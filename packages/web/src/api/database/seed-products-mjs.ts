/**
 * MJS Floorcoverings into the price book — 104 lines across 31 ranges off the
 * February 2026 price list. The first supplier in the book with THREE rates on
 * one product line.
 *
 * Eight things here are deliberate.
 *
 * 1. THREE RATES, AND THEY ANSWER TWO DIFFERENT QUESTIONS. Somplan 100 prints
 *    $20.56/m2 cut, $17.50/m2 a roll, and $16.90/m2 once the order passes
 *    300 m2. The cut/roll pair answers "did MJS have to cut this". The third
 *    rate answers "how big is the whole order". Both move the rate on the same
 *    product and a 400 m2 order answers both at once, so the third rate gets
 *    its own columns:
 *        costPrice        the roll rate
 *        cutCostPrice     the cut rate, where one exists
 *        volumeCostPrice  the over-300 rate, where one exists
 *        volumeQty        300, MJS's own threshold
 *    `resolveRollCut` in api/lib/pricing.ts picks between all three.
 *
 * 2. THE 17.5% CUT SURCHARGE IS ALREADY INSIDE cutCostPrice AND THERE IS NO
 *    FEE ROW FOR IT. MJS's Charges & Rules sheet lists it as if it were a
 *    separate charge. It is not. Damien confirmed the printed Cut Price column
 *    IS the roll rate with the 17.5% applied, and the extractor asserts
 *    17.50 x 1.175 = 20.56 on every commercial sheet row rather than trusting
 *    it. A fee rule would charge 17.5% on top of a price that carries it.
 *
 * 3. A RATE EQUAL TO THE ROLL RATE IS NOT A BREAK. The three weld rods print
 *    the SAME figure in all three price columns, and Nomad Plus turf prints
 *    only one. Both cutCostPrice and volumeCostPrice are null on those four,
 *    so the resolver correctly finds no decision to make instead of announcing
 *    a saving of zero dollars. This is decided ARITHMETICALLY at extract time
 *    (is the printed cut figure equal to the roll figure?) and never by range
 *    name, so a future MJS list that splits those rates would pick itself up.
 *
 * 4. CARTON GOODS HAVE THE VOLUME BREAK WITHOUT A CUT RATE. The four Tru Plank
 *    LVP ranges, Matilda XL and both True Dimensions tile ranges print a roll
 *    rate and an over-300 rate and NO cut rate, because a carton is not cut.
 *    That combination is valid and the resolver handles it: no cut tier to
 *    fall to, a volume tier above.
 *
 * 5. BALING IS ON THE SUPPLIER, UNTICKED, AND IS NOT IN ANY costPrice. $20 per
 *    commercial vinyl cut length, $50 per residential sheet half roll, $50 per
 *    Tru Turf cut length. Whether one bites depends on whether the order is a
 *    cut or a whole roll, which the charge engine cannot see, so the office
 *    ticks the right one. Baling is a FLAT handling charge and is separate from
 *    the cut RATE in note 2 — they are not the same thing and both are real.
 *
 * 6. MJS DELIVER DIRECT TO THE SHOP FOR NOTHING, so there is no freight in
 *    these costs and none missing either. This is unlike Tarkett, whose order
 *    cost really is short by unpriced freight. The $85 metro forwarding charge
 *    is for an order forwarded ex another MJS location and sits unticked on the
 *    supplier. Country forwarding is not modelled at all — it needs a product
 *    weight the list does not publish.
 *
 * 7. 18 ROWS HAVE A BLANK COLOUR AND THERE ARE THREE DIFFERENT REASONS FOR IT.
 *    8 rows sit in ranges where MJS's website does not reliably expose a
 *    colour list and the source's own rule is to never invent one. 7 turf rows
 *    are where the source repeats the range name in the colour column, which
 *    is not a colour. The 3 weld rods have no colour cell in the printed list
 *    at all: they are bought by code and matched to the sheet they weld, so a
 *    colour is not a property of the line. Every row says which reason applies
 *    in its notes, so a blank colour is always explained and never looks like
 *    missing data.
 *
 * 8. 4 SAFETRED ROWS IN THE SOURCE ARE NOT SEEDED. Tarkett sell both ranges at
 *    $34.00/m2 flat plus 2.1% fuel while MJS want $35.50 and $44.00 a roll, so
 *    MJS are dearer at every quantity. Two prices for one product is how a
 *    quote picks the dearer one. The count guard below is 104, not 108, and
 *    MJS_EXCLUDED_ROWS carries the four with their reasons.
 *
 * SYNTHETIC TURF GOT ITS OWN CATEGORY because it is not a floor covering and
 * must never turn up in a flooring comparison. NEEDLE PUNCH went into `carpet`
 * because it is roll goods priced per m2 and cut the way broadloom is; every
 * row says "Needle punch" so it is not mistaken for tufted broadloom.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-mjs.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  MJS_BALING,
  MJS_CATEGORY_COUNTS,
  MJS_CUT_SURCHARGE,
  MJS_EXCLUDED_ROWS,
  MJS_FLAT_RATE_RANGES,
  MJS_FORWARDING,
  MJS_NO_COLOUR_RANGES,
  MJS_PRICE_LIST_PRINTED,
  MJS_PRODUCTS,
  MJS_RANGES,
  MJS_SOURCE,
  MJS_THREE_RATE_RANGES,
  MJS_VOLUME_QTY_M2,
  MJS_VOLUME_RANGES,
} from "./mjs-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(MJS_RANGES.map((r) => [r.range, r]));

const money = (n: number) => `$${n.toFixed(2)}`;

const BALING_BY_CATEGORY: Record<string, string> = {
  "Commercial Sheet": "$20 per cut length",
  "Residential Sheet": "$50 per half roll",
  "Synthetic Turf": "$50 per cut length",
};

/** "2m x 23m roll", "184 x 1219mm plank", "25 x 100cm tile". As printed. */
function sizeText(r: (typeof MJS_PRODUCTS)[number]): string {
  if (r.isPack) return `${r.printedWidth} x ${r.printedLength}`;
  if (!r.printedWidth) return r.printedLength ? `${r.printedLength} coil` : "";
  return `${r.printedWidth} x ${r.printedLength} roll`;
}

function buildMjs(supplierId: number): ProductSeed[] {
  return MJS_PRODUCTS.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;
    const baling = BALING_BY_CATEGORY[r.printedCategory] ?? "";
    const isTurf = r.printedCategory === "Synthetic Turf";
    const isNeedlePunch = r.printedCategory === "Needle Punch";

    return {
      supplierId,
      supplier: "MJS Floorcoverings",
      // MJS badge their own goods (Somplan, Tru Plank, Tru Turf) and resell
      // others (Beauflor weld rod, Interface's True Dimensions). The list does
      // not separate them, so the supplier name is the only defensible brand.
      brand: "MJS Floorcoverings",
      range: r.range,
      // Blank on 15 of the 104 rows, and the notes say which of the two
      // reasons applies. Never a placeholder.
      colour: r.colour,
      category: r.category,
      // MJS publish no grade or band anywhere on the list.
      tier: "",
      // m2 on sheet, plank, tile and needle punch. lm on turf and weld rod,
      // which is how MJS price them and not a conversion.
      unit: r.unit,
      backing: "",
      size: sizeText(r),
      // Roll width in metres on roll goods, null on carton goods — a carton of
      // planks has no roll width and 0.184 is not one.
      widthM: r.widthM,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      wearLayerMm: r.wearLayerMm,
      // Not published on any of the 104 lines. It is also what blocks country
      // forwarding, which is priced per kg.
      weight: "",

      // Derived from the printed plank/tile size, never from the printed
      // carton m2 — the extractor reconciles the two and keeps the integer
      // count as the source of truth.
      unitsPerPack: r.unitsPerPack,
      unitM2: r.unitM2,
      packM2Printed: r.packM2Printed,
      // Not stated on the list.
      boxesPerPallet: null,

      // THE ROLL RATE. Ex GST, no fuel surcharge on this supplier at all, and
      // no baling in it — baling is a flat charge on the supplier record.
      costPrice: r.rollPrice,
      sellPrice: sell(r.rollPrice),

      // THE CUT RATE, already carrying MJS's 17.5% on commercial sheet. Null
      // where the printed cut figure equals the roll figure (the three weld
      // rods, Nomad Plus) and null on carton goods, which are not cut.
      cutCostPrice: r.cutPrice,
      // MJS print a dollar cut rate, not a percentage. Never both.
      cutUpliftPct: null,
      // Quantity on one full buying unit in `unit`: m2 on a roll, m2 in a
      // carton. On carton goods with no cut rate this is not a price
      // threshold, it is the ordering increment.
      rollM2: r.bulkQty,
      bulkKind: r.bulkKind,

      // THE THIRD RATE. Null on everything MJS do not publish one for, and
      // null where the printed over-300 figure equals the roll figure.
      volumeCostPrice: r.volumePrice,
      volumeQty: r.volumeQty,

      priceOnApplication: false,
      // Not published.
      minOrderQty: null,
      // The list names no expiry. It is not a quote.
      priceValidUntil: "",
      fitsRange: r.isWall ? "WALL CLADDING, not a floor covering" : "",

      // Nothing on this list says lead time or stock status either way, so
      // all 104 rows are treated as available and none claims a lead time.
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote:
        "MJS publish no stock or lead-time information on the February 2026 list. Treated as available; confirm at order time on anything with a date on it.",

      sku: r.code,
      variantKey: r.variantKey,
      sourceNote:
        `${money(r.rollPrice)}/${r.unit} roll rate ex GST from the MJS ${MJS_PRICE_LIST_PRINTED} price list. ` +
        (r.cutPrice !== null
          ? `Cut rate ${money(r.cutPrice)}/${r.unit}${r.printedCategory === "Commercial Sheet" ? ` — the roll rate plus MJS's ${MJS_CUT_SURCHARGE.pct}%, ALREADY INCLUDED, asserted at extract time` : ""}. `
          : r.isPack
            ? `NO CUT RATE: carton goods, MJS do not cut a carton. `
            : `NO CUT RATE: MJS print the same figure in every price column on this one, so there is no break. `) +
        (r.volumePrice !== null
          ? `Over ${MJS_VOLUME_QTY_M2} ${r.unit} the rate drops to ${money(r.volumePrice)}/${r.unit}, saving ${money(r.rollPrice - r.volumePrice)}/${r.unit} — ${money(meta.volumeSavingAt300 ?? 0)} on a ${MJS_VOLUME_QTY_M2} ${r.unit} order. `
          : `No over-${MJS_VOLUME_QTY_M2} ${r.unit} rate published for this range. `) +
        `${meta.bulkKind === "pack" ? `Carton` : `Roll`} of ${r.bulkQty} ${r.unit} = ${money(meta.costPerBulkUnit)} at the roll rate. ` +
        (r.colour
          ? `Colour from ${r.colourSource}. `
          : r.colourIsRangeName
            ? `COLOUR LEFT BLANK: the source repeats the range name in the colour column, which is not a colour. `
            : r.colourNoneInSource
              ? `NO COLOUR ON THIS LINE AT ALL: the printed list carries no colour cell for it and claims nothing about one. Weld rod is bought by code ${r.code} and matched to the sheet it welds. `
              : `COLOUR LEFT BLANK ON PURPOSE: MJS's website does not reliably expose a colour list for this range and the source's own rule is to never invent one. Quote it by range and code ${r.code}. `) +
        (baling ? `${baling} baling applies to this category and is NOT in this price. ` : `No baling charge on this category. `) +
        `Source: ${r.url || MJS_SOURCE}`,
      notes:
        `${MJS_SOURCE}, MJS ${MJS_PRICE_LIST_PRINTED}. 8 months old as at Sep 2026 and the only date in the file. ` +
        (r.cutPrice !== null && r.volumePrice !== null
          ? `THREE RATES ON THIS PRODUCT AND THE ORDER SIZE PICKS ONE: ${money(r.cutPrice)}/${r.unit} cut, ${money(r.rollPrice)}/${r.unit} for a full ${r.bulkQty} ${r.unit} roll, ${money(r.volumePrice)}/${r.unit} once the order passes ${MJS_VOLUME_QTY_M2} ${r.unit}. Worth checking any quote that lands near either threshold: a whole roll is ${money(meta.costPerBulkUnit)} against ${money(Math.round((r.bulkQty - 1) * r.cutPrice * 100) / 100)} for one metre-squared less at the cut rate. `
          : r.volumePrice !== null
            ? `TWO RATES, AND THE ORDER SIZE PICKS ONE: ${money(r.rollPrice)}/${r.unit} normally, ${money(r.volumePrice)}/${r.unit} once the order passes ${MJS_VOLUME_QTY_M2} ${r.unit} — ${money(meta.volumeSavingAt300 ?? 0)} back on a ${MJS_VOLUME_QTY_M2} ${r.unit} order. There is NO cut rate: ${r.isPack ? "these are carton goods and MJS do not cut a carton" : "MJS publish none"}. `
            : r.cutPrice !== null
              ? `TWO RATES: ${money(r.cutPrice)}/${r.unit} cut and ${money(r.rollPrice)}/${r.unit} for a full ${r.bulkQty} ${r.unit} roll, a ${meta.cutPremiumPct ?? 0}% premium for the cut. MJS publish no over-${MJS_VOLUME_QTY_M2} ${r.unit} rate on this range. `
              : `ONE RATE WHATEVER THE QUANTITY. MJS print ${money(r.rollPrice)}/${r.unit} in every price column on this line, so there is genuinely no break — not a missing cut rate. An identical rate is not a discount and the app will not offer one. `) +
        (r.printedCategory === "Commercial Sheet" && r.cutPrice !== null
          ? `THE ${MJS_CUT_SURCHARGE.pct}% CUT SURCHARGE IS ALREADY INSIDE THE ${money(r.cutPrice)} CUT RATE — ${money(r.rollPrice)} x 1.175 = ${money(r.cutPrice)}, asserted on every commercial sheet row at extract time and confirmed by Damien directly. MJS list it on their charges sheet as though it were separate. IT IS NOT. Never add it again. `
          : "") +
        (baling
          ? `BALING IS SEPARATE AND IS NOT IN THIS PRICE: ${baling} ex GST, held on the supplier as an UNTICKED fee because whether it applies depends on whether the order is a cut or a whole roll. It is a flat handling charge and has nothing to do with the cut rate above. `
          : "") +
        `NO FREIGHT IS MISSING FROM THIS COST. MJS deliver direct to the Terra shop and charge nothing for it, per Damien — unlike Tarkett, whose order cost really is short by unpriced freight. The $85/order metro forwarding charge is for an order forwarded ex another MJS location and sits unticked on the supplier. Country forwarding is not modelled: it is priced per kg and the list publishes no product weight. ` +
        `NO FUEL SURCHARGE ON THIS SUPPLIER AT ALL, unlike Tarkett's 2.1% and Chaparral's $2/lm. The February 2026 list carries no fuel row. ` +
        (r.colour
          ? ""
          : r.colourIsRangeName
            ? `COLOUR IS BLANK BECAUSE THE SOURCE HAS NO REAL ONE: it repeats the range name in the colour column. Turf is specified by range and width, not by colour name, so nothing is actually missing. `
            : r.colourNoneInSource
              ? `COLOUR IS BLANK BECAUSE A WELD ROD DOES NOT HAVE ONE ON THIS LIST: the printed row has no colour cell and MJS make no claim about one. The rod is ordered by code ${r.code} and picked to match the sheet it welds, so there is nothing missing to chase. `
              : `COLOUR IS BLANK BECAUSE MJS PUBLISH NONE THAT CAN BE VERIFIED — the source's words are that the colour list is not reliably exposed by MJS's website, and its rule is to never invent one. This is NOT missing data and must not be filled with a guess. Quote by range and code ${r.code}, and complete it only from a verified MJS page or catalogue. `) +
        (r.isWall
          ? `THIS IS WALL CLADDING, NOT FLOORING. Somwall is the only part of MJS's commercial sheet that goes up a wall, and the two Somwall ranges are the only rows on the whole list whose slip rating reads N/A, which is what a wall product would say. Never specify it as a floor covering. `
          : "") +
        (isTurf
          ? `PRICED PER LINEAL METRE, NOT PER m2, which is how MJS price turf. ${r.printedWidth} wide. Leisure Lawn Plus and Test Wicket are each sold in two widths at two different per-lm rates, so comparing per-lm figures across widths without the width is meaningless. Synthetic turf is in its own category on purpose: it is not a floor covering and should never appear in a flooring comparison. `
          : "") +
        (isNeedlePunch
          ? `NEEDLE PUNCH. Filed under carpet because it is roll goods priced per m2 and cut the way broadloom is, but it is not tufted broadloom — do not offer it as one. ${r.printedWidth} x ${r.printedLength} roll, ${r.thicknessMm}mm. `
          : "") +
        (r.isPack
          ? `CARTON GOODS: ${r.unitsPerPack} pieces of ${r.printedWidth} x ${r.printedLength} to a carton, ${r.packM2Printed} m2 as MJS print it. The piece count is the source of truth for ordering maths — the printed carton m2 is rounded and is kept only for checking an invoice. `
          : "") +
        `STILL UNSTATED BY MJS AND WORTH ASKING: product weight (which is what blocks country forwarding), stock status and lead time of any kind, minimum order, warranty, acoustic rating, and whether the over-${MJS_VOLUME_QTY_M2} ${r.unit} rate is per order or per colour — the list says "over ${MJS_VOLUME_QTY_M2}m2" and nothing more.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "mjs"));
  if (!supplier) throw new Error("Seed suppliers first — no MJS supplier row found.");

  const items = buildMjs(supplier.id);

  if (items.length !== 104) throw new Error(`expected 104 lines, got ${items.length}`);
  if (MJS_EXCLUDED_ROWS.length !== 4) throw new Error(`expected 4 excluded Safetred rows, got ${MJS_EXCLUDED_ROWS.length}`);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  // Guards on the decisions above.
  let threeRate = 0;
  let volume = 0;
  let flat = 0;
  let blankColour = 0;
  let wall = 0;
  for (const i of items) {
    const row = MJS_PRODUCTS.find((r) => r.variantKey === i.variantKey)!;
    const range = RANGE_BY_NAME.get(i.range!)!;

    if (i.costPrice === null) throw new Error(`no roll price on ${i.range} ${i.colour}`);
    if (i.costPrice !== range.rollPrice) throw new Error(`costPrice moved off the printed roll rate on ${i.range} ${i.colour}`);

    // Note 2: the 17.5% must be inside the cut rate and nowhere else.
    if (row.printedCategory === "Commercial Sheet" && i.cutCostPrice !== null) {
      const expected = Math.round(row.rollPrice * (1 + MJS_CUT_SURCHARGE.pct / 100) * 100) / 100;
      if (Math.abs((i.cutCostPrice as number) - expected) > 0.01) {
        throw new Error(`cut rate is not roll x 1.175 on ${i.range} ${i.colour}: ${i.cutCostPrice} vs ${expected}`);
      }
    }
    // MJS print dollars, never a percentage.
    if (i.cutUpliftPct !== null) throw new Error(`MJS publish a dollar cut rate, not an uplift — ${i.range} ${i.colour}`);
    // Note 3: an identical rate is not a break, in either direction.
    if (i.cutCostPrice != null && i.cutCostPrice <= i.costPrice) {
      throw new Error(`cut rate is not dearer than the roll rate on ${i.range} ${i.colour}`);
    }
    if (i.volumeCostPrice != null && i.volumeCostPrice >= i.costPrice) {
      throw new Error(`volume rate is not cheaper than the roll rate on ${i.range} ${i.colour}`);
    }
    // The volume pair has to be all-or-nothing, or the resolver gets a rate
    // with no threshold or a threshold with no rate.
    if ((i.volumeCostPrice === null) !== (i.volumeQty === null)) {
      throw new Error(`volume rate and volume qty must be set together — ${i.range} ${i.colour}`);
    }
    if (i.volumeQty !== null && i.volumeQty !== MJS_VOLUME_QTY_M2) {
      throw new Error(`volume threshold is not ${MJS_VOLUME_QTY_M2} on ${i.range} ${i.colour}`);
    }
    // Note 4: carton goods are never cut.
    if (row.isPack && i.cutCostPrice !== null) throw new Error(`carton goods with a cut rate: ${i.range} ${i.colour}`);
    if (row.isPack && (!i.unitsPerPack || !i.unitM2)) throw new Error(`carton goods without a piece count: ${i.range} ${i.colour}`);
    if (!row.isPack && i.unitsPerPack !== null) throw new Error(`roll goods with a piece count: ${i.range} ${i.colour}`);
    if (!i.rollM2 || i.rollM2 !== range.bulkQty) throw new Error(`rollM2 is not the printed buying unit on ${i.range} ${i.colour}`);
    if (i.bulkKind !== (row.isPack ? "pack" : "roll")) throw new Error(`bulkKind does not match the goods on ${i.range} ${i.colour}`);

    // No supplier on this list has a lead time or a stock flag.
    if (i.madeToOrder || i.leadTimeDays !== null) throw new Error(`MJS publish no lead time — ${i.range} ${i.colour}`);
    if (!i.availabilityNote) throw new Error(`no availability note on ${i.range} ${i.colour}`);

    // Note 7: a blank colour is always explained.
    if (!i.colour) {
      blankColour += 1;
      if (!row.colourNotPublished && !row.colourIsRangeName && !row.colourNoneInSource) {
        throw new Error(`blank colour with no reason recorded: ${i.range} ${i.sku}`);
      }
      // A blank on a floor line has to be one of the two published-colour
      // reasons. Only an accessory may have no colour cell at all.
      if (row.colourNoneInSource && row.category !== "accessory") {
        throw new Error(`blank colour cell on a non-accessory line: ${i.range} ${i.sku}`);
      }
      if (!i.notes!.includes("COLOUR IS BLANK")) throw new Error(`blank colour not explained in notes: ${i.range}`);
    }
    if (i.colour && i.colour.toLowerCase() === i.range!.toLowerCase()) {
      throw new Error(`range name left in the colour field: ${i.range}`);
    }
    if (!i.sku) throw new Error(`MJS publish a code on every line — missing on ${i.range} ${i.colour}`);

    if (row.isWall) {
      wall += 1;
      if (!i.fitsRange) throw new Error(`Somwall row not flagged as wall: ${i.range}`);
    } else if (i.fitsRange) {
      throw new Error(`non-wall row flagged as wall: ${i.range} ${i.colour}`);
    }

    if (i.cutCostPrice !== null && i.volumeCostPrice !== null) threeRate += 1;
    if (i.volumeCostPrice !== null) volume += 1;
    if (i.cutCostPrice === null && i.volumeCostPrice === null) flat += 1;

    // Note 2 again, from the other side: nothing may create a 17.5% fee.
    if (/17\.5% surcharge (applies|to add)/i.test(i.notes!)) {
      throw new Error(`notes imply the 17.5% is chargeable again on ${i.range}`);
    }
  }

  // Counts have to agree with what the extractor found in the source.
  const seededCats = items.reduce<Record<string, number>>((acc, i) => {
    const row = MJS_PRODUCTS.find((r) => r.variantKey === i.variantKey)!;
    acc[row.printedCategory] = (acc[row.printedCategory] ?? 0) + 1;
    return acc;
  }, {});
  for (const [cat, n] of Object.entries(MJS_CATEGORY_COUNTS)) {
    if (seededCats[cat] !== n) throw new Error(`${cat}: seeded ${seededCats[cat] ?? 0}, source says ${n}`);
  }

  const threeRateExpected = MJS_PRODUCTS.filter((r) => MJS_THREE_RATE_RANGES.includes(r.range)).length;
  if (threeRate !== threeRateExpected) throw new Error(`${threeRate} three-rate rows, expected ${threeRateExpected}`);
  const volumeExpected = MJS_PRODUCTS.filter((r) => MJS_VOLUME_RANGES.includes(r.range)).length;
  if (volume !== volumeExpected) throw new Error(`${volume} rows with a volume rate, expected ${volumeExpected}`);
  const flatExpected = MJS_PRODUCTS.filter((r) => MJS_FLAT_RATE_RANGES.includes(r.range)).length;
  if (flat !== flatExpected) throw new Error(`${flat} flat-rate rows, expected ${flatExpected}`);
  if (wall !== 2) throw new Error(`${wall} wall rows, expected 2 Somwall lines`);

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

  console.log(`MJS Floorcoverings: ${created} created, ${updated} updated of ${items.length} lines across ${MJS_RANGES.length} ranges`);
  for (const r of MJS_RANGES) {
    const rates =
      r.cutPrice !== null && r.volumePrice !== null
        ? `${money(r.cutPrice)} cut / ${money(r.rollPrice)} roll / ${money(r.volumePrice)} over ${MJS_VOLUME_QTY_M2}`
        : r.volumePrice !== null
          ? `${money(r.rollPrice)} / ${money(r.volumePrice)} over ${MJS_VOLUME_QTY_M2}`
          : r.cutPrice !== null
            ? `${money(r.cutPrice)} cut / ${money(r.rollPrice)} roll`
            : `${money(r.rollPrice)} flat, no break`;
    console.log(
      `  ${r.range}: ${r.colours} line${r.colours === 1 ? "" : "s"} at ${rates} per ${r.unit}, ` +
        `${r.bulkKind} of ${r.bulkQty} ${r.unit} = ${money(r.costPerBulkUnit)}` +
        `${r.isWall ? " — WALL CLADDING" : ""}${r.colourNotPublished ? " — no published colour" : ""}`,
    );
  }
  console.log(`  ${threeRate} lines carry all three rates, ${volume} carry the over-${MJS_VOLUME_QTY_M2} rate, ${flat} have one rate and no break.`);
  console.log(
    `  ${blankColour} lines seeded with a blank colour, for three different reasons: ${MJS_NO_COLOUR_RANGES.length} ranges MJS publish no verifiable colour list for, 7 turf lines whose colour column repeats the range name, and 3 weld rods with no colour cell in the list at all.`,
  );
  console.log(`  the ${MJS_CUT_SURCHARGE.pct}% cut surcharge is ALREADY in every printed cut rate and has no fee rule. Never add it twice.`);
  console.log(`  baling is on the supplier, unticked: ${MJS_BALING.map((b) => `${money(b.amount!)} ${b.unit.replace("$/", "per ")}`).join(", ")}.`);
  console.log(
    `  MJS deliver direct to the shop for nothing, so no freight is missing here. Metro forwarding ${money(MJS_FORWARDING.metro.amount)}/order is unticked; country forwarding is not modelled.`,
  );
  console.log(`  ${MJS_EXCLUDED_ROWS.length} Safetred lines in the source are NOT seeded — Tarkett are cheaper on every normal order size.`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
