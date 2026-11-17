/* Pure, so the Settings page can show the defaults and a preview. */

/* ---------------------------------------------------------------------------
 * The quote email wording (fix list item 11, Damien 11 Oct). Saved in
 * Settings as two templates. {placeholders} are filled from the quote; a
 * " · " or " — " part of a line whose placeholder has nothing to show (no
 * deposit, no suburb) is left out, and a line left empty goes too.
 * ------------------------------------------------------------------------- */

export const QUOTE_EMAIL_SUBJECT_KEY = "quote_email_subject";
export const QUOTE_EMAIL_BODY_KEY = "quote_email_body";

/* The wording before 17 Nov 2026. Kept so a saved copy of it is moved onto the new one. */
export const OLD_QUOTE_EMAIL_SUBJECT = "Your Terra Flooring quote #{quote_number}";
const OLD_OPENING = "Thanks for having us out. Your quote for {scope} is ready.";
const OLD_NEXT_STEPS = "Once you accept, we'll confirm your colour, order your flooring and lock in an install date that suits you.";
export const OLD_QUOTE_EMAIL_BODY = [
  "Hi {first_name},",
  "",
  OLD_OPENING,
  "",
  "View and accept your quote online: {link}",
  "",
  "Total: {total} incl. GST · Deposit to secure your booking: {deposit} · Valid until {valid_until}",
  "",
  OLD_NEXT_STEPS,
  "",
  "Any questions, just reply to this email or call me on 1300 183 772.",
  "",
  "Kind regards,",
  "Damien",
  "Terra Flooring",
].join("\n");

/*
 * Damien, 17 Nov 2026: the wording comes from the quote's own lines. The
 * opening, the review line and the next steps are worked out per quote
 * (quote-message-context.ts), so a repair quote talks about repairs and a
 * supply only quote about pickup or delivery. The send adds the ref tag, such
 * as [#188116], to the end of the subject, so the subject has no number.
 */
export const DEFAULT_QUOTE_EMAIL_SUBJECT = "Your {quote_title} quote — {suburb}";
export const DEFAULT_QUOTE_EMAIL_BODY = [
  "Hi {first_name},",
  "",
  "{opening}",
  "",
  "{review_line}",
  "",
  "{link}",
  "",
  "Quote total: {total} including GST",
  "Deposit: {deposit}",
  "Quote valid until: {valid_until}",
  "",
  "{next_steps}",
  "",
  "Any questions about the quoted work, please reply to this email or call me on 1300 183 772.",
  "",
  "Kind regards,",
  "Damien",
  "Terra Flooring",
].join("\n");

/**
 * A saved template from before 17 Nov 2026. The old default becomes the new
 * one. A changed copy keeps its changes, with the old fixed opening and next
 * steps lines swapped for the ones worked out from the quote.
 */
export function upgradeTemplate(t: { subject: string; body: string }) {
  const norm = (x: string) => x.replace(/\r\n/g, "\n").trim();
  const subject = norm(t.subject) === OLD_QUOTE_EMAIL_SUBJECT ? DEFAULT_QUOTE_EMAIL_SUBJECT : t.subject;
  const body =
    norm(t.body) === norm(OLD_QUOTE_EMAIL_BODY)
      ? DEFAULT_QUOTE_EMAIL_BODY
      : t.body.replace(/\r\n/g, "\n").split("\n").map((l) => (l.trim() === OLD_OPENING ? "{opening}" : l.trim() === OLD_NEXT_STEPS ? "{next_steps}" : l)).join("\n");
  return { subject, body };
}

/**
 * 188001 list item 1: a supply only quote has no install, so the draft swaps
 * the install date wording for delivery. Works on a saved template too, as
 * long as it still has the default wording.
 */
const INSTALL_WORDS = /lock in an install date that suits you/gi;
export const SUPPLY_ONLY_WORDS = "arrange a delivery date that suits you";
export const forSupplyOnly = (body: string) => body.replace(INSTALL_WORDS, SUPPLY_ONLY_WORDS);

/**
 * Until 17 Nov 2026 the office typed what the quote was for in place of this.
 * The draft now fills {scope} from the quote's lines. The send still refuses
 * an email that has this left in it (a pasted old template, say).
 */
export const SCOPE_FILL = "[what the quote is for]";

/** True while the office still has to type what the quote is for. */
export const needsScope = (...texts: (string | null | undefined)[]) => texts.some((t) => (t ?? "").includes(SCOPE_FILL));

/** The placeholders, for the Settings card. */
export const QUOTE_EMAIL_FIELDS = [
  "first_name",
  "quote_number",
  "quote_title",
  "suburb",
  "opening",
  "scope",
  "review_line",
  "link",
  "total",
  "deposit",
  "valid_until",
  "next_steps",
] as const;
export type QuoteEmailValues = Record<(typeof QUOTE_EMAIL_FIELDS)[number], string>;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Fills a template. Parts of a line with an empty placeholder are dropped, split on " · " or " — ". */
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
    const kept = line
      .split(" · ")
      .map((dot) => dot.split(" — ").filter((p) => !empty(p)).join(" — "))
      .filter(Boolean);
    if (!kept.length) continue;
    out.push(kept.map(fill).join(" · "));
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

/** "9 November 2026", Brisbane time. */
export function longDate(d: Date | null | undefined) {
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "long", year: "numeric" });
}

