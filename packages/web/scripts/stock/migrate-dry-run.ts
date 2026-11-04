/**
 * Dry run of the Stage 1 stock migration. Changes nothing in the database it is given.
 *
 *   bun scripts/stock/migrate-dry-run.ts <path-to-database-file>
 *
 * 1. Opens the file read-only and stops (exit 1) if any of the four Terra Stock
 *    tables already has a row, or the migration looks applied already.
 * 2. Otherwise copies the file to a temporary folder, applies
 *    src/api/database/sql/2026-11-23-stock-stage1.sql and then
 *    2026-11-24-stock-a2.sql (A2, supply settings and warehouse orders) to the copy, checks the
 *    new tables and columns are there and every old row count is unchanged,
 *    then deletes the copy.
 * The original file is never written to.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OLD_STOCK = ["stock_movements", "stock_reservations", "stocktakes", "stocktake_lines"] as const;
const NEW_TABLES = [
  "stock_locations",
  "stock_items",
  "stock_orders",
  "stock_counts",
  "stock_payment_confirmations",
  "stock_alerts",
  "stock_permissions",
  // A2
  "stock_po_links",
  "stock_supply_approvals",
];
/** Applied in this order. A2 runs after Stage 1. */
const SQL_FILES = ["2026-11-23-stock-stage1.sql", "2026-11-24-stock-a2.sql"].map((f) => join(import.meta.dir, "../../src/api/database/sql", f));

export type DryRun = { ok: boolean; stopped?: string; rows?: Record<string, number>; created?: string[]; addedColumns?: number; countsUnchanged?: boolean };

const tables = (db: Database) => (db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((r) => r.name);
const count = (db: Database, t: string) => (db.query(`select count(*) as n from "${t}"`).get() as { n: number }).n;

export function dryRun(path: string): DryRun {
  const before = statSync(path).mtimeMs;
  const src = new Database(path, { readonly: true });
  let have: string[];
  const rows: Record<string, number> = {};
  try {
    have = tables(src);
    const missing = OLD_STOCK.filter((t) => !have.includes(t));
    if (missing.length) return { ok: false, stopped: `Not the expected database: ${missing.join(", ")} not found.` };
    for (const t of OLD_STOCK) rows[t] = count(src, t);
    const busy = OLD_STOCK.filter((t) => rows[t]! > 0);
    if (busy.length) return { ok: false, stopped: `Stopped. ${busy.map((t) => `${t} has ${rows[t]} row(s)`).join(", ")}. Nothing was changed.`, rows };
    if (have.includes("stock_items")) return { ok: false, stopped: "Stopped. stock_items already exists: the migration looks applied. Nothing was changed.", rows };
  } finally {
    src.close();
  }

  const dir = mkdtempSync(join(tmpdir(), "stock-dry-"));
  try {
    const copy = join(dir, "copy.db");
    copyFileSync(path, copy);
    const db = new Database(copy);
    const oldCounts = Object.fromEntries(have.filter((t) => !t.startsWith("sqlite_")).map((t) => [t, count(db, t)]));
    const cols = (t: string) => (db.query(`pragma table_info("${t}")`).all() as { name: string }[]).length;
    const altered = ["stock_movements", "stock_reservations", "job_costs", "invoice_payments", "products", "purchase_orders", "purchase_order_lines"];
    const colsBefore = Object.fromEntries(altered.map((t) => [t, cols(t)]));
    const statements = SQL_FILES.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0),
    );
    db.exec("begin");
    for (const s of statements) db.exec(s);
    db.exec("commit");
    const after = tables(db);
    const created = NEW_TABLES.filter((t) => after.includes(t));
    const addedColumns = altered.reduce((n, t) => n + cols(t) - colsBefore[t]!, 0);
    const countsUnchanged = Object.entries(oldCounts).every(([t, n]) => count(db, t) === n);
    db.close();
    const untouched = statSync(path).mtimeMs === before;
    const ok = created.length === NEW_TABLES.length && countsUnchanged && untouched;
    return { ok, rows, created, addedColumns, countsUnchanged, ...(untouched ? {} : { stopped: "The original file changed during the dry run." }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: bun scripts/stock/migrate-dry-run.ts <path-to-database-file>");
    process.exit(2);
  }
  const out = dryRun(path);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
