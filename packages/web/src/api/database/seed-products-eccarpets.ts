/**
 * EC Carpets broadloom into the price book — 236 colours across 27 ranges,
 * priced per lineal metre.
 *
 * Five things here are deliberate.
 *
 * 1. CATEGORY IS `carpet`, UNIT IS `lm`, FIBRE GOES IN `tier`. Same shape as
 *    Belgotex and Victoria Carpets broadloom: bought by the metre off a roll.
 *    EC's "Category" column is a FIBRE (Pure Wool / Solution Dyed Nylon /
 *    Polyester / Polypropylene), not a floor type, and every row of the file is
 *    carpet — so it lands in `tier`, which is where a supplier's own grade band
 *    lives (Belgotex PREMIUM / WOOL). On this supplier the fibre IS the band:
 *    it is what separates $55.90 polypropylene from $249.90 wool.
 *
 * 2. THE 25 LM BREAK IS SEEDED AS A REAL ROLL/CUT SPLIT — the first carpet
 *    supplier in this book where that is true. 10 of the 27 ranges publish an
 *    "Over 25m" rate, so for those:
 *        rollM2       = 25      (the threshold, in lm, `unit` being lm)
 *        costPrice    = the over-25m rate   (what you pay AT or ABOVE 25 lm)
 *        cutCostPrice = the standard rate   (what a shorter order pays)
 *    That is exactly how `resolveRollCut` reads the pair: `onRollRate` is
 *    `qty >= rollM2`, rate is `costPrice` there and `cutCostPrice` below. It
 *    also makes the resolver's `betterAsFullRoll` branch do real work here —
 *    on Summit Point, anything under 21.49 lm costs MORE than simply buying 25
 *    lm at the break rate, and the office gets told so in the quote note.
 *    `bulkKind` stays the default "roll" because that is literally what it is.
 *
 *    THE DISCOUNT IS A FLAT $8.00/lm ON ALL TEN RANGES, proven at parse time.
 *    Not a percentage — which means it is worth 14.1% on the cheapest range
 *    carrying it and 4.3% on the dearest. The relative prize is biggest at the
 *    BUDGET end, the opposite of the usual assumption about volume deals.
 *
 * 3. THE OTHER 17 RANGES GET NULL, NOT AN ASSUMED $8. No `rollM2`, no
 *    `cutCostPrice` — one rate, nothing for the resolver to pick between. The
 *    blanks are not random: Polyester has the break on 2 of 2 ranges and
 *    Polypropylene on 4 of 5, but Solution Dyed Nylon on 3 of 14 and Pure Wool
 *    on 1 of 6. Reads as deliberate policy rather than an unfilled column, and
 *    either way inventing the rate would put a discount EC never offered into
 *    quotes. Every one of those rows says which it is so nobody assumes.
 *
 * 4. `widthM` IS NULL ON ALL 236 ROWS, AND THAT BLOCKS lm -> m2. EC publish no
 *    roll width anywhere in the file. Independent retailer listings (Harvey
 *    Norman, Floormania, Goodwood) all say 3.66 m for Boucle, Orchard and
 *    Flinders Gorge, so 3.66 m is very likely right for the nylons — but "very
 *    likely" is not a number to put into a customer's area calculation, and a
 *    4.0 m assumption against a 3.66 m roll under-orders a job by 9%. So it
 *    stays null, exactly as on Victoria Carpets, and the note carries the
 *    indicative figure as something to CONFIRM rather than something to use.
 *
 * 5. COLOUR CODES GO IN `sku`, NEVER IN THE IDENTITY KEY, AND 8104 IS FLAGGED.
 *    235 of 236 codes are unique; 8104 is Dolomites "Madonna" at $106.90/lm
 *    AND Sky Bridge "Marlow" at $97.90/lm. `variantKey` is composite
 *    (range+colour) so the collision cannot corrupt identity, and both rows
 *    carry an `availabilityNote` — soft warning, never a block, same treatment
 *    as the Airlay expanded colours. A code is what an order gets typed off,
 *    so the office needs to see it at quote time.
 *
 * Freight ($69.90 per invoice) is the only charge EC publish and it sits on the
 * supplier row as an auto-applying fee. See seed-suppliers.ts.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-eccarpets.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  EC_BREAK_DISCOUNT_PER_LM,
  EC_BREAK_LM,
  EC_BROADLOOM,
  EC_CODE_COLLISIONS,
  EC_FIBRES,
  EC_FREIGHT,
  EC_PRICE_LIST_PRINTED,
  EC_RANGES,
  EC_SOURCE,
} from "./eccarpets-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

const RANGE_BY_NAME = new Map(EC_RANGES.map((r) => [r.range, r]));
const FIBRE_BY_NAME = new Map(EC_FIBRES.map((f) => [f.fibre, f]));

/** Ranges the 3.66 m width is corroborated for by third-party listings — still unconfirmed by EC. */
const WIDTH_INDICATED = new Set(["Boucle", "Orchard", "Flinders Gorge"]);

function buildEcCarpets(supplierId: number): ProductSeed[] {
  return EC_BROADLOOM.map((r) => {
    const meta = RANGE_BY_NAME.get(r.range)!;
    const fibre = FIBRE_BY_NAME.get(r.fibre)!;
    const hasBreak = r.overBreakPerLm !== null;

    // The rate AT or ABOVE 25 lm is the `costPrice` the resolver treats as the
    // roll rate; the standard rate becomes the below-threshold cut rate. Where
    // EC publish no break there is one rate and no threshold.
    const rollRate = hasBreak ? r.overBreakPerLm! : r.pricePerLm;
    const cutRate = hasBreak ? r.pricePerLm : null;

    const collision = EC_CODE_COLLISIONS.find((c) => c.code === r.colourCode);
    const otherUse = collision?.uses.find((u) => u.range !== r.range);

    return {
      supplierId,
      supplier: "EC Carpets",
      brand: "EC Carpets",
      range: r.range,
      colour: r.colour,
      category: "carpet",
      // EC's "Category" column is the fibre, and on this supplier the fibre is
      // the grade band — it is what separates $55.90 from $249.90.
      tier: r.fibre,
      // Bought by the metre off a roll, like Belgotex and Victoria Carpets.
      unit: "lm",
      // NOT PUBLISHED. Null on purpose — see note 4 above. Without it, lm
      // cannot be converted to m2 for any EC Carpets line.
      widthM: null,
      size: "",
      // Nothing dimensional is published: no roll length, no pile height, no
      // face weight, no backing, no ACCS rating.
      lengthMm: null,
      widthMm: null,
      thicknessMm: null,
      wearLayerMm: null,
      weight: "",
      unitsPerPack: null,
      unitM2: null,
      packM2Printed: null,
      boxesPerPallet: null,

      costPrice: rollRate,
      sellPrice: sell(rollRate),

      // A genuine volume break, not a cut premium in the Polyflor sense — but
      // arithmetically identical and handled by the same resolver. Set
      // `cutCostPrice` OR `cutUpliftPct`, never both.
      cutCostPrice: cutRate,
      cutUpliftPct: null,
      rollM2: hasBreak ? EC_BREAK_LM : null,
      bulkKind: "roll",

      priceOnApplication: false,
      // Not published. Belgotex broadloom is 2.0 lm; EC state no minimum, so
      // this is left null rather than borrowed off another supplier.
      minOrderQty: null,
      priceValidUntil: "",
      fitsRange: "",
      madeToOrder: false,
      leadTimeDays: null,

      // Soft warning, never a block — the office sees it at quote time.
      availabilityNote: otherUse
        ? `COLOUR CODE ${r.colourCode} IS NOT UNIQUE. EC use it for ${r.range} "${r.colour}" at $${r.pricePerLm.toFixed(2)}/lm AND for ${otherUse.range} "${otherUse.colour}" at $${otherUse.pricePerLm.toFixed(2)}/lm — $${collision!.spreadPerLm.toFixed(2)}/lm apart. Order by RANGE + COLOUR, never by the code alone.`
        : "",

      sku: r.colourCode,
      variantKey: r.variantKey,
      sourceNote:
        `$${r.pricePerLm.toFixed(2)}/lm ex GST from the ${EC_PRICE_LIST_PRINTED} list. ` +
        (hasBreak
          ? `Over ${EC_BREAK_LM} lm it drops to $${r.overBreakPerLm!.toFixed(2)}/lm — a flat $${EC_BREAK_DISCOUNT_PER_LM.toFixed(2)}/lm off, ${meta.discountPct}% on this range. ` +
            `At ${EC_BREAK_LM} lm that is $${meta.savingAt25Lm!.toFixed(2)} saved. Below ${meta.breakEvenLm} lm, buying the full ${EC_BREAK_LM} lm costs LESS than the shorter run. `
          : `EC publish NO over-${EC_BREAK_LM} lm rate for ${r.range}, so one rate applies at any quantity. `) +
        `All ${meta.colours} colours in ${r.range} share this price. Colour code ${r.colourCode}. ` +
        `${r.fibre} — ${fibre.means}. Source: ${meta.url}`,
      notes:
        `${EC_SOURCE}, list dated ${EC_PRICE_LIST_PRINTED} — current, and the only date in the file. Australian-made. ` +
        `ROLL WIDTH NOT PUBLISHED, so lineal metres cannot be converted to m2 on this line — measure and quote in lm, and get the width from EC before doing any area maths. ` +
        (WIDTH_INDICATED.has(r.range)
          ? `Third-party retailer listings state 3.66 m for ${r.range}, which is indicative ONLY and deliberately not recorded as the width — confirm it with EC before using it. `
          : `Retailer listings suggest 3.66 m is EC's standard nylon roll width, but nothing corroborates it for ${r.range} specifically. `) +
        (hasBreak
          ? `THE ${EC_BREAK_LM} LM BREAK IS MODELLED: quoting applies $${r.overBreakPerLm!.toFixed(2)}/lm at or above ${EC_BREAK_LM} lm and $${r.pricePerLm.toFixed(2)}/lm below it, automatically. `
          : `NO BREAK IS MODELLED because EC publish none for this range. Note that ${fibre.rangesWithBreak} of the ${fibre.ranges} ${r.fibre} ranges do have one, so this may be policy (EC discount volume at the budget end) or may be an unfilled column — worth one question, because if it does apply it is $${(EC_BREAK_DISCOUNT_PER_LM * EC_BREAK_LM).toFixed(2)} on a ${EC_BREAK_LM} lm job. `) +
        `Freight $${EC_FREIGHT.amount.toFixed(2)} + GST ${EC_FREIGHT.basis.toLowerCase()} — flat, so consolidate orders; two invoices cost double. EC manufacture in Lonsdale SA, so confirm that rate is all-in to the Gold Coast and ask about lead times. ` +
        `Face weight, pile height, backing, roll length, ACCS rating, minimum order and any part-roll cutting charge are all unstated by the supplier.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "eccarpets"));
  if (!supplier) throw new Error("Seed suppliers first — no EC Carpets supplier row found.");

  const items = buildEcCarpets(supplier.id);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  // Guards on the decisions above: a break must be a complete pair, and a
  // range without one must carry no threshold at all.
  for (const i of items) {
    const paired = i.rollM2 !== null && i.cutCostPrice !== null;
    const bare = i.rollM2 === null && i.cutCostPrice === null;
    if (!paired && !bare) throw new Error(`half a break on ${i.range} ${i.colour}`);
    if (paired && !(i.cutCostPrice! > i.costPrice!)) {
      throw new Error(`break is not cheaper on ${i.range} ${i.colour}`);
    }
    if (i.costPrice === null) throw new Error(`no price on ${i.range} ${i.colour}`);
    if (i.widthM !== null) throw new Error(`widthM must stay null — ${i.range} ${i.colour}`);
  }

  const withBreak = items.filter((i) => i.rollM2 !== null);
  if (withBreak.length !== 81) throw new Error(`expected 81 break rows, got ${withBreak.length}`);
  for (const i of withBreak) {
    const d = Math.round((i.cutCostPrice! - i.costPrice!) * 100) / 100;
    if (d !== EC_BREAK_DISCOUNT_PER_LM) throw new Error(`discount ${d} on ${i.range} ${i.colour}`);
  }

  const flagged = items.filter((i) => i.availabilityNote);
  if (flagged.length !== 2) throw new Error(`expected 2 code-collision rows, got ${flagged.length}`);

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

  console.log(`EC Carpets: ${created} created, ${updated} updated of ${items.length} lines`);
  for (const f of EC_FIBRES) {
    console.log(
      `  ${f.fibre.padEnd(20)} ${String(f.ranges).padStart(2)} ranges ${String(f.colours).padStart(4)} colours  ` +
        `$${f.minPerLm.toFixed(2)}-$${f.maxPerLm.toFixed(2)}/lm  ${f.rangesWithBreak}/${f.ranges} with a ${EC_BREAK_LM} lm break`,
    );
  }
  console.log(`  price list ${EC_PRICE_LIST_PRINTED} — current, the only date in the file`);
  console.log(
    `  ${withBreak.length} rows across ${EC_RANGES.filter((r) => r.overBreakPerLm !== null).length} ranges carry the break, ` +
      `flat $${EC_BREAK_DISCOUNT_PER_LM.toFixed(2)}/lm off, seeded as rollM2=${EC_BREAK_LM} + cutCostPrice so quoting picks the rate`,
  );
  const best = EC_RANGES.filter((r) => r.discountPct !== null).sort((a, b) => b.discountPct! - a.discountPct!)[0];
  console.log(
    `    worth ${best.discountPct}% on ${best.range} ($${best.pricePerLm}/lm) — and under ${best.breakEvenLm} lm, 25 lm is cheaper than the length asked for`,
  );
  console.log(`  ${items.length - withBreak.length} rows have no break published — rollM2/cutCostPrice left null, never assumed`);
  console.log(`  widthM null on all ${items.length} lines — roll width not published, so lm -> m2 is not possible`);
  console.log(`  ${flagged.length} rows flagged: colour code ${EC_CODE_COLLISIONS[0].code} is two products $${EC_CODE_COLLISIONS[0].spreadPerLm.toFixed(2)}/lm apart`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
