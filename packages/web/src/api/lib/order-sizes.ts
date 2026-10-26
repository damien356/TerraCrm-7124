/**
 * Fix list 11 Oct, items 2 and 3: whole boxes, whole lengths, whole pails,
 * underlay and rolls. The sums only. No server imports here, so the quote
 * builder can use them too.
 *
 * Damien's rules:
 *  - Box goods are priced per m2 but bought by the whole box. A typed qty is
 *    rounded up to whole boxes too, so the PO and the quote agree.
 *  - Trims are lengths (2.4 m each), priced per lm, rounded up to whole
 *    lengths. Adhesive rounds up to whole pails. Anything sold by the piece
 *    (each, box, roll, pail) is a whole number.
 *  - Size missing: flag the line and ask. Never guess.
 *  - Carpet underlay (lm) = carpet m2 / underlay roll width, which is the
 *    carpet lm x (carpet width / underlay width). Charged at full width, so
 *    rounded UP to the next 0.1 lm, never down.
 *  - Hard floor underlay (m2) = the floor m2 plus its wastage.
 *  - Ordering: a stocked roll is cut to the exact metres ("2 rolls + 4 m"),
 *    one that is not stocked is ordered in whole rolls.
 */
import { boxM2Of, type ProductShape } from "./flooring-qty";
import { isAccessoryCategory } from "./product-categories";

export const UNDERLAY_CATEGORIES = ["carpet_underlay", "hard_floor_underlay", "underlay"] as const;
export const isUnderlayCategory = (c: string | null | undefined) => (UNDERLAY_CATEGORIES as readonly string[]).includes(c ?? "");

/** Floors a carpet underlay follows on its own. */
export const CARPET_FLOORS = ["carpet"] as const;
/** Floors a hard floor underlay follows on its own. */
export const HARD_FLOORS = ["engineered_timber", "solid_timber", "timber", "laminate", "hybrid"] as const;
/** The floors an underlay of this category goes with, when nobody said which line. */
export function floorsForUnderlay(category: string): readonly string[] {
  if (category === "carpet_underlay") return CARPET_FLOORS;
  if (category === "hard_floor_underlay") return HARD_FLOORS;
  return [];
}

export const PIECE_FLAG = "No length size in the price book, so this is not rounded to whole lengths. Check the quantity.";
export const UNDERLAY_WIDTH_FLAG = "No roll width on this underlay in the price book. Put it in, or type the metres.";
export const UNDERLAY_WAIT_FLAG = "The carpet has no roll width yet, so the underlay metres wait for it.";
export const UNDERLAY_ALONE_FLAG = "No floor line for this underlay to follow. Type the quantity, or add the floor first.";
const OWN_FLAGS = new Set([PIECE_FLAG, UNDERLAY_WIDTH_FLAG, UNDERLAY_WAIT_FLAG, UNDERLAY_ALONE_FLAG]);
/** Flags this file sets, so they clear once the gap is filled. */
export const isSizeFlag = (reason: string | null | undefined) => !!reason && OWN_FLAGS.has(reason);

export type SizeShape = ProductShape & {
  brand?: string | null;
  range?: string | null;
  colour?: string | null;
  lengthMm?: number | null;
  pieceLengthM?: number | null;
  rollLengthM?: number | null;
  heldInWarehouse?: boolean | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const fmt = (n: number) => String(r2(n));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Units that only come whole. */
const WHOLE_UNITS: Record<string, [string, string]> = {
  each: ["each", "each"],
  box: ["box", "boxes"],
  pack: ["pack", "packs"],
  roll: ["roll", "rolls"],
  pail: ["pail", "pails"],
  sheet: ["sheet", "sheets"],
};

/** "Carpetmate Standard underlay". The client sees this name and nothing else about it. */
export function underlayName(p: { range?: string | null; colour?: string | null; brand?: string | null }): string {
  const range = (p.range ?? "").trim();
  const colour = (p.colour ?? "").trim();
  const sq = (s: string) => s.toLowerCase();
  let name: string;
  if (!colour) name = range;
  else if (!range || /underlay/i.test(range) || sq(colour).startsWith(sq(range))) name = colour;
  else if (sq(colour) === sq(range)) name = range;
  else name = `${range} ${colour}`;
  name = name || (p.brand ?? "").trim();
  return /underlay/i.test(name) ? name : `${name} underlay`.trim();
}

export type Rounded = {
  qty: number;
  /** "3 lengths of 2.4 m (7.2 lm)". Null when nothing needed saying. */
  note: string | null;
  flag: string | null;
};

/**
 * A typed qty, rounded to what can actually be bought: whole boxes on box
 * goods, whole lengths on trims, whole pieces on anything sold by the piece.
 * Measured floor lines go through floorQty instead. Underlay that follows a
 * floor goes through the underlay sums.
 */
export function wholeUnits(p: SizeShape, qtyIn: number): Rounded {
  const qty = Math.max(0, qtyIn);
  if (p.soldAs === "box") {
    const boxM2 = boxM2Of(p);
    if (!boxM2) return { qty, note: null, flag: null };
    if (p.unit !== "m2") return { qty: Math.ceil(qty - 1e-9), note: null, flag: null };
    const boxes = Math.ceil(qty / boxM2 - 1e-9);
    const m2 = Math.floor(boxes * boxM2 * 10_000 + 1e-6) / 10_000;
    return { qty: m2, note: `${plural(boxes, "box", "boxes")} (${fmt(m2)} m²)`, flag: null };
  }
  if (p.soldAs === "broadloom") return { qty, note: null, flag: null };
  if (p.unit === "lm" && isAccessoryCategory(p.category)) {
    const len = p.pieceLengthM && p.pieceLengthM > 0 ? p.pieceLengthM : null;
    if (!len) {
      // Weld rod comes on a coil (length_mm, or just named weld rod), not in lengths.
      const coil = (p.lengthMm && p.lengthMm > 0) || /weld\s*rod/i.test(`${p.brand ?? ""} ${p.range ?? ""}`);
      return { qty, note: null, flag: coil ? null : PIECE_FLAG };
    }
    const n = Math.ceil(qty / len - 1e-9);
    const lm = r4(n * len);
    return { qty: lm, note: `${plural(n, "length", "lengths")} of ${fmt(len)} m (${fmt(lm)} lm)`, flag: null };
  }
  const words = WHOLE_UNITS[p.unit];
  if (words) {
    const n = Math.ceil(qty - 1e-9);
    return { qty: n, note: n !== qty ? `Rounded up to ${plural(n, words[0], words[1])}.` : null, flag: null };
  }
  return { qty, note: null, flag: null };
}

/* -------------------------------- underlay -------------------------------- */

export type UnderlayQty = { qty: number; note: string; flag: string | null };

/**
 * Carpet underlay lm off the carpet: carpet m2 over the underlay's roll width,
 * rounded UP to the next 0.1 lm. 17 lm of 3.66 m carpet on 1.83 m underlay is 34 lm.
 */
export function carpetUnderlay(carpet: { lm: number | null; widthM: number | null }, underlayWidthM: number | null | undefined): UnderlayQty {
  if (!underlayWidthM || underlayWidthM <= 0) return { qty: 0, note: "No underlay roll width.", flag: UNDERLAY_WIDTH_FLAG };
  if (carpet.lm == null || !carpet.widthM) return { qty: 0, note: "Waiting on the carpet roll width.", flag: UNDERLAY_WAIT_FLAG };
  const ratio = carpet.widthM / underlayWidthM;
  const lm = Math.ceil(r4(carpet.lm * ratio) * 10 - 1e-9) / 10;
  return {
    qty: lm,
    note: `${fmt(carpet.lm)} lm of ${fmt(carpet.widthM)} m carpet x ${fmt(ratio)} (${fmt(carpet.widthM)} ÷ ${fmt(underlayWidthM)}) = ${fmt(lm)} lm.`,
    flag: null,
  };
}

/** Hard floor underlay m2: the floor's m2 with its wastage, to the next 0.01 m2. */
export function hardFloorUnderlay(floor: { measuredM2: number | null; totalM2: number; wastagePct: number | null }): UnderlayQty {
  const m2 = Math.ceil(r4(floor.totalM2) * 100 - 1e-9) / 100;
  const head =
    floor.measuredM2 != null && floor.wastagePct
      ? `Floor ${fmt(floor.measuredM2)} m² + ${fmt(floor.wastagePct)}%`
      : `Floor ${fmt(floor.totalM2)} m²`;
  return { qty: m2, note: `${head} = ${fmt(m2)} m².`, flag: null };
}

/* ---------------------------------- rolls --------------------------------- */

/** Metres on one roll. The roll length, or worked back from the qty on a roll. */
export function rollLengthOf(p: SizeShape & { rollM2?: number | null }): number | null {
  if (p.rollLengthM && p.rollLengthM > 0) return p.rollLengthM;
  if (!p.rollM2 || p.rollM2 <= 0) return null;
  if (p.unit === "lm") return p.rollM2;
  if (p.unit === "m2" && p.widthM && p.widthM > 0) return r4(p.rollM2 / p.widthM);
  return null;
}

/** Whether ordering goes by the roll: underlay, plastic, Floorshield. Not carpet or sheet vinyl, which have roll and cut rates. */
export function ordersByRoll(p: SizeShape & { rollM2?: number | null }): boolean {
  // Import fixes 26 Oct: underlay tagged Broadloom is still cut off the roll.
  if (p.soldAs && !isUnderlayCategory(p.category)) return false;
  if (p.unit === "roll") return true;
  return (isUnderlayCategory(p.category) || isAccessoryCategory(p.category)) && rollLengthOf(p) != null && (p.unit === "lm" || p.unit === "m2");
}

export type RollOrder = {
  /** Qty to put on the order, in the product's own unit. */
  qty: number;
  rolls: number;
  /** "2 rolls + 4 m" when stocked, "3 rolls (45 m)" when not. */
  note: string;
};

/**
 * What to order for `qty` of a roll good. Stocked: cut the exact metres off
 * Terra's own roll. Not stocked: whole rolls. Null when the roll length is not
 * known, so the office is told to check it.
 */
export function rollOrder(p: SizeShape & { rollM2?: number | null }, qty: number): RollOrder | null {
  if (p.unit === "roll") {
    const n = Math.ceil(qty - 1e-9);
    return { qty: n, rolls: n, note: plural(n, "roll", "rolls") };
  }
  const len = rollLengthOf(p);
  if (!len) return null;
  const metres = p.unit === "lm" ? qty : p.widthM && p.widthM > 0 ? qty / p.widthM : null;
  if (metres == null) return null;
  if (p.heldInWarehouse) {
    const whole = Math.floor(metres / len + 1e-9);
    const extra = r2(metres - whole * len);
    const parts = [whole ? plural(whole, "roll", "rolls") : "", extra > 0.005 ? `${fmt(extra)} m` : ""].filter(Boolean);
    return { qty, rolls: whole + (extra > 0.005 ? 1 : 0), note: `Cut from stock: ${parts.join(" + ") || "0 m"}` };
  }
  const rolls = Math.ceil(r4(metres / len) - 1e-9);
  const orderM = r4(rolls * len);
  const orderQty = p.unit === "lm" ? orderM : r4(orderM * (p.widthM ?? 0));
  return { qty: orderQty, rolls, note: `${plural(rolls, "roll", "rolls")} (${fmt(orderM)} m)` };
}
