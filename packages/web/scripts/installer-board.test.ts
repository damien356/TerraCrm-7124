/**
 * Installers & bookings on the job (Damien's brief, 11 Nov 2026, job 188070).
 *
 *   bun test scripts/installer-board.test.ts      (from packages/web)
 *
 * Runs the real board, assign, booking, offer, crew app and job status code
 * on a throwaway SQLite file built from the schema. Job 188070 is copied as
 * it is live: accepted quote with Carpet tile install 256 m², Hybrid
 * installation 135 m², Install trims/scotia 105 lm and carpet tiles to steps
 * 30, plus supply, freight and pick up lines. Its one dispatch carries only
 * the carpet tile and stairs lines, as live. Paul (19) and Fabrizio (24) are
 * copied with their live work categories. Sign in is faked; pushes and office
 * alerts are caught and every network call is blocked.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "installer-board-"));
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
const ADMIN: Who = { id: "t-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "t-office", name: "Test Office", email: "office@example.invalid" };
const OFFICE_COSTS: Who = { id: "t-office-costs", name: "Office With Costs", email: "office2@example.invalid" };
const PAUL_LOGIN: Who = { id: "t-paul", name: "Paul William Elmer", email: "paul@example.invalid" };
const FAB_LOGIN: Who = { id: "t-fab", name: "Fabrizio Boldrini", email: "fab@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

const PAUL = 19;
const FAB = 24;
const OTHER = 30; // a solo carpet layer, to show "suitable first"
const SK = { tiles: 2, stairs: 3, hybrid: 7, laminate: 8 };
const IT = { tiles: 4, stairs: 8, hybrid: 15, scotia: 111 };
const WED = "2026-11-18";
const THU = "2026-11-19";

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  board: typeof import("../src/api/routes/installer-board").installerBoard;
  tasksRoute: typeof import("../src/api/routes/tasks");
  offers: typeof import("../src/api/routes/offers").offers;
  field: typeof import("../src/api/routes/field").field;
  stage: typeof import("../src/api/lib/job-stage");
  availability: typeof import("../src/api/lib/availability");
  orm: typeof import("drizzle-orm");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in installer-board tests: ${String(input)}`);
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
    board: (await import("../src/api/routes/installer-board")).installerBoard,
    tasksRoute: await import("../src/api/routes/tasks"),
    offers: (await import("../src/api/routes/offers")).offers,
    field: (await import("../src/api/routes/field")).field,
    stage: await import("../src/api/lib/job-stage"),
    availability: await import("../src/api/lib/availability"),
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
const book = (taskId: number, installerId: number, dates: string[], extra: Record<string, unknown> = {}) =>
  run(m.tasksRoute.tasks.book, { taskId, installerId, dates, arrivalStart: "07:00", arrivalEnd: "15:00", durationHours: 8, coordinateAfterFirst: false, perDay: [], ...extra });

/* --------------------------------- fixtures --------------------------------- */

let siteId = 0;
let jobSeq = 188070;

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true });
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: "Test Office", email: OFFICE!.email, role: "office" });
  await db.insert(schema.profiles).values({ userId: OFFICE_COSTS!.id, name: "Office With Costs", email: OFFICE_COSTS!.email, role: "office", canSeeCosts: true } as any);
  for (const [id, name] of [[1, "Lead"], [2, "Quoted"], [3, "Won"], [4, "Scheduled"], [5, "In Progress"], [6, "Complete"], [7, "Invoiced"], [8, "Paid"], [9, "Cancelled"]] as const) {
    await db.insert(schema.jobStatuses).values({ id, name, active: true } as any);
  }
  for (const [id, name, groupName] of [
    [SK.tiles, "Carpet tiles", "carpet"],
    [SK.stairs, "Carpet stairs", "carpet"],
    [SK.hybrid, "Hybrid", "resilient"],
    [SK.laminate, "Laminate", "resilient"],
  ] as const) {
    await db.insert(schema.skills).values({ id, name, groupName, defaultCrewSize: 1 } as any);
  }
  for (const [id, name, crewCapacity, skills] of [
    [PAUL, "Paul William Elmer", "own_offsider", [SK.tiles, SK.stairs, SK.hybrid]],
    [FAB, "Fabrizio Boldrini", "solo", [SK.hybrid, SK.laminate]],
    [OTHER, "Carl Carpet", "solo", [SK.tiles, SK.stairs]],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, crewCapacity, active: true } as any);
    for (const skillId of skills) await db.insert(schema.installerSkills).values({ installerId: id, skillId } as any);
  }
  for (const [login, installerId] of [
    [PAUL_LOGIN, PAUL],
    [FAB_LOGIN, FAB],
  ] as const) {
    await db.insert(schema.profiles).values({ userId: login!.id, name: login!.name, email: login!.email, role: "field", installerId } as any);
  }
  for (const [id, name, unit, groupName, skillId] of [
    [IT.tiles, "Carpet tile install", "m2", "carpet", SK.tiles],
    [IT.stairs, "Carpet stairs, standard straight step", "step", "carpet", SK.stairs],
    [IT.hybrid, "Hybrid installation", "m2", "resilient", SK.hybrid],
    [IT.scotia, "Install trims/scotia", "lm", "resilient", SK.hybrid],
  ] as const) {
    await db.insert(schema.labourRateItems).values({ id, name, unit, groupName, skillId, kind: "work", active: true, restricted: false } as any);
  }
  // Terra's installer rates (pay), not the selling prices.
  for (const [itemId, amount] of [[IT.tiles, 10], [IT.stairs, 13], [IT.hybrid, 28], [IT.scotia, 8]] as const) {
    await db.insert(schema.labourRates).values({ itemId, installerId: null, amount, effectiveFrom: "2026-01-01" } as any);
  }
  const [site] = await db.insert(schema.sites).values({ address: "1 Test St, Brisbane", propertyType: "house" } as any).returning();
  siteId = site!.id;
}

/** A copy of 188070 as it is live: hybrid and scotia labour on the quote, on no dispatch. */
async function job188070(opts: { withHybridOnDispatch?: boolean } = {}) {
  const { db } = m;
  const [j] = await db.insert(schema.jobs).values({ number: jobSeq++, siteId, statusId: 3, furnitureMoving: false, furnitureOnSite: false } as any).returning();
  const jobId = j!.id;
  const [quote] = await db.insert(schema.quotes).values({ number: jobSeq, jobId, status: "accepted" } as any).returning();
  let sort = 0;
  const line = (description: string, qty: number, unit: string, kind: string, rateItemId: number | null) =>
    db.insert(schema.quoteItems).values({ quoteId: quote!.id, description, qty, unit, kind, rateItemId, unitPrice: 1, total: qty, sortOrder: sort++ } as any);
  await line("Airlay Geoform Plank in White Sands", 270, "m2", "supply", null);
  await line("Carpet tile install", 256, "m2", "labour", IT.tiles);
  await line("Supplier freight: Airlay", 1, "order", "supplier_charge", null);
  await line("Big Panda Titan Guard SPC Hybrid 6.5mm", 143.64, "m2", "supply", null);
  await line("Hybrid installation", 135, "m2", "labour", IT.hybrid);
  await line("Big Panda Scotia PVC/WPC", 41, "each", "supply", null);
  await line("Install trims/scotia", 105, "lm", "labour", IT.scotia);
  await line("Install carpet tiles to steps inc aluminium nosing install", 30, "each", "labour", IT.stairs);
  await line("Jocks pick up from Sublime", 1, "each", "delivery", null);

  const [t] = await db
    .insert(schema.jobTasks)
    .values({ jobId, seq: 1, title: "Carpet tile install + Hybrid installation + 1 more", skillId: SK.tiles, durationHours: 4, crewSize: 1, areaM2: 391, status: "unassigned", payType: "per_job" } as any)
    .returning();
  const lines: [number, number, string | null][] = [
    [IT.tiles, 256, null],
    ...(opts.withHybridOnDispatch ? ([[IT.hybrid, 135, null], [IT.scotia, 105, null]] as [number, number, null][]) : []),
    [IT.stairs, 30, "Quote line 560: carpet tiles to steps, aluminium nosing install included. No separate nosing pay."],
  ];
  let i = 0;
  for (const [itemId, qty, note] of lines) await db.insert(schema.taskLabourLines).values({ taskId: t!.id, itemId, qty, note, sortOrder: i++ } as any);
  await db.insert(schema.activityLog).values({ jobId, taskId: t!.id, entityType: "quote", entityId: quote!.id, action: "dispatch_made", detail: "Dispatch made from the quote" });
  return { jobId, taskId: t!.id, quoteId: quote!.id };
}

const board = (jobId: number, w: Who = ADMIN) => as(w, () => run<any>(m.board.board, { jobId }));
const lineOf = (b: any, itemId: number) => b.lines.find((l: any) => l.itemId === itemId);
const assign = (jobId: number, lineIds: number[], installerId: number | null, extra: Record<string, unknown> = {}, w: Who = ADMIN) =>
  as(w, () => run<any>(m.board.assign, { jobId, lineIds, installerId, ...extra }));
const tasksOf = (jobId: number) => q("SELECT id, status, assigned_installer_id who, labour_cost, pay_amount, scheduled_date FROM job_tasks WHERE job_id = ? ORDER BY id", [jobId]);
const qtys = (jobId: number) =>
  q("SELECT l.item_id item, sum(l.qty) qty, count(*) n FROM task_labour_lines l JOIN job_tasks t ON t.id = l.task_id WHERE t.job_id = ? GROUP BY l.item_id ORDER BY l.item_id", [jobId]);

/** 188070 with the labour back and both people on it, not booked. */
async function allocated() {
  const ids = await job188070();
  await run(m.board.restoreLabour, { jobId: ids.jobId });
  const b = await board(ids.jobId);
  await assign(ids.jobId, [lineOf(b, IT.hybrid).lineId, lineOf(b, IT.scotia).lineId], FAB);
  const b2 = await board(ids.jobId);
  await assign(ids.jobId, b2.lines.filter((l: any) => l.state === "unassigned").map((l: any) => l.lineId), PAUL);
  const b3 = await board(ids.jobId);
  const fabTask = b3.cards.find((c: any) => c.installer.id === FAB).visits[0].taskId as number;
  const paulTask = b3.cards.find((c: any) => c.installer.id === PAUL).visits[0].taskId as number;
  return { ...ids, fabTask, paulTask };
}

/* ---------------------------------- checks ---------------------------------- */

describe("1. Why Fabrizio could not be chosen", () => {
  test("the hybrid and scotia labour is on the quote but on no dispatch, and the board says so", async () => {
    const { jobId } = await job188070();
    const b = await board(jobId);
    expect(b.lines.map((l: any) => [l.name, l.qty, l.unit])).toEqual([
      ["Carpet tile install", 256, "m2"],
      ["Carpet stairs, standard straight step", 30, "step"],
    ]);
    expect(b.missing.map((x: any) => [x.name, x.missing, x.unit])).toEqual([
      ["Hybrid installation", 135, "m2"],
      ["Install trims/scotia", 105, "lm"],
    ]);
    // On the remaining work he is not ticked for either category: shown, with the exact reason, after the suitable people.
    const people = await run<any[]>(m.board.people, { jobId, lineIds: b.lines.map((l: any) => l.lineId) });
    const fab = people.find((p) => p.id === FAB)!;
    expect(fab.suitable).toBe(false);
    expect(fab.warnings.some((w: any) => w.kind === "skill")).toBe(true);
    expect(people.findIndex((p) => p.id === FAB)).toBeGreaterThan(people.findIndex((p) => p.id === PAUL));
    expect(people.find((p) => p.id === PAUL)!.suitable).toBe(true);
  });

  test("Put back on the job restores the quote's quantities onto the quote's own dispatch, no new dispatch, no price change", async () => {
    const { jobId, taskId } = await job188070();
    const quoteBefore = await q("SELECT id, qty, unit_price, total FROM quote_items ORDER BY id");
    const r = await as(OFFICE, () => run<any>(m.board.restoreLabour, { jobId }));
    expect(r.taskId).toBe(taskId);
    expect(await qtys(jobId)).toEqual([
      { item: IT.tiles, qty: 256, n: 1 },
      { item: IT.stairs, qty: 30, n: 1 },
      { item: IT.hybrid, qty: 135, n: 1 },
      { item: IT.scotia, qty: 105, n: 1 },
    ] as any);
    expect((await tasksOf(jobId)).length).toBe(1);
    expect(await q("SELECT id, qty, unit_price, total FROM quote_items ORDER BY id")).toEqual(quoteBefore);
    expect((await board(jobId)).missing).toEqual([]);
    // Twice does nothing more.
    expect((await failure(run(m.board.restoreLabour, { jobId }))).message).toContain("already on the job");
    expect(await qtys(jobId)).toHaveLength(4);
    const log = await q("SELECT action, detail FROM activity_log WHERE job_id = ? AND action = 'labour_restored'", [jobId]);
    expect(log).toHaveLength(1);
    expect(log[0].detail).toContain("Hybrid installation 135 m²");
  });

  test("materials, freight and pick up never become labour", async () => {
    const { jobId } = await job188070();
    await run(m.board.restoreLabour, { jobId });
    const names = (await board(jobId)).lines.map((l: any) => l.name);
    expect(names.some((n: string) => /Airlay|Panda|freight|pick up/i.test(n))).toBe(false);
  });
});

describe("2. Assign selected work", () => {
  test("Fabrizio gets hybrid + scotia, Paul the carpet tiles and stairs: two dispatches, paid once each, nothing sent", async () => {
    const sentBefore = pushes.length;
    const alertsBefore = alerts.length;
    const { jobId, taskId, fabTask, paulTask } = await allocated();
    expect(paulTask).toBe(taskId); // the original dispatch stays, no duplicate
    const tasks = await tasksOf(jobId);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === fabTask)).toMatchObject({ who: FAB, status: "assigned", labour_cost: 4620, scheduled_date: null });
    expect(tasks.find((t) => t.id === paulTask)).toMatchObject({ who: PAUL, status: "assigned", labour_cost: 2950, scheduled_date: null });
    // Same quantities and units as the quote: stairs 30, once.
    expect(await qtys(jobId)).toEqual([
      { item: IT.tiles, qty: 256, n: 1 },
      { item: IT.stairs, qty: 30, n: 1 },
      { item: IT.hybrid, qty: 135, n: 1 },
      { item: IT.scotia, qty: 105, n: 1 },
    ] as any);
    const paulLines = await q("SELECT item_id, qty, note FROM task_labour_lines WHERE task_id = ? ORDER BY item_id", [paulTask]);
    expect(paulLines.map((l) => [l.item_id, l.qty])).toEqual([[IT.tiles, 256], [IT.stairs, 30]]);
    expect(paulLines[1].note).toContain("aluminium nosing install included");
    // No offers, no pushes, no network, no task day.
    expect(await q("SELECT count(*) n FROM task_offers t JOIN job_tasks j ON j.id = t.task_id WHERE j.job_id = ?", [jobId])).toEqual([{ n: 0 }] as any);
    expect(await q("SELECT count(*) n FROM task_days d JOIN job_tasks j ON j.id = d.task_id WHERE j.job_id = ?", [jobId])).toEqual([{ n: 0 }] as any);
    expect(pushes.length).toBe(sentBefore);
    expect(alerts.length).toBe(alertsBefore);
    expect(blocked).toEqual([]);
    // History says no message went.
    const logs = await q("SELECT detail FROM activity_log WHERE job_id = ? AND action = 'assigned'", [jobId]);
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => String(l.detail).includes("No offer or message sent."))).toBe(true);
    // One job, one quote.
    expect(await q("SELECT count(*) n FROM quotes WHERE job_id = ?", [jobId])).toEqual([{ n: 1 }] as any);
  });

  test("the board: one card each, counts, crew titles name only their own work", async () => {
    const { jobId, fabTask, paulTask } = await allocated();
    const b = await board(jobId);
    expect(b.cards.map((c: any) => [c.installer.name, c.pay, c.lineCount])).toEqual([
      ["Fabrizio Boldrini", 4620, 2],
      ["Paul William Elmer", 2950, 2],
    ]);
    expect(b.counts).toEqual({ lines: 4, unassigned: 0, unbooked: 4, booked: 0 });
    const titles = await q("SELECT id, title FROM job_tasks WHERE id IN (?, ?)", [fabTask, paulTask]);
    expect(titles.find((t) => t.id === fabTask).title).toBe("Hybrid installation + Install trims/scotia");
    expect(titles.find((t) => t.id === paulTask).title).toBe("Carpet tile install + Carpet stairs, standard straight step");
  });

  test("Office without cost access sees the people and work but no pay; Office with it and the admin see each person's own pay", async () => {
    const { jobId } = await allocated();
    const office = await board(jobId, OFFICE);
    expect(office.canSeePay).toBe(false);
    expect(office.cards.map((c: any) => c.pay)).toEqual([null, null]);
    expect(office.cards.flatMap((c: any) => c.visits.map((v: any) => v.pay))).toEqual([null, null]);
    expect(JSON.stringify(office)).not.toContain("4620");
    expect(JSON.stringify(office)).not.toContain("2950");
    // Office can still assign.
    const costs = await board(jobId, OFFICE_COSTS);
    expect(costs.cards.map((c: any) => c.pay)).toEqual([4620, 2950]);
    // The picker shows no rates to the office.
    const people = await as(OFFICE, () => run<any[]>(m.board.people, { jobId, lineIds: [office.lines[0].lineId] }));
    expect(people.every((p) => p.payMethod?.rate == null)).toBe(true);
  });

  test("a warning needs Assign anyway, and is written on the history; the person's profile is not changed", async () => {
    const { jobId } = await job188070();
    const b = await board(jobId);
    const ids = b.lines.map((l: any) => l.lineId);
    const e = await failure(assign(jobId, ids, FAB, {}, OFFICE));
    expect(e.data?.reason).toBe("assign_check");
    expect((await tasksOf(jobId))[0].who).toBeNull();
    const skillsBefore = await q("SELECT skill_id FROM installer_skills WHERE installer_id = ? ORDER BY skill_id", [FAB]);
    await assign(jobId, ids, FAB, { assignAnyway: [{ installerId: FAB, warnings: e.data.warnings.map((w: any) => w.text), note: "He has done stairs before" }] }, OFFICE);
    expect((await tasksOf(jobId))[0].who).toBe(FAB);
    expect(await q("SELECT skill_id FROM installer_skills WHERE installer_id = ? ORDER BY skill_id", [FAB])).toEqual(skillsBefore);
    expect(await q("SELECT count(*) n FROM activity_log WHERE job_id = ? AND action = 'assignment_override'", [jobId])).toEqual([{ n: 1 }] as any);
  });
});

describe("3. Booking each person", () => {
  test("both booked for the same day and time on the same job: not a clash; each keeps their own times", async () => {
    const { jobId, fabTask, paulTask } = await allocated();
    await book(fabTask, FAB, [WED]);
    await book(paulTask, PAUL, [WED, THU], { arrivalStart: "07:00", arrivalEnd: "15:00" });
    const daysOf = async (id: number) => (await q("SELECT date, arrival_start FROM task_days WHERE task_id = ? ORDER BY date", [id])).map((d) => [d.date, d.arrival_start]);
    expect(await daysOf(fabTask)).toEqual([[WED, "07:00"]]);
    expect(await daysOf(paulTask)).toEqual([[WED, "07:00"], [THU, "07:00"]]);
    // Paul on the same job at the same time is not a clash for Fabrizio, and the other way round.
    const times = { durationHours: 8, days: [{ date: WED, arrivalStart: "07:00", arrivalEnd: "15:00" }] };
    for (const [installerId, exceptTaskId] of [[FAB, fabTask], [PAUL, paulTask]] as const) {
      const check = await m.availability.checkDays({ installerId, dates: [WED], exceptTaskId, times });
      expect(check.flatMap((c) => c.clashes)).toEqual([]);
    }
    const b = await board(jobId);
    expect(b.counts).toEqual({ lines: 4, unassigned: 0, unbooked: 0, booked: 4 });
    // Editing Fabrizio's booking leaves Paul's alone.
    await book(fabTask, FAB, [THU], { arrivalStart: "08:00", arrivalEnd: "12:00", durationHours: 4 });
    expect((await q("SELECT date, arrival_start FROM task_days WHERE task_id = ? ORDER BY date", [paulTask])).map((d) => [d.date, d.arrival_start])).toEqual([
      [WED, "07:00"],
      [THU, "07:00"],
    ]);
    expect(pushes.length).toBeGreaterThanOrEqual(0);
    expect(await q("SELECT count(*) n FROM task_offers t JOIN job_tasks j ON j.id = t.task_id WHERE j.job_id = ?", [jobId])).toEqual([{ n: 0 }] as any);
  });

  test("before 6am still needs the office's confirm, on that person's booking only", async () => {
    const { fabTask, paulTask } = await allocated();
    await book(paulTask, PAUL, [WED]);
    const e = await failure(book(fabTask, FAB, [WED], { arrivalStart: "05:00", arrivalEnd: "05:30" }));
    expect(e.data?.reason).toBe("outside_hours");
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [fabTask])).toEqual([{ n: 0 }] as any);
    await book(fabTask, FAB, [WED], { arrivalStart: "05:00", arrivalEnd: "05:30", confirmOutsideHours: true });
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [fabTask])).toEqual([{ n: 1 }] as any);
    expect((await q("SELECT date, arrival_start FROM task_days WHERE task_id = ?", [paulTask])).map((d) => [d.date, d.arrival_start])).toEqual([[WED, "07:00"]]);
  });

  test("each crew login sees only its own visit and its own pay", async () => {
    const { fabTask, paulTask } = await allocated();
    await book(fabTask, FAB, [WED]);
    await book(paulTask, PAUL, [WED]);
    const fab = await as(FAB_LOGIN, () => run<any[]>(m.field.upcoming, { from: WED, to: THU }));
    const paul = await as(PAUL_LOGIN, () => run<any[]>(m.field.upcoming, { from: WED, to: THU }));
    const fabMine = fab.filter((c) => c.id === fabTask || c.id === paulTask);
    const paulMine = paul.filter((c) => c.id === fabTask || c.id === paulTask);
    expect(fabMine.map((c) => c.id)).toEqual([fabTask]);
    expect(paulMine.map((c) => c.id)).toEqual([paulTask]);
    expect(fabMine[0].payTotal).toBe(4620);
    expect(paulMine[0].payTotal).toBe(2950);
    expect(JSON.stringify(fabMine)).not.toContain("Carpet tile install");
    expect(JSON.stringify(paulMine)).not.toContain("Hybrid installation");
    // Opening the other person's visit is refused.
    const e = await failure(as(FAB_LOGIN, () => run(m.field.task, { id: paulTask })));
    expect(String(e.message)).not.toContain("Carpet tile install");
  });
});

describe("4. Changing who has it", () => {
  test("booked work needs the change confirmed; then the booking comes off and nobody is paid twice", async () => {
    const { jobId, fabTask, paulTask } = await allocated();
    await book(fabTask, FAB, [WED]);
    const b = await board(jobId);
    const hybridLines = b.lines.filter((l: any) => l.taskId === fabTask).map((l: any) => l.lineId);
    const e = await failure(assign(jobId, hybridLines, PAUL));
    expect(e.data?.reason).toBe("replace_installer");
    expect(e.message).toContain("Fabrizio Boldrini's booking on");
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [fabTask])).toEqual([{ n: 1 }] as any);

    await assign(jobId, hybridLines, PAUL, { replaceInstaller: true });
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [fabTask])).toEqual([{ n: 0 }] as any);
    const tasks = await tasksOf(jobId);
    // Paul's unbooked visit took the hybrid lines: one visit, one pay.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: paulTask, who: PAUL, labour_cost: 7570 });
    expect(await qtys(jobId)).toHaveLength(4);
    expect((await q("SELECT count(*) n FROM activity_log WHERE job_id = ? AND action = 'allocation_changed'", [jobId]))[0].n).toBe(1);
  });

  test("an open offer is withdrawn only after the change is confirmed; part of a dispatch can move", async () => {
    const { jobId, fabTask } = await allocated();
    await run(m.offers.sendDirect, { taskId: fabTask, installerId: FAB });
    expect(pushes.at(-1)).toBe(FAB);
    const b = await board(jobId);
    expect(b.cards.find((c: any) => c.installer.id === FAB).visits[0].state).toBe("offered");
    const scotia = lineOf(b, IT.scotia).lineId;
    const e = await failure(assign(jobId, [scotia], PAUL));
    expect(e.data?.reason).toBe("replace_installer");
    expect(await q("SELECT status FROM task_offers WHERE task_id = ?", [fabTask])).toEqual([{ status: "pending" }] as any);
    await assign(jobId, [scotia], PAUL, { replaceInstaller: true });
    expect(await q("SELECT status FROM task_offers WHERE task_id = ?", [fabTask])).toEqual([{ status: "withdrawn" }] as any);
    const fab = (await q("SELECT who, labour_cost FROM (SELECT assigned_installer_id who, labour_cost, id FROM job_tasks) WHERE id = ?", [fabTask]))[0];
    expect(fab).toMatchObject({ who: FAB, labour_cost: 3780 });
    const b2 = await board(jobId);
    expect(b2.cards.find((c: any) => c.installer.id === PAUL).pay).toBe(2950 + 840);
  });

  test("started or done work never moves, and one person finishing does not complete the job", async () => {
    const { jobId, fabTask, paulTask } = await allocated();
    await book(fabTask, FAB, [WED]);
    await book(paulTask, PAUL, [WED]);
    await m.db.update(schema.jobTasks).set({ status: "complete" }).where(m.orm.eq(schema.jobTasks.id, fabTask));
    await m.stage.syncJobFromTasks(jobId, { name: "Test", role: "admin" } as any);
    const [job] = await q("SELECT status_id FROM jobs WHERE id = ?", [jobId]);
    expect(job.status_id).not.toBe(6);
    const b = await board(jobId);
    const e = await failure(assign(jobId, b.lines.filter((l: any) => l.taskId === fabTask).map((l: any) => l.lineId), PAUL, { replaceInstaller: true }));
    expect(e.data?.reason).toBe("board_stopped");
    expect((await tasksOf(jobId)).find((t) => t.id === fabTask)).toMatchObject({ who: FAB, status: "complete", labour_cost: 4620 });
  });

  test("work with an installer invoice on it never moves", async () => {
    const { jobId, fabTask } = await allocated();
    await m.db.insert(schema.installerInvoices).values({ taskId: fabTask, jobId, installerId: FAB, invoiceNumber: 1 } as any);
    const b = await board(jobId);
    const before = await tasksOf(jobId);
    const e = await failure(assign(jobId, b.lines.filter((l: any) => l.taskId === fabTask).map((l: any) => l.lineId), PAUL, { replaceInstaller: true }));
    expect(e.data?.reason).toBe("board_stopped");
    expect(e.message).toContain("installer invoice");
    expect(await tasksOf(jobId)).toEqual(before);
  });

  test("2-man work is never given to a solo person", async () => {
    const { jobId, taskId } = await job188070();
    await m.db.update(schema.jobTasks).set({ crewSize: 2 }).where(m.orm.eq(schema.jobTasks.id, taskId));
    const b = await board(jobId);
    const people = await run<any[]>(m.board.people, { jobId, lineIds: b.lines.map((l: any) => l.lineId) });
    expect(people.find((p) => p.id === OTHER)!.stops.length).toBe(1);
    const e = await failure(assign(jobId, b.lines.map((l: any) => l.lineId), OTHER));
    expect(e.data?.reason).toBe("board_stopped");
  });
});

describe("5. Dispatch names after Split by trade (Damien, 11 Nov, 188070-A kept the old name)", () => {
  const dispatches = async () => (await import("../src/api/routes/dispatches")).dispatches;
  const names = (jobId: number) => q("SELECT seq, title FROM job_tasks WHERE job_id = ? AND status <> 'cancelled' ORDER BY seq", [jobId]);

  test("the rule: named after its work, '+ N more', a typed name, and a name the office gave it", async () => {
    const { leftBehindName, nameFromWork } = await import("../src/api/lib/dispatch-names");
    expect(nameFromWork(["A", "B", "C", "D"])).toBe("A + B + 2 more");
    expect(leftBehindName("Carpet tile install + Hybrid installation + 1 more", ["Hybrid installation", "Install trims/scotia"], ["Carpet tile install", "Carpet stairs"])).toBe(
      "Carpet tile install + Carpet stairs",
    );
    expect(leftBehindName("Install + prep + 3 more", ["Uplift"], ["Install"])).toBe("Install");
    expect(leftBehindName("Downstairs", ["Hybrid installation"], ["Carpet tile install"])).toBeNull();
    expect(leftBehindName("Downstairs", ["Hybrid installation"], ["Carpet tile install"], "  Upstairs carpet  ")).toBe("Upstairs carpet");
    expect(leftBehindName("Same", ["x"], ["y"], "Same")).toBeNull();
  });

  test("Split by trade renames what stays to the work still on it; the new one keeps its typed name; the history says so", async () => {
    const { jobId, taskId } = await job188070({ withHybridOnDispatch: true });
    const d = await dispatches();
    const created = await run<any>(d.split, { taskId, itemIds: [IT.hybrid, IT.scotia], title: "Hybrid + Scotia install" });
    expect(await names(jobId)).toEqual([
      { seq: 1, title: "Carpet tile install + Carpet stairs, standard straight step" },
      { seq: 2, title: "Hybrid + Scotia install" },
    ]);
    const [log] = await q("SELECT detail FROM activity_log WHERE task_id = ? AND action = 'dispatch_split'", [created.id]);
    expect(log.detail).toContain('The dispatch left behind is now "Carpet tile install + Carpet stairs, standard straight step"');
    // Work, quantities and pay basis are untouched by the name.
    expect((await qtys(jobId)).map((r: any) => [r.item, r.qty])).toEqual([[IT.tiles, 256], [IT.stairs, 30], [IT.hybrid, 135], [IT.scotia, 105]]);
  });

  test("a name typed for what stays wins, and a name the office gave it is kept when left blank", async () => {
    const a = await job188070({ withHybridOnDispatch: true });
    const d = await dispatches();
    await run(d.split, { taskId: a.taskId, itemIds: [IT.hybrid, IT.scotia], title: null, keepTitle: "Carpet tiles + stairs" });
    expect((await names(a.jobId))[0].title).toBe("Carpet tiles + stairs");

    const b = await job188070({ withHybridOnDispatch: true });
    await client.execute({ sql: "UPDATE job_tasks SET title = 'Level 2 fit-out' WHERE id = ?", args: [b.taskId] });
    await run(d.split, { taskId: b.taskId, itemIds: [IT.hybrid, IT.scotia], title: null });
    expect((await names(b.jobId)).map((r: any) => r.title)).toEqual(["Level 2 fit-out", "Hybrid installation, Install trims/scotia"]);
  });

  test("Rename changes only the name, even on booked work, goes on the history, and refuses a blank name", async () => {
    const { jobId, taskId } = await job188070({ withHybridOnDispatch: true });
    const d = await dispatches();
    await book(taskId, PAUL, [WED]);
    const before = (await q("SELECT status, assigned_installer_id, scheduled_date, labour_cost FROM job_tasks WHERE id = ?", [taskId]))[0];
    const days = await q("SELECT date, status FROM task_days WHERE task_id = ? ORDER BY date", [taskId]);
    await as(OFFICE, () => run(d.rename, { taskId, title: "  Carpet tiles + stairs  " }));
    expect((await names(jobId))[0].title).toBe("Carpet tiles + stairs");
    expect((await q("SELECT status, assigned_installer_id, scheduled_date, labour_cost FROM job_tasks WHERE id = ?", [taskId]))[0]).toEqual(before);
    expect(await q("SELECT date, status FROM task_days WHERE task_id = ? ORDER BY date", [taskId])).toEqual(days);
    const [log] = await q("SELECT detail, actor_name FROM activity_log WHERE task_id = ? AND action = 'dispatch_renamed'", [taskId]);
    expect(log.detail).toBe('Dispatch renamed from "Carpet tile install + Hybrid installation + 1 more" to "Carpet tiles + stairs"');
    expect(log.actor_name).toBe("Test Office");
    expect(await failure(run(d.rename, { taskId, title: "   " }))).toBeTruthy();
    expect((await names(jobId))[0].title).toBe("Carpet tiles + stairs");
    expect(blocked).toEqual([]);
  });
});
