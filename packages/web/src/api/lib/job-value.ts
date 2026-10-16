import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositSplit } from "./deposits";
import { approvedVariationsTotal } from "./variations";

/**
 * Damien, 16 Oct (notes 18.52): every job's value is its quote. One rule, used
 * by the job page Value, the Jobs list, the dashboard and "What this job makes":
 *
 *  - an accepted quote: its total plus accepted variations (quote-accept.ts and
 *    variation-accept.ts write the same figure). The deposit stays as the
 *    first accept set it, and so does a deposit that is already paid.
 *  - no accepted quote: the job's latest quote (the newest one made), total and
 *    deposit. A draft, a sent quote and a new version all count.
 *  - no quote at all: the value typed on the job stays.
 *
 * The old rule kept a hand typed value on a job that was made first and quoted
 * later, which is how jobs made on the New job screen sat at $0 with a quote.
 *
 * Stored INC GST (see gst.ts).
 */
type QuoteRow = typeof schema.quotes.$inferSelect;

/** The quote that sets the job's value: the accepted one (newest version), else the newest quote. */
export function quoteThatCounts<T extends Pick<QuoteRow, "id" | "status" | "version">>(rows: T[]): T | null {
  const accepted = rows.filter((q) => q.status === "accepted").sort((a, b) => b.version - a.version || b.id - a.id)[0];
  if (accepted) return accepted;
  return [...rows].sort((a, b) => b.id - a.id)[0] ?? null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** What the job's value and deposit should be. Null when the job has no quote (its typed value stays). */
export async function jobValuePlan(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) return null;
  const rows = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId));
  const quote = quoteThatCounts(rows);
  if (!quote) return null;
  const accepted = quote.status === "accepted";
  const value = accepted ? r2(Number(quote.total ?? 0) + (await approvedVariationsTotal(jobId))) : r2(Number(quote.total ?? 0));
  // A paid deposit is history, and an accepted job's deposit was set by its first accept.
  const keepDeposit = accepted || job.depositPaid;
  const depositAmount = keepDeposit ? Number(job.depositAmount ?? 0) : depositSplit(value, quote.depositPercent ?? 0).deposit;
  return {
    job,
    quote,
    value,
    depositAmount,
    changed: Number(job.value) !== value || Number(job.depositAmount) !== depositAmount,
  };
}

export async function syncJobValueFromQuote(quoteId: number) {
  const [quote] = await db.select({ jobId: schema.quotes.jobId }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  return quote?.jobId ? syncJobValue(quote.jobId) : false;
}

/** Puts the value and deposit from the rule above on the job. True when it changed. */
export async function syncJobValue(jobId: number) {
  const plan = await jobValuePlan(jobId);
  if (!plan || !plan.changed) return false;
  await db
    .update(schema.jobs)
    .set({ value: plan.value, depositAmount: plan.depositAmount, updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId));
  return true;
}
