import { and, eq, inArray, ne, or, sql, isNull } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { checkDays } from "../availability";
import { checkAttendance, slotWindow, toMin } from "../calendar-availability";
import { addLocalDays, todayLocal } from "../local-date";
import { bneParts, type PhoneConfig } from "./config";

/* ---------------------------------------------------------------------------
 * Free times for a measure or site visit (Retell, 5 Nov).
 *
 * A slot is free for a person only when every one of these says so:
 *   - their working days and dated time off (lib/availability checkDays),
 *   - nothing already booked on them that day overlapping the visit plus the
 *     travel buffer either side. A booking with no time counts as a clash,
 *     because it can't be ruled out,
 *   - for anyone with a linked Google calendar, the private busy times with
 *     that calendar's own buffers (lib/calendar-availability). A calendar
 *     that can't be read counts as busy.
 * The caller only ever hears "free" or "not free". No reason, no detail of
 * anyone's private time, ever leaves this file.
 * ------------------------------------------------------------------------- */

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (mins: number) => `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;

export async function visitSkillId(cfg: PhoneConfig) {
  if (cfg.visits.skillId) return cfg.visits.skillId;
  const [s] = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(sql`lower(${schema.skills.name}) like 'measure%'`)
    .orderBy(schema.skills.id)
    .limit(1);
  return s?.id ?? null;
}

/** Who may be booked for a visit: the picked list, or every active installer ticked for the skill. */
export async function visitPeople(cfg: PhoneConfig, skillId: number | null) {
  if (!skillId) return [];
  const rows = await db
    .select({ id: schema.installers.id })
    .from(schema.installers)
    .innerJoin(schema.installerSkills, and(eq(schema.installerSkills.installerId, schema.installers.id), eq(schema.installerSkills.skillId, skillId)))
    .where(and(eq(schema.installers.active, true), isNull(schema.installers.archivedAt)))
    .orderBy(schema.installers.id);
  const ticked = rows.map((r) => r.id);
  return cfg.visits.installerIds.length ? cfg.visits.installerIds.filter((id) => ticked.includes(id)) : ticked;
}

/** Work already on this person that day, overlapping [startMs, endMs). Untimed work always overlaps. */
async function bookingClash(installerId: number, date: string, startMs: number, endMs: number) {
  const rows = await db
    .select({ day: schema.taskDays, durationHours: schema.jobTasks.durationHours })
    .from(schema.taskDays)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskDays.taskId))
    .where(
      and(
        eq(schema.taskDays.date, date),
        ne(schema.taskDays.status, "cancelled"),
        ne(schema.jobTasks.status, "cancelled"),
        or(
          eq(schema.taskDays.installerId, installerId),
          and(isNull(schema.taskDays.installerId), or(eq(schema.jobTasks.assignedInstallerId, installerId), eq(schema.jobTasks.secondInstallerId, installerId))),
        ),
      ),
    );
  for (const r of rows) {
    if (r.day.coordinate) return true;
    const w = slotWindow(date, r.day.arrivalStart, r.day.arrivalEnd, r.durationHours);
    if (!w) return true;
    if (w.startMs < endMs && w.endMs > startMs) return true;
  }
  return false;
}

/** Is this person free for a visit starting at `start` (HH:MM) on `date`? */
export async function slotFree(cfg: PhoneConfig, installerId: number, date: string, start: string) {
  const s = toMin(start);
  if (s == null) return false;
  const buf = cfg.visits.bufferMins;
  const dur = cfg.visits.durationMins;
  const from = Math.max(0, s - buf);
  const hours = (dur + 2 * buf) / 60;
  const [day] = await checkDays({ installerId, dates: [date] });
  if (!day || day.status !== "available") return false;
  const win = slotWindow(date, hm(from), null, hours);
  if (!win) return false;
  if (await bookingClash(installerId, date, win.startMs, win.endMs)) return false;
  const cal = await checkAttendance({ taskId: null, durationHours: hours, days: [{ date, arrivalStart: hm(from), arrivalEnd: null, coordinate: false, people: [installerId] }], actor: null });
  return cal.every((c) => c.status === "clear");
}

export type Slot = { slot: string; date: string; start: string; installerId: number };

export const slotId = (s: { date: string; start: string; installerId: number }) => `${s.date}|${s.start}|${s.installerId}`;
export function parseSlot(raw: unknown): Slot | null {
  const m = /^(\d{4}-\d{2}-\d{2})\|(\d{2}:\d{2})\|(\d+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  return { slot: m[0], date: m[1]!, start: m[2]!, installerId: Number(m[3]) };
}

export function sayDay(date: string) {
  return new Date(`${date}T12:00:00+10:00`).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long" });
}
export function sayTime(hhmm: string) {
  const m = toMin(hhmm) ?? 0;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${mm ? `:${pad(mm)}` : ""} ${h < 12 ? "a.m." : "p.m."}`;
}

/** The first few free slots from `fromDate`, honouring notice, the window and the time of day asked for. */
export async function freeSlots(cfg: PhoneConfig, opts: { fromDate?: string | null; partOfDay?: "morning" | "afternoon" | "any"; max?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const skillId = await visitSkillId(cfg);
  const people = await visitPeople(cfg, skillId);
  if (!people.length) return { skillId, people, slots: [] as Slot[] };
  const today = todayLocal();
  const earliestMs = now.getTime() + cfg.visits.minNoticeHours * 3600_000;
  const last = addLocalDays(today, cfg.visits.daysAhead);
  let date = opts.fromDate && opts.fromDate > today ? opts.fromDate : today;
  const max = opts.max ?? 3;
  const slots: Slot[] = [];
  const times = cfg.visits.startTimes.filter((t) => {
    const m = toMin(t) ?? 0;
    if (opts.partOfDay === "morning") return m < 12 * 60;
    if (opts.partOfDay === "afternoon") return m >= 12 * 60;
    return true;
  });
  for (let guard = 0; guard < 62 && date <= last && slots.length < max; guard++, date = addLocalDays(date, 1)) {
    const wd = bneParts(new Date(`${date}T12:00:00+10:00`)).weekday;
    if (!cfg.officeHours.days.includes(wd)) continue;
    for (const t of times) {
      if (slots.length >= max) break;
      if (Date.parse(`${date}T${t}:00+10:00`) < earliestMs) continue;
      for (const id of people) {
        if (await slotFree(cfg, id, date, t)) {
          slots.push({ slot: slotId({ date, start: t, installerId: id }), date, start: t, installerId: id });
          break;
        }
      }
    }
  }
  return { skillId, people, slots };
}

/** Other days already on this job's tasks, so a second visit isn't booked on top of the first. */
export async function openVisitOnJob(jobId: number, skillId: number) {
  const [row] = await db
    .select({ id: schema.jobTasks.id })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), eq(schema.jobTasks.skillId, skillId), inArray(schema.jobTasks.status, ["unassigned", "offered", "assigned", "in_progress"])))
    .limit(1);
  return row?.id ?? null;
}
