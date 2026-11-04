import { eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { addBillFlag, BILL_DIFFERS, dropBillFlag, hasBillFlag, money } from "./core";
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
 *  - Bill agrees: the mark comes off and the cost is final.
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

/** Run after the PO's bills are compared. Safe to run again: an item already right is skipped. */
export async function applyBillToStock(poId: number) {
  const state = await billStateOf(poId);
  const out = { state, flagged: 0, finalised: 0 };
  if (!state) return out;
  const fam = await familyOf(poId);
  if (!fam.length) return out;
  const byHand = new Set(
    (await db.select({ id: schema.stockMovements.stockItemId, kind: schema.stockMovements.kind }).from(schema.stockMovements).where(inArray(schema.stockMovements.stockItemId, fam.map((i) => i.id))))
      .filter((m) => m.kind === "cost_adjust")
      .map((m) => m.id),
  );
  for (const it of fam) {
    if (it.unitCost == null || it.costStatus === "unknown" || it.costStatus === "estimate" || byHand.has(it.id)) continue;
    if (state === "different") {
      if (it.costStatus === "provisional" && hasBillFlag(it.purchaseCostNote)) continue;
      await db.update(schema.stockItems).set({ costStatus: "provisional", purchaseCostNote: addBillFlag(it.purchaseCostNote), updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
      await noteMovement(it, "cost_review", `${BILL_DIFFERS}. Kept at the PO rate, ${money(it.unitCost)} per ${it.costPer}, freight not included. For review.`, BY);
      out.flagged++;
    } else {
      if (it.costStatus !== "provisional") continue;
      await db.update(schema.stockItems).set({ costStatus: "final", purchaseCostNote: dropBillFlag(it.purchaseCostNote), updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
      await noteMovement(it, "cost_review", `Bill agrees with the PO. Cost final at the PO rate, ${money(it.unitCost)} per ${it.costPer}.`, BY);
      out.finalised++;
    }
  }
  return out;
}
