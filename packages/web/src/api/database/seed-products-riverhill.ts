/**
 * Riverhill into the price book — 71 colour lines across 8 ranges, plus the 21
 * priced accessory lines off the "Accessories & Charges" sheet.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: Riverhill publishes one standard rate per
 * range and no dated clearances.
 *
 * Four things this supplier does that the seed has to respect:
 *
 * 1. ONE PRICE PER RANGE. Colour never moves the rate, so every colour of a
 *    range carries its range's cost.
 *
 * 2. RANDOM-LENGTH BOARDS QUOTE OFF THE MINIMUM. "Engineered Australian
 *    Classic" ships 1820-2100mm boards, 8 to a pack, so a pack holds between
 *    1.98 and 2.28 m2. `lengthMm` and `unitM2` are therefore built off the
 *    SHORTEST board — ordering off the maximum under-orders a job by up to 13%.
 *    The maximum is kept in `notes` for reference and nowhere near the maths.
 *
 * 3. HYBRID THICKNESS IS ADDITIVE. Riverhill writes hybrid as "7.5+2" (core
 *    plus wear layer = 9.5mm total) and timber as "15/3" (board thickness with
 *    a 3mm veneer inside it, NOT 18mm). The extractor already resolved that;
 *    `thicknessMm` here is always the real total board thickness.
 *
 * 4. TRIM GAPS ARE REAL. Every accessory carries `fitsRange` so quoting can
 *    only offer a trim that exists. 9.5mm Hybrid genuinely has no Reducer and
 *    no Base Channel, and Chevron, Herringbone, SPC Herringbone and Engineered
 *    Australian Classic have no trims at all. Confirmed absences, not gaps in
 *    the data — do not "fill" them.
 *
 * NOT SEEDED HERE, on purpose:
 *   - The bailing charge. Riverhill's sheet lists the line with no amount and
 *     the owner confirmed it is $0, so it is recorded on the supplier record
 *     rather than faked as a zero-cost product. The extractor keeps it in
 *     RIVERHILL_UNPRICED so it can't be silently lost; this seed just reports it.
 *   - Delivery. Riverhill does not deliver to the Gold Coast warehouse; Terra
 *     books its own carrier, so there is no fee rule and no freight in cost.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-riverhill.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  RIVERHILL_ACCESSORIES,
  RIVERHILL_ROWS,
  RIVERHILL_SOURCE,
  RIVERHILL_UNPRICED,
} from "./riverhill-data";

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
 * Riverhill sells under two product families and prints the family as the
 * first word of the range — "iDesign Chevron", "iDesign15 Oak", "Classique
 * Oak", "Elegant SPC Hybrid 6.5mm". Read off the range, never invented, and
 * stored as `tier` so the product list groups the way Damien talks about them.
 * A range that matches none (Engineered Australian Classic) gets an empty tier.
 */
const FAMILIES = ["iDesign15", "iDesign", "Classique", "Elegant"];
function family(range: string): string {
  return FAMILIES.find((f) => range.startsWith(f)) ?? "";
}

function buildFloors(supplierId: number): ProductSeed[] {
  return RIVERHILL_ROWS.map((r) => {
    /* One board's real area, off the SHORTEST board on a random-length range. */
    const unitM2 = Math.round((r.packM2Min / r.boardsPerPack) * 10_000) / 10_000;

    const noteParts = [RIVERHILL_SOURCE, r.productType];
    if (r.wearLayerText) noteParts.push(r.wearLayerText);
    if (r.randomLength) {
      noteParts.push(
        `RANDOM LENGTH ${r.lengthMinMm}-${r.lengthMaxMm}mm: a pack of ${r.boardsPerPack} boards holds ${r.packM2Min}-${r.packM2Max} m2. Quote and order off the ${r.packM2Min} m2 minimum — the maximum under-orders by up to 13%.`,
      );
    }
    if (r.note) noteParts.push(r.note);

    return {
      supplierId,
      supplier: "Riverhill",
      brand: "Riverhill",
      range: r.range,
      colour: r.colour,
      category: r.category,
      tier: family(r.range),
      unit: "m2",

      size: r.size,
      // Boards, not roll goods — no roll width.
      widthM: null,
      // MINIMUM length on a random-length board. Freight prices off this too.
      lengthMm: r.lengthMinMm,
      widthMm: r.widthMm,
      // Real total board thickness: hybrid's "7.5+2" is already added up.
      thicknessMm: r.thicknessMm,
      // Timber states an oak veneer, hybrid a wear layer. Only one is ever set.
      wearLayerMm: r.veneerMm ?? r.wearLayerMm,
      weight: "",

      unitsPerPack: r.boardsPerPack,
      unitM2,
      // The sheet's printed figure, for cross-checking an invoice and nothing else.
      packM2Printed: r.packM2PrintedMin,
      // Riverhill states no pallet quantities.
      boxesPerPallet: null,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // Boxed product: no roll, so no cut rate and no cut threshold.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,

      sku: r.code,
      variantKey: variantKey(["riverhill", r.category, r.range, r.colour, r.code]),
      sourceNote: RIVERHILL_SOURCE,
      notes: noteParts.join(" · "),
    } satisfies ProductSeed;
  });
}

/**
 * Trims, nosings, underlay and floor protection.
 *
 * Underlay and floor protection are BOUGHT as a 20 m2 roll and PRICED per m2,
 * so the price goes in `costPrice` per m2 and the roll size in `rollM2` as the
 * purchase unit. There is no part-roll premium — Riverhill charges the same
 * per m2 either way — so `cutCostPrice` and `cutUpliftPct` stay null.
 */
function buildAccessories(supplierId: number): ProductSeed[] {
  return RIVERHILL_ACCESSORIES.map((a) => ({
    supplierId,
    supplier: "Riverhill",
    brand: "Riverhill",
    // The sheet's own grouping label doubles as the range, so the product list
    // reads "Underlay — HEL-20" rather than a bare code.
    range: a.fitsLabel || a.item,
    colour: "",
    category: a.rollM2 !== null ? "underlay" : "accessory",
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
    sellPrice: sell(a.price),
    cutCostPrice: null,
    cutUpliftPct: null,
    // Purchase unit where it differs from the sell unit: a 20 m2 roll sold per m2.
    rollM2: a.rollM2,

    // Empty = fits any range. A named range means it fits ONLY that range.
    fitsRange: a.fitsRange,

    sku: a.item,
    variantKey: variantKey(["riverhill", "accessory", a.fitsRange || "universal", a.item]),
    sourceNote: RIVERHILL_SOURCE,
    notes: [
      a.description,
      a.rollM2 !== null ? `Bought as a ${a.rollM2} m2 roll, priced per m2` : "",
      a.fitsRange ? `Fits ${a.fitsRange} only` : "Universal — fits any range",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "riverhill"));
  if (!supplier) throw new Error("Seed suppliers first — no Riverhill supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const items = [...floors, ...accessories];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* An accessory may only name a range that actually exists, or quoting could
   * offer a trim for a floor Riverhill does not sell. */
  const ranges = new Set(floors.map((f) => f.range));
  for (const a of accessories) {
    if (a.fitsRange && !ranges.has(a.fitsRange)) {
      throw new Error(`accessory ${a.sku} fits unknown range "${a.fitsRange}"`);
    }
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

  console.log(`Riverhill: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${floors.length} floor lines, ${ranges.size} ranges — ${[...byCategory.entries()]
      .map(([c, n]) => `${n} ${c}`)
      .join(", ")}`,
  );
  console.log(
    `  ${accessories.length} accessory lines — ${accessories.filter((a) => a.fitsRange).length} range-specific, ${accessories.filter((a) => !a.fitsRange).length} universal`,
  );
  const randoms = floors.filter((f) => (f.notes ?? "").includes("RANDOM LENGTH")).length;
  console.log(`  ${randoms} random-length lines seeded off their minimum pack m2`);
  for (const u of RIVERHILL_UNPRICED) {
    console.log(`  not seeded as a product: ${u.item} — ${u.note} (supplier record states $0)`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
