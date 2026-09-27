/**
 * Money and date formatting, shared by the finance and intelligence screens so
 * the same figure reads the same way everywhere.
 */

export const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export const moneyExact = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

/** Compact form for chart axes: $48.6k, $1.2m. */
export const moneyShort = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
};

export const pct = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)}%`);

/** "17 Nov". The format Damien reads dates in. */
export const shortDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};

/** "17 Nov 2026", where the year matters. */
export const longDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

export const daysBetween = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86_400_000,
  );

/**
 * For dates in the past that could be years back. "17 Nov" when it is this
 * year, "17 Nov 2024" when it is not, so an old last job never reads as recent.
 */
export const histDate = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.getFullYear() === new Date().getFullYear() ? shortDate(iso) : longDate(iso);
};
