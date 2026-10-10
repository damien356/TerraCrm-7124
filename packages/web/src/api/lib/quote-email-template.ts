/* Pure, so the Settings page can show the defaults and a preview. */

/* ---------------------------------------------------------------------------
 * The quote email wording (fix list item 11, Damien 11 Oct). Saved in
 * Settings as two templates. {placeholders} are filled from the quote; a
 * " · " part of a line whose placeholder has nothing to show (no deposit, no
 * valid until date) is left out, and a line left empty goes too.
 * ------------------------------------------------------------------------- */

export const QUOTE_EMAIL_SUBJECT_KEY = "quote_email_subject";
export const QUOTE_EMAIL_BODY_KEY = "quote_email_body";

export const DEFAULT_QUOTE_EMAIL_SUBJECT = "Your Terra Flooring quote #{quote_number}";
export const DEFAULT_QUOTE_EMAIL_BODY = [
  "Hi {first_name},",
  "",
  "Thanks for having us out. Your quote for {scope} is ready.",
  "",
  "View and accept your quote online: {link}",
  "",
  "Total: {total} incl. GST · Deposit to secure your booking: {deposit} · Valid until {valid_until}",
  "",
  "Once you accept, we'll confirm your colour, order your flooring and lock in an install date that suits you.",
  "",
  "Any questions, just reply to this email or call me on 1300 183 772.",
  "",
  "Kind regards,",
  "Damien",
  "Terra Flooring",
].join("\n");

/**
 * What the quote is for is typed by the office each time (Damien, 11 Oct), so
 * the draft leaves this in its place and the email will not send until it is
 * replaced.
 */
export const SCOPE_FILL = "[what the quote is for]";

/** True while the office still has to type what the quote is for. */
export const needsScope = (...texts: (string | null | undefined)[]) => texts.some((t) => (t ?? "").includes(SCOPE_FILL));

/** The placeholders, for the Settings card. */
export const QUOTE_EMAIL_FIELDS = ["first_name", "quote_number", "scope", "link", "total", "deposit", "valid_until"] as const;
export type QuoteEmailValues = Record<(typeof QUOTE_EMAIL_FIELDS)[number], string>;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Fills a template. Parts of a line with an empty placeholder are dropped. */
export function fillQuoteTemplate(template: string, values: Partial<QuoteEmailValues>) {
  const vals = values as Record<string, string | undefined>;
  const known = (k: string) => (QUOTE_EMAIL_FIELDS as readonly string[]).includes(k);
  const fill = (part: string) => part.replace(PLACEHOLDER, (m, k: string) => (known(k) ? (vals[k] ?? "") : m));
  const empty = (part: string) => [...part.matchAll(PLACEHOLDER)].some(([, k]) => known(k!) && !vals[k!]?.trim());
  const out: string[] = [];
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const parts = line.split(" · ").filter((p) => !empty(p));
    if (!parts.length) continue;
    out.push(parts.map(fill).join(" · "));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** "9 November 2026", Brisbane time. */
export function longDate(d: Date | null | undefined) {
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "long", year: "numeric" });
}

