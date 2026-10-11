import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of } from "./flooring-qty";
import { ordersByRoll, rollOrder } from "./order-sizes";
import { lmForQty, m2ForQty, resolveSupplierCharges, todayISO, type SupplierChargeRule } from "./pricing";
import { feeAppliesTo } from "./purchase-orders";

/* ---------------------------------------------------------------------------
 * Supplier freight and charges, built into the material lines of a quote.
 * Fix list 11 Oct, item 14 and answer 5.
 *
 *  - Each supplier on a quote is one order. Its automatic charges (freight,
 *    baling, handling, fuel, levies) are worked out with the same rules the
 *    PO uses, for the place the supplier delivers to (EC: the warehouse).
 *  - That money is spread over the supplier's own material lines, in step
 *    with each line's cost, and added to the line's cost per unit.
 *  - The sell moves with it at the line's own markup (sell / cost), so the
 *    freight is recovered at the same margin as the goods. A discount on the
 *    line (list price) moves the same way, so the discount % holds.
 *  - The client never sees a freight line. The office sees "includes $X".
 *  - `freight_unit_cost` keeps how much of the cost per unit is freight, so
 *    the line can be worked out again when its qty or the quote changes.
 *  - Accepted, declined, expired and replaced quotes are never touched.
 *
 * One difference from the PO: a supplier who does not deliver themselves
 * (Advantage, through Jocks) still costs Terra the carrier's bill. The PO
 * leaves that off because the carrier invoices it, but the quote must
 * recover it, so carrier freight rules count here.
 * ------------------------------------------------------------------------- */

const LOCKED = new Set(["accepted", "declined", "expired", "replaced"]);

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

export type FreightProduct = {
  id: number;
  supplierId: number | null;
  category: string;
  unit: string;
  soldAs?: string | null;
  widthM?: number | null;
  unitsPerPack?: number | null;
  unitM2?: number | null;
  packM2Printed?: number | null;
  rollM2?: number | null;
  rollLengthM?: number | null;
  heldInWarehouse?: boolean | null;
};

export type FreightLine = {
  id: number;
  productId: number | null;
  lineType: string;
  qty: number;
  unitCost: number | null;
  unitPrice: number;
  listUnitPrice: number | null;
  freightUnitCost: number | null;
};

export type FreightSupplier = { id: number; name: string; deliversTo?: string | null; deliversDirect?: boolean | null };
export type FreightRule = SupplierChargeRule & { supplierId: number; appliesTo?: string | null };

export type FreightPlanSupplier = {
  supplierId: number;
  name: string;
  /** Where the order goes: the warehouse unless the supplier only delivers to site. */
  deliverTo: "warehouse" | "site";
  goodsExGst: number;
  chargesExGst: number;
  charges: { name: string; exGst: number; note: string }[];
  lineIds: number[];
};

export type FreightLineUpdate = {
  id: number;
  freightUnitCost: number;
  unitCost: number;
  unitPrice: number;
  listUnitPrice: number | null;
};

/** Cost per unit before any freight was added. */
function baseCostOf(l: FreightLine) {
  return Math.max(0, (l.unitCost ?? 0) - (l.freightUnitCost ?? 0));
}

/** A material line with a costed product from a supplier. Only these carry freight. */
function carries(l: FreightLine, p: FreightProduct | undefined): p is FreightProduct & { supplierId: number } {
  return Boolean(l.lineType === "material" && p && p.supplierId && l.qty > 0 && baseCostOf(l) > 0);
}

/** The order measured the way the supplier's rules read it. */
function measure(lines: { l: FreightLine; p: FreightProduct }[]) {
  let m2 = 0;
  let lm = 0;
  let items = 0;
  let boxes = 0;
  let rolls = 0;
  let boxed = false;
  for (const { l, p } of lines) {
    const unit = p.unit;
    m2 += m2ForQty(l.qty, unit, p.widthM ?? null) ?? 0;
    lm += lmForQty(l.qty, unit, p.widthM ?? null) ?? 0;
    if (unit === "each") items += l.qty;
    if (p.soldAs === "box") {
      boxed = true;
      const per = boxM2Of(p);
      boxes += per && unit === "m2" ? Math.ceil(l.qty / per - 1e-9) : Math.ceil(l.qty - 1e-9);
    }
    // One cut is baled and sent as one roll. Roll goods count their rolls.
    if (ordersByRoll(p)) rolls += rollOrder(p, l.qty)?.rolls ?? 1;
    else if (p.soldAs === "broadloom") rolls += 1;
  }
  // Boxed goods go on a pallet. Broadloom on its own does not.
  return { m2: r2(m2), lm: r2(lm), items: r2(items), boxes, rolls, pallets: boxed ? 1 : 0, shipments: 1 };
}

/**
 * Pure. What each supplier on the quote charges for its order, and the new
 * cost and sell of every line that changes.
 */
export function planQuoteFreight(
  lines: FreightLine[],
  products: Map<number, FreightProduct>,
  suppliers: Map<number, FreightSupplier>,
  rules: FreightRule[],
  today = todayISO(),
): { suppliers: FreightPlanSupplier[]; updates: FreightLineUpdate[] } {
  const groups = new Map<number, { l: FreightLine; p: FreightProduct }[]>();
  for (const l of lines) {
    const p = l.productId != null ? products.get(l.productId) : undefined;
    if (!carries(l, p)) continue;
    if (!suppliers.has(p.supplierId)) continue;
    groups.set(p.supplierId, [...(groups.get(p.supplierId) ?? []), { l, p }]);
  }

  const share = new Map<number, number>();
  const out: FreightPlanSupplier[] = [];
  for (const [supplierId, group] of groups) {
    const s = suppliers.get(supplierId)!;
    const deliverTo = s.deliversTo === "site" ? "site" : "warehouse";
    const own = rules.filter((r) => r.supplierId === supplierId && r.active !== false && feeAppliesTo(r.appliesTo, deliverTo));
    const goods = r2(group.reduce((a, { l }) => a + baseCostOf(l) * l.qty, 0));
    // Carrier freight is Terra's cost on a quote, so deliversDirect is not applied (see top).
    const q = resolveSupplierCharges({ name: s.name, deliversDirect: true }, own, { goodsExGst: goods, ...measure(group) }, { today });
    const total = Math.max(0, q.chargesExGst);
    out.push({
      supplierId,
      name: s.name,
      deliverTo,
      goodsExGst: goods,
      chargesExGst: r2(total),
      charges: q.charges.map((c) => ({ name: c.name, exGst: c.exGst, note: c.note })),
      lineIds: group.map(({ l }) => l.id),
    });
    if (total <= 0 || goods <= 0) continue;
    for (const { l } of group) share.set(l.id, (total * baseCostOf(l) * l.qty) / goods);
  }

  const updates: FreightLineUpdate[] = [];
  for (const l of lines) {
    const old = l.freightUnitCost ?? 0;
    const lineShare = share.get(l.id) ?? 0;
    if (!old && !lineShare) continue;
    const cost = l.unitCost ?? 0;
    if (cost <= 0 || l.qty <= 0) {
      // Nothing to scale against. Drop the record so it cannot be added twice later.
      if (old) updates.push({ id: l.id, freightUnitCost: 0, unitCost: l.unitCost ?? 0, unitPrice: l.unitPrice, listUnitPrice: l.listUnitPrice });
      continue;
    }
    const freightUnitCost = r4(lineShare / l.qty);
    if (Math.abs(freightUnitCost - old) < 0.00005) continue;
    const nextCost = r4(baseCostOf(l) + freightUnitCost);
    // Sell and list price keep their ratio to cost: same markup, same discount.
    const ratio = nextCost / cost;
    updates.push({
      id: l.id,
      freightUnitCost,
      unitCost: nextCost,
      unitPrice: r2(l.unitPrice * ratio),
      listUnitPrice: l.listUnitPrice == null ? null : r2(l.listUnitPrice * ratio),
    });
  }
  return { suppliers: out, updates };
}

async function loadFor(quoteId: number) {
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is number => x != null))];
  const products = productIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, productIds)) : [];
  const supplierIds = [...new Set(products.map((p) => p.supplierId).filter((x): x is number => x != null))];
  const [suppliers, rules] = supplierIds.length
    ? await Promise.all([
        db.select().from(schema.suppliers).where(inArray(schema.suppliers.id, supplierIds)),
        db
          .select()
          .from(schema.supplierFeeRules)
          .where(and(inArray(schema.supplierFeeRules.supplierId, supplierIds), eq(schema.supplierFeeRules.active, true))),
      ])
    : [[], []];
  return {
    items,
    products: new Map(products.map((p) => [p.id, p as FreightProduct])),
    suppliers: new Map(suppliers.map((s) => [s.id, s as FreightSupplier])),
    rules: [...rules].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)) as FreightRule[],
  };
}

/**
 * Work the freight into the lines again. Called from recalc, so every add,
 * edit, remove and new version goes through it. Returns how many lines moved.
 */
export async function refreshQuoteFreight(quoteId: number): Promise<number> {
  const [quote] = await db.select({ status: schema.quotes.status }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote || LOCKED.has(quote.status)) return 0;
  const { items, products, suppliers, rules } = await loadFor(quoteId);
  const { updates } = planQuoteFreight(items, products, suppliers, rules);
  if (!updates.length) return 0;
  const byId = new Map(items.map((i) => [i.id, i]));
  const now = new Date();
  for (const u of updates) {
    await db
      .update(schema.quoteItems)
      .set({
        freightUnitCost: u.freightUnitCost || null,
        unitCost: u.unitCost,
        unitPrice: u.unitPrice,
        listUnitPrice: u.listUnitPrice,
        total: r2((byId.get(u.id)?.qty ?? 0) * u.unitPrice),
        updatedAt: now,
      })
      .where(eq(schema.quoteItems.id, u.id));
  }
  return updates.length;
}

export type QuoteFreightView = {
  supplier: string;
  /** Freight and charges inside the line costs now, ex GST. */
  costExGst: number;
  /** What it adds to the client price, ex GST. */
  sellExGst: number;
  /** The charges that make it up, from the supplier's rules today. */
  charges: string;
};

/** For the office: which supplier charges sit inside the prices. Cost viewers only. */
export async function quoteFreightView(quoteId: number): Promise<QuoteFreightView[]> {
  const { items, products, suppliers, rules } = await loadFor(quoteId);
  const plan = planQuoteFreight(items.map((i) => ({ ...i, freightUnitCost: i.freightUnitCost })), products, suppliers, rules);
  const named = new Map(plan.suppliers.map((s) => [s.supplierId, s]));
  const sums = new Map<number, { cost: number; sell: number }>();
  for (const i of items) {
    const f = i.freightUnitCost ?? 0;
    const p = i.productId != null ? products.get(i.productId) : undefined;
    if (!f || !p?.supplierId) continue;
    const ratio = i.unitCost && i.unitCost > 0 ? i.unitPrice / i.unitCost : 0;
    const s = sums.get(p.supplierId) ?? { cost: 0, sell: 0 };
    s.cost += f * i.qty;
    s.sell += f * i.qty * ratio;
    sums.set(p.supplierId, s);
  }
  return [...sums.entries()].map(([id, s]) => ({
    supplier: suppliers.get(id)?.name ?? "Supplier",
    costExGst: r2(s.cost),
    sellExGst: r2(s.sell),
    charges: (named.get(id)?.charges ?? []).map((c) => c.name).join(", "),
  }));
}

/** Per line, for the office: the freight inside this line's total, at sell. */
export function lineFreightSell(i: { freightUnitCost: number | null; qty: number; unitCost: number | null; unitPrice: number }) {
  const f = i.freightUnitCost ?? 0;
  if (!f || !i.unitCost || i.unitCost <= 0) return null;
  return r2(f * i.qty * (i.unitPrice / i.unitCost));
}
