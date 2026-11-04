import { and, eq } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { stockAlert } from "./alerts";
import { bad, cm, need, needOn, notFound, type PermActor, r4, unitText } from "./core";
import { createItem, type Item } from "./items";

/** "PO199703-1" stays as it is; an older number like "4113-A" reads "PO 4113-A". */
const poName = (n: string) => (/^PO/i.test(n) ? n : `PO ${n}`);

/* ---------------------------------------------------------------------------
 * Receiving goods against a PO line (v3 section 6, A1.1).
 *
 *  - Part deliveries are fine. The line's received quantity goes up each time.
 *  - A repeated press (same request key) returns the first receipt.
 *  - A roll shorter than its label is recorded at what was measured, and the
 *    office is told once.
 *  - Goods bought on a job's PO become "Bought for Job [number] on PO
 *    [number]", firmly reserved to that job straight away, with their cost
 *    left on the PO line (issuing them adds no second cost).
 *  - Nothing here sends, changes or re-prices a PO.
 * ------------------------------------------------------------------------- */

type Actor = PermActor & { profileId: number | null };

export type ReceivePiece = {
  /** Rolls: measured length in metres. Others: count in the line's unit (boxes, units). */
  qty: number;
  /** Rolls: what the supplier's label says, to spot a short roll. */
  labelQty?: number | null;
  widthM?: number | null;
  batch?: string | null;
  supplierRollNo?: string;
  packSize?: number | null;
  locationId?: number | null;
};

const isRollLine = (unit: string, pieces: ReceivePiece[]) => unit === "lm" || (unit === "m2" && pieces.every((p) => p.widthM && p.widthM > 0));

/** The line's own quantity a piece adds up to (m² for a roll bought by the m²). */
const lineQtyOf = (unit: string, p: ReceivePiece, roll: boolean) => (roll && unit === "m2" ? r4(p.qty * (p.widthM ?? 0)) : r4(p.qty));

export async function receiveLine(input: { poLineId: number; pieces: ReceivePiece[]; requestKey: string }, actor: Actor) {
  await need(actor, "handle");
  await needOn("s1");
  const key = input.requestKey.trim();
  if (key.length < 6) throw bad("Refresh the page and try again.");
  const [seen] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.requestKey, `${key}:0`));
  if (seen) {
    const all = await db.select().from(schema.stockItems).where(eq(schema.stockItems.poLineId, seen.poLineId!));
    return { items: all.filter((i) => i.requestKey?.startsWith(`${key}:`)), reused: true, shortRolls: [] as string[] };
  }
  if (!input.pieces.length) throw bad("Add at least one roll, box or unit.");
  const [line] = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, input.poLineId));
  if (!line) throw notFound("PO line not found");
  if (line.kind !== "goods") throw bad("Only goods lines are received.");
  if (!line.productId) throw bad("This PO line has no product. Link the product first.");
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, line.poId));
  if (!po) throw notFound("PO not found");
  if (po.status === "cancelled") throw bad(`${poName(po.number)} is cancelled.`);
  if (po.status === "draft") throw bad(`${poName(po.number)} has not been sent yet.`);
  if (line.closedAt) throw bad("This line was closed. The rest is not coming.");
  for (const p of input.pieces) if (!(p.qty > 0)) throw bad("Each piece needs a quantity over 0.");

  const roll = isRollLine(line.unit, input.pieces);
  if (line.unit === "m2" && !roll) throw bad("Enter the width of each roll.");
  const adding = r4(input.pieces.reduce((s, p) => s + lineQtyOf(line.unit, p, roll), 0));
  const left = r4(line.qty - line.receivedQty);
  if (adding > left * 1.1 + 0.01) throw bad(`Only ${left} ${unitText(line.unit)} is still to come on this line.`);

  // Claim the quantity first, so two people receiving the same delivery cannot both count it.
  const [claimed] = await db
    .update(schema.purchaseOrderLines)
    .set({ receivedQty: r4(line.receivedQty + adding), updatedAt: new Date() })
    .where(and(eq(schema.purchaseOrderLines.id, line.id), eq(schema.purchaseOrderLines.receivedQty, line.receivedQty)))
    .returning();
  if (!claimed) throw bad("Someone else just received against this line. Refresh and check.");

  // A warehouse PO has no job. Job-linked shares on it (A2 route B) are handled after the items exist.
  const jobId = po.kind !== "warehouse" ? po.jobId : null;
  const [job] = jobId != null ? await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, jobId)) : [];
  const costPer = roll ? (line.unit === "m2" ? "m2" : "lm") : "unit";
  const items: Item[] = [];
  const shortRolls: string[] = [];
  for (const [n, p] of input.pieces.entries()) {
    const made = await createItem(
      {
        productId: line.productId,
        type: roll ? "roll" : line.unit === "box" ? "box_lot" : "unit_lot",
        unit: roll ? "lm" : line.unit === "box" ? "box" : "unit",
        qty: p.qty,
        widthM: roll ? (p.widthM ?? null) : null,
        lengthSource: roll ? "measured" : null,
        widthSource: roll ? "measured" : null,
        packSize: p.packSize ?? null,
        supplierId: po.supplierId,
        supplierRollNo: p.supplierRollNo ?? "",
        batch: p.batch ?? null,
        locationId: p.locationId ?? null,
        costPer,
        unitCost: line.unitCostExGst > 0 ? line.unitCostExGst : null,
        costStatus: po.status === "invoiced" ? "final" : "provisional",
        poId: po.id,
        poLineId: line.id,
        boughtForJobId: jobId,
        costOnJobId: jobId,
        note: jobId != null ? `Bought for Job ${job?.number ?? jobId} on ${poName(po.number)}.` : `Warehouse stock, ${poName(po.number)}.`,
      },
      actor,
      { status: "available", kind: "receive", requestKey: `${key}:${n}`, jobId, note: `Received on ${poName(po.number)}.` },
    );
    items.push(made.item);
    if (roll && p.labelQty && p.qty < p.labelQty - 0.005) {
      shortRolls.push(made.item.code);
      await stockAlert(`short-roll:${made.item.id}`, "stock_short_roll", {
        jobId,
        title: `Short roll on ${poName(po.number)}`,
        body: `${made.item.code}: label says ${cm(p.labelQty)} m, measured ${cm(p.qty)} m (${cm(p.labelQty - p.qty)} m short). Recorded at the measured length. Raise it with the supplier.`,
        path: `/stock/items/${made.item.id}`,
      });
    }
    if (jobId != null) await holdForJob(made.item, jobId, po, line, key, n, actor);
  }
  // A2 route B: job shares on a warehouse line become that job's holds now, at stock cost, once.
  if (jobId == null) {
    const { fillLinksFromReceipt } = await import("./warehouse-po");
    await fillLinksFromReceipt(po, claimed, items, key, actor);
  }
  // Goods for a job's order: check the order now, so "Now fully reserved" goes out straight away (A1.6). Never stops the receipt.
  if (jobId != null) {
    try {
      const [order] = await db.select({ id: schema.stockOrders.id }).from(schema.stockOrders).where(eq(schema.stockOrders.jobId, jobId));
      if (order) {
        const { recheckOrder } = await import("./recheck");
        await recheckOrder(order.id);
      }
    } catch (e) {
      console.error("[stock] check after receipt failed:", (e as Error).message);
    }
  }
  return { items, reused: false, shortRolls };
}

/**
 * Goods bought on the job's PO are held for that job at once and are not
 * free to anyone else. If the job's order is in the stock workflow, the hold
 * joins it, and any "short" row for that line is closed off.
 */
async function holdForJob(it: Item, jobId: number, po: typeof schema.purchaseOrders.$inferSelect, line: typeof schema.purchaseOrderLines.$inferSelect, key: string, n: number, actor: Actor) {
  const [order] = await db.select().from(schema.stockOrders).where(eq(schema.stockOrders.jobId, jobId));
  await db
    .insert(schema.stockReservations)
    .values({
      productId: it.productId,
      jobId,
      orderId: order?.id ?? null,
      jobMaterialId: line.jobMaterialId,
      stockItemId: it.id,
      qty: it.qty,
      lineUnit: line.unit,
      orderedQty: line.unit === "m2" && it.unit === "lm" ? r4(it.qty * (it.widthM ?? 0)) : it.qty,
      billedQty: null,
      status: "reserved",
      costOnPo: true,
      confirmedAt: new Date(),
      confirmedByName: `Bought on ${poName(po.number)}`,
      appliedByProfileId: actor.profileId,
      appliedByName: actor.name,
      requestKey: `${key}:hold:${n}`,
    })
    .onConflictDoNothing();
  if (order && line.jobMaterialId) {
    await db
      .update(schema.stockReservations)
      .set({ status: "released", releasedAt: new Date(), releaseReason: `Covered by goods received on ${poName(po.number)}.`, updatedAt: new Date() })
      .where(and(eq(schema.stockReservations.orderId, order.id), eq(schema.stockReservations.jobMaterialId, line.jobMaterialId), eq(schema.stockReservations.status, "short")));
  }
}
