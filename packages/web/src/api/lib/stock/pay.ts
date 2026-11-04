import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { AWAITING_CONFIRM, cardCheck, isLive, money, r2, WAITING } from "./core";
import { depositState, ordersForInvoice, paymentFacts, switchFor, type OrderKind } from "./orders";
import { invoiceShortages, orderShortages, type OrderShort } from "./shortage";

/* ---------------------------------------------------------------------------
 * The deposit on a direct invoice (A1.3, clarification 3).
 *
 * Only a direct invoice with stock waiting on its deposit gets the extra
 * "Pay the deposit" choice. The deposit button asks for the required deposit
 * less what is confirmed AND less what is recorded but not yet confirmed, so
 * a $300 bank payment typed in but not confirmed is never asked for again.
 * Every other invoice keeps today's pay page.
 *
 * A2c: an actual material shortage on the order (never just a deposit that is
 * less than the total) changes what the customer is told. A container or
 * stock-only shortage blocks payment until it is resolved, or the main admin
 * records the arrangement the customer agreed to. A payment already made
 * stays recorded as it is: no refund, no purchase, no "Fully reserved".
 * ------------------------------------------------------------------------- */

export type StockPayInfo = {
  /** Shown on the pay page under the amount. Null when there is nothing to add. */
  stockLabel: string | null;
  /** A2c: a known shortage. Shown on the pay page, PDF and email. */
  notice: string | null;
  /** A2c: payment is not taken while this is true (container or stock-only shortage with no recorded customer arrangement). */
  blocked: boolean;
  /** The deposit button. Null when only the full amount is offered. */
  depositOption: { amount: number; percent: number; balance: number } | null;
  /** The added line on the pay page, PDF and email. Null when there is none. */
  depositLine: string | null;
};

/** A2c, approved wording: a known shortage before payment. */
export const SHORT_BEFORE_PAY =
  "Some material for your order is currently unavailable. Please contact Terra Flooring before paying so we can confirm the available quantities and agree how to proceed.";
/** A2c, approved wording: paid, then the shortage was found. */
export const PAID_SHORT =
  "Your payment has been received, but we have not yet been able to reserve all the material for your order. Our office will contact you to discuss the next steps.";
export const HELD_LABEL = "Stock is held for you once the deposit is paid.";

/**
 * "Required deposit: $300.00 (30% of the invoice total). Balance after deposit: $700.00."
 * After part of it is paid, the line says what is still to pay, never the full deposit again.
 */
export function depositLineText(a: { required: number; percent: number; stillToPay: number; balance: number }) {
  const head = `Required deposit: ${money(a.required)} (${a.percent}% of the invoice total).`;
  const paid = r2(a.required - a.stillToPay);
  const mid = paid > 0.005 ? ` Paid so far: ${money(paid)}. Deposit still to pay: ${money(a.stillToPay)}.` : "";
  return `${head}${mid} Balance after deposit: ${money(a.balance)}.`;
}

/** Shortages on every live order a payment on this invoice could move. */
async function shortsFor(invoiceId: number): Promise<{ open: OrderShort[]; paidAny: boolean }> {
  const open: OrderShort[] = [];
  let paidAny = false;
  const orders = await ordersForInvoice(invoiceId);
  // A direct-sale invoice with no stock order: its own sale lines are checked (S3).
  if (!orders.length && (await isLive("s3"))) {
    const s = (await invoiceShortages(invoiceId)).filter((x) => !x.arrangement);
    if (s.length) {
      open.push(...s);
      paidAny = (await paymentFacts([invoiceId])).some((p) => p.amount > 0.005 && p.method !== "contra");
    }
    return { open, paidAny };
  }
  for (const o of orders) {
    if (o.status !== "active" || !(await isLive(switchFor(o.kind as OrderKind)))) continue;
    const s = (await orderShortages(o)).filter((x) => !x.arrangement);
    if (!s.length) continue;
    open.push(...s);
    const dep = await depositState(o);
    if (dep.confirmed + dep.recordedUnconfirmed > 0.005) paidAny = true;
  }
  return { open, paidAny };
}

/** For one invoice and what is owing on it now. Null when stock has nothing to say about this invoice. */
export async function stockPayInfo(invoiceId: number, owing: number): Promise<StockPayInfo | null> {
  if (!(await isLive("s3")) && !(await isLive("s4"))) return null;
  const { open, paidAny } = await shortsFor(invoiceId);
  const blocked = owing > 0.005 && open.some((s) => s.blocksPayment);
  const notice = open.length ? (paidAny ? PAID_SHORT : SHORT_BEFORE_PAY) : null;
  const deposit = blocked ? null : await depositPart(invoiceId, owing);
  if (!notice && !deposit) return null;
  return {
    // Never "held for you" while something on the order is short.
    stockLabel: notice ? null : (deposit?.stockLabel ?? null),
    notice,
    blocked,
    depositOption: deposit?.depositOption ?? null,
    depositLine: deposit?.depositLine ?? null,
  };
}

/** The deposit choice on a direct invoice with stock waiting on its deposit (S3). */
async function depositPart(invoiceId: number, owing: number) {
  if (!(owing > 0.005) || !(await isLive("s3"))) return null;
  const [o] = await db
    .select()
    .from(schema.stockOrders)
    .where(and(eq(schema.stockOrders.invoiceId, invoiceId), eq(schema.stockOrders.kind, "sale_invoice"), inArray(schema.stockOrders.status, ["active"])));
  if (!o) return null;
  const waiting = await db
    .select({ id: schema.stockReservations.id })
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.orderId, o.id), inArray(schema.stockReservations.status, [...WAITING])));
  if (!waiting.length) return null;
  const dep = await depositState(o);
  if (dep.code === "awaiting_confirm") return { stockLabel: AWAITING_CONFIRM, depositOption: null, depositLine: null };
  if (dep.code !== "awaiting" || dep.percent == null || dep.required == null) return null;
  const amount = r2(dep.stillToPay);
  // The deposit button only while the card check is recorded: a card deposit before then would not secure the stock by itself.
  const offer = (await cardCheck()).done && amount > 0.005 && amount < owing - 0.005;
  const balance = r2(owing - amount);
  return {
    stockLabel: HELD_LABEL,
    depositOption: offer ? { amount, percent: dep.percent, balance } : null,
    depositLine: amount > 0.005 && amount < owing - 0.005 ? depositLineText({ required: dep.required, percent: dep.percent, stillToPay: amount, balance }) : null,
  };
}
