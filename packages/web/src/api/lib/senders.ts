/* ---------------------------------------------------------------------------
 * Who an email comes from. Import-free on purpose, so the web can read the
 * labels without pulling in a server module.
 *
 * Two senders on the one verified domain (terraflooring.com.au):
 *   team  quotes, invoices, bookings, reminders, swaps and every journey.
 *         The default for everything.
 *   care  the after-job care emails ONLY. Comes from Damien, and replies go
 *         to his own inbox, because a reply is the best sign it is working.
 *
 * Nothing picks "care" by accident: a send is team@ unless the caller asks
 * for care by name.
 * ------------------------------------------------------------------------- */

export const SENDER_KEYS = ["team", "care"] as const;
export type SenderKey = (typeof SENDER_KEYS)[number];

export const SENDERS: Record<SenderKey, { label: string; from: string; replyTo: string }> = {
  team: {
    label: "Terra Flooring (team@)",
    from: "Terra Flooring <team@terraflooring.com.au>",
    replyTo: "team@terraflooring.com.au",
  },
  care: {
    label: "Damien (damien@), after-job care only",
    from: "Damien at Terra Flooring <damien@terraflooring.com.au>",
    replyTo: "damien@terraflooring.com.au",
  },
};

/** Anything unknown or missing falls back to team@. */
export const senderFor = (key?: string | null) => SENDERS[(SENDER_KEYS as readonly string[]).includes(key ?? "") ? (key as SenderKey) : "team"];
