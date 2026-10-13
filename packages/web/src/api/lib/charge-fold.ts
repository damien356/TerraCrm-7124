/* ---------------------------------------------------------------------------
 * Notes 18.33. The client copy of a quote never shows a supplier charge line.
 *
 * Each charge line's sell is spread into that supplier's own product lines
 * (supply and accessory), in step with each line's cost, so the lines the
 * client reads still add up to the quote total. Shared to the cent: the
 * rounding left over goes to the lines with the biggest remainders.
 *
 * A charge with none of its supplier's lines left on the quote (typed over,
 * then the goods removed) shows as one "Freight" delivery line instead, so
 * the money is never lost.
 *
 * Used by the client PDF, page and email (routes/quoteBundles.ts) and by the
 * office quote view for staff who cannot see costs. No server imports.
 * ------------------------------------------------------------------------- */

import { DELIVERY, SUPPLIER_CHARGE } from "./line-kinds";

export type FoldLine = {
  id: number;
  kind: string;
  qty: number;
  unitPrice: number;
  total: number;
  unitCost: number | null;
  /** The product's supplier, on a product line. */
  supplierId: number | null;
  /** Set on a supplier charge line. */
  chargeSupplierId: number | null;
  description: string;
};

/** Settings, Business rules. What supplier charge lines sell at over cost. */
export const SUPPLIER_CHARGES_MARKUP_KEY = "supplier_charges_markup_pct";
export const SUPPLIER_CHARGES_MARKUP_DEFAULT = 15;

const GOODS = new Set(["supply", "accessory"]);

export const isChargeLine = (l: { kind: string; chargeSupplierId?: number | null }) =>
  l.kind === SUPPLIER_CHARGE || l.chargeSupplierId != null;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/**
 * The lines as the client reads them. `shares` is how much charge sell (ex
 * GST, dollars) went into each product line.
 */
export function foldCharges<T extends FoldLine>(lines: T[]): { lines: T[]; shares: Map<number, number> } {
  const charges = lines.filter(isChargeLine);
  const shares = new Map<number, number>();
  if (!charges.length) return { lines, shares };

  const bySupplier = new Map<number, T[]>();
  const orphans: T[] = [];
  for (const c of charges) {
    if (c.chargeSupplierId == null) {
      orphans.push(c);
      continue;
    }
    bySupplier.set(c.chargeSupplierId, [...(bySupplier.get(c.chargeSupplierId) ?? []), c]);
  }

  for (const [supplierId, group] of bySupplier) {
    const cents = Math.round(group.reduce((a, c) => a + c.total, 0) * 100);
    const receivers = lines.filter((l) => !isChargeLine(l) && GOODS.has(l.kind) && l.supplierId === supplierId && l.qty > 0);
    if (!receivers.length) {
      orphans.push(...group);
      continue;
    }
    if (cents === 0) continue;
    let weights = receivers.map((l) => Math.max(0, (l.unitCost ?? 0) * l.qty));
    if (!weights.some((w) => w > 0)) weights = receivers.map((l) => Math.max(0, l.total));
    if (!weights.some((w) => w > 0)) weights = receivers.map(() => 1);
    const sum = weights.reduce((a, w) => a + w, 0);
    const raw = weights.map((w) => (cents * w) / sum);
    const base = raw.map((x) => Math.floor(x));
    let left = cents - base.reduce((a, x) => a + x, 0);
    const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k]!.i]! += 1;
    receivers.forEach((l, i) => shares.set(l.id, (shares.get(l.id) ?? 0) + base[i]! / 100));
  }

  const orphanIds = new Set(orphans.map((o) => o.id));
  const out: T[] = [];
  for (const l of lines) {
    if (isChargeLine(l)) {
      if (orphanIds.has(l.id)) out.push({ ...l, kind: DELIVERY, description: "Freight", chargeSupplierId: null });
      continue;
    }
    const s = shares.get(l.id);
    if (!s) {
      out.push(l);
      continue;
    }
    const total = r2(l.total + s);
    out.push({ ...l, total, unitPrice: l.qty ? r4(total / l.qty) : l.unitPrice });
  }
  return { lines: out, shares };
}
