/**
 * Floor Distributors into the price book — 72 flooring colour lines across 9
 * ranges, 45 accessory lines (timber scotia, Viva scotia, Viva custom stair)
 * and the one underlay line.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: the list publishes standing rates and no
 * dated clearances.
 *
 * Six things this supplier does that the seed has to respect:
 *
 * 1. PRICE IS PER ROW, NOT PER RANGE. Four ranges print more than one rate
 *    across their colours (Balmain Feature $45.00/$47.50/$49.50, Balmain Oak
 *    $59.50/$61.50, Balmain Oak Wide $69.50/$74.00, Federation Plank
 *    $79.90/$82.90). No colour ever inherits a range rate, so `costPrice`
 *    always comes off its own row.
 *
 * 2. FEDERATION PLANK PRICES ON LENGTH. The same colour costs $79.90/m2 as a
 *    1830mm board and $82.90/m2 as a 2190mm one. Length is therefore part of
 *    the variant identity, not just a spec, and it is in `variantKey`.
 *
 * 3. FULL PACK QUANTITIES ONLY. Nothing ships broken, so `minOrderQty` is one
 *    box in m2 and the pack arithmetic is held as the INTEGER board count with
 *    m2 derived off it. The sheet's printed box m2 goes in `packM2Printed` for
 *    cross-checking an invoice and nowhere near the ordering maths.
 *
 * 4. ONE PALLET DOES NOT DIVIDE WHOLE. Every Viva Luxury Vinyl Plank row
 *    prints 111.5 m2 a pallet against a 2.787091 m2 box, which is 40.006
 *    boxes. `boxesPerPallet` stays null on those 20 rows rather than carrying
 *    a rounded count that freight would then price off.
 *
 * 5. NO PALLET PRICE BREAK. The printed full-pallet m2 is freight information.
 *    Damien confirmed there is no cheaper pallet rate anywhere on this
 *    supplier, so `volumeCostPrice` and `volumeQty` stay null on all flooring.
 *
 * 6. TRIM FITS ARE PER RANGE. A Viva scotia or custom stair that fits two
 *    ranges is seeded as one row PER range (the Chameleon pattern) so quoting
 *    can only ever offer a trim against a floor Floor Distributors sells. The
 *    timber scotia is the other way round: it names colours, not ranges, so it
 *    is universal here and the link lives on the flooring row's `scotiaCode`.
 *
 * NOT SEEDED HERE, on purpose:
 *   - Viva Stair (code prefix "VST"). Scrapped on Damien's instruction: the
 *     list publishes no colour codes for it. Kept in FLOORDISTRIBUTORS_DROPPED
 *     so it can't be silently lost; this seed just reports it.
 *   - The middle underlay tier ($1.95 for 10-20 rolls). Damien seeded two
 *     tiers only: $2.05 standard with the break at 20 rolls to $1.85.
 *   - Freight. Floor Distributors drop to a Brisbane depot and Terra's own
 *     courier collects, so their freight schedule sits on the supplier record
 *     as reference only. The one real cost, picking and bailing $29.50 an
 *     order, is a supplier fee rule, not a product.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-floordistributors.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  FLOORDISTRIBUTORS_ACCESSORIES,
  FLOORDISTRIBUTORS_CONFLICTS,
  FLOORDISTRIBUTORS_DROPPED,
  FLOORDISTRIBUTORS_PICKING_FEE,
  FLOORDISTRIBUTORS_ROWS,
  FLOORDISTRIBUTORS_SOURCE,
  FLOORDISTRIBUTORS_UNDERLAY,
} from "./floordistributors-data";

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

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** The sheet's own $/m and $/piece wording mapped onto the product unit vocabulary. */
function unitFor(printed: string): string {
  if (printed === "$/m") return "lm";
  if (printed === "$/piece") return "each";
  throw new Error(`unknown accessory unit "${printed}" — map it, do not guess`);
}

/** Ranges that price on board length, so the length has to sit in the variant key. */
const LENGTH_PRICED = new Set(
  [...new Set(FLOORDISTRIBUTORS_ROWS.map((r) => r.range))].filter((range) => {
    const rows = FLOORDISTRIBUTORS_ROWS.filter((r) => r.range === range);
    const lengths = new Set(rows.map((r) => r.lengthMm));
    if (lengths.size < 2) return false;
    return new Set(rows.map((r) => `${r.lengthMm}|${r.pricePerM2}`)).size > 1;
  }),
);

function buildFloors(supplierId: number): ProductSeed[] {
  return FLOORDISTRIBUTORS_ROWS.map((r) => {
    /* One board's real area off its printed dimensions, cross-checked against
     * the extractor's box m2 so a bad dimension can't slip through as maths. */
    const unitM2 = round((r.lengthMm * r.widthMm) / 1_000_000, 6);
    const derived = round(unitM2 * r.boardsPerBox, 4);
    if (Math.abs(derived - round(r.boxM2, 4)) > 0.001) {
      throw new Error(
        `${r.code}: ${r.boardsPerBox} boards x ${unitM2} m2 = ${derived}, but boxM2 is ${r.boxM2}`,
      );
    }

    const noteParts = [
      FLOORDISTRIBUTORS_SOURCE,
      r.printedCategory,
      `Full packs only: ${r.boardsPerBox} boards, ${round(r.boxM2, 4)} m2 a box (sheet prints ${r.boxM2Printed})`,
    ];
    if (LENGTH_PRICED.has(r.range)) {
      noteParts.push(
        `PRICES ON LENGTH: this range charges a different rate per board length, and this row is the ${r.lengthMm}mm board at $${r.pricePerM2}/m2. Check the length before quoting.`,
      );
    }
    if (r.boxesPerPallet !== null) {
      noteParts.push(`${r.boxesPerPallet} boxes a pallet (${r.palletM2Printed} m2) — freight info, not a price break`);
    } else {
      noteParts.push(
        `Pallet count unknown: the sheet's ${r.palletM2Printed} m2 pallet does not divide into whole boxes, so no box-per-pallet figure is carried. Confirm the pallet make-up with Floor Distributors before pricing freight off it.`,
      );
    }
    if (r.scotiaCode) {
      noteParts.push(
        r.scotiaInferred
          ? `Matching scotia read as ${r.scotiaCode} — the sheet printed "${r.matchLabel}", which is not a scotia colour. CONFIRM with Floor Distributors.`
          : `Matching scotia ${r.scotiaCode} (sheet prints "${r.matchLabel}")`,
      );
    } else if (r.matchLabel) {
      noteParts.push(`Sheet prints matching trim as "${r.matchLabel}"`);
    }
    if (r.vivaStairNote) noteParts.push(`Stair trim: ${r.vivaStairNote}`);
    if (r.note) noteParts.push(r.note);

    return {
      supplierId,
      supplier: "Floor Distributors",
      brand: r.brand,
      range: r.range,
      colour: r.colour,
      category: r.category,
      // The sheet's own grouping wording, kept so the list reads the way the
      // price list does rather than the way the database normalises it.
      tier: r.printedCategory,
      unit: "m2",

      backing: "",
      size: `${r.lengthMm} x ${r.widthMm} x ${r.thicknessMm}mm`,
      // Boards, not roll goods.
      widthM: null,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      // Vinyl and hybrid print one; engineered timber does not.
      wearLayerMm: r.wearLayerMm,
      weight: "",

      unitsPerPack: r.boardsPerBox,
      unitM2,
      // The sheet's printed figure, for cross-checking an invoice and nothing else.
      packM2Printed: r.boxM2Printed,
      // Null on the 20 Viva LVP rows, whose printed pallet is 40.006 boxes.
      boxesPerPallet: r.boxesPerPallet,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // Boxed product: no roll, so no cut rate and no cut threshold.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      bulkKind: "pack",
      // Damien confirmed no pallet price break exists on this supplier.
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      // Full pack quantities only: one box is the smallest they will sell.
      minOrderQty: round(r.boxM2, 4),

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      variantKey: variantKey([
        "floordistributors",
        r.category,
        r.range,
        r.colour,
        LENGTH_PRICED.has(r.range) ? r.lengthMm : null,
        r.code,
      ]),
      sourceNote: `${FLOORDISTRIBUTORS_SOURCE} (p${r.sourcePage})`,
      notes: noteParts.join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

/**
 * Scotia, and the custom stair pieces Floor Distributors mill out of the
 * flooring itself.
 *
 * A trim that names two ranges becomes TWO rows, one per range, so a quote can
 * never offer a Viva Classic scotia against a floor it does not fit. The
 * timber scotia names colours instead of ranges, so it stays universal and the
 * match is carried on the flooring row.
 */
function buildAccessories(supplierId: number): ProductSeed[] {
  const out: ProductSeed[] = [];
  for (const a of FLOORDISTRIBUTORS_ACCESSORIES) {
    const isStair = a.printedCategory === "Stair Nosing";
    // Custom stair is milled to order out of the flooring, not stocked.
    const madeToOrder = /custom made/i.test(a.note);
    const targets = a.fitsRanges.length ? a.fitsRanges : [""];

    for (const fits of targets) {
      out.push({
        supplierId,
        supplier: "Floor Distributors",
        brand: a.brand,
        range: fits && isStair ? `${a.range}, ${fits}` : a.range,
        colour: "",
        category: "accessory",
        tier: a.printedCategory,
        unit: unitFor(a.unit),

        backing: "",
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
        bulkKind: "pack",
        volumeCostPrice: null,
        volumeQty: null,
        priceOnApplication: false,
        minOrderQty: null,

        // Empty = fits any range. A named range means it fits ONLY that range.
        fitsRange: fits,
        madeToOrder,
        leadTimeDays: null,
        availabilityNote: madeToOrder ? "Made to order out of the flooring — confirm lead time at order" : "",

        sku: a.code,
        variantKey: variantKey([
          "floordistributors",
          "accessory",
          a.range,
          a.code,
          fits || "universal",
        ]),
        sourceNote: `${FLOORDISTRIBUTORS_SOURCE} (p${a.sourcePage})`,
        notes: [
          a.description,
          `Sold per ${a.unit === "$/m" ? "lineal metre" : "piece"}`,
          fits ? `Fits ${fits} only` : "Range not stated on the sheet — matched by colour, see the flooring row's scotia code",
          // The sheet's own bracketed wording, kept verbatim as the evidence.
          a.suitsPrinted ? `Sheet lists it as suiting: ${a.suitsPrinted}` : "",
          a.note,
        ]
          .filter(Boolean)
          .join(" · "),
        active: true,
      });
    }
  }
  return out;
}

/**
 * Underlay. Priced per lineal metre off a 50m roll, with a volume rate.
 *
 * The list prints three tiers; Damien seeded two. $2.05 standard, and $1.85
 * once the order reaches 20 rolls. 20 rolls is 1000 lineal metres, and lineal
 * metres is the unit it is priced in, so `volumeQty` is 1000, not 20.
 *
 * `rollM2` is 50 (one roll, in `unit`) with no cut rate: Floor Distributors
 * sell whole rolls at one rate, so there is no part-roll premium to resolve.
 */
function buildUnderlay(supplierId: number): ProductSeed[] {
  return FLOORDISTRIBUTORS_UNDERLAY.map((u) => ({
    supplierId,
    supplier: "Floor Distributors",
    brand: "Floor Distributors",
    range: u.description.replace(/\s*\(\d+m\)\s*$/, ""),
    colour: "",
    category: "underlay",
    tier: "Underlay",
    unit: "lm",

    backing: "",
    size: `${u.rollM}m roll`,
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

    costPrice: u.price1to9,
    sellPrice: sell(u.price1to9),
    // Whole rolls at one rate: no part-roll premium.
    cutCostPrice: null,
    cutUpliftPct: null,
    rollM2: u.rollM,
    bulkKind: "roll",
    // The break Damien chose, in the unit it is priced in.
    volumeCostPrice: u.price20plus,
    volumeQty: u.breakM,
    priceOnApplication: false,
    minOrderQty: null,

    fitsRange: "",
    madeToOrder: false,
    leadTimeDays: null,
    availabilityNote: "",

    sku: u.code,
    variantKey: variantKey(["floordistributors", "underlay", u.code]),
    sourceNote: `${FLOORDISTRIBUTORS_SOURCE} (p${u.sourcePage})`,
    notes: [
      FLOORDISTRIBUTORS_SOURCE,
      `Bought as a ${u.rollM}m roll, priced per lineal metre`,
      `Two tiers on Damien's instruction: $${u.price1to9}/lm standard, $${u.price20plus}/lm from ${u.breakRolls} rolls (${u.breakM} lm)`,
      `The sheet's middle tier ($${u.price10to20}/lm for 10-20 rolls) is deliberately not seeded`,
    ].join(" · "),
    active: true,
  }));
}

async function main() {
  const [supplier] = await db
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.code, "floordistributors"));
  if (!supplier) throw new Error("Seed suppliers first — no Floor Distributors supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const underlay = buildUnderlay(supplier.id);
  const items = [...floors, ...accessories, ...underlay];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* A trim may only name a range that actually exists, or quoting could offer
   * a scotia for a floor Floor Distributors does not sell. */
  const ranges = new Set(floors.map((f) => f.range));
  for (const a of accessories) {
    if (a.fitsRange && !ranges.has(a.fitsRange)) {
      throw new Error(`accessory ${a.sku} fits unknown range "${a.fitsRange}"`);
    }
  }

  /* And the reverse: a flooring row may only point at a scotia that exists. */
  const accCodes = new Set(FLOORDISTRIBUTORS_ACCESSORIES.map((a) => a.code));
  for (const r of FLOORDISTRIBUTORS_ROWS) {
    if (r.scotiaCode && !accCodes.has(r.scotiaCode)) {
      throw new Error(`${r.code} points at unknown scotia "${r.scotiaCode}"`);
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

  const byCategory = new Map<string, number>();
  for (const i of floors) byCategory.set(i.category!, (byCategory.get(i.category!) ?? 0) + 1);

  console.log(`Floor Distributors: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${floors.length} floor lines, ${ranges.size} ranges — ${[...byCategory.entries()]
      .map(([c, n]) => `${n} ${c}`)
      .join(", ")}`,
  );
  console.log(
    `  ${accessories.length} accessory rows from ${FLOORDISTRIBUTORS_ACCESSORIES.length} sheet lines (a trim fitting two ranges is one row per range) — ${accessories.filter((a) => a.fitsRange).length} range-specific, ${accessories.filter((a) => !a.fitsRange).length} matched by colour`,
  );
  console.log(
    `  ${accessories.filter((a) => a.madeToOrder).length} made-to-order stair pieces, ${underlay.length} underlay line`,
  );

  const multiRate = [...ranges].filter(
    (rg) => new Set(floors.filter((f) => f.range === rg).map((f) => f.costPrice)).size > 1,
  );
  console.log(`  ${multiRate.length} ranges price per colour, not per range: ${multiRate.join(", ")}`);
  console.log(`  ${LENGTH_PRICED.size} range prices on board length: ${[...LENGTH_PRICED].join(", ")}`);

  const noPallet = floors.filter((f) => f.boxesPerPallet === null).length;
  console.log(`  ${noPallet} lines carry no boxes-per-pallet — printed pallet m2 does not divide whole`);

  const drift = FLOORDISTRIBUTORS_ROWS.filter(
    (r) => Math.abs(r.boxM2 - r.boxM2Printed) > 0.0005,
  ).length;
  console.log(
    `  ${drift} lines where the sheet's printed box m2 is rounded — ordering maths uses the derived figure`,
  );

  console.log(
    `  freight not seeded: Floor Distributors drop to a Brisbane depot and Terra's courier collects. Only real cost is picking and bailing $${FLOORDISTRIBUTORS_PICKING_FEE} an order, held as a supplier fee rule.`,
  );
  for (const d of FLOORDISTRIBUTORS_DROPPED) {
    console.log(`  not seeded as a product: ${d.code} ${d.description} — ${d.reason}`);
  }
  for (const c of FLOORDISTRIBUTORS_CONFLICTS) {
    console.log(`  CONFIRM WITH SUPPLIER: ${c}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
