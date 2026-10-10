import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, authed } from "../middleware/auth";
import { groupForSkill } from "./labour";
import { autoSoldAs, SOLD_AS } from "../lib/flooring-qty";
import { JOB_NUMBER_KEY, JOB_NUMBER_START_KEY, jobNumbering, setJobNumberStart } from "../lib/job-number";

/**
 * Skills, job statuses and key/value settings are editable DATA, never hardcoded
 * enums — Damien adds/renames them in the app after testing without a rebuild.
 */
/** Setting keys that never go to Office or Field crew. */
const SENSITIVE_SETTING = /(key|token|secret|password|xero|clicksend|supabase|github|markup|margin|cost|credit|tier|formula)/i;

export const settings = {
  /** Everything the admin UI needs to render pickers, in one round trip. */
  bootstrap: authed.handler(async ({ context }) => {
    const [skills, statuses, kv] = await Promise.all([
      db.select().from(schema.skills).orderBy(asc(schema.skills.sortOrder), asc(schema.skills.name)),
      db.select().from(schema.jobStatuses).orderBy(asc(schema.jobStatuses.sortOrder)),
      db.select().from(schema.settings),
    ]);
    return {
      actor: context.actor,
      skills: skills.filter((s) => s.active),
      allSkills: skills,
      statuses: statuses.filter((s) => s.active),
      allStatuses: statuses,
      // Integration keys, markups and other money settings are for Admin only.
      settings: Object.fromEntries(
        kv
          .filter((r) => context.actor.role === "admin" || !SENSITIVE_SETTING.test(r.key))
          .map((r) => [r.key, r.value]),
      ) as Record<string, string>,
    };
  }),

  /* ----------------------------- skills ----------------------------- */
  skillCreate: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        groupName: z.string().default("other"),
        defaultCrewSize: z.number().int().min(1).max(2).default(1),
        /** How the job gets crewed and how fast it goes, for duration maths. */
        minCrew: z.number().int().min(1).max(10).default(1),
        recommendedCrew: z.number().int().min(1).max(10).default(1),
        productionRate: z.number().min(0).nullable().default(null),
        productionUnit: z.string().default("m2"),
        extraCrewUpliftPct: z.number().int().min(0).max(200).default(35),
        fixedDays: z.number().min(0).max(30).default(0),
        sortOrder: z.number().int().default(0),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.skills).values(input).returning();
      return row;
    }),

  skillUpdate: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        groupName: z.string().optional(),
        defaultCrewSize: z.number().int().min(1).max(2).optional(),
        minCrew: z.number().int().min(1).max(10).optional(),
        recommendedCrew: z.number().int().min(1).max(10).optional(),
        productionRate: z.number().min(0).nullable().optional(),
        productionUnit: z.string().optional(),
        extraCrewUpliftPct: z.number().int().min(0).max(200).optional(),
        fixedDays: z.number().min(0).max(30).optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.skills)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.skills.id, id))
        .returning();
      // The items under a skill follow it into its new section.
      const g = row && rest.groupName !== undefined ? await groupForSkill(row.id) : null;
      if (g) {
        await db
          .update(schema.labourRateItems)
          .set({ groupName: g, updatedAt: new Date() })
          .where(eq(schema.labourRateItems.skillId, row.id));
      }
      return row;
    }),

  /* --------------------------- job statuses -------------------------- */
  statusCreate: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        colour: z.string().default("#7A736D"),
        stage: z.string().default("open"),
        sortOrder: z.number().int().default(0),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.jobStatuses).values(input).returning();
      return row;
    }),

  statusUpdate: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        colour: z.string().optional(),
        stage: z.string().optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.jobStatuses)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobStatuses.id, id))
        .returning();
      return row;
    }),

  /* ------------------------------ kv -------------------------------- */
  set: adminOnly
    .input(z.object({ key: z.string().min(1), value: z.string() }))
    .handler(async ({ input }) => {
      // Job numbers have their own checked setter below. Written here they
      // could go backwards and hand out a number already in use.
      if (input.key === JOB_NUMBER_KEY || input.key === JOB_NUMBER_START_KEY) {
        throw new ORPCError("BAD_REQUEST", { message: "Set job numbers on the Job numbers card." });
      }
      await db
        .insert(schema.settings)
        .values({ key: input.key, value: input.value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: input.value, updatedAt: new Date() },
        });
      return { ok: true };
    }),

  /* --------------------------- job numbers --------------------------- */
  /** Where numbering starts, the next number out, and the lowest start allowed (spec section 1). */
  jobNumbering: adminOnly.handler(() => jobNumbering()),

  setJobNumberStart: adminOnly
    .input(z.object({ start: z.number().int() }))
    .handler(async ({ input }) => {
      try {
        return await setJobNumberStart(input.start);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", { message: e instanceof Error ? e.message : String(e) });
      }
    }),

  /* ---------------------------- products ---------------------------- */
  products: adminOnly.handler(() =>
    db.select().from(schema.products).orderBy(asc(schema.products.brand), asc(schema.products.range)),
  ),

  productCreate: adminOnly
    .input(
      z.object({
        supplier: z.string().default(""),
        brand: z.string().default(""),
        range: z.string().default(""),
        colour: z.string().default(""),
        category: z.string().default("carpet"),
        unit: z.string().default("m2"),
        costPrice: z.number().nullable().optional(),
        sellPrice: z.number().nullable().optional(),
        sku: z.string().nullable().optional(),
        /** Picked from the supplier list. Wins over the free text name, which is copied from it. */
        supplierId: z.number().nullable().optional(),
        /** Box or Broadloom (item 9). Left out = worked out from category and unit. Null = neither. */
        soldAs: z.enum(SOLD_AS).nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      // variant_key is UNIQUE and defaults to "", so a second hand-made product
      // would collide with the first. Give each one its own key.
      const values = {
        ...input,
        soldAs: input.soldAs !== undefined ? input.soldAs : autoSoldAs(input),
        variantKey: `manual|${crypto.randomUUID()}`,
      };
      if (input.supplierId) {
        const [sup] = await db
          .select({ name: schema.suppliers.name })
          .from(schema.suppliers)
          .where(eq(schema.suppliers.id, input.supplierId));
        if (!sup) throw new ORPCError("NOT_FOUND", { message: "Supplier not found" });
        values.supplier = sup.name;
      }
      const [row] = await db.insert(schema.products).values(values).returning();
      return row;
    }),

  productUpdate: adminOnly
    .input(
      z.object({
        id: z.number(),
        supplier: z.string().optional(),
        brand: z.string().optional(),
        range: z.string().optional(),
        colour: z.string().optional(),
        category: z.string().optional(),
        unit: z.string().optional(),
        costPrice: z.number().nullable().optional(),
        sellPrice: z.number().nullable().optional(),
        sku: z.string().nullable().optional(),
        active: z.boolean().optional(),
        /** Box or Broadloom (item 9). Null = neither. */
        soldAs: z.enum(SOLD_AS).nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.products)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.products.id, id))
        .returning();
      return row;
    }),
};
