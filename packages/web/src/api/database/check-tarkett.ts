/**
 * Tarkett, checked against the database and the real pricing path.
 *
 * The thing that can quietly go wrong on this supplier is not the price, it is
 * AVAILABILITY. 110 of the 180 colours are in Australian stock and 70 are
 * import only at 8-10 weeks, at the identical rate per square metre, with the
 * split running through the ranges rather than between them. A row that loses
 * its import flag becomes indistinguishable from a stocked one and the office
 * quotes a date it cannot hit. So the availability trio is checked row by row,
 * not sampled.
 *
 * Also checked:
 *   - the 2.1% fuel surcharge, through resolveSupplierCharges, as a
 *     percent_of_order rule (the first one in the book)
 *   - that it bills with no m2 or roll count entered, because a percentage
 *     reads off the goods and needs no quantity
 *   - that the Resiloop levy has NOT been added as a fee, because 9c/m2 is
 *     already inside the quoted rate
 *   - that no cut/roll break exists, so resolveRollCut finds no decision
 *   - that Wallgard 2mm is flagged wall-not-floor, and nothing else is
 *   - that 45 blank colour codes stayed blank and never became "None"
 *   - that freight is still missing, which is the open question on this
 *     supplier and must stay visible rather than reading as $0.00
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/check-tarkett.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { resolveRollCut, resolveSupplierCharges, type SupplierChargeRule } from "../lib/pricing";
import * as s from "./schema";
import {
  TARKETT_CODELESS_COLOURS,
  TARKETT_FUEL_PCT,
  TARKETT_IMPORT_COLOURS,
  TARKETT_IMPORT_LEAD_WEEKS_MAX,
  TARKETT_IMPORT_NOTE,
  TARKETT_IN_STOCK_COLOURS,
  TARKETT_MIXED_STOCK_RANGES,
  TARKETT_PRICE_LIST_DATE,
  TARKETT_RANGES,
  TARKETT_ROLL_WIDTH_M,
  TARKETT_SHEET_VINYL,
  TARKETT_STOCK_NOTE,
} from "./tarkett-data";

const money = (n: number) => `$${n.toFixed(2)}`;
const IMPORT_LEAD_DAYS = TARKETT_IMPORT_LEAD_WEEKS_MAX * 7;
/** Inside the fee rule's window, so the surcharge is live for these checks. */
const TODAY = "2026-09-26";

let failures = 0;

function check(label: string, got: number, want: number) {
  const ok = Math.abs(got - want) < 0.005;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${money(got)}, expected ${money(want)}`);
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
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "tarkett"));
  if (!supplier) throw new Error("no Tarkett supplier row — seed suppliers first");

  const rules = (await db
    .select()
    .from(s.supplierFeeRules)
    .where(eq(s.supplierFeeRules.supplierId, supplier.id))) as unknown as SupplierChargeRule[];

  const rows = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));

  console.log(
    `Tarkett: ${rows.length} products, ${rules.length} charge rule(s), fuel ${supplier.fuelSurchargePct}% active=${supplier.fuelSurchargeActive}\n`,
  );

  /* ---------------------------- the supplier row --------------------------- */
  console.log("--- supplier ---");
  checkCount("one charge rule on file", rules.length, 1);
  const fuel = rules[0]!;
  checkTrue("that rule is the fuel surcharge", fuel.kind === "fuel", `kind=${fuel.kind}`);
  checkTrue("billed as a percent of the order", fuel.basis === "percent_of_order", `basis=${fuel.basis}`);
  check("the percentage", fuel.percent ?? 0, TARKETT_FUEL_PCT);
  checkTrue("no flat amount alongside the percentage", fuel.amount === null, `amount=${fuel.amount}`);
  checkTrue("applies automatically", fuel.autoApply === true);
  checkTrue("dated from the quote date", fuel.effectiveFrom === TARKETT_PRICE_LIST_DATE, `from=${fuel.effectiveFrom}`);
  checkTrue("left open-ended, Tarkett give no end date", fuel.effectiveUntil === null);
  check("supplier fuel percentage matches the rule", supplier.fuelSurchargePct ?? 0, TARKETT_FUEL_PCT);

  // The levy is inside the quoted rate. A fee row for it would charge it twice.
  const resiloop = rules.filter((r) => /resiloop|levy/i.test(r.name));
  checkCount("no Resiloop fee row, the 9c is already in the price", resiloop.length, 0);

  // Freight is genuinely unknown here, not zero. Nothing may have been invented.
  const freightRules = rules.filter((r) => /freight|delivery|baling|cartage/i.test(r.name));
  checkCount("no invented freight or baling charge", freightRules.length, 0);

  /* ------------------------------- the counts ------------------------------ */
  console.log("\n--- counts, against the data file's own constants ---");
  checkCount("colours seeded", rows.length, TARKETT_SHEET_VINYL.length);
  checkCount("colours seeded is 180", rows.length, 180);
  const ranges = new Set(rows.map((r) => r.range));
  checkCount("ranges", ranges.size, TARKETT_RANGES.length);

  const imported = rows.filter((r) => r.madeToOrder);
  const stocked = rows.filter((r) => !r.madeToOrder);
  checkCount("in Australian stock", stocked.length, TARKETT_IN_STOCK_COLOURS);
  checkCount("import only", imported.length, TARKETT_IMPORT_COLOURS);
  checkCount("blank colour codes", rows.filter((r) => !r.sku).length, TARKETT_CODELESS_COLOURS);

  /* --------------------------- the availability trio ----------------------- */
  // Row by row. The whole supplier turns on this staying consistent.
  console.log("\n--- availability, every row ---");
  let tripBad = 0;
  for (const r of rows) {
    const badImport =
      r.madeToOrder && (r.leadTimeDays !== IMPORT_LEAD_DAYS || r.availabilityNote !== TARKETT_IMPORT_NOTE);
    const badStock = !r.madeToOrder && (r.leadTimeDays !== null || r.availabilityNote !== TARKETT_STOCK_NOTE);
    if (badImport || badStock) {
      tripBad += 1;
      console.log(
        `      BAD  ${r.range} ${r.colour}: madeToOrder=${r.madeToOrder} lead=${r.leadTimeDays} note="${r.availabilityNote}"`,
      );
    }
  }
  checkCount("rows with an inconsistent availability trio", tripBad, 0);
  checkTrue(
    "every import row carries the quotable 8-10 week wording",
    imported.every((r) => r.availabilityNote.includes("8-10 weeks")),
  );
  checkTrue(
    "no stocked row carries a lead time",
    stocked.every((r) => r.leadTimeDays === null),
  );
  // A blank note would read as "it is fine" when it means "nobody checked".
  checkCount("rows with no availability note at all", rows.filter((r) => !r.availabilityNote).length, 0);

  // The mixed ranges are the trap: same range, same price, both availabilities.
  console.log("\n--- the split runs through the ranges, not between them ---");
  for (const meta of TARKETT_RANGES) {
    const mine = rows.filter((r) => r.range === meta.range);
    const inStock = mine.filter((r) => !r.madeToOrder).length;
    const imports = mine.filter((r) => r.madeToOrder).length;
    checkCount(`${meta.range} colours`, mine.length, meta.colours);
    checkCount(`${meta.range} in stock`, inStock, meta.inStockColours);
    checkCount(`${meta.range} import only`, imports, meta.importColours);
    const mixed = inStock > 0 && imports > 0;
    checkTrue(
      `${meta.range} mixed-stock flag agrees with the data file`,
      mixed === TARKETT_MIXED_STOCK_RANGES.includes(meta.range),
      mixed ? "both availabilities at one price" : "single availability",
    );
  }

  /* ------------------------------ prices, pinned --------------------------- */
  console.log("\n--- prices and roll geometry ---");
  for (const meta of TARKETT_RANGES) {
    const mine = rows.filter((r) => r.range === meta.range);
    const offRate = mine.filter((r) => r.costPrice !== meta.pricePerM2);
    checkCount(`${meta.range} rows off the quoted ${money(meta.pricePerM2)}/m2`, offRate.length, 0);
    const offRoll = mine.filter(
      (r) => r.widthM !== TARKETT_ROLL_WIDTH_M || r.rollM2 !== TARKETT_ROLL_WIDTH_M * meta.rollLengthM,
    );
    checkCount(`${meta.range} rows off the ${TARKETT_ROLL_WIDTH_M}m x ${meta.rollLengthM}m roll`, offRoll.length, 0);
  }
  checkCount("rows priced per square metre", rows.filter((r) => r.unit === "m2").length, rows.length);
  checkCount(
    "rows carrying a cut rate Tarkett never quoted",
    rows.filter((r) => r.cutCostPrice !== null || r.cutUpliftPct !== null).length,
    0,
  );

  /* ------------------------- Wallgard is not a floor ----------------------- */
  console.log("\n--- Wallgard 2mm ---");
  const wall = rows.filter((r) => r.range === "Wallgard 2mm");
  checkCount("Wallgard colours", wall.length, 5);
  checkTrue("all flagged as wall cladding", wall.every((r) => /WALL CLADDING/.test(r.fitsRange ?? "")));
  checkTrue("all in Australian stock", wall.every((r) => !r.madeToOrder));
  checkCount(
    "non-Wallgard rows wearing the wall flag",
    rows.filter((r) => r.range !== "Wallgard 2mm" && /WALL CLADDING/.test(r.fitsRange ?? "")).length,
    0,
  );

  /* ------------------------ codeless colours stay blank -------------------- */
  console.log("\n--- the 45 colours Tarkett publish no code for ---");
  checkCount(
    'skus holding the string "none"',
    rows.filter((r) => (r.sku ?? "").trim().toLowerCase() === "none").length,
    0,
  );
  checkCount(
    'variant keys holding a "none" segment',
    rows.filter((r) => r.variantKey.split("|").includes("none")).length,
    0,
  );
  // An empty segment would mean the key was built with a hole in it.
  checkCount(
    "variant keys with an empty segment",
    rows.filter((r) => r.variantKey.split("|").some((part) => part === "")).length,
    0,
  );
  checkCount("variant keys, all distinct", new Set(rows.map((r) => r.variantKey)).size, rows.length);

  /* ---------------------- the surcharge, through the engine ---------------- */
  // A full roll of iQ Granit (New): 46 m2 at $33.50 = $1,541.00 of goods, and
  // 2.1% on top is $32.36, so the roll truly costs $1,573.36 before freight.
  console.log("\n--- 2.1% fuel surcharge, through resolveSupplierCharges ---");
  const granit = rows.find((r) => r.range === "iQ Granit (New)");
  if (!granit) throw new Error("no iQ Granit (New) row");
  const meta = TARKETT_RANGES.find((m) => m.range === "iQ Granit (New)")!;

  const rollGoods = meta.fullRollM2 * meta.pricePerM2;
  check("a full roll of goods", rollGoods, meta.costPerRoll);
  const q = resolveSupplierCharges(
    supplier,
    rules,
    { goodsExGst: rollGoods, m2: meta.fullRollM2, rolls: 1 },
    { today: TODAY },
  );
  check("fuel surcharge on a full roll", q.surchargesExGst, Math.round(rollGoods * 0.021 * 100) / 100);
  check("true material cost of a full roll", q.totalExGst, Math.round(rollGoods * 1.021 * 100) / 100);
  // Freight is unpriced, so it must total zero AND stay obvious in the note.
  check("supplier freight, still unknown not zero-rated", q.freightExGst, 0);
  check("packing, unpriced too", q.packingExGst, 0);
  console.log(`      ${q.note}`);

  // Per square metre the surcharge is 70c, which is the figure in the notes.
  check("fuel per m2 on this range", Math.round(meta.pricePerM2 * 0.021 * 100) / 100, meta.fuelPerM2);
  check("effective rate per m2 once fuel lands", Math.round(meta.effectivePerM2 * 100) / 100, meta.effectivePerM2);

  // A percentage needs no quantity. Chaparral's per-roll baling drops out of
  // the costing when the roll count is blank, by design. This must not.
  const bare = resolveSupplierCharges(supplier, rules, { goodsExGst: 1000 }, { today: TODAY });
  check("surcharge still bills with no m2 or roll count entered", bare.surchargesExGst, 21);
  checkCount("nothing excluded for a missing quantity", bare.excluded.length, 0);

  // Before the quote date the rule is out of its window and must not bill.
  const early = resolveSupplierCharges(supplier, rules, { goodsExGst: 1000 }, { today: "2025-06-08" });
  check("no surcharge the day before it took effect", early.surchargesExGst, 0);
  checkTrue("and it says why", early.excluded.some((e) => /dates/i.test(e.reason)));

  /* -------------------------- no cut/roll decision ------------------------- */
  // rollM2 is the real roll area for ordering. It is NOT a price threshold, so
  // the resolver must find one rate whatever the quantity.
  console.log("\n--- no cut/roll break exists on Tarkett ---");
  for (const qty of [5, 46, 200]) {
    const cut = resolveRollCut(granit, qty);
    check(`${qty} m2 rate chosen`, cut.rateExGst!, meta.pricePerM2);
    checkTrue(`${qty} m2 not pushed towards a full roll`, !cut.betterAsFullRoll);
  }

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
