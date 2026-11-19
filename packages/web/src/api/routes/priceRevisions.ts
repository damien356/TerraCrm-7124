import { z } from "zod";
import { adminOnly, staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { BUILDER_POSITIONS, confirmRevision, recordRevision, revisionDraft, revisionView, withdrawRevision } from "../lib/price-revision";

/* ---------------------------------------------------------------------------
 * The job page's Agreed price card (Damien, 18 Nov 2026, job 188070).
 * Anyone in the office reads it. Only an Admin records, confirms or withdraws
 * an agreed whole-job price revision (lib/price-revision.ts).
 * ------------------------------------------------------------------------- */

const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after price revision failed:", e));

export const priceRevisions = {
  /** The active revision, earlier ones, the job's balance and what a new one would start from. */
  forJob: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input }) => {
    const [view, draft] = await Promise.all([revisionView(input.jobId), revisionDraft(input.jobId)]);
    return { ...view, draft };
  }),

  record: adminOnly
    .input(
      z.object({
        jobId: z.number().int(),
        /** The agreed figure, ex GST. GST goes on at 10%. */
        toSubtotal: z.number().positive().max(10_000_000),
        reason: z.string().trim().min(3).max(300),
        builderPosition: z.enum(BUILDER_POSITIONS),
        builderNote: z.string().trim().max(1000).nullish(),
        invoiceWording: z.string().trim().min(3).max(4000),
        includedVariationIds: z.array(z.number().int()).max(100).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const rev = await recordRevision({ ...input, actor: { name: context.actor.name, role: context.actor.role } });
      await rebuild();
      return { id: rev.id };
    }),

  confirm: adminOnly
    .input(z.object({ id: z.number().int(), note: z.string().trim().max(500).nullish() }))
    .handler(async ({ input, context }) => {
      const rev = await confirmRevision({ id: input.id, note: input.note ?? null, actor: { name: context.actor.name, role: context.actor.role } });
      return { id: rev.id, builderPosition: rev.builderPosition };
    }),

  withdraw: adminOnly
    .input(z.object({ id: z.number().int(), reason: z.string().trim().min(3).max(300) }))
    .handler(async ({ input, context }) => {
      const r = await withdrawRevision({ id: input.id, reason: input.reason, actor: { name: context.actor.name, role: context.actor.role } });
      await rebuild();
      return r;
    }),
};
