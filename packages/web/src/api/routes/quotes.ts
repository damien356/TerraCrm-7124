import { z } from "zod";
import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/**
 * Quotes are admin-only, end to end. Installers must never reach any procedure
 * in this file — pricing, margins and unit costs live here.
 *
 * Money rules: line total = qty × unitPrice. Subtotal is the sum of lines,
 * GST is 10% (Australia), total = subtotal + gst. Every write recalculates the
 * header from the lines so the two can never drift apart.
 */

const GST_RATE = 0.1;

/** Recalculate a quote header from its own line items. Returns the new totals. */
async function recalc(quoteId: number) {
  const items = await db
    .select({ total: schema.quoteItems.total })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId));

  const subtotal = round2(items.reduce((sum, i) => sum + (i.total ?? 0), 0));
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);

  await db
    .update(schema.quotes)
    .set({ subtotal, gst, total, updatedAt: new Date() })
    .where(eq(schema.quotes.id, quoteId));

  return { subtotal, gst, total };
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function quoteOrThrow(id: number) {
  const [row] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  return row;
}

export const quotes = {
  list: adminOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.string().optional(),
          contactId: z.number().optional(),
          companyId: z.number().optional(),
          jobId: z.number().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ limit: 200 }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (input.status) where.push(eq(schema.quotes.status, input.status));
      if (input.contactId) where.push(eq(schema.quotes.contactId, input.contactId));
      if (input.companyId) where.push(eq(schema.quotes.companyId, input.companyId));
      if (input.jobId) where.push(eq(schema.quotes.jobId, input.jobId));
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        const asNumber = Number(input.search.replace(/\D/g, ""));
        where.push(
          or(
            like(sql`lower(coalesce(${schema.sites.address}, ''))`, q),
            like(sql`lower(coalesce(${schema.contacts.firstName} || ' ' || ${schema.contacts.lastName}, ''))`, q),
            like(sql`lower(coalesce(${schema.companies.name}, ''))`, q),
            Number.isFinite(asNumber) && asNumber > 0 ? eq(schema.quotes.number, asNumber) : sql`0`,
          ),
        );
      }

      const rows = await db
        .select({
          quote: schema.quotes,
          contact: schema.contacts,
          company: schema.companies,
          site: schema.sites,
          job: { id: schema.jobs.id, number: schema.jobs.number },
          itemCount: sql<number>`(select count(*) from quote_items qi where qi.quote_id = quotes.id)`,
        })
        .from(schema.quotes)
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.quotes.jobId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.quotes.number), desc(schema.quotes.version))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r.quote,
        contact: r.contact,
        company: r.company,
        site: r.site,
        job: r.job?.id ? r.job : null,
        itemCount: Number(r.itemCount ?? 0),
      }));
    }),

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [row] = await db
      .select({
        quote: schema.quotes,
        contact: schema.contacts,
        company: schema.companies,
        site: schema.sites,
        job: { id: schema.jobs.id, number: schema.jobs.number, title: schema.jobs.title },
      })
      .from(schema.quotes)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
      .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.quotes.jobId))
      .where(eq(schema.quotes.id, input.id));

    if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });

    const [items, activity, versions] = await Promise.all([
      db
        .select()
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.id))
        .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id)),
      db
        .select()
        .from(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "quote"), eq(schema.activityLog.entityId, input.id)))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(50),
      db
        .select({
          id: schema.quotes.id,
          version: schema.quotes.version,
          status: schema.quotes.status,
          total: schema.quotes.total,
          createdAt: schema.quotes.createdAt,
        })
        .from(schema.quotes)
        .where(eq(schema.quotes.number, row.quote.number))
        .orderBy(desc(schema.quotes.version)),
    ]);

    const cost = items.reduce((sum, i) => sum + (i.unitCost ?? 0) * (i.qty ?? 0), 0);

    return {
      ...row.quote,
      contact: row.contact,
      company: row.company,
      site: row.site,
      job: row.job?.id ? row.job : null,
      items,
      activity,
      versions,
      /** Admin-only margin figures. Never expose these through field.ts. */
      estimatedCost: round2(cost),
      estimatedMargin: round2(row.quote.subtotal - cost),
      estimatedMarginPercent: row.quote.subtotal > 0 ? round2(((row.quote.subtotal - cost) / row.quote.subtotal) * 100) : 0,
    };
  }),

  create: adminOnly
    .input(
      z.object({
        jobId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        depositPercent: z.number().min(0).max(100).default(0),
        validDays: z.number().int().min(1).max(365).default(30),
        notes: z.string().nullable().optional(),
        terms: z.string().nullable().optional(),
        items: z
          .array(
            z.object({
              productId: z.number().nullable().optional(),
              kind: z.string().default("supply"),
              description: z.string().min(1),
              qty: z.number().default(1),
              unit: z.string().default("m2"),
              unitPrice: z.number().default(0),
              unitCost: z.number().nullable().optional(),
            }),
          )
          .default([]),
      }),
    )
    .handler(async ({ input, context }) => {
      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quotes.number}), 1000)` })
        .from(schema.quotes);
      const number = Number(maxRow?.max ?? 1000) + 1;

      const [settingRow] = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "quote_terms"));

      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + input.validDays);

      const [row] = await db
        .insert(schema.quotes)
        .values({
          number,
          version: 1,
          jobId: input.jobId ?? null,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          siteId: input.siteId ?? null,
          status: "draft",
          depositPercent: input.depositPercent,
          validUntil,
          notes: input.notes ?? null,
          terms: input.terms ?? settingRow?.value ?? null,
        })
        .returning();

      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Quote not created" });

      if (input.items.length) {
        await db.insert(schema.quoteItems).values(
          input.items.map((item, i) => ({
            quoteId: row.id,
            productId: item.productId ?? null,
            kind: item.kind,
            description: item.description,
            qty: item.qty,
            unit: item.unit,
            unitPrice: item.unitPrice,
            unitCost: item.unitCost ?? null,
            total: round2(item.qty * item.unitPrice),
            sortOrder: i,
          })),
        );
      }

      const totals = await recalc(row.id);

      await db.insert(schema.activityLog).values({
        jobId: input.jobId ?? null,
        contactId: input.contactId ?? null,
        entityType: "quote",
        entityId: row.id,
        action: "created",
        detail: `Quote #${number} created`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { ...row, ...totals };
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        jobId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        status: z.enum(["draft", "sent", "accepted", "declined", "expired"]).optional(),
        depositPercent: z.number().min(0).max(100).optional(),
        validUntil: z.date().nullable().optional(),
        notes: z.string().nullable().optional(),
        terms: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      await quoteOrThrow(id);
      const [row] = await db
        .update(schema.quotes)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.quotes.id, id))
        .returning();
      return row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const quote = await quoteOrThrow(input.id);
    if (quote.status === "accepted") {
      throw new ORPCError("BAD_REQUEST", { message: "An accepted quote can't be deleted — void it instead" });
    }
    await db.delete(schema.quotes).where(eq(schema.quotes.id, input.id));
    return { ok: true };
  }),

  /* ----------------------------- line items ----------------------------- */

  addItem: adminOnly
    .input(
      z.object({
        quoteId: z.number(),
        productId: z.number().nullable().optional(),
        kind: z.string().default("supply"),
        description: z.string().min(1),
        qty: z.number().default(1),
        unit: z.string().default("m2"),
        unitPrice: z.number().default(0),
        unitCost: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      await quoteOrThrow(input.quoteId);
      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.quoteId));

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          productId: input.productId ?? null,
          kind: input.kind,
          description: input.description,
          qty: input.qty,
          unit: input.unit,
          unitPrice: input.unitPrice,
          unitCost: input.unitCost ?? null,
          total: round2(input.qty * input.unitPrice),
          sortOrder: Number(maxRow?.max ?? -1) + 1,
        })
        .returning();

      const totals = await recalc(input.quoteId);
      return { item: row, totals };
    }),

  /** Add a line straight off the price list, carrying sell price and cost across. */
  addProduct: adminOnly
    .input(z.object({ quoteId: z.number(), productId: z.number(), qty: z.number().default(1) }))
    .handler(async ({ input }) => {
      await quoteOrThrow(input.quoteId);
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.quoteId));

      const unitPrice = product.sellPrice ?? 0;
      const description = [product.brand, product.range, product.colour].filter(Boolean).join(" — ");

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          productId: product.id,
          kind: product.category === "labour" ? "labour" : "supply",
          description: description || product.sku || "Product",
          qty: input.qty,
          unit: product.unit,
          unitPrice,
          unitCost: product.costPrice ?? null,
          total: round2(input.qty * unitPrice),
          sortOrder: Number(maxRow?.max ?? -1) + 1,
        })
        .returning();

      const totals = await recalc(input.quoteId);
      return { item: row, totals };
    }),

  updateItem: adminOnly
    .input(
      z.object({
        id: z.number(),
        kind: z.string().optional(),
        description: z.string().min(1).optional(),
        qty: z.number().optional(),
        unit: z.string().optional(),
        unitPrice: z.number().optional(),
        unitCost: z.number().nullable().optional(),
        sortOrder: z.number().int().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });

      const qty = rest.qty ?? before.qty;
      const unitPrice = rest.unitPrice ?? before.unitPrice;

      const [row] = await db
        .update(schema.quoteItems)
        .set({ ...rest, total: round2(qty * unitPrice), updatedAt: new Date() })
        .where(eq(schema.quoteItems.id, id))
        .returning();

      const totals = await recalc(before.quoteId);
      return { item: row, totals };
    }),

  removeItem: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
    if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
    await db.delete(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
    const totals = await recalc(before.quoteId);
    return { totals };
  }),

  /** Drag-reorder the lines on a quote. */
  reorderItems: adminOnly
    .input(z.object({ quoteId: z.number(), orderedIds: z.array(z.number()) }))
    .handler(async ({ input }) => {
      await Promise.all(
        input.orderedIds.map((id, i) =>
          db
            .update(schema.quoteItems)
            .set({ sortOrder: i, updatedAt: new Date() })
            .where(and(eq(schema.quoteItems.id, id), eq(schema.quoteItems.quoteId, input.quoteId))),
        ),
      );
      return { ok: true };
    }),

  /* ------------------------------ lifecycle ----------------------------- */

  send: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await quoteOrThrow(input.id);
    const [row] = await db
      .update(schema.quotes)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.quotes.id, input.id))
      .returning();

    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: quote.id,
      action: "sent",
      detail: `Quote #${quote.number} marked as sent`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });

    return row;
  }),

  accept: adminOnly
    .input(z.object({ id: z.number(), note: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);

      const [row] = await db
        .update(schema.quotes)
        .set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.quotes.id, input.id))
        .returning();

      // Sibling versions of the same quote number lose.
      await db
        .update(schema.quotes)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(schema.quotes.number, quote.number),
            inArray(schema.quotes.status, ["draft", "sent"]),
            sql`${schema.quotes.id} != ${quote.id}`,
          ),
        );

      // Keep the linked job's value honest with the accepted price.
      if (quote.jobId) {
        await db
          .update(schema.jobs)
          .set({ value: quote.total, updatedAt: new Date() })
          .where(eq(schema.jobs.id, quote.jobId));
      }

      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "accepted",
        detail: input.note?.trim() || `Quote #${quote.number} accepted — $${quote.total.toFixed(2)}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  decline: adminOnly
    .input(z.object({ id: z.number(), reason: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      const [row] = await db
        .update(schema.quotes)
        .set({ status: "declined", updatedAt: new Date() })
        .where(eq(schema.quotes.id, input.id))
        .returning();

      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "declined",
        detail: `Quote #${quote.number} declined — ${input.reason}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  /** Copy a quote into a new version so the original stays as sent history. */
  revise: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await quoteOrThrow(input.id);
    const items = await db
      .select()
      .from(schema.quoteItems)
      .where(eq(schema.quoteItems.quoteId, quote.id))
      .orderBy(asc(schema.quoteItems.sortOrder));

    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${schema.quotes.version}), 1)` })
      .from(schema.quotes)
      .where(eq(schema.quotes.number, quote.number));

    const [row] = await db
      .insert(schema.quotes)
      .values({
        number: quote.number,
        version: Number(maxRow?.max ?? 1) + 1,
        jobId: quote.jobId,
        contactId: quote.contactId,
        companyId: quote.companyId,
        siteId: quote.siteId,
        status: "draft",
        depositPercent: quote.depositPercent,
        validUntil: quote.validUntil,
        notes: quote.notes,
        terms: quote.terms,
      })
      .returning();

    if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Revision not created" });

    if (items.length) {
      await db.insert(schema.quoteItems).values(
        items.map((i, idx) => ({
          quoteId: row.id,
          productId: i.productId,
          kind: i.kind,
          description: i.description,
          qty: i.qty,
          unit: i.unit,
          unitPrice: i.unitPrice,
          unitCost: i.unitCost,
          total: i.total,
          sortOrder: idx,
        })),
      );
    }

    const totals = await recalc(row.id);

    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: row.id,
      action: "revised",
      detail: `Quote #${quote.number} v${row.version} created from v${quote.version}`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });

    return { ...row, ...totals };
  }),

  /**
   * Turn an accepted quote into a job. Labour/prep/removal lines become
   * unassigned TASKS (the dispatch unit) and supply lines become materials.
   */
  convertToJob: adminOnly
    .input(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        furnitureOnSite: z.boolean().default(false),
        createTasks: z.boolean().default(true),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      if (quote.jobId) {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is already attached to a job" });
      }

      const items = await db
        .select()
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quote.id))
        .orderBy(asc(schema.quoteItems.sortOrder));

      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.jobs.number}), 200)` })
        .from(schema.jobs);
      const number = Number(maxRow?.max ?? 200) + 1;

      const [status] = await db
        .select({ id: schema.jobStatuses.id })
        .from(schema.jobStatuses)
        .where(eq(schema.jobStatuses.active, true))
        .orderBy(asc(schema.jobStatuses.sortOrder))
        .limit(1);

      const [site] = quote.siteId
        ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId))
        : [undefined];

      const [job] = await db
        .insert(schema.jobs)
        .values({
          number,
          title: input.title || site?.address || `Quote #${quote.number}`,
          statusId: status?.id ?? null,
          siteId: quote.siteId,
          contactId: quote.contactId,
          companyId: quote.companyId,
          // Billing is decided per job, not per person: a company on the quote
          // means the company pays, otherwise the person does.
          billToType: quote.companyId ? "company" : "contact",
          billToContactId: quote.companyId ? null : quote.contactId,
          billToCompanyId: quote.companyId ?? null,
          furnitureOnSite: input.furnitureOnSite,
          accessNotes: site?.accessNotes ?? null,
          value: quote.total,
        })
        .returning();

      if (!job) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Job not created" });

      if (quote.contactId) {
        await db
          .insert(schema.jobContacts)
          .values({
            jobId: job.id,
            contactId: quote.contactId,
            role: "job_contact",
            isPrimary: true,
            onSiteContact: true,
            receivesSms: true,
            receivesEmail: true,
            canApproveQuote: true,
          })
          .onConflictDoNothing();
      }

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

      // Work lines become unassigned tasks — one dispatch each.
      let tasksCreated = 0;
      if (input.createTasks) {
        const workLines = items.filter((i) => i.kind === "labour" || i.kind === "prep" || i.kind === "removal");
        const skills = await db
          .select()
          .from(schema.skills)
          .where(eq(schema.skills.active, true))
          .orderBy(asc(schema.skills.sortOrder));

        for (const [idx, line] of workLines.entries()) {
          const haystack = line.description.toLowerCase();
          const skill =
            skills.find((s) => haystack.includes(s.name.toLowerCase())) ??
            skills.find((s) => (line.kind === "removal" ? s.groupName === "demolition" : s.groupName === "prep"));

          const crewSize = input.furnitureOnSite ? 2 : (skill?.defaultCrewSize ?? 1);

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

      await db
        .update(schema.quotes)
        .set({ jobId: job.id, updatedAt: new Date() })
        .where(eq(schema.quotes.id, quote.id));

      await db.insert(schema.activityLog).values({
        jobId: job.id,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "converted",
        detail: `Quote #${quote.number} converted to job #${number} — ${tasksCreated} task(s), ${supplyLines.length} material line(s)`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { job, tasksCreated, materialsCreated: supplyLines.length };
    }),

  /** Dashboard/pipeline figures for the quotes screen. */
  stats: adminOnly.handler(async () => {
    const rows = await db
      .select({
        status: schema.quotes.status,
        count: sql<number>`count(*)`,
        value: sql<number>`coalesce(sum(${schema.quotes.total}), 0)`,
      })
      .from(schema.quotes)
      .groupBy(schema.quotes.status);

    const byStatus = Object.fromEntries(
      rows.map((r) => [r.status, { count: Number(r.count), value: Number(r.value) }]),
    ) as Record<string, { count: number; value: number }>;

    return {
      byStatus,
      outstandingValue: round2(byStatus.sent?.value ?? 0),
      draftCount: byStatus.draft?.count ?? 0,
      sentCount: byStatus.sent?.count ?? 0,
      acceptedValue: round2(byStatus.accepted?.value ?? 0),
    };
  }),
};
