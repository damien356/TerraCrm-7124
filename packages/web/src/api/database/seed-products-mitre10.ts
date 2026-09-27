/**
 * Woodmans Mitre 10 Beenleigh into the price book — 5 structural plywood sheets
 * and 30 pine mouldings.
 *
 * THIS SUPPLIER IS A QUOTE, NOT A PRICE LIST, and the two quotes on the one
 * document do not expire together:
 *   structural ply   dated 21 Sep 2026, valid to 21 Oct 2026
 *   mouldings 6431308 dated 13 May 2026, EXPIRED 12 Jun 2026
 * So the expiry is written per line into `priceValidUntil`, not once onto the
 * supplier. Expired lines are still loaded and still quotable — deleting them
 * would just hide what Terra last paid — but they carry a loud
 * `availabilityNote` so nobody puts a four-month-old moulding price in front of
 * a customer without ringing the branch first.
 *
 * PLYWOOD IS F8 STRUCTURAL WITH A T&G EDGE: the yellow tongue keys sheet into
 * sheet, and this is the sheet that goes over JOISTS. Hurford's CD plywood is
 * non-structural and only goes straight to slab. They are NOT substitutes, so
 * the T&G and the structural rating are both in the range name where a search
 * cannot miss them.
 *
 * MOULDINGS SELL BY THE WHOLE 5.4m LENGTH, unit `each`. `pricePerM` exists in
 * the extract for comparing against per-metre suppliers and is deliberately NOT
 * loaded as a price — you cannot buy 2.3 metres of it.
 *
 * Run: cd packages/web && bun --env-file=../../.env src/api/database/seed-products-mitre10.ts
 */
import { eq } from "drizzle-orm";
import { db } from "./index";
import { MITRE10_BRANCH, MITRE10_MOULDINGS, MITRE10_PLY, MITRE10_SOURCE } from "./mitre10-data";
import * as s from "./schema";

/** Overhead 30% -> inefficiency 5% (fixed) -> profit 40%. Mirrors MARKUP in api/lib/pricing.ts. */
const sell = (cost: number) => Math.round(cost * 1.3 * 1.05 * 1.4 * 100) / 100;

type ProductSeed = typeof s.products.$inferInsert;

/** The warning that rides on a line whose quote has lapsed. */
function expiryNote(quoteExpiry: string, daysLeft: number, what: string) {
  if (daysLeft < 0) {
    return `PRICE EXPIRED ${quoteExpiry} (${Math.abs(daysLeft)} days ago). Re-quote ${MITRE10_BRANCH} before this goes on a customer quote.`;
  }
  return `Quoted price, valid to ${quoteExpiry} — ${daysLeft} days left. Re-quote ${what} after that.`;
}

function buildPly(supplierId: number): ProductSeed[] {
  return MITRE10_PLY.map((r) => ({
    supplierId,
    supplier: MITRE10_BRANCH,
    brand: "Mitre 10",
    // T&G and STRUCTURAL both in the name: this is the joist sheet, and the
    // whole point is that it is never confused with Hurford's overlay.
    range: r.isSelex ? "Structural Plywood T&G F8 (SELEX)" : "Structural Plywood T&G F8",
    colour: "",
    category: "sheet_goods",
    tier: "Structural F8",
    // Priced, stocked and ordered by the sheet.
    unit: "each",
    size: `${r.sizePrinted}mm`,
    lengthMm: r.lengthMm,
    widthMm: r.widthMm,
    thicknessMm: r.thicknessMm,
    unitM2: r.sheetM2,

    costPrice: r.pricePerSheet,
    sellPrice: sell(r.pricePerSheet),
    // No pack/loose split on this quote — one rate whatever the quantity.
    cutCostPrice: null,
    cutUpliftPct: null,
    rollM2: null,
    priceValidUntil: r.quoteExpiry,
    availabilityNote: expiryNote(r.quoteExpiry, r.daysLeft, "the branch"),

    sku: r.code,
    variantKey: `mitre10|structural-ply-tg-f8|${r.thicknessMm}mm|${r.code}`.toLowerCase(),
    sourceNote:
      `Quoted ${r.quoteDate} by ${MITRE10_BRANCH}, $${r.pricePerSheet.toFixed(2)} a sheet ex GST. ` +
      `$${r.perMmPerM2.toFixed(4)} per mm of thickness per m2` +
      (r.outOfBand
        ? ` — WELL ABOVE the 1.34-1.52 the 9-18mm sheets hold. This is the SELEX line, a different product and a different code format, so the jump is real and not a typo.`
        : `, in line with the rest of the range.`),
    notes:
      `${MITRE10_SOURCE}. STRUCTURAL F8, T&G edge — spans JOISTS. Not interchangeable with Hurford's CD ` +
      `non-structural, which is slab overlay only. ${r.sheetM2} m2 a sheet. Mitre 10 delivers, $80 + GST.`,
  }));
}

function buildMouldings(supplierId: number): ProductSeed[] {
  return MITRE10_MOULDINGS.map((r) => {
    const priceNote = r.realPremium
      ? `REAL PREMIUM: $${r.priceEach.toFixed(2)} against $${r.sizeBandBase.toFixed(2)} for the cheapest ${r.sizePrinted} profile, a $${(r.priceEach - r.sizeBandBase).toFixed(2)} difference. Charge it — this profile genuinely costs more.`
      : r.roundingNoise
        ? `Within a cent of the $${r.sizeBandBase.toFixed(2)} band base for ${r.sizePrinted}. That cent is an inc-GST division artifact, not a price difference.`
        : `Band base for ${r.sizePrinted}; nothing cheaper in this size.`;

    return {
      supplierId,
      supplier: MITRE10_BRANCH,
      brand: "Mitre 10",
      range: `Pine Moulding ${r.profile}`,
      colour: "",
      // A skirting or scotia is a trim, same as every other supplier's.
      category: "accessory",
      tier: "Moulding",
      // ONE WHOLE 5.4m LENGTH. Not per metre — it cannot be bought cut.
      unit: "each",
      size: `${r.sizePrinted} x ${r.lengthM}m`,
      lengthMm: r.lengthMm,
      widthMm: r.faceMm,
      thicknessMm: r.thicknessMm,

      costPrice: r.priceEach,
      sellPrice: sell(r.priceEach),
      cutCostPrice: null,
      cutUpliftPct: null,
      rollM2: null,
      // One length is the smallest purchase there is.
      minOrderQty: 1,
      priceValidUntil: r.quoteExpiry,
      availabilityNote: expiryNote(r.quoteExpiry, r.daysLeft, `quote ${r.quoteNo}`),

      sku: r.code,
      variantKey: `mitre10|moulding|${r.profile}|${r.sizePrinted}|${r.code}`
        .toLowerCase()
        .replace(/\s+/g, "-"),
      sourceNote:
        `${r.product}, quote ${r.quoteNo} dated ${r.quoteDate}. $${r.priceEach.toFixed(2)} ex GST per whole ` +
        `${r.lengthM}m length. ${priceNote}`,
      notes:
        `${MITRE10_SOURCE}. Sold as a whole ${r.lengthM}m length, NOT by the metre — ` +
        `$${r.pricePerM.toFixed(2)}/m is for comparison against per-metre suppliers only, never an order quantity. ` +
        `${r.faceMm}mm face x ${r.thicknessMm}mm.`,
    };
  });
}

async function main() {
  const [supplier] = await db.select().from(s.suppliers).where(eq(s.suppliers.code, "mitre10"));
  if (!supplier) throw new Error("Seed suppliers first — no Mitre 10 supplier row found.");

  const items = [...buildPly(supplier.id), ...buildMouldings(supplier.id)];
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

  const expired = items.filter((i) => i.availabilityNote?.startsWith("PRICE EXPIRED")).length;
  const premium = MITRE10_MOULDINGS.filter((m) => m.realPremium).length;
  console.log(`Mitre 10: ${created} created, ${updated} updated of ${items.length} lines`);
  console.log(`  ${MITRE10_PLY.length} structural T&G ply sheets, ${MITRE10_MOULDINGS.length} mouldings`);
  console.log(`  ${expired} lines carry an EXPIRED quote price and need re-quoting`);
  console.log(`  ${premium} mouldings carry a real premium over their size band, not rounding noise`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
