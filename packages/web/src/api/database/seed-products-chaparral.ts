/**
 * Chaparral Carpets broadloom into the price book — 22 colours across 3
 * ranges, priced per lineal metre.
 *
 * Five things here are deliberate.
 *
 * 1. CATEGORY IS `carpet`, UNIT IS `lm`, WIDTH IS 3.6m ON ALL 22 ROWS. All
 *    carpet is priced per LINEAL metre, same as EC Carpets, Victoria Carpets
 *    and Belgotex broadloom: bought by the metre off a roll. The difference
 *    here is that the WIDTH IS KNOWN, so this is the first lm-priced carpet in
 *    the book that converts to m2 at all.
 *
 *    THE WIDTH IS NOT IN THE WORKBOOK. Damien confirmed it directly, and
 *    `CHAPARRAL_ROLL_WIDTH_SOURCE` says so on the data side while every product
 *    note repeats it, because a width is exactly the kind of figure that gets
 *    treated as printed spec a year later. It also is NOT the 3.66m much of the
 *    trade rolls: 60mm narrower, which is worth confirming before a big order
 *    because a 3.66m assumption under-orders by 1.7% and a 4.0m one by 10%.
 *
 * 2. THE 20 LM BREAK IS SEEDED AS A REAL ROLL/CUT SPLIT, on every row — unlike
 *    EC Carpets where only 10 of 27 ranges carry one. All three ranges publish
 *    both rates, so:
 *        rollM2       = 20      (the threshold, in lm, `unit` being lm)
 *        costPrice    = the 20+ lm roll rate  (paid AT or ABOVE the break)
 *        cutCostPrice = the under-20 lm cut rate (what a shorter order pays)
 *    That is exactly how `resolveRollCut` reads the pair: `onRollRate` is
 *    `qty >= rollM2`, rate is `costPrice` there and `cutCostPrice` below.
 *    `bulkKind` stays "roll" because that is literally what it is.
 *
 * 3. THE BREAK IS A CLIFF, AND THE RESOLVER IS WHAT CATCHES IT. The discount
 *    applies to the WHOLE quantity, so on all three ranges 19 lm costs MORE
 *    than 20 lm: $132.00 more on Apartment 2, $111.00 on Kingston, $62.00 on
 *    Outback. `resolveRollCut`'s `betterAsFullRoll` branch computes the
 *    break-even per line (17.06 / 17.75 / 18.55 lm) and tells the office in
 *    the quote note, which is the whole reason this is modelled as prices
 *    rather than written up as a warning nobody reads at quote time.
 *
 *    The break is a FLAT $10.00/lm on every range, asserted at parse time —
 *    so it is worth 14.7% on Apartment 2 and 7.2% on Outback. The relative
 *    prize is biggest at the BUDGET end, same backwards shape as EC's $8.
 *
 * 4. THE FUEL SURCHARGE AND BALING ARE NOT IN THESE PRICES. $2.00/lm fuel and
 *    $20.00 baling are on every row of the source, and both stay on the
 *    supplier as dated fee rules. Baling is PER ORDER, not per roll: the
 *    workbook words it "per roll" and Damien has corrected it, so the fee rule
 *    uses basis "order". Chaparral's own word for the fuel surcharge
 *    is "temporary": baked into 22 costPrice values it could not be switched
 *    off without re-importing the list. `costPrice` is the rate, nothing else.
 *    So a 15 lm Apartment 2 order is $1,020.00 of goods here and $1,050.00 of
 *    true material cost once the surcharge is added by the charge engine.
 *
 * 5. NATURAL DIRECTION AND BROMPTON ARE NOT SEEDED, AND EVERY ROW SAYS SO.
 *    The source's Supplier Rules sheet removed both — no longer on Chaparral's
 *    website — and carries no price row for either. Damien's message quoted
 *    rates for them, but nothing in the source supports those figures, so they
 *    are absent by decision, exactly as Big Panda's MDF Scotia is. The note is
 *    on the product rows because that is where someone hunting for a missing
 *    range will actually look.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-chaparral.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  CHAPARRAL_BALING,
  CHAPARRAL_BALING_BASIS_SOURCE,
  CHAPARRAL_BREAK_DISCOUNT_PER_LM,
  CHAPARRAL_BREAK_LM,
  CHAPARRAL_BROADLOOM,
  CHAPARRAL_EXCLUDED_RANGES,
  CHAPARRAL_FUEL,
  CHAPARRAL_PRICE_LIST_PRINTED,
  CHAPARRAL_PRICE_STATUS,
  CHAPARRAL_RANGES,
  CHAPARRAL_ROLL_WIDTH_M,
  CHAPARRAL_ROLL_WIDTH_SOURCE,
  CHAPARRAL_SOURCE,
  CHAPARRAL_TRADE_STANDARD_WIDTH_M,
} from "./chaparral-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(CHAPARRAL_RANGES.map((r) => [r.range, r]));

const money = (n: number) => `$${n.toFixed(2)}`;
const EXCLUDED_NAMES = CHAPARRAL_EXCLUDED_RANGES.map((r) => r.range).join(" and ");

function buildChaparral(supplierId: number): ProductSeed[] {
  return CHAPARRAL_BROADLOOM.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;

    return {
      supplierId,
      supplier: "Chaparral Carpets",
      brand: "Chaparral Carpets",
      range: r.range,
      colour: r.colour,
      category: "carpet",
      // NO FIBRE, GRADE OR BAND IS PUBLISHED. EC Carpets' fibre column made
      // `tier` meaningful there; Chaparral state nothing, so it stays blank
      // rather than inventing a band out of the price.
      tier: "",
      // Bought by the broadloom metre off a roll.
      unit: "lm",
      // 3.6m on every range. FROM DAMIEN, NOT THE WORKBOOK — see note 1. This
      // is what lets lm convert to m2 on a Chaparral line.
      widthM: CHAPARRAL_ROLL_WIDTH_M,
      size: `${CHAPARRAL_ROLL_WIDTH_M}m wide`,
      // Roll LENGTH is still unpublished, as are pile height, face weight,
      // backing and any ACCS rating.
      lengthMm: null,
      widthMm: null,
      thicknessMm: null,
      wearLayerMm: null,
      weight: "",
      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      // The 20+ lm roll rate. NOT the cut rate, and NOT carrying the fuel
      // surcharge or baling — those are supplier fee rules.
      costPrice: r.rollPerLm,
      sellPrice: sell(r.rollPerLm),

      // The under-20 lm cut rate, HIGHER than the roll rate. Set
      // `cutCostPrice` OR `cutUpliftPct`, never both.
      cutCostPrice: r.cutPerLm,
      cutUpliftPct: null,
      rollM2: CHAPARRAL_BREAK_LM,
      bulkKind: "roll",

      priceOnApplication: false,
      // Not published. Chaparral state no minimum, so left null rather than
      // borrowed off another carpet supplier.
      minOrderQty: null,
      priceValidUntil: "",
      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      // Chaparral publish no colour or product code at all.
      sku: "",
      variantKey: r.variantKey,
      sourceNote:
        `${money(r.cutPerLm)}/lm ex GST under ${CHAPARRAL_BREAK_LM} lm, ${money(r.rollPerLm)}/lm at ${CHAPARRAL_BREAK_LM} lm and over, from the ${CHAPARRAL_PRICE_LIST_PRINTED} list (${CHAPARRAL_PRICE_STATUS.toLowerCase()}). ` +
        `A flat ${money(CHAPARRAL_BREAK_DISCOUNT_PER_LM)}/lm off at the break, ${meta.discountPct}% on this range. ` +
        `THE DISCOUNT APPLIES TO THE WHOLE QUANTITY, so below ${meta.breakEvenLm} lm buying the full ${CHAPARRAL_BREAK_LM} lm at ${money(meta.rollPerLm)} (${money(meta.fullBreakCost)}) costs LESS than the shorter run — 19 lm is ${money(meta.cliffAt19Lm)} worse than 20 lm. ` +
        `All ${meta.colours} colours in ${r.range} share this price pair. ` +
        `Plus ${money(CHAPARRAL_FUEL.amount)}/lm fuel (${meta.fuelPctOfRoll}% of this range's roll rate) and ${money(CHAPARRAL_BALING.amount)} baling ONCE PER ORDER, both held on the supplier as fee rules, not in this price. ` +
        `Off the ${CHAPARRAL_ROLL_WIDTH_M}m width that is ${money(meta.cutPerM2)}/m2 cut and ${money(meta.rollPerM2)}/m2 on a roll, DERIVED for comparison only — Chaparral price by the lineal metre and quotes should too. Source: ${r.url}`,
      notes:
        `${CHAPARRAL_SOURCE}, list dated ${CHAPARRAL_PRICE_LIST_PRINTED}, the only date in the file. ` +
        `ROLL WIDTH IS ${CHAPARRAL_ROLL_WIDTH_M}m, AND THAT CAME FROM DAMIEN, NOT THIS FILE (${CHAPARRAL_ROLL_WIDTH_SOURCE}) — treat it as owner-confirmed, not printed spec, and note it is narrower than the ${CHAPARRAL_TRADE_STANDARD_WIDTH_M}m much of the trade rolls. ` +
        `All carpet is priced per LINEAL metre, so quote this in lm. The width is what lets it be compared with the m2-priced half of the book: ${money(meta.rollPerM2)}/m2 at the roll rate and ${money(meta.cutPerM2)}/m2 cut, and one full ${CHAPARRAL_BREAK_LM} lm roll covers ${(CHAPARRAL_BREAK_LM * CHAPARRAL_ROLL_WIDTH_M).toFixed(1)} m2. Those per-m2 figures are DERIVED, never quote them as Chaparral's. ` +
        `THE ${CHAPARRAL_BREAK_LM} LM BREAK IS MODELLED: quoting applies ${money(r.rollPerLm)}/lm at or above ${CHAPARRAL_BREAK_LM} lm and ${money(r.cutPerLm)}/lm below it, automatically, never averaged. Watch any job between about ${Math.floor(meta.breakEvenLm)} and ${CHAPARRAL_BREAK_LM} lm — ordering the extra metres is cheaper. ` +
        `SURCHARGES ARE NOT IN THIS PRICE, ON PURPOSE. ${money(CHAPARRAL_FUEL.amount)}/lm fuel is temporary by Chaparral's own wording and ${money(CHAPARRAL_BALING.amount)} baling is a flat once-per-order charge, so both live on the supplier record with dates and a toggle. A 15 lm cut of this colour is ${money(15 * r.cutPerLm)} of goods and ${money(15 * r.cutPerLm + 15 * CHAPARRAL_FUEL.amount)} of material cost before baling and transport. ` +
        `BALING IS PER ORDER, NOT PER ROLL (${CHAPARRAL_BALING_BASIS_SOURCE}) — ${money(CHAPARRAL_BALING.amount)} flat however many rolls ship, so the unpublished roll length no longer affects what an order costs. ` +
        `FREIGHT IS NOT A CHAPARRAL COST HERE: they do not deliver direct to Terra, stock is on-forwarded through Jocks Transport and Terra pays that leg separately. Their published delivery charge is on file unticked and must never be applied. ` +
        `${EXCLUDED_NAMES.toUpperCase()} ARE DELIBERATELY NOT IN THE PRICE BOOK — the source file removed both because they are no longer on Chaparral's website, and it carries no price row for either. If either is still orderable, ask Chaparral for a current sheet. ` +
        (r.range === "Outback"
          ? `OUTBACK'S SOURCE URL IS THE GENERIC RANGE PAGE, not a product page like Apartment 2's and Kingston's — so these are the least directly verifiable rows in the file, and they are the dearest. Re-check them against Chaparral's site before a large order. `
          : "") +
        `Fibre, construction, pile weight, durability or commercial rating, warranty, whether part-rolls are cut to order, lead time, minimum order and any trade or volume rate are all unstated by the supplier.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "chaparral"));
  if (!supplier) throw new Error("Seed suppliers first — no Chaparral Carpets supplier row found.");

  const items = buildChaparral(supplier.id);

  if (items.length !== 22) throw new Error(`expected 22 colours, got ${items.length}`);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  // Guards on the decisions above. Every row is a complete break pair, and the
  // cut rate must be the DEARER of the two — the opposite direction would mean
  // the columns got swapped somewhere and every short quote would be under.
  for (const i of items) {
    if (i.costPrice === null) throw new Error(`no price on ${i.range} ${i.colour}`);
    if (i.rollM2 !== CHAPARRAL_BREAK_LM) throw new Error(`wrong threshold on ${i.range} ${i.colour}`);
    if (i.cutCostPrice === null) throw new Error(`no cut rate on ${i.range} ${i.colour}`);
    if (!(i.cutCostPrice! > i.costPrice!)) {
      throw new Error(`cut rate is not dearer than the roll rate on ${i.range} ${i.colour}`);
    }
    const d = Math.round((i.cutCostPrice! - i.costPrice!) * 100) / 100;
    if (d !== CHAPARRAL_BREAK_DISCOUNT_PER_LM) throw new Error(`break is ${d} on ${i.range} ${i.colour}`);
    // The width is owner-confirmed, not printed, so it is pinned here: a
    // silent drift to 3.66 or 4.0 would quietly misprice every area comparison.
    if (i.widthM !== CHAPARRAL_ROLL_WIDTH_M) throw new Error(`widthM must be ${CHAPARRAL_ROLL_WIDTH_M} — ${i.range} ${i.colour}`);
    // The whole point of note 4: a surcharge must never reach a costPrice.
    const range = RANGE_BY_NAME.get(i.range!)!;
    if (i.costPrice !== range.rollPerLm) throw new Error(`costPrice moved off the roll rate on ${i.range} ${i.colour}`);
  }

  // The excluded ranges must not have crept in through a re-extract.
  for (const ex of CHAPARRAL_EXCLUDED_RANGES) {
    if (items.some((i) => i.range === ex.range)) throw new Error(`${ex.range} must not be seeded`);
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

  console.log(`Chaparral Carpets: ${created} created, ${updated} updated of ${items.length} lines`);
  for (const r of CHAPARRAL_RANGES) {
    console.log(
      `  ${r.range}: ${r.colours} colours, ${money(r.cutPerLm)} cut / ${money(r.rollPerLm)} roll per lm, ` +
        `break-even ${r.breakEvenLm} lm, ` +
        `${money(r.cutPerM2)} / ${money(r.rollPerM2)} per m2 derived off ${CHAPARRAL_ROLL_WIDTH_M}m`,
    );
  }
  console.log(`  not seeded: ${EXCLUDED_NAMES} — removed by the source file, no price rows exist.`);
  console.log(
    `  roll width ${CHAPARRAL_ROLL_WIDTH_M}m on all ${items.length} rows (${CHAPARRAL_ROLL_WIDTH_SOURCE}) — ` +
      `one ${CHAPARRAL_BREAK_LM} lm roll covers ${(CHAPARRAL_BREAK_LM * CHAPARRAL_ROLL_WIDTH_M).toFixed(1)} m2.`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
