import { eq, or, like, desc } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sellExGst } from "../lib/pricing";
import { rateBook } from "../routes/labour";
import type { Extraction } from "./extract";

/**
 * Pass 2: turn a structured `Extraction` (see `extract.ts`) into priced
 * quote lines, shaped exactly like `quoteItems` rows so the caller can insert
 * them straight in. This is the ONLY place that touches the products table
 * and the labour rate book for the voice pipeline — the extraction model
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
};

function normalise(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ");
}

/** Token overlap, 0..1. Cheap and good enough for short product names. */
function tokenScore(a: string, b: string): number {
  const at = new Set(normalise(a).split(" ").filter(Boolean));
  const bt = new Set(normalise(b).split(" ").filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;
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
 * A confident match is required before a material line prices itself
 * silently. Below this, the line still gets the best guess (so the office has
 * a number to start from) but is flagged for a human to confirm.
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

  let candidates: ProductRow[];
  if (patterns.length === 0) {
    // Nothing specific said beyond the sentence itself — narrow by category
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
    .orderBy(desc(schema.voicePhraseProductMatches.confirmCount))
    .limit(1);
  return rows[0]?.product ?? null;
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
  const phraseKey = normalise(spoken);

  const learned = phraseKey ? await findLearnedProduct(phraseKey) : null;
  if (learned) {
    const description = [learned.brand, learned.range, learned.colour].filter(Boolean).join(", ") || spoken;
    return {
      productId: learned.id,
      kind: learned.category === "labour" ? "labour" : "supply",
      description,
      qty,
      unit: learned.unit || unit,
      unitPrice: learned.sellPrice ?? 0,
      unitCost: learned.costPrice ?? null,
      flagged: false,
      flagReason: null,
      voicePhrase: phraseKey,
    };
  }

  const match = await findBestProduct(hints);

  if (!match) {
    return {
      productId: null,
      kind: "supply",
      description: spoken,
      qty,
      unit,
      unitPrice: 0,
      unitCost: null,
      flagged: true,
      flagReason: "No matching product found in the price book. Priced at $0 — pick the right product and reprice before sending.",
      voicePhrase: phraseKey || null,
    };
  }

  const { product, score } = match;
  const description = [product.brand, product.range, product.colour].filter(Boolean).join(", ") || spoken;
  const confident = score >= CONFIDENT_MATCH_THRESHOLD;

  return {
    productId: product.id,
    kind: product.category === "labour" ? "labour" : "supply",
    description: confident ? description : `${spoken} (best guess: ${description})`,
    qty,
    unit: product.unit || unit,
    unitPrice: product.sellPrice ?? 0,
    unitCost: product.costPrice ?? null,
    flagged: !confident,
    flagReason: confident
      ? null
      : `Damien said "${spoken}". Closest match in the price book is "${description}", but it is not a strong match. Check the product before sending.`,
    voicePhrase: confident ? null : phraseKey || null,
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
      flagReason: "No labour rate book item was matched. Priced at $0 — pick the right item and reprice before sending.",
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
    flagReason: cost === null ? `No current rate on file for "${description}". Priced at $0 — set a rate and reprice before sending.` : null,
    voicePhrase: null,
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
      flagReason: "Damien did not give a dollar figure for this line. Priced at $0 — fill it in before sending.",
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
