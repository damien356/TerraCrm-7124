/**
 * Floor Distributors through the real pricing path, not arithmetic in a comment.
 *
 * Seven claims are checked, in the order they will break:
 *
 *   1. THE SEEDED SET. 124 rows read back OUT of the database rather than
 *      trusted from the extractor: 72 flooring, 51 accessory rows, 1 underlay.
 *   2. PRICE IS PER COLOUR ON FOUR RANGES. Balmain Feature must hold three
 *      different rates and Balmain Oak two, because a range rate applied to
 *      every colour would quietly overcharge or undercharge half of them.
 *   3. FEDERATION PLANK PRICES ON LENGTH. The same colour must bill $79.90 at
 *      1830mm and $82.90 at 2190mm, as two separate rows, while the Rustic
 *      sibling stays $75.90 at both. This is the one pricing trap here.
 *   4. NO PALLET BREAK ANYWHERE ON THE FLOORING, confirmed by Damien with
 *      "forget this". 5,000 m2 must bill at exactly the same rate as 1 m2. A
 *      break that grew on its own is the failure this catches.
 *   5. THE UNDERLAY IS THE ONLY BREAK, and it fires at 1000 lineal metres
 *      (20 rolls), at $1.85, with the printed middle tier nowhere in the maths.
 *   6. FREIGHT IS NOT TERRA'S COST. Picking and bailing $29.50 an order is the
 *      only charge that lands. The four published delivery rates must stay out
 *      of the total EVEN WHEN TICKED BY HAND, which is the double guard doing
 *      its job.
 *   7. NOTHING IS INVENTED. No cut rate on a boxed product, no box-per-pallet
 *      figure on the one pallet that does not divide whole, no Viva Stair, no
 *      effective date, no wear layer on engineered timber.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-floordistributors.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { resolveRollCut, resolveSupplierCharges, type SupplierChargeRule } from "../lib/pricing";
import * as s from "./schema";
import {
  FLOORDISTRIBUTORS_ACCESSORIES,
  FLOORDISTRIBUTORS_DROPPED,
  FLOORDISTRIBUTORS_ROWS,
} from "./floordistributors-data";

const money = (n: number) => `$${n.toFixed(2)}`;
let failures = 0;

function check(label: string, got: number, want: number) {
  const okNow = Math.abs(got - want) < 0.005;
  if (!okNow) failures += 1;
  console.log(`${okNow ? "PASS" : "FAIL"}  ${label}: got ${money(got)}, expected ${money(want)}`);
}

function ok(label: string, condition: boolean) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

async function main() {
  const [supplier] = await db
    .select()
    .from(s.suppliers)
    .where(eq(s.suppliers.code, "floordistributors"));
  if (!supplier) throw new Error("no Floor Distributors supplier row");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const all = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const bySku = (sku: string) => {
    const rows = all.filter((r) => r.sku === sku);
    if (!rows.length) throw new Error(`no row seeded for ${sku}`);
    if (rows.length > 1) throw new Error(`${sku} is ${rows.length} rows, pick by fit`);
    return rows[0];
  };
  const floors = all.filter((r) => ["timber", "hybrid", "vinyl"].includes(r.category));
  const accessories = all.filter((r) => r.category === "accessory");
  const underlayRows = all.filter((r) => r.category === "underlay");

  console.log(
    `Floor Distributors: deliversDirect=${supplier.deliversDirect}, freight="${supplier.freightMethod}", fuelSurcharge=${supplier.fuelSurchargeActive}, ${rules.length} charge rules, ${all.length} products\n`,
  );

  // ------------------------------------------------------------------
  // 1. THE SHAPE OF THE WHOLE SEEDED SET.
  // ------------------------------------------------------------------
  console.log("--- the seeded set ---");
  check("rows seeded", all.length, 124);
  check("flooring rows", floors.length, 72);
  check("flooring rows on the source sheet", FLOORDISTRIBUTORS_ROWS.length, 72);
  check("flooring ranges", new Set(floors.map((r) => r.range)).size, 9);
  check("timber rows", floors.filter((r) => r.category === "timber").length, 29);
  check("hybrid rows", floors.filter((r) => r.category === "hybrid").length, 23);
  check("vinyl rows", floors.filter((r) => r.category === "vinyl").length, 20);
  check("underlay rows", underlayRows.length, 1);
  // 45 sheet lines become 51 rows: a Viva trim that fits two ranges is seeded
  // once per range so a quote can never offer it against the wrong floor.
  check("accessory sheet lines", FLOORDISTRIBUTORS_ACCESSORIES.length, 45);
  check("accessory rows seeded", accessories.length, 51);
  check("of those, tied to one range", accessories.filter((r) => r.fitsRange).length, 41);
  check("and matched by colour instead", accessories.filter((r) => !r.fitsRange).length, 10);
  check("made-to-order stair rows", all.filter((r) => r.madeToOrder).length, 19);
  ok("every variant key is unique", new Set(all.map((r) => r.variantKey)).size === all.length);
  ok("every row has a cost price", all.every((r) => (r.costPrice ?? 0) > 0));
  ok("every row has a supplier code, this list publishes one for everything", all.every((r) => !!r.sku));
  ok("every flooring row is priced per m2", floors.every((r) => r.unit === "m2"));
  ok("every accessory is priced per lineal metre or per piece", accessories.every((r) => r.unit === "lm" || r.unit === "each"));
  ok("the underlay is priced per lineal metre", underlayRows.every((r) => r.unit === "lm"));

  // A trim may only name a range that exists, and a flooring row may only
  // point at a scotia that exists. Both directions, because the two sheets
  // disagree with each other in four places.
  const ranges = new Set(floors.map((r) => r.range));
  ok("no trim claims a range Floor Distributors does not sell", accessories.every((r) => !r.fitsRange || ranges.has(r.fitsRange)));
  const accCodes = new Set(FLOORDISTRIBUTORS_ACCESSORIES.map((a) => a.code));
  ok(
    "every matched scotia code exists on the accessories sheet",
    FLOORDISTRIBUTORS_ROWS.every((r) => !r.scotiaCode || accCodes.has(r.scotiaCode)),
  );
  check("flooring rows joined to a matching scotia", FLOORDISTRIBUTORS_ROWS.filter((r) => r.scotiaCode).length, 29);
  check("of those, inferred rather than printed", FLOORDISTRIBUTORS_ROWS.filter((r) => r.scotiaInferred).length, 1);
  ok(
    "and the inferred one says so on the row, so nobody reads it as printed",
    FLOORDISTRIBUTORS_ROWS.filter((r) => r.scotiaInferred).every((r) => {
      const row = all.find((p) => p.sku === r.code);
      return !!row && /CONFIRM/i.test(row.notes ?? "");
    }),
  );

  // ------------------------------------------------------------------
  // 2. PRICE IS PER COLOUR, NOT PER RANGE, ON FOUR OF THE NINE RANGES.
  // ------------------------------------------------------------------
  console.log("\n--- four ranges price per colour ---");
  const ratesIn = (range: string) => new Set(floors.filter((r) => r.range === range).map((r) => r.costPrice));
  check("Balmain Feature 14mm distinct rates", ratesIn("Balmain Feature 14mm").size, 3);
  check("Balmain Oak 14mm distinct rates", ratesIn("Balmain Oak 14mm").size, 2);
  check("Balmain Oak Wide 15mm distinct rates", ratesIn("Balmain Oak Wide 15mm").size, 2);
  check("Balmain Feature Baltimore", bySku("BLOAK14BALT").costPrice!, 45);
  check("Balmain Feature Lisbon", bySku("BLOAK14LIS").costPrice!, 47.5);
  check("Balmain Feature Copenhagen", bySku("BLOAK14COPE").costPrice!, 49.5);
  check("Balmain Oak Alpine White", bySku("BAL14AW").costPrice!, 59.5);
  check("Balmain Oak Limed Grey, dearer than its own range-mate", bySku("BAL14LG").costPrice!, 61.5);
  ok("so no colour inherited a range rate", bySku("BAL14AW").costPrice !== bySku("BAL14LG").costPrice);
  check("Alpine White sell price off its own cost", bySku("BAL14AW").sellPrice!, 113.7);
  // The three Viva hybrids really are flat, and that is a finding too.
  const viva = floors.filter((r) => r.category === "hybrid");
  ok("all three Viva hybrid ranges are flat at $23.90", viva.every((r) => r.costPrice === 23.9));
  ok("Viva Luxury Vinyl Plank is flat at $24.90", floors.filter((r) => r.category === "vinyl").every((r) => r.costPrice === 24.9));

  // ------------------------------------------------------------------
  // 3. FEDERATION PLANK PRICES ON BOARD LENGTH.
  //
  // The same colour, the same range, two lengths, two rates. Both rows exist
  // and the length is in the variant key, so a quote has to pick one.
  // ------------------------------------------------------------------
  console.log("\n--- Federation Plank: length moves the rate ---");
  const fed1830 = bySku("FEDBBTBRM1830");
  const fed2190 = bySku("FEDBBTBRM2190");
  ok("same colour, same range, two rows", fed1830.colour === fed2190.colour && fed1830.range === fed2190.range);
  check("1830mm board", fed1830.costPrice!, 79.9);
  check("2190mm board, dearer", fed2190.costPrice!, 82.9);
  check("1830mm length recorded", fed1830.lengthMm!, 1830);
  check("2190mm length recorded", fed2190.lengthMm!, 2190);
  ok("the length is in the variant key, so the two can never collapse", (fed1830.variantKey ?? "").includes("|1830|") && (fed2190.variantKey ?? "").includes("|2190|"));
  check("100 m2 of the 1830mm board", resolveRollCut(fed1830, 100).costExGst!, 7990);
  check("100 m2 of the 2190mm board", resolveRollCut(fed2190, 100).costExGst!, 8290);
  check("quoting the wrong length on 100 m2 costs", 8290 - 7990, 300);
  // The Rustic sibling is flat at both lengths, so the trap is on the
  // non-rustic rows only. Seeding it as length-priced would be wrong too.
  const rustic = floors.filter((r) => r.range === "Federation Plank 14mm Rustic");
  check("Rustic rows", rustic.length, 4);
  ok("Rustic is $75.90 at BOTH lengths", rustic.every((r) => r.costPrice === 75.9));
  ok("and Rustic still carries both lengths as separate rows", new Set(rustic.map((r) => r.lengthMm)).size === 2);

  // ------------------------------------------------------------------
  // 4. FULL PACKS, DERIVED PACK MATHS, AND NO PALLET BREAK.
  // ------------------------------------------------------------------
  console.log("\n--- full packs, derived maths, no pallet break ---");
  ok("every flooring row holds an integer board count", floors.every((r) => Number.isInteger(r.unitsPerPack)));
  ok(
    "and its box m2 is board area times that count, not the printed figure",
    floors.every((r) => Math.abs(r.unitM2! * r.unitsPerPack! - r.minOrderQty!) < 0.001),
  );
  ok("full packs only: the minimum order is one box", floors.every((r) => (r.minOrderQty ?? 0) > 0));
  ok("every flooring row is pack goods, not roll goods", floors.every((r) => r.bulkKind === "pack" && r.rollM2 === null));
  const drift = FLOORDISTRIBUTORS_ROWS.filter((r) => Math.abs(r.boxM2 - r.boxM2Printed) > 0.0005).length;
  check("rows where the sheet's printed box m2 is rounded", drift, 32);
  ok(
    "the printed figure is still on file for checking an invoice",
    floors.every((r) => (r.packM2Printed ?? 0) > 0),
  );

  const classic = bySku("VCPAW");
  check("Viva Classic board area", classic.unitM2!, 0.27432);
  check("boards a box", classic.unitsPerPack!, 6);
  check("derived box m2, the ordering unit", classic.minOrderQty!, 1.6459);
  check("printed box m2, for the invoice only", classic.packM2Printed!, 1.646);
  check("boxes a pallet", classic.boxesPerPallet!, 60);

  // NO PALLET BREAK, ANYWHERE ON THE FLOORING. Asked and answered.
  ok("no flooring row carries a volume rate", floors.every((r) => r.volumeCostPrice === null && r.volumeQty === null));
  const one = resolveRollCut(classic, 1.6459);
  const lots = resolveRollCut(classic, 5000);
  check("one box bills at the standard rate", one.rateExGst!, 23.9);
  check("5,000 m2 bills at exactly the same rate", lots.rateExGst!, 23.9);
  check("5,000 m2 cost", lots.costExGst!, 119500);
  ok("no volume rate is offered at any quantity", one.volumeRateExGst === null && lots.volumeRateExGst === null);
  ok("no saving is claimed", lots.volumeSavingTotal === 0);
  ok("and no push-to-a-pallet advice on a flat rate", one.betterAtVolume === null && lots.betterAtVolume === null);
  console.log(`      ${lots.note}`);

  // THE ONE PALLET THAT DOES NOT DIVIDE WHOLE stays null rather than rounded.
  console.log("\n--- Viva Luxury Vinyl Plank: the pallet does not divide whole ---");
  const lvp = bySku("VLVBBT");
  const lvpRows = floors.filter((r) => r.range === "Viva Luxury Vinyl Plank");
  check("Viva LVP rows", lvpRows.length, 20);
  check("board area", lvp.unitM2!, 0.348386);
  check("boards a box", lvp.unitsPerPack!, 8);
  check("derived box m2", lvp.minOrderQty!, 2.7871);
  check("printed box m2", lvp.packM2Printed!, 2.79);
  ok("no box-per-pallet figure on any of the 20 rows", lvpRows.every((r) => r.boxesPerPallet === null));
  ok("and every one of them says why", lvpRows.every((r) => /pallet/i.test(r.notes ?? "") && /confirm/i.test(r.notes ?? "")));
  check("the 111.5 m2 printed pallet is this many boxes", 111.5 / 2.787091, 40.0059);
  check("rows carrying no pallet count", floors.filter((r) => r.boxesPerPallet === null).length, 20);
  ok("every other flooring row does carry one", floors.filter((r) => r.range !== "Viva Luxury Vinyl Plank").every((r) => (r.boxesPerPallet ?? 0) > 0));

  // ------------------------------------------------------------------
  // 5. THE UNDERLAY IS THE ONLY VOLUME BREAK ON THIS SUPPLIER.
  //
  // The list prints three tiers. Damien seeded two: $2.05 standard, $1.85 from
  // 20 rolls. 20 rolls is 1000 lineal metres, and lineal metres is the unit it
  // is priced in, so the threshold is 1000 and not 20.
  // ------------------------------------------------------------------
  console.log("\n--- underlay: two tiers, breaking at 1000 lm ---");
  const pp50 = bySku("PP50");
  check("standard rate", pp50.costPrice!, 2.05);
  check("volume rate", pp50.volumeCostPrice!, 1.85);
  check("threshold, in the unit it is priced in", pp50.volumeQty!, 1000);
  check("one roll", pp50.rollM2!, 50);
  ok("the volume rate is the cheaper of the two", pp50.volumeCostPrice! < pp50.costPrice!);
  ok("no part-roll premium, they sell whole rolls at one rate", pp50.cutCostPrice === null && pp50.cutUpliftPct === null);
  ok("THE MIDDLE TIER IS NOWHERE IN THE MATHS", pp50.costPrice !== 1.95 && pp50.volumeCostPrice !== 1.95);
  ok("and the row says it was dropped on purpose", /middle tier/i.test(pp50.notes ?? ""));

  const u500 = resolveRollCut(pp50, 500);
  check("500 lm bills at the standard rate", u500.rateExGst!, 2.05);
  check("500 lm cost", u500.costExGst!, 1025);
  ok("500 lm has not reached the break", !u500.onVolumeRate);

  // One metre under the break, the office must be told to push it over.
  const u999 = resolveRollCut(pp50, 999);
  check("999 lm cost at the standard rate", u999.costExGst!, 2047.95);
  const push = u999.betterAtVolume;
  if (!push) throw new Error("expected 999 lm to be flagged as better pushed to the break");
  check("1000 lm instead of 999", push.costExGst, 1850);
  check("what pushing it over saves", push.savingExGst, 197.95);
  check("spare lm left over", push.spareQty, 1);
  console.log(`      ${u999.note}`);

  const u1000 = resolveRollCut(pp50, 1000);
  ok("1000 lm reaches the break", u1000.onVolumeRate);
  check("1000 lm rate", u1000.rateExGst!, 1.85);
  check("1000 lm cost", u1000.costExGst!, 1850);
  check("what the break saves on that order", u1000.volumeSavingTotal, 200);
  check("sell per lm follows the rate down", u1000.sellPerUnitExGst!, 3.54);
  check("1500 lm stays on the volume rate", resolveRollCut(pp50, 1500).rateExGst!, 1.85);
  check("1500 lm cost", resolveRollCut(pp50, 1500).costExGst!, 2775);

  // ------------------------------------------------------------------
  // 6. FREIGHT IS NOT TERRA'S COST, AND THE GUARD HOLDS EVEN WHEN TICKED.
  // ------------------------------------------------------------------
  console.log("\n--- freight: picking and bailing only ---");
  ok("Floor Distributors do NOT deliver to Terra", supplier.deliversDirect === false);
  ok("the collection arrangement is on the supplier row", /courier/i.test(supplier.freightMethod ?? ""));
  ok("and the Gold Coast exclusion is written down", /gold coast/i.test(supplier.freightNote ?? ""));
  ok("no fuel surcharge on this supplier", supplier.fuelSurchargeActive === false);
  check("charge rules on file", rules.length, 6);

  const picking = rules.find((r) => r.name === "Picking & Bailing");
  if (!picking) throw new Error("no picking and bailing rule");
  ok("picking and bailing is handling, not delivery, which is why it can apply", picking.kind === "handling");
  ok("charged per order, not per pallet and not per line", picking.basis === "order");
  check("the amount", picking.amount!, 29.5);
  ok("ex GST, as every rate on this supplier is", picking.amountIncludesGst === false);
  ok("auto-applied, because they charge it on every order", picking.autoApply === true);

  const urgent = rules.find((r) => r.name.startsWith("Urgent Brisbane"));
  if (!urgent) throw new Error("no urgent packing rule");
  check("the urgent same-day packing charge", urgent.amount!, 35);
  ok("real but conditional, so it is NOT automatic", urgent.autoApply === false);
  ok("and it is handling too, not freight", urgent.kind === "handling");

  const referenceOnly = rules.filter((r) => /NOT USED/.test(r.name));
  check("published delivery rates held on file as reference only", referenceOnly.length, 4);
  ok("every one of them is a delivery charge", referenceOnly.every((r) => r.kind === "delivery"));
  ok("every one of them is off by default", referenceOnly.every((r) => r.autoApply === false));
  ok("and every one tells the office not to tick it", referenceOnly.every((r) => /DO NOT TICK/i.test(r.condition ?? "")));
  check("the metro pallet rate on file", referenceOnly.find((r) => /Metro/.test(r.name))!.amount!, 95);
  check("the bundle rate on file", referenceOnly.find((r) => /Bundle/.test(r.name))!.amount!, 75);
  check("the oversized rate on file", referenceOnly.find((r) => /Oversized/.test(r.name))!.amount!, 125);
  check("the regional pallet rate on file", referenceOnly.find((r) => /Regional/.test(r.name))!.amount!, 65);

  // A normal order: goods plus exactly $29.50.
  const order = resolveRollCut(bySku("BAL14AW"), 100);
  const quote = resolveSupplierCharges(supplier, rules, {
    goodsExGst: order.costExGst!,
    m2: 100,
    lm: 0,
    rolls: 0,
    pallets: 2,
    shipments: 1,
  });
  check("100 m2 of Balmain Oak Alpine White, goods", quote.goodsExGst, 5950);
  check("handling on the order", quote.packingExGst, 29.5);
  check("freight in Terra's cost", quote.freightExGst, 0);
  check("surcharges", quote.surchargesExGst, 0);
  check("true material cost, goods plus picking and bailing", quote.totalExGst, 5979.5);
  check("one charge on the order", quote.charges.length, 1);
  ok("and it is the picking and bailing", quote.charges[0].name === "Picking & Bailing");
  console.log(`      ${quote.note}`);

  // Per ORDER, so a bigger order does not pay more of it.
  const bigger = resolveSupplierCharges(supplier, rules, {
    goodsExGst: 40000,
    m2: 700,
    lm: 0,
    rolls: 0,
    pallets: 9,
    shipments: 3,
  });
  check("a $40,000 order still pays $29.50", bigger.packingExGst, 29.5);
  check("and totals goods plus $29.50", bigger.totalExGst, 40029.5);
  check("still no freight in it", bigger.freightExGst, 0);

  // THE DOUBLE GUARD. Tick all four delivery rates by hand and they must
  // STILL not reach the total, because the supplier does not deliver. This is
  // the protection against billing the same freight twice, once through Floor
  // Distributors and once through Terra's own courier.
  console.log("\n--- the double guard: ticked delivery rates still cannot bill ---");
  const forced = resolveSupplierCharges(
    supplier,
    rules,
    { goodsExGst: order.costExGst!, m2: 100, lm: 0, rolls: 0, pallets: 2, shipments: 1 },
    { pickedIds: [...referenceOnly.map((r) => r.id), urgent.id] },
  );
  check("freight after ticking all four by hand", forced.freightExGst, 0);
  check("charges that did apply", forced.charges.length, 2);
  check("picking and bailing plus the urgent packing", forced.packingExGst, 64.5);
  check("total, with no freight in it", forced.totalExGst, 6014.5);
  check("delivery rules refused with a reason", forced.excluded.length, 4);
  ok(
    "and the reason names the collection arrangement",
    forced.excluded.every((e) => /does not deliver/i.test(e.reason)),
  );
  for (const e of forced.excluded) console.log(`      refused: ${e.name}`);

  // ------------------------------------------------------------------
  // 7. NOTHING IS INVENTED.
  // ------------------------------------------------------------------
  console.log("\n--- nothing invented ---");
  // Boxed and lineal product only. A cut rate here would be a premium Floor
  // Distributors never published.
  ok("no cut rate anywhere on this supplier", all.every((r) => r.cutCostPrice === null && r.cutUpliftPct === null));
  ok("no flooring row converts to lineal metres", floors.every((r) => r.widthM === null));
  ok("no roll width invented on a boxed product", floors.every((r) => resolveRollCut(r, 10).qtyLm === null));
  // The sheet prints a wear layer on vinyl and hybrid and leaves it blank on
  // engineered timber. Borrowing one from a sibling range would be a spec the
  // customer is told and the supplier never stated.
  ok("no wear layer claimed on engineered timber", floors.filter((r) => r.category === "timber").every((r) => r.wearLayerMm === null));
  ok("and the vinyl and hybrid rows all carry the printed 0.5mm", floors.filter((r) => r.category !== "timber").every((r) => r.wearLayerMm === 0.5));
  // Nothing on this list states stock or lead time.
  ok("no lead time claimed on any row", all.every((r) => r.leadTimeDays === null));
  ok("nothing marked made to order except the custom stair", all.filter((r) => r.madeToOrder).every((r) => /Custom Stair/i.test(r.range)));
  ok("and the custom stair says the lead time is unknown", all.filter((r) => r.madeToOrder).every((r) => /lead time/i.test(r.availabilityNote ?? "")));
  // VIVA STAIR IS SCRAPPED. No row, and nothing at its $12.50 rate.
  check("dropped lines recorded rather than lost", FLOORDISTRIBUTORS_DROPPED.length, 1);
  ok("Viva Stair is not seeded as a product", !all.some((r) => (r.sku ?? "").startsWith("VST") || /Viva Stair/i.test(r.range)));
  ok("and nothing carries its $12.50 rate", !all.some((r) => r.costPrice === 12.5));
  // The list prints no effective date and Damien has not named one.
  ok("no effective date invented on the supplier row", !supplier.priceListEffectiveFrom);
  ok("and the source note says the list prints none", /NO effective date/i.test(supplier.priceListSource ?? ""));
  ok("the four source conflicts are written on the supplier row", /FOUR SOURCE CONFLICTS/i.test(supplier.notes ?? ""));
  ok("the no-pallet-break answer is written down too", /NO PALLET PRICE BREAK/i.test(supplier.notes ?? ""));
  ok("every row carries its source page for a dispute", all.every((r) => /p\d+/.test(r.sourceNote ?? "")));

  // Every sell price on the supplier comes off the one markup, so a hand-typed
  // price cannot hide in the set.
  const mismatched = all.filter(
    (r) => Math.abs(r.sellPrice! - Math.round(r.costPrice! * 1.3 * 1.05 * 1.4 * 100) / 100) > 0.005,
  );
  ok(`all ${all.length} sell prices come off the standard markup`, mismatched.length === 0);
  if (mismatched.length) console.log(`      offenders: ${mismatched.map((r) => r.sku).join(", ")}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
