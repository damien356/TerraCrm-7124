import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../database";
import * as schema from "../database/schema";
import { audit, auditRow, bad, guard, notFound, nowSec, runGuarded, type Who } from "./trade-core";

/* ---------------------------------------------------------------------------
 * The warehouse stock ledger, back for trade sales (notes 18.65, answers 1 and
 * 2). ON HAND is the sum of movements for a product, in the product's own unit
 * (products.unit). Nobody types an on hand figure, and a movement is never
 * edited or deleted: a mistake is undone with a reversing movement.
 *
 * Kinds used now: opening, received, job_used, adjustment, stocktake,
 * reversal, trade_out, trade_return. Job reservations and scanning stay out.
 *
 * A product below zero is flagged "negative stock, needs correcting" until a
 * received, stocktake or adjustment brings it back. Nothing ever posts a
 * receipt to hide a negative balance.
 * ------------------------------------------------------------------------- */

export const STOCK_KIND_LABEL: Record<string, string> = {
  opening: "Opening count",
  received: "Stock received",
  job_used: "Used on job",
  adjustment: "Adjustment",
  stocktake: "Stocktake",
  reversal: "Reversal",
  trade_out: "Trade sale out",
  trade_return: "Trade return",
};

const q3 = (n: number) => Math.round(n * 1000) / 1000;

export type MovementSpec = {
  productId: number;
  kind: string;
  qty: number;
  unitCostExGst?: number | null;
  jobId?: number | null;
  installerId?: number | null;
  reversesId?: number | null;
  note?: string;
  who: Who;
};

/**
 * One ledger row as a batch statement. The balance before and after is worked
 * out inside the same INSERT, so two movements at once still chain correctly.
 * Cost is the product's standard cost at the time unless given.
 */
export function movementStmt(m: MovementSpec) {
  const qty = q3(m.qty);
  if (!Number.isFinite(qty) || qty === 0) throw bad("A stock movement needs a quantity.");
  const now = nowSec();
  const cost =
    m.unitCostExGst === undefined ? sql`(select cost_price from products where id = ${m.productId})` : sql`${m.unitCostExGst ?? null}`;
  return db.run(sql`
    insert into stock_movements (
      product_id, kind, qty, balance_before, balance_after, unit_cost_ex_gst,
      job_id, installer_id, reverses_id, source, note, by_name, created_at, updated_at
    )
    select ${m.productId}, ${m.kind}, ${qty},
      round(coalesce(sum(qty), 0), 3), round(coalesce(sum(qty), 0) + ${qty}, 3), ${cost},
      ${m.jobId ?? null}, ${m.installerId ?? null}, ${m.reversesId ?? null}, 'office', ${(m.note ?? "").slice(0, 500)},
      ${m.who.name || "System"}, ${now}, ${now}
    from stock_movements where product_id = ${m.productId}`);
}

/** The id of the movement a batch just wrote for this product (the batch is one transaction). */
export const lastMovementIdSql = (productId: number) => sql`(select max(id) from stock_movements where product_id = ${productId})`;

export async function onHandFor(productIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>(productIds.map((id) => [id, 0]));
  if (!productIds.length) return out;
  const rows = await db
    .select({ productId: schema.stockMovements.productId, qty: sql<number>`coalesce(sum(${schema.stockMovements.qty}), 0)` })
    .from(schema.stockMovements)
    .where(inArray(schema.stockMovements.productId, productIds))
    .groupBy(schema.stockMovements.productId);
  for (const r of rows) out.set(r.productId, q3(Number(r.qty)));
  return out;
}

export async function productExists(productId: number) {
  const [p] = await db.select({ id: schema.products.id, unit: schema.products.unit }).from(schema.products).where(eq(schema.products.id, productId));
  if (!p) throw notFound("Product not found");
  return p;
}

/** Every product with stock movements, or on the trade list, with on hand and the negative flag. */
export async function stockLevels(productIds: number[]) {
  const ids = [
    ...new Set([
      ...productIds,
      ...(await db.selectDistinct({ id: schema.stockMovements.productId }).from(schema.stockMovements)).map((r) => r.id),
    ]),
  ];
  if (!ids.length) return [];
  const [products, onHand, opened] = await Promise.all([
    db.select().from(schema.products).where(inArray(schema.products.id, ids)),
    onHandFor(ids),
    db
      .selectDistinct({ id: schema.stockMovements.productId })
      .from(schema.stockMovements)
      .where(and(inArray(schema.stockMovements.productId, ids), eq(schema.stockMovements.kind, "opening"))),
  ]);
  const hasOpening = new Set(opened.map((r) => r.id));
  return products.map((p) => {
    const have = onHand.get(p.id) ?? 0;
    return {
      productId: p.id,
      name: [p.brand, p.range].filter(Boolean).join(" "),
      detail: [p.colour, p.size].filter(Boolean).join(", "),
      supplier: p.supplier,
      category: p.category,
      unit: p.unit,
      onHand: have,
      negative: have < -0.0005,
      hasOpening: hasOpening.has(p.id),
      costPrice: p.costPrice,
      value: p.costPrice != null ? Math.round(have * p.costPrice * 100) / 100 : null,
    };
  });
}

export async function movementsFor(productId: number, limit = 200) {
  const rows = await db
    .select()
    .from(schema.stockMovements)
    .where(eq(schema.stockMovements.productId, productId))
    .orderBy(desc(schema.stockMovements.id))
    .limit(limit);
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? await db
        .select({ movementId: schema.tradeStockLinks.movementId, saleId: schema.tradeStockLinks.saleId, number: schema.tradeSales.number })
        .from(schema.tradeStockLinks)
        .innerJoin(schema.tradeSales, eq(schema.tradeSales.id, schema.tradeStockLinks.saleId))
        .where(inArray(schema.tradeStockLinks.movementId, ids))
    : [];
  const linkOf = new Map(links.map((l) => [l.movementId, l]));
  const reversed = new Set(rows.filter((r) => r.reversesId).map((r) => r.reversesId!));
  const allReversed = ids.length
    ? await db
        .select({ id: schema.stockMovements.reversesId })
        .from(schema.stockMovements)
        .where(inArray(schema.stockMovements.reversesId, ids))
    : [];
  for (const r of allReversed) if (r.id) reversed.add(r.id);
  return rows.map((r) => ({
    ...r,
    label: STOCK_KIND_LABEL[r.kind] ?? r.kind,
    saleRef: linkOf.get(r.id) ? `S${linkOf.get(r.id)!.number}` : null,
    saleId: linkOf.get(r.id)?.saleId ?? null,
    reversed: reversed.has(r.id),
  }));
}

/* ------------------------------ ledger actions ---------------------------- */

export type LedgerAction =
  | { kind: "opening"; productId: number; qty: number; note?: string }
  | { kind: "received"; productId: number; qty: number; supplier: string; ref: string; date: string; note?: string }
  | { kind: "job_used"; productId: number; qty: number; jobId: number; note?: string }
  | { kind: "adjustment"; productId: number; qty: number; reason: string }
  | { kind: "stocktake"; productId: number; counted: number; note?: string; expectOnHand: number }
  | { kind: "reversal"; movementId: number; reason: string };

export async function postLedger(a: LedgerAction, who: Who) {
  if (a.kind === "reversal") {
    const [m] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.id, a.movementId));
    if (!m) throw notFound("Movement not found");
    if (m.kind === "reversal") throw bad("A reversal cannot itself be reversed. Post an adjustment instead.");
    if (m.kind === "trade_out" || m.kind === "trade_return") throw bad("Trade sale movements are undone from the sale (a return), not here.");
    const [already] = await db.select({ id: schema.stockMovements.id }).from(schema.stockMovements).where(eq(schema.stockMovements.reversesId, m.id));
    if (already) throw bad("Already reversed.");
    await runGuarded([
      movementStmt({ productId: m.productId, kind: "reversal", qty: -m.qty, unitCostExGst: m.unitCostExGst, reversesId: m.id, jobId: m.jobId, note: `Reverses #${m.id}: ${a.reason}`, who }),
      auditRow({ entityType: "stock", entityId: m.productId, action: "stock_reversal", detail: `Reversed movement #${m.id} (${m.kind} ${m.qty}). ${a.reason}`, who }),
    ]);
    return;
  }
  const p = await productExists(a.productId);
  if (a.kind === "opening") {
    if (!(a.qty >= 0)) throw bad("An opening count cannot be below zero.");
    if (a.qty === 0) throw bad("Nothing to record. A product with none on the shelf needs no opening count.");
    await runGuarded([
      guard(sql`(select count(*) from stock_movements where product_id = ${a.productId} and kind = 'opening') = 0`),
      movementStmt({ productId: a.productId, kind: "opening", qty: a.qty, note: a.note ?? "", who }),
      auditRow({ entityType: "stock", entityId: a.productId, action: "stock_opening", detail: `Opening count ${a.qty} ${p.unit}`, who }),
    ]).catch((e) => {
      if (String(e?.message).includes("figures changed")) throw bad("This product already has an opening count. Correct it with an adjustment.");
      throw e;
    });
    return;
  }
  if (a.kind === "received") {
    if (!(a.qty > 0)) throw bad("Received needs a quantity above zero.");
    if (!a.ref.trim()) throw bad("Add the supplier invoice or docket ref.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date)) throw bad("Pick the date received.");
    const note = `${a.supplier.trim()} ${a.ref.trim()} on ${a.date}${a.note?.trim() ? `. ${a.note.trim()}` : ""}`;
    await runGuarded([
      movementStmt({ productId: a.productId, kind: "received", qty: a.qty, note, who }),
      auditRow({ entityType: "stock", entityId: a.productId, action: "stock_received", detail: `Received ${a.qty} ${p.unit}: ${note}`, who }),
    ]);
    return;
  }
  if (a.kind === "job_used") {
    if (!(a.qty > 0)) throw bad("Used on job needs a quantity above zero.");
    const [job] = await db.select({ id: schema.jobs.id, number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, a.jobId));
    if (!job) throw notFound("Job not found");
    // A plain movement tagged with the job. It never touches the job, its quote, its costs or the schedule.
    await runGuarded([
      movementStmt({ productId: a.productId, kind: "job_used", qty: -a.qty, jobId: job.id, note: `Job ${job.number}${a.note?.trim() ? `. ${a.note.trim()}` : ""}`, who }),
      auditRow({ entityType: "stock", entityId: a.productId, action: "stock_job_used", detail: `Used ${a.qty} ${p.unit} on job ${job.number}`, who }),
    ]);
    return;
  }
  if (a.kind === "adjustment") {
    if (!a.qty) throw bad("An adjustment needs a quantity, plus or minus.");
    if (!a.reason.trim()) throw bad("Say why.");
    await runGuarded([
      movementStmt({ productId: a.productId, kind: "adjustment", qty: a.qty, note: a.reason.trim(), who }),
      auditRow({ entityType: "stock", entityId: a.productId, action: "stock_adjustment", detail: `Adjusted ${a.qty > 0 ? "+" : ""}${a.qty} ${p.unit}: ${a.reason.trim()}`, who }),
    ]);
    return;
  }
  if (a.kind === "stocktake") {
    if (!(a.counted >= 0)) throw bad("A count cannot be below zero.");
    const have = (await onHandFor([a.productId])).get(a.productId) ?? 0;
    if (Math.abs(have - a.expectOnHand) > 0.0005) throw bad("On hand changed since the screen loaded. Reload and count again.");
    const diff = q3(a.counted - have);
    if (diff === 0) return;
    const stmts: BatchItem<"sqlite">[] = [
      guard(sql`abs(coalesce((select sum(qty) from stock_movements where product_id = ${a.productId}), 0) - ${have}) < 0.0005`),
      movementStmt({ productId: a.productId, kind: "stocktake", qty: diff, note: `Counted ${a.counted}${a.note?.trim() ? `. ${a.note.trim()}` : ""}`, who }),
      auditRow({ entityType: "stock", entityId: a.productId, action: "stock_stocktake", detail: `Stocktake: counted ${a.counted} ${p.unit}, was ${have}`, who }),
    ];
    await runGuarded(stmts);
    return;
  }
}

export async function auditStock(productId: number, detail: string, who: Who) {
  await audit({ entityType: "stock", entityId: productId, action: "stock_note", detail, who });
}
