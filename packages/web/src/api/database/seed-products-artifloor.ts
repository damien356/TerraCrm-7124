/**
 * ArtiFloor Timberland luxury vinyl plank into the price book — 24 colours in
 * two ranges (4.5mm x 18, 2.5mm x 6).
 *
 * Four things here are deliberate.
 *
 * 1. CATEGORY IS `vinyl`, which is where every LVP/LVT plank in this book
 *    already lives — Polyflor Camaro and Expona, Chameleon Elsa, Sunstar
 *    Naturale Plank. `hybrid` is reserved for the rigid SPC click boards
 *    (6.5-9.5mm), which these are not.
 *
 * 2. NO PACK BREAK. One rate per m2, whatever the quantity, so `rollM2`,
 *    `cutCostPrice` and `cutUpliftPct` are all null and the quote note says so
 *    plainly. Cartons still matter for ORDERING — you buy whole cartons — and
 *    `unitsPerPack` x `unitM2` is what rounds an area up to them.
 *
 * 3. `unitM2` IS DERIVED FROM THE BOARD, NOT COPIED OFF THE LIST. ArtiFloor's
 *    printed m2/carton rounds up, and its printed m2/pallet is that rounded
 *    carton figure times the box count, so the error compounds 60-fold: a
 *    pallet of 4.5mm really covers 166.79 m2 against the 167.4 m2 printed. The
 *    printed carton figure is kept in `packM2Printed` for invoice-checking and
 *    is never used for ordering maths — the schema's own rule.
 *
 * 4. THE VARIANT KEY CARRIES THE RANGE, because colour does not identify a
 *    product here. Coastal Blackbutt, Weathered Oak, Natural Blackbutt and
 *    White Washed Oak each exist in BOTH ranges, $9.00/m2 apart.
 *
 * The 4.5mm range is NOT the harder-wearing floor. Both ranges have the same
 * 0.5mm wear layer; the premium is core thickness and board length only. That
 * sentence is on every row, because it is the thing most easily got wrong on
 * the phone.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-artifloor.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  ARTIFLOOR_CHARGE,
  ARTIFLOOR_LVP,
  ARTIFLOOR_SOURCE,
  ARTIFLOOR_THICK_PREMIUM,
  ARTIFLOOR_THICK_PREMIUM_PCT,
} from "./artifloor-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const slug = (v: string) => v.toLowerCase().replace(/\s+/g, "-");

function buildArtiFloor(supplierId: number): ProductSeed[] {
  return ARTIFLOOR_LVP.map((r) => {
    const isThick = r.thicknessMm === 4.5;
    return {
      supplierId,
      supplier: "ArtiFloor",
      brand: "ArtiFloor",
      range: r.range,
      colour: r.colour,
      // Same home as every other LVP/LVT plank in the book. Not `hybrid` —
      // that is the rigid SPC click category.
      category: "vinyl",
      tier: "",
      unit: "m2",
      size: r.sizePrinted,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      wearLayerMm: r.wearLayerMm,

      // Ordering is in whole cartons: pieces x true board area. The printed
      // carton m2 goes in packM2Printed and stays out of the arithmetic.
      unitsPerPack: r.piecesPerCarton,
      unitM2: r.pieceM2,
      packM2Printed: r.cartonM2Printed,
      boxesPerPallet: r.boxesPerPallet,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // One rate at any quantity — no carton or pallet break published.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,

      sku: r.code,
      variantKey: `artifloor|${slug(r.range)}|${slug(r.colour)}|${r.code}`.toLowerCase(),
      sourceNote:
        `$${r.pricePerM2.toFixed(2)}/m2 ex GST, one rate at any quantity. ` +
        `A carton is ${r.piecesPerCarton} boards = ${r.cartonM2True} m2 ($${r.pricePerCarton.toFixed(2)}); ` +
        `a pallet is ${r.boxesPerPallet} cartons = ${r.palletM2True} m2 ($${r.pricePerPallet.toFixed(2)}). ` +
        `ArtiFloor print ${r.cartonM2Printed} m2 a carton and ${r.palletM2Printed} m2 a pallet — both rounded UP, ` +
        `so a pallet is ${r.palletM2Drift} m2 SHORT of the printed figure. Order off ${r.cartonM2True} m2 a carton. ` +
        (r.sharedColour
          ? `"${r.colour}" also exists in the other Timberland range at a different price — name the range on the quote. `
          : "") +
        `Item ${r.code}.`,
      notes:
        `${ARTIFLOOR_SOURCE} (no effective date printed — the file is titled "CURRENT"). ` +
        `${r.wearLayerMm}mm wear layer, the SAME as the other Timberland range: ` +
        (isThick
          ? `this range costs $${ARTIFLOOR_THICK_PREMIUM.toFixed(2)}/m2 more (+${ARTIFLOOR_THICK_PREMIUM_PCT}%) for a thicker core and a longer board, NOT for durability. Do not sell it as the harder-wearing floor. `
          : `the 4.5mm range is $${ARTIFLOOR_THICK_PREMIUM.toFixed(2)}/m2 dearer for core thickness and board length only, so this range wears the same. `) +
        `Board ${r.lengthMm}mm is over the 1200mm length Jocks charges extra for (Unified does not). ` +
        `Install method not stated by ArtiFloor — confirm glue-down vs loose lay vs click before quoting adhesive. ` +
        `${ARTIFLOOR_CHARGE.name} $${ARTIFLOOR_CHARGE.amount.toFixed(2)} ${ARTIFLOOR_CHARGE.basis.toLowerCase()} applies; freight unconfirmed.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "artifloor"));
  if (!supplier) throw new Error("Seed suppliers first — no ArtiFloor supplier row found.");

  const items = buildArtiFloor(supplier.id);
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

  const shared = items.filter((i) => ARTIFLOOR_LVP.find((r) => r.code === i.sku)?.sharedColour).length;
  console.log(`ArtiFloor: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  Timberland 4.5mm x 18 @ $24.90/m2, Timberland 2.5mm x 6 @ $15.90/m2, one rate per range`);
  console.log(`  ${shared} lines share a colour name with the other range — variant key carries the range`);
  console.log(`  carton/pallet m2 derived from the board count, not ArtiFloor's rounded-up printed figures`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
