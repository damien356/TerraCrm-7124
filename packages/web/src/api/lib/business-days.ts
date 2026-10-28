import { addLocalDays, weekdayOf } from "./local-date";

/* ---------------------------------------------------------------------------
 * Business days for anything that writes to a customer on a schedule.
 *
 * Queensland public holidays, from qld.gov.au (fetched 28 Oct 2026). Only
 * 2026 to 2028 are listed: past the end of the list every weekday counts as a
 * business day, so add the next year before then (the check script warns).
 *
 * Show days are only a holiday in their own area. Terra is on the Gold Coast,
 * so by default the Gold Coast show day counts and the Brisbane one does not.
 * Settings can change that (quote_followup_show_days).
 *
 * The Christmas shutdown (24 Dec to 2 Jan) is Terra's own rule for automatic
 * emails, not a public holiday: nobody is in to answer the replies.
 * ------------------------------------------------------------------------- */

export const QLD_HOLIDAYS: Record<string, string> = {
  "2026-01-01": "New Year's Day",
  "2026-01-26": "Australia Day",
  "2026-04-03": "Good Friday",
  "2026-04-04": "Easter Saturday",
  "2026-04-06": "Easter Monday",
  "2026-04-25": "Anzac Day",
  "2026-05-04": "Labour Day",
  "2026-10-05": "King's Birthday",
  "2026-12-25": "Christmas Day",
  "2026-12-26": "Boxing Day",
  "2026-12-28": "Boxing Day holiday",
  "2027-01-01": "New Year's Day",
  "2027-01-26": "Australia Day",
  "2027-03-26": "Good Friday",
  "2027-03-27": "Easter Saturday",
  "2027-03-29": "Easter Monday",
  "2027-04-26": "Anzac Day holiday",
  "2027-05-03": "Labour Day",
  "2027-10-04": "King's Birthday",
  "2027-12-25": "Christmas Day",
  "2027-12-26": "Boxing Day",
  "2027-12-27": "Christmas Day holiday",
  "2027-12-28": "Boxing Day holiday",
  "2028-01-01": "New Year's Day",
  "2028-01-03": "New Year's Day holiday",
  "2028-01-26": "Australia Day",
  "2028-04-14": "Good Friday",
  "2028-04-15": "Easter Saturday",
  "2028-04-17": "Easter Monday",
  "2028-04-25": "Anzac Day",
  "2028-05-01": "Labour Day",
  "2028-10-02": "King's Birthday",
  "2028-12-25": "Christmas Day",
  "2028-12-26": "Boxing Day",
};

export const SHOW_DAYS = {
  brisbane: { "2026-08-12": "Brisbane show day", "2027-08-11": "Brisbane show day" } as Record<string, string>,
  gold_coast: { "2026-08-28": "Gold Coast show day", "2027-08-27": "Gold Coast show day" } as Record<string, string>,
};
export type ShowDays = "none" | "gold_coast" | "brisbane" | "both";

/** The last day the holiday list covers. */
export const HOLIDAYS_KNOWN_UNTIL = "2028-12-31";

export function isShutdown(date: string) {
  const md = date.slice(5);
  return md >= "12-24" || md <= "01-02";
}

/** Why this day is not a business day, or null when it is one. */
export function notBusinessDay(date: string, showDays: ShowDays = "gold_coast"): string | null {
  const wd = weekdayOf(date);
  if (wd === 0) return "Sunday";
  if (wd === 6) return "Saturday";
  if (QLD_HOLIDAYS[date]) return QLD_HOLIDAYS[date]!;
  if ((showDays === "gold_coast" || showDays === "both") && SHOW_DAYS.gold_coast[date]) return SHOW_DAYS.gold_coast[date]!;
  if ((showDays === "brisbane" || showDays === "both") && SHOW_DAYS.brisbane[date]) return SHOW_DAYS.brisbane[date]!;
  if (isShutdown(date)) return "Christmas shutdown";
  return null;
}

/** This day if it is a business day, otherwise the next one. */
export function onOrAfterBusinessDay(date: string, showDays: ShowDays = "gold_coast") {
  let d = date;
  for (let i = 0; i < 30 && notBusinessDay(d, showDays); i++) d = addLocalDays(d, 1);
  return d;
}

/* ------------------------------ time zones -------------------------------- */

/** Australian time zone from a postcode. Anything unknown is Brisbane. */
export function timeZoneForPostcode(postcode: string | null | undefined): string {
  const p = Number(String(postcode ?? "").trim());
  if (!Number.isInteger(p) || p < 800 || p > 9999) return "Australia/Brisbane";
  if (p >= 800 && p < 1000) return "Australia/Darwin";
  if (p === 2880) return "Australia/Broken_Hill";
  if (p >= 1000 && p < 3000) return "Australia/Sydney";
  if (p >= 3000 && p < 4000) return "Australia/Melbourne";
  if (p >= 4000 && p < 5000) return "Australia/Brisbane";
  if (p >= 5000 && p < 6000) return "Australia/Adelaide";
  if (p >= 6000 && p < 7000) return "Australia/Perth";
  if (p >= 7000 && p < 8000) return "Australia/Hobart";
  if (p >= 9000) return "Australia/Brisbane";
  return "Australia/Brisbane";
}

/** Minutes the zone is ahead of UTC at this instant (daylight saving included). */
function offsetMinutes(tz: string, at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "10:00" on a calendar date in a time zone, as a real instant. */
export function zonedTimeOn(date: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h ?? 10, m ?? 0);
  let t = guess - offsetMinutes(tz, new Date(guess)) * 60_000;
  /* Once more, for the day the clocks change. */
  t = guess - offsetMinutes(tz, new Date(t)) * 60_000;
  return new Date(t);
}

/** YYYY-MM-DD in a time zone for this instant. */
export function dateIn(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Hour 0 to 23 in a time zone for this instant. */
export function hourIn(tz: string, at: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit" }).format(at)) % 24;
}
