/**
 * A maximum per order on a percentage supplier charge (Damien, 12 Nov 2026).
 *
 * Forbo's notice of 27 March 2026: "1.5% surcharge, capped at $180 per order".
 * A percentage charge now takes an optional "Maximum per order". The charge is
 * the percentage of the goods, or the maximum, whichever is less. It is held in
 * the rule's amount, which a percentage charge never used, so there is no
 * database step.
 *
 * Part 1 is pure: the rule maths, and the quote and sale charge lines.
 * Part 2 runs the real PO pricing and the invoice price check on a throwaway
 * database file built from schema.ts. Network is blocked and office alerts are
 * recorded, not sent.
 *
 *   bun test scripts/charge-cap.test.ts      (from packages/web)
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";
import type { SupplierChargeRule } from "../src/api/lib/pricing";
import type { FreightLine, FreightProduct, FreightRule } from "../src/api/lib/quote-freight";

// The throwaway database is named before anything that opens one is loaded,
// so no test can reach the live database.
const dir = mkdtempSync(join(tmpdir(), "charge-cap-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;

const { cappedPercentExGst, percentCapExGst, resolveSupplierCharges } = await import("../src/api/lib/pricing");
const { planQuoteFreight } = await import("../src/api/lib/quote-freight");

const TODAY = "2026-11-12";
const fuel = (o: Partial<SupplierChargeRule> = {}): SupplierChargeRule => ({
  id: 819,
  name: "Fuel Surcharge",
  kind: "fuel",
  basis: "percent_of_order",
  amount: 180,
  percent: 1.5,
  amountIncludesGst: false,
  isCredit: false,
  autoApply: true,
  effectiveFrom: "2026-10-28",
  effectiveUntil: null,
  ...o,
});
const resolve = (rules: SupplierChargeRule[], goodsExGst: number, extra: Record<string, number> = {}) =>
  resolveSupplierCharges({ name: "Flooring Distributors", deliversDirect: true }, rules, { goodsExGst, ...extra }, { today: TODAY });

/* ================================ part 1 ================================ */

describe("the maximum on the rule", () => {
  test("blank, 0 or a fixed charge has no maximum", () => {
    expect(percentCapExGst(fuel({ amount: null }))).toBeNull();
    expect(percentCapExGst(fuel({ amount: 0 }))).toBeNull();
    expect(percentCapExGst(fuel({ amount: -5 }))).toBeNull();
    expect(percentCapExGst(fuel({ basis: "order", amount: 30, percent: null }))).toBeNull();
  });
  test("$180 is $180 ex GST, and $198 inc GST is $180 ex GST", () => {
    expect(percentCapExGst(fuel())).toBe(180);
    expect(percentCapExGst(fuel({ amount: 198, amountIncludesGst: true }))).toBe(180);
  });
  test("whichever is less", () => {
    expect(cappedPercentExGst(fuel(), 1000)).toEqual({ exGst: 15, uncappedExGst: 15, capExGst: 180, capped: false });
    expect(cappedPercentExGst(fuel(), 15000)).toEqual({ exGst: 180, uncappedExGst: 225, capExGst: 180, capped: true });
    // Exactly at the maximum is not "capped": the percentage already came to it.
    expect(cappedPercentExGst(fuel(), 12000)).toEqual({ exGst: 180, uncappedExGst: 180, capExGst: 180, capped: false });
  });
});

describe("supplier charges on one order", () => {
  test("under the maximum: the percentage, and the line says what the maximum is", () => {
    const q = resolve([fuel()], 5000);
    expect(q.charges).toHaveLength(1);
    expect(q.charges[0]!.exGst).toBe(75);
    expect(q.charges[0]!.capped).toBe(false);
    expect(q.charges[0]!.note).toBe("1.5% of $5000.00 goods = $75.00 (maximum $180.00 per order).");
    expect(q.totalExGst).toBe(5075);
  });
  test("over the maximum: $180, and the line says why", () => {
    const q = resolve([fuel()], 15000);
    expect(q.charges[0]!.exGst).toBe(180);
    expect(q.charges[0]!.capped).toBe(true);
    expect(q.charges[0]!.capExGst).toBe(180);
    expect(q.charges[0]!.note).toBe("1.5% of $15000.00 goods is $225.00, over the $180.00 maximum per order, so $180.00.");
    expect(q.surchargesExGst).toBe(180);
    expect(q.totalExGst).toBe(15180);
  });
  test("no maximum: exactly as before", () => {
    const q = resolve([fuel({ amount: null })], 15000);
    expect(q.charges[0]!.exGst).toBe(225);
    expect(q.charges[0]!.capped).toBe(false);
    expect(q.charges[0]!.note).toBe("1.5% of $15000.00 goods = $225.00.");
  });
  test("a maximum inc GST is held to its ex GST figure", () => {
    const q = resolve([fuel({ amount: 198, amountIncludesGst: true })], 15000);
    expect(q.charges[0]!.exGst).toBe(180);
  });
  test("a credit with a maximum credits no more than the maximum", () => {
    const q = resolve([fuel({ isCredit: true, kind: "credit" })], 15000);
    expect(q.charges[0]!.exGst).toBe(-180);
  });
  test("on goods and charges, the maximum still holds", () => {
    const rules = [fuel({ percentBase: "goods_and_charges" }), { ...fuel({ id: 2, name: "Broken pack", kind: "handling", basis: "order", amount: 80, percent: null }) }];
    const small = resolve(rules, 1000);
    expect(small.charges.find((c) => c.id === 819)!.exGst).toBe(16.2); // 1.5% of $1,080
    const big = resolve(rules, 20000);
    expect(big.charges.find((c) => c.id === 819)!.exGst).toBe(180);
    expect(big.charges.find((c) => c.id === 819)!.note).toBe("1.5% of $20080.00 goods and charges is $301.20, over the $180.00 maximum per order, so $180.00.");
  });
  test("other charges on the order are not touched by it", () => {
    const q = resolve([fuel(), fuel({ id: 818, name: "Forbo Raw material Surcharge", kind: "other", amount: null, percent: 6.1 })], 15000);
    expect(q.charges.map((c) => [c.name, c.exGst])).toEqual([
      ["Fuel Surcharge", 180],
      ["Forbo Raw material Surcharge", 915],
    ]);
  });
});

describe("quote and Sell products charge lines", () => {
  const product: FreightProduct = { id: 1, supplierId: 7, category: "vinyl", unit: "m2" };
  const line = (qty: number, unitCost: number): FreightLine => ({ id: 1, productId: 1, lineType: "material", kind: "supply", qty, unitCost, unitPrice: unitCost * 1.6, listUnitPrice: null, freightUnitCost: null });
  const plan = (qty: number, unitCost: number) =>
    planQuoteFreight([line(qty, unitCost)], new Map([[1, product]]), new Map([[7, { id: 7, name: "Flooring Distributors" }]]), [{ ...fuel(), supplierId: 7, appliesTo: "both" } as FreightRule], 0, TODAY);
  test("over the maximum the line carries $180 and says it is capped", () => {
    const p = plan(500, 30); // $15,000 goods
    expect(p.charges).toHaveLength(1);
    expect(p.charges[0]!.unitCost).toBe(180);
    expect(p.charges[0]!.description).toBe("Supplier charge: Flooring Distributors, Fuel Surcharge (1.5%, capped at $180.00)");
  });
  test("under it, the line reads as before", () => {
    const p = plan(100, 30); // $3,000 goods
    expect(p.charges[0]!.unitCost).toBe(45);
    expect(p.charges[0]!.description).toBe("Supplier charge: Flooring Distributors, Fuel Surcharge (1.5%)");
  });
});

/* ================================ part 2 ================================ */

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const alerts: string[] = [];
let client: Client;
let m: {
  db: typeof import("../src/api/database").db;
  po: typeof import("../src/api/lib/purchase-orders");
  pc: typeof import("../src/api/lib/price-check");
};
const SUP = 70;
const FUEL = 700;
const RAW = 701;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in charge-cap tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);
  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({ ...realNotify, notifyOffice: async (kind: string) => void alerts.push(kind) }));
  m = {
    db: (await import("../src/api/database")).db,
    po: await import("../src/api/lib/purchase-orders"),
    pc: await import("../src/api/lib/price-check"),
  };
  await m.db.insert(schema.suppliers).values({ id: SUP, name: "Cap Test Flooring", code: "captest", deliversTo: "both", deliversDirect: true } as any);
  await m.db.insert(schema.supplierFeeRules).values([
    { id: FUEL, supplierId: SUP, name: "Fuel Surcharge", kind: "fuel", basis: "percent_of_order", amount: 180, percent: 1.5, autoApply: true, active: true, effectiveFrom: "2026-10-28", appliesTo: "both" },
    { id: RAW, supplierId: SUP, name: "Raw material surcharge", kind: "other", basis: "percent_of_order", amount: null, percent: 6.1, autoApply: true, active: true, effectiveFrom: "2026-10-28", appliesTo: "both" },
  ] as any);
}, 60_000);

afterAll(() => {
  client?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];
const goods = (qty: number, cost: number) => ({ kind: "goods" as const, jobMaterialId: null, productId: null, description: "Test sheet vinyl", qty, unit: "m2", unitCostExGst: cost });

describe("purchase order", () => {
  test("a $15,000 order: Fuel Surcharge $180, the 6.1% with no maximum untouched", async () => {
    const p = await m.po.pricePo({ supplierId: SUP, deliverTo: "warehouse", lines: [goods(500, 30)] }, TODAY);
    const f = p.lines.find((l) => l.description === "Fuel Surcharge")!;
    expect([f.kind, f.qty, f.unit, f.unitCostExGst, f.totalExGst]).toEqual(["charge", 1, "%", 1.5, 180]);
    expect(f.note).toContain("over the $180.00 maximum per order");
    expect(p.lines.find((l) => l.description === "Raw material surcharge")!.totalExGst).toBe(915);
    expect(p.goodsExGst).toBe(15000);
    expect(p.chargesExGst).toBe(1095);
    expect(p.totalExGst).toBe(16095);
  });
  test("a $2,000 order: Fuel Surcharge $30, as before", async () => {
    const p = await m.po.pricePo({ supplierId: SUP, deliverTo: "site", lines: [goods(100, 20)] }, TODAY);
    expect(p.lines.find((l) => l.description === "Fuel Surcharge")!.totalExGst).toBe(30);
  });
});

let invSeq = 0;
async function invoice(lines: { description: string; qty: number | null; unit: string | null; unitPriceExGst: number | null; totalExGst: number | null }[]) {
  const n = ++invSeq;
  const goodsEx = lines[0]!.totalExGst!;
  const total = lines.reduce((a, l) => a + (l.totalExGst ?? 0), 0);
  const [po] = await m.db
    .insert(schema.purchaseOrders)
    .values({ number: `PO18899${n}-1`, supplierId: SUP, status: "invoiced", kind: "job", totalExGst: total, goodsExGst: goodsEx } as any)
    .returning();
  const [inv] = await m.db
    .insert(schema.supplierInvoices)
    .values({
      supplierId: SUP,
      supplierNameRaw: "Cap Test Flooring",
      invoiceNumber: `CT${n}`,
      dedupeKey: `${SUP}|ct${n}|${n}`,
      poRefRaw: po!.number,
      poId: po!.id,
      invoiceDate: TODAY,
      goodsExGst: goodsEx,
      freightExGst: Math.round((total - goodsEx) * 100) / 100,
      totalExGst: total,
      gst: Math.round(total * 10) / 100,
      totalIncGst: Math.round(total * 110) / 100,
      lines: JSON.stringify(lines),
      matchStatus: "different",
      matchNote: "",
    } as any)
    .returning();
  return inv!.id;
}
const vinyl = { description: "Test sheet vinyl", qty: 500, unit: "m2", unitPriceExGst: 30, totalExGst: 15000 };
const raw = { description: "Raw material surcharge", qty: 1, unit: null, unitPriceExGst: 915, totalExGst: 915 };
const fuelFlags = async (id: number) => (await m.pc.draftFlags(id)).filter((f) => f.feeRuleId === FUEL);

describe("invoice price check", () => {
  test("billed the $180 maximum on $15,000: nothing to flag", async () => {
    const id = await invoice([vinyl, { description: "Fuel Surcharge", qty: 1, unit: null, unitPriceExGst: 180, totalExGst: 180 }, raw]);
    expect(await fuelFlags(id)).toEqual([]);
    // Not hidden under some other flag either: nothing at all about the fuel line.
    expect((await m.pc.draftFlags(id)).filter((f) => /fuel/i.test(`${f.title} ${f.lineText}`))).toEqual([]);
  });
  test("billed the full 1.5% ($225): flagged against $180, and nothing offered to change", async () => {
    const id = await invoice([vinyl, { description: "Fuel Surcharge", qty: 1, unit: null, unitPriceExGst: 225, totalExGst: 225 }, raw]);
    const f = await fuelFlags(id);
    expect(f).toHaveLength(1);
    expect(f[0]!.opsValue).toBe(180);
    expect(f[0]!.impactExGst).toBe(45);
    expect(f[0]!.change).toBeNull();
    expect(f[0]!.detail).toContain("more than the $180.00 maximum per order");
  });
  test("no fuel line at all: missing, at $180 not $225", async () => {
    const id = await invoice([vinyl, raw]);
    const f = await fuelFlags(id);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe("missing_charge");
    expect(f[0]!.opsValue).toBe(180);
    expect(f[0]!.detail).toContain("1.5% (maximum $180.00 per order)");
  });
  test("nothing left the machine", () => {
    expect(blocked).toEqual([]);
    expect(alerts).toEqual([]);
  });
});
