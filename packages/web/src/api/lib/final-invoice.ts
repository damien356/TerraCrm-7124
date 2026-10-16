import { ORPCError } from "@orpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { jobBillTo, quoteBillTo } from "./bill-to";
import { raiseInvoice } from "./client-invoices";
import { loadDepositMaps, loadTermsMaps, resolveTerms, settleDate, termsLabel, today } from "./cashflow";
import { quoteRefOf } from "./quote-number";
import { jobText } from "./refs";

/* ---------------------------------------------------------------------------
 * The final and progress invoices (188001 fix list items 9 and 13).
 *
 * Until now the only invoice Terra raised by itself was the deposit. A
 * builder on 0% deposit got nothing at all. The office raises the rest from
 * the job's Client invoices card, and a supply only job raises its final
 * invoice when it is marked delivered.
 *
 * What is left to bill is the job value less every invoice that is not void.
 * The job value already carries the accepted variations (variation-accept.ts),
 * so a variation billed on the final invoice is in that figure. The due date
 * follows the payer's terms, the same ones the forecast uses.
 * ------------------------------------------------------------------------- */

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Noon Brisbane on a YYYY-MM-DD day, so the date never slips a day either side. */
export const dayAt = (isoDay: string) => new Date(`${isoDay}T12:00:00+10:00`);

export const prettyDay = (isoDay: string) =>
  dayAt(isoDay).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" });

/** The newest accepted quote on the job, if there is one. */
export async function acceptedQuoteOf(jobId: number) {
  const [q] = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id))
    .limit(1);
  return q ?? null;
}

/** Where the invoice email goes by default: the billed contact, else the company's accounts email. */
async function recipientFor(job: typeof schema.jobs.$inferSelect, quote: typeof schema.quotes.$inferSelect | null) {
  // Notes 18.54: the accepted quote's Bill to is who pays, else the job's.
  const payer = (quote ? quoteBillTo(quote) : null) ?? jobBillTo(job);
  if (payer?.type === "company") {
    const id = payer.id;
    const [co] = await db.select({ email: schema.companies.email, name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, id));
    const email = co?.email?.trim() || "";
    return EMAIL_RE.test(email) ? { email, who: `${co?.name ?? "the company"} accounts` } : null;
  }
  const id = payer?.id;
  if (!id) return null;
  const [c] = await db
    .select({ email: schema.contacts.email, first: schema.contacts.firstName, last: schema.contacts.lastName })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, id));
  const email = c?.email?.trim() || "";
  return EMAIL_RE.test(email) ? { email, who: [c?.first, c?.last].filter(Boolean).join(" ").trim() || "the client" } : null;
}

/** The payer's terms, and the due date of an invoice raised on `fromDay`. */
async function dueFor(job: typeof schema.jobs.$inferSelect, fromDay: string) {
  const [{ byJob, byCompany }, deposits] = await Promise.all([loadTermsMaps(), loadDepositMaps()]);
  const terms = resolveTerms(job.companyId, job.id, byJob, byCompany, { deposits, contactId: job.contactId });
  return { dueDay: settleDate(fromDay, terms.termsDays, terms.endOfMonth), termsText: termsLabel(terms.termsDays, terms.endOfMonth) };
}

/** What the job page needs to raise an invoice: what is left to bill, the default due date and who it goes to. */
export async function billingOnJob(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const [live, quote, status] = await Promise.all([
    db
      .select({ number: schema.invoices.number, kind: schema.invoices.kind, total: schema.invoices.total })
      .from(schema.invoices)
      .where(and(eq(schema.invoices.jobId, jobId), sql`${schema.invoices.status} != 'void'`)),
    acceptedQuoteOf(jobId),
    job.statusId
      ? db.select({ name: schema.jobStatuses.name }).from(schema.jobStatuses).where(eq(schema.jobStatuses.id, job.statusId))
      : Promise.resolve([] as { name: string }[]),
  ]);
  const jobValue = round2(job.value ?? 0);
  const billed = round2(live.reduce((s, r) => s + (r.total ?? 0), 0));
  const toBill = round2(Math.max(0, jobValue - billed));
  const final = live.find((r) => r.kind === "final") ?? null;
  const quoteRef = quote ? await quoteRefOf(quote) : null;
  const statusName = (status[0]?.name ?? "").trim().toLowerCase();
  const { dueDay, termsText } = await dueFor(job, today());
  const recipient = await recipientFor(job, quote);

  let reason: string | null = null;
  if (job.parentJobId && job.callbackChargeable === false) reason = "This callback is not chargeable. Nothing is billed.";
  else if (!quote && (statusName === "" || statusName === "lead" || statusName === "quoted")) reason = "The quote is not accepted yet.";
  else if (toBill <= 0.005) reason = billed > 0 ? "Everything on this job has been billed." : "The job has no value to bill.";

  return {
    jobValue,
    billed,
    toBill,
    finalRef: final?.number ?? null,
    quoteId: quote?.id ?? null,
    quoteRef,
    dueDay,
    termsText,
    recipient,
    canRaise: reason === null,
    reason,
    jobRef: jobText(job),
  };
}

export const RAISE_KINDS = ["final", "stage"] as const;

export function defaultInvoiceLabel(kind: (typeof RAISE_KINDS)[number], ref: string) {
  return kind === "final" ? `Final invoice, ${ref}` : `Progress invoice, ${ref}`;
}

/**
 * Raise a final or progress invoice on a job, for no more than is left to
 * bill. One live final per job: a second one has to be a progress invoice,
 * or the first is voided.
 */
export async function raiseJobInvoice(args: {
  jobId: number;
  kind: (typeof RAISE_KINDS)[number];
  amount?: number | null;
  label?: string | null;
  /** The day the terms count from when they run from completion. Today if left out. */
  completionDay?: string | null;
  actor: { name: string; role: string };
}) {
  const bill = await billingOnJob(args.jobId);
  if (!bill.canRaise) throw bad(bill.reason ?? "Nothing to bill.");
  if (args.kind === "final" && bill.finalRef) {
    throw bad(`Final invoice ${bill.finalRef} is already raised. Raise a progress invoice, or void ${bill.finalRef} first.`);
  }
  const amount = round2(args.amount ?? bill.toBill);
  if (!(amount > 0)) throw bad("Enter an amount over $0.");
  if (amount > bill.toBill + 0.005) throw bad(`That is more than the ${money(bill.toBill)} not billed yet.`);

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const [{ byJob, byCompany }, deposits] = await Promise.all([loadTermsMaps(), loadDepositMaps()]);
  const terms = resolveTerms(job.companyId, job.id, byJob, byCompany, { deposits, contactId: job.contactId });
  const from = terms.termsFrom === "completion" && args.completionDay ? args.completionDay : today();
  const dueDay = settleDate(from, terms.termsDays, terms.endOfMonth);

  const ref = bill.quoteRef ? `quote ${bill.quoteRef}` : `job ${bill.jobRef}`;
  const label = args.label?.trim() || defaultInvoiceLabel(args.kind, ref);
  return raiseInvoice({
    jobId: job.id,
    quoteId: bill.quoteId,
    kind: args.kind,
    label: label.slice(0, 200),
    total: amount,
    createdByName: args.actor.name,
    actorRole: args.actor.role,
    dueDate: dayAt(dueDay),
  });
}
