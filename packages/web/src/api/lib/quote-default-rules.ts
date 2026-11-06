/**
 * Quote defaults (Damien's brief, 6 Nov 2026, and his answers the same day).
 * What goes on by default with each floor, which products bring the trim
 * install, and the carpet disposal figures. No server imports, so the quote
 * builder can use them too. The writing lives in lib/quote-defaults.ts.
 *
 * His rule: he would rather remove a standard item that is not needed than
 * forget to add it. So these go on selected, not as suggestions, and each
 * can be edited or removed. One removed by hand is never put back.
 *
 * Every record is the existing one, matched by id AND name (or SKU), so a
 * renamed or missing record is flagged on the line instead of swapped for
 * something else.
 */
import type { FloorType } from "./flooring-qty";

/** Rate book items, live ids (labour_rate_items). Names as they are on file. */
export const RATE = {
  carpetUplift: { id: 7, name: "Carpet uplift" },
  skim: { id: 109, name: "Skim floor with Smoothing compound" },
  coving: { id: 21, name: "Vinyl Coving 100mm" },
  corners: { id: 102, name: "Corner in/external" },
  hotWelding: { id: 20, name: "Hot welding" },
  cuttingGyprock: { id: 120, name: "Cutting gyprock" },
  trimInstall: { id: 111, name: "Install trims/scotia" },
  skirting: { id: 65, name: "Skirting removal and refit" },
  sanding: { id: 114, name: "Sanding coating 1 coat Polyurethane and 1 coat 2 Pac." },
} as const;

/** Price book products, live ids. Matched on SKU too. */
export const PRODUCT = {
  superGreen: { id: 9912, sku: "710071", name: "Dunlop Carpetmate Super Green" },
  plywood: { id: 7234, sku: "PNCD241215", name: "Hurford's CD Non-Structural Pine Plywood" },
} as const;

/**
 * How a default's starting qty is worked out.
 *  - measured_m2: the floor's measured m2, no wastage (the real area).
 *  - uplift_lm: measured m2 over the roll width, no wastage, marked Check required.
 *  - enter: 0, flagged until the real length or count is typed in.
 *  - underlay: off the carpet, the same as underlay added by hand.
 *  - sheets: measured m2 over the sheet m2, up to whole sheets, no wastage.
 */
export type QtyRule = "measured_m2" | "uplift_lm" | "enter" | "underlay" | "sheets";

export type FloorDefault =
  | { key: string; type: "labour"; itemId: number; name: string; qty: QtyRule; what?: string }
  | { key: string; type: "product"; productId: number; sku: string; name: string; qty: QtyRule };

const labour = (r: { id: number; name: string }, qty: QtyRule, what?: string): FloorDefault => ({
  key: `floor:${r.id}`,
  type: "labour",
  itemId: r.id,
  name: r.name,
  qty,
  what,
});
const product = (p: { id: number; sku: string; name: string }, qty: QtyRule): FloorDefault => ({
  key: `product:${p.id}`,
  type: "product",
  productId: p.id,
  sku: p.sku,
  name: p.name,
  qty,
});

/**
 * Damien's table. "carpet" is broadloom only: carpet tiles are their own
 * floor type and get nothing. Commercial vinyl rolls are every sheet vinyl
 * (his answer). Engineered timber gets nothing.
 */
export const FLOOR_DEFAULTS: Partial<Record<FloorType, FloorDefault[]>> = {
  carpet: [product(PRODUCT.superGreen, "underlay"), labour(RATE.carpetUplift, "uplift_lm")],
  sheet_vinyl: [
    labour(RATE.skim, "measured_m2"),
    labour(RATE.coving, "enter", "coving length (lm)"),
    labour(RATE.corners, "enter", "number of corners"),
    labour(RATE.hotWelding, "enter", "hot welding length (lm)"),
  ],
  vinyl_plank: [labour(RATE.skim, "measured_m2")],
  laminate: [
    labour(RATE.cuttingGyprock, "enter", "gyprock cutting length (lm)"),
    labour(RATE.trimInstall, "enter", "trim and scotia install length (lm)"),
    labour(RATE.skirting, "enter", "skirting length (lm)"),
  ],
  hybrid: [
    labour(RATE.trimInstall, "enter", "trim and scotia install length (lm)"),
    labour(RATE.skirting, "enter", "skirting length (lm)"),
  ],
  solid_timber: [product(PRODUCT.plywood, "sheets"), labour(RATE.sanding, "measured_m2")],
};

/**
 * Jobs made by the two sale forms (lib/product-sale.ts SALE_SOURCE and
 * lib/materials-sale.ts MATERIALS_SOURCE). Supply only: no defaults, no trim
 * install, no disposal, even if a line is added to one later by hand.
 */
export const SUPPLY_ONLY_SOURCES = ["Product sale", "Installer (materials)"] as const;

/** Key of the trim install on a trim or scotia line, and of the disposal on an uplift line. */
export const TRIM_KEY = "trim";
export const DISPOSAL_KEY = "disposal";
/** On a trim line whose install was already on the quote: "trim:covered:<line id>". */
export const coveredKey = (lineId: number) => `${TRIM_KEY}:covered:${lineId}`;
export const coveredLineOf = (applied: string[]) => {
  const k = applied.find((a) => a.startsWith(`${TRIM_KEY}:covered:`));
  const id = k ? Number(k.split(":")[2]) : NaN;
  return Number.isFinite(id) ? id : null;
};

/** The products that bring Install trims/scotia: Scotia, Trim, and Accessories with scotia or trim in the name. */
export function isTrimProduct(p: { category: string | null; brand?: string | null; range?: string | null; colour?: string | null }) {
  if (p.category === "scotia" || p.category === "trim") return true;
  if (p.category !== "accessory") return false;
  return /scotia|trim/i.test([p.brand, p.range, p.colour].filter(Boolean).join(" "));
}

/* ------------------------------ carpet disposal ----------------------------- */

export const DISPOSAL_DESCRIPTION = "Carpet disposal - Terra Flooring (shop skip bin)";
/** Settings, Admin only (the words "cost" and "markup" keep them from anyone who cannot see costs). */
export const DISPOSAL_COST_KEY = "carpet_disposal_cost_per_m2";
export const DISPOSAL_MARKUP_KEY = "carpet_disposal_markup_pct";

/** A Settings figure as a number, or null when unset or not a number. */
export function settingNumber(v: string | null | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ---------------------------------- flags ---------------------------------- */

export const DEFAULT_FLAG_PREFIX = "Put on by default.";
export const enterFlag = (what: string) => `${DEFAULT_FLAG_PREFIX} Enter the ${what}, or remove the line if it is not needed.`;
export const UPLIFT_NO_WIDTH_FLAG = `${DEFAULT_FLAG_PREFIX} Enter the uplift length. It works out once the carpet has a roll width.`;
export const TRIM_FLAG = enterFlag("trim and scotia install length (lm)");
export const DISPOSAL_NO_RATE_FLAG =
  "Disposal rate not set. Put the carpet disposal cost and markup in Settings, or remove the line.";
export const DISPOSAL_NO_QTY_FLAG = `${DEFAULT_FLAG_PREFIX} Enter the disposal m² (uplift lm times the roll width), or remove the line.`;
export const DISPOSAL_ORPHAN_FLAG = "Carpet uplift removed. Review or remove this disposal allowance.";

/** A flag this feature set, so it can clear it once the line is filled in. */
export function isDefaultFlag(reason: string | null | undefined) {
  return !!reason && (reason.startsWith(DEFAULT_FLAG_PREFIX) || reason === DISPOSAL_NO_RATE_FLAG);
}

/** The defaults already put on for a line. */
export function appliedOf(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
