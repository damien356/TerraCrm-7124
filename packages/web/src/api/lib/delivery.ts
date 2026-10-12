import { ORPCError } from "@orpc/server";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { moveJobForward } from "./job-stage";
import { acceptedQuoteOf, billingOnJob, dayAt, prettyDay, raiseJobInvoice } from "./final-invoice";
import { today } from "./cashflow";

/* ---------------------------------------------------------------------------
 * The delivered step for supply only jobs (188001 fix list item 13).
 *
 * A job completes when crew finish the last dispatch on the phone. A supply
 * only job has no dispatch, so it never did. The office marks it delivered
 * instead: the proof goes in the job file under Completion, the job moves to
 * Complete with the delivered date, and the final invoice is raised for what
 * is left to bill. That invoice is ready to send. It is never emailed here.
 *
 * Supply only means the accepted quote has no labour, prep or removal lines
 * and the job has no dispatch that is still live.
 * ------------------------------------------------------------------------- */

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const WORK_KINDS = ["labour", "prep", "removal"];

export async function deliveryStatus(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const quote = await acceptedQuoteOf(jobId);
  const [work, tasks] = await Promise.all([
    quote
      ? db
          .select({ id: schema.quoteItems.id })
          .from(schema.quoteItems)
          .where(and(eq(schema.quoteItems.quoteId, quote.id), inArray(schema.quoteItems.kind, WORK_KINDS)))
          .limit(1)
      : Promise.resolve([]),
    db
      .select({ id: schema.jobTasks.id })
      .from(schema.jobTasks)
      .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
      .limit(1),
  ]);
  const supplyOnly = !!quote && work.length === 0 && tasks.length === 0;
  const delivered = await db
    .select({ id: schema.activityLog.id, detail: schema.activityLog.detail, at: schema.activityLog.createdAt, by: schema.activityLog.actorName })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.jobId, jobId), eq(schema.activityLog.action, "delivered")))
    .limit(1);
  return {
    supplyOnly,
    hasAcceptedQuote: !!quote,
    completedAt: job.completedAt ?? null,
    deliveredBy: delivered[0]?.by ?? null,
    deliveredNote: delivered[0]?.detail ?? null,
    canMark: supplyOnly && !job.completedAt,
  };
}

export interface ProofFile {
  storageKey: string;
  filename?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
}

const kindOf = (mime: string | null | undefined) =>
  (mime ?? "").startsWith("image/") ? "photo" : (mime ?? "").startsWith("video/") ? "video" : "doc";

export async function markDelivered(args: {
  jobId: number;
  /** YYYY-MM-DD */
  deliveredOn: string;
  proofs: ProofFile[];
  note?: string | null;
  actor: { name: string; role: string; userId: string };
}) {
  const st = await deliveryStatus(args.jobId);
  if (!st.hasAcceptedQuote) throw bad("The quote is not accepted yet.");
  if (!st.supplyOnly) throw bad("This job has crew work on it. It completes when crew finish their dispatch.");
  if (st.completedAt) throw bad("This job is already complete.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.deliveredOn)) throw bad("Pick the day it was delivered.");
  if (args.deliveredOn > today()) throw bad("The delivered date cannot be in the future.");
  if (!args.proofs.length) throw bad("Add a photo or proof of delivery.");
  const prefix = `jobs/${args.jobId}/completion/`;
  if (args.proofs.some((p) => !p.storageKey.startsWith(prefix))) throw bad("That proof file does not belong to this job. Upload it again.");

  const when = dayAt(args.deliveredOn);
  // Only the first of two clicks lands.
  const moved = await db
    .update(schema.jobs)
    .set({ completedAt: when, updatedAt: new Date() })
    .where(and(eq(schema.jobs.id, args.jobId), isNull(schema.jobs.completedAt)))
    .returning({ id: schema.jobs.id });
  if (!moved.length) throw bad("This job is already complete.");

  const [profile] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, args.actor.userId));
  const day = prettyDay(args.deliveredOn);
  const note = args.note?.trim() ?? "";
  await db.insert(schema.jobMedia).values(
    args.proofs.map((p) => ({
      jobId: args.jobId,
      bucket: "completion",
      kind: kindOf(p.mime),
      storageKey: p.storageKey,
      url: p.storageKey,
      filename: p.filename ?? null,
      mime: p.mime ?? null,
      sizeBytes: p.sizeBytes ?? null,
      caption: `Proof of delivery, ${day}${note ? `. ${note}` : ""}`.slice(0, 300),
      capturedAt: when,
      uploadedByProfileId: profile?.id ?? null,
      uploaderName: args.actor.name || "Office",
    })),
  );

  await db.insert(schema.activityLog).values({
    jobId: args.jobId,
    entityType: "job",
    entityId: args.jobId,
    action: "delivered",
    detail: `Delivered ${day}. Proof filed in the job file under Completion (${args.proofs.length} file${args.proofs.length === 1 ? "" : "s"})${note ? `. ${note}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  await moveJobForward({ jobId: args.jobId, target: "complete", why: `delivered ${day}`, actor: args.actor });

  // The final invoice for what is left to bill. Ready to send, never emailed from here.
  const bill = await billingOnJob(args.jobId);
  let invoice: { id: number; ref: string; total: number } | null = null;
  let invoiceNote: string | null = null;
  if (!bill.canRaise) invoiceNote = bill.reason;
  else if (bill.finalRef) invoiceNote = `Final invoice ${bill.finalRef} was already raised.`;
  else {
    const row = await raiseJobInvoice({
      jobId: args.jobId,
      kind: "final",
      label: `Final invoice, ${bill.quoteRef ? `quote ${bill.quoteRef}` : `job ${bill.jobRef}`}, delivered ${day}`,
      completionDay: args.deliveredOn,
      actor: args.actor,
    });
    invoice = { id: row.id, ref: row.number, total: row.total };
  }
  return { completedAt: when, invoice, invoiceNote, files: args.proofs.length };
}
