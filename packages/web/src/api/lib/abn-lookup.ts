/* ---------------------------------------------------------------------------
 * ABN Lookup (notes 18.64). One call to the Australian Business Register's
 * free web service, SearchByABNv202001, for one ABN.
 *
 * Server only. The key is ABR_GUID in the root .env and never leaves this
 * file: it is not logged, not returned, and scrubbed out of any error text.
 * No key, a timeout or a register outage come back as kind "error", which the
 * callers treat as "could not check", never as "not found".
 * ------------------------------------------------------------------------- */

const ENDPOINT = "https://abr.business.gov.au/abrxmlsearch/AbrXmlSearch.asmx/SearchByABNv202001";
const TIMEOUT_MS = 12_000;

export type AbnFound = {
  kind: "found";
  abn: string;
  /** "Active" or "Cancelled", as the register says it. */
  status: string;
  statusFrom: string | null;
  entityType: string | null;
  legalName: string;
  /** Given and family name only, for a sole trader. Null for a company or trust. */
  personName: string | null;
  businessNames: string[];
  gstFrom: string | null;
  gstTo: string | null;
  state: string | null;
  postcode: string | null;
};

export type AbnResult =
  | AbnFound
  | { kind: "not_found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "error"; message: string };

/** Digits only. */
export function abnDigits(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

/** "82 651 012 001" for an 11 digit ABN, otherwise what was typed, trimmed. */
export function formatAbn(value: string | null | undefined) {
  const d = abnDigits(value);
  if (d.length !== 11) return (value ?? "").trim() || null;
  return `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
}

/** The ATO check digit rule: take 1 off the first digit, weight, sum, divisible by 89. */
export function abnChecksumOk(value: string | null | undefined) {
  const d = abnDigits(value);
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += (Number(d[i]) - (i === 0 ? 1 : 0)) * w[i]!;
  return sum % 89 === 0;
}

/* A small reader for this one response. It has no attributes we need and no
 * prefixes on its own elements, so a tag match is enough. */
const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();

function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!);
  return out;
}

function first(xml: string | undefined, ...path: string[]): string | null {
  let cur: string | undefined = xml;
  for (const tag of path) {
    if (cur == null) return null;
    cur = blocks(cur, tag)[0];
  }
  if (cur == null) return null;
  const v = decode(cur);
  return v || null;
}

/** The register writes 0001-01-01 for "no date". */
const day = (v: string | null) => (v && !v.startsWith("0001-01-01") ? v.slice(0, 10) : null);

/** Exported for tests: turns the register's XML into a result. */
export function parseAbrXml(xml: string): AbnResult {
  const response = blocks(xml, "response")[0];
  if (!response) return { kind: "error", message: "The ABN register sent back something unreadable." };
  const exception = first(response, "exception", "exceptionDescription");
  if (exception) {
    const low = exception.toLowerCase();
    if (low.includes("not a valid")) return { kind: "invalid", message: exception };
    if (low.includes("no records") || low.includes("not found") || low.includes("no record")) return { kind: "not_found", message: exception };
    return { kind: "error", message: exception };
  }
  const be = blocks(response, "businessEntity202001")[0];
  if (!be) return { kind: "not_found", message: "No record of this ABN on the register." };

  const org = first(be, "mainName", "organisationName");
  const given = first(be, "legalName", "givenName");
  const other = first(be, "legalName", "otherGivenName");
  const family = first(be, "legalName", "familyName");
  const personName = !org && (given || family) ? [given, family].filter(Boolean).join(" ") : null;
  const legalName = org ?? [given, other, family].filter(Boolean).join(" ");

  const names = [
    ...blocks(be, "businessName").map((b) => first(b, "organisationName")),
    ...blocks(be, "mainTradingName").map((b) => first(b, "organisationName")),
    ...blocks(be, "otherTradingName").map((b) => first(b, "organisationName")),
  ].filter((n): n is string => !!n);
  const seen = new Set<string>();
  const businessNames = names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const gstBlock = blocks(be, "goodsAndServicesTax")[0];
  return {
    kind: "found",
    abn: first(be, "ABN", "identifierValue") ?? "",
    status: first(be, "entityStatus", "entityStatusCode") ?? "",
    statusFrom: day(first(be, "entityStatus", "effectiveFrom")),
    entityType: first(be, "entityType", "entityDescription"),
    legalName,
    personName,
    businessNames,
    gstFrom: gstBlock ? day(first(gstBlock, "effectiveFrom")) : null,
    gstTo: gstBlock ? day(first(gstBlock, "effectiveTo")) : null,
    state: first(be, "mainBusinessPhysicalAddress", "stateCode"),
    postcode: first(be, "mainBusinessPhysicalAddress", "postcode"),
  };
}

/** Look one ABN up. Never throws. */
export async function lookupAbn(value: string): Promise<AbnResult> {
  const digits = abnDigits(value);
  if (!abnChecksumOk(digits)) return { kind: "invalid", message: "That is not a valid ABN. It needs 11 digits that pass the ABN check." };
  const guid = (process.env.ABR_GUID ?? "").trim();
  if (!guid) return { kind: "error", message: "ABN Lookup is not set up on this server (no ABR key)." };
  const scrub = (s: string) => s.split(guid).join("[key]");
  const url = `${ENDPOINT}?${new URLSearchParams({ searchString: digits, includeHistoricalDetails: "N", authenticationGuid: guid })}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { kind: "error", message: `The ABN register answered ${res.status}. Try again later.` };
    const result = parseAbrXml(await res.text());
    return "message" in result ? { ...result, message: scrub(result.message) } : result;
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") return { kind: "error", message: "The ABN register did not answer in time. Try again later." };
    return { kind: "error", message: scrub(`Could not reach the ABN register: ${(e as Error)?.message ?? String(e)}`) };
  }
}
