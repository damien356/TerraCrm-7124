import { ORPCError } from "@orpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { clientInvoicePdfFor } from "./clientInvoicePdf";
import { ensureForJob } from "./conversations";
import { pickedFiles, sendJobEmail, type MailUpload } from "./job-mail";
import { INVOICE_KIND_LABEL } from "./client-invoices";
import { SENDER_NAME } from "./material-selection";
import { TERRA_PRINT } from "./quotePdf";
import { cardPaymentsOn, owingOn, payUrl } from "./stripe";

/* ---------------------------------------------------------------------------
 * Email a client invoice with its PDF and Pay by card link (fix list item 6,
 * spec 15 Oct). Bank transfer details stay in the email as they are on the
 * quote. Goes from team@ like every client email and is logged on the job's
 * thread.
 * ------------------------------------------------------------------------- */

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Who the invoice email goes to by default: the billed contact, else the company. */
export async function invoiceRecipient(inv: typeof schema.invoices.$inferSelect) {
  if (inv.billToContactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, inv.billToContactId));
    if (c?.email?.trim()) return { email: c.email.trim(), first: c.firstName?.trim() || "", contact: c };
  }
  if (inv.billToCompanyId) {
    const [co] = await db.select().from(schema.companies).where(eq(schema.companies.id, inv.billToCompanyId));
    if (co?.email?.trim()) return { email: co.email.trim(), first: "", contact: null };
  }
  return null;
}

export function invoiceEmailBody(args: { first: string; ref: string; label: string; owing: number; url: string | null }) {
  const lines = [
    `Hi ${args.first || "there"},`,
    "",
    `Here is your invoice ${args.ref}${args.label ? ` (${args.label})` : ""} for ${money(args.owing)} including GST.`,
    "",
  ];
  if (args.url) lines.push("Pay by card online:", args.url, "", "Or pay by bank transfer:");
  else lines.push("Please pay by bank transfer:");
  lines.push(
    `Account name: ${TERRA_PRINT.bank.name}`,
    `BSB: ${TERRA_PRINT.bank.bsb}`,
    `Account: ${TERRA_PRINT.bank.account}`,
    `Reference: ${args.ref}`,
    "",
    "Any questions, just reply to this email or call me on 1300 183 772.",
    "",
    "Kind regards,",
    "Damien",
    "Terra Flooring",
  );
  return lines.join("\n");
}

export async function sendInvoiceEmail(args: {
  invoiceId: number;
  to?: string | null;
  cc?: string[];
  mediaIds?: number[];
  uploads?: MailUpload[];
  byName: string;
  actorRole: string;
  byProfileId?: number | null;
}) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, args.invoiceId));
  if (!inv) throw bad("Invoice not found");
  if (!inv.jobId) throw bad("This invoice is not on a job.");
  const owing = owingOn(inv);
  if (!(owing > 0)) throw bad(inv.status === "void" ? "This invoice is void." : "Nothing is owing on this invoice.");
  const found = await invoiceRecipient(inv);
  const to = args.to?.trim() || found?.email || "";
  if (!EMAIL_RE.test(to)) throw bad(to ? `"${to}" is not an email address.` : "No email address on file for this client. Type one in.");

  for (const c of args.cc ?? []) if (!EMAIL_RE.test(c.trim())) throw bad(`"${c}" is not an email address.`);

  const conv = await ensureForJob(inv.jobId);
  const url = cardPaymentsOn() ? payUrl(inv.id) : null;
  const text = invoiceEmailBody({
    first: found && found.email.toLowerCase() === to.toLowerCase() ? found.first : "",
    ref: inv.number,
    label: inv.label || INVOICE_KIND_LABEL[inv.kind] || "",
    owing,
    url,
  });
  /* The invoice itself goes as a PDF, with the pay link in the email (spec 15 Oct). */
  const { pdf, filename, snapshot, fresh } = await clientInvoicePdfFor(inv.id);
  const picked = await pickedFiles({ jobId: inv.jobId, mediaIds: args.mediaIds, uploads: args.uploads, byName: args.byName, byProfileId: args.byProfileId });
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, to)).limit(1);
  const sent = await sendJobEmail({
    conv,
    jobId: inv.jobId,
    to,
    cc: args.cc,
    subject: `Terra Flooring invoice ${inv.number}`,
    text,
    fromName: SENDER_NAME,
    files: [{ filename, content: pdf, contentType: "application/pdf", storeAt: `invoices/${inv.jobId}/${inv.id}/sent-${Date.now()}.pdf` }, ...picked],
    label: `Invoice ${inv.number}`,
    contactId: contact?.id ?? null,
    authorName: args.byName,
    authorProfileId: args.byProfileId ?? null,
  });
  // The first email fixes what the invoice says. Later sends draw from this, not from the job as it is then.
  if (fresh) {
    await db
      .update(schema.invoices)
      .set({ issuedSnapshot: JSON.stringify(snapshot), updatedAt: new Date() })
      .where(and(eq(schema.invoices.id, inv.id), isNull(schema.invoices.issuedSnapshot)));
  }
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: "invoice_emailed",
    detail: `${inv.number} emailed to ${to} with the PDF${url ? " and the Pay by card link" : ""}${fresh && !snapshot.legacy ? "" : `, as first issued on ${snapshot.issuedAt.slice(0, 10)}`}`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  const withheld = snapshot.summary.state === "withheld" ? snapshot.summary.reason : null;
  if (withheld && fresh && !snapshot.legacy) await flagWithheld(inv, withheld, args.byName, args.actorRole);
  return {
    to,
    via: sent.via,
    messageId: sent.message.id,
    linked: sent.linked,
    /** Set when the PDF went without its billing summary because the figures did not hold together. */
    summaryWithheld: withheld,
  };
}

/**
 * The billing summary did not add up, so the invoice went without it (Damien,
 * 26 Oct). The office is told on the job and with a task, once per invoice.
 */
async function flagWithheld(inv: typeof schema.invoices.$inferSelect, reason: string, byName: string, actorRole: string) {
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: "invoice_summary_withheld",
    detail: `${inv.number} went without its billing summary: ${reason}`,
    actorName: byName,
    actorRole,
  });
  const title = `Check the billing on ${inv.number}`;
  const [open] = await db
    .select({ id: schema.officeTasks.id })
    .from(schema.officeTasks)
    .where(and(eq(schema.officeTasks.jobId, inv.jobId!), eq(schema.officeTasks.title, title)))
    .limit(1);
  if (open) return;
  await db.insert(schema.officeTasks).values({
    jobId: inv.jobId,
    title,
    detail: `${inv.number} was emailed without the billing summary, because the figures did not agree.\n${reason}\nThe invoice and its amount due are right. Check the job value, the quote, the variations and the other invoices on the job.`,
    createdByName: byName,
  });
}
