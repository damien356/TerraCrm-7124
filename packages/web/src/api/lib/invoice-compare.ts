import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { compareToPo, type ChargeRule, type Comparison, type InvLine, type PoLine } from "./charge-match";

/* ---------------------------------------------------------------------------
 * One supplier invoice against its saved PO, line by line (charge-match.ts).
 *
 * The match note, the price checks and the invoice panel all read this, so
 * the three always group the lines the same way. Reads only.
 * ------------------------------------------------------------------------- */

type InvoiceRow = typeof schema.supplierInvoices.$inferSelect;

const r2 = (n: number) => Math.round(n * 100) / 100;

export const invoiceLines = (inv: Pick<InvoiceRow, "lines">): InvLine[] => {
  try {
    const v = JSON.parse(inv.lines) as InvLine[] | null;
    return (v ?? []).filter((l) => l && typeof l.description === "string");
  } catch {
    return [];
  }
};

const exGst = (i: Pick<InvoiceRow, "totalExGst" | "totalIncGst" | "gst">) => r2(i.totalExGst ?? (i.gst !== null ? i.totalIncGst - i.gst : i.totalIncGst / 1.1));

export type InvoiceComparison = Comparison & { poId: number | null; hasLines: boolean };

/** The comparison for one invoice, or null for a credit or an invoice that cannot be read. */
export async function compareInvoice(invOrId: number | InvoiceRow): Promise<InvoiceComparison | null> {
  const inv = typeof invOrId === "number" ? (await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invOrId)))[0] : invOrId;
  if (!inv || inv.docType === "credit") return null;
  const lines = invoiceLines(inv);
  const rules: ChargeRule[] = inv.supplierId
    ? await db
        .select()
        .from(schema.supplierFeeRules)
        .where(and(eq(schema.supplierFeeRules.supplierId, inv.supplierId), eq(schema.supplierFeeRules.active, true)))
    : [];
  const [po] = inv.poId ? await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, inv.poId)) : [];
  const poLines: PoLine[] = po
    ? (await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id))).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    : [];
  const productIds = [...new Set(poLines.map((l) => l.productId).filter((x): x is number => x != null))];
  const skus = productIds.length ? await db.select({ id: schema.products.id, sku: schema.products.sku }).from(schema.products).where(inArray(schema.products.id, productIds)) : [];
  const skuByProductId = new Map(skus.filter((s) => s.sku).map((s) => [s.id, s.sku!]));
  const cmp = compareToPo({ totalExGst: exGst(inv), lines }, po ? { number: po.number, totalExGst: po.totalExGst, lines: poLines } : null, rules, { skuByProductId });
  return { ...cmp, poId: po?.id ?? null, hasLines: cmp.classified.some((c) => !c.skipped) };
}
