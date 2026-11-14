import { and, asc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { normaliseRole } from "../middleware/auth";
import { workDaysFor, type WorkDay } from "./crew-days";
import { jobNumberSql, taskRefSql } from "./job-ref";
import { addLocalDays, localDate, localDayBounds, localTimeOn, sayTime, TERRA_TZ, todayLocal } from "./local-date";
import { isMeasureSkill } from "./property-types";
import { termsOn } from "./hourly";
import { crewBoard } from "./task-run";

/* ---------------------------------------------------------------------------
 * Home-screen widgets (Damien, 14 Nov 2026).
 *
 * One small snapshot the phone saves and draws "Terra Today" (office) and
 * "My Job" (crew) from. It is built from the same bookings, task days, site
 * visits and work sessions as the app. Nothing new is stored.
 *
 * What may sit on a home screen: job and task refs, suburb, date, the booked
 * time or arrival window, the type of booking, the person's own labour lines
 * (name and quantity only) and counts. Never money, customer names, phones,
 * street addresses, access codes, notes or Google Calendar events. The office
 * side only reads job tasks on the person's own staff card, so a private
 * calendar event can never reach it.
 * ------------------------------------------------------------------------- */

export const WIDGET_VERSION = 1;
/** After this the phone shows "Open Terra to refresh" instead of old jobs. */
export const WIDGET_TTL_MS = 12 * 3600_000;
/** How far ahead to look for a next booking. */
const LOOK_AHEAD_DAYS = 21;
/** Enough for the phone to roll forward through a busy day without the app. */
const MAX_ITEMS = 4;

export type WidgetKind = "measure" | "site_visit" | "install";

export interface WidgetItem {
  taskId: number;
  jobId: number;
  /** "188070-B". */
  ref: string;
  /** "188070". */
  jobRef: string;
  kind: WidgetKind;
  /** "Measure", "Site visit", "Install". */
  kindLabel: string;
  /** YYYY-MM-DD, Brisbane. */
  date: string;
  /** "7-11 am", "7:30 am", "Time to confirm with site", or null when no time is set. */
  timeLabel: string | null;
  /** True when timeLabel is an arrival window, never shown as one exact time. */
  isWindow: boolean;
  /** The booked start, ms. Null when there is no time. */
  startsAt: number | null;
  /** When this item stops being the next one, ms. */
  until: number;
  suburb: string | null;
  /** His own labour, short: "Hybrid installation 135 m² · Install trims/scotia 105 lm". */
  work: string;
  status: string;
  statusLabel: string;
  /** "Day 2 of 3". Null on a one day job. */
  dayLabel: string | null;
  /** At it now when the phone synced: an open site visit or a task running today. */
  current: boolean;
  /** In-app paths. The phone turns them into links and each screen checks access again. */
  links: { open: string; directions: string | null; timeClock: string | null };
}

export interface WidgetSession {
  state: "working" | "on_break";
  taskId: number;
  ref: string;
  /** When the session started, ms. Shown as "since", never as a live timer. */
  since: number;
}

export interface AttentionCounts {
  /** Distinct tasks across every line below, so one task is never counted twice. */
  total: number;
  lines: { key: AttentionKey; label: string; count: number; path: string }[];
  path: string;
}

export interface WidgetSnapshot {
  v: typeof WIDGET_VERSION;
  /** The login this belongs to. The phone throws the cache away when it changes. */
  accountId: string;
  syncedAt: number;
  expiresAt: number;
  tz: typeof TERRA_TZ;
  today: string;
  /** Terra Today. Null for crew logins. */
  office: { bookable: boolean; items: WidgetItem[]; attention: AttentionCounts } | null;
  /** My Job. Null for logins with no crew card. */
  crew: { items: WidgetItem[]; todayCount: number; session: WidgetSession | null } | null;
}

/* ---------------------------------------------------------------- helpers */

const UNIT: Record<string, string> = { m2: "m²", lm: "lm", step: "steps", hour: "h", day: "days", km: "km" };

function qtyText(qty: number, unit: string | null | undefined) {
  if (!qty) return "";
  const n = Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 10) / 10);
  const u = UNIT[unit ?? ""] ?? "";
  return u ? `${n} ${u}` : n;
}

/** "7-11 am", "10 am-1 pm", "7:30-11 am". Never turns a window into one time. */
export function windowLabel(start: string, end: string): string | null {
  const a = sayTime(start);
  const b = sayTime(end);
  if (!a || !b) return a ?? null;
  const [aT, aS] = a.split(" ");
  const [bT, bS] = b.split(" ");
  return aS === bS ? `${aT}-${bT} ${bS}` : `${a}-${b}`;
}

export function kindOf(skillName: string | null | undefined): WidgetKind {
  if (/site visit|inspection/i.test(skillName ?? "")) return "site_visit";
  if (isMeasureSkill(skillName)) return "measure";
  return "install";
}

const KIND_LABEL: Record<WidgetKind, string> = { measure: "Measure", site_visit: "Site visit", install: "Install" };

const STATUS_LABEL: Record<string, string> = { assigned: "Booked in", in_progress: "On the job" };

/** The bookable card for a login: crew use their own, office and admin their staff card. */
export async function widgetCardOf(actor: Actor): Promise<number | null> {
  if (!actor.profileId) return null;
  const [profile] = await db.select().from(schema.profiles).where(eq(schema.profiles.id, actor.profileId));
  if (!profile) return null;
  if (normaliseRole(profile.role) === "field") return profile.installerId ?? null;
  const [s] = await db.select().from(schema.staffCards).where(eq(schema.staffCards.profileId, profile.id));
  return s?.installerId ?? null;
}

/** Each task's own labour lines, name and quantity only. Never a rate or a total. */
async function workFor(taskIds: number[]) {
  const out = new Map<number, string>();
  if (!taskIds.length) return out;
  const lines = await db
    .select({
      taskId: schema.taskLabourLines.taskId,
      qty: schema.taskLabourLines.qty,
      name: schema.labourRateItems.name,
      unit: schema.labourRateItems.unit,
      kind: schema.labourRateItems.kind,
    })
    .from(schema.taskLabourLines)
    .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
    .where(inArray(schema.taskLabourLines.taskId, taskIds))
    .orderBy(asc(schema.taskLabourLines.sortOrder), asc(schema.taskLabourLines.id));
  const byTask = new Map<number, string[]>();
  for (const l of lines) {
    if (l.kind !== "work") continue;
    if (!byTask.has(l.taskId)) byTask.set(l.taskId, []);
    byTask.get(l.taskId)!.push([l.name.trim(), qtyText(l.qty, l.unit)].filter(Boolean).join(" "));
  }
  for (const [id, parts] of byTask) out.set(id, parts.join(" · "));

  // Older tasks have no lines, only the breakdown saved on the task. Names and quantities only.
  const missing = taskIds.filter((id) => !out.has(id));
  if (missing.length) {
    const rows = await db
      .select({ id: schema.jobTasks.id, breakdown: schema.jobTasks.labourBreakdown })
      .from(schema.jobTasks)
      .where(inArray(schema.jobTasks.id, missing));
    for (const r of rows) {
      if (!r.breakdown) continue;
      try {
        const parsed = JSON.parse(r.breakdown) as Array<{ name?: unknown; unit?: unknown; qty?: unknown }>;
        const parts = parsed
          .filter((l) => typeof l.name === "string" && l.name.trim())
          .map((l) => [String(l.name).trim(), qtyText(Number(l.qty) || 0, typeof l.unit === "string" ? l.unit : null)].filter(Boolean).join(" "));
        if (parts.length) out.set(r.id, parts.join(" · "));
      } catch {
        /* unreadable breakdown, fall back to the title */
      }
    }
  }
  return out;
}

interface TaskFacts {
  id: number;
  jobId: number;
  status: string;
  startTime: string | null;
  durationHours: number;
  payType: string;
  assignedInstallerId: number | null;
  title: string;
  skillName: string | null;
  jobRef: string;
  ref: string;
  suburb: string | null;
  hasSite: boolean;
}

async function factsFor(taskIds: number[]) {
  const out = new Map<number, TaskFacts>();
  if (!taskIds.length) return out;
  const rows = await db
    .select({
      id: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      status: schema.jobTasks.status,
      startTime: schema.jobTasks.startTime,
      durationHours: schema.jobTasks.durationHours,
      payType: schema.jobTasks.payType,
      assignedInstallerId: schema.jobTasks.assignedInstallerId,
      title: schema.jobTasks.title,
      skillName: schema.skills.name,
      jobRef: jobNumberSql,
      ref: taskRefSql,
      suburb: schema.sites.suburb,
      address: schema.sites.address,
      lat: schema.sites.lat,
    })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(inArray(schema.jobTasks.id, taskIds));
  for (const r of rows) {
    const { address, lat, ...rest } = r;
    out.set(r.id, { ...rest, suburb: r.suburb?.trim() || null, hasSite: Boolean(address?.trim()) || lat != null });
  }
  return out;
}

/**
 * Where this card stands today. At it now: an open site visit, or a task
 * running today that he has not already left. Left today: a visit closed
 * today with none open, so a later job that day can come first.
 */
async function standingToday(installerId: number, today: string, todays: WorkDay[]) {
  const visits = await db
    .select({ taskId: schema.siteVisits.taskId, leftAt: schema.siteVisits.leftAt, visitDate: schema.siteVisits.visitDate })
    .from(schema.siteVisits)
    .where(and(eq(schema.siteVisits.installerId, installerId), isNull(schema.siteVisits.voidedAt), or(isNull(schema.siteVisits.leftAt), eq(schema.siteVisits.visitDate, today))));
  const open = new Set(visits.filter((v) => !v.leftAt).map((v) => v.taskId));
  const left = new Set(visits.filter((v) => v.leftAt && v.visitDate === today && !open.has(v.taskId)).map((v) => v.taskId));
  const running = await workDaysFor(installerId, today, today, ["in_progress"]);
  const ids = new Set(open);
  for (const d of running) if (!left.has(d.taskId)) ids.add(d.taskId);
  // Only a task on today's schedule can be "Now".
  const onToday = new Set(todays.map((d) => d.taskId));
  return { current: new Set([...ids].filter((id) => onToday.has(id))), left };
}

/**
 * The next few bookings on one card, current first, then by date and time.
 * Built from the same work days as the crew app, so a three day lay reads
 * "Day 2 of 3" and weekends nobody is booked on never appear.
 */
async function itemsFor(
  installerId: number,
  opts: { side: "crew" | "office"; hourlyIds?: Set<number>; now: number; today: string },
): Promise<{ items: WidgetItem[]; todayCount: number }> {
  const { now, today } = opts;
  const days = await workDaysFor(installerId, today, addLocalDays(today, LOOK_AHEAD_DAYS));
  if (!days.length) return { items: [], todayCount: 0 };
  const taskIds = [...new Set(days.map((d) => d.taskId))];
  const [facts, work] = await Promise.all([factsFor(taskIds), workFor(taskIds)]);
  const { current, left } = await standingToday(installerId, today, days.filter((d) => d.date === today));

  const items: (WidgetItem & { sort: string })[] = [];
  for (const d of days) {
    const t = facts.get(d.taskId);
    if (!t) continue;
    const start = d.arrivalStart ?? t.startTime;
    const isWindow = Boolean(d.arrivalStart && d.arrivalEnd);
    const timeLabel = d.coordinate
      ? "Time to confirm with site"
      : isWindow
        ? windowLabel(d.arrivalStart!, d.arrivalEnd!)
        : sayTime(start);
    const startsAt = d.coordinate ? null : (localTimeOn(d.date, start)?.getTime() ?? null);
    const kind = kindOf(t.skillName);
    const dayEnd = localDayBounds(d.date).end.getTime();
    // A measure at 9:30 is over when its time is up. A day on the tools is the whole day.
    const until =
      kind !== "install" && startsAt != null && !isWindow ? Math.min(dayEnd, startsAt + Math.max(0.5, t.durationHours || 1) * 3600_000) : dayEnd;
    if (until <= now && !current.has(t.id)) continue;
    const isCurrent = d.date === today && current.has(t.id);
    items.push({
      taskId: t.id,
      jobId: t.jobId,
      ref: t.ref,
      jobRef: t.jobRef,
      kind,
      kindLabel: KIND_LABEL[kind],
      date: d.date,
      timeLabel,
      isWindow,
      startsAt,
      until,
      suburb: t.suburb,
      work: work.get(t.id) || t.skillName || t.title,
      status: t.status,
      statusLabel: STATUS_LABEL[t.status] ?? t.status,
      dayLabel: d.dayCount > 1 ? `Day ${d.daySeq} of ${d.dayCount}` : null,
      current: isCurrent,
      links:
        opts.side === "crew"
          ? {
              open: `/task/${t.id}`,
              directions: t.hasSite ? `/task/${t.id}?go=directions` : null,
              timeClock: opts.hourlyIds?.has(t.id) ? `/hours?task=${t.id}` : null,
            }
          : { open: `/office?path=${encodeURIComponent(`/jobs/${t.jobId}`)}`, directions: null, timeClock: null },
      sort: `${isCurrent ? 0 : 1} ${d.date} ${(start ?? "99:99").padStart(5, "0")} ${String(t.id).padStart(9, "0")}`,
    });
  }
  items.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));

  // Several bookings in one day: one he is not at gives way when the next one is due.
  for (const it of items) {
    if (it.current || it.startsAt == null) continue;
    const later = items.find((o) => o !== it && o.date === it.date && o.startsAt != null && o.startsAt > it.startsAt!);
    if (later) it.until = Math.min(it.until, later.startsAt!);
  }
  // Already left today and something else is still to come today: that one is next.
  const kept = items.filter((it) => {
    if (it.until <= now && !it.current) return false;
    if (it.date !== today || it.current || !left.has(it.taskId)) return true;
    return !items.some((o) => o.date === today && o.taskId !== it.taskId && (o.current || o.until > now) && !left.has(o.taskId));
  });

  const todayCount = new Set(kept.filter((i) => i.date === today).map((i) => i.taskId)).size;
  return { items: kept.slice(0, MAX_ITEMS).map(({ sort: _s, ...i }) => i), todayCount };
}

/** Tasks he can record hourly time on, the same rule as My time (hourlyInvoices.myJobs). */
async function hourlyTaskIds(installerId: number, today: string) {
  const rows = await db
    .select({ id: schema.jobTasks.id, payType: schema.jobTasks.payType })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.assignedInstallerId, installerId), sql`${schema.jobTasks.status} not in ('complete','cancelled')`));
  const onTerms = Boolean(await termsOn(installerId, today));
  return new Set(rows.filter((r) => onTerms || r.payType === "hourly").map((r) => r.id));
}

/** His open work session from the existing time clock, if any. Read only. */
async function sessionFor(installerId: number): Promise<WidgetSession | null> {
  const [s] = await db
    .select({ id: schema.workSessions.id, taskId: schema.workSessions.taskId, startedAt: schema.workSessions.startedAt, ref: taskRefSql })
    .from(schema.workSessions)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.workSessions.taskId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .where(and(eq(schema.workSessions.installerId, installerId), eq(schema.workSessions.status, "open")))
    .limit(1);
  if (!s) return null;
  const [brk] = await db
    .select({ id: schema.workBreaks.id })
    .from(schema.workBreaks)
    .where(and(eq(schema.workBreaks.sessionId, s.id), isNull(schema.workBreaks.endedAt)))
    .limit(1);
  return { state: brk ? "on_break" : "working", taskId: s.taskId, ref: s.ref, since: s.startedAt.getTime() };
}

/* ------------------------------------------------------- needs attention */

export type AttentionKey = "unfilled" | "offers" | "overdue" | "incomplete";

export const ATTENTION_LABEL: Record<AttentionKey, string> = {
  unfilled: "Needs a body",
  offers: "Waiting on installers",
  overdue: "Overdue",
  incomplete: "Schedule incomplete",
};

export interface AttentionRow {
  taskId: number;
  jobId: number;
  ref: string;
  title: string;
  suburb: string | null;
  date: string | null;
  /** Short, plain words: who it is with, or why it is listed. */
  note: string | null;
}

/**
 * The office dashboard's own lists (routes/dashboard.ts), whole rather than
 * the first 20, and as tasks rather than offers. No new rule, no money.
 */
export async function attentionLists(today = todayLocal(), now = new Date()): Promise<Record<AttentionKey, AttentionRow[]>> {
  const weekEnd = addLocalDays(today, 7);
  const [board, unfilled, offers] = await Promise.all([
    crewBoard(today),
    db
      .select({
        taskId: schema.jobTasks.id,
        jobId: schema.jobTasks.jobId,
        ref: taskRefSql,
        title: schema.jobTasks.title,
        suburb: schema.sites.suburb,
        date: schema.jobTasks.scheduledDate,
        skillName: schema.skills.name,
      })
      .from(schema.jobTasks)
      .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(
        and(
          isNull(schema.jobTasks.assignedInstallerId),
          inArray(schema.jobTasks.status, ["unassigned", "offered"]),
          or(isNull(schema.jobTasks.scheduledDate), and(gte(schema.jobTasks.scheduledDate, today), sql`${schema.jobTasks.scheduledDate} <= ${weekEnd}`)),
        ),
      )
      .orderBy(asc(schema.jobTasks.scheduledDate)),
    // Pending and still inside its window. The dashboard expires the rest before it counts.
    db
      .select({
        taskId: schema.jobTasks.id,
        jobId: schema.jobTasks.jobId,
        ref: taskRefSql,
        title: schema.jobTasks.title,
        suburb: schema.sites.suburb,
        date: schema.jobTasks.scheduledDate,
        installerName: schema.installers.name,
        expiresAt: schema.taskOffers.expiresAt,
      })
      .from(schema.taskOffers)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(and(eq(schema.taskOffers.status, "pending"), or(isNull(schema.taskOffers.expiresAt), gte(schema.taskOffers.expiresAt, now))))
      .orderBy(asc(schema.taskOffers.expiresAt)),
  ]);

  // One row per task on the offers line, naming everyone it is with.
  const offerRows = new Map<number, AttentionRow>();
  for (const o of offers) {
    const row = offerRows.get(o.taskId);
    if (row) row.note = `${row.note}, ${o.installerName}`;
    else offerRows.set(o.taskId, { taskId: o.taskId, jobId: o.jobId, ref: o.ref, title: o.title, suburb: o.suburb, date: o.date, note: `With ${o.installerName}` });
  }

  return {
    unfilled: unfilled.map((t) => ({ taskId: t.taskId, jobId: t.jobId, ref: t.ref, title: t.title, suburb: t.suburb, date: t.date, note: t.skillName })),
    offers: [...offerRows.values()],
    overdue: board.late.map((t) => ({
      taskId: t.id,
      jobId: t.jobId,
      ref: t.ref,
      title: t.title,
      suburb: t.siteSuburb,
      date: t.lastDay,
      note: t.installerName ?? "Unassigned",
    })),
    incomplete: board.incomplete.map((t) => ({
      taskId: t.id,
      jobId: t.jobId,
      ref: t.ref,
      title: t.title,
      suburb: t.siteSuburb,
      date: t.scheduledDate,
      note: t.reason,
    })),
  };
}

export const ATTENTION_KEYS: AttentionKey[] = ["unfilled", "offers", "overdue", "incomplete"];

const attentionPath = (key?: AttentionKey) => `/office?path=${encodeURIComponent(key ? `/attention?show=${key}` : "/attention")}`;

export function attentionCounts(lists: Record<AttentionKey, AttentionRow[]>): AttentionCounts {
  const all = new Set<number>();
  for (const k of ATTENTION_KEYS) for (const r of lists[k]) all.add(r.taskId);
  return {
    total: all.size,
    lines: ATTENTION_KEYS.map((key) => ({ key, label: ATTENTION_LABEL[key], count: lists[key].length, path: attentionPath(key) })).filter((l) => l.count > 0),
    path: attentionPath(),
  };
}

/* --------------------------------------------------------------- snapshot */

export async function widgetSnapshot(actor: Actor, at = new Date()): Promise<WidgetSnapshot> {
  const now = at.getTime();
  // Brisbane date of this instant. Queensland has no daylight saving.
  const today = localDate(at);
  const isStaff = actor.role !== "field";

  let office: WidgetSnapshot["office"] = null;
  if (isStaff) {
    const card = await widgetCardOf(actor);
    const [mine, lists] = await Promise.all([
      card ? itemsFor(card, { side: "office", now, today }) : Promise.resolve({ items: [], todayCount: 0 }),
      attentionLists(today, at),
    ]);
    office = { bookable: card != null, items: mine.items, attention: attentionCounts(lists) };
  }

  let crew: WidgetSnapshot["crew"] = null;
  if (actor.installerId) {
    const hourlyIds = await hourlyTaskIds(actor.installerId, today);
    const [mine, session] = await Promise.all([itemsFor(actor.installerId, { side: "crew", hourlyIds, now, today }), sessionFor(actor.installerId)]);
    crew = { items: mine.items, todayCount: mine.todayCount, session };
  }

  return { v: WIDGET_VERSION, accountId: actor.userId, syncedAt: now, expiresAt: now + WIDGET_TTL_MS, tz: TERRA_TZ, today, office, crew };
}
