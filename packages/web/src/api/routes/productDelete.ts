import { z } from "zod";
import { adminOnly } from "../middleware/auth";
import { applyDelete, deleteLog, deleteRows, MAX_DELETE, previewDelete, undoLastDelete } from "../lib/product-delete";

/**
 * 15 Oct. Settings, Price list: the bin on a row, Delete selected, Undo last
 * delete and the delete log. Admin only: Office and Crew never see the
 * buttons and are refused here.
 */

const ids = z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_DELETE * 4) });

export const productDelete = {
  /** How many go, how many are hidden instead because they are used, and why. Writes nothing. */
  preview: adminOnly.input(ids).handler(({ input }) => previewDelete(input.ids)),

  /** Checks again and deletes the unused ones. The used ones get Active unticked. */
  apply: adminOnly.input(ids).handler(({ input, context }) => applyDelete(input.ids, context.actor)),

  undoLast: adminOnly.handler(({ context }) => undoLastDelete(context.actor)),

  log: adminOnly.handler(() => deleteLog()),

  rows: adminOnly.input(z.object({ deleteId: z.number().int() })).handler(({ input }) => deleteRows(input.deleteId)),
};
