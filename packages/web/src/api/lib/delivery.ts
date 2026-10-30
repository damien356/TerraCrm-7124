import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { moveJobForward } from "./job-stage";
import { acceptedQuoteOf, billingOnJob, dayAt, prettyDay, raiseJobInvoice } from "./final-invoice";
import { todayLocal } from "./local-date";

/* ---------------------------------------------------------------------------
 * The delivered step for supply only jobs (188001 fix list item 13), now
 * with collection and part handovers (Damien, 30 Oct, Fix 1).
 *
 * Each handover says what left: delivered or collected, which lines and how
 * much, the day, and for a collection who took it. Delivered needs a proof
 * file. Collected may have a photo. The job completes only when nothing on
 * the accepted quote is still outstanding. Handing goods over never marks
 * anything paid.
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

/**
 * Supply only: the accepted quote has no labour, prep or removal lines and the
 * job has no dispatch that is still live. Care emails and the job completed
 * and anniversary journeys skip these jobs (Damien, 30 Oct, Fix 2).
 */
export async function supplyOnlyOf(jobId: number) {
  const quote = await acceptedQuoteOf(jobId);
  if (!quote) return { supplyOnly: false, quote: null };
  const [work, tasks] = await Promise.all([
    db
      .select({ id: schema.quoteItems.id })
      .from(schema.quoteItems)
      .where(and(eq(schema.quoteItems.quoteId, quote.id), inArray(schema.quoteItems.kind, WORK_KINDS)))
      .limit(1),
    db
      .select({ id: schema.jobTasks.id })
      .from(schema.jobTasks)
      .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")))
      .limit(1),
  ]);
  return { supplyOnly: work.length === 0 && tasks.length === 0, quote };
}

export async function deliveryStatus(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const { supplyOnly, quote } = await supplyOnlyOf(jobId);
  const delivered = await db
    .select({ id: schema.activityLog.id, detail: schema.activityLog.detail, at: schema.activityLog.createdAt, by: schema.activityLog.actorName })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.jobId, jobId), inArray(schema.activityLog.action, ["delivered", "collected"])))
    .limit(1);
  const h = supplyOnly ? await handoverView(jobId, quote, job.completedAt ?? null) : { lines: [], handovers: [], outstanding: 0, legacy: false };
  return {
    supplyOnly,
    hasAcceptedQuote: !!quote,
    completedAt: job.completedAt ?? null,
    deliveredBy: delivered[0]?.by ?? null,
    deliveredNote: delivered[0]?.detail ?? null,
    canMark: supplyOnly && !job.completedAt,
    ...h,
  };
}

const GOODS_KINDS = ["supply", "accessory", "other"];
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
const qtyText = (n: number, unit: string) => `${r4(n)} ${unit === "m2" ? "m²" : unit}`;

/** The goods lines on the accepted quote, each with how much has been handed over and how much is still to go. */
async function handoverView(jobId: number, quote: typeof schema.quotes.$inferSelect | null, completedAt: Date | null) {
  const items = quote
    ? (
        await db
          .select()
          .from(schema.quoteItems)
          .where(and(eq(schema.quoteItems.quoteId, quote.id), inArray(schema.quoteItems.kind, GOODS_KINDS)))
          .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id))
      ).filter((i) => i.qty > 0)
    : [];
  const rows = await db.select().from(schema.supplyHandovers).where(eq(schema.supplyHandovers.jobId, jobId)).orderBy(asc(schema.supplyHandovers.id));
  // Completed before quantities were kept: everything went.
  const legacy = !!completedAt && rows.length === 0;
  const ids = new Set(items.map((i) => i.id));
  const lines = items.map((i) => {
    const mine = rows.filter(
      (r) => r.quoteItemId === i.id || ((r.quoteItemId == null || !ids.has(r.quoteItemId)) && r.description === i.description && (r.productId ?? null) === (i.productId ?? null)),
    );
    const supplied = legacy ? i.qty : r4(mine.reduce((s, r) => s + r.qty, 0));
    return {
      quoteItemId: i.id,
      productId: i.productId,
      description: i.description,
      unit: i.unit,
      qty: i.qty,
      supplied,
      outstanding: r4(Math.max(0, i.qty - supplied)),
    };
  });
  const batches = new Map<string, { batchKey: string; kind: string; handedOn: string; collectedBy: string; note: string; by: string; lines: { description: string; qty: number; unit: string }[] }>();
  for (const r of rows) {
    const b = batches.get(r.batchKey) ?? { batchKey: r.batchKey, kind: r.kind, handedOn: r.handedOn, collectedBy: r.collectedBy, note: r.note, by: r.actorName, lines: [] };
    if (r.qty > 0) b.lines.push({ description: r.description, qty: r.qty, unit: r.unit });
    batches.set(r.batchKey, b);
  }
  return {
    lines,
    handovers: [...batches.values()].reverse(),
    outstanding: lines.filter((l) => l.outstanding > 0.00005).length,
    legacy,
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

const jobLocks = new Map<number, Promise<unknown>>();
async function oneJobAtATime<T>(jobId: number, fn: () => Promise<T>): Promise<T> {
  const prev = jobLocks.get(jobId) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => undefined);
  jobLocks.set(jobId, tail);
  try {
    return await run;
  } finally {
    if (jobLocks.get(jobId) === tail) jobLocks.delete(jobId);
  }
}

export type HandoverArgs = {
  jobId: number;
  kind: "delivered" | "collected";
  /** YYYY-MM-DD */
  on: string;
  /** Null: everything still outstanding. */
  lines: { quoteItemId: number; qty: number }[] | null;
  collectedBy?: string | null;
  proofs: ProofFile[];
  note?: string | null;
  /** The form's key. The same key twice records it once. */
  batchKey: string;
  actor: { name: string; role: string; userId: string };
};

/**
 * Record goods delivered or collected. When nothing is left outstanding the
 * job moves to Complete and the final invoice is raised for anything not
 * billed yet (a sale invoiced up front has nothing left, so none is raised).
 * Nothing is emailed and nothing is marked paid.
 */
export async function recordHandover(args: HandoverArgs) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.on)) throw bad(`Pick the day it was ${args.kind}.`);
  /* Gold Coast date. today() is the server clock, which is UTC and still yesterday until 10 am here. */
  if (args.on > todayLocal()) throw bad(`The ${args.kind} date cannot be in the future.`);
  const collectedBy = (args.collectedBy ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (args.kind === "collected" && !collectedBy) throw bad("Type who collected it.");
  if (args.kind === "delivered" && !args.proofs.length) throw bad("Add a photo or proof of delivery.");
  const prefix = `jobs/${args.jobId}/completion/`;
  if (args.proofs.some((p) => !p.storageKey.startsWith(prefix))) throw bad("That file does not belong to this job. Upload it again.");
  const batchKey = args.batchKey.trim();
  if (batchKey.length < 8) throw bad("Refresh the page and try again.");

  return oneJobAtATime(args.jobId, async () => {
    const [seen] = await db.select({ id: schema.supplyHandovers.id }).from(schema.supplyHandovers).where(eq(schema.supplyHandovers.batchKey, batchKey)).limit(1);
    if (seen) {
      const st = await deliveryStatus(args.jobId);
      return { reused: true, completedAt: st.completedAt, invoice: null, invoiceNote: null, files: 0, outstanding: st.outstanding };
    }
    const st = await deliveryStatus(args.jobId);
    if (!st.hasAcceptedQuote) throw bad("The quote is not accepted yet.");
    if (!st.supplyOnly) throw bad("This job has crew work on it. It completes when crew finish their dispatch.");
    if (st.completedAt) throw bad("This job is already complete. Everything has been handed over.");

    const want = args.lines ?? st.lines.map((l) => ({ quoteItemId: l.quoteItemId, qty: l.outstanding }));
    const picked: { line: (typeof st.lines)[number]; qty: number }[] = [];
    for (const w of want) {
      const line = st.lines.find((l) => l.quoteItemId === w.quoteItemId);
      if (!line) throw bad("A line on this form is no longer on the accepted quote. Refresh the page.");
      const qty = r4(w.qty);
      if (qty < 0) throw bad(`"${line.description}" can not be less than 0.`);
      if (qty === 0) continue;
      if (qty > line.outstanding + 0.00005) {
        throw bad(`"${line.description}": only ${qtyText(line.outstanding, line.unit)} is still to go, not ${qtyText(qty, line.unit)}.`);
      }
      picked.push({ line, qty });
    }
    if (!picked.length && st.lines.length) throw bad("Type how much of at least one line went.");

    const day = prettyDay(args.on);
    const note = args.note?.trim().slice(0, 300) ?? "";
    const base = { jobId: args.jobId, kind: args.kind, handedOn: args.on, collectedBy, note, batchKey, actorName: args.actor.name, actorRole: args.actor.role };
    await db.insert(schema.supplyHandovers).values(
      picked.length
        ? picked.map((p) => ({ ...base, quoteItemId: p.line.quoteItemId, productId: p.line.productId, description: p.line.description, unit: p.line.unit, qty: p.qty }))
        : [{ ...base, quoteItemId: null, productId: null, description: "Everything on the job", unit: "each", qty: 0 }],
    );

    const when = dayAt(args.on);
    if (args.proofs.length) {
      const [profile] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, args.actor.userId));
      const caption = args.kind === "delivered" ? `Proof of delivery, ${day}` : `Collected by ${collectedBy}, ${day}`;
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
          caption: `${caption}${note ? `. ${note}` : ""}`.slice(0, 300),
          capturedAt: when,
          uploadedByProfileId: profile?.id ?? null,
          uploaderName: args.actor.name || "Office",
        })),
      );
    }

    const after = await deliveryStatus(args.jobId);
    const left = after.lines.filter((l) => l.outstanding > 0.00005);
    const what = picked.map((p) => {
      const l = after.lines.find((x) => x.quoteItemId === p.line.quoteItemId);
      return `- ${p.line.description}: ${qtyText(p.qty, p.line.unit)}${l && l.outstanding > 0.00005 ? `, ${qtyText(l.outstanding, l.unit)} still to go` : ", all supplied"}`;
    });
    await db.insert(schema.activityLog).values({
      jobId: args.jobId,
      entityType: "job",
      entityId: args.jobId,
      action: args.kind,
      detail: [
        args.kind === "delivered" ? `Delivered ${day}.` : `Collected ${day} by ${collectedBy}.`,
        ...what,
        args.proofs.length ? `${args.proofs.length} file${args.proofs.length === 1 ? "" : "s"} filed in the job file under Completion.` : "",
        note,
        left.length ? `${left.length} line${left.length === 1 ? "" : "s"} still outstanding.` : "Nothing left outstanding.",
        "Payment is not changed by this.",
      ]
        .filter(Boolean)
        .join("\n"),
      actorName: args.actor.name,
      actorRole: args.actor.role,
    });
    if (left.length) return { reused: false, completedAt: null, invoice: null, invoiceNote: null, files: args.proofs.length, outstanding: left.length };

    // Nothing left: the job is complete. Only the first of two lands.
    const moved = await db
      .update(schema.jobs)
      .set({ completedAt: when, updatedAt: new Date() })
      .where(and(eq(schema.jobs.id, args.jobId), isNull(schema.jobs.completedAt)))
      .returning({ id: schema.jobs.id });
    if (!moved.length) return { reused: false, completedAt: after.completedAt, invoice: null, invoiceNote: null, files: args.proofs.length, outstanding: 0 };
    const how = args.kind === "delivered" ? `delivered ${day}` : `collected ${day}`;
    await moveJobForward({ jobId: args.jobId, target: "complete", why: `everything ${how}`, actor: args.actor });

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
        label: `Final invoice, ${bill.quoteRef ? `quote ${bill.quoteRef}` : `job ${bill.jobRef}`}, ${how}`,
        completionDay: args.on,
        actor: args.actor,
      });
      invoice = { id: row.id, ref: row.number, total: row.total };
    }
    return { reused: false, completedAt: when, invoice, invoiceNote, files: args.proofs.length, outstanding: 0 };
  });
}

/** The older one step Mark delivered: everything still outstanding went on that day. */
export async function markDelivered(args: {
  jobId: number;
  /** YYYY-MM-DD */
  deliveredOn: string;
  proofs: ProofFile[];
  note?: string | null;
  actor: { name: string; role: string; userId: string };
}) {
  return recordHandover({
    jobId: args.jobId,
    kind: "delivered",
    on: args.deliveredOn,
    lines: null,
    proofs: args.proofs,
    note: args.note,
    batchKey: `all:${args.jobId}:${Date.now()}`,
    actor: args.actor,
  });
}
