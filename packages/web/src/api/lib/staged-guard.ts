import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * STAGED JOBS, the small checks other parts of Ops ask (Damien, 12 Nov 2026).
 *
 * Kept apart from lib/staged-jobs.ts on purpose: the field app, the job
 * status chain, the forecast and the invoice routes only need to know "is
 * work still waiting on this job", and must not pull in the whole staging
 * module (or loop back through the invoice code) to find out.
 *
 * Only an AGREED plan holds anything back. A draft is a proposal nobody has
 * confirmed yet, so it changes nothing.
 * ------------------------------------------------------------------------- */

export const PART_COMPLETE_STATUS = "Part complete, awaiting client/builder";

export type OpenStaging = {
  planId: number;
  kind: string;
  openStages: number;
  /** The seq of the last open stage: the visit that finishes the job. */
  lastOpenSeq: number | null;
  /** Latest expected date of the open stages, null when any of them is awaiting readiness with no date. */
  returnDate: string | null;
  followUpDate: string | null;
};

/** The agreed plan on this job with work still open, or null. */
export async function openStaging(jobId: number): Promise<OpenStaging | null> {
  const [plan] = await db
    .select()
    .from(schema.jobStagePlans)
    .where(and(eq(schema.jobStagePlans.jobId, jobId), eq(schema.jobStagePlans.status, "agreed")))
    .limit(1);
  if (!plan) return null;
  const open = await db
    .select({ seq: schema.jobStages.seq, plannedDate: schema.jobStages.plannedDate })
    .from(schema.jobStages)
    .where(and(eq(schema.jobStages.planId, plan.id), eq(schema.jobStages.status, "open")));
  if (!open.length) return null;
  const dates = open.map((s) => s.plannedDate).filter((d): d is string => !!d);
  return {
    planId: plan.id,
    kind: plan.kind,
    openStages: open.length,
    lastOpenSeq: Math.max(...open.map((s) => s.seq)),
    returnDate: dates.length ? dates.sort().at(-1)! : null,
    followUpDate: plan.followUpDate,
  };
}

/**
 * Field app: may this task be marked finished? Not while a stage other than
 * the last one is still open and this task is part of the staged work. The
 * installer finishing the first visit is a stage, recorded by the office.
 */
export async function stagedFinishBlock(task: { id: number; jobId: number; labourBreakdown: string | null; payType: string }) {
  const open = await openStaging(task.jobId);
  if (!open || open.openStages < 2) return null;
  const [row] = await db
    .select({ id: schema.jobStagePay.id })
    .from(schema.jobStagePay)
    .where(and(eq(schema.jobStagePay.planId, open.planId), eq(schema.jobStagePay.taskId, task.id)))
    .limit(1);
  if (!row && !task.labourBreakdown && task.payType !== "hourly") return null;
  return "This job is being done in stages and this is not the last visit. Tell Terra office this stage is finished. They record it and approve your pay for it.";
}

/** Forecast: when the remaining work is expected, job by job. The return date, else the follow-up date. */
export async function stagedForecastDates(jobIds: number[]) {
  const out = new Map<number, { date: string; basis: string }>();
  if (!jobIds.length) return out;
  const plans = await db
    .select()
    .from(schema.jobStagePlans)
    .where(and(inArray(schema.jobStagePlans.jobId, jobIds), eq(schema.jobStagePlans.status, "agreed")));
  if (!plans.length) return out;
  const stages = await db
    .select({ planId: schema.jobStages.planId, plannedDate: schema.jobStages.plannedDate })
    .from(schema.jobStages)
    .where(and(inArray(schema.jobStages.planId, plans.map((p) => p.id)), eq(schema.jobStages.status, "open")));
  for (const p of plans) {
    const open = stages.filter((s) => s.planId === p.id);
    if (!open.length) continue;
    const dates = open.map((s) => s.plannedDate).filter((d): d is string => !!d).sort();
    if (dates.length) out.set(p.jobId, { date: dates.at(-1)!, basis: `remaining stage expected ${dates.at(-1)}` });
    else if (p.followUpDate) out.set(p.jobId, { date: p.followUpDate, basis: `remaining stage awaiting readiness, follow up ${p.followUpDate}` });
  }
  return out;
}

/**
 * Installer claims on a staged task: his approved stage pay not claimed yet.
 * Null when the task is not staged, so the normal whole-task invoice applies.
 * An empty list means it IS staged and nothing is claimable right now.
 */
export async function stagedClaimRows(taskId: number, installerId: number) {
  const plans = await db
    .select({ id: schema.jobStagePay.planId })
    .from(schema.jobStagePay)
    .innerJoin(schema.jobStagePlans, eq(schema.jobStagePlans.id, schema.jobStagePay.planId))
    .where(and(eq(schema.jobStagePay.taskId, taskId), inArray(schema.jobStagePlans.status, ["agreed", "complete"])))
    .limit(1);
  if (!plans.length) return null;
  return db
    .select({ pay: schema.jobStagePay, stageName: schema.jobStages.name, stageSeq: schema.jobStages.seq })
    .from(schema.jobStagePay)
    .innerJoin(schema.jobStages, eq(schema.jobStages.id, schema.jobStagePay.stageId))
    .where(
      and(
        eq(schema.jobStagePay.planId, plans[0]!.id),
        eq(schema.jobStagePay.taskId, taskId),
        eq(schema.jobStagePay.installerId, installerId),
        isNotNull(schema.jobStagePay.approvedAt),
        isNull(schema.jobStagePay.claimInvoiceId),
        isNotNull(schema.jobStagePay.amount),
        sql`${schema.jobStagePay.lineKey} <> 'hourly'`,
      ),
    );
}

/** Does this person have staged pay on this task (so he keeps access after the rest is reassigned)? */
export async function hasStagePayOn(taskId: number, installerId: number) {
  const [row] = await db
    .select({ id: schema.jobStagePay.id })
    .from(schema.jobStagePay)
    .where(and(eq(schema.jobStagePay.taskId, taskId), eq(schema.jobStagePay.installerId, installerId)))
    .limit(1);
  return !!row;
}
