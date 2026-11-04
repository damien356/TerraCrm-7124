import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { stockAlert } from "./alerts";
import { FIRM, money, qtyText, r4, WAITING } from "./core";
import { afterChange, expireHolds, firmHold, type Hold, holdsOfOrder, warnHolds } from "./holds";
import { cardOfJob, depositState, type DepositState, type Order, orderById, ordersForInvoice, syncTerms } from "./orders";

/** Who, which job, how much, and the draft POs: what the office needs from a stock alert (v3 11.2). */
async function orderFacts(o: Order, dep: DepositState) {
  const [job] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, o.jobId));
  const card = await cardOfJob(o.jobId).catch(() => null);
  const drafts = await db
    .select({ number: schema.purchaseOrders.number })
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.jobId, o.jobId), eq(schema.purchaseOrders.status, "draft")));
  const po = drafts.length ? ` Draft POs, not sent: ${drafts.map((d) => d.number).join(", ")}.` : " No draft POs.";
  return `${card?.name ?? "Customer"}, job ${job?.number ?? o.jobId}. ${money(dep.confirmed)} confirmed for stock.${po}`;
}

/* ---------------------------------------------------------------------------
 * The stock check (A1.2, clarification 2).
 *
 * Runs after a payment (outside the payment save), at start-up, every 10
 * minutes and on the "Recheck stock" button. Everything is worked out again
 * from the facts: the order's terms, the payment rows and the holds. So if a
 * payment saved and nothing else did, the next check finds it.
 *
 *  - Cancelled or review orders are never touched.
 *  - Handed over and issued stock is never held again.
 *  - Each alert has a fixed key and is sent once.
 * ------------------------------------------------------------------------- */

const MAX_FAILS = 3;

/**
 * The one-line stock status shown on the job (A1.6 fulfilment):
 * "Fully reserved", or "Partially reserved: 40 m² outstanding".
 * Short rows are kept in the line's own unit.
 */
export function reserveStatus(holds: Pick<Hold, "status" | "qty" | "orderedQty" | "lineUnit">[]): string | null {
  const live = holds.filter((h) => h.status !== "released" && h.status !== "cancelled");
  if (!live.length) return null;
  const firm = live.filter((h) => (FIRM as string[]).includes(h.status));
  const short = live.filter((h) => h.status === "short");
  const waiting = live.filter((h) => (WAITING as string[]).includes(h.status));
  if (short.length) {
    const byUnit = new Map<string, number>();
    for (const h of short) byUnit.set(h.lineUnit ?? "", r4((byUnit.get(h.lineUnit ?? "") ?? 0) + (h.orderedQty ?? h.qty)));
    const txt = [...byUnit].map(([u, q]) => qtyText(q, u)).join(" + ");
    if (firm.length) return `Partially reserved: ${txt} outstanding`;
    // Nothing firm yet: the rest waits on the deposit, and this much is not in stock at all.
    return waiting.length ? `Not reserved yet. ${txt} still to come in` : `Not reserved: ${txt} outstanding`;
  }
  if (waiting.length) return firm.length ? `Partially reserved: ${waiting.length} line(s) waiting` : "Not reserved yet";
  return "Fully reserved";
}

async function jobCancelled(jobId: number) {
  const [row] = await db
    .select({ status: schema.jobStatuses.name })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(eq(schema.jobs.id, jobId));
  return (row?.status ?? "").trim().toLowerCase() === "cancelled";
}

async function invoiceVoid(o: Order) {
  if (o.kind !== "sale_invoice" || !o.invoiceId) return false;
  const [inv] = await db.select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, o.invoiceId));
  return inv?.status === "void";
}

export type CheckResult = { orderId: number; skipped?: string; firmed: number; short: number; state: string; error?: string };

/**
 * The job was cancelled or the invoice voided. Money received for stock:
 * the stock stays firm and the office decides (status review). No money:
 * waiting holds are let go and the order is cancelled.
 */
async function handleCancel(o: Order): Promise<CheckResult> {
  const dep = await depositState(o);
  const holds = await holdsOfOrder(o.id);
  const firm = holds.filter((h) => (FIRM as string[]).includes(h.status));
  if (dep.confirmed > 0 || dep.recordedUnconfirmed > 0 || firm.length) {
    const note = `Cancelled after money was received (${money(dep.confirmed + dep.recordedUnconfirmed)}). Stock kept firm. Office to decide: refund, credit or keep.`;
    await db.update(schema.stockOrders).set({ status: "review", reviewNote: note, updatedAt: new Date() }).where(and(eq(schema.stockOrders.id, o.id), eq(schema.stockOrders.status, o.status)));
    await stockAlert(`review:${o.id}`, "stock_review", { orderId: o.id, jobId: o.jobId, title: "Stock order needs review", body: note, path: `/jobs/${o.jobId}` });
    return { orderId: o.id, firmed: 0, short: 0, state: "review" };
  }
  const now = new Date();
  await db
    .update(schema.stockReservations)
    .set({ status: "released", releasedAt: now, releaseReason: "Order cancelled before any deposit. Stock released.", updatedAt: now })
    .where(and(eq(schema.stockReservations.orderId, o.id), inArray(schema.stockReservations.status, [...WAITING, "short"])));
  // A2: a job share on a warehouse order is let go too. The order itself is never changed: that quantity becomes general stock.
  await db
    .update(schema.stockPoLinks)
    .set({ status: "cancelled", note: "Order cancelled before any deposit. The quantity stays on the warehouse order as general stock.", updatedAt: now })
    .where(and(eq(schema.stockPoLinks.orderId, o.id), eq(schema.stockPoLinks.status, "open")));
  await db.update(schema.stockOrders).set({ status: "cancelled", updatedAt: now }).where(and(eq(schema.stockOrders.id, o.id), eq(schema.stockOrders.status, o.status)));
  await afterChange(o.jobId);
  return { orderId: o.id, firmed: 0, short: 0, state: "cancelled" };
}

async function checkOne(o0: Order): Promise<CheckResult> {
  if (o0.status === "cancelled" || o0.status === "review") return { orderId: o0.id, skipped: o0.status, firmed: 0, short: 0, state: o0.status };
  if ((await jobCancelled(o0.jobId)) || (await invoiceVoid(o0))) return handleCancel(o0);
  // A PO drafted or sent before stock was chosen is flagged here too (never changed).
  await import("./costs").then((c) => c.flagPoOverlap(o0.jobId)).catch((e) => console.error("[stock] PO overlap check failed:", (e as Error).message));
  const o = await syncTerms(o0);
  if (o.status !== "active") return { orderId: o.id, skipped: "not accepted", firmed: 0, short: 0, state: "not_accepted" };
  const dep = await depositState(o);
  if (dep.code !== "confirmed") return { orderId: o.id, firmed: 0, short: 0, state: dep.code };

  let firmed = 0;
  let short = 0;
  for (const h of await holdsOfOrder(o.id)) {
    // Only waiting holds. Fulfilled, firm and ended ones are left exactly as they are.
    if (!(WAITING as string[]).includes(h.status)) continue;
    const r = await firmHold(h, dep.payments.some((p) => p.counts && p.source === "stripe") ? "Card deposit" : "Deposit confirmed");
    firmed += r.firmed;
    short = r4(short + r.short);
  }
  if (firmed || short) await afterChange(o.jobId);

  const after = await holdsOfOrder(o.id);
  const firmNow = after.filter((h) => (FIRM as string[]).includes(h.status));
  const shortNow = after.filter((h) => h.status === "short");
  if (firmNow.length || shortNow.length) {
    if (shortNow.length) {
      await stockAlert(`reserved:${o.id}`, "stock_short", {
        orderId: o.id,
        jobId: o.jobId,
        title: "Stock partly reserved",
        body: `Deposit confirmed. ${firmNow.length} line(s) reserved, ${shortNow.length} short. Choose more stock or order it. ${await orderFacts(o, dep)}`,
        path: `/jobs/${o.jobId}`,
      });
    } else {
      const [first] = await db.select().from(schema.stockAlerts).where(eq(schema.stockAlerts.key, `reserved:${o.id}`));
      if (!first) {
        await stockAlert(`reserved:${o.id}`, "stock_reserved", { orderId: o.id, jobId: o.jobId, title: "Stock reserved", body: `Deposit confirmed. ${firmNow.length} line(s) reserved. ${await orderFacts(o, dep)}`, path: `/jobs/${o.jobId}` });
      } else if (first.kind === "stock_short") {
        await stockAlert(`full:${o.id}`, "stock_full", { orderId: o.id, jobId: o.jobId, title: "Now fully reserved", body: "The short lines are now covered. Everything on the order is reserved.", path: `/jobs/${o.jobId}` });
      }
    }
  }
  if (shortNow.length) await paidWhileSupplyShort(o, shortNow).catch((e) => console.error("[stock] supply short check failed:", (e as Error).message));
  return { orderId: o.id, firmed, short, state: shortNow.length ? "short" : "confirmed" };
}

/**
 * A2 (7D): the deposit is in and a container or stock-only product is short.
 * The payment stays recorded as it is. No refund, no purchase, no message to
 * the customer: the office is told once per order and product.
 */
async function paidWhileSupplyShort(o: Order, shortNow: Hold[]) {
  const ids = [...new Set(shortNow.map((h) => h.productId))];
  const prods = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  const { modeOf, productName, SHORT_LABEL } = await import("./replenish");
  for (const p of prods) {
    const mode = modeOf(p);
    if (mode !== "container" && mode !== "stock_only") continue;
    const qty = r4(shortNow.filter((h) => h.productId === p.id).reduce((s, h) => s + (h.orderedQty ?? h.qty), 0));
    await stockAlert(`paid-short:${o.id}:${p.id}`, "stock_paid_short", {
      orderId: o.id,
      jobId: o.jobId,
      title: `Paid order short: ${productName(p)}`,
      body: `${SHORT_LABEL[mode]}. The deposit is recorded and stays as it is. ${qty} short on this order. No refund or purchase has been made. Decide with the customer.`,
      path: `/jobs/${o.jobId}`,
    });
  }
}

/** Check one order. Never throws: a failure is counted and, the third time running, alerted once. */
export async function recheckOrder(orderId: number): Promise<CheckResult> {
  let o: Order;
  try {
    o = await orderById(orderId);
  } catch (e) {
    return { orderId, firmed: 0, short: 0, state: "missing", error: (e as Error).message };
  }
  try {
    const out = await checkOne(o);
    await db.update(schema.stockOrders).set({ lastCheckAt: new Date(), lastCheckError: null, failCount: 0 }).where(eq(schema.stockOrders.id, o.id));
    return out;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const fails = o.failCount + 1;
    await db.update(schema.stockOrders).set({ lastCheckAt: new Date(), lastCheckError: msg, failCount: fails }).where(eq(schema.stockOrders.id, o.id));
    if (fails >= MAX_FAILS) {
      await stockAlert(`check-failed:${o.id}`, "stock_check_failed", {
        orderId: o.id,
        jobId: o.jobId,
        title: "Stock check failed",
        body: `The stock check on this order failed ${fails} times running. Last error: ${msg}. Press "Recheck stock" on the job, or tell support.`,
        path: `/jobs/${o.jobId}`,
      });
    }
    return { orderId: o.id, firmed: 0, short: 0, state: "error", error: msg };
  }
}

/** After a payment is saved. Called outside the payment save: the payment always stands. */
export async function recheckAfterPayment(invoiceId: number) {
  try {
    const orders = await ordersForInvoice(invoiceId);
    const [inv] = await db.select({ jobId: schema.invoices.jobId }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    // A planned order on the same job may just need its terms picked up.
    const planned = inv?.jobId
      ? await db
          .select()
          .from(schema.stockOrders)
          .where(and(eq(schema.stockOrders.jobId, inv.jobId), eq(schema.stockOrders.status, "planned")))
      : [];
    const out: CheckResult[] = [];
    for (const o of [...orders, ...planned]) out.push(await recheckOrder(o.id));
    return out;
  } catch (e) {
    console.error("[stock] check after payment failed:", (e as Error).message);
    return [];
  }
}

/** Start-up, every 10 minutes, and the office button for all orders. */
export async function recheckAll(now = new Date()) {
  const expired = await expireHolds(now).catch(() => 0);
  const warned = await warnHolds(now).catch(() => 0);
  const orders = await db.select({ id: schema.stockOrders.id }).from(schema.stockOrders).where(inArray(schema.stockOrders.status, ["planned", "active"]));
  const results: CheckResult[] = [];
  for (const o of orders) results.push(await recheckOrder(o.id));
  const { resendUnsent } = await import("./alerts");
  const resent = await resendUnsent().catch(() => 0);
  // A2: one low-stock alert per low spell, for products with alerts ticked (S6 on only).
  const { checkLowAlerts } = await import("./replenish");
  const low = await checkLowAlerts().catch((e) => {
    console.error("[stock] low stock check failed:", (e as Error).message);
    return { sent: 0, reset: 0 };
  });
  return { expired, warned, resent, results, low };
}
