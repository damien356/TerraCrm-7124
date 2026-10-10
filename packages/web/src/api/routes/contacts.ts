import { z } from "zod";
import { isSupervisor, notifySupervisorChange } from "../lib/supervisors";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, type Actor } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";

export const createContactInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().default(""),
  mobile: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  suburb: z.string().nullable().optional(),
  postcode: z.string().nullable().optional(),
  source: z.string().default("other"),
  notes: z.string().nullable().optional(),
  marketingOptIn: z.boolean().default(false),
  /** Optionally file them under a company straight away. */
  companyId: z.number().nullable().optional(),
  companyRole: z.string().default("other"),
  /** Their job title at that company, e.g. "Site supervisor". */
  companyJobTitle: z.string().nullable().optional(),
});

/** Shared with voice memos, which offer a new client straight out of a recording. */
export async function createContact(input: z.input<typeof createContactInput>, actor: Pick<Actor, "name" | "role">) {
  const parsed = createContactInput.parse(input);
  const { companyId, companyRole, companyJobTitle, ...values } = parsed;
  const [row] = await db.insert(schema.contacts).values(values).returning();
  if (companyId && row) {
    await db
      .insert(schema.companyContacts)
      .values({ companyId, contactId: row.id, role: companyRole, jobTitle: companyJobTitle?.trim() || null })
      .onConflictDoNothing();
  }
  await db.insert(schema.activityLog).values({
    contactId: row!.id,
    entityType: "contact",
    entityId: row!.id,
    action: "created",
    detail: `${row!.firstName} ${row!.lastName}`.trim(),
    actorName: actor.name,
    actorRole: actor.role,
  });
  return row;
}

/**
 * A contact is a PERSON and exists once, forever. Companies are optional
 * wrappers (see companies.ts). Billing is decided per job, not per person —
 * so Carol can be ABC Builders' site manager and a retail customer at her own
 * house, on the same record, with one history.
 */
export const contacts = {
  list: staffOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          companyId: z.number().optional(),
          includeInactive: z.boolean().default(false),
          /** Migrated records still waiting on a human decision (see review.ts). */
          needsReview: z.boolean().optional(),
          /** Only people there is a lawful basis to market to, block respected. */
          marketableOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ includeInactive: false, limit: 200 }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (!input.includeInactive) where.push(eq(schema.contacts.active, true));
      if (input.needsReview !== undefined) where.push(eq(schema.contacts.needsReview, input.needsReview));
      if (input.marketableOnly) {
        where.push(sql`${schema.contacts.marketingBasis} != 'none'`);
        where.push(eq(schema.contacts.doNotMarket, false));
      }
      // Every word has to match somewhere, so "marcos brancea" finds Marcos
      // Brancea and "brancea bahrs" finds him by suburb. A search that is only
      // a number ("0434 107", "+61 434") is read as one phone number. Phones
      // are compared as bare digits with the leading 0 or 61 dropped, so the
      // local "0434 107" finds "+61434107559" and the other way round.
      const raw = (input.search ?? "").trim();
      const compact = raw.replace(/[\s()+.-]/g, "");
      const words = /^\d{3,}$/.test(compact) ? [compact] : raw.toLowerCase().split(/\s+/).filter(Boolean);
      const bareMobile = sql`replace(replace(replace(replace(replace(coalesce(${schema.contacts.mobile}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', '')`;
      const barePhone = sql`replace(replace(replace(replace(replace(coalesce(${schema.contacts.phone}, ''), ' ', ''), '+', ''), '-', ''), '(', ''), ')', '')`;
      for (const word of words) {
        const q = `%${word}%`;
        const digits = word.replace(/\D/g, "");
        const core = digits.startsWith("61") ? digits.slice(2) : digits.startsWith("0") ? digits.slice(1) : digits;
        const phoneMatches =
          digits.length >= 3 && core.length >= 2
            ? [like(bareMobile, `%${core}%`), like(barePhone, `%${core}%`)]
            : [];
        where.push(
          or(
            like(sql`lower(${schema.contacts.firstName})`, q),
            like(sql`lower(${schema.contacts.lastName})`, q),
            like(sql`lower(coalesce(${schema.contacts.email}, ''))`, q),
            like(sql`lower(coalesce(${schema.contacts.suburb}, ''))`, q),
            ...phoneMatches,
          ),
        );
      }

      const rows = await db
        .select({
          contact: schema.contacts,
          jobCount: sql<number>`(
            select count(*) from jobs j where j.contact_id = contacts.id
          )`,
          companyNames: sql<string>`(
            select group_concat(c.name, ', ') from company_contacts cc
            join companies c on c.id = cc.company_id
            where cc.contact_id = contacts.id
          )`,
        })
        .from(schema.contacts)
        .where(where.length ? and(...where) : undefined)
        .orderBy(asc(schema.contacts.lastName), asc(schema.contacts.firstName))
        .limit(input.limit);

      const filtered = input.companyId
        ? await (async () => {
            const links = await db
              .select({ contactId: schema.companyContacts.contactId })
              .from(schema.companyContacts)
              .where(eq(schema.companyContacts.companyId, input.companyId!));
            const ids = new Set(links.map((l) => l.contactId));
            return rows.filter((r) => ids.has(r.contact.id));
          })()
        : rows;

      return filtered.map((r) => ({
        ...r.contact,
        jobCount: Number(r.jobCount ?? 0),
        companyNames: r.companyNames ?? "",
      }));
    }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.id));
    if (!contact) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });

    const [companies, sites, jobRows, quoteRows, activity] = await Promise.all([
      db
        .select({ link: schema.companyContacts, company: schema.companies })
        .from(schema.companyContacts)
        .innerJoin(schema.companies, eq(schema.companies.id, schema.companyContacts.companyId))
        .where(eq(schema.companyContacts.contactId, input.id)),
      db.select().from(schema.sites).where(eq(schema.sites.contactId, input.id)),
      db
        .select({
          job: schema.jobs,
          status: schema.jobStatuses,
          site: schema.sites,
          role: sql<string>`(
            select jc.role from job_contacts jc
            where jc.job_id = jobs.id and jc.contact_id = ${input.id} limit 1
          )`,
          /** JSON list of this person's tags on the job (lib/person-tags.ts). */
          tags: sql<string | null>`(
            select jc.tags from job_contacts jc
            where jc.job_id = jobs.id and jc.contact_id = ${input.id} limit 1
          )`,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(
          or(
            eq(schema.jobs.contactId, input.id),
            eq(schema.jobs.billToContactId, input.id),
            sql`exists (select 1 from ${schema.jobContacts} jc where jc.job_id = ${schema.jobs.id} and jc.contact_id = ${input.id})`,
          ),
        )
        .orderBy(desc(schema.jobs.number)),
      db.select().from(schema.quotes).where(eq(schema.quotes.contactId, input.id)).orderBy(desc(schema.quotes.number)),
      db
        .select()
        .from(schema.activityLog)
        .where(eq(schema.activityLog.contactId, input.id))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(30),
    ]);

    return { contact, companies, sites, jobs: jobRows, quotes: quoteRows, activity };
  }),

  create: staffOnly
    .input(createContactInput)
    .handler(({ input, context }) => createContact(input, context.actor)),

  update: staffOnly
    .input(
      z.object({
        id: z.number(),
        firstName: z.string().min(1).optional(),
        lastName: z.string().optional(),
        mobile: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        suburb: z.string().nullable().optional(),
        postcode: z.string().nullable().optional(),
        source: z.string().optional(),
        notes: z.string().nullable().optional(),
        marketingOptIn: z.boolean().optional(),
        /** Deposit % new quotes start at when no company is on the quote. Null = 50. */
        depositPercent: z.number().min(0).max(100).nullable().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [before] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, id));
      const [row] = await db
        .update(schema.contacts)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.contacts.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });
      if (before && before.depositPercent !== row.depositPercent) {
        await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after deposit change failed:", e));
      }
      const emailChanged =
        rest.email !== undefined && before && (before.email ?? "").trim().toLowerCase() !== (rest.email ?? "").trim().toLowerCase();
      if (emailChanged && before?.email && (await isSupervisor(id))) {
        await notifySupervisorChange({
          name: `${row.firstName} ${row.lastName}`.trim(),
          contactId: id,
          oldEmail: before.email,
          newEmail: rest.email ?? "",
          mobile: row.mobile,
        });
      }
      return row;
    }),

  /**
   * A supervisor moves to another company. History stays: old jobs and quotes
   * keep the company they were for, and the old link becomes "former
   * supervisor". Damien gets an email so he can chase work at the new place.
   */
  moveCompany: staffOnly
    .input(
      z.object({
        contactId: z.number(),
        toCompanyId: z.number(),
        email: z.string().trim().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId));
      if (!c) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });
      const [to] = await db.select().from(schema.companies).where(eq(schema.companies.id, input.toCompanyId));
      if (!to) throw new ORPCError("NOT_FOUND", { message: "Company not found" });

      const current = await db
        .select({ link: schema.companyContacts, company: schema.companies })
        .from(schema.companyContacts)
        .innerJoin(schema.companies, eq(schema.companies.id, schema.companyContacts.companyId))
        .where(and(eq(schema.companyContacts.contactId, input.contactId), eq(schema.companyContacts.role, "supervisor")));
      const old = current.find((r) => r.link.companyId !== input.toCompanyId) ?? current[0];
      if (current.some((r) => r.link.companyId === input.toCompanyId) && current.length === 1 && input.email === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "They already work for that company" });
      }

      for (const r of current) {
        if (r.link.companyId === input.toCompanyId) continue;
        await db
          .update(schema.companyContacts)
          .set({ role: "former_supervisor", isPrimary: false })
          .where(eq(schema.companyContacts.id, r.link.id));
      }
      await db
        .insert(schema.companyContacts)
        .values({ contactId: input.contactId, companyId: input.toCompanyId, role: "supervisor", isPrimary: true })
        .onConflictDoNothing();

      const emailChanged = input.email !== undefined && (input.email ?? "") !== (c.email ?? "");
      if (emailChanged) {
        await db.update(schema.contacts).set({ email: input.email || null, updatedAt: new Date() }).where(eq(schema.contacts.id, input.contactId));
      }
      await notifySupervisorChange({
        name: `${c.firstName} ${c.lastName}`.trim(),
        contactId: input.contactId,
        oldCompany: old?.company.name ?? null,
        newCompany: old?.link.companyId === input.toCompanyId ? null : to.name,
        oldEmail: c.email,
        newEmail: emailChanged ? (input.email ?? "") : undefined,
        mobile: c.mobile,
      });
      return { ok: true };
    }),

  /** Attach an existing person to a company with a role. */
  linkCompany: staffOnly
    .input(
      z.object({
        contactId: z.number(),
        companyId: z.number(),
        role: z.string().default("other"),
        jobTitle: z.string().nullable().optional(),
        isPrimary: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.companyContacts).values(input).onConflictDoNothing().returning();
      return row ?? { ok: true };
    }),

  unlinkCompany: staffOnly.input(z.object({ linkId: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.companyContacts).where(eq(schema.companyContacts.id, input.linkId));
    return { ok: true };
  }),
};
