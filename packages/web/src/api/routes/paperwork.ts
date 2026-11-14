import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { DOCS, paperworkFor, setPaperwork, type PaperRow } from "../lib/paperwork";

/* ---------------------------------------------------------------------------
 * Who gets what on a job (Damien, 14 Nov 2026): the card on the job that
 * shows and sets who gets quotes, variations and invoices. Office and Admin.
 * The sends themselves are checked in lib/paperwork.ts.
 * ------------------------------------------------------------------------- */

const shape = (r: PaperRow) => ({
  key: r.key,
  kind: r.kind,
  contactId: r.contactId,
  companyId: r.companyId,
  name: r.name,
  roleLabel: r.roleLabel,
  email: r.email,
  mobileShown: r.mobileShown,
  onJob: r.onJob,
  quote: r.quote,
  variation: r.variation,
  invoice: r.invoice,
  defaultWhy: r.defaultWhy,
});

async function cardFor(jobId: number) {
  const pw = await paperworkFor(jobId);
  if (!pw) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  return { typeLabel: pw.typeLabel, rows: pw.rows.map(shape) };
}

export const paperwork = {
  get: staffOnly.input(z.object({ jobId: z.number().int() })).handler(({ input }) => cardFor(input.jobId)),

  /** One box. on null puts it back to the default for their role. */
  set: staffOnly
    .input(
      z.object({
        jobId: z.number().int(),
        contactId: z.number().int().nullish(),
        companyId: z.number().int().nullish(),
        doc: z.enum(DOCS),
        on: z.boolean().nullable(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (!input.contactId === !input.companyId) throw new ORPCError("BAD_REQUEST", { message: "Pick one person or the company." });
      await setPaperwork({ jobId: input.jobId, contactId: input.contactId ?? null, companyId: input.companyId ?? null, doc: input.doc, on: input.on, byName: context.actor.name });
      return cardFor(input.jobId);
    }),
};
