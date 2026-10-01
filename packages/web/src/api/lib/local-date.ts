/* ---------------------------------------------------------------------------
 * Gold Coast dates. Queensland has no daylight saving, so it is always UTC+10.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, which is yesterday
 * on the Gold Coast until 10 am. Anything that asks "what is today" for the
 * crew goes through here instead.
 * ------------------------------------------------------------------------- */

export const TERRA_TZ = "Australia/Brisbane";
const OFFSET_MS = 10 * 3600_000;

/** YYYY-MM-DD on the Gold Coast for this instant. */
export function localDate(d: Date = new Date()): string {
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Today, Gold Coast time. */
export const todayLocal = () => localDate(new Date());

/** YYYY-MM-DD plus n days. Pure calendar arithmetic, no time zone involved. */
export function addLocalDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The first and last instant of a Gold Coast calendar day. */
export function localDayBounds(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+10:00`);
  return { start, end: new Date(start.getTime() + 86400_000) };
}

/** "07:30" on a Gold Coast date, as a real instant. Null for a bad time. */
export function localTimeOn(date: string, hhmm: string | null | undefined): Date | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${date}T${m[1]!.padStart(2, "0")}:${m[2]}:00+10:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "7:30 am", the way Siri should say it. */
export function sayTime(hhmm: string | null | undefined): string | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mins = m[2]!;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mins === "00" ? `${h12} ${suffix}` : `${h12}:${mins} ${suffix}`;
}

/** "today", "tomorrow", or "Friday the 9th". */
export function sayDay(date: string, today: string = todayLocal()): string {
  if (date === today) return "today";
  if (date === addLocalDays(today, 1)) return "tomorrow";
  const d = new Date(`${date}T12:00:00+10:00`);
  const weekday = d.toLocaleDateString("en-AU", { timeZone: TERRA_TZ, weekday: "long" });
  const n = Number(date.slice(8, 10));
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${weekday} the ${n}${suffix}`;
}

/** "1 hour 20 minutes". */
export function sayMinutes(total: number): string {
  const mins = Math.max(0, Math.round(total));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m || !h) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
  return parts.join(" ");
}
