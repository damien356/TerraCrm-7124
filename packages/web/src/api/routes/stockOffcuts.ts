import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { autoApplyOffcuts, issueOffcut, offcutsForJob, recordUnderlayOffcut, undoOffcut, useOffcut } from "../lib/stock/offcuts";

/* ---------------------------------------------------------------------------
 * Underlay offcuts on the job page (Damien, 20 Nov 2026). Thin: the rules,
 * switches and permission ticks are all checked in lib/stock/offcuts.ts.
 * ------------------------------------------------------------------------- */

const key = z.string().trim().min(6).max(80);
const id = z.number().int();

export const stockOffcuts = {
  /** Per underlay material: offcuts held for it, ones it could use, and ones that came back from it. */
  forJob: staffOnly.input(z.object({ jobId: id })).handler(({ input }) => offcutsForJob(input.jobId)),
  /** The job page calls this when it opens, so materials added by hand get their offcuts too. */
  autoApply: staffOnly.input(z.object({ jobId: id })).handler(({ input }) => autoApplyOffcuts(input.jobId)),
  use: staffOnly.input(z.object({ jobMaterialId: id, itemId: id })).handler(({ input, context }) => useOffcut(input, context.actor)),
  undo: staffOnly.input(z.object({ holdId: id })).handler(({ input, context }) => undoOffcut(input.holdId, context.actor)),
  issue: staffOnly.input(z.object({ holdId: id })).handler(({ input, context }) => issueOffcut(input.holdId, context.actor)),
  record: staffOnly
    .input(
      z.object({
        jobMaterialId: id,
        metres: z.number().positive().max(500),
        widthM: z.number().positive().max(10).nullish(),
        locationId: id.nullish(),
        note: z.string().trim().max(300).optional(),
        requestKey: key,
      }),
    )
    .handler(({ input, context }) => recordUnderlayOffcut(input, context.actor)),
};
