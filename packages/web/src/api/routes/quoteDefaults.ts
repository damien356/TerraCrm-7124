import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { openDefaultWarning, openDefaultWarnings } from "../lib/quote-default-gate";
import { coverTrim, trimInstallChoices } from "../lib/quote-defaults";
import { isPrepWarning, m2Text } from "../lib/quote-default-rules";
import { confirmPartial, followArea, prepLinks } from "../lib/prep-link";
import { editableQuoteOrThrow, recalc } from "./quotes";

/**
 * Quote defaults in the builder (Damien's review, 7 Nov 2026). Admin and
 * Office. Mark a warning reviewed (who and when are kept, and logged), see
 * which floor areas have Install trims/scotia, and pick the area a trim goes
 * with. None of these adds a line or changes a price.
 */
export const quoteDefaults = {
  /** The warnings still stopping this quote going out. */
  open: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => openDefaultWarnings(input.quoteId)),

  /** A warning checked by a person: the quote can go out with the line as it is. The warning text stays on the line as history. */
  review: staffOnly
    .input(z.object({ itemId: z.number(), note: z.string().trim().max(500).optional() }))
    .handler(async ({ input, context }) => {
      const [line] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await editableQuoteOrThrow(line.quoteId);
      if (!openDefaultWarning(line)) {
        throw new ORPCError("BAD_REQUEST", { message: "This line has no quote defaults warning waiting for review." });
      }
      if (isPrepWarning(line.flagReason)) {
        throw new ORPCError("BAD_REQUEST", {
          message: "A quantity mismatch is not cleared by Mark reviewed. Follow the floor area, confirm a partial area with a reason, or remove the line.",
        });
      }
      const at = new Date();
      const [row] = await db
        .update(schema.quoteItems)
        .set({ defaultReviewedBy: context.actor.name, defaultReviewedAt: at, defaultReviewNote: input.note || null, updatedAt: at })
        .where(eq(schema.quoteItems.id, line.id))
        .returning();
      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "default_reviewed",
        detail: `Quote defaults warning on "${line.description}" marked reviewed${input.note ? `: ${input.note}` : ""}. It said: ${line.flagReason ?? ""}`.slice(0, 2000),
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return {
        id: row!.id,
        defaultReviewedBy: row!.defaultReviewedBy,
        defaultReviewedAt: row!.defaultReviewedAt,
        defaultReviewNote: row!.defaultReviewNote,
      };
    }),

  /** Area prep lines (grinding and the other m2 prep) with the floor area each follows. Read only. */
  prepLinks: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => prepLinks(input.quoteId)),

  /** Follow the floor's measured area: the qty becomes that m2 and moves with it from now on. */
  followArea: staffOnly
    .input(z.object({ itemId: z.number(), floorItemId: z.number().optional() }))
    .handler(async ({ input, context }) => {
      const [line] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await editableQuoteOrThrow(line.quoteId);
      const res = await followArea(line.id, input.floorItemId).catch((e: unknown) => {
        throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : "Could not follow the area." });
      });
      await logPrep(quote, context.actor, "prep_follow_area", `"${line.description}" now follows the measured floor area of "${res.floor.description}": ${m2Text(res.qty)} (was ${m2Text(res.was)}).`);
      return { item: res.row, totals: await recalc(line.quoteId) };
    }),

  /** A genuine partial area. A click is never enough: the qty and a reason are needed, and who and when are kept. */
  confirmPartial: staffOnly
    .input(z.object({ itemId: z.number(), qty: z.number().positive(), reason: z.string().trim().min(3).max(300), floorItemId: z.number().optional() }))
    .handler(async ({ input, context }) => {
      const [line] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await editableQuoteOrThrow(line.quoteId);
      const res = await confirmPartial(line.id, input.qty, input.reason, context.actor.name, input.floorItemId).catch((e: unknown) => {
        throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : "Could not confirm the partial area." });
      });
      await logPrep(
        quote,
        context.actor,
        "prep_partial_confirmed",
        `Partial area confirmed on "${line.description}": ${m2Text(res.qty)} of the ${m2Text(res.floor.measuredM2 ?? 0)} floor "${res.floor.description}" (was ${m2Text(res.was)}). Reason: ${res.reason}`,
      );
      return { item: res.row, totals: await recalc(line.quoteId) };
    }),

  /** The Install trims/scotia lines on the quote, each with its floor area, for a trim's Install with pick. */
  trimChoices: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => trimInstallChoices(input.quoteId)),

  /** Which area's Install trims/scotia covers this trim. Only the link moves. */
  coverTrim: staffOnly
    .input(z.object({ itemId: z.number(), installId: z.number() }))
    .handler(async ({ input }) => {
      const [line] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      await editableQuoteOrThrow(line.quoteId);
      try {
        return await coverTrim(input.itemId, input.installId);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : "Could not move the install." });
      }
    }),
};

async function logPrep(
  quote: { id: number; jobId: number | null; contactId: number | null },
  actor: { name: string; role: string },
  action: string,
  detail: string,
) {
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action,
    detail: detail.slice(0, 2000),
    actorName: actor.name,
    actorRole: actor.role,
  });
}
