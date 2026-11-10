import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { SUPPLIER_CHARGE } from "./line-kinds";
import { planQuoteFreight, supplierChargesMarkupPct, type ChargeLineWant, type FreightLine, type FreightProduct, type FreightRule, type FreightSupplier } from "./quote-freight";

/* ---------------------------------------------------------------------------
 * Supplier charges on Sell products (Damien, 11 Nov 2026, job 188083).
 *
 * "the freight/baling fee was not added to the sale price, it is $35 per roll".
 * The quote builder puts each supplier's automatic charges (freight, baling,
 * handling, levies) on a quote as their own internal lines, sold at cost plus
 * Settings "Supplier charges markup %", and the customer's copy spreads them
 * into that supplier's product lines. Sell products now does the same, with
 * the same rules (lib/quote-freight.ts planQuoteFreight), so a Belgotex cut
 * carries its Broadloom baling.
 *
 * Only what is ordered from the supplier makes a charge: ordering ticked, and
 * the qty not coming from stock now. Stock off the shelf was already bought.
 * A typed line (no product) or a product with no cost makes none.
 * ------------------------------------------------------------------------- */

export type SaleCharge = ChargeLineWant;

export type ChargeSource = { productId: number | null; toOrder: number; unitCost: number | null; unitPrice: number };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export async function saleChargesFor(lines: ChargeSource[], orderNeeded: boolean): Promise<SaleCharge[]> {
  if (!orderNeeded) return [];
  const used = lines.filter((l) => l.productId != null && l.toOrder > 0.00005 && (l.unitCost ?? 0) > 0);
  if (!used.length) return [];
  const ids = [...new Set(used.map((l) => l.productId!))];
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  const supplierIds = [...new Set(products.map((p) => p.supplierId).filter((x): x is number => x != null))];
  if (!supplierIds.length) return [];
  const [suppliers, rules] = await Promise.all([
    db.select().from(schema.suppliers).where(inArray(schema.suppliers.id, supplierIds)),
    db
      .select()
      .from(schema.supplierFeeRules)
      .where(and(inArray(schema.supplierFeeRules.supplierId, supplierIds), eq(schema.supplierFeeRules.active, true))),
  ]);
  // Same as the PO helper: an inactive or No PO needed supplier is ordered by hand, so no charge is guessed.
  const live = suppliers.filter((s) => s.active && !s.noPoNeeded);
  const freightLines: FreightLine[] = used.map((l, i) => ({
    id: i + 1,
    productId: l.productId,
    lineType: "material",
    kind: "supply",
    qty: l.toOrder,
    unitCost: l.unitCost,
    unitPrice: l.unitPrice,
    listUnitPrice: null,
    freightUnitCost: null,
    chargeSupplierId: null,
  }));
  const plan = planQuoteFreight(
    freightLines,
    new Map(products.map((p) => [p.id, p as FreightProduct])),
    new Map(live.map((s) => [s.id, s as FreightSupplier])),
    [...rules].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) as FreightRule[],
    await supplierChargesMarkupPct(),
  );
  return plan.charges;
}

/** What a person sees of the charges. Logins without costs see one total, not the supplier's rates. */
export function chargesView(charges: { description: string; total: number; flagReason: string | null }[], canSeeCosts: boolean) {
  if (!charges.length) return [];
  if (canSeeCosts) return charges.map((c) => ({ description: c.description, total: c.total, flagReason: c.flagReason }));
  return [
    {
      description: "Supplier charges (freight, baling, handling)",
      total: r2(charges.reduce((a, c) => a + c.total, 0)),
      flagReason: charges.find((c) => c.flagReason)?.flagReason ?? null,
    },
  ];
}

/** The quote line values for one charge (kind supplier_charge, as refreshQuoteFreight writes them). */
export function chargeItemValues(c: SaleCharge) {
  return {
    kind: SUPPLIER_CHARGE,
    lineType: "material",
    chargeSupplierId: c.supplierId,
    chargeKey: c.key,
    description: c.description,
    qty: c.qty,
    unit: c.unit,
    unitCost: c.unitCost,
    unitPrice: c.unitPrice,
    total: c.total,
    markupPercent: c.markupPercent,
    flagged: c.flagged,
    flagReason: c.flagReason,
  };
}
