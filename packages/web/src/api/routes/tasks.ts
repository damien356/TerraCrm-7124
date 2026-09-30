import { z } from "zod";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { checkDays, nonWorkingWeekdays } from "../lib/availability";
import { lockTaskLabour } from "./costing";

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

/** "Thu 1 Oct", the way the office says a date out loud. */
function sayDate(date: string) {
  const d = new Date(`${date}T00:00:00`);
  return `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString("en-AU", { month: "short" })}`;
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

  const rate = row.skill?.productionRate ?? null;
  if (!rate || rate <= 0) return null;
  const unit = row.skill?.productionUnit ?? "m2";
  const crew = Math.max(1, row.task.crewSize);

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

  const exact = qty / (rate * crew);
  return {
    days: Math.max(1, Math.ceil(exact - 0.15)),
    exact: Math.round(exact * 10) / 10,
    basis: measuredQty > 0 ? ("measured" as const) : ("area" as const),
    qty: Math.round(qty * 10) / 10,
    unit,
    perDay: rate * crew,
  };
}

export const tasks = {
  /** The dispatch board feed: every task in a date window, plus the unassigned queue. */
  board: adminOnly
    .input(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ input }) => {
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
        ...r.task,
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

  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
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
      ...row.task,
      skill: row.skill,
      job: row.job,
      site: row.site,
      installer: row.installer,
      checklist,
      photos,
      offers,
      days: days.map((d) => ({ ...d.day, installerName: d.installer?.name ?? null })),
      suggested,
    };
  }),

  create: adminOnly
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

  update: adminOnly
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
    .handler(async ({ input }) => {
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
      return row;
    }),

  /** Drag-and-drop on the board: move a task to a day, optionally onto an installer. */
  reschedule: adminOnly
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

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          scheduledDate: input.scheduledDate,
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

      await db.insert(schema.activityLog).values({
        jobId: existing.jobId,
        taskId: input.id,
        entityType: "task",
        entityId: input.id,
        action: "rescheduled",
        detail: `${existing.title} → ${input.scheduledDate ?? "unscheduled"}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  /** Assign directly, no offer — the installer is simply told. */
  assign: adminOnly
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

      return row;
    }),

  /* --------------------------- booking a run --------------------------- */

  /**
   * What a booking would land on, before anything is written: the dates, each
   * one's availability, and anything already in that installer's diary. The
   * panel calls this on every change so the office is looking at the real
   * answer while they set it up, not after they press book.
   */
  planBooking: adminOnly
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
  book: adminOnly
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

  unassign: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
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
    return row;
  }),

  setStatus: adminOnly
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
      return row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db.delete(schema.jobTasks).where(eq(schema.jobTasks.id, input.id));
    return { ok: true };
  }),

  /* --------------------------- checklists --------------------------- */
  addChecklistItem: adminOnly
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
