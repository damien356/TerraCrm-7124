import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { markupOf } from "./pricing";
import { liveSellFor } from "./live-sell";
import { underlayName, isUnderlayCategory, wholeUnits } from "./order-sizes";
import { standardLabour } from "./quote-labour";
import { newToken } from "./quote-links";
import { jobText, variationRef } from "./refs";
import { OPS_URL } from "./swms-checks";

/* ---------------------------------------------------------------------------
 * Variations (fix list 11 Oct, item 12). Extra work or a dearer product after
 * a quote is accepted. Priced like a quote, off the price book and the rate
 * book, numbered off the job: V188000-01, V188000-02.
 *
 *   draft     being priced. Editing a sent one puts it back to draft.
 *   sent      out to the client by email or SMS with the /v/<token> link
 *   approved  accepted (signed online, or marked by the office). Added to
 *             the job value. It goes on the final invoice (homeowner) or the
 *             end invoice (company billed). Never its own invoice, never a
 *             new deposit, so it stays approved.
 *   rejected  the client said no
 *
 * "invoiced" is never set now. It stays counted and labelled only so an old
 * row would still read right.
 *
 * Accepting is lib/variation-accept.ts, sending lib/variation-send.ts.
 * ------------------------------------------------------------------------- */

export type Variation = typeof schema.variations.$inferSelect;
export type VariationItem = typeof schema.variationItems.$inferSelect;

export const GST_RATE = 0.1;
/** The bill_mode column stays, always "final". Damien: never a separate invoice. */
export const BILL_MODES = ["final"] as const;
export type BillMode = (typeof BILL_MODES)[number];
/** Statuses whose total is in the job value. */
export const COUNTED_STATUSES = ["approved", "invoiced"] as const;
/** Statuses the office can still change the lines on. */
export const EDITABLE_STATUSES = ["draft", "sent"] as const;
export const LINE_KINDS = ["supply", "accessory", "labour", "prep", "removal", "other"] as const;
export const WORK_KINDS = new Set(["labour", "prep", "removal"]);
export const SUPPLY_KINDS = new Set(["supply", "accessory"]);

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  sent: "Sent",
  approved: "Accepted",
  invoiced: "Accepted, invoiced",
  rejected: "Declined",
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });

export const variationUrl = (token: string) => `${OPS_URL}/v/${token}`;
export const lineTypeOfKind = (kind: string) => (WORK_KINDS.has(kind) ? "labour" : "material");

/** "Andes Peak in Merida", the same as a quote line (routes/quotes.ts). */
export function productLineName(p: { brand: string | null; range: string | null; colour: string | null; category?: string | null }) {
  if (isUnderlayCategory(p.category)) return underlayName(p);
  const named = [p.brand, p.range].filter(Boolean).join(" ");
  return p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named;
}

export async function variationOrThrow(id: number) {
  const [row] = await db.select().from(schema.variations).where(eq(schema.variations.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Variation not found" });
  return row;
}

export async function editableOrThrow(id: number) {
  const v = await variationOrThrow(id);
  if (!(EDITABLE_STATUSES as readonly string[]).includes(v.status)) {
    throw bad(`Variation ${v.ref} is ${STATUS_LABEL[v.status]?.toLowerCase() ?? v.status}. It cannot be changed now. Make a new variation instead.`);
  }
  return v;
}

/** Editing a sent variation takes it back to draft, so the client never accepts lines they did not see. */
async function touched(v: Variation) {
  if (v.status === "sent") {
    await db.update(schema.variations).set({ status: "draft", updatedAt: new Date() }).where(eq(schema.variations.id, v.id));
  }
}

export async function itemsOf(variationId: number) {
  return db
    .select()
    .from(schema.variationItems)
    .where(eq(schema.variationItems.variationId, variationId))
    .orderBy(asc(schema.variationItems.sortOrder), asc(schema.variationItems.id));
}

/** The accepted quote on a job, the newest version. Null when the job has none in Ops. */
export async function acceptedQuoteFor(jobId: number) {
  const rows = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")));
  return rows.sort((a, b) => b.version - a.version || b.id - a.id)[0] ?? null;
}

/** Sum of accepted variations on a job, GST inclusive. A quote re-accept adds this back on. */
export async function approvedVariationsTotal(jobId: number) {
  const [row] = await db
    .select({ sum: sql<number>`coalesce(sum(${schema.variations.total}), 0)` })
    .from(schema.variations)
    .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, [...COUNTED_STATUSES])));
  return round2(Number(row?.sum ?? 0));
}

export async function recalcVariation(id: number) {
  const items = await db.select({ total: schema.variationItems.total }).from(schema.variationItems).where(eq(schema.variationItems.variationId, id));
  const subtotal = round2(items.reduce((s, i) => s + (i.total ?? 0), 0));
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);
  await db.update(schema.variations).set({ subtotal, gst, total, amount: total, updatedAt: new Date() }).where(eq(schema.variations.id, id));
  return { subtotal, gst, total };
}

async function nextSort(variationId: number) {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${schema.variationItems.sortOrder}), -1)` })
    .from(schema.variationItems)
    .where(eq(schema.variationItems.variationId, variationId));
  return Number(row?.max ?? -1) + 1;
}

/* --------------------------------- create --------------------------------- */

export async function createVariation(args: { jobId: number; description?: string; byName: string; actorRole: string }) {
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
  if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
  const quote = await acceptedQuoteFor(job.id);
  const jobRef = jobText(job);

  let row: Variation | undefined;
  for (let attempt = 0; attempt < 6 && !row; attempt++) {
    const [top] = await db
      .select({ max: sql<number>`coalesce(max(${schema.variations.seq}), 0)` })
      .from(schema.variations)
      .where(eq(schema.variations.jobId, job.id));
    const seq = Number(top?.max ?? 0) + 1;
    try {
      [row] = await db
        .insert(schema.variations)
        .values({
          jobId: job.id,
          quoteId: quote?.id ?? null,
          ref: variationRef(jobRef, seq),
          seq,
          description: args.description?.trim() ?? "",
          billMode: "final",
          status: "draft",
          createdByName: args.byName,
        })
        .returning();
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      if (!/unique/i.test(`${err?.message ?? e} ${err?.cause?.message ?? ""}`)) throw e;
    }
  }
  if (!row) throw bad("Could not find a free variation number. Try again.");
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "variation",
    entityId: row.id,
    action: "variation_created",
    detail: `Variation ${row.ref} started`,
    actorName: args.byName,
    actorRole: args.actorRole,
  });
  return row;
}

export async function updateVariation(id: number, fields: { description?: string; photoMediaIds?: number[] }) {
  const v = await editableOrThrow(id);
  const set: Partial<typeof schema.variations.$inferInsert> = { updatedAt: new Date() };
  if (fields.description !== undefined) set.description = fields.description.trim();
  if (fields.photoMediaIds !== undefined) {
    const ids = [...new Set(fields.photoMediaIds)].slice(0, 12);
    if (ids.length) {
      const found = await db
        .select({ id: schema.jobMedia.id })
        .from(schema.jobMedia)
        .where(and(eq(schema.jobMedia.jobId, v.jobId), inArray(schema.jobMedia.id, ids), ne(schema.jobMedia.bucket, "signed")));
      if (found.length !== ids.length) throw bad("A photo picked is not in this job's file.");
    }
    set.photoMediaIds = JSON.stringify(ids);
  }
  // The reason and the photos are what the client reads, so a change there needs a resend too.
  if (v.status === "sent" && (fields.description !== undefined || fields.photoMediaIds !== undefined)) {
    set.status = "draft";
  }
  const [row] = await db.update(schema.variations).set(set).where(eq(schema.variations.id, id)).returning();
  return row!;
}

/** Only a draft that never went out can be deleted. Anything sent stays on the record. */
export async function deleteVariation(id: number, actor: { name: string; role: string }) {
  const v = await variationOrThrow(id);
  if (v.status !== "draft" || v.sentAt) throw bad(`Variation ${v.ref} has been sent, so it stays on the record. Mark it declined instead.`);
  await db.delete(schema.variations).where(eq(schema.variations.id, id));
  await db.insert(schema.activityLog).values({
    jobId: v.jobId,
    entityType: "variation",
    entityId: v.id,
    action: "variation_deleted",
    detail: `Draft variation ${v.ref} deleted`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { ok: true as const };
}

export function photoIdsOf(v: Pick<Variation, "photoMediaIds">): number[] {
  try {
    const ids = JSON.parse(v.photoMediaIds || "[]");
    return Array.isArray(ids) ? ids.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

/** The /v/ link. Made once, the same link after that. */
export async function tokenFor(v: Variation) {
  if (v.token) return v.token;
  const token = newToken();
  await db
    .update(schema.variations)
    .set({ token, updatedAt: new Date() })
    .where(and(eq(schema.variations.id, v.id), sql`${schema.variations.token} is null`));
  const [fresh] = await db.select({ token: schema.variations.token }).from(schema.variations).where(eq(schema.variations.id, v.id));
  if (!fresh?.token) throw new Error("Variation link not created");
  return fresh.token;
}

/* ---------------------------------- lines --------------------------------- */

export async function addProductLine(args: { variationId: number; productId: number; qty: number }) {
  const v = await editableOrThrow(args.variationId);
  const [product] = await db.select().from(schema.products).where(eq(schema.products.id, args.productId));
  if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
  const unitPrice = await liveSellFor(product);
  // Whole boxes, lengths and pails, the same as a quote line.
  const sized = wholeUnits(product, args.qty);
  const qty = sized.qty;
  const isLabour = product.category === "labour";
  const kind = isLabour ? "labour" : product.category === "accessory" ? "accessory" : "supply";
  const [row] = await db
    .insert(schema.variationItems)
    .values({
      variationId: v.id,
      productId: product.id,
      kind,
      lineType: lineTypeOfKind(kind),
      description: productLineName(product) || product.sku || "Product",
      qty,
      unit: product.unit,
      unitPrice,
      unitCost: product.costPrice ?? null,
      total: round2(qty * unitPrice),
      sortOrder: await nextSort(v.id),
    })
    .returning();
  await touched(v);
  const totals = await recalcVariation(v.id);
  return { item: row!, note: sized.note, flag: sized.flag, totals, markupPercent: markupOf(product.costPrice, unitPrice) };
}

export async function addLabourLine(args: { variationId: number; itemId: number; qty: number; description?: string }) {
  const v = await editableOrThrow(args.variationId);
  const { values, minApplied } = await standardLabour(args.itemId, args.qty);
  const kind = values.kind === "other" ? "other" : "labour";
  const [row] = await db
    .insert(schema.variationItems)
    .values({
      variationId: v.id,
      rateItemId: values.rateItemId,
      kind,
      lineType: kind === "other" ? "material" : "labour",
      description: args.description?.trim() || values.description,
      qty: values.qty,
      unit: values.unit,
      unitPrice: values.unitPrice,
      unitCost: values.unitCost,
      total: values.total,
      sortOrder: await nextSort(v.id),
    })
    .returning();
  await touched(v);
  const totals = await recalcVariation(v.id);
  return { item: row!, minApplied, totals, markupPercent: values.markupPercent };
}

export async function addOtherLine(args: {
  variationId: number;
  kind: (typeof LINE_KINDS)[number];
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  unitCost?: number | null;
}) {
  const v = await editableOrThrow(args.variationId);
  const [row] = await db
    .insert(schema.variationItems)
    .values({
      variationId: v.id,
      kind: args.kind,
      lineType: lineTypeOfKind(args.kind),
      description: args.description.trim(),
      qty: args.qty,
      unit: args.unit.trim() || "each",
      unitPrice: round2(args.unitPrice),
      unitCost: args.unitCost ?? null,
      total: round2(args.qty * args.unitPrice),
      sortOrder: await nextSort(v.id),
    })
    .returning();
  await touched(v);
  const totals = await recalcVariation(v.id);
  return { item: row!, totals };
}

async function lineOrThrow(id: number) {
  const [line] = await db.select().from(schema.variationItems).where(eq(schema.variationItems.id, id));
  if (!line) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
  return line;
}

export async function updateLine(args: {
  id: number;
  description?: string;
  qty?: number;
  unit?: string;
  unitPrice?: number;
  unitCost?: number | null;
  kind?: (typeof LINE_KINDS)[number];
}) {
  const line = await lineOrThrow(args.id);
  const v = await editableOrThrow(line.variationId);
  const qty = args.qty ?? line.qty;
  const unitPrice = args.unitPrice !== undefined ? round2(args.unitPrice) : line.unitPrice;
  // A labour line keeps its minimum charge unless the qty or the rate changes.
  const total = args.qty === undefined && args.unitPrice === undefined ? line.total : round2(qty * unitPrice);
  const set: Partial<typeof schema.variationItems.$inferInsert> = { qty, unitPrice, total, updatedAt: new Date() };
  if (args.description !== undefined) set.description = args.description.trim() || line.description;
  if (args.unit !== undefined) set.unit = args.unit.trim() || line.unit;
  if (args.unitCost !== undefined) set.unitCost = args.unitCost;
  if (args.kind !== undefined) {
    set.kind = args.kind;
    set.lineType = lineTypeOfKind(args.kind);
  }
  const [row] = await db.update(schema.variationItems).set(set).where(eq(schema.variationItems.id, line.id)).returning();
  await touched(v);
  const totals = await recalcVariation(v.id);
  return { item: row!, totals };
}

export async function removeLine(id: number) {
  const line = await lineOrThrow(id);
  const v = await editableOrThrow(line.variationId);
  await db.delete(schema.variationItems).where(eq(schema.variationItems.id, line.id));
  await touched(v);
  return { totals: await recalcVariation(v.id) };
}

/* -------------------------- after a quote is accepted -------------------------- */

export const AFTER_ACCEPT_MESSAGE =
  "is accepted, so changes now go on a variation. Use Create variation on the job page. The client approves it and it adds to the job.";

/**
 * Fix list 11 Oct, item 12: once a quote is accepted, a new version is not
 * allowed. Extra work or a dearer colour is a variation the client approves.
 */
export async function assertNoAcceptedQuote(args: { number?: number | null; jobId?: number | null }) {
  const conds = [];
  if (args.number != null) conds.push(eq(schema.quotes.number, args.number));
  if (args.jobId != null) conds.push(eq(schema.quotes.jobId, args.jobId));
  if (!conds.length) return;
  for (const cond of conds) {
    const [hit] = await db
      .select({ number: schema.quotes.number, version: schema.quotes.version, jobId: schema.quotes.jobId })
      .from(schema.quotes)
      .where(and(cond, eq(schema.quotes.status, "accepted")))
      .limit(1);
    if (hit) {
      const [job] = hit.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, hit.jobId)) : [];
      const ref = `Q${job?.displayNumber && /^R\d/.test(job.displayNumber) ? job.displayNumber : hit.number}${hit.version > 1 ? `-${hit.version}` : ""}`;
      throw bad(`Quote ${ref} ${AFTER_ACCEPT_MESSAGE}`);
    }
  }
}
