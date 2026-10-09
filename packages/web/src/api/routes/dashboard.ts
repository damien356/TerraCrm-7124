import { jobNumberSql, taskRefSql } from "../lib/job-ref";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { expireStale } from "./offers";

const day = (offset = 0) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);

/** The office's morning screen: what's on today, what's not filled, what's at risk. */
export const dashboard = {
  summary: staffOnly.handler(async () => {
    await expireStale();

    const today = day(0);
    const weekEnd = day(7);

    const [todayTasks, unfilled, pendingOffers, atRisk, counts, revenue, recent] = await Promise.all([
      db
        .select({
          id: schema.jobTasks.id,
          title: schema.jobTasks.title,
          startTime: schema.jobTasks.startTime,
          status: schema.jobTasks.status,
          crewSize: schema.jobTasks.crewSize,
          installerName: schema.installers.name,
          installerColour: schema.installers.colour,
          skillName: schema.skills.name,
          jobNumber: jobNumberSql,
          ref: taskRefSql,
          siteAddress: schema.sites.address,
          siteSuburb: schema.sites.suburb,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(and(eq(schema.jobTasks.scheduledDate, today), sql`${schema.jobTasks.status} != 'cancelled'`))
        .orderBy(asc(schema.jobTasks.startTime)),

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

      // Tasks whose day has passed but were never finished.
      db
        .select({
          id: schema.jobTasks.id,
          title: schema.jobTasks.title,
          scheduledDate: schema.jobTasks.scheduledDate,
          status: schema.jobTasks.status,
          installerName: schema.installers.name,
          jobNumber: jobNumberSql,
          ref: taskRefSql,
          siteSuburb: schema.sites.suburb,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(
          and(
            lte(schema.jobTasks.scheduledDate, day(-1)),
            inArray(schema.jobTasks.status, ["unassigned", "offered", "assigned", "in_progress"]),
          ),
        )
        .orderBy(asc(schema.jobTasks.scheduledDate))
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
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(15),
    ]);

    return {
      today,
      todayTasks,
      unfilled,
      pendingOffers,
      atRisk,
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
