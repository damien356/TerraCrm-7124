/**
 * Hurford's engineered timber flooring into the price book — 163 colour/length
 * rows across 17 ranges, plus 5 Genuine Oak nosings and mitres and 2 foam
 * underlays. Every flooring rate is per m2 ex GST.
 *
 * This is Hurford's SECOND list. The 8 plywood rows seeded by
 * seed-products-hurfords.ts stay exactly as they are; this adds the flooring
 * line the supplier note used to flag as still open, and answers its question:
 * it prices per m2, not per lineal metre.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: the list publishes standing rates.
 *
 * Six things this supplier does that the seed has to respect:
 *
 * 1. THE $80 IS A BROKEN PACK FEE, ONCE AN ORDER, AND IT IS NOT ON ANY PRODUCT
 *    ROW. DELIVERY TO NERANG IS FREE. The workbook prints an $80 "Job Lot Fee"
 *    against all 163 rows and then describes it two incompatible ways in the
 *    one rule: once per order, AND per product short of a full pallet. On a
 *    three-line short order the second reading bills $240. Damien settled it:
 *    Hurford's charge the $80 when the order does not make a full pallet, and
 *    they deliver to the warehouse for nothing with no minimum. This CORRECTS
 *    an earlier reading of the same $80 as a flat delivery charge on every
 *    order, so an all-full-pallet order now carries nothing where it used to
 *    carry $80. It is one $80 on the order however many lines are short, and a
 *    full-pallet line does not escape it when it shares an order with a short
 *    line, because the test is whether the ORDER makes a pallet. It is a
 *    handling fee rule on the supplier. Putting it in `costPrice` or seeding it
 *    per row would charge it two to three times.
 *
 * 2. ONE RATE FOR EVERY QUANTITY. The rate column is headed "Pallet Price
 *    $/m2", which reads like the cheaper half of a pallet/broken-pallet pair,
 *    but no second rate is printed and none was confirmed. So `cutCostPrice`,
 *    `cutUpliftPct`, `rollM2`, `volumeCostPrice` and `volumeQty` all stay null.
 *    This is the OPPOSITE shape to Hurford's own plywood, which genuinely has a
 *    pack rate and a higher loose rate resolved by resolveRollCut(). Copying
 *    the plywood treatment onto the flooring would invent a discount.
 *
 * 3. A COLOUR IN TWO BOARD LENGTHS IS TWO PRODUCTS. 21 manufacturer codes end
 *    "+" and cover both 1830mm and 2190mm at the same rate per m2 but different
 *    m2 a box, so box and pallet maths differ. Each length is its own row, the
 *    length is in the variant key, and the workbook's -1830/-2190 SKU suffix is
 *    kept as the product code. The bare "+" code is not orderable on its own.
 *
 * 4. PACK QUANTITIES ARE THE DERIVED WHOLE-PIECE COUNT. 83 of 163 rows print a
 *    rounded box m2 (1.932 against a real 1.93248 for 8 boards of 132 x 1830).
 *    `unitsPerPack` x `unitM2` is the ordering figure and the printed one goes
 *    in `packM2Printed` for checking an invoice, same as Karndean.
 *
 * 5. HERRINGBONE AND CHEVRON ARE HANDED. 26 rows are one hand of a left/right
 *    pair and a job needs both, so each names its opposite number in `notes`.
 *
 * 6. NOTHING IS INVENTED WHERE THE LIST IS SILENT. No warranty, acoustic
 *    rating, janka, moisture content, lead time or stock position is printed.
 *    The lamella is printed on all but 4 First Floors rows, which stay null.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-hurfords-timber.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  HURFORDS_ACCESSORIES,
  HURFORDS_BROKEN_PACK_FEE_EX_GST,
  HURFORDS_TIMBER_AUDIT,
  HURFORDS_TIMBER_EFFECTIVE_DATE,
  HURFORDS_TIMBER_ROWS,
  HURFORDS_TIMBER_SOURCE,
  HURFORDS_UNDERLAY,
} from "./hurfords-timber-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The fee warning that goes on every row of this supplier. The rate is the
 * rate; the $80 lands once on the order, not per line, and only when the order
 * is short of a pallet. Delivery itself costs nothing.
 */
const BROKEN_PACK_NOTE =
  `DELIVERY TO US IS FREE, NO MINIMUM ORDER. What this rate excludes is the broken pack fee: ` +
  `${money(HURFORDS_BROKEN_PACK_FEE_EX_GST)} ex GST once on an order that does not make a full pallet, added ` +
  `by the charge engine off the supplier's fee rule. An order that is all full pallets carries nothing. The ` +
  `workbook's per-row "Job Lot Fee" column is that same ${money(HURFORDS_BROKEN_PACK_FEE_EX_GST)}, not a ` +
  `second charge and not one per short line, so it is not carried here.`;

/**
 * The second thing the rate excludes, and unlike the $80 it lands on EVERY
 * order regardless of pallets. Percent of goods, so it is worth more per m2 on
 * a dearer board. Seeded as a supplier fee rule, not into the rates, so this
 * note is the only place a quoter sees it on the product.
 */
const FUEL_NOTE =
  `A 2.21% FUEL SURCHARGE APPLIES FROM 23 SEP 2026 and it is not in this rate. Damien: "all orders", ` +
  `covering the flooring and the plywood alike, with no threshold and no end date. It is 2.21% of the goods ` +
  `ex GST, so it stacks with the broken pack fee without compounding on it.`;

const SPECS_NOTE =
  "NOT ON THIS PRICE LIST, so not recorded: warranty, acoustic rating, janka, moisture content, lead time and " +
  "stock position. Ask Hurford's if a customer needs them.";

function buildFloors(supplierId: number): ProductSeed[] {
  return HURFORDS_TIMBER_ROWS.map((r) => {
    /* Re-derive the board and box from the printed dimensions rather than
     * trusting the extractor, then cross-check the whole-piece count. */
    const boardM2 = Math.round(((r.widthMm * r.lengthMm) / 1e6) * 1e8) / 1e8;
    if (Math.abs(boardM2 - r.boardM2) > 1e-8) {
      throw new Error(`${r.code}: board m2 ${boardM2} does not match ${r.boardM2}`);
    }
    const boxDerived = Math.round(boardM2 * r.piecesPerBox * 1e6) / 1e6;
    if (Math.abs(boxDerived - r.boxM2Derived) > 1e-6) {
      throw new Error(`${r.code}: box m2 ${boxDerived} does not match ${r.boxM2Derived}`);
    }
    /* The printed figure must be within a board of the derived one. A bigger
     * gap means the piece count is wrong, not that the sheet rounded. */
    if (Math.abs(r.boxM2Printed - boxDerived) > boardM2 / 2) {
      throw new Error(`${r.code}: printed box m2 ${r.boxM2Printed} is more than half a board off ${boxDerived}`);
    }

    const palletM2 = Math.round(boxDerived * r.boxesPerPallet * 1e4) / 1e4;

    const parts: string[] = [];
    parts.push(`${HURFORDS_TIMBER_SOURCE}, page ${r.sourcePage ?? "?"}, row ${r.sourceRow}`);
    parts.push(`${r.printedCategory}, ${r.pattern}`);
    parts.push(`Hurford's code ${r.mfrCode}`);
    if (r.mfrCodeCoversTwoLengths) {
      parts.push(
        `THE CODE ${r.mfrCode} IS NOT ORDERABLE ON ITS OWN, the "+" means Hurford's publish it in two board ` +
          `lengths. This row is the ${r.lengthMm}mm.`,
      );
    }
    parts.push(r.finish);

    /* Pack and pallet maths, with the rounding called out where it is real. */
    const packBits =
      `${r.piecesPerBox} boards a box at ${boardM2.toFixed(6)} m2 each = ${boxDerived.toFixed(6)} m2 a box, ` +
      `${r.boxesPerPallet} boxes a pallet = ${palletM2} m2 a pallet.`;
    if (r.boxM2IsRounded) {
      parts.push(
        `${packBits} THE LIST PRINTS ${r.boxM2Printed} m2 A BOX, which is rounded. Order off the ` +
          `${boxDerived.toFixed(6)} figure and expect the printed one on the invoice, the difference is ` +
          `${Math.abs(boxDerived - r.boxM2Printed).toFixed(6)} m2 a box.`,
      );
    } else {
      parts.push(`${packBits} Matches the printed ${r.boxM2Printed} m2 a box exactly.`);
    }
    parts.push(
      `The workbook's own Full Pallet m2 column is blank on every row, so ${palletM2} m2 is derived here.`,
    );

    /* The rate is one rate. Say so, because the column heading suggests two. */
    parts.push(
      `${money(r.pricePerM2)}/m2 ex GST AT ANY QUANTITY. The list heads this column "Pallet Price $/m2" but ` +
        `prints no broken-pallet or loose rate, so a single box and a full pallet quote at the same rate. ` +
        `Unlike Hurford's plywood, this line has no pack-versus-loose break.`,
    );

    if (r.otherLengthCode) {
      parts.push(
        `SAME COLOUR ALSO COMES AS ${r.otherLengthCode} at ${r.otherLengthMm}mm, same ` +
          `${money(r.pricePerM2)}/m2 but a different m2 a box, so the box count for a job changes with the ` +
          `length. Both are the one Hurford's code ${r.mfrCode}.`,
      );
    }
    if (r.hand) {
      parts.push(
        `SOLD HANDED: this is the ${r.hand.toUpperCase()} box. A ${r.pattern} floor needs both hands, and the ` +
          `opposite is ${r.otherHandCode}. Quoting one hand only is half a floor.`,
      );
    }
    if (r.otherSpecCode) {
      parts.push(
        `CAREFUL, TWO FLOORS SHARE THIS NAME. The same range, colour and board size also comes as ` +
          `${r.otherSpecCode} at ${r.otherSpecThicknessMm}mm for ${money(r.otherSpecPricePerM2!)}/m2, against ` +
          `this row's ${r.thicknessMm}mm at ${money(r.pricePerM2)}/m2. Same m2 a box and same boxes a pallet, ` +
          `so the only thing separating them on a quote is the thickness and the rate. Quote without naming ` +
          `the thickness and it is a coin toss which floor turns up.`,
      );
    }
    if (r.lamellaMm === null) {
      parts.push("LAMELLA NOT PRINTED on this row, where the rest of the list prints one. Ask Hurford's.");
    }
    parts.push(BROKEN_PACK_NOTE);
    parts.push(FUEL_NOTE);
    parts.push(SPECS_NOTE);

    return {
      supplierId,
      supplier: "Hurford's",
      brand: "Hurford's",
      range: r.range,
      colour: r.colour,
      category: r.category,
      // The list's own grouping wording, kept so the book reads like the list.
      tier: r.printedCategory,
      unit: "m2",

      backing: "",
      size: r.sizePrinted,
      // Boards, not roll goods.
      widthM: null,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      // The lamella IS the wear layer on an engineered board. Null on the 4
      // First Floors rows that print none, rather than guessed.
      wearLayerMm: r.lamellaMm,
      weight: "",

      unitsPerPack: r.piecesPerBox,
      unitM2: boardM2,
      // The list's own figure, for checking an invoice. Rounded on 83 rows.
      packM2Printed: r.boxM2Printed,
      boxesPerPallet: r.boxesPerPallet,

      // THE RATE AS PRINTED. Delivery is a fee rule, never folded in here.
      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),
      // ONE RATE ONLY. No broken-pallet rate is printed, so nothing here
      // implies a second one.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      bulkKind: "pack",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      // The list states no minimum. The box is in unitsPerPack x unitM2.
      minOrderQty: null,

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: r.code,
      variantKey: r.variantKey,
      sourceNote: `${HURFORDS_TIMBER_SOURCE} (page ${r.sourcePage ?? "?"}, row ${r.sourceRow})`,
      notes: parts.filter(Boolean).join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

function buildAccessories(supplierId: number): ProductSeed[] {
  return HURFORDS_ACCESSORIES.map((a) => {
    const parts: string[] = [];
    parts.push(`${HURFORDS_TIMBER_SOURCE}, page ${a.sourcePage}, row ${a.sourceRow}`);
    parts.push(a.description);
    parts.push(`${a.sizePrinted}, priced per ${a.unitPrinted} at ${money(a.price)} ex GST`);
    if (a.codeIsTemplate) {
      parts.push(
        `THE CODE IS A TEMPLATE, NOT A CODE. Hurford's print it as "${a.code}" with a literal ** where the ` +
          `colour code goes, because it is available in every Genuine Oak colour. The office fills in the ` +
          `colour at order time. It is kept verbatim rather than filled in with a guess, so do not send this ` +
          `code to Hurford's as it stands.`,
      );
    }
    parts.push(
      a.unit === "lm"
        ? "Sold by the lineal metre, so a quote needs the run length, not an m2 figure."
        : "Sold as a whole piece at the length printed, not by the metre.",
    );
    parts.push(BROKEN_PACK_NOTE);
    parts.push(FUEL_NOTE);
    parts.push(
      "NOT ON THIS PRICE LIST: finish or coating on the raw items, lead time, and whether the unfinished " +
        "nosings can be site-coated to match a prefinished floor. Worth asking.",
    );

    return {
      supplierId,
      supplier: "Hurford's",
      brand: "Hurford's",
      range: a.range,
      colour: /raw/i.test(a.description) ? "RAW (unfinished)" : "",
      category: "accessory",
      tier: a.printedCategory,
      unit: a.unit,

      backing: "",
      size: a.sizePrinted,
      widthM: null,
      lengthMm: null,
      widthMm: null,
      thicknessMm: null,
      wearLayerMm: null,
      weight: "",

      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      costPrice: a.price,
      sellPrice: sell(a.price),
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      bulkKind: "pack",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      minOrderQty: null,

      // These are Genuine Oak trims, and the list says so. A nosing that fits
      // nothing on the book would be worse than no nosing.
      fitsRange: a.range,
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: a.code,
      variantKey: a.variantKey,
      sourceNote: `${HURFORDS_TIMBER_SOURCE} (page ${a.sourcePage}, row ${a.sourceRow})`,
      notes: parts.join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

function buildUnderlay(supplierId: number): ProductSeed[] {
  return HURFORDS_UNDERLAY.map((u) => {
    const parts: string[] = [];
    parts.push(`${HURFORDS_TIMBER_SOURCE}, page ${u.sourcePage}, row ${u.sourceRow}`);
    parts.push(u.description);
    parts.push(
      `${money(u.pricePerRoll)} ex GST A WHOLE ROLL, which is what the list prices and how Hurford's sell it. ` +
        `The roll is ${u.rollSizePrinted}, so ${u.rollM2} m2, working out at ${money(u.derivedPerM2)}/m2. That ` +
        `per-m2 figure is derived for comparing against other suppliers' underlay and is NOT a rate Hurford's ` +
        `quote, so a job needing ${u.rollM2 + 1} m2 buys two rolls, not a part roll.`,
    );
    parts.push(BROKEN_PACK_NOTE);
    parts.push(FUEL_NOTE);
    parts.push(
      "NOT ON THIS PRICE LIST: acoustic rating, R-value, moisture barrier and whether it suits a slab or a " +
        "joist subfloor. Those decide whether it is the right underlay at all, so ask before substituting it " +
        "for a spec'd product.",
    );

    return {
      supplierId,
      supplier: "Hurford's",
      brand: "Hurford's",
      range: u.description.split(" - ")[0]?.trim() || u.description,
      colour: "",
      category: "underlay",
      tier: "Underlay",
      unit: "roll",

      backing: "",
      size: u.rollSizePrinted,
      widthM: u.rollWidthM,
      lengthMm: Math.round(u.rollLengthM * 1000),
      widthMm: Math.round(u.rollWidthM * 1000),
      thicknessMm: u.thicknessMm,
      wearLayerMm: null,
      weight: "",

      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      // Priced per roll, so costPrice is the roll. rollM2 records how much
      // floor one covers; there is no part-roll rate, hence no cut rate.
      costPrice: u.pricePerRoll,
      sellPrice: sell(u.pricePerRoll),
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: u.rollM2,
      bulkKind: "roll",
      volumeCostPrice: null,
      volumeQty: null,
      priceOnApplication: false,
      minOrderQty: null,

      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: "",

      sku: u.code,
      variantKey: u.variantKey,
      sourceNote: `${HURFORDS_TIMBER_SOURCE} (page ${u.sourcePage}, row ${u.sourceRow})`,
      notes: parts.join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "hurfords"));
  if (!supplier) throw new Error("Seed suppliers first — no Hurford's supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const underlay = buildUnderlay(supplier.id);
  const items = [...floors, ...accessories, ...underlay];

  /* ------------------------------ guards ------------------------------ */
  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);
  const skus = new Set(items.map((i) => i.sku));
  if (skus.size !== items.length) throw new Error(`duplicate product codes: ${items.length - skus.size}`);

  /* The plywood rows are a different list on the same supplier and must not be
   * touched by this seed. If a variant key ever collided, one list would
   * silently overwrite the other. */
  const plywood = await db.select().from(s.products).where(eq(s.products.supplierId, supplier.id));
  const existing = new Set(plywood.filter((p) => p.category === "sheet_goods").map((p) => p.variantKey));
  for (const i of items) {
    if (existing.has(i.variantKey)) throw new Error(`${i.variantKey} collides with a plywood row`);
  }

  /* Every seeded cost must be a rate Hurford's actually print. If the $80 ever
   * got folded into a rate this catches it. */
  const printed = new Set<number>([
    ...HURFORDS_TIMBER_ROWS.map((r) => r.pricePerM2),
    ...HURFORDS_ACCESSORIES.map((a) => a.price),
    ...HURFORDS_UNDERLAY.map((u) => u.pricePerRoll),
  ]);
  for (const i of items) {
    if (!printed.has(i.costPrice as number)) {
      throw new Error(`${i.sku}: cost ${i.costPrice} is not a printed Hurford's rate`);
    }
  }

  /* A handed row has to point at a real row of the opposite hand. */
  const codes = new Set(HURFORDS_TIMBER_ROWS.map((r) => r.code));
  for (const r of HURFORDS_TIMBER_ROWS) {
    if (r.hand && !r.otherHandCode) throw new Error(`${r.code} is handed with no opposite hand`);
    if (r.otherHandCode && !codes.has(r.otherHandCode)) {
      throw new Error(`${r.code} points at unknown hand "${r.otherHandCode}"`);
    }
    if (r.otherLengthCode && !codes.has(r.otherLengthCode)) {
      throw new Error(`${r.code} points at unknown length "${r.otherLengthCode}"`);
    }
    /* The rival-spec rows are only worth flagging because they price apart. If
     * a future list ever gives two thicknesses the same rate, the note above
     * reads as a warning about nothing, so fail and rewrite it instead. */
    if (r.otherSpecCode) {
      if (!codes.has(r.otherSpecCode)) {
        throw new Error(`${r.code} points at unknown rival spec "${r.otherSpecCode}"`);
      }
      if (r.otherSpecThicknessMm === r.thicknessMm) {
        throw new Error(`${r.code} names a rival spec at its own thickness`);
      }
      if (r.otherSpecPricePerM2 === r.pricePerM2) {
        throw new Error(`${r.code} and ${r.otherSpecCode} differ in thickness but not in rate`);
      }
    }
  }

  /* Nothing on this list has a second rate, so nothing may carry one. */
  for (const i of items) {
    if (i.cutCostPrice !== null || i.cutUpliftPct !== null || i.volumeCostPrice !== null) {
      throw new Error(`${i.sku}: carries a second rate this list does not print`);
    }
  }

  /* ------------------------------- write ------------------------------- */
  let created = 0;
  let updated = 0;
  for (const item of items) {
    const [found] = await db
      .select({ id: s.products.id })
      .from(s.products)
      .where(eq(s.products.variantKey, item.variantKey as string));
    if (found) {
      await db.update(s.products).set(item).where(eq(s.products.id, found.id));
      updated += 1;
    } else {
      await db.insert(s.products).values(item);
      created += 1;
    }
  }

  /* ------------------------------ report ------------------------------ */
  const rates = [...new Set(HURFORDS_TIMBER_ROWS.map((r) => r.pricePerM2))].sort((a, b) => a - b);
  const ranges = [...new Set(HURFORDS_TIMBER_ROWS.map((r) => r.range))];
  const rounded = HURFORDS_TIMBER_ROWS.filter((r) => r.boxM2IsRounded).length;
  const twoLength = HURFORDS_TIMBER_ROWS.filter((r) => r.mfrCodeCoversTwoLengths).length;
  const handed = HURFORDS_TIMBER_ROWS.filter((r) => r.hand).length;
  const noLamella = HURFORDS_TIMBER_ROWS.filter((r) => r.lamellaMm === null).length;

  console.log(`Hurford's engineered flooring: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${floors.length} flooring rows across ${ranges.length} ranges, ` +
      `${accessories.length} accessories, ${underlay.length} underlays`,
  );
  console.log(`  ${rates.length} rates on the flooring list: ${rates.map((r) => `$${r}`).join(", ")}`);
  console.log(`  ${twoLength} rows are one of two board lengths under a single Hurford's "+" code`);
  console.log(`  ${rounded} rows print a rounded box m2 — ordering maths uses the derived figure`);
  console.log(`  ${handed} rows are one hand of a herringbone/chevron pair, every one paired`);
  console.log(`  ${noLamella} rows print no lamella, left null rather than guessed`);
  console.log(
    `  delivery to us is FREE with no minimum; the ${money(HURFORDS_BROKEN_PACK_FEE_EX_GST)} ex GST is a BROKEN ` +
      `PACK FEE, once on an order short of a full pallet, seeded as a supplier fee rule and on no product row`,
  );
  console.log(
    `  a 2.21% fuel surcharge runs from 23 Sep 2026 on every Hurford's order, flooring and plywood both, ` +
      `seeded as a second supplier fee rule and not built into any of these rates`,
  );
  console.log(
    `  the workbook's per-row "Job Lot Fee" column is that same $80 described badly, NOT a second charge — ` +
      `seeding it per line would bill it up to 3x on a multi-line order`,
  );
  console.log(
    `  no cut rate, no loose rate and no volume break: the column is headed "Pallet Price $/m2" but only one ` +
      `rate is printed, so every quantity quotes the same`,
  );
  console.log(`  effective ${HURFORDS_TIMBER_EFFECTIVE_DATE}, confirmed current by Damien, no stale flag`);
  console.log(`  plywood rows on this supplier left untouched: ${existing.size}`);
  for (const a of HURFORDS_TIMBER_AUDIT) {
    console.log(`  AUDIT (${a.topic}): ${a.note}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
