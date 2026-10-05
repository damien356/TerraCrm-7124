import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  MERGE_FIELDS,
  mergeFieldsFor,
  renderMarketingEmail,
  sendMarketing,
  unsubscribeUrl,
} from "../lib/marketing";
import { fillMergeFields } from "../lib/email";

/**
 * Email templates — the words Terra sends, editable by the office.
 *
 * Deliberately plain text with `{{merge_fields}}`, not a drag-and-drop builder.
 * A review request that reads like Damien typed it gets replies; a template
 * that looks like a newsletter goes to the promotions tab and gets ignored.
 *
 * Nothing here can reach a customer. Sending is the engine's job, through the
 * consent gate in lib/marketing. The one exception is `sendTest`, which is
 * pinned to the signed-in staff member's own address.
 */

/** A body with no unsubscribe path and no wrapper is a compliance problem. */
function wrapperWarning(useWrapper: boolean, body: string) {
  if (useWrapper) return null;
  if (/unsubscribe|\{\{\s*unsubscribe/i.test(body)) return null;
  return "Wrapper is off and the body has no unsubscribe line. Australian law requires one on marketing email.";
}

/** Merge fields the office typed that don't exist. Silent blanks otherwise. */
function unknownMergeFields(...parts: string[]) {
  const known = new Set<string>(MERGE_FIELDS.map((f) => f.key));
  const found = new Set<string>();
  for (const part of parts) {
    for (const m of part.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)) {
      const key = (m[1] ?? "").toLowerCase();
      if (!known.has(key)) found.add(key);
    }
  }
  return [...found];
}

const upsertInput = z.object({
  name: z.string().trim().min(1, "Give the template a name").max(120),
  subject: z.string().trim().max(200).default(""),
  body: z.string().max(20_000).default(""),
  useWrapper: z.boolean().default(true),
  active: z.boolean().default(true),
});

export const templates = {
  /** Every template, newest edit first. The list page. */
  list: staffOnly
    .input(
      z
        .object({ includeInactive: z.boolean().default(true) })
        .default({ includeInactive: true }),
    )
    .handler(async ({ input }) => {
      const rows = await db
        .select()
        .from(schema.emailTemplates)
        .where(input.includeInactive ? undefined : eq(schema.emailTemplates.active, true))
        .orderBy(desc(schema.emailTemplates.updatedAt));

      /* How many journey steps point at each one, so the office knows what is
       * in use before they edit the words going out tomorrow morning. */
      const usage = await db
        .select({
          templateId: schema.journeySteps.templateId,
          steps: sql<number>`count(*)`,
        })
        .from(schema.journeySteps)
        .groupBy(schema.journeySteps.templateId);

      const usedBy = new Map(usage.map((u) => [u.templateId, Number(u.steps)]));

      return rows.map((t) => ({ ...t, usedByStepCount: usedBy.get(t.id) ?? 0 }));
    }),

  /** One template plus the merge fields the editor shows beside it. */
  get: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db
      .select()
      .from(schema.emailTemplates)
      .where(eq(schema.emailTemplates.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Template not found" });

    const steps = await db
      .select({
        stepId: schema.journeySteps.id,
        label: schema.journeySteps.label,
        journeyId: schema.journeys.id,
        journeyName: schema.journeys.name,
        journeyStatus: schema.journeys.status,
      })
      .from(schema.journeySteps)
      .innerJoin(schema.journeys, eq(schema.journeys.id, schema.journeySteps.journeyId))
      .where(eq(schema.journeySteps.templateId, input.id))
      .orderBy(asc(schema.journeys.name));

    return { template: row, usedBy: steps, mergeFields: MERGE_FIELDS };
  }),

  /** The fields available, for a fresh editor with nothing loaded yet. */
  mergeFields: staffOnly.handler(async () => MERGE_FIELDS),

  create: staffOnly.input(upsertInput).handler(async ({ input }) => {
    const [row] = await db.insert(schema.emailTemplates).values(input).returning();
    return row!;
  }),

  update: staffOnly
    .input(upsertInput.partial().extend({ id: z.number().int() }))
    .handler(async ({ input }) => {
      const { id, ...patch } = input;

      const [existing] = await db
        .select()
        .from(schema.emailTemplates)
        .where(eq(schema.emailTemplates.id, id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Template not found" });

      const [row] = await db
        .update(schema.emailTemplates)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.emailTemplates.id, id))
        .returning();
      return row!;
    }),

  /**
   * Deactivates rather than deletes when a journey step still points at it.
   * Deleting would null the step's template and leave a live journey with a
   * step that sends nothing, silently.
   */
  remove: adminOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [inUse] = await db
      .select({ id: schema.journeySteps.id })
      .from(schema.journeySteps)
      .where(eq(schema.journeySteps.templateId, input.id))
      .limit(1);

    if (inUse) {
      await db
        .update(schema.emailTemplates)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(schema.emailTemplates.id, input.id));
      return { deleted: false, deactivated: true };
    }

    await db.delete(schema.emailTemplates).where(eq(schema.emailTemplates.id, input.id));
    return { deleted: true, deactivated: false };
  }),

  /**
   * Renders exactly what would go on the wire, through the same function the
   * real send uses. Against a real contact when one is named, otherwise against
   * the sample values, so the office can check it before anyone receives it.
   */
  preview: staffOnly
    .input(
      z.object({
        subject: z.string().default(""),
        body: z.string().default(""),
        useWrapper: z.boolean().default(true),
        /** Render against this contact's real details instead of samples. */
        contactId: z.number().int().optional(),
      }),
    )
    .handler(async ({ input }) => {
      let fields: Record<string, string>;
      let against = "sample values";

      if (input.contactId) {
        const [contact] = await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, input.contactId));
        if (!contact) throw new ORPCError("NOT_FOUND", { message: "Contact not found" });

        /* Their most recent completed job, because that is the one a review
         * request or an anniversary would actually be about. */
        const [job] = await db
          .select({ number: schema.jobs.number, title: schema.jobs.title })
          .from(schema.jobs)
          .where(and(eq(schema.jobs.contactId, contact.id), sql`${schema.jobs.completedAt} is not null`))
          .orderBy(desc(schema.jobs.completedAt))
          .limit(1);

        fields = mergeFieldsFor({
          contact,
          jobNumber: job?.number ?? null,
          product: job?.title ?? null,
        });
        against = `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "that contact";
      } else {
        fields = Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.sample]));
      }

      const subject = fillMergeFields(input.subject, fields);
      const bodyText = fillMergeFields(input.body, fields);

      /* A visible placeholder token: a preview must never mint a real
       * unsubscribe token, or the link in a screenshot would work forever. */
      const html = renderMarketingEmail(
        bodyText,
        unsubscribeUrl("preview-token"),
        input.useWrapper,
      );

      return {
        subject,
        bodyText,
        html,
        renderedAgainst: against,
        warnings: [
          wrapperWarning(input.useWrapper, input.body),
          unknownMergeFields(input.subject, input.body).length
            ? `Unknown merge fields will send blank: ${unknownMergeFields(input.subject, input.body)
                .map((f) => `{{${f}}}`)
                .join(", ")}`
            : null,
          input.subject.trim() ? null : "No subject line.",
          input.body.trim() ? null : "No body.",
        ].filter((w): w is string => w !== null),
      };
    }),

  /**
   * Sends the template to the signed-in staff member and nobody else.
   *
   * The address is taken from the session, never from the input, so this can
   * never be pointed at a customer. It runs as a test send, which bypasses the
   * consent gate — safe only because the recipient is Terra's own staff.
   */
  sendTest: staffOnly
    .input(
      z.object({
        subject: z.string().default(""),
        body: z.string().default(""),
        useWrapper: z.boolean().default(true),
      }),
    )
    .handler(async ({ input, context }) => {
      const to = context.actor.email?.trim();
      if (!to) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Your staff account has no email address, so there is nowhere to send the test.",
        });
      }

      /* A synthetic contact carrying the staff address. Never written to the
       * contacts table — a test must not create a marketable record. */
      const self = {
        id: -1,
        firstName: context.actor.name?.split(" ")[0] ?? "there",
        lastName: "",
        email: to,
        mobile: null,
        phone: null,
        suburb: null,
        marketingOptIn: true,
        doNotMarket: false,
        marketingBasis: "express",
      } as unknown as typeof schema.contacts.$inferSelect;

      const result = await sendMarketing({
        contact: self,
        channel: "email",
        subject: input.subject || "Test from Terra Ops",
        body: input.body,
        useWrapper: input.useWrapper,
        test: true,
        merge: {
          contact: self,
          jobNumber: "1042",
          product: "Terramater Oak",
        },
      });

      if (!result.ok) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: result.deferred
            ? `Test deferred: ${result.reason}`
            : `Test failed: ${result.reason}`,
        });
      }

      return { sentTo: to };
    }),
};
