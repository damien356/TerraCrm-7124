import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { roundTo } from "./bulk-price";
import { isChargeLine } from "./charge-fold";
import { liveSellFor } from "./live-sell";
import { markupOf, sellAtMarkup, sellExGst } from "./pricing";

/* ---------------------------------------------------------------------------
 * Roll and cut pricing on broadloom carpet (Damien, 2 Nov 2026, second rule).
 *
 *  - Some carpet lists (Advantage) print two prices a lm: a cut price, and a
 *    cheaper roll price. `costPrice` is the cut price, `rollPrice` the roll
 *    price a lm, `rollLengthM` the metres on a roll (25).
 *  - Each colour goes on ONE line with its total lm. That line on its own:
 *    under 25 lm, every metre at the cut price. 25 lm or more, every metre at
 *    the roll price. No splitting into rolls and cuts.
 *  - Sell is the chosen cost at the normal markup, one rate on the line.
 *  - Lines are never added together, not across colours and not across two
 *    lines of the same colour. The same colour on two lines is flagged so he
 *    can merge them.
 *  - A roll price the same as the cut price is ignored.
 *  - Only on category carpet sold per lm. Elsewhere `rollPrice` is the price
 *    of ONE WHOLE roll (Dunlop, Damtec, MJS underlay), never a lm rate.
 *  - A line is only repriced when it is added, or its qty or product changes.
 *    A sent quote nobody touches keeps its prices.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const lmText = (n: number) => `${r2(n)}`;

const LOCKED = new Set(["accepted", "declined", "expired", "replaced", "cancelled"]);

export type RollShape = {
  category: string;
  unit: string;
  costPrice: number | null;
  rollPrice: number | null;
  rollLengthM: number | null;
};

/** Carpet priced a lm with a roll price a lm on file (Advantage's shape), break or not. */
export function isRollCutCarpet(p: RollShape) {
  return p.category === "carpet" && p.unit === "lm" && (p.rollPrice ?? 0) > 0 && (p.rollLengthM ?? 0) > 0;
}

/** The roll break on a product, or null when there is none (no roll price, or the same as cut). */
export function rollBreakOf(p: RollShape): { rollRate: number; cutRate: number; lengthM: number } | null {
  if (!isRollCutCarpet(p)) return null;
  const cutRate = p.costPrice ?? 0;
  const rollRate = p.rollPrice ?? 0;
  if (cutRate <= 0 || rollRate >= cutRate - 0.005) return null;
  return { rollRate, cutRate, lengthM: p.rollLengthM ?? 0 };
}

/** 25 lm or more on the one line. */
export function atRollQty(qty: number, brk: { lengthM: number }) {
  return qty >= brk.lengthM - 1e-9;
}

/** The roll sell a lm: the normal markup off the roll price, or the product's own markup if its sell was set by hand. */
export function rollSellOf(cutRate: number, cutSell: number, rollRate: number) {
  const standardCut = roundTo(sellExGst(cutRate), "10c");
  if (Math.abs(cutSell - standardCut) < 0.005) return roundTo(sellExGst(rollRate), "10c");
  return roundTo((cutSell * rollRate) / cutRate, "10c");
}

/** Pure. The cost and sell a lm for one line of this qty. */
export function rollCutRate(qty: number, brk: { rollRate: number; cutRate: number; lengthM: number }, cutSell: number) {
  const roll = atRollQty(qty, brk);
  return {
    roll,
    unitCost: roll ? brk.rollRate : brk.cutRate,
    unitPrice: roll ? rollSellOf(brk.cutRate, cutSell, brk.rollRate) : cutSell,
  };
}

type Item = typeof schema.quoteItems.$inferSelect;
type Product = typeof schema.products.$inferSelect;

/** Carpet lm lines from the price list, not supplier charges. */
function isCarpetLine(i: Item) {
  return i.productId != null && i.unit === "lm" && i.lineType === "material" && !isChargeLine(i) && i.qty > 0;
}

/**
 * Put the roll or cut price on the given lines, each on its own qty. Called
 * when a line is added, or its qty or product changes, before recalc. "all"
 * is for a brand new quote. Returns how many lines moved.
 */
export async function repriceRollCuts(quoteId: number, itemIds: (number | null | undefined)[] | "all"): Promise<number> {
  const ids = itemIds === "all" ? null : [...new Set(itemIds.filter((x): x is number => x != null))];
  if (ids && !ids.length) return 0;
  const [quote] = await db.select({ status: schema.quotes.status }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote || LOCKED.has(quote.status)) return 0;
  const items = (
    await db
      .select()
      .from(schema.quoteItems)
      .where(ids ? and(eq(schema.quoteItems.quoteId, quoteId), inArray(schema.quoteItems.id, ids)) : eq(schema.quoteItems.quoteId, quoteId))
  ).filter(isCarpetLine);
  if (!items.length) return 0;
  const pids = [...new Set(items.map((i) => i.productId!))];
  const products: Product[] = await db.select().from(schema.products).where(inArray(schema.products.id, pids));
  const now = new Date();
  let moved = 0;
  for (const l of items) {
    const p = products.find((x) => x.id === l.productId);
    const brk = p ? rollBreakOf(p) : null;
    if (!p || !brk) continue;
    const rate = rollCutRate(l.qty, brk, await liveSellFor(p));
    const unitCost = rate.unitCost;
    let unitPrice = l.unitPrice;
    if (l.priceBy === "markup" && l.markupPercent != null) unitPrice = sellAtMarkup(unitCost, l.markupPercent);
    else if (l.priceBy !== "hand") unitPrice = rate.unitPrice;
    const listUnitPrice = l.listUnitPrice == null ? null : rate.unitPrice;
    const markupPercent = l.priceBy === "markup" && l.markupPercent != null ? l.markupPercent : markupOf(unitCost, unitPrice);
    const total = r2(l.qty * unitPrice);
    const same =
      l.unitCost === unitCost && l.unitPrice === unitPrice && l.listUnitPrice === listUnitPrice && l.total === total && l.markupPercent === markupPercent && !l.freightUnitCost;
    if (same) continue;
    await db
      .update(schema.quoteItems)
      .set({ unitCost, unitPrice, listUnitPrice, markupPercent, total, freightUnitCost: null, updatedAt: now })
      .where(eq(schema.quoteItems.id, l.id));
    moved += 1;
  }
  return moved;
}

/** The message for the same roll and cut colour on more than one line, or null. Pure. */
export function duplicateColourText(qtys: number[], lengthM: number, where = "") {
  if (qtys.length < 2) return null;
  const total = qtys.reduce((a, q) => a + q, 0);
  const each = `${qtys.map(lmText).join(" + ")} lm`;
  const missesRoll = total >= lengthM - 1e-9 && qtys.every((q) => q < lengthM - 1e-9);
  return missesRoll
    ? `Same colour on ${qtys.length} lines${where} (${each}). Each line is priced on its own qty, so none gets the roll price. Merge them into one ${lmText(total)} lm line to get it.`
    : `Same colour on ${qtys.length} lines${where} (${each}). Each line is priced on its own qty. Merge them into one ${lmText(total)} lm line if it is one colour order.`;
}

/** Lines whose roll and cut colour is on another line of the quote too. Nothing is priced together. */
export async function rollDuplicateFlags(items: Item[]): Promise<Record<number, string>> {
  const lines = items.filter(isCarpetLine);
  const pids = [...new Set(lines.map((i) => i.productId!))];
  const repeated = pids.filter((id) => lines.filter((l) => l.productId === id).length > 1);
  if (!repeated.length) return {};
  const products: Product[] = await db.select().from(schema.products).where(inArray(schema.products.id, repeated));
  const out: Record<number, string> = {};
  for (const p of products) {
    const brk = rollBreakOf(p);
    if (!brk) continue;
    const mine = lines.filter((l) => l.productId === p.id);
    const text = duplicateColourText(
      mine.map((l) => l.qty),
      brk.lengthM,
    );
    if (text) for (const l of mine) out[l.id] = text;
  }
  return out;
}
