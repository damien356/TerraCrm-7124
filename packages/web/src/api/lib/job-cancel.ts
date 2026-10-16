import { referralOnCancel } from "./referral-fees";
import { ORPCError } from "@orpc/server";
import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { rebuildForecast } from "./cashflow";
import { voidInvoice } from "./client-invoices";
import { cancelPo } from "./purchase-orders";
import { pushToInstaller } from "./push";
import { quoteRefOf } from "./quote-number";
import { jobText, taskRef } from "./refs";
import { rejectVariation } from "./variation-accept";

/* ---------------------------------------------------------------------------
 * CANCEL A JOB (Damien, 12 Oct). One flow, from the accepted quote or the job
 * page. A confirm screen lists exactly what will happen, with two buttons:
 *
 *  Real cancel. The job goes to Cancelled, the accepted quote to cancelled
 *  (out of the win numbers), unpaid invoices are voided, open dispatches are
 *  cancelled and booked crew told, open office tasks closed, drafts removed,
 *  materials still to order removed, unsent POs cancelled. Money that is real
 *  stays: a supplier bill stays as a cost, a sent PO is flagged so the office
 *  rings the supplier, a paid invoice stays paid with a task to refund or
 *  credit it. One office task lists what has to be sorted by hand.
 *
 *  Test job, clear everything. Admin only, and only after typing the job
 *  number. Everything on the job is cleared: every PO cancelled (sent ones
 *  too), every invoice voided, every material, variation and cost removed.
 *  Blocked while the job has a card payment, or a supplier bill tied to one
 *  of its POs: untie the bill first (Finance, Suppliers owed) or use Real
 *  cancel. Logged as a test job clear.
 * ------------------------------------------------------------------------- */

export type CancelMode = "real" | "clear";

type Actor = { name: string; role: string };

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** PO numbers already read "PO188000-1". Older ones may not. */
const poName = (n: string) => (/^PO/i.test(n) ? n : `PO ${n}`);
/** "2026-11-02" reads "Mon 2 Nov". */
const day = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-AU", o);
  return `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`;
};
/** End a line with one full stop, even when it ends on a description that has its own. */
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const OPEN_TASK = ["complete", "cancelled"];
const DRAFT_QUOTE = ["draft", "needs_review"];
const LIVE_QUOTE = ["accepted", "sent"];

/** A PO that has reached the supplier. */
const poSent = (po: { status: string; sentAt: Date | null }) => !!po.sentAt || po.status === "sent" || po.status === "invoiced";
/** A payment that came in by card. Card money can only be refunded through Stripe, so it is never cleared. */
const cardPaid = (i: { amountPaid: number; paymentMethod: string | null; stripePaymentIntentId: string | null }) =>
  i.amountPaid > 0 && (i.paymentMethod === "card" || !!i.stripePaymentIntentId);

async function cancelledStatus() {
  const rows = await db.select().from(schema.jobStatuses).where(eq(schema.jobStatuses.active, true));
  return rows.find((s) => s.name.trim().toLowerCase() === "cancelled") ?? rows.find((s) => s.name.toLowerCase().includes("cancel")) ?? null;
}

/** Everything on the job that a cancel touches, read once. */
async function gather(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const [status] = job.statusId ? await db.select().from(schema.jobStatuses).where(eq(schema.jobStatuses.id, job.statusId)) : [];
  const target = await cancelledStatus();
  const ref = jobText(job);

  const quotes = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(schema.quotes.version);
  const quoteRefs = new Map<number, string>();
  for (const q of quotes) quoteRefs.set(q.id, await quoteRefOf(q));

  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, jobId), ne(schema.invoices.status, "void")))
    .orderBy(schema.invoices.seq);

  const pos = await db
    .select({ po: schema.purchaseOrders, supplier: schema.suppliers.name })
    .from(schema.purchaseOrders)
    .leftJoin(schema.suppliers, eq(schema.suppliers.id, schema.purchaseOrders.supplierId))
    .where(and(eq(schema.purchaseOrders.jobId, jobId), ne(schema.purchaseOrders.status, "cancelled")))
    .orderBy(schema.purchaseOrders.id);
  const poIds = pos.map((p) => p.po.id);
  const bills = poIds.length
    ? await db
        .select({ id: schema.supplierInvoices.id, poId: schema.supplierInvoices.poId, number: schema.supplierInvoices.invoiceNumber })
        .from(schema.supplierInvoices)
        .where(inArray(schema.supplierInvoices.poId, poIds))
    : [];
  // Bills untied from a PO still carry the job id. Nothing reads it, but a test clear tidies it.
  const looseBills = await db
    .select({ id: schema.supplierInvoices.id, number: schema.supplierInvoices.invoiceNumber })
    .from(schema.supplierInvoices)
    .where(and(eq(schema.supplierInvoices.jobId, jobId), isNull(schema.supplierInvoices.poId)));
  const poLines = poIds.length
    ? await db
        .select({ poId: schema.purchaseOrderLines.poId, materialId: schema.purchaseOrderLines.jobMaterialId })
        .from(schema.purchaseOrderLines)
        .where(inArray(schema.purchaseOrderLines.poId, poIds))
    : [];

  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), notInArray(schema.jobTasks.status, OPEN_TASK)))
    .orderBy(schema.jobTasks.seq, schema.jobTasks.id);
  const taskIds = tasks.map((t) => t.id);
  const days = taskIds.length
    ? await db
        .select()
        .from(schema.taskDays)
        .where(and(inArray(schema.taskDays.taskId, taskIds), eq(schema.taskDays.status, "booked")))
    : [];
  const offers = taskIds.length
    ? await db
        .select()
        .from(schema.taskOffers)
        .where(and(inArray(schema.taskOffers.taskId, taskIds), inArray(schema.taskOffers.status, ["pending", "provisional"])))
    : [];

  const officeTasks = await db
    .select()
    .from(schema.officeTasks)
    // Notes 18.47: Admin only tasks (the referral fee) are left to the referral, and their titles never reach Office's preview.
    .where(and(eq(schema.officeTasks.jobId, jobId), eq(schema.officeTasks.status, "open"), eq(schema.officeTasks.adminOnly, false)))
    .orderBy(schema.officeTasks.id);
  const materials = await db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId)).orderBy(schema.jobMaterials.id);
  const variations = await db.select().from(schema.variations).where(eq(schema.variations.jobId, jobId)).orderBy(schema.variations.seq);
  const costs = await db.select().from(schema.jobCosts).where(eq(schema.jobCosts.jobId, jobId));
  const [events] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.cashEvents)
    .where(eq(schema.cashEvents.jobId, jobId));

  const installerIds = new Set<number>();
  for (const t of tasks) {
    if (t.assignedInstallerId) installerIds.add(t.assignedInstallerId);
    if (t.secondInstallerId) installerIds.add(t.secondInstallerId);
  }
  for (const d of days) if (d.installerId) installerIds.add(d.installerId);
  for (const o of offers) installerIds.add(o.installerId);
  const installers = installerIds.size
    ? await db
        .select({ id: schema.installers.id, name: schema.installers.name })
        .from(schema.installers)
        .where(inArray(schema.installers.id, [...installerIds]))
    : [];

  return {
    job,
    ref,
    statusName: status?.name ?? null,
    target,
    quotes,
    quoteRefs,
    invoices,
    pos,
    bills,
    looseBills,
    poLines,
    tasks,
    days,
    offers,
    officeTasks,
    materials,
    variations,
    costs,
    eventCount: Number(events?.n ?? 0),
    installerName: new Map(installers.map((i) => [i.id, i.name])),
  };
}

type Facts = Awaited<ReturnType<typeof gather>>;

/** Who gets told about a dispatch: whoever is booked on it, plus anyone it was offered to. */
function crewOn(f: Facts, task: Facts["tasks"][number]) {
  const booked = new Set<number>();
  if (task.assignedInstallerId) booked.add(task.assignedInstallerId);
  if (task.secondInstallerId) booked.add(task.secondInstallerId);
  for (const d of f.days) if (d.taskId === task.id && d.installerId) booked.add(d.installerId);
  const offered = new Set<number>();
  for (const o of f.offers) if (o.taskId === task.id && !booked.has(o.installerId)) offered.add(o.installerId);
  return { booked: [...booked], offered: [...offered] };
}

const names = (f: Facts, ids: number[]) => ids.map((id) => f.installerName.get(id) ?? `Installer ${id}`).join(", ");

function blockOf(f: Facts): string | null {
  const card = f.invoices.find(cardPaid);
  if (card) return `Invoice ${card.number} has a card payment of ${money(card.amountPaid)}. Card money is refunded through Stripe, so only Real cancel is allowed.`;
  const bill = f.bills[0];
  if (bill) {
    const po = f.pos.find((p) => p.po.id === bill.poId);
    return `Supplier bill ${bill.number} is tied to ${poName(po?.po.number ?? "")}. Untie it first in Finance, Suppliers owed, or use Real cancel.`;
  }
  return null;
}

export interface CancelPlan {
  /** What happens, in plain lines, top to bottom. */
  steps: string[];
  /** What stays as it is, and why. */
  kept: string[];
  /** Real cancel only: the lines of the one office task it makes. Empty means no task. */
  toSort: string[];
}

function planFor(f: Facts, mode: CancelMode): CancelPlan {
  const steps: string[] = [];
  const kept: string[] = [];
  const toSort: string[] = [];
  const clear = mode === "clear";

  // Job.
  if (f.target && f.job.statusId !== f.target.id) steps.push(`Job ${f.ref} goes to ${f.target.name}${f.statusName ? ` (it is ${f.statusName} now)` : ""}.`);

  // Quotes.
  for (const q of f.quotes) {
    const r = f.quoteRefs.get(q.id)!;
    if (q.status === "accepted") steps.push(`Quote ${r} (accepted, ${money(q.total)}) goes to cancelled. It drops out of the win numbers.`);
    else if (q.status === "sent") steps.push(`Quote ${r} (sent, not accepted) goes to cancelled, so the client can no longer sign it.`);
    else if (DRAFT_QUOTE.includes(q.status)) steps.push(`Draft ${r} is deleted.`);
  }

  // Client invoices.
  for (const i of f.invoices) {
    if (i.amountPaid <= 0) steps.push(`Invoice ${i.number} (${money(i.total)}, nothing paid) is voided.`);
    else if (clear) steps.push(`Invoice ${i.number} is voided and its ${money(i.amountPaid)} payment record is removed.`);
    else {
      kept.push(`Invoice ${i.number} stays ${i.status === "paid" ? "paid" : "part paid"}: ${money(i.amountPaid)} received.`);
      toSort.push(`Refund or credit ${money(i.amountPaid)} received on invoice ${i.number}.`);
    }
  }

  // Dispatches.
  for (const t of f.tasks) {
    const label = `Dispatch ${taskRef(f.ref, t.seq)} "${t.title}"`;
    const { booked, offered } = crewOn(f, t);
    const told: string[] = [];
    if (booked.length) told.push(`${names(f, booked)} ${booked.length === 1 ? "is" : "are"} booked and told by notification.`);
    if (offered.length) told.push(`The offer to ${names(f, offered)} is pulled back and they are told.`);
    steps.push([`${label}${t.status === "in_progress" ? " (started)" : ""} is cancelled.`, ...told].join(" "));
    if (t.status === "in_progress" && !clear) toSort.push(`${label} was started. Check what the installer is owed.`);
  }

  // Office tasks.
  if (f.officeTasks.length) {
    steps.push(`${plural(f.officeTasks.length, "open office task")} closed: ${f.officeTasks.map((t) => `"${t.title}"`).join(", ")}.`);
  }

  // Purchase orders.
  for (const { po, supplier } of f.pos) {
    const who = supplier ?? "the supplier";
    const bill = f.bills.find((b) => b.poId === po.id);
    if (bill) {
      kept.push(`${poName(po.number)} has bill ${bill.number} from ${who}. The bill stays as a cost on the job.`);
    } else if (!poSent(po)) {
      steps.push(`${poName(po.number)} (${who}, not sent) is cancelled.`);
    } else if (clear) {
      steps.push(`${poName(po.number)} (${who}) was sent. It is cancelled in Ops. Nobody rings the supplier.`);
    } else {
      kept.push(`${poName(po.number)} was sent to ${who}. It stays open until they confirm.`);
      toSort.push(`Ring ${who} to cancel ${poName(po.number)}, then cancel it on the job.`);
    }
  }

  // Materials. On a real cancel, what sits on an unsent PO comes back to "to order" and goes too.
  if (clear) {
    if (f.materials.length) steps.push(stop(`${plural(f.materials.length, "material")} removed: ${f.materials.map((m) => m.description.trim()).join(", ")}`));
  } else {
    const freed = new Set(
      f.poLines
        .filter((l) => {
          const p = f.pos.find((x) => x.po.id === l.poId);
          return p && !poSent(p.po) && !f.bills.some((b) => b.poId === p.po.id);
        })
        .map((l) => l.materialId),
    );
    const held = new Set(
      f.poLines
        .filter((l) => {
          const p = f.pos.find((x) => x.po.id === l.poId);
          return p && (poSent(p.po) || f.bills.some((b) => b.poId === p.po.id));
        })
        .map((l) => l.materialId),
    );
    const gone = f.materials.filter((m) => m.status === "to_order" || (m.status === "ordered" && freed.has(m.id) && !held.has(m.id)));
    if (gone.length) steps.push(stop(`${plural(gone.length, "material")} still to order removed: ${gone.map((m) => m.description.trim()).join(", ")}`));
    const stay = f.materials.filter((m) => !gone.includes(m));
    if (stay.length) kept.push(stop(`${plural(stay.length, "material")} already ordered or on site stay on the job: ${stay.map((m) => m.description.trim()).join(", ")}`));
  }

  // Variations.
  for (const v of f.variations) {
    if (clear) steps.push(`Variation ${v.ref} (${v.status === "rejected" ? "declined" : v.status}) is deleted.`);
    else if (v.status === "draft" && !v.sentAt) steps.push(`Draft variation ${v.ref} is deleted.`);
    else if (v.status === "draft" || v.status === "sent") steps.push(`Variation ${v.ref} (sent) is withdrawn, so the client can no longer sign it.`);
    else if (v.status === "approved") {
      kept.push(`Variation ${v.ref} was approved (${money(v.total)}) and not billed.`);
      toSort.push(`Variation ${v.ref} was approved for ${money(v.total)}. Decide if any of it is billed.`);
    }
  }

  // Costs and the forecast.
  if (clear) {
    if (f.costs.length) steps.push(`${plural(f.costs.length, "job cost")} removed.`);
    for (const b of f.looseBills) steps.push(`Supplier bill ${b.number} still points at this job with no PO. That link is cleared.`);
  } else {
    // Item 16: expected costs are only estimates, so they go with the job.
    const budget = f.costs.filter((c) => c.state === "budget");
    if (budget.length) steps.push(`${plural(budget.length, "expected cost")} (budget, nothing ordered) removed from Money out.`);
  }
  if (steps.length || f.eventCount) steps.push("The cashflow forecast is rebuilt.");
  if (toSort.length) steps.push(`One office task lists the ${plural(toSort.length, "thing")} to sort by hand.`);
  return { steps, kept, toSort };
}

export async function cancelPreview(jobId: number, actor: { role: string }) {
  const f = await gather(jobId);
  const real = planFor(f, "real");
  const clear = planFor(f, "clear");
  const block = blockOf(f);
  const nothing = !real.steps.some((s) => s !== "The cashflow forecast is rebuilt.") && !real.toSort.length;
  return {
    jobId: f.job.id,
    jobRef: f.ref,
    statusName: f.statusName,
    /** The job has no Cancelled status to move to. */
    noStatus: !f.target,
    /** Already cancelled and nothing open on it. */
    nothingToDo: nothing && clear.steps.every((s) => s === "The cashflow forecast is rebuilt."),
    real,
    clear,
    clearAllowed: actor.role === "admin" && !block,
    clearBlocked: actor.role !== "admin" ? "Only an Admin can clear a test job." : block,
  };
}

/** "#188000", " 188000 " and "188000" all read as the job number. */
const typed = (s: string) => s.trim().replace(/^#/, "").replace(/^job\s*/i, "").trim().toUpperCase();

export async function cancelJob(args: { jobId: number; mode: CancelMode; confirmNumber?: string | null; actor: Actor }) {
  const { mode, actor } = args;
  const clear = mode === "clear";
  const f = await gather(args.jobId);
  if (!f.target) throw bad("There is no Cancelled job status. Add one in Settings first.");
  if (clear) {
    if (actor.role !== "admin") throw new ORPCError("FORBIDDEN", { message: "Only an Admin can clear a test job." });
    const block = blockOf(f);
    if (block) throw bad(block);
    if (typed(args.confirmNumber ?? "") !== f.ref.toUpperCase()) throw bad(`Type the job number ${f.ref} to clear this test job.`);
  }
  const plan = planFor(f, mode);
  const now = new Date();
  const why = clear ? "Test job cleared" : "Job cancelled";

  // 1. Open office tasks close first, so the new task below stays open.
  if (f.officeTasks.length) {
    await db
      .update(schema.officeTasks)
      .set({ status: "done", completedAt: now, completedByName: actor.name, updatedAt: now })
      .where(inArray(schema.officeTasks.id, f.officeTasks.map((t) => t.id)));
  }

  // 2. Dispatches: offers pulled back, booked days cancelled, the task cancelled.
  const tell: { installerId: number; title: string; body: string; taskId: number }[] = [];
  for (const t of f.tasks) {
    const { booked, offered } = crewOn(f, t);
    await db
      .update(schema.taskOffers)
      .set({ status: "withdrawn", provisionalUntil: null, respondedAt: now, updatedAt: now })
      .where(and(eq(schema.taskOffers.taskId, t.id), inArray(schema.taskOffers.status, ["pending", "provisional"])));
    await db
      .update(schema.taskDays)
      .set({ status: "cancelled", updatedAt: now })
      .where(and(eq(schema.taskDays.taskId, t.id), eq(schema.taskDays.status, "booked")));
    await db.update(schema.jobTasks).set({ status: "cancelled", updatedAt: now }).where(eq(schema.jobTasks.id, t.id));
    await db.insert(schema.activityLog).values({
      jobId: f.job.id,
      taskId: t.id,
      entityType: "task",
      entityId: t.id,
      action: "task_cancelled",
      detail: `${t.title}: ${why.toLowerCase()}`,
      actorName: actor.name,
      actorRole: actor.role,
    });
    const ref = taskRef(f.ref, t.seq);
    const when = t.scheduledDate ? ` on ${day(t.scheduledDate)}` : "";
    for (const id of booked) tell.push({ installerId: id, taskId: t.id, title: `Dispatch ${ref} cancelled`, body: `${t.title}${when} is cancelled. You do not need to go.` });
    for (const id of offered) tell.push({ installerId: id, taskId: t.id, title: `Offer pulled back: ${ref}`, body: `${t.title}${when} was cancelled, so the offer is closed.` });
  }

  // 3. Client invoices. Unpaid ones are voided. A paid one stays paid on a real cancel.
  for (const i of f.invoices) {
    if (i.amountPaid <= 0) {
      await voidInvoice({ id: i.id, reason: why, byName: actor.name, actorRole: actor.role });
    } else if (clear) {
      await db
        .update(schema.invoices)
        .set({ status: "void", amountPaid: 0, paidAt: null, paymentMethod: null, markedPaidByName: null, voidedAt: now, voidReason: `${why}. Payment record of ${money(i.amountPaid)} removed.`, updatedAt: now })
        .where(eq(schema.invoices.id, i.id));
      await db.insert(schema.activityLog).values({
        jobId: f.job.id,
        entityType: "invoice",
        entityId: i.id,
        action: "invoice_void",
        detail: `${i.number} voided, test job cleared. The ${money(i.amountPaid)} payment record was removed.`,
        actorName: actor.name,
        actorRole: actor.role,
      });
    }
  }

  // 4. POs. Unsent ones are cancelled. On a test clear the sent ones are too.
  for (const { po } of f.pos) {
    if (f.bills.some((b) => b.poId === po.id)) continue;
    if (poSent(po) && !clear) continue;
    await cancelPo(po.id, { restoreExpected: false });
    await db.insert(schema.activityLog).values({
      jobId: f.job.id,
      entityType: "purchase_order",
      entityId: po.id,
      action: "po_cancelled",
      detail: `${poName(po.number)} cancelled: ${why.toLowerCase()}`,
      actorName: actor.name,
      actorRole: actor.role,
    });
  }

  // 5. Materials. Read again: cancelling a PO puts its materials back to "to order".
  if (clear) {
    await db.delete(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, f.job.id));
  } else {
    await db.delete(schema.jobMaterials).where(and(eq(schema.jobMaterials.jobId, f.job.id), eq(schema.jobMaterials.status, "to_order")));
  }

  // 6. Variations.
  for (const v of f.variations) {
    if (clear || (v.status === "draft" && !v.sentAt)) {
      await db.delete(schema.variations).where(eq(schema.variations.id, v.id));
      await db.insert(schema.activityLog).values({
        jobId: f.job.id,
        entityType: "variation",
        entityId: v.id,
        action: "variation_deleted",
        detail: `Variation ${v.ref} deleted: ${why.toLowerCase()}`,
        actorName: actor.name,
        actorRole: actor.role,
      });
    } else if (v.status === "draft" || v.status === "sent") {
      await rejectVariation({ id: v.id, actor, via: "staff", reason: why });
    }
  }

  // 7. Quotes. Accepted and sent versions are kept as cancelled, drafts go.
  for (const q of f.quotes) {
    const r = f.quoteRefs.get(q.id)!;
    if (LIVE_QUOTE.includes(q.status)) {
      await db.update(schema.quotes).set({ status: "cancelled", updatedAt: now }).where(eq(schema.quotes.id, q.id));
      await db.insert(schema.activityLog).values({
        jobId: f.job.id,
        contactId: q.contactId,
        entityType: "quote",
        entityId: q.id,
        action: "cancelled",
        detail: `Quote ${r} cancelled${clear ? " (test job cleared)" : ""}`,
        actorName: actor.name,
        actorRole: actor.role,
      });
    } else if (DRAFT_QUOTE.includes(q.status)) {
      await db.delete(schema.quotes).where(eq(schema.quotes.id, q.id));
      await db.insert(schema.activityLog).values({
        jobId: f.job.id,
        entityType: "quote",
        entityId: q.id,
        action: "quote_deleted",
        detail: `Draft ${r} deleted: ${why.toLowerCase()}`,
        actorName: actor.name,
        actorRole: actor.role,
      });
    }
  }

  // 8. A test clear takes every cost and forecast line off the job. A real
  // cancel takes off the expected (budget) costs, which were only estimates.
  if (!clear) {
    await db.delete(schema.jobCosts).where(and(eq(schema.jobCosts.jobId, f.job.id), eq(schema.jobCosts.state, "budget")));
  }
  if (clear) {
    await db.delete(schema.cashEvents).where(eq(schema.cashEvents.jobId, f.job.id));
    await db.delete(schema.jobCosts).where(eq(schema.jobCosts.jobId, f.job.id));
    if (f.looseBills.length) {
      await db
        .update(schema.supplierInvoices)
        .set({ jobId: null, updatedAt: now })
        .where(inArray(schema.supplierInvoices.id, f.looseBills.map((b) => b.id)));
    }
  }

  // 9. The job.
  if (f.job.statusId !== f.target.id) {
    await db.update(schema.jobs).set({ statusId: f.target.id, updatedAt: now }).where(eq(schema.jobs.id, f.job.id));
  }
  await db.insert(schema.activityLog).values({
    jobId: f.job.id,
    entityType: "job",
    entityId: f.job.id,
    action: clear ? "test_job_cleared" : "job_cancelled",
    detail: [`${clear ? "Test job cleared" : "Job cancelled"} by ${actor.name}.`, ...plan.steps, ...plan.kept.map((k) => `Kept: ${k}`)].join("\n"),
    actorName: actor.name,
    actorRole: actor.role,
  });

  // Notes 18.47: a referral on the job is flagged for Damien (a test clear takes it off unless it was paid).
  await referralOnCancel(f.job.id, clear);

  // 10. What has to be sorted by hand, as one office task.
  let taskId: number | null = null;
  if (!clear && plan.toSort.length) {
    const [task] = await db
      .insert(schema.officeTasks)
      .values({
        jobId: f.job.id,
        title: `Sort ${plural(plan.toSort.length, "thing")} after cancelling job ${f.ref}`,
        detail: plan.toSort.map((s) => `- ${s}`).join("\n"),
        createdByName: actor.name,
      })
      .returning();
    taskId = task?.id ?? null;
  }

  await rebuildForecast();

  // 11. Crew last, once the database says it is cancelled.
  let pushed = 0;
  for (const t of tell) {
    pushed += await pushToInstaller(t.installerId, { title: t.title, body: t.body, data: { kind: "task", taskId: t.taskId, jobId: f.job.id } }).catch((e) => {
      console.error("[job-cancel] crew push failed:", e);
      return 0;
    });
  }

  return { mode, jobRef: f.ref, steps: plan.steps, kept: plan.kept, toSort: plan.toSort, taskId, crewTold: tell.length, pushed, total: round2(f.job.value) };
}
