/**
 * Items 8 and 9 (Damien, 10 Oct): one measured m2 per floor, his own wastage %,
 * and the install labour that goes with it.
 *
 * No server imports here, so the quote builder can show the same sums before
 * the line is added.
 *
 * His rules, confirmed 10 Oct:
 *  - Box goods (hybrid, engineered timber, vinyl planks, laminate, carpet
 *    tiles): material = measured + wastage, rounded UP to full boxes.
 *    Labour = the measured m2 only, no wastage.
 *  - Broadloom (carpet, sheet vinyl, turf): material = measured + wastage,
 *    rounded UP to the next 0.1 lm of the roll width. Labour includes the
 *    wastage too: the same lm (or m2) as the material.
 *  - Carpet with no roll width, and the timber install type: flag and ask.
 *    Never guess.
 */

export type SoldAs = "box" | "broadloom";
export const SOLD_AS = ["box", "broadloom"] as const;

export const FLOOR_TYPES = [
  "carpet",
  "carpet_tile",
  "vinyl_plank",
  "sheet_vinyl",
  "hybrid",
  "laminate",
  "timber",
  "turf",
] as const;
export type FloorType = (typeof FLOOR_TYPES)[number];

export const FLOOR_TYPE_LABELS: Record<FloorType, string> = {
  carpet: "Carpet",
  carpet_tile: "Carpet tiles",
  vinyl_plank: "Vinyl plank",
  sheet_vinyl: "Sheet vinyl",
  hybrid: "Hybrid",
  laminate: "Laminate",
  timber: "Timber",
  turf: "Turf",
};

/** Settings key holding the starting wastage % for a floor type. Missing = 0%. */
export const wastageKey = (t: FloorType) => `wastage_pct_${t}`;

export function wastageFromSettings(settings: Record<string, string | undefined>, t: FloorType | null): number {
  if (!t) return 0;
  const n = Number(settings[wastageKey(t)]);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export type ProductShape = {
  category: string;
  unit: string;
  soldAs?: string | null;
  widthM?: number | null;
  unitsPerPack?: number | null;
  unitM2?: number | null;
  packM2Printed?: number | null;
  rollM2?: number | null;
};

/**
 * The Box or Broadloom tag a product should carry. Same rule as
 * database/sql/2026-10-10-wastage-labour.sql, used for new products.
 */
export function autoSoldAs(p: ProductShape): SoldAs | null {
  if (p.category === "carpet" || p.category === "turf") return "broadloom";
  if (["carpet_tile", "hybrid", "laminate", "timber"].includes(p.category)) return p.unit === "m2" ? "box" : null;
  if (p.category === "vinyl") {
    if (p.unitsPerPack != null || p.packM2Printed != null) return "box";
    if (p.widthM != null || p.rollM2 != null) return "broadloom";
    return "box";
  }
  return null;
}

const tagOf = (p: ProductShape): SoldAs | null =>
  p.soldAs === "box" || p.soldAs === "broadloom" ? p.soldAs : null;

/** Which wastage and install rule a product falls under. Null = not a floor sold by area. */
export function floorTypeOf(p: ProductShape): FloorType | null {
  const tag = tagOf(p);
  if (!tag) return null;
  switch (p.category) {
    case "carpet":
      return "carpet";
    case "carpet_tile":
      return "carpet_tile";
    case "vinyl":
      return tag === "broadloom" ? "sheet_vinyl" : "vinyl_plank";
    case "hybrid":
    case "laminate":
    case "timber":
    case "turf":
      return p.category;
    default:
      return null;
  }
}

/** m2 in one box. The exact count x tile size where known, the supplier's printed figure otherwise. */
export function boxM2Of(p: ProductShape): number | null {
  if (p.unitsPerPack && p.unitM2) return Math.round(p.unitsPerPack * p.unitM2 * 10_000) / 10_000;
  return p.packM2Printed && p.packM2Printed > 0 ? p.packM2Printed : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
/**
 * Round DOWN to 4 places. A box line's m2 must never sit a hair over its whole
 * boxes, or the purchase order (which rounds up to boxes) would order one more.
 */
const floor4 = (n: number) => Math.floor(n * 10_000 + 1e-6) / 10_000;
const fmt = (n: number) => String(r2(n));

export const NO_WIDTH_FLAG = "No roll width in the price book. Pick 3.66 m or 4.0 m on the line.";
export const NO_BOX_FLAG = "No box size in the price book, so this is not rounded to full boxes. Check the quantity.";
export const TIMBER_FLAG = "Pick the timber install: floating, direct stick, or secret nail. Or untick it.";
const ODD_WIDTH = "No carpet install for a ";
/** Flags this file sets, so they can be cleared once the gap is filled. */
export function isOwnFlag(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason === NO_WIDTH_FLAG || reason === NO_BOX_FLAG || reason === TIMBER_FLAG || reason.startsWith(ODD_WIDTH);
}
/** The flags that are about the install, cleared once one is added or ticked off. */
export function isInstallFlag(reason: string | null | undefined): boolean {
  return !!reason && (reason === TIMBER_FLAG || reason.startsWith(ODD_WIDTH));
}

export type QtyResult = {
  soldAs: SoldAs;
  /** Material qty in the product's own unit. */
  qty: number;
  /** Measured plus wastage. */
  totalM2: number;
  boxes: number | null;
  boxM2: number | null;
  lm: number | null;
  widthM: number | null;
  /** Labour qty when the install is priced per m2. */
  labourM2: number;
  /** Labour qty when the install is priced per lm. Null on box goods. */
  labourLm: number | null;
  problem: "no_width" | "no_box_size" | null;
  /** One plain line for under the quote line. */
  note: string;
};

/** Material and labour quantities for a measured area. Null when the product is not tagged. */
export function floorQty(
  p: ProductShape,
  measuredM2: number,
  wastagePct: number,
  rollWidthM?: number | null,
): QtyResult | null {
  const soldAs = tagOf(p);
  if (!soldAs) return null;
  const measured = Math.max(0, measuredM2);
  const w = Math.max(0, wastagePct);
  const totalM2 = r4(measured * (1 + w / 100));
  const head = w > 0 ? `${fmt(measured)} m² + ${fmt(w)}% = ${fmt(totalM2)} m²` : `${fmt(measured)} m², no wastage`;

  if (soldAs === "box") {
    const boxM2 = boxM2Of(p);
    if (!boxM2) {
      return {
        soldAs, qty: r2(totalM2), totalM2, boxes: null, boxM2: null, lm: null, widthM: null,
        labourM2: r4(measured), labourLm: null, problem: "no_box_size",
        note: `${head}. No box size, not rounded.`,
      };
    }
    const boxes = Math.ceil(totalM2 / boxM2 - 1e-9);
    const boxedM2 = floor4(boxes * boxM2);
    const byBox = p.unit === "box" || p.unit === "each" || p.unit === "pack";
    return {
      soldAs, qty: byBox ? boxes : boxedM2, totalM2, boxes, boxM2, lm: null, widthM: null,
      labourM2: r4(measured), labourLm: null, problem: null,
      note: `${head}. ${boxes} box${boxes === 1 ? "" : "es"} of ${fmt(boxM2)} m² = ${fmt(boxedM2)} m². Labour on ${fmt(measured)} m².`,
    };
  }

  const widthM = p.widthM && p.widthM > 0 ? p.widthM : rollWidthM && rollWidthM > 0 ? rollWidthM : null;
  if (!widthM) {
    return {
      soldAs, qty: p.unit === "lm" ? 0 : r2(totalM2), totalM2, boxes: null, boxM2: null, lm: null, widthM: null,
      labourM2: r4(totalM2), labourLm: null, problem: "no_width",
      note: `${head}. No roll width yet.`,
    };
  }
  const lm = Math.ceil((totalM2 / widthM) * 10 - 1e-9) / 10;
  const rolledM2 = r4(lm * widthM);
  return {
    soldAs, qty: p.unit === "lm" ? lm : rolledM2, totalM2, boxes: null, boxM2: null, lm, widthM,
    labourM2: rolledM2, labourLm: lm, problem: null,
    note: `${head}. ${fmt(lm)} lm off a ${fmt(widthM)} m roll = ${fmt(rolledM2)} m². Labour on the same.`,
  };
}

/** Labour qty for an install priced per `unit`. Null when the unit does not follow area (steps, each). */
export function labourQtyFor(res: QtyResult, unit: string): number | null {
  if (unit === "m2") return res.labourM2;
  if (unit === "lm") return res.labourLm;
  return null;
}

/* ------------------------------ install labour ----------------------------
 * Rate book item ids on live (labour_rate_items). Laminate uses Hybrid
 * installation (15), which Damien renames "hybrid/laminate install" himself.
 */
export const INSTALL_ITEMS: Record<FloorType, number[]> = {
  carpet: [1, 2, 5],
  carpet_tile: [4],
  vinyl_plank: [17, 18],
  sheet_vinyl: [19],
  hybrid: [15, 16],
  laminate: [15, 16],
  timber: [37, 38, 39],
  turf: [],
};

export type InstallPick =
  | { kind: "item"; itemId: number }
  /** Damien has to choose. `reason` goes on the line. */
  | { kind: "ask"; reason: string }
  /** Nothing in the rate book for this floor (turf). */
  | { kind: "none" };

const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

export function defaultInstall(t: FloorType | null, widthM: number | null): InstallPick {
  switch (t) {
    case "carpet":
      if (widthM == null) return { kind: "ask", reason: NO_WIDTH_FLAG };
      if (near(widthM, 3.66)) return { kind: "item", itemId: 1 };
      if (near(widthM, 4)) return { kind: "item", itemId: 2 };
      return { kind: "ask", reason: `${ODD_WIDTH}${fmt(widthM)} m roll. Pick the install, or untick it.` };
    case "carpet_tile":
      return { kind: "item", itemId: 4 };
    case "vinyl_plank":
      return { kind: "item", itemId: 17 };
    case "sheet_vinyl":
      return { kind: "item", itemId: 19 };
    case "hybrid":
    case "laminate":
      return { kind: "item", itemId: 15 };
    case "timber":
      return { kind: "ask", reason: TIMBER_FLAG };
    default:
      return { kind: "none" };
  }
}

/** The floor an install item is for, when it is one of the installs above. */
export function floorForInstall(itemId: number | null | undefined): FloorType[] {
  if (itemId == null) return [];
  return FLOOR_TYPES.filter((t) => INSTALL_ITEMS[t].includes(itemId));
}
