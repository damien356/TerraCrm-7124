/**
 * Advantage Flooring broadloom carpet into the price book — 296 colours
 * across 39 ranges, priced per lineal metre.
 *
 * Three things here are deliberate.
 *
 * 1. CATEGORY IS `carpet`, UNIT IS `lm`, `widthM` IS NULL. Same shape as
 *    Victoria Carpets and EC Carpets broadloom: bought by the metre off a
 *    roll. Advantage Flooring publish no roll width anywhere in the source
 *    (the workbook's own Price UoM column says "Not stated in price list" on
 *    every one of the 296 rows), so lm cannot be converted to m2 here and
 *    `widthM` stays null rather than borrowing a common broadloom width.
 *
 * 2. A GENUINE CUT-LENGTH PREMIUM EXISTS ON 102 OF 296 ROWS, BUT IT IS KEPT
 *    AS REFERENCE ONLY, NOT WIRED INTO THE ROLL/CUT BREAK. The workbook
 *    prints a "Roll Price" and a "Cut Price" per row and 102 rows genuinely
 *    differ ($2, $5 or $10/lm more for a cut length) — this is not the
 *    Victoria Carpets case of one number in two columns. But no lm threshold
 *    is published for when the cut rate applies (unlike EC Carpets' printed
 *    "over 25m" break), so `resolveRollCut` has nothing to pick a rate by:
 *    `rollM2` stays null, `cutCostPrice` stays null, and both printed rates
 *    live in `sourceNote` instead so the office can see the real cut price
 *    before quoting a short order. `costPrice` is always the Roll Price, the
 *    cheaper of the two and the one used for markup.
 *
 * 3. NO PRODUCT CODES AT ALL. Every one of the 296 rows has a blank Product
 *    Code, so `sku` is null throughout and product identity is a generated
 *    composite key only.
 *
 * Freight: Advantage Flooring does not deliver. Terra books Jocks Carpet
 * Express, whose own rate card charges $25 + GST per roll plus their 25%
 * fuel levy ($31.25 ex GST/roll) — seeded on the supplier as an auto-applying
 * per-roll fee. See seed-suppliers.ts.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-advantage.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { ADVANTAGE_BROADLOOM, ADVANTAGE_PRICE_LIST_DATE, ADVANTAGE_SOURCE } from "./advantage-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

function buildProducts(supplierId: number): ProductSeed[] {
  return ADVANTAGE_BROADLOOM.map((r) => {
    const hasCutPremium = r.cutPricePerLm !== r.rollPricePerLm;
    return {
      supplierId,
      supplier: "Advantage Flooring",
      brand: "Advantage Flooring",
      range: r.range,
      colour: r.colour,
      category: "carpet",
      tier: r.construction,
      unit: "lm",

      widthM: null,
      size: "",

      costPrice: r.rollPricePerLm,
      sellPrice: sell(r.rollPricePerLm),
      // See note 2 above: a real cut premium exists on 102/296 rows but no lm
      // threshold is published, so it is not wired into resolveRollCut.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      minOrderQty: null,

      sku: null,
      variantKey: variantKey(["advantageflooring", r.range, r.colour, r.market]),
      availabilityNote: r.unverifiedColour
        ? `${r.range} — colour list not found on Advantage Flooring's current website. Priced, but confirm this colour is still made before promising it.`
        : "",
      sourceNote:
        `$${r.rollPricePerLm.toFixed(2)}/lm ex GST Roll Price from ${ADVANTAGE_SOURCE}. ` +
        (hasCutPremium
          ? `Cut Price is $${r.cutPricePerLm.toFixed(2)}/lm, a $${(r.cutPricePerLm - r.rollPricePerLm).toFixed(2)}/lm premium over the roll rate for a cut length — no lm threshold is published for when this applies, so confirm with Advantage Flooring before quoting a short order at the roll rate. `
          : "Roll Price and Cut Price are the same on this row — no cut-length premium. ") +
        `Market: ${r.market}. Construction: ${r.construction}. ` +
        (r.colourSource
          ? `Colours confirmed against ${r.colourSource}.`
          : "Colour not confirmed on any current Advantage Flooring website page."),
      notes:
        `${ADVANTAGE_SOURCE}. Price list date ${ADVANTAGE_PRICE_LIST_DATE}. ` +
        "ROLL WIDTH NOT PUBLISHED anywhere in the source (Price UoM prints \"Not stated in price list\" on every row), so lineal metres cannot be converted to m2 on this supplier — measure and quote in lm. " +
        "NO PRODUCT CODES PUBLISHED AT ALL, so product identity is a generated composite key, never a supplier code. " +
        (hasCutPremium
          ? "A real cut-length premium is printed for this row but no lm threshold is published for when it applies, so it is kept in the source note only and not wired into the roll/cut break."
          : "") +
        " Freight is not included: Advantage Flooring does not deliver, so Terra books Jocks Carpet Express, seeded as an automatic $31.25 ex GST per-roll supplier fee, not baked into this product's price.",
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "advantageflooring"));
  if (!supplier) throw new Error("Seed suppliers first — no Advantage Flooring supplier row found.");

  const items = buildProducts(supplier.id);
  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  for (const item of items) {
    if (item.costPrice === null || item.costPrice === undefined) throw new Error(`${item.variantKey}: missing cost price`);
  }

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

  const ranges = new Set(items.map((i) => i.range)).size;
  const cutPremiumRows = items.filter((i) => i.sourceNote?.includes("premium over the roll rate")).length;
  const unverified = items.filter((i) => i.availabilityNote).length;

  console.log(`Advantage Flooring: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  ${ranges} broadloom carpet ranges, priced per lm, widthM null on all ${items.length} lines`);
  console.log(`  ${cutPremiumRows} rows carry a genuine cut-length premium (kept as reference only, no threshold published)`);
  console.log(`  ${unverified} row(s) carry the unverified-colour availability warning`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
