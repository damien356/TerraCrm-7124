import { and, eq, sql } from "drizzle-orm";
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
