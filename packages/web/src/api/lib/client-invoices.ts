import { ORPCError } from "@orpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { invoiceRef } from "./refs";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

/* ---------------------------------------------------------------------------
 * Client invoices, numbered off the job (spec section 1): IQ188000-1 is the
 * deposit, then -2, -3 for the final, stages and variations. A repair bills
 * under its parent's number, the same rule as purchase orders.
 *
 * Section 2 raises two kinds by itself: the deposit when a quote is accepted,
 * and a variation for the difference when a replacement quote is accepted
 * and comes to more. Payment is marked by Admin or Office until Stripe and
 * Xero are built.
 * ------------------------------------------------------------------------- */

export const INVOICE_KINDS = ["deposit", "final", "stage", "variation", "other"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

export const INVOICE_KIND_LABEL: Record<string, string> = {
  deposit: "Deposit",
  final: "Final",
  stage: "Stage payment",
  variation: "Variation",
  other: "Invoice",
};

export const PAYMENT_METHODS = ["bank", "card", "cash", "other"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Totals are GST inclusive, the figure the client pays. */
export function gstSplit(total: number) {
  const subtotal = round2(total / 1.1);
  return { subtotal, gst: round2(total - subtotal) };
}

/** The number invoices on this job are raised under. */
export async function invoiceBaseNumber(jobId: number) {
  const [job] = await db
    .select({ number: schema.jobs.number, parentJobId: schema.jobs.parentJobId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  if (!job) throw bad(`job ${jobId} not found`);
  if (!job.parentJobId) return job.number;
  const [main] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, job.parentJobId));
  return main?.number ?? job.number;
}

export interface RaiseInvoice {
  jobId: number;
  quoteId?: number | null;
  kind: InvoiceKind;
  label: string;
  /** GST inclusive. */
  total: number;
  createdByName: string;
  /** admin · office · customer · system, as activity_log uses them. */
  actorRole: string;
  dueDate?: Date | null;
}

/**
 * Raise the next IQ invoice on a job. The seq is the next free one under the
 * job's number; two raised at the same moment both land, one retries.
 */
export async function raiseInvoice(args: RaiseInvoice) {
  const total = round2(args.total);
  if (!(total > 0)) throw bad("An invoice needs an amount over $0.");
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
  if (!job) throw bad(`job ${args.jobId} not found`);
  const base = await invoiceBaseNumber(job.id);
  const { subtotal, gst } = gstSplit(total);

  let row: typeof schema.invoices.$inferSelect | undefined;
  for (let attempt = 0; attempt < 6 && !row; attempt++) {
    const [top] = await db
      .select({ max: sql<number>`coalesce(max(${schema.invoices.seq}), 0)` })
      .from(schema.invoices)
      .where(eq(schema.invoices.jobNumber, base));
    const seq = Number(top?.max ?? 0) + 1;
    try {
      [row] = await db
        .insert(schema.invoices)
        .values({
          number: invoiceRef(base, seq),
          jobNumber: base,
          seq,
          jobId: job.id,
          quoteId: args.quoteId ?? null,
          kind: args.kind,
          label: args.label,
          billToType: job.billToType,
          billToContactId: job.billToType === "company" ? null : (job.billToContactId ?? job.contactId ?? null),
          billToCompanyId: job.billToType === "company" ? (job.billToCompanyId ?? job.companyId ?? null) : null,
          status: "sent",
          subtotal,
          gst,
          total,
          dueDate: args.dueDate ?? new Date(),
          createdByName: args.createdByName,
        })
        .returning();
    } catch (e) {
      // Someone took that seq a moment ago. Anything else is a real failure.
      const err = e as { message?: string; cause?: { message?: string } };
      if (!/unique/i.test(`${err?.message ?? e} ${err?.cause?.message ?? ""}`)) throw e;
    }
  }
  if (!row) throw bad("Could not find a free invoice number. Try again.");
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "invoice",
    entityId: row.id,
    action: "invoice_raised",
    detail: `Invoice ${row.number} raised, ${INVOICE_KIND_LABEL[row.kind] ?? row.kind}, ${money(total)}`,
    actorName: args.createdByName,
    actorRole: args.actorRole,
  });
  return row;
}

export type InvoiceRow = typeof schema.invoices.$inferSelect;

export function shapeInvoice(i: InvoiceRow) {
  const outstanding = round2(i.total - i.amountPaid);
  return {
    id: i.id,
    ref: i.number,
    kind: i.kind,
    kindLabel: INVOICE_KIND_LABEL[i.kind] ?? i.kind,
    label: i.label,
    status: i.status,
    subtotal: i.subtotal,
    gst: i.gst,
    total: i.total,
    amountPaid: i.amountPaid,
    outstanding: i.status === "void" ? 0 : Math.max(0, outstanding),
    dueDate: i.dueDate,
    paidAt: i.paidAt,
    paymentMethod: i.paymentMethod,
    markedPaidByName: i.markedPaidByName,
    voidedAt: i.voidedAt,
    voidReason: i.voidReason,
    quoteId: i.quoteId,
    createdAt: i.createdAt,
  };
}

export async function invoicesForJob(jobId: number) {
  const rows = await db.select().from(schema.invoices).where(eq(schema.invoices.jobId, jobId)).orderBy(asc(schema.invoices.seq));
  return rows.map(shapeInvoice);
}

/** The deposit invoice raised against this quote version, if any. Void ones do not count. */
export async function depositInvoiceFor(quoteId: number) {
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.quoteId, quoteId), eq(schema.invoices.kind, "deposit"), sql`${schema.invoices.status} != 'void'`))
    .limit(1);
  return row ?? null;
}

/**
 * Record a payment. Paid in full by default. A part payment leaves it
 * part_paid. Only moves an invoice that is not void.
 */
export async function markInvoicePaid(args: {
  id: number;
  amount?: number | null;
  method: (typeof PAYMENT_METHODS)[number];
  paidOn?: Date | null;
  byName: string;
  actorRole: string;
}) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, args.id));
  if (!inv) throw bad("Invoice not found");
  if (inv.status === "void") throw bad("This invoice is void.");
  if (inv.status === "paid") throw bad("This invoice is already paid.");
  const owing = round2(inv.total - inv.amountPaid);
  const amount = round2(args.amount ?? owing);
  if (!(amount > 0)) throw bad("Enter an amount over $0.");
  if (amount > owing + 0.005) throw bad(`That is more than the ${money(owing)} still owing.`);
  const paid = round2(inv.amountPaid + amount);
  const full = paid >= inv.total - 0.005;
  const when = args.paidOn ?? new Date();
  const [row] = await db
    .update(schema.invoices)
    .set({
      amountPaid: paid,
      status: full ? "paid" : "part_paid",
      paidAt: full ? when : inv.paidAt,
      paymentMethod: args.method,
      markedPaidByName: args.byName,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.invoices.id, inv.id), eq(schema.invoices.amountPaid, inv.amountPaid)))
    .returning();
  if (!row) throw bad("Someone else just changed this invoice. Refresh and try again.");
  // The job card's deposit flag follows the deposit invoice, so the forecast and the job agree.
  if (full && inv.kind === "deposit" && inv.jobId) {
    await db.update(schema.jobs).set({ depositPaid: true, updatedAt: new Date() }).where(eq(schema.jobs.id, inv.jobId));
  }
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: full ? "invoice_paid" : "invoice_part_paid",
    detail: `${inv.number}: ${money(amount)} received by ${args.method}${full ? ", paid in full" : `, ${money(round2(inv.total - paid))} still owing`}`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  return row;
}

export async function voidInvoice(args: { id: number; reason: string; byName: string; actorRole: string }) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, args.id));
  if (!inv) throw bad("Invoice not found");
  if (inv.status === "void") return inv;
  if (inv.amountPaid > 0) throw bad("Money has been received on this invoice. It cannot be voided.");
  const [row] = await db
    .update(schema.invoices)
    .set({ status: "void", voidedAt: new Date(), voidReason: args.reason, updatedAt: new Date() })
    .where(eq(schema.invoices.id, inv.id))
    .returning();
  await db.insert(schema.activityLog).values({
    jobId: inv.jobId,
    entityType: "invoice",
    entityId: inv.id,
    action: "invoice_void",
    detail: `${inv.number} voided: ${args.reason}`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  return row;
}
