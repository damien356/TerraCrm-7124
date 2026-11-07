import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Per-contractor rate items (Damien's brief, 7 Nov 2026, section 3).
 *
 * The day rates (one man, two man crew, leading hand) carry no skill, so
 * before this every installer's card, app and the admin card showed them
 * with Terra's price. They are now marked restricted: an installer only gets
 * one when Damien switches it on for him, from a date, and it stays off for
 * everyone else. Each switch is a new row, so the history is kept, and
 * switching off never touches pay already agreed or invoiced.
 * ------------------------------------------------------------------------- */

const key = (installerId: number, itemId: number) => `${installerId}:${itemId}`;

/** Switched on today (or on `on`), per installer and item. Missing means off. */
export async function accessOn(installerIds: number[], on: string) {
  const out = new Map<string, boolean>();
  if (!installerIds.length) return out;
  const rows = await db
    .select()
    .from(schema.installerRateItemAccess)
    .where(and(inArray(schema.installerRateItemAccess.installerId, [...new Set(installerIds)]), lte(schema.installerRateItemAccess.effectiveFrom, on)))
    .orderBy(asc(schema.installerRateItemAccess.effectiveFrom), asc(schema.installerRateItemAccess.id));
  for (const r of rows) out.set(key(r.installerId, r.itemId), r.enabled);
  return out;
}

/** Whether this installer gets this item: anything not restricted, or a restricted one switched on for him. */
export function itemOpenTo(item: { id: number; restricted: boolean }, installerId: number, access: Map<string, boolean>) {
  return !item.restricted || access.get(key(installerId, item.id)) === true;
}

/** The restricted items among these that are not switched on for him, by name. */
export async function lockedItems(installerId: number, itemIds: number[], on: string) {
  if (!itemIds.length) return [];
  const items = await db
    .select({ id: schema.labourRateItems.id, name: schema.labourRateItems.name, restricted: schema.labourRateItems.restricted })
    .from(schema.labourRateItems)
    .where(and(inArray(schema.labourRateItems.id, [...new Set(itemIds)]), eq(schema.labourRateItems.restricted, true)));
  if (!items.length) return [];
  const access = await accessOn([installerId], on);
  return items.filter((i) => !itemOpenTo(i, installerId, access));
}

/** Every switch for one installer, oldest first (the card reverses it), for the admin card. */
export async function accessHistory(installerId: number) {
  return db
    .select()
    .from(schema.installerRateItemAccess)
    .where(eq(schema.installerRateItemAccess.installerId, installerId))
    .orderBy(asc(schema.installerRateItemAccess.effectiveFrom), asc(schema.installerRateItemAccess.id));
}
