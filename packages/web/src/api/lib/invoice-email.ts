import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendAsTeam } from "./agent-mail";
import { addParticipant, ensureForJob, logMessage, subjectWithRef } from "./conversations";
import { INVOICE_KIND_LABEL } from "./client-invoices";
import { SENDER_NAME } from "./material-selection";
import { TERRA_PRINT } from "./quotePdf";
import { cardPaymentsOn, owingOn, payUrl } from "./stripe";

/* ---------------------------------------------------------------------------
 * Email a client invoice with its Pay by card link (fix list item 6). Bank
 * transfer details stay in the email as they are on the quote. Goes from
 * team@ like every client email and is logged on the job's thread.
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

export async function sendInvoiceEmail(args: { invoiceId: number; to?: string | null; byName: string; actorRole: string; byProfileId?: number | null }) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, args.invoiceId));
  if (!inv) throw bad("Invoice not found");
  if (!inv.jobId) throw bad("This invoice is not on a job.");
  const owing = owingOn(inv);
  if (!(owing > 0)) throw bad(inv.status === "void" ? "This invoice is void." : "Nothing is owing on this invoice.");
  const found = await invoiceRecipient(inv);
  const to = args.to?.trim() || found?.email || "";
  if (!EMAIL_RE.test(to)) throw bad(to ? `"${to}" is not an email address.` : "No email address on file for this client. Type one in.");

  const conv = await ensureForJob(inv.jobId);
  const subject = subjectWithRef(`Terra Flooring invoice ${inv.number}`, conv.ref);
  const text = invoiceEmailBody({
    first: found && found.email.toLowerCase() === to.toLowerCase() ? found.first : "",
    ref: inv.number,
    label: inv.label || INVOICE_KIND_LABEL[inv.kind] || "",
    owing,
    url: cardPaymentsOn() ? payUrl(inv.id) : null,
  });
  const out = await sendAsTeam({ to, subject, text, fromName: SENDER_NAME });
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.email, to)).limit(1);
  await logMessage({
    conversationId: conv.id,
    jobId: inv.jobId,
    contactId: contact?.id ?? null,
    channel: "email",
    audience: "customer",
    direction: "out",
    subject,
    body: text,
    authorName: args.byName,
    authorProfileId: args.byProfileId ?? null,
    toAddress: to,
    providerId: out.id,
    status: "sent",
  });
  if (contact) {
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
    await addParticipant(conv.id, { role: "customer", contactId: contact.id, name, email: contact.email, mobile: contact.mobile });
  }
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: "invoice_emailed",
    detail: `${inv.number} emailed to ${to}${cardPaymentsOn() ? " with the Pay by card link" : ""}`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  return { to, via: out.via };
}
