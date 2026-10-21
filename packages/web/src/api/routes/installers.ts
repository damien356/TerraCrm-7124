import { z } from "zod";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { blockedInstallerIds } from "../lib/availability";
import { mayWorkBetween, slotCols, workSlots } from "../lib/task-run";
import { installerLogoKey, signGet, signPut } from "../lib/s3";
import { taskForStaff } from "../lib/staff-view";
import { abnChangeColumns, abnView, checkInstallerAbn, hideAbnCheck } from "../lib/abn-check";
import { abnDigits } from "../lib/abn-lookup";

/**
 * Skills are TICKS on the installer card (`installer_skills`) with a per-skill
 * rate and a canLead flag. A task only ever goes to installers ticked for that
 * task's skill. Crew capacity is solo / own_offsider / needs_partner, because a
 * 2-man task is either filled by one man who brings his own offsider or by two
 * separate assignments.
 */
export const installers = {
  list: staffOnly
    .input(z.object({ includeInactive: z.boolean().default(false) }).default({ includeInactive: false }))
    .handler(async ({ input, context }) => {
      const isAdmin = context.actor.role === "admin";
      const rows = await db
        .select()
        .from(schema.installers)
        .where(input.includeInactive ? undefined : eq(schema.installers.active, true))
        .orderBy(asc(schema.installers.name));

      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.id);
      const [skillRows, openTasks] = await Promise.all([
        db
          .select({ link: schema.installerSkills, skill: schema.skills })
          .from(schema.installerSkills)
          .innerJoin(schema.skills, eq(schema.skills.id, schema.installerSkills.skillId))
          .where(inArray(schema.installerSkills.installerId, ids)),
        db
          .select({
            installerId: schema.jobTasks.assignedInstallerId,
            count: sql<number>`count(*)`,
          })
          .from(schema.jobTasks)
          .where(inArray(schema.jobTasks.status, ["assigned", "in_progress"]))
          .groupBy(schema.jobTasks.assignedInstallerId),
      ]);

      const taskCounts = new Map(openTasks.map((t) => [t.installerId, Number(t.count)]));

      return rows.map((installer) => ({
        ...(isAdmin ? installer : hideAbnCheck(installer)),
        ...(isAdmin ? {} : { creditLimit: 0, bankAccountName: null, bankBsb: null, bankAccountNumber: null }),
        unavailableDays: safeDays(installer.unavailableDays),
        worksWeekendDays: safeDays(installer.worksWeekendDays),
        skills: skillRows
          .filter((s) => s.link.installerId === installer.id)
          .map((s) => ({
            id: s.link.id,
            skillId: s.link.skillId,
            name: s.skill.name,
            groupName: s.skill.groupName,
            rateType: isAdmin ? s.link.rateType : null,
            rate: isAdmin ? s.link.rate : null,
            canLead: s.link.canLead,
          })),
        openTaskCount: taskCounts.get(installer.id) ?? 0,
      }));
    }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const isAdmin = context.actor.role === "admin";
    const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.id));
    if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });

    const [skillRows, recent, stats, invoiceStats] = await Promise.all([
      db
        .select({ link: schema.installerSkills, skill: schema.skills })
        .from(schema.installerSkills)
        .innerJoin(schema.skills, eq(schema.skills.id, schema.installerSkills.skillId))
        .where(eq(schema.installerSkills.installerId, input.id)),
      db
        .select({ task: schema.jobTasks, job: schema.jobs, site: schema.sites })
        .from(schema.jobTasks)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(eq(schema.jobTasks.assignedInstallerId, input.id))
        .orderBy(sql`${schema.jobTasks.scheduledDate} desc`)
        .limit(25),
      db
        .select({
          completed: sql<number>`sum(case when ${schema.jobTasks.status} = 'complete' then 1 else 0 end)`,
          total: sql<number>`count(*)`,
          pay: sql<number>`sum(coalesce(${schema.jobTasks.payAmount}, 0))`,
        })
        .from(schema.jobTasks)
        .where(eq(schema.jobTasks.assignedInstallerId, input.id)),
      /*
       * Invoice numbering belongs to the contractor, so the office sets the
       * starting number once. After he has raised one, the number is his own
       * running sequence and we only report it, never reset it.
       */
      db
        .select({
          count: sql<number>`count(*)`,
          lastNumber: sql<number>`max(${schema.installerInvoices.invoiceNumber})`,
        })
        .from(schema.installerInvoices)
        .where(eq(schema.installerInvoices.installerId, input.id)),
    ]);

    return {
      installer: {
        ...(isAdmin ? installer : hideAbnCheck(installer)),
        unavailableDays: safeDays(installer.unavailableDays),
        worksWeekendDays: safeDays(installer.worksWeekendDays),
        ...(isAdmin ? {} : { creditLimit: 0, bankAccountName: null, bankBsb: null, bankAccountNumber: null }),
      },
      /** Notes 18.64: the ABN check. Admin only, null for Office. */
      abnCheck: isAdmin ? abnView(installer) : null,
      invoicing: {
        raised: Number(invoiceStats[0]?.count ?? 0),
        lastNumber: invoiceStats[0]?.lastNumber ?? null,
        /* Short-lived read link so the office can eyeball the logo it uploaded. */
        logoViewUrl: installer.logoUrl ? await signGet(installer.logoUrl) : null,
      },
      skills: skillRows.map((s) => ({
        id: s.link.id,
        skillId: s.link.skillId,
        name: s.skill.name,
        groupName: s.skill.groupName,
        rateType: isAdmin ? s.link.rateType : null,
        rate: isAdmin ? s.link.rate : null,
        canLead: s.link.canLead,
      })),
      recentTasks: recent.map((r) => ({ ...r, task: taskForStaff(r.task, context.actor) })),
      stats: {
        completed: Number(stats[0]?.completed ?? 0),
        total: Number(stats[0]?.total ?? 0),
        payTotal: Number(stats[0]?.pay ?? 0),
      },
    };
  }),

  create: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        fullName: z.string().nullable().optional(),
        mobile: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        crewCapacity: z.enum(["solo", "own_offsider", "needs_partner"]).default("solo"),
        serviceArea: z.string().nullable().optional(),
        abn: z.string().nullable().optional(),
        colour: z.string().default("#4A7FA5"),
        notes: z.string().nullable().optional(),
        starRating: z.number().int().min(1).max(5).default(3),
        creditLimit: z.number().min(0).default(0),
      }),
    )
    .handler(async ({ input }) => {
      const [row] = await db
        .insert(schema.installers)
        .values({ ...input, fullName: input.fullName?.trim() || null, ...abnChangeColumns(input.abn) })
        .returning();
      // Notes 18.64: an ABN typed on a new card is looked up straight away.
      if (row && abnDigits(row.abn)) return (await checkInstallerAbn(row.id)) ? (await reread(row.id)) ?? row : row;
      return row;
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().trim().min(1, "His short name can't be empty.").optional(),
        /** Notes 18.66: his full legal name, for the ABN check and bills. */
        fullName: z.string().nullable().optional(),
        mobile: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        crewCapacity: z.enum(["solo", "own_offsider", "needs_partner"]).optional(),
        serviceArea: z.string().nullable().optional(),
        unavailableDays: z.array(z.number().int().min(0).max(6)).optional(),
        /** Weekend days he does work, 0 Sun and 6 Sat. Weekends are off otherwise. */
        worksWeekendDays: z.array(z.union([z.literal(0), z.literal(6)])).optional(),
        abn: z.string().nullable().optional(),
        insuranceExpiry: z.date().nullable().optional(),
        licenceExpiry: z.date().nullable().optional(),
        colour: z.string().optional(),
        notes: z.string().nullable().optional(),
        active: z.boolean().optional(),
        starRating: z.number().int().min(1).max(5).optional(),
        creditLimit: z.number().min(0).optional(),
        tradingName: z.string().nullable().optional(),
        /** Notes 18.64: GST comes from the ABN lookup. Only accepted when it is no change. */
        gstRegistered: z.boolean().optional(),
        businessAddress: z.string().nullable().optional(),
        invoiceEmail: z.string().nullable().optional(),
        logoUrl: z.string().nullable().optional(),
        bankAccountName: z.string().nullable().optional(),
        bankBsb: z.string().nullable().optional(),
        bankAccountNumber: z.string().nullable().optional(),
        nextInvoiceNumber: z.number().int().min(1).nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, unavailableDays, worksWeekendDays, gstRegistered, ...rest } = input;
      const [current] = await db.select().from(schema.installers).where(eq(schema.installers.id, id));
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
      if (gstRegistered !== undefined && gstRegistered !== current.gstRegistered) {
        throw new ORPCError("BAD_REQUEST", { message: "GST is set by the ABN lookup only. It can't be changed by hand." });
      }
      // Notes 18.64: a new ABN clears the old lookup and is looked up again below.
      const abnChanged = rest.abn !== undefined && abnDigits(rest.abn) !== abnDigits(current.abn);
      const [updated] = await db
        .update(schema.installers)
        .set({
          ...rest,
          ...(rest.fullName !== undefined ? { fullName: rest.fullName?.trim() || null } : {}),
          ...(abnChanged ? abnChangeColumns(rest.abn) : rest.abn !== undefined ? { abn: current.abn } : {}),
          ...(unavailableDays ? { unavailableDays: JSON.stringify(unavailableDays) } : {}),
          ...(worksWeekendDays ? { worksWeekendDays: JSON.stringify([...new Set(worksWeekendDays)].sort()) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.installers.id, id))
        .returning();
      if (!updated) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
      const row = abnChanged && abnDigits(updated.abn) && (await checkInstallerAbn(id)) ? ((await reread(id)) ?? updated) : updated;
      // One person, one record: name, phone and email live on the login too.
      const sync = {
        ...(rest.name !== undefined ? { name: rest.name } : {}),
        ...(rest.mobile !== undefined ? { phone: rest.mobile } : {}),
        ...(rest.email != null ? { email: rest.email } : {}),
      };
      if (Object.keys(sync).length) {
        await db.update(schema.profiles).set({ ...sync, updatedAt: new Date() }).where(eq(schema.profiles.installerId, id));
      }
      return row;
    }),

  /**
   * A presigned slot for an installer's business logo, uploaded by the office.
   * Most of these blokes will never upload their own, so the office does it
   * off whatever they emailed through. Same storage key the app would use.
   */
  presignLogo: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        filename: z.string().min(1),
        contentType: z.string().min(1),
      }),
    )
    .handler(async ({ input }) => {
      const key = installerLogoKey(input.installerId, input.filename);
      const url = await signPut(key, input.contentType);
      return { url, key };
    }),

  /** Tick or untick a skill, and set the rate for it. */
  setSkill: adminOnly
    .input(
      z.object({
        installerId: z.number(),
        skillId: z.number(),
        enabled: z.boolean(),
        rateType: z.enum(["per_m2", "hourly", "per_job", "day_rate"]).default("per_m2"),
        rate: z.number().nullable().optional(),
        canLead: z.boolean().default(true),
      }),
    )
    .handler(async ({ input }) => {
      if (!input.enabled) {
        await db
          .delete(schema.installerSkills)
          .where(
            and(
              eq(schema.installerSkills.installerId, input.installerId),
              eq(schema.installerSkills.skillId, input.skillId),
            ),
          );
        return { ok: true, enabled: false };
      }

      await db
        .insert(schema.installerSkills)
        .values({
          installerId: input.installerId,
          skillId: input.skillId,
          rateType: input.rateType,
          rate: input.rate ?? null,
          canLead: input.canLead,
        })
        .onConflictDoUpdate({
          target: [schema.installerSkills.installerId, schema.installerSkills.skillId],
          set: {
            rateType: input.rateType,
            rate: input.rate ?? null,
            canLead: input.canLead,
            updatedAt: new Date(),
          },
        });
      return { ok: true, enabled: true };
    }),

  /** Who can legitimately be offered this skill, used by the dispatch pickers. */
  eligible: staffOnly
    .input(z.object({ skillId: z.number(), date: z.string().optional(), crewSize: z.number().default(1) }))
    .handler(async ({ input, context }) => {
      // Installer rates are Admin only. Office books the person, not the price.
      const isAdmin = context.actor.role === "admin";
      const rows = await db
        .select({ installer: schema.installers, link: schema.installerSkills })
        .from(schema.installerSkills)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.installerSkills.installerId))
        .where(and(eq(schema.installerSkills.skillId, input.skillId), eq(schema.installers.active, true)))
        .orderBy(asc(schema.installers.name));

      // Busy means working that Brisbane date on any day of a run, not only on
      // the task's first date. A schedule nobody can read counts as maybe busy.
      const slots = input.date
        ? await workSlots(
            await db
              .select(slotCols)
              .from(schema.jobTasks)
              .where(and(inArray(schema.jobTasks.status, ["assigned", "in_progress"]), mayWorkBetween(input.date, input.date))),
            input.date,
            input.date,
          )
        : [];
      const busy = new Set(slots.map((c) => c.installerId));
      const sureBusy = new Set(slots.filter((c) => !c.incomplete).map((c) => c.installerId));
      // Blackout dates and standing rules, both resolved server-side.
      const blocked = input.date ? await blockedInstallerIds(input.date) : new Set<number>();

      return rows.map((r) => {
        const off = blocked.has(r.installer.id);
        return {
          id: r.installer.id,
          name: r.installer.name,
          mobile: r.installer.mobile,
          colour: r.installer.colour,
          crewCapacity: r.installer.crewCapacity,
          starRating: r.installer.starRating,
          rateType: isAdmin ? r.link.rateType : null,
          rate: isAdmin ? r.link.rate : null,
          canLead: r.link.canLead,
          busyThatDay: busy.has(r.installer.id),
          /** Busy only because a schedule cannot be read, so it might be free. */
          busyScheduleIncomplete: busy.has(r.installer.id) && !sureBusy.has(r.installer.id),
          unavailableThatDay: off,
          /** A needs_partner installer can't cover a 2-man task on their own. */
          canCoverAlone: input.crewSize < 2 || r.installer.crewCapacity === "own_offsider",
        };
      });
    }),

  /** Compliance watchlist: insurance or licence expiring inside 60 days. */
  expiring: staffOnly.handler(async () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 60);
    const rows = await db
      .select()
      .from(schema.installers)
      .where(and(eq(schema.installers.active, true), lte(schema.installers.insuranceExpiry, soon)));
    return rows.map((r) => ({ id: r.id, name: r.name, insuranceExpiry: r.insuranceExpiry }));
  }),

  /**
   * Availability heat for the week: how many tasks each installer holds per
   * Brisbane day. Every working day of a run counts, and the second installer
   * and a day's cover count too. Hours are the task's day hours. A day only a
   * schedule nobody can read puts there is counted in `incomplete`.
   */
  load: staffOnly
    .input(z.object({ from: z.string(), to: z.string() }))
    .handler(async ({ input }) => {
      const tasks = await db
        .select({ ...slotCols, hours: schema.jobTasks.durationHours })
        .from(schema.jobTasks)
        .where(
          and(
            inArray(schema.jobTasks.status, ["assigned", "in_progress", "complete"]),
            mayWorkBetween(input.from, input.to),
          ),
        );
      const hoursOf = new Map(tasks.map((t) => [t.id, Number(t.hours ?? 0)]));
      const cells = new Map<string, { installerId: number; date: string; hours: number; tasks: number; incomplete: number }>();
      for (const sl of await workSlots(tasks, input.from, input.to)) {
        const key = `${sl.installerId}|${sl.date}`;
        const c = cells.get(key) ?? { installerId: sl.installerId, date: sl.date, hours: 0, tasks: 0, incomplete: 0 };
        c.tasks += 1;
        c.hours += hoursOf.get(sl.taskId) ?? 0;
        if (sl.incomplete) c.incomplete += 1;
        cells.set(key, c);
      }
      return [...cells.values()];
    }),
};

function safeDays(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

async function reread(id: number) {
  const [row] = await db.select().from(schema.installers).where(eq(schema.installers.id, id));
  return row ?? null;
}
