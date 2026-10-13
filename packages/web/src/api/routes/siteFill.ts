import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { DELIVERY, isDeliveryText } from "../lib/line-kinds";
import { siteGuessFromText } from "../lib/site-guess";
import { newSiteInput } from "../lib/job-new-records";
import { fillJobFromQuote } from "../lib/quote-convert";
import { quoteRefOf } from "../lib/quote-number";

/* ---------------------------------------------------------------------------
 * 188001 list item 12: site is blank. A quote with a delivery line and no
 * site asks for one before Send and Accept, and a job with no site offers
 * "No site. Add one". Both use the same form, prefilled from the delivery
 * line's text.
 * ------------------------------------------------------------------------- */

/** Quotes that can still take a site. Accepted and the rest are shut. */
const OPEN_QUOTE = ["draft", "needs_review", "sent"];

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

type DeliveryLine = { kind: string; description: string };
const isDeliveryLine = (i: DeliveryLine) => i.kind === DELIVERY || isDeliveryText(i.description);

/** The first delivery line's text on these quotes, newest first. */
async function deliveryTextOf(quoteIds: number[]) {
  if (!quoteIds.length) return null;
  const items = await db
    .select({ quoteId: schema.quoteItems.quoteId, kind: schema.quoteItems.kind, description: schema.quoteItems.description })
    .from(schema.quoteItems)
    .where(inArray(schema.quoteItems.quoteId, quoteIds))
    .orderBy(schema.quoteItems.sortOrder, schema.quoteItems.id);
  for (const id of quoteIds) {
    const line = items.find((i) => i.quoteId === id && isDeliveryLine(i));
    if (line) return line.description;
  }
  return null;
}

function answer(needed: boolean, deliveryText: string | null) {
  return {
    needed,
    /** The delivery line the guess came from, shown above the form. */
    deliveryText,
    guess: deliveryText ? siteGuessFromText(deliveryText) : null,
  };
}

export const siteFill = {
  /** Needed when the quote has a delivery line and neither it nor its job has a site. */
  forQuote: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, input.quoteId));
    if (!quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
    const [job] = quote.jobId ? await db.select({ siteId: schema.jobs.siteId }).from(schema.jobs).where(eq(schema.jobs.id, quote.jobId)) : [];
    const text = await deliveryTextOf([quote.id]);
    return answer(!!text && !quote.siteId && !job?.siteId, text);
  }),

  /** Needed when the job has no site. The guess comes off its newest quote with a delivery line. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const [job] = await db.select({ siteId: schema.jobs.siteId }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    if (job.siteId) return answer(false, null);
    const quotes = await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(eq(schema.quotes.jobId, input.jobId))
      .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
    return answer(true, await deliveryTextOf(quotes.map((q) => q.id)));
  }),

  /**
   * Save the site on the quote and its job, or on the job and its open
   * quotes. Either an existing site (siteId) or a new address (newSite).
   */
  save: staffOnly
    .input(
      z.object({
        quoteId: z.number().optional(),
        jobId: z.number().optional(),
        siteId: z.number().optional(),
        newSite: newSiteInput.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (!input.quoteId === !input.jobId) throw bad("Save the site on a quote or on a job.");
      if (!input.siteId === !input.newSite) throw bad("Pick an existing site or type a new address.");

      const [quote] = input.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, input.quoteId)) : [];
      if (input.quoteId && !quote) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
      const jobId = quote ? quote.jobId : input.jobId!;
      const [job] = jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)) : [];
      if (input.jobId && !job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

      if (quote && !OPEN_QUOTE.includes(quote.status)) throw bad("This quote is locked. Add the site on the job page.");
      if (quote?.siteId) throw bad("This quote already has a site.");
      if (job?.siteId) throw bad("This job already has a site.");

      let site: typeof schema.sites.$inferSelect | undefined;
      if (input.siteId) {
        [site] = await db.select().from(schema.sites).where(eq(schema.sites.id, input.siteId));
        if (!site) throw bad("That site is gone. Pick it again.");
      } else {
        [site] = await db
          .insert(schema.sites)
          .values({
            ...input.newSite!,
            contactId: quote?.contactId ?? job?.contactId ?? null,
            companyId: quote?.companyId ?? job?.companyId ?? null,
          })
          .returning();
      }
      const s = site!;

      if (quote) {
        await db.update(schema.quotes).set({ siteId: s.id, updatedAt: new Date() }).where(eq(schema.quotes.id, quote.id));
        // The job takes the site, its access notes and the address as title (lib/quote-convert.ts).
        if (quote.jobId) await fillJobFromQuote(quote.id);
      } else if (job) {
        const patch: Partial<typeof schema.jobs.$inferInsert> = { siteId: s.id, updatedAt: new Date() };
        if (!job.accessNotes && s.accessNotes) patch.accessNotes = s.accessNotes;
        if (/^Quote Q\d/.test(job.title ?? "")) patch.title = s.address;
        await db.update(schema.jobs).set(patch).where(eq(schema.jobs.id, job.id));
        // Its quotes that can still change take the site too. Accepted ones stay as signed.
        await db
          .update(schema.quotes)
          .set({ siteId: s.id, updatedAt: new Date() })
          .where(and(eq(schema.quotes.jobId, job.id), isNull(schema.quotes.siteId), inArray(schema.quotes.status, OPEN_QUOTE)));
      }

      const where = [s.address, s.suburb].filter(Boolean).join(", ");
      await db.insert(schema.activityLog).values({
        jobId: jobId ?? null,
        contactId: quote?.contactId ?? job?.contactId ?? null,
        entityType: quote ? "quote" : "job",
        entityId: quote ? quote.id : job!.id,
        action: "site_added",
        detail: quote ? `Site ${where} added to quote ${await quoteRefOf(quote)}` : `Site ${where} added to the job`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { siteId: s.id, address: s.address, suburb: s.suburb };
    }),
};
