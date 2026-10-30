import { db } from "../database";
import * as schema from "../database/schema";
import { linkProblem, refreshLink } from "./calendar-availability";
import { isLiveServer } from "./runtime";

/* ---------------------------------------------------------------------------
 * Keeps the board's busy shading fresh: every 10 minutes, re-reads each
 * connected person's ticked Google calendars (busy times only). Booking checks
 * never rely on this: they read Google live at the moment of booking.
 *
 *   CALENDAR_SYNC=off   never run
 *   CALENDAR_SYNC=on    run regardless of the entry script
 * ------------------------------------------------------------------------- */

const EVERY_MS = 10 * 60 * 1000;

let booted = false;
let running = false;

export async function refreshAllCalendars() {
  if (running) return;
  running = true;
  try {
    const links = await db.select().from(schema.calendarLinks);
    for (const link of links) {
      if (linkProblem(link)) continue;
      const r = await refreshLink(link);
      if (!r.ok) console.warn(`[calendar] link ${link.id} could not be read: ${r.error}`);
    }
  } catch (e) {
    console.error("[calendar] refresh failed", e);
  } finally {
    running = false;
  }
}

export function bootCalendarSync() {
  if (booted) return;
  booted = true;
  const mode = process.env.CALENDAR_SYNC;
  if (mode === "off") return void console.log("[calendar] disabled by CALENDAR_SYNC=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[calendar] idle, not the published server");
  console.log("[calendar] reading busy times every 10 minutes");
  setTimeout(() => void refreshAllCalendars(), 60 * 1000);
  setInterval(() => void refreshAllCalendars(), EVERY_MS);
}
