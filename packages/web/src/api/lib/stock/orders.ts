import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { cardOf, jobBillTo } from "../bill-to";
import { AWAITING_CONFIRM, bad, cardCheck, forbid, isLive, money, notFound, type PermActor, r2, type SwitchKey, switches } from "./core";

/* ---------------------------------------------------------------------------
 * Orders in the stock workflow, and the deposit worked out from the facts.
 *
 * Terms are frozen at acceptance (or "Raise invoice now"). Deposit status is
 * never stored: it is added up from the payment rows each time.
 *
 * Which payments count for stock (A1.4, clarification 3 and 4):
 *   online card through Stripe   only once the live card check is recorded
 *   anything typed in by hand    only after an Admin "Confirm for stock"
 *   read back from Xero          only after an Admin "Confirm for stock"
 *   contra                       never
 * The invoice's paid total and the job's "deposit paid" tick are never read.
 * ------------------------------------------------------------------------- */

export type Order = typeof schema.stockOrders.$inferSelect;
export type OrderKind = "sale_quote" | "sale_invoice" | "job";

export const switchFor = (kind: OrderKind): SwitchKey => (kind === "job" ? "s4" : "s3");

/** The Bill to card of a job, as it is now. */
export async function cardOfJob(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return job ? cardOf(jobBillTo(job)) : null;
}

export async function orderById(id: number) {
  const [o] = await db.select().from(schema.stockOrders).where(eq(schema.stockOrders.id, id));
  if (!o) throw notFound("Stock order not found");
  return o;
}
export async function orderOfJob(jobId: number) {
  const [o] = await db.select().from(schema.stockOrders).where(eq(schema.stockOrders.jobId, jobId));
  return o ?? null;
}

/** What kind of order a job is: a product sale (quote or direct invoice) or an installation job. */
export async function kindOfJob(jobId: number): Promise<{ kind: OrderKind; saleId: number | null }> {
  const [s] = await db
    .select({ id: schema.productSales.id, mode: schema.productSales.mode })
    .from(schema.productSales)
    .where(eq(schema.productSales.jobId, jobId))
    .orderBy(asc(schema.productSales.id))
    .limit(1);
  if (!s) return { kind: "job", saleId: null };
  return { kind: s.mode === "invoice" ? "sale_invoice" : "sale_quote", saleId: s.id };
}

/**
 * The order for a job, made when stock is first chosen for it (status
 * planned). Only while the switch for that kind of order is on.
 */
export async function ensureOrder(jobId: number) {
  const seen = await orderOfJob(jobId);
  if (seen) return seen;
  const { kind, saleId } = await kindOfJob(jobId);
  if (!(await isLive(switchFor(kind)))) throw bad(kind === "job" ? "S4 Installation jobs is off." : "S3 Stock-backed sales is off.");
  const facts = await termsFromFacts(jobId, kind);
  if (facts.acceptedBeforeSwitch) throw bad("This order was accepted before the stock workflow was on. An Admin uses \"Bring into stock workflow\" first.");
  const card = await cardOfJob(jobId);
  await db.insert(schema.stockOrders).values({ jobId, saleId, kind, status: "planned", proposedPercent: card?.percent ?? null }).onConflictDoNothing();
  return syncTerms((await orderOfJob(jobId))!);
}

export type TermsFacts = { accepted: boolean; percent: number | null; total: number; invoiceId: number | null; acceptedAt: Date | null; acceptedBeforeSwitch: boolean };

/**
 * Whether the order has been agreed, and on what terms, worked out from the
 * quote and invoice rows (clarification 2). Used when the order is first
 * made and by the check, so an acceptance that saved but did not reach the
 * stock workflow is still picked up.
 */
export async function termsFromFacts(jobId: number, kind: OrderKind, cutoff?: Date | null): Promise<TermsFacts> {
  const none: TermsFacts = { accepted: false, percent: null, total: 0, invoiceId: null, acceptedAt: null, acceptedBeforeSwitch: false };
  const sw = cutoff === undefined ? (await switches())[switchFor(kind)] : null;
  const first = sw?.since ?? sw?.at ?? null;
  // Stored times are whole seconds, so the switch time is compared to the second.
  const exact = cutoff === undefined ? (first ? new Date(first) : null) : cutoff;
  const since = exact ? new Date(Math.floor(exact.getTime() / 1000) * 1000) : null;
  if (kind === "sale_invoice") {
    const [inv] = await db
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.jobId, jobId), ne(schema.invoices.status, "void")))
      .orderBy(asc(schema.invoices.id))
      .limit(1);
    if (!inv) return none;
    const at = inv.createdAt ?? null;
    const [sq] = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(asc(schema.quotes.id)).limit(1);
    // The sale's own quote carries the typed % (or the card %). Source "none" means blank, so the card is the only fallback.
    const pct = sq && sq.depositSource !== "none" ? sq.depositPercent : ((await cardOfJob(jobId))?.percent ?? null);
    return { accepted: true, percent: pct, total: r2(inv.total), invoiceId: inv.id, acceptedAt: at, acceptedBeforeSwitch: !!(since && at && at < since) };
  }
  const [q] = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(asc(schema.quotes.id))
    .limit(1);
  if (!q) return none;
  const at = q.acceptedAt ?? null;
  return { accepted: true, percent: q.depositSource === "none" ? null : q.depositPercent, total: r2(q.total), invoiceId: null, acceptedAt: at, acceptedBeforeSwitch: !!(since && at && at < since) };
}

/** A planned order whose quote or invoice is agreed gets its terms frozen. Brought-in orders were frozen when brought in. */
export async function syncTerms(o: Order) {
  if (o.status !== "planned") return o;
  const f = await termsFromFacts(o.jobId, o.kind as OrderKind, o.joinedVia === "brought_in" ? null : undefined);
  if (!f.accepted || f.acceptedBeforeSwitch) return o;
  return (await freezeTerms(o.jobId, { percent: f.percent, total: f.total, invoiceId: f.invoiceId })) ?? o;
}

/**
 * Freeze the terms. Called at acceptance, or when "Raise invoice now" is
 * pressed. A blank % stays blank ("Deposit % to complete"), never 0.
 * Running it again on an active order changes nothing.
 */
export async function freezeTerms(jobId: number, args: { percent: number | null; total: number; invoiceId?: number | null }) {
  const o = await orderOfJob(jobId);
  if (!o) return null;
  if (o.status !== "planned") return o;
  const pct = args.percent == null || !Number.isFinite(args.percent) ? null : args.percent;
  const required = pct == null ? null : r2((args.total * pct) / 100);
  const [row] = await db
    .update(schema.stockOrders)
    .set({
      status: "active",
      depositPercent: pct,
      orderTotal: r2(args.total),
      requiredDeposit: required,
      frozenAt: new Date(),
      invoiceId: args.invoiceId ?? o.invoiceId,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.stockOrders.id, o.id), eq(schema.stockOrders.status, "planned")))
    .returning();
  // Chosen stock now waits for the deposit. A temporary hold keeps holding until it is firm or expires.
  await db
    .update(schema.stockReservations)
    .set({ status: "awaiting", updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.orderId, o.id), eq(schema.stockReservations.status, "planned")));
  return row ?? (await orderById(o.id));
}

/** The office fills in a blank deposit %. Only while it is blank; a frozen % never changes. */
export async function completePercent(orderId: number, percent: number, actor: PermActor) {
  if (actor.role === "field") throw forbid("Office or Admin only.");
  if (!(percent >= 0 && percent <= 100)) throw bad("Enter a % from 0 to 100.");
  const o = await orderById(orderId);
  if (o.status === "planned") throw bad("The order is not accepted yet. The % is fixed at acceptance.");
  if (o.depositPercent != null) throw bad(`The deposit % was fixed at ${o.depositPercent}% when the order was accepted.`);
  const required = r2(((o.orderTotal ?? 0) * percent) / 100);
  await db
    .update(schema.stockOrders)
    .set({ depositPercent: percent, requiredDeposit: required, updatedAt: new Date() })
    .where(and(eq(schema.stockOrders.id, o.id), eq(schema.stockOrders.status, o.status)));
  return orderById(o.id);
}

/* ------------------------------ payment facts ----------------------------- */

/** The invoices whose payments count toward the deposit for stock. */
export async function depositInvoiceIds(o: Order) {
  if (o.kind === "sale_invoice") return o.invoiceId ? [o.invoiceId] : [];
  const rows = await db
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, o.jobId), eq(schema.invoices.kind, "deposit")));
  return rows.map((r) => r.id);
}

export type PaymentFact = {
  id: number;
  invoiceId: number;
  amount: number;
  method: string;
  source: string | null;
  byName: string;
  paidOn: Date | null;
  confirmedBy: string | null;
  counts: boolean;
  why: string;
};

export async function paymentFacts(invoiceIds: number[]): Promise<PaymentFact[]> {
  if (!invoiceIds.length) return [];
  const rows = await db.select().from(schema.invoicePayments).where(inArray(schema.invoicePayments.invoiceId, invoiceIds)).orderBy(asc(schema.invoicePayments.id));
  const conf = rows.length
    ? await db
        .select()
        .from(schema.stockPaymentConfirmations)
        .where(
          inArray(
            schema.stockPaymentConfirmations.paymentId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const confBy = new Map(conf.map((c) => [c.paymentId, c.byName]));
  const card = await cardCheck();
  return rows.map((p) => {
    const confirmedBy = confBy.get(p.id) ?? null;
    let counts = false;
    let why = "";
    if (p.method === "contra") why = "Contra never counts for stock.";
    else if (p.source === "stripe" && p.method === "card" && card.done) {
      counts = true;
      why = "Online card payment.";
    } else if (confirmedBy) {
      counts = true;
      why = `Confirmed for stock by ${confirmedBy}.`;
    } else if (p.source === "stripe") why = "Online card payment. The live card check is not recorded yet, so an Admin confirms it for stock.";
    else if (p.source === "xero") why = "Read back from Xero. Needs an Admin to confirm it for stock.";
    else why = "Recorded by hand. Needs an Admin to confirm it for stock.";
    return { id: p.id, invoiceId: p.invoiceId, amount: p.amount, method: p.method, source: p.source, byName: p.byName, paidOn: p.paidOn, confirmedBy, counts, why };
  });
}

export type DepositCode = "not_accepted" | "to_complete" | "awaiting" | "awaiting_confirm" | "confirmed" | "cancelled";
export type DepositState = {
  code: DepositCode;
  label: string;
  percent: number | null;
  required: number | null;
  confirmed: number;
  recordedUnconfirmed: number;
  /** What a customer should still pay toward the deposit. Recorded but unconfirmed money is not asked for again. */
  stillToPay: number;
  payments: PaymentFact[];
};

export async function depositState(o: Order): Promise<DepositState> {
  const payments = await paymentFacts(await depositInvoiceIds(o));
  const confirmed = r2(payments.filter((p) => p.counts).reduce((s, p) => s + p.amount, 0));
  const recordedUnconfirmed = r2(payments.filter((p) => !p.counts && p.method !== "contra").reduce((s, p) => s + p.amount, 0));
  const base = { percent: o.depositPercent, required: o.requiredDeposit, confirmed, recordedUnconfirmed, payments };
  if (o.status === "planned") return { ...base, code: "not_accepted", label: "Not accepted yet", stillToPay: 0 };
  if (o.status === "cancelled") return { ...base, code: "cancelled", label: "Cancelled", stillToPay: 0 };
  if (o.depositPercent == null || o.requiredDeposit == null) return { ...base, code: "to_complete", label: "Deposit % to complete", stillToPay: 0 };
  const req = o.requiredDeposit;
  if (confirmed >= req - 0.005) return { ...base, code: "confirmed", label: "Deposit confirmed", stillToPay: 0 };
  const stillToPay = r2(Math.max(0, req - confirmed - recordedUnconfirmed));
  if (recordedUnconfirmed > 0 && confirmed + recordedUnconfirmed >= req - 0.005) return { ...base, code: "awaiting_confirm", label: AWAITING_CONFIRM, stillToPay };
  return { ...base, code: "awaiting", label: `Awaiting deposit (${money(confirmed)} of ${money(req)} confirmed)`, stillToPay };
}

/* --------------------------- confirm for stock ---------------------------- */

/**
 * Admin: "Confirm for stock" on a payment already recorded (by hand, or read
 * back from Xero). Uses that payment, so nothing is recorded twice. Pressing
 * it again returns the first confirmation.
 */
export async function confirmForStock(paymentId: number, note: string, actor: PermActor & { profileId: number | null }) {
  if (actor.role !== "admin") throw forbid("Only an Admin can confirm a payment for stock.");
  const [p] = await db.select().from(schema.invoicePayments).where(eq(schema.invoicePayments.id, paymentId));
  if (!p) throw notFound("Payment not found");
  if (p.method === "contra") throw bad("Contra never counts for stock.");
  if (!(p.amount > 0)) throw bad("Only money received can be confirmed.");
  const [seen] = await db.select().from(schema.stockPaymentConfirmations).where(eq(schema.stockPaymentConfirmations.paymentId, p.id));
  if (seen) return { confirmation: seen, reused: true };
  await db
    .insert(schema.stockPaymentConfirmations)
    .values({ paymentId: p.id, invoiceId: p.invoiceId, amount: p.amount, byProfileId: actor.profileId, byName: actor.name, note: note.trim().slice(0, 300) })
    .onConflictDoNothing();
  const [row] = await db.select().from(schema.stockPaymentConfirmations).where(eq(schema.stockPaymentConfirmations.paymentId, p.id));
  await db.insert(schema.activityLog).values({
    entityType: "invoice",
    entityId: p.invoiceId,
    action: "stock_payment_confirmed",
    detail: `${money(p.amount)} ${p.method} payment confirmed for stock.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { confirmation: row!, reused: false };
}

/** Orders a payment on this invoice could move. */
export async function ordersForInvoice(invoiceId: number) {
  const [inv] = await db.select({ id: schema.invoices.id, jobId: schema.invoices.jobId, kind: schema.invoices.kind }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv?.jobId) return [];
  const rows = await db
    .select()
    .from(schema.stockOrders)
    .where(and(eq(schema.stockOrders.jobId, inv.jobId), ne(schema.stockOrders.status, "planned")));
  return rows.filter((o) => (o.kind === "sale_invoice" ? o.invoiceId === inv.id : inv.kind === "deposit"));
}

/* ---------------------------- bring into workflow ------------------------- */

/**
 * Admin: an order accepted before the switch went on joins the workflow.
 * Nothing is re-ordered, re-reserved or re-costed. The starting position is
 * saved with who did it.
 */
export async function startPosition(jobId: number) {
  const mats = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId));
  const pos = await db
    .select({ number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, total: schema.purchaseOrders.totalExGst })
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.jobId, jobId));
  const invs = await db
    .select({ number: schema.invoices.number, kind: schema.invoices.kind, total: schema.invoices.total, paid: schema.invoices.amountPaid, status: schema.invoices.status })
    .from(schema.invoices)
    .where(eq(schema.invoices.jobId, jobId));
  const count = (s: string) => mats.filter((m) => m.status === s).length;
  return {
    materials: { toOrder: count("to_order"), ordered: count("ordered"), onSite: count("on_site"), installed: count("installed"), total: mats.length },
    purchaseOrders: pos.map((p) => ({ number: p.number, status: p.status, total: p.total })),
    invoices: invs.map((i) => ({ number: i.number, kind: i.kind, total: i.total, paidShownOnInvoice: i.paid, status: i.status })),
  };
}

export async function bringIntoWorkflow(jobId: number, actor: PermActor) {
  if (actor.role !== "admin") throw forbid("Only an Admin can bring an order into the stock workflow.");
  const seen = await orderOfJob(jobId);
  if (seen && seen.status !== "planned") throw bad("This order is already in the stock workflow.");
  const { kind, saleId } = await kindOfJob(jobId);
  if (!(await isLive(switchFor(kind)))) throw bad(kind === "job" ? "Turn S4 Installation jobs on first." : "Turn S3 Stock-backed sales on first.");
  const [q] = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(asc(schema.quotes.id));
  const [inv] = kind === "sale_invoice" ? await db.select().from(schema.invoices).where(eq(schema.invoices.jobId, jobId)).orderBy(asc(schema.invoices.id)) : [];
  if (!q && !inv) throw bad("There is no accepted quote or invoice on this job.");
  const pos = await startPosition(jobId);
  const percent = q ? (q.depositSource === "none" ? null : q.depositPercent) : ((await cardOfJob(jobId))?.percent ?? null);
  const total = q?.total ?? inv?.total ?? 0;
  if (!seen) await db.insert(schema.stockOrders).values({ jobId, saleId, kind, status: "planned" }).onConflictDoNothing();
  await db
    .update(schema.stockOrders)
    .set({ joinedVia: "brought_in", broughtInByName: actor.name, broughtInAt: new Date(), startPosition: JSON.stringify(pos), updatedAt: new Date() })
    .where(eq(schema.stockOrders.jobId, jobId));
  const o = await freezeTerms(jobId, { percent, total, invoiceId: inv?.id ?? null });
  await db.insert(schema.activityLog).values({
    entityType: "job",
    entityId: jobId,
    action: "stock_brought_in",
    detail: `Brought into the stock workflow. Nothing re-ordered, re-reserved or re-costed.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { order: o!, startPosition: pos };
}

/** One line stock can be chosen for: a quote line, a sale line or a job material, with the ids that tie them together. */
export type StockLine = { key: string; label: string; productId: number; qty: number; unit: string; quoteItemId: number | null; saleLineId: number | null; jobMaterialId: number | null };

/**
 * The lines on a job or sale that stock can be chosen for. Ties a quote line to
 * its job material (same product, only one) so one choice reduces the expected
 * cost, the PO helper and the Crew "held" status together.
 */
export async function stockLinesOf(jobId: number): Promise<StockLine[]> {
  const quotes = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId));
  const pick = quotes.find((q) => q.status === "accepted") ?? null;
  const qItems = pick ? await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, pick.id)) : [];
  const mats = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId));
  const sales = await db.select({ id: schema.productSales.id }).from(schema.productSales).where(eq(schema.productSales.jobId, jobId));
  const saleLines = sales.length ? await db.select().from(schema.productSaleLines).where(inArray(schema.productSaleLines.saleId, sales.map((s) => s.id))) : [];
  const usedMats = new Set<number>();
  const out: StockLine[] = [];
  const matFor = (productId: number, saleLineId: number | null) => {
    const bySale = saleLineId != null ? mats.filter((m) => m.saleLineId === saleLineId) : [];
    const same = bySale.length === 1 ? bySale : mats.filter((m) => m.productId === productId && !usedMats.has(m.id));
    if (same.length !== 1) return null;
    usedMats.add(same[0].id);
    return same[0].id;
  };
  for (const q of qItems) {
    if (!q.productId) continue;
    const sl = saleLines.find((s) => s.quoteItemId === q.id) ?? null;
    out.push({ key: `q:${q.id}`, label: `Quote line: ${q.description}`, productId: q.productId, qty: q.qty, unit: q.unit, quoteItemId: q.id, saleLineId: sl?.id ?? null, jobMaterialId: matFor(q.productId, sl?.id ?? null) });
  }
  for (const s of saleLines) {
    if (!s.productId || out.some((o) => o.saleLineId === s.id)) continue;
    out.push({ key: `s:${s.id}`, label: `Sale line: ${s.description}`, productId: s.productId, qty: s.qty, unit: s.unit, quoteItemId: s.quoteItemId ?? null, saleLineId: s.id, jobMaterialId: matFor(s.productId, s.id) });
  }
  for (const m of mats) {
    if (!m.productId || usedMats.has(m.id)) continue;
    out.push({ key: `m:${m.id}`, label: `Material: ${m.description}`, productId: m.productId, qty: m.qty, unit: m.unit, quoteItemId: null, saleLineId: m.saleLineId ?? null, jobMaterialId: m.id });
  }
  return out;
}
