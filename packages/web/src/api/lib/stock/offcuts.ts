import { and, asc, eq, inArray, like, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { isUnderlayCategory, rollLengthOf } from "../order-sizes";
import { BLOCKING, bad, cm, isOn, money, need, needOn, notFound, type PermActor, r2, r4, stockRules } from "./core";
import { stockAllocatedByMaterial } from "./costs";
import { afterChange, availableOn, holdById, holdsOnItem, outstanding } from "./holds";
import { createItem, itemCode, itemById, move } from "./items";

/* ---------------------------------------------------------------------------
 * Underlay offcuts (Damien, 20 Nov 2026, quote 188123 plan).
 *
 *  Job A orders 2 rolls and uses 1.25. The 9 m left over comes back as a
 *  "to check" remnant, costed at what Job A paid per m². When an Admin
 *  approves it, Job A gets a credit for it (approveReturn, return:<id>).
 *
 *  Job B needs the same underlay. Before its PO is drafted, Ops holds the
 *  offcut for it (pre-ticked, the office can untick). Job B carries the
 *  offcut's cost as a hold:<id> line, and the PO helper orders only the rest.
 *
 *  Offcuts under the keep size (2 m to start, Stock rules) are not stock.
 *  They get a note on the job and nothing else.
 *
 *  This never uses the warehouse order flow (S4, takeOut, allocate): an
 *  offcut is ours already, so there is no deposit or order to wait for.
 * ------------------------------------------------------------------------- */

type Actor = PermActor & { profileId: number | null };

const SYSTEM: Actor = { name: "Ops (automatic)", role: "admin", profileId: null, canSeeCosts: true, isMainAdmin: false };
const HOLD_BY = "Underlay offcut";
const UNTICK = "Unticked by office";
const KEY = "offcut:";
const REC = "ocrec:";

type Product = typeof schema.products.$inferSelect;
type Material = typeof schema.jobMaterials.$inferSelect;
type Shape = { unit: string; widthM: number; rollLenM: number };

const isOffcutHold = (h: { requestKey: string | null }) => !!h.requestKey?.startsWith(KEY);

/** Material quantity in metres off the roll. */
function toLm(q: number, s: Shape) {
  if (s.unit === "m2") return r4(q / s.widthM);
  if (s.unit === "roll") return r4(q * s.rollLenM);
  return q;
}
/** Metres off the roll back into the material's unit. */
function fromLm(lm: number, s: Shape) {
  if (s.unit === "m2") return r4(lm * s.widthM);
  if (s.unit === "roll") return r4(lm / s.rollLenM);
  return lm;
}

async function jobNumber(jobId: number) {
  const [j] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return j?.number ?? jobId;
}

/** Why an underlay material can't use offcuts, or its roll shape. */
function shapeOf(m: Material, p: Product | null): { shape: Shape | null; why: string } {
  if (!p || !isUnderlayCategory(p.category)) return { shape: null, why: "Not underlay." };
  if (m.saleLineId) return { shape: null, why: "Sell products order. Offcuts are for installation jobs." };
  if (!(p.widthM && p.widthM > 0)) return { shape: null, why: "No roll width in the price book." };
  const len = rollLengthOf(p);
  if (!len) return { shape: null, why: "No roll length in the price book." };
  if (!["m2", "lm", "roll"].includes(m.unit)) return { shape: null, why: `Priced per ${m.unit}, not by length.` };
  return { shape: { unit: m.unit, widthM: p.widthM, rollLenM: len }, why: "" };
}

/** Underlay materials on the job, with their product. */
async function underlayMaterials(jobId: number) {
  const rows = await db
    .select({ m: schema.jobMaterials, p: schema.products })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(eq(schema.jobMaterials.jobId, jobId))
    .orderBy(asc(schema.jobMaterials.id));
  return rows.filter((r) => r.p && isUnderlayCategory(r.p.category));
}

/** Live (not cancelled) PO lines for these materials. */
async function poLinesOf(materialIds: number[]) {
  if (!materialIds.length) return [];
  return db
    .select({ line: schema.purchaseOrderLines, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .where(and(inArray(schema.purchaseOrderLines.jobMaterialId, materialIds), ne(schema.purchaseOrders.status, "cancelled")));
}

async function openLinkOf(materialId: number) {
  const [l] = await db
    .select({ id: schema.stockPoLinks.id })
    .from(schema.stockPoLinks)
    .where(and(eq(schema.stockPoLinks.jobMaterialId, materialId), eq(schema.stockPoLinks.status, "open")));
  return l ?? null;
}

/** Offcuts of this product that are free to use now, with how much is free on each. */
async function freeOffcuts(productId: number) {
  const items = await db
    .select()
    .from(schema.stockItems)
    .where(and(eq(schema.stockItems.productId, productId), eq(schema.stockItems.type, "remnant"), eq(schema.stockItems.status, "available"), eq(schema.stockItems.condition, "good")))
    .orderBy(asc(schema.stockItems.id));
  const out: Array<{ item: (typeof items)[number]; free: number }> = [];
  for (const item of items) {
    const free = await availableOn(item.id);
    if (free > 0.005) out.push({ item, free });
  }
  return out;
}

/** Largest offcut that fits inside the need, or else the smallest one bigger than it. */
function pick<T extends { free: number }>(list: T[], needLm: number): T | null {
  const under = list.filter((o) => o.free <= needLm + 0.0001).sort((a, b) => b.free - a.free);
  if (under[0]) return under[0];
  const over = list.filter((o) => o.free > needLm).sort((a, b) => a.free - b.free);
  return over[0] ?? null;
}

/** The accepted quote's line for this product and unit, so the expected cost does not count the offcut twice. */
async function quoteLineFor(jobId: number, m: Material) {
  if (!m.productId) return { quoteId: null, quoteItemId: null };
  const { acceptedQuoteIdOf } = await import("../expected-costs");
  const quoteId = await acceptedQuoteIdOf(jobId);
  if (!quoteId) return { quoteId: null, quoteItemId: null };
  const [qi] = await db
    .select({ id: schema.quoteItems.id })
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.quoteId, quoteId), eq(schema.quoteItems.productId, m.productId), eq(schema.quoteItems.unit, m.unit)))
    .orderBy(asc(schema.quoteItems.id))
    .limit(1);
  return { quoteId, quoteItemId: qi?.id ?? null };
}

/** Does the hold fit, counting every blocking hold on the item oldest first. */
async function holdFits(holdId: number, itemId: number) {
  const it = await itemById(itemId);
  if (it.status !== "available") return false;
  let used = 0;
  for (const h of await holdsOnItem(itemId)) {
    if (!(BLOCKING as string[]).includes(h.status)) continue;
    used = cm(used + outstanding(h));
    if (h.id === holdId) return used <= it.qty + 0.0001;
  }
  return true;
}

/** What the material still needs after stock already held for it, in metres. */
async function needLmOf(jobId: number, m: Material, s: Shape) {
  const fromStock = (await stockAllocatedByMaterial(jobId)).get(m.id) ?? 0;
  return cm(Math.max(0, toLm(m.qty - fromStock, s)));
}

/**
 * Hold an offcut for a material. Takes what the job needs, or the whole
 * offcut when what would be left is under the keep size. Null when it no
 * longer fits (someone else took it first).
 */
async function placeHold(jobId: number, m: Material, s: Shape, itemId: number, requestKey: string, actor: Actor) {
  const [seen] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.requestKey, requestKey));
  if (seen) return seen;
  const needLm = await needLmOf(jobId, m, s);
  if (!(needLm > 0.005)) return null;
  const free = await availableOn(itemId);
  if (!(free > 0.005)) return null;
  const { underlayKeepMinM } = await stockRules();
  let holdLm = cm(Math.min(free, needLm));
  if (free - holdLm > 0.005 && free - holdLm < underlayKeepMinM) holdLm = free;
  const used = fromLm(Math.min(holdLm, needLm), s);
  const it = await itemById(itemId);
  const q = await quoteLineFor(jobId, m);
  const [h] = await db
    .insert(schema.stockReservations)
    .values({
      productId: it.productId,
      jobId,
      jobMaterialId: m.id,
      quoteId: q.quoteId,
      quoteItemId: q.quoteItemId,
      qty: holdLm,
      status: "reserved",
      confirmedAt: new Date(),
      confirmedByName: HOLD_BY,
      confirmNote: `Offcut ${it.code} for ${m.description}`.slice(0, 300),
      stockItemId: it.id,
      lineUnit: m.unit,
      orderedQty: used,
      billedQty: used,
      appliedByProfileId: actor.profileId,
      appliedByName: actor.name,
      requestKey,
    })
    .onConflictDoNothing()
    .returning();
  if (!h) {
    const [again] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.requestKey, requestKey));
    return again ?? null;
  }
  if (!(await holdFits(h.id, it.id))) {
    await db
      .update(schema.stockReservations)
      .set({ status: "cancelled", releasedAt: new Date(), releaseReason: "Someone else took this offcut first.", updatedAt: new Date() })
      .where(eq(schema.stockReservations.id, h.id));
    return null;
  }
  return h;
}

/**
 * Released by a person for this material and offcut (unticked here, or released
 * on the stock panel), so Ops does not tick it again. Damien, 20 Nov 2026.
 */
async function untickedPairs(jobId: number) {
  const rows = await db
    .select({ m: schema.stockReservations.jobMaterialId, i: schema.stockReservations.stockItemId })
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.jobId, jobId), eq(schema.stockReservations.status, "released"), like(schema.stockReservations.requestKey, `${KEY}%`)));
  return new Set(rows.map((r) => `${r.m}:${r.i}`));
}

/** Can Ops still change what this material orders: to order, not on a live PO or warehouse order. */
async function stillToOrder(m: Material) {
  if (m.status !== "to_order") return false;
  if ((await poLinesOf([m.id])).length) return false;
  return !(await openLinkOf(m.id));
}

/**
 * Ops holds the right offcuts for the job's underlay before anything is
 * ordered. Runs before every PO draft and when the job page opens. Quiet when
 * S1 is off. Never throws to the caller.
 */
export async function autoApplyOffcuts(jobId: number, actor: Actor = SYSTEM) {
  const applied: Array<{ holdId: number; materialId: number; code: string; lm: number }> = [];
  try {
    if (!(await isOn("s1"))) return { applied };
    const skip = await untickedPairs(jobId);
    for (const { m, p } of await underlayMaterials(jobId)) {
      const { shape } = shapeOf(m, p);
      if (!shape || !p || !(await stillToOrder(m))) continue;
      const tried = new Set<number>();
      for (let i = 0; i < 5; i++) {
        const needLm = await needLmOf(jobId, m, shape);
        if (!(needLm > 0.005)) break;
        const list = (await freeOffcuts(p.id)).filter((o) => !tried.has(o.item.id) && !skip.has(`${m.id}:${o.item.id}`));
        const o = pick(list, needLm);
        if (!o) break;
        tried.add(o.item.id);
        const h = await placeHold(jobId, m, shape, o.item.id, `${KEY}${m.id}:${o.item.id}`, actor);
        if (h && h.status === "reserved") applied.push({ holdId: h.id, materialId: m.id, code: o.item.code, lm: h.qty });
      }
    }
    if (applied.length) await afterChange(jobId);
  } catch (e) {
    console.error("[offcuts] auto apply failed:", (e as Error).message);
  }
  return { applied };
}

/** The office ticks an offcut again (or picks a different one) for a material. */
export async function useOffcut(input: { jobMaterialId: number; itemId: number }, actor: Actor) {
  await need(actor, "allocate");
  await needOn("s1");
  const [row] = await db
    .select({ m: schema.jobMaterials, p: schema.products })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(eq(schema.jobMaterials.id, input.jobMaterialId));
  if (!row) throw notFound("Material not found");
  const { shape, why } = shapeOf(row.m, row.p);
  if (!shape) throw bad(why);
  if (!(await stillToOrder(row.m))) throw bad("This material is already ordered, so an offcut can't change it now.");
  const it = await itemById(input.itemId);
  if (it.productId !== row.m.productId || it.type !== "remnant") throw bad("That offcut is a different product.");
  if (!(await needLmOf(row.m.jobId, row.m, shape) > 0.005)) throw bad("This material is already fully covered.");
  const h = await placeHold(row.m.jobId, row.m, shape, it.id, `${KEY}${row.m.id}:${it.id}:${Date.now()}`, actor);
  if (!h) throw bad(`${it.code} is no longer free. Refresh the page.`);
  await afterChange(row.m.jobId);
  return h;
}

/** The office unticks an offcut. Only before anything is ordered around it or taken out. */
export async function undoOffcut(holdId: number, actor: Actor) {
  await need(actor, "allocate");
  const h = await holdById(holdId);
  if (!isOffcutHold(h)) throw bad("That is not an offcut hold.");
  if (h.status !== "reserved" || h.collectedQty > 0) throw bad("This offcut has already gone to the job.");
  if (h.jobMaterialId) {
    const [l] = await poLinesOf([h.jobMaterialId]);
    if (l) throw bad(`This material is on PO ${l.number}, which was worked out with the offcut. Remove that PO line first, then untick.`);
  }
  await db
    .update(schema.stockReservations)
    .set({ status: "released", releasedAt: new Date(), releaseReason: `${UNTICK}: ${actor.name}`, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "reserved")));
  await afterChange(h.jobId);
  return holdById(h.id);
}

/** The offcut has gone out to the job. Takes it off the stock and makes the job's cost actual. */
export async function issueOffcut(holdId: number, actor: Actor) {
  await need(actor, "handle");
  const h = await holdById(holdId);
  if (!isOffcutHold(h) || !h.stockItemId) throw bad("That is not an offcut hold.");
  if (h.status === "issued") return h;
  if (h.status !== "reserved") throw bad("This offcut is no longer held for the job.");
  const it = await itemById(h.stockItemId);
  const qty = outstanding(h);
  await move(it.id, -qty, "issue", {
    byName: actor.name,
    byProfileId: actor.profileId,
    jobId: h.jobId,
    reservationId: h.id,
    requestKey: `offcut-issue:${h.id}`,
    note: `Underlay offcut taken to Job ${await jobNumber(h.jobId)}`,
  });
  await db
    .update(schema.stockReservations)
    .set({ collectedQty: cm(h.collectedQty + qty), status: "issued", updatedAt: new Date() })
    .where(eq(schema.stockReservations.id, h.id));
  // Damien, 20 Nov 2026: a line the offcuts cover in full, with nothing ordered, is now on site.
  if (h.jobMaterialId) {
    const [m] = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.id, h.jobMaterialId));
    if (m && m.status === "to_order" && !(await poLinesOf([m.id])).length) {
      const gone = await db
        .select({ q: schema.stockReservations.orderedQty })
        .from(schema.stockReservations)
        .where(and(eq(schema.stockReservations.jobMaterialId, m.id), eq(schema.stockReservations.status, "issued"), like(schema.stockReservations.requestKey, `${KEY}%`)));
      if (gone.reduce((s, r) => s + (r.q ?? 0), 0) >= m.qty - 0.001) {
        await db.update(schema.jobMaterials).set({ status: "on_site" }).where(and(eq(schema.jobMaterials.id, m.id), eq(schema.jobMaterials.status, "to_order")));
      }
    }
  }
  await afterChange(h.jobId);
  return holdById(h.id);
}

/** What Job A paid per m² for the material: its PO line, else the price book. Null when unknown. */
async function costPerM2(m: Material, p: Product, s: Shape) {
  const [l] = (await poLinesOf([m.id])).filter((r) => r.line.unitCostExGst > 0);
  if (l) {
    const u = l.line.unit;
    const c = l.line.unitCostExGst;
    const per = u === "m2" ? c : u === "lm" ? c / s.widthM : u === "roll" ? c / (s.rollLenM * s.widthM) : null;
    if (per && per > 0) return { cost: r4(per), from: `PO ${l.number}` };
  }
  const book =
    p.unit === "m2" && p.costPrice ? p.costPrice : p.unit === "lm" && p.costPrice ? p.costPrice / s.widthM : p.rollPrice ? p.rollPrice / (s.rollLenM * s.widthM) : null;
  if (book && book > 0) return { cost: r4(book), from: "price book" };
  return { cost: null, from: "" };
}

/** Metres that can still come back off this material: what was bought, rounded to whole rolls, less offcuts already recorded. */
async function capLm(m: Material, s: Shape) {
  const lines = await poLinesOf([m.id]);
  const poLm = lines.reduce((sum, l) => sum + toLm(l.line.qty, { ...s, unit: l.line.unit }), 0);
  const matLm = toLm(m.qty, s);
  const rolled = Math.ceil(r4(matLm / s.rollLenM) - 1e-9) * s.rollLenM;
  const recorded = await db.select({ q: schema.stockItems.originalQty }).from(schema.stockItems).where(like(schema.stockItems.requestKey, `${REC}${m.id}:%`));
  return cm(Math.max(poLm, rolled) - recorded.reduce((sum, r) => sum + r.q, 0));
}

/**
 * The crew or office says an underlay offcut came back from a job. 2 m or
 * more becomes a "to check" remnant for an Admin to approve; less is a note.
 */
export async function recordUnderlayOffcut(
  input: { jobMaterialId: number; metres: number; widthM?: number | null; locationId?: number | null; note?: string; requestKey: string },
  actor: Actor,
) {
  await need(actor, "handle");
  await needOn("s1");
  const key = `${REC}${input.jobMaterialId}:${input.requestKey.trim()}`;
  const [seen] = await db.select().from(schema.stockItems).where(eq(schema.stockItems.requestKey, key));
  if (seen) return { stock: true, item: seen, note: "Already recorded." };
  const [row] = await db
    .select({ m: schema.jobMaterials, p: schema.products })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(eq(schema.jobMaterials.id, input.jobMaterialId));
  if (!row) throw notFound("Material not found");
  const { m, p } = row;
  const { shape, why } = shapeOf(m, p);
  if (!shape || !p) throw bad(why);
  const metres = cm(input.metres);
  if (!(metres > 0)) throw bad("Enter the metres that came back.");
  const cap = await capLm(m, shape);
  if (metres > cap + 0.0001) throw bad(cap > 0 ? `Only ${cap} m could be left over on this material.` : "Every offcut from this material is already recorded.");
  const width = input.widthM && input.widthM > 0 ? input.widthM : shape.widthM;
  if (width > shape.widthM + 0.0001) throw bad(`The roll is only ${shape.widthM} m wide.`);
  const num = await jobNumber(m.jobId);
  const note = (input.note ?? "").trim().slice(0, 500);
  const { underlayKeepMinM } = await stockRules();

  if (metres < underlayKeepMinM) {
    await db.insert(schema.activityLog).values({
      jobId: m.jobId,
      entityType: "job",
      entityId: m.jobId,
      action: "stock_leftover_not_stock",
      detail: `${metres} m of ${m.description} left over. Under ${underlayKeepMinM} m, so not kept as stock.${note ? ` ${note}` : ""}`.slice(0, 1000),
      actorName: actor.name,
      actorRole: actor.role,
    });
    return { stock: false, item: null, note: `Under ${underlayKeepMinM} m, so it is not kept as stock. A note is on the job.` };
  }

  const c = await costPerM2(m, p, shape);
  const made = await createItem(
    {
      productId: p.id,
      type: "remnant",
      unit: "lm",
      qty: metres,
      widthM: width,
      lengthSource: "measured",
      widthSource: "measured",
      supplierId: p.supplierId,
      locationId: input.locationId ?? null,
      costPer: "m2",
      unitCost: c.cost,
      costStatus: c.cost == null ? "unknown" : "provisional",
      originJobId: m.jobId,
      terraOwned: true,
      note: [`Underlay offcut from Job ${num}.`, c.cost != null ? `${money(c.cost)}/m² from the ${c.from}.` : "", note].filter(Boolean).join(" "),
    },
    actor,
    { status: "to_check", kind: "return", requestKey: key, jobId: m.jobId, note: `Underlay offcut back from Job ${num}` },
  );
  const credit = c.cost != null ? r2(c.cost * metres * width) : null;
  return {
    stock: true,
    item: made.item,
    note: credit != null ? `${made.item.code} is waiting for Admin approval. Job ${num} then gets ${money(credit)} back.` : `${made.item.code} is waiting for Admin approval. The cost is unknown, so no credit until it is set.`,
  };
}

/** The job page view: per underlay material, the offcuts held for it, the ones it could use, and the ones that came back from it. */
export async function offcutsForJob(jobId: number) {
  const rows = await underlayMaterials(jobId);
  const { underlayKeepMinM } = await stockRules();
  const on = await isOn("s1");
  const holds = await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.jobId, jobId), like(schema.stockReservations.requestKey, `${KEY}%`)));
  const lines = await poLinesOf(rows.map((r) => r.m.id));
  const out = [];
  for (const { m, p } of rows) {
    const { shape, why } = shapeOf(m, p);
    const mine = holds.filter((h) => h.jobMaterialId === m.id && (h.status === "reserved" || h.status === "issued"));
    const po = lines.find((l) => l.line.jobMaterialId === m.id);
    const held = [];
    for (const h of mine) {
      const it = await itemById(h.stockItemId!);
      held.push({
        holdId: h.id,
        itemId: it.id,
        code: it.code,
        metres: h.qty,
        covers: h.orderedQty ?? 0,
        status: h.status,
        // The PO was worked out with the offcut, so it can't be unticked from here (undoOffcut says why).
        canUndo: h.status === "reserved" && h.collectedQty === 0 && !po,
        canIssue: h.status === "reserved",
        text: `${h.qty} m offcut ${it.code}${h.status === "issued" ? ", taken to the job" : ""}`,
      });
    }
    const open = !!shape && (await stillToOrder(m));
    const needLm = shape ? await needLmOf(jobId, m, shape) : 0;
    const usedIds = new Set(mine.map((h) => h.stockItemId));
    const could = shape && open && on && needLm > 0.005 ? (await freeOffcuts(p!.id)).filter((o) => !usedIds.has(o.item.id)).map((o) => ({ itemId: o.item.id, code: o.item.code, free: o.free })) : [];
    const back = await db
      .select()
      .from(schema.stockItems)
      .where(like(schema.stockItems.requestKey, `${REC}${m.id}:%`))
      .orderBy(asc(schema.stockItems.id));
    out.push({
      materialId: m.id,
      eligible: !!shape,
      why,
      unit: m.unit,
      widthM: shape?.widthM ?? null,
      rollLenM: shape?.rollLenM ?? null,
      open,
      onPo: po ? po.number : null,
      needM: needLm,
      held,
      could,
      back: back.map((it) => ({ itemId: it.id, code: it.code ?? itemCode(it.id), metres: it.originalQty, status: it.status, toCheck: it.status === "to_check" })),
    });
  }
  return { on, keepMinM: underlayKeepMinM, materials: out };
}
