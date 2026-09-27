/**
 * Sunstar into the price book — 235 live colour lines across 24 ranges, plus 30
 * accessory lines off the "Accessories & Charges" sheet.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: Sunstar publishes one standard rate per
 * range and no dated clearances.
 *
 * Five things this supplier does that the seed has to respect:
 *
 * 1. ONE PRICE PER RANGE. Colour never moves the rate.
 *
 * 2. ORDER OFF THE INTEGER BOARD COUNT, NEVER THE PRINTED m2/PACK. Sunstar
 *    rounds m2/pack and 13 of the 24 ranges drift from the truth — Naturale
 *    Plank 3.0 prints 3.26 where 15 boards is 3.2547, Maxi Hybrid prints 2.1
 *    where 5 boards is 2.1045. `unitsPerPack` is the asserted integer and
 *    `unitM2` is one board's real area; `packM2Printed` is kept for invoice
 *    cross-checks and is never used for maths.
 *
 * 3. PRISM AND PRISM HERRINGBONE STAY OUT. Printed "Coming Q2 2026" with no
 *    codes and no colours — the owner's call is to hold them until Sunstar
 *    publishes them. They live in SUNSTAR_UPCOMING and this seed reports them
 *    without inserting anything.
 *
 * 4. STAIR NOSINGS ARE PER RANGE AND SOME LINES COVER A FAMILY. The sheet
 *    writes "Le Parquet" and "Classic Oak 14/2mm", which each cover more than
 *    one real range, so the extractor expanded those into one row per range and
 *    marked them `confirmFit`. Those rows carry an `availabilityNote` — quotable,
 *    but the office confirms the nosing suits the sub-range before ordering.
 *    Ranges with no nosing line at all (every luxury vinyl plank range, and
 *    Classic Oak Wide Board's own colours aside) genuinely have none.
 *
 * 5. CUSTOM STAIR NOSING IS PRICE ON APPLICATION. No cost, no sell, 10-day lead
 *    time, `priceOnApplication` true so quoting has to ring Sunstar Orders.
 *
 * NOT SEEDED HERE, on purpose:
 *   - Delivery ($110 + GST per pallet, QLD metro). Order-level, already a
 *     supplier_fee_rules row — putting it in a product would double-charge it.
 *   - The bailing line. $0 per Sunstar's own sheet, recorded on the supplier.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-sunstar.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  SUNSTAR_ACCESSORIES,
  SUNSTAR_CHARGES,
  SUNSTAR_ROWS,
  SUNSTAR_SOURCE,
  SUNSTAR_UPCOMING,
} from "./sunstar-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

/** Composite identity, built the same way as every other supplier's. */
function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

/**
 * Sunstar's product families, printed as the first words of the range —
 * "Classic Oak - Wide Board", "Le Parquet - Herringbone", "Maxi Hybrid".
 * Read off the range, never invented, and stored as `tier` so the product list
 * groups the way Damien talks about them. Longest match first so "Maxi Smooth"
 * never swallows "Maxi Hybrid".
 */
const FAMILIES = [
  "Classic Oak",
  "Classic Hybrid",
  "Le Parquet",
  "Australian Naturals",
  "Maxi Smooth",
  "Maxi Hybrid",
  "Authentic",
  "Eucalyptus Steps",
  "Naturale Plank",
  "Vogue",
  "Adare",
  "Keeta",
  "Oatlands",
];
function family(range: string): string {
  return FAMILIES.find((f) => range.startsWith(f)) ?? "";
}

const CONFIRM_FIT_NOTE =
  "Sunstar lists this nosing against a product family, not this exact range — confirm it suits the range with Sunstar Orders before ordering.";

function buildFloors(supplierId: number): ProductSeed[] {
  return SUNSTAR_ROWS.map((r) => ({
    supplierId,
    supplier: "Sunstar Flooring",
    brand: "Sunstar",
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
    // Timber's veneer sits INSIDE this thickness; it is never added to it.
    thicknessMm: r.thicknessMm,
    // Timber states an oak veneer, hybrid and vinyl a wear layer, laminate
    // neither (it publishes an AC rating instead). Only one is ever set.
    wearLayerMm: r.veneerMm ?? r.wearLayerMm,
    weight: "",

    // THE ORDERING FIGURE. Asserted integer, not the sheet's rounded m2/pack.
    unitsPerPack: r.boardsPerPack,
    unitM2: Math.round((r.packM2 / r.boardsPerPack) * 10_000) / 10_000,
    packM2Printed: r.packM2Printed,
    // Sunstar states no pallet quantities, only a per-pallet delivery rate.
    boxesPerPallet: null,

    costPrice: r.pricePerM2,
    sellPrice: sell(r.pricePerM2),
    // Boxed product: no roll, so no cut rate and no cut threshold.
    cutCostPrice: null,
    cutUpliftPct: null,
    rollM2: null,

    sku: r.code,
    variantKey: variantKey(["sunstar", r.category, r.range, r.colour, r.code]),
    sourceNote: SUNSTAR_SOURCE,
    notes: [
      SUNSTAR_SOURCE,
      r.productType,
      r.wearLayerText,
      `${r.boardsPerPack} boards/pack = ${r.packM2} m2 (Sunstar prints ${r.packM2Printed})`,
      r.note,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

/**
 * Trims, scotias, underlay and stair nosings.
 *
 * Underlay and floor protection are BOUGHT as a 20 x 1m roll and PRICED per m2,
 * so the per-m2 price goes in `costPrice` and the roll size in `rollM2` as the
 * purchase unit. Sunstar charges the same per m2 either way, so there is no
 * part-roll premium and `cutCostPrice`/`cutUpliftPct` stay null.
 */
function buildAccessories(supplierId: number): ProductSeed[] {
  return SUNSTAR_ACCESSORIES.map((a) => ({
    supplierId,
    supplier: "Sunstar Flooring",
    brand: "Sunstar",
    // A nosing reads as its floor range; everything else as the finish or spec
    // label the sheet sells it under.
    range: a.group === "Stair Nosing" ? `Stair Nosing — ${a.fitsRange || a.fitsLabel}` : a.fitsLabel || a.item,
    colour: "",
    category: a.group === "Underlay" ? "underlay" : "accessory",
    tier: a.group,
    unit: a.unit,

    size: a.size,
    widthM: null,
    lengthMm: null,
    widthMm: null,
    thicknessMm: null,
    wearLayerMm: null,
    weight: "",

    unitsPerPack: null,
    unitM2: null,
    packM2Printed: null,
    boxesPerPallet: null,

    costPrice: a.price,
    sellPrice: a.price === null ? null : sell(a.price),
    cutCostPrice: null,
    cutUpliftPct: null,
    // Purchase unit where it differs from the sell unit: a 20 m2 roll sold per m2.
    rollM2: a.rollM2,
    // Custom nosing: no published rate, the office rings Sunstar Orders.
    priceOnApplication: a.priceOnApplication,
    leadTimeDays: a.leadTimeDays,
    // Empty = sold on finish or spec, fits any range.
    fitsRange: a.fitsRange,
    availabilityNote: a.confirmFit ? CONFIRM_FIT_NOTE : "",

    sku: a.item,
    variantKey: variantKey([
      "sunstar",
      "accessory",
      a.group,
      a.item,
      a.fitsRange || a.fitsLabel || "universal",
    ]),
    sourceNote: SUNSTAR_SOURCE,
    notes: [
      a.description,
      a.rollM2 !== null ? `Bought as a ${a.rollM2} m2 roll, priced per m2` : "",
      a.fitsRange ? `Fits ${a.fitsRange}` : "",
      a.priceOnApplication ? "Price on application — contact Sunstar Orders" : "",
      a.leadTimeDays !== null ? `Allow ${a.leadTimeDays} days for manufacture and delivery` : "",
      a.note,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "sunstar"));
  if (!supplier) throw new Error("Seed suppliers first — no Sunstar supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const items = [...floors, ...accessories];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* An accessory may only name a range that actually exists, or quoting could
   * offer a nosing for a floor Sunstar does not sell. */
  const ranges = new Set(floors.map((f) => f.range));
  for (const a of accessories) {
    if (a.fitsRange && !ranges.has(a.fitsRange)) {
      throw new Error(`accessory ${a.sku} fits unknown range "${a.fitsRange}"`);
    }
  }

  /* A held-out range must never have slipped into the seed. */
  for (const u of SUNSTAR_UPCOMING) {
    if (ranges.has(u.range)) throw new Error(`upcoming range "${u.range}" must not be seeded`);
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
  for (const i of floors) byCategory.set(i.category!, (byCategory.get(i.category!) ?? 0) + 1);

  console.log(`Sunstar: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${floors.length} floor lines, ${ranges.size} ranges — ${[...byCategory.entries()]
      .map(([c, n]) => `${n} ${c}`)
      .join(", ")}`,
  );
  const nosings = accessories.filter((a) => a.tier === "Stair Nosing");
  console.log(
    `  ${accessories.length} accessory lines — ${nosings.length} stair nosings, ${accessories.filter((a) => a.availabilityNote).length} flagged to confirm fit, ${accessories.filter((a) => a.priceOnApplication).length} price-on-application`,
  );
  for (const u of SUNSTAR_UPCOMING) {
    console.log(`  held out (not seeded): ${u.range} @ $${u.pricePerM2}/m2 — ${u.note}`);
  }
  for (const c of SUNSTAR_CHARGES) {
    console.log(
      `  order-level, not a product: ${c.group} ${c.price === null ? "(no amount — $0)" : `$${c.price}/${c.unit}`}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
