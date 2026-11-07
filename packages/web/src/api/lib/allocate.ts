import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { checkDays } from "./availability";
import { DISPATCH_SPLIT, DispatchError, splitDispatch, taskLock } from "./dispatch-build";
import { checkOutsideHours } from "./outside-hours";
import { missingSkills, sayList, skillsForTask } from "./task-skills";
import { lockedItems } from "./rate-access";
import { todayLocal } from "./local-date";
import { hourlyRateBarrier } from "./hourly";
import { bookTask } from "../routes/tasks";

/* ---------------------------------------------------------------------------
 * Allocate / Dispatch labour (Damien's brief, 7 Nov 2026, section 1).
 *
 * On the existing job: tick some or all of a dispatch's labour lines, pick
 * the installer, the date and the start and finish, review it, then book it.
 * Ticking only some lines splits them onto their own dispatch first (the
 * same Split by trade the job page already has), so each person's visit is
 * one dispatch with its own lines and is paid once. Nothing here sends a
 * message, an offer or an invoice.
 *
 * Materials, freight, delivery and disposal are never labour lines, so they
 * never reach pay. The stair rate covers the nosing: a stairs line and a
 * nosing fit line on the same job would pay the stairs twice, so that is
 * refused until one comes off.
 * ------------------------------------------------------------------------- */

const GOODS = new Set(["supply", "accessory", "delivery", "supplier_charge", "internal_charge", "other"]);

export type AllocationStatus = "unassigned" | "offered" | "accepted" | "assigned" | "booked" | "completed" | "cancelled";

/** The brief's six states, read off the task, its offers and its booked days. */
async function statusOf(task: typeof schema.jobTasks.$inferSelect): Promise<AllocationStatus> {
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "complete") return "completed";
  if (task.status === "offered") return "offered";
  const [offer] = await db
    .select({ status: schema.taskOffers.status })
    .from(schema.taskOffers)
    .where(and(eq(schema.taskOffers.taskId, task.id), inArray(schema.taskOffers.status, ["pending", "provisional", "accepted"])))
    .orderBy(desc(schema.taskOffers.id))
    .limit(1);
  if (task.status === "unassigned") return offer && offer.status !== "accepted" ? "offered" : "unassigned";
  const [day] = await db
    .select({ id: schema.taskDays.id })
    .from(schema.taskDays)
    .where(and(eq(schema.taskDays.taskId, task.id), eq(schema.taskDays.status, "booked")))
    .limit(1);
  if (day) return "booked";
  return offer?.status === "accepted" ? "accepted" : "assigned";
}

/** Items done under the Nosings skill, and stair items (priced per step). */
async function nosingClash(itemIds: number[]) {
  if (!itemIds.length) return null;
  const rows = await db
    .select({ id: schema.labourRateItems.id, name: schema.labourRateItems.name, unit: schema.labourRateItems.unit, skill: schema.skills.name })
    .from(schema.labourRateItems)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.labourRateItems.skillId))
    .where(inArray(schema.labourRateItems.id, [...new Set(itemIds)]));
  const stairs = rows.filter((r) => r.unit === "step");
  const nosing = rows.filter((r) => /nosing/i.test(r.skill ?? ""));
  if (!stairs.length || !nosing.length) return null;
  return `${nosing.map((n) => n.name).join(", ")} would pay the nosing again on top of ${stairs[0]!.name}. The stair rate covers the nosing, so take the nosing line off first.`;
}

/** Every dispatch on the job as the allocation view shows it, plus what is not pay. */
export async function allocationView(jobId: number) {
  const tasks = await db
    .select({ task: schema.jobTasks, installer: schema.installers })
    .from(schema.jobTasks)
    .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
    .where(eq(schema.jobTasks.jobId, jobId))
    .orderBy(asc(schema.jobTasks.seq), asc(schema.jobTasks.id));
  const ids = tasks.map((t) => t.task.id);
  const [lines, days] = ids.length
    ? await Promise.all([
        db
          .select({ line: schema.taskLabourLines, item: schema.labourRateItems, skill: schema.skills })
          .from(schema.taskLabourLines)
          .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
          .leftJoin(schema.skills, eq(schema.skills.id, schema.labourRateItems.skillId))
          .where(inArray(schema.taskLabourLines.taskId, ids))
          .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id)),
        db
          .select({ taskId: schema.taskDays.taskId, date: schema.taskDays.date, arrivalStart: schema.taskDays.arrivalStart, arrivalEnd: schema.taskDays.arrivalEnd })
          .from(schema.taskDays)
          .where(and(inArray(schema.taskDays.taskId, ids), eq(schema.taskDays.status, "booked")))
          .orderBy(asc(schema.taskDays.date)),
      ])
    : [[], []];

  const dispatches = [];
  for (const { task, installer } of tasks) {
    const status = await statusOf(task);
    dispatches.push({
      id: task.id,
      title: task.title,
      status,
      lock: status === "cancelled" ? "cancelled" : await taskLock(task),
      installer: installer ? { id: installer.id, name: installer.name } : null,
      durationHours: task.durationHours,
      days: days.filter((d) => d.taskId === task.id).map(({ date, arrivalStart, arrivalEnd }) => ({ date, arrivalStart, arrivalEnd })),
      lines: lines
        .filter((l) => l.line.taskId === task.id)
        .map((l) => ({ itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty, skill: l.skill?.name ?? null })),
    });
  }

  // The accepted quote's lines that are not labour pay, so the review can say so.
  const [quote] = await db
    .select({ id: schema.quotes.id })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.id))
    .limit(1);
  const quoteLines = quote
    ? await db
        .select({ id: schema.quoteItems.id, kind: schema.quoteItems.kind, description: schema.quoteItems.description, qty: schema.quoteItems.qty, unit: schema.quoteItems.unit, rateItemId: schema.quoteItems.rateItemId })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quote.id))
    : [];
  return {
    dispatches,
    /** Materials, freight, delivery and disposal: never on anyone's pay. */
    notPay: quoteLines.filter((l) => GOODS.has(l.kind)).map(({ id, kind, description, qty, unit }) => ({ id, kind, description, qty, unit })),
    /** Work on the quote with no rate book line, so no one is paid for it until one is added. */
    unpricedWork: quoteLines.filter((l) => !GOODS.has(l.kind) && !l.rateItemId).map(({ id, kind, description, qty, unit }) => ({ id, kind, description, qty, unit })),
  };
}

export type AllocateInput = {
  taskId: number;
  itemIds: number[];
  installerId: number;
  dates: string[];
  arrivalStart?: string | null;
  arrivalEnd?: string | null;
  durationHours?: number | null;
  title?: string | null;
  confirmOutsideHours?: boolean;
  replaceInstaller?: boolean;
  /** Why the office is booking over another booking that overlaps. */
  overrideNote?: string | null;
};

/**
 * What booking these lines would do, without writing anything: the scope,
 * the recipient, the skills and who is missing them, clashes, outside-hours
 * days and anything that stops it. The review screen shows this.
 */
export async function previewAllocation(input: AllocateInput, actor: Actor) {
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
  if (!task) throw new ORPCError("NOT_FOUND", { message: "Dispatch not found" });
  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
  if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });

  const lines = await db
    .select({ line: schema.taskLabourLines, item: schema.labourRateItems })
    .from(schema.taskLabourLines)
    .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
    .where(eq(schema.taskLabourLines.taskId, task.id));
  const picked = lines.filter((l) => input.itemIds.includes(l.item.id));
  const whole = picked.length === lines.length;
  const stops: string[] = [];
  if (!picked.length) stops.push("Tick at least one line to allocate.");
  if (picked.length !== new Set(input.itemIds).size) stops.push("Some of the ticked lines are no longer on this dispatch. Reload the job.");

  const needs = await skillsForTask(task.id, picked.map((l) => l.item.id));
  const missing = await missingSkills(installer.id, needs);
  if (missing.length) stops.push(`${installer.name} isn't ticked for ${sayList(missing.map((m) => m.name))}.`);
  const locked = await lockedItems(installer.id, picked.map((l) => l.item.id), todayLocal());
  if (locked.length) stops.push(`${sayList(locked.map((l) => l.name))} isn't switched on for ${installer.name}'s rate card.`);
  const hourlyStop = await hourlyRateBarrier(installer.id);
  if (hourlyStop) stops.push(hourlyStop);
  if (installer.archivedAt || !installer.active) stops.push(`${installer.name} is ${installer.archivedAt ? "archived" : "switched off"}.`);

  // Booked or offered already: whole dispatch only, as a reviewed change; never a part of it.
  const lock = await taskLock(task);
  let replacing: string | null = null;
  if (lock) {
    if (!whole) stops.push(`This dispatch is ${lock}. Lines can't be taken off it until it is taken back off the crew.`);
    else if (lock === "offered to crew") stops.push("This dispatch is out as an offer. Withdraw the offer first.");
    else if (task.status === "in_progress" || task.status === "complete") stops.push(`This dispatch is ${lock}, so it can't be given to someone else.`);
    else if (task.assignedInstallerId && task.assignedInstallerId !== installer.id) {
      const [prev] = await db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, task.assignedInstallerId));
      replacing = prev?.name ?? "another installer";
    }
  }

  // Nosing on top of a stair rate, across every live dispatch on the job.
  const others = await db
    .select({ itemId: schema.taskLabourLines.itemId })
    .from(schema.taskLabourLines)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskLabourLines.taskId))
    .where(and(eq(schema.jobTasks.jobId, task.jobId), ne(schema.jobTasks.status, "cancelled")));
  const nosing = await nosingClash(others.map((o) => o.itemId));
  if (nosing) stops.push(nosing);

  const dates = [...new Set(input.dates)].sort();
  if (!dates.length) stops.push("Pick a date.");
  if (!input.arrivalStart) stops.push("Pick a start time.");

  const hours = input.durationHours ?? task.durationHours;
  const days = dates.map((date) => ({ date, arrivalStart: input.arrivalStart ?? null, arrivalEnd: input.arrivalEnd ?? null }));
  // Asked as already confirmed, so it only lists the days; the booking asks for real.
  const outside = checkOutsideHours({ days, durationHours: hours, confirmed: true, actor });
  const checks = dates.length
    ? await checkDays({ installerId: installer.id, dates, exceptTaskId: task.id, times: input.arrivalStart ? { durationHours: hours, days } : null })
    : [];
  const clashes = checks.flatMap((c) => c.clashes.map((x) => ({ date: c.date, title: x.title, when: x.when ?? null, untimed: Boolean(x.untimed) })));
  const sameDay = checks.flatMap((c) => (c.sameDay ?? []).map((x) => ({ date: c.date, title: x.title, when: x.when })));
  const unavailable = checks.filter((c) => c.status !== "available").map((c) => ({ date: c.date, status: c.status, reason: c.reason }));

  return {
    taskId: task.id,
    /** True when every line goes, so the dispatch is booked as it is, not split. */
    whole,
    recipient: { id: installer.id, name: installer.name },
    replacing,
    lines: picked.map((l) => ({ itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty })),
    staying: lines.filter((l) => !input.itemIds.includes(l.item.id)).map((l) => ({ itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty })),
    skills: needs.map((n) => n.name),
    dates,
    arrivalStart: input.arrivalStart ?? null,
    arrivalEnd: input.arrivalEnd ?? null,
    durationHours: hours,
    outsideHours: outside,
    clashes,
    sameDay,
    unavailable,
    stops,
  };
}

/** Puts split-off lines back when the booking after the split was refused. */
async function undoSplit(fromId: number, createdId: number, before: { skillId: number | null; areaM2: number | null }) {
  await db.update(schema.taskLabourLines).set({ taskId: fromId, updatedAt: new Date() }).where(eq(schema.taskLabourLines.taskId, createdId));
  await db.update(schema.jobTasks).set({ skillId: before.skillId, areaM2: before.areaM2, updatedAt: new Date() }).where(eq(schema.jobTasks.id, fromId));
  await db.delete(schema.activityLog).where(and(eq(schema.activityLog.taskId, createdId), eq(schema.activityLog.action, DISPATCH_SPLIT)));
  await db.delete(schema.jobTasks).where(eq(schema.jobTasks.id, createdId));
}

/**
 * Books the ticked lines to one installer as one visit. Refused with the
 * review's reasons when anything stops it, before anything is written. A
 * clash needs a reason typed by the office; the outside-hours confirm never
 * stands in for it.
 */
export async function allocate(input: AllocateInput, actor: Actor) {
  const review = await previewAllocation(input, actor);
  if (review.stops.length) throw new ORPCError("BAD_REQUEST", { message: review.stops.join(" "), data: { reason: "allocation_stopped", stops: review.stops } });
  if (review.clashes.length && !input.overrideNote?.trim()) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${review.recipient.name} already has work at that time: ${review.clashes.map((c) => `${c.title}${c.when ? ` (${c.when})` : ""}`).join("; ")}. Pick another time, or give a reason to book over it.`,
      data: { reason: "clash", clashes: review.clashes },
    });
  }
  if (review.replacing && !input.replaceInstaller) {
    throw new ORPCError("BAD_REQUEST", {
      message: `This dispatch is booked to ${review.replacing}. Review the change and confirm taking it off ${review.replacing} before giving it to ${review.recipient.name}.`,
      data: { reason: "replace_installer", from: review.replacing },
    });
  }
  // Asked here too, so a part-split is never made for a booking that then stops on the hours.
  checkOutsideHours({
    days: review.dates.map((date) => ({ date, arrivalStart: review.arrivalStart, arrivalEnd: review.arrivalEnd })),
    durationHours: review.durationHours,
    confirmed: input.confirmOutsideHours,
    actor,
  });

  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
  let targetId = task!.id;
  let created: number | null = null;
  if (!review.whole) {
    try {
      const row = await splitDispatch({ taskId: task!.id, itemIds: review.lines.map((l) => l.itemId), title: input.title ?? null }, actor);
      targetId = row.id;
      created = row.id;
    } catch (error) {
      if (error instanceof DispatchError) throw new ORPCError("BAD_REQUEST", { message: error.message });
      throw error;
    }
  }
  try {
    const booked = await bookTask(
      {
        taskId: targetId,
        installerId: input.installerId,
        dates: review.dates,
        arrivalStart: review.arrivalStart,
        arrivalEnd: review.arrivalEnd,
        durationHours: input.durationHours ?? null,
        coordinateAfterFirst: false,
        perDay: [],
        overrideNote: input.overrideNote?.trim() || null,
        confirmOutsideHours: input.confirmOutsideHours,
        replaceInstaller: input.replaceInstaller,
      },
      actor,
    );
    return { taskId: targetId, split: created != null, dates: booked.dates };
  } catch (error) {
    if (created != null) await undoSplit(task!.id, created, { skillId: task!.skillId, areaM2: task!.areaM2 });
    throw error;
  }
}
