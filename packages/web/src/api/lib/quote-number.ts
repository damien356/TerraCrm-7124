import { eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { nextJobNumber } from "./job-number";
import { jobNumberSql } from "./job-ref";
import { quoteRef } from "./refs";

/**
 * The number a new quote takes (spec section 1). The job and its quote share
 * one number:
 *
 *   on a job      the job's own number. A job that already has a quote gets
 *                 the next revision of it (Q188000-2), never a second number.
 *   no job yet    the next job number. The job made from it keeps it.
 *
 * Replaces max(quotes.number) + 1, which could hand two quotes made at the
 * same moment the same number.
 */
export async function quoteNumberFor(jobId: number | null | undefined): Promise<{ number: number; version: number }> {
  if (!jobId) return { number: await nextJobNumber(), version: 1 };
  const [job] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new Error("Job not found");
  const [row] = await db
    .select({ max: sql<number | null>`max(${schema.quotes.version})` })
    .from(schema.quotes)
    .where(eq(schema.quotes.number, job.number));
  return { number: job.number, version: Number(row?.max ?? 0) + 1 };
}

/** "Q188000-2" for a quote row in hand. A quote on a repair reads QR188000-1. */
export async function quoteRefOf(q: { number: number; version: number; jobId: number | null }) {
  if (!q.jobId) return quoteRef(q.number, q.version);
  const [job] = await db.select({ ref: jobNumberSql }).from(schema.jobs).where(eq(schema.jobs.id, q.jobId));
  return quoteRef(q.number, q.version, job?.ref ?? null);
}

export async function quoteRefById(id: number) {
  const [q] = await db
    .select({ number: schema.quotes.number, version: schema.quotes.version, jobId: schema.quotes.jobId })
    .from(schema.quotes)
    .where(eq(schema.quotes.id, id));
  return q ? quoteRefOf(q) : `quote ${id}`;
}
