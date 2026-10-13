import {
  BANK,
  BANK_GAP_DAYS,
  CARE_HOLIDAYS,
  FIXED_CODES,
  HOLIDAY_SEND_HOUR,
  LAST_CODE,
  LAST_CODE_WEEKS,
  MIN_GAP_DAYS,
  SCHEDULES,
  SERIES_SEND_HOUR,
  holidayClearDays,
  isLoopPile,
  isWoolFibre,
  scheduleKeyFor,
  type CareFloor,
  type CareHoliday,
  type ScheduleKey,
} from "./care-codes";

/* ---------------------------------------------------------------------------
 * The care series planner. Pure: no database, no clock of its own.
 *
 * It never stores a plan. Given who the person is and what they have already
 * been sent, it works out the ONE next email and when it is due. So a floor
 * added by a second job, an email Damien switches off, or a holiday that lands
 * in the middle all just change the answer next time it is asked, and nothing
 * stored can drift out of step.
 *
 * Rules, from the spec (Attachments/after_job_care_series):
 *  - each floor has its own schedule in weeks after completion
 *  - merged schedules keep at least 3 weeks between any two emails (S1 excepted)
 *  - a seasonal email (H1 H2 H3) pushes others 2 weeks clear, a holiday one 10 days
 *  - C3, T6 and S4 go exactly 12 months after completion, then yearly, never moved
 *  - A5 goes 5 weeks after the last email of the schedule
 *  - after that, one bank email (R1 to R10) every 8 to 10 weeks
 * ------------------------------------------------------------------------- */

const DAY = 86_400_000;
const BNE = 10 * 3_600_000;

/** Brisbane calendar date of an instant, YYYY-MM-DD. Queensland has no daylight saving. */
export const bneDate = (d: Date) => new Date(d.getTime() + BNE).toISOString().slice(0, 10);
/** The instant a Brisbane date and hour is. */
export const atBne = (date: string, hour: number) => new Date(Date.parse(`${date}T00:00:00Z`) + hour * 3_600_000 - BNE);
export const bneMonth = (d: Date) => new Date(d.getTime() + BNE).getUTCMonth() + 1;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** Same Brisbane date n years on, 29 Feb falls back to 28 Feb. */
function addYears(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
  return `${String(y + n).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}
/** The series send time on the Brisbane day an instant falls on. */
const seriesTime = (d: Date) => atBne(bneDate(d), SERIES_SEND_HOUR);

export interface PlanFloor {
  floor: CareFloor;
  startedAt: Date;
  jobId?: number | null;
}

export interface PlanHistory {
  code: string;
  /** When it was sent, or when it was skipped. */
  at: Date;
  status: "sent" | "skipped" | "failed";
}

export interface PlanInput {
  memberId: number;
  floors: PlanFloor[];
  fibre: string;
  pile: string;
  landlord: boolean;
  history: PlanHistory[];
  /** Codes Damien switched off on the Care page. They are passed over, never sent. */
  inactive?: Set<string>;
  /** The member's group is slowed to every 12 weeks in year 2. */
  slow?: boolean;
  now: Date;
  holidays?: CareHoliday[];
}

export interface PlanItem {
  code: string;
  kind: "series" | "fixed" | "holiday" | "bank";
  dueAt: Date;
  floor?: CareFloor;
  jobId?: number | null;
}

/** C1 becomes C1-W for wool, wool blend or loop pile. */
export const carpetFirstCode = (fibre: string, pile: string) => (isWoolFibre(fibre) || isLoopPile(pile) ? "C1-W" : "C1");

const sameCode = (a: string, b: string) => a === b || ((a === "C1" || a === "C1-W") && (b === "C1" || b === "C1-W"));

/**
 * A code counts as done once sent or skipped, or after it failed twice.
 * Only history from `since` on counts, so a floor that restarts after 12 months
 * gets its emails again.
 */
function doneCodes(history: PlanHistory[], since = 0) {
  const done = new Set<string>();
  const fails = new Map<string, number>();
  for (const h of history) {
    if (h.at.getTime() < since) continue;
    if (h.status === "failed") {
      const n = (fails.get(h.code) ?? 0) + 1;
      fails.set(h.code, n);
      if (n >= 2) done.add(h.code);
    } else done.add(h.code);
  }
  if (done.has("C1") || done.has("C1-W")) {
    done.add("C1");
    done.add("C1-W");
  }
  return done;
}

interface Nominal {
  code: string;
  nominal: Date;
  urgent: boolean;
  floor: CareFloor;
  jobId: number | null;
  order: number;
  /** ms, start of the floor this email belongs to. */
  start: number;
}

/** Every first-year email this person qualifies for, earliest date per code. */
function nominals(input: PlanInput) {
  const out = new Map<string, Nominal>();
  let order = 0;
  for (const f of input.floors) {
    const key = scheduleKeyFor(f.floor, input.landlord);
    for (const step of SCHEDULES[key]) {
      order++;
      if (step.woolOnly && !isWoolFibre(input.fibre)) continue;
      const code = step.code === "C1" ? carpetFirstCode(input.fibre, input.pile) : step.code;
      const nominal = step.week < 1 ? seriesTime(addDays(f.startedAt, Math.round(step.week * 7))) : seriesTime(addDays(f.startedAt, step.week * 7));
      const had = out.get(code);
      if (!had || nominal < had.nominal) out.set(code, { code, nominal, urgent: !!step.urgent, floor: f.floor, jobId: f.jobId ?? null, order, start: f.startedAt.getTime() });
    }
  }
  return [...out.values()];
}

export const scheduleKeysOf = (input: Pick<PlanInput, "floors" | "landlord">): ScheduleKey[] => [
  ...new Set(input.floors.map((f) => scheduleKeyFor(f.floor, input.landlord))),
];

/** The next 12-month email for each fixed code, on its exact date. */
function fixedDue(input: PlanInput): PlanItem[] {
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  for (const f of input.floors) {
    const code = FIXED_CODES[scheduleKeyFor(f.floor, input.landlord)];
    if (!code || seen.has(code) || input.inactive?.has(code)) continue;
    seen.add(code);
    const start = bneDate(f.startedAt);
    for (let k = 1; k < 60; k++) {
      const due = atBne(addYears(start, k), SERIES_SEND_HOUR);
      /* More than 30 days late (the engine was off) waits for next year. */
      if (due.getTime() + 30 * DAY < input.now.getTime()) continue;
      const handled = input.history.some((h) => h.code === code && h.status !== "failed" && Math.abs(h.at.getTime() - due.getTime()) < 60 * DAY);
      if (handled) continue;
      out.push({ code, kind: "fixed", dueAt: due, floor: f.floor, jobId: f.jobId ?? null });
      break;
    }
  }
  return out;
}

/** The latest completion date across their floors. */
const latestStart = (input: PlanInput) => Math.max(...input.floors.map((f) => f.startedAt.getTime()));

/** Holidays this person will get: completed at least 3 weeks before, and switched on. */
function holidaysFor(input: PlanInput) {
  const latest = latestStart(input);
  return (input.holidays ?? CARE_HOLIDAYS)
    .filter((h) => !input.inactive?.has(h.code))
    .map((h) => ({ ...h, at: atBne(h.date, HOLIDAY_SEND_HOUR) }))
    .filter((h) => h.at.getTime() - latest >= MIN_GAP_DAYS * DAY);
}

/**
 * Pushes a due date clear of holidays and the fixed 12-month emails until it
 * settles. A holiday pushes it to clear days after the holiday, a fixed email
 * to 3 weeks after it.
 */
function settle(due: Date, input: PlanInput, fixed: PlanItem[]) {
  const hols = holidaysFor(input);
  let d = due;
  for (let i = 0; i < 40; i++) {
    let moved = false;
    for (const h of hols) {
      const clear = holidayClearDays(h.code) * DAY;
      if (Math.abs(d.getTime() - h.at.getTime()) < clear) {
        d = seriesTime(new Date(h.at.getTime() + clear));
        moved = true;
      }
    }
    for (const f of fixed) {
      if (Math.abs(d.getTime() - f.dueAt.getTime()) < MIN_GAP_DAYS * DAY) {
        d = seriesTime(addDays(f.dueAt, MIN_GAP_DAYS));
        moved = true;
      }
    }
    if (!moved) break;
  }
  return d;
}

/** Last non-holiday email actually sent. Holidays have their own clear rule. */
function lastSent(input: PlanInput) {
  let at = 0;
  for (const h of input.history) if (h.status === "sent" && !/^H\d$/.test(h.code)) at = Math.max(at, h.at.getTime());
  return at ? new Date(at) : null;
}

/** A small, steady spread for the year 2 gap so it never lands on the same weekday. */
function spread(memberId: number, n: number) {
  let x = (memberId * 2654435761 + n * 40503) >>> 0;
  x ^= x >>> 15;
  return x % (BANK_GAP_DAYS.max - BANK_GAP_DAYS.min + 1);
}

/** The next bank email: who it suits, the season, and the 6-month rule. */
function bankPick(input: PlanInput, due: Date): string | null {
  const keys = scheduleKeysOf(input);
  const month = bneMonth(due);
  const sentWithin = (code: string, days: number) =>
    input.history.some((h) => sameCode(h.code, code) && h.status === "sent" && due.getTime() - h.at.getTime() < days * DAY);
  const lastOf = (code: string) => Math.max(0, ...input.history.filter((h) => h.code === code && h.status !== "failed").map((h) => h.at.getTime()));

  const ok = BANK.filter((b) => {
    if (input.inactive?.has(b.code)) return false;
    if (b.landlordOnly && !input.landlord) return false;
    if (b.for.length && !b.for.some((k) => keys.includes(k))) return false;
    if (b.months?.length && !b.months.includes(month)) return false;
    if (b.from.some((c) => sentWithin(c, 183))) return false;
    if (sentWithin(b.code, 300)) return false;
    return true;
  });
  if (!ok.length) return null;
  /* In season first, then never sent, then the longest ago, then bank order. */
  ok.sort((a, b) => {
    const sa = a.months?.length ? 0 : 1;
    const sb = b.months?.length ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return lastOf(a.code) - lastOf(b.code);
  });
  return ok[0]!.code;
}

/**
 * The one next email, holidays aside (see holidayDue). Null when there is
 * nothing left to plan, which in practice never happens once year 2 starts.
 */
/** Series emails still to come, each checked against history from its own floor's start. */
function seriesLeft(input: PlanInput, all: Nominal[]) {
  const bySince = new Map<number, Set<string>>();
  const doneFor = (since: number) => {
    let d = bySince.get(since);
    if (!d) bySince.set(since, (d = doneCodes(input.history, since)));
    return d;
  };
  return all.filter((n) => !doneFor(n.start).has(n.code));
}

/** When A5 is due on its own, before the gap and holiday rules. */
const lastCodeNominal = (all: Nominal[]) => seriesTime(addDays(new Date(Math.max(...all.map((n) => n.nominal.getTime()))), LAST_CODE_WEEKS * 7));

/**
 * A5 closes the series, at most once in any 12 months: it counts as done when
 * handled in the 300 days before it would be due (the same "about a year"
 * the bank uses). So a floor restarting after a year gets it again, a second
 * floor added a few months on does not.
 */
const lastCodeDone = (input: PlanInput, all: Nominal[]) => doneCodes(input.history, lastCodeNominal(all).getTime() - 300 * DAY).has(LAST_CODE);

export function nextEmail(input: PlanInput): PlanItem | null {
  if (!input.floors.length) return null;
  const fixed = fixedDue(input);
  const last = lastSent(input);
  const gapFrom = (d: Date) => (last && d.getTime() < last.getTime() + MIN_GAP_DAYS * DAY ? seriesTime(addDays(last, MIN_GAP_DAYS)) : d);

  const all = nominals(input);
  const left = seriesLeft(input, all)
    .filter((n) => !input.inactive?.has(n.code))
    .sort((a, b) => a.nominal.getTime() - b.nominal.getTime() || a.order - b.order);

  let candidate: PlanItem | null = null;
  if (left.length) {
    const n = left[0]!;
    const due = n.urgent ? n.nominal : settle(gapFrom(n.nominal), input, fixed);
    candidate = { code: n.code, kind: "series", dueAt: due, floor: n.floor, jobId: n.jobId };
  } else if (all.length && !lastCodeDone(input, all) && !input.inactive?.has(LAST_CODE)) {
    const due = settle(gapFrom(lastCodeNominal(all)), input, fixed);
    candidate = { code: LAST_CODE, kind: "series", dueAt: due };
  } else {
    /* Year 2: the bank. */
    const bankSent = input.history.filter((h) => /^R\d+$/.test(h.code)).length;
    const gap = input.slow ? BANK_GAP_DAYS.slow : BANK_GAP_DAYS.min + spread(input.memberId, bankSent);
    const from = last ?? new Date(latestStart(input));
    let due = settle(seriesTime(addDays(from, gap)), input, fixed);
    for (let i = 0; i < 30; i++) {
      const code = bankPick(input, due);
      if (code) {
        candidate = { code, kind: "bank", dueAt: due };
        break;
      }
      due = settle(seriesTime(addDays(due, 7)), input, fixed);
    }
  }

  const options = [...fixed, ...(candidate ? [candidate] : [])];
  if (!options.length) return null;
  options.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return options[0]!;
}

/**
 * Series emails whose own date has already gone, for someone joining late (the
 * jobs from the last 6 months added when the series first starts). They are
 * written as passed over so the person starts from today: the planner then
 * offers the first email still to come, on its own date. Switched off emails
 * are included, so switching one back on later does not send an old one.
 * A5 is included once every series email before it has gone too.
 */
export function pastDue(input: PlanInput): PlanItem[] {
  if (!input.floors.length) return [];
  const now = input.now.getTime();
  const all = nominals(input);
  const left = seriesLeft(input, all);
  const out: PlanItem[] = left
    .filter((n) => n.nominal.getTime() < now)
    .sort((a, b) => a.nominal.getTime() - b.nominal.getTime() || a.order - b.order)
    .map((n) => ({ code: n.code, kind: "series" as const, dueAt: n.nominal, floor: n.floor, jobId: n.jobId }));
  if (all.length && out.length === left.length && !lastCodeDone(input, all)) {
    const a5 = lastCodeNominal(all);
    if (a5.getTime() < now) out.push({ code: LAST_CODE, kind: "series", dueAt: a5 });
  }
  return out;
}

/** How long after the holiday's 7am a late holiday email may still go (engine down, daily cap). */
export const HOLIDAY_LATE_HOURS = 36;

/** A holiday email due right now for this person, if any. */
export function holidayDue(input: PlanInput): PlanItem | null {
  if (!input.floors.length) return null;
  const now = input.now.getTime();
  for (const h of holidaysFor(input)) {
    if (now < h.at.getTime() || now > h.at.getTime() + HOLIDAY_LATE_HOURS * 3_600_000) continue;
    /* Once per holiday, and each holiday email at most once a year (300 days, so the same date next year still goes). */
    const had = input.history.some(
      (x) => x.code === h.code && x.status !== "failed" && (Math.abs(x.at.getTime() - h.at.getTime()) < 5 * DAY || (h.at.getTime() - x.at.getTime() < 300 * DAY && h.at.getTime() > x.at.getTime())),
    );
    if (had) continue;
    return { code: h.code, kind: "holiday", dueAt: h.at };
  }
  return null;
}

/** The holiday emails this person will get from now on, for the report. */
export function upcomingHolidays(input: PlanInput) {
  return holidaysFor(input).filter((h) => h.at.getTime() + HOLIDAY_LATE_HOURS * 3_600_000 >= input.now.getTime());
}

/**
 * Plays the plan forward as if every email went on its due date. For tests and
 * the timeline on the Care page. Holidays are included.
 */
export function simulate(input: PlanInput, until: Date, max = 80): PlanItem[] {
  const history = [...input.history];
  const out: PlanItem[] = [];
  let now = input.now;
  for (let i = 0; i < max; i++) {
    const nx = nextEmail({ ...input, history, now });
    const hol = upcomingHolidays({ ...input, history, now }).find((h) => holidayDue({ ...input, history, now: h.at }));
    let pick: PlanItem | null = nx;
    if (hol && (!nx || hol.at.getTime() <= nx.dueAt.getTime())) pick = { code: hol.code, kind: "holiday", dueAt: hol.at };
    if (!pick || pick.dueAt > until) break;
    /* A holiday and another email on the same day: the other waits a day (24h rule). */
    const at = out.length && pick.dueAt.getTime() - out[out.length - 1]!.dueAt.getTime() < DAY ? addDays(out[out.length - 1]!.dueAt, 1) : pick.dueAt;
    out.push({ ...pick, dueAt: at });
    history.push({ code: pick.code, at, status: "sent" });
    now = at;
  }
  return out;
}
