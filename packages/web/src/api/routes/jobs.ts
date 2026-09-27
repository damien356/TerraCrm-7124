import { z } from "zod";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/**
 * A job is the commercial container. The WORK inside it lives in job_tasks —
 * tasks are the dispatch unit, not jobs (see tasks.ts). A job also holds many
 * contacts with roles and per-person comms flags, and decides its own billing
 * target independently of who the work is for.
 */
export const jobs = {
  list: adminOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          statusId: z.number().optional(),
          stage: z.string().optional(),
          contactId: z.number().optional(),
          companyId: z.number().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ limit: 200 }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (input.statusId) where.push(eq(schema.jobs.statusId, input.statusId));
      if (input.contactId) where.push(eq(schema.jobs.contactId, input.contactId));
      if (input.companyId) where.push(eq(schema.jobs.companyId, input.companyId));
      if (input.stage) where.push(eq(schema.jobStatuses.stage, input.stage));
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        const asNumber = Number(input.search.replace(/\D/g, ""));
        where.push(
          or(
            like(sql`lower(${schema.jobs.title})`, q),
            like(sql`lower(coalesce(${schema.sites.address}, ''))`, q),
            like(sql`lower(coalesce(${schema.contacts.firstName} || ' ' || ${schema.contacts.lastName}, ''))`, q),
            like(sql`lower(coalesce(${schema.companies.name}, ''))`, q),
            // Old ServiceM8 numbers carry letters, e.g. 611577TF, so they are
            // matched as text rather than parsed.
            like(sql`lower(coalesce(${schema.jobs.externalRef}, ''))`, q),
            Number.isFinite(asNumber) && asNumber > 0 ? eq(schema.jobs.number, asNumber) : sql`0`,
          ),
        );
      }

      const rows = await db
        .select({
          job: schema.jobs,
          status: schema.jobStatuses,
          site: schema.sites,
          contact: schema.contacts,
          company: schema.companies,
          taskCount: sql<number>`(select count(*) from job_tasks t where t.job_id = jobs.id)`,
          doneCount: sql<number>`(select count(*) from job_tasks t where t.job_id = jobs.id and t.status = 'complete')`,
          unassignedCount: sql<number>`(select count(*) from job_tasks t where t.job_id = jobs.id and t.status = 'unassigned')`,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.jobs.number))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r.job,
        status: r.status,
        site: r.site,
        contact: r.contact,
        company: r.company,
        taskCount: Number(r.taskCount ?? 0),
        doneCount: Number(r.doneCount ?? 0),
        unassignedCount: Number(r.unassignedCount ?? 0),
      }));
    }),

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [row] = await db
      .select({
        job: schema.jobs,
        status: schema.jobStatuses,
        site: schema.sites,
        contact: schema.contacts,
        company: schema.companies,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
      .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
      .where(eq(schema.jobs.id, input.id));

    if (!row) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

    const [people, tasks, materials, photos, quoteRows, invoiceRows, activity] = await Promise.all([
      db
        .select({ link: schema.jobContacts, contact: schema.contacts })
        .from(schema.jobContacts)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
        .where(eq(schema.jobContacts.jobId, input.id))
        .orderBy(desc(schema.jobContacts.isPrimary)),
      db
        .select({
          task: schema.jobTasks,
          skill: schema.skills,
          installer: schema.installers,
          offerCount: sql<number>`(
            select count(*) from task_offers o
            where o.task_id = job_tasks.id and o.status = 'pending'
          )`,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
        .where(eq(schema.jobTasks.jobId, input.id))
        .orderBy(asc(schema.jobTasks.seq)),
      db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, input.id)),
      db.select().from(schema.taskPhotos).where(eq(schema.taskPhotos.jobId, input.id)).orderBy(desc(schema.taskPhotos.createdAt)),
      db.select().from(schema.quotes).where(eq(schema.quotes.jobId, input.id)).orderBy(desc(schema.quotes.version)),
      db.select().from(schema.invoices).where(eq(schema.invoices.jobId, input.id)),
      db
        .select()
        .from(schema.activityLog)
        .where(eq(schema.activityLog.jobId, input.id))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(50),
    ]);

    return {
      ...row.job,
      status: row.status,
      site: row.site,
      contact: row.contact,
      company: row.company,
      contacts: people,
      tasks: tasks.map((t) => ({
        ...t.task,
        skill: t.skill,
        installer: t.installer,
        pendingOffers: Number(t.offerCount ?? 0),
      })),
      materials,
      photos,
      quotes: quoteRows,
      invoices: invoiceRows,
      activity,
    };
  }),

  create: adminOnly
    .input(
      z.object({
        title: z.string().default(""),
        statusId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        billToType: z.enum(["contact", "company"]).default("contact"),
        billToContactId: z.number().nullable().optional(),
        billToCompanyId: z.number().nullable().optional(),
        furnitureOnSite: z.boolean().default(false),
        description: z.string().nullable().optional(),
        accessNotes: z.string().nullable().optional(),
        source: z.string().default("other"),
        value: z.number().default(0),
      }),
    )
    .handler(async ({ input, context }) => {
      const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${schema.jobs.number}), 200)` }).from(schema.jobs);
      const number = Number(maxRow?.max ?? 200) + 1;

      const [status] = input.statusId
        ? [{ id: input.statusId }]
        : await db
            .select({ id: schema.jobStatuses.id })
            .from(schema.jobStatuses)
            .where(eq(schema.jobStatuses.active, true))
            .orderBy(asc(schema.jobStatuses.sortOrder))
            .limit(1);

      const [row] = await db
        .insert(schema.jobs)
        .values({
          ...input,
          number,
          statusId: status?.id ?? null,
          billToContactId: input.billToType === "contact" ? (input.billToContactId ?? input.contactId ?? null) : null,
          billToCompanyId: input.billToType === "company" ? (input.billToCompanyId ?? input.companyId ?? null) : null,
        })
        .returning();

      if (row && input.contactId) {
        await db
          .insert(schema.jobContacts)
          .values({
            jobId: row.id,
            contactId: input.contactId,
            role: "job_contact",
            isPrimary: true,
            onSiteContact: true,
            receivesSms: true,
            receivesEmail: true,
            canApproveQuote: true,
          })
          .onConflictDoNothing();
      }

      await db.insert(schema.activityLog).values({
        jobId: row!.id,
        entityType: "job",
        entityId: row!.id,
        action: "created",
        detail: `Job #${number} created`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        statusId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        billToType: z.enum(["contact", "company"]).optional(),
        billToContactId: z.number().nullable().optional(),
        billToCompanyId: z.number().nullable().optional(),
        furnitureOnSite: z.boolean().optional(),
        description: z.string().nullable().optional(),
        accessNotes: z.string().nullable().optional(),
        source: z.string().optional(),
        value: z.number().optional(),
        depositAmount: z.number().optional(),
        depositPaid: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const [before] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

      const [row] = await db
        .update(schema.jobs)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobs.id, id))
        .returning();

      // The furniture rule is a data rule, not a UI rule: turning the flag on
      // forces every install task on the job up to a 2-man crew.
      if (rest.furnitureOnSite === true && !before.furnitureOnSite) {
        await db
          .update(schema.jobTasks)
          .set({ crewSize: 2, updatedAt: new Date() })
          .where(
            and(
              eq(schema.jobTasks.jobId, id),
              inArray(schema.jobTasks.status, ["unassigned", "offered", "assigned"]),
            ),
          );
        await db.insert(schema.activityLog).values({
          jobId: id,
          entityType: "job",
          entityId: id,
          action: "furniture_flagged",
          detail: "Furniture on site — install tasks forced to 2-man crews",
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }

      if (rest.statusId && rest.statusId !== before.statusId) {
        const [status] = await db.select().from(schema.jobStatuses).where(eq(schema.jobStatuses.id, rest.statusId));
        await db.insert(schema.activityLog).values({
          jobId: id,
          entityType: "job",
          entityId: id,
          action: "status_changed",
          detail: `Status → ${status?.name ?? rest.statusId}`,
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }

      return row;
    }),

  /* ------------------------- job contacts ------------------------- */
  addContact: adminOnly
    .input(
      z.object({
        jobId: z.number(),
        contactId: z.number(),
        role: z.string().default("job_contact"),
        isPrimary: z.boolean().default(false),
        onSiteContact: z.boolean().default(false),
        receivesSms: z.boolean().default(false),
        receivesEmail: z.boolean().default(false),
        canApproveQuote: z.boolean().default(false),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.jobContacts).values(input).onConflictDoNothing().returning();
      return row ?? { ok: true };
    }),

  updateContact: adminOnly
    .input(
      z.object({
        id: z.number(),
        role: z.string().optional(),
        isPrimary: z.boolean().optional(),
        onSiteContact: z.boolean().optional(),
        receivesSms: z.boolean().optional(),
        receivesEmail: z.boolean().optional(),
        canApproveQuote: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.jobContacts)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobContacts.id, id))
        .returning();
      return row;
    }),

  removeContact: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobContacts).where(eq(schema.jobContacts.id, input.id));
    return { ok: true };
  }),

  /* --------------------------- materials -------------------------- */
  addMaterial: adminOnly
    .input(
      z.object({
        jobId: z.number(),
        taskId: z.number().nullable().optional(),
        productId: z.number().nullable().optional(),
        description: z.string().min(1),
        qty: z.number().default(0),
        unit: z.string().default("m2"),
        status: z.string().default("to_order"),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.jobMaterials).values(input).returning();
      return row;
    }),

  updateMaterial: adminOnly
    .input(
      z.object({
        id: z.number(),
        description: z.string().optional(),
        qty: z.number().optional(),
        unit: z.string().optional(),
        status: z.string().optional(),
        taskId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.jobMaterials)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobMaterials.id, id))
        .returning();
      return row;
    }),

  removeMaterial: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobMaterials).where(eq(schema.jobMaterials.id, input.id));
    return { ok: true };
  }),

  /** Free-text note onto the job timeline. */
  addNote: adminOnly
    .input(z.object({ jobId: z.number(), body: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .insert(schema.activityLog)
        .values({
          jobId: input.jobId,
          entityType: "job",
          entityId: input.jobId,
          action: "note",
          detail: input.body,
          actorName: context.actor.name,
          actorRole: context.actor.role,
        })
        .returning();
      return row;
    }),
};
