import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { staffOnly } from "../middleware/auth";
import { DispatchError, jobDispatchLines, mergeDispatches, splitDispatch } from "../lib/dispatch-build";

/**
 * Split by trade and Merge on the job page (fix list item 13). A quote makes
 * one dispatch per job; the office splits it when two crews do the work
 * (Pedro on the uplift and prep, an installer on the floor) and can put it
 * back together. Only free dispatches move: nothing already with crew.
 */
async function guard<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof DispatchError) throw new ORPCError("BAD_REQUEST", { message: error.message });
    throw error;
  }
}

export const dispatches = {
  /** Each dispatch on the job with its work lines, and whether it can be split or merged. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => jobDispatchLines(input.jobId)),

  split: staffOnly
    .input(z.object({ taskId: z.number(), itemIds: z.array(z.number()).min(1), title: z.string().trim().max(200).nullable().default(null) }))
    .handler(({ input, context }) => guard(() => splitDispatch(input, context.actor))),

  merge: staffOnly
    .input(z.object({ intoId: z.number(), taskIds: z.array(z.number()).min(1) }))
    .handler(({ input, context }) => guard(() => mergeDispatches(input, context.actor))),
};
