/**
 * Dunlop Flooring boxed hard-flooring products into the price book.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. This imports the flooring rows only. The supplied workbook explicitly
 * excludes accessories, stairnose, adhesive, end profiles, scotia and T trims.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-dunlop.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import { DUNLOP_BOXED_PRODUCTS, DUNLOP_PRICE_LIST_DATE, DUNLOP_SOURCE } from "./dunlop-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

function category(productType: string): string {
  switch (productType) {
    case "Engineered Timber":
      return "timber";
    case "Hybrid":
      return "hybrid";
    case "Laminate":
      return "laminate";
    case "LVT":
      return "vinyl";
    default:
      throw new Error(`Unhandled Dunlop product type: ${productType}`);
  }
}

function parseSize(size: string | null): { lengthMm: number | null; widthMm: number | null } {
  if (!size) return { lengthMm: null, widthMm: null };
  const nums = [...size.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  if (nums.length < 2) throw new Error(`Could not parse Dunlop size: ${size}`);
  return { lengthMm: Math.max(nums[0], nums[1]), widthMm: Math.min(nums[0], nums[1]) };
}

function piecesPerCarton(notes: string | null): number | null {
  if (!notes) return null;
  const match = notes.match(/(\d+)\s+pieces\/carton/i);
  return match ? Number(match[1]) : null;
}

function cartonsPerPallet(notes: string | null): number | null {
  if (!notes) return null;
  const match = notes.match(/(\d+)\s+cartons\/pallet/i);
  return match ? Number(match[1]) : null;
}

function round6(n: number) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function buildProducts(supplierId: number): ProductSeed[] {
  return DUNLOP_BOXED_PRODUCTS.map((r) => {
    const { lengthMm, widthMm } = parseSize(r.size);
    const pieces = piecesPerCarton(r.notes);
    const boxes = cartonsPerPallet(r.notes);
    const derivedBoxM2 = lengthMm && widthMm && pieces ? round6((lengthMm * widthMm * pieces) / 1_000_000) : null;
    const unitM2 = lengthMm && widthMm ? round6((lengthMm * widthMm) / 1_000_000) : pieces ? round6(r.m2PerBox / pieces) : null;
    const inferredBoxesFromPallet = r.palletM2 ? Math.round(r.palletM2 / r.m2PerBox) : null;
    const boxesPerPallet = boxes ?? inferredBoxesFromPallet;

    if (boxes && inferredBoxesFromPallet && boxes !== inferredBoxesFromPallet) {
      throw new Error(`${r.code} ${r.range}: cartons/pallet note ${boxes} conflicts with pallet m2 ${inferredBoxesFromPallet}`);
    }

    return {
      supplierId,
      supplier: "Dunlop Flooring",
      brand: "Dunlop Flooring",
      range: r.range,
      colour: r.colour,
      category: category(r.productType),
      tier: r.productType,
      unit: "m2",

      size: r.size ?? "",
      widthM: null,
      lengthMm,
      widthMm,
      thicknessMm: r.thicknessMm,
      wearLayerMm: null,
      weight: "",

      unitsPerPack: pieces,
      unitM2,
      packM2Printed: r.m2PerBox,
      boxesPerPallet,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      bulkKind: "roll",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      minOrderQty: r.m2PerBox,
      priceValidUntil: "",
      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      variantKey: variantKey(["dunlop", r.productType, r.range, r.code, r.colour, r.size]),
      sourceNote:
        `${DUNLOP_SOURCE}. Prices are per m2 ex GST. Price list date ${DUNLOP_PRICE_LIST_DATE}. ` +
        "No pallet discount exists in this list, so the same unit rate is kept for all quantities.",
      notes: [
        r.notes,
        r.size ? `Printed plank/tile size: ${r.size}.` : "Plank/tile size is blank on the supplied price list, so dimensions are not guessed.",
        r.thicknessMm !== null ? `Printed thickness: ${r.thicknessMm}mm.` : "Thickness is blank on the supplied price list, so it is not guessed.",
        derivedBoxM2 && Math.abs(derivedBoxM2 - r.m2PerBox) > 0.01
          ? `Derived carton area from printed size and pieces is ${derivedBoxM2} m2, while Dunlop print ${r.m2PerBox} m2/box. The printed box figure is kept for ordering and invoice checks.`
          : "",
        r.palletM2 !== null ? `Printed pallet size: ${r.palletM2} m2.` : "Pallet size is blank on the supplied price list, so pallet quantity is not guessed.",
        "Accessories, stairnose, adhesive, end profiles, scotia and T trims were excluded by the workbook scope and are deliberately not seeded here.",
        "Dunlop delivery is $80 + GST per order, seeded as an automatic supplier fee, not baked into the product price.",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "dunlop"));
  if (!supplier) throw new Error("Seed suppliers first — no Dunlop supplier row found.");

  const items = buildProducts(supplier.id);
  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  for (const item of items) {
    if (item.costPrice === null || item.costPrice === undefined) throw new Error(`${item.variantKey}: missing cost price`);
    if (!item.packM2Printed) throw new Error(`${item.variantKey}: missing m2 per box`);
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

  const byCategory = new Map<string, number>();
  for (const i of items) byCategory.set(i.category!, (byCategory.get(i.category!) ?? 0) + 1);
  const ranges = new Set(items.map((i) => i.range)).size;

  console.log(`Dunlop Flooring: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  ${ranges} floor ranges — ${[...byCategory.entries()].map(([c, n]) => `${n} ${c}`).join(", ")}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
