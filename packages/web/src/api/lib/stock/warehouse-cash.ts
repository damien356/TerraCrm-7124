import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { iso, settleDate, termsLabel, today } from "../cashflow";
import { costCashOut } from "../gst";
import { supplierTermsMap, DEFAULT_SUPPLIER_TERMS, type SupplierTerms } from "../supplier-terms";

/* ---------------------------------------------------------------------------
 * A2 (decision 3): warehouse POs in the cash forecast. Internal only; Xero is
 * never touched.
 *
 *  - Sent (or marked sent) and invoiced warehouse POs are committed money out.
 *    Being sent does not mean the money is due that day: the date is the
 *    expected payment date an Admin typed, else the supplier's terms.
 *  - No expected payment date and no supplier terms: the PO is flagged and
 *    left off the dated forecast. A date is never invented.
 *  - A supplier deposit and the balance are separate lines.
 *  - Drafts are "Planned purchase (draft)", pipeline only, never committed.
 *  - A bill matched to the PO replaces the estimate. A part bill replaces
 *    only its share; the rest of the estimate stays. Unpaid bills are dated by
 *    the bill. Paid bills drop out, so payments reduce what is left.
 *  - Receiving, reserving and issuing stock add nothing here. Only the PO
 *    and its bills are money.
 * ------------------------------------------------------------------------- */

type NewEvent = typeof schema.cashEvents.$inferInsert;
type Po = typeof schema.purchaseOrders.$inferSelect;
type Bill = typeof schema.supplierInvoices.$inferSelect;

export type UndatedPo = { poId: number; number: string; supplier: string; part: "deposit" | "balance" | "bill"; amountIncGst: number; status: string; why: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const billEx = (b: Pick<Bill, "totalExGst" | "totalIncGst" | "gst">) =>
  b.totalExGst ?? (b.gst != null ? r2(b.totalIncGst - b.gst) : r2(b.totalIncGst / 1.1));

export const UNDATED_TEXT = "No expected payment date and no supplier terms. Enter one on the warehouse order.";

/** What the PO is still expected to cost ex GST: its total, less any line the supplier will not deliver. */
function estimateEx(po: Po, lines: Array<typeof schema.purchaseOrderLines.$inferSelect>) {
  let closedOff = 0;
  for (const l of lines) {
    if (l.kind !== "goods" || !l.closedAt) continue;
    closedOff += Math.max(0, l.qty - l.receivedQty) * l.unitCostExGst;
  }
  return r2(Math.max(0, po.totalExGst - closedOff));
}

export async function warehouseCash(now = today()): Promise<{ events: NewEvent[]; undated: UndatedPo[] }> {
  const pos = await db
    .select({ po: schema.purchaseOrders, supplier: schema.suppliers.name })
    .from(schema.purchaseOrders)
    .leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .where(and(eq(schema.purchaseOrders.kind, "warehouse"), inArray(schema.purchaseOrders.status, ["draft", "sent", "invoiced"])));
  const events: NewEvent[] = [];
  const undated: UndatedPo[] = [];
  if (!pos.length) return { events, undated };
  const ids = pos.map((p) => p.po.id);
  const [lines, bills, terms] = await Promise.all([
    db.select().from(schema.purchaseOrderLines).where(inArray(schema.purchaseOrderLines.poId, ids)),
    db.select().from(schema.supplierInvoices).where(inArray(schema.supplierInvoices.poId, ids)),
    supplierTermsMap(),
  ]);

  for (const { po, supplier } of pos) {
    const name = supplier ?? "Supplier";
    const t: SupplierTerms = terms.get(po.supplierId) ?? DEFAULT_SUPPLIER_TERMS;
    const myBills = bills.filter((b) => b.poId === po.id);
    const est = estimateEx(po, lines.filter((l) => l.poId === po.id));
    const draft = po.status === "draft";
    const base = po.sentAt ? iso(po.sentAt) : now;
    const label = (part: string) => `${draft ? "Planned purchase (draft) " : ""}${po.number} ${name}, warehouse stock${part ? `, ${part}` : ""}`;
    const flag = (part: UndatedPo["part"], amountIncGst: number, why = UNDATED_TEXT) =>
      undated.push({ poId: po.id, number: po.number, supplier: name, part, amountIncGst: r2(amountIncGst), status: po.status, why });
    const push = (amountEx: number, part: string, date: string, basis: string) => {
      if (amountEx <= 0.5) return;
      events.push({
        direction: "out",
        confidence: draft ? "pipeline" : "committed",
        kind: "materials",
        jobId: null,
        label: label(part),
        amount: costCashOut(amountEx, "materials", false),
        dueDate: date,
        basis: `${basis}, plus GST`,
      });
    };

    /* --- bills: each one replaces its share of the estimate --- */
    const billed = r2(myBills.reduce((a, b) => a + (b.docType === "credit" ? -1 : 1) * billEx(b), 0));
    for (const b of myBills) {
      if (b.docType === "credit" || b.payState === "paid") continue;
      const date = b.dueDate ?? (b.invoiceDate && t.set ? settleDate(b.invoiceDate, t.days, t.eom) : null);
      if (!date) {
        flag("bill", b.totalIncGst, `Bill ${b.invoiceNumber} has no due date and the supplier has no terms. Enter terms on the supplier.`);
        continue;
      }
      events.push({
        direction: "out",
        confidence: "committed",
        kind: "materials",
        jobId: null,
        label: `${po.number} ${name}, warehouse stock, bill ${b.invoiceNumber}`,
        amount: r2(b.totalIncGst),
        dueDate: date,
        basis: b.dueDate ? "due date on the bill" : `bill date, then supplier terms ${termsLabel(t.days, t.eom)}`,
      });
    }

    /* --- what is not billed yet: deposit first, then the balance --- */
    const remaining = r2(Math.max(0, est - billed));
    if (remaining <= 0.5) continue;
    const deposit = r2(Math.min(remaining, Math.max(0, (po.supplierDepositExGst ?? 0) - Math.max(0, billed))));
    const balance = r2(remaining - deposit);
    if (deposit > 0.5) {
      if (po.supplierDepositDue) push(deposit, "supplier deposit", po.supplierDepositDue, "supplier deposit date entered");
      else flag("deposit", costCashOut(deposit, "materials", false), "Supplier deposit has no due date. Enter one on the warehouse order.");
    }
    if (balance > 0.5) {
      const part = deposit > 0.5 || po.supplierDepositExGst ? "balance" : billed > 0.5 ? "not billed yet" : "";
      if (po.expectedPayDate) push(balance, part, po.expectedPayDate, "expected payment date entered");
      else if (t.set)
        push(balance, part, settleDate(base, t.days, t.eom), `supplier terms ${termsLabel(t.days, t.eom)} from the ${draft ? "day it would be sent (today)" : "date sent"}`);
      else flag("balance", costCashOut(balance, "materials", false));
    }
  }
  return { events, undated };
}

/** For the forecast page: warehouse POs left off because no date could be worked out. */
export async function warehouseUndated() {
  return (await warehouseCash()).undated;
}
