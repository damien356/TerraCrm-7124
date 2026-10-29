import { and, desc, eq, gte, inArray, lt, notInArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { localDate } from "./local-date";
import { asSalesCategory, SALES_CATEGORIES, salesAccountsView, type SalesCategory } from "./xero-invoices";

/* ---------------------------------------------------------------------------
 * Sales by category (Task H, Damien 29 Oct).
 *
 * Customer sales (Xero 200) and installer materials sales (Xero 204) shown
 * apart, by the category on each invoice. Never by how it was paid: an
 * installer materials sale settled by contra is still an installer materials
 * sale, with its GST, and the contra shows as how it was paid.
 *
 * Invoices raised in the range, not draft or void. Payments are each payment
 * Ops recorded on them (invoice_payments). A payment recorded before that
 * table existed is put under the invoice's payment method, or "not split"
 * when the invoice had more than one kind.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type PaidSplit = { bank: number; card: number; cash: number; other: number; contra: number; notSplit: number };
const zeroSplit = (): PaidSplit => ({ bank: 0, card: 0, cash: 0, other: 0, contra: 0, notSplit: 0 });
const KNOWN = new Set(["bank", "card", "cash", "other", "contra"]);

function addTo(split: PaidSplit, method: string | null | undefined, amount: number) {
  const k = (method && KNOWN.has(method) ? method : "notSplit") as keyof PaidSplit;
  split[k] = r2(split[k] + amount);
}

/** YYYY-MM-DD in Brisbane to the start of that day. */
const dayStart = (d: string) => new Date(`${d}T00:00:00+10:00`);
const nextDay = (d: string) => new Date(dayStart(d).getTime() + 86_400_000);

export async function salesByCategory(range: { from?: string | null; to?: string | null }) {
  const conds = [notInArray(schema.invoices.status, ["draft", "void"])];
  if (range.from) conds.push(gte(schema.invoices.createdAt, dayStart(range.from)));
  if (range.to) conds.push(lt(schema.invoices.createdAt, nextDay(range.to)));
  const rows = await db
    .select({
      i: schema.invoices,
      companyName: schema.companies.name,
      contactFirst: schema.contacts.firstName,
      contactLast: schema.contacts.lastName,
    })
    .from(schema.invoices)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.invoices.billToCompanyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.invoices.billToContactId))
    .where(and(...conds))
    .orderBy(desc(schema.invoices.id));

  const ids = rows.map((r) => r.i.id);
  const pays = ids.length ? await db.select().from(schema.invoicePayments).where(inArray(schema.invoicePayments.invoiceId, ids)) : [];
  const byInvoice = new Map<number, typeof pays>();
  for (const p of pays) byInvoice.set(p.invoiceId, [...(byInvoice.get(p.invoiceId) ?? []), p]);

  const blank = () => ({ count: 0, total: 0, gst: 0, exGst: 0, paid: zeroSplit(), received: 0, owing: 0 });
  const categories: Record<SalesCategory, ReturnType<typeof blank>> = { customer: blank(), installer_materials: blank() };
  const materials: Array<{
    id: number;
    number: string;
    jobId: number | null;
    who: string;
    date: string;
    status: string;
    total: number;
    gst: number;
    paid: PaidSplit;
    owing: number;
    inXero: boolean;
    xeroSalesAccount: string | null;
  }> = [];

  for (const r of rows) {
    const inv = r.i;
    const cat = asSalesCategory(inv.salesCategory);
    const split = zeroSplit();
    const mine = byInvoice.get(inv.id) ?? [];
    for (const p of mine) addTo(split, p.method, p.amount);
    // Paid before payments were kept one by one.
    const earlier = r2(inv.amountPaid - mine.reduce((a, p) => a + p.amount, 0));
    if (earlier > 0.005) addTo(split, inv.paymentMethod === "part_contra" ? null : inv.paymentMethod, earlier);
    const owing = r2(Math.max(0, inv.total - inv.amountPaid));

    const c = categories[cat];
    c.count += 1;
    c.total = r2(c.total + inv.total);
    c.gst = r2(c.gst + inv.gst);
    c.exGst = r2(c.exGst + inv.subtotal);
    c.received = r2(c.received + inv.amountPaid);
    c.owing = r2(c.owing + owing);
    for (const k of Object.keys(split) as (keyof PaidSplit)[]) c.paid[k] = r2(c.paid[k] + split[k]);

    if (cat === "installer_materials") {
      materials.push({
        id: inv.id,
        number: inv.number,
        jobId: inv.jobId,
        who: r.companyName ?? [r.contactFirst, r.contactLast].filter(Boolean).join(" "),
        date: localDate(inv.createdAt),
        status: inv.status,
        total: r2(inv.total),
        gst: r2(inv.gst),
        paid: split,
        owing,
        inXero: !!inv.xeroInvoiceId,
        xeroSalesAccount: inv.xeroSalesAccount,
      });
    }
  }

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    accounts: await salesAccountsView(),
    order: SALES_CATEGORIES,
    categories,
    materials,
  };
}
