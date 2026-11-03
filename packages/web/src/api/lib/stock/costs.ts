import { and, eq, inArray, isNotNull, like } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { ALLOCATED, bad, COST_UNKNOWN, money, need, type PermActor, r2, unitText } from "./core";
import { type Hold, holdById } from "./holds";
import { costPerItemUnit, type Item, itemById } from "./items";

/* ---------------------------------------------------------------------------
 * Costing (A1.1).
 *
 *  - A quote line's expected cost is its cost price × only the quantity still
 *    to order. What comes from stock is taken off at the quote's rate.
 *  - Stock gets its own cost line at what we actually paid for it
 *    (jobCosts.source "stock", stockRef "hold:<id>"). It follows the
 *    allocation and becomes actual once issued.
 *  - A supplier with nothing left to order loses its quoted freight and
 *    charges too, with a note.
 *  - Goods bought on this job's PO (costOnPo) carry their cost on the PO
 *    line. Issuing them adds nothing.
 *
 * Stock cost lines are written with state "paid": the stock is already paid
 * for, so it never shows in Money out or the supplier forecast.
 * ------------------------------------------------------------------------- */

export const STOCK_SOURCE = "stock";
const LIVE: string[] = [...ALLOCATED];

/** Quote line id → quantity covered from stock, in the line's unit. Excludes goods bought on the job's PO. */
export async function stockAllocatedByQuoteItem(jobId: number) {
  const rows = await db
    .select()
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.jobId, jobId), isNotNull(schema.stockReservations.quoteItemId), inArray(schema.stockReservations.status, LIVE)));
  const out = new Map<number, number>();
  for (const h of rows) {
    if (h.costOnPo || !h.stockItemId) continue;
    out.set(h.quoteItemId!, (out.get(h.quoteItemId!) ?? 0) + (h.orderedQty ?? h.qty));
  }
  return out;
}

/** Job material id → quantity coming from stock (so the PO helper does not order it). */
export async function stockAllocatedByMaterial(jobId: number) {
  const rows = await db
    .select()
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.jobId, jobId), isNotNull(schema.stockReservations.jobMaterialId), inArray(schema.stockReservations.status, LIVE)));
  const out = new Map<number, number>();
  for (const h of rows) {
    if (!h.stockItemId) continue;
    out.set(h.jobMaterialId!, (out.get(h.jobMaterialId!) ?? 0) + (h.orderedQty ?? h.qty));
  }
  return out;
}

/**
 * A PO line that now orders more than the job still needs, because stock was
 * allocated after the PO was drafted or sent (v3: "Changes after drafting are
 * flagged, never applied to a sent PO"). Nothing on the PO is changed, by us,
 * ever: the office fixes a draft and decides on a sent one. One alert per
 * line per stock quantity, so a repeat check does not send it twice.
 */
export async function flagPoOverlap(jobId: number): Promise<string[]> {
  // Only warehouse stock counts here. A roll bought on this job's own PO
  // (costOnPo) is that PO arriving, not an overlap with it.
  const held = await db
    .select()
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.jobId, jobId), isNotNull(schema.stockReservations.jobMaterialId), inArray(schema.stockReservations.status, LIVE)));
  const fromStock = new Map<number, number>();
  for (const h of held) {
    if (h.costOnPo || !h.stockItemId) continue;
    fromStock.set(h.jobMaterialId!, (fromStock.get(h.jobMaterialId!) ?? 0) + (h.orderedQty ?? h.qty));
  }
  if (!fromStock.size) return [];
  const lines = await db
    .select({
      lineId: schema.purchaseOrderLines.id,
      lineQty: schema.purchaseOrderLines.qty,
      unit: schema.purchaseOrderLines.unit,
      materialId: schema.purchaseOrderLines.jobMaterialId,
      materialQty: schema.jobMaterials.qty,
      description: schema.purchaseOrderLines.description,
      number: schema.purchaseOrders.number,
      status: schema.purchaseOrders.status,
    })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .innerJoin(schema.jobMaterials, eq(schema.jobMaterials.id, schema.purchaseOrderLines.jobMaterialId))
    .where(and(eq(schema.purchaseOrders.jobId, jobId), inArray(schema.purchaseOrderLines.jobMaterialId, [...fromStock.keys()]), inArray(schema.purchaseOrders.status, ["draft", "sent", "invoiced"])));
  const out: string[] = [];
  const { stockAlert } = await import("./alerts");
  for (const l of lines) {
    const stock = fromStock.get(l.materialId!) ?? 0;
    const still = Math.max(0, Math.round((l.materialQty - stock) * 10_000) / 10_000);
    if (l.lineQty <= still + 0.0001) continue;
    const u = unitText(l.unit);
    const need = still > 0 ? `Stock now covers ${stock} ${u}, so only ${still} ${u} is still needed.` : `Stock now covers all ${stock} ${u}, so this line is not needed.`;
    const msg =
      l.status === "draft"
        ? `Draft ${l.number} still orders ${l.lineQty} ${u} of ${l.description}. ${need} Change the draft before sending it.`
        : `${l.number} was sent for ${l.lineQty} ${u} of ${l.description}. ${need} The PO was not changed. Decide with the supplier.`;
    out.push(msg);
    const title = still > 0 ? `Check ${l.number}: stock now covers part of it` : `Check ${l.number}: stock now covers this line`;
    await stockAlert(`po-overlap:${l.lineId}:${stock}`, "stock_po_overlap", { jobId, title, body: msg, path: `/jobs/${jobId}` }).catch((e) =>
      console.error("[stock] PO overlap alert failed:", (e as Error).message),
    );
  }
  return out;
}

/** What a hold costs the job. Opened containers already costed to a job add only an approved carried amount. */
export function holdCost(h: Hold, it: Item): { amount: number; known: boolean } {
  if (h.costOnPo) return { amount: 0, known: true };
  // Opened container: the first job already carries its full cost. A reissue adds $0
  // (an approved carried amount is booked once, on issue, as its own line).
  if (it.condition === "opened" && it.costOnJobId) return { amount: 0, known: true };
  const per = costPerItemUnit(it);
  if (per == null) return { amount: 0, known: false };
  return { amount: r2(per * h.qty), known: true };
}

/**
 * Make the job's stock cost lines match its holds, then the expected
 * supplier costs. Worked out from the holds each time, so running it again
 * changes nothing.
 */
export async function syncStockCosts(jobId: number) {
  const holds = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.jobId, jobId));
  const want = new Map<string, { amount: number; description: string; notes: string }>();
  for (const h of holds) {
    if (!LIVE.includes(h.status) || !h.stockItemId || h.costOnPo) continue;
    const it = await itemById(h.stockItemId);
    const c = holdCost(h, it);
    const done = h.status === "issued" || h.status === "handed_over";
    want.set(`hold:${h.id}`, {
      amount: c.amount,
      description: `From stock: ${it.code}, ${h.qty} ${unitText(it.unit)}${h.freeQty && h.freeState === "approved" ? ` (${h.freeQty} free)` : ""}`.slice(0, 300),
      notes: c.known ? (done ? "Stock issued. Actual cost." : "Stock allocated. Already paid for, not owed to anyone.") : COST_UNKNOWN,
    });
  }
  const rows = await db
    .select()
    .from(schema.jobCosts)
    .where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.source, STOCK_SOURCE), like(schema.jobCosts.stockRef, "hold:%")));
  for (const r of rows) {
    const w = want.get(r.stockRef!);
    want.delete(r.stockRef!);
    if (!w) {
      await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, r.id));
      continue;
    }
    if (r.amount !== w.amount || r.description !== w.description || r.notes !== w.notes) {
      await db.update(schema.jobCosts).set({ ...w, updatedAt: new Date() }).where(eq(schema.jobCosts.id, r.id));
    }
  }
  for (const [ref, w] of want) {
    await db.insert(schema.jobCosts).values({ jobId, kind: "materials", supplierId: null, ...w, state: "paid", source: STOCK_SOURCE, stockRef: ref });
  }
  const { acceptedQuoteIdOf, syncExpectedCosts } = await import("../expected-costs");
  const q = await acceptedQuoteIdOf(jobId);
  if (q) await syncExpectedCosts(jobId, q);
}

/** A one-off stock cost line (a return, a release, a cost move). Never written twice for the same ref. */
export async function stockCostLine(jobId: number, ref: string, amount: number, description: string, notes: string) {
  const [seen] = await db.select().from(schema.jobCosts).where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.stockRef, ref)));
  if (seen) return { row: seen, reused: true };
  const [row] = await db
    .insert(schema.jobCosts)
    .values({ jobId, kind: "materials", supplierId: null, amount: r2(amount), description: description.slice(0, 300), notes, state: "paid", source: STOCK_SOURCE, stockRef: ref })
    .returning();
  return { row: row!, reused: false };
}

/** The job's material cost total, the figure in the A1.1 table. */
export async function jobMaterialTotal(jobId: number) {
  const rows = await db.select().from(schema.jobCosts).where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.kind, "materials")));
  return r2(rows.reduce((s, r) => s + r.amount, 0));
}

/**
 * Admin approval: goods bought on this job's PO go to general stock (left
 * over, or the job cancelled). Job cost down, stock value up, by the same
 * amount. Never twice.
 */
export async function releaseJobPoGoods(holdId: number, reason: string, actor: PermActor) {
  await need(actor, "approve");
  if (reason.trim().length < 3) throw bad("Say why the goods go back to stock.");
  const h = await holdById(holdId);
  if (!h.costOnPo || !h.stockItemId) throw bad("This hold is not goods bought on the job's PO.");
  if (h.status === "released") {
    const [row] = await db.select().from(schema.jobCosts).where(eq(schema.jobCosts.stockRef, `release:${h.id}`));
    return { hold: h, cost: row ?? null, reused: true };
  }
  const left = Math.max(0, h.qty - h.collectedQty);
  if (!(left > 0)) throw bad("Everything on this hold has gone to the job.");
  const it = await itemById(h.stockItemId);
  const per = costPerItemUnit(it);
  if (per == null) throw bad(`${COST_UNKNOWN}. Set the cost first.`);
  const value = r2(per * left);
  await db
    .update(schema.stockReservations)
    .set({ status: "released", releasedAt: new Date(), releaseReason: `To general stock, approved by ${actor.name}: ${reason.trim().slice(0, 200)}`, updatedAt: new Date() })
    .where(eq(schema.stockReservations.id, h.id));
  await db.update(schema.stockItems).set({ costOnJobId: null, updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
  const { row } = await stockCostLine(h.jobId, `release:${h.id}`, -value, `Returned to stock: ${it.code}, ${left} ${unitText(it.unit)}`, `Bought on the job's PO, moved to general stock at ${money(value)}. Internal only.`);
  return { hold: await holdById(h.id), cost: row, reused: false };
}

/** Value of general stock: available items, less anything held for a job's own PO goods. */
export async function generalStockValue() {
  const items = await db.select().from(schema.stockItems).where(eq(schema.stockItems.status, "available"));
  const holds = await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.costOnPo, true), inArray(schema.stockReservations.status, LIVE)));
  const tied = new Map<number, number>();
  for (const h of holds) if (h.stockItemId) tied.set(h.stockItemId, (tied.get(h.stockItemId) ?? 0) + Math.max(0, h.qty - h.collectedQty));
  let v = 0;
  for (const it of items) {
    // Opened containers: the cost is already on a job. Only an approved carried amount is still in stock.
    if (it.condition === "opened") {
      v += it.costCarry;
      continue;
    }
    const per = costPerItemUnit(it);
    if (per == null) continue;
    v += per * Math.max(0, it.qty - (tied.get(it.id) ?? 0));
  }
  return r2(v);
}
