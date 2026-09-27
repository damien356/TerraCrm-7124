/**
 * NFD into the price book — 203 colour lines across 28 ranges and 5 categories,
 * plus 13 trims and 3 underlays off the "Accessories & Underlay" sheet.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows: NFD publish one standard rate per range and
 * no dated clearances.
 *
 * Seven things here are deliberate.
 *
 * 1. ONE PRICE PER RANGE, PER m2. Colour never moves the rate — asserted at
 *    parse time, so an odd one out fails the extract rather than being averaged.
 *
 * 2. NO PALLET DISCOUNT, SO NO ROLL/CUT SPLIT. The list has two price columns,
 *    "Pallet/Roll" and "Single/Cut", holding the SAME number on all 203 rows.
 *    On boxed goods that sentence means something sharper than it did on
 *    Victoria Carpets broadloom: buying ONE BOX costs the same per m2 as buying
 *    a FULL PALLET. So `cutCostPrice`, `cutUpliftPct` and `rollM2` are null and
 *    `resolveRollCut` has nothing to resolve — a PROVEN no-break, not missing
 *    data, and the note on every row says so. Nobody should ring to ask what
 *    the pallet rate is, and nobody should pad an order up to a pallet.
 *
 * 3. EVERY SPEC COLUMN IS NULL BECAUSE NFD PUBLISH NONE. No thickness, no wear
 *    layer, no board or tile size, no boards per box, no AC rating — on none of
 *    the 203 rows. `size` is empty, `lengthMm` / `widthMm` / `thicknessMm` /
 *    `wearLayerMm` / `unitsPerPack` / `unitM2` are all null. That is worse than
 *    a cosmetic gap: `lengthMm` is what the freight logic uses to decide
 *    whether a board trips Jocks' over-1200mm rate, so NFD orders cannot be
 *    freight-classified from this data at all. Flagged on every row rather than
 *    filled with a plausible number.
 *    THE TWO EXCEPTIONS: LUXE GRAIN 12MM and LUXE GRAIN 8MM print their
 *    thickness in NFD's own range name, so those 20 rows carry a real
 *    `thicknessMm`. Read off the supplier's text, asserted against it, never
 *    inferred.
 *
 * 4. m2/BOX GOES IN `packM2Printed` AND IT IS THE ONLY PACK FIGURE THERE IS.
 *    Everywhere else in this book `packM2Printed` is the supplier's rounded
 *    number kept ONLY to cross-check an invoice, because `unitsPerPack` x
 *    `unitM2` is the truth (Sunstar and Airlay both drift). NFD give no board
 *    count, so there is nothing to derive and nothing to check it against —
 *    on this supplier the printed m2/box has to be trusted for ordering maths.
 *    That inversion is called out on every row so the next person reading a
 *    quote knows which kind of number they are looking at.
 *
 * 5. THE SIX DAINTREE LINES KEEP NFD'S OWN SPLIT. The sheet's Range column
 *    reads "DAINTREE - B/B", "- S/G", "- T/O" and the same three for DAINTREE
 *    XL — six single-colour ranges whose suffix IS the colour. Consolidating
 *    them into two 3-colour ranges would be tidier and would be inventing a
 *    grouping NFD did not publish, so they stay as written and are tied back
 *    together through `tier` (DAINTREE / DAINTREE XL) for the product list.
 *    They are also the only 6 rows with no boxes/pallet, so `boxesPerPallet` is
 *    null there — unpublished, NOT zero.
 *
 * 6. TRIMS ARE `accessory` WITH AN EMPTY `fitsRange`, ON PURPOSE. Riverhill and
 *    Sunstar nosings name a floor range because those suppliers print one. NFD
 *    name a SUBSTRATE — "CUSTOM NOSING - HYB / LAM / LVT / TIM" — which is a
 *    category, not a range, and `fitsRange` is validated against real range
 *    names elsewhere. So the substrate goes in `tier` and the notes, and
 *    `fitsRange` stays empty rather than being filled with something that is
 *    not a range. A quote can offer any NFD nosing against any NFD floor of the
 *    matching substrate, which is exactly what NFD's own wording allows.
 *    Worth noting for the floor: NON NFD NOSING exists in HYB and LVT at $55
 *    against $45 for their own — a $10 penalty for matching a nosing to a floor
 *    bought elsewhere — and there is no non-NFD option in laminate or timber.
 *
 * 7. PERFORMANCE PLUS UNDERLAY IS PRICE-ON-APPLICATION DESPITE HAVING PRICES.
 *    It is the one line in the whole file where the two price columns differ
 *    ($12 bulk, $16 single) AND it is the one underlay with no package size, so
 *    what those dollars buy is unknown — $12 for a 20m roll would be absurd
 *    next to $40 for CLASSICMAX foam, so it reads as per-m2, but reading is not
 *    knowing. Both numbers are recorded in the notes and `priceOnApplication`
 *    is true so quoting has to ring NFD instead of silently picking a unit.
 *    ACOUSTICMAX and CLASSICMAX are priced per 20m roll and are unambiguous.
 *
 * NOT SEEDED HERE, on purpose:
 *   - Packing & Admin ($75 + GST per order). Order-level, already a
 *     supplier_fee_rules row — putting it in a product would double-charge it.
 *   - The 25%-of-returned-goods re-stocking fee, which no fee basis can express
 *     and which is recorded on the supplier without an amount. See
 *     seed-suppliers.ts.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-nfd.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  NFD_ACCESSORIES,
  NFD_COLOUR_COLLISIONS,
  NFD_FLOORS,
  NFD_NO_PALLET_QTY_RANGES,
  NFD_PACKING_FEE,
  NFD_PRICE_LIST_PRINTED,
  NFD_RANGES,
  NFD_RETURNS_FEE,
  NFD_SOURCE,
} from "./nfd-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

/** Composite identity, built the same way as every other supplier's. */
function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

/**
 * The substrate each trim is cut for, read off NFD's own suffix. A category,
 * not a range — which is why it lives in `tier` and never in `fitsRange`.
 */
const SUBSTRATE_LABELS: Record<string, string> = {
  HYB: "Hybrid",
  LAM: "Laminate",
  LVT: "Luxury vinyl plank",
  TIM: "Engineered timber",
};
function substrate(item: string): string {
  const suffix = item.split(" - ")[1]?.trim();
  return (suffix && SUBSTRATE_LABELS[suffix]) || "";
}

/** How many NFD ranges share this colour name, for the note on the row. */
const COLLISION_COUNT = new Map(NFD_COLOUR_COLLISIONS.map((c) => [c.colour, c.count]));
const RANGE_BY_NAME = new Map(NFD_RANGES.map((r) => [r.range, r]));

const NO_SPECS_NOTE =
  "NFD PUBLISH NO DIMENSIONS FOR THIS PRODUCT — no board/tile size, no thickness, no wear layer, no AC rating and no boards per box anywhere on their price list. " +
  "Do not answer a customer's 'how thick is it' off this record, and note that freight cannot be classified by board length for NFD lines the way it can for Sunstar or Riverhill.";

function buildFloors(supplierId: number): ProductSeed[] {
  return NFD_FLOORS.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;
    const shared = COLLISION_COUNT.get(r.colour) ?? 1;
    return {
      supplierId,
      supplier: "NFD",
      brand: "NFD",
      range: r.range,
      colour: r.colour,
      category: r.category,
      // NFD's own grouping where their naming implies one — DAINTREE, DAINTREE
      // XL, LUXE GRAIN, EVOLVE. Read off the range name, never invented.
      tier: r.family,
      unit: "m2",

      // All empty/null: see note 3. NFD state no sizes at all.
      size: "",
      widthM: null,
      lengthMm: null,
      widthMm: null,
      // Set ONLY on LUXE GRAIN 12MM / 8MM, which name their thickness.
      thicknessMm: r.thicknessMm,
      wearLayerMm: null,
      weight: "",

      // No board count published, so nothing to derive a per-board area from.
      unitsPerPack: null,
      unitM2: null,
      // The only pack figure NFD give, and unverifiable — see note 4.
      packM2Printed: r.m2PerBox,
      // Null on the six Daintree lines: unpublished, not zero.
      boxesPerPallet: r.boxesPerPallet,

      costPrice: r.pricePerM2,
      sellPrice: sell(r.pricePerM2),

      // Pallet rate === single-box rate on every row, proven at parse time.
      // Nothing for resolveRollCut to pick between.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,

      // Not published. Left null rather than borrowed off another supplier.
      minOrderQty: null,

      // NFD publish no product or colour codes at all — the composite key is
      // the only identifier, and it must carry the range because 28 colour
      // names are reused across ranges at different prices.
      sku: null,
      variantKey: r.variantKey,
      sourceNote:
        `$${r.pricePerM2.toFixed(2)}/m2 ex GST, price list ${NFD_PRICE_LIST_PRINTED}. ` +
        `Pallet/roll and single/cut price are the SAME $${r.pricePerM2.toFixed(2)} — NFD publish no pallet discount, so one box costs the same per m2 as a full pallet. ` +
        `All ${meta.colours} colours in ${r.range} share this price. ` +
        `${r.m2PerBox} m2/box` +
        (r.boxesPerPallet ? ` x ${r.boxesPerPallet} boxes = ${r.palletM2} m2/pallet` : ", boxes per pallet NOT published") +
        `. Colour confirmed against NFD's own product page: ${r.colourSource}`,
      notes: [
        NFD_SOURCE,
        `NFD category "${r.sheetCategory}"`,
        NO_SPECS_NOTE,
        r.thicknessMm
          ? `Thickness ${r.thicknessMm}mm is the one spec available, and only because NFD print it in the range name.`
          : "",
        `ORDER OFF ${r.m2PerBox} m2/BOX. Unlike Sunstar or Airlay there is no boards-per-box figure to derive the true pack area from, so NFD's printed m2/box is the only number there is and ordering maths has to use it — it cannot be cross-checked against an invoice.`,
        NFD_NO_PALLET_QTY_RANGES.includes(r.range)
          ? "NO BOXES/PALLET PUBLISHED for this range — unpublished, not zero, so this line cannot be turned into a pallet count for freight. Ask NFD."
          : "",
        shared > 1
          ? `COLOUR NAME IS NOT UNIQUE: "${r.colour}" is used in ${shared} different NFD ranges at different prices. Always order this as "${r.range} ${r.colour}", never by colour alone.`
          : "",
        `Packing & admin $${NFD_PACKING_FEE.amount.toFixed(0)} + GST per order, flat — combine NFD orders where possible. Returns carry a ${NFD_RETURNS_FEE.pct}% re-stocking fee on the value sent back, so order tight.`,
        "Freight to the Gold Coast unconfirmed; NFD warehouse at Ormeau is ~25 min away so pickup may be practical. Minimum order quantity and lead time both unstated.",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

/**
 * Trims, scotias, stair nosings and underlay.
 *
 * Trims are priced per piece in the single/cut column only — NFD publish no
 * bulk rate for any of them, asserted at parse time. ACOUSTICMAX and CLASSICMAX
 * are priced per 20m roll. PERFORMANCE PLUS is the odd one out: two different
 * prices and no stated package, so it goes out price-on-application.
 */
function buildAccessories(supplierId: number): ProductSeed[] {
  return NFD_ACCESSORIES.map((a) => {
    const isUnderlay = a.group === "Underlay";
    const sub = substrate(a.item);
    // PERFORMANCE PLUS: both columns priced and differing, package unstated.
    const ambiguous = a.hasBulkBreak;
    const price = a.bulkPrice ?? a.singlePrice;
    return {
      supplierId,
      supplier: "NFD",
      brand: "NFD",
      range: a.item,
      colour: "",
      category: isUnderlay ? "underlay" : "accessory",
      // "Trims" / "Underlay", narrowed to the substrate where NFD name one.
      tier: sub ? `${a.group} — ${sub}` : a.group,
      // Trims sell per piece. Underlay sells per roll, except PERFORMANCE PLUS
      // whose unit NFD do not state — left as "each" with the ambiguity flagged
      // rather than guessed at as m2.
      unit: isUnderlay && !ambiguous ? "roll" : "each",

      size: a.size,
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

      // Price withheld on PERFORMANCE PLUS: both numbers are in the notes, but
      // a cost per unknown unit is not a cost that can be quoted.
      costPrice: ambiguous ? null : price,
      sellPrice: ambiguous || price === null ? null : sell(price),
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      priceOnApplication: ambiguous,

      // Empty on purpose — NFD name a SUBSTRATE, not a range. See note 6.
      fitsRange: "",
      availabilityNote: ambiguous
        ? "NFD list two different prices for PERFORMANCE PLUS ($12 bulk / $16 single) and no package size, so what those dollars buy is unknown. Ring NFD for the unit before quoting it."
        : "",

      sku: null,
      variantKey: variantKey(["nfd", "accessory", a.group, a.item]),
      sourceNote:
        `${a.description}. Price list ${NFD_PRICE_LIST_PRINTED}. ` +
        (ambiguous
          ? `NFD list $${a.bulkPrice!.toFixed(2)} pallet/roll and $${a.singlePrice!.toFixed(2)} single/cut — the ONLY line in the file where the two columns differ (+${a.upliftPct}%) — with no package size stated.`
          : `$${price!.toFixed(2)} ex GST` +
            (a.size ? ` per ${a.size}` : a.bulkPrice !== null ? " per roll" : " each") +
            `, priced in the ${a.bulkPrice !== null ? "pallet/roll" : "single/cut"} column only.`),
      notes: [
        NFD_SOURCE,
        a.description,
        sub ? `Cut for ${sub.toLowerCase()} floors — NFD name the substrate, not a specific range, so it suits any NFD ${sub.toLowerCase()} line.` : "",
        a.item.startsWith("NON NFD")
          ? "FOR A FLOOR NOT BOUGHT FROM NFD. $55 against $45 for the same nosing in their own product — a $10 penalty for mixing suppliers, and there is no non-NFD equivalent in laminate or engineered timber at all."
          : "",
        a.item.startsWith("CUSTOM NOSING")
          ? "Custom-made. NFD state no lead time for it, unlike Sunstar's 10 days — confirm before promising a date."
          : "",
        !a.size && !isUnderlay ? "NFD state no length or profile size for this trim." : "",
        ambiguous
          ? "UNIT UNKNOWN — the two prices differ and no package is stated. $12 for a 20m roll would be absurd next to $40 for CLASSICMAX, so it reads as per-m2 with a 33% single-cut uplift, but that is a reading and not a fact. Seeded price-on-application."
          : "",
        isUnderlay && !ambiguous ? "NFD state no roll width or m2 coverage, so this cannot be converted to a per-m2 rate." : "",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "nfd"));
  if (!supplier) throw new Error("Seed suppliers first — no NFD supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const items = [...floors, ...accessories];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* No accessory may claim a floor range, because NFD publish compatibility by
   * substrate and not by range — if one ever does, the substrate mapping above
   * has been misread. */
  for (const a of accessories) {
    if (a.fitsRange) throw new Error(`accessory ${a.range} should not name a range: "${a.fitsRange}"`);
  }

  /* A priced line with no unit is worse than no line, so the only thing allowed
   * to be price-on-application is the one row whose unit NFD left out. */
  const poa = items.filter((i) => i.priceOnApplication);
  if (poa.length !== 1 || poa[0].range !== "PERFORMANCE PLUS") {
    throw new Error(`expected PERFORMANCE PLUS alone to be price-on-application, got ${poa.map((p) => p.range).join(", ")}`);
  }

  /* Every floor line must carry a price — NFD publish one for all 203. */
  for (const f of floors) {
    if (!f.costPrice) throw new Error(`${f.range} ${f.colour} has no cost price`);
  }

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

  const byCategory = new Map<string, number>();
  for (const i of items) byCategory.set(i.category!, (byCategory.get(i.category!) ?? 0) + 1);

  console.log(`NFD: ${created} created, ${updated} updated of ${items.length} lines`);
  for (const [category, n] of [...byCategory].sort()) console.log(`  ${category.padEnd(12)} ${n}`);
  console.log(
    `  ${NFD_RANGES.length} ranges, $${Math.min(...NFD_RANGES.map((r) => r.pricePerM2)).toFixed(2)}/m2 to ` +
      `$${Math.max(...NFD_RANGES.map((r) => r.pricePerM2)).toFixed(2)}/m2, one price per range`,
  );
  console.log(`  price list ${NFD_PRICE_LIST_PRINTED} — the only date in the file`);
  console.log(`  no pallet discount (pallet price === single price on all ${floors.length} rows) — cutCostPrice left null`);
  console.log(
    `  NO size/thickness/wear-layer data on ${floors.length - floors.filter((f) => f.thicknessMm).length} of ${floors.length} lines; ` +
      `${floors.filter((f) => f.thicknessMm).length} carry a thickness only because LUXE GRAIN names it`,
  );
  console.log(`  ${floors.filter((f) => f.boxesPerPallet === null).length} Daintree lines have no boxes/pallet — left null, not zero`);
  console.log(`  ${NFD_COLOUR_COLLISIONS.length} colour names reused across ranges — flagged on every affected row`);
  console.log(`  1 line price-on-application (PERFORMANCE PLUS — two prices, no stated unit)`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
