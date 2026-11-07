/* ---------------------------------------------------------------------------
 * Booking times, pure (no database), so the server and the web share one rule.
 *
 * Standard working hours (Damien's brief, 7 Nov 2026): 6:00 am to 6:00 pm
 * Brisbane. A booking that starts before 6:00 am or finishes after 6:00 pm is
 * still allowed, but only after someone confirms it, and who confirmed it is
 * recorded on the job. A confirm never waves through a real clash.
 *
 * Same-day bookings for one person: two bookings on one day only clash when
 * their times overlap, travel buffers counted. A day with no time set can't be
 * ruled out, so it still shows as a possible clash.
 *
 * All times are Brisbane wall clock, HH:MM. Brisbane has no daylight saving.
 * ------------------------------------------------------------------------- */

export const WORK_START = "06:00";
export const WORK_END = "18:00";
const START_MIN = 6 * 60;
const END_MIN = 18 * 60;

/** Minutes after midnight for "HH:MM", or null when it isn't a time. */
export function hmToMin(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h > 23 || mm > 59 ? null : h * 60 + mm;
}

/** "HH:MM" for minutes after midnight. 1440 and over reads as the next day's clock. */
export function minToHm(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "6:00 am", the way the confirm says it. */
export function sayClock(hhmm: string | null | undefined): string {
  const m = hmToMin(hhmm);
  if (m == null) return hhmm ?? "";
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * A day's booked span in minutes. The finish is the later of the given finish
 * time and start plus hours, the same rule the calendar check uses. Null when
 * there is no start time (the day can't be placed in time).
 */
export function dayWindow(
  arrivalStart: string | null | undefined,
  arrivalEnd: string | null | undefined,
  durationHours: number | null | undefined,
): { from: number; to: number } | null {
  const s = hmToMin(arrivalStart);
  if (s == null) return null;
  const hours = Number(durationHours ?? 0);
  const byHours = hours > 0 && hours <= 16 ? s + Math.round(hours * 60) : null;
  const e = hmToMin(arrivalEnd);
  const byEnd = e != null && e > s ? e : null;
  const to = Math.max(byHours ?? 0, byEnd ?? 0);
  return { from: s, to: to > s ? to : s + 1 };
}

export type Overlap = "clash" | "maybe" | "clear";

/**
 * Two bookings on the same day for the same person. Buffers are the person's
 * travel time either side (calendar link), zero when none is set.
 */
export function sameDayOverlap(
  a: { from: number; to: number } | null,
  b: { from: number; to: number } | null,
  bufferBeforeMin = 0,
  bufferAfterMin = 0,
): Overlap {
  if (!a || !b) return "maybe";
  const bFrom = b.from - bufferBeforeMin;
  const bTo = b.to + bufferAfterMin;
  return a.from < bTo && bFrom < a.to ? "clash" : "clear";
}

/**
 * The start and finish the office picked: the finish time when one is given
 * (an arrival window or an exact finish), else start plus the hours.
 */
export function selectedSpan(
  arrivalStart: string | null | undefined,
  arrivalEnd: string | null | undefined,
  durationHours: number | null | undefined,
): { from: number; to: number } | null {
  const s = hmToMin(arrivalStart);
  if (s == null) return null;
  const e = hmToMin(arrivalEnd);
  if (e != null && e > s) return { from: s, to: e };
  const hours = Number(durationHours ?? 0);
  return { from: s, to: hours > 0 && hours <= 24 ? s + Math.round(hours * 60) : s };
}

/** True when a booked span starts before 6:00 am or finishes after 6:00 pm. */
export function outsideWorkHours(win: { from: number; to: number } | null): boolean {
  if (!win) return false;
  return win.from < START_MIN || win.to > END_MIN;
}

export type HoursDay = { date: string; arrivalStart: string | null | undefined; arrivalEnd?: string | null; coordinate?: boolean | null };

/** The days of a booking that fall outside standard hours, with their span. */
export function outsideDays(days: HoursDay[], durationHours: number | null | undefined) {
  const out: { date: string; from: string; to: string }[] = [];
  for (const d of days) {
    if (d.coordinate) continue;
    const win = selectedSpan(d.arrivalStart, d.arrivalEnd ?? null, durationHours);
    if (outsideWorkHours(win)) out.push({ date: d.date, from: minToHm(win!.from), to: minToHm(win!.to) });
  }
  return out;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Thu 12 Nov 2026" from YYYY-MM-DD, with no time zone in play. */
export function sayDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const wd = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return `${DAYS[wd]} ${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

/** The confirm wording from the brief, with the selected date and times filled in. */
export function outsideHoursMessage(days: { date: string; from: string; to: string }[]): string {
  const said = days.map((d) => `${sayDay(d.date)}, ${sayClock(d.from)} to ${sayClock(d.to)}`).join("; ");
  return `This booking is outside standard working hours (6:00 am-6:00 pm). You selected ${said}. Are you sure you want to continue?`;
}

/** Marker the server puts on the error so the web can open the confirm. */
export const OUTSIDE_HOURS = "outside_hours";
