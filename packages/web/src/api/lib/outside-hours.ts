import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { OUTSIDE_HOURS, outsideDays, outsideHoursMessage, sayClock, sayDay, type HoursDay } from "./work-hours";

/* ---------------------------------------------------------------------------
 * Outside standard hours (Damien's brief, 7 Nov 2026, section 6).
 *
 * Booking or moving a booking so a day starts before 6:00 am or finishes
 * after 6:00 pm Brisbane needs a confirm. Without it the write is refused
 * with the brief's wording and `data.reason = "outside_hours"`, so the panel
 * can open "Change time" / "Confirm outside-hours booking". With it, the
 * booking goes ahead and who confirmed it, and when, goes on the job record.
 *
 * The confirm only answers the hours question. It never stands in for a
 * calendar clash or anything else the booking paths check.
 *
 * The AI phone agent books inside the visit hours set in Phone settings and
 * can't answer a dialog, so its bookings are left as they are (brief: the
 * agent's hours stay unchanged).
 * ------------------------------------------------------------------------- */

const AGENT_USER = "system:retell-agent";

export type OutsideHit = { date: string; from: string; to: string };

/** The days that need the confirm. Throws when they are not confirmed. */
export function checkOutsideHours(args: { days: HoursDay[]; durationHours: number | null | undefined; confirmed?: boolean | null; actor: Actor }): OutsideHit[] {
  if (args.actor.userId === AGENT_USER) return [];
  const hits = outsideDays(args.days, args.durationHours);
  if (!hits.length || args.confirmed) return hits;
  throw new ORPCError("BAD_REQUEST", {
    message: outsideHoursMessage(hits),
    data: { reason: OUTSIDE_HOURS, days: hits },
  });
}

/** Writes who confirmed an outside-hours booking, after the booking itself is saved. */
export async function logOutsideHours(args: { jobId: number; taskId: number; hits: OutsideHit[]; actor: Actor; source: string }) {
  if (!args.hits.length) return;
  const said = args.hits.map((h) => `${sayDay(h.date)} ${sayClock(h.from)} to ${sayClock(h.to)}`).join("; ");
  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    taskId: args.taskId,
    entityType: "task",
    entityId: args.taskId,
    action: "outside_hours_confirmed",
    detail: `Outside standard working hours (6:00 am-6:00 pm) confirmed by ${args.actor.name || "unknown"} (${args.actor.role}) at ${new Date().toISOString()}, ${args.source}: ${said}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
}
