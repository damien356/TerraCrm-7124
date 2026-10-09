import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { repairJobNumber } from "./job-number";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { signMany } from "./s3";
import { parseRepairRef, quoteRef, repairRef } from "./refs";

/**
 * CALLBACKS. A client rings back after a job is done: a fix, a repair, a
 * return visit. It is a normal job row linked to the original, so the
 * schedule, tasks, offers, Crew, quotes and SWMS all work on it unchanged.
 *
 * - It takes the next job number under the hood, and is SHOWN as "3981-C1".
 * - Every callback points at the ORIGINAL job, so a chain is one level deep.
 * - Products, notes and photos are read live from the original, never copied,
 *   so nothing is ordered twice and nothing goes out of date.
 * - Cause, chargeable and rework cost are office facts. Crew never sees them.
 */

export const CALLBACK_CAUSES = [
  "installer_error",
  "product_fault",
  "customer_damage",
  "wear_and_tear",
  "warranty",
  "other",
] as const;
export type CallbackCause = (typeof CALLBACK_CAUSES)[number];

export const CALLBACK_CAUSE_LABELS: Record<CallbackCause, string> = {
  installer_error: "Installer error",
  product_fault: "Product fault",
  customer_damage: "Customer damage",
  wear_and_tear: "Wear and tear",
  warranty: "Warranty",
  other: "Other",
};

export const CALLBACK_COST_KINDS = ["labour", "product", "trip", "other"] as const;
export const CALLBACK_COST_LABELS: Record<(typeof CALLBACK_COST_KINDS)[number], string> = {
  labour: "Labour",
  product: "Replacement product",
  trip: "Return trip",
  other: "Other",
};

export { jobRef } from "./job-ref";

/**
 * "R188000-2", "r188000 2", and the old "3981-C2", "3981c2", "#3981 C2" all
 * read as parent and repair number. `displayNumber` is how that repair is
 * stored: R form from section 1 on, C form on the old ones.
 */
export function parseCallbackRef(text: string): { parent: number; seq: number; displayNumber: string } | null {
  const r = parseRepairRef(text);
  if (!r) return null;
  return { parent: r.parent, seq: r.seq, displayNumber: r.old ? `${r.parent}-C${r.seq}` : repairRef(r.parent, r.seq) };
}

/**
 * The installer whose work the callback is about: whoever did the last
 * finished task on the original job, else whoever was last put on it.
 */
export async function originalInstallerId(jobId: number): Promise<number | null> {
  const rows = await db
    .select({ id: schema.jobTasks.assignedInstallerId, status: schema.jobTasks.status })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), isNotNull(schema.jobTasks.assignedInstallerId)))
    .orderBy(desc(schema.jobTasks.completedAt), desc(schema.jobTasks.seq));
  const done = rows.find((r) => r.status === "complete");
  return (done ?? rows[0])?.id ?? null;
}

/** A callback marked "not chargeable" bills nothing. Quotes on it are refused. */
export async function assertBillable(jobId: number | null | undefined) {
  if (!jobId) return;
  const [job] = await db
    .select({ parentJobId: schema.jobs.parentJobId, chargeable: schema.jobs.callbackChargeable, displayNumber: schema.jobs.displayNumber })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  if (job?.parentJobId && job.chargeable === false) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Callback ${job.displayNumber} is marked not chargeable, so nothing is billed. Change it to chargeable first.`,
    });
  }
}

export const createCallbackInput = z
  .object({
    jobId: z.number(),
    cause: z.enum(CALLBACK_CAUSES),
    chargeable: z.boolean(),
    /** Installer error only. Required then, ignored otherwise. */
    payInstaller: z.boolean().nullable().optional(),
    /** Who does the fix. Defaults to the original installer; null leaves it unassigned. */
    installerId: z.number().nullable().optional(),
    /** What the client reported. Goes on the job and the fix task. */
    problem: z.string().trim().max(4000).default(""),
  })
  .superRefine((v, ctx) => {
    if (v.cause === "installer_error" && (v.payInstaller === null || v.payInstaller === undefined)) {
      ctx.addIssue({ code: "custom", path: ["payInstaller"], message: "Say whether the installer is paid for this visit" });
    }
  });

/** Creates the linked callback job, its people, and one fix task. Returns the new job. */
export async function createCallback(input: z.input<typeof createCallbackInput>, actor: Pick<Actor, "name" | "role">) {
  const v = createCallbackInput.parse(input);
  const [picked] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, v.jobId));
  if (!picked) throw new ORPCError("NOT_FOUND", { message: "Job not found" });

  // A callback of a callback still hangs off the original job.
  const original = picked.parentJobId
    ? (await db.select().from(schema.jobs).where(eq(schema.jobs.id, picked.parentJobId)))[0] ?? picked
    : picked;

  const [seqRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.jobs.callbackSeq}), 0)` })
    .from(schema.jobs)
    .where(eq(schema.jobs.parentJobId, original.id));
  const seq = Number(seqRow?.max ?? 0) + 1;
  // R188000-1 (spec section 1). Old callbacks keep their 3981-C1. The row
  // number is hidden, so the repair does not use up a job number.
  const number = repairJobNumber(original.number, seq);
  const displayNumber = repairRef(original.number, seq);

  const [firstStatus] = await db
    .select({ id: schema.jobStatuses.id })
    .from(schema.jobStatuses)
    .where(eq(schema.jobStatuses.active, true))
    .orderBy(asc(schema.jobStatuses.sortOrder))
    .limit(1);

  const isInstallerError = v.cause === "installer_error";
  const payInstaller = isInstallerError ? (v.payInstaller ?? null) : null;
  const problem = v.problem.trim();

  const [row] = await db
    .insert(schema.jobs)
    .values({
      number,
      displayNumber,
      parentJobId: original.id,
      callbackSeq: seq,
      callbackCause: v.cause,
      callbackChargeable: v.chargeable,
      callbackPayInstaller: payInstaller,
      title: `Callback: ${original.title || `job #${original.number}`}`.slice(0, 200),
      statusId: firstStatus?.id ?? null,
      siteId: original.siteId,
      contactId: original.contactId,
      companyId: original.companyId,
      billToType: original.billToType,
      billToContactId: original.billToContactId,
      billToCompanyId: original.billToCompanyId,
      furnitureOnSite: original.furnitureOnSite,
      description: problem || null,
      accessNotes: original.accessNotes,
      planUrl: original.planUrl,
      planName: original.planName,
      planMime: original.planMime,
      source: "callback",
      category: original.category,
      requiresSwms: original.requiresSwms,
      // Starts at nothing either way. A chargeable callback gets its value from
      // its accepted quote like any job; a free one can never get a quote.
      value: 0,
    })
    .returning();
  if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not create the callback" });

  // Everyone on the original job comes across with their tags, ticks and notes.
  const people = await db.select().from(schema.jobContacts).where(eq(schema.jobContacts.jobId, original.id));
  if (people.length) {
    await db.insert(schema.jobContacts).values(
      people.map(({ id: _id, jobId: _jobId, createdAt: _c, updatedAt: _u, ...p }) => ({ ...p, jobId: row.id })),
    );
  }

  // One fix task. Same skill as the original work, so the same installers qualify.
  const [origTask] = await db
    .select({ skillId: schema.jobTasks.skillId, crewSize: schema.jobTasks.crewSize })
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.jobId, original.id))
    .orderBy(asc(schema.jobTasks.seq))
    .limit(1);
  const installerId = v.installerId === undefined ? await originalInstallerId(original.id) : v.installerId;
  if (installerId && origTask?.skillId) {
    const [tick] = await db
      .select({ id: schema.installerSkills.installerId })
      .from(schema.installerSkills)
      .where(and(eq(schema.installerSkills.installerId, installerId), eq(schema.installerSkills.skillId, origTask.skillId)));
    const isOriginal = installerId === (await originalInstallerId(original.id));
    if (!tick && !isOriginal) {
      throw new ORPCError("BAD_REQUEST", { message: "That installer isn't ticked for this kind of work. Pick someone else." });
    }
  }
  const unpaid = isInstallerError && payInstaller === false;
  const [task] = await db
    .insert(schema.jobTasks)
    .values({
      jobId: row.id,
      seq: 1,
      skillId: origTask?.skillId ?? null,
      title: "Callback visit",
      description: problem || null,
      durationHours: 2,
      crewSize: original.furnitureOnSite ? 2 : 1,
      status: installerId ? "assigned" : "unassigned",
      assignedInstallerId: installerId ?? null,
      payType: "per_job",
      payAmount: unpaid ? 0 : null,
      ...(unpaid ? { labourCost: 0, labourBreakdown: "[]", labourPricedOn: new Date().toISOString().slice(0, 10) } : {}),
    })
    .returning();

  const causeLabel = CALLBACK_CAUSE_LABELS[v.cause];
  await db.insert(schema.activityLog).values([
    {
      jobId: row.id,
      entityType: "job",
      entityId: row.id,
      action: "created",
      detail: `Callback ${displayNumber} created from job ${original.number}. ${causeLabel}, ${v.chargeable ? "chargeable" : "not chargeable"}${isInstallerError ? `, installer ${payInstaller ? "paid" : "not paid"} for the visit` : ""}.`,
      actorName: actor.name,
      actorRole: actor.role,
    },
    {
      jobId: original.id,
      entityType: "job",
      entityId: original.id,
      action: "callback_created",
      detail: `Callback ${displayNumber} opened. ${causeLabel}.${problem ? ` ${problem.slice(0, 200)}` : ""}`,
      actorName: actor.name,
      actorRole: actor.role,
    },
  ]);

  return { ...row, taskId: task?.id ?? null };
}

/** The original job and every callback in its chain, oldest first. */
export async function callbackChain(jobId: number) {
  const [job] = await db
    .select({ id: schema.jobs.id, parentJobId: schema.jobs.parentJobId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  if (!job) return null;
  const rootId = job.parentJobId ?? job.id;
  const rows = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      displayNumber: schema.jobs.displayNumber,
      title: schema.jobs.title,
      parentJobId: schema.jobs.parentJobId,
      callbackSeq: schema.jobs.callbackSeq,
      cause: schema.jobs.callbackCause,
      chargeable: schema.jobs.callbackChargeable,
      createdAt: schema.jobs.createdAt,
      completedAt: schema.jobs.completedAt,
      status: { name: schema.jobStatuses.name, colour: schema.jobStatuses.colour, stage: schema.jobStatuses.stage },
    })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(sql`${schema.jobs.id} = ${rootId} or ${schema.jobs.parentJobId} = ${rootId}`)
    .orderBy(asc(sql`coalesce(${schema.jobs.callbackSeq}, 0)`));
  const root = rows.find((r) => r.id === rootId) ?? null;
  return { root, callbacks: rows.filter((r) => r.parentJobId === rootId) };
}

/** What the callback page shows from the original job: products, notes and photos, read only. */
export async function originalJobFile(parentJobId: number) {
  const [materials, notes, media] = await Promise.all([
    db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, parentJobId)),
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.jobId, parentJobId), inArray(schema.activityLog.action, ["note"])))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(30),
    db
      .select()
      .from(schema.jobMedia)
      .where(and(eq(schema.jobMedia.jobId, parentJobId), isNull(schema.jobMedia.archivedAt)))
      .orderBy(asc(schema.jobMedia.capturedAt)),
  ]);
  return { materials, notes, media: await signMany(media) };
}

/* ------------------------------ office edits ------------------------------ */

async function callbackOrThrow(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  if (!job.parentJobId) throw new ORPCError("BAD_REQUEST", { message: "This job isn't a callback." });
  return job;
}

/**
 * The fix task's pay follows the "pay the installer" answer. Only work not yet
 * done moves, and only pay the office hasn't set by hand: a $0 from "don't pay"
 * goes back to unpriced, so the rate book prices it again.
 */
async function applyPayRule(jobId: number, pay: boolean | null) {
  const open = await db
    .select({ id: schema.jobTasks.id, payAmount: schema.jobTasks.payAmount, labourCost: schema.jobTasks.labourCost })
    .from(schema.jobTasks)
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "complete")));
  let changed = 0;
  for (const t of open) {
    if (pay === false && (t.payAmount !== 0 || t.labourCost !== 0)) {
      await db
        .update(schema.jobTasks)
        .set({ payAmount: 0, labourCost: 0, labourBreakdown: "[]", labourPricedOn: new Date().toISOString().slice(0, 10), updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, t.id));
      changed++;
    } else if (pay !== false && t.payAmount === 0 && t.labourCost === 0) {
      await db
        .update(schema.jobTasks)
        .set({ payAmount: null, labourCost: null, labourBreakdown: null, labourPricedOn: null, updatedAt: new Date() })
        .where(eq(schema.jobTasks.id, t.id));
      changed++;
    }
  }
  return changed;
}

export const setCauseInput = z
  .object({
    jobId: z.number(),
    cause: z.enum(CALLBACK_CAUSES),
    payInstaller: z.boolean().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.cause === "installer_error" && (v.payInstaller === null || v.payInstaller === undefined)) {
      ctx.addIssue({ code: "custom", path: ["payInstaller"], message: "Say whether the installer is paid for this visit" });
    }
  });

export async function setCause(input: z.input<typeof setCauseInput>, actor: Pick<Actor, "name" | "role">) {
  const v = setCauseInput.parse(input);
  const job = await callbackOrThrow(v.jobId);
  const pay = v.cause === "installer_error" ? (v.payInstaller ?? null) : null;
  if (job.callbackCause === v.cause && (job.callbackPayInstaller ?? null) === pay) return job;
  const [row] = await db
    .update(schema.jobs)
    .set({ callbackCause: v.cause, callbackPayInstaller: pay, updatedAt: new Date() })
    .where(eq(schema.jobs.id, job.id))
    .returning();
  const moved = await applyPayRule(job.id, pay);
  const was = job.callbackCause ? (CALLBACK_CAUSE_LABELS[job.callbackCause as CallbackCause] ?? job.callbackCause) : "none";
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    action: "callback_cause",
    detail: `Cause changed from ${was} to ${CALLBACK_CAUSE_LABELS[v.cause]}${pay === null ? "" : `, installer ${pay ? "paid" : "not paid"} for the visit`}.${moved ? ` Pay reset on ${moved} open task${moved === 1 ? "" : "s"}.` : ""}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return row!;
}

export async function setChargeable(jobId: number, chargeable: boolean, actor: Pick<Actor, "name" | "role">) {
  const job = await callbackOrThrow(jobId);
  if (job.callbackChargeable === chargeable) return job;
  if (!chargeable) {
    const live = await db
      .select({ number: schema.quotes.number, version: schema.quotes.version, status: schema.quotes.status })
      .from(schema.quotes)
      .where(and(eq(schema.quotes.jobId, jobId), inArray(schema.quotes.status, ["sent", "accepted"])));
    if (live.length) {
      const q = live[0]!;
      throw new ORPCError("BAD_REQUEST", {
        message: `Quote ${quoteRef(q.number, q.version, job.displayNumber)} on this repair is ${q.status}. Decline it before marking the callback not chargeable.`,
      });
    }
  }
  const [row] = await db
    .update(schema.jobs)
    .set({ callbackChargeable: chargeable, ...(chargeable ? {} : { value: 0 }), updatedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
    .returning();
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "job",
    entityId: jobId,
    action: "callback_chargeable",
    detail: chargeable ? "Marked chargeable. Quotes can go out on it." : "Marked not chargeable. Nothing is billed on it.",
    actorName: actor.name,
    actorRole: actor.role,
  });
  return row!;
}

/* ------------------------------ rework cost ------------------------------- */

export const addCostInput = z.object({
  jobId: z.number(),
  kind: z.enum(CALLBACK_COST_KINDS),
  description: z.string().trim().max(500).default(""),
  amount: z.number().min(0).max(1_000_000),
  /** Left out, it goes against the original installer. */
  installerId: z.number().nullable().optional(),
});

export async function listCosts(jobId: number) {
  const job = await callbackOrThrow(jobId);
  const rows = await db
    .select({ cost: schema.callbackCosts, installerName: schema.installers.name })
    .from(schema.callbackCosts)
    .leftJoin(schema.installers, eq(schema.installers.id, schema.callbackCosts.installerId))
    .where(eq(schema.callbackCosts.jobId, jobId))
    .orderBy(asc(schema.callbackCosts.id));
  const originalId = await originalInstallerId(job.parentJobId!);
  const [orig] = originalId
    ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, originalId))
    : [];
  return {
    original: orig ?? null,
    items: rows.map((r) => ({ ...r.cost, installerName: r.installerName ?? null })),
    total: Math.round(rows.reduce((a, r) => a + (r.cost.amount ?? 0), 0) * 100) / 100,
  };
}

export async function addCost(input: z.input<typeof addCostInput>, actor: Pick<Actor, "name" | "role">) {
  const v = addCostInput.parse(input);
  const job = await callbackOrThrow(v.jobId);
  const installerId = v.installerId === undefined ? await originalInstallerId(job.parentJobId!) : v.installerId;
  const [row] = await db
    .insert(schema.callbackCosts)
    .values({ jobId: v.jobId, installerId, kind: v.kind, description: v.description, amount: Math.round(v.amount * 100) / 100 })
    .returning();
  // No job history line. Office reads the history, and rework cost is Admin only.
  void actor;
  return row!;
}

export async function removeCost(id: number, actor: Pick<Actor, "name" | "role">) {
  const [row] = await db.delete(schema.callbackCosts).where(eq(schema.callbackCosts.id, id)).returning();
  if (!row) throw new ORPCError("NOT_FOUND", { message: "That cost line is gone already." });
  void actor;
  return { ok: true };
}

/* --------------------------------- report --------------------------------- */

/** Brisbane day bounds, as Dates. */
const dayStart = (d: string) => new Date(`${d}T00:00:00+10:00`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999+10:00`);

/**
 * Every callback opened in the range, with who did the original work and what
 * fixing it cost. Rolled up per installer and per cause. Report only: nothing
 * here is charged to anyone.
 */
export async function callbackReport(range: { from?: string | null; to?: string | null }) {
  const where = [isNotNull(schema.jobs.parentJobId)];
  if (range.from) where.push(gte(schema.jobs.createdAt, dayStart(range.from)));
  if (range.to) where.push(lte(schema.jobs.createdAt, dayEnd(range.to)));
  const rows = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      displayNumber: schema.jobs.displayNumber,
      parentJobId: schema.jobs.parentJobId,
      title: schema.jobs.title,
      cause: schema.jobs.callbackCause,
      chargeable: schema.jobs.callbackChargeable,
      payInstaller: schema.jobs.callbackPayInstaller,
      createdAt: schema.jobs.createdAt,
      completedAt: schema.jobs.completedAt,
      status: schema.jobStatuses.name,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(and(...where))
    .orderBy(desc(schema.jobs.createdAt));

  const ids = rows.map((r) => r.id);
  const parentIds = [...new Set(rows.map((r) => r.parentJobId!))];
  const [costs, parentTasks, installers] = await Promise.all([
    ids.length ? db.select().from(schema.callbackCosts).where(inArray(schema.callbackCosts.jobId, ids)) : [],
    parentIds.length
      ? db
          .select({ jobId: schema.jobTasks.jobId, id: schema.jobTasks.assignedInstallerId, status: schema.jobTasks.status })
          .from(schema.jobTasks)
          .where(and(inArray(schema.jobTasks.jobId, parentIds), isNotNull(schema.jobTasks.assignedInstallerId)))
          .orderBy(desc(schema.jobTasks.completedAt), desc(schema.jobTasks.seq))
      : [],
    db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers),
  ]);
  const nameOf = new Map(installers.map((i) => [i.id, i.name]));
  // Same rule as originalInstallerId: the last finished task, else the last one put on.
  const originalOf = new Map<number, number | null>();
  for (const pid of parentIds) {
    const t = parentTasks.filter((x) => x.jobId === pid);
    originalOf.set(pid, (t.find((x) => x.status === "complete") ?? t[0])?.id ?? null);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const list = rows.map((r) => {
    const mine = costs.filter((c) => c.jobId === r.id);
    const originalInstaller = originalOf.get(r.parentJobId!) ?? null;
    return {
      ...r,
      ref: r.displayNumber || String(r.number),
      causeLabel: r.cause ? (CALLBACK_CAUSE_LABELS[r.cause as CallbackCause] ?? r.cause) : "No cause set",
      originalInstallerId: originalInstaller,
      originalInstallerName: originalInstaller ? (nameOf.get(originalInstaller) ?? "Installer") : null,
      cost: r2(mine.reduce((a, c) => a + (c.amount ?? 0), 0)),
    };
  });

  const perInstaller = new Map<string, { installerId: number | null; name: string; callbacks: number; installerError: number; cost: number }>();
  for (const r of list) {
    const key = String(r.originalInstallerId ?? "none");
    const a = perInstaller.get(key) ?? {
      installerId: r.originalInstallerId,
      name: r.originalInstallerName ?? "No installer on the original",
      callbacks: 0,
      installerError: 0,
      cost: 0,
    };
    a.callbacks++;
    if (r.cause === "installer_error") a.installerError++;
    a.cost = r2(a.cost + r.cost);
    perInstaller.set(key, a);
  }
  const perCause = CALLBACK_CAUSES.map((cause) => {
    const mine = list.filter((r) => r.cause === cause);
    return { cause, label: CALLBACK_CAUSE_LABELS[cause], callbacks: mine.length, cost: r2(mine.reduce((a, r) => a + r.cost, 0)) };
  }).filter((c) => c.callbacks > 0);

  return {
    callbacks: list,
    perInstaller: [...perInstaller.values()].sort((a, b) => b.cost - a.cost || b.callbacks - a.callbacks),
    perCause,
    totals: {
      callbacks: list.length,
      notChargeable: list.filter((r) => r.chargeable === false).length,
      cost: r2(list.reduce((a, r) => a + r.cost, 0)),
    },
  };
}
