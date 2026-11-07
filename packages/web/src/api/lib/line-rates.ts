import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { rateBook } from "../routes/labour";
import { termsOn } from "./hourly";
import { todayLocal } from "./local-date";

/*
 * $0.00 is "Rate not set", never an agreement to work for free (Damien,
 * 7 Nov 2026). A line of paid work can't be offered, booked or approved for
 * pay to someone whose rate for that item is $0.00 or missing: his own rate
 * when he has one, otherwise Terra's standard, exactly as the pay is priced.
 *
 * An hourly man is paid on approved time, not on the lines (the lines are
 * only the benchmark), so his lines are not checked here. His hourly rate
 * has its own check (hourlyRateBarrier).
 */

/** "A" / "A and B" / "A, B and C" (the same wording as the skill reasons). */
function sayList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type UnsetRate = { itemId: number; name: string; rate: number | null };

/** The lines of a task (or only itemIds) with no valid rate for this installer. */
export async function unsetRates(taskId: number, installerId: number, itemIds?: number[] | null, on: string = todayLocal()): Promise<UnsetRate[]> {
  const terms = await termsOn(installerId, on);
  if (terms?.defaultForNew) return [];
  const lines = (await db.select().from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, taskId))).filter(
    (l) => !itemIds?.length || itemIds.includes(l.itemId),
  );
  if (!lines.length) return [];
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const [items, rates] = await Promise.all([
    db.select({ id: schema.labourRateItems.id, name: schema.labourRateItems.name }).from(schema.labourRateItems).where(inArray(schema.labourRateItems.id, ids)),
    rateBook.loadRates(ids),
  ]);
  const out: UnsetRate[] = [];
  for (const id of ids) {
    const r = rateBook.pick(rates, id, installerId, on);
    if (r.amount != null && r.amount > 0) continue;
    out.push({ itemId: id, name: items.find((i) => i.id === id)?.name ?? `Item ${id}`, rate: r.amount });
  }
  return out;
}

/** The words shown when a line has no valid rate. */
export function rateNotSetMessage(unset: UnsetRate[], doing = "giving this person this work"): string {
  return `${sayList(unset.map((u) => u.name))}: Rate not set ($0.00). Set the agreed rate on this person's rate card before ${doing}.`;
}

/** Why this installer can't be given these lines at the rates on his card, or null. */
export async function lineRateBarrier(taskId: number, installerId: number, itemIds?: number[] | null): Promise<string | null> {
  const unset = await unsetRates(taskId, installerId, itemIds);
  return unset.length ? rateNotSetMessage(unset) : null;
}

/**
 * Lines of pay with no valid rate, from a frozen breakdown or an invoice's
 * lines. Approved extras are set by the office as an amount, so they are
 * checked on their total.
 */
export function unsetPayLines(lines: Array<{ description?: string; name?: string; qty: number; rate: number | null; total: number | null }>): string[] {
  return lines
    .filter((l) => (l.qty ?? 0) > 0)
    .filter((l) => {
      const label = l.description ?? l.name ?? "";
      if (label.startsWith("Approved extra:")) return !((l.total ?? 0) > 0);
      return !(l.rate != null && l.rate > 0);
    })
    .map((l) => l.description ?? l.name ?? "A line");
}
