import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Extraction } from "../agent/extract";
import { findCandidates, type Candidate } from "./memo-context";

/**
 * Who a voice quote is for. Same matcher as voice memos, so a mis-heard name
 * still finds its closest few, but a quote only attaches someone on its own
 * when the match is strong. Anything less shows "Customer not found" on the
 * quote with the closest matches and a new client form, filled in from what
 * Damien said.
 */

export interface SpokenCustomer {
  name: string | null;
  firstName: string;
  lastName: string;
  mobile: string | null;
  email: string | null;
  address: string | null;
  suburb: string | null;
  isNew: boolean;
}

const tidy = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** "Jane Doe" to Jane / Doe. A company-ish name stays whole in first name. */
function splitName(name: string | null) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

/** Older recordings kept the phone and email only in the words. */
function fromWords(transcript: string) {
  const email = transcript.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0] ?? null;
  const mobile = transcript.replace(/(\d)[\s-](?=\d)/g, "$1").match(/(?:\+?61|0)4\d{8}/)?.[0] ?? null;
  return { email, mobile };
}

export function spokenCustomer(extraction: Partial<Extraction> | null, transcript: string | null): SpokenCustomer {
  const e = (extraction ?? {}) as Partial<Extraction>;
  const words = fromWords(transcript ?? "");
  const name = tidy(e.customerSpokenName);
  return {
    name,
    ...splitName(name),
    mobile: tidy(e.customerMobile)?.replace(/[^\d+]/g, "") || words.mobile,
    email: tidy(e.customerEmail)?.toLowerCase() ?? words.email,
    address: tidy(e.customerAddress),
    suburb: tidy(e.customerSuburb),
    isNew: Boolean(e.customerIsNew) || /\bnew (client|customer)\b/i.test(transcript ?? ""),
  };
}

export async function customerCandidates(s: SpokenCustomer): Promise<Candidate[]> {
  if (!s.name && !s.mobile && !s.email) return [];
  const { list } = await findCandidates({
    personNames: s.name ? [s.name] : [],
    companyNames: [],
    phoneNumbers: s.mobile ? [s.mobile] : [],
    emails: s.email ? [s.email] : [],
    jobNumbers: [],
    suburbs: s.suburb ? [s.suburb] : [],
  });
  return list;
}

/**
 * The one client to attach without asking, or null. Their phone or email
 * matching is enough. A name alone has to be a full, exact, clear winner,
 * and never when he said it is a new client.
 */
export function strongMatch(s: SpokenCustomer, list: Candidate[]): Candidate | null {
  const [top, next] = list;
  if (!top) return null;
  if (top.score >= 10) return top;
  if (s.isNew) return null;
  const fullExact = Boolean(s.lastName) && top.name.toLowerCase() === (s.name ?? "").toLowerCase();
  if (fullExact && top.score >= 6 && (!next || next.score < top.score)) return top;
  return null;
}

/** What he said about the customer on the recording that made this quote. */
export async function spokenForQuote(quoteId: number) {
  const [row] = await db
    .select({ extractedJson: schema.voiceQuoteCaptures.extractedJson, transcript: schema.voiceQuoteCaptures.transcript })
    .from(schema.voiceQuoteCaptures)
    .where(eq(schema.voiceQuoteCaptures.quoteId, quoteId))
    .orderBy(desc(schema.voiceQuoteCaptures.id))
    .limit(1);
  if (!row) return null;
  let parsed: (Partial<Extraction> & { kind?: string }) | null = null;
  try {
    parsed = row.extractedJson ? JSON.parse(row.extractedJson) : null;
  } catch {
    parsed = null;
  }
  // A voice memo stores its plan here, not a quote extraction. Its client
  // was settled in the memo, so only the words are worth reading.
  if (parsed?.kind === "memo") parsed = null;
  return spokenCustomer(parsed, row.transcript);
}

/** The note line a voice quote leaves when nobody matched. */
export const UNMATCHED_NOTE = /^Damien said the customer's name as "[^"]*", no matching contact or company was found\. Attach the right one before sending\.\n*/m;
/** The phone and email line written beside it, also spent once someone is on the quote. */
export const SAID_DETAILS_NOTE = /^Customer details said: [^\n]*\n*/m;
