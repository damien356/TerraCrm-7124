import { and, eq, isNull, lte } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { pushToOffice, sendPush } from "./push";

/* ---------------------------------------------------------------------------
 * Timed reminders from voice memos ("remind me in an hour to call her").
 *
 * Every minute, any open office task whose remind_at has passed and has not
 * been nudged yet gets a push to the assignee's phone, then remind_at is
 * stamped as done so it fires exactly once. The dashboard and the phone's
 * Office tab also list them, so a reminder still shows when no phone has
 * registered for push.
 *
 * Same gate as the journey engine: the API module is also loaded by the Vite
 * dev server, which points at the live database. A ticker there would buzz
 * Damien's phone off a developer's sandbox, and stamp reminders as sent so the
 * real server never sends them. It only ticks in the published server, where
 * the entry script is `__server.ts`.
 *
 *   REMINDERS=off   never tick
 *   REMINDERS=on    tick regardless of the entry script
 * ------------------------------------------------------------------------- */

const EVERY_MS = 60_000;

function isPublishedServer() {
  const argv = (process as unknown as { argv?: string[] }).argv ?? [];
  return (argv[1] ?? "").endsWith("__server.ts");
}

async function userIdForProfile(profileId: number | null) {
  if (!profileId) return null;
  const [p] = await db
    .select({ userId: schema.profiles.userId })
    .from(schema.profiles)
    .where(eq(schema.profiles.id, profileId));
  return p?.userId ?? null;
}

let running = false;

/** One pass. Exported so it can be run by hand against a scratch database. */
export async function tickReminders(now = new Date()) {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    const due = await db
      .select()
      .from(schema.officeTasks)
      .where(
        and(
          eq(schema.officeTasks.status, "open"),
          isNull(schema.officeTasks.remindedAt),
          lte(schema.officeTasks.remindAt, now),
        ),
      )
      .limit(50);

    for (const t of due) {
      // Stamp first: a push that half fails must never repeat every minute.
      await db.update(schema.officeTasks).set({ remindedAt: now }).where(eq(schema.officeTasks.id, t.id));
      const message = {
        title: "Reminder",
        body: t.title || "Follow up",
        data: { screen: "office", officeTaskId: t.id, jobId: t.jobId },
        sound: "default" as const,
      };
      const userId = await userIdForProfile(t.assignedProfileId);
      const delivered = userId ? await sendPush([userId], message) : 0;
      if (delivered === 0) await pushToOffice(message);
      sent++;
    }
  } catch (err) {
    console.error("[reminders] tick failed:", err);
  } finally {
    running = false;
  }
  return sent;
}

let booted = false;

export function bootReminders() {
  if (booted) return;
  booted = true;
  const mode = process.env.REMINDERS;
  if (mode === "off") {
    console.log("[reminders] disabled by REMINDERS=off");
    return;
  }
  if (mode !== "on" && !isPublishedServer()) {
    console.log("[reminders] idle, not the published server, no pushes will be sent");
    return;
  }
  console.log("[reminders] ticking every minute");
  setInterval(() => void tickReminders(), EVERY_MS);
  setTimeout(() => void tickReminders(), 15_000);
}
