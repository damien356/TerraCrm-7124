/**
 * Edit price record, and the price book cost on Sell products lines
 * (Damien, 11 Nov 2026, job 188083).
 *
 *   bun test scripts/price-record-edit.test.ts      (from packages/web)
 *
 * Runs the real Sell products raise, and the real Edit price record routes,
 * on a throwaway SQLite file built from the schema. Job 188083 is replayed as
 * it is live: an installer buying Belgotex Boulevard in Gravel 45, 25 lm at
 * $263.34, Raise invoice now, ordering on, one draft PO at $137.80 a lm.
 * Sign in is faked; emails, texts, pushes and files are caught, and every
 * network call is blocked. Nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "price-record-edit-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY = "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;
delete process.env.STRIPE_SECRET_KEY;

const realFetch = globalThis.fetch;
const outside = { fetch: [] as string[], email: [] as unknown[], sms: [] as unknown[], push: [] as unknown[], stored: [] as string[], alerts: [] as string[] };

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "t-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "t-office", name: "Test Office", email: "office@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  sales: typeof import("../src/api/routes/productSales").productSales;
  orm: typeof import("drizzle-orm");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    outside.fetch.push(String(input));
    throw new Error(`Network blocked in price-record-edit tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({
    ...realNotify,
    notifyOffice: async (kind: string) => {
      outside.alerts.push(kind);
    },
  }));
  const realPush = await import("../src/api/lib/push");
  mock.module("../src/api/lib/push", () => ({
    ...realPush,
    sendPush: async () => 0,
    pushToInstaller: async (id: number) => {
      outside.push.push(id);
      return 0;
    },
    pushToOffice: async (x: unknown) => {
      outside.push.push(x);
      return 0;
    },
  }));
  const realEmail = await import("../src/api/lib/email");
  mock.module("../src/api/lib/email", () => ({
    ...realEmail,
    sendEmail: async (a: unknown) => {
      outside.email.push(a);
      return { ok: false, reason: "test" };
    },
  }));
  const realSms = await import("../src/api/lib/sms");
  mock.module("../src/api/lib/sms", () => ({
    ...realSms,
    sendSms: async (a: unknown) => {
      outside.sms.push(a);
      return { ok: false, reason: "test" };
    },
  }));
  const realS3 = await import("../src/api/lib/s3");
  mock.module("../src/api/lib/s3", () => ({
    ...realS3,
    putObject: async (key: string) => {
      outside.stored.push(key);
    },
  }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    sales: (await import("../src/api/routes/productSales")).productSales,
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
const run = <O = any>(proc: any, input: unknown) => m.call(proc, input, { context: { headers: new Headers() } }) as Promise<O>;
async function failure(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected it to be refused");
}

/* --------------------------------- fixtures --------------------------------- */

const ids = { belgotex: 0, boulevard: 0, other: 0, underlay: 0, contact: 0, installer: 22 };

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true } as any);
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: "Test Office", email: OFFICE!.email, role: "office" } as any);
  for (const [id, name] of [[1, "Lead"], [2, "Quoted"], [3, "Won"], [4, "Scheduled"], [5, "In Progress"], [6, "Complete"], [7, "Invoiced"], [8, "Paid"], [9, "Cancelled"]] as const) {
    await db.insert(schema.jobStatuses).values({ id, name, active: true } as any);
  }
  // Belgotex as it is live: delivers to store, no PO-free flag. Its supplier email is a .invalid address.
  const [b] = await db.insert(schema.suppliers).values({ name: "Belgotex", code: "belgotex", active: true, deliversDirect: true, deliversTo: "both", email: "orders@belgotex.invalid" } as any).returning();
  ids.belgotex = b!.id;
  const [o] = await db.insert(schema.suppliers).values({ name: "Underlay Co", code: "underlayco", active: true, email: "orders@underlay.invalid" } as any).returning();
  ids.other = o!.id;
  const [p] = await db
    .insert(schema.products)
    .values({
      supplierId: ids.belgotex,
      supplier: "Belgotex",
      brand: "Belgotex",
      range: "Boulevard",
      colour: "Gravel 45",
      category: "carpet",
      unit: "lm",
      costPrice: 137.8,
      sellPrice: 263.34,
      active: true,
      size: "4.00m wide",
      widthM: 4,
      minOrderQty: 2,
      variantKey: "belgotex|carpet|boulevard|gravel-45|4m",
      bulkKind: "roll",
      soldAs: "broadloom",
      supplyMode: "job",
    } as any)
    .returning();
  ids.boulevard = p!.id;
  const [u] = await db
    .insert(schema.products)
    .values({ supplierId: ids.other, supplier: "Underlay Co", brand: "Test", range: "Comfort", colour: "Grey", category: "accessory", unit: "each", costPrice: 40, sellPrice: 60, active: true, variantKey: "test|underlay|comfort", supplyMode: "job" } as any)
    .returning();
  ids.underlay = u!.id;
  const [c] = await db.insert(schema.contacts).values({ firstName: "Phillip", lastName: "Test", email: "phillip@example.invalid" } as any).returning();
  ids.contact = c!.id;
  await db.insert(schema.installers).values({ id: ids.installer, name: "Phillip Test", active: true } as any);
  await db.insert(schema.installerBuyerLinks).values({ installerId: ids.installer, billToType: "contact", contactId: ids.contact, buyerName: "PHILLIP TEST", basis: "confirmed", confirmedByName: "Test", confirmedAt: new Date() } as any);
}

const LINE = () => ({ productId: ids.boulevard, description: "", qty: 25, unit: "lm", unitPrice: 263.34, fromStock: 0 });

/** Sell products as 188083 was raised: installer, Raise invoice now, ordering on. */
async function raise188083() {
  const input = { buyer: { kind: "installer" as const, installerId: ids.installer }, mode: "invoice" as const, lines: [LINE()], orderNeeded: true, depositPercent: null, note: null };
  const pv = await run(m.sales.preview, input);
  const out = await run(m.sales.raise, { ...input, requestKey: `k-${Math.random().toString(36).slice(2)}-188083`, expectedTotal: pv.total });
  return { pv, out, jobId: out.jobId as number };
}

async function rowsOf(jobId: number) {
  const [job] = await q("select * from jobs where id=?", [jobId]);
  const [quote] = await q("select * from quotes where job_id=?", [jobId]);
  const items = await q("select * from quote_items where quote_id=? order by sort_order, id", [quote.id]);
  const invoices = await q("select * from invoices where job_id=? order by id", [jobId]);
  const [sale] = await q("select * from product_sales where job_id=?", [jobId]);
  const lines = await q("select * from product_sale_lines where sale_id=? order by sort_order, id", [sale.id]);
  const mats = await q("select * from job_materials where job_id=? order by id", [jobId]);
  const pos = await q("select * from purchase_orders where job_id=? order by id", [jobId]);
  const poLines = await q("select * from purchase_order_lines where po_id in (select id from purchase_orders where job_id=?) order by po_id, sort_order, id", [jobId]);
  const acts = await q("select * from activity_log where job_id=? order by id", [jobId]);
  return { job, quote, items, invoices, sale, lines, mats, pos, poLines, acts };
}

const state = (jobId: number) => run(m.sales.priceRecord, { jobId });
const lineIn = (rec: any, over: Record<string, unknown> = {}) =>
  rec.lines.map((l: any) => ({ quoteItemId: l.quoteItemId, productId: l.productId, description: l.description, qty: l.qty, unit: l.unit, unitPrice: l.unitPrice, unitCost: l.unitCost, fromStock: l.fromStock, ...over }));
async function save(jobId: number, lines: any[], note: string | null = null) {
  const rec = await state(jobId);
  const pv = await run(m.sales.previewPriceRecordEdit, { jobId, lines });
  return run(m.sales.editPriceRecord, { jobId, lines, stamp: rec.stamp, expectedTotal: pv.after.total, note });
}

/* ---------------------------------- tests ---------------------------------- */

describe("Sell products puts the price book cost on its lines", () => {
  test("188083 replayed: cost $137.80 on the line, total still $7,241.85, no supplier charge lines", async () => {
    const { pv, jobId } = await raise188083();
    expect(pv.total).toBe(7241.85);
    const r = await rowsOf(jobId);
    expect(r.items.length).toBe(1);
    expect(r.items[0].unit_cost).toBe(137.8);
    expect(r.items[0].markup_percent).toBeGreaterThan(90);
    expect(r.items.some((i: any) => i.kind === "supplier_charge")).toBe(false);
    expect(r.quote.total).toBe(7241.85);
    expect(r.invoices.length).toBe(1);
    expect(r.invoices[0].total).toBe(7241.85);
    expect(r.pos.length).toBe(1);
    expect(r.pos[0].status).toBe("draft");
    expect(r.pos[0].total_ex_gst).toBe(3445);
  });

  test("a quote (not an invoice) gets the cost too; a typed line has none", async () => {
    const input = {
      buyer: { kind: "contact" as const, contactId: ids.contact },
      mode: "quote" as const,
      lines: [LINE(), { productId: null, description: "Delivery by hand", qty: 1, unit: "each", unitPrice: 50 }],
      orderNeeded: false,
      depositPercent: 0,
      note: null,
    };
    const pv = await run(m.sales.preview, input);
    const out = await run(m.sales.raise, { ...input, requestKey: `k-quote-${Math.random().toString(36).slice(2)}`, expectedTotal: pv.total });
    const r = await rowsOf(out.jobId);
    expect(r.items.map((i: any) => i.unit_cost)).toEqual([137.8, null]);
    expect(r.quote.total).toBe(pv.total);
  });
});

describe("Edit price record", () => {
  let jobId = 0;
  test("188083 is editable; a login without costs sees no cost", async () => {
    ({ jobId } = await raise188083());
    const rec = await state(jobId);
    expect(rec.isPriceRecord).toBe(true);
    expect(rec.blockers).toEqual([]);
    expect(rec.editable).toBe(true);
    expect(rec.lines[0].unitCost).toBe(137.8);
    const office = await as(OFFICE, () => state(jobId));
    expect(office.lines[0].unitCost).toBeNull();
    expect(office.lines[0].bookCost).toBeNull();
  });

  test("preview writes nothing", async () => {
    const rec = await state(jobId);
    const before = await rowsOf(jobId);
    const pv = await run(m.sales.previewPriceRecordEdit, { jobId, lines: lineIn(rec, { qty: 23, unitPrice: 250 }) });
    expect(pv.after.total).toBe(6325);
    expect(pv.invoice.after).toBe(6325);
    expect(pv.drafts[0].after).toBe(3169.4);
    expect(pv.changes.join(" ")).toContain("25 lm to 23 lm");
    const after = await rowsOf(jobId);
    expect(after.quote.total).toBe(before.quote.total);
    expect(after.invoices[0].total).toBe(before.invoices[0].total);
    expect(after.acts.length).toBe(before.acts.length);
  });

  test("qty and price flow to the quote, job value, invoice (same number), sale line, material and draft PO", async () => {
    const before = await rowsOf(jobId);
    const rec = await state(jobId);
    const out = await save(jobId, lineIn(rec, { qty: 23, unitPrice: 250 }), "installer took 23 lm");
    expect(out.changed).toBe(true);
    const r = await rowsOf(jobId);
    expect(r.quote.subtotal).toBe(5750);
    expect(r.quote.total).toBe(6325);
    expect(r.job.value).toBe(6325);
    expect(r.items[0].qty).toBe(23);
    expect(r.items[0].unit_price).toBe(250);
    expect(r.items[0].unit_cost).toBe(137.8);
    expect(r.invoices.length).toBe(1);
    expect(r.invoices[0].number).toBe(before.invoices[0].number);
    expect(r.invoices[0].id).toBe(before.invoices[0].id);
    expect(r.invoices[0].subtotal).toBe(5750);
    expect(r.invoices[0].total).toBe(6325);
    expect(r.lines[0].qty).toBe(23);
    expect(r.mats[0].qty).toBe(23);
    expect(r.pos.length).toBe(1);
    expect(r.pos[0].number).toBe(before.pos[0].number);
    expect(r.pos[0].status).toBe("draft");
    expect(r.pos[0].sent_at).toBeNull();
    expect(r.pos[0].total_ex_gst).toBe(3169.4);
    expect(r.poLines.filter((l: any) => l.kind === "goods").map((l: any) => [l.qty, l.job_material_id])).toEqual([[23, r.mats[0].id]]);
    const log = r.acts.find((a: any) => a.action === "price_record_edited");
    expect(log.detail).toContain("Why: installer took 23 lm");
    expect(log.detail).toContain("Nothing was emailed or sent.");
    expect(log.detail).toContain(`${r.invoices[0].number} now $6,325.00, same number`);
    const inst = await q("select * from activity_log where entity_type='installer' and entity_id=? and action='materials_invoice_changed'", [ids.installer]);
    expect(inst.length).toBe(1);
    // The forecast follows the invoice.
    const cash = await q("select * from cash_events where invoice_id=?", [r.invoices[0].id]);
    if (cash.length) expect(cash[0].amount).toBe(6325);
  });

  test("a screen opened before the save can not save over it", async () => {
    const old = await state(jobId);
    await save(jobId, lineIn(old, { unitPrice: 251 }));
    const lines = lineIn(old, { unitPrice: 252 });
    const pv = await run(m.sales.previewPriceRecordEdit, { jobId, lines });
    const e = await failure(run(m.sales.editPriceRecord, { jobId, lines, stamp: old.stamp, expectedTotal: pv.after.total }));
    expect(String(e.message)).toContain("Someone changed this sale since you opened it");
    expect((await rowsOf(jobId)).items[0].unit_price).toBe(251);
  });

  test("the same save twice changes nothing the second time", async () => {
    const rec = await state(jobId);
    const acts = (await rowsOf(jobId)).acts.length;
    const out = await save(jobId, lineIn(rec));
    expect(out.changed).toBe(false);
    expect((await rowsOf(jobId)).acts.length).toBe(acts);
  });

  test("a wrong expected total is refused", async () => {
    const rec = await state(jobId);
    const e = await failure(run(m.sales.editPriceRecord, { jobId, lines: lineIn(rec, { qty: 20 }), stamp: rec.stamp, expectedTotal: 1 }));
    expect(String(e.message)).toContain("not the $1.00 you saw");
  });

  test("From stock now lowers the material and the draft", async () => {
    const rec = await state(jobId);
    await save(jobId, lineIn(rec, { fromStock: 5 }));
    const r = await rowsOf(jobId);
    expect(r.lines[0].from_stock).toBe(5);
    expect(r.mats[0].qty).toBe(18);
    expect(r.poLines.filter((l: any) => l.kind === "goods")[0].qty).toBe(18);
    const back = await state(jobId);
    await save(jobId, lineIn(back, { fromStock: 0 }));
    expect((await rowsOf(jobId)).mats[0].qty).toBe(23);
  });

  test("a login without costs can not change a cost; its other changes still save", async () => {
    const rec = await as(OFFICE, () => state(jobId));
    await as(OFFICE, () => save(jobId, lineIn(rec, { unitCost: 1, unitPrice: 255 })));
    const r = await rowsOf(jobId);
    expect(r.items[0].unit_price).toBe(255);
    expect(r.items[0].unit_cost).toBe(137.8);
  });

  test("an admin can change the cost; the customer's total does not move", async () => {
    const rec = await state(jobId);
    const before = (await rowsOf(jobId)).quote.total;
    await save(jobId, lineIn(rec, { unitCost: 130 }));
    const r = await rowsOf(jobId);
    expect(r.items[0].unit_cost).toBe(130);
    expect(r.quote.total).toBe(before);
    await save(jobId, lineIn(await state(jobId), { unitCost: 137.8 }));
  });

  test("swapping the product on a line is refused", async () => {
    const rec = await state(jobId);
    const e = await failure(run(m.sales.previewPriceRecordEdit, { jobId, lines: lineIn(rec, { productId: ids.underlay }) }));
    expect(String(e.message)).toContain("remove the line and add the new product");
  });

  test("an added line from another supplier gets its own draft PO and the price book cost", async () => {
    const rec = await state(jobId);
    const lines = [...lineIn(rec), { productId: ids.underlay, description: "", qty: 3, unit: "each", unitPrice: 60, fromStock: 0 }];
    const out = await save(jobId, lines);
    expect(out.drafted.length).toBe(1);
    const r = await rowsOf(jobId);
    expect(r.items.length).toBe(2);
    expect(r.items[1].unit_cost).toBe(40);
    expect(r.quote.subtotal).toBe(23 * 255 + 180);
    expect(r.invoices[0].subtotal).toBe(23 * 255 + 180);
    expect(r.lines.length).toBe(2);
    const live = r.pos.filter((p: any) => p.status === "draft");
    expect(live.length).toBe(2);
    expect(live.map((p: any) => p.supplier_id).sort()).toEqual([ids.belgotex, ids.other].sort());
  });

  test("a removed line takes its draft PO with it (kept as cancelled, never sent)", async () => {
    const rec = await state(jobId);
    const lines = lineIn(rec).filter((l: any) => l.productId === ids.boulevard);
    await save(jobId, lines);
    const r = await rowsOf(jobId);
    expect(r.items.length).toBe(1);
    expect(r.lines.length).toBe(1);
    expect(r.mats.length).toBe(1);
    const other = r.pos.find((p: any) => p.supplier_id === ids.other);
    expect(other.status).toBe("cancelled");
    expect(other.sent_at).toBeNull();
    expect(r.pos.find((p: any) => p.supplier_id === ids.belgotex).status).toBe("draft");
    expect(r.quote.subtotal).toBe(23 * 255);
    expect(r.invoices[0].subtotal).toBe(23 * 255);
  });

  test("locked once the invoice is emailed, in Xero, paid, or a PO is sent", async () => {
    const r = await rowsOf(jobId);
    const inv = r.invoices[0];
    const po = r.pos.find((p: any) => p.status === "draft");
    const tryIt = async () => {
      const rec = await state(jobId);
      expect(rec.editable).toBe(false);
      const e = await failure(run(m.sales.editPriceRecord, { jobId, lines: lineIn(rec, { qty: 10 }), stamp: rec.stamp, expectedTotal: 0 }));
      expect(String(e.message)).toContain("Locked:");
      return rec.blockers.join(" ");
    };
    await q("insert into activity_log (entity_type, entity_id, action, detail, actor_name, actor_role, created_at) values ('invoice', ?, 'invoice_emailed', 'test', 'Test', 'admin', unixepoch())", [inv.id]);
    expect(await tryIt()).toContain("was emailed");
    await q("delete from activity_log where entity_type='invoice' and action='invoice_emailed'");

    await q("update invoices set xero_invoice_id='x-test' where id=?", [inv.id]);
    expect(await tryIt()).toContain("is in Xero");
    await q("update invoices set xero_invoice_id=null where id=?", [inv.id]);

    await q("update invoices set amount_paid=100 where id=?", [inv.id]);
    expect(await tryIt()).toContain("is paid on");
    await q("update invoices set amount_paid=0 where id=?", [inv.id]);

    await q("update purchase_orders set status='sent', sent_at=unixepoch() where id=?", [po.id]);
    expect(await tryIt()).toContain("has gone to the supplier");
    await q("update purchase_orders set status='draft', sent_at=null where id=?", [po.id]);

    expect((await state(jobId)).editable).toBe(true);
    const after = await rowsOf(jobId);
    expect(after.items[0].qty).toBe(23);
  });

  test("a normal quote's job is not a price record", async () => {
    const [row] = await q("select job_id from quotes where status != 'accepted' and job_id is not null limit 1");
    const rec = await state(row.job_id);
    expect(rec?.isPriceRecord ?? false).toBe(false);
  });

  test("nothing left the machine", () => {
    expect(outside.fetch).toEqual([]);
    expect(outside.email).toEqual([]);
    expect(outside.sms).toEqual([]);
    expect(outside.stored).toEqual([]);
  });
});
