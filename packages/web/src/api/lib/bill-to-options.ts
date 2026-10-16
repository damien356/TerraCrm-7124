import { eq, inArray, like, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { cardOf, jobBillTo, quoteBillTo, type BillTo, type Card } from "./bill-to";

/* Who the Bill to picker offers (notes 18.54): the job's company and people first, then anyone by name. */

export type BillToOption = Card & { role: string };

const fullName = (p: { firstName: string | null; lastName: string | null }) => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "No name";

/** The picker's short list for a job or quote, and who it bills now. */
export async function billToOptions(args: { jobId?: number | null; quoteId?: number | null }) {
  let jobId = args.jobId ?? null;
  let current: BillTo | null = null;
  const companyIds = new Set<number>();
  const contactIds = new Map<number, string>();
  if (args.quoteId) {
    const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, args.quoteId));
    if (q) {
      current = quoteBillTo(q);
      jobId = jobId ?? q.jobId;
      if (q.companyId) companyIds.add(q.companyId);
      if (q.contactId) contactIds.set(q.contactId, "On the quote");
    }
  }
  if (jobId) {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    if (job) {
      if (!args.quoteId) current = jobBillTo(job);
      if (job.companyId) companyIds.add(job.companyId);
      if (job.billToCompanyId) companyIds.add(job.billToCompanyId);
      if (job.contactId && !contactIds.has(job.contactId)) contactIds.set(job.contactId, "Job contact");
      if (job.billToContactId && !contactIds.has(job.billToContactId)) contactIds.set(job.billToContactId, "Bills the job");
      const people = await db.select({ id: schema.jobContacts.contactId, role: schema.jobContacts.role }).from(schema.jobContacts).where(eq(schema.jobContacts.jobId, jobId));
      for (const p of people) if (!contactIds.has(p.id)) contactIds.set(p.id, p.role.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()));
    }
  }
  if (current?.type === "company") companyIds.add(current.id);
  if (current?.type === "contact" && !contactIds.has(current.id)) contactIds.set(current.id, "Bills now");
  const options: BillToOption[] = [];
  if (companyIds.size) {
    const rows = await db
      .select({ id: schema.companies.id, name: schema.companies.name, percent: schema.companies.depositPercent, kind: schema.companies.type })
      .from(schema.companies)
      .where(inArray(schema.companies.id, [...companyIds]));
    for (const r of rows) options.push({ type: "company", id: r.id, name: r.name, percent: r.percent, role: `Company, ${r.kind.replace(/_/g, " ")}` });
  }
  if (contactIds.size) {
    const rows = await db
      .select({ id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, percent: schema.contacts.depositPercent })
      .from(schema.contacts)
      .where(inArray(schema.contacts.id, [...contactIds.keys()]));
    for (const r of rows) options.push({ type: "contact", id: r.id, name: fullName(r), percent: r.percent, role: contactIds.get(r.id) ?? "Person" });
  }
  const cur = current ? await cardOf(current) : null;
  return { current: cur, options };
}

/** Anyone by name: companies and people, 20 at most. */
export async function searchBillTo(q: string): Promise<BillToOption[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const pat = `%${term.replace(/[%_]/g, "")}%`;
  const companies = await db
    .select({ id: schema.companies.id, name: schema.companies.name, percent: schema.companies.depositPercent, kind: schema.companies.type })
    .from(schema.companies)
    .where(like(schema.companies.name, pat))
    .limit(10);
  const people = await db
    .select({ id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName, percent: schema.contacts.depositPercent, mobile: schema.contacts.mobile, email: schema.contacts.email })
    .from(schema.contacts)
    .where(
      or(
        like(sql`${schema.contacts.firstName} || ' ' || ${schema.contacts.lastName}`, pat),
        like(schema.contacts.email, pat),
        like(schema.contacts.mobile, pat),
      ),
    )
    .limit(10);
  return [
    ...companies.map((r) => ({ type: "company" as const, id: r.id, name: r.name, percent: r.percent, role: `Company, ${r.kind.replace(/_/g, " ")}` })),
    ...people.map((r) => ({ type: "contact" as const, id: r.id, name: fullName(r), percent: r.percent, role: r.mobile || r.email || "Person" })),
  ];
}

/** Cards for a list of Bill tos, in the same order. A card that is gone comes back null. */
export async function cardsOf(list: BillTo[]) {
  const out: Array<Card | null> = [];
  for (const b of list) out.push(await cardOf(b));
  return out;
}

