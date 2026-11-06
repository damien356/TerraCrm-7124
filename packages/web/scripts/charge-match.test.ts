/**
 * Supplier invoice charge matching (Karndean CI155812 against PO188007-1,
 * Damien's brief 6 Nov 2026, section 6).
 *
 * Part 1 is the pure comparison (lib/charge-match.ts): every row of the
 * brief's verification table on the real invoice and PO lines.
 * Part 2 runs the whole recheck (placeInvoice, settlePo, price checks) on a
 * throwaway database file built from schema.ts: old wrong flags are
 * withdrawn and kept, decided ones stay decided, an old approval cannot
 * apply, and no supplier rate changes by itself.
 *
 * Nothing leaves: fetch is blocked and office alerts are recorded, not sent.
 * Run from packages/web: bun test scripts/charge-match.test.ts
 * With every test file at once, use bun test --isolate: each file builds its
 * own throwaway database, and without --isolate they share one db client.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";
import { compareToPo, type ChargeRule, type InvLine, type PoLine } from "../src/api/lib/charge-match";

/* ------------------------------ the real data ------------------------------ */

// CI155812 lines exactly as the reader saved them (live invoice 276).
const CI155812: InvLine[] = [
  { description: "LLP329 LOOSE LAY LONGBOARD PURE FABRIC OAK", qty: 189, unit: "m2", unitPriceExGst: 45.3, totalExGst: 8561.7 },
  { description: "HANDLING", qty: 1, unit: null, unitPriceExGst: 80, totalExGst: 80 },
  { description: "RESILOOP", qty: 189, unit: null, unitPriceExGst: 0.09, totalExGst: 17.01 },
  { description: "FUELSURCH", qty: 189, unit: null, unitPriceExGst: 0.4, totalExGst: 75.6 },
];
// PO188007-1 lines as saved when it went out (live PO 21).
const PO188007: PoLine[] = [
  { id: 41, kind: "goods", description: "Karndean LooseLay Longboard in Pure Fabric Oak", qty: 189, unit: "m2", unitCostExGst: 45.3, totalExGst: 8561.7, productId: 9246 },
  { id: 42, kind: "charge", description: "Fuel Surcharge", qty: 189, unit: "m2", unitCostExGst: 0.4, totalExGst: 75.6, productId: null },
  { id: 43, kind: "charge", description: "Resiloop recycling levy", qty: 189, unit: "m2", unitCostExGst: 0.09, totalExGst: 17.01, productId: null },
  { id: 44, kind: "freight", description: "Delivery to Gold Coast warehouse", qty: 1, unit: "order", unitCostExGst: 100.7, totalExGst: 100.7, productId: null },
];
// CI154416 (live invoice 235) and its own PO, PO188014-1 (live PO 12).
const CI154416: InvLine[] = [
  { description: "VGW129T-7 VAN GOGH - WASHED BLACKBUTT", qty: 42.25, unit: "m2", unitPriceExGst: 23.91, totalExGst: 1009.78 },
  { description: "HANDLING", qty: 1, unit: null, unitPriceExGst: 80, totalExGst: 80 },
  { description: "RESILOOP", qty: 42.25, unit: null, unitPriceExGst: 0.09, totalExGst: 3.8 },
  { description: "FUELSURCH", qty: 42.25, unit: null, unitPriceExGst: 0.4, totalExGst: 16.9 },
];
const PO188014: PoLine[] = [
  { id: 21, kind: "goods", description: "Karndean Van Gogh Gluedown in Washed Blackbutt", qty: 42.31, unit: "m2", unitCostExGst: 23.9, totalExGst: 1011.24, productId: 9322 },
  { id: 22, kind: "charge", description: "Fuel Surcharge", qty: 42.31, unit: "m2", unitCostExGst: 0.4, totalExGst: 16.92, productId: null },
  { id: 23, kind: "charge", description: "Resiloop recycling levy", qty: 42.31, unit: "m2", unitCostExGst: 0.09, totalExGst: 3.81, productId: null },
  { id: 24, kind: "freight", description: "Delivery to Gold Coast warehouse", qty: 1, unit: "order", unitCostExGst: 80, totalExGst: 80, productId: null },
];

/** Karndean's three charges after the fix: 795 renamed, $80 restored, invoice wording added. */
const rule = (r: Partial<ChargeRule> & Pick<ChargeRule, "id" | "name" | "kind" | "basis" | "amount">): ChargeRule => ({ percent: null, amountIncludesGst: false, invoiceNames: "", ...r });
const KARNDEAN: ChargeRule[] = [
  rule({ id: 793, name: "Fuel Surcharge", invoiceNames: "FUELSURCH", kind: "fuel", basis: "m2", amount: 0.4 }),
  rule({ id: 794, name: "Resiloop recycling levy", invoiceNames: "RESILOOP", kind: "levy", basis: "m2", amount: 0.09 }),
  rule({ id: 795, name: "Handling / Freight", invoiceNames: "HANDLING, Delivery to Gold Coast warehouse", kind: "delivery", basis: "order", amount: 80 }),
];
const SKUS = { skuByProductId: new Map([[9246, "LLP329"], [9322, "VGW129T"]]) };
const po276 = { number: "PO188007-1", totalExGst: 8755.01, lines: PO188007 };
const SUMMARY_276 =
  "Invoice is $20.70 ex GST below PO188007-1. Handling / Freight was billed at $80.00 against the $100.70 allowance. Product, fuel surcharge and Resiloop recycling levy match the PO.";

// CI154416: every per-m2 line is billed at the PO rate on 42.25 m2 against 42.31 m2. $1.46 + $0.02 + $0.01 = $1.49.
const SUMMARY_235 =
  "Invoice is $1.49 ex GST below PO188014-1. " +
  "Karndean Van Gogh Gluedown in Washed Blackbutt was billed at the PO rate of $23.90 a m2 on 42.25 m2 against 42.31 m2 on the PO: $1,009.78 against $1,011.24, $1.46 less. " +
  "The invoice prints $23.91 a m2 on this line, but its amount is 42.25 m2 at $23.90 (at $23.91 it would be $1,010.20). " +
  "Fuel Surcharge was billed at the PO rate of $0.40 a m2 on 42.25 m2 against 42.31 m2 on the PO: $16.90 against $16.92, $0.02 less. " +
  "Resiloop recycling levy was billed at the PO rate of $0.09 a m2 on 42.25 m2 against 42.31 m2 on the PO: $3.80 against $3.81, $0.01 less. " +
  "Handling / Freight matches the PO.";

const withLine = (lines: InvLine[], desc: string, l: Partial<InvLine>) => lines.map((x) => (x.description === desc ? { ...x, ...l } : x));
const sumLines = (lines: InvLine[]) => Math.round(lines.reduce((a, l) => a + (l.totalExGst ?? 0), 0) * 100) / 100;

/* -------------------------------- part 1 ---------------------------------- */

describe("comparison, CI155812 against PO188007-1", () => {
  const cmp = compareToPo({ totalExGst: 8734.31, lines: CI155812 }, po276, KARNDEAN, SKUS);

  test("the exact summary from the brief", () => {
    expect(cmp.summary).toBe(SUMMARY_276);
  });

  test("$8,734.31 against $8,755.01. The only money difference is Handling / Freight, $20.70 lower", () => {
    expect(cmp.invoice).toEqual({ goods: 8561.7, charges: 92.61, freight: 80, extras: 172.61, total: 8734.31, linesTotal: 8734.31 });
    expect(cmp.po).toEqual({ number: "PO188007-1", goods: 8561.7, charges: 92.61, freight: 100.7, total: 8755.01 });
    expect(cmp.diff).toBe(-20.7);
    const off = cmp.rows.filter((r) => r.status !== "match");
    expect(off.map((r) => [r.label, r.diff, r.status])).toEqual([["Handling / Freight", -20.7, "variance"]]);
    expect(cmp.hasIncrease).toBe(false);
    expect(cmp.linesDisagree).toBe(false);
    // Each line counted once, each tied to its own PO line.
    expect(cmp.rows.map((r) => [r.invoice?.lines[0], r.po?.lineId, r.group])).toEqual([
      ["LLP329 LOOSE LAY LONGBOARD PURE FABRIC OAK", 41, "goods"],
      ["HANDLING", 44, "freight"],
      ["RESILOOP", 43, "charges"],
      ["FUELSURCH", 42, "charges"],
    ]);
    // $172.61 is only ever all the extra charges together, never a freight figure.
    expect(cmp.rows.find((r) => r.group === "freight")!.invoice!.total).toBe(80);
  });

  test("supplier wording: FUELSURCH, RESILOOP and HANDLING find their charges, whatever the case or spacing", () => {
    const ids = (lines: InvLine[]) => compareToPo({ totalExGst: sumLines(lines), lines }, po276, KARNDEAN, SKUS).rows.map((r) => r.ruleId);
    expect(ids(CI155812)).toEqual([null, 795, 794, 793]);
    const messy = CI155812.map((l) => ({ ...l, description: l.description === "HANDLING" ? " handling. " : l.description === "FUELSURCH" ? "Fuel-Surch" : l.description === "RESILOOP" ? "Resi Loop" : l.description }));
    expect(ids(messy)).toEqual([null, 795, 794, 793]);
  });

  test("an amount alone never makes a match: an $80 line called something else is not Handling / Freight", () => {
    const lines = withLine(CI155812, "HANDLING", { description: "PALLET WRAP" });
    const c = compareToPo({ totalExGst: 8734.31, lines }, po276, KARNDEAN, SKUS);
    const wrap = c.rows.find((r) => r.invoice?.lines[0] === "PALLET WRAP")!;
    expect(wrap.ruleId).toBeNull();
    expect(wrap.status).toBe("not_on_po");
    expect(c.rows.find((r) => r.po?.lineId === 44)!.status).toBe("not_billed");
  });

  test("a changed rate on a known charge is a variance on that charge, not a new charge", () => {
    const lines = withLine(CI155812, "RESILOOP", { unitPriceExGst: 0.15, totalExGst: 28.35 });
    const c = compareToPo({ totalExGst: sumLines(lines), lines }, po276, KARNDEAN, SKUS);
    const row = c.rows.find((r) => r.ruleId === 794)!;
    expect(row.status).toBe("variance");
    expect(row.po!.lineId).toBe(43);
    expect(row.diff).toBe(11.34);
    expect(row.note).toBe("Resiloop recycling levy was billed at $0.15 a m2 ($28.35) against $0.09 a m2 on the PO ($17.01), $11.34 more.");
    expect(c.rows.some((r) => r.status === "not_on_po")).toBe(false);
  });

  test("fuel at $0.45 a m2: the $9.45 increase shows even though the invoice is $11.25 under the PO", () => {
    const lines = withLine(CI155812, "FUELSURCH", { unitPriceExGst: 0.45, totalExGst: 85.05 });
    const c = compareToPo({ totalExGst: sumLines(lines), lines }, po276, KARNDEAN, SKUS);
    expect(c.diff).toBe(-11.25);
    const fuel = c.rows.find((r) => r.ruleId === 793)!;
    expect([fuel.status, fuel.diff]).toEqual(["variance", 9.45]);
    expect(c.hasIncrease).toBe(true);
    // Increases come first in the summary, so the lower total never buries one.
    expect(c.summary).toBe(
      "Invoice is $11.25 ex GST below PO188007-1. Fuel Surcharge was billed at $0.45 a m2 ($85.05) against $0.40 a m2 on the PO ($75.60), $9.45 more. Handling / Freight was billed at $80.00 against the $100.70 allowance. Product and Resiloop recycling levy match the PO.",
    );
  });

  test("a charge on the PO that the price list does not have still matches the PO", () => {
    const noResiloop = KARNDEAN.filter((r) => r.id !== 794);
    const c = compareToPo({ totalExGst: 8734.31, lines: CI155812 }, po276, noResiloop, SKUS);
    const row = c.rows.find((r) => r.invoice?.lines[0] === "RESILOOP")!;
    expect([row.ruleId, row.po?.lineId, row.status, row.group]).toEqual([null, 43, "match", "charges"]);
    expect(c.summary).toBe(SUMMARY_276);
  });

  test("separate handling and freight lines from another supplier stay separate, and an extra charge stays visible", () => {
    const rules = [
      rule({ id: 1, name: "Handling", kind: "handling", basis: "order", amount: 25 }),
      rule({ id: 2, name: "Freight", kind: "delivery", basis: "order", amount: 60 }),
    ];
    const po = {
      number: "PO-T1",
      totalExGst: 585,
      lines: [
        { id: 1, kind: "goods", description: "Hybrid Oak", qty: 10, unit: "m2", unitCostExGst: 50, totalExGst: 500, productId: null },
        { id: 2, kind: "charge", description: "Handling", qty: 1, unit: "order", unitCostExGst: 25, totalExGst: 25, productId: null },
        { id: 3, kind: "freight", description: "Freight", qty: 1, unit: "order", unitCostExGst: 60, totalExGst: 60, productId: null },
      ] satisfies PoLine[],
    };
    const lines: InvLine[] = [
      { description: "HYBRID OAK", qty: 10, unit: "m2", unitPriceExGst: 50, totalExGst: 500 },
      { description: "HANDLING FEE", qty: 1, unit: null, unitPriceExGst: 25, totalExGst: 25 },
      { description: "FREIGHT", qty: 1, unit: null, unitPriceExGst: 60, totalExGst: 60 },
      { description: "PALLET WRAP CHARGE", qty: 1, unit: null, unitPriceExGst: 15, totalExGst: 15 },
    ];
    const c = compareToPo({ totalExGst: 600, lines }, po, rules);
    expect(c.rows.map((r) => [r.invoice?.lines[0], r.ruleId, r.po?.lineId ?? null, r.group, r.status])).toEqual([
      ["HYBRID OAK", null, 1, "goods", "match"],
      ["HANDLING FEE", 1, 2, "charges", "match"],
      ["FREIGHT", 2, 3, "freight", "match"],
      ["PALLET WRAP CHARGE", null, null, "charges", "not_on_po"],
    ]);
    expect(c.invoice).toMatchObject({ goods: 500, charges: 40, freight: 60, total: 600 });
  });

  test("a line that could be two charges is shown for review, never guessed", () => {
    const rules = [
      rule({ id: 1, name: "Freight metro", invoiceNames: "FREIGHT", kind: "delivery", basis: "order", amount: 60 }),
      rule({ id: 2, name: "Freight country", invoiceNames: "FREIGHT", kind: "delivery", basis: "order", amount: 120 }),
    ];
    const c = compareToPo({ totalExGst: 560, lines: [{ description: "HYBRID OAK", qty: 10, unit: "m2", unitPriceExGst: 50, totalExGst: 500 }, { description: "FREIGHT", qty: 1, unit: null, unitPriceExGst: 60, totalExGst: 60 }] }, null, rules);
    const row = c.rows.find((r) => r.invoice?.lines[0] === "FREIGHT")!;
    expect([row.status, row.ruleId]).toEqual(["review", null]);
    expect(row.candidates).toEqual(["Freight metro", "Freight country"]);
  });

  test("a subtotal the reader picked up is never a charge of its own", () => {
    const lines = [...CI155812, { description: "Total charges", qty: null, unit: null, unitPriceExGst: null, totalExGst: 172.61 }];
    const c = compareToPo({ totalExGst: 8734.31, lines }, po276, KARNDEAN, SKUS);
    expect(c.invoice.extras).toBe(172.61);
    expect(c.invoice.linesTotal).toBe(8734.31);
    expect(c.summary).toBe(SUMMARY_276);
  });

  test("CI154416 against its own PO, PO188014-1: same rates, 0.06 m2 less on every per-m2 line, and every cent of the $1.49 is named", () => {
    const c = compareToPo({ totalExGst: 1110.48, lines: CI154416 }, { number: "PO188014-1", totalExGst: 1111.97, lines: PO188014 }, KARNDEAN, SKUS);
    expect(c.diff).toBe(-1.49);
    expect(c.rows.map((r) => [r.po?.lineId, r.status, r.diff])).toEqual([
      [21, "variance", -1.46],
      [24, "match", 0],
      [23, "match", -0.01],
      [22, "match", -0.02],
    ]);
    expect(c.hasIncrease).toBe(false);
    expect(c.summary).toBe(SUMMARY_235);
    // The named differences add up to the whole variance. Only Handling / Freight is said to match.
    expect(Math.round(c.rows.reduce((a, r) => a + r.diff, 0) * 100) / 100).toBe(c.diff);
    expect(c.rows.filter((r) => r.note.endsWith("matches the PO.")).map((r) => r.label)).toEqual(["Handling / Freight"]);
  });
});

/* -------------------------------- part 2 ---------------------------------- */

const dir = mkdtempSync(join(tmpdir(), "charge-match-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const alerts: { kind: string; title: string; body: string }[] = [];

type Mods = {
  db: typeof import("../src/api/database").db;
  match: typeof import("../src/api/lib/invoice-match");
  pc: typeof import("../src/api/lib/price-check");
  orm: typeof import("drizzle-orm");
};
let m: Mods;
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in charge-match tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);
  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({
    ...realNotify,
    notifyOffice: async (kind: string, msg: { title: string; body: string }) => {
      alerts.push({ kind, title: msg.title, body: msg.body });
    },
  }));
  m = {
    db: (await import("../src/api/database")).db,
    match: await import("../src/api/lib/invoice-match"),
    pc: await import("../src/api/lib/price-check"),
    orm: await import("drizzle-orm"),
  };
});

afterAll(() => {
  client?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];

/** Karndean as it is on live before the fix: 795 still "Delivery to Gold Coast warehouse" at $100.70 (flag 30), no invoice wording. */
async function karndeanBeforeFix() {
  const { db } = m;
  const [sup] = await db.insert(schema.suppliers).values({ name: "Karndean", code: `karndean${Date.now()}${Math.random()}` }).returning();
  const add = async (name: string, kind: string, basis: string, amount: number) =>
    (await db.insert(schema.supplierFeeRules).values({ supplierId: sup!.id, name, kind, basis, amount, autoApply: true, active: true }).returning())[0]!;
  const fuel = await add("Fuel Surcharge", "fuel", "m2", 0.4);
  const resiloop = await add("Resiloop recycling levy", "levy", "m2", 0.09);
  const handling = await add("Delivery to Gold Coast warehouse", "delivery", "order", 100.7);
  const [llp] = await db.insert(schema.products).values({ supplierId: sup!.id, brand: "Karndean", range: "LooseLay Longboard", colour: "Pure Fabric Oak", sku: "LLP329", variantKey: `LLP329-${sup!.id}`, unit: "m2", costPrice: 45.3, sellPrice: 80.12 }).returning();
  const [vgw] = await db.insert(schema.products).values({ supplierId: sup!.id, brand: "Karndean", range: "Van Gogh Gluedown", colour: "Washed Blackbutt", sku: "VGW129T", variantKey: `VGW129T-${sup!.id}`, unit: "m2", costPrice: 23.9, sellPrice: 42.27 }).returning();
  return { sup: sup!, fuel, resiloop, handling, llp: llp!, vgw: vgw! };
}

/** The fix's rule data, as the SQL script will apply it. Same records, nothing added. */
async function applyRuleData(k: Awaited<ReturnType<typeof karndeanBeforeFix>>) {
  await q("update supplier_fee_rules set invoice_names = 'FUELSURCH' where id = ?", [k.fuel.id]);
  await q("update supplier_fee_rules set invoice_names = 'RESILOOP' where id = ?", [k.resiloop.id]);
  await q("update supplier_fee_rules set name = 'Handling / Freight', invoice_names = 'HANDLING, Delivery to Gold Coast warehouse', amount = 80 where id = ?", [k.handling.id]);
}

let poSeq = 1;
let poNum = 188900;
/** A PO number the invoice reader recognises, like Karndean's own. */
const nextPo = () => `PO${poNum++}-1`;
async function poWithInvoice(supplierId: number, number: string, invNumber: string, lines: InvLine[], poLines: Omit<PoLine, "id">[], totals: { po: number; inv: number; gst: number }, matchNote = "") {
  const { db } = m;
  const [po] = await db.insert(schema.purchaseOrders).values({ number, supplierId, status: "invoiced", kind: "job", totalExGst: totals.po, goodsExGst: poLines.filter((l) => l.kind === "goods").reduce((a, l) => a + l.totalExGst, 0) }).returning();
  for (const [i, l] of poLines.entries()) await db.insert(schema.purchaseOrderLines).values({ ...l, poId: po!.id, sortOrder: i });
  const [inv] = await db
    .insert(schema.supplierInvoices)
    .values({
      supplierId,
      supplierNameRaw: "Karndean",
      invoiceNumber: invNumber,
      dedupeKey: `${supplierId}|${invNumber.toLowerCase()}|${poSeq++}`,
      poRefRaw: number,
      poId: po!.id,
      invoiceDate: "2026-11-06",
      goodsExGst: lines[0]!.totalExGst,
      // What the reader put in freight on CI155812: every extra charge together.
      freightExGst: Math.round((totals.inv - lines[0]!.totalExGst!) * 100) / 100,
      totalExGst: totals.inv,
      gst: totals.gst,
      totalIncGst: Math.round((totals.inv + totals.gst) * 100) / 100,
      lines: JSON.stringify(lines),
      matchStatus: "different",
      matchNote,
    })
    .returning();
  return { po: po!, inv: inv! };
}

const noIds = (ls: PoLine[]) => ls.map(({ id: _id, ...l }) => l);
const flagsOf = async (invoiceId: number) => q("select * from price_flags where invoice_id = ? order by id", [invoiceId]);
const invRow = async (id: number) => (await q("select * from supplier_invoices where id = ?", [id]))[0];
const ruleRow = async (id: number) => (await q("select * from supplier_fee_rules where id = ?", [id]))[0];
const oldFlag = async (invoiceId: number, supplierId: number, f: { kind: string; key: string; status?: string; feeRuleId?: number | null; change?: object | null; title: string; decidedBy?: string; outcome?: string }) =>
  (
    await q(
      "insert into price_flags (invoice_id, supplier_id, kind, fee_rule_id, title, detail, change, status, dedupe_key, decided_by, outcome, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?) returning *",
      [invoiceId, supplierId, f.kind, f.feeRuleId ?? null, f.title, "", f.change ? JSON.stringify(f.change) : null, f.status ?? "open", f.key, f.decidedBy ?? null, f.outcome ?? "", Date.now(), Date.now()],
    )
  )[0];

describe("recheck on the record (throwaway database)", () => {
  let k: Awaited<ReturnType<typeof karndeanBeforeFix>>;
  let i276: number;
  let i235: number;
  let old: Record<string, any> = {};

  beforeAll(async () => {
    k = await karndeanBeforeFix();
    const a = await poWithInvoice(k.sup.id, "PO188007-1", "CI155812", CI155812, noIds(PO188007).map((l) => ({ ...l, productId: l.kind === "goods" ? k.llp.id : null })), { po: 8755.01, inv: 8734.31, gst: 873.43 },
      "PO PO188007-1 printed on the invoice. | $20.70 ex GST less than PO PO188007-1. A part delivery, or a better price. | Freight $71.91 charged that is not on the PO.");
    const b = await poWithInvoice(k.sup.id, "PO188014-1", "CI154416", CI154416, noIds(PO188014).map((l) => ({ ...l, productId: l.kind === "goods" ? k.vgw.id : null })), { po: 1111.97, inv: 1110.48, gst: 111.05 },
      "PO PO188014-1 printed on the invoice. | Agrees with PO PO188014-1. | Freight $20.70 charged that is not on the PO.");
    i276 = a.inv.id;
    i235 = b.inv.id;
    await q("update supplier_invoices set match_status = 'matched' where id = ?", [i235]);
    // The wrong flags as they are on live: 38, 39, 40 open on CI155812; 28, 29 ignored and 30 approved on CI154416.
    old.handling = await oldFlag(i276, k.sup.id, { kind: "new_charge", key: `${i276}:l:handling`, title: 'Karndean charged "HANDLING" $80.00' });
    old.fuel = await oldFlag(i276, k.sup.id, { kind: "new_charge", key: `${i276}:l:fuelsurch`, title: 'Karndean charged "FUELSURCH" $75.60' });
    old.freight = await oldFlag(i276, k.sup.id, { kind: "fee_amount", key: `${i276}:freight`, feeRuleId: k.handling.id, change: { target: "rule", feeRuleId: k.handling.id, field: "amount", from: 100.7, to: 172.61 }, title: "Warehouse delivery $172.61" });
    old.ign1 = await oldFlag(i235, k.sup.id, { kind: "new_charge", key: `${i235}:l:handling`, status: "ignored", decidedBy: "Damien Lacey", outcome: "Ignored. Price list left as it was.", title: "HANDLING" });
    old.ign2 = await oldFlag(i235, k.sup.id, { kind: "new_charge", key: `${i235}:l:fuelsurch`, status: "ignored", decidedBy: "Damien Lacey", outcome: "Ignored. Price list left as it was.", title: "FUELSURCH" });
    old.appr = await oldFlag(i235, k.sup.id, { kind: "fee_amount", key: `${i235}:freight`, status: "approved", feeRuleId: k.handling.id, change: { target: "rule", feeRuleId: k.handling.id, field: "amount", from: 80, to: 100.7 }, decidedBy: "Damien Lacey", outcome: "Delivery to Gold Coast warehouse: $80.00 to $100.70.", title: "Warehouse delivery $100.70" });
    await applyRuleData(k);
  });

  test("CI155812 rechecked: the brief's summary, one money difference, and the wrong flags withdrawn and kept", async () => {
    const logBefore = (await q("select count(*) n from activity_log"))[0].n;
    await m.match.placeInvoice(i276);
    const inv = await invRow(i276);
    expect(inv.match_note).toBe(`PO PO188007-1 printed on the invoice. | ${SUMMARY_276}`);
    expect(inv.match_status).toBe("different");
    expect(inv.diff_ex_gst).toBe(-20.7);
    // Same invoice, same PO, nothing added.
    expect((await q("select count(*) n from supplier_invoices where invoice_number = 'CI155812'"))[0].n).toBe(1);
    expect((await q("select count(*) n from purchase_orders where number = 'PO188007-1'"))[0].n).toBe(1);
    expect((await q("select total_ex_gst from purchase_orders where number = 'PO188007-1'"))[0].total_ex_gst).toBe(8755.01);

    const flags = await flagsOf(i276);
    expect(flags.length).toBe(3);
    for (const f of flags) {
      expect(f.status).toBe("withdrawn");
      expect(f.decided_by).toBe("Invoice matching");
      expect(f.outcome).toMatch(/^Withdrawn on recheck/);
    }
    expect(flags.find((f) => f.id === old.freight.id).outcome).toContain("Its update can no longer be approved.");
    // Every change is in the log: three withdrawals and the replaced comparison.
    const log = await q("select action, detail from activity_log where entity_type = 'supplier_invoice' and entity_id = ? order by id", [i276]);
    expect(log.filter((l) => l.action === "price_check_rechecked").length).toBe(3);
    const rechecked = log.filter((l) => l.action === "match_rechecked");
    expect(rechecked.length).toBe(1);
    expect(rechecked[0].detail).toContain("A part delivery, or a better price.");
    expect(rechecked[0].detail).toContain(SUMMARY_276);
    expect((await q("select count(*) n from activity_log"))[0].n).toBe(logBefore + 4);
    expect(alerts).toEqual([]);
  });

  test("the old $172.61 update cannot be approved or ignored, and the charge stays at $80", async () => {
    await expect(m.pc.approveFlag(old.freight.id, "Damien Lacey")).rejects.toThrow(/Withdrawn on recheck/);
    await expect(m.pc.ignoreFlag(old.freight.id, "Damien Lacey")).rejects.toThrow(/Withdrawn on recheck/);
    const r = await ruleRow(k.handling.id);
    expect([r.name, r.amount, r.basis]).toEqual(["Handling / Freight", 80, "order"]);
  });

  test("Check again, again and again: same answer, nothing duplicated, nothing reopened", async () => {
    // Old "last updated" times, so a rewrite in the same second still shows.
    await q("update supplier_invoices set updated_at = 1000 where id = ?", [i276]);
    await q("update purchase_orders set updated_at = 1000 where id = (select po_id from supplier_invoices where id = ?)", [i276]);
    const before = { flags: await flagsOf(i276), log: (await q("select count(*) n from activity_log"))[0].n, inv: await invRow(i276) };
    for (let i = 0; i < 3; i++) {
      await m.pc.checkInvoicePrices(i276);
      await m.match.placeInvoice(i276);
    }
    const after = await invRow(i276);
    expect([after.match_note, after.match_status, after.diff_ex_gst]).toEqual([before.inv.match_note, before.inv.match_status, before.inv.diff_ex_gst]);
    // Nothing rewritten with the same values: the invoice and its PO keep their old times.
    expect(after.updated_at).toBe(1000);
    expect((await q("select updated_at from purchase_orders where id = ?", [after.po_id]))[0].updated_at).toBe(1000);
    expect(await flagsOf(i276)).toEqual(before.flags);
    expect((await q("select count(*) n from activity_log"))[0].n).toBe(before.log);
    expect((await q("select count(*) n from supplier_fee_rules where supplier_id = ?", [k.sup.id]))[0].n).toBe(3);
    expect((await q("select count(*) n from supplier_invoices"))[0].n).toBe(2);
  });

  test("CI154416 rechecked against its own PO: matched, and Damien's earlier decisions stay as they were", async () => {
    await m.match.placeInvoice(i235);
    const inv = await invRow(i235);
    expect(inv.match_status).toBe("matched");
    expect(inv.diff_ex_gst).toBe(-1.49);
    expect(inv.match_note).toBe(
      `PO PO188014-1 printed on the invoice. | ${SUMMARY_235}`,
    );
    const flags = await flagsOf(i235);
    expect(flags.map((f) => [f.id, f.status, f.decided_by])).toEqual([
      [old.ign1.id, "ignored", "Damien Lacey"],
      [old.ign2.id, "ignored", "Damien Lacey"],
      [old.appr.id, "approved", "Damien Lacey"],
    ]);
    expect(flags.find((f) => f.id === old.appr.id).outcome).toBe("Delivery to Gold Coast warehouse: $80.00 to $100.70.");
    // Each invoice against its own PO: CI155812 is untouched by this one.
    expect((await invRow(i276)).match_note).toBe(`PO PO188007-1 printed on the invoice. | ${SUMMARY_276}`);
  });

  test("rates stay rates: per m2 charges and the product cost are not replaced by any line total", async () => {
    expect((await ruleRow(k.fuel.id)).amount).toBe(0.4);
    expect((await ruleRow(k.resiloop.id)).amount).toBe(0.09);
    expect((await ruleRow(k.handling.id)).amount).toBe(80);
    const p = (await q("select cost_price, sell_price from products where id = ?", [k.llp.id]))[0];
    expect([p.cost_price, p.sell_price]).toEqual([45.3, 80.12]);
  });
});

describe("price checks on a changed rate (throwaway database)", () => {
  let k: Awaited<ReturnType<typeof karndeanBeforeFix>>;

  beforeAll(async () => {
    k = await karndeanBeforeFix();
    await applyRuleData(k);
  });

  const poLines = () => noIds(PO188007).map((l) => ({ ...l, productId: l.kind === "goods" ? k.llp.id : null, ...(l.kind === "freight" ? { unitCostExGst: 80, totalExGst: 80 } : {}) }));

  test("Resiloop at $0.15 a m2: a rate variance on Resiloop, approve sets the RATE, and an outdated approval is refused", async () => {
    const lines = withLine(CI155812, "RESILOOP", { unitPriceExGst: 0.15, totalExGst: 28.35 });
    const { inv } = await poWithInvoice(k.sup.id, nextPo(), "CI-R1", lines, poLines(), { po: 8734.31, inv: sumLines(lines), gst: 0 });
    await m.match.placeInvoice(inv.id);
    let flags = await flagsOf(inv.id);
    expect(flags.map((f) => [f.kind, f.fee_rule_id, f.ops_value, f.invoice_value, f.impact_ex_gst])).toEqual([["fee_amount", k.resiloop.id, 0.09, 0.15, 11.34]]);
    expect(JSON.parse(flags[0].change)).toEqual({ target: "rule", feeRuleId: k.resiloop.id, field: "amount", from: 0.09, to: 0.15 });
    expect((await invRow(inv.id)).match_status).toBe("different");

    // The invoice is read again with a different rate before anyone approves: the old approval is refused.
    const fixed = withLine(CI155812, "RESILOOP", { unitPriceExGst: 0.2, totalExGst: 37.8 });
    await q("update supplier_invoices set lines = ?, total_ex_gst = ? where id = ?", [JSON.stringify(fixed), sumLines(fixed), inv.id]);
    await expect(m.pc.approveFlag(flags[0].id, "Damien Lacey")).rejects.toThrow(/different answer/);
    expect((await ruleRow(k.resiloop.id)).amount).toBe(0.09);

    // Now the check says $0.20. Approve sets the rate, never the $37.80 line total.
    flags = await flagsOf(inv.id);
    expect(JSON.parse(flags[0].change).to).toBe(0.2);
    await m.pc.approveFlag(flags[0].id, "Damien Lacey");
    expect((await ruleRow(k.resiloop.id)).amount).toBe(0.2);
    await q("update supplier_fee_rules set amount = 0.09, condition = '' where id = ?", [k.resiloop.id]);
  });

  test("fuel at $0.45 a m2 makes the invoice different though it is $11.25 under", async () => {
    const lines = withLine(CI155812, "FUELSURCH", { unitPriceExGst: 0.45, totalExGst: 85.05 });
    const { inv } = await poWithInvoice(k.sup.id, nextPo(), "CI-F1", lines, noIds(PO188007).map((l) => ({ ...l, productId: l.kind === "goods" ? k.llp.id : null })), { po: 8755.01, inv: sumLines(lines), gst: 0 });
    await m.match.placeInvoice(inv.id);
    const row = await invRow(inv.id);
    expect(row.diff_ex_gst).toBe(-11.25);
    expect(row.match_status).toBe("different");
    expect(row.match_note).toContain("Fuel Surcharge was billed at $0.45 a m2 ($85.05) against $0.40 a m2 on the PO ($75.60), $9.45 more.");
  });

  test("handling billed higher is shown, but never offered as a change to the standing charge", async () => {
    const lines = withLine(CI155812, "HANDLING", { unitPriceExGst: 120, totalExGst: 120 });
    const { inv } = await poWithInvoice(k.sup.id, nextPo(), "CI-H1", lines, poLines(), { po: 8734.31, inv: sumLines(lines), gst: 0 });
    await m.match.placeInvoice(inv.id);
    const flags = await flagsOf(inv.id);
    expect(flags.map((f) => [f.kind, f.fee_rule_id, f.invoice_value, f.change])).toEqual([["fee_amount", k.handling.id, 120, null]]);
    await expect(m.pc.approveFlag(flags[0].id, "Damien Lacey")).rejects.toThrow(/Nothing to change/);
    expect((await ruleRow(k.handling.id)).amount).toBe(80);
    expect((await invRow(inv.id)).match_note).toContain("Handling / Freight was billed at $120.00 against the $80.00 allowance.");
  });

  test("on the PO but not in the price list: matches the PO, and the wording gap is its own quiet note", async () => {
    await q("update supplier_fee_rules set active = 0 where id = ?", [k.resiloop.id]);
    const { inv } = await poWithInvoice(k.sup.id, nextPo(), "CI-M1", CI155812, poLines(), { po: 8734.31, inv: 8734.31, gst: 0 });
    const alertsBefore = alerts.length;
    await m.match.placeInvoice(inv.id);
    const row = await invRow(inv.id);
    expect(row.match_status).toBe("matched");
    expect(row.match_note).toContain("Resiloop recycling levy");
    const flags = await flagsOf(inv.id);
    expect(flags.map((f) => f.kind)).toEqual(["charge_mapping"]);
    expect(flags[0].title).toMatch(/^"RESILOOP" is on PO1889\d+-1, but Ops does not know Karndean's wording for it$/);
    expect(flags[0].detail).not.toMatch(/no line for it|not on the PO/);
    expect(alerts.length).toBe(alertsBefore);
    await q("update supplier_fee_rules set active = 1 where id = ?", [k.resiloop.id]);
  });

  test("a genuinely new charge stays visible for review, and nothing is added by itself", async () => {
    const lines = [...CI155812, { description: "PALLET WRAP CHARGE", qty: 1, unit: null, unitPriceExGst: 15, totalExGst: 15 }];
    const { inv } = await poWithInvoice(k.sup.id, nextPo(), "CI-N1", lines, poLines(), { po: 8734.31, inv: sumLines(lines), gst: 0 });
    await m.match.placeInvoice(inv.id);
    const flags = await flagsOf(inv.id);
    expect(flags.map((f) => [f.kind, f.invoice_value, f.change])).toEqual([["new_charge", 15, null]]);
    expect((await q("select count(*) n from supplier_fee_rules where supplier_id = ?", [k.sup.id]))[0].n).toBe(3);
    expect((await invRow(inv.id)).match_note).toContain("PALLET WRAP CHARGE $15.00 is on the invoice but not on the PO.");
  });

  test("nothing left the machine", () => {
    expect(blocked).toEqual([]);
  });
});
