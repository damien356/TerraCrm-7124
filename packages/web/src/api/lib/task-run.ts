import { and, asc, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { jobNumberSql, taskRefSql } from "./job-ref";
import { addLocalDays, todayLocal, weekdayOf } from "./local-date";

/* ---------------------------------------------------------------------------
 * Which days a task is worked on, one rule for every "today" in the office.
 *
 * Business dates are Australia/Brisbane (lib/local-date.ts). A task that is
 * not cancelled belongs in Today when one of its working days is today.
 *
 * Where the days come from, in order:
 *  1. task_days rows, skipping cancelled days. This is the booking.
 *  2. No rows: the scheduled start to end range, but only where the day count
 *     on the task (manual_days) says how to read it. The same columns also
 *     hold an offer window, so a range on its own is not a booking.
 *  3. No rows and no range: a one day task on scheduled_date.
 * Anything else is flagged as an incomplete schedule. It is never quietly
 * read as day one only, because that is what hid running jobs before.
 *
 * Late means the final working day has passed. There is no reliable finish
 * time on a task (duration_hours defaults to 4), so a task is not late on its
 * last day, only from the day after.
 * ------------------------------------------------------------------------- */

export const ACTIVE_TASK = ["unassigned", "offered", "assigned", "in_progress"] as const;
const BOOKED = ["assigned", "in_progress"];

export type RunSource = "days" | "range" | "single" | "none";

export interface RunTask {
  id: number;
  status: string;
  scheduledDate: string | null;
  scheduledFrom: string | null;
  scheduledTo: string | null;
  manualDays: number | null;
}

export interface RunDay {
  date: string;
  status: string;
  installerId?: number | null;
}

export interface TaskRun {
  taskId: number;
  source: RunSource;
  /** Working days in order. Empty when the schedule is incomplete or not booked. */
  days: string[];
  /** Cover installer for a day, where the day row names one. */
  coverOn: Map<string, number>;
  /** Plain words, set when the schedule cannot be read reliably. */
  incomplete: string | null;
  /** The dates an incomplete schedule could cover, so it still shows. */
  windowFrom: string | null;
  windowTo: string | null;
}

/** Every calendar date from a to b inclusive. Capped so a typo cannot run away. */
function datesBetween(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b && out.length < 120; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

const isWeekday = (d: string) => {
  const w = weekdayOf(d);
  return w !== 0 && w !== 6;
};

/** Pure. The working days of one task from its own columns and day rows. */
export function resolveRun(task: RunTask, dayRows: RunDay[]): TaskRun {
  const base = { taskId: task.id, coverOn: new Map<string, number>(), windowFrom: null, windowTo: null } as const;
  const booked = BOOKED.includes(task.status);

  if (dayRows.length) {
    const live = dayRows.filter((d) => d.status !== "cancelled").sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const days = [...new Set(live.map((d) => d.date))];
    const coverOn = new Map<string, number>();
    for (const d of live) if (d.installerId) coverOn.set(d.date, d.installerId);
    if (!days.length && booked) {
      return { ...base, coverOn, source: "days", days, incomplete: "Every booked day is cancelled but the task is still open." };
    }
    return { ...base, coverOn, source: "days", days, incomplete: null };
  }

  const start = task.scheduledDate;
  if (!start) {
    return {
      ...base,
      source: "none",
      days: [],
      incomplete: booked ? "Booked to an installer with no date." : null,
    };
  }

  const end = task.scheduledTo && task.scheduledTo > start ? task.scheduledTo : null;
  const n = task.manualDays ?? null;

  if (!end) {
    if (n && n > 1) {
      return {
        ...base,
        source: "single",
        days: [],
        incomplete: `Set for ${n} days but only ${start} is booked.`,
        windowFrom: start,
        windowTo: start,
      };
    }
    return { ...base, source: "single", days: [start], incomplete: null };
  }

  const all = datesBetween(start, end);
  const weekdays = all.filter(isWeekday);
  if (n === all.length) return { ...base, source: "range", days: all, incomplete: null };
  if (n === weekdays.length && weekdays.length) return { ...base, source: "range", days: weekdays, incomplete: null };
  // A one day task inside a wider offer window: the locked day is the day.
  if (n === 1) return { ...base, source: "single", days: [start], incomplete: null };
  return {
    ...base,
    source: "range",
    days: [],
    incomplete:
      n == null
        ? `No booked days. Range ${start} to ${end} with no day count.`
        : `No booked days. Range ${start} to ${end} does not match ${n} days.`,
    windowFrom: start,
    windowTo: end,
  };
}

/** Where a date sits in a run. Null when the task is not on that date. */
export function dayOf(run: TaskRun, date: string): { daySeq: number | null; dayCount: number | null; incomplete: string | null } | null {
  const i = run.days.indexOf(date);
  if (i >= 0) return { daySeq: i + 1, dayCount: run.days.length, incomplete: run.incomplete };
  if (run.incomplete && run.windowFrom && run.windowTo && date >= run.windowFrom && date <= run.windowTo) {
    return { daySeq: null, dayCount: null, incomplete: run.incomplete };
  }
  return null;
}

/** The last day the task is meant to be worked. Null when nobody knows. */
export function lastDayOf(run: TaskRun, task: RunTask): string | null {
  if (run.days.length) return run.days[run.days.length - 1]!;
  if (run.windowTo) return run.windowTo;
  if (run.source === "days") return null;
  return task.scheduledTo ?? task.scheduledDate ?? null;
}

/** Late: still open and the final working day is before today. */
export function isLate(run: TaskRun, task: RunTask, today: string): boolean {
  if (!(ACTIVE_TASK as readonly string[]).includes(task.status)) return false;
  const last = lastDayOf(run, task);
  return last != null && last < today;
}

/** Every date an incomplete schedule could cover. */
export function windowDates(run: TaskRun): string[] {
  return run.windowFrom && run.windowTo ? datesBetween(run.windowFrom, run.windowTo) : [];
}

/** "Day 2 of 6", or a flag when the schedule is incomplete. */
export function dayLabel(d: { daySeq: number | null; dayCount: number | null; incomplete: string | null }): string {
  if (d.daySeq && d.dayCount) return `Day ${d.daySeq} of ${d.dayCount}`;
  return "Schedule incomplete";
}

/** Day rows for many tasks, grouped by task. */
export async function dayRowsFor(taskIds: number[]) {
  const out = new Map<number, RunDay[]>();
  if (!taskIds.length) return out;
  const rows = await db
    .select({ taskId: schema.taskDays.taskId, date: schema.taskDays.date, status: schema.taskDays.status, installerId: schema.taskDays.installerId })
    .from(schema.taskDays)
    .where(inArray(schema.taskDays.taskId, [...new Set(taskIds)]));
  for (const r of rows) {
    if (!out.has(r.taskId)) out.set(r.taskId, []);
    out.get(r.taskId)!.push(r);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Worker days: who is on which task on which Brisbane date.
 *
 * The busy clash, the load heat, the availability clash list, the SWMS board
 * and client prep all ask the same question, so they all use this. Before,
 * each read job_tasks.scheduled_date as the only day when a task had no day
 * rows, so day 2 of a range looked free.
 *
 * Who works a date: the day row's cover installer when it names one, else the
 * task's own installer and second installer. A schedule that cannot be read
 * gives a slot on every date it could cover, with `incomplete` set, so the
 * caller can flag it. It is never read as day one only.
 * ------------------------------------------------------------------------- */

export interface SlotTask extends RunTask {
  assignedInstallerId: number | null;
  secondInstallerId: number | null;
}

export interface WorkSlot {
  taskId: number;
  date: string;
  installerId: number;
  daySeq: number | null;
  dayCount: number | null;
  /** Plain words when the schedule cannot be read. The date is a maybe. */
  incomplete: string | null;
}

/** SQL candidates: tasks that could have a working day between two dates. workSlots has the final say. */
export function mayWorkBetween(from: string, to: string) {
  return or(
    sql`exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id} and d.date >= ${from} and d.date <= ${to} and d.status != 'cancelled')`,
    and(
      sql`not exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id})`,
      lte(schema.jobTasks.scheduledDate, to),
      sql`coalesce(${schema.jobTasks.scheduledTo}, ${schema.jobTasks.scheduledDate}) >= ${from}`,
    ),
  );
}

/** Pure. Every worker day of one task between two dates, inclusive. */
export function slotsOf(task: SlotTask, rows: RunDay[], from: string, to: string): WorkSlot[] {
  if (task.status === "cancelled") return [];
  const run = resolveRun(task, rows);
  const crew = [...new Set([task.assignedInstallerId, task.secondInstallerId].filter((x): x is number => Boolean(x)))];
  const out: WorkSlot[] = [];
  for (const date of run.days.length ? run.days : windowDates(run)) {
    if (date < from || date > to) continue;
    const at = dayOf(run, date);
    if (!at) continue;
    const cover = run.coverOn.get(date);
    for (const installerId of cover ? [cover] : crew) {
      out.push({ taskId: task.id, date, installerId, daySeq: at.daySeq, dayCount: at.dayCount, incomplete: at.incomplete });
    }
  }
  return out;
}

/** Worker days for many tasks, day rows read in one go. */
export async function workSlots(tasks: SlotTask[], from: string, to: string): Promise<WorkSlot[]> {
  const rows = await dayRowsFor(tasks.map((t) => t.id));
  return tasks
    .flatMap((t) => slotsOf(t, rows.get(t.id) ?? [], from, to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.taskId - b.taskId));
}

/** The columns workSlots needs, for a select. */
export const slotCols = {
  id: schema.jobTasks.id,
  status: schema.jobTasks.status,
  scheduledDate: schema.jobTasks.scheduledDate,
  scheduledFrom: schema.jobTasks.scheduledFrom,
  scheduledTo: schema.jobTasks.scheduledTo,
  manualDays: schema.jobTasks.manualDays,
  assignedInstallerId: schema.jobTasks.assignedInstallerId,
  secondInstallerId: schema.jobTasks.secondInstallerId,
};

const runCols = {
  id: schema.jobTasks.id,
  status: schema.jobTasks.status,
  scheduledDate: schema.jobTasks.scheduledDate,
  scheduledFrom: schema.jobTasks.scheduledFrom,
  scheduledTo: schema.jobTasks.scheduledTo,
  manualDays: schema.jobTasks.manualDays,
};

const cardCols = {
  ...runCols,
  title: schema.jobTasks.title,
  startTime: schema.jobTasks.startTime,
  crewSize: schema.jobTasks.crewSize,
  assignedInstallerId: schema.jobTasks.assignedInstallerId,
  installerName: schema.installers.name,
  installerColour: schema.installers.colour,
  skillName: schema.skills.name,
  jobId: schema.jobTasks.jobId,
  jobNumber: jobNumberSql,
  ref: taskRefSql,
  siteAddress: schema.sites.address,
  siteSuburb: schema.sites.suburb,
};

function cards(where: ReturnType<typeof and>) {
  return db
    .select(cardCols)
    .from(schema.jobTasks)
    .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(where)
    .orderBy(asc(schema.jobTasks.startTime), asc(schema.jobTasks.id));
}

type Card = Awaited<ReturnType<typeof cards>>[number];

/**
 * Everything the dashboard, the 7am email and the alerts need about crew work
 * on one Brisbane date: who is on today (with day N of M), what is late, and
 * what has a schedule nobody can read.
 */
export async function crewBoard(today: string = todayLocal(), opts: { lateSince?: string } = {}) {
  const hasDays = sql`exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id})`;
  const dayToday = sql`exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id} and d.date = ${today})`;

  const [onRows, lateRows, blankRows] = await Promise.all([
    // Candidates for today. The resolver has the final say.
    cards(
      and(
        ne(schema.jobTasks.status, "cancelled"),
        or(
          dayToday,
          and(sql`not ${hasDays}`, lte(schema.jobTasks.scheduledDate, today), sql`coalesce(${schema.jobTasks.scheduledTo}, ${schema.jobTasks.scheduledDate}) >= ${today}`),
        ),
      ),
    ),
    // Candidates for late: open, and something about them is in the past.
    cards(
      and(
        inArray(schema.jobTasks.status, [...ACTIVE_TASK]),
        or(
          lt(schema.jobTasks.scheduledDate, today),
          sql`exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id} and d.date < ${today})`,
        ),
      ),
    ),
    // Booked with no day rows: the resolver decides if the columns are enough.
    cards(and(inArray(schema.jobTasks.status, BOOKED), sql`not ${hasDays}`)),
  ]);

  const all = new Map<number, Card>();
  for (const r of [...onRows, ...lateRows, ...blankRows]) all.set(r.id, r);
  // Covered for incomplete-check: booked tasks whose days are all cancelled.
  const allCancelled = await db
    .select(cardCols)
    .from(schema.jobTasks)
    .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(
      and(
        inArray(schema.jobTasks.status, BOOKED),
        hasDays,
        sql`not exists (select 1 from ${schema.taskDays} d where d.task_id = ${schema.jobTasks.id} and d.status != 'cancelled')`,
      ),
    );
  for (const r of allCancelled) all.set(r.id, r);

  const dayRows = await dayRowsFor([...all.keys()]);
  const runs = new Map<number, TaskRun>();
  for (const [id, t] of all) runs.set(id, resolveRun(t, dayRows.get(id) ?? []));

  const coverIds = [...new Set([...runs.values()].flatMap((r) => [...r.coverOn.values()]))];
  const coverNames = new Map<number, string>();
  if (coverIds.length) {
    for (const i of await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, coverIds))) {
      coverNames.set(i.id, i.name);
    }
  }

  const strip = ({ scheduledFrom: _f, scheduledTo: _t, manualDays: _m, ...rest }: Card) => rest;

  const todayTasks = onRows
    .map((t) => {
      const run = runs.get(t.id)!;
      const d = dayOf(run, today);
      if (!d) return null;
      const cover = run.coverOn.get(today);
      return {
        ...strip(t),
        installerName: cover ? (coverNames.get(cover) ?? t.installerName) : t.installerName,
        daySeq: d.daySeq,
        dayCount: d.dayCount,
        dayLabel: dayLabel(d),
        scheduleIncomplete: d.incomplete,
        startDate: run.days[0] ?? run.windowFrom ?? t.scheduledDate,
        endDate: lastDayOf(run, t),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const since = opts.lateSince ?? null;
  const late = lateRows
    .map((t) => {
      const run = runs.get(t.id)!;
      if (!isLate(run, t, today)) return null;
      const lastDay = lastDayOf(run, t)!;
      if (since && lastDay < since) return null;
      return { ...strip(t), lastDay, dayCount: run.days.length || null, scheduleIncomplete: run.incomplete };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => (a.lastDay < b.lastDay ? -1 : a.lastDay > b.lastDay ? 1 : a.id - b.id));

  // Incomplete and not already shown in Today or late, so the office still sees it.
  const shown = new Set([...todayTasks.map((t) => t.id), ...late.map((t) => t.id)]);
  const incomplete = [...all.values()]
    .filter((t) => t.status !== "cancelled" && t.status !== "complete")
    .map((t) => ({ t, run: runs.get(t.id)! }))
    .filter(({ t, run }) => run.incomplete && !shown.has(t.id))
    .map(({ t, run }) => ({ ...strip(t), reason: run.incomplete! }));

  return { today, todayTasks, late, incomplete };
}
