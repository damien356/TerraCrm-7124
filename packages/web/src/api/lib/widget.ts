import { ORPCError } from "@orpc/server";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { normaliseRole } from "../middleware/auth";
import { workDaysFor, type WorkDay } from "./crew-days";
import { jobNumberSql, taskRefSql } from "./job-ref";
import { quoteRef } from "./refs";
import { QA_TEST_SOURCE, TEST_LEAD_TAG_LIKE } from "./lead-codes";
import { addLocalDays, localDate, localDayBounds, localTimeOn, sayTime, TERRA_TZ, todayLocal } from "./local-date";
import { isMeasureSkill } from "./property-types";
import { termsOn } from "./hourly";
import { crewBoard } from "./task-run";
import { phoneTablesMissing } from "./phone/calls";
import { loadPhoneConfig } from "./phone/config";

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
  /** Distinct items across every line below, so nothing is counted twice. */
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

export type AttentionKey = "enquiries" | "quotes" | "unfilled" | "offers" | "overdue" | "incomplete";

/**
 * Every line counts jobs, each job once (Damien, 14 Nov 2026). The labels say
 * so, because the dashboard tiles count dispatches and offers, and a number
 * must never sit under a label that means something else on another screen.
 */
export const ATTENTION_LABEL: Record<AttentionKey, string> = {
  enquiries: "Enquiries needing action",
  quotes: "Measures awaiting a quote",
  unfilled: "Jobs needing a body",
  offers: "Jobs awaiting installer acceptance",
  overdue: "Overdue jobs",
  incomplete: "Jobs with schedule incomplete",
};

export interface AttentionRow {
  /** "j:<job>", or "f:<phone follow-up>" for a phone enquiry not on a job yet. The total counts each once. */
  key: string;
  /** The first dispatch it is about, on the booking lines. Null otherwise. */
  taskId: number | null;
  /** Null only for a phone enquiry not on a job yet. */
  jobId: number | null;
  /** Where the row opens on the web. */
  path: string;
  /** The job number. */
  ref: string;
  title: string;
  suburb: string | null;
  date: string | null;
  /** Short, plain words: which dispatches, who it is with, or why it is listed. */
  note: string | null;
  /** "Awaiting quote" or "Overdue" on Measures awaiting a quote. */
  badge: { label: string; tone: "warning" | "danger" } | null;
  /** Jobs awaiting installer acceptance only: how many offers are pending on this job. */
  pendingOffers?: number;
}

/** Who is looking. Admin also sees admin-only office tasks, as on the dashboard. */
export interface AttentionViewer {
  role: string;
}

/**
 * Enquiries needing action (Damien, 14 Nov 2026). His rule, built from what
 * the office already works from, no separate widget rule:
 *
 * An enquiry is a job still on the open stage, Lead or Quoted, the same as
 * the dashboard's Leads count. Not merged into another job, not a test.
 * Won, cancelled and closed jobs are other stages, so never here. Spam
 * never becomes a job.
 *
 * It counts only when Terra owes it something now:
 * - an open office task on it that is due: no due date, or due today or
 *   before, and not snoozed to later (routes/officeTasks.ts). Every new web
 *   lead gets "Call new lead" (lib/lead-intake.ts), and the automatic
 *   "We received your enquiry" email never closes it. Booking the measure
 *   or site visit, or sending a quote, clears that first call;
 * - or an open phone follow-up on it that is due or overdue. A phone
 *   enquiry not on a job yet counts on its own.
 * A future due date or reminder means it waits until then. An enquiry with
 * nothing outstanding is not counted just for being there.
 */
async function enquiryRows(today: string, now: Date, viewer: AttentionViewer): Promise<AttentionRow[]> {
  const activeEnquiry = and(
    sql`coalesce(${schema.jobStatuses.stage}, 'open') = 'open'`,
    isNull(schema.jobs.mergedIntoJobId),
    sql`coalesce(${schema.jobs.source}, '') != ${QA_TEST_SOURCE} and coalesce(${schema.jobs.tags}, '') not like ${TEST_LEAD_TAG_LIKE}`,
  );
  const jobCols = {
    jobId: schema.jobs.id,
    // Sent the same way the leads report counts it.
    quoteSent: sql<number>`exists (select 1 from ${schema.quotes} q where q.job_id = ${schema.jobs.id} and (q.sent_at is not null or q.status in ('sent', 'accepted')))`,
    ref: jobNumberSql,
    jobTitle: schema.jobs.title,
    suburb: schema.sites.suburb,
    createdAt: schema.jobs.createdAt,
  };

  const tasks = await db
    .select({ ...jobCols, taskTitle: schema.officeTasks.title, dueDate: schema.officeTasks.dueDate })
    .from(schema.officeTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.officeTasks.jobId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(
      and(
        eq(schema.officeTasks.status, "open"),
        viewer.role === "admin" ? undefined : eq(schema.officeTasks.adminOnly, false),
        or(isNull(schema.officeTasks.dueDate), lte(schema.officeTasks.dueDate, today)),
        or(isNull(schema.officeTasks.remindAt), lte(schema.officeTasks.remindAt, now)),
        activeEnquiry,
      ),
    );

  // Same test as the leads report: a measure or site visit with a day on it.
  const firstCall = (title: string) => /^Call (new|recovered) lead\b/.test(title);
  const askIds = [...new Set(tasks.filter((t) => firstCall(t.taskTitle) && !t.quoteSent).map((t) => t.jobId))];
  const booked = new Set<number>();
  if (askIds.length) {
    const visits = await db
      .select({ jobId: schema.jobTasks.jobId, skillName: schema.skills.name })
      .from(schema.jobTasks)
      .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .where(and(inArray(schema.jobTasks.jobId, askIds), sql`${schema.jobTasks.status} != 'cancelled'`, isNotNull(schema.jobTasks.scheduledDate)));
    for (const v of visits) if (isMeasureSkill(v.skillName)) booked.add(v.jobId);
  }

  type Hit = { jobId: number | null; ref: string; title: string; suburb: string | null; date: string | null; why: Set<string> };
  const hits = new Map<string, Hit>();
  const onJob = (j: { jobId: number; ref: string; jobTitle: string; suburb: string | null; createdAt: Date }) => {
    const key = `j:${j.jobId}`;
    let h = hits.get(key);
    if (!h) hits.set(key, (h = { jobId: j.jobId, ref: j.ref, title: j.jobTitle || "Enquiry", suburb: j.suburb, date: localDate(j.createdAt), why: new Set() }));
    return h;
  };
  for (const t of tasks) {
    if (firstCall(t.taskTitle) && (t.quoteSent || booked.has(t.jobId))) continue;
    onJob(t).why.add(
      firstCall(t.taskTitle)
        ? "First call not made"
        : t.dueDate && t.dueDate < today
          ? "Office task overdue"
          : /^Reply to email\b/.test(t.taskTitle)
            ? "Email to answer"
            : "Office task due",
    );
  }

  // Phone follow-ups, for roles allowed to see AI phone calls.
  if (await phoneVisible(viewer)) {
    const due = and(inArray(schema.phoneFollowups.status, ["new", "assigned", "in_progress"]), or(isNull(schema.phoneFollowups.dueAt), lte(schema.phoneFollowups.dueAt, now)));
    const [onJobs, loose] = await Promise.all([
      db
        .select({ ...jobCols, dueAt: schema.phoneFollowups.dueAt })
        .from(schema.phoneFollowups)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.phoneFollowups.jobId))
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(and(due, activeEnquiry)),
      db
        .select({ id: schema.phoneFollowups.id, dueAt: schema.phoneFollowups.dueAt, createdAt: schema.phoneFollowups.createdAt })
        .from(schema.phoneFollowups)
        .where(and(due, isNull(schema.phoneFollowups.jobId), eq(schema.phoneFollowups.callType, "enquiry"))),
    ]);
    const callWhy = (dueAt: Date | null) => (dueAt && dueAt.getTime() < now.getTime() ? "Callback overdue" : "Callback due");
    for (const f of onJobs) onJob(f).why.add(callWhy(f.dueAt));
    for (const f of loose) {
      hits.set(`f:${f.id}`, { jobId: null, ref: "Phone", title: "Phone enquiry, not on a job yet", suburb: null, date: localDate(f.createdAt), why: new Set([callWhy(f.dueAt)]) });
    }
  }

  return [...hits.entries()]
    .map(([key, h]) => ({
      key,
      taskId: null,
      jobId: h.jobId,
      path: h.jobId ? `/jobs/${h.jobId}` : `/phone-calls?tab=open&followup=${key.slice(2)}`,
      ref: h.ref,
      title: h.title,
      suburb: h.suburb,
      date: h.date,
      note: [...h.why].join(", "),
      badge: null,
    }))
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

async function phoneVisible(viewer: AttentionViewer) {
  if (viewer.role === "field" || (await phoneTablesMissing()).length) return false;
  const cfg = await loadPhoneConfig();
  return (cfg.permissions.viewCalls as string[]).includes(viewer.role);
}

/* ------------------------------------------------ measures awaiting a quote */

/** A measure and quote visit. A site visit or inspection is a check, not a quote. */
export const MEASURE_QUOTE = /\bmeasure/i;
/** After this long without a quote going out, a measure reads Overdue. */
export const QUOTE_DUE_MS = 24 * 3600_000;
/** Activity on the job, newest wins: the office's own word on whether a quote is still owed. */
export const QUOTE_NOT_NEEDED = "quote_not_needed";
export const QUOTE_NEEDED_AGAIN = "quote_needed_again";
/** A quote in one of these has been with the customer. */
const BEEN_SENT = ["sent", "accepted", "declined", "expired", "replaced"];

/** "Sat 14 Nov 3:10 pm", Brisbane time. */
export function fmtWhen(d: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", { timeZone: TERRA_TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}`;
}

/**
 * Measures awaiting a quote (Damien, 14 Nov 2026), his rule:
 *
 * A measure and quote visit marked completed (status complete, by the crew
 * on the phone or the office on the job). A booked time passing proves
 * nothing, so a measure still showing Booked in is never counted. Future,
 * cancelled and site check visits are not counted either. The job is still
 * live: not Complete, Invoiced, Paid or Cancelled, not merged, not a test.
 *
 * It counts until the quote for it has gone to the customer: a quote on the
 * job sent on or after the day of the measure. "Sent" is what the Send
 * screen records once the email or text went, or the office marking it as
 * sent another way. A draft does not clear it and a failed send does not
 * either, because neither sets it as sent. A quote sent before the measure
 * was for something earlier, so it does not clear it. The office can also
 * record that no quote is needed, with a reason (quoteNotNeeded below).
 *
 * "Awaiting quote" from the moment it is marked completed, "Overdue" once
 * 24 hours have passed. Times read in Brisbane time.
 */
export async function measureQuoteRows(now: Date): Promise<AttentionRow[]> {
  const done = await db
    .select({
      taskId: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      taskRef: taskRefSql,
      taskTitle: schema.jobTasks.title,
      skillName: schema.skills.name,
      scheduledDate: schema.jobTasks.scheduledDate,
      completedAt: schema.jobTasks.completedAt,
      updatedAt: schema.jobTasks.updatedAt,
      ref: jobNumberSql,
      jobTitle: schema.jobs.title,
      suburb: schema.sites.suburb,
    })
    .from(schema.jobTasks)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(
      and(
        eq(schema.jobTasks.status, "complete"),
        sql`coalesce(${schema.jobStatuses.stage}, 'open') not in ('complete', 'closed')`,
        isNull(schema.jobs.mergedIntoJobId),
        sql`coalesce(${schema.jobs.source}, '') != ${QA_TEST_SOURCE} and coalesce(${schema.jobs.tags}, '') not like ${TEST_LEAD_TAG_LIKE}`,
      ),
    );
  // The skill decides. A dispatch with no skill goes by its title.
  const measures = done.filter((t) => MEASURE_QUOTE.test(t.skillName ?? t.taskTitle ?? ""));
  if (!measures.length) return [];
  const jobIds = [...new Set(measures.map((m) => m.jobId))];

  const [quotes, failed, calls] = await Promise.all([
    db
      .select({
        id: schema.quotes.id,
        jobId: schema.quotes.jobId,
        number: schema.quotes.number,
        version: schema.quotes.version,
        status: schema.quotes.status,
        sentAt: schema.quotes.sentAt,
        acceptedAt: schema.quotes.acceptedAt,
        updatedAt: schema.quotes.updatedAt,
        createdAt: schema.quotes.createdAt,
      })
      .from(schema.quotes)
      .where(inArray(schema.quotes.jobId, jobIds)),
    // Presses of Send where nothing went.
    db
      .select({ jobId: schema.quotes.jobId, at: schema.quoteSends.createdAt })
      .from(schema.quoteSends)
      .innerJoin(schema.quotes, eq(schema.quotes.id, schema.quoteSends.quoteId))
      .where(and(inArray(schema.quotes.jobId, jobIds), sql`${schema.quoteSends.emailStatus} != 'sent' and ${schema.quoteSends.smsStatus} != 'sent'`)),
    db
      .select({ jobId: schema.activityLog.jobId, action: schema.activityLog.action, at: schema.activityLog.createdAt, id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(and(inArray(schema.activityLog.jobId, jobIds), eq(schema.activityLog.entityType, "job"), inArray(schema.activityLog.action, [QUOTE_NOT_NEEDED, QUOTE_NEEDED_AGAIN]))),
  ]);

  const sentMoment = (q: (typeof quotes)[number]) =>
    q.status === "cancelled" ? null : (q.sentAt ?? (BEEN_SENT.includes(q.status) ? (q.acceptedAt ?? q.updatedAt) : null));

  type Open = { m: (typeof measures)[number]; doneAt: Date; overdue: boolean; quoteText: string };
  const open = new Map<number, Open[]>();
  for (const m of measures) {
    const doneAt = m.completedAt ?? m.updatedAt;
    const doneDay = localDate(doneAt);
    const visitDay = m.scheduledDate && m.scheduledDate < doneDay ? m.scheduledDate : doneDay;
    const from = localDayBounds(visitDay).start.getTime();
    const mine = quotes.filter((q) => q.jobId === m.jobId);
    if (mine.some((q) => (sentMoment(q)?.getTime() ?? -1) >= from)) continue;
    const word = calls.filter((c) => c.jobId === m.jobId && c.at.getTime() >= from).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id).at(-1);
    if (word?.action === QUOTE_NOT_NEEDED) continue;

    // What is on the job now, newest first.
    const draft = mine.filter((q) => !sentMoment(q) && q.status !== "cancelled").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const fail = failed.filter((f) => f.jobId === m.jobId && f.at.getTime() >= from).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    const quoteText = fail
      ? `Send failed ${fmtWhen(fail.at)}, not sent`
      : draft
        ? `Draft ${quoteRef(draft.number, draft.version, m.ref)} not sent yet`
        : "No quote started";
    const row = { m, doneAt, overdue: now.getTime() - doneAt.getTime() >= QUOTE_DUE_MS, quoteText };
    if (!open.has(m.jobId)) open.set(m.jobId, []);
    open.get(m.jobId)!.push(row);
  }

  return [...open.entries()]
    .map(([jobId, list]) => {
      list.sort((a, b) => a.doneAt.getTime() - b.doneAt.getTime());
      const first = list[0]!;
      const overdue = list.some((o) => o.overdue);
      return {
        key: `j:${jobId}`,
        taskId: first.m.taskId,
        jobId,
        path: `/jobs/${jobId}`,
        ref: first.m.ref,
        title: first.m.jobTitle || "Job",
        suburb: first.m.suburb,
        date: localDate(first.doneAt),
        note: [...list.map((o) => `${o.m.taskRef} measured ${fmtWhen(o.doneAt)}`), first.quoteText].join(" · "),
        badge: overdue ? { label: "Overdue", tone: "danger" as const } : { label: "Awaiting quote", tone: "warning" as const },
      };
    })
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
}

/**
 * The office records that this job's measure needs no quote, with a reason
 * (Damien, 14 Nov 2026). Logged on the job's activity like everything else,
 * so it is plain who said so and why. Nothing is sent to anyone.
 */
export async function setQuoteNeeded(jobId: number, needed: boolean, reason: string, actor: { name: string; role: string }) {
  const [job] = await db.select({ id: schema.jobs.id, contactId: schema.jobs.contactId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "That job is not there any more." });
  const why = reason.trim();
  await db.insert(schema.activityLog).values({
    jobId,
    contactId: job.contactId,
    entityType: "job",
    entityId: jobId,
    action: needed ? QUOTE_NEEDED_AGAIN : QUOTE_NOT_NEEDED,
    detail: needed ? `Quote needed after all${why ? `: ${why}` : ""}` : `No quote needed after the measure: ${why}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
}

/* --------------------------------------------------------- the booking lines */

type DispatchHit = { taskId: number; jobId: number; ref: string; title: string; suburb: string | null; date: string | null; note: string | null };

/** One row per job. Its dispatches are named in the note, earliest date first. */
async function perJob(hits: DispatchHit[], say: (h: DispatchHit) => string): Promise<AttentionRow[]> {
  if (!hits.length) return [];
  const jobIds = [...new Set(hits.map((h) => h.jobId))];
  const jobs = await db.select({ id: schema.jobs.id, ref: jobNumberSql, title: schema.jobs.title }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds));
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const byJob = new Map<number, DispatchHit[]>();
  for (const h of hits) {
    if (!byJob.has(h.jobId)) byJob.set(h.jobId, []);
    byJob.get(h.jobId)!.push(h);
  }
  const rows: AttentionRow[] = [];
  for (const [jobId, list] of byJob) {
    list.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.ref.localeCompare(b.ref));
    const j = jobOf.get(jobId);
    rows.push({
      key: `j:${jobId}`,
      taskId: list[0]!.taskId,
      jobId,
      path: `/jobs/${jobId}`,
      ref: j?.ref ?? list[0]!.ref.replace(/-[A-Z]+$/, ""),
      title: j?.title || list[0]!.title,
      suburb: list[0]!.suburb,
      date: list.find((h) => h.date)?.date ?? null,
      note: list.map(say).join(" · "),
      badge: null,
    });
  }
  return rows.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
}

/** "Wed 30 Sept", or "not dated". */
const dayText = (d: string | null) =>
  d ? new Date(`${d}T12:00:00+10:00`).toLocaleDateString("en-AU", { timeZone: TERRA_TZ, weekday: "short", day: "numeric", month: "short" }).replace(",", "") : "not dated";

/**
 * Everything the widget counts and the page lists, from one place, so the two
 * can never disagree. The booking lines are the office dashboard's own lists
 * (routes/dashboard.ts), whole rather than the first 20, one row per job.
 * No money. Enquiries needing action is first, see enquiryRows, then
 * Measures awaiting a quote, see measureQuoteRows.
 */
export async function attentionLists(viewer: AttentionViewer, today = todayLocal(), now = new Date()): Promise<Record<AttentionKey, AttentionRow[]>> {
  const weekEnd = addLocalDays(today, 7);
  const [enquiries, quotes, board, unfilled, offers] = await Promise.all([
    enquiryRows(today, now, viewer),
    measureQuoteRows(now),
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

  // One hit per dispatch on the offers line, naming everyone it is with.
  const offerHits = new Map<number, DispatchHit & { names: string[] }>();
  for (const o of offers) {
    const h = offerHits.get(o.taskId);
    if (h) h.names.push(o.installerName);
    else offerHits.set(o.taskId, { taskId: o.taskId, jobId: o.jobId, ref: o.ref, title: o.title, suburb: o.suburb, date: o.date, note: null, names: [o.installerName] });
  }
  const offerRows = await perJob([...offerHits.values()], (h) => `${h.ref} ${dayText(h.date)}, with ${(h as DispatchHit & { names: string[] }).names.join(", ")}`);
  for (const r of offerRows) {
    const n = offers.filter((o) => o.jobId === r.jobId).length;
    r.pendingOffers = n;
    r.note = `${n} pending ${n === 1 ? "offer" : "offers"} · ${r.note}`;
  }

  const [unfilledRows, overdueRows, incompleteRows] = await Promise.all([
    perJob(
      unfilled.map((t) => ({ taskId: t.taskId, jobId: t.jobId, ref: t.ref, title: t.title, suburb: t.suburb, date: t.date, note: t.skillName })),
      (h) => `${h.ref} ${dayText(h.date)}${h.note ? ` (${h.note})` : ""}`,
    ),
    perJob(
      board.late.map((t) => ({ taskId: t.id, jobId: t.jobId, ref: t.ref, title: t.title, suburb: t.siteSuburb, date: t.lastDay, note: t.installerName ?? "Unassigned" })),
      (h) => `${h.ref} last day ${dayText(h.date)}, ${h.note}`,
    ),
    perJob(
      board.incomplete.map((t) => ({ taskId: t.id, jobId: t.jobId, ref: t.ref, title: t.title, suburb: t.siteSuburb, date: t.scheduledDate, note: t.reason })),
      (h) => `${h.ref}: ${h.note}`,
    ),
  ]);

  return { enquiries, quotes, unfilled: unfilledRows, offers: offerRows, overdue: overdueRows, incomplete: incompleteRows };
}

export const ATTENTION_KEYS: AttentionKey[] = ["enquiries", "quotes", "unfilled", "offers", "overdue", "incomplete"];

const attentionPath = (key?: AttentionKey) => `/office?path=${encodeURIComponent(key ? `/attention?show=${key}` : "/attention")}`;

/** Each line is its own list's length. The total is distinct jobs across them all, never the lines added up. */
export function attentionCounts(lists: Record<AttentionKey, AttentionRow[]>): AttentionCounts {
  const all = new Set<string>();
  for (const k of ATTENTION_KEYS) for (const r of lists[k]) all.add(r.key);
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
      attentionLists(actor, today, at),
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
