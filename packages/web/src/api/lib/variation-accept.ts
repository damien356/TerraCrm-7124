import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { assertBillable } from "./callbacks";
import { insertDispatchForLines, type WorkLine } from "./dispatch-build";
import { pushToOffice } from "./push";
import { jobText } from "./refs";
import { addressedFor } from "./variation-send";
import { bad, itemsOf, money, SUPPLY_KINDS, variationOrThrow, WORK_KINDS, type Variation, type VariationItem } from "./variations";

/* ---------------------------------------------------------------------------
 * Accepting a variation (item 12). Staff pressing Accepted and a client
 * signing online both come through here:
 *
 *   lock it (only from draft or sent, and only once), add its total to the
 *   job value, make its work once: labour, prep and removal lines become a
 *   new unassigned dispatch, supply and accessory lines become materials to
 *   order. Then an office task, a log line, and a push when it was online.
 *
 * A variation is never invoiced on its own and never takes a deposit. It
 * stays approved and goes on the final invoice (homeowner) or the end invoice
 * (company billed). A company billed job also needs an updated work order
 * from the supervisor before it is invoiced, so the task says so.
 * ------------------------------------------------------------------------- */

/** Shown on accept, on the office task and on the card for a company billed job. */
export const WORK_ORDER_WARNING = "Get an updated work order from the supervisor that covers this variation before invoicing.";

export type VariationActor = { name: string; role: string };

/** A variation line in the shape the dispatch builder reads. */
function asWorkLine(l: VariationItem): WorkLine {
  return { ...l, quoteId: 0, labourForItemId: null, measuredM2: null } as unknown as WorkLine;
}

/** Its dispatch and materials, once. The `workMadeAt` claim stops a second run. */
export async function makeVariationWork(v: Variation) {
  const now = new Date();
  const [claimed] = await db
    .update(schema.variations)
    .set({ workMadeAt: now, updatedAt: now })
    .where(and(eq(schema.variations.id, v.id), sql`${schema.variations.workMadeAt} is null`))
    .returning({ id: schema.variations.id });
  if (!claimed) return { taskId: null as number | null, materials: 0, skipped: true };

  const lines = await itemsOf(v.id);
  const work = lines.filter((l) => WORK_KINDS.has(l.kind));
  const supply = lines.filter((l) => SUPPLY_KINDS.has(l.kind));
  if (supply.length) {
    await db.insert(schema.jobMaterials).values(
      supply.map((l) => ({ jobId: v.jobId, productId: l.productId, description: l.description, qty: l.qty, unit: l.unit, status: "to_order" })),
    );
  }
  let taskId: number | null = null;
  if (work.length) {
    const [job] = await db.select({ furnitureOnSite: schema.jobs.furnitureOnSite }).from(schema.jobs).where(eq(schema.jobs.id, v.jobId));
    const [top] = await db.select({ max: sql<number>`coalesce(max(${schema.jobTasks.seq}), 0)` }).from(schema.jobTasks).where(eq(schema.jobTasks.jobId, v.jobId));
    // mark=false: this is not the quote's dispatch, so a later quote version leaves it alone.
    const task = await insertDispatchForLines(
      v.jobId,
      work.map(asWorkLine),
      supply.map(asWorkLine),
      Number(top?.max ?? 0) + 1,
      job?.furnitureOnSite ?? false,
      v.quoteId ?? 0,
      false,
    );
    taskId = task.id;
    const extra = `From variation ${v.ref}.`;
    await db
      .update(schema.jobTasks)
      .set({ description: [extra, task.description].filter(Boolean).join("\n"), updatedAt: new Date() })
      .where(eq(schema.jobTasks.id, task.id));
  }
  await db.insert(schema.activityLog).values({
    jobId: v.jobId,
    taskId,
    entityType: "variation",
    entityId: v.id,
    action: "work_made",
    detail: `Made from variation ${v.ref}: ${taskId ? "1 dispatch" : "no dispatch"}, ${supply.length} material${supply.length === 1 ? "" : "s"} to order`,
    actorName: "Terra Ops",
    actorRole: "system",
  });
  return { taskId, materials: supply.length, skipped: false };
}

export async function acceptVariation(args: { id: number; actor: VariationActor; via: "staff" | "online"; note?: string | null }) {
  const v = await variationOrThrow(args.id);
  if (v.status === "approved" || v.status === "invoiced") throw bad(`Variation ${v.ref} is already accepted.`);
  if (v.status === "rejected") throw bad(`Variation ${v.ref} was declined. Make a new one.`);
  if (args.via === "online" && v.status !== "sent") throw bad("This variation is not ready to accept yet.");
  if (!(v.total > 0)) throw bad("This variation comes to $0. Add its lines first.");
  await assertBillable(v.jobId);

  const now = new Date();
  const [locked] = await db
    .update(schema.variations)
    .set({ status: "approved", approvedAt: now, approvedByName: args.actor.name, approvalChannel: args.via === "online" ? "online" : "staff", updatedAt: now })
    .where(and(eq(schema.variations.id, v.id), eq(schema.variations.status, v.status)))
    .returning();
  if (!locked) throw bad("This variation just changed. Refresh and try again.");

  await db
    .update(schema.jobs)
    .set({ value: sql`coalesce(${schema.jobs.value}, 0) + ${locked.total}`, updatedAt: now })
    .where(eq(schema.jobs.id, locked.jobId));

  const work = await makeVariationWork(locked);
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, locked.jobId));
  const jobRef = job ? jobText(job) : String(locked.jobId);
  const billedToCompany = (await addressedFor(locked)).billedToCompany;

  await db.insert(schema.activityLog).values({
    jobId: locked.jobId,
    entityType: "variation",
    entityId: locked.id,
    action: "variation_accepted",
    detail: `Variation ${locked.ref} accepted${args.via === "online" ? ` online by ${args.actor.name}` : " by the office"}, ${money(locked.total)}. Job value now ${money(job?.value ?? 0)}${args.note?.trim() ? `. ${args.note.trim()}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });

  const lines = await itemsOf(locked.id);
  const taskDetail = [
    `Variation ${locked.ref} accepted, ${money(locked.total)}.`,
    billedToCompany ? "It goes on the end invoice." : "It goes on the final invoice.",
    billedToCompany ? WORK_ORDER_WARNING : "",
    work.materials ? `${work.materials} material${work.materials === 1 ? "" : "s"} to order.` : "",
    work.taskId ? "A new dispatch is on the job for the extra work. Book it in." : "",
    lines.some((l) => !SUPPLY_KINDS.has(l.kind) && !WORK_KINDS.has(l.kind)) ? "It has other lines. Check if anything else needs doing." : "",
  ]
    .filter(Boolean)
    .join("\n");
  const [task] = await db
    .insert(schema.officeTasks)
    .values({ jobId: locked.jobId, title: `Variation ${locked.ref} accepted, job ${jobRef}`, detail: taskDetail, createdByName: args.actor.name })
    .returning();

  if (args.via === "online") {
    await pushToOffice({
      title: `Variation ${locked.ref} accepted online`,
      body: `${args.actor.name} accepted ${money(locked.total)}.${billedToCompany ? " Get an updated work order before invoicing." : ""}`,
      data: { kind: "job", jobId: locked.jobId },
    }).catch((e) => console.error("[variation] push failed:", e));
  }

  const [fresh] = await db.select().from(schema.variations).where(eq(schema.variations.id, locked.id));
  return { variation: fresh ?? locked, work, billedToCompany, taskId: task?.id ?? null };
}

export async function rejectVariation(args: { id: number; actor: VariationActor; via: "staff" | "online"; reason?: string | null }) {
  const v = await variationOrThrow(args.id);
  if (!["draft", "sent"].includes(v.status)) throw bad(`Variation ${v.ref} is already ${v.status === "rejected" ? "declined" : "accepted"}.`);
  if (args.via === "online" && v.status !== "sent") throw bad("This variation is not open.");
  const now = new Date();
  const [row] = await db
    .update(schema.variations)
    .set({ status: "rejected", rejectedAt: now, updatedAt: now })
    .where(and(eq(schema.variations.id, v.id), inArray(schema.variations.status, ["draft", "sent"])))
    .returning();
  if (!row) throw bad("This variation just changed. Refresh and try again.");
  const why = args.reason?.trim();
  await db.insert(schema.activityLog).values({
    jobId: v.jobId,
    entityType: "variation",
    entityId: v.id,
    action: "variation_rejected",
    detail: `Variation ${v.ref} declined${args.via === "online" ? ` online by ${args.actor.name}` : ""}${why ? `: ${why}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  if (args.via === "online") {
    await pushToOffice({
      title: `Variation ${v.ref} declined online`,
      body: `${args.actor.name} declined ${money(v.total)}${why ? `: ${why.slice(0, 140)}` : "."}`,
      data: { kind: "job", jobId: v.jobId },
    }).catch((e) => console.error("[variation] push failed:", e));
  }
  return row;
}
