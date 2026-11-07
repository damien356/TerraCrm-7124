import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { lockedItems } from "./rate-access";
import { todayLocal } from "./local-date";
import { hourlyRateBarrier } from "./hourly";
import { lineRateBarrier } from "./line-rates";

/* ---------------------------------------------------------------------------
 * Which skills a piece of work needs, and who can do it (Damien's brief,
 * 7 Nov 2026, section 2).
 *
 * The cause of Fabrizio missing from the picker: a dispatch made from a quote
 * took the skill of its first install line only (Carpet tiles on job 4297),
 * and the picker listed only people ticked for that one skill. Someone ticked
 * for the hybrid on the same dispatch was dropped with no reason shown.
 *
 * Now the skills come from the work itself: every labour line's rate item
 * that has a skill. Lines with no skill (a day rate) need none. A dispatch
 * with no lines falls back to its own skill. Eligibility is judged against
 * the lines actually being given out, so a package of only the hybrid lines
 * needs only Hybrid.
 * ------------------------------------------------------------------------- */

export type SkillNeed = { id: number; name: string };

/** The skills the given lines of a task need (all its lines when itemIds is left out). */
export async function skillsForTask(taskId: number, itemIds?: number[] | null): Promise<SkillNeed[]> {
  const [task] = await db.select({ skillId: schema.jobTasks.skillId }).from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
  if (!task) return [];
  const lines = await db
    .select({ itemId: schema.taskLabourLines.itemId, skillId: schema.labourRateItems.skillId })
    .from(schema.taskLabourLines)
    .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
    .where(eq(schema.taskLabourLines.taskId, taskId));
  const picked = itemIds?.length ? lines.filter((l) => itemIds.includes(l.itemId)) : lines;
  let ids = [...new Set(picked.map((l) => l.skillId).filter((s): s is number => s != null))];
  // No lines (or none with a skill): the dispatch's own skill, as before.
  if (!ids.length && !picked.length && task.skillId) ids = [task.skillId];
  return namesFor(ids);
}

export async function namesFor(ids: number[]): Promise<SkillNeed[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills).where(inArray(schema.skills.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => ({ id, name: byId.get(id) ?? "this skill" }));
}

/** The needed skills this installer is not ticked for. */
export async function missingSkills(installerId: number, needs: SkillNeed[]): Promise<SkillNeed[]> {
  if (!needs.length) return [];
  const ticks = await db
    .select({ skillId: schema.installerSkills.skillId })
    .from(schema.installerSkills)
    .where(and(eq(schema.installerSkills.installerId, installerId), inArray(schema.installerSkills.skillId, needs.map((n) => n.id))));
  const have = new Set(ticks.map((t) => t.skillId));
  return needs.filter((n) => !have.has(n.id));
}

/** "Carpet tiles" / "Carpet tiles and Hybrid" / "A, B and C". */
export function sayList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why this installer can't be given these lines of a task, or null. Skills
 * he isn't ticked for, and per-contractor items (a day rate) not switched on
 * for him.
 */
export async function workBarrier(
  taskId: number,
  installerId: number,
  itemIds?: number[] | null,
  opts: { rates?: boolean } = {},
): Promise<string | null> {
  const missing = await missingSkills(installerId, await skillsForTask(taskId, itemIds));
  if (missing.length) return `That installer isn't ticked for ${sayList(missing.map((m) => m.name))}.`;
  const lines = await db.select({ itemId: schema.taskLabourLines.itemId }).from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, taskId));
  const ids = lines.map((l) => l.itemId).filter((id) => !itemIds?.length || itemIds.includes(id));
  const locked = await lockedItems(installerId, ids, todayLocal());
  if (locked.length) return `${sayList(locked.map((l) => l.name))} isn't switched on for that installer's rate card.`;
  // A line at $0.00 (or with no rate at all) is "Rate not set", never free work.
  if (opts.rates !== false) {
    const rateStop = await lineRateBarrier(taskId, installerId, itemIds);
    if (rateStop) return rateStop;
  }
  // Hourly man with no agreed rate: never offered work as if $0.00 were a rate.
  return hourlyRateBarrier(installerId);
}
