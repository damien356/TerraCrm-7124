import { jobNumberSql, taskRefSql } from "../lib/job-ref";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { expireStale } from "./offers";
import { addLocalDays, todayLocal } from "../lib/local-date";
import { crewBoard } from "../lib/task-run";

/** The office's morning screen: what's on today, what's not filled, what's at risk. */
export const dashboard = {
  summary: staffOnly.handler(async () => {
    await expireStale();

    // Business dates are Brisbane dates, never the server's UTC date.
    const today = todayLocal();
    const weekEnd = addLocalDays(today, 7);

    const [board, unfilled, pendingOffers, counts, revenue, recent] = await Promise.all([
      // Today, late and incomplete come from one rule (lib/task-run.ts),
      // the same one the 7am email uses.
      crewBoard(today),

      // Scheduled inside the next week but still nobody on it.
      db
        .select({
          id: schema.jobTasks.id,
          title: schema.jobTasks.title,
          scheduledDate: schema.jobTasks.scheduledDate,
          crewSize: schema.jobTasks.crewSize,
          skillName: schema.skills.name,
          jobNumber: jobNumberSql,
          ref: taskRefSql,
          siteSuburb: schema.sites.suburb,
          furnitureOnSite: schema.jobs.furnitureOnSite,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(
          and(
            isNull(schema.jobTasks.assignedInstallerId),
            inArray(schema.jobTasks.status, ["unassigned", "offered"]),
            or(
              isNull(schema.jobTasks.scheduledDate),
              and(gte(schema.jobTasks.scheduledDate, today), lte(schema.jobTasks.scheduledDate, weekEnd)),
            ),
          ),
        )
        .orderBy(asc(schema.jobTasks.scheduledDate)),

      db
        .select({
          id: schema.taskOffers.id,
          taskId: schema.taskOffers.taskId,
          mode: schema.taskOffers.mode,
          expiresAt: schema.taskOffers.expiresAt,
          payAmount: schema.taskOffers.payAmount,
          installerName: schema.installers.name,
          taskTitle: schema.jobTasks.title,
          jobNumber: jobNumberSql,
          ref: taskRefSql,
        })
        .from(schema.taskOffers)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
        .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .where(eq(schema.taskOffers.status, "pending"))
        .orderBy(asc(schema.taskOffers.expiresAt))
        .limit(20),

      db
        .select({
          openJobs: sql<number>`sum(case when coalesce(s.stage, 'open') not in ('complete','closed') then 1 else 0 end)`,
          leads: sql<number>`sum(case when coalesce(s.stage, 'open') = 'open' then 1 else 0 end)`,
          scheduled: sql<number>`sum(case when coalesce(s.stage, 'open') in ('scheduled','active') then 1 else 0 end)`,
        })
        .from(sql`${schema.jobs} j`)
        .leftJoin(sql`${schema.jobStatuses} s`, sql`s.id = j.status_id`),

      // Value of work that came in over the last 30 days. created_at cannot
      // be trusted on its own: the ServiceM8 import stamped all 4,219 history
      // jobs with the day it ran, which counted ten years of work as last
      // month's and showed about $26M. An imported job has no real "came in"
      // date, so it goes by its own scheduled or completed day instead. A job
      // made in Terra Ops goes by created_at as normal. Capped at now so a
      // booking in the future is not counted as work already in.
      db
        .select({
          weekValue: sql<number>`coalesce(sum(${schema.jobs.value}), 0)`,
        })
        .from(schema.jobs)
        .where(
          sql`(case when ${schema.jobs.externalRef} is null then ${schema.jobs.createdAt}
                else coalesce(${schema.jobs.scheduledStart}, ${schema.jobs.completedAt}, ${schema.jobs.createdAt}) end)
              between ${Math.floor((Date.now() - 30 * 86400_000) / 1000)} and ${Math.floor(Date.now() / 1000)}`,
        ),

      db
        .select()
        .from(schema.activityLog)
        // Phone crash reports have their own list under Team.
        .where(ne(schema.activityLog.entityType, "app_problem"))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(15),
    ]);

    const todayTasks = board.todayTasks;
    // Past the final working day and still open. scheduledDate stays the
    // last working day here so the web card reads the right date.
    const atRisk = board.late.slice(0, 20).map((t) => ({ ...t, scheduledDate: t.lastDay }));
    return {
      today,
      todayTasks,
      unfilled,
      pendingOffers,
      atRisk,
      scheduleIncomplete: board.incomplete,
      counts: {
        openJobs: Number(counts[0]?.openJobs ?? 0),
        leads: Number(counts[0]?.leads ?? 0),
        scheduled: Number(counts[0]?.scheduled ?? 0),
      },
      pipelineValue: Number(revenue[0]?.weekValue ?? 0),
      recent,
    };
  }),
};
