import { and, eq } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { bad, cm, COST_UNKNOWN, forbid, inheritBillFlag, money, need, needOn, notFound, type PermActor, productKind, r2, stockRules, unitText } from "./core";
import { stockCostLine } from "./costs";
import { holdById } from "./holds";
import { approveItem, costPerItemUnit, createItem, type Item, itemById, valueOf } from "./items";

/* ---------------------------------------------------------------------------
 * Returns and leftovers from our own jobs (v3 sections 5.3 to 5.5, S5).
 *
 *  unopened   Back at the original cost. On approval the job gets an
 *             internal "returned to stock" reversal. 30 out, 4 back: the
 *             job carries 26.
 *  opened     "Opened — internal use only. Cost already allocated to Job N."
 *             The first job keeps the full cost. Reissue adds $0. An
 *             approved cost move shifts an amount to the next job; the
 *             total never changes.
 *  leftover   Carpet 2.7 m or more, vinyl over 2 m, Terra-owned. Costed at
 *             the roll's own original rate (3 m x 2 m at $10/m² = $60).
 *             No cost known: "Cost unknown — review required", no credit.
 * Everything comes back "to check" and an Admin approves it. A credit is
 * written once per returned item, never twice.
 * ------------------------------------------------------------------------- */

type Actor = PermActor & { profileId: number | null };
export type ReturnKind = "unopened" | "opened" | "leftover";

async function jobNumber(jobId: number) {
  const [j] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return j?.number ?? jobId;
}

export async function returnFromJob(
  input: { holdId: number; kind: ReturnKind; qty: number; widthM?: number | null; terraOwned?: boolean; note?: string; requestKey: string },
  actor: Actor,
) {
  await need(actor, "handle");
  await needOn("s5");
  const key = input.requestKey.trim();
  if (key.length < 6) throw bad("Refresh the page and try again.");
  const [seen] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.requestKey, key));
  if (seen) return { stock: true, item: seen, reused: true, note: "" };
  const h = await holdById(input.holdId);
  if (!(h.collectedQty > 0) || !h.stockItemId) throw bad("Nothing has gone out to the job on this hold.");
  const [order] = h.orderId ? await db.select().from(schema.stockOrders).where(eq(schema.stockOrders.id, h.orderId)) : [];
  if (!(order?.kind === "job" || h.costOnPo)) throw bad("Returns here are for our own installation jobs.");
  const src = await itemById(h.stockItemId);
  const q = cm(input.qty);
  if (!(q > 0)) throw bad("Enter what came back.");
  const num = await jobNumber(h.jobId);
  const note = (input.note ?? "").trim().slice(0, 500);

  if (input.kind === "unopened") {
    if (src.unit === "lm") throw bad("A roll offcut is a leftover, not an unopened unit.");
    if (q > h.collectedQty + 0.0001) throw bad(`Only ${h.collectedQty} ${unitText(src.unit)} went out on this hold.`);
    if (src.condition === "opened") throw bad("This came from an opened container. Return it as opened.");
    const made = await createItem(
      {
        productId: src.productId,
        type: src.type === "loose" ? "loose" : src.type === "box_lot" ? "box_lot" : "unit_lot",
        unit: src.unit,
        qty: q,
        packSize: src.packSize,
        supplierId: src.supplierId,
        colour: src.colour,
        batch: src.batch,
        locationId: src.locationId,
        costPer: src.costPer as "unit",
        unitCost: src.unitCost,
        costStatus: src.costStatus as "final",
        purchaseCostNote: inheritBillFlag(src),
        parentItemId: src.id,
        originJobId: h.jobId,
        note: `Unopened, back from Job ${num} (hold #${h.id}). ${note}`.trim(),
      },
      actor,
      { status: "to_check", kind: "return", requestKey: key, jobId: h.jobId, note: `Unopened return from Job ${num}.` },
    );
    return { stock: true, item: made.item, reused: made.reused, note: "Waiting for Admin approval. The job is credited at the original cost when approved." };
  }

  if (input.kind === "opened") {
    if (src.unit === "lm") throw bad("A roll offcut is a leftover.");
    const costJob = src.condition === "opened" && src.costOnJobId ? src.costOnJobId : h.jobId;
    const per = costPerItemUnit(src);
    const made = await createItem(
      {
        productId: src.productId,
        type: "unit_lot",
        unit: src.unit,
        qty: q,
        packSize: src.packSize,
        supplierId: src.supplierId,
        colour: src.colour,
        batch: src.batch,
        locationId: src.locationId,
        condition: "opened",
        costPer: "unit",
        unitCost: src.unitCost,
        costStatus: src.costStatus as "final",
        purchaseCostNote: inheritBillFlag(src, per == null ? COST_UNKNOWN : `Original purchase cost ${money(per)} per ${unitText(src.unit) || "unit"}. Cost already allocated to Job ${await jobNumber(costJob)}.`),
        parentItemId: src.id,
        originJobId: h.jobId,
        costOnJobId: costJob,
        note: `Opened — internal use only. Cost already allocated to Job ${await jobNumber(costJob)}. Approximate quantity left. ${note}`.trim(),
      },
      actor,
      { status: "to_check", kind: "return", requestKey: key, jobId: h.jobId, note: `Opened container back from Job ${num}.` },
    );
    return { stock: true, item: made.item, reused: made.reused, note: "Opened — internal use only. No credit: the first job keeps the full cost." };
  }

  // Leftover carpet or vinyl.
  if (src.unit !== "lm") throw bad("Leftovers are carpet or vinyl cut from a roll.");
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, src.productId));
  const kind = productKind(p!);
  const rules = await stockRules();
  const width = input.widthM ?? src.widthM;
  if (!(width && width > 0)) throw bad("Enter the usable width.");
  const big = kind === "carpet" ? q >= rules.carpetKeepMinM - 0.0001 : kind === "vinyl" ? q > rules.vinylFreeMaxM + 0.0001 : false;
  if (!big || !input.terraOwned) {
    const why = !input.terraOwned ? "not ticked as Terra-owned" : kind === "carpet" ? `under ${rules.carpetKeepMinM} m` : kind === "vinyl" ? `${rules.vinylFreeMaxM} m or less` : "not carpet or vinyl";
    await db.insert(schema.activityLog).values({
      jobId: h.jobId,
      entityType: "job",
      entityId: h.jobId,
      action: "stock_leftover_not_stock",
      detail: `Leftover ${q} m x ${width} m of ${src.code} is not stock (${why}). ${note}`.trim(),
      actorName: actor.name,
      actorRole: actor.role,
    });
    return { stock: false, item: null, reused: false, note: `Not stock: ${why}. Recorded on the job.` };
  }
  const made = await createItem(
    {
      productId: src.productId,
      type: "remnant",
      unit: "lm",
      qty: q,
      widthM: width,
      lengthSource: "measured",
      widthSource: "measured",
      supplierId: src.supplierId,
      supplierRollNo: src.supplierRollNo,
      colour: src.colour,
      batch: src.batch,
      locationId: src.locationId,
      costPer: src.costPer as "lm" | "m2",
      unitCost: src.unitCost,
      costStatus: src.unitCost == null ? "unknown" : (src.costStatus as "final"),
      purchaseCostNote: inheritBillFlag(src),
      parentItemId: src.id,
      originJobId: h.jobId,
      terraOwned: true,
      note: `Leftover from Job ${num}, from ${src.code}. Terra-owned, not kept for the customer. ${note}`.trim(),
    },
    actor,
    { status: "to_check", kind: "return", requestKey: key, jobId: h.jobId, note: `Leftover from Job ${num}.` },
  );
  return { stock: true, item: made.item, reused: made.reused, note: made.item.unitCost == null ? `${COST_UNKNOWN}. No job credit until a cost is set.` : "Waiting for Admin approval." };
}

/** What a returned item credits its job. Opened containers never do; an unknown cost does not until it is set. */
export function returnCredit(it: Pick<Item, "condition" | "originJobId" | "unitCost" | "costPer" | "unit" | "widthM" | "qty" | "originalQty">) {
  if (!it.originJobId || it.condition === "opened") return { amount: 0, known: true };
  const v = valueOf(it, it.originalQty);
  return v == null ? { amount: 0, known: false } : { amount: v, known: true };
}

/** The internal "returned to stock" line, once per item. Only after approval and only with a known cost. */
export async function creditReturn(itemId: number) {
  const it = await itemById(itemId);
  if (it.status === "to_check") return { credited: false, note: "Not approved yet." };
  if (!it.originJobId || it.condition === "opened") return { credited: false, note: "No credit for this item." };
  const c = returnCredit(it);
  if (!c.known) return { credited: false, note: `${COST_UNKNOWN}. No job credit.` };
  const { row, reused } = await stockCostLine(
    it.originJobId,
    `return:${it.id}`,
    -c.amount,
    `Returned to stock: ${it.code}, ${it.originalQty} ${unitText(it.unit)}${it.widthM ? ` x ${it.widthM} m` : ""}`,
    `Internal only. At the original cost (${money(c.amount)}).`,
  );
  return { credited: !reused, note: reused ? "Already credited." : `Job credited ${money(c.amount)}.`, row };
}

/** Admin approves a returned item. It becomes available (opened ones stay internal use only) and the job is credited once. */
export async function approveReturn(itemId: number, actor: Actor) {
  const it = await approveItem(itemId, actor);
  const credit = await creditReturn(it.id);
  return { item: it, credit };
}

/**
 * Admin with "Change stock costs": move part of an opened container's cost
 * off the job that carries it. The next job to use it takes that amount.
 * $120 pail, $40 moved: first job $80, next job $40, total $120. Once per item.
 */
export async function moveOpenedCost(itemId: number, amount: number, reason: string, actor: Actor) {
  const perms = await need(actor, "changeCosts");
  if (!perms.changeCosts) throw forbid("Only an Admin with Change stock costs can do this.");
  if (reason.trim().length < 3) throw bad("Say why the cost is being moved.");
  const it = await itemById(itemId);
  if (it.condition !== "opened" || !it.costOnJobId) throw bad("Only an opened container with its cost on a job.");
  const a = r2(amount);
  if (!(a > 0)) throw bad("Enter an amount over $0.");
  const per = costPerItemUnit(it);
  if (per != null && a > r2(per * Math.max(1, it.originalQty)) + 0.005) throw bad(`That is more than the container cost (${money(per)}).`);
  const [seen] = await db.select().from(schema.jobCosts).where(eq(schema.jobCosts.stockRef, `costmove:${it.id}`));
  if (seen) return { moved: false, note: "A cost move was already approved on this item." };
  const [claimed] = await db
    .update(schema.stockItems)
    .set({ costCarry: a, updatedAt: new Date() })
    .where(and(eq(schema.stockItems.id, it.id), eq(schema.stockItems.costCarry, 0)))
    .returning();
  if (!claimed) throw bad("A cost move is already waiting on this item.");
  await stockCostLine(it.costOnJobId, `costmove:${it.id}`, -a, `Opened container ${it.code}: cost moved to remaining material`, `Approved by ${actor.name}: ${reason.trim().slice(0, 200)}. Total unchanged.`);
  await db.insert(schema.activityLog).values({
    entityType: "stock_item",
    entityId: it.id,
    action: "stock_cost_move",
    detail: `${money(a)} moved off Job ${await jobNumber(it.costOnJobId)} onto ${it.code}. The next job that uses it carries it.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { moved: true, note: "" };
}

export async function returnedItem(itemId: number) {
  const it = await itemById(itemId);
  if (!it.originJobId) throw notFound("Not a returned item.");
  return { item: it, credit: returnCredit(it) };
}
