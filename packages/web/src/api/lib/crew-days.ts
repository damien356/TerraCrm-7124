import { and, asc, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Which days an installer is booked on which task.
 *
 * A three day lay is one task with three `task_days` rows, so "what am I on
 * today" cannot be answered from `job_tasks.scheduled_date`, which is only day
 * one. Older tasks booked before task days existed have no rows at all, and
 * for those the scheduled date is the only day.
 *
 * Covers (a task day handed to someone other than the task's own installer)
 * are left out on purpose: every crew write goes through `ownTaskOrThrow`,
 * which only lets the task's own installers in.
 */
export interface WorkDay {
  taskId: number;
  date: string;
  /** 1-based, for "day 2 of 3". */
  daySeq: number;
  dayCount: number;
  arrivalStart: string | null;
  arrivalEnd: string | null;
  coordinate: boolean;
}

const mine = (installerId: number) =>
  sql`(${schema.jobTasks.assignedInstallerId} = ${installerId} or ${schema.jobTasks.secondInstallerId} = ${installerId})`;

export async function workDaysFor(
  installerId: number,
  from: string,
  to: string,
  statuses: string[] = ["assigned", "in_progress"],
): Promise<WorkDay[]> {
  const tasks = await db
    .select({ id: schema.jobTasks.id, scheduledDate: schema.jobTasks.scheduledDate })
    .from(schema.jobTasks)
    .where(and(mine(installerId), inArray(schema.jobTasks.status, statuses)));
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);

  const days = await db
    .select()
    .from(schema.taskDays)
    .where(and(inArray(schema.taskDays.taskId, ids), ne(schema.taskDays.status, "cancelled")))
    .orderBy(asc(schema.taskDays.date));

  const byTask = new Map<number, (typeof days)[number][]>();
  for (const d of days) {
    if (!byTask.has(d.taskId)) byTask.set(d.taskId, []);
    byTask.get(d.taskId)!.push(d);
  }

  const out: WorkDay[] = [];
  for (const t of tasks) {
    const run = byTask.get(t.id);
    if (run && run.length) {
      run.forEach((d, i) => {
        if (d.date < from || d.date > to) return;
        if (d.installerId && d.installerId !== installerId) return;
        out.push({
          taskId: t.id,
          date: d.date,
          daySeq: i + 1,
          dayCount: run.length,
          arrivalStart: d.arrivalStart,
          arrivalEnd: d.arrivalEnd,
          coordinate: d.coordinate,
        });
      });
    } else if (t.scheduledDate && t.scheduledDate >= from && t.scheduledDate <= to) {
      out.push({
        taskId: t.id,
        date: t.scheduledDate,
        daySeq: 1,
        dayCount: 1,
        arrivalStart: null,
        arrivalEnd: null,
        coordinate: false,
      });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
}

/** Task ids this installer is booked on for one date. */
export async function taskIdsOn(installerId: number, date: string, statuses?: string[]) {
  return [...new Set((await workDaysFor(installerId, date, date, statuses)).map((d) => d.taskId))];
}
