import { useEffect } from "react";
import * as Notifications from "expo-notifications";
import { pushSupported } from "./push";
import { safeGet, safeSet } from "./crash-guard";

/**
 * Forgotten clock-out reminder (Damien, 13 Nov 2026).
 *
 * While he is on the clock the phone holds one local reminder, 10 hours after
 * he tapped Start. Finishing cancels it. Nothing is sent to the server and
 * nothing ever finishes his time for him: the reminder only asks.
 *
 * Native only, and only when he has already allowed notifications. Web and a
 * refused permission quietly do nothing.
 */

const KEY = "hourly_clock_reminder";
const AFTER_MS = 10 * 60 * 60 * 1000;

type Held = { sessionId: number; notificationId: string };

function held(): Held | null {
  const raw = safeGet(KEY);
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as Held;
    return h?.notificationId ? h : null;
  } catch {
    return null;
  }
}

function clockText(iso: string) {
  const d = new Date(Date.parse(iso) + 10 * 60 * 60 * 1000); // Brisbane, no daylight saving
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

let running: Promise<void> = Promise.resolve();

async function sync(open: { id: number; start: string } | null) {
  const now = held();
  if (open && now?.sessionId === open.id) return;
  if (now) {
    await Notifications.cancelScheduledNotificationAsync(now.notificationId).catch(() => undefined);
    safeSet(KEY, "");
  }
  if (!open) return;
  const at = Date.parse(open.start) + AFTER_MS;
  if (!Number.isFinite(at) || at <= Date.now() + 60_000) return;
  const perm = await Notifications.getPermissionsAsync().catch(() => null);
  if (perm?.status !== "granted") return;
  const notificationId = await Notifications.scheduleNotificationAsync({
    content: {
      title: "Still on the clock?",
      body: `You tapped Start at ${clockText(open.start)}. If you have stopped, open Terra and tap Finish. If you forgot earlier, ask the office to fix the time.`,
      sound: "default",
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(at), channelId: "default" },
  });
  safeSet(KEY, JSON.stringify({ sessionId: open.id, notificationId } satisfies Held));
}

/**
 * Keep the reminder in step with the timer. Pass the open entry once loaded
 * (null when he is off the clock); undefined means "not known yet", so
 * nothing changes.
 */
export function useClockOutReminder(open: { id: number; start: string } | null | undefined) {
  const id = open === undefined ? undefined : (open?.id ?? null);
  const start = open?.start ?? null;
  useEffect(() => {
    if (!pushSupported || id === undefined) return;
    const next = id === null || !start ? null : { id, start };
    running = running.then(() => sync(next)).catch(() => undefined);
  }, [id, start]);
}
