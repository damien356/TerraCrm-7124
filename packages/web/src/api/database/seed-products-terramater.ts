/**
 * Terramater into the price book — 104 colour lines across 13 ranges, off the
 * owner-supplied 2025 workbook.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: Terramater's list carries one standard rate
 * per range and no dated clearances.
 *
 * Three things this supplier does that the seed has to respect:
 *
 * 1. ONE PRICE PER RANGE. Colour never changes the rate, so every colour of a
 *    range gets its range's cost. (Airlay is the opposite — there the variant
 *    is the price.)
 *
 * 2. PACK MATHS OFF THE INTEGER BOARD COUNT. `unitsPerPack` is the board count
 *    and `unitM2` is one board's real area; 18 of the 104 rows have a printed
 *    m2/pack that disagrees with the derived figure in the 4th decimal, so
 *    `packM2Printed` is kept for invoice cross-checks and nothing else.
 *
 * 3. PRICES ARE FREIGHT-EXCLUSIVE AND 18 MONTHS OLD. Effective 1 April 2025.
 *    Freight, the SA->Gold Coast delivery charge, baling and the 2% fuel
 *    surcharge are all order-level and live in `supplier_fee_rules`, never in
 *    `costPrice`. The age is recorded on every row's `sourceNote` so a quote
 *    carries the warning with it.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-terramater.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import { TERRAMATER_ROWS, TERRAMATER_SOURCE } from "./terramater-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

/** Composite identity. Terramater's codes are unique today but the key is built the same way as every other supplier's. */
function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

/**
 * Terramater sells under three product families and prints the family as the
 * first word of the range — "WildOak Donato", "ResiPlank Eternity 705",
 * "NuCore Extreme AC5". Read off the range, not invented, and stored as `tier`
 * so the product list can group the way Damien talks about them.
 */
const FAMILIES = ["WildOak", "ResiPlank", "NuCore"];
function family(range: string): string {
  return FAMILIES.find((f) => range.startsWith(f)) ?? "";
}

const STALE_WARNING =
  "Terramater list effective 1 April 2025 — over 18 months old. Re-confirm the rate with Terramater before a large order.";

function buildTerramater(supplierId: number): ProductSeed[] {
  return TERRAMATER_ROWS.map((r) => ({
    supplierId,
    supplier: "Terramater",
    brand: "Terramater",
    range: r.range,
    colour: r.colour,
    category: r.category,
    tier: family(r.range),
    unit: "m2",

    size: r.size,
    // Boards, not roll goods — no roll width.
    widthM: null,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    thicknessMm: r.thicknessMm,
    // On timber this is the oak VENEER off the "14/2mm" notation; on hybrid and
    // vinyl it is the wear layer. Laminate states an AC rating instead of a
    // measurement, so it is null there and the rating sits in `notes`.
    wearLayerMm: r.veneerMm ?? r.wearLayerMm,
    // Freight maths: Terramater states both figures and a pallet of timber is
    // heavy enough to change the carrier.
    weight:
      r.packWeightKg !== null && r.palletWeightKg !== null
        ? `Pack ${r.packWeightKg}kg / Pallet ${r.palletWeightKg}kg`
        : "",

    unitsPerPack: r.boardsPerPack,
    // One board's real area. packM2 = this x boardsPerPack.
    unitM2: Math.round((r.packM2 / r.boardsPerPack) * 10_000) / 10_000,
    packM2Printed: r.packM2Printed,
    boxesPerPallet: r.packsPerPallet,

    costPrice: r.pricePerM2,
    sellPrice: sell(r.pricePerM2),
    // Boxed product: no roll, so no cut rate and no cut threshold.
    cutCostPrice: null,
    cutUpliftPct: null,
    rollM2: null,

    sku: r.code,
    variantKey: variantKey(["terramater", r.category, r.range, r.colour, r.code]),
    sourceNote: STALE_WARNING,
    notes: `${TERRAMATER_SOURCE} · ${r.construction}${r.wearLayerText ? ` · ${r.wearLayerText}` : ""}`,
  }));
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "terramater"));
  if (!supplier) throw new Error("Seed suppliers first — no Terramater supplier row found.");

  const items = buildTerramater(supplier.id);
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

  const byCategory = new Map<string, number>();
  for (const i of items) byCategory.set(i.category!, (byCategory.get(i.category!) ?? 0) + 1);
  const ranges = new Set(items.map((i) => i.range)).size;

  console.log(`Terramater: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${ranges} ranges — ${[...byCategory.entries()].map(([c, n]) => `${n} ${c}`).join(", ")}`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
