import { round2, sellExGst } from "./pricing";

/**
 * Pure maths for the bulk price tools. No database in here, so the preview and
 * the apply step run the exact same code and cannot disagree.
 */

export type Rounding = "none" | "5c" | "10c" | "dollar";

export function roundTo(n: number, rounding: Rounding) {
  if (rounding === "5c") return round2(Math.round(n * 20) / 20);
  if (rounding === "10c") return round2(Math.round(n * 10) / 10);
  if (rounding === "dollar") return Math.round(n);
  return round2(n);
}

export type PriceEditMode = "percent" | "add" | "set";

/** New standard cost, or null when the input makes no sense (negative result). */
export function editedCost(old: number, mode: PriceEditMode, amount: number, rounding: Rounding) {
  const raw = mode === "percent" ? old * (1 + amount / 100) : mode === "add" ? old + amount : amount;
  const next = roundTo(raw, rounding);
  return next < 0 ? null : next;
}

export type SpecialMode = "percent_off" | "dollar_off" | "set_cost";

/** Special cost from the standard cost. */
export function specialCost(standard: number, mode: SpecialMode, amount: number, rounding: Rounding) {
  const raw = mode === "percent_off" ? standard * (1 - amount / 100) : mode === "dollar_off" ? standard - amount : amount;
  return roundTo(raw, rounding);
}

export { sellExGst };
