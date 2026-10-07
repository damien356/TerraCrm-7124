import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * SUPERVISORS, STARTING CLEAN.
 *
 * A job belongs to a supervisor only when someone picked them on it (a
 * job_contacts row tagged 'supervisor'). A quote belongs to a supervisor
 * only through quotes.supervisor_contact_id. Nothing is guessed from the old
 * ServiceM8 contact data, so the numbers build up from new work.
 */

export const QUIET_MONTHS_KEY = "supervisor_quiet_months";

/** Months without a job or quote request before a supervisor counts as gone quiet. Default 3. */
export async function quietMonths(): Promise<number> {
  const [r] = await db.select().from(schema.settings).where(eq(schema.settings.key, QUIET_MONTHS_KEY));
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 36 ? Math.round(n) : 3;
}

export type Range = "12m" | "year" | "all";

/** Start of the range in epoch seconds, or 0 for all time. */
export function rangeStart(range: Range): number {
  const now = new Date();
  if (range === "all") return 0;
  if (range === "year") return Math.floor(new Date(now.getFullYear(), 0, 1).getTime() / 1000);
  const d = new Date(now);
  d.setFullYear(d.getFullYear() - 1);
  return Math.floor(d.getTime() / 1000);
}

const DELIVERED = sql`(s.stage = 'complete' or lower(s.name) = 'paid')`;
const CANCELLED = sql`(lower(s.name) like 'cancel%')`;
const LIVE = sql`(s.stage in ('open','won','scheduled','active'))`;
const JOB_DATE = sql`coalesce(j.completed_at, j.scheduled_start, j.created_at)`;

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (secs: number | null | undefined) => (secs ? new Date(secs * 1000).toISOString().slice(0, 10) : null);

export interface SupJob {
  sup: number;
  id: number;
  number: number;
  title: string;
  status: string;
  value: number;
  companyId: number | null;
  companyName: string | null;
  createdAt: number;
  jobDate: number;
  delivered: boolean;
  cancelled: boolean;
  live: boolean;
  installerCost: number;
  materialCost: number;
  otherCost: number;
  /** Gross profit is only claimed when both installer and material costs exist. */
  complete: boolean;
  grossProfit: number | null;
}

export interface SupQuote {
  sup: number;
  id: number;
  number: number;
  status: string;
  total: number;
  companyId: number | null;
  companyName: string | null;
  createdAt: number;
  sentAt: number | null;
  sent: boolean;
  won: boolean;
}

/** Every job with an explicit supervisor link. One row per supervisor per job. */
export async function loadJobs(): Promise<SupJob[]> {
  const rows = await db.all<any>(sql`
    select jcs.contact_id as sup, j.id, j.number, j.title, s.name as status, j.value,
      j.company_id, co.name as company_name, j.created_at, ${JOB_DATE} as job_date,
      case when ${DELIVERED} then 1 else 0 end as delivered,
      case when ${CANCELLED} then 1 else 0 end as cancelled,
      case when ${LIVE} then 1 else 0 end as live,
      (select count(*) from job_costs jc where jc.job_id = j.id and jc.kind = 'installer') as inst_n,
      (select coalesce(sum(jc.amount),0) from job_costs jc where jc.job_id = j.id and jc.kind = 'installer') as inst,
      (select count(*) from job_costs jc where jc.job_id = j.id and jc.kind = 'materials') as mat_n,
      (select coalesce(sum(jc.amount),0) from job_costs jc where jc.job_id = j.id and jc.kind = 'materials') as mat,
      (select coalesce(sum(jc.amount),0) from job_costs jc where jc.job_id = j.id and jc.kind not in ('installer','materials')) as other
    from job_contacts jcs
    join jobs j on j.id = jcs.job_id
    left join job_statuses s on s.id = j.status_id
    left join companies co on co.id = j.company_id
    where exists (select 1 from json_each(jcs.tags) where json_each.value = 'supervisor')
  `);
  return rows.map((r) => {
    const complete = Number(r.inst_n) > 0 && Number(r.mat_n) > 0;
    return {
      sup: r.sup,
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status ?? "",
      value: r.value ?? 0,
      companyId: r.company_id,
      companyName: r.company_name,
      createdAt: r.created_at ?? 0,
      jobDate: r.job_date ?? r.created_at ?? 0,
      delivered: !!r.delivered,
      cancelled: !!r.cancelled,
      live: !!r.live,
      installerCost: r.inst,
      materialCost: r.mat,
      otherCost: r.other,
      complete,
      grossProfit: complete ? r2((r.value ?? 0) - r.inst - r.mat - r.other) : null,
    };
  });
}

/** Every quote with an explicit supervisor link. */
export async function loadQuotes(): Promise<SupQuote[]> {
  const rows = await db.all<any>(sql`
    select q.supervisor_contact_id as sup, q.id, q.number, q.status, q.total, q.company_id,
      co.name as company_name, q.created_at, q.sent_at
    from quotes q
    left join companies co on co.id = q.company_id
    where q.supervisor_contact_id is not null
  `);
  return rows.map((r) => ({
    sup: r.sup,
    id: r.id,
    number: r.number,
    status: r.status,
    total: r.total ?? 0,
    companyId: r.company_id,
    companyName: r.company_name,
    createdAt: r.created_at ?? 0,
    sentAt: r.sent_at ?? null,
    sent: r.sent_at != null || ["sent", "accepted", "declined", "expired"].includes(r.status),
    won: r.status === "accepted",
  }));
}

export interface QuietRow {
  id: number;
  name: string;
  companyName: string | null;
  lastSent: string | null;
  lastSentAt: number;
  monthsAgo: number;
}

/** Supervisors who have sent work before but nothing in the last N months. */
export async function goneQuiet(): Promise<{ months: number; rows: QuietRow[] }> {
  const months = await quietMonths();
  const [jobs, quotes] = await Promise.all([loadJobs(), loadQuotes()]);
  const last = new Map<number, { at: number; company: string | null }>();
  const bump = (sup: number, at: number, company: string | null) => {
    const cur = last.get(sup);
    if (!cur || at > cur.at) last.set(sup, { at, company });
  };
  for (const j of jobs) bump(j.sup, j.createdAt, j.companyName);
  for (const q of quotes) bump(q.sup, q.createdAt, q.companyName);

  const cut = new Date();
  cut.setMonth(cut.getMonth() - months);
  const cutSecs = Math.floor(cut.getTime() / 1000);
  const quietIds = [...last.entries()].filter(([, v]) => v.at < cutSecs).map(([id]) => id);
  if (quietIds.length === 0) return { months, rows: [] };

  const people = await db.all<{ id: number; first_name: string; last_name: string; active: number }>(
    sql`select id, first_name, last_name, active from contacts where id in (${sql.join(quietIds.map((i) => sql`${i}`), sql`, `)})`,
  );
  const now = Date.now() / 1000;
  const rows = people
    .filter((p) => p.active !== 0)
    .map((p) => {
      const l = last.get(p.id)!;
      return {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        companyName: l.company,
        lastSent: iso(l.at),
        lastSentAt: l.at,
        monthsAgo: Math.max(months, Math.floor((now - l.at) / (30.44 * 86400))),
      };
    })
    .sort((a, b) => b.lastSentAt - a.lastSentAt);
  return { months, rows };
}

/* ------------------------------ list roll-up ------------------------------ */

export type SupSort = "revenue" | "gp" | "jobs" | "recent";

export async function supervisorList(opts: {
  search: string;
  sort: SupSort;
  range: Range;
  canSeeCosts: boolean;
}) {
  const since = rangeStart(opts.range);
  const [jobsAll, quotesAll, quiet] = await Promise.all([loadJobs(), loadQuotes(), goneQuiet()]);
  const quietIds = new Set(quiet.rows.map((r) => r.id));

  const jobs = jobsAll.filter((j) => j.jobDate >= since);
  const quotes = quotesAll.filter((q) => (q.sentAt ?? q.createdAt) >= since);

  const ids = new Set<number>([...jobs.map((j) => j.sup), ...quotes.map((q) => q.sup)]);
  // People who sent work before but nothing in this range still appear, with zeros.
  for (const j of jobsAll) ids.add(j.sup);
  for (const q of quotesAll) ids.add(q.sup);
  if (ids.size === 0) {
    return emptyList(quiet, opts.canSeeCosts);
  }

  const people = await db.all<{
    id: number;
    first_name: string;
    last_name: string;
    mobile: string | null;
    email: string | null;
    active: number;
    company_id: number | null;
    company_name: string | null;
  }>(sql`
    select c.id, c.first_name, c.last_name, c.mobile, c.email, c.active,
      (select cc.company_id from company_contacts cc where cc.contact_id = c.id and cc.role = 'supervisor'
         order by cc.is_primary desc, cc.id desc limit 1) as company_id,
      (select co.name from company_contacts cc join companies co on co.id = cc.company_id
         where cc.contact_id = c.id and cc.role = 'supervisor'
         order by cc.is_primary desc, cc.id desc limit 1) as company_name
    from contacts c
    where c.id in (${sql.join([...ids].map((i) => sql`${i}`), sql`, `)})
  `);

  const term = opts.search.trim().toLowerCase();
  let rows = people
    .filter((p) => p.active !== 0)
    .filter((p) => !term || `${p.first_name} ${p.last_name}`.toLowerCase().includes(term))
    .map((p) => {
      const mj = jobs.filter((j) => j.sup === p.id && !j.cancelled);
      const delivered = mj.filter((j) => j.delivered);
      const mq = quotes.filter((q) => q.sup === p.id);
      const sent = mq.filter((q) => q.sent).length;
      const won = mq.filter((q) => q.won).length;
      const complete = delivered.filter((j) => j.complete);
      const incomplete = delivered.length - complete.length;
      const allDates = [...jobsAll.filter((j) => j.sup === p.id).map((j) => j.createdAt), ...quotesAll.filter((q) => q.sup === p.id).map((q) => q.createdAt)];
      const lastAt = allDates.length ? Math.max(...allDates) : 0;
      const lastCompany =
        jobsAll.filter((j) => j.sup === p.id).sort((a, b) => b.createdAt - a.createdAt)[0]?.companyName ?? null;
      return {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        mobile: p.mobile,
        email: p.email,
        companyId: p.company_id,
        companyName: p.company_name ?? lastCompany,
        jobs: mj.length,
        deliveredJobs: delivered.length,
        liveJobs: mj.filter((j) => j.live).length,
        revenue: r2(delivered.reduce((s, j) => s + j.value, 0)),
        pipelineValue: r2(mj.filter((j) => j.live).reduce((s, j) => s + j.value, 0)),
        quotesSent: sent,
        lastSent: iso(lastAt),
        lastSentAt: lastAt,
        quiet: quietIds.has(p.id),
        // Cost-gated fields. Stripped below for anyone without cost access.
        grossProfit: complete.length ? r2(complete.reduce((s, j) => s + (j.grossProfit ?? 0), 0)) : (null as number | null),
        gpIncompleteJobs: incomplete,
        gpState: (delivered.length === 0 ? "none" : incomplete > 0 ? "incomplete" : "ok") as
          | "none"
          | "incomplete"
          | "ok"
          | "hidden",
        quotesWon: won as number | null,
        winRate: sent > 0 ? Math.round((won / sent) * 1000) / 10 : (null as number | null),
      };
    });

  rows.sort((a, b) => {
    switch (opts.sort) {
      case "gp":
        return (b.grossProfit ?? -Infinity) - (a.grossProfit ?? -Infinity) || b.revenue - a.revenue;
      case "jobs":
        return b.jobs - a.jobs || b.revenue - a.revenue;
      case "recent":
        return b.lastSentAt - a.lastSentAt;
      default:
        return b.revenue - a.revenue || b.jobs - a.jobs;
    }
  });

  const totalRevenue = r2(rows.reduce((s, r) => s + r.revenue, 0));
  const active = rows.filter((r) => r.jobs > 0 || r.quotesSent > 0).length;

  // Charts follow the chosen sort. "Most recent" has no chart axis, so it falls back to revenue.
  const metric = opts.sort === "recent" ? "revenue" : opts.sort;
  const value = (r: (typeof rows)[number]) =>
    metric === "gp" ? Math.max(0, r.grossProfit ?? 0) : metric === "jobs" ? r.jobs : r.revenue;
  const top10 = [...rows]
    .sort((a, b) => value(b) - value(a))
    .slice(0, 10)
    .filter((r) => value(r) > 0 || metric === "jobs")
    .map((r) => ({ id: r.id, name: r.name, companyName: r.companyName, value: value(r) }));

  const byRev = [...rows].sort((a, b) => b.revenue - a.revenue);
  const top5 = byRev.slice(0, 5).filter((r) => r.revenue > 0);
  const top5Revenue = r2(top5.reduce((s, r) => s + r.revenue, 0));
  const concentration = {
    top5: top5.map((r) => ({ id: r.id, name: r.name, revenue: r.revenue })),
    top5Revenue,
    othersRevenue: r2(totalRevenue - top5Revenue),
    top5Percent: totalRevenue > 0 ? Math.round((top5Revenue / totalRevenue) * 1000) / 10 : 0,
  };

  const out = {
    canSeeCosts: opts.canSeeCosts,
    range: opts.range,
    quietMonths: quiet.months,
    summary: { activeSupervisors: active, revenue: totalRevenue, goneQuiet: quiet.rows.length },
    quiet: quiet.rows,
    rows,
    top10,
    concentration: opts.canSeeCosts ? concentration : null,
  };

  if (!opts.canSeeCosts) {
    for (const r of out.rows) {
      r.grossProfit = null;
      r.quotesWon = null;
      r.winRate = null;
      r.gpState = "hidden";
      r.gpIncompleteJobs = 0;
    }
    if (opts.sort === "gp") out.rows.sort((a, b) => b.revenue - a.revenue);
    if (metric === "gp") {
      out.top10 = [...out.rows].slice(0, 10).map((r) => ({ id: r.id, name: r.name, companyName: r.companyName, value: r.revenue }));
    }
  }
  return out;
}

function emptyList(quiet: { months: number; rows: QuietRow[] }, canSeeCosts: boolean) {
  return {
    canSeeCosts,
    range: "12m" as Range,
    quietMonths: quiet.months,
    summary: { activeSupervisors: 0, revenue: 0, goneQuiet: quiet.rows.length },
    quiet: quiet.rows,
    rows: [] as never[],
    top10: [] as { id: number; name: string; companyName: string | null; value: number }[],
    concentration: null as null,
  };
}

/* ------------------------------- one person ------------------------------- */

export async function supervisorDetail(id: number, canSeeCosts: boolean) {
  const [people, jobsAll, quotesAll, quiet] = await Promise.all([
    db.all<any>(sql`select * from contacts where id = ${id}`),
    loadJobs(),
    loadQuotes(),
    goneQuiet(),
  ]);
  const contact = people[0];
  if (!contact) return null;

  const jobs = jobsAll.filter((j) => j.sup === id).sort((a, b) => b.jobDate - a.jobDate);
  const quotes = quotesAll.filter((q) => q.sup === id).sort((a, b) => b.number - a.number);

  const companies = await db.all<{ id: number; name: string; role: string }>(sql`
    select co.id, co.name, cc.role from company_contacts cc
    join companies co on co.id = cc.company_id where cc.contact_id = ${id}
  `);

  // Which company each stretch of work came from.
  const byCompany = new Map<string, { companyId: number | null; name: string; jobs: number; quotes: number; revenue: number; first: number; last: number }>();
  const touch = (cid: number | null, name: string | null, at: number) => {
    const key = String(cid ?? 0);
    const cur = byCompany.get(key) ?? { companyId: cid, name: name ?? "No company", jobs: 0, quotes: 0, revenue: 0, first: at, last: at };
    cur.first = Math.min(cur.first, at);
    cur.last = Math.max(cur.last, at);
    byCompany.set(key, cur);
    return cur;
  };
  for (const j of jobs) {
    const c = touch(j.companyId, j.companyName, j.createdAt);
    c.jobs++;
    if (j.delivered) c.revenue += j.value;
  }
  for (const q of quotes) touch(q.companyId, q.companyName, q.createdAt).quotes++;

  // Work sent per month, last 24 months, oldest first.
  const months: { month: string; jobs: number; quotes: number; revenue: number }[] = [];
  const now = new Date();
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, jobs: 0, quotes: 0, revenue: 0 });
  }
  const slot = (secs: number) => {
    const d = new Date(secs * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    return months.find((m) => m.month === key);
  };
  for (const j of jobs) {
    const m = slot(j.createdAt);
    if (m && !j.cancelled) {
      m.jobs++;
      m.revenue += j.value;
    }
  }
  for (const q of quotes) {
    const m = slot(q.createdAt);
    if (m) m.quotes++;
  }

  const delivered = jobs.filter((j) => j.delivered && !j.cancelled);
  const complete = delivered.filter((j) => j.complete);
  const sent = quotes.filter((q) => q.sent).length;
  const won = quotes.filter((q) => q.won).length;
  const quietRow = quiet.rows.find((r) => r.id === id) ?? null;

  return {
    canSeeCosts,
    contact: { id: contact.id, first_name: contact.first_name, last_name: contact.last_name, mobile: contact.mobile, email: contact.email },
    companies,
    quietMonths: quiet.months,
    quiet: quietRow,
    summary: {
      jobs: jobs.filter((j) => !j.cancelled).length,
      deliveredJobs: delivered.length,
      revenue: r2(delivered.reduce((s, j) => s + j.value, 0)),
      pipelineValue: r2(jobs.filter((j) => j.live).reduce((s, j) => s + j.value, 0)),
      quotesSent: sent,
      lastSent: iso(Math.max(0, ...jobs.map((j) => j.createdAt), ...quotes.map((q) => q.createdAt))),
      grossProfit: canSeeCosts && complete.length ? r2(complete.reduce((s, j) => s + (j.grossProfit ?? 0), 0)) : null,
      gpIncompleteJobs: canSeeCosts ? delivered.length - complete.length : 0,
      quotesWon: canSeeCosts ? won : null,
      winRate: canSeeCosts && sent > 0 ? Math.round((won / sent) * 1000) / 10 : null,
    },
    history: [...byCompany.values()]
      .sort((a, b) => b.last - a.last)
      .map((c) => ({ ...c, revenue: r2(c.revenue), first: iso(c.first), last: iso(c.last) })),
    months: months.map((m) => ({ ...m, revenue: r2(m.revenue) })),
    jobs: jobs.map((j) => ({
      id: j.id,
      number: j.number,
      title: j.title,
      status: j.status,
      value: j.value,
      date: iso(j.jobDate),
      companyId: j.companyId,
      companyName: j.companyName,
      delivered: j.delivered,
      // "complete" only means both costs exist. Null hides the number from staff without cost access.
      gpState: !canSeeCosts ? "hidden" : j.complete ? "ok" : "incomplete",
      grossProfit: canSeeCosts ? j.grossProfit : null,
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      number: q.number,
      status: q.status,
      total: q.total,
      companyId: q.companyId,
      companyName: q.companyName,
      date: iso(q.createdAt),
    })),
  };
}

/* ------------------------------ the new rule ------------------------------ */

/**
 * A supervisor is optional, even on a company job or quote. Not every company
 * works through supervisors. When one is picked they must belong to that
 * company. Throws a plain-English error otherwise.
 */
export async function assertSupervisor(companyId: number | null | undefined, supervisorId: number | null | undefined) {
  const { ORPCError } = await import("@orpc/server");
  if (!companyId || !supervisorId) return;
  const [m] = await db.all<{ n: number }>(
    sql`select count(*) as n from company_contacts where company_id = ${companyId} and contact_id = ${supervisorId}`,
  );
  if (!Number(m?.n)) {
    throw new ORPCError("BAD_REQUEST", { message: "That supervisor is not linked to this company. Add them under the company first." });
  }
}

/* --------------------------- change notifications -------------------------- */

const ALERT_TO = "damien@terraflooring.com.au";
const ALERT_FROM = "Terra Flooring <team@terraflooring.com.au>";

/** Is this person a supervisor (picked on a job or quote, or filed as one under a company)? */
export async function isSupervisor(contactId: number): Promise<boolean> {
  const [r] = await db.all<{ n: number }>(sql`
    select (
      (select count(*) from job_contacts jc where jc.contact_id = ${contactId} and exists (select 1 from json_each(jc.tags) where json_each.value = 'supervisor')) +
      (select count(*) from quotes where supervisor_contact_id = ${contactId}) +
      (select count(*) from company_contacts where contact_id = ${contactId} and role = 'supervisor')
    ) as n`);
  return Number(r?.n) > 0;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/**
 * Tells Damien a supervisor changed email or company so he can chase work at
 * the new place. Sent FROM team@, never from damien@. A failed send never
 * blocks the edit that caused it.
 */
export async function notifySupervisorChange(args: {
  name: string;
  contactId: number;
  oldEmail?: string | null;
  newEmail?: string | null;
  oldCompany?: string | null;
  newCompany?: string | null;
  mobile?: string | null;
}) {
  try {
    const { sendEmail } = await import("./email");
    const lines: string[] = [];
    if (args.newCompany && args.newCompany !== args.oldCompany)
      lines.push(`Company: ${args.oldCompany || "none on file"} to ${args.newCompany}`);
    if (args.newEmail !== undefined && (args.newEmail ?? "") !== (args.oldEmail ?? ""))
      lines.push(`Email: ${args.oldEmail || "none on file"} to ${args.newEmail || "none"}`);
    if (lines.length === 0) return;
    const text = `${args.name} has moved.\n\n${lines.join("\n")}${args.mobile ? `\nMobile: ${args.mobile}` : ""}\n\nThis is a good time to get in touch and chase work at the new place.`;
    await sendEmail({
      to: ALERT_TO,
      from: ALERT_FROM,
      subject: `Supervisor update: ${args.name}`,
      text,
      html: `<p><b>${esc(args.name)}</b> has moved.</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>${args.mobile ? `<p>Mobile: ${esc(args.mobile)}</p>` : ""}<p>This is a good time to get in touch and chase work at the new place.</p>`,
    });
  } catch (e) {
    console.error("supervisor change email failed", e);
  }
}
