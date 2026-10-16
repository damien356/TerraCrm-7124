import { eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * JOB MERGE (notes 18.48). A merged job points at the job it went into.
 * Anything that finds a job by number or id (an email tag, a supplier bill,
 * a thread) follows the pointer, so 188013 lands on 188012.
 * A chain (A into B, B into C) is followed to the end, a few hops at most.
 */
export async function mergedTarget(jobId: number): Promise<number> {
  let id = jobId;
  for (let hop = 0; hop < 5; hop++) {
    const [row] = await db.select({ into: schema.jobs.mergedIntoJobId }).from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!row?.into || row.into === id) return id;
    id = row.into;
  }
  return id;
}

/** The same for a list of ids. Order kept, repeats dropped. */
export async function mergedTargets(ids: number[]): Promise<number[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: schema.jobs.id, into: schema.jobs.mergedIntoJobId })
    .from(schema.jobs)
    .where(inArray(schema.jobs.id, ids));
  const out: number[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id);
    const target = r?.into ? await mergedTarget(r.into) : id;
    if (!out.includes(target)) out.push(target);
  }
  return out;
}
