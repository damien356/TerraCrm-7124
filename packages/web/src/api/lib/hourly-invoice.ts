import type { Client } from "@libsql/client";
import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { addLocalDays, localDate, todayLocal, weekdayOf } from "./local-date";
import { jobRef } from "./job-ref";
import { taskRef } from "./refs";
import { abnView } from "./abn-check";
import { EMPLOYEE_NO_INVOICE, isEmployee } from "./worker-type";
import { HOURLY_ITEM, RATE_TO_CONFIRM } from "./hourly";
import { round2 } from "./hourly-calc";
import { renderInvoicePdf, type InvoiceLineItem } from "./invoicePdf";
import { getObject, periodInvoicePdfKey, putObject, signGet } from "./s3";
import { sendEmail } from "./email";
import { hourlyInvoicingReady } from "./period-invoices";

/* ---------------------------------------------------------------------------
 * HOURLY CONTRACTOR INVOICING (Damien, 13 Nov 2026).
 *
 * Finishing work saves the hours. Invoicing is his own separate choice: today,
 * this week (Mon to Sun, Brisbane) or dates he picks, across any number of
 * jobs. Only his approved, payable time not billed before can go on it.
 *
 * Issue is ONE database write: the invoice, a link row per time entry, the
 * entry's invoice id, the paperwork details and his next invoice number all
 * land together or not at all. The unique link index means an entry can only
 * ever sit on one invoice, and the CHECK on the details row refuses the whole
 * write if fewer entries were claimed than were shown, so double taps,
 * retries and two phones can never bill the same time twice. The PDF and the
 * emails come after the write. A failed send is sent again, never re-issued.
 * ------------------------------------------------------------------------- */

/** Payment terms on every hourly contractor invoice (Damien, 13 Nov 2026). */
export const TERMS_DAYS = 7;

export const BILLING_EMAIL = "billing@terraflooring.com.au";

export { hourlyInvoicingReady, resetHourlyInvoicingReady } from "./period-invoices";

export const NOT_READY = "Invoicing by dates is not switched on yet. Terra office will let you know.";

/* ------------------------------ Dates ------------------------------------ */

const ymd = /^\d{4}-\d{2}-\d{2}$/;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function sayDate(d: string) {
  const x = new Date(`${d}T00:00:00Z`);
  return `${DOW[x.getUTCDay()]} ${x.getUTCDate()} ${MON[x.getUTCMonth()]}`;
}
export function sayDateYear(d: string) {
  const x = new Date(`${d}T00:00:00Z`);
  return `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** Monday to Sunday of the week holding this Brisbane date. */
export function weekOf(date: string = todayLocal()) {
  const dow = weekdayOf(date); // 0 Sunday
  const from = addLocalDays(date, dow === 0 ? -6 : 1 - dow);
  return { from, to: addLocalDays(from, 6) };
}

export type PeriodChoice = { kind: "today" } | { kind: "week" } | { kind: "dates"; from: string; to: string };

export function periodOf(choice: PeriodChoice, today: string = todayLocal()) {
  if (choice.kind === "today") return { from: today, to: today };
  if (choice.kind === "week") return weekOf(today);
  if (!ymd.test(choice.from) || !ymd.test(choice.to)) throw new ORPCError("BAD_REQUEST", { message: "Pick a start and end date." });
  if (choice.from > choice.to) throw new ORPCError("BAD_REQUEST", { message: "The start date is after the end date." });
  if (choice.from > today) throw new ORPCError("BAD_REQUEST", { message: "Those dates are in the future. Only work already done can be invoiced." });
  return { from: choice.from, to: choice.to > today ? today : choice.to };
}

/* ------------------------------ Entries ---------------------------------- */

type Line = { band?: string; label: string; minutes: number; rate: number; total: number };
function linesOf(json: string | null): Line[] {
  try {
    return json ? (JSON.parse(json) as Line[]) : [];
  } catch {
    return [];
  }
}

export type EntryView = {
  id: number;
  workDate: string;
  jobId: number;
  taskId: number;
  jobRef: string;
  taskRef: string;
  taskTitle: string;
  minutes: number;
  amount: number;
  rate: number | null;
  /** Why it can't go on an invoice, in his words. Null when it can. */
  reason: string | null;
};

/**
 * His time entries worked in the dates, sorted into what can be invoiced and
 * what can't, each with the reason. Nothing is changed.
 */
export async function entriesFor(installerId: number, from: string, to: string) {
  const rows = await db
    .select({
      s: schema.workSessions,
      taskSeq: schema.jobTasks.seq,
      taskTitle: schema.jobTasks.title,
      jobNumber: schema.jobs.number,
      jobDisplay: schema.jobs.displayNumber,
    })
    .from(schema.workSessions)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.workSessions.taskId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.workSessions.jobId))
    .where(and(eq(schema.workSessions.installerId, installerId), gte(schema.workSessions.workDate, from), lte(schema.workSessions.workDate, to)))
    .orderBy(asc(schema.workSessions.workDate), asc(schema.workSessions.startedAt));

  const ready: EntryView[] = [];
  const held: EntryView[] = [];
  const billed: Array<EntryView & { invoiceId: number }> = [];
  for (const r of rows) {
    const s = r.s;
    if (s.status === "rejected") continue;
    const jr = jobRef({ number: r.jobNumber, displayNumber: r.jobDisplay });
    const base: Omit<EntryView, "reason"> = {
      id: s.id,
      workDate: s.workDate,
      jobId: s.jobId,
      taskId: s.taskId,
      jobRef: jr,
      taskRef: taskRef(jr, r.taskSeq),
      taskTitle: r.taskTitle,
      minutes: s.approvedMinutes ?? 0,
      amount: round2(s.approvedPay ?? 0),
      rate: s.rateBase,
    };
    if (s.invoiceId != null) {
      billed.push({ ...base, reason: "Already on an invoice", invoiceId: s.invoiceId });
      continue;
    }
    let reason: string | null = null;
    if (s.status === "open") reason = "Still running. Finish work first.";
    else if (s.status === "recorded" && s.correctionRequestedAt) reason = "Correction asked for. Waiting for Terra office to check it.";
    else if (s.status === "recorded") reason = "Waiting for Terra office to approve.";
    else if (s.status !== "approved") reason = "Not approved.";
    else if (!((s.rateBase ?? 0) > 0)) reason = `${HOURLY_ITEM}: ${RATE_TO_CONFIRM}.`;
    else if (s.payable !== true) reason = "Approved as not paid time.";
    if (reason) held.push({ ...base, reason });
    else ready.push({ ...base, reason: null });
  }
  return { ready, held, billed };
}

/**
 * One invoice line per day, job and rate. Different rates are never merged.
 * The amounts are the ones approved on each entry, so the invoice always adds
 * up to the approved pay.
 */
export async function invoiceLines(sessionIds: number[]) {
  if (!sessionIds.length) return [] as Array<InvoiceLineItem & { workDate: string; jobId: number; taskId: number; minutes: number; sessionIds: number[] }>;
  const rows = await db
    .select({ s: schema.workSessions, taskSeq: schema.jobTasks.seq, taskTitle: schema.jobTasks.title, jobNumber: schema.jobs.number, jobDisplay: schema.jobs.displayNumber })
    .from(schema.workSessions)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.workSessions.taskId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.workSessions.jobId))
    .where(inArray(schema.workSessions.id, sessionIds))
    .orderBy(asc(schema.workSessions.workDate), asc(schema.workSessions.startedAt));
  const groups = new Map<string, InvoiceLineItem & { workDate: string; jobId: number; taskId: number; minutes: number; sessionIds: number[] }>();
  for (const r of rows) {
    const jr = jobRef({ number: r.jobNumber, displayNumber: r.jobDisplay });
    for (const l of linesOf(r.s.payLines)) {
      if (l.minutes <= 0) continue;
      const key = `${r.s.workDate}|${r.s.taskId}|${l.label}|${l.rate}`;
      const g = groups.get(key);
      if (g) {
        g.minutes += l.minutes;
        g.total = round2((g.total ?? 0) + l.total);
        g.qty = round2(g.minutes / 60);
        if (!g.sessionIds.includes(r.s.id)) g.sessionIds.push(r.s.id);
      } else {
        groups.set(key, {
          description: `${sayDate(r.s.workDate)}, Job ${taskRef(jr, r.taskSeq)} ${r.taskTitle}: ${l.label}`,
          unit: "hour",
          qty: round2(l.minutes / 60),
          rate: l.rate,
          total: round2(l.total),
          workDate: r.s.workDate,
          jobId: r.s.jobId,
          taskId: r.s.taskId,
          minutes: l.minutes,
          sessionIds: [r.s.id],
        });
      }
    }
  }
  return [...groups.values()];
}

/* ------------------------------ Preview ---------------------------------- */

type InstallerRow = typeof schema.installers.$inferSelect;

function setupBlock(i: InstallerRow): string | null {
  if (isEmployee(i)) return EMPLOYEE_NO_INVOICE;
  if (i.nextInvoiceNumber == null) return "Terra office hasn't set up your invoice numbering yet. Ask them to enable invoicing before you invoice.";
  if (!abnView(i).passes) return "Ask Terra office to check your ABN before you invoice.";
  if (!i.bankBsb || !i.bankAccountNumber || !i.bankAccountName) return "Add your bank details on the Me tab (Bank details) before you invoice.";
  return null;
}

/**
 * The GST on this invoice, checked before issue. He never picks it himself:
 * it comes from the terms each entry was approved under, and they must agree
 * with each other and with his record. Any disagreement stops the invoice
 * until the office confirms it.
 */
export function gstCheck(installer: InstallerRow, entries: Array<{ gstRegistered: boolean | null }>) {
  const flags = new Set(entries.map((e) => e.gstRegistered === true));
  if (flags.size > 1) return { gst: false, block: "Some of these days were approved as GST registered and some not. Ask Terra office to confirm your GST before you invoice." };
  const gst = flags.has(true);
  if (entries.length && gst !== installer.gstRegistered) {
    return { gst, block: "Your GST registration on file does not match your hourly pay terms. Ask Terra office to confirm your GST before you invoice." };
  }
  return { gst, block: null as string | null };
}

export type PreviewInput = { period: PeriodChoice; sessionIds?: number[] };

/**
 * What an invoice for these dates would hold. Read only: nothing is claimed
 * and no number is used.
 */
export async function previewPeriod(installerId: number, input: PreviewInput, today: string = todayLocal()) {
  if (!(await hourlyInvoicingReady())) throw new ORPCError("BAD_REQUEST", { message: NOT_READY });
  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
  const { from, to } = periodOf(input.period, today);
  const { ready, held, billed } = await entriesFor(installerId, from, to);
  const chosen = input.sessionIds?.length ? ready.filter((e) => input.sessionIds!.includes(e.id)) : ready;
  const lines = await invoiceLines(chosen.map((e) => e.id));
  const sessions = chosen.length ? await db.select({ id: schema.workSessions.id, gstRegistered: schema.workSessions.gstRegistered }).from(schema.workSessions).where(inArray(schema.workSessions.id, chosen.map((e) => e.id))) : [];
  const g = gstCheck(installer, sessions);
  const subtotal = round2(lines.reduce((a, l) => a + (l.total ?? 0), 0));
  const gstAmount = g.gst ? round2(subtotal * 0.1) : 0;
  const minutes = lines.reduce((a, l) => a + l.minutes, 0);
  const abn = abnView(installer);
  const block = setupBlock(installer) ?? (chosen.length === 0 ? (held.length ? "Nothing in these dates is ready to invoice yet." : "There is no approved time in these dates.") : g.block);
  return {
    from,
    to,
    entries: ready.map((e) => ({ ...e, selected: chosen.some((c) => c.id === e.id) })),
    held,
    billed: billed.map((b) => ({ id: b.id, workDate: b.workDate, taskRef: b.taskRef, invoiceId: b.invoiceId })),
    lines: lines.map(({ description, unit, qty, rate, total, workDate, jobId, taskId }) => ({ description, unit, qty, rate, total, workDate, jobId, taskId })),
    jobs: [...new Set(chosen.map((e) => e.taskRef))],
    hours: round2(minutes / 60),
    subtotal,
    gstRegistered: g.gst,
    gstAmount,
    total: round2(subtotal + gstAmount),
    title: g.gst ? "Tax Invoice" : "Invoice",
    gstNote: g.gst ? "GST at 10% is included in the total." : "No GST charged. Not registered for GST.",
    termsDays: TERMS_DAYS,
    issueDate: today,
    dueDate: addLocalDays(today, TERMS_DAYS),
    nextInvoiceNumber: installer.nextInvoiceNumber,
    from_: { billName: abn.billName, abn: installer.abn },
    canIssue: !block,
    blockedReason: block,
  };
}

/* ------------------------------ Issue ------------------------------------ */

const inList = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Issue one invoice for these entries, in one write. The request key comes
 * from the phone, once per Issue tap: the same key always returns the same
 * invoice, so a retry on bad signal never makes a second one.
 */
export async function issuePeriod(installerId: number, input: PreviewInput & { requestKey: string }, today: string = todayLocal()) {
  if (!(await hourlyInvoicingReady())) throw new ORPCError("BAD_REQUEST", { message: NOT_READY });
  const again = await byRequestKey(installerId, input.requestKey);
  if (again) return { invoice: again, repeated: true as const };

  // What each of his unbilled approved entries looks like right now, read
  // BEFORE the preview. The write only claims an entry still exactly like
  // this (same minutes, same approval), so any change after this moment
  // stops the whole invoice instead of billing a stale amount.
  const snap = await db
    .select({ id: schema.workSessions.id, minutes: schema.workSessions.approvedMinutes, approvedAt: schema.workSessions.approvedAt, taskId: schema.workSessions.taskId, jobId: schema.workSessions.jobId, workDate: schema.workSessions.workDate })
    .from(schema.workSessions)
    .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.status, "approved"), isNull(schema.workSessions.invoiceId)));

  const preview = await previewPeriod(installerId, input, today);
  if (!preview.canIssue) throw new ORPCError("BAD_REQUEST", { message: preview.blockedReason ?? "This invoice can't be issued yet." });
  const ids = preview.entries.filter((e) => e.selected).map((e) => e.id);
  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  const abn = abnView(installer!);
  const invoiceNumber = installer!.nextInvoiceNumber!;
  const lines = await invoiceLines(ids);
  const approved = snap.filter((a) => ids.includes(a.id));
  if (approved.length !== ids.length) {
    throw new ORPCError("CONFLICT", { message: "Some of this time changed a moment ago. Nothing was issued. Check the preview again." });
  }
  const anchor = [...approved].sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : a.id - b.id))[0]!;
  const jobCount = new Set(approved.map((a) => a.jobId)).size;
  const title =
    preview.from === preview.to
      ? `Hourly work ${sayDateYear(preview.from)}`
      : `Hourly work ${sayDateYear(preview.from)} to ${sayDateYear(preview.to)}${jobCount > 1 ? `, ${jobCount} jobs` : ""}`;
  const [anchorJob] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, anchor.jobId));
  const now = Math.floor(Date.now() / 1000);
  const findInvoice = "(select id from installer_invoices where installer_id = ? and invoice_number = ?)";
  const asSeen = JSON.stringify(approved.map((a) => [a.id, a.minutes ?? 0, a.approvedAt ? Math.floor(a.approvedAt.getTime() / 1000) : null]));

  const stmts = [
    {
      sql: `insert into installer_invoices (task_id, job_id, installer_id, invoice_number, part, status, trading_name, installer_name, legal_name, abn, gst_registered,
              business_address, invoice_email, mobile, logo_url, bank_account_name, bank_bsb, bank_account_number, job_number, site_address, task_title,
              line_items, subtotal, gst_amount, total, confirmed_at, submitted_at, created_at, updated_at)
            values (?, ?, ?, ?, (select coalesce(max(part), 0) + 1 from installer_invoices where task_id = ? and installer_id = ?), 'submitted', ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        anchor.taskId, anchor.jobId, installerId, invoiceNumber, anchor.taskId, installerId,
        abn.businessName ?? "", installer!.name, abn.legalName, installer!.abn, preview.gstRegistered ? 1 : 0,
        installer!.businessAddress, installer!.invoiceEmail, installer!.mobile, installer!.logoUrl, installer!.bankAccountName, installer!.bankBsb, installer!.bankAccountNumber,
        anchorJob?.number ?? 0, null, title,
        JSON.stringify(lines.map(({ description, unit, qty, rate, total }) => ({ description, unit, qty, rate, total }))),
        preview.subtotal, preview.gstAmount, preview.total, now, now, now, now,
      ],
    },
    // One link row per entry, only while it is still approved, payable, unbilled and exactly as previewed.
    {
      sql: `insert into installer_invoice_sessions (invoice_id, session_id, task_id, job_id, work_date, minutes, amount, created_at, updated_at)
            select ${findInvoice}, w.id, w.task_id, w.job_id, w.work_date, coalesce(w.approved_minutes, 0), round(coalesce(w.approved_pay, 0), 2), ?, ?
            from work_sessions w
            where w.id in (${inList(ids.length)}) and w.installer_id = ? and w.status = 'approved' and w.payable = 1 and w.invoice_id is null and w.rate_base > 0
              and exists (select 1 from json_each(?) j
                where json_extract(j.value, '$[0]') = w.id and json_extract(j.value, '$[1]') = coalesce(w.approved_minutes, 0) and json_extract(j.value, '$[2]') = w.approved_at)`,
      args: [installerId, invoiceNumber, now, now, ...ids, installerId, asSeen],
    },
    {
      sql: `update work_sessions set invoice_id = ${findInvoice}, updated_at = ?
            where invoice_id is null and id in (select session_id from installer_invoice_sessions where invoice_id = ${findInvoice})`,
      args: [installerId, invoiceNumber, now, installerId, invoiceNumber],
    },
    // The CHECK on this row refuses the whole write if any entry was not claimed above.
    {
      sql: `insert into installer_invoice_details (invoice_id, installer_id, kind, period_from, period_to, terms_days, due_date, request_key, sessions_expected, sessions_claimed, created_at, updated_at)
            select i.id, ?, 'period', ?, ?, ?, ?, ?, ?,
              (select count(*) from work_sessions w join installer_invoice_sessions l on l.session_id = w.id and l.invoice_id = i.id where w.invoice_id = i.id), ?, ?
            from installer_invoices i where i.installer_id = ? and i.invoice_number = ?`,
      args: [installerId, preview.from, preview.to, TERMS_DAYS, addLocalDays(today, TERMS_DAYS), input.requestKey, ids.length, now, now, installerId, invoiceNumber],
    },
    {
      sql: "update installers set next_invoice_number = next_invoice_number + 1, updated_at = ? where id = ? and next_invoice_number = ?",
      args: [now, installerId, invoiceNumber],
    },
  ];

  try {
    await (db.$client as Client).batch(stmts, "write");
  } catch (e) {
    // A retry or a second phone with the same key: the first one won. Give back its invoice.
    const won = await byRequestKey(installerId, input.requestKey);
    if (won) return { invoice: won, repeated: true as const };
    const msg = String((e as Error)?.message ?? e);
    if (/installer_invoice_details_claim_check|installer_invoice_sessions_session_unique|installer_invoice_number_unique|UNIQUE|CHECK/i.test(msg)) {
      throw new ORPCError("CONFLICT", { message: "Some of this time changed or was invoiced a moment ago. Nothing was issued. Check the preview again." });
    }
    throw e;
  }
  const [row] = await db
    .select()
    .from(schema.installerInvoices)
    .where(and(eq(schema.installerInvoices.installerId, installerId), eq(schema.installerInvoices.invoiceNumber, invoiceNumber)));
  return { invoice: row!, repeated: false as const };
}

async function byRequestKey(installerId: number, requestKey: string) {
  const [hit] = await db
    .select({ invoice: schema.installerInvoices })
    .from(schema.installerInvoiceDetails)
    .innerJoin(schema.installerInvoices, eq(schema.installerInvoices.id, schema.installerInvoiceDetails.invoiceId))
    .where(and(eq(schema.installerInvoiceDetails.installerId, installerId), eq(schema.installerInvoiceDetails.requestKey, requestKey)));
  return hit?.invoice ?? null;
}

/* ------------------------------ Details and balances --------------------- */

export type Details = typeof schema.installerInvoiceDetails.$inferSelect;

export async function detailsFor(invoiceIds: number[]) {
  const out = new Map<number, Details>();
  if (!invoiceIds.length || !(await hourlyInvoicingReady())) return out;
  const rows = await db.select().from(schema.installerInvoiceDetails).where(inArray(schema.installerInvoiceDetails.invoiceId, invoiceIds));
  for (const r of rows) out.set(r.invoiceId, r);
  return out;
}

export async function paymentsFor(invoiceIds: number[]) {
  const out = new Map<number, Array<typeof schema.installerInvoicePayments.$inferSelect>>();
  if (!invoiceIds.length || !(await hourlyInvoicingReady())) return out;
  const rows = await db
    .select()
    .from(schema.installerInvoicePayments)
    .where(inArray(schema.installerInvoicePayments.invoiceId, invoiceIds))
    .orderBy(asc(schema.installerInvoicePayments.paidOn), asc(schema.installerInvoicePayments.id));
  for (const r of rows) out.set(r.invoiceId, [...(out.get(r.invoiceId) ?? []), r]);
  return out;
}

/**
 * Where an invoice stands for him: Awaiting payment with what is left, Part
 * paid, or Paid. Paid is what the office recorded (Xero stays the source of
 * truth for bills and payments; nothing is read from or written to it here).
 */
export function balanceOf(inv: { total: number; status: string }, paid: Array<{ amount: number }>) {
  const paidSum = round2(paid.reduce((a, p) => a + p.amount, 0));
  const markedPaid = inv.status === "paid";
  const balance = markedPaid ? 0 : round2(Math.max(0, inv.total - paidSum));
  const state = markedPaid || balance <= 0 ? "paid" : paidSum > 0 ? "part_paid" : "awaiting_payment";
  const label = state === "paid" ? "Paid" : state === "part_paid" ? "Part paid" : "Awaiting payment";
  return { state, label, paid: markedPaid ? inv.total : paidSum, balance };
}

/** His four totals: Awaiting approval, Ready to invoice, Awaiting payment, Paid. */
export async function mySummary(installerId: number) {
  const sessions = await db
    .select({ status: schema.workSessions.status, payable: schema.workSessions.payable, invoiceId: schema.workSessions.invoiceId, pay: schema.workSessions.approvedPay, minutes: schema.workSessions.approvedMinutes, rate: schema.workSessions.rateBase })
    .from(schema.workSessions)
    .where(eq(schema.workSessions.installerId, installerId));
  const awaiting = sessions.filter((s) => s.status === "open" || s.status === "recorded");
  const ready = sessions.filter((s) => s.status === "approved" && s.payable === true && s.invoiceId == null && (s.rate ?? 0) > 0);
  const invs = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.installerId, installerId));
  const pays = await paymentsFor(invs.map((i) => i.id));
  let owed = 0;
  let paid = 0;
  for (const i of invs) {
    const b = balanceOf(i, pays.get(i.id) ?? []);
    owed += b.balance;
    paid += b.paid;
  }
  return {
    awaitingApproval: { entries: awaiting.length },
    readyToInvoice: { entries: ready.length, hours: round2(ready.reduce((a, s) => a + (s.minutes ?? 0), 0) / 60), amount: round2(ready.reduce((a, s) => a + (s.pay ?? 0), 0)) },
    awaitingPayment: { amount: round2(owed) },
    paid: { amount: round2(paid) },
  };
}

/** His invoices, newest first, with dates, terms, due date and balance. Only his own. */
export async function myInvoiceList(installerId: number) {
  const invs = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.installerId, installerId)).orderBy(desc(schema.installerInvoices.submittedAt), desc(schema.installerInvoices.id));
  const ids = invs.map((i) => i.id);
  const [det, pays] = await Promise.all([detailsFor(ids), paymentsFor(ids)]);
  return invs.map((i) => {
    const d = det.get(i.id);
    const b = balanceOf(i, pays.get(i.id) ?? []);
    return {
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      title: i.taskTitle,
      kind: d?.kind ?? "task",
      periodFrom: d?.periodFrom ?? null,
      periodTo: d?.periodTo ?? null,
      issuedOn: i.submittedAt ? localDate(i.submittedAt) : null,
      dueDate: d?.dueDate ?? null,
      termsDays: d?.termsDays ?? null,
      subtotal: i.subtotal,
      gstAmount: i.gstAmount,
      total: i.total,
      gstRegistered: i.gstRegistered,
      officeStatus: i.status,
      ...b,
      payments: (pays.get(i.id) ?? []).map((p) => ({ amount: p.amount, paidOn: p.paidOn })),
      hasPdf: !!i.pdfKey,
      emailedToTerra: !!i.emailedToTerraAt,
      emailError: i.emailError,
    };
  });
}

/**
 * The office records money paid against a contractor invoice (what Xero
 * shows). Once the total is covered the invoice reads Paid.
 */
export async function recordPayment(input: { invoiceId: number; amount: number; paidOn: string; note: string | null }, actorName: string) {
  if (!(await hourlyInvoicingReady())) throw new ORPCError("BAD_REQUEST", { message: "Payments can be recorded once the database step has run." });
  if (!ymd.test(input.paidOn)) throw new ORPCError("BAD_REQUEST", { message: "Pick the date it was paid." });
  if (input.paidOn > todayLocal()) throw new ORPCError("BAD_REQUEST", { message: "That date is in the future." });
  const [inv] = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.id, input.invoiceId));
  if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
  const before = balanceOf(inv, (await paymentsFor([inv.id])).get(inv.id) ?? []);
  if (before.balance <= 0) throw new ORPCError("BAD_REQUEST", { message: "This invoice is already paid in full." });
  const amount = round2(input.amount);
  if (!(amount > 0)) throw new ORPCError("BAD_REQUEST", { message: "Enter the amount paid." });
  if (amount > before.balance + 0.004) throw new ORPCError("BAD_REQUEST", { message: `That is more than the $${before.balance.toFixed(2)} left on this invoice.` });
  await db.insert(schema.installerInvoicePayments).values({ invoiceId: inv.id, installerId: inv.installerId, amount, paidOn: input.paidOn, source: "office", note: input.note, recordedByName: actorName });
  const after = balanceOf(inv, (await paymentsFor([inv.id])).get(inv.id) ?? []);
  if (after.state === "paid" && inv.status !== "paid") {
    await db.update(schema.installerInvoices).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() }).where(eq(schema.installerInvoices.id, inv.id));
  }
  return after;
}

/** Entries an invoice bills, from the link rows. */
export async function linkedSessions(invoiceIds: number[]) {
  if (!invoiceIds.length || !(await hourlyInvoicingReady())) return [] as Array<typeof schema.installerInvoiceSessions.$inferSelect>;
  return db.select().from(schema.installerInvoiceSessions).where(inArray(schema.installerInvoiceSessions.invoiceId, invoiceIds));
}

/** Tasks with at least one of his entries billed, for the installer board. */
export async function billedTaskIds(taskIds: number[]) {
  if (!taskIds.length || !(await hourlyInvoicingReady())) return [] as number[];
  const rows = await db
    .selectDistinct({ taskId: schema.installerInvoiceSessions.taskId })
    .from(schema.installerInvoiceSessions)
    .where(inArray(schema.installerInvoiceSessions.taskId, taskIds));
  return rows.map((r) => r.taskId);
}


/* ------------------------------ PDF and sending -------------------------- */

async function logoOf(logoUrl: string | null) {
  if (!logoUrl) return null;
  try {
    const res = await fetch(await signGet(logoUrl));
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${res.headers.get("content-type") ?? "image/png"};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Make the PDF for an issued invoice by dates (once) and send it to Terra
 * billing and to him (whatever has not gone yet). Safe to call again: the
 * stored PDF is reused, nothing is recalculated and no new invoice or number
 * is made. A failed send is recorded so the app can offer Send again.
 */
export async function deliverPeriodInvoice(invoiceId: number, opts: { force?: boolean } = {}) {
  const [inv] = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.id, invoiceId));
  if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
  const d = (await detailsFor([inv.id])).get(inv.id);
  if (!d || d.kind !== "period") throw new ORPCError("BAD_REQUEST", { message: "This is not an hourly invoice by dates." });
  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, inv.installerId));
  const issued = inv.submittedAt ? localDate(inv.submittedAt) : todayLocal();
  const jobsOn = [...new Set((await linkedSessions([inv.id])).map((l) => l.jobId))];
  const periodLabel = d.periodFrom === d.periodTo ? sayDateYear(d.periodFrom ?? issued) : `${sayDateYear(d.periodFrom ?? issued)} to ${sayDateYear(d.periodTo ?? issued)}`;

  let pdf: Buffer;
  let pdfKey = inv.pdfKey;
  if (pdfKey) {
    pdf = await getObject(pdfKey);
  } else {
    pdf = await renderInvoicePdf({
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: issued,
      tradingName: inv.tradingName,
      installerName: inv.installerName,
      legalName: inv.legalName,
      abn: inv.abn,
      gstRegistered: inv.gstRegistered,
      businessAddress: inv.businessAddress,
      invoiceEmail: inv.invoiceEmail,
      mobile: inv.mobile,
      logoDataUri: await logoOf(inv.logoUrl),
      bankAccountName: inv.bankAccountName,
      bankBsb: inv.bankBsb,
      bankAccountNumber: inv.bankAccountNumber,
      jobNumber: inv.jobNumber,
      siteAddress: null,
      taskTitle: jobsOn.length > 1 ? `Hourly work, ${jobsOn.length} jobs` : "Hourly work",
      lineItems: JSON.parse(inv.lineItems || "[]") as InvoiceLineItem[],
      subtotal: inv.subtotal,
      gstAmount: inv.gstAmount,
      total: inv.total,
      serviceFrom: d.periodFrom,
      serviceTo: d.periodTo,
      termsDays: d.termsDays,
      dueDate: d.dueDate,
      periodLabel: `Service dates ${periodLabel}`,
      noGstLine: true,
    });
    pdfKey = periodInvoicePdfKey(inv.installerId, d.periodFrom ?? issued, d.periodTo ?? issued);
    await putObject(pdfKey, pdf, "application/pdf", `invoice-${inv.invoiceNumber}.pdf`);
    await db.update(schema.installerInvoices).set({ pdfKey, updatedAt: new Date() }).where(eq(schema.installerInvoices.id, inv.id));
  }

  const attachments = [{ filename: `invoice-${inv.invoiceNumber}.pdf`, content: pdf.toString("base64") }];
  const who = inv.legalName ? (inv.tradingName ? `${inv.legalName} t/a ${inv.tradingName}` : inv.legalName) : inv.tradingName || inv.installerName;
  const subject = `Invoice #${inv.invoiceNumber} from ${who}, hourly work ${periodLabel}`;
  const money = `$${inv.total.toFixed(2)}${inv.gstRegistered ? " inc GST" : ", no GST charged"}`;
  const bodyText = `Invoice #${inv.invoiceNumber} for hourly work ${periodLabel}${jobsOn.length > 1 ? ` across ${jobsOn.length} jobs` : ""}. Total ${money}. Terms ${d.termsDays} days, due ${d.dueDate ? sayDateYear(d.dueDate) : "on receipt"}.`;
  const bodyHtml = `<p>${bodyText}</p>`;

  const now = new Date();
  const toTerra = !inv.emailedToTerraAt || opts.force ? await sendEmail({ to: BILLING_EMAIL, subject, html: bodyHtml, text: bodyText, attachments }) : { ok: true as const };
  const toHim = installer?.invoiceEmail && !inv.emailedToInstallerAt ? await sendEmail({ to: installer.invoiceEmail, subject, html: bodyHtml, text: bodyText, attachments }) : null;
  const [saved] = await db
    .update(schema.installerInvoices)
    .set({
      emailedToTerraAt: toTerra.ok ? (inv.emailedToTerraAt && !opts.force ? inv.emailedToTerraAt : now) : inv.emailedToTerraAt,
      emailedToInstallerAt: toHim?.ok ? now : inv.emailedToInstallerAt,
      emailError: toTerra.ok ? null : toTerra.reason,
      updatedAt: now,
    })
    .where(eq(schema.installerInvoices.id, inv.id))
    .returning();
  return { invoice: saved!, sentToTerra: toTerra.ok, error: toTerra.ok ? null : toTerra.reason };
}
