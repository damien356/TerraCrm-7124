import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { assignAnywayInput } from "../lib/assign-check";
import { assignBoardLines, boardPeople, installerBoard as boardFor, restoreQuoteLabour } from "../lib/installer-board";

/*
 * Installers & bookings on the job page (Damien, 11 Nov 2026, job 188070).
 * The office ticks labour lines and gives them to people; the dispatch
 * records underneath are split and merged for them. Nothing here sends an
 * offer, a text or an email, and nothing needs a date. Book and Send offer
 * stay on their own routes (tasks, offers), each acting on one person's visit.
 */
const lineIds = z.array(z.number().int()).min(1).max(200);

export const installerBoard = {
  /** The job's labour lines, one card per person, the counts, and quote labour on no dispatch. */
  board: staffOnly.input(z.object({ jobId: z.number().int() })).handler(({ input, context }) => boardFor(input.jobId, context.actor)),

  /** Everyone current, judged on the ticked lines only: suitable first, warnings for the rest. Writes nothing. */
  people: staffOnly
    .input(z.object({ jobId: z.number().int(), lineIds }))
    .handler(({ input, context }) => boardPeople(input.jobId, input.lineIds, context.actor)),

  /** Gives the ticked lines to one person as a draft (or back to unassigned). No date, no offer, no message. */
  assign: staffOnly
    .input(
      z.object({
        jobId: z.number().int(),
        lineIds,
        installerId: z.number().int().nullable(),
        assignAnyway: assignAnywayInput,
        replaceInstaller: z.boolean().optional(),
      }),
    )
    .handler(({ input, context }) => assignBoardLines(input, context.actor)),

  /** Labour on the accepted quote that is on no dispatch goes back on the job at the quote's quantities. */
  restoreLabour: staffOnly.input(z.object({ jobId: z.number().int() })).handler(({ input, context }) => restoreQuoteLabour(input.jobId, context.actor)),
};
