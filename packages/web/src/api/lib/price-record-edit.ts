import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { resolveAiActionsForPo } from "./ai-actions";
import { emailedAtFor } from "./invoice-emailed";
import { syncJobValue } from "./job-value";
import { markupOf } from "./pricing";
import { bookCostsOf, LIVE_HOLDS, oneAtATime, orderForSale, priceLines, saleOfJob, syncSaleLines, totalsOf, type Priced } from "./product-sale";
import { pricePo, writeLines, type PoLineInput } from "./purchase-orders";
import { quoteRefOf } from "./quote-number";

/* ---------------------------------------------------------------------------
 * Edit price record (Damien, 11 Nov 2026, job 188083).
 *
 * Sell products, Raise invoice now, saves its lines as a quote marked
 * accepted inside Ops so the invoice has something to bill from. Until now
 * those lines were locked like a customer's accepted quote. They are not a
 * customer acceptance, so while nothing has left Terra they can be changed:
 *
 *   - the invoice has not been emailed, is not in Xero, and has no payment,
 *     card payment, contra or credit on it;
 *   - every PO on the job is still a draft (nothing sent to a supplier);
 *   - nothing is handed over, held, cut or picked in stock.
 *
 * One save changes, together: the quote lines and totals, the job value,
 * the invoice amounts (same invoice number, same label), the sale lines and
 * From stock now, the materials to order, and the draft POs (re-priced in
 * place, a draft left with nothing on it is removed and kept as cancelled).
 * New lines are ordered as drafts when ordering is on. Nothing is emailed,
 * sent to Xero or sent to a supplier. Every change goes on the job history.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number, unit: string) => `${r4(n)} ${unit === "m2" ? "m²" : unit}`;
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const auDay = (d: Date) => d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" });

export const PRICE_RECORD_EDITED = "price_record_edited";

export type EditLineIn = {
  /** The quote line being changed. Left out for a new line. */
  quoteItemId?: number | null;
  productId?: number | null;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  /** What Terra pays, ex GST. Left out keeps the line's cost. Never on the invoice. */
  unitCost?: number | null;
  fromStock?: number | null;
};

type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;

async function load(jobId: number) {
  const sale = await saleOfJob(jobId);
  if (!sale || !sale.quoteId) return null;
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, sale.quoteId));
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!quote || !job) return null;
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id)).orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  const lines = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, sale.id)).orderBy(asc(schema.productSaleLines.sortOrder), asc(schema.productSaleLines.id));
  const invoices = await db.select().from(schema.invoices).where(and(eq(schema.invoices.jobId, jobId), ne(schema.invoices.status, "void"))).orderBy(asc(schema.invoices.id));
  const mats = lines.length ? await db.select().from(schema.jobMaterials).where(inArray(schema.jobMaterials.saleLineId, lines.map((l) => l.id))) : [];
  const pos = await db.select().from(schema.purchaseOrders).where(and(eq(schema.purchaseOrders.jobId, jobId), ne(schema.purchaseOrders.status, "cancelled"))).orderBy(asc(schema.purchaseOrders.id));
  const poLines = pos.length ? await db.select().from(schema.purchaseOrderLines).where(inArray(schema.purchaseOrderLines.poId, pos.map((p) => p.id))) : [];
  return { sale, quote, job, items, lines, invoices, mats, pos, poLines };
}

/** The reasons the lines can not change now. Empty means they can. */
async function blockersOf(s: Loaded): Promise<string[]> {
  const out: string[] = [];
  const { sale, quote, job, items, invoices, mats, pos, poLines } = s;
  if (sale.mode !== "invoice" || quote.status !== "accepted") {
    out.push("This is not a price record. Change a quote that is still a draft or sent in the quote builder as usual.");
    return out;
  }
  if (job.mergedIntoJobId) out.push("This job was merged into another job.");
  const [status] = job.statusId ? await db.select({ name: schema.jobStatuses.name }).from(schema.jobStatuses).where(eq(schema.jobStatuses.id, job.statusId)) : [];
  if (/cancel/i.test(status?.name ?? "")) out.push("This job is cancelled.");
  if (job.completedAt) out.push("The sale is marked complete.");

  if (items.some((i) => i.lineType === "labour" || !["supply", "accessory", "other"].includes(i.kind))) {
    out.push("This price record has lines Sell products does not make (labour, delivery or supplier charges). Change it with a variation.");
  }
  const lineSum = r2(items.reduce((t, i) => t + (i.total ?? 0), 0));
  if (Math.abs(lineSum - r2(quote.subtotal)) > 0.005) out.push(`The quote total (${money(quote.subtotal)} ex GST) is not the sum of its lines (${money(lineSum)}). Ask for it to be checked first.`);

  if (invoices.length !== 1) {
    out.push(invoices.length ? `This job has ${invoices.length} invoices (${invoices.map((i) => i.number).join(", ")}). Only a sale with one invoice can be changed here.` : "The invoice for this sale is void or missing.");
  }
  const inv = invoices[0];
  if (inv) {
    if (inv.kind !== "final" || (inv.quoteId != null && inv.quoteId !== quote.id)) out.push(`${inv.number} does not bill this price record.`);
    const emailed = (await emailedAtFor([inv.id])).get(inv.id);
    if (emailed || inv.issuedSnapshot) out.push(`${inv.number} was emailed${emailed ? ` on ${auDay(emailed)}` : ""}. Once the customer has it the amount can not change. Void it and sell again, or raise a credit.`);
    if (inv.xeroInvoiceId) out.push(`${inv.number} is in Xero.`);
    if (inv.amountPaid > 0.004) out.push(`${money(inv.amountPaid)} is paid on ${inv.number}.`);
    if (inv.stripePaymentIntentId) out.push(`A card payment was started on ${inv.number}.`);
    if (!["draft", "sent", "overdue"].includes(inv.status)) out.push(`${inv.number} is ${inv.status.replace("_", " ")}.`);
    const [pay] = await db.select({ id: schema.invoicePayments.id }).from(schema.invoicePayments).where(eq(schema.invoicePayments.invoiceId, inv.id)).limit(1);
    if (pay && !(inv.amountPaid > 0.004)) out.push(`A payment is recorded against ${inv.number}.`);
    const [contra] = await db.select({ id: schema.xeroContras.id }).from(schema.xeroContras).where(eq(schema.xeroContras.invoiceId, inv.id)).limit(1);
    if (contra) out.push(`${inv.number} has a contra against installer pay.`);
  }

  for (const po of pos) if (po.status !== "draft" || po.sentAt) out.push(`${po.number} has gone to the supplier.`);
  if (poLines.some((l) => l.receivedQty > 0)) out.push("Goods have been received against a PO on this job.");
  const poIds = pos.map((p) => p.id);
  if (poIds.length) {
    const [si] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(inArray(schema.supplierInvoices.poId, poIds)).limit(1);
    if (si) out.push("A supplier bill is matched to a PO on this job.");
  }
  if (mats.some((m) => m.status !== "to_order")) out.push("Some of it is already marked ordered.");
  if (mats.length) {
    const [link] = await db
      .select({ id: schema.stockPoLinks.id })
      .from(schema.stockPoLinks)
      .where(and(inArray(schema.stockPoLinks.jobMaterialId, mats.map((m) => m.id)), eq(schema.stockPoLinks.status, "open")))
      .limit(1);
    if (link) out.push("Some of it is on a warehouse order.");
  }
  if (s.lines.length) {
    const [hold] = await db
      .select({ id: schema.stockReservations.id })
      .from(schema.stockReservations)
      .where(and(inArray(schema.stockReservations.saleLineId, s.lines.map((l) => l.id)), inArray(schema.stockReservations.status, LIVE_HOLDS)))
      .limit(1);
    if (hold) out.push("Warehouse stock is held for this sale.");
  }
  const [hand] = await db.select({ id: schema.supplyHandovers.id }).from(schema.supplyHandovers).where(eq(schema.supplyHandovers.jobId, job.id)).limit(1);
  if (hand) out.push("Some of it is recorded as delivered or collected.");
  const [so] = await db.select({ id: schema.stockOrders.id }).from(schema.stockOrders).where(eq(schema.stockOrders.jobId, job.id)).limit(1);
  if (so) out.push("This sale has a stock order.");
  const [mv] = await db.select({ id: schema.stockMovements.id }).from(schema.stockMovements).where(eq(schema.stockMovements.jobId, job.id)).limit(1);
  if (mv) out.push("Warehouse stock has moved for this job.");
  return out;
}

/** Changes when anything on the record changes, so a stale screen can not save over a newer one. */
function stampOf(s: Loaded) {
  const inv = s.invoices[0];
  return JSON.stringify([
    r2(s.quote.total),
    s.items.map((i) => [i.id, i.productId, i.qty, i.unit, i.unitPrice, i.unitCost, i.description]),
    s.lines.map((l) => [l.id, l.fromStock]),
    inv ? [inv.id, r2(inv.total), inv.status] : null,
  ]);
}

/** What the edit window opens with. */
export async function priceRecordState(jobId: number, actor: { canSeeCosts: boolean }) {
  const s = await load(jobId);
  if (!s) return null;
  const blockers = await blockersOf(s);
  const productIds = [...new Set(s.items.map((i) => i.productId).filter((x): x is number => x != null))];
  const products = productIds.length
    ? await db
        .select({ id: schema.products.id, sku: schema.products.sku, size: schema.products.size, supplierId: schema.products.supplierId, heldInWarehouse: schema.products.heldInWarehouse })
        .from(schema.products)
        .where(inArray(schema.products.id, productIds))
    : [];
  const supIds = [...new Set(products.map((p) => p.supplierId).filter((x): x is number => x != null))];
  const sups = supIds.length ? await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supIds)) : [];
  const inv = s.invoices[0] ?? null;
  const book = actor.canSeeCosts ? await bookCostsOf(productIds) : new Map<number, number>();
  return {
    jobId,
    saleId: s.sale.id,
    quoteId: s.quote.id,
    quoteRef: await quoteRefOf(s.quote),
    isPriceRecord: s.sale.mode === "invoice" && s.quote.status === "accepted",
    editable: blockers.length === 0,
    blockers,
    stamp: stampOf(s),
    orderNeeded: s.sale.orderNeeded,
    invoice: inv ? { id: inv.id, number: inv.number, total: r2(inv.total), status: inv.status } : null,
    total: r2(s.quote.total),
    subtotal: r2(s.quote.subtotal),
    drafts: s.pos.map((p) => ({ number: p.number, totalExGst: r2(p.totalExGst), status: p.status })),
    lines: s.items.map((i) => {
      const p = products.find((x) => x.id === i.productId);
      const sl = s.lines.find((l) => l.quoteItemId === i.id);
      return {
        quoteItemId: i.id,
        productId: i.productId,
        description: i.description,
        detail: p ? [sups.find((x) => x.id === p.supplierId)?.name, p.size, p.sku ? `SKU ${p.sku}` : ""].filter(Boolean).join(" · ") : "",
        qty: i.qty,
        unit: i.unit,
        unitPrice: i.unitPrice,
        unitCost: actor.canSeeCosts ? i.unitCost : null,
        /** The price book cost today, to fill a blank cost. Only for logins that can see costs. */
        bookCost: actor.canSeeCosts && i.productId != null ? (book.get(i.productId) ?? null) : null,
        fromStock: sl?.fromStock ?? 0,
        stocked: !!p?.heldInWarehouse,
      };
    }),
  };
}

/* ------------------------------- the plan -------------------------------- */

type PlannedLine = Priced & { itemId: number | null; unitCost: number | null; keepDescription: boolean };
type DraftPlan = { poId: number; number: string; before: number; lines: PoLineInput[]; remove: boolean; priced: Awaited<ReturnType<typeof pricePo>> | null; saved: Record<string, unknown> };

async function planOf(s: Loaded, input: EditLineIn[]) {
  const seen = new Set<number>();
  for (const l of input) {
    if (l.quoteItemId == null) continue;
    if (seen.has(l.quoteItemId)) throw bad("The same line is on the list twice. Refresh the page and try again.");
    seen.add(l.quoteItemId);
    const it = s.items.find((i) => i.id === l.quoteItemId);
    if (!it) throw bad("A line has changed since you opened this. Close it and open Edit price record again.");
    // A line keeps its product. To swap a product, remove the line and add the new one.
    if ((l.productId ?? null) !== (it.productId ?? null)) throw bad(`"${it.description}": remove the line and add the new product instead of swapping it.`);
  }
  const priced = await priceLines(
    input.map((l) => ({ productId: l.productId ?? null, description: (l.description ?? "").trim(), qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, fromStock: l.fromStock ?? 0 })),
  );
  if (priced.length !== input.length) throw bad("Every line needs a description or a product.");
  const book = await bookCostsOf(priced.map((p) => p.productId));
  const planned: PlannedLine[] = priced.map((p, i) => {
    const l = input[i]!;
    const it = l.quoteItemId != null ? s.items.find((x) => x.id === l.quoteItemId) : undefined;
    // Left out: a line keeps its cost, a new line gets the price book cost (as Sell products and the quote builder do).
    const cost = l.unitCost === undefined ? (it ? (it.unitCost ?? null) : p.productId != null ? (book.get(p.productId) ?? null) : null) : l.unitCost;
    if (cost != null && !(cost >= 0)) throw bad(`"${p.description}": cost must be $0 or more.`);
    return { ...p, itemId: it?.id ?? null, unitCost: cost == null ? null : r2(cost), keepDescription: !!it };
  });
  const totals = totalsOf(planned);
  const removed = s.items.filter((i) => !planned.some((p) => p.itemId === i.id));

  // Materials: each line's to-order qty after the change, by the material that carries it now.
  const matPlan = new Map<number, { qty: number; productId: number | null; description: string; unit: string } | null>();
  for (const m of s.mats) {
    const sl = s.lines.find((l) => l.id === m.saleLineId);
    const p = sl?.quoteItemId != null ? planned.find((x) => x.itemId === sl.quoteItemId) : undefined;
    if (!p) {
      matPlan.set(m.id, null);
      continue;
    }
    const first = s.mats.find((x) => x.saleLineId === m.saleLineId)!;
    const want = r4(Math.max(0, p.qty - Math.min(p.qty, p.fromStock)));
    matPlan.set(m.id, first.id === m.id && want > 0.00005 ? { qty: want, productId: p.productId, description: p.description, unit: p.unit } : null);
  }

  // Draft POs that carry any of the sale's materials, re-priced as they will be.
  const supplierOf = new Map<number, number | null>();
  const pids = [...new Set(planned.map((p) => p.productId).filter((x): x is number => x != null))];
  if (pids.length) for (const r of await db.select({ id: schema.products.id, supplierId: schema.products.supplierId }).from(schema.products).where(inArray(schema.products.id, pids))) supplierOf.set(r.id, r.supplierId);
  const saleMatIds = new Set(s.mats.map((m) => m.id));
  const drafts: DraftPlan[] = [];
  for (const po of s.pos) {
    const mine = s.poLines.filter((l) => l.poId === po.id);
    if (!mine.some((l) => l.jobMaterialId != null && saleMatIds.has(l.jobMaterialId))) continue;
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(po.pricingInputs || "{}") as Record<string, unknown>;
    } catch {
      saved = {};
    }
    const base: PoLineInput[] = Array.isArray(saved.lines)
      ? (saved.lines as PoLineInput[])
      : mine
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .filter((l) => l.kind === "goods")
          .map((l) => ({ kind: "goods" as const, jobMaterialId: l.jobMaterialId, productId: l.productId, description: l.description, qty: l.qty, unit: l.unit }));
    const next: PoLineInput[] = [];
    for (const l of base) {
      if (l.kind !== "goods" || l.jobMaterialId == null || !saleMatIds.has(l.jobMaterialId)) {
        next.push(l);
        continue;
      }
      const m = matPlan.get(l.jobMaterialId);
      // Gone, or now from a different supplier: off this draft. A new draft is made for it if ordering is on.
      if (!m || m.productId == null || supplierOf.get(m.productId) !== po.supplierId) continue;
      next.push({ ...l, productId: m.productId, description: m.description, qty: m.qty, unit: m.unit });
    }
    const goods = next.filter((l) => l.kind === "goods");
    if (!goods.length) {
      drafts.push({ poId: po.id, number: po.number, before: r2(po.totalExGst), lines: [], remove: true, priced: null, saved });
      continue;
    }
    const priced = await pricePo({
      supplierId: po.supplierId,
      deliverTo: po.deliverTo as "warehouse" | "site" | "pickup",
      lines: next,
      feeIds: Array.isArray(saved.feeIds) ? (saved.feeIds as number[]) : [],
      skipFeeIds: Array.isArray(saved.skipFeeIds) ? (saved.skipFeeIds as number[]) : [],
      boxes: (saved.boxes as number | null | undefined) ?? null,
      rolls: (saved.rolls as number | null | undefined) ?? null,
      pallets: (saved.pallets as number | null | undefined) ?? null,
    }).catch((e: Error) => {
      throw bad(`${po.number} could not be re-priced: ${e.message}`);
    });
    drafts.push({ poId: po.id, number: po.number, before: r2(po.totalExGst), lines: next, remove: false, priced, saved });
  }

  // What the person reads before saving, line by line.
  const said: string[] = [];
  for (const p of planned) {
    const it = p.itemId != null ? s.items.find((i) => i.id === p.itemId) : undefined;
    if (!it) {
      said.push(`Add ${p.description}, ${qtyText(p.qty, p.unit)} at ${money(p.unitPrice)} = ${money(p.total)} ex GST`);
      continue;
    }
    const bits: string[] = [];
    if (Math.abs(it.qty - p.qty) > 0.00005 || it.unit !== p.unit) bits.push(`${qtyText(it.qty, it.unit)} to ${qtyText(p.qty, p.unit)}`);
    if (Math.abs(it.unitPrice - p.unitPrice) > 0.005) bits.push(`${money(it.unitPrice)} to ${money(p.unitPrice)} each`);
    if (it.description !== p.description) bits.push(`now reads "${p.description}"`);
    if ((it.unitCost ?? null) !== (p.unitCost ?? null)) bits.push(p.unitCost == null ? "cost cleared" : `cost ${it.unitCost == null ? "none" : money(it.unitCost)} to ${money(p.unitCost)}`);
    if (bits.length) said.push(`${it.description}: ${bits.join(", ")}${Math.abs(it.total - p.total) > 0.005 ? ` (${money(it.total)} to ${money(p.total)} ex GST)` : ""}`);
  }
  for (const r of removed) said.push(`Remove ${r.description}, ${qtyText(r.qty, r.unit)}, ${money(r.total)} ex GST`);
  const stockSaid: string[] = [];
  for (const p of planned) {
    const sl = p.itemId != null ? s.lines.find((l) => l.quoteItemId === p.itemId) : undefined;
    const before = sl?.fromStock ?? 0;
    const after = Math.min(p.qty, p.fromStock);
    if (sl && Math.abs(before - after) > 0.00005) stockSaid.push(`${p.description}: From stock now ${qtyText(before, p.unit)} to ${qtyText(after, p.unit)}`);
  }
  return { planned, totals, removed, matPlan, drafts, said, stockSaid };
}

/** What Save would do. Writes nothing. */
export async function previewPriceRecordEdit(args: { jobId: number; lines: EditLineIn[] }) {
  const s = await load(args.jobId);
  if (!s) throw bad("This job is not a Sell products sale.");
  const blockers = await blockersOf(s);
  if (blockers.length) throw bad(`Locked: ${blockers.join(" ")}`);
  const p = await planOf(s, args.lines);
  const inv = s.invoices[0]!;
  return {
    changes: p.said,
    stock: p.stockSaid,
    before: { subtotal: r2(s.quote.subtotal), gst: r2(s.quote.gst), total: r2(s.quote.total) },
    after: p.totals,
    invoice: { number: inv.number, before: r2(inv.total), after: p.totals.total },
    drafts: p.drafts.map((d) => ({ number: d.number, before: d.before, after: d.priced ? r2(d.priced.totalExGst) : 0, removed: d.remove, notes: d.priced?.lines.filter((l) => l.note).map((l) => `${l.description}: ${l.note}`) ?? [] })),
    ordersNew: s.sale.orderNeeded && p.planned.some((x) => x.itemId == null && x.toOrder > 0 && !x.orderNote),
    byHand: p.planned.filter((x) => x.orderNote && x.toOrder > 0).map((x) => `${x.description}: ${x.orderNote}`),
    qtyNotes: p.planned.filter((x) => x.qtyNote).map((x) => `${x.description}: ${x.qtyNote}`),
    nothing: !p.said.length && !p.stockSaid.length,
  };
}

/* -------------------------------- the save -------------------------------- */

export async function editPriceRecord(
  args: { jobId: number; lines: EditLineIn[]; stamp: string; expectedTotal: number; note?: string | null },
  actor: { name: string; role: string },
) {
  return oneAtATime(`order:${args.jobId}`, async () => {
    const s = await load(args.jobId);
    if (!s) throw bad("This job is not a Sell products sale.");
    const blockers = await blockersOf(s);
    if (blockers.length) throw bad(`Locked: ${blockers.join(" ")}`);
    if (stampOf(s) !== args.stamp) throw bad("Someone changed this sale since you opened it. Close the window and open Edit price record again.");
    const p = await planOf(s, args.lines);
    if (Math.abs(p.totals.total - r2(args.expectedTotal)) > 0.005) throw bad(`The total is now ${money(p.totals.total)}, not the ${money(args.expectedTotal)} you saw. Check again.`);
    if (!p.said.length && !p.stockSaid.length) return { changed: false as const, total: r2(s.quote.total), invoiceNumber: s.invoices[0]!.number, drafted: [] as string[], log: "" };
    if (s.sale.mode === "invoice") {
      const { assertSupplyOk } = await import("./stock/supply-check");
      await assertSupplyOk(p.planned.map((l) => ({ productId: l.productId, qty: l.qty, unit: l.unit })), s.job.id, { entityType: "sale", entityKey: s.sale.requestKey });
    }
    const now = new Date();
    const inv = s.invoices[0]!;
    const ref = await quoteRefOf(s.quote);

    // 1. The quote lines.
    const itemIdOf: number[] = [];
    for (const [n, l] of p.planned.entries()) {
      const values = {
        productId: l.productId,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
        listUnitPrice: l.listPrice != null && Math.abs(l.listPrice - l.unitPrice) > 0.005 ? l.listPrice : null,
        unitCost: l.unitCost,
        markupPercent: markupOf(l.unitCost, l.unitPrice),
        total: l.total,
        sortOrder: n,
        updatedAt: now,
      };
      if (l.itemId != null) {
        await db.update(schema.quoteItems).set(values).where(eq(schema.quoteItems.id, l.itemId));
        itemIdOf.push(l.itemId);
      } else {
        const [row] = await db
          .insert(schema.quoteItems)
          .values({ ...values, quoteId: s.quote.id, kind: "supply", lineType: "material", flagged: false, createdAt: now })
          .returning({ id: schema.quoteItems.id });
        itemIdOf.push(row!.id);
      }
    }
    // A removed line's materials go first (they are only on drafts), so the line itself can go.
    const removedLineIds = new Set(s.lines.filter((l) => l.quoteItemId != null && p.removed.some((r) => r.id === l.quoteItemId)).map((l) => l.id));
    for (const m of s.mats) if (m.saleLineId != null && removedLineIds.has(m.saleLineId)) await db.delete(schema.jobMaterials).where(eq(schema.jobMaterials.id, m.id));
    if (p.removed.length) await db.delete(schema.quoteItems).where(inArray(schema.quoteItems.id, p.removed.map((r) => r.id)));

    // 2. Quote totals, job value, invoice. Same invoice number and label.
    await db.update(schema.quotes).set({ ...p.totals, updatedAt: now }).where(eq(schema.quotes.id, s.quote.id));
    // The job value follows the one rule (job-value.ts): the accepted quote plus approved variations.
    await syncJobValue(s.job.id);
    await db.update(schema.invoices).set({ ...p.totals, updatedAt: now }).where(eq(schema.invoices.id, inv.id));

    // 3. Sale lines follow the quote, then From stock now as typed.
    await syncSaleLines(s.sale.id, s.quote.id, actor);
    const fresh = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, s.sale.id));
    for (const [n, l] of p.planned.entries()) {
      const sl = fresh.find((x) => x.quoteItemId === itemIdOf[n]);
      const v = Math.min(l.qty, Math.max(0, r4(l.fromStock)));
      if (sl && Math.abs(sl.fromStock - v) > 0.00005) await db.update(schema.productSaleLines).set({ fromStock: v, updatedAt: now }).where(eq(schema.productSaleLines.id, sl.id));
    }

    // 4. Materials to order, then the drafts that carry them.
    for (const m of s.mats) {
      if (m.saleLineId != null && removedLineIds.has(m.saleLineId)) continue;
      const next = p.matPlan.get(m.id);
      if (!next) await db.delete(schema.jobMaterials).where(eq(schema.jobMaterials.id, m.id));
      else if (Math.abs(next.qty - m.qty) > 0.00005 || next.productId !== m.productId || next.description !== m.description || next.unit !== m.unit) {
        await db.update(schema.jobMaterials).set({ ...next, updatedAt: now }).where(eq(schema.jobMaterials.id, m.id));
      }
    }
    const poSaid: string[] = [];
    for (const d of p.drafts) {
      if (d.remove) {
        await db
          .update(schema.purchaseOrders)
          .set({ status: "cancelled", notes: "Draft removed, never sent. Nothing left on it after the price record was changed.", updatedAt: now })
          .where(and(eq(schema.purchaseOrders.id, d.poId), eq(schema.purchaseOrders.status, "draft")));
        await db.update(schema.stockPoLinks).set({ status: "cancelled", updatedAt: now }).where(and(eq(schema.stockPoLinks.poId, d.poId), eq(schema.stockPoLinks.status, "open")));
        await resolveAiActionsForPo(d.poId, actor.name, "dismissed");
        poSaid.push(`Draft ${d.number} removed, never sent. Nothing is left on it. Kept as cancelled so its number is not used again.`);
        continue;
      }
      const pr = d.priced!;
      await db
        .update(schema.purchaseOrders)
        .set({
          goodsExGst: pr.goodsExGst,
          chargesExGst: pr.chargesExGst,
          freightExGst: pr.freightExGst,
          totalExGst: pr.totalExGst,
          pricingInputs: JSON.stringify({ ...d.saved, ...pr.pricingInputs, lines: d.lines }),
          updatedAt: now,
        })
        .where(eq(schema.purchaseOrders.id, d.poId));
      await writeLines(d.poId, pr.lines);
      poSaid.push(
        Math.abs(pr.totalExGst - d.before) > 0.005
          ? `Draft ${d.number} re-priced: ${money(d.before)} to ${money(pr.totalExGst)} ex GST. Not sent.`
          : `Draft ${d.number} updated, total unchanged at ${money(pr.totalExGst)} ex GST. Not sent.`,
      );
    }
    let drafted: string[] = [];
    if (s.sale.orderNeeded) {
      const out = await orderForSale(s.sale.id, { quoteRef: ref, actor });
      drafted = out.drafted;
      if (drafted.length) poSaid.push(`New draft ${drafted.join(", ")} for the new lines. Not sent.`);
    }

    // 5. The job history.
    const log = [
      `Price record ${ref} changed. ${inv.number} was not emailed, not in Xero, nothing paid.`,
      ...p.said.map((t) => `- ${t}`),
      ...p.stockSaid.map((t) => `- ${t}`),
      Math.abs(p.totals.total - s.quote.total) > 0.005
        ? `Total ${money(s.quote.total)} to ${money(p.totals.total)} inc GST. ${inv.number} now ${money(p.totals.total)}, same number.`
        : `Total unchanged at ${money(p.totals.total)} inc GST.`,
      ...poSaid,
      args.note?.trim() ? `Why: ${args.note.trim().slice(0, 300)}` : "",
      "Nothing was emailed or sent.",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    await db.insert(schema.activityLog).values([
      { jobId: s.job.id, entityType: "job", entityId: s.job.id, action: PRICE_RECORD_EDITED, detail: log, actorName: actor.name, actorRole: actor.role },
      ...(s.sale.installerId
        ? [{ entityType: "installer", entityId: s.sale.installerId, action: "materials_invoice_changed", detail: `${inv.number} changed to ${money(p.totals.total)} (was ${money(inv.total)}), price record ${ref}.`, actorName: actor.name, actorRole: actor.role }]
        : []),
    ]);
    return { changed: true as const, total: p.totals.total, invoiceNumber: inv.number, drafted, log };
  });
}
