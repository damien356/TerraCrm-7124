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
  /** 7 Nov catalog answers: new skirting at $10 a lm installer rate, and removal only at $5 (sql/2026-12-01-skirting-labour.sql). */
  newSkirting: { id: 121, name: "Install new skirting" },
  skirtingRemovalOnly: { id: 122, name: "Skirting removal only" },
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
 * Install trims/scotia on a laminate or hybrid floor (7 Nov): one line per
 * floor area, each for that area's own length. Separate areas add up (10 lm
 * of laminate and 15 lm of hybrid is 25 lm), and a trim or scotia added to
 * an area is covered by that area's line, never charged again.
 */
export const AREA_TRIM_WHAT = "trim and scotia install length (lm) for this floor area only";

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
    labour(RATE.trimInstall, "enter", AREA_TRIM_WHAT),
    labour(RATE.skirting, "enter", "skirting length (lm)"),
  ],
  hybrid: [
    labour(RATE.trimInstall, "enter", AREA_TRIM_WHAT),
    labour(RATE.skirting, "enter", "skirting length (lm)"),
  ],
  solid_timber: [product(PRODUCT.plywood, "sheets"), labour(RATE.sanding, "measured_m2")],
};

/**
 * Commercial vinyl rolls (7 Nov). Damien's 6 Nov answer was "All roll (sheet)
 * vinyl", but the price book also has wall vinyl and 4 m ranges that may be
 * residential. Until he confirms, only these price book tiers count as
 * commercial and get skim, coving, corners and hot welding. Every other sheet
 * vinyl gets nothing put on and is flagged for a decision.
 */
export const COMMERCIAL_SHEET_TIERS = ["Commercial Sheet", "Safety Sheet"] as const;
export function isCommercialSheet(p: { tier?: string | null }) {
  const t = (p.tier ?? "").trim().toLowerCase();
  return COMMERCIAL_SHEET_TIERS.some((c) => c.toLowerCase() === t);
}

/** The price book categories Damien's table covers. One with no Sold as cannot be told apart, so nothing goes on. */
export const DEFAULT_CATEGORIES = ["carpet", "vinyl", "laminate", "hybrid", "solid_timber"] as const;
export function needsClassifying(p: { category: string | null; soldAs?: string | null }) {
  return (DEFAULT_CATEGORIES as readonly string[]).includes(p.category ?? "") && p.soldAs !== "box" && p.soldAs !== "broadloom";
}

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

/**
 * The products that bring Install trims/scotia: Scotia, Trim, and Accessories
 * named as a trim. 7 Nov (second brief): end profiles, C channels, reducers
 * and top covers are trims too. Stair nosings are not (their own labour).
 */
const TRIM_WORDS = /scotia|trim|profile|channel|reducer|top cover/i;
const NOT_TRIM_WORDS = /nosing|stair/i;
/**
 * Catalog decisions (Damien, 7 Nov): a base plate or base channel is an insert
 * that goes under a top trim, not a finished trim. It is bought in lengths like
 * one, but brings no install of its own: the top trim's install covers the run.
 */
const COMPONENT_WORDS = /base\s*plate|base\s*channel/i;
export function isTrimComponent(p: { brand?: string | null; range?: string | null; colour?: string | null }) {
  return COMPONENT_WORDS.test([p.brand, p.range, p.colour].filter(Boolean).join(" "));
}
export function isTrimProduct(p: { category: string | null; brand?: string | null; range?: string | null; colour?: string | null }) {
  if (isTrimComponent(p)) return false;
  if (p.category === "scotia" || p.category === "trim") return true;
  if (p.category !== "accessory") return false;
  const name = [p.brand, p.range, p.colour].filter(Boolean).join(" ");
  return TRIM_WORDS.test(name) && !NOT_TRIM_WORDS.test(name);
}

/**
 * New skirting boards (Damien, 7 Nov): the price book's Skirting products,
 * the Mitre 10 pine mouldings. Each brings Install new skirting under it at
 * the lm installed, or flagged to fill in. Not a trim: no Install trims/scotia.
 */
export const SKIRTING_KEY = "skirting";
export function isNewSkirting(p: { category: string | null }) {
  return p.category === "skirting";
}
/** A trim, scotia or new skirting: takes the lm installed, and the supply is whole lengths off it. */
export function takesInstalledLm(p: { category: string | null; brand?: string | null; range?: string | null; colour?: string | null }) {
  return isTrimProduct(p) || isNewSkirting(p);
}

/**
 * 7 Nov (second brief): the installed lm typed in when a trim was added, kept
 * on the trim line as "trim:installed:<lm>". The supply is whole lengths off
 * it; the install is this, never the supplied metres.
 */
export const installedKey = (lm: number) => `${TRIM_KEY}:installed:${Math.round(lm * 10_000) / 10_000}`;
export const installedOf = (applied: string[]) => {
  const k = applied.find((a) => a.startsWith(`${TRIM_KEY}:installed:`));
  const n = k ? Number(k.split(":")[2]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
/**
 * On an Install trims/scotia line: the lm this feature last set it to, off
 * the installed lm of the trims it covers ("trim:auto:<lm>"). A qty that no
 * longer matches it (or any qty above 0 with no such key) was typed by hand,
 * and is never changed.
 */
export const autoKey = (lm: number) => `${TRIM_KEY}:auto:${Math.round(lm * 10_000) / 10_000}`;
export const autoOf = (applied: string[]) => {
  const k = applied.find((a) => a.startsWith(`${TRIM_KEY}:auto:`));
  const n = k ? Number(k.split(":")[2]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Sheet vinyl the price book marks as wall cladding (7 Nov, second brief). A
 * verified type: no coving or welding goes on, and it is not flagged as an
 * unclassified roll.
 */
export const WALL_VINYL_TIER = "Wall Vinyl";
export function isWallVinyl(p: { tier?: string | null }) {
  return (p.tier ?? "").trim().toLowerCase() === WALL_VINYL_TIER.toLowerCase();
}
/**
 * Catalog decisions (Damien, 7 Nov): sheet ranges he confirmed as domestic
 * (MJS Easy Living, Inspire, Trojan, Trojan Plus). A verified type: the
 * commercial skim, coving, corners and welding do not go on, and it is not
 * flagged as an unclassified roll. Normal install and anything added by hand stay.
 */
export const DOMESTIC_SHEET_TIER = "Domestic Sheet";
export function isDomesticSheet(p: { tier?: string | null }) {
  return (p.tier ?? "").trim().toLowerCase() === DOMESTIC_SHEET_TIER.toLowerCase();
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
export const SKIRTING_FLAG = enterFlag("new skirting install length (lm)");
/**
 * 7 Nov: the $3.00 a m2 and 15% came from Damien's 6 Nov question form only,
 * with no separate sign off, so nothing is filled in for him. Until an Admin
 * puts them in Settings, every disposal line is on at $0 with this flag.
 */
export const DISPOSAL_NO_RATE_FLAG =
  "Disposal rate not set. Put the carpet disposal cost and markup in Settings, or remove the line.";
/** What was proposed, shown on the Settings card while the figures are blank. Never used as a price. */
export const DISPOSAL_PROPOSED = { cost: 3, markupPct: 15, from: "Damien's answers to the quote defaults questions, 6 Nov 2026" } as const;
export const DISPOSAL_NO_QTY_FLAG = `${DEFAULT_FLAG_PREFIX} Enter the disposal m² (uplift lm times the roll width), or remove the line.`;
export const DISPOSAL_ORPHAN_FLAG = "Carpet uplift removed. Review or remove this disposal allowance.";
/** A default left over from the product the line was before it was changed. */
export const changedFlag = (was: string, now: string) =>
  `Product changed from ${was} to ${now}. This was put on for the ${was}. Check it is still needed, or remove it.`;

export const UNCLASSIFIED_MARK = "Not classified:";
export const unclassifiedFlag = (name: string) =>
  `${UNCLASSIFIED_MARK} ${name} has no Sold as (box or roll) in the price book, so its standard lines were not put on. Set Sold as on the product in Settings and add it again, or mark this reviewed.`;
export const NOT_COMMERCIAL_MARK = "Sheet vinyl not marked commercial";
export const notCommercialFlag = (tier: string | null | undefined) =>
  `${NOT_COMMERCIAL_MARK} (price book tier ${tier?.trim() ? `"${tier.trim()}"` : "blank"}). Skim, coving, corners and hot welding were not put on. Add any that are needed, or mark this reviewed.`;
export const TRIM_PICK_FLAG =
  "More than one floor area has Install trims/scotia. Pick the area this goes with (Install with, on this line), or mark this reviewed.";
export const TRIM_INSTALL_GONE_FLAG =
  "The Install trims/scotia line that covered this was removed. Pick another area on this line, or mark this reviewed if no install is needed.";
/**
 * 7 Nov (second brief), on an Install trims/scotia line. Either its length
 * was typed by hand (kept, never changed) and a trim was added to it, or a
 * trim it covers has no installed length, so that trim is not counted. Both
 * clear when the length is typed again.
 */
export const TRIM_ADDED_MARK = "Check the Install trims/scotia length.";
export const trimTypedFlag = (trim: string, lm: number | null) =>
  `${TRIM_ADDED_MARK} It was typed by hand, so it was kept. ${trim} was added ${lm != null ? `with ${lm} lm installed` : "with no installed length"}. Type the length again if it does not include it, or mark this reviewed.`;
export const trimUnmeasuredFlag = (trims: string[]) =>
  `${TRIM_ADDED_MARK} ${trims.join(", ")} ${trims.length === 1 ? "has" : "have"} no installed length, so ${trims.length === 1 ? "it is" : "they are"} not counted. Type the full length, or mark this reviewed.`;
/** The flag with these sentences taken off. Null when nothing is left. */
export function withoutTrimAdded(reason: string | null | undefined): string | null {
  if (!reason) return null;
  let text = reason;
  for (let i = text.indexOf(TRIM_ADDED_MARK); i >= 0; i = text.indexOf(TRIM_ADDED_MARK)) {
    const end = text.indexOf("or mark this reviewed.", i);
    if (end < 0) break;
    text = `${text.slice(0, i)} ${text.slice(end + "or mark this reviewed.".length)}`;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}
/**
 * The flag with only the "check the length" sentences for these trims kept
 * (each sentence names its trim in quotes). A trim moved to another area, or
 * removed, takes its sentence with it. Other warnings are kept as they are.
 */
export function keepTrimAddedFor(reason: string | null | undefined, names: string[]): string | null {
  if (!reason) return null;
  const END = "or mark this reviewed.";
  let rest = reason;
  let out = "";
  for (let i = rest.indexOf(TRIM_ADDED_MARK); i >= 0; i = rest.indexOf(TRIM_ADDED_MARK)) {
    const end = rest.indexOf(END, i);
    if (end < 0) break;
    const sentence = rest.slice(i, end + END.length);
    out += ` ${rest.slice(0, i)}${names.some((n) => sentence.includes(n)) ? ` ${sentence}` : ""}`;
    rest = rest.slice(end + END.length);
  }
  const text = `${out} ${rest}`.replace(/\s+/g, " ").trim();
  return text || null;
}
export const AREA_GONE_MARK = "area this install was for was removed";
export const areaGoneFlag = (area: string, trims: string[]) =>
  `The ${area} ${AREA_GONE_MARK}. It still covers ${trims.join(", ")}. Check the length is only for ${trims.length === 1 ? "that" : "those"}, or remove it.`;
/**
 * A laminate or hybrid area added after a trim already brought its own
 * Install trims/scotia (7 Nov). Both lines start at 0 lm, so nothing is
 * charged twice by itself, but the office must not type the same length on
 * both. Stays on, and holds the send, until marked reviewed.
 */
export const TRIM_OVERLAP_MARK = "Also on this quote: Install trims/scotia under";
export const trimOverlapFlag = (names: string[]) =>
  `${TRIM_OVERLAP_MARK} ${names.join(", ")}. Count each length on one line only, then mark this reviewed.`;
/** Ends of the "enter the length" flags, so a typed qty takes off that part only. */
const ENTER_ENDS = ["or remove the line if it is not needed.", "once the carpet has a roll width."];
/** The flag with its leading "Put on by default. Enter ..." part taken off. Null when nothing is left. */
export function withoutEnterFlag(reason: string | null | undefined): string | null {
  if (!reason) return null;
  if (!reason.startsWith(DEFAULT_FLAG_PREFIX)) return reason;
  const ends = ENTER_ENDS.map((e) => {
    const i = reason.indexOf(e);
    return i < 0 ? -1 : i + e.length;
  }).filter((i) => i > 0);
  if (!ends.length) return null;
  const left = reason.slice(Math.min(...ends)).trim();
  return left || null;
}
export const MISSING_MARK = "Not put on by default:";
export const TRIM_MISSING_MARK = "Install trims/scotia not put on.";
export const SKIRTING_MISSING_MARK = "Install new skirting not put on.";
const CHANGED_MARK = "This was put on for the";

/* ------------------------------- area prep -------------------------------- */
/*
 * Area prep (Damien, 10 Nov 2026, job 188016: Grinding at 1 m2 on a 50 m2
 * carpet tile floor). An m2 preparation line (the rate book's prep group:
 * grinding, floor preparation, levelling, moisture barrier, hardboard,
 * floating floor removal) is linked to the floor area it is for and follows
 * that floor's measured m2, never the ordered m2 with waste. A different
 * qty is a partial area, confirmed with a reason, or a mismatch that stops
 * the quote going out. Work not measured in m2 keeps its own rule.
 */
export const PREP_KEY_PREFIX = "prep:";
export const prepKey = (rateItemId: number) => `${PREP_KEY_PREFIX}${rateItemId}`;
export const isPrepKey = (k: string | null | undefined) => !!k && k.startsWith(PREP_KEY_PREFIX) && !k.startsWith("prep:partial:");
const isM2Unit = (u: string | null | undefined) => /^(m2|m²|sqm)$/i.test((u ?? "").trim());
/** A rate book item that is area preparation, priced by the m2. */
export function isAreaPrepItem(i: { unit: string | null; groupName: string | null }) {
  return isM2Unit(i.unit) && (i.groupName ?? "").trim().toLowerCase() === "prep";
}
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
/** On a prep line in defaultsApplied: a partial area someone confirmed, and the floor m2 it was confirmed against. */
export const partialKey = (qty: number, floorM2: number) => `prep:partial:${r4(qty)}:${r4(floorM2)}`;
export function partialOf(applied: string[]): { qty: number; floorM2: number } | null {
  const k = applied.find((a) => a.startsWith("prep:partial:"));
  if (!k) return null;
  const [, , q, f] = k.split(":");
  const qty = Number(q);
  const floorM2 = Number(f);
  return Number.isFinite(qty) && Number.isFinite(floorM2) ? { qty, floorM2 } : null;
}
export const m2Text = (n: number) => `${Math.round(n * 100) / 100} m2`;
export const followsAreaLabel = (m2: number) => `Follows measured floor area: ${m2Text(m2)}`;
export const PREP_MISMATCH_MARK = "Quantity mismatch:";
const PREP_MISMATCH_END = "if it is not required.";
export const prepMismatchFlag = (areaM2: number, name: string, qty: number) =>
  `${PREP_MISMATCH_MARK} this floor area is ${m2Text(areaM2)} but ${name} is ${m2Text(qty)}. Follow the ${m2Text(areaM2)} area, confirm partial ${name.toLowerCase()} with a reason, or remove ${name.toLowerCase()} ${PREP_MISMATCH_END}`;
export const PREP_PICK_MARK = "Pick the floor area for";
const PREP_PICK_END = "confirm a partial area with a reason.";
export const prepPickFlag = (name: string, floors: number) =>
  floors === 0
    ? `${PREP_PICK_MARK} ${name}: no floor line on this quote has a measured area yet. Enter the floor's measured m2, then follow it, or ${PREP_PICK_END}`
    : `${PREP_PICK_MARK} ${name}: this quote has ${floors} measured floor areas. Pick the one it is for, or ${PREP_PICK_END}`;
export const PREP_PARTIAL_MARK = "Check the partial area:";
const PREP_PARTIAL_END = "or remove it if it is not needed.";
export const prepPartialReviewFlag = (name: string, qty: number, wasM2: number, nowM2: number) =>
  `${PREP_PARTIAL_MARK} ${name} was confirmed at ${m2Text(qty)} of a ${m2Text(wasM2)} floor, and the floor is now ${m2Text(nowM2)}. Confirm the partial area again with a reason, follow the ${m2Text(nowM2)} area, ${PREP_PARTIAL_END}`;
const PREP_FLAGS: Array<[string, string]> = [
  [PREP_MISMATCH_MARK, PREP_MISMATCH_END],
  [PREP_PICK_MARK, PREP_PICK_END],
  [PREP_PARTIAL_MARK, PREP_PARTIAL_END],
];
/** True when the reason carries an area prep warning. Mark reviewed is not enough for these. */
export function isPrepWarning(reason: string | null | undefined) {
  return !!reason && PREP_FLAGS.some(([m]) => reason.includes(m));
}
/** The reason with the area prep warnings taken off. Null when nothing is left. */
export function withoutPrepFlags(reason: string | null | undefined): string | null {
  if (!reason) return null;
  let text = reason;
  for (const [mark, end] of PREP_FLAGS) {
    for (let i = text.indexOf(mark); i >= 0; i = text.indexOf(mark)) {
      const j = text.indexOf(end, i);
      if (j < 0) break;
      text = `${text.slice(0, i)} ${text.slice(j + end.length)}`;
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * The warnings this feature puts on a line. While any is on a line, the
 * quote cannot be sent, accepted or made into a job (lib/quote-default-gate.ts).
 * Each one is filled in, marked reviewed, or the line removed.
 */
export function isDefaultWarning(reason: string | null | undefined) {
  if (!reason) return false;
  return [
    DEFAULT_FLAG_PREFIX,
    DISPOSAL_NO_RATE_FLAG,
    DISPOSAL_ORPHAN_FLAG,
    MISSING_MARK,
    TRIM_MISSING_MARK,
    SKIRTING_MISSING_MARK,
    CHANGED_MARK,
    UNCLASSIFIED_MARK,
    NOT_COMMERCIAL_MARK,
    TRIM_PICK_FLAG,
    TRIM_INSTALL_GONE_FLAG,
    AREA_GONE_MARK,
    TRIM_OVERLAP_MARK,
    TRIM_ADDED_MARK,
    PREP_MISMATCH_MARK,
    PREP_PICK_MARK,
    PREP_PARTIAL_MARK,
  ].some((m) => reason.includes(m));
}

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
