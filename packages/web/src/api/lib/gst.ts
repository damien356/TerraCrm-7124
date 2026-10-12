/**
 * GST in one place.
 *
 * Job value (`jobs.value`) is stored INC GST: it is the accepted quote total,
 * plus accepted variations, and the ServiceM8 history came across the same
 * way. Costs (`job_costs.amount`) are entered EX GST.
 *
 * So:
 *   - gross profit and margin compare ex GST with ex GST: `exGst(value) - costs`
 *   - cash compares inc GST with inc GST: money in is the value as billed,
 *     money out is the cost plus the GST the supplier or installer charges.
 */
export const GST_RATE = 0.1;
export const GST_FACTOR = 1 + GST_RATE;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** An inc GST figure taken back to ex GST. */
export const exGst = (inc: number | null | undefined) => r2((inc ?? 0) / GST_FACTOR);

/** An ex GST figure with GST on top. */
export const incGst = (ex: number | null | undefined) => r2((ex ?? 0) * GST_FACTOR);

/**
 * What a cost takes out of the bank, inc GST. Suppliers and other costs always
 * charge GST. An installer only does when they are GST registered.
 */
export function costCashOut(amount: number | null | undefined, kind: string | null | undefined, installerGstRegistered: boolean | null | undefined) {
  if (kind === "installer" && !installerGstRegistered) return r2(amount ?? 0);
  return incGst(amount);
}

/** True when a cost carries GST on the bill. */
export const costHasGst = (kind: string | null | undefined, installerGstRegistered: boolean | null | undefined) =>
  !(kind === "installer" && !installerGstRegistered);
