import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * One dispatch per job (fix list item 13, Damien 11 Oct).
 *
 * An accepted quote makes ONE dispatch. Uplift, disposal and prep go in with
 * the install, as labour lines on that dispatch (task_labour_lines), so the
 * installer's pay and the days on site still see every line.
 *
 *   insertDispatchForLines  the quote's work lines become one dispatch
 *   splitDispatch           Split by trade: chosen lines move to a new dispatch
 *   mergeDispatches         dispatches go back into one
 *
 * Split and merge only touch free dispatches: unassigned, no offer out and
 * no day booked. Anything already with crew stays as it is.
 * ------------------------------------------------------------------------- */

type Task = typeof schema.jobTasks.$inferSelect;
type RateItem = typeof schema.labourRateItems.$inferSelect;
export type WorkLine = typeof schema.quoteItems.$inferSelect;

/** Log actions that mark a dispatch as made from a quote, or split off one. */
export const DISPATCH_MADE = "dispatch_made";
export const DISPATCH_SPLIT = "dispatch_split";

/** Rate book groups that are not the floor itself. */
export const SIDE_GROUPS = new Set(["prep", "demolition", "trades", "other", "surcharge"]);

/** Why a dispatch cannot be touched, or null when it is free. */
export async function taskLock(task: Task): Promise<string | null> {
  if (task.status === "offered") return "offered to crew";
  if (task.status === "assigned") return "booked";
  if (task.status === "in_progress") return "started";
  if (task.status === "complete") return "done";
  if (task.status !== "unassigned") return task.status;
  if (task.assignedInstallerId) return "booked";
  const [offer] = await db
    .select({ id: schema.taskOffers.id })
    .from(schema.taskOffers)
    .where(and(eq(schema.taskOffers.taskId, task.id), inArray(schema.taskOffers.status, ["pending", "provisional"])))
    .limit(1);
  if (offer) return "offered to crew";
  const [day] = await db
    .select({ id: schema.taskDays.id })
    .from(schema.taskDays)
    .where(and(eq(schema.taskDays.taskId, task.id), eq(schema.taskDays.status, "booked")))
    .limit(1);
  if (day) return "booked";
  return null;
}

export async function rateItemsFor(ids: number[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<number, RateItem>();
  const rows = await db.select().from(schema.labourRateItems).where(inArray(schema.labourRateItems.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/** An install line: linked to a floor, or priced under a floor trade. */
export function isInstall(line: WorkLine, items: Map<number, RateItem>) {
  if (line.labourForItemId) return true;
  const item = line.rateItemId ? items.get(line.rateItemId) : undefined;
  if (item) return item.kind === "work" && !SIDE_GROUPS.has(item.groupName);
  return line.kind === "labour";
}

/** The skill a set of rate items is done under: the floor trade first. */
function skillOfItems(list: RateItem[]): number | null {
  const floor = list.find((i) => i.kind === "work" && i.skillId && !SIDE_GROUPS.has(i.groupName));
  const any = list.find((i) => i.kind === "work" && i.skillId);
  return floor?.skillId ?? any?.skillId ?? null;
}

/** The old wording guess, for quotes whose lines have no rate item. */
async function guessSkill(line: WorkLine) {
  const skills = await db.select().from(schema.skills).where(eq(schema.skills.active, true)).orderBy(asc(schema.skills.sortOrder));
  const haystack = line.description.toLowerCase();
  return (
    skills.find((s) => haystack.includes(s.name.toLowerCase())) ??
    skills.find((s) => (line.kind === "removal" ? s.groupName === "demolition" : s.groupName === "prep"))
  );
}

const fmtQty = (qty: number, unit: string | null) => `${Number(qty.toFixed(2))} ${unit === "m2" ? "m²" : (unit ?? "")}`.trim();

/** Work lines with no rate item cannot be labour lines, so they are written on the dispatch. */
export function freeTextNote(lines: WorkLine[]) {
  const loose = lines.filter((l) => !l.rateItemId);
  if (!loose.length) return null;
  return `Also on the quote: ${loose.map((l) => `${l.description} (${fmtQty(l.qty, l.unit)})`).join(", ")}.`;
}

/** Labour lines for the quote lines, quantities of the same rate item added together. */
export function labourQtys(lines: WorkLine[]) {
  const out = new Map<number, number>();
  for (const l of lines) {
    if (!l.rateItemId) continue;
    out.set(l.rateItemId, (out.get(l.rateItemId) ?? 0) + (l.qty ?? 0));
  }
  return out;
}

/** Adds quantities onto a dispatch's labour lines, one row per rate item. */
export async function addLabour(taskId: number, qtys: Map<number, number>) {
  if (!qtys.size) return;
  const existing = await db.select().from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, taskId));
  let sort = existing.reduce((m, r) => Math.max(m, r.sortOrder), 0);
  for (const [itemId, qty] of qtys) {
    const row = existing.find((r) => r.itemId === itemId);
    if (row) {
      await db
        .update(schema.taskLabourLines)
        .set({ qty: Math.round((row.qty + qty) * 1000) / 1000, updatedAt: new Date() })
        .where(eq(schema.taskLabourLines.id, row.id));
    } else {
      await db.insert(schema.taskLabourLines).values({ taskId, itemId, qty: Math.round(qty * 1000) / 1000, sortOrder: ++sort });
    }
  }
}

/**
 * The quote's work lines as ONE unassigned dispatch. Title and skill come
 * from the install line, the floor area from the install lines and the
 * floors they lay, and every line with a rate item is a labour line.
 */
export async function insertDispatchForLines(
  jobId: number,
  work: WorkLine[],
  supply: WorkLine[],
  seq: number,
  furnitureOnSite: boolean,
  quoteId: number,
  /** False for jobs from before item 13, which are still matched by wording. */
  mark = true,
) {
  const items = await rateItemsFor(work.map((l) => l.rateItemId).filter((n): n is number => n != null));
  // Lines priced from the rate book lead. A loose labour line only names the
  // dispatch when nothing on the quote is from the rate book.
  const allInstalls = work.filter((l) => isInstall(l, items));
  const rated = allInstalls.filter((l) => l.rateItemId);
  const installs = rated.length ? rated : allInstalls;
  const main = installs[0] ?? work.find((l) => l.rateItemId) ?? work[0]!;

  const mainItem = main.rateItemId ? items.get(main.rateItemId) : undefined;
  let skillId = mainItem?.kind === "work" ? (mainItem.skillId ?? null) : null;
  if (!skillId) skillId = skillOfItems([...items.values()]);
  let skillRow = skillId ? (await db.select().from(schema.skills).where(eq(schema.skills.id, skillId)))[0] : undefined;
  if (!skillRow) {
    skillRow = await guessSkill(main);
    skillId = skillRow?.id ?? null;
  }

  const titles = [...new Set((installs.length ? installs : [main]).map((l) => l.description.trim()))];
  const title = titles.length <= 2 ? titles.join(" + ") : `${titles.slice(0, 2).join(" + ")} + ${titles.length - 2} more`;

  // Floor area: install lines in m², or the m² of the floor a linked install lays.
  let area = 0;
  for (const l of installs) {
    if (l.unit === "m2") area += l.qty ?? 0;
    else if (l.labourForItemId) {
      const floor = supply.find((s) => s.id === l.labourForItemId);
      if (floor?.unit === "m2") area += floor.measuredM2 ?? floor.qty ?? 0;
    }
  }

  const [row] = await db
    .insert(schema.jobTasks)
    .values({
      jobId,
      skillId,
      title,
      description: freeTextNote(work),
      status: "unassigned",
      areaM2: area > 0 ? Math.round(area * 100) / 100 : null,
      crewSize: furnitureOnSite ? 2 : (skillRow?.defaultCrewSize ?? 1),
      seq,
    })
    .returning();
  await addLabour(row!.id, labourQtys(work));
  if (!mark) return row!;
  // Marks the dispatch as the quote's own, so a later version knows which one to change.
  await db.insert(schema.activityLog).values({
    jobId,
    taskId: row!.id,
    entityType: "quote",
    entityId: quoteId,
    action: DISPATCH_MADE,
    detail: `Dispatch "${title}" made from the quote`,
  });
  return row!;
}

/** The dispatches on a job that came from its quote (made, split off, or merged into). */
export async function quoteDispatchIds(jobId: number) {
  const rows = await db
    .select({ taskId: schema.activityLog.taskId })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.jobId, jobId), inArray(schema.activityLog.action, [DISPATCH_MADE, DISPATCH_SPLIT])));
  return new Set(rows.map((r) => r.taskId).filter((n): n is number => n != null));
}

/** Rewrites the "Also on the quote" sentence in a dispatch's notes, keeping anything else. */
export function withFreeTextNote(description: string | null, lines: WorkLine[]) {
  const kept = (description ?? "").split("\n").filter((l) => !l.startsWith("Also on the quote: "));
  const note = freeTextNote(lines);
  return [note, ...kept].filter((l) => l && l.trim()).join("\n") || null;
}

/* ------------------------------- the job page ------------------------------ */

/** Every dispatch on a job with its labour lines and whether it is free to split or merge. */
export async function jobDispatchLines(jobId: number) {
  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.jobId, jobId))
    .orderBy(asc(schema.jobTasks.seq), asc(schema.jobTasks.id));
  const ids = tasks.map((t) => t.id);
  const lines = ids.length
    ? await db
        .select({ line: schema.taskLabourLines, item: schema.labourRateItems })
        .from(schema.taskLabourLines)
        .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
        .where(inArray(schema.taskLabourLines.taskId, ids))
        .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id))
    : [];
  const out = [];
  for (const t of tasks) {
    out.push({
      id: t.id,
      seq: t.seq,
      title: t.title,
      status: t.status,
      lock: t.status === "cancelled" ? "cancelled" : await taskLock(t),
      lines: lines
        .filter((l) => l.line.taskId === t.id)
        .map((l) => ({ itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty, groupName: l.item.groupName })),
    });
  }
  return out;
}

/* --------------------------------- split ---------------------------------- */

export class DispatchError extends Error {}

async function freeTask(id: number, jobId?: number) {
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, id));
  if (!task) throw new DispatchError("Dispatch not found.");
  if (jobId != null && task.jobId !== jobId) throw new DispatchError("Those dispatches are on different jobs.");
  if (task.status === "cancelled") throw new DispatchError(`Dispatch "${task.title}" is cancelled.`);
  const lock = await taskLock(task);
  if (lock) throw new DispatchError(`Dispatch "${task.title}" is ${lock}, so it cannot be changed. Take it back off the crew first.`);
  return task;
}

/**
 * Split by trade. The chosen labour lines move off the dispatch onto a new
 * one (Pedro does the uplift and prep, then an installer lays the floor).
 * At least one line has to stay behind.
 */
export async function splitDispatch(
  args: { taskId: number; itemIds: number[]; title?: string | null },
  actor: { name: string; role: string },
) {
  const task = await freeTask(args.taskId);
  const lines = await db.select().from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, task.id));
  const moving = lines.filter((l) => args.itemIds.includes(l.itemId));
  if (!moving.length) throw new DispatchError("Pick the lines that go on the new dispatch.");
  if (moving.length === lines.length) throw new DispatchError("Leave at least one line on this dispatch.");

  const items = await rateItemsFor(lines.map((l) => l.itemId));
  const movedItems = moving.map((l) => items.get(l.itemId)).filter((i): i is RateItem => !!i);
  const stayItems = lines.filter((l) => !args.itemIds.includes(l.itemId)).map((l) => items.get(l.itemId)).filter((i): i is RateItem => !!i);

  const newSkillId = skillOfItems(movedItems);
  const [newSkill] = newSkillId ? await db.select().from(schema.skills).where(eq(schema.skills.id, newSkillId)) : [];
  const [job] = await db.select({ furnitureOnSite: schema.jobs.furnitureOnSite }).from(schema.jobs).where(eq(schema.jobs.id, task.jobId));
  const [top] = await db
    .select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` })
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.jobId, task.jobId));
  const title = args.title?.trim() || movedItems.map((i) => i.name).join(", ");

  // The floor area goes with the floor. If the install lines move, so does the m².
  const movesFloor = movedItems.some((i) => i.kind === "work" && !SIDE_GROUPS.has(i.groupName));
  const floorStays = stayItems.some((i) => i.kind === "work" && !SIDE_GROUPS.has(i.groupName));
  const moveArea = movesFloor && !floorStays;

  const [created] = await db
    .insert(schema.jobTasks)
    .values({
      jobId: task.jobId,
      seq: Number(top?.max ?? 0) + 1,
      skillId: newSkillId,
      title,
      status: "unassigned",
      areaM2: moveArea ? task.areaM2 : null,
      crewSize: job?.furnitureOnSite ? 2 : (newSkill?.defaultCrewSize ?? 1),
      tenderMode: task.tenderMode,
      durationHours: task.durationHours,
      scheduledFrom: task.scheduledFrom,
      scheduledTo: task.scheduledTo,
    })
    .returning();

  await db
    .update(schema.taskLabourLines)
    .set({ taskId: created!.id, updatedAt: new Date() })
    .where(and(eq(schema.taskLabourLines.taskId, task.id), inArray(schema.taskLabourLines.itemId, moving.map((l) => l.itemId))));

  // The dispatch left behind keeps its skill unless none of its lines are done under it any more.
  const patch: Partial<typeof schema.jobTasks.$inferInsert> = { updatedAt: new Date() };
  if (moveArea) patch.areaM2 = null;
  if (!stayItems.some((i) => i.skillId === task.skillId)) {
    const stillSkill = skillOfItems(stayItems);
    if (stillSkill) patch.skillId = stillSkill;
  }
  await db.update(schema.jobTasks).set(patch).where(eq(schema.jobTasks.id, task.id));

  await db.insert(schema.activityLog).values({
    jobId: task.jobId,
    taskId: created!.id,
    entityType: "task",
    entityId: created!.id,
    action: DISPATCH_SPLIT,
    detail: `Split from "${task.title}": ${movedItems.map((i) => i.name).join(", ")}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return created!;
}

/* --------------------------------- merge ---------------------------------- */

/** Tables that point at a dispatch and must follow it into the merged one. */
const FOLLOW_TABLES = [
  "activity_log",
  "job_materials",
  "task_checklist_items",
  "task_photos",
  "installer_account_entries",
  "installer_locations",
  "job_areas",
  "job_media",
  "form_submissions",
  "installer_invoices",
  "installer_variation_requests",
  "site_visits",
  "voice_actions",
  "swms_records",
  "swms_flags",
] as const;

/**
 * Dispatches back into one. The first keeps its title, skill and place;
 * the others' labour lines are added onto it, their notes, photos and
 * history move across, and the empty dispatches are removed.
 */
export async function mergeDispatches(args: { intoId: number; taskIds: number[] }, actor: { name: string; role: string }) {
  const into = await freeTask(args.intoId);
  const others = [];
  for (const id of [...new Set(args.taskIds)].filter((id) => id !== into.id)) others.push(await freeTask(id, into.jobId));
  if (!others.length) throw new DispatchError("Pick at least two dispatches to merge.");
  const ids = others.map((t) => t.id);

  const lines = await db.select().from(schema.taskLabourLines).where(inArray(schema.taskLabourLines.taskId, ids));
  const qtys = new Map<number, number>();
  for (const l of lines) qtys.set(l.itemId, (qtys.get(l.itemId) ?? 0) + l.qty);
  await addLabour(into.id, qtys);

  const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  for (const table of FOLLOW_TABLES) {
    await db.run(sql`update ${sql.identifier(table)} set task_id = ${into.id} where task_id in (${idList})`);
  }

  const notes = [into.description, ...others.map((t) => [`Merged in: ${t.title}.`, t.description].filter(Boolean).join(" "))].filter(Boolean);
  await db
    .update(schema.jobTasks)
    .set({
      description: notes.join("\n") || null,
      areaM2: into.areaM2 ?? others.find((t) => t.areaM2 != null)?.areaM2 ?? null,
      crewSize: Math.max(into.crewSize, ...others.map((t) => t.crewSize)),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobTasks.id, into.id));
  await db.delete(schema.jobTasks).where(inArray(schema.jobTasks.id, ids));

  await db.insert(schema.activityLog).values({
    jobId: into.jobId,
    taskId: into.id,
    entityType: "task",
    entityId: into.id,
    action: "dispatch_merged",
    detail: `Merged into "${into.title}": ${others.map((t) => t.title).join(", ")}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { id: into.id, merged: ids.length };
}
