import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { termsOn } from "./hourly";
import { todayLocal } from "./local-date";

/*
 * Pay not set (Damien, 10 Nov 2026, job 188016 / dispatch 188016-B).
 *
 * A fixed-price dispatch with no measured lines, no frozen labour and no
 * agreed amount has no pay at all. It used to be booked anyway, and the crew
 * app showed a dash under Your pay while Money out carried the installer's
 * allowance. That is never "free work" and never an apparent $0.00: it reads
 * "Pay not set / Office review required" and new paid work stops until the
 * pay is confirmed.
 *
 * Left alone: hourly work (paid on approved time, its own checks), Terra
 * employees and staff cards (paid wages, not per job), a Measure & quote
 * visit (a sales visit, not installing work), and a $0.00 amount the office
 * typed in on purpose (a callback Terra isn't paying for).
 * Existing bookings are flagged, never cancelled or changed.
 */

export const PAY_NOT_SET = "Pay not set / Office review required";

export type PayFacts = {
  payType: string;
  payAmount: number | null;
  labourCost: number | null;
  agreedHourlyRate?: number | null;
  /** Measured labour lines on the dispatch. */
  lineCount: number;
  /** Paid on hourly terms, an employee or a staff card. */
  notPerJob?: boolean;
  /** A Measure & quote visit: not installing work. */
  visit?: boolean;
};

/** True when this fixed-price dispatch has no agreed pay of any kind. */
export function payNotSet(f: PayFacts): boolean {
  if (f.notPerJob || f.visit) return false;
  if (f.payType === "hourly" || f.agreedHourlyRate != null) return false;
  // An amount the office typed, even $0.00 on purpose, is a decision.
  if (f.payAmount != null) return false;
  if (f.labourCost != null && f.labourCost > 0) return false;
  return f.lineCount === 0;
}

/** What the crew card says about the pay. "not_set" never shows as a dash or $0.00. */
export function payStatusOf(f: PayFacts & { payTotal: number | null }): "set" | "not_set" | "hourly" {
  if (f.payType === "hourly") return "hourly";
  if (f.notPerJob || f.visit) return "set";
  if (f.payAmount != null) return "set";
  if (f.payTotal != null && f.payTotal > 0) return "set";
  if (f.labourCost != null && f.labourCost > 0) return "set";
  return "not_set";
}

/** Skills that are a Measure & quote visit, not installing work (same test as the phone agent's visits). */
export async function visitSkillIds(): Promise<Set<number>> {
  const rows = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(sql`lower(${schema.skills.name}) like 'measure%'`);
  return new Set(rows.map((r) => r.id));
}

/** Paid by the hour, a Terra employee, or a staff card: never priced per job. */
export async function notPerJobPeople(installerIds: number[], on: string = todayLocal()): Promise<Set<number>> {
  const ids = [...new Set(installerIds.filter((i): i is number => i != null))];
  const out = new Set<number>();
  if (!ids.length) return out;
  const [people, cards] = await Promise.all([
    db.select({ id: schema.installers.id, workerType: schema.installers.workerType }).from(schema.installers).where(inArray(schema.installers.id, ids)),
    db.select({ id: schema.staffCards.installerId }).from(schema.staffCards).where(inArray(schema.staffCards.installerId, ids)),
  ]);
  for (const p of people) if (p.workerType === "employee") out.add(p.id);
  for (const c of cards) if (c.id != null) out.add(c.id);
  for (const id of ids) {
    if (out.has(id)) continue;
    const terms = await termsOn(id, on);
    if (terms?.defaultForNew) out.add(id);
  }
  return out;
}

/** The words shown on the office screens and in a refused booking or offer. */
export function payNotSetMessage(doing = "giving this work out"): string {
  return `${PAY_NOT_SET}. This dispatch has no measured lines and no agreed pay. Measure up the work or enter the agreed amount before ${doing}.`;
}

/**
 * Why this dispatch can't be given to this person as paid work, or null.
 * typedPay is an amount the office is giving with the offer or booking.
 */
export async function payBarrier(taskId: number, installerId: number, typedPay?: number | null, doing?: string): Promise<string | null> {
  if (typedPay != null) return null;
  const [task] = await db
    .select({
      payType: schema.jobTasks.payType,
      payAmount: schema.jobTasks.payAmount,
      labourCost: schema.jobTasks.labourCost,
      agreedHourlyRate: schema.jobTasks.agreedHourlyRate,
      skillId: schema.jobTasks.skillId,
    })
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.id, taskId));
  if (!task) return null;
  if (task.skillId != null && (await visitSkillIds()).has(task.skillId)) return null;
  const lines = await db.select({ id: schema.taskLabourLines.id }).from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, taskId));
  if (lines.length) return null;
  const off = await notPerJobPeople([installerId]);
  return payNotSet({ ...task, lineCount: 0, notPerJob: off.has(installerId) }) ? payNotSetMessage(doing) : null;
}

/** Booked fixed-price dispatches with no pay, for the office flag. Read only. */
export async function payNotSetTaskIds(taskIds: number[]): Promise<Set<number>> {
  const ids = [...new Set(taskIds)];
  const out = new Set<number>();
  if (!ids.length) return out;
  const [tasks, lines] = await Promise.all([
    db
      .select({
        id: schema.jobTasks.id,
        status: schema.jobTasks.status,
        installerId: schema.jobTasks.assignedInstallerId,
        payType: schema.jobTasks.payType,
        payAmount: schema.jobTasks.payAmount,
        labourCost: schema.jobTasks.labourCost,
        agreedHourlyRate: schema.jobTasks.agreedHourlyRate,
        skillId: schema.jobTasks.skillId,
      })
      .from(schema.jobTasks)
      .where(inArray(schema.jobTasks.id, ids)),
    db.select({ taskId: schema.taskLabourLines.taskId }).from(schema.taskLabourLines).where(inArray(schema.taskLabourLines.taskId, ids)),
  ]);
  const booked = tasks.filter((t) => t.installerId != null && t.status !== "cancelled");
  const [off, visits] = await Promise.all([notPerJobPeople(booked.map((t) => t.installerId!)), visitSkillIds()]);
  for (const t of booked) {
    const lineCount = lines.filter((l) => l.taskId === t.id).length;
    const visit = t.skillId != null && visits.has(t.skillId);
    if (payNotSet({ ...t, lineCount, notPerJob: off.has(t.installerId!), visit })) out.add(t.id);
  }
  return out;
}
