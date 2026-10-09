import { sql } from "drizzle-orm";
import { db } from "../database";

/* ---------------------------------------------------------------------------
 * Job numbers.
 *
 * Every new job, quote convert, callback and voice memo job takes its number
 * here. The old way read the highest number and added 1, so two jobs made at
 * the same moment could both pick the same number (the second one then failed
 * on the unique check).
 *
 * The database has no sequences, so a counter row in `settings` does the job.
 * One upsert statement bumps it and hands the new number back. The database
 * runs writes one at a time, so two callers can never get the same number.
 *
 * The counter never goes below the highest number already on a job, so an
 * import or seed that wrote numbers directly cannot cause a clash.
 *
 * A number taken by a job that then fails to save is skipped, not reused.
 * ------------------------------------------------------------------------- */

export const JOB_NUMBER_KEY = "job_number_last";
/** Where numbering starts when there are no jobs at all. The first job is 201. */
const FLOOR = 200;

export async function nextJobNumber(): Promise<number> {
  const rows = await db.all<{ value: string }>(sql`
    insert into settings (key, value, updated_at)
    values (
      ${JOB_NUMBER_KEY},
      cast((select coalesce(max(number), ${FLOOR}) from jobs) + 1 as text),
      cast(strftime('%s', 'now') as integer)
    )
    on conflict (key) do update set
      value = cast(max(cast(settings.value as integer), (select coalesce(max(number), ${FLOOR}) from jobs)) + 1 as text),
      updated_at = cast(strftime('%s', 'now') as integer)
    returning value
  `);
  const n = Number(rows[0]?.value);
  if (!Number.isInteger(n) || n <= FLOOR) throw new Error("Could not take a job number");
  return n;
}
