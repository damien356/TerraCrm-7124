import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositSplit } from "./deposits";
import { carryQuotePeopleToJob } from "./job-people";
import { nextJobNumber } from "./job-number";
import { quoteRef } from "./refs";

/* ---------------------------------------------------------------------------
 * Turn a quote into a job. Shared by the Convert to job button and by an
 * accept (staff or online) on a quote that has no job yet, so both make the
 * same job the same way.
 *
 * Labour, prep and removal lines become unassigned tasks (the dispatch unit),
 * supply and accessory lines become materials to order.
 * ------------------------------------------------------------------------- */

export type QuoteRow = typeof schema.quotes.$inferSelect;

export async function convertQuoteToJob(
  quote: QuoteRow,
  opts: { title?: string; furnitureOnSite?: boolean; createTasks?: boolean },
  actor: { name: string; role: string },
) {
  if (quote.jobId) throw new Error("This quote is already attached to a job");
  const furnitureOnSite = opts.furnitureOnSite ?? false;
  const createTasks = opts.createTasks ?? true;

  const items = await db
    .select()
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quote.id))
    .orderBy(asc(schema.quoteItems.sortOrder));

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
      accessNotes: site?.accessNotes ?? null,
      value: quote.total,
      // The deposit the customer accepted. Drives the forecast and the deposit invoice.
      depositAmount: depositSplit(quote.total ?? 0, quote.depositPercent ?? 0).deposit,
    })
    .returning();

  if (!job) throw new Error("Job not created");

  // Customer, supervisor and every job contact on the quote, one row per person.
  await carryQuotePeopleToJob(quote.id, job.id);

  // Supply lines become materials to order.
  const supplyLines = items.filter((i) => i.kind === "supply" || i.kind === "accessory");
  if (supplyLines.length) {
    await db.insert(schema.jobMaterials).values(
      supplyLines.map((i) => ({
        jobId: job.id,
        productId: i.productId,
        description: i.description,
        qty: i.qty,
        unit: i.unit,
        status: "to_order",
      })),
    );
  }

  // Work lines become unassigned tasks, one dispatch each.
  let tasksCreated = 0;
  if (createTasks) {
    const workLines = items.filter((i) => i.kind === "labour" || i.kind === "prep" || i.kind === "removal");
    const skills = await db.select().from(schema.skills).where(eq(schema.skills.active, true)).orderBy(asc(schema.skills.sortOrder));

    for (const [idx, line] of workLines.entries()) {
      const haystack = line.description.toLowerCase();
      const skill =
        skills.find((s) => haystack.includes(s.name.toLowerCase())) ??
        skills.find((s) => (line.kind === "removal" ? s.groupName === "demolition" : s.groupName === "prep"));

      const crewSize = furnitureOnSite ? 2 : (skill?.defaultCrewSize ?? 1);

      await db.insert(schema.jobTasks).values({
        jobId: job.id,
        skillId: skill?.id ?? null,
        title: line.description,
        status: "unassigned",
        areaM2: line.unit === "m2" ? line.qty : null,
        crewSize,
        seq: idx + 1,
      });
      tasksCreated += 1;
    }
  }

  // Every version of the quote now belongs to the job.
  await db
    .update(schema.quotes)
    .set({ jobId: job.id, updatedAt: new Date() })
    .where(and(eq(schema.quotes.number, quote.number), isNull(schema.quotes.jobId)));

  await db.insert(schema.activityLog).values({
    jobId: job.id,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action: "converted",
    detail: `Quote ${quoteRef(quote.number, quote.version)} converted to job ${number}, ${tasksCreated} task(s), ${supplyLines.length} material line(s)`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  return { job, tasksCreated, materialsCreated: supplyLines.length };
}
