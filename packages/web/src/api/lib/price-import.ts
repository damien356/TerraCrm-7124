/**
 * Fix list 11 Oct, items 4 and 5: price list import, export and undo.
 *
 * The plan comes from lib/price-sheet.ts. This file reads what the plan needs
 * and writes what it decided, all in one batch, so an import either lands
 * whole or not at all. The confirm re-reads the file and re-plans; it never
 * trusts a plan sent back from the browser, and refuses if the plan is not the
 * one that was previewed.
 */
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  exportGrid,
  parseCsv,
  planCounts,
  planImport,
  PRICE_FIELDS,
  SHEET_COLUMNS,
  toCsv,
  type Patch,
  type Plan,
  type Product,
} from "./price-sheet";
import { gridToXlsx, xlsxToGrid } from "./price-xlsx";

export type SheetFile = { fileName: string; csv?: string; xlsxBase64?: string };
type ActorLite = { userId: string; name: string };

const money = (n: unknown) => (typeof n === "number" ? `$${n.toFixed(2)}` : "none");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });

async function gridOf(file: SheetFile): Promise<string[][]> {
  if (file.xlsxBase64) {
    try {
      return await xlsxToGrid(file.xlsxBase64);
    } catch {
      throw new ORPCError("BAD_REQUEST", { message: "That Excel file could not be read. Save it as .xlsx or .csv and try again." });
    }
  }
  return parseCsv(file.csv ?? "");
}

async function loadAll() {
  const [products, suppliers] = await Promise.all([
    db.select().from(schema.products).orderBy(asc(schema.products.id)),
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers),
  ]);
  return { products, suppliers };
}

async function planFor(file: SheetFile): Promise<Plan> {
  const [grid, all] = await Promise.all([gridOf(file), loadAll()]);
  return planImport(grid, all.products, all.suppliers);
}

/** What the preview screen shows. Before/after stay on the server. */
function view(plan: Plan, fileName: string) {
  return {
    fileName,
    hash: plan.hash,
    counts: planCounts(plan),
    fileErrors: plan.fileErrors,
    ignoredColumns: plan.ignoredColumns,
    updates: plan.updates
      .filter((u) => !u.discontinues)
      .map((u) => ({ row: u.row, productId: u.productId, name: u.name, changes: u.changes, warnings: u.warnings })),
    discontinued: plan.updates
      .filter((u) => u.discontinues)
      .map((u) => ({ row: u.row, productId: u.productId, name: u.name, changes: u.changes, warnings: u.warnings })),
    creates: plan.creates.map((c) => ({
      row: c.row,
      name: c.name,
      supplier: c.values.supplier,
      category: c.values.category ?? "",
      unit: c.values.unit ?? "",
      cost: c.values.costPrice ?? null,
      sell: c.values.sellPrice ?? null,
      warnings: c.warnings,
    })),
    errors: plan.errors,
    warnings: plan.warnings,
  };
}
export type ImportPreview = ReturnType<typeof view>;

export async function previewImport(file: SheetFile) {
  return view(await planFor(file), file.fileName);
}

/** Next free id, past every id ever used, so a new row never takes a deleted row's number. */
async function nextId(table: "products" | "price_imports") {
  const res = await db.all<{ n: number | null }>(
    sql`select max(coalesce((select seq from sqlite_sequence where name = ${table}), 0), coalesce((select max(id) from ${sql.identifier(table)}), 0)) + 1 as n`,
  );
  return Number(res[0]?.n ?? 1);
}

function priceDetail(file: string, unit: string, before: Patch, after: Patch) {
  const parts: string[] = [];
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const name: Record<string, string> = { costPrice: "Cost", sellPrice: "Sell", cutCostPrice: "Cut price", rollPrice: "Roll price" };
  for (const f of PRICE_FIELDS) if (f in a) parts.push(`${name[f]} ${money(b[f])} to ${money(a[f])}`);
  return `Price list import "${file}": ${parts.join(". ")} per ${unit}.`;
}

function otherDetail(file: string, changes: { label: string; from: string; to: string }[]) {
  return `Price list import "${file}": ${changes.map((c) => `${c.label} ${c.from} to ${c.to}`).join(". ")}.`;
}

const chunk = <T,>(list: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
};

async function runBatch(stmts: BatchItem<"sqlite">[]) {
  if (!stmts.length) return;
  await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

export async function applyImport(file: SheetFile, expectHash: string, actor: ActorLite) {
  const plan = await planFor(file);
  if (plan.fileErrors.length) throw new ORPCError("BAD_REQUEST", { message: plan.fileErrors.join(" ") });
  if (plan.hash !== expectHash) {
    throw new ORPCError("CONFLICT", { message: "The price list changed since the preview. Check the preview again, then confirm." });
  }
  if (!plan.updates.length && !plan.creates.length) {
    throw new ORPCError("BAD_REQUEST", { message: "Nothing to import. Every row is either the same as now or has an error." });
  }
  const counts = planCounts(plan);
  const importId = await nextId("price_imports");
  let pid = await nextId("products");
  const created = plan.creates.map((c) => ({ ...c, id: pid++ }));
  const now = new Date();
  const actorName = actor.name || "Admin";
  const src = `Price list import "${file.fileName}" on ${today()}`;

  const stmts: BatchItem<"sqlite">[] = [
    db.insert(schema.priceImports).values({
      id: importId,
      fileName: file.fileName,
      actorName,
      actorUserId: actor.userId,
      counts: JSON.stringify(counts),
      status: "applied",
    }),
  ];
  for (const u of plan.updates) {
    stmts.push(db.update(schema.products).set({ ...u.after, updatedAt: now }).where(eq(schema.products.id, u.productId)));
  }
  for (const part of chunk(created, 40)) {
    stmts.push(
      db.insert(schema.products).values(
        part.map((c) => ({
          ...c.values,
          id: c.id,
          variantKey: `import|${crypto.randomUUID()}`,
          sourceNote: src,
        })),
      ),
    );
  }
  const rows = [
    ...plan.updates.map((u) => ({
      importId,
      productId: u.productId,
      action: "update",
      before: JSON.stringify(u.before),
      after: JSON.stringify(u.after),
    })),
    ...created.map((c) => ({ importId, productId: c.id, action: "create", before: null, after: JSON.stringify(c.values) })),
  ];
  for (const part of chunk(rows, 150)) stmts.push(db.insert(schema.priceImportRows).values(part));

  const unitOf = new Map<number, string>();
  const logs: (typeof schema.activityLog.$inferInsert)[] = [];
  const all = await db.select({ id: schema.products.id, unit: schema.products.unit }).from(schema.products).where(
    inArray(
      schema.products.id,
      plan.updates.map((u) => u.productId).concat([-1]),
    ),
  );
  for (const p of all) unitOf.set(p.id, p.unit);
  for (const u of plan.updates) {
    const priced = u.changes.filter((c) => c.price);
    const other = u.changes.filter((c) => !c.price);
    if (priced.length) {
      logs.push({
        entityType: "product",
        entityId: u.productId,
        action: "standard_price_changed",
        detail: priceDetail(file.fileName, (u.after.unit ?? unitOf.get(u.productId)) || "unit", u.before, u.after),
        actorName,
        actorRole: "admin",
      });
    }
    if (other.length) {
      logs.push({
        entityType: "product",
        entityId: u.productId,
        action: u.discontinues ? "product_discontinued" : "product_updated",
        detail: otherDetail(file.fileName, other),
        actorName,
        actorRole: "admin",
      });
    }
  }
  for (const c of created) {
    logs.push({
      entityType: "product",
      entityId: c.id,
      action: "product_created",
      detail: `Added by price list import "${file.fileName}". Cost ${money(c.values.costPrice)}, sell ${money(c.values.sellPrice)} per ${c.values.unit}.`,
      actorName,
      actorRole: "admin",
    });
  }
  logs.push({
    entityType: "price_import",
    entityId: importId,
    action: "price_import_applied",
    detail: `"${file.fileName}": ${counts.updated} updated, ${counts.created} new, ${counts.discontinued} discontinued, ${counts.errors} skipped.`,
    actorName,
    actorRole: "admin",
  });
  for (const part of chunk(logs, 150)) stmts.push(db.insert(schema.activityLog).values(part));

  await runBatch(stmts);
  return { importId, counts };
}

/* --------------------------------- undo --------------------------------- */

const sameVal = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.0005;
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === "")) return true;
  return a === b;
};

/** Tables that point at a product and keep their row when it goes. A product they use is never deleted. */
async function productsInUse(ids: number[]): Promise<Set<number>> {
  const used = new Set<number>();
  if (!ids.length) return used;
  const tables = [
    schema.quoteItems,
    schema.jobMaterials,
    schema.purchaseOrderLines,
    schema.quotePriceHistory,
    schema.priceFlags,
    schema.installerAccountEntries,
  ] as const;
  for (const t of tables) {
    const rows = await db.select({ id: t.productId }).from(t).where(inArray(t.productId, ids));
    for (const r of rows) if (r.id != null) used.add(r.id);
  }
  return used;
}

/**
 * The newest import still applied. Undo works like a stack: undo the last one,
 * then the one before it becomes the last, and so on.
 */
async function latestImport() {
  const [row] = await db
    .select()
    .from(schema.priceImports)
    .where(eq(schema.priceImports.status, "applied"))
    .orderBy(desc(schema.priceImports.id))
    .limit(1);
  return row ?? null;
}

export async function undoLastImport(actor: ActorLite) {
  const imp = await latestImport();
  if (!imp) throw new ORPCError("BAD_REQUEST", { message: "There is no import to undo." });
  const rows = await db.select().from(schema.priceImportRows).where(eq(schema.priceImportRows.importId, imp.id));
  const ids = rows.map((r) => r.productId);
  const current = new Map<number, Product>();
  for (const part of chunk(ids, 500)) {
    for (const p of await db.select().from(schema.products).where(inArray(schema.products.id, part))) current.set(p.id, p);
  }
  const createdIds = rows.filter((r) => r.action === "create").map((r) => r.productId);
  const inUse = await productsInUse(createdIds);

  const now = new Date();
  const actorName = actor.name || "Admin";
  const stmts: BatchItem<"sqlite">[] = [];
  const logs: (typeof schema.activityLog.$inferInsert)[] = [];
  let restored = 0;
  let removed = 0;
  const keptInUse: string[] = [];
  const handEdited: string[] = [];
  let gone = 0;

  for (const r of rows) {
    const p = current.get(r.productId);
    if (!p) {
      gone++;
      continue;
    }
    const name = [p.brand, p.range, p.colour].filter(Boolean).join(" ");
    if (r.action === "create") {
      if (inUse.has(p.id)) {
        stmts.push(db.update(schema.products).set({ active: false, updatedAt: now }).where(eq(schema.products.id, p.id)));
        keptInUse.push(name);
        logs.push({
          entityType: "product",
          entityId: p.id,
          action: "product_discontinued",
          detail: `Undo of price list import "${imp.fileName}": kept as discontinued because a quote or order uses it.`,
          actorName,
          actorRole: "admin",
        });
      } else {
        stmts.push(db.delete(schema.products).where(eq(schema.products.id, p.id)));
        removed++;
      }
      continue;
    }
    const before = JSON.parse(r.before ?? "{}") as Record<string, unknown>;
    const after = JSON.parse(r.after) as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    let skipped = false;
    for (const k of Object.keys(after)) {
      if (sameVal((p as Record<string, unknown>)[k], after[k])) set[k] = before[k] ?? null;
      else skipped = true;
    }
    if (skipped) handEdited.push(name);
    if (!Object.keys(set).length) continue;
    stmts.push(db.update(schema.products).set({ ...(set as Patch), updatedAt: now }).where(eq(schema.products.id, p.id)));
    restored++;
    const priceBack = PRICE_FIELDS.filter((f) => f in set);
    if (priceBack.length) {
      const label: Record<string, string> = { costPrice: "Cost", sellPrice: "Sell", cutCostPrice: "Cut price", rollPrice: "Roll price" };
      logs.push({
        entityType: "product",
        entityId: p.id,
        action: "standard_price_changed",
        detail: `Undo of price list import "${imp.fileName}": ${priceBack.map((f) => `${label[f]} ${money(after[f])} back to ${money(set[f])}`).join(". ")} per ${p.unit}.`,
        actorName,
        actorRole: "admin",
      });
    }
  }

  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const more = (list: string[]) => `${list.slice(0, 10).join(", ")}${list.length > 10 ? "..." : ""}`;
  const notes: string[] = [`${n(restored, "product", "products")} put back`, `${n(removed, "new product", "new products")} removed`];
  if (keptInUse.length) notes.push(`${n(keptInUse.length, "new product", "new products")} kept as discontinued because a quote or order uses ${keptInUse.length === 1 ? "it" : "them"}: ${more(keptInUse)}`);
  if (handEdited.length) notes.push(`${n(handEdited.length, "product was", "products were")} changed by hand after the import, so those changes were kept: ${more(handEdited)}`);
  if (gone) notes.push(`${n(gone, "product was", "products were")} already deleted`);
  const undoNote = notes.join(". ") + ".";

  stmts.push(
    db
      .update(schema.priceImports)
      .set({ status: "undone", undoneAt: now, undoneBy: actorName, undoNote, updatedAt: now })
      .where(eq(schema.priceImports.id, imp.id)),
  );
  logs.push({
    entityType: "price_import",
    entityId: imp.id,
    action: "price_import_undone",
    detail: `"${imp.fileName}": ${undoNote}`,
    actorName,
    actorRole: "admin",
  });
  for (const part of chunk(logs, 150)) stmts.push(db.insert(schema.activityLog).values(part));
  await runBatch(stmts);
  return { importId: imp.id, restored, removed, keptInUse: keptInUse.length, handEdited: handEdited.length, note: undoNote };
}

/* ---------------------------------- log --------------------------------- */

export async function importLog() {
  const list = await db.select().from(schema.priceImports).orderBy(desc(schema.priceImports.id)).limit(20);
  const latestId = list.find((r) => r.status === "applied")?.id ?? null;
  return list.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    actorName: r.actorName,
    createdAt: r.createdAt,
    counts: JSON.parse(r.counts || "{}") as ReturnType<typeof planCounts>,
    status: r.status,
    undoneAt: r.undoneAt,
    undoneBy: r.undoneBy,
    undoNote: r.undoNote,
    canUndo: r.id === latestId,
  }));
}

/** The changes one import made, for its line in the log. */
export async function importRows(importId: number) {
  const rows = await db.select().from(schema.priceImportRows).where(eq(schema.priceImportRows.importId, importId)).limit(2000);
  const ids = rows.map((r) => r.productId);
  const names = new Map<number, string>();
  for (const part of chunk(ids, 500)) {
    const ps = await db
      .select({ id: schema.products.id, brand: schema.products.brand, range: schema.products.range, colour: schema.products.colour })
      .from(schema.products)
      .where(inArray(schema.products.id, part));
    for (const p of ps) names.set(p.id, [p.brand, p.range, p.colour].filter(Boolean).join(" "));
  }
  return rows.map((r) => {
    const after = JSON.parse(r.after) as Record<string, unknown>;
    return {
      productId: r.productId,
      action: r.action,
      name: names.get(r.productId) ?? [after.brand, after.range, after.colour].filter(Boolean).join(" ") + " (removed)",
      before: r.before ? (JSON.parse(r.before) as Record<string, unknown>) : null,
      after,
    };
  });
}

/* -------------------------------- export -------------------------------- */

/** Same filter as the Price list screen: the search box and Show discontinued. */
export async function exportPriceList(opts: { search: string; includeDiscontinued: boolean; format: "csv" | "xlsx" }) {
  const all = (await db.select().from(schema.products).orderBy(asc(schema.products.brand), asc(schema.products.range))).filter(
    (p) => {
      if (!opts.includeDiscontinued && !p.active) return false;
      const q = opts.search.trim().toLowerCase();
      if (!q) return true;
      return [p.supplier, p.brand, p.range, p.colour, p.sku].join(" ").toLowerCase().includes(q);
    },
  );
  const grid = exportGrid(all);
  const base = `terra-price-list-${today()}`;
  if (opts.format === "xlsx") return { filename: `${base}.xlsx`, count: all.length, csv: null, xlsxBase64: await gridToXlsx(grid) };
  return { filename: `${base}.csv`, count: all.length, csv: toCsv(grid), xlsxBase64: null };
}

export function templateCsv() {
  return { filename: "terra-price-list-template.csv", csv: toCsv([[...SHEET_COLUMNS]]) };
}
