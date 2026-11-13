import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { addLabour, DISPATCH_MADE, DispatchError, mergeDispatches, quoteDispatchIds, splitDispatch, taskLock } from "./dispatch-build";
import { assignWarnings, logAssignOverride, payMethodOf, payToConfirmTaskIds, requireAcknowledged } from "./assign-check";
import type { AssignAnyway, AssignWarning } from "./assign-check";
import { lockTaskLabour } from "../routes/costing";
import { syncJobForTask } from "./job-stage";
import { jobText, taskRef } from "./refs";
import { sayClock, sayDay } from "./work-hours";
import { acceptedQuoteFor } from "./variations";
import { linksForTasks, taskInvoicesOnly } from "./period-invoices";

/* ---------------------------------------------------------------------------
 * Installers & bookings on the job (Damien, 11 Nov 2026, job 188070).
 *
 * The office works with the labour lines and the people, never with the
 * dispatch records underneath. Tick lines, pick a person, Assign selected
 * work: lines ticked off a bigger dispatch are split onto their own behind
 * the scenes (the same Split by trade), and one person's lines on this job
 * that are not booked yet are kept together as one visit, so the pay and
 * the booking are each made once. Saving sends no offer and no message, and
 * needs no date. Booking and offers stay on the existing Book and Send offer.
 *
 * Work that is offered, accepted or booked only moves after the office
 * confirms the change: the offer is withdrawn, the booked days come off,
 * and the history says who had it. Started, done, invoiced or paid work
 * never moves. Quantities and units are the dispatch's own; pay is the
 * installer rates, frozen at assignment (costing lockTaskLabour). Only
 * people who can see costs see the pay.
 * ------------------------------------------------------------------------- */

type Task = typeof schema.jobTasks.$inferSelect;

export type LineState = "unassigned" | "assigned" | "offered" | "accepted" | "booked" | "started" | "completed";

export const STATE_LABEL: Record<LineState, string> = {
  unassigned: "Unassigned",
  assigned: "Assigned, not booked",
  offered: "Offered",
  accepted: "Accepted, not booked",
  booked: "Booked",
  started: "Started",
  completed: "Completed",
};

const bad = (message: string, data?: Record<string, unknown>) => new ORPCError("BAD_REQUEST", { message, ...(data ? { data } : {}) });
const qtyText = (qty: number, unit: string) => `${Number(qty.toFixed(2))} ${unit === "m2" ? "m²" : unit}`;
const titleOf = (names: string[]) =>
  names.length <= 3 ? names.join(" + ") : `${names.slice(0, 3).join(" + ")} + ${names.length - 3} more`;

type Facts = {
  offers: Array<{ taskId: number; installerId: number; status: string; payAmount: number | null }>;
  days: Array<{ taskId: number; date: string; arrivalStart: string | null; arrivalEnd: string | null }>;
  billed: Set<number>;
};

async function factsFor(ids: number[]): Promise<Facts> {
  if (!ids.length) return { offers: [], days: [], billed: new Set() };
  const [offers, days, bills] = await Promise.all([
    db
      .select({ taskId: schema.taskOffers.taskId, installerId: schema.taskOffers.installerId, status: schema.taskOffers.status, payAmount: schema.taskOffers.payAmount })
      .from(schema.taskOffers)
      .where(and(inArray(schema.taskOffers.taskId, ids), inArray(schema.taskOffers.status, ["pending", "provisional", "accepted"])))
      .orderBy(desc(schema.taskOffers.id)),
    db
      .select({ taskId: schema.taskDays.taskId, date: schema.taskDays.date, arrivalStart: schema.taskDays.arrivalStart, arrivalEnd: schema.taskDays.arrivalEnd })
      .from(schema.taskDays)
      .where(and(inArray(schema.taskDays.taskId, ids), eq(schema.taskDays.status, "booked")))
      .orderBy(asc(schema.taskDays.date)),
    db.select({ id: schema.installerInvoices.id, taskId: schema.installerInvoices.taskId }).from(schema.installerInvoices).where(inArray(schema.installerInvoices.taskId, ids)),
  ]);
  // Damien, 13 Nov 2026: an invoice by dates counts for each task it billed time on, not the task it is stored on.
  const [taskBills, links] = await Promise.all([taskInvoicesOnly(bills), linksForTasks(ids)]);
  return { offers, days, billed: new Set([...taskBills.map((b) => b.taskId), ...links.map((l) => l.taskId)]) };
}

function stateOf(task: Task, f: Facts): LineState {
  if (task.status === "complete") return "completed";
  if (task.status === "in_progress") return "started";
  const open = f.offers.filter((o) => o.taskId === task.id && (o.status === "pending" || o.status === "provisional"));
  if (task.status === "offered" || (open.length && !task.assignedInstallerId)) return "offered";
  if (!task.assignedInstallerId) return "unassigned";
  if (f.days.some((d) => d.taskId === task.id)) return "booked";
  if (open.length) return "offered";
  return f.offers.some((o) => o.taskId === task.id && o.status === "accepted" && o.installerId === task.assignedInstallerId) ? "accepted" : "assigned";
}

/** The job's live dispatches with their labour lines (cancelled ones are left out). */
async function jobWork(jobId: number) {
  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
    .orderBy(asc(schema.jobTasks.seq), asc(schema.jobTasks.id));
  const ids = tasks.map((t) => t.id);
  const lines = ids.length
    ? await db
        .select({ line: schema.taskLabourLines, item: schema.labourRateItems, skill: schema.skills })
        .from(schema.taskLabourLines)
        .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
        .leftJoin(schema.skills, eq(schema.skills.id, schema.labourRateItems.skillId))
        .where(inArray(schema.taskLabourLines.taskId, ids))
        .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id))
    : [];
  return { tasks, lines };
}

/**
 * Labour on the accepted quote that is on no dispatch at all, by rate item.
 * Lines on cancelled or finished dispatches count as on a dispatch, so only
 * work that has gone missing shows.
 */
export async function quoteLabourGap(jobId: number) {
  const quote = await acceptedQuoteFor(jobId);
  if (!quote) return { quote: null, missing: [] as Array<{ itemId: number; name: string; unit: string; onQuote: number; onDispatches: number; missing: number }> };
  const quoteLines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id));
  const want = new Map<number, number>();
  for (const l of quoteLines) {
    if (!l.rateItemId) continue;
    want.set(l.rateItemId, (want.get(l.rateItemId) ?? 0) + (l.qty ?? 0));
  }
  const tasks = await db.select({ id: schema.jobTasks.id }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, jobId));
  const have = new Map<number, number>();
  if (tasks.length) {
    const rows = await db.select().from(schema.taskLabourLines).where(inArray(schema.taskLabourLines.taskId, tasks.map((t) => t.id)));
    for (const r of rows) have.set(r.itemId, (have.get(r.itemId) ?? 0) + r.qty);
  }
  const items = want.size ? await db.select().from(schema.labourRateItems).where(inArray(schema.labourRateItems.id, [...want.keys()])) : [];
  const missing = [];
  for (const [itemId, qty] of want) {
    const item = items.find((i) => i.id === itemId);
    // Materials and charges never come here: only rate book work becomes installer pay.
    if (!item || item.kind !== "work") continue;
    const gap = Math.round((qty - (have.get(itemId) ?? 0)) * 1000) / 1000;
    if (gap > 0.0001) missing.push({ itemId, name: item.name, unit: item.unit, onQuote: qty, onDispatches: have.get(itemId) ?? 0, missing: gap });
  }
  return { quote, missing };
}

/** Everything the Installers & bookings card shows. Pay only for logins that can see costs. */
export async function installerBoard(jobId: number, actor: Actor) {
  const canSeePay = Boolean(actor.canSeeCosts);
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const ref = jobText(job);
  const { tasks, lines } = await jobWork(jobId);
  const f = await factsFor(tasks.map((t) => t.id));
  const peopleIds = [...new Set([...tasks.map((t) => t.assignedInstallerId), ...f.offers.map((o) => o.installerId)].filter((n): n is number => n != null))];
  const people = peopleIds.length ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, peopleIds)) : [];
  const nameOf = (id: number | null | undefined) => people.find((p) => p.id === id)?.name ?? null;
  const toConfirm = canSeePay ? await payToConfirmTaskIds(tasks.map((t) => t.id)) : new Set<number>();

  const visits = tasks.map((t) => {
    const state = stateOf(t, f);
    const open = f.offers.find((o) => o.taskId === t.id && (o.status === "pending" || o.status === "provisional"));
    // An offer out to someone with nobody on it yet sits on that person's card.
    const who = t.assignedInstallerId ?? (state === "offered" ? (open?.installerId ?? null) : null);
    const pay = t.payType === "hourly" ? null : (t.payAmount ?? t.labourCost ?? open?.payAmount ?? null);
    return {
      taskId: t.id,
      ref: taskRef(ref, t.seq),
      title: t.title,
      state,
      stateLabel: STATE_LABEL[state],
      installerId: who,
      offeredTo: state === "offered" ? nameOf(open?.installerId) : null,
      days: f.days.filter((d) => d.taskId === t.id).map(({ date, arrivalStart, arrivalEnd }) => ({ date, arrivalStart, arrivalEnd })),
      durationHours: t.durationHours,
      billed: f.billed.has(t.id),
      pay: canSeePay ? pay : null,
      hourly: t.payType === "hourly",
      payToConfirm: canSeePay ? toConfirm.has(t.id) : false,
      lines: lines
        .filter((l) => l.line.taskId === t.id)
        .map((l) => ({ lineId: l.line.id, itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty, skill: l.skill?.name ?? null, note: l.line.note })),
    };
  });

  const rows = visits.flatMap((v) =>
    v.lines.map((l) => ({ ...l, taskId: v.taskId, ref: v.ref, state: v.state, stateLabel: v.stateLabel, installer: v.installerId ? { id: v.installerId, name: nameOf(v.installerId) ?? "Someone" } : null })),
  );
  const cards = [...new Set(visits.map((v) => v.installerId).filter((n): n is number => n != null))].map((id) => {
    const mine = visits.filter((v) => v.installerId === id);
    const pays = mine.map((v) => v.pay);
    return {
      installer: { id, name: nameOf(id) ?? "Someone" },
      visits: mine,
      lineCount: mine.reduce((n, v) => n + v.lines.length, 0),
      /** Their own pay across their visits on this job. Null when not shown or not all priced. */
      pay: canSeePay && pays.every((p) => p != null) ? Math.round(pays.reduce((s, p) => s + (p ?? 0), 0) * 100) / 100 : null,
    };
  }).sort((a, b) => a.installer.name.localeCompare(b.installer.name));
  const gap = await quoteLabourGap(jobId);
  return {
    jobId,
    canSeePay,
    lines: rows,
    cards,
    unassignedVisits: visits.filter((v) => v.installerId == null),
    counts: {
      lines: rows.length,
      unassigned: rows.filter((r) => r.state === "unassigned").length,
      /** With someone but not booked yet: assigned, offered or accepted with no day. */
      unbooked: rows.filter((r) => r.state === "assigned" || r.state === "offered" || r.state === "accepted").length,
      booked: rows.filter((r) => r.state === "booked" || r.state === "started" || r.state === "completed").length,
    },
    /** On the accepted quote, not on any dispatch. */
    missing: gap.missing,
  };
}

/* ------------------------------- who can take it ------------------------------ */

type Picked = { task: Task; lines: Array<{ id: number; itemId: number; name: string; unit: string; qty: number }>; all: number };

/** The ticked lines, grouped by the dispatch they are on. Refused when any has gone. */
async function pickedLines(jobId: number, lineIds: number[]): Promise<Picked[]> {
  const ids = [...new Set(lineIds)];
  if (!ids.length) throw bad("Tick at least one line of work.");
  const { tasks, lines } = await jobWork(jobId);
  const found = lines.filter((l) => ids.includes(l.line.id));
  if (found.length !== ids.length) throw bad("Some of the ticked work is no longer on this job. Reload the job.");
  return tasks
    .map((task) => ({
      task,
      all: lines.filter((l) => l.line.taskId === task.id).length,
      lines: found.filter((l) => l.line.taskId === task.id).map((l) => ({ id: l.line.id, itemId: l.item.id, name: l.item.name, unit: l.item.unit, qty: l.line.qty })),
    }))
    .filter((g) => g.lines.length);
}

/** One person's warnings for these lines, joined across the dispatches they sit on. */
async function warningsFor(groups: Picked[], installerId: number) {
  const out: AssignWarning[] = [];
  for (const g of groups) {
    if (g.task.assignedInstallerId === installerId) continue;
    for (const w of await assignWarnings(g.task.id, installerId, g.lines.map((l) => l.itemId))) {
      if (!out.some((x) => x.text === w.text)) out.push(w);
    }
  }
  return out;
}

/**
 * Everyone current, judged on the ticked work only: suitable people first,
 * then the rest with the exact warnings Assign anyway confirms. Nobody is
 * hidden; archived and switched-off people are not offered at all.
 */
export async function boardPeople(jobId: number, lineIds: number[], actor: Actor) {
  const groups = await pickedLines(jobId, lineIds);
  const people = await db
    .select()
    .from(schema.installers)
    .where(and(eq(schema.installers.active, true), isNull(schema.installers.archivedAt)))
    .orderBy(asc(schema.installers.name));
  const twoMan = groups.some((g) => g.task.crewSize > 1);
  const out = [];
  for (const p of people) {
    const warnings = await warningsFor(groups, p.id);
    const stops = twoMan && p.crewCapacity !== "own_offsider" ? ["This is 2-man work and they don't bring an offsider. Book it with a second person from the visit's Book."] : [];
    out.push({
      id: p.id,
      name: p.name,
      crewCapacity: p.crewCapacity,
      suitable: warnings.length === 0 && stops.length === 0,
      warnings,
      stops,
      payMethod: await payMethodOf(p.id, actor.role === "admin"),
      holds: groups.filter((g) => g.task.assignedInstallerId === p.id).reduce((n, g) => n + g.lines.length, 0),
    });
  }
  return out.sort((a, b) => Number(b.suitable) - Number(a.suitable) || a.name.localeCompare(b.name));
}

/* ---------------------------------- assign ---------------------------------- */

export type BoardAssignInput = {
  jobId: number;
  lineIds: number[];
  /** Null puts the work back to unassigned. */
  installerId: number | null;
  assignAnyway?: AssignAnyway;
  /** The office confirmed taking offered, accepted or booked work off the person who has it. */
  replaceInstaller?: boolean;
};

const dayText = (d: { date: string; arrivalStart: string | null }) => `${sayDay(d.date)}${d.arrivalStart ? ` ${sayClock(d.arrivalStart)}` : ""}`;

/** What taking this work off its current person undoes, in words, or null when nothing is held. */
function heldText(task: Task, f: Facts, names: Map<number, string>) {
  const open = f.offers.filter((o) => o.taskId === task.id && (o.status === "pending" || o.status === "provisional"));
  const days = f.days.filter((d) => d.taskId === task.id);
  const accepted = f.offers.some((o) => o.taskId === task.id && o.status === "accepted" && o.installerId === task.assignedInstallerId);
  const parts: string[] = [];
  const who = task.assignedInstallerId ? (names.get(task.assignedInstallerId) ?? "the installer") : null;
  if (days.length) parts.push(`${who ?? "the installer"}'s booking on ${days.map(dayText).join(", ")}`);
  else if (accepted && who) parts.push(`the offer ${who} accepted`);
  for (const o of open) parts.push(`the offer out to ${names.get(o.installerId) ?? "an installer"}`);
  return parts.length ? parts.join(" and ") : null;
}

/**
 * Gives the ticked lines to one person (or back to unassigned) as a draft:
 * no date, no offer, no message. Checks everything first and writes only
 * when nothing stops it.
 */
export async function assignBoardLines(input: BoardAssignInput, actor: Actor) {
  const groups = await pickedLines(input.jobId, input.lineIds);
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
  const ref = jobText(job!);
  const person = input.installerId != null ? (await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId)))[0] : null;
  if (input.installerId != null && !person) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
  if (person && (person.archivedAt || !person.active)) throw bad(`${person.name} is ${person.archivedAt ? "archived" : "switched off"}, so they can't be given work. Pick someone else.`);

  const f = await factsFor(groups.map((g) => g.task.id));
  const nameIds = [...new Set([...groups.map((g) => g.task.assignedInstallerId), ...f.offers.map((o) => o.installerId)].filter((n): n is number => n != null))];
  const names = new Map(
    (nameIds.length ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, nameIds)) : []).map((p) => [p.id, p.name]),
  );

  const stops: string[] = [];
  const changes: string[] = [];
  const plan: Array<{ g: Picked; whole: boolean; held: string | null; draft: boolean }> = [];
  for (const g of groups) {
    const t = g.task;
    const tRef = taskRef(ref, t.seq);
    const whole = g.lines.length === g.all;
    const state = stateOf(t, f);
    const theirs = person ? t.assignedInstallerId === person.id && state !== "offered" : state === "unassigned";
    if (theirs) continue;
    if (state === "started" || state === "completed") {
      stops.push(`${tRef} (${g.lines.map((l) => l.name).join(", ")}) is ${state === "completed" ? "done" : "started"}, so it stays with ${names.get(t.assignedInstallerId ?? 0) ?? "the person on it"}.`);
      continue;
    }
    if (f.billed.has(t.id)) {
      stops.push(`${tRef} has an installer invoice on it, so it can't be moved.`);
      continue;
    }
    const held = heldText(t, f, names);
    if (held) changes.push(`${g.lines.map((l) => l.name).join(", ")}: ${held}`);
    if (!whole && t.payAmount != null && (held || t.assignedInstallerId)) {
      stops.push(`${tRef} has an agreed pay amount for the whole visit. Change that on its booking before moving part of the work.`);
    }
    if (person && t.crewSize > 1 && person.crewCapacity !== "own_offsider") {
      stops.push(`${tRef} is 2-man work and ${person.name} doesn't bring an offsider. Use Book on the visit to add a second person.`);
    }
    plan.push({ g, whole, held, draft: Boolean(t.assignedInstallerId) && !held });
  }
  if (stops.length) throw bad(stops.join(" "), { reason: "board_stopped", stops });
  if (!plan.length) return { taskId: null, changed: 0 };

  const warnings = person ? await warningsFor(plan.map((p) => p.g), person.id) : [];
  const ok = person ? requireAcknowledged({ installerId: person.id, name: person.name, warnings, ack: input.assignAnyway, payMethod: await payMethodOf(person.id, actor.role === "admin") }) : null;
  if (changes.length && !input.replaceInstaller) {
    throw bad(
      `This work is already out: ${changes.join("; ")}. Confirm the change to take it back${person ? ` and give it to ${person.name}` : ""}. Nobody is messaged, so let them know yourself.`,
      { reason: "replace_installer", changes },
    );
  }

  /* --------------------------------- writes --------------------------------- */
  const pieces: number[] = [];
  const now = () => new Date();
  for (const p of plan) {
    const t = p.g.task;
    const prev = t.assignedInstallerId;
    const prevName = prev ? (names.get(prev) ?? "the installer") : null;
    if (p.whole) {
      if (p.held || p.draft) await release(t, actor, ref, p.held, prevName);
      pieces.push(t.id);
      continue;
    }
    // Part of a dispatch: the ticked lines go onto their own, the rest stay where they are.
    if (p.held) {
      await db
        .update(schema.taskOffers)
        .set({ status: "withdrawn", provisionalUntil: null, respondedAt: now(), updatedAt: now() })
        .where(and(eq(schema.taskOffers.taskId, t.id), inArray(schema.taskOffers.status, ["pending", "provisional"])));
      if (t.status === "offered") await db.update(schema.jobTasks).set({ status: prev ? "assigned" : "unassigned", updatedAt: now() }).where(eq(schema.jobTasks.id, t.id));
    }
    let created: Task;
    try {
      created = await splitDispatch({ taskId: t.id, itemIds: p.g.lines.map((l) => l.itemId) }, actor, { held: Boolean(p.held || p.draft) });
    } catch (error) {
      if (error instanceof DispatchError) throw bad(error.message);
      throw error;
    }
    // The split-off work has no date of its own yet.
    await db.update(schema.jobTasks).set({ scheduledDate: null, scheduledFrom: null, scheduledTo: null, startTime: null, updatedAt: now() }).where(eq(schema.jobTasks.id, created.id));
    await retitle(t.id);
    await retitle(created.id);
    // What stays with the person who had it is paid on what stays: frozen again on the same rates.
    if (prev) await lockTaskLabour({ taskId: t.id, installerId: prev, assignment: false });
    if (p.held || p.draft) {
      await log(t, actor, "allocation_changed", `${taskRef(ref, t.seq)}: ${p.g.lines.map((l) => l.name).join(", ")} taken off ${prevName ?? "the offer"}${p.held ? ` (${p.held} withdrawn for this work)` : ""}. The rest stays as it was.`);
    }
    pieces.push(created.id);
  }

  // One person's unbooked work on this job is one visit: an existing draft of theirs takes the new lines.
  const intoDraft = person ? await draftOf(input.jobId, person.id, pieces) : await freeUnassigned(input.jobId, pieces);
  if (intoDraft && person) {
    // Freed for the merge only; it is given straight back to the same person below.
    await db.update(schema.jobTasks).set({ assignedInstallerId: null, secondInstallerId: null, status: "unassigned", updatedAt: now() }).where(eq(schema.jobTasks.id, intoDraft));
  }
  const all = intoDraft ? [intoDraft, ...pieces] : pieces;
  // The dispatch that had offers keeps its id, so its offer history is never lost in a merge.
  const offered = all.length > 1 ? await db.select({ taskId: schema.taskOffers.taskId }).from(schema.taskOffers).where(inArray(schema.taskOffers.taskId, all)) : [];
  const target = all.find((id) => offered.some((o) => o.taskId === id)) ?? all[0]!;
  const others = all.filter((id) => id !== target);
  if (others.length) {
    try {
      await mergeDispatches({ intoId: target, taskIds: others }, actor);
    } catch (error) {
      if (error instanceof DispatchError) throw bad(error.message);
      throw error;
    }
    await retitle(target);
  }

  const [row] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, target));
  const lineText = groups.flatMap((g) => g.lines.map((l) => `${l.name} ${qtyText(l.qty, l.unit)}`)).join(", ");
  if (person) {
    await db.update(schema.jobTasks).set({ assignedInstallerId: person.id, status: "assigned", updatedAt: now() }).where(eq(schema.jobTasks.id, target));
    // Pay freezes at his rates today, the same as any assignment. Materials and freight are never labour lines.
    await lockTaskLabour({ taskId: target, installerId: person.id, assignment: true });
    await log(row!, actor, "assigned", `${row!.title} → ${person.name} (Installers & bookings, not booked yet): ${lineText}. No offer or message sent.`);
    if (ok && warnings.length) {
      await logAssignOverride({ jobId: row!.jobId, taskId: target, taskRef: taskRef(ref, row!.seq), installerName: person.name, warnings, note: ok.note, actor, source: "Installers & bookings" });
    }
  } else {
    await db.update(schema.jobTasks).set({ labourCost: null, labourBreakdown: null, labourPricedOn: null, updatedAt: now() }).where(eq(schema.jobTasks.id, target));
    await log(row!, actor, "unassigned", `${lineText} back to unassigned (Installers & bookings).`);
  }
  for (const id of new Set([target, ...plan.map((p) => p.g.task.id)])) {
    const [still] = await db.select({ id: schema.jobTasks.id }).from(schema.jobTasks).where(eq(schema.jobTasks.id, id));
    if (still) await syncJobForTask(id, actor);
  }
  return { taskId: target, changed: plan.length };
}

/** Takes a whole dispatch back off the person who has it: offer withdrawn, booked days off, pay to be frozen again. */
async function release(t: Task, actor: Actor, ref: string, held: string | null, prevName: string | null) {
  const at = new Date();
  await db
    .update(schema.taskOffers)
    .set({ status: "withdrawn", provisionalUntil: null, respondedAt: at, updatedAt: at })
    .where(and(eq(schema.taskOffers.taskId, t.id), inArray(schema.taskOffers.status, ["pending", "provisional"])));
  await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, t.id));
  const [hasLines] = await db.select({ id: schema.taskLabourLines.id }).from(schema.taskLabourLines).where(eq(schema.taskLabourLines.taskId, t.id)).limit(1);
  await db
    .update(schema.jobTasks)
    .set({
      assignedInstallerId: null,
      secondInstallerId: null,
      status: "unassigned",
      scheduledDate: null,
      scheduledFrom: null,
      scheduledTo: null,
      startTime: null,
      // Pay comes from the lines at the next person's rates, never the last person's amount.
      ...(hasLines ? { payAmount: null, labourCost: null, labourBreakdown: null, labourPricedOn: null } : {}),
      updatedAt: at,
    })
    .where(eq(schema.jobTasks.id, t.id));
  if (held || prevName) {
    await log(t, actor, "allocation_changed", `${taskRef(ref, t.seq)} ${t.title}: taken off ${prevName ?? "the offer"}${held ? ` after review (${held} withdrawn)` : ""}. Same dispatch, paid once. Nobody was messaged.`);
  }
}

/** A dispatch on this job given to this person and not booked or offered yet. */
async function draftOf(jobId: number, installerId: number, except: number[]) {
  const rows = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), eq(schema.jobTasks.assignedInstallerId, installerId), eq(schema.jobTasks.status, "assigned")))
    .orderBy(asc(schema.jobTasks.seq));
  const f = await factsFor(rows.map((r) => r.id));
  const draft = rows.find((r) => !except.includes(r.id) && stateOf(r, f) === "assigned" && r.payAmount == null && r.payType !== "hourly" && !r.secondInstallerId && !f.billed.has(r.id));
  return draft?.id ?? null;
}

/** A free unassigned dispatch on the job for work put back to unassigned. */
async function freeUnassigned(jobId: number, except: number[]) {
  const rows = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), eq(schema.jobTasks.status, "unassigned")))
    .orderBy(asc(schema.jobTasks.seq));
  for (const r of rows) if (!except.includes(r.id) && !(await taskLock(r))) return r.id;
  return null;
}

/** A dispatch the board split or merged is named after the work on it, so the crew card says what is theirs. */
async function retitle(taskId: number) {
  const lines = await db
    .select({ name: schema.labourRateItems.name })
    .from(schema.taskLabourLines)
    .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
    .where(eq(schema.taskLabourLines.taskId, taskId))
    .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id));
  if (!lines.length) return;
  await db.update(schema.jobTasks).set({ title: titleOf(lines.map((l) => l.name)), updatedAt: new Date() }).where(eq(schema.jobTasks.id, taskId));
}

async function log(t: Pick<Task, "id" | "jobId">, actor: Actor, action: string, detail: string) {
  await db.insert(schema.activityLog).values({ jobId: t.jobId, taskId: t.id, entityType: "task", entityId: t.id, action, detail, actorName: actor.name, actorRole: actor.role });
}

/* ------------------------- put missing quote labour back ------------------------- */

export const LABOUR_RESTORED = "labour_restored";

/**
 * Labour on the accepted quote that is on no dispatch goes back on the job,
 * at the quote's quantities, onto the quote's own dispatch while it is still
 * free (or a new unassigned one). No price, quote or invoice changes.
 */
export async function restoreQuoteLabour(jobId: number, actor: Actor) {
  const gap = await quoteLabourGap(jobId);
  if (!gap.quote || !gap.missing.length) throw bad("Every labour line on the accepted quote is already on the job.");
  const own = await quoteDispatchIds(jobId);
  const tasks = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), eq(schema.jobTasks.status, "unassigned")))
    .orderBy(asc(schema.jobTasks.seq));
  let target: Task | null = null;
  for (const t of tasks) if (own.has(t.id) && !(await taskLock(t))) { target = t; break; }
  if (!target) {
    const [top] = await db.select({ seq: schema.jobTasks.seq }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, jobId)).orderBy(desc(schema.jobTasks.seq)).limit(1);
    const items = await db.select().from(schema.labourRateItems).where(inArray(schema.labourRateItems.id, gap.missing.map((m) => m.itemId)));
    const skillId = items.find((i) => i.skillId)?.skillId ?? null;
    const [job] = await db.select({ furnitureOnSite: schema.jobs.furnitureOnSite }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
    [target] = await db
      .insert(schema.jobTasks)
      .values({ jobId, seq: (top?.seq ?? 0) + 1, skillId, title: titleOf(gap.missing.map((m) => m.name)), status: "unassigned", crewSize: job?.furnitureOnSite ? 2 : 1 })
      .returning();
    // The quote's own work, so a later version of the quote knows this dispatch.
    await db.insert(schema.activityLog).values({ jobId, taskId: target!.id, entityType: "quote", entityId: gap.quote.id, action: DISPATCH_MADE, detail: `Dispatch "${target!.title}" made from the quote` });
  }
  await addLabour(target!.id, new Map(gap.missing.map((m) => [m.itemId, m.missing])));
  const said = gap.missing.map((m) => `${m.name} ${qtyText(m.missing, m.unit)}`).join(", ");
  await log(target!, actor, LABOUR_RESTORED, `Put back on the job from the accepted quote: ${said}. These were on the quote but on no dispatch. No price or quote change.`);
  return { taskId: target!.id, restored: gap.missing };
}
