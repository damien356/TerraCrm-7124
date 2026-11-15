import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authed, staffOnly } from "../middleware/auth";
import { ATTENTION_KEYS, ATTENTION_LABEL, attentionLists, measureQuoteRows, setQuoteNeeded, widgetSnapshot } from "../lib/widget";
import { expireStale } from "./offers";
import { todayLocal } from "../lib/local-date";

/**
 * Home-screen widgets (Damien, 14 Nov 2026). See lib/widget.ts.
 *
 * `snapshot` is what the phone saves for "Terra Today" and "My Job". Any
 * signed-in login may ask, and each part is built only from what that login
 * can already see: office counts for Office and Admin, the person's own staff
 * card or crew card for the bookings. Read only, nothing is written.
 *
 * `attention` is the page the widget opens. It is built by the same
 * attentionLists call as the widget's counts, for the same login, so each
 * count is exactly the rows under it.
 */
export const widget = {
  snapshot: authed.handler(({ context }) => widgetSnapshot(context.actor)),

  /** The "Needs attention" list the widget opens. Office and Admin only. */
  attention: staffOnly
    .input(z.object({ show: z.enum(ATTENTION_KEYS as [string, ...string[]]).optional() }).optional())
    .handler(async ({ context }) => {
      // Same as the dashboard: stale offers come off before anything is counted.
      await expireStale();
      const today = todayLocal();
      const lists = await attentionLists(context.actor, today);
      return { today, sections: ATTENTION_KEYS.map((key) => ({ key, label: ATTENTION_LABEL[key], rows: lists[key] })) };
    }),

  /**
   * Measures awaiting a quote (Damien, 14 Nov 2026): the office says no quote
   * is needed after this job's measure, with a reason. Only a job on that
   * list. Logged on the job. Sends nothing, books nothing.
   */
  quoteNotNeeded: staffOnly
    .input(z.object({ jobId: z.number().int(), reason: z.string().trim().min(3, "Say why no quote is needed.").max(500) }))
    .handler(async ({ input, context }) => {
      const open = await measureQuoteRows(new Date());
      if (!open.some((r) => r.jobId === input.jobId)) {
        throw new ORPCError("BAD_REQUEST", { message: "This job has no measure waiting on a quote any more." });
      }
      await setQuoteNeeded(input.jobId, false, input.reason, context.actor);
      return { ok: true };
    }),

  /** Undo the above: the measure is back on the list until a quote is sent. */
  quoteNeededAgain: staffOnly
    .input(z.object({ jobId: z.number().int(), reason: z.string().trim().max(500).optional() }))
    .handler(async ({ input, context }) => {
      await setQuoteNeeded(input.jobId, true, input.reason ?? "", context.actor);
      return { ok: true };
    }),
};
