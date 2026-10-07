import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import {
  addDays,
  addMonths,
  costDueDate,
  endOfMonth,
  iso,
  jobDeposit,
  loadDepositMaps,
  loadTermsMaps,
  parseIso,
  rebuildForecast,
  resolveTerms,
  settleDate,
  termsLabel,
  today,
  type Confidence,
} from "../lib/cashflow";

/**
 * FINANCE — payment terms, job costs, and the cashflow forecast read model.
 *
 * Three rules this file keeps:
 *
 *  1. Committed, expected and pipeline money are reported separately. An
 *     accepted $40k job is not the same thing as a $40k quote nobody has
 *     signed, and they are never added into one number.
 *  2. Every predicted date carries its reasoning, so a wrong number can be
 *     argued with instead of quietly destroying trust in the whole screen.
 *  3. Where there is no data, the screen says so. Missing job costs are
 *     reported as a gap, not smoothed over.
 */

/** How Damien says each payment structure out loud. */
const STRUCTURE_LABEL: Record<string, string> = {
  deposit_balance: "deposit then balance",
  on_completion: "invoiced on completion",
  progress_claims: "progress claims",
};

const OPENING_BALANCE_KEY = "finance.opening_balance";
const OPENING_DATE_KEY = "finance.opening_balance_date";

const WINDOWS = { "12w": 84, "6m": 183, "12m": 365 } as const;
type WindowKey = keyof typeof WINDOWS;

const money = (n: number) => Math.round(n * 100) / 100;

async function openingBalance() {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [OPENING_BALANCE_KEY, OPENING_DATE_KEY]));
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const amount = Number(kv[OPENING_BALANCE_KEY] ?? "");
  const date = kv[OPENING_DATE_KEY] ?? "";
  const set = Number.isFinite(amount) && !!date;
  return {
    amount: set ? amount : 0,
    date: set ? date : today(),
    /** manual for now. Xero becomes the source for this tile once connected. */
    source: set ? ("manual" as const) : ("unset" as const),
  };
}

interface Bucket {
  label: string;
  start: string;
  end: string;
  inCommitted: number;
  inExpected: number;
  inPipeline: number;
  outCommitted: number;
  outExpected: number;
  outPipeline: number;
  net: number;
  closing: number;
}

function buildBuckets(window: WindowKey, from: string): { label: string; start: string; end: string }[] {
  const out: { label: string; start: string; end: string }[] = [];
  if (window === "12w") {
    // Weeks start on Monday so a bucket matches how the week is actually run.
    const d = parseIso(from);
    const shift = (d.getDay() + 6) % 7;
    let start = addDays(from, -shift);
    for (let i = 0; i < 12; i += 1) {
      const end = addDays(start, 6);
      const s = parseIso(start);
      out.push({
        label: `${s.getDate()} ${s.toLocaleString("en-AU", { month: "short" })}`,
        start,
        end,
      });
      start = addDays(start, 7);
    }
    return out;
  }
  const months = window === "6m" ? 6 : 12;
  const f = parseIso(from);
  let cursor = iso(new Date(f.getFullYear(), f.getMonth(), 1));
  for (let i = 0; i < months; i += 1) {
    const c = parseIso(cursor);
    out.push({
      label: c.toLocaleString("en-AU", { month: "short", year: "2-digit" }),
      start: cursor,
      end: endOfMonth(cursor),
    });
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export const finance = {
  /* ------------------------------ forecast ------------------------------ */

  /**
   * The whole cashflow picture for one window: buckets for the chart, the
   * lowest cash point, and the lists of what is coming in and going out.
   */
  forecast: adminOnly
    .input(
      z
        .object({
          window: z.enum(["12w", "6m", "12m"]).default("12w"),
          /** Pipeline is off by default. Unsigned money never moves the line. */
          includePipeline: z.boolean().default(false),
        })
        .default({ window: "12w", includePipeline: false }),
    )
    .handler(async ({ input }) => {
      const now = today();
      const opening = await openingBalance();
      const buckets = buildBuckets(input.window, now);
      const windowEnd = buckets[buckets.length - 1]!.end;
      const walkFrom = opening.date < now ? opening.date : now;

      const rows = await db
        .select({
          e: schema.cashEvents,
          jobNumber: jobNumberSql,
          companyName: schema.companies.name,
          contactFirst: schema.contacts.firstName,
          contactLast: schema.contacts.lastName,
        })
        .from(schema.cashEvents)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.cashEvents.jobId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.cashEvents.companyId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.cashEvents.contactId))
        .where(and(gte(schema.cashEvents.dueDate, walkFrom), lte(schema.cashEvents.dueDate, windowEnd)))
        .orderBy(asc(schema.cashEvents.dueDate));

      const counted = (c: string) => c !== "pipeline" || input.includePipeline;

      const events = rows.map((r) => ({
        id: r.e.id,
        direction: r.e.direction as "in" | "out",
        confidence: r.e.confidence as Confidence,
        kind: r.e.kind,
        label: r.e.label,
        amount: r.e.amount,
        dueDate: r.e.dueDate,
        basis: r.e.basis,
        jobId: r.e.jobId,
        jobNumber: r.jobNumber,
        who:
          r.companyName ??
          [r.contactFirst, r.contactLast].filter(Boolean).join(" ") ??
          "",
        overdue: r.e.dueDate < now && !r.e.actual,
      }));

      /* ---- daily walk, for the balance line and the lowest cash point ---- */
      const byDay = new Map<string, number>();
      for (const e of events) {
        if (!counted(e.confidence)) continue;
        const delta = e.direction === "in" ? e.amount : -e.amount;
        byDay.set(e.dueDate, (byDay.get(e.dueDate) ?? 0) + delta);
      }

      let balance = opening.amount;
      const daily: { date: string; balance: number }[] = [];
      let cursor = walkFrom;
      while (cursor <= windowEnd) {
        balance += byDay.get(cursor) ?? 0;
        daily.push({ date: cursor, balance: money(balance) });
        cursor = addDays(cursor, 1);
      }

      // Lowest point is only interesting from today forward.
      const forward = daily.filter((d) => d.date >= now);
      let lowest = forward[0] ?? { date: now, balance: money(opening.amount) };
      for (const d of forward) if (d.balance < lowest.balance) lowest = d;

      const outBefore = events
        .filter((e) => e.direction === "out" && counted(e.confidence) && e.dueDate >= now && e.dueDate <= lowest.date)
        .reduce((a, e) => a + e.amount, 0);
      const inBefore = events
        .filter((e) => e.direction === "in" && counted(e.confidence) && e.dueDate >= now && e.dueDate <= lowest.date)
        .reduce((a, e) => a + e.amount, 0);
      const inAfterWindow = addDays(lowest.date, 21);
      const inAfter = events
        .filter(
          (e) =>
            e.direction === "in" &&
            counted(e.confidence) &&
            e.dueDate > lowest.date &&
            e.dueDate <= inAfterWindow,
        )
        .reduce((a, e) => a + e.amount, 0);

      const day30 = addDays(now, 30);
      const closing30 =
        daily.find((d) => d.date === day30)?.balance ?? daily[daily.length - 1]?.balance ?? 0;

      /* ----------------------------- buckets ----------------------------- */
      const filled: Bucket[] = [];
      let running = daily.find((d) => d.date === buckets[0]!.start)?.balance ?? opening.amount;
      for (const b of buckets) {
        const slice = events.filter((e) => e.dueDate >= b.start && e.dueDate <= b.end);
        const sum = (dir: "in" | "out", conf: Confidence) =>
          money(
            slice
              .filter((e) => e.direction === dir && e.confidence === conf)
              .reduce((a, e) => a + e.amount, 0),
          );
        const bucket: Bucket = {
          label: b.label,
          start: b.start,
          end: b.end,
          inCommitted: sum("in", "committed"),
          inExpected: sum("in", "expected"),
          inPipeline: sum("in", "pipeline"),
          outCommitted: sum("out", "committed"),
          outExpected: sum("out", "expected"),
          outPipeline: sum("out", "pipeline"),
          net: 0,
          closing: 0,
        };
        const inC = bucket.inCommitted + bucket.inExpected + (input.includePipeline ? bucket.inPipeline : 0);
        const outC =
          bucket.outCommitted + bucket.outExpected + (input.includePipeline ? bucket.outPipeline : 0);
        bucket.net = money(inC - outC);
        running = money(daily.find((d) => d.date === b.end)?.balance ?? running + bucket.net);
        bucket.closing = running;
        filled.push(bucket);
      }

      const total = (dir: "in" | "out", conf: Confidence) =>
        money(
          events
            .filter((e) => e.direction === dir && e.confidence === conf)
            .reduce((a, e) => a + e.amount, 0),
        );

      /* ------------------------------- gaps ------------------------------ */
      const [gapRow] = await db
        .select({
          jobs: sql<number>`count(*)`,
          value: sql<number>`coalesce(sum(${schema.jobs.value}), 0)`,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .where(
          and(
            inArray(schema.jobStatuses.stage, ["won", "scheduled", "active", "complete"]),
            sql`${schema.jobs.value} > 0`,
            sql`not exists (select 1 from job_costs c where c.job_id = jobs.id)`,
          ),
        );

      return {
        window: input.window,
        from: buckets[0]!.start,
        to: windowEnd,
        today: now,
        opening,
        buckets: filled,
        daily: daily.filter((d) => d.date >= now),
        totals: {
          inCommitted: total("in", "committed"),
          inExpected: total("in", "expected"),
          inPipeline: total("in", "pipeline"),
          outCommitted: total("out", "committed"),
          outExpected: total("out", "expected"),
          outPipeline: total("out", "pipeline"),
        },
        lowest: {
          date: lowest.date,
          balance: lowest.balance,
          outBefore: money(outBefore),
          inBefore: money(inBefore),
          inAfter: money(inAfter),
          inAfterTo: inAfterWindow,
        },
        closing30,
        closing30Date: day30,
        upcomingIn: events
          .filter((e) => e.direction === "in")
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .slice(0, 40),
        upcomingOut: events
          .filter((e) => e.direction === "out")
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .slice(0, 40),
        gaps: {
          jobsMissingCosts: Number(gapRow?.jobs ?? 0),
          valueMissingCosts: money(Number(gapRow?.value ?? 0)),
        },
      };
    }),

  /** Recompute every predicted event. Cheap enough to run on demand. */
  rebuild: adminOnly.handler(() => rebuildForecast()),

  /* --------------------------- opening balance -------------------------- */

  /**
   * The bank balance the forecast starts from. Typed by hand today; Xero takes
   * over this tile once connected and this stays as the fallback.
   */
  openingBalanceGet: adminOnly.handler(() => openingBalance()),

  openingBalanceSet: adminOnly
    .input(z.object({ amount: z.number(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
    .handler(async ({ input }) => {
      for (const [key, value] of [
        [OPENING_BALANCE_KEY, String(input.amount)],
        [OPENING_DATE_KEY, input.date],
      ] as const) {
        await db
          .insert(schema.settings)
          .values({ key, value, updatedAt: new Date() })
          .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
      }
      await rebuildForecast();
      return openingBalance();
    }),

  /* ------------------------------- terms -------------------------------- */

  /** The terms that actually apply to a job or company, and where they came from. */
  termsGet: adminOnly
    .input(z.object({ companyId: z.number().optional(), jobId: z.number().optional() }))
    .handler(async ({ input }) => {
      const [{ byJob, byCompany, milestones }, deposits] = await Promise.all([loadTermsMaps(), loadDepositMaps()]);
      let companyId = input.companyId ?? null;
      let contactId: number | null = null;
      if (input.jobId) {
        const [job] = await db
          .select({ companyId: schema.jobs.companyId, contactId: schema.jobs.contactId })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, input.jobId));
        companyId = companyId ?? job?.companyId ?? null;
        contactId = job?.contactId ?? null;
      }
      const card = { deposits, contactId };
      const resolved = resolveTerms(companyId, input.jobId ?? null, byJob, byCompany, card);
      return {
        resolved,
        companyRow: companyId ? (byCompany.get(companyId) ?? null) : null,
        jobRow: input.jobId ? (byJob.get(input.jobId) ?? null) : null,
        milestones: resolved.id ? (milestones.get(resolved.id) ?? []) : [],
        // Terra's standard for this payer, with the deposit off the card.
        defaults: resolveTerms(companyId, null, new Map(), new Map(), card),
        label: termsLabel(resolved.termsDays, resolved.endOfMonth),
      };
    }),

  /** Write terms for a company (their standard) or a job (the override). */
  termsSet: adminOnly
    .input(
      z.object({
        companyId: z.number().nullable().default(null),
        jobId: z.number().nullable().default(null),
        structure: z.enum(["deposit_balance", "on_completion", "progress_claims"]),
        depositPercent: z.number().min(0).max(100).default(0),
        termsFrom: z.enum(["invoice", "completion"]).default("invoice"),
        termsDays: z.number().int().min(0).max(180).default(30),
        endOfMonth: z.boolean().default(false),
        retentionPercent: z.number().min(0).max(100).default(0),
        retentionDays: z.number().int().min(0).max(730).default(0),
        /** What this payer actually does, on top of what they promised. */
        observedDaysLate: z.number().min(0).max(120).default(0),
        notes: z.string().default(""),
      }),
    )
    .handler(async ({ input }) => {
      const { companyId, jobId, ...rest } = input;
      if (!companyId === !jobId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Terms belong to exactly one of a company or a job",
        });
      }
      const existing = await db
        .select()
        .from(schema.paymentTerms)
        .where(jobId ? eq(schema.paymentTerms.jobId, jobId) : eq(schema.paymentTerms.companyId, companyId!));

      let row;
      if (existing.length) {
        [row] = await db
          .update(schema.paymentTerms)
          .set({ ...rest, updatedAt: new Date() })
          .where(eq(schema.paymentTerms.id, existing[0]!.id))
          .returning();
      } else {
        [row] = await db
          .insert(schema.paymentTerms)
          .values({ companyId, jobId, ...rest })
          .returning();
      }
      // A company's deposit is ONE setting: the % on the company card, which
      // also prefills new quotes. Saving the terms writes it there. Progress
      // claims carry their own stages and leave the card alone.
      if (companyId && input.structure !== "progress_claims") {
        await db
          .update(schema.companies)
          .set({ depositPercent: input.structure === "deposit_balance" ? input.depositPercent : 0, updatedAt: new Date() })
          .where(eq(schema.companies.id, companyId));
      }
      await rebuildForecast();
      return row;
    }),

  /**
   * Drop a terms row so whatever sits under it takes over again. A job falls
   * back to its company, a company falls back to Terra's standard.
   */
  termsClear: adminOnly
    .input(
      z.object({
        jobId: z.number().nullable().default(null),
        companyId: z.number().nullable().default(null),
      }),
    )
    .handler(async ({ input }) => {
      const { jobId, companyId } = input;
      if (!companyId === !jobId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Clear terms on exactly one of a company or a job",
        });
      }
      const where = jobId
        ? eq(schema.paymentTerms.jobId, jobId)
        : eq(schema.paymentTerms.companyId, companyId!);
      const doomed = await db.select({ id: schema.paymentTerms.id }).from(schema.paymentTerms).where(where);
      for (const row of doomed) {
        await db.delete(schema.paymentMilestones).where(eq(schema.paymentMilestones.termsId, row.id));
      }
      await db.delete(schema.paymentTerms).where(where);
      await rebuildForecast();
      return { ok: true, cleared: doomed.length };
    }),

  milestoneSet: adminOnly
    .input(
      z.object({
        termsId: z.number(),
        stages: z
          .array(
            z.object({
              seq: z.number().int(),
              label: z.string().default(""),
              percent: z.number().min(0).max(100),
              trigger: z.enum(["acceptance", "order", "delivery", "start", "completion", "fixed_date"]),
              offsetDays: z.number().int().default(0),
              onDate: z.string().nullable().default(null),
            }),
          )
          .default([]),
      }),
    )
    .handler(async ({ input }) => {
      await db
        .delete(schema.paymentMilestones)
        .where(eq(schema.paymentMilestones.termsId, input.termsId));
      if (input.stages.length) {
        await db
          .insert(schema.paymentMilestones)
          .values(input.stages.map((s) => ({ ...s, termsId: input.termsId })));
      }
      await rebuildForecast();
      return db
        .select()
        .from(schema.paymentMilestones)
        .where(eq(schema.paymentMilestones.termsId, input.termsId))
        .orderBy(asc(schema.paymentMilestones.seq));
    }),

  /* ------------------------------- costs -------------------------------- */

  /**
   * The job's money-out side, with the gross profit that falls out of it.
   * Nothing is estimated on Terra's behalf: a job with no costs entered shows
   * no margin rather than a flattering guess.
   */
  jobBudget: adminOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

    const [costs, suppliers, installers, { byJob, byCompany, milestones }, deposits] = await Promise.all([
      db
        .select({
          cost: schema.jobCosts,
          supplierName: schema.suppliers.name,
          installerName: schema.installers.name,
        })
        .from(schema.jobCosts)
        .leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.jobCosts.supplierId))
        .leftJoin(schema.installers, eq(schema.installers.id, schema.jobCosts.installerId))
        .where(eq(schema.jobCosts.jobId, input.jobId))
        .orderBy(asc(schema.jobCosts.kind), asc(schema.jobCosts.id)),
      db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers),
      db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers),
      loadTermsMaps(),
      loadDepositMaps(),
    ]);

    const terms = resolveTerms(job.companyId, job.id, byJob, byCompany, { deposits, contactId: job.contactId });
    const start = job.scheduledStart ? iso(job.scheduledStart) : null;
    const completion = job.completedAt ? iso(job.completedAt) : start ? addDays(start, 2) : null;

    const byKind = (kind: string) =>
      money(costs.filter((c) => c.cost.kind === kind).reduce((a, c) => a + (c.cost.amount ?? 0), 0));
    const materials = byKind("materials");
    const installer = byKind("installer");
    const other = byKind("other");
    const totalCost = money(materials + installer + other);
    const grossProfit = money((job.value ?? 0) - totalCost);

    // The number Damien asked for: how much of Terra's own cash the job eats
    // before the customer pays anything.
    const receiptDate = settleDate(
      completion ?? addDays(today(), 21),
      terms.termsDays,
      terms.endOfMonth,
      terms.observedDaysLate,
    );
    const deposit = money(jobDeposit(job, terms, job.value ?? 0).amount);
    const outBeforeReceipt = money(
      costs
        .filter((c) => {
          if (c.cost.state === "paid") return false;
          const d =
            c.cost.dueDate ?? costDueDate(c.cost.kind, start, completion, today()).date;
          return d <= receiptDate;
        })
        .reduce((a, c) => a + (c.cost.amount ?? 0), 0),
    );

    return {
      job,
      costs: costs.map((c) => ({
        ...c.cost,
        supplierName: c.supplierName,
        installerName: c.installerName,
        computedDue: costDueDate(c.cost.kind, start, completion, today()),
      })),
      suppliers,
      installers,
      terms: {
        ...terms,
        label: termsLabel(terms.termsDays, terms.endOfMonth),
        structureLabel: STRUCTURE_LABEL[terms.structure] ?? terms.structure,
      },
      milestones: terms.id ? (milestones.get(terms.id) ?? []) : [],
      summary: {
        value: money(job.value ?? 0),
        materials,
        installer,
        other,
        totalCost,
        grossProfit,
        marginPercent: job.value ? money((grossProfit / job.value) * 100) : null,
        hasCosts: costs.length > 0,
        receiptDate,
        deposit,
        cashRequirement: money(Math.max(0, outBeforeReceipt - deposit)),
        outBeforeReceipt,
      },
    };
  }),

  costSave: adminOnly
    .input(
      z.object({
        id: z.number().optional(),
        jobId: z.number(),
        kind: z.enum(["materials", "installer", "other"]),
        description: z.string().default(""),
        supplierId: z.number().nullable().default(null),
        installerId: z.number().nullable().default(null),
        amount: z.number().min(0),
        state: z.enum(["budget", "committed", "invoiced", "paid"]).default("budget"),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
        dueDateLocked: z.boolean().default(false),
        invoiceRef: z.string().nullable().default(null),
        notes: z.string().default(""),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const paidAt = rest.state === "paid" ? new Date() : null;
      let row;
      if (id) {
        [row] = await db
          .update(schema.jobCosts)
          .set({ ...rest, paidAt, updatedAt: new Date() })
          .where(eq(schema.jobCosts.id, id))
          .returning();
      } else {
        [row] = await db.insert(schema.jobCosts).values({ ...rest, paidAt }).returning();
      }
      await rebuildForecast();
      return row;
    }),

  costDelete: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, input.id));
    await rebuildForecast();
    return { ok: true };
  }),

  /* ------------------------ expenses & receipts ------------------------- */

  /** Everything owed out, across every job, soonest first. */
  expenses: adminOnly
    .input(z.object({ days: z.number().int().min(7).max(365).default(60) }).default({ days: 60 }))
    .handler(async ({ input }) => {
      const now = today();
      const to = addDays(now, input.days);
      const rows = await db
        .select({
          cost: schema.jobCosts,
          jobNumber: jobNumberSql,
          jobTitle: schema.jobs.title,
          supplierName: schema.suppliers.name,
          installerName: schema.installers.name,
        })
        .from(schema.jobCosts)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobCosts.jobId))
        .leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.jobCosts.supplierId))
        .leftJoin(schema.installers, eq(schema.installers.id, schema.jobCosts.installerId))
        .where(
          and(
            sql`${schema.jobCosts.state} != 'paid'`,
            or(isNull(schema.jobCosts.dueDate), lte(schema.jobCosts.dueDate, to)),
          ),
        )
        .orderBy(asc(schema.jobCosts.dueDate));

      return rows.map((r) => ({
        ...r.cost,
        jobNumber: r.jobNumber,
        jobTitle: r.jobTitle,
        who: r.supplierName ?? r.installerName ?? "",
        overdue: !!r.cost.dueDate && r.cost.dueDate < now,
      }));
    }),

  /** Customer money owed in, from the forecast rather than from invoices alone. */
  receipts: adminOnly
    .input(z.object({ days: z.number().int().min(7).max(365).default(60) }).default({ days: 60 }))
    .handler(async ({ input }) => {
      const now = today();
      const to = addDays(now, input.days);
      const rows = await db
        .select({
          e: schema.cashEvents,
          jobNumber: jobNumberSql,
          companyName: schema.companies.name,
          contactFirst: schema.contacts.firstName,
          contactLast: schema.contacts.lastName,
        })
        .from(schema.cashEvents)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.cashEvents.jobId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.cashEvents.companyId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.cashEvents.contactId))
        .where(
          and(
            eq(schema.cashEvents.direction, "in"),
            eq(schema.cashEvents.actual, false),
            lte(schema.cashEvents.dueDate, to),
          ),
        )
        .orderBy(asc(schema.cashEvents.dueDate));

      return rows.map((r) => ({
        ...r.e,
        jobNumber: r.jobNumber,
        who: r.companyName ?? [r.contactFirst, r.contactLast].filter(Boolean).join(" "),
        overdue: r.e.dueDate < now,
      }));
    }),

  /* ------------------------------ invoices ------------------------------ */

  /**
   * Issued invoices with their ageing. Separate from the forecast on purpose:
   * this is money already billed, the forecast also carries agreed work that
   * has not been billed yet. The two numbers disagreeing is normal and useful.
   */
  invoiceList: adminOnly
    .input(
      z
        .object({
          status: z.enum(["all", "unpaid", "overdue", "paid"]).default("unpaid"),
          limit: z.number().int().min(20).max(500).default(200),
        })
        .default({ status: "unpaid", limit: 200 }),
    )
    .handler(async ({ input }) => {
      const now = today();
      const rows = await db
        .select({
          i: schema.invoices,
          jobNumber: jobNumberSql,
          jobTitle: schema.jobs.title,
          companyName: schema.companies.name,
          contactFirst: schema.contacts.firstName,
          contactLast: schema.contacts.lastName,
        })
        .from(schema.invoices)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.invoices.jobId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.invoices.billToCompanyId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.invoices.billToContactId))
        .orderBy(desc(schema.invoices.number))
        .limit(input.limit);

      const shaped = rows.map((r) => {
        const due = r.i.dueDate ? iso(r.i.dueDate) : null;
        const outstanding = money((r.i.total ?? 0) - (r.i.amountPaid ?? 0));
        const settled = r.i.status === "paid" || r.i.status === "void" || outstanding <= 0;
        const daysOverdue = due && !settled && due < now ? Math.round((parseIso(now).getTime() - parseIso(due).getTime()) / 86_400_000) : 0;
        return {
          id: r.i.id,
          number: r.i.number,
          status: r.i.status,
          total: money(r.i.total ?? 0),
          amountPaid: money(r.i.amountPaid ?? 0),
          outstanding,
          dueDate: due,
          paidAt: r.i.paidAt ? iso(r.i.paidAt) : null,
          jobId: r.i.jobId,
          jobNumber: r.jobNumber,
          jobTitle: r.jobTitle,
          who: r.companyName ?? [r.contactFirst, r.contactLast].filter(Boolean).join(" "),
          settled,
          daysOverdue,
          /** current · 1-30 · 31-60 · 60+, the ageing buckets Terra chases on. */
          ageing:
            settled || daysOverdue <= 0
              ? ("current" as const)
              : daysOverdue <= 30
                ? ("1-30" as const)
                : daysOverdue <= 60
                  ? ("31-60" as const)
                  : ("60+" as const),
        };
      });

      const filtered = shaped.filter((r) =>
        input.status === "all"
          ? true
          : input.status === "paid"
            ? r.settled
            : input.status === "overdue"
              ? !r.settled && r.daysOverdue > 0
              : !r.settled,
      );

      const sum = (rs: typeof shaped) => money(rs.reduce((a, r) => a + r.outstanding, 0));
      const unpaid = shaped.filter((r) => !r.settled);
      return {
        rows: filtered,
        summary: {
          count: shaped.length,
          outstanding: sum(unpaid),
          overdue: sum(unpaid.filter((r) => r.daysOverdue > 0)),
          ageing: {
            current: sum(unpaid.filter((r) => r.ageing === "current")),
            d30: sum(unpaid.filter((r) => r.ageing === "1-30")),
            d60: sum(unpaid.filter((r) => r.ageing === "31-60")),
            older: sum(unpaid.filter((r) => r.ageing === "60+")),
          },
        },
      };
    }),

  /** Company payment terms list, for the Finance area. */
  termsList: adminOnly.handler(async () => {
    const rows = await db
      .select({ terms: schema.paymentTerms, companyName: schema.companies.name })
      .from(schema.paymentTerms)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.paymentTerms.companyId))
      .where(sql`${schema.paymentTerms.companyId} is not null`)
      .orderBy(asc(schema.companies.name));
    return rows.map((r) => ({
      ...r.terms,
      companyName: r.companyName ?? "",
      label: termsLabel(r.terms.termsDays, !!r.terms.endOfMonth),
    }));
  }),
};
