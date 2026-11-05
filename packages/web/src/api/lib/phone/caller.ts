import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { phoneKey, emailKey } from "../contact-merge";
import { jobText } from "../refs";
import { localDate, todayLocal } from "../local-date";
import { quoteRefOf } from "../quote-number";

/* ---------------------------------------------------------------------------
 * Who is calling, and what they may hear (Retell, 5 Nov).
 *
 * Two separate checks, never one:
 *   - match: the caller ID is on one or more cards. That only narrows the
 *     search. It never unlocks anything, because numbers are shared (a
 *     couple, an office line) and can be spoofed.
 *   - verify: the caller gives their surname plus something only the
 *     customer knows (the site's street, the email on file, or a job number).
 *     With no caller-ID match they need two of those.
 * Everything read out is customer-facing: no costs, margins, crew pay, staff
 * details, or anyone else's records.
 * ------------------------------------------------------------------------- */

export const MAX_VERIFY_ATTEMPTS = 3;

export type CallRow = typeof schema.phoneCalls.$inferSelect;

/** Active cards whose mobile or phone is this number. */
export async function contactsByNumber(number: string | null | undefined) {
  const key = phoneKey(number);
  if (!key) return [];
  const rows = await db
    .select({ id: schema.contacts.id, mobile: schema.contacts.mobile, phone: schema.contacts.phone })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.active, true), or(sql`${schema.contacts.mobile} like ${"%" + key.slice(-8)}`, sql`${schema.contacts.phone} like ${"%" + key.slice(-8)}`, sql`replace(${schema.contacts.mobile}, ' ', '') like ${"%" + key.slice(-8)}`, sql`replace(${schema.contacts.phone}, ' ', '') like ${"%" + key.slice(-8)}`)));
  return rows.filter((r) => phoneKey(r.mobile) === key || phoneKey(r.phone) === key).map((r) => r.id);
}

/** Jobs a person is on: the customer, the bill-to, or a person on the job. Merged-away jobs are left out. */
export async function jobIdsFor(contactId: number): Promise<number[]> {
  const linked = await db.select({ jobId: schema.jobContacts.jobId }).from(schema.jobContacts).where(eq(schema.jobContacts.contactId, contactId));
  const own = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(or(eq(schema.jobs.contactId, contactId), eq(schema.jobs.billToContactId, contactId)), isNull(schema.jobs.mergedIntoJobId)));
  const ids = [...new Set([...own.map((r) => r.id), ...linked.map((r) => r.jobId)])];
  if (!ids.length) return [];
  const live = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(inArray(schema.jobs.id, ids), isNull(schema.jobs.mergedIntoJobId)));
  return live.map((r) => r.id);
}

export async function contactOnJob(contactId: number, jobId: number) {
  return (await jobIdsFor(contactId)).includes(jobId);
}

/** "4283", "#4283", "job 188 001", "R188000-1" to the job. */
export async function jobByRef(ref: string | number | null | undefined) {
  const raw = String(ref ?? "").trim().replace(/^#|^job\s*/i, "").replace(/\s+/g, "");
  if (!raw) return null;
  const [byDisplay] = await db.select().from(schema.jobs).where(sql`upper(${schema.jobs.displayNumber}) = ${raw.toUpperCase()}`).limit(1);
  if (byDisplay) return byDisplay;
  if (!/^\d+$/.test(raw)) return null;
  const [row] = await db.select().from(schema.jobs).where(eq(schema.jobs.number, Number(raw))).limit(1);
  return row ?? null;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "12 Smith St" against "12 Smith Street, Robina": same number and same first word of the street. */
export function streetMatches(said: string, onFile: string | null | undefined) {
  const a = norm(said).split(" ");
  const b = norm(onFile).split(" ");
  const num = (w: string[]) => w.find((x) => /^\d+[a-z]?$/.test(x));
  const n1 = num(a);
  const n2 = num(b);
  if (!n1 || !n2 || n1 !== n2) return false;
  const after = (w: string[], n: string) => w[w.indexOf(n) + 1] ?? "";
  const s1 = after(a, n1);
  const s2 = after(b, n2);
  return s1.length >= 3 && s1 === s2;
}

export type VerifyInput = { lastName: string; firstName?: string | null; street?: string | null; email?: string | null; jobRef?: string | null };

/**
 * Checks what the caller said. Returns the one card it proves, or why not.
 * `candidates` are the caller-ID matches; empty means withheld or unknown.
 */
export async function checkIdentity(candidates: number[], v: VerifyInput) {
  const last = norm(v.lastName);
  if (last.length < 2) return { ok: false as const, reason: "surname needed" };
  const pool = candidates.length
    ? await db.select().from(schema.contacts).where(and(inArray(schema.contacts.id, candidates), eq(schema.contacts.active, true)))
    : await db.select().from(schema.contacts).where(and(eq(schema.contacts.active, true), sql`lower(trim(${schema.contacts.lastName})) = ${last}`)).limit(50);
  const byName = pool.filter((c) => norm(c.lastName) === last && (!v.firstName || !norm(c.firstName) || norm(c.firstName).split(" ")[0] === norm(v.firstName).split(" ")[0]));
  const need = candidates.length ? 1 : 2;
  const passed: Array<{ contact: (typeof pool)[number]; factors: string[] }> = [];
  for (const c of byName) {
    const factors: string[] = [];
    const jobIds = await jobIdsFor(c.id);
    if (v.email && emailKey(v.email) && emailKey(v.email) === emailKey(c.email)) factors.push("email on file");
    if (v.street) {
      const sites = jobIds.length
        ? await db
            .select({ address: schema.sites.address })
            .from(schema.sites)
            .innerJoin(schema.jobs, eq(schema.jobs.siteId, schema.sites.id))
            .where(inArray(schema.jobs.id, jobIds))
        : [];
      const own = await db.select({ address: schema.sites.address }).from(schema.sites).where(eq(schema.sites.contactId, c.id));
      if ([...sites, ...own, { address: c.address }].some((s) => streetMatches(v.street!, s.address))) factors.push("site address");
    }
    if (v.jobRef) {
      const j = await jobByRef(v.jobRef);
      if (j && jobIds.includes(j.id)) factors.push("job number");
    }
    if (factors.length >= need) passed.push({ contact: c, factors });
  }
  if (passed.length === 1) {
    const p = passed[0]!;
    return { ok: true as const, contact: p.contact, method: `${candidates.length ? "caller ID + " : ""}surname + ${p.factors.join(" + ")}` };
  }
  if (passed.length > 1) return { ok: false as const, reason: "more than one person matches" };
  return { ok: false as const, reason: "details did not match" };
}

/** The caller's jobs, said the way they would recognise them. Nothing internal. */
export async function jobsForCaller(contactId: number) {
  const ids = await jobIdsFor(contactId);
  if (!ids.length) return [];
  const rows = await db
    .select({ job: schema.jobs, status: schema.jobStatuses.name, stage: schema.jobStatuses.stage, suburb: schema.sites.suburb, address: schema.sites.address })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(inArray(schema.jobs.id, ids))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(10);
  return rows.map((r) => ({
    job_ref: jobText(r.job),
    what: r.job.title || "Flooring job",
    where: r.address ? `${r.address}${r.suburb && !r.address.includes(r.suburb) ? `, ${r.suburb}` : ""}` : r.suburb || "",
    status: r.status ?? "",
  }));
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The issued quotes a caller could mean: sent, not past its valid-until, not replaced. */
export async function currentQuotes(jobId: number) {
  const rows = await db.select().from(schema.quotes).where(and(eq(schema.quotes.jobId, jobId), ne(schema.quotes.status, "draft"))).orderBy(desc(schema.quotes.id));
  const today = todayLocal();
  const issued = rows.filter((q) => q.status === "sent" && (!q.validUntil || localDate(q.validUntil as unknown as Date) >= today));
  return { all: rows, issued };
}

/** What the agent may tell a verified customer about their job. */
export async function jobSummary(jobId: number) {
  const [row] = await db
    .select({ job: schema.jobs, status: schema.jobStatuses.name, address: schema.sites.address, suburb: schema.sites.suburb })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobs.id, jobId));
  if (!row) return null;
  const today = todayLocal();
  const tasks = await db
    .select({ id: schema.jobTasks.id, title: schema.jobTasks.title, status: schema.jobTasks.status, startTime: schema.jobTasks.startTime, scheduledDate: schema.jobTasks.scheduledDate })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  const days = tasks.length
    ? await db.select().from(schema.taskDays).where(and(inArray(schema.taskDays.taskId, tasks.map((t) => t.id)), sql`${schema.taskDays.date} >= ${today}`, ne(schema.taskDays.status, "cancelled")))
    : [];
  const visits = days
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6)
    .map((d) => {
      const t = tasks.find((x) => x.id === d.taskId)!;
      return { what: t.title, date: d.date, arrival: d.coordinate ? "time to be arranged with you" : [d.arrivalStart, d.arrivalEnd].filter(Boolean).join(" to ") || "time to be confirmed" };
    });
  const unbooked = tasks.filter((t) => (t.status === "unassigned" || t.status === "offered") && !days.some((d) => d.taskId === t.id)).map((t) => t.title);
  const { issued, all } = await currentQuotes(jobId);
  const quotes = await Promise.all(
    all.slice(0, 4).map(async (q) => ({
      ref: await quoteRefOf(q),
      status: q.status === "sent" ? (issued.some((i) => i.id === q.id) ? "issued, waiting for your OK" : "expired") : q.status,
      total_inc_gst: money(q.total),
      valid_until: q.validUntil ? localDate(q.validUntil as unknown as Date) : null,
    })),
  );
  const invs = await db
    .select({ number: schema.invoices.number, total: schema.invoices.total, paid: schema.invoices.amountPaid, status: schema.invoices.status, due: schema.invoices.dueDate })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, jobId), inArray(schema.invoices.status, ["sent", "part_paid", "overdue", "paid"])));
  return {
    job_ref: jobText(row.job),
    what: row.job.title || "Flooring job",
    where: row.address ?? row.suburb ?? "",
    status: row.status ?? "",
    booked_visits: visits,
    not_yet_booked: unbooked,
    quotes,
    invoices: invs.map((i) => ({ ref: i.number, total: money(i.total), still_to_pay: money(Math.max(0, i.total - i.paid)), status: i.status, due: i.due ? localDate(i.due) : null })),
  };
}
