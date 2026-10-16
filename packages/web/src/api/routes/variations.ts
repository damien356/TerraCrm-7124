import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, type Actor } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { acceptVariation, rejectVariation, WORK_ORDER_WARNING } from "../lib/variation-accept";
import { uploadInput } from "../lib/job-mail";
import { addressedFor, billNoteOf, sendVariation, variationDraft, variationPdfFor, variationPhotos } from "../lib/variation-send";
import {
  acceptedQuoteFor,
  addLabourLine,
  addOtherLine,
  addProductLine,
  approvedVariationsTotal,
  createVariation,
  deleteVariation,
  itemsOf,
  LINE_KINDS,
  removeLine,
  STATUS_LABEL,
  updateLine,
  updateVariation,
  variationOrThrow,
  variationUrl,
  type Variation,
} from "../lib/variations";
import { quoteRefOf } from "../lib/quote-number";
import { auDate } from "../lib/invoice-match";
import { todayISO } from "../lib/pricing";
import { feeView, variationSnapshot } from "../lib/referral-fees";
import { foldFee, priceWithoutFee } from "../lib/referral-fold";

/* ---------------------------------------------------------------------------
 * Variations on a job (fix list 11 Oct, item 12). Admin and Office only.
 * Unit costs are hidden from anyone whose actor cannot see costs.
 * The money and the rules live in lib/variations.ts and lib/variation-*.ts.
 * ------------------------------------------------------------------------- */

const lineKind = z.enum(LINE_KINDS);
const qty = z.number().positive().max(100000);

async function profileIdOf(userId: string) {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, userId)).limit(1);
  return p?.id ?? null;
}

async function viewOf(v: Variation, actor: Actor) {
  const raw = await itemsOf(v.id);
  // Notes 18.47: only an Admin sees the referral fee. Everyone else reads the lines with it spread in.
  const snap = await variationSnapshot(v.id);
  const admin = actor.role === "admin";
  const items = !admin && snap?.amount ? foldFee(raw, snap.amount).lines : raw;
  const [sig] = await db
    .select({ name: schema.variationSignatures.name, position: schema.variationSignatures.position, signedAt: schema.variationSignatures.signedAt })
    .from(schema.variationSignatures)
    .where(eq(schema.variationSignatures.variationId, v.id))
    .orderBy(desc(schema.variationSignatures.id))
    .limit(1);
  const { billedToCompany } = await addressedFor(v);
  return {
    id: v.id,
    jobId: v.jobId,
    quoteId: v.quoteId,
    ref: v.ref,
    seq: v.seq,
    description: v.description,
    status: v.status,
    statusLabel: STATUS_LABEL[v.status] ?? v.status,
    billedToCompany,
    billNote: billNoteOf(billedToCompany),
    /** Company billed: an updated work order is needed before invoicing. Checked by hand until the work order build. */
    workOrderWarning: billedToCompany ? WORK_ORDER_WARNING : null,
    subtotal: v.subtotal,
    gst: v.gst,
    total: v.total,
    views: v.views,
    firstViewedAt: v.firstViewedAt,
    lastViewedAt: v.lastViewedAt,
    sentAt: v.sentAt,
    approvedAt: v.approvedAt,
    approvedByName: v.approvedByName,
    approvalChannel: v.approvalChannel,
    rejectedAt: v.rejectedAt,
    createdAt: v.createdAt,
    createdByName: v.createdByName,
    url: v.token ? variationUrl(v.token) : null,
    signature: sig ?? null,
    photos: (await variationPhotos(v)).map((p) => ({ id: p.id, caption: p.caption, kind: p.kind, url: p.url })),
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      rateItemId: i.rateItemId,
      kind: i.kind,
      lineType: i.lineType,
      description: i.description,
      qty: i.qty,
      unit: i.unit,
      unitPrice: i.unitPrice,
      unitCost: actor.canSeeCosts ? i.unitCost : null,
      total: i.total,
    })),
    /** Admin only: the fee as its own line. Null for everyone else. */
    referralFee: admin ? feeView(snap) : null,
  };
}

async function variationPriceWithoutFee(lineId: number, typed: number) {
  const [line] = await db.select().from(schema.variationItems).where(eq(schema.variationItems.id, lineId));
  if (!line || typed === line.unitPrice) return typed;
  const snap = await variationSnapshot(line.variationId);
  if (!snap?.amount) return typed;
  const share = foldFee(await itemsOf(line.variationId), snap.amount).shares.get(line.id) ?? 0;
  return priceWithoutFee(typed, line.qty, snap, share);
}

async function fresh(id: number, actor: Actor) {
  return viewOf(await variationOrThrow(id), actor);
}

export const variations = {
  /** Every variation on a job, newest first, with the accepted quote it adds to. */
  list: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => {
    const rows = await db.select().from(schema.variations).where(eq(schema.variations.jobId, input.jobId)).orderBy(desc(schema.variations.seq));
    const quote = await acceptedQuoteFor(input.jobId);
    return {
      acceptedQuote: quote ? { id: quote.id, ref: await quoteRefOf(quote), total: quote.total } : null,
      approvedTotal: await approvedVariationsTotal(input.jobId),
      canSeeCosts: context.actor.canSeeCosts,
      variations: await Promise.all(rows.map((v) => viewOf(v, context.actor))),
    };
  }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => fresh(input.id, context.actor)),

  create: staffOnly
    .input(z.object({ jobId: z.number(), description: z.string().max(4000).optional() }))
    .handler(async ({ input, context }) => {
      const row = await createVariation({ ...input, byName: context.actor.name, actorRole: context.actor.role });
      return fresh(row.id, context.actor);
    }),

  update: staffOnly
    .input(
      z.object({
        id: z.number(),
        description: z.string().max(4000).optional(),
        photoMediaIds: z.array(z.number()).max(12).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...fields } = input;
      await updateVariation(id, fields);
      return fresh(id, context.actor);
    }),

  delete: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => deleteVariation(input.id, context.actor)),

  addProduct: staffOnly
    .input(z.object({ variationId: z.number(), productId: z.number(), qty }))
    .handler(async ({ input, context }) => {
      const out = await addProductLine(input);
      return { note: out.note, flag: out.flag, variation: await fresh(input.variationId, context.actor) };
    }),

  addLabour: staffOnly
    .input(z.object({ variationId: z.number(), itemId: z.number(), qty, description: z.string().max(500).optional() }))
    .handler(async ({ input, context }) => {
      const out = await addLabourLine(input);
      return { minApplied: out.minApplied, variation: await fresh(input.variationId, context.actor) };
    }),

  addOther: staffOnly
    .input(
      z.object({
        variationId: z.number(),
        kind: lineKind.default("other"),
        description: z.string().trim().min(1, "Describe the line.").max(500),
        qty,
        unit: z.string().max(30).default("each"),
        unitPrice: z.number().min(0).max(1000000),
        unitCost: z.number().min(0).max(1000000).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const unitCost = context.actor.canSeeCosts ? (input.unitCost ?? null) : null;
      await addOtherLine({ ...input, unitCost });
      return fresh(input.variationId, context.actor);
    }),

  updateLine: staffOnly
    .input(
      z.object({
        id: z.number(),
        description: z.string().max(500).optional(),
        qty: qty.optional(),
        unit: z.string().max(30).optional(),
        unitPrice: z.number().min(0).max(1000000).optional(),
        unitCost: z.number().min(0).max(1000000).nullish(),
        kind: lineKind.optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { unitCost, ...rest } = input;
      // Notes 18.47: a price typed with the referral fee spread in goes back to Terra's own price.
      if (context.actor.role !== "admin" && rest.unitPrice !== undefined) rest.unitPrice = await variationPriceWithoutFee(input.id, rest.unitPrice);
      // Only someone who can see costs can set one.
      const out = await updateLine(context.actor.canSeeCosts && unitCost !== undefined ? { ...rest, unitCost } : rest);
      const [item] = await db.select({ v: schema.variationItems.variationId }).from(schema.variationItems).where(eq(schema.variationItems.id, out.item.id));
      return fresh(item!.v, context.actor);
    }),

  removeLine: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [line] = await db.select({ v: schema.variationItems.variationId }).from(schema.variationItems).where(eq(schema.variationItems.id, input.id));
    await removeLine(input.id);
    return line ? fresh(line.v, context.actor) : null;
  }),

  /** What the Send dialog opens with: recipients, email, text and the link. */
  draft: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => variationDraft(input.id)),

  send: staffOnly
    .input(
      z.object({
        id: z.number(),
        channel: z.enum(["email", "sms"]),
        to: z.string().trim().min(3).max(200),
        subject: z.string().max(300).optional(),
        body: z.string().trim().min(1).max(20000),
        cc: z.array(z.string().trim().max(200)).max(10).optional(),
        mediaIds: z.array(z.number().int()).max(30).optional(),
        uploads: z.array(uploadInput).max(20).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const out = await sendVariation({
        ...input,
        byName: context.actor.name,
        byProfileId: await profileIdOf(context.actor.userId),
        actorRole: context.actor.role,
      });
      return { to: out.to, url: out.url, linked: out.linked, variation: await fresh(input.id, context.actor) };
    }),

  pdf: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [sig] = await db
      .select()
      .from(schema.variationSignatures)
      .where(eq(schema.variationSignatures.variationId, input.id))
      .orderBy(desc(schema.variationSignatures.id))
      .limit(1);
    const signed = sig
      ? { name: sig.name, position: sig.position, date: auDate(todayISO(sig.signedAt)), signature: JSON.parse(sig.signatureJson) }
      : undefined;
    const { pdf, filename } = await variationPdfFor(input.id, signed);
    return { filename, base64: pdf.toString("base64") };
  }),

  /** The client said yes another way (email, phone, on site). The note says how. */
  accept: staffOnly
    .input(z.object({ id: z.number(), note: z.string().trim().max(1000).optional() }))
    .handler(async ({ input, context }) => {
      const out = await acceptVariation({ id: input.id, actor: context.actor, via: "staff", note: input.note ? `How: ${input.note}` : null });
      await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after variation accept failed:", e));
      return {
        workOrderWarning: out.billedToCompany ? WORK_ORDER_WARNING : null,
        dispatchId: out.work.taskId,
        materials: out.work.materials,
        variation: await fresh(input.id, context.actor),
      };
    }),

  reject: staffOnly
    .input(z.object({ id: z.number(), reason: z.string().trim().max(1000).optional() }))
    .handler(async ({ input, context }) => {
      await rejectVariation({ id: input.id, actor: context.actor, via: "staff", reason: input.reason });
      return fresh(input.id, context.actor);
    }),
};
