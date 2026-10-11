import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendAsTeam } from "./agent-mail";
import { addParticipant, ensureForJob, logMessage, subjectWithRef } from "./conversations";
import { auDate } from "./invoice-match";
import { SENDER_NAME } from "./material-selection";
import { todayISO } from "./pricing";
import { quoteRefOf } from "./quote-number";
import { jobText } from "./refs";
import { getObject, putObject, signGet } from "./s3";
import { normaliseMobile, sendSms, SMS_OPT_OUT } from "./sms";
import { cardPaymentsOn, owingOn, payUrl } from "./stripe";
import { type Signature } from "./signature";
import { renderVariationPdf, type VariationPdfInput } from "./variationPdf";
import {
  bad,
  editableOrThrow,
  itemsOf,
  money,
  photoIdsOf,
  tokenFor,
  variationOrThrow,
  variationUrl,
  type Variation,
} from "./variations";

/* ---------------------------------------------------------------------------
 * A variation going out (item 12): by email with the PDF, or by SMS, both
 * with the /v/<token> link where the client reads, signs and accepts it.
 * Logged on the job's thread, the same as a quote. The signed copy comes back
 * by email after an online accept.
 * ------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

type Contact = typeof schema.contacts.$inferSelect;
export type Recipient = { contactId: number | null; name: string; email: string | null; mobile: string | null; why: string };

async function contextOf(v: Variation) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, v.jobId));
  if (!job) throw bad("The job for this variation is gone.");
  const [quote] = v.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, v.quoteId)) : [];
  return { job, quote: quote ?? null };
}

/** Who can get it: the quote's supervisor and client, the job's contact, people ticked on the job, the company. */
export async function variationRecipients(v: Variation): Promise<Recipient[]> {
  const { job, quote } = await contextOf(v);
  const out: Recipient[] = [];
  const add = (c: Contact | undefined, why: string) => {
    if (!c) return;
    const email = c.email?.trim() || null;
    const mobile = normaliseMobile(c.mobile);
    if (!email && !mobile) return;
    if (out.some((o) => o.contactId === c.id)) return;
    out.push({ contactId: c.id, name: fullName(c), email, mobile, why });
  };
  const byId = async (id: number | null | undefined) =>
    id ? (await db.select().from(schema.contacts).where(eq(schema.contacts.id, id)))[0] : undefined;
  if (quote?.supervisorContactId) add(await byId(quote.supervisorContactId), "Supervisor");
  if (quote?.contactId) add(await byId(quote.contactId), "Customer");
  if (job.contactId) add(await byId(job.contactId), "Customer");
  const onJob = await db
    .select({ contact: schema.contacts, link: schema.jobContacts })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, job.id))
    .orderBy(schema.jobContacts.id);
  for (const p of onJob) if (p.link.receivesEmail || p.link.receivesSms || p.link.canApproveQuote) add(p.contact, "On the job");
  const companyId = quote?.companyId ?? (job.billToType === "company" ? (job.billToCompanyId ?? job.companyId) : null);
  if (companyId) {
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId));
    const email = co?.email?.trim();
    if (co && email && !out.some((o) => o.email?.toLowerCase() === email.toLowerCase())) {
      out.push({ contactId: null, name: co.name, email, mobile: null, why: "Company" });
    }
  }
  return out;
}

/** Who it is addressed to and where, for the page and the PDF. */
export async function addressedFor(v: Variation) {
  const { job, quote } = await contextOf(v);
  const personId = quote?.supervisorContactId ?? quote?.contactId ?? job.billToContactId ?? job.contactId;
  const [person] = personId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, personId)) : [];
  const companyId = quote?.companyId ?? (job.billToType === "company" ? (job.billToCompanyId ?? job.companyId) : null);
  const [company] = companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)) : [];
  const [site] = job.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [];
  return {
    name: fullName(person) || company?.name || "",
    company: company?.name ?? null,
    email: person?.email || company?.email || null,
    phone: person?.mobile || null,
    siteAddress: site ? [site.address, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null,
    billedToCompany: !!companyId,
    jobRef: jobText(job),
    quoteRef: quote ? await quoteRefOf(quote) : null,
  };
}

/** The invoice it was billed on, with what is owing and the card link. */
export async function variationInvoice(v: Variation) {
  if (!v.invoiceId) return null;
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, v.invoiceId));
  if (!inv) return null;
  const owing = owingOn(inv);
  return { id: inv.id, ref: inv.number, total: inv.total, status: inv.status, owing, payUrl: cardPaymentsOn() && owing > 0 ? payUrl(inv.id) : null };
}

export function billNoteOf(v: Variation, invoiceRef: string | null) {
  if (v.billMode === "own") return invoiceRef ? `Billed on invoice ${invoiceRef}.` : "Billed on its own invoice once you accept.";
  return "Added to your final invoice.";
}

/** The photos picked to show why, with short-lived links. Archived ones drop off. */
export async function variationPhotos(v: Variation, expiresIn = 3600) {
  const ids = photoIdsOf(v);
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(schema.jobMedia)
    .where(and(eq(schema.jobMedia.jobId, v.jobId), inArray(schema.jobMedia.id, ids)));
  const kept = ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => !!r && !r.archivedAt);
  return Promise.all(
    kept.map(async (r) => ({ id: r.id, caption: r.caption, kind: r.kind, mime: r.mime, storageKey: r.storageKey, url: await signGet(r.storageKey, expiresIn) })),
  );
}

async function pdfPhotos(v: Variation) {
  const out: { bytes: Buffer; type: "png" | "jpg" }[] = [];
  for (const p of (await variationPhotos(v)).slice(0, 4)) {
    const mime = (p.mime ?? "").toLowerCase();
    const type = mime.includes("png") ? "png" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : null;
    if (!type) continue;
    try {
      out.push({ bytes: await getObject(p.storageKey), type });
    } catch (e) {
      console.error("[variation] photo not read for the PDF:", e);
    }
  }
  return out;
}

export async function variationPdfFor(id: number, signed?: VariationPdfInput["signed"]) {
  const v = await variationOrThrow(id);
  const to = await addressedFor(v);
  const lines = await itemsOf(v.id);
  const inv = await variationInvoice(v);
  const token = await tokenFor(v);
  const cardPay =
    v.billMode === "own" && cardPaymentsOn()
      ? inv
        ? inv.payUrl
          ? { url: inv.payUrl, note: `Pay invoice ${inv.ref} online by card.` }
          : null
        : { url: variationUrl(token), note: "Accept this variation online, then pay by card." }
      : null;
  const pdf = await renderVariationPdf({
    ref: v.ref,
    date: auDate(todayISO(v.sentAt ?? v.createdAt)),
    jobRef: to.jobRef,
    quoteRef: to.quoteRef,
    to: { name: to.name, company: to.company, address: null, email: to.email, phone: to.phone },
    siteAddress: to.siteAddress,
    reason: v.description,
    lines: lines.map((l) => ({ description: l.description, qty: l.qty, unit: l.unit })),
    subtotal: v.subtotal,
    gst: v.gst,
    total: v.total,
    billNote: billNoteOf(v, inv?.ref ?? null),
    payRef: v.billMode === "own" ? (inv?.ref ?? v.ref) : null,
    cardPay,
    showPosition: to.billedToCompany,
    signed: signed ?? null,
    photos: await pdfPhotos(v),
  });
  return { pdf, filename: `Terra Flooring variation ${v.ref}.pdf`, ref: v.ref };
}

/** What the send dialog opens with. The office can change any of it. */
export async function variationDraft(id: number) {
  const v = await variationOrThrow(id);
  const recipients = await variationRecipients(v);
  const to = await addressedFor(v);
  const url = variationUrl(await tokenFor(v));
  const first = (recipients[0]?.name || to.name).split(" ")[0] || "there";
  const why = v.description.trim() ? `: ${v.description.trim().replace(/\.$/, "")}.` : ".";
  const billing = v.billMode === "own" ? "It is billed on its own invoice once you accept." : "It goes on your final invoice.";
  return {
    recipients,
    email: recipients.find((r) => r.email)?.email ?? "",
    mobile: recipients.find((r) => r.mobile)?.mobile ?? "",
    subject: `Variation ${v.ref} for job ${to.jobRef}`,
    body: [
      `Hi ${first},`,
      "",
      `We have priced a variation to your job ${to.jobRef}${why}`,
      "",
      `The variation comes to ${money(v.total)} inc GST. ${billing}`,
      "",
      `View, sign and accept it online: ${url}`,
      "",
      "Kind regards,",
      "Damien",
      "Terra Flooring",
    ].join("\n"),
    sms: `Hi ${first}, Terra Flooring here. Variation ${v.ref} for your job comes to ${money(v.total)} inc GST. View and accept it here: ${url}`,
    url,
  };
}

async function attachPdf(messageId: number, key: string, pdf: Buffer, filename: string) {
  await putObject(key, pdf, "application/pdf", filename);
  await db.insert(schema.messageAttachments).values({ messageId, filename, mime: "application/pdf", sizeBytes: pdf.length, storageKey: key, url: "" });
}

/**
 * Send it. Nothing is marked sent unless the email or text went. The link is
 * put back in if the office edited it out.
 */
export async function sendVariation(args: {
  id: number;
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
  byName: string;
  byProfileId?: number | null;
  actorRole: string;
}) {
  const v = await editableOrThrow(args.id);
  const lines = await itemsOf(v.id);
  if (!lines.length) throw bad("Add at least one line before sending.");
  if (!(v.total > 0)) throw bad("This variation comes to $0. Check the lines before sending.");
  const url = variationUrl(await tokenFor(v));
  const conv = await ensureForJob(v.jobId);
  let messageId: number;
  let sentTo: string;

  if (args.channel === "email") {
    const to = args.to.trim();
    if (!EMAIL_RE.test(to)) throw bad(`"${to}" is not an email address.`);
    const body = args.body.includes(url) ? args.body : `${args.body.trimEnd()}\n\nView and accept the variation online: ${url}`;
    const subject = subjectWithRef(args.subject?.trim() || `Variation ${v.ref}`, conv.ref);
    const { pdf, filename } = await variationPdfFor(v.id);
    const out = await sendAsTeam({ to, subject, text: body, fromName: SENDER_NAME, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, to)).limit(1);
    const msg = await logMessage({
      conversationId: conv.id,
      jobId: v.jobId,
      contactId: contact?.id ?? null,
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
    await attachPdf(msg.id, `variations/${v.jobId}/${v.id}/sent-${stamp()}.pdf`, pdf, filename);
    if (contact) await addParticipant(conv.id, { role: "customer", contactId: contact.id, name: fullName(contact), email: contact.email, mobile: contact.mobile });
    messageId = msg.id;
    sentTo = to;
  } else {
    const mobile = normaliseMobile(args.to);
    if (!mobile) throw bad(`"${args.to}" is not an Australian mobile number.`);
    const text = (args.body.includes(url) ? args.body.trim() : `${args.body.trim()} ${url}`) + SMS_OPT_OUT;
    const out = await sendSms({ to: mobile, body: text, sender: "number", needsReply: true });
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.mobile, args.to.trim())).limit(1);
    const msg = await logMessage({
      conversationId: conv.id,
      jobId: v.jobId,
      contactId: contact?.id ?? null,
      channel: "sms",
      audience: "customer",
      direction: "out",
      body: text,
      authorName: args.byName,
      authorProfileId: args.byProfileId ?? null,
      toAddress: mobile,
      providerId: out.ok ? out.providerId : null,
      status: out.ok ? "sent" : "failed",
      statusDetail: out.ok ? null : out.reason,
      failedAt: out.ok ? null : new Date(),
    });
    if (!out.ok) throw bad(`The text did not go: ${out.reason}`);
    messageId = msg.id;
    sentTo = mobile;
  }

  const now = new Date();
  const [row] = await db.update(schema.variations).set({ status: "sent", sentAt: now, updatedAt: now }).where(eq(schema.variations.id, v.id)).returning();
  await db.insert(schema.activityLog).values({
    jobId: v.jobId,
    entityType: "variation",
    entityId: v.id,
    action: "variation_sent",
    detail: `Variation ${v.ref} (${money(v.total)}) sent by ${args.channel === "email" ? "email" : "SMS"} to ${sentTo}`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  return { variation: row!, to: sentTo, messageId, url };
}

/** After an online accept: the signed PDF on the thread and a copy to the signer. Never undoes the accept. */
export async function sendVariationSignedCopy(args: {
  variation: Variation;
  signatureId: number;
  signerName: string;
  signerEmail: string | null;
  signed: { name: string; position: string; date: string; signature: Signature };
}) {
  const v = args.variation;
  const { pdf, filename } = await variationPdfFor(v.id, args.signed);
  const key = `variations/${v.jobId}/${v.id}/signed-${stamp()}.pdf`;
  const conv = await ensureForJob(v.jobId);
  const inv = await variationInvoice(v);
  const first = args.signerName.split(" ")[0] || "there";
  const lines = [`Hi ${first},`, "", `Thanks for accepting variation ${v.ref} for ${money(v.total)} inc GST. Your signed copy is attached.`, ""];
  if (inv && inv.owing > 0) {
    lines.push(`Your invoice is ${inv.ref} for ${money(inv.total)}.`, "");
    if (inv.payUrl) lines.push("Pay by card online:", inv.payUrl, "", `Or pay by bank transfer and use ${inv.ref} as the reference.`, "");
    else lines.push(`Please pay by bank transfer and use ${inv.ref} as the reference.`, "");
  } else if (v.billMode === "final") {
    lines.push("It will go on your final invoice.", "");
  }
  lines.push("Kind regards,", "Damien", "Terra Flooring");
  const body = lines.join("\n");
  const subject = subjectWithRef(`Variation ${v.ref} accepted, your signed copy`, conv.ref);

  let providerId: string | null = null;
  let failed: string | null = null;
  const to = args.signerEmail?.trim() || null;
  if (to && EMAIL_RE.test(to)) {
    try {
      const out = await sendAsTeam({ to, subject, text: body, fromName: SENDER_NAME, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
      providerId = out.id;
    } catch (e) {
      failed = String((e as Error)?.message ?? e).slice(0, 300);
      console.error("[variation] signed copy email failed:", failed);
    }
  }
  const msg = await logMessage({
    conversationId: conv.id,
    jobId: v.jobId,
    channel: to ? "email" : "note",
    audience: to ? "customer" : "internal",
    direction: "out",
    subject: to ? subject : null,
    body: to ? body : `${args.signerName} accepted variation ${v.ref} online. Signed copy attached.`,
    authorName: "Terra Ops",
    toAddress: to,
    providerId,
    status: failed ? "failed" : "sent",
    statusDetail: failed,
    failedAt: failed ? new Date() : null,
  });
  await attachPdf(msg.id, key, pdf, filename);
  await db.update(schema.variationSignatures).set({ pdfKey: key, updatedAt: new Date() }).where(eq(schema.variationSignatures.id, args.signatureId));
  return { key, emailed: Boolean(providerId), failed };
}
