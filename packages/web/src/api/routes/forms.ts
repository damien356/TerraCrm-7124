import { z } from "zod";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { signGet } from "../lib/s3";

/**
 * THE FORMS ENGINE.
 *
 * Templates are editable data in Settings — never a hardcoded list of questions.
 * The crew fill them in on site from the task screen; anything flagged
 * `needsOfficeReview` lands in the office as a pending item.
 *
 * The rule that matters: a variation is DESCRIBED by the crew and PRICED BY THE
 * OFFICE. There is no price field on a crew form and there never will be —
 * every dollar figure is added here, on the admin side.
 */

export const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "checkbox",
  "photo",
  "signature",
  "date",
] as const;

export const FORM_KINDS = [
  "variation",
  "prestart",
  "defect",
  "moisture",
  "swms",
  "toolbox",
  "vehicle",
  "custom",
] as const;

export const SUBMISSION_STATUSES = ["pending", "priced", "approved", "rejected", "closed"] as const;

export const FORM_KIND_LABELS: Record<(typeof FORM_KINDS)[number], string> = {
  variation: "Variation",
  prestart: "Pre-start site check",
  defect: "Defect report",
  moisture: "Moisture / subfloor report",
  swms: "SWMS",
  toolbox: "Toolbox talk",
  vehicle: "Vehicle check",
  custom: "Custom",
};

const fieldTypeEnum = z.enum(FIELD_TYPES);
const kindEnum = z.enum(FORM_KINDS);
const statusEnum = z.enum(SUBMISSION_STATUSES);

/** The seed Variation form. Describes the change — never prices it. */
const VARIATION_FIELDS: Array<{
  label: string;
  type: (typeof FIELD_TYPES)[number];
  required: boolean;
  helpText?: string;
  options?: string[];
  unit?: string;
  mediaBucket?: string;
}> = [
  {
    label: "What changed?",
    type: "select",
    required: true,
    helpText: "Pick the closest one, then explain below.",
    options: [
      "Extra area not in the scope",
      "Subfloor worse than expected",
      "Extra prep needed",
      "Different product required",
      "Furniture / removal not quoted",
      "Access problem",
      "Existing damage found",
      "Other",
    ],
  },
  {
    label: "Describe it in your own words",
    type: "textarea",
    required: true,
    helpText: "What you found, and what needs to happen. Don't worry about pricing it.",
  },
  {
    label: "Extra area",
    type: "number",
    required: false,
    unit: "m2",
    helpText: "Leave blank if it isn't an area change.",
  },
  {
    label: "Extra linear metres",
    type: "number",
    required: false,
    unit: "LM",
    helpText: "Leave blank if it doesn't apply.",
  },
  {
    label: "Extra hours you reckon it adds",
    type: "number",
    required: false,
    unit: "hours",
  },
  {
    label: "Photos of it",
    type: "photo",
    required: true,
    mediaBucket: "found",
    helpText: "At least one. These go into 'What we found' on the job file.",
  },
  {
    label: "Can you keep working in the meantime?",
    type: "select",
    required: true,
    options: ["Yes, carrying on", "No, I'm stopped until this is sorted"],
  },
  {
    label: "Did you talk to the customer about it?",
    type: "select",
    required: true,
    helpText: "Never quote them a price — just tell them the office will be in touch.",
    options: ["No", "Yes, told them the office will call", "Customer raised it with me"],
  },
];

async function templateWithFields(id: number) {
  const [template] = await db.select().from(schema.formTemplates).where(eq(schema.formTemplates.id, id));
  if (!template) return null;
  const fields = await db
    .select()
    .from(schema.formFields)
    .where(eq(schema.formFields.templateId, id))
    .orderBy(asc(schema.formFields.sortOrder), asc(schema.formFields.id));
  return { ...template, fields };
}

export const forms = {
  /* ---------------------------------------------------------------- templates */

  templates: adminOnly.handler(async () => {
    const rows = await db
      .select()
      .from(schema.formTemplates)
      .orderBy(asc(schema.formTemplates.sortOrder), asc(schema.formTemplates.id));

    const counts = await db
      .select({ templateId: schema.formFields.templateId, n: sql<number>`count(*)` })
      .from(schema.formFields)
      .groupBy(schema.formFields.templateId);

    const subs = await db
      .select({ templateId: schema.formSubmissions.templateId, n: sql<number>`count(*)` })
      .from(schema.formSubmissions)
      .groupBy(schema.formSubmissions.templateId);

    return rows.map((r) => ({
      ...r,
      kindLabel: FORM_KIND_LABELS[r.kind as (typeof FORM_KINDS)[number]] ?? r.kind,
      fieldCount: Number(counts.find((c) => c.templateId === r.id)?.n ?? 0),
      submissionCount: Number(subs.find((c) => c.templateId === r.id)?.n ?? 0),
    }));
  }),

  template: adminOnly.input(z.object({ id: z.number() })).handler(({ input }) => templateWithFields(input.id)),

  createTemplate: adminOnly
    .input(
      z.object({
        name: z.string().min(1, "Give the form a name."),
        kind: kindEnum.default("custom"),
        description: z.string().default(""),
        needsOfficeReview: z.boolean().default(true),
        active: z.boolean().default(true),
      }),
    )
    .handler(async ({ input }) => {
      const existing = await db.select({ id: schema.formTemplates.id }).from(schema.formTemplates);
      const [row] = await db
        .insert(schema.formTemplates)
        .values({ ...input, sortOrder: existing.length })
        .returning();
      return row;
    }),

  updateTemplate: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        kind: kindEnum.optional(),
        description: z.string().optional(),
        needsOfficeReview: z.boolean().optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.formTemplates)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.formTemplates.id, id))
        .returning();
      return row;
    }),

  /**
   * A template that has been filled in is never destroyed — history would go
   * with it. It gets switched off instead.
   */
  removeTemplate: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [used] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.formSubmissions)
      .where(eq(schema.formSubmissions.templateId, input.id));

    if (Number(used?.n ?? 0) > 0) {
      await db
        .update(schema.formTemplates)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(schema.formTemplates.id, input.id));
      return { ok: true, deactivated: true };
    }

    await db.delete(schema.formTemplates).where(eq(schema.formTemplates.id, input.id));
    return { ok: true, deactivated: false };
  }),

  /* ------------------------------------------------------------------- fields */

  addField: adminOnly
    .input(
      z.object({
        templateId: z.number(),
        label: z.string().min(1, "Give the question a label."),
        type: fieldTypeEnum.default("text"),
        required: z.boolean().default(false),
        helpText: z.string().default(""),
        options: z.array(z.string()).default([]),
        mediaBucket: z.string().nullable().default(null),
        unit: z.string().default(""),
      }),
    )
    .handler(async ({ input }) => {
      const existing = await db
        .select({ id: schema.formFields.id })
        .from(schema.formFields)
        .where(eq(schema.formFields.templateId, input.templateId));

      const [row] = await db
        .insert(schema.formFields)
        .values({
          templateId: input.templateId,
          label: input.label,
          type: input.type,
          required: input.required,
          helpText: input.helpText,
          options: JSON.stringify(input.options),
          mediaBucket: input.type === "photo" ? (input.mediaBucket ?? "found") : null,
          unit: input.unit,
          sortOrder: existing.length,
        })
        .returning();
      return row;
    }),

  updateField: adminOnly
    .input(
      z.object({
        id: z.number(),
        label: z.string().min(1).optional(),
        type: fieldTypeEnum.optional(),
        required: z.boolean().optional(),
        helpText: z.string().optional(),
        options: z.array(z.string()).optional(),
        mediaBucket: z.string().nullable().optional(),
        unit: z.string().optional(),
        sortOrder: z.number().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, options, ...rest } = input;
      const [row] = await db
        .update(schema.formFields)
        .set({
          ...rest,
          ...(options ? { options: JSON.stringify(options) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.formFields.id, id))
        .returning();
      return row;
    }),

  removeField: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.formFields).where(eq(schema.formFields.id, input.id));
    return { ok: true };
  }),

  reorderFields: adminOnly
    .input(z.object({ templateId: z.number(), orderedIds: z.array(z.number()) }))
    .handler(async ({ input }) => {
      for (const [i, id] of input.orderedIds.entries()) {
        await db
          .update(schema.formFields)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(and(eq(schema.formFields.id, id), eq(schema.formFields.templateId, input.templateId)));
      }
      return { ok: true };
    }),

  /* -------------------------------------------------------------- submissions */

  submissions: adminOnly
    .input(
      z
        .object({
          status: statusEnum.nullable().default(null),
          jobId: z.number().nullable().default(null),
          kind: kindEnum.nullable().default(null),
        })
        .default({ status: null, jobId: null, kind: null }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (input.status) where.push(eq(schema.formSubmissions.status, input.status));
      if (input.jobId) where.push(eq(schema.formSubmissions.jobId, input.jobId));
      if (input.kind) where.push(eq(schema.formSubmissions.templateKind, input.kind));

      return db
        .select({
          id: schema.formSubmissions.id,
          templateName: schema.formSubmissions.templateName,
          templateKind: schema.formSubmissions.templateKind,
          jobId: schema.formSubmissions.jobId,
          taskId: schema.formSubmissions.taskId,
          status: schema.formSubmissions.status,
          submittedByName: schema.formSubmissions.submittedByName,
          submittedAt: schema.formSubmissions.submittedAt,
          reviewNote: schema.formSubmissions.reviewNote,
          reviewedAt: schema.formSubmissions.reviewedAt,
          jobRef: schema.jobs.number,
          jobTitle: schema.jobs.title,
          installerName: schema.installers.name,
        })
        .from(schema.formSubmissions)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.formSubmissions.jobId))
        .leftJoin(schema.installers, eq(schema.installers.id, schema.formSubmissions.installerId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.formSubmissions.submittedAt));
    }),

  /** One submission, answers in order, photo links signed for reading. */
  submission: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [sub] = await db
      .select({
        id: schema.formSubmissions.id,
        templateId: schema.formSubmissions.templateId,
        templateName: schema.formSubmissions.templateName,
        templateKind: schema.formSubmissions.templateKind,
        jobId: schema.formSubmissions.jobId,
        taskId: schema.formSubmissions.taskId,
        installerId: schema.formSubmissions.installerId,
        submittedByName: schema.formSubmissions.submittedByName,
        submittedAt: schema.formSubmissions.submittedAt,
        status: schema.formSubmissions.status,
        reviewNote: schema.formSubmissions.reviewNote,
        reviewedAt: schema.formSubmissions.reviewedAt,
        jobRef: schema.jobs.number,
        jobTitle: schema.jobs.title,
        installerName: schema.installers.name,
      })
      .from(schema.formSubmissions)
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.formSubmissions.jobId))
      .leftJoin(schema.installers, eq(schema.installers.id, schema.formSubmissions.installerId))
      .where(eq(schema.formSubmissions.id, input.id));

    if (!sub) return null;

    const answers = await db
      .select()
      .from(schema.formAnswers)
      .where(eq(schema.formAnswers.submissionId, input.id))
      .orderBy(asc(schema.formAnswers.sortOrder), asc(schema.formAnswers.id));

    const mediaIds = answers.map((a) => a.mediaId).filter((v): v is number => typeof v === "number");

    const mediaRows = mediaIds.length
      ? await db.select().from(schema.jobMedia).where(inArray(schema.jobMedia.id, mediaIds))
      : [];

    const signed = await Promise.all(
      mediaRows.map(async (m) => ({
        id: m.id,
        bucket: m.bucket,
        kind: m.kind,
        caption: m.caption,
        url: await signGet(m.storageKey),
      })),
    );

    return {
      ...sub,
      answers: answers.map((a) => ({
        ...a,
        media: a.mediaId ? (signed.find((s) => s.id === a.mediaId) ?? null) : null,
      })),
    };
  }),

  /**
   * The office decision. Pricing a variation happens on the quote — this only
   * records where the submission got to and why, and writes it to the job
   * timeline so there's a record of who decided what.
   */
  review: adminOnly
    .input(
      z.object({
        id: z.number(),
        status: statusEnum,
        reviewNote: z.string().default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const [profile] = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, context.actor.userId));

      const [row] = await db
        .update(schema.formSubmissions)
        .set({
          status: input.status,
          reviewNote: input.reviewNote,
          reviewedByProfileId: profile?.id ?? null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.formSubmissions.id, input.id))
        .returning();

      if (row?.jobId) {
        await db.insert(schema.activityLog).values({
          jobId: row.jobId,
          taskId: row.taskId,
          entityType: "form_submission",
          entityId: row.id,
          action: `${row.templateName} ${input.status}`,
          detail: input.reviewNote,
          actorName: context.actor.name || "Office",
          actorRole: "admin",
        });
      }

      return row;
    }),

  /**
   * Creates the Variation form with its questions, once. Safe to run again —
   * if a variation template already exists it is left exactly as it is so an
   * edited form is never clobbered.
   */
  seedVariation: adminOnly.handler(async () => {
    const [existing] = await db
      .select()
      .from(schema.formTemplates)
      .where(eq(schema.formTemplates.kind, "variation"));

    if (existing) return { created: false, templateId: existing.id };

    const count = await db.select({ id: schema.formTemplates.id }).from(schema.formTemplates);

    const [template] = await db
      .insert(schema.formTemplates)
      .values({
        name: "Variation",
        kind: "variation",
        description:
          "Raised on site when the job changes. The crew describe what changed and photograph it; the office prices it.",
        needsOfficeReview: true,
        active: true,
        sortOrder: count.length,
      })
      .returning();

    if (!template) return { created: false, templateId: null };

    await db.insert(schema.formFields).values(
      VARIATION_FIELDS.map((f, i) => ({
        templateId: template.id,
        label: f.label,
        type: f.type,
        required: f.required,
        helpText: f.helpText ?? "",
        options: JSON.stringify(f.options ?? []),
        mediaBucket: f.type === "photo" ? (f.mediaBucket ?? "found") : null,
        unit: f.unit ?? "",
        sortOrder: i,
      })),
    );

    return { created: true, templateId: template.id };
  }),
};
