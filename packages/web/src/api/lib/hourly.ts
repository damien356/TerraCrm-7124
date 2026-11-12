import { and, asc, eq, inArray, isNull, lte, or, sql, gte } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { localDate, TERRA_TZ, todayLocal } from "./local-date";
import {
  BAND_LABEL,
  BANDS,
  CATEGORIES,
  CATEGORY_LABEL,
  bandRates,
  compare,
  payLines,
  round2,
  suggestSplit,
  vehicleShares,
  workIntervals,
  type Band,
  type Category,
  type NightWindow,
  type PayLine,
  type SplitPart,
  type Terms,
} from "./hourly-calc";

/**
 * HOURLY CONTRACTORS: the database side. Pay terms, settings, the time
 * records, approval and the office costing view.
 *
 * Two hard rules run through all of it:
 *  - an approved session keeps the rate it was approved at, copied onto the
 *    row, and is never recalculated;
 *  - the vehicle allowance is an internal costing figure. It is never added to
 *    pay, an invoice, a reimbursement or a supplier balance.
 */

type Session = typeof schema.workSessions.$inferSelect;
type Break = typeof schema.workBreaks.$inferSelect;
type TermsRow = typeof schema.installerPayTerms.$inferSelect;
export type ActorLike = { name: string; role: string };

/* ------------------------------------------------------------------ *
 * Settings. Every unresolved business answer is stored as "pending" and
 * blocks approval of the time it affects, rather than being guessed.
 * ------------------------------------------------------------------ */

export const SETTING_KEYS = {
  night: "hourly_night_window",
  breaks: "hourly_break_policy",
  categories: "hourly_paid_categories",
  vehicleDefault: "hourly_vehicle_allowance",
  benchmarkVehicle: "hourly_benchmark_vehicle_default",
} as const;

export const BREAK_POLICIES = ["pending", "per_break", "paid", "unpaid"] as const;
export type BreakPolicy = (typeof BREAK_POLICIES)[number];
export type CategoryPay = "pending" | "paid" | "unpaid";
export type BenchmarkVehicle = "unknown" | "included" | "excluded";

export type HourlySettings = {
  nightWindow: NightWindow;
  breakPolicy: BreakPolicy;
  categories: Record<Category, CategoryPay>;
  vehicleAllowanceDefault: number;
  benchmarkVehicleDefault: BenchmarkVehicle;
};

const DEFAULT_CATEGORIES = Object.fromEntries(
  CATEGORIES.map((c) => [c, c === "site" ? "paid" : "pending"]),
) as Record<Category, CategoryPay>;

export async function hourlySettings(): Promise<HourlySettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, Object.values(SETTING_KEYS)));
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const parse = <T>(v: string | null, fallback: T): T => {
    if (v == null) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  const night = parse<NightWindow>(get(SETTING_KEYS.night), null);
  const policy = get(SETTING_KEYS.breaks) as BreakPolicy | null;
  const cats = { ...DEFAULT_CATEGORIES, ...parse<Partial<Record<Category, CategoryPay>>>(get(SETTING_KEYS.categories), {}) };
  cats.site = "paid";
  const veh = Number(get(SETTING_KEYS.vehicleDefault));
  const bv = get(SETTING_KEYS.benchmarkVehicle) as BenchmarkVehicle | null;
  return {
    nightWindow: night && night.start && night.end ? night : null,
    breakPolicy: policy && BREAK_POLICIES.includes(policy) ? policy : "pending",
    categories: cats,
    vehicleAllowanceDefault: Number.isFinite(veh) && veh > 0 ? veh : 50,
    benchmarkVehicleDefault: bv === "included" || bv === "excluded" ? bv : "unknown",
  };
}

export async function putSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

/** What still needs a business answer before live payable use. */
export function pendingSettings(s: HourlySettings): string[] {
  const out: string[] = [];
  if (!s.nightWindow) out.push("Night / after-hours start and end times (office confirms the band on every session until set)");
  if (s.breakPolicy === "pending") out.push("Break arrangement: paid, unpaid or decided per break");
  for (const c of CATEGORIES) if (s.categories[c] === "pending") out.push(`Is "${CATEGORY_LABEL[c]}" paid?`);
  if (s.benchmarkVehicleDefault === "unknown") out.push("Does the normal subcontract allowance already include the subbie's vehicle?");
  return out;
}

/* ------------------------------------------------------------------ *
 * Pay terms
 * ------------------------------------------------------------------ */

export async function termsFor(installerIds: number[], on: string = todayLocal()): Promise<Map<number, TermsRow>> {
  const out = new Map<number, TermsRow>();
  if (!installerIds.length) return out;
  const rows = await db
    .select()
    .from(schema.installerPayTerms)
    .where(
      and(
        inArray(schema.installerPayTerms.installerId, [...new Set(installerIds)]),
        lte(schema.installerPayTerms.effectiveFrom, on),
        or(isNull(schema.installerPayTerms.effectiveTo), gte(schema.installerPayTerms.effectiveTo, on)),
      ),
    )
    .orderBy(asc(schema.installerPayTerms.effectiveFrom), asc(schema.installerPayTerms.id));
  for (const r of rows) out.set(r.installerId, r);
  return out;
}

export async function termsOn(installerId: number, on: string = todayLocal()) {
  return (await termsFor([installerId], on)).get(installerId) ?? null;
}

/**
 * True for anyone paid by the hour now, or ever before. Once a man has hourly
 * terms his screens are restricted for good: the restriction does not lapse
 * because a terms row ended.
 */
export async function isHourlyContractor(installerId: number): Promise<boolean> {
  const [r] = await db
    .select({ id: schema.installerPayTerms.id })
    .from(schema.installerPayTerms)
    .where(eq(schema.installerPayTerms.installerId, installerId))
    .limit(1);
  return Boolean(r);
}

/** The name the brief gives the hourly pay item on each contractor's record. */
export const HOURLY_ITEM = "Contractor labor - per hour";

/**
 * Why this installer can't be given hourly work now, or null. Hourly work
 * with no agreed rate, or a rate of $0.00, is never agreement to work for free.
 */
export async function hourlyRateBarrier(installerId: number, on: string = todayLocal()): Promise<string | null> {
  const terms = await termsOn(installerId, on);
  if (!terms || !terms.defaultForNew) return null;
  if (terms.baseRate > 0) return null;
  return `${HOURLY_ITEM}: Rate not set ($0.00). Set the agreed hourly rate before giving this person hourly work.`;
}

/** Each task's agreed hourly rate and pay basis, for the session views. */
export async function taskPay(taskIds: number[]) {
  const ids = [...new Set(taskIds.filter((t): t is number => t != null))];
  if (!ids.length) return new Map<number, TaskPay>();
  const rows = await db
    .select({
      id: schema.jobTasks.id,
      payType: schema.jobTasks.payType,
      payAmount: schema.jobTasks.payAmount,
      labourCost: schema.jobTasks.labourCost,
      agreedHourlyRate: schema.jobTasks.agreedHourlyRate,
      assignedInstallerId: schema.jobTasks.assignedInstallerId,
      secondInstallerId: schema.jobTasks.secondInstallerId,
    })
    .from(schema.jobTasks)
    .where(inArray(schema.jobTasks.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}
export type TaskPay = {
  id: number;
  payType: string;
  labourCost: number | null;
  agreedHourlyRate: number | null;
  payAmount?: number | null;
  assignedInstallerId?: number | null;
  secondInstallerId?: number | null;
};

/** Terms as they apply to one session: the rate agreed for its allocation wins over the terms of the day. */
export function termsForTask(terms: TermsRow | null, task: TaskPay | null | undefined): TermsRow | null {
  if (!terms) return null;
  if (task?.agreedHourlyRate != null) return { ...terms, baseRate: task.agreedHourlyRate };
  return terms;
}

/**
 * Damien, 11 Nov 2026: an hourly job with no agreed rate reads "Rate to
 * confirm". Never the standard $50, never $0. Time can still be recorded;
 * approval waits until the rate is confirmed.
 */
export const RATE_TO_CONFIRM = "Rate to confirm";

/** His rates as they apply to one task, or null when the rate is still to confirm. */
export function taskRatesView(terms: TermsRow | null, task: TaskPay | null | undefined) {
  const t = termsForTask(terms, task);
  if (!t || !(t.baseRate > 0)) return null;
  return ownRatesView(t);
}

/**
 * Damien, 11 Nov 2026: the same person is never paid a fixed price and by the
 * hour for the same work. Only the person the fixed-price work is given to is
 * blocked: an hourly helper beside him (the second body, or anyone else with no
 * fixed pay of his own on it) is allowed. Extra hourly work by that person goes
 * on its own hourly task the office approves, and the time moves there. The
 * time record is always kept.
 */
export function flatPayClash(task: TaskPay | null | undefined, installerId: number): string | null {
  if (!task || task.payType === "hourly") return null;
  if (task.assignedInstallerId == null) {
    // Older rows with no assignee on record: the unit-rate lines are the pay.
    return (task.labourCost ?? 0) > 0 ? LINES_CLASH : null;
  }
  if (task.assignedInstallerId !== installerId) return null;
  // Unit-rate lines priced for him keep their own wording: the lines are the pay.
  return (task.labourCost ?? 0) > 0 ? LINES_CLASH : FLAT_CLASH;
}
export const LINES_CLASH = "This work is paid by its agreed lines, not by the hour. Approving hours on it would pay it twice.";
export const FLAT_CLASH =
  "This person is paid a fixed price for this work, so approving hours on it would pay it twice. If it was extra work, add it as its own hourly task for the office to approve and move this time there. The time is kept.";

const termsOf = (t: Pick<TermsRow, "baseRate" | "weekendMultiplier" | "nightMultiplier">): Terms => ({
  baseRate: t.baseRate,
  weekendMultiplier: t.weekendMultiplier,
  nightMultiplier: t.nightMultiplier,
});

/** His own rates, the only pay information an hourly contractor is given. */
export function ownRatesView(t: TermsRow | null) {
  if (!t) return null;
  const r = bandRates(termsOf(t));
  return {
    standardRate: r.standard,
    weekendRate: r.weekend,
    nightRate: r.night,
    gstRegistered: t.gstRegistered,
    effectiveFrom: t.effectiveFrom,
  };
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export async function logTime(args: {
  session: Pick<Session, "id" | "installerId" | "taskId"> | null;
  action: string;
  actor: ActorLike;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}) {
  await db.insert(schema.workTimeEvents).values({
    sessionId: args.session?.id ?? null,
    installerId: args.session?.installerId ?? null,
    taskId: args.session?.taskId ?? null,
    action: args.action,
    actorName: args.actor.name,
    actorRole: args.actor.role,
    before: args.before === undefined ? null : JSON.stringify(args.before),
    after: args.after === undefined ? null : JSON.stringify(args.after),
    reason: args.reason ?? null,
  });
}

export const snap = (s: Session) => ({
  start: (s.adjStartedAt ?? s.startedAt)?.toISOString() ?? null,
  end: (s.adjEndedAt ?? s.endedAt)?.toISOString() ?? null,
  taskId: s.taskId,
  category: s.category,
  vehicleId: s.vehicleId,
  status: s.status,
  bandSplit: s.bandSplit,
});

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

/** The vehicle-use day, created once with the allowance of the day. */
export async function ensureVehicleDay(vehicleId: number | null, useDate: string) {
  if (!vehicleId) return null;
  const [v] = await db.select().from(schema.vehicles).where(eq(schema.vehicles.id, vehicleId));
  if (!v) throw new ORPCError("BAD_REQUEST", { message: "No such vehicle." });
  await db
    .insert(schema.vehicleDays)
    .values({ vehicleId, useDate, allowance: v.dailyAllowance })
    .onConflictDoNothing();
  const [d] = await db
    .select()
    .from(schema.vehicleDays)
    .where(and(eq(schema.vehicleDays.vehicleId, vehicleId), eq(schema.vehicleDays.useDate, useDate)));
  return d ?? null;
}

/** Drop vehicle days a correction left with no time and no office shares. */
export async function tidyVehicleDays(vehicleIds: Array<number | null>) {
  for (const id of new Set(vehicleIds.filter((x): x is number => x != null))) {
    const days = await db.select().from(schema.vehicleDays).where(eq(schema.vehicleDays.vehicleId, id));
    for (const d of days) {
      const [used] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.workSessions)
        .where(
          and(
            eq(schema.workSessions.vehicleId, id),
            eq(schema.workSessions.workDate, d.useDate),
            sql`${schema.workSessions.status} != 'rejected'`,
          ),
        );
      const [shared] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.vehicleDayShares)
        .where(eq(schema.vehicleDayShares.vehicleDayId, d.id));
      if (Number(used?.n ?? 0) === 0 && Number(shared?.n ?? 0) === 0) {
        await db.delete(schema.vehicleDays).where(eq(schema.vehicleDays.id, d.id));
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * One session, worked out
 * ------------------------------------------------------------------ */

export type SessionView = ReturnType<typeof viewSession>;

/**
 * Everything the office needs to approve one session: the recorded and the
 * corrected times, the breaks, the suggested band split and what is blocking
 * approval. `now` closes an open session for display only.
 */
export function viewSession(s: Session, breaks: Break[], settings: HourlySettings, termsIn: TermsRow | null, now = Date.now(), task: TaskPay | null = null) {
  // The rate agreed when this work was allocated wins over today's terms.
  const terms = termsForTask(termsIn, task);
  const start = (s.adjStartedAt ?? s.startedAt).getTime();
  const endRaw = s.adjEndedAt ?? s.endedAt;
  const end = endRaw ? endRaw.getTime() : now;
  const own = breaks.filter((b) => b.sessionId === s.id);
  const effPaid = (b: Break): boolean | null => {
    if (b.paid != null) return b.paid;
    if (settings.breakPolicy === "paid") return true;
    if (settings.breakPolicy === "unpaid") return false;
    return null;
  };
  const w = workIntervals(
    start,
    Math.max(start, end),
    own.map((b) => ({ start: b.startedAt.getTime(), end: b.endedAt ? b.endedAt.getTime() : end, paid: effPaid(b) })),
  );
  const suggestion = suggestSplit(w.intervals, TERRA_TZ, settings.nightWindow);
  const category = (CATEGORIES as readonly string[]).includes(s.category) ? (s.category as Category) : "site";
  const catPay = settings.categories[category];
  let confirmed: SplitPart[] | null = null;
  if (s.bandSplit) {
    try {
      confirmed = JSON.parse(s.bandSplit) as SplitPart[];
    } catch {
      confirmed = null;
    }
  }

  const blockers: string[] = [];
  if (s.status === "open") blockers.push("Still running: he has not finished work for the day.");
  if (own.some((b) => !b.endedAt) && s.status !== "open") blockers.push("A break has no end time.");
  if (w.undecided > 0) {
    blockers.push(
      settings.breakPolicy === "pending"
        ? "Break arrangement not confirmed yet. Mark each break paid or unpaid, or set the break policy."
        : "A break is not marked paid or unpaid yet.",
    );
  }
  if (catPay === "pending") blockers.push(`Not confirmed whether "${CATEGORY_LABEL[category]}" is paid.`);
  if (!terms) blockers.push(`${RATE_TO_CONFIRM}: no hourly pay terms for this worker on this date. Confirm the rate before approving.`);
  else if (!(terms.baseRate > 0)) blockers.push(`${RATE_TO_CONFIRM}. ${HOURLY_ITEM}: Rate not set ($0.00). Set the agreed hourly rate before approving.`);
  // No hourly pay on top of fixed-price pay to the same person for the same work.
  const clash = flatPayClash(task, s.installerId);
  if (clash) blockers.push(clash);
  const payableMinutes = suggestion.minutes;
  if (catPay !== "unpaid") {
    if (!confirmed && !settings.nightWindow) blockers.push("Rate band not confirmed. Night hours are not set, so the office confirms the band.");
    if (confirmed && confirmed.reduce((a, p) => a + p.minutes, 0) !== payableMinutes) {
      blockers.push("Confirmed band minutes no longer match the payable minutes. Confirm the band again.");
    }
  }

  const split = confirmed ?? suggestion.split;
  const est = terms && catPay !== "unpaid" ? payLines(split, termsOf(terms)) : null;
  return {
    id: s.id,
    installerId: s.installerId,
    taskId: s.taskId,
    jobId: s.jobId,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    categoryPay: catPay,
    workDate: s.workDate,
    status: s.status,
    source: s.source,
    vehicleId: s.vehicleId,
    note: s.note,
    recordedStart: s.startedAt.toISOString(),
    recordedEnd: s.endedAt ? s.endedAt.toISOString() : null,
    start: new Date(start).toISOString(),
    end: endRaw ? endRaw.toISOString() : null,
    corrected: Boolean(s.adjStartedAt || s.adjEndedAt),
    correctionRequestedAt: s.correctionRequestedAt ? s.correctionRequestedAt.toISOString() : null,
    correctionNote: s.correctionNote,
    grossMinutes: w.gross,
    paidBreakMinutes: w.paidBreak,
    unpaidBreakMinutes: w.unpaidBreak,
    undecidedBreakMinutes: w.undecided,
    payableMinutes,
    breaks: own.map((b) => ({
      id: b.id,
      start: b.startedAt.toISOString(),
      end: b.endedAt ? b.endedAt.toISOString() : null,
      paid: b.paid,
      effectivePaid: effPaid(b),
    })),
    suggestedSplit: suggestion.split,
    confirmedSplit: confirmed,
    bandConfirmedBy: s.bandConfirmedBy,
    blockers,
    canApprove: blockers.length === 0 && s.status === "recorded",
    /* Approved snapshot. */
    approvedMinutes: s.approvedMinutes,
    approvedPay: s.approvedPay,
    payLines: s.payLines ? (JSON.parse(s.payLines) as PayLine[]) : null,
    payable: s.payable,
    rateBase: s.rateBase,
    approvedAt: s.approvedAt ? s.approvedAt.toISOString() : null,
    approvedByName: s.approvedByName,
    invoiceId: s.invoiceId,
    /** At today's terms, for recorded time not yet approved. Labelled an estimate. */
    estimate: est ? { lines: est.lines, total: est.total } : null,
  };
}

export async function loadSessions(where: ReturnType<typeof and>) {
  const sessions = await db.select().from(schema.workSessions).where(where).orderBy(asc(schema.workSessions.startedAt));
  const breaks = sessions.length
    ? await db
        .select()
        .from(schema.workBreaks)
        .where(inArray(schema.workBreaks.sessionId, sessions.map((s) => s.id)))
        .orderBy(asc(schema.workBreaks.startedAt))
    : [];
  return { sessions, breaks };
}

export async function viewSessions(where: ReturnType<typeof and>, now = Date.now()) {
  const settings = await hourlySettings();
  const { sessions, breaks } = await loadSessions(where);
  const out: SessionView[] = [];
  const tasks = await taskPay(sessions.map((s) => s.taskId as number));
  for (const s of sessions) {
    const terms = await termsOn(s.installerId, s.workDate);
    out.push(viewSession(s, breaks, settings, terms, now, s.taskId != null ? tasks.get(s.taskId) ?? null : null));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Approval
 * ------------------------------------------------------------------ */

export async function approveSession(id: number, actor: ActorLike, split?: SplitPart[] | null) {
  const [s] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  if (!s) throw new ORPCError("NOT_FOUND", { message: "No such time entry." });
  if (s.status === "approved") return s;
  if (s.status !== "recorded") throw new ORPCError("BAD_REQUEST", { message: "Only finished time can be approved." });
  const settings = await hourlySettings();
  const task = s.taskId != null ? (await taskPay([s.taskId])).get(s.taskId) ?? null : null;
  const terms = termsForTask(await termsOn(s.installerId, s.workDate), task);

  if (split) {
    for (const p of split) if (!BANDS.includes(p.band)) throw new ORPCError("BAD_REQUEST", { message: `Unknown band ${p.band}` });
    await db
      .update(schema.workSessions)
      .set({ bandSplit: JSON.stringify(split.filter((p) => p.minutes > 0)), bandConfirmedBy: actor.name, bandConfirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.workSessions.id, id));
    await logTime({ session: s, action: "band_confirmed", actor, before: s.bandSplit, after: split });
  }
  const [fresh] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  const breaks = await db.select().from(schema.workBreaks).where(eq(schema.workBreaks.sessionId, id));
  const v = viewSession(fresh!, breaks, settings, terms, Date.now(), task);
  if (v.blockers.length) throw new ORPCError("BAD_REQUEST", { message: v.blockers.join(" ") });

  // Undecided breaks take the office policy now, so the record says what was paid.
  for (const b of v.breaks) {
    if (b.paid == null && b.effectivePaid != null) {
      await db
        .update(schema.workBreaks)
        .set({ paid: b.effectivePaid, decidedByName: `${actor.name} (policy)`, updatedAt: new Date() })
        .where(eq(schema.workBreaks.id, b.id));
    }
  }
  const payable = v.categoryPay === "paid";
  const finalSplit = v.confirmedSplit ?? v.suggestedSplit;
  const pay = payable ? payLines(finalSplit, termsOf(terms!)) : { lines: [] as PayLine[], minutes: v.payableMinutes, total: 0 };
  const now = new Date();
  await db
    .update(schema.workSessions)
    .set({
      status: "approved",
      bandSplit: JSON.stringify(finalSplit),
      bandConfirmedBy: fresh!.bandConfirmedBy ?? actor.name,
      bandConfirmedAt: fresh!.bandConfirmedAt ?? now,
      payable,
      approvedMinutes: v.payableMinutes,
      paidBreakMinutes: v.paidBreakMinutes,
      unpaidBreakMinutes: v.unpaidBreakMinutes,
      termsId: terms!.id,
      rateBase: terms!.baseRate,
      weekendMultiplier: terms!.weekendMultiplier,
      nightMultiplier: terms!.nightMultiplier,
      gstRegistered: terms!.gstRegistered,
      payLines: JSON.stringify(pay.lines),
      approvedPay: pay.total,
      approvedAt: now,
      approvedByName: actor.name,
      correctionRequestedAt: null,
      updatedAt: now,
    })
    .where(and(eq(schema.workSessions.id, id), eq(schema.workSessions.status, "recorded")));
  const [after] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  await logTime({ session: s, action: "approved", actor, before: snap(s), after: { ...snap(after!), pay: pay.total, minutes: v.payableMinutes } });
  return after!;
}

/** Back to recorded so it can be corrected. Never once it is on an invoice. */
export async function unapproveSession(id: number, actor: ActorLike, reason: string) {
  const [s] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  if (!s) throw new ORPCError("NOT_FOUND", { message: "No such time entry." });
  if (s.status !== "approved") return s;
  if (s.invoiceId) throw new ORPCError("BAD_REQUEST", { message: "This time is on a contractor invoice already. Sort the invoice out first." });
  await db
    .update(schema.workSessions)
    .set({
      status: "recorded",
      payable: null,
      approvedMinutes: null,
      paidBreakMinutes: null,
      unpaidBreakMinutes: null,
      termsId: null,
      rateBase: null,
      weekendMultiplier: null,
      nightMultiplier: null,
      gstRegistered: null,
      payLines: null,
      approvedPay: null,
      approvedAt: null,
      approvedByName: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.workSessions.id, id));
  await logTime({ session: s, action: "unapproved", actor, before: { pay: s.approvedPay, minutes: s.approvedMinutes }, reason });
  const [after] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  return after!;
}

/* ------------------------------------------------------------------ *
 * Office costing for one job
 * ------------------------------------------------------------------ */

type ShareRow = { vehicleDayId: number; vehicleId: number; vehicleName: string; useDate: string; allowance: number; taskId: number; minutes: number; share: number; override: boolean };

/** Every vehicle day touching these tasks, split across all its tasks (not only these). */
export async function vehicleAllocation(taskIds: number[]): Promise<{ rows: ShareRow[]; unallocated: Array<{ vehicleDayId: number; useDate: string; vehicleName: string; allowance: number }> }> {
  if (!taskIds.length) return { rows: [], unallocated: [] };
  const touching = await db
    .selectDistinct({ vehicleId: schema.workSessions.vehicleId, workDate: schema.workSessions.workDate })
    .from(schema.workSessions)
    .where(and(inArray(schema.workSessions.taskId, taskIds), sql`${schema.workSessions.vehicleId} is not null`, sql`${schema.workSessions.status} != 'rejected'`));
  const shareTouch = await db
    .select({ vehicleDayId: schema.vehicleDayShares.vehicleDayId })
    .from(schema.vehicleDayShares)
    .where(inArray(schema.vehicleDayShares.taskId, taskIds));
  const days = await db.select().from(schema.vehicleDays);
  const wanted = days.filter(
    (d) => touching.some((t) => t.vehicleId === d.vehicleId && t.workDate === d.useDate) || shareTouch.some((x) => x.vehicleDayId === d.id),
  );
  const vehicles = await db.select().from(schema.vehicles);
  const settings = await hourlySettings();
  const rows: ShareRow[] = [];
  const unallocated: Array<{ vehicleDayId: number; useDate: string; vehicleName: string; allowance: number }> = [];
  for (const d of wanted) {
    const { sessions, breaks } = await loadSessions(
      and(eq(schema.workSessions.vehicleId, d.vehicleId), eq(schema.workSessions.workDate, d.useDate), sql`${schema.workSessions.status} != 'rejected'`),
    );
    const parts = sessions.map((s) => {
      if (s.status === "approved" && s.approvedMinutes != null) return { taskId: s.taskId, minutes: s.approvedMinutes };
      const v = viewSession(s, breaks, settings, null);
      return { taskId: s.taskId, minutes: v.payableMinutes };
    });
    const overrides = await db.select().from(schema.vehicleDayShares).where(eq(schema.vehicleDayShares.vehicleDayId, d.id));
    const name = vehicles.find((v) => v.id === d.vehicleId)?.name ?? `Vehicle ${d.vehicleId}`;
    const res = vehicleShares(d.allowance, parts, overrides.map((o) => ({ taskId: o.taskId, share: o.share })));
    if (!res.shares.length) unallocated.push({ vehicleDayId: d.id, useDate: d.useDate, vehicleName: name, allowance: d.allowance });
    for (const sh of res.shares) {
      rows.push({ vehicleDayId: d.id, vehicleId: d.vehicleId, vehicleName: name, useDate: d.useDate, allowance: d.allowance, ...sh });
    }
  }
  void settings;
  return { rows, unallocated };
}

/**
 * The office job card for hourly work: the benchmark, the plan, the time by
 * worker and band, the vehicle allowance, the comparison and the margin after
 * allowances. Admin or cost-permitted office only, enforced by the caller.
 */
export async function jobHourlyCosting(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "No such job." });
  const tasks = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.jobId, jobId)).orderBy(asc(schema.jobTasks.seq));
  const sessionsAll = await viewSessions(and(eq(schema.workSessions.jobId, jobId), sql`${schema.workSessions.status} != 'rejected'`));
  const hourlyTasks = tasks.filter((t) => t.payType === "hourly" || sessionsAll.some((s) => s.taskId === t.id));
  const settings = await hourlySettings();
  const alloc = await vehicleAllocation(hourlyTasks.map((t) => t.id));
  const installerIds = [...new Set([...sessionsAll.map((s) => s.installerId), ...hourlyTasks.map((t) => t.assignedInstallerId).filter((x): x is number => x != null)])];
  const people = installerIds.length
    ? await db
        .select({ id: schema.installers.id, name: schema.installers.name, workerType: schema.installers.workerType })
        .from(schema.installers)
        .where(inArray(schema.installers.id, installerIds))
    : [];
  const nameOf = (id: number) => people.find((p) => p.id === id)?.name ?? `Installer ${id}`;
  const invoices = hourlyTasks.length
    ? await db.select().from(schema.installerInvoices).where(inArray(schema.installerInvoices.taskId, hourlyTasks.map((t) => t.id)))
    : [];

  // Days a worker has time with no vehicle on any of his entries that day. The
  // allowance is per actual vehicle, so a missing one makes the costing
  // incomplete: never read as a zero vehicle cost, never a final saving.
  const withVehicle = installerIds.length
    ? await db
        .selectDistinct({ installerId: schema.workSessions.installerId, workDate: schema.workSessions.workDate })
        .from(schema.workSessions)
        .where(and(inArray(schema.workSessions.installerId, installerIds), sql`${schema.workSessions.vehicleId} is not null`, sql`${schema.workSessions.status} != 'rejected'`))
    : [];
  const hasVehicle = new Set(withVehicle.map((r) => `${r.installerId}|${r.workDate}`));

  const taskViews = [];
  for (const t of hourlyTasks) {
    const ss = sessionsAll.filter((s) => s.taskId === t.id);
    const approved = ss.filter((s) => s.status === "approved");
    const pending = ss.filter((s) => s.status !== "approved");
    const leadTerms0 = t.assignedInstallerId ? await termsOn(t.assignedInstallerId) : null;
    // The plan is priced at the hourly person's agreed rate: the lead on hourly
    // work, the hourly helper (second body) beside a fixed-price lead.
    const helperTerms = t.payType !== "hourly" && t.secondInstallerId ? await termsOn(t.secondInstallerId) : null;
    const leadTerms = t.payType === "hourly" ? termsForTask(leadTerms0, t) : (helperTerms ?? leadTerms0);

    // By worker and band.
    const byWorker = new Map<number, { installerId: number; name: string; approved: Record<Band, { minutes: number; pay: number }>; recordedMinutes: number; estimate: number; approvedPay: number; approvedMinutes: number; unpaidMinutes: number }>();
    const blank = () => Object.fromEntries(BANDS.map((b) => [b, { minutes: 0, pay: 0 }])) as Record<Band, { minutes: number; pay: number }>;
    for (const s of ss) {
      const w =
        byWorker.get(s.installerId) ??
        { installerId: s.installerId, name: nameOf(s.installerId), approved: blank(), recordedMinutes: 0, estimate: 0, approvedPay: 0, approvedMinutes: 0, unpaidMinutes: 0 };
      byWorker.set(s.installerId, w);
      if (s.status === "approved") {
        for (const l of s.payLines ?? []) {
          w.approved[l.band].minutes += l.minutes;
          w.approved[l.band].pay = round2(w.approved[l.band].pay + l.total);
        }
        w.approvedPay = round2(w.approvedPay + (s.approvedPay ?? 0));
        w.approvedMinutes += s.approvedMinutes ?? 0;
        if (s.payable === false) w.unpaidMinutes += s.approvedMinutes ?? 0;
      } else {
        w.recordedMinutes += s.payableMinutes;
        w.estimate = round2(w.estimate + (s.estimate?.total ?? 0));
      }
    }

    const approvedLabour = round2(approved.reduce((a, s) => a + (s.approvedPay ?? 0), 0));
    const recordedEstimate = round2(pending.reduce((a, s) => a + (s.estimate?.total ?? 0), 0));
    // Logged time with no rate yet: counted in hours, never priced at a guessed rate.
    const uncostedMinutes = pending.filter((s) => !(s.estimate && s.estimate.total > 0) && s.categoryPay !== "unpaid").reduce((a, s) => a + s.payableMinutes, 0);
    const vehicleRows = alloc.rows.filter((r) => r.taskId === t.id);
    const vehicle = round2(vehicleRows.reduce((a, r) => a + r.share, 0));
    const vehicleDaysUsed = new Set(vehicleRows.map((r) => r.vehicleDayId)).size;

    const missingKeys = [...new Set(ss.filter((s) => !hasVehicle.has(`${s.installerId}|${s.workDate}`)).map((s) => `${s.installerId}|${s.workDate}`))].sort();
    const vehicleMissing = missingKeys.map((k) => {
      const [id, workDate] = k.split("|");
      return { installerId: Number(id), name: nameOf(Number(id)), workDate: workDate! };
    });
    const final = t.status === "complete" && pending.length === 0 && approved.length > 0 && vehicleMissing.length === 0;
    const hoursSoFar = (approved.reduce((a, s) => a + (s.approvedMinutes ?? 0), 0) + pending.reduce((a, s) => a + s.payableMinutes, 0)) / 60;
    const plannedLabour = t.plannedHours != null && leadTerms ? round2(t.plannedHours * leadTerms.baseRate) : null;
    const plannedVehicle = t.plannedVehicleDays != null ? round2(t.plannedVehicleDays * settings.vehicleAllowanceDefault) : null;
    const remainingLabour = final ? 0 : t.plannedHours != null && leadTerms ? round2(Math.max(0, t.plannedHours - hoursSoFar) * leadTerms.baseRate) : null;
    const remainingVehicle = final ? 0 : t.plannedVehicleDays != null ? round2(Math.max(0, t.plannedVehicleDays - vehicleDaysUsed) * settings.vehicleAllowanceDefault) : null;

    const labourBasis = final ? approvedLabour : round2(approvedLabour + recordedEstimate + (remainingLabour ?? 0));
    const vehicleBasis = final ? vehicle : round2(vehicle + (remainingVehicle ?? 0));
    const cmp0 = compare({ benchmark: t.benchmarkCost, labour: labourBasis, vehicle: vehicleBasis, benchmarkVehicle: (t.benchmarkVehicle as BenchmarkVehicle) ?? "unknown" });
    // Missing vehicle: the vehicle side is unknown, so no saving after vehicle and nothing final.
    const cmp = vehicleMissing.length ? { ...cmp0, savingAfterVehicle: null, provisional: true, incomplete: true } : { ...cmp0, incomplete: false };

    // Contractor invoices matched to approved time, never added to it.
    const recon = [...byWorker.values()].map((w) => {
      // Later-approved hours go on a later invoice (part 2, 3 ...), never a rebill.
      const invs = invoices.filter((i) => i.installerId === w.installerId && i.taskId === t.id).sort((a, b) => (a.part ?? 1) - (b.part ?? 1));
      const inv = invs[invs.length - 1] ?? null;
      let invoicedHours = 0;
      let invoicedHourly = 0;
      for (const one of invs) {
        try {
          for (const l of JSON.parse(one.lineItems) as Array<{ unit: string; qty: number; total: number | null }>) {
            if (l.unit === "hour") {
              invoicedHours += l.qty;
              invoicedHourly += l.total ?? 0;
            }
          }
        } catch {
          /* unreadable lines: shown as nothing matched */
        }
      }
      const invIds = new Set(invs.map((i) => i.id));
      const linked = approved.filter((s) => s.installerId === w.installerId && s.invoiceId != null && invIds.has(s.invoiceId));
      const unbilled = approved.filter((s) => s.installerId === w.installerId && !s.invoiceId && s.payable !== false);
      const linkedPay = round2(linked.reduce((a, s) => a + (s.approvedPay ?? 0), 0));
      return {
        installerId: w.installerId,
        name: w.name,
        /** Employees never invoice. Their approved time is internal labour cost only. */
        employee: people.find((p) => p.id === w.installerId)?.workerType === "employee",
        invoice: inv ? { id: inv.id, number: inv.invoiceNumber, status: inv.status, subtotal: inv.subtotal, gst: inv.gstAmount, total: inv.total } : null,
        /** Every invoice for this person on this task, part 1 first. */
        invoices: invs.map((i) => ({ id: i.id, part: i.part ?? 1, number: i.invoiceNumber, status: i.status, subtotal: i.subtotal, gst: i.gstAmount, total: i.total })),
        approvedPay: w.approvedPay,
        invoicedHourly: round2(invoicedHourly),
        invoicedHours: round2(invoicedHours),
        linkedPay,
        unbilledPay: round2(unbilled.reduce((a, s) => a + (s.approvedPay ?? 0), 0)),
        unbilledSessions: unbilled.length,
        matched: invs.length ? round2(invoicedHourly) === linkedPay : null,
      };
    });

    let scope: Array<{ name: string; qty: number; unit: string; total: number | null }> = [];
    try {
      scope = t.benchmarkBreakdown ? (JSON.parse(t.benchmarkBreakdown) as Array<{ name: string; qty: number; unit: string; total: number | null }>).map((l) => ({ name: l.name, qty: l.qty, unit: l.unit, total: l.total })) : [];
    } catch {
      scope = [];
    }

    taskViews.push({
      taskId: t.id,
      seq: t.seq,
      title: t.title,
      status: t.status,
      payType: t.payType,
      installerId: t.assignedInstallerId,
      installerName: t.assignedInstallerId ? nameOf(t.assignedInstallerId) : null,
      leadRates: ownRatesView(leadTerms),
      benchmark: {
        amount: t.benchmarkCost,
        pricedOn: t.benchmarkPricedOn,
        note: t.benchmarkNote,
        vehicle: (t.benchmarkVehicle as BenchmarkVehicle) ?? "unknown",
        scope,
      },
      plan: { hours: t.plannedHours, vehicleDays: t.plannedVehicleDays, labour: plannedLabour, vehicle: plannedVehicle, combined: plannedLabour != null || plannedVehicle != null ? round2((plannedLabour ?? 0) + (plannedVehicle ?? 0)) : null },
      final,
      /** Days with time but no vehicle assigned: the costing is incomplete until the office assigns one. */
      vehicleMissing,
      costingComplete: vehicleMissing.length === 0,
      soFar: {
        approvedLabour,
        approvedMinutes: approved.reduce((a, s) => a + (s.approvedMinutes ?? 0), 0),
        recordedMinutes: pending.reduce((a, s) => a + s.payableMinutes, 0),
        recordedEstimate,
        uncostedMinutes,
        vehicle,
        vehicleDays: vehicleDaysUsed,
        combined: round2(approvedLabour + vehicle),
      },
      remaining: { labour: remainingLabour, vehicle: remainingVehicle },
      projected: { labour: labourBasis, vehicle: vehicleBasis, combined: cmp.combined },
      comparison: cmp,
      workers: [...byWorker.values()].map((w) => ({
        ...w,
        lines: BANDS.filter((b) => w.approved[b].minutes > 0).map((b) => ({ band: b, label: BAND_LABEL[b], minutes: w.approved[b].minutes, hours: round2(w.approved[b].minutes / 60), pay: w.approved[b].pay })),
      })),
      vehicleRows,
      reconciliation: recon,
      sessions: ss,
    });
  }

  // Margin after allowances: actual revenue less materials, every task's labour
  // (hourly at approved or projected cost), the vehicle allowance and other direct costs.
  const quotes = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId));
  const { quoteThatCounts } = await import("./job-value");
  const { exGst } = await import("./gst");
  const quote = quoteThatCounts(quotes);
  const items = quote ? await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id)) : [];
  const goods = (k: string) => k === "supply" || k === "accessory" || k === "delivery" || k === "supplier_charge";
  const materials = round2(items.filter((i) => goods(i.kind)).reduce((a, i) => a + (i.unitCost ?? 0) * (i.qty ?? 0), 0));
  const otherCosts = await db.select().from(schema.jobCosts).where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.kind, "other")));
  const other = round2(otherCosts.reduce((a, c) => a + c.amount, 0));
  const revenue = exGst(job.value);
  const otherLabour = round2(tasks.filter((t) => !hourlyTasks.some((h) => h.id === t.id)).reduce((a, t) => a + (t.labourCost ?? 0), 0));
  const hourlyLabour = round2(taskViews.reduce((a, t) => a + t.projected.labour, 0));
  const vehicleAll = round2(taskViews.reduce((a, t) => a + t.projected.vehicle, 0));
  const totalCost = round2(materials + otherLabour + hourlyLabour + vehicleAll + other);
  const allFinal = taskViews.length > 0 && taskViews.every((t) => t.final);
  const budget = jobHourlyBudget(taskViews);

  return {
    jobId,
    number: job.number,
    settings,
    pending: pendingSettings(settings),
    tasks: taskViews,
    budget,
    unallocatedVehicleDays: alloc.unallocated,
    margin: {
      revenue,
      materials,
      otherLabour,
      hourlyLabour,
      vehicleAllowance: vehicleAll,
      otherDirect: other,
      cost: totalCost,
      marginAfterAllowances: round2(revenue - totalCost),
      marginPct: revenue > 0 ? round2(((revenue - totalCost) / revenue) * 100) : null,
      final: allFinal,
      /** A vehicle is missing on some day: the margin is not complete. */
      incomplete: taskViews.some((t) => t.vehicleMissing.length > 0),
    },
  };
}

/**
 * Damien, 11 Nov 2026: the whole job's estimated hourly-labour budget, counting
 * every hourly worker and helper on it. Approved cost and logged time not yet
 * approved are kept apart; the forecast is both added together, so a warning
 * comes in time. Logged time with no rate yet is counted in hours only. Never
 * stops a timer, removes hours or changes the customer's price.
 */
export function jobHourlyBudget(
  tasks: Array<{ plan: { labour: number | null; hours: number | null }; soFar: { approvedLabour: number; recordedEstimate: number; uncostedMinutes: number; approvedMinutes: number; recordedMinutes: number } }>,
) {
  const planned = tasks.filter((t) => t.plan.labour != null && t.plan.labour > 0);
  const amount = planned.length ? round2(planned.reduce((a, t) => a + (t.plan.labour ?? 0), 0)) : null;
  const approved = round2(tasks.reduce((a, t) => a + t.soFar.approvedLabour, 0));
  const unapproved = round2(tasks.reduce((a, t) => a + t.soFar.recordedEstimate, 0));
  const forecast = round2(approved + unapproved);
  const pct = amount ? Math.round((forecast / amount) * 1000) / 10 : null;
  return {
    /** Null: no planned hours with a rate on any hourly task, so no alerts. */
    amount,
    plannedHours: round2(tasks.reduce((a, t) => a + (t.plan.hours ?? 0), 0)),
    tasksWithoutPlan: tasks.length - planned.length,
    approved,
    unapproved,
    forecast,
    pct,
    uncostedMinutes: tasks.reduce((a, t) => a + t.soFar.uncostedMinutes, 0),
    approvedMinutes: tasks.reduce((a, t) => a + t.soFar.approvedMinutes, 0),
    unapprovedMinutes: tasks.reduce((a, t) => a + t.soFar.recordedMinutes, 0),
    reached: pct == null ? [] : BUDGET_THRESHOLDS.filter((th) => pct >= th),
  };
}
export const BUDGET_THRESHOLDS = [80, 100] as const;

/* ------------------------------------------------------------------ *
 * The worker's own view
 * ------------------------------------------------------------------ */

/** His own time on one task: an open session if any, and his approved pay. Nothing else. */
export async function myTaskTime(installerId: number, taskId: number) {
  const views = await viewSessions(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.taskId, taskId), sql`${schema.workSessions.status} != 'rejected'`));
  return views.map(crewSessionView);
}

/** The cut down session a worker sees: times, breaks, hours, his own pay. No vehicle, no costing. */
export function crewSessionView(v: SessionView) {
  return {
    id: v.id,
    taskId: v.taskId,
    category: v.category,
    categoryLabel: v.categoryLabel,
    workDate: v.workDate,
    status: v.status,
    start: v.start,
    end: v.end,
    recordedStart: v.recordedStart,
    recordedEnd: v.recordedEnd,
    corrected: v.corrected,
    correctionRequestedAt: v.correctionRequestedAt,
    breaks: v.breaks.map((b) => ({ id: b.id, start: b.start, end: b.end })),
    onBreak: v.breaks.some((b) => !b.end),
    /** Hours recorded, before office approval. */
    recordedMinutes: v.status === "approved" ? null : v.payableMinutes,
    approvedMinutes: v.status === "approved" ? v.approvedMinutes : null,
    approvedPay: v.status === "approved" ? v.approvedPay : null,
    payLines: v.status === "approved" ? v.payLines : null,
  };
}

/** His pay summary across all his hourly work. Approved and recorded kept apart. */
export async function myHourlySummary(installerId: number) {
  const views = await viewSessions(and(eq(schema.workSessions.installerId, installerId), sql`${schema.workSessions.status} != 'rejected'`));
  const approved = views.filter((v) => v.status === "approved");
  const recorded = views.filter((v) => v.status !== "approved");
  const terms = await termsOn(installerId);
  const rated = terms && terms.baseRate > 0 ? terms : null;
  return {
    rates: ownRatesView(rated),
    /** Damien, 11 Nov 2026: no agreed rate reads "Rate to confirm", never $0. */
    rateToConfirm: !rated,
    approvedMinutes: approved.reduce((a, v) => a + (v.approvedMinutes ?? 0), 0),
    approvedPay: round2(approved.reduce((a, v) => a + (v.approvedPay ?? 0), 0)),
    recordedMinutes: recorded.reduce((a, v) => a + v.payableMinutes, 0),
    open: recorded.filter((v) => v.status === "open").map(crewSessionView)[0] ?? null,
  };
}

export const todayBne = () => localDate(new Date());
export { CATEGORIES, CATEGORY_LABEL, BANDS, BAND_LABEL };
