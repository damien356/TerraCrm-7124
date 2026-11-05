import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { addBillFlag, addFreightFlag, BILL_DIFFERS, dropBillFlag, dropFreightFlag, hasBillFlag, hasFreightFlag, money } from "./core";
import { type Item, noteMovement } from "./items";

/* ---------------------------------------------------------------------------
 * Stock cost when the supplier bill is not the PO amount (v3 section 13,
 * item 4; A1 amendment). The simplest rule that fits the approved design:
 *
 *  - Stock always keeps the PO line rate. Freight is not included. The
 *    cost figure itself is never changed here.
 *  - Bill differs from the PO: every item from that PO, and everything cut,
 *    opened or returned from them (remnants too), is "provisional" and
 *    marked "Cost provisional, bill differs from PO" for Damien's review.
 *  - Bill agrees: the mark comes off and the cost is final, unless the PO
 *    carries freight or charges. Those are not spread onto the stock cost,
 *    so the stock stays provisional, marked "Cost provisional, freight or
 *    charges on the PO not in the stock cost", for the manual cost review
 *    (release, Damien 5 Nov).
 *  - An item whose cost an Admin already set by hand is left alone.
 *  - Job charges and credits are not touched. They stay at the PO rate.
 * ------------------------------------------------------------------------- */

const BY = { name: "Supplier bill check", profileId: null };

/** "matched" when every bill on the PO agrees, "different" when any does not, null with no bill yet. */
export async function billStateOf(poId: number): Promise<"matched" | "different" | null> {
  const invs = await db.select({ matchStatus: schema.supplierInvoices.matchStatus }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.poId, poId));
  if (!invs.length) return null;
  if (invs.some((i) => i.matchStatus === "different")) return "different";
  if (invs.every((i) => i.matchStatus === "matched")) return "matched";
  return null;
}

/** Items received on the PO, then everything made from them, all the way down. */
async function familyOf(poId: number) {
  const all: Item[] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.poId, poId));
  let ids = all.map((i) => i.id);
  const seen = new Set(ids);
  while (ids.length) {
    const kids = await db.select().from(schema.stockItems).where(inArray(schema.stockItems.parentItemId, ids));
    const fresh = kids.filter((k) => !seen.has(k.id));
    for (const k of fresh) seen.add(k.id);
    all.push(...fresh);
    ids = fresh.map((k) => k.id);
  }
  return all;
}

/** Freight and charge lines on the PO (ex GST). Not spread onto the stock cost. */
export async function extrasOnPo(poId: number): Promise<number> {
  const lines = await db
    .select({ total: schema.purchaseOrderLines.totalExGst })
    .from(schema.purchaseOrderLines)
    .where(and(eq(schema.purchaseOrderLines.poId, poId), ne(schema.purchaseOrderLines.kind, "goods")));
  return Math.round(lines.reduce((a, l) => a + (l.total > 0 ? l.total : 0), 0) * 100) / 100;
}

/** Run after the PO's bills are compared. Safe to run again: an item already right is skipped. */
export async function applyBillToStock(poId: number) {
  const state = await billStateOf(poId);
  const out = { state, flagged: 0, finalised: 0 };
  if (!state) return out;
  const fam = await familyOf(poId);
  if (!fam.length) return out;
  const extras = await extrasOnPo(poId);
  const byHand = new Set(
    (await db.select({ id: schema.stockMovements.stockItemId, kind: schema.stockMovements.kind }).from(schema.stockMovements).where(inArray(schema.stockMovements.stockItemId, fam.map((i) => i.id))))
      .filter((m) => m.kind === "cost_adjust")
      .map((m) => m.id),
  );
  for (const it of fam) {
    if (it.unitCost == null || it.costStatus === "unknown" || it.costStatus === "estimate" || byHand.has(it.id)) continue;
    // Only touch the note where a mark goes on or comes off, so nothing else in it is rewritten.
    const was = it.purchaseCostNote ?? "";
    const withBill = state === "different" ? addBillFlag(was) : hasBillFlag(was) ? dropBillFlag(was) : was;
    const note = extras > 0 ? addFreightFlag(withBill) : hasFreightFlag(withBill) ? dropFreightFlag(withBill) : withBill;
    const status = state === "different" || extras > 0 ? "provisional" : "final";
    if (status === it.costStatus && note === was) continue;
    if (status === "final" && it.costStatus !== "provisional") continue;
    await db.update(schema.stockItems).set({ costStatus: status, purchaseCostNote: note, updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
    const rate = `${money(it.unitCost)} per ${it.costPer}`;
    if (state === "different") {
      await noteMovement(it, "cost_review", `${BILL_DIFFERS}. Kept at the PO rate, ${rate}, freight not included. For review.`, BY);
      out.flagged++;
    } else if (extras > 0) {
      await noteMovement(it, "cost_review", `Bill agrees with the PO. Cost kept provisional at the PO rate, ${rate}: freight or charges of ${money(extras)} on the PO are not in the stock cost. For review.`, BY);
      out.flagged++;
    } else {
      await noteMovement(it, "cost_review", `Bill agrees with the PO. Cost final at the PO rate, ${rate}.`, BY);
      out.finalised++;
    }
  }
  return out;
}
