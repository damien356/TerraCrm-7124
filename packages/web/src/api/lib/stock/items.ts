import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { todayLocal } from "../local-date";
import { bad, cm, COST_UNKNOWN, forbid, money, need, needOn, notFound, type PermActor, r2, r4, unitText } from "./core";

/* ---------------------------------------------------------------------------
 * Stock items and movements. Every physical change is a movement row with
 * the item's quantity before and after. A wrong entry is put right by a
 * reversing row (Admin, with a reason). Nothing is edited in place.
 * ------------------------------------------------------------------------- */

export type Item = typeof schema.stockItems.$inferSelect;
export type Movement = typeof schema.stockMovements.$inferSelect;

export const ITEM_TYPES = ["roll", "remnant", "cut_piece", "box_lot", "loose", "unit_lot"] as const;
export const itemCode = (id: number) => `T${String(id).padStart(5, "0")}`;

export async function itemById(id: number) {
  const [it] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.id, id));
  if (!it) throw notFound("Stock item not found");
  return it;
}

/** What one unit of the item cost, ex GST. Null when the cost is not known. */
export function costPerItemUnit(it: Pick<Item, "unitCost" | "costPer" | "unit" | "widthM">): number | null {
  if (it.unitCost == null) return null;
  if (it.costPer === "m2" && it.unit === "lm") return it.widthM ? r4(it.unitCost * it.widthM) : null;
  return it.unitCost;
}
export function valueOf(it: Pick<Item, "unitCost" | "costPer" | "unit" | "widthM">, qty: number) {
  const per = costPerItemUnit(it);
  return per == null ? null : r2(per * qty);
}

export type NewItem = {
  productId: number;
  type: (typeof ITEM_TYPES)[number];
  unit: string;
  qty: number;
  widthM?: number | null;
  lengthSource?: "measured" | "supplier_label" | "estimated" | null;
  widthSource?: "measured" | "supplier_label" | "estimated" | null;
  packSize?: number | null;
  supplierId?: number | null;
  supplierRollNo?: string;
  colour?: string;
  batch?: string | null;
  locationId?: number | null;
  condition?: string;
  costPer?: "lm" | "m2" | "unit";
  unitCost?: number | null;
  goodsCost?: number | null;
  freightCost?: number | null;
  /** final · provisional · estimate · unknown. Unknown needs the tick, never a $0 cost. */
  costStatus?: "final" | "provisional" | "estimate" | "unknown";
  purchaseCostNote?: string;
  parentItemId?: number | null;
  poId?: number | null;
  poLineId?: number | null;
  boughtForJobId?: number | null;
  originJobId?: number | null;
  costOnJobId?: number | null;
  terraOwned?: boolean;
  madeOn?: string | null;
  expiresOn?: string | null;
  note?: string;
};

async function defaultLocationId() {
  const [loc] = await db.select({ id: schema.stockLocations.id }).from(schema.stockLocations).where(eq(schema.stockLocations.name, "Unsorted"));
  if (loc) return loc.id;
  const [made] = await db.insert(schema.stockLocations).values({ name: "Unsorted" }).onConflictDoNothing().returning({ id: schema.stockLocations.id });
  if (made) return made.id;
  const [again] = await db.select({ id: schema.stockLocations.id }).from(schema.stockLocations).where(eq(schema.stockLocations.name, "Unsorted"));
  return again!.id;
}

/**
 * Make an item. Opening stock and returns start "to check"; received goods
 * are available. One movement row records it arriving. A repeated press with
 * the same request key returns the first item.
 */
export async function createItem(
  input: NewItem,
  actor: { name: string; profileId?: number | null },
  opts: { status: "to_check" | "available"; kind: string; requestKey?: string | null; jobId?: number | null; note?: string },
) {
  if (opts.requestKey) {
    const [seen] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.requestKey, opts.requestKey));
    if (seen) return { item: seen, reused: true };
  }
  if (!(input.qty > 0)) throw bad("Enter a quantity over 0.");
  if (input.unitCost != null && !(input.unitCost > 0)) throw bad('A stock cost is never $0. Leave it blank and tick "Cost unknown", or enter the cost.');
  const costStatus = input.unitCost == null ? "unknown" : (input.costStatus ?? "provisional");
  if (input.unit === "lm" && !(input.widthM && input.widthM > 0)) throw bad("Enter the roll width.");
  const [p] = await db.select({ id: schema.products.id, colour: schema.products.colour, supplierId: schema.products.supplierId }).from(schema.products).where(eq(schema.products.id, input.productId));
  if (!p) throw notFound("Product not found");
  const [row] = await db
    .insert(schema.stockItems)
    .values({
      code: `NEW-${crypto.randomUUID()}`,
      productId: input.productId,
      type: input.type,
      parentItemId: input.parentItemId ?? null,
      supplierId: input.supplierId ?? p.supplierId ?? null,
      supplierRollNo: input.supplierRollNo?.trim() ?? "",
      colour: input.colour?.trim() || p.colour || "",
      batch: input.batch?.trim() ? input.batch.trim() : null,
      locationId: input.locationId ?? (await defaultLocationId()),
      condition: input.condition ?? "good",
      status: opts.status,
      unit: input.unit,
      qty: cm(input.qty),
      originalQty: cm(input.qty),
      widthM: input.widthM ?? null,
      lengthSource: input.lengthSource ?? null,
      widthSource: input.widthSource ?? null,
      packSize: input.packSize ?? null,
      costPer: input.costPer ?? "unit",
      unitCost: input.unitCost ?? null,
      goodsCost: input.goodsCost ?? null,
      freightCost: input.freightCost ?? null,
      costStatus,
      purchaseCostNote: input.purchaseCostNote ?? "",
      poId: input.poId ?? null,
      poLineId: input.poLineId ?? null,
      boughtForJobId: input.boughtForJobId ?? null,
      originJobId: input.originJobId ?? null,
      costOnJobId: input.costOnJobId ?? null,
      terraOwned: input.terraOwned ?? true,
      madeOn: input.madeOn ?? null,
      expiresOn: input.expiresOn ?? null,
      receivedOn: todayLocal(),
      note: (input.note ?? "").slice(0, 1000),
      createdByName: actor.name,
      requestKey: opts.requestKey ?? null,
    })
    .returning();
  const [item] = await db.update(schema.stockItems).set({ code: itemCode(row!.id) }).where(eq(schema.stockItems.id, row!.id)).returning();
  await db.insert(schema.stockMovements).values({
    productId: item!.productId,
    stockItemId: item!.id,
    kind: opts.kind,
    qty: item!.qty,
    unit: item!.unit,
    balanceBefore: 0,
    balanceAfter: item!.qty,
    unitCostExGst: costPerItemUnit(item!),
    jobId: opts.jobId ?? input.originJobId ?? null,
    poId: input.poId ?? null,
    poLineId: input.poLineId ?? null,
    source: "office",
    note: opts.note ?? "",
    byProfileId: actor.profileId ?? null,
    byName: actor.name,
  });
  return { item: item!, reused: false };
}

/**
 * Change an item's quantity by `delta` and write the movement. The update
 * only lands if nobody changed the item in between, and never takes it below 0.
 */
export async function move(
  itemId: number,
  delta: number,
  kind: string,
  extra: {
    byName: string;
    byProfileId?: number | null;
    jobId?: number | null;
    reservationId?: number | null;
    poId?: number | null;
    poLineId?: number | null;
    note?: string;
    requestKey?: string | null;
    reversesId?: number | null;
    installerId?: number | null;
  },
) {
  if (extra.requestKey) {
    const [seen] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestKey, extra.requestKey));
    if (seen) return { movement: seen, reused: true };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const it = await itemById(itemId);
    const after = cm(it.qty + delta);
    if (after < -0.0001) throw bad(`Only ${r4(it.qty)} ${unitText(it.unit)} on ${it.code}.`);
    const [done] = await db
      .update(schema.stockItems)
      .set({ qty: Math.max(0, after), status: after <= 0.0001 && it.status === "available" ? "used_up" : it.status === "used_up" && after > 0 ? "available" : it.status, updatedAt: new Date() })
      .where(and(eq(schema.stockItems.id, it.id), eq(schema.stockItems.qty, it.qty)))
      .returning({ id: schema.stockItems.id });
    if (!done) continue;
    const [mv] = await db
      .insert(schema.stockMovements)
      .values({
        productId: it.productId,
        stockItemId: it.id,
        kind,
        qty: cm(delta),
        unit: it.unit,
        balanceBefore: it.qty,
        balanceAfter: Math.max(0, after),
        unitCostExGst: costPerItemUnit(it),
        jobId: extra.jobId ?? null,
        reservationId: extra.reservationId ?? null,
        poId: extra.poId ?? null,
        poLineId: extra.poLineId ?? null,
        installerId: extra.installerId ?? null,
        reversesId: extra.reversesId ?? null,
        source: "office",
        note: (extra.note ?? "").slice(0, 1000),
        byProfileId: extra.byProfileId ?? null,
        byName: extra.byName,
        requestKey: extra.requestKey ?? null,
      })
      .returning();
    return { movement: mv!, reused: false };
  }
  throw bad("Someone else just changed this stock item. Refresh and try again.");
}

/** A note-only movement (location or condition change). The quantity does not move. */
export async function noteMovement(it: Item, kind: string, note: string, actor: { name: string; profileId?: number | null }) {
  await db.insert(schema.stockMovements).values({
    productId: it.productId,
    stockItemId: it.id,
    kind,
    qty: 0,
    unit: it.unit,
    balanceBefore: it.qty,
    balanceAfter: it.qty,
    unitCostExGst: costPerItemUnit(it),
    source: "office",
    note,
    byProfileId: actor.profileId ?? null,
    byName: actor.name,
  });
}

/** Admin: a "to check" item becomes available. Needs a cost, or the cost-unknown tick. */
export async function approveItem(itemId: number, actor: PermActor) {
  await need(actor, "approve");
  const it = await itemById(itemId);
  if (it.status !== "to_check") throw bad(`${it.code} is not waiting to be checked.`);
  const [row] = await db
    .update(schema.stockItems)
    .set({ status: "available", approvedByName: actor.name, approvedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.stockItems.id, it.id), eq(schema.stockItems.status, "to_check")))
    .returning();
  await noteMovement(it, "approved", `Approved by ${actor.name}.${it.costStatus === "unknown" ? ` ${COST_UNKNOWN}.` : ""}`, actor);
  return row!;
}

/** Admin: put a wrong movement right with a new dated reversing row. The original stays. */
export async function reverseMovement(movementId: number, reason: string, actor: PermActor) {
  await need(actor, "correct");
  if (reason.trim().length < 3) throw bad("Say why it is being reversed.");
  const [mv] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.id, movementId));
  if (!mv) throw notFound("Movement not found");
  if (mv.reversesId) throw bad("That row is itself a reversal.");
  if (!mv.stockItemId) throw bad("That movement is not on a stock item.");
  const [already] = await db.select({ id: schema.stockMovements.id }).from(schema.stockMovements).where(eq(schema.stockMovements.reversesId, mv.id));
  if (already) throw bad("That movement has already been reversed.");
  const out = await move(mv.stockItemId, -mv.qty, "reversal", {
    byName: actor.name,
    byProfileId: actor.profileId,
    jobId: mv.jobId,
    reversesId: mv.id,
    note: `Reverses movement #${mv.id} (${mv.kind}): ${reason.trim().slice(0, 300)}`,
  });
  return out.movement;
}

export async function movementsOf(itemId: number) {
  return db.select().from(schema.stockMovements).where(eq(schema.stockMovements.stockItemId, itemId)).orderBy(desc(schema.stockMovements.id));
}

/* ------------------------------- boxed stock ------------------------------ */

/**
 * Open full boxes into loose full pieces. 1 box less, packSize loose more,
 * at the same cost per piece. Total quantity and cost are unchanged.
 */
export async function openBox(itemId: number, boxes: number, requestKey: string, actor: PermActor & { profileId: number | null }) {
  await need(actor, "handle");
  await needOn("s1");
  const box = await itemById(itemId);
  if (box.type !== "box_lot") throw bad(`${box.code} is not a box lot.`);
  if (!(box.packSize && box.packSize > 0)) throw bad(`Set the pieces per box on ${box.code} first.`);
  if (!Number.isInteger(boxes) || boxes < 1) throw bad("Open whole boxes only.");
  const { availableOn } = await import("./holds");
  if ((await availableOn(box.id)) < boxes - 0.0001) throw bad(`Only ${await availableOn(box.id)} box(es) on ${box.code} are free to open.`);
  const out = await move(box.id, -boxes, "open_box", { byName: actor.name, byProfileId: actor.profileId, requestKey: `${requestKey}:box`, note: `Opened ${boxes} box(es) into loose pieces.` });
  if (out.reused) {
    const [loose] = await db.select().from(schema.stockItems).where(and(eq(schema.stockItems.parentItemId, box.id), eq(schema.stockItems.type, "loose")));
    return { box: await itemById(box.id), loose: loose! };
  }
  const pieces = boxes * box.packSize;
  const perPiece = box.unitCost == null ? null : r4(box.unitCost / box.packSize);
  const [loose] = await db.select().from(schema.stockItems).where(and(eq(schema.stockItems.parentItemId, box.id), eq(schema.stockItems.type, "loose")));
  if (loose) {
    await move(loose.id, pieces, "open_box", { byName: actor.name, byProfileId: actor.profileId, requestKey: `${requestKey}:loose`, note: `From ${box.code}.` });
    return { box: await itemById(box.id), loose: await itemById(loose.id) };
  }
  const made = await createItem(
    {
      productId: box.productId,
      type: "loose",
      unit: "piece",
      qty: pieces,
      parentItemId: box.id,
      supplierId: box.supplierId,
      colour: box.colour,
      batch: box.batch,
      locationId: box.locationId,
      condition: box.condition,
      costPer: "unit",
      unitCost: perPiece,
      costStatus: box.costStatus as NewItem["costStatus"],
      note: `Loose full pieces from ${box.code}.`,
    },
    actor,
    { status: "available", kind: "open_box", requestKey: `${requestKey}:new`, note: `From ${box.code}.` },
  );
  return { box: await itemById(box.id), loose: made.item };
}

/** Part box back: only loose full pieces count. Short boards are never stock. */
export async function countLooseReturn(fullPieces: number, shortBoards: number) {
  if (!Number.isInteger(fullPieces) || fullPieces < 0) throw bad("Count whole pieces.");
  return { counted: fullPieces, notCounted: shortBoards, note: shortBoards > 0 ? `${shortBoards} short board(s) not counted as stock.` : "" };
}

/* ----------------------------- other item edits --------------------------- */

export async function setLocation(itemId: number, locationId: number, actor: PermActor & { profileId: number | null }) {
  await need(actor, "handle");
  const it = await itemById(itemId);
  const [loc] = await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, locationId));
  if (!loc) throw notFound("Location not found");
  await db.update(schema.stockItems).set({ locationId, updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
  await noteMovement(it, "move", `Moved to ${loc.name}.`, actor);
  return itemById(it.id);
}

export async function setCondition(itemId: number, condition: "good" | "damaged" | "quarantined" | "expired", note: string, actor: PermActor & { profileId: number | null }) {
  await need(actor, condition === "good" ? "correct" : "handle");
  const it = await itemById(itemId);
  if (it.condition === "opened") throw bad("An opened container stays internal use only.");
  await db.update(schema.stockItems).set({ condition, updatedAt: new Date() }).where(eq(schema.stockItems.id, it.id));
  await noteMovement(it, "condition", `Condition ${it.condition} to ${condition}. ${note}`.trim(), actor);
  return itemById(it.id);
}

export async function writeOff(itemId: number, qty: number, reason: string, actor: PermActor & { profileId: number | null }) {
  await need(actor, "correct");
  if (reason.trim().length < 3) throw bad("Say why it is being written off.");
  const { availableOn } = await import("./holds");
  if ((await availableOn(itemId)) < qty - 0.0001) throw bad("Part of that is held for an order. Release the hold first.");
  return (await move(itemId, -qty, "write_off", { byName: actor.name, byProfileId: actor.profileId, note: reason.trim() })).movement;
}

/** Admin with the "Change stock costs" tick only. A dated note goes on the item. */
export async function setItemCost(
  itemId: number,
  input: { unitCost: number | null; costStatus: "final" | "provisional" | "estimate" | "unknown"; note: string },
  actor: PermActor & { profileId: number | null },
) {
  const perms = await need(actor, "changeCosts");
  if (!perms.changeCosts) throw forbid("Only an Admin with Change stock costs can do this.");
  if (input.unitCost != null && !(input.unitCost > 0)) throw bad("A stock cost is never $0.");
  const it = await itemById(itemId);
  await db
    .update(schema.stockItems)
    .set({ unitCost: input.unitCost, costStatus: input.unitCost == null ? "unknown" : input.costStatus, updatedAt: new Date() })
    .where(eq(schema.stockItems.id, it.id));
  await noteMovement(
    it,
    "cost_adjust",
    `Cost ${it.unitCost == null ? "unknown" : money(it.unitCost)} to ${input.unitCost == null ? "unknown" : money(input.unitCost)} per ${it.costPer} on ${todayLocal()}. ${input.note}`.trim(),
    actor,
  );
  return itemById(it.id);
}

/* --------------------------------- counts --------------------------------- */

export async function recordCount(itemId: number, counted: number, actor: PermActor) {
  await need(actor, "handle");
  const it = await itemById(itemId);
  const status = Math.abs(cm(counted) - it.qty) < 0.005 ? "matched" : "pending";
  const [row] = await db.insert(schema.stockCounts).values({ stockItemId: it.id, expectedQty: it.qty, countedQty: cm(counted), status, byName: actor.name }).returning();
  return row!;
}

export async function approveCount(countId: number, actor: PermActor & { profileId: number | null }) {
  await need(actor, "correct");
  const [c] = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.id, countId));
  if (!c || c.status !== "pending") throw bad("That count is not waiting.");
  const it = await itemById(c.stockItemId);
  const delta = cm(c.countedQty - it.qty);
  const mv = await move(it.id, delta, "count_adjust", { byName: actor.name, byProfileId: actor.profileId, note: `Count by ${c.byName}: ${c.countedQty}, expected ${c.expectedQty}.` });
  await db.update(schema.stockCounts).set({ status: "approved", approvedByName: actor.name, movementId: mv.movement.id, updatedAt: new Date() }).where(eq(schema.stockCounts.id, c.id));
  return mv.movement;
}

/** Sum of item quantities by status, for the list. */
export async function itemsSummary() {
  return db.all<{ status: string; n: number }>(sql`select status, count(*) as n from stock_items group by status`);
}
