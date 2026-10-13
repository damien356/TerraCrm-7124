import { CARE_FLOORS, type CareFloor, type Fibre, type Pile } from "./care-codes";

/* ---------------------------------------------------------------------------
 * What a job put down, and whether the carpet is wool or loop. Pure.
 *
 * In order of trust:
 *   1. the office set it on the job (jobs.care_floors, jobs.fibre, jobs.pile)
 *   2. the products on the quote, with their Fibre and Pile from the price book
 *   3. the job's category (ServiceM8's job category on older jobs)
 *   4. the job title and notes, with stricter patterns because the notes say
 *      things like "remove carpet" on a vinyl job
 *
 * Fibre falls back from the product's Fibre, to its tier (EC Carpets keep the
 * fibre there, Belgotex keep WOOL there), to the Wool ranges list, to the word
 * "wool". Pile falls back to the words loop, berber or sisal.
 * ------------------------------------------------------------------------- */

export interface DetectProduct {
  category: string;
  soldAs?: string | null;
  fibre?: string | null;
  pile?: string | null;
  tier?: string | null;
  brand?: string | null;
  range?: string | null;
  colour?: string | null;
  notes?: string | null;
}

/** A price book category to a care floor. Underlay, turf, plywood and trims are not floors here. */
export function productFloor(p: DetectProduct): CareFloor | null {
  switch (p.category) {
    case "carpet":
    case "outdoor_carpet":
      return "carpet";
    case "carpet_tile":
      return "carpet_tiles";
    case "vinyl":
      return p.soldAs === "broadloom" ? "sheet_vinyl" : "vinyl_plank";
    case "hybrid":
      return "hybrid";
    case "laminate":
      return "laminate";
    case "engineered_timber":
    case "solid_timber":
    case "timber":
      return "engineered_timber";
    default:
      return null;
  }
}

const has = (re: RegExp, s: string) => re.test(s);

/** A job category or a quote line, read loosely. */
export function floorsFromCategory(raw: string | null | undefined): CareFloor[] {
  const s = ` ${(raw ?? "").toLowerCase()} `;
  if (!s.trim()) return [];
  const out = new Set<CareFloor>();
  if (has(/carpet\s*tiles?/, s)) out.add("carpet_tiles");
  const noTiles = s.replace(/carpet\s*tiles?/g, " ").replace(/carpet\s*clean\w*/g, " ");
  if (has(/carpet|broadloom/, noTiles)) out.add("carpet");
  if (has(/sheet\s*vinyl|vinyl\s*sheet|kitchen\s*vinyl|coving/, s)) out.add("sheet_vinyl");
  else if (has(/vinyl|lvt|\bspc\b/, s)) out.add("vinyl_plank");
  if (has(/hybrid/, s)) out.add("hybrid");
  if (has(/laminate|floating\s*floor/, s)) out.add("laminate");
  const sanding = has(/\bsand(ing|ed)?\b|re-?coat|polish/, s);
  if (sanding) out.add("sanding");
  if (has(/timber|engineered|parquet|hardwood|oak\s+board/, s) && !sanding) out.add("engineered_timber");
  return CARE_FLOORS.filter((f) => out.has(f));
}

/** Title and notes. Stricter: only phrases that mean the floor went in. */
export function floorsFromNotes(raw: string | null | undefined): CareFloor[] {
  const s = (raw ?? "").toLowerCase();
  if (!s.trim()) return [];
  const out = new Set<CareFloor>();
  if (has(/carpet\s*tiles?\b/, s)) out.add("carpet_tiles");
  if (has(/carpet\s*product:[ \t]*[a-z0-9]/, s) || has(/carpet\s*(install|installation|supply|laid)\b/, s) || has(/broadloom/, s)) out.add("carpet");
  if (has(/vinyl\s*plank|\blvt\b/, s)) out.add("vinyl_plank");
  if (has(/sheet\s*vinyl|vinyl\s*sheet/, s)) out.add("sheet_vinyl");
  if (has(/hybrid\s*(floor|plank|install|supply)/, s)) out.add("hybrid");
  if (has(/laminate\s*(floor|install|supply|m2|-)|laminate-/, s)) out.add("laminate");
  if (has(/engineered\s*(timber|oak|board)|timber\s*floor\s*(install|supply)/, s)) out.add("engineered_timber");
  if (has(/sand\s*(and|&)\s*(coat|polish)|floor\s*sanding|sanding\s*(and|&)\s*coating/, s)) out.add("sanding");
  /* "To supply and install Armstrong Kingswood 6.0mm hybrid", "Install only of Hurfords timber": the floor named soon after. */
  for (const m of s.matchAll(/\b(?:supply\s*(?:and|&)\s*install|install\s*only\s*of|to\s*install|to\s*supply)\b((?:[^.\n]|\.(?=\d)){0,80})/g)) {
    const t = m[1] ?? "";
    if (has(/carpet\s*tiles?\b/, t)) out.add("carpet_tiles");
    else if (has(/\bcarpet\b/, t)) out.add("carpet");
    if (has(/\bhybrid\b/, t)) out.add("hybrid");
    if (has(/\blaminate\b/, t)) out.add("laminate");
    if (has(/vinyl\s*plank|\blvt\b/, t)) out.add("vinyl_plank");
    else if (has(/sheet\s*vinyl|vinyl\s*sheet/, t)) out.add("sheet_vinyl");
    if (has(/\b(engineered|timber|oak)\b/, t)) out.add("engineered_timber");
  }
  return CARE_FLOORS.filter((f) => out.has(f));
}

export interface DetectJob {
  careFloors?: string | null;
  category?: string | null;
  title?: string | null;
  description?: string | null;
  /** Supply lines with a product on the quote, and materials on the job. */
  products: DetectProduct[];
  /** Every quote line description, for sand and coat labour lines. */
  lineTexts?: string[];
}

/** The office's own list, if they set one. */
export function parseFloors(raw: string | null | undefined): CareFloor[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    return CARE_FLOORS.filter((f) => v.includes(f));
  } catch {
    return null;
  }
}

export function detectFloors(j: DetectJob): { floors: CareFloor[]; from: "office" | "quote" | "category" | "notes" | "none" } {
  const set = parseFloors(j.careFloors);
  if (set) return { floors: set, from: "office" };

  const out = new Set<CareFloor>();
  for (const p of j.products) {
    const f = productFloor(p);
    if (f) out.add(f);
  }
  /* Sanding has no product, it is a labour line. */
  if ((j.lineTexts ?? []).some((t) => floorsFromNotes(t).includes("sanding") || /sand\s*(and|&)\s*coat/i.test(t))) out.add("sanding");
  if (out.size) return { floors: CARE_FLOORS.filter((f) => out.has(f)), from: "quote" };

  const cat = floorsFromCategory(j.category);
  if (cat.length) return { floors: cat, from: "category" };

  const notes = floorsFromNotes(`${j.title ?? ""}\n${j.description ?? ""}`);
  if (notes.length) return { floors: notes, from: "notes" };
  return { floors: [], from: "none" };
}

/* ---------------------------------------------------------------------------
 * Fibre and pile
 * ------------------------------------------------------------------------- */

/** What a supplier's tier column says about fibre. EC Carpets: "Pure Wool", "Solution Dyed Nylon". */
export function tierFibre(tier: string | null | undefined): Fibre | "" {
  const t = (tier ?? "").toLowerCase();
  if (!t) return "";
  if (/wool/.test(t)) return /blend|mix|\d+\s*\/\s*\d+/.test(t) && !/pure|100/.test(t) ? "wool_blend" : "wool";
  if (/nylon|\bsdn\b/.test(t)) return "nylon";
  if (/polyprop|olefin|\bsdp\b|\bpp\b/.test(t)) return "polypropylene";
  if (/polyester|\bpet\b|triexta/.test(t)) return "polyester";
  return "";
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Wool from free text: a range on the Wool ranges list, or the word wool. */
export function textFibre(text: string | null | undefined, woolRanges: string[]): Fibre | "" {
  const s = norm(text ?? "");
  if (!s) return "";
  if (/wool\s*(blend|mix|rich)|\d+\s*%\s*wool|wool\s*\/\s*\w+|\w+\s*\/\s*wool/.test(s) && !/pure\s*wool|100\s*%\s*wool/.test(s)) return "wool_blend";
  if (woolRanges.some((r) => r.trim() && s.includes(norm(r)))) return "wool";
  /* "wool wash" is cleaning advice, not the carpet. */
  if (/\bwool\b(?!\s*wash)/.test(s)) return "wool";
  return "";
}

export function textPile(text: string | null | undefined): Pile | "" {
  const s = (text ?? "").toLowerCase();
  if (/cut\s*(and|&|\/)\s*loop/.test(s)) return "cut_loop";
  if (/\bloop\b|\bberber\b|\bsisal\b/.test(s)) return "loop";
  return "";
}

export function productFibre(p: DetectProduct, woolRanges: string[]): Fibre | "" {
  if (p.fibre) return p.fibre as Fibre;
  return tierFibre(p.tier) || textFibre([p.brand, p.range, p.colour, p.notes].filter(Boolean).join(" "), woolRanges);
}

export function productPile(p: DetectProduct): Pile | "" {
  if (p.pile) return p.pile as Pile;
  return textPile([p.range, p.colour, p.notes].filter(Boolean).join(" "));
}

/** Wool beats a blend beats a synthetic: one wool carpet in the house gets the wool advice. */
const FIBRE_RANK: Record<string, number> = { wool: 5, wool_blend: 4, nylon: 2, polypropylene: 2, polyester: 2, not_wool: 1, unknown: 0, "": 0 };
export const strongerFibre = (a: string, b: string) => ((FIBRE_RANK[b] ?? 0) > (FIBRE_RANK[a] ?? 0) ? b : a);
const PILE_RANK: Record<string, number> = { loop: 3, cut_loop: 2, cut: 1, "": 0 };
export const strongerPile = (a: string, b: string) => ((PILE_RANK[b] ?? 0) > (PILE_RANK[a] ?? 0) ? b : a);

export interface DetectFibreJob {
  fibre?: string | null;
  pile?: string | null;
  title?: string | null;
  description?: string | null;
  category?: string | null;
  products: DetectProduct[];
  lineTexts?: string[];
}

/**
 * Fibre and pile for a carpet job. "unknown" means nobody can tell, which is
 * what raises the one-tap question to Damien.
 */
export function detectFibre(j: DetectFibreJob, woolRanges: string[]): { fibre: Fibre; pile: Pile | ""; from: string } {
  const carpets = j.products.filter((p) => productFloor(p) === "carpet");
  let pile: string = j.pile ?? "";
  for (const p of carpets) pile = strongerPile(pile, productPile(p));
  const text = [j.title, j.description, j.category, ...(j.lineTexts ?? [])].filter(Boolean).join("\n");
  if (!pile) pile = textPile(text);

  if (j.fibre && j.fibre !== "unknown") return { fibre: j.fibre as Fibre, pile: pile as Pile | "", from: "job" };
  let fibre = "";
  for (const p of carpets) fibre = strongerFibre(fibre, productFibre(p, woolRanges));
  if (fibre) return { fibre: fibre as Fibre, pile: pile as Pile | "", from: "quote" };
  fibre = textFibre(text, woolRanges);
  if (fibre) return { fibre: fibre as Fibre, pile: pile as Pile | "", from: "notes" };
  return { fibre: "unknown", pile: pile as Pile | "", from: "none" };
}
