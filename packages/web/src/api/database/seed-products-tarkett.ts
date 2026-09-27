/**
 * Tarkett commercial sheet vinyl into the price book — 180 colours across 8
 * ranges, priced per square metre off custom quote 1210062.
 *
 * Six things here are deliberate.
 *
 * 1. STOCK IS PER COLOUR, AND IT IS THE WHOLE REASON THIS SUPPLIER NEEDED
 *    CARE. 110 of the 180 colours sit in Australian stock. The other 70 are
 *    IMPORT ONLY at 8-10 WEEKS from order. The split runs THROUGH the ranges,
 *    not between them: iQ Granit (New) has 21 stocked colours and 29
 *    import-only ones at the identical $33.50/m2, Ruby 70 is 14 against 19.
 *    Nothing in the price, the width or the spec says which is which.
 *
 *    So `inStock` is read per row and lands on three fields per row:
 *        madeToOrder      = true on an import colour, false on a stocked one
 *        leadTimeDays     = 70 on an import colour, null on a stocked one
 *        availabilityNote = the 8-10 week wording, or "Held in Australian stock."
 *
 *    This is the first supplier in the book where availability varies WITHIN
 *    a range, which is why it is on the product row and not in the supplier
 *    notes where nobody reads it at quote time.
 *
 * 2. THE LEAD TIME IS 8-10 WEEKS AND THAT WORDING IS WHAT GETS QUOTED. The
 *    schema stores days, so `leadTimeDays` carries 70 — the CONSERVATIVE end,
 *    10 weeks, so any date arithmetic errs late rather than early. It exists
 *    for sorting and for "will this land before the deadline" maths. It is NOT
 *    what a customer is told: "allow 50 working days" is a different promise
 *    from "8 to 10 weeks", and the second is what Tarkett actually said. The
 *    quotable wording is in `availabilityNote`, verbatim, on every import row.
 *
 * 3. THE 2.1% FUEL SURCHARGE IS NOT IN ANY costPrice. All 180 source rows
 *    carry it and Tarkett call it temporary, so it is a dated
 *    `percent_of_order` rule on the supplier — the first percent-based fee in
 *    the book. Baked into 180 prices it could not be switched off without a
 *    re-import. On iQ Granit (New) it is 70c/m2, taking $33.50 to $34.20
 *    effective. `costPrice` is the quoted rate and nothing else.
 *
 * 4. THE RESILOOP LEVY IS ALREADY IN THESE PRICES. 9c/m2, per the quote's own
 *    wording. There is no Resiloop fee row on the supplier and there must not
 *    be one — adding it would double-charge. Every product note says so,
 *    because a 9c levy is exactly the kind of thing someone adds "to be safe".
 *
 * 5. BALING AND DELIVERY TO THE TERRA SHOP ARE UNPRICED, SO A TARKETT ORDER
 *    COST IS INCOMPLETE. The source carries both rows, leaves both amounts
 *    blank and marks both Active: No. Nothing is invented for either. Every
 *    product row says the cost is short by freight until Tarkett confirm.
 *
 * 6. WALLGARD 2mm GOES ON A WALL. Same quote, same 2m width, same $22.00/m2
 *    as Ruby 70, but it is wall cladding and not floor covering. Its 5 colours
 *    say so in `fitsRange` and in the notes so it is never specified as a
 *    floor. All 5 are in Australian stock.
 *
 * NO PRICE BREAK EXISTS HERE, unlike Polyflor's sheet vinyl and Chaparral's
 * broadloom. Tarkett quote one rate per range. `rollM2` carries the real roll
 * size (40 / 46 / 50 m2, 2m x the printed length) for ordering, and
 * `cutCostPrice` stays null, so the cut/roll resolver correctly finds no
 * decision to make rather than inventing a cut premium.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-tarkett.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  TARKETT_CODELESS_COLOURS,
  TARKETT_FUEL_PCT,
  TARKETT_IMPORT_COLOURS,
  TARKETT_IMPORT_LEAD_PRINTED,
  TARKETT_IMPORT_LEAD_WEEKS_MAX,
  TARKETT_IMPORT_LEAD_WEEKS_MIN,
  TARKETT_IMPORT_NOTE,
  TARKETT_IN_STOCK_COLOURS,
  TARKETT_MIXED_STOCK_RANGES,
  TARKETT_PRICE_LIST_PRINTED,
  TARKETT_PRICE_LIST_SOURCE,
  TARKETT_RANGES,
  TARKETT_RESILOOP,
  TARKETT_ROLL_WIDTH_M,
  TARKETT_SHEET_VINYL,
  TARKETT_SOURCE,
  TARKETT_STOCK_INDICATOR,
  TARKETT_STOCK_NOTE,
  TARKETT_STOCK_VERIFICATION,
  TARKETT_UNPRICED_CHARGES,
} from "./tarkett-data";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(TARKETT_RANGES.map((r) => [r.range, r]));

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * 10 weeks in days. The CONSERVATIVE end on purpose — see note 2. Only ever
 * used for date maths, never for wording shown to a customer.
 */
const IMPORT_LEAD_DAYS = TARKETT_IMPORT_LEAD_WEEKS_MAX * 7;

const UNPRICED = TARKETT_UNPRICED_CHARGES.filter((c) => !c.active)
  .map((c) => c.charge)
  .join(" and ");

function buildTarkett(supplierId: number): ProductSeed[] {
  return TARKETT_SHEET_VINYL.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;
    const fuelPerM2 = meta.fuelPerM2;

    return {
      supplierId,
      supplier: "Tarkett",
      brand: "Tarkett",
      range: r.range,
      colour: r.colour,
      // Same home as Polyflor's commercial sheet — `vinyl` covers sheet and
      // plank alike in this book.
      category: "vinyl",
      // Tarkett publish no grade or band on the quote. Left blank rather than
      // banded off the price.
      tier: "",
      // Priced per SQUARE METRE on the quote, same as Polyflor sheet. Not lm,
      // even though it comes off a roll.
      unit: "m2",
      // 2m on all 180 rows, printed on every one of them.
      widthM: TARKETT_ROLL_WIDTH_M,
      size: `${TARKETT_ROLL_WIDTH_M}m x ${meta.rollLengthM}m roll`,
      // Roll length is printed and real, so the roll area is arithmetic on two
      // printed figures. Thickness, wear layer and weight are NOT published on
      // this quote.
      lengthMm: null,
      widthMm: null,
      thicknessMm: null,
      wearLayerMm: null,
      weight: "",
      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      // The quoted rate, ex GST, WITHOUT the 2.1% fuel surcharge — that is a
      // supplier fee rule. Resiloop's 9c IS already inside this figure.
      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),

      // NO CUT/ROLL BREAK EXISTS. Tarkett quote one rate per range, so there
      // is no cut premium to record. `rollM2` is the real roll size for
      // ordering, not a price threshold.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: r.fullRollM2,
      bulkKind: "roll",

      priceOnApplication: false,
      // Not published anywhere on the quote.
      minOrderQty: null,
      priceValidUntil: "",
      // Wallgard is the only range that is not a floor, so the one place a
      // specifier looks for fit gets told.
      fitsRange: meta.isWall ? "WALL CLADDING, not a floor covering" : "",

      // ------------------------------------------------ the availability trio
      // An import colour is made-to-order in every practical sense: it is not
      // on a shelf anywhere in the country and it comes on a boat.
      madeToOrder: !r.inStock,
      // 70 = the 10-week end. Null on a stocked colour rather than 0, because
      // Tarkett state no lead time at all for local stock.
      leadTimeDays: r.inStock ? null : IMPORT_LEAD_DAYS,
      // THE QUOTABLE WORDING. Both cases carry a note, the stocked one
      // included, so a blank note always means "nobody checked" and never
      // "it is fine".
      availabilityNote: r.inStock ? TARKETT_STOCK_NOTE : TARKETT_IMPORT_NOTE,

      // Blank on 45 of the 180 colours because Tarkett publish no code for
      // them, not because it is missing. Never fill it with a placeholder.
      sku: r.code,
      variantKey: r.variantKey,
      sourceNote:
        `${money(r.pricePerM2)}/m2 ex GST from ${TARKETT_PRICE_LIST_SOURCE} dated ${TARKETT_PRICE_LIST_PRINTED}. All ${meta.colours} colours in ${r.range} share this rate. ` +
        (r.inStock
          ? `IN AUSTRALIAN STOCK. `
          : `IMPORT ONLY — ALLOW ${TARKETT_IMPORT_LEAD_PRINTED.toUpperCase()} FROM ORDER. Not held in Australia. `) +
        `${meta.inStockColours} of this range's ${meta.colours} colours are stocked and ${meta.importColours} are ${TARKETT_IMPORT_LEAD_PRINTED} imports, at the SAME price — availability here is per colour, not per range. ` +
        `Plus ${TARKETT_FUEL_PCT}% fuel surcharge (${money(fuelPerM2)}/m2 on this range, ${money(meta.effectivePerM2)}/m2 effective), held on the supplier as a dated fee rule and NOT in this price. ` +
        `The Resiloop levy of 9c/m2 IS already included in the quoted rate — do not add it. ` +
        `${TARKETT_ROLL_WIDTH_M}m x ${meta.rollLengthM}m roll = ${r.fullRollM2} m2, ${money(meta.costPerRoll)} a full roll ex GST and ex fuel. ` +
        (r.code ? `Tarkett colour code ${r.code}. ` : `Tarkett publish NO colour code for this one — quote it by range and colour name. `) +
        `Source: ${r.url}`,
      notes:
        `${TARKETT_SOURCE}, ${TARKETT_PRICE_LIST_SOURCE} dated ${TARKETT_PRICE_LIST_PRINTED} — the only date in the file, so these rates are 15 months old as at Sep 2026 and worth refreshing. ` +
        (r.inStock
          ? `AVAILABILITY: held in Australian stock, per the blue Australian-stock badge on Tarkett's AU site. Normal lead time, nothing to warn the customer about. `
          : `AVAILABILITY IS THE THING TO TELL THE CUSTOMER: this colour is NOT held in Australia and Tarkett quote ${TARKETT_IMPORT_LEAD_PRINTED} (${TARKETT_IMPORT_LEAD_WEEKS_MIN} to ${TARKETT_IMPORT_LEAD_WEEKS_MAX} weeks) from order. Say it as weeks, the way Tarkett said it — the ${IMPORT_LEAD_DAYS}-day figure on this record is the 10-week end kept for date arithmetic only and is not a promise anyone made. A stocked colour in the same range at the same ${money(r.pricePerM2)}/m2 is the obvious alternative on a job with a date on it. `) +
        `STOCK STATUS IS THE SOFTEST-SOURCED FACT ON THIS PRODUCT and it is the one that moves a delivery date: ${TARKETT_STOCK_VERIFICATION} (${TARKETT_STOCK_INDICATOR}). It came off the website, not off the pricing quote, so re-confirm it with Tarkett before committing to a job date. ` +
        `${TARKETT_FUEL_PCT}% FUEL SURCHARGE IS NOT IN THIS PRICE, ON PURPOSE. Tarkett's own word for it is temporary, so it lives on the supplier record with a date and a toggle instead of inside 180 costPrice values. 50 m2 of this colour is ${money(50 * r.pricePerM2)} of goods and ${money(Math.round(50 * r.pricePerM2 * (1 + TARKETT_FUEL_PCT / 100) * 100) / 100)} of material cost once it lands. ` +
        `THE RESILOOP LEVY IS ALREADY INSIDE THE QUOTED RATE — 9c/m2. ${TARKETT_RESILOOP.notes} There is deliberately no Resiloop fee row on the supplier; adding one would charge it twice. ` +
        `${UNPRICED.toUpperCase()} ARE UNPRICED, so a Tarkett order cost is SHORT BY FREIGHT until someone asks. The source carries both rows, leaves both blank and marks them inactive, and nothing has been invented for either. This is the top open question on this supplier. ` +
        (meta.isWall
          ? `WALLGARD 2mm IS WALL CLADDING, NOT FLOORING. Same quote, same ${TARKETT_ROLL_WIDTH_M}m width and same ${money(r.pricePerM2)}/m2 as Ruby 70, but it goes up a wall — never specify it as a floor covering. `
          : "") +
        `NO CUT/ROLL PRICE BREAK EXISTS: Tarkett quote the one rate whatever the quantity, unlike Polyflor sheet and Chaparral broadloom. The ${r.fullRollM2} m2 roll size here is for ordering, not a price threshold, and whether part-rolls are cut to order at all is unstated. ` +
        `Thickness, wear layer, slip rating${r.range.includes("R12") ? " beyond what the R12 in the name implies" : ""}, acoustic rating, warranty and minimum order are all unstated by the supplier.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "tarkett"));
  if (!supplier) throw new Error("Seed suppliers first — no Tarkett supplier row found.");

  const items = buildTarkett(supplier.id);

  if (items.length !== 180) throw new Error(`expected 180 colours, got ${items.length}`);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  // Guards on the decisions above.
  let stocked = 0;
  let imported = 0;
  let codeless = 0;
  for (const i of items) {
    if (i.costPrice === null) throw new Error(`no price on ${i.range} ${i.colour}`);
    // Note 3: a surcharge must never reach a costPrice.
    const range = RANGE_BY_NAME.get(i.range!)!;
    if (i.costPrice !== range.pricePerM2) {
      throw new Error(`costPrice moved off the quoted rate on ${i.range} ${i.colour}`);
    }
    // Note 5: no price break, so no cut rate may ever appear here.
    if (i.cutCostPrice !== null || i.cutUpliftPct !== null) {
      throw new Error(`Tarkett has no cut/roll break — ${i.range} ${i.colour}`);
    }
    if (i.widthM !== TARKETT_ROLL_WIDTH_M) throw new Error(`widthM must be ${TARKETT_ROLL_WIDTH_M} — ${i.range} ${i.colour}`);
    if (!i.rollM2 || i.rollM2 !== TARKETT_ROLL_WIDTH_M * range.rollLengthM) {
      throw new Error(`rollM2 is not the printed roll area on ${i.range} ${i.colour}`);
    }
    // The availability trio has to stay internally consistent. A row that is
    // made-to-order with no lead time, or stocked with an import note, is the
    // exact failure this supplier was seeded carefully to avoid.
    if (!i.availabilityNote) throw new Error(`no availability note on ${i.range} ${i.colour}`);
    if (i.madeToOrder) {
      imported += 1;
      if (i.leadTimeDays !== IMPORT_LEAD_DAYS) throw new Error(`import row without the ${IMPORT_LEAD_DAYS}-day lead time: ${i.range} ${i.colour}`);
      if (i.availabilityNote !== TARKETT_IMPORT_NOTE) throw new Error(`import row without the import note: ${i.range} ${i.colour}`);
    } else {
      stocked += 1;
      if (i.leadTimeDays !== null) throw new Error(`stocked row carrying a lead time: ${i.range} ${i.colour}`);
      if (i.availabilityNote !== TARKETT_STOCK_NOTE) throw new Error(`stocked row without the stock note: ${i.range} ${i.colour}`);
    }
    // Note 6: the one range that is not a floor must say so.
    if (range.isWall && !i.fitsRange) throw new Error(`Wallgard row not flagged as wall: ${i.range} ${i.colour}`);
    if (!range.isWall && i.fitsRange) throw new Error(`non-wall row flagged as wall: ${i.range} ${i.colour}`);
    // A blank sku is correct on 45 rows. The string "None" never is.
    if (!i.sku) codeless += 1;
    if (i.sku && i.sku.toLowerCase() === "none") throw new Error(`placeholder sku on ${i.range} ${i.colour}`);
  }

  if (stocked !== TARKETT_IN_STOCK_COLOURS) throw new Error(`${stocked} stocked rows, expected ${TARKETT_IN_STOCK_COLOURS}`);
  if (imported !== TARKETT_IMPORT_COLOURS) throw new Error(`${imported} import rows, expected ${TARKETT_IMPORT_COLOURS}`);
  if (codeless !== TARKETT_CODELESS_COLOURS) throw new Error(`${codeless} codeless rows, expected ${TARKETT_CODELESS_COLOURS}`);

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

  console.log(`Tarkett: ${created} created, ${updated} updated of ${items.length} lines`);
  for (const r of TARKETT_RANGES) {
    console.log(
      `  ${r.range}: ${r.colours} colours at ${money(r.pricePerM2)}/m2 ` +
        `(${money(r.effectivePerM2)} with fuel), ${TARKETT_ROLL_WIDTH_M}x${r.rollLengthM}m = ${r.fullRollM2} m2 roll at ${money(r.costPerRoll)}, ` +
        `${r.inStockColours} stocked / ${r.importColours} import${r.isWall ? " — WALL CLADDING" : ""}`,
    );
  }
  console.log(
    `  ${stocked} colours in Australian stock, ${imported} IMPORT ONLY at ${TARKETT_IMPORT_LEAD_PRINTED} ` +
      `(${IMPORT_LEAD_DAYS} days stored as the conservative end, for date maths only).`,
  );
  console.log(`  availability varies WITHIN these ranges: ${TARKETT_MIXED_STOCK_RANGES.join(", ")} — same price, different wait.`);
  console.log(`  ${codeless} colours have no supplier code, seeded with a blank sku.`);
  console.log(`  ${TARKETT_FUEL_PCT}% fuel surcharge is on the supplier, not in these prices. Resiloop 9c/m2 already is in them — never add it.`);
  console.log(`  ${UNPRICED} are unpriced, so a Tarkett order cost is short by freight until Tarkett confirm.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
