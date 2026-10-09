import { desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import type { Mentions } from "../agent/memo";
import { quoteRef } from "../lib/refs";

/* ---------------------------------------------------------------------------
 * What the voice memo router gets to read.
 *
 * In-context memos (recorded on a job or client card) get that client's whole
 * picture as plain text: details, jobs with their dates and status, products,
 * measurements, quotes, recent notes. Global memos get a short list of real
 * candidates found from the names, numbers and suburbs that were said, so the
 * model picks from records that exist rather than inventing a match.
 * ------------------------------------------------------------------------- */

export const TZ = "Australia/Brisbane";

export function nowStrings(now = new Date()) {
  const local = now.toLocaleString("en-AU", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return { nowLocal: `${local} (Gold Coast time)`, nowIso: now.toISOString() };
}

/** "2026-10-01T15:30" said in Gold Coast time, to a real instant. */
export function localToDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = value.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]!.padStart(2, "0")}:${m[3]}:00+10:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sayLocal(d: Date) {
  return d.toLocaleString("en-AU", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`.trim();
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (v: Date | string | null | undefined) => {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return typeof v === "string" ? v : null;
  return d.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
};

type Contact = typeof schema.contacts.$inferSelect;

function contactLines(c: Contact) {
  const lines = [`Client: ${fullName(c)} (contact id ${c.id})`];
  const reach = [c.mobile && `mobile ${c.mobile}`, c.phone && `phone ${c.phone}`, c.email && `email ${c.email}`]
    .filter(Boolean)
    .join(", ");
  lines.push(`Contact: ${reach || "no phone or email on file"}`);
  const addr = [c.address, c.suburb, c.postcode].filter(Boolean).join(", ");
  if (addr) lines.push(`Address: ${addr}`);
  if (c.notes) lines.push(`Notes on file: ${c.notes.slice(0, 400)}`);
  return lines;
}

/** One line per job, with every date the office would quote back to a customer. */
async function jobLines(jobIds: number[]) {
  if (!jobIds.length) return new Map<number, string>();
  const rows = await db
    .select({ job: schema.jobs, status: schema.jobStatuses.name, site: schema.sites })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(inArray(schema.jobs.id, jobIds));
  const tasks = await db
    .select({ task: schema.jobTasks, installer: schema.installers.name })
    .from(schema.jobTasks)
    .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
    .where(inArray(schema.jobTasks.jobId, jobIds));

  const out = new Map<number, string>();
  for (const r of rows) {
    const bits = [`Job id ${r.job.id}, #${r.job.number} "${r.job.title || "untitled"}"`, `status ${r.status ?? "none"}`];
    if (r.job.scheduledStart) bits.push(`install date ${day(r.job.scheduledStart)}`);
    if (r.site) bits.push(`site ${[r.site.address, r.site.suburb].filter(Boolean).join(", ")}`);
    if (r.job.value) bits.push(`value ${money(r.job.value)}`);
    const t = tasks
      .filter((x) => x.task.jobId === r.job.id && x.task.status !== "cancelled")
      .map((x) => {
        const when = x.task.scheduledDate
          ? day(x.task.scheduledDate)
          : x.task.scheduledFrom
            ? `window ${x.task.scheduledFrom} to ${x.task.scheduledTo ?? "?"}`
            : "not booked";
        return `"${x.task.title}" ${x.task.status}${x.installer ? ` with ${x.installer}` : ""}, ${when}`;
      });
    if (t.length) bits.push(`dispatches: ${t.join("; ")}`);
    out.set(r.job.id, bits.join(", "));
  }
  return out;
}

export async function jobsForContact(contactId: number, limit = 8) {
  const rows = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(
      or(
        eq(schema.jobs.contactId, contactId),
        eq(schema.jobs.billToContactId, contactId),
        sql`exists (select 1 from job_contacts jc where jc.job_id = ${schema.jobs.id} and jc.contact_id = ${contactId})`,
      ),
    )
    // Cancelled jobs go to the bottom, so "his latest job" is the newest live one.
    .orderBy(
      sql`exists (select 1 from job_statuses js where js.id = ${schema.jobs.statusId} and lower(js.name) like 'cancel%')`,
      desc(schema.jobs.number),
    )
    .limit(limit);
  return rows.map((r) => r.id);
}

/** Who the customer on a job is: the job's own contact, else its primary person. */
export async function jobCustomer(jobId: number): Promise<Contact | null> {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) return null;
  if (job.contactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId));
    if (c) return c;
  }
  const [link] = await db
    .select({ contact: schema.contacts })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, jobId))
    .orderBy(desc(schema.jobContacts.isPrimary))
    .limit(1);
  return link?.contact ?? null;
}

/**
 * The full picture for a memo recorded on a card. Returns the text block and
 * the customer the memo is about.
 */
export async function buildCardContext(link: { jobId: number | null; contactId: number | null }) {
  let contact: Contact | null = null;
  if (link.contactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, link.contactId));
    contact = c ?? null;
  } else if (link.jobId) {
    contact = await jobCustomer(link.jobId);
  }

  const lines: string[] = [];
  if (link.jobId) lines.push(`Recorded on job id ${link.jobId}. Actions are about this job unless he clearly means another.`);
  else lines.push("Recorded on the client's card.");
  if (contact) lines.push(...contactLines(contact));
  else lines.push("Client: none linked to this job yet.");

  const jobIds = new Set<number>();
  if (link.jobId) jobIds.add(link.jobId);
  if (contact) for (const id of await jobsForContact(contact.id)) jobIds.add(id);
  const jl = await jobLines([...jobIds]);
  if (jl.size) {
    lines.push("Jobs (newest first, cancelled last):");
    const latest = contact ? (await jobsForContact(contact.id, 1))[0] : null;
    for (const id of jobIds) if (jl.has(id)) lines.push(`- ${jl.get(id)}${id === latest ? " (latest job)" : ""}`);
  }

  if (link.jobId) {
    const [materials, areas, notes] = await Promise.all([
      db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, link.jobId)),
      db.select().from(schema.jobAreas).where(eq(schema.jobAreas.jobId, link.jobId)),
      db
        .select()
        .from(schema.activityLog)
        .where(eq(schema.activityLog.jobId, link.jobId))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(12),
    ]);
    if (materials.length)
      lines.push(
        `Products on this job: ${materials.map((m) => `${m.description} ${m.qty} ${m.unit} (${m.status.replace("_", " ")})`).join("; ")}`,
      );
    if (areas.length)
      lines.push(
        `Measurements: ${areas.map((a) => `${a.name}${a.areaM2 != null ? ` ${a.areaM2} m2` : ""}`).join("; ")}`,
      );
    if (notes.length)
      lines.push(`Recent history: ${notes.map((n) => `${day(n.createdAt)} ${n.action}: ${n.detail.slice(0, 160)}`).join(" | ")}`);
  }

  const quotes = contact
    ? await db
        .select()
        .from(schema.quotes)
        .where(link.jobId ? or(eq(schema.quotes.contactId, contact.id), eq(schema.quotes.jobId, link.jobId)) : eq(schema.quotes.contactId, contact.id))
        .orderBy(desc(schema.quotes.number))
        .limit(6)
    : link.jobId
      ? await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, link.jobId)).limit(6)
      : [];
  if (quotes.length)
    lines.push(`Quotes: ${quotes.map((q) => `${quoteRef(q.number, q.version)} ${q.status} ${money(q.total)}`).join("; ")}`);

  if (!link.jobId && contact) {
    const notes = await db
      .select()
      .from(schema.activityLog)
      .where(eq(schema.activityLog.contactId, contact.id))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(8);
    if (notes.length)
      lines.push(`Recent history: ${notes.map((n) => `${day(n.createdAt)} ${n.action}: ${n.detail.slice(0, 160)}`).join(" | ")}`);
  }

  return { text: lines.join("\n"), contact };
}

/* ---------------------------------------------------------------------------
 * Global memos: find who he might mean.
 * ------------------------------------------------------------------------- */

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z' -]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);

function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Letter pairs in common, 0..1. Survives the vowels speech to text swaps about. */
function pairScore(a: string, b: string) {
  const pairs = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  if (!pa.length || !pb.length) return 0;
  const left = [...pb];
  let hit = 0;
  for (const p of pa) {
    const i = left.indexOf(p);
    if (i >= 0) {
      hit++;
      left.splice(i, 1);
    }
  }
  return (2 * hit) / (pa.length + pb.length);
}

/** A rough sound key: c/k/q alike, ph is f, doubled letters and inner vowels gone. */
function soundKey(s: string) {
  const t = s
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/ph/g, "f")
    .replace(/[ckq]/g, "k")
    .replace(/[sz]/g, "s")
    .replace(/(.)\1+/g, "$1");
  return t.slice(0, 1) + t.slice(1).replace(/[aeiouyhw]/g, "");
}

/**
 * How well a spoken name fits a client. Exact name parts count most, then one
 * letter off, then a sounds-alike surname ("Cornobbio" for "Ciobanu": same
 * first sound, shared letter pairs), then a prefix.
 */
function nameScore(spoken: string, c: Pick<Contact, "firstName" | "lastName">) {
  const parts = tokens(`${c.firstName} ${c.lastName}`);
  let score = 0;
  for (const t of tokens(spoken)) {
    if (parts.includes(t)) score += 3;
    else if (t.length >= 4 && parts.some((p) => editDistance(p, t) <= 1)) score += 2;
    else if (t.length >= 4 && fuzzy(t, parts) > 0) score += fuzzy(t, parts);
    else if (t.length >= 3 && parts.some((p) => p.startsWith(t))) score += 1;
  }
  return score;
}

/** 1.2 to 2 for a sounds-alike name part, 0 when nothing is close. */
function fuzzy(t: string, parts: string[]) {
  let best = 0;
  for (const p of parts) {
    if (p.length < 3) continue;
    const pair = pairScore(p, t);
    const ka = soundKey(p);
    const kb = soundKey(t);
    const sameStart = ka[0] === kb[0];
    const close = pair >= 0.5 || (sameStart && pair >= 0.25) || (sameStart && ka.length >= 3 && editDistance(ka, kb) <= 1);
    if (close) best = Math.max(best, Math.min(2, 1.2 + pair));
  }
  return best;
}

/** Every active client's name, kept for a minute. 1,650 rows, scored in code. */
type NameRows = { id: number; firstName: string; lastName: string }[];
/* One per database, so the Play reviewer's demo is matched against demo clients only. */
const nameCaches: Record<"live" | "demo", { at: number; rows: NameRows } | null> = { live: null, demo: null };
async function allNames() {
  const which = inDemo() ? "demo" : "live";
  const nameCache = nameCaches[which];
  if (nameCache && Date.now() - nameCache.at < 60_000) return nameCache.rows;
  const rows = await db
    .select({ id: schema.contacts.id, firstName: schema.contacts.firstName, lastName: schema.contacts.lastName })
    .from(schema.contacts)
    .where(eq(schema.contacts.active, true));
  nameCaches[which] = { at: Date.now(), rows };
  return rows;
}

/** For tests and the rerun path: forget the cached names after a client is added. */
export function forgetNames() {
  nameCaches[inDemo() ? "demo" : "live"] = null;
}

export interface Candidate {
  id: number;
  name: string;
  detail: string;
  score: number;
}

export async function findCandidates(m: Mentions): Promise<{ text: string | null; list: Candidate[] }> {
  const scores = new Map<number, { contact: Contact; score: number; why: string[] }>();
  const bump = (c: Contact, by: number, why: string) => {
    const cur = scores.get(c.id) ?? { contact: c, score: 0, why: [] };
    cur.score += by;
    if (!cur.why.includes(why)) cur.why.push(why);
    scores.set(c.id, cur);
  };

  if (m.personNames.length) {
    // Score every client in code, not with a LIKE: speech to text gets
    // "Ciobanu" as "Cornobbio" and "Nguyen" as "Win", so no prefix would find them.
    const names = await allNames();
    const hits = new Map<number, { score: number; why: string }>();
    for (const name of m.personNames) {
      const said = tokens(name);
      if (!said.length) continue;
      // A surname said on its own only has the sounds-alike score to go on.
      const floor = said.length === 1 && said[0]!.length >= 5 ? 1.45 : 2;
      for (const c of names) {
        const s = nameScore(name, c);
        if (s >= floor && s > (hits.get(c.id)?.score ?? 0)) hits.set(c.id, { score: s, why: `name "${name}"` });
      }
    }
    const best = [...hits.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 60);
    if (best.length) {
      const rows = await db
        .select()
        .from(schema.contacts)
        .where(inArray(schema.contacts.id, best.map(([id]) => id)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const [id, h] of best) {
        const c = byId.get(id);
        if (c) bump(c, h.score, h.why);
      }
    }
  }

  for (const raw of m.phoneNumbers) {
    const d = digits(raw);
    if (d.length < 8) continue;
    const tail = d.slice(-8);
    const rows = await db
      .select()
      .from(schema.contacts)
      .where(
        or(
          like(sql`replace(replace(replace(${schema.contacts.mobile}, ' ', ''), '+61', '0'), '-', '')`, `%${tail}`),
          like(sql`replace(replace(replace(${schema.contacts.phone}, ' ', ''), '+61', '0'), '-', '')`, `%${tail}`),
        ),
      )
      .limit(5);
    for (const c of rows) bump(c, 10, `phone ${raw}`);
  }

  for (const email of m.emails) {
    const rows = await db
      .select()
      .from(schema.contacts)
      .where(eq(sql`lower(${schema.contacts.email})`, email.toLowerCase().trim()))
      .limit(3);
    for (const c of rows) bump(c, 10, `email ${email}`);
  }

  if (m.jobNumbers.length) {
    const jobs = await db.select().from(schema.jobs).where(inArray(schema.jobs.number, m.jobNumbers));
    for (const j of jobs) {
      const c = await jobCustomer(j.id);
      if (c) bump(c, 8, `job #${j.number}`);
    }
  }

  for (const company of m.companyNames) {
    const rows = await db
      .select({ contact: schema.contacts, company: schema.companies.name })
      .from(schema.companies)
      .innerJoin(schema.companyContacts, eq(schema.companyContacts.companyId, schema.companies.id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.companyContacts.contactId))
      .where(like(sql`lower(${schema.companies.name})`, `%${company.toLowerCase().trim()}%`))
      .limit(6);
    for (const r of rows) bump(r.contact, 3, `works at ${r.company}`);
  }

  // A suburb only ever strengthens someone already in the running.
  const suburbs = m.suburbs.map((s) => s.toLowerCase());
  for (const v of scores.values()) {
    const where = `${v.contact.address ?? ""} ${v.contact.suburb ?? ""}`.toLowerCase();
    if (suburbs.some((s) => s && where.includes(s))) {
      v.score += 2;
      v.why.push("same suburb");
    }
  }

  // "John's job" ties forty Johns on name alone. The one he means is almost
  // always the one with something going on, so ties go to the most recent job
  // activity, then the newest record.
  const ids = [...scores.keys()];
  const recent = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await db
      .select({ contactId: schema.jobs.contactId, last: sql<number>`max(${schema.jobs.updatedAt})` })
      .from(schema.jobs)
      .where(inArray(schema.jobs.contactId, chunk))
      .groupBy(schema.jobs.contactId);
    for (const r of rows) if (r.contactId) recent.set(r.contactId, Number(r.last) || 0);
  }
  const lastActive = (c: Contact) => Math.max(recent.get(c.id) ?? 0, Math.floor(c.updatedAt.getTime() / 1000));
  const top = [...scores.values()]
    .sort((a, b) => b.score - a.score || lastActive(b.contact) - lastActive(a.contact))
    .slice(0, 6);
  if (!top.length) return { text: null, list: [] };

  const blocks: string[] = [];
  const list: Candidate[] = [];
  for (const t of top) {
    const ids = await jobsForContact(t.contact.id, 5);
    const jl = await jobLines(ids);
    const lines = contactLines(t.contact);
    lines.push(`Why it came up: ${t.why.join(", ")}`);
    if (jl.size) {
      lines.push("Jobs (newest first, cancelled last):");
      ids.forEach((id, i) => {
        if (jl.has(id)) lines.push(`- ${jl.get(id)}${i === 0 ? " (latest job)" : ""}`);
      });
    }
    blocks.push(lines.join("\n"));
    list.push({
      id: t.contact.id,
      name: fullName(t.contact),
      detail: [t.contact.mobile, t.contact.suburb, ids.length ? `${ids.length} job${ids.length === 1 ? "" : "s"}` : "no jobs"]
        .filter(Boolean)
        .join(" · "),
      score: t.score,
    });
  }
  return { text: blocks.join("\n\n"), list };
}

/* ---------------------------------------------------------------------------
 * Jobs a memo action can be moved to, labelled so a person can tell them apart.
 * Old imports have titles like "ServiceM8 job 1775430" or a pasted note, so the
 * label leads with the number, the site and the status, and keeps the title short.
 * ------------------------------------------------------------------------- */

export interface JobChoice {
  id: number;
  number: number;
  label: string;
  detail: string;
}

const junkTitle = (t: string | null | undefined) =>
  !t || /^servicem8 job \d+$/i.test(t.trim()) || /^untitled$/i.test(t.trim()) || /^pick ?up from:?$/i.test(t.trim());
export const shortTitle = (t: string | null | undefined, max = 42) => {
  if (junkTitle(t)) return "";
  const clean = t!.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

export async function jobChoicesFor(contactId: number | null, extra: (number | null)[] = []): Promise<JobChoice[]> {
  const ids = new Set<number>();
  if (contactId) for (const id of await jobsForContact(contactId, 20)) ids.add(id);
  for (const id of extra) if (id) ids.add(id);
  if (!ids.size) return [];
  const rows = await db
    .select({ job: schema.jobs, status: schema.jobStatuses.name, site: schema.sites })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(inArray(schema.jobs.id, [...ids]));
  const dead = (r: (typeof rows)[number]) => (/^cancel/i.test(r.status ?? "") ? 1 : 0);
  return rows
    .sort((a, b) => dead(a) - dead(b) || b.job.number - a.job.number)
    .map((r) => {
      const title = shortTitle(r.job.title);
      const where = [r.site?.address, r.site?.suburb].filter(Boolean).join(", ");
      return {
        id: r.job.id,
        number: r.job.number,
        label: `#${r.job.number}${title ? ` ${title}` : where ? ` ${where}` : ""}`,
        detail: [r.status, title && where ? where : null, r.job.scheduledStart ? `install ${day(r.job.scheduledStart)}` : null]
          .filter(Boolean)
          .join(" · "),
      };
    });
}

/** A short "#4335 Hybrid to hall" for the action card. */
export async function shortJobLabel(jobId: number | null) {
  if (!jobId) return null;
  const [r] = await db
    .select({ job: schema.jobs, site: schema.sites })
    .from(schema.jobs)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobs.id, jobId));
  if (!r) return null;
  const title = shortTitle(r.job.title);
  const where = [r.site?.address, r.site?.suburb].filter(Boolean).join(", ");
  return `#${r.job.number}${title ? ` ${title}` : where ? ` ${where}` : ""}`;
}
