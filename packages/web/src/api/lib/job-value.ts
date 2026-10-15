import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositSplit } from "./deposits";

/**
 * Damien, 16 Oct: a job that a quote made (a voice quote, New quote on the
 * Quotes page, Convert to job) shows the quote's total as its value and
 * deposit, and keeps it as the quote changes.
 *
 * Only while the job's price is still open:
 *  - the job was made for its quote, so its first quote is no newer than the
 *    job. A job made by hand and quoted later keeps the value typed on it.
 *  - no quote on the job is accepted. From the accept on, quote-accept.ts
 *    owns the value (accepted price plus approved variations).
 *  - the quote is the job's current one: its newest version that is still a
 *    draft, needs review, or sent. Editing an older version changes nothing.
 */
const OPEN = ["draft", "needs_review", "sent"];

export async function syncJobValueFromQuote(quoteId: number) {
  const [quote] = await db.select({ jobId: schema.quotes.jobId }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  return quote?.jobId ? syncJobValue(quote.jobId) : false;
}

/** Puts the job's current quote total and deposit on the job, under the rules above. */
export async function syncJobValue(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) return false;
  const all = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.jobId, job.id))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
  if (!all.length || all.some((q) => q.status === "accepted")) return false;
  const first = Math.min(...all.map((q) => +q.createdAt));
  if (!(first <= +job.createdAt)) return false;
  const current = all.find((q) => OPEN.includes(q.status));
  if (!current) return false;
  const value = Number(current.total ?? 0);
  const depositAmount = depositSplit(value, current.depositPercent ?? 0).deposit;
  if (Number(job.value) === value && Number(job.depositAmount) === depositAmount) return false;
  await db.update(schema.jobs).set({ value, depositAmount, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
  return true;
}
