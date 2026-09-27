/**
 * Karndean into the price book — 193 colour lines across 12 ranges and 15
 * range/size families, every one of them vinyl and every rate per m2 ex GST.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: the list publishes standing rates and no
 * dated clearances.
 *
 * Five things this supplier does that the seed has to respect:
 *
 * 1. THE RATES HERE ARE THE RATE AND NOTHING ELSE. Karndean's fuel surcharge
 *    of $0.40/m2 and the Resiloop levy of $0.09/m2 are NOT in `costPrice` and
 *    must not be put there. Both are auto-applying per-m2 supplier fee rules,
 *    so the charge engine adds 49c/m2 to every Karndean order on top of these
 *    figures. This is the OPPOSITE of Tarkett, whose quoted rates already
 *    include their 9c Resiloop and who therefore carry no levy fee row.
 *    Baking the levies in here would charge them twice.
 *
 * 2. GLUEDOWN AND RIGID CORE ARE TWO PRODUCTS, NOT TWO FORMATS OF ONE. 48
 *    colours across Knight Tile and Van Gogh are published in both and share
 *    the colour NAME and nothing else: different code, different board size,
 *    different m2 a box and a different rate ($25.00 against $28.81 on Knight
 *    Tile, $33.13 against $35.69 on Van Gogh). Each is its own row, the format
 *    is part of the variant identity, and every paired row names its opposite
 *    number in `notes` so a quote cannot silently use the cheaper one.
 *
 * 3. A RANGE NAME DOES NOT PRICE A JOB, THE RANGE AND SIZE DO. Korlok 5G and
 *    Knight Tile each carry a wood family and a stone family under one range
 *    name at different board sizes and box quantities, so the size is in the
 *    variant key and every row is checked against its own family.
 *
 * 4. PACK QUANTITIES ARE THE DERIVED WHOLE-PIECE COUNT, NOT THE PRINTED m2.
 *    Nine of the 15 families print a rounded box m2 (Art Select Handcrafted
 *    prints 3.345 against a real 3.33792). `unitsPerPack` x `unitM2` is the
 *    ordering figure and the printed one goes in `packM2Printed` for checking
 *    an invoice, the same treatment as Floor Distributors.
 *
 * 5. NOTHING IS INVENTED WHERE THE LIST IS SILENT. No wear layer, gauge,
 *    thickness, warranty or acoustic rating is printed on any row, no lead
 *    time or stock position, no pallet quantity, no volume break and no
 *    minimum order. All of those stay null or empty rather than guessed.
 *
 * NOT SEEDED HERE, on purpose:
 *   - Opus Gluedown. Priced at $30.95/m2 on the workbook's Price List Basis
 *     sheet with not one colour published anywhere on the product sheet, so
 *     there is nothing orderable behind the rate. Kept in
 *     KARNDEAN_UNSEEDED_BASIS; this seed just reports it.
 *   - Accessories and adhesives. None are on this price list at all.
 *   - Freight and the two levies. Karndean deliver themselves for a flat $80
 *     an order, which with both levies sits on the supplier record as fee
 *     rules, not as products.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-karndean.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  KARNDEAN_AUDIT_NOTES,
  KARNDEAN_BASIS,
  KARNDEAN_EFFECTIVE_DATE,
  KARNDEAN_FAMILIES,
  KARNDEAN_FREIGHT_FLAT_EX_GST,
  KARNDEAN_FUEL_SURCHARGE_PER_M2,
  KARNDEAN_LEVIES_PER_M2,
  KARNDEAN_RESILOOP_PER_M2,
  KARNDEAN_ROWS,
  KARNDEAN_UNSEEDED_BASIS,
} from "./karndean-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** The source line every row carries, so a price can be argued from paperwork. */
const SOURCE = `Karndean Silver Australia price list effective ${KARNDEAN_EFFECTIVE_DATE}, owner-supplied workbook`;

function buildFloors(supplierId: number): ProductSeed[] {
  /* Family lookup, keyed the way the extractor groups them: a range name alone
   * is not enough, because Korlok 5G and Knight Tile each span two sizes. */
  const families = new Map(
    KARNDEAN_FAMILIES.map((f) => [`${f.range}|${f.format}|${f.sizeSlug}`, f]),
  );
  /* Which families the basis sheet prices, so a row can say what its rate is
   * quoted off. The sheet gives "Current display stand" throughout. */
  const basisFor = new Map<string, string>();
  for (const b of KARNDEAN_BASIS) {
    for (const [range, format, sizeSlug] of b.seededFamilies) {
      basisFor.set(`${range}|${format}|${sizeSlug}`, `${b.range} (${b.basis})`);
    }
  }

  return KARNDEAN_ROWS.map((r) => {
    const familyKey = `${r.range}|${r.format}|${r.sizeSlug}`;
    const family = families.get(familyKey);
    if (!family) throw new Error(`${r.code}: no family for "${familyKey}"`);

    /* One piece's real area off its printed dimensions, cross-checked against
     * the extractor's box m2 so a bad dimension cannot slip through as maths. */
    const unitM2 = round((r.lengthMm * r.widthMm) / 1_000_000, 6);
    const derived = round(unitM2 * r.piecesPerBox, 5);
    if (Math.abs(derived - round(r.boxM2, 5)) > 0.0001) {
      throw new Error(
        `${r.code}: ${r.piecesPerBox} pieces x ${unitM2} m2 = ${derived}, but boxM2 is ${r.boxM2}`,
      );
    }
    /* And the rate has to be the family's rate. Per-colour pricing is a real
     * thing on other suppliers (Floor Distributors) and is NOT a thing here,
     * so a row disagreeing with its family means the extract drifted. */
    if (r.pricePerM2 !== family.pricePerM2) {
      throw new Error(
        `${r.code}: $${r.pricePerM2}/m2 against family ${familyKey} at $${family.pricePerM2}/m2`,
      );
    }

    const noteParts = [
      SOURCE,
      `${r.printedCategory}, ${r.format}`,
      `${r.piecesPerBox} pieces, ${round(r.boxM2, 5)} m2 a box${
        r.boxM2Exact ? "" : ` (the list prints ${r.boxM2Printed}, which is rounded — the derived figure is what ordering uses)`
      }`,
      /* THE LEVY LINE GOES ON EVERY ROW. It is the single most likely thing to
       * be got wrong on this supplier, in both directions. */
      `THIS RATE EXCLUDES THE LEVIES: Karndean add a fuel surcharge of $${KARNDEAN_FUEL_SURCHARGE_PER_M2.toFixed(2)}/m2 and the Resiloop levy of $${KARNDEAN_RESILOOP_PER_M2.toFixed(2)}/m2 on top, ${KARNDEAN_LEVIES_PER_M2.toFixed(2)}c/m2 together, so a ${round(r.boxM2, 3)} m2 box carries $${round(r.boxM2 * KARNDEAN_LEVIES_PER_M2, 2).toFixed(2)} of levies. Both are supplier fee rules and are added automatically — do not add them to this price`,
    ];
    if (r.pairedCode) {
      noteParts.push(
        `SAME COLOUR, OTHER FORMAT, DIFFERENT PRICE: ${r.colour} is also published as ${r.pairedRange} (${r.pairedCode}) at $${r.pairedPricePerM2}/m2. Name the format when quoting, the two are not interchangeable`,
      );
    }
    const basis = basisFor.get(familyKey);
    if (basis) noteParts.push(`Rate quoted off the list's own basis row: ${basis}`);
    /* The workbook's own warning, carried onto the 20 rows it is about. */
    if (r.range === "LooseLay Longboard") {
      noteParts.push(
        "CONFIRM BEFORE A BIG QUOTE: the workbook's audit notes record that Karndean announced another Australian LooseLay Longboard refresh in September 2026, so this is the range whose rate is most likely to have moved",
      );
    }
    noteParts.push(
      "The list prints no wear layer, gauge, thickness, warranty or acoustic rating for this row, and no lead time, minimum order or pallet quantity — ask Karndean rather than assuming",
    );
    noteParts.push(`Colour name and code from ${r.source}`);

    return {
      supplierId,
      supplier: "Karndean",
      brand: "Karndean",
      range: r.range,
      colour: r.colour,
      category: r.category,
      // The list's own grouping wording (Luxury Vinyl Plank, Rigid Core LVT and
      // so on), kept so the book reads the way the price list does.
      tier: r.printedCategory,
      unit: "m2",

      backing: "",
      size: r.sizePrinted,
      // Planks and tiles, not roll goods.
      widthM: null,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      // NOT PRINTED on this list, on any row. Left null rather than guessed
      // from a Karndean web page that may describe a refreshed product.
      thicknessMm: null,
      wearLayerMm: null,
      weight: "",

      unitsPerPack: r.piecesPerBox,
      unitM2,
      // The list's printed figure, for cross-checking an invoice and nothing
      // else. Rounded on 9 of the 15 families.
      packM2Printed: r.boxM2Printed,
      // No pallet quantity is printed anywhere on this list.
      boxesPerPallet: null,

      // THE RATE AS PRINTED. The 49c/m2 of levies is added by the charge
      // engine off the supplier's fee rules, never folded in here.
      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // Boxed product: no roll, so no cut rate and no cut threshold.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      bulkKind: "pack",
      // No volume break is printed anywhere on this list.
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      // The list states no minimum order, so none is seeded. The box m2 is in
      // `unitsPerPack` and `unitM2` if the office needs the pack size.
      minOrderQty: null,

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      // Built by the extractor as karndean|range|colour|size. The size is in
      // it because a colour can exist twice at two sizes and two rates.
      variantKey: r.variantKey,
      sourceNote: `${SOURCE} (row ${r.sourceRow})`,
      notes: noteParts.join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "karndean"));
  if (!supplier) throw new Error("Seed suppliers first — no Karndean supplier row found.");

  const items = buildFloors(supplier.id);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);
  const skus = new Set(items.map((i) => i.sku));
  if (skus.size !== items.length) throw new Error(`duplicate product codes: ${items.length - skus.size}`);

  /* A paired row has to point at a code that is actually being seeded, and at
   * a different rate. If a pairing ever pointed at the same price the whole
   * gluedown/rigid-core warning would be noise. */
  const codes = new Set(KARNDEAN_ROWS.map((r) => r.code));
  for (const r of KARNDEAN_ROWS) {
    if (!r.pairedCode) continue;
    if (!codes.has(r.pairedCode)) throw new Error(`${r.code} pairs with unknown code "${r.pairedCode}"`);
    if (r.pairedPricePerM2 === r.pricePerM2) {
      throw new Error(`${r.code} pairs with ${r.pairedCode} at the same $${r.pricePerM2}/m2`);
    }
  }

  /* Opus is priced on the basis sheet with no colours behind it. It must not
   * appear as a product, or the book would carry a range nobody can order. */
  const opus = items.filter((i) => /opus/i.test(`${i.range} ${i.colour}`));
  if (opus.length) throw new Error(`Opus must not be seeded, found ${opus.length} rows`);

  /* No levy may be inside a cost price. The guard that keeps the Tarkett
   * treatment from being copied onto this supplier by a later edit. */
  for (const i of items) {
    const row = KARNDEAN_ROWS.find((r) => r.code === i.sku)!;
    if (i.costPrice !== row.pricePerM2) {
      throw new Error(`${i.sku}: cost price ${i.costPrice} is not the printed rate ${row.pricePerM2}`);
    }
  }

  let created = 0;
  let updated = 0;
  for (const product of items) {
    const [existing] = await db
      .select()
      .from(s.products)
      .where(eq(s.products.variantKey, product.variantKey!));
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

  const byTier = new Map<string, number>();
  for (const i of items) byTier.set(i.tier!, (byTier.get(i.tier!) ?? 0) + 1);

  console.log(`Karndean: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${new Set(items.map((i) => i.range)).size} ranges, ${KARNDEAN_FAMILIES.length} range/size families — ${[...byTier.entries()]
      .map(([t, n]) => `${n} ${t}`)
      .join(", ")}`,
  );
  console.log(
    `  ${new Set(items.map((i) => i.costPrice)).size} rates across the list: ${[...new Set(items.map((i) => i.costPrice))]
      .sort((a, b) => (a as number) - (b as number))
      .map((p) => `$${p}`)
      .join(", ")}`,
  );
  console.log(
    `  ${KARNDEAN_ROWS.filter((r) => r.pairedCode).length} lines are a colour published in BOTH gluedown and rigid core at different rates — format is part of the price`,
  );
  console.log(
    `  ${KARNDEAN_ROWS.filter((r) => !r.boxM2Exact).length} lines sit on a family whose printed box m2 is rounded — ordering maths uses the derived figure`,
  );
  console.log(
    `  levies NOT in any cost price: fuel $${KARNDEAN_FUEL_SURCHARGE_PER_M2.toFixed(2)}/m2 + Resiloop $${KARNDEAN_RESILOOP_PER_M2.toFixed(2)}/m2, both auto-applying fee rules. Tarkett's Resiloop IS in their rates — do not copy one supplier's treatment onto the other.`,
  );
  console.log(
    `  freight is a real auto-applying cost here, $${KARNDEAN_FREIGHT_FLAT_EX_GST} flat an order: Karndean deliver to Terra's warehouse themselves.`,
  );
  for (const u of KARNDEAN_UNSEEDED_BASIS) {
    console.log(`  not seeded as a product: ${u.range} at $${u.pricePerM2}/m2 — ${u.reason}`);
  }
  for (const n of KARNDEAN_AUDIT_NOTES) {
    if (n.status === "Source basis") continue;
    console.log(`  CONFIRM WITH SUPPLIER (${n.status}): ${n.note}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
