import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  jobPlan,
  jobsToFill,
  onMyWay,
  planForOffice,
  prepSettings,
  retryFailed,
  savePrepSettings,
  stopPrep,
  tickAptCheck,
  unstopPrep,
} from "../lib/prep";
import { PREP_DEFAULTS } from "../lib/prep-templates";

/* ---------------------------------------------------------------------------
 * CLIENT PREP (notes 18.56). The job's prep panel, Stop, Retry, On my way for
 * the office, the apartment checklist, the Settings tab and the To fill page.
 * Admin and Office. Only Settings is Admin.
 * ------------------------------------------------------------------------- */

const kind = z.enum(["install_email", "day_sms", "omw_sms"]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:00");

const templatesInput = z.object(
  Object.fromEntries(Object.keys(PREP_DEFAULTS).map((k) => [k, z.string().max(4000)])) as Record<keyof typeof PREP_DEFAULTS, z.ZodString>,
);

async function plan(jobId: number) {
  const p = await jobPlan(jobId);
  if (!p) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  return planForOffice(p);
}

export const prep = {
  /** What goes, to whom, when, what it says, and what has gone. */
  plan: staffOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => plan(input.jobId)),

  /** Stop one message. It stays stopped until put back on. */
  stop: staffOnly
    .input(z.object({ jobId: z.number(), kind, forDate: isoDate }))
    .handler(async ({ input, context }) => {
      await stopPrep(input.jobId, input.kind, input.forDate, context.actor.name || "Office");
      return plan(input.jobId);
    }),

  unstop: staffOnly
    .input(z.object({ jobId: z.number(), kind, forDate: isoDate }))
    .handler(async ({ input, context }) => {
      await unstopPrep(input.jobId, input.kind, input.forDate, context.actor.name || "Office");
      return plan(input.jobId);
    }),

  /** Send a failed one again now. */
  retry: staffOnly
    .input(z.object({ jobId: z.number(), kind, forDate: isoDate }))
    .handler(async ({ input, context }) => {
      const r = await retryFailed(input.jobId, input.kind, input.forDate, context.actor.name || "Office");
      return { ...r, plan: await plan(input.jobId) };
    }),

  /** The office taps On my way for the installer. Texts the client once a day. */
  onMyWay: staffOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const r = await onMyWay(input.taskId, { name: context.actor.name || "Office", installerId: null });
    if (!r.ok) throw new ORPCError("BAD_REQUEST", { message: r.reason ?? "Not sent." });
    return r;
  }),

  /** On, off, or back to the rule (builder jobs off, the rest on). */
  setPrepOn: staffOnly
    .input(z.object({ jobId: z.number(), on: z.boolean().nullable() }))
    .handler(async ({ input, context }) => {
      await db.update(schema.jobs).set({ prepOn: input.on, updatedAt: new Date() }).where(eq(schema.jobs.id, input.jobId));
      await db.insert(schema.activityLog).values({
        jobId: input.jobId,
        entityType: "job",
        entityId: input.jobId,
        action: "prep_switch",
        detail: input.on == null ? "Client prep messages back to the default" : `Client prep messages switched ${input.on ? "on" : "off"}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return plan(input.jobId);
    }),

  tickApt: staffOnly
    .input(z.object({ jobId: z.number(), key: z.enum(["fire", "lift", "parking"]), done: z.boolean() }))
    .handler(({ input, context }) => tickAptCheck(input.jobId, input.key, input.done, context.actor.name || "Office", context.actor.role)),

  settingsGet: staffOnly.handler(() => prepSettings()),

  settingsSave: adminOnly
    .input(
      z
        .object({
          on: z.boolean(),
          windowStart: hhmm,
          windowEnd: hhmm,
          sendHour: z.number().int().min(6).max(18),
          templates: templatesInput,
        })
        .refine((v) => v.windowStart < v.windowEnd, { message: "The window has to end after it starts.", path: ["windowEnd"] }),
    )
    .handler(async ({ input }) => {
      await savePrepSettings(input);
      return prepSettings();
    }),

  /** Open jobs with an install booked that still need the property type or furniture answer. */
  toFill: staffOnly.handler(() => jobsToFill()),
};
