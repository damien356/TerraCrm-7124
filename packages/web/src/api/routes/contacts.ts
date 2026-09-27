import { z } from "zod";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/**
 * A contact is a PERSON and exists once, forever. Companies are optional
 * wrappers (see companies.ts). Billing is decided per job, not per person —
 * so Carol can be ABC Builders' site manager and a retail customer at her own
 * house, on the same record, with one history.
 */
export const contacts = {
  list: adminOnly
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
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        where.push(
          or(
            like(sql`lower(${schema.contacts.firstName})`, q),
            like(sql`lower(${schema.contacts.lastName})`, q),
            like(sql`lower(coalesce(${schema.contacts.email}, ''))`, q),
            like(sql`coalesce(${schema.contacts.mobile}, '')`, `%${input.search}%`),
            like(sql`lower(coalesce(${schema.contacts.suburb}, ''))`, q),
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

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
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

  create: adminOnly
    .input(
      z.object({
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
      }),
    )
    .handler(async ({ input, context }) => {
      const { companyId, companyRole, ...values } = input;
      const [row] = await db.insert(schema.contacts).values(values).returning();
      if (companyId && row) {
        await db
          .insert(schema.companyContacts)
          .values({ companyId, contactId: row.id, role: companyRole })
          .onConflictDoNothing();
      }
      await db.insert(schema.activityLog).values({
        contactId: row!.id,
        entityType: "contact",
        entityId: row!.id,
        action: "created",
        detail: `${row!.firstName} ${row!.lastName}`.trim(),
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return row;
    }),

  update: adminOnly
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
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.contacts)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.contacts.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });
      return row;
    }),

  /** Attach an existing person to a company with a role. */
  linkCompany: adminOnly
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

  unlinkCompany: adminOnly.input(z.object({ linkId: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.companyContacts).where(eq(schema.companyContacts.id, input.linkId));
    return { ok: true };
  }),
};
