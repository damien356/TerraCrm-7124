/**
 * Polyflor into the price book — 474 colour lines off the owner-supplied master
 * workbook, plus weld rod as a sellable accessory.
 *
 * Idempotent on `variantKey`, so re-running after a price change updates in
 * place. No product_specials rows are written on purpose: the Discount column
 * on Polyflor's list is Damien's EVERYDAY price, not a dated clearance, so it
 * is the standard cost. Nothing here reverts.
 *
 * The roll/cut pair on sheet vinyl is stored as two rates on the one row
 * (`costPrice` = roll, `cutCostPrice` = cut, `rollM2` = 40) and resolved against
 * the order quantity at quote time by resolveRollCut() in api/lib/pricing.ts.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-polyflor.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import {
  POLYFLOR_ACCESSORIES,
  POLYFLOR_RANGES,
  POLYFLOR_ROLL_WIDTH_M,
  POLYFLOR_SOURCE,
  type PolyflorCostSource,
} from "./polyflor-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

/** Composite identity. Polyflor's codes are not unique across ranges. */
function variantKey(parts: (string | number | null | undefined)[]) {
  return parts
    .filter((p) => p !== null && p !== undefined && p !== "")
    .map((p) => String(p).trim().toLowerCase().replace(/\s+/g, "-"))
    .join("|");
}

/**
 * m2 of ONE plank/tile, parsed off the printed size so pack maths is done on
 * the real dimensions rather than the supplier's rounded m2/box. Null where the
 * size is not a dimension pair ("Multiple sizes", "See shade format").
 */
function unitM2FromSize(size: string): number | null {
  const m = size.match(/([\d.]+)\s*(?:mm)?\s*[x×]\s*([\d.]+)\s*(?:mm)?/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h) return null;
  // A 2m x 20m roll is stated in metres, everything else in millimetres.
  const toM = w < 50 ? 1 : 1000;
  return Math.round(((w / toM) * (h / toM)) * 10_000) / 10_000;
}

const SOURCE_NOTE: Record<PolyflorCostSource, string> = {
  discount:
    "Cost read off the DISCOUNT column of Polyflor's list — Damien's everyday price, not a dated special, so it never reverts.",
  trade:
    "Cost read off the TRADE column: Polyflor publishes no discount price for this range, so trade IS the standard cost here.",
  owner:
    "Blank in both price columns on Polyflor's list. $38.77/m2 supplied directly by Damien (26 Sep 2026) — confirm before a big order.",
};

function buildPolyflor(supplierId: number) {
  const items: ProductSeed[] = [];

  for (const r of POLYFLOR_RANGES) {
    const isSheet = r.rollM2 !== null;
    for (const c of r.colours) {
      const size = c.size ?? r.size;
      const format = c.format ?? r.format;
      const printedM2 = c.m2PerUnit !== undefined ? c.m2PerUnit : r.m2PerUnit;
      const qtyPerBox = c.qtyPerBox !== undefined ? c.qtyPerBox : r.qtyPerBox;
      const boxesPerPallet = c.boxesPerPallet !== undefined ? c.boxesPerPallet : r.boxesPerPallet;

      items.push({
        supplierId,
        supplier: "Polyflor",
        brand: "Polyflor",
        range: r.range,
        colour: c.colour,
        category: "vinyl",
        // Polyflor's own banding — LVT / Commercial Sheet / Safety Sheet.
        tier: r.band,
        unit: "m2",
        size,
        // Sheet is 2m off the roll; boxed LVT has no roll width.
        widthM: isSheet ? POLYFLOR_ROLL_WIDTH_M : null,
        thicknessMm: r.thicknessMm,
        wearLayerMm: r.wearLayerMm,
        unitsPerPack: isSheet ? null : qtyPerBox,
        unitM2: isSheet ? null : unitM2FromSize(size),
        packM2Printed: isSheet ? null : printedM2,
        boxesPerPallet: isSheet ? null : boxesPerPallet,

        // ALWAYS the standard cost. For sheet that is the ROLL rate; the cut
        // rate is a separate column, never folded into this one.
        costPrice: r.rollCost,
        sellPrice: sell(r.rollCost),
        cutCostPrice: r.cutCost,
        cutUpliftPct: null,
        rollM2: r.rollM2,

        sku: c.code,
        variantKey: variantKey(["polyflor", r.band, r.range, c.colour, c.code]),
        sourceNote: `${SOURCE_NOTE[r.costSource]}${c.note ?? r.note ? ` ${c.note ?? r.note}` : ""}`,
        notes: `${POLYFLOR_SOURCE} · ${format}`,
      });
    }
  }

  for (const a of POLYFLOR_ACCESSORIES) {
    items.push({
      supplierId,
      supplier: "Polyflor",
      brand: "Polyflor",
      range: a.name,
      colour: "",
      category: "accessory",
      tier: "Accessory",
      unit: a.unit,
      costPrice: a.cost,
      sellPrice: sell(a.cost),
      variantKey: variantKey(["polyflor", "accessory", a.name]),
      sourceNote: `${a.note}. Damien: priced per lineal metre.`,
      notes: POLYFLOR_SOURCE,
    });
  }

  return items;
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "polyflor"));
  if (!supplier) throw new Error("Seed suppliers first — no Polyflor supplier row found.");

  const items = buildPolyflor(supplier.id);
  const keys = new Set(items.map((i) => i.variantKey));
  if (keys.size !== items.length) throw new Error(`duplicate variant keys: ${items.length - keys.size}`);

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

  const sheet = items.filter((i) => i.rollM2).length;
  const lvt = items.filter((i) => i.tier === "LVT").length;
  const acc = items.filter((i) => i.category === "accessory").length;
  console.log(`Polyflor: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  ${sheet} sheet-vinyl lines with a roll + cut rate, ${lvt} LVT lines, ${acc} accessory`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
