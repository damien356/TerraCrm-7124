/**
 * Karndean through the real pricing path, not arithmetic in a comment.
 *
 * Six claims are checked, in the order they will break:
 *
 *   1. THE SEEDED SET. 193 rows read back OUT of the database rather than
 *      trusted from the extractor: 12 ranges, 15 range/size families, every
 *      one of them vinyl and priced per m2.
 *   2. GLUEDOWN AND RIGID CORE ARE TWO PRICES FOR ONE COLOUR NAME. 96 rows
 *      are half of a pair, and each pair must read back as two rows with two
 *      codes, two board sizes, two box quantities and two rates. A pair that
 *      collapsed into one row is the failure this catches, because it would
 *      quote rigid core at the gluedown rate.
 *   3. A RANGE NAME IS NOT A PRICE. Korlok 5G and Knight Tile each carry a
 *      wood and a stone family at different sizes, so the size has to be in
 *      the identity and each family has to hold its own pack maths.
 *   4. THE PACK MATHS IS THE DERIVED WHOLE-PIECE COUNT. 86 rows sit on a
 *      family whose printed box m2 is Karndean's rounding, and ordering must
 *      use the derived figure with the printed one kept beside it.
 *   5. THE 49c OF LEVIES STACKS AND IS NOT IN ANY RATE. Fuel $0.40/m2 and
 *      Resiloop $0.09/m2 must both land on every order ON TOP of the goods,
 *      the $80 freight must land too because this supplier really delivers,
 *      and TARKETT MUST STILL HAVE NO LEVY ROW because theirs is inside their
 *      quoted rate. Both directions, in one run, since the whole risk here is
 *      one supplier's treatment being copied onto the other.
 *   6. NOTHING IS INVENTED. No wear layer, thickness, lead time, pallet count,
 *      volume break, cut rate or minimum order, because the list prints none
 *      of them, and no Opus row, because it is priced with no colours behind it.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-karndean.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { resolveRollCut, resolveSupplierCharges, type SupplierChargeRule } from "../lib/pricing";
import * as s from "./schema";
import {
  KARNDEAN_FAMILIES,
  KARNDEAN_FUEL_SURCHARGE_PER_M2,
  KARNDEAN_RESILOOP_PER_M2,
  KARNDEAN_ROWS,
  KARNDEAN_UNSEEDED_BASIS,
} from "./karndean-data";

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
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "karndean"));
  if (!supplier) throw new Error("no Karndean supplier row");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const all = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const bySku = (sku: string) => {
    const rows = all.filter((r) => r.sku === sku);
    if (!rows.length) throw new Error(`no row seeded for ${sku}`);
    if (rows.length > 1) throw new Error(`${sku} is ${rows.length} rows`);
    return rows[0];
  };
  const order = (m2: number, goodsExGst: number, pickedIds?: number[]) =>
    resolveSupplierCharges(
      supplier,
      rules,
      { goodsExGst, m2, lm: 0, rolls: 0, pallets: 0, shipments: 1 },
      pickedIds ? { pickedIds } : {},
    );

  console.log(
    `Karndean: deliversDirect=${supplier.deliversDirect}, freight="${supplier.freightMethod}", ${rules.length} charge rules, ${all.length} products\n`,
  );

  // ------------------------------------------------------------------
  // 1. THE SHAPE OF THE WHOLE SEEDED SET.
  // ------------------------------------------------------------------
  console.log("--- the seeded set ---");
  check("rows seeded", all.length, 193);
  check("rows on the source sheet", KARNDEAN_ROWS.length, 193);
  check("ranges", new Set(all.map((r) => r.range)).size, 12);
  check("range/size families", new Set(all.map((r) => `${r.range}|${r.size}`)).size, 15);
  check("families held by the extractor", KARNDEAN_FAMILIES.length, 15);
  check("Luxury Vinyl Plank rows", all.filter((r) => r.tier === "Luxury Vinyl Plank").length, 96);
  check("Luxury Vinyl Tile rows", all.filter((r) => r.tier === "Luxury Vinyl Tile").length, 18);
  check("Rigid Core LVP rows", all.filter((r) => r.tier === "Rigid Core LVP").length, 61);
  check("Rigid Core LVT rows", all.filter((r) => r.tier === "Rigid Core LVT").length, 18);
  // Format is not a column, it is written onto the row. 64 gluedown, 50 loose
  // lay, 79 rigid core, which is the whole list.
  check("gluedown rows", all.filter((r) => /, Gluedown/.test(r.notes ?? "")).length, 64);
  check("loose lay rows", all.filter((r) => /, Loose lay/.test(r.notes ?? "")).length, 50);
  check("rigid core rows", all.filter((r) => /, Rigid core/.test(r.notes ?? "")).length, 79);
  ok("every row is vinyl, there is nothing else on this list", all.every((r) => r.category === "vinyl"));
  ok("every row is priced per m2", all.every((r) => r.unit === "m2"));
  ok("every row has a cost price", all.every((r) => (r.costPrice ?? 0) > 0));
  ok("every row has Karndean's own product code", all.every((r) => !!r.sku));
  ok("every code is unique", new Set(all.map((r) => r.sku)).size === all.length);
  ok("every variant key is unique", new Set(all.map((r) => r.variantKey)).size === all.length);
  ok("the size is in every variant key, because a colour can exist twice", all.every((r) => /\|\d+x\d+$/.test(r.variantKey ?? "")));
  check("rates across the whole list", new Set(all.map((r) => r.costPrice)).size, 9);
  ok(
    "and they are the nine printed rates",
    [...new Set(all.map((r) => r.costPrice))].sort((a, b) => (a as number) - (b as number)).join(",") ===
      "25,28.81,33.13,35.69,36.67,42.29,45.3,58.48,65.03",
  );

  // ------------------------------------------------------------------
  // 2. GLUEDOWN AND RIGID CORE ARE TWO PRODUCTS AT TWO PRICES.
  //
  // The pricing trap on this supplier. Quoting Knight Tile or Van Gogh without
  // naming the format is quoting the wrong price by $3.81 or $2.56 a m2.
  // ------------------------------------------------------------------
  console.log("\n--- gluedown against rigid core: same colour, different price ---");
  check("rows that are half of a pair", all.filter((r) => /SAME COLOUR, OTHER FORMAT/.test(r.notes ?? "")).length, 96);
  check("pairs behind them", 96 / 2, 48);

  const ktGlue = bySku("KP105-7");
  const ktRigid = bySku("SCB-KP105");
  ok("White Painted Oak is two separate rows", ktGlue.id !== ktRigid.id);
  ok("same colour name on both", ktGlue.colour === "White Painted Oak" && ktRigid.colour === ktGlue.colour);
  check("Knight Tile gluedown", ktGlue.costPrice!, 25);
  check("Knight Tile rigid core", ktRigid.costPrice!, 28.81);
  check("what the format is worth per m2", ktRigid.costPrice! - ktGlue.costPrice!, 3.81);
  ok("different board size", ktGlue.size !== ktRigid.size);
  ok("different pieces a box", ktGlue.unitsPerPack !== ktRigid.unitsPerPack);
  ok("each row names its opposite number's code", /SCB-KP105/.test(ktGlue.notes ?? "") && /KP105-7/.test(ktRigid.notes ?? ""));
  ok("and tells the office to name the format", /Name the format when quoting/.test(ktGlue.notes ?? ""));
  // The same trap on Van Gogh, at a different gap.
  const vgGlue = bySku("VGW84T");
  const vgRigid = bySku("SCB-VGW84T");
  check("Van Gogh gluedown", vgGlue.costPrice!, 33.13);
  check("Van Gogh rigid core", vgRigid.costPrice!, 35.69);
  check("the gap there", vgRigid.costPrice! - vgGlue.costPrice!, 2.56);
  // 100 m2 quoted on the wrong side of the pair, in money.
  check("100 m2 of Knight Tile at the gluedown rate", resolveRollCut(ktGlue, 100).costExGst!, 2500);
  check("the same 100 m2 in rigid core", resolveRollCut(ktRigid, 100).costExGst!, 2881);
  ok(
    "every pair really does differ in price",
    KARNDEAN_ROWS.filter((r) => r.pairedCode).every((r) => r.pairedPricePerM2 !== r.pricePerM2),
  );

  // ------------------------------------------------------------------
  // 3. A RANGE NAME IS NOT A PRICE: SIZE IDENTIFIES THE FAMILY.
  // ------------------------------------------------------------------
  console.log("\n--- one range name, two families ---");
  const korlokWood = bySku("RKP8105");
  const korlokStone = bySku("RKT3021");
  ok("both are Korlok 5G", korlokWood.range === "Korlok 5G" && korlokStone.range === "Korlok 5G");
  check("Korlok rows in total", all.filter((r) => r.range === "Korlok 5G").length, 31);
  check("the wood family", all.filter((r) => r.range === "Korlok 5G" && r.size === "1420 x 225 mm").length, 19);
  check("the stone family", all.filter((r) => r.range === "Korlok 5G" && r.size === "600 x 457 mm").length, 12);
  check("wood box m2", korlokWood.unitM2! * korlokWood.unitsPerPack!, 3.195);
  check("stone box m2", korlokStone.unitM2! * korlokStone.unitsPerPack!, 2.742);
  check("same rate on both, which is why only the box maths differs", korlokWood.costPrice!, korlokStone.costPrice!);
  check("that rate", korlokWood.costPrice!, 42.29);
  // Knight Tile spans two sizes in EACH format, which is four families.
  check("Knight Tile gluedown sizes", new Set(all.filter((r) => r.range === "Knight Tile Gluedown").map((r) => r.size)).size, 2);
  check("Knight Tile rigid core sizes", new Set(all.filter((r) => r.range === "Knight Tile Rigid Core").map((r) => r.size)).size, 2);
  // No range prices per colour on this supplier, unlike Floor Distributors.
  const perColour = [...new Set(all.map((r) => `${r.range}|${r.size}`))].filter(
    (k) => new Set(all.filter((r) => `${r.range}|${r.size}` === k).map((r) => r.costPrice)).size > 1,
  );
  ok("no family prices per colour, every colour in a family shares its rate", perColour.length === 0);

  // ------------------------------------------------------------------
  // 4. PACK MATHS IS DERIVED, NOT READ OFF THE PRINTED BOX m2.
  // ------------------------------------------------------------------
  console.log("\n--- pack maths: derived pieces, printed figure kept beside it ---");
  const hc = bySku("HC01");
  check("Art Select Handcrafted piece area", hc.unitM2!, 0.13908);
  check("pieces a box", hc.unitsPerPack!, 24);
  check("derived box m2, which ordering uses", hc.unitM2! * hc.unitsPerPack!, 3.33792);
  check("the figure Karndean print", hc.packM2Printed!, 3.345);
  check("the drift between them", hc.packM2Printed! - hc.unitM2! * hc.unitsPerPack!, 0.00708);
  ok("and the row says the printed figure is rounded", /rounded/.test(hc.notes ?? ""));
  check("rows sitting on a rounded printed box m2", all.filter((r) => /which is rounded/.test(r.notes ?? "")).length, 86);
  check("rows where the printed figure is exact", all.filter((r) => !/which is rounded/.test(r.notes ?? "")).length, 107);
  // The parquet is the extreme case: 193 pieces to a box.
  check("Art Select Parquet pieces a box", bySku("AP01").unitsPerPack!, 193);
  check("its piece area", bySku("AP01").unitM2!, 0.017328);
  // Every row's pack maths has to reconcile, read back out of the database.
  const badPack = all.filter(
    (r) => Math.abs((r.lengthMm! * r.widthMm!) / 1_000_000 - r.unitM2!) > 0.000001,
  );
  ok(`all ${all.length} piece areas match the printed board size`, badPack.length === 0);
  ok("every row carries a whole number of pieces a box", all.every((r) => Number.isInteger(r.unitsPerPack)));
  ok("and the printed box m2 is on every row for checking an invoice", all.every((r) => (r.packM2Printed ?? 0) > 0));

  // ------------------------------------------------------------------
  // 5. THE LEVIES STACK, THE FREIGHT LANDS, AND TARKETT STAYS UNTOUCHED.
  // ------------------------------------------------------------------
  console.log("\n--- the 49c of levies, on top of every rate ---");
  check("charge rules on file", rules.length, 3);
  const fuel = rules.find((r) => r.kind === "fuel");
  const levy = rules.find((r) => r.kind === "levy");
  const freight = rules.find((r) => r.kind === "delivery");
  if (!fuel || !levy || !freight) throw new Error("expected a fuel, a levy and a delivery rule");
  check("fuel surcharge", fuel.amount!, KARNDEAN_FUEL_SURCHARGE_PER_M2);
  check("Resiloop levy", levy.amount!, KARNDEAN_RESILOOP_PER_M2);
  check("flat freight", freight.amount!, 80);
  ok("the fuel surcharge is charged per m2, not as a percentage", fuel.basis === "m2");
  ok("so is the Resiloop levy", levy.basis === "m2");
  ok("the freight is flat per order", freight.basis === "order");
  ok("all three auto-apply, Karndean charge them on every order", [fuel, levy, freight].every((r) => r.autoApply === true));
  ok("and all three are ex GST", [fuel, levy, freight].every((r) => r.amountIncludesGst === false));
  ok("the supplier-wide fuel percentage stays off, this one is per m2", supplier.fuelSurchargeActive === false);

  // A box of LooseLay Originals, which is the arithmetic Damien gave.
  const llp = bySku("LLP95");
  const boxM2 = llp.unitM2! * llp.unitsPerPack!;
  check("one LooseLay box", boxM2, 3.15);
  const oneBox = order(boxM2, resolveRollCut(llp, boxM2).costExGst!);
  check("goods on one box", oneBox.goodsExGst, 115.51);
  check("fuel surcharge on it, which is Damien's own figure", oneBox.charges.find((c) => c.kind === "fuel")!.exGst, 1.26);
  check("Resiloop on it", oneBox.charges.find((c) => c.kind === "levy")!.exGst, 0.28);
  check("both levies together", oneBox.surchargesExGst, 1.54);
  check("freight on it", oneBox.freightExGst, 80);
  check("total for one box delivered", oneBox.totalExGst, 197.05);
  console.log(`      ${oneBox.note}`);

  // 100 m2, where the levies are the money and the freight is the rounding.
  const hundred = order(100, resolveRollCut(llp, 100).costExGst!);
  check("100 m2 goods", hundred.goodsExGst, 3667);
  check("fuel on 100 m2", hundred.charges.find((c) => c.kind === "fuel")!.exGst, 40);
  check("Resiloop on 100 m2", hundred.charges.find((c) => c.kind === "levy")!.exGst, 9);
  check("levies together", hundred.surchargesExGst, 49);
  check("freight", hundred.freightExGst, 80);
  check("nothing in packing, they charge no baling or handling", hundred.packingExGst, 0);
  check("nothing in other", hundred.otherExGst, 0);
  check("total delivered", hundred.totalExGst, 3796);
  check("charges on the order", hundred.charges.length, 3);
  ok("nothing was refused, this supplier's charges are all real", hundred.excluded.length === 0);
  console.log(`      ${hundred.note}`);

  // THE LEVIES SCALE AND THE FREIGHT DOES NOT. Which is why a one-box order is
  // dear and a big order is not.
  const big = order(700, 25000);
  check("levies on 700 m2", big.surchargesExGst, 343);
  check("freight on 700 m2 is the same $80", big.freightExGst, 80);
  check("freight as a share of a one-box order", (80 / oneBox.totalExGst) * 100, 40.6);
  check("and of a 700 m2 order", (80 / big.totalExGst) * 100, 0.31);

  // A LIVE PER-m2 CHARGE WITH NO m2 ENTERED IS NOT $0.00, IT IS A MISSING
  // QUANTITY, and the office has to be told rather than quietly undercharged.
  const noQty = order(0, 4000);
  check("levies when nobody entered the m2", noQty.surchargesExGst, 0);
  check("but both are reported as not costed", noQty.excluded.length, 2);
  // The engine writes the unit with a superscript, "Charged per m² and this
  // order has none entered", so the office reads a missing quantity and not a
  // free charge. Matched exactly as it is written.
  ok("with a reason naming the unit", noQty.excluded.every((e) => /charged per m²/i.test(e.reason)));
  ok("and telling the office to enter it", noQty.excluded.every((e) => /none entered/i.test(e.reason)));
  check("the freight still lands, it is flat", noQty.freightExGst, 80);

  // THE MIRROR OF CHAPARRAL AND FLOOR DISTRIBUTORS. Karndean deliver, so the
  // deliversDirect guard must NOT fire here.
  console.log("\n--- Karndean really do deliver, so freight is Terra's cost ---");
  ok("deliversDirect is true on this supplier", supplier.deliversDirect === true);
  ok("the delivery charge reaches the total", hundred.freightExGst === 80);
  ok("no delivery rule was refused", !hundred.excluded.some((e) => /deliver/i.test(e.reason)));
  ok("and the quote note says delivered rather than before transport", /delivered/.test(hundred.note));
  ok("the $80 and the levies are written on the supplier row", /\$80 EX GST FLAT AN ORDER/.test(supplier.freightNote ?? ""));

  // THE TARKETT CONTRAST, CHECKED IN THE SAME RUN. Same levy, same 9c,
  // opposite treatment. Getting either backwards is a real invoice error.
  console.log("\n--- the Tarkett contrast: same levy, opposite treatment ---");
  const [tarkett] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "tarkett"));
  if (!tarkett) throw new Error("no Tarkett supplier row to contrast against");
  const tarkettRules = await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, tarkett.id));
  ok("Karndean carry a Resiloop fee row, because theirs is charged on top", !!levy);
  check("Tarkett carry none, because theirs is already in the rate", tarkettRules.filter((r) => /resiloop|levy/i.test(r.name) || r.kind === "levy").length, 0);
  ok("and Tarkett's supplier row says so in writing", /RESILOOP LEVY IS ALREADY IN THESE PRICES/i.test(tarkett.notes ?? ""));
  ok("while Karndean's says the opposite in writing", /NEITHER IS INSIDE THE PRICE LIST RATES/i.test(supplier.freightNote ?? ""));
  ok("and names Tarkett as the case not to copy", /OPPOSITE of Tarkett/i.test(supplier.notes ?? ""));
  ok(
    "and every Karndean row warns the rate excludes them",
    all.every((r) => /THIS RATE EXCLUDES THE LEVIES/.test(r.notes ?? "")),
  );
  // No cost price may have a levy folded into it. 49c added to a rate would
  // leave a price that is not one of the nine printed ones.
  const printed = new Set(KARNDEAN_ROWS.map((r) => r.pricePerM2));
  ok("every cost price is still a rate Karndean actually print", all.every((r) => printed.has(r.costPrice!)));

  // ------------------------------------------------------------------
  // 6. NOTHING IS INVENTED.
  // ------------------------------------------------------------------
  console.log("\n--- nothing invented ---");
  // The list prints no spec beyond the board size and the box m2.
  ok("no wear layer claimed on any row", all.every((r) => r.wearLayerMm === null));
  ok("no thickness claimed either", all.every((r) => r.thicknessMm === null));
  ok("no weight or backing invented", all.every((r) => r.weight === "" && r.backing === ""));
  ok("and every row says those specs are not on the list", all.every((r) => /prints no wear layer/.test(r.notes ?? "")));
  // Boxed product, so no roll maths anywhere.
  ok("no cut rate anywhere on this supplier", all.every((r) => r.cutCostPrice === null && r.cutUpliftPct === null));
  ok("no roll m2 on a boxed product", all.every((r) => r.rollM2 === null));
  ok("no roll width, so nothing converts to lineal metres", all.every((r) => r.widthM === null));
  ok("every row is a pack, not a roll", all.every((r) => r.bulkKind === "pack"));
  // Nothing on this list states a break, a pallet or a minimum.
  ok("no volume break on any row", all.every((r) => r.volumeCostPrice === null && r.volumeQty === null));
  ok("no boxes-per-pallet figure, the list prints no pallet quantity", all.every((r) => r.boxesPerPallet === null));
  ok("no minimum order, the list states none", all.every((r) => r.minOrderQty === null));
  ok("nothing is price on application, every row has a rate", all.every((r) => r.priceOnApplication === false));
  // Nothing on this list states stock or lead time.
  ok("no lead time claimed on any row", all.every((r) => r.leadTimeDays === null));
  ok("nothing marked made to order", all.every((r) => r.madeToOrder === false));
  ok("no availability note invented", all.every((r) => r.availabilityNote === ""));
  ok("no row claims to fit a range, there are no accessories on this list", all.every((r) => r.fitsRange === ""));
  // OPUS IS PRICED WITH NO COLOURS BEHIND IT AND MUST NOT BE A PRODUCT.
  check("priced ranges recorded but not seeded", KARNDEAN_UNSEEDED_BASIS.length, 1);
  ok("Opus is not seeded as a product", !all.some((r) => /opus/i.test(`${r.range} ${r.colour}`)));
  ok("and nothing carries its $30.95 rate", !all.some((r) => r.costPrice === 30.95));
  // The effective date IS known on this supplier, unlike Floor Distributors.
  ok("the 14 August 2023 effective date is on the supplier row", (supplier.priceListEffectiveFrom?.toISOString() ?? "").startsWith("2023-08-14"));
  ok("and the source note names the list it came off", /Silver Australia price list/i.test(supplier.priceListSource ?? ""));
  ok("every row carries its source row for a dispute", all.every((r) => /row \d+/.test(r.sourceNote ?? "")));
  // The workbook's own warning, carried onto the rows it is about.
  const longboard = all.filter((r) => r.range === "LooseLay Longboard");
  check("LooseLay Longboard rows", longboard.length, 20);
  ok("every one warns about the announced September 2026 refresh", longboard.every((r) => /September 2026/.test(r.notes ?? "")));
  ok("and no other row does", all.filter((r) => /September 2026/.test(r.notes ?? "")).length === longboard.length);
  ok("the gluedown/rigid core trap is written on the supplier row", /GLUEDOWN AND RIGID CORE ARE TWO DIFFERENT PRODUCTS/.test(supplier.notes ?? ""));
  ok("so is the Tarkett contrast", /Tarkett/.test(supplier.notes ?? ""));

  // Every sell price comes off the one markup, so a hand-typed price cannot
  // hide in the set.
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
