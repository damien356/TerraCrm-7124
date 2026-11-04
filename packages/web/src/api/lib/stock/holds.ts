import { and, asc, eq, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { BLOCKING, bad, cm, ENDED, FIRM, type HoldStage, inheritBillFlag, need, needOn, notFound, type PermActor, r4, stockRules, unitText, WAITING } from "./core";
import { createItem, costPerItemUnit, type Item, itemById, move } from "./items";
import { depositState, ensureOrder, orderById, type OrderKind, switchFor } from "./orders";

/* ---------------------------------------------------------------------------
 * Holds and reservations (v3 section 4, A1.2, clarification 1).
 *
 * Several holds can sit on one roll: a 25 m roll with 5 m held for A and
 * 7 m for B has 13 m free before anything is cut. The holds that block the
 * stock (temporary, reserved, cut, picked) never add up to more than the
 * item's quantity. A hold is checked after it is written, oldest first, so
 * when two people hold the same stock at once the first one in wins and the
 * second is turned down. "One reservation per piece" means one hold per
 * order line per item, never one customer per roll.
 *
 * Quantities on a hold:
 *   qty           what is held, in the item's unit (free part included)
 *   collectedQty  handed over or issued so far, in the item's unit
 *   orderedQty    what the customer ordered from this piece, in the line's unit
 *   billedQty     what is billed, in the line's unit (never changed by a free part)
 *   freeQty       free remainder, in the item's unit
 * ------------------------------------------------------------------------- */

export type Hold = typeof schema.stockReservations.$inferSelect;
type Actor = PermActor & { profileId: number | null };

export const outstanding = (h: Pick<Hold, "qty" | "collectedQty">) => cm(Math.max(0, h.qty - h.collectedQty));

export async function holdById(id: number) {
  const [h] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.id, id));
  if (!h) throw notFound("Hold not found");
  return h;
}

export async function holdsOnItem(itemId: number) {
  return db.select().from(schema.stockReservations).where(eq(schema.stockReservations.stockItemId, itemId)).orderBy(asc(schema.stockReservations.id));
}
export async function holdsOfOrder(orderId: number) {
  return db.select().from(schema.stockReservations).where(eq(schema.stockReservations.orderId, orderId)).orderBy(asc(schema.stockReservations.id));
}

/** Can the item be used for customers at all. Opened containers only go to our own jobs. */
export function usable(it: Item, forJob: boolean) {
  if (it.status !== "available") return false;
  if (it.condition === "good") return true;
  return forJob && it.condition === "opened";
}

/** Free on the item: its quantity less every blocking hold still to come off it. */
export async function availableOn(itemId: number, exceptHoldId?: number) {
  const it = await itemById(itemId);
  if (it.status !== "available") return 0;
  const held = (await holdsOnItem(itemId))
    .filter((h) => h.id !== exceptHoldId && (BLOCKING as string[]).includes(h.status))
    .reduce((s, h) => s + outstanding(h), 0);
  return cm(Math.max(0, it.qty - held));
}

/**
 * After a blocking hold is written: does it fit, counting every blocking hold
 * on the item oldest first? The later of two clashing holds is the one that
 * does not fit.
 */
async function fits(holdId: number, itemId: number) {
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

/** Every blocking hold on the item together fits. Used when a waiting hold is made firm: if two firm at once and overrun, the one checking backs off. */
async function totalFits(itemId: number) {
  const it = await itemById(itemId);
  if (it.status !== "available") return false;
  const used = (await holdsOnItem(itemId)).filter((h) => (BLOCKING as string[]).includes(h.status)).reduce((s, h) => cm(s + outstanding(h)), 0);
  return used <= it.qty + 0.0001;
}

/** An item quantity in the order line's unit (a vinyl roll in lm, billed in m²). */
export function toLine(it: Pick<Item, "unit" | "widthM">, q: number, lineUnit: string | null) {
  if (lineUnit === "m2" && it.unit === "lm") return r4(q * (it.widthM ?? 0));
  return r4(q);
}
export function fromLine(it: Pick<Item, "unit" | "widthM">, q: number, lineUnit: string | null) {
  if (lineUnit === "m2" && it.unit === "lm") return it.widthM ? cm(q / it.widthM) : q;
  return cm(q);
}

const lineMatch = (a: Pick<Hold, "quoteItemId" | "saleLineId" | "jobMaterialId">, b: Pick<Hold, "quoteItemId" | "saleLineId" | "jobMaterialId">) =>
  (a.quoteItemId != null && a.quoteItemId === b.quoteItemId) ||
  (a.saleLineId != null && a.saleLineId === b.saleLineId) ||
  (a.jobMaterialId != null && a.jobMaterialId === b.jobMaterialId);

/** A batch match needs both batches known and equal. Two unknowns never match. */
export const sameBatch = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export type AllocateInput = {
  jobId: number;
  /** Null: wanted from stock but none on the shelf yet ("to come in"). */
  itemId: number | null;
  /** What the customer ordered from this piece, in the line's unit. */
  orderedQty: number;
  lineUnit: string;
  billedQty?: number | null;
  productId?: number | null;
  quoteItemId?: number | null;
  saleLineId?: number | null;
  jobMaterialId?: number | null;
  temporary?: boolean;
  /** Office approved a different or unknown batch on the same line. */
  batchApproved?: boolean;
  requestKey: string;
};

/**
 * Choose stock for an order line. The stage follows the order:
 *   not accepted       planned (or temporary if asked)
 *   awaiting deposit   awaiting (or temporary if asked)
 *   deposit confirmed  reserved, firm straight away
 */
export async function allocate(input: AllocateInput, actor: Actor) {
  await need(actor, "allocate");
  const key = input.requestKey.trim();
  if (key.length < 6) throw bad("Refresh the page and try again.");
  const [seen] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.requestKey, key));
  if (seen) return { hold: seen, reused: true, warning: "" };
  if (!(input.orderedQty > 0)) throw bad("Enter a quantity over 0.");

  const order = await ensureOrder(input.jobId);
  await needOn(switchFor(order.kind as OrderKind));
  if (order.status === "cancelled" || order.status === "review") throw bad("This order is cancelled or under review. Sort it out before choosing stock.");
  const forJob = order.kind === "job";
  const dep = await depositState(order);
  const firmNow = order.status === "active" && dep.code === "confirmed";

  let it: Item | null = null;
  let qty = cm(input.orderedQty);
  let productId = input.productId ?? null;
  if (input.itemId != null) {
    it = await itemById(input.itemId);
    if (!usable(it, forJob)) throw bad(it.condition === "opened" ? "Opened — internal use only. It can only go to our own jobs." : `${it.code} is not available (${it.status}, ${it.condition}).`);
    if (productId != null && it.productId !== productId) throw bad(`${it.code} is a different product.`);
    productId = it.productId;
    if (input.lineUnit === "m2" && it.unit === "lm" && !it.widthM) throw bad(`${it.code} has no width.`);
    qty = fromLine(it, input.orderedQty, input.lineUnit);
  }
  if (productId == null) throw bad("Pick the product.");

  const mine = (await holdsOfOrder(order.id)).filter((h) => !(ENDED as string[]).includes(h.status));
  const line = { quoteItemId: input.quoteItemId ?? null, saleLineId: input.saleLineId ?? null, jobMaterialId: input.jobMaterialId ?? null };
  if (it && mine.some((h) => h.stockItemId === it!.id && lineMatch(h, line))) throw bad(`${it.code} is already allocated to this line. Change that hold instead.`);
  if (it && !input.batchApproved) {
    for (const h of mine.filter((h) => h.stockItemId && h.stockItemId !== it!.id && lineMatch(h, line))) {
      const other = await itemById(h.stockItemId!);
      if (!sameBatch(other.batch, it.batch)) throw bad(`Batch differs from ${other.code} on the same line (or is unknown). Tick "Batch approved" to go ahead.`);
    }
  }

  const stage: HoldStage = !it ? "short" : firmNow ? "reserved" : input.temporary ? "temporary" : order.status === "planned" ? "planned" : "awaiting";
  const blocking = (BLOCKING as string[]).includes(stage);
  let warning = "";
  if (it) {
    const free = await availableOn(it.id);
    if (free < qty - 0.0001) {
      if (blocking) throw bad(`Only ${free} ${unitText(it.unit)} free on ${it.code}.`);
      warning = `Only ${free} ${unitText(it.unit)} free on ${it.code} right now. It is not held until the deposit is confirmed or a temporary hold is applied.`;
    }
  }
  const rules = await stockRules();
  const [row] = await db
    .insert(schema.stockReservations)
    .values({
      productId,
      jobId: input.jobId,
      orderId: order.id,
      stockItemId: it?.id ?? null,
      ...line,
      quoteId: null,
      qty,
      lineUnit: input.lineUnit,
      orderedQty: r4(input.orderedQty),
      billedQty: input.billedQty ?? r4(input.orderedQty),
      status: stage,
      expiresAt: stage === "temporary" ? new Date(Date.now() + rules.holdHours * 3600_000) : null,
      confirmedAt: stage === "reserved" ? new Date() : null,
      confirmedByName: stage === "reserved" ? "Deposit already confirmed" : null,
      appliedByProfileId: actor.profileId,
      appliedByName: actor.name,
      requestKey: key,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { hold: (await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.requestKey, key)))[0]!, reused: true, warning: "" };
  if (blocking && it && !(await fits(row.id, it.id))) {
    await db
      .update(schema.stockReservations)
      .set({ status: "cancelled", releaseReason: "Someone else held it first.", releasedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.stockReservations.id, row.id));
    throw bad(`Someone else just held stock on ${it.code}. Refresh and pick again.`);
  }
  if (it && order.kind !== "job") {
    const { proposeFree } = await import("./remainders");
    await proposeFree(row.id);
  }
  const flags = await afterChange(input.jobId);
  return { hold: await holdById(row.id), reused: false, warning: [warning, ...flags].filter(Boolean).join(" ") };
}

/** Costs and the PO helper follow the holds. Never throws into the caller. */
export async function afterChange(jobId: number): Promise<string[]> {
  try {
    const { syncStockCosts } = await import("./costs");
    await syncStockCosts(jobId);
  } catch (e) {
    console.error("[stock] cost sync failed:", (e as Error).message);
  }
  try {
    const { flagPoOverlap } = await import("./costs");
    return await flagPoOverlap(jobId);
  } catch (e) {
    console.error("[stock] PO overlap check failed:", (e as Error).message);
    return [];
  }
}

/**
 * Make a waiting hold firm. A temporary hold converts in place (it was
 * already holding). A planned or awaiting one is checked: whatever is not
 * free becomes a short row, never shown as reserved.
 */
export async function firmHold(h: Hold, byName: string): Promise<{ firmed: number; short: number }> {
  if (!(WAITING as string[]).includes(h.status)) return { firmed: 0, short: 0 };
  const stamp = { confirmedAt: new Date(), confirmedByName: byName, updatedAt: new Date() };
  if (h.status === "temporary") {
    const [done] = await db
      .update(schema.stockReservations)
      .set({ status: "reserved", expiresAt: null, ...stamp })
      .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "temporary")))
      .returning();
    return { firmed: done ? 1 : 0, short: 0 };
  }
  if (!h.stockItemId) return { firmed: 0, short: 0 };
  const it = await itemById(h.stockItemId);
  const order = h.orderId ? await orderById(h.orderId) : null;
  const free = usable(it, order?.kind === "job") ? await availableOn(it.id, h.id) : 0;
  if (free >= h.qty - 0.0001) {
    const [done] = await db
      .update(schema.stockReservations)
      .set({ status: "reserved", ...stamp })
      .where(and(eq(schema.stockReservations.id, h.id), inArray(schema.stockReservations.status, ["planned", "awaiting"])))
      .returning();
    if (!done) return { firmed: 0, short: 0 };
    if (await totalFits(it.id)) return { firmed: 1, short: 0 };
    // Lost a race to another hold: back to waiting, the next check makes it short.
    await db.update(schema.stockReservations).set({ status: "awaiting", confirmedAt: null, confirmedByName: null }).where(eq(schema.stockReservations.id, h.id));
    return { firmed: 0, short: 0 };
  }
  // Not enough free. Firm what there is, the rest is short.
  const part = cm(Math.max(0, free));
  const lineTotal = h.orderedQty ?? toLine(it, h.qty, h.lineUnit);
  const linePart = part > 0 ? toLine(it, part, h.lineUnit) : 0;
  const lineShort = r4(Math.max(0, lineTotal - linePart));
  if (part > 0) {
    const [done] = await db
      .update(schema.stockReservations)
      .set({ status: "reserved", qty: part, orderedQty: linePart, billedQty: linePart, freeQty: 0, freeState: h.freeState === "approved" ? "declined" : h.freeState, ...stamp })
      .where(and(eq(schema.stockReservations.id, h.id), inArray(schema.stockReservations.status, ["planned", "awaiting"])))
      .returning();
    if (!done) return { firmed: 0, short: 0 };
    if (!(await totalFits(it.id))) {
      await db.update(schema.stockReservations).set({ status: "awaiting", qty: h.qty, orderedQty: h.orderedQty, billedQty: h.billedQty, confirmedAt: null, confirmedByName: null }).where(eq(schema.stockReservations.id, h.id));
      return { firmed: 0, short: 0 };
    }
    await db.insert(schema.stockReservations).values({
      productId: h.productId,
      jobId: h.jobId,
      orderId: h.orderId,
      quoteItemId: h.quoteItemId,
      saleLineId: h.saleLineId,
      jobMaterialId: h.jobMaterialId,
      stockItemId: null,
      qty: lineShort,
      lineUnit: h.lineUnit,
      orderedQty: lineShort,
      billedQty: lineShort,
      status: "short",
      confirmNote: `Short: only ${part} ${unitText(it.unit)} free on ${it.code}.`,
      appliedByName: byName,
      requestKey: `short-of:${h.id}`,
    }).onConflictDoNothing();
    return { firmed: 1, short: lineShort };
  }
  const [done] = await db
    .update(schema.stockReservations)
    .set({ status: "short", stockItemId: null, qty: lineTotal, confirmNote: `Short: ${it.code} has nothing free.`, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), inArray(schema.stockReservations.status, ["planned", "awaiting"])))
    .returning();
  return { firmed: 0, short: done ? lineTotal : 0 };
}

/* ----------------------------- temporary holds ---------------------------- */

export async function extendHold(holdId: number, reason: string, actor: Actor) {
  await need(actor, "allocate");
  if (reason.trim().length < 3) throw bad("Say why the hold is being extended.");
  const h = await holdById(holdId);
  if (h.status !== "temporary") throw bad("Only a temporary hold can be extended.");
  const rules = await stockRules();
  const [row] = await db
    .update(schema.stockReservations)
    .set({
      expiresAt: new Date(Date.now() + rules.holdHours * 3600_000),
      warnedAt: null,
      extendReason: `${h.extendReason ? `${h.extendReason}\n` : ""}${new Date().toISOString()} ${actor.name}: ${reason.trim().slice(0, 300)}`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "temporary")))
    .returning();
  return row!;
}

/**
 * Temporary holds past their time stop holding. The stock is released only:
 * the hold goes back to planned or awaiting, and the quote, invoice and
 * order are not touched. Firm, paid and cut holds are never timed out.
 */
export async function expireHolds(now = new Date()) {
  const due = await db
    .select()
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.status, "temporary"), isNotNull(schema.stockReservations.expiresAt), lte(schema.stockReservations.expiresAt, now)));
  let n = 0;
  for (const h of due) {
    const order = h.orderId ? await orderById(h.orderId) : null;
    const [done] = await db
      .update(schema.stockReservations)
      .set({ status: order?.status === "planned" ? "planned" : "awaiting", releaseReason: "Temporary hold expired. Stock released, quote and invoice unchanged.", releasedAt: now, updatedAt: now })
      .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "temporary")))
      .returning();
    if (done) n += 1;
  }
  return n;
}

export const brisbane = (d: Date) =>
  d.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** The warning before a temporary hold ends, to the office (Damien) and naming who applied it. Once per hold. */
export async function warnHolds(now = new Date()) {
  const rules = await stockRules();
  const soon = new Date(now.getTime() + rules.warnHours * 3600_000);
  const due = await db
    .select()
    .from(schema.stockReservations)
    .where(and(eq(schema.stockReservations.status, "temporary"), isNotNull(schema.stockReservations.expiresAt), lte(schema.stockReservations.expiresAt, soon)));
  const { stockAlert } = await import("./alerts");
  let n = 0;
  for (const h of due) {
    if (h.warnedAt) continue;
    const [claimed] = await db
      .update(schema.stockReservations)
      .set({ warnedAt: now, updatedAt: now })
      .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "temporary")))
      .returning();
    if (!claimed) continue;
    const it = h.stockItemId ? await itemById(h.stockItemId) : null;
    await stockAlert(`hold-warn:${h.id}:${h.expiresAt!.getTime()}`, "stock_hold_expiring", {
      orderId: h.orderId,
      jobId: h.jobId,
      title: `Temporary hold ends ${brisbane(h.expiresAt!)}`,
      body: `${it?.code ?? "Stock"}: ${h.qty} ${unitText(it?.unit)} held by ${h.appliedByName ?? "someone"}. It ends ${brisbane(h.expiresAt!)} Brisbane time. Extend it with a reason, or let it go. For ${h.appliedByName ?? "the person who applied it"} and Damien.`,
    });
    n += 1;
  }
  return n;
}

/* ------------------------------ release, cut ------------------------------ */

export async function releaseHold(holdId: number, reason: string, actor: Actor) {
  await need(actor, "allocate");
  if (reason.trim().length < 3) throw bad("Say why the hold is being released.");
  const h = await holdById(holdId);
  // A2: a "short" row holds nothing, but it is demand on the Reorder list. It
  // can be withdrawn when the job no longer needs it, unless it is on a
  // warehouse order. A sent order is never changed from here.
  const shortRow = h.status === "short";
  if (!shortRow && ((ENDED as string[]).includes(h.status) || h.status === "handed_over" || h.status === "issued")) throw bad("That hold is already finished.");
  if (h.collectedQty > 0) throw bad("Part of it has gone out. Hand over or return the rest instead.");
  if (shortRow) {
    const [l] = await db
      .select({ number: schema.purchaseOrders.number, status: schema.purchaseOrders.status })
      .from(schema.stockPoLinks)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.stockPoLinks.poId))
      .where(and(eq(schema.stockPoLinks.reservationId, h.id), eq(schema.stockPoLinks.status, "open")));
    if (l?.status === "draft") throw bad(`This shortage is on draft ${l.number}. Take it off that draft on the Reorder list first.`);
    if (l) throw bad(`This shortage is on ${l.number}, which has been sent. The order is not changed from here. Check with the supplier, then close or receive that line.`);
  }
  await db
    .update(schema.stockReservations)
    .set({ status: "released", releasedAt: new Date(), releaseReason: `${actor.name}: ${reason.trim().slice(0, 300)}`, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), ne(schema.stockReservations.status, "released")));
  await afterChange(h.jobId);
  return holdById(h.id);
}

/**
 * Cut a firm hold off its roll. The piece becomes its own item and the hold
 * moves to it. A 20 m roll with 5 m cut is a 15 m roll and a 5 m piece.
 * A repeated press returns the first cut.
 */
export async function cutHold(holdId: number, requestKey: string, actor: Actor) {
  await need(actor, "handle");
  const h = await holdById(holdId);
  if (h.status === "cut" || h.status === "picked" || h.status === "handed_over" || h.status === "issued") return { hold: h, reused: true };
  if (h.status !== "reserved") throw bad("Only firm stock is cut. Wait for the deposit to be confirmed.");
  if (!h.stockItemId) throw bad("Nothing chosen to cut from.");
  const roll = await itemById(h.stockItemId);
  if (roll.unit !== "lm") throw bad(`${roll.code} is not cut. Pick it instead.`);
  if (Math.abs(roll.qty - h.qty) < 0.005 && (await holdsOnItem(roll.id)).filter((o) => o.id !== h.id && (BLOCKING as string[]).includes(o.status)).length === 0) {
    await db.update(schema.stockReservations).set({ status: "cut", updatedAt: new Date() }).where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "reserved")));
    return { hold: await holdById(h.id), reused: false };
  }
  const out = await move(roll.id, -h.qty, "cut", { byName: actor.name, byProfileId: actor.profileId, jobId: h.jobId, reservationId: h.id, requestKey: `${requestKey}:roll`, note: `Cut ${h.qty} m for hold #${h.id}.` });
  const made = await createItem(
    {
      productId: roll.productId,
      type: "cut_piece",
      unit: "lm",
      qty: h.qty,
      widthM: roll.widthM,
      lengthSource: "measured",
      widthSource: roll.widthSource as "measured" | null,
      parentItemId: roll.id,
      supplierId: roll.supplierId,
      supplierRollNo: roll.supplierRollNo,
      colour: roll.colour,
      batch: roll.batch,
      locationId: roll.locationId,
      costPer: roll.costPer as "lm" | "m2",
      unitCost: roll.unitCost,
      costStatus: roll.costStatus as "final",
      purchaseCostNote: inheritBillFlag(roll),
      boughtForJobId: roll.boughtForJobId,
      note: `Cut from ${roll.code} for job hold #${h.id}.`,
    },
    actor,
    { status: "available", kind: "cut", requestKey: `${requestKey}:piece`, jobId: h.jobId, note: `Cut from ${roll.code}.` },
  );
  await db
    .update(schema.stockReservations)
    .set({ status: "cut", stockItemId: made.item.id, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.status, "reserved")));
  void out;
  return { hold: await holdById(h.id), reused: false };
}

export async function pickHold(holdId: number, actor: Actor) {
  await need(actor, "handle");
  const h = await holdById(holdId);
  if (h.status === "picked") return h;
  if (!(h.status === "reserved" || h.status === "cut")) throw bad("Only firm stock is picked.");
  await db.update(schema.stockReservations).set({ status: "picked", updatedAt: new Date() }).where(and(eq(schema.stockReservations.id, h.id), inArray(schema.stockReservations.status, ["reserved", "cut"])));
  return holdById(h.id);
}

/**
 * Hand over (supply-only) or issue (our own job) some or all of a firm hold.
 * Outstanding stays right on a partial collection. Nothing here completes the
 * job or raises an invoice. A repeated press returns the first movement.
 */
export async function takeOut(holdId: number, qty: number, requestKey: string, actor: Actor) {
  await need(actor, "handle");
  const h = await holdById(holdId);
  const order = h.orderId ? await orderById(h.orderId) : null;
  const toJob = order?.kind === "job" || h.costOnPo;
  const [seen] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.requestKey, requestKey));
  if (seen) return { hold: h, movement: seen, reused: true };
  if (!(FIRM as string[]).includes(h.status) || h.status === "handed_over" || h.status === "issued") throw bad("Only firm stock still to go out can be handed over or issued.");
  if (!h.stockItemId) throw bad("Nothing on the shelf for this hold yet.");
  const left = outstanding(h);
  const q = cm(qty);
  if (!(q > 0) || q > left + 0.0001) throw bad(`Up to ${left} can go out on this hold.`);
  const it = await itemById(h.stockItemId);
  const out = await move(it.id, -q, toJob ? "issue" : "handover", { byName: actor.name, byProfileId: actor.profileId, jobId: h.jobId, reservationId: h.id, requestKey, note: toJob ? "Issued to job." : "Handed over." });
  const collected = cm(h.collectedQty + q);
  const done = collected >= h.qty - 0.0001;
  const [row] = await db
    .update(schema.stockReservations)
    .set({ collectedQty: collected, status: done ? (toJob ? "issued" : "handed_over") : h.status, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.collectedQty, h.collectedQty)))
    .returning();
  if (!row) throw bad("Someone else just changed this hold. Refresh and try again.");
  if (toJob && it.condition === "opened" && it.costCarry > 0 && it.costOnJobId !== h.jobId) {
    // An approved cost move off the first job lands on the next job that uses it, once.
    const [took] = await db
      .update(schema.stockItems)
      .set({ costCarry: 0, updatedAt: new Date() })
      .where(and(eq(schema.stockItems.id, it.id), eq(schema.stockItems.costCarry, it.costCarry)))
      .returning();
    if (took) {
      const { stockCostLine } = await import("./costs");
      await stockCostLine(h.jobId, `carry:${h.id}`, it.costCarry, `Opened container ${it.code}: share of its cost`, "Cost moved from the first job with Admin approval. Total unchanged.");
    }
  }
  await afterChange(h.jobId);
  return { hold: row, movement: out.movement, reused: false, unitCost: costPerItemUnit(it) };
}

/**
 * A roll turns out damaged: the office chooses another one. The new hold is
 * firm straight away if the old one was; the old one is released and points
 * at its replacement. Never two holds for the same line at once.
 */
export async function replaceItem(holdId: number, newItemId: number, requestKey: string, actor: Actor) {
  await need(actor, "allocate");
  const h = await holdById(holdId);
  if (h.replacedById) return { hold: await holdById(h.replacedById), reused: true };
  if (h.collectedQty > 0 || (ENDED as string[]).includes(h.status) || h.status === "handed_over" || h.status === "issued") throw bad("That hold can no longer be swapped.");
  if (h.stockItemId === newItemId) throw bad("Pick a different item.");
  const it = await itemById(newItemId);
  const order = h.orderId ? await orderById(h.orderId) : null;
  if (!usable(it, order?.kind === "job")) throw bad(`${it.code} is not available.`);
  if (it.productId !== h.productId) throw bad(`${it.code} is a different product.`);
  const wasFirm = (FIRM as string[]).includes(h.status);
  const stage: HoldStage = wasFirm ? "reserved" : h.status === "temporary" ? "temporary" : (h.status as HoldStage);
  const lineQty = h.orderedQty ?? h.qty;
  const qty = fromLine(it, lineQty, h.lineUnit);
  if ((BLOCKING as string[]).includes(stage) && (await availableOn(it.id)) < qty - 0.0001) throw bad(`Not enough free on ${it.code}.`);
  const [row] = await db
    .insert(schema.stockReservations)
    .values({
      productId: h.productId,
      jobId: h.jobId,
      orderId: h.orderId,
      quoteItemId: h.quoteItemId,
      saleLineId: h.saleLineId,
      jobMaterialId: h.jobMaterialId,
      stockItemId: it.id,
      qty,
      lineUnit: h.lineUnit,
      orderedQty: h.orderedQty,
      billedQty: h.billedQty,
      status: stage,
      expiresAt: h.expiresAt,
      confirmedAt: wasFirm ? new Date() : null,
      confirmedByName: wasFirm ? `Replacement for hold #${h.id}` : null,
      costOnPo: h.costOnPo,
      appliedByProfileId: actor.profileId,
      appliedByName: actor.name,
      requestKey,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return { hold: (await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.requestKey, requestKey)))[0]!, reused: true };
  if ((BLOCKING as string[]).includes(stage) && !(await fits(row.id, it.id))) {
    await db.update(schema.stockReservations).set({ status: "cancelled", releaseReason: "Someone else held it first." }).where(eq(schema.stockReservations.id, row.id));
    throw bad(`Someone else just held stock on ${it.code}.`);
  }
  await db
    .update(schema.stockReservations)
    .set({ status: "released", replacedById: row.id, releasedAt: new Date(), releaseReason: `Replaced by ${it.code} (${actor.name}).`, updatedAt: new Date() })
    .where(eq(schema.stockReservations.id, h.id));
  await afterChange(h.jobId);
  return { hold: row, reused: false };
}
