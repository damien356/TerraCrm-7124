/* ---------------------------------------------------------------------------
 * Notes 18.47. The referral fee on the client's copy and on Office's view.
 *
 * The fee is never a quote line. It is spread over every line in step with
 * each line's price, to the cent, so the lines still add up to the quote
 * total and nobody but an Admin can see a fee was added. The rounding left
 * over goes to the lines with the biggest remainders, the same as the
 * supplier charge fold (lib/charge-fold.ts). Run it after that fold.
 *
 * No server imports.
 * ------------------------------------------------------------------------- */

export type FeeFoldLine = { id: number; qty: number; unitPrice: number; total: number };

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;

/** The lines with the fee in them. `shares` is how much fee (ex GST, dollars) went into each line. */
export function foldFee<T extends FeeFoldLine>(lines: T[], fee: number): { lines: T[]; shares: Map<number, number> } {
  const shares = new Map<number, number>();
  const cents = Math.round((fee || 0) * 100);
  if (cents <= 0 || !lines.length) return { lines, shares };
  let receivers = lines.filter((l) => l.total > 0);
  if (!receivers.length) receivers = [lines[0]!];
  const weights = receivers.map((l) => Math.max(0, l.total));
  const sum = weights.reduce((a, w) => a + w, 0);
  const raw = sum > 0 ? weights.map((w) => (cents * w) / sum) : receivers.map(() => cents / receivers.length);
  const base = raw.map((x) => Math.floor(x));
  let left = cents - base.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k]!.i]! += 1;
  receivers.forEach((l, i) => shares.set(l.id, base[i]! / 100));
  return {
    lines: lines.map((l) => {
      const s = shares.get(l.id);
      if (!s) return l;
      const total = r2(l.total + s);
      return { ...l, total, unitPrice: l.qty ? r4(total / l.qty) : l.unitPrice };
    }),
    shares,
  };
}

/**
 * A price typed by someone who sees the fee spread in, taken back to Terra's
 * own price. A % fee comes off in proportion. A fixed fee takes this line's
 * share back out.
 */
export function priceWithoutFee(typed: number, qty: number, fee: { feeType: string; feeValue: number; amount: number } | null, share: number) {
  if (!fee || !(fee.amount > 0)) return typed;
  if (fee.feeType === "percent" && fee.feeValue > 0) return r2(typed / (1 + fee.feeValue / 100));
  return qty > 0 ? r2(typed - share / qty) : typed;
}
