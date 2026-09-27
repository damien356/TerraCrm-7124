/**
 * Hurford's SOLID timber flooring into the price book — 552 rows across 8
 * ranges. 495 boards priced per LINEAL METRE and 57 parquetry rows priced per
 * m2, all ex GST.
 *
 * This is Hurford's THIRD list. The 8 plywood rows (seed-products-hurfords.ts)
 * and the 170 engineered flooring, accessory and underlay rows
 * (seed-products-hurfords-timber.ts) stay exactly as they are. Solid shares the
 * `timber` category with engineered, so the two are told apart by `tier`:
 * "Solid Timber" here against "Engineered Timber*" there, and every variant key
 * on this list is prefixed `hurfords|solid|`. A guard below refuses to write if
 * a key or a code ever collides with either of the other two lists.
 *
 * Seven things this list does that the seed has to respect:
 *
 * 1. SOLID SELLS BY THE LINEAL METRE, ENGINEERED SELLS BY THE m2. Both columns
 *    are printed on the board rows and they agree, so the $/m2 is a cross-check
 *    and NOT a second rate. `unit` is "lm" on a board, with the board width in
 *    `widthM` so the app can still show an m2 figure. The two parquetry ranges
 *    genuinely price per m2, because a parquetry block has no lineal run.
 *
 * 2. THE GRADE IS THE PRICE LEVER, AND IT IS PUNCHED OUT OF THE PRODUCT CODE.
 *    The same board in Select and in Rustic can be nearly half the price, and
 *    529 of 552 codes print "##" (or a single "#" on 9 mistyped rows) where the
 *    two-letter grade code belongs. `sku` is the RESOLVED, orderable code; the
 *    printed template is kept in the notes so an invoice matches either way.
 *    Every row carries the full grade spread for its board, so nobody quotes a
 *    grade they did not price.
 *
 * 3. ONE RATE FOR EVERY QUANTITY. No broken-pack rate, no volume break and no
 *    cut rate is printed anywhere on this list, so `cutCostPrice`,
 *    `cutUpliftPct` and `volumeCostPrice` all stay null. Going short of a pack
 *    costs the $80 job lot FEE, it does not move the rate.
 *
 * 4. THIS IS THE ONE HURFORD'S LIST WITH REAL FREIGHT ON IT. The other two
 *    print none, and the supplier note used to say so flatly. Delivery INTO OUR
 *    WAREHOUSE IS STILL FREE — we unload with our own forklift — but straight
 *    to site is a flat $320 ex GST with the crane truck, and our own rule is we
 *    only send to site over 10 m2. All of it is fee rules on the supplier, none
 *    of it is in a rate.
 *
 * 5. THE $80 JOB LOT FEE STACKS ON A FREE DELIVERY. Damien: still charged, $80
 *    on top, even when delivery costs nothing. It is handling, not freight.
 *
 * 6. 109 ROWS HAVE NO PACK SIZE AND THAT IS THE PRODUCT, NOT A GAP. Overlay T&G
 *    83 x 12 and Overlay T&G FOURTEEN+ 85 x 14 are natural random-length timber
 *    from 1 m to 6 m, per Damien, so there is no pack quantity to publish.
 *    `rollM2` stays null on them rather than being guessed at 400 LM.
 *
 * 7. NOTHING IS INVENTED WHERE THE LIST IS SILENT. One row prints no price at
 *    all (Cypress Pine 62 x 20) and it is seeded price-on-application rather
 *    than filled in from its neighbour. No janka, moisture content, coating,
 *    warranty or lead time is printed, so none is recorded.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: the list publishes standing rates.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-hurfords-solid.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  HURFORDS_SOLID_AUDIT,
  HURFORDS_SOLID_CRANE_SUNSHINE_EX_GST,
  HURFORDS_SOLID_EFFECTIVE_DATE,
  HURFORDS_SOLID_FREIGHT_EXTRA_PACK_EX_GST,
  HURFORDS_SOLID_FREIGHT_FIRST_PACK_EX_GST,
  HURFORDS_SOLID_GRADES,
  HURFORDS_SOLID_JOB_LOT_FEE_EX_GST,
  HURFORDS_SOLID_PARQUETRY_BROKEN_PACK_FEE_EX_GST,
  HURFORDS_SOLID_PARQUETRY_FREIGHT_FEE_EX_GST,
  HURFORDS_SOLID_PARQUETRY_FREIGHT_SURCHARGE_EX_GST,
  HURFORDS_SOLID_RANDOM_LENGTH_MAX_M,
  HURFORDS_SOLID_RANDOM_LENGTH_MIN_M,
  HURFORDS_SOLID_ROWS,
  HURFORDS_SOLID_SITE_FREIGHT_FLAT_EX_GST,
  HURFORDS_SOLID_SOURCE,
  HURFORDS_SOLID_TERRA_PICKUP_M2_THRESHOLD,
  HURFORDS_SOLID_WAREHOUSE_FREIGHT_EX_GST,
  type HurfordsSolidRow,
} from "./hurfords-solid-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const money = (n: number) => `$${n.toFixed(2)}`;
const TIER = "Solid Timber";

/**
 * What the rate excludes, part one: getting it here. This is the only Hurford's
 * list that prints freight at all, so the note has to be explicit that the free
 * warehouse delivery is OUR arrangement and not what the sheet says.
 */
const FREIGHT_NOTE =
  `DELIVERY INTO OUR WAREHOUSE IS FREE AND IS THE DEFAULT ON THIS LIST — ` +
  `${money(HURFORDS_SOLID_WAREHOUSE_FREIGHT_EX_GST)} freight, no minimum, because we unload with our own ` +
  `forklift and need no crane truck or tailgate. STRAIGHT TO SITE IS A FLAT ` +
  `${money(HURFORDS_SOLID_SITE_FREIGHT_FLAT_EX_GST)} ex GST with the crane truck, whatever the load, and our ` +
  `own rule is that we only send to site over ${HURFORDS_SOLID_TERRA_PICKUP_M2_THRESHOLD} m2. Under that we ` +
  `take delivery here and run the timber out ourselves rather than pay for a crane truck. Site delivery is a ` +
  `tickbox on the order, never automatic. The sheet's printed yard freight of ` +
  `${money(HURFORDS_SOLID_FREIGHT_FIRST_PACK_EX_GST)} the first pack then ` +
  `${money(HURFORDS_SOLID_FREIGHT_EXTRA_PACK_EX_GST)} a pack after it describes a depot delivery we do not ` +
  `buy, and the ${money(HURFORDS_SOLID_CRANE_SUNSHINE_EX_GST)} Sunshine Coast crane rate is not ours. Both ` +
  `are on file for reference and neither is ever applied.`;

/**
 * Part two: the handling. Confirmed by Damien to land EVEN WHEN THE DELIVERY IS
 * FREE, which is the whole point of writing it out — a free delivery reads like
 * a free order otherwise.
 */
const JOB_LOT_NOTE =
  `${money(HURFORDS_SOLID_JOB_LOT_FEE_EX_GST)} ex GST JOB LOT FEE ON AN ORDER SHORT OF FULL PACKS, once on ` +
  `the order and not per line. DAMIEN HAS CONFIRMED IT STILL LANDS WHEN THE DELIVERY ITSELF IS FREE: it is ` +
  `handling, not freight, so a free warehouse delivery does not get you out of it. Added by the charge engine ` +
  `off the supplier's fee rule, never built into this rate.`;

/** Boxed parquetry is charged its own way, and only one of the three printed figures is ours. */
const PARQUETRY_FEE_NOTE =
  `BOXED PARQUETRY IS CHARGED DIFFERENTLY TO THE BOARDS. The sheet prints three figures against it: a ` +
  `${money(HURFORDS_SOLID_PARQUETRY_BROKEN_PACK_FEE_EX_GST)} broken pack fee, a ` +
  `${money(HURFORDS_SOLID_PARQUETRY_FREIGHT_FEE_EX_GST)} freight fee, and a note that the ` +
  `${money(HURFORDS_SOLID_PARQUETRY_FREIGHT_SURCHARGE_EX_GST)} freight surcharge applies as well. INTO OUR ` +
  `WAREHOUSE ONLY THE ${money(HURFORDS_SOLID_PARQUETRY_BROKEN_PACK_FEE_EX_GST)} BROKEN PACK FEE LANDS, ` +
  `because the other two are freight and freight in is free. Damien: "$150 broken pack, to my warehouse it's ` +
  `free." It replaces the ${money(HURFORDS_SOLID_JOB_LOT_FEE_EX_GST)} job lot fee on a parquetry line rather ` +
  `than adding to it.`;

/** Same surcharge as the plywood and the engineered flooring. Supplier-wide, Damien's words. */
const FUEL_NOTE =
  `A 2.21% FUEL SURCHARGE APPLIES FROM 23 SEP 2026 and it is not in this rate. Damien: "all orders", solid ` +
  `included, with no threshold and no end date. It is 2.21% of the goods ex GST, so it stacks with the job ` +
  `lot fee without compounding on it.`;

const SPECS_NOTE =
  "NOT ON THIS PRICE LIST, so not recorded: janka rating, moisture content, coating or finish, warranty, " +
  "lead time and stock position. The sheet says all stock is subject to availability and prices change " +
  "without notice. Ask Hurford's if a customer needs any of it.";

/** The grade guide sheet, keyed by code, for the per-row grade description. */
const GRADE_BY_CODE = new Map(HURFORDS_SOLID_GRADES.map((g) => [g.code, g]));

/** The hash slot the grade code drops into, re-derived rather than trusted. */
function resolveCode(r: HurfordsSolidRow): string {
  return r.codeHashes === 0 ? r.codeTemplate : r.codeTemplate.replace(/#+/, r.gradeCode);
}

/**
 * The shortest board in the row, in mm, or null where the list prints no range.
 * `lengthMm` is documented as the MINIMUM on a random-length board, and the
 * freight carrier choice reads it, so it is worth filling in wherever the sheet
 * or Damien actually gives a figure and left null where neither does.
 */
function minLengthMm(r: HurfordsSolidRow): number | null {
  const range = /^([\d.]+)m to ([\d.]+)m/.exec(r.lengthNotes);
  if (range) return Math.round(Number(range[1]) * 1000);
  const floor = /([\d.]+)m and longer/.exec(r.lengthNotes);
  if (floor) return Math.round(Number(floor[1]) * 1000);
  // The 109 no-pack rows: 1 m to 6 m, per Damien, not per the sheet.
  if (r.randomLengthNoPack) return Math.round(HURFORDS_SOLID_RANDOM_LENGTH_MIN_M * 1000);
  return null;
}

/** The notes every row on this list carries, whatever its shape. */
function commonNotes(r: HurfordsSolidRow): string[] {
  const parts: string[] = [];
  parts.push(`${HURFORDS_SOLID_SOURCE}, page ${r.sourcePage ?? "?"}, row ${r.sourceRow}`);
  parts.push(`${r.printedCategory}, ${r.range}, ${r.profile}`);
  parts.push(`Grade ${r.grade}`);

  const g = GRADE_BY_CODE.get(r.gradeCode);
  if (g) parts.push(`Hurford's grade guide on ${g.grade}: ${g.description}`);

  /* The code. The grade is punched out of it, so the printed one is not orderable. */
  if (r.codeHashes === 0) {
    parts.push(`Hurford's code ${r.code}, printed complete because this board comes in the one grade only.`);
  } else {
    parts.push(
      `Hurford's code ${r.code}. THE LIST PRINTS IT AS "${r.codeTemplate}", with ` +
        `${r.codeHashes === 1 ? 'a single "#"' : '"##"'} where the two-letter grade code belongs. ` +
        `${r.gradeCode} is this row's grade, so ${r.code} is what goes on an order` +
        `${r.codeHashes === 1 ? ', and the single hash is a typo in the same slot the rest of the list prints as "##"' : ""}.`,
    );
  }

  /* The grade spread. The biggest lever on this list and invisible on a single row. */
  if (r.gradeCountOnThisBoard > 1) {
    parts.push(
      `GRADE IS THE PRICE ON THIS BOARD, AND IT COMES IN ${r.gradeCountOnThisBoard}: ${r.gradesOnThisBoard}. ` +
        `This row is ${r.gradeCode}. Same species, same size, same profile — quote without naming the grade ` +
        `and the rate is a guess.`,
    );
  } else {
    parts.push(`Only grade published at this size: ${r.gradesOnThisBoard}.`);
  }

  if (r.speciesMisspeltInSource) {
    parts.push(
      `THE SHEET MISSPELLS THE SPECIES as "${r.speciesPrinted}". The price book carries the corrected ` +
        `"${r.species}" and the source spelling is kept here so an invoice matches either way. There is no ` +
        `correctly-spelled rival at this size, so it is the same product with a typo, not a second product.`,
    );
  }

  return parts;
}

/** 495 board rows: random-length hardwood, priced per lineal metre, packed in LM. */
function buildBoards(supplierId: number): ProductSeed[] {
  return HURFORDS_SOLID_ROWS.filter((r) => r.form === "board").map((r) => {
    const code = resolveCode(r);
    if (code !== r.code) throw new Error(`${r.code}: code does not rebuild from template ${r.codeTemplate}`);

    const widthM = Math.round((r.widthMm / 1000) * 1e6) / 1e6;
    const parts = commonNotes(r);

    if (r.priceOnApplication) {
      if (r.pricePerLm !== null || r.pricePerM2 !== null) {
        throw new Error(`${r.code}: flagged price-on-application but carries a rate`);
      }
      parts.push(
        `NO PRICE IS PRINTED ON THIS ROW. The sheet leaves the $/LM, the $/m2 and the pack price all blank ` +
          `where the other five Cypress Pine sizes print them, so it is seeded price-on-application rather ` +
          `than filled in from the neighbouring size. RING HURFORD'S FOR A RATE, and ask whether this size ` +
          `is still made. The ${r.packLmPrinted} pack size IS printed, so that much is real.`,
      );
    } else {
      /* Re-derive the m2 rate off the width rather than trusting the extractor.
       * If the two printed columns ever disagreed by more than rounding, the
       * width or the rate is wrong and the row must not be quoted. */
      const lm = r.pricePerLm as number;
      const derivedM2 = Math.round((lm / widthM) * 100) / 100;
      if (r.pricePerM2 !== null) {
        const drift = Math.abs(derivedM2 - r.pricePerM2) / r.pricePerM2;
        if (drift > 0.005) {
          throw new Error(
            `${r.code}: ${money(lm)}/LM over ${r.widthMm}mm derives ${money(derivedM2)}/m2, ` +
              `${(drift * 100).toFixed(2)}% off the printed ${money(r.pricePerM2)}/m2`,
          );
        }
      }
      parts.push(
        `${money(lm)} ex GST PER LINEAL METRE AT ANY QUANTITY, and the lineal metre is how Hurford's sell ` +
          `solid timber and how the pack size is quoted. No broken-pack rate, no loose rate and no volume ` +
          `break is printed, so one pack and ten quote the same rate. ` +
          (r.pricePerM2 !== null
            ? `The sheet also prints ${money(r.pricePerM2)}/m2, which is the same money over the ${r.widthMm}mm ` +
              `cover width (${money(lm)} / ${widthM} = ${money(derivedM2)}/m2) and is a CROSS-CHECK, not a ` +
              `second rate. Quote in LM; the m2 figure is for comparing against an engineered or hybrid floor.`
            : `No $/m2 is printed on this row, so the m2 figure the app shows is derived off the ${r.widthMm}mm ` +
              `cover width.`),
      );
    }

    /* Pack maths. The pack is quoted in lineal metres, not pieces, because the
     * boards are random length — there is no piece count to publish. */
    if (r.randomLengthNoPack) {
      parts.push(
        `NO PACK SIZE, AND THAT IS THE PRODUCT RATHER THAN A GAP. Damien: this is natural timber supplied in ` +
          `RANDOM LENGTHS FROM ${HURFORDS_SOLID_RANDOM_LENGTH_MIN_M} m TO ${HURFORDS_SOLID_RANDOM_LENGTH_MAX_M} m, ` +
          `so there is no fixed pack quantity for Hurford's to print. Every other board size in this range ` +
          `prints one; this size does not, deliberately. It is quoted by the lineal metre and a quote on it ` +
          `CANNOT state a pack count. Because Hurford's yard freight is priced per pack, a yard or depot ` +
          `delivery of this has to be quoted by Hurford's directly — which is moot for us, since delivery ` +
          `into our warehouse is free.`,
      );
    } else {
      const packLm = r.packLm as number;
      const packM2 = Math.round(packLm * widthM * 100) / 100;
      parts.push(
        `APPROX PACK SIZE ${packLm} LINEAL METRES${r.packLmPrinted && /L\/M/.test(r.packLmPrinted) ? ' (printed "' + r.packLmPrinted + '")' : ""}, ` +
          `which is about ${packM2} m2 of floor at the ${r.widthMm}mm cover width. The sheet calls it ` +
          `approximate because the boards are random length, so treat it as the buying unit and not as an ` +
          `exact quantity. Going short of it costs the ${money(HURFORDS_SOLID_JOB_LOT_FEE_EX_GST)} job lot ` +
          `fee, it does not change the rate.`,
      );
    }

    /* Length. Random on every board, so what is recorded is the minimum. */
    const minMm = minLengthMm(r);
    if (/^[\d.]+m to [\d.]+m/.test(r.lengthNotes)) {
      parts.push(
        `LENGTHS: ${r.lengthNotes}. The shortest board is what is recorded as the length, because a random ` +
          `parcel contains the lot and the carrier prices off the longest — check the longest length before ` +
          `booking freight.`,
      );
    } else if (r.randomLengthNoPack) {
      parts.push(
        `LENGTHS: random, ${HURFORDS_SOLID_RANDOM_LENGTH_MIN_M} m to ${HURFORDS_SOLID_RANDOM_LENGTH_MAX_M} m ` +
          `per Damien, not off the sheet. The ${HURFORDS_SOLID_RANDOM_LENGTH_MIN_M * 1000}mm minimum is what ` +
          `is recorded; boards up to ${HURFORDS_SOLID_RANDOM_LENGTH_MAX_M} m are in the parcel, so freight ` +
          `off the minimum would be wrong.`,
      );
    } else if (minMm !== null) {
      parts.push(
        `LENGTHS: ${r.lengthNotes}. The ${minMm}mm floor is recorded as the length; the parcel runs longer ` +
          `than that, so check the longest board before booking freight.`,
      );
    } else {
      parts.push(
        `LENGTHS: random, and the sheet prints no range for this size, so NO LENGTH IS RECORDED. Solid ` +
          `boards run long, so confirm the longest length with Hurford's before choosing a carrier.`,
      );
    }

    parts.push(FREIGHT_NOTE);
    parts.push(JOB_LOT_NOTE);
    parts.push(FUEL_NOTE);
    parts.push(SPECS_NOTE);

    return {
      supplierId,
      supplier: "Hurford's",
      brand: "Hurford's",
      range: r.range,
      colour: r.species,
      category: r.category,
      // What tells this list apart from the engineered one on the same
      // supplier and the same category.
      tier: TIER,
      // Solid sells by the lineal metre. This is the whole difference from
      // Hurford's engineered list and it is not a presentation choice.
      unit: "lm",

      backing: "",
      size: r.sizePrinted,
      // Cover width in metres, so the app can turn lineal metres into m2.
      widthM,
      // Random length: the MINIMUM where one is published, null where none is.
      lengthMm: minLengthMm(r),
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      // Solid timber is solid through. There is no wear layer to record.
      wearLayerMm: null,
      weight: "",

      // A random-length pack has no piece count, so there is no per-piece m2
      // and the sheet prints no m2 a pack either. The pack is in `rollM2`.
      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      costPrice: r.priceOnApplication ? null : r.pricePerLm,
      sellPrice: r.priceOnApplication ? null : sell(r.pricePerLm as number),
      // ONE RATE ONLY. Short of a pack costs the $80 fee, not a dearer rate.
      cutCostPrice: null,
      cutUpliftPct: null,
      // The full buying unit, in `unit`: lineal metres in a pack. Null on the
      // 109 random-length rows that have no pack. With no cut rate beside it
      // this records the pack without implying a quantity break.
      rollM2: r.packLm,
      bulkKind: "pack",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: r.priceOnApplication,
      // The sheet states no minimum. The pack is in `rollM2`.
      minOrderQty: null,

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      variantKey: r.variantKey,
      sourceNote: `${HURFORDS_SOLID_SOURCE} (page ${r.sourcePage ?? "?"}, row ${r.sourceRow})`,
      notes: parts.filter(Boolean).join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

/** 57 parquetry rows: XL boards and hardwood blocks, priced per m2, sold by the box. */
function buildParquetry(supplierId: number): ProductSeed[] {
  return HURFORDS_SOLID_ROWS.filter((r) => r.form === "parquetry").map((r) => {
    const code = resolveCode(r);
    if (code !== r.code) throw new Error(`${r.code}: code does not rebuild from template ${r.codeTemplate}`);
    if (r.pricePerM2 === null) throw new Error(`${r.code}: a parquetry row with no $/m2`);
    if (r.lengthMm === null) throw new Error(`${r.code}: a parquetry row with no length`);
    if (r.piecesPerBox === null) throw new Error(`${r.code}: a parquetry row with no piece count`);

    /* Re-derive the piece and the box off the printed dimensions rather than
     * trusting the extractor, the same way the engineered seed does. */
    const pieceExact = (r.widthMm * r.lengthMm) / 1e6;
    const pieceM2 = Math.round(pieceExact * 1e8) / 1e8;
    if (r.pieceM2 === null || Math.abs(pieceM2 - r.pieceM2) > 1e-9) {
      throw new Error(`${r.code}: piece m2 ${pieceM2} does not match ${r.pieceM2}`);
    }
    /* The box comes off the UNROUNDED piece. Rounding the piece first loses
     * 0.00024 m2 a box on the 128mm XL rows, which then reads as a mismatch
     * against the sheet's own printed figure. */
    const boxM2 = Math.round(pieceExact * r.piecesPerBox * 1e6) / 1e6;
    if (r.boxM2Derived === null || Math.abs(boxM2 - r.boxM2Derived) > 1e-6) {
      throw new Error(`${r.code}: box m2 ${boxM2} does not match ${r.boxM2Derived}`);
    }
    /* The printed box m2 must be within half a piece of the derived one. A
     * bigger gap means the piece count is wrong, not that the sheet rounded. */
    if (r.boxM2Printed === null || Math.abs(r.boxM2Printed - boxM2) > pieceM2 / 2) {
      throw new Error(`${r.code}: printed box m2 ${r.boxM2Printed} is more than half a piece off ${boxM2}`);
    }
    const boxRounded = Math.abs(r.boxM2Printed - boxM2) > 1e-9;

    const parts = commonNotes(r);

    parts.push(
      `${money(r.pricePerM2)} ex GST PER m2 AT ANY QUANTITY. Parquetry is the one shape on this list that ` +
        `prices per m2 and not per lineal metre, because a block has no lineal run, and no $/LM is printed ` +
        `on any of the 57 parquetry rows. No quantity break of any kind is published.`,
    );

    /* The box. This is the buying unit: the sheet says nearest box quantity. */
    const printedBits =
      `${r.piecesPerBox} ${r.range === "XL Parquetry" ? "boards" : "blocks"} a box at ` +
      `${Math.abs(pieceExact - pieceM2) > 1e-9 ? pieceExact.toFixed(6) : pieceM2} m2 each = ` +
      `${boxM2} m2 a box` +
      (boxRounded
        ? `. THE SHEET PRINTS ${r.boxM2Printed} m2 A BOX, which is rounded — order off the ${boxM2} figure ` +
          `and expect the printed one on the invoice, the difference is ` +
          `${Math.abs(boxM2 - r.boxM2Printed).toFixed(6)} m2 a box.`
        : `, matching the printed ${r.boxM2Printed} m2 exactly.`);
    parts.push(
      `${printedBits} SUPPLIED TO THE NEAREST BOX, so a job is quoted in whole boxes and ${boxM2} m2 is the ` +
        `smallest order. ${money(r.pricePerM2)}/m2 x ${boxM2} m2 = ${money(
          Math.round(r.pricePerM2 * boxM2 * 100) / 100,
        )} a box.`,
    );

    /* Where a box price is printed it has to reconcile, or one of the two is wrong. */
    if (r.boxPricePrinted !== null) {
      const derived = Math.round(r.pricePerM2 * (r.boxM2Printed as number) * 100) / 100;
      const boxPriceGap = Math.abs(derived - r.boxPricePrinted);
      /* A cent of slack: Hurford's prints a box m2 that is itself rounded, so their
       * box price and the m2 rate over that rounded m2 land a cent apart on 6 of the
       * 42 rows that print one. Anything past a cent is a real disagreement. */
      if (boxPriceGap > 0.011) {
        throw new Error(
          `${r.code}: printed box price ${money(r.boxPricePrinted)} does not reconcile to ` +
            `${money(r.pricePerM2)}/m2 x ${r.boxM2Printed} m2 = ${money(derived)}`,
        );
      }
      parts.push(
        `THE SHEET PRINTS THE BOX PRICE TOO: ${money(r.boxPricePrinted)} ex GST a box, which reconciles to ` +
          `${money(r.pricePerM2)}/m2 over the printed ${r.boxM2Printed} m2 ` +
          (boxPriceGap > 1e-9
            ? `to within a cent, landing on ${money(derived)}. The cent is Hurford's own rounding of the box ` +
              `m2 and nothing to query.`
            : "to the cent.") +
          ` The m2 rate is the seeded one and the box price is the cross-check for an invoice.`,
      );
    } else {
      parts.push("No box price is printed on this row, so the box figure above is derived off the m2 rate.");
    }

    if (r.sizeColumnLengthWrong) {
      parts.push(
        `THE SIZE COLUMN ON THIS ROW IS WRONG ON THE SHEET. It sits under a "${r.sizePrinted}" heading, but ` +
          `the species text says ${r.lengthMm}mm, the product code ends ${String(r.lengthMm).slice(0, 2)} ` +
          `rather than 65, and ${r.piecesPerBox} boards of ${r.lengthMm} x ${r.widthMm} give the printed ` +
          `${r.boxM2Printed} m2 a box where 650mm would give ${(
            Math.round(r.piecesPerBox * ((r.widthMm * 650) / 1e6) * 1e6) / 1e6
          ).toFixed(3)}. The length is taken as ${r.lengthMm}mm on the strength of the code and the box m2 ` +
          `agreeing. WORTH TELLING HURFORD'S the size column is wrong.`,
      );
    }
    if (r.speciesSizeInPrintedName) {
      parts.push(
        `The sheet prints the board size inside the species text on this row ("${r.speciesPrinted}"). It is ` +
          `stripped out of the colour name here and kept in the size field where it belongs.`,
      );
    }

    parts.push(FREIGHT_NOTE);
    parts.push(PARQUETRY_FEE_NOTE);
    parts.push(FUEL_NOTE);
    parts.push(SPECS_NOTE);

    return {
      supplierId,
      supplier: "Hurford's",
      brand: "Hurford's",
      range: r.range,
      colour: r.species,
      category: r.category,
      tier: TIER,
      // Parquetry genuinely prices per m2. The sheet prints no $/LM for it.
      unit: "m2",

      backing: "",
      size: r.sizePrinted,
      // Fixed-length blocks, not roll goods and not random length.
      widthM: null,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      wearLayerMm: null,
      weight: "",

      unitsPerPack: r.piecesPerBox,
      unitM2: pieceM2,
      // The sheet's own figure, for checking an invoice. Rounded on some rows.
      packM2Printed: r.boxM2Printed,
      boxesPerPallet: null,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      cutCostPrice: null,
      cutUpliftPct: null,
      // m2 on one box, the full buying unit. No cut rate beside it, so it
      // records the box without implying a part-box rate.
      rollM2: boxM2,
      bulkKind: "pack",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      // Supplied to the nearest box, so one box is the minimum.
      minOrderQty: boxM2,

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      variantKey: r.variantKey,
      sourceNote: `${HURFORDS_SOLID_SOURCE} (page ${r.sourcePage ?? "?"}, row ${r.sourceRow})`,
      notes: parts.filter(Boolean).join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "hurfords"));
  if (!supplier) throw new Error("Seed suppliers first — no Hurford's supplier row found.");

  const boards = buildBoards(supplier.id);
  const parquetry = buildParquetry(supplier.id);
  const items = [...boards, ...parquetry];

  /* ------------------------------ guards ------------------------------ */
  if (items.length !== HURFORDS_SOLID_ROWS.length) {
    throw new Error(`built ${items.length} of ${HURFORDS_SOLID_ROWS.length} rows — a form went unhandled`);
  }

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);
  const skus = new Set(items.map((i) => i.sku));
  if (skus.size !== items.length) throw new Error(`duplicate product codes: ${items.length - skus.size}`);

  /* Every key on this list is prefixed so it can never be mistaken for one of
   * the other two Hurford's lists. */
  for (const i of items) {
    if (!String(i.variantKey).startsWith("hurfords|solid|")) {
      throw new Error(`${i.sku}: variant key "${i.variantKey}" is not prefixed hurfords|solid|`);
    }
    if (i.tier !== TIER) throw new Error(`${i.sku}: tier is "${i.tier}", not "${TIER}"`);
  }

  /* THE COLLISION GUARD. Solid shares the `timber` category with Hurford's
   * engineered flooring and sits on the same supplier as the plywood, so a
   * clashing key or code would have one list silently overwrite the other.
   * Checked against every existing row on this supplier that is not solid. */
  const onSupplier = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const otherLists = onSupplier.filter((p) => p.tier !== TIER);
  const otherKeys = new Set(otherLists.map((p) => p.variantKey));
  const otherSkus = new Set(otherLists.map((p) => p.sku));
  for (const i of items) {
    if (otherKeys.has(i.variantKey as string)) {
      throw new Error(`${i.variantKey} collides with an existing non-solid Hurford's row`);
    }
    if (i.sku && otherSkus.has(i.sku)) {
      throw new Error(`code ${i.sku} is already used by an existing non-solid Hurford's row`);
    }
  }

  /* Every seeded cost must be a rate Hurford's actually print. If a fee ever
   * got folded into a rate, or a POA row filled in, this catches it. */
  const printed = new Set<number>(
    HURFORDS_SOLID_ROWS.flatMap((r) => [r.pricePerLm, r.pricePerM2].filter((n): n is number => n !== null)),
  );
  for (const i of items) {
    if (i.costPrice === null) continue;
    if (!printed.has(i.costPrice as number)) {
      throw new Error(`${i.sku}: cost ${i.costPrice} is not a printed Hurford's rate`);
    }
  }

  /* One row prints no price. Exactly one, and it is the Cypress Pine 62 x 20. */
  const poa = items.filter((i) => i.priceOnApplication);
  if (poa.length !== 1) throw new Error(`expected 1 price-on-application row, found ${poa.length}`);
  if (poa[0]!.sku !== "FECYPN062020") throw new Error(`unexpected POA row ${poa[0]!.sku}`);
  if (poa[0]!.costPrice !== null || poa[0]!.sellPrice !== null) {
    throw new Error("the POA row carries a price, which defeats the point of the flag");
  }
  for (const i of items) {
    if (!i.priceOnApplication && (i.costPrice === null || i.sellPrice === null)) {
      throw new Error(`${i.sku}: no price and not flagged price-on-application`);
    }
  }

  /* The grade has to be a real grade off Hurford's own guide, and the row's own
   * rate has to appear in the spread it publishes for its board. A row that
   * listed a spread it was not part of would send a quoter to the wrong rate. */
  for (const r of HURFORDS_SOLID_ROWS) {
    if (!GRADE_BY_CODE.has(r.gradeCode)) throw new Error(`${r.code}: grade code ${r.gradeCode} is not on the guide`);
    if (!r.gradesOnThisBoard.includes(r.gradeCode)) {
      throw new Error(`${r.code}: its own grade ${r.gradeCode} is missing from "${r.gradesOnThisBoard}"`);
    }
    const listed = r.gradesOnThisBoard.split(",").length;
    if (listed !== r.gradeCountOnThisBoard) {
      throw new Error(`${r.code}: grade count ${r.gradeCountOnThisBoard} against ${listed} listed`);
    }
    const rate = r.pricePerLm ?? r.pricePerM2;
    if (rate !== null && !r.gradesOnThisBoard.includes(rate.toFixed(2))) {
      throw new Error(`${r.code}: its own rate ${money(rate)} is missing from "${r.gradesOnThisBoard}"`);
    }
  }

  /* Boards price in lm and parquetry in m2, and nothing on this list carries a
   * second rate of any kind. */
  for (const i of items) {
    if (i.unit !== "lm" && i.unit !== "m2") throw new Error(`${i.sku}: unit ${i.unit}`);
    if (i.cutCostPrice !== null || i.cutUpliftPct !== null || i.volumeCostPrice !== null) {
      throw new Error(`${i.sku}: carries a second rate this list does not print`);
    }
  }
  for (const i of boards) {
    if (i.unit !== "lm") throw new Error(`${i.sku}: a board priced per ${i.unit}`);
    if (!i.widthM) throw new Error(`${i.sku}: a board with no cover width, so lm cannot convert to m2`);
  }
  for (const i of parquetry) {
    if (i.unit !== "m2") throw new Error(`${i.sku}: parquetry priced per ${i.unit}`);
    if (!i.minOrderQty) throw new Error(`${i.sku}: parquetry with no box minimum`);
  }

  /* ------------------------------- write ------------------------------- */
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const [found] = await db
      .select({ id: s.products.id })
      .from(s.products)
      .where(eq(s.products.variantKey, item.variantKey as string));
    if (found) {
      await db.update(s.products).set(item).where(eq(s.products.id, found.id));
      updated += 1;
    } else {
      await db.insert(s.products).values(item);
      created += 1;
    }
  }

  /* ------------------------------ report ------------------------------ */
  const ranges = [...new Set(HURFORDS_SOLID_ROWS.map((r) => r.range))];
  const species = new Set(HURFORDS_SOLID_ROWS.map((r) => r.species));
  const lmRates = [...new Set(boards.map((i) => i.costPrice).filter((n): n is number => n != null))];
  const m2Rates = [...new Set(parquetry.map((i) => i.costPrice as number))];
  const noPack = HURFORDS_SOLID_ROWS.filter((r) => r.randomLengthNoPack).length;
  const templated = HURFORDS_SOLID_ROWS.filter((r) => r.codeHashes > 0).length;
  const singleHash = HURFORDS_SOLID_ROWS.filter((r) => r.codeHashes === 1).length;
  const misspelt = HURFORDS_SOLID_ROWS.filter((r) => r.speciesMisspeltInSource).length;
  const wrongSize = HURFORDS_SOLID_ROWS.filter((r) => r.sizeColumnLengthWrong).length;
  const multiGrade = HURFORDS_SOLID_ROWS.filter((r) => r.gradeCountOnThisBoard > 1).length;

  console.log(`Hurford's solid timber: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${boards.length} board rows priced per LINEAL METRE and ${parquetry.length} parquetry rows priced per ` +
      `m2, across ${ranges.length} ranges and ${species.size} species`,
  );
  console.log(
    `  ${lmRates.length} distinct $/LM rates from $${Math.min(...lmRates)} to $${Math.max(...lmRates)}, and ` +
      `${m2Rates.length} distinct $/m2 parquetry rates from $${Math.min(...m2Rates)} to $${Math.max(...m2Rates)}`,
  );
  console.log(
    `  ${multiGrade} rows are one of 2 or 3 grades of the same board — grade is the price lever on this list ` +
      `and every row carries its board's full spread`,
  );
  console.log(
    `  ${templated} codes have the grade punched out of them (${singleHash} with a single "#" typo), all ` +
      `resolved to orderable codes with no collisions`,
  );
  console.log(`  ${noPack} rows have no pack size: random-length timber 1 m to 6 m, left null on purpose`);
  console.log(`  1 row is price-on-application (FECYPN062020, Cypress Pine 62 x 20 prints no rate at all)`);
  console.log(`  ${misspelt} rows carry a corrected species name, ${wrongSize} carry a corrected board length`);
  console.log(
    `  FREIGHT: $0 into our warehouse and that is the default, a flat ` +
      `${money(HURFORDS_SOLID_SITE_FREIGHT_FLAT_EX_GST)} ex GST crane truck to site, and we only send to ` +
      `site over ${HURFORDS_SOLID_TERRA_PICKUP_M2_THRESHOLD} m2. THIS IS THE ONLY HURFORD'S LIST WITH REAL ` +
      `FREIGHT ON IT — the plywood and the engineered lists print none.`,
  );
  console.log(
    `  FEES: ${money(HURFORDS_SOLID_JOB_LOT_FEE_EX_GST)} job lot fee on an order short of full packs, ` +
      `CONFIRMED BY DAMIEN TO STILL LAND ON A FREE DELIVERY; ` +
      `${money(HURFORDS_SOLID_PARQUETRY_BROKEN_PACK_FEE_EX_GST)} broken pack fee instead on boxed parquetry; ` +
      `2.21% fuel surcharge on everything. All three are supplier fee rules, none is in a rate.`,
  );
  console.log(`  effective ${HURFORDS_SOLID_EFFECTIVE_DATE}, the freshest of the three Hurford's lists`);
  console.log(`  rows on this supplier from the other two lists, left untouched: ${otherLists.length}`);
  for (const a of HURFORDS_SOLID_AUDIT) {
    console.log(`  AUDIT (${a.topic}): ${a.note}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
