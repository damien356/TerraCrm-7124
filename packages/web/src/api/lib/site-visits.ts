import { jobNumberSql } from "./job-ref";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import { localDate, localDayBounds } from "./local-date";
import { pushToInstaller, pushToOffice } from "./push";

/* ---------------------------------------------------------------------------
 * Site visits: arrived, left, and the every-day completion photo rule.
 *
 * The phone tells us when it crossed the circle round a site. The server does
 * the deciding: whether a visit is real (more than 5 minutes inside), whether
 * the office hears about it, and whether leaving broke the photo rule.
 *
 * THE PHOTO RULE. Every day on site needs that day's completion photos, so on
 * a multi-day job the progress shots go in each evening. Leaving without them
 * does not stop anything, a phone cannot stop a ute. It stamps the visit, tells
 * the installer, and shows red for the office. The flag clears itself when the
 * photos for that day turn up, or when they come back to site the same day.
 * Marking the task complete is still gated separately in `field.complete`.
 * ------------------------------------------------------------------------- */

/** A geofence visit shorter than this was a drive past, not a visit. */
export const MIN_VISIT_MS = 5 * 60_000;
export const FLAG_NO_PHOTOS = "left_without_completion_photos";

/** Radius of the circle round each site, in metres. Settings key `site_circle_m`. */
export async function siteCircleMetres(): Promise<number> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, "site_circle_m"));
  const n = Number(row?.value);
  if (!Number.isFinite(n) || n <= 0) return 150;
  return Math.min(1000, Math.max(100, Math.round(n)));
}

/** How many completion photos this task's trade demands. Same number every day. */
export async function minCompletionPhotos(skillId: number | null) {
  if (!skillId) return 4;
  const [skill] = await db
    .select({ n: schema.skills.minCompletionPhotos })
    .from(schema.skills)
    .where(eq(schema.skills.id, skillId));
  return skill?.n ?? 4;
}

/** Completion photos on this task taken on one Gold Coast day, by anyone on the crew. */
export async function completionPhotosOn(taskId: number, date: string) {
  const { start, end } = localDayBounds(date);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.jobMedia)
    .where(
      and(
        eq(schema.jobMedia.taskId, taskId),
        eq(schema.jobMedia.bucket, "completion"),
        isNull(schema.jobMedia.archivedAt),
        gte(schema.jobMedia.capturedAt, start),
        lt(schema.jobMedia.capturedAt, end),
      ),
    );
  return Number(row?.n ?? 0);
}

/** A phone's clock can be off, and a queued event can arrive late. Keep it sane. */
export function saneInstant(at: Date | string | number | null | undefined): Date {
  const now = Date.now();
  if (at == null) return new Date(now);
  const t = new Date(at).getTime();
  if (!Number.isFinite(t) || t > now + 2 * 60_000 || t < now - 24 * 3600_000) return new Date(now);
  return new Date(t);
}

type Visit = typeof schema.siteVisits.$inferSelect;

async function installerName(installerId: number) {
  const [row] = await db
    .select({ name: schema.installers.name })
    .from(schema.installers)
    .where(eq(schema.installers.id, installerId));
  return row?.name ?? "Installer";
}

async function taskSummary(taskId: number) {
  const [row] = await db
    .select({
      id: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      title: schema.jobTasks.title,
      skillId: schema.jobTasks.skillId,
      status: schema.jobTasks.status,
      damageCheckedAt: schema.jobTasks.damageCheckedAt,
      damageNone: schema.jobTasks.damageNone,
      jobNumber: jobNumberSql,
      jobTitle: schema.jobs.title,
      suburb: schema.sites.suburb,
    })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobTasks.id, taskId));
  return row ?? null;
}

/** Job titles are mostly imported junk ("pick up from:"), so name the place by suburb. */
const placeOf = (t: { suburb: string | null; jobNumber: number | string }) =>
  t.suburb?.trim() ? `the ${t.suburb.trim()} site` : `job #${t.jobNumber}`;

async function openVisit(taskId: number, installerId: number) {
  const [row] = await db
    .select()
    .from(schema.siteVisits)
    .where(
      and(
        eq(schema.siteVisits.taskId, taskId),
        eq(schema.siteVisits.installerId, installerId),
        isNull(schema.siteVisits.leftAt),
        isNull(schema.siteVisits.voidedAt),
      ),
    )
    .orderBy(desc(schema.siteVisits.arrivedAt))
    .limit(1);
  return row ?? null;
}

async function clearFlags(taskId: number, installerId: number | null, date: string, reason: string) {
  const where = [
    eq(schema.siteVisits.taskId, taskId),
    eq(schema.siteVisits.visitDate, date),
    eq(schema.siteVisits.flag, FLAG_NO_PHOTOS),
    isNull(schema.siteVisits.flagClearedAt),
  ];
  if (installerId) where.push(eq(schema.siteVisits.installerId, installerId));
  const cleared = await db
    .update(schema.siteVisits)
    .set({ flagClearedAt: new Date(), flagClearedReason: reason, updatedAt: new Date() })
    .where(and(...where))
    .returning({ id: schema.siteVisits.id });
  return cleared.length;
}

/**
 * Tell the office once that someone has arrived, and nudge the installer about
 * the damage walk. Runs 5 minutes after a geofence arrival so a drive past
 * says nothing, straight away for a hand tapped one, and as a catch up when
 * the visit closes in case the server restarted in between.
 */
export async function announceArrival(visitId: number) {
  const [v] = await db.select().from(schema.siteVisits).where(eq(schema.siteVisits.id, visitId));
  if (!v || v.announcedAt || v.voidedAt) return false;
  if (v.arriveSource === "geofence") {
    const end = v.leftAt ? v.leftAt.getTime() : Date.now();
    if (end - v.arrivedAt.getTime() < MIN_VISIT_MS) return false;
  }
  const [claimed] = await db
    .update(schema.siteVisits)
    .set({ announcedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.siteVisits.id, visitId), isNull(schema.siteVisits.announcedAt)))
    .returning({ id: schema.siteVisits.id });
  if (!claimed) return false;

  const task = await taskSummary(v.taskId);
  if (!task) return false;
  const who = await installerName(v.installerId);
  const how = v.arriveSource === "geofence" ? "" : " (tapped by hand)";
  await db.insert(schema.activityLog).values({
    jobId: task.jobId,
    taskId: task.id,
    entityType: "task",
    entityId: task.id,
    action: "site_arrived",
    detail: `${who} arrived at ${placeOf(task)}${how}`,
    actorName: who,
    actorRole: "installer",
    createdAt: v.arrivedAt,
  });

  if (!v.leftAt) {
    void pushToOffice({
      title: "Crew on site",
      body: `${who} arrived at ${placeOf(task)}`,
      data: { kind: "task", taskId: task.id, jobId: task.jobId },
    });
    if (task.status === "assigned" && !task.damageCheckedAt && !task.damageNone) {
      void pushToInstaller(v.installerId, {
        title: "You're at the site",
        body: "Do the damage walk before you start.",
        data: { kind: "task", taskId: task.id },
      });
    }
  }
  return true;
}

/* Keyed by database as well as visit id. The Play reviewer's demo numbers its
 * visits from 1 too, and its timer must never cancel a real crew member's. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const timerKey = (visitId: number) => `${inDemo() ? "demo" : "live"}:${visitId}`;

export async function arrive(args: {
  taskId: number;
  jobId: number;
  installerId: number;
  at: Date;
  source: "geofence" | "manual";
}): Promise<{ visit: Visit; outcome: "already_here" | "came_back" | "arrived" }> {
  const existing = await openVisit(args.taskId, args.installerId);
  if (existing) return { visit: existing, outcome: "already_here" };

  /* Stepped back over the line for a minute, GPS jitter at the edge, or a
   * quick trip to the ute. Same visit, carry on. */
  const [recent] = await db
    .select()
    .from(schema.siteVisits)
    .where(
      and(
        eq(schema.siteVisits.taskId, args.taskId),
        eq(schema.siteVisits.installerId, args.installerId),
        isNull(schema.siteVisits.voidedAt),
        gte(schema.siteVisits.leftAt, new Date(args.at.getTime() - MIN_VISIT_MS)),
      ),
    )
    .orderBy(desc(schema.siteVisits.leftAt))
    .limit(1);

  const date = localDate(args.at);
  if (recent && recent.visitDate === date) {
    const [reopened] = await db
      .update(schema.siteVisits)
      .set({ leftAt: null, leaveSource: null, updatedAt: new Date() })
      .where(eq(schema.siteVisits.id, recent.id))
      .returning();
    await clearFlags(args.taskId, args.installerId, date, "came back to site");
    return { visit: reopened!, outcome: "came_back" };
  }

  const [visit] = await db
    .insert(schema.siteVisits)
    .values({
      taskId: args.taskId,
      jobId: args.jobId,
      installerId: args.installerId,
      visitDate: date,
      arrivedAt: args.at,
      arriveSource: args.source,
    })
    .returning();

  /* Came back later the same day, e.g. after lunch. The earlier departure
   * was not the end of the day after all. */
  await clearFlags(args.taskId, args.installerId, date, "came back to site");

  if (args.source === "manual") {
    await announceArrival(visit!.id);
  } else {
    const wait = Math.max(0, args.at.getTime() + MIN_VISIT_MS - Date.now()) + 1000;
    const key = timerKey(visit!.id);
    const timer = setTimeout(() => {
      timers.delete(key);
      void announceArrival(visit!.id).catch((e) => console.error("[visits] announce failed", e));
    }, wait);
    timers.set(key, timer);
  }
  return { visit: visit!, outcome: "arrived" };
}

export type LeaveOutcome =
  | { outcome: "not_here" }
  | { outcome: "drive_past"; visit: Visit }
  | { outcome: "left"; visit: Visit; photosHad: number; photosNeeded: number; flagged: boolean };

export async function leave(args: {
  taskId: number;
  installerId: number;
  at: Date;
  source: "geofence" | "manual";
}): Promise<LeaveOutcome> {
  const open = await openVisit(args.taskId, args.installerId);
  if (!open) return { outcome: "not_here" };
  const at = args.at < open.arrivedAt ? new Date() : args.at;

  if (open.arriveSource === "geofence" && args.source === "geofence" && at.getTime() - open.arrivedAt.getTime() < MIN_VISIT_MS) {
    const t = timers.get(timerKey(open.id));
    if (t) clearTimeout(t);
    timers.delete(timerKey(open.id));
    const [voided] = await db
      .update(schema.siteVisits)
      .set({
        leftAt: at,
        leaveSource: args.source,
        voidedAt: new Date(),
        voidReason: "Inside the circle under 5 minutes, so not counted",
        updatedAt: new Date(),
      })
      .where(eq(schema.siteVisits.id, open.id))
      .returning();
    return { outcome: "drive_past", visit: voided! };
  }

  const task = await taskSummary(open.taskId);
  const need = await minCompletionPhotos(task?.skillId ?? null);
  const had = await completionPhotosOn(open.taskId, open.visitDate);
  /* A finished task already passed the completion gate. */
  const flagged = Boolean(task && task.status !== "complete" && had < need);

  const [closed] = await db
    .update(schema.siteVisits)
    .set({
      leftAt: at,
      leaveSource: args.source,
      photosHad: had,
      photosNeeded: need,
      flag: flagged ? FLAG_NO_PHOTOS : null,
      flagClearedAt: null,
      flagClearedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.siteVisits.id, open.id))
    .returning();

  const t = timers.get(timerKey(open.id));
  if (t) clearTimeout(t);
  timers.delete(timerKey(open.id));
  await announceArrival(open.id);

  if (task) {
    const who = await installerName(args.installerId);
    const mins = Math.round((at.getTime() - open.arrivedAt.getTime()) / 60_000);
    await db.insert(schema.activityLog).values({
      jobId: task.jobId,
      taskId: task.id,
      entityType: "task",
      entityId: task.id,
      action: flagged ? "site_left_no_photos" : "site_left",
      detail: flagged
        ? `${who} left ${placeOf(task)} without today's completion photos (${had} of ${need}), on site ${mins} min`
        : `${who} left ${placeOf(task)}, on site ${mins} min`,
      actorName: who,
      actorRole: "installer",
      createdAt: at,
    });
    if (flagged) {
      void pushToInstaller(args.installerId, {
        title: "Photos still needed",
        body: `Your ${placeOf(task)} job still needs today's completion photos (${had} of ${need}).`,
        data: { kind: "task", taskId: task.id },
      });
    }
  }

  return { outcome: "left", visit: closed!, photosHad: had, photosNeeded: need, flagged };
}

/**
 * Called after a completion photo lands. If that day's count now meets the
 * rule, any red flag on that day's visits clears itself.
 */
export async function recheckPhotoFlags(taskId: number, capturedAt: Date = new Date()) {
  const date = localDate(capturedAt);
  const [flagged] = await db
    .select({ id: schema.siteVisits.id })
    .from(schema.siteVisits)
    .where(
      and(
        eq(schema.siteVisits.taskId, taskId),
        eq(schema.siteVisits.visitDate, date),
        eq(schema.siteVisits.flag, FLAG_NO_PHOTOS),
        isNull(schema.siteVisits.flagClearedAt),
      ),
    )
    .limit(1);
  if (!flagged) return 0;
  const task = await taskSummary(taskId);
  const need = await minCompletionPhotos(task?.skillId ?? null);
  const had = await completionPhotosOn(taskId, date);
  if (had < need) return 0;
  return clearFlags(taskId, null, date, "photos added");
}
