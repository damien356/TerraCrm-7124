import { and, eq, gte, lte, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * The single source of truth for "can this installer work that day".
 * Every dispatch path — direct offer, broadcast, accept, drag-and-drop — runs
 * through here server-side, so a blocked day can't be booked from the UI.
 */
export async function blockedInstallerIds(date: string): Promise<Set<number>> {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const rows = await db
    .select({
      installerId: schema.installerUnavailability.installerId,
      kind: schema.installerUnavailability.kind,
      weekdayMask: schema.installerUnavailability.weekdayMask,
    })
    .from(schema.installerUnavailability)
    .where(
      or(
        eq(schema.installerUnavailability.kind, "recurring"),
        and(
          lte(schema.installerUnavailability.fromDate, date),
          gte(schema.installerUnavailability.toDate, date),
        ),
      ),
    );

  const blocked = new Set<number>();
  for (const r of rows) {
    if (r.kind === "recurring") {
      if (safeWeekdays(r.weekdayMask).includes(weekday)) blocked.add(r.installerId);
    } else {
      blocked.add(r.installerId);
    }
  }

  // Legacy per-installer weekday ticks on the installer card still count.
  const legacy = await db
    .select({ id: schema.installers.id, days: schema.installers.unavailableDays })
    .from(schema.installers);
  for (const l of legacy) {
    if (safeWeekdays(l.days).includes(weekday)) blocked.add(l.id);
  }
  return blocked;
}

/** Throws nothing — callers decide. Returns the reason if they're blocked. */
export async function blockedReason(installerId: number, date: string): Promise<string | null> {
  const weekday = new Date(`${date}T00:00:00`).getDay();
  const rows = await db
    .select()
    .from(schema.installerUnavailability)
    .where(eq(schema.installerUnavailability.installerId, installerId));
  for (const r of rows) {
    if (r.kind === "recurring") {
      if (safeWeekdays(r.weekdayMask).includes(weekday)) return r.reason || "Doesn't work that day";
    } else if (r.fromDate && r.toDate && r.fromDate <= date && date <= r.toDate) {
      return r.reason || "Booked out";
    }
  }
  return null;
}

export function safeWeekdays(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}
