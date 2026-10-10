import { and, eq, or, like, desc, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sellExGst } from "../lib/pricing";
import { liveSellFor } from "../lib/live-sell";
import { rateBook } from "../routes/labour";
import type { Extraction } from "./extract";

/**
 * Pass 2: turn a structured `Extraction` (see `extract.ts`) into priced
 * quote lines, shaped exactly like `quoteItems` rows so the caller can insert
 * them straight in. This is the ONLY place that touches the products table
 * and the labour rate book for the voice pipeline (the extraction model)
 * never sees either.
 */

export type PricedLine = {
  productId: number | null;
  kind: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  unitCost: number | null;
  flagged: boolean;
  flagReason: string | null;
  /** The normalised spoken phrase this line came from, kept for learning. */
  voicePhrase: string | null;
  /** Labour lines: the rate book item it was priced off. */
  rateItemId?: number | null;
};

function normalise(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
}

/** Token overlap, 0..1. Cheap and good enough for short product names. */
function tokenScore(a: string, b: string): number {
  const at = new Set(normalise(a).split(" ").filter(Boolean));
  const bt = new Set(normalise(b).split(" ").filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
  // "Cobble Ridge" heard for "Cobbleridge" is the same name.
  if ([...at].join("") === [...bt].join("")) return 1;
  let hit = 0;
  for (const t of at) if (bt.has(t)) hit++;
  return hit / Math.max(at.size, bt.size);
}

type ProductRow = typeof schema.products.$inferSelect;

/**
 * Score a candidate product against the hints Damien spoke. Weighted so a
 * range match (the most specific thing a supplier names) counts for more
 * than a loose colour match, and a category mismatch never wins.
 */
function scoreProduct(
  p: ProductRow,
  hints: { supplierHint: string | null; brandHint: string | null; rangeHint: string | null; colourHint: string | null; category: string | null; spokenDescription: string | null },
): number {
  let score = 0;
  let weight = 0;
  if (hints.supplierHint) {
    weight += 1;
    score += tokenScore(hints.supplierHint, p.supplier) * 1;
  }
  if (hints.brandHint) {
    weight += 1;
    score += tokenScore(hints.brandHint, p.brand) * 1;
  }
  if (hints.rangeHint) {
    weight += 2;
    score += tokenScore(hints.rangeHint, p.range) * 2;
  }
  if (hints.colourHint) {
    weight += 1;
    score += tokenScore(hints.colourHint, p.colour) * 1;
  }
  // No hints at all beyond the raw sentence: fall back to matching the whole
  // spoken line against supplier+brand+range+colour together.
  if (weight === 0 && hints.spokenDescription) {
    const whole = [p.supplier, p.brand, p.range, p.colour].filter(Boolean).join(" ");
    return tokenScore(hints.spokenDescription, whole);
  }
  if (weight === 0) return 0;
  let total = score / weight;
  if (hints.category && hints.category !== "unknown" && p.category !== hints.category) {
    total *= 0.3; // category mismatch drags a match down hard, never wins outright
  }
  return total;
}

/**
 * A confident match is required before a material line takes a product and
 * a price. Below this the line stays at $0 in his words, flagged, with the
 * closest product named for one tap.
 */
const CONFIDENT_MATCH_THRESHOLD = 0.6;

async function findBestProduct(hints: {
  supplierHint: string | null;
  brandHint: string | null;
  rangeHint: string | null;
  colourHint: string | null;
  category: string | null;
  spokenDescription: string | null;
}): Promise<{ product: ProductRow; score: number } | null> {
  const patterns: string[] = [];
  for (const h of [hints.supplierHint, hints.brandHint, hints.rangeHint, hints.colourHint]) {
    if (h) patterns.push(...normalise(h).split(" ").filter((w) => w.length > 2));
  }
  // Also look for a spoken two word range run together, "cobble ridge" as "cobbleridge".
  if (hints.rangeHint && normalise(hints.rangeHint).includes(" ")) patterns.push(normalise(hints.rangeHint).replace(/ /g, ""));

  let candidates: ProductRow[];
  if (patterns.length === 0) {
    // Nothing specific said beyond the sentence itself, narrow by category
    // only, then score every product in it. Categories are small enough
    // (a few hundred each) for this to be cheap.
    candidates = hints.category && hints.category !== "unknown"
      ? await db.select().from(schema.products).where(eq(schema.products.category, hints.category))
      : [];
  } else {
    const clauses = patterns.map((w) =>
      or(
        like(schema.products.supplier, `%${w}%`),
        like(schema.products.brand, `%${w}%`),
        like(schema.products.range, `%${w}%`),
        like(schema.products.colour, `%${w}%`),
      ),
    );
    candidates = await db.select().from(schema.products).where(or(...clauses));
  }

  if (candidates.length === 0) return null;

  let best: { product: ProductRow; score: number } | null = null;
  for (const p of candidates) {
    const s = scoreProduct(p, hints);
    if (!best || s > best.score) best = { product: p, score: s };
  }
  return best;
}

/**
 * A phrase Damien has already corrected before, once, wins outright over
 * the token-score guess. Picks whichever product has been confirmed against
 * this exact phrase the most times.
 */
async function findLearnedProduct(phraseKey: string): Promise<ProductRow | null> {
  if (!phraseKey) return null;
  const rows = await db
    .select({ product: schema.products })
    .from(schema.voicePhraseProductMatches)
    .innerJoin(schema.products, eq(schema.products.id, schema.voicePhraseProductMatches.productId))
    .where(eq(schema.voicePhraseProductMatches.phrase, phraseKey))
    .orderBy(desc(schema.voicePhraseProductMatches.confirmCount), desc(schema.voicePhraseProductMatches.lastConfirmedAt))
    .limit(1);
  return rows[0]?.product ?? null;
}

/* ---------------------------------------------------------------------------
 * Who he named, and what the line should read when nothing in the book fits.
 * ------------------------------------------------------------------------- */

/** Words that say nothing about which supplier: "Advantage Flooring supplier" is Advantage. */
const GENERIC = new Set(["flooring", "floors", "floor", "supplier", "suppliers", "carpets", "carpet", "floorcoverings", "the", "and", "from"]);
const core = (s: string) => normalise(s).split(" ").filter((w) => w && !GENERIC.has(w));

function sameWord(a: string, b: string) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/** The supplier he named, if it is one Terra buys from (whether or not it has products loaded). */
async function namedSupplier(hint: string | null): Promise<{ name: string; productCount: number } | null> {
  if (!hint) return null;
  const said = core(hint);
  if (!said.length) return null;
  const [table, inBook] = await Promise.all([
    db.select({ name: schema.suppliers.name }).from(schema.suppliers),
    db
      .select({ name: schema.products.supplier, n: sql<number>`count(*)` })
      .from(schema.products)
      .where(eq(schema.products.active, true))
      .groupBy(schema.products.supplier),
  ]);
  const counts = new Map(inBook.map((r) => [r.name, Number(r.n)]));
  const names = [...new Set([...table.map((t) => t.name), ...counts.keys()])];
  for (const name of names) {
    const words = core(name);
    if (words.length && words.every((w) => said.some((x) => sameWord(w, x)))) return { name, productCount: counts.get(name) ?? 0 };
  }
  return null;
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** "Advantage Flooring Hip Hop in Winter", built from what he said, never "43 linear metres of carpet". */
function spokenProductName(line: Extraction["lines"][number], supplier: string | null) {
  const parts = [supplier ?? line.supplierHint, line.brandHint, line.rangeHint].filter(Boolean).map((x) => titleCase(String(x).trim()));
  const named = [...new Set(parts)].join(" ");
  const colour = line.colourHint ? titleCase(line.colourHint.trim()) : "";
  if (named && colour) return `${named} in ${colour}`;
  return named || colour || null;
}

/**
 * The closest products in the book to a spoken line, best first. Feeds the
 * "Change product" list on a quote line, so the office picks from a handful
 * of real options instead of scrolling four thousand.
 */
export async function suggestProducts(phrase: string, limit = 6) {
  const words = normalise(phrase)
    .split(" ")
    .filter((w) => w.length > 2 && !/^\d+$/.test(w) && !["linear", "metres", "meters", "square", "colour", "color", "of", "got"].includes(w))
    .filter((w) => !GENERIC.has(w));
  if (!words.length) return [];
  const rows = await db
    .select()
    .from(schema.products)
    .where(
      and(
        eq(schema.products.active, true),
        or(
          ...words.map((w) =>
            or(
              like(schema.products.supplier, `%${w}%`),
              like(schema.products.brand, `%${w}%`),
              like(schema.products.range, `%${w}%`),
              like(schema.products.colour, `%${w}%`),
            ),
          ),
        ),
      ),
    )
    .limit(800);
  const scored = rows.map((p) => {
    const range = normalise(p.range);
    const colour = normalise(p.colour);
    const who = normalise(`${p.supplier} ${p.brand}`);
    let score = 0;
    for (const w of words) {
      if (range.split(" ").includes(w)) score += 3;
      else if (range.includes(w)) score += 1.5;
      if (colour.split(" ").includes(w)) score += 2;
      else if (colour.includes(w)) score += 1;
      if (who.split(" ").includes(w)) score += 1;
    }
    return { p, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}

const NOT_PRODUCT = new Set([
  "linear", "lineal", "metre", "metres", "meter", "meters", "square", "sqm", "lm", "m2", "m", "of", "the", "a",
  "colour", "color", "supplier", "got", "about", "roughly", "and", "in",
]);
/** The product-naming words of a line, for remembering a pick. */
export function learnKey(line: Pick<Extraction["lines"][number], "supplierHint" | "brandHint" | "rangeHint" | "colourHint" | "spokenDescription">) {
  // A colour alone ("green") is too loose to learn from, so it falls back to
  // the words he said ("green foam underlay").
  const hasName = Boolean(line.supplierHint || line.brandHint || line.rangeHint);
  const named = hasName ? [line.supplierHint, line.brandHint, line.rangeHint, line.colourHint].filter(Boolean).join(" ") : "";
  return normalise(named || line.spokenDescription || line.colourHint)
    .split(" ")
    .filter((w) => w && !/^\d+$/.test(w) && !NOT_PRODUCT.has(w))
    .join(" ");
}

/**
 * He said one unit and the product sells by another, so the quantity is
 * probably wrong. Say so rather than guess a conversion (carpet comes 3.6 m
 * or 4 m wide, and underlay is priced per lineal metre of carpet).
 */
function unitCheck(qty: number, said: string | null | undefined, sells: string) {
  if (!said || said === sells) return "";
  return `You said ${qty} ${said} and it sells by the ${sells}. Check the quantity.`;
}

async function priceMaterialLine(line: Extraction["lines"][number]): Promise<PricedLine> {
  const hints = {
    supplierHint: line.supplierHint,
    brandHint: line.brandHint,
    rangeHint: line.rangeHint,
    colourHint: line.colourHint,
    category: line.category,
    spokenDescription: line.spokenDescription,
  };
  const qty = line.qty;
  const unit = line.unit ?? "m2";
  const spoken = line.spokenDescription ?? "Material (unspecified)";
  // What gets learned is WHICH product he named, not how much of it: the
  // key leaves out quantities and units, so "43 lm of Hip Hop in Winter" and
  // "20 lm of Hip Hop in Winter" teach and find the same pick.
  const phraseKey = learnKey(line);

  const learned = phraseKey ? await findLearnedProduct(phraseKey) : null;
  if (learned) {
    const description = [learned.brand, learned.range, learned.colour].filter(Boolean).join(", ") || spoken;
    const note = unitCheck(qty, line.unit, learned.unit || unit);
    return {
      productId: learned.id,
      kind: learned.category === "labour" ? "labour" : "supply",
      description,
      qty,
      unit: learned.unit || unit,
      unitPrice: await liveSellFor(learned),
      unitCost: learned.costPrice ?? null,
      flagged: Boolean(note),
      flagReason: note || null,
      voicePhrase: phraseKey,
    };
  }

  const [match, supplier] = await Promise.all([findBestProduct(hints), namedSupplier(line.supplierHint)]);
  const asSaid = spokenProductName(line, supplier?.name ?? null) ?? spoken;

  // He named a supplier and the best guess is someone else's product. That is
  // never the right line (it once quoted Victoria Carpets Appleton for
  // Advantage Flooring Hip Hop), so the line keeps his words and waits.
  if (supplier && match && match.product.supplier !== supplier.name) {
    return {
      productId: null,
      kind: "supply",
      description: asSaid,
      qty,
      unit,
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason:
        supplier.productCount === 0
          ? `${supplier.name} has no products in the price book yet, so this is priced at $0. Put the price in, or tap Change product.`
          : `Couldn't find that in ${supplier.name}'s price list. Priced at $0. Tap Change product, or put the price in.`,
      voicePhrase: phraseKey || null,
    };
  }

  if (!match) {
    return {
      productId: null,
      kind: "supply",
      description: asSaid,
      qty,
      unit,
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason: "Nothing like it in the price book. Priced at $0. Tap Change product, or put the price in.",
      voicePhrase: phraseKey || null,
    };
  }

  const { product, score } = match;
  const guessName = [product.supplier, product.range, product.colour].filter(Boolean).join(" ");

  // Not a confident match means it is most likely not in the price book yet
  // (green foam underlay once came back as a vinyl). A guessed price on the
  // quote is worse than none, so the line keeps his words at $0 and names the
  // closest product, which Change product offers first.
  if (score < CONFIDENT_MATCH_THRESHOLD) {
    const words = line.spokenDescription?.trim();
    const named = titleCase(words && words.length <= 60 ? words : asSaid);
    // Only point at the closest product when it is the same sort of thing.
    const sameKind = !line.category || line.category === "unknown" || product.category === line.category;
    return {
      productId: null,
      kind: "supply",
      description: line.category === "underlay" && !/underlay/i.test(named) ? `${named} Underlay` : named,
      qty,
      unit,
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason: sameKind
        ? `Not in the price book yet, so this is priced at $0. Closest is ${guessName}. Tap Change product to use it or pick another, or put the price in.`
        : "Not in the price book yet, so this is priced at $0. Add it to the price book, tap Change product, or put the price in.",
      voicePhrase: phraseKey || null,
    };
  }

  const description = [product.brand, product.range, product.colour].filter(Boolean).join(", ") || spoken;
  const sells = product.unit || unit;
  const unitNote = unitCheck(qty, line.unit, sells);
  const flagged = Boolean(unitNote);

  return {
    productId: product.id,
    kind: product.category === "labour" ? "labour" : "supply",
    description,
    qty,
    unit: sells,
    unitPrice: await liveSellFor(product),
    unitCost: product.costPrice ?? null,
    flagged,
    flagReason: flagged ? unitNote : null,
    voicePhrase: null,
  };
}

async function priceLabourLine(line: Extraction["lines"][number]): Promise<PricedLine> {
  const itemId = line.labourItemId;
  if (itemId === null) {
    return {
      productId: null,
      kind: "labour",
      description: line.note ?? "Labour (unspecified)",
      qty: line.qty,
      unit: "each",
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason: "No labour rate book item was matched. Priced at $0. Pick the right item and reprice before sending.",
      voicePhrase: null,
    };
  }

  const [item] = await db.select().from(schema.labourRateItems).where(eq(schema.labourRateItems.id, itemId));
  const rates = await rateBook.loadRates([itemId]);
  const resolved = rateBook.pick(rates, itemId, null, rateBook.today());

  const description = item ? item.name : (line.note ?? `Labour item #${itemId}`);
  const unit = item?.unit ?? "each";
  const cost = resolved.amount;
  const unitPrice = cost === null ? 0 : sellExGst(cost);

  return {
    productId: null,
    kind: "labour",
    description: line.note ? `${description}, ${line.note}` : description,
    qty: line.qty,
    unit,
    unitPrice,
    unitCost: cost,
    flagged: cost === null,
    flagReason: cost === null ? `No current rate on file for "${description}". Priced at $0. Set a rate and reprice before sending.` : null,
    voicePhrase: null,
    rateItemId: item ? itemId : null,
  };
}

function priceOtherLine(line: Extraction["lines"][number]): PricedLine {
  const cost = line.spokenDollarAmount;
  const description = line.description ?? "Other";
  const qty = line.qty || 1;

  if (cost === null) {
    return {
      productId: null,
      kind: "other",
      description,
      qty,
      unit: "each",
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason: "Damien did not give a dollar figure for this line. Priced at $0. Fill it in before sending.",
      voicePhrase: null,
    };
  }

  return {
    productId: null,
    kind: "other",
    description,
    qty,
    unit: "each",
    unitPrice: sellExGst(cost),
    unitCost: cost,
    flagged: false,
    flagReason: null,
    voicePhrase: null,
  };
}

export async function priceExtraction(extraction: Extraction): Promise<PricedLine[]> {
  const lines: PricedLine[] = [];
  for (const line of extraction.lines) {
    if (line.kind === "material") lines.push(await priceMaterialLine(line));
    else if (line.kind === "labour") lines.push(await priceLabourLine(line));
    else lines.push(priceOtherLine(line));
  }
  return lines;
}
