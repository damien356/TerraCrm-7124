import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { GST_RATE } from "./gst";
import { syncJobValue } from "./job-value";
import { quoteRefOf } from "./quote-number";
import { jobText } from "./refs";
import { acceptedQuoteFor, COUNTED_STATUSES } from "./variations";
import { bundlesFor } from "../routes/quoteBundles";

/* ---------------------------------------------------------------------------
 * An agreed whole-job price revision (Damien, 18 Nov 2026, job 188070).
 *
 * The builder and Terra settle on one figure for the whole job in place of
 * the accepted quote plus the variations it covers. The scope does not move,
 * so nothing is re-quoted and no variation is made (approving a variation
 * makes dispatch tasks and materials). The quote, its variations and every
 * document already sent stay exactly as they are.
 *
 * While a revision is active:
 *  - the job value is the revised figure, plus any variation approved later
 *    (lib/job-value.ts);
 *  - invoices bill the job's Bill to, not the quote's, so a changed payer
 *    reaches the invoice (lib/client-invoices.ts, lib/final-invoice.ts);
 *  - the final invoice shows one fixed price line with the scope words, and
 *    the billing summary starts from the agreed price (lib/invoice-summary.ts,
 *    lib/clientInvoicePdf.ts);
 *  - while the builder has only called it a budget or allowance, no invoice
 *    on it can be emailed or sent to Xero until Damien confirms the price.
 *
 * Only one revision is active on a job at a time. It applies to the accepted
 * quote it was made on; accepting a different version leaves it behind.
 * ------------------------------------------------------------------------- */

export type PriceRevision = typeof schema.jobPriceRevisions.$inferSelect;

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n < 0 ? "-" : "+"}${money(Math.abs(n))}`;

export const BUILDER_POSITIONS = ["budget_allowance", "confirmed"] as const;
export const BUILDER_POSITION_LABEL: Record<string, string> = {
  budget_allowance: "Budget or allowance, price not confirmed",
  confirmed: "Confirmed",
};
export const CONFIRM_TASK_TITLE = "Confirm the revised price";

export function includedIds(rev: Pick<PriceRevision, "includedVariationIds">): number[] {
  try {
    const v = JSON.parse(rev.includedVariationIds || "[]");
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The job's active revision, only while it still sits on the accepted quote it
 * was made on. Null otherwise.
 */
export async function activeRevision(jobId: number, acceptedQuoteId?: number | null): Promise<PriceRevision | null> {
  const [rev] = await db
    .select()
    .from(schema.jobPriceRevisions)
    .where(and(eq(schema.jobPriceRevisions.jobId, jobId), eq(schema.jobPriceRevisions.status, "active")))
    .orderBy(desc(schema.jobPriceRevisions.id))
    .limit(1);
  if (!rev) return null;
  const quoteId = acceptedQuoteId === undefined ? ((await acceptedQuoteFor(jobId))?.id ?? null) : acceptedQuoteId;
  if (rev.quoteId && rev.quoteId !== quoteId) return null;
  return rev;
}

/** Approved variations on the job the revision does not cover: approved after it, so they still add on. */
export async function laterVariations(jobId: number, rev: PriceRevision) {
  const ids = new Set(includedIds(rev));
  const rows = await db
    .select({ id: schema.variations.id, ref: schema.variations.ref, description: schema.variations.description, subtotal: schema.variations.subtotal, total: schema.variations.total })
    .from(schema.variations)
    .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, [...COUNTED_STATUSES])))
    .orderBy(asc(schema.variations.seq));
  return rows.filter((v) => !ids.has(v.id));
}

/** The job value while the revision is active, inc GST. */
export async function revisedJobValue(jobId: number, rev: PriceRevision) {
  const later = await laterVariations(jobId, rev);
  return r2(rev.toTotal + later.reduce((s, v) => s + (v.total ?? 0), 0));
}

/** What the record form starts from: the figure now, the variations it would cover and the scope words. */
export async function revisionDraft(jobId: number) {
  const quote = await acceptedQuoteFor(jobId);
  if (!quote) return null;
  const vars = await db
    .select({ id: schema.variations.id, ref: schema.variations.ref, description: schema.variations.description, subtotal: schema.variations.subtotal, total: schema.variations.total })
    .from(schema.variations)
    .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, [...COUNTED_STATUSES])))
    .orderBy(asc(schema.variations.seq));
  const { bundles } = await bundlesFor(quote);
  const wording = [
    ...bundles.map((b) => (b.wording || b.title || "").trim()).filter(Boolean),
    ...vars.map((v) => (v.description || "").trim()).filter(Boolean),
  ].join("\n");
  return {
    quote: { id: quote.id, ref: await quoteRefOf(quote), subtotal: r2(quote.subtotal), total: r2(quote.total) },
    variations: vars.map((v) => ({ ...v, subtotal: r2(v.subtotal), total: r2(v.total) })),
    fromSubtotal: r2(quote.subtotal + vars.reduce((s, v) => s + (v.subtotal ?? 0), 0)),
    fromTotal: r2(quote.total + vars.reduce((s, v) => s + (v.total ?? 0), 0)),
    wording,
  };
}

/**
 * Record the agreed figure. Ex GST in, GST at 10% on top. Refused when one is
 * already active (withdraw it first) or the job has no accepted quote.
 */
export async function recordRevision(args: {
  jobId: number;
  /** The agreed figure, ex GST. */
  toSubtotal: number;
  reason: string;
  builderPosition: (typeof BUILDER_POSITIONS)[number];
  builderNote?: string | null;
  invoiceWording: string;
  /** Left out: every approved variation on the job now. */
  includedVariationIds?: number[] | null;
  actor: { name: string; role: string };
}) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const draft = await revisionDraft(job.id);
  if (!draft) throw bad("The job has no accepted quote. A price revision replaces an accepted quote's figure.");
  if (await activeRevision(job.id, draft.quote.id)) throw bad("This job already has a revised price. Withdraw it first to record a different one.");
  const reason = args.reason.trim();
  if (!reason) throw bad("Give a reason for the revised price.");
  const wording = args.invoiceWording.trim();
  if (!wording) throw bad("Give the scope words the invoice will show.");
  const toSubtotal = r2(args.toSubtotal);
  if (!(toSubtotal > 0)) throw bad("Enter the agreed price, ex GST, over $0.");

  const known = new Map(draft.variations.map((v) => [v.id, v]));
  const ids = args.includedVariationIds ?? draft.variations.map((v) => v.id);
  for (const id of ids) if (!known.has(id)) throw bad(`Variation ${id} is not an approved variation on this job.`);
  const fromSubtotal = r2(draft.quote.subtotal + ids.reduce((s, id) => s + (known.get(id)?.subtotal ?? 0), 0));
  const fromTotal = r2(draft.quote.total + ids.reduce((s, id) => s + (known.get(id)?.total ?? 0), 0));
  const toGst = r2(toSubtotal * GST_RATE);
  const toTotal = r2(toSubtotal + toGst);

  const [rev] = await db
    .insert(schema.jobPriceRevisions)
    .values({
      jobId: job.id,
      quoteId: draft.quote.id,
      fromSubtotal,
      fromTotal,
      toSubtotal,
      toGst,
      toTotal,
      diffSubtotal: r2(toSubtotal - fromSubtotal),
      diffTotal: r2(toTotal - fromTotal),
      reason: reason.slice(0, 500),
      scopeUnchanged: true,
      builderPosition: args.builderPosition,
      builderNote: args.builderNote?.trim() || null,
      invoiceWording: wording.slice(0, 4000),
      includedVariationIds: JSON.stringify(ids),
      createdByName: args.actor.name,
    })
    .returning();
  if (!rev) throw bad("The revised price could not be saved. Try again.");

  const covers = [draft.quote.ref, ...ids.map((id) => known.get(id)?.ref).filter(Boolean)].join(" and ");
  const flag = rev.builderPosition === "budget_allowance" ? "Builder called it a budget allowance, price not confirmed." : "Builder confirmed the price.";
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "price_revision",
    entityId: rev.id,
    action: "price_revised",
    detail: [
      `Agreed whole-job price revision. Was ${money(fromSubtotal)} ex GST, ${money(fromTotal)} inc GST (${covers}).`,
      `Now ${money(toSubtotal)} ex GST, ${money(toGst)} GST, ${money(toTotal)} inc GST. Replaces the figure, not added on top.`,
      `Difference ${signed(rev.diffSubtotal)} ex GST, ${signed(rev.diffTotal)} inc GST.`,
      `Reason: ${rev.reason}.`,
      flag,
      rev.builderNote ? `Note: ${rev.builderNote}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  if (rev.builderPosition === "budget_allowance") {
    await db.insert(schema.officeTasks).values({
      jobId: job.id,
      title: `${CONFIRM_TASK_TITLE}, job ${jobText(job)}`,
      detail: `The builder called ${money(toTotal)} inc GST their budget or allowance. Confirm the price with them, then press Confirm price on the job's Agreed price card. No invoice on this price can be emailed until then.`,
      createdByName: args.actor.name,
      adminOnly: true,
    });
  }
  await syncJobValue(job.id);
  return rev;
}

/** Damien has the builder's confirmation. Closes the confirm task. */
export async function confirmRevision(args: { id: number; note?: string | null; actor: { name: string; role: string } }) {
  const [rev] = await db.select().from(schema.jobPriceRevisions).where(eq(schema.jobPriceRevisions.id, args.id));
  if (!rev || rev.status !== "active") throw bad("That revised price is not active.");
  if (rev.builderPosition === "confirmed") return rev;
  const now = new Date();
  const note = args.note?.trim() || null;
  const [row] = await db
    .update(schema.jobPriceRevisions)
    .set({
      builderPosition: "confirmed",
      confirmedAt: now,
      confirmedByName: args.actor.name,
      builderNote: note ? [rev.builderNote, `Confirmed: ${note}`].filter(Boolean).join("\n") : rev.builderNote,
      updatedAt: now,
    })
    .where(and(eq(schema.jobPriceRevisions.id, rev.id), eq(schema.jobPriceRevisions.builderPosition, "budget_allowance")))
    .returning();
  await db
    .update(schema.officeTasks)
    .set({ status: "done", completedAt: now, completedByName: args.actor.name, updatedAt: now })
    .where(and(eq(schema.officeTasks.jobId, rev.jobId), eq(schema.officeTasks.status, "open"), like(schema.officeTasks.title, `${CONFIRM_TASK_TITLE}%`)));
  await db.insert(schema.activityLog).values({
    jobId: rev.jobId,
    entityType: "price_revision",
    entityId: rev.id,
    action: "price_revision_confirmed",
    detail: `Revised price ${money(rev.toTotal)} inc GST confirmed with the builder.${note ? ` ${note}` : ""}`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  return row ?? rev;
}

/** Back to the quote's figure. Refused while an invoice that is not void bills it. */
export async function withdrawRevision(args: { id: number; reason: string; actor: { name: string; role: string } }) {
  const [rev] = await db.select().from(schema.jobPriceRevisions).where(eq(schema.jobPriceRevisions.id, args.id));
  if (!rev || rev.status !== "active") throw bad("That revised price is not active.");
  const reason = args.reason.trim();
  if (!reason) throw bad("Say why it is withdrawn.");
  const live = await db
    .select({ number: schema.invoices.number })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.priceRevisionId, rev.id), sql`${schema.invoices.status} != 'void'`));
  if (live.length) throw bad(`${live.map((i) => i.number).join(", ")} bills this price. Void it first, then withdraw the price.`);
  const now = new Date();
  await db
    .update(schema.jobPriceRevisions)
    .set({ status: "withdrawn", withdrawnAt: now, withdrawnByName: args.actor.name, updatedAt: now })
    .where(eq(schema.jobPriceRevisions.id, rev.id));
  await db
    .update(schema.officeTasks)
    .set({ status: "done", completedAt: now, completedByName: args.actor.name, updatedAt: now })
    .where(and(eq(schema.officeTasks.jobId, rev.jobId), eq(schema.officeTasks.status, "open"), like(schema.officeTasks.title, `${CONFIRM_TASK_TITLE}%`)));
  await db.insert(schema.activityLog).values({
    jobId: rev.jobId,
    entityType: "price_revision",
    entityId: rev.id,
    action: "price_revision_withdrawn",
    detail: `Revised price ${money(rev.toTotal)} inc GST withdrawn: ${reason}. The job goes back to the quote and its variations.`,
    actorName: args.actor.name,
    actorRole: args.actor.role,
  });
  await syncJobValue(rev.jobId);
  return { ok: true as const };
}

/**
 * Why an invoice cannot be emailed or sent to Xero yet: it bills a revised
 * price the builder has only called a budget or allowance. Null when it can.
 */
export async function revisionSendBlocker(inv: Pick<typeof schema.invoices.$inferSelect, "priceRevisionId" | "number">) {
  if (!inv.priceRevisionId) return null;
  const [rev] = await db.select().from(schema.jobPriceRevisions).where(eq(schema.jobPriceRevisions.id, inv.priceRevisionId));
  if (!rev) return null;
  if (rev.status !== "active") return `${inv.number} bills a revised price that has been withdrawn. Void it and raise a new invoice.`;
  if (rev.builderPosition !== "confirmed") {
    return `${inv.number} bills the revised price of ${money(rev.toTotal)}, which the builder called a budget or allowance. Confirm the price on the job's Agreed price card first, then send.`;
  }
  return null;
}

/** The job page card: the revision, the balance and what is left to do. */
export async function revisionView(jobId: number) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const quote = await acceptedQuoteFor(jobId);
  const rev = await activeRevision(jobId, quote?.id ?? null);
  const history = await db
    .select()
    .from(schema.jobPriceRevisions)
    .where(eq(schema.jobPriceRevisions.jobId, jobId))
    .orderBy(desc(schema.jobPriceRevisions.id));
  const invoices = await db.select().from(schema.invoices).where(eq(schema.invoices.jobId, jobId)).orderBy(asc(schema.invoices.seq));
  const live = invoices.filter((i) => i.status !== "void" && i.status !== "draft");
  const invoiced = r2(live.filter((i) => i.total > 0).reduce((s, i) => s + i.total, 0));
  const credits = r2(live.filter((i) => i.total < 0).reduce((s, i) => s + i.total, 0));
  const received = r2(live.reduce((s, i) => s + (i.amountPaid ?? 0), 0));
  const jobValue = r2(Number(job.value ?? 0));
  const later = rev ? await laterVariations(jobId, rev) : [];
  const covered = rev ? includedIds(rev) : [];
  const coveredRefs = covered.length
    ? (await db.select({ id: schema.variations.id, ref: schema.variations.ref }).from(schema.variations).where(inArray(schema.variations.id, covered))).map((v) => v.ref)
    : [];
  const shape = (r: PriceRevision) => ({
    id: r.id,
    status: r.status,
    fromSubtotal: r.fromSubtotal,
    fromTotal: r.fromTotal,
    toSubtotal: r.toSubtotal,
    toGst: r.toGst,
    toTotal: r.toTotal,
    diffSubtotal: r.diffSubtotal,
    diffTotal: r.diffTotal,
    reason: r.reason,
    scopeUnchanged: r.scopeUnchanged,
    builderPosition: r.builderPosition,
    builderPositionLabel: BUILDER_POSITION_LABEL[r.builderPosition] ?? r.builderPosition,
    builderNote: r.builderNote,
    confirmedAt: r.confirmedAt,
    confirmedByName: r.confirmedByName,
    invoiceWording: r.invoiceWording,
    createdByName: r.createdByName,
    createdAt: r.createdAt,
    withdrawnAt: r.withdrawnAt,
    withdrawnByName: r.withdrawnByName,
  });
  return {
    active: rev ? { ...shape(rev), coveredRefs, laterVariations: later.map((v) => ({ ref: v.ref, total: r2(v.total) })) } : null,
    history: history.filter((h) => h.id !== rev?.id).map(shape),
    balance: {
      jobValue,
      invoiced,
      credits,
      received,
      toInvoice: r2(Math.max(0, jobValue - invoiced - credits)),
      owing: r2(Math.max(0, invoiced + credits - received)),
      invoices: invoices.map((i) => ({
        ref: i.number,
        kind: i.kind,
        status: i.status,
        total: i.total,
        paid: i.amountPaid,
        outstanding: i.status === "void" ? 0 : r2(Math.max(0, i.total - i.amountPaid)),
        replaces: i.replacesInvoiceId ? (invoices.find((x) => x.id === i.replacesInvoiceId)?.number ?? null) : null,
        revised: !!i.priceRevisionId,
      })),
    },
  };
}
