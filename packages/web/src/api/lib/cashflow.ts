import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositDefaultOf } from "./deposits";
import { quoteRef } from "./refs";

/**
 * THE CASHFLOW ENGINE.
 *
 * Not a graph of invoice due dates. The forecast starts the moment work is
 * AGREED, because that is the moment the cash consequences are locked in:
 * material has to be ordered, an installer has to be paid, and the customer
 * pays on their own terms weeks later.
 *
 * Every predicted movement is written to `cash_events` with:
 *   - a direction (in/out),
 *   - a confidence (committed / expected / pipeline, never added together),
 *   - a `basis` string saying in plain English how the date was worked out,
 *     so Damien can disagree with a number instead of distrusting all of them.
 *
 * What it will NOT do is invent the cost side. If a job has no costs entered,
 * its outflows are missing and the forecast says so out loud rather than
 * drawing a confident line that is only half the story.
 */

export type Confidence = "committed" | "expected" | "pipeline";
export type Direction = "in" | "out";

/* --------------------------------- dates -------------------------------- */

export const iso = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

export const today = (): string => iso(new Date());

export const parseIso = (s: string): Date => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
};

export const addDays = (s: string, n: number): string => {
  const d = parseIso(s);
  d.setDate(d.getDate() + n);
  return iso(d);
};

export const addMonths = (s: string, n: number): string => {
  const d = parseIso(s);
  d.setMonth(d.getMonth() + n);
  return iso(d);
};

/** Last day of the month a date falls in. */
export const endOfMonth = (s: string): string => {
  const d = parseIso(s);
  return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};

export const maxDate = (a: string, b: string): string => (a > b ? a : b);

/**
 * When cash actually lands, given terms.
 *
 * "30 days EOM" is not 30 days. An invoice dated 2 October sits until the end
 * of October and only then starts its 30 days, so it pays on 30 November. That
 * month of drift is what catches people out, so it is modelled explicitly.
 */
export function settleDate(base: string, termsDays: number, eom: boolean, daysLate = 0): string {
  const start = eom ? endOfMonth(base) : base;
  return addDays(start, Math.round(termsDays + (daysLate || 0)));
}

export const termsLabel = (termsDays: number, eom: boolean): string =>
  eom ? `${termsDays} days EOM` : termsDays === 0 ? "on the day" : `${termsDays} days`;

/* --------------------------------- terms -------------------------------- */

export interface ResolvedTerms {
  id: number | null;
  /** company · job · default */
  level: "job" | "company" | "default";
  structure: "deposit_balance" | "on_completion" | "progress_claims";
  depositPercent: number;
  termsFrom: "invoice" | "completion";
  termsDays: number;
  endOfMonth: boolean;
  retentionPercent: number;
  retentionDays: number;
  observedDaysLate: number;
  notes: string;
}

/** Builders and commercial: 30 days EOM from invoice. Damien's standard. */
export const COMMERCIAL_DEFAULT: ResolvedTerms = {
  id: null,
  level: "default",
  structure: "on_completion",
  depositPercent: 0,
  termsFrom: "invoice",
  termsDays: 30,
  endOfMonth: true,
  retentionPercent: 0,
  retentionDays: 0,
  observedDaysLate: 0,
  notes: "",
};

/** Residential and direct: 50% deposit on acceptance, balance on completion. */
export const RESIDENTIAL_DEFAULT: ResolvedTerms = {
  id: null,
  level: "default",
  structure: "deposit_balance",
  depositPercent: 50,
  termsFrom: "completion",
  termsDays: 0,
  endOfMonth: false,
  retentionPercent: 0,
  retentionDays: 0,
  observedDaysLate: 0,
  notes: "",
};

type TermsRow = typeof schema.paymentTerms.$inferSelect;

const shape = (row: TermsRow, level: "job" | "company"): ResolvedTerms => ({
  id: row.id,
  level,
  structure: (row.structure as ResolvedTerms["structure"]) ?? "on_completion",
  depositPercent: row.depositPercent ?? 0,
  termsFrom: (row.termsFrom as ResolvedTerms["termsFrom"]) ?? "invoice",
  termsDays: row.termsDays ?? 30,
  endOfMonth: !!row.endOfMonth,
  retentionPercent: row.retentionPercent ?? 0,
  retentionDays: row.retentionDays ?? 0,
  observedDaysLate: row.observedDaysLate ?? 0,
  notes: row.notes ?? "",
});

export const defaultTermsFor = (companyId: number | null | undefined): ResolvedTerms =>
  companyId ? COMMERCIAL_DEFAULT : RESIDENTIAL_DEFAULT;

/**
 * The deposit % on the company card (or the contact card when there is no
 * company) is the ONE deposit setting, Damien 2026-10-06. It prefills new
 * quotes and it drives the forecast. Loaded once per rebuild.
 */
export interface DepositMaps {
  companies: Map<number, { type: string; depositPercent: number | null }>;
  contacts: Map<number, number>;
}

export async function loadDepositMaps(): Promise<DepositMaps> {
  const [cos, cts] = await Promise.all([
    db
      .select({ id: schema.companies.id, type: schema.companies.type, depositPercent: schema.companies.depositPercent })
      .from(schema.companies),
    db
      .select({ id: schema.contacts.id, depositPercent: schema.contacts.depositPercent })
      .from(schema.contacts)
      .where(sql`${schema.contacts.depositPercent} is not null`),
  ]);
  return {
    companies: new Map(cos.map((c) => [c.id, { type: c.type, depositPercent: c.depositPercent }])),
    contacts: new Map(cts.map((c) => [c.id, c.depositPercent ?? 0])),
  };
}

/** The card deposit % for whoever is paying. */
export function cardDeposit(
  deposits: DepositMaps,
  companyId: number | null | undefined,
  contactId: number | null | undefined,
): number {
  const company = companyId ? deposits.companies.get(companyId) : undefined;
  const contactPct = contactId ? deposits.contacts.get(contactId) : undefined;
  return depositDefaultOf(company ?? null, contactPct == null ? null : { depositPercent: contactPct }).percent;
}

/**
 * Job row wins over company row, company row wins over the default.
 *
 * With `deposits` passed, the company and default levels take their deposit
 * from the card, and a deposit above 0 means "deposit, then the balance"
 * while 0 means "one invoice on completion". Progress claims are left alone,
 * their stages say what is taken when. A job's own terms row is a deliberate
 * override for that one job and keeps its own figure.
 */
export function resolveTerms(
  companyId: number | null | undefined,
  jobId: number | null | undefined,
  byJob: Map<number, TermsRow>,
  byCompany: Map<number, TermsRow>,
  card?: { deposits: DepositMaps; contactId?: number | null },
): ResolvedTerms {
  const j = jobId ? byJob.get(jobId) : undefined;
  if (j) return shape(j, "job");
  const c = companyId ? byCompany.get(companyId) : undefined;
  const base = c ? shape(c, "company") : defaultTermsFor(companyId);
  if (!card || base.structure === "progress_claims") return base;
  const pct = cardDeposit(card.deposits, companyId, card.contactId);
  return { ...base, depositPercent: pct, structure: pct > 0 ? "deposit_balance" : "on_completion" };
}

/**
 * What the customer pays up front on a job. The accepted quote's deposit,
 * copied onto the job when it was made, wins. Otherwise the terms' %.
 */
export function jobDeposit(
  job: { depositAmount: number; depositPaid: boolean },
  terms: ResolvedTerms,
  contract: number,
): { amount: number; basis: string } {
  if (job.depositPaid || terms.structure === "progress_claims") return { amount: 0, basis: "" };
  if (job.depositAmount > 0) return { amount: job.depositAmount, basis: "deposit on the accepted quote, taken before material is ordered" };
  if (terms.structure !== "deposit_balance") return { amount: 0, basis: "" };
  return {
    amount: (contract * (terms.depositPercent ?? 0)) / 100,
    basis: `${terms.depositPercent}% deposit, taken before material is ordered`,
  };
}

export async function loadTermsMaps() {
  const rows = await db.select().from(schema.paymentTerms);
  const byJob = new Map<number, TermsRow>();
  const byCompany = new Map<number, TermsRow>();
  for (const r of rows) {
    if (r.jobId) byJob.set(r.jobId, r);
    else if (r.companyId) byCompany.set(r.companyId, r);
  }
  const milestones = await db
    .select()
    .from(schema.paymentMilestones)
    .orderBy(schema.paymentMilestones.seq);
  const byTerms = new Map<number, (typeof schema.paymentMilestones.$inferSelect)[]>();
  for (const m of milestones) {
    const list = byTerms.get(m.termsId) ?? [];
    list.push(m);
    byTerms.set(m.termsId, list);
  }
  return { byJob, byCompany, milestones: byTerms };
}

/* ------------------------------ cost timing ----------------------------- */

/** Supplier terms, one rule for everyone: 30 days EOM. */
export const SUPPLIER_TERMS = { days: 30, eom: true };
/** Installers are paid within 7 days of THEIR invoice, not of completion. */
export const INSTALLER_TERMS_DAYS = 7;

/**
 * When a cost leaves, when nobody has typed a date.
 *
 * Material is ordered before the job starts and falls due on the supplier's
 * 30 days EOM. The installer invoices at completion and is paid a week later.
 */
export function costDueDate(
  kind: string,
  start: string | null,
  completion: string | null,
  fallback: string,
): { date: string; basis: string } {
  if (kind === "materials") {
    const order = start ? addDays(start, -7) : fallback;
    return {
      date: settleDate(order, SUPPLIER_TERMS.days, SUPPLIER_TERMS.eom),
      basis: `material ordered ${order}, supplier 30 days EOM`,
    };
  }
  if (kind === "installer") {
    const done = completion ?? start ?? fallback;
    return {
      date: addDays(done, INSTALLER_TERMS_DAYS),
      basis: `installer invoices at completion ${done}, paid within 7 days`,
    };
  }
  const when = completion ?? start ?? fallback;
  return { date: when, basis: `direct cost around ${when}` };
}

/* ------------------------------- the build ------------------------------ */

const confidenceForStage = (stage: string, statusName: string): Confidence | null => {
  const name = statusName.toLowerCase();
  if (name.includes("cancel")) return null;
  if (name === "paid") return null;
  if (stage === "open") return "pipeline";
  if (stage === "won") return "expected";
  if (stage === "scheduled" || stage === "active" || stage === "complete") return "committed";
  return null;
};

const confidenceForCost = (state: string): Confidence | null => {
  if (state === "paid") return null;
  if (state === "budget") return "expected";
  return "committed";
};

type NewEvent = typeof schema.cashEvents.$inferInsert;

export interface RebuildResult {
  events: number;
  in: number;
  out: number;
  jobsForecast: number;
  jobsMissingCosts: number;
  valueMissingCosts: number;
}

/**
 * Rebuild every predicted cash event. Rows marked `actual` are history and are
 * never touched; everything else is thrown away and worked out again, so the
 * forecast always reflects today's jobs, terms and costs.
 */
export async function rebuildForecast(): Promise<RebuildResult> {
  const now = today();
  const { byJob, byCompany, milestones } = await loadTermsMaps();
  const deposits = await loadDepositMaps();

  const jobRows = await db
    .select({
      job: schema.jobs,
      statusName: schema.jobStatuses.name,
      stage: schema.jobStatuses.stage,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(
      or(
        isNull(schema.jobs.statusId),
        inArray(
          schema.jobStatuses.stage,
          ["open", "won", "scheduled", "active", "complete"],
        ),
      ),
    );

  const live = jobRows.filter(
    (r) => confidenceForStage(r.stage ?? "open", r.statusName ?? "") !== null,
  );
  const liveIds = live.map((r) => r.job.id);

  const [costRows, invoiceRows, taskRows] = await Promise.all([
    liveIds.length
      ? db
          .select()
          .from(schema.jobCosts)
          .where(and(inArray(schema.jobCosts.jobId, liveIds), ne(schema.jobCosts.state, "paid")))
      : Promise.resolve([]),
    liveIds.length
      ? db
          .select()
          .from(schema.invoices)
          .where(
            and(
              inArray(schema.invoices.jobId, liveIds),
              inArray(schema.invoices.status, ["draft", "sent", "part_paid", "overdue"]),
            ),
          )
      : Promise.resolve([]),
    liveIds.length
      ? db
          .select({
            jobId: schema.jobTasks.jobId,
            lastDate: sql<string>`max(coalesce(${schema.jobTasks.scheduledDate}, ${schema.jobTasks.scheduledTo}))`,
          })
          .from(schema.jobTasks)
          .where(inArray(schema.jobTasks.jobId, liveIds))
          .groupBy(schema.jobTasks.jobId)
      : Promise.resolve([]),
  ]);

  const costsByJob = new Map<number, typeof costRows>();
  for (const c of costRows) {
    const list = costsByJob.get(c.jobId) ?? [];
    list.push(c);
    costsByJob.set(c.jobId, list);
  }
  const invoicesByJob = new Map<number, typeof invoiceRows>();
  for (const i of invoiceRows) {
    if (!i.jobId) continue;
    const list = invoicesByJob.get(i.jobId) ?? [];
    list.push(i);
    invoicesByJob.set(i.jobId, list);
  }
  const lastTaskDate = new Map<number, string>();
  for (const t of taskRows) if (t.lastDate) lastTaskDate.set(t.jobId, t.lastDate);

  const events: NewEvent[] = [];
  let missingCosts = 0;
  let valueMissingCosts = 0;

  for (const row of live) {
    const job = row.job;
    const conf = confidenceForStage(row.stage ?? "open", row.statusName ?? "")!;
    const terms = resolveTerms(job.companyId, job.id, byJob, byCompany, { deposits, contactId: job.contactId });

    const start = job.scheduledStart ? iso(job.scheduledStart) : null;
    const completion = job.completedAt
      ? iso(job.completedAt)
      : (lastTaskDate.get(job.id) ??
        (start ? addDays(start, 2) : addDays(now, 21)));
    const completionBasis = job.completedAt
      ? `completed ${completion}`
      : lastTaskDate.get(job.id)
        ? `last scheduled task ${completion}`
        : start
          ? `starts ${start}, allowing 3 days`
          : `no date set, assuming 3 weeks out`;

    /* ---------------------------- money in --------------------------- */
    const invoiced = invoicesByJob.get(job.id) ?? [];
    let invoicedTotal = 0;
    for (const inv of invoiced) {
      const outstanding = (inv.total ?? 0) - (inv.amountPaid ?? 0);
      if (outstanding <= 0) continue;
      invoicedTotal += outstanding;
      const base = inv.dueDate
        ? iso(inv.dueDate)
        : settleDate(iso(inv.createdAt ?? new Date()), terms.termsDays, terms.endOfMonth);
      events.push({
        direction: "in",
        confidence: "committed",
        kind: "customer_payment",
        jobId: job.id,
        invoiceId: inv.id,
        companyId: job.companyId,
        contactId: job.contactId,
        label: `Invoice ${inv.number} — job ${job.number}`,
        amount: outstanding,
        dueDate: settleDate(base, 0, false, terms.observedDaysLate),
        basis: terms.observedDaysLate
          ? `invoice due ${base}, this payer runs ${Math.round(terms.observedDaysLate)} days late`
          : `invoice due ${base}`,
      });
    }

    const contract = Math.max(0, (job.value ?? 0) - invoicedTotal);
    if (contract > 0) {
      const retention = (contract * (terms.retentionPercent ?? 0)) / 100;
      const { amount: deposit, basis: depositBasis } = jobDeposit(job, terms, contract);

      if (deposit > 0) {
        const when = start ? maxDate(now, addDays(start, -7)) : addDays(now, 7);
        events.push({
          direction: "in",
          confidence: conf,
          kind: "deposit",
          jobId: job.id,
          companyId: job.companyId,
          contactId: job.contactId,
          label: `Deposit — job ${job.number}`,
          amount: deposit,
          dueDate: when,
          basis: depositBasis,
        });
      }

      if (terms.structure === "progress_claims" && terms.id && milestones.get(terms.id)?.length) {
        for (const m of milestones.get(terms.id)!) {
          const trigger =
            m.trigger === "fixed_date"
              ? (m.onDate ?? completion)
              : m.trigger === "acceptance"
                ? iso(job.createdAt ?? new Date())
                : m.trigger === "order"
                  ? (start ? addDays(start, -7) : now)
                  : m.trigger === "delivery"
                    ? (start ? addDays(start, -2) : now)
                    : m.trigger === "start"
                      ? (start ?? now)
                      : completion;
          const claimDate = addDays(trigger, m.offsetDays ?? 0);
          const amount = (contract * (m.percent ?? 0)) / 100;
          if (amount <= 0) continue;
          events.push({
            direction: "in",
            confidence: conf,
            kind: "progress_claim",
            jobId: job.id,
            companyId: job.companyId,
            contactId: job.contactId,
            label: `${m.label || `Claim ${m.seq}`} — job ${job.number}`,
            amount,
            dueDate: settleDate(claimDate, terms.termsDays, terms.endOfMonth, terms.observedDaysLate),
            basis: `${m.percent}% claimed at ${m.trigger} (${claimDate}), ${termsLabel(terms.termsDays, terms.endOfMonth)}`,
          });
        }
      } else {
        const balance = contract - deposit - retention;
        if (balance > 0) {
          const base = terms.termsFrom === "invoice" ? completion : completion;
          events.push({
            direction: "in",
            confidence: conf,
            kind: "customer_payment",
            jobId: job.id,
            companyId: job.companyId,
            contactId: job.contactId,
            label: `${deposit > 0 ? "Balance" : "Payment"} — job ${job.number}`,
            amount: balance,
            dueDate: settleDate(base, terms.termsDays, terms.endOfMonth, terms.observedDaysLate),
            basis: `${completionBasis}, invoiced on completion, ${termsLabel(terms.termsDays, terms.endOfMonth)}${
              terms.observedDaysLate ? `, plus ${Math.round(terms.observedDaysLate)} days this payer runs late` : ""
            }`,
          });
        }
      }

      if (retention > 0) {
        events.push({
          direction: "in",
          confidence: conf,
          kind: "retention",
          jobId: job.id,
          companyId: job.companyId,
          contactId: job.contactId,
          label: `Retention release — job ${job.number}`,
          amount: retention,
          dueDate: addDays(completion, terms.retentionDays ?? 0),
          basis: `${terms.retentionPercent}% held, released ${terms.retentionDays} days after completion`,
        });
      }
    }

    /* ---------------------------- money out -------------------------- */
    const costs = costsByJob.get(job.id) ?? [];
    if (!costs.length && conf !== "pipeline" && (job.value ?? 0) > 0) {
      missingCosts += 1;
      valueMissingCosts += job.value ?? 0;
    }
    for (const c of costs) {
      const cc = confidenceForCost(c.state ?? "budget");
      if (!cc) continue;
      const computed = costDueDate(c.kind ?? "other", start, completion, now);
      const date = c.dueDateLocked && c.dueDate ? c.dueDate : (c.dueDate ?? computed.date);
      events.push({
        direction: "out",
        confidence: conf === "pipeline" ? "pipeline" : cc,
        kind: (c.kind as NewEvent["kind"]) ?? "other",
        jobId: job.id,
        costId: c.id,
        companyId: job.companyId,
        label: `${c.description || c.kind} — job ${job.number}`,
        amount: c.amount ?? 0,
        dueDate: date,
        basis: c.dueDateLocked && c.dueDate ? `date set by hand` : computed.basis,
      });
    }
  }

  /* ------------------------ pipeline from quotes ----------------------- */
  const quoteRows = await db
    .select({ quote: schema.quotes })
    .from(schema.quotes)
    .where(inArray(schema.quotes.status, ["draft", "sent"]));

  for (const { quote } of quoteRows) {
    if (quote.jobId) continue; // already counted through the job
    if ((quote.total ?? 0) <= 0) continue;
    const terms = resolveTerms(quote.companyId, null, byJob, byCompany, { deposits, contactId: quote.contactId });
    const assumedStart = addDays(now, 21);
    events.push({
      direction: "in",
      confidence: "pipeline",
      kind: "customer_payment",
      quoteId: quote.id,
      companyId: quote.companyId,
      contactId: quote.contactId,
      label: `Quote ${quoteRef(quote.number, quote.version)}, not accepted`,
      amount: quote.total ?? 0,
      dueDate: settleDate(assumedStart, terms.termsDays, terms.endOfMonth),
      basis: `unaccepted quote, assuming work 3 weeks out then ${termsLabel(terms.termsDays, terms.endOfMonth)}`,
    });
  }

  await db.delete(schema.cashEvents).where(eq(schema.cashEvents.actual, false));
  for (let i = 0; i < events.length; i += 200) {
    await db.insert(schema.cashEvents).values(events.slice(i, i + 200));
  }

  return {
    events: events.length,
    in: events.filter((e) => e.direction === "in").length,
    out: events.filter((e) => e.direction === "out").length,
    jobsForecast: live.length,
    jobsMissingCosts: missingCosts,
    valueMissingCosts,
  };
}
