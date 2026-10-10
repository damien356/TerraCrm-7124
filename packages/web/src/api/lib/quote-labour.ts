/**
 * Install labour on quotes (item 8) and measured m2 plus wastage (item 9).
 * The sums live in flooring-qty.ts. This file reads the price book, the rate
 * book and Settings, and writes lines.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { markupPctUsed, sellExGstWithMarkup } from "./pricing";
import {
  defaultInstall,
  FLOOR_TYPE_LABELS,
  floorForInstall,
  floorQty,
  INSTALL_ITEMS,
  floorTypeOf,
  isInstallFlag,
  isOwnFlag,
  labourQtyFor,
  NO_BOX_FLAG,
  NO_WIDTH_FLAG,
  wastageFromSettings,
  type InstallPick,
  type QtyResult,
} from "./flooring-qty";

type Product = typeof schema.products.$inferSelect;
type Line = typeof schema.quoteItems.$inferSelect;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Starting wastage % for a product's floor type, off Settings. 0 when unset. */
export async function wastageDefaultFor(product: Product): Promise<number> {
  const t = floorTypeOf(product);
  if (!t) return 0;
  const rows = await db.select().from(schema.settings);
  return wastageFromSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])), t);
}

/**
 * One labour line off the rate book at Terra's STANDARD rate. The same sums
 * quotes.addLabour has always used: the item's own markup or the standard
 * chain, and a minimum charge as a floor on the line.
 */
export async function standardLabour(itemId: number, qty: number) {
  const [item] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, itemId));
  if (!item) throw new ORPCError("NOT_FOUND", { message: "That work item is not in the rate book" });

  const on = new Date().toISOString().slice(0, 10);
  const rates = await db
    .select()
    .from(schema.labourRates)
    .where(and(eq(schema.labourRates.itemId, itemId), isNull(schema.labourRates.installerId)));
  const live = rates
    .filter((r) => r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  if (!live) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${item.name} has no standard rate yet. Price it in the rate book first, otherwise it quotes at zero.`,
    });
  }

  const cost = live.amount;
  const sell = sellExGstWithMarkup(cost, item.markupPercent);
  const lineCost = Math.max(round2(qty * cost), live.minimumCharge ?? 0);
  const lineSell = Math.max(
    round2(qty * sell),
    live.minimumCharge ? sellExGstWithMarkup(live.minimumCharge, item.markupPercent) : 0,
  );
  const minApplied = live.minimumCharge != null && round2(qty * cost) < live.minimumCharge;
  return {
    item,
    live,
    cost,
    sell,
    lineCost,
    lineSell,
    minApplied,
    values: {
      kind: item.kind === "allowance" ? "other" : "labour",
      lineType: "labour",
      description: item.name,
      qty,
      unit: item.unit,
      unitPrice: sell,
      unitCost: cost,
      markupPercent: markupPctUsed(item.markupPercent),
      total: lineSell,
      rateItemId: item.id,
    },
  };
}

export async function nextSortOrder(quoteId: number) {
  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId));
  return Number(maxRow?.max ?? -1) + 1;
}

/** What a product line's measured m2 comes to, with this line's wastage and roll width. */
export function qtyForLine(product: Product, line: Pick<Line, "measuredM2" | "wastagePct" | "rollWidthM">): QtyResult | null {
  if (line.measuredM2 == null) return null;
  return floorQty(product, line.measuredM2, line.wastagePct ?? 0, line.rollWidthM);
}

/** The flag a product line should carry for its quantity, or null. */
export function qtyFlag(res: QtyResult | null): string | null {
  if (!res) return null;
  if (res.problem === "no_width") return NO_WIDTH_FLAG;
  if (res.problem === "no_box_size") return NO_BOX_FLAG;
  return null;
}

/** The install that goes with a product line by default, now its width is known. */
export function installFor(product: Product, res: QtyResult | null): InstallPick {
  return defaultInstall(floorTypeOf(product), res?.widthM ?? product.widthM ?? null);
}

/** Labour qty for an install on this product line. 1 when the install is not priced by area. */
export function linkedQty(res: QtyResult | null, unit: string, fallback: number): number {
  if (!res) return fallback;
  return labourQtyFor(res, unit) ?? 1;
}

/** Add an install line under a product line, linked to it. */
export async function addLinkedLabour(productLine: Line, product: Product, itemId: number) {
  const res = qtyForLine(product, productLine);
  const [item] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, itemId));
  if (!item) throw new ORPCError("NOT_FOUND", { message: "That work item is not in the rate book" });
  const qty = linkedQty(res, item.unit, productLine.qty);
  const priced = await standardLabour(itemId, qty);
  // Straight under its product line: everything below moves down one.
  await db
    .update(schema.quoteItems)
    .set({ sortOrder: sql`${schema.quoteItems.sortOrder} + 1` })
    .where(and(eq(schema.quoteItems.quoteId, productLine.quoteId), sql`${schema.quoteItems.sortOrder} > ${productLine.sortOrder}`));
  const [row] = await db
    .insert(schema.quoteItems)
    .values({
      quoteId: productLine.quoteId,
      ...priced.values,
      labourForItemId: productLine.id,
      floorCategory: productLine.floorCategory,
      sortOrder: productLine.sortOrder + 1,
    })
    .returning();
  // The install has been chosen, so a "pick the install" flag has done its job.
  if (productLine.flagged && isInstallFlag(productLine.flagReason)) {
    await db
      .update(schema.quoteItems)
      .set({ flagged: false, flagReason: null, updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, productLine.id));
  }
  return row;
}

/**
 * After a product line's area, wastage, width or product changed: move the
 * install lines linked to it. A labour qty someone typed over by hand (it no
 * longer matches what the old figures gave) is left where they put it.
 */
export async function followLinkedLabour(
  before: { line: Line; product: Product | null },
  after: { line: Line; product: Product | null },
) {
  const linked = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.labourForItemId, after.line.id));
  if (!linked.length) return 0;
  const was = before.product ? qtyForLine(before.product, before.line) : null;
  const now = after.product ? qtyForLine(after.product, after.line) : null;
  // Area cleared: the qty is typed by hand now, so the install is left as it is.
  if (!now) return 0;
  let moved = 0;
  for (const l of linked) {
    const expectedBefore = linkedQty(was, l.unit, before.line.qty);
    if (Math.abs(l.qty - expectedBefore) > 0.0005) continue;
    const qty = linkedQty(now, l.unit, after.line.qty);
    if (Math.abs(qty - l.qty) <= 0.0005) continue;
    await db
      .update(schema.quoteItems)
      .set({ qty, total: round2(qty * l.unitPrice), updatedAt: new Date() })
      .where(eq(schema.quoteItems.id, l.id));
    moved++;
  }
  return moved;
}

/** Keeps a flag set by someone else; replaces or clears one this feature set. */
export function nextFlag(line: Pick<Line, "flagged" | "flagReason">, own: string | null) {
  if (line.flagged && !isOwnFlag(line.flagReason)) return { flagged: true, flagReason: line.flagReason };
  return own ? { flagged: true, flagReason: own } : { flagged: false, flagReason: null };
}

export type LineArea = {
  floorType: string;
  floorLabel: string;
  soldAs: string;
  /** "12.4 m² + 10% = 13.64 m². 7 boxes of 2.2 m² = 15.4 m²." Null until an area is entered. */
  note: string | null;
  problem: "no_width" | "no_box_size" | null;
  /** The price book roll width. Null = the line has to pick one. */
  productWidthM: number | null;
  /** Install lines added with this product line. */
  linkedLabourIds: number[];
  /** Rate book installs for this floor, for the add picker. */
  installChoices: { id: number; name: string; unit: string }[];
};

/** Per product line: its floor type, the sums in words, and its linked installs. For the quote page. */
export async function lineAreas(items: Line[]): Promise<Record<number, LineArea>> {
  const ids = [...new Set(items.map((i) => i.productId).filter((v): v is number => v != null))];
  if (!ids.length) return {};
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  const byId = new Map(products.map((p) => [p.id, p]));
  const rateItems = await db
    .select({ id: schema.labourRateItems.id, name: schema.labourRateItems.name, unit: schema.labourRateItems.unit })
    .from(schema.labourRateItems)
    .where(inArray(schema.labourRateItems.id, [...new Set(Object.values(INSTALL_ITEMS).flat())]));
  const rateById = new Map(rateItems.map((r) => [r.id, r]));
  const out: Record<number, LineArea> = {};
  for (const i of items) {
    const p = i.productId != null ? byId.get(i.productId) : undefined;
    const t = p ? floorTypeOf(p) : null;
    if (!p || !t) continue;
    const res = qtyForLine(p, i);
    out[i.id] = {
      floorType: t,
      floorLabel: FLOOR_TYPE_LABELS[t],
      soldAs: p.soldAs ?? "",
      note: res?.note ?? null,
      problem: res?.problem ?? null,
      productWidthM: p.widthM ?? null,
      linkedLabourIds: items.filter((l) => l.labourForItemId === i.id).map((l) => l.id),
      installChoices: INSTALL_ITEMS[t].map((id) => rateById.get(id)).filter((r): r is NonNullable<typeof r> => !!r),
    };
  }
  return out;
}

/**
 * Voice quotes (items 8 and 9). A product line said in m2 (or with no unit,
 * which reads as m2) becomes a measured line: the Settings wastage goes on and
 * the qty is rounded to boxes or roll. The install goes on only where the
 * recording did not already name labour for that floor, so nothing doubles.
 */
export async function voiceAreas<
  L extends { productId: number | null; kind: string; qty: number; unit: string; unitPrice: number; flagged: boolean; flagReason: string | null; rateItemId?: number | null },
>(lines: L[], said: { unit?: string | null; qty: number }[]) {
  const ids = [...new Set(lines.map((l) => l.productId).filter((v): v is number => v != null))];
  const products = ids.length ? await db.select().from(schema.products).where(inArray(schema.products.id, ids)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const kv = Object.fromEntries((await db.select().from(schema.settings)).map((r) => [r.key, r.value]));
  const covered = new Set(lines.filter((l) => l.kind === "labour").flatMap((l) => floorForInstall(l.rateItemId)));

  return lines.map((l, i) => {
    const p = l.productId != null ? byId.get(l.productId) : undefined;
    const t = p ? floorTypeOf(p) : null;
    const unitSaid = said[i]?.unit ?? "m2";
    if (!p || !t || l.kind !== "supply" || unitSaid !== "m2") {
      return { ...l, measuredM2: null as number | null, wastagePct: null as number | null, install: null as InstallPick | null, product: p ?? null };
    }
    const wastagePct = wastageFromSettings(kv, t);
    const measuredM2 = said[i]?.qty ?? l.qty;
    const res = floorQty(p, measuredM2, wastagePct, null);
    const pick: InstallPick | null = covered.has(t) ? null : installFor(p, res);
    // Worked out in the product's own unit now, so "you said m2, it sells by lm" no longer applies.
    const base = l.flagReason?.startsWith("You said ") ? { flagged: false, flagReason: null } : { flagged: l.flagged, flagReason: l.flagReason };
    const own = qtyFlag(res) ?? (pick?.kind === "ask" ? pick.reason : null);
    const flag = nextFlag(base, own);
    return {
      ...l,
      qty: res?.qty ?? l.qty,
      measuredM2,
      wastagePct,
      install: res?.problem === "no_width" ? null : pick,
      product: p,
      ...flag,
    };
  });
}
