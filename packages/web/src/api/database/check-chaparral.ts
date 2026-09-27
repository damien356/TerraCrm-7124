/**
 * Proves Damien's two worked examples against the real code path — not
 * arithmetic in a comment. Reads the seeded rows out of the database, runs
 * resolveRollCut to pick the cut/roll rate, then resolveSupplierCharges for
 * the fuel surcharge, and checks the totals.
 *
 *   15 lm Apartment 2 = 15 x $68.00 + 15 x $2.00 = $1,050.00
 *   25 lm Apartment 2 = 25 x $58.00 + 25 x $2.00 = $1,500.00
 *
 * Also checks the cliff (19 lm dearer than 20 lm) and that Chaparral's own
 * delivery charge cannot land in the cost.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-chaparral.ts
 */
import { and, eq } from "drizzle-orm";
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

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "chaparral"));
  if (!supplier) throw new Error("no Chaparral supplier row");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  console.log(
    `Chaparral: deliversDirect=${supplier.deliversDirect}, freight="${supplier.freightMethod}", ${rules.length} charge rules\n`,
  );

  const [product] = await db
    .select()
    .from(s.products)
    .where(and(eq(s.products.supplierId, supplier.id), eq(s.products.range, "Apartment 2")));
  if (!product) throw new Error("no Apartment 2 row");
  console.log(`${product.range} "${product.colour}": costPrice ${money(product.costPrice!)}, cutCostPrice ${money(product.cutCostPrice!)}, rollM2 ${product.rollM2}\n`);

  // Damien's two worked examples, which are GOODS + FUEL:
  //   15 lm = 15 x $68.00 + 15 x $2.00 = $1,050.00
  //   25 lm = 25 x $58.00 + 25 x $2.00 = $1,500.00
  // Those still hold exactly and are checked as goods and fuel separately.
  // The ALL-IN order cost is now $20.00 higher than each, because baling is a
  // flat per-order charge and therefore lands on every order. It used to be
  // modelled per roll, so with rolls: 0 it dropped out of the costing and the
  // all-in happened to equal his goods+fuel figure. That was the old basis
  // being wrong, not these examples.
  for (const [qty, wantRate, wantGoodsPlusFuel] of [
    [15, 68, 1050],
    [25, 58, 1500],
  ] as const) {
    const cut = resolveRollCut(product, qty);
    check(`${qty} lm rate chosen`, cut.rateExGst!, wantRate);
    const quote = resolveSupplierCharges(supplier, rules, { goodsExGst: cut.costExGst!, lm: qty, rolls: 0 });
    check(`${qty} lm goods`, quote.goodsExGst, wantRate * qty);
    check(`${qty} lm fuel surcharge`, quote.surchargesExGst, qty * 2);
    check(`${qty} lm goods + fuel (Damien's figure)`, quote.goodsExGst + quote.surchargesExGst, wantGoodsPlusFuel);
    check(`${qty} lm baling, flat, no roll count entered`, quote.packingExGst, 20);
    check(`${qty} lm TRUE MATERIAL COST incl baling`, quote.totalExGst, wantGoodsPlusFuel + 20);
    console.log(`      ${cut.note}`);
    console.log(`      ${quote.note}\n`);
  }

  // The cliff: 19 lm must cost more than 20 lm, fuel included.
  const at19 = resolveRollCut(product, 19);
  const at20 = resolveRollCut(product, 20);
  const c19 = resolveSupplierCharges(supplier, rules, { goodsExGst: at19.costExGst!, lm: 19, rolls: 1 });
  const c20 = resolveSupplierCharges(supplier, rules, { goodsExGst: at20.costExGst!, lm: 20, rolls: 1 });
  console.log(`19 lm all-in ${money(c19.totalExGst)} vs 20 lm all-in ${money(c20.totalExGst)}`);
  console.log(`${c20.totalExGst < c19.totalExGst ? "PASS" : "FAIL"}  ordering 20 lm is cheaper than 19 lm`);
  if (c20.totalExGst >= c19.totalExGst) failures += 1;

  // Baling on a 20 lm single roll, and the charges still separate.
  console.log(`\n20 lm with 1 roll: ${c20.charges.map((c) => `${c.name} ${money(c.exGst)}`).join(", ")}`);
  check("20 lm baling", c20.packingExGst, 20);
  check("20 lm supplier freight", c20.freightExGst, 0);

  // BALING IS PER ORDER, NOT PER ROLL. Damien's correction, and it overrides
  // the workbook's own "per roll" wording. $20.00 flat however many rolls ship,
  // and it must still bill when no roll count is entered at all — as a per-roll
  // charge it used to drop out of the costing entirely on rolls: 0.
  console.log("\n--- baling is flat per order ---");
  for (const rolls of [0, 1, 3, 10]) {
    const big = resolveRollCut(product, 100);
    const q = resolveSupplierCharges(supplier, rules, { goodsExGst: big.costExGst!, lm: 100, rolls });
    check(`100 lm with rolls=${rolls}, baling stays flat`, q.packingExGst, 20);
  }

  // Chaparral's own delivery charge must be impossible to apply. Tick it by
  // hand and it must still be refused, with a reason.
  const delivery = rules.find((r) => r.kind === "delivery");
  if (!delivery) throw new Error("expected the reference-only delivery rule on file");
  const forced = resolveSupplierCharges(supplier, rules, { goodsExGst: 1160, lm: 20, rolls: 1 }, {
    pickedIds: [delivery.id],
  });
  const blocked = forced.excluded.some((e) => e.id === delivery.id);
  console.log(`\n${blocked ? "PASS" : "FAIL"}  Chaparral delivery charge refused even when ticked by hand`);
  if (!blocked) failures += 1;
  else console.log(`      ${forced.excluded.find((e) => e.id === delivery.id)!.reason}`);
  check("forced-delivery freight total", forced.freightExGst, 0);

  // ------------------------------------------------------------------
  // ROLL WIDTH AND THE lm/m2 UNIT BUG IT EXPOSED.
  //
  // 3.60 m is Damien's figure, not the workbook's, so it is pinned here: if
  // anyone re-imports the list and the width goes back to null, these fail
  // loudly instead of silently returning null again.
  //
  // The bug this guards: `lmFromM2(qty, widthM)` was being called on the raw
  // order quantity, but for an lm-priced product the quantity ALREADY IS
  // lineal metres. 20 lm was becoming 20 / 3.6 = 5.56. It went unnoticed for
  // as long as it did because every lm-priced supplier in the book had a null
  // width, so the broken path always returned null and never produced a
  // visibly wrong number.
  // ------------------------------------------------------------------
  console.log("\n--- roll width and lm/m2 conversion ---");
  check("roll width on the product row", product.widthM!, 3.6);
  console.log(`${product.unit === "lm" ? "PASS" : "FAIL"}  priced per lineal metre (unit=${product.unit})`);
  if (product.unit !== "lm") failures += 1;

  // The direct regression: an lm quantity must survive unchanged, and convert
  // to area by MULTIPLYING by the width.
  check("lmForQty(20 lm) stays 20 lm, not 5.56", lmForQty(20, product.unit, product.widthM)!, 20);
  check("m2ForQty(20 lm) covers 72 m2", m2ForQty(20, product.unit, product.widthM)!, 72);

  // The mirror case must not have been broken by the fix: a genuinely
  // m2-priced product still converts its quantity DOWN to lm.
  check("lmForQty(72 m2 @ 3.6m) is 20 lm", lmForQty(72, "m2", 3.6)!, 20);
  check("m2ForQty(72 m2) stays 72 m2", m2ForQty(72, "m2", 3.6)!, 72);

  // And through the real pricing path, not just the helper.
  check("resolveRollCut(20 lm).qtyLm is 20", at20.qtyLm!, 20);
  check("resolveRollCut(19 lm).qtyLm is 19", at19.qtyLm!, 19);
  const spare = at19.betterAsFullRoll;
  if (!spare) throw new Error("expected 19 lm to be flagged as better bought as a full roll");
  check("19 lm full-roll spare is 1 lm", spare.spareLm!, 1);
  console.log(`      ${at19.note}`);

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
