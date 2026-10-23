import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { CLIENT_TYPES, LEAD_AUTOREPLY_KEY, LEGACY_SOURCE_NAMES, REPORT_EXCLUDED_JOB_NUMBERS, TEST_LEAD_TAG_LIKE, UNKNOWN_SOURCE, isTestJob, clientTypeLabel, sourceName } from "../lib/lead-codes";
import { readLeadFields, takeLead } from "../lib/lead-intake";
import { TERRA_TZ } from "../lib/local-date";
import { OPS_URL } from "../lib/notify";
import { bad } from "../lib/variations";

/* ---------------------------------------------------------------------------
 * Lead sources, landing pages, ad spend and the leads report (spec 14 Oct,
 * Part A, notes 18.38). The form posts themselves come in through
 * POST /api/leads/<form key> in index.ts and lib/lead-intake.ts.
 *
 * Everything here is Admin only, bar `sources`, which every New job and
 * quote screen reads for its picker.
 * ------------------------------------------------------------------------- */

const clientTypeEnum = z.enum(CLIENT_TYPES.map(([k]) => k) as [string, ...string[]]);
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateRe = /^\d{4}-\d{2}-\d{2}$/;

const monthFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TERRA_TZ, year: "numeric", month: "2-digit" });
/** YYYY-MM in Brisbane time. */
const monthOf = (d: Date) => monthFmt.format(d).slice(0, 7);
/** Start of a Brisbane day (UTC+10, no daylight saving). */
const dayStart = (ymd: string) => new Date(`${ymd}T00:00:00+10:00`);
const dayEnd = (ymd: string) => new Date(`${ymd}T23:59:59.999+10:00`);

const tagsOf = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim()) : [];
  } catch {
    return [];
  }
};

const cents = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------ the job facts ------------------------------ */

type LeadJob = {
  id: number;
  number: number;
  displayNumber: string | null;
  title: string;
  source: string;
  clientType: string;
  landingPageId: number | null;
  createdAt: Date;
  month: string;
  statusName: string;
  quoteSent: boolean;
  won: boolean;
  wonValue: number;
  paidValue: number;
  contactName: string;
  companyName: string;
};

const WON_STAGES = new Set(["won", "scheduled", "active", "complete"]);

/** A company type read as a client type, for jobs that did not come in on a page. */
function clientTypeFromCompany(type: string | null | undefined) {
  if (type === "builder") return "builder";
  if (type && type !== "other") return "commercial";
  return "homeowner";
}

/**
 * Every job the report counts in the range, with what happened to it. Small
 * enough to do in memory: a few thousand jobs.
 */
async function leadJobs(range: { from?: string; to?: string; clientType?: string; source?: string }) {
  // A merged job (notes 18.48) is not a lead of its own: it counts once, on the job it went into.
  const where = [isNull(schema.jobs.parentJobId), isNull(schema.jobs.mergedIntoJobId)];
  if (range.from) where.push(gte(schema.jobs.createdAt, dayStart(range.from)));
  if (range.to) where.push(lte(schema.jobs.createdAt, dayEnd(range.to)));
  const rows = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      displayNumber: schema.jobs.displayNumber,
      title: schema.jobs.title,
      source: schema.jobs.source,
      tags: schema.jobs.tags,
      value: schema.jobs.value,
      landingPageId: schema.jobs.landingPageId,
      createdAt: schema.jobs.createdAt,
      statusName: schema.jobStatuses.name,
      stage: schema.jobStatuses.stage,
      pageClientType: schema.landingPages.clientType,
      companyType: schema.companies.type,
      companyName: schema.companies.name,
      firstName: schema.contacts.firstName,
      lastName: schema.contacts.lastName,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.landingPages, eq(schema.landingPages.id, schema.jobs.landingPageId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
    .where(and(...where));

  const excluded = new Set(REPORT_EXCLUDED_JOB_NUMBERS);
  const jobs = rows.filter((r) => !excluded.has(r.number) && !isTestJob(r));
  const ids = jobs.map((j) => j.id);

  const quotes = new Map<number, { sent: boolean; accepted: number }>();
  const paid = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const qs = await db
      .select({ jobId: schema.quotes.jobId, status: schema.quotes.status, sentAt: schema.quotes.sentAt, total: schema.quotes.total })
      .from(schema.quotes)
      .where(inArray(schema.quotes.jobId, chunk));
    for (const q of qs) {
      if (q.jobId == null) continue;
      const cur = quotes.get(q.jobId) ?? { sent: false, accepted: 0 };
      if (q.sentAt || q.status === "sent" || q.status === "accepted") cur.sent = true;
      if (q.status === "accepted") cur.accepted += q.total ?? 0;
      quotes.set(q.jobId, cur);
    }
    const inv = await db
      .select({ jobId: schema.invoices.jobId, paid: sql<number>`coalesce(sum(${schema.invoices.amountPaid}), 0)` })
      .from(schema.invoices)
      .where(and(inArray(schema.invoices.jobId, chunk), isNull(schema.invoices.voidedAt)))
      .groupBy(schema.invoices.jobId);
    for (const r of inv) if (r.jobId != null) paid.set(r.jobId, Number(r.paid) || 0);
  }

  const out: LeadJob[] = [];
  for (const j of jobs) {
    const q = quotes.get(j.id);
    const cancelled = (j.statusName ?? "").toLowerCase() === "cancelled";
    const isPaidStage = (j.statusName ?? "").toLowerCase() === "paid";
    const won = !cancelled && ((q?.accepted ?? 0) > 0 || WON_STAGES.has(j.stage ?? "") || isPaidStage);
    const wonValue = won ? cents(q?.accepted ? q.accepted : j.value ?? 0) : 0;
    const invoicePaid = paid.get(j.id);
    const paidValue = cents(invoicePaid != null && invoicePaid > 0 ? invoicePaid : isPaidStage ? wonValue : 0);
    const clientType = j.pageClientType || clientTypeFromCompany(j.companyType);
    const source = sourceName(j.source);
    if (range.clientType && clientType !== range.clientType) continue;
    if (range.source && source !== range.source) continue;
    out.push({
      id: j.id,
      number: j.number,
      displayNumber: j.displayNumber,
      title: j.title,
      source,
      clientType,
      landingPageId: j.landingPageId,
      createdAt: j.createdAt,
      month: monthOf(j.createdAt),
      statusName: j.statusName ?? "",
      quoteSent: !!q?.sent || won,
      won,
      wonValue,
      paidValue,
      contactName: `${j.firstName ?? ""} ${j.lastName ?? ""}`.trim(),
      companyName: j.companyName ?? "",
    });
  }
  return out;
}

type Tally = { leads: number; quotesSent: number; won: number; wonValue: number; paidValue: number };
const blank = (): Tally => ({ leads: 0, quotesSent: 0, won: 0, wonValue: 0, paidValue: 0 });
function add(t: Tally, j: LeadJob) {
  t.leads++;
  if (j.quoteSent) t.quotesSent++;
  if (j.won) t.won++;
  t.wonValue = cents(t.wonValue + j.wonValue);
  t.paidValue = cents(t.paidValue + j.paidValue);
}
/** Win rate on the leads that got a quote, as a whole percent. */
const winRate = (t: Tally) => (t.quotesSent ? Math.round((t.won / t.quotesSent) * 100) : 0);

/** Ad spend per source and month, from the per page figures. */
async function spendBySource(fromMonth?: string, toMonth?: string) {
  const where = [];
  if (fromMonth) where.push(gte(schema.adSpend.month, fromMonth));
  if (toMonth) where.push(lte(schema.adSpend.month, toMonth));
  const rows = await db
    .select({ month: schema.adSpend.month, amount: schema.adSpend.amount, source: schema.landingPages.leadSource })
    .from(schema.adSpend)
    .innerJoin(schema.landingPages, eq(schema.landingPages.id, schema.adSpend.landingPageId))
    .where(where.length ? and(...where) : undefined);
  const out = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (const r of rows) {
    out.set(r.source, cents((out.get(r.source) ?? 0) + r.amount));
    const k = `${r.source}|${r.month}`;
    byMonth.set(k, cents((byMonth.get(k) ?? 0) + r.amount));
  }
  return { total: out, byMonth };
}

/** What to call the old keys in the list, so a rename finds them too. */
const keysFor = (name: string) => [name, ...Object.entries(LEGACY_SOURCE_NAMES).filter(([, v]) => v === name).map(([k]) => k)];

const sourceInput = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, "Give the source a name").max(80),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

const pageInput = z.object({
  id: z.number().int().optional(),
  url: z
    .string()
    .trim()
    .max(300)
    .transform((v) => v.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()),
  leadSource: z.string().trim().min(1, "Pick a lead source"),
  clientType: clientTypeEnum,
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  followUpOn: z.boolean().default(true),
  formKey: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, "The form key is letters, numbers and dashes only, e.g. medical-gpclinic"),
  conversionLabel: z.string().trim().max(120).default(""),
  timber: z.boolean().default(false),
  active: z.boolean().default(true),
});

const rangeInput = z.object({
  from: z.string().regex(dateRe).optional(),
  to: z.string().regex(dateRe).optional(),
  clientType: clientTypeEnum.optional(),
});

const noArrivals = () => ({ lastAt: null as Date | null, lastOkAt: null as Date | null, lastJobRef: null as string | null, ok30: 0, notThrough30: 0, test30: 0 });

/**
 * What each page has sent us, from lead_submissions: the last post of any
 * kind, the last one that made a job, and the last 30 days. A page that has
 * never sent anything shows that plainly in Settings, Leads.
 */
async function pageArrivals() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({
      formKey: schema.leadSubmissions.formKey,
      lastAt: sql<number | null>`max(${schema.leadSubmissions.createdAt})`,
      lastOkAt: sql<number | null>`max(case when ${schema.leadSubmissions.verdict} in ('ok','released') then ${schema.leadSubmissions.createdAt} end)`,
      ok30: sql<number>`sum(case when ${schema.leadSubmissions.verdict} in ('ok','released') and ${schema.leadSubmissions.createdAt} >= ${Math.floor(since.getTime() / 1000)} then 1 else 0 end)`,
      notThrough30: sql<number>`sum(case when ${schema.leadSubmissions.verdict} in ('spam','failed','held') and ${schema.leadSubmissions.createdAt} >= ${Math.floor(since.getTime() / 1000)} then 1 else 0 end)`,
      test30: sql<number>`sum(case when ${schema.leadSubmissions.verdict} in ('ok','released') and ${schema.leadSubmissions.createdAt} >= ${Math.floor(since.getTime() / 1000)} and coalesce(${schema.jobs.tags}, '') like ${TEST_LEAD_TAG_LIKE} then 1 else 0 end)`,
    })
    .from(schema.leadSubmissions)
    .leftJoin(schema.jobs, eq(schema.jobs.id, schema.leadSubmissions.jobId))
    .groupBy(schema.leadSubmissions.formKey);
  const last = await db
    .select({ formKey: schema.leadSubmissions.formKey, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber })
    .from(schema.leadSubmissions)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.leadSubmissions.jobId))
    .where(inArray(schema.leadSubmissions.verdict, ["ok", "released"]))
    .orderBy(desc(schema.leadSubmissions.id));
  const lastRef = new Map<string, string>();
  for (const r of last) if (!lastRef.has(r.formKey)) lastRef.set(r.formKey, r.displayNumber || String(r.number));
  const toDate = (v: number | null) => (v == null ? null : new Date(Number(v) * 1000));
  return new Map(
    rows.map((r) => [
      r.formKey,
      { lastAt: toDate(r.lastAt), lastOkAt: toDate(r.lastOkAt), lastJobRef: lastRef.get(r.formKey) ?? null, ok30: Number(r.ok30 ?? 0), notThrough30: Number(r.notThrough30 ?? 0), test30: Number(r.test30 ?? 0) },
    ]),
  );
}

/** Posts that did not make a job of their own, shown in Settings, Leads with what can be done. */
const NOT_THROUGH = ["spam", "failed", "held"] as const;

/** A blocked post, read back into what a person would see. */
function blockedView(r: typeof schema.leadSubmissions.$inferSelect) {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(r.raw) as Record<string, unknown>;
  } catch {
    /* kept as sent, even when it is not JSON */
  }
  const lead = readLeadFields(raw);
  return {
    id: r.id,
    formKey: r.formKey,
    verdict: r.verdict,
    reason: r.reason,
    ip: r.ip,
    jobId: r.jobId,
    createdAt: r.createdAt,
    name: lead.name || `${lead.firstName} ${lead.lastName}`.trim(),
    phone: lead.phone,
    email: lead.email,
    message: lead.message.slice(0, 400),
    files: Array.isArray(raw._files) ? (raw._files as unknown[]).length : 0,
    enquiryRef: lead.enquiryRef,
    backfill: lead.backfill,
  };
}

export const leads = {
  /** The active list for the New job and quote pickers. Every staff role. */
  sources: staffOnly.handler(async () => {
    const rows = await db
      .select({ id: schema.leadSources.id, name: schema.leadSources.name })
      .from(schema.leadSources)
      .where(eq(schema.leadSources.active, true))
      .orderBy(asc(schema.leadSources.sortOrder), asc(schema.leadSources.name));
    return rows;
  }),

  /* ------------------------------ Settings, Leads ------------------------------ */

  /** Sources, pages and how many jobs each has, for the Settings tab. */
  settings: adminOnly.handler(async () => {
    const [sources, pages, counts, pageCounts, [autoReply]] = await Promise.all([
      db.select().from(schema.leadSources).orderBy(asc(schema.leadSources.sortOrder), asc(schema.leadSources.name)),
      db.select().from(schema.landingPages).orderBy(asc(schema.landingPages.id)),
      db.select({ source: schema.jobs.source, n: sql<number>`count(*)` }).from(schema.jobs).groupBy(schema.jobs.source),
      db
        .select({ id: schema.jobs.landingPageId, n: sql<number>`count(*)` })
        .from(schema.jobs)
        .where(sql`${schema.jobs.landingPageId} is not null`)
        .groupBy(schema.jobs.landingPageId),
      db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, LEAD_AUTOREPLY_KEY)),
    ]);
    const arrivals = await pageArrivals();
    const bySource = new Map<string, number>();
    for (const c of counts) {
      const name = sourceName(c.source);
      bySource.set(name, (bySource.get(name) ?? 0) + Number(c.n));
    }
    const byPage = new Map(pageCounts.map((c) => [c.id, Number(c.n)]));
    const known = new Set(sources.map((s) => s.name));
    return {
      sources: sources.map((s) => ({ ...s, jobs: bySource.get(s.name) ?? 0 })),
      /** Sources on jobs that are not in the list (old keys like "callback"). */
      strays: [...bySource.entries()].filter(([n]) => !known.has(n)).map(([name, jobs]) => ({ name, jobs })),
      pages: pages.map((p) => ({ ...p, tags: tagsOf(p.tags), jobs: byPage.get(p.id) ?? 0, postTo: `/api/leads/${p.formKey}`, arrivals: arrivals.get(p.formKey) ?? noArrivals() })),
      clientTypes: CLIENT_TYPES.map(([value, label]) => ({ value, label })),
      autoReply: autoReply?.value === "1",
      siteUrl: OPS_URL,
    };
  }),

  /** The thank you email to the client on a new lead. Off unless switched on here. */
  saveAutoReply: adminOnly.input(z.object({ on: z.boolean() })).handler(async ({ input }) => {
    const now = new Date();
    const value = input.on ? "1" : "0";
    await db
      .insert(schema.settings)
      .values({ key: LEAD_AUTOREPLY_KEY, value, updatedAt: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
    return { on: input.on };
  }),

  /** Add or change a source. A rename moves its jobs, contacts and pages with it. */
  saveSource: adminOnly.input(sourceInput).handler(async ({ input }) => {
    const now = new Date();
    const [clash] = await db
      .select({ id: schema.leadSources.id })
      .from(schema.leadSources)
      .where(sql`lower(trim(${schema.leadSources.name})) = ${input.name.toLowerCase()}`);
    if (clash && clash.id !== input.id) throw bad(`"${input.name}" is already in the list.`);
    if (!input.id) {
      const [row] = await db
        .insert(schema.leadSources)
        .values({ name: input.name, active: input.active, sortOrder: input.sortOrder, createdAt: now, updatedAt: now })
        .returning();
      return { ...row!, moved: 0 };
    }
    const [cur] = await db.select().from(schema.leadSources).where(eq(schema.leadSources.id, input.id));
    if (!cur) throw bad("That source is not in the list any more.");
    if (cur.name === UNKNOWN_SOURCE && input.name !== UNKNOWN_SOURCE) throw bad(`"${UNKNOWN_SOURCE}" is what old jobs read as, so it keeps its name.`);
    let moved = 0;
    if (cur.name !== input.name) {
      const keys = keysFor(cur.name);
      const res = await db.update(schema.jobs).set({ source: input.name, updatedAt: now }).where(inArray(schema.jobs.source, keys)).returning({ id: schema.jobs.id });
      moved = res.length;
      await db.update(schema.contacts).set({ source: input.name, updatedAt: now }).where(inArray(schema.contacts.source, keys));
      await db.update(schema.landingPages).set({ leadSource: input.name, updatedAt: now }).where(eq(schema.landingPages.leadSource, cur.name));
    }
    const [row] = await db
      .update(schema.leadSources)
      .set({ name: input.name, active: input.active, sortOrder: input.sortOrder, updatedAt: now })
      .where(eq(schema.leadSources.id, input.id))
      .returning();
    return { ...row!, moved };
  }),

  /** Add or change a landing page. This is all a new page needs on the Terra side. */
  savePage: adminOnly.input(pageInput).handler(async ({ input }) => {
    const now = new Date();
    const [src] = await db.select({ id: schema.leadSources.id }).from(schema.leadSources).where(eq(schema.leadSources.name, input.leadSource));
    if (!src) throw bad("Pick a lead source from the list. Add it under Lead sources first if it is new.");
    const [clash] = await db.select({ id: schema.landingPages.id }).from(schema.landingPages).where(eq(schema.landingPages.formKey, input.formKey));
    if (clash && clash.id !== input.id) throw bad(`Another page already uses the form key "${input.formKey}".`);
    const tags = [...new Set(input.timber && !input.tags.includes("Timber repair") ? [...input.tags, "Timber repair"] : input.tags)];
    const values = {
      url: input.url,
      leadSource: input.leadSource,
      clientType: input.clientType,
      tags: JSON.stringify(tags),
      followUpOn: input.followUpOn,
      formKey: input.formKey,
      conversionLabel: input.conversionLabel,
      timber: input.timber,
      active: input.active,
      updatedAt: now,
    };
    if (input.id) {
      const [row] = await db.update(schema.landingPages).set(values).where(eq(schema.landingPages.id, input.id)).returning();
      if (!row) throw bad("That page is not in the list any more.");
      return { ...row, tags: tagsOf(row.tags) };
    }
    const [row] = await db.insert(schema.landingPages).values({ ...values, createdAt: now }).returning();
    return { ...row!, tags: tagsOf(row!.tags) };
  }),

  /** Blocked form posts, newest first, so a real lead caught as spam can be let through. */
  blocked: adminOnly.input(z.object({ limit: z.number().int().min(1).max(500).default(100) }).default({ limit: 100 })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(schema.leadSubmissions)
      .where(inArray(schema.leadSubmissions.verdict, [...NOT_THROUGH, "released"]))
      .orderBy(desc(schema.leadSubmissions.createdAt), desc(schema.leadSubmissions.id))
      .limit(input.limit);
    const counts = await db
      .select({ verdict: schema.leadSubmissions.verdict, n: sql<number>`count(*)` })
      .from(schema.leadSubmissions)
      .where(inArray(schema.leadSubmissions.verdict, [...NOT_THROUGH]))
      .groupBy(schema.leadSubmissions.verdict);
    const n = (v: string) => Number(counts.find((c) => c.verdict === v)?.n ?? 0);
    const refs = new Map<number, string>();
    const ids = [...new Set(rows.map((r) => r.jobId).filter((x): x is number => x != null))];
    if (ids.length) {
      for (const j of await db.select({ id: schema.jobs.id, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(inArray(schema.jobs.id, ids)))
        refs.set(j.id, j.displayNumber || String(j.number));
    }
    return { rows: rows.map((r) => ({ ...blockedView(r), jobRef: r.jobId ? (refs.get(r.jobId) ?? null) : null })), spam: n("spam"), failed: n("failed"), held: n("held") };
  }),

  /**
   * Let a post through: it makes its job now, the same way a good one does.
   * Works on a blocked post, a held one (a possible hand keyed match) and a
   * failed one that made no job. Photo files are not kept on these; photo links are fetched again.
   */
  release: adminOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const [row] = await db.select().from(schema.leadSubmissions).where(eq(schema.leadSubmissions.id, input.id));
    if (!row) throw bad("That form post is not there any more.");
    if (!(NOT_THROUGH as readonly string[]).includes(row.verdict)) throw bad("Only a blocked, held or failed post can be let through.");
    if (row.verdict === "failed" && row.jobId) throw bad("That post already made a job. Open the job instead.");
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(row.raw) as Record<string, unknown>;
    } catch {
      throw bad("That post could not be read, so it cannot make a job.");
    }
    for (const k of ["_files", "_ua", "_origin", "_connIp"]) delete raw[k];
    const out = await takeLead(row.formKey, raw, [], { ip: row.ip, releaseId: row.id });
    if (out.verdict !== "ok") throw bad("That post did not make a job.");
    return { jobId: out.jobId, jobNumber: out.jobNumber };
  }),

  /* --------------------------------- ad spend --------------------------------- */

  spend: adminOnly.input(z.object({ year: z.number().int().min(2020).max(2100) })).handler(async ({ input }) => {
    const rows = await db
      .select()
      .from(schema.adSpend)
      .where(and(gte(schema.adSpend.month, `${input.year}-01`), lte(schema.adSpend.month, `${input.year}-12`)));
    return rows.map((r) => ({ landingPageId: r.landingPageId, month: r.month, amount: r.amount }));
  }),

  /** One page, one month. 0 clears it. */
  saveSpend: adminOnly
    .input(z.object({ landingPageId: z.number().int(), month: z.string().regex(monthRe, "Month is YYYY-MM"), amount: z.number().min(0).max(1_000_000) }))
    .handler(async ({ input }) => {
      const now = new Date();
      if (!input.amount) {
        await db.delete(schema.adSpend).where(and(eq(schema.adSpend.landingPageId, input.landingPageId), eq(schema.adSpend.month, input.month)));
        return { ok: true };
      }
      await db
        .insert(schema.adSpend)
        .values({ landingPageId: input.landingPageId, month: input.month, amount: cents(input.amount), createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: [schema.adSpend.landingPageId, schema.adSpend.month], set: { amount: cents(input.amount), updatedAt: now } });
      return { ok: true };
    }),

  /* ---------------------------------- report ---------------------------------- */

  /** Leads and money by source, by month, with spend. Admin only. */
  report: adminOnly.input(rangeInput).handler(async ({ input }) => {
    const jobs = await leadJobs(input);
    const fromMonth = input.from?.slice(0, 7);
    const toMonth = input.to?.slice(0, 7);
    const spend = await spendBySource(fromMonth, toMonth);

    const bySource = new Map<string, Tally>();
    const byCell = new Map<string, Tally>();
    const months = new Set<string>();
    const total = blank();
    for (const j of jobs) {
      if (!bySource.has(j.source)) bySource.set(j.source, blank());
      add(bySource.get(j.source)!, j);
      const k = `${j.source}|${j.month}`;
      if (!byCell.has(k)) byCell.set(k, blank());
      add(byCell.get(k)!, j);
      months.add(j.month);
      add(total, j);
    }
    for (const k of spend.byMonth.keys()) months.add(k.split("|")[1]!);
    const monthList = [...months].sort();
    const spendTotal = [...spend.total.values()].reduce((a, b) => a + b, 0);

    const sources = [...new Set([...bySource.keys(), ...spend.total.keys()])].map((name) => {
      const t = bySource.get(name) ?? blank();
      const s = spend.total.get(name) ?? 0;
      return {
        source: name,
        ...t,
        winRate: winRate(t),
        spend: s,
        costPerLead: s && t.leads ? cents(s / t.leads) : null,
        returnPerDollar: s ? cents(t.wonValue / s) : null,
        months: monthList.map((m) => {
          const c = byCell.get(`${name}|${m}`) ?? blank();
          const ms = spend.byMonth.get(`${name}|${m}`) ?? 0;
          return { month: m, ...c, winRate: winRate(c), spend: ms, costPerLead: ms && c.leads ? cents(ms / c.leads) : null };
        }),
      };
    });
    sources.sort((a, b) => b.wonValue - a.wonValue || b.leads - a.leads || a.source.localeCompare(b.source));
    const paidLeads = sources.filter((x) => x.spend > 0).reduce((n, x) => n + x.leads, 0);
    const paidWon = sources.filter((x) => x.spend > 0).reduce((n, x) => n + x.wonValue, 0);

    return {
      months: monthList,
      sources,
      total: {
        ...total,
        winRate: winRate(total),
        spend: cents(spendTotal),
        /* Over the paid sources only: the ad spend against the leads and wins it bought. */
        costPerLead: spendTotal && paidLeads ? cents(spendTotal / paidLeads) : null,
        returnPerDollar: spendTotal ? cents(paidWon / spendTotal) : null,
      },
      clientTypes: CLIENT_TYPES.map(([value, label]) => ({ value, label })),
      excludedJobNumbers: REPORT_EXCLUDED_JOB_NUMBERS,
    };
  }),

  /** One source's jobs in the range, for the click through. */
  drill: adminOnly.input(rangeInput.extend({ source: z.string().min(1), month: z.string().regex(monthRe).optional() })).handler(async ({ input }) => {
    const jobs = (await leadJobs(input)).filter((j) => !input.month || j.month === input.month);
    jobs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return jobs.slice(0, 500).map((j) => ({
      id: j.id,
      number: j.displayNumber || String(j.number),
      title: j.title,
      client: j.companyName || j.contactName,
      clientType: clientTypeLabel(j.clientType),
      createdAt: j.createdAt,
      status: j.statusName,
      quoteSent: j.quoteSent,
      won: j.won,
      wonValue: j.wonValue,
      paidValue: j.paidValue,
    }));
  }),

  /** The Dashboard card: top 3 sources this month by won value. */
  topThisMonth: adminOnly.handler(async () => {
    const month = monthOf(new Date());
    const jobs = (await leadJobs({ from: `${month}-01` })).filter((j) => j.month === month);
    const by = new Map<string, Tally>();
    for (const j of jobs) {
      if (!by.has(j.source)) by.set(j.source, blank());
      add(by.get(j.source)!, j);
    }
    const rows = [...by.entries()]
      .map(([source, t]) => ({ source, leads: t.leads, won: t.won, wonValue: t.wonValue }))
      .sort((a, b) => b.wonValue - a.wonValue || b.leads - a.leads)
      .slice(0, 3);
    return { month, rows, leads: jobs.length };
  }),
};
