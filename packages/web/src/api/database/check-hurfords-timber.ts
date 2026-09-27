/**
 * Hurford's engineered timber flooring through the real pricing path, not
 * arithmetic in a comment.
 *
 * Seven claims are checked, in the order they will break:
 *
 *   1. THE SEEDED SET. 163 flooring rows, 5 accessories and 2 underlays read
 *      back OUT of the database rather than trusted from the extractor, and
 *      the 8 plywood rows of the OTHER Hurford's list still sitting beside
 *      them untouched, at the prices they were seeded at.
 *   2. THE $80 IS A BROKEN PACK FEE THAT LANDS ONCE AN ORDER, AND DELIVERY IS
 *      FREE. The workbook prints the $80 against all 163 rows and describes it
 *      two incompatible ways, so a three-line short order could bill $240.
 *      Damien corrected an earlier reading of it as a flat delivery charge:
 *      Hurford's deliver to Nerang for nothing and the $80 is for an order
 *      that does not make a full pallet. So freight must be $0 on every
 *      order, the $80 must show up in packing exactly once however many lines
 *      are short, a full-pallet line beside a short one must not exempt the
 *      order, and no product row may carry the charge in its rate.
 *   2b. THE 2.21% FUEL SURCHARGE, FROM 23 SEP 2026, ON ALL ORDERS. Damien
 *      gave the rate, the date and the scope: all orders, the plywood and the
 *      engineered flooring alike. So it must read back as a live percent rule,
 *      land in surcharges rather than packing, bill 2.21% of the GOODS so it
 *      never compounds on the $80, stack with the $80 on a short order,
 *      survive the $80 being struck off a full-pallet order, and sit in no
 *      seeded rate.
 *   3. FIRST FLOORS 135mm IS TWO FLOORS. Blackbutt and Spotted Gum are each
 *      published twice at the same width and the same two lengths, at 14mm
 *      for $88 and 13.5mm for $81. Both specs must read back as separate rows
 *      naming each other, because a collapsed pair quotes the wrong floor by
 *      $7/m2 and the variant key used to collapse them.
 *   4. THE PAIRS RESOLVE. 26 handed herringbone and chevron rows and 42 rows
 *      sharing a "+" code across two board lengths, every one pointing at a
 *      row that really exists.
 *   5. PACK MATHS IS THE DERIVED WHOLE-PIECE COUNT. 83 rows print a rounded
 *      box m2, and ordering must use the derived figure with the printed one
 *      kept beside it.
 *   6. ONE RATE FOR EVERY QUANTITY, WHERE THE PLYWOOD HAS TWO. No cut rate,
 *      loose rate or volume break on any flooring row, and the plywood's real
 *      pack-versus-loose break still intact in the same run, since the whole
 *      risk is one list's treatment being copied onto the other.
 *   7. NOTHING IS INVENTED. No warranty, acoustic rating, janka, moisture
 *      content, lead time or stock position, because the list prints none of
 *      them, and the 4 rows with no lamella are exactly the 13.5mm ones.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-hurfords-timber.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { isChargeLive, resolveRollCut, resolveSupplierCharges, type SupplierChargeRule } from "../lib/pricing";
import * as s from "./schema";
import {
  HURFORDS_ACCESSORIES,
  HURFORDS_BROKEN_PACK_FEE_EX_GST,
  HURFORDS_TIMBER_AUDIT,
  HURFORDS_TIMBER_EFFECTIVE_DATE,
  HURFORDS_TIMBER_ROWS,
  HURFORDS_UNDERLAY,
} from "./hurfords-timber-data";
import { HURFORDS_PLYWOOD } from "./hurfords-data";

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
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "hurfords"));
  if (!supplier) throw new Error("no Hurford's supplier row");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const all = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const floors = all.filter((r) => r.category === "timber");
  const accessories = all.filter((r) => r.category === "accessory");
  const underlay = all.filter((r) => r.category === "underlay");
  const plywood = all.filter((r) => r.category === "sheet_goods");

  const bySku = (sku: string) => {
    const rows = all.filter((r) => r.sku === sku);
    if (!rows.length) throw new Error(`no row seeded for ${sku}`);
    if (rows.length > 1) throw new Error(`${sku} is ${rows.length} rows`);
    return rows[0];
  };
  /** 2.21% of the goods, rounded like the charge engine rounds it. */
  const fuelOn = (goodsExGst: number) => Math.round(goodsExGst * 2.21) / 100;
  const order = (m2: number, goodsExGst: number) =>
    resolveSupplierCharges(
      supplier,
      rules,
      { goodsExGst, m2, lm: 0, rolls: 0, pallets: 0, shipments: 1 },
      {},
    );

  console.log(
    `Hurford's: deliversDirect=${supplier.deliversDirect}, ${rules.length} charge rule(s), ${all.length} products ` +
      `(${floors.length} flooring, ${accessories.length} accessories, ${underlay.length} underlay, ${plywood.length} plywood)\n`,
  );

  // ------------------------------------------------------------------
  // 1. THE SHAPE OF THE WHOLE SEEDED SET.
  // ------------------------------------------------------------------
  console.log("--- the seeded set ---");
  check("flooring rows seeded", floors.length, 163);
  check("rows on the source sheet", HURFORDS_TIMBER_ROWS.length, 163);
  check("accessories", accessories.length, 5);
  check("accessories on the source sheet", HURFORDS_ACCESSORIES.length, 5);
  check("underlays", underlay.length, 2);
  check("underlays on the source sheet", HURFORDS_UNDERLAY.length, 2);
  check("everything on this supplier", all.length, 178);
  check("ranges", new Set(floors.map((r) => r.range)).size, 17);
  check("range/width/thickness families", new Set(floors.map((r) => `${r.range}|${r.widthMm}|${r.thicknessMm}`)).size, 18);
  check("plain plank rows", floors.filter((r) => r.tier === "Engineered Timber").length, 134);
  check("herringbone rows", floors.filter((r) => r.tier === "Engineered Timber - Herringbone").length, 17);
  check("chevron rows", floors.filter((r) => r.tier === "Engineered Timber - Chevron").length, 12);
  ok("every flooring row is timber, there is nothing else on this list", floors.every((r) => r.category === "timber"));
  ok("every flooring row is priced per m2, which answers the question the supplier note left open", floors.every((r) => r.unit === "m2"));
  ok("every row has a rate", all.every((r) => (r.costPrice ?? 0) > 0));
  ok("every row has Hurford's own code", all.every((r) => !!r.sku));
  ok("every code on the supplier is unique, across both lists", new Set(all.map((r) => r.sku)).size === all.length);
  ok("so is every variant key", new Set(all.map((r) => r.variantKey)).size === all.length);
  check("rates on the flooring list", new Set(floors.map((r) => r.costPrice)).size, 23);
  ok(
    "and they are the 23 printed rates",
    [...new Set(floors.map((r) => r.costPrice))].sort((a, b) => (a as number) - (b as number)).join(",") ===
      "56,59,60,62,63,66,67.5,69,70.4,74.65,76,79,81,84,86,87,88,89,92,96,109,112,115",
  );
  check("cheapest rate", Math.min(...floors.map((r) => r.costPrice as number)), 56);
  check("dearest rate", Math.max(...floors.map((r) => r.costPrice as number)), 115);

  // THE OTHER LIST ON THE SAME SUPPLIER IS UNTOUCHED. Two lists under one
  // supplier is how a seed silently eats the other one.
  console.log("\n--- the plywood list beside it, untouched ---");
  check("plywood rows still there", plywood.length, 8);
  ok(
    "at the prices they were seeded at",
    plywood
      .map((r) => `${r.sku}:${r.costPrice}`)
      .sort()
      .join(",") ===
      "PNCD241207:23.95,PNCD241209:26.94,PNCD241212:32.24,PNCD241215:41.2,PNCD241217:45.62,PNCD241219:52.12,PNCD241221:62.31,PNCD241225:72.84",
  );
  ok("every plywood row is still sheet goods, not re-categorised", plywood.every((r) => r.category === "sheet_goods"));
  ok("no plywood variant key collided with a flooring one", plywood.every((r) => /cd-non-structural-plywood/.test(r.variantKey ?? "")));
  ok("and no flooring row landed in the plywood namespace", floors.every((r) => !/plywood/.test(r.variantKey ?? "")));

  // ------------------------------------------------------------------
  // 2. THE $80 IS A BROKEN PACK FEE, ONCE AN ORDER, AND DELIVERY IS FREE.
  //
  // The whole reason this supplier needed an answer before it could be seeded,
  // and the answer changed: the same $80 was first read as a flat delivery
  // charge on every order. Damien corrected it. Hurford's deliver to Nerang for
  // nothing, and the $80 is what they charge for an order that does not make a
  // full pallet. So freight on this supplier must now be ZERO on every order,
  // and the $80 has to land in packing instead.
  // ------------------------------------------------------------------
  console.log("\n--- the $80: a broken pack fee once an order, and free delivery ---");
  check("charge rules on file", rules.length, 2);
  const brokenPack = rules.find((r) => r.kind === "handling");
  if (!brokenPack) throw new Error("expected a handling rule for the broken pack fee");
  check("the broken pack fee", brokenPack.amount!, HURFORDS_BROKEN_PACK_FEE_EX_GST);
  check("which is the $80 the workbook prints", HURFORDS_BROKEN_PACK_FEE_EX_GST, 80);
  ok("it is named for what it is", brokenPack.name === "Broken pack fee");
  ok("it is a handling charge, not freight", brokenPack.kind === "handling");
  ok("NO DELIVERY RULE EXISTS, because delivery to Nerang is free", !rules.some((r) => r.kind === "delivery"));
  ok("charged per order, NOT per box, pallet or product", brokenPack.basis === "order");
  ok("it auto-applies, since a Terra job is almost never a whole pallet", brokenPack.autoApply === true);
  ok("and it is ex GST", brokenPack.amountIncludesGst === false);
  ok("only ONE handling rule exists, so nothing doubles the $80", rules.filter((r) => r.kind === "handling").length === 1);
  ok("the other rule is the fuel surcharge, not a second broken pack fee", rules.filter((r) => r.kind === "fuel").length === 1);
  ok("no fee rule is charged per pallet, box or each, which is how the trap reading would be modelled", rules.every((r) => !["pallet", "box", "each"].includes(r.basis)));

  // ONE LINE, ONE BOX, NOWHERE NEAR A PALLET.
  const oneRow = bySku("ANEBB13214-1830");
  const boxM2 = oneRow.unitM2! * oneRow.unitsPerPack!;
  check("one box of Australian Native Blackbutt 1830", boxM2, 1.93248);
  const oneLine = order(boxM2, resolveRollCut(oneRow, boxM2).costExGst!);
  check("goods on one box", oneLine.goodsExGst, 162.33);
  check("FREIGHT ON IT IS NOTHING, Hurford's deliver free", oneLine.freightExGst, 0);
  check("the $80 lands in packing, which is where a handling charge belongs", oneLine.packingExGst, 80);
  check("and the fuel surcharge lands in surcharges, not in packing beside it", oneLine.surchargesExGst, 3.59);
  check("which is 2.21% of the goods and not of the goods plus the $80", oneLine.surchargesExGst, fuelOn(162.33));
  check("total for one box, one box being well short of a pallet", oneLine.totalExGst, 245.92);
  console.log(`      ${oneLine.note}`);

  // THREE LINES, EACH SHORT OF A PALLET. This is the exact order the workbook's
  // second reading would have billed $240 of "job lot fee" on.
  const l1 = bySku("ANEBB13214-1830");
  const l2 = bySku("FIRBB13514-1830");
  const l3 = bySku("PQCLBN1501475");
  const lines = [l1, l2, l3].map((r) => ({ row: r, m2: 20 }));
  const goodsThree = lines.reduce((sum, l) => sum + resolveRollCut(l.row, l.m2).costExGst!, 0);
  const m2Three = lines.reduce((sum, l) => sum + l.m2, 0);
  const three = order(m2Three, Math.round(goodsThree * 100) / 100);
  check("m2 on the three-line order", m2Three, 60);
  check("goods on it", three.goodsExGst, 20 * 84 + 20 * 88 + 20 * 74.65);
  check("THE FEE ON A THREE-LINE SHORT ORDER IS STILL $80", three.packingExGst, 80);
  ok("not $240, which is what the workbook's per-product reading would have billed", three.packingExGst !== 240);
  check("and still no freight", three.freightExGst, 0);
  check("charges on the order: the one $80 and the one fuel surcharge", three.charges.length, 2);
  check("fuel on it, once, on the whole order's goods", three.surchargesExGst, fuelOn(20 * 84 + 20 * 88 + 20 * 74.65));
  check("total", three.totalExGst, 20 * 84 + 20 * 88 + 20 * 74.65 + 80 + fuelOn(20 * 84 + 20 * 88 + 20 * 74.65));
  console.log(`      ${three.note}`);

  // A FULL-PALLET LINE SITTING BESIDE A SHORT ONE. Damien was asked this
  // directly and said the full-pallet line does NOT escape the fee: the test is
  // whether the ORDER makes a pallet, not each line. So this order carries
  // exactly one $80 — not nothing because a pallet is on it, and not $160.
  const palletRow = bySku("FIRBB13514-1830");
  const palletSrc = HURFORDS_TIMBER_ROWS.find((r) => r.code === "FIRBB13514-1830");
  if (!palletSrc) throw new Error("no source row for FIRBB13514-1830");
  const palletM2 = palletSrc.palletM2Derived;
  check("a full pallet of First Floors Blackbutt 135 x 14", palletM2, 88.938);
  const goodsMixed =
    resolveRollCut(oneRow, 20).costExGst! + resolveRollCut(palletRow, palletM2).costExGst!;
  const mixed = order(20 + palletM2, Math.round(goodsMixed * 100) / 100);
  check("goods on the mixed order", mixed.goodsExGst, Math.round((20 * 84 + palletM2 * 88) * 100) / 100);
  check("A FULL-PALLET LINE DOES NOT EXEMPT THE ORDER: still $80", mixed.packingExGst, 80);
  ok("not nothing, which is what a per-line reading would have given the pallet line", mixed.packingExGst !== 0);
  ok("and not $160, which is one fee a line", mixed.packingExGst !== 160);
  check("two charges on it, the fee once and the fuel once", mixed.charges.length, 2);
  check("and no freight on it either", mixed.freightExGst, 0);

  // AN ORDER THAT IS ALL FULL PALLETS IS THE ONLY ONE THAT AVOIDS THE FEE, AND
  // THE ENGINE CANNOT SEE THAT. Nothing in resolveSupplierCharges knows what a
  // pallet is, so the rule auto-applies and the office strikes it off by hand.
  // That is deliberate, and the exception is written into the rule so they know
  // when. Both halves are checked: the engine really does still bill it, and
  // once it is off the order there is nothing left on top of the goods at all.
  const palletGoods = Math.round(resolveRollCut(palletRow, palletM2).costExGst! * 100) / 100;
  const pallets = order(palletM2, palletGoods);
  check("the engine bills the fee even on a full pallet, since it cannot see pallets", pallets.packingExGst, 80);
  ok(
    "so the rule itself tells the office to take it off an all-full-pallet order",
    /TAKE IT OFF an order that is all full pallets/.test(brokenPack.condition ?? ""),
  );
  // STRIKING THE $80 OFF DOES NOT STRIKE THE FUEL OFF. The fee is the only
  // thing a full pallet escapes; the fuel surcharge is on "all orders" with no
  // threshold, so what is left is the goods plus 2.21% and nothing else.
  const struck = resolveSupplierCharges(
    supplier,
    rules.filter((r) => r.kind !== "handling"),
    { goodsExGst: palletGoods, m2: palletM2, lm: 0, rolls: 0, pallets: 1, shipments: 1 },
    {},
  );
  check("struck off, a full-pallet order carries no packing at all", struck.packingExGst, 0);
  check("but the fuel surcharge stays, because a pallet does not exempt an order from it", struck.surchargesExGst, fuelOn(palletGoods));
  check("so the charges left are the fuel and nothing else", struck.chargesExGst, fuelOn(palletGoods));
  check("no freight creeps back in, because free means free", struck.freightExGst, 0);
  check("and the total is the goods plus 2.21%", struck.totalExGst, palletGoods + fuelOn(palletGoods));

  // A TEN-LINE ORDER, TO PROVE IT IS FLAT AND NOT MERELY UNDER-COUNTED.
  const ten = order(400, 34000);
  check("the fee on a ten-line-sized order", ten.packingExGst, 80);
  check("no freight on that either", ten.freightExGst, 0);
  check("the fee as a share of a one-box order", (80 / oneLine.totalExGst) * 100, 32.53);
  check("and of a 400 m2 order", (80 / ten.totalExGst) * 100, 0.23);
  check("fuel on that 400 m2 order, where the flat fee has faded to nothing", ten.surchargesExGst, fuelOn(34000));
  ok("so on a big order the fuel surcharge costs many times what the $80 does", ten.surchargesExGst > 80 * 9);

  // AND IT IS NOWHERE IN A RATE. $80 folded into a cost price would leave a
  // figure that is not one of the printed ones.
  const printedRates = new Set<number>([
    ...HURFORDS_TIMBER_ROWS.map((r) => r.pricePerM2),
    ...HURFORDS_ACCESSORIES.map((a) => a.price),
    ...HURFORDS_UNDERLAY.map((u) => u.pricePerRoll),
  ]);
  ok("every cost price is a rate Hurford's actually print", all.filter((r) => r.category !== "sheet_goods").every((r) => printedRates.has(r.costPrice!)));
  ok("nothing carries a bare $80 as its rate", !all.some((r) => r.costPrice === 80));
  ok(
    "every flooring row says delivery to us is free",
    floors.every((r) => /DELIVERY TO US IS FREE/.test(r.notes ?? "")),
  );
  ok(
    "and names the broken pack fee as what the rate really excludes",
    floors.every((r) => /broken pack fee/.test(r.notes ?? "")),
  );
  ok(
    "and says the workbook's per-row Job Lot Fee column is that same charge, not a second one",
    all.filter((r) => r.category !== "sheet_goods").every((r) => /not a second charge/.test(r.notes ?? "")),
  );
  ok("no product row still calls the $80 delivery", !all.some((r) => /EXCLUDES DELIVERY/.test(r.notes ?? "")));
  ok("the supplier row says free delivery to Nerang", /DELIVERY TO NERANG IS FREE/.test(supplier.notes ?? ""));
  ok("and calls the $80 a broken pack fee, not delivery", /THE \$80 IS A BROKEN PACK FEE, NOT DELIVERY/.test(supplier.notes ?? ""));
  ok("and flags it as a correction of the earlier reading", /CORRECTS an earlier reading/.test(supplier.notes ?? ""));
  ok("and says it is one $80 an order, not one per short line", /IT IS ONE \$80 AN ORDER, NOT ONE PER SHORT LINE/.test(supplier.notes ?? ""));
  ok("with the $240 that the wrong reading bills", /\$240/.test(supplier.notes ?? ""));
  ok("and spells out that the fee is order-level", /THE FEE IS ORDER-LEVEL, SO A FULL-PALLET LINE DOES NOT ESCAPE IT/.test(supplier.notes ?? ""));
  ok("the fee rule itself says it is the only $80 on the supplier", /THIS IS THE ONLY \$80 ON THIS SUPPLIER/.test(brokenPack.condition ?? ""));
  ok("and that it is not delivery, which is free", /it is NOT delivery, which is free/.test(brokenPack.condition ?? ""));
  ok("Hurford's still deliver themselves, it is just free, so deliversDirect stays true", supplier.deliversDirect === true);
  ok("nothing was excluded from the three-line order", three.excluded.length === 0);

  // ------------------------------------------------------------------
  // 2b. THE 2.21% FUEL SURCHARGE, FROM 23 SEP 2026, ON ALL ORDERS.
  //
  // Damien: "Effective 23.09.2026 there will be an added 2.21% fuel surcharge
  // to all orders", and on which lists it covers, "All orders including solid,
  // plywood and engineered". So it is supplier-wide, it is percent of GOODS,
  // and it stacks with the $80 without compounding on it. The date is already
  // past, so it has to be live, not sitting in a future window.
  // ------------------------------------------------------------------
  console.log("\n--- the 2.21% fuel surcharge, all orders, from 23 Sep 2026 ---");
  const fuel = rules.find((r) => r.kind === "fuel");
  if (!fuel) throw new Error("expected a fuel rule for the 2.21% surcharge");
  ok("it is named for what the supplier calls it", fuel.name === "Fuel Surcharge");
  check("THE RATE IS 2.21%", fuel.percent!, 2.21);
  ok("charged as a percentage of the order, not a flat dollar figure", fuel.basis === "percent_of_order");
  ok("so it carries NO dollar amount, which would be read as a flat fee", fuel.amount === null);
  ok("it auto-applies, because Damien said all orders with no threshold", fuel.autoApply === true);
  ok("it is ex GST like everything else on this supplier", fuel.amountIncludesGst === false);
  ok("it is a charge, not a credit", fuel.isCredit === false);
  ok("EFFECTIVE FROM 23 SEP 2026, Damien's own date", fuel.effectiveFrom === "2026-09-23");
  ok("no end date, which is until further notice and not a promise it is permanent", !fuel.effectiveUntil);
  ok("IT IS LIVE TODAY, since the start date has already passed", isChargeLive(fuel));
  ok("it was already live the day it started", isChargeLive(fuel, "2026-09-23"));
  ok("and it was NOT live the day before", !isChargeLive(fuel, "2026-09-22"));
  ok("nothing is excluded from a one-box order, so the surcharge really bills", oneLine.excluded.length === 0);
  ok("the rule records that it covers all orders, both lists", /IT COVERS BOTH LISTS/.test(fuel.condition ?? ""));
  ok("with Damien's own words on the lists it covers", /All orders including solid, plywood and engineered/.test(fuel.condition ?? ""));
  ok("and says it is percent of goods, so it does not compound on the $80", /IT IS PERCENT OF GOODS, NOT OF THE ORDER TOTAL/.test(fuel.condition ?? ""));
  ok("the supplier notes carry the surcharge and its start date", /2\.21% FUEL SURCHARGE RUNS FROM 23 SEP 2026/.test(supplier.notes ?? ""));
  ok("and flag that 'solid' has no list behind it yet", /"SOLID" IN DAMIEN'S ANSWER HAS NO LIST BEHIND IT YET/.test(supplier.notes ?? ""));
  ok("the legacy display percentage is switched on and in step with the rule", supplier.fuelSurchargeActive === true);
  check("and holds the same 2.21%", supplier.fuelSurchargePct, 2.21);

  // IT IS ON THE PLYWOOD TOO, WHICH IS THE HALF DAMIEN VOLUNTEERED. Both lists
  // are quoted off the one supplier row, so one rule covers both, and the
  // plywood rows say so in their own notes.
  const plyRow = plywood.find((r) => r.sku === "PNCD241217");
  if (!plyRow) throw new Error("no 17mm plywood row");
  const plyOrder = order(0, plyRow.costPrice! * 32);
  check("a full pack of 32 sheets of 17mm plywood", plyOrder.goodsExGst, 1459.84);
  check("fuel on the plywood as well as the flooring", plyOrder.surchargesExGst, fuelOn(1459.84));
  check("which is $1.01 a sheet at the $45.62 pack rate", fuelOn(plyRow.costPrice!), 1.01);
  ok("every plywood row says delivery is free", plywood.every((r) => /DELIVERY TO US IS FREE/.test(r.notes ?? "")));
  ok("and every plywood row carries the 2.21% from 23 Sep 2026", plywood.every((r) => /2\.21% FUEL SURCHARGE from 23 Sep 2026/.test(r.notes ?? "")));
  ok("and every flooring row carries it too", floors.every((r) => /2\.21% FUEL SURCHARGE APPLIES FROM 23 SEP 2026/.test(r.notes ?? "")));
  ok(
    "no plywood cost price was quietly marked up by 2.21% to bake the surcharge in",
    plywood.every((r) => HURFORDS_PLYWOOD.some((p) => p.packPrice === r.costPrice)),
  );

  // ------------------------------------------------------------------
  // 3. FIRST FLOORS 135mm IS TWO FLOORS UNDER ONE NAME.
  //
  // This is the collision that ate four rows on the first seed attempt.
  // ------------------------------------------------------------------
  console.log("\n--- First Floors 135mm: one range name, two floors, $7 apart ---");
  const bb14 = bySku("FIRBB13514-1830");
  const bb135 = bySku("FIRUBB13513.5-1830");
  const sg14 = bySku("FIRSG13514-1830");
  const sg135 = bySku("FIRUSG13513.5-1830");
  ok("Blackbutt is two separate rows", bb14.id !== bb135.id);
  ok("same range name on both", bb14.range === bb135.range);
  ok("same colour name on both", bb14.colour === bb135.colour);
  ok("same board width", bb14.widthMm === bb135.widthMm && bb14.widthMm === 135);
  ok("same board length", bb14.lengthMm === bb135.lengthMm);
  check("the 14mm rate", bb14.costPrice!, 88);
  check("the 13.5mm rate", bb135.costPrice!, 81);
  check("what the half millimetre is worth per m2", bb14.costPrice! - bb135.costPrice!, 7);
  check("and on a 100 m2 job", resolveRollCut(bb14, 100).costExGst! - resolveRollCut(bb135, 100).costExGst!, 700);
  ok("different thickness", bb14.thicknessMm !== bb135.thicknessMm);
  check("same m2 a box, which is why nothing else separates them", bb14.packM2Printed!, bb135.packM2Printed!);
  check("and the same boxes a pallet", bb14.boxesPerPallet!, bb135.boxesPerPallet!);
  ok("the thickness is in the variant key, because range and colour alone collide", (bb14.variantKey ?? "").endsWith("|14|1830") && (bb135.variantKey ?? "").endsWith("|13.5|1830"));
  ok("each row names its rival by code", /FIRUBB13513.5-1830/.test(bb14.notes ?? "") && /FIRBB13514-1830/.test(bb135.notes ?? ""));
  ok("and warns what quoting without the thickness does", /coin toss which floor turns up/.test(bb14.notes ?? ""));
  ok("Spotted Gum has the same trap at the same gap", sg14.costPrice! - sg135.costPrice! === 7);
  check("rows carrying a rival spec", floors.filter((r) => /TWO FLOORS SHARE THIS NAME/.test(r.notes ?? "")).length, 8);
  check("which is four pairs, across two board lengths each", 8 / 2, 4);
  ok(
    "every rival pair really does differ in price, or the warning is about nothing",
    HURFORDS_TIMBER_ROWS.filter((r) => r.otherSpecCode).every((r) => r.otherSpecPricePerM2 !== r.pricePerM2),
  );
  ok(
    "and every rival code points at a row that exists",
    HURFORDS_TIMBER_ROWS.filter((r) => r.otherSpecCode).every((r) =>
      HURFORDS_TIMBER_ROWS.some((o) => o.code === r.otherSpecCode),
    ),
  );
  // The 13.5mm rows are exactly the ones with no lamella printed.
  check("rows with no lamella on the whole list", floors.filter((r) => r.wearLayerMm === null).length, 4);
  ok(
    "and they are exactly the four 13.5mm First Floors rows",
    floors
      .filter((r) => r.wearLayerMm === null)
      .map((r) => r.sku)
      .sort()
      .join(",") === "FIRUBB13513.5-1830,FIRUBB13513.5-2190,FIRUSG13513.5-1830,FIRUSG13513.5-2190",
  );
  ok("each of them says the lamella is not printed rather than guessing one", floors.filter((r) => r.wearLayerMm === null).every((r) => /LAMELLA NOT PRINTED/.test(r.notes ?? "")));
  ok("every other row carries the lamella as its wear layer", floors.filter((r) => r.wearLayerMm !== null).every((r) => (r.wearLayerMm ?? 0) > 0));
  ok("the trap is in the audit trail on the generated data", HURFORDS_TIMBER_AUDIT.some((a) => /two floors, not one/i.test(a.topic)));

  // ------------------------------------------------------------------
  // 4. THE PAIRS RESOLVE: HANDED PARQUETRY AND TWO-LENGTH CODES.
  // ------------------------------------------------------------------
  console.log("\n--- handed parquetry and the two-length codes ---");
  check("rows that are one hand of a pair", floors.filter((r) => /SOLD HANDED/.test(r.notes ?? "")).length, 26);
  check("pairs behind them", 26 / 2, 13);
  const left = bySku("PQCLBN1501475");
  const right = bySku("PQCRBN1501475");
  ok("Oak Chevron Blonde is a left row and a right row", left.id !== right.id);
  check("same rate on both hands", left.costPrice!, right.costPrice!);
  check("that rate", left.costPrice!, 74.65);
  ok("each names the other", /PQCRBN1501475/.test(left.notes ?? "") && /PQCLBN1501475/.test(right.notes ?? ""));
  ok("and says one hand is half a floor", /half a floor/.test(left.notes ?? ""));
  ok(
    "every handed row in the extract has an opposite that exists",
    HURFORDS_TIMBER_ROWS.filter((r) => r.hand).every((r) =>
      HURFORDS_TIMBER_ROWS.some((o) => o.code === r.otherHandCode && o.hand !== r.hand),
    ),
  );
  // 3 parquetry rows are NOT handed: Hurford's box those as left-and-right
  // sets, so calling them handed would ask the office for a second box that
  // does not exist.
  check("parquetry rows in total", floors.filter((r) => /Herringbone|Chevron/.test(r.tier ?? "")).length, 29);
  check("of which sold as left-and-right sets in the one box", 29 - 26, 3);
  ok("and those say so instead of naming an opposite hand", floors.filter((r) => /Herringbone|Chevron/.test(r.tier ?? "") && !/SOLD HANDED/.test(r.notes ?? "")).every((r) => /Left and right sets/i.test(r.notes ?? "")));

  check("rows sharing a \"+\" code across two lengths", floors.filter((r) => /IS NOT ORDERABLE ON ITS OWN/.test(r.notes ?? "")).length, 42);
  check("codes behind them", 42 / 2, 21);
  const short = bySku("ANEBB13214-1830");
  const long = bySku("ANEBB13214-2190");
  check("same rate on both lengths", short.costPrice!, long.costPrice!);
  ok("but a different m2 a box, so the box count for a job changes", short.packM2Printed !== long.packM2Printed);
  check("the 1830 box", short.unitM2! * short.unitsPerPack!, 1.93248);
  check("the 2190 box", long.unitM2! * long.unitsPerPack!, 2.31264);
  ok("both say the bare + code is not orderable", /IS NOT ORDERABLE ON ITS OWN/.test(short.notes ?? "") && /IS NOT ORDERABLE ON ITS OWN/.test(long.notes ?? ""));
  ok(
    "every two-length row points at a sibling that exists",
    HURFORDS_TIMBER_ROWS.filter((r) => r.otherLengthCode).every((r) =>
      HURFORDS_TIMBER_ROWS.some((o) => o.code === r.otherLengthCode && o.lengthMm !== r.lengthMm),
    ),
  );
  ok("and the length is in every variant key", floors.every((r) => new RegExp(`\\|${r.lengthMm}$`).test(r.variantKey ?? "")));

  // ------------------------------------------------------------------
  // 5. PACK MATHS IS DERIVED, NOT READ OFF THE PRINTED BOX m2.
  // ------------------------------------------------------------------
  console.log("\n--- pack maths: derived pieces, printed figure kept beside it ---");
  check("board area on the sample row", short.unitM2!, 0.24156);
  check("boards a box", short.unitsPerPack!, 8);
  check("derived box m2, which ordering uses", short.unitM2! * short.unitsPerPack!, 1.93248);
  check("the figure Hurford's print", short.packM2Printed!, 1.932);
  check("the drift between them", short.unitM2! * short.unitsPerPack! - short.packM2Printed!, 0.00048);
  ok("and the row says the printed figure is rounded", /which is rounded/.test(short.notes ?? ""));
  check("rows sitting on a rounded printed box m2", floors.filter((r) => /which is rounded/.test(r.notes ?? "")).length, 83);
  check("rows where the printed figure is exact", floors.filter((r) => /Matches the printed/.test(r.notes ?? "")).length, 80);
  const badBoard = floors.filter((r) => Math.abs((r.lengthMm! * r.widthMm!) / 1_000_000 - r.unitM2!) > 0.000001);
  ok(`all ${floors.length} board areas match the printed board size`, badBoard.length === 0);
  ok("every row carries a whole number of boards a box", floors.every((r) => Number.isInteger(r.unitsPerPack)));
  ok("and a whole number of boxes a pallet", floors.every((r) => Number.isInteger(r.boxesPerPallet)));
  ok("the printed box m2 is on every row for checking an invoice", floors.every((r) => (r.packM2Printed ?? 0) > 0));
  ok("the printed figure is never more than half a board off the derived one", floors.every((r) => Math.abs(r.packM2Printed! - r.unitM2! * r.unitsPerPack!) <= r.unitM2! / 2));
  // The pallet figure is DERIVED, because the workbook's own column is blank.
  ok("every row says the pallet m2 is derived, the workbook's column being blank", floors.every((r) => /Full Pallet m2 column is blank/.test(r.notes ?? "")));
  check("smallest pallet", Math.min(...HURFORDS_TIMBER_ROWS.map((r) => r.palletM2Derived)), 69.12);
  check("largest pallet", Math.max(...HURFORDS_TIMBER_ROWS.map((r) => r.palletM2Derived)), 119.8368);
  ok("and none of them came off the printed, rounded box figure", HURFORDS_TIMBER_ROWS.every((r) => Math.abs(r.palletM2Derived - r.boxM2Derived * r.boxesPerPallet) < 0.0001));

  // ------------------------------------------------------------------
  // 6. ONE RATE FOR EVERY QUANTITY HERE, TWO ON THE PLYWOOD.
  //
  // Same supplier, opposite shape. Copying either treatment onto the other
  // invents a discount or hides a premium.
  // ------------------------------------------------------------------
  console.log("\n--- one rate on the flooring, a real break on the plywood ---");
  ok("no cut rate on any flooring row", floors.every((r) => r.cutCostPrice === null && r.cutUpliftPct === null));
  ok("no volume break either", floors.every((r) => r.volumeCostPrice === null && r.volumeQty === null));
  ok("no roll m2 on a boxed good", floors.every((r) => r.rollM2 === null));
  ok("no roll width, so nothing converts to lineal metres", floors.every((r) => r.widthM === null));
  ok("every flooring row is a pack", floors.every((r) => r.bulkKind === "pack"));
  ok("and every row says the rate holds at any quantity", floors.every((r) => /AT ANY QUANTITY/.test(r.notes ?? "")));
  ok("with the Pallet Price column heading called out as not implying a second rate", floors.every((r) => /Pallet Price \$\/m2/.test(r.notes ?? "")));
  // A box and a pallet quote at the same rate, which is the whole claim.
  const oneBox = resolveRollCut(short, 1.93248);
  const onePallet = resolveRollCut(short, 86.9616);
  check("rate on one box", oneBox.rateExGst!, 84);
  check("rate on a full pallet", onePallet.rateExGst!, 84);
  ok("no cut premium on either", oneBox.cutPremiumTotal === 0 && onePallet.cutPremiumTotal === 0);
  ok("neither is flagged as better bought as a full pallet, because there is no saving", oneBox.betterAsFullRoll === null && onePallet.betterAsFullRoll === null);
  check("100 m2 of it", resolveRollCut(short, 100).costExGst!, 8400);
  // THE PLYWOOD, IN THE SAME RUN, STILL HAS ITS TWO RATES.
  const ply7 = bySku("PNCD241207");
  check("plywood pack rate", ply7.costPrice!, 23.95);
  check("plywood loose rate, which is Hurford's own printed figure", ply7.cutCostPrice!, 25.87);
  ok("so the plywood really does carry a second rate where the flooring carries none", ply7.cutCostPrice !== null && floors.every((r) => r.cutCostPrice === null));
  ok("and the flooring rows say so in writing", floors.every((r) => /no pack-versus-loose break/.test(r.notes ?? "")));
  ok("the supplier row says it too", /only ONE rate per row/.test(supplier.notes ?? ""));
  ok(
    "and explains that under a pallet costs the fee, not a different rate per m2",
    /going under a pallet costs the \$80 fee rather than a higher rate per m2/.test(supplier.notes ?? ""),
  );

  // ------------------------------------------------------------------
  // 7. NOTHING IS INVENTED, AND THE ODD ROWS ARE FLAGGED NOT FIXED.
  // ------------------------------------------------------------------
  console.log("\n--- nothing invented ---");
  const seeded = all.filter((r) => r.category !== "sheet_goods");
  ok("no lead time claimed on any row", seeded.every((r) => r.leadTimeDays === null));
  ok("nothing marked made to order", seeded.every((r) => r.madeToOrder === false));
  ok("no availability note invented", seeded.every((r) => r.availabilityNote === ""));
  ok("nothing is price on application, every row has a rate", seeded.every((r) => r.priceOnApplication === false));
  ok("no minimum order, the list states none", seeded.every((r) => r.minOrderQty === null));
  ok("no weight or backing invented", seeded.every((r) => r.weight === "" && r.backing === ""));
  ok("no price-valid-until date invented off an 18-month-old list", seeded.every((r) => r.priceValidUntil === ""));
  ok(
    "and every flooring row lists what the price list does not print",
    floors.every((r) => /warranty, acoustic rating, janka, moisture content, lead time and stock position/.test(r.notes ?? "")),
  );
  ok("every row carries its source row for a dispute", seeded.every((r) => /row \d+/.test(r.sourceNote ?? "")));
  ok("and names the flooring list, not the plywood one", seeded.every((r) => /Engineered Flooring Price List/.test(r.sourceNote ?? "")));
  ok("with its 1 April 2025 date, which is not the supplier's date", seeded.every((r) => /1 April 2025/.test(r.sourceNote ?? "")));
  check("the effective date the extract carries", Number(HURFORDS_TIMBER_EFFECTIVE_DATE.slice(0, 4)), 2025);
  ok("the supplier row still carries the PLYWOOD date, and says the flooring date lives per row", (supplier.priceListEffectiveFrom?.toISOString() ?? "").startsWith("2025-06-01"));
  ok("and explains why the two dates differ", /DATED DIFFERENTLY/.test(supplier.notes ?? ""));
  ok("the price age was confirmed rather than assumed", /CONFIRMED CURRENT BY DAMIEN/.test(supplier.notes ?? ""));

  // THE ACCESSORIES. Two of the five codes are templates with a literal **.
  console.log("\n--- the accessories and the template code ---");
  check("accessories priced by the lineal metre", accessories.filter((r) => r.unit === "lm").length, 3);
  check("accessories priced as a whole piece", accessories.filter((r) => r.unit === "each").length, 2);
  check("the nosing rate", bySku("NOSOAFS08503220").costPrice!, 31.4);
  check("the 2200mm mitre", bySku("NOS**1000302.2").costPrice!, 165);
  check("the 1900mm mitre", bySku("NOS**1000301.9").costPrice!, 142.5);
  check("codes that are a template, not a code", accessories.filter((r) => /THE CODE IS A TEMPLATE/.test(r.notes ?? "")).length, 2);
  ok("both still carry the literal ** rather than a guessed colour code", accessories.filter((r) => /THE CODE IS A TEMPLATE/.test(r.notes ?? "")).every((r) => (r.sku ?? "").includes("**")));
  ok("and both say not to send the code as it stands", accessories.filter((r) => /THE CODE IS A TEMPLATE/.test(r.notes ?? "")).every((r) => /do not send this code to Hurford's as it stands/.test(r.notes ?? "")));
  ok("every accessory says what range it fits, a trim that fits nothing is worse than none", accessories.every((r) => r.fitsRange === "Genuine Oak"));
  ok("no flooring row claims to fit a range", floors.every((r) => r.fitsRange === ""));
  ok("the template trap is on the supplier row", /A TEMPLATE, NOT A CODE/.test(supplier.notes ?? ""));

  // THE UNDERLAY IS PRICED PER ROLL, AND THE PER-m2 FIGURE IS NOT A RATE.
  console.log("\n--- the underlay: priced per roll, not per m2 ---");
  check("underlay rows", underlay.length, 2);
  ok("both priced per roll", underlay.every((r) => r.unit === "roll"));
  check("HUSHwalk a roll", bySku("HWALK425").costPrice!, 114.25);
  check("EVERwalk a roll", bySku("EWALK625").costPrice!, 63.5);
  ok("each records the m2 a roll covers", underlay.every((r) => r.rollM2 === 25));
  ok("with no cut rate, because there is no part-roll price", underlay.every((r) => r.cutCostPrice === null && r.cutUpliftPct === null));
  ok("and each says the derived per-m2 figure is NOT a rate Hurford's quote", underlay.every((r) => /is NOT a rate Hurford's quote/.test(r.notes ?? "")));
  // 26 m2 of floor buys two rolls, not 26 m2 of underlay.
  const hush = bySku("HWALK425");
  check("two rolls", resolveRollCut(hush, 2).costExGst!, 228.5);
  ok("and the row says a job over one roll buys two", /buys two rolls, not a part roll/.test(hush.notes ?? ""));

  // Every sell price comes off the one markup, so a hand-typed price cannot
  // hide in the set.
  const mismatched = seeded.filter(
    (r) => Math.abs(r.sellPrice! - Math.round(r.costPrice! * 1.3 * 1.05 * 1.4 * 100) / 100) > 0.005,
  );
  ok(`all ${seeded.length} sell prices come off the standard markup`, mismatched.length === 0);
  if (mismatched.length) console.log(`      offenders: ${mismatched.map((r) => r.sku).join(", ")}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
