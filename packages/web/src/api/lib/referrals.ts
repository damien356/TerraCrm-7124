import { sql } from "drizzle-orm";
import { db } from "../database";

/**
 * REFERRERS.
 *
 * Who sends Terra work, by person and by company. Only people tagged
 * Supervisor or Property manager / Real estate agent count. Starts clean: only
 * work recorded in Terra Ops, nothing guessed from ServiceM8.
 *
 * Person level: every referrer on a job or quote is credited its full value.
 * Company level: the company the referrer acted for (saved when they were
 * added), and each job or quote counts once per company.
 *
 * Quoted: the latest sent version of each quote number they are on. A person
 * is on a quote when they are its supervisor, tagged on the quote, or tagged
 * on the quote's job. Invoiced: Terra Ops invoices on their jobs, excluding
 * drafts and voids. Both ex GST. Sales only: nothing here reads a cost.
 */

const REF = `('supervisor','property_manager')`;
const hasRef = (alias: string) => `exists (select 1 from json_each(${alias}.tags) where json_each.value in ${REF})`;

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : null);

export async function referrers(args: { from?: string | null; to?: string | null }) {
  const fromS = args.from ? Math.floor(new Date(`${args.from}T00:00:00+10:00`).getTime() / 1000) : 0;
  const toS = args.to ? Math.floor(new Date(`${args.to}T23:59:59+10:00`).getTime() / 1000) : 4102444800;

  // The latest sent version of every quote number, in range by its send date.
  const quotes = await db.all<{ id: number; number: number; job_id: number | null; company_id: number | null; sup: number | null; subtotal: number; status: string; sent_at: number }>(sql`
    select q.id, q.number, q.job_id, q.company_id, q.supervisor_contact_id as sup, q.subtotal, q.status, q.sent_at
    from quotes q
    where q.sent_at is not null
      and q.version = (select max(q2.version) from quotes q2 where q2.number = q.number and q2.sent_at is not null)
      and q.sent_at between ${fromS} and ${toS}`);

  const quoteLinks = await db.all<{ quote_id: number; contact_id: number; company_id: number | null; tags: string }>(sql.raw(`
    select qc.quote_id, qc.contact_id, qc.acted_for_company_id as company_id, qc.tags
    from quote_contacts qc where ${hasRef("qc")}`));
  const jobLinks = await db.all<{ job_id: number; contact_id: number; company_id: number | null; tags: string; job_created: number }>(sql.raw(`
    select jc.job_id, jc.contact_id, jc.acted_for_company_id as company_id, jc.tags, j.created_at as job_created
    from job_contacts jc join jobs j on j.id = jc.job_id where ${hasRef("jc")}`));
  const jobCreated = new Map(jobLinks.map((l) => [l.job_id, Number(l.job_created ?? 0)]));

  const invoices = await db.all<{ job_id: number; subtotal: number; created_at: number }>(sql`
    select i.job_id, i.subtotal, i.created_at from invoices i
    where i.job_id is not null and i.status not in ('draft','void')
      and i.created_at between ${fromS} and ${toS}`);

  const qByQuote = new Map<number, typeof quoteLinks>();
  for (const l of quoteLinks) qByQuote.set(l.quote_id, [...(qByQuote.get(l.quote_id) ?? []), l]);
  const jByJob = new Map<number, typeof jobLinks>();
  for (const l of jobLinks) jByJob.set(l.job_id, [...(jByJob.get(l.job_id) ?? []), l]);

  type Acc = { quotes: Map<number, { total: number; won: boolean; at: number }>; jobs: Set<number>; tags: Set<string>; companies: Set<number> };
  const people = new Map<number, Acc>();
  const companies = new Map<number, Acc>();
  const acc = (m: Map<number, Acc>, id: number) => {
    let a = m.get(id);
    if (!a) m.set(id, (a = { quotes: new Map(), jobs: new Set(), tags: new Set(), companies: new Set() }));
    return a;
  };
  const tagsOf = (raw: string) => {
    try {
      return (JSON.parse(raw) as string[]).filter((t) => t === "supervisor" || t === "property_manager");
    } catch {
      return [];
    }
  };

  for (const q of quotes) {
    const credit: Array<{ contactId: number; companyId: number | null; tags: string[] }> = [];
    if (q.sup && q.company_id) credit.push({ contactId: q.sup, companyId: q.company_id, tags: ["supervisor"] });
    for (const l of qByQuote.get(q.id) ?? []) credit.push({ contactId: l.contact_id, companyId: l.company_id, tags: tagsOf(l.tags) });
    if (q.job_id) for (const l of jByJob.get(q.job_id) ?? []) credit.push({ contactId: l.contact_id, companyId: l.company_id, tags: tagsOf(l.tags) });
    const entry = { total: q.subtotal ?? 0, won: q.status === "accepted", at: q.sent_at };
    for (const c of credit) {
      const p = acc(people, c.contactId);
      p.quotes.set(q.number, entry);
      for (const t of c.tags) p.tags.add(t);
      if (c.companyId) {
        p.companies.add(c.companyId);
        acc(companies, c.companyId).quotes.set(q.number, entry);
      }
    }
  }

  // Jobs and invoices: every job a referrer is tagged on.
  const invByJob = new Map<number, { total: number; at: number }>();
  for (const i of invoices) {
    const v = invByJob.get(i.job_id) ?? { total: 0, at: 0 };
    v.total += i.subtotal ?? 0;
    v.at = Math.max(v.at, i.created_at ?? 0);
    invByJob.set(i.job_id, v);
  }
  const personJobs = new Map<number, Set<number>>();
  const companyJobs = new Map<number, Set<number>>();
  for (const l of jobLinks) {
    const p = acc(people, l.contact_id);
    for (const t of tagsOf(l.tags)) p.tags.add(t);
    if (l.company_id) p.companies.add(l.company_id);
    personJobs.set(l.contact_id, (personJobs.get(l.contact_id) ?? new Set()).add(l.job_id));
    if (l.company_id) {
      acc(companies, l.company_id);
      companyJobs.set(l.company_id, (companyJobs.get(l.company_id) ?? new Set()).add(l.job_id));
    }
  }

  const ids = [...people.keys()];
  const coIds = [...new Set([...companies.keys(), ...[...people.values()].flatMap((p) => [...p.companies])])];
  const cards = ids.length
    ? await db.all<{ id: number; first_name: string; last_name: string; mobile: string | null; email: string | null }>(
        sql.raw(`select id, first_name, last_name, mobile, email from contacts where id in (${ids.map(Number).join(",")})`),
      )
    : [];
  const cos = coIds.length
    ? await db.all<{ id: number; name: string; type: string; phone: string | null; email: string | null }>(
        sql.raw(`select id, name, type, phone, email from companies where id in (${coIds.map(Number).join(",")})`),
      )
    : [];
  const cardBy = new Map(cards.map((c) => [c.id, c]));
  const coBy = new Map(cos.map((c) => [c.id, c]));

  const finish = (a: Acc, jobs: Set<number>) => {
    let invoiced = 0;
    let last = 0;
    let jobsInRange = 0;
    for (const j of jobs) {
      const inv = invByJob.get(j);
      if (inv) {
        invoiced += inv.total;
        last = Math.max(last, inv.at);
        jobsInRange++;
      }
    }
    let quoted = 0;
    let won = 0;
    for (const q of a.quotes.values()) {
      quoted += q.total;
      if (q.won) won++;
      last = Math.max(last, q.at);
    }
    // Jobs counts the jobs created in the range; invoiced counts invoices raised in it.
    const created = [...jobs].filter((j) => {
      const at = jobCreated.get(j) ?? 0;
      return at >= fromS && at <= toS;
    });
    for (const j of created) last = Math.max(last, jobCreated.get(j) ?? 0);
    return { quotesSent: a.quotes.size, quotedTotal: r2(quoted), quotesWon: won, jobs: created.length, jobsInvoiced: jobsInRange, invoicedTotal: r2(invoiced), lastActivity: iso(last || null) };
  };

  const peopleRows = ids.map((id) => {
    const a = people.get(id)!;
    const c = cardBy.get(id);
    return {
      id,
      name: c ? `${c.first_name} ${c.last_name}`.trim() : `#${id}`,
      detail: [...a.companies].map((cid) => coBy.get(cid)?.name).filter(Boolean).join(", "),
      mobile: c?.mobile ?? null,
      email: c?.email ?? null,
      tags: [...a.tags].sort(),
      ...finish(a, personJobs.get(id) ?? new Set()),
    };
  });
  const companyRows = [...companies.keys()].map((id) => {
    const a = companies.get(id)!;
    const c = coBy.get(id);
    return {
      id,
      name: c?.name ?? `#${id}`,
      detail: c?.type ?? "",
      mobile: c?.phone ?? null,
      email: c?.email ?? null,
      tags: [] as string[],
      ...finish(a, companyJobs.get(id) ?? new Set()),
    };
  });
  const order = (x: { invoicedTotal: number; quotedTotal: number; name: string }, y: typeof x) =>
    y.invoicedTotal - x.invoicedTotal || y.quotedTotal - x.quotedTotal || x.name.localeCompare(y.name);
  const keep = (r: { quotesSent: number; jobs: number; invoicedTotal: number }) => r.quotesSent > 0 || r.jobs > 0 || r.invoicedTotal > 0;
  const sum = (rows: Array<{ quotedTotal: number; invoicedTotal: number }>) => ({
    quotedTotal: r2(rows.reduce((s, r) => s + r.quotedTotal, 0)),
    invoicedTotal: r2(rows.reduce((s, r) => s + r.invoicedTotal, 0)),
  });
  const P = peopleRows.filter(keep).sort(order);
  const C = companyRows.filter(keep).sort(order);
  return {
    people: P,
    companies: C,
    totals: { people: sum(P), companies: sum(C) },
    range: { from: args.from ?? null, to: args.to ?? null },
  };
}
