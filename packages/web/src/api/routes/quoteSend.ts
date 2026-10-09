import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { assertBillable } from "../lib/callbacks";
import { leadToQuotedOnSend } from "../lib/job-stage";
import { quoteRefOf } from "../lib/quote-number";
import { linkSummary } from "../lib/quote-links";
import { depositInvoiceFor } from "../lib/client-invoices";
import { quoteEmailDraft, sendQuoteEmail } from "../lib/quote-email";
import { assertReadyToGoOut, editableQuoteOrThrow, quoteOrThrow, recordPriceHistory } from "./quotes";

/* ---------------------------------------------------------------------------
 * Emailing a quote from the builder (spec 2.1): the PDF attached, plus the
 * no-login link the client reads and signs at. "Mark as sent" (quotes.send)
 * stays for quotes that went out some other way.
 * ------------------------------------------------------------------------- */

async function profileIdOf(userId: string) {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  return p?.id ?? null;
}

export const quoteSend = {
  /** What the Email quote dialog opens with: recipients, subject, body and the link. */
  draft: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const quote = await editableQuoteOrThrow(input.quoteId);
    const ref = await quoteRefOf(quote);
    const draft = await quoteEmailDraft(quote, ref);
    return { ...draft, ref, link: await linkSummary(quote.id) };
  }),

  /** Email it. Only marked sent once the email has actually gone. */
  send: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        to: z.string().min(3).max(200),
        subject: z.string().max(300),
        body: z.string().min(1).max(20000),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await editableQuoteOrThrow(input.quoteId);
      await assertBillable(quote.jobId);
      await assertReadyToGoOut(quote, context.actor);
      await recordPriceHistory(quote, context.actor.name);
      const out = await sendQuoteEmail({
        quote,
        to: input.to,
        subject: input.subject,
        body: input.body,
        byName: context.actor.name,
        byProfileId: await profileIdOf(context.actor.userId),
      });
      const now = new Date();
      const [row] = await db
        .update(schema.quotes)
        .set({ status: "sent", sentAt: quote.sentAt ?? now, updatedAt: now })
        .where(eq(schema.quotes.id, quote.id))
        .returning();
      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "sent",
        detail: `Quote ${out.ref} emailed to ${out.to}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      await leadToQuotedOnSend({ jobId: quote.jobId, quoteNumber: out.ref, actor: context.actor });
      return { quote: row, to: out.to, via: out.via, url: out.url };
    }),

  /** The link card on the builder: url, how often it was opened, and the signature if signed. */
  link: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    await quoteOrThrow(input.quoteId);
    const inv = await depositInvoiceFor(input.quoteId);
    return {
      ...(await linkSummary(input.quoteId)),
      depositInvoice: inv ? { ref: inv.number, total: inv.total, amountPaid: inv.amountPaid, status: inv.status } : null,
    };
  }),
};
