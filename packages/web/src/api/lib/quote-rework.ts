import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { quoteLines, type QuoteLine } from "./quote-convert";
import { addLabour, insertDispatchForLines, labourQtys, quoteDispatchIds, rateItemsFor, SIDE_GROUPS, taskLock, withFreeTextNote } from "./dispatch-build";

/* ---------------------------------------------------------------------------
 * A later version of a quote is accepted on a job that already has the
 * dispatches and materials of an earlier one (item 7, Damien 10 Oct).
 *
 * The job has one dispatch per quote (item 13, 11 Oct), the quote's work as
 * labour lines on it, unless the office split it by trade. Each work line is
 * matched to the dispatch holding its rate item, and each material to the
 * earlier line it was made from (by the product, or its wording). Then:
 *
 *   same line, new numbers   free ones are updated, the rest are flagged
 *   line gone                taken off a free dispatch (a dispatch left with
 *                            nothing is cancelled), or flagged
 *   new line                 added to the quote's free dispatch, or a new
 *                            dispatch when that one is already with crew
 *
 * Free means nobody else has it yet:
 *   a dispatch that is unassigned, with no offer out and no day booked
 *   a material still To order and not on any purchase order
 *
 * Offered, booked, started or done dispatches, and ordered materials, are
 * never changed. Crew are only told when the office changes one by hand.
 * Anything Ops made or added by hand that does not match a line is left alone.
 * ------------------------------------------------------------------------- */

const key = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const num = (n: number | null | undefined) => (n == null ? null : Math.round(n * 1000) / 1000);
const same = (a: number | null | undefined, b: number | null | undefined) => num(a) === num(b);
const qtyText = (n: number | null | undefined, unit: string | null | undefined) =>
  n == null ? "no area" : `${Number(n.toFixed(2))} ${unit === "m2" ? "m2" : (unit ?? "")}`.trim();

/** Actions that mean "this version's lines are on the job now". */
export const WORK_ACTIONS = ["converted", "work_made", "work_swapped"] as const;

/**
 * The version whose lines the job's dispatches and materials were made from,
 * or null when none were made from any version of this quote yet.
 */
export async function workBaseQuoteId(quoteNumber: number, jobId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.activityLog.entityId })
    .from(schema.activityLog)
    .where(
      and(
        eq(schema.activityLog.entityType, "quote"),
        eq(schema.activityLog.jobId, jobId),
        inArray(schema.activityLog.action, [...WORK_ACTIONS]),
        sql`${schema.activityLog.entityId} in (select id from quotes where number = ${quoteNumber})`,
      ),
    )
    .orderBy(desc(schema.activityLog.id))
    .limit(1);
  return row?.id ?? null;
}

type Material = typeof schema.jobMaterials.$inferSelect;

/** Why a material cannot be touched, or null when it is free. */
async function materialLock(m: Material): Promise<string | null> {
  const [po] = await db
    .select({ number: schema.purchaseOrders.number })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .where(eq(schema.purchaseOrderLines.jobMaterialId, m.id))
    .limit(1);
  if (po) return `on purchase order ${po.number}`;
  if (m.status === "ordered") return "ordered";
  if (m.status === "on_site") return "on site";
  if (m.status === "installed") return "installed";
  if (m.status !== "to_order") return m.status;
  return null;
}

/** Pairs each earlier line with the job row made from it, first match wins. */
function pairUp<R>(lines: QuoteLine[], rows: R[], keyOfLine: (l: QuoteLine) => string, keyOfRow: (r: R) => string) {
  const pool = [...rows];
  return lines.map((line) => {
    const k = keyOfLine(line);
    const i = pool.findIndex((r) => keyOfRow(r) === k);
    return { line, row: i >= 0 ? (pool.splice(i, 1)[0] ?? null) : null };
  });
}

type Task = typeof schema.jobTasks.$inferSelect;

/**
 * The dispatch half of a version swap. The quote's own dispatches (made from
 * it, or split off one) are found by their log mark, and each work line by
 * the dispatch holding its rate item, so a split by trade still finds its
 * lines. Jobs made before item 13 (a dispatch per line) are matched by
 * wording, as they were.
 */
async function reworkDispatches(jobId: number, beforeWork: QuoteLine[], afterWork: QuoteLine[], furniture: boolean, afterSupply: QuoteLine[], quoteId: number, out: Rework) {
  const now = new Date();
  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
    .orderBy(schema.jobTasks.seq, schema.jobTasks.id);
  const marked = await quoteDispatchIds(jobId);
  const quoteTasks = tasks.filter((t) => marked.has(t.id));
  const [top] = await db.select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, jobId));
  let seq = Number(top?.max ?? 0);

  /* Jobs from before item 13: a dispatch per line, matched by wording. */
  const legacy = pairUp(beforeWork, tasks, (l) => key(l.description), (t) => key(t.title));
  if (!quoteTasks.length && legacy.some((p) => p.row)) {
    const left = [...legacy];
    const fresh: QuoteLine[] = [];
    for (const line of afterWork) {
      const i = left.findIndex((p) => key(p.line.description) === key(line.description));
      const task = i >= 0 ? (left.splice(i, 1)[0]?.row ?? null) : null;
      if (!task) {
        fresh.push(line);
        continue;
      }
      const area = line.unit === "m2" ? line.qty : null;
      if (same(task.areaM2, area)) continue;
      const lock = await taskLock(task);
      if (lock) {
        out.flags.push(`Dispatch "${task.title}" is ${lock}. The new quote changes it from ${qtyText(task.areaM2, "m2")} to ${qtyText(area, "m2")}. Not changed.`);
      } else {
        await db.update(schema.jobTasks).set({ areaM2: area, updatedAt: now }).where(eq(schema.jobTasks.id, task.id));
        out.changes.push(`Dispatch "${task.title}" updated from ${qtyText(task.areaM2, "m2")} to ${qtyText(area, "m2")}.`);
        out.tasksUpdated += 1;
      }
    }
    if (fresh.length) {
      const made = await insertDispatchForLines(jobId, fresh, afterSupply, ++seq, furniture, quoteId, false);
      out.tasksAdded += 1;
      out.changes.push(`Dispatch "${made.title}" added for ${fresh.map((l) => l.description).join(", ")}.`);
    }
    for (const p of left) {
      const task = p.row;
      if (!task) continue;
      const lock = await taskLock(task);
      if (lock) {
        out.flags.push(`Dispatch "${task.title}" is not on the new quote but is ${lock}. Left as it is.`);
      } else {
        await db.update(schema.jobTasks).set({ status: "cancelled", updatedAt: now }).where(eq(schema.jobTasks.id, task.id));
        out.changes.push(`Dispatch "${task.title}" cancelled, it is not on the new quote.`);
        out.tasksCancelled += 1;
      }
    }
    return;
  }

  if (beforeWork.length && !quoteTasks.length) {
    if (afterWork.length) out.flags.push("No dispatches were made from the earlier version, so none were made for this one. Add them on the job if they are needed.");
    return;
  }

  const ids = quoteTasks.map((t) => t.id);
  const lines = ids.length ? await db.select().from(schema.taskLabourLines).where(inArray(schema.taskLabourLines.taskId, ids)) : [];
  const beforeQ = labourQtys(beforeWork);
  const afterQ = labourQtys(afterWork);
  const holderOf = (itemId: number) => {
    const line = lines.find((l) => l.itemId === itemId);
    return line ? { line, task: quoteTasks.find((t) => t.id === line.taskId)! } : null;
  };
  const items = await rateItemsFor([...beforeQ.keys(), ...afterQ.keys()]);
  const name = (id: number) => items.get(id)?.name ?? `Rate item ${id}`;
  const unitOf = (id: number) => items.get(id)?.unit ?? null;
  const locks = new Map<number, string | null>();
  const lockOf = async (t: Task) => {
    if (!locks.has(t.id)) locks.set(t.id, await taskLock(t));
    return locks.get(t.id) ?? null;
  };
  const touched = new Set<number>();
  const emptied = new Set<number>();
  const toAdd = new Map<number, number>();

  for (const itemId of new Set([...beforeQ.keys(), ...afterQ.keys()])) {
    const was = beforeQ.get(itemId) ?? 0;
    const next = afterQ.get(itemId) ?? 0;
    if (same(was, next)) continue;
    const held = holderOf(itemId);
    if (!held) {
      if (next > 0) toAdd.set(itemId, next);
      continue;
    }
    const lock = await lockOf(held.task);
    if (lock) {
      out.flags.push(
        next > 0
          ? `Dispatch "${held.task.title}" is ${lock}. The new quote changes ${name(itemId)} from ${qtyText(was, unitOf(itemId))} to ${qtyText(next, unitOf(itemId))}. Not changed.`
          : `Dispatch "${held.task.title}" is ${lock}. ${name(itemId)} is not on the new quote. Left as it is.`,
      );
      continue;
    }
    // The floor area follows an install line priced by the m².
    const item = items.get(itemId);
    if (item?.unit === "m2" && item.kind === "work" && !SIDE_GROUPS.has(item.groupName) && held.task.areaM2 != null) {
      const area = Math.max(0, Math.round((held.task.areaM2 + next - was) * 100) / 100);
      await db.update(schema.jobTasks).set({ areaM2: area || null, updatedAt: now }).where(eq(schema.jobTasks.id, held.task.id));
    }
    if (next > 0) {
      await db.update(schema.taskLabourLines).set({ qty: Math.round(next * 1000) / 1000, updatedAt: now }).where(eq(schema.taskLabourLines.id, held.line.id));
      out.changes.push(`Dispatch "${held.task.title}": ${name(itemId)} from ${qtyText(was, unitOf(itemId))} to ${qtyText(next, unitOf(itemId))}.`);
    } else {
      await db.delete(schema.taskLabourLines).where(eq(schema.taskLabourLines.id, held.line.id));
      out.changes.push(`Dispatch "${held.task.title}": ${name(itemId)} taken off, it is not on the new quote.`);
      lines.splice(lines.indexOf(held.line), 1);
      if (!lines.some((l) => l.taskId === held.task.id)) emptied.add(held.task.id);
    }
    touched.add(held.task.id);
  }

  // The quote's free dispatch takes new lines, the install one first.
  let home: Task | null = null;
  const byInstall = [...quoteTasks].sort((a, b) => Number(lines.some((l) => l.taskId === b.id && !SIDE_GROUPS.has(items.get(l.itemId)?.groupName ?? "other"))) - Number(lines.some((l) => l.taskId === a.id && !SIDE_GROUPS.has(items.get(l.itemId)?.groupName ?? "other"))));
  for (const t of byInstall) if (!(await lockOf(t)) && !emptied.has(t.id)) { home = t; break; }

  // Work lines with no rate item are written in the dispatch notes.
  const loose = (ls: QuoteLine[]) => ls.filter((l) => !l.rateItemId).map((l) => `${key(l.description)}|${num(l.qty)}|${l.unit}`).sort().join("\n");
  const looseChanged = loose(beforeWork) !== loose(afterWork);
  const afterLoose = afterWork.filter((l) => !l.rateItemId);

  // A dispatch left with only notes still holds the lines with no rate item,
  // when it is the one carrying them or they changed and need a home.
  if (!home && afterLoose.length) {
    const kept = byInstall.find((t) => emptied.has(t.id) && (looseChanged || (t.description ?? "").includes("Also on the quote: ")));
    if (kept) {
      home = kept;
      emptied.delete(kept.id);
    }
  }

  if (!home && (toAdd.size || (looseChanged && afterLoose.length))) {
    const fresh = afterWork.filter((l) => (l.rateItemId != null && toAdd.has(l.rateItemId)) || (looseChanged && !l.rateItemId));
    const made = await insertDispatchForLines(jobId, fresh, afterSupply, ++seq, furniture, quoteId);
    out.tasksAdded += 1;
    out.changes.push(`Dispatch "${made.title}" added for ${fresh.map((l) => l.description).join(", ")}.`);
    if (quoteTasks.length) out.flags.push(`The new quote adds work (${fresh.map((l) => l.description).join(", ")}). The job's dispatch is already with crew, so a new dispatch "${made.title}" was made for it.`);
  } else if (home) {
    if (toAdd.size) {
      await addLabour(home.id, toAdd);
      touched.add(home.id);
      out.changes.push(`Dispatch "${home.title}": ${[...toAdd.keys()].map(name).join(", ")} added.`);
    }
    if (looseChanged) {
      const description = withFreeTextNote(home.description, afterWork);
      if (description !== home.description) {
        await db.update(schema.jobTasks).set({ description, updatedAt: now }).where(eq(schema.jobTasks.id, home.id));
        out.changes.push(`Dispatch "${home.title}": notes updated with the work lines that have no rate book item.`);
        touched.add(home.id);
      }
    }
  } else if (looseChanged) {
    out.flags.push("Work lines with no rate book item changed on the new quote, and the job's dispatch is already with crew. Check its notes by hand.");
  }

  for (const id of emptied) {
    const task = quoteTasks.find((t) => t.id === id)!;
    await db.update(schema.jobTasks).set({ status: "cancelled", updatedAt: now }).where(eq(schema.jobTasks.id, id));
    out.changes.push(`Dispatch "${task.title}" cancelled, nothing on it is on the new quote.`);
    out.tasksCancelled += 1;
    touched.delete(id);
  }
  out.tasksUpdated += touched.size;
}

export interface Rework {
  /** What Ops changed, for the job log and the office task. */
  changes: string[];
  /** What the office needs to sort by hand. Sent to the office as a notification. */
  flags: string[];
  tasksAdded: number;
  tasksUpdated: number;
  tasksCancelled: number;
  materialsAdded: number;
  materialsUpdated: number;
  materialsRemoved: number;
}

export async function reworkJobForVersion(args: { jobId: number; fromQuoteId: number; toQuoteId: number }): Promise<Rework> {
  const out: Rework = { changes: [], flags: [], tasksAdded: 0, tasksUpdated: 0, tasksCancelled: 0, materialsAdded: 0, materialsUpdated: 0, materialsRemoved: 0 };
  if (args.fromQuoteId === args.toQuoteId) return out;
  const before = await quoteLines(args.fromQuoteId);
  const after = await quoteLines(args.toQuoteId);
  const now = new Date();
  const [job] = await db.select({ furnitureOnSite: schema.jobs.furnitureOnSite }).from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
  const furniture = job?.furnitureOnSite ?? false;

  /* -------------------------------- dispatches ------------------------------- */
  await reworkDispatches(args.jobId, before.work, after.work, furniture, after.supply, args.toQuoteId, out);

  /* -------------------------------- materials -------------------------------- */
  const mats = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, args.jobId)).orderBy(schema.jobMaterials.id);
  const matKey = (productId: number | null, description: string) => (productId ? `p:${productId}` : `d:${key(description)}`);
  const matPairs = pairUp(before.supply, mats, (l) => matKey(l.productId, l.description), (m) => matKey(m.productId, m.description));
  const leftMats = [...matPairs];
  for (const line of after.supply) {
    const k = matKey(line.productId, line.description);
    const i = leftMats.findIndex((p) => matKey(p.line.productId, p.line.description) === k);
    const pair = i >= 0 ? leftMats.splice(i, 1)[0] : undefined;
    const m = pair?.row ?? null;
    if (m) {
      if (same(m.qty, line.qty) && m.unit === line.unit && m.description === line.description) continue;
      const lock = await materialLock(m);
      if (lock) {
        if (!same(m.qty, line.qty) || m.unit !== line.unit) {
          out.flags.push(`Material "${m.description}" is ${lock} at ${qtyText(m.qty, m.unit)}. The new quote needs ${qtyText(line.qty, line.unit)}. Not changed.`);
        }
      } else {
        await db
          .update(schema.jobMaterials)
          .set({ qty: line.qty, unit: line.unit, description: line.description, updatedAt: now })
          .where(eq(schema.jobMaterials.id, m.id));
        if (!same(m.qty, line.qty) || m.unit !== line.unit) {
          out.changes.push(`Material "${line.description}" updated from ${qtyText(m.qty, m.unit)} to ${qtyText(line.qty, line.unit)}.`);
          out.materialsUpdated += 1;
        }
      }
      continue;
    }
    await db.insert(schema.jobMaterials).values({
      jobId: args.jobId,
      productId: line.productId,
      description: line.description,
      qty: line.qty,
      unit: line.unit,
      status: "to_order",
    });
    out.materialsAdded += 1;
    out.changes.push(`Material "${line.description}" added, ${qtyText(line.qty, line.unit)} to order.`);
    if (pair) out.flags.push(`Added "${line.description}" to order. The material from the earlier version was not found (renamed or removed by hand?). Check the job for doubles.`);
  }
  for (const p of leftMats) {
    const m = p.row;
    if (!m) continue;
    const lock = await materialLock(m);
    if (lock) {
      out.flags.push(`Material "${m.description}" is not on the new quote but is ${lock}. Kept.`);
    } else {
      await db.delete(schema.jobMaterials).where(eq(schema.jobMaterials.id, m.id));
      out.changes.push(`Material "${m.description}" removed, it is not on the new quote.`);
      out.materialsRemoved += 1;
    }
  }

  return out;
}

/**
 * Before a job-first accept makes the work: dispatches and materials already
 * on the job (added by hand) that match a line on the quote. Ops still makes
 * the quote's ones, and the office is told there may be two of each.
 */
export async function doublesBeforeBuild(quoteId: number, jobId: number): Promise<string[]> {
  const lines = await quoteLines(quoteId);
  const tasks = await db
    .select({ title: schema.jobTasks.title })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  const mats = await db
    .select({ productId: schema.jobMaterials.productId, description: schema.jobMaterials.description })
    .from(schema.jobMaterials)
    .where(eq(schema.jobMaterials.jobId, jobId));
  const matKey = (productId: number | null, description: string) => (productId ? `p:${productId}` : `d:${key(description)}`);
  const out: string[] = [];
  const handLines = tasks.length
    ? await db
        .select({ itemId: schema.taskLabourLines.itemId, title: schema.jobTasks.title })
        .from(schema.taskLabourLines)
        .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskLabourLines.taskId))
        .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
    : [];
  const said = new Set<string>();
  for (const line of lines.work) {
    const byLine = line.rateItemId ? handLines.find((h) => h.itemId === line.rateItemId) : undefined;
    const byTitle = tasks.find((t) => key(t.title) === key(line.description));
    const title = byLine?.title ?? byTitle?.title;
    if (!title || said.has(title)) continue;
    said.add(title);
    out.push(`Dispatch "${title}" was already on the job with work that is on the quote, and the quote made its own dispatch too. Merge them or cancel one.`);
  }
  for (const line of lines.supply) {
    if (mats.some((m) => matKey(m.productId, m.description) === matKey(line.productId, line.description))) {
      out.push(`Material "${line.description}" was already on the job, and the quote added it to order again. Remove one of them.`);
    }
  }
  return out;
}

/** One line for the job log: what moved, in numbers. */
export function reworkSummary(r: Rework) {
  const bits = [
    r.tasksAdded ? `${r.tasksAdded} dispatch${r.tasksAdded === 1 ? "" : "es"} added` : "",
    r.tasksUpdated ? `${r.tasksUpdated} updated` : "",
    r.tasksCancelled ? `${r.tasksCancelled} cancelled` : "",
    r.materialsAdded ? `${r.materialsAdded} material${r.materialsAdded === 1 ? "" : "s"} added` : "",
    r.materialsUpdated ? `${r.materialsUpdated} material${r.materialsUpdated === 1 ? "" : "s"} updated` : "",
    r.materialsRemoved ? `${r.materialsRemoved} material${r.materialsRemoved === 1 ? "" : "s"} removed` : "",
    r.flags.length ? `${r.flags.length} to sort by hand` : "",
  ].filter(Boolean);
  return bits.length ? bits.join(", ") : "nothing needed changing";
}
