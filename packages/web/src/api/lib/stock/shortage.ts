import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { bad, forbid, type PermActor, r4, WAITING } from "./core";
import { availableOn, holdsOfOrder, outstanding } from "./holds";
import { orderById, type Order } from "./orders";
import { modeOf, productName, SHORT_LABEL, type SupplyMode } from "./replenish";
import { quoteSupplyLines, supplyShorts, type SupplyLine } from "./supply-check";

/* ---------------------------------------------------------------------------
 * A2c: is material on this order actually short right now?
 *
 * Only a real shortage counts. A deposit that is less than the order total is
 * not a shortage. A product is short on an order when:
 *  - a hold on the order is "short" (found when the deposit came in), or
 *  - a hold still waiting on the deposit sits on stock that is no longer free
 *    (someone else's firm hold took it), or
 *  - a container or stock-only product on the order needs more than is on the
 *    shelf (the same check as before a quote is sent or a sale is raised).
 *
 * Container and stock-only shortages block payment until the shortage is
 * resolved or the main admin records the arrangement the customer agreed to.
 * The internal approval note never counts as the customer's agreement.
 * Reads only, except recordCustomerArrangement.
 * ------------------------------------------------------------------------- */

export type OrderShort = {
  productId: number;
  product: string;
  mode: SupplyMode;
  label: string;
  /** Container or stock-only: payment waits for the shortage to be resolved or a recorded customer arrangement. */
  blocksPayment: boolean;
  arrangement: { text: string; byName: string | null; at: Date | null } | null;
};

const OWNER_REVIEW: SupplyMode[] = ["container", "stock_only"];

/** The quote the order's lines come from: the accepted quote, else the sale's own quote. */
async function orderQuoteId(o: Order): Promise<number | null> {
  const qs = await db.select({ id: schema.quotes.id, status: schema.quotes.status }).from(schema.quotes).where(eq(schema.quotes.jobId, o.jobId)).orderBy(asc(schema.quotes.id));
  return (qs.find((q) => q.status === "accepted") ?? (o.kind === "job" ? null : qs[0]))?.id ?? null;
}

/** What the order needs: a job's accepted quote lines; a sale's own lines, else its quote's lines. */
async function orderLines(o: Order): Promise<SupplyLine[]> {
  if (o.kind === "job") {
    const quoteId = await orderQuoteId(o);
    return quoteId != null ? quoteSupplyLines(quoteId) : [];
  }
  const fromSale = await saleLinesOfJob(o.jobId);
  if (fromSale.length) return fromSale;
  const quoteId = await orderQuoteId(o);
  return quoteId != null ? quoteSupplyLines(quoteId) : [];
}

async function saleLinesOfJob(jobId: number): Promise<SupplyLine[]> {
  const sales = await db.select({ id: schema.productSales.id }).from(schema.productSales).where(eq(schema.productSales.jobId, jobId));
  if (!sales.length) return [];
  const rows = await db
    .select({ productId: schema.productSaleLines.productId, qty: schema.productSaleLines.qty, unit: schema.productSaleLines.unit })
    .from(schema.productSaleLines)
    .where(inArray(schema.productSaleLines.saleId, sales.map((x) => x.id)));
  return rows.filter((r) => r.productId != null && r.qty > 0);
}

/** Where a customer arrangement is kept: one live stock order, or a direct-sale invoice that has no stock order. */
export type ShortTarget = { orderId: number; invoiceId?: undefined } | { invoiceId: number; orderId?: undefined };

async function describe(ids: Set<number>, entityType: "order" | "invoice", entityKey: string): Promise<OrderShort[]> {
  if (!ids.size) return [];
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, [...ids]));
  const agreed = await db
    .select()
    .from(schema.stockSupplyApprovals)
    .where(and(eq(schema.stockSupplyApprovals.entityType, entityType), eq(schema.stockSupplyApprovals.entityKey, entityKey)));
  return products.map((p) => {
    const mode = modeOf(p);
    const a = agreed.find((x) => x.productId === p.id && x.customerAgreed.trim());
    return {
      productId: p.id,
      product: productName(p),
      mode,
      label: SHORT_LABEL[mode],
      blocksPayment: OWNER_REVIEW.includes(mode),
      arrangement: a ? { text: a.customerAgreed, byName: a.customerAgreedBy, at: a.customerAgreedAt ?? null } : null,
    };
  });
}

async function shortIds(lines: SupplyLine[], jobId: number, ids: Set<number>) {
  for (const s of await supplyShorts(lines, jobId, null)) {
    // A line whose unit does not compare is a setup problem, not a known shortage.
    if (s.short != null && s.short > 0.0001) ids.add(s.productId);
  }
}

export async function orderShortages(o: Order): Promise<OrderShort[]> {
  if (o.status !== "active") return [];
  const ids = new Set<number>();
  for (const h of await holdsOfOrder(o.id)) {
    if (h.status === "short") ids.add(h.productId);
    else if ((WAITING as string[]).includes(h.status) && h.stockItemId != null && (await availableOn(h.stockItemId, h.id)) < outstanding(h) - 0.0001) ids.add(h.productId);
  }
  await shortIds(await orderLines(o), o.jobId, ids);
  return describe(ids, "order", String(o.id));
}

/**
 * A direct-sale invoice that has no stock order (the shelf stock was not
 * chosen on it). Its own sale lines are checked the same way.
 */
export async function invoiceShortages(invoiceId: number): Promise<OrderShort[]> {
  const [inv] = await db.select({ id: schema.invoices.id, jobId: schema.invoices.jobId, status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv?.jobId || inv.status === "void") return [];
  const orders = await db.select({ id: schema.stockOrders.id }).from(schema.stockOrders).where(eq(schema.stockOrders.jobId, inv.jobId));
  if (orders.length) return [];
  const sales = await db.select({ id: schema.productSales.id }).from(schema.productSales).where(eq(schema.productSales.jobId, inv.jobId));
  if (!sales.length) return [];
  const ids = new Set<number>();
  await shortIds(await saleLinesOfJob(inv.jobId), inv.jobId, ids);
  return describe(ids, "invoice", String(inv.id));
}

/** The job panel: the order's shortages, else those on the job's direct-sale invoices. */
export async function jobShortages(jobId: number, order: Order | null): Promise<(OrderShort & { target: ShortTarget })[]> {
  if (order) return (await orderShortages(order)).map((s) => ({ ...s, target: { orderId: order.id } }));
  const invs = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.jobId, jobId)).orderBy(asc(schema.invoices.id));
  const out: (OrderShort & { target: ShortTarget })[] = [];
  for (const i of invs) for (const s of await invoiceShortages(i.id)) out.push({ ...s, target: { invoiceId: i.id } });
  return out;
}

/**
 * The main admin records the arrangement the customer agreed to for one short
 * product on one order. Kept apart from the internal approval note. Payment for
 * that product's shortage is no longer blocked. Nothing is ordered or refunded.
 */
export async function recordCustomerArrangement(input: ShortTarget & { productId: number; arrangement: string; customerAgreed: boolean }, actor: PermActor) {
  if (!actor.isMainAdmin) throw forbid("Only the main admin can record an arrangement agreed with the customer.");
  if (!input.customerAgreed) throw bad("Tick that the customer has agreed to this arrangement.");
  const text = input.arrangement.trim();
  if (text.length < 10) throw bad("Write down what the customer agreed to.");
  let entityType: "order" | "invoice";
  let entityKey: string;
  let jobId: number | null;
  let shorts: OrderShort[];
  if (input.orderId != null) {
    const o = await orderById(input.orderId);
    [entityType, entityKey, jobId, shorts] = ["order", String(o.id), o.jobId, await orderShortages(o)];
  } else if (input.invoiceId != null) {
    const [inv] = await db.select({ id: schema.invoices.id, jobId: schema.invoices.jobId }).from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId));
    if (!inv) throw bad("Invoice not found.");
    [entityType, entityKey, jobId, shorts] = ["invoice", String(inv.id), inv.jobId, await invoiceShortages(inv.id)];
  } else throw bad("Choose the order or invoice.");
  const s = shorts.find((x) => x.productId === input.productId);
  if (!s) throw bad("Nothing is short on this order for that product.");
  const now = new Date();
  await db
    .insert(schema.stockSupplyApprovals)
    .values({
      entityType,
      entityKey,
      productId: input.productId,
      shortQty: r4(0),
      note: "",
      byName: actor.name,
      customerAgreed: text.slice(0, 500),
      customerAgreedBy: actor.name,
      customerAgreedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.stockSupplyApprovals.entityType, schema.stockSupplyApprovals.entityKey, schema.stockSupplyApprovals.productId],
      set: { customerAgreed: text.slice(0, 500), customerAgreedBy: actor.name, customerAgreedAt: now, updatedAt: now },
    });
  await db.insert(schema.activityLog).values({
    entityType: "job",
    entityId: jobId,
    action: "stock_customer_arrangement",
    detail: `Customer arrangement recorded for ${s.product}: ${text.slice(0, 300)}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { ok: true };
}
