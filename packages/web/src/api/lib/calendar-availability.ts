import { ORPCError } from "@orpc/server";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { freeBusy, safeIds, type RawBusy } from "./google-calendar";
import { addLocalDays, todayLocal } from "./local-date";
import { mayWorkBetween, resolveRun, slotCols, windowDates, workSlots } from "./task-run";
import { jobNumberSql } from "./job-ref";

/* ---------------------------------------------------------------------------
 * Personal availability for calendar-checked people (Damien, 30 Oct).
 *
 * The rules, in one place so every booking path asks the same question:
 *
 * - Only people with a calendar link are checked, and only when they are the
 *   one attending. Their commitments never touch anyone else's bookings.
 * - Booking a checked person needs a date, a start time and a length. A day
 *   with no time can't be checked, so it is refused outright, never waved on.
 * - A clash is a busy time on a ticked Google calendar (with the person's
 *   buffers either side) or another Terra Ops booking at the same time.
 * - If Google can't be checked right now the answer is "not checked", never
 *   "free". That blocks the same as a clash.
 * - Only the person themselves, signed in as their own login, can book over
 *   a clash or a failed check, with a reason. That approval is recorded.
 *
 * All times are Brisbane wall clock. Brisbane has no daylight saving, so a
 * fixed +10:00 is exact. Google's busy times are absolute instants, so an
 * event set up in Sydney or Perth time lands where it really is.
 * ------------------------------------------------------------------------- */

const BNE = "+10:00";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export const toMin = (hhmm: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h > 23 || mm > 59 ? null : h * 60 + mm;
};
export const dayStartMs = (date: string) => Date.parse(`${date}T00:00:00${BNE}`);
export const bneMs = (date: string, minutes: number) => dayStartMs(date) + minutes * MIN;

const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Brisbane", hour: "2-digit", minute: "2-digit", hour12: false });
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane", year: "numeric", month: "2-digit", day: "2-digit" });
/** HH:MM in Brisbane. */
export const bneHM = (ms: number) => hmFmt.format(new Date(ms)).replace(/^24:/, "00:");
/** YYYY-MM-DD in Brisbane. */
export const bneDate = (ms: number) => dateFmt.format(new Date(ms));

/** "8:00am", the way the office says it. */
export function sayHM(hhmm: string) {
  const m = toMin(hhmm);
  if (m == null) return hhmm;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mm).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}

/** A span that may run past midnight, said in Brisbane time. */
function sayRange(fromMs: number, toMs: number, onDate: string) {
  const d1 = bneDate(fromMs);
  const d2 = bneDate(toMs - 1);
  const a = d1 < onDate ? "before the day" : sayHM(bneHM(fromMs));
  const b = d2 > onDate ? "into the next day" : sayHM(bneHM(toMs));
  if (fromMs <= dayStartMs(onDate) && toMs >= dayStartMs(onDate) + DAY) return "all day";
  return `${a} to ${b}`;
}

/**
 * How long one booked day holds the person: from the start time for the hours
 * booked, or to the end of the arrival window if that is later. Null when the
 * day has no start time.
 */
export function slotWindow(date: string, arrivalStart: string | null | undefined, arrivalEnd: string | null | undefined, durationHours: number | null | undefined) {
  const s = toMin(arrivalStart);
  if (s == null) return null;
  const hours = Number(durationHours ?? 0);
  if (!(hours > 0) || hours > 16) return null;
  const e = Math.max(s + Math.round(hours * 60), toMin(arrivalEnd) ?? 0);
  return { startMs: bneMs(date, s), endMs: bneMs(date, e) };
}

/* ------------------------------- who is checked ------------------------------- */

export type CalLink = typeof schema.calendarLinks.$inferSelect;

export async function linksFor(installerIds: number[]): Promise<Map<number, CalLink>> {
  const ids = [...new Set(installerIds.filter((x) => Number.isFinite(x) && x > 0))];
  if (!ids.length) return new Map();
  const rows = await db.select().from(schema.calendarLinks).where(inArray(schema.calendarLinks.installerId, ids));
  return new Map(rows.map((r) => [r.installerId, r]));
}

/** Why a link can't be read right now, in plain words, or null when it can. */
export function linkProblem(link: CalLink): string | null {
  if (!link.refreshTokenSealed) return link.lastError || "The Google calendar is not connected.";
  if (!safeIds(link.calendarIds).length) return "No Google calendars are ticked to count.";
  return null;
}

/** Busy times with the person's buffers either side, overlaps merged. */
export function withBuffers(raw: Array<{ startAt: number; endAt: number }>, beforeMin: number, afterMin: number) {
  const spans = raw
    // A whole day or more away needs no travel time either side.
    .map((r) => (r.endAt - r.startAt >= DAY ? { start: r.startAt, end: r.endAt } : { start: r.startAt - beforeMin * MIN, end: r.endAt + afterMin * MIN }))
    .sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/* ------------------------------- the cache ------------------------------- */

/** The window the board keeps fresh: yesterday to about two months out. */
export function cacheWindow(now = Date.now()) {
  const today = bneDate(now);
  // A week back, so the current week's earlier days still show their shading.
  return { from: dayStartMs(addLocalDays(today, -7)), to: dayStartMs(addLocalDays(today, 63)) };
}

/** Busy times older than this are not trusted on the board. */
export const BOARD_FRESH_MS = 20 * MIN;

/** Re-reads one person's ticked calendars for the board window. Never throws. */
export async function refreshLink(link: CalLink): Promise<{ ok: boolean; error?: string }> {
  const problem = linkProblem(link);
  const now = Date.now();
  if (problem) return { ok: false, error: problem };
  const win = cacheWindow(now);
  try {
    const busy = await freeBusy(link.id, safeIds(link.calendarIds), win.from, win.to);
    await db.delete(schema.calendarBusy).where(eq(schema.calendarBusy.linkId, link.id));
    for (let i = 0; i < busy.length; i += 200) {
      await db.insert(schema.calendarBusy).values(
        busy.slice(i, i + 200).map((b) => ({ linkId: link.id, calendarId: b.calendarId, startAt: b.startAt, endAt: b.endAt, fetchedAt: now })),
      );
    }
    await db
      .update(schema.calendarLinks)
      .set({ cacheFrom: win.from, cacheTo: win.to, lastSyncOkAt: now, lastSyncTryAt: now, lastError: null, updatedAt: new Date() })
      .where(eq(schema.calendarLinks.id, link.id));
    return { ok: true };
  } catch (e) {
    const error = String((e as Error).message ?? e).slice(0, 300);
    await db
      .update(schema.calendarLinks)
      .set({ lastSyncTryAt: now, lastError: error, updatedAt: new Date() })
      .where(eq(schema.calendarLinks.id, link.id));
    return { ok: false, error };
  }
}

/** Read Google straight after a connect, so the board is right on the first look. */
export async function refreshLinkById(id: number): Promise<void> {
  const [link] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, id));
  if (link) await refreshLink(link);
}

export type BoardBlock = { date: string; from: string; to: string; label: string };
export type BoardPerson = {
  installerId: number;
  name: string;
  /** ok: checked recently. unchecked: Google could not be read, never shown as free. */
  state: "ok" | "unchecked";
  problem: string | null;
  checkedAt: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  blocks: BoardBlock[];
};

/**
 * What the schedule shades for each calendar-checked person across a range.
 * Times only, labelled "<name> unavailable — personal commitment". A span the
 * cache doesn't cover, or a cache that has gone stale, comes back unchecked.
 */
export async function boardBlocks(fromDate: string, toDate: string): Promise<BoardPerson[]> {
  const links = await db
    .select({ link: schema.calendarLinks, name: schema.installers.name })
    .from(schema.calendarLinks)
    .innerJoin(schema.installers, eq(schema.installers.id, schema.calendarLinks.installerId));
  const out: BoardPerson[] = [];
  const fromMs = dayStartMs(fromDate);
  const toMs = dayStartMs(addLocalDays(toDate, 1));
  for (const { link: l0, name } of links) {
    let link = l0;
    // A stale board refreshes itself once on the way, so a quiet server still shows today.
    if (!linkProblem(link) && (!link.lastSyncOkAt || Date.now() - link.lastSyncOkAt > 10 * MIN) && (!link.lastSyncTryAt || Date.now() - link.lastSyncTryAt > MIN)) {
      await refreshLink(link);
      [link] = await db.select().from(schema.calendarLinks).where(eq(schema.calendarLinks.id, l0.id));
      if (!link) continue;
    }
    let problem = linkProblem(link);
    if (!problem && (!link.lastSyncOkAt || Date.now() - link.lastSyncOkAt > BOARD_FRESH_MS)) {
      problem = link.lastError ? `Google could not be checked: ${link.lastError}` : "Google has not been checked recently.";
    }
    if (!problem && (link.cacheFrom == null || link.cacheTo == null)) {
      problem = "Google has not been checked yet.";
    } else if (!problem && toMs > link.cacheTo!) {
      problem = "This week is further out than the calendar is read ahead. It is checked when a booking is made.";
    } else if (!problem && fromMs < link.cacheFrom!) {
      problem = "Busy times aren't kept for past weeks. A booking is still checked when it is made.";
    }
    const raw = await db
      .select({ startAt: schema.calendarBusy.startAt, endAt: schema.calendarBusy.endAt })
      .from(schema.calendarBusy)
      .where(and(eq(schema.calendarBusy.linkId, link.id), sql`${schema.calendarBusy.endAt} > ${fromMs - DAY}`, sql`${schema.calendarBusy.startAt} < ${toMs + DAY}`));
    const blocks: BoardBlock[] = [];
    for (const b of withBuffers(raw, link.bufferBeforeMin, link.bufferAfterMin)) {
      // Split a span over midnight into one block per Brisbane day.
      for (let d = bneDate(Math.max(b.start, fromMs)), guard = 0; dayStartMs(d) < Math.min(b.end, toMs) && guard < 62; d = addLocalDays(d, 1), guard++) {
        const ds = dayStartMs(d);
        const s = Math.max(b.start, ds);
        const e = Math.min(b.end, ds + DAY);
        if (e <= s) continue;
        blocks.push({
          date: d,
          from: bneHM(s),
          to: e >= ds + DAY ? "24:00" : bneHM(e),
          label: `${name} unavailable — personal commitment`,
        });
      }
    }
    out.push({
      installerId: link.installerId,
      name,
      state: problem ? "unchecked" : "ok",
      problem,
      checkedAt: link.lastSyncOkAt ?? null,
      bufferBeforeMin: link.bufferBeforeMin,
      bufferAfterMin: link.bufferAfterMin,
      blocks,
    });
  }
  return out;
}

/* ------------------------------- the check ------------------------------- */

export type ProposedDay = {
  date: string;
  arrivalStart: string | null;
  arrivalEnd: string | null;
  coordinate: boolean;
  /** Who attends that day: the cover person, or the task's own crew. */
  people: number[];
};

export type Clash = { kind: "personal" | "booking" | "booking_untimed"; when: string; label: string };

export type PersonDayCheck = {
  installerId: number;
  name: string;
  date: string;
  /** The booked time, Brisbane HH:MM, when there is one. */
  from: string | null;
  to: string | null;
  status: "clear" | "clash" | "unchecked" | "no_time";
  clashes: Clash[];
  problem: string | null;
  ownerProfileId: number;
  /** True only when the person asking is the person whose time it is. */
  canOverride: boolean;
};

/** The day rows a booking would leave behind, read into who attends when. */
export function proposedDays(
  rows: Array<{ date: string; arrivalStart: string | null; arrivalEnd: string | null; coordinate: boolean; installerId: number | null; status?: string }>,
  crew: Array<number | null | undefined>,
): ProposedDay[] {
  const own = [...new Set(crew.filter((x): x is number => Boolean(x)))];
  return rows
    .filter((r) => r.status !== "cancelled" && r.status !== "complete")
    .map((r) => ({
      date: r.date,
      arrivalStart: r.coordinate ? null : r.arrivalStart,
      arrivalEnd: r.coordinate ? null : r.arrivalEnd,
      coordinate: r.coordinate,
      people: r.installerId ? [r.installerId] : own,
    }));
}

/** A task's own days as they stand now, for paths that change who or how long but not when. */
export async function currentDays(taskId: number, patch?: Partial<typeof schema.jobTasks.$inferSelect>) {
  const [stored] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
  const task = stored ? { ...stored, ...patch } : undefined;
  if (!task) return { task: null, rows: [] as Parameters<typeof proposedDays>[0] };
  const rows = await db
    .select({
      date: schema.taskDays.date,
      arrivalStart: schema.taskDays.arrivalStart,
      arrivalEnd: schema.taskDays.arrivalEnd,
      coordinate: schema.taskDays.coordinate,
      installerId: schema.taskDays.installerId,
      status: schema.taskDays.status,
    })
    .from(schema.taskDays)
    .where(eq(schema.taskDays.taskId, taskId));
  if (rows.length) return { task, rows };
  // No day rows: an older single date or a date range, read the same way the board reads it.
  const run = resolveRun(task, []);
  const dates = run.days.length ? run.days : windowDates(run);
  return {
    task,
    rows: dates.map((date) => ({ date, arrivalStart: task.startTime, arrivalEnd: null, coordinate: false, installerId: null, status: "booked" })),
  };
}

async function profileIdOf(actor: Actor): Promise<number | null> {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, actor.userId));
  return p?.id ?? null;
}

/** Other Terra Ops work on these people on these dates, with the time it holds them. */
async function opsBookings(people: number[], dates: string[], exceptTaskId: number | null) {
  if (!people.length || !dates.length) return [];
  const sorted = [...dates].sort();
  const from = sorted[0]!;
  const to = sorted[sorted.length - 1]!;
  const tasks = await db
    .select({
      ...slotCols,
      jobId: schema.jobTasks.jobId,
      jobNumber: jobNumberSql,
      title: schema.jobTasks.title,
      startTime: schema.jobTasks.startTime,
      durationHours: schema.jobTasks.durationHours,
      suburb: schema.sites.suburb,
    })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(and(inArray(schema.jobTasks.status, ["assigned", "in_progress"]), mayWorkBetween(from, to), exceptTaskId ? ne(schema.jobTasks.id, exceptTaskId) : sql`1 = 1`));
  if (!tasks.length) return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const want = new Set(dates);
  const who = new Set(people);
  const slots = (await workSlots(tasks, from, to)).filter((s) => who.has(s.installerId) && want.has(s.date));
  if (!slots.length) return [];
  const dayRows = await db
    .select()
    .from(schema.taskDays)
    .where(inArray(schema.taskDays.taskId, [...new Set(slots.map((s) => s.taskId))]));
  const rowOf = new Map(dayRows.map((r) => [`${r.taskId}:${r.date}`, r]));
  return slots.map((s) => {
    const t = byId.get(s.taskId)!;
    const r = rowOf.get(`${s.taskId}:${s.date}`);
    const win = r
      ? r.coordinate
        ? null
        : slotWindow(s.date, r.arrivalStart, r.arrivalEnd, t.durationHours)
      : slotWindow(s.date, t.startTime, null, t.durationHours);
    return {
      installerId: s.installerId,
      date: s.date,
      taskId: t.id,
      jobId: t.jobId,
      label: `Job #${t.jobNumber}${t.suburb ? ` ${t.suburb}` : ""}, ${t.title}`,
      win,
    };
  });
}

/**
 * The check itself. Reads Google live for the days being booked (not the
 * board cache), so a commitment added a minute ago still counts. Returns one
 * line per checked person per day. People without a calendar link are not
 * looked at at all.
 */
export async function checkAttendance(args: {
  taskId: number | null;
  durationHours: number | null | undefined;
  days: ProposedDay[];
  actor: Actor | null;
}): Promise<PersonDayCheck[]> {
  const today = todayLocal();
  const days = args.days.filter((d) => d.date >= today);
  const links = await linksFor(days.flatMap((d) => d.people));
  if (!links.size) return [];
  const actorProfile = args.actor ? await profileIdOf(args.actor) : null;

  const names = new Map(
    (await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(inArray(schema.installers.id, [...links.keys()]))).map((r) => [r.id, r.name]),
  );
  const [own] = args.taskId ? await db.select({ jobId: schema.jobTasks.jobId }).from(schema.jobTasks).where(eq(schema.jobTasks.id, args.taskId)) : [];
  const checkedDates = [...new Set(days.filter((d) => d.people.some((p) => links.has(p))).map((d) => d.date))];
  const ops = (await opsBookings([...links.keys()], checkedDates, args.taskId)).filter((o) => own?.jobId == null || o.jobId !== own.jobId);

  // One live Google read per person, across all their days.
  const live = new Map<number, { ok: true; busy: RawBusy[] } | { ok: false; error: string }>();
  for (const [installerId, link] of links) {
    const theirDates = days.filter((d) => d.people.includes(installerId)).map((d) => d.date).sort();
    if (!theirDates.length) continue;
    const problem = linkProblem(link);
    if (problem) {
      live.set(installerId, { ok: false, error: problem });
      continue;
    }
    try {
      const from = dayStartMs(addLocalDays(theirDates[0]!, -1));
      const to = dayStartMs(addLocalDays(theirDates[theirDates.length - 1]!, 2));
      live.set(installerId, { ok: true, busy: await freeBusy(link.id, safeIds(link.calendarIds), from, to) });
    } catch (e) {
      live.set(installerId, { ok: false, error: String((e as Error).message ?? e).slice(0, 300) });
    }
  }

  const out: PersonDayCheck[] = [];
  for (const d of days) {
    for (const installerId of d.people) {
      const link = links.get(installerId);
      if (!link) continue;
      const name = names.get(installerId) ?? "This person";
      const win = slotWindow(d.date, d.arrivalStart, d.arrivalEnd, args.durationHours);
      const base = {
        installerId,
        name,
        date: d.date,
        from: win ? bneHM(win.startMs) : null,
        to: win ? bneHM(win.endMs) : null,
        ownerProfileId: link.ownerProfileId,
        canOverride: actorProfile != null && actorProfile === link.ownerProfileId,
      };
      if (!win) {
        out.push({
          ...base,
          status: "no_time",
          clashes: [],
          problem: `${name}'s calendar is checked, so this needs a start time and a finish time (or hours).`,
        });
        continue;
      }
      const clashes: Clash[] = [];
      for (const o of ops) {
        if (o.installerId !== installerId || o.date !== d.date) continue;
        if (!o.win) clashes.push({ kind: "booking_untimed", when: "no time set", label: `${o.label} (booked that day with no time, so it can't be ruled out)` });
        else if (o.win.startMs < win.endMs && o.win.endMs > win.startMs)
          clashes.push({ kind: "booking", when: sayRange(o.win.startMs, o.win.endMs, d.date), label: o.label });
      }
      const g = live.get(installerId);
      if (g?.ok) {
        for (const b of withBuffers(g.busy, link.bufferBeforeMin, link.bufferAfterMin)) {
          if (b.start < win.endMs && b.end > win.startMs) {
            clashes.push({ kind: "personal", when: sayRange(b.start, b.end, d.date), label: `${name} unavailable — personal commitment` });
          }
        }
      }
      if (!g || !g.ok) {
        out.push({
          ...base,
          status: "unchecked",
          clashes,
          problem: `${name}'s Google calendar could not be checked${g && !g.ok ? `: ${g.error}` : "."} Not shown as available.`,
        });
      } else {
        out.push({ ...base, status: clashes.length ? "clash" : "clear", clashes, problem: null });
      }
    }
  }
  return out;
}

/** Plain words for one problem line, for the error the office sees. */
export function sayProblem(c: PersonDayCheck) {
  const day = new Date(`${c.date}T12:00:00${BNE}`).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short" });
  if (c.status === "no_time") return `${day}: ${c.problem}`;
  const at = c.from && c.to ? ` ${sayHM(c.from)} to ${sayHM(c.to)}` : "";
  const parts = c.clashes.map((x) => (x.kind === "personal" ? `${x.label}, ${x.when}` : `${x.label}${x.kind === "booking" ? `, ${x.when}` : ""}`));
  if (c.status === "unchecked") parts.unshift(c.problem ?? "Google could not be checked.");
  return `${day}${at}: ${parts.join("; ")}`;
}

/**
 * The guard every booking path calls before it writes. Clear: returns. A
 * problem: throws CONFLICT with the lines in `data.calendar`, unless the
 * person whose time it is approved it here with a reason. A day with no time
 * is never approvable: it has to be given a time.
 */
export async function guardAttendance(args: {
  taskId: number | null;
  durationHours: number | null | undefined;
  days: ProposedDay[];
  actor: Actor;
  /** Only honoured from the person's own login. */
  override?: { reason: string } | null;
  source: string;
}) {
  const checks = await checkAttendance(args);
  const problems = checks.filter((c) => c.status !== "clear");
  if (!problems.length) return { checked: checks.length, overridden: 0 };

  const noTime = problems.filter((p) => p.status === "no_time");
  const reason = (args.override?.reason ?? "").trim();
  const allMine = problems.every((p) => p.canOverride);
  if (!noTime.length && reason.length >= 3 && allMine) {
    const [me] = await db.select({ id: schema.profiles.id, name: schema.profiles.name }).from(schema.profiles).where(eq(schema.profiles.userId, args.actor.userId));
    if (!me) throw new ORPCError("FORBIDDEN", { message: "Your login has no Terra Ops profile, so it can't approve this." });
    for (const p of problems) {
      await db.insert(schema.calendarOverrides).values({
        taskId: args.taskId,
        installerId: p.installerId,
        date: p.date,
        slotStart: p.from,
        slotEnd: p.to,
        clashesJson: JSON.stringify(p.clashes.map((c) => ({ kind: c.kind, when: c.when }))),
        kind: p.status,
        reason: reason.slice(0, 500),
        approvedByProfileId: me.id,
        approvedByName: me.name || args.actor.name,
        source: args.source,
      });
    }
    if (args.taskId) {
      const [t] = await db.select({ jobId: schema.jobTasks.jobId, title: schema.jobTasks.title }).from(schema.jobTasks).where(eq(schema.jobTasks.id, args.taskId));
      if (t) {
        await db.insert(schema.activityLog).values({
          jobId: t.jobId,
          taskId: args.taskId,
          entityType: "task",
          entityId: args.taskId,
          action: "calendar_override",
          detail: `${t.title}: booked over ${problems[0]!.name}'s ${problems.some((p) => p.status === "unchecked") ? "unchecked calendar" : "personal commitment"} on ${problems.length === 1 ? "1 day" : `${problems.length} days`}. Approved by ${me.name || args.actor.name}: ${reason.slice(0, 300)}`,
          actorName: args.actor.name,
          actorRole: args.actor.role,
        });
      }
    }
    return { checked: checks.length, overridden: problems.length };
  }

  const who = [...new Set(problems.map((p) => p.name))].join(" and ");
  const lead = noTime.length
    ? `${who}'s calendar is checked, so pick a start time and a finish time first.`
    : problems.some((p) => p.status !== "unchecked")
      ? `${who} is not available then.`
      : `${who}'s Google calendar could not be checked, so ${who} is not shown as available.`;
  const tail = noTime.length
    ? ""
    : allMine
      ? reason.length === 0
        ? " To book over your own time, open the booking and say why."
        : reason.length < 3
          ? " Say a bit more about why, at least 3 letters."
          : ""
      : ` Only ${who} can approve booking over it, signed in as themselves.`;
  throw new ORPCError("CONFLICT", {
    message: `${lead}${tail} ${problems.map(sayProblem).join(" | ")}`.trim(),
    data: { calendar: problems },
  });
}

/** True when anyone in this list is calendar-checked, for paths that can't carry a time. */
export async function anyChecked(installerIds: Array<number | null | undefined>) {
  return (await linksFor(installerIds.filter((x): x is number => Boolean(x)))).size > 0;
}

