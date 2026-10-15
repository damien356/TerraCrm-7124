/**
 * 15 Oct. Delete products from Settings, Price list: the bin on a row and
 * Delete selected. Admin only (the routes check).
 *
 * Delete is not the same as Active. Unticking Active hides a product; this
 * removes the row for good. Only a product nothing has ever used can go: a
 * product on a quote, job, variation, selection form, purchase order,
 * supplier invoice check or installer account is never deleted. Its Active
 * is unticked instead and the reason is given, so an old quote or invoice
 * can never lose its product. A product in an underlay upgrade pair is left
 * as it is until the pair is taken out in Settings.
 *
 * Every delete is one batch with its own log rows (who, when, which
 * product) and keeps the whole product row, its specials and its voice
 * matches, so Undo last delete can put it back with the same id. Undo works
 * newest first, like Undo last import.
 */
import { and, desc, eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { parsePairs, UNDERLAY_UPGRADES_KEY } from "./underlay-pairs";

type ActorLite = { userId: string; name: string };
type Product = typeof schema.products.$inferSelect;

/** One delete at a time keeps the batch (and the undo copy) a safe size. */
export const MAX_DELETE = 1500;

const chunk = <T,>(list: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

async function runBatch(stmts: BatchItem<"sqlite">[]) {
  if (!stmts.length) return;
  await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

async function nextId(table: "product_deletes") {
  const res = await db.all<{ n: number | null }>(
    sql`select max(coalesce((select seq from sqlite_sequence where name = ${table}), 0), coalesce((select max(id) from ${sql.identifier(table)}), 0)) + 1 as n`,
  );
  return Number(res[0]?.n ?? 1);
}

export const productName = (p: Pick<Product, "id" | "brand" | "range" | "colour">) =>
  [p.brand, p.range, p.colour].filter(Boolean).join(" ") || `Product ${p.id}`;

const productLine = (p: Product) =>
  [productName(p), p.supplier ? `from ${p.supplier}` : "", p.sku ? `SKU ${p.sku}` : "", `id ${p.id}`].filter(Boolean).join(", ");

/* --------------------------------- usage --------------------------------- */

type Kind = "quote" | "job" | "variation" | "selection" | "po" | "supplierInvoice" | "installer";
const KIND_ORDER: Kind[] = ["quote", "job", "variation", "selection", "po", "supplierInvoice", "installer"];
const KIND_WORDS: Record<Kind, [string, string]> = {
  quote: ["quote", "quotes"],
  job: ["job", "jobs"],
  variation: ["variation", "variations"],
  selection: ["material selection form", "material selection forms"],
  po: ["purchase order", "purchase orders"],
  supplierInvoice: ["supplier invoice check", "supplier invoice checks"],
  installer: ["installer account entry", "installer account entries"],
};

export type Usage = Map<number, Map<Kind, Set<string>>>;

/**
 * Everything that points at a product and keeps its row when the product
 * goes. Any hit means the product has been used and is never deleted.
 */
export async function productUsage(ids: number[]): Promise<Usage> {
  const used: Usage = new Map();
  const add = (id: number | null, kind: Kind, parent: unknown) => {
    if (id == null) return;
    let k = used.get(id);
    if (!k) used.set(id, (k = new Map()));
    let s = k.get(kind);
    if (!s) k.set(kind, (s = new Set()));
    s.add(String(parent));
  };
  const S = schema;
  for (const part of chunk([...new Set(ids)], 400)) {
    const [qi, qph, jm, vi, msi, pol, pf, iae] = await Promise.all([
      db.select({ id: S.quoteItems.productId, p: S.quoteItems.quoteId }).from(S.quoteItems).where(inArray(S.quoteItems.productId, part)),
      db
        .select({ id: S.quotePriceHistory.productId, p: S.quotePriceHistory.quoteId, h: S.quotePriceHistory.id })
        .from(S.quotePriceHistory)
        .where(inArray(S.quotePriceHistory.productId, part)),
      db.select({ id: S.jobMaterials.productId, p: S.jobMaterials.jobId }).from(S.jobMaterials).where(inArray(S.jobMaterials.productId, part)),
      db.select({ id: S.variationItems.productId, p: S.variationItems.variationId }).from(S.variationItems).where(inArray(S.variationItems.productId, part)),
      db
        .select({
          a: S.materialSelectionItems.productId,
          b: S.materialSelectionItems.quotedProductId,
          c: S.materialSelectionItems.offerProductId,
          p: S.materialSelectionItems.selectionId,
        })
        .from(S.materialSelectionItems)
        .where(
          or(
            inArray(S.materialSelectionItems.productId, part),
            inArray(S.materialSelectionItems.quotedProductId, part),
            inArray(S.materialSelectionItems.offerProductId, part),
          ),
        ),
      db.select({ id: S.purchaseOrderLines.productId, p: S.purchaseOrderLines.poId }).from(S.purchaseOrderLines).where(inArray(S.purchaseOrderLines.productId, part)),
      db.select({ id: S.priceFlags.productId, p: S.priceFlags.invoiceId }).from(S.priceFlags).where(inArray(S.priceFlags.productId, part)),
      db
        .select({ id: S.installerAccountEntries.productId, p: S.installerAccountEntries.id })
        .from(S.installerAccountEntries)
        .where(inArray(S.installerAccountEntries.productId, part)),
    ]);
    for (const r of qi) add(r.id, "quote", r.p);
    for (const r of qph) add(r.id, "quote", r.p ?? `h${r.h}`);
    for (const r of jm) add(r.id, "job", r.p);
    for (const r of vi) add(r.id, "variation", r.p);
    const inPart = new Set(part);
    for (const r of msi) for (const id of [r.a, r.b, r.c]) if (id != null && inPart.has(id)) add(id, "selection", r.p);
    for (const r of pol) add(r.id, "po", r.p);
    for (const r of pf) add(r.id, "supplierInvoice", r.p);
    for (const r of iae) add(r.id, "installer", r.p);
  }
  return used;
}

/** "Used on 2 quotes, 1 job and 1 purchase order." */
export function usageReason(kinds: Map<Kind, Set<string>> | undefined) {
  if (!kinds?.size) return "";
  const parts = KIND_ORDER.filter((k) => kinds.has(k)).map((k) => {
    const n = kinds.get(k)!.size;
    return `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}`;
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  return `Used on ${list}.`;
}

/**
 * The delete checks again inside its own statement, so a product put on a
 * quote a second before the delete still keeps its row.
 */
const UNUSED_GUARD = sql.raw(
  [
    "quote_items",
    "quote_price_history",
    "job_materials",
    "variation_items",
    "purchase_order_lines",
    "price_flags",
    "installer_account_entries",
  ]
    .map((t) => `not exists (select 1 from ${t} u where u.product_id = products.id)`)
    .concat(
      "not exists (select 1 from material_selection_items u where u.product_id = products.id or u.quoted_product_id = products.id or u.offer_product_id = products.id)",
    )
    .join(" and "),
);

async function pairedIds(): Promise<Set<number>> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, UNDERLAY_UPGRADES_KEY));
  const out = new Set<number>();
  for (const p of parsePairs(row?.value)) {
    out.add(p.from);
    out.add(p.to);
  }
  return out;
}

/* ---------------------------------- plan --------------------------------- */

export type DeleteOutcome = "delete" | "hide" | "kept";
type PlanItem = { product: Product; outcome: DeleteOutcome; reason: string };

const PAIR_REASON = "It is in an underlay upgrade pair in Settings, Business rules. Take it out of the pair first.";

async function planDelete(ids: number[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new ORPCError("BAD_REQUEST", { message: "Pick at least one product." });
  if (unique.length > MAX_DELETE) {
    throw new ORPCError("BAD_REQUEST", { message: `Delete ${MAX_DELETE.toLocaleString("en-AU")} or fewer at a time. ${unique.length.toLocaleString("en-AU")} are selected.` });
  }
  const products: Product[] = [];
  for (const part of chunk(unique, 400)) products.push(...(await db.select().from(schema.products).where(inArray(schema.products.id, part))));
  const [usage, paired] = await Promise.all([productUsage(products.map((p) => p.id)), pairedIds()]);
  const items: PlanItem[] = products
    .sort((a, b) => productName(a).localeCompare(productName(b)))
    .map((p) => {
      const why = usageReason(usage.get(p.id));
      if (why) return { product: p, outcome: "hide", reason: why };
      if (paired.has(p.id)) return { product: p, outcome: "kept", reason: PAIR_REASON };
      return { product: p, outcome: "delete", reason: "" };
    });
  return { items, missing: unique.length - products.length };
}

const summary = (items: PlanItem[]) => ({
  toDelete: items.filter((i) => i.outcome === "delete").length,
  toHide: items.filter((i) => i.outcome === "hide" && i.product.active).length,
  alreadyHidden: items.filter((i) => i.outcome === "hide" && !i.product.active).length,
  kept: items.filter((i) => i.outcome === "kept").length,
});

/** What a delete would do. Writes nothing. */
export async function previewDelete(ids: number[]) {
  const { items, missing } = await planDelete(ids);
  const s = summary(items);
  const view = (i: PlanItem) => ({
    id: i.product.id,
    name: productName(i.product),
    supplier: i.product.supplier,
    sku: i.product.sku,
    active: i.product.active,
    outcome: i.outcome,
    reason: i.reason,
  });
  return {
    ...s,
    missing,
    selected: items.length,
    /** Every one that is not deleted, with its reason. */
    notDeleted: items.filter((i) => i.outcome !== "delete").map(view),
    /** The first 50 that go, to show by name. */
    deleteSample: items.filter((i) => i.outcome === "delete").slice(0, 50).map(view),
  };
}

/* ---------------------------------- apply -------------------------------- */

type Snapshot = {
  product: Record<string, unknown>;
  specials: Record<string, unknown>[];
  voice: Record<string, unknown>[];
};

/** JSON turns dates into strings. Put them back as dates for the columns that hold them. */
function revive(table: SQLiteTable, row: Record<string, unknown>) {
  const cols = getTableColumns(table) as Record<string, { columnType: string }>;
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(cols)) {
    if (!(k in row)) continue;
    const v = row[k];
    out[k] = c.columnType === "SQLiteTimestamp" && v != null ? new Date(v as string) : v;
  }
  return out;
}

export async function applyDelete(ids: number[], actor: ActorLite) {
  const { items, missing } = await planDelete(ids);
  const goes = items.filter((i) => i.outcome === "delete");
  const hides = items.filter((i) => i.outcome === "hide");
  const kept = items.filter((i) => i.outcome === "kept");
  const toHide = hides.filter((i) => i.product.active);
  if (!goes.length && !toHide.length) {
    const why = items.length === 1 ? items[0].reason : "";
    throw new ORPCError("BAD_REQUEST", {
      message: items.length
        ? `Nothing to delete. ${items.length === 1 ? `${productName(items[0].product)} is not deleted. ${why}` : "Every selected product is used or in an underlay pair, and the used ones are already hidden."}`
        : "Those products are already gone.",
    });
  }
  const goIds = goes.map((i) => i.product.id);
  const specials = goIds.length ? await db.select().from(schema.productSpecials).where(inArray(schema.productSpecials.productId, goIds)) : [];
  const voice = goIds.length ? await db.select().from(schema.voicePhraseProductMatches).where(inArray(schema.voicePhraseProductMatches.productId, goIds)) : [];
  const group = <T extends { productId: number }>(list: T[]) => {
    const m = new Map<number, T[]>();
    for (const x of list) m.set(x.productId, [...(m.get(x.productId) ?? []), x]);
    return m;
  };
  const specialsOf = group(specials);
  const voiceOf = group(voice);
  const [{ lastLog }] = await db.select({ lastLog: sql<number>`coalesce(max(${schema.activityLog.id}), 0)` }).from(schema.activityLog);

  const deleteId = await nextId("product_deletes");
  const now = new Date();
  const actorName = actor.name || "Admin";
  const stmts: BatchItem<"sqlite">[] = [
    db.insert(schema.productDeletes).values({
      id: deleteId,
      actorName,
      actorUserId: actor.userId,
      deleted: goes.length,
      hidden: toHide.length,
      status: "applied",
    }),
  ];
  const rows: (typeof schema.productDeleteRows.$inferInsert)[] = [
    ...goes.map((i) => ({
      deleteId,
      productId: i.product.id,
      action: "deleted",
      name: productName(i.product),
      wasActive: i.product.active,
      snapshot: JSON.stringify({
        product: i.product,
        specials: specialsOf.get(i.product.id) ?? [],
        voice: voiceOf.get(i.product.id) ?? [],
      } satisfies Snapshot),
    })),
    ...hides.map((i) => ({
      deleteId,
      productId: i.product.id,
      action: "hidden",
      name: productName(i.product),
      reason: i.reason,
      wasActive: i.product.active,
    })),
    ...kept.map((i) => ({
      deleteId,
      productId: i.product.id,
      action: "kept",
      name: productName(i.product),
      reason: i.reason,
      wasActive: i.product.active,
    })),
  ];
  for (const part of chunk(rows, 100)) stmts.push(db.insert(schema.productDeleteRows).values(part));
  for (const part of chunk(toHide.map((i) => i.product.id), 400)) {
    stmts.push(db.update(schema.products).set({ active: false, updatedAt: now }).where(inArray(schema.products.id, part)));
  }
  for (const part of chunk(goIds, 200)) {
    stmts.push(db.delete(schema.products).where(and(inArray(schema.products.id, part), UNUSED_GUARD)));
    // The foreign keys cascade these when they are on. When they are off, clear them by hand, only for products that really went.
    const gone = sql`(select id from products)`;
    stmts.push(db.delete(schema.productSpecials).where(and(inArray(schema.productSpecials.productId, part), sql`${schema.productSpecials.productId} not in ${gone}`)));
    stmts.push(
      db
        .delete(schema.voicePhraseProductMatches)
        .where(and(inArray(schema.voicePhraseProductMatches.productId, part), sql`${schema.voicePhraseProductMatches.productId} not in ${gone}`)),
    );
  }
  const logs: (typeof schema.activityLog.$inferInsert)[] = [
    ...goes.map((i) => ({
      entityType: "product",
      entityId: i.product.id,
      action: "product_deleted",
      detail: `Deleted from the price list for good: ${productLine(i.product)}.`,
      actorName,
      actorRole: "admin",
    })),
    ...toHide.map((i) => ({
      entityType: "product",
      entityId: i.product.id,
      action: "product_discontinued",
      detail: `Delete refused: ${i.reason} Active unticked instead: ${productLine(i.product)}.`,
      actorName,
      actorRole: "admin",
    })),
    ...hides
      .filter((i) => !i.product.active)
      .concat(kept)
      .map((i) => ({
        entityType: "product",
        entityId: i.product.id,
        action: "product_delete_refused",
        detail: `Delete refused, left as it is: ${i.outcome === "kept" ? PAIR_REASON : `${i.reason} Already hidden.`} ${productLine(i.product)}.`,
        actorName,
        actorRole: "admin",
      })),
    {
      entityType: "product_delete",
      entityId: deleteId,
      action: "products_deleted",
      detail: `Price list delete: ${goes.length} deleted, ${toHide.length} hidden instead because they are used${kept.length ? `, ${kept.length} left in an underlay pair` : ""}.`,
      actorName,
      actorRole: "admin",
    },
  ];
  for (const part of chunk(logs, 150)) stmts.push(db.insert(schema.activityLog).values(part));
  await runBatch(stmts);

  // The guard in the delete may have kept one that got used between the check and the write. Say so and hide it.
  const stayed = goIds.length
    ? (await db.select().from(schema.products).where(inArray(schema.products.id, goIds)))
    : [];
  if (stayed.length) {
    const fix: BatchItem<"sqlite">[] = [];
    const late = "Used on a quote, job or order while it was being deleted.";
    for (const p of stayed) {
      fix.push(
        db
          .update(schema.productDeleteRows)
          .set({ action: "hidden", reason: late, snapshot: "{}" })
          .where(and(eq(schema.productDeleteRows.deleteId, deleteId), eq(schema.productDeleteRows.productId, p.id))),
      );
      fix.push(db.update(schema.activityLog).set({ action: "product_discontinued", detail: `Delete refused: ${late} Active unticked instead: ${productLine(p)}.` }).where(and(eq(schema.activityLog.entityType, "product"), eq(schema.activityLog.entityId, p.id), eq(schema.activityLog.action, "product_deleted"), sql`${schema.activityLog.id} > ${lastLog}`)));
    }
    fix.push(db.update(schema.products).set({ active: false, updatedAt: new Date() }).where(inArray(schema.products.id, stayed.map((p) => p.id))));
    fix.push(
      db
        .update(schema.productDeletes)
        .set({ deleted: goes.length - stayed.length, hidden: toHide.length + stayed.length })
        .where(eq(schema.productDeletes.id, deleteId)),
    );
    await runBatch(fix);
  }

  const deleted = goes.length - stayed.length;
  const hidden = toHide.length + stayed.length;
  const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-AU")} ${k === 1 ? one : many}`;
  const notes = [`${n(deleted, "product", "products")} deleted`];
  if (hidden) notes.push(`${n(hidden, "was", "were")} used, so Active was unticked instead`);
  const already = hides.filter((i) => !i.product.active).length;
  if (already) notes.push(`${n(already, "used product was", "used products were")} already hidden`);
  if (kept.length) notes.push(`${n(kept.length, "was", "were")} left because ${kept.length === 1 ? "it is" : "they are"} in an underlay upgrade pair`);
  if (missing) notes.push(`${n(missing, "was", "were")} already gone`);
  const single = items.length === 1 && deleted === 0 ? ` ${items[0].reason}` : "";
  return { deleteId, deleted, hidden, alreadyHidden: already, kept: kept.length, note: `${notes.join(". ")}.${single}` };
}

/* ---------------------------------- undo --------------------------------- */

async function latestDelete() {
  const [row] = await db
    .select()
    .from(schema.productDeletes)
    .where(eq(schema.productDeletes.status, "applied"))
    .orderBy(desc(schema.productDeletes.id))
    .limit(1);
  return row ?? null;
}

export async function undoLastDelete(actor: ActorLite) {
  const del = await latestDelete();
  if (!del) throw new ORPCError("BAD_REQUEST", { message: "There is no delete to undo." });
  const rows = await db.select().from(schema.productDeleteRows).where(eq(schema.productDeleteRows.deleteId, del.id));
  const ids = rows.map((r) => r.productId);
  const current = new Map<number, Product>();
  for (const part of chunk(ids, 400)) for (const p of await db.select().from(schema.products).where(inArray(schema.products.id, part))) current.set(p.id, p);

  const back = rows.filter((r) => r.action === "deleted").map((r) => ({ r, snap: JSON.parse(r.snapshot || "{}") as Snapshot }));
  const keys = back.map((b) => String(b.snap.product?.variantKey ?? "")).filter(Boolean);
  const takenKeys = new Set<string>();
  for (const part of chunk(keys, 400)) {
    for (const p of await db.select({ k: schema.products.variantKey }).from(schema.products).where(inArray(schema.products.variantKey, part))) takenKeys.add(p.k);
  }

  const now = new Date();
  const actorName = actor.name || "Admin";
  const stmts: BatchItem<"sqlite">[] = [];
  const logs: (typeof schema.activityLog.$inferInsert)[] = [];
  let restored = 0;
  let reticked = 0;
  const already: string[] = [];
  const clash: string[] = [];
  const handTicked: string[] = [];

  for (const { r, snap } of back) {
    if (current.has(r.productId)) {
      already.push(r.name);
      continue;
    }
    if (!snap.product || takenKeys.has(String(snap.product.variantKey ?? ""))) {
      clash.push(r.name);
      continue;
    }
    stmts.push(db.insert(schema.products).values(revive(schema.products, snap.product) as typeof schema.products.$inferInsert));
    for (const part of chunk(snap.specials ?? [], 50)) {
      stmts.push(
        db
          .insert(schema.productSpecials)
          .values(part.map((s) => revive(schema.productSpecials, s) as typeof schema.productSpecials.$inferInsert))
          .onConflictDoNothing(),
      );
    }
    for (const part of chunk(snap.voice ?? [], 50)) {
      stmts.push(
        db
          .insert(schema.voicePhraseProductMatches)
          .values(part.map((v) => revive(schema.voicePhraseProductMatches, v) as typeof schema.voicePhraseProductMatches.$inferInsert))
          .onConflictDoNothing(),
      );
    }
    restored++;
    logs.push({
      entityType: "product",
      entityId: r.productId,
      action: "product_restored",
      detail: `Undo of price list delete ${del.id}: put back with the same id: ${r.name}.`,
      actorName,
      actorRole: "admin",
    });
  }
  const tick: number[] = [];
  for (const r of rows.filter((x) => x.action === "hidden" && x.wasActive)) {
    const p = current.get(r.productId);
    if (!p) continue;
    if (p.active) {
      handTicked.push(r.name);
      continue;
    }
    tick.push(p.id);
    reticked++;
    logs.push({
      entityType: "product",
      entityId: p.id,
      action: "product_reactivated",
      detail: `Undo of price list delete ${del.id}: Active ticked again: ${r.name}.`,
      actorName,
      actorRole: "admin",
    });
  }
  for (const part of chunk(tick, 400)) stmts.push(db.update(schema.products).set({ active: true, updatedAt: now }).where(inArray(schema.products.id, part)));

  const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-AU")} ${k === 1 ? one : many}`;
  const more = (list: string[]) => `${list.slice(0, 10).join(", ")}${list.length > 10 ? "..." : ""}`;
  const notes = [`${n(restored, "product", "products")} put back`];
  if (rows.some((r) => r.action === "hidden")) notes.push(`${n(reticked, "product", "products")} ticked Active again`);
  if (clash.length) notes.push(`${n(clash.length, "was", "were")} not put back because the same product was added again since: ${more(clash)}`);
  if (already.length) notes.push(`${n(already.length, "was", "were")} already back: ${more(already)}`);
  if (handTicked.length) notes.push(`${n(handTicked.length, "was", "were")} already ticked Active by hand`);
  const undoNote = `${notes.join(". ")}.`;

  stmts.push(
    db
      .update(schema.productDeletes)
      .set({ status: "undone", undoneAt: now, undoneBy: actorName, undoNote, updatedAt: now })
      .where(eq(schema.productDeletes.id, del.id)),
  );
  logs.push({
    entityType: "product_delete",
    entityId: del.id,
    action: "products_delete_undone",
    detail: `Price list delete ${del.id}: ${undoNote}`,
    actorName,
    actorRole: "admin",
  });
  for (const part of chunk(logs, 150)) stmts.push(db.insert(schema.activityLog).values(part));
  await runBatch(stmts);
  return { deleteId: del.id, restored, reticked, note: undoNote };
}

/* ----------------------------------- log --------------------------------- */

export async function deleteLog() {
  const list = await db.select().from(schema.productDeletes).orderBy(desc(schema.productDeletes.id)).limit(20);
  const latestId = list.find((r) => r.status === "applied")?.id ?? null;
  return list.map((r) => ({
    id: r.id,
    actorName: r.actorName,
    createdAt: r.createdAt,
    deleted: r.deleted,
    hidden: r.hidden,
    status: r.status,
    undoneAt: r.undoneAt,
    undoneBy: r.undoneBy,
    undoNote: r.undoNote,
    canUndo: r.id === latestId,
  }));
}

/** The products one delete touched, for its line in the log. */
export async function deleteRows(deleteId: number) {
  const rows = await db
    .select({
      productId: schema.productDeleteRows.productId,
      action: schema.productDeleteRows.action,
      name: schema.productDeleteRows.name,
      reason: schema.productDeleteRows.reason,
      wasActive: schema.productDeleteRows.wasActive,
    })
    .from(schema.productDeleteRows)
    .where(eq(schema.productDeleteRows.deleteId, deleteId));
  const rank: Record<string, number> = { deleted: 0, hidden: 1, kept: 2 };
  return rows.sort((a, b) => (rank[a.action] ?? 3) - (rank[b.action] ?? 3) || a.name.localeCompare(b.name));
}
