import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { createQuoteRecord, productLineName } from "../routes/quotes";
import { cardOf, type BillTo } from "./bill-to";
import { raiseJobInvoice } from "./final-invoice";
import { billToOfLink, buyerLinkOf } from "./installer-buyer";
import { moveJobForward } from "./job-stage";
import { liveSellFor } from "./live-sell";
import { wholeUnits } from "./order-sizes";
import { quoteRefOf } from "./quote-number";
import { jobText } from "./refs";
import { salesAccountsView } from "./xero-invoices";

/* ---------------------------------------------------------------------------
 * Sell products (Damien, 30 Oct). One form for a product sale with nothing
 * to install, to an installer or to a customer.
 *
 *   Save as quote: a draft quote on its own supply only job. It is sent and
 *   accepted the normal way, by a person. Nothing goes out from here.
 *
 *   Raise invoice now: the quote is accepted inside Ops with no deposit, the
 *   job goes to Won and the invoice for the full amount is raised. It is
 *   NOT emailed and NOT sent to Xero. Those are their own buttons.
 *
 * Both:
 *   - installer sales go to Installer materials (Xero 204), everyone else to
 *     Customer sales (Xero 200). Every invoice on the job takes it.
 *   - no dispatches, no install tasks, no crew alerts, no Crew logins, no
 *     contra. Care emails are skipped (the job is supply only).
 *   - "We need to order this" (off by default): only what is not coming off
 *     the shelf goes on Materials to order and draft POs. Drafts only.
 *   - the same request key twice (a double click, two people) gives back the
 *     first sale, never a second invoice.
 * ------------------------------------------------------------------------- */

export const SALE_SOURCE = "Product sale";
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const qtyText = (n: number, unit: string) => `${r4(n)} ${unit === "m2" ? "m²" : unit}`;

export type SaleBuyer = { kind: "installer"; installerId: number } | { kind: "contact"; contactId: number } | { kind: "company"; companyId: number };
export type SaleLineIn = { productId?: number | null; description: string; qty: number; unit: string; unitPrice: number; fromStock?: number | null };
export type SaleInput = {
  buyer: SaleBuyer;
  mode: "quote" | "invoice";
  lines: SaleLineIn[];
  orderNeeded: boolean;
  /** Quote only. Left out: the Bill to's card %, else 0. */
  depositPercent?: number | null;
  note?: string | null;
};

/* ------------------------------- the buyer ------------------------------- */

async function buyerOf(b: SaleBuyer) {
  if (b.kind === "installer") {
    const [inst] = await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, b.installerId));
    if (!inst) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
    const link = await buyerLinkOf(b.installerId);
    if (!link) throw bad(`Set who ${inst.name} is billed as first (Account tab, Billed as).`);
    const billTo = billToOfLink(link) as BillTo;
    const card = await cardOf(billTo);
    if (!card) throw bad("The record he is billed as has gone. Set Billed as again.");
    return {
      kind: b.kind,
      name: inst.name,
      billTo,
      billToName: link.buyerName || card.name,
      cardPercent: card.percent,
      salesCategory: "installer_materials" as const,
      installerId: inst.id,
      contactId: null as number | null,
      companyId: null as number | null,
    };
  }
  const billTo: BillTo = b.kind === "contact" ? { type: "contact", id: b.contactId } : { type: "company", id: b.companyId };
  const card = await cardOf(billTo);
  if (!card) throw new ORPCError("NOT_FOUND", { message: b.kind === "contact" ? "Contact not found" : "Company not found" });
  return {
    kind: b.kind,
    name: card.name,
    billTo,
    billToName: card.name,
    cardPercent: card.percent,
    salesCategory: "customer" as const,
    installerId: null as number | null,
    contactId: b.kind === "contact" ? b.contactId : null,
    companyId: b.kind === "company" ? b.companyId : null,
  };
}

async function emailOf(billTo: BillTo) {
  if (billTo.type === "company") {
    const [c] = await db.select({ email: schema.companies.email }).from(schema.companies).where(eq(schema.companies.id, billTo.id));
    return c?.email?.trim() || null;
  }
  const [c] = await db.select({ email: schema.contacts.email }).from(schema.contacts).where(eq(schema.contacts.id, billTo.id));
  return c?.email?.trim() || null;
}

/* ------------------------------- the lines ------------------------------- */

type Priced = {
  productId: number | null;
  description: string;
  qty: number;
  typedQty: number;
  qtyNote: string | null;
  unit: string;
  unitPrice: number;
  listPrice: number | null;
  total: number;
  fromStock: number;
  toOrder: number;
  stocked: boolean;
  supplierId: number | null;
  supplierName: string | null;
  orderNote: string | null;
};

async function priceLines(lines: SaleLineIn[]): Promise<Priced[]> {
  const clean = lines
    .map((l) => ({ ...l, description: (l.description ?? "").replace(/\s+/g, " ").trim(), unit: (l.unit || "each").trim() }))
    .filter((l) => l.description || l.productId);
  if (!clean.length) throw bad("Add at least one product or line.");
  if (clean.length > 60) throw bad("Keep it to 60 lines or fewer.");
  const ids = [...new Set(clean.map((l) => l.productId).filter((x): x is number => x != null))];
  const products = ids.length ? await db.select().from(schema.products).where(inArray(schema.products.id, ids)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const supIds = [...new Set(products.map((p) => p.supplierId).filter((x): x is number => x != null))];
  const sups = supIds.length
    ? await db.select({ id: schema.suppliers.id, name: schema.suppliers.name, active: schema.suppliers.active, noPoNeeded: schema.suppliers.noPoNeeded }).from(schema.suppliers).where(inArray(schema.suppliers.id, supIds))
    : [];
  const supById = new Map(sups.map((s) => [s.id, s]));

  const out: Priced[] = [];
  for (const l of clean) {
    const p = l.productId != null ? byId.get(l.productId) : undefined;
    if (l.productId != null && !p) throw bad("A product on this sale is no longer in the price list. Remove it and pick it again.");
    const description = l.description || (p ? productLineName(p) || p.sku || "Product" : "");
    if (!(l.qty > 0)) throw bad(`"${description}" needs a quantity over 0.`);
    if (!(l.unitPrice > 0)) throw bad(`"${description}" needs a price over $0.`);
    const sized = p ? wholeUnits(p, l.qty) : { qty: l.qty, note: null };
    const qty = r4(sized.qty);
    const fromStock = Math.min(qty, Math.max(0, r4(Number(l.fromStock ?? 0) || 0)));
    const sup = p?.supplierId ? supById.get(p.supplierId) : undefined;
    const toOrder = r4(Math.max(0, qty - fromStock));
    let orderNote: string | null = null;
    if (toOrder > 0) {
      if (!p) orderNote = "Typed line, not from the price list. Ops can not draft a PO for it. Order it by hand.";
      else if (!sup || !sup.active) orderNote = "No active supplier in the price list. Order it by hand.";
      else if (sup.noPoNeeded) orderNote = `${sup.name} is ticked No PO needed. No PO is drafted.`;
    }
    out.push({
      productId: p?.id ?? null,
      description: description.slice(0, 300),
      qty,
      typedQty: l.qty,
      qtyNote: sized.note && qty !== l.qty ? sized.note : null,
      unit: p?.unit ?? l.unit,
      unitPrice: r2(l.unitPrice),
      listPrice: p ? await liveSellFor(p) : null,
      total: r2(qty * r2(l.unitPrice)),
      fromStock,
      toOrder,
      stocked: !!p?.heldInWarehouse,
      supplierId: sup?.id ?? null,
      supplierName: sup?.name ?? null,
      orderNote,
    });
  }
  return out;
}

/** The same sums recalc does on a quote with no referral fee and no supplier charge lines. */
function totalsOf(lines: Priced[]) {
  const subtotal = r2(lines.reduce((s, l) => s + l.total, 0));
  const gst = r2(subtotal * 0.1);
  return { subtotal, gst, total: r2(subtotal + gst) };
}

/* -------------------------------- preview -------------------------------- */

export async function previewSale(input: SaleInput) {
  const buyer = await buyerOf(input.buyer);
  const lines = await priceLines(input.lines);
  const totals = totalsOf(lines);
  const accounts = await salesAccountsView();
  const account = accounts[buyer.salesCategory];
  const depositPercent = input.mode === "invoice" ? 0 : (input.depositPercent ?? buyer.cardPercent ?? 0);
  const deposit = input.mode === "quote" && depositPercent > 0 ? r2((totals.total * depositPercent) / 100) : 0;
  const email = await emailOf(buyer.billTo);
  const ordering = input.orderNeeded ? lines.filter((l) => l.toOrder > 0) : [];
  return {
    mode: input.mode,
    buyer: { kind: buyer.kind, name: buyer.name, billToName: buyer.billToName, email, cardPercent: buyer.cardPercent },
    salesCategory: buyer.salesCategory,
    account: { label: account.label, code: account.code, name: account.name },
    lines,
    ...totals,
    depositPercent,
    deposit,
    orderNeeded: input.orderNeeded,
    ordering: ordering.map((l) => ({ description: l.description, qty: l.toOrder, unit: l.unit, supplierName: l.supplierName, note: l.orderNote })),
    /** Plain statements shown above Confirm. */
    happens: [
      input.mode === "invoice"
        ? `Raises one invoice for ${money(totals.total)} billed to ${buyer.billToName}, on its own supply only job.`
        : `Saves a draft quote for ${money(totals.total)} for ${buyer.billToName}, on its own supply only job.${deposit > 0 ? ` When it is accepted, a ${depositPercent}% deposit invoice (${money(deposit)}) is raised.` : ""}`,
      `Sales category: ${account.label} (${account.name}).`,
      input.mode === "invoice" ? "Nothing is emailed and nothing goes to Xero. Use Email and Send to Xero on the job when you are ready." : "Nothing is sent. Open the quote and press Send when you are ready.",
      input.orderNeeded
        ? ordering.length
          ? orderSentence(input.mode, ordering.filter((l) => !l.orderNote).length, ordering.filter((l) => l.orderNote).length)
          : "Everything is coming from stock, so nothing is ordered."
        : "Nothing is ordered. Tick \"We need to order this\" if it has to come from a supplier.",
      "No install tasks, crew alerts, care emails or Crew logins. Nothing is marked paid.",
    ],
  };
}

/** What the order tick will do, counting only lines Ops can draft a PO for. */
function orderSentence(mode: "quote" | "invoice", drafted: number, byHand: number) {
  const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (drafted > 0)
    parts.push(`${mode === "invoice" ? "Drafts" : "When accepted, drafts"} purchase orders for ${lines(drafted)}. Drafts only, never sent by Ops.`);
  if (byHand > 0) parts.push(`${lines(byHand)} must be ordered by hand. No PO is drafted for ${byHand === 1 ? "it" : "them"}.`);
  return parts.join(" ");
}

/* --------------------------------- raise --------------------------------- */

const locks = new Map<string, Promise<void>>();
async function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = before.then(() => new Promise<void>((r) => (release = r)));
  locks.set(key, mine);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

async function finalInvoiceOn(jobId: number) {
  const [inv] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, jobId), eq(schema.invoices.kind, "final"), ne(schema.invoices.status, "void")));
  return inv ?? null;
}

export type SaleResult = {
  saleId: number;
  jobId: number;
  quoteId: number;
  quoteRef: string;
  mode: "quote" | "invoice";
  total: number;
  invoice: { id: number; number: string; total: number } | null;
  poDrafts: string[];
  reused: boolean;
  note: string | null;
};

async function resultOf(sale: typeof schema.productSales.$inferSelect, reused: boolean, extra: { poDrafts?: string[]; note?: string | null } = {}): Promise<SaleResult> {
  if (!sale.jobId || !sale.quoteId) throw bad("This sale is still being saved, or the first try stopped part way. Refresh the page before trying again.");
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, sale.quoteId));
  const inv = sale.mode === "invoice" ? await finalInvoiceOn(sale.jobId) : null;
  return {
    saleId: sale.id,
    jobId: sale.jobId,
    quoteId: sale.quoteId,
    quoteRef: quote ? await quoteRefOf(quote) : "",
    mode: sale.mode === "invoice" ? "invoice" : "quote",
    total: r2(quote?.total ?? 0),
    invoice: inv ? { id: inv.id, number: inv.number, total: r2(inv.total) } : null,
    poDrafts: extra.poDrafts ?? [],
    reused,
    note: extra.note ?? null,
  };
}

export async function raiseSale(input: SaleInput & { requestKey: string; expectedTotal: number }, actor: Actor): Promise<SaleResult> {
  const key = input.requestKey.trim();
  if (key.length < 8) throw bad("Refresh the page and try again.");
  return oneAtATime(`sale:${key}`, async () => {
    const [seen] = await db.select().from(schema.productSales).where(eq(schema.productSales.requestKey, key));
    if (seen) return resultOf(seen, true);

    const buyer = await buyerOf(input.buyer);
    const lines = await priceLines(input.lines);
    const totals = totalsOf(lines);
    if (Math.abs(totals.total - r2(input.expectedTotal)) > 0.005) {
      throw bad(`The total is now ${money(totals.total)}, not the ${money(input.expectedTotal)} you saw. Check the preview again.`);
    }
    const note = input.note?.trim().slice(0, 500) ?? "";

    // The claim. The unique key stops a second sale even across two servers.
    let sale: typeof schema.productSales.$inferSelect | undefined;
    try {
      [sale] = await db
        .insert(schema.productSales)
        .values({
          requestKey: key,
          mode: input.mode,
          buyerKind: buyer.kind,
          installerId: buyer.installerId,
          contactId: buyer.contactId,
          companyId: buyer.companyId,
          salesCategory: buyer.salesCategory,
          orderNeeded: input.orderNeeded,
          note,
          createdByName: actor.name,
        })
        .returning();
    } catch (e) {
      const [again] = await db.select().from(schema.productSales).where(eq(schema.productSales.requestKey, key));
      if (again) return resultOf(again, true);
      throw e;
    }
    if (!sale) throw new Error("Sale not saved");

    const q = await createQuoteRecord(
      {
        jobId: null,
        contactId: buyer.contactId,
        companyId: buyer.companyId,
        supervisorContactId: null,
        people: [],
        makeJob: true,
        source: buyer.kind === "installer" ? "Installer (materials)" : SALE_SOURCE,
        siteId: null,
        billTo: buyer.billTo,
        depositPercent: input.mode === "invoice" ? 0 : (input.depositPercent ?? buyer.cardPercent ?? 0),
        validDays: 30,
        notes: null,
        terms: null,
        // No cost on the lines, so no supplier freight lines are added and the total is what the preview showed.
        items: lines.map((l) => ({
          productId: l.productId,
          kind: "supply",
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitPrice: l.unitPrice,
          unitCost: null,
          flagged: false,
          flagReason: null,
        })),
      },
      actor,
    );
    const jobId = q.jobId;
    if (!jobId) throw new Error("The sale's job was not made.");
    const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, q.id)).orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
    const goods = items.filter((i) => i.kind === "supply");
    await db.insert(schema.productSaleLines).values(
      lines.map((l, i) => ({
        saleId: sale!.id,
        quoteItemId: goods[i]?.id ?? null,
        productId: l.productId,
        description: l.description,
        qty: l.qty,
        unit: l.unit,
        unitPrice: l.unitPrice,
        fromStock: l.fromStock,
        sortOrder: i,
      })),
    );
    const now = new Date();
    await db
      .update(schema.jobs)
      .set({
        title: `Product sale to ${buyer.billToName}`.slice(0, 200),
        description: `Supply only product sale${buyer.kind === "installer" ? ` to installer ${buyer.name}` : ""}. Nothing to install.${note ? `\n${note}` : ""}`,
        prepOn: false,
        careState: "skipped",
        careNote: "Supply only product sale, no install. No automatic care emails. Send a care guide from the job if they want one.",
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, jobId));
    await db.update(schema.productSales).set({ jobId, quoteId: q.id, updatedAt: now }).where(eq(schema.productSales.id, sale.id));

    const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, q.id));
    const ref = quote ? await quoteRefOf(quote) : "";
    const realTotal = r2(quote?.total ?? 0);
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    const jobRef = job ? jobText(job) : String(jobId);

    if (input.mode === "quote" || Math.abs(realTotal - totals.total) > 0.005) {
      const off = input.mode === "invoice";
      await db.insert(schema.activityLog).values({
        jobId,
        contactId: buyer.contactId,
        entityType: "job",
        entityId: jobId,
        action: "product_sale",
        detail: off
          ? `Sell products: the quote came to ${money(realTotal)}, not ${money(totals.total)}. Saved as quote ${ref} only. No invoice raised.`
          : `Sell products: quote ${ref} saved for ${money(realTotal)}, ${lines.length} line${lines.length === 1 ? "" : "s"}, for ${buyer.billToName}. Not sent.`,
        actorName: actor.name,
        actorRole: actor.role,
      });
      if (off) await db.update(schema.productSales).set({ mode: "quote", updatedAt: new Date() }).where(eq(schema.productSales.id, sale.id));
      const [fresh] = await db.select().from(schema.productSales).where(eq(schema.productSales.id, sale.id));
      return resultOf(fresh!, false, { note: off ? `The total came to ${money(realTotal)}. It was saved as a quote and no invoice was raised. Check it on job ${jobRef}.` : null });
    }

    // Raise now: agreed already. Accepted without the accept routine (no deposit, no dispatch, no Order product task).
    await db.update(schema.quotes).set({ status: "accepted", acceptedAt: now, updatedAt: now }).where(eq(schema.quotes.id, q.id));
    await db.update(schema.jobs).set({ value: realTotal, depositAmount: 0, updatedAt: now }).where(eq(schema.jobs.id, jobId));
    await moveJobForward({ jobId, target: "won", why: "product sale, invoiced straight away", actor });
    const inv = await raiseJobInvoice({ jobId, kind: "final", label: `Products supplied, quote ${ref}`, actor: { name: actor.name, role: actor.role } });

    let poDrafts: string[] = [];
    if (input.orderNeeded) poDrafts = (await orderForSale(sale.id, { quoteRef: ref, actor })).drafted;

    await db.insert(schema.activityLog).values([
      {
        jobId,
        contactId: buyer.contactId,
        entityType: "job",
        entityId: jobId,
        action: "product_sale",
        detail: [
          `Sell products: invoice ${inv.number} raised for ${money(inv.total)}, ${lines.length} line${lines.length === 1 ? "" : "s"}, billed to ${buyer.billToName}. Not emailed, not in Xero.`,
          input.orderNeeded ? (poDrafts.length ? `Draft POs ${poDrafts.join(", ")}. Not sent.` : "Order ticked. Nothing left to draft a PO for.") : "Not ordered: from stock.",
        ].join("\n"),
        actorName: actor.name,
        actorRole: actor.role,
      },
      ...(buyer.installerId
        ? [{ entityType: "installer", entityId: buyer.installerId, action: "materials_invoice_raised", detail: `${inv.number} raised for products, ${money(inv.total)}, job ${jobRef}.`, actorName: actor.name, actorRole: actor.role }]
        : []),
    ]);
    const [fresh] = await db.select().from(schema.productSales).where(eq(schema.productSales.id, sale.id));
    return resultOf(fresh!, false, { poDrafts });
  });
}

/* -------------------------------- ordering ------------------------------- */

export async function saleOfJob(jobId: number) {
  const [s] = await db.select().from(schema.productSales).where(eq(schema.productSales.jobId, jobId)).orderBy(desc(schema.productSales.id)).limit(1);
  return s ?? null;
}

/** Each line: what is wanted, what comes off the shelf, what is already on order, what is still to order. */
export async function orderPlan(saleId: number) {
  const lines = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, saleId)).orderBy(asc(schema.productSaleLines.sortOrder));
  const mats = lines.length
    ? await db
        .select()
        .from(schema.jobMaterials)
        .where(inArray(schema.jobMaterials.saleLineId, lines.map((l) => l.id)))
    : [];
  const onPo = mats.length
    ? await db
        .select({ jobMaterialId: schema.purchaseOrderLines.jobMaterialId, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status })
        .from(schema.purchaseOrderLines)
        .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
        .where(and(inArray(schema.purchaseOrderLines.jobMaterialId, mats.map((m) => m.id)), ne(schema.purchaseOrders.status, "cancelled")))
    : [];
  const poOf = new Map<number, { number: string; status: string }[]>();
  for (const r of onPo) if (r.jobMaterialId) poOf.set(r.jobMaterialId, [...(poOf.get(r.jobMaterialId) ?? []), { number: r.number, status: r.status }]);
  return lines.map((l) => {
    const mine = mats.filter((m) => m.saleLineId === l.id);
    const covered = r4(mine.reduce((s, m) => s + m.qty, 0));
    const pos = mine.flatMap((m) => poOf.get(m.id) ?? []);
    const want = r4(Math.max(0, l.qty - l.fromStock));
    return {
      lineId: l.id,
      description: l.description,
      unit: l.unit,
      qty: l.qty,
      fromStock: l.fromStock,
      onOrder: covered,
      pos: [...new Map(pos.map((p) => [p.number, p])).values()],
      stillToOrder: r4(Math.max(0, want - covered)),
    };
  });
}

/**
 * Put what is still needed on Materials to order and draft the POs. Run it
 * twice and the second run finds everything covered and drafts nothing.
 */
export async function orderForSale(saleId: number, args: { quoteRef: string; actor: { name: string; role: string } }) {
  const [sale] = await db.select().from(schema.productSales).where(eq(schema.productSales.id, saleId));
  if (!sale?.jobId) throw bad("This sale has no job yet.");
  const jobId = sale.jobId;
  const lines = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, saleId));
  const plan = await orderPlan(saleId);
  const added: string[] = [];
  for (const p of plan) {
    if (p.stillToOrder <= 0.00005) continue;
    const line = lines.find((l) => l.id === p.lineId)!;
    await db.insert(schema.jobMaterials).values({
      jobId,
      productId: line.productId,
      description: line.description,
      qty: p.stillToOrder,
      unit: line.unit,
      status: "to_order",
      saleLineId: line.id,
    });
    added.push(`${line.description}, ${qtyText(p.stillToOrder, line.unit)}`);
  }
  if (!sale.orderNeeded) await db.update(schema.productSales).set({ orderNeeded: true, updatedAt: new Date() }).where(eq(schema.productSales.id, saleId));
  const { draftPosForJob } = await import("./po-helper");
  const drafts = await draftPosForJob({ jobId, quoteRef: args.quoteRef });
  if (added.length) {
    await db.insert(schema.activityLog).values({
      jobId,
      entityType: "job",
      entityId: jobId,
      action: "sale_ordered",
      detail: [`Put on Materials to order for the sale:`, ...added.map((a) => `- ${a}`), drafts.drafted.length ? `Draft POs ${drafts.drafted.map((d) => d.number).join(", ")}. Not sent.` : ""].filter(Boolean).join("\n"),
      actorName: args.actor.name,
      actorRole: args.actor.role,
    });
  }
  return { added, drafted: drafts.drafted.map((d) => d.number), pos: drafts.drafted, skipped: drafts.skipped };
}

/** Change what comes off the shelf, then order the rest. Lines already on order stay on order. */
export async function setStockAndOrder(args: { jobId: number; fromStock: { lineId: number; qty: number }[]; actor: Actor }) {
  return oneAtATime(`order:${args.jobId}`, async () => {
    const sale = await saleOfJob(args.jobId);
    if (!sale) throw bad("This job is not a product sale.");
    const [q] = sale.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, sale.quoteId)) : [];
    if (!q || q.status !== "accepted") throw bad("The quote is not accepted yet. Order once it is accepted.");
    const lines = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, sale.id));
    for (const f of args.fromStock) {
      const l = lines.find((x) => x.id === f.lineId);
      if (!l) throw bad("That line is not on this sale. Refresh the page.");
      const v = Math.min(l.qty, Math.max(0, r4(f.qty)));
      if (v !== l.fromStock) await db.update(schema.productSaleLines).set({ fromStock: v, updatedAt: new Date() }).where(eq(schema.productSaleLines.id, l.id));
    }
    return orderForSale(sale.id, { quoteRef: await quoteRefOf(q), actor: args.actor });
  });
}

/**
 * acceptQuote calls this for a quote that came from Sell products. The lines
 * are taken from the version accepted (it may have been revised), keeping
 * what was said about stock, and ordered only when the tick was on.
 */
export async function saleQuoteAccepted(args: { jobId: number; quoteId: number; quoteRef: string; actor: { name: string; role: string } }) {
  const sale = await saleOfJob(args.jobId);
  if (!sale) return null;
  if (sale.quoteId !== args.quoteId) {
    const old = await db.select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, sale.id));
    const items = await db
      .select()
      .from(schema.quoteItems)
      .where(and(eq(schema.quoteItems.quoteId, args.quoteId), inArray(schema.quoteItems.kind, ["supply", "accessory"])))
      .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
    await db.delete(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, sale.id));
    if (items.length) {
      await db.insert(schema.productSaleLines).values(
        items.map((i, n) => {
          const was = old.find((o) => o.productId === i.productId && o.description === i.description);
          return {
            saleId: sale.id,
            quoteItemId: i.id,
            productId: i.productId,
            description: i.description,
            qty: i.qty,
            unit: i.unit,
            unitPrice: i.unitPrice,
            fromStock: Math.min(i.qty, was?.fromStock ?? 0),
            sortOrder: n,
          };
        }),
      );
    }
    await db.update(schema.productSales).set({ quoteId: args.quoteId, updatedAt: new Date() }).where(eq(schema.productSales.id, sale.id));
  }
  if (!sale.orderNeeded) return { sale, pos: [] as Awaited<ReturnType<typeof orderForSale>>["pos"], ordered: false };
  const out = await orderForSale(sale.id, { quoteRef: args.quoteRef, actor: args.actor });
  return { sale, pos: out.pos, ordered: true };
}
