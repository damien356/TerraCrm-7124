import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { acceptedQuoteOf } from "./final-invoice";
import { quoteRefOf } from "./quote-number";
import { isEmployee } from "./worker-type";
import { COUNTED_STATUSES, WORK_KINDS } from "./variations";
import { PART_COMPLETE_STATUS } from "./staged-guard";

/* ---------------------------------------------------------------------------
 * STAGED JOBS AND PROGRESS PAYMENTS (Damien, 12 Nov 2026).
 *
 * One job, several visits. The customer or builder asks for the work in
 * stages, or the rest of the site is not ready part way through. Terra's rule:
 *
 *  - the full agreed MATERIAL selling amount is due when the staging is agreed,
 *    less the deposit and anything already invoiced;
 *  - customer LABOUR is invoiced as each stage is finished;
 *  - the price never changes and no fee is added for staging;
 *  - the accepted quote and its invoices are never rewritten.
 *
 * Selling values come ONLY from the accepted quote's own lines (or a split the
 * office types and approves when the quote is one bundled price). Installer pay
 * comes ONLY from the task's locked pay lines. The two never mix: "What this job
 * makes" shows costs, and costs are never used as a selling split.
 *
 * This file: the selling split, the plan (setup, preview, checks, save, agree),
 * finishing a stage, approving stage pay and handing the rest to another
 * installer. Billing, reconciliation and the crew view: lib/staged-billing.ts.
 * ------------------------------------------------------------------------- */

export const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const QTY_EPS = 0.0001;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const PLAN_KINDS = ["planned", "hold"] as const;
export const PLAN_KIND_LABEL: Record<string, string> = {
  planned: "Planned staging, agreed before the work",
  hold: "Held after work started, the rest is not ready",
};
export const STAGE_REASONS = ["client_requested", "kitchen_not_ready", "other_trades", "site_not_ready", "other"] as const;
export const STAGE_REASON_LABEL: Record<string, string> = {
  client_requested: "Client/builder requested staging",
  kitchen_not_ready: "Kitchen not ready",
  other_trades: "Waiting for other trades",
  site_not_ready: "Site not ready",
  other: "Other",
};
export const CONFIRM_HOWS = ["email", "sms", "signed", "letter", "other"] as const;
export const VARIATION_TIMINGS = ["final", "with_materials"] as const;
export const VARIATION_TIMING_LABEL: Record<string, string> = {
  final: "On the final invoice (the standing rule)",
  with_materials: "Their material part now, with the materials",
};

/** Brief section 2, word for word. The office adds the job's own amounts and dates under it. */
export const CUSTOMER_WORDING: Record<(typeof PLAN_KINDS)[number], string> = {
  planned:
    "As the work is being split into stages at your request, payment for the full material amount for the agreed job is required when we confirm the staged arrangement. Labour will be invoiced as each stage is completed, with the remaining labour balance invoiced when the later stage is finished. Any deposit and payments already received will be credited to your job account. We will provide the amounts and stage schedule for your confirmation.",
  hold: "As the remaining work is being held until your site is ready, we will prepare a progress invoice covering the full agreed material amount and the labour completed to date, allowing for your existing deposit and previous billing. The remaining labour will be invoiced when that work is completed. We will confirm the breakdown with you before arranging the return visit.",
};

export type Actor = { name: string; role: string };

/* ------------------------------- inputs -------------------------------- */

export type StageLineIn = { quoteItemId: number; qty: number; amountInc?: number | null };
export type StagePayIn = { taskId: number; lineKey: string; qty: number; amount?: number | null; estimatedHours?: number | null };
export type StageIn = {
  name: string;
  scope: string;
  plannedDate: string | null;
  awaitingReadiness: boolean;
  lines: StageLineIn[];
  pay: StagePayIn[];
};
export type PlanIn = {
  jobId: number;
  kind: (typeof PLAN_KINDS)[number];
  reason: (typeof STAGE_REASONS)[number];
  reasonNote: string;
  requestedBy: string;
  requestedOn: string | null;
  arrangement: string;
  followUpDate: string | null;
  variationTiming: (typeof VARIATION_TIMINGS)[number];
  materialsLocation: string;
  /** The office's own split, when the quote's lines cannot give one or should not. GST inclusive. */
  split: { materialsInc: number; labourInc: number; note: string } | null;
  /** The office approves the selling split (needed for a bundled price or a typed split). */
  approveSplit: boolean;
  stages: StageIn[];
};

/* ---------------------------- selling split ---------------------------- */

export type LabourLine = { quoteItemId: number; description: string; unit: string; qty: number; amountEx: number; amountInc: number };

export type SellingSplit = {
  quoteId: number;
  quoteRef: string;
  quoteTotal: number;
  quoteSubtotal: number;
  /** What the client was shown: one bundled price, or the lines. */
  bundled: boolean;
  /** Lines add back to the quote's subtotal (no fee or discount sitting on top). */
  linesAddBack: boolean;
  materialsEx: number;
  labourEx: number;
  materialsInc: number | null;
  labourInc: number | null;
  source: "quote_lines" | "office";
  /** The quote_lines split has a rounding cent on labour so the two add back exactly. */
  roundingOnLabour: number;
  needsApproval: boolean;
  labourLines: LabourLine[];
  issue: string | null;
};

/** The material and labour selling split of the accepted quote, inc GST, adding back exactly to its total. */
export function sellingSplitOf(
  quote: typeof schema.quotes.$inferSelect,
  quoteRef: string,
  items: (typeof schema.quoteItems.$inferSelect)[],
  override: { materialsInc: number; labourInc: number } | null,
): SellingSplit {
  const lineSum = round2(items.reduce((s, i) => s + (i.total ?? 0), 0));
  const labourItems = items.filter((i) => i.lineType === "labour");
  const labourEx = round2(labourItems.reduce((s, i) => s + (i.total ?? 0), 0));
  const materialsEx = round2(lineSum - labourEx);
  const linesAddBack = Math.abs(lineSum - quote.subtotal) < 0.005;
  const bundled = quote.bundleMode === "combined" && quote.layout !== "itemised";
  const total = round2(quote.total);

  let materialsInc: number | null = null;
  let labourInc: number | null = null;
  let source: SellingSplit["source"] = "quote_lines";
  let issue: string | null = null;
  let roundingOnLabour = 0;
  if (!labourItems.length) issue = "The accepted quote has no labour lines, so there is no labour to stage.";
  if (override) {
    source = "office";
    materialsInc = round2(override.materialsInc);
    labourInc = round2(override.labourInc);
    if (materialsInc < 0 || labourInc < 0) issue = "The split cannot have a negative amount.";
    else if (Math.abs(materialsInc + labourInc - total) > 0.005) {
      issue = `The split adds up to ${money(materialsInc + labourInc)}, not the accepted ${money(total)}. It must add back exactly.`;
    }
  } else if (linesAddBack) {
    materialsInc = round2(materialsEx * 1.1);
    labourInc = round2(total - materialsInc);
    roundingOnLabour = round2(labourInc - labourEx * 1.1);
  } else {
    issue = `The quote's lines add up to ${money(lineSum)} ex GST but its subtotal is ${money(quote.subtotal)} (a fee or discount on top). Type the material and labour split and approve it.`;
  }

  // Each labour line's share of the labour selling value, the last cent on the biggest line.
  const labourLines: LabourLine[] = labourItems.map((i) => ({
    quoteItemId: i.id,
    description: i.description,
    unit: i.unit,
    qty: i.qty,
    amountEx: round2(i.total),
    amountInc: labourInc != null && labourEx > 0 ? round2((labourInc * i.total) / labourEx) : 0,
  }));
  if (labourInc != null && labourLines.length) {
    const gap = round2(labourInc - labourLines.reduce((s, l) => s + l.amountInc, 0));
    if (gap !== 0) {
      const big = labourLines.reduce((a, b) => (b.amountEx > a.amountEx ? b : a));
      big.amountInc = round2(big.amountInc + gap);
    }
  }

  return {
    quoteId: quote.id,
    quoteRef,
    quoteTotal: total,
    quoteSubtotal: round2(quote.subtotal),
    bundled,
    linesAddBack,
    materialsEx,
    labourEx,
    materialsInc,
    labourInc,
    source,
    roundingOnLabour,
    needsApproval: bundled || source === "office" || !linesAddBack,
    labourLines,
    issue,
  };
}

/* ------------------------------ pay lines ------------------------------ */

export type PayLine = { lineKey: string; description: string; unit: string; qty: number; rate: number | null; total: number };

export type TaskPay = {
  taskId: number;
  title: string;
  seq: number;
  status: string;
  installerId: number | null;
  installerName: string | null;
  /** lines · flat · hourly · employee · unset · invoiced */
  mode: "lines" | "flat" | "hourly" | "employee" | "unset" | "invoiced";
  lines: PayLine[];
  total: number;
  /** Approved extras on this task, ex GST. Claimed on his invoice as now, never split. */
  extras: { id: number; description: string; amount: number; invoiced: boolean }[];
  note: string | null;
};

/** The task's locked pay, line by line, the same basis as his invoice. */
export function payLinesOfTask(task: typeof schema.jobTasks.$inferSelect): PayLine[] {
  if (task.payType === "hourly") return [];
  if (task.labourBreakdown) {
    try {
      const parsed = JSON.parse(task.labourBreakdown) as Array<{ name: string; unit: string; qty: number; rate: number | null; total: number | null }>;
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((l, i) => ({
          lineKey: `line:${i}`,
          description: l.name,
          unit: l.unit,
          qty: Number(l.qty) || 0,
          rate: l.rate ?? null,
          total: round2(Number(l.total) || 0),
        }));
      }
    } catch {
      // fall through to the flat amount
    }
  }
  if (task.payAmount != null && task.payAmount > 0) {
    return [{ lineKey: "flat", description: task.title, unit: "job", qty: 1, rate: task.payAmount, total: round2(task.payAmount) }];
  }
  return [];
}

/* ------------------------------- context ------------------------------- */

export type PlanRow = typeof schema.jobStagePlans.$inferSelect;
export type StageRow = typeof schema.jobStages.$inferSelect;

export async function loadJobContext(jobId: number, opts: { planId?: number } = {}) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const quote = await acceptedQuoteOf(jobId);
  const [plan] = opts.planId
    ? await db.select().from(schema.jobStagePlans).where(eq(schema.jobStagePlans.id, opts.planId))
    : await db
        .select()
        .from(schema.jobStagePlans)
        // A finished plan still shows: the Final, the last claims and the reconciliation hang off it.
        // Damien, 12 Nov 2026.
        .where(and(eq(schema.jobStagePlans.jobId, jobId), inArray(schema.jobStagePlans.status, ["draft", "agreed", "complete"])))
        .orderBy(desc(schema.jobStagePlans.id))
        .limit(1);
  const [items, tasks, stages, lines, pay, vars] = await Promise.all([
    quote ? db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id)).orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id)) : [],
    db
      .select()
      .from(schema.jobTasks)
      .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
      .orderBy(asc(schema.jobTasks.seq)),
    plan ? db.select().from(schema.jobStages).where(eq(schema.jobStages.planId, plan.id)).orderBy(asc(schema.jobStages.seq)) : [],
    plan ? db.select().from(schema.jobStageLines).where(eq(schema.jobStageLines.planId, plan.id)) : [],
    plan ? db.select().from(schema.jobStagePay).where(eq(schema.jobStagePay.planId, plan.id)) : [],
    db
      .select()
      .from(schema.variations)
      .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, [...COUNTED_STATUSES]))),
  ]);
  const taskIds = tasks.map((t) => t.id);
  const instIds = [...new Set([...tasks.map((t) => t.assignedInstallerId), ...pay.map((p) => p.installerId)].filter((x): x is number => x != null))];
  const [installers, priorClaims, extras, varItems] = await Promise.all([
    instIds.length ? db.select().from(schema.installers).where(inArray(schema.installers.id, instIds)) : [],
    taskIds.length ? db.select().from(schema.installerInvoices).where(inArray(schema.installerInvoices.taskId, taskIds)) : [],
    taskIds.length
      ? db
          .select()
          .from(schema.installerVariationRequests)
          .where(and(inArray(schema.installerVariationRequests.taskId, taskIds), eq(schema.installerVariationRequests.status, "approved")))
      : [],
    vars.length ? db.select().from(schema.variationItems).where(inArray(schema.variationItems.variationId, vars.map((v) => v.id))) : [],
  ]);
  const quoteRef = quote ? await quoteRefOf(quote) : null;
  const instById = new Map(installers.map((i) => [i.id, i]));
  const stageClaimIds = new Set(pay.map((p) => p.claimInvoiceId).filter((x): x is number => x != null));

  const taskPay: TaskPay[] = tasks.map((t) => {
    const inst = t.assignedInstallerId != null ? instById.get(t.assignedInstallerId) : undefined;
    const lines = payLinesOfTask(t);
    // A whole-task invoice raised before the staging (not one of the stage claims) means his pay is already billed in full.
    const wholeTask = priorClaims.find((c) => c.taskId === t.id && !stageClaimIds.has(c.id) && !pay.some((p) => p.taskId === t.id));
    const mode: TaskPay["mode"] =
      inst && isEmployee(inst)
        ? "employee"
        : wholeTask
          ? "invoiced"
          : t.payType === "hourly"
            ? "hourly"
            : lines.length === 0
              ? "unset"
              : lines[0]!.lineKey === "flat"
                ? "flat"
                : "lines";
    return {
      taskId: t.id,
      title: t.title,
      seq: t.seq,
      status: t.status,
      installerId: t.assignedInstallerId,
      installerName: inst?.name ?? null,
      mode,
      lines,
      total: round2(lines.reduce((s, l) => s + l.total, 0)),
      extras: extras
        .filter((e) => e.taskId === t.id)
        .map((e) => ({ id: e.id, description: e.description, amount: round2(e.amount ?? 0), invoiced: e.invoiceId != null })),
      note:
        mode === "employee"
          ? "Employee. Paid through payroll, so there is no stage claim."
          : mode === "invoiced"
            ? `Already invoiced in full by the installer (invoice #${wholeTask!.invoiceNumber}). Nothing left to split.`
            : mode === "hourly"
              ? "Hourly. Paid from approved timesheets only. Hours per stage are an estimate, never an entitlement."
              : mode === "unset"
                ? "Pay not set yet. Terra office must confirm the agreed pay before it can be split."
                : null,
    };
  });

  const split = quote && quoteRef
    ? sellingSplitOf(quote, quoteRef, items, plan && plan.splitSource === "office" ? { materialsInc: plan.materialsInc, labourInc: plan.labourInc } : null)
    : null;

  // Approved customer variations, inc GST, and their material part.
  const variations = vars.map((v) => {
    const its = varItems.filter((i) => i.variationId === v.id);
    const workEx = its.filter((i) => WORK_KINDS.has(i.kind)).reduce((s, i) => s + (i.total ?? 0), 0);
    const exAll = its.reduce((s, i) => s + (i.total ?? 0), 0);
    const total = round2(v.total ?? 0);
    const materialInc = exAll > 0 ? round2((total * (exAll - workEx)) / exAll) : total;
    return { id: v.id, ref: v.ref, description: v.description ?? "", total, materialInc, labourInc: round2(total - materialInc) };
  });

  return { job, quote, quoteRef, items, tasks, taskPay, plan: plan ?? null, stages, lines, pay, split, variations, instById, priorClaims };
}

export type JobContext = Awaited<ReturnType<typeof loadJobContext>>;

/* ------------------------ build, check, preview ------------------------ */

/** Splits `total` across stages: typed amounts stay, the rest follows quantity, the last cent on the last stage with any. */
export function allocate(total: number, parts: { qty: number; typed: number | null }[]): { amounts: number[]; issue: string | null } {
  const typedSum = round2(parts.reduce((s, p) => s + (p.typed ?? 0), 0));
  const free = parts.map((p, i) => ({ ...p, i })).filter((p) => p.typed == null);
  const freeQty = free.reduce((s, p) => s + p.qty, 0);
  const rest = round2(total - typedSum);
  const amounts = parts.map((p) => (p.typed != null ? round2(p.typed) : 0));
  if (!free.length || freeQty <= QTY_EPS) {
    if (Math.abs(rest) > 0.005) return { amounts, issue: `adds up to ${money(typedSum)}, not ${money(total)}` };
    return { amounts, issue: null };
  }
  for (const p of free) amounts[p.i] = round2((rest * p.qty) / freeQty);
  const gap = round2(total - amounts.reduce((s, a) => s + a, 0));
  if (gap !== 0) {
    const last = [...free].reverse().find((p) => p.qty > QTY_EPS) ?? free[free.length - 1]!;
    amounts[last.i] = round2(amounts[last.i]! + gap);
  }
  if (amounts.some((a) => a < -0.005)) return { amounts, issue: `typed amounts are more than the ${money(total)} on the line` };
  return { amounts, issue: null };
}

export type BuiltStage = {
  seq: number;
  name: string;
  scope: string;
  plannedDate: string | null;
  awaitingReadiness: boolean;
  status: "open" | "complete";
  completedOn: string | null;
  lines: { quoteItemId: number; description: string; unit: string; qty: number; amountInc: number; amountTyped: boolean }[];
  pay: {
    taskId: number;
    installerId: number | null;
    lineKey: string;
    description: string;
    unit: string;
    qty: number;
    rate: number | null;
    amount: number | null;
    estimatedHours: number | null;
    amountTyped: boolean;
    approved: boolean;
    claimed: boolean;
    reassignedFromInstallerId: number | null;
    changeNote: string | null;
  }[];
  labourInc: number;
  payTotal: number;
};

export type BuiltPlan = {
  stages: BuiltStage[];
  materialsInc: number | null;
  labourInc: number | null;
  issues: string[];
  notes: string[];
};

/** Turns the office's setup into stage rows, with every check. Writes nothing. Completed stages keep what they had. */
export function buildPlan(ctx: JobContext, input: PlanIn): BuiltPlan {
  const issues: string[] = [];
  const notes: string[] = [];
  const split = ctx.quote && ctx.quoteRef ? sellingSplitOf(ctx.quote, ctx.quoteRef, ctx.items, input.split) : null;
  if (!split) issues.push("The job has no accepted quote, so there are no agreed selling values to stage.");
  else if (split.issue) issues.push(split.issue);

  const done = ctx.stages.filter((s) => s.status === "complete").sort((a, b) => a.seq - b.seq);
  const openIn = input.stages.slice(done.length);
  if (done.length + openIn.length < 2) issues.push("A staged job needs at least two stages.");
  if (input.stages.length < done.length) issues.push("A finished stage cannot be taken off the plan.");

  const stages: BuiltStage[] = [];
  for (const s of done) {
    stages.push({
      seq: s.seq,
      name: s.name,
      scope: s.scope,
      plannedDate: s.plannedDate,
      awaitingReadiness: s.awaitingReadiness,
      status: "complete",
      completedOn: s.completedOn,
      lines: ctx.lines
        .filter((l) => l.stageId === s.id)
        .map((l) => ({ quoteItemId: l.quoteItemId, description: l.description, unit: l.unit, qty: l.qty, amountInc: l.amountInc, amountTyped: true })),
      pay: ctx.pay
        .filter((p) => p.stageId === s.id)
        .map((p) => ({
          taskId: p.taskId,
          installerId: p.installerId,
          lineKey: p.lineKey,
          description: p.description,
          unit: p.unit,
          qty: p.qty,
          rate: p.rate,
          amount: p.amount,
          estimatedHours: p.estimatedHours,
          amountTyped: true,
          approved: p.approvedAt != null,
          claimed: p.claimInvoiceId != null,
          reassignedFromInstallerId: p.reassignedFromInstallerId,
          changeNote: p.changeNote,
        })),
      labourInc: 0,
      payTotal: 0,
    });
  }
  let seq = done.length ? Math.max(...done.map((d) => d.seq)) : 0;
  openIn.forEach((s) => {
    seq += 1;
    const label = s.name.trim() || `Stage ${seq}`;
    const date = s.plannedDate?.trim() || null;
    if (date && !ISO_DAY.test(date)) issues.push(`${label}: the date must be a day like 2026-12-15.`);
    if (!date && !s.awaitingReadiness) issues.push(`${label}: set the expected date, or tick Awaiting readiness.`);
    stages.push({
      seq,
      name: label.slice(0, 120),
      scope: s.scope.trim().slice(0, 2000),
      plannedDate: date,
      awaitingReadiness: !date && s.awaitingReadiness,
      status: "open",
      completedOn: null,
      lines: [],
      pay: [],
      labourInc: 0,
      payTotal: 0,
    });
  });
  const openStages = stages.filter((s) => s.status === "open");
  if (openStages.some((s) => s.awaitingReadiness) && !input.followUpDate) {
    issues.push("A stage is awaiting readiness. Set a follow-up date so the unfinished work stays in view.");
  }
  if (input.followUpDate && !ISO_DAY.test(input.followUpDate)) issues.push("The follow-up date must be a day like 2026-12-15.");
  if (input.requestedOn && !ISO_DAY.test(input.requestedOn)) issues.push("The requested date must be a day like 2026-11-12.");

  /* Customer labour, line by line, off the accepted quote. */
  for (const line of split?.labourLines ?? []) {
    const parts = stages.map((st, idx) => {
      if (st.status === "complete") {
        const had = st.lines.find((l) => l.quoteItemId === line.quoteItemId);
        return { qty: had?.qty ?? 0, typed: had?.amountInc ?? 0 };
      }
      const given = input.stages[idx]?.lines.find((l) => l.quoteItemId === line.quoteItemId);
      const typed = given?.amountInc != null && Number.isFinite(given.amountInc) ? round2(given.amountInc) : null;
      return { qty: Math.max(0, Number(given?.qty) || 0), typed };
    });
    const qtySum = parts.reduce((s, p) => s + p.qty, 0);
    if (input.stages.some((st, idx) => (st.lines.find((l) => l.quoteItemId === line.quoteItemId)?.qty ?? 0) < 0 && stages[idx]?.status === "open")) {
      issues.push(`${line.description}: a quantity cannot be negative.`);
    }
    if (Math.abs(qtySum - line.qty) > QTY_EPS) {
      issues.push(`${line.description}: the stages add up to ${+qtySum.toFixed(4)} of the ${line.qty} ${line.unit} quoted. Every quoted ${line.unit} must sit in one stage.`);
    }
    const { amounts, issue } = allocate(line.amountInc, parts);
    if (issue) issues.push(`${line.description}: the labour amounts ${issue}.`);
    stages.forEach((st, idx) => {
      if (st.status === "complete") return;
      st.lines.push({
        quoteItemId: line.quoteItemId,
        description: line.description,
        unit: line.unit,
        qty: parts[idx]!.qty,
        amountInc: amounts[idx]!,
        amountTyped: parts[idx]!.typed != null,
      });
    });
  }
  for (const st of input.stages) {
    for (const l of st.lines) {
      if (!split?.labourLines.some((x) => x.quoteItemId === l.quoteItemId)) issues.push(`Quote line ${l.quoteItemId} is not a labour line on the accepted quote.`);
    }
  }

  /* Installer pay, task by task, off his locked pay lines. */
  for (const tp of ctx.taskPay) {
    if (tp.mode === "employee" || tp.mode === "invoiced" || tp.mode === "unset") {
      if (tp.note) notes.push(`Task ${tp.seq} ${tp.title}: ${tp.note}`);
      continue;
    }
    if (tp.mode === "hourly") {
      notes.push(`Task ${tp.seq} ${tp.title}: ${tp.note}`);
      stages.forEach((st, idx) => {
        if (st.status === "complete") return;
        const given = input.stages[idx]?.pay.find((p) => p.taskId === tp.taskId && p.lineKey === "hourly");
        const keep = ctx.pay.find((p) => p.taskId === tp.taskId && p.lineKey === "hourly" && p.installerId != null);
        st.pay.push({
          taskId: tp.taskId,
          installerId: keep?.installerId ?? tp.installerId,
          lineKey: "hourly",
          description: `${tp.title}, hourly`,
          unit: "hour",
          qty: 0,
          rate: null,
          amount: null,
          estimatedHours: given?.estimatedHours != null && given.estimatedHours >= 0 ? round2(given.estimatedHours) : null,
          amountTyped: false,
          approved: false,
          claimed: false,
          reassignedFromInstallerId: null,
          changeNote: null,
        });
      });
      continue;
    }
    for (const line of tp.lines) {
      const parts = stages.map((st, idx) => {
        if (st.status === "complete") {
          const had = st.pay.find((p) => p.taskId === tp.taskId && p.lineKey === line.lineKey);
          return { qty: had?.qty ?? 0, typed: had?.amount ?? 0 };
        }
        const given = input.stages[idx]?.pay.find((p) => p.taskId === tp.taskId && p.lineKey === line.lineKey);
        const typed = given?.amount != null && Number.isFinite(given.amount) ? round2(given.amount) : null;
        return { qty: Math.max(0, Number(given?.qty) || 0), typed };
      });
      const qtySum = parts.reduce((s, p) => s + p.qty, 0);
      const what = `Task ${tp.seq} pay, ${line.description}`;
      if (Math.abs(qtySum - line.qty) > QTY_EPS) {
        issues.push(`${what}: the stages add up to ${+qtySum.toFixed(4)} of the ${line.qty} ${line.unit} in his agreed pay.`);
      }
      // A rate the office changed when the rest went to someone else (reassignRemaining) is an explicit
      // office decision: that stage keeps the changed rate, and the line total moves by the difference.
      const shaped = parts.map((p, idx) => {
        const st = stages[idx]!;
        const ch = ctx.pay.find(
          (x) => x.taskId === tp.taskId && x.lineKey === line.lineKey && x.changeNote && x.rate != null && ctx.stages.find((s) => s.id === x.stageId)?.seq === st.seq,
        );
        if (!ch) return { qty: p.qty, typed: p.typed, delta: 0 };
        const amount = st.status === "complete" ? round2(ch.amount ?? 0) : round2(p.qty * ch.rate!);
        return { qty: p.qty, typed: amount, delta: round2(amount - (line.total * p.qty) / (line.qty || 1)) };
      });
      const lineTotal = round2(line.total + shaped.reduce((s, p) => s + p.delta, 0));
      const { amounts, issue } = allocate(
        lineTotal,
        shaped.map((p) => ({ qty: p.qty, typed: p.typed })),
      );
      if (issue) issues.push(`${what}: the pay amounts ${issue}.`);
      stages.forEach((st, idx) => {
        if (st.status === "complete") return;
        const prev = ctx.pay.find((p) => p.taskId === tp.taskId && p.lineKey === line.lineKey && ctx.stages.find((s) => s.id === p.stageId)?.seq === st.seq);
        st.pay.push({
          taskId: tp.taskId,
          installerId: prev?.installerId ?? tp.installerId,
          lineKey: line.lineKey,
          description: line.description,
          unit: line.unit,
          qty: parts[idx]!.qty,
          rate: prev?.changeNote ? prev.rate : line.rate,
          amount: amounts[idx]!,
          estimatedHours: null,
          amountTyped: parts[idx]!.typed != null,
          approved: false,
          claimed: false,
          reassignedFromInstallerId: prev?.reassignedFromInstallerId ?? null,
          changeNote: prev?.changeNote ?? null,
        });
      });
    }
  }
  for (const st of input.stages) {
    for (const p of st.pay) {
      const tp = ctx.taskPay.find((t) => t.taskId === p.taskId);
      if (!tp) issues.push(`Task ${p.taskId} is not a live task on this job.`);
      else if (p.lineKey !== "hourly" && !tp.lines.some((l) => l.lineKey === p.lineKey)) issues.push(`Task ${tp.seq}: pay line ${p.lineKey} is not in his agreed pay.`);
    }
  }

  for (const st of stages) {
    st.labourInc = round2(st.lines.reduce((s, l) => s + l.amountInc, 0));
    st.payTotal = round2(st.pay.reduce((s, p) => s + (p.amount ?? 0), 0));
  }
  return {
    stages,
    materialsInc: split?.materialsInc ?? null,
    labourInc: split?.labourInc ?? null,
    issues: [...new Set(issues)],
    notes: [...new Set(notes)],
  };
}

/** What agreeing still needs, on top of the plan checks. */
export function agreeBlocks(plan: PlanRow, split: SellingSplit | null): string[] {
  const out: string[] = [];
  if (!plan.requestedBy.trim()) out.push("Record who asked for the staging.");
  if (!plan.confirmedByName || !plan.confirmedOn || !plan.confirmedHow) {
    out.push("Record the customer's written confirmation (who, when and how) before agreeing.");
  }
  if (split?.needsApproval && !plan.splitApprovedAt) out.push("The material and labour split needs office approval.");
  return out;
}

/** A first setup for the dialog: every quantity in the last stage, so nothing is guessed. The office moves what is done. */
export function proposePlan(ctx: JobContext, kind: (typeof PLAN_KINDS)[number]): PlanIn {
  const lastLines = (ctx.split?.labourLines ?? []).map((l) => ({ quoteItemId: l.quoteItemId, qty: l.qty }));
  const lastPay: StagePayIn[] = [];
  for (const tp of ctx.taskPay) {
    if (tp.mode === "hourly") lastPay.push({ taskId: tp.taskId, lineKey: "hourly", qty: 0 });
    if (tp.mode === "lines" || tp.mode === "flat") for (const l of tp.lines) lastPay.push({ taskId: tp.taskId, lineKey: l.lineKey, qty: l.qty });
  }
  const firstPay = lastPay.map((p) => ({ ...p, qty: 0 }));
  return {
    jobId: ctx.job.id,
    kind,
    reason: kind === "hold" ? "kitchen_not_ready" : "client_requested",
    reasonNote: "",
    requestedBy: "",
    requestedOn: null,
    arrangement: "",
    followUpDate: null,
    variationTiming: "final",
    materialsLocation: "",
    split: null,
    approveSplit: false,
    stages: [
      { name: kind === "hold" ? "Done so far" : "Stage 1", scope: "", plannedDate: null, awaitingReadiness: false, lines: lastLines.map((l) => ({ ...l, qty: 0 })), pay: firstPay },
      { name: kind === "hold" ? "Remaining work" : "Stage 2", scope: "", plannedDate: null, awaitingReadiness: kind === "hold", lines: lastLines, pay: lastPay },
    ],
  };
}

/** The stored plan as setup input, so a change to one part keeps the rest. */
export function planAsInput(ctx: JobContext): PlanIn {
  const p = ctx.plan;
  if (!p) throw bad("There is no stage plan on this job.");
  return {
    jobId: p.jobId,
    kind: (PLAN_KINDS as readonly string[]).includes(p.kind) ? (p.kind as PlanIn["kind"]) : "planned",
    reason: (STAGE_REASONS as readonly string[]).includes(p.reason) ? (p.reason as PlanIn["reason"]) : "other",
    reasonNote: p.reasonNote,
    requestedBy: p.requestedBy,
    requestedOn: p.requestedOn,
    arrangement: p.arrangement,
    followUpDate: p.followUpDate,
    variationTiming: p.variationTiming === "with_materials" ? "with_materials" : "final",
    materialsLocation: p.materialsLocation,
    split: p.splitSource === "office" ? { materialsInc: p.materialsInc, labourInc: p.labourInc, note: p.splitNote } : null,
    approveSplit: p.splitApprovedAt != null,
    stages: ctx.stages.map((s) => ({
      name: s.name,
      scope: s.scope,
      plannedDate: s.plannedDate,
      awaitingReadiness: s.awaitingReadiness,
      lines: ctx.lines.filter((l) => l.stageId === s.id).map((l) => ({ quoteItemId: l.quoteItemId, qty: l.qty, amountInc: l.amountTyped ? l.amountInc : null })),
      pay: ctx.pay
        .filter((x) => x.stageId === s.id)
        .map((x) => ({ taskId: x.taskId, lineKey: x.lineKey, qty: x.qty, amount: x.amountTyped ? x.amount : null, estimatedHours: x.estimatedHours })),
    })),
  };
}

/* -------------------------------- writes -------------------------------- */

async function log(jobId: number, entityId: number, action: string, detail: string, actor: Actor) {
  await db.insert(schema.activityLog).values({ jobId, entityType: "stage_plan", entityId, action, detail, actorName: actor.name, actorRole: actor.role });
}

/** Saves the setup. Draft or agreed; finished stages are never touched. Returns the plan id. */
export async function savePlan(input: PlanIn, actor: Actor) {
  const ctx = await loadJobContext(input.jobId);
  if (ctx.job.parentJobId) throw bad("This is a callback job. A return visit to finish agreed work belongs on the original job, not a callback.");
  const built = buildPlan(ctx, input);
  if (built.issues.length) throw bad(built.issues[0]!);
  const split = ctx.quote && ctx.quoteRef ? sellingSplitOf(ctx.quote, ctx.quoteRef, ctx.items, input.split)! : null;
  const now = new Date();

  const fields = {
    quoteId: ctx.quote?.id ?? null,
    kind: input.kind,
    reason: input.reason,
    reasonNote: input.reasonNote.trim().slice(0, 1000),
    requestedBy: input.requestedBy.trim().slice(0, 200),
    requestedOn: input.requestedOn || null,
    arrangement: input.arrangement.trim().slice(0, 2000),
    followUpDate: input.followUpDate || null,
    variationTiming: input.variationTiming,
    materialsLocation: input.materialsLocation.trim().slice(0, 1000),
    materialsInc: built.materialsInc ?? 0,
    labourInc: built.labourInc ?? 0,
    splitSource: input.split ? "office" : "quote_lines",
    splitNote: input.split?.note.trim().slice(0, 1000) ?? "",
    updatedAt: now,
  };
  // A changed split loses its approval. The same split keeps it.
  const sameSplit = ctx.plan && ctx.plan.materialsInc === fields.materialsInc && ctx.plan.labourInc === fields.labourInc && ctx.plan.splitSource === fields.splitSource;
  const approval =
    input.approveSplit && split
      ? sameSplit && ctx.plan?.splitApprovedAt
        ? {}
        : { splitApprovedByName: actor.name, splitApprovedAt: now }
      : sameSplit
        ? {}
        : { splitApprovedByName: null, splitApprovedAt: null };

  let planId: number;
  if (ctx.plan) {
    if (ctx.plan.status !== "draft" && ctx.plan.status !== "agreed") throw bad("This stage plan is closed.");
    planId = ctx.plan.id;
    await db.update(schema.jobStagePlans).set({ ...fields, ...approval }).where(eq(schema.jobStagePlans.id, planId));
    // Open stages are rebuilt. Their pay is never approved or claimed, so nothing is lost.
    await db.delete(schema.jobStages).where(and(eq(schema.jobStages.planId, planId), eq(schema.jobStages.status, "open")));
  } else {
    try {
      const [row] = await db
        .insert(schema.jobStagePlans)
        .values({ jobId: input.jobId, status: "draft", createdByName: actor.name, ...fields, ...approval })
        .returning({ id: schema.jobStagePlans.id });
      planId = row!.id;
    } catch (e) {
      if (/unique/i.test(String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? ""))) {
        throw bad("Someone else started a stage plan on this job a moment ago. Refresh to see it.");
      }
      throw e;
    }
  }

  for (const st of built.stages) {
    if (st.status === "complete") continue;
    let stageId: number;
    try {
      const [row] = await db
        .insert(schema.jobStages)
        .values({ planId, jobId: input.jobId, seq: st.seq, name: st.name, scope: st.scope, plannedDate: st.plannedDate, awaitingReadiness: st.awaitingReadiness, status: "open" })
        .returning({ id: schema.jobStages.id });
      stageId = row!.id;
    } catch (e) {
      if (/unique/i.test(String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? ""))) {
        throw bad("Someone else saved this plan at the same moment. Refresh and check it.");
      }
      throw e;
    }
    if (st.lines.length) {
      await db.insert(schema.jobStageLines).values(
        st.lines.map((l) => ({ planId, stageId, quoteItemId: l.quoteItemId, description: l.description, unit: l.unit, qty: l.qty, amountInc: l.amountInc, amountTyped: l.amountTyped })),
      );
    }
    if (st.pay.length) {
      await db.insert(schema.jobStagePay).values(
        st.pay.map((p) => ({
          planId,
          stageId,
          taskId: p.taskId,
          installerId: p.installerId,
          lineKey: p.lineKey,
          description: p.description,
          unit: p.unit,
          qty: p.qty,
          rate: p.rate,
          amount: p.amount,
          estimatedHours: p.estimatedHours,
          amountTyped: p.amountTyped,
          reassignedFromInstallerId: p.reassignedFromInstallerId,
          changeNote: p.changeNote,
        })),
      );
    }
  }
  await log(input.jobId, planId, ctx.plan ? "stage_plan_saved" : "stage_plan_created", `Stage plan ${ctx.plan ? "updated" : "started"}: ${built.stages.length} stages, ${PLAN_KIND_LABEL[input.kind]}`, actor);
  return planId;
}

export async function planOrThrow(planId: number) {
  const [plan] = await db.select().from(schema.jobStagePlans).where(eq(schema.jobStagePlans.id, planId));
  if (!plan) throw new ORPCError("NOT_FOUND", { message: "Stage plan not found" });
  return plan;
}

/** The customer's written confirmation, kept with the plan beside the accepted quote. */
export async function recordConfirmation(args: { planId: number; name: string; on: string; how: (typeof CONFIRM_HOWS)[number]; text: string; actor: Actor }) {
  const plan = await planOrThrow(args.planId);
  if (plan.status === "cancelled") throw bad("This stage plan was cancelled.");
  if (!args.name.trim()) throw bad("Who confirmed it?");
  if (!ISO_DAY.test(args.on)) throw bad("The confirmation date must be a day like 2026-11-12.");
  await db
    .update(schema.jobStagePlans)
    .set({
      confirmedByName: args.name.trim().slice(0, 200),
      confirmedOn: args.on,
      confirmedHow: args.how,
      confirmationText: args.text.trim().slice(0, 5000) || null,
      confirmationRecordedByName: args.actor.name,
      confirmationRecordedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobStagePlans.id, plan.id));
  await log(plan.jobId, plan.id, "stage_plan_confirmed", `Customer confirmation recorded: ${args.name.trim()}, ${args.how}, ${args.on}`, args.actor);
}

/** Draft to agreed. From here the materials claim can be raised and stages finished. */
export async function agreePlan(planId: number, actor: Actor) {
  const plan = await planOrThrow(planId);
  if (plan.status === "agreed") return plan;
  if (plan.status !== "draft") throw bad("Only a draft plan can be agreed.");
  const ctx = await loadJobContext(plan.jobId, { planId });
  const built = buildPlan(ctx, planAsInput(ctx));
  const blocks = [...built.issues, ...agreeBlocks(plan, ctx.split)];
  if (blocks.length) throw bad(blocks[0]!);
  const moved = await db
    .update(schema.jobStagePlans)
    .set({ status: "agreed", updatedAt: new Date() })
    .where(and(eq(schema.jobStagePlans.id, planId), eq(schema.jobStagePlans.status, "draft")))
    .returning();
  if (!moved.length) return planOrThrow(planId);
  await log(plan.jobId, plan.id, "stage_plan_agreed", `Staging agreed (${STAGE_REASON_LABEL[plan.reason] ?? plan.reason}), requested by ${plan.requestedBy}`, actor);
  return moved[0]!;
}

/** Cancel a plan nobody has billed or finished a stage on. */
export async function cancelPlan(planId: number, reason: string, actor: Actor) {
  const ctx = await loadJobContext((await planOrThrow(planId)).jobId, { planId });
  const plan = ctx.plan!;
  if (plan.status !== "draft" && plan.status !== "agreed") throw bad("This plan is already closed.");
  if (ctx.stages.some((s) => s.status === "complete")) throw bad("A stage is already finished, so the plan stays. Finish the remaining stages instead.");
  if (plan.materialsInvoiceId) {
    const [inv] = await db.select({ status: schema.invoices.status, number: schema.invoices.number }).from(schema.invoices).where(eq(schema.invoices.id, plan.materialsInvoiceId));
    if (inv && inv.status !== "void") throw bad(`Progress invoice ${inv.number} was raised from this plan. Void it first if the staging is off.`);
  }
  if (!reason.trim()) throw bad("Say why the plan is cancelled.");
  await db
    .update(schema.jobStagePlans)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelledReason: reason.trim().slice(0, 500), updatedAt: new Date() })
    .where(eq(schema.jobStagePlans.id, planId));
  await log(plan.jobId, plan.id, "stage_plan_cancelled", `Stage plan cancelled: ${reason.trim()}`, actor);
}

/** Sets the job's status by name, logged. Statuses are data, so a renamed one simply does nothing. */
export async function setJobStatusByName(jobId: number, name: string, why: string, actor: Actor) {
  const [st] = await db
    .select()
    .from(schema.jobStatuses)
    .where(and(eq(schema.jobStatuses.active, true), sql`lower(${schema.jobStatuses.name}) = ${name.toLowerCase()}`))
    .limit(1);
  if (!st) return null;
  const [job] = await db.select({ statusId: schema.jobs.statusId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job || job.statusId === st.id) return st.id;
  await db.update(schema.jobs).set({ statusId: st.id, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "job",
    entityId: jobId,
    action: "status_changed",
    detail: `Status → ${st.name} (${why})`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return st.id;
}

/**
 * The office records a stage as finished. The quantities done can be put
 * right first: whatever this stage did not get to moves to the next open
 * stage (a new "Remaining work" stage, awaiting readiness, if there is none).
 * The stage's pay waits for the office's approval. The progress invoice is
 * its own step (lib/staged-billing.ts), shown with its figures first.
 */
export async function completeStage(args: {
  stageId: number;
  completedOn: string;
  lines?: { quoteItemId: number; qty: number; amountInc?: number | null }[];
  pay?: { taskId: number; lineKey: string; qty: number; amount?: number | null }[];
  actor: Actor;
}) {
  const [stage] = await db.select().from(schema.jobStages).where(eq(schema.jobStages.id, args.stageId));
  if (!stage) throw new ORPCError("NOT_FOUND", { message: "Stage not found" });
  if (!ISO_DAY.test(args.completedOn)) throw bad("The finish date must be a day like 2026-11-20.");
  if (stage.status === "complete") return { stageSeq: stage.seq, already: true, openLeft: null as number | null };
  const ctx = await loadJobContext(stage.jobId, { planId: stage.planId });
  if (ctx.plan?.status !== "agreed") throw bad("Agree the staging first, with the customer's confirmation recorded.");
  if (ctx.stages.some((s) => s.seq < stage.seq && s.status !== "complete")) throw bad("Finish the earlier stage first.");

  let seq = stage.seq;
  if (args.lines?.length || args.pay?.length) {
    const input = planAsInput(ctx);
    const idx = ctx.stages.findIndex((s) => s.id === stage.id);
    // Only a real shortfall needs somewhere to go. The same or a larger quantity leaves nothing behind.
    const cur0 = input.stages[idx]!;
    const leftover =
      (args.lines ?? []).some((l) => (cur0.lines.find((x) => x.quoteItemId === l.quoteItemId)?.qty ?? 0) - l.qty > 1e-9) ||
      (args.pay ?? []).some((p) => (cur0.pay.find((x) => x.taskId === p.taskId && x.lineKey === p.lineKey)?.qty ?? 0) - p.qty > 1e-9);
    if (idx === input.stages.length - 1 && leftover) {
      // The last stage cannot leave anything behind without somewhere for it to go.
      input.stages.push({ name: "Remaining work", scope: "", plannedDate: null, awaitingReadiness: true, lines: [], pay: [] });
      if (!input.followUpDate) throw bad("Part of the last stage is left. Set a follow-up date on the plan first, so the remaining work stays in view.");
    }
    const here = input.stages[idx]!;
    const next = input.stages[idx + 1] ?? { name: "", scope: "", plannedDate: null, awaitingReadiness: false, lines: [], pay: [] };
    for (const l of args.lines ?? []) {
      const cur = here.lines.find((x) => x.quoteItemId === l.quoteItemId);
      const was = cur?.qty ?? 0;
      if (l.qty < 0) throw bad("A quantity cannot be negative.");
      if (cur) Object.assign(cur, { qty: l.qty, amountInc: l.amountInc ?? null });
      else here.lines.push({ quoteItemId: l.quoteItemId, qty: l.qty, amountInc: l.amountInc ?? null });
      const n = next.lines.find((x) => x.quoteItemId === l.quoteItemId);
      const moved = was - l.qty;
      if (n) Object.assign(n, { qty: Math.max(0, n.qty + moved), amountInc: null });
      else next.lines.push({ quoteItemId: l.quoteItemId, qty: Math.max(0, moved) });
    }
    for (const p of args.pay ?? []) {
      const cur = here.pay.find((x) => x.taskId === p.taskId && x.lineKey === p.lineKey);
      const was = cur?.qty ?? 0;
      if (p.qty < 0) throw bad("A quantity cannot be negative.");
      if (cur) Object.assign(cur, { qty: p.qty, amount: p.amount ?? null });
      else here.pay.push({ taskId: p.taskId, lineKey: p.lineKey, qty: p.qty, amount: p.amount ?? null });
      const n = next.pay.find((x) => x.taskId === p.taskId && x.lineKey === p.lineKey);
      const moved = was - p.qty;
      if (n) Object.assign(n, { qty: Math.max(0, n.qty + moved), amount: null });
      else next.pay.push({ taskId: p.taskId, lineKey: p.lineKey, qty: Math.max(0, moved) });
    }
    await savePlan(input, args.actor);
    seq = stage.seq;
  }

  const [fresh] = await db.select().from(schema.jobStages).where(and(eq(schema.jobStages.planId, stage.planId), eq(schema.jobStages.seq, seq)));
  if (!fresh) throw bad("The stage moved while it was being saved. Refresh and try again.");
  const now = new Date();
  const done = await db
    .update(schema.jobStages)
    .set({ status: "complete", completedOn: args.completedOn, completedByName: args.actor.name, completedAt: now, updatedAt: now })
    .where(and(eq(schema.jobStages.id, fresh.id), eq(schema.jobStages.status, "open")))
    .returning({ id: schema.jobStages.id });
  if (!done.length) return { stageSeq: seq, already: true, openLeft: null as number | null };

  const left = await db
    .select({ id: schema.jobStages.id })
    .from(schema.jobStages)
    .where(and(eq(schema.jobStages.planId, stage.planId), eq(schema.jobStages.status, "open")));
  await log(stage.jobId, stage.planId, "stage_complete", `${fresh.name} finished ${args.completedOn}. ${left.length ? `${left.length} stage${left.length === 1 ? "" : "s"} still to do.` : "That was the last stage."}`, args.actor);

  if (left.length) {
    await setJobStatusByName(stage.jobId, PART_COMPLETE_STATUS, `${fresh.name} finished, the rest is waiting`, args.actor);
  } else {
    await db.update(schema.jobStagePlans).set({ status: "complete", closedAt: now, updatedAt: now }).where(eq(schema.jobStagePlans.id, stage.planId));
    const tasks = await db
      .select({ status: schema.jobTasks.status })
      .from(schema.jobTasks)
      .where(and(eq(schema.jobTasks.jobId, stage.jobId), ne(schema.jobTasks.status, "cancelled")));
    if (tasks.length && tasks.every((t) => t.status === "complete")) {
      await db
        .update(schema.jobs)
        .set({ completedAt: now, updatedAt: now })
        .where(and(eq(schema.jobs.id, stage.jobId), isNull(schema.jobs.completedAt)));
      await setJobStatusByName(stage.jobId, "complete", "last stage finished", args.actor);
    } else {
      // The installer still has to finish the task on his phone. The normal chain takes it to Complete then.
      await setJobStatusByName(stage.jobId, "in progress", "last stage under way", args.actor);
    }
  }
  return { stageSeq: seq, already: false, openLeft: left.length };
}

/** The office approves the pay for a finished stage. Only then can the installer claim it. */
export async function approveStagePay(args: { stageId: number; actor: Actor }) {
  const [stage] = await db.select().from(schema.jobStages).where(eq(schema.jobStages.id, args.stageId));
  if (!stage) throw new ORPCError("NOT_FOUND", { message: "Stage not found" });
  if (stage.status !== "complete") throw bad("Finish the stage first. Pay is approved for finished work only.");
  const rows = await db.select().from(schema.jobStagePay).where(eq(schema.jobStagePay.stageId, stage.id));
  const zero = rows.filter((r) => r.amount != null && r.qty > QTY_EPS && !(r.amount > 0));
  if (zero.length) throw bad(`${zero.map((z) => z.description).join(", ")}: Rate not set ($0.00). Set the agreed rate before approving.`);
  const now = new Date();
  const approved = await db
    .update(schema.jobStagePay)
    .set({ approvedByName: args.actor.name, approvedAt: now, updatedAt: now })
    .where(and(eq(schema.jobStagePay.stageId, stage.id), isNull(schema.jobStagePay.approvedAt), sql`${schema.jobStagePay.amount} is not null`))
    .returning();
  if (approved.length) {
    const sum = round2(approved.reduce((s, r) => s + (r.amount ?? 0), 0));
    await log(stage.jobId, stage.planId, "stage_pay_approved", `${stage.name}: installer pay approved, ${money(sum)} ex GST`, args.actor);
  }
  return { approved: approved.length, total: round2(approved.reduce((s, r) => s + (r.amount ?? 0), 0)) };
}

/**
 * A different installer finishes the job. Only the remaining (open) stages move;
 * the first installer keeps every finished stage he earned, claimed or not.
 * Same rates unless the office decides otherwise, in its own words.
 */
export async function reassignRemaining(args: {
  planId: number;
  taskId: number;
  toInstallerId: number;
  rates: { lineKey: string; rate: number }[] | null;
  note: string;
  actor: Actor;
}) {
  const plan = await planOrThrow(args.planId);
  if (plan.status !== "agreed" && plan.status !== "draft") throw bad("This plan is closed.");
  const [to] = await db.select().from(schema.installers).where(eq(schema.installers.id, args.toInstallerId));
  if (!to) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
  const open = await db
    .select({ pay: schema.jobStagePay })
    .from(schema.jobStagePay)
    .innerJoin(schema.jobStages, eq(schema.jobStages.id, schema.jobStagePay.stageId))
    .where(and(eq(schema.jobStagePay.planId, plan.id), eq(schema.jobStagePay.taskId, args.taskId), eq(schema.jobStages.status, "open")));
  if (!open.length) throw bad("There is no remaining work on this task to hand over.");
  if (args.rates?.length && !args.note.trim()) throw bad("A change of rate needs the office's reason, in its own words.");
  const now = new Date();
  for (const { pay } of open) {
    const r = args.rates?.find((x) => x.lineKey === pay.lineKey);
    const changed = r && pay.lineKey !== "hourly" && r.rate !== pay.rate;
    if (r && !(r.rate >= 0)) throw bad("A rate cannot be negative.");
    await db
      .update(schema.jobStagePay)
      .set({
        installerId: to.id,
        reassignedFromInstallerId: pay.installerId !== to.id ? pay.installerId : pay.reassignedFromInstallerId,
        ...(changed ? { rate: r.rate, amount: round2(pay.qty * r.rate), amountTyped: true, changeNote: args.note.trim().slice(0, 500) } : {}),
        updatedAt: now,
      })
      .where(eq(schema.jobStagePay.id, pay.id));
  }
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, args.taskId));
  if (task && task.status !== "complete") {
    await db.update(schema.jobTasks).set({ assignedInstallerId: to.id, updatedAt: now }).where(eq(schema.jobTasks.id, task.id));
  }
  await log(plan.jobId, plan.id, "stage_work_reassigned", `Remaining work on task ${task?.seq ?? args.taskId} handed to ${to.name}${args.rates?.length ? ` at a changed rate: ${args.note.trim()}` : ", same agreed rates"}. Finished stages stay with who did them.`, args.actor);
  return { moved: open.length };
}
