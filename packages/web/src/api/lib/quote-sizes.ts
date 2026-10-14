/**
 * Fix list 11 Oct, items 2 and 3, on quote lines. The sums live in
 * order-sizes.ts. This file reads the lines and products, and writes lines.
 *
 *  - A typed qty on a box good, trim or piece good is rounded up to what can
 *    be bought (whole boxes, 2.4 m lengths, pails). Measured floor lines are
 *    already rounded by floorQty.
 *  - An underlay line follows a floor line (`follows_item_id`). Carpet
 *    underlay lm comes off the carpet's lm and width, hard floor underlay m2
 *    off the floor's m2 with its wastage. It moves when the floor moves,
 *    unless someone typed over its qty.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of } from "./flooring-qty";
import {
  carpetUnderlay,
  floorsForUnderlay,
  hardFloorUnderlay,
  isSizeFlag,
  UNDERLAY_ALONE_FLAG,
  underlayName,
  wholeUnits,
  type UnderlayQty,
} from "./order-sizes";
import { qtyForLine } from "./quote-labour";

type Product = typeof schema.products.$inferSelect;
type Line = typeof schema.quoteItems.$inferSelect;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const same = (a: number, b: number) => Math.abs(a - b) <= 0.0005;

export { isSizeFlag, underlayName, wholeUnits };

/** True for the two underlays that follow a floor line. */
export const followsAFloor = (p: Pick<Product, "category"> | null | undefined) => !!p && floorsForUnderlay(p.category).length > 0;

/**
 * What a floor line comes to, for the underlay under it. The line's own qty
 * wins: a carpet measured at 5 m2 (1.3 lm) but typed up to 7 lm puts 7 lm of
 * underlay down, not 1.3. The measure only counts while the qty still matches it.
 */
function floorFacts(floor: Line, fp: Product) {
  const res = qtyForLine(fp, floor);
  if (res && same(floor.qty, res.qty)) {
    return {
      lm: res.lm,
      widthM: res.widthM,
      totalM2: res.soldAs === "broadloom" ? res.labourM2 : res.totalM2,
      measuredM2: floor.measuredM2,
      wastagePct: floor.wastagePct,
    };
  }
  const widthM = res?.widthM ?? fp.widthM ?? floor.rollWidthM ?? null;
  const box = boxM2Of(fp);
  const lm = fp.unit === "lm" ? floor.qty : fp.unit === "m2" && widthM ? floor.qty / widthM : null;
  const totalM2 =
    fp.unit === "m2" ? floor.qty : fp.unit === "lm" && widthM ? floor.qty * widthM : box && fp.unit !== "lm" ? floor.qty * box : null;
  return { lm, widthM, totalM2, measuredM2: null, wastagePct: null };
}

/** The qty an underlay line should carry off its floor line. Null when it is not an underlay that follows. */
export function underlayQty(up: Product, floor: Line | null | undefined, fp: Product | null | undefined): UnderlayQty | null {
  if (!followsAFloor(up)) return null;
  if (!floor || !fp) return { qty: 0, note: "Not following a floor line.", flag: UNDERLAY_ALONE_FLAG };
  const f = floorFacts(floor, fp);
  if (up.category === "carpet_underlay") return carpetUnderlay(f, up.widthM);
  if (f.totalM2 == null) return { qty: 0, note: "The floor line has no m² to work from.", flag: UNDERLAY_ALONE_FLAG };
  return hardFloorUnderlay({ measuredM2: f.measuredM2, totalM2: f.totalM2, wastagePct: f.wastagePct });
}

async function productOf(id: number | null | undefined) {
  if (id == null) return null;
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, id));
  return p ?? null;
}

/**
 * The floor line a new underlay goes with: the one asked for, or the latest
 * floor of its kind on the quote that has no underlay yet (the latest of its
 * kind when they all have one).
 */
export async function floorLineFor(quoteId: number, up: Product, askedId?: number | null) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  if (askedId != null) {
    const line = lines.find((l) => l.id === askedId && l.productId != null) ?? null;
    return { line, product: line ? await productOf(line.productId) : null };
  }
  const kinds = floorsForUnderlay(up.category);
  const ids = [...new Set(lines.map((l) => l.productId).filter((v): v is number => v != null))];
  const products = ids.length ? await db.select().from(schema.products).where(inArray(schema.products.id, ids)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const floors = lines
    .filter((l) => l.productId != null && l.followsItemId == null && kinds.includes(byId.get(l.productId)?.category ?? ""))
    .sort((a, b) => b.sortOrder - a.sortOrder);
  const taken = new Set(lines.filter((l) => l.followsItemId != null && followsAFloor(byId.get(l.productId ?? -1))).map((l) => l.followsItemId));
  const line = floors.find((l) => !taken.has(l.id)) ?? floors[0] ?? null;
  return { line, product: line ? (byId.get(line.productId!) ?? null) : null };
}

/** Sort order straight under a floor line and the installs linked to it. Moves the lines below down one. */
export async function slotUnder(floor: Line) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, floor.quoteId));
  const after = Math.max(
    floor.sortOrder,
    ...lines.filter((l) => l.labourForItemId === floor.id || l.followsItemId === floor.id).map((l) => l.sortOrder),
  );
  await db
    .update(schema.quoteItems)
    .set({ sortOrder: sql`${schema.quoteItems.sortOrder} + 1` })
    .where(and(eq(schema.quoteItems.quoteId, floor.quoteId), sql`${schema.quoteItems.sortOrder} > ${after}`));
  return after + 1;
}

/** Keeps a flag someone else set; replaces or clears one this feature set. */
function flagAfter(line: Pick<Line, "flagged" | "flagReason">, own: string | null) {
  if (line.flagged && !isSizeFlag(line.flagReason)) return { flagged: true, flagReason: line.flagReason };
  return own ? { flagged: true, flagReason: own } : { flagged: false, flagReason: null };
}

/** Write an underlay line's qty off its floor line. */
async function setUnderlay(l: Line, got: UnderlayQty, keepQty = false) {
  const qty = keepQty ? l.qty : got.qty;
  await db
    .update(schema.quoteItems)
    .set({ qty, total: round2(qty * l.unitPrice), ...flagAfter(l, got.flag), updatedAt: new Date() })
    .where(eq(schema.quoteItems.id, l.id));
}

/**
 * After a floor line's qty, area, width or product changed: move the underlay
 * following it. A qty someone typed over (it no longer matches what the old
 * floor gave) stays where they put it.
 */
export async function followUnderlay(before: { line: Line; product: Product | null }, after: { line: Line; product: Product | null }) {
  const linked = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.followsItemId, after.line.id));
  let moved = 0;
  for (const l of linked) {
    const up = await productOf(l.productId);
    if (!up || !followsAFloor(up)) continue;
    const was = underlayQty(up, before.line, before.product);
    if (was && !same(l.qty, was.qty)) continue;
    const now = underlayQty(up, after.line, after.product);
    if (!now) continue;
    await setUnderlay(l, now);
    moved++;
  }
  return moved;
}

/** An underlay line's own product or floor changed: work its qty out again. */
export async function refollow(lineId: number) {
  const [l] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, lineId));
  if (!l || l.followsItemId == null) return null;
  const up = await productOf(l.productId);
  if (!up) return null;
  const [floor] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, l.followsItemId));
  const got = underlayQty(up, floor ?? null, floor ? await productOf(floor.productId) : null);
  if (got) await setUnderlay(l, got);
  return got;
}

/**
 * Voice quotes: link each underlay line to its floor and work its qty out.
 * The floor said just before it, else the nearest floor of its kind. No floor
 * at all: flagged, and the qty he said stands.
 */
export async function linkUnderlay(quoteId: number) {
  const lines = (await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId))).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
  );
  const ids = [...new Set(lines.map((l) => l.productId).filter((v): v is number => v != null))];
  const products = ids.length ? await db.select().from(schema.products).where(inArray(schema.products.id, ids)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const taken = new Set<number>();
  for (const [at, l] of lines.entries()) {
    const up = l.productId != null ? byId.get(l.productId) : undefined;
    if (!up || !followsAFloor(up) || l.followsItemId != null) continue;
    const kinds = floorsForUnderlay(up.category);
    const isFloor = (f: Line) => f.id !== l.id && kinds.includes(byId.get(f.productId ?? -1)?.category ?? "");
    const before = lines.slice(0, at).reverse();
    const floor =
      before.find((f) => isFloor(f) && !taken.has(f.id)) ??
      lines.slice(at + 1).find((f) => isFloor(f) && !taken.has(f.id)) ??
      before.find(isFloor) ??
      null;
    if (!floor) {
      await db.update(schema.quoteItems).set(flagAfter(l, UNDERLAY_ALONE_FLAG)).where(eq(schema.quoteItems.id, l.id));
      continue;
    }
    taken.add(floor.id);
    await db.update(schema.quoteItems).set({ followsItemId: floor.id }).where(eq(schema.quoteItems.id, l.id));
    await refollow(l.id);
  }
}

export type LineSize = {
  /** "34 lm of 3.66 m carpet x 2 ...", "3 lengths of 2.4 m (7.2 lm)". Internal only. */
  note: string | null;
  /** On an underlay line: the floor line it follows. */
  follows: { id: number; description: string } | null;
  /** On an underlay line: the floor lines it could follow. */
  floorChoices: { id: number; description: string }[] | null;
};

/** Per line, the size sums in words and what an underlay follows. For the quote page. */
export async function lineSizes(items: Line[]): Promise<Record<number, LineSize>> {
  const ids = [...new Set(items.map((i) => i.productId).filter((v): v is number => v != null))];
  if (!ids.length) return {};
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: Record<number, LineSize> = {};
  for (const i of items) {
    const p = i.productId != null ? byId.get(i.productId) : undefined;
    if (!p) continue;
    if (followsAFloor(p)) {
      const kinds = floorsForUnderlay(p.category);
      const floor = i.followsItemId != null ? items.find((l) => l.id === i.followsItemId) : undefined;
      const got = underlayQty(p, floor, floor ? byId.get(floor.productId ?? -1) : null);
      const typed = got && floor && !same(i.qty, got.qty);
      out[i.id] = {
        note: !floor ? null : typed ? `Typed over. The floor gives ${got.qty} ${p.unit}.` : (got?.note ?? null),
        follows: floor ? { id: floor.id, description: floor.description } : null,
        floorChoices: items
          .filter((l) => {
            const fp = l.productId != null ? byId.get(l.productId) : undefined;
            return l.id !== i.id && !!fp && !followsAFloor(fp) && (!!fp.soldAs || kinds.includes(fp.category));
          })
          .map((l) => ({ id: l.id, description: `${l.description} (${round2(l.qty)} ${l.unit})` })),
      };
      continue;
    }
    if (i.measuredM2 != null) continue;
    const r = wholeUnits(p, i.qty);
    if (r.note && same(r.qty, i.qty)) out[i.id] = { note: r.note, follows: null, floorChoices: null };
  }
  return out;
}

/**
 * A size flag on a line after a typed qty: set ours, clear ours once the gap
 * is filled, never touch a flag someone else set. Empty = leave it as it is.
 */
export function sizeFlag(line: Pick<Line, "flagged" | "flagReason">, own: string | null): { flagged?: boolean; flagReason?: string | null } {
  if (line.flagged && !isSizeFlag(line.flagReason)) return {};
  if (own) return { flagged: true, flagReason: own };
  return line.flagged ? { flagged: false, flagReason: null } : {};
}

/**
 * A new product line that is not measured: its qty, flag, and for underlay the
 * floor line it follows and where it sits (straight under that floor).
 */
export async function startLine(quoteId: number, product: Product, qty: number, followsItemId?: number | null) {
  if (followsAFloor(product)) {
    const floor = await floorLineFor(quoteId, product, followsItemId);
    if (!floor.line) return { qty, flag: UNDERLAY_ALONE_FLAG, note: null, followsItemId: null, sortOrder: null };
    const got = underlayQty(product, floor.line, floor.product)!;
    return {
      // No underlay width: the typed qty stands until the width is in.
      qty: got.flag && got.qty === 0 && product.widthM == null ? qty : got.qty,
      flag: got.flag,
      note: got.note,
      followsItemId: floor.line.id,
      sortOrder: await slotUnder(floor.line),
    };
  }
  const r = wholeUnits(product, qty);
  return { qty: r.qty, flag: r.flag, note: r.note, followsItemId: null, sortOrder: null };
}
