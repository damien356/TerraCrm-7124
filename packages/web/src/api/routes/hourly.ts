import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, installerOnly, staffOnly, type Actor } from "../middleware/auth";
import { ownTaskOrThrow } from "./field";
import { addLocalDays, localDate } from "../lib/local-date";
import { jobText, taskRef } from "../lib/refs";
import { BANDS, CATEGORIES, CATEGORY_LABEL, BAND_LABEL, type SplitPart } from "../lib/hourly-calc";
import {
  BREAK_POLICIES,
  SETTING_KEYS,
  approveSession,
  crewSessionView,
  ensureVehicleDay,
  hourlySettings,
  jobHourlyCosting,
  logTime,
  myHourlySummary,
  ownRatesView,
  pendingSettings,
  putSetting,
  snap,
  termsOn,
  tidyVehicleDays,
  unapproveSession,
  viewSessions,
  type SessionView,
} from "../lib/hourly";

/**
 * HOURLY TIME. Three audiences, three bases:
 *
 *  - the worker (installerOnly): Start work, Break, Resume, Finish work today
 *    and "please fix this one", on his own tasks only. He gets his own times
 *    and his own pay back, nothing else;
 *  - the office (staffOnly): checks, corrects and approves time. Dollar
 *    figures only when the login may see costs;
 *  - costs (Admin, or office with costs switched on): vehicles, the job
 *    costing card, the plan and the vehicle split. Settings and pay terms are
 *    Admin only.
 *
 * Finishing work for the day never completes the task. Every change to time
 * is written to work_time_events with who, before, after and why.
 */

const MAX_BACKDATE_MS = 12 * 60 * 60 * 1000;
const key = z.string().min(6).max(80);
const category = z.enum(CATEGORIES);
const split = z.array(z.object({ band: z.enum(BANDS), minutes: z.number().int().min(0) }));

const actorOf = (a: Actor) => ({ name: a.name || a.email || "Unknown", role: a.role });

/** A tap time from the phone (it may have been offline), kept honest. */
function tapTime(at: string | undefined | null): Date {
  const now = Date.now();
  if (!at) return new Date(now);
  const t = Date.parse(at);
  if (!Number.isFinite(t)) throw new ORPCError("BAD_REQUEST", { message: "That time could not be read." });
  if (t > now + 2 * 60_000) throw new ORPCError("BAD_REQUEST", { message: "That time is in the future." });
  if (t < now - MAX_BACKDATE_MS) {
    throw new ORPCError("BAD_REQUEST", { message: "That is more than 12 hours ago. Ask the office to fix the time instead." });
  }
  return new Date(t);
}

function needCosts(a: Actor) {
  if (!a.canSeeCosts) throw new ORPCError("FORBIDDEN", { message: "Costs access required" });
}

async function sessionOr404(id: number) {
  const [s] = await db.select().from(schema.workSessions).where(eq(schema.workSessions.id, id));
  if (!s) throw new ORPCError("NOT_FOUND", { message: "No such time entry." });
  return s;
}

async function mineOr403(id: number, installerId: number) {
  const s = await sessionOr404(id);
  if (s.installerId !== installerId) throw new ORPCError("FORBIDDEN", { message: "That time isn't yours." });
  return s;
}

async function crewView(id: number) {
  const [v] = await viewSessions(and(eq(schema.workSessions.id, id)));
  return v ? crewSessionView(v) : null;
}

/** No two stretches of time for one man may overlap, whatever task they are on. */
async function assertNoOverlap(installerId: number, start: Date, end: Date | null, exceptId: number | null) {
  const others = await db
    .select()
    .from(schema.workSessions)
    .where(and(eq(schema.workSessions.installerId, installerId), sql`${schema.workSessions.status} != 'rejected'`));
  const s0 = start.getTime();
  const e0 = (end ?? new Date()).getTime();
  for (const o of others) {
    if (o.id === exceptId) continue;
    const s1 = (o.adjStartedAt ?? o.startedAt).getTime();
    const e1 = (o.adjEndedAt ?? o.endedAt ?? new Date()).getTime();
    if (s0 < e1 && s1 < e0) {
      throw new ORPCError("CONFLICT", {
        message: `That overlaps another time entry (#${o.id}, ${o.workDate}). Fix that one first.`,
      });
    }
  }
}

/** Vehicles a worker may pick: names only. No allowance ever reaches the phone. */
async function crewVehicles(installerId: number) {
  const rows = await db.select().from(schema.vehicles).where(eq(schema.vehicles.active, true)).orderBy(asc(schema.vehicles.name));
  return rows.map((v) => ({ id: v.id, name: v.name, mine: v.usualDriverId === installerId }));
}

/** The office row: names and refs added, dollars removed unless costs are allowed. */
async function officeRows(views: SessionView[], canSeeCosts: boolean) {
  const installerIds = [...new Set(views.map((v) => v.installerId))];
  const taskIds = [...new Set(views.map((v) => v.taskId))];
  const people = installerIds.length
    ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, installerIds))
    : [];
  const tasks = taskIds.length
    ? await db
        .select({ id: schema.jobTasks.id, seq: schema.jobTasks.seq, title: schema.jobTasks.title, payType: schema.jobTasks.payType, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber, jobId: schema.jobs.id })
        .from(schema.jobTasks)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .where(inArray(schema.jobTasks.id, taskIds))
    : [];
  const vehicles = await db.select({ id: schema.vehicles.id, name: schema.vehicles.name }).from(schema.vehicles);
  return views.map((v) => {
    const t = tasks.find((x) => x.id === v.taskId);
    const row = {
      ...v,
      installerName: people.find((p) => p.id === v.installerId)?.name ?? `Installer ${v.installerId}`,
      taskRef: t ? taskRef(jobText(t), t.seq) : `Task ${v.taskId}`,
      taskTitle: t?.title ?? "",
      vehicleName: v.vehicleId ? (vehicles.find((x) => x.id === v.vehicleId)?.name ?? null) : null,
    };
    if (canSeeCosts) return row;
    return {
      ...row,
      approvedPay: null,
      rateBase: null,
      estimate: null,
      payLines: row.payLines ? row.payLines.map((l) => ({ ...l, rate: 0, total: 0 })) : null,
    };
  });
}

/* ================================================================== *
 * The worker
 * ================================================================== */

const crew = {
  /** Everything the time controls on one task need. His own time only. */
  myTime: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);
    const terms = await termsOn(context.installerId);
    const views = await viewSessions(
      and(eq(schema.workSessions.installerId, context.installerId), sql`${schema.workSessions.status} != 'rejected'`),
    );
    const here = views.filter((v) => v.taskId === task.id);
    const openAnywhere = views.find((v) => v.status === "open") ?? null;
    return {
      enabled: Boolean(terms),
      taskId: task.id,
      taskStatus: task.status,
      rates: ownRatesView(terms),
      sessions: here.map(crewSessionView),
      open: openAnywhere ? crewSessionView(openAnywhere) : null,
      openElsewhere: Boolean(openAnywhere && openAnywhere.taskId !== task.id),
      approvedMinutes: here.filter((v) => v.status === "approved").reduce((a, v) => a + (v.approvedMinutes ?? 0), 0),
      approvedPay: Math.round(here.filter((v) => v.status === "approved").reduce((a, v) => a + (v.approvedPay ?? 0), 0) * 100) / 100,
      recordedMinutes: here.filter((v) => v.status !== "approved").reduce((a, v) => a + v.payableMinutes, 0),
      vehicles: terms ? await crewVehicles(context.installerId) : [],
      categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })),
    };
  }),

  mySummary: installerOnly.handler(async ({ context }) => myHourlySummary(context.installerId)),

  /** Start work. A retry with the same clientKey returns the same entry, never a second one. */
  start: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        clientKey: key,
        category: category.default("site"),
        vehicleId: z.number().nullable().optional(),
        at: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const installerId = context.installerId;
      const [again] = await db
        .select()
        .from(schema.workSessions)
        .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.clientKey, input.clientKey)));
      if (again) return { session: await crewView(again.id), repeated: true };

      const task = await ownTaskOrThrow(input.taskId, installerId);
      if (task.status === "complete" || task.status === "cancelled") {
        throw new ORPCError("BAD_REQUEST", { message: "This task is closed. Talk to the office." });
      }
      const at = tapTime(input.at);
      const terms = await termsOn(installerId, localDate(at));
      if (!terms) throw new ORPCError("FORBIDDEN", { message: "You are not set up for hourly time. Talk to the office." });

      const [open] = await db
        .select()
        .from(schema.workSessions)
        .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.status, "open")));
      if (open) {
        throw new ORPCError("CONFLICT", {
          message: open.taskId === task.id ? "You are already on the clock for this job." : "You are still on the clock on another job. Finish that first.",
        });
      }
      await assertNoOverlap(installerId, at, null, null);

      let vehicleId = input.vehicleId === undefined ? null : input.vehicleId;
      if (input.vehicleId === undefined) {
        const [usual] = await db
          .select()
          .from(schema.vehicles)
          .where(and(eq(schema.vehicles.usualDriverId, installerId), eq(schema.vehicles.active, true)))
          .limit(1);
        vehicleId = usual?.id ?? null;
      }
      const workDate = localDate(at);
      try {
        const [row] = await db
          .insert(schema.workSessions)
          .values({
            installerId,
            taskId: task.id,
            jobId: task.jobId,
            category: input.category,
            clientKey: input.clientKey,
            workDate,
            startedAt: at,
            vehicleId,
            source: "app",
            status: "open",
          })
          .returning();
        await ensureVehicleDay(vehicleId, workDate);
        await logTime({ session: row!, action: "start", actor: actorOf(context.actor), after: snap(row!) });
        return { session: await crewView(row!.id), repeated: false };
      } catch (e) {
        // Two taps racing: the unique indexes decide, and the retry gets the row.
        const [raced] = await db
          .select()
          .from(schema.workSessions)
          .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.clientKey, input.clientKey)));
        if (raced) return { session: await crewView(raced.id), repeated: true };
        const msg = String((e as Error)?.message ?? e);
        if (msg.includes("work_sessions_one_open") || msg.includes("UNIQUE")) {
          throw new ORPCError("CONFLICT", { message: "You are already on the clock. Finish that first." });
        }
        throw e;
      }
    }),

  /** Break. One open break at a time; a retry returns the same break. */
  pause: installerOnly
    .input(z.object({ sessionId: z.number(), clientKey: key, at: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const s = await mineOr403(input.sessionId, context.installerId);
      const [again] = await db
        .select()
        .from(schema.workBreaks)
        .where(and(eq(schema.workBreaks.sessionId, s.id), eq(schema.workBreaks.clientKey, input.clientKey)));
      if (again) return { session: await crewView(s.id), repeated: true };
      if (s.status !== "open") throw new ORPCError("BAD_REQUEST", { message: "You are not on the clock." });
      const [openBreak] = await db
        .select()
        .from(schema.workBreaks)
        .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)));
      if (openBreak) return { session: await crewView(s.id), repeated: true };
      const at = tapTime(input.at);
      if (at.getTime() < s.startedAt.getTime()) throw new ORPCError("BAD_REQUEST", { message: "A break can't start before work did." });
      await db.insert(schema.workBreaks).values({ sessionId: s.id, clientKey: input.clientKey, startedAt: at }).onConflictDoNothing();
      await logTime({ session: s, action: "break_start", actor: actorOf(context.actor), after: { at: at.toISOString() } });
      return { session: await crewView(s.id), repeated: false };
    }),

  /** Resume. Ending a break that is already ended is a no-op. */
  resume: installerOnly
    .input(z.object({ sessionId: z.number(), at: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const s = await mineOr403(input.sessionId, context.installerId);
      const [openBreak] = await db
        .select()
        .from(schema.workBreaks)
        .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)));
      if (!openBreak) return { session: await crewView(s.id), repeated: true };
      const at = tapTime(input.at);
      const end = at.getTime() < openBreak.startedAt.getTime() ? openBreak.startedAt : at;
      await db.update(schema.workBreaks).set({ endedAt: end, updatedAt: new Date() }).where(eq(schema.workBreaks.id, openBreak.id));
      await logTime({ session: s, action: "break_end", actor: actorOf(context.actor), after: { at: end.toISOString() } });
      return { session: await crewView(s.id), repeated: false };
    }),

  /** Finish work today. Closes any open break. Never completes the task. */
  finish: installerOnly
    .input(z.object({ sessionId: z.number(), at: z.string().optional(), note: z.string().max(500).optional() }))
    .handler(async ({ input, context }) => {
      const s = await mineOr403(input.sessionId, context.installerId);
      if (s.status !== "open") return { session: await crewView(s.id), repeated: true };
      const at = tapTime(input.at);
      const end = at.getTime() < s.startedAt.getTime() ? s.startedAt : at;
      await db
        .update(schema.workBreaks)
        .set({ endedAt: end, updatedAt: new Date() })
        .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)));
      await db
        .update(schema.workSessions)
        .set({ endedAt: end, status: "recorded", note: input.note ?? s.note, updatedAt: new Date() })
        .where(and(eq(schema.workSessions.id, s.id), eq(schema.workSessions.status, "open")));
      const after = await sessionOr404(s.id);
      await logTime({ session: s, action: "finish", actor: actorOf(context.actor), before: snap(s), after: snap(after) });
      return { session: await crewView(s.id), repeated: false };
    }),

  /** "This one is wrong." The office fixes it; the worker never edits recorded time. */
  requestCorrection: installerOnly
    .input(z.object({ sessionId: z.number(), note: z.string().min(3).max(500) }))
    .handler(async ({ input, context }) => {
      const s = await mineOr403(input.sessionId, context.installerId);
      if (s.invoiceId) throw new ORPCError("BAD_REQUEST", { message: "This time is already on your invoice. Talk to the office." });
      await db
        .update(schema.workSessions)
        .set({ correctionRequestedAt: new Date(), correctionNote: input.note, updatedAt: new Date() })
        .where(eq(schema.workSessions.id, s.id));
      await logTime({ session: s, action: "correction_requested", actor: actorOf(context.actor), reason: input.note });
      return { session: await crewView(s.id) };
    }),
};

/* ================================================================== *
 * The office: check, correct, approve
 * ================================================================== */

const office = {
  /** Time to look at. Default: everything not approved yet, oldest first. */
  queue: staffOnly
    .input(
      z.object({
        status: z.enum(["open", "recorded", "approved", "rejected", "todo", "all"]).default("todo"),
        installerId: z.number().optional(),
        jobId: z.number().optional(),
        taskId: z.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const conds = [
        input.status === "todo"
          ? sql`${schema.workSessions.status} in ('open','recorded')`
          : input.status === "all"
            ? sql`1 = 1`
            : eq(schema.workSessions.status, input.status),
      ];
      if (input.installerId) conds.push(eq(schema.workSessions.installerId, input.installerId));
      if (input.jobId) conds.push(eq(schema.workSessions.jobId, input.jobId));
      if (input.taskId) conds.push(eq(schema.workSessions.taskId, input.taskId));
      if (input.from) conds.push(sql`${schema.workSessions.workDate} >= ${input.from}`);
      if (input.to) conds.push(sql`${schema.workSessions.workDate} <= ${input.to}`);
      const views = await viewSessions(and(...conds));
      const settings = await hourlySettings();
      return {
        rows: await officeRows(views, context.actor.canSeeCosts),
        pending: pendingSettings(settings),
        nightWindow: settings.nightWindow,
        breakPolicy: settings.breakPolicy,
        canSeeCosts: context.actor.canSeeCosts,
        bands: BANDS.map((b) => ({ id: b, label: BAND_LABEL[b] })),
        categories: CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c], pay: settings.categories[c] })),
      };
    }),

  /** Who changed what, oldest first. */
  history: staffOnly.input(z.object({ sessionId: z.number() })).handler(async ({ input }) => {
    return db
      .select()
      .from(schema.workTimeEvents)
      .where(eq(schema.workTimeEvents.sessionId, input.sessionId))
      .orderBy(asc(schema.workTimeEvents.createdAt), asc(schema.workTimeEvents.id));
  }),

  /**
   * Fix a time entry: start, end, task, category or vehicle. The recorded
   * times stay as they were; the corrected ones sit beside them. Approved
   * time has to be un-approved first, so a change is always seen twice.
   */
  correct: staffOnly
    .input(
      z.object({
        sessionId: z.number(),
        start: z.string().nullable().optional(),
        end: z.string().nullable().optional(),
        taskId: z.number().optional(),
        category: category.optional(),
        vehicleId: z.number().nullable().optional(),
        reason: z.string().min(3).max(500),
      }),
    )
    .handler(async ({ input, context }) => {
      const s = await sessionOr404(input.sessionId);
      if (s.status === "approved") throw new ORPCError("BAD_REQUEST", { message: "Un-approve this time first, then correct it." });
      if (s.status === "rejected") throw new ORPCError("BAD_REQUEST", { message: "This entry was rejected." });
      const parse = (v: string | null | undefined, fallback: Date | null) => {
        if (v === undefined) return fallback;
        if (v === null) return null;
        const t = Date.parse(v);
        if (!Number.isFinite(t)) throw new ORPCError("BAD_REQUEST", { message: "That time could not be read." });
        return new Date(t);
      };
      const adjStart = parse(input.start, s.adjStartedAt);
      const adjEnd = parse(input.end, s.adjEndedAt);
      const start = adjStart ?? s.startedAt;
      const end = adjEnd ?? s.endedAt;
      if (end && end.getTime() <= start.getTime()) throw new ORPCError("BAD_REQUEST", { message: "Finish must be after start." });
      if (end && end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) {
        throw new ORPCError("BAD_REQUEST", { message: "One entry can't be longer than 24 hours. Split it into days." });
      }
      if (end && end.getTime() > Date.now() + 60_000) throw new ORPCError("BAD_REQUEST", { message: "Finish is in the future." });

      let taskId = s.taskId;
      let jobId = s.jobId;
      if (input.taskId && input.taskId !== s.taskId) {
        const [t] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
        if (!t) throw new ORPCError("BAD_REQUEST", { message: "No such task." });
        if (t.assignedInstallerId !== s.installerId && t.secondInstallerId !== s.installerId) {
          throw new ORPCError("BAD_REQUEST", { message: "That task isn't assigned to this worker." });
        }
        taskId = t.id;
        jobId = t.jobId;
      }
      await assertNoOverlap(s.installerId, start, end, s.id);

      const workDate = localDate(start);
      const vehicleId = input.vehicleId === undefined ? s.vehicleId : input.vehicleId;
      // Closing a missed clock-out makes it finished time, never approved time.
      const status = s.status === "open" && end ? "recorded" : s.status;
      const timesMoved = adjStart?.getTime() !== s.adjStartedAt?.getTime() || adjEnd?.getTime() !== s.adjEndedAt?.getTime();
      await db
        .update(schema.workSessions)
        .set({
          adjStartedAt: adjStart,
          adjEndedAt: adjEnd,
          taskId,
          jobId,
          workDate,
          category: input.category ?? s.category,
          vehicleId,
          status,
          // A confirmed band split no longer fits new times; it is confirmed again.
          ...(timesMoved ? { bandSplit: null, bandConfirmedBy: null, bandConfirmedAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.workSessions.id, s.id));
      if (status === "recorded" && s.status === "open") {
        await db
          .update(schema.workBreaks)
          .set({ endedAt: end, updatedAt: new Date() })
          .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)));
      }
      await ensureVehicleDay(vehicleId, workDate);
      await tidyVehicleDays([s.vehicleId, vehicleId]);
      const after = await sessionOr404(s.id);
      await logTime({ session: after, action: "corrected", actor: actorOf(context.actor), before: snap(s), after: snap(after), reason: input.reason });
      const [v] = await viewSessions(and(eq(schema.workSessions.id, s.id)));
      return (await officeRows([v!], context.actor.canSeeCosts))[0]!;
    }),

  /** Mark one break paid or unpaid, or fix its times. */
  decideBreak: staffOnly
    .input(
      z.object({
        breakId: z.number(),
        paid: z.boolean().nullable().optional(),
        start: z.string().optional(),
        end: z.string().nullable().optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [b] = await db.select().from(schema.workBreaks).where(eq(schema.workBreaks.id, input.breakId));
      if (!b) throw new ORPCError("NOT_FOUND", { message: "No such break." });
      const s = await sessionOr404(b.sessionId);
      if (s.status === "approved") throw new ORPCError("BAD_REQUEST", { message: "Un-approve this time first." });
      const start = input.start ? new Date(Date.parse(input.start)) : b.startedAt;
      const end = input.end === undefined ? b.endedAt : input.end === null ? null : new Date(Date.parse(input.end));
      if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) throw new ORPCError("BAD_REQUEST", { message: "That time could not be read." });
      if (end && end.getTime() <= start.getTime()) throw new ORPCError("BAD_REQUEST", { message: "Break end must be after its start." });
      const timesChanged = start.getTime() !== b.startedAt.getTime() || (end?.getTime() ?? null) !== (b.endedAt?.getTime() ?? null);
      if (timesChanged && !input.reason) throw new ORPCError("BAD_REQUEST", { message: "Say why the break times changed." });
      await db
        .update(schema.workBreaks)
        .set({
          startedAt: start,
          endedAt: end,
          ...(input.paid !== undefined ? { paid: input.paid, decidedByName: input.paid === null ? null : actorOf(context.actor).name } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.workBreaks.id, b.id));
      if (timesChanged) {
        await db.update(schema.workSessions).set({ bandSplit: null, bandConfirmedBy: null, bandConfirmedAt: null, updatedAt: new Date() }).where(eq(schema.workSessions.id, s.id));
      }
      await logTime({
        session: s,
        action: "break_decided",
        actor: actorOf(context.actor),
        before: { start: b.startedAt.toISOString(), end: b.endedAt?.toISOString() ?? null, paid: b.paid },
        after: { start: start.toISOString(), end: end?.toISOString() ?? null, paid: input.paid === undefined ? b.paid : input.paid },
        reason: input.reason ?? null,
      });
      const [v] = await viewSessions(and(eq(schema.workSessions.id, s.id)));
      return (await officeRows([v!], context.actor.canSeeCosts))[0]!;
    }),

  /** Confirm which band each minute is paid at. Must add up to the payable minutes. */
  confirmBand: staffOnly
    .input(z.object({ sessionId: z.number(), split }))
    .handler(async ({ input, context }) => {
      const s = await sessionOr404(input.sessionId);
      if (s.status === "approved") throw new ORPCError("BAD_REQUEST", { message: "Un-approve this time first." });
      const [v] = await viewSessions(and(eq(schema.workSessions.id, s.id)));
      const sum = input.split.reduce((a, p) => a + p.minutes, 0);
      if (sum !== v!.payableMinutes) {
        throw new ORPCError("BAD_REQUEST", { message: `The bands add up to ${sum} minutes. This entry has ${v!.payableMinutes} payable minutes.` });
      }
      const clean: SplitPart[] = input.split.filter((p) => p.minutes > 0);
      await db
        .update(schema.workSessions)
        .set({ bandSplit: JSON.stringify(clean), bandConfirmedBy: actorOf(context.actor).name, bandConfirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.workSessions.id, s.id));
      await logTime({ session: s, action: "band_confirmed", actor: actorOf(context.actor), before: s.bandSplit, after: clean });
      const [after] = await viewSessions(and(eq(schema.workSessions.id, s.id)));
      return (await officeRows([after!], context.actor.canSeeCosts))[0]!;
    }),

  /** Approve. Copies the rate onto the entry; it is never recalculated after this. */
  approve: staffOnly
    .input(z.object({ sessionId: z.number(), split: split.optional() }))
    .handler(async ({ input, context }) => {
      await approveSession(input.sessionId, actorOf(context.actor), input.split ?? null);
      const [v] = await viewSessions(and(eq(schema.workSessions.id, input.sessionId)));
      return (await officeRows([v!], context.actor.canSeeCosts))[0]!;
    }),

  unapprove: staffOnly
    .input(z.object({ sessionId: z.number(), reason: z.string().min(3).max(500) }))
    .handler(async ({ input, context }) => {
      await unapproveSession(input.sessionId, actorOf(context.actor), input.reason);
      const [v] = await viewSessions(and(eq(schema.workSessions.id, input.sessionId)));
      return (await officeRows([v!], context.actor.canSeeCosts))[0]!;
    }),

  /** Not real time (a test tap, a duplicate). Kept, with the reason, never counted. */
  reject: staffOnly
    .input(z.object({ sessionId: z.number(), reason: z.string().min(3).max(500) }))
    .handler(async ({ input, context }) => {
      const s = await sessionOr404(input.sessionId);
      if (s.status === "approved") throw new ORPCError("BAD_REQUEST", { message: "Un-approve this time first." });
      const now = new Date();
      await db
        .update(schema.workBreaks)
        .set({ endedAt: s.adjEndedAt ?? s.endedAt ?? now, updatedAt: now })
        .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)));
      await db
        .update(schema.workSessions)
        .set({ status: "rejected", endedAt: s.endedAt ?? now, updatedAt: now })
        .where(eq(schema.workSessions.id, s.id));
      await tidyVehicleDays([s.vehicleId]);
      const after = await sessionOr404(s.id);
      await logTime({ session: s, action: "rejected", actor: actorOf(context.actor), before: snap(s), after: snap(after), reason: input.reason });
      return { ok: true };
    }),

  /** Time the phone never recorded (no signal, forgot the app). Office entered, with a reason. */
  manual: staffOnly
    .input(
      z.object({
        installerId: z.number(),
        taskId: z.number(),
        start: z.string(),
        end: z.string(),
        category: category.default("site"),
        vehicleId: z.number().nullable().default(null),
        breaks: z.array(z.object({ start: z.string(), end: z.string(), paid: z.boolean().nullable().default(null) })).default([]),
        reason: z.string().min(3).max(500),
      }),
    )
    .handler(async ({ input, context }) => {
      const [t] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
      if (!t) throw new ORPCError("BAD_REQUEST", { message: "No such task." });
      if (t.assignedInstallerId !== input.installerId && t.secondInstallerId !== input.installerId) {
        throw new ORPCError("BAD_REQUEST", { message: "That task isn't assigned to this worker." });
      }
      const start = new Date(Date.parse(input.start));
      const end = new Date(Date.parse(input.end));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ORPCError("BAD_REQUEST", { message: "That time could not be read." });
      if (end.getTime() <= start.getTime()) throw new ORPCError("BAD_REQUEST", { message: "Finish must be after start." });
      if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) throw new ORPCError("BAD_REQUEST", { message: "One entry can't be longer than 24 hours." });
      if (end.getTime() > Date.now() + 60_000) throw new ORPCError("BAD_REQUEST", { message: "Finish is in the future." });
      if (!(await termsOn(input.installerId, localDate(start)))) {
        throw new ORPCError("BAD_REQUEST", { message: "This worker has no hourly pay terms on that date." });
      }
      await assertNoOverlap(input.installerId, start, end, null);
      const workDate = localDate(start);
      const [row] = await db
        .insert(schema.workSessions)
        .values({
          installerId: input.installerId,
          taskId: t.id,
          jobId: t.jobId,
          category: input.category,
          clientKey: `office-${crypto.randomUUID()}`,
          workDate,
          startedAt: start,
          endedAt: end,
          vehicleId: input.vehicleId,
          source: "office",
          status: "recorded",
          note: input.reason,
        })
        .returning();
      for (const [i, b] of input.breaks.entries()) {
        const bs = new Date(Date.parse(b.start));
        const be = new Date(Date.parse(b.end));
        if (Number.isNaN(bs.getTime()) || Number.isNaN(be.getTime()) || be <= bs) throw new ORPCError("BAD_REQUEST", { message: "A break time could not be read." });
        await db.insert(schema.workBreaks).values({
          sessionId: row!.id,
          clientKey: `office-${i}`,
          startedAt: bs,
          endedAt: be,
          paid: b.paid,
          decidedByName: b.paid == null ? null : actorOf(context.actor).name,
        });
      }
      await ensureVehicleDay(input.vehicleId, workDate);
      await logTime({ session: row!, action: "manual_entry", actor: actorOf(context.actor), after: snap(row!), reason: input.reason });
      const [v] = await viewSessions(and(eq(schema.workSessions.id, row!.id)));
      return (await officeRows([v!], context.actor.canSeeCosts))[0]!;
    }),

  /** Workers on hourly terms, for the office pickers. Rates only with costs access. */
  workers: staffOnly.handler(async ({ context }) => {
    const rows = await db
      .select({ installerId: schema.installerPayTerms.installerId, name: schema.installers.name })
      .from(schema.installerPayTerms)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.installerPayTerms.installerId))
      .groupBy(schema.installerPayTerms.installerId, schema.installers.name)
      .orderBy(asc(schema.installers.name));
    const out = [];
    for (const r of rows) {
      const t = await termsOn(r.installerId);
      out.push({ ...r, current: Boolean(t), rates: context.actor.canSeeCosts ? ownRatesView(t) : null });
    }
    return out;
  }),

  /** Tasks a worker is on, for the office "add time" picker. Not cancelled, newest first. */
  workerTasks: staffOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .select({ id: schema.jobTasks.id, seq: schema.jobTasks.seq, title: schema.jobTasks.title, status: schema.jobTasks.status, payType: schema.jobTasks.payType, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber, jobId: schema.jobs.id })
      .from(schema.jobTasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .where(
        and(
          sql`(${schema.jobTasks.assignedInstallerId} = ${input.installerId} or ${schema.jobTasks.secondInstallerId} = ${input.installerId})`,
          sql`${schema.jobTasks.status} != 'cancelled'`,
        ),
      )
      .orderBy(desc(schema.jobTasks.id))
      .limit(60);
    return rows.map((t) => ({ id: t.id, jobId: t.jobId, ref: taskRef(jobText(t), t.seq), title: t.title, status: t.status, hourly: t.payType === "hourly" }));
  }),

  vehicleNames: staffOnly.handler(async () => {
    const rows = await db.select().from(schema.vehicles).orderBy(asc(schema.vehicles.name));
    return rows.map((v) => ({ id: v.id, name: v.name, active: v.active, isTest: v.isTest }));
  }),
};

/* ================================================================== *
 * Costs, vehicles, settings and pay terms
 * ================================================================== */

const costs = {
  /** The office job card for hourly work. Labelled "so far" until the work is finished. */
  job: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => {
    needCosts(context.actor);
    return jobHourlyCosting(input.jobId);
  }),

  /** Planned hours and vehicle days, and whether the benchmark already covers the vehicle. */
  plan: staffOnly
    .input(
      z.object({
        taskId: z.number(),
        plannedHours: z.number().min(0).max(2000).nullable().optional(),
        plannedVehicleDays: z.number().min(0).max(365).nullable().optional(),
        benchmarkVehicle: z.enum(["unknown", "included", "excluded"]).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      needCosts(context.actor);
      const [t] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
      if (!t) throw new ORPCError("NOT_FOUND", { message: "No such task." });
      await db
        .update(schema.jobTasks)
        .set({
          ...(input.plannedHours !== undefined ? { plannedHours: input.plannedHours } : {}),
          ...(input.plannedVehicleDays !== undefined ? { plannedVehicleDays: input.plannedVehicleDays } : {}),
          ...(input.benchmarkVehicle !== undefined ? { benchmarkVehicle: input.benchmarkVehicle } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, t.id));
      await logTime({
        session: null,
        action: "task_plan",
        actor: actorOf(context.actor),
        before: { taskId: t.id, plannedHours: t.plannedHours, plannedVehicleDays: t.plannedVehicleDays, benchmarkVehicle: t.benchmarkVehicle },
        after: input,
      });
      return { ok: true };
    }),

  /** Override how one vehicle day splits across jobs. Must add up to the day's allowance. Empty list clears it. */
  vehicleShare: staffOnly
    .input(
      z.object({
        vehicleDayId: z.number(),
        shares: z.array(z.object({ taskId: z.number(), share: z.number().min(0) })),
        note: z.string().min(3).max(500),
      }),
    )
    .handler(async ({ input, context }) => {
      needCosts(context.actor);
      const [d] = await db.select().from(schema.vehicleDays).where(eq(schema.vehicleDays.id, input.vehicleDayId));
      if (!d) throw new ORPCError("NOT_FOUND", { message: "No such vehicle day." });
      if (input.shares.length) {
        const cents = Math.round(input.shares.reduce((a, s) => a + s.share, 0) * 100);
        if (cents !== Math.round(d.allowance * 100)) {
          throw new ORPCError("BAD_REQUEST", { message: `The shares must add up to $${d.allowance.toFixed(2)}.` });
        }
      }
      const before = await db.select().from(schema.vehicleDayShares).where(eq(schema.vehicleDayShares.vehicleDayId, d.id));
      await db.delete(schema.vehicleDayShares).where(eq(schema.vehicleDayShares.vehicleDayId, d.id));
      for (const s of input.shares) {
        await db.insert(schema.vehicleDayShares).values({ vehicleDayId: d.id, taskId: s.taskId, share: s.share, note: input.note, byName: actorOf(context.actor).name });
      }
      await logTime({
        session: null,
        action: "vehicle_share",
        actor: actorOf(context.actor),
        before: { vehicleDayId: d.id, shares: before.map((b) => ({ taskId: b.taskId, share: b.share })) },
        after: { vehicleDayId: d.id, shares: input.shares },
        reason: input.note,
      });
      return { ok: true };
    }),

  vehicles: staffOnly.handler(async ({ context }) => {
    needCosts(context.actor);
    const rows = await db
      .select({ v: schema.vehicles, driver: schema.installers.name })
      .from(schema.vehicles)
      .leftJoin(schema.installers, eq(schema.installers.id, schema.vehicles.usualDriverId))
      .orderBy(desc(schema.vehicles.active), asc(schema.vehicles.name));
    return rows.map((r) => ({ ...r.v, usualDriverName: r.driver }));
  }),

  /**
   * Add or change a vehicle. A new allowance applies to days not used yet;
   * a day already used keeps the allowance it was first used at.
   */
  saveVehicle: staffOnly
    .input(
      z.object({
        id: z.number().optional(),
        name: z.string().min(1).max(80),
        usualDriverId: z.number().nullable().default(null),
        dailyAllowance: z.number().min(0).max(1000).default(50),
        isTest: z.boolean().default(false),
        active: z.boolean().default(true),
        notes: z.string().max(500).nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => {
      needCosts(context.actor);
      const { id, ...vals } = input;
      if (id) {
        const [before] = await db.select().from(schema.vehicles).where(eq(schema.vehicles.id, id));
        if (!before) throw new ORPCError("NOT_FOUND", { message: "No such vehicle." });
        await db.update(schema.vehicles).set({ ...vals, updatedAt: new Date() }).where(eq(schema.vehicles.id, id));
        await logTime({ session: null, action: "vehicle_saved", actor: actorOf(context.actor), before, after: { id, ...vals } });
        return { id };
      }
      const [row] = await db.insert(schema.vehicles).values(vals).returning();
      await logTime({ session: null, action: "vehicle_added", actor: actorOf(context.actor), after: row });
      return { id: row!.id };
    }),

  settings: staffOnly.handler(async ({ context }) => {
    needCosts(context.actor);
    const s = await hourlySettings();
    return { ...s, pending: pendingSettings(s), breakPolicies: BREAK_POLICIES, categoryLabels: CATEGORY_LABEL };
  }),

  /** Admin only. Each unanswered question stays "pending" and keeps blocking the time it affects. */
  saveSettings: adminOnly
    .input(
      z.object({
        nightWindow: z
          .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
          .nullable()
          .optional(),
        breakPolicy: z.enum(BREAK_POLICIES).optional(),
        categories: z.record(z.string(), z.enum(["pending", "paid", "unpaid"])).optional(),
        vehicleAllowanceDefault: z.number().min(0).max(1000).optional(),
        benchmarkVehicleDefault: z.enum(["unknown", "included", "excluded"]).optional(),
        reason: z.string().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const before = await hourlySettings();
      if (input.nightWindow !== undefined) {
        if (input.nightWindow && input.nightWindow.start === input.nightWindow.end) {
          throw new ORPCError("BAD_REQUEST", { message: "Night start and end can't be the same time." });
        }
        await putSetting(SETTING_KEYS.night, JSON.stringify(input.nightWindow));
      }
      if (input.breakPolicy) await putSetting(SETTING_KEYS.breaks, input.breakPolicy);
      if (input.categories) {
        const clean = Object.fromEntries(Object.entries(input.categories).filter(([k]) => (CATEGORIES as readonly string[]).includes(k) && k !== "site"));
        await putSetting(SETTING_KEYS.categories, JSON.stringify({ ...before.categories, ...clean }));
      }
      if (input.vehicleAllowanceDefault != null) await putSetting(SETTING_KEYS.vehicleDefault, String(input.vehicleAllowanceDefault));
      if (input.benchmarkVehicleDefault) await putSetting(SETTING_KEYS.benchmarkVehicle, input.benchmarkVehicleDefault);
      const after = await hourlySettings();
      await logTime({ session: null, action: "settings", actor: actorOf(context.actor), before, after, reason: input.reason ?? null });
      return { ...after, pending: pendingSettings(after) };
    }),

  /** Every pay terms row for one worker, newest first. Admin only. */
  terms: adminOnly.input(z.object({ installerId: z.number() })).handler(async ({ input }) => {
    return db
      .select()
      .from(schema.installerPayTerms)
      .where(eq(schema.installerPayTerms.installerId, input.installerId))
      .orderBy(desc(schema.installerPayTerms.effectiveFrom), desc(schema.installerPayTerms.id));
  }),

  /**
   * New pay terms from a date. The row before it is ended the day before.
   * Never edits a row in place, and approved time keeps the rate it was
   * approved at whatever is added here.
   */
  addTerms: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        baseRate: z.number().positive().max(500),
        weekendMultiplier: z.number().min(1).max(4).default(1.5),
        nightMultiplier: z.number().min(1).max(4).default(2),
        gstRegistered: z.boolean(),
        gstNote: z.string().min(3).max(300),
        defaultForNew: z.boolean().default(true),
        effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        note: z.string().max(500).nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => {
      const [inst] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
      if (!inst) throw new ORPCError("NOT_FOUND", { message: "No such installer." });
      const [clash] = await db
        .select()
        .from(schema.installerPayTerms)
        .where(and(eq(schema.installerPayTerms.installerId, input.installerId), eq(schema.installerPayTerms.effectiveFrom, input.effectiveFrom)));
      if (clash) throw new ORPCError("CONFLICT", { message: "There are already terms from that date. Pick the next day." });
      const dayBefore = addLocalDays(input.effectiveFrom, -1);
      const prev = await db
        .select()
        .from(schema.installerPayTerms)
        .where(
          and(
            eq(schema.installerPayTerms.installerId, input.installerId),
            lt(schema.installerPayTerms.effectiveFrom, input.effectiveFrom),
            sql`(${schema.installerPayTerms.effectiveTo} is null or ${schema.installerPayTerms.effectiveTo} >= ${input.effectiveFrom})`,
          ),
        );
      for (const p of prev) {
        await db.update(schema.installerPayTerms).set({ effectiveTo: dayBefore, updatedAt: new Date() }).where(eq(schema.installerPayTerms.id, p.id));
      }
      const later = await db
        .select()
        .from(schema.installerPayTerms)
        .where(and(eq(schema.installerPayTerms.installerId, input.installerId), sql`${schema.installerPayTerms.effectiveFrom} > ${input.effectiveFrom}`))
        .orderBy(asc(schema.installerPayTerms.effectiveFrom));
      const [row] = await db
        .insert(schema.installerPayTerms)
        .values({
          ...input,
          basis: "hourly",
          effectiveTo: later[0] ? addLocalDays(later[0].effectiveFrom, -1) : null,
          createdByName: actorOf(context.actor).name,
        })
        .returning();
      await logTime({
        session: null,
        action: "pay_terms",
        actor: actorOf(context.actor),
        before: prev.map((p) => ({ id: p.id, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo })),
        after: row,
        reason: input.note,
      });
      return row!;
    }),
};

export const hourly = { ...crew, ...office, ...costs };
