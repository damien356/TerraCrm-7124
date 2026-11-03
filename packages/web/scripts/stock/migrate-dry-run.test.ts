/**
 * The migration dry run on a small throwaway database: the four Terra Stock
 * tables as they are on live today, plus the tables the migration adds columns to.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRun } from "./migrate-dry-run";

const dir = mkdtempSync(join(tmpdir(), "stock-dry-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(name: string, extra = "") {
  const path = join(dir, name);
  const db = new Database(path);
  db.exec(`
    create table products (id integer primary key);
    create table profiles (id integer primary key);
    create table product_sale_lines (id integer primary key);
    create table job_costs (id integer primary key, amount real);
    create table invoice_payments (id integer primary key, amount real);
    create table stock_movements (id integer primary key, product_id integer, qty real);
    create table stock_reservations (id integer primary key, job_material_id integer, status text, qty real);
    create table stocktakes (id integer primary key, status text);
    create table stocktake_lines (id integer primary key, stocktake_id integer);
    insert into job_costs (amount) values (100), (200);
    ${extra}
  `);
  db.close();
  return path;
}
const hash = (p: string) => createHash("sha1").update(readFileSync(p)).digest("hex");

describe("migration dry run", () => {
  test("empty stock tables: applies cleanly to a copy, original unchanged", () => {
    const p = makeDb("clean.db");
    const before = hash(p);
    const out = dryRun(p);
    expect(out.ok).toBe(true);
    expect(out.created!.length).toBe(7);
    expect(out.addedColumns).toBe(24);
    expect(out.countsUnchanged).toBe(true);
    expect(hash(p)).toBe(before);
  });
  for (const t of ["stock_movements", "stock_reservations", "stocktakes", "stocktake_lines"]) {
    test(`a row in ${t}: stops, nothing changed`, () => {
      const p = makeDb(`${t}.db`, `insert into ${t} (id) values (1);`);
      const before = hash(p);
      const out = dryRun(p);
      expect(out.ok).toBe(false);
      expect(out.stopped).toBe(`Stopped. ${t} has 1 row(s). Nothing was changed.`);
      expect(hash(p)).toBe(before);
    });
  }
  test("already applied: stops", () => {
    const p = makeDb("applied.db", "create table stock_items (id integer primary key);");
    expect(dryRun(p).stopped).toBe("Stopped. stock_items already exists: the migration looks applied. Nothing was changed.");
  });
});
