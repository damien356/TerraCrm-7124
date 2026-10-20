import { autoSoldAs, boxM2Of } from "./flooring-qty";
import { isChargeLive, round2, todayISO, type SupplierChargeRule } from "./pricing";

/* ---------------------------------------------------------------------------
 * Trade sales pricing (notes 18.65). Pure functions, no database.
 *
 *  RATE      Product rate ex GST per selling unit =
 *              standard cost ex GST (products.cost_price, never a special)
 *              x the explicit cost to selling unit conversion
 *              x (1 + trade markup), rounded to cents.
 *            A fixed trade price override (trade_product_rules.price_override)
 *            is the FINAL material rate ex GST per selling unit. No markup is
 *            added to it (decision E).
 *  FEES      Supplier fees are never inside the rate. Only automatic per unit
 *            fees apply (per m2, lm, box, roll, each, and % of goods fuel),
 *            pro rata to the qty sold on the fee's own basis. Per order,
 *            shipment, pallet and storage fees, and any delivery kind fee, are
 *            never added: delivery is a line Admin types (decision A). One rule
 *            gives at most one fee line per product line, so a fee can never be
 *            charged twice. Each fee line stores its cost, the trade markup and
 *            the charge, and the markup is applied once to the fee cost
 *            (decision D). An override marked "fees included" adds no fees.
 *  GST       10% only on products Admin has confirmed. Rate and amount stored
 *            per line. Anything unconfirmed cannot be finalised.
 *  UNITS     Boxed floors sell in whole boxes (m2 per box shown). Broadloom and
 *            sheet vinyl sell in lm, decimals allowed (roll width shown).
 *            Everything else sells in its own unit with a label. A missing
 *            conversion blocks the line, nothing is guessed.
 * ------------------------------------------------------------------------- */

export type TradeProduct = {
  id: number;
  supplierId: number | null;
  supplier: string;
  brand: string;
  range: string;
  colour: string;
  size: string;
  category: string;
  unit: string;
  soldAs: string | null;
  widthM: number | null;
  unitsPerPack: number | null;
  unitM2: number | null;
  packM2Printed: number | null;
  rollM2: number | null;
  costPrice: number | null;
  active: boolean;
};

export type TradeRule = {
  mode: string;
  priceOverride: number | null;
  gstConfirmed: boolean;
  unitLabel: string;
  feesIncluded: boolean;
};

export type TradeUnits =
  | {
      ok: true;
      /** box · lm · m2 · each · roll */
      sellUnit: string;
      unitLabel: string;
      /** Whole numbers only (boxes, each, rolls). */
      whole: boolean;
      /** How many cost units (products.unit) are in one selling unit. */
      costPerSell: number;
      /** How many stock units are in one selling unit. Stock is kept in products.unit. */
      stockPerSell: number;
      stockUnit: string;
      m2PerBox: number | null;
      rollWidthM: number | null;
      /** m2 and lm in one selling unit, for fees on those bases. Null = not known. */
      m2PerSell: number | null;
      lmPerSell: number | null;
      /** Rolls in one selling unit, for per roll fees. Null = no roll length on file. */
      rollsPerSell: number | null;
    }
  | { ok: false; reason: string };

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const pos = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export const productName = (p: { brand: string; range: string; colour?: string }) =>
  [p.brand, p.range].map((s) => (s ?? "").trim()).filter(Boolean).join(" ") || "Product";

/** Colour or size, e.g. "Grey" or "20kg bag". */
export const productDetail = (p: { colour: string; size: string }) =>
  [p.colour, p.size].map((s) => (s ?? "").trim()).filter(Boolean).join(", ");

const UNIT_WORD: Record<string, string> = { box: "box", lm: "lm", m2: "m2", each: "each", roll: "roll" };

/** The selling unit and every conversion, or why there is none. */
export function unitsFor(p: TradeProduct, rule: Pick<TradeRule, "unitLabel"> | null): TradeUnits {
  const unit = p.unit;
  const label = (rule?.unitLabel ?? "").trim();
  const tag = p.soldAs === "box" || p.soldAs === "broadloom" ? p.soldAs : autoSoldAs(p);
  const roll = (lmPerSell: number | null) => {
    if (unit === "roll") return 1;
    if (!pos(p.rollM2) || lmPerSell == null) return null;
    if (unit !== "lm" && !pos(p.widthM)) return null;
    const rollLm = unit === "lm" ? p.rollM2 : p.rollM2 / p.widthM!;
    return pos(rollLm) ? lmPerSell / rollLm : null;
  };

  if (tag === "box") {
    if (unit !== "m2") return { ok: false, reason: `Boxed floor priced per ${unit}, not per m2. Fix the price book unit first.` };
    const box = boxM2Of(p);
    if (!pos(box)) return { ok: false, reason: "No m2 per box in the price book, so a box cannot be priced. Add the box size first." };
    return {
      ok: true,
      sellUnit: "box",
      unitLabel: label || `box (${r4(box)} m2)`,
      whole: true,
      costPerSell: box,
      stockPerSell: box,
      stockUnit: "m2",
      m2PerBox: box,
      rollWidthM: null,
      m2PerSell: box,
      lmPerSell: null,
      rollsPerSell: null,
    };
  }
  if (tag === "broadloom") {
    if (unit === "lm") {
      return {
        ok: true,
        sellUnit: "lm",
        unitLabel: label || (pos(p.widthM) ? `lm (${r4(p.widthM)} m roll width)` : "lm"),
        whole: false,
        costPerSell: 1,
        stockPerSell: 1,
        stockUnit: "lm",
        m2PerBox: null,
        rollWidthM: pos(p.widthM) ? p.widthM : null,
        m2PerSell: pos(p.widthM) ? p.widthM : null,
        lmPerSell: 1,
        rollsPerSell: roll(1),
      };
    }
    if (unit === "m2") {
      if (!pos(p.widthM)) return { ok: false, reason: "Sold by the lm but there is no roll width in the price book. Add the width first." };
      return {
        ok: true,
        sellUnit: "lm",
        unitLabel: label || `lm (${r4(p.widthM)} m roll width)`,
        whole: false,
        costPerSell: p.widthM,
        stockPerSell: p.widthM,
        stockUnit: "m2",
        m2PerBox: null,
        rollWidthM: p.widthM,
        m2PerSell: p.widthM,
        lmPerSell: 1,
        rollsPerSell: roll(1),
      };
    }
    return { ok: false, reason: `Roll goods priced per ${unit}. There is no defined conversion to lm.` };
  }
  if (!UNIT_WORD[unit]) return { ok: false, reason: `Unknown unit "${unit}" in the price book.` };
  const size = (p.size ?? "").trim();
  return {
    ok: true,
    sellUnit: unit,
    unitLabel: label || size || UNIT_WORD[unit]!,
    whole: unit === "each" || unit === "roll",
    costPerSell: 1,
    stockPerSell: 1,
    stockUnit: unit,
    m2PerBox: null,
    rollWidthM: pos(p.widthM) ? p.widthM : null,
    m2PerSell: unit === "m2" ? 1 : unit === "lm" && pos(p.widthM) ? p.widthM : null,
    lmPerSell: unit === "lm" ? 1 : null,
    rollsPerSell: unit === "roll" ? 1 : null,
  };
}

/** On the trade list? Product exclusion always wins, then product, category or supplier tick. */
export function onTradeList(p: Pick<TradeProduct, "category" | "supplierId" | "active">, rule: Pick<TradeRule, "mode"> | null, settings: { categories: string[]; supplierIds: number[] }) {
  if (!p.active) return false;
  if (rule?.mode === "exclude") return false;
  if (rule?.mode === "include") return true;
  return settings.categories.includes(p.category) || (p.supplierId != null && settings.supplierIds.includes(p.supplierId));
}

/** On the list AND the buyer may buy the category. */
export function buyerMayBuy(p: Pick<TradeProduct, "category" | "supplierId" | "active">, rule: Pick<TradeRule, "mode"> | null, settings: { categories: string[]; supplierIds: number[] }, buyerCategories: string[]) {
  return onTradeList(p, rule, settings) && buyerCategories.includes(p.category);
}

export type FeeLine = {
  ruleId: number;
  name: string;
  kind: string;
  basis: string;
  /** Units of the basis on this line (12 m2, 0.4 rolls). Null for a percentage. */
  units: number | null;
  /** Supplier cost of the fee for this line, ex GST. */
  costExGst: number;
  markupPct: number;
  /** What the buyer pays, ex GST: the cost with the trade markup once. */
  chargeExGst: number;
  note: string;
};

export type FeeResult = { ok: true; fees: FeeLine[]; skipped: Array<{ ruleId: number; name: string; reason: string }> } | { ok: false; reason: string };

/** Fees on a per unit basis. Everything else is a supplier inbound cost, never added (decision A). */
export const TRADE_FEE_BASES = ["m2", "lm", "box", "roll", "each", "percent_of_order"] as const;

export function feesFor(
  p: TradeProduct,
  units: Extract<TradeUnits, { ok: true }>,
  qty: number,
  rules: Array<SupplierChargeRule & { appliesTo?: string }>,
  markupPct: number,
  opts: { feesIncluded: boolean; today?: string },
): FeeResult {
  const skipped: Array<{ ruleId: number; name: string; reason: string }> = [];
  if (opts.feesIncluded) return { ok: true, fees: [], skipped };
  const today = opts.today ?? todayISO();
  const goodsCost = (p.costPrice ?? 0) * units.costPerSell * qty;
  const per: Record<string, number | null> = {
    m2: units.m2PerSell != null ? units.m2PerSell * qty : null,
    lm: units.lmPerSell != null ? units.lmPerSell * qty : null,
    box: units.sellUnit === "box" ? qty : null,
    roll: units.rollsPerSell != null ? units.rollsPerSell * qty : null,
    each: units.sellUnit === "each" ? qty : null,
  };
  const fees: FeeLine[] = [];
  const later: Array<SupplierChargeRule> = [];
  for (const r of rules) {
    if (!r.autoApply || r.active === false) continue;
    if (!isChargeLive(r, today)) continue;
    if (r.appliesTo === "site") {
      skipped.push({ ruleId: r.id, name: r.name, reason: "Site deliveries only, not warehouse stock." });
      continue;
    }
    if (r.kind === "delivery") {
      skipped.push({ ruleId: r.id, name: r.name, reason: "Delivery is added by hand on a trade sale." });
      continue;
    }
    if (!(TRADE_FEE_BASES as readonly string[]).includes(r.basis)) {
      skipped.push({ ruleId: r.id, name: r.name, reason: `Charged per ${r.basis} on Terra's own order, not per unit sold.` });
      continue;
    }
    if (r.basis === "percent_of_order" && r.percentBase === "goods_and_charges") {
      later.push(r);
      continue;
    }
    const fee = oneFee(r, per, goodsCost, markupPct);
    if (!fee.ok) return { ok: false, reason: fee.reason };
    fees.push(fee.fee);
  }
  // A percentage on goods plus charges reads off the other fee costs too, never off itself.
  for (const r of later) {
    const base = goodsCost + fees.reduce((s, f) => s + f.costExGst, 0);
    const fee = oneFee(r, per, base, markupPct);
    if (!fee.ok) return { ok: false, reason: fee.reason };
    fees.push(fee.fee);
  }
  return { ok: true, fees, skipped };
}

function oneFee(r: SupplierChargeRule, per: Record<string, number | null>, goodsCost: number, markupPct: number): { ok: true; fee: FeeLine } | { ok: false; reason: string } {
  const isPercent = r.basis === "percent_of_order";
  let units: number | null = null;
  let cost: number;
  let note: string;
  if (isPercent) {
    cost = (goodsCost * (r.percent ?? 0)) / 100;
    note = `${r.percent}% of goods`;
  } else {
    units = per[r.basis] ?? null;
    if (units == null) {
      return {
        ok: false,
        reason: `${r.name} is charged per ${r.basis} and this product has no ${r.basis === "roll" ? "roll length" : r.basis} conversion on file. Add it, or set a trade price with fees included.`,
      };
    }
    // Pro rata to the qty sold. A per block fee ($35 per 40 lm) is $35/40 per lm.
    const block = r.unitBlock && r.unitBlock > 0 ? r.unitBlock : 1;
    const rate = (r.amount ?? 0) / block;
    cost = rate * units;
    note = block === 1 ? `$${(r.amount ?? 0).toFixed(2)} per ${r.basis} x ${r4(units)} ${r.basis}` : `$${(r.amount ?? 0).toFixed(2)} per ${block} ${r.basis}, pro rata on ${r4(units)} ${r.basis}`;
  }
  if (r.amountIncludesGst && !isPercent) cost = cost / 1.1;
  const sign = r.isCredit ? -1 : 1;
  const costExGst = round2(cost) * sign;
  const chargeExGst = round2(round2(cost) * (1 + markupPct / 100)) * sign;
  return { ok: true, fee: { ruleId: r.id, name: r.name, kind: r.kind, basis: r.basis, units: units == null ? null : r4(units), costExGst, markupPct, chargeExGst, note } };
}

export type RateResult =
  | { ok: true; source: "calculated" | "override"; costPerSellExGst: number | null; rateExGst: number; markupPct: number | null }
  | { ok: false; reason: string };

/** The material rate ex GST per selling unit. */
export function rateFor(p: TradeProduct, units: Extract<TradeUnits, { ok: true }>, rule: Pick<TradeRule, "priceOverride"> | null, markupPct: number): RateResult {
  const costPerSell = pos(p.costPrice) ? r4(p.costPrice * units.costPerSell) : null;
  if (rule?.priceOverride != null && rule.priceOverride > 0) {
    return { ok: true, source: "override", costPerSellExGst: costPerSell, rateExGst: round2(rule.priceOverride), markupPct: null };
  }
  if (costPerSell == null) return { ok: false, reason: "No standard cost in the price book. Add the cost, or set a fixed trade price." };
  return { ok: true, source: "calculated", costPerSellExGst: costPerSell, rateExGst: round2(costPerSell * (1 + markupPct / 100)), markupPct };
}

/** GST on one line: 10% on confirmed products, worked per line and rounded to cents. */
export function gstOn(lineExGst: number, rate: number) {
  return round2((lineExGst * rate) / 100);
}

export function lineTotals(qty: number, unitPrice: number, discountPct: number, gstRate: number) {
  const ex = round2(qty * unitPrice * (1 - (discountPct || 0) / 100));
  const gst = gstOn(ex, gstRate);
  return { lineExGst: ex, gstAmount: gst, lineIncGst: round2(ex + gst) };
}

/** S188000, S188000-1 (the invoice), S188000-2 (first credit note). */
export const saleRef = (n: number) => (n > 0 ? `S${n}` : "Draft");
export const invoiceRef = (n: number) => (n > 0 ? `S${n}-1` : "Draft");
export const creditRef = (n: number, seq: number) => `S${n}-${seq}`;
