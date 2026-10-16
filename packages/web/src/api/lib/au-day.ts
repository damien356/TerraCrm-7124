/**
 * Damien, 16 Oct (notes 18.52): every date a person reads is DD/MM/YYYY.
 * "2026-10-16" (or a full ISO time) becomes "16/10/2026". Anything that is not
 * an ISO date passes through as it came, so it is safe on text already formatted.
 */
export function auDay(s: string | null | undefined): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}
