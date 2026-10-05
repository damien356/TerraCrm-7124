import { z } from "zod";
import { and, asc, desc, eq, inArray, lt, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { pushToInstaller, pushToOffice } from "../lib/push";
import { blockedReason } from "../lib/availability";
import { lockTaskLabour } from "./costing";

/**
 * Dispatch is DIRECT or BROADCAST.
 *  - direct    → one installer, take it or leave it
 *  - broadcast → every installer ticked for the skill; FIRST TO ACCEPT WINS and
 *                the rest auto-close to "filled"
 * Offers always show the installer's pay up front, expire after 2 hours, and
 * then escalate back to the office.
 */

const OFFER_TTL_HOURS = 2;

/**
 * Star tiers. Damien sets stars 1-5 by hand on the installer card.
 *  - 4 and 5 star  → accept instantly, pick a day out of the window, locked
 *  - 3 and under   → the accept becomes a PROVISIONAL hold for 2 hours while
 *                    higher-star installers still get first crack. If nobody
 *                    higher takes it, the hold converts to a real booking.
 *
 * When a lower-star holder loses it they are told ONLY that the job was already
 * accepted. Never that it went to someone rated higher. Damien was explicit.
 */
const INSTANT_ACCEPT_MIN_STARS = 4;
const PROVISIONAL_HOLD_HOURS = 2;
const ALREADY_TAKEN = "Sorry, this job was already accepted.";

/** Every day the task could land on. Empty when there's no window set. */
function windowDays(task: { scheduledFrom: string | null; scheduledTo: string | null }): string[] {
  if (!task.scheduledFrom) return [];
  const from = new Date(`${task.scheduledFrom}T00:00:00`);
  const to = new Date(`${task.scheduledTo ?? task.scheduledFrom}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) return [];
  const days: string[] = [];
  for (const d = new Date(from); d <= to && days.length < 60; d.setDate(d.getDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/** Works out what this installer gets paid for this task, from their own rate. */
async function derivePay(taskId: number, installerId: number): Promise<number | null> {
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
  if (!task) return null;
  if (task.payAmount != null) return task.payAmount;
  if (!task.skillId) return null;

  const [tick] = await db
    .select()
    .from(schema.installerSkills)
    .where(
      and(eq(schema.installerSkills.installerId, installerId), eq(schema.installerSkills.skillId, task.skillId)),
    );
  if (!tick?.rate) return null;

  switch (tick.rateType) {
    case "per_m2":
      return task.areaM2 ? Math.round(tick.rate * task.areaM2 * 100) / 100 : null;
    case "hourly":
      return Math.round(tick.rate * task.durationHours * 100) / 100;
    case "day_rate":
      return Math.round(tick.rate * Math.max(1, Math.ceil(task.durationHours / 8)) * 100) / 100;
    default:
      return tick.rate;
  }
}

/** Lazily expires anything past its window — no cron needed for phase 1. */
async function expireStale() {
  const now = new Date();
  const stale = await db
    .select({ id: schema.taskOffers.id, taskId: schema.taskOffers.taskId })
    .from(schema.taskOffers)
    .where(and(eq(schema.taskOffers.status, "pending"), lt(schema.taskOffers.expiresAt, now)));

  if (stale.length === 0) return [];

  await db
    .update(schema.taskOffers)
    .set({ status: "expired", respondedAt: now, updatedAt: now })
    .where(
      inArray(
        schema.taskOffers.id,
        stale.map((s) => s.id),
      ),
    );

  // Any task left with no live offer and nobody assigned goes back to the queue
  // so it shows up in the office's "needs attention" list.
  const taskIds = [...new Set(stale.map((s) => s.taskId))];
  for (const taskId of taskIds) {
    const live = await db
      .select({ id: schema.taskOffers.id })
      .from(schema.taskOffers)
      .where(and(eq(schema.taskOffers.taskId, taskId), eq(schema.taskOffers.status, "pending")));
    if (live.length === 0) {
      const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
      if (task && task.status === "offered" && !task.assignedInstallerId) {
        await db
          .update(schema.jobTasks)
          .set({ status: "unassigned", updatedAt: new Date() })
          .where(eq(schema.jobTasks.id, taskId));
        await db.insert(schema.activityLog).values({
          jobId: task.jobId,
          taskId,
          entityType: "task",
          entityId: taskId,
          action: "offer_expired",
          detail: `No one accepted "${task.title}" within ${OFFER_TTL_HOURS}h — back in the queue`,
          actorName: "System",
          actorRole: "system",
        });
      }
    }
  }
  return taskIds;
}

export const offers = {
  /** Send to one installer. */
  sendDirect: staffOnly
    .input(z.object({ taskId: z.number(), installerId: z.number(), payAmount: z.number().nullable().optional() }))
    .handler(async ({ input, context }) => {
      const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
      if (!task) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

      if (task.skillId) {
        const [tick] = await db
          .select()
          .from(schema.installerSkills)
          .where(
            and(
              eq(schema.installerSkills.installerId, input.installerId),
              eq(schema.installerSkills.skillId, task.skillId),
            ),
          );
        if (!tick) throw new ORPCError("BAD_REQUEST", { message: "That installer isn't ticked for this skill." });
      }

      const expiresAt = new Date(Date.now() + OFFER_TTL_HOURS * 3600_000);
      const pay = input.payAmount ?? (await derivePay(input.taskId, input.installerId));

      const [offer] = await db
        .insert(schema.taskOffers)
        .values({
          taskId: input.taskId,
          installerId: input.installerId,
          mode: "direct",
          status: "pending",
          payAmount: pay,
          expiresAt,
        })
        .returning();

      await db
        .update(schema.jobTasks)
        .set({ status: "offered", updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, input.taskId));

      const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "offer",
        entityId: offer!.id,
        action: "offer_sent",
        detail: `Offered "${task.title}" to ${installer?.name ?? "installer"}${pay ? ` — $${pay}` : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      // Buzz his phone. A missed offer expires, so this is not optional comms.
      void pushToInstaller(input.installerId, {
        title: "New job offer",
        body: `${task.title}${task.scheduledDate ? ` on ${task.scheduledDate}` : ""}${pay ? `, $${pay}` : ""}`,
        data: { kind: "offer", taskId: input.taskId, offerId: offer!.id },
      });

      return offer;
    }),

  /** Blast every installer ticked for the task's skill. First accept wins. */
  broadcast: staffOnly
    .input(z.object({ taskId: z.number(), payAmount: z.number().nullable().optional() }))
    .handler(async ({ input, context }) => {
      const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
      if (!task) throw new ORPCError("NOT_FOUND", { message: "Task not found" });
      if (!task.skillId) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Give the task a skill first — a broadcast goes to everyone ticked for that skill.",
        });
      }

      const candidates = await db
        .select({ installer: schema.installers })
        .from(schema.installerSkills)
        .innerJoin(schema.installers, eq(schema.installers.id, schema.installerSkills.installerId))
        .where(and(eq(schema.installerSkills.skillId, task.skillId), eq(schema.installers.active, true)));

      // A 2-man task can only be broadcast to people who can actually cover it.
      const eligible = candidates.filter(
        (c) => task.crewSize < 2 || c.installer.crewCapacity === "own_offsider" || task.secondInstallerId != null,
      );

      if (eligible.length === 0) {
        throw new ORPCError("BAD_REQUEST", {
          message:
            task.crewSize > 1
              ? "Nobody ticked for this skill can cover a 2-man task on their own. Assign a pair instead."
              : "No active installer is ticked for this skill yet.",
        });
      }

      const expiresAt = new Date(Date.now() + OFFER_TTL_HOURS * 3600_000);
      const created = [];
      for (const c of eligible) {
        const pay = input.payAmount ?? (await derivePay(input.taskId, c.installer.id));
        const [offer] = await db
          .insert(schema.taskOffers)
          .values({
            taskId: input.taskId,
            installerId: c.installer.id,
            mode: "broadcast",
            status: "pending",
            payAmount: pay,
            expiresAt,
          })
          .returning();
        created.push(offer);
      }

      await db
        .update(schema.jobTasks)
        .set({ status: "offered", updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, input.taskId));

      await db.insert(schema.activityLog).values({
        jobId: task.jobId,
        taskId: input.taskId,
        entityType: "offer",
        entityId: input.taskId,
        action: "broadcast_sent",
        detail: `Broadcast "${task.title}" to ${created.length} installer${created.length === 1 ? "" : "s"} — first to accept wins`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      for (const offer of created) {
        void pushToInstaller(offer!.installerId, {
          title: "Job up for grabs",
          body: `${task.title}${task.scheduledDate ? ` on ${task.scheduledDate}` : ""}${offer!.payAmount ? `, $${offer!.payAmount}` : ""}. First to accept gets it.`,
          data: { kind: "offer", taskId: input.taskId, offerId: offer!.id },
        });
      }

      return { sent: created.length, offers: created, expiresAt };
    }),

  /** Office pulls an offer back. */
  withdraw: staffOnly.input(z.object({ taskId: z.number() })).handler(async ({ input, context }) => {
    const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, input.taskId));
    if (!task) throw new ORPCError("NOT_FOUND", { message: "Task not found" });

    await db
      .update(schema.taskOffers)
      .set({ status: "withdrawn", respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.taskOffers.taskId, input.taskId), eq(schema.taskOffers.status, "pending")));

    if (task.status === "offered") {
      await db
        .update(schema.jobTasks)
        .set({ status: "unassigned", updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, input.taskId));
    }

    await db.insert(schema.activityLog).values({
      jobId: task.jobId,
      taskId: input.taskId,
      entityType: "offer",
      entityId: input.taskId,
      action: "offer_withdrawn",
      detail: `Offers pulled back on "${task.title}"`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    return { ok: true };
  }),

  /** Everything outstanding — the office's "waiting on installers" list. */
  pending: staffOnly.handler(async () => {
    await expireStale();
    const rows = await db
      .select({
        offer: schema.taskOffers,
        installer: schema.installers,
        task: schema.jobTasks,
        job: schema.jobs,
        site: schema.sites,
        skill: schema.skills,
      })
      .from(schema.taskOffers)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
      .where(eq(schema.taskOffers.status, "pending"))
      .orderBy(asc(schema.taskOffers.expiresAt));

    return rows.map((r) => ({
      id: r.offer.id,
      taskId: r.offer.taskId,
      mode: r.offer.mode,
      payAmount: r.offer.payAmount,
      sentAt: r.offer.sentAt,
      expiresAt: r.offer.expiresAt,
      installerName: r.installer.name,
      installerId: r.installer.id,
      taskTitle: r.task.title,
      scheduledDate: r.task.scheduledDate,
      skillName: r.skill?.name ?? null,
      jobNumber: r.job.number,
      siteAddress: r.site?.address ?? "",
      siteSuburb: r.site?.suburb ?? "",
    }));
  }),

  /** Full offer history for one task, so the office can see who said no and why. */
  forTask: staffOnly.input(z.object({ taskId: z.number() })).handler(async ({ input }) => {
    await expireStale();
    return db
      .select({ offer: schema.taskOffers, installer: schema.installers })
      .from(schema.taskOffers)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
      .where(eq(schema.taskOffers.taskId, input.taskId))
      .orderBy(desc(schema.taskOffers.sentAt));
  }),

  /** Recently declined, with reasons — Damien wanted the reason mandatory. */
  declines: staffOnly.handler(() =>
    db
      .select({
        offer: schema.taskOffers,
        installer: schema.installers,
        task: schema.jobTasks,
        job: schema.jobs,
      })
      .from(schema.taskOffers)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.taskOffers.installerId))
      .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
      .where(eq(schema.taskOffers.status, "declined"))
      .orderBy(desc(schema.taskOffers.respondedAt))
      .limit(30),
  ),
};

/**
 * Locks a task to one installer on one day. Every other live or provisional
 * offer on the task closes as "filled" — the neutral outcome, no explanation of
 * who got it or why.
 */
async function lockTask(args: {
  offerId: number;
  taskId: number;
  jobId: number;
  taskTitle: string;
  installerId: number;
  day: string | null;
  payAmount: number | null;
  promotedFromHold?: boolean;
}) {
  const now = new Date();

  await db
    .update(schema.taskOffers)
    .set({ status: "accepted", chosenDate: args.day, respondedAt: now, updatedAt: now })
    .where(eq(schema.taskOffers.id, args.offerId));

  // Everyone else loses — pending AND anyone sitting on a provisional hold.
  await db
    .update(schema.taskOffers)
    .set({ status: "filled", provisionalUntil: null, respondedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.taskOffers.taskId, args.taskId),
        inArray(schema.taskOffers.status, ["pending", "provisional"]),
        ne(schema.taskOffers.id, args.offerId),
      ),
    );

  await db
    .update(schema.jobTasks)
    .set({
      assignedInstallerId: args.installerId,
      status: "assigned",
      // The chosen day is the lock. The rest of the window frees up.
      ...(args.day ? { scheduledDate: args.day } : {}),
      ...(args.payAmount != null ? { payAmount: args.payAmount } : {}),
      updatedAt: now,
    })
    .where(eq(schema.jobTasks.id, args.taskId));

  // He won it, so the labour freezes at his card as it reads today.
  await lockTaskLabour({ taskId: args.taskId, installerId: args.installerId });

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, args.installerId));
  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    taskId: args.taskId,
    entityType: "offer",
    entityId: args.offerId,
    action: args.promotedFromHold ? "hold_confirmed" : "offer_accepted",
    detail: args.promotedFromHold
      ? `${installer?.name ?? "Installer"}'s ${PROVISIONAL_HOLD_HOURS}h hold on "${args.taskTitle}" converted — locked to ${args.day ?? "no date yet"}`
      : `${installer?.name ?? "Installer"} accepted "${args.taskTitle}"${args.day ? ` — locked to ${args.day}` : ""}`,
    actorName: installer?.name ?? "Installer",
    actorRole: "installer",
  });

  void pushToOffice({
    title: args.promotedFromHold ? "Hold confirmed" : "Offer accepted",
    body: `${installer?.name ?? "Installer"} has "${args.taskTitle}"${args.day ? ` on ${args.day}` : ""}`,
    data: { kind: "task", taskId: args.taskId, jobId: args.jobId },
  });

  return { ok: true, taskId: args.taskId, scheduledDate: args.day };
}

/**
 * Lazily converts provisional holds that have run their 2 hours. Nobody
 * higher-rated took it, so the hold becomes a real booking. Cheap enough to run
 * on every offer read — no cron needed.
 */
async function settleProvisional() {
  const now = new Date();
  const due = await db
    .select({ offer: schema.taskOffers, task: schema.jobTasks })
    .from(schema.taskOffers)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
    .where(and(eq(schema.taskOffers.status, "provisional"), lt(schema.taskOffers.provisionalUntil, now)))
    .orderBy(asc(schema.taskOffers.provisionalUntil));

  for (const row of due) {
    // Somebody rated higher already took it while the hold was running.
    if (row.task.assignedInstallerId && row.task.assignedInstallerId !== row.offer.installerId) {
      await db
        .update(schema.taskOffers)
        .set({ status: "filled", provisionalUntil: null, respondedAt: now, updatedAt: now })
        .where(eq(schema.taskOffers.id, row.offer.id));
      continue;
    }
    if (row.task.status === "cancelled") {
      await db
        .update(schema.taskOffers)
        .set({ status: "withdrawn", provisionalUntil: null, respondedAt: now, updatedAt: now })
        .where(eq(schema.taskOffers.id, row.offer.id));
      continue;
    }
    await lockTask({
      offerId: row.offer.id,
      taskId: row.offer.taskId,
      jobId: row.task.jobId,
      taskTitle: row.task.title,
      installerId: row.offer.installerId,
      day: row.offer.chosenDate ?? row.task.scheduledDate ?? row.task.scheduledFrom,
      payAmount: row.offer.payAmount,
      promotedFromHold: true,
    });
  }
  return due.length;
}

/**
 * Shared with field.ts — the accept path.
 *
 * 4 and 5 star installers lock the job on the spot and pick their day out of
 * the window. 3 star and under get a 2-hour provisional hold instead, so the
 * higher tier still has a shot. Losers only ever see "this job was already
 * accepted".
 */
export async function acceptOffer(offerId: number, installerId: number, chosenDate?: string | null) {
  await expireStale();
  await settleProvisional();

  const [row] = await db
    .select({ offer: schema.taskOffers, task: schema.jobTasks })
    .from(schema.taskOffers)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
    .where(and(eq(schema.taskOffers.id, offerId), eq(schema.taskOffers.installerId, installerId)));

  if (!row) throw new ORPCError("NOT_FOUND", { message: "Offer not found" });

  if (row.offer.status === "provisional") {
    throw new ORPCError("BAD_REQUEST", { message: "You're already holding this one — we'll confirm it shortly." });
  }
  if (row.offer.status === "accepted") {
    return { ok: true, taskId: row.offer.taskId, scheduledDate: row.task.scheduledDate };
  }
  if (row.offer.status !== "pending") {
    throw new ORPCError("BAD_REQUEST", {
      message:
        row.offer.status === "expired"
          ? "This offer has expired."
          : row.offer.status === "filled"
            ? ALREADY_TAKEN
            : "This offer is no longer open.",
    });
  }
  if (row.task.assignedInstallerId && row.task.assignedInstallerId !== installerId) {
    await db
      .update(schema.taskOffers)
      .set({ status: "filled", respondedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.taskOffers.id, offerId));
    throw new ORPCError("BAD_REQUEST", { message: ALREADY_TAKEN });
  }

  // Which day are they doing it?
  const days = windowDays(row.task);
  let day = chosenDate ?? row.task.scheduledDate ?? (days.length === 1 ? days[0]! : null);
  if (chosenDate && days.length > 0 && !days.includes(chosenDate)) {
    throw new ORPCError("BAD_REQUEST", { message: "That day isn't in the window for this job." });
  }
  if (!day && days.length > 1) {
    throw new ORPCError("BAD_REQUEST", { message: "Pick which day out of the window you'll do it." });
  }
  if (!day && days.length === 0) day = row.task.scheduledDate;

  if (day) {
    const clash = await blockedReason(installerId, day);
    if (clash) {
      throw new ORPCError("BAD_REQUEST", {
        message: `You're marked as unavailable that day (${clash}). Pick another day or tell the office.`,
      });
    }
  }

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  const stars = installer?.starRating ?? 3;
  const now = new Date();

  // Top tier: locked in immediately.
  if (stars >= INSTANT_ACCEPT_MIN_STARS) {
    const res = await lockTask({
      offerId,
      taskId: row.offer.taskId,
      jobId: row.task.jobId,
      taskTitle: row.task.title,
      installerId,
      day,
      payAmount: row.offer.payAmount,
    });
    return { ...res, provisional: false as const, holdUntil: null };
  }

  // Lower tier: 2-hour hold. Task stays "offered" so higher stars still see it.
  const holdUntil = new Date(now.getTime() + PROVISIONAL_HOLD_HOURS * 3600_000);
  await db
    .update(schema.taskOffers)
    .set({
      status: "provisional",
      provisionalUntil: holdUntil,
      chosenDate: day,
      // The hold outlives the original 2h offer window.
      expiresAt: holdUntil,
      respondedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.taskOffers.id, offerId));

  await db.insert(schema.activityLog).values({
    jobId: row.task.jobId,
    taskId: row.offer.taskId,
    entityType: "offer",
    entityId: offerId,
    action: "offer_held",
    detail: `${installer?.name ?? "Installer"} put a ${PROVISIONAL_HOLD_HOURS}h hold on "${row.task.title}"${day ? ` for ${day}` : ""} — confirms automatically unless someone else takes it`,
    actorName: installer?.name ?? "Installer",
    actorRole: "installer",
  });

  return {
    ok: true as const,
    taskId: row.offer.taskId,
    scheduledDate: day,
    provisional: true as const,
    holdUntil,
  };
}

/** Shared with field.ts — decline needs a reason. */
export async function declineOffer(offerId: number, installerId: number, reason: string) {
  const [row] = await db
    .select({ offer: schema.taskOffers, task: schema.jobTasks })
    .from(schema.taskOffers)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskOffers.taskId))
    .where(and(eq(schema.taskOffers.id, offerId), eq(schema.taskOffers.installerId, installerId)));

  if (!row) throw new ORPCError("NOT_FOUND", { message: "Offer not found" });

  const now = new Date();
  await db
    .update(schema.taskOffers)
    .set({ status: "declined", declineReason: reason, respondedAt: now, updatedAt: now })
    .where(eq(schema.taskOffers.id, offerId));

  const live = await db
    .select({ id: schema.taskOffers.id })
    .from(schema.taskOffers)
    .where(and(eq(schema.taskOffers.taskId, row.offer.taskId), eq(schema.taskOffers.status, "pending")));

  if (live.length === 0 && !row.task.assignedInstallerId) {
    await db
      .update(schema.jobTasks)
      .set({ status: "unassigned", updatedAt: now })
      .where(eq(schema.jobTasks.id, row.offer.taskId));
  }

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  await db.insert(schema.activityLog).values({
    jobId: row.task.jobId,
    taskId: row.offer.taskId,
    entityType: "offer",
    entityId: offerId,
    action: "offer_declined",
    detail: `${installer?.name ?? "Installer"} declined "${row.task.title}" — ${reason}`,
    actorName: installer?.name ?? "Installer",
    actorRole: "installer",
  });

  void pushToOffice({
    title: "Offer declined",
    body: `${installer?.name ?? "Installer"} knocked back "${row.task.title}": ${reason}`,
    data: { kind: "task", taskId: row.offer.taskId, jobId: row.task.jobId },
  });

  return { ok: true };
}

/** Shared with field.ts — hand a task back after previously accepting it. */
export async function releaseTask(taskId: number, installerId: number, reason: string) {
  const [task] = await db
    .select()
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.id, taskId), eq(schema.jobTasks.assignedInstallerId, installerId)));
  if (!task) throw new ORPCError("NOT_FOUND", { message: "That task isn't yours." });
  if (task.status === "complete") {
    throw new ORPCError("BAD_REQUEST", { message: "That task is already finished." });
  }

  const now = new Date();
  await db
    .update(schema.jobTasks)
    .set({ assignedInstallerId: null, status: "unassigned", updatedAt: now })
    .where(eq(schema.jobTasks.id, taskId));

  const [installer] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  await db.insert(schema.activityLog).values({
    jobId: task.jobId,
    taskId,
    entityType: "task",
    entityId: taskId,
    action: "task_released",
    detail: `${installer?.name ?? "Installer"} handed back "${task.title}" — ${reason}`,
    actorName: installer?.name ?? "Installer",
    actorRole: "installer",
  });

  void pushToOffice({
    title: "Task handed back",
    body: `${installer?.name ?? "Installer"} gave back "${task.title}": ${reason}. It needs covering.`,
    data: { kind: "task", taskId, jobId: task.jobId },
  });

  return { ok: true };
}

export { expireStale, OFFER_TTL_HOURS };
