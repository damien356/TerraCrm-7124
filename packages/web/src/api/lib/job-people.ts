import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { PERSON_TAGS, REFERRAL_TAGS, parseTags, tagsJson, type PersonTag } from "./person-tags";

/**
 * PEOPLE ON A JOB OR QUOTE.
 *
 * One row per person per job (and per quote). The row holds the tags that
 * person has on this job, the ticks (Decision-maker, Site access, Show to
 * Crew), the comms flags and a "when to contact" note. Show to Crew is the
 * only thing that puts a person in front of field crew, chosen job by job. The person's own card (name,
 * phone, email) lives once in `contacts`.
 *
 * `role` is legacy and always mirrors the first tag.
 */

/** One person as the new quote and new job screens send them. */
export const personInput = z.object({
  contactId: z.number(),
  tags: z.array(z.enum(PERSON_TAGS)).min(1, "Pick at least one tag"),
  onSiteContact: z.boolean().default(false),
  canApproveQuote: z.boolean().default(false),
  receivesSms: z.boolean().default(false),
  receivesEmail: z.boolean().default(false),
  /** Crew sees this person (name, number, tags, note) on the job. Left out, a tenant starts shown. */
  showToCrew: z.boolean().optional(),
  whenToContact: z.string().nullable().optional(),
});

export interface PersonPatch {
  /** Tags to add (merge) or, with `replaceTags`, the full new list. */
  tags?: readonly string[];
  replaceTags?: boolean;
  isPrimary?: boolean;
  onSiteContact?: boolean;
  canApproveQuote?: boolean;
  receivesSms?: boolean;
  receivesEmail?: boolean;
  showToCrew?: boolean;
  whenToContact?: string | null;
  /** Explicit acted-for company. Left out, it is worked out from the person's company links. */
  actedForCompanyId?: number | null;
}

/** SQL test for "this row holds tag X". `alias` is the table alias in raw SQL. */
export function hasTagSql(alias: string, tag: PersonTag) {
  if (!PERSON_TAGS.includes(tag)) throw new Error(`Unknown tag ${tag}`);
  return sql.raw(`exists (select 1 from json_each(${alias}.tags) where json_each.value = '${tag}')`);
}

/** SQL test for "this row holds a referral tag". */
export function hasReferralTagSql(alias: string) {
  const list = REFERRAL_TAGS.map((t) => `'${t}'`).join(",");
  return sql.raw(`exists (select 1 from json_each(${alias}.tags) where json_each.value in (${list}))`);
}

const firstTag = (tags: PersonTag[]) => tags[0] ?? "other";
/** Show to Crew when nobody said either way: a tenant is who lets crew in. */
const defaultShowToCrew = (tags: PersonTag[]) => tags.includes("tenant");
const hasReferral = (tags: PersonTag[]) => tags.some((t) => REFERRAL_TAGS.includes(t));

/**
 * The company a person is acting for. The billed company wins when they are
 * linked to it, then their primary company link, then any link.
 */
export async function actedForCompany(contactId: number, preferCompanyId?: number | null): Promise<number | null> {
  const links = await db
    .select({ companyId: schema.companyContacts.companyId, role: schema.companyContacts.role })
    .from(schema.companyContacts)
    .where(eq(schema.companyContacts.contactId, contactId))
    .orderBy(sql`${schema.companyContacts.isPrimary} desc`, asc(schema.companyContacts.id));
  if (preferCompanyId && links.some((l) => l.companyId === preferCompanyId)) return preferCompanyId;
  // A company they used to work for is not who they act for now.
  return links.find((l) => l.role !== "former_supervisor")?.companyId ?? null;
}

interface Stored {
  tags: string;
  isPrimary?: boolean;
  onSiteContact: boolean;
  canApproveQuote: boolean;
  receivesSms: boolean;
  receivesEmail: boolean;
  showToCrew: boolean;
  whenToContact: string | null;
  actedForCompanyId: number | null;
}

/**
 * Merges a patch into an existing row. Adding never takes anything away:
 * tags join, ticks stay on if either side has them, a note is only filled
 * when the old one is blank. `replaceTags` swaps the tag list outright.
 */
export function mergePerson(existing: Stored | null, patch: PersonPatch) {
  const oldTags = existing ? parseTags(existing.tags) : [];
  const tags = patch.replaceTags ? parseTags([...(patch.tags ?? [])]) : parseTags([...oldTags, ...(patch.tags ?? [])]);
  const or = (a: boolean | undefined, b: boolean | undefined) => !!a || !!b;
  const note = (patch.whenToContact ?? "").trim();
  return {
    tags,
    isPrimary: or(existing?.isPrimary, patch.isPrimary),
    onSiteContact: or(existing?.onSiteContact, patch.onSiteContact),
    canApproveQuote: or(existing?.canApproveQuote, patch.canApproveQuote),
    receivesSms: or(existing?.receivesSms, patch.receivesSms),
    receivesEmail: or(existing?.receivesEmail, patch.receivesEmail),
    showToCrew: existing ? or(existing.showToCrew, patch.showToCrew) : (patch.showToCrew ?? defaultShowToCrew(tags)),
    whenToContact: existing?.whenToContact?.trim() ? existing.whenToContact : note || null,
    actedForCompanyId: existing?.actedForCompanyId ?? patch.actedForCompanyId ?? null,
  };
}

async function jobCompany(jobId: number) {
  const [j] = await db.select({ companyId: schema.jobs.companyId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return j?.companyId ?? null;
}

async function quoteCompany(quoteId: number) {
  const [q] = await db.select({ companyId: schema.quotes.companyId }).from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  return q?.companyId ?? null;
}

/** Adds a person to a job, or merges into their existing row. Returns the row. */
export async function addJobPerson(jobId: number, contactId: number, patch: PersonPatch) {
  const [existing] = await db
    .select()
    .from(schema.jobContacts)
    .where(and(eq(schema.jobContacts.jobId, jobId), eq(schema.jobContacts.contactId, contactId)));
  const m = mergePerson(existing ?? null, patch);
  if (m.actedForCompanyId == null && hasReferral(m.tags) && patch.actedForCompanyId === undefined) {
    m.actedForCompanyId = await actedForCompany(contactId, await jobCompany(jobId));
  }
  const values = { ...m, tags: tagsJson(m.tags), role: firstTag(m.tags), updatedAt: new Date() };
  if (existing) {
    const [row] = await db.update(schema.jobContacts).set(values).where(eq(schema.jobContacts.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(schema.jobContacts)
    .values({ jobId, contactId, ...values })
    .onConflictDoUpdate({ target: [schema.jobContacts.jobId, schema.jobContacts.contactId], set: values })
    .returning();
  return row!;
}

/** Exact edit of one job person row: tags replace, ticks set as given. */
export async function updateJobPerson(id: number, patch: PersonPatch) {
  const [existing] = await db.select().from(schema.jobContacts).where(eq(schema.jobContacts.id, id));
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.tags) {
    const tags = parseTags([...patch.tags]);
    set.tags = tagsJson(tags);
    set.role = firstTag(tags);
    if (hasReferral(tags) && existing.actedForCompanyId == null && patch.actedForCompanyId === undefined) {
      set.actedForCompanyId = await actedForCompany(existing.contactId, await jobCompany(existing.jobId));
    }
  }
  for (const k of ["isPrimary", "onSiteContact", "canApproveQuote", "receivesSms", "receivesEmail", "showToCrew"] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.whenToContact !== undefined) set.whenToContact = patch.whenToContact?.trim() || null;
  if (patch.actedForCompanyId !== undefined) set.actedForCompanyId = patch.actedForCompanyId;
  const [row] = await db.update(schema.jobContacts).set(set).where(eq(schema.jobContacts.id, id)).returning();
  return row ?? null;
}

/**
 * Takes a tag off everyone on a job (for example, the old supervisor when a
 * new one is picked). A row left with no tags is removed.
 */
export async function removeJobTag(jobId: number, tag: PersonTag, exceptContactId?: number | null) {
  const rows = await db.select().from(schema.jobContacts).where(eq(schema.jobContacts.jobId, jobId));
  for (const r of rows) {
    if (exceptContactId && r.contactId === exceptContactId) continue;
    const tags = parseTags(r.tags);
    if (!tags.includes(tag)) continue;
    const left = tags.filter((t) => t !== tag);
    if (left.length === 0) {
      await db.delete(schema.jobContacts).where(eq(schema.jobContacts.id, r.id));
    } else {
      await db
        .update(schema.jobContacts)
        .set({ tags: tagsJson(left), role: firstTag(left), updatedAt: new Date() })
        .where(eq(schema.jobContacts.id, r.id));
    }
  }
}

/* --------------------------------- quotes --------------------------------- */

export async function addQuotePerson(quoteId: number, contactId: number, patch: PersonPatch) {
  const [existing] = await db
    .select()
    .from(schema.quoteContacts)
    .where(and(eq(schema.quoteContacts.quoteId, quoteId), eq(schema.quoteContacts.contactId, contactId)));
  const { isPrimary: _p, ...m } = mergePerson(existing ?? null, patch);
  if (m.actedForCompanyId == null && hasReferral(m.tags) && patch.actedForCompanyId === undefined) {
    m.actedForCompanyId = await actedForCompany(contactId, await quoteCompany(quoteId));
  }
  const values = { ...m, tags: tagsJson(m.tags), updatedAt: new Date() };
  if (existing) {
    const [row] = await db.update(schema.quoteContacts).set(values).where(eq(schema.quoteContacts.id, existing.id)).returning();
    return row!;
  }
  const [row] = await db
    .insert(schema.quoteContacts)
    .values({ quoteId, contactId, ...values })
    .onConflictDoUpdate({ target: [schema.quoteContacts.quoteId, schema.quoteContacts.contactId], set: values })
    .returning();
  return row!;
}

export async function updateQuotePerson(id: number, patch: PersonPatch) {
  const [existing] = await db.select().from(schema.quoteContacts).where(eq(schema.quoteContacts.id, id));
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.tags) {
    const tags = parseTags([...patch.tags]);
    set.tags = tagsJson(tags);
    if (hasReferral(tags) && existing.actedForCompanyId == null && patch.actedForCompanyId === undefined) {
      set.actedForCompanyId = await actedForCompany(existing.contactId, await quoteCompany(existing.quoteId));
    }
  }
  for (const k of ["onSiteContact", "canApproveQuote", "receivesSms", "receivesEmail", "showToCrew"] as const) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  if (patch.whenToContact !== undefined) set.whenToContact = patch.whenToContact?.trim() || null;
  if (patch.actedForCompanyId !== undefined) set.actedForCompanyId = patch.actedForCompanyId;
  const [row] = await db.update(schema.quoteContacts).set(set).where(eq(schema.quoteContacts.id, id)).returning();
  return row ?? null;
}

export async function listQuotePeople(quoteId: number) {
  const rows = await db
    .select({ link: schema.quoteContacts, contact: schema.contacts, company: schema.companies })
    .from(schema.quoteContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.quoteContacts.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.quoteContacts.actedForCompanyId))
    .where(eq(schema.quoteContacts.quoteId, quoteId))
    .orderBy(asc(schema.quoteContacts.id));
  return rows.map((r) => ({
    ...r.link,
    tags: parseTags(r.link.tags),
    contact: r.contact,
    actedForCompanyName: r.company?.name ?? null,
  }));
}

/** New version of a quote keeps its people. */
export async function copyQuotePeople(fromQuoteId: number, toQuoteId: number) {
  const rows = await db.select().from(schema.quoteContacts).where(eq(schema.quoteContacts.quoteId, fromQuoteId));
  for (const r of rows) {
    const { id: _id, quoteId: _q, createdAt: _c, updatedAt: _u, ...rest } = r;
    await db
      .insert(schema.quoteContacts)
      .values({ ...rest, quoteId: toQuoteId })
      .onConflictDoNothing();
  }
  return rows.length;
}

/** The tag the customer gets on a new job: Owner, or Builder contact when they sit in the billed company. */
export async function customerTag(contactId: number, companyId: number | null | undefined): Promise<PersonTag> {
  if (!companyId) return "owner";
  const [l] = await db
    .select({ id: schema.companyContacts.id })
    .from(schema.companyContacts)
    .where(and(eq(schema.companyContacts.companyId, companyId), eq(schema.companyContacts.contactId, contactId)));
  return l ? "builder_contact" : "owner";
}

/**
 * Puts the quote's people on the job: the customer, the supervisor and every
 * quote contact, merged so a person appears once with all their tags.
 */
export async function carryQuotePeopleToJob(quoteId: number, jobId: number) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!q) return 0;
  let n = 0;
  if (q.contactId) {
    const tag = await customerTag(q.contactId, q.companyId);
    await addJobPerson(jobId, q.contactId, {
      tags: [tag],
      isPrimary: true,
      onSiteContact: tag === "owner",
      canApproveQuote: true,
      receivesSms: true,
      receivesEmail: true,
      // The owner on a private job is who crew rings. A builder contact stays hidden until ticked.
      showToCrew: tag === "owner",
    });
    n++;
  }
  if (q.companyId && q.supervisorContactId) {
    await addJobPerson(jobId, q.supervisorContactId, {
      tags: ["supervisor"],
      isPrimary: true,
      receivesEmail: true,
      canApproveQuote: true,
    });
    n++;
  }
  const people = await db.select().from(schema.quoteContacts).where(eq(schema.quoteContacts.quoteId, quoteId));
  for (const p of people) {
    await addJobPerson(jobId, p.contactId, {
      tags: parseTags(p.tags),
      onSiteContact: p.onSiteContact,
      canApproveQuote: p.canApproveQuote,
      receivesSms: p.receivesSms,
      receivesEmail: p.receivesEmail,
      showToCrew: p.showToCrew,
      whenToContact: p.whenToContact,
      actedForCompanyId: p.actedForCompanyId ?? undefined,
    });
    n++;
  }
  return n;
}

/** Shape the web reads for one person on a job. */
export function shapeJobPerson<T extends { tags: string }>(link: T) {
  return { ...link, tags: parseTags(link.tags) };
}
