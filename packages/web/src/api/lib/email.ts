import { Resend } from "resend";
import { inDemo } from "../database";

/* ---------------------------------------------------------------------------
 * Terra's outbound email. ONE pipe, and every marketing send in the app goes
 * down it so the guards below cannot be sidestepped.
 *
 * Two addresses, two different jobs:
 *   team@terraflooring.com.au    marketing, journeys, blasts. Built here.
 *   damien@terraflooring.com.au  quotes. ALREADY WORKING, untouched by this file.
 *
 * Resend only SENDS. Terra's actual inboxes stay on whatever hosts the domain,
 * and nothing here touches MX records or mail delivery. Damien reads his mail
 * exactly as he did before.
 * ------------------------------------------------------------------------- */

const resend = new Resend(process.env.RESEND_API_KEY);

export const MARKETING_FROM = "Terra Flooring <team@terraflooring.com.au>";
export const MARKETING_REPLY_TO = "team@terraflooring.com.au";

/** Sending-only key on purpose. It cannot read the account or delete anything. */
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

/* ---------------------------------------------------------------------------
 * Free-plan ceilings. Damien is on Resend Free: 100 a day AND 3,000 a month,
 * and the 3,001st email is REJECTED, not queued. A send that trips a ceiling
 * must come back as `deferred` so the engine can try it again tomorrow rather
 * than dropping a review request on the floor where nobody notices.
 *
 * Numbers live here so moving to Pro ($20/mo, 50,000, no daily cap) is a two
 * line edit, not a hunt through the codebase.
 * ------------------------------------------------------------------------- */
export const PLAN_LIMITS = { perDay: 100, perMonth: 3000 } as const;

/** Leave headroom so a quote or a password reset never loses to a drip email. */
export const MARKETING_DAILY_BUDGET = 80;

export type SendOutcome =
  | { ok: true; providerId: string }
  | { ok: false; deferred: true; reason: string }
  | { ok: false; deferred: false; reason: string };

/* ---------------------------------------------------------------------------
 * Job conversations use their own pair of addresses, kept separate from
 * marketing on purpose.
 *
 *   from     a verified sending address on terraflooring.com.au
 *   replyTo  an address on an INBOUND-ONLY subdomain
 *
 * The subdomain matters. Receiving mail means pointing MX records at Resend,
 * and Terra's own MX on terraflooring.com.au is Damien's real mailbox. Pointing
 * those at Resend would take his email off him. A subdomain like
 * reply.terraflooring.com.au receives for the app alone and leaves his inbox
 * exactly as it is.
 * ------------------------------------------------------------------------- */
export const CONVERSATION_FROM =
  process.env.CONVERSATION_FROM ?? "Terra Flooring <team@terraflooring.com.au>";
export const CONVERSATION_REPLY_TO = process.env.CONVERSATION_REPLY_TO ?? "";

/** Can a customer's reply actually get back into Terra Ops? */
export const inboundConfigured = () => Boolean(CONVERSATION_REPLY_TO);

/**
 * A reply-to address unique to one conversation, e.g. conv+184@reply.terra...
 *
 * This is the part that makes inbound reliable. Resend generates the outgoing
 * Message-ID itself and does not hand it back, so we cannot match the first
 * reply on In-Reply-To alone. Putting the conversation id in the address the
 * customer replies TO means the reply identifies itself, whatever their mail
 * client does to the subject line or the headers.
 *
 * Needs the inbound address to accept plus-addressing or be a catch-all.
 */
export function conversationReplyTo(conversationId: number) {
  if (!CONVERSATION_REPLY_TO) return undefined;
  const [local, domain] = CONVERSATION_REPLY_TO.split("@");
  if (!local || !domain) return CONVERSATION_REPLY_TO;
  return `${local}+${conversationId}@${domain}`;
}

/** Read the conversation id back out of whichever address the reply arrived on. */
export function conversationIdFromAddress(raw: string | null | undefined) {
  if (!raw) return null;
  const m = raw.match(/\+(\d+)@/);
  return m?.[1] ? Number(m[1]) : null;
}

interface SendArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Overrides the marketing From. Job conversations pass their own. */
  from?: string;
  /** Per-recipient unsubscribe URL. Marketing mail must carry one. */
  unsubscribeUrl?: string;
  /**
   * Real RFC threading. Passing these is what makes a reply land under the
   * right thread in the customer's mail client, and what lets us match their
   * reply back to the right conversation when it returns.
   */
  inReplyTo?: string;
  references?: string;
  /** Transactional attachments, e.g. a generated invoice PDF. Base64 content. */
  attachments?: Array<{ filename: string; content: string }>;
}

/**
 * Raw send. Callers in the marketing engine must go through `sendMarketing`
 * in the journey service instead, which checks consent, opt-out and the daily
 * budget first. This function deliberately knows nothing about contacts.
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  replyTo,
  from,
  unsubscribeUrl,
  inReplyTo,
  references,
  attachments,
}: SendArgs): Promise<SendOutcome> {
  if (!emailConfigured()) return { ok: false, deferred: true, reason: "RESEND_API_KEY not set" };
  /* The Google Play reviewer's demo: the screen behaves as if it sent, nothing leaves. */
  if (inDemo()) return { ok: true, providerId: "demo-not-sent" };

  /* One-click unsubscribe. Gmail and Outlook both surface this as a button and
   * treat its absence on bulk mail as a spam signal, so it is not optional.
   * Threading headers go out on the same map. */
  const headers: Record<string, string> = {};
  if (unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
  if (references) headers["References"] = references;

  const { data, error } = await resend.emails.send({
    from: from ?? MARKETING_FROM,
    to: [to],
    subject,
    html,
    text,
    replyTo: replyTo ?? MARKETING_REPLY_TO,
    headers: Object.keys(headers).length ? headers : undefined,
    attachments,
  });

  if (error) {
    const msg = error.message ?? String(error);
    /* Rate limits and plan ceilings are temporary. Anything else is the
     * address or the payload, and retrying it tomorrow changes nothing. */
    const temporary = /rate|limit|quota|too many|exceeded|timeout|5\d\d/i.test(msg);
    return { ok: false, deferred: temporary, reason: msg };
  }

  return { ok: true, providerId: data?.id ?? "" };
}

/* ---------------------------------------------------------------------------
 * The wrapper. Mostly-text, one logo, a plain link instead of a button, and
 * Terra's details in the footer. That is what lands in the inbox rather than
 * the promotions tab, and it is what gets replies, because it reads like a
 * person typed it.
 * ------------------------------------------------------------------------- */

const TERRA = {
  name: "Terra Flooring",
  phone: "1300 1 TERRA",
  email: "team@terraflooring.com.au",
  site: "terraflooring.com.au",
} as const;

export function wrapEmail(bodyHtml: string, unsubscribeUrl: string) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f4f2;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f1d1b;">
  <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em;padding-bottom:24px;">${TERRA.name}</div>
  ${bodyHtml}
  <div style="margin-top:36px;padding-top:20px;border-top:1px solid #dcd8d4;font-size:13px;line-height:1.5;color:#6b655f;">
    <div style="font-weight:600;color:#1f1d1b;">${TERRA.name}</div>
    <div>${TERRA.phone} &nbsp;&middot;&nbsp; ${TERRA.email}</div>
    <div>${TERRA.site}</div>
    <div style="margin-top:12px;">
      <a href="${unsubscribeUrl}" style="color:#6b655f;">Unsubscribe</a> from these emails.
    </div>
  </div>
</div>
</body></html>`;
}

/** Plain-text twin. Sending HTML alone costs you deliverability. */
export function footerText(unsubscribeUrl: string) {
  return `\n\n--\n${TERRA.name}\n${TERRA.phone}  ${TERRA.email}\n${TERRA.site}\n\nUnsubscribe: ${unsubscribeUrl}\n`;
}

/** `{{first_name}}` and friends, filled at send time. Unknown fields blank out. */
export function fillMergeFields(template: string, fields: Record<string, string>) {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => fields[key.toLowerCase()] ?? "");
}
