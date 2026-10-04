/* ---------------------------------------------------------------------------
 * Terra's outbound SMS, via ClickSend. Australian, no monthly fee, billed per
 * message in AUD.
 *
 * Same shape as lib/email.ts on purpose: a raw sender with no knowledge of
 * contacts, and the consent and opt-out checks living in the journey engine
 * above it. Nothing in the app may call ClickSend directly.
 * ------------------------------------------------------------------------- */

import { inDemo } from "../database";

const BASE = "https://rest.clicksend.com/v3";

const auth = () =>
  "Basic " + btoa(`${process.env.CLICKSEND_USERNAME}:${process.env.CLICKSEND_API_KEY}`);

export const smsConfigured = () => Boolean(process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_API_KEY);

/**
 * Terra holds two senders on the one ClickSend account, and they behave very
 * differently. Every text picks one.
 *
 *   THE ALPHA TAG ("TerraFloors") shows Terra's name instead of a number. It is
 *   send-only: there is no number behind it, so a homeowner pressing reply
 *   reaches nothing, and "reply STOP" on a tag is a lie. Free to hold.
 *
 *   Careful with its status. ClickSend's own alpha-tags endpoint reports
 *   APPROVED, but that is only ClickSend's internal check, granted instantly.
 *   It is NOT the ACMA SMS Sender ID Register. Since 1 July 2026 any tag not on
 *   the ACMA register is overstamped "Unverified" by the carriers, so the
 *   handset shows "Unverified" where Terra's name should be. Confirmed on a
 *   real test text, 27 Sep 2026. Registering means three checkpoints: ClickSend
 *   vets it, Terra's nominated Entity Representative confirms in ACMA Assist
 *   via myID and ABR authorisation, then ACMA approves.
 *
 *   THE DEDICATED NUMBER (+61493089052) is a real AU mobile Terra rents, $20.90
 *   a month, inbound free. Two-way, so replies land back in Terra Ops and STOP
 *   opt-outs are captured automatically. No ACMA registration, no overstamp, and
 *   a homeowner can save it as a contact. Right for anything that asks a
 *   question, because "reply YES and we will price it" is pointless if the reply
 *   goes nowhere.
 *
 * The number is plumbing, not branding. It is never printed or advertised,
 * 1300 1 TERRA is the only number that goes on trucks, quotes and the site.
 */
export const SMS_TAG = (process.env.CLICKSEND_SENDER_ID ?? "").trim();
export const SMS_NUMBER = (process.env.CLICKSEND_REPLY_NUMBER ?? "").trim();

/**
 * Whether the tag is actually on the ACMA register, which ClickSend's API
 * cannot tell us. Defaults to false on purpose: an unregistered tag arrives as
 * "Unverified", which is worse for trust than sending from a plain number.
 * Flip this to true only once ACMA confirms, then Terra's name shows properly.
 */
export const tagOnAcmaRegister = () =>
  String(process.env.CLICKSEND_TAG_ACMA_REGISTERED ?? "").toLowerCase() === "true";

/** Back-compat name for the default, one-way sender. */
export const SMS_FROM = SMS_TAG;

const looksLikeNumber = (v: string) => /^\+\d{8,15}$/.test(v);

/** Is the rented two-way number configured and usable? */
export const hasReplyNumber = () => looksLikeNumber(SMS_NUMBER);

/** True when the default sender is itself a number rather than a tag. */
export const isDedicatedNumber = () => looksLikeNumber(SMS_TAG);

/**
 * Live status of our alpha tag, straight from ClickSend. Cached briefly because
 * every queued text would otherwise ask.
 *
 * ServiceM8 sending "TerraFloors" today proves nothing about this account. A
 * tag is registered per sending account, so Terra's ClickSend registration has
 * to stand on its own even though the same words already go out elsewhere.
 */
let tagCache: { ready: boolean; at: number } | null = null;

export async function alphaTagReady(): Promise<boolean> {
  if (!SMS_TAG || !smsConfigured()) return false;
  /* A rented number is ours already. Nothing to wait for. */
  if (isDedicatedNumber()) return true;
  if (tagCache && Date.now() - tagCache.at < 15 * 60_000) return tagCache.ready;

  try {
    const res = await fetch(`${BASE}/alpha-tags`, { headers: { Authorization: auth() } });
    const json = (await res.json().catch(() => ({}))) as any;
    const rows: any[] = Array.isArray(json?.alpha_tags) ? json.alpha_tags : [];
    const mine = rows.find((r) => String(r?.alpha_tag).toLowerCase() === SMS_TAG.toLowerCase());
    const ready = String(mine?.status ?? "").toUpperCase() === "APPROVED";
    tagCache = { ready, at: Date.now() };
    return ready;
  } catch {
    /* Cannot confirm, so do not risk the tag. The pool number still sends. */
    return false;
  }
}

/**
 * Can a homeowner actually reply to what we send? A journey step that invites a
 * reply must refuse to run when the answer is no, rather than sending a text
 * that asks a question into a void.
 */
export const canReceiveReplies = () => hasReplyNumber() || isDedicatedNumber();

/**
 * Which sender a given text goes out as.
 *
 *   "tag"     the alpha tag, one-way, for operational notices
 *   "number"  the rented two-way number, for anything inviting a reply
 *   "auto"    the tag, unless the step needs replies
 *
 * Resolved per message rather than per account, because Terra runs both at once
 * and a journey mixes the two. Returns the literal string ClickSend wants, or
 * null to send from ClickSend's shared pool, which is the safe fallback when
 * our own sender is not usable yet.
 */
export type SmsSender = "tag" | "number" | "auto";

export async function resolveSender(sender: SmsSender, needsReply = false): Promise<string | null> {
  const tagUsable = Boolean(SMS_TAG) && tagOnAcmaRegister() && (await alphaTagReady());

  /* "auto" wants Terra's name on the message, but not at the cost of the
   * "Unverified" overstamp. Until ACMA registration lands, a plain number reads
   * better than a message branded Unverified. */
  const wantsNumber = sender === "number" || (sender === "auto" && (needsReply || !tagUsable));

  if (wantsNumber) {
    if (hasReplyNumber()) return SMS_NUMBER;
    /* Asked for a repliable sender and there is not one. Falling back to the
     * tag would send a question nobody can answer, so refuse instead. */
    if (sender === "number" || needsReply) return null;
    /* One-way text, no number to hand. ClickSend's shared pool still delivers. */
    return null;
  }

  return tagUsable ? SMS_TAG : null;
}

/** Terra bills in AUD. Roughly 7.9c a message to an Australian mobile. */
export type SmsOutcome =
  | { ok: true; providerId: string; price: number }
  | { ok: false; deferred: true; reason: string }
  | { ok: false; deferred: false; reason: string };

/**
 * E.164 for Australian mobiles. ServiceM8 data arrives as 0412 345 678,
 * 0412345678, +61412345678 and worse, and ClickSend wants one shape.
 * Returns null when it is not a mobile we can text, which is a hard fail
 * rather than something to retry.
 */
export function normaliseMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^\d+]/g, "");
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^614\d{8}$/.test(d)) return `+${d}`;
  if (/^04\d{8}$/.test(d)) return `+61${d.slice(1)}`;
  if (/^4\d{8}$/.test(d)) return `+61${d}`;
  return null;
}

/**
 * A GSM-7 text is 160 characters, and past that carriers bill per 153-character
 * part. The office should see the cost before sending, not after.
 */
export function smsParts(body: string) {
  const unicode = /[^\x20-\x7E\n\r]/.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

interface SendSmsArgs {
  to: string;
  body: string;
  /** Which sender to appear as. Defaults to the one-way tag. */
  sender?: SmsSender;
  /** True when the copy asks the homeowner to reply, which forces the number. */
  needsReply?: boolean;
}

export async function sendSms({ to, body, sender = "auto", needsReply = false }: SendSmsArgs): Promise<SmsOutcome> {
  /* The Google Play reviewer's demo: the screen behaves as if it sent, nothing leaves. */
  if (inDemo()) return { ok: true, providerId: "demo-not-sent", price: 0 };
  if (!smsConfigured()) return { ok: false, deferred: true, reason: "ClickSend credentials not set" };

  const mobile = normaliseMobile(to);
  if (!mobile) return { ok: false, deferred: false, reason: `not a valid AU mobile: ${to}` };

  /* A text that asks a question must go from the repliable number. If that is
   * missing, do not quietly send it from the tag into a void. */
  if ((sender === "number" || needsReply) && !hasReplyNumber()) {
    return { ok: false, deferred: true, reason: "this message needs the two-way number, which is not configured" };
  }

  const message: Record<string, string> = { to: mobile, body, source: "terra-ops" };
  const from = await resolveSender(sender, needsReply);
  if (from) message.from = from;

  let res: Response;
  try {
    res = await fetch(`${BASE}/sms/send`, {
      method: "POST",
      headers: { Authorization: auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [message] }),
    });
  } catch (e) {
    /* Network trouble is always worth another go. */
    return { ok: false, deferred: true, reason: `clicksend unreachable: ${String(e)}` };
  }

  const json = (await res.json().catch(() => ({}))) as any;
  const row = json?.data?.messages?.[0];
  const status = String(row?.status ?? "");

  /* An empty wallet is the common one and it is temporary by nature: top up
   * and the same message goes out tomorrow. Never discard it. */
  if (status === "INSUFFICIENT_CREDIT") {
    return { ok: false, deferred: true, reason: "ClickSend balance is empty, top up to resume" };
  }

  if (!res.ok || json?.response_code !== "SUCCESS") {
    const reason = json?.response_msg ?? `HTTP ${res.status}`;
    const temporary = res.status === 429 || res.status >= 500;
    return { ok: false, deferred: temporary, reason: String(reason) };
  }

  if (status !== "SUCCESS" && status !== "QUEUED") {
    return { ok: false, deferred: false, reason: status || "unknown ClickSend status" };
  }

  return { ok: true, providerId: String(row?.message_id ?? ""), price: Number(row?.message_price ?? 0) };
}

/** What a send will cost, asked before sending. Does not send or charge. */
export async function priceSms(to: string, body: string) {
  const mobile = normaliseMobile(to);
  if (!mobile || !smsConfigured() || inDemo()) return null;
  const res = await fetch(`${BASE}/sms/price`, {
    method: "POST",
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ to: mobile, body, source: "terra-ops" }] }),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  return typeof json?.data?.total_price === "number" ? (json.data.total_price as number) : null;
}

/** Wallet balance in AUD, so the office is warned before a journey stalls. */
export async function smsBalance() {
  if (!smsConfigured() || inDemo()) return null;
  const res = await fetch(`${BASE}/account`, { headers: { Authorization: auth() } });
  const json = (await res.json().catch(() => ({}))) as any;
  const bal = Number(json?.data?.balance);
  return Number.isFinite(bal) ? bal : null;
}

/** Every Terra text ends the same way. Opting out of SMS is a legal must. */
export const SMS_OPT_OUT = " Reply STOP to opt out.";
