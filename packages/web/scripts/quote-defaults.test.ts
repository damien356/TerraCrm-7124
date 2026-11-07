/**
 * Quote defaults v2 (Damien's brief, 6 Nov 2026, and his answers the same day).
 *
 *   bun test scripts/quote-defaults.test.ts      (from packages/web)
 *
 * Runs the real quote routes (addProduct, addLabour, updateItem, removeItem,
 * revise, accept, send, the public quote page, Money out) on a throwaway
 * SQLite file built from the schema. Sign in is faked: an Admin by default,
 * switched to Office (no costs), Field crew or nobody for the permission
 * tests. The office alerts are caught, and every network call is blocked, so
 * nothing leaves the machine. The rate book and products are the live records
 * Damien's table names (same ids, names, SKUs and rates), plus one floor
 * product of each type.
 *
 * The carpet disposal figures ($3.00 a m2, 15%) are put in Settings here, as
 * if an Admin had typed them in. The live database has none, and the tests
 * marked "no disposal rate" take them out again to check that case.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "quote-defaults-"));
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
const alerts: { kind: string; title: string }[] = [];
const USER = "test-admin";
/** Who is signed in. null is nobody, as on the public /q/ page. */
type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: USER, name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "test-office", name: "Test Office", email: "office@example.invalid" };
const FIELD: Who = { id: "test-field", name: "Test Crew", email: "crew@example.invalid" };
let who: Who = ADMIN;
/** Run with someone else signed in, then back to the Admin. */
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

type Mods = {
  db: typeof import("../src/api/database").db;
  quotes: typeof import("../src/api/routes/quotes").quotes;
  quoteSend: typeof import("../src/api/routes/quoteSend").quoteSend;
  quoteDefaults: typeof import("../src/api/routes/quoteDefaults").quoteDefaults;
  publicPages: typeof import("../src/api/routes/publicPages").publicPages;
  finance: typeof import("../src/api/routes/finance").finance;
  costing: typeof import("../src/api/routes/costing").costing;
  links: typeof import("../src/api/lib/quote-links");
  gate: typeof import("../src/api/lib/quote-default-gate");
  disposal: typeof import("../src/api/lib/disposal-cost");
  call: typeof import("@orpc/server").call;
  rules: typeof import("../src/api/lib/quote-default-rules");
  orm: typeof import("drizzle-orm");
};
let m: Mods;
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in quote-defaults tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({
    ...realNotify,
    notifyOffice: async (kind: string, msg: { title: string }) => {
      alerts.push({ kind, title: msg.title });
    },
  }));
  // Sign in: whoever `who` is (the Admin unless a test switches it).
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    quotes: (await import("../src/api/routes/quotes")).quotes,
    quoteSend: (await import("../src/api/routes/quoteSend")).quoteSend,
    quoteDefaults: (await import("../src/api/routes/quoteDefaults")).quoteDefaults,
    publicPages: (await import("../src/api/routes/publicPages")).publicPages,
    finance: (await import("../src/api/routes/finance")).finance,
    costing: (await import("../src/api/routes/costing")).costing,
    links: await import("../src/api/lib/quote-links"),
    gate: await import("../src/api/lib/quote-default-gate"),
    disposal: await import("../src/api/lib/disposal-cost"),
    call: (await import("@orpc/server")).call,
    rules: await import("../src/api/lib/quote-default-rules"),
    orm: await import("drizzle-orm"),
  };
  await seed();
});

afterAll(() => {
  client?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];
const ctx = () => ({ context: { headers: new Headers() } });
const run = <I, O>(proc: any, input: I) => m.call(proc, input, ctx()) as Promise<O>;

/* --------------------------------- fixtures --------------------------------- */

/** The live rate book rows these defaults use (labour_rate_items and the standard rate on file). */
const RATES: { id: number; name: string; unit: string; group: string; markup: number | null; amount: number }[] = [
  { id: 1, name: "Broadloom carpet 3.66m", unit: "lm", group: "carpet", markup: null, amount: 40 },
  { id: 2, name: "Broadloom carpet 4.0m", unit: "lm", group: "carpet", markup: null, amount: 45 },
  { id: 7, name: "Carpet uplift", unit: "lm", group: "demolition", markup: null, amount: 10 },
  { id: 15, name: "Hybrid installation", unit: "m2", group: "resilient", markup: null, amount: 28 },
  { id: 16, name: "Laminate flooring installation", unit: "m2", group: "resilient", markup: null, amount: 28 },
  { id: 17, name: "Vinyl plank / LVT installation inc glue supply", unit: "m2", group: "resilient", markup: null, amount: 25 },
  { id: 19, name: "Sheet vinyl installation looselay", unit: "m2", group: "resilient", markup: null, amount: 55 },
  { id: 20, name: "Hot welding", unit: "lm", group: "resilient", markup: null, amount: 9 },
  { id: 21, name: "Vinyl Coving 100mm", unit: "lm", group: "resilient", markup: null, amount: 12 },
  { id: 39, name: "Solid timber, secret nail and stick", unit: "m2", group: "timber", markup: 50, amount: 65 },
  { id: 65, name: "Skirting removal and refit", unit: "lm", group: "trades", markup: 50, amount: 12 },
  { id: 86, name: "Carpet disposal and tip run", unit: "m2", group: "demolition", markup: 15, amount: 4 },
  { id: 102, name: "Corner in/external", unit: "each", group: "resilient", markup: null, amount: 9 },
  { id: 109, name: "Skim floor with Smoothing compound", unit: "m2", group: "resilient", markup: null, amount: 11.5 },
  { id: 111, name: "Install trims/scotia", unit: "lm", group: "resilient", markup: null, amount: 8 },
  { id: 114, name: "Sanding coating 1 coat Polyurethane and 1 coat 2 Pac.", unit: "m2", group: "timber", markup: 70, amount: 60 },
  { id: 120, name: "Cutting gyprock", unit: "lm", group: "resilient", markup: 60, amount: 4 },
  { id: 121, name: "Install new skirting", unit: "lm", group: "trades", markup: 50, amount: 10 },
  { id: 122, name: "Skirting removal only", unit: "lm", group: "trades", markup: 50, amount: 5 },
];

const P: Record<string, number> = {};
let supplierId = 0;
let contactId = 0;
let quoteSeq = 900;
let jobSeq = 5000;

async function product(key: string, v: Partial<typeof schema.products.$inferInsert>) {
  const [row] = await m.db
    .insert(schema.products)
    .values({ supplierId, unit: "m2", costPrice: 20, sellPrice: 40, active: true, variantKey: `${key}-${Math.random()}`, ...v })
    .returning();
  P[key] = row!.id;
}

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: USER, name: "Test Admin", email: "admin@example.invalid", role: "admin", isMainAdmin: true });
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: OFFICE!.name, email: OFFICE!.email, role: "office", canSeeCosts: false });
  await db.insert(schema.profiles).values({ userId: FIELD!.id, name: FIELD!.name, email: FIELD!.email, role: "field" });
  for (const r of RATES) {
    await db.insert(schema.labourRateItems).values({ id: r.id, name: r.name, unit: r.unit, groupName: r.group, kind: "work", markupPercent: r.markup, active: true });
    await db.insert(schema.labourRates).values({ itemId: r.id, amount: r.amount, effectiveFrom: "2026-09-01" });
  }
  const [sup] = await db.insert(schema.suppliers).values({ name: "Test supplier", code: "testsup" }).returning();
  supplierId = sup!.id;
  // The two products Damien named, at their live ids.
  await db.insert(schema.products).values({
    id: 9912, supplierId, brand: "Dunlop", range: "Carpetmate Super Green", sku: "710071", variantKey: "710071", category: "carpet_underlay",
    unit: "lm", widthM: 1.83, costPrice: 9, sellPrice: 17, active: true,
  });
  await db.insert(schema.products).values({
    id: 7234, supplierId, brand: "Hurford's", range: "CD Non-Structural Pine Plywood", sku: "PNCD241215", variantKey: "PNCD241215", category: "sheet_goods",
    unit: "each", unitM2: 2.88, costPrice: 40, sellPrice: 70, active: true,
  });
  await product("carpet", { brand: "Godfrey Hirst", range: "Andes Peak", colour: "Merida", sku: "CPT1", category: "carpet", soldAs: "broadloom", unit: "lm", widthM: 3.66 });
  await product("carpetNoWidth", { brand: "Feltex", range: "No Width", colour: "Grey", sku: "CPT2", category: "carpet", soldAs: "broadloom", unit: "lm", widthM: null });
  await product("sheetVinyl", { brand: "Polyflor", range: "Expona", colour: "Oak", sku: "SV1", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2, tier: "Commercial Sheet" });
  // 7 Nov: sheet vinyl the price book does not mark commercial, as on the live price book (blank tier, "Sheet Vinyl").
  await product("sheetVinylBlank", { brand: "Tarkett", range: "Home", colour: "Beige", sku: "SV2", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 4, tier: "" });
  await product("sheetVinylPlain", { brand: "Airlay", range: "Loose", colour: "Grey", sku: "SV3", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2, tier: "Sheet Vinyl" });
  // 7 Nov: no Sold as on file, as on 714 vinyl, 10 carpet and 495 solid timber products live.
  await product("vinylUnsorted", { brand: "Unsorted", range: "Vinyl", colour: "X", sku: "UV1", category: "vinyl", soldAs: null, unit: "m2" });
  await product("carpetUnsorted", { brand: "Unsorted", range: "Carpet", colour: "X", sku: "UC1", category: "carpet", soldAs: null, unit: "m2" });
  await product("timberUnsorted", { brand: "Unsorted", range: "Timber", colour: "X", sku: "UT1", category: "solid_timber", soldAs: null, unit: "m2" });
  // 7 Nov: 4.0 m broadloom, for Super Green 9912 (1.83 m) off a 4 m carpet.
  await product("carpet4", { brand: "Godfrey Hirst", range: "Wide", colour: "Stone", sku: "CPT4", category: "carpet", soldAs: "broadloom", unit: "lm", widthM: 4 });
  await product("vinylPlank", { brand: "Karndean", range: "Van Gogh", colour: "Ash", sku: "VP1", category: "vinyl", soldAs: "box", unit: "m2", unitsPerPack: 10, unitM2: 0.2 });
  await product("laminate", { brand: "Quickstep", range: "Classic", colour: "Oak", sku: "LM1", category: "laminate", soldAs: "box", unit: "m2", unitsPerPack: 8, unitM2: 0.25 });
  await product("hybrid", { brand: "Woodland", range: "Hybrid", colour: "Spotted Gum", sku: "HY1", category: "hybrid", soldAs: "box", unit: "m2", unitsPerPack: 10, unitM2: 0.2 });
  await product("solidTimber", { brand: "Boral", range: "Solid", colour: "Blackbutt", sku: "ST1", category: "solid_timber", soldAs: "box", unit: "m2", unitsPerPack: 10, unitM2: 0.1 });
  await product("scotia", { brand: "Terra", range: "Scotia", colour: "White", sku: "SC1", category: "scotia", unit: "lm" });
  await product("trim", { brand: "Terra", range: "Reducer", colour: "Silver", sku: "TR1", category: "trim", unit: "each" });
  await product("accTrim", { brand: "Terra", range: "Aluminium Trim End", colour: "Silver", sku: "AC1", category: "accessory", unit: "each" });
  await product("accGlue", { brand: "Terra", range: "Glue", colour: "", sku: "AC2", category: "accessory", unit: "each" });
  await db.insert(schema.settings).values([
    { key: "carpet_disposal_cost_per_m2", value: "3" },
    { key: "carpet_disposal_markup_pct", value: "15" },
  ]);
  const [c] = await db.insert(schema.contacts).values({ firstName: "Test", lastName: "Client", email: "client@example.invalid" }).returning();
  contactId = c!.id;
}

async function newQuote(opts: { status?: string; source?: string } = {}) {
  let jobId: number | null = null;
  if (opts.source) {
    const [j] = await m.db.insert(schema.jobs).values({ number: jobSeq++, title: "Sale", source: opts.source, contactId }).returning();
    jobId = j!.id;
  }
  const [row] = await m.db
    .insert(schema.quotes)
    .values({ number: quoteSeq++, status: opts.status ?? "draft", contactId, jobId })
    .returning();
  return row!.id;
}

type Item = typeof schema.quoteItems.$inferSelect;
const linesOf = async (quoteId: number): Promise<Item[]> =>
  m.db.select().from(schema.quoteItems).where(m.orm.eq(schema.quoteItems.quoteId, quoteId)).orderBy(schema.quoteItems.sortOrder);
const lineOf = async (id: number): Promise<Item> => (await m.db.select().from(schema.quoteItems).where(m.orm.eq(schema.quoteItems.id, id)))[0]!;
/** What a quote reads as: description, qty, unit price, flagged. In sort order. */
const shape = (ls: Item[]) => ls.map((l) => [l.description, l.qty, l.unitPrice, l.flagged] as const);

const addProduct = (input: Record<string, unknown>) =>
  run<Record<string, unknown>, { item: Item; defaultsNote: string | null; defaultsAdded: number }>(m.quotes.addProduct, input);
const addLabour = (input: Record<string, unknown>) => run<Record<string, unknown>, { item: Item }>(m.quotes.addLabour, input);
const updateItem = (input: Record<string, unknown>) => run<Record<string, unknown>, { item: Item }>(m.quotes.updateItem, input);
const removeItem = (id: number) =>
  run<{ id: number }, { removedLabour: number; removedDefaults: number; disposalFlagged: number; installsKept: number; trimsFlagged: number }>(m.quotes.removeItem, { id });

const sell = (cost: number, pct: number | null) => {
  // The labour sell the rate book gives, read back off the route rather than worked out here.
  void cost;
  void pct;
};
void sell;

/* ---------------------------------- tests ---------------------------------- */

describe("§6 the six floor types", () => {
  test("carpet: install, Super Green underlay, uplift at measured / width, disposal at $3.45 a m2", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30, wastagePct: 10 });
    const ls = await linesOf(qid);
    const d = ls.map((l) => l.description);
    // Carpet: 30 m2 + 10% = 33 m2 / 3.66 = 9.1 lm (up to 0.1).
    expect(d[0]).toBe("Godfrey Hirst Andes Peak in Merida");
    expect(ls[0]!.qty).toBe(9.1);
    expect(d[1]).toBe("Broadloom carpet 3.66m");
    expect(ls[1]!.labourForItemId).toBe(r.item.id);

    const underlay = ls.find((l) => l.productId === 9912)!;
    expect(underlay.defaultForItemId).toBe(r.item.id);
    expect(underlay.followsItemId).toBe(r.item.id);
    expect(underlay.defaultKey).toBe("product:9912");

    const uplift = ls.find((l) => l.rateItemId === 7)!;
    // 30 m2 / 3.66 = 8.197 -> 8.2 lm. No wastage.
    expect(uplift.qty).toBe(8.2);
    expect(uplift.checkRequired).toBe(true);
    expect(uplift.defaultForItemId).toBe(r.item.id);
    expect(uplift.flagged).toBe(false);

    const disposal = ls.find((l) => l.kind === "internal_charge")!;
    expect(disposal.description).toBe(m.rules.DISPOSAL_DESCRIPTION);
    expect(disposal.defaultForItemId).toBe(uplift.id);
    expect(disposal.qty).toBe(30.01); // 8.2 lm x 3.66 = 30.012
    expect(disposal.unitCost).toBe(3);
    expect(disposal.unitPrice).toBe(3.45);
    expect(disposal.total).toBe(103.53);
    expect(disposal.flagged).toBe(false);
    // Item 86 (contractor paid) is never used.
    expect(ls.some((l) => l.rateItemId === 86)).toBe(false);
    // Order: carpet, its install, then the defaults, disposal straight under its uplift.
    expect(ls.indexOf(disposal)).toBe(ls.indexOf(uplift) + 1);
    expect(r.defaultsAdded).toBe(3);
    expect(r.defaultsNote).toContain("3 default lines put on underneath");
    console.log("carpet:", JSON.stringify(shape(ls)));
  });

  test("sheet vinyl (commercial roll): install, skim at measured m2, coving, corners and hot welding at 0 flagged", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.sheetVinyl, measuredM2: 20, wastagePct: 10 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 19, 109, 21, 102, 20]);
    const by = (id: number) => ls.find((l) => l.rateItemId === id)!;
    expect(by(19).labourForItemId).toBe(r.item.id);
    expect(by(109).qty).toBe(20);
    expect(by(109).flagged).toBe(false);
    for (const id of [21, 102, 20]) {
      expect(by(id).qty).toBe(0);
      expect(by(id).flagged).toBe(true);
      expect(by(id).flagReason).toStartWith(m.rules.DEFAULT_FLAG_PREFIX);
      expect(by(id).defaultForItemId).toBe(r.item.id);
    }
    expect(by(21).flagReason).toContain("coving length (lm)");
    expect(by(102).flagReason).toContain("number of corners");
    expect(by(20).flagReason).toContain("hot welding length (lm)");
    console.log("sheet vinyl:", JSON.stringify(shape(ls)));
  });

  test("vinyl plank: install and skim at measured m2 only", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 15.5, wastagePct: 5 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 17, 109]);
    expect(ls[2]!.qty).toBe(15.5);
    console.log("vinyl plank:", JSON.stringify(shape(ls)));
  });

  test("laminate: install, cutting gyprock, trims/scotia and skirting, each at 0 flagged", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 40, wastagePct: 10 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 16, 120, 111, 65]);
    for (const l of ls.slice(2)) {
      expect(l.qty).toBe(0);
      expect(l.flagged).toBe(true);
    }
    console.log("laminate:", JSON.stringify(shape(ls)));
  });

  test("hybrid: install, trims/scotia and skirting, each at 0 flagged", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 40, wastagePct: 10 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 15, 111, 65]);
    console.log("hybrid:", JSON.stringify(shape(ls)));
  });

  test("solid timber: install, plywood 7234 at ceil(measured / 2.88) sheets, sanding at measured m2", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.solidTimber, measuredM2: 25, wastagePct: 10 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId ?? l.productId)).toEqual([P.solidTimber, 39, 7234, 114]);
    const ply = ls.find((l) => l.productId === 7234)!;
    expect(ply.qty).toBe(9); // 25 / 2.88 = 8.68 -> 9 sheets, no wastage
    expect(ply.description).toBe("Hurford's CD Non-Structural Pine Plywood");
    expect(ply.defaultForItemId).toBe(r.item.id);
    expect(ls.find((l) => l.rateItemId === 114)!.qty).toBe(25);
    console.log("solid timber:", JSON.stringify(shape(ls)));
  });

  test("the install stays on with the defaults, and unticking the install puts no defaults on", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 10, labour: null });
    const ls = await linesOf(qid);
    expect(ls).toHaveLength(1);
  });
});

describe("check 1: removed defaults stay removed", () => {
  test("a removed skim does not come back when the area changes, and the install stays", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 10 });
    const skim = (await linesOf(qid)).find((l) => l.rateItemId === 109)!;
    const out = await removeItem(skim.id);
    expect(out.removedDefaults).toBe(0);
    await updateItem({ id: r.item.id, measuredM2: 12 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 17]);
    expect(ls[1]!.qty).toBe(12);
    expect(m.rules.appliedOf(ls[0]!.defaultsApplied)).toContain("floor:109");
  });

  test("defaults follow a new area unless typed over", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.sheetVinyl, measuredM2: 20 });
    const skim = (await linesOf(qid)).find((l) => l.rateItemId === 109)!;
    await updateItem({ id: r.item.id, measuredM2: 24 });
    expect((await lineOf(skim.id)).qty).toBe(24);
    await updateItem({ id: skim.id, qty: 18 });
    await updateItem({ id: r.item.id, measuredM2: 30 });
    expect((await lineOf(skim.id)).qty).toBe(18);
  });

  test("a 0 qty flag clears once a length is typed in", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    const skirting = (await linesOf(qid)).find((l) => l.rateItemId === 65)!;
    expect(skirting.flagged).toBe(true);
    const out = await updateItem({ id: skirting.id, qty: 22 });
    expect(out.item.flagged).toBe(false);
    expect(out.item.flagReason).toBeNull();
  });

  test("removing the floor line takes its defaults with it", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.sheetVinyl, measuredM2: 20 });
    const out = await removeItem(r.item.id);
    expect(out.removedDefaults).toBe(4);
    expect(out.removedLabour).toBe(1);
    expect(await linesOf(qid)).toHaveLength(0);
  });
});

describe("check 2: trims and scotia bring Install trims/scotia, never twice", () => {
  test("a scotia on its own gets 111 at 0 lm, flagged, linked to it", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.scotia, qty: 12 });
    const ls = await linesOf(qid);
    expect(ls.map((l) => l.rateItemId)).toEqual([null, 111]);
    expect(ls[1]!.qty).toBe(0);
    expect(ls[1]!.flagged).toBe(true);
    expect(ls[1]!.flagReason).toBe(m.rules.TRIM_FLAG);
    expect(ls[1]!.defaultForItemId).toBe(r.item.id);
    expect(r.defaultsNote).toContain("Install trims/scotia put on underneath");
  });

  test("a trim on a hybrid quote is covered by the 111 already on, no second line", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    const r = await addProduct({ quoteId: qid, productId: P.trim, qty: 3 });
    const ls = await linesOf(qid);
    expect(ls.filter((l) => l.rateItemId === 111)).toHaveLength(1);
    expect(r.defaultsAdded).toBe(0);
    expect(r.defaultsNote).toContain("Install covered by");
    expect(m.rules.coveredLineOf(m.rules.appliedOf((await lineOf(r.item.id)).defaultsApplied))).toBe(ls.find((l) => l.rateItemId === 111)!.id);
  });

  test("several trims share one install line", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    await addProduct({ quoteId: qid, productId: P.trim, qty: 2 });
    await addProduct({ quoteId: qid, productId: P.accTrim, qty: 2 });
    const ls = await linesOf(qid);
    expect(ls.filter((l) => l.rateItemId === 111)).toHaveLength(1);
  });

  test("an accessory with trim in the name brings it, one without does not", async () => {
    const a = await newQuote();
    await addProduct({ quoteId: a, productId: P.accTrim, qty: 1 });
    expect((await linesOf(a)).map((l) => l.rateItemId)).toEqual([null, 111]);
    const b = await newQuote();
    await addProduct({ quoteId: b, productId: P.accGlue, qty: 1 });
    expect(await linesOf(b)).toHaveLength(1);
  });

  test("a hybrid added after a scotia: the area gets its own 111, warned not to count the scotia's length twice", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    const trims = (await linesOf(qid)).filter((l) => l.rateItemId === 111);
    expect(trims).toHaveLength(2);
    const area = trims.find((l) => l.defaultForItemId === hy.item.id)!;
    // Both start at 0 lm, so nothing is charged twice by itself.
    expect(trims.every((l) => l.qty === 0 && l.total === 0)).toBe(true);
    expect(area.flagReason).toContain(m.rules.AREA_TRIM_WHAT);
    expect(area.flagReason).toContain(m.rules.TRIM_OVERLAP_MARK);
    expect(area.flagReason).not.toContain("already on this quote");
    // Typing the length takes off the "enter" part only. The overlap warning stays until reviewed.
    await updateItem({ id: area.id, qty: 15 });
    const typed = await lineOf(area.id);
    expect(typed.flagged).toBe(true);
    expect(typed.flagReason).toStartWith(m.rules.TRIM_OVERLAP_MARK);
    expect(m.gate.openDefaultWarning(typed)).toBe(true);
  });

  test("removing the scotia takes its install, and it is not put back", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    const out = await removeItem(r.item.id);
    expect(out.removedDefaults).toBe(1);
    expect(await linesOf(qid)).toHaveLength(0);
  });
});

describe("check 5b: Change product keeps what was done and flags what no longer fits", () => {
  const changeProduct = (id: number, productId: number) => run<{ id: number; productId: number }, unknown>(m.quotes.changeProduct, { id, productId });

  test("laminate changed to hybrid: cutting gyprock is flagged, trims and skirting stay once, nothing doubles", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 40 });
    const skirting = (await linesOf(qid)).find((l) => l.rateItemId === 65)!;
    await updateItem({ id: skirting.id, qty: 22 });
    await changeProduct(r.item.id, P.hybrid);
    const ls = await linesOf(qid);
    expect(ls.filter((l) => l.rateItemId === 111)).toHaveLength(1);
    expect(ls.filter((l) => l.rateItemId === 65)).toHaveLength(1);
    expect(ls.find((l) => l.rateItemId === 65)!.qty).toBe(22);
    const gyprock = ls.find((l) => l.rateItemId === 120)!;
    expect(gyprock.flagged).toBe(true);
    expect(gyprock.flagReason).toContain("Product changed from laminate to hybrid");
  });

  test("carpet changed to laminate: underlay and uplift are flagged, laminate's defaults go on", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    await changeProduct(r.item.id, P.laminate);
    const ls = await linesOf(qid);
    const uplift = ls.find((l) => l.rateItemId === 7)!;
    expect(uplift.flagReason).toContain("Product changed from carpet to laminate");
    expect(ls.find((l) => l.productId === 9912)!.flagReason).toContain("Product changed from carpet to laminate");
    for (const id of [120, 111, 65]) expect(ls.filter((l) => l.rateItemId === id)).toHaveLength(1);
    // The disposal stays with the uplift, for the office to decide with it.
    expect(ls.filter((l) => l.kind === "internal_charge")).toHaveLength(1);
  });

  test("a removed default is not put back by changing to a product of the same type", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 40 });
    const gyprock = (await linesOf(qid)).find((l) => l.rateItemId === 120)!;
    await removeItem(gyprock.id);
    await changeProduct(r.item.id, P.laminate);
    expect((await linesOf(qid)).filter((l) => l.rateItemId === 120)).toHaveLength(0);
  });

  test("a scotia changed to a glue: its install is flagged", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    await changeProduct(r.item.id, P.accGlue);
    const install = (await linesOf(qid)).find((l) => l.rateItemId === 111)!;
    expect(install.flagReason).toContain("Product changed from trim or scotia");
  });
});

describe("check 3: carpet uplift brings the disposal allowance", () => {
  test("uplift added by hand: disposal at uplift lm x the quote's carpet width", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 20, labour: { itemId: 1 } });
    // Remove the default uplift (its disposal stays, flagged), then add one by hand.
    const first = (await linesOf(qid)).find((l) => l.rateItemId === 7)!;
    const rm = await removeItem(first.id);
    expect(rm.disposalFlagged).toBe(1);
    const orphan = (await linesOf(qid)).find((l) => l.kind === "internal_charge")!;
    expect(orphan.flagReason).toBe(m.rules.DISPOSAL_ORPHAN_FLAG);
    expect(orphan.defaultForItemId).toBeNull();
    await removeItem(orphan.id);

    const r = await addLabour({ quoteId: qid, itemId: 7, qty: 6 });
    const disposal = (await linesOf(qid)).find((l) => l.kind === "internal_charge" && l.defaultForItemId === r.item.id)!;
    expect(disposal.qty).toBe(21.96); // 6 lm x 3.66
    expect(disposal.unitPrice).toBe(3.45);
    expect(disposal.flagged).toBe(false);
  });

  test("uplift added by hand on a quote with no carpet: disposal at 0, flagged", async () => {
    const qid = await newQuote();
    const r = await addLabour({ quoteId: qid, itemId: 7, qty: 6 });
    const disposal = (await linesOf(qid)).find((l) => l.defaultForItemId === r.item.id)!;
    expect(disposal.qty).toBe(0);
    expect(disposal.flagged).toBe(true);
    expect(disposal.flagReason).toBe(m.rules.DISPOSAL_NO_QTY_FLAG);
    // Typing the m2 in clears it and stops it following.
    const out = await updateItem({ id: disposal.id, qty: 25 });
    expect(out.item.flagged).toBe(false);
    expect(out.item.disposalTyped).toBe(true);
  });

  test("uplift added as the carpet's install follows the carpet, and its disposal follows it", async () => {
    const qid = await newQuote();
    const carpet = await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 20, labour: null });
    const up = await addLabour({ quoteId: qid, itemId: 7, forItemId: carpet.item.id });
    const d = (await linesOf(qid)).find((l) => l.defaultForItemId === up.item.id)!;
    expect(d.qty).toBe(Math.round((await lineOf(up.item.id)).qty * 3.66 * 100) / 100);
    expect(d.flagged).toBe(false);
  });

  test("uplift qty change moves the disposal, a typed disposal stays, removing the uplift flags it", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    const uplift = (await linesOf(qid)).find((l) => l.rateItemId === 7)!;
    const disposal = (await linesOf(qid)).find((l) => l.kind === "internal_charge")!;

    await updateItem({ id: uplift.id, qty: 10 });
    expect((await lineOf(disposal.id)).qty).toBe(36.6);
    expect((await lineOf(disposal.id)).total).toBe(126.27);

    await updateItem({ id: disposal.id, qty: 40 });
    expect((await lineOf(disposal.id)).disposalTyped).toBe(true);
    await updateItem({ id: uplift.id, qty: 12 });
    expect((await lineOf(disposal.id)).qty).toBe(40);

    const out = await removeItem(uplift.id);
    expect(out.disposalFlagged).toBe(1);
    const left = await lineOf(disposal.id);
    expect(left.flagged).toBe(true);
    expect(left.flagReason).toBe(m.rules.DISPOSAL_ORPHAN_FLAG);
  });

  test("a new carpet area moves the uplift and its disposal", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    await updateItem({ id: r.item.id, measuredM2: 40 });
    const ls = await linesOf(qid);
    const uplift = ls.find((l) => l.rateItemId === 7)!;
    expect(uplift.qty).toBe(11); // 40 / 3.66 = 10.93 -> 11.0
    expect(ls.find((l) => l.kind === "internal_charge")!.qty).toBe(40.26);
  });

  test("carpet with no roll width: uplift at 0 flagged, then it works out once the width is in", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpetNoWidth, measuredM2: 20 });
    let ls = await linesOf(qid);
    let uplift = ls.find((l) => l.rateItemId === 7)!;
    expect(uplift.qty).toBe(0);
    expect(uplift.flagReason).toBe(m.rules.UPLIFT_NO_WIDTH_FLAG);
    expect(ls.find((l) => l.kind === "internal_charge")!.flagReason).toBe(m.rules.DISPOSAL_NO_QTY_FLAG);

    await updateItem({ id: r.item.id, rollWidthM: 4 });
    ls = await linesOf(qid);
    uplift = ls.find((l) => l.rateItemId === 7)!;
    expect(uplift.qty).toBe(5);
    expect(uplift.flagged).toBe(false);
    const d = ls.find((l) => l.kind === "internal_charge")!;
    expect(d.qty).toBe(20);
    expect(d.flagged).toBe(false);
  });

  test("no disposal rate in Settings: on at $0 flagged, priced once the rate is set", async () => {
    await q("delete from settings where key = 'carpet_disposal_cost_per_m2'");
    try {
      const qid = await newQuote();
      await addLabour({ quoteId: qid, itemId: 7, qty: 5 });
      let d = (await linesOf(qid)).find((l) => l.kind === "internal_charge")!;
      expect(d.unitPrice).toBe(0);
      expect(d.flagReason).toBe(m.rules.DISPOSAL_NO_RATE_FLAG);
      await q("insert into settings (key, value, updated_at) values ('carpet_disposal_cost_per_m2', '3', 0)");
      // Any change on the quote prices it (recalc).
      const other = await addLabour({ quoteId: qid, itemId: 65, qty: 1 });
      void other;
      d = await lineOf(d.id);
      expect(d.unitPrice).toBe(3.45);
      expect(d.flagReason).toBe(m.rules.DISPOSAL_NO_QTY_FLAG); // still no carpet width to work the m2 from
    } finally {
      await q("insert or ignore into settings (key, value, updated_at) values ('carpet_disposal_cost_per_m2', '3', 0)");
    }
  });

  test("the disposal line cannot be turned into another kind, and nothing else becomes Internal", async () => {
    const qid = await newQuote();
    await addLabour({ quoteId: qid, itemId: 7, qty: 5 });
    const ls = await linesOf(qid);
    const d = ls.find((l) => l.kind === "internal_charge")!;
    await updateItem({ id: d.id, kind: "labour" });
    expect((await lineOf(d.id)).kind).toBe("internal_charge");
    const up = ls.find((l) => l.rateItemId === 7)!;
    await updateItem({ id: up.id, kind: "internal_charge" });
    expect((await lineOf(up.id)).kind).toBe("labour");
  });
});

describe("check 4: only new scope on installation quotes", () => {
  test("product sale and materials sale quotes get nothing", async () => {
    for (const source of m.rules.SUPPLY_ONLY_SOURCES) {
      const qid = await newQuote({ source });
      await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 20 });
      await addProduct({ quoteId: qid, productId: P.scotia, qty: 5 });
      await addLabour({ quoteId: qid, itemId: 7, qty: 5 });
      const ls = await linesOf(qid);
      expect(ls.some((l) => l.defaultForItemId != null || l.kind === "internal_charge")).toBe(false);
    }
  });

  test("a sent quote changed in place gets nothing", async () => {
    const qid = await newQuote({ status: "sent" });
    await addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 10 });
    await addLabour({ quoteId: qid, itemId: 7, qty: 5 });
    const ls = await linesOf(qid);
    expect(ls.some((l) => l.defaultForItemId != null || l.kind === "internal_charge")).toBe(false);
  });

  test("an accepted quote cannot be changed at all", async () => {
    const qid = await newQuote({ status: "accepted" });
    await expect(addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 10 })).rejects.toThrow("locked");
  });

  test("existing lines are not backfilled", async () => {
    const qid = await newQuote();
    // A floor line already on the quote before this change (no defaults_applied).
    await m.db.insert(schema.quoteItems).values({ quoteId: qid, productId: P.vinylPlank, description: "Old line", qty: 10, unit: "m2", unitPrice: 40, total: 400, measuredM2: 10, wastagePct: 0, sortOrder: 0 });
    const [old] = await linesOf(qid);
    await updateItem({ id: old!.id, measuredM2: 11 });
    expect(await linesOf(qid)).toHaveLength(1);
  });
});

describe("check 5: revise keeps the links", () => {
  test("a new version keeps each default linked to its own line, removals and flags", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    const underlay = (await linesOf(qid)).find((l) => l.productId === 9912)!;
    await removeItem(underlay.id);
    await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    await q("update quotes set status = 'sent' where id = ?", [qid]);

    const v2 = await run<{ id: number }, { id: number }>(m.quotes.revise, { id: qid });
    const ls = await linesOf(v2.id);
    const carpet = ls.find((l) => l.productId === P.carpet)!;
    expect(carpet.id).not.toBe(r.item.id);
    expect(m.rules.appliedOf(carpet.defaultsApplied)).toContain("product:9912");
    expect(ls.some((l) => l.productId === 9912)).toBe(false);
    const uplift = ls.find((l) => l.rateItemId === 7)!;
    expect(uplift.defaultForItemId).toBe(carpet.id);
    const disposal = ls.find((l) => l.kind === "internal_charge")!;
    expect(disposal.defaultForItemId).toBe(uplift.id);
    const scotia = ls.find((l) => l.productId === P.scotia)!;
    const trim = ls.find((l) => l.rateItemId === 111)!;
    expect(trim.defaultForItemId).toBe(scotia.id);
    expect(trim.flagged).toBe(true);
    // Editing the new version still follows: the uplift moves its disposal.
    await updateItem({ id: uplift.id, qty: 10 });
    expect((await lineOf(disposal.id)).qty).toBe(36.6);
  });
});

describe("check 6: accepted, the disposal is a job cost, not labour, a PO or a material", () => {
  test("accept: one budget job cost at $3 a m2, no PO, no material, no dispatch labour from it", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    // Clear the Check required on the uplift, as the office would.
    const uplift = (await linesOf(qid)).find((l) => l.rateItemId === 7)!;
    await updateItem({ id: uplift.id, checkRequired: false });
    const ls = await linesOf(qid);
    expect(ls.filter((l) => l.flagged)).toHaveLength(0);
    const disposal = ls.find((l) => l.kind === "internal_charge")!;
    // Who pays, and a deposit typed on the quote: what Accept asks for first.
    await q("update quotes set bill_to_type = 'contact', bill_to_contact_id = ?, deposit_percent = 0, deposit_source = 'quote' where id = ?", [contactId, qid]);

    const out = await run<{ id: number }, { jobId: number }>(m.quotes.accept, { id: qid });
    expect(out.jobId).toBeGreaterThan(0);
    const costs = await q("select kind, state, description, amount, notes from job_costs where job_id = ?", [out.jobId]);
    const mine = costs.filter((c) => String(c.description).startsWith("Carpet disposal (estimate)"));
    expect(mine).toHaveLength(1);
    expect(mine[0].kind).toBe("other");
    expect(mine[0].state).toBe("budget");
    expect(mine[0].amount).toBe(Math.round(disposal.qty * 3 * 100) / 100);
    expect(mine[0].description).toContain(`${disposal.qty} m²`);

    const mats = await q("select description from job_materials where job_id = ?", [out.jobId]);
    expect(mats.some((x) => /disposal/i.test(String(x.description)))).toBe(false);
    const pos = await q("select l.description from purchase_order_lines l join purchase_orders p on p.id = l.po_id where p.job_id = ?", [out.jobId]);
    expect(pos.some((x) => /disposal/i.test(String(x.description)))).toBe(false);
    const tasks = await q("select * from job_tasks where job_id = ?", [out.jobId]);
    // The job really was built: the carpet and underlay are materials, the install and uplift are tasks.
    expect(mats.length).toBeGreaterThan(0);
    expect(tasks.length).toBeGreaterThan(0);
    console.log("accepted job:", JSON.stringify({ costs, mats, tasks: tasks.map((t) => t.title ?? t.name ?? t.id) }));
    expect(JSON.stringify(tasks)).not.toMatch(/Carpet disposal - Terra/);
    expect(JSON.stringify(tasks)).not.toMatch(/Carpet disposal and tip run/);
    // The installer is still paid the uplift, on the task's pay lines, and never item 86.
    const pay = await q("select l.item_id, l.qty from task_labour_lines l join job_tasks t on t.id = l.task_id where t.job_id = ?", [out.jobId]);
    console.log("task pay lines:", JSON.stringify(pay));
    expect(pay.some((x) => Number(x.item_id) === 7 && Number(x.qty) === uplift.qty)).toBe(true);
    expect(pay.some((x) => Number(x.item_id) === 86)).toBe(false);
    const offers = await q("select count(*) n from task_offers o join job_tasks t on t.id = o.task_id where t.job_id = ?", [out.jobId]);
    expect(Number(offers[0].n)).toBe(0);
  });
});

/* ------------------------- Damien's review, 7 Nov 2026 ------------------------- */

const r2t = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const SIGNATURE = { w: 300, h: 100, strokes: [[0, 50, 40, 50, 80, 50, 120, 50, 160, 50, 200, 50, 240, 50, 280, 50]] };
/** Who pays and the deposit, and no Check required left: what Send and Accept ask for besides the defaults. */
async function readyToGo(qid: number) {
  await q("update quotes set bill_to_type = 'contact', bill_to_contact_id = ?, deposit_percent = 0, deposit_source = 'quote' where id = ?", [contactId, qid]);
  await q("update quote_items set check_required = 0 where quote_id = ?", [qid]);
}
const GATE = /put on by quote defaults still need/;
const installsOf = async (qid: number) => (await linesOf(qid)).filter((l) => l.rateItemId === 111);
const subtotalOf = async (qid: number) => Number((await q("select subtotal from quotes where id = ?", [qid]))[0].subtotal);
const review = (itemId: number, note?: string) =>
  run<{ itemId: number; note?: string }, { id: number; defaultReviewedBy: string | null; defaultReviewedAt: Date | null }>(m.quoteDefaults.review, { itemId, note });
const cover = (itemId: number, installId: number) => run<{ itemId: number; installId: number }, { area: string }>(m.quoteDefaults.coverTrim, { itemId, installId });
async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as { message: string; code?: string; data?: { defaultWarnings?: number[] } };
  }
  throw new Error("expected it to be stopped");
}

describe("7 Nov 1: Install trims/scotia is per floor area, and a trim is never charged twice", () => {
  test("10 lm of laminate and 15 lm of hybrid make 25 lm; a scotia added after is covered, nothing extra charged", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    let installs = await installsOf(qid);
    expect(installs).toHaveLength(2);
    const lamInstall = installs.find((l) => l.defaultForItemId === lam.item.id)!;
    const hyInstall = installs.find((l) => l.defaultForItemId === hy.item.id)!;
    for (const l of [lamInstall, hyInstall]) expect(l.flagReason).toContain(m.rules.AREA_TRIM_WHAT);
    await updateItem({ id: lamInstall.id, qty: 10 });
    await updateItem({ id: hyInstall.id, qty: 15 });
    installs = await installsOf(qid);
    const rate = installs[0]!.unitPrice;
    expect(installs.every((l) => l.unitPrice === rate && !l.flagged)).toBe(true);
    expect(r2t(installs.reduce((a, l) => a + l.qty, 0))).toBe(25);
    const installTotal = r2t(installs.reduce((a, l) => a + l.total, 0));
    expect(installTotal).toBe(r2t(25 * rate));
    const before = await subtotalOf(qid);

    const sc = await addProduct({ quoteId: qid, productId: P.scotia, qty: 12 });
    expect(sc.defaultsAdded).toBe(0);
    const after = await installsOf(qid);
    expect(after).toHaveLength(2);
    expect(after.map((l) => [l.id, l.qty, l.total])).toEqual(installs.map((l) => [l.id, l.qty, l.total]));
    // Only the scotia itself was added to the price.
    expect(r2t((await subtotalOf(qid)) - before)).toBe(r2t((await lineOf(sc.item.id)).total));
    const scLine = await lineOf(sc.item.id);
    // Two areas have an install, so the office picks. Covered by the nearest above (the hybrid) for now.
    expect(m.rules.coveredLineOf(m.rules.appliedOf(scLine.defaultsApplied))).toBe(hyInstall.id);
    expect(scLine.flagReason).toContain(m.rules.TRIM_PICK_FLAG);

    const choices = await run<{ quoteId: number }, { id: number; area: string; qty: number }[]>(m.quoteDefaults.trimChoices, { quoteId: qid });
    expect(choices.map((c) => [c.id, c.qty])).toEqual([
      [lamInstall.id, 10],
      [hyInstall.id, 15],
    ]);
    expect(choices[0]!.area).toBe(lam.item.description);
    await cover(sc.item.id, lamInstall.id);
    const moved = await lineOf(sc.item.id);
    expect(m.rules.coveredLineOf(m.rules.appliedOf(moved.defaultsApplied))).toBe(lamInstall.id);
    // The pick warning is gone; the scotia's own length-size note stays, and it is not a default warning.
    expect(moved.flagReason ?? "").not.toContain(m.rules.TRIM_PICK_FLAG);
    expect(m.rules.isDefaultWarning(moved.flagReason)).toBe(false);
    expect((await installsOf(qid)).map((l) => [l.id, l.qty, l.total])).toEqual(installs.map((l) => [l.id, l.qty, l.total]));
    console.log("10 + 15 lm:", JSON.stringify(shape(await linesOf(qid))));
  });

  test("removing the laminate area keeps its install while a scotia still needs it, flagged", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const lamInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === lam.item.id)!;
    const hyInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    await updateItem({ id: lamInstall.id, qty: 10 });
    await updateItem({ id: hyInstall.id, qty: 15 });
    const sc = await addProduct({ quoteId: qid, productId: P.scotia, qty: 8 });
    await cover(sc.item.id, lamInstall.id);

    const out = await removeItem(lam.item.id);
    expect(out.installsKept).toBe(1);
    const kept = await lineOf(lamInstall.id);
    expect(kept).toBeDefined();
    expect(kept.qty).toBe(10);
    expect(kept.defaultForItemId).toBeNull();
    expect(kept.flagReason).toContain(m.rules.AREA_GONE_MARK);
    expect(kept.flagReason).toContain(sc.item.description);
    expect(m.gate.openDefaultWarning(kept)).toBe(true);
    // The hybrid area is untouched.
    expect((await lineOf(hyInstall.id)).qty).toBe(15);
    expect((await lineOf(hyInstall.id)).flagged).toBe(false);
    // The laminate's own other defaults went with it.
    expect((await linesOf(qid)).some((l) => l.rateItemId === 120)).toBe(false);
  });

  test("an area whose install covers nothing takes it with it", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const out = await removeItem(lam.item.id);
    expect(out.installsKept).toBe(0);
    expect(await installsOf(qid)).toHaveLength(0);
  });

  test("removing an Install trims/scotia line flags the trim it covered, moves it to the other area, and undoes its review", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const lamInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === lam.item.id)!;
    const hyInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    const sc = await addProduct({ quoteId: qid, productId: P.scotia, qty: 8 });
    const rv = await review(sc.item.id, "Goes with the hybrid");
    expect(rv.defaultReviewedBy).toBe("Test Admin");
    expect(m.gate.openDefaultWarning(await lineOf(sc.item.id))).toBe(false);

    const out = await removeItem(hyInstall.id);
    expect(out.trimsFlagged).toBe(1);
    const t = await lineOf(sc.item.id);
    expect(t.flagReason).toContain(m.rules.TRIM_INSTALL_GONE_FLAG);
    expect(m.rules.coveredLineOf(m.rules.appliedOf(t.defaultsApplied))).toBe(lamInstall.id);
    // A new warning on a reviewed line needs reviewing again.
    expect(t.defaultReviewedAt).toBeNull();
    expect(m.gate.openDefaultWarning(t)).toBe(true);
  });

  test("Install with only takes an Install trims/scotia line on the same quote", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const sc = await addProduct({ quoteId: qid, productId: P.scotia, qty: 8 });
    await expect(cover(sc.item.id, lam.item.id)).rejects.toThrow("Pick an Install trims/scotia line on this quote.");
  });
});

describe("7 Nov 2: no Sold as, and sheet vinyl not marked commercial", () => {
  test("vinyl, carpet and solid timber with no Sold as: nothing put on, the line is flagged, and Send is stopped", async () => {
    for (const key of ["vinylUnsorted", "carpetUnsorted", "timberUnsorted"]) {
      const qid = await newQuote();
      const r = await addProduct({ quoteId: qid, productId: P[key], measuredM2: 20 });
      const ls = await linesOf(qid);
      expect(ls.some((l) => l.defaultForItemId != null || l.kind === "internal_charge")).toBe(false);
      const line = await lineOf(r.item.id);
      expect(line.flagged).toBe(true);
      expect(line.flagReason).toStartWith(m.rules.UNCLASSIFIED_MARK);
      expect(line.flagReason).toContain("Set Sold as on the product in Settings and add it again");
      await readyToGo(qid);
      await expect(run(m.quotes.send, { id: qid })).rejects.toThrow(GATE);
      console.log(`${key}:`, JSON.stringify(shape(ls)));
    }
  });

  test("supply only (install unticked) is not flagged", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.vinylUnsorted, measuredM2: 20, labour: null });
    expect((await lineOf(r.item.id)).flagged).toBe(false);
  });

  test("sheet vinyl with a blank or plain Sheet Vinyl tier gets no skim, coving, corners or welding, and is flagged", async () => {
    for (const [key, tier] of [
      ["sheetVinylBlank", "blank"],
      ["sheetVinylPlain", '"Sheet Vinyl"'],
    ] as const) {
      const qid = await newQuote();
      const r = await addProduct({ quoteId: qid, productId: P[key], measuredM2: 20 });
      const ls = await linesOf(qid);
      expect(ls.some((l) => [109, 21, 102, 20].includes(l.rateItemId ?? 0))).toBe(false);
      const line = await lineOf(r.item.id);
      expect(line.flagReason).toStartWith(m.rules.NOT_COMMERCIAL_MARK);
      expect(line.flagReason).toContain(`tier ${tier}`);
      expect(m.gate.openDefaultWarning(line)).toBe(true);
    }
  });

  test("Commercial Sheet and Safety Sheet are the only tiers that count", () => {
    expect(m.rules.isCommercialSheet({ tier: "Commercial Sheet" })).toBe(true);
    expect(m.rules.isCommercialSheet({ tier: " safety sheet " })).toBe(true);
    for (const t of ["", null, "Sheet Vinyl", "Wall", "4m Residential"]) expect(m.rules.isCommercialSheet({ tier: t })).toBe(false);
  });
});

describe("7 Nov 3: a warning stops the quote going out until it is filled in, reviewed or removed", () => {
  test("Send, staff Accept, Convert to job and the send dialog are all stopped on the server", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    await readyToGo(qid);
    const open = await m.gate.openDefaultWarnings(qid);
    expect(open).toHaveLength(2); // Install trims/scotia and skirting at 0
    const e = await errorOf(run(m.quotes.send, { id: qid }));
    expect(e.message).toMatch(GATE);
    expect(e.data?.defaultWarnings?.sort()).toEqual(open.map((o) => o.id).sort());
    await expect(run(m.quotes.accept, { id: qid })).rejects.toThrow(GATE);
    await expect(run(m.quotes.convertToJob, { id: qid })).rejects.toThrow(GATE);
    await expect(run(m.quoteSend.send, { quoteId: qid, sendKey: `gate-test-${qid}`, to: "", subject: "", body: "" })).rejects.toThrow(GATE);
    const [row] = await q("select status, job_id from quotes where id = ?", [qid]);
    expect(row.status).toBe("draft");
    expect(row.job_id).toBeNull();
    expect(await q("select id from quote_sends where quote_id = ?", [qid])).toHaveLength(0);
  });

  test("a customer accepting online is stopped with a plain message, and nothing is accepted", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    await readyToGo(qid);
    // Only possible on old data or a direct database edit: a quote can no longer be sent like this.
    await q("update quotes set status = 'sent', sent_at = ? where id = ?", [Math.floor(Date.now() / 1000), qid]);
    const { token } = await m.links.linkForQuote(qid);
    const e = await as(null, () => errorOf(run(m.publicPages.quote.accept, { token, name: "Test Client", agreed: true, signature: SIGNATURE })));
    expect(e.message).toBe(m.gate.DEFAULTS_OPEN_CUSTOMER);
    expect(e.message).not.toMatch(/skirting|trims|\$/i);
    expect((await q("select status from quotes where id = ?", [qid]))[0].status).toBe("sent");
    expect(await q("select id from quote_signatures where quote_id = ?", [qid])).toHaveLength(0);
  });

  test("filled in and marked reviewed (who, when, logged): then it sends", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    await readyToGo(qid);
    const ls = await linesOf(qid);
    const skirting = ls.find((l) => l.rateItemId === 65)!;
    const install = ls.find((l) => l.rateItemId === 111)!;
    await updateItem({ id: skirting.id, qty: 22 });
    expect((await lineOf(skirting.id)).flagged).toBe(false);
    const t0 = Date.now() - 1000;
    const rv = await review(install.id, "No trims on this job");
    expect(rv.defaultReviewedBy).toBe("Test Admin");
    expect(new Date(rv.defaultReviewedAt!).getTime()).toBeGreaterThanOrEqual(t0);
    const kept = await lineOf(install.id);
    // The warning text stays as history; it no longer holds the quote.
    expect(kept.flagged).toBe(true);
    expect(kept.flagReason).toContain(m.rules.AREA_TRIM_WHAT);
    expect(kept.defaultReviewNote).toBe("No trims on this job");
    const log = await q("select action, detail, actor_name from activity_log where entity_type = 'quote' and entity_id = ? and action = 'default_reviewed'", [qid]);
    expect(log).toHaveLength(1);
    expect(log[0].actor_name).toBe("Test Admin");
    expect(String(log[0].detail)).toContain("No trims on this job");
    expect(await m.gate.openDefaultWarnings(qid)).toHaveLength(0);
    await run(m.quotes.send, { id: qid });
    expect((await q("select status from quotes where id = ?", [qid]))[0].status).toBe("sent");
  });

  test("removed: then it can go", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    await readyToGo(qid);
    for (const l of (await linesOf(qid)).filter((x) => x.flagged)) await removeItem(l.id);
    expect(await m.gate.openDefaultWarnings(qid)).toHaveLength(0);
    await run(m.quotes.send, { id: qid });
  });

  test("a changed product puts a new warning on a reviewed line, and it needs reviewing again", async () => {
    const qid = await newQuote();
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    const install = (await installsOf(qid))[0]!;
    await review(install.id);
    expect(m.gate.openDefaultWarning(await lineOf(install.id))).toBe(false);
    await run(m.quotes.changeProduct, { id: hy.item.id, productId: P.vinylPlank });
    const after = await lineOf(install.id);
    expect(after.flagReason).toContain("Product changed from hybrid");
    expect(after.defaultReviewedAt).toBeNull();
    expect(m.gate.openDefaultWarning(after)).toBe(true);
  });

  test("Mark reviewed needs an open warning, and is Admin or Office only", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.vinylPlank, measuredM2: 10 });
    await expect(review(r.item.id)).rejects.toThrow("no quote defaults warning waiting for review");
    const skim = (await linesOf(qid)).find((l) => l.rateItemId === 109)!;
    await q("update quote_items set flagged = 1, flag_reason = ? where id = ?", [m.rules.enterFlag("x"), skim.id]);
    await expect(as(FIELD, () => review(skim.id))).rejects.toThrow("Office access required");
    await expect(as(null, () => review(skim.id))).rejects.toThrow();
    const rv = await as(OFFICE, () => review(skim.id));
    expect(rv.defaultReviewedBy).toBe("Test Office");
  });

  test("an existing quote with older flags on it is not held", async () => {
    const qid = await newQuote({ status: "sent" });
    await m.db.insert(schema.quoteItems).values({
      quoteId: qid, productId: P.hybrid, description: "Old hybrid line", qty: 10, unit: "m2", unitPrice: 40, total: 400, sortOrder: 0,
      flagged: true, flagReason: "No boxes per pallet on file for Old hybrid line. Check the delivery.",
    });
    await readyToGo(qid);
    expect(await m.gate.openDefaultWarnings(qid)).toHaveLength(0);
    const out = await run<{ id: number }, { jobId: number }>(m.quotes.accept, { id: qid });
    expect(out.jobId).toBeGreaterThan(0);
  });
});

describe("7 Nov 4: no disposal rate in Settings (as live today)", () => {
  test("the release SQL writes no Settings, only the 7 new columns", () => {
    const sql = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-11-28-quote-defaults.sql"), "utf8");
    const statements = sql.split("--> statement-breakpoint").map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean);
    expect(statements).toHaveLength(7);
    expect(statements.every((s) => /^ALTER TABLE quote_items ADD COLUMN /.test(s))).toBe(true);
    expect(statements.join("\n")).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(m.rules.DISPOSAL_PROPOSED).toMatchObject({ cost: 3, markupPct: 15 });
  });

  test("a carpet uplift's disposal goes on at $0, flagged, and holds Send until filled in or reviewed", async () => {
    const saved = await q("select key, value from settings where key like 'carpet_disposal_%'");
    await q("delete from settings where key like 'carpet_disposal_%'");
    try {
      const qid = await newQuote();
      await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
      await readyToGo(qid);
      const d = (await linesOf(qid)).find((l) => l.kind === "internal_charge")!;
      expect(d.unitPrice).toBe(0);
      expect(d.total).toBe(0);
      expect(d.unitCost).toBeNull();
      expect(d.flagReason).toBe(m.rules.DISPOSAL_NO_RATE_FLAG);
      await expect(run(m.quotes.send, { id: qid })).rejects.toThrow(GATE);
      // The proposed $3 and 15% are never used as a price.
      expect((await linesOf(qid)).some((l) => l.unitPrice === 3.45 || l.unitCost === 3)).toBe(false);
    } finally {
      for (const s of saved) await q("insert or replace into settings (key, value, updated_at) values (?, ?, 0)", [s.key, s.value]);
    }
  });
});

describe("7 Nov 5: disposal estimate and the real skip bin are counted once", () => {
  test("the estimate row is edited into the actual; a second skip bin row is stopped; nothing is counted twice", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.carpet, measuredM2: 30 });
    await readyToGo(qid);
    const items = await linesOf(qid);
    const disposal = items.find((l) => l.kind === "internal_charge")!;
    const { jobId } = await run<{ id: number }, { jobId: number }>(m.quotes.accept, { id: qid });
    type Budget = { costs: { id: number; kind: string; amount: number; state: string; source: string; description: string }[]; summary: { other: number } };
    const budget = () => run<{ jobId: number }, Budget>(m.finance.jobBudget, { jobId });
    let b = await budget();
    const est = b.costs.filter((c) => c.source === m.disposal.DISPOSAL_SOURCE);
    expect(est).toHaveLength(1);
    expect(est[0]!.amount).toBe(r2t(disposal.qty * 3));
    expect(b.summary.other).toBe(est[0]!.amount);

    // A second skip bin row while the estimate is still a budget would count it twice.
    for (const description of ["Skip bin share", "Tip run", "carpet disposal"]) {
      await expect(run(m.finance.costSave, { jobId, kind: "other", description, amount: 40 })).rejects.toThrow(m.disposal.DISPOSAL_TWICE_MESSAGE);
    }
    // Something else is not stopped.
    const parking = await run<Record<string, unknown>, { id: number }>(m.finance.costSave, { jobId, kind: "other", description: "Parking", amount: 12 });
    void parking;

    // The real cost: this job's share of the bin, on the estimate row, paid.
    await run(m.finance.costSave, { id: est[0]!.id, jobId, kind: "other", description: "Carpet disposal, share of skip bin", amount: 55, state: "paid" });
    b = await budget();
    const mine = b.costs.filter((c) => c.source === m.disposal.DISPOSAL_SOURCE);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.amount).toBe(55);
    expect(mine[0]!.state).toBe("paid");
    expect(b.summary.other).toBe(r2t(55 + 12));
    // A later quote version does not write over the actual.
    const sync = await m.disposal.syncDisposalCosts(jobId, qid);
    expect(sync.changed).toBe(0);
    expect(sync.flags.join(" ")).toContain("paid at $55.00");
    expect((await budget()).costs.filter((c) => c.source === m.disposal.DISPOSAL_SOURCE)[0]!.amount).toBe(55);

    // What this job makes prices off the quote lines only: the disposal cost once, never the Money out rows on top.
    const f = await run<{ jobId: number }, { materials: number }>(m.costing.forecast, { jobId });
    const goods = items.filter((l) => ["supply", "accessory", "delivery", "supplier_charge", "internal_charge"].includes(l.kind));
    expect(f.materials).toBe(r2t(goods.reduce((a, l) => a + (l.unitCost ?? 0) * l.qty, 0)));
    console.log("disposal budget:", JSON.stringify({ estimate: est[0]!.amount, actual: 55, other: b.summary.other, forecastMaterials: f.materials }));
  });
});

describe("7 Nov 6: who sees what", () => {
  let qid = 0;
  let token = "";
  const COST = 13.57;

  test("set up a sent installation quote with a cost only Admin should see", async () => {
    await product("carpetCost", { brand: "Cost", range: "Check", colour: "Teal", sku: "CPT9", category: "carpet", soldAs: "broadloom", unit: "lm", widthM: 3.66, costPrice: COST, sellPrice: 41.23 });
    qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.carpetCost, measuredM2: 20 });
    await readyToGo(qid);
    await run(m.quotes.send, { id: qid });
    token = (await m.links.linkForQuote(qid)).token;
    expect((await linesOf(qid)).some((l) => l.unitCost === COST)).toBe(true);
  });

  test("Office without costs: no cost, markup or margin on any line, the disposal included", async () => {
    const view = await as(OFFICE, () => run<{ id: number }, any>(m.quotes.get, { id: qid }));
    expect(view.costsHidden).toBe(true);
    expect(view.estimatedCost).toBeNull();
    expect(view.estimatedMargin).toBeNull();
    for (const i of view.items) {
      expect(i.unitCost).toBeNull();
      expect(i.markupPercent).toBeNull();
    }
    expect(view.items.some((i: any) => i.kind === "internal_charge")).toBe(true);
    expect(JSON.stringify(view)).not.toContain(String(COST));
    // The defaults tools work for Office, and show no cost either.
    const open = await as(OFFICE, () => run<{ quoteId: number }, unknown[]>(m.quoteDefaults.open, { quoteId: qid }));
    expect(JSON.stringify(open)).not.toContain(String(COST));
  });

  test("Field crew: no quote and none of the defaults tools", async () => {
    await as(FIELD, async () => {
      await expect(run(m.quotes.get, { id: qid })).rejects.toThrow("Office access required");
      await expect(run(m.quoteDefaults.open, { quoteId: qid })).rejects.toThrow("Office access required");
      await expect(run(m.quoteDefaults.trimChoices, { quoteId: qid })).rejects.toThrow("Office access required");
      await expect(run(m.quoteDefaults.coverTrim, { itemId: 1, installId: 1 })).rejects.toThrow("Office access required");
    });
  });

  test("the customer's /q/ page and PDF: sections, no cost, no markup", async () => {
    const page = await as(null, () => run<{ token: string }, any>(m.publicPages.quote.get, { token }));
    expect(page.state).toBe("open");
    expect(page.layout).toBe("sections");
    expect(page.items).toEqual([]);
    expect(page.bundles.length).toBeGreaterThan(0);
    const json = JSON.stringify(page);
    expect(json).not.toContain(String(COST));
    expect(json).not.toMatch(/unitCost|markup|"cost"/i);

    const pdf = await as(null, () => run<{ token: string }, { filename: string; base64: string }>(m.publicPages.quote.pdf, { token }));
    const file = join(dir, "sections.pdf");
    writeFileSync(file, Buffer.from(pdf.base64, "base64"));
    const text = spawnSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" }).stdout;
    expect(text.length).toBeGreaterThan(100);
    expect(text).not.toContain(String(COST));
    expect(text).not.toMatch(/markup/i);
    for (const b of page.bundles) expect(text).toContain(String(b.title).split("\n")[0]!.slice(0, 20));
    console.log("sections PDF:", JSON.stringify({ bundles: page.bundles.map((b: any) => [b.title, b.total]), total: page.total, chars: text.length }));
  });

  test("itemised, if the office picks it: one row per line at the sell rate, still no cost", async () => {
    await q("update quotes set layout = 'itemised' where id = ?", [qid]);
    try {
      const page = await as(null, () => run<{ token: string }, any>(m.publicPages.quote.get, { token }));
      expect(page.layout).toBe("itemised");
      const lines = await linesOf(qid);
      expect(page.items).toHaveLength(lines.length);
      for (const r of page.items) {
        expect(Object.keys(r).sort()).toEqual(["description", "id", "qty", "rate", "total", "unit"]);
        expect(r.rate).toBe(r2t(lines.find((l) => l.id === r.id)!.unitPrice));
      }
      expect(JSON.stringify(page)).not.toContain(String(COST));
    } finally {
      await q("update quotes set layout = 'auto' where id = ?", [qid]);
    }
  });
});

describe("7 Nov 7: 4.0 m carpet with Super Green (9912, 1.83 m)", () => {
  test("underlay = carpet lm x 4.0 / 1.83, up to the next 0.1 lm; uplift and disposal off the 4 m width", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.carpet4, measuredM2: 30, wastagePct: 10 });
    const ls = await linesOf(qid);
    const carpet = await lineOf(r.item.id);
    // 30 m2 + 10% = 33 m2 / 4.0 = 8.25 -> 8.3 lm.
    expect(carpet.qty).toBe(8.3);
    const underlay = ls.find((l) => l.productId === 9912)!;
    const want = Math.ceil(Math.round(((8.3 * 4) / 1.83) * 10_000) / 10_000 * 10 - 1e-9) / 10;
    expect(want).toBe(18.2); // 33.2 / 1.83 = 18.14 -> 18.2
    expect(underlay.qty).toBe(want);
    expect(ls.find((l) => l.rateItemId === 7)!.qty).toBe(7.5); // 30 / 4.0, no wastage
    expect(ls.find((l) => l.kind === "internal_charge")!.qty).toBe(30); // 7.5 lm x 4.0
    console.log("4.0 m carpet:", JSON.stringify(shape(ls)));
  });
});

describe("7 Nov 8: follow-ups, as they stand", () => {
  test("a variation line cannot be an Internal disposal line", async () => {
    const { LINE_KINDS } = await import("../src/api/lib/variations");
    expect((LINE_KINDS as readonly string[]).includes("internal_charge")).toBe(false);
  });
});

describe("7 Nov (second brief): trims and scotia by the length, install by the installed lm, vinyl classified", () => {
  // Copies of the live records the demos use, with the lengths the catalog SQL fills in.
  test("set up the demo products", async () => {
    // Acouslime 10961: scotia per lm, 2.4 m lengths, $12.50 a length stored as 5.2083 a lm.
    await product("acScotia", { id: 20961, brand: "Acouslime", range: "Scotia Waterproof 19x19mm", colour: "Wood Grain", sku: "D10961", category: "scotia", unit: "lm", pieceLengthM: 2.4, costPrice: 2.7083, sellPrice: 5.2083 });
    // Big Panda 8545 (2400 x 22 x 12mm) and 8548 (2700mm), priced per length.
    await product("bpScotia", { brand: "Big Panda Flooring", range: "Scotia PVC/WPC", colour: "", sku: "D8545", category: "accessory", unit: "each", pieceLengthM: 2.4, costPrice: 4.8, sellPrice: 9.17 });
    await product("bpTrim27", { brand: "Big Panda Flooring", range: "Universal Trim", colour: "", sku: "D8548", category: "accessory", unit: "each", pieceLengthM: 2.7, costPrice: 17, sellPrice: 32.49 });
    // Acouslime 10968: 3.4 m, each, tagged Box with 1 a pack in the price book.
    await product("acTop34", { brand: "Acouslime", range: "Universal Top Cover", colour: "Wood Grain", sku: "D10968", category: "accessory", unit: "each", pieceLengthM: 3.4, soldAs: "box", unitsPerPack: 1, costPrice: 25.5, sellPrice: 49.1 });
    // Acouslime 10995: a longer existing trim, 3.6 m, per lm.
    await product("acStep36", { brand: "Acouslime", range: "Vinyl Step Down 3mm", colour: "Silver", sku: "D10995", category: "trim", unit: "lm", pieceLengthM: 3.6, costPrice: 7.9167, sellPrice: 15.25 });
    // NFD 8491 style: a scotia priced each with no length on file.
    await product("noLenScotia", { brand: "NFD", range: "Scotia Unknown", colour: "", sku: "D8491", category: "accessory", unit: "each", costPrice: 5, sellPrice: 10 });
    // Forbo Surestep after the catalog SQL: broadloom, Safety Sheet. Armstrong Wallflex: Wall Vinyl.
    await product("forboSafety", { brand: "Forbo", range: "Surestep Original", colour: "Grey", sku: "D-SS", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2, tier: "Safety Sheet" });
    await product("wallVinyl", { brand: "Armstrong", range: "Wallflex", colour: "White", sku: "D-WF", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2, tier: "Wall Vinyl" });
    expect(P.acScotia).toBe(20961);
  });

  const noteOf = (r: unknown) => String((r as { qtyNote?: string | null }).qtyNote ?? "");
  const auto = (l: Item) => m.rules.autoOf(m.rules.appliedOf(l.defaultsApplied));
  const installedOn = (l: Item) => m.rules.installedOf(m.rules.appliedOf(l.defaultsApplied));

  test("23 lm installed on 2.4 m scotia: 10 lengths supplied, Install trims/scotia at 23 lm", async () => {
    const qid = await newQuote();
    const sc = await addProduct({ quoteId: qid, productId: P.acScotia, installedLm: 23 });
    const line = await lineOf(sc.item.id);
    expect(line.qty).toBe(24);
    expect(noteOf(sc)).toContain("10 lengths of 2.4 m (24 lm)");
    expect(installedOn(line)).toBe(23);
    // Material: 10 lengths at $12.50 a length.
    expect(line.total).toBe(125);
    const [inst] = await installsOf(qid);
    expect(inst!.defaultForItemId).toBe(sc.item.id);
    expect(inst!.qty).toBe(23);
    expect(inst!.total).toBe(r2t(23 * inst!.unitPrice));
    expect(inst!.flagged).toBe(false);
    expect(auto(inst!)).toBe(23);
  });

  test("Acouslime scotia per length: 63 lengths come to 787.50, not 787.49", async () => {
    const qid = await newQuote();
    const sc = await addProduct({ quoteId: qid, productId: P.acScotia, installedLm: 151.2 });
    const line = await lineOf(sc.item.id);
    expect(line.qty).toBe(151.2);
    expect(line.total).toBe(787.5);
    // The price is not changed, only carried to more places.
    expect(Math.abs(line.unitPrice - 5.2083)).toBeLessThan(0.00005);
  });

  test("2.4, 2.7, 3.4 and 3.6 m trims each use their own length; labour is always the installed lm", async () => {
    const cases: [string, number, number, number][] = [
      // product, installed lm, supply qty, material total
      ["bpScotia", 23, 10, r2t(10 * 9.17)],
      ["bpTrim27", 23, 9, r2t(9 * 32.49)],
      ["acTop34", 23, 7, r2t(7 * 49.1)],
      ["acStep36", 23, 25.2, r2t(25.2 * 15.25)],
    ];
    const out: unknown[] = [];
    for (const [key, lm, supply, total] of cases) {
      const qid = await newQuote();
      const t = await addProduct({ quoteId: qid, productId: P[key], installedLm: lm });
      const line = await lineOf(t.item.id);
      expect([key, line.qty, line.total]).toEqual([key, supply, total]);
      const [inst] = await installsOf(qid);
      expect([key, inst!.qty, inst!.flagged]).toEqual([key, lm, false]);
      out.push([line.description, line.qty, noteOf(t), inst!.qty]);
    }
    console.log("lengths:", JSON.stringify(out));
    // The 3.4 m one tagged Box still reads in lengths.
    expect(String(out[2])).toContain("7 lengths of 3.4 m (23.8 lm)");
  });

  test("lengths typed with no installed lm: the lm is shown, the install is flagged to fill in", async () => {
    const qid = await newQuote();
    const t = await addProduct({ quoteId: qid, productId: P.bpScotia, qty: 10 });
    expect(noteOf(t)).toContain("10 lengths of 2.4 m (24 lm)");
    const [inst] = await installsOf(qid);
    expect(inst!.qty).toBe(0);
    expect(inst!.flagReason).toBe(m.rules.TRIM_FLAG);
    expect(m.gate.openDefaultWarning(inst!)).toBe(true);
  });

  test("a scotia with no length on file, priced each: the count is typed, and the install is still added", async () => {
    const qid = await newQuote();
    const t = await addProduct({ quoteId: qid, productId: P.noLenScotia, qty: 4, installedLm: 9 });
    expect((await lineOf(t.item.id)).qty).toBe(4);
    const [inst] = await installsOf(qid);
    expect(inst!.qty).toBe(9);
  });

  test("on a hybrid area: the area's install takes the trims' installed lm, no second line", async () => {
    const qid = await newQuote();
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const area = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    expect(area.qty).toBe(0);
    const sc = await addProduct({ quoteId: qid, productId: P.bpScotia, installedLm: 23 });
    expect(sc.defaultsAdded).toBe(0);
    let installs = await installsOf(qid);
    expect(installs).toHaveLength(1);
    expect(installs[0]!.qty).toBe(23);
    const tr = await addProduct({ quoteId: qid, productId: P.bpTrim27, installedLm: 5 });
    installs = await installsOf(qid);
    expect(installs.map((l) => [l.id, l.qty])).toEqual([[area.id, 28]]);
    expect(installs[0]!.total).toBe(r2t(28 * installs[0]!.unitPrice));
    // Removing a trim takes its length off.
    await removeItem(tr.item.id);
    expect((await lineOf(area.id)).qty).toBe(23);
    // A trim with no installed lm is not counted, and says so.
    const bare = await addProduct({ quoteId: qid, productId: P.acTop34, qty: 2 });
    const after = await lineOf(area.id);
    expect(after.qty).toBe(23);
    expect(after.flagReason ?? "").toContain(m.rules.TRIM_ADDED_MARK);
    expect(after.flagReason ?? "").toContain(bare.item.description);
    expect(m.gate.openDefaultWarning(after)).toBe(true);
    // Removing it takes the warning with it.
    await removeItem(bare.item.id);
    const clean = await lineOf(area.id);
    expect(clean.qty).toBe(23);
    expect(clean.flagReason ?? "").not.toContain(m.rules.TRIM_ADDED_MARK);
  });

  test("an install length typed by hand is kept, and the new trim is flagged to check", async () => {
    const qid = await newQuote();
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const area = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    await updateItem({ id: area.id, qty: 30 });
    const sc = await addProduct({ quoteId: qid, productId: P.bpScotia, installedLm: 23 });
    const kept = await lineOf(area.id);
    expect(kept.qty).toBe(30);
    expect(kept.flagReason ?? "").toContain(m.rules.trimTypedFlag(`"${sc.item.description}"`, 23));
    expect(m.gate.openDefaultWarning(kept)).toBe(true);
    // Typing the length again clears the check.
    await updateItem({ id: area.id, qty: 53 });
    const typed = await lineOf(area.id);
    expect(typed.qty).toBe(53);
    expect(typed.flagReason ?? "").not.toContain(m.rules.TRIM_ADDED_MARK);
  });

  test("moving a scotia to the other area moves its installed lm with it", async () => {
    const qid = await newQuote();
    const lam = await addProduct({ quoteId: qid, productId: P.laminate, measuredM2: 20 });
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const lamInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === lam.item.id)!;
    const hyInstall = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    const sc = await addProduct({ quoteId: qid, productId: P.bpScotia, installedLm: 12 });
    expect((await lineOf(hyInstall.id)).qty).toBe(12);
    await cover(sc.item.id, lamInstall.id);
    expect((await lineOf(lamInstall.id)).qty).toBe(12);
    const left = await lineOf(hyInstall.id);
    expect(left.qty).toBe(0);
    expect(left.flagReason ?? "").toContain(m.rules.AREA_TRIM_WHAT);
    expect((await installsOf(qid))).toHaveLength(2);
  });

  test("vinyl: commercial and safety sheet get skim, coving, corners and welding; plank skim only; wall vinyl nothing and not flagged", async () => {
    const rateIds = async (qid: number) => (await linesOf(qid)).map((l) => l.rateItemId).filter((r) => r != null).sort((a, b) => a! - b!);
    for (const key of ["sheetVinyl", "forboSafety"]) {
      const qid = await newQuote();
      await addProduct({ quoteId: qid, productId: P[key], measuredM2: 20 });
      expect([key, await rateIds(qid)]).toEqual([key, [19, 20, 21, 102, 109]]);
    }
    const plank = await newQuote();
    await addProduct({ quoteId: plank, productId: P.vinylPlank, measuredM2: 20 });
    expect(await rateIds(plank)).toEqual([17, 109]);
    const wall = await newQuote();
    const w = await addProduct({ quoteId: wall, productId: P.wallVinyl, measuredM2: 20 });
    expect((await rateIds(wall)).filter((r) => [20, 21, 102, 109].includes(r!))).toEqual([]);
    expect((await lineOf(w.item.id)).flagReason ?? "").not.toContain(m.rules.NOT_COMMERCIAL_MARK);
  });

  test("lines already on a quote are not changed by any of this", async () => {
    const qid = await newQuote();
    // As live line 388 (Big Panda scotia, each 26), put on before the lengths were filled in.
    const [old] = await m.db
      .insert(schema.quoteItems)
      .values({ quoteId: qid, productId: P.bpScotia, description: "Big Panda Flooring Scotia PVC/WPC", qty: 26, unit: "each", unitPrice: 9.17, total: 238.42, sortOrder: 1, kind: "material" } as any)
      .returning();
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    await addProduct({ quoteId: qid, productId: P.bpTrim27, installedLm: 5 });
    const same = await lineOf(old!.id);
    expect([same.qty, same.unitPrice, same.total, same.defaultsApplied ?? null]).toEqual([26, 9.17, 238.42, old!.defaultsApplied ?? null]);
  });
});

describe("7 Nov catalog decisions: base plates, new skirting, Sunstar and Riverhill trims, domestic and commercial sheet", () => {
  // Copies of the live records as 2026-11-30-catalog-decisions.sql leaves them.
  test("set up the demo products", async () => {
    await product("acBase", { brand: "Acouslime", range: "Universal Base Plate", colour: "Standard", sku: "D-UBP", category: "trim", unit: "each", pieceLengthM: 3.4, costPrice: 19, sellPrice: 36.6 });
    await product("rhChannel", { brand: "Riverhill", range: "Elegant Hybrid 6.5mm", colour: "", sku: "Base Channel", category: "accessory", unit: "each", pieceLengthM: 2.4, costPrice: 1.5, sellPrice: 2.87 });
    await product("ssTTrim", { brand: "Sunstar", range: "Vinyl Wrapped", colour: "", sku: "T-Trim", category: "trim", unit: "each", pieceLengthM: 2.4, costPrice: 22, sellPrice: 42.04 });
    await product("m10Skirt", { brand: "Mitre 10", range: "Pine Moulding Bullnose", colour: "", sku: "D-B940745", category: "skirting", unit: "each", lengthMm: 5400, pieceLengthM: 5.4, costPrice: 5.3, sellPrice: 10.09 });
    await product("armCommercial", { brand: "Armstrong", range: "Accolade Plus", colour: "Grey", sku: "D-AP", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2, tier: "Commercial Sheet" });
    await product("mjsDomestic", { brand: "MJS Floorcoverings", range: "Trojan", colour: "Oak", sku: "D-TR", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 4, tier: "Domestic Sheet" });
  });

  const noteOf = (r: unknown) => String((r as { qtyNote?: string | null }).qtyNote ?? "");

  test("the rules: a base plate or base channel is an insert, not a trim; skirting is not a trim", () => {
    expect(m.rules.isTrimProduct({ category: "trim", brand: "Acouslime", range: "Universal Base Plate", colour: "Standard" })).toBe(false);
    expect(m.rules.isTrimProduct({ category: "accessory", brand: "Riverhill", range: "Universal base channel" })).toBe(false);
    expect(m.rules.isTrimComponent({ range: "Universal Base Plate Plus 20mm" })).toBe(true);
    expect(m.rules.isTrimProduct({ category: "trim", brand: "Sunstar", range: "Vinyl Wrapped" })).toBe(true);
    expect(m.rules.isTrimProduct({ category: "skirting", brand: "Mitre 10", range: "Pine Moulding Bullnose" })).toBe(false);
    expect(m.rules.isDomesticSheet({ tier: " domestic sheet " })).toBe(true);
    expect(m.rules.isCommercialSheet({ tier: "Domestic Sheet" })).toBe(false);
  });

  test("a base plate is bought in 3.4 m lengths and brings no install of its own", async () => {
    const qid = await newQuote();
    const bp = await addProduct({ quoteId: qid, productId: P.acBase, qty: 7 });
    expect(noteOf(bp)).toContain("7 lengths of 3.4 m (23.8 lm)");
    expect((await lineOf(bp.item.id)).total).toBe(r2t(7 * 36.6));
    expect(await installsOf(qid)).toHaveLength(0);
  });

  test("top cover and base plate on one hybrid run: the run's install is charged once", async () => {
    const qid = await newQuote();
    const hy = await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 30 });
    const area = (await installsOf(qid)).find((l) => l.defaultForItemId === hy.item.id)!;
    await addProduct({ quoteId: qid, productId: P.acTop34, installedLm: 23 });
    const bp = await addProduct({ quoteId: qid, productId: P.acBase, qty: 7 });
    const installs = await installsOf(qid);
    expect(installs.map((l) => [l.id, l.qty])).toEqual([[area.id, 23]]);
    expect(installs[0]!.flagReason ?? "").not.toContain(bp.item.description);
  });

  test("a Sunstar T-Trim, now a trim: 23 lm installed is 10 lengths, install at 23 lm", async () => {
    const qid = await newQuote();
    const t = await addProduct({ quoteId: qid, productId: P.ssTTrim, installedLm: 23 });
    const line = await lineOf(t.item.id);
    expect([line.qty, line.total]).toEqual([10, r2t(10 * 42.04)]);
    const [inst] = await installsOf(qid);
    expect([inst!.qty, inst!.flagged]).toEqual([23, false]);
  });

  test("Mitre 10 pine moulding is new skirting: 5.4 m lengths, Install new skirting flagged to fill in, no trim install, no skirting removal", async () => {
    const qid = await newQuote();
    const sk = await addProduct({ quoteId: qid, productId: P.m10Skirt, qty: 5 });
    expect(noteOf(sk)).toContain("5 lengths of 5.4 m (27 lm)");
    const rated = (await linesOf(qid)).filter((l) => l.rateItemId != null);
    expect(rated.map((l) => [l.rateItemId, l.qty, l.flagged, l.defaultForItemId])).toEqual([[121, 0, true, sk.item.id]]);
    expect(rated[0]!.flagReason).toBe(m.rules.SKIRTING_FLAG);
  });

  test("new skirting with 25 lm installed: 5 lengths of 5.4 m, Install new skirting at 25 lm, $10 a lm cost at 50% markup", async () => {
    expect(m.rules.isNewSkirting({ category: "skirting" })).toBe(true);
    expect(m.rules.takesInstalledLm({ category: "skirting" })).toBe(true);
    const qid = await newQuote();
    const sk = await addProduct({ quoteId: qid, productId: P.m10Skirt, installedLm: 25 });
    const line = await lineOf(sk.item.id);
    expect([line.qty, line.total]).toEqual([5, r2t(5 * 10.09)]);
    const [inst] = (await linesOf(qid)).filter((l) => l.rateItemId != null);
    expect([inst!.rateItemId, inst!.description, inst!.qty, inst!.unitCost, inst!.unitPrice, inst!.total, inst!.flagged]).toEqual([121, "Install new skirting", 25, 10, 15, 375, false]);
    // Taken off with its skirting line, and the quote is clear.
    await removeItem(sk.item.id);
    expect((await linesOf(qid)).length).toBe(0);
  });

  test("typing the length on Install new skirting clears its fill-in flag", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.m10Skirt, qty: 4 });
    const [inst] = (await linesOf(qid)).filter((l) => l.rateItemId === 121);
    await updateItem({ id: inst!.id, qty: 20 });
    const now = await lineOf(inst!.id);
    expect([now.qty, now.flagged, now.total]).toEqual([20, false, 300]);
  });

  test("Armstrong Accolade Plus (Commercial Sheet) gets the commercial lines; MJS Trojan (Domestic Sheet) gets none and is not flagged", async () => {
    const rateIds = async (qid: number) => (await linesOf(qid)).map((l) => l.rateItemId).filter((r) => r != null).sort((a, b) => a! - b!);
    const com = await newQuote();
    await addProduct({ quoteId: com, productId: P.armCommercial, measuredM2: 20 });
    expect(await rateIds(com)).toEqual([19, 20, 21, 102, 109]);
    const dom = await newQuote();
    const d = await addProduct({ quoteId: dom, productId: P.mjsDomestic, measuredM2: 20 });
    expect((await rateIds(dom)).filter((r) => [20, 21, 102, 109].includes(r!))).toEqual([]);
    expect((await lineOf(d.item.id)).flagReason ?? "").not.toContain(m.rules.NOT_COMMERCIAL_MARK);
  });
});

test("nothing was sent", () => {
  expect(blocked).toEqual([]);
});
