import { createHash } from "node:crypto";

/**
 * Client bundles. The client only ever sees a bundle's title, its wording and
 * its total (ex GST). Never qty, m2, rates or line prices. Those stay in the
 * back end, on the quote lines.
 *
 * Combined mode: one bundle ("all") holding every line.
 * Split mode: one bundle per floor type, plus "extras" for prep, removal,
 * disposal and anything else that is not a floor. In Live quotes (slice 5)
 * the split bundles become the options a client can pick.
 */

import {
  ALL,
  BUNDLE_TITLES,
  EXTRAS,
  FLOOR_CATEGORIES,
  LINE_CATEGORIES,
  type FloorCategory,
} from "./bundleCatalog";

export {
  ALL,
  BUNDLE_MODES,
  BUNDLE_TITLES,
  CATEGORY_LABELS,
  EXTRAS,
  FLOOR_CATEGORIES,
  LINE_CATEGORIES,
  type BundleMode,
  type FloorCategory,
} from "./bundleCatalog";

const isFloor = (c: string | null | undefined): c is FloorCategory =>
  !!c && (FLOOR_CATEGORIES as readonly string[]).includes(c);

export type BundleLine = {
  id: number;
  kind: string;
  description: string;
  productId: number | null;
  /** The product's price book category, when the line has a product. */
  productCategory: string | null;
  /** Set by hand. Wins over everything. */
  floorCategory: string | null;
  total: number;
  sortOrder?: number;
};

/** Floor words in a line's own text, most specific first. */
const KEYWORDS: [RegExp, FloorCategory][] = [
  [/carpet\s*tile/i, "carpet_tile"],
  [/sheet\s*vinyl|vinyl\s*sheet|\bsheet\b/i, "sheet_goods"],
  [/\bhybrid\b/i, "hybrid"],
  [/laminate/i, "laminate"],
  [/\bturf\b|artificial\s*grass|synthetic\s*grass/i, "turf"],
  [/timber|engineered|\boak\b|parquet|herringbone|chevron|sanding|\bsand\b|polish|floorboard/i, "timber"],
  [/\bvinyl\b|\blvt\b|\bspc\b|\bplank\b/i, "vinyl"],
  [/carpet|broadloom/i, "carpet"],
];

function keywordCategory(text: string): FloorCategory | null {
  for (const [re, cat] of KEYWORDS) if (re.test(text)) return cat;
  return null;
}

/**
 * The bundle each line belongs to in split mode, and whether that was worked
 * out (auto) or set by hand.
 *
 *  1. Set by hand: that.
 *  2. Prep and removal lines: extras. So is any non-floor line whose words say
 *     uplift, removal, disposal, levelling, grinding, furniture and the like.
 *  3. A floor product: its category.
 *  4. Labour: the floor its own words name ("Carpet stairs" goes with carpet).
 *  5. Underlay, accessories, other labour: the floor they most likely go with.
 *     Underlay goes with carpet if there is carpet, then the first floating
 *     floor. Otherwise the only floor on the quote, or the biggest one.
 *  6. Nothing to go with: extras.
 */
/** Work that is not laying a floor: it goes in "Preparation, removal and disposal". */
const PREP_REMOVAL =
  /\b(?:uplift|removal|remove|disposal|dispose|rip(?:ping)?[ -]?up|strip(?:ping)? out|levell?ing|self[ -]?level\w*|grind(?:ing)?|screed\w*|moisture barrier|floor prep\w*|preparation|skip bin|furniture)\b/i;

export function assignCategories(lines: BundleLine[]): Map<number, { key: string; auto: boolean }> {
  const out = new Map<number, { key: string; auto: boolean }>();
  const pending: BundleLine[] = [];

  for (const l of lines) {
    if (l.floorCategory && (LINE_CATEGORIES as readonly string[]).includes(l.floorCategory)) {
      out.set(l.id, { key: l.floorCategory, auto: false });
    } else if (l.kind === "prep" || l.kind === "removal") {
      out.set(l.id, { key: EXTRAS, auto: true });
    } else if (isFloor(l.productCategory)) {
      out.set(l.id, { key: l.productCategory, auto: true });
    } else if (PREP_REMOVAL.test(l.description)) {
      // "Carpet uplift/removal" is removal, even though it names a floor.
      out.set(l.id, { key: EXTRAS, auto: true });
    } else if (l.kind === "labour" && keywordCategory(l.description)) {
      out.set(l.id, { key: keywordCategory(l.description)!, auto: true });
    } else {
      pending.push(l);
    }
  }

  // Floors on the quote, biggest first, from lines already placed.
  const size = new Map<string, number>();
  for (const l of lines) {
    const k = out.get(l.id)?.key;
    if (k && k !== EXTRAS) size.set(k, (size.get(k) ?? 0) + Math.abs(l.total));
  }
  const floors = [...size.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  for (const l of pending) {
    let key: string | null = null;
    const named = keywordCategory(l.description);
    if (named && floors.includes(named)) key = named;
    else if (l.productCategory === "underlay") {
      key = floors.includes("carpet")
        ? "carpet"
        : (floors.find((f) => ["hybrid", "laminate", "timber", "vinyl"].includes(f)) ?? floors[0] ?? null);
    } else key = floors[0] ?? null;
    out.set(l.id, { key: key ?? EXTRAS, auto: true });
  }
  return out;
}

/**
 * What the wording was written for. Changes when a line is added, removed or
 * swapped to another product. Qty and price changes do not count: the wording
 * never states them.
 */
export function lineSignature(lines: Pick<BundleLine, "kind" | "productId" | "description">[]): string {
  const parts = lines
    .map((l) => `${l.kind}|${l.productId ?? ""}|${l.description.trim().toLowerCase().replace(/\s+/g, " ")}`)
    .sort();
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export type SavedBundle = {
  bundleKey: string;
  title: string;
  wording: string;
  wordingSource: string;
  lineSignature: string;
};

export type Bundle = {
  key: string;
  title: string;
  wording: string;
  wordingSource: string;
  /** Ex GST. */
  total: number;
  lineIds: number[];
  signature: string;
  /** Wording was written for different lines. */
  stale: boolean;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The bundles a quote shows the client right now, in print order. */
export function buildBundles(mode: string, lines: BundleLine[], saved: SavedBundle[]): Bundle[] {
  const savedBy = new Map(saved.map((s) => [s.bundleKey, s]));
  const ordered = [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);

  const groups = new Map<string, BundleLine[]>();
  if (mode === "split") {
    const cats = assignCategories(ordered);
    for (const l of ordered) {
      const key = cats.get(l.id)!.key;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(l);
    }
    // Extras always print last.
    const extras = groups.get(EXTRAS);
    if (extras) {
      groups.delete(EXTRAS);
      groups.set(EXTRAS, extras);
    }
  } else {
    groups.set(ALL, ordered);
  }

  return [...groups.entries()].map(([key, group]) => {
    const s = savedBy.get(key);
    const signature = lineSignature(group);
    return {
      key,
      title: s?.title || BUNDLE_TITLES[key] || key,
      wording: s?.wording ?? "",
      wordingSource: s?.wordingSource ?? "",
      total: round2(group.reduce((sum, l) => sum + (l.total ?? 0), 0)),
      lineIds: group.map((l) => l.id),
      signature,
      stale: !!s?.wording && s.lineSignature !== signature,
    };
  });
}

/* ------------------------------------------------------------------------- */
/* Wording clean up. Applied to everything the AI writes.                    */
/* ------------------------------------------------------------------------- */

const MEASURE =
  /\b(?:approx\.?\s*)?\d+(?:[.,]\d+)?\s*(?:m2|m²|sqm|sq\.?\s?m|square\s+met(?:re|er)s?|lm|l\/m|lineal\s+met(?:re|er)s?|linear\s+met(?:re|er)s?|met(?:re|er)s?|steps?|stairs?|treads?|rolls?|boxes|packs?)\b/gi;
const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:per|\/)\s*\w+)?/gi;

/**
 * No dashes (em or en), no prices, no quantities. Thickness in mm and product
 * sizes stay: those describe the product, not how much of it.
 */
export function cleanWording(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(MONEY, "")
    .replace(MEASURE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A sample of the house style, from Damien. */
export const STYLE_SAMPLE =
  'To supply and install Sunstar "Classic Oak Herringbone" engineered oak flooring (colour to be advised) to master bedroom and walk-in robe, direct stick to the levelled substrate. Uplift existing carpet and underlay and dispose of offsite. Remove and de-nail existing skirting boards and reattach on completion. Light grind slab and double prime, then self level floor using Sika self levelling compound at approx. 15mm thickness, to finish flush with the flooring outside the bedroom. Any elevated moisture within the concrete slab can only be assessed once the existing flooring has been removed and the substrate is fully exposed. Any additional works required will be discussed and quoted separately prior to proceeding.';

/** Line text for the AI with qty and money removed, so it cannot repeat them. */
export function lineForPrompt(l: { kind: string; description: string; productCategory: string | null }): string {
  const d = cleanWording(l.description).replace(/\s*,\s*\d+\s+[a-z ]+$/i, "");
  return `- ${l.kind}${l.productCategory ? ` (${l.productCategory})` : ""}: ${d}`;
}
