import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../database";
import * as schema from "../database/schema";
import { PRODUCT_CATEGORIES } from "./product-categories";
import { round2, type SupplierChargeRule } from "./pricing";
import {
  addDays,
  auditRow,
  bad,
  buyerView,
  buyerViews,
  conflict,
  GUARD_MSG,
  guard,
  notFound,
  oneSaleMoney,
  parseCategories,
  requireTradeOn,
  runGuarded,
  saleMoney,
  tradeSettings,
  ymd,
  type BuyerKind,
  type Who,
} from "./trade-core";
import {
  buyerMayBuy,
  feesFor,
  invoiceRef,
  lineTotals,
  onTradeList,
  productDetail,
  productName,
  rateFor,
  saleRef,
  unitsFor,
  type FeeLine,
  type TradeProduct,
  type TradeRule,
} from "./trade-pricing";
import { onHandFor } from "./trade-stock";

/* ---------------------------------------------------------------------------
 * Trade sales: settings, the trade list, buyers, drafts and finalise
 * (notes 18.65). Money after finalise (payments, credits, fulfilment) is in
 * trade-money.ts, offsets and bills in trade-settle.ts.
 *
 * A draft is priced live: every change re-prices every line from today's
 * cost, markup and fees. Finalise re-prices once more and refuses if anything
 * moved since the screen was loaded, then freezes the lot. After that nothing
 * on the sale or its lines is ever recalculated.
 * ------------------------------------------------------------------------- */

const CATS = new Set<string>(PRODUCT_CATEGORIES);
const cleanCats = (cats: string[]) => [...new Set(cats.filter((c) => CATS.has(c)))];
const GST_RATE = 10;

/* -------------------------------- settings -------------------------------- */

export async function saveSettings(
  input: { enabled?: boolean; markupPct?: number; categories?: string[]; supplierIds?: number[]; nextNumber?: number },
  who: Who,
) {
  const cur = await tradeSettings();
  const set: Partial<typeof schema.tradeSettings.$inferInsert> = { updatedByName: who.name, updatedAt: new Date() };
  const changes: string[] = [];
  if (input.enabled !== undefined && input.enabled !== cur.enabled) {
    set.enabled = input.enabled;
    changes.push(`Trade sales ${input.enabled ? "on" : "off"}`);
  }
  if (input.markupPct !== undefined && input.markupPct !== cur.markupPct) {
    if (!(input.markupPct >= 0 && input.markupPct <= 500)) throw bad("Markup must be between 0 and 500%.");
    set.markupPct = input.markupPct;
    changes.push(`Markup ${cur.markupPct}% to ${input.markupPct}%`);
  }
  if (input.categories) {
    set.categories = JSON.stringify(cleanCats(input.categories));
    changes.push(`Categories: ${cleanCats(input.categories).join(", ") || "none"}`);
  }
  if (input.supplierIds) {
    const ids = [...new Set(input.supplierIds.filter((n) => Number.isInteger(n)))];
    set.supplierIds = JSON.stringify(ids);
    changes.push(`Suppliers: ${ids.join(", ") || "none"}`);
  }
  if (input.nextNumber !== undefined && input.nextNumber !== cur.nextNumber) {
    if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) throw bad("The next number must be a whole number.");
    const [{ top }] = (await db.all<{ top: number | null }>(sql`select max(number) as top from trade_sales where number > 0`)) as [{ top: number | null }];
    if (top != null && input.nextNumber <= top) throw bad(`S${top} is already used. The next number must be above it.`);
    set.nextNumber = input.nextNumber;
    changes.push(`Next number S${input.nextNumber}`);
  }
  if (!changes.length) return tradeSettings();
  await runGuarded([
    db.update(schema.tradeSettings).set(set).where(eq(schema.tradeSettings.id, 1)),
    auditRow({ entityType: "settings", entityId: 1, action: "settings", detail: changes.join(". "), who }),
  ]);
  return tradeSettings();
}

/* ------------------------------ product data ------------------------------ */

type ProductRow = typeof schema.products.$inferSelect;
type RuleRow = typeof schema.tradeProductRules.$inferSelect;

export const toTradeProduct = (p: ProductRow): TradeProduct => ({
  id: p.id,
  supplierId: p.supplierId,
  supplier: p.supplier,
  brand: p.brand,
  range: p.range,
  colour: p.colour,
  size: p.size,
  category: p.category,
  unit: p.unit,
  soldAs: p.soldAs,
  widthM: p.widthM,
  unitsPerPack: p.unitsPerPack,
  unitM2: p.unitM2,
  packM2Printed: p.packM2Printed,
  rollM2: p.rollM2,
  costPrice: p.costPrice,
  active: p.active,
});

export const toTradeRule = (r: RuleRow | undefined | null): TradeRule | null =>
  r ? { mode: r.mode, priceOverride: r.priceOverride, gstConfirmed: r.gstConfirmed, unitLabel: r.unitLabel, feesIncluded: r.feesIncluded } : null;

type FeeRule = SupplierChargeRule & { appliesTo: string; supplierId: number };

async function feeRulesFor(supplierIds: number[]): Promise<Map<number, FeeRule[]>> {
  const out = new Map<number, FeeRule[]>();
  const ids = [...new Set(supplierIds)];
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(schema.supplierFeeRules)
    .where(and(inArray(schema.supplierFeeRules.supplierId, ids), eq(schema.supplierFeeRules.active, true)));
  for (const r of rows.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)) {
    const list = out.get(r.supplierId) ?? [];
    list.push(r as FeeRule);
    out.set(r.supplierId, list);
  }
  return out;
}

export type PriceCheck =
  | {
      ok: true;
      units: Extract<ReturnType<typeof unitsFor>, { ok: true }>;
      rate: Extract<ReturnType<typeof rateFor>, { ok: true }>;
      fees: FeeLine[];
      skipped: Array<{ ruleId: number; name: string; reason: string }>;
    }
  | { ok: false; reason: string };

/** Price one product for a qty: selling unit, rate and per unit fees, or why it cannot be priced. */
export function priceProduct(p: TradeProduct, rule: TradeRule | null, rules: FeeRule[], markupPct: number, qty: number): PriceCheck {
  const units = unitsFor(p, rule);
  if (!units.ok) return { ok: false, reason: units.reason };
  const rate = rateFor(p, units, rule, markupPct);
  if (!rate.ok) return { ok: false, reason: rate.reason };
  const feesIncluded = rate.source === "override" && !!rule?.feesIncluded;
  const fees = feesFor(p, units, qty, rules, markupPct, { feesIncluded });
  if (!fees.ok) return { ok: false, reason: fees.reason };
  return { ok: true, units, rate, fees: fees.fees, skipped: fees.skipped };
}

/** The trade list for Settings and Sell: every product that is or could be listed, with what blocks it. */
export async function tradeProducts(input: { search?: string; listedOnly?: boolean; buyerId?: number; limit?: number }) {
  const s = await tradeSettings();
  const term = (input.search ?? "").trim().toLowerCase();
  const rules = await db.select().from(schema.tradeProductRules);
  const ruleOf = new Map(rules.map((r) => [r.productId, r]));
  const where = term
    ? sql`${schema.products.active} = 1 and lower(${schema.products.brand} || ' ' || ${schema.products.range} || ' ' || ${schema.products.colour} || ' ' || ${schema.products.supplier} || ' ' || coalesce(${schema.products.sku}, '')) like ${`%${term}%`}`
    : sql`${schema.products.active} = 1`;
  const all = await db.select().from(schema.products).where(where).limit(input.limit ?? 400);
  const buyer = input.buyerId ? await buyerView(input.buyerId) : null;
  const listed = all.filter((p) => {
    const r = toTradeRule(ruleOf.get(p.id));
    if (!input.listedOnly) return true;
    return buyer ? buyerMayBuy(p, r, s, buyer.categories) : onTradeList(p, r, s);
  });
  const fees = await feeRulesFor(listed.map((p) => p.supplierId).filter((x): x is number => x != null));
  const onHand = await onHandFor(listed.map((p) => p.id));
  return listed.map((p) => {
    const tp = toTradeProduct(p);
    const rule = toTradeRule(ruleOf.get(p.id));
    const priced = priceProduct(tp, rule, p.supplierId ? (fees.get(p.supplierId) ?? []) : [], s.markupPct, 1);
    const flags: string[] = [];
    if (p.costPrice == null || p.costPrice <= 0) flags.push("No standard cost");
    if (!rule?.gstConfirmed) flags.push("GST not confirmed");
    if (!priced.ok) flags.push(priced.reason);
    const have = onHand.get(p.id) ?? 0;
    if (have < -0.0005) flags.push("Negative stock, needs correcting");
    return {
      productId: p.id,
      name: productName(p),
      detail: productDetail(p),
      supplier: p.supplier,
      supplierId: p.supplierId,
      category: p.category,
      unit: p.unit,
      costPrice: p.costPrice,
      rule: rule ? { ...rule } : null,
      onList: onTradeList(p, rule, s),
      buyerMay: buyer ? buyerMayBuy(p, rule, s, buyer.categories) : null,
      priced: priced.ok
        ? {
            sellUnit: priced.units.sellUnit,
            unitLabel: priced.units.unitLabel,
            whole: priced.units.whole,
            m2PerBox: priced.units.m2PerBox,
            rollWidthM: priced.units.rollWidthM,
            rateExGst: priced.rate.rateExGst,
            source: priced.rate.source,
            feesPerUnit: priced.fees.map((f) => ({ name: f.name, costExGst: f.costExGst, chargeExGst: f.chargeExGst, note: f.note })),
            skippedFees: priced.skipped,
          }
        : null,
      blocked: priced.ok ? null : priced.reason,
      onHand: have,
      flags,
    };
  });
}

export async function saveProductRule(
  input: { productId: number; mode: "auto" | "include" | "exclude"; priceOverride: number | null; gstConfirmed: boolean; unitLabel: string; feesIncluded: boolean },
  who: Who,
) {
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
  if (!p) throw notFound("Product not found");
  if (input.priceOverride != null && !(input.priceOverride > 0)) throw bad("A fixed trade price must be above zero, or blank.");
  if (input.feesIncluded && input.priceOverride == null) throw bad("Fees included only applies to a fixed trade price.");
  const [old] = await db.select().from(schema.tradeProductRules).where(eq(schema.tradeProductRules.productId, input.productId));
  const now = new Date();
  const values = {
    mode: input.mode,
    priceOverride: input.priceOverride == null ? null : round2(input.priceOverride),
    gstConfirmed: input.gstConfirmed,
    unitLabel: input.unitLabel.trim().slice(0, 80),
    feesIncluded: input.feesIncluded,
    updatedByName: who.name,
    updatedAt: now,
  };
  const detail = [
    `${productName(p)} ${productDetail(p)}`.trim(),
    `list ${values.mode}`,
    values.priceOverride != null ? `fixed trade price $${values.priceOverride.toFixed(2)} ex GST${values.feesIncluded ? ", fees included" : ""}` : "price calculated",
    values.gstConfirmed ? "GST 10% confirmed" : "GST not confirmed",
    old ? `was ${old.mode}, ${old.priceOverride != null ? `$${old.priceOverride}` : "calculated"}, GST ${old.gstConfirmed ? "confirmed" : "not confirmed"}` : "new",
  ].join(". ");
  await runGuarded([
    old
      ? db.update(schema.tradeProductRules).set(values).where(eq(schema.tradeProductRules.productId, input.productId))
      : db.insert(schema.tradeProductRules).values({ productId: input.productId, ...values, createdAt: now }),
    auditRow({ entityType: "product", entityId: input.productId, action: "product_rule", detail, who }),
  ]);
}

/* --------------------------------- buyers --------------------------------- */

export async function findBuyer(kind: BuyerKind, refId: number) {
  const col = kind === "installer" ? schema.tradeBuyers.installerId : kind === "company" ? schema.tradeBuyers.companyId : schema.tradeBuyers.contactId;
  const [b] = await db.select().from(schema.tradeBuyers).where(eq(col, refId));
  return b ?? null;
}

async function refExists(kind: BuyerKind, refId: number) {
  const t = kind === "installer" ? schema.installers : kind === "company" ? schema.companies : schema.contacts;
  const [r] = await db.select({ id: t.id }).from(t).where(eq(t.id, refId));
  if (!r) throw notFound(`That ${kind} was not found.`);
}

export async function saveBuyer(
  input: {
    kind: BuyerKind;
    refId: number;
    active: boolean;
    categories: string[];
    creditApproved: boolean;
    termsDays: number;
    feePresentation: "itemised" | "combined";
    notes: string;
  },
  who: Who,
) {
  await refExists(input.kind, input.refId);
  const old = await findBuyer(input.kind, input.refId);
  if (!old) await requireTradeOn(); // A new buyer tick is a new trade relationship. Edits stay open when off.
  if (!(Number.isInteger(input.termsDays) && input.termsDays >= 0 && input.termsDays <= 90)) throw bad("Terms must be 0 to 90 days.");
  const now = new Date();
  const creditChanged = !old || old.creditApproved !== input.creditApproved;
  const values = {
    active: input.active,
    categories: JSON.stringify(cleanCats(input.categories)),
    creditApproved: input.creditApproved,
    ...(creditChanged ? { creditApprovedByName: input.creditApproved ? who.name : null, creditApprovedAt: input.creditApproved ? now : null } : {}),
    termsDays: input.termsDays,
    feePresentation: input.feePresentation,
    notes: input.notes.slice(0, 2000),
    updatedAt: now,
  };
  const detail = [
    input.active ? "Trade buyer on" : "Trade buyer off",
    `categories ${cleanCats(input.categories).join(", ") || "none"}`,
    input.creditApproved ? `credit approved, ${input.termsDays} days` : "pay before collection",
    `fees ${input.feePresentation}`,
  ].join(". ");
  if (old) {
    await runGuarded([
      db.update(schema.tradeBuyers).set(values).where(eq(schema.tradeBuyers.id, old.id)),
      auditRow({ entityType: "buyer", entityId: old.id, action: "buyer_saved", detail, who }),
    ]);
    return buyerView(old.id);
  }
  const ref =
    input.kind === "installer" ? { installerId: input.refId } : input.kind === "company" ? { companyId: input.refId } : { contactId: input.refId };
  await runGuarded([
    db.insert(schema.tradeBuyers).values({ ...ref, ...values, createdByName: who.name, createdAt: now }),
    auditRow({ entityType: "buyer", entityId: null, action: "buyer_created", detail: `${input.kind} ${input.refId}. ${detail}`, who }),
  ]);
  const created = await findBuyer(input.kind, input.refId);
  return buyerView(created!.id);
}

/** "Verify same entity": the installer card's ABN is the business that sells the labour and buys the goods. */
export async function verifyEntity(buyerId: number, who: Who) {
  const b = await buyerView(buyerId);
  if (b.kind !== "installer") throw bad("Only an installer card can be verified for offsets. External buyers never get offsets.");
  const abn = (b.abn ?? "").replace(/\D/g, "");
  if (abn.length !== 11) throw bad("The installer card needs its 11 digit ABN first.");
  await runGuarded([
    db
      .update(schema.tradeBuyers)
      .set({ entityAbn: abn, entityVerifiedAt: new Date(), entityVerifiedByName: who.name, updatedAt: new Date() })
      .where(eq(schema.tradeBuyers.id, buyerId)),
    auditRow({ entityType: "buyer", entityId: buyerId, action: "entity_verified", detail: `Same entity verified on ABN ${abn} (${b.name})`, who }),
  ]);
  return buyerView(buyerId);
}

/** Called when an installer card's ABN is edited. A changed ABN is never verified. */
export async function clearEntityOnAbnChange(installerId: number, newAbn: string | null | undefined) {
  const abn = (newAbn ?? "").replace(/\D/g, "");
  const [b] = await db.select().from(schema.tradeBuyers).where(eq(schema.tradeBuyers.installerId, installerId));
  if (!b || !b.entityAbn || b.entityAbn === abn) return;
  await runGuarded([
    db
      .update(schema.tradeBuyers)
      .set({ entityAbn: null, entityVerifiedAt: null, entityVerifiedByName: null, updatedAt: new Date() })
      .where(eq(schema.tradeBuyers.id, b.id)),
    auditRow({
      entityType: "buyer",
      entityId: b.id,
      action: "entity_cleared",
      detail: `ABN changed from ${b.entityAbn} to ${abn || "blank"}. Same entity check cleared.`,
      who: { name: "System", role: "system" },
    }),
  ]);
}

export async function listBuyers() {
  const rows = await db.select().from(schema.tradeBuyers).orderBy(desc(schema.tradeBuyers.updatedAt));
  const views = await buyerViews(rows);
  const sales = await db
    .select({ id: schema.tradeSales.id, buyerId: schema.tradeSales.buyerId })
    .from(schema.tradeSales)
    .where(eq(schema.tradeSales.status, "finalised"));
  const money = await saleMoney(sales.map((s) => s.id));
  return views.map((v) => {
    const mine = sales.filter((s) => s.buyerId === v.id).map((s) => money.get(s.id)!);
    const owing = round2(mine.reduce((t, m) => t + Math.max(0, m.balance), 0));
    const credit = round2(mine.reduce((t, m) => t + Math.max(0, -m.balance), 0));
    return { ...v, salesCount: mine.length, owing, creditBalance: credit };
  });
}

/** The trade tab on a contact, company or installer card. Admin only. */
export async function buyerCard(kind: BuyerKind, refId: number) {
  const b = await findBuyer(kind, refId);
  if (!b) return { buyer: null, sales: [], owing: 0, creditBalance: 0 };
  const buyer = await buyerView(b.id);
  const sales = await listSales({ buyerId: b.id });
  const fin = sales.filter((s) => s.status === "finalised");
  return {
    buyer,
    sales,
    owing: round2(fin.reduce((t, s) => t + Math.max(0, s.money.balance), 0)),
    creditBalance: round2(fin.reduce((t, s) => t + Math.max(0, -s.money.balance), 0)),
  };
}

/* ---------------------------------- sales --------------------------------- */

export async function listSales(input: { buyerId?: number; status?: string; limit?: number }) {
  const conds = [];
  if (input.buyerId) conds.push(eq(schema.tradeSales.buyerId, input.buyerId));
  if (input.status) conds.push(eq(schema.tradeSales.status, input.status));
  const rows = await db
    .select()
    .from(schema.tradeSales)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.tradeSales.id))
    .limit(input.limit ?? 300);
  const money = await saleMoney(rows.map((r) => r.id));
  const buyers = new Map((await buyerViews(await buyerRows(rows.map((r) => r.buyerId)))).map((v) => [v.id, v]));
  const fulfilled = rows.length
    ? new Map(
        (await db.select().from(schema.tradeFulfilments).where(inArray(schema.tradeFulfilments.saleId, rows.map((r) => r.id)))).map((f) => [
          f.saleId,
          f,
        ]),
      )
    : new Map();
  const openOffsets = rows.length
    ? await db
        .select({ saleId: schema.tradeOffsets.saleId, status: schema.tradeOffsets.status, amount: schema.tradeOffsets.amount })
        .from(schema.tradeOffsets)
        .where(inArray(schema.tradeOffsets.saleId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => ({
    id: r.id,
    ref: r.number > 0 ? saleRef(r.number) : `Draft ${r.id}`,
    invoiceRef: r.number > 0 ? invoiceRef(r.number) : null,
    number: r.number > 0 ? r.number : null,
    status: r.status,
    settleBy: r.settleBy,
    buyerId: r.buyerId,
    buyerName: r.status === "draft" ? (buyers.get(r.buyerId)?.name ?? "") : r.billName,
    buyerKind: buyers.get(r.buyerId)?.kind ?? "contact",
    total: r.total,
    dueDate: r.dueDate,
    finalisedAt: r.finalisedAt,
    sentAt: r.sentAt,
    createdAt: r.createdAt,
    fulfilment: fulfilled.get(r.id)?.method ?? null,
    offsetState: offsetState(openOffsets.filter((o) => o.saleId === r.id)),
    money: money.get(r.id)!,
  }));
}

const offsetState = (rows: Array<{ status: string }>) =>
  rows.some((o) => o.status === "proposed")
    ? "proposed"
    : rows.some((o) => o.status === "approved")
      ? "approved"
      : rows.some((o) => o.status === "confirmed")
        ? "confirmed"
        : null;

async function buyerRows(ids: number[]) {
  if (!ids.length) return [];
  return db.select().from(schema.tradeBuyers).where(inArray(schema.tradeBuyers.id, [...new Set(ids)]));
}

async function saleRow(saleId: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!s) throw notFound("Sale not found");
  return s;
}

async function draftRow(saleId: number) {
  const s = await saleRow(saleId);
  if (s.status !== "draft") throw bad("This sale is finalised. Its lines can no longer change. Use a credit note.");
  return s;
}

/** Start a draft. Drafts carry a temporary negative number until finalise gives them the next S number. */
export async function createDraft(input: { buyerId: number; settleBy: "pay" | "deduct"; notes?: string }, who: Who) {
  await requireTradeOn();
  const buyer = await buyerView(input.buyerId);
  if (!buyer.active) throw bad("This buyer's trade tick is off.");
  if (input.settleBy === "deduct" && buyer.kind !== "installer") throw bad("Deduct from next pay is for subcontractor installers only.");
  const now = new Date();
  const [row] = await db
    .insert(schema.tradeSales)
    .values({
      number: sql`(select coalesce(min(number), 0) - 1 from trade_sales where number < 0)`,
      buyerId: buyer.id,
      status: "draft",
      settleBy: input.settleBy,
      billName: buyer.name,
      feePresentation: buyer.feePresentation,
      notes: (input.notes ?? "").slice(0, 2000),
      createdByName: who.name,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await auditRow({ entityType: "sale", entityId: row!.id, saleId: row!.id, action: "draft_created", detail: `Draft for ${buyer.name}`, who });
  return row!.id;
}

export type DraftLineInput =
  | { op: "add"; productId: number; qty: number }
  | { op: "update"; lineId: number; qty: number; discountPct: number; typedPrice: number | null; typedReason: string | null }
  | { op: "remove"; lineId: number }
  | { op: "delivery"; lineId?: number; description: string; amountExGst: number }
  | { op: "settle"; settleBy: "pay" | "deduct" }
  | { op: "notes"; notes: string };

/** Every edit to a draft goes through here, then the whole draft is re-priced. */
export async function editDraft(saleId: number, change: DraftLineInput, who: Who) {
  await requireTradeOn();
  const sale = await draftRow(saleId);
  const now = new Date();
  if (change.op === "add") {
    if (!(change.qty > 0)) throw bad("Enter a quantity above zero.");
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, change.productId));
    if (!p) throw notFound("Product not found");
    const [{ n }] = (await db.all<{ n: number }>(sql`select coalesce(max(sort), 0) + 1 as n from trade_sale_lines where sale_id = ${saleId}`)) as [{ n: number }];
    await db.insert(schema.tradeSaleLines).values({
      saleId,
      sort: n,
      kind: "product",
      productId: p.id,
      description: productName(p),
      detail: productDetail(p),
      qty: change.qty,
      createdAt: now,
      updatedAt: now,
    });
  } else if (change.op === "update") {
    const line = await draftLine(saleId, change.lineId);
    if (line.kind !== "product") throw bad("Only product lines take a quantity.");
    if (!(change.qty > 0)) throw bad("Enter a quantity above zero, or remove the line.");
    if (!(change.discountPct >= 0 && change.discountPct < 100)) throw bad("Discount must be 0 to 99%.");
    if (change.typedPrice != null && (!(change.typedPrice >= 0) || !(change.typedReason ?? "").trim())) {
      throw bad("A typed price needs a reason.");
    }
    await db
      .update(schema.tradeSaleLines)
      .set({
        qty: change.qty,
        discountPct: change.discountPct,
        priceSource: change.typedPrice != null ? "typed" : "calculated",
        unitPriceExGst: change.typedPrice != null ? round2(change.typedPrice) : line.unitPriceExGst,
        typedReason: change.typedPrice != null ? (change.typedReason ?? "").trim().slice(0, 300) : null,
        updatedAt: now,
      })
      .where(eq(schema.tradeSaleLines.id, line.id));
  } else if (change.op === "remove") {
    const line = await draftLine(saleId, change.lineId);
    if (line.kind === "fee") throw bad("A supplier fee goes with its product. Remove the product, or set a trade price with fees included.");
    // Draft working lines only. A finalised line is never deleted.
    await db.batch([
      db.delete(schema.tradeSaleLines).where(and(eq(schema.tradeSaleLines.saleId, saleId), eq(schema.tradeSaleLines.parentLineId, line.id))),
      db.delete(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.id, line.id)),
    ]);
  } else if (change.op === "delivery") {
    if (!change.description.trim()) throw bad("Describe the delivery.");
    if (!(change.amountExGst > 0)) throw bad("Enter the delivery charge ex GST.");
    const t = lineTotals(1, round2(change.amountExGst), 0, GST_RATE);
    const values = {
      kind: "delivery",
      description: change.description.trim().slice(0, 200),
      sellUnit: "each",
      unitLabel: "each",
      qty: 1,
      priceSource: "typed",
      unitPriceExGst: round2(change.amountExGst),
      gstRate: GST_RATE,
      ...t,
      updatedAt: now,
    };
    if (change.lineId) {
      const line = await draftLine(saleId, change.lineId);
      if (line.kind !== "delivery") throw bad("That is not a delivery line.");
      await db.update(schema.tradeSaleLines).set(values).where(eq(schema.tradeSaleLines.id, line.id));
    } else {
      const [{ n }] = (await db.all<{ n: number }>(sql`select coalesce(max(sort), 0) + 1 as n from trade_sale_lines where sale_id = ${saleId}`)) as [{ n: number }];
      await db.insert(schema.tradeSaleLines).values({ saleId, sort: n, ...values, createdAt: now });
    }
  } else if (change.op === "settle") {
    const buyer = await buyerView(sale.buyerId);
    if (change.settleBy === "deduct" && buyer.kind !== "installer") throw bad("Deduct from next pay is for subcontractor installers only.");
    await db.update(schema.tradeSales).set({ settleBy: change.settleBy, updatedAt: now }).where(eq(schema.tradeSales.id, saleId));
  } else if (change.op === "notes") {
    await db.update(schema.tradeSales).set({ notes: change.notes.slice(0, 2000), updatedAt: now }).where(eq(schema.tradeSales.id, saleId));
  }
  await repriceDraft(saleId);
  // Typed prices, delivery charges and the settle choice are the edits worth a trail.
  const detail =
    change.op === "update" && change.typedPrice != null
      ? `Typed price $${round2(change.typedPrice).toFixed(2)} on line ${change.lineId}: ${(change.typedReason ?? "").trim().slice(0, 300)}`
      : change.op === "delivery"
        ? `Delivery $${round2(change.amountExGst).toFixed(2)} ex GST: ${change.description.trim().slice(0, 200)}`
        : change.op === "settle"
          ? `Settle by ${change.settleBy === "deduct" ? "deduct from next pay" : "pay"}`
          : null;
  if (detail) await auditRow({ entityType: "sale", entityId: saleId, saleId, action: `draft_${change.op}`, detail, who });
}

async function draftLine(saleId: number, lineId: number) {
  const [l] = await db.select().from(schema.tradeSaleLines).where(and(eq(schema.tradeSaleLines.id, lineId), eq(schema.tradeSaleLines.saleId, saleId)));
  if (!l) throw notFound("Line not found");
  return l;
}

export type LineIssue = { lineId: number; message: string };

type Repriced = {
  stmts: BatchItem<"sqlite">[];
  issues: LineIssue[];
  subtotal: number;
  gst: number;
  total: number;
  markupPct: number;
};

/** Work every line of a draft out again from today's figures. Returns the writes, not yet run. */
async function planReprice(saleId: number): Promise<Repriced> {
  const s = await tradeSettings();
  const sale = await saleRow(saleId);
  const buyer = await buyerView(sale.buyerId);
  const lines = await db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, saleId)).orderBy(schema.tradeSaleLines.sort, schema.tradeSaleLines.id);
  const productIds = lines.filter((l) => l.kind === "product" && l.productId).map((l) => l.productId!);
  const products = productIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, productIds)) : [];
  const pOf = new Map(products.map((p) => [p.id, p]));
  const rules = productIds.length ? await db.select().from(schema.tradeProductRules).where(inArray(schema.tradeProductRules.productId, productIds)) : [];
  const rOf = new Map(rules.map((r) => [r.productId, r]));
  const feeRules = await feeRulesFor(products.map((p) => p.supplierId).filter((x): x is number => x != null));
  const now = new Date();
  const stmts: BatchItem<"sqlite">[] = [
    db.delete(schema.tradeSaleLines).where(and(eq(schema.tradeSaleLines.saleId, saleId), eq(schema.tradeSaleLines.kind, "fee"))),
  ];
  const issues: LineIssue[] = [];
  let subtotal = 0;
  let gst = 0;
  for (const l of lines) {
    if (l.kind === "fee") continue;
    if (l.kind === "delivery") {
      subtotal += l.lineExGst;
      gst += l.gstAmount;
      continue;
    }
    const p = pOf.get(l.productId!);
    if (!p) {
      issues.push({ lineId: l.id, message: "Product no longer in the price book." });
      continue;
    }
    const rule = toTradeRule(rOf.get(p.id));
    const tp = toTradeProduct(p);
    if (!buyerMayBuy(tp, rule, s, buyer.categories)) {
      issues.push({
        lineId: l.id,
        message: onTradeList(tp, rule, s) ? `${buyer.name} is not set up to buy ${p.category.replace(/_/g, " ")}.` : "Not on the trade list.",
      });
    }
    if (!rule?.gstConfirmed) issues.push({ lineId: l.id, message: "GST 10% not confirmed for this product in Trade settings." });
    const priced = priceProduct(tp, rule, p.supplierId ? (feeRules.get(p.supplierId) ?? []) : [], s.markupPct, l.qty);
    if (!priced.ok) {
      issues.push({ lineId: l.id, message: priced.reason });
      stmts.push(
        db
          .update(schema.tradeSaleLines)
          .set({ unitPriceExGst: l.priceSource === "typed" ? l.unitPriceExGst : 0, lineExGst: 0, gstAmount: 0, lineIncGst: 0, updatedAt: now })
          .where(eq(schema.tradeSaleLines.id, l.id)),
      );
      continue;
    }
    const u = priced.units;
    if (u.whole && Math.abs(l.qty - Math.round(l.qty)) > 1e-9) issues.push({ lineId: l.id, message: `Sold in whole ${u.sellUnit === "box" ? "boxes" : u.unitLabel}.` });
    const unitPrice = l.priceSource === "typed" ? l.unitPriceExGst : priced.rate.rateExGst;
    const t = lineTotals(l.qty, unitPrice, l.discountPct, GST_RATE);
    subtotal += t.lineExGst;
    gst += t.gstAmount;
    stmts.push(
      db
        .update(schema.tradeSaleLines)
        .set({
          description: productName(p),
          detail: productDetail(p),
          sellUnit: u.sellUnit,
          unitLabel: u.unitLabel,
          priceSource: l.priceSource === "typed" ? "typed" : priced.rate.source,
          standardCostExGst: p.costPrice,
          costUnit: p.unit,
          costPerSellUnit: priced.rate.costPerSellExGst,
          stockPerSellUnit: u.stockPerSell,
          stockUnit: u.stockUnit,
          m2PerBox: u.m2PerBox,
          rollWidthM: u.rollWidthM,
          markupPct: priced.rate.source === "calculated" && l.priceSource !== "typed" ? s.markupPct : null,
          unitPriceExGst: unitPrice,
          gstRate: GST_RATE,
          ...t,
          updatedAt: now,
        })
        .where(eq(schema.tradeSaleLines.id, l.id)),
    );
    let k = 0;
    for (const f of priced.fees) {
      k += 1;
      const ft = lineTotals(1, f.chargeExGst, 0, GST_RATE);
      subtotal += ft.lineExGst;
      gst += ft.gstAmount;
      stmts.push(
        db.insert(schema.tradeSaleLines).values({
          saleId,
          sort: l.sort,
          kind: "fee",
          parentLineId: l.id,
          productId: p.id,
          feeRuleId: f.ruleId,
          feeKind: f.kind,
          description: f.name,
          detail: f.note,
          sellUnit: "each",
          unitLabel: "fee",
          qty: 1,
          priceSource: "fee",
          markupPct: f.markupPct,
          feeCostExGst: f.costExGst,
          unitPriceExGst: f.chargeExGst,
          gstRate: GST_RATE,
          ...ft,
          createdAt: new Date(now.getTime() + k),
          updatedAt: now,
        }),
      );
    }
  }
  subtotal = round2(subtotal);
  gst = round2(gst);
  if (!lines.some((l) => l.kind === "product")) issues.push({ lineId: 0, message: "Add at least one product." });
  return { stmts, issues, subtotal, gst, total: round2(subtotal + gst), markupPct: s.markupPct };
}

async function repriceDraft(saleId: number) {
  const plan = await planReprice(saleId);
  await runGuarded([
    guard(sql`(select status from trade_sales where id = ${saleId}) = 'draft'`),
    ...plan.stmts,
    db
      .update(schema.tradeSales)
      .set({ subtotal: plan.subtotal, gst: plan.gst, total: plan.total, markupPct: plan.markupPct, rev: sql`rev + 1`, updatedAt: new Date() })
      .where(eq(schema.tradeSales.id, saleId)),
  ]);
}

/**
 * Finalise: re-price, refuse if anything moved since `rev` was read, then take
 * the next S number and freeze the sale, all in one write. A repeat press or a
 * retry finds it already finalised and does nothing.
 */
export async function finalise(saleId: number, rev: number, who: Who) {
  const sale = await saleRow(saleId);
  if (sale.status === "finalised") return { already: true, number: sale.number };
  if (sale.status !== "draft") throw bad("This sale was cancelled.");
  await requireTradeOn();
  if (sale.rev !== rev) throw conflict("This draft changed since you opened it. Check the lines and finalise again.");
  const plan = await planReprice(saleId);
  if (plan.issues.length) throw bad(`Not ready: ${[...new Set(plan.issues.map((i) => i.message))].join(" ")}`);
  if (plan.total !== sale.total || plan.subtotal !== sale.subtotal) {
    await repriceDraft(saleId);
    throw conflict("Prices changed since you opened this draft. The new figures are on screen. Check them and finalise again.");
  }
  if (!(plan.total > 0)) throw bad("A sale needs a total above zero.");
  const buyer = await buyerView(sale.buyerId);
  if (!buyer.active) throw bad("This buyer's trade tick is off.");
  if (sale.settleBy === "deduct" && buyer.kind !== "installer") throw bad("Deduct from next pay is for subcontractor installers only.");
  const today = ymd();
  const credit = buyer.creditApproved;
  const now = new Date();
  try {
    await runGuarded([
      guard(sql`(select status from trade_sales where id = ${saleId}) = 'draft' and (select rev from trade_sales where id = ${saleId}) = ${rev}`),
      ...plan.stmts,
      db
        .update(schema.tradeSales)
        .set({
          number: sql`(select next_number from trade_settings where id = 1)`,
          status: "finalised",
          billName: buyer.name,
          billAbn: buyer.abn,
          billEmail: buyer.email,
          billAddress: buyer.address,
          termsDays: credit ? buyer.termsDays : null,
          payBeforeCollection: !credit,
          dueDate: credit ? addDays(today, buyer.termsDays) : today,
          feePresentation: buyer.feePresentation,
          markupPct: plan.markupPct,
          subtotal: plan.subtotal,
          gst: plan.gst,
          total: plan.total,
          finalisedAt: now,
          finalisedByName: who.name,
          rev: sql`rev + 1`,
          updatedAt: now,
        })
        .where(eq(schema.tradeSales.id, saleId)),
      db.update(schema.tradeSettings).set({ nextNumber: sql`next_number + 1` }).where(eq(schema.tradeSettings.id, 1)),
      db.run(sql`insert into trade_audit (entity_type, entity_id, sale_id, action, detail, actor_name, actor_role, created_at)
        select 'sale', ${saleId}, ${saleId}, 'finalised',
          'Finalised ' || 'S' || number || '-1 for ' || ${buyer.name} || ', total $' || printf('%.2f', total) || '. ' || ${credit ? `Credit approved, ${buyer.termsDays} days.` : "Pay before collection."} || ' Settle by ' || ${sale.settleBy === "deduct" ? "deduct from next pay (needs an approved offset)" : "payment"} || '.',
          ${who.name}, ${who.role}, unixepoch()
        from trade_sales where id = ${saleId}`),
    ]);
  } catch (e) {
    const again = await saleRow(saleId);
    if (again.status === "finalised") return { already: true, number: again.number };
    if (e instanceof Error && e.message === GUARD_MSG) throw conflict("This draft changed while finalising. Nothing was saved. Reload and try again.");
    throw e;
  }
  const done = await saleRow(saleId);
  return { already: false, number: done.number };
}

/* ---------------------------------- views --------------------------------- */

export async function saleView(saleId: number) {
  const sale = await saleRow(saleId);
  const buyer = await buyerView(sale.buyerId);
  const [lines, credits, creditLines, payments, fulfilment, returns, offsets, auditRows, settlements] = await Promise.all([
    db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, saleId)).orderBy(schema.tradeSaleLines.sort, schema.tradeSaleLines.id),
    db.select().from(schema.tradeCreditNotes).where(eq(schema.tradeCreditNotes.saleId, saleId)).orderBy(schema.tradeCreditNotes.seq),
    db
      .select({ l: schema.tradeCreditLines })
      .from(schema.tradeCreditLines)
      .innerJoin(schema.tradeCreditNotes, eq(schema.tradeCreditNotes.id, schema.tradeCreditLines.creditId))
      .where(eq(schema.tradeCreditNotes.saleId, saleId)),
    db.select().from(schema.tradePayments).where(eq(schema.tradePayments.saleId, saleId)).orderBy(schema.tradePayments.id),
    db.select().from(schema.tradeFulfilments).where(eq(schema.tradeFulfilments.saleId, saleId)),
    db.select().from(schema.tradeReturns).where(eq(schema.tradeReturns.saleId, saleId)).orderBy(schema.tradeReturns.id),
    db.select().from(schema.tradeOffsets).where(eq(schema.tradeOffsets.saleId, saleId)).orderBy(schema.tradeOffsets.id),
    db.select().from(schema.tradeAudit).where(eq(schema.tradeAudit.saleId, saleId)).orderBy(desc(schema.tradeAudit.id)),
    db.select().from(schema.installerBillSettlements).where(eq(schema.installerBillSettlements.saleId, saleId)).orderBy(schema.installerBillSettlements.id),
  ]);
  const issues = sale.status === "draft" ? (await planReprice(saleId)).issues : [];
  const money = await oneSaleMoney(saleId);
  const creditedOn = new Map<number, { qty: number; ex: number; inc: number }>();
  for (const { l } of creditLines) {
    const c = creditedOn.get(l.saleLineId) ?? { qty: 0, ex: 0, inc: 0 };
    c.qty += l.qty;
    c.ex = round2(c.ex + l.lineExGst);
    c.inc = round2(c.inc + l.lineIncGst);
    creditedOn.set(l.saleLineId, c);
  }
  const returnedOn = new Map<number, number>();
  for (const r of returns) returnedOn.set(r.saleLineId, (returnedOn.get(r.saleLineId) ?? 0) + r.qty);
  const billIds = [...new Set(offsets.map((o) => o.billId).filter((x): x is number => x != null))];
  const bills = billIds.length
    ? await db
        .select({ id: schema.installerInvoices.id, number: schema.installerInvoices.invoiceNumber, total: schema.installerInvoices.total, status: schema.installerInvoices.status, jobNumber: schema.installerInvoices.jobNumber })
        .from(schema.installerInvoices)
        .where(inArray(schema.installerInvoices.id, billIds))
    : [];
  const productIds = lines.filter((l) => l.kind === "product" && l.productId).map((l) => l.productId!);
  const onHand = await onHandFor(productIds);
  return {
    id: sale.id,
    ref: sale.number > 0 ? saleRef(sale.number) : `Draft ${sale.id}`,
    invoiceRef: sale.number > 0 ? invoiceRef(sale.number) : null,
    number: sale.number > 0 ? sale.number : null,
    status: sale.status,
    settleBy: sale.settleBy,
    rev: sale.rev,
    buyer,
    bill: { name: sale.billName, abn: sale.billAbn, email: sale.billEmail, address: sale.billAddress },
    terms: { termsDays: sale.termsDays, payBeforeCollection: sale.payBeforeCollection, dueDate: sale.dueDate },
    feePresentation: sale.feePresentation,
    markupPct: sale.markupPct,
    subtotal: sale.subtotal,
    gst: sale.gst,
    total: sale.total,
    finalisedAt: sale.finalisedAt,
    finalisedByName: sale.finalisedByName,
    sentAt: sale.sentAt,
    sentTo: sale.sentTo,
    cancelledAt: sale.cancelledAt,
    cancelledByName: sale.cancelledByName,
    cancelReason: sale.cancelReason,
    arrangement: sale.arrangementNote ? { note: sale.arrangementNote, by: sale.arrangementByName, at: sale.arrangementAt } : null,
    notes: sale.notes,
    lines: lines.map((l) => ({
      ...l,
      credited: creditedOn.get(l.id) ?? { qty: 0, ex: 0, inc: 0 },
      returnedQty: returnedOn.get(l.id) ?? 0,
      onHand: l.productId && l.kind === "product" ? (onHand.get(l.productId) ?? 0) : null,
    })),
    issues,
    credits: credits.map((c) => ({ ...c, ref: creditRef(sale.number, c.seq), lines: creditLines.filter((x) => x.l.creditId === c.id).map((x) => x.l) })),
    payments,
    fulfilment: fulfilment[0] ?? null,
    returns,
    offsets: offsets.map((o) => ({ ...o, bill: bills.find((b) => b.id === o.billId) ?? null })),
    settlements,
    audit: auditRows,
    money,
  };
}

const creditRef = (n: number, seq: number) => `S${n}-${seq}`;

/** Last price sold, from finalised sales only, never drafts and never re-worked. Reference only. */
export async function lastPrices(productId: number, buyerId: number | null) {
  const base = and(eq(schema.tradeSaleLines.productId, productId), eq(schema.tradeSaleLines.kind, "product"), eq(schema.tradeSales.status, "finalised"), isNotNull(schema.tradeSales.finalisedAt));
  const pick = {
    unitPriceExGst: schema.tradeSaleLines.unitPriceExGst,
    discountPct: schema.tradeSaleLines.discountPct,
    sellUnit: schema.tradeSaleLines.sellUnit,
    unitLabel: schema.tradeSaleLines.unitLabel,
    finalisedAt: schema.tradeSales.finalisedAt,
    number: schema.tradeSales.number,
    buyerName: schema.tradeSales.billName,
  };
  const [any] = await db
    .select(pick)
    .from(schema.tradeSaleLines)
    .innerJoin(schema.tradeSales, eq(schema.tradeSales.id, schema.tradeSaleLines.saleId))
    .where(base)
    .orderBy(desc(schema.tradeSales.finalisedAt), desc(schema.tradeSaleLines.id))
    .limit(1);
  const [mine] = buyerId
    ? await db
        .select(pick)
        .from(schema.tradeSaleLines)
        .innerJoin(schema.tradeSales, eq(schema.tradeSales.id, schema.tradeSaleLines.saleId))
        .where(and(base, eq(schema.tradeSales.buyerId, buyerId)))
        .orderBy(desc(schema.tradeSales.finalisedAt), desc(schema.tradeSaleLines.id))
        .limit(1)
    : [];
  const shape = (r: typeof any | undefined) =>
    r
      ? {
          rateExGst: r.unitPriceExGst,
          discountPct: r.discountPct,
          sellUnit: r.sellUnit,
          unitLabel: r.unitLabel,
          date: r.finalisedAt ? ymd(r.finalisedAt) : null,
          ref: invoiceRef(r.number),
          buyerName: r.buyerName,
          gst: "ex GST" as const,
        }
      : null;
  return { thisBuyer: shape(mine), anyBuyer: shape(any) };
}

export { parseCategories };
