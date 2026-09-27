/**
 * Belgotex into the price book — real prices off two supplied lists, plus the
 * dated clearances that go with them.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. Specials are matched on (product, label, startsOn) so a re-run does
 * not stack duplicates, and a special is never merged into the product's
 * standard price: the standard price is what the app reverts to when a
 * clearance window closes.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products.ts
 */
import { and, eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  BROADLOOM_MIN_ORDER_LM,
  BROADLOOM_ROWS,
  TILE_CLEARANCE_STARTS_ON,
  TILE_ROWS,
  TILE_UNIT_M2,
} from "./belgotex-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;
type SpecialSeed = Omit<typeof s.productSpecials.$inferInsert, "productId">;

const TILE_SOURCE = "Belgotex carpet tiles, Sep 2026";
const BROADLOOM_SOURCE = "Belgotex broadloom price list, 03/07/2026";

/** Composite identity, because Belgotex publishes no product codes. */
function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

function buildBelgotex(supplierId: number) {
  const items: { product: ProductSeed; specials: SpecialSeed[] }[] = [];

  for (const [range, colour, backing, size, unitsPerPack, standard, clearance, endsOn, note] of TILE_ROWS) {
    items.push({
      product: {
        supplierId,
        supplier: "Belgotex",
        brand: "Belgotex",
        range,
        colour,
        category: "carpet_tile",
        unit: "m2",
        backing,
        size,
        unitsPerPack,
        unitM2: TILE_UNIT_M2,
        // Derived from the integer tile count, never read off the printed figure.
        packM2Printed: Math.round(unitsPerPack * TILE_UNIT_M2 * 10_000) / 10_000,
        // ALWAYS the standard price. The clearance lives in product_specials.
        costPrice: standard,
        sellPrice: sell(standard),
        variantKey: variantKey(["belgotex", "carpet_tile", range, colour, backing, size]),
        sourceNote: note,
        notes: TILE_SOURCE,
      },
      specials:
        clearance !== null && endsOn !== null
          ? [
              {
                label: "Belgotex clearance",
                kind: "clearance",
                costPriceExGst: clearance,
                startsOn: TILE_CLEARANCE_STARTS_ON,
                endsOn,
                source: TILE_SOURCE,
                notes: `Standard $${standard.toFixed(2)}/m2 returns from ${endsOn} onwards.`,
              },
            ]
          : [],
    });
  }

  for (const [tier, range, colour, widthM, weight, pricePerLm] of BROADLOOM_ROWS) {
    items.push({
      product: {
        supplierId,
        supplier: "Belgotex",
        brand: "Belgotex",
        range,
        colour,
        category: "carpet",
        tier,
        // Broadloom is bought by the metre off a fixed-width roll.
        unit: "lm",
        widthM,
        weight,
        size: `${widthM.toFixed(2)}m wide`,
        costPrice: pricePerLm,
        sellPrice: sell(pricePerLm),
        minOrderQty: BROADLOOM_MIN_ORDER_LM,
        variantKey: variantKey(["belgotex", "carpet", range, colour, `${widthM}m`]),
        sourceNote: "Colour and range confirmed against belgotex.com.au.",
        notes: BROADLOOM_SOURCE,
      },
      specials: [],
    });
  }

  return items;
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "belgotex"));
  if (!supplier) throw new Error("Seed suppliers first — no Belgotex supplier row found.");

  const items = buildBelgotex(supplier.id);
  let created = 0;
  let updated = 0;
  let specialsCreated = 0;
  let specialsUpdated = 0;

  for (const { product, specials } of items) {
    const [existing] = await db
      .select()
      .from(s.products)
      .where(eq(s.products.variantKey, product.variantKey!));

    const productId = existing
      ? ((updated += 1),
        (
          await db
            .update(s.products)
            .set({ ...product, updatedAt: new Date() })
            .where(eq(s.products.id, existing.id))
            .returning()
        )[0].id)
      : ((created += 1), (await db.insert(s.products).values(product).returning())[0].id);

    for (const special of specials) {
      const [existingSpecial] = await db
        .select()
        .from(s.productSpecials)
        .where(
          and(
            eq(s.productSpecials.productId, productId),
            eq(s.productSpecials.label, special.label!),
            eq(s.productSpecials.startsOn, special.startsOn),
          ),
        );
      if (existingSpecial) {
        specialsUpdated += 1;
        await db
          .update(s.productSpecials)
          .set({ ...special, updatedAt: new Date() })
          .where(eq(s.productSpecials.id, existingSpecial.id));
      } else {
        specialsCreated += 1;
        await db.insert(s.productSpecials).values({ ...special, productId });
      }
    }
  }

  const tiles = items.filter((i) => i.product.category === "carpet_tile").length;
  const broadloom = items.filter((i) => i.product.category === "carpet").length;
  console.log(
    `Belgotex: ${created} created, ${updated} updated (${tiles} carpet tile variants, ${broadloom} broadloom lines)`,
  );
  console.log(`clearances: ${specialsCreated} created, ${specialsUpdated} updated`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
