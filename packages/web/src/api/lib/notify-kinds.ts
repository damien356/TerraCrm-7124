/* ---------------------------------------------------------------------------
 * What Terra Ops can tell the office about, and the settings that steer it.
 * Fix list 11 Oct, item 15.
 *
 * No imports on purpose: the Settings page and the Dashboard read this file
 * too, and web code must never pull in a server module.
 * ------------------------------------------------------------------------- */

export const ALERT_KINDS = {
  quote_accepted: { label: "Client accepted a quote online", group: "Clients", urgent: true },
  payment_received: { label: "Card payment received", group: "Money", urgent: true },
  swms_red: { label: "SWMS red card from the crew", group: "Crew", urgent: true },
  price_flag_big: { label: "Supplier price flag over $50", group: "Money", urgent: true },
  price_flag: { label: "Supplier price flag under $50", group: "Money", urgent: false },
  missing_invoice: { label: "Supplier invoice missing (on a statement)", group: "Money", urgent: false },
  quote_rework: { label: "Things to sort after a quote is accepted", group: "Clients", urgent: false },
  quote_viewed: { label: "Quote opened 3 or more times", group: "Clients", urgent: false },
  variation_accepted: { label: "Client accepted a variation online", group: "Clients", urgent: false },
  variation_declined: { label: "Client declined a variation online", group: "Clients", urgent: false },
  selection_done: { label: "Client filled in flooring or colours", group: "Clients", urgent: false },
  client_text: { label: "Text from a client", group: "Clients", urgent: false },
  client_email: { label: "Email from a client", group: "Clients", urgent: false },
  care_wool: { label: "Is this carpet wool? (care emails)", group: "Clients", urgent: false },
  lead_new: { label: "New lead from a landing page", group: "Clients", urgent: true },
  repair_price_ready: { label: "Timber repair price back from Marc", group: "Clients", urgent: false },
  repair_no_reply: { label: "Timber repair: no price after 2 hours", group: "Clients", urgent: false },
  repair_bad_reply: { label: "Timber repair: reply not understood", group: "Clients", urgent: false },
  offer_accepted: { label: "Crew took a job or locked a hold", group: "Crew", urgent: false },
  offer_declined: { label: "Crew declined an offer", group: "Crew", urgent: false },
  offer_expired: { label: "Offer got no taker", group: "Crew", urgent: false },
  handed_back: { label: "Crew handed a job back", group: "Crew", urgent: false },
  crew_on_site: { label: "Crew arrived on site", group: "Crew", urgent: false },
  task_finished: { label: "Crew finished a task", group: "Crew", urgent: false },
  ready_to_invoice: { label: "Job ready to invoice", group: "Crew", urgent: false },
  running_late: { label: "Crew running late", group: "Crew", urgent: false },
  crew_note: { label: "Voice note from the crew", group: "Crew", urgent: false },
} as const;

export type AlertKind = keyof typeof ALERT_KINDS;

export const ALERT_KIND_KEYS = Object.keys(ALERT_KINDS) as AlertKind[];

export const isAlertKind = (k: string): k is AlertKind => Object.prototype.hasOwnProperty.call(ALERT_KINDS, k);

export const alertLabel = (k: string) => (isAlertKind(k) ? ALERT_KINDS[k].label : k);

export const DEFAULT_URGENT: AlertKind[] = ALERT_KIND_KEYS.filter((k) => ALERT_KINDS[k].urgent);

/* Settings keys, all in the settings table. */
export const NOTIFY_EMAIL_TO_KEY = "notify_email_to";
export const NOTIFY_DAILY_KEY = "notify_daily_on";
export const NOTIFY_URGENT_KEY = "notify_urgent_kinds";
export const NOTIFY_DAILY_SENT_KEY = "notify_daily_sent_on";
/** JSON of the last scheduled summary actually sent: real time, how, to whom, Resend id (21 Oct). */
export const NOTIFY_DAILY_LAST_KEY = "notify_daily_last_sent";
export const CLIENT_AUTO_SMS_KEY = "client_auto_sms_on";

export const NOTIFY_EMAIL_TO_DEFAULT = "damien@terraflooring.com.au";

/* ---------------------------------------------------------------------------
 * Loop protection. Every email Terra Ops sends the office comes from this one
 * address, with a subject that starts "[Terra Ops]". Anything that reads mail
 * (the mail agent, any future work order catcher) skips mail that matches, so
 * Terra Ops never turns its own notification into a task, a job or an invoice.
 * ------------------------------------------------------------------------- */

export const NOTIFY_FROM_ADDRESS = "notifications@terraflooring.com.au";
export const NOTIFY_FROM = `Terra Ops <${NOTIFY_FROM_ADDRESS}>`;
export const NOTIFY_SUBJECT_TAG = "[Terra Ops]";

/** True for mail Terra Ops sent itself. Replies ("Re: [Terra Ops] ...") count too. */
export function isTerraOpsMail(from: string | null | undefined, subject: string | null | undefined): boolean {
  const f = String(from ?? "").toLowerCase();
  if (f.includes(NOTIFY_FROM_ADDRESS)) return true;
  return String(subject ?? "").toLowerCase().includes(NOTIFY_SUBJECT_TAG.toLowerCase());
}

/** The saved urgent list, or the defaults when nothing is saved or it is unreadable. */
export function parseUrgent(raw: string | null | undefined): AlertKind[] {
  if (raw == null || raw === "") return [...DEFAULT_URGENT];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [...DEFAULT_URGENT];
    return v.filter((k): k is AlertKind => typeof k === "string" && isAlertKind(k));
  } catch {
    return [...DEFAULT_URGENT];
  }
}
