import { z } from "zod";
import { adminOnly } from "../middleware/auth";
import { mergeJobs, mergePreview } from "../lib/job-merge";

/**
 * Merge a job into another (notes 18.48). Admin only. `preview` lists exactly
 * what moves and why a merge is blocked. `run` does it, in one batch.
 */
export const jobMerge = {
  preview: adminOnly
    .input(z.object({ fromJobId: z.number(), intoJobId: z.number() }))
    .handler(async ({ input }) => mergePreview(input.fromJobId, input.intoJobId)),

  run: adminOnly
    .input(z.object({ fromJobId: z.number(), intoJobId: z.number() }))
    .handler(async ({ input, context }) => mergeJobs({ fromJobId: input.fromJobId, intoJobId: input.intoJobId, actor: context.actor })),
};
