/* ---------------------------------------------------------------------------
 * The text that goes with a quote email (Damien, 30 Oct). No imports on
 * purpose: the Send screen builds the same preview from this file, so what
 * the office reads is what the client gets.
 * ------------------------------------------------------------------------- */

/** Same words as SMS_OPT_OUT in lib/sms.ts. Every customer text ends with it. */
export const QUOTE_SMS_OPT_OUT = " Reply STOP to opt out.";

export type QuoteSmsParts = {
  firstName: string;
  /** "hybrid flooring to the living areas". Typed or checked on the Send screen. */
  description: string;
  url: string;
  /** Only true once the email has actually been handed to Gmail. */
  emailed: boolean;
  /** Set when the client has more than one quote out, so they know which one this is. */
  option?: { n: number; of: number; ref: string } | null;
  /** An accepted quote with its wording fixed. */
  resend?: boolean;
};

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

/** The short description, cleaned so it reads inside the sentence. */
export function smsDescription(raw: string) {
  return tidy(raw).replace(/[.\s]+$/, "").replace(/^(your|the)\s+quote\s+for\s+/i, "");
}

export function quoteSmsText(p: QuoteSmsParts) {
  const first = tidy(p.firstName) || "there";
  const what = smsDescription(p.description);
  const opt = p.option ? ` ${p.option.ref} (option ${p.option.n} of ${p.option.of})` : "";
  const forWhat = what ? ` for ${what}` : "";
  const emailed = p.emailed ? " We've also emailed it to you." : "";
  if (p.resend) {
    return `Hi ${first}, Damien from Terra Flooring here. We've tidied up the wording on your accepted quote${opt}${forWhat}. The price is the same. View it here: ${p.url}${emailed} Any questions, please get in touch.${QUOTE_SMS_OPT_OUT}`;
  }
  return `Hi ${first}, Damien from Terra Flooring here. Your quote${opt}${forWhat} is ready: ${p.url}${emailed} Any questions, please get in touch.${QUOTE_SMS_OPT_OUT}`;
}

/** Same sum as smsParts in lib/sms.ts: 160 a part, 153 once it splits. */
export function quoteSmsPartCount(body: string) {
  const unicode = /[^\x20-\x7E\n\r]/.test(body);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return body.length <= single ? 1 : Math.ceil(body.length / multi);
}

/** AU mobile check for the screen, same rules as normaliseMobile in lib/sms.ts. */
export function mobileForSms(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^\d+]/g, "");
  if (/^\+614\d{8}$/.test(d)) return d;
  if (/^614\d{8}$/.test(d)) return `+${d}`;
  if (/^04\d{8}$/.test(d)) return `+61${d.slice(1)}`;
  if (/^4\d{8}$/.test(d)) return `+61${d}`;
  return null;
}

/** +61469967205 as 0469 967 205, how the office reads it. */
export function showMobile(e164: string | null | undefined) {
  if (!e164) return "";
  const m = /^\+614(\d{2})(\d{3})(\d{3})$/.exec(e164);
  return m ? `04${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** The email scope typed in place of the fill-in, found from the words either side of it. */
export function scopeFromBody(template: string, edited: string, fill: string) {
  const at = template.indexOf(fill);
  if (at < 0) return "";
  const before = template.slice(Math.max(0, at - 40), at);
  const after = template.slice(at + fill.length, at + fill.length + 40);
  const start = edited.indexOf(before);
  if (!before || start < 0) return "";
  const from = start + before.length;
  const end = after ? edited.indexOf(after, from) : edited.length;
  if (end < 0 || end - from > 160) return "";
  const got = edited.slice(from, end).trim();
  return got === fill ? "" : got;
}
