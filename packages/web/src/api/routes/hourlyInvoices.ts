import { z } from "zod";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { installerOnly, staffOnly } from "../middleware/auth";
import { signGet } from "../lib/s3";
import { jobRef } from "../lib/job-ref";
import { taskRef } from "../lib/refs";
import { termsOn } from "../lib/hourly";
import { swmsNeededFor } from "../lib/swms";
import {
  balanceOf,
  deliverPeriodInvoice,
  detailsFor,
  hourlyInvoicingReady,
  issuePeriod,
  linkedSessions,
  myInvoiceList,
  mySummary,
  paymentsFor,
  previewPeriod,
  recordPayment,
} from "../lib/hourly-invoice";
import { xeroPaymentCheck } from "../lib/hourly-xero-check";

/**
 * HOURLY CONTRACTOR INVOICING (Damien, 13 Nov 2026).
 *
 *  - the contractor (installerOnly): preview and issue an invoice for today,
 *    this week or dates he picks, his four totals, his invoices, the PDF and
 *    Send again. Every query is filtered by his own installer id;
 *  - the office (staffOnly): where each invoice stands (balance, Part paid),
 *    the time entries it bills, and recording money paid. Bank details stay
 *    with Admin.
 *
 * The rules (what can be billed, one write, no double billing) live in
 * lib/hourly-invoice.ts. The one Xero call is xeroCheck, which only reads
 * bills (lib/hourly-xero-check.ts, Damien, 13 Nov 2026).
 */

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const period = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("today") }),
  z.object({ kind: z.literal("week") }),
  z.object({ kind: z.literal("dates"), from: ymd, to: ymd }),
]);
const pick = z.object({ period, sessionIds: z.array(z.number().int()).max(400).optional() });

async function mineOr404(invoiceId: number, installerId: number) {
  const [row] = await db
    .select()
    .from(schema.installerInvoices)
    .where(and(eq(schema.installerInvoices.id, invoiceId), eq(schema.installerInvoices.installerId, installerId)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
  return row;
}

const crew = {
  /** Is invoicing by dates switched on yet (the database step has run). */
  ready: installerOnly.handler(async () => ({ ready: await hourlyInvoicingReady() })),

  /**
   * The jobs he can record hourly time on: his own open tasks, when he is on
   * hourly terms or the task is paid by the hour. He picks one before Start work.
   */
  myJobs: installerOnly.handler(async ({ context }) => {
    const rows = await db
      .select({ id: schema.jobTasks.id, seq: schema.jobTasks.seq, title: schema.jobTasks.title, status: schema.jobTasks.status, payType: schema.jobTasks.payType, scheduledDate: schema.jobTasks.scheduledDate, jobId: schema.jobs.id, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber })
      .from(schema.jobTasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .where(and(eq(schema.jobTasks.assignedInstallerId, context.installerId), sql`${schema.jobTasks.status} not in ('complete','cancelled')`))
      .orderBy(asc(schema.jobTasks.scheduledDate), asc(schema.jobTasks.id));
    const onTerms = Boolean(await termsOn(context.installerId));
    const mine = rows.filter((r) => onTerms || r.payType === "hourly");
    // Site work on a SWMS job needs today's SWMS first, the same as on the job screen.
    const swms = mine.length ? await swmsNeededFor(context.installerId, [...new Set(mine.map((r) => r.jobId))]) : new Map();
    return mine.map((r) => {
      const jr = jobRef({ number: r.number, displayNumber: r.displayNumber });
      const sw = swms.get(r.jobId);
      return { taskId: r.id, jobId: r.jobId, jobRef: jr, taskRef: taskRef(jr, r.seq), title: r.title, scheduledDate: r.scheduledDate, status: r.status, swmsDue: Boolean(sw?.required && !sw.signedToday) };
    });
  }),

  /** Awaiting approval, Ready to invoice, Awaiting payment, Paid. His own only. */
  summary: installerOnly.handler(async ({ context }) => mySummary(context.installerId)),

  /** What an invoice for these dates would hold, and why anything is left off. Read only. */
  preview: installerOnly.input(pick).handler(async ({ input, context }) => previewPeriod(context.installerId, input)),

  /**
   * Issue & send to Terra. The phone makes requestKey once per tap: the same
   * key always gives back the same invoice, never a second one.
   */
  issue: installerOnly
    .input(pick.extend({ requestKey: z.string().min(8).max(80) }))
    .handler(async ({ input, context }) => {
      const { invoice, repeated } = await issuePeriod(context.installerId, input);
      // The invoice stands once written. Making and sending the PDF can fail on its own; it is then sent again, never re-issued.
      let sent: { sentToTerra: boolean; error: string | null } = { sentToTerra: !!invoice.emailedToTerraAt, error: invoice.emailError };
      if (!invoice.pdfKey || !invoice.emailedToTerraAt) {
        try {
          const d = await deliverPeriodInvoice(invoice.id);
          sent = { sentToTerra: d.sentToTerra, error: d.error };
        } catch (e) {
          sent = { sentToTerra: false, error: String((e as Error)?.message ?? e) };
        }
      }
      const list = await myInvoiceList(context.installerId);
      return { invoice: list.find((i) => i.id === invoice.id)!, repeated, ...sent };
    }),

  /** My invoices, newest first, with service dates, terms, due date and balance. */
  invoices: installerOnly.handler(async ({ context }) => myInvoiceList(context.installerId)),

  /** A download link for one of my own invoices. */
  downloadUrl: installerOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input, context }) => {
    const row = await mineOr404(input.invoiceId, context.installerId);
    if (!row.pdfKey) throw new ORPCError("NOT_FOUND", { message: "The PDF isn't ready yet. Tap Send again." });
    return { url: await signGet(row.pdfKey) };
  }),

  /** Send again. The stored invoice and PDF are reused: no new number, nothing recalculated. */
  resend: installerOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input, context }) => {
    const row = await mineOr404(input.invoiceId, context.installerId);
    const d = await deliverPeriodInvoice(row.id, { force: true });
    if (!d.sentToTerra) throw new ORPCError("BAD_GATEWAY", { message: d.error ?? "Sending failed. Try again shortly." });
    return { ok: true };
  }),
};

const office = {
  /** Where these invoices stand: kind, service dates, due date, paid, balance. */
  balances: staffOnly.input(z.object({ invoiceIds: z.array(z.number()).max(500) })).handler(async ({ input }) => {
    if (!input.invoiceIds.length) return [];
    const ids = [...new Set(input.invoiceIds)];
    const mine = await db.select().from(schema.installerInvoices).where(inArray(schema.installerInvoices.id, ids));
    const [det, pays] = await Promise.all([detailsFor(ids), paymentsFor(ids)]);
    return mine.map((r) => {
      const d = det.get(r.id);
      return {
        invoiceId: r.id,
        kind: d?.kind ?? "task",
        periodFrom: d?.periodFrom ?? null,
        periodTo: d?.periodTo ?? null,
        dueDate: d?.dueDate ?? null,
        termsDays: d?.termsDays ?? null,
        ...balanceOf(r, pays.get(r.id) ?? []),
        payments: (pays.get(r.id) ?? []).map((p) => ({ id: p.id, amount: p.amount, paidOn: p.paidOn, note: p.note, by: p.recordedByName })),
      };
    });
  }),

  /** The time entries an invoice bills, one row each. */
  invoiceEntries: staffOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input, context }) => {
    const links = await linkedSessions([input.invoiceId]);
    return links.map((l) => ({
      sessionId: l.sessionId,
      taskId: l.taskId,
      jobId: l.jobId,
      workDate: l.workDate,
      minutes: l.minutes,
      amount: context.actor.canSeeCosts ? l.amount : null,
    }));
  }),

  /** Money paid against a contractor invoice, as Xero shows it. Costs access needed. */
  recordPayment: staffOnly
    .input(z.object({ invoiceId: z.number(), amount: z.number().positive(), paidOn: ymd, note: z.string().max(300).nullable().optional() }))
    .handler(async ({ input, context }) => {
      if (!context.actor.canSeeCosts) throw new ORPCError("FORBIDDEN", { message: "Costs access required" });
      return recordPayment({ invoiceId: input.invoiceId, amount: input.amount, paidOn: input.paidOn, note: input.note ?? null }, context.actor.name || context.actor.email || "Office");
    }),

  /**
   * Damien, 13 Nov 2026: read Xero bills and flag invoices that look paid
   * there. Read only. Nothing is recorded: the office presses Record payment.
   */
  xeroCheck: staffOnly.input(z.object({ invoiceIds: z.array(z.number().int()).max(500) })).handler(async ({ input, context }) => {
    if (!context.actor.canSeeCosts) throw new ORPCError("FORBIDDEN", { message: "Costs access required" });
    return xeroPaymentCheck(input.invoiceIds);
  }),
};

export const hourlyInvoices = { ...crew, ...office };
