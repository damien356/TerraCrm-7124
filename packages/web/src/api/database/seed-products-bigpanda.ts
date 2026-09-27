/**
 * Big Panda Flooring into the price book — 38 floor colours across 5 ranges,
 * plus 5 trims and 1 underlay off the "Accessories" sheet.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: this list carries one standard rate per
 * (range, board size) and no dated clearances.
 *
 * Seven things this supplier does that the seed has to respect:
 *
 * 1. PRICE IS PER (RANGE, BOARD SIZE), NOT PER RANGE. Four ranges hold one rate
 *    for every colour; "Modern Engineered Timber / Oak 14/3mm" holds two, split
 *    by board size ($59 on 1900x190, $62 on 2200x220). The extractor asserts
 *    one price per (range, size) pair, so the row's own `pricePerM2` is always
 *    correct and nothing needs resolving here. `size` is part of the variant
 *    key on that account.
 *
 * 2. `thicknessMm` IS THE TOTAL INCLUDING THE ATTACHED PAD, because that is
 *    what the range is named and what the customer is sold: Titan Guard 6.5mm
 *    is a 5mm board + 1.5mm IXPE. The core alone goes in `notes` as the figure
 *    to compare against a rival's SPC, never into `thicknessMm` — quoting a
 *    customer 5mm for a product called 6.5mm would be wrong in the other
 *    direction.
 *
 * 3. `wearLayerMm` IS NULL ON ALL 25 SPC ROWS, DELIBERATELY. The "+1.5mm" in
 *    the dimension string is UNDERLAY. Writing 1.5 into `wearLayerMm` would
 *    claim a wear layer three times thicker than a premium commercial SPC and
 *    is the single worst data error available in this file. Big Panda publish
 *    no wear layer at all.
 *
 * 4. PACK MATHS OFF THE DERIVED BOARD COUNT. `unitsPerPack` is the recovered
 *    integer board count and `unitM2` is one board's real area, so
 *    unitsPerPack x unitM2 is the ordering figure. The 2 rows whose printed
 *    m2/box disagrees (2200x220: 2.904 derived vs 2.900 printed) keep
 *    `packM2Printed` for invoice cross-checks and nothing else.
 *
 * 5. NO ROLL/CUT BREAK AND NO PALLET RATE EXISTS. One price column in the whole
 *    file, and no boxes-per-pallet figure either, so `cutCostPrice`,
 *    `cutUpliftPct`, `rollM2` and `boxesPerPallet` are null on every row. Not
 *    missing data on the price side (there is genuinely one rate); genuinely
 *    missing on the pallet side (they publish no pallet quantity).
 *
 * 6. THE SCOTIA GETS A REAL `fitsRange`. It is the only accessory in this file
 *    tied to ONE floor range — "6.5mm SPC ONLY" — so it is the `fitsRange`
 *    column doing its job, the same way Riverhill's confirmed per-range trims
 *    do. The other four trims say "Match Colour" or "All Laminate/SPC", which
 *    name a substrate rather than a range, so they stay empty (same call as
 *    NFD). Nothing at all fits the engineered timber, flagged on both oak
 *    ranges so a quote cannot silently offer a trim that does not exist.
 *
 * 7. THE PRICE LIST DATE IS OFF THE FILENAME. The file has no date column, so
 *    Feb 2025 is an inference. Every row's `sourceNote` carries both the age
 *    and the fact that the date itself is unconfirmed — a stronger warning
 *    than Terramater's, where the date at least was printed.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-bigpanda.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  BP_ACCESSORIES,
  BP_FLOORS,
  BP_PRICE_LIST_PRINTED,
  BP_SOURCE,
} from "./bigpanda-data";

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
 * The product family, read off the range name and not invented — "Titan Guard"
 * is Big Panda's own SPC line name and both oaks are engineered. Stored as
 * `tier` so the product list groups the way Damien talks about them, matching
 * Terramater / Riverhill / Sunstar.
 */
function family(range: string): string {
  if (range.startsWith("Titan Guard")) return "Titan Guard SPC";
  return "Engineered Oak";
}

const DATE_WARNING =
  `Big Panda list dated ${BP_PRICE_LIST_PRINTED} — over 18 months old, AND that date is off the filename, not the list. ` +
  "The workbook carries no date column anywhere, so the age is a floor not a fact. Re-confirm the rate with Big Panda and ask for a dated list before a large order.";

const NO_TIMBER_TRIMS =
  "Big Panda publish no scotia, trim, reducer or stair nosing for their engineered timber — all 6 accessories are SPC or laminate items. Trims for this floor have to be bought elsewhere.";

function buildFloors(supplierId: number): ProductSeed[] {
  return BP_FLOORS.map((r) => {
    const isSpc = r.category === "hybrid";
    return {
      supplierId,
      supplier: "Big Panda Flooring",
      brand: "Big Panda Flooring",
      range: r.range,
      colour: r.colour,
      category: r.category,
      tier: family(r.range),
      unit: "m2",

      size: r.size,
      // Boards, not roll goods — no roll width.
      widthM: null,
      // Real column because freight depends on it: the shortest board here is
      // 1500mm and every one exceeds the 1200mm pallet threshold, so Unified
      // is the carrier on every Big Panda order.
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      // TOTAL as named and sold. On SPC that includes the 1.5mm attached pad.
      thicknessMm: r.thicknessMm,
      // On timber this is the oak veneer off the "14/3mm" notation. On SPC it is
      // NULL: the only other number published is the attached pad, which is not
      // a wear layer. See note 3.
      wearLayerMm: r.veneerMm,
      // No box or pallet weight is published anywhere in the file.
      weight: "",

      // Recovered integer board count (the file has no boards-per-box column).
      unitsPerPack: r.boardsPerBox,
      unitM2: r.boardM2,
      // Only set where the printed figure disagrees with the derived one.
      packM2Printed: r.m2PerBoxDrifts ? r.m2PerBoxPrinted : null,
      // Unpublished, not zero — no pallet quantity anywhere in the file.
      boxesPerPallet: null,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // One price column in the whole file: no cut rate, no pallet break.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,

      // SPC rows carry Big Panda's own code. Every engineered row is codeless
      // in the source, so it stays null rather than being invented.
      sku: r.code,
      // `size` is in the key because Modern Engineered prices on board size.
      variantKey: variantKey(["bigpanda", r.category, r.range, r.colour, r.size]),
      sourceNote: DATE_WARNING,
      notes: [
        BP_SOURCE,
        `${r.surface} finish`,
        isSpc
          ? `SPC. ${r.thicknessMm}mm as named and sold = ${r.coreMm}mm board + ${r.padMm}mm attached IXPE pad. COMPARE ON THE ${r.coreMm}mm, not the ${r.thicknessMm}mm — a rival's "${r.thicknessMm}mm SPC" with no attached pad is ${r.thicknessMm}mm of actual board. No underlay needed on top of this floor.`
          : `Engineered oak, ${r.thicknessMm}mm total with a ${r.veneerMm}mm wear veneer. ${r.surface}.`,
        isSpc
          ? "NO WEAR LAYER PUBLISHED. The +1.5mm is underlay, not wear layer — do not quote it as one. No AC or commercial rating stated either, so 'is it rated for a shop' cannot be answered from this list."
          : "",
        `${r.boardsPerBox} boards per box, ${r.m2PerBox} m2 (${r.boardM2} m2 per board)` +
          (r.m2PerBoxDrifts
            ? `. Big Panda print ${r.m2PerBoxPrinted} m2/box; the derived figure is ${r.m2PerBox} and is what ordering uses. The printed one is kept for cross-checking an invoice.`
            : "."),
        r.m2PerBox < 1.5
          ? `Small box: ${r.m2PerBox} m2 against 2.052 on the 6.5mm and 8.0mm, so a 100 m2 job is ~${Math.ceil(100 / r.m2PerBox)} boxes instead of ~49. More to load, stack and count for the same floor.`
          : "",
        "Boxes per pallet and box weight are not published, so a pallet count and a freight price cannot be worked out from this list.",
        r.range.startsWith("Modern Engineered")
          ? `PRICE SPLITS ON BOARD SIZE WITHIN THIS RANGE: 1900x190 is $59.00/m2 and 2200x220 is $62.00/m2. This colour is the ${r.size} board at $${r.pricePerM2.toFixed(2)}. Never quote "Modern Engineered Timber" without the colour.`
          : "",
        r.category === "timber" ? NO_TIMBER_TRIMS : "",
        r.colour === "Natural Oak"
          ? 'COLOUR NAME CLASH: "Natural Oak" is also a Titan Guard 8.0mm SPC colour at $25.50/m2 against this at $59.00/m2. Always confirm the range.'
          : "",
        r.code ? `Big Panda code ${r.code}.` : "Big Panda publish no product code for their engineered timber.",
        "Big Panda do not deliver — pickup from Acacia Ridge (~45 min up the M1) or Terra's own carrier. No baling, packing or dispatch fee, confirmed on their notes sheet.",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

function buildAccessories(supplierId: number): ProductSeed[] {
  return BP_ACCESSORIES.map((a) => ({
    supplierId,
    supplier: "Big Panda Flooring",
    brand: "Big Panda Flooring",
    range: a.item,
    colour: "",
    category: a.isUnderlay ? "underlay" : "accessory",
    tier: a.isUnderlay ? "Underlay" : "Trims",
    // Trims sell per length, the underlay per roll.
    unit: a.isUnderlay ? "roll" : "each",

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
    rollM2: null,
    priceOnApplication: false,

    // Set ONLY on the scotia, which names one thickness. See note 6.
    fitsRange: a.fitsRange,
    availabilityNote: a.applies.toLowerCase().includes("laminate")
      ? "Big Panda list this as fitting laminate as well as SPC, but they sell no laminate in this price list. Either it is shared stock off a range they no longer list, or the products sheet is incomplete — ask before promising it for a laminate job."
      : "",

    sku: null,
    variantKey: variantKey(["bigpanda", "accessory", a.item, a.size]),
    sourceNote:
      `$${a.price.toFixed(2)} ex GST per ${a.unitPrinted.toLowerCase()}, ${a.size}. Applicable range as printed: "${a.applies}". ` +
      DATE_WARNING,
    notes: [
      BP_SOURCE,
      a.fitsRange
        ? `FITS ONE THICKNESS ONLY — ${a.fitsRange}. Big Panda state "6.5mm SPC ONLY", so this is wrong on an 8.0mm or 10.5mm job.`
        : "",
      a.multiLength
        ? `TWO LENGTHS AT ONE PRICE: ${a.size}. So $${a.price.toFixed(2)} buys 2700mm on an 8mm SPC job and 2400mm on a 6.5mm or 10.5mm one — 300mm more trim for the same money on the 8mm.`
        : "",
      a.matchColour
        ? "Colour is matched to the floor at order time rather than being a stocked variant, so there is nothing to choose here — state the floor range and colour on the order."
        : "",
      a.coverageM2 && a.perM2
        ? `${a.coverageM2} m2 roll at $${a.price.toFixed(2)} = $${a.perM2.toFixed(2)}/m2. WHAT IT IS FOR IS UNSTATED: all 25 Big Panda SPC lines already have 1.5mm of pad attached and do not need underlay, so it reads as being for the engineered oak — a reading, not a fact. Confirm before quoting it alongside an SPC job.`
        : "",
      "Big Panda do not deliver — pickup from Acacia Ridge or Terra's own carrier. No baling, packing or dispatch fee.",
      "MDF scotia is deliberately absent from this list: Terra do not sell it, so it was excluded at source. The gap is intentional.",
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "bigpanda"));
  if (!supplier) throw new Error("Seed suppliers first — no Big Panda supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const items = [...floors, ...accessories];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* The +1.5mm attached pad must never have been read as a wear layer. This is
   * the one error in this file that would be invisible on screen and wrong in
   * a commercial customer's hands, so it is asserted rather than trusted. */
  for (const f of floors) {
    if (f.category === "hybrid" && f.wearLayerMm !== null) {
      throw new Error(`${f.range} ${f.colour}: SPC row has a wear layer of ${f.wearLayerMm} — the +1.5mm is a PAD, not wear`);
    }
    if (f.unitsPerPack === null || f.unitM2 === null) {
      throw new Error(`${f.range} ${f.colour}: missing pack maths`);
    }
  }
  /* Only the scotia may claim a floor range — the rest name a substrate. */
  const claiming = accessories.filter((a) => a.fitsRange);
  if (claiming.length !== 1 || !claiming[0].range.startsWith("Scotia")) {
    throw new Error(`expected only the scotia to name a range, got: ${claiming.map((a) => a.range).join(", ")}`);
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
  const ranges = new Set(floors.map((i) => i.range)).size;

  console.log(`Big Panda Flooring: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${ranges} floor ranges — ${[...byCategory.entries()].map(([c, n]) => `${n} ${c}`).join(", ")}`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
