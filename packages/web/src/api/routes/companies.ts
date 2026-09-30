import { z } from "zod";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/**
 * Companies are an OPTIONAL wrapper around contacts. A company never owns a
 * person — `company_contacts` links them with a role, and a person can sit in
 * several companies. Whether a job bills to the company or to the person is
 * decided on the job (`jobs.billToType`), never here.
 */
export const companies = {
  list: adminOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          includeInactive: z.boolean().default(false),
        })
        .default({ includeInactive: false }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (!input.includeInactive) where.push(eq(schema.companies.active, true));
      if (input.search) {
        where.push(like(sql`lower(${schema.companies.name})`, `%${input.search.toLowerCase()}%`));
      }

      const rows = await db
        .select({
          company: schema.companies,
          contactCount: sql<number>`(
            select count(*) from company_contacts cc where cc.company_id = companies.id
          )`,
          openJobs: sql<number>`(
            select count(*) from jobs j
            join job_statuses s on s.id = j.status_id
            where j.company_id = companies.id and s.stage not in ('complete','closed')
          )`,
          jobCount: sql<number>`(select count(*) from jobs j where j.company_id = companies.id)`,
          siteCount: sql<number>`(select count(*) from sites s where s.company_id = companies.id)`,
        })
        .from(schema.companies)
        .where(where.length ? and(...where) : undefined)
        .orderBy(asc(schema.companies.name));

      return rows.map((r) => ({
        ...r.company,
        contactCount: Number(r.contactCount ?? 0),
        openJobs: Number(r.openJobs ?? 0),
        jobCount: Number(r.jobCount ?? 0),
        siteCount: Number(r.siteCount ?? 0),
      }));
    }),

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [company] = await db.select().from(schema.companies).where(eq(schema.companies.id, input.id));
    if (!company) throw new ORPCError("NOT_FOUND", { message: "Company not found" });

    const [people, sites, jobRows] = await Promise.all([
      db
        .select({ link: schema.companyContacts, contact: schema.contacts })
        .from(schema.companyContacts)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.companyContacts.contactId))
        .where(eq(schema.companyContacts.companyId, input.id))
        .orderBy(desc(schema.companyContacts.isPrimary)),
      db.select().from(schema.sites).where(eq(schema.sites.companyId, input.id)),
      db
        .select({ job: schema.jobs, status: schema.jobStatuses, site: schema.sites })
        .from(schema.jobs)
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(eq(schema.jobs.companyId, input.id))
        .orderBy(desc(schema.jobs.number)),
    ]);

    return { company, people, sites, jobs: jobRows };
  }),

  /**
   * The people filed under one company, optionally narrowed to certain roles.
   * Used by the supervisor picker on a job, which only wants the people who
   * could plausibly have sent the work.
   */
  people: adminOnly
    .input(z.object({ companyId: z.number(), roles: z.array(z.string()).optional() }))
    .handler(async ({ input }) => {
      const where = [eq(schema.companyContacts.companyId, input.companyId)];
      if (input.roles?.length) where.push(inArray(schema.companyContacts.role, input.roles));

      const rows = await db
        .select({ link: schema.companyContacts, contact: schema.contacts })
        .from(schema.companyContacts)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.companyContacts.contactId))
        .where(and(...where))
        .orderBy(desc(schema.companyContacts.isPrimary), asc(schema.contacts.firstName));

      return rows.map((r) => ({
        contactId: r.contact.id,
        name: `${r.contact.firstName} ${r.contact.lastName}`.trim(),
        mobile: r.contact.mobile,
        email: r.contact.email,
        role: r.link.role,
        jobTitle: r.link.jobTitle,
        isPrimary: r.link.isPrimary,
      }));
    }),

  create: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        abn: z.string().nullable().optional(),
        type: z.string().default("builder"),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        billingAddress: z.string().nullable().optional(),
        paymentTerms: z.number().int().min(0).default(14),
        creditLimit: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.companies).values(input).returning();
      return row;
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        abn: z.string().nullable().optional(),
        type: z.string().optional(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        billingAddress: z.string().nullable().optional(),
        paymentTerms: z.number().int().min(0).optional(),
        creditLimit: z.number().nullable().optional(),
        notes: z.string().nullable().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.companies)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.companies.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Company not found" });
      return row;
    }),
};

/** Sites — the physical addresses work happens at. */
export const sites = {
  list: adminOnly
    .input(z.object({ search: z.string().optional(), contactId: z.number().optional() }).default({}))
    .handler(async ({ input }) => {
      const where = [];
      if (input.contactId) where.push(eq(schema.sites.contactId, input.contactId));
      if (input.search) {
        where.push(like(sql`lower(${schema.sites.address})`, `%${input.search.toLowerCase()}%`));
      }
      return db
        .select({ site: schema.sites, contact: schema.contacts, company: schema.companies })
        .from(schema.sites)
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.sites.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.sites.companyId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(asc(schema.sites.address))
        .limit(200);
    }),

  create: adminOnly
    .input(
      z.object({
        label: z.string().nullable().optional(),
        address: z.string().min(1),
        suburb: z.string().default(""),
        state: z.string().default("QLD"),
        postcode: z.string().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        accessNotes: z.string().nullable().optional(),
        propertyType: z.string().default("residential"),
        notes: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.sites).values(input).returning();
      return row;
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        label: z.string().nullable().optional(),
        address: z.string().min(1).optional(),
        suburb: z.string().optional(),
        state: z.string().optional(),
        postcode: z.string().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        accessNotes: z.string().nullable().optional(),
        propertyType: z.string().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.sites)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.sites.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Site not found" });
      return row;
    }),
};
