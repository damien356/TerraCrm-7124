import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Homeowner or trade?
 *
 * Every marketing rail in this app is written around the split: journeys are
 * homeowner-only, builders can never be enrolled. The original test for it was
 * "does this contact have a job attached to a company", which read correctly
 * and was almost entirely useless against the real data:
 *
 *   1,351 jobs carry a company_id — but with contact_id NULL. ServiceM8 filed
 *   builder work against the company and never against a person, so exactly TWO
 *   of 1,653 contacts were classed as trade by that test.
 *
 * Which meant the reachable pool included shane@repairrebuild.com.au (24
 * completed jobs), a Coronis agent, a Kollosche agent, a shopfitter, a painter
 * and a body corporate manager — all sitting there waiting for a "how are you
 * finding your new floor" review request.
 *
 * So the split is answered by signals instead, and a human decision always
 * beats the signals. `contacts.audienceKind` is that decision: once someone
 * marks a contact homeowner or trade, the heuristic stops guessing about them.
 * ------------------------------------------------------------------------- */

/**
 * Mailbox providers a private person uses. Anything outside this list is a
 * domain somebody bought, which for a flooring customer base means a business
 * far more often than not.
 */
export const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.au",
  "hotmail.co.uk",
  "outlook.com",
  "outlook.com.au",
  "live.com",
  "live.com.au",
  "msn.com",
  "yahoo.com",
  "yahoo.com.au",
  "y7mail.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "bigpond.com",
  "bigpond.net.au",
  "optusnet.com.au",
  "tpg.com.au",
  "iinet.net.au",
  "iinet.com.au",
  "internode.on.net",
  "dodo.com.au",
  "westnet.com.au",
  "ozemail.com.au",
  "exemail.com.au",
  "iprimus.com.au",
  "aapt.net.au",
  "spin.net.au",
  "mail.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "yandex.com",
  "hey.com",
  "fastmail.com",
]);

/** A homeowner may genuinely re-floor twice. Four jobs is a portfolio. */
export const TRADE_JOB_COUNT = 4;

export type AudienceKind = "homeowner" | "trade" | "unknown";

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").trim().toLowerCase().split("@");
  return at.length === 2 && at[1] ? at[1] : null;
}

/** Bought their own domain, so probably a business. Not proof, a signal. */
export function hasBusinessEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return !FREEMAIL_DOMAINS.has(domain);
}

export interface TradeSignals {
  businessEmail: boolean;
  manyJobs: boolean;
  jobCount: number;
  companyJob: boolean;
  companyContact: boolean;
}

export const looksLikeTrade = (s: TradeSignals) =>
  s.businessEmail || s.manyJobs || s.companyJob || s.companyContact;

/** Plain English for the review screen, so a human can judge the guess. */
export function tradeReasons(s: TradeSignals, email?: string | null): string[] {
  const out: string[] = [];
  if (s.businessEmail) out.push(`business email domain (${emailDomain(email) ?? "unknown"})`);
  if (s.manyJobs) out.push(`${s.jobCount} completed jobs`);
  if (s.companyJob) out.push("has a job billed to a company");
  if (s.companyContact) out.push("listed as a contact inside a company");
  return out;
}

/* ---------------------------------------------------------------------------
 * Correlated subqueries
 *
 * Written table-qualified and by hand. Drizzle renders a bare column name when
 * a column reference lands inside a select-list subquery, which SQLite then
 * reads as the OUTER column — "where contact_id = id" against contacts is not
 * ambiguous to SQLite, it is simply wrong, and it fails or silently matches
 * nothing. Qualify both sides and the correlation is unmistakable.
 * ------------------------------------------------------------------------- */

const JOB_COUNT_SQL = sql<number>`(
  select count(*) from jobs
  where jobs.contact_id = contacts.id and jobs.completed_at is not null
)`;

const COMPANY_JOB_SQL = sql<number>`(
  select count(*) from jobs
  where jobs.contact_id = contacts.id and jobs.company_id is not null
)`;

const COMPANY_CONTACT_SQL = sql<number>`(
  select count(*) from company_contacts where company_contacts.contact_id = contacts.id
)`;

/** Signals for one contact, read fresh. */
export async function signalsFor(contactId: number): Promise<TradeSignals> {
  const [row] = await db
    .select({
      email: schema.contacts.email,
      jobCount: JOB_COUNT_SQL,
      companyJob: COMPANY_JOB_SQL,
      companyContact: COMPANY_CONTACT_SQL,
    })
    .from(schema.contacts)
    .where(sql`contacts.id = ${contactId}`);

  const jobCount = Number(row?.jobCount ?? 0);
  return {
    businessEmail: hasBusinessEmail(row?.email),
    manyJobs: jobCount >= TRADE_JOB_COUNT,
    jobCount,
    companyJob: Number(row?.companyJob ?? 0) > 0,
    companyContact: Number(row?.companyContact ?? 0) > 0,
  };
}

/* ---------------------------------------------------------------------------
 * The same test, in SQL
 *
 * Needed for the segment counts, which cannot afford a query per contact. The
 * free-mail list is inlined as a NOT IN, which SQLite handles fine at this size
 * and keeps one definition of "private mailbox" in this file.
 * ------------------------------------------------------------------------- */

const freemailList = sql.join(
  [...FREEMAIL_DOMAINS].map((d) => sql`${d}`),
  sql`, `,
);

/** True when the heuristic thinks this contact is a business. */
export const likelyTradeSql: SQL = sql`(
  (instr(trim(coalesce(contacts.email, '')), '@') > 0
   and lower(substr(trim(coalesce(contacts.email, '')), instr(trim(coalesce(contacts.email, '')), '@') + 1))
       not in (${freemailList}))
  or ${JOB_COUNT_SQL} >= ${TRADE_JOB_COUNT}
  or ${COMPANY_JOB_SQL} > 0
  or ${COMPANY_CONTACT_SQL} > 0
)`;

/**
 * "Treat this contact as a homeowner."
 *
 * A human decision wins outright. Where there is none, the signals decide, and
 * they decide conservatively: an unreviewed business-looking contact is held
 * back rather than mailed. Terra can always let them back in; it cannot unsend.
 */
export const treatAsHomeownerSql: SQL = sql`(
  contacts.audience_kind = 'homeowner'
  or (contacts.audience_kind = 'unknown' and not ${likelyTradeSql})
)`;

/** "Treat this contact as trade." The complement, for a builder segment. */
export const treatAsTradeSql: SQL = sql`(
  contacts.audience_kind = 'trade'
  or (contacts.audience_kind = 'unknown' and ${likelyTradeSql})
)`;

/**
 * The per-contact version, for the journey engine. Reads the stored decision
 * first and only computes signals when there is not one, so the common case is
 * a single row read.
 */
export async function isHomeowner(
  contactId: number,
): Promise<{ homeowner: boolean; decided: boolean; reasons: string[] }> {
  const [row] = await db
    .select({ kind: schema.contacts.audienceKind, email: schema.contacts.email })
    .from(schema.contacts)
    .where(sql`contacts.id = ${contactId}`);

  if (!row) return { homeowner: false, decided: false, reasons: ["contact not found"] };
  if (row.kind === "homeowner") return { homeowner: true, decided: true, reasons: [] };
  if (row.kind === "trade") return { homeowner: false, decided: true, reasons: ["marked as trade"] };

  const signals = await signalsFor(contactId);
  const trade = looksLikeTrade(signals);
  return {
    homeowner: !trade,
    decided: false,
    reasons: trade ? tradeReasons(signals, row.email) : [],
  };
}

/* ---------------------------------------------------------------------------
 * The review queue
 * ------------------------------------------------------------------------- */

export interface TradeReviewRow {
  id: number;
  name: string;
  email: string | null;
  suburb: string | null;
  jobCount: number;
  lastCompletedAt: Date | null;
  reasons: string[];
}

/**
 * Everyone the heuristic is holding back and nobody has ruled on yet, worst
 * first: most completed jobs at the top, because that is where the real trade
 * accounts are. Only contacts who would otherwise be mailable are listed —
 * there is no point reviewing people with no consent basis.
 */
export async function tradeReviewQueue(limit = 200): Promise<TradeReviewRow[]> {
  const rows = await db
    .select({
      id: schema.contacts.id,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
      email: schema.contacts.email,
      suburb: schema.contacts.suburb,
      lastCompletedAt: schema.contacts.lastCompletedAt,
      jobCount: JOB_COUNT_SQL,
      companyJob: COMPANY_JOB_SQL,
      companyContact: COMPANY_CONTACT_SQL,
    })
    .from(schema.contacts)
    .where(
      sql`contacts.active = 1
        and contacts.audience_kind = 'unknown'
        and ${likelyTradeSql}
        and contacts.do_not_market = 0
        and (contacts.marketing_opt_in = 1 or contacts.marketing_basis = 'completed_job')
        and trim(coalesce(contacts.email, '')) != ''`,
    )
    .orderBy(sql`${JOB_COUNT_SQL} desc`)
    .limit(limit);

  return rows.map((r) => {
    const jobCount = Number(r.jobCount);
    const signals: TradeSignals = {
      businessEmail: hasBusinessEmail(r.email),
      manyJobs: jobCount >= TRADE_JOB_COUNT,
      jobCount,
      companyJob: Number(r.companyJob) > 0,
      companyContact: Number(r.companyContact) > 0,
    };
    return {
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      email: r.email,
      suburb: r.suburb,
      jobCount,
      lastCompletedAt: r.lastCompletedAt,
      reasons: tradeReasons(signals, r.email),
    };
  });
}
