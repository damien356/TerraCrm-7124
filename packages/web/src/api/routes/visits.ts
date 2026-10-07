import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { crewVoice } from "../middleware/voice";
import { ownTaskOrThrow } from "./field";
import { workDaysFor } from "../lib/crew-days";
import { briefFor, sayPlace } from "../lib/crew-brief";
import { addLocalDays, todayLocal } from "../lib/local-date";
import { arrive, FLAG_NO_PHOTOS, leave, saneInstant, siteCircleMetres } from "../lib/site-visits";

/* ---------------------------------------------------------------------------
 * ARRIVED AND LEFT SITE.
 *
 * The phone watches a circle round today's and tomorrow's sites and calls
 * `enter` and `leave` when it crosses one. An installer who will not give the
 * app "Always" location taps the same two buttons by hand. Either way the
 * deciding happens in lib/site-visits: what counts as a visit, who hears, and
 * the every-day completion photo rule.
 *
 * Arriving only stamps Arrived. It never starts the task, the damage walk and
 * the Start tap stay with the installer.
 * ------------------------------------------------------------------------- */

const SOURCES = ["geofence", "manual"] as const;
const LIVE = ["assigned", "in_progress"];

const eventInput = z.object({
  taskId: z.number().int(),
  /** When the phone saw it. Queued events arrive late, the server keeps it sane. */
  at: z.string().nullable().optional(),
  source: z.enum(SOURCES).default("manual"),
});

/** Actions the Crew updates feed shows. Everything else in the log is noise here. */
const FEED_ACTIONS = [
  "site_arrived",
  "site_left",
  "site_left_no_photos",
  "voice_late_client",
  "voice_late_client_failed",
  "voice_late_office",
  "voice_call",
  "field_note",
  "sms_reply",
  "sms_opt_out",
] as const;

function visitView(v: typeof schema.siteVisits.$inferSelect) {
  return {
    id: v.id,
    taskId: v.taskId,
    jobId: v.jobId,
    installerId: v.installerId,
    visitDate: v.visitDate,
    arrivedAt: v.arrivedAt,
    leftAt: v.leftAt,
    arriveSource: v.arriveSource,
    leaveSource: v.leaveSource,
    voided: Boolean(v.voidedAt),
    voidReason: v.voidReason,
    /** Red on the Ops view while true. */
    flagged: v.flag === FLAG_NO_PHOTOS && !v.flagClearedAt,
    flag: v.flag,
    flagClearedAt: v.flagClearedAt,
    flagClearedReason: v.flagClearedReason,
    photosHad: v.photosHad,
    photosNeeded: v.photosNeeded,
  };
}

export const visits = {
  /* ------------------------------ the phone ------------------------------ */

  /**
   * What to watch: every site this installer is booked at today or tomorrow,
   * with the circle size. The phone geocodes the address itself, sites have no
   * stored coordinates. Tomorrow is included so an early start before the app
   * has refreshed still has its fence.
   */
  targets: crewVoice.handler(async ({ context }) => {
    const today = todayLocal();
    const days = await workDaysFor(context.installerId, today, addLocalDays(today, 1), LIVE);
    const radiusM = await siteCircleMetres();
    const seen = new Set<string>();
    const out: {
      taskId: number;
      jobId: number;
      date: string;
      label: string;
      destination: string | null;
      radiusM: number;
    }[] = [];
    for (const d of days) {
      const key = `${d.taskId}:${d.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = await briefFor(d.taskId);
      if (!b) continue;
      out.push({ taskId: b.taskId, jobId: b.jobId, date: d.date, label: sayPlace(b), destination: b.destination, radiusM });
    }
    const open = await db
      .select()
      .from(schema.siteVisits)
      .where(
        and(
          eq(schema.siteVisits.installerId, context.installerId),
          isNull(schema.siteVisits.leftAt),
          isNull(schema.siteVisits.voidedAt),
        ),
      );
    return { today, radiusM, targets: out, openVisits: open.map(visitView) };
  }),

  /** Crossed into the circle, or tapped Arrived. */
  enter: crewVoice.input(eventInput).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);
    if (!LIVE.includes(task.status)) {
      return { outcome: "task_closed" as const, message: "That task is already finished or cancelled." };
    }
    const at = saneInstant(input.at);
    if (input.source === "geofence") {
      /* A fence only counts on a day they are booked there. Driving past
       * Thursday's job on a Tuesday is not a visit. */
      const today = todayLocal();
      const booked = await workDaysFor(context.installerId, today, today, LIVE);
      if (!booked.some((d) => d.taskId === task.id)) {
        return { outcome: "not_booked_today" as const, message: "Not booked there today, ignored." };
      }
    }
    const r = await arrive({ taskId: task.id, jobId: task.jobId, installerId: context.installerId, at, source: input.source });
    return { outcome: r.outcome, visit: visitView(r.visit) };
  }),

  /** Crossed out of the circle, or tapped Left site. */
  leave: crewVoice.input(eventInput).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);
    const r = await leave({ taskId: input.taskId, installerId: context.installerId, at: saneInstant(input.at), source: input.source });
    if (r.outcome === "not_here") return { outcome: r.outcome, flagged: false, message: "You weren't marked on site." };
    if (r.outcome === "drive_past") return { outcome: r.outcome, flagged: false, visit: visitView(r.visit) };
    return {
      outcome: r.outcome,
      flagged: r.flagged,
      photosHad: r.photosHad,
      photosNeeded: r.photosNeeded,
      visit: visitView(r.visit),
      message: r.flagged
        ? `Today's completion photos are still needed (${r.photosHad} of ${r.photosNeeded}).`
        : "Left site.",
    };
  }),

  /** For the job card: am I on site, and is anything red today. */
  mine: crewVoice.input(z.object({ taskId: z.number().int() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);
    const rows = await db
      .select()
      .from(schema.siteVisits)
      .where(
        and(
          eq(schema.siteVisits.taskId, input.taskId),
          eq(schema.siteVisits.installerId, context.installerId),
          isNull(schema.siteVisits.voidedAt),
        ),
      )
      .orderBy(desc(schema.siteVisits.arrivedAt))
      .limit(20);
    const v = rows.map(visitView);
    return {
      onSite: v.some((x) => !x.leftAt),
      flaggedDates: [...new Set(v.filter((x) => x.flagged).map((x) => x.visitDate))],
      visits: v,
    };
  }),

  /* ------------------------------ the office ----------------------------- */

  /**
   * The Crew updates feed for the dashboard: who is on site now, every red
   * photo flag still open, and the last few days of crew messages.
   */
  feed: staffOnly
    .input(z.object({ days: z.number().int().min(1).max(30).default(3), limit: z.number().int().min(1).max(200).default(60) }).default({ days: 3, limit: 60 }))
    .handler(async ({ input }) => {
      const since = new Date(Date.now() - input.days * 86_400_000);

      const visitCols = {
        visit: schema.siteVisits,
        installerName: schema.installers.name,
        jobNumber: jobNumberSql,
        jobTitle: schema.jobs.title,
        taskTitle: schema.jobTasks.title,
        suburb: schema.sites.suburb,
      };
      const onSiteRows = await db
        .select(visitCols)
        .from(schema.siteVisits)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.siteVisits.installerId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.siteVisits.jobId))
        .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.siteVisits.taskId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(and(isNull(schema.siteVisits.leftAt), isNull(schema.siteVisits.voidedAt), gte(schema.siteVisits.arrivedAt, new Date(Date.now() - 18 * 3600_000))))
        .orderBy(desc(schema.siteVisits.arrivedAt));

      const flagRows = await db
        .select(visitCols)
        .from(schema.siteVisits)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.siteVisits.installerId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.siteVisits.jobId))
        .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.siteVisits.taskId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(
          and(
            eq(schema.siteVisits.flag, FLAG_NO_PHOTOS),
            isNull(schema.siteVisits.flagClearedAt),
            isNull(schema.siteVisits.voidedAt),
            isNotNull(schema.siteVisits.leftAt),
          ),
        )
        .orderBy(desc(schema.siteVisits.leftAt))
        .limit(50);

      const shapeVisit = (r: (typeof onSiteRows)[number]) => ({
        ...visitView(r.visit),
        installerName: r.installerName,
        jobNumber: r.jobNumber,
        jobTitle: r.jobTitle,
        taskTitle: r.taskTitle,
        suburb: r.suburb,
      });

      const events = await db
        .select({
          id: schema.activityLog.id,
          jobId: schema.activityLog.jobId,
          taskId: schema.activityLog.taskId,
          action: schema.activityLog.action,
          detail: schema.activityLog.detail,
          actorName: schema.activityLog.actorName,
          actorRole: schema.activityLog.actorRole,
          createdAt: schema.activityLog.createdAt,
          jobNumber: jobNumberSql,
          jobTitle: schema.jobs.title,
        })
        .from(schema.activityLog)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.activityLog.jobId))
        .where(
          and(
            inArray(schema.activityLog.action, [...FEED_ACTIONS]),
            gte(schema.activityLog.createdAt, since),
            /* Office notes are office business. Crew notes and client replies only. */
            sql`(${schema.activityLog.action} != 'field_note' or ${schema.activityLog.actorRole} = 'installer')`,
          ),
        )
        .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id))
        .limit(input.limit);

      return {
        onSite: onSiteRows.map(shapeVisit),
        flags: flagRows.map(shapeVisit),
        events: events.map((e) => ({
          ...e,
          tone:
            e.action === "site_left_no_photos" || e.action === "voice_late_client_failed"
              ? ("red" as const)
              : e.action.startsWith("voice_late") || e.action === "sms_reply" || e.action === "sms_opt_out"
                ? ("amber" as const)
                : ("plain" as const),
        })),
      };
    }),

  /** Every visit on one job, for the job page. Voided drive-pasts included, marked as such. */
  forJob: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input }) => {
    const rows = await db
      .select({ visit: schema.siteVisits, installerName: schema.installers.name, taskTitle: schema.jobTasks.title })
      .from(schema.siteVisits)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.siteVisits.installerId))
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.siteVisits.taskId))
      .where(eq(schema.siteVisits.jobId, input.jobId))
      .orderBy(desc(schema.siteVisits.arrivedAt))
      .limit(200);
    return rows.map((r) => ({ ...visitView(r.visit), installerName: r.installerName, taskTitle: r.taskTitle }));
  }),
};
