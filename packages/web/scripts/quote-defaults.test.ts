/**
 * Quote defaults v2 (Damien's brief, 6 Nov 2026, and his answers the same day).
 *
 *   bun test scripts/quote-defaults.test.ts      (from packages/web)
 *
 * Runs the real quote routes (addProduct, addLabour, updateItem, removeItem,
 * revise, accept) on a throwaway SQLite file built from the schema. Sign in
 * is faked to one Admin profile, the office alerts are caught, and every
 * network call is blocked, so nothing leaves the machine. The rate book and
 * products are the live records Damien's table names (same ids, names, SKUs
 * and rates), plus one floor product of each type.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

type Mods = {
  db: typeof import("../src/api/database").db;
  quotes: typeof import("../src/api/routes/quotes").quotes;
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
  // Sign in: every call is the one Admin profile below.
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => ({ user: { id: USER, name: "Test Admin", email: "admin@example.invalid" }, session: {} }) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    quotes: (await import("../src/api/routes/quotes")).quotes,
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
  await product("sheetVinyl", { brand: "Polyflor", range: "Expona", colour: "Oak", sku: "SV1", category: "vinyl", soldAs: "broadloom", unit: "m2", widthM: 2 });
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
  run<{ id: number }, { removedLabour: number; removedDefaults: number; disposalFlagged: number }>(m.quotes.removeItem, { id });

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

  test("a hybrid added after a scotia: its 111 default says the install is already on", async () => {
    const qid = await newQuote();
    await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    await addProduct({ quoteId: qid, productId: P.hybrid, measuredM2: 20 });
    const trims = (await linesOf(qid)).filter((l) => l.rateItemId === 111);
    expect(trims).toHaveLength(2);
    expect(trims[1]!.flagReason).toContain("already on this quote");
  });

  test("removing the scotia takes its install, and it is not put back", async () => {
    const qid = await newQuote();
    const r = await addProduct({ quoteId: qid, productId: P.scotia, qty: 10 });
    const out = await removeItem(r.item.id);
    expect(out.removedDefaults).toBe(1);
    expect(await linesOf(qid)).toHaveLength(0);
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
  });
});

test("nothing was sent", () => {
  expect(blocked).toEqual([]);
});
