import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { insertTaskForLine, quoteLines, type QuoteLine } from "./quote-convert";

/* ---------------------------------------------------------------------------
 * A later version of a quote is accepted on a job that already has the
 * dispatches and materials of an earlier one (item 7, Damien 10 Oct).
 *
 * Each dispatch and material is matched to the earlier version's line it was
 * made from (by its wording, or the product for a material). Then, line by line:
 *
 *   same line, new numbers   free ones are updated, the rest are flagged
 *   line gone                free ones are cancelled or removed, the rest flagged
 *   new line                 a new dispatch or material is made
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

type Task = typeof schema.jobTasks.$inferSelect;
type Material = typeof schema.jobMaterials.$inferSelect;

/** Why a dispatch cannot be touched, or null when it is free. */
async function taskLock(task: Task): Promise<string | null> {
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
  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, args.jobId), ne(schema.jobTasks.status, "cancelled")))
    .orderBy(schema.jobTasks.seq, schema.jobTasks.id);
  const taskPairs = pairUp(before.work, tasks, (l) => key(l.description), (t) => key(t.title));
  const tasksWereMade = before.work.length === 0 || taskPairs.some((p) => p.row);
  if (!tasksWereMade) {
    if (after.work.length) out.flags.push("No dispatches were made from the earlier version, so none were made for this one. Add them on the job if they are needed.");
  } else {
    const [top] = await db
      .select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` })
      .from(schema.jobTasks)
      .where(eq(schema.jobTasks.jobId, args.jobId));
    let seq = Number(top?.max ?? 0);
    const left = [...taskPairs];
    for (const line of after.work) {
      const i = left.findIndex((p) => key(p.line.description) === key(line.description));
      const pair = i >= 0 ? left.splice(i, 1)[0] : undefined;
      const task = pair?.row ?? null;
      if (task) {
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
        continue;
      }
      await insertTaskForLine(args.jobId, line, ++seq, furniture);
      out.tasksAdded += 1;
      if (pair) {
        out.changes.push(`Dispatch "${line.description}" made.`);
        out.flags.push(`Made a new dispatch for "${line.description}". The one from the earlier version was not found (renamed or removed by hand?). Check the job for doubles.`);
      } else {
        out.changes.push(`Dispatch "${line.description}" added.`);
      }
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
  }

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
  for (const line of lines.work) {
    if (tasks.some((t) => key(t.title) === key(line.description))) {
      out.push(`Dispatch "${line.description}" was already on the job, and the quote made another. Cancel one of them.`);
    }
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
