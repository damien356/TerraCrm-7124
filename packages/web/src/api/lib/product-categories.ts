/**
 * The price book's categories, in one place. No server imports here, so the
 * web app, the API and the voice agent all use the same list and labels.
 *
 * Fix list 11 Oct, item 10: "timber" is split into Engineered timber and
 * Solid timber. Damien, same day: the MJS 2.0 m outdoor ranges get their own
 * "Outdoor carpet" category so they keep their 2.0 m width. Item 3 (answer
 * 10): underlay is two categories, carpet underlay (lm, follows the carpet)
 * and hard floor underlay (m2 of floor plus wastage).
 */

export const PRODUCT_CATEGORIES = [
  "carpet",
  "outdoor_carpet",
  "carpet_tile",
  "vinyl",
  "hybrid",
  "laminate",
  "engineered_timber",
  "solid_timber",
  "carpet_underlay",
  "hard_floor_underlay",
  "turf",
  "sheet_goods",
  "accessory",
  "trim",
  "scotia",
  "stair_nosing",
  "skirting",
] as const;

export const PRODUCT_CATEGORY_LABELS: Record<string, string> = {
  carpet: "Broadloom carpet",
  outdoor_carpet: "Outdoor carpet",
  carpet_tile: "Carpet tile",
  vinyl: "Vinyl",
  hybrid: "Hybrid",
  laminate: "Laminate",
  engineered_timber: "Engineered timber",
  solid_timber: "Solid timber",
  carpet_underlay: "Carpet underlay",
  hard_floor_underlay: "Hard floor underlay",
  turf: "Synthetic turf",
  /** Plywood. Not a floor covering, the substrate that goes under one. */
  sheet_goods: "Sheet goods",
  accessory: "Accessory",
  /** Import fixes 26 Oct (Damien): trims, scotia, stair nosing and skirting get their own categories. */
  trim: "Trims",
  scotia: "Scotia",
  stair_nosing: "Stair nosing",
  skirting: "Skirting",
  /** Old names, before the splits. Nothing on file uses them now. */
  timber: "Timber",
  underlay: "Underlay",
};

export const categoryLabel = (c: string) => PRODUCT_CATEGORY_LABELS[c] ?? c;

/**
 * Accessories plus the four sold-by-the-length categories (26 Oct). Everything
 * that treated "accessory" as "a trim" (whole lengths, rolls, colours on the
 * selection form) treats these the same.
 */
export const LENGTH_CATEGORIES = ["trim", "scotia", "stair_nosing", "skirting"] as const;
export const isAccessoryCategory = (c: string | null | undefined) =>
  c === "accessory" || (LENGTH_CATEGORIES as readonly string[]).includes(c ?? "");

export const TIMBER_CATEGORIES = ["engineered_timber", "solid_timber"] as const;

/** True for either timber category, and the old single "timber" one. */
export const isTimberCategory = (c: string | null | undefined) =>
  c === "timber" || (TIMBER_CATEGORIES as readonly string[]).includes(c ?? "");

/**
 * The categories a spoken or typed category means. "timber" on its own covers
 * both kinds, so a voice quote that only says "timber" still finds the boards.
 * "underlay" covers both underlays the same way.
 */
export function categoriesForHint(hint: string): string[] {
  if (hint === "timber") return [...TIMBER_CATEGORIES, "timber"];
  if (hint === "underlay") return ["carpet_underlay", "hard_floor_underlay", "underlay"];
  if (hint === "accessory") return ["accessory", ...LENGTH_CATEGORIES];
  return [hint];
}

/** Whether a product's category is what the hint asked for. */
export const categoryMatchesHint = (hint: string, category: string) => categoriesForHint(hint).includes(category);

/* --------------------------------- item 1 ---------------------------------
 * Carpet roll widths (fix list 11 Oct). Every broadloom carpet is 3.66 m,
 * except these Belgotex ranges, which are 4.0 m. Outdoor carpet keeps its own.
 */
export const BELGOTEX_4M_RANGES = [
  "Baltimore",
  "Parkview Gardens",
  "Riverside Reserve",
  "Sheer Bliss",
  "Sumptuous",
  "Westminster",
  "Alexandria",
  "Benghazi",
  "Cobbleridge",
  "Stoneridge",
  "Avenue",
  "Belle",
  "Boulevard",
  "Key West",
  "Naples",
  "Palm Beach",
] as const;

const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const FOUR_M = new Set(BELGOTEX_4M_RANGES.map(squash));

/** The roll width a broadloom carpet gets by rule. Null for anything that is not broadloom carpet. */
export function carpetWidthByRule(p: { category: string; supplier?: string | null; brand?: string | null; range?: string | null }): number | null {
  if (p.category !== "carpet") return null;
  const belgotex = /belgotex/i.test(`${p.supplier ?? ""} ${p.brand ?? ""}`);
  return belgotex && FOUR_M.has(squash(p.range)) ? 4 : 3.66;
}
