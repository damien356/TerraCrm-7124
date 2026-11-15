import type { AppRouterClient } from "@template/web";

/**
 * HOME-SCREEN WIDGETS: WHAT EACH ONE SAYS (Damien, 14 Nov 2026).
 *
 * Pure functions, no phone APIs, so the iPhone timeline, the Android widget
 * and the tests all draw from the same rules.
 *
 * The phone keeps the last widget.snapshot it was given (lib/widget-store.ts).
 * From that, these work out what "Terra Today" and "My Job" should say at a
 * given moment: the next booking rolls forward as the day goes on, "Now" shows
 * while a timed booking is on, and once the copy is older than the server's
 * expiry the widget stops showing jobs and asks to open Terra instead.
 *
 * Nothing here shows money, customer names, phone numbers, street addresses
 * or access notes. The snapshot never carries them in the first place.
 */

export type WidgetSnapshot = Awaited<ReturnType<AppRouterClient["widget"]["snapshot"]>>;
type Item = NonNullable<WidgetSnapshot["crew"]>["items"][number];

/** The app's own link scheme (app.json expo.scheme). */
export const APP_SCHEME = "runable-terraop-l8jfdfu";

/** An in-app path ("/task/82") as a link the home screen can open. */
export function appUrl(path: string) {
  return `${APP_SCHEME}://${path.replace(/^\/+/, "")}`;
}

/** What the phone keeps between syncs. */
export interface WidgetCache {
  snap: WidgetSnapshot;
  /** The last time a refresh was tried and did not get through, ms. */
  failedAt: number | null;
}

/**
 * ok: showing jobs. signin: no usable login. stale: too old to trust.
 * wrong: this widget is not for this kind of login. example: nothing synced
 * yet, so a made-up preview is shown and clearly called an example.
 */
export type WidgetState = "ok" | "signin" | "stale" | "wrong" | "example";

export interface BookingView {
  /** "Now", "Today", "Tomorrow" or "Mon 23 Nov". */
  badge: string;
  isNow: boolean;
  /** "7-11 am", "9:30 am", "No time set". An arrival window stays a window. */
  when: string;
  kind: string;
  /** "188070-B". */
  ref: string;
  suburb: string;
  url: string;
}

export interface TodayProps {
  state: WidgetState;
  /** Shown instead of the sections when state is not ok. */
  message: string | null;
  /** Where a tap anywhere else on the widget goes. */
  tapUrl: string;
  /** "Updated 7:42 am" from the real sync time, or "Not refreshed since 7:42 am". */
  updated: string;
  booking: BookingView | null;
  /** "No more bookings today", "No bookings in the next 3 weeks"... */
  bookingNote: string | null;
  attention: { total: number; summary: string; url: string } | null;
}

export interface JobView extends BookingView {
  /** His own labour only. */
  work: string;
  status: string;
  /** "Day 2 of 3", or null. */
  dayLabel: string | null;
  openUrl: string;
  directionsUrl: string | null;
  /** Only for jobs he is on hourly. Opens the time screen, never starts it. */
  timeUrl: string | null;
}

export interface MyJobProps {
  state: WidgetState;
  message: string | null;
  tapUrl: string;
  updated: string;
  job: JobView | null;
  jobNote: string | null;
  /** "Working on 188070-B since 7:02 am (at last sync)". Never called live. */
  session: { text: string; url: string } | null;
  /** Set when he has more than one booking today. */
  viewTodayUrl: string | null;
}

/* ------------------------------------------------------------ Brisbane time */

// Queensland has no daylight saving, so Brisbane is always UTC+10. The server
// pins the same zone (snapshot.tz) and already wrote every booking time as words.
const BRISBANE_MS = 10 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YYYY-MM-DD in Brisbane at this instant. */
export function brisbaneDate(ms: number) {
  return new Date(ms + BRISBANE_MS).toISOString().slice(0, 10);
}

/** The next Brisbane midnight after this instant, ms. */
export function nextMidnight(ms: number) {
  return Math.floor((ms + BRISBANE_MS) / DAY_MS) * DAY_MS + DAY_MS - BRISBANE_MS;
}

/** "7:42 am". */
export function clockLabel(ms: number) {
  const d = new Date(ms + BRISBANE_MS);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function addDays(date: string, n: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow", or "Mon 23 Nov". */
export function dayBadge(date: string, today: string) {
  if (date === today) return "Today";
  if (date === addDays(today, 1)) return "Tomorrow";
  const d = new Date(`${date}T00:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

function updatedLabel(cache: WidgetCache, now: number) {
  const { syncedAt } = cache.snap;
  const sameDay = brisbaneDate(syncedAt) === brisbaneDate(now);
  const at = sameDay ? clockLabel(syncedAt) : `${DOW[new Date(syncedAt + BRISBANE_MS).getUTCDay()]} ${clockLabel(syncedAt)}`;
  const failed = cache.failedAt != null && cache.failedAt > syncedAt;
  return failed ? `Not refreshed since ${at}` : `Updated ${at}`;
}

/* --------------------------------------------------------------- the items */

/** Still worth showing at this moment. The server already put them in order. */
function liveItems(items: Item[], now: number) {
  return items.filter((it) => it.until > now);
}

/**
 * "Now" for a timed measure or site visit while its time is on, or for
 * anything the server saw him at when it synced. An arrival window or a day
 * on the tools is never turned into "Now" by the clock alone.
 */
function isNow(it: Item, now: number) {
  if (it.until <= now) return false;
  if (it.current) return true;
  return it.kind !== "install" && !it.isWindow && it.startsAt != null && it.startsAt <= now;
}

function bookingOf(it: Item, now: number): BookingView {
  const nowOn = isNow(it, now);
  return {
    badge: nowOn ? "Now" : dayBadge(it.date, brisbaneDate(now)),
    isNow: nowOn,
    when: it.timeLabel ?? "No time set",
    kind: it.kindLabel,
    ref: it.ref,
    suburb: it.suburb ?? "Suburb to come",
    url: appUrl(it.links.open),
  };
}

function noteFor(all: Item[], live: Item[], now: number, nothing: string) {
  if (live.length === 0) {
    // The phone only keeps the next few. Once those are used up, say so
    // rather than claim there is nothing booked.
    return all.length > 0 ? "Open Terra to see what's next" : nothing;
  }
  return live[0].date !== brisbaneDate(now) ? "No more bookings today. Next:" : null;
}

/* ---------------------------------------------------------------- the views */

const HOME = appUrl("/");

function blankToday(state: WidgetState, message: string, updated = ""): TodayProps {
  return { state, message, tapUrl: HOME, updated, booking: null, bookingNote: null, attention: null };
}

function blankJob(state: WidgetState, message: string, updated = ""): MyJobProps {
  return { state, message, tapUrl: HOME, updated, job: null, jobNote: null, session: null, viewTodayUrl: null };
}

/** Too old to trust: from the server's own expiry, or from a day that has gone. */
function tooOld(cache: WidgetCache, now: number) {
  return now >= cache.snap.expiresAt || now < cache.snap.syncedAt - 5 * 60_000;
}

export const SIGN_IN = "Open Terra to sign in";
export const REFRESH = "Open Terra to refresh";

export function todayView(cache: WidgetCache | null, now: number): TodayProps {
  if (!cache) return blankToday("signin", SIGN_IN);
  if (tooOld(cache, now)) return blankToday("stale", REFRESH);
  const office = cache.snap.office;
  if (!office) return blankToday("wrong", "Terra Today is for office logins. Add the My Job widget instead.");

  const live = liveItems(office.items, now);
  const a = office.attention;
  const shown = a.lines.slice(0, 3).map((l) => `${l.label} ${l.count}`);
  return {
    state: "ok",
    message: null,
    tapUrl: HOME,
    updated: updatedLabel(cache, now),
    booking: live[0] ? bookingOf(live[0], now) : null,
    bookingNote: office.bookable
      ? noteFor(office.items, live, now, "No bookings in the next 3 weeks")
      : "No bookings on this login",
    attention: { total: a.total, summary: a.total === 0 ? "All clear" : shown.join(" · "), url: appUrl(a.path) },
  };
}

export function myJobView(cache: WidgetCache | null, now: number): MyJobProps {
  if (!cache) return blankJob("signin", SIGN_IN);
  if (tooOld(cache, now)) return blankJob("stale", REFRESH);
  const crew = cache.snap.crew;
  if (!crew) return blankJob("wrong", "My Job shows jobs for installer logins. Add the Terra Today widget instead.");

  const live = liveItems(crew.items, now);
  const first = live[0];
  const job: JobView | null = first
    ? {
        ...bookingOf(first, now),
        work: first.work,
        status: first.statusLabel,
        dayLabel: first.dayLabel,
        openUrl: appUrl(first.links.open),
        directionsUrl: first.links.directions ? appUrl(first.links.directions) : null,
        timeUrl: first.links.timeClock ? appUrl(first.links.timeClock) : null,
      }
    : null;

  // An open session stays findable even when a different booking is next.
  const s = crew.session;
  const session = s
    ? {
        text: `${s.state === "on_break" ? "On break" : "Working"} on ${s.ref} since ${clockLabel(s.since)} (at last sync)`,
        url: appUrl(`/hours?task=${s.taskId}`),
      }
    : null;

  const sameDay = cache.snap.today === brisbaneDate(now);
  return {
    state: "ok",
    message: null,
    tapUrl: job ? job.openUrl : HOME,
    updated: updatedLabel(cache, now),
    job,
    jobNote: noteFor(crew.items, live, now, "No assigned jobs"),
    session,
    viewTodayUrl: sameDay && crew.todayCount > 1 ? HOME : null,
  };
}

/** Signed out, switched off or expired: every widget says the same safe thing. */
export const signedOutToday = (): TodayProps => blankToday("signin", SIGN_IN);
export const signedOutJob = (): MyJobProps => blankJob("signin", SIGN_IN);

/**
 * The moments the widget's words change without a new sync: each booking
 * finishing or starting, midnight, and the expiry. The iPhone is handed one
 * entry per moment so it can roll forward with the app closed.
 */
export function timelineMoments(cache: WidgetCache, now: number, max = 24) {
  const { snap } = cache;
  const end = snap.expiresAt;
  const all = [...(snap.office?.items ?? []), ...(snap.crew?.items ?? [])];
  const at = new Set<number>([now, end]);
  for (const it of all) {
    if (it.until > now && it.until < end) at.add(it.until);
    if (it.startsAt != null && it.startsAt > now && it.startsAt < end) at.add(it.startsAt);
  }
  for (let m = nextMidnight(now); m < end; m += DAY_MS) at.add(m);
  return [...at].sort((x, y) => x - y).slice(0, max);
}

/* ------------------------------------------------------------------ example */

// Made up, for the widget gallery before Terra has synced. Every value is
// fictional and the widget labels it "Example".
export const EXAMPLE_TODAY: TodayProps = {
  state: "example",
  message: SIGN_IN,
  tapUrl: HOME,
  updated: "Example",
  booking: { badge: "Today", isNow: false, when: "9:30 am", kind: "Measure", ref: "100001-A", suburb: "Sampletown", url: HOME },
  bookingNote: null,
  attention: { total: 5, summary: "Jobs needing a body 2 · Overdue jobs 3", url: HOME },
};

export const EXAMPLE_JOB: MyJobProps = {
  state: "example",
  message: SIGN_IN,
  tapUrl: HOME,
  updated: "Example",
  job: {
    badge: "Today",
    isNow: false,
    when: "7-11 am",
    kind: "Install",
    ref: "100001-B",
    suburb: "Sampletown",
    url: HOME,
    work: "Hybrid installation 40 m²",
    status: "Booked in",
    dayLabel: "Day 1 of 2",
    openUrl: HOME,
    directionsUrl: HOME,
    timeUrl: null,
  },
  jobNote: null,
  session: null,
  viewTodayUrl: null,
};
