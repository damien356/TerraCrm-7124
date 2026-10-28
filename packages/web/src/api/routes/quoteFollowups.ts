import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  editStep,
  enrolQuote,
  followupSettings,
  followupView,
  followupsForJob,
  pauseByHand,
  resumeByHand,
  saveFollowupSettings,
  setStepDate,
  skipStep,
  stopByHand,
} from "../lib/quote-followup";
import { followupBacklog, followupMetrics } from "../lib/quote-followup-report";

/* ---------------------------------------------------------------------------
 * QUOTE FOLLOW-UPS (28 Oct). The card on the quote and the job, the backlog
 * report, the numbers and the Settings switch. Admin and Office; Settings is
 * Admin only. Kept apart from prep (routes/prep.ts) and care (routes/care.ts).
 * ------------------------------------------------------------------------- */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const step = z.union([z.literal(3), z.literal(7), z.literal(14), z.literal(25)]);

const fail = (e: unknown): never => {
  throw new ORPCError("BAD_REQUEST", { message: String((e as Error)?.message ?? e) });
};

async function viewOrThrow(quoteId: number) {
  const v = await followupView(quoteId);
  if (!v) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  return v;
}

async function quoteIdOfSeq(id: number) {
  const [seq] = await db.select({ quoteId: schema.quoteFollowups.quoteId }).from(schema.quoteFollowups).where(eq(schema.quoteFollowups.id, id));
  if (!seq?.quoteId) throw new ORPCError("NOT_FOUND", { message: "Follow-ups not found" });
  return seq.quoteId;
}

async function quoteIdOfStep(id: number) {
  const [row] = await db.select({ followupId: schema.quoteFollowupSteps.followupId }).from(schema.quoteFollowupSteps).where(eq(schema.quoteFollowupSteps.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Step not found" });
  return quoteIdOfSeq(row.followupId);
}

export const quoteFollowups = {
  /** The card: every step, its date and wording, why it is held, what went. */
  view: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => viewOrThrow(input.quoteId)),

  /** Every sequence on a job, for the job page and its Conversation tab. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => followupsForJob(input.jobId)),

  /** Start them on one quote, by hand. From the backlog, the steps already passed are skipped, never sent late. */
  enrol: staffOnly.input(z.object({ quoteId: z.number(), firstStep: step.optional() })).handler(async ({ input, context }) => {
    const r = await enrolQuote(input.quoteId, { byName: context.actor.name, how: "backlog", firstStep: input.firstStep });
    if (!r.ok) fail(r.reason);
    return viewOrThrow(input.quoteId);
  }),

  /** Pause. With a date: "contact me next month", nothing goes before it. */
  pause: staffOnly
    .input(z.object({ id: z.number(), until: isoDate.nullable().optional(), note: z.string().max(300).optional() }))
    .handler(async ({ input, context }) => {
      await pauseByHand(input.id, context.actor.name, input.until ?? null, input.note ?? "").catch(fail);
      return viewOrThrow(await quoteIdOfSeq(input.id));
    }),

  resume: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await resumeByHand(input.id, context.actor.name).catch(fail);
    return viewOrThrow(await quoteIdOfSeq(input.id));
  }),

  stop: staffOnly.input(z.object({ id: z.number(), reason: z.string().max(300).optional() })).handler(async ({ input, context }) => {
    await stopByHand(input.id, context.actor.name, input.reason ?? "").catch(fail);
    return viewOrThrow(await quoteIdOfSeq(input.id));
  }),

  skip: staffOnly.input(z.object({ stepId: z.number() })).handler(async ({ input, context }) => {
    await skipStep(input.stepId, context.actor.name).catch(fail);
    return viewOrThrow(await quoteIdOfStep(input.stepId));
  }),

  edit: staffOnly
    .input(z.object({ stepId: z.number(), subject: z.string().min(3).max(200), body: z.string().min(20).max(6000) }))
    .handler(async ({ input, context }) => {
      await editStep(input.stepId, context.actor.name, input.subject, input.body).catch(fail);
      return viewOrThrow(await quoteIdOfStep(input.stepId));
    }),

  /** A date the customer agreed. */
  setDate: staffOnly.input(z.object({ stepId: z.number(), date: isoDate })).handler(async ({ input, context }) => {
    await setStepDate(input.stepId, context.actor.name, input.date).catch(fail);
    return viewOrThrow(await quoteIdOfStep(input.stepId));
  }),

  /** Read only. Every quote out with a customer, and what could be done about it. */
  backlog: staffOnly.handler(() => followupBacklog()),

  metrics: staffOnly.handler(() => followupMetrics()),

  settings: staffOnly.handler(() => followupSettings()),

  saveSettings: adminOnly
    .input(
      z.object({
        on: z.boolean(),
        autoEnrol: z.boolean(),
        consent: z.enum(["marketing", "quote_request"]),
        showDays: z.enum(["none", "brisbane", "gold_coast", "both"]),
        sendHour: z.number().int().min(8).max(16),
      }),
    )
    .handler(async ({ input }) => {
      await saveFollowupSettings(input);
      return followupSettings();
    }),
};
