/**
 * Chameleon Flooring into the price book — 82 colour lines across 9 priced
 * product lines, plus 9 trim lines off the "Trims & Accessories" sheet.
 *
 * Idempotent on `variantKey`. No product_specials rows: this list publishes one
 * standard rate per product line and no dated clearances.
 *
 * What this supplier does that the seed has to respect:
 *
 * 1. THE PRICED ENTITY IS THE PRODUCT LINE, NOT THE FAMILY. The sheet's "Range"
 *    column is the family and one family carries several rates — Pallas runs
 *    $28 / $33 / $33 / $35 across its four lines. So `range` is the product line
 *    and `tier` is the family. A quote that says only "Pallas" is not a price.
 *
 * 2. ORDER OFF THE INTEGER BOARD COUNT. Elsa Plus XL prints 2.601 m2/pack where
 *    8 boards is truly 2.5937 — ordering off the printed figure under-orders by
 *    about 0.3%. `unitsPerPack` is the asserted integer, `unitM2` one board's
 *    real area, and `packM2Printed` is kept only to reconcile an invoice.
 *
 * 3. PALLAS QUANTUM'S RATE IS NOT SUPPLIER-PUBLISHED. The sheet's own note says
 *    "price supplied by user" and its wear layer is blank. Those 8 rows carry
 *    that provenance in `availabilityNote` so it reaches whoever is quoting,
 *    not just whoever reads the source note.
 *
 * 4. TRIMS FIT BY CORE TYPE, WHICH THIS WORKBOOK DOES NOT PUBLISH. The trim
 *    notes say "WPC Core", "SPC Hybrids", "Vulcan Core" — and there is no core
 *    column on the flooring sheet to match them against. Rather than guess a
 *    fit and have quoting offer a trim that does not suit the floor, each trim
 *    is resolved through TRIM_FITS below: an explicit, auditable decision per
 *    item, with the supplier's raw wording preserved. Only the fits the DOCUMENT
 *    states are set as a real `fitsRange`.
 *
 * NOT SEEDED HERE, on purpose:
 *   - The $50 warehouse/admin fee. Order-level, and its basis is unconfirmed —
 *     it sits on the supplier record as a non-auto-applying fee rule.
 *   - Delivery. Goods are ex Brisbane with no rate published; like Riverhill,
 *     Terra books its own carrier.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-chameleon.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import * as s from "./schema";
import {
  CHAMELEON_ACCESSORIES,
  CHAMELEON_ROWS,
  CHAMELEON_SOURCE,
} from "./chameleon-data";

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

const OWNER_PRICE_NOTE =
  "PRICE NOT FROM THE SUPPLIER'S DOCUMENT — $35/m2 was supplied by Damien, and this line's wear layer is blank on the price list. Confirm the rate with Chameleon before quoting.";

/**
 * How each trim's stated fit was resolved.
 *
 * `fits`        real range names, ONLY where the document itself names the fit.
 * `confirm`     the warning quoting shows; empty means the trim is genuinely universal.
 * `colours`     where the sheet's notes column is a colour list rather than a fit.
 *
 * Every key is asserted against the sheet, and every range in `fits` against
 * the seeded ranges, so this table cannot silently drift out of date.
 */
const TRIM_FITS: Record<
  string,
  { fits: string[]; confirm: string; colours?: string }
> = {
  // "For 9mm Ultimate" — one product line is 9mm and called Ultimate. Stated, not inferred.
  "Matching 160mm click stair nosing": {
    fits: ["Pallas Ultimate 9mm"],
    confirm: "",
  },
  // "For 7.5mm Deluxe" — two lines are 7.5mm and only one is called Deluxe, so
  // the label is ambiguous. Offered against both, with the fit confirmed at order.
  "Matching 115mm click stair nosing": {
    fits: ["Pallas 7.5mm", "Pallas Deluxe Herringbone"],
    confirm:
      "Chameleon lists this nosing as suiting '7.5mm Deluxe'. Both 7.5mm Pallas lines are 7.5mm but only the herringbone is called Deluxe — confirm which it suits before ordering.",
  },
  // "All Vulcan colours; will suit 9mm Hybrid if Vulcan colour is acceptable" —
  // the fit IS stated (9mm hybrid); it is the COLOUR that carries the condition.
  "Metal 10mm C Channel": {
    fits: ["Pallas Ultimate 9mm"],
    confirm:
      "Chameleon states this suits the 9mm hybrid only if a Vulcan colour is acceptable to the customer — Vulcan is not a range Terra stocks, so check the colour against the floor before ordering.",
    colours: "All Vulcan colours",
  },
  // Core type stated, but this workbook publishes no core per product line, so
  // the fit cannot be derived. Quotable, with the core confirmed at order.
  "Matching scotia trims": {
    fits: [],
    confirm:
      "Chameleon sells this against a WPC core. This price list does not state which product lines are WPC, so confirm the floor's core with Chameleon before ordering.",
  },
  "Matching T, Ramp & End profile": {
    fits: [],
    confirm:
      "Chameleon sells this against SPC hybrids. This price list does not state which product lines are SPC, so confirm the floor's core with Chameleon before ordering.",
  },
  "Matching T & Ramp profiles": {
    fits: [],
    confirm:
      "Chameleon sells this against a Vulcan core. Vulcan is not a range Terra stocks off this list, so this trim may not suit anything in the current price book — confirm with Chameleon before quoting it.",
  },
  // No fit stated and none implied — a plain L angle goes anywhere.
  "Matching L angle profile": { fits: [], confirm: "" },
  // Metal trims: the notes column is a colour list, not a fit.
  "Metal 8mm C Channel": {
    fits: [],
    confirm:
      "Sized 8mm, and no product line on this list is 8mm — confirm the channel suits the board thickness before ordering.",
    colours: "White, Black, Champagne, Bronze, Silver",
  },
  "Metal 2cm x 1cm L Trim": {
    fits: [],
    confirm: "",
    colours: "White, Black, Champagne, Bronze, Silver",
  },
};

function buildFloors(supplierId: number): ProductSeed[] {
  return CHAMELEON_ROWS.map((r) => ({
    supplierId,
    supplier: "Chameleon Flooring",
    brand: "Chameleon",
    // The PRODUCT line, which is what carries the price.
    range: r.range,
    colour: r.colour,
    category: r.category,
    // The family the product line sits in — ELSA, ELSA Plus, ELSA Plus XL, Pallas.
    tier: r.family,
    unit: "m2",

    size: r.sizePrinted,
    // Boards, not roll goods.
    widthM: null,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    thicknessMm: r.thicknessMm,
    // Blank on Pallas QUANTUM only; every other line publishes one.
    wearLayerMm: r.wearLayerMm,
    weight: "",

    // THE ORDERING FIGURE. Asserted integer, not the sheet's rounded m2/pack.
    unitsPerPack: r.unitsPerPack,
    unitM2: r.unitM2,
    packM2Printed: r.packM2Printed,
    // Both pallet columns are empty on every row of this list.
    boxesPerPallet: null,

    costPrice: r.price,
    sellPrice: sell(r.price),
    // Boxed product: no roll, so no cut rate and no cut threshold.
    cutCostPrice: null,
    cutUpliftPct: null,
    rollM2: null,
    priceOnApplication: false,
    minOrderQty: null,

    fitsRange: "",
    madeToOrder: false,
    leadTimeDays: null,
    // Surfaces at quote time, which is where an owner-supplied rate has to be seen.
    availabilityNote: r.priceFromOwner ? OWNER_PRICE_NOTE : "",

    // No codes published anywhere on this list.
    sku: null,
    variantKey: variantKey([
      "chameleon",
      r.category,
      r.range,
      r.colour,
      r.sizePrinted,
    ]),
    sourceNote: r.priceFromOwner
      ? `${CHAMELEON_SOURCE} PALLAS QUANTUM RATE SUPPLIED BY THE OWNER, not read off the document.`
      : CHAMELEON_SOURCE,
    notes: [
      r.productType,
      `${r.unitsPerPack} boards/pack = ${r.packM2} m2` +
        (Math.abs(r.packM2 - r.packM2Printed) >= 0.005
          ? ` (Chameleon prints ${r.packM2Printed} — order off the board count, not the printed figure)`
          : ""),
      r.note,
    ]
      .filter(Boolean)
      .join(" · "),
    active: true,
  }));
}

function buildTrims(supplierId: number): ProductSeed[] {
  const out: ProductSeed[] = [];
  for (const a of CHAMELEON_ACCESSORIES) {
    const resolved = TRIM_FITS[a.item];
    if (!resolved) throw new Error(`no TRIM_FITS entry for "${a.item}" — resolve it, do not guess`);

    // One row per named fit, or a single universal row where no fit is stated.
    const targets = resolved.fits.length ? resolved.fits : [""];
    for (const fits of targets) {
      const isNosing = /stair nosing/i.test(a.item);
      out.push({
        supplierId,
        supplier: "Chameleon Flooring",
        brand: "Chameleon",
        range: isNosing ? `Stair Nosing — ${fits || a.item}` : a.item,
        colour: "",
        category: "accessory",
        tier: a.group,
        // Sold as a length, not by area.
        unit: "each",

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
          "chameleon",
          "accessory",
          a.group,
          a.item,
          fits || "universal",
        ]),
        sourceNote: CHAMELEON_SOURCE,
        notes: [
          `Sold per ${a.size}`,
          fits ? `Fits ${fits}` : "",
          resolved.colours ? `Colours: ${resolved.colours}` : "",
          // The supplier's raw wording, kept verbatim as the evidence behind the fit.
          a.fitsLabel ? `Supplier note: ${a.fitsLabel}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        active: true,
      });
    }
  }
  return out;
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "chameleon"));
  if (!supplier) throw new Error("Seed suppliers first — no Chameleon supplier row found.");

  const floors = buildFloors(supplier.id);
  const trims = buildTrims(supplier.id);
  const items = [...floors, ...trims];

  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

  /* TRIM_FITS must describe exactly the trims on the sheet — no stale keys. */
  const sheetItems = new Set(CHAMELEON_ACCESSORIES.map((a) => a.item));
  for (const key of Object.keys(TRIM_FITS)) {
    if (!sheetItems.has(key)) throw new Error(`TRIM_FITS has a stale entry "${key}" — not on the sheet`);
  }

  /* A trim may only name a range that actually exists, or quoting could offer a
   * nosing for a floor Chameleon does not sell. */
  const ranges = new Set(floors.map((f) => f.range));
  for (const t of trims) {
    if (t.fitsRange && !ranges.has(t.fitsRange)) {
      throw new Error(`trim "${t.range}" fits unknown range "${t.fitsRange}"`);
    }
  }

  /* Every floor line must have resolved to a whole board count upstream. */
  for (const f of floors) {
    if (!f.unitsPerPack || f.unitsPerPack < 1) throw new Error(`${f.range} ${f.colour}: bad board count`);
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
  for (const f of floors) byCategory.set(f.category!, (byCategory.get(f.category!) ?? 0) + 1);

  console.log(`Chameleon: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(
    `  ${floors.length} floor lines, ${ranges.size} priced product lines — ${[...byCategory.entries()]
      .map(([c, n]) => `${n} ${c}`)
      .join(", ")}`,
  );
  const families = new Map<string, number>();
  for (const f of floors) families.set(f.tier!, (families.get(f.tier!) ?? 0) + 1);
  console.log(
    `  families: ${[...families.entries()].map(([f, n]) => `${f} (${n})`).join(", ")}`,
  );
  console.log(
    `  ${trims.length} trim lines — ${trims.filter((t) => t.fitsRange).length} matched to a named range, ${
      trims.filter((t) => !t.fitsRange).length
    } universal, ${trims.filter((t) => t.availabilityNote).length} carrying a confirm-before-order warning`,
  );
  console.log(
    `  ${floors.filter((f) => f.availabilityNote).length} floor lines flagged as owner-supplied pricing (Pallas QUANTUM)`,
  );
  console.log(
    "  not seeded as products: $50 warehouse/admin fee (order-level, basis unconfirmed), delivery (goods ex Brisbane, Terra books its own carrier)",
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
