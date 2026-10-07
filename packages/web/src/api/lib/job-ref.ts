import { sql } from "drizzle-orm";
import * as schema from "../database/schema";

/**
 * The job number as people read it: "3981-C1" on a callback, "3981" on
 * anything else. Text, never a number, so a callback shows its link to the
 * original job on every list, card, PDF and email without each one knowing.
 */
export const jobNumberSql = sql<string>`coalesce(${schema.jobs.displayNumber}, cast(${schema.jobs.number} as text))`;

/** Same rule for a job row already in hand. */
export function jobRef(j: { number: number; displayNumber?: string | null }) {
  return j.displayNumber || String(j.number);
}
