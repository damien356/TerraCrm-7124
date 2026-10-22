/**
 * HOURLY PAY AND VEHICLE ALLOWANCE MATHS. Pure functions, no database, so
 * every number the office signs off can be checked by a test.
 *
 * Bands: standard, weekend (Saturday and Sunday daytime) and night (after
 * hours on any day). Night replaces weekend, it never stacks: Saturday night
 * is base x night multiplier, not base x 1.5 x 2.
 *
 * The night window is an office setting that is not decided yet. Until it is
 * set, nothing is ever classed as night automatically: the office confirms the
 * band on every session.
 */

export const BANDS = ["standard", "weekend", "night"] as const;
export type Band = (typeof BANDS)[number];

export const BAND_LABEL: Record<Band, string> = {
  standard: "Ordinary hours",
  weekend: "Weekend daytime",
  night: "Night / after hours",
};

export const CATEGORIES = [
  "site",
  "loading",
  "collect_materials",
  "travel_between_jobs",
  "travel_shop_job",
  "travel_home_work",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  site: "Work on site",
  loading: "Loading",
  collect_materials: "Collecting materials",
  travel_between_jobs: "Travel between jobs",
  travel_shop_job: "Travel shop to job and back",
  travel_home_work: "Home to work travel",
};

export type Terms = { baseRate: number; weekendMultiplier: number; nightMultiplier: number };
export type SplitPart = { band: Band; minutes: number };
export type PayLine = { band: Band; label: string; minutes: number; hours: number; rate: number; total: number };
export type NightWindow = { start: string; end: string } | null;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Hourly rate for a band. Night overrides weekend: one multiplier, never two. */
export function rateFor(band: Band, t: Terms): number {
  if (band === "night") return round2(t.baseRate * t.nightMultiplier);
  if (band === "weekend") return round2(t.baseRate * t.weekendMultiplier);
  return round2(t.baseRate);
}

export function bandRates(t: Terms): Record<Band, number> {
  return { standard: rateFor("standard", t), weekend: rateFor("weekend", t), night: rateFor("night", t) };
}

/** Pay lines for a confirmed split. Totals are minutes x rate / 60, to the cent. */
export function payLines(split: SplitPart[], t: Terms): { lines: PayLine[]; minutes: number; total: number } {
  const merged = new Map<Band, number>();
  for (const p of split) {
    if (!BANDS.includes(p.band)) throw new Error(`Unknown band ${p.band}`);
    if (!Number.isFinite(p.minutes) || p.minutes < 0) throw new Error("Band minutes must be zero or more");
    merged.set(p.band, (merged.get(p.band) ?? 0) + Math.round(p.minutes));
  }
  const lines: PayLine[] = [];
  for (const band of BANDS) {
    const minutes = merged.get(band) ?? 0;
    if (minutes <= 0) continue;
    const rate = rateFor(band, t);
    lines.push({ band, label: BAND_LABEL[band], minutes, hours: round2(minutes / 60), rate, total: round2((minutes * rate) / 60) });
  }
  return {
    lines,
    minutes: lines.reduce((s, l) => s + l.minutes, 0),
    total: round2(lines.reduce((s, l) => s + l.total, 0)),
  };
}

/* ------------------------------------------------------------------ *
 * Local time, without assuming a fixed offset.
 * ------------------------------------------------------------------ */

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-AU", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, weekday: wd };
}

export const localDateOf = (ms: number, tz: string) => parts(ms, tz).date;

const toMin = (hhmm: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Bad time ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/** True when a local HH:MM falls in the night window. A window may cross midnight. */
export function inNight(hhmm: string, w: NightWindow): boolean {
  if (!w) return false;
  const t = toMin(hhmm);
  const s = toMin(w.start);
  const e = toMin(w.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * The band each minute of work falls in, in the job's own time zone. Weekend
 * is Saturday or Sunday by the local date, so it is decided by the calendar.
 * Night is only applied when the office has set the window.
 */
export function suggestSplit(
  intervals: Array<[number, number]>,
  tz: string,
  night: NightWindow,
): { split: SplitPart[]; minutes: number } {
  const acc: Record<Band, number> = { standard: 0, weekend: 0, night: 0 };
  for (const [a, b] of intervals) {
    if (!(b > a)) continue;
    const total = Math.round((b - a) / 60_000);
    // Read the local clock once an hour and count minutes in between, which is
    // exact for any zone whose offset only moves on the hour.
    let mod = 0;
    let wd = 0;
    for (let i = 0; i < total; i++) {
      if (i % 60 === 0) {
        const p = parts(a + i * 60_000, tz);
        mod = toMin(p.hhmm);
        wd = p.weekday;
      } else if (++mod >= 1440) {
        mod = 0;
        wd = (wd + 1) % 7;
      }
      const hhmm = `${String(Math.floor(mod / 60)).padStart(2, "0")}:${String(mod % 60).padStart(2, "0")}`;
      const band: Band = inNight(hhmm, night) ? "night" : wd === 0 || wd === 6 ? "weekend" : "standard";
      acc[band]++;
    }
  }
  const split = BANDS.filter((b) => acc[b] > 0).map((band) => ({ band, minutes: acc[band] }));
  return { split, minutes: split.reduce((s, x) => s + x.minutes, 0) };
}

/**
 * Work time minus the unpaid breaks, as intervals. Paid breaks stay in the
 * work time and are reported separately. Undecided breaks stay in too and the
 * caller blocks approval on them.
 */
export function workIntervals(
  start: number,
  end: number,
  breaks: Array<{ start: number; end: number | null; paid: boolean | null }>,
): { intervals: Array<[number, number]>; paidBreak: number; unpaidBreak: number; undecided: number; gross: number } {
  const cuts = breaks
    .map((b) => ({ s: Math.max(start, b.start), e: Math.min(end, b.end ?? end), paid: b.paid }))
    .filter((b) => b.e > b.s)
    .sort((x, y) => x.s - y.s);
  let paidBreak = 0;
  let unpaidBreak = 0;
  let undecided = 0;
  const intervals: Array<[number, number]> = [];
  let cursor = start;
  for (const c of cuts) {
    const mins = Math.round((c.e - c.s) / 60_000);
    if (c.paid === true) paidBreak += mins;
    else if (c.paid === false) unpaidBreak += mins;
    else undecided += mins;
    if (c.paid === false) {
      if (c.s > cursor) intervals.push([cursor, c.s]);
      cursor = Math.max(cursor, c.e);
    }
  }
  if (end > cursor) intervals.push([cursor, end]);
  return { intervals, paidBreak, unpaidBreak, undecided, gross: Math.round((end - start) / 60_000) };
}

/**
 * Split one vehicle day's allowance across its jobs by time, to the cent, so
 * the shares always add back to the allowance exactly (largest remainder).
 * Office corrections replace the computed shares when they add up.
 */
export function vehicleShares(
  allowance: number,
  parts: Array<{ taskId: number; minutes: number }>,
  overrides: Array<{ taskId: number; share: number }> = [],
): { shares: Array<{ taskId: number; minutes: number; share: number; override: boolean }>; overrideIgnored: boolean } {
  const byTask = new Map<number, number>();
  for (const p of parts) byTask.set(p.taskId, (byTask.get(p.taskId) ?? 0) + Math.max(0, p.minutes));
  for (const o of overrides) if (!byTask.has(o.taskId)) byTask.set(o.taskId, 0);
  const ids = [...byTask.keys()].sort((a, b) => a - b);
  const cents = Math.round(allowance * 100);

  if (overrides.length) {
    const sum = Math.round(overrides.reduce((s, o) => s + o.share, 0) * 100);
    const covered = ids.every((id) => overrides.some((o) => o.taskId === id));
    if (sum === cents && covered) {
      return {
        shares: ids.map((taskId) => ({ taskId, minutes: byTask.get(taskId)!, share: round2(overrides.find((o) => o.taskId === taskId)!.share), override: true })),
        overrideIgnored: false,
      };
    }
  }
  const total = ids.reduce((s, id) => s + byTask.get(id)!, 0);
  if (ids.length === 0) return { shares: [], overrideIgnored: overrides.length > 0 };
  const raw = ids.map((id) => ({ taskId: id, minutes: byTask.get(id)!, exact: total > 0 ? (cents * byTask.get(id)!) / total : cents / ids.length }));
  const floor = raw.map((r) => ({ ...r, c: Math.floor(r.exact) }));
  let left = cents - floor.reduce((s, r) => s + r.c, 0);
  const order = [...floor].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)) || a.taskId - b.taskId);
  for (const r of order) {
    if (left <= 0) break;
    r.c++;
    left--;
  }
  return {
    shares: floor.map((r) => ({ taskId: r.taskId, minutes: r.minutes, share: r.c / 100, override: false })),
    overrideIgnored: overrides.length > 0,
  };
}

/**
 * Benchmark against hourly labour plus the vehicle allowance. Both comparisons
 * are always returned. Which one is like for like depends on whether the
 * benchmark already covers the subbie's own vehicle; until the office says,
 * the result is provisional.
 */
export function compare(args: {
  benchmark: number | null;
  labour: number;
  vehicle: number;
  benchmarkVehicle: "unknown" | "included" | "excluded";
}) {
  const { benchmark, labour, vehicle } = args;
  const combined = round2(labour + vehicle);
  if (benchmark == null) {
    return { combined, savingBeforeVehicle: null, savingAfterVehicle: null, likeForLike: null, provisional: true };
  }
  const before = round2(benchmark - labour);
  const after = round2(benchmark - combined);
  const likeForLike = args.benchmarkVehicle === "included" ? "after" : args.benchmarkVehicle === "excluded" ? "before" : null;
  return { combined, savingBeforeVehicle: before, savingAfterVehicle: after, likeForLike, provisional: likeForLike === null };
}
