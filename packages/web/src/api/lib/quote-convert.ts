import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositSplit } from "./deposits";
import { carryQuotePeopleToJob } from "./job-people";
import { nextJobNumber } from "./job-number";
import { quoteRef } from "./refs";

/* ---------------------------------------------------------------------------
 * Quotes and their jobs.
 *
 *   createJobForQuote   the job on its own. New quote uses it, so a quote
 *                       has its job (and its one list of people) from the start.
 *   buildWorkFromQuote  labour, prep and removal lines become unassigned
 *                       tasks (the dispatch unit), supply and accessory
 *                       lines become materials to order.
 *   convertQuoteToJob   both. The Convert to job button, and an accept on an
 *                       old quote that has no job yet.
 *
 * A later version swapping the work over is lib/quote-rework.ts.
 * ------------------------------------------------------------------------- */

export type QuoteRow = typeof schema.quotes.$inferSelect;

/** The work lines and supply lines of one quote version, in order. */
export async function quoteLines(quoteId: number) {
  const items = await db
    .select()
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  return {
    work: items.filter((i) => i.kind === "labour" || i.kind === "prep" || i.kind === "removal"),
    supply: items.filter((i) => i.kind === "supply" || i.kind === "accessory"),
  };
}

export type QuoteLine = typeof schema.quoteItems.$inferSelect;

/** One unassigned task for a work line. The skill is guessed from the wording. */
export async function insertTaskForLine(jobId: number, line: QuoteLine, seq: number, furnitureOnSite: boolean) {
  const skills = await db.select().from(schema.skills).where(eq(schema.skills.active, true)).orderBy(asc(schema.skills.sortOrder));
  const haystack = line.description.toLowerCase();
  const skill =
    skills.find((s) => haystack.includes(s.name.toLowerCase())) ??
    skills.find((s) => (line.kind === "removal" ? s.groupName === "demolition" : s.groupName === "prep"));
  const crewSize = furnitureOnSite ? 2 : (skill?.defaultCrewSize ?? 1);
  const [row] = await db
    .insert(schema.jobTasks)
    .values({
      jobId,
      skillId: skill?.id ?? null,
      title: line.description,
      status: "unassigned",
      areaM2: line.unit === "m2" ? line.qty : null,
      crewSize,
      seq,
    })
    .returning();
  return row!;
}

/**
 * Work lines become unassigned tasks (one dispatch each) and supply lines
 * become materials to order, on a job that has none from this quote yet.
 */
export async function buildWorkFromQuote(quoteId: number, jobId: number, opts: { createTasks?: boolean; furnitureOnSite?: boolean } = {}) {
  const { work, supply } = await quoteLines(quoteId);
  const [job] = await db.select({ furnitureOnSite: schema.jobs.furnitureOnSite }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  const furnitureOnSite = opts.furnitureOnSite ?? job?.furnitureOnSite ?? false;

  if (supply.length) {
    await db.insert(schema.jobMaterials).values(
      supply.map((i) => ({
        jobId,
        productId: i.productId,
        description: i.description,
        qty: i.qty,
        unit: i.unit,
        status: "to_order",
      })),
    );
  }

  let tasksCreated = 0;
  if (opts.createTasks ?? true) {
    // Tasks already on the job (a measure, say) keep their places at the front.
    const [top] = await db.select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, jobId));
    const start = Number(top?.max ?? 0);
    for (const [idx, line] of work.entries()) {
      await insertTaskForLine(jobId, line, start + idx + 1, furnitureOnSite);
      tasksCreated += 1;
    }
  }
  return { tasksCreated, materialsCreated: supply.length };
}

/**
 * Makes the job a quote belongs to, without any dispatches or materials yet.
 * New quote on the Quotes page does this the moment the quote is started,
 * so the quote and the job share one number and one list of people.
 */
export async function createJobForQuote(
  quote: QuoteRow,
  opts: { title?: string; furnitureOnSite?: boolean; source?: string },
) {
  if (quote.jobId) throw new Error("This quote is already attached to a job");
  const furnitureOnSite = opts.furnitureOnSite ?? false;

  // The job keeps the quote's number (spec section 1). The quote took it
  // from the job counter, so no job has it. Old quotes made before that
  // rule may clash with an old job, and those get a fresh number.
  const [clash] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.number, quote.number));
  const number = clash ? await nextJobNumber() : quote.number;

  // The job starts where the quote already is: Won if it was accepted,
  // Quoted if it went out, otherwise the first status (Lead).
  const startName = quote.status === "accepted" ? "won" : quote.status === "sent" ? "quoted" : null;
  const [named] = startName
    ? await db
        .select({ id: schema.jobStatuses.id })
        .from(schema.jobStatuses)
        .where(and(eq(schema.jobStatuses.active, true), sql`lower(trim(${schema.jobStatuses.name})) = ${startName}`))
        .limit(1)
    : [];
  const [status] = named
    ? [named]
    : await db
        .select({ id: schema.jobStatuses.id })
        .from(schema.jobStatuses)
        .where(eq(schema.jobStatuses.active, true))
        .orderBy(asc(schema.jobStatuses.sortOrder))
        .limit(1);

  const [site] = quote.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId)) : [undefined];

  const [job] = await db
    .insert(schema.jobs)
    .values({
      number,
      title: opts.title || site?.address || `Quote ${quoteRef(quote.number, quote.version)}`,
      statusId: status?.id ?? null,
      siteId: quote.siteId,
      contactId: quote.contactId,
      companyId: quote.companyId,
      // Billing is decided per job, not per person: a company on the quote
      // means the company pays, otherwise the person does.
      billToType: quote.companyId ? "company" : "contact",
      billToContactId: quote.companyId ? null : quote.contactId,
      billToCompanyId: quote.companyId ?? null,
      furnitureOnSite,
      ...(opts.source ? { source: opts.source } : {}),
      accessNotes: site?.accessNotes ?? null,
      value: quote.total,
      // The deposit the customer accepted. Drives the forecast and the deposit invoice.
      depositAmount: depositSplit(quote.total ?? 0, quote.depositPercent ?? 0).deposit,
    })
    .returning();

  if (!job) throw new Error("Job not created");

  // Customer, supervisor and every job contact on the quote, one row per
  // person. From here on the job's list is the only list (item 7), so the
  // quote's own rows go once they are on the job.
  const versions = await db.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.number, quote.number));
  await carryQuotePeopleToJob(quote.id, job.id);
  for (const v of versions) if (v.id !== quote.id) await carryQuotePeopleToJob(v.id, job.id);
  if (versions.length) {
    await db.delete(schema.quoteContacts).where(inArray(schema.quoteContacts.quoteId, versions.map((v) => v.id)));
  }

  // Every version of the quote now belongs to the job.
  await db
    .update(schema.quotes)
    .set({ jobId: job.id, updatedAt: new Date() })
    .where(and(eq(schema.quotes.number, quote.number), isNull(schema.quotes.jobId)));

  return { job, number };
}

/**
 * A quote on a job got its customer, company or site after the job was made
 * (New quote with nobody picked yet). The job fills in whatever it is still
 * missing and the people go on its list. Nothing the job already has is
 * changed, and billing is only set while the job has no invoices.
 */
export async function fillJobFromQuote(quoteId: number) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q?.jobId) return;
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, q.jobId));
  if (!job) return;
  const [invoice] = await db.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.jobId, job.id)).limit(1);
  const patch: Partial<typeof schema.jobs.$inferInsert> = {};
  if (!job.contactId && q.contactId) patch.contactId = q.contactId;
  if (!invoice && !job.companyId && q.companyId) {
    patch.companyId = q.companyId;
    patch.billToType = "company";
    patch.billToCompanyId = q.companyId;
    patch.billToContactId = null;
  } else if (!invoice && !job.companyId && job.billToType === "contact" && !job.billToContactId && q.contactId) {
    patch.billToContactId = q.contactId;
  }
  if (!job.siteId && q.siteId) {
    const [site] = await db.select().from(schema.sites).where(eq(schema.sites.id, q.siteId));
    patch.siteId = q.siteId;
    if (!job.accessNotes && site?.accessNotes) patch.accessNotes = site.accessNotes;
    // The placeholder title from createJobForQuote gives way to the address.
    if (site?.address && /^Quote Q\d/.test(job.title ?? "")) patch.title = site.address;
  }
  if (Object.keys(patch).length) {
    await db.update(schema.jobs).set({ ...patch, updatedAt: new Date() }).where(eq(schema.jobs.id, job.id));
  }
  await carryQuotePeopleToJob(q.id, job.id);
}

/**
 * Turn a quote into a job. Shared by the Convert to job button and by an
 * accept on a quote that has no job yet.
 */
export async function convertQuoteToJob(
  quote: QuoteRow,
  opts: { title?: string; furnitureOnSite?: boolean; createTasks?: boolean },
  actor: { name: string; role: string },
) {
  const { job, number } = await createJobForQuote(quote, opts);
  const { tasksCreated, materialsCreated } = await buildWorkFromQuote(quote.id, job.id, {
    createTasks: opts.createTasks,
    furnitureOnSite: opts.furnitureOnSite ?? false,
  });

  await db.insert(schema.activityLog).values({
    jobId: job.id,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action: "converted",
    detail: `Quote ${quoteRef(quote.number, quote.version)} converted to job ${number}, ${tasksCreated} task(s), ${materialsCreated} material line(s)`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  return { job, tasksCreated, materialsCreated };
}
