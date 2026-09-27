/**
 * Hurford's CD non-structural pine plywood into the price book — 8 thicknesses,
 * all 2400 x 1200mm, off Hurford's own list effective 1 Jun 2025.
 *
 * Two things here are deliberate and easy to get wrong later.
 *
 * 1. UNIT IS `each`, A SHEET. Hurford's price, pack and sell by the sheet, and
 *    nobody orders 14.7 m2 of plywood — they order 6 sheets. `unitM2` carries
 *    2.88 so a floor area still converts to a sheet count, but the money is per
 *    sheet and the order is a whole number.
 *
 * 2. THE PACK BREAK IS THE SAME MECHANISM AS A VINYL ROLL CUT, so it reuses
 *    resolveRollCut() rather than a second copy of the arithmetic:
 *      `costPrice`     the PACK rate, the standard cost
 *      `cutCostPrice`  the LOOSE rate, Hurford's own printed figure
 *      `rollM2`        sheets in one full pack — the threshold
 *      `bulkKind`      "pack", which only changes the words in the quote note
 *    The loose rate is stored EXPLICITLY and never derived from the +8% the
 *    list quotes: three of the eight lines miss a flat 8% by a cent, in both
 *    directions, and a quote that disagrees with Hurford's own document by a
 *    cent is a quote the office has to defend.
 *
 * NON-STRUCTURAL. This sheet is a slab overlay and cannot span joists. The
 * joist-rated sheet Terra buys is Mitre 10's F8 T&G, not this.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-hurfords.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { HURFORDS_EFFECTIVE_FROM, HURFORDS_PLYWOOD, HURFORDS_SOURCE } from "./hurfords-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

function buildHurfords(supplierId: number): ProductSeed[] {
  return HURFORDS_PLYWOOD.map((r) => ({
    supplierId,
    supplier: "Hurford's",
    brand: "Hurford's",
    range: "CD Non-Structural Pine Plywood",
    colour: "",
    // Sheet goods: plywood is not a floor covering and must never turn up in a
    // carpet-or-timber product search as if it were one.
    category: "sheet_goods",
    tier: "Non-Structural",
    // A sheet, not a square metre. See the header note.
    unit: "each",
    size: `${r.sizePrinted}mm`,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    thicknessMm: r.thicknessMm,
    // m2 of ONE sheet, so a floor area converts to a sheet count at quote time.
    unitM2: r.sheetM2,

    // Standard cost = the PACK rate. The loose rate is a second rate on the
    // same product, chosen by order quantity, never folded into this one.
    costPrice: r.packPrice,
    sellPrice: sell(r.packPrice),
    cutCostPrice: r.loosePrice,
    cutUpliftPct: null,
    rollM2: r.packQty,
    bulkKind: "pack",

    sku: r.code,
    variantKey: `hurfords|cd-non-structural-plywood|${r.thicknessMm}mm|${r.code}`.toLowerCase(),
    sourceNote:
      `${r.rule} Loose rate $${r.loosePrice.toFixed(2)} is Hurford's printed figure ` +
      `(+${r.looseUpliftPct.toFixed(2)}% on the pack rate, not exactly the +8% the list claims` +
      `${r.centDrift === 0 ? "" : `, ${r.centDrift > 0 ? "+" : ""}${r.centDrift.toFixed(2)} off it`}). ` +
      `A full pack of ${r.packQty} is ${r.packHeightMm}mm of timber and covers ${r.packM2} m2. ` +
      `Above ${r.breakEvenSheets} sheets a full pack is cheaper than buying loose.`,
    notes:
      `${HURFORDS_SOURCE}, effective ${HURFORDS_EFFECTIVE_FROM}. ` +
      `NON-STRUCTURAL: slab overlay only, cannot span joists — use Mitre 10 F8 T&G structural ply over joists. ` +
      `${r.sheetM2} m2 a sheet. ` +
      `DELIVERY TO US IS FREE, NO MINIMUM ORDER, confirmed by Damien for the plywood as well as the flooring. ` +
      `What this rate does exclude is a 2.21% FUEL SURCHARGE from 23 Sep 2026, which Damien confirmed covers ` +
      `all Hurford's orders including the plywood. It is 2.21% of the goods ex GST, worth ` +
      `${(r.packPrice * 0.0221).toFixed(2)} a sheet at this pack rate, and it is seeded as a supplier fee ` +
      `rule rather than into this price so it comes off in one place when Hurford's drop it.`,
  }));
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "hurfords"));
  if (!supplier) throw new Error("Seed suppliers first — no Hurford's supplier row found.");

  const items = buildHurfords(supplier.id);
  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  let created = 0;
  let updated = 0;
  for (const product of items) {
    const [existing] = await db.select().from(s.products).where(eq(s.products.variantKey, product.variantKey!));
    if (existing) {
      updated += 1;
      await db
        .update(s.products)
        .set({ ...product, updatedAt: new Date() })
        .where(eq(s.products.id, existing.id));
    } else {
      created += 1;
      await db.insert(s.products).values(product);
    }
  }

  console.log(`Hurford's: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  all pack/loose pairs, ${items.length} thicknesses, sheet-priced (unit "each")`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
