import { z } from "zod";
import { sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import { adminOnly, staffOnly } from "../middleware/auth";
import { goneQuiet, supervisorDetail, supervisorList } from "../lib/supervisors";

/**
 * CLIENT, COMPANY AND SUPERVISOR INTELLIGENCE.
 *
 * Three things this file is careful about:
 *
 *  1. REVENUE AND GROSS PROFIT ARE BOTH REPORTED, never revenue alone. A
 *     builder who has given Terra $600k at bad margins is not automatically
 *     worth more than one who has given $350k at good margins and pays on
 *     time, so the screens have to carry both numbers side by side.
 *
 *  2. GP IS ONLY CLAIMED WHERE COSTS EXIST. `costedRevenue` says how much of
 *     the revenue actually has costs recorded against it. Where that is zero,
 *     GP is null and the UI says "no cost data", instead of drawing a margin
 *     out of thin air.
 *
 *  3. NO COMPOSITE SCORE. There is deliberately no single "client value"
 *     number. The underlying figures are shown and Damien draws the
 *     conclusion.
 *
 * A job counts as DELIVERED when its status stage is complete, or its status
 * is Paid. Cancelled jobs are counted separately and never as revenue.
 */

/* Status classification, shared by every query below. */
const DELIVERED = sql`(s.stage = 'complete' or lower(s.name) = 'paid')`;
const CANCELLED = sql`(lower(s.name) like 'cancel%')`;
const LIVE = sql`(s.stage in ('open','won','scheduled','active'))`;
const JOB_DATE = sql`coalesce(j.completed_at, j.scheduled_start, j.created_at)`;
const JOB_COSTS = sql`(select coalesce(sum(jc.amount), 0) from job_costs jc where jc.job_id = j.id)`;
const HAS_COSTS = sql`exists (select 1 from job_costs jc where jc.job_id = j.id)`;

/**
 * WHO SENT THE WORK.
 *
 * Tried in order: a supervisor-ish contact linked to the job, the job's own
 * contact, the billing contact, then the contact on the site. Written as a
 * function because it has to be usable against more than one job alias in the
 * same query.
 *
 * Worth knowing before reading the numbers: the imported history barely
 * carries this link. Of 1,351 jobs billed to a company, 3 have a contact on
 * them and `job_contacts` holds 6 rows in total. So attribution is close to
 * empty until people get linked to jobs going forward, and every query here
 * reports what it could not attribute rather than quietly dropping it.
 */
const senderFor = (j: string) => sql`coalesce(
  (select jcs.contact_id from job_contacts jcs
     where jcs.job_id = ${sql.raw(j)}.id
       and exists (select 1 from json_each(jcs.tags) where json_each.value in ('supervisor','builder_contact'))
     order by jcs.is_primary desc limit 1),
  ${sql.raw(j)}.contact_id,
  ${sql.raw(j)}.bill_to_contact_id,
  (select st.contact_id from sites st where st.id = ${sql.raw(j)}.site_id)
)`;

const SENDER = senderFor("j");

/** The aggregate block every ranked list shares. */
const AGG = sql`
  count(j.id) as total_jobs,
  coalesce(sum(case when ${DELIVERED} then 1 end), 0) as delivered_jobs,
  coalesce(sum(case when ${CANCELLED} then 1 end), 0) as cancelled_jobs,
  coalesce(sum(case when ${LIVE} then 1 end), 0) as live_jobs,
  coalesce(sum(case when ${DELIVERED} then j.value end), 0) as revenue,
  coalesce(sum(case when ${LIVE} then j.value end), 0) as pipeline_value,
  coalesce(sum(case when ${DELIVERED} and ${HAS_COSTS} then j.value end), 0) as costed_revenue,
  coalesce(sum(case when ${DELIVERED} and ${HAS_COSTS} then j.value - ${JOB_COSTS} end), 0) as gross_profit,
  min(case when ${DELIVERED} then ${JOB_DATE} end) as first_job_at,
  max(case when ${DELIVERED} then ${JOB_DATE} end) as last_job_at
`;

interface AggRow {
  total_jobs: number;
  delivered_jobs: number;
  cancelled_jobs: number;
  live_jobs: number;
  revenue: number;
  pipeline_value: number;
  costed_revenue: number;
  gross_profit: number;
  first_job_at: number | null;
  last_job_at: number | null;
}

const isoOrNull = (secs: number | null) =>
  secs ? new Date(secs * 1000).toISOString().slice(0, 10) : null;

/** Shapes the raw aggregate row into the numbers the UI shows. */
function shapeAgg(r: AggRow) {
  const revenue = Math.round((r.revenue ?? 0) * 100) / 100;
  const costed = Math.round((r.costed_revenue ?? 0) * 100) / 100;
  const gp = costed > 0 ? Math.round((r.gross_profit ?? 0) * 100) / 100 : null;
  const delivered = Number(r.delivered_jobs ?? 0);
  return {
    jobs: Number(r.total_jobs ?? 0),
    deliveredJobs: delivered,
    cancelledJobs: Number(r.cancelled_jobs ?? 0),
    liveJobs: Number(r.live_jobs ?? 0),
    revenue,
    pipelineValue: Math.round((r.pipeline_value ?? 0) * 100) / 100,
    /** Null means no costs recorded, not a zero margin. */
    grossProfit: gp,
    /** How much of the revenue above actually has costs behind it. */
    costedRevenue: costed,
    marginPercent: gp !== null && costed > 0 ? Math.round((gp / costed) * 1000) / 10 : null,
    avgJobValue: delivered > 0 ? Math.round((revenue / delivered) * 100) / 100 : 0,
    firstJob: isoOrNull(r.first_job_at),
    lastJob: isoOrNull(r.last_job_at),
  };
}

export const intel = {
  /* ------------------------------ clients ------------------------------- */

  /**
   * Individual customers, ranked by what they have actually given Terra.
   * Includes people who sit inside a company only when the job was billed to
   * them personally — company work is reported under Companies.
   */
  clients: adminOnly
    .input(
      z
        .object({
          search: z.string().default(""),
          sort: z.enum(["revenue", "gp", "jobs", "recent", "name"]).default("revenue"),
          limit: z.number().int().min(10).max(2000).default(100),
        })
        .default({ search: "", sort: "revenue", limit: 100 }),
    )
    .handler(async ({ input }) => {
      const term = `%${input.search.toLowerCase()}%`;
      const order =
        input.sort === "gp"
          ? sql`gross_profit desc`
          : input.sort === "jobs"
            ? sql`total_jobs desc`
            : input.sort === "recent"
              ? sql`last_job_at desc`
              : input.sort === "name"
                ? sql`lower(c.first_name || ' ' || c.last_name) asc`
                : sql`revenue desc`;

      /**
       * Left joined on purpose. A person with no jobs yet is still a client
       * record people need to find, so they rank last rather than vanish.
       */
      const rows = await db.all<AggRow & { id: number; first_name: string; last_name: string; mobile: string | null; email: string | null; suburb: string | null; outstanding: number; company_names: string | null; active: number }>(sql`
        select c.id, c.first_name, c.last_name, c.mobile, c.email, c.suburb, c.active,
          (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
             where i.bill_to_contact_id = c.id and i.status not in ('paid','void')) as outstanding,
          (select group_concat(co.name, ', ') from company_contacts cc
             join companies co on co.id = cc.company_id where cc.contact_id = c.id) as company_names,
          ${AGG}
        from contacts c
        left join jobs j on j.contact_id = c.id
        left join job_statuses s on s.id = j.status_id
        ${
          input.search
            ? sql`where lower(c.first_name || ' ' || c.last_name) like ${term}
                or lower(coalesce(c.email, '')) like ${term}
                or replace(coalesce(c.mobile, ''), ' ', '') like ${term}
                or lower(coalesce(c.suburb, '')) like ${term}`
            : sql``
        }
        group by c.id
        order by ${order}
        limit ${input.limit}
      `);

      const [countRow] = await db.all<{ n: number }>(sql`select count(*) as n from contacts`);

      return {
        total: Number(countRow?.n ?? 0),
        rows: rows.map((r) => ({
          id: r.id,
          name: `${r.first_name} ${r.last_name}`.trim(),
          mobile: r.mobile,
          email: r.email,
          suburb: r.suburb,
          active: !!r.active,
          companyNames: r.company_names,
          outstanding: Math.round((r.outstanding ?? 0) * 100) / 100,
          ...shapeAgg(r),
        })),
      };
    }),

  /** One client's lifetime record, plus every job and quote behind it. */
  client: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [contact] = await db.all<{ id: number; first_name: string; last_name: string }>(
      sql`select * from contacts where id = ${input.id}`,
    );
    if (!contact) throw new ORPCError("NOT_FOUND", { message: "Client not found" });

    const [agg] = await db.all<AggRow>(sql`
      select ${AGG}
      from jobs j left join job_statuses s on s.id = j.status_id
      where j.contact_id = ${input.id}
    `);

    const jobs = await db.all<{
      id: number;
      number: number;
      title: string;
      status: string;
      stage: string;
      value: number;
      job_date: number | null;
      cost: number;
      has_costs: number;
    }>(sql`
      select j.id, j.number, j.title, s.name as status, s.stage, j.value,
        ${JOB_DATE} as job_date, ${JOB_COSTS} as cost,
        case when ${HAS_COSTS} then 1 else 0 end as has_costs
      from jobs j left join job_statuses s on s.id = j.status_id
      where j.contact_id = ${input.id}
      order by job_date desc
    `);

    const [quoteAgg] = await db.all<{ won: number; lost: number; open: number; won_value: number }>(sql`
      select
        coalesce(sum(case when status = 'accepted' then 1 end), 0) as won,
        coalesce(sum(case when status in ('declined','expired') then 1 end), 0) as lost,
        coalesce(sum(case when status in ('draft','sent') then 1 end), 0) as open,
        coalesce(sum(case when status = 'accepted' then total end), 0) as won_value
      from quotes where contact_id = ${input.id}
    `);

    const companies = await db.all<{ id: number; name: string; role: string }>(sql`
      select co.id, co.name, cc.role from company_contacts cc
      join companies co on co.id = cc.company_id
      where cc.contact_id = ${input.id}
    `);

    const [extra] = await db.all<{ outstanding: number; avg_days_to_pay: number | null }>(sql`
      select
        (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
           where i.bill_to_contact_id = ${input.id} and i.status not in ('paid','void')) as outstanding,
        (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
           from invoices i where i.bill_to_contact_id = ${input.id} and i.paid_at is not null) as avg_days_to_pay
    `);

    return {
      contact,
      lifetime: shapeAgg(agg ?? ({} as AggRow)),
      outstanding: Math.round((extra?.outstanding ?? 0) * 100) / 100,
      avgDaysToPay: extra?.avg_days_to_pay == null ? null : Math.round(extra.avg_days_to_pay),
      jobs: jobs.map((j) => ({
        ...j,
        date: isoOrNull(j.job_date),
        hasCosts: !!j.has_costs,
        grossProfit: j.has_costs ? Math.round((j.value - j.cost) * 100) / 100 : null,
      })),
      quotes: {
        won: Number(quoteAgg?.won ?? 0),
        lost: Number(quoteAgg?.lost ?? 0),
        open: Number(quoteAgg?.open ?? 0),
        wonValue: Number(quoteAgg?.won_value ?? 0),
      },
      companies,
    };
  }),

  /* ----------------------------- companies ------------------------------ */

  /** Builders and commercial clients, ranked. */
  companies: adminOnly
    .input(
      z
        .object({
          search: z.string().default(""),
          sort: z.enum(["revenue", "gp", "jobs", "recent", "outstanding", "name"]).default("revenue"),
          limit: z.number().int().min(10).max(2000).default(100),
        })
        .default({ search: "", sort: "revenue", limit: 100 }),
    )
    .handler(async ({ input }) => {
      const term = `%${input.search.toLowerCase()}%`;
      const order =
        input.sort === "gp"
          ? sql`gross_profit desc`
          : input.sort === "jobs"
            ? sql`delivered_jobs desc`
            : input.sort === "recent"
              ? sql`last_job_at desc`
              : input.sort === "outstanding"
                ? sql`outstanding desc`
                : input.sort === "name"
                  ? sql`lower(co.name) asc`
                  : sql`revenue desc`;

      const rows = await db.all<
        AggRow & {
          id: number;
          name: string;
          type: string;
          outstanding: number;
          avg_days_to_pay: number | null;
          contact_count: number;
          terms_days: number | null;
          terms_eom: number | null;
        }
      >(sql`
        select co.id, co.name, co.type,
          (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
             where i.bill_to_company_id = co.id and i.status not in ('paid','void')) as outstanding,
          (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
             from invoices i where i.bill_to_company_id = co.id and i.paid_at is not null) as avg_days_to_pay,
          (select count(*) from company_contacts cc where cc.company_id = co.id) as contact_count,
          (select pt.terms_days from payment_terms pt where pt.company_id = co.id) as terms_days,
          (select pt.end_of_month from payment_terms pt where pt.company_id = co.id) as terms_eom,
          ${AGG}
        from companies co
        left join jobs j on j.company_id = co.id
        left join job_statuses s on s.id = j.status_id
        ${input.search ? sql`where lower(co.name) like ${term}` : sql``}
        group by co.id
        order by ${order}
        limit ${input.limit}
      `);

      const [countRow] = await db.all<{ n: number }>(sql`select count(*) as n from companies`);

      return {
        total: Number(countRow?.n ?? 0),
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          contactCount: Number(r.contact_count ?? 0),
          outstanding: Math.round((r.outstanding ?? 0) * 100) / 100,
          avgDaysToPay: r.avg_days_to_pay === null ? null : Math.round(r.avg_days_to_pay),
          /** Falls back to Damien's standard, 30 days EOM, when nothing is set. */
          termsDays: r.terms_days ?? 30,
          termsEom: r.terms_eom === null ? true : !!r.terms_eom,
          ...shapeAgg(r),
        })),
      };
    }),

  /**
   * One company in full, with the people inside it ranked by the work they
   * personally sent. Unattributed work is reported rather than hidden, because
   * the ranking is only as good as the contact links behind it.
   */
  company: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [company] = await db.all<{ id: number; name: string }>(
      sql`select * from companies where id = ${input.id}`,
    );
    if (!company) throw new ORPCError("NOT_FOUND", { message: "Company not found" });

    const [agg] = await db.all<AggRow>(sql`
      select ${AGG}
      from jobs j left join job_statuses s on s.id = j.status_id
      where j.company_id = ${input.id}
    `);

    const [extra] = await db.all<{
      outstanding: number;
      avg_days_to_pay: number | null;
      unattributed: number;
      unattributed_value: number;
    }>(sql`
      select
        (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
           where i.bill_to_company_id = ${input.id} and i.status not in ('paid','void')) as outstanding,
        (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
           from invoices i where i.bill_to_company_id = ${input.id} and i.paid_at is not null) as avg_days_to_pay,
        (select count(*) from jobs j left join job_statuses s on s.id = j.status_id
           where j.company_id = ${input.id} and ${SENDER} is null) as unattributed,
        (select coalesce(sum(j.value), 0) from jobs j left join job_statuses s on s.id = j.status_id
           where j.company_id = ${input.id} and ${SENDER} is null and ${DELIVERED}) as unattributed_value
    `);

    const supervisors = await db.all<AggRow & { id: number; first_name: string; last_name: string; mobile: string | null; email: string | null; role: string | null }>(sql`
      select p.id, p.first_name, p.last_name, p.mobile, p.email,
        (select cc.role from company_contacts cc
           where cc.company_id = ${input.id} and cc.contact_id = p.id limit 1) as role,
        ${AGG}
      from jobs j
      left join job_statuses s on s.id = j.status_id
      join contacts p on p.id = ${SENDER}
      where j.company_id = ${input.id}
      group by p.id
      order by revenue desc
    `);

    const jobs = await db.all<{
      id: number;
      number: number;
      title: string;
      status: string;
      stage: string;
      value: number;
      job_date: number | null;
      cost: number;
      has_costs: number;
      sender_name: string | null;
      display_number: string | null;
    }>(sql`
      select j.id, j.number, j.display_number, j.title, s.name as status, s.stage, j.value,
        ${JOB_DATE} as job_date, ${JOB_COSTS} as cost,
        case when ${HAS_COSTS} then 1 else 0 end as has_costs,
        (select p.first_name || ' ' || p.last_name from contacts p where p.id = ${SENDER}) as sender_name
      from jobs j left join job_statuses s on s.id = j.status_id
      where j.company_id = ${input.id}
      order by job_date desc
      limit 300
    `);

    return {
      company,
      lifetime: shapeAgg(agg ?? ({} as AggRow)),
      outstanding: Math.round((extra?.outstanding ?? 0) * 100) / 100,
      avgDaysToPay: extra?.avg_days_to_pay == null ? null : Math.round(extra.avg_days_to_pay),
      attribution: {
        unattributedJobs: Number(extra?.unattributed ?? 0),
        unattributedValue: Math.round((extra?.unattributed_value ?? 0) * 100) / 100,
      },
      supervisors: supervisors.map((r) => ({
        id: r.id,
        name: `${r.first_name} ${r.last_name}`.trim(),
        role: r.role,
        mobile: r.mobile,
        email: r.email,
        ...shapeAgg(r),
      })),
      jobs: jobs.map((j) => ({
        ...j,
        date: isoOrNull(j.job_date),
        hasCosts: !!j.has_costs,
        grossProfit: j.has_costs ? Math.round((j.value - j.cost) * 100) / 100 : null,
        senderName: j.sender_name,
        displayNumber: j.display_number,
      })),
    };
  }),

  /* ---------------------------- supervisors ----------------------------- */

  /**
   * Supervisors, starting clean: only people picked on a job or quote count.
   * Office sees supervisors, jobs and revenue. Gross profit, win rate and the
   * concentration donut are stripped on the server unless the caller can see costs.
   */
  supervisors: staffOnly
    .input(
      z
        .object({
          search: z.string().default(""),
          sort: z.enum(["revenue", "gp", "jobs", "recent"]).default("revenue"),
          range: z.enum(["12m", "year", "all"]).default("12m"),
        })
        .default({ search: "", sort: "revenue", range: "12m" }),
    )
    .handler(({ input, context }) =>
      supervisorList({ ...input, canSeeCosts: context.actor.canSeeCosts }),
    ),

  /** Gone quiet list, for the Dashboard. */
  goneQuiet: staffOnly.handler(() => goneQuiet()),

  /** Every job and quote one supervisor has sent, with the company each came from. */
  supervisor: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const d = await supervisorDetail(input.id, context.actor.canSeeCosts);
    if (!d) throw new ORPCError("NOT_FOUND", { message: "Supervisor not found" });
    return d;
  }),

  /**
   * Client profitability, raw. Revenue, GP, margin, days to pay, outstanding,
   * quote conversion, repeat frequency. Deliberately no composite score.
   */
  profitability: adminOnly
    .input(
      z
        .object({
          scope: z.enum(["companies", "clients", "supervisors"]).default("companies"),
          limit: z.number().int().min(10).max(500).default(100),
        })
        .default({ scope: "companies", limit: 100 }),
    )
    .handler(async ({ input }) => {
      /*
       * The supervisor scope counts only jobs with a real `job_contacts` row at
       * tag 'supervisor'. It deliberately does NOT use the softer sender
       * fallback chain above, because a guess dressed up as a name is worse
       * than an honest gap. Jobs with nobody recorded fall out of the list and
       * are counted by `supervisorAttribution` instead.
       *
       * Unlike the company and client scopes this one keeps people whose work
       * has not been delivered yet. Attribution starts from nothing, so the
       * first jobs to carry a supervisor will all be live, and a tab that hid
       * them until they were finished would read as broken rather than empty.
       * Revenue is still delivered work only, so a new supervisor shows jobs
       * against their name and no revenue until those jobs land.
       */
      const supervisorsQuery = sql`
        select c.id, c.first_name || ' ' || c.last_name as name,
          coalesce(
            (select co.name from company_contacts cc
               join companies co on co.id = cc.company_id
               where cc.contact_id = c.id
               order by cc.is_primary desc limit 1),
            (select co2.name from job_contacts jc2
               join jobs j2 on j2.id = jc2.job_id
               join companies co2 on co2.id = j2.company_id
               where jc2.contact_id = c.id and exists (select 1 from json_each(jc2.tags) where json_each.value = 'supervisor')
               order by j2.number desc limit 1)
          ) as company_name,
          (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
             where i.status not in ('paid','void')
               and i.job_id in (select jc3.job_id from job_contacts jc3
                                  where jc3.contact_id = c.id and exists (select 1 from json_each(jc3.tags) where json_each.value = 'supervisor'))) as outstanding,
          (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
             from invoices i
             where i.paid_at is not null
               and i.job_id in (select jc4.job_id from job_contacts jc4
                                  where jc4.contact_id = c.id and exists (select 1 from json_each(jc4.tags) where json_each.value = 'supervisor'))) as avg_days_to_pay,
          (select count(*) from quotes q where q.contact_id = c.id) as quotes_total,
          (select count(*) from quotes q where q.contact_id = c.id and q.status = 'accepted') as quotes_won,
          ${AGG}
        from contacts c
        join job_contacts jcs on jcs.contact_id = c.id and exists (select 1 from json_each(jcs.tags) where json_each.value = 'supervisor')
        join jobs j on j.id = jcs.job_id
        left join job_statuses s on s.id = j.status_id
        group by c.id having total_jobs > 0
        order by revenue desc limit ${input.limit}
      `;

      const rows = await db.all<
        AggRow & {
          id: number;
          name: string;
          company_name?: string | null;
          outstanding: number;
          avg_days_to_pay: number | null;
          quotes_total: number;
          quotes_won: number;
        }
      >(
        input.scope === "supervisors"
          ? supervisorsQuery
          : input.scope === "companies"
          ? sql`
            select co.id, co.name,
              (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
                 where i.bill_to_company_id = co.id and i.status not in ('paid','void')) as outstanding,
              (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
                 from invoices i where i.bill_to_company_id = co.id and i.paid_at is not null) as avg_days_to_pay,
              (select count(*) from quotes q where q.company_id = co.id) as quotes_total,
              (select count(*) from quotes q where q.company_id = co.id and q.status = 'accepted') as quotes_won,
              ${AGG}
            from companies co
            join jobs j on j.company_id = co.id
            left join job_statuses s on s.id = j.status_id
            group by co.id having delivered_jobs > 0
            order by revenue desc limit ${input.limit}
          `
          : sql`
            select c.id, c.first_name || ' ' || c.last_name as name,
              (select coalesce(sum(i.total - i.amount_paid), 0) from invoices i
                 where i.bill_to_contact_id = c.id and i.status not in ('paid','void')) as outstanding,
              (select avg(julianday(i.paid_at, 'unixepoch') - julianday(i.created_at, 'unixepoch'))
                 from invoices i where i.bill_to_contact_id = c.id and i.paid_at is not null) as avg_days_to_pay,
              (select count(*) from quotes q where q.contact_id = c.id) as quotes_total,
              (select count(*) from quotes q where q.contact_id = c.id and q.status = 'accepted') as quotes_won,
              ${AGG}
            from contacts c
            join jobs j on j.contact_id = c.id
            left join job_statuses s on s.id = j.status_id
            group by c.id having delivered_jobs > 0
            order by revenue desc limit ${input.limit}
          `,
      );

      return rows.map((r) => {
        const shaped = shapeAgg(r);
        const spanDays =
          r.first_job_at && r.last_job_at ? (r.last_job_at - r.first_job_at) / 86400 : 0;
        return {
          id: r.id,
          name: r.name,
          /** Only filled on the supervisor scope: who they work for. */
          company: r.company_name ?? null,
          ...shaped,
          outstanding: Math.round((r.outstanding ?? 0) * 100) / 100,
          avgDaysToPay: r.avg_days_to_pay == null ? null : Math.round(r.avg_days_to_pay),
          quotesTotal: Number(r.quotes_total ?? 0),
          quotesWon: Number(r.quotes_won ?? 0),
          quoteConversion:
            Number(r.quotes_total ?? 0) > 0
              ? Math.round((Number(r.quotes_won) / Number(r.quotes_total)) * 1000) / 10
              : null,
          /** Jobs per year over the span they have been a customer. */
          jobsPerYear:
            shaped.deliveredJobs > 1 && spanDays > 30
              ? Math.round((shaped.deliveredJobs / (spanDays / 365)) * 10) / 10
              : null,
        };
      });
    }),

  /**
   * How much of the work has a supervisor recorded against it. Sits above the
   * supervisor list so the gap is stated rather than implied by a short table.
   * Cancelled jobs are left out, nobody needs chasing about those.
   */
  supervisorAttribution: adminOnly.handler(async () => {
    const [row] = await db.all<{
      total_jobs: number;
      with_supervisor: number;
      without_value: number;
    }>(sql`
      select count(*) as total_jobs,
        coalesce(sum(case when exists (
          select 1 from job_contacts jc where jc.job_id = j.id and exists (select 1 from json_each(jc.tags) where json_each.value = 'supervisor')
        ) then 1 end), 0) as with_supervisor,
        coalesce(sum(case when not exists (
          select 1 from job_contacts jc where jc.job_id = j.id and exists (select 1 from json_each(jc.tags) where json_each.value = 'supervisor')
        ) then j.value end), 0) as without_value
      from jobs j
      left join job_statuses s on s.id = j.status_id
      where not ${CANCELLED}
    `);

    const total = Number(row?.total_jobs ?? 0);
    const withSupervisor = Number(row?.with_supervisor ?? 0);
    return {
      totalJobs: total,
      withSupervisor,
      withoutSupervisor: total - withSupervisor,
      valueWithoutSupervisor: Math.round((row?.without_value ?? 0) * 100) / 100,
    };
  }),
};
