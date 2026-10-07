import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { checkDays, nonWorkingWeekdays } from "../lib/availability";
import { daysFromQty } from "../lib/day-estimate";
import { matchInstaller, parseBookingLine } from "../lib/booking-command";
import { lockTaskLabour } from "./costing";
import { installerForStaff, taskForStaff } from "../lib/staff-view";

/**
 * TASKS ARE THE DISPATCH UNIT — not jobs. One job can be five separate
 * dispatches (tile removal → prep → carpet lay → skirting → silicone), each
 * with its own skill requirement, crew size, installer and pay. This is the
 * biggest single departure from ServiceM8.
 */

/** Enforces the furniture rule and the skill-tick rule in one place. */
async function assertAssignable(taskId: number, installerId: number, _crewSize: number) {
  const [task] = await db
    .select({ task: schema.jobTasks, job: schema.jobs })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .where(eq(schema.jobTasks.id, taskId));
  if (!task) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

  // Only installers ticked for this skill can ever be given the task.
  if (task.task.skillId) {
    const [tick] = await db
      .select()
      .from(schema.installerSkills)
      .where(
        and(
          eq(schema.installerSkills.installerId, installerId),
          eq(schema.installerSkills.skillId, task.task.skillId),
        ),
      );
    if (!tick) {
      const [skill] = await db.select().from(schema.skills).where(eq(schema.skills.id, task.task.skillId));
      throw new ORPCError("BAD_REQUEST", {
        message: `That installer isn't ticked for ${skill?.name ?? "this skill"}.`,
      });
    }
  }

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });

  return { task: task.task, job: task.job, installer };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** A date as YYYY-MM-DD in local time, not UTC, so "today" is today here. */
function iso(d: Date) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** "Thu 1 Oct", the way the office says a date out loud. */
function sayDate(date: string) {
  const d = new Date(`${date}T00:00:00`);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString("en-AU", { month: "short" })}`;
}

/** Same date, n days on. Plain calendar days, no weekend logic. */
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Calendar days from a to b, so a run keeps its shape when it moves. */
function daysBetween(a: string, b: string) {
  const ms = new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * The days a run of `days` starting on `startDate` would land on, stepping over
 * the weekdays this installer never works. Same walk planBooking does, so a
 * dragged booking and a panel booking land on the same dates.
 */
function runDates(startDate: string, days: number, off: number[]) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  for (let guard = 0; dates.length < days && guard < 120; guard++) {
    if (!off.includes(cursor.getDay())) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

/**
 * How many days on site the work looks like, from what has already been
 * measured, or failing that the area on the dispatch. It is a starting number
 * for the office to accept or change, never a lock: a 96m2 carpet lay at
 * 60m2 a day suggests 2 days, and Damien can still book it as 1 or 3.
 */
async function suggestDays(taskId: number) {
  const [row] = await db
    .select({ task: schema.jobTasks, skill: schema.skills })
    .from(schema.jobTasks)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .where(eq(schema.jobTasks.id, taskId));
  if (!row) return null;

  // A hand-entered day count is the answer, full stop. The office set it
  // because they know something the rates do not.
  if (row.task.manualDays && row.task.manualDays > 0) {
    return {
      days: row.task.manualDays,
      exact: row.task.manualDays,
      basis: "manual" as const,
      qty: 0,
      unit: row.skill?.productionUnit ?? "m2",
      perDay: 0,
      fixedDays: 0,
    };
  }

  const rate = row.skill?.productionRate ?? null;
  if (!rate || rate <= 0) return null;
  const unit = row.skill?.productionUnit ?? "m2";
  const crew = Math.max(1, row.task.crewSize);
  const uplift = row.skill?.extraCrewUpliftPct ?? 35;
  const fixedDays = row.skill?.fixedDays ?? 0;

  const measured = await db
    .select({ qty: schema.taskLabourLines.qty, unit: schema.labourRateItems.unit, kind: schema.labourRateItems.kind })
    .from(schema.taskLabourLines)
    .innerJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.taskLabourLines.itemId))
    .where(eq(schema.taskLabourLines.taskId, taskId));

  const measuredQty = measured
    .filter((l) => l.kind === "work" && l.unit === unit)
    .reduce((sum, l) => sum + l.qty, 0);
  const qty = measuredQty > 0 ? measuredQty : unit === "m2" ? (row.task.areaM2 ?? 0) : 0;
  if (qty <= 0) return null;

  const est = daysFromQty({ qty, rate, crew, extraCrewUpliftPct: uplift, fixedDays });
  if (!est) return null;
  return {
    days: est.days,
    exact: est.exact,
    basis: measuredQty > 0 ? ("measured" as const) : ("area" as const),
    qty: Math.round(qty * 10) / 10,
    unit,
    perDay: est.perDay,
    fixedDays: est.fixedDays,
  };
}

export const tasks = {
  /** The dispatch board feed: every task in a date window, plus the unassigned queue. */
  board: staffOnly
    .input(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ input, context }) => {
      const scheduled = await db
        .select({
          task: schema.jobTasks,
          skill: schema.skills,
          job: schema.jobs,
          site: schema.sites,
          contact: schema.contacts,
          company: schema.companies,
          status: schema.jobStatuses,
          pendingOffers: sql<number>`(
            select count(*) from task_offers o
            where o.task_id = job_tasks.id and o.status = 'pending'
          )`,
          secondName: sql<string | null>`(
            select i.name from installers i where i.id = job_tasks.second_installer_id
          )`,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .where(
          and(
            // A run that started before this week still belongs on it, so the
            // window matches either the task's own day or any of its day rows.
            or(
              and(gte(schema.jobTasks.scheduledDate, input.from), lte(schema.jobTasks.scheduledDate, input.to)),
              sql`exists (
                select 1 from task_days d
                where d.task_id = job_tasks.id and d.status != 'cancelled'
                  and d.date >= ${input.from} and d.date <= ${input.to}
              )`,
            ),
            sql`${schema.jobTasks.status} != 'cancelled'`,
          ),
        )
        .orderBy(asc(schema.jobTasks.scheduledDate), asc(schema.jobTasks.startTime));

      // Every day of every run on the board, so a 3 day job draws across 3 cells.
      const dayRows = scheduled.length
        ? await db
            .select()
            .from(schema.taskDays)
            .where(
              and(
                inArray(
                  schema.taskDays.taskId,
                  scheduled.map((r) => r.task.id),
                ),
                sql`${schema.taskDays.status} != 'cancelled'`,
              ),
            )
            .orderBy(asc(schema.taskDays.date))
        : [];
      const daysByTask = new Map<number, typeof dayRows>();
      for (const d of dayRows) {
        const list = daysByTask.get(d.taskId) ?? [];
        list.push(d);
        daysByTask.set(d.taskId, list);
      }

      const unassigned = await db
        .select({
          task: schema.jobTasks,
          skill: schema.skills,
          job: schema.jobs,
          site: schema.sites,
          contact: schema.contacts,
          company: schema.companies,
          pendingOffers: sql<number>`(
            select count(*) from task_offers o
            where o.task_id = job_tasks.id and o.status = 'pending'
          )`,
        })
        .from(schema.jobTasks)
        .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
        .where(
          and(
            inArray(schema.jobTasks.status, ["unassigned", "offered"]),
            or(isNull(schema.jobTasks.assignedInstallerId), isNull(schema.jobTasks.scheduledDate)),
          ),
        )
        .orderBy(asc(schema.jobTasks.createdAt));

      const shape = (r: (typeof scheduled)[number] | (typeof unassigned)[number]) => ({
        ...taskForStaff(r.task, context.actor),
        skill: r.skill,
        jobNumber: r.job.number,
        jobTitle: r.job.title,
        furnitureOnSite: r.job.furnitureOnSite,
        siteAddress: r.site?.address ?? "",
        siteSuburb: r.site?.suburb ?? "",
        customerName: r.company?.name ?? [r.contact?.firstName, r.contact?.lastName].filter(Boolean).join(" "),
        pendingOffers: Number(r.pendingOffers ?? 0),
      });

      return {
        tasks: scheduled.map((r) => {
          const days = (daysByTask.get(r.task.id) ?? []).map((d) => ({
            date: d.date,
            seq: d.seq,
            arrivalStart: d.arrivalStart,
            arrivalEnd: d.arrivalEnd,
            coordinate: d.coordinate,
            installerId: d.installerId,
          }));
          return {
            ...shape(r),
            secondInstallerName: r.secondName ?? null,
            days,
            /** Every date this dispatch occupies, so the board can draw one bar. */
            dates: days.length ? days.map((d) => d.date) : r.task.scheduledDate ? [r.task.scheduledDate] : [],
          };
        }),
        unassigned: unassigned.map(shape),
      };
    }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select({
        task: schema.jobTasks,
        skill: schema.skills,
        job: schema.jobs,
        site: schema.sites,
        installer: schema.installers,
      })
      .from(schema.jobTasks)
      .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .leftJoin(schema.installers, eq(schema.installers.id, schema.jobTasks.assignedInstallerId))
      .where(eq(schema.jobTasks.id, input.id));
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

    const [checklist, photos, offers, days, suggested] = await Promise.all([
      db
        .select()
        .from(schema.taskChecklistItems)
        .where(eq(schema.taskChecklistItems.taskId, input.id))
        .orderBy(asc(schema.taskChecklistItems.sortOrder)),
      db.select().from(schema.taskPhotos).where(eq(schema.taskPhotos.taskId, input.id)),
      db
        .select({ offer: schema.taskOffers, installer: schema.installers })
        .from(schema.taskOffers)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
        .where(eq(schema.taskOffers.taskId, input.id))
        .orderBy(asc(schema.taskOffers.sentAt)),
      db
        .select({ day: schema.taskDays, installer: schema.installers })
        .from(schema.taskDays)
        .leftJoin(schema.installers, eq(schema.installers.id, schema.taskDays.installerId))
        .where(and(eq(schema.taskDays.taskId, input.id), sql`${schema.taskDays.status} != 'cancelled'`))
        .orderBy(asc(schema.taskDays.date)),
      suggestDays(input.id),
    ]);

    return {
      ...taskForStaff(row.task, context.actor),
      skill: row.skill,
      job: row.job,
      site: row.site,
      installer: installerForStaff(row.installer, context.actor),
      checklist,
      photos,
      offers: offers.map((o) => ({ ...o, installer: installerForStaff(o.installer, context.actor) })),
      days: days.map((d) => ({ ...d.day, installerName: d.installer?.name ?? null })),
      suggested,
    };
  }),

  create: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        skillId: z.number().nullable().optional(),
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        areaM2: z.number().nullable().optional(),
        scheduledDate: z.string().nullable().optional(),
        /** Date window the work can land in — the installer picks the day. */
        scheduledFrom: z.string().nullable().optional(),
        scheduledTo: z.string().nullable().optional(),
        tenderMode: z.boolean().optional(),
        startTime: z.string().nullable().optional(),
        durationHours: z.number().default(4),
        crewSize: z.number().int().min(1).max(2).default(1),
        payType: z.enum(["per_m2", "hourly", "per_job", "day_rate"]).default("per_job"),
        payAmount: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

      const [maxSeq] = await db
        .select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` })
        .from(schema.jobTasks)
        .where(eq(schema.jobTasks.jobId, input.jobId));

      // Furniture on site forces a 2-man crew — the office can't undercut it.
      const crewSize = job.furnitureOnSite ? Math.max(2, input.crewSize) : input.crewSize;

      const [row] = await db
        .insert(schema.jobTasks)
        .values({ ...input, crewSize, seq: Number(maxSeq?.max ?? 0) + 1 })
        .returning();

      await db.insert(schema.activityLog).values({
        jobId: input.jobId,
        taskId: row!.id,
        entityType: "task",
        entityId: row!.id,
        action: "task_created",
        detail: `${input.title}${crewSize > input.crewSize ? " (crew forced to 2 — furniture on site)" : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  update: staffOnly
    .input(
      z.object({
        id: z.number(),
        skillId: z.number().nullable().optional(),
        title: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        areaM2: z.number().nullable().optional(),
        scheduledFrom: z.string().nullable().optional(),
        scheduledTo: z.string().nullable().optional(),
        tenderMode: z.boolean().optional(),
        durationHours: z.number().optional(),
        crewSize: z.number().int().min(1).max(2).optional(),
        payType: z.enum(["per_m2", "hourly", "per_job", "day_rate"]).optional(),
        payAmount: z.number().nullable().optional(),
        seq: z.number().int().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const [existing] = await db
        .select({ task: schema.jobTasks, job: schema.jobs })
        .from(schema.jobTasks)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .where(eq(schema.jobTasks.id, id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

      if (rest.crewSize === 1 && existing.job.furnitureOnSite) {
        throw new ORPCError("BAD_REQUEST", {
          message: "This job has furniture on site — it needs a 2-man crew.",
        });
      }

      const [row] = await db
        .update(schema.jobTasks)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, id))
        .returning();
      return row ? taskForStaff(row, context.actor) : row;
    }),

  /**
   * Drag-and-drop on the board: move a task to a day, optionally onto an
   * installer. A booked run moves as a whole. Drag the bar to Wednesday and
   * all four days shift with it, gaps and per-day windows intact.
   */
  reschedule: staffOnly
    .input(
      z.object({
        id: z.number(),
        scheduledDate: z.string().nullable(),
        startTime: z.string().nullable().optional(),
        installerId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [existing] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

      if (input.installerId) {
        const { task, job } = await assertAssignable(input.id, input.installerId, existing.crewSize);
        const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
        // A 2-man task can't be covered by one person unless they bring their own offsider.
        if (task.crewSize > 1 && installer!.crewCapacity !== "own_offsider" && !task.secondInstallerId) {
          throw new ORPCError("BAD_REQUEST", {
            message: `${installer!.name} can't cover a 2-man task alone${job.furnitureOnSite ? " (furniture on site)" : ""}. Add a second installer or pick someone who brings an offsider.`,
          });
        }
      }

      // Move the booked days with the bar the office just dragged.
      const existingDays = await db
        .select()
        .from(schema.taskDays)
        .where(and(eq(schema.taskDays.taskId, input.id), sql`${schema.taskDays.status} != 'cancelled'`))
        .orderBy(asc(schema.taskDays.date));

      let moved: string[] = [];
      /** How many days the drag booked when it booked more than the one dropped on. */
      let bookedDays = 0;
      const runInstaller = input.installerId ?? existing.assignedInstallerId;
      if (existingDays.length && input.scheduledDate) {
        const offsets = existingDays.map((d) => daysBetween(existingDays[0]!.date, d.date));
        moved = offsets.map((o) => addDays(input.scheduledDate!, o));
        // Rewrite the run rather than nudge each row, so the one-day-per-task
        // unique index can't trip over a date the run already holds.
        await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, input.id));
        await db.insert(schema.taskDays).values(
          existingDays.map((d, i) => ({
            taskId: input.id,
            date: moved[i]!,
            seq: i + 1,
            arrivalStart: i === 0 && input.startTime !== undefined ? input.startTime : d.arrivalStart,
            arrivalEnd: d.arrivalEnd,
            coordinate: d.coordinate,
            // A day handed to someone else stays theirs. Only dropping the run
            // on a different installer pulls those hand-offs back.
            installerId:
              input.installerId && input.installerId !== existing.assignedInstallerId ? null : d.installerId,
            status: d.status,
            overrideNote: d.overrideNote,
          })),
        );
      } else if (existingDays.length && !input.scheduledDate) {
        // Dragged off the board: the run is gone, not silently left behind.
        await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, input.id));
      } else if (input.scheduledDate && runInstaller) {
        // Dragging an unbooked dispatch onto a day books the whole run Terra
        // reckons it takes, not just the day under the cursor. A 3 day carpet
        // lay lands as 3 days in one drag, and the office adjusts it after if
        // the estimate is wrong.
        const suggested = await suggestDays(input.id);
        const off = await nonWorkingWeekdays(runInstaller);
        moved = runDates(input.scheduledDate, Math.max(1, suggested?.days ?? 1), off);
        bookedDays = moved.length;
        // Clears any cancelled day rows left on the task, so the one-day-per-task
        // index can't trip over a date this run wants.
        await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, input.id));
        await db.insert(schema.taskDays).values(
          moved.map((date, i) => ({
            taskId: input.id,
            date,
            seq: i + 1,
            arrivalStart: (input.startTime !== undefined ? input.startTime : existing.startTime) ?? null,
            arrivalEnd: null,
            coordinate: false,
            installerId: null,
            status: "booked",
          })),
        );
      }

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          scheduledDate: input.scheduledDate,
          ...(existingDays.length || moved.length
            ? { scheduledFrom: moved[0] ?? null, scheduledTo: moved[moved.length - 1] ?? null }
            : {}),
          ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
          ...(input.installerId !== undefined
            ? {
                assignedInstallerId: input.installerId,
                status: input.installerId ? "assigned" : "unassigned",
                ...(input.installerId ? {} : { secondInstallerId: null }),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.id))
        .returning();

      // Someone is on it now, so the labour stops moving with the rate book.
      if (input.installerId) await lockTaskLabour({ taskId: input.id, installerId: input.installerId });

      const span =
        moved.length > 1
          ? `${sayDate(moved[0]!)} → ${sayDate(moved[moved.length - 1]!)} (${moved.length} days)`
          : input.scheduledDate
            ? sayDate(input.scheduledDate)
            : "unscheduled";
      await db.insert(schema.activityLog).values({
        jobId: existing.jobId,
        taskId: input.id,
        entityType: "task",
        entityId: input.id,
        action: bookedDays ? "booked" : "rescheduled",
        detail: `${existing.title} → ${span}${bookedDays > 1 ? " (Terra's estimate, dragged on)" : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { ...row, dates: moved, bookedDays };
    }),

  /** Assign directly, no offer — the installer is simply told. */
  assign: staffOnly
    .input(
      z.object({
        id: z.number(),
        installerId: z.number(),
        secondInstallerId: z.number().nullable().optional(),
        payAmount: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { task, job, installer } = await assertAssignable(input.id, input.installerId, 1);

      const needsTwo = task.crewSize > 1;
      const bringsOwn = installer.crewCapacity === "own_offsider";
      if (needsTwo && !bringsOwn && !input.secondInstallerId) {
        throw new ORPCError("BAD_REQUEST", {
          message: `This is a 2-man task${job.furnitureOnSite ? " (furniture on site)" : ""} and ${installer.name} doesn't bring an offsider. Pick a second installer.`,
        });
      }
      if (input.secondInstallerId) {
        await assertAssignable(input.id, input.secondInstallerId, 1);
      }

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          assignedInstallerId: input.installerId,
          secondInstallerId: input.secondInstallerId ?? null,
          status: "assigned",
          ...(input.payAmount !== undefined && input.payAmount !== null ? { payAmount: input.payAmount } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.id))
        .returning();

      // Any outstanding offers on this task are moot now.
      await db
        .update(schema.taskOffers)
        .set({ status: "withdrawn", respondedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.taskOffers.taskId, input.id), eq(schema.taskOffers.status, "pending")));

      // Lock the labour at his rates, today. A rise next year is next year's job.
      await lockTaskLabour({ taskId: input.id, installerId: input.installerId });

      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.id,
        entityType: "task",
        entityId: input.id,
        action: "assigned",
        detail: `${task.title} → ${installer.name}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row ? taskForStaff(row, context.actor) : row;
    }),

  /* --------------------------- booking a run --------------------------- */

  /**
   * Read a typed booking line and say what it would do, without doing it.
   *
   * "Pedro 4446 thu 3 days 7-11" is faster to say than to click, so the board
   * takes the whole booking as one line. This resolves the words into a real
   * installer, a real task and real dates, then hands back exactly what the
   * panel would have shown: the days, their availability, and any clash.
   *
   * It resolves rather than assumes. Anything it could not place comes back as
   * a question, because a booking that lands on the wrong week is worse than
   * one that took an extra five seconds to confirm.
   */
  parseCommand: staffOnly
    .input(
      z.object({
        text: z.string(),
        /** The task already on screen, used when the line names no job. */
        contextTaskId: z.number().nullable().default(null),
      }),
    )
    .handler(async ({ input }) => {
      /** Genuinely in the way: without these there is nothing to book. */
      const problems: string[] = [];
      /**
       * Filled in for them rather than asked about. These never hold the
       * booking up, the same way a clash never does: they are said out loud on
       * the preview and the office books straight over them if they are right.
       */
      const notes: string[] = [];
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const parsed = parseBookingLine(input.text, today);

      /* ---------------------------- the task ---------------------------- */
      let taskRow: { task: typeof schema.jobTasks.$inferSelect; job: typeof schema.jobs.$inferSelect } | null = null;
      let jobChoices: Array<{ taskId: number; label: string }> = [];

      if (parsed.taskId) {
        const [found] = await db
          .select({ task: schema.jobTasks, job: schema.jobs })
          .from(schema.jobTasks)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
          .where(eq(schema.jobTasks.id, parsed.taskId));
        if (found) taskRow = found;
        else problems.push(`There is no dispatch ${parsed.taskId}.`);
      } else if (parsed.jobNumber) {
        const rows = await db
          .select({ task: schema.jobTasks, job: schema.jobs })
          .from(schema.jobTasks)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
          .where(and(eq(schema.jobs.number, Number(parsed.jobNumber)), inArray(schema.jobTasks.status, ["unassigned", "offered", "assigned"])))
          .orderBy(asc(schema.jobTasks.seq));
        if (rows.length === 1) taskRow = rows[0]!;
        else if (rows.length > 1) {
          // Several dispatches on the one job is normal: tile removal, then
          // prep, then the lay. The line cannot tell them apart, so ask.
          taskRow = null;
          jobChoices = rows.map((r) => ({ taskId: r.task.id, label: r.task.title }));
          problems.push(`Job ${parsed.jobNumber} has ${rows.length} dispatches on it. Which one?`);
        } else problems.push(`No open dispatch on job ${parsed.jobNumber}.`);
      } else if (input.contextTaskId) {
        const [found] = await db
          .select({ task: schema.jobTasks, job: schema.jobs })
          .from(schema.jobTasks)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
          .where(eq(schema.jobTasks.id, input.contextTaskId));
        if (found) taskRow = found;
      } else problems.push("No job number in that.");

      /* -------------------------- the installer -------------------------- */
      // Matched against who is ticked for this skill when the task is known,
      // so a name only has to be unique among the people who could do it.
      const pool = taskRow?.task.skillId
        ? await db
            .select({ id: schema.installers.id, name: schema.installers.name })
            .from(schema.installerSkills)
            .innerJoin(schema.installers, eq(schema.installers.id, schema.installerSkills.installerId))
            .where(and(eq(schema.installerSkills.skillId, taskRow.task.skillId), eq(schema.installers.active, true)))
        : await db
            .select({ id: schema.installers.id, name: schema.installers.name })
            .from(schema.installers)
            .where(eq(schema.installers.active, true));

      const { installer, ambiguous } = matchInstaller(parsed.nameWords, pool);
      if (!installer) {
        if (ambiguous.length > 1) problems.push(`Which one: ${ambiguous.map((a) => a.name).join(" or ")}?`);
        else if (parsed.nameWords.length) problems.push(`No installer matching "${parsed.nameWords.join(" ")}" is ticked for this work.`);
        else problems.push("No installer name in that.");
      }

      /* ---------------------------- the dates ---------------------------- */
      const startDate = parsed.startDate ?? iso(today);
      if (!parsed.dateGiven) notes.push("No day said, so today it is.");

      const suggested = taskRow ? await suggestDays(taskRow.task.id) : null;
      const days = parsed.days ?? suggested?.days ?? 1;
      if (parsed.days == null && days > 1) {
        notes.push(`No day count said, so Terra reckons ${days} days.`);
      }
      const off = installer ? await nonWorkingWeekdays(installer.id) : [];
      const dates = runDates(startDate, days, off);

      const checks =
        installer && taskRow
          ? await checkDays({ installerId: installer.id, dates, exceptTaskId: taskRow.task.id })
          : dates.map((date) => ({ date, status: "available" as const, reason: null, clashes: [] }));

      // Words that went nowhere are usually a mangled time. Loud, but not a
      // blocker: the preview shows the window it did read, so the office can
      // see for themselves whether the leftovers mattered.
      if (parsed.unread.length) {
        notes.push(`Could not place "${parsed.unread.join(" ")}", so it was left out.`);
      }

      return {
        /**
         * Enough resolved to book. Notes and clashes deliberately do not count:
         * the office overrides those on purpose, the same as on the panel.
         */
        ready: problems.length === 0 && !!installer && !!taskRow,
        problems,
        notes,
        unread: parsed.unread,
        jobChoices,
        task: taskRow
          ? {
              id: taskRow.task.id,
              title: taskRow.task.title,
              jobNumber: taskRow.job.number,
              areaM2: taskRow.task.areaM2,
              crewSize: taskRow.task.crewSize,
            }
          : null,
        installer: installer ?? null,
        startDate,
        dateGiven: parsed.dateGiven,
        days,
        /** True when the day count came off the rates, not off the line. */
        daysFromRates: parsed.days == null && suggested != null,
        daysByHand: parsed.days != null,
        suggested,
        arrivalStart: parsed.arrivalStart,
        arrivalEnd: parsed.arrivalEnd,
        coordinateAfterFirst: parsed.coordinateAfterFirst,
        dates,
        dayChecks: checks.map((c) => ({ ...c, label: sayDate(c.date) })),
        clashCount: checks.reduce((n, c) => n + c.clashes.length, 0),
        unavailableCount: checks.filter((c) => c.status !== "available").length,
      };
    }),

  /**
   * What a booking would land on, before anything is written: the dates, each
   * one's availability, and anything already in that installer's diary. The
   * panel calls this on every change so the office is looking at the real
   * answer while they set it up, not after they press book.
   */
  planBooking: staffOnly
    .input(
      z.object({
        taskId: z.number(),
        installerId: z.number().nullable(),
        startDate: z.string(),
        days: z.number().int().min(1).max(30).default(1),
        /** Step over the days this installer never works instead of counting them. */
        skipNonWorking: z.boolean().default(true),
        /** Dates the office has ticked off the run by hand. */
        excludeDates: z.array(z.string()).default([]),
      }),
    )
    .handler(async ({ input }) => {
      const off = input.installerId && input.skipNonWorking ? await nonWorkingWeekdays(input.installerId) : [];
      const excluded = new Set(input.excludeDates);

      const dates: string[] = [];
      const skipped: string[] = [];
      const cursor = new Date(`${input.startDate}T00:00:00`);
      // Walk forward until the run has its days. The cap stops a bad rule
      // (someone marked unavailable every weekday) spinning forever.
      for (let guard = 0; dates.length < input.days && guard < 120; guard++) {
        const date = cursor.toISOString().slice(0, 10);
        if (off.includes(cursor.getDay())) skipped.push(date);
        else if (excluded.has(date)) skipped.push(date);
        else dates.push(date);
        cursor.setDate(cursor.getDate() + 1);
      }

      const checks = input.installerId
        ? await checkDays({ installerId: input.installerId, dates, exceptTaskId: input.taskId })
        : dates.map((date) => ({ date, status: "available" as const, reason: null, clashes: [] }));

      return {
        dates,
        skipped,
        days: checks.map((c) => ({ ...c, label: sayDate(c.date) })),
        clashCount: checks.reduce((n, c) => n + c.clashes.length, 0),
        unavailableCount: checks.filter((c) => c.status !== "available").length,
      };
    }),

  /**
   * Book a dispatch onto an installer for one day or a run of days, in a single
   * write. Three days is one task with three day rows, so the labour, the
   * checklist, the photos and the invoice all stay on one job.
   *
   * A clash or a day off does NOT stop this. The office can have a reason the
   * system doesn't know about, so the warning is loud in the panel and the
   * override is recorded here rather than the booking being refused.
   */
  book: staffOnly
    .input(
      z.object({
        taskId: z.number(),
        installerId: z.number(),
        secondInstallerId: z.number().nullable().optional(),
        /** The exact days, already worked out by planBooking. */
        dates: z.array(z.string()).min(1).max(30),
        /** Same window every day unless a day overrides it below. */
        arrivalStart: z.string().nullable().optional(),
        arrivalEnd: z.string().nullable().optional(),
        /** Following days are left for the installer and the site to sort out. */
        coordinateAfterFirst: z.boolean().default(false),
        /** Per-day overrides: window, or a different installer for that day. */
        perDay: z
          .array(
            z.object({
              date: z.string(),
              arrivalStart: z.string().nullable().optional(),
              arrivalEnd: z.string().nullable().optional(),
              coordinate: z.boolean().optional(),
              installerId: z.number().nullable().optional(),
            }),
          )
          .default([]),
        durationHours: z.number().nullable().optional(),
        payAmount: z.number().nullable().optional(),
        /** Why the office booked over a clash. Stored on the affected days. */
        overrideNote: z.string().nullable().optional(),
        /**
         * Day count the office put in themselves. Stored on the task so it
         * beats the rate-based recommendation from here on, including on a
         * later drag. Null leaves the recommendation in charge.
         */
        manualDays: z.number().int().min(1).max(30).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const dates = [...new Set(input.dates)].sort();
      const { task, job, installer } = await assertAssignable(input.taskId, input.installerId, 1);

      const needsTwo = task.crewSize > 1;
      const bringsOwn = installer.crewCapacity === "own_offsider";
      if (needsTwo && !bringsOwn && !input.secondInstallerId && !task.secondInstallerId) {
        throw new ORPCError("BAD_REQUEST", {
          message: `This is a 2-man task${job.furnitureOnSite ? " (furniture on site)" : ""} and ${installer.name} doesn't bring an offsider. Pick a second installer.`,
        });
      }
      if (input.secondInstallerId) await assertAssignable(input.taskId, input.secondInstallerId, 1);
      // A day handed to someone else still has to be someone ticked for the work.
      for (const d of input.perDay) {
        if (d.installerId) await assertAssignable(input.taskId, d.installerId, 1);
      }

      const overrides = new Map(input.perDay.map((d) => [d.date, d]));
      const first = dates[0]!;

      // Replace the run rather than add to it, so re-booking is idempotent.
      await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, input.taskId));
      await db.insert(schema.taskDays).values(
        dates.map((date, i) => {
          const o = overrides.get(date);
          const coordinate = o?.coordinate ?? (i > 0 ? input.coordinateAfterFirst : false);
          return {
            taskId: input.taskId,
            date,
            seq: i + 1,
            arrivalStart: coordinate ? null : (o?.arrivalStart ?? input.arrivalStart ?? null),
            arrivalEnd: coordinate ? null : (o?.arrivalEnd ?? input.arrivalEnd ?? null),
            coordinate,
            installerId: o?.installerId ?? null,
            status: "booked",
            overrideNote: input.overrideNote ?? null,
          };
        }),
      );

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          assignedInstallerId: input.installerId,
          ...(input.secondInstallerId !== undefined ? { secondInstallerId: input.secondInstallerId } : {}),
          status: "assigned",
          scheduledDate: first,
          scheduledFrom: first,
          scheduledTo: dates[dates.length - 1]!,
          startTime: input.arrivalStart ?? task.startTime,
          ...(input.durationHours != null ? { durationHours: input.durationHours } : {}),
          ...(input.payAmount != null ? { payAmount: input.payAmount } : {}),
          ...(input.manualDays !== undefined ? { manualDays: input.manualDays } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.taskId))
        .returning();

      // Outstanding offers are moot: it's booked.
      await db
        .update(schema.taskOffers)
        .set({ status: "withdrawn", respondedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.taskOffers.taskId, input.taskId), eq(schema.taskOffers.status, "pending")));

      // Lock the labour at today's rates, same as any other assignment.
      await lockTaskLabour({ taskId: input.taskId, installerId: input.installerId });

      const span = dates.length === 1 ? sayDate(first) : `${sayDate(first)} → ${sayDate(dates[dates.length - 1]!)}`;
      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "task",
        entityId: input.taskId,
        action: "booked",
        detail: `${task.title} → ${installer.name}, ${dates.length === 1 ? "1 day" : `${dates.length} days`} ${span}${input.overrideNote ? ` (override: ${input.overrideNote})` : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { ...row, dates };
    }),

  /**
   * "It needs another day." One click, one write, on a run that is already
   * booked.
   *
   * This exists instead of re-booking the whole run because the days already on
   * the job carry things worth keeping: a window the customer was told, a day
   * handed to a second installer, a day already marked complete. Rebuilding the
   * run would wipe all of that to add one day to the end of it.
   *
   * Extending walks forward from the last day the same way the panel does,
   * stepping over the weekdays this installer never works, so an extra day on a
   * Friday run lands on Monday rather than Saturday. Trimming takes days off
   * the end and stops at one, since a booking with no days is an unassignment
   * and that is a different button.
   *
   * A clash on the day it adds does not stop it, same rule as everywhere else.
   * The day goes in, the clash comes back in the response, and the board shows
   * it in red.
   */
  extendRun: staffOnly
    .input(
      z.object({
        taskId: z.number(),
        /** Days to add, or negative to take days off the end. */
        by: z.number().int().min(-30).max(30).refine((n) => n !== 0, "Nothing to change"),
        /** Step over the days this installer never works instead of counting them. */
        skipNonWorking: z.boolean().default(true),
        /** Why the office added a day over a clash. Stored on the new days. */
        overrideNote: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [row] = await db
        .select({ task: schema.jobTasks, job: schema.jobs })
        .from(schema.jobTasks)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .where(eq(schema.jobTasks.id, input.taskId));
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      const { task, job } = row;
      if (!task.assignedInstallerId) {
        throw new ORPCError("BAD_REQUEST", { message: "Nothing booked on this one yet, so there is no run to extend." });
      }

      const existing = await db
        .select()
        .from(schema.taskDays)
        .where(eq(schema.taskDays.taskId, input.taskId))
        .orderBy(asc(schema.taskDays.date));
      if (existing.length === 0) {
        throw new ORPCError("BAD_REQUEST", { message: "No days on this booking yet, so there is no run to extend." });
      }

      const [installer] = await db
        .select()
        .from(schema.installers)
        .where(eq(schema.installers.id, task.assignedInstallerId));

      const added: string[] = [];
      const removed: string[] = [];

      if (input.by > 0) {
        const off = input.skipNonWorking ? await nonWorkingWeekdays(task.assignedInstallerId) : [];
        const taken = new Set(existing.map((d) => d.date));
        const last = existing[existing.length - 1]!;
        // The window the run is already running to. A new day on the end keeps
        // the same arrival time as the day before it rather than inventing one.
        const cursor = new Date(`${last.date}T00:00:00`);
        for (let guard = 0; added.length < input.by && guard < 120; guard++) {
          cursor.setDate(cursor.getDate() + 1);
          const date = iso(cursor);
          if (off.includes(cursor.getDay())) continue;
          if (taken.has(date)) continue;
          added.push(date);
        }

        await db.insert(schema.taskDays).values(
          added.map((date, i) => ({
            taskId: input.taskId,
            date,
            seq: existing.length + i + 1,
            arrivalStart: last.coordinate ? null : last.arrivalStart,
            arrivalEnd: last.coordinate ? null : last.arrivalEnd,
            coordinate: last.coordinate,
            // Day-level installer is deliberately not carried over: a day
            // handed to someone else was a one-off, so the extra day goes back
            // to whoever the task belongs to.
            installerId: null,
            status: "booked" as const,
            overrideNote: input.overrideNote ?? null,
          })),
        );
      } else {
        // Never trim the run out of existence, and never trim a day the crew
        // has already done.
        const keepAtLeast = Math.max(1, existing.filter((d) => d.status === "complete").length);
        const canDrop = Math.max(0, existing.length - keepAtLeast);
        const dropping = existing.slice(existing.length - Math.min(-input.by, canDrop));
        if (dropping.length === 0) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              existing.length === 1
                ? "That is the only day on it. Take the installer off instead of trimming it."
                : "The rest of the run is already done, so there is nothing left to trim.",
          });
        }
        await db.delete(schema.taskDays).where(
          inArray(
            schema.taskDays.id,
            dropping.map((d) => d.id),
          ),
        );
        removed.push(...dropping.map((d) => d.date));
      }

      const dates = [...new Set([...existing.map((d) => d.date), ...added])]
        .filter((d) => !removed.includes(d))
        .sort();

      // Re-number so "day 2 of 4" on the installer's phone stays right.
      for (const [i, date] of dates.entries()) {
        await db
          .update(schema.taskDays)
          .set({ seq: i + 1, updatedAt: new Date() })
          .where(and(eq(schema.taskDays.taskId, input.taskId), eq(schema.taskDays.date, date)));
      }

      const [updated] = await db
        .update(schema.jobTasks)
        .set({
          scheduledDate: dates[0]!,
          scheduledFrom: dates[0]!,
          scheduledTo: dates[dates.length - 1]!,
          /**
           * Adding a day by hand is the office overruling the rate book, so the
           * new length sticks. Otherwise a later drag would quietly snap the run
           * back to the number the rates reckon and undo this.
           */
          manualDays: dates.length,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.taskId))
        .returning();

      const checks = added.length
        ? await checkDays({ installerId: task.assignedInstallerId, dates: added, exceptTaskId: input.taskId })
        : [];

      const label = added.length
        ? `+${added.length === 1 ? "1 day" : `${added.length} days`}, now ${dates.length} to ${sayDate(dates[dates.length - 1]!)}`
        : `-${removed.length === 1 ? "1 day" : `${removed.length} days`}, now ${dates.length} to ${sayDate(dates[dates.length - 1]!)}`;
      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "task",
        entityId: input.taskId,
        action: added.length ? "run_extended" : "run_trimmed",
        detail: `${task.title} → ${installer?.name ?? "installer"}, ${label}${input.overrideNote ? ` (override: ${input.overrideNote})` : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return {
        ...updated,
        dates,
        added: checks.map((c) => ({ ...c, label: sayDate(c.date) })),
        removed: removed.map((d) => ({ date: d, label: sayDate(d) })),
        clashCount: checks.reduce((n, c) => n + c.clashes.length, 0),
        unavailableCount: checks.filter((c) => c.status !== "available").length,
        /**
         * A day rate job just got longer, so what Terra pays changed and only a
         * person can decide by how much. Said, never silently adjusted.
         */
        payNeedsLook: task.payType === "day_rate",
        installerName: installer?.name ?? null,
        jobNumber: job.number,
      };
    }),

  unassign: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [existing] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.id));
    if (!existing) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

    // Taking someone off drops the booked days with them.
    await db.delete(schema.taskDays).where(eq(schema.taskDays.taskId, input.id));

    const [row] = await db
      .update(schema.jobTasks)
      .set({ assignedInstallerId: null, secondInstallerId: null, status: "unassigned", updatedAt: new Date() })
      .where(eq(schema.jobTasks.id, input.id))
      .returning();

    await db.insert(schema.activityLog).values({
      jobId: existing.jobId,
      taskId: input.id,
      entityType: "task",
      entityId: input.id,
      action: "unassigned",
      detail: existing.title,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    return row ? taskForStaff(row, context.actor) : row;
  }),

  setStatus: staffOnly
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["unassigned", "offered", "assigned", "in_progress", "complete", "cancelled"]),
      }),
    )
    .handler(async ({ input, context }) => {
      const [existing] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          status: input.status,
          ...(input.status === "in_progress" && !existing.startedAt ? { startedAt: new Date() } : {}),
          ...(input.status === "complete" ? { completedAt: new Date() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.id))
        .returning();

      await db.insert(schema.activityLog).values({
        jobId: existing.jobId,
        taskId: input.id,
        entityType: "task",
        entityId: input.id,
        action: `task_${input.status}`,
        detail: existing.title,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return row ? taskForStaff(row, context.actor) : row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobTasks).where(eq(schema.jobTasks.id, input.id));
    return { ok: true };
  }),

  /* --------------------------- checklists --------------------------- */
  addChecklistItem: staffOnly
    .input(
      z.object({
        taskId: z.number(),
        label: z.string().min(1),
        required: z.boolean().default(false),
        sortOrder: z.number().int().default(0),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db.insert(schema.taskChecklistItems).values(input).returning();
      return row;
    }),

  removeChecklistItem: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.taskChecklistItems).where(eq(schema.taskChecklistItems.id, input.id));
    return { ok: true };
  }),
};
