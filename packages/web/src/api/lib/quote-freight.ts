import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of } from "./flooring-qty";
import { ordersByRoll, rollOrder } from "./order-sizes";
import { lmForQty, m2ForQty, resolveSupplierCharges, todayISO, type ResolvedCharge, type SupplierChargeRule } from "./pricing";
import { feeAppliesTo } from "./purchase-orders";
import { SUPPLIER_CHARGE } from "./line-kinds";
import { foldCharges, isChargeLine, SUPPLIER_CHARGES_MARKUP_DEFAULT, SUPPLIER_CHARGES_MARKUP_KEY } from "./charge-fold";

export { SUPPLIER_CHARGES_MARKUP_DEFAULT, SUPPLIER_CHARGES_MARKUP_KEY };

/* ---------------------------------------------------------------------------
 * Supplier freight and charges on a quote, as their own internal lines.
 * Notes 18.33 (replaces 18.13, freight inside the material line price).
 *
 *  - Each supplier on a quote is one order. Its automatic charges (freight,
 *    baling, handling, fuel, levies) are worked out with the same rules the
 *    PO uses, for the place the supplier delivers to (EC: the warehouse).
 *  - Each charge is one line, kind supplier_charge, for example
 *    "Supplier freight: Sunstar (1 pallet)". Qty is the charge's own units
 *    (pallets, rolls), cost is the rule's rate, and sell is cost plus the
 *    Settings "Supplier charges markup %" (15 by default).
 *  - Pallets: every boxed product's boxes over its boxes per pallet, added up
 *    and rounded up. A product with no boxes per pallet counts 1 pallet and
 *    the line is flagged to check.
 *  - The product lines keep their true price book cost and sell.
 *  - A line someone has typed over stays as typed (charge_typed).
 *  - The client never sees these lines: lib/charge-fold.ts spreads their sell
 *    into that supplier's product lines on every client copy.
 *  - They never go on Materials to order or a PO (the PO adds the supplier
 *    charges itself). Their cost counts with the supplier's materials.
 *  - Older drafts with freight inside the line (freight_unit_cost) move to
 *    this way the next time they change: the freight comes back out of the
 *    line at the line's own ratio and the charge line goes on.
 *  - Accepted, declined, expired, replaced and cancelled quotes are never touched.
 *
 * One difference from the PO: a supplier who does not deliver themselves
 * (Advantage, through Jocks) still costs Terra the carrier's bill. The PO
 * leaves that off because the carrier invoices it, but the quote must
 * recover it, so carrier freight rules count here.
 * ------------------------------------------------------------------------- */

const LOCKED = new Set(["accepted", "declined", "expired", "replaced", "cancelled"]);

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
  range?: string | null;
  colour?: string | null;
  boxesPerPallet?: number | null;
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
  kind?: string;
  chargeSupplierId?: number | null;
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
  pallets: number;
  /** Set when a boxed product has no boxes per pallet on file. */
  palletFlag: string | null;
};

/** One supplier charge line the quote should have. */
export type ChargeLineWant = {
  supplierId: number;
  key: string;
  description: string;
  qty: number;
  unit: string;
  unitCost: number;
  unitPrice: number;
  total: number;
  markupPercent: number;
  flagged: boolean;
  flagReason: string | null;
};

/** An older line with freight inside its price, put back to its own price. */
export type FreightLineUpdate = {
  id: number;
  unitCost: number;
  unitPrice: number;
  listUnitPrice: number | null;
};

/** Cost per unit before any freight was added. */
function baseCostOf(l: FreightLine) {
  return Math.max(0, (l.unitCost ?? 0) - (l.freightUnitCost ?? 0));
}

/** A material line with a costed product from a supplier. Only these make charges. */
function carries(l: FreightLine, p: FreightProduct | undefined): p is FreightProduct & { supplierId: number } {
  return Boolean(l.lineType === "material" && !isChargeLine({ kind: l.kind ?? "", chargeSupplierId: l.chargeSupplierId }) && p && p.supplierId && l.qty > 0 && baseCostOf(l) > 0);
}

/** Boxes on one line: m2 lines go up to whole boxes. */
function boxesOf(l: FreightLine, p: FreightProduct) {
  const per = boxM2Of(p);
  return per && p.unit === "m2" ? Math.ceil(l.qty / per - 1e-9) : Math.ceil(l.qty - 1e-9);
}

/** The order measured the way the supplier's rules read it. */
export function measure(lines: { l: FreightLine; p: FreightProduct }[]) {
  let m2 = 0;
  let lm = 0;
  let items = 0;
  let boxes = 0;
  let rolls = 0;
  let boxed = false;
  let palletShare = 0;
  const unknown: string[] = [];
  for (const { l, p } of lines) {
    const unit = p.unit;
    m2 += m2ForQty(l.qty, unit, p.widthM ?? null) ?? 0;
    lm += lmForQty(l.qty, unit, p.widthM ?? null) ?? 0;
    if (unit === "each") items += l.qty;
    if (p.soldAs === "box") {
      boxed = true;
      const n = boxesOf(l, p);
      boxes += n;
      if (p.boxesPerPallet && p.boxesPerPallet > 0) palletShare += n / p.boxesPerPallet;
      else {
        const name = [p.range, p.colour].filter(Boolean).join(" ") || "a boxed product";
        if (!unknown.includes(name)) unknown.push(name);
      }
    }
    // One cut is baled and sent as one roll. Roll goods count their rolls.
    if (ordersByRoll(p)) rolls += rollOrder(p, l.qty)?.rolls ?? 1;
    else if (p.soldAs === "broadloom") rolls += 1;
  }
  // Boxed goods go on pallets. A product with no boxes per pallet counts as 1. Broadloom on its own does not.
  const pallets = boxed ? Math.max(1, Math.ceil(palletShare - 1e-9) + (unknown.length ? 1 : 0)) : 0;
  const palletFlag = unknown.length ? `No boxes per pallet on file for ${unknown.join(", ")}. Check the pallets.` : null;
  return { m2: r2(m2), lm: r2(lm), items: r2(items), boxes, rolls, pallets, shipments: 1, palletFlag };
}

/** "Sunstar Flooring" reads "Sunstar" on the line. */
export function shortSupplierName(name: string) {
  return name.replace(/\s+(flooring|floorcoverings)$/i, "").trim() || name;
}

const UNIT_OF: Record<string, [string, string]> = {
  pallet: ["pallet", "pallets"],
  roll: ["roll", "rolls"],
  box: ["box", "boxes"],
  each: ["item", "items"],
  lm: ["lm", "lm"],
  m2: ["m²", "m²"],
  week: ["pallet week", "pallet weeks"],
};

/** The line's unit, as quote lines spell it. */
const lineUnitOf = (basis: string) =>
  basis === "pallet" ? "pallet" : basis === "roll" ? "roll" : basis === "box" ? "box" : basis === "lm" ? "lm" : basis === "m2" ? "m2" : basis === "each" ? "each" : basis === "week" ? "week" : "order";

/** "(1 pallet)", "(2.1%)", or nothing for a flat charge. */
function countText(c: ResolvedCharge) {
  if (c.basis === "percent_of_order") return ` (${c.percent ?? 0}%)`;
  const u = UNIT_OF[c.basis];
  if (!u) return "";
  return ` (${r2(c.units)} ${c.units === 1 ? u[0] : u[1]})`;
}

/**
 * Pure. What each supplier on the quote charges for its order, the charge
 * lines that should be on the quote, and the older lines whose built in
 * freight comes back out.
 */
export function planQuoteFreight(
  lines: FreightLine[],
  products: Map<number, FreightProduct>,
  suppliers: Map<number, FreightSupplier>,
  rules: FreightRule[],
  markupPct = SUPPLIER_CHARGES_MARKUP_DEFAULT,
  today = todayISO(),
): { suppliers: FreightPlanSupplier[]; charges: ChargeLineWant[]; updates: FreightLineUpdate[] } {
  const groups = new Map<number, { l: FreightLine; p: FreightProduct }[]>();
  for (const l of lines) {
    const p = l.productId != null ? products.get(l.productId) : undefined;
    if (!carries(l, p)) continue;
    if (!suppliers.has(p.supplierId)) continue;
    groups.set(p.supplierId, [...(groups.get(p.supplierId) ?? []), { l, p }]);
  }

  const out: FreightPlanSupplier[] = [];
  const charges: ChargeLineWant[] = [];
  const factor = 1 + markupPct / 100;
  for (const [supplierId, group] of groups) {
    const s = suppliers.get(supplierId)!;
    const deliverTo = s.deliversTo === "site" ? "site" : "warehouse";
    const own = rules.filter((r) => r.supplierId === supplierId && r.active !== false && feeAppliesTo(r.appliesTo, deliverTo));
    const goods = r2(group.reduce((a, { l }) => a + baseCostOf(l) * l.qty, 0));
    const m = measure(group);
    // Carrier freight is Terra's cost on a quote, so deliversDirect is not applied (see top).
    const q = resolveSupplierCharges({ name: s.name, deliversDirect: true }, own, { goodsExGst: goods, ...m }, { today });
    out.push({
      supplierId,
      name: s.name,
      deliverTo,
      goodsExGst: goods,
      chargesExGst: r2(q.chargesExGst),
      charges: q.charges.map((c) => ({ name: c.name, exGst: c.exGst, note: c.note })),
      lineIds: group.map(({ l }) => l.id),
      pallets: m.pallets,
      palletFlag: m.palletFlag,
    });
    const live = q.charges.filter((c) => Math.abs(c.exGst) >= 0.005);
    const freights = live.filter((c) => c.kind === "delivery").length;
    const short = shortSupplierName(s.name);
    for (const c of live) {
      const isFreight = c.kind === "delivery";
      const named = isFreight ? (freights > 1 ? `, ${c.name}` : "") : `, ${c.name}`;
      const description = `${isFreight ? "Supplier freight" : "Supplier charge"}: ${short}${named}${countText(c)}`;
      const perUnit = c.basis !== "percent_of_order" && c.basis !== "order" && c.basis !== "shipment" && c.units > 0;
      const qty = perUnit ? r2(c.units) : 1;
      const unitCost = r4(c.exGst / qty);
      const unitPrice = r2(unitCost * factor);
      const flagReason = c.basis === "pallet" && m.palletFlag ? m.palletFlag : null;
      charges.push({
        supplierId,
        key: `rule:${c.id}`,
        description,
        qty,
        unit: perUnit ? lineUnitOf(c.basis) : "order",
        unitCost,
        unitPrice,
        total: r2(qty * unitPrice),
        markupPercent: markupPct,
        flagged: Boolean(flagReason),
        flagReason,
      });
    }
  }

  // Older lines with freight built in: the freight comes back out at the line's own ratio.
  const updates: FreightLineUpdate[] = [];
  for (const l of lines) {
    const old = l.freightUnitCost ?? 0;
    if (!old) continue;
    const cost = l.unitCost ?? 0;
    if (cost <= 0 || l.qty <= 0) {
      updates.push({ id: l.id, unitCost: l.unitCost ?? 0, unitPrice: l.unitPrice, listUnitPrice: l.listUnitPrice });
      continue;
    }
    const nextCost = r4(baseCostOf(l));
    const ratio = nextCost / cost;
    updates.push({
      id: l.id,
      unitCost: nextCost,
      unitPrice: r2(l.unitPrice * ratio),
      listUnitPrice: l.listUnitPrice == null ? null : r2(l.listUnitPrice * ratio),
    });
  }
  return { suppliers: out, charges, updates };
}

/** Settings, Business rules: "Supplier charges markup %". 15 when unset. */
export async function supplierChargesMarkupPct(): Promise<number> {
  const [r] = await db.select().from(schema.settings).where(eq(schema.settings.key, SUPPLIER_CHARGES_MARKUP_KEY));
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : SUPPLIER_CHARGES_MARKUP_DEFAULT;
}

async function loadFor(quoteId: number) {
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
  const productIds = [...new Set(items.map((i) => i.productId).filter((x): x is number => x != null))];
  const products = productIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, productIds)) : [];
  const supplierIds = [
    ...new Set([
      ...products.map((p) => p.supplierId).filter((x): x is number => x != null),
      ...items.map((i) => i.chargeSupplierId).filter((x): x is number => x != null),
    ]),
  ];
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

const GONE_FLAG = /^No .* goods left on this quote\./;
const goneFlag = (supplier: string) => `No ${shortSupplierName(supplier)} goods left on this quote. Remove this line if it is not needed.`;

/**
 * Put the supplier charge lines right. Called from recalc, so every add,
 * edit, remove and new version goes through it. Returns how many lines moved.
 */
export async function refreshQuoteFreight(quoteId: number): Promise<number> {
  const [quote] = await db.select({ status: schema.quotes.status }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote || LOCKED.has(quote.status)) return 0;
  const { items, products, suppliers, rules } = await loadFor(quoteId);
  const pct = await supplierChargesMarkupPct();
  const plan = planQuoteFreight(items, products, suppliers, rules, pct);
  const byId = new Map(items.map((i) => [i.id, i]));
  const now = new Date();
  let moved = 0;

  for (const u of plan.updates) {
    await db
      .update(schema.quoteItems)
      .set({
        freightUnitCost: null,
        unitCost: u.unitCost,
        unitPrice: u.unitPrice,
        listUnitPrice: u.listUnitPrice,
        total: r2((byId.get(u.id)?.qty ?? 0) * u.unitPrice),
        updatedAt: now,
      })
      .where(eq(schema.quoteItems.id, u.id));
    moved += 1;
  }

  const existing = items.filter(isChargeLine);
  const have = new Map<string, (typeof existing)[number]>();
  const extra: typeof existing = [];
  for (const e of existing) {
    const k = `${e.chargeSupplierId ?? 0}|${e.chargeKey ?? ""}`;
    if (have.has(k)) extra.push(e);
    else have.set(k, e);
  }
  const goodsFrom = new Set(plan.suppliers.map((s) => s.supplierId));

  let sort: number | null = null;
  const nextSort = async () => {
    if (sort == null) {
      const [top] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quoteId));
      sort = Number(top?.max ?? -1);
    }
    sort += 1;
    return sort;
  };

  for (const w of plan.charges) {
    const k = `${w.supplierId}|${w.key}`;
    const e = have.get(k);
    have.delete(k);
    const values = {
      description: w.description,
      qty: w.qty,
      unit: w.unit,
      unitCost: w.unitCost,
      unitPrice: w.unitPrice,
      total: w.total,
      markupPercent: w.markupPercent,
      flagged: w.flagged,
      flagReason: w.flagReason,
    };
    if (e) {
      if (e.chargeTyped) {
        // Typed over: it stays. Its goods are back, so the "no goods left" flag goes.
        if (e.flagReason != null && GONE_FLAG.test(e.flagReason)) {
          await db.update(schema.quoteItems).set({ flagged: false, flagReason: null, updatedAt: now }).where(eq(schema.quoteItems.id, e.id));
          moved += 1;
        }
        continue;
      }
      const same = (Object.keys(values) as (keyof typeof values)[]).every((f) => e[f] === values[f]) && e.kind === SUPPLIER_CHARGE;
      if (same) continue;
      await db
        .update(schema.quoteItems)
        .set({ ...values, kind: SUPPLIER_CHARGE, lineType: "material", listUnitPrice: null, freightUnitCost: null, updatedAt: now })
        .where(eq(schema.quoteItems.id, e.id));
    } else {
      await db.insert(schema.quoteItems).values({
        quoteId,
        kind: SUPPLIER_CHARGE,
        lineType: "material",
        chargeSupplierId: w.supplierId,
        chargeKey: w.key,
        sortOrder: await nextSort(),
        ...values,
      });
    }
    moved += 1;
  }

  for (const e of [...have.values(), ...extra]) {
    if (e.chargeTyped) {
      // Typed over: it stays. Say so when its supplier has no goods left.
      const supplier = suppliers.get(e.chargeSupplierId ?? 0)?.name ?? "supplier";
      const want = goodsFrom.has(e.chargeSupplierId ?? 0) ? null : goneFlag(supplier);
      const ownFlag = e.flagReason != null && GONE_FLAG.test(e.flagReason);
      if (want && e.flagReason !== want && (!e.flagged || ownFlag)) {
        await db.update(schema.quoteItems).set({ flagged: true, flagReason: want, updatedAt: now }).where(eq(schema.quoteItems.id, e.id));
        moved += 1;
      } else if (!want && ownFlag) {
        await db.update(schema.quoteItems).set({ flagged: false, flagReason: null, updatedAt: now }).where(eq(schema.quoteItems.id, e.id));
        moved += 1;
      }
      continue;
    }
    await db.delete(schema.quoteItems).where(eq(schema.quoteItems.id, e.id));
    moved += 1;
  }
  return moved;
}

export type QuoteFreightView = {
  supplier: string;
  /** The supplier's charge lines, cost ex GST. */
  costExGst: number;
  /** What they add to the client price, ex GST. */
  sellExGst: number;
  /** The lines, by name. */
  charges: string;
  /** Any line typed over. */
  typed: boolean;
  /** A line to check, for example no boxes per pallet. */
  flag: string | null;
};

/** For the office: the supplier charge lines per supplier, and what the client copy spreads. Cost viewers only. */
export async function quoteFreightView(quoteId: number): Promise<QuoteFreightView[]> {
  const items = (await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId))).filter(isChargeLine);
  if (!items.length) return [];
  const ids = [...new Set(items.map((i) => i.chargeSupplierId).filter((x): x is number => x != null))];
  const names = new Map(
    ids.length ? (await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, ids))).map((s) => [s.id, s.name] as const) : [],
  );
  const by = new Map<number, typeof items>();
  for (const i of items) by.set(i.chargeSupplierId ?? 0, [...(by.get(i.chargeSupplierId ?? 0) ?? []), i]);
  return [...by.entries()].map(([id, ls]) => ({
    supplier: names.get(id) ?? "Supplier",
    costExGst: r2(ls.reduce((a, l) => a + (l.unitCost ?? 0) * l.qty, 0)),
    sellExGst: r2(ls.reduce((a, l) => a + l.total, 0)),
    charges: ls.map((l) => l.description).join(", "),
    typed: ls.some((l) => l.chargeTyped),
    flag: ls.find((l) => l.flagged && l.flagReason)?.flagReason ?? null,
  }));
}

/**
 * Lines as the client reads them (lib/charge-fold.ts), for rows straight off
 * quote_items. Loads each product's supplier.
 */
export async function foldForClient<
  T extends { id: number; kind: string; qty: number; unitPrice: number; total: number; unitCost: number | null; productId: number | null; chargeSupplierId: number | null; description: string },
>(rows: T[]) {
  if (!rows.some(isChargeLine)) return { lines: rows, shares: new Map<number, number>() };
  const ids = [...new Set(rows.map((r) => r.productId).filter((x): x is number => x != null))];
  const sup = new Map(
    ids.length ? (await db.select({ id: schema.products.id, s: schema.products.supplierId }).from(schema.products).where(inArray(schema.products.id, ids))).map((p) => [p.id, p.s] as const) : [],
  );
  const { lines, shares } = foldCharges(rows.map((r) => ({ ...r, supplierId: r.productId != null ? (sup.get(r.productId) ?? null) : null })));
  return { lines: lines.map(({ supplierId: _s, ...r }) => r as unknown as T), shares };
}
