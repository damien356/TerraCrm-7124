import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { AWAITING_CONFIRM, cardCheck, isLive, money, r2, WAITING } from "./core";
import { depositState } from "./orders";

/* ---------------------------------------------------------------------------
 * The deposit on a direct invoice (A1.3, clarification 3).
 *
 * Only a direct invoice with stock waiting on its deposit gets the extra
 * "Pay the deposit" choice. The deposit button asks for the required deposit
 * less what is confirmed AND less what is recorded but not yet confirmed, so
 * a $300 bank payment typed in but not confirmed is never asked for again.
 * Every other invoice keeps today's pay page.
 * ------------------------------------------------------------------------- */

export type StockPayInfo = {
  /** Shown on the pay page under the amount. */
  stockLabel: string;
  /** The deposit button. Null when only the full amount is offered. */
  depositOption: { amount: number; percent: number; balance: number } | null;
  /** The added line on the PDF and email. Null when there is none. */
  depositLine: string | null;
};

/** Proposed wording (A2 follow-up), for Damien to confirm: some lines are short, so the deposit cannot promise them. */
export const PART_SHORT_LABEL = "The deposit holds the stock we have now. Some of this order is not in stock, and our office will contact you about it.";

/** "$300" for whole dollars, "$300.50" otherwise, as in the approved wording. */
const dollars = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 ? `$${Math.round(n).toLocaleString("en-AU")}` : money(n));

/** For one invoice and what is owing on it now. Null when stock has nothing to say about this invoice. */
export async function stockPayInfo(invoiceId: number, owing: number): Promise<StockPayInfo | null> {
  if (!(await isLive("s3"))) return null;
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
  // A2 follow-up: part of the order is already short. Do not say it is all held.
  const short = await db
    .select({ id: schema.stockReservations.id })
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.orderId, o.id), eq(schema.stockReservations.status, "short")));
  const dep = await depositState(o);
  if (dep.code === "awaiting_confirm") return { stockLabel: AWAITING_CONFIRM, depositOption: null, depositLine: null };
  if (dep.code !== "awaiting" || dep.percent == null || dep.required == null) return null;
  const amount = r2(dep.stillToPay);
  // The deposit button only while the card check is recorded: a card deposit before then would not secure the stock by itself.
  const offer = (await cardCheck()).done && amount > 0.005 && amount < owing - 0.005;
  const balance = r2(owing - amount);
  return {
    stockLabel: short.length ? PART_SHORT_LABEL : "Stock is held for you once the deposit is paid.",
    depositOption: offer ? { amount, percent: dep.percent, balance } : null,
    depositLine: amount > 0.005 && amount < owing - 0.005 ? `Deposit to secure stock: ${dollars(amount)} (${dep.percent}%). Balance ${dollars(balance)}.` : null,
  };
}
