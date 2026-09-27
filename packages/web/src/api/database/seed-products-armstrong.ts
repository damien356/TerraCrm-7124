/**
 * Armstrong into the price book. 355 lines across 31 ranges and 38 printed
 * sizes, off the Armstrong Partner Price List effective 18 May 2026 plus
 * Armstrong's own website, all per m2 ex GST.
 *
 * This is the SECOND import of Armstrong. The first one ran off an earlier
 * workbook that left four things blank, and Armstrong have since supplied a
 * corrected list. Everything below that says "used to be" is describing that
 * first import, not a pending change.
 *
 * 1. FIVE PRICE SHAPES, TAKEN FROM THE LIST'S OWN Price Rule COLUMN. The old
 *    import had three and two of them were guesses at what Armstrong meant.
 *      roll_cut                 177 rows, 14 ranges. The printed rate IS the
 *                               full-roll rate and a part roll costs 15% more
 *                               per m2. Seeded as costPrice plus
 *                               cutUpliftPct 15.
 *      pallet_break              31 rows, 5 ranges. Pallet rate at the printed
 *                               threshold, standard rate below it.
 *      pallet_break_dealer       86 rows, 7 ranges. Same shape, and both rates
 *                               are Armstrong's DEALER rates, which the
 *                               pricing notes confirm are what Terra pay.
 *      pallet_break_per_variant  56 rows, 4 ranges. Same shape again, but the
 *                               threshold is printed per colour and size, not
 *                               once per range.
 *      pallet_info_only           5 rows, 1 range. Excelon VCT. See note 4.
 *
 * 2. EVERY PALLET BREAK IS NOW LIVE. The old list printed a pallet RATE and
 *    never a pallet QUANTITY, so all 39 pallet rows were seeded dormant and
 *    billed at the standard rate. The new list prints a threshold on every
 *    single row, so 173 rows across 16 ranges now carry a real
 *    volumeCostPrice / volumeQty pair and a big order earns the pallet rate by
 *    itself. costPrice stays the STANDARD rate, which is what a normal order
 *    pays, and the pallet rate is the break on top of it.
 *
 * 3. THE THRESHOLD IS USED EXACTLY AS PRINTED, never rounded to a whole pack.
 *    Two variants do not divide cleanly (Aspirations at 64.855 packs and
 *    EarthCuts Standard 610 x 305mm at 150.480 packs) and both carry a loud
 *    note instead of a tidied-up number. Armstrong's printed threshold is what
 *    Armstrong will honour.
 *
 * 4. EXCELON VCT HAS NO BREAK TO SEED AND THAT IS A REAL FINDING. The list
 *    prints $17.28/m2 either side of the 239.76 m2 pallet, so the threshold is
 *    for carton counting and ordering, not a discount. No volume pair is
 *    seeded on those 5 rows, because the resolver only counts a volume rate
 *    that is strictly cheaper and a saving of zero dollars is worse than
 *    saying nothing. The extractor asserts the two rates stay equal, so if
 *    Armstrong ever put a real discount there, extraction fails and this gets
 *    revisited rather than quietly staying flat.
 *
 * 5. CHESTERFIELD'S PALLET RATE IS AN OVERRIDE. The workbook prints $12.75/m2
 *    on both its sheets. Damien confirmed $12.95/m2 with Armstrong, so
 *    $12.95 is seeded and the printed figure is kept beside it in
 *    ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE. The extractor asserts the printed
 *    figure is still $12.75, so a change at Armstrong's end cannot slip past.
 *
 * 6. cutCostPrice IS NULL ON ALL 355 ROWS AND THAT IS CORRECT. Armstrong
 *    publish a PERCENTAGE, not a dollar cut rate. Polyflor and MJS print
 *    dollars and use cutCostPrice; Hurford's prints dollars for its pack/loose
 *    pair and uses cutCostPrice. Armstrong print "+15%", so the percentage is
 *    stored and the resolver does the arithmetic once, at quote time. Storing
 *    both would be two versions of the same rate waiting to disagree.
 *
 * 7. THE 15% IS ARMSTRONG'S OWN FORMULA, NOT A RULE OF THUMB. Every cut cell
 *    in the source workbook literally reads `=D{row}*1.15` against its own
 *    base cell, and the extractor asserts that on all 177 roll rows. The
 *    workbook holds no cached results at all, so the cut rate is computed from
 *    the asserted formula rather than read off a stale cell.
 *
 * 8. FREIGHT IS KNOWN NOW, AND IT IS A FEE, NOT A MARGIN ON THE GOODS.
 *    Armstrong deliver to Terra's warehouse for a flat $150 an order ex GST,
 *    inclusive of all fees, confirmed by Damien. That is seeded as a supplier
 *    fee rule in seed-suppliers.ts and is never folded into a per-m2 rate.
 *    The old import said the freight position was unknown. It is not any more.
 *
 * 9. NO SKUs EXIST ANYWHERE IN THE SOURCE. Not one of the 355 rows carries a
 *    code, so `sku` is blank on all of them. Identity is range plus colour
 *    plus printed size, see below.
 *
 * VARIANT KEY CARRIES THE SIZE, ON PURPOSE AND ON EVERY ROW.
 * EarthCuts print Concrete, Sandstone and Slate at two different tile sizes
 * each, so range plus colour collides on three rows. Rather than special-case
 * those three, the size slug is on all 355 keys, which is the same shape MJS
 * uses. The keys therefore differ from the first import and the rows below
 * insert fresh rather than updating in place.
 *
 * WALLFLEX (13 rows) IS WALL CLADDING, not a floor covering, and is flagged
 * the same way Tarkett's Wallgard and MJS's Somwall are.
 *
 * ONLY ONE AMBIGUITY IS LEFT IN THE SOURCE. Armalon NG Colours prints two roll
 * widths (1.83m x 20m or 1.525m x 24m) without saying which colour comes on
 * which, so widthM is left NULL on those 8 rows with a loud note. Both work out
 * at 36.6 m2 a roll, so the roll threshold is safe either way, but quoting
 * lineal metres off the wrong width would be out by 20%. The other three gaps
 * from the first import are closed: Safeguard's "2mm / 1.50" is a raised grip
 * texture on a 2mm sheet and not two gauges, and the Natural Creations
 * "various sizes" rows now print a size, a pack and a threshold each.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-armstrong.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  ARMSTRONG_CATEGORY_COUNTS,
  ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE,
  ARMSTRONG_CUT_UPLIFT_PCT,
  ARMSTRONG_EFFECTIVE_DATE,
  ARMSTRONG_FREIGHT_FLAT_EX_GST,
  ARMSTRONG_NO_BREAK_RANGES,
  ARMSTRONG_PRICING_NOTES,
  ARMSTRONG_RANGES,
  ARMSTRONG_ROLL_RANGES,
  ARMSTRONG_ROWS,
  ARMSTRONG_SHAPE_COUNTS,
  ARMSTRONG_SOURCE,
  ARMSTRONG_VARIANTS,
  ARMSTRONG_WALL_RANGES,
} from "./armstrong-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(ARMSTRONG_RANGES.map((r) => [r.range, r]));
const VARIANT_BY_KEY = new Map(ARMSTRONG_VARIANTS.map((v) => [`${v.range}||${v.dimsRaw}`, v]));
const ROW_BY_KEY = new Map(ARMSTRONG_ROWS.map((r) => [r.variantKey, r]));

const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The three shapes where a pallet actually earns a cheaper rate. */
const PALLET_BREAK_SHAPES = new Set(["pallet_break", "pallet_break_dealer", "pallet_break_per_variant"]);

/** "2.5mm; 1219 x 184mm" printed as a size string, gauge first where there is one. */
function sizeText(v: (typeof ARMSTRONG_VARIANTS)[number]): string {
  const bits: string[] = [];
  if (v.thicknessMm !== null) bits.push(`${v.thicknessMm}mm`);
  if (v.sizePrinted) bits.push(v.sizePrinted);
  return bits.join("; ");
}

/**
 * m2 on one full buying unit: a roll on roll goods, a carton on carton goods.
 * The carton figure is DERIVED from the integer piece count and the face size,
 * not read off the printed carton m2, which Armstrong round (3.34 against a
 * true 3.3496 on EarthCuts 457mm). Falls back to the printed figure only where
 * a piece count cannot be derived.
 */
function bulkQtyFor(v: (typeof ARMSTRONG_VARIANTS)[number]): number | null {
  if (v.rollM2 !== null) return v.rollM2;
  if (v.unitsPerPack !== null && v.unitM2 !== null) return round2(v.unitsPerPack * v.unitM2);
  return v.packM2Printed;
}

function buildArmstrong(supplierId: number): ProductSeed[] {
  return ARMSTRONG_ROWS.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range);
    if (!meta) throw new Error(`no range meta for ${r.range}`);
    const v = VARIANT_BY_KEY.get(`${r.range}||${r.dimsRaw}`);
    if (!v) throw new Error(`no size variant for ${r.range} / ${r.dimsRaw}`);

    const isRoll = r.priceShape === "roll_cut";
    const hasBreak = PALLET_BREAK_SHAPES.has(r.priceShape);
    const isInfoOnly = r.priceShape === "pallet_info_only";

    /**
     * On a roll range the printed rate is the ROLL rate, so that is the cost
     * and the 15% rides on top of it. On a pallet range the cost is the
     * STANDARD rate, which is what an ordinary order pays, and the pallet rate
     * goes in the volume columns. Excelon prints one rate for both, so either
     * column is the same number.
     */
    const cost = isRoll || isInfoOnly ? r.palletPrice : r.standardPrice;
    const cutPrice = isRoll ? round2(cost * (1 + ARMSTRONG_CUT_UPLIFT_PCT / 100)) : null;
    const bulkQty = bulkQtyFor(v);
    const bulkCost = bulkQty === null ? null : round2(cost * bulkQty);
    const palletSaving = hasBreak ? round2(r.standardPrice - r.palletPrice) : null;
    const palletPremiumPct = hasBreak ? Math.round(((r.standardPrice - r.palletPrice) / r.palletPrice) * 10000) / 100 : null;
    const palletOrderCost = hasBreak ? round2(r.palletPrice * r.thresholdM2) : null;
    const bulkNoun = v.rollM2 !== null ? "Roll" : "Carton";

    return {
      supplierId,
      supplier: "Armstrong Flooring",
      // Armstrong badge everything on this list themselves. The Source column
      // is identical on all 355 rows and names no second brand.
      brand: "Armstrong",
      range: r.range,
      colour: r.colour,
      category: r.category,
      // Armstrong publish no grade, band or residential/commercial split
      // anywhere on this workbook.
      tier: "",
      // Every one of the 355 rows is per m2. There is no lineal-metre or
      // per-sheet pricing anywhere on this list.
      unit: "m2",
      backing: v.backing || meta.backing,
      size: sizeText(v),
      // Roll width in metres on roll goods. Null on carton goods, and null on
      // Armalon NG Colours as well, which prints two widths, see the header.
      widthM: v.widthM,
      lengthMm: v.tileLengthMm,
      widthMm: v.tileWidthMm,
      // 2mm on the 18 Safeguard rows now: the source's "2mm / 1.50" is a
      // raised grip relief on a 2mm sheet, not a second gauge.
      thicknessMm: v.thicknessMm,
      wearLayerMm: v.wearLayerMm,
      // Not published on any of the 355 lines.
      weight: "",

      // Derived from the printed plank or tile size and reconciled against the
      // printed carton m2 at extract time, with the integer piece count kept
      // as the source of truth. Null on roll goods, which have no pack.
      unitsPerPack: v.unitsPerPack,
      unitM2: v.unitM2,
      packM2Printed: v.packM2Printed,
      // Cartons on a full pallet, worked back from the printed threshold and
      // the pack size. Null on roll goods, and null on the two variants whose
      // threshold does not divide into a whole number of packs.
      boxesPerPallet: v.packsPerPalletExact === true ? v.packsPerPallet : null,

      costPrice: cost,
      sellPrice: sell(cost),

      // NULL ON ALL 355 ROWS. Armstrong publish a percentage, not a dollar cut
      // rate. See note 6.
      cutCostPrice: null,
      // 15 on the 177 roll rows. Null on carton goods, which are not cut off a
      // roll: a short carton order is not cheaper or dearer per m2.
      cutUpliftPct: isRoll ? ARMSTRONG_CUT_UPLIFT_PCT : null,
      // m2 on one full roll or one carton. On a roll row this is also the
      // threshold the cut uplift turns on.
      rollM2: bulkQty,
      bulkKind: meta.bulkKind,

      // The PALLET rate and the printed pallet THRESHOLD. An order-size break,
      // not a cut rate, which is why it sits in the same columns as MJS's
      // over-300 m2 rate. Both null on roll rows and on Excelon, where no
      // cheaper rate exists to earn.
      volumeCostPrice: hasBreak ? r.palletPrice : null,
      volumeQty: hasBreak ? r.thresholdM2 : null,

      priceOnApplication: false,
      // Not published.
      minOrderQty: null,
      // The workbook names no expiry. It is a price list, not a quote.
      priceValidUntil: "",
      // Same exact string as Tarkett's Wallgard and MJS's Somwall so one
      // search finds every wall product in the book.
      fitsRange: meta.isWall ? "WALL CLADDING, not a floor covering" : "",

      // The list carries no stock or lead-time column of any kind, and Damien
      // rings Armstrong before ordering on every product regardless, so
      // nothing here claims a lead time and nothing claims stock either.
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote:
        "No lead time or stock data on this list. Always call Armstrong to confirm availability before ordering, which is how Damien works this supplier on every product.",

      // NO SKUs EXIST IN THE SOURCE. See note 9.
      sku: "",
      variantKey: r.variantKey,
      sourceNote:
        (isRoll
          ? `${money(cost)}/m2 FULL ROLL rate ex GST. A part roll is +${ARMSTRONG_CUT_UPLIFT_PCT}% = ${money(cutPrice!)}/m2, which is ${money(round2(cutPrice! - cost))}/m2 more. The percentage is stored, not the cut price, so the two can never drift apart. Roll of ${bulkQty} m2 = ${money(bulkCost!)} at the roll rate. `
          : hasBreak
            ? `${money(cost)}/m2 STANDARD rate ex GST, which is what a normal order pays. The PALLET rate is ${money(r.palletPrice)}/m2 from ${r.thresholdM2} m2, saving ${money(palletSaving!)}/m2. A full pallet of ${r.thresholdM2} m2 is ${money(palletOrderCost!)}. Both rates are printed by Armstrong and neither is derived from the other. `
            : `${money(cost)}/m2 ex GST. Armstrong print the same rate above and below the ${r.thresholdM2} m2 pallet, so the quantity is for ordering only and there is no discount on this range. `) +
        (bulkQty !== null && !isRoll ? `${bulkNoun} of ${bulkQty} m2 = ${money(bulkCost!)} at this rate. ` : "") +
        (meta.isDealerPricing ? `DEALER PRICING: both rates on this range are Armstrong's dealer rates, which the list's own pricing notes confirm are Terra's cost. ` : "") +
        (meta.priceOverride ? `${meta.priceOverride} ` : "") +
        `Printed rule: "${meta.ruleText}". Threshold type: "${r.thresholdType}". Dimensions as printed: "${r.dimsRaw}". ` +
        `NO SKU: this list carries no product codes at all, so quote by range, colour and size. ` +
        `Freight is NOT in this rate: Armstrong deliver to the warehouse for a flat ${money(ARMSTRONG_FREIGHT_FLAT_EX_GST)} an order ex GST, seeded as a supplier fee. ` +
        `Source: ${ARMSTRONG_SOURCE}, effective ${ARMSTRONG_EFFECTIVE_DATE}.`,
      notes:
        `${ARMSTRONG_SOURCE}, effective ${ARMSTRONG_EFFECTIVE_DATE}. 355 lines across 31 ranges and 38 printed sizes, all per m2 ex GST. ` +
        (isRoll
          ? `PRICED AS A FULL ROLL WITH A ${ARMSTRONG_CUT_UPLIFT_PCT}% CUT UPLIFT: ${money(cost)}/m2 for a full ${bulkQty} m2 roll, ${money(cutPrice!)}/m2 for a cut. The ${ARMSTRONG_CUT_UPLIFT_PCT}% is Armstrong's own workbook formula, asserted cell by cell at extract time, not a rule of thumb. It is stored as a PERCENTAGE rather than a second dollar price, which is the opposite of how Polyflor and MJS are held, because that is how Armstrong publish it. Worth checking any quote near the roll size: a full roll is ${money(bulkCost!)} against ${money(round2((bulkQty! - 1) * cutPrice!))} for one square metre less at the cut rate. `
          : hasBreak
            ? `TWO PRINTED RATES AND THE ORDER SIZE PICKS ONE: ${money(cost)}/m2 standard, ${money(r.palletPrice)}/m2 once the order reaches ${r.thresholdM2} m2, a ${palletPremiumPct}% premium for not taking a pallet. THE BREAK IS LIVE. The first Armstrong import had to seed this dormant because the old list printed a pallet rate and never a pallet quantity; the corrected list prints a threshold on every row, so a big enough order now earns the pallet rate by itself. This is an ORDER-SIZE break, not a cut rate, so it is held in the same columns as MJS's over-300 m2 rate. `
            : `NO PALLET DISCOUNT ON THIS RANGE, AND THAT IS WHAT THE LIST SAYS. Armstrong print ${money(cost)}/m2 both above and below the ${r.thresholdM2} m2 pallet, so the pallet quantity is for ordering and carton counting only. No volume break is seeded, deliberately, because a break that saves nothing would have the app announce a saving of zero dollars. `) +
        (r.priceShape === "pallet_break_per_variant"
          ? `THRESHOLD IS PER SIZE ON THIS RANGE: Armstrong print the pallet quantity against each colour and size rather than once across the range, so this line's ${r.thresholdM2} m2 is its own and the sibling sizes differ. `
          : "") +
        (meta.isDealerPricing
          ? `DEALER PRICING, CONFIRMED BY THE LIST ITSELF: the pricing notes name this range as one where Armstrong publish dealer pallet and dealer standard rates and state those are the rates to use as Terra's cost. Both rates here are the dealer ones, which sit well below the rates the first import carried. `
          : "") +
        (meta.priceOverride ? `${meta.priceOverride} ` : "") +
        (v.dimsNote ? `${v.dimsNote} ` : "") +
        (meta.isWall
          ? `THIS IS WALL CLADDING, NOT FLOORING. Wallflex is Armstrong's wall vinyl, the only Wall Vinyl category on the list, 13 colours on a 1.50m x 20m roll. It is flagged so nobody specifies it as a floor covering, the same way Tarkett's Wallgard and MJS's Somwall are. `
          : "") +
        (meta.slipRating
          ? `SAFETY VINYL, SLIP RATED ${meta.slipRating}, which is Armstrong's own printed rating and is part of the range name. R10, R11 and R12 are three separate ranges at two different rates, so the rating is chosen before the price, never after. `
          : meta.safetyRange
            ? `SAFETY RANGE, NO R-NUMBER PRINTED. Armstrong market this as a safety product but publish no slip rating against it on this list, unlike the Safeguard ranges. The rating is left blank rather than borrowed from a sibling range. Confirm the rating with Armstrong before specifying it anywhere a slip rating is a condition of the job. `
            : "") +
        (v.backing || meta.backing
          ? `${v.backing || meta.backing}: a separate, dearer range from standard ${r.range.replace(/ Cushion Back$/, "")}, kept apart on Armstrong's own instruction in the pricing notes rather than merged as a backing option. `
          : "") +
        (v.unitsPerPack !== null
          ? `CARTON GOODS: ${v.unitsPerPack} pieces of ${v.sizePrinted} to a carton, ${v.packM2Printed} m2 as Armstrong print it and ${bulkQty} m2 derived off the face size. The piece count is the source of truth for ordering maths; the printed carton m2 is rounded and is kept only for checking an invoice against. ` +
            (v.packsPerPalletExact === true
              ? `A pallet is ${v.packsPerPallet} cartons at the printed ${r.thresholdM2} m2 threshold. `
              : `THE PRINTED PALLET DOES NOT DIVIDE INTO WHOLE CARTONS here, so no carton-per-pallet figure is stored. The ${r.thresholdM2} m2 threshold is used exactly as printed. `)
          : "") +
        `NO SKU ON THIS LINE, OR ON ANY OF THE 355. The list has no code column at all, so identity is range plus colour plus printed size and there is nothing to chase. The size is in the key because EarthCuts print three of their colours at two tile sizes each. ` +
        `FREIGHT IS KNOWN AND PRICED: Armstrong deliver to Terra's warehouse for a flat ${money(ARMSTRONG_FREIGHT_FLAT_EX_GST)} an order ex GST, inclusive of all fees, confirmed by Damien. It is seeded as a supplier fee rule and is never folded into this per-m2 rate, so this cost is goods only and the delivery lands once an order, not once a line. ` +
        `NO FUEL SURCHARGE: this list carries no fuel row, unlike Tarkett's 2.1% and Chaparral's $2/lm. ` +
        `NO LEAD TIME OR STOCK DATA EXISTS ON THIS LIST, and Damien rings Armstrong before ordering on every product anyway, so always confirm availability before committing a date. ` +
        `STILL UNSTATED BY ARMSTRONG AND WORTH ASKING: which colours of Armalon NG Colours come on the 1.83m roll and which on the 1.525m, the pallet make-up on the two variants whose threshold is not a whole number of cartons, minimum order, warranty, acoustic ratings and product weight.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "armstrong"));
  if (!supplier) throw new Error("Seed suppliers first, no Armstrong supplier row found.");

  const items = buildArmstrong(supplier.id);

  if (items.length !== 355) throw new Error(`expected 355 lines, got ${items.length}`);
  if (ARMSTRONG_RANGES.length !== 31) throw new Error(`expected 31 ranges, got ${ARMSTRONG_RANGES.length}`);
  if (ARMSTRONG_VARIANTS.length !== 38) throw new Error(`expected 38 size variants, got ${ARMSTRONG_VARIANTS.length}`);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  // Guards on the decisions in the header.
  let roll = 0;
  let live = 0;
  let infoOnly = 0;
  let wall = 0;
  let dealer = 0;
  for (const i of items) {
    const row = ROW_BY_KEY.get(i.variantKey!);
    if (!row) throw new Error(`no source row behind ${i.variantKey}`);

    if (!i.costPrice) throw new Error(`no cost price on ${i.range} ${i.colour}`);
    if (i.unit !== "m2") throw new Error(`every Armstrong line is per m2, ${i.range} ${i.colour} is not`);
    // Note 6: a dollar cut rate must never appear on this supplier.
    if (i.cutCostPrice !== null) throw new Error(`Armstrong publish a % uplift, not a dollar cut rate: ${i.range} ${i.colour}`);
    // Note 9: no codes exist in the source, so none may be invented here.
    if (i.sku !== "") throw new Error(`invented a SKU on ${i.range} ${i.colour}, the source has no code column`);
    // Every row on the new list prints a threshold, so the size must be known.
    if (i.rollM2 === null) throw new Error(`no roll or carton size on ${i.range} ${i.colour}`);
    if (i.variantKey !== `${i.variantKey}`.toLowerCase()) throw new Error(`variant key not lower case: ${i.variantKey}`);

    if (row.priceShape === "roll_cut") {
      roll += 1;
      if (i.cutUpliftPct !== ARMSTRONG_CUT_UPLIFT_PCT) throw new Error(`roll row without the ${ARMSTRONG_CUT_UPLIFT_PCT}% uplift: ${i.range} ${i.colour}`);
      if (i.costPrice !== row.palletPrice) throw new Error(`costPrice moved off the printed roll rate on ${i.range} ${i.colour}`);
      if (i.volumeCostPrice !== null || i.volumeQty !== null) throw new Error(`roll row carrying a volume break: ${i.range} ${i.colour}`);
      if (i.bulkKind !== "roll") throw new Error(`roll row not marked as roll goods: ${i.range} ${i.colour}`);
    } else if (PALLET_BREAK_SHAPES.has(row.priceShape)) {
      live += 1;
      // Note 2: the STANDARD rate is the cost, the pallet rate is the break.
      if (i.costPrice !== row.standardPrice) throw new Error(`pallet row not seeded at the standard rate: ${i.range} ${i.colour}`);
      if (i.volumeCostPrice !== row.palletPrice) throw new Error(`pallet rate missing from the volume column: ${i.range} ${i.colour}`);
      if (i.volumeCostPrice! >= i.costPrice) throw new Error(`pallet rate is not cheaper than standard on ${i.range} ${i.colour}`);
      // Note 3: the threshold is the printed one, never a tidied-up number.
      if (i.volumeQty !== row.thresholdM2) throw new Error(`pallet threshold moved off the printed figure on ${i.range} ${i.colour}`);
      if (!i.volumeQty || i.volumeQty <= 0) throw new Error(`dead pallet threshold on ${i.range} ${i.colour}`);
      // A pallet break is not a cut, so it must not carry the uplift.
      if (i.cutUpliftPct !== null) throw new Error(`pallet row carrying a cut uplift: ${i.range} ${i.colour}`);
      if (i.bulkKind !== "pack") throw new Error(`carton row not marked as pack goods: ${i.range} ${i.colour}`);
    } else {
      infoOnly += 1;
      // Note 4: Excelon prints one rate either side of the pallet. Seeding a
      // volume pair here would announce a saving of zero dollars.
      if (row.palletPrice !== row.standardPrice) throw new Error(`${i.range} ${i.colour} is seeded as no-break and its two printed rates differ`);
      if (i.volumeCostPrice !== null || i.volumeQty !== null) throw new Error(`no-break row carrying a volume break: ${i.range} ${i.colour}`);
      if (i.cutUpliftPct !== null) throw new Error(`no-break row carrying a cut uplift: ${i.range} ${i.colour}`);
      if (!ARMSTRONG_NO_BREAK_RANGES.includes(i.range!)) throw new Error(`${i.range} seeded with no break and is not one of the no-break ranges`);
    }

    // Note 5: Chesterfield is the one row where the seeded rate is not the
    // printed one, and it must be the confirmed rate, not the printed one.
    if (i.range === "Chesterfield") {
      if (i.volumeCostPrice !== ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE.used) {
        throw new Error(`Chesterfield pallet rate must be the confirmed ${ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE.used}, got ${i.volumeCostPrice}`);
      }
      if (!/OVERRIDDEN/.test(i.notes ?? "")) throw new Error(`Chesterfield row without the override note`);
    }

    if (RANGE_BY_NAME.get(i.range!)!.isDealerPricing) dealer += 1;

    if (/WALL CLADDING/.test(i.fitsRange ?? "")) {
      wall += 1;
      if (!ARMSTRONG_WALL_RANGES.includes(i.range!)) throw new Error(`${i.range} flagged as wall cladding and is not one`);
    }
  }

  const expectedLive =
    ARMSTRONG_SHAPE_COUNTS.pallet_break + ARMSTRONG_SHAPE_COUNTS.pallet_break_dealer + ARMSTRONG_SHAPE_COUNTS.pallet_break_per_variant;
  if (roll !== ARMSTRONG_SHAPE_COUNTS.roll_cut) throw new Error(`roll rows: ${roll} vs ${ARMSTRONG_SHAPE_COUNTS.roll_cut}`);
  if (live !== expectedLive) throw new Error(`live pallet rows: ${live} vs ${expectedLive}`);
  if (infoOnly !== ARMSTRONG_SHAPE_COUNTS.pallet_info_only) throw new Error(`no-break rows: ${infoOnly} vs ${ARMSTRONG_SHAPE_COUNTS.pallet_info_only}`);
  if (dealer !== ARMSTRONG_SHAPE_COUNTS.pallet_break_dealer) throw new Error(`dealer rows: ${dealer} vs ${ARMSTRONG_SHAPE_COUNTS.pallet_break_dealer}`);
  if (wall !== 13) throw new Error(`expected 13 Wallflex wall rows, got ${wall}`);

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

  // THE FIRST IMPORT'S ROWS MUST GO. Its variant keys had no printed size in
  // them, so every one of its 350 rows is a stale twin of a row seeded above
  // rather than something this script updates in place. Anything on this
  // supplier that is not one of the 355 current keys is swept, so the count in
  // the database matches the count on the list.
  const liveKeys = new Set(items.map((i) => i.variantKey!));
  const onFile = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const orphans = onFile.filter((r) => !liveKeys.has(r.variantKey ?? ""));
  for (const o of orphans) await db.delete(s.products).where(eq(s.products.id, o.id));

  console.log(`Armstrong: ${created} created, ${updated} updated of ${items.length} lines across ${ARMSTRONG_RANGES.length} ranges and ${ARMSTRONG_VARIANTS.length} printed sizes`);
  if (orphans.length) console.log(`  ${orphans.length} superseded rows from the first import deleted`);
  console.log(`  ${roll} roll rows on ${ARMSTRONG_ROLL_RANGES.length} ranges, +${ARMSTRONG_CUT_UPLIFT_PCT}% cut uplift`);
  console.log(`  ${live} pallet rows with a LIVE volume break at the printed threshold (was dormant on the first import)`);
  console.log(`  ${dealer} of those are at Armstrong's dealer rates`);
  console.log(`  ${infoOnly} Excelon VCT rows with NO break: one rate either side of the pallet`);
  console.log(`  ${wall} Wallflex rows flagged WALL CLADDING`);
  console.log(`  Chesterfield pallet rate seeded at ${money(ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE.used)}, overriding the printed ${money(ARMSTRONG_CHESTERFIELD_PALLET_OVERRIDE.printed)}`);
  console.log(`  categories: ${Object.entries(ARMSTRONG_CATEGORY_COUNTS).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  freight ${money(ARMSTRONG_FREIGHT_FLAT_EX_GST)} flat an order, seeded as a supplier fee, not in these rates`);
  console.log(`  ${ARMSTRONG_PRICING_NOTES.length} pricing notes carried from the source sheet, list effective ${ARMSTRONG_EFFECTIVE_DATE}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
