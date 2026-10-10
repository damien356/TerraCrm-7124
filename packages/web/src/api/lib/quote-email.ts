import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { clientPdfFor } from "../routes/quoteBundles";
import { sendAsTeam } from "./agent-mail";
import { addParticipant, ensureForQuote, logMessage, subjectWithRef } from "./conversations";
import { depositSplit } from "./deposits";
import { linkForQuote, quoteUrl } from "./quote-links";
import { SENDER_NAME } from "./material-selection";
import { TERRA_PRINT } from "./quotePdf";
import { putObject } from "./s3";

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

/* ---------------------------------------------------------------------------
 * Quote emails: the quote going out (PDF plus the no-login link) and the
 * signed copy coming back after an online accept. Both go through team@
 * (Gmail, Resend if team@ is not connected) as "Damien from Terra", replies to
 * team@, and both are logged on the quote's thread with the PDF attached.
 *
 * The PDF is NOT filed in the job file (job_media): crew can open the job
 * file and must never see what the client is paying.
 * ------------------------------------------------------------------------- */

type Quote = typeof schema.quotes.$inferSelect;
type Contact = typeof schema.contacts.$inferSelect;

const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();

export const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Everyone on the quote with an email, the one it is addressed to first. */
export async function quoteRecipients(quote: Quote) {
  const out: { contactId: number | null; name: string; email: string; why: string }[] = [];
  const add = (c: Contact | undefined, why: string) => {
    const email = c?.email?.trim();
    if (!c || !email || out.some((o) => o.email.toLowerCase() === email.toLowerCase())) return;
    out.push({ contactId: c.id, name: fullName(c), email, why });
  };
  if (quote.supervisorContactId) {
    const [s] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.supervisorContactId));
    add(s, "Supervisor");
  }
  if (quote.contactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.contactId));
    add(c, "Customer");
  }
  // A quote on a job reads the job's list (item 7). Only people ticked for
  // email or as a decision-maker get it, so a tenant there for access does not.
  if (quote.jobId) {
    const onJob = await db
      .select({ contact: schema.contacts, link: schema.jobContacts })
      .from(schema.jobContacts)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
      .where(eq(schema.jobContacts.jobId, quote.jobId))
      .orderBy(schema.jobContacts.id);
    for (const p of onJob) if (p.link.receivesEmail || p.link.canApproveQuote) add(p.contact, "On the job");
  }
  const people = await db
    .select({ contact: schema.contacts })
    .from(schema.quoteContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.quoteContacts.contactId))
    .where(eq(schema.quoteContacts.quoteId, quote.id));
  for (const p of people) add(p.contact, "On the quote");
  if (quote.companyId) {
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, quote.companyId));
    const email = co?.email?.trim();
    if (co && email && !out.some((o) => o.email.toLowerCase() === email.toLowerCase())) {
      out.push({ contactId: null, name: co.name, email, why: "Company" });
    }
  }
  return out;
}

/** The email the dialog opens with. The office can change any of it. */
export async function quoteEmailDraft(quote: Quote, ref: string) {
  const recipients = await quoteRecipients(quote);
  const first = recipients[0]?.name.split(" ")[0] || "there";
  const link = await linkForQuote(quote.id);
  const { deposit } = depositSplit(quote.total, quote.depositPercent);
  const body = [
    `Hi ${first},`,
    "",
    `Thanks for the chance to quote. Your quote ${ref} for ${money(quote.total)} including GST is attached.`,
    "",
    "You can also read it, and accept it online, here:",
    quoteUrl(link.token),
    "",
    quote.depositPercent > 0
      ? `To lock in your job we take a ${quote.depositPercent}% deposit (${money(deposit)}) when you accept.`
      : "There is no deposit to pay on this quote.",
    "",
    "Any questions, just reply to this email or give me a call.",
    "",
    "Kind regards,",
    "Damien",
    "Terra Flooring",
  ].join("\n");
  return {
    recipients,
    to: recipients[0]?.email ?? "",
    subject: `Your Terra Flooring quote ${ref}`,
    body,
    url: quoteUrl(link.token),
  };
}

/** Store a PDF and hang it off a logged message as an attachment. */
async function attachPdf(messageId: number, key: string, pdf: Buffer, filename: string) {
  await putObject(key, pdf, "application/pdf", filename);
  await db.insert(schema.messageAttachments).values({
    messageId,
    filename,
    mime: "application/pdf",
    sizeBytes: pdf.length,
    storageKey: key,
    url: "",
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Send the quote. The link is checked to be in the body (the office may have
 * edited it out), the PDF is attached, and it is logged on the thread.
 * Throws if the email did not go: nothing is marked sent then.
 */
export async function sendQuoteEmail(args: { quote: Quote; to: string; subject: string; body: string; byName: string; byProfileId?: number | null }) {
  const to = args.to.trim();
  if (!EMAIL_RE.test(to)) throw bad(`"${to}" is not an email address.`);
  const { pdf, filename, ref } = await clientPdfFor(args.quote.id);
  const link = await linkForQuote(args.quote.id);
  const url = quoteUrl(link.token);
  const body = args.body.includes(url) ? args.body : `${args.body.trimEnd()}\n\nRead and accept your quote online:\n${url}`;

  const conv = await ensureForQuote(args.quote.id);
  const subject = subjectWithRef(args.subject.trim() || `Your Terra Flooring quote ${ref}`, conv.ref);
  const out = await sendAsTeam({
    to,
    subject,
    text: body,
    fromName: SENDER_NAME,
    attachments: [{ filename, content: pdf, contentType: "application/pdf" }],
  });

  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, to)).limit(1);
  const msg = await logMessage({
    conversationId: conv.id,
    jobId: args.quote.jobId,
    contactId: contact?.id ?? args.quote.contactId ?? null,
    channel: "email",
    audience: "customer",
    direction: "out",
    subject,
    body,
    authorName: args.byName,
    authorProfileId: args.byProfileId ?? null,
    toAddress: to,
    providerId: out.id,
    status: "sent",
  });
  await attachPdf(msg.id, `quotes/${args.quote.number}/${args.quote.id}/sent-${stamp()}.pdf`, pdf, filename);
  if (contact) {
    await addParticipant(conv.id, { role: "customer", contactId: contact.id, name: fullName(contact), email: contact.email, mobile: contact.mobile });
  }
  return { ref, to, via: out.via, messageId: msg.id, url };
}

/**
 * After an online accept: store the signed PDF, log it on the thread, and
 * send the signer their copy with the deposit details. A failed email is
 * logged as failed but never undoes the accept.
 */
export async function sendSignedCopy(args: {
  quote: Quote;
  signatureId: number;
  pdf: Buffer;
  filename: string;
  ref: string;
  signerName: string;
  signerEmail: string | null;
  deposit: { ref: string; total: number; payUrl?: string | null } | null;
}) {
  const key = `quotes/${args.quote.number}/${args.quote.id}/signed-${stamp()}.pdf`;
  const conv = await ensureForQuote(args.quote.id);
  const first = args.signerName.split(" ")[0] || "there";
  const lines = [
    `Hi ${first},`,
    "",
    `Thanks for accepting quote ${args.ref}. Your signed copy is attached.`,
    "",
  ];
  if (args.deposit) {
    lines.push(`Your deposit invoice is ${args.deposit.ref} for ${money(args.deposit.total)}.`, "");
    if (args.deposit.payUrl) lines.push("Pay by card online:", args.deposit.payUrl, "", `Or pay by bank transfer and use ${args.deposit.ref} as the reference:`);
    else lines.push(`Please pay by bank transfer and use ${args.deposit.ref} as the reference:`);
    lines.push(
      `Account name: ${TERRA_PRINT.bank.name}`,
      `BSB: ${TERRA_PRINT.bank.bsb}`,
      `Account: ${TERRA_PRINT.bank.account}`,
      "",
      "We order your flooring once the deposit lands.",
      "",
    );
  }
  lines.push("We will be in touch to book your job in.", "", "Kind regards,", "Damien", "Terra Flooring");
  const body = lines.join("\n");
  const subject = subjectWithRef(`Quote ${args.ref} accepted, your signed copy`, conv.ref);

  let providerId: string | null = null;
  let failed: string | null = null;
  const to = args.signerEmail?.trim() || null;
  if (to && EMAIL_RE.test(to)) {
    try {
      const out = await sendAsTeam({
        to,
        subject,
        text: body,
        fromName: SENDER_NAME,
        attachments: [{ filename: args.filename, content: args.pdf, contentType: "application/pdf" }],
      });
      providerId = out.id;
    } catch (e) {
      failed = String((e as Error)?.message ?? e).slice(0, 300);
      console.error("[quote] signed copy email failed:", failed);
    }
  }

  // Logged either way, so the signed PDF is on the thread even with no email.
  const msg = await logMessage({
    conversationId: conv.id,
    jobId: args.quote.jobId,
    contactId: args.quote.contactId,
    channel: to ? "email" : "note",
    audience: to ? "customer" : "internal",
    direction: "out",
    subject: to ? subject : null,
    body: to ? body : `${args.signerName} accepted quote ${args.ref} online. Signed copy attached.`,
    authorName: "Terra Ops",
    toAddress: to,
    providerId,
    status: failed ? "failed" : "sent",
    statusDetail: failed,
    failedAt: failed ? new Date() : null,
  });
  await attachPdf(msg.id, key, args.pdf, args.filename);
  await db.update(schema.quoteSignatures).set({ pdfKey: key, updatedAt: new Date() }).where(eq(schema.quoteSignatures.id, args.signatureId));
  return { key, emailed: Boolean(providerId), failed };
}
