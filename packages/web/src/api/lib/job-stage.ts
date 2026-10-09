import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * A quote linked to a job has gone out, so the job is no longer just a lead.
 *
 * Damien's rule: a job sitting on Lead moves to Quoted when its quote is
 * sent. Only from Lead (or no status at all). A job already further along,
 * Won or Scheduled say, is never moved back by a requote.
 *
 * Statuses are editable data, so they are found by name. If either one has
 * been renamed or switched off, nothing moves and nothing breaks.
 * ------------------------------------------------------------------------- */

const byName = (name: string) =>
  db
    .select()
    .from(schema.jobStatuses)
    .where(and(eq(schema.jobStatuses.active, true), sql`lower(${schema.jobStatuses.name}) = ${name}`))
    .limit(1);

export async function leadToQuotedOnSend(args: {
  jobId: number | null;
  quoteNumber: number | string;
  actor: { name: string; role: string };
}) {
  if (!args.jobId) return null;
  const [job] = await db
    .select({ id: schema.jobs.id, statusId: schema.jobs.statusId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, args.jobId));
  if (!job) return null;

  const [[lead], [quoted]] = await Promise.all([byName("lead"), byName("quoted")]);
  if (!quoted) return null;
  if (job.statusId !== null && job.statusId !== lead?.id) return null;

  // Only moves it if it is still where we read it, so two sends at once log once.
  const moved = await db
    .update(schema.jobs)
    .set({ statusId: quoted.id, updatedAt: new Date() })
    .where(
      and(
        eq(schema.jobs.id, job.id),
        job.statusId === null ? sql`${schema.jobs.statusId} is null` : eq(schema.jobs.statusId, job.statusId),
      ),
    )
    .returning({ id: schema.jobs.id });
  if (!moved.length) return null;

  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    action: "status_changed",
    detail: `Status → ${quoted.name} (quote #${args.quoteNumber} sent)`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  return quoted.id;
}

/* ---------------------------------------------------------------------------
 * Automatic status moves (spec 0.10).
 *
 *   quote accepted          → Won
 *   every task booked       → Scheduled
 *   first task started      → In Progress
 *   every task complete     → Complete
 *
 * Forward only. A job moves only when it sits on an earlier step of this
 * chain (or has no status). A job on Invoiced, Paid, Cancelled or any status
 * the office made up is never touched, and nothing ever moves backwards.
 * Old jobs are not back-filled: a move only happens when something changes.
 * The office can still set any status by hand.
 * ------------------------------------------------------------------------- */

const CHAIN = ["lead", "quoted", "won", "scheduled", "in progress", "complete"] as const;
export type ChainStep = (typeof CHAIN)[number];

type Actor = { name: string; role: string };

/** Moves the job forward to `target` if it sits earlier in the chain. Returns the new status id or null. */
export async function moveJobForward(args: { jobId: number; target: ChainStep; why: string; actor: Actor }) {
  const [job] = await db
    .select({ id: schema.jobs.id, statusId: schema.jobs.statusId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, args.jobId));
  if (!job) return null;

  const statuses = await db
    .select({ id: schema.jobStatuses.id, name: schema.jobStatuses.name, active: schema.jobStatuses.active })
    .from(schema.jobStatuses);
  const step = (id: number | null) => {
    if (id === null) return -1;
    const s = statuses.find((x) => x.id === id);
    // A status that is not on the chain (or a deleted one) reads as -2: off limits.
    const at = s ? CHAIN.indexOf(s.name.trim().toLowerCase() as ChainStep) : -1;
    return at === -1 ? -2 : at;
  };
  const target = statuses.find((x) => x.active && x.name.trim().toLowerCase() === args.target);
  if (!target) return null;

  const from = step(job.statusId);
  // -2 is a status outside the chain (Invoiced, Paid, Cancelled, a custom one). Leave it.
  if (from === -2 || from >= CHAIN.indexOf(args.target)) return null;

  // Only moves it if it is still where we read it, so two triggers at once log once.
  const moved = await db
    .update(schema.jobs)
    .set({ statusId: target.id, updatedAt: new Date() })
    .where(
      and(
        eq(schema.jobs.id, job.id),
        job.statusId === null ? sql`${schema.jobs.statusId} is null` : eq(schema.jobs.statusId, job.statusId),
      ),
    )
    .returning({ id: schema.jobs.id });
  if (!moved.length) return null;

  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    action: "status_changed",
    detail: `Status → ${target.name} (${args.why})`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  return target.id;
}

/**
 * Looks at every live task on the job and moves the job forward to match.
 * Call it after any task is booked, started or completed.
 *
 *  - every live task complete                      → Complete
 *  - any task started or complete                  → In Progress
 *  - every live task has an installer and a date   → Scheduled
 *
 * Cancelled tasks do not count. A job with no live tasks does not move.
 */
export async function syncJobFromTasks(jobId: number, actor: Actor) {
  const tasks = await db
    .select({
      status: schema.jobTasks.status,
      installer: schema.jobTasks.assignedInstallerId,
      date: schema.jobTasks.scheduledDate,
      from: schema.jobTasks.scheduledFrom,
    })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  if (tasks.length === 0) return null;

  if (tasks.every((t) => t.status === "complete")) {
    return moveJobForward({ jobId, target: "complete", why: "every task complete", actor });
  }
  if (tasks.some((t) => t.status === "in_progress" || t.status === "complete")) {
    return moveJobForward({ jobId, target: "in progress", why: "first task started", actor });
  }
  const booked = (t: (typeof tasks)[number]) =>
    t.status === "assigned" && t.installer !== null && Boolean(t.date || t.from);
  if (tasks.every(booked)) {
    return moveJobForward({ jobId, target: "scheduled", why: "every task booked", actor });
  }
  return null;
}

/** Same as syncJobFromTasks, for a task id. Never throws: a status move must not break the action that caused it. */
export async function syncJobForTask(taskId: number, actor: Actor) {
  try {
    const [t] = await db
      .select({ jobId: schema.jobTasks.jobId })
      .from(schema.jobTasks)
      .where(eq(schema.jobTasks.id, taskId));
    if (t) await syncJobFromTasks(t.jobId, actor);
  } catch (e) {
    console.error("[job-stage] status sync failed", e);
  }
}
