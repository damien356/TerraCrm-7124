/**
 * MJS Floorcoverings, checked against the database and the real pricing path.
 *
 * MJS are the first supplier in the book with THREE rates on one product: a
 * cut rate, a full-roll rate, and a deeper rate once the order passes 300 of
 * whatever unit the product is priced in. So the thing that can quietly go
 * wrong here is not the number, it is WHICH number a quote reaches for. That
 * is checked through `resolveRollCut` on real seeded rows at quantities either
 * side of both thresholds, not by reading the columns back.
 *
 * The second thing that can go wrong is the 17.5% cut surcharge being charged
 * twice. It is already inside every printed cut price, confirmed by Damien, so
 * there is no fee rule for it and there must never be one. Checked two ways:
 * the arithmetic on every commercial sheet row, and the absence of any
 * surcharge rule on the supplier.
 *
 * Also checked:
 *   - all 4 charge rules are unticked, so a normal order costs goods only
 *   - metro forwarding does not bill on a normal order, and does bill when the
 *     office ticks it, because a forwarded order is a real thing
 *   - baling asks for a count rather than silently totalling zero
 *   - MJS deliver direct, so freight is $0 because it IS $0, not because it is
 *     unknown, which is the opposite of Tarkett
 *   - no fuel surcharge anywhere on this supplier
 *   - the 4 Safetred rows never made it into the book
 *   - 18 blank colours stayed blank, for their three different reasons
 *   - carton goods carry no cut rate, because MJS do not cut a carton
 *   - the weld rods price flat at every quantity, since an identical figure in
 *     all three columns is not a break
 *   - Somwall is flagged wall-not-floor, and nothing else is
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-mjs.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { resolveRollCut, resolveSupplierCharges, type SupplierChargeRule } from "../lib/pricing";
import * as s from "./schema";
import {
  MJS_BALING,
  MJS_CATEGORY_COUNTS,
  MJS_CUT_SURCHARGE,
  MJS_EXCLUDED_ROWS,
  MJS_FLAT_RATE_RANGES,
  MJS_FORWARDING,
  MJS_NO_COLOUR_RANGES,
  MJS_PRICE_LIST_DATE,
  MJS_PRODUCTS,
  MJS_RANGES,
  MJS_THREE_RATE_RANGES,
  MJS_VOLUME_QTY_M2,
  MJS_VOLUME_RANGES,
} from "./mjs-data";

const money = (n: number) => `$${n.toFixed(2)}`;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Inside every rule's window, so nothing is skipped for being out of date. */
const TODAY = "2026-09-26";

let failures = 0;

function check(label: string, got: number | null, want: number) {
  const ok = got !== null && Math.abs(got - want) < 0.005;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got === null ? "null" : money(got)}, expected ${money(want)}`);
}

function checkCount(label: string, got: number, want: number) {
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, expected ${want}`);
}

function checkTrue(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "mjs"));
  if (!supplier) throw new Error("no MJS supplier row — seed suppliers first");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const rows = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));

  console.log(
    `MJS Floorcoverings: ${rows.length} products, ${rules.length} charge rule(s), delivers direct=${supplier.deliversDirect}, fuel active=${supplier.fuelSurchargeActive}\n`,
  );

  /* ---------------------------- the supplier row --------------------------- */
  console.log("--- supplier ---");
  checkTrue("MJS deliver direct to the shop", supplier.deliversDirect === true);
  checkTrue("no fuel surcharge on this supplier", supplier.fuelSurchargeActive === false);
  check("and no fuel percentage hiding on the row", supplier.fuelSurchargePct ?? 0, 0);
  checkCount("charge rules on file", rules.length, MJS_BALING.length + 1);
  checkTrue(
    "every rule is unticked, so a normal order costs goods only",
    rules.every((r) => r.autoApply === false),
    rules.filter((r) => r.autoApply).map((r) => r.name).join(", ") || "none auto-apply",
  );
  checkTrue(
    "every rule dated from the February 2026 list",
    rules.every((r) => r.effectiveFrom === MJS_PRICE_LIST_DATE),
  );

  // The 17.5% is inside the printed cut price. A rule for it charges it twice.
  const surchargeRules = rules.filter((r) => /surcharge|17\.5/i.test(r.name) || r.kind === "fuel");
  checkCount("no rule for the 17.5% cut surcharge, it is already in the cut price", surchargeRules.length, 0);
  checkCount(
    "no percent-of-order rule at all on MJS",
    rules.filter((r) => r.basis === "percent_of_order").length,
    0,
  );

  const baling = rules.filter((r) => r.kind === "baling");
  checkCount("three baling rules", baling.length, 3);
  for (const b of MJS_BALING) {
    const mine = baling.find((r) => r.name === b.charge);
    checkTrue(`baling rule on file: ${b.charge}`, Boolean(mine));
    if (mine) {
      check(`  its amount`, mine.amount ?? 0, b.amount!);
      checkTrue(`  keeps MJS's own wording "${b.unit}"`, (mine.condition ?? "").includes(b.unit.replace("$/", "")));
    }
  }

  const forwarding = rules.filter((r) => r.kind === "delivery");
  checkCount("one forwarding rule", forwarding.length, 1);
  check("metro forwarding amount", forwarding[0]?.amount ?? 0, MJS_FORWARDING.metro.amount);
  checkTrue("and it is per order", forwarding[0]?.basis === "order", `basis=${forwarding[0]?.basis}`);
  checkTrue(
    "country forwarding was not seeded, there is no product weight to price it on",
    MJS_FORWARDING.countrySeeded === false && !rules.some((r) => /country/i.test(r.name)),
  );

  /* ------------------------------- the counts ------------------------------ */
  console.log("\n--- counts, against the data file's own constants ---");
  checkCount("rows seeded", rows.length, MJS_PRODUCTS.length);
  checkCount("rows seeded is 104", rows.length, 104);
  checkCount("ranges", new Set(rows.map((r) => r.range)).size, MJS_RANGES.length);
  checkCount("variant keys, all distinct", new Set(rows.map((r) => r.variantKey)).size, rows.length);
  checkCount("rows with no MJS code", rows.filter((r) => !r.sku).length, 0);

  for (const [cat, n] of Object.entries(MJS_CATEGORY_COUNTS)) {
    const mine = MJS_PRODUCTS.filter((p) => p.printedCategory === cat).map((p) => p.variantKey);
    checkCount(`${cat} rows in the database`, rows.filter((r) => mine.includes(r.variantKey)).length, n);
  }
  checkCount("turf rows in their own category", rows.filter((r) => r.category === "turf").length, 7);
  checkCount("needle punch filed under carpet", rows.filter((r) => r.category === "carpet").length, 6);

  // Two prices for one product is how a quote picks the dearer one.
  const safetred = rows.filter((r) => /safetred/i.test(r.range ?? ""));
  checkCount(`the ${MJS_EXCLUDED_ROWS.length} Safetred rows stayed out of the book`, safetred.length, 0);

  /* --------------------------- prices, row by row -------------------------- */
  console.log("\n--- prices, every row against the printed list ---");
  let offRate = 0;
  let offCut = 0;
  let offVolume = 0;
  let offGeometry = 0;
  for (const row of MJS_PRODUCTS) {
    const db_ = rows.find((r) => r.variantKey === row.variantKey);
    if (!db_) {
      failures += 1;
      console.log(`      MISSING  ${row.range} ${row.colour}`);
      continue;
    }
    if (db_.costPrice !== row.rollPrice) {
      offRate += 1;
      console.log(`      BAD ROLL  ${row.range} ${row.colour}: ${db_.costPrice} vs printed ${row.rollPrice}`);
    }
    if ((db_.cutCostPrice ?? null) !== row.cutPrice) {
      offCut += 1;
      console.log(`      BAD CUT   ${row.range} ${row.colour}: ${db_.cutCostPrice} vs printed ${row.cutPrice}`);
    }
    if ((db_.volumeCostPrice ?? null) !== row.volumePrice || (db_.volumeQty ?? null) !== row.volumeQty) {
      offVolume += 1;
      console.log(
        `      BAD VOL   ${row.range} ${row.colour}: ${db_.volumeCostPrice} at ${db_.volumeQty} vs printed ${row.volumePrice} at ${row.volumeQty}`,
      );
    }
    if (db_.rollM2 !== row.bulkQty || db_.bulkKind !== row.bulkKind || db_.unit !== row.unit) {
      offGeometry += 1;
      console.log(
        `      BAD SHAPE ${row.range} ${row.colour}: ${db_.bulkKind} ${db_.rollM2} ${db_.unit} vs printed ${row.bulkKind} ${row.bulkQty} ${row.unit}`,
      );
    }
  }
  checkCount("rows off the printed roll rate", offRate, 0);
  checkCount("rows off the printed cut rate", offCut, 0);
  checkCount("rows off the printed over-300 rate", offVolume, 0);
  checkCount("rows off the printed buying unit", offGeometry, 0);

  checkCount(
    "rows carrying a cut UPLIFT — MJS publish dollars, not a percentage",
    rows.filter((r) => r.cutUpliftPct !== null).length,
    0,
  );
  checkCount(
    "rows where the cut rate is not dearer than the roll rate",
    rows.filter((r) => r.cutCostPrice !== null && r.cutCostPrice <= r.costPrice!).length,
    0,
  );
  checkCount(
    "rows where the over-300 rate is not cheaper than the roll rate",
    rows.filter((r) => r.volumeCostPrice !== null && r.volumeCostPrice >= r.costPrice!).length,
    0,
  );
  checkCount(
    `rows with a volume rate at a threshold other than ${MJS_VOLUME_QTY_M2}`,
    rows.filter((r) => r.volumeCostPrice !== null && r.volumeQty !== MJS_VOLUME_QTY_M2).length,
    0,
  );

  /* ------------------- the 17.5% is already in the cut price ---------------- */
  console.log("\n--- the 17.5% cut surcharge, proved on every commercial sheet row ---");
  checkTrue("the data file says it is already inside the cut price", MJS_CUT_SURCHARGE.alreadyInCutPrice === true);
  let badIdentity = 0;
  let commercialCuts = 0;
  for (const row of MJS_PRODUCTS.filter((p) => p.printedCategory === "Commercial Sheet" && p.cutPrice !== null)) {
    commercialCuts += 1;
    const expected = round2(row.rollPrice * (1 + MJS_CUT_SURCHARGE.pct / 100));
    if (Math.abs(expected - row.cutPrice!) > 0.01) {
      badIdentity += 1;
      console.log(`      BAD  ${row.range} ${row.colour}: cut ${row.cutPrice} vs roll x 1.175 = ${expected}`);
    }
  }
  checkCount("commercial sheet rows with a cut rate", commercialCuts, 20);
  checkCount("rows where the cut rate is NOT roll x 1.175", badIdentity, 0);

  /* --------------------- carton goods are never cut ------------------------ */
  console.log("\n--- carton goods ---");
  const packRows = MJS_PRODUCTS.filter((p) => p.isPack);
  checkCount("carton lines", packRows.length, 50);
  checkCount(
    "carton lines carrying a cut rate MJS never quoted",
    rows.filter((r) => r.bulkKind === "pack" && r.cutCostPrice !== null).length,
    0,
  );
  checkCount(
    "carton lines missing their piece count",
    rows.filter((r) => r.bulkKind === "pack" && (!r.unitsPerPack || !r.unitM2)).length,
    0,
  );
  checkCount(
    "roll lines wearing a piece count",
    rows.filter((r) => r.bulkKind === "roll" && r.unitsPerPack !== null).length,
    0,
  );

  /* -------------------------- blank colours stay blank --------------------- */
  console.log("\n--- the 18 blank colours, and their three reasons ---");
  const blank = rows.filter((r) => !r.colour);
  checkCount("rows with a blank colour", blank.length, 18);
  checkCount(
    "of those, in ranges MJS publish no colour list for",
    blank.filter((r) => MJS_NO_COLOUR_RANGES.includes(r.range ?? "")).length,
    8,
  );
  checkCount(
    "of those, turf rows whose colour column repeats the range name",
    blank.filter((r) => r.category === "turf").length,
    7,
  );
  checkCount(
    "of those, weld rods with no colour cell in the list at all",
    blank.filter((r) => r.category === "accessory").length,
    3,
  );
  checkCount(
    "blank colours that quietly became a placeholder",
    rows.filter((r) => ["none", "n/a", "na", "-", "tbc"].includes((r.colour ?? "").trim().toLowerCase())).length,
    0,
  );
  checkCount("every blank colour explained in the notes", blank.filter((r) => !/COLOUR IS BLANK/.test(r.notes ?? "")).length, 0);
  checkCount(
    "rows with the range name sitting in the colour field",
    rows.filter((r) => (r.colour ?? "").toLowerCase() === (r.range ?? "").toLowerCase() && r.colour).length,
    0,
  );
  checkCount(
    "variant keys with an empty segment",
    rows.filter((r) => r.variantKey.split("|").some((p) => p === "")).length,
    0,
  );

  /* ----------------------------- lead times ------------------------------- */
  console.log("\n--- availability ---");
  checkCount("rows flagged made to order — MJS publish no lead time at all", rows.filter((r) => r.madeToOrder).length, 0);
  checkCount("rows carrying a lead time", rows.filter((r) => r.leadTimeDays !== null).length, 0);
  checkCount("rows with no availability note", rows.filter((r) => !r.availabilityNote).length, 0);

  /* --------------------------- Somwall is a wall --------------------------- */
  console.log("\n--- Somwall ---");
  const wall = rows.filter((r) => /WALL CLADDING/.test(r.fitsRange ?? ""));
  checkCount("rows flagged wall cladding", wall.length, 2);
  checkTrue("both are Somwall", wall.every((r) => (r.range ?? "").startsWith("Somwall")), wall.map((r) => r.range).join(", "));

  /* ------------------ a normal order costs goods and nothing else ---------- */
  console.log("\n--- a normal order, through resolveSupplierCharges ---");
  const q = resolveSupplierCharges(supplier, rules, { goodsExGst: 5000, m2: 250, rolls: 1 }, { today: TODAY });
  check("charges on a normal order", q.chargesExGst, 0);
  check("surcharges", q.surchargesExGst, 0);
  // $0 because MJS really do deliver for nothing, unlike Tarkett's unknown.
  check("freight, which is genuinely zero on this supplier", q.freightExGst, 0);
  check("total is the goods", q.totalExGst, 5000);
  checkCount("nothing billed without being ticked", q.charges.length, 0);

  // Ticked, because a forwarded order is a real thing that costs $85.
  const metro = rules.find((r) => r.kind === "delivery")!;
  const fwd = resolveSupplierCharges(
    supplier,
    rules,
    { goodsExGst: 5000, m2: 250, rolls: 1 },
    { today: TODAY, pickedIds: [metro.id] },
  );
  check("metro forwarding once the office ticks it", fwd.freightExGst, MJS_FORWARDING.metro.amount);
  check("and the order total with it", fwd.totalExGst, 5085);

  // Baling is per cut length, and a cut count nobody entered is not $0.00.
  const balingRule = rules.find((r) => r.kind === "baling" && r.basis === "each")!;
  const noCount = resolveSupplierCharges(
    supplier,
    rules,
    { goodsExGst: 5000 },
    { today: TODAY, pickedIds: [balingRule.id] },
  );
  check("baling with no cut count entered bills nothing", noCount.chargesExGst, 0);
  checkTrue(
    "and says the count is missing rather than totalling zero",
    noCount.excluded.some((e) => /none entered|put the/i.test(e.reason)),
    noCount.excluded.map((e) => e.reason).join(" | ") || "nothing excluded",
  );
  const twoCuts = resolveSupplierCharges(
    supplier,
    rules,
    // basis "each" bills off `items`: a cut length IS the item being baled.
    { goodsExGst: 5000, items: 2 },
    { today: TODAY, pickedIds: [balingRule.id] },
  );
  check("two cut lengths of commercial vinyl baled", twoCuts.chargesExGst, 40);

  /* ------------------- three rates, through resolveRollCut ----------------- */
  // Somplan 350: $23.38 cut, $19.90 roll on a 46 m2 roll, $19.30 over 300 m2.
  console.log("\n--- Somplan 350: which of the three rates a quote reaches for ---");
  const sp350 = rows.find((r) => r.range === "Somplan 350");
  if (!sp350) throw new Error("no Somplan 350 row");
  const m350 = MJS_RANGES.find((m) => m.range === "Somplan 350")!;

  const small = resolveRollCut(sp350, 20);
  check("20 m2 is priced at the cut rate", small.rateExGst, m350.cutPrice!);
  checkTrue("20 m2 is not on the roll rate", !small.onRollRate);
  checkTrue("and not on the volume rate", !small.onVolumeRate);
  check("20 m2 costs", small.costExGst, round2(m350.cutPrice! * 20));
  check("the cut premium it carries", small.cutPremiumTotal, round2((m350.cutPrice! - m350.rollPrice) * 20));
  // The premium per m2 IS the 17.5%, arrived at from the two printed columns.
  check(
    "which per m2 is the 17.5% already in the printed cut price",
    small.cutPremiumPerUnit,
    round2(m350.rollPrice * (MJS_CUT_SURCHARGE.pct / 100)),
  );

  const near = resolveRollCut(sp350, 44);
  check("44 m2 still on the cut rate", near.rateExGst, m350.cutPrice!);
  checkTrue("but a whole 46 m2 roll is called out as cheaper", near.betterAsFullRoll !== null);
  check("the whole roll costs", near.betterAsFullRoll?.costExGst ?? 0, m350.costPerBulkUnit);
  check("saving against 44 m2 cut", near.betterAsFullRoll?.savingExGst ?? 0, round2(44 * m350.cutPrice! - m350.costPerBulkUnit));
  check("break-even quantity", near.breakEvenQty ?? 0, round2((46 * m350.rollPrice) / m350.cutPrice!));

  const full = resolveRollCut(sp350, 46);
  check("46 m2 drops to the roll rate", full.rateExGst, m350.rollPrice);
  checkTrue("and is on the roll rate", full.onRollRate);
  checkCount("one full roll", full.fullRolls, 1);

  const justUnder = resolveRollCut(sp350, 299);
  check("299 m2 is still the roll rate", justUnder.rateExGst, m350.rollPrice);
  checkTrue("and the volume break is flagged as the better buy", justUnder.betterAtVolume !== null);
  check("300 m2 at the volume rate costs", justUnder.betterAtVolume?.costExGst ?? 0, round2(m350.volumePrice! * 300));
  check(
    "which saves against 299 m2 at the roll rate",
    justUnder.betterAtVolume?.savingExGst ?? 0,
    round2(299 * m350.rollPrice - 300 * m350.volumePrice!),
  );
  check("with this much spare stock", justUnder.betterAtVolume?.spareQty ?? 0, 1);

  const atVolume = resolveRollCut(sp350, 300);
  check("300 m2 earns the over-300 rate", atVolume.rateExGst, m350.volumePrice!);
  checkTrue("and is flagged as on the volume rate", atVolume.onVolumeRate);
  check("what that saves against the roll rate", atVolume.volumeSavingTotal, round2((m350.rollPrice - m350.volumePrice!) * 300));
  check("volume break-even quantity", atVolume.volumeBreakEvenQty ?? 0, round2((300 * m350.volumePrice!) / m350.rollPrice));
  checkTrue("300 m2 costs less than 299 m2 does", (atVolume.costExGst ?? 0) < (justUnder.costExGst ?? 0));

  /* ------------- carton goods: a volume break with no cut tier ------------- */
  console.log("\n--- Tru Plank Timeless: a volume break with no cut rate under it ---");
  const timeless = rows.find((r) => r.range === "Tru Plank Timeless");
  if (!timeless) throw new Error("no Tru Plank Timeless row");
  const mTimeless = MJS_RANGES.find((m) => m.range === "Tru Plank Timeless")!;
  const tpSmall = resolveRollCut(timeless, 30);
  check("30 m2 of cartons is the base rate", tpSmall.rateExGst, mTimeless.rollPrice);
  checkTrue("there is no cut rate to fall to", tpSmall.cutRateExGst === null);
  checkTrue("and no cut premium charged", tpSmall.cutPremiumTotal === 0);
  checkTrue("priced as a pack, not a roll", tpSmall.bulkKind === "pack", `bulkKind=${tpSmall.bulkKind}`);
  const tpVolume = resolveRollCut(timeless, 300);
  check("300 m2 earns the over-300 rate", tpVolume.rateExGst, mTimeless.volumePrice!);
  checkTrue("on the volume rate", tpVolume.onVolumeRate);
  const tpNear = resolveRollCut(timeless, 290);
  check("290 m2 is still the base rate", tpNear.rateExGst, mTimeless.rollPrice);
  checkTrue("and 300 m2 is called out as the cheaper buy", tpNear.betterAtVolume !== null);

  /* ------------------------- the weld rods price flat ---------------------- */
  console.log("\n--- the flat-rate lines: an identical figure is not a break ---");
  for (const rangeName of MJS_FLAT_RATE_RANGES) {
    const row = rows.find((r) => r.range === rangeName);
    if (!row) {
      failures += 1;
      console.log(`      MISSING  ${rangeName}`);
      continue;
    }
    const meta = MJS_RANGES.find((m) => m.range === rangeName)!;
    for (const qty of [5, 50, 400]) {
      const quote = resolveRollCut(row, qty);
      check(`${rangeName} at ${qty} ${meta.unit}`, quote.rateExGst, meta.rollPrice);
      checkTrue(`  no volume break announced`, !quote.onVolumeRate && quote.volumeSavingTotal === 0);
      checkTrue(`  no cut premium announced`, quote.cutPremiumTotal === 0);
    }
    const one = resolveRollCut(row, 5);
    checkTrue(`${rangeName} says it plainly`, /one rate, whatever the quantity/i.test(one.note), one.note);
  }

  /* --------------------------- the three-rate set -------------------------- */
  console.log("\n--- how many ranges carry what ---");
  const threeRateRows = rows.filter((r) => r.cutCostPrice !== null && r.volumeCostPrice !== null);
  const threeRateRanges = new Set(threeRateRows.map((r) => r.range));
  checkCount("ranges with all three rates", threeRateRanges.size, MJS_THREE_RATE_RANGES.length);
  const volumeRanges = new Set(rows.filter((r) => r.volumeCostPrice !== null).map((r) => r.range));
  checkCount("ranges with an over-300 rate", volumeRanges.size, MJS_VOLUME_RANGES.length);
  const flatRanges = new Set(
    rows.filter((r) => r.cutCostPrice === null && r.volumeCostPrice === null).map((r) => r.range),
  );
  checkCount("ranges with one flat rate", flatRanges.size, MJS_FLAT_RATE_RANGES.length);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
