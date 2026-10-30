import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { invoiceExGst, tolerance } from "./invoice-match";

/**
 * PRODUCT SALE COSTS (Damien, 31 Oct, job 188054).
 *
 * What a Sell products job costs, line by line, with expected and actual kept
 * apart and nothing counted twice:
 *
 *  - Expected: what is on a PO for the line (draft or sent), and for the rest
 *    of the line the cost price typed on the line, else the price book cost.
 *  - Actual: the supplier bills matched to that PO. A PO with its bills in
 *    counts at the bills instead of its own total, never both. The PO's line
 *    in Money out is the same money, so it is never added on top.
 *  - Missing: any quantity with none of the above. While any line has a
 *    missing quantity the margin stays unavailable. A cost typed by hand in
 *    Money out, or a bill not matched to a PO, is shown but never fills a
 *    gap: it is not tied to a line, so it cannot say which line it paid for.
 *
 * From stock never changes what has been delivered or collected. It only
 * means that part of the line has no PO.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export type SaleCostLine = {
  quoteItemId: number;
  description: string;
  qty: number;
  unit: string;
  fromStock: number;
  /** Qty on a PO (not cancelled). */
  poQty: number;
  /** PO goods total for that qty, ex GST. */
  poExpected: number;
  /** The rest of the line, not on a PO. */
  restQty: number;
  /** Per unit for the rest, and where it came from. Null when missing. */
  restUnitCost: number | null;
  restBasis: "cost price" | "price book" | null;
  /** Expected for the whole line, null while any of it is missing. */
  expected: number | null;
  missingQty: number;
};

export type SaleCostPo = {
  id: number;
  number: string;
  status: string;
  /** The PO total ex GST: goods, charges and freight. */
  expected: number;
  /** Matched supplier bills, ex GST, credits taken off. Null with none in. */
  billed: number | null;
  bills: number;
  /** What counts: the bills once they cover the PO, else the PO total. */
  counts: number;
  countsAs: "bills" | "PO";
};

export type SaleCosts = {
  saleId: number;
  /** quote · invoice. An invoice sale's quote was accepted by Raise invoice now, not by the customer. */
  mode: string;
  lines: SaleCostLine[];
  pos: SaleCostPo[];
  /** Sum of expected: PO totals plus the rest of each line. */
  expected: number;
  /** Sum of matched supplier bills. */
  actual: number;
  /** What the margin uses: PO at its bills when in, else expected. */
  materials: number;
  missing: string[];
  unknown: boolean;
  /** Typed in Money out by hand. Shown, never counted. */
  hand: { count: number; total: number };
  /** Supplier bills on this job not matched to a PO. Shown, never counted. */
  unmatchedBills: { count: number; total: number };
};

/** Null when the job is not a Sell products job. */
export async function saleCosts(jobId: number): Promise<SaleCosts | null> {
  const [sale] = await db
    .select()
    .from(schema.productSales)
    .where(eq(schema.productSales.jobId, jobId))
    .orderBy(desc(schema.productSales.id))
    .limit(1);
  if (!sale) return null;

  const saleLines = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, sale.id));
  const itemIds = saleLines.map((l) => l.quoteItemId).filter((id): id is number => id != null);
  const items = itemIds.length ? await db.select().from(schema.quoteItems).where(inArray(schema.quoteItems.id, itemIds)) : [];
  const productIds = saleLines.map((l) => l.productId).filter((id): id is number => id != null);
  const products = productIds.length
    ? await db.select({ id: schema.products.id, costPrice: schema.products.costPrice }).from(schema.products).where(inArray(schema.products.id, productIds))
    : [];
  const mats = saleLines.length
    ? await db.select().from(schema.jobMaterials).where(inArray(schema.jobMaterials.saleLineId, saleLines.map((l) => l.id)))
    : [];
  const pos = await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.jobId, jobId), ne(schema.purchaseOrders.status, "cancelled")));
  const poIds = pos.map((p) => p.id);
  const poLines = poIds.length ? await db.select().from(schema.purchaseOrderLines).where(inArray(schema.purchaseOrderLines.poId, poIds)) : [];
  const bills = await db
    .select()
    .from(schema.supplierInvoices)
    .where(eq(schema.supplierInvoices.jobId, jobId));
  const poBills = poIds.length
    ? await db.select().from(schema.supplierInvoices).where(inArray(schema.supplierInvoices.poId, poIds))
    : [];
  const handRows = await db
    .select({ amount: schema.jobCosts.amount })
    .from(schema.jobCosts)
    .where(
      and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.source, ""), eq(schema.jobCosts.kind, "materials")),
    );

  const signed = (i: typeof schema.supplierInvoices.$inferSelect) => (i.docType === "credit" ? -1 : 1) * invoiceExGst(i);

  const lines: SaleCostLine[] = saleLines
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((l) => {
      const item = items.find((i) => i.id === l.quoteItemId);
      const qty = item?.qty ?? l.qty;
      const matIds = new Set(mats.filter((m) => m.saleLineId === l.id).map((m) => m.id));
      const onPo = poLines.filter((p) => p.jobMaterialId != null && matIds.has(p.jobMaterialId));
      const poQty = round2(onPo.reduce((a, p) => a + (p.qty ?? 0), 0));
      const poExpected = round2(onPo.reduce((a, p) => a + (p.totalExGst ?? 0), 0));
      const restQty = round2(Math.max(0, qty - poQty));
      const priceBook = products.find((p) => p.id === l.productId)?.costPrice ?? null;
      const restUnitCost = item?.unitCost ?? priceBook;
      const restBasis = item?.unitCost != null ? ("cost price" as const) : priceBook != null ? ("price book" as const) : null;
      const missingQty = restQty > 0 && restUnitCost == null ? restQty : 0;
      return {
        quoteItemId: item?.id ?? l.quoteItemId ?? 0,
        description: item?.description ?? l.description,
        qty,
        unit: item?.unit ?? l.unit,
        fromStock: l.fromStock,
        poQty,
        poExpected,
        restQty,
        restUnitCost: restQty > 0 ? restUnitCost : null,
        restBasis: restQty > 0 ? restBasis : null,
        expected: missingQty > 0 ? null : round2(poExpected + restQty * (restUnitCost ?? 0)),
        missingQty,
      };
    });

  const poViews: SaleCostPo[] = pos.map((p) => {
    const mine = poBills.filter((b) => b.poId === p.id);
    const billed = mine.length ? round2(mine.reduce((a, b) => a + signed(b), 0)) : null;
    // Same rule as settlePo: bills that fall short are a part delivery, so the PO still stands.
    const covers = billed != null && billed >= p.totalExGst - tolerance(p.totalExGst);
    return {
      id: p.id,
      number: p.number,
      status: p.status,
      expected: round2(p.totalExGst),
      billed,
      bills: mine.length,
      counts: covers ? billed! : round2(p.totalExGst),
      countsAs: covers ? ("bills" as const) : ("PO" as const),
    };
  });

  const rest = round2(lines.reduce((a, l) => a + (l.restQty > 0 && l.restUnitCost != null ? l.restQty * l.restUnitCost : 0), 0));
  const unmatched = bills.filter((b) => b.poId == null || !poIds.includes(b.poId));
  const missing = lines.filter((l) => l.missingQty > 0).map((l) => l.description);

  return {
    saleId: sale.id,
    mode: sale.mode,
    lines,
    pos: poViews,
    expected: round2(rest + poViews.reduce((a, p) => a + p.expected, 0)),
    actual: round2(poViews.reduce((a, p) => a + (p.billed ?? 0), 0)),
    materials: round2(rest + poViews.reduce((a, p) => a + p.counts, 0)),
    missing,
    unknown: missing.length > 0,
    hand: { count: handRows.length, total: round2(handRows.reduce((a, r) => a + (r.amount ?? 0), 0)) },
    unmatchedBills: { count: unmatched.length, total: round2(unmatched.reduce((a, b) => a + signed(b), 0)) },
  };
}
