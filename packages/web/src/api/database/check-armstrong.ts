/**
 * Armstrong through the real pricing path, not arithmetic in a comment.
 *
 * THIS IS THE SECOND IMPORT OF ARMSTRONG AND THE CHECKS MOVED WITH IT. The
 * first import ran off an earlier workbook that published a pallet PRICE and
 * never a pallet QUANTITY, so all 39 of its pallet rows had to be seeded
 * dormant and this file's job was to prove the break could not fire. Armstrong
 * then supplied a corrected list. Every pallet row now prints its threshold,
 * so 173 rows carry a LIVE volume break and the job here is the opposite one:
 * prove the break fires at the printed quantity, and prove it does not fire
 * anywhere Armstrong never granted one.
 *
 * Six claims are checked, in the order they will break:
 *
 *   1. THE SEEDED SET. 355 rows, 31 ranges, 177 roll, 178 pack, read back out
 *      of the database rather than trusted from the extractor.
 *   2. ROLL GOODS, 177 rows. Accolade Plus at $38.37/m2 full roll must bill
 *      $44.13/m2 on a part roll off the PERCENTAGE alone. Armstrong are still
 *      the only supplier in the book whose cut rate is a percentage, so this
 *      is the live proof of cutUpliftPct.
 *   3. THE PALLET BREAK IS LIVE. Chesterfield must bill $14.95 under 314.3 m2
 *      and $12.95 at or over it, at the $12.95 Damien confirmed rather than
 *      the $12.75 the workbook prints.
 *   4. EXCELON VCT HAS NO BREAK AND MUST NOT GROW ONE. One rate either side of
 *      the pallet is a real finding, not missing data.
 *   5. FREIGHT IS ONE FLAT $150 AN ORDER, auto-applied, per order and not per
 *      line, and the order total must be goods plus exactly that.
 *   6. NOTHING IS INVENTED. No SKU, no lead time, no dollar cut rate, no
 *      threshold that is not the printed one, no width where the list prints
 *      two.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-armstrong.ts
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./index";
import {
  lmForQty,
  m2ForQty,
  resolveRollCut,
  resolveSupplierCharges,
  type SupplierChargeRule,
} from "../lib/pricing";
import * as s from "./schema";

const money = (n: number) => `$${n.toFixed(2)}`;
let failures = 0;

function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${money(got)}, expected ${money(want)}`);
}

function ok(label: string, condition: boolean) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

async function rowFor(supplierId: number, range: string, colour: string) {
  const rows = await db
    .select()
    .from(s.products)
    .where(
      and(
        eq(s.products.supplierId, supplierId),
        eq(s.products.range, range),
        eq(s.products.colour, colour),
      ),
    );
  if (!rows.length) throw new Error(`no ${range} "${colour}" row seeded`);
  // EarthCuts print Concrete, Sandstone and Slate at two tile sizes each, so
  // range plus colour is not unique on three rows. Anything picked by name
  // alone here must be a single row or the test is ambiguous.
  if (rows.length > 1) throw new Error(`${range} "${colour}" is ${rows.length} rows, name the size`);
  return rows[0];
}

async function rowForSize(supplierId: number, range: string, colour: string, size: string) {
  const [row] = await db
    .select()
    .from(s.products)
    .where(
      and(
        eq(s.products.supplierId, supplierId),
        eq(s.products.range, range),
        eq(s.products.colour, colour),
        eq(s.products.size, size),
      ),
    );
  if (!row) throw new Error(`no ${range} "${colour}" at ${size}`);
  return row;
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "armstrong"));
  if (!supplier) throw new Error("no Armstrong supplier row");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const all = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));

  console.log(
    `Armstrong: deliversDirect=${supplier.deliversDirect}, freight="${supplier.freightMethod}", fuelSurcharge=${supplier.fuelSurchargeActive}, ${rules.length} charge rules, ${all.length} products\n`,
  );

  // ------------------------------------------------------------------
  // 1. THE SHAPE OF THE WHOLE SEEDED SET. These are the decisions in
  // seed-products-armstrong.ts read back OUT OF THE DATABASE, so a later
  // re-import that quietly changes one fails here rather than in a quote.
  // ------------------------------------------------------------------
  console.log("--- the seeded set ---");
  check("rows seeded", all.length, 355);
  check("ranges seeded", new Set(all.map((r) => r.range)).size, 31);
  // 38 is the count of RANGE PLUS PRINTED SIZE pairs, which is what the source
  // groups by. The bare size string collapses to 26, because ranges share a
  // size: "2mm; 1.83m x 20m" is Accolade Plus and Armalon NG both.
  check("range and printed size pairs seeded", new Set(all.map((r) => `${r.range}||${r.size}`)).size, 38);
  check("distinct printed size strings", new Set(all.map((r) => r.size)).size, 26);
  check("roll rows carrying the 15% uplift", all.filter((r) => r.cutUpliftPct === 15).length, 177);
  check("roll rows by bulk kind", all.filter((r) => r.bulkKind === "roll").length, 177);
  check("pack rows by bulk kind", all.filter((r) => r.bulkKind === "pack").length, 178);
  check("pallet rows with a LIVE volume break", all.filter((r) => r.volumeCostPrice !== null).length, 173);
  check("of those, at Armstrong's dealer rates", all.filter((r) => /dealer/i.test(r.notes ?? "")).length, 86);
  check(
    "rows with no break of either kind, the Excelon VCT five",
    all.filter((r) => r.cutUpliftPct === null && r.volumeCostPrice === null).length,
    5,
  );
  check("Wallflex rows flagged wall cladding", all.filter((r) => /WALL CLADDING/.test(r.fitsRange ?? "")).length, 13);
  // The first import left 350 rows on a variant key with no printed size in
  // it. The re-import sweeps them, so a stale twin of every line is exactly
  // the failure this count catches.
  ok("no superseded rows from the first import left behind", all.length === 355);
  ok("every variant key is unique", new Set(all.map((r) => r.variantKey)).size === all.length);
  ok("every variant key carries the printed size", all.every((r) => (r.variantKey ?? "").split("|").length === 4));

  // A row cannot be both a cut and a pallet. The uplift is a part-roll
  // premium, the break is an order-size discount, and nothing Armstrong print
  // is both.
  ok("no row is both a roll cut and a pallet break", all.every((r) => !(r.cutUpliftPct !== null && r.volumeCostPrice !== null)));
  ok("every volume rate is cheaper than the standard rate", all.every((r) => r.volumeCostPrice === null || r.volumeCostPrice < r.costPrice!));
  ok("every volume rate has a threshold to fire at", all.every((r) => r.volumeCostPrice === null || (r.volumeQty ?? 0) > 0));
  ok("every row priced per m2, no lineal metre or per sheet anywhere", all.every((r) => r.unit === "m2"));
  ok("every row has a cost price", all.every((r) => (r.costPrice ?? 0) > 0));
  // Armstrong publish a percentage, so a dollar cut rate on an Armstrong row
  // would be a second copy of the same rate waiting to disagree with the first.
  ok("no dollar cut rate on any of the 355 rows", all.every((r) => r.cutCostPrice === null));
  // The source workbook has no code column, so a SKU here would be invented.
  ok("no SKU on any row, the source has no codes", all.every((r) => r.sku === ""));
  // Damien rings Armstrong before ordering on every product, and the list
  // publishes nothing about stock or lead time.
  ok("no lead time claimed on any row", all.every((r) => r.leadTimeDays === null));
  ok("nothing marked made to order", all.every((r) => !r.madeToOrder));
  ok("every row tells the office to call and confirm", all.every((r) => /call Armstrong to confirm/i.test(r.availabilityNote ?? "")));

  const cats = all.reduce<Record<string, number>>((a, r) => {
    a[r.category] = (a[r.category] ?? 0) + 1;
    return a;
  }, {});
  check("vinyl rows", cats.vinyl ?? 0, 276);
  check("carpet tile rows", cats.carpet_tile ?? 0, 31);
  check("hybrid rows", cats.hybrid ?? 0, 24);
  check("laminate rows", cats.laminate ?? 0, 24);

  // ------------------------------------------------------------------
  // 2. ROLL GOODS AND THE PERCENTAGE CUT RATE.
  //
  // $38.37 full roll, +15% = $44.13 cut. The 15% is Armstrong's own workbook
  // formula (=D{row}*1.15, asserted cell by cell at extract time), and the
  // percentage is what is stored, so the $44.13 below is produced by the
  // resolver and not seeded.
  // ------------------------------------------------------------------
  console.log("\n--- roll goods: the cut rate comes off the percentage ---");
  const accolade = await rowFor(supplier.id, "Accolade Plus", "Alpine White");
  console.log(
    `Accolade Plus "${accolade.colour}": costPrice ${money(accolade.costPrice!)}, cutUpliftPct ${accolade.cutUpliftPct}%, cutCostPrice ${accolade.cutCostPrice}, roll ${accolade.rollM2} m2 @ ${accolade.widthM}m wide`,
  );
  check("full-roll rate as printed", accolade.costPrice!, 38.37);
  check("sell price off the roll rate", accolade.sellPrice!, 73.33);
  ok("the cut rate is held as a percentage, not a second dollar price", accolade.cutCostPrice === null);
  ok("a roll good carries no pallet break", accolade.volumeCostPrice === null && accolade.volumeQty === null);

  // A part roll: 20 m2 out of a 36.6 m2 roll.
  const cut20 = resolveRollCut(accolade, 20);
  ok("20 m2 is a cut, not a roll", !cut20.onRollRate);
  check("20 m2 cut rate, derived from +15%", cut20.cutRateExGst!, 44.13);
  check("20 m2 rate charged", cut20.rateExGst!, 44.13);
  check("20 m2 cost", cut20.costExGst!, 882.6);
  check("20 m2 cut premium per m2", cut20.cutPremiumPerUnit, 5.76);
  check("20 m2 cut premium on the line", cut20.cutPremiumTotal, 115.2);
  // The cut premium is real money out the door on THIS order, so unlike a
  // special it passes through to the customer.
  check("20 m2 sell per m2 follows the cut rate", cut20.sellPerUnitExGst!, 84.33);
  check("20 m2 sell ex GST", cut20.sellExGst!, 1686.6);
  check("20 m2 sell inc GST", cut20.sellIncGst!, 1855.26);
  console.log(`      ${cut20.note}`);

  // A whole roll: no premium, and the roll rate is the printed rate.
  const roll = resolveRollCut(accolade, 36.6);
  ok("36.6 m2 is one full roll", roll.onRollRate && roll.fullRolls === 1 && roll.remainder === 0);
  check("full roll rate", roll.rateExGst!, 38.37);
  check("full roll cost", roll.costExGst!, 1404.34);
  check("full roll carries no cut premium", roll.cutPremiumTotal, 0);
  check("a 36.6 m2 roll is 20 lineal metres at 1.83m wide", roll.qtyLm!, 20);
  console.log(`      ${roll.note}`);

  // Past a roll, the WHOLE quantity drops to the roll rate: the offcut is not
  // charged a premium.
  const over = resolveRollCut(accolade, 40);
  check("40 m2 bills entirely at the roll rate", over.rateExGst!, 38.37);
  check("40 m2 cost", over.costExGst!, 1534.8);
  check("40 m2 cut premium", over.cutPremiumTotal, 0);

  // ------------------------------------------------------------------
  // THE FALSE ECONOMY. Above the break-even quantity a cut costs more than the
  // whole roll, and the offcut is free stock. This is the number the office
  // needs when a job measures up just under a roll.
  // ------------------------------------------------------------------
  console.log("\n--- the cut/roll cliff on Accolade Plus ---");
  check("a roll only pays for itself above", cut20.breakEvenQty!, 31.82);
  const at31 = resolveRollCut(accolade, 31);
  const at32 = resolveRollCut(accolade, 32);
  check("31 m2 cut", at31.costExGst!, 1368.03);
  check("32 m2 cut", at32.costExGst!, 1412.16);
  ok("31 m2 is still cheaper cut than a whole roll", at31.betterAsFullRoll === null);
  const better = at32.betterAsFullRoll;
  if (!better) throw new Error("expected 32 m2 to be flagged as better bought as a whole roll");
  check("whole roll instead of 32 m2 cut", better.costExGst, 1404.34);
  check("what taking the whole roll saves", better.savingExGst, 7.82);
  check("free offcut left over", better.spareQty, 4.6);
  check("free offcut in lineal metres", better.spareLm!, 2.51);
  ok("ordering the whole roll beats 32 m2 cut", better.costExGst < at32.costExGst!);
  console.log(`      ${at32.note}`);

  // The percentage applies to every roll range at its own rate, so spot-check
  // the safety vinyl and the wall cladding.
  console.log("\n--- the same percentage, other roll ranges ---");
  const safeguard = await rowFor(supplier.id, "Safeguard R10", "Light Grey");
  check("Safeguard R10 roll rate", safeguard.costPrice!, 26.78);
  check("Safeguard R10 cut rate off +15%", resolveRollCut(safeguard, 10).rateExGst!, 30.8);
  check("Safeguard R10 full 40 m2 roll", resolveRollCut(safeguard, 40).costExGst!, 1071.2);

  // Slip rating is priced, so it is chosen before the price and not after.
  const r11 = await rowFor(supplier.id, "Safeguard R11", "Dune");
  const r12rows = all.filter((r) => r.range === "Safeguard R12");
  check("Safeguard R11 roll rate", r11.costPrice!, 29.57);
  ok("R11 and R12 are the same rate, dearer than R10", r12rows.every((r) => r.costPrice === 29.57));
  ok("R11 and R12 cost more than R10", 29.57 > safeguard.costPrice!);

  // SAFEGUARD'S "2mm / 1.50" IS A GRIP TEXTURE, NOT TWO GAUGES. The first
  // import left the gauge blank as ambiguous. It is 2mm with a raised
  // slip-resistant surface, and the prose must say so on every Safeguard row.
  const sgRows = all.filter((r) => r.range.startsWith("Safeguard"));
  check("Safeguard rows", sgRows.length, 18);
  ok("every Safeguard row is 2mm gauge", sgRows.every((r) => r.size.startsWith("2mm;")));
  ok("and every one explains the grip texture", sgRows.every((r) => /grip/i.test(r.notes ?? "")));

  // Ranges marketed as safety but carrying no printed R-number must not borrow
  // a rating off a sibling range.
  const unrated = all.filter((r) => /^(Accolade Foothold|Accolade Safe|Natralis Foothold)$/.test(r.range));
  ok("the unrated safety ranges are seeded", unrated.length > 0);
  ok("and none of them claims an R rating", unrated.every((r) => !/\bR1[012]\b/.test(`${r.size} ${r.fitsRange ?? ""}`)));

  const wallflex = await rowFor(supplier.id, "Wallflex", "Ice White");
  ok("Wallflex is flagged as wall cladding, not flooring", /WALL CLADDING/.test(wallflex.fitsRange ?? ""));
  check("Wallflex roll rate", wallflex.costPrice!, 22.38);
  check("Wallflex cut rate off +15%", resolveRollCut(wallflex, 10).rateExGst!, 25.74);

  // Armalon NG Colours prints two roll widths and does not say which colour
  // comes on which, so the width is deliberately null and no lineal-metre
  // figure may be conjured from it. STILL OPEN WITH ARMSTRONG.
  const armalon = await rowFor(supplier.id, "Armalon NG - Colours", "Coconut");
  ok("Armalon NG Colours has no roll width recorded, the source prints two", armalon.widthM === null);
  ok("so no lineal metres are invented for it", resolveRollCut(armalon, 20).qtyLm === null);
  check("Armalon NG Colours still prices per m2", resolveRollCut(armalon, 20).rateExGst!, 16.55);
  check("and both printed widths give the same 36.6 m2 roll", armalon.rollM2!, 36.6);
  ok("the open width question is written on the row", /width/i.test(armalon.notes ?? ""));

  // Armalon NG Black is a 1.20m roll where the rest of the sheet vinyl is
  // 1.83m. Not ambiguous, just unusual enough to get wrong.
  const black = await rowFor(supplier.id, "Armalon NG - Black", "Black Storm");
  check("Armalon NG Black roll width", black.widthM!, 1.2);
  check("Armalon NG Black roll m2", black.rollM2!, 24);

  // ------------------------------------------------------------------
  // 3. THE PALLET BREAK, NOW LIVE.
  //
  // The corrected list prints a threshold on every pallet row, so the break
  // fires by itself. costPrice is the STANDARD rate, which is what a normal
  // order pays; the pallet rate is the discount on top of it.
  //
  // Chesterfield is also the one price on this supplier that is NOT the
  // printed one: the workbook says $12.75/m2 on a pallet, Damien confirmed
  // $12.95 with Armstrong, and Damien's number is what is seeded.
  // ------------------------------------------------------------------
  console.log("\n--- the pallet break fires at Armstrong's printed threshold ---");
  const chesterfield = await rowFor(supplier.id, "Chesterfield", "Java Oak");
  console.log(
    `Chesterfield "${chesterfield.colour}": costPrice ${money(chesterfield.costPrice!)} standard, volumeCostPrice ${money(chesterfield.volumeCostPrice!)} pallet from ${chesterfield.volumeQty} m2`,
  );
  check("standard rate, what a normal order pays", chesterfield.costPrice!, 14.95);
  check("pallet rate, the $12.95 Damien confirmed and not the $12.75 printed", chesterfield.volumeCostPrice!, 12.95);
  check("pallet threshold, exactly as printed", chesterfield.volumeQty!, 314.3);
  ok("the pallet rate is the cheaper of the two", chesterfield.volumeCostPrice! < chesterfield.costPrice!);
  ok("THE OVERRIDE IS WRITTEN ON EVERY CHESTERFIELD ROW", all.filter((r) => r.range === "Chesterfield").every((r) => /OVERRID/i.test(r.notes ?? "")));
  // A pallet is an order-size question, never a cut, so it must not have
  // picked up the roll uplift.
  ok("a pallet break is not a cut, so no uplift on the row", chesterfield.cutUpliftPct === null);
  check("cartons per pallet", chesterfield.boxesPerPallet!, 70);

  for (const qty of [10, 100, 300]) {
    const q = resolveRollCut(chesterfield, qty);
    check(`${qty} m2 bills at the standard rate, under the break`, q.rateExGst!, 14.95);
    ok(`${qty} m2 has not reached the pallet rate`, !q.onVolumeRate);
  }
  check("100 m2 of Chesterfield", resolveRollCut(chesterfield, 100).costExGst!, 1495);

  // Just under the break, the office must be told to push it over.
  const at300 = resolveRollCut(chesterfield, 300);
  const push = at300.betterAtVolume;
  if (!push) throw new Error("expected 300 m2 to be flagged as better pushed to a pallet");
  check("a pallet instead of 300 m2", push.costExGst, 4070.19);
  check("what pushing it to a pallet saves", push.savingExGst, 414.81);
  check("spare m2 left over on the pallet", push.spareQty, 14.3);
  console.log(`      ${at300.note}`);

  // At and over the break, the WHOLE quantity drops to the pallet rate.
  const pallet = resolveRollCut(chesterfield, 314.3);
  ok("314.3 m2 reaches the pallet rate", pallet.onVolumeRate);
  check("314.3 m2 bills at the pallet rate", pallet.rateExGst!, 12.95);
  check("a full pallet of Chesterfield", pallet.costExGst!, 4070.19);
  check("what the pallet saves on that order", pallet.volumeSavingTotal, 628.6);
  check("sell per m2 follows the pallet rate down", pallet.sellPerUnitExGst!, 24.75);
  console.log(`      ${pallet.note}`);
  const over400 = resolveRollCut(chesterfield, 400);
  check("400 m2 stays on the pallet rate", over400.rateExGst!, 12.95);
  check("400 m2 cost", over400.costExGst!, 5180);

  // The dealer ranges are the highest-value finding on this supplier: the
  // list's own notes sheet confirms dealer prices are Terra's cost.
  console.log("\n--- dealer rates, confirmed by the list's own notes sheet ---");
  const longplank = await rowFor(supplier.id, "Natural Creations Longplank", "Blanc Oak");
  check("Longplank dealer standard rate", longplank.costPrice!, 30.35);
  check("Longplank dealer pallet rate", longplank.volumeCostPrice!, 27.2);
  check("Longplank pallet threshold", longplank.volumeQty!, 122.1);
  const lpPallet = resolveRollCut(longplank, 122.1);
  check("a full pallet of Longplank", lpPallet.costExGst!, 3321.12);
  check("what it saves", lpPallet.volumeSavingTotal, 384.62);
  ok("the dealer basis is written on the row", /dealer/i.test(longplank.notes ?? ""));

  // Natural Creations print the threshold PER COLOUR AND SIZE, not once per
  // range, so the same colour at two tile sizes must carry two thresholds.
  console.log("\n--- per-variant thresholds: the same colour at two tile sizes ---");
  const small457 = await rowForSize(supplier.id, "Natural Creations EarthCuts (Standard)", "Concrete", "2.5mm; 457 x 457mm");
  const small610 = await rowForSize(supplier.id, "Natural Creations EarthCuts (Standard)", "Concrete", "2.5mm; 610 x 305mm");
  check("EarthCuts Concrete 457 x 457mm threshold", small457.volumeQty!, 213.76);
  check("EarthCuts Concrete 610 x 305mm threshold", small610.volumeQty!, 225.72);
  ok("two different thresholds on one colour, which is why size is in the key", small457.volumeQty !== small610.volumeQty);
  ok("same rate on both sizes", small457.costPrice === small610.costPrice && small457.volumeCostPrice === small610.volumeCostPrice);

  // THE THRESHOLD IS NEVER ROUNDED TO A WHOLE CARTON. Two variants do not
  // divide cleanly, so they carry no carton-per-pallet figure rather than a
  // tidied-up one. Worth confirming the pallet make-up with Armstrong.
  const inexact = all.filter((r) => r.bulkKind === "pack" && r.boxesPerPallet === null);
  check("pack rows with no carton-per-pallet figure", inexact.length, 15);
  ok(
    "and they are only the two variants whose pallet is not a whole number of cartons",
    new Set(inexact.map((r) => `${r.range} @ ${r.size}`)).size === 2,
  );
  ok("every one of them says why", inexact.every((r) => /pallet/i.test(r.notes ?? "")));
  const aspirations = await rowFor(supplier.id, "Aspirations", "Chardonnay Oak");
  check("Aspirations pallet threshold, printed not rounded", aspirations.volumeQty!, 145.6);
  check("Aspirations printed pack m2", aspirations.packM2Printed!, 2.245);
  ok("no carton-per-pallet figure invented for it", aspirations.boxesPerPallet === null);

  // A part carton must NOT be charged a loose premium Armstrong never
  // published, and carton goods must not convert to lineal metres.
  const geologic = await rowFor(supplier.id, "Geologic", "Sterling");
  const partCarton = resolveRollCut(geologic, 3);
  check("Geologic standard rate", geologic.costPrice!, 20.85);
  check("3 m2, less than one 5 m2 carton, no invented loose premium", partCarton.rateExGst!, 20.85);
  check("3 m2 of Geologic", partCarton.costExGst!, 62.55);
  check("and no premium on the line", partCarton.cutPremiumTotal, 0);
  ok("carton goods do not convert to lineal metres", partCarton.qtyLm === null);
  check("a full Geologic pallet at 180 m2", resolveRollCut(geologic, 180).rateExGst!, 18.95);

  // ------------------------------------------------------------------
  // 4. EXCELON VCT: NO PALLET DISCOUNT, AND THAT IS A FINDING.
  //
  // Armstrong print $17.28/m2 above and below the 239.76 m2 pallet, so the
  // quantity is for ordering and carton counting only. Announcing a saving of
  // zero dollars would be worse than saying nothing.
  // ------------------------------------------------------------------
  console.log("\n--- Excelon VCT: one rate either side of the pallet ---");
  const excelon = await rowFor(supplier.id, "Excelon VCT", "Mitchell");
  const excelonRows = all.filter((r) => r.range === "Excelon VCT");
  check("Excelon rows", excelonRows.length, 5);
  check("Excelon rate", excelon.costPrice!, 17.28);
  ok("no volume rate seeded on any Excelon row", excelonRows.every((r) => r.volumeCostPrice === null && r.volumeQty === null));
  ok("and no cut uplift either, it is a tile", excelonRows.every((r) => r.cutUpliftPct === null));
  ok("the no-discount finding is written on the row", /no.*discount|same rate|no break/i.test(excelon.notes ?? ""));
  const ex1 = resolveRollCut(excelon, 1);
  const ex1000 = resolveRollCut(excelon, 1000);
  check("1 m2 rate", ex1.rateExGst!, 17.28);
  check("1,000 m2 rate is the same", ex1000.rateExGst!, 17.28);
  check("1,000 m2 cost", ex1000.costExGst!, 17280);
  ok("no volume rate offered at any quantity", ex1.volumeRateExGst === null && ex1000.volumeRateExGst === null);
  ok("no saving claimed", ex1000.volumeSavingTotal === 0);
  ok("no push-to-a-pallet advice on a flat rate", ex1.betterAtVolume === null && ex1000.betterAtVolume === null);
  ok("no cut rate offered on a tile", ex1.cutRateExGst === null && ex1000.cutRateExGst === null);
  console.log(`      ${ex1000.note}`);

  // ------------------------------------------------------------------
  // 5. FREIGHT: ONE FLAT $150 AN ORDER, CONFIRMED BY DAMIEN.
  //
  // The first import had to leave the freight position UNKNOWN, because that
  // workbook published nothing about freight at all. Armstrong deliver to
  // Terra's warehouse for a flat $150 ex GST an order, inclusive of all fees,
  // so it lands once an order and never per line.
  // ------------------------------------------------------------------
  console.log("\n--- freight: $150 flat an order, delivered to the warehouse ---");
  ok("Armstrong deliver to Terra", supplier.deliversDirect === true);
  check("charge rules on file", rules.length, 1);
  const fee = rules[0];
  ok("the one rule is a delivery", fee.kind === "delivery");
  ok("charged per order, not per line and not per roll", fee.basis === "order");
  check("the amount", fee.amount!, 150);
  ok("ex GST, as every rate on this supplier is", fee.amountIncludesGst === false);
  ok("auto-applied, because Armstrong charge it on every order", fee.autoApply === true);
  ok("no fuel surcharge, unlike Tarkett's 2.1% and Chaparral's $2/lm", supplier.fuelSurchargeActive === false);

  const order = resolveRollCut(accolade, 100);
  const quote = resolveSupplierCharges(supplier, rules, {
    goodsExGst: order.costExGst!,
    m2: 100,
    lm: lmForQty(100, accolade.unit, accolade.widthM) ?? 0,
    rolls: 3,
    pallets: 1,
    shipments: 1,
  });
  check("100 m2 of Accolade Plus, goods", quote.goodsExGst, 3837);
  check("freight on the order", quote.freightExGst, 150);
  check("surcharges", quote.surchargesExGst, 0);
  check("packing", quote.packingExGst, 0);
  check("other", quote.otherExGst, 0);
  check("credits", quote.creditsExGst, 0);
  check("true material cost, goods plus the flat delivery", quote.totalExGst, 3987);
  check("one charge on the order", quote.charges.length, 1);
  check("and it is the $150", quote.charges[0].exGst, 150);
  ok("nothing was excluded", quote.excluded.length === 0);
  console.log(`      ${quote.note}`);

  // THE FEE IS PER ORDER, SO A BIGGER ORDER DOES NOT PAY MORE FREIGHT. This is
  // the difference between Armstrong's $150 and Polyflor's $20 a bale.
  const bigger = resolveSupplierCharges(supplier, rules, {
    goodsExGst: 40000,
    m2: 1000,
    lm: 546,
    rolls: 28,
    pallets: 7,
    shipments: 1,
  });
  check("a $40,000 order still pays $150 freight", bigger.freightExGst, 150);
  check("and totals goods plus $150", bigger.totalExGst, 40150);

  // "Inclusive of all fees" is Damien's word, so nothing else may appear: no
  // baling, no split pallet, no futile delivery, no metro or country split.
  ok("no second fee has crept in", rules.length === 1);
  ok("the $150 and what it covers are written on the supplier", /150/.test(supplier.freightNote ?? "") && /inclusive of all fees/i.test(supplier.freightNote ?? ""));
  ok("the dealer-pricing question is recorded as ANSWERED", /answered/i.test(supplier.dealerPricingNote ?? ""));
  ok("the list's effective date is on the supplier row", supplier.priceListEffectiveFrom !== null);

  // ------------------------------------------------------------------
  // The unit helpers on an m2-priced roll good, which is what all 177 roll
  // rows are. An m2 quantity must stay m2 and convert UP to lm by dividing by
  // the width, the mirror of the lm-priced carpet case Chaparral pinned.
  // ------------------------------------------------------------------
  console.log("\n--- unit conversions on an m2-priced roll ---");
  check("roll width on the row", accolade.widthM!, 1.83);
  check("m2ForQty(36.6 m2) stays 36.6", m2ForQty(36.6, accolade.unit, accolade.widthM)!, 36.6);
  check("lmForQty(36.6 m2 @ 1.83m) is 20 lm", lmForQty(36.6, accolade.unit, accolade.widthM)!, 20);

  // ------------------------------------------------------------------
  // 6. TWO LAST SWEEPS ACROSS EVERY ROW.
  // ------------------------------------------------------------------
  console.log("\n--- sweeps across all 355 rows ---");

  // Every roll row must actually be able to price a cut. A roll rate with no
  // roll size is a cut premium that can never fire.
  const rollRows = await db
    .select()
    .from(s.products)
    .where(and(eq(s.products.supplierId, supplier.id), isNotNull(s.products.cutUpliftPct)));
  const unpriceable = rollRows.filter((r) => {
    const q = resolveRollCut(r, 1);
    return !r.rollM2 || q.cutRateExGst === null || q.cutRateExGst <= r.costPrice!;
  });
  ok(`all ${rollRows.length} roll rows price a cut dearer than a roll`, unpriceable.length === 0);
  if (unpriceable.length) console.log(`      offenders: ${unpriceable.map((r) => `${r.range} ${r.colour}`).join(", ")}`);

  // Every pallet row must actually reach its break, and must still bill the
  // standard rate one m2 under it.
  const volRows = all.filter((r) => r.volumeCostPrice !== null);
  const broken = volRows.filter((r) => {
    const atBreak = resolveRollCut(r, r.volumeQty!);
    const under = resolveRollCut(r, Math.max(1, r.volumeQty! - 1));
    return (
      !atBreak.onVolumeRate ||
      Math.abs(atBreak.rateExGst! - r.volumeCostPrice!) > 0.005 ||
      under.onVolumeRate ||
      Math.abs(under.rateExGst! - r.costPrice!) > 0.005
    );
  });
  ok(`all ${volRows.length} pallet rows fire at the printed threshold and not before`, broken.length === 0);
  if (broken.length) console.log(`      offenders: ${broken.map((r) => `${r.range} ${r.colour}`).join(", ")}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
