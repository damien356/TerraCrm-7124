/**
 * Assign anyway (Damien's brief, 11 Nov 2026, dispatch 188007-A).
 *
 *   bun test scripts/assign-anyway.test.ts      (from packages/web)
 *
 * Runs the real booking, picker, allocation, offer, costing, crew card and
 * invoice code on a throwaway SQLite file built from the schema. Dispatch
 * 188007-A is copied as it is live: "Day rate, one man" and "Day rate, leading
 * hand", qty 1 each, both per-person items (unit hour, Terra $35 and $47 an
 * hour from 10 Nov) switched on for nobody. Pedro Sinclair is copied as he is
 * live: solo, hourly at $47 (weekend x1.2, night x1.8), new work hourly.
 * Sign in is faked. Office alerts and pushes are caught, and every network
 * call is blocked, so nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "assign-anyway-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY = "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const alerts: string[] = [];
const pushes: number[] = [];

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "test-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "test-office", name: "Test Office", email: "office@example.invalid" };
const PEDRO_LOGIN: Who = { id: "test-pedro", name: "Pedro Sinclair", email: "pedro@example.invalid" };
const FIXED_LOGIN: Who = { id: "test-fiona", name: "Fiona Fixed", email: "fiona@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

// Ids as they are live where they matter.
const PEDRO = 8;
const ZERO_OWN = 17; // has his own $0 rates on 73, 74 and 103, like 17 and 21 live
const PAUL = 19; // per m2 contractor
const FIXED = 40; // fixed price, no own rate on the day rates
const OWN = 41; // fixed price, his own agreed day rates
const OFF = 42; // switched off
const SK = { lvt: 6, tiles: 2, pedroA: 28, pedroB: 35 };
const IT = { tiles: 4, dayOne: 73, dayTwo: 74, dayLead: 103 };
const WARN = '"Day rate, one man" and "Day rate, leading hand" are not enabled on Pedro\'s profile.';
const TITLE = "Vinyl plank / LVT installation inc glue supply + Install Rubber Underlay inc glue";

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  orm: typeof import("drizzle-orm");
  check: typeof import("../src/api/lib/assign-check");
  hourly: typeof import("../src/api/lib/hourly");
  tasksRoute: typeof import("../src/api/routes/tasks");
  installers: typeof import("../src/api/routes/installers").installers;
  offers: typeof import("../src/api/routes/offers").offers;
  dispatches: typeof import("../src/api/routes/dispatches").dispatches;
  invoices: typeof import("../src/api/routes/installerInvoices").installerInvoices;
  field: typeof import("../src/api/routes/field").field;
  costing: typeof import("../src/api/routes/costing").costing;
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in assign-anyway tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({
    ...realNotify,
    notifyOffice: async (kind: string) => {
      alerts.push(kind);
    },
  }));
  const realPush = await import("../src/api/lib/push");
  mock.module("../src/api/lib/push", () => ({
    ...realPush,
    sendPush: async () => 0,
    pushToInstaller: async (installerId: number) => {
      pushes.push(installerId);
      return 0;
    },
    pushToOffice: async () => 0,
  }));
  const realGoogle = await import("../src/api/lib/google-calendar");
  mock.module("../src/api/lib/google-calendar", () => ({ ...realGoogle, freeBusy: async () => [] }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    orm: await import("drizzle-orm"),
    check: await import("../src/api/lib/assign-check"),
    hourly: await import("../src/api/lib/hourly"),
    tasksRoute: await import("../src/api/routes/tasks"),
    installers: (await import("../src/api/routes/installers")).installers,
    offers: (await import("../src/api/routes/offers")).offers,
    dispatches: (await import("../src/api/routes/dispatches")).dispatches,
    invoices: (await import("../src/api/routes/installerInvoices")).installerInvoices,
    field: (await import("../src/api/routes/field")).field,
    costing: (await import("../src/api/routes/costing")).costing,
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
const actor = (over: Partial<import("../src/api/middleware/auth").Actor> = {}): import("../src/api/middleware/auth").Actor => ({
  userId: ADMIN!.id,
  name: "Test Admin",
  email: ADMIN!.email,
  role: "admin",
  installerId: null,
  canSeeCosts: true,
  profileId: 1,
  isMainAdmin: true,
  canRestorePeople: true,
  ...over,
});
const ack = (installerId: number, warnings: string[], note: string | null = null) => [{ installerId, warnings, note }];
const book = (taskId: number, installerId: number, dates: string[], extra: Record<string, unknown> = {}) =>
  m.tasksRoute.bookTask({ taskId, installerId, dates, arrivalStart: "07:00", coordinateAfterFirst: false, perDay: [], ...extra } as any, actor());

/* --------------------------------- fixtures --------------------------------- */

let siteId = 0;
let jobSeq = 188007;

async function newJob() {
  const [j] = await m.db.insert(schema.jobs).values({ number: jobSeq++, siteId, furnitureMoving: false } as any).returning();
  return j!.id;
}

/** A copy of 188007-A: the two day rate lines, qty 1 each, the LVT category on the dispatch only. */
async function newTask(jobId: number, lines: [number, number][] = [[IT.dayOne, 1], [IT.dayLead, 1]], over: Record<string, unknown> = {}) {
  const [t] = await m.db
    .insert(schema.jobTasks)
    .values({ jobId, seq: 1, title: TITLE, skillId: SK.lvt, durationHours: 4, crewSize: 1, status: "unassigned", payType: "per_job", ...over } as any)
    .returning();
  let i = 0;
  for (const [itemId, qty] of lines) await m.db.insert(schema.taskLabourLines).values({ taskId: t!.id, itemId, qty, sortOrder: i++ } as any);
  return t!.id;
}

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true });
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: "Test Office", email: OFFICE!.email, role: "office" });

  for (const [id, name, groupName] of [
    [SK.lvt, "Vinyl plank / LVT", "resilient"],
    [SK.tiles, "Carpet tiles", "carpet"],
    [SK.pedroA, "Hybrid", "resilient"],
    [SK.pedroB, "Underlay", "trades"],
  ] as const) {
    await db.insert(schema.skills).values({ id, name, groupName } as any);
  }
  for (const [id, name, crewCapacity, active, skills] of [
    [PEDRO, "Pedro Sinclair", "solo", true, [SK.pedroA, SK.pedroB]],
    [ZERO_OWN, "Zed Zero", "solo", true, [SK.lvt]],
    [PAUL, "Paul", "own_offsider", true, [SK.tiles, SK.lvt]],
    [FIXED, "Fiona Fixed", "solo", true, [SK.lvt]],
    [OWN, "Oscar Own", "solo", true, [SK.lvt]],
    [OFF, "Olly Off", "solo", false, [SK.lvt]],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, crewCapacity, active } as any);
    for (const skillId of skills) await db.insert(schema.installerSkills).values({ installerId: id, skillId } as any);
  }
  for (const [login, installerId] of [
    [PEDRO_LOGIN, PEDRO],
    [FIXED_LOGIN, FIXED],
  ] as const) {
    await db.insert(schema.profiles).values({ userId: login!.id, name: login!.name, email: login!.email, role: "field", installerId } as any);
  }

  // The rate book rows. 73 and 103 are per hour now, Terra $35 and $47 from 10 Nov.
  for (const [id, name, unit, groupName, skillId, restricted] of [
    [IT.tiles, "Carpet tile install", "m2", "carpet", SK.tiles, false],
    [IT.dayOne, "Day rate, one man", "hour", "other", null, true],
    [IT.dayTwo, "Day rate, two man crew", "day", "other", null, true],
    [IT.dayLead, "Day rate, leading hand", "hour", "other", null, true],
  ] as const) {
    await db.insert(schema.labourRateItems).values({ id, name, unit, groupName, skillId, kind: "work", active: true, restricted } as any);
  }
  for (const [itemId, installerId, amount, from, to] of [
    [IT.tiles, null, 10, "2026-01-01", null],
    [IT.dayOne, null, 320, "2026-01-01", "2026-11-09"],
    [IT.dayOne, null, 35, "2026-11-10", null],
    [IT.dayLead, null, 580, "2026-01-01", "2026-11-09"],
    [IT.dayLead, null, 47, "2026-11-10", null],
    [IT.dayTwo, null, 640, "2026-01-01", null],
    [IT.dayOne, ZERO_OWN, 0, "2026-01-01", null],
    [IT.dayTwo, ZERO_OWN, 0, "2026-01-01", null],
    [IT.dayLead, ZERO_OWN, 0, "2026-01-01", null],
    [IT.dayOne, OWN, 300, "2026-01-01", null],
    [IT.dayLead, OWN, 420, "2026-01-01", null],
  ] as const) {
    await db.insert(schema.labourRates).values({ itemId, installerId, amount, effectiveFrom: from, effectiveTo: to } as any);
  }

  // Pedro's terms as live: $47 an hour, weekend x1.2, night x1.8, new work hourly.
  await db.insert(schema.installerPayTerms).values({
    installerId: PEDRO, baseRate: 47, weekendMultiplier: 1.2, nightMultiplier: 1.8, defaultForNew: true, effectiveFrom: "2026-10-23",
  } as any);

  const [site] = await db.insert(schema.sites).values({ address: "1 Test St, Brisbane", propertyType: "house" } as any).returning();
  siteId = site!.id;
}

const WED = "2026-11-18";
const THU = "2026-11-19";
const FRI = "2026-11-20";
const MON = "2026-11-23";
const TUE = "2026-11-24";
const ALLOC = "2026-11-25";

const snapshot = async (installerId: number) => ({
  person: await q("SELECT name, active, crew_capacity, worker_type FROM installers WHERE id = ?", [installerId]),
  skills: await q("SELECT skill_id FROM installer_skills WHERE installer_id = ? ORDER BY skill_id", [installerId]),
  terms: await q("SELECT base_rate, weekend_multiplier, night_multiplier, default_for_new, effective_from, effective_to FROM installer_pay_terms WHERE installer_id = ?", [installerId]),
  access: await q("SELECT item_id, enabled FROM installer_rate_item_access WHERE installer_id = ?", [installerId]),
  rates: await q("SELECT item_id, amount FROM labour_rates WHERE installer_id = ? ORDER BY item_id", [installerId]),
});

/* ---------------------------------- checks ---------------------------------- */

describe("1. The cause, and Pedro in the picker", () => {
  test("Pedro shows with the exact warning and how he is paid; Office sees no rate", async () => {
    const t = await newTask(await newJob());
    const rows = await run<any[]>(m.installers.eligible, { taskId: t });
    const pedro = rows.find((r) => r.id === PEDRO)!;
    expect(pedro.warnings.map((w: any) => w.text)).toEqual([WARN]);
    expect(pedro.warnings[0].detail).toBe(
      "Pedro is paid hourly, so these lines are only Terra's benchmark for the dispatch. The pay is Pedro's approved hours.",
    );
    expect(pedro.payMethod).toEqual({ kind: "hourly", label: "Hourly, paid on approved hours", rate: "$47.00 an hour (weekend ×1.2, night ×1.8)", payToConfirm: false });
    // Every active person needs a check on this dispatch: nobody has the day rates switched on.
    const active = rows.filter((r) => r.id !== OFF);
    expect(active.every((r) => r.warnings.some((w: any) => w.kind === "rate_item"))).toBe(true);

    const office = await as(OFFICE, () => run<any[]>(m.installers.eligible, { taskId: t }));
    expect(office.find((r) => r.id === PEDRO)!.payMethod.rate).toBeNull();
    // The lines carry no work category, so there is no skill warning for him.
    expect(pedro.warnings.some((w: any) => w.kind === "skill")).toBe(false);
  });
});

describe("2. Assign anyway on a booking", () => {
  test("refused without the acknowledgement, with the warnings and pay method, and nothing is written", async () => {
    const t = await newTask(await newJob());
    const before = await snapshot(PEDRO);
    const e = await failure(book(t, PEDRO, [WED]));
    expect(e.data?.reason).toBe("assign_check");
    expect(e.data.name).toBe("Pedro Sinclair");
    expect(e.data.warnings.map((w: any) => w.text)).toEqual([WARN]);
    expect(e.data.payMethod.kind).toBe("hourly");
    // The admin sees his rate in the check, as in the picker.
    expect(e.data.payMethod.rate).toBe("$47.00 an hour (weekend ×1.2, night ×1.8)");
    expect(e.message).toBe(`Check assignment — Pedro Sinclair. ${WARN}`);
    // A partial or wrong acknowledgement is refused the same way.
    expect((await failure(book(t, PEDRO, [WED], { assignAnyway: ack(PEDRO, ["something else"]) }))).data?.reason).toBe("assign_check");
    expect((await failure(book(t, PEDRO, [WED], { assignAnyway: ack(ZERO_OWN, [WARN]) }))).data?.reason).toBe("assign_check");
    expect(await q("SELECT assigned_installer_id who, status FROM job_tasks WHERE id = ?", [t])).toEqual([{ who: null, status: "unassigned" }] as any);
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
    expect(await snapshot(PEDRO)).toEqual(before);
  });

  test("one day: saved with the acknowledgement, paid hourly at $47, estimated hours kept, override on the job history", async () => {
    const t = await newTask(await newJob());
    const before = await snapshot(PEDRO);
    await book(t, PEDRO, [WED], { assignAnyway: ack(PEDRO, [WARN], "Pedro is hourly, day rates are only the benchmark"), plannedHours: 8 });

    const [row] = await q(
      "SELECT assigned_installer_id who, status, pay_type, agreed_hourly_rate, labour_cost, labour_breakdown, planned_hours, benchmark_cost, benchmark_breakdown FROM job_tasks WHERE id = ?",
      [t],
    );
    expect([row.who, row.status, row.pay_type, row.agreed_hourly_rate, row.labour_cost, row.labour_breakdown, row.planned_hours]).toEqual([
      PEDRO, "assigned", "hourly", 47, null, null, 8,
    ]);
    // The lines are Terra's benchmark at the hourly rates from 10 Nov: $35 + $47.
    expect(row.benchmark_cost).toBe(82);
    expect(JSON.parse(row.benchmark_breakdown).map((l: any) => [l.name, l.unit, l.rate])).toEqual([
      ["Day rate, one man", "hour", 35],
      ["Day rate, leading hand", "hour", 47],
    ]);

    const log = await q("SELECT action, detail, actor_name FROM activity_log WHERE task_id = ? ORDER BY id", [t]);
    expect(log.map((l) => l.action)).toEqual(["booked", "assignment_override"]);
    expect(log[0].detail).toContain("estimated 8h");
    const o = log[1].detail as string;
    expect(o.startsWith(`Assign anyway: Pedro Sinclair on 188`)).toBe(true);
    expect(o).toContain("-A (booking). Warning: " + WARN + " Confirmed by Test Admin (admin) on ");
    expect(o.endsWith("Note: Pedro is hourly, day rates are only the benchmark")).toBe(true);
    expect(log[1].actor_name).toBe("Test Admin");

    // His profile, skills, pay terms and switches are exactly as they were.
    expect(await snapshot(PEDRO)).toEqual(before);

    // Reopened, the booking panel shows the pay method and the override.
    const panel = await run<any>(m.tasksRoute.tasks.get, { id: t });
    expect(panel.payMethod.kind).toBe("hourly");
    expect(panel.payToConfirm).toBe(false);
    expect(panel.assignOverrides.map((x: any) => x.detail)).toEqual([o]);
    // Changing the booking later doesn't ask again: he was checked when he got it.
    await book(t, PEDRO, [THU], { plannedHours: 6 });
    expect((await q("SELECT planned_hours FROM job_tasks WHERE id = ?", [t]))[0].planned_hours).toBe(6);
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ? AND action = 'assignment_override'", [t])).toEqual([{ n: 1 }] as any);
  });

  test("several days: one acknowledgement covers the run, every day is booked", async () => {
    const t = await newTask(await newJob());
    await book(t, PEDRO, [MON, TUE], { assignAnyway: ack(PEDRO, [WARN]), plannedHours: 16 });
    expect(await q("SELECT date, installer_id FROM task_days WHERE task_id = ? ORDER BY date", [t])).toEqual([
      { date: MON, installer_id: null },
      { date: TUE, installer_id: null },
    ] as any);
    expect(await q("SELECT scheduled_from f, scheduled_to t, pay_type, planned_hours FROM job_tasks WHERE id = ?", [t])).toEqual([
      { f: MON, t: TUE, pay_type: "hourly", planned_hours: 16 },
    ] as any);
    const log = await q("SELECT detail FROM activity_log WHERE task_id = ? AND action = 'assignment_override'", [t]);
    expect(log.length).toBe(1);
    expect(log[0].detail).not.toContain("Note:");
  });

  test("assign and drag on the board ask the same way and log where it came from", async () => {
    const a = await newTask(await newJob());
    expect((await failure(run(m.tasksRoute.tasks.assign, { id: a, installerId: PEDRO }))).data?.reason).toBe("assign_check");
    await run(m.tasksRoute.tasks.assign, { id: a, installerId: PEDRO, assignAnyway: ack(PEDRO, [WARN]) });
    expect((await q("SELECT detail FROM activity_log WHERE task_id = ? AND action = 'assignment_override'", [a]))[0].detail).toContain("(direct assign)");

    const r = await newTask(await newJob());
    expect((await failure(run(m.tasksRoute.tasks.reschedule, { id: r, scheduledDate: FRI, startTime: "07:00", installerId: PEDRO }))).data?.reason).toBe("assign_check");
    expect((await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [r]))[0].who).toBeNull();
    await run(m.tasksRoute.tasks.reschedule, { id: r, scheduledDate: FRI, startTime: "07:00", installerId: PEDRO, assignAnyway: ack(PEDRO, [WARN]) });
    expect((await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [r]))[0].who).toBe(PEDRO);
    expect((await q("SELECT detail FROM activity_log WHERE task_id = ? AND action = 'assignment_override'", [r]))[0].detail).toContain("(board)");
  });
});

describe("3. Hourly labour counted once, beside a per-m2 contractor", () => {
  test("the job costing plans 8h at $47, and approved hours are part of it, not on top; Paul's m2 pay is his own", async () => {
    const j = await newJob();
    const pedroTask = await newTask(j);
    const paulTask = await newTask(j, [[IT.tiles, 40]], { seq: 2, title: "Carpet tiles", skillId: SK.tiles });
    await book(pedroTask, PEDRO, [WED], { assignAnyway: ack(PEDRO, [WARN]), plannedHours: 8 });
    await book(paulTask, PAUL, [WED]);
    expect(await q("SELECT pay_type, labour_cost FROM job_tasks WHERE id = ?", [paulTask])).toEqual([{ pay_type: "per_job", labour_cost: 400 }] as any);

    let cost = await m.hourly.jobHourlyCosting(j);
    expect(cost.tasks.map((t: any) => t.taskId)).toEqual([pedroTask]);
    const before = cost.tasks[0]!;
    expect(before.plan.labour).toBe(376);

    // Three hours approved on Wednesday at $47.
    await m.db.insert(schema.workSessions).values({
      installerId: PEDRO, taskId: pedroTask, jobId: j, clientKey: "pedro-1", workDate: WED,
      startedAt: new Date("2026-11-17T21:00:00Z"), endedAt: new Date("2026-11-18T00:00:00Z"), status: "approved",
      payable: true, approvedMinutes: 180, rateBase: 47, approvedPay: 141,
      payLines: JSON.stringify([{ band: "standard", label: "Standard", minutes: 180, rate: 47, total: 141 }]),
    } as any);
    cost = await m.hourly.jobHourlyCosting(j);
    const after = cost.tasks[0]! as any;
    expect(after.soFar.approvedLabour).toBe(141);
    // 141 approved + 5 hours still to go at $47 = the 8 hours planned, never 141 + 376.
    expect(after.remaining.labour).toBe(235);
    expect(after.projected.labour).toBe(376);
    // Paul's m2 pay is counted once as other labour, Pedro's once as hourly.
    expect([cost.margin.otherLabour, cost.margin.hourlyLabour]).toEqual([400, 376]);
  });
});

describe("4. Pay to confirm: no Terra rate borrowed", () => {
  const FWARN = '"Day rate, one man" and "Day rate, leading hand" are not enabled on Fiona\'s profile.';

  test("a fixed-price person without her own rate: booked with the check, the lines stay unpriced, flagged everywhere", async () => {
    const j = await newJob();
    const t = await newTask(j);
    const rows = await run<any[]>(m.installers.eligible, { taskId: t });
    const fiona = rows.find((r) => r.id === FIXED)!;
    expect(fiona.warnings.map((w: any) => w.text)).toEqual([FWARN]);
    expect(fiona.warnings[0].detail).toContain("Terra's rate is not borrowed.");
    expect(fiona.payMethod.kind).toBe("fixed");

    await book(t, FIXED, [WED], { assignAnyway: ack(FIXED, [FWARN]) });
    const [row] = await q("SELECT pay_type, labour_cost, labour_breakdown FROM job_tasks WHERE id = ?", [t]);
    expect(row.pay_type).toBe("per_job");
    const lines = JSON.parse(row.labour_breakdown);
    expect(lines.map((l: any) => [l.name, l.rate, l.source])).toEqual([
      ["Day rate, one man", null, "none"],
      ["Day rate, leading hand", null, "none"],
    ]);
    expect(row.labour_cost ?? 0).toBe(0);

    expect([...(await m.check.payToConfirmTaskIds([t]))]).toEqual([t]);
    expect((await run<any>(m.tasksRoute.tasks.get, { id: t })).payToConfirm).toBe(true);
    const f = await run<any>(m.costing.forecast, { jobId: j });
    const view = f.tasks.find((x: any) => x.taskId === t);
    expect([view.payToConfirm, view.payNotSet]).toEqual([true, false]);
    const card = await as(FIXED_LOGIN, () => run<any>(m.field.task, { id: t }));
    expect(card.payNote).toBe("Pay to confirm");

    // Never invoiced or approved until the rate is set.
    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [t]);
    expect((await failure(as(FIXED_LOGIN, () => run(m.invoices.submit, { taskId: t })))).message).toContain("Rate not set");
    expect(await q("SELECT count(*) n FROM installer_invoices WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
  });

  test("his own $0.00 rates are Rate not set too, never Terra's", async () => {
    const t = await newTask(await newJob());
    const w = await m.check.assignWarnings(t, ZERO_OWN);
    expect(w.map((x) => x.kind)).toEqual(["rate_item"]);
    await book(t, ZERO_OWN, [WED], { assignAnyway: ack(ZERO_OWN, w.map((x) => x.text)) });
    const lines = JSON.parse((await q("SELECT labour_breakdown b FROM job_tasks WHERE id = ?", [t]))[0].b);
    expect(lines.map((l: any) => l.rate)).toEqual([0, 0]);
    expect([...(await m.check.payToConfirmTaskIds([t]))]).toEqual([t]);
  });

  test("a person with his own agreed day rates keeps them, and is not Pay to confirm", async () => {
    const t = await newTask(await newJob());
    const w = await m.check.assignWarnings(t, OWN);
    expect(w.map((x) => x.text)).toEqual(['"Day rate, one man" and "Day rate, leading hand" are not enabled on Oscar\'s profile.']);
    expect(w[0]!.detail).toBe("Oscar's own agreed rate on the card is used for these lines. Terra's rate is not borrowed.");
    await book(t, OWN, [WED], { assignAnyway: ack(OWN, w.map((x) => x.text)) });
    expect((await q("SELECT labour_cost FROM job_tasks WHERE id = ?", [t]))[0].labour_cost).toBe(720);
    expect((await m.check.payToConfirmTaskIds([t])).size).toBe(0);
  });

  test("the job page reads Pedro's lines at Terra's benchmark, not unpriced; a fixed-price person stays unpriced", async () => {
    const j = await newJob();
    const t = await newTask(j);
    await book(t, PEDRO, [WED], { assignAnyway: ack(PEDRO, [WARN]), plannedHours: 4 });
    const f = await run<any>(m.costing.forecast, { jobId: j });
    const view = f.tasks.find((x: any) => x.taskId === t);
    expect(view.unpriced).toEqual([]);
    expect([view.payToConfirm, view.payNotSet]).toEqual([false, false]);
    const lines = await run<any>(m.costing.taskLines, { taskId: t });
    expect(lines.unpriced).toEqual([]);

    // Fiona, fixed price, same lines: still unpriced, Terra's rate not borrowed.
    const t2 = await newTask(await newJob());
    await book(t2, FIXED, [WED], { assignAnyway: ack(FIXED, ['"Day rate, one man" and "Day rate, leading hand" are not enabled on Fiona\'s profile.']) });
    const l2 = await run<any>(m.costing.taskLines, { taskId: t2 });
    expect(l2.unpriced.length).toBe(2);
  });

  test("Pedro's own crew card has no Pay to confirm note", async () => {
    const t = await newTask(await newJob());
    await book(t, PEDRO, [WED], { assignAnyway: ack(PEDRO, [WARN]) });
    const card = await as(PEDRO_LOGIN, () => run<any>(m.field.task, { id: t }));
    expect(card.payNote).toBeNull();
  });
});

describe("5. Hard stops stay hard", () => {
  test("switched off is refused, even with an acknowledgement", async () => {
    const t = await newTask(await newJob());
    const e = await failure(book(t, OFF, [WED], { assignAnyway: ack(OFF, [WARN]) }));
    expect(e.message).toContain("switched off");
    expect(e.data?.reason).not.toBe("assign_check");
  });

  test("Pay not set (no lines, no pay) is refused, even with an acknowledgement", async () => {
    const t = await newTask(await newJob(), []);
    const e = await failure(book(t, FIXED, [WED], { assignAnyway: ack(FIXED, []) }));
    expect(e.message).toContain("Pay not set");
    expect(await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [t])).toEqual([{ who: null }] as any);
  });

  test("offers stay strict: no offer goes out on a warning, and the refusal says how to book anyway", async () => {
    const t = await newTask(await newJob());
    const e = await failure(run(m.offers.sendDirect, { taskId: t, installerId: PEDRO }));
    expect(e.message.endsWith(" To give it to them anyway, book it directly and press Assign anyway.")).toBe(true);
    expect(await q("SELECT count(*) n FROM task_offers WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
    // Pay not set gives no such hint.
    const bare = await newTask(await newJob(), []);
    const p = await failure(run(m.offers.sendDirect, { taskId: bare, installerId: FIXED }));
    expect(p.message).not.toContain("Assign anyway");
  });

  test("allocation asks for the check before any split, and books with it", async () => {
    const j = await newJob();
    const t = await newTask(j, [[IT.dayOne, 1], [IT.dayLead, 1], [IT.tiles, 20]]);
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: t, itemIds: [IT.dayOne, IT.dayLead], installerId: PEDRO, dates: [ALLOC], arrivalStart: "07:00" });
    expect(review.stops).toEqual([]);
    expect(review.warnings.map((w: any) => w.text)).toEqual([WARN]);
    expect(review.payMethod.kind).toBe("hourly");

    const e = await failure(run(m.dispatches.allocate, { taskId: t, itemIds: [IT.dayOne, IT.dayLead], installerId: PEDRO, dates: [ALLOC], arrivalStart: "07:00" }));
    expect(e.data?.reason).toBe("assign_check");
    expect(await q("SELECT count(*) n FROM job_tasks WHERE job_id = ?", [j])).toEqual([{ n: 1 }] as any);

    const a = await run<any>(m.dispatches.allocate, {
      taskId: t, itemIds: [IT.dayOne, IT.dayLead], installerId: PEDRO, dates: [ALLOC], arrivalStart: "07:00", assignAnyway: ack(PEDRO, [WARN]), plannedHours: 8,
    });
    expect(a.split).toBe(true);
    expect(await q("SELECT assigned_installer_id who, pay_type, agreed_hourly_rate, planned_hours FROM job_tasks WHERE id = ?", [a.taskId])).toEqual([
      { who: PEDRO, pay_type: "hourly", agreed_hourly_rate: 47, planned_hours: 8 },
    ] as any);
    expect(await q("SELECT item_id FROM task_labour_lines WHERE task_id = ? ORDER BY item_id", [t])).toEqual([{ item_id: IT.tiles }] as any);
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ? AND action = 'assignment_override'", [a.taskId])).toEqual([{ n: 1 }] as any);
  });
});

describe("6. Nothing sent", () => {
  test("no push, no offer, no network call", async () => {
    expect(pushes).toEqual([]);
    expect(await q("SELECT count(*) n FROM task_offers")).toEqual([{ n: 0 }] as any);
    expect(blocked).toEqual([]);
  });
});
