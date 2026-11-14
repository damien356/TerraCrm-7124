import { z } from "zod";
import { authed, staffOnly } from "../middleware/auth";
import { ATTENTION_KEYS, ATTENTION_LABEL, attentionLists, widgetSnapshot } from "../lib/widget";
import { expireStale } from "./offers";
import { todayLocal } from "../lib/local-date";

/**
 * Home-screen widgets (Damien, 14 Nov 2026). See lib/widget.ts.
 *
 * `snapshot` is what the phone saves for "Terra Today" and "My Job". Any
 * signed-in login may ask, and each part is built only from what that login
 * can already see: office counts for Office and Admin, the person's own staff
 * card or crew card for the bookings. Read only, nothing is written.
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
};
