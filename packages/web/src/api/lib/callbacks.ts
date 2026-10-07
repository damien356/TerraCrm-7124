import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";

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

/** "3981-C1" for a callback, "3981" for anything else. */
export function jobRef(j: { number: number; displayNumber?: string | null }) {
  return j.displayNumber || String(j.number);
}

/** "3981-C2", "3981c2", "#3981 C2" all read as parent 3981, callback 2. */
export function parseCallbackRef(text: string): { parent: number; seq: number } | null {
  const m = text.trim().match(/^#?\s*(\d+)\s*-?\s*c\s*(\d+)$/i);
  return m ? { parent: Number(m[1]), seq: Number(m[2]) } : null;
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
      message: `Callback #${job.displayNumber} is marked not chargeable, so nothing is billed. Change it to chargeable first.`,
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
  const [maxRow] = await db.select({ max: sql<number>`coalesce(max(${schema.jobs.number}), 200)` }).from(schema.jobs);
  const number = Number(maxRow?.max ?? 200) + 1;
  const displayNumber = `${original.number}-C${seq}`;

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
      // Not chargeable: no value, so the forecast never expects money from it.
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
      detail: `Callback #${displayNumber} created from job #${original.number}. ${causeLabel}, ${v.chargeable ? "chargeable" : "not chargeable"}${isInstallerError ? `, installer ${payInstaller ? "paid" : "not paid"} for the visit` : ""}.`,
      actorName: actor.name,
      actorRole: actor.role,
    },
    {
      jobId: original.id,
      entityType: "job",
      entityId: original.id,
      action: "callback_created",
      detail: `Callback #${displayNumber} opened. ${causeLabel}.${problem ? ` ${problem.slice(0, 200)}` : ""}`,
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
  const [materials, notes, photos] = await Promise.all([
    db.select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, parentJobId)),
    db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.jobId, parentJobId), inArray(schema.activityLog.action, ["note"])))
      .orderBy(desc(schema.activityLog.createdAt))
      .limit(30),
    db.select().from(schema.taskPhotos).where(eq(schema.taskPhotos.jobId, parentJobId)).orderBy(desc(schema.taskPhotos.createdAt)),
  ]);
  return { materials, notes, photos };
}
