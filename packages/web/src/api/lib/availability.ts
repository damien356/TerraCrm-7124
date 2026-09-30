import { and, eq, gte, inArray, isNull, lte, ne, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * The single source of truth for "can this installer work that day".
 * Every dispatch path — direct offer, broadcast, accept, drag-and-drop — runs
 * through here server-side, so a blocked day can't be booked from the UI.
 */
export async function blockedInstallerIds(date: string): Promise<Set<number>> {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const rows = await db
    .select({
      installerId: schema.installerUnavailability.installerId,
      kind: schema.installerUnavailability.kind,
      weekdayMask: schema.installerUnavailability.weekdayMask,
    })
    .from(schema.installerUnavailability)
    .where(
      or(
        eq(schema.installerUnavailability.kind, "recurring"),
        and(
          lte(schema.installerUnavailability.fromDate, date),
          gte(schema.installerUnavailability.toDate, date),
        ),
      ),
    );

  const blocked = new Set<number>();
  for (const r of rows) {
    if (r.kind === "recurring") {
      if (safeWeekdays(r.weekdayMask).includes(weekday)) blocked.add(r.installerId);
    } else {
      blocked.add(r.installerId);
    }
  }

  // Legacy per-installer weekday ticks on the installer card still count.
  const legacy = await db
    .select({ id: schema.installers.id, days: schema.installers.unavailableDays })
    .from(schema.installers);
  for (const l of legacy) {
    if (safeWeekdays(l.days).includes(weekday)) blocked.add(l.id);
  }
  return blocked;
}

/** Throws nothing — callers decide. Returns the reason if they're blocked. */
export async function blockedReason(installerId: number, date: string): Promise<string | null> {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const rows = await db
    .select()
    .from(schema.installerUnavailability)
    .where(eq(schema.installerUnavailability.installerId, installerId));
  for (const r of rows) {
    if (r.kind === "recurring") {
      if (safeWeekdays(r.weekdayMask).includes(weekday)) return r.reason || "Doesn't work that day";
    } else if (r.fromDate && r.toDate && r.fromDate <= date && date <= r.toDate) {
      return r.reason || "Booked out";
    }
  }
  return null;
}

export type DayStatus = "available" | "normally_unavailable" | "unavailable";

export type DayCheck = {
  date: string;
  status: DayStatus;
  /** Why the day is flagged, in the words the office wrote. */
  reason: string | null;
  /** Other work already on this installer that day. Never blocks, always shown. */
  clashes: { taskId: number; jobId: number; jobNumber: number; title: string; suburb: string }[];
};

/**
 * Per-date picture for one installer across a booking run: the standing day off
 * (a warning, he might still take it), a booked-out range (louder), and anything
 * already in his diary that day.
 *
 * Nothing here blocks a booking. The office can double book with a reason, they
 * just can't do it by accident, so every clash comes back to be shown.
 */
export async function checkDays(args: {
  installerId: number;
  dates: string[];
  /** The task being booked, so its own days don't read as a clash with itself. */
  exceptTaskId?: number | null;
}): Promise<DayCheck[]> {
  const { installerId, dates } = args;
  if (dates.length === 0) return [];

  const [rules, legacy, clashes] = await Promise.all([
    db.select().from(schema.installerUnavailability).where(eq(schema.installerUnavailability.installerId, installerId)),
    db.select({ days: schema.installers.unavailableDays }).from(schema.installers).where(eq(schema.installers.id, installerId)),
    bookedDays({ installerId, dates, exceptTaskId: args.exceptTaskId ?? null }),
  ]);
  const legacyOff = safeWeekdays(legacy[0]?.days);

  return dates.map((date) => {
    const weekday = new Date(`${date}T00:00:00`).getDay();
    let status: DayStatus = "available";
    let reason: string | null = null;

    if (legacyOff.includes(weekday)) {
      status = "normally_unavailable";
      reason = "Doesn't normally work that day";
    }
    for (const r of rules) {
      if (r.kind === "recurring") {
        if (safeWeekdays(r.weekdayMask).includes(weekday) && status === "available") {
          status = "normally_unavailable";
          reason = r.reason || "Doesn't normally work that day";
        }
      } else if (r.fromDate && r.toDate && r.fromDate <= date && date <= r.toDate) {
        // A dated blackout beats a standing day off: he has told us he is away.
        status = "unavailable";
        reason = r.reason || "Booked out";
      }
    }

    return { date, status, reason, clashes: clashes.filter((c) => c.date === date).map(({ date: _d, ...c }) => c) };
  });
}

/** Work already sitting on one installer across a set of dates. */
export async function bookedDays(args: {
  installerId: number;
  dates: string[];
  exceptTaskId?: number | null;
}): Promise<{ date: string; taskId: number; jobId: number; jobNumber: number; title: string; suburb: string }[]> {
  const { installerId, dates } = args;
  if (dates.length === 0) return [];
  const live = ["assigned", "in_progress"] as const;

  // Two sources: the day rows a booked run writes, and the single scheduled
  // date every task has carried since before runs existed.
  const [dayRows, taskRows] = await Promise.all([
    db
      .select({
        date: schema.taskDays.date,
        taskId: schema.jobTasks.id,
        jobId: schema.jobs.id,
        jobNumber: schema.jobs.number,
        title: schema.jobTasks.title,
        suburb: schema.sites.suburb,
      })
      .from(schema.taskDays)
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskDays.taskId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(
        and(
          inArray(schema.taskDays.date, dates),
          ne(schema.taskDays.status, "cancelled"),
          inArray(schema.jobTasks.status, [...live]),
          or(
            eq(schema.taskDays.installerId, installerId),
            and(isNull(schema.taskDays.installerId), eq(schema.jobTasks.assignedInstallerId, installerId)),
            and(isNull(schema.taskDays.installerId), eq(schema.jobTasks.secondInstallerId, installerId)),
          ),
        ),
      ),
    db
      .select({
        date: schema.jobTasks.scheduledDate,
        taskId: schema.jobTasks.id,
        jobId: schema.jobs.id,
        jobNumber: schema.jobs.number,
        title: schema.jobTasks.title,
        suburb: schema.sites.suburb,
      })
      .from(schema.jobTasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(
        and(
          inArray(schema.jobTasks.scheduledDate, dates),
          inArray(schema.jobTasks.status, [...live]),
          or(
            eq(schema.jobTasks.assignedInstallerId, installerId),
            eq(schema.jobTasks.secondInstallerId, installerId),
          ),
        ),
      ),
  ]);

  const seen = new Set<string>();
  const out: { date: string; taskId: number; jobId: number; jobNumber: number; title: string; suburb: string }[] = [];
  for (const r of [...dayRows, ...taskRows]) {
    if (!r.date) continue;
    if (args.exceptTaskId && r.taskId === args.exceptTaskId) continue;
    const key = `${r.taskId}:${r.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...r, date: r.date, suburb: r.suburb ?? "" });
  }
  return out;
}

/**
 * The weekdays one installer never works, so a run can step over them instead
 * of landing three of its five days on a weekend nobody turns up for.
 */
export async function nonWorkingWeekdays(installerId: number): Promise<number[]> {
  const [rules, legacy] = await Promise.all([
    db
      .select({ kind: schema.installerUnavailability.kind, weekdayMask: schema.installerUnavailability.weekdayMask })
      .from(schema.installerUnavailability)
      .where(eq(schema.installerUnavailability.installerId, installerId)),
    db.select({ days: schema.installers.unavailableDays }).from(schema.installers).where(eq(schema.installers.id, installerId)),
  ]);
  const out = new Set<number>(safeWeekdays(legacy[0]?.days));
  for (const r of rules) {
    if (r.kind === "recurring") for (const d of safeWeekdays(r.weekdayMask)) out.add(d);
  }
  return [...out].sort();
}

export function safeWeekdays(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}
