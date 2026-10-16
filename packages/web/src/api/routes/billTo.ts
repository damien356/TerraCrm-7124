import { z } from "zod";
import { staffOnly } from "../middleware/auth";
import { billToInput, cardOf, cardsMissingDeposit, setCardDeposit } from "../lib/bill-to";
import { billToOptions, cardsOf, searchBillTo } from "../lib/bill-to-options";

/* ---------------------------------------------------------------------------
 * BILL TO (notes 18.54). Who pays a job or a quote, the deposit % on their
 * card, and the Deposit % to fill page. Admin and Office. Nothing here sends
 * anything to a client.
 * ------------------------------------------------------------------------- */

export const billTo = {
  /** One card: its name and deposit %. Null when the card is gone. */
  card: staffOnly.input(billToInput).handler(({ input }) => cardOf(input)),

  /** Several cards at once, in the order asked. */
  cards: staffOnly.input(z.object({ list: z.array(billToInput).max(50) })).handler(({ input }) => cardsOf(input.list)),

  /** The picker's short list for a job or quote, and who it bills now. */
  options: staffOnly
    .input(z.object({ jobId: z.number().nullable().optional(), quoteId: z.number().nullable().optional() }))
    .handler(({ input }) => billToOptions(input)),

  /** Anyone by name, mobile or email. */
  search: staffOnly.input(z.object({ q: z.string().max(100) })).handler(({ input }) => searchBillTo(input.q)),

  /** Save a % on a card. Draft quotes billed to it follow. Sent quotes stay. */
  setCardDeposit: staffOnly
    .input(z.object({ billTo: billToInput, percent: z.number().min(0).max(100) }))
    .handler(({ input, context }) => setCardDeposit(input.billTo, input.percent, context.actor)),

  /** Cards with no % yet that pay on an open job. */
  missing: staffOnly.handler(() => cardsMissingDeposit()),
};
