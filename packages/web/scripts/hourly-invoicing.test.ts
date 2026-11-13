/**
 * Hourly contractor invoicing (Damien, 13 Nov 2026).
 *
 *   bun test scripts/hourly-invoicing.test.ts      (from packages/web)
 *
 * Runs the real approval, preview, issue, payment and task invoice code on a
 * throwaway SQLite file. The three new tables are made by the very SQL file
 * the live step runs (sql/2026-12-09-hourly-invoicing.sql), not by the
 * schema, so the file itself is tested too. Sign in is faked. Office alerts,
 * pushes, emails and file uploads are caught, and every network call is
 * blocked, so nothing leaves the machine. People are "Hourly A" and so on.
 * The $47 rate is only ever used here, never on a live record.
 *
 * Brief section 8, one describe block each:
 *   0  Before the database step: nothing changes
 *   1  Three days across two jobs, one invoice by dates: 22 h x $47 = $1,034.00, no GST
 *   2  One day invoiced on its own, the other days stay available (GST registered)
 *   3  Waiting for approval, rate to confirm, still running, not paid time: each explained
 *   4  GST: $103.40 GST, $1,137.40 total; a GST record that disagrees stops the invoice
 *   5  Double taps, retries and two phones at once never bill anything twice
 *   6  A rate change keeps earlier work; a correction on approved time needs approval again
 *   7  Privacy: each contractor sees only his own; costs stay with costs access
 *   8  Payments: Part paid, then Paid
 *   9  The task invoice and an invoice by dates never bill the same time
 *
 * Unsynced taps live on the phone (its offline queue and the dot on each
 * entry). On the server they arrive later with the same key, and an Issue
 * retry with the same request key gives back the same invoice (block 5).
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "hourly-invoicing-"));
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
const outside = { email: [] as Array<{ to: string; subject: string }>, stored: [] as string[] };

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "test-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE_NO_COSTS: Who = { id: "test-office", name: "Office B", email: "office@example.invalid" };
const A_LOGIN: Who = { id: "test-ha", name: "Hourly A", email: "ha@example.invalid" };
const G_LOGIN: Who = { id: "test-hg", name: "Hourly G", email: "hg@example.invalid" };
const M_LOGIN: Who = { id: "test-hm", name: "Hourly M", email: "hm@example.invalid" };
const R_LOGIN: Who = { id: "test-hr", name: "Hourly R", email: "hr@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

const HA = 41; // not GST registered
const HG = 42; // GST registered
const HM = 43; // card says GST, pay terms say no GST (the shape of a live record to confirm)
const HR = 44; // rate change and corrections
const RATE = 47;
const NEW_TABLES = ["installerInvoiceDetails", "installerInvoiceSessions", "installerInvoicePayments"];

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  orm: typeof import("drizzle-orm");
  hourly: typeof import("../src/api/routes/hourly").hourly;
  hi: typeof import("../src/api/routes/hourlyInvoices").hourlyInvoices;
  invoices: typeof import("../src/api/routes/installerInvoices").installerInvoices;
  lib: typeof import("../src/api/lib/hourly-invoice");
  period: typeof import("../src/api/lib/period-invoices");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in hourly-invoicing tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  // Everything except the three new tables: those come from the live SQL file below.
  const before = Object.fromEntries(Object.entries(schema).filter(([k]) => !NEW_TABLES.includes(k)));
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(before as any));
  for (const s of ddl) await client.execute(s);

  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({ ...realNotify, notifyOffice: async () => {} }));
  const realPush = await import("../src/api/lib/push");
  mock.module("../src/api/lib/push", () => ({ ...realPush, sendPush: async () => 0, pushToInstaller: async () => 0, pushToOffice: async () => 0 }));
  const realGoogle = await import("../src/api/lib/google-calendar");
  mock.module("../src/api/lib/google-calendar", () => ({ ...realGoogle, freeBusy: async () => [] }));
  const realEmail = await import("../src/api/lib/email");
  mock.module("../src/api/lib/email", () => ({
    ...realEmail,
    sendEmail: async (a: { to: string; subject: string }) => {
      outside.email.push({ to: a.to, subject: a.subject });
      return { ok: true };
    },
  }));
  const realS3 = await import("../src/api/lib/s3");
  mock.module("../src/api/lib/s3", () => ({
    ...realS3,
    putObject: async (key: string) => {
      outside.stored.push(key);
    },
    getObject: async () => Buffer.from("%PDF-test"),
    signGet: async (key: string) => `https://storage.example.invalid/${key}`,
  }));
  const realPdf = await import("../src/api/lib/invoicePdf");
  mock.module("../src/api/lib/invoicePdf", () => ({ ...realPdf, renderInvoicePdf: async () => Buffer.from("%PDF-test") }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    orm: await import("drizzle-orm"),
    hourly: (await import("../src/api/routes/hourly")).hourly,
    hi: (await import("../src/api/routes/hourlyInvoices")).hourlyInvoices,
    invoices: (await import("../src/api/routes/installerInvoices")).installerInvoices,
    lib: await import("../src/api/lib/hourly-invoice"),
    period: await import("../src/api/lib/period-invoices"),
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
const dates = (from: string, to: string) => ({ kind: "dates" as const, from, to });
let keyNo = 0;
const newKey = () => `test-request-${++keyNo}-${Date.now()}`;

/* --------------------------------- fixtures --------------------------------- */

async function applyHourlyInvoicingSql() {
  const text = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-12-09-hourly-invoicing.sql"), "utf8");
  const parts = text
    .split("--> statement-breakpoint")
    .map((p) => p.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
  for (const p of parts) await client.execute(p);
}

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true });
  await db.insert(schema.profiles).values({ userId: OFFICE_NO_COSTS!.id, name: "Office B", email: OFFICE_NO_COSTS!.email, role: "office", canSeeCosts: false } as any);
  await db.insert(schema.jobStatuses).values({ id: 4, name: "Scheduled", sortOrder: 3, stage: "scheduled" } as any);
  const bank = { bankBsb: "000-000", bankAccountNumber: "12345678", bankAccountName: "Test Account", abn: "51 824 753 556", abnStatus: "Active", active: true };
  for (const [id, name, gst, next] of [
    [HA, "Hourly A", false, 100],
    [HG, "Hourly G", true, 200],
    [HM, "Hourly M", true, 300],
    [HR, "Hourly R", false, 400],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, abnLegalName: name, gstRegistered: gst, nextInvoiceNumber: next, invoiceEmail: `${id}@example.invalid`, ...bank } as any);
  }
  for (const [login, installerId] of [
    [A_LOGIN, HA],
    [G_LOGIN, HG],
    [M_LOGIN, HM],
    [R_LOGIN, HR],
  ] as const) {
    await db.insert(schema.profiles).values({ userId: login!.id, name: login!.name, email: login!.email, role: "field", installerId } as any);
  }
  // Hourly pay terms. HM's terms say no GST while his card says GST.
  for (const [installerId, gstRegistered] of [
    [HA, false],
    [HG, true],
    [HM, false],
    [HR, false],
  ] as const) {
    await db.insert(schema.installerPayTerms).values({ installerId, baseRate: RATE, gstRegistered, defaultForNew: true, effectiveFrom: "2026-01-01" } as any);
  }
  // Settings so approval needs no band confirmation: night hours set, breaks unpaid.
  await db.insert(schema.settings).values({ key: "hourly_night_window", value: JSON.stringify({ start: "19:00", end: "05:00" }), updatedAt: new Date() });
  await db.insert(schema.settings).values({ key: "hourly_break_policy", value: "unpaid", updatedAt: new Date() });
}

let jobNo = 6100;
async function hourlyTask(installerId: number, title = "Hourly work") {
  const number = jobNo++;
  const [job] = await m.db.insert(schema.jobs).values({ number, value: 0, statusId: 4 } as any).returning();
  const [task] = await m.db
    .insert(schema.jobTasks)
    .values({ jobId: job!.id, title, seq: 1, assignedInstallerId: installerId, status: "assigned", payType: "hourly", scheduledDate: "2026-11-09" } as any)
    .returning();
  return { jobId: job!.id, taskId: task!.id, number };
}

/** Finished time: from 7am Brisbane on that date, for that many hours, no breaks. */
let sessionKey = 0;
async function worked(installerId: number, t: { jobId: number; taskId: number }, workDate: string, hours: number, extra: Record<string, unknown> = {}) {
  const start = new Date(`${workDate}T07:00:00+10:00`);
  const [s] = await m.db
    .insert(schema.workSessions)
    .values({
      installerId,
      taskId: t.taskId,
      jobId: t.jobId,
      clientKey: `s-${++sessionKey}`,
      workDate,
      startedAt: start,
      endedAt: new Date(start.getTime() + hours * 3600_000),
      status: "recorded",
      ...extra,
    } as any)
    .returning();
  return s!.id;
}

const approveAll = (ids: number[]) => run<{ approved: number[]; skipped: Array<{ sessionId: number; reason: string }> }>(m.hourly.bulkApprove, { items: ids.map((sessionId) => ({ sessionId })) });
const nextNo = async (id: number) => (await q("SELECT next_invoice_number AS n FROM installers WHERE id = ?", [id]))[0].n as number;
const countInvoices = async (id: number) => (await q("SELECT count(*) AS n FROM installer_invoices WHERE installer_id = ?", [id]))[0].n as number;

/* ---------------------------------- tests ----------------------------------- */

describe("0. Before the database step", () => {
  test("nothing changes: invoicing by dates says it is not switched on yet", async () => {
    m.period.resetHourlyInvoicingReady();
    expect(await m.period.hourlyInvoicingReady()).toBe(false);
    expect(await as(A_LOGIN, () => run(m.hi.ready, {}))).toEqual({ ready: false });
    const e = await failure(as(A_LOGIN, () => run(m.hi.preview, { period: { kind: "today" } })));
    expect(e.message).toBe(m.lib.NOT_READY);
    // The task readers carry on as before.
    expect(await m.period.taskInvoicesOnly([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  test("the live SQL file makes the tables, the CHECK and each person's rate on the rate card", async () => {
    await applyHourlyInvoicingSql();
    m.period.resetHourlyInvoicingReady();
    expect(await m.period.hourlyInvoicingReady()).toBe(true);
    const [ddl] = await q("SELECT sql FROM sqlite_master WHERE name = 'installer_invoice_details'");
    expect(ddl.sql).toContain("installer_invoice_details_claim_check");
    const [item] = await q("SELECT id, unit, restricted FROM labour_rate_items WHERE name = 'Contractor labour — per hour'");
    expect([item.unit, item.restricted]).toEqual(["hour", 1]);
    const [setting] = await q("SELECT value FROM settings WHERE key = 'hourly_labour_item_id'");
    expect(Number(setting.value)).toBe(item.id);
    const rates = await q("SELECT installer_id, amount FROM labour_rates WHERE item_id = ? ORDER BY installer_id", [item.id]);
    expect(rates.map((r) => [r.installer_id, r.amount])).toEqual([HA, HG, HM, HR].map((id) => [id, RATE]));
    // Running the inserts again adds nothing.
    const text = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-12-09-hourly-invoicing.sql"), "utf8");
    for (const p of text.split("--> statement-breakpoint").map((x) => x.trim()).filter((x) => x.startsWith("INSERT"))) await client.execute(p);
    expect((await q("SELECT count(*) AS n FROM labour_rate_items WHERE name = 'Contractor labour — per hour'"))[0].n).toBe(1);
    expect((await q("SELECT count(*) AS n FROM labour_rates WHERE item_id = ?", [item.id]))[0].n).toBe(4);
    expect((await m.lib.mySummary(HA)).readyToInvoice.entries).toBe(0);
  });
});

let A1: { jobId: number; taskId: number; number: number };
let A2: { jobId: number; taskId: number; number: number };
let aSessions: number[] = [];
let aInvoiceId = 0;

describe("1. Three days across two jobs make one invoice by dates", () => {
  test("bulk approve: each through the same checks, a repeated id once only", async () => {
    A1 = await hourlyTask(HA, "Hybrid install");
    A2 = await hourlyTask(HA, "Carpet tiles");
    aSessions = [await worked(HA, A1, "2026-11-09", 7.5), await worked(HA, A2, "2026-11-10", 8), await worked(HA, A1, "2026-11-11", 6.5)];
    const r = await approveAll([...aSessions, aSessions[0]!]);
    expect(r.approved).toEqual(aSessions);
    expect(r.skipped).toEqual([]);
    const rows = await q(`SELECT approved_minutes, rate_base, approved_pay, gst_registered FROM work_sessions WHERE id IN (${aSessions.join(",")}) ORDER BY id`);
    expect(rows.map((x) => [x.approved_minutes, x.rate_base, x.approved_pay, x.gst_registered])).toEqual([
      [450, 47, 352.5, 0],
      [480, 47, 376, 0],
      [390, 47, 305.5, 0],
    ]);
  });

  test("bulk approve leaves what can't be approved, with the reason", async () => {
    const open = await worked(HA, A1, "2026-11-12", 2, { status: "open", endedAt: null });
    const r = await approveAll([open]);
    expect(r.approved).toEqual([]);
    expect(r.skipped).toEqual([{ sessionId: open, reason: "Only finished time can be approved." }]);
    await q("UPDATE work_sessions SET status = 'rejected', ended_at = started_at WHERE id = ?", [open]);
  });

  test("the preview: 22 h x $47 = $1,034.00, no GST, two jobs, nothing claimed", async () => {
    const p = await as(A_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-09", "2026-11-11") }));
    expect(p.canIssue).toBe(true);
    expect(p.entries.map((e: any) => e.id)).toEqual(aSessions);
    expect(p.hours).toBe(22);
    expect([p.subtotal, p.gstAmount, p.total]).toEqual([1034, 0, 1034]);
    expect(p.title).toBe("Invoice");
    expect(p.gstNote).toBe("No GST charged. Not registered for GST.");
    expect(p.jobs.length).toBe(2);
    expect(p.lines.map((l: any) => [l.workDate, l.qty, l.rate, l.total])).toEqual([
      ["2026-11-09", 7.5, 47, 352.5],
      ["2026-11-10", 8, 47, 376],
      ["2026-11-11", 6.5, 47, 305.5],
    ]);
    expect(p.lines[0].description).toContain("Mon 9 Nov");
    expect(p.termsDays).toBe(7);
    expect(p.nextInvoiceNumber).toBe(100);
    expect(await nextNo(HA)).toBe(100);
    expect((await q("SELECT count(*) AS n FROM installer_invoice_sessions"))[0].n).toBe(0);
  });

  test("Issue & send to Terra: one invoice, every entry marked, details, PDF and email", async () => {
    const r = await as(A_LOGIN, () => run<any>(m.hi.issue, { period: dates("2026-11-09", "2026-11-11"), requestKey: newKey() }));
    expect(r.repeated).toBe(false);
    expect(r.sentToTerra).toBe(true);
    expect(r.invoice.invoiceNumber).toBe(100);
    expect(r.invoice.total).toBe(1034);
    expect(r.invoice.label).toBe("Awaiting payment");
    expect([r.invoice.periodFrom, r.invoice.periodTo, r.invoice.termsDays]).toEqual(["2026-11-09", "2026-11-11", 7]);
    aInvoiceId = r.invoice.id;
    expect(await nextNo(HA)).toBe(101);
    const marked = await q(`SELECT invoice_id FROM work_sessions WHERE id IN (${aSessions.join(",")})`);
    expect(marked.every((x) => x.invoice_id === aInvoiceId)).toBe(true);
    const links = await q("SELECT session_id, amount FROM installer_invoice_sessions WHERE invoice_id = ? ORDER BY session_id", [aInvoiceId]);
    expect(links.map((l) => [l.session_id, l.amount])).toEqual([
      [aSessions[0], 352.5],
      [aSessions[1], 376],
      [aSessions[2], 305.5],
    ]);
    const [d] = await q("SELECT kind, sessions_expected, sessions_claimed, due_date FROM installer_invoice_details WHERE invoice_id = ?", [aInvoiceId]);
    expect([d.kind, d.sessions_expected, d.sessions_claimed]).toEqual(["period", 3, 3]);
    const [inv] = await q("SELECT task_title, pdf_key, line_items FROM installer_invoices WHERE id = ?", [aInvoiceId]);
    expect(inv.task_title).toBe("Hourly work 9 Nov 2026 to 11 Nov 2026, 2 jobs");
    expect(inv.pdf_key).toBeTruthy();
    expect(JSON.parse(inv.line_items).length).toBe(3);
    expect(outside.email.map((e) => e.to)).toEqual([m.lib.BILLING_EMAIL, `${HA}@example.invalid`]);
    expect(outside.email[0]!.subject).toContain("Invoice #100");
  });

  test("the same dates again: nothing left to bill, the three show as already invoiced", async () => {
    const p = await as(A_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-09", "2026-11-11") }));
    expect(p.entries).toEqual([]);
    expect(p.billed.map((b: any) => b.invoiceId)).toEqual([aInvoiceId, aInvoiceId, aInvoiceId]);
    expect(p.canIssue).toBe(false);
    expect((await failure(as(A_LOGIN, () => run(m.hi.issue, { period: dates("2026-11-09", "2026-11-11"), requestKey: newKey() })))).message).toBe(
      "There is no approved time in these dates.",
    );
    expect(await nextNo(HA)).toBe(101);
  });

  test("today, this week and future dates", async () => {
    const today = m.lib.periodOf({ kind: "today" }, "2026-11-13");
    expect(today).toEqual({ from: "2026-11-13", to: "2026-11-13" });
    expect(m.lib.periodOf({ kind: "week" }, "2026-11-13")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(m.lib.periodOf({ kind: "week" }, "2026-11-15")).toEqual({ from: "2026-11-09", to: "2026-11-15" });
    expect(m.lib.periodOf(dates("2026-11-01", "2026-11-20"), "2026-11-13")).toEqual({ from: "2026-11-01", to: "2026-11-13" });
    expect(() => m.lib.periodOf(dates("2026-11-14", "2026-11-20"), "2026-11-13")).toThrow("in the future");
    expect(() => m.lib.periodOf(dates("2026-11-12", "2026-11-10"), "2026-11-13")).toThrow("after the end date");
  });
});

let G: { jobId: number; taskId: number; number: number };
let gSessions: number[] = [];

describe("2 and 4. One day on its own, then the rest, with GST", () => {
  test("all three days with GST: $1,034.00 + $103.40 GST = $1,137.40, a Tax Invoice", async () => {
    G = await hourlyTask(HG);
    const G2 = await hourlyTask(HG, "Second job");
    gSessions = [await worked(HG, G, "2026-11-02", 7.5), await worked(HG, G2, "2026-11-03", 8), await worked(HG, G, "2026-11-04", 6.5)];
    expect((await approveAll(gSessions)).approved).toEqual(gSessions);
    const p = await as(G_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-02", "2026-11-04") }));
    expect([p.subtotal, p.gstAmount, p.total]).toEqual([1034, 103.4, 1137.4]);
    expect(p.title).toBe("Tax Invoice");
    expect(p.gstNote).toBe("GST at 10% is included in the total.");
  });

  test("one day ticked: invoiced on its own, the other two stay ready", async () => {
    const one = await as(G_LOGIN, () => run<any>(m.hi.issue, { period: dates("2026-11-02", "2026-11-04"), sessionIds: [gSessions[0]], requestKey: newKey() }));
    expect([one.invoice.subtotal, one.invoice.gstAmount, one.invoice.total]).toEqual([352.5, 35.25, 387.75]);
    expect([one.invoice.periodFrom, one.invoice.periodTo]).toEqual(["2026-11-02", "2026-11-04"]);
    const left = await as(G_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-02", "2026-11-04") }));
    expect(left.entries.map((e: any) => e.id)).toEqual([gSessions[1], gSessions[2]]);
    expect(left.billed.map((b: any) => b.id)).toEqual([gSessions[0]]);
    expect([left.subtotal, left.gstAmount, left.total]).toEqual([681.5, 68.15, 749.65]);
    const rest = await as(G_LOGIN, () => run<any>(m.hi.issue, { period: dates("2026-11-02", "2026-11-04"), requestKey: newKey() }));
    expect(rest.invoice.total).toBe(749.65);
    expect(rest.invoice.invoiceNumber).toBe(one.invoice.invoiceNumber + 1);
    // Together they are exactly the whole: $1,137.40.
    expect(Math.round((one.invoice.total + rest.invoice.total) * 100) / 100).toBe(1137.4);
    const summary = await as(G_LOGIN, () => run<any>(m.hi.summary, {}));
    expect(summary.readyToInvoice.entries).toBe(0);
    expect(summary.awaitingPayment.amount).toBe(1137.4);
  });

  test("a ticked entry that is not his or not ready is simply not on it", async () => {
    const p = await as(G_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-02", "2026-11-04"), sessionIds: [aSessions[0]] }));
    expect(p.entries).toEqual([]);
    expect(p.canIssue).toBe(false);
  });

  test("GST on his card and his pay terms disagree: the invoice waits for the office", async () => {
    const t = await hourlyTask(HM);
    const s = await worked(HM, t, "2026-11-05", 4);
    expect((await approveAll([s])).approved).toEqual([s]);
    const p = await as(M_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-05", "2026-11-05") }));
    expect(p.canIssue).toBe(false);
    expect(p.blockedReason).toBe("Your GST registration on file does not match your hourly pay terms. Ask Terra office to confirm your GST before you invoice.");
    expect((await failure(as(M_LOGIN, () => run(m.hi.issue, { period: dates("2026-11-05", "2026-11-05"), requestKey: newKey() })))).message).toContain("confirm your GST");
    expect(await countInvoices(HM)).toBe(0);
  });

  test("days approved under different GST terms are never mixed on one invoice", () => {
    const inst = { gstRegistered: true } as any;
    expect(m.lib.gstCheck(inst, [{ gstRegistered: true }, { gstRegistered: false }]).block).toContain("some not");
    expect(m.lib.gstCheck(inst, [{ gstRegistered: true }]).block).toBeNull();
  });
});

describe("3. Anything left off is explained", () => {
  test("waiting for approval, correction asked, still running, rate to confirm, not paid time", async () => {
    const t = await hourlyTask(HA, "Reasons");
    const waiting = await worked(HA, t, "2026-10-26", 3);
    const corr = await worked(HA, t, "2026-10-27", 3, { correctionRequestedAt: new Date(), correctionNote: "Forgot to finish" });
    const zero = await worked(HA, t, "2026-10-28", 3, { status: "approved", payable: true, approvedMinutes: 180, rateBase: 0, approvedPay: 0, approvedAt: new Date(), payLines: "[]" });
    const unpaid = await worked(HA, t, "2026-10-29", 3, { status: "approved", payable: false, approvedMinutes: 180, rateBase: 47, approvedPay: 0, approvedAt: new Date(), payLines: "[]" });
    const p = await as(A_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-10-26", "2026-10-30") }));
    const why = Object.fromEntries(p.held.map((h: any) => [h.id, h.reason]));
    expect(why).toEqual({
      [waiting]: "Waiting for Terra office to approve.",
      [corr]: "Correction asked for. Waiting for Terra office to check it.",
      [zero]: "Contractor labour — per hour: Rate to confirm.",
      [unpaid]: "Approved as not paid time.",
    });
    expect(JSON.stringify(p)).not.toContain("$0.00");
    expect(p.canIssue).toBe(false);
    expect(p.blockedReason).toBe("Nothing in these dates is ready to invoice yet.");
    const summary = await as(A_LOGIN, () => run<any>(m.hi.summary, {}));
    expect(summary.awaitingApproval.entries).toBe(2);
    expect(summary.readyToInvoice.entries).toBe(0);
  });

  test("a time entry still running", async () => {
    const t = await hourlyTask(HR, "Running");
    const open = await worked(HR, t, "2026-10-26", 1, { status: "open", endedAt: null });
    const p = await as(R_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-10-26", "2026-10-26") }));
    expect(p.held.map((h: any) => [h.id, h.reason])).toEqual([[open, "Still running. Finish work first."]]);
    await q("UPDATE work_sessions SET status = 'rejected', ended_at = started_at WHERE id = ?", [open]);
  });

  test("set up missing: no invoice numbering, no bank details", async () => {
    await q("UPDATE installers SET next_invoice_number = NULL WHERE id = ?", [HR]);
    let p = await as(R_LOGIN, () => run<any>(m.hi.preview, { period: { kind: "today" } }));
    expect(p.blockedReason).toContain("invoice numbering");
    await q("UPDATE installers SET next_invoice_number = 400, bank_bsb = NULL WHERE id = ?", [HR]);
    p = await as(R_LOGIN, () => run<any>(m.hi.preview, { period: { kind: "today" } }));
    expect(p.blockedReason).toContain("bank details");
    await q("UPDATE installers SET bank_bsb = '000-000' WHERE id = ?", [HR]);
  });
});

describe("5. Double taps, retries and two phones never bill twice", () => {
  let t: { jobId: number; taskId: number; number: number };
  const D = dates("2026-10-12", "2026-10-14");

  test("a retry with the same key gives back the same invoice, no new number", async () => {
    t = await hourlyTask(HR, "Retries");
    const ids = [await worked(HR, t, "2026-10-12", 5), await worked(HR, t, "2026-10-13", 5)];
    await approveAll(ids);
    const key = newKey();
    const first = await as(R_LOGIN, () => run<any>(m.hi.issue, { period: D, requestKey: key }));
    const again = await as(R_LOGIN, () => run<any>(m.hi.issue, { period: D, requestKey: key }));
    expect(first.repeated).toBe(false);
    expect(again.repeated).toBe(true);
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(await nextNo(HR)).toBe(401);
    expect(await countInvoices(HR)).toBe(1);
  });

  test("a double tap (two at once, same key): one invoice", async () => {
    await approveAll([await worked(HR, t, "2026-10-14", 4)]);
    const key = newKey();
    const both = await as(R_LOGIN, () => Promise.all([m.lib.issuePeriod(HR, { period: D, requestKey: key }), m.lib.issuePeriod(HR, { period: D, requestKey: key })]));
    expect(both[0].invoice.id).toBe(both[1].invoice.id);
    expect(both.filter((b) => b.repeated).length).toBe(1);
    expect(await countInvoices(HR)).toBe(2);
  });

  test("two phones at once (different keys): one invoice, the other is told nothing was issued", async () => {
    await approveAll([await worked(HR, t, "2026-10-15", 3)]);
    const P = dates("2026-10-15", "2026-10-15");
    const before = await nextNo(HR);
    const out = await Promise.allSettled([m.lib.issuePeriod(HR, { period: P, requestKey: newKey() }), m.lib.issuePeriod(HR, { period: P, requestKey: newKey() })]);
    expect(out.filter((o) => o.status === "fulfilled").length).toBe(1);
    const lost = out.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason.code).toBe("CONFLICT");
    expect(lost.reason.message).toContain("Nothing was issued");
    expect(await nextNo(HR)).toBe(before + 1);
    expect((await q("SELECT count(*) AS n FROM installer_invoice_sessions l JOIN work_sessions w ON w.id = l.session_id WHERE w.work_date = '2026-10-15' AND w.installer_id = ?", [HR]))[0].n).toBe(1);
  });

  test("time changed between the preview and the write: the whole invoice is refused", async () => {
    const s = await worked(HR, t, "2026-10-16", 6);
    await approveAll([s]);
    const c = m.db.$client as any;
    const orig = c.batch;
    c.batch = async (...a: unknown[]) => {
      c.batch = orig;
      // The office changes it a moment before the write lands.
      await client.execute({ sql: "UPDATE work_sessions SET approved_minutes = 300, approved_pay = 235 WHERE id = ?", args: [s] });
      return orig.apply(c, a);
    };
    const before = await nextNo(HR);
    try {
      const e = await failure(m.lib.issuePeriod(HR, { period: dates("2026-10-16", "2026-10-16"), requestKey: newKey() }));
      expect(e.code).toBe("CONFLICT");
    } finally {
      c.batch = orig;
    }
    expect(await nextNo(HR)).toBe(before);
    expect((await q("SELECT invoice_id FROM work_sessions WHERE id = ?", [s]))[0].invoice_id).toBeNull();
    expect((await q("SELECT count(*) AS n FROM installer_invoice_sessions WHERE session_id = ?", [s]))[0].n).toBe(0);
    // Looked at again, it is still there to invoice, as it now stands.
    const p = await m.lib.previewPeriod(HR, { period: dates("2026-10-16", "2026-10-16") });
    expect(p.entries.map((e: any) => [e.id, e.minutes, e.amount])).toEqual([[s, 300, 235]]);
  });

  test("the CHECK refuses details that claim fewer entries than shown", async () => {
    const e = await failure(
      client.execute({
        sql: "INSERT INTO installer_invoice_details (invoice_id, installer_id, kind, sessions_expected, sessions_claimed, created_at, updated_at) VALUES (?, ?, 'period', 2, 1, 0, 0)",
        args: [aInvoiceId, HA],
      }),
    );
    expect(String(e.message)).toMatch(/CHECK|UNIQUE/);
    const e2 = await failure(client.execute({ sql: "INSERT INTO installer_invoice_sessions (invoice_id, session_id, task_id, job_id, work_date, created_at, updated_at) VALUES (?, ?, 1, 1, '2026-11-09', 0, 0)", args: [aInvoiceId, aSessions[0]!] }));
    expect(String(e2.message)).toContain("UNIQUE");
  });
});

describe("6. Rate changes and corrections", () => {
  test("a new rate from a date: earlier approved work keeps $47, later work is at the new rate, lines never merged", async () => {
    const t = await hourlyTask(HR, "Rate change");
    const early = await worked(HR, t, "2026-09-28", 2);
    await approveAll([early]);
    const [item] = await q("SELECT id FROM labour_rate_items WHERE name = 'Contractor labour — per hour'");
    await q("UPDATE labour_rates SET effective_to = '2026-09-29' WHERE item_id = ? AND installer_id = ?", [item.id, HR]);
    await q("INSERT INTO labour_rates (item_id, installer_id, amount, effective_from, created_by_name, created_at, updated_at) VALUES (?, ?, 50, '2026-09-30', 'Test', 0, 0)", [item.id, HR]);
    const late = await worked(HR, t, "2026-09-30", 2);
    await approveAll([late]);
    const p = await m.lib.previewPeriod(HR, { period: dates("2026-09-28", "2026-09-30") });
    expect(p.lines.map((l: any) => [l.workDate, l.rate, l.total])).toEqual([
      ["2026-09-28", 47, 94],
      ["2026-09-30", 50, 100],
    ]);
    expect(p.subtotal).toBe(194);
  });

  test("a correction asked on approved time sends it back for approval; on invoiced time it is refused", async () => {
    const t = await hourlyTask(HR, "Correction");
    const s = await worked(HR, t, "2026-09-21", 3);
    await approveAll([s]);
    await as(R_LOGIN, () => run(m.hourly.requestCorrection, { sessionId: s, note: "Finished at 2, not 3" }));
    const [row] = await q("SELECT status, approved_pay, correction_note FROM work_sessions WHERE id = ?", [s]);
    expect([row.status, row.approved_pay, row.correction_note]).toEqual(["recorded", null, "Finished at 2, not 3"]);
    const p = await m.lib.previewPeriod(HR, { period: dates("2026-09-21", "2026-09-21") });
    expect(p.held.map((h: any) => h.reason)).toEqual(["Correction asked for. Waiting for Terra office to check it."]);
    // Approved again by the office, it is ready once more.
    await approveAll([s]);
    expect((await m.lib.previewPeriod(HR, { period: dates("2026-09-21", "2026-09-21") })).entries.length).toBe(1);

    const e = await failure(as(A_LOGIN, () => run(m.hourly.requestCorrection, { sessionId: aSessions[0], note: "Wrong day" })));
    expect(e.message).toContain("already on your invoice");
    const u = await failure(run(m.hourly.unapprove, { sessionId: aSessions[0], reason: "Testing" }));
    expect(u.message).toContain("on a contractor invoice already");
  });
});

describe("7. Privacy", () => {
  test("he sees only his own invoices, PDFs and time", async () => {
    const mine = await as(G_LOGIN, () => run<any[]>(m.hi.invoices, {}));
    expect(mine.length).toBe(2);
    expect(mine.some((i) => i.id === aInvoiceId)).toBe(false);
    expect((await failure(as(G_LOGIN, () => run(m.hi.downloadUrl, { invoiceId: aInvoiceId })))).message).toBe("Invoice not found");
    expect((await failure(as(G_LOGIN, () => run(m.hi.resend, { invoiceId: aInvoiceId })))).message).toBe("Invoice not found");
    const p = await as(G_LOGIN, () => run<any>(m.hi.preview, { period: dates("2026-11-09", "2026-11-11") }));
    expect([...p.entries, ...p.held, ...p.billed]).toEqual([]);
    expect((await as(A_LOGIN, () => run<any>(m.hi.downloadUrl, { invoiceId: aInvoiceId }))).url).toContain("storage.example.invalid");
  });

  test("office screens are closed to field logins; amounts need costs access", async () => {
    expect((await failure(as(A_LOGIN, () => run(m.hi.balances, { invoiceIds: [aInvoiceId] })))).code).toBe("FORBIDDEN");
    expect((await failure(as(A_LOGIN, () => run(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 1, paidOn: "2026-11-12" })))).code).toBe("FORBIDDEN");
    const noCosts = await as(OFFICE_NO_COSTS, () => run<any[]>(m.hi.invoiceEntries, { invoiceId: aInvoiceId }));
    expect(noCosts.length).toBe(3);
    expect(noCosts.every((e) => e.amount === null)).toBe(true);
    const admin = await run<any[]>(m.hi.invoiceEntries, { invoiceId: aInvoiceId });
    expect(admin.map((e) => e.amount).sort()).toEqual([305.5, 352.5, 376]);
    expect((await failure(as(OFFICE_NO_COSTS, () => run(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 1, paidOn: "2026-11-12" })))).message).toBe("Costs access required");
  });
});

describe("8. Payments", () => {
  test("Awaiting payment, then Part paid, then Paid", async () => {
    const [b0] = await run<any[]>(m.hi.balances, { invoiceIds: [aInvoiceId] });
    expect([b0.label, b0.balance, b0.kind, b0.dueDate != null]).toEqual(["Awaiting payment", 1034, "period", true]);
    const part = await run<any>(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 500, paidOn: "2026-11-12", note: "Xero part payment" });
    expect([part.label, part.paid, part.balance]).toEqual(["Part paid", 500, 534]);
    expect((await failure(run(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 600, paidOn: "2026-11-12" }))).message).toBe("That is more than the $534.00 left on this invoice.");
    const done = await run<any>(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 534, paidOn: "2026-11-13" });
    expect([done.label, done.balance]).toEqual(["Paid", 0]);
    expect((await q("SELECT status FROM installer_invoices WHERE id = ?", [aInvoiceId]))[0].status).toBe("paid");
    expect((await failure(run(m.hi.recordPayment, { invoiceId: aInvoiceId, amount: 1, paidOn: "2026-11-13" }))).message).toBe("This invoice is already paid in full.");
    const mine = (await as(A_LOGIN, () => run<any[]>(m.hi.invoices, {}))).find((i) => i.id === aInvoiceId)!;
    expect([mine.label, mine.paid, mine.payments.length]).toEqual(["Paid", 1034, 2]);
    const s = await as(A_LOGIN, () => run<any>(m.hi.summary, {}));
    expect(s.paid.amount).toBe(1034);
  });

  test("balanceOf on its own", () => {
    expect(m.lib.balanceOf({ total: 100, status: "submitted" }, [])).toEqual({ state: "awaiting_payment", label: "Awaiting payment", paid: 0, balance: 100 });
    expect(m.lib.balanceOf({ total: 100, status: "submitted" }, [{ amount: 40 }])).toEqual({ state: "part_paid", label: "Part paid", paid: 40, balance: 60 });
    expect(m.lib.balanceOf({ total: 100, status: "paid" }, [])).toEqual({ state: "paid", label: "Paid", paid: 100, balance: 0 });
  });
});

describe("9. The task invoice and invoices by dates", () => {
  test("an invoice by dates is not the task's invoice, and its time is never billed on the task", async () => {
    expect(await m.period.taskInvoicesOnly([{ id: aInvoiceId }, { id: 999999 }])).toEqual([{ id: 999999 }]);
    const links = await m.period.linksForTasks([A1.taskId]);
    expect(links.map((l) => l.sessionId).sort((a, b) => a - b)).toEqual([aSessions[0], aSessions[2]]);
    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [A1.taskId]);
    const before = await countInvoices(HA);
    await failure(as(A_LOGIN, () => run(m.invoices.submit, { taskId: A1.taskId })));
    expect(await countInvoices(HA)).toBe(before);
    const marked = await q(`SELECT invoice_id FROM work_sessions WHERE id IN (${aSessions[0]}, ${aSessions[2]})`);
    expect(marked.every((x) => x.invoice_id === aInvoiceId)).toBe(true);
  });

  test("time billed on the task invoice is linked too, and never goes on an invoice by dates", async () => {
    const t = await hourlyTask(HG, "Task invoice");
    const s = await worked(HG, t, "2026-10-05", 4);
    await approveAll([s]);
    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [t.taskId]);
    const inv = await as(G_LOGIN, () => run<any>(m.invoices.submit, { taskId: t.taskId }));
    expect(inv.total).toBe(206.8);
    expect((await q("SELECT invoice_id FROM installer_invoice_sessions WHERE session_id = ?", [s]))[0].invoice_id).toBe(inv.id);
    const p = await m.lib.previewPeriod(HG, { period: dates("2026-10-05", "2026-10-05") });
    expect(p.entries).toEqual([]);
    expect(p.billed.map((b: any) => b.invoiceId)).toEqual([inv.id]);
  });

  test("nothing left the machine", () => {
    expect(blocked).toEqual([]);
  });
});
