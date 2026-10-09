import { sql } from "drizzle-orm";
import { db } from "../database";

/* ---------------------------------------------------------------------------
 * Job numbers.
 *
 * Every new job, quote without a job, quote convert and voice memo
 * job takes its number here. The old way read the highest number and added
 * 1, so two jobs made at the same moment could both pick the same number
 * (the second one then failed on the unique check).
 *
 * The database has no sequences, so a counter row in `settings` does the job.
 * One upsert statement bumps it and hands the new number back. The database
 * runs writes one at a time, so two callers can never get the same number.
 *
 * Where it starts (spec section 1): Admin sets the start number in Settings,
 * 188000 until changed. Old jobs 218 to 4447 keep their numbers. The counter
 * never goes below the highest number already on a job or on a quote that
 * has no job yet, so an import or seed cannot cause a clash.
 *
 * A number taken by a job that then fails to save is skipped, not reused.
 * Gaps are fine.
 *
 * Repairs do not take a number from the run. A repair is shown as R188000-1
 * and carries its parent's number everywhere people see it. The row still
 * needs a unique number, so it gets a hidden one far above the run
 * (REPAIR_NUMBER_BASE + parent x 1000 + repair number). Those are left out of
 * every "highest used" check, so they never push the next job number along.
 * ------------------------------------------------------------------------- */

export const JOB_NUMBER_KEY = "job_number_last";
export const JOB_NUMBER_START_KEY = "job_number_start";
/** Where new numbering starts until Admin changes it. */
export const DEFAULT_JOB_NUMBER_START = 188000;
/** Keeps a typo from jumping the numbers into the billions. */
export const MAX_JOB_NUMBER_START = 99_999_999;
/** Hidden row numbers for repairs start here. Never shown, never in the run. */
export const REPAIR_NUMBER_BASE = 1_000_000_000_000;

/** The hidden row number for repair `seq` of job `parentNumber`. */
export function repairJobNumber(parentNumber: number, seq: number) {
  return REPAIR_NUMBER_BASE + parentNumber * 1000 + seq;
}

/** The highest number anything already holds. The next number is above this. */
const usedSql = sql`max(
  coalesce((select max(number) from jobs where number < ${REPAIR_NUMBER_BASE}), 0),
  coalesce((select max(number) from quotes where job_id is null and number < ${REPAIR_NUMBER_BASE}), 0),
  coalesce((select cast(value as integer) from settings where key = ${JOB_NUMBER_START_KEY}), ${DEFAULT_JOB_NUMBER_START}) - 1
)`;

export async function nextJobNumber(): Promise<number> {
  const rows = await db.all<{ value: string }>(sql`
    insert into settings (key, value, updated_at)
    values (${JOB_NUMBER_KEY}, cast(${usedSql} + 1 as text), cast(strftime('%s', 'now') as integer))
    on conflict (key) do update set
      value = cast(max(cast(settings.value as integer), ${usedSql}) + 1 as text),
      updated_at = cast(strftime('%s', 'now') as integer)
    returning value
  `);
  const n = Number(rows[0]?.value);
  if (!Number.isInteger(n) || n <= 0) throw new Error("Could not take a job number");
  return n;
}

/** The highest number anything has ever been given: jobs, quotes, and the counter itself. */
async function highestUsed() {
  const [row] = await db.all<{ highest: number }>(sql`
    select max(
      coalesce((select max(number) from jobs where number < ${REPAIR_NUMBER_BASE}), 0),
      coalesce((select max(number) from quotes where number < ${REPAIR_NUMBER_BASE}), 0),
      coalesce((select cast(value as integer) from settings where key = ${JOB_NUMBER_KEY}), 0)
    ) as highest
  `);
  return Number(row?.highest ?? 0);
}

/** What Settings shows: the start Admin set, the number the next job gets, and the lowest start allowed. */
export async function jobNumbering() {
  const [row] = await db.all<{ start: number | null; last: number | null; used: number }>(sql`
    select
      (select cast(value as integer) from settings where key = ${JOB_NUMBER_START_KEY}) as start,
      (select cast(value as integer) from settings where key = ${JOB_NUMBER_KEY}) as last,
      ${usedSql} as used
  `);
  const highest = await highestUsed();
  return {
    start: Number(row?.start ?? DEFAULT_JOB_NUMBER_START),
    next: Math.max(Number(row?.last ?? 0), Number(row?.used ?? 0)) + 1,
    lowestStart: highest + 1,
  };
}

/**
 * Admin sets where numbering starts. It can only go above every number
 * already handed out, so no job, quote or invoice can ever share a number.
 */
export async function setJobNumberStart(start: number) {
  if (!Number.isInteger(start) || start < 1 || start > MAX_JOB_NUMBER_START) {
    throw new Error(`The start number must be a whole number from 1 to ${MAX_JOB_NUMBER_START}.`);
  }
  const highest = await highestUsed();
  if (start <= highest) {
    throw new Error(`Number ${highest} is already used. The start number has to be ${highest + 1} or more.`);
  }
  await db.run(sql`
    insert into settings (key, value, updated_at)
    values (${JOB_NUMBER_START_KEY}, ${String(start)}, cast(strftime('%s', 'now') as integer))
    on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  `);
  return jobNumbering();
}
