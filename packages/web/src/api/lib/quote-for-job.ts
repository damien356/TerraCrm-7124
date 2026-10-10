import { ORPCError } from "@orpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositDefaultFor } from "./deposits";
import { hasTagSql } from "./job-people";
import { jobNumberSql } from "./job-ref";
import { laterVersionHold } from "./quote-accept";
import { quoteRef } from "./refs";

/* ---------------------------------------------------------------------------
 * Create quote on the job page (item 6, Damien 10 Oct). The quote takes the
 * job's number (Q188000, then Q188000-2) and its people off the job:
 *
 *   customer   the job's contact
 *   company    only when the job bills the company
 *   supervisor the person tagged Supervisor on the job, when they are filed
 *              under that company
 *   site       the job's site
 *
 * A blank version starts at the card's deposit, the same as New quote. A
 * copied version keeps the deposit of the version it copies. Either can be
 * typed over for this quote only.
 * ------------------------------------------------------------------------- */

const OPEN_STATUSES = ["draft", "needs_review"];

async function jobOrThrow(jobId: number) {
  const [job] = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      ref: jobNumberSql,
      contactId: schema.jobs.contactId,
      companyId: schema.jobs.companyId,
      siteId: schema.jobs.siteId,
      billToType: schema.jobs.billToType,
      billToCompanyId: schema.jobs.billToCompanyId,
      parentJobId: schema.jobs.parentJobId,
      chargeable: schema.jobs.callbackChargeable,
      displayNumber: schema.jobs.displayNumber,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  return job;
}

/** Who a blank quote on this job is for. */
export async function quoteDefaultsForJob(jobId: number) {
  const job = await jobOrThrow(jobId);
  const companyId = job.billToType === "company" ? (job.billToCompanyId ?? job.companyId ?? null) : null;
  let supervisorContactId: number | null = null;
  if (companyId) {
    const [sup] = await db.all<{ id: number }>(sql`
      select jc.contact_id as id from job_contacts jc
      where jc.job_id = ${jobId} and ${hasTagSql("jc", "supervisor")}
        and exists (select 1 from company_contacts cc where cc.company_id = ${companyId} and cc.contact_id = jc.contact_id)
      order by jc.id limit 1`);
    supervisorContactId = sup?.id ?? null;
  }
  return { job, contactId: job.contactId ?? null, companyId, supervisorContactId, siteId: job.siteId ?? null };
}

/** What the Create quote popup needs to know before anything is made. */
export async function quoteStartForJob(jobId: number) {
  const d = await quoteDefaultsForJob(jobId);
  const quotes = await db
    .select({ id: schema.quotes.id, number: schema.quotes.number, version: schema.quotes.version, status: schema.quotes.status, depositPercent: schema.quotes.depositPercent, total: schema.quotes.total })
    .from(schema.quotes)
    .where(eq(schema.quotes.jobId, jobId))
    .orderBy(desc(schema.quotes.version));
  const refOf = (q: { number: number; version: number }) => quoteRef(q.number, q.version, d.job.ref);
  const latest = quotes[0] ?? null;
  const draft = quotes.find((q) => OPEN_STATUSES.includes(q.status)) ?? null;
  const cardDeposit = await depositDefaultFor({ companyId: d.companyId, contactId: d.contactId });
  const notChargeable = d.job.parentJobId != null && d.job.chargeable === false;
  // A new version is an earlier quote plus one, so test as if it already existed.
  const hold = latest ? await laterVersionHold({ id: -1, number: d.job.number, jobId }) : null;
  return {
    nextRef: quoteRef(d.job.number, (latest?.version ?? 0) + 1, d.job.ref),
    latest: latest ? { id: latest.id, ref: refOf(latest), status: latest.status, depositPercent: latest.depositPercent, total: latest.total } : null,
    draft: draft ? { id: draft.id, ref: refOf(draft), status: draft.status } : null,
    cardDeposit,
    billsCompany: d.companyId != null,
    hasSupervisor: d.supervisorContactId != null,
    blocked: notChargeable
      ? `Callback ${d.job.displayNumber ?? d.job.ref} is marked not chargeable, so nothing is billed. Change it to chargeable first.`
      : null,
    holdMessage: hold?.staff ?? null,
  };
}

/** The highest version on the job, to copy from. */
export async function latestQuoteOnJob(jobId: number) {
  const [q] = await db
    .select()
    .from(schema.quotes)
    .where(eq(schema.quotes.jobId, jobId))
    .orderBy(desc(schema.quotes.version))
    .limit(1);
  return q ?? null;
}
