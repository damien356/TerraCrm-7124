/**
 * Victoria Carpets broadloom into the price book — 91 colours across 11 ranges,
 * priced per lineal metre.
 *
 * Five things here are deliberate.
 *
 * 1. CATEGORY IS `carpet`, UNIT IS `lm`. Same shape as Belgotex broadloom:
 *    bought by the metre off a roll, not by the m2.
 *
 * 2. `widthM` IS NULL, AND THAT BLOCKS lm -> m2. Victoria Carpets publish no
 *    roll width on any of the 91 lines. Belgotex broadloom carries 4.0m / 3.66m
 *    because Belgotex print it; guessing 3.66m here because that is a common
 *    broadloom width would put an invented number into every area calculation
 *    this supplier touches. So it stays null and every row says why.
 *
 * 3. NO ROLL/CUT SPLIT, BECAUSE THE SUPPLIER PUBLISHES NONE. The list has two
 *    price columns — "Roll Price" and "Cut Length Price" — holding the SAME
 *    number on all 91 rows, asserted at parse time. So `cutCostPrice`,
 *    `cutUpliftPct` and `rollM2` are all null and `resolveRollCut` has nothing
 *    to resolve. That is a PROVEN no-premium, not missing data, and the note on
 *    every row says so — the office should not ring to ask what the cut rate is.
 *
 * 4. THE PRICES START 1 OCT 2026. Every row carries that date and the file
 *    carries no other, so this is Victoria Carpets' NEXT price book, loaded
 *    before it takes effect. `priceValidUntil` is the wrong field for that —
 *    it is the LAST day a cost holds, and nothing here expires — so the
 *    effective date lives on the supplier row and in each product's note.
 *
 * 5. ICONIC CARRIES AN `availabilityNote`. Its 8 colours come off a hosted spec
 *    sheet, not Victoria Carpets' live Products index. Priced, so quotable —
 *    same soft-warning treatment as the Airlay expanded colours, never a block.
 *
 * Baling is NOT modelled per-metre here: it is per 40 lm started, which the fee
 * engine cannot express, so it sits on the supplier as a non-auto-applying fee
 * with the real rule written out. See seed-suppliers.ts.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-victoriacarpets.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  VICTORIA_BALING,
  VICTORIA_BROADLOOM,
  VICTORIA_EFFECTIVE_PRINTED,
  VICTORIA_RANGES,
  VICTORIA_SOURCE,
} from "./victoriacarpets-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(VICTORIA_RANGES.map((r) => [r.range, r]));

function buildVictoriaCarpets(supplierId: number): ProductSeed[] {
  return VICTORIA_BROADLOOM.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;
    return {
      supplierId,
      supplier: "Victoria Carpets",
      brand: "Victoria Carpets",
      range: r.range,
      colour: r.colour,
      category: "carpet",
      tier: "",
      // Bought by the metre off a roll, like Belgotex broadloom.
      unit: "lm",
      // NOT PUBLISHED. Null on purpose — see note 2 above. Without it, lm
      // cannot be converted to m2 for any Victoria Carpets line.
      widthM: null,
      size: "",

      costPrice: r.pricePerLm,
      sellPrice: sell(r.pricePerLm),

      // Roll price === cut price on every row, proven at parse time. Nothing
      // for resolveRollCut to pick between.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,

      // Not published. Belgotex broadloom is 2.0 lm; Victoria Carpets state no
      // minimum, so this is left null rather than borrowed.
      minOrderQty: null,

      sku: r.sku,
      variantKey: r.variantKey,
      availabilityNote: r.specSheetOnly
        ? `${r.range} is NOT on Victoria Carpets' current Products index — these colours come off their hosted specification sheet. Priced and quotable, but confirm the colour is still made before promising it.`
        : "",
      sourceNote:
        `$${r.pricePerLm.toFixed(2)}/lm ex GST from ${VICTORIA_EFFECTIVE_PRINTED}. ` +
        `Roll price and cut length price are the SAME $${r.pricePerLm.toFixed(2)} — Victoria Carpets publish no part-roll premium, so a cut length is not dearer per metre. ` +
        `All ${meta.colours} colours in ${r.range} share this price. SKU ${r.sku} (${r.productCode}/${r.colourCode}). ` +
        `Website status: ${r.websiteStatus}.`,
      notes:
        `${VICTORIA_SOURCE}. PRICE EFFECTIVE ${VICTORIA_EFFECTIVE_PRINTED} — every row on the list carries that date and no earlier rate was supplied, so this is next month's price book: right for October work, wrong for checking a September invoice. ` +
        `ROLL WIDTH NOT PUBLISHED, so lineal metres cannot be converted to m2 on this line — measure and quote in lm, and get the width from Victoria Carpets before doing any area maths. ` +
        `Baling ${VICTORIA_BALING.rule} — ceil(lm / ${VICTORIA_BALING.blockLm}) x $${VICTORIA_BALING.amount.toFixed(2)} + GST, and 0.1 lm over a block boundary costs a full extra $${VICTORIA_BALING.amount.toFixed(2)}. It does NOT auto-apply on quotes; add it at the right multiple. ` +
        `Freight to the Gold Coast unconfirmed. Fibre, face weight, backing, roll length and minimum order all unstated by the supplier.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "victoriacarpets"));
  if (!supplier) throw new Error("Seed suppliers first — no Victoria Carpets supplier row found.");

  const items = buildVictoriaCarpets(supplier.id);
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

  const specOnly = items.filter((i) => i.availabilityNote).length;
  console.log(`Victoria Carpets: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${VICTORIA_RANGES.length} ranges, $${VICTORIA_RANGES[0].pricePerLm}/lm (${VICTORIA_RANGES[0].range}) to ` +
      `$${VICTORIA_RANGES[VICTORIA_RANGES.length - 1].pricePerLm}/lm (${VICTORIA_RANGES[VICTORIA_RANGES.length - 1].range}), one price per range`,
  );
  console.log(`  prices effective ${VICTORIA_EFFECTIVE_PRINTED} — a future price book, flagged on every row`);
  console.log(`  no part-roll premium (roll price === cut price on all ${items.length} rows) — cutCostPrice left null`);
  console.log(`  widthM null on all ${items.length} lines — roll width not published, so lm -> m2 is not possible`);
  console.log(`  ${specOnly} lines carry the ICONIC spec-sheet-only availability warning`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
