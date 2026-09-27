/**
 * Airlay QLD into the price book — 325 colour lines across 27 range/category
 * pairs, plus 13 sellable accessory lines off the "Accessories & Charges" sheet.
 *
 * Idempotent on `variantKey`. No product_specials rows: this list publishes one
 * standard rate per variant and no dated clearances.
 *
 * What this supplier does that the seed has to respect:
 *
 * 1. PRICE IS NOT ONE-PER-RANGE — the first supplier in the book where it
 *    isn't. The same range and colour costs a different amount on a different
 *    BACKING (+$6 cushion, +$8 PU cushion), and price also moves by SIZE
 *    (Alpine runs $25.50 at 177.8 and $31.50 at 228.6), by THICKNESS (Rustic
 *    $17.50 at 8mm, $22.50 at 12mm) and, for Corporate alone, PER COLOUR —
 *    nine rates in one range. So `backing` is a priced axis here, not a spec,
 *    and the variant key has to carry backing, size and thickness. A quote that
 *    names only the range and colour is not a price on this supplier.
 *
 * 2. RANGE NAMES COLLIDE ACROSS CATEGORIES. "Oakwood" is a vinyl plank at
 *    $28.50 AND a hybrid at $26.50, sharing all six colour names. Category is
 *    therefore part of identity, and `fitsRange` alone cannot disambiguate an
 *    accessory — see ACCESSORY_FITS.
 *
 * 3. ROLL GOODS, THE FIRST IN THE BOOK. 41 sheet vinyl lines, 2.0m x 20m,
 *    40 m2 a roll, priced per m2. `rollM2` is the cut threshold, but the cut
 *    rate columns stay NULL on purpose: Airlay charges a flat $30 per cut,
 *    which is a fee rule on the supplier, not a different per-m2 rate on the
 *    product. Filling `cutCostPrice` here would double-charge it.
 *
 * 4. ORDER OFF THE INTEGER UNIT COUNT. Printed m2/box drifts both ways on this
 *    list — Alpine 177.8 prints 3.26 where 15 planks is 3.2516, Oakwood vinyl
 *    prints 2.80 where 8 planks is 2.8042. `unitsPerPack` is the asserted
 *    integer; `packM2Printed` is kept only to reconcile an invoice.
 *
 * 5. THE COLOUR NAMES ARE WEB-SOURCED, THE PRICES ARE NOT. Colours were
 *    expanded from airlay.com.au onto a Jan 2025 price list, and the workbook's
 *    own notes admit the two disagree in places. 33 rows the price list marked
 *    "selected colours" carry a confirm-at-order warning into quoting rather
 *    than being dropped — Damien's call was quotable, checked at order.
 *
 * NOT SEEDED HERE, on purpose:
 *   - The $30 sheet vinyl cutting fee and the $85 metropolitan delivery
 *     bundling fee. Both are already fee rules on the supplier record; seeding
 *     them as products would bill them twice.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-airlay.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import { AIRLAY_ACCESSORIES, AIRLAY_ROWS, AIRLAY_SOURCE } from "./airlay-data";

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

/** The only backings this list uses. Asserted, so a new one is never silently priced. */
const KNOWN_BACKINGS = new Set(["PVC", "Cushion Back", "PU Cushion Back", "IXPE underlay", ""]);

const SELECTED_COLOURS_NOTE =
  "Airlay's price list offers this range in SELECTED COLOURS only, and this colour was " +
  "expanded from airlay.com.au — it is quotable, but confirm the colour is available " +
  "at this rate when the order is placed.";

/**
 * How each accessory's fit was resolved.
 *
 * `fits`     real range names, ONLY where the document supports the fit.
 * `confirm`  the warning quoting shows; empty means genuinely unrestricted.
 * `unit`     each = sold as one 2400mm length or one reel; lm = sold by the metre.
 *
 * Every key is asserted against the sheet, and every range in `fits` against
 * the seeded ranges, so this table cannot drift out of date.
 */
const ACCESSORY_FITS: Record<
  string,
  { fits: string[]; confirm: string; unit: "each" | "lm" }
> = {
  // Sourced off Airlay's HYBRID Oakwood page, and its six colour names are
  // exactly the six shared by both Oakwood ranges. The fit is named, but which
  // Oakwood is not — so it is offered against the range and the ambiguity is
  // stated rather than resolved by guesswork.
  "Oakwood Quads/Scotia": {
    fits: ["Oakwood"],
    confirm:
      "Airlay lists this scotia on the hybrid Oakwood page, but its colour names are shared " +
      "by both the hybrid Oakwood (1500 x 228) and the vinyl plank Oakwood (230 x 1524). " +
      "Confirm which Oakwood it is being ordered against.",
    unit: "each",
  },
  // Spec'd "12mm" where Rustic is sold in 8mm and 12mm. On the Oakwood scotia
  // the leading number (16mm) cannot be a floor thickness — Oakwood hybrid is
  // 8mm — so 12mm here is most likely the scotia's own profile size, not the
  // floor it suits. Not resolved here; flagged.
  "Rustic Quads/Scotia": {
    fits: ["Rustic"],
    confirm:
      "Spec'd '12mm' and Rustic is sold in both 8mm and 12mm. On the Oakwood scotia the " +
      "same leading figure (16mm) is not a floor thickness, so this is probably the scotia " +
      "profile rather than the board it suits — confirm before ordering against 8mm Rustic.",
    unit: "each",
  },
  // Welding rod for sheet vinyl seams. Airlay publishes no colour names for it
  // at all, so it cannot be matched to a floor colour.
  "All Weld Rods": {
    fits: [],
    confirm:
      "Airlay's price list publishes no individual weld-rod colours. Match the rod to the " +
      "sheet vinyl colour with Airlay when ordering.",
    unit: "each",
  },
};

function buildFloors(supplierId: number): ProductSeed[] {
  return AIRLAY_ROWS.map((r) => {
    if (!KNOWN_BACKINGS.has(r.backing)) {
      throw new Error(`${r.range} ${r.colour}: unknown backing "${r.backing}"`);
    }

    return {
      supplierId,
      supplier: "Airlay",
      brand: "Airlay",
      range: r.range,
      colour: r.colour,
      category: r.category,
      // Airlay's own format band — Carpet Plank, Sheet Vinyl, Vinyl Tile. Three
      // formats collapse into `vinyl`, so without this the distinction is lost.
      tier: r.tier,
      // Rolls are priced per m2 on this list too, not per linear metre.
      unit: "m2",

      // A PRICE AXIS on this supplier. Cushion back is +$6 and PU cushion +$8
      // on the same range and colour.
      backing: r.backing,
      size: r.sizePrinted,
      // Roll width, set on sheet vinyl only; drives lm -> m2 for a cut plan.
      widthM: r.widthM,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      thicknessMm: r.thicknessMm,
      wearLayerMm: r.wearLayerMm,
      // No face weights anywhere on this list.
      weight: "",

      // THE ORDERING FIGURE. Null on rolls, which have no carton.
      unitsPerPack: r.unitsPerPack,
      unitM2: r.unitM2,
      packM2Printed: r.isRoll ? null : r.packM2Printed,
      // Not published on this list.
      boxesPerPallet: null,

      costPrice: r.price,
      sellPrice: sell(r.price),
      // DELIBERATELY NULL on rolls: Airlay's part-roll charge is a flat $30 per
      // cut on the supplier's fee rules, not a different per-m2 rate. Setting a
      // cut rate here would charge it twice.
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: r.rollM2,
      priceOnApplication: false,
      minOrderQty: null,

      fitsRange: "",
      madeToOrder: r.madeToOrder,
      leadTimeDays: null,
      // Only real risks reach quoting: a restricted colour, or a row whose
      // price breaks the list's own pattern.
      availabilityNote: [r.selectedColours ? SELECTED_COLOURS_NOTE : "", r.upliftNote ?? ""]
        .filter(Boolean)
        .join(" "),

      // No codes published anywhere on this list.
      sku: null,
      variantKey: variantKey([
        "airlay",
        r.category,
        r.range,
        r.colour,
        r.backing,
        r.sizePrinted,
        r.thicknessMm,
      ]),
      sourceNote: [AIRLAY_SOURCE, r.note ?? "", r.source ? `Colour source: ${r.source}` : ""]
        .filter(Boolean)
        .join(" "),
      notes: [
        r.tier,
        r.slipRating ? `Slip rating ${r.slipRating}` : "",
        r.construction ?? "",
        r.isRoll
          ? `Roll goods — ${r.widthM}m x ${r.rollLengthM}m = ${r.rollM2} m2/roll, priced per m2. ` +
            "Part rolls attract Airlay's flat $30 per cut, charged per cut in the plan."
          : `${r.unitsPerPack}/box = ${r.packM2} m2` +
            (Math.abs(r.packM2 - r.packM2Printed) >= 0.0005
              ? ` (Airlay prints ${r.packM2Printed} — order off the unit count, not the printed figure)`
              : ""),
        r.pvcOnly ? "Airlay lists this colour as PVC backing only — no cushion-back option." : "",
        r.sizeNote ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

function buildAccessories(supplierId: number): ProductSeed[] {
  return AIRLAY_ACCESSORIES.map((a) => {
    const resolved = ACCESSORY_FITS[a.item];
    if (!resolved) {
      throw new Error(`no ACCESSORY_FITS entry for "${a.item}" — resolve it, do not guess`);
    }
    // The weld-rod sheet has two lines for one item: a 100m reel and a per-metre
    // cut rate. The unit comes off the spec, not the item name.
    const perMetre = /per metre/i.test(a.spec);
    const fits = resolved.fits[0] ?? "";

    return {
      supplierId,
      supplier: "Airlay",
      brand: "Airlay",
      range: a.item,
      colour: a.colour,
      category: "accessory",
      tier: a.group,
      unit: perMetre ? "lm" : resolved.unit,

      backing: "",
      size: a.spec,
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
      priceOnApplication: false,
      minOrderQty: null,

      fitsRange: fits,
      madeToOrder: false,
      leadTimeDays: null,
      availabilityNote: resolved.confirm,

      sku: null,
      variantKey: variantKey([
        "airlay",
        "accessory",
        a.group,
        a.item,
        a.colour,
        a.spec,
      ]),
      sourceNote: [AIRLAY_SOURCE, a.source ? `Source: ${a.source}` : ""].filter(Boolean).join(" "),
      notes: [
        perMetre ? "Sold by the metre (cut rate)" : `Sold per ${a.spec}`,
        fits ? `Fits ${fits}` : "",
        a.note ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
      active: true,
    } satisfies ProductSeed;
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "airlay"));
  if (!supplier) throw new Error("Seed suppliers first — no Airlay supplier row found.");

  const floors = buildFloors(supplier.id);
  const accessories = buildAccessories(supplier.id);
  const items = [...floors, ...accessories];

  if (floors.length !== 325) throw new Error(`expected 325 floor lines, got ${floors.length}`);
  if (accessories.length !== 13) throw new Error(`expected 13 accessories, got ${accessories.length}`);

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) {
    const seen = new Set<string>();
    const dupes = items.map((i) => i.variantKey!).filter((k) => seen.has(k) || !seen.add(k));
    throw new Error(`duplicate variant keys: ${[...new Set(dupes)].join(", ")}`);
  }

  /* ACCESSORY_FITS must describe exactly the sheet's items — no stale keys. */
  const sheetItems = new Set(AIRLAY_ACCESSORIES.map((a) => a.item));
  for (const key of Object.keys(ACCESSORY_FITS)) {
    if (!sheetItems.has(key)) throw new Error(`ACCESSORY_FITS has a stale entry "${key}"`);
  }

  /* An accessory may only name a range that exists, or quoting could offer a
   * scotia for a floor Airlay does not sell. */
  const ranges = new Set(floors.map((f) => f.range));
  for (const a of accessories) {
    if (a.fitsRange && !ranges.has(a.fitsRange)) {
      throw new Error(`accessory "${a.range}" fits unknown range "${a.fitsRange}"`);
    }
  }

  /* Boxed goods must carry a whole unit count; rolls must carry a threshold and
   * no unit count. Getting these the wrong way round breaks ordering maths. */
  for (const f of floors) {
    const isRoll = f.rollM2 !== null;
    if (isRoll) {
      if (f.unitsPerPack !== null || f.unitM2 !== null) {
        throw new Error(`${f.range} ${f.colour}: roll goods must not carry pack maths`);
      }
      if (f.rollM2 !== 40 || f.widthM !== 2) {
        throw new Error(`${f.range} ${f.colour}: unexpected roll geometry`);
      }
    } else {
      if (!f.unitsPerPack || f.unitsPerPack < 1 || !f.unitM2 || f.unitM2 <= 0) {
        throw new Error(`${f.range} ${f.colour}: bad unit count`);
      }
      if (f.widthM !== null) throw new Error(`${f.range} ${f.colour}: boxed goods must not have a roll width`);
    }
    if (!f.costPrice || f.costPrice <= 0) throw new Error(`${f.range} ${f.colour}: bad cost price`);
  }

  let created = 0;
  let updated = 0;
  for (const product of items) {
    const [existing] = await db
      .select()
      .from(s.products)
      .where(eq(s.products.variantKey, product.variantKey!));
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

  const tally = (list: ProductSeed[], pick: (p: ProductSeed) => string) => {
    const m = new Map<string, number>();
    for (const p of list) m.set(pick(p), (m.get(pick(p)) ?? 0) + 1);
    return [...m.entries()].sort().map(([k, n]) => `${k} (${n})`).join(", ");
  };

  console.log(`Airlay: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  ${floors.length} floor lines across ${ranges.size} range names, ${new Set(floors.map((f) => `${f.category}|${f.range}`)).size} range/category pairs`);
  console.log(`  categories: ${tally(floors, (f) => f.category!)}`);
  console.log(`  formats:    ${tally(floors, (f) => f.tier!)}`);
  console.log(`  backings:   ${tally(floors, (f) => f.backing || "(none)")}`);
  console.log(
    `  ${floors.filter((f) => f.rollM2 !== null).length} roll lines (40 m2 threshold, cut rate deliberately null — flat $30/cut is a supplier fee)`,
  );
  console.log(
    `  ${floors.filter((f) => f.availabilityNote).length} floor lines carrying a confirm-at-order warning, ${
      floors.filter((f) => f.madeToOrder).length
    } made to order`,
  );
  console.log(
    `  ${accessories.length} accessory lines — ${accessories.filter((a) => a.fitsRange).length} matched to a range, ${
      accessories.filter((a) => !a.fitsRange).length
    } unrestricted, ${accessories.filter((a) => a.availabilityNote).length} carrying a confirm-before-order warning`,
  );
  console.log(
    "  not seeded as products: $30 sheet vinyl cutting fee, $85 metropolitan delivery bundling fee (both already fee rules on the supplier)",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
