/**
 * Shared set-up for the warehouse stock tests (Step A).
 *
 * A throwaway database file built from schema.ts. Push, email, SMS and the
 * job mailer are replaced with recorders, and fetch is blocked, so no test
 * can reach Stripe, Xero, Resend, the SMS gateway or the phones. Stripe is
 * exercised through its signed webhook with a made-up secret.
 *
 * Imported by stock.test.ts only. Run from packages/web: bun test scripts/stock
 */
import { mock } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../../src/api/database/schema";

export { schema };

export const dir = mkdtempSync(join(tmpdir(), "stock-test-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY = "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
// Made-up Stripe values. Nothing calls Stripe: fetch is blocked below.
process.env.STRIPE_SECRET_KEY = "sk_test_not_a_real_key";
export const WEBHOOK_SECRET = "whsec_test_only_not_real";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;

/** Everything that tried to leave the machine. Each list must stay empty, or hold only captured fakes. */
export const outside = {
  fetch: [] as string[],
  push: [] as { title: string; body: string }[],
  email: [] as { to: unknown; subject: unknown }[],
  sms: [] as { to: unknown }[],
  jobMail: [] as { to: string }[],
  /** A2 follow-up: purchase orders "sent" to a test-only supplier address. Captured here, never sent. */
  supplierMail: [] as { to: string; subject: string; text: string; attachments: { filename: string; content: string }[] }[],
  /** Make the next N emails fail, as a relay outage would. */
  failNext: 0,
  /** Files the app tried to store. Never uploaded. */
  stored: [] as string[],
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
  outside.fetch.push(url);
  throw new Error(`Network blocked in stock tests: ${url}`);
}) as typeof fetch;
export const restoreFetch = () => (globalThis.fetch = realFetch);

let client: Client;
export const sql = async (s: string, args: (string | number | null)[] = []) => (await client.execute({ sql: s, args })).rows as any[];

async function load() {
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realPush = await import("../../src/api/lib/push");
  mock.module("../../src/api/lib/push", () => ({
    ...realPush,
    sendPush: async () => 0,
    pushToInstaller: async () => 0,
    pushToOffice: async (m: { title: string; body: string }) => {
      outside.push.push({ title: m.title, body: m.body });
      return 1;
    },
  }));
  const realEmail = await import("../../src/api/lib/email");
  mock.module("../../src/api/lib/email", () => ({
    ...realEmail,
    sendEmail: async (a: { to: unknown; subject: unknown; text?: string; attachments?: { filename: string; content: string }[] }) => {
      if (outside.failNext > 0) {
        outside.failNext--;
        return { ok: false, reason: "Test relay is down (500)" };
      }
      if (/^Purchase order /.test(String(a.subject))) {
        if (!/@[a-z0-9.-]+\.invalid$/i.test(String(a.to))) throw new Error(`Supplier mail in tests must go to a .invalid address, not ${String(a.to)}`);
        outside.supplierMail.push({ to: String(a.to), subject: String(a.subject), text: a.text ?? "", attachments: a.attachments ?? [] });
        return { ok: true, id: `test-po-${outside.supplierMail.length}` };
      }
      outside.email.push({ to: a.to, subject: a.subject });
      return { ok: true, id: `test-${outside.email.length}` };
    },
  }));
  const realS3 = await import("../../src/api/lib/s3");
  mock.module("../../src/api/lib/s3", () => ({
    ...realS3,
    putObject: async (key: string) => {
      outside.stored.push(key);
    },
  }));
  const realSms = await import("../../src/api/lib/sms");
  mock.module("../../src/api/lib/sms", () => ({
    ...realSms,
    sendSms: async (a: { to: unknown }) => {
      outside.sms.push({ to: a.to });
      return { ok: false, reason: "test" };
    },
  }));
  const realMail = await import("../../src/api/lib/job-mail");
  mock.module("../../src/api/lib/job-mail", () => ({
    ...realMail,
    pickedFiles: async () => [],
    sendJobEmail: async (a: { to: string }) => {
      outside.jobMail.push({ to: a.to });
      return { via: "test", message: { id: outside.jobMail.length }, linked: [] };
    },
  }));

  return {
    db: (await import("../../src/api/database")).db,
    core: await import("../../src/api/lib/stock/core"),
    items: await import("../../src/api/lib/stock/items"),
    orders: await import("../../src/api/lib/stock/orders"),
    holds: await import("../../src/api/lib/stock/holds"),
    recheck: await import("../../src/api/lib/stock/recheck"),
    costs: await import("../../src/api/lib/stock/costs"),
    alerts: await import("../../src/api/lib/stock/alerts"),
    pay: await import("../../src/api/lib/stock/pay"),
    receiving: await import("../../src/api/lib/stock/receiving"),
    remainders: await import("../../src/api/lib/stock/remainders"),
    returns: await import("../../src/api/lib/stock/returns"),
    ci: await import("../../src/api/lib/client-invoices"),
    stripe: await import("../../src/api/lib/stripe"),
    publicPages: await import("../../src/api/routes/publicPages"),
    pdf: await import("../../src/api/lib/clientInvoicePdf"),
    mail: await import("../../src/api/lib/invoice-email"),
    expected: await import("../../src/api/lib/expected-costs"),
    po: await import("../../src/api/lib/purchase-orders"),
    match: await import("../../src/api/lib/invoice-match"),
    poHelper: await import("../../src/api/lib/po-helper"),
    cashflow: await import("../../src/api/lib/cashflow"),
    crew: await import("../../src/api/lib/crew-materials"),
    replenish: await import("../../src/api/lib/stock/replenish"),
    warehousePo: await import("../../src/api/lib/stock/warehouse-po"),
    warehouseCash: await import("../../src/api/lib/stock/warehouse-cash"),
    supplyCheck: await import("../../src/api/lib/stock/supply-check"),
    purchasing: await import("../../src/api/routes/purchasing"),
    poGate: await import("../../src/api/lib/stock/po-send-gate"),
    quoteAccept: await import("../../src/api/lib/quote-accept"),
    productSale: await import("../../src/api/lib/product-sale"),
    drizzle: await import("drizzle-orm"),
  };
}
export type Mods = Awaited<ReturnType<typeof load>>;
let mods: Mods | null = null;
export async function setup() {
  mods ??= await load();
  return mods;
}
export const m = () => {
  if (!mods) throw new Error("setup() first");
  return mods;
};
export function teardown() {
  client?.close();
  restoreFetch();
  rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------- people --------------------------------- */

export type TestActor = {
  userId: string;
  name: string;
  email: string;
  role: "admin" | "office" | "field";
  installerId: number | null;
  canSeeCosts: boolean;
  profileId: number | null;
  isMainAdmin: boolean;
  canRestorePeople: boolean;
};
export const people = {} as Record<"main" | "admin2" | "office" | "officeCosts" | "officeNoTick" | "field", TestActor>;

export async function makePeople() {
  const { db } = m();
  const mk = async (key: keyof typeof people, role: TestActor["role"], extra: Partial<TestActor> = {}) => {
    const [p] = await db
      .insert(schema.profiles)
      .values({ userId: `u-${key}`, name: `Test ${key}`, email: `${key}@example.invalid`, role, canSeeCosts: !!extra.canSeeCosts, isMainAdmin: !!extra.isMainAdmin })
      .returning();
    people[key] = {
      userId: `u-${key}`,
      name: `Test ${key}`,
      email: `${key}@example.invalid`,
      role,
      installerId: null,
      canSeeCosts: !!extra.canSeeCosts,
      profileId: p!.id,
      isMainAdmin: !!extra.isMainAdmin,
      canRestorePeople: false,
    };
  };
  await mk("main", "admin", { isMainAdmin: true, canSeeCosts: true });
  await mk("admin2", "admin", { canSeeCosts: true });
  await mk("office", "office");
  await mk("officeCosts", "office", { canSeeCosts: true });
  await mk("officeNoTick", "office");
  await mk("field", "field");
}

/* ------------------------------ catalogue seed ----------------------------- */

let n = 0;
const next = () => ++n;

export async function supplier(name = "Test Supplier") {
  const [s] = await m().db.insert(schema.suppliers).values({ name: `${name} ${next()}`, code: `TS${n}` }).returning();
  return s!;
}

export async function product(args: { supplierId?: number | null; category?: string; unit?: string; soldAs?: string | null; widthM?: number | null; name?: string }) {
  const [p] = await m()
    .db.insert(schema.products)
    .values({
      supplierId: args.supplierId ?? null,
      brand: "Test",
      range: args.name ?? `Range ${next()}`,
      colour: "Grey",
      category: args.category ?? "carpet",
      unit: args.unit ?? "m2",
      soldAs: args.soldAs ?? null,
      widthM: args.widthM ?? null,
      variantKey: `test-variant-${next()}`,
    })
    .returning();
  return p!;
}

let jobNo = 880000;
/** A contact, a job and optionally a quote. Accepted quotes are stamped now (after the switch went on). */
export async function job(args: {
  quoteTotal?: number;
  percent?: number | null;
  /** quote | card | none */
  source?: string;
  accepted?: boolean;
  cardPercent?: number | null;
  items?: { productId?: number | null; kind?: string; description: string; qty: number; unit?: string; unitCost?: number | null; chargeSupplierId?: number | null; lineType?: string }[];
}) {
  const { db } = m();
  // Accepting a quote in a test creates its own job at the next free number, so skip past any taken one.
  const taken = new Set((await db.select({ n: schema.jobs.number }).from(schema.jobs)).map((r) => r.n));
  while (taken.has(jobNo)) jobNo++;
  const number = jobNo++;
  const [contact] = await db
    .insert(schema.contacts)
    .values({ firstName: "Pat", lastName: `Tester ${number}`, email: `c${number}@example.invalid`, depositPercent: args.cardPercent ?? null })
    .returning();
  const [jb] = await db.insert(schema.jobs).values({ number, contactId: contact!.id, billToType: "contact", value: args.quoteTotal ?? 0, title: `Stock test ${number}` }).returning();
  let quote: typeof schema.quotes.$inferSelect | null = null;
  const quoteItems: (typeof schema.quoteItems.$inferSelect)[] = [];
  if (args.quoteTotal != null) {
    const total = args.quoteTotal;
    const subtotal = Math.round((total / 1.1) * 100) / 100;
    const pct = args.percent ?? null;
    [quote] = await db
      .insert(schema.quotes)
      .values({
        number,
        version: 1,
        jobId: jb!.id,
        contactId: contact!.id,
        status: args.accepted ? "accepted" : "sent",
        acceptedAt: args.accepted ? new Date() : null,
        subtotal,
        gst: Math.round((total - subtotal) * 100) / 100,
        total,
        depositPercent: pct ?? 0,
        depositSource: args.source ?? (pct == null ? "none" : "quote"),
      })
      .returning();
    for (const [i, it] of (args.items ?? []).entries()) {
      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: quote!.id,
          productId: it.productId ?? null,
          kind: it.kind ?? "supply",
          description: it.description,
          qty: it.qty,
          unit: it.unit ?? "m2",
          unitPrice: 0,
          unitCost: it.unitCost ?? null,
          chargeSupplierId: it.chargeSupplierId ?? null,
          lineType: it.lineType ?? "material",
          sortOrder: i,
        })
        .returning();
      quoteItems.push(row!);
    }
  }
  return { job: jb!, contact: contact!, quote, quoteItems };
}

export async function accept(quoteId: number) {
  const { db, drizzle } = m();
  await db.update(schema.quotes).set({ status: "accepted", acceptedAt: new Date() }).where(drizzle.eq(schema.quotes.id, quoteId));
}

/** A Sell products sale. mode "invoice" is a direct invoice; the sale's quote carries the %. */
export async function sale(args: { mode: "invoice" | "quote"; total: number; percent?: number | null; cardPercent?: number | null }) {
  const { db, ci, drizzle } = m();
  const made = await job({ quoteTotal: args.total, percent: args.percent ?? null, accepted: args.mode === "quote" ? false : false, cardPercent: args.cardPercent ?? null });
  await db.insert(schema.productSales).values({ requestKey: `sale-${made.job.id}-${next()}`, mode: args.mode, buyerKind: "contact", jobId: made.job.id });
  let invoice: typeof schema.invoices.$inferSelect | null = null;
  if (args.mode === "invoice") {
    invoice = await ci.raiseInvoice({ jobId: made.job.id, quoteId: made.quote!.id, kind: "final", label: "Products supplied", total: args.total, createdByName: "Test", actorRole: "office" } as any);
    [invoice] = await db.select().from(schema.invoices).where(drizzle.eq(schema.invoices.id, (invoice as any).id));
  }
  return { ...made, invoice };
}

export async function depositInvoice(jobId: number, quoteId: number | null, total: number) {
  const { ci, db, drizzle } = m();
  const row = await ci.raiseInvoice({ jobId, quoteId, kind: "deposit", label: "Deposit", total, createdByName: "Test", actorRole: "office" } as any);
  const [inv] = await db.select().from(schema.invoices).where(drizzle.eq(schema.invoices.id, (row as any).id));
  return inv!;
}

export async function invoice(id: number) {
  const { db, drizzle } = m();
  const [row] = await db.select().from(schema.invoices).where(drizzle.eq(schema.invoices.id, id));
  return row!;
}

/** A stock item, received and available. */
export async function item(productId: number, args: { qty: number; unit?: string; type?: string; unitCost?: number | null; costPer?: "lm" | "m2" | "unit"; widthM?: number | null; batch?: string | null; packSize?: number | null; condition?: string }) {
  const out = await m().items.createItem(
    {
      productId,
      type: (args.type ?? "roll") as "roll",
      unit: args.unit ?? "lm",
      qty: args.qty,
      widthM: args.widthM !== undefined ? args.widthM : args.unit === "lm" || !args.unit ? 4 : null,
      unitCost: args.unitCost === undefined ? 10 : args.unitCost,
      costPer: args.costPer ?? (args.unit && args.unit !== "lm" ? "unit" : "lm"),
      batch: args.batch === undefined ? "B1" : args.batch,
      packSize: args.packSize ?? null,
      condition: args.condition,
      costStatus: "final",
    },
    people.main,
    { status: "available", kind: "receive" },
  );
  return out.item;
}

let key = 0;
export const rk = (p = "k") => `${p}-${Date.now()}-${++key}`;

/* ------------------------------ fake Stripe ------------------------------- */

let pi = 0;
/** A signed checkout.session.completed, as Stripe would post it. The customer never comes back to the page. */
export function stripeEvent(invoiceId: number, amount: number, paymentIntent = `pi_test_${++pi}`) {
  const body = JSON.stringify({
    id: `evt_test_${pi}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${pi}`,
        metadata: { terra_invoice_id: String(invoiceId) },
        payment_status: "paid",
        currency: "aud",
        amount_total: Math.round(amount * 100),
        payment_intent: paymentIntent,
        customer_details: { name: "Pat Tester", email: "pat@example.invalid" },
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return { body, header: `t=${t},v1=${sig}`, paymentIntent };
}

/* --------------------------------- reading -------------------------------- */

export async function holdsOf(jobId: number) {
  const { db, drizzle } = m();
  return db.select().from(schema.stockReservations).where(drizzle.eq(schema.stockReservations.jobId, jobId)).orderBy(drizzle.asc(schema.stockReservations.id));
}
export async function alertsFor(orderId: number) {
  const { db, drizzle } = m();
  return db.select().from(schema.stockAlerts).where(drizzle.eq(schema.stockAlerts.orderId, orderId));
}
export async function paymentsOf(invoiceId: number) {
  const { db, drizzle } = m();
  return db.select().from(schema.invoicePayments).where(drizzle.eq(schema.invoicePayments.invoiceId, invoiceId));
}
export async function costsOf(jobId: number) {
  const { db, drizzle } = m();
  return db.select().from(schema.jobCosts).where(drizzle.eq(schema.jobCosts.jobId, jobId)).orderBy(drizzle.asc(schema.jobCosts.id));
}

/** The PDF's text, read back with pdftotext. */
export function pdfText(pdf: Buffer, name: string) {
  const f = join(dir, `${name}.pdf`);
  writeFileSync(f, pdf);
  const p = Bun.spawnSync(["pdftotext", "-layout", f, "-"]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
