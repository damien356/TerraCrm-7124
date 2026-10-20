import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { cardPaymentsOn, stripeRequest, type StripeSession } from "./stripe";
import { OPS_URL } from "./swms-checks";
import { auditRow, money, oneSaleMoney, runGuarded, ymd } from "./trade-core";
import { invoiceRef } from "./trade-pricing";

/* ---------------------------------------------------------------------------
 * Pay a trade invoice by card (notes 18.65). Same Stripe Checkout as job
 * invoices, its own link and its own records:
 *
 *   /tp/<token>   one link per trade sale. Shows the ref, total, paid and
 *                 balance only. No lines, costs, offsets or other buyers.
 *
 * A payment lands from the webhook or the return page, once: the Stripe
 * payment intent is unique on trade_payments. These keep working when Trade
 * sales is switched off, so no buyer money is ever lost.
 *
 * Paid more than owing (an offset or a bank payment came first) is still
 * recorded, because the money is in Stripe. The sale shows a credit balance
 * and the audit says to refund or keep it. Any open offset on the sale is
 * flagged so it cannot take the same money again.
 * ------------------------------------------------------------------------- */

function sign(id: number) {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.MAIL_TOKEN_KEY || "terra-pay";
  return createHmac("sha256", secret).update(`terra-trade-pay:${id}`).digest("base64url").slice(0, 22);
}
export const tradePayToken = (saleId: number) => `${saleId}-${sign(saleId)}`;
export const tradePayUrl = (saleId: number) => `${OPS_URL}/tp/${tradePayToken(saleId)}`;

export function saleIdFromToken(token: string) {
  const m = /^(\d{1,10})-([A-Za-z0-9_-]{22})$/.exec(token ?? "");
  if (!m) return null;
  const id = Number(m[1]);
  const want = Buffer.from(sign(id));
  const got = Buffer.from(m[2]!);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

/** What the buyer's pay page may show. Totals only. */
export async function publicTradeState(saleId: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!s || s.status === "draft") return null;
  const m = await oneSaleMoney(saleId);
  const owing = s.status === "finalised" ? Math.max(0, m.balance) : 0;
  return {
    ref: invoiceRef(s.number),
    billName: s.billName,
    total: s.total,
    credited: m.credited,
    paid: Math.round((m.cashIn - m.refunded + m.offsetConfirmed) * 100) / 100,
    owing,
    dueDate: s.dueDate,
    cancelled: s.status === "cancelled",
    canPay: cardPaymentsOn() && owing > 0.005,
  };
}

export async function tradeCheckout(saleId: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!s || s.status !== "finalised") throw new Error(s?.status === "cancelled" ? "This invoice has been cancelled." : "Invoice not found.");
  const m = await oneSaleMoney(saleId);
  const owing = Math.round(m.balance * 100) / 100;
  if (!(owing > 0.005)) throw new Error("This invoice is already paid. Thank you.");
  const ref = invoiceRef(s.number);
  const back = tradePayUrl(saleId);
  const meta = { terra_trade_sale_id: String(s.id), terra_trade_invoice: ref };
  const session = await stripeRequest<StripeSession>("POST", "/checkout/sessions", {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: s.billEmail?.trim() || undefined,
    client_reference_id: ref,
    line_items: [
      {
        quantity: 1,
        price_data: { currency: "aud", unit_amount: Math.round(owing * 100), product_data: { name: `Terra Flooring ${ref}`, description: `Materials invoice ${ref}` } },
      },
    ],
    metadata: meta,
    payment_intent_data: { description: `Terra Flooring ${ref}`, metadata: meta },
    success_url: `${back}?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${back}?cancelled=1`,
  });
  if (!session.url) throw new Error("Stripe did not return a payment page.");
  return { url: session.url, sessionId: session.id, amount: owing };
}

export type TradeApplied =
  | { ok: true; saleId: number; state: "paid" | "part_paid" | "over_paid" | "already_counted"; amount: number }
  | { ok: false; reason: string; saleId?: number };

const piOf = (s: StripeSession) => (typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null));

export async function applyTradeSession(s: StripeSession): Promise<TradeApplied> {
  const saleId = Number(s.metadata?.terra_trade_sale_id ?? 0);
  if (!saleId) return { ok: false, reason: "not a trade sale" };
  if (s.payment_status !== "paid") return { ok: false, reason: `payment ${s.payment_status ?? "unknown"}`, saleId };
  if ((s.currency ?? "").toLowerCase() !== "aud") return { ok: false, reason: `currency ${s.currency}`, saleId };
  const pi = piOf(s) ?? s.id;
  const amount = Math.round(s.amount_total ?? 0) / 100;
  if (!(amount > 0)) return { ok: false, reason: "no amount", saleId };
  const [sale] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!sale) return { ok: false, reason: "sale not found", saleId };
  const [seen] = await db.select({ id: schema.tradePayments.id }).from(schema.tradePayments).where(eq(schema.tradePayments.stripeRef, pi));
  if (seen) return { ok: true, saleId, state: "already_counted", amount };

  const before = await oneSaleMoney(saleId);
  const who = s.customer_details?.name?.trim() || s.customer_details?.email?.trim() || "Buyer";
  const ref = invoiceRef(sale.number);
  const over = amount > before.balance + 0.005;
  const open = await db
    .select()
    .from(schema.tradeOffsets)
    .where(and(eq(schema.tradeOffsets.saleId, saleId), inArray(schema.tradeOffsets.status, ["proposed", "approved"])));
  const after = Math.round((before.balance - amount) * 100) / 100;
  const clash = open.filter((o) => o.amount > Math.max(0, after) + 0.005);
  try {
    await runGuarded([
      db.insert(schema.tradePayments).values({
        saleId,
        kind: "payment",
        method: "card",
        amount,
        paidDate: ymd(),
        reference: `Stripe ${pi}`,
        stripeRef: pi,
        idemKey: `stripe:${pi}`,
        byName: `${who} (Stripe)`,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      auditRow({
        entityType: "payment",
        saleId,
        action: over ? "card_payment_over" : "card_payment",
        detail: over
          ? `${ref}: card payment ${money(amount)} (Stripe ${pi}) but only ${money(Math.max(0, before.balance))} was owing. Recorded in full. Refund or keep the ${money(amount - Math.max(0, before.balance))} as credit.`
          : `${ref}: ${money(amount)} paid by card online (Stripe ${pi}).`,
        who: { name: `${who} (Stripe)`, role: "customer" },
      }),
      ...clash.map((o) =>
        db
          .update(schema.tradeOffsets)
          .set({
            conflict: `Card payment ${money(amount)} landed on ${ymd()} (Stripe ${pi}). Only ${money(Math.max(0, after))} is now owing on ${ref}. Change or cancel this offset.`,
            updatedAt: new Date(),
          })
          .where(eq(schema.tradeOffsets.id, o.id)),
      ),
      ...clash.map((o) =>
        auditRow({
          entityType: "offset",
          entityId: o.id,
          saleId,
          billId: o.billId,
          action: "offset_conflict",
          detail: `Offset ${money(o.amount)} flagged: a card payment of ${money(amount)} came first. Nothing deducted.`,
          who: { name: "System", role: "system" },
        }),
      ),
    ]);
  } catch (e) {
    const [again] = await db.select({ id: schema.tradePayments.id }).from(schema.tradePayments).where(eq(schema.tradePayments.stripeRef, pi));
    if (again) return { ok: true, saleId, state: "already_counted", amount };
    throw e;
  }
  return { ok: true, saleId, state: over ? "over_paid" : after <= 0.005 ? "paid" : "part_paid", amount };
}

export async function confirmTradeSession(sessionId: string, saleId: number) {
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return { ok: false as const, reason: "bad session" };
  const s = await stripeRequest<StripeSession>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (Number(s.metadata?.terra_trade_sale_id ?? 0) !== saleId) return { ok: false as const, reason: "session is for another invoice" };
  return applyTradeSession(s);
}

/** Admin cash figures: trade receipts are their own line, offsets are non cash. */
export async function tradeCashTotals(from: string, to: string) {
  const [r] = await db.all<{ cash_in: number; refunds: number; offsets: number; card: number; bank: number; cash: number }>(sql`
    select
      coalesce(sum(case when kind = 'payment' and method != 'credit' then amount when kind = 'payment_reversal' and method != 'credit' then -amount else 0 end), 0) as cash_in,
      coalesce(sum(case when kind = 'refund' and method != 'credit' then amount when kind = 'refund_reversal' and method != 'credit' then -amount else 0 end), 0) as refunds,
      0 as offsets,
      coalesce(sum(case when method = 'card' then (case kind when 'payment' then amount when 'payment_reversal' then -amount else 0 end) else 0 end), 0) as card,
      coalesce(sum(case when method = 'bank' then (case kind when 'payment' then amount when 'payment_reversal' then -amount else 0 end) else 0 end), 0) as bank,
      coalesce(sum(case when method = 'cash' then (case kind when 'payment' then amount when 'payment_reversal' then -amount else 0 end) else 0 end), 0) as cash
    from trade_payments where paid_date between ${from} and ${to}`);
  const [o] = await db.all<{ offsets: number }>(sql`
    select coalesce(sum(case kind when 'offset' then amount when 'offset_reversal' then -amount else 0 end), 0) as offsets
    from installer_bill_settlements where sale_id is not null and date(created_at, 'unixepoch', '+10 hours') between ${from} and ${to}`);
  const r2 = (n: number) => Math.round(Number(n) * 100) / 100;
  return {
    from,
    to,
    cashIn: r2(r!.cash_in),
    refunds: r2(r!.refunds),
    netCash: r2(r!.cash_in - r!.refunds),
    byMethod: { card: r2(r!.card), bank: r2(r!.bank), cash: r2(r!.cash) },
    nonCashOffsets: r2(o!.offsets),
  };
}
