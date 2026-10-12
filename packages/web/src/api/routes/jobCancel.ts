import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { cancelJob, cancelPreview } from "../lib/job-cancel";

/**
 * Cancel a job (Damien, 12 Oct). `preview` lists exactly what each button
 * does. `run` does it. Real cancel is open to staff. Clear everything is a
 * test job tool: Admin only, and the job number has to be typed (the lib checks both).
 */
export const jobCancel = {
  preview: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => cancelPreview(input.jobId, context.actor)),

  run: staffOnly
    .input(z.object({ jobId: z.number(), mode: z.enum(["real", "clear"]), confirmNumber: z.string().nullable().optional() }))
    .handler(async ({ input, context }) =>
      cancelJob({ jobId: input.jobId, mode: input.mode, confirmNumber: input.confirmNumber, actor: context.actor }),
    ),
};
