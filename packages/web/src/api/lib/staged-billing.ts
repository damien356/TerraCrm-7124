import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { raiseInvoice } from "./client-invoices";
import { loadDepositMaps, loadTermsMaps, resolveTerms, settleDate, today } from "./cashflow";
import { dayAt } from "./final-invoice";
import {
  type Actor,
  bad,
  type BuiltPlan,
  type JobContext,
  loadJobContext,
  money,
  planOrThrow,
  round2,
  type TaskPay,
} from "./staged-jobs";

/* ---------------------------------------------------------------------------
 * STAGED JOBS: the money (Damien, 12 Nov 2026).
 *
 * Cumulative invoicing. Each progress invoice bills up to a target, never a
 * fresh slice on top:
 *
 *   target   = full material selling amount
 *              + labour of every finished stage
 *              + anything else due now (a variation's material part, when the
 *                office chose "with the materials")
 *   new      = target less every invoice already raised that is not void
 *   remaining= the contract total (accepted quote plus approved variations)
 *              less everything invoiced, this one included
 *
 * The deposit is an invoice already raised, so it is credited whether it is
 * paid or not. An unpaid deposit stays owing on its own invoice and is never
 * charged a second time. When earlier invoices already come to more than the
 * target, nothing is raised and the office is told. Never a negative invoice.
 *
 * The last stage raises the Final invoice for whatever is left, variations
 * included, so everything that waits for a final (referral fees, care
 * emails, Paid) keeps working. Raising only writes the invoice. Emailing it
 * and sending it to Xero stay on the Client invoices card, as for any invoice.
 * ------------------------------------------------------------------------- */

/* ------------------------------ the figures ----------------------------- */

export type StageBilling = {
  /** Accepted quote plus approved variations. */
  contractTotal: number;
  quoteTotal: number;
  variationsTotal: number;
  /** The job's own value, which should equal the contract total. */
  jobValue: number;
  materialsInc: number;
  /** Variation material billed with the materials (office choice), else 0. */
  variationMaterialsNow: number;
  labourDone: number;
  labourRemaining: number;
  allStagesDone: boolean;
  target: number;
  alreadyInvoiced: number;
  paymentsReceived: number;
  outstandingExisting: number;
  newInvoice: number;
  /** Earlier invoices already over the target, by this much. Nothing is raised. */
  overBilledBy: number;
  remainingAfter: number;
  outstandingAfter: number;
  kind: "stage" | "final";
  label: string;
  /** Stage ids this invoice covers: finished stages not billed yet. */
  coversStageIds: number[];
  invoices: { id: number; ref: string; kind: string; label: string; status: string; total: number; paid: number; outstanding: number }[];
  notes: string[];
};

async function jobInvoices(jobId: number) {
  return db.select().from(schema.invoices).where(eq(schema.invoices.jobId, jobId));
}

/** The figures for the next progress invoice. Writes nothing. */
export async function stageBillingOf(ctx: JobContext, invoiceRows?: (typeof schema.invoices.$inferSelect)[]): Promise<StageBilling> {
  const rows = invoiceRows ?? (await jobInvoices(ctx.job.id));
  const live = rows.filter((r) => r.status !== "void");
  const plan = ctx.plan;
  const quoteTotal = round2(ctx.quote?.total ?? 0);
  const variationsTotal = round2(ctx.variations.reduce((s, v) => s + v.total, 0));
  const contractTotal = round2(quoteTotal + variationsTotal);
  const jobValue = round2(ctx.job.value ?? 0);
  const materialsInc = round2(plan?.materialsInc ?? ctx.split?.materialsInc ?? 0);
  const variationMaterialsNow =
    plan?.variationTiming === "with_materials" ? round2(ctx.variations.reduce((s, v) => s + v.materialInc, 0)) : 0;

  const doneIds = new Set(ctx.stages.filter((s) => s.status === "complete").map((s) => s.id));
  const labourDone = round2(ctx.lines.filter((l) => doneIds.has(l.stageId)).reduce((s, l) => s + l.amountInc, 0));
  const labourAll = round2(ctx.lines.reduce((s, l) => s + l.amountInc, 0));
  const allStagesDone = ctx.stages.length > 0 && ctx.stages.every((s) => s.status === "complete");

  const notes: string[] = [];
  if (Math.abs(jobValue - contractTotal) > 0.005) {
    notes.push(`The job value ${money(jobValue)} is not the accepted quote plus approved variations (${money(contractTotal)}). Check it before raising.`);
  }
  // The final takes everything left, so the books close at the contract total.
  const target = allStagesDone ? contractTotal : round2(materialsInc + variationMaterialsNow + labourDone);
  const alreadyInvoiced = round2(live.reduce((s, r) => s + (r.total ?? 0), 0));
  const paymentsReceived = round2(live.reduce((s, r) => s + (r.amountPaid ?? 0), 0));
  const outstandingExisting = round2(live.reduce((s, r) => s + Math.max(0, (r.total ?? 0) - (r.amountPaid ?? 0)), 0));
  const gap = round2(target - alreadyInvoiced);
  const toBill = round2(Math.max(0, jobValue - alreadyInvoiced));
  const newInvoice = round2(Math.min(Math.max(0, gap), toBill));
  const overBilledBy = gap < -0.005 ? round2(-gap) : 0;
  if (overBilledBy > 0) {
    notes.push(`Invoices already raised come to ${money(alreadyInvoiced)}, which is ${money(overBilledBy)} more than is due at this point (${money(target)}). Nothing new is raised. Check the earlier invoices.`);
  }
  const unpaidDeposit = live.filter((r) => r.kind === "deposit" && r.total - r.amountPaid > 0.005);
  for (const d of unpaidDeposit) {
    notes.push(`Deposit ${d.number} is still unpaid (${money(round2(d.total - d.amountPaid))}). It stays owing on its own invoice and is not charged again.`);
  }

  const hasFinal = live.some((r) => r.kind === "final");
  const kind: StageBilling["kind"] = allStagesDone && !hasFinal ? "final" : "stage";
  const unbilledDone = ctx.stages.filter((s) => s.status === "complete" && !liveId(s.invoiceId, live));
  const materialsBilled = !!liveId(plan?.materialsInvoiceId ?? null, live);
  const ref = ctx.quoteRef ? `quote ${ctx.quoteRef}` : `job ${ctx.job.number}`;
  const parts: string[] = [];
  if (!materialsBilled) parts.push("materials in full");
  if (unbilledDone.length) parts.push(`${unbilledDone.map((s) => s.name).join(", ")} labour`);
  const label =
    kind === "final"
      ? `Final invoice, ${ref}${parts.length ? `: ${parts.join(" and ")}` : ""}`
      : `Progress invoice, ${ref}${parts.length ? `: ${parts.join(" and ")}` : ""}`;

  return {
    contractTotal,
    quoteTotal,
    variationsTotal,
    jobValue,
    materialsInc,
    variationMaterialsNow,
    labourDone,
    labourRemaining: round2(labourAll - labourDone),
    allStagesDone,
    target,
    alreadyInvoiced,
    paymentsReceived,
    outstandingExisting,
    newInvoice,
    overBilledBy,
    remainingAfter: round2(Math.max(0, contractTotal - alreadyInvoiced - newInvoice)),
    outstandingAfter: round2(outstandingExisting + newInvoice),
    kind,
    label: label.slice(0, 200),
    coversStageIds: unbilledDone.map((s) => s.id),
    invoices: rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map((r) => ({
        id: r.id,
        ref: r.number,
        kind: r.kind,
        label: r.label,
        status: r.status,
        total: round2(r.total),
        paid: round2(r.amountPaid),
        outstanding: r.status === "void" ? 0 : round2(Math.max(0, r.total - r.amountPaid)),
      })),
    notes,
  };
}

const liveId = (id: number | null, live: { id: number }[]) => (id != null && live.some((r) => r.id === id) ? id : null);

/* ------------------------------- raising -------------------------------- */

/**
 * Raise the next progress invoice (or the Final, after the last stage).
 * `expectedSeq` is the plan's invoiceSeq the screen was showing: a second
 * click, or two people at once, finds it moved and gets the invoice the first
 * one raised instead of a second invoice.
 */
export async function raiseStageInvoice(args: { planId: number; expectedSeq: number; actor: Actor }) {
  const plan = await planOrThrow(args.planId);
  if (plan.status !== "agreed" && plan.status !== "complete") {
    throw bad(plan.status === "draft" ? "Agree the staging first, with the customer's confirmation recorded." : "This stage plan was cancelled.");
  }
  const claimed = await db
    .update(schema.jobStagePlans)
    .set({ invoiceSeq: args.expectedSeq + 1, updatedAt: new Date() })
    .where(and(eq(schema.jobStagePlans.id, plan.id), eq(schema.jobStagePlans.invoiceSeq, args.expectedSeq)))
    .returning({ id: schema.jobStagePlans.id });
  if (!claimed.length) {
    const latest = await latestPlanInvoice(plan.id);
    if (latest) return { invoice: latest, already: true };
    throw bad("Someone else is raising this invoice right now. Refresh in a moment.");
  }
  try {
    return await raiseClaimed(plan, args);
  } catch (e) {
    // Nothing was raised: give the turn back, so the card's next click is not mistaken for a repeat.
    await db
      .update(schema.jobStagePlans)
      .set({ invoiceSeq: args.expectedSeq })
      .where(and(eq(schema.jobStagePlans.id, plan.id), eq(schema.jobStagePlans.invoiceSeq, args.expectedSeq + 1)));
    throw e;
  }
}

async function raiseClaimed(plan: typeof schema.jobStagePlans.$inferSelect, args: { planId: number; expectedSeq: number; actor: Actor }) {
  const ctx = await loadJobContext(plan.jobId, { planId: plan.id });
  const bill = await stageBillingOf(ctx);
  if (bill.overBilledBy > 0) throw bad(bill.notes.find((n) => n.startsWith("Invoices already raised")) ?? "Earlier invoices are over what is due.");
  if (!(bill.newInvoice > 0.005)) throw bad("Nothing new is due yet. The materials and every finished stage are already invoiced.");

  const job = ctx.job;
  const [{ byJob, byCompany }, deposits] = await Promise.all([loadTermsMaps(), loadDepositMaps()]);
  const terms = resolveTerms(job.companyId, job.id, byJob, byCompany, { deposits, contactId: job.contactId });
  const lastDone = ctx.stages
    .filter((s) => bill.coversStageIds.includes(s.id) && s.completedOn)
    .map((s) => s.completedOn!)
    .sort()
    .at(-1);
  const from = terms.termsFrom === "completion" && lastDone ? lastDone : today();
  const dueDay = settleDate(from, terms.termsDays, terms.endOfMonth);

  const row = await raiseInvoice({
    jobId: job.id,
    quoteId: ctx.quote?.id ?? null,
    kind: bill.kind,
    label: bill.label,
    total: bill.newInvoice,
    createdByName: args.actor.name,
    actorRole: args.actor.role,
    dueDate: dayAt(dueDay),
  });

  const live = (await jobInvoices(job.id)).filter((r) => r.status !== "void");
  if (!liveId(plan.materialsInvoiceId, live)) {
    await db.update(schema.jobStagePlans).set({ materialsInvoiceId: row.id }).where(eq(schema.jobStagePlans.id, plan.id));
  }
  if (bill.coversStageIds.length) {
    await db.update(schema.jobStages).set({ invoiceId: row.id, updatedAt: new Date() }).where(inArray(schema.jobStages.id, bill.coversStageIds));
  }
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "stage_plan",
    entityId: plan.id,
    action: "stage_invoice_raised",
    detail: `${row.number} raised for ${money(bill.newInvoice)}: due so far ${money(bill.target)}, less ${money(bill.alreadyInvoiced)} already invoiced. ${money(bill.remainingAfter)} left to invoice.`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  return { invoice: row, already: false };
}

async function latestPlanInvoice(planId: number) {
  const plan = await planOrThrow(planId);
  const stageInv = await db
    .select({ id: schema.jobStages.invoiceId })
    .from(schema.jobStages)
    .where(and(eq(schema.jobStages.planId, planId), sql`${schema.jobStages.invoiceId} is not null`));
  const ids = [plan.materialsInvoiceId, ...stageInv.map((s) => s.id)].filter((x): x is number => x != null);
  if (!ids.length) return null;
  const rows = await db.select().from(schema.invoices).where(inArray(schema.invoices.id, ids));
  return rows.sort((a, b) => b.id - a.id)[0] ?? null;
}

/* ------------------------------ the preview ----------------------------- */

export type PreviewRow = { row: "scope" | "materials" | "labour" | "pay"; label: string; current: string; remaining: string };

/**
 * The setup screen's table: Area / Completed or current stage / Remaining.
 * "Current" is the stage being finished or billed now: the last finished one
 * on a hold, else the first open one. "Remaining" is every stage after it.
 */
export function previewTable(built: BuiltPlan): { currentName: string; rows: PreviewRow[] } {
  const st = built.stages;
  const lastDone = [...st].reverse().find((s) => s.status === "complete");
  const current = lastDone ?? st[0];
  if (!current) return { currentName: "", rows: [] };
  const later = st.filter((s) => s.seq > current.seq);
  const qtyText = (lines: { description: string; unit: string; qty: number }[]) =>
    lines.filter((l) => l.qty > 0).map((l) => `${+l.qty.toFixed(4)} ${l.unit} ${l.description}`).join("; ") || "Nothing";
  const curScope = [current.scope, qtyText(current.lines)].filter(Boolean).join(". ");
  const restScope =
    later.map((s) => `${s.name}: ${[s.scope, qtyText(s.lines)].filter(Boolean).join(". ")}${s.plannedDate ? ` (expected ${s.plannedDate})` : s.awaitingReadiness ? " (awaiting readiness)" : ""}`).join(" | ") ||
    "Nothing";
  const payOf = (stages: typeof st) => {
    const fixed = round2(stages.reduce((s, x) => s + x.payTotal, 0));
    const hourly = stages.some((x) => x.pay.some((p) => p.lineKey === "hourly"));
    return `${money(fixed)} ex GST${hourly ? ", plus hourly work paid from approved timesheets" : ""}`;
  };
  const labourLater = round2(later.reduce((s, x) => s + x.labourInc, 0));
  return {
    currentName: current.name,
    rows: [
      { row: "scope", label: "Area and quantities", current: curScope, remaining: restScope },
      {
        row: "materials",
        label: "Customer materials",
        current: built.materialsInc != null ? `${money(built.materialsInc)} inc GST, the full agreed amount, due now` : "No agreed split yet",
        remaining: "$0.00, already in the materials claim",
      },
      { row: "labour", label: "Customer labour", current: `${money(current.labourInc)} inc GST`, remaining: `${money(labourLater)} inc GST` },
      { row: "pay", label: "Installer pay", current: payOf([current]), remaining: payOf(later) },
    ],
  };
}

/* --------------------------- reconciliation ----------------------------- */

/** The office's rate decisions on the remaining work, against the original rate. Part of the authorised pay. */
export function rateChangeDelta(tp: TaskPay, pay: JobContext["pay"]) {
  let delta = 0;
  for (const p of pay) {
    if (p.taskId !== tp.taskId || !p.changeNote || p.amount == null) continue;
    const line = tp.lines.find((l) => l.lineKey === p.lineKey);
    if (!line) continue;
    delta += p.amount - (line.total * p.qty) / (line.qty || 1);
  }
  return round2(delta);
}

export type Reconciliation = {
  customer: {
    materialsInc: number;
    labourInc: number;
    quoteTotal: number;
    splitAddsBack: boolean;
    stageLabourAddsBack: boolean;
    variationsTotal: number;
    contractTotal: number;
    jobValue: number;
    invoiced: number;
    received: number;
    leftToInvoice: number;
    ok: boolean;
  };
  pay: {
    taskId: number;
    title: string;
    mode: TaskPay["mode"];
    agreedPay: number;
    rateChanges: number;
    extras: number;
    authorised: number;
    inStages: number;
    approved: number;
    claimed: number;
    claimable: number;
    notApproved: number;
    ok: boolean;
    note: string | null;
  }[];
  ok: boolean;
  problems: string[];
};

export function reconcile(ctx: JobContext, bill: StageBilling): Reconciliation {
  const problems: string[] = [];
  const materialsInc = round2(ctx.plan?.materialsInc ?? ctx.split?.materialsInc ?? 0);
  const labourInc = round2(ctx.plan?.labourInc ?? ctx.split?.labourInc ?? 0);
  const quoteTotal = bill.quoteTotal;
  const splitAddsBack = Math.abs(materialsInc + labourInc - quoteTotal) < 0.005;
  if (!splitAddsBack) problems.push(`Materials ${money(materialsInc)} plus labour ${money(labourInc)} is not the accepted ${money(quoteTotal)}.`);
  const stageLabour = round2(ctx.lines.reduce((s, l) => s + l.amountInc, 0));
  const stageLabourAddsBack = !ctx.lines.length || Math.abs(stageLabour - labourInc) < 0.005;
  if (!stageLabourAddsBack) problems.push(`The stages carry ${money(stageLabour)} of labour, not the agreed ${money(labourInc)}.`);
  if (Math.abs(bill.jobValue - bill.contractTotal) > 0.005) problems.push(`Job value ${money(bill.jobValue)} is not the quote plus variations, ${money(bill.contractTotal)}.`);
  if (bill.alreadyInvoiced > bill.contractTotal + 0.005) problems.push(`Invoiced ${money(bill.alreadyInvoiced)} is more than the contract ${money(bill.contractTotal)}.`);

  const pay = ctx.taskPay.map((tp) => {
    const rows = ctx.pay.filter((p) => p.taskId === tp.taskId && p.lineKey !== "hourly");
    const rateChanges = rateChangeDelta(tp, ctx.pay);
    const extras = round2(tp.extras.reduce((s, e) => s + e.amount, 0));
    const agreedPay = tp.mode === "lines" || tp.mode === "flat" ? tp.total : 0;
    const inStages = round2(rows.reduce((s, p) => s + (p.amount ?? 0), 0));
    const approved = round2(rows.filter((p) => p.approvedAt).reduce((s, p) => s + (p.amount ?? 0), 0));
    const claimed = round2(rows.filter((p) => p.claimInvoiceId != null).reduce((s, p) => s + (p.amount ?? 0), 0));
    const ok = !rows.length || Math.abs(inStages - (agreedPay + rateChanges)) < 0.005;
    if (!ok) problems.push(`Task ${tp.seq}: the stages carry ${money(inStages)} of pay, not the authorised ${money(agreedPay + rateChanges)}.`);
    return {
      taskId: tp.taskId,
      title: tp.title,
      mode: tp.mode,
      agreedPay,
      rateChanges,
      extras,
      authorised: round2(agreedPay + rateChanges + extras),
      inStages,
      approved,
      claimed,
      claimable: round2(approved - claimed),
      notApproved: round2(inStages - approved),
      ok,
      note: tp.note,
    };
  });
  const custOk = splitAddsBack && stageLabourAddsBack && Math.abs(bill.jobValue - bill.contractTotal) < 0.005 && bill.alreadyInvoiced <= bill.contractTotal + 0.005;
  return {
    customer: {
      materialsInc,
      labourInc,
      quoteTotal,
      splitAddsBack,
      stageLabourAddsBack,
      variationsTotal: bill.variationsTotal,
      contractTotal: bill.contractTotal,
      jobValue: bill.jobValue,
      invoiced: bill.alreadyInvoiced,
      received: bill.paymentsReceived,
      leftToInvoice: round2(bill.contractTotal - bill.alreadyInvoiced),
      ok: custOk,
    },
    pay,
    ok: custOk && pay.every((p) => p.ok),
    problems,
  };
}

/* ------------------------------- crew view ------------------------------ */

/**
 * What Terra Crew shows the installer on a staged task: his finished stages,
 * what he can claim, the work and pay still to come, and the return visit.
 * Pay only. No selling price, no customer invoice and no margin.
 */
export async function crewStageView(taskId: number, installerId: number) {
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
  if (!task) return null;
  const [plan] = await db
    .select()
    .from(schema.jobStagePlans)
    .where(and(eq(schema.jobStagePlans.jobId, task.jobId), inArray(schema.jobStagePlans.status, ["agreed", "complete"])))
    .limit(1);
  if (!plan) return null;
  const [stages, pay] = await Promise.all([
    db.select().from(schema.jobStages).where(eq(schema.jobStages.planId, plan.id)),
    db
      .select()
      .from(schema.jobStagePay)
      .where(and(eq(schema.jobStagePay.planId, plan.id), eq(schema.jobStagePay.taskId, taskId))),
  ]);
  const mine = pay.filter((p) => p.installerId === installerId);
  if (!mine.length && task.assignedInstallerId !== installerId) return null;
  const claimIds = [...new Set(mine.map((p) => p.claimInvoiceId).filter((x): x is number => x != null))];
  const claims = claimIds.length
    ? await db
        .select({ id: schema.installerInvoices.id, number: schema.installerInvoices.invoiceNumber, status: schema.installerInvoices.status })
        .from(schema.installerInvoices)
        .where(inArray(schema.installerInvoices.id, claimIds))
    : [];
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const ordered = stages.slice().sort((a, b) => a.seq - b.seq);
  const lastDone = [...ordered].reverse().find((s) => s.status === "complete");
  const nextOpen = ordered.find((s) => s.status === "open") ?? null;
  // A return visit is booked when the task's date is moved past the last finished stage. Never a made up date.
  const booked = task.scheduledDate && lastDone?.completedOn && task.scheduledDate > lastDone.completedOn ? task.scheduledDate : null;

  const view = ordered.map((s) => {
    const rows = mine.filter((p) => p.stageId === s.id);
    const hourly = rows.some((p) => p.lineKey === "hourly");
    const amount = round2(rows.reduce((t, p) => t + (p.amount ?? 0), 0));
    const state =
      s.status === "open"
        ? "to_do"
        : rows.length && rows.every((p) => p.lineKey === "hourly" || p.claimInvoiceId != null)
          ? "claimed"
          : rows.some((p) => p.approvedAt && p.claimInvoiceId == null && p.lineKey !== "hourly")
            ? "claimable"
            : "awaiting_approval";
    const claim = rows.map((p) => (p.claimInvoiceId != null ? claimById.get(p.claimInvoiceId) : undefined)).find(Boolean);
    return {
      seq: s.seq,
      name: s.name,
      scope: s.scope,
      status: s.status,
      completedOn: s.completedOn,
      plannedDate: s.plannedDate,
      awaitingReadiness: s.awaitingReadiness,
      lines: rows.map((p) => ({ description: p.description, unit: p.unit, qty: p.qty, rate: p.rate, amount: p.amount, estimatedHours: p.estimatedHours, hourly: p.lineKey === "hourly" })),
      amount,
      hourly,
      state: hourly && s.status === "complete" ? ("timesheets" as const) : (state as "to_do" | "claimed" | "claimable" | "awaiting_approval"),
      claimRef: claim ? `#${claim.number}` : null,
      notYours: !rows.length && s.status === "open",
    };
  });
  const claimable = round2(mine.filter((p) => p.approvedAt && p.claimInvoiceId == null && p.amount != null && p.lineKey !== "hourly").reduce((t, p) => t + p.amount!, 0));
  const remainingPay = round2(mine.filter((p) => stages.find((s) => s.id === p.stageId)?.status === "open").reduce((t, p) => t + (p.amount ?? 0), 0));
  return {
    planStatus: plan.status,
    stages: view,
    claimable,
    remainingPay,
    returnVisit: nextOpen
      ? {
          stageName: nextOpen.name,
          booked,
          expected: nextOpen.plannedDate,
          awaitingReadiness: nextOpen.awaitingReadiness,
          text: booked
            ? `Booked for ${booked}`
            : nextOpen.plannedDate
              ? `Expected ${nextOpen.plannedDate}, not booked yet. Terra office will book it with you.`
              : "Awaiting the site. Terra office will book the return visit when it is ready.",
        }
      : null,
    materialsLocation: plan.materialsLocation || null,
  };
}

