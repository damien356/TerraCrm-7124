/**
 * EMAIL FORMAT AND TYPO CHECK (no network).
 *
 * Shared by the server check and the web EmailInput so the "Did you mean"
 * line can show straight away. The mail server lookup lives in
 * routes/emailCheck.ts.
 */

/** Plain "name@domain.tld" check. Loose on the name, strict on the domain. */
export function emailFormatOk(raw: string): boolean {
  const email = raw.trim();
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase();
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  return /^[a-z]{2,24}$/.test(labels[labels.length - 1] ?? "");
}

/** Mail providers our clients use most. Typos near these get a "Did you mean". */
const KNOWN_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.au",
  "outlook.com",
  "outlook.com.au",
  "live.com",
  "live.com.au",
  "msn.com",
  "yahoo.com",
  "yahoo.com.au",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "tpg.com.au",
  "iinet.net.au",
  "westnet.com.au",
  "internode.on.net",
  "dodo.com.au",
  "ozemail.com.au",
  "aapt.net.au",
  "telstra.com",
  "protonmail.com",
  "proton.me",
  "aol.com",
];

/** Ending typos fixed on any domain: "acme.con" to "acme.com". */
const ENDING_FIXES: Array<[string, string]> = [
  [".con", ".com"],
  [".cmo", ".com"],
  [".ocm", ".com"],
  [".vom", ".com"],
  [".xom", ".com"],
  [".comm", ".com"],
  [".coom", ".com"],
  [".ccom", ".com"],
  [".cpm", ".com"],
  [".com.u", ".com.au"],
  [".com.aus", ".com.au"],
  [".com.au.au", ".com.au"],
  [".comau", ".com.au"],
  [".con.au", ".com.au"],
  [".cmo.au", ".com.au"],
  [".net.u", ".net.au"],
  [".netau", ".net.au"],
  [".nte", ".net"],
  [".ent", ".net"],
  [".nett", ".net"],
  [".ogr", ".org"],
  [".orgau", ".org.au"],
];

/** Edit distance where swapping two letters next to each other counts as one. */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * A likely fix for a typo in the domain, or null.
 * "bob@gmai.com" gives "bob@gmail.com". A domain we know is never changed.
 */
export function suggestEmail(raw: string): string | null {
  const email = raw.trim();
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const local = email.slice(0, at);
  let domain = email.slice(at + 1).toLowerCase().replace(/\.+$/, "");
  if (!domain || KNOWN_DOMAINS.includes(domain)) return null;

  // Comma for a dot, doubled dots: "gmail,com", "gmail..com".
  domain = domain.replace(/,/g, ".").replace(/\.{2,}/g, ".");
  if (!domain.includes(".")) {
    // "bob@gmail" with no ending.
    const bare = KNOWN_DOMAINS.find((d) => d.split(".")[0] === domain);
    if (bare) domain = bare;
  }
  for (const [bad, good] of ENDING_FIXES) {
    if (domain.endsWith(bad)) {
      domain = domain.slice(0, -bad.length) + good;
      break;
    }
  }

  if (!KNOWN_DOMAINS.includes(domain)) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const k of KNOWN_DOMAINS) {
      const dist = distance(domain, k);
      if (dist < bestD) {
        bestD = dist;
        best = k;
      }
    }
    const close = best && ((bestD === 1 && domain.length >= 7) || (bestD === 2 && domain.length >= 10));
    if (close && best) domain = best;
  }

  const fixed = `${local}@${domain}`;
  return fixed.toLowerCase() === email.toLowerCase() ? null : fixed;
}
