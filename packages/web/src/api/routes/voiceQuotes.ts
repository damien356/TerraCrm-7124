import { z } from "zod";
import { desc, eq, like, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, type Actor } from "../middleware/auth";
import { getObject, signGet, voiceAudioKey, signPut } from "../lib/s3";
import { transcribeAudio } from "../agent/transcribe";
import { extractVoiceQuote } from "../agent/extract";
import { priceExtraction } from "../agent/price";
import { recalc } from "./quotes";

/**
 * Damien records a rough job note on site, this turns it into a draft quote.
 * Recording -> transcript (Whisper) -> structured lines (GPT, labour rate book
 * only) -> priced lines (products table + labour rates, in code) -> a real
 * quote, same tables and totals as one built by hand in the quote builder.
 *
 * Anything the pricing pass could not match with confidence comes back
 * flagged, the quote goes in as "needs_review" instead of "draft", and the
 * office looks it over before it goes anywhere near a customer.
 */

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const processInput = z.object({
  audioKey: z.string().min(1),
  durationSeconds: z.number().nullable().optional(),
  contactId: z.number().nullable().optional(),
  companyId: z.number().nullable().optional(),
  jobId: z.number().nullable().optional(),
});
type ProcessInput = z.infer<typeof processInput>;

export const voiceQuotes = {
  /** Presigned upload for the recording itself, before anything is processed. */
  presign: adminOnly
    .input(
      z.object({ filename: z.string().min(1), contentType: z.string().min(1) }),
    )
    .handler(async ({ input }) => {
      const key = voiceAudioKey(input.filename);
      const url = await signPut(key, input.contentType);
      return { url, key };
    }),

  list: adminOnly
    .input(
      z
        .object({ limit: z.number().int().min(1).max(200).default(50) })
        .default({ limit: 50 }),
    )
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.voiceQuoteCaptures)
        .orderBy(desc(schema.voiceQuoteCaptures.createdAt))
        .limit(input.limit);
      return Promise.all(
        rows.map(async (r) => ({ ...r, audioUrl: await signGet(r.audioKey) })),
      );
    }),

  get: adminOnly
    .input(z.object({ id: z.number() }))
    .handler(async ({ input }) => {
      const [row] = await db
        .select()
        .from(schema.voiceQuoteCaptures)
        .where(eq(schema.voiceQuoteCaptures.id, input.id));
      if (!row)
        throw new ORPCError("NOT_FOUND", { message: "Capture not found" });
      return { ...row, audioUrl: await signGet(row.audioKey) };
    }),

  /**
   * Runs the whole pipeline against an already-uploaded recording and leaves
   * a draft quote behind. One call, a few seconds of latency (Whisper + one
   * LLM call), no background job — the office is watching a spinner while
   * Damien's note turns into a quote.
   */
  process: adminOnly.input(processInput).handler(async ({ input, context }) => {
    const captureId = await startCapture(input, context.actor.name);
    return runPipeline(captureId, input, context.actor);
  }),

  /**
   * Same pipeline as `process`, but it answers straight away with the capture
   * id and does the work in the background. Whisper plus the extraction call
   * regularly runs past 10 seconds, and the published Bun server hangs up on
   * any request that is silent for that long, so the phone saw "Load failed"
   * even though the quote was made. The client polls `status` instead.
   */
  start: adminOnly.input(processInput).handler(async ({ input, context }) => {
    const captureId = await startCapture(input, context.actor.name);
    runPipeline(captureId, input, context.actor).catch((err) => {
      console.error(`[voice-quotes] capture ${captureId} failed:`, err);
    });
    return { captureId };
  }),

  /** Where a background run has got to, and the finished result once priced. */
  status: adminOnly
    .input(z.object({ id: z.number() }))
    .handler(async ({ input }) => {
      const [row] = await db
        .select()
        .from(schema.voiceQuoteCaptures)
        .where(eq(schema.voiceQuoteCaptures.id, input.id));
      if (!row)
        throw new ORPCError("NOT_FOUND", { message: "Capture not found" });
      if (row.status === "failed")
        return {
          status: "failed" as const,
          errorMessage: row.errorMessage,
          result: null,
        };
      if (!row.quoteId)
        return { status: "working" as const, errorMessage: null, result: null };

      const [quote] = await db
        .select()
        .from(schema.quotes)
        .where(eq(schema.quotes.id, row.quoteId));
      if (!quote)
        return { status: "working" as const, errorMessage: null, result: null };
      const items = await db
        .select({ flagged: schema.quoteItems.flagged })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quote.id));

      let matchedCustomerName: string | null = null;
      if (quote.contactId) {
        const [ct] = await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, quote.contactId));
        if (ct) matchedCustomerName = `${ct.firstName} ${ct.lastName}`.trim();
      } else if (quote.companyId) {
        const [co] = await db
          .select()
          .from(schema.companies)
          .where(eq(schema.companies.id, quote.companyId));
        if (co) matchedCustomerName = co.name;
      }

      return {
        status: "done" as const,
        errorMessage: null,
        result: {
          captureId: row.id,
          quote,
          transcript: row.transcript ?? "",
          flaggedCount: items.filter((i) => i.flagged).length,
          lineCount: items.length,
          matchedCustomerName,
        },
      };
    }),
};


async function startCapture(input: ProcessInput, actorName: string) {
  const [capture] = await db
    .insert(schema.voiceQuoteCaptures)
    .values({
      audioKey: input.audioKey,
      durationSeconds: input.durationSeconds ?? null,
      contactId: input.contactId ?? null,
      jobId: input.jobId ?? null,
      status: "transcribing",
      capturedByProfileId: null,
      capturedByName: actorName,
    })
    .returning();
  if (!capture)
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Could not start the capture",
    });
  return capture.id;
}

async function runPipeline(captureId: number, input: ProcessInput, actor: Actor) {
  try {
    const audioBuffer = await getObject(input.audioKey);
    const transcript = await transcribeAudio(new Uint8Array(audioBuffer));

    await db
      .update(schema.voiceQuoteCaptures)
      .set({ transcript, status: "extracting", updatedAt: new Date() })
      .where(eq(schema.voiceQuoteCaptures.id, captureId));

    const built = await buildQuoteFromTranscript(
      transcript,
      { contactId: input.contactId ?? null, companyId: input.companyId ?? null, jobId: input.jobId ?? null },
      actor,
    );

    await db
      .update(schema.voiceQuoteCaptures)
      .set({
        extractedJson: JSON.stringify(built.extraction),
        quoteId: built.quote.id,
        contactId: built.contactId,
        status: "priced",
        updatedAt: new Date(),
      })
      .where(eq(schema.voiceQuoteCaptures.id, captureId));

    return {
      captureId,
      quote: built.quote,
      transcript,
      flaggedCount: built.flaggedCount,
      lineCount: built.lineCount,
      matchedCustomerName: built.matchedCustomerName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong processing this recording.";
    await db
      .update(schema.voiceQuoteCaptures)
      .set({ status: "failed", errorMessage: message, updatedAt: new Date() })
      .where(eq(schema.voiceQuoteCaptures.id, captureId));
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
  }
}

/**
 * Spoken job description in, real priced quote out. Shared by the voice quote
 * page and by voice memos, where "quote her for..." is one of several things
 * a single recording can ask for. When the memo already knows the client
 * (recorded from inside their card) the ids come in set, and the spoken-name
 * match below is skipped.
 */
export async function buildQuoteFromTranscript(
  transcript: string,
  link: { contactId: number | null; companyId: number | null; jobId: number | null },
  actor: Pick<Actor, "name" | "role">,
) {
  const labourItems = await db
    .select({
      id: schema.labourRateItems.id,
      name: schema.labourRateItems.name,
      groupName: schema.labourRateItems.groupName,
      unit: schema.labourRateItems.unit,
    })
    .from(schema.labourRateItems);

  const extraction = await extractVoiceQuote(transcript, labourItems);
  const pricedLines = await priceExtraction(extraction);

  // Try to match the spoken name to an existing contact or company.
  // Never create a new record silently, an unmatched name just rides
  // along on the quote's notes so the office can attach it by hand.
  let contactId = link.contactId;
  let companyId = link.companyId;
  let matchedCustomerName: string | null = null;
  if (contactId) {
    const [ct] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
    if (ct) matchedCustomerName = `${ct.firstName} ${ct.lastName}`.trim();
  } else if (!companyId && extraction.customerSpokenName) {
    const q = `%${extraction.customerSpokenName.toLowerCase()}%`;
    const [contactMatch] = await db
      .select()
      .from(schema.contacts)
      .where(like(sql`lower(${schema.contacts.firstName} || ' ' || ${schema.contacts.lastName})`, q))
      .limit(1);
    if (contactMatch) {
      contactId = contactMatch.id;
      matchedCustomerName = `${contactMatch.firstName} ${contactMatch.lastName}`.trim();
    } else {
      const [companyMatch] = await db
        .select()
        .from(schema.companies)
        .where(like(sql`lower(${schema.companies.name})`, q))
        .limit(1);
      if (companyMatch) {
        companyId = companyMatch.id;
        matchedCustomerName = companyMatch.name;
      }
    }
  }

  const anyFlagged = pricedLines.some((l) => l.flagged);
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.quotes.number}), 1000)` })
    .from(schema.quotes);
  const number = Number(maxRow?.max ?? 1000) + 1;

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + 30);

  const notesParts: string[] = [];
  if (extraction.customerSpokenName && !matchedCustomerName) {
    notesParts.push(
      `Damien said the customer's name as "${extraction.customerSpokenName}", no matching contact or company was found. Attach the right one before sending.`,
    );
  }
  if (extraction.generalNotes) notesParts.push(extraction.generalNotes);
  notesParts.push(`Created from a voice recording. Transcript: "${transcript}"`);

  const [quoteRow] = await db
    .insert(schema.quotes)
    .values({
      number,
      version: 1,
      jobId: link.jobId,
      contactId,
      companyId,
      status: anyFlagged ? "needs_review" : "draft",
      depositPercent: 0,
      validUntil,
      notes: notesParts.join("\n\n"),
    })
    .returning();
  if (!quoteRow) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Quote not created" });

  if (pricedLines.length) {
    await db.insert(schema.quoteItems).values(
      pricedLines.map((l, i) => ({
        quoteId: quoteRow.id,
        productId: l.productId,
        kind: l.kind,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
        unitCost: l.unitCost,
        total: round2(l.qty * l.unitPrice),
        sortOrder: i,
        flagged: l.flagged,
        flagReason: l.flagReason,
        voicePhrase: l.voicePhrase,
      })),
    );
  }

  const totals = await recalc(quoteRow.id);

  await db.insert(schema.activityLog).values({
    contactId,
    jobId: link.jobId,
    entityType: "quote",
    entityId: quoteRow.id,
    action: "created_from_voice",
    detail: anyFlagged
      ? `Quote #${number} created from a voice recording. Some lines need review before it can be sent.`
      : `Quote #${number} created from a voice recording.`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  return {
    quote: { ...quoteRow, ...totals },
    extraction,
    contactId,
    flaggedCount: pricedLines.filter((l) => l.flagged).length,
    lineCount: pricedLines.length,
    matchedCustomerName,
  };
}
