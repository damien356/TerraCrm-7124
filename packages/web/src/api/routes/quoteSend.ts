import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { assertBillable } from "../lib/callbacks";
import { quoteRefOf } from "../lib/quote-number";
import { linkSummary } from "../lib/quote-links";
import { depositInvoiceFor } from "../lib/client-invoices";
import { uploadInput } from "../lib/job-mail";
import { EMAIL_RE, quoteEmailDraft } from "../lib/quote-email";
import { needsScope, SCOPE_FILL } from "../lib/quote-email-template";
import { claimSend, releaseSend, retryChannel, runSend, sendByKeySettled, sendsFor, sendSummary, quoteSmsDraft } from "../lib/quote-send";
import { ORPCError } from "@orpc/server";
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

/**
 * 188001 list item 7: an accepted quote can have its wording fixed and go out
 * again. Declined, expired and replaced ones stay shut.
 */
async function sendableQuoteOrThrow(id: number) {
  const quote = await quoteOrThrow(id);
  return quote.status === "accepted" ? quote : editableQuoteOrThrow(id);
}

/** The re-send email for an accepted quote: the wording changed, the price did not. */
async function resendDraft(quote: typeof schema.quotes.$inferSelect, ref: string) {
  const base = await quoteEmailDraft(quote, ref);
  const first = base.recipients[0]?.name.split(" ")[0] || "there";
  return {
    ...base,
    subject: `Updated copy of your Terra Flooring quote ${ref}`,
    body: [
      `Hi ${first},`,
      "",
      `We have tidied up the wording on quote ${ref}, which you have already accepted. The price, quantities and deposit are the same.`,
      "",
      "The updated copy is attached. You can also view it online here:",
      base.url,
      "",
      "Nothing to sign or pay because of this email. Any questions, just reply or call me on 1300 183 772.",
      "",
      "Kind regards,",
      "Damien",
      "Terra Flooring",
    ].join("\n"),
  };
}

export const quoteSend = {
  /** What the Email quote dialog opens with: recipients, subject, body and the link. */
  draft: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const quote = await sendableQuoteOrThrow(input.quoteId);
    const ref = await quoteRefOf(quote);
    const resend = quote.status === "accepted";
    const draft = resend ? await resendDraft(quote, ref) : await quoteEmailDraft(quote, ref);
    return { ...draft, ref, resend, jobId: quote.jobId, link: await linkSummary(quote.id), sms: await quoteSmsDraft(quote, resend) };
  }),

  /**
   * Send it: the email as before, and a text with the link unless turned off
   * (30 Oct, after 188048). Each channel has its own result. Marked sent once
   * either has actually gone. The same sendKey twice sends once.
   */
  send: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        sendKey: z.string().min(8).max(80),
        /** Empty when there is no usable email: the text can still go. */
        to: z.string().max(200),
        subject: z.string().max(300),
        body: z.string().max(20000),
        cc: z.array(z.string().trim().max(200)).max(10).optional(),
        mediaIds: z.array(z.number().int()).max(30).optional(),
        uploads: z.array(uploadInput).max(20).optional(),
        sms: z
          .object({
            to: z.string().max(40),
            contactId: z.number().int().nullable().optional(),
            firstName: z.string().max(60),
            description: z.string().max(160),
            showOption: z.boolean(),
          })
          .nullable()
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await sendableQuoteOrThrow(input.quoteId);
      const already = await sendByKeySettled(input.sendKey);
      if (already) {
        if (already.quoteId !== quote.id) throw new ORPCError("BAD_REQUEST", { message: "That send belongs to another quote." });
        return { send: sendSummary(already), duplicate: true };
      }
      const wantsEmail = input.to.trim().length > 0;
      if (wantsEmail && EMAIL_RE.test(input.to.trim())) {
        if (!input.body.trim()) throw new ORPCError("BAD_REQUEST", { message: "The email has no message." });
        if (needsScope(input.subject, input.body)) throw new ORPCError("BAD_REQUEST", { message: `Type what the quote is for in place of ${SCOPE_FILL} before sending.` });
        for (const c of input.cc ?? []) if (!EMAIL_RE.test(c.trim())) throw new ORPCError("BAD_REQUEST", { message: `"${c}" is not an email address.` });
      }
      if (input.sms && !input.sms.description.trim()) throw new ORPCError("BAD_REQUEST", { message: "Type a few words for the text about what the quote is for." });

      const resend = quote.status === "accepted";
      const row = await claimSend({ quote, sendKey: input.sendKey, kind: resend ? "resend" : "first", byName: context.actor.name });
      if (!row) {
        const first = await sendByKeySettled(input.sendKey);
        return { send: first ? sendSummary(first) : null, duplicate: true };
      }
      if (!resend) {
        try {
          await assertBillable(quote.jobId);
          await assertReadyToGoOut(quote, context.actor);
          await recordPriceHistory(quote, context.actor.name);
        } catch (e) {
          await releaseSend(row.id);
          throw e;
        }
      }
      const who = { name: context.actor.name, role: context.actor.role, profileId: await profileIdOf(context.actor.userId) };
      const done = await runSend({
        row,
        quote,
        who,
        email: wantsEmail
          ? { to: input.to, subject: input.subject, body: input.body, cc: input.cc?.map((c) => c.trim()).filter(Boolean), mediaIds: input.mediaIds, uploads: input.uploads }
          : null,
        sms: input.sms ? { ...input.sms, contactId: input.sms.contactId ?? null } : null,
      });
      return { send: sendSummary(done), duplicate: false };
    }),

  /** Try again only the channel that failed. The one that went is never sent twice. */
  retry: staffOnly
    .input(z.object({ quoteId: z.number(), sendId: z.number().int(), channel: z.enum(["email", "sms"]) }))
    .handler(async ({ input, context }) => {
      const quote = await sendableQuoteOrThrow(input.quoteId);
      const who = { name: context.actor.name, role: context.actor.role, profileId: await profileIdOf(context.actor.userId) };
      const row = await retryChannel({ sendId: input.sendId, channel: input.channel, quote, who });
      return { send: sendSummary(row) };
    }),

  /** Each send on this quote with the email and the text shown apart. */
  sends: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    await quoteOrThrow(input.quoteId);
    return sendsFor(input.quoteId);
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
