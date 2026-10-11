import { z } from "zod";
import { adminOnly } from "../middleware/auth";
import {
  applyImport,
  exportPriceList,
  importLog,
  importRows,
  previewImport,
  templateCsv,
  undoLastImport,
} from "../lib/price-import";

/**
 * Fix list 11 Oct, items 4 and 5: Settings, Price list. Download template,
 * Export, Import (preview then confirm) and Undo last import. Admin only:
 * Office never sees the buttons and Crew never reach any of it.
 */

/** About 4,000 products is under 2 MB as CSV. 12 MB leaves room for a fat Excel file. */
const sheetFile = z
  .object({
    fileName: z.string().max(200).default("price-list.csv"),
    csv: z.string().max(12_000_000).optional(),
    xlsxBase64: z.string().max(16_000_000).optional(),
  })
  .refine((f) => f.csv !== undefined || f.xlsxBase64 !== undefined, { message: "No file" });

export const priceImport = {
  template: adminOnly.handler(() => templateCsv()),

  export: adminOnly
    .input(
      z.object({
        search: z.string().default(""),
        includeDiscontinued: z.boolean().default(false),
        format: z.enum(["csv", "xlsx"]).default("csv"),
      }),
    )
    .handler(({ input }) => exportPriceList(input)),

  /** Reads the file and says what it would do. Writes nothing. */
  preview: adminOnly.input(sheetFile).handler(({ input }) => previewImport(input)),

  /** Re-reads the file, re-plans, and writes only if the plan is the one previewed. */
  confirm: adminOnly
    .input(z.object({ file: sheetFile, hash: z.string().min(1) }))
    .handler(({ input, context }) => applyImport(input.file, input.hash, context.actor)),

  undoLast: adminOnly.handler(({ context }) => undoLastImport(context.actor)),

  log: adminOnly.handler(() => importLog()),

  rows: adminOnly.input(z.object({ importId: z.number().int() })).handler(({ input }) => importRows(input.importId)),
};
