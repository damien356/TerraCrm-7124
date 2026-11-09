import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { askOfficeToCheck } from "../lib/doc-classify";
import { byLine } from "../lib/file-access";

/* ---------------------------------------------------------------------------
 * Site access details a client sent in (Damien, 9 Nov 2026: document privacy).
 *
 * A reply with a lockbox, gate code or key note no longer goes straight onto
 * the job for the crew. It waits here as a proposal. The office reads it,
 * edits it if it needs to, and approves it, and only then does it join the
 * job's Site access notes the crew see. The activity feed records that it
 * happened and who did it, never the words or a code.
 * ------------------------------------------------------------------------- */

const ids = (raw: string) => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
};

async function pendingOrThrow(id: number) {
  const [p] = await db.select().from(schema.accessNoteProposals).where(eq(schema.accessNoteProposals.id, id)).limit(1);
  if (!p) throw new ORPCError("NOT_FOUND", { message: "That access note is not there any more." });
  if (p.status !== "pending") throw new ORPCError("BAD_REQUEST", { message: `Already ${p.status} by ${p.decidedByName || "the office"}.` });
  return p;
}

async function logDecision(jobId: number, id: number, action: string, detail: string, actor: { name: string; role: string }) {
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "access_note_proposal",
    entityId: id,
    action,
    detail,
    actorName: (actor.name || "Office").slice(0, 120),
    actorRole: actor.role,
  });
}

export const accessNotes = {
  /** What is waiting on a job, newest first, with the job's current notes to compare. */
  list: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const [job] = await db.select({ accessNotes: schema.jobs.accessNotes }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId)).limit(1);
    const rows = await db
      .select()
      .from(schema.accessNoteProposals)
      .where(and(eq(schema.accessNoteProposals.jobId, input.jobId), eq(schema.accessNoteProposals.status, "pending")))
      .orderBy(desc(schema.accessNoteProposals.createdAt));
    return {
      current: job?.accessNotes ?? "",
      pending: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        fromName: r.fromName,
        text: r.text,
        fileCount: ids(r.mediaIds).length,
        conflicts: r.conflicts,
        createdAt: r.createdAt,
      })),
    };
  }),

  /**
   * Add it to the job's Site access notes, as typed (or as the office edited
   * it). The notes from before are kept on the proposal, so an approval can
   * always be undone by hand.
   */
  approve: staffOnly
    .input(z.object({ id: z.number(), text: z.string().trim().min(1, "Nothing to add.").max(2000).optional() }))
    .handler(async ({ input, context }) => {
      const p = await pendingOrThrow(input.id);
      const [job] = await db.select({ accessNotes: schema.jobs.accessNotes }).from(schema.jobs).where(eq(schema.jobs.id, p.jobId)).limit(1);
      if (!job) throw new ORPCError("NOT_FOUND", { message: "That job is not there." });
      const by = context.actor.name || "Office";
      const before = job.accessNotes ?? "";
      const words = (input.text ?? p.text).trim();
      const when = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Brisbane" });
      const added = `${words}\n(from ${p.fromName || "the client"} by ${p.channel === "sms" ? "text" : "email"}, approved by ${by} ${when})`;
      const next = before.trim() ? `${before.trim()}\n\n${added}` : added;
      // Claim it first, so two people pressing Approve at once add it once.
      const claimed = await db
        .update(schema.accessNoteProposals)
        .set({ status: "approved", previousNotes: before, decidedByName: by, decidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.accessNoteProposals.id, p.id), eq(schema.accessNoteProposals.status, "pending")))
        .returning({ id: schema.accessNoteProposals.id });
      if (!claimed.length) throw new ORPCError("BAD_REQUEST", { message: "Someone else just dealt with this one." });
      await db.update(schema.jobs).set({ accessNotes: next, updatedAt: new Date() }).where(eq(schema.jobs.id, p.jobId));
      await logDecision(p.jobId, p.id, "access_note_approved", `Site access note from the client added to the job by ${byLine(context.actor)}. The crew can see it now.`, context.actor);
      await askOfficeToCheck(p.jobId);
      return { ok: true };
    }),

  /** Not right, or already on the job. Nothing changes on the job. */
  dismiss: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const p = await pendingOrThrow(input.id);
    const by = context.actor.name || "Office";
    await db
      .update(schema.accessNoteProposals)
      .set({ status: "dismissed", decidedByName: by, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.accessNoteProposals.id, p.id));
    await logDecision(p.jobId, p.id, "access_note_dismissed", `Site access note from the client not added, by ${byLine(context.actor)}.`, context.actor);
    await askOfficeToCheck(p.jobId);
    return { ok: true };
  }),
};
