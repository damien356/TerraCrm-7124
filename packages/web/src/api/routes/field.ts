import { jobNumberSql } from "../lib/job-ref";
import { syncJobForTask } from "../lib/job-stage";
import { z } from "zod";
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { installerOnly } from "../middleware/auth";
import { pushToOffice } from "../lib/push";
import { signMany } from "../lib/s3";
import { acceptOffer, declineOffer, expireStale, releaseTask } from "./offers";
import { addLocalDays, todayLocal } from "../lib/local-date";
import { taskIdsOn } from "../lib/crew-days";
import { completionPhotosOn, minCompletionPhotos, recheckPhotoFlags } from "../lib/site-visits";
import { assertSwmsDone, swmsNeededFor } from "../lib/swms";
import { crewPeopleFor } from "../lib/crew-people";

/**
 * THE INSTALLER API. Every single query here filters by `context.installerId`.
 *
 * Installers may see: their own tasks, the address, access notes, the scope,
 * the materials, the people the office ticked Show to Crew on the job (name,
 * phone, tags on that job, note), and THEIR OWN pay.
 * Installers must NEVER see: customer pricing, margins, quotes, invoices,
 * supplier costs, or any other installer's tasks or rates. That is enforced
 * here on the server — never in the UI.
 */

/** The cut-down task card. Deliberately hand-picked columns — no job.value, no quotes. */
async function taskCardsFor(installerId: number, where: ReturnType<typeof and>[]) {
  const rows = await db
    .select({
      id: schema.jobTasks.id,
      jobId: schema.jobTasks.jobId,
      title: schema.jobTasks.title,
      description: schema.jobTasks.description,
      areaM2: schema.jobTasks.areaM2,
      scheduledDate: schema.jobTasks.scheduledDate,
      startTime: schema.jobTasks.startTime,
      durationHours: schema.jobTasks.durationHours,
      crewSize: schema.jobTasks.crewSize,
      status: schema.jobTasks.status,
      payType: schema.jobTasks.payType,
      payAmount: schema.jobTasks.payAmount,
      startedAt: schema.jobTasks.startedAt,
      completedAt: schema.jobTasks.completedAt,
      isSecond: sql<number>`case when ${schema.jobTasks.secondInstallerId} = ${installerId} then 1 else 0 end`,
      skillName: schema.skills.name,
      skillGroup: schema.skills.groupName,
      jobNumber: jobNumberSql,
      jobTitle: schema.jobs.title,
      furnitureOnSite: schema.jobs.furnitureOnSite,
      jobAccessNotes: schema.jobs.accessNotes,
      siteAddress: schema.sites.address,
      siteSuburb: schema.sites.suburb,
      sitePostcode: schema.sites.postcode,
      siteAccessNotes: schema.sites.accessNotes,
      propertyType: schema.sites.propertyType,
      labourBreakdown: schema.jobTasks.labourBreakdown,
    })
    .from(schema.jobTasks)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(and(...where))
    .orderBy(asc(schema.jobTasks.scheduledDate), asc(schema.jobTasks.startTime));

  if (rows.length === 0) return [];

  // Crew sees only the Site access and Decision-maker people (lib/crew-people.ts).
  const jobIds = [...new Set(rows.map((r) => r.jobId))];
  const people = await crewPeopleFor(jobIds);
  // SWMS: required on the job, and whether I've signed today's.
  const swms = await swmsNeededFor(installerId, jobIds);

  return rows.map((r) => {
    let payBreakdown: Array<{ name: string; unit: string; qty: number; rate: number | null; total: number | null }> | null =
      null;
    if (r.labourBreakdown) {
      try {
        const parsed = JSON.parse(r.labourBreakdown) as Array<{
          name: string;
          unit: string;
          qty: number;
          rate: number | null;
          total: number | null;
        }>;
        payBreakdown = parsed.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty, rate: l.rate, total: l.total }));
      } catch {
        payBreakdown = null;
      }
    }
    const { labourBreakdown: _labourBreakdown, ...rest } = r;
    return {
      ...rest,
      isSecond: Number(r.isSecond) === 1,
      payBreakdown,
      swmsRequired: swms.get(r.jobId)?.required ?? false,
      swmsSignedToday: swms.get(r.jobId)?.signedToday ?? false,
      contacts: people.get(r.jobId) ?? [],
    };
  });
}

/** The original job a callback hangs off, or null for an ordinary job. */
async function parentJobOf(jobId: number) {
  const [j] = await db.select({ parentJobId: schema.jobs.parentJobId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return j?.parentJobId ?? null;
}

/** Guarantees the task belongs to this installer before any write. */
export async function ownTaskOrThrow(taskId: number, installerId: number) {
  const [task] = await db
    .select()
    .from(schema.jobTasks)
    .where(
      and(
        eq(schema.jobTasks.id, taskId),
        sql`(${schema.jobTasks.assignedInstallerId} = ${installerId} or ${schema.jobTasks.secondInstallerId} = ${installerId})`,
      ),
    );
  if (!task) throw new ORPCError("FORBIDDEN", { message: "That task isn't yours." });
  return task;
}

/** Buckets the crew may add to. Plans are office-only — they can look, not upload. */
const CREW_BUCKETS = ["access", "area", "damage", "found", "completion", "defect"] as const;

async function countMedia(taskId: number, bucket: string) {
  const rows = await db
    .select({ id: schema.jobMedia.id })
    .from(schema.jobMedia)
    .where(
      and(
        eq(schema.jobMedia.taskId, taskId),
        eq(schema.jobMedia.bucket, bucket),
        sql`${schema.jobMedia.archivedAt} is null`,
      ),
    );
  return rows.length;
}

export const field = {
  /** Who am I, plus my own skills and rates — never anyone else's. */
  me: installerOnly.handler(async ({ context }) => {
    const [installer] = await db
      .select()
      .from(schema.installers)
      .where(eq(schema.installers.id, context.installerId));
    if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer record not found" });

    const [skills, stats] = await Promise.all([
      db
        .select({ link: schema.installerSkills, skill: schema.skills })
        .from(schema.installerSkills)
        .innerJoin(schema.skills, eq(schema.skills.id, schema.installerSkills.skillId))
        .where(eq(schema.installerSkills.installerId, context.installerId)),
      db
        .select({
          completed: sql<number>`sum(case when ${schema.jobTasks.status} = 'complete' then 1 else 0 end)`,
          upcoming: sql<number>`sum(case when ${schema.jobTasks.status} in ('assigned','in_progress') then 1 else 0 end)`,
          earned: sql<number>`sum(case when ${schema.jobTasks.status} = 'complete' then coalesce(${schema.jobTasks.payAmount}, 0) else 0 end)`,
        })
        .from(schema.jobTasks)
        .where(eq(schema.jobTasks.assignedInstallerId, context.installerId)),
    ]);

    return {
      id: installer.id,
      name: installer.name,
      mobile: installer.mobile,
      email: installer.email,
      crewCapacity: installer.crewCapacity,
      serviceArea: installer.serviceArea,
      insuranceExpiry: installer.insuranceExpiry,
      licenceExpiry: installer.licenceExpiry,
      locationConsentAt: installer.locationConsentAt,
      skills: skills.map((s) => ({
        name: s.skill.name,
        groupName: s.skill.groupName,
        rateType: s.link.rateType,
        rate: s.link.rate,
        canLead: s.link.canLead,
      })),
      stats: {
        completed: Number(stats[0]?.completed ?? 0),
        upcoming: Number(stats[0]?.upcoming ?? 0),
        earned: Number(stats[0]?.earned ?? 0),
      },
    };
  }),

  /** Today's work. */
  today: installerOnly.handler(async ({ context }) => {
    /* Gold Coast date, not UTC, or before 10 am "today" is yesterday. And a
     * multi-day run shows on every one of its days, not only day one. */
    const ids = await taskIdsOn(context.installerId, todayLocal(), ["assigned", "in_progress", "complete"]);
    if (ids.length === 0) return [];
    return taskCardsFor(context.installerId, [
      sql`(${schema.jobTasks.assignedInstallerId} = ${context.installerId} or ${schema.jobTasks.secondInstallerId} = ${context.installerId})`,
      inArray(schema.jobTasks.id, ids),
      inArray(schema.jobTasks.status, ["assigned", "in_progress", "complete"]),
    ]);
  }),

  /** My upcoming schedule. */
  upcoming: installerOnly
    .input(z.object({ from: z.string().optional(), to: z.string().optional() }).default({}))
    .handler(async ({ input, context }) => {
      const from = input.from ?? todayLocal();
      const to = input.to ?? addLocalDays(todayLocal(), 28);
      return taskCardsFor(context.installerId, [
        sql`(${schema.jobTasks.assignedInstallerId} = ${context.installerId} or ${schema.jobTasks.secondInstallerId} = ${context.installerId})`,
        isNotNull(schema.jobTasks.scheduledDate),
        gte(schema.jobTasks.scheduledDate, from),
        lte(schema.jobTasks.scheduledDate, to),
        inArray(schema.jobTasks.status, ["assigned", "in_progress"]),
      ]);
    }),

  /** Finished work — my history and what I earned on it. */
  history: installerOnly.handler(async ({ context }) => {
    const rows = await db
      .select({
        id: schema.jobTasks.id,
        title: schema.jobTasks.title,
        scheduledDate: schema.jobTasks.scheduledDate,
        completedAt: schema.jobTasks.completedAt,
        payAmount: schema.jobTasks.payAmount,
        jobNumber: jobNumberSql,
        siteSuburb: schema.sites.suburb,
        labourBreakdown: schema.jobTasks.labourBreakdown,
      })
      .from(schema.jobTasks)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(
        and(eq(schema.jobTasks.assignedInstallerId, context.installerId), eq(schema.jobTasks.status, "complete")),
      )
      .orderBy(desc(schema.jobTasks.completedAt))
      .limit(50);
    return rows.map((r) => {
      let payBreakdown: Array<{ name: string; unit: string; qty: number; rate: number | null; total: number | null }> | null =
        null;
      if (r.labourBreakdown) {
        try {
          const parsed = JSON.parse(r.labourBreakdown) as Array<{
            name: string;
            unit: string;
            qty: number;
            rate: number | null;
            total: number | null;
          }>;
          payBreakdown = parsed.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty, rate: l.rate, total: l.total }));
        } catch {
          payBreakdown = null;
        }
      }
      const { labourBreakdown: _labourBreakdown, ...rest } = r;
      return { ...rest, payBreakdown };
    });
  }),

  /** One task card, with checklist, materials and photos. */
  task: installerOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.id, context.installerId);
    const [card] = await taskCardsFor(context.installerId, [eq(schema.jobTasks.id, input.id)]);
    if (!card) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

    const [checklist, materials, photos, mate] = await Promise.all([
      db
        .select()
        .from(schema.taskChecklistItems)
        .where(eq(schema.taskChecklistItems.taskId, input.id))
        .orderBy(asc(schema.taskChecklistItems.sortOrder)),
      // Materials only — description, qty, unit. No costs, ever.
      db
        .select({
          id: schema.jobMaterials.id,
          description: schema.jobMaterials.description,
          qty: schema.jobMaterials.qty,
          unit: schema.jobMaterials.unit,
          status: schema.jobMaterials.status,
        })
        .from(schema.jobMaterials)
        .where(eq(schema.jobMaterials.jobId, card.jobId)),
      db.select().from(schema.taskPhotos).where(eq(schema.taskPhotos.taskId, input.id)),
      // Who else is on this task with me — name only, no rate.
      db
        .select({ name: schema.installers.name, mobile: schema.installers.mobile })
        .from(schema.jobTasks)
        .innerJoin(
          schema.installers,
          sql`${schema.installers.id} = case when ${schema.jobTasks.assignedInstallerId} = ${context.installerId} then ${schema.jobTasks.secondInstallerId} else ${schema.jobTasks.assignedInstallerId} end`,
        )
        .where(eq(schema.jobTasks.id, input.id)),
    ]);

    // My own pay breakdown, frozen at assignment. Never anyone else's rate,
    // never a sell price or margin, just what this task's lines pay me.
    const [taskRow] = await db
      .select({ labourCost: schema.jobTasks.labourCost, labourBreakdown: schema.jobTasks.labourBreakdown })
      .from(schema.jobTasks)
      .where(eq(schema.jobTasks.id, input.id));

    let payBreakdown: Array<{ name: string; unit: string; qty: number; rate: number | null; total: number | null }> | null =
      null;
    if (taskRow?.labourBreakdown) {
      try {
        const parsed = JSON.parse(taskRow.labourBreakdown) as Array<{
          name: string;
          unit: string;
          qty: number;
          rate: number | null;
          total: number | null;
        }>;
        payBreakdown = parsed.map((l) => ({ name: l.name, unit: l.unit, qty: l.qty, rate: l.rate, total: l.total }));
      } catch {
        payBreakdown = null;
      }
    }

    // A callback shows the original job's products too, read only, so the
    // crew knows exactly what went down. Never the cause or who pays.
    const parentId = await parentJobOf(card.jobId);
    const originalMaterials = parentId
      ? await db
          .select({
            id: schema.jobMaterials.id,
            description: schema.jobMaterials.description,
            qty: schema.jobMaterials.qty,
            unit: schema.jobMaterials.unit,
            status: schema.jobMaterials.status,
          })
          .from(schema.jobMaterials)
          .where(eq(schema.jobMaterials.jobId, parentId))
      : [];

    return {
      ...card,
      isCallback: Boolean(parentId),
      checklist,
      materials: [...materials.map((m) => ({ ...m, original: false })), ...originalMaterials.map((m) => ({ ...m, original: true }))],
      photos,
      crewMate: mate[0] ?? null,
      payBreakdown,
      payTotalExGst: taskRow?.labourCost ?? null,
    };
  }),

  /* ----------------------------- offers ----------------------------- */

  /**
   * Offers waiting on me, with the pay shown up front.
   *
   * An offer goes out to several installers at once, so it is deliberately
   * anonymous: everything needed to price the work, nothing that identifies
   * the customer. Suburb only, never the street address, and no contact names
   * or numbers. Both unlock on the task card the moment the job is theirs.
   */
  offers: installerOnly.handler(async ({ context }) => {
    await expireStale();
    const rows = await db
      .select({
        offerId: schema.taskOffers.id,
        mode: schema.taskOffers.mode,
        status: schema.taskOffers.status,
        provisionalUntil: schema.taskOffers.provisionalUntil,
        chosenDate: schema.taskOffers.chosenDate,
        payAmount: schema.taskOffers.payAmount,
        sentAt: schema.taskOffers.sentAt,
        expiresAt: schema.taskOffers.expiresAt,
        taskId: schema.jobTasks.id,
        title: schema.jobTasks.title,
        description: schema.jobTasks.description,
        areaM2: schema.jobTasks.areaM2,
        scheduledDate: schema.jobTasks.scheduledDate,
        scheduledFrom: schema.jobTasks.scheduledFrom,
        scheduledTo: schema.jobTasks.scheduledTo,
        startTime: schema.jobTasks.startTime,
        durationHours: schema.jobTasks.durationHours,
        crewSize: schema.jobTasks.crewSize,
        payType: schema.jobTasks.payType,
        skillName: schema.skills.name,
        skillGroup: schema.skills.groupName,
        jobNumber: jobNumberSql,
        furnitureOnSite: schema.jobs.furnitureOnSite,
        // Suburb and property type only. The street address stays out of the
        // payload, not just out of the UI.
        siteSuburb: schema.sites.suburb,
        siteState: schema.sites.state,
        propertyType: schema.sites.propertyType,
      })
      .from(schema.taskOffers)
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
      .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(
        and(
          eq(schema.taskOffers.installerId, context.installerId),
          // Provisional holds stay on the list so they can see they're holding it.
          inArray(schema.taskOffers.status, ["pending", "provisional"]),
        ),
      )
      .orderBy(asc(schema.taskOffers.expiresAt));
    return rows;
  }),

  /** Accepting picks a day out of the task's window when there is one. */
  accept: installerOnly
    .input(z.object({ offerId: z.number(), chosenDate: z.string().nullable().optional() }))
    .handler(({ input, context }) => acceptOffer(input.offerId, context.installerId, input.chosenDate ?? null)),

  /** Declining is always allowed, but the reason is mandatory. */
  decline: installerOnly
    .input(z.object({ offerId: z.number(), reason: z.string().min(3, "Give a reason so the office knows why.") }))
    .handler(({ input, context }) => declineOffer(input.offerId, context.installerId, input.reason)),

  /** Hand back a task I'd already accepted — reason mandatory, office gets told. */
  release: installerOnly
    .input(z.object({ taskId: z.number(), reason: z.string().min(3, "Give a reason so the office knows why.") }))
    .handler(({ input, context }) => releaseTask(input.taskId, context.installerId, input.reason)),

  /* ---------------------------- on the job --------------------------- */

  start: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);

    // SWMS first, when the job needs one. Geofence arrival still stamps
    // Arrived, but nobody starts work until today's SWMS is signed.
    await assertSwmsDone(task.jobId, context.installerId, "start");

    // Pre-start damage walk. Either photos of what's already wrong, or an
    // explicit "nothing found". Without one of those the job can't start —
    // this is the bit that wins the argument three weeks later.
    if (!task.damageCheckedAt && !task.damageNone) {
      const damage = await countMedia(input.taskId, "damage");
      if (damage === 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Walk the site first — add any existing damage, or tick 'nothing found'.",
        });
      }
      await db
        .update(schema.jobTasks)
        .set({ damageCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, input.taskId));
    }

    const [row] = await db
      .update(schema.jobTasks)
      .set({ status: "in_progress", startedAt: task.startedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(schema.jobTasks.id, input.taskId))
      .returning({ id: schema.jobTasks.id, status: schema.jobTasks.status });

    const [installer] = await db
      .select({ name: schema.installers.name })
      .from(schema.installers)
      .where(eq(schema.installers.id, context.installerId));
    await db.insert(schema.activityLog).values({
      jobId: task.jobId,
      taskId: input.taskId,
      entityType: "task",
      entityId: input.taskId,
      action: "task_started",
      detail: `${installer?.name ?? "Installer"} started "${task.title}"`,
      actorName: installer?.name ?? "Installer",
      actorRole: "installer",
    });
    await syncJobForTask(input.taskId, { name: installer?.name ?? "Installer", role: "installer" });
    return row;
  }),

  complete: installerOnly
    .input(z.object({ taskId: z.number(), signatureName: z.string().nullable().optional(), notes: z.string().nullable().optional() }))
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      await assertSwmsDone(task.jobId, context.installerId, "finish");

      const required = await db
        .select()
        .from(schema.taskChecklistItems)
        .where(and(eq(schema.taskChecklistItems.taskId, input.taskId), eq(schema.taskChecklistItems.required, true)));
      const outstanding = required.filter((r) => !r.done);
      if (outstanding.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Still to tick off: ${outstanding.map((o) => o.label).join(", ")}`,
        });
      }

      // Completion photos are not optional.
      const need = await minCompletionPhotos(task.skillId);
      const have = await countMedia(input.taskId, "completion");
      if (have < need) {
        throw new ORPCError("BAD_REQUEST", {
          message: `${need} completion photos needed before you can close this one — you've added ${have}.`,
        });
      }

      const [row] = await db
        .update(schema.jobTasks)
        .set({
          status: "complete",
          completedAt: new Date(),
          signatureName: input.signatureName ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.jobTasks.id, input.taskId))
        .returning({ id: schema.jobTasks.id, status: schema.jobTasks.status });

      const [installer] = await db
        .select({ name: schema.installers.name })
        .from(schema.installers)
        .where(eq(schema.installers.id, context.installerId));

      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "task",
        entityId: input.taskId,
        action: "task_complete",
        detail: `${installer?.name ?? "Installer"} finished "${task.title}"${input.notes ? ` — ${input.notes}` : ""}`,
        actorName: installer?.name ?? "Installer",
        actorRole: "installer",
      });

      void pushToOffice({
        title: "Task finished",
        body: `${installer?.name ?? "Installer"} finished "${task.title}"`,
        data: { kind: "task", taskId: input.taskId, jobId: task.jobId },
      });

      // If that was the last task, flag the job as ready for the office.
      const remaining = await db
        .select({ id: schema.jobTasks.id })
        .from(schema.jobTasks)
        .where(
          and(
            eq(schema.jobTasks.jobId, task.jobId),
            inArray(schema.jobTasks.status, ["unassigned", "offered", "assigned", "in_progress"]),
          ),
        );
      if (remaining.length === 0) {
        await db
          .update(schema.jobs)
          .set({ completedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.jobs.id, task.jobId));
        await db.insert(schema.activityLog).values({
          jobId: task.jobId,
          entityType: "job",
          entityId: task.jobId,
          action: "all_tasks_complete",
          detail: "Every task on this job is finished — ready to invoice",
          actorName: "System",
          actorRole: "system",
        });
        void pushToOffice({
          title: "Job ready to invoice",
          body: `Every task on job ${task.jobId} is finished.`,
          data: { kind: "job", jobId: task.jobId },
        });
      }
      await syncJobForTask(input.taskId, { name: installer?.name ?? "Installer", role: "installer" });

      return row;
    }),

  tickChecklistItem: installerOnly
    .input(z.object({ id: z.number(), done: z.boolean() }))
    .handler(async ({ input, context }) => {
      const [item] = await db
        .select()
        .from(schema.taskChecklistItems)
        .where(eq(schema.taskChecklistItems.id, input.id));
      if (!item) throw new ORPCError("NOT_FOUND", { message: "Checklist item not found" });
      await ownTaskOrThrow(item.taskId, context.installerId);

      const [row] = await db
        .update(schema.taskChecklistItems)
        .set({ done: input.done, doneAt: input.done ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.taskChecklistItems.id, input.id))
        .returning();
      return row;
    }),

  addPhoto: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        url: z.string().min(1),
        storageKey: z.string().nullable().optional(),
        kind: z.enum(["before", "during", "after", "issue", "measure"]).default("during"),
        caption: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const [row] = await db
        .insert(schema.taskPhotos)
        .values({ ...input, jobId: task.jobId, installerId: context.installerId })
        .returning();
      return row;
    }),

  /* ----------------------------- the job file ------------------------ */

  /**
   * Plans, site access, areas, damage, what we found, completion, defects.
   * Named buckets, never a loose diary feed. No pricing lives here.
   */
  jobFile: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);

    const [areas, mediaRows] = await Promise.all([
      db
        .select()
        .from(schema.jobAreas)
        .where(eq(schema.jobAreas.jobId, task.jobId))
        .orderBy(asc(schema.jobAreas.sortOrder), asc(schema.jobAreas.id)),
      db
        .select()
        .from(schema.jobMedia)
        .where(and(eq(schema.jobMedia.jobId, task.jobId), sql`${schema.jobMedia.archivedAt} is null`))
        .orderBy(asc(schema.jobMedia.capturedAt)),
    ]);

    // On a callback, the original job's photos come along read only, as "original".
    const parentId = await parentJobOf(task.jobId);
    const originalRows = parentId
      ? await db
          .select()
          .from(schema.jobMedia)
          .where(and(eq(schema.jobMedia.jobId, parentId), sql`${schema.jobMedia.archivedAt} is null`))
          .orderBy(asc(schema.jobMedia.capturedAt))
      : [];
    const signed = await signMany(mediaRows);
    const signedOriginal = (await signMany(originalRows)).map((m) => ({ ...m, bucket: "original", taskId: null as number | null, areaId: null as number | null, uploadedByInstallerId: null as number | null }));
    const need = await minCompletionPhotos(task.skillId);

    return {
      areas,
      isCallback: Boolean(parentId),
      media: [...signed, ...signedOriginal].map((m) => ({
        id: m.id,
        bucket: m.bucket,
        kind: m.kind,
        url: m.url,
        areaId: m.areaId,
        caption: m.caption,
        filename: m.filename,
        capturedAt: m.capturedAt,
        uploaderName: m.uploaderName,
        mine: m.uploadedByInstallerId === context.installerId,
      })),
      gates: {
        damageDone: Boolean(task.damageCheckedAt || task.damageNone),
        damageNone: task.damageNone,
        completionNeeded: need,
        completionHave: signed.filter((m) => m.bucket === "completion" && m.taskId === task.id).length,
        /** The every-day rule: today's completion photos, Gold Coast date. */
        completionTodayHave: await completionPhotosOn(task.id, todayLocal()),
      },
    };
  }),

  /**
   * Record a photo or video the crew just uploaded straight to storage.
   * Auto-stamped with who, when, where and which job — nobody names a file.
   * There is no delete: the office archives, the record survives.
   */
  addMedia: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        bucket: z.enum(CREW_BUCKETS),
        kind: z.enum(["photo", "video"]).default("photo"),
        storageKey: z.string().min(1),
        areaId: z.number().nullable().optional(),
        filename: z.string().nullable().optional(),
        mime: z.string().nullable().optional(),
        sizeBytes: z.number().nullable().optional(),
        durationSeconds: z.number().nullable().optional(),
        caption: z.string().nullable().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const [installer] = await db
        .select({ name: schema.installers.name })
        .from(schema.installers)
        .where(eq(schema.installers.id, context.installerId));

      const [row] = await db
        .insert(schema.jobMedia)
        .values({
          jobId: task.jobId,
          taskId: task.id,
          areaId: input.areaId ?? null,
          bucket: input.bucket,
          kind: input.kind,
          storageKey: input.storageKey,
          url: input.storageKey,
          filename: input.filename ?? null,
          mime: input.mime ?? null,
          sizeBytes: input.sizeBytes ?? null,
          durationSeconds: input.durationSeconds ?? null,
          caption: input.caption ?? null,
          capturedLat: input.lat ?? null,
          capturedLng: input.lng ?? null,
          uploadedByInstallerId: context.installerId,
          uploaderName: installer?.name ?? "Installer",
        })
        .returning({ id: schema.jobMedia.id, bucket: schema.jobMedia.bucket });

      if (input.bucket === "damage" && !task.damageCheckedAt) {
        await db
          .update(schema.jobTasks)
          .set({ damageCheckedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.jobTasks.id, task.id));
      }

      /* A completion photo may be the one that clears today's red flag. */
      if (input.bucket === "completion") {
        await recheckPhotoFlags(task.id).catch((e) => console.error("[visits] recheck failed", e));
      }

      if (input.bucket === "found") {
        await db.insert(schema.activityLog).values({
          jobId: task.jobId,
          taskId: task.id,
          entityType: "task",
          entityId: task.id,
          action: "site_finding",
          detail: `${installer?.name ?? "Installer"} flagged something on site${input.caption ? ` — ${input.caption}` : ""}`,
          actorName: installer?.name ?? "Installer",
          actorRole: "installer",
        });
      }

      return row;
    }),

  /** "Walked it, nothing already damaged." Logged against their name. */
  noDamage: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const task = await ownTaskOrThrow(input.taskId, context.installerId);
    const [installer] = await db
      .select({ name: schema.installers.name })
      .from(schema.installers)
      .where(eq(schema.installers.id, context.installerId));

    await db
      .update(schema.jobTasks)
      .set({ damageNone: true, damageCheckedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.jobTasks.id, task.id));

    await db.insert(schema.activityLog).values({
      jobId: task.jobId,
      taskId: task.id,
      entityType: "task",
      entityId: task.id,
      action: "damage_check",
      detail: `${installer?.name ?? "Installer"} walked the site — no existing damage found`,
      actorName: installer?.name ?? "Installer",
      actorRole: "installer",
    });
    return { ok: true };
  }),

  /** Note back to the office from the field. */
  addNote: installerOnly
    .input(z.object({ taskId: z.number(), body: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      const [installer] = await db
        .select({ name: schema.installers.name })
        .from(schema.installers)
        .where(eq(schema.installers.id, context.installerId));
      const [row] = await db
        .insert(schema.activityLog)
        .values({
          jobId: task.jobId,
          taskId: input.taskId,
          entityType: "task",
          entityId: input.taskId,
          action: "field_note",
          detail: input.body,
          actorName: installer?.name ?? "Installer",
          actorRole: "installer",
        })
        .returning();
      return row;
    }),

  /* --------------------------- location sharing -----------------------
   * ON-SHIFT ONLY. The phone reports a position while a task is in progress
   * and stops the moment it's marked complete. Consent is the installer's to
   * give and to take back, from their own Me screen, any time.
   * ------------------------------------------------------------------- */

  /** Turn location sharing on or off. Turning it off wipes every position held. */
  setLocationConsent: installerOnly
    .input(z.object({ on: z.boolean() }))
    .handler(async ({ input, context }) => {
      await db
        .update(schema.installers)
        .set({ locationConsentAt: input.on ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.installers.id, context.installerId));

      // Opting out isn't a pause — the history goes with it.
      if (!input.on) {
        await db
          .delete(schema.installerLocations)
          .where(eq(schema.installerLocations.installerId, context.installerId));
      }
      return { on: input.on };
    }),

  /**
   * A position ping. Rejected unless (a) they've consented and (b) the task
   * named is theirs AND actually in progress right now. No shift, no record.
   */
  pingLocation: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().nullable().optional(),
        speed: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [installer] = await db
        .select({ consent: schema.installers.locationConsentAt })
        .from(schema.installers)
        .where(eq(schema.installers.id, context.installerId));
      if (!installer?.consent) throw new ORPCError("FORBIDDEN", { message: "Location sharing is off." });

      const task = await ownTaskOrThrow(input.taskId, context.installerId);
      if (task.status !== "in_progress") {
        throw new ORPCError("BAD_REQUEST", { message: "That job isn't running, so nothing is tracked." });
      }

      await db.insert(schema.installerLocations).values({
        installerId: context.installerId,
        taskId: input.taskId,
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy ?? null,
        speed: input.speed ?? null,
        capturedAt: new Date(),
      });
      return { ok: true };
    }),

  /* ---------------------------------- forms ---------------------------------
   * On-site forms — the variation form above all. The crew DESCRIBE what
   * changed and photograph it. There is no price field on any crew form and
   * there never will be: the office prices every variation.
   * ------------------------------------------------------------------------ */

  /** The forms the crew can raise on this task. Active templates only. */
  forms: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);

    const templates = await db
      .select()
      .from(schema.formTemplates)
      .where(eq(schema.formTemplates.active, true))
      .orderBy(asc(schema.formTemplates.sortOrder), asc(schema.formTemplates.id));

    if (!templates.length) return [];

    const fields = await db
      .select()
      .from(schema.formFields)
      .where(inArray(schema.formFields.templateId, templates.map((t) => t.id)))
      .orderBy(asc(schema.formFields.sortOrder), asc(schema.formFields.id));

    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      description: t.description,
      fields: fields
        .filter((f) => f.templateId === t.id)
        .map((f) => ({
          id: f.id,
          label: f.label,
          type: f.type,
          required: f.required,
          helpText: f.helpText,
          unit: f.unit,
          mediaBucket: f.mediaBucket,
          options: JSON.parse(f.options || "[]") as string[],
        })),
    }));
  }),

  /** What this installer has already raised on this task. */
  mySubmissions: installerOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    await ownTaskOrThrow(input.taskId, context.installerId);
    return db
      .select({
        id: schema.formSubmissions.id,
        templateName: schema.formSubmissions.templateName,
        templateKind: schema.formSubmissions.templateKind,
        status: schema.formSubmissions.status,
        submittedAt: schema.formSubmissions.submittedAt,
      })
      .from(schema.formSubmissions)
      .where(
        and(
          eq(schema.formSubmissions.taskId, input.taskId),
          eq(schema.formSubmissions.installerId, context.installerId),
        ),
      )
      .orderBy(desc(schema.formSubmissions.submittedAt));
  }),

  /**
   * Submit a filled-in form. Required questions are enforced HERE, on the
   * server — a patched app can't skip them. Photo answers reference media the
   * phone already uploaded through addMedia, so the photo is in the job file
   * whatever happens to the form.
   */
  submitForm: installerOnly
    .input(
      z.object({
        taskId: z.number(),
        templateId: z.number(),
        answers: z.array(
          z.object({
            fieldId: z.number(),
            value: z.string().default(""),
            mediaId: z.number().nullable().optional(),
          }),
        ),
      }),
    )
    .handler(async ({ input, context }) => {
      const task = await ownTaskOrThrow(input.taskId, context.installerId);

      const [template] = await db
        .select()
        .from(schema.formTemplates)
        .where(eq(schema.formTemplates.id, input.templateId));

      if (!template || !template.active) {
        throw new ORPCError("BAD_REQUEST", { message: "That form isn't available." });
      }

      const fields = await db
        .select()
        .from(schema.formFields)
        .where(eq(schema.formFields.templateId, template.id))
        .orderBy(asc(schema.formFields.sortOrder), asc(schema.formFields.id));

      for (const f of fields) {
        if (!f.required) continue;
        const given = input.answers.filter((a) => a.fieldId === f.id);
        const answered = given.some((a) => a.value.trim() !== "" || typeof a.mediaId === "number");
        if (!answered) {
          throw new ORPCError("BAD_REQUEST", { message: `"${f.label}" still needs an answer.` });
        }
      }

      const [installer] = await db
        .select({ name: schema.installers.name })
        .from(schema.installers)
        .where(eq(schema.installers.id, context.installerId));

      const [submission] = await db
        .insert(schema.formSubmissions)
        .values({
          templateId: template.id,
          templateName: template.name,
          templateKind: template.kind,
          jobId: task.jobId,
          taskId: task.id,
          installerId: context.installerId,
          submittedByName: installer?.name ?? "Installer",
          submittedAt: new Date(),
          status: "pending",
        })
        .returning();

      if (!submission) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not save that form." });

      const rows = input.answers
        .map((a) => {
          const field = fields.find((f) => f.id === a.fieldId);
          if (!field) return null;
          return {
            submissionId: submission.id,
            fieldId: field.id,
            label: field.label,
            type: field.type,
            unit: field.unit,
            value: a.value,
            mediaId: a.mediaId ?? null,
            sortOrder: field.sortOrder,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);

      if (rows.length) await db.insert(schema.formAnswers).values(rows);

      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: task.id,
        entityType: "form_submission",
        entityId: submission.id,
        action: template.kind === "variation" ? "variation_raised" : `${template.name} submitted`,
        detail: `${installer?.name ?? "Installer"} submitted ${template.name}`,
        actorName: installer?.name ?? "Installer",
        actorRole: "installer",
      });

      return { id: submission.id, status: submission.status };
    }),
};
