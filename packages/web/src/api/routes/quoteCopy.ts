import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { copyCreate, copyPreview, copySearch, quotesForClient } from "../lib/quote-copy";
import { copyLinksForJob } from "../lib/quote-copy-links";

/**
 * Copy from previous job and Duplicate this quote (Damien, 16 Oct, notes
 * 18.46). Admin and Office. The copy is priced off the price book, so Office
 * stays inside its usual pricing limits on the new quote.
 */
export const quoteCopy = {
  /** Past quotes by client name, site address, product or quote number. The picked client's come first. */
  search: staffOnly
    .input(
      z.object({
        q: z.string().max(200).default(""),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
      }),
    )
    .handler(({ input }) => copySearch(input)),

  /** The lines on a quote, ticked or not, priced today, red where they cannot be copied as they are. */
  preview: staffOnly.input(z.object({ quoteId: z.number() })).handler(({ input }) => copyPreview(input.quoteId)),

  /** Make the copy. The original quote and job are never changed. */
  create: staffOnly
    .input(
      z.object({
        fromQuoteId: z.number(),
        mode: z.enum(["same", "other"]),
        lines: z
          .array(z.object({ itemId: z.number(), replaceProductId: z.number().nullable().optional() }))
          .max(500),
      }),
    )
    .handler(({ input, context }) => copyCreate(input, context.actor)),

  /** The job page: where its quotes were copied from, and the copies made from them. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => copyLinksForJob(input.jobId)),

  /** The client record: quotes with their follow-ons grouped under the original. */
  forClient: staffOnly
    .input(z.object({ contactId: z.number().nullable().optional(), companyId: z.number().nullable().optional() }))
    .handler(({ input }) => quotesForClient(input)),
};
