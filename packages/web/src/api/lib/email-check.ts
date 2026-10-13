import { Resolver } from "node:dns/promises";
import { emailFormatOk, suggestEmail } from "./email-typo";

/**
 * EMAIL CHECK (like ServiceM8).
 *
 * Office types an email; the field asks here whether the address looks right
 * and whether its domain can take mail. Nothing is ever blocked: a red field
 * is a warning, and saving still works.
 *
 * Mail lookup: the domain's MX records, then its A or AAAA records when it has
 * no MX (a plain domain can still take mail, RFC 5321). A "null MX" (RFC 7505)
 * or a domain that does not exist means no mail. A slow or broken DNS answer
 * is "unknown" and never turns the field red. Free, no key needed.
 */

export type MailStatus = "ok" | "no_mail" | "unknown";

const resolver = new Resolver({ timeout: 3000, tries: 2 });

const cache = new Map<string, { status: MailStatus; at: number }>();
const OK_TTL = 6 * 60 * 60_000;
const BAD_TTL = 30 * 60_000;
const UNKNOWN_TTL = 2 * 60_000;
const CACHE_MAX = 3000;

const code = (e: unknown) => (e as { code?: string })?.code ?? "";
/** DNS answers that mean "this name has no such records" rather than "the lookup failed". */
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND", "NOTFOUND", "ENONAME"]);

async function hasAddress(domain: string): Promise<boolean | null> {
  let failed = false;
  for (const kind of ["A", "AAAA"] as const) {
    try {
      const rows = kind === "A" ? await resolver.resolve4(domain) : await resolver.resolve6(domain);
      if (rows.length) return true;
    } catch (e) {
      if (!NO_RECORDS.has(code(e))) failed = true;
    }
  }
  return failed ? null : false;
}

async function lookup(domain: string): Promise<MailStatus> {
  try {
    const mx = await resolver.resolveMx(domain);
    const real = mx.filter((r) => r.exchange && r.exchange !== ".");
    if (real.length) return "ok";
    if (mx.length) return "no_mail"; // null MX: the domain says it takes no mail
  } catch (e) {
    const c = code(e);
    if (c === "ENOTFOUND" || c === "NOTFOUND" || c === "ENONAME") return "no_mail"; // no such domain
    if (c !== "ENODATA") return "unknown";
  }
  const addr = await hasAddress(domain);
  return addr === null ? "unknown" : addr ? "ok" : "no_mail";
}

/** Whether a domain can take mail. Cached so repeat checks are instant. */
export async function domainMailStatus(domainRaw: string): Promise<MailStatus> {
  const domain = domainRaw.trim().toLowerCase().replace(/\.+$/, "");
  const hit = cache.get(domain);
  const now = Date.now();
  if (hit) {
    const ttl = hit.status === "ok" ? OK_TTL : hit.status === "no_mail" ? BAD_TTL : UNKNOWN_TTL;
    if (now - hit.at < ttl) return hit.status;
  }
  const status = await lookup(domain);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(domain, { status, at: now });
  return status;
}

export interface EmailCheckResult {
  email: string;
  /** ok: fine. bad_format: not an email. no_mail: the domain cannot take mail. unknown: lookup failed, treat as fine. */
  status: "ok" | "bad_format" | "no_mail" | "unknown";
  suggestion: string | null;
  message: string;
}

export async function checkEmail(raw: string): Promise<EmailCheckResult> {
  const email = raw.trim();
  const suggestion = suggestEmail(email);
  if (!emailFormatOk(email)) {
    return { email, status: "bad_format", suggestion, message: "This is not a valid email address." };
  }
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const status = await domainMailStatus(domain);
  const message =
    status === "no_mail"
      ? `${domain} can't receive email. Check the spelling.`
      : status === "unknown"
        ? "Couldn't check this domain right now."
        : "";
  return { email, status, suggestion, message };
}
