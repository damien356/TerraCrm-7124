import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { installerOnly, staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import {
  agreeBlocks,
  agreePlan,
  approveStagePay,
  buildPlan,
  cancelPlan,
  completeStage,
  CONFIRM_HOWS,
  CUSTOMER_WORDING,
  loadJobContext,
  PLAN_KIND_LABEL,
  PLAN_KINDS,
  planAsInput,
  planOrThrow,
  proposePlan,
  reassignRemaining,
  recordConfirmation,
  savePlan,
  STAGE_REASON_LABEL,
  STAGE_REASONS,
  VARIATION_TIMING_LABEL,
  VARIATION_TIMINGS,
  type PlanIn,
} from "../lib/staged-jobs";
import { crewStageView, previewTable, raiseStageInvoice, reconcile, stageBillingOf } from "../lib/staged-billing";
import { shapeInvoice } from "../lib/client-invoices";

/* ---------------------------------------------------------------------------
 * STAGED JOBS AND PROGRESS PAYMENTS (Damien, 12 Nov 2026).
 * The job page's Stages card ("Split into stages / Record partial
 * completion") and the crew's view of a staged task. lib/staged-jobs.ts
 * and lib/staged-billing.ts hold the rules.
 * ------------------------------------------------------------------------- */

const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after staging change failed:", e));

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a day like 2026-12-15");
const money = z.number().finite();

const planInput = z.object({
  jobId: z.number(),
  kind: z.enum(PLAN_KINDS),
  reason: z.enum(STAGE_REASONS),
  reasonNote: z.string().max(1000).default(""),
  requestedBy: z.string().max(200).default(""),
  requestedOn: day.nullable().default(null),
  arrangement: z.string().max(2000).default(""),
  followUpDate: day.nullable().default(null),
  variationTiming: z.enum(VARIATION_TIMINGS).default("final"),
  materialsLocation: z.string().max(1000).default(""),
  split: z.object({ materialsInc: money, labourInc: money, note: z.string().max(1000).default("") }).nullable().default(null),
  approveSplit: z.boolean().default(false),
  stages: z
    .array(
      z.object({
        name: z.string().max(120).default(""),
        scope: z.string().max(2000).default(""),
        plannedDate: day.nullable().default(null),
        awaitingReadiness: z.boolean().default(false),
        lines: z.array(z.object({ quoteItemId: z.number(), qty: z.number().finite(), amountInc: money.nullish() })).max(200),
        pay: z
          .array(z.object({ taskId: z.number(), lineKey: z.string().max(40), qty: z.number().finite(), amount: money.nullish(), estimatedHours: z.number().finite().nullish() }))
          .max(400),
      }),
    )
    .min(1)
    .max(20),
});

const actorOf = (context: { actor: { name: string; role: string } }) => ({ name: context.actor.name, role: context.actor.role });

/** Everything the Stages card shows. */
async function cardFor(jobId: number, draft?: PlanIn) {
  const ctx = await loadJobContext(jobId);
  const input = draft ?? (ctx.plan ? planAsInput(ctx) : null);
  const built = input ? buildPlan(ctx, input) : null;
  const bill = await stageBillingOf(ctx);
  const materials = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId));
  const blocked = ctx.job.parentJobId
    ? "This is a callback job. A return visit to finish agreed work belongs on the original job."
    : !ctx.quote
      ? "There is no accepted quote on this job, so there are no agreed selling values to stage."
      : null;
  return {
    jobId,
    blocked,
    labels: {
      kinds: PLAN_KIND_LABEL,
      reasons: STAGE_REASON_LABEL,
      variationTimings: VARIATION_TIMING_LABEL,
      confirmHows: CONFIRM_HOWS,
    },
    wording: CUSTOMER_WORDING,
    quote: ctx.quote ? { id: ctx.quote.id, ref: ctx.quoteRef, total: ctx.quote.total } : null,
    split: ctx.split,
    variations: ctx.variations,
    tasks: ctx.taskPay,
    quoteLabour: ctx.split?.labourLines ?? [],
    plan: ctx.plan
      ? {
          ...ctx.plan,
          agreeBlocks: ctx.plan.status === "draft" ? agreeBlocks(ctx.plan, ctx.split) : [],
        }
      : null,
    input,
    built,
    preview: built ? previewTable(built) : null,
    stages: ctx.stages.map((s) => ({
      ...s,
      lines: ctx.lines.filter((l) => l.stageId === s.id),
      pay: ctx.pay
        .filter((p) => p.stageId === s.id)
        .map((p) => ({ ...p, installerName: p.installerId != null ? (ctx.instById.get(p.installerId)?.name ?? null) : null })),
    })),
    billing: bill,
    reconciliation: ctx.plan ? reconcile(ctx, bill) : null,
    materials: materials.map((m) => ({ id: m.id, description: m.description, qty: m.qty, unit: m.unit, status: m.status })),
  };
}

export const stages = {
  /** The Stages card. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => cardFor(input.jobId)),

  /** A first setup for the dialog when there is no plan yet. Every quantity starts in the last stage. */
  propose: staffOnly.input(z.object({ jobId: z.number(), kind: z.enum(PLAN_KINDS) })).handler(async ({ input }) => {
    const ctx = await loadJobContext(input.jobId);
    return proposePlan(ctx, input.kind);
  }),

  /** The preview table and every check for a setup being typed. Writes nothing. */
  preview: staffOnly.input(planInput).handler(async ({ input }) => cardFor(input.jobId, input)),

  /** Save the setup as a draft, or update it. Finished stages are never touched. */
  save: staffOnly.input(planInput).handler(async ({ input, context }) => {
    const planId = await savePlan(input, actorOf(context));
    await rebuild();
    return { planId };
  }),

  /** The customer's written confirmation of the arrangement. */
  confirm: staffOnly
    .input(z.object({ planId: z.number(), name: z.string().trim().min(1).max(200), on: day, how: z.enum(CONFIRM_HOWS), text: z.string().max(5000).default("") }))
    .handler(async ({ input, context }) => {
      await recordConfirmation({ ...input, actor: actorOf(context) });
      return { ok: true };
    }),

  /** Draft to agreed. Needs the requester, the written confirmation and an approved split. */
  agree: staffOnly.input(z.object({ planId: z.number() })).handler(async ({ input, context }) => {
    const plan = await agreePlan(input.planId, actorOf(context));
    await rebuild();
    return { status: plan.status };
  }),

  cancel: staffOnly.input(z.object({ planId: z.number(), reason: z.string().trim().min(1).max(500) })).handler(async ({ input, context }) => {
    await cancelPlan(input.planId, input.reason, actorOf(context));
    await rebuild();
    return { ok: true };
  }),

  /** Record a stage as finished, with the quantities actually done. What was not done moves to the next stage. */
  completeStage: staffOnly
    .input(
      z.object({
        stageId: z.number(),
        completedOn: day,
        lines: z.array(z.object({ quoteItemId: z.number(), qty: z.number().finite().min(0), amountInc: money.nullish() })).max(200).optional(),
        pay: z.array(z.object({ taskId: z.number(), lineKey: z.string().max(40), qty: z.number().finite().min(0), amount: money.nullish() })).max(400).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const out = await completeStage({ ...input, actor: actorOf(context) });
      await rebuild();
      return out;
    }),

  /** Approve the installer pay for a finished stage, so he can claim it. */
  approvePay: staffOnly.input(z.object({ stageId: z.number() })).handler(async ({ input, context }) => approveStagePay({ stageId: input.stageId, actor: actorOf(context) })),

  /**
   * Raise the next progress invoice (or the Final after the last stage) for
   * the figures on the card. `expectedSeq` is the plan's invoiceSeq the card
   * showed, so a double click raises one invoice. Email and Xero stay on the
   * Client invoices card.
   */
  raiseInvoice: staffOnly.input(z.object({ planId: z.number(), expectedSeq: z.number().int().min(0) })).handler(async ({ input, context }) => {
    const out = await raiseStageInvoice({ planId: input.planId, expectedSeq: input.expectedSeq, actor: actorOf(context) });
    await rebuild();
    return { invoice: shapeInvoice(out.invoice), already: out.already };
  }),

  /** Hand the remaining work on a task to another installer. Same rates unless the office decides otherwise. */
  reassign: staffOnly
    .input(
      z.object({
        planId: z.number(),
        taskId: z.number(),
        toInstallerId: z.number(),
        rates: z.array(z.object({ lineKey: z.string().max(40), rate: z.number().finite().min(0) })).max(50).nullable().default(null),
        note: z.string().max(500).default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      await planOrThrow(input.planId);
      const out = await reassignRemaining({ ...input, actor: actorOf(context) });
      await rebuild();
      return out;
    }),

  /** Terra Crew: his stages on this task. Pay only, never a selling price. */
  crew: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    // Null when the task is not staged, or not his.
    return crewStageView(input.taskId, context.installerId);
  }),
};
