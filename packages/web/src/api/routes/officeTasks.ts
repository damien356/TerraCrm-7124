import { z } from "zod";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";

/* ---------------------------------------------------------------------------
 * Office to-dos and timed reminders, mostly made by voice memos.
 *
 * The dashboard and the phone's Office tab read `open`. A reminder whose time
 * has come shows as due here whether or not a phone got the push.
 * ------------------------------------------------------------------------- */

const row = {
  id: schema.officeTasks.id,
  title: schema.officeTasks.title,
  detail: schema.officeTasks.detail,
  dueDate: schema.officeTasks.dueDate,
  remindAt: schema.officeTasks.remindAt,
  remindedAt: schema.officeTasks.remindedAt,
  status: schema.officeTasks.status,
  assignedName: schema.officeTasks.assignedName,
  createdByName: schema.officeTasks.createdByName,
  createdAt: schema.officeTasks.createdAt,
  jobId: schema.officeTasks.jobId,
  jobNumber: schema.jobs.number,
  jobTitle: schema.jobs.title,
};

export const officeTasks = {
  /** Everything open: timed reminders first by time, then dated tasks, then the rest. */
  open: adminOnly.handler(async () => {
    const rows = await db
      .select(row)
      .from(schema.officeTasks)
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.officeTasks.jobId))
      .where(eq(schema.officeTasks.status, "open"))
      .orderBy(
        sql`case when ${schema.officeTasks.remindAt} is null then 1 else 0 end`,
        asc(schema.officeTasks.remindAt),
        sql`case when ${schema.officeTasks.dueDate} is null then 1 else 0 end`,
        asc(schema.officeTasks.dueDate),
        desc(schema.officeTasks.createdAt),
      )
      .limit(100);
    const now = Date.now();
    return rows.map((r) => ({
      ...r,
      due: r.remindAt ? r.remindAt.getTime() <= now : false,
    }));
  }),

  complete: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [t] = await db
      .update(schema.officeTasks)
      .set({ status: "done", completedAt: new Date(), completedByName: context.actor.name, updatedAt: new Date() })
      .where(and(eq(schema.officeTasks.id, input.id), eq(schema.officeTasks.status, "open")))
      .returning();
    if (!t) throw new ORPCError("NOT_FOUND", { message: "That task is already done or gone." });
    return { ok: true };
  }),

  /** Push it back. Clears remindedAt so the phone is nudged again at the new time. */
  snooze: adminOnly
    .input(z.object({ id: z.number(), minutes: z.number().int().min(5).max(60 * 24 * 14) }))
    .handler(async ({ input }) => {
      const remindAt = new Date(Date.now() + input.minutes * 60_000);
      const [t] = await db
        .update(schema.officeTasks)
        .set({ remindAt, remindedAt: null, updatedAt: new Date() })
        .where(and(eq(schema.officeTasks.id, input.id), eq(schema.officeTasks.status, "open")))
        .returning();
      if (!t) throw new ORPCError("NOT_FOUND", { message: "That task is already done or gone." });
      return { ok: true, remindAt };
    }),
};
