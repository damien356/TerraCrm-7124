import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";

/**
 * THE CREW MAP. Where everyone is, while they're on a job.
 *
 * Deliberate limits, agreed with Damien: positions are only ever recorded
 * while a task is in progress, only for installers who switched sharing on
 * themselves, and a pin drops off the map once it goes stale. There is no
 * after-hours tracking and no history browsing here.
 */

/** A pin older than this isn't "live" any more. */
const LIVE_MINUTES = 45;

export const crew = {
  /** Everyone on the clock right now, with their last known position. */
  live: staffOnly
    .input(z.object({ staleMinutes: z.number().min(5).max(240).default(LIVE_MINUTES) }).default({ staleMinutes: LIVE_MINUTES }))
    .handler(async ({ input }) => {
      const cutoff = new Date(Date.now() - input.staleMinutes * 60_000);

      // Latest ping per installer inside the window. The alias must not be
      // "captured_at": drizzle references it unqualified in the join, and that
      // name also exists on installer_locations, so SQLite refused the query
      // as ambiguous and the crew map and the phone's "On site now" 500'd.
      const latest = db
        .select({
          installerId: schema.installerLocations.installerId,
          capturedAt: sql<number>`max(${schema.installerLocations.capturedAt})`.as("latest_captured_at"),
        })
        .from(schema.installerLocations)
        .where(gte(schema.installerLocations.capturedAt, cutoff))
        .groupBy(schema.installerLocations.installerId)
        .as("latest");

      const rows = await db
        .select({
          installerId: schema.installers.id,
          installerName: schema.installers.name,
          installerColour: schema.installers.colour,
          mobile: schema.installers.mobile,
          lat: schema.installerLocations.lat,
          lng: schema.installerLocations.lng,
          accuracy: schema.installerLocations.accuracy,
          speed: schema.installerLocations.speed,
          capturedAt: schema.installerLocations.capturedAt,
          taskId: schema.jobTasks.id,
          taskTitle: schema.jobTasks.title,
          taskStatus: schema.jobTasks.status,
          startedAt: schema.jobTasks.startedAt,
          jobNumber: jobNumberSql,
          jobTitle: schema.jobs.title,
          siteAddress: schema.sites.address,
          siteSuburb: schema.sites.suburb,
        })
        .from(schema.installerLocations)
        .innerJoin(
          latest,
          and(
            eq(latest.installerId, schema.installerLocations.installerId),
            eq(latest.capturedAt, schema.installerLocations.capturedAt),
          ),
        )
        .innerJoin(schema.installers, eq(schema.installers.id, schema.installerLocations.installerId))
        .leftJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.installerLocations.taskId))
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .orderBy(desc(schema.installerLocations.capturedAt));

      // Dedupe defensively — two pings can share the same second.
      const seen = new Set<number>();
      return rows.filter((r) => {
        if (seen.has(r.installerId)) return false;
        seen.add(r.installerId);
        return true;
      });
    }),

  /**
   * Who's on the clock, whether or not they're sharing. Lets the office see
   * "Mick is on a job but sharing is off" instead of guessing.
   */
  onShift: staffOnly.handler(async () => {
    const running = await db
      .select({
        taskId: schema.jobTasks.id,
        taskTitle: schema.jobTasks.title,
        startedAt: schema.jobTasks.startedAt,
        installerId: schema.installers.id,
        installerName: schema.installers.name,
        installerColour: schema.installers.colour,
        sharing: schema.installers.locationConsentAt,
        jobNumber: jobNumberSql,
        siteSuburb: schema.sites.suburb,
      })
      .from(schema.jobTasks)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(eq(schema.jobTasks.status, "in_progress"))
      .orderBy(desc(schema.jobTasks.startedAt));

    return running.map((r) => ({ ...r, sharing: Boolean(r.sharing) }));
  }),

  /** The office-side view of who has sharing switched on. Read-only — consent is theirs to give. */
  sharingStatus: staffOnly.handler(async () => {
    return db
      .select({
        id: schema.installers.id,
        name: schema.installers.name,
        consentAt: schema.installers.locationConsentAt,
      })
      .from(schema.installers)
      .where(eq(schema.installers.active, true))
      .orderBy(schema.installers.name);
  }),

  /** Today's breadcrumb trail for one installer, on-shift pings only. */
  trail: staffOnly
    .input(z.object({ installerId: z.number(), hours: z.number().min(1).max(24).default(12) }))
    .handler(async ({ input }) => {
      const cutoff = new Date(Date.now() - input.hours * 3_600_000);
      return db
        .select({
          lat: schema.installerLocations.lat,
          lng: schema.installerLocations.lng,
          capturedAt: schema.installerLocations.capturedAt,
          taskId: schema.installerLocations.taskId,
        })
        .from(schema.installerLocations)
        .where(
          and(
            eq(schema.installerLocations.installerId, input.installerId),
            gte(schema.installerLocations.capturedAt, cutoff),
          ),
        )
        .orderBy(schema.installerLocations.capturedAt);
    }),

  /** Wipe an installer's position history — for when someone asks. */
  clearTrail: adminOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    await db
      .delete(schema.installerLocations)
      .where(eq(schema.installerLocations.installerId, input.installerId));
    return { ok: true };
  }),

  /** Housekeeping: positions older than 14 days are no use to anyone. */
  prune: adminOnly.handler(async () => {
    const cutoff = new Date(Date.now() - 14 * 24 * 3_600_000);
    await db.delete(schema.installerLocations).where(sql`${schema.installerLocations.capturedAt} < ${cutoff}`);
    return { ok: true };
  }),
};
