/**
 * Staged jobs and progress payments (Damien, 12 Nov 2026).
 *
 *   bun test scripts/staged-jobs.test.ts      (from packages/web)
 *
 * Runs the real staging, billing, claim, guard and crew code on a throwaway
 * SQLite file built from the schema. Sign in is faked. Office alerts, pushes,
 * emails and file uploads are caught, and every network call is blocked, so
 * nothing leaves the machine. People are "Installer A" and "Installer B".
 *
 * Brief section 8, one describe block each:
 *   1  Two-stage carpet tile job a month apart, deposit paid: 6600 + 2200 - 3300 = 5500, 2200 left
 *   2  The same with the deposit unpaid: 8800 owing across two invoices, the deposit never charged twice
 *   3  Kitchen hold on a bundled price (188014 shape): the split needs approval, $1,050 = $800 + $250
 *   4  Selling and pay kept apart: quote lines only, never costs, no prices on Terra Crew
 *   5  More than two stages, a typed labour amount, a shortfall moved on
 *   6  A claim already submitted or paid, and a whole-task claim before staging
 *   7  Installer change: the first keeps his finished stage; a rate change needs the office's reason
 *   8  Double clicks and races: raise, claim, save, finish
 *   9  Final reconciliation, variations, over-billing, status, care and the forecast
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "staged-jobs-"));
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
const outside = { email: [] as unknown[], stored: [] as string[], push: 0, alerts: [] as string[] };

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "test-admin", name: "Test Admin", email: "admin@example.invalid" };
const A_LOGIN: Who = { id: "test-a", name: "Installer A", email: "a@example.invalid" };
const B_LOGIN: Who = { id: "test-b", name: "Installer B", email: "b@example.invalid" };
const H_LOGIN: Who = { id: "test-h", name: "Hourly C", email: "h@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

const INST_A = 19; // GST registered, like the live installer on both real jobs
const INST_B = 24; // not GST registered
const HOURLY = 18;
const EMP = 30;
const ST = { lead: 1, quoted: 2, won: 3, scheduled: 4, inProgress: 5, complete: 6, invoiced: 7, paid: 8, cancelled: 9, part: 10 };

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  orm: typeof import("drizzle-orm");
  stages: typeof import("../src/api/routes/stages").stages;
  invoices: typeof import("../src/api/routes/installerInvoices").installerInvoices;
  jobs: typeof import("../src/api/routes/jobs").jobs;
  sj: typeof import("../src/api/lib/staged-jobs");
  sb: typeof import("../src/api/lib/staged-billing");
  guard: typeof import("../src/api/lib/staged-guard");
  finalInv: typeof import("../src/api/lib/final-invoice");
  jobStage: typeof import("../src/api/lib/job-stage");
  care: typeof import("../src/api/lib/care-engine");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in staged-jobs tests: ${String(input)}`);
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
    pushToInstaller: async () => {
      outside.push++;
      return 0;
    },
    pushToOffice: async () => 0,
  }));
  const realGoogle = await import("../src/api/lib/google-calendar");
  mock.module("../src/api/lib/google-calendar", () => ({ ...realGoogle, freeBusy: async () => [] }));
  const realEmail = await import("../src/api/lib/email");
  mock.module("../src/api/lib/email", () => ({
    ...realEmail,
    sendEmail: async (a: unknown) => {
      outside.email.push(a);
      return { ok: false, reason: "test" };
    },
  }));
  const realS3 = await import("../src/api/lib/s3");
  mock.module("../src/api/lib/s3", () => ({
    ...realS3,
    putObject: async (key: string) => {
      outside.stored.push(key);
    },
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
    stages: (await import("../src/api/routes/stages")).stages,
    invoices: (await import("../src/api/routes/installerInvoices")).installerInvoices,
    jobs: (await import("../src/api/routes/jobs")).jobs,
    sj: await import("../src/api/lib/staged-jobs"),
    sb: await import("../src/api/lib/staged-billing"),
    guard: await import("../src/api/lib/staged-guard"),
    finalInv: await import("../src/api/lib/final-invoice"),
    jobStage: await import("../src/api/lib/job-stage"),
    care: await import("../src/api/lib/care-engine"),
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
const OFFICE = { name: "Test Admin", role: "admin" };

/* --------------------------------- fixtures --------------------------------- */

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true });
  for (const [id, name, sort, stage] of [
    [ST.lead, "Lead", 0, "open"],
    [ST.quoted, "Quoted", 1, "open"],
    [ST.won, "Won", 2, "won"],
    [ST.scheduled, "Scheduled", 3, "scheduled"],
    [ST.inProgress, "In Progress", 4, "active"],
    [ST.complete, "Complete", 5, "complete"],
    [ST.invoiced, "Invoiced", 6, "complete"],
    [ST.paid, "Paid", 7, "closed"],
    [ST.cancelled, "Cancelled", 8, "closed"],
  ] as const) {
    await db.insert(schema.jobStatuses).values({ id, name, sortOrder: sort, stage } as any);
  }
  // The new status, by the very statement in sql/2026-12-08-staged-jobs.sql. Run twice: the guard adds it once.
  const sqlFile = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-12-08-staged-jobs.sql"), "utf8");
  const addStatus = sqlFile.split("--> statement-breakpoint").map((x) => x.trim()).find((x) => x.startsWith("INSERT INTO job_statuses"))!;
  await client.execute(addStatus);
  await client.execute(addStatus);
  const bank = { bankBsb: "000-000", bankAccountNumber: "12345678", bankAccountName: "Test Account", abn: "51 824 753 556", abnStatus: "Active", active: true };
  for (const [id, name, gst, workerType, next] of [
    [INST_A, "Installer A", true, null, 100],
    [INST_B, "Installer B", false, null, 500],
    [HOURLY, "Hourly C", false, null, 700],
    [EMP, "Employee D", false, "employee", null],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, gstRegistered: gst, workerType, nextInvoiceNumber: next, ...bank } as any);
  }
  for (const [login, installerId] of [
    [A_LOGIN, INST_A],
    [B_LOGIN, INST_B],
    [H_LOGIN, HOURLY],
  ] as const) {
    await db.insert(schema.profiles).values({ userId: login!.id, name: login!.name, email: login!.email, role: "field", installerId } as any);
  }
}

type QLine = { kind: string; lineType: "material" | "labour"; description: string; qty: number; unit: string; total: number };
type TaskIn = {
  installerId: number | null;
  title: string;
  breakdown?: { name: string; unit: string; qty: number; rate: number | null; total: number }[];
  payType?: string;
  status?: string;
  labourCost?: number;
};

let quoteNo = 9000;
async function makeJob(o: {
  number: number;
  subtotal: number;
  total: number;
  bundled?: boolean;
  lines: QLine[];
  deposit?: { total: number; paid: number };
  tasks: TaskIn[];
  value?: number;
  parentJobId?: number | null;
}) {
  const { db } = m;
  const [job] = await db
    .insert(schema.jobs)
    .values({ number: o.number, value: o.value ?? o.total, statusId: ST.scheduled, parentJobId: o.parentJobId ?? null } as any)
    .returning();
  const [quote] = await db
    .insert(schema.quotes)
    .values({
      number: quoteNo++,
      version: 1,
      jobId: job!.id,
      status: "accepted",
      subtotal: o.subtotal,
      total: o.total,
      bundleMode: o.bundled ? "combined" : "split",
      layout: o.bundled ? "auto" : "itemised",
    } as any)
    .returning();
  const itemIds: number[] = [];
  let i = 0;
  for (const l of o.lines) {
    const [it] = await db
      .insert(schema.quoteItems)
      .values({ quoteId: quote!.id, kind: l.kind, lineType: l.lineType, description: l.description, qty: l.qty, unit: l.unit, total: l.total, sortOrder: i++ } as any)
      .returning();
    itemIds.push(it!.id);
  }
  if (o.deposit) {
    await db.insert(schema.invoices).values({
      number: `IQ${o.number}-1`,
      jobNumber: o.number,
      seq: 1,
      jobId: job!.id,
      quoteId: quote!.id,
      kind: "deposit",
      label: "Deposit",
      status: o.deposit.paid >= o.deposit.total ? "paid" : "sent",
      subtotal: Math.round((o.deposit.total / 1.1) * 100) / 100,
      gst: Math.round((o.deposit.total - o.deposit.total / 1.1) * 100) / 100,
      total: o.deposit.total,
      amountPaid: o.deposit.paid,
    } as any);
  }
  const taskIds: number[] = [];
  let seq = 1;
  for (const t of o.tasks) {
    const [row] = await db
      .insert(schema.jobTasks)
      .values({
        jobId: job!.id,
        title: t.title,
        seq: seq++,
        assignedInstallerId: t.installerId,
        status: t.status ?? "assigned",
        payType: t.payType ?? "per_job",
        payAmount: t.breakdown ? 0 : null,
        labourBreakdown: t.breakdown ? JSON.stringify(t.breakdown) : null,
        labourCost: t.labourCost ?? null,
        scheduledDate: "2026-11-16",
      } as any)
      .returning();
    taskIds.push(row!.id);
  }
  return { jobId: job!.id, quoteId: quote!.id, itemIds, taskIds };
}

/** The 6600 / 4400 carpet tile job of the worked example: 200 m2, a $3,300 deposit. */
async function carpetTileJob(number: number, depositPaid: number) {
  return makeJob({
    number,
    subtotal: 10000,
    total: 11000,
    lines: [
      { kind: "supply", lineType: "material", description: "Carpet tiles", qty: 200, unit: "m2", total: 5900 },
      { kind: "supplier_charge", lineType: "material", description: "Freight", qty: 1, unit: "each", total: 100 },
      { kind: "labour", lineType: "labour", description: "Carpet tile install", qty: 200, unit: "m2", total: 4000 },
    ],
    deposit: { total: 3300, paid: depositPaid },
    tasks: [{ installerId: INST_A, title: "Carpet tiles", breakdown: [{ name: "Carpet tile install", unit: "m2", qty: 200, rate: 10, total: 2000 }], labourCost: 9999 }],
  });
}

/** Setup input from the real propose step, then the office's own entries. */
async function setup(jobId: number, kind: "planned" | "hold", f: (p: any) => void) {
  const p = await run<any>(m.stages.propose, { jobId, kind });
  p.requestedBy = "The client";
  p.requestedOn = "2026-11-12";
  p.arrangement = "Stage 1 now, the rest in a month";
  f(p);
  return p;
}
const confirm = (planId: number) => run(m.stages.confirm, { planId, name: "The client", on: "2026-11-12", how: "email", text: "Yes, go ahead in two stages." });
const card = (jobId: number) => run<any>(m.stages.forJob, { jobId });
const invoiceCount = async (jobId: number) => Number((await q("SELECT count(*) n FROM invoices WHERE job_id = ? AND status <> 'void'", [jobId]))[0].n);
const statusOf = async (jobId: number) => Number((await q("SELECT status_id s FROM jobs WHERE id = ?", [jobId]))[0].s);

/* ---------------------------------- checks ---------------------------------- */

describe("0. The new status", () => {
  test("added once, stage active, so Complete-only steps (care, reviews, Paid) never see it", async () => {
    expect(await q("SELECT id, stage, sort_order FROM job_statuses WHERE name = 'Part complete, awaiting client/builder'")).toEqual([{ id: ST.part, stage: "active", sort_order: 5 }] as any);
  });
});

describe("1. Two-stage carpet tile job a month apart, deposit paid", () => {
  let J: Awaited<ReturnType<typeof carpetTileJob>>;
  let planId = 0;
  const quoteBefore: any[] = [];

  test("setup: the split comes off the quote's own lines, and preview writes nothing", async () => {
    J = await carpetTileJob(880001, 3300);
    quoteBefore.push(...(await q("SELECT id, status, subtotal, total FROM quotes WHERE id = ?", [J.quoteId])), ...(await q("SELECT id, total, qty FROM quote_items WHERE quote_id = ? ORDER BY id", [J.quoteId])));
    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-20";
      p.stages[0].lines[0].qty = 100;
      p.stages[0].pay[0].qty = 100;
      p.stages[1].plannedDate = "2026-12-21";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 100;
      p.stages[1].pay[0].qty = 100;
    });
    const pv = await run<any>(m.stages.preview, input);
    expect(pv.built.issues).toEqual([]);
    expect(pv.split.materialsInc).toBe(6600);
    expect(pv.split.labourInc).toBe(4400);
    expect(pv.split.needsApproval).toBe(false);
    expect(pv.built.stages.map((s: any) => s.labourInc)).toEqual([2200, 2200]);
    expect(pv.built.stages.map((s: any) => s.payTotal)).toEqual([1000, 1000]);
    expect(pv.preview.rows.map((r: any) => r.row)).toEqual(["scope", "materials", "labour", "pay"]);
    expect(pv.preview.rows.find((r: any) => r.row === "materials").current).toContain("$6,600.00");
    expect(await q("SELECT count(*) n FROM job_stage_plans WHERE job_id = ?", [J.jobId])).toEqual([{ n: 0 }] as any);

    planId = (await run<any>(m.stages.save, input)).planId;
    expect(planId).toBeGreaterThan(0);
  });

  test("a draft holds nothing back, and agreeing needs the customer's written confirmation", async () => {
    expect(await m.guard.openStaging(J.jobId)).toBeNull();
    expect((await failure(run(m.stages.agree, { planId }))).message).toContain("written confirmation");
    await confirm(planId);
    expect((await run<any>(m.stages.agree, { planId })).status).toBe("agreed");
    const [p] = await q("SELECT confirmed_by_name, confirmed_how, confirmation_text FROM job_stage_plans WHERE id = ?", [planId]);
    expect(p).toEqual({ confirmed_by_name: "The client", confirmed_how: "email", confirmation_text: "Yes, go ahead in two stages." });
  });

  test("the planned wording is the brief's, word for word", async () => {
    const c = await card(J.jobId);
    expect(c.wording.planned).toStartWith("As the work is being split into stages at your request, payment for the full material amount");
    expect(c.wording.hold).toStartWith("As the remaining work is being held until your site is ready");
  });

  test("the installer can't finish the task on his phone while a later stage is still to do", async () => {
    const [t] = await m.db.select().from(schema.jobTasks).where(m.orm.eq(schema.jobTasks.id, J.taskIds[0]!));
    expect(await m.guard.stagedFinishBlock(t!)).toContain("being done in stages");
  });

  test("worked example: stage 1 done, 6600 + 2200 = 8800, less the 3300 deposit = 5500, 2200 left", async () => {
    const c0 = await card(J.jobId);
    const s1 = c0.stages[0];
    const done = await run<any>(m.stages.completeStage, { stageId: s1.id, completedOn: "2026-11-20" });
    expect(done.openLeft).toBe(1);
    const b = (await card(J.jobId)).billing;
    expect(b.target).toBe(8800);
    expect(b.alreadyInvoiced).toBe(3300);
    expect(b.paymentsReceived).toBe(3300);
    expect(b.outstandingExisting).toBe(0);
    expect(b.newInvoice).toBe(5500);
    expect(b.remainingAfter).toBe(2200);
    expect(b.overBilledBy).toBe(0);
    expect(b.kind).toBe("stage");
    expect(await statusOf(J.jobId)).toBe(ST.part);
  });

  test("raise: one invoice for 5500, and a double click gives back the same invoice", async () => {
    const seq = (await card(J.jobId)).plan.invoiceSeq;
    const first = await run<any>(m.stages.raiseInvoice, { planId, expectedSeq: seq });
    expect(first.already).toBe(false);
    expect(first.invoice.total).toBe(5500);
    const again = await run<any>(m.stages.raiseInvoice, { planId, expectedSeq: seq });
    expect(again.already).toBe(true);
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(await invoiceCount(J.jobId)).toBe(2);
    const [inv] = await q("SELECT kind, status, xero_status FROM invoices WHERE id = ?", [first.invoice.id]);
    // Raised only. Emailing it and Xero stay on the Client invoices card.
    expect(inv.kind).toBe("stage");
    expect(inv.xero_status).toBeNull();
    expect(outside.email.length).toBe(0);
    const b = (await card(J.jobId)).billing;
    expect(b.newInvoice).toBe(0);
    expect(b.remainingAfter).toBe(2200);
  });

  test("no Complete, Invoiced, Paid or Final while work remains, and no care or review email", async () => {
    for (const s of [ST.complete, ST.invoiced, ST.paid]) {
      expect((await failure(run(m.jobs.update, { id: J.jobId, statusId: s }))).message).toContain("being done in stages");
    }
    expect((await failure(m.finalInv.raiseJobInvoice({ jobId: J.jobId, kind: "final", actor: OFFICE } as any))).message).toContain("being done in stages");
    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [J.taskIds[0]!]);
    expect(await m.jobStage.syncJobFromTasks(J.jobId, OFFICE as any)).toBeNull();
    await q("UPDATE job_tasks SET status = 'assigned' WHERE id = ?", [J.taskIds[0]!]);
    expect(await m.care.completedStatusIds()).not.toContain(ST.part);
    expect(await statusOf(J.jobId)).toBe(ST.part);
  });

  test("the forecast keeps the remaining labour on the return date", async () => {
    const dates = await m.guard.stagedForecastDates([J.jobId]);
    expect(dates.get(J.jobId)).toEqual({ date: "2026-12-21", basis: "remaining stage expected 2026-12-21" });
  });

  test("installer pay: approve stage 1, he claims $1,000 + GST, and only that", async () => {
    const c = await card(J.jobId);
    const blockedBefore = await as(A_LOGIN, () => run<any>(m.invoices.preview, { taskId: J.taskIds[0] }));
    expect(blockedBefore.canSubmit).toBe(false);
    expect(blockedBefore.blockedReason).toContain("Nothing to claim yet");
    const ap = await run<any>(m.stages.approvePay, { stageId: c.stages[0].id });
    expect(ap.total).toBe(1000);
    const pv = await as(A_LOGIN, () => run<any>(m.invoices.preview, { taskId: J.taskIds[0] }));
    expect(pv.canSubmit).toBe(true);
    expect(pv.subtotal).toBe(1000);
    expect(pv.total).toBe(1100);
    const inv = await as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId: J.taskIds[0] }));
    expect(inv.subtotal).toBe(1000);
    expect(inv.part).toBe(1);
  });

  test("stage 2: the Final is the 2200 left, and the books close at the contract total", async () => {
    const c = await card(J.jobId);
    const s2 = c.stages[1];
    await run(m.stages.completeStage, { stageId: s2.id, completedOn: "2026-12-21" });
    const b = (await card(J.jobId)).billing;
    expect(b.allStagesDone).toBe(true);
    expect(b.kind).toBe("final");
    expect(b.newInvoice).toBe(2200);
    const r = await run<any>(m.stages.raiseInvoice, { planId, expectedSeq: (await card(J.jobId)).plan.invoiceSeq });
    expect(r.invoice.kind).toBe("final");
    expect(r.invoice.total).toBe(2200);
    const after = await card(J.jobId);
    expect(after.billing.alreadyInvoiced).toBe(11000);
    expect(after.billing.remainingAfter).toBe(0);
    expect(after.reconciliation.ok).toBe(true);
    const [plan] = await q("SELECT status FROM job_stage_plans WHERE id = ?", [planId]);
    expect(plan.status).toBe("complete");
    // The task is not finished on the phone yet, so the job goes back to In Progress, not Complete.
    expect(await statusOf(J.jobId)).toBe(ST.inProgress);
  });

  test("the second claim is stage 2 only, part 2: $1,000 + $1,000 = the $2,000 agreed", async () => {
    const c = await card(J.jobId);
    await run(m.stages.approvePay, { stageId: c.stages[1].id });
    const inv = await as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId: J.taskIds[0] }));
    expect(inv.part).toBe(2);
    expect(inv.subtotal).toBe(1000);
    const rec = (await card(J.jobId)).reconciliation.pay[0];
    expect(rec).toMatchObject({ agreedPay: 2000, inStages: 2000, approved: 2000, claimed: 2000, claimable: 0, ok: true });
  });

  test("the accepted quote was never rewritten", async () => {
    const now = [...(await q("SELECT id, status, subtotal, total FROM quotes WHERE id = ?", [J.quoteId])), ...(await q("SELECT id, total, qty FROM quote_items WHERE quote_id = ? ORDER BY id", [J.quoteId]))];
    expect(now).toEqual(quoteBefore);
  });
});

describe("2. The same job with the deposit unpaid", () => {
  test("8800 owing across two invoices, the deposit credited and never charged twice", async () => {
    const J = await carpetTileJob(880002, 0);
    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-20";
      p.stages[0].lines[0].qty = 100;
      p.stages[0].pay[0].qty = 100;
      p.stages[1].plannedDate = "2026-12-21";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 100;
      p.stages[1].pay[0].qty = 100;
    });
    const { planId } = await run<any>(m.stages.save, input);
    await confirm(planId);
    await run(m.stages.agree, { planId });
    await run(m.stages.completeStage, { stageId: (await card(J.jobId)).stages[0].id, completedOn: "2026-11-20" });
    const b = (await card(J.jobId)).billing;
    expect(b.target).toBe(8800);
    expect(b.alreadyInvoiced).toBe(3300);
    expect(b.paymentsReceived).toBe(0);
    expect(b.outstandingExisting).toBe(3300);
    expect(b.newInvoice).toBe(5500);
    expect(b.outstandingAfter).toBe(8800);
    expect(b.remainingAfter).toBe(2200);
    expect(b.notes.join(" ")).toContain(`Deposit IQ880002-1 is still unpaid ($3,300.00). It stays owing on its own invoice and is not charged again.`);
    await run(m.stages.raiseInvoice, { planId, expectedSeq: 0 });
    const rows = await q("SELECT kind, total, amount_paid FROM invoices WHERE job_id = ? ORDER BY seq", [J.jobId]);
    expect(rows).toEqual([
      { kind: "deposit", total: 3300, amount_paid: 0 },
      { kind: "stage", total: 5500, amount_paid: 0 },
    ] as any);
  });
});

describe("3. Kitchen hold on a bundled price (188014 shape)", () => {
  let J: Awaited<ReturnType<typeof makeJob>>;
  let planId = 0;
  const pay = [{ name: "Vinyl plank / LVT installation inc glue supply", unit: "m2", qty: 42, rate: 25, total: 1050 }];

  test("the bundled price needs the office's approved split, 2141.60 + 1906.68 (1c rounding on labour)", async () => {
    J = await makeJob({
      number: 880014,
      subtotal: 3680.25,
      total: 4048.28,
      bundled: true,
      lines: [
        { kind: "supply", lineType: "material", description: "Vinyl plank", qty: 42.3111, unit: "m2", total: 1831.22 },
        { kind: "supplier_charge", lineType: "material", description: "Fuel levy", qty: 1, unit: "each", total: 19.46 },
        { kind: "supplier_charge", lineType: "material", description: "Recycling levy", qty: 1, unit: "each", total: 4.23 },
        { kind: "supplier_charge", lineType: "material", description: "Freight", qty: 1, unit: "each", total: 92 },
        { kind: "labour", lineType: "labour", description: "Vinyl plank / LVT installation inc glue supply", qty: 42, unit: "m2", total: 1733.34 },
      ],
      deposit: { total: 2024.14, paid: 2024.14 },
      tasks: [{ installerId: INST_A, title: "Vinyl plank", breakdown: pay }],
    });
    const input = await setup(J.jobId, "hold", (p) => {
      p.reason = "kitchen_not_ready";
      p.stages[0].plannedDate = "2026-11-16";
      p.stages[0].lines[0].qty = 32;
      p.stages[0].pay[0].qty = 32;
      p.stages[1].lines[0].qty = 10;
      p.stages[1].pay[0].qty = 10;
    });
    // Awaiting readiness with no follow-up date is refused, so the work stays in view.
    const noFollow = await run<any>(m.stages.preview, input);
    expect(noFollow.built.issues.join(" ")).toContain("Set a follow-up date");
    input.followUpDate = "2026-12-01";
    input.materialsLocation = "10 m2 boxed in the garage";
    const pv = await run<any>(m.stages.preview, input);
    expect(pv.built.issues).toEqual([]);
    expect(pv.split.bundled).toBe(true);
    expect(pv.split.needsApproval).toBe(true);
    expect(pv.split.materialsInc).toBe(2141.6);
    expect(pv.split.labourInc).toBe(1906.68);
    expect(pv.split.roundingOnLabour).toBe(0.01);
    expect(pv.built.stages.map((s: any) => s.payTotal)).toEqual([800, 250]);
    planId = (await run<any>(m.stages.save, input)).planId;
    await confirm(planId);
    expect((await failure(run(m.stages.agree, { planId }))).message).toContain("needs office approval");
    input.approveSplit = true;
    await run(m.stages.save, input);
    expect((await run<any>(m.stages.agree, { planId })).status).toBe("agreed");
  });

  test("a typed split that does not add back to the accepted price is refused", async () => {
    const c = await card(J.jobId);
    const bad = { ...c.input, split: { materialsInc: 2000, labourInc: 2000, note: "" } };
    const pv = await run<any>(m.stages.preview, bad);
    expect(pv.built.issues.join(" ")).toContain("must add back exactly");
  });

  test("the done-so-far stage: materials in full plus 32 m2 of labour, less the deposit", async () => {
    const c = await card(J.jobId);
    await run(m.stages.completeStage, { stageId: c.stages[0].id, completedOn: "2026-11-16" });
    const b = (await card(J.jobId)).billing;
    const labour32 = Math.round(((1906.68 * 32) / 42) * 100) / 100;
    expect(b.labourDone).toBe(labour32);
    expect(b.target).toBe(Math.round((2141.6 + labour32) * 100) / 100);
    expect(b.newInvoice).toBe(Math.round((2141.6 + labour32 - 2024.14) * 100) / 100);
    expect(b.remainingAfter).toBe(Math.round((1906.68 - labour32) * 100) / 100);
    expect(await statusOf(J.jobId)).toBe(ST.part);
    const f = await m.guard.stagedForecastDates([J.jobId]);
    expect(f.get(J.jobId)?.basis).toContain("awaiting readiness, follow up 2026-12-01");
  });

  test("Terra Crew: the finished stage, $800 once approved, $250 still to come, no made-up return date", async () => {
    const c = await card(J.jobId);
    const before = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskIds[0] }));
    expect(before.stages[0].state).toBe("awaiting_approval");
    expect(before.claimable).toBe(0);
    await run(m.stages.approvePay, { stageId: c.stages[0].id });
    const v = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskIds[0] }));
    expect(v.stages.map((s: any) => s.state)).toEqual(["claimable", "to_do"]);
    expect(v.claimable).toBe(800);
    expect(v.remainingPay).toBe(250);
    expect(v.returnVisit.booked).toBeNull();
    expect(v.returnVisit.text).toBe("Awaiting the site. Terra office will book the return visit when it is ready.");
    expect(v.materialsLocation).toBe("10 m2 boxed in the garage");
    // Once the office moves his task to a later day, that is the booked return visit.
    await m.db.update(schema.jobTasks).set({ scheduledDate: "2026-12-03" } as any).where(m.orm.eq(schema.jobTasks.id, J.taskIds[0]));
    const later = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskIds[0] }));
    expect(later.returnVisit.booked).toBe("2026-12-03");
    await m.db.update(schema.jobTasks).set({ scheduledDate: "2026-11-16" } as any).where(m.orm.eq(schema.jobTasks.id, J.taskIds[0]));
  });
});

describe("4. Selling and pay kept apart", () => {
  test("the split ignores costs ('What this job makes'), and pay follows his locked lines", async () => {
    const J = await carpetTileJob(880004, 3300);
    // Costs on the task are set to nonsense: the selling split must not move.
    await q("UPDATE job_tasks SET labour_cost = 1 WHERE id = ?", [J.taskIds[0]!]);
    const c = await card(J.jobId);
    expect(c.split.materialsInc).toBe(6600);
    expect(c.split.labourInc).toBe(4400);
    expect(c.tasks[0].total).toBe(2000);
    expect(c.tasks[0].lines[0]).toMatchObject({ qty: 200, rate: 10, total: 2000 });
  });

  test("Terra Crew never carries a selling price, a customer invoice or a margin", async () => {
    const J = await (async () => {
      const [j] = await q("SELECT id FROM jobs WHERE number = 880014");
      return { jobId: Number(j.id), taskId: Number((await q("SELECT id FROM job_tasks WHERE job_id = ?", [j.id]))[0].id) };
    })();
    const v = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskId }));
    const text = JSON.stringify(v);
    for (const word of ["amountInc", "labourInc", "materialsInc", "1906.68", "2141.6", "4048.28", "margin", "invoiceId", "total\""]) {
      expect(text).not.toContain(word);
    }
    // Someone else's task is not his to see.
    expect(await as(B_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskId }))).toBeNull();
  });

  test("hourly work: estimates only, paid from approved timesheets, never a stage claim; employees left out", async () => {
    const J = await makeJob({
      number: 880005,
      subtotal: 10000,
      total: 11000,
      lines: [
        { kind: "supply", lineType: "material", description: "Tiles", qty: 100, unit: "m2", total: 6000 },
        { kind: "labour", lineType: "labour", description: "Tile install", qty: 100, unit: "m2", total: 4000 },
      ],
      tasks: [
        { installerId: HOURLY, title: "Hourly help", payType: "hourly" },
        { installerId: EMP, title: "Employee help", breakdown: [{ name: "Help", unit: "day", qty: 2, rate: 300, total: 600 }] },
      ],
    });
    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-20";
      p.stages[0].lines[0].qty = 50;
      p.stages[0].pay.find((x: any) => x.lineKey === "hourly").estimatedHours = 16;
      p.stages[1].plannedDate = "2026-12-20";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 50;
    });
    const pv = await run<any>(m.stages.preview, input);
    expect(pv.built.issues).toEqual([]);
    expect(pv.built.notes.join(" ")).toContain("Paid from approved timesheets only");
    expect(pv.built.notes.join(" ")).toContain("Employee. Paid through payroll");
    expect(pv.built.stages[0].pay).toHaveLength(1);
    expect(pv.built.stages[0].pay[0]).toMatchObject({ lineKey: "hourly", amount: null, estimatedHours: 16 });
    const { planId } = await run<any>(m.stages.save, input);
    await confirm(planId);
    await run(m.stages.agree, { planId });
    const c = await card(J.jobId);
    await run(m.stages.completeStage, { stageId: c.stages[0].id, completedOn: "2026-11-20" });
    expect((await run<any>(m.stages.approvePay, { stageId: c.stages[0].id })).approved).toBe(0);
    const v = await as(H_LOGIN, () => run<any>(m.stages.crew, { taskId: J.taskIds[0] }));
    expect(v.stages[0].state).toBe("timesheets");
    expect(v.claimable).toBe(0);
    expect(await m.guard.stagedClaimRows(J.taskIds[1]!, EMP)).toBeNull();
    const rec = (await card(J.jobId)).reconciliation.pay;
    expect(rec.map((r: any) => r.mode)).toEqual(["hourly", "employee"]);
    expect(rec.every((r: any) => r.ok)).toBe(true);
  });
});

describe("5. More than two stages", () => {
  let J: Awaited<ReturnType<typeof makeJob>>;
  let planId = 0;

  test("three stages, a typed labour amount on the first, the rest by quantity, adding back exactly", async () => {
    J = await makeJob({
      number: 880006,
      subtotal: 15000,
      total: 16500,
      lines: [
        { kind: "supply", lineType: "material", description: "Carpet tiles", qty: 300, unit: "m2", total: 9000 },
        { kind: "labour", lineType: "labour", description: "Carpet tile install", qty: 300, unit: "m2", total: 6000 },
      ],
      deposit: { total: 4950, paid: 4950 },
      tasks: [{ installerId: INST_A, title: "Carpet tiles", breakdown: [{ name: "Carpet tile install", unit: "m2", qty: 300, rate: 10, total: 3000 }] }],
    });
    const input = await setup(J.jobId, "planned", (p) => {
      const s = (qty: number, date: string, amountInc: number | null = null) => ({
        name: "",
        scope: "",
        plannedDate: date,
        awaitingReadiness: false,
        lines: [{ quoteItemId: J.itemIds[1], qty, amountInc }],
        pay: [{ taskId: J.taskIds[0], lineKey: "line:0", qty }],
      });
      p.stages = [s(100, "2026-11-20", 2500), s(100, "2026-12-10"), s(100, "2027-01-15")];
    });
    const pv = await run<any>(m.stages.preview, input);
    expect(pv.built.issues).toEqual([]);
    expect(pv.built.stages.map((s: any) => s.labourInc)).toEqual([2500, 2050, 2050]);
    expect(pv.built.stages.map((s: any) => s.name)).toEqual(["Stage 1", "Stage 2", "Stage 3"]);
    planId = (await run<any>(m.stages.save, input)).planId;
    await confirm(planId);
    await run(m.stages.agree, { planId });
  });

  test("a quantity left out of every stage is refused", async () => {
    const c = await card(J.jobId);
    const short = structuredClone(c.input);
    short.stages[2].lines[0].qty = 90;
    const pv = await run<any>(m.stages.preview, short);
    expect(pv.built.issues.join(" ")).toContain("Every quoted m2 must sit in one stage");
  });

  test("finishing stage 1 short: the 20 m2 not done moves to stage 2, money and pay with it", async () => {
    const c = await card(J.jobId);
    const out = await run<any>(m.stages.completeStage, {
      stageId: c.stages[0].id,
      completedOn: "2026-11-20",
      lines: [{ quoteItemId: J.itemIds[1], qty: 80 }],
      pay: [{ taskId: J.taskIds[0], lineKey: "line:0", qty: 80 }],
    });
    expect(out.openLeft).toBe(2);
    const after = await card(J.jobId);
    expect(after.stages.map((s: any) => s.lines[0].qty)).toEqual([80, 120, 100]);
    expect(after.stages.map((s: any) => s.pay[0].amount)).toEqual([800, 1200, 1000]);
    const labour = after.stages.map((s: any) => s.lines[0].amountInc);
    expect(Math.round(labour.reduce((a: number, b: number) => a + b, 0) * 100) / 100).toBe(6600);
    expect(after.reconciliation.ok).toBe(true);
  });

  test("finishing the same stage twice changes nothing", async () => {
    const c = await card(J.jobId);
    const again = await run<any>(m.stages.completeStage, { stageId: c.stages[0].id, completedOn: "2026-11-21" });
    expect(again.already).toBe(true);
    const [s] = await q("SELECT completed_on FROM job_stages WHERE id = ?", [c.stages[0].id]);
    expect(s.completed_on).toBe("2026-11-20");
  });

  test("stages finish in order", async () => {
    const c = await card(J.jobId);
    expect((await failure(run(m.stages.completeStage, { stageId: c.stages[2].id, completedOn: "2026-12-01" }))).message).toContain("Finish the earlier stage first");
  });
});

describe("6. A claim already submitted or paid", () => {
  test("a submitted claim counts as claimed: no second claim for the same stage, and paid stays claimed", async () => {
    const [j] = await q("SELECT id FROM jobs WHERE number = 880014");
    const taskId = Number((await q("SELECT id FROM job_tasks WHERE job_id = ?", [j.id]))[0].id);
    const first = await as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId }));
    expect(first.subtotal).toBe(800);
    expect(first.total).toBe(880);
    const again = await as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId }));
    expect(again.id).toBe(first.id);
    const pv = await as(A_LOGIN, () => run<any>(m.invoices.preview, { taskId }));
    expect(pv.alreadySubmitted).toBe(true);
    await q("UPDATE installer_invoices SET status = 'paid' WHERE id = ?", [first.id]);
    const v = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId }));
    expect(v.stages[0].state).toBe("claimed");
    expect(v.stages[0].claimRef).toBe(`#${first.invoiceNumber}`);
    expect(v.claimable).toBe(0);
    expect(await m.guard.stagedClaimRows(taskId, INST_A)).toEqual([]);
  });

  test("a whole-task claim raised before the staging: nothing left to split, and no stage pay for it", async () => {
    const J = await carpetTileJob(880007, 3300);
    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [J.taskIds[0]!]);
    const whole = await as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId: J.taskIds[0] }));
    expect(whole.subtotal).toBe(2000);
    const c = await card(J.jobId);
    expect(c.tasks[0].mode).toBe("invoiced");
    expect(c.tasks[0].note).toContain(`Already invoiced in full by the installer (invoice #${whole.invoiceNumber})`);
    const input = await setup(J.jobId, "hold", (p) => {
      p.followUpDate = "2026-12-01";
      p.stages[0].plannedDate = "2026-11-16";
      p.stages[0].lines[0].qty = 150;
      p.stages[1].lines[0].qty = 50;
    });
    expect(input.stages[0].pay).toEqual([]);
    const pv = await run<any>(m.stages.preview, input);
    expect(pv.built.issues).toEqual([]);
    expect(pv.built.stages.every((s: any) => s.pay.length === 0)).toBe(true);
  });
});

describe("7. Installer change", () => {
  test("the rest of the 188014-shape job goes to Installer B: A keeps his $800, B gets the $250, same rate", async () => {
    const [j] = await q("SELECT id FROM jobs WHERE number = 880014");
    const jobId = Number(j.id);
    const taskId = Number((await q("SELECT id FROM job_tasks WHERE job_id = ?", [jobId]))[0].id);
    const planId = (await card(jobId)).plan.id;
    const out = await run<any>(m.stages.reassign, { planId, taskId, toInstallerId: INST_B, rates: null, note: "" });
    expect(out.moved).toBe(1);
    const c = await card(jobId);
    expect(c.stages[0].pay[0]).toMatchObject({ installerId: INST_A, amount: 800 });
    expect(c.stages[1].pay[0]).toMatchObject({ installerId: INST_B, amount: 250, reassignedFromInstallerId: INST_A, changeNote: null });
    // A still sees his finished stage; the rest is not his.
    const a = await as(A_LOGIN, () => run<any>(m.stages.crew, { taskId }));
    expect(a.stages[0].state).toBe("claimed");
    expect(a.remainingPay).toBe(0);
    expect(a.stages[1].notYours).toBe(true);
    const b = await as(B_LOGIN, () => run<any>(m.stages.crew, { taskId }));
    expect(b.remainingPay).toBe(250);
    expect(b.claimable).toBe(0);
    // B finishes it; the claim is his $250 (not GST registered), and 800 + 250 = the $1,050 agreed.
    await run(m.stages.completeStage, { stageId: c.stages[1].id, completedOn: "2026-12-05" });
    await run(m.stages.approvePay, { stageId: c.stages[1].id });
    const inv = await as(B_LOGIN, () => run<any>(m.invoices.submit, { taskId }));
    expect(inv.subtotal).toBe(250);
    expect(inv.total).toBe(250);
    const rec = (await card(jobId)).reconciliation.pay[0];
    expect(rec).toMatchObject({ agreedPay: 1050, rateChanges: 0, inStages: 1050, claimed: 1050, ok: true });
  });

  test("a changed rate needs the office's reason, and the authorised pay moves by exactly the change", async () => {
    const [j] = await q("SELECT id FROM jobs WHERE number = 880006");
    const jobId = Number(j.id);
    const taskId = Number((await q("SELECT id FROM job_tasks WHERE job_id = ?", [jobId]))[0].id);
    const planId = (await card(jobId)).plan.id;
    const noReason = await failure(run(m.stages.reassign, { planId, taskId, toInstallerId: INST_B, rates: [{ lineKey: "line:0", rate: 12 }], note: "" }));
    expect(noReason.message).toContain("needs the office's reason");
    await run(m.stages.reassign, { planId, taskId, toInstallerId: INST_B, rates: [{ lineKey: "line:0", rate: 12 }], note: "Agreed $12 with Installer B for the return visits" });
    const c = await card(jobId);
    expect(c.stages.map((s: any) => [s.pay[0].installerId, s.pay[0].amount])).toEqual([
      [INST_A, 800],
      [INST_B, 1440],
      [INST_B, 1200],
    ]);
    const rec = c.reconciliation.pay[0];
    expect(rec).toMatchObject({ agreedPay: 3000, rateChanges: 440, inStages: 3440, ok: true });
  });
});

describe("8. Double clicks and races", () => {
  test("two Raise clicks at once: one invoice", async () => {
    const J = await carpetTileJob(880008, 3300);
    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-20";
      p.stages[0].lines[0].qty = 100;
      p.stages[0].pay[0].qty = 100;
      p.stages[1].plannedDate = "2026-12-21";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 100;
      p.stages[1].pay[0].qty = 100;
    });
    // Two people starting the plan at once: one plan.
    const saves = await Promise.allSettled([run<any>(m.stages.save, input), run<any>(m.stages.save, input)]);
    expect(await q("SELECT count(*) n FROM job_stage_plans WHERE job_id = ?", [J.jobId])).toEqual([{ n: 1 }] as any);
    for (const s of saves) if (s.status === "rejected") expect(String((s.reason as Error).message)).toMatch(/a moment ago|same moment/);
    const planId = Number((await q("SELECT id FROM job_stage_plans WHERE job_id = ?", [J.jobId]))[0].id);
    await confirm(planId);
    await run(m.stages.agree, { planId });
    const c = await card(J.jobId);
    await Promise.allSettled([
      run(m.stages.completeStage, { stageId: c.stages[0].id, completedOn: "2026-11-20" }),
      run(m.stages.completeStage, { stageId: c.stages[0].id, completedOn: "2026-11-20" }),
    ]);
    expect(await q("SELECT count(*) n FROM job_stages WHERE plan_id = ? AND status = 'complete'", [planId])).toEqual([{ n: 1 }] as any);
    const both = await Promise.allSettled([run<any>(m.stages.raiseInvoice, { planId, expectedSeq: 0 }), run<any>(m.stages.raiseInvoice, { planId, expectedSeq: 0 })]);
    expect(await invoiceCount(J.jobId)).toBe(2);
    for (const r of both) if (r.status === "rejected") expect(String((r.reason as Error).message)).toContain("Someone else is raising");
    const [p] = await q("SELECT invoice_seq FROM job_stage_plans WHERE id = ?", [planId]);
    expect(p.invoice_seq).toBe(1);
    // A refused raise gives its turn back, so the card's next click is not taken for a repeat.
    const nothing = await failure(run(m.stages.raiseInvoice, { planId, expectedSeq: 1 }));
    expect(nothing.message).toContain("Nothing new is due yet");
    expect((await q("SELECT invoice_seq FROM job_stage_plans WHERE id = ?", [planId]))[0].invoice_seq).toBe(1);
  });

  test("two Claim taps at once: one claim, each stage line on one invoice only", async () => {
    const [j] = await q("SELECT id FROM jobs WHERE number = 880008");
    const jobId = Number(j.id);
    const taskId = Number((await q("SELECT id FROM job_tasks WHERE job_id = ?", [jobId]))[0].id);
    await run(m.stages.approvePay, { stageId: (await card(jobId)).stages[0].id });
    const both = await Promise.allSettled([
      as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId })),
      as(A_LOGIN, () => run<any>(m.invoices.submit, { taskId })),
    ]);
    const ok = both.filter((b) => b.status === "fulfilled") as PromiseFulfilledResult<any>[];
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok.map((o) => o.value.id)).size).toBe(1);
    expect(await q("SELECT count(*) n FROM installer_invoices WHERE task_id = ? AND installer_id = ?", [taskId, INST_A])).toEqual([{ n: 1 }] as any);
    const rows = await q("SELECT claim_invoice_id FROM job_stage_pay WHERE task_id = ? AND approved_at IS NOT NULL", [taskId]);
    expect(rows.map((r) => r.claim_invoice_id)).toEqual([ok[0]!.value.id]);
  });
});

describe("9. Final reconciliation, variations, over-billing and the rest", () => {
  test("Wizards shape: 0% deposit, a variation on the final, books close at quote + variation", async () => {
    const J = await makeJob({
      number: 880040,
      subtotal: 34216,
      total: 37637.6,
      value: 39110.06,
      lines: [
        { kind: "supply", lineType: "material", description: "Tiles", qty: 400, unit: "m2", total: 26772 },
        { kind: "other", lineType: "material", description: "Glue", qty: 1, unit: "each", total: 400 },
        { kind: "labour", lineType: "labour", description: "Tile install", qty: 400, unit: "m2", total: 7044 },
      ],
      tasks: [{ installerId: INST_A, title: "Tiles", breakdown: [{ name: "Tile install", unit: "m2", qty: 400, rate: 10, total: 4000 }] }],
    });
    const [v] = await m.db.insert(schema.variations).values({ jobId: J.jobId, ref: "V880040-01", status: "approved", amount: 1472.46, subtotal: 1338.6, gst: 133.86, total: 1472.46 } as any).returning();
    await m.db.insert(schema.variationItems).values({ variationId: v!.id, kind: "supply", lineType: "material", description: "Extra tiles", qty: 20, unit: "m2", total: 1338.6 } as any);

    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-19";
      p.stages[0].lines[0].qty = 200;
      p.stages[0].pay[0].qty = 200;
      p.stages[1].plannedDate = "2026-12-15";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 200;
      p.stages[1].pay[0].qty = 200;
      p.variationTiming = "with_materials";
    });
    const { planId } = await run<any>(m.stages.save, input);
    // Office choice "with the materials": the variation's material part is due now too.
    expect((await card(J.jobId)).billing.target).toBe(Math.round((29889.2 + 1472.46) * 100) / 100);
    input.variationTiming = "final";
    await run(m.stages.save, input);
    const c0 = await card(J.jobId);
    expect(c0.split).toMatchObject({ materialsInc: 29889.2, labourInc: 7748.4, linesAddBack: true, needsApproval: false });
    expect(c0.billing.target).toBe(29889.2);
    expect(c0.billing.contractTotal).toBe(39110.06);
    await confirm(planId);
    await run(m.stages.agree, { planId });
    await run(m.stages.completeStage, { stageId: c0.stages[0].id, completedOn: "2026-11-20" });
    const b1 = (await card(J.jobId)).billing;
    expect(b1.target).toBe(33763.4);
    expect(b1.newInvoice).toBe(33763.4);
    expect(b1.remainingAfter).toBe(5346.66);
    await run(m.stages.raiseInvoice, { planId, expectedSeq: 0 });
    await run(m.stages.completeStage, { stageId: c0.stages[1].id, completedOn: "2026-12-15" });
    const b2 = (await card(J.jobId)).billing;
    expect(b2.kind).toBe("final");
    expect(b2.newInvoice).toBe(5346.66);
    await run(m.stages.raiseInvoice, { planId, expectedSeq: 1 });
    const rec = (await card(J.jobId)).reconciliation;
    expect(rec.customer).toMatchObject({ contractTotal: 39110.06, jobValue: 39110.06, invoiced: 39110.06, leftToInvoice: 0, splitAddsBack: true, stageLabourAddsBack: true });
    expect(rec.ok).toBe(true);
  });

  test("earlier billing over the target is flagged, and nothing is raised (never a negative invoice)", async () => {
    const J = await carpetTileJob(880009, 3300);
    await m.db.insert(schema.invoices).values({ number: "IQ880009-2", jobNumber: 880009, seq: 2, jobId: J.jobId, kind: "stage", label: "Progress", status: "sent", subtotal: 5454.55, gst: 545.45, total: 6000, amountPaid: 0 } as any);
    const input = await setup(J.jobId, "planned", (p) => {
      p.stages[0].plannedDate = "2026-11-20";
      p.stages[0].lines[0].qty = 50;
      p.stages[0].pay[0].qty = 50;
      p.stages[1].plannedDate = "2026-12-21";
      p.stages[1].awaitingReadiness = false;
      p.stages[1].lines[0].qty = 150;
      p.stages[1].pay[0].qty = 150;
    });
    const { planId } = await run<any>(m.stages.save, input);
    await confirm(planId);
    await run(m.stages.agree, { planId });
    await run(m.stages.completeStage, { stageId: (await card(J.jobId)).stages[0].id, completedOn: "2026-11-20" });
    const b = (await card(J.jobId)).billing;
    expect(b.target).toBe(7700);
    expect(b.alreadyInvoiced).toBe(9300);
    expect(b.overBilledBy).toBe(1600);
    expect(b.newInvoice).toBe(0);
    expect(b.notes.join(" ")).toContain("Nothing new is raised");
    expect((await failure(run(m.stages.raiseInvoice, { planId, expectedSeq: 0 }))).message).toContain("Invoices already raised");
    expect(await invoiceCount(J.jobId)).toBe(2);
    expect((await q("SELECT min(total) t FROM invoices WHERE job_id = ?", [J.jobId]))[0].t).toBeGreaterThan(0);
  });

  test("a return visit on a callback job is refused: it belongs on the original job", async () => {
    const parent = await carpetTileJob(880010, 3300);
    const J = await makeJob({
      number: 880011,
      subtotal: 1000,
      total: 1100,
      parentJobId: parent.jobId,
      lines: [
        { kind: "supply", lineType: "material", description: "Tiles", qty: 10, unit: "m2", total: 600 },
        { kind: "labour", lineType: "labour", description: "Install", qty: 10, unit: "m2", total: 400 },
      ],
      tasks: [],
    });
    const input = await setup(J.jobId, "hold", (p) => {
      p.followUpDate = "2026-12-01";
      p.stages[0].plannedDate = "2026-11-16";
      p.stages[0].lines[0].qty = 5;
      p.stages[1].lines[0].qty = 5;
    });
    expect((await failure(run(m.stages.save, input))).message).toContain("callback job");
    expect((await card(J.jobId)).blocked).toContain("callback job");
  });

  test("a plan can't be cancelled once a stage is finished or invoiced", async () => {
    const [j] = await q("SELECT id FROM jobs WHERE number = 880008");
    const planId = (await card(Number(j.id))).plan.id;
    expect((await failure(run(m.stages.cancel, { planId, reason: "changed my mind" }))).message).toContain("already finished");
  });

  test("nothing left the machine", () => {
    expect(blocked).toEqual([]);
    expect(outside.push).toBe(0);
    // Installer claims try to email a copy (caught here, never sent): one per claim submitted above.
    expect(outside.email.length).toBeGreaterThan(0);
  });
});
