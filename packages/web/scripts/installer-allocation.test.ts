/**
 * Installer allocation, rates and booking (Damien's brief, 7 Nov 2026).
 *
 *   bun test scripts/installer-allocation.test.ts      (from packages/web)
 *
 * Runs the real allocation, booking, picker, rate card, hourly and invoice
 * code on a throwaway SQLite file built from the schema. The job is a copy of
 * job 4297 as it is live (quote 81 and dispatch 69: carpet tiles 256 m2,
 * hybrid 135 m2, trims/scotia 105 lm, all on one carpet tile dispatch), with
 * Paul (19) and Fabrizio (24) and the live rate book rows those lines use.
 * Sign in is faked. Office alerts and pushes are caught, and every network
 * call is blocked, so nothing leaves the machine.
 *
 * Acceptance checks (brief section 7) map to the describe blocks:
 *   1  Fabrizio in the picker, with reasons for anyone who can't take it
 *   2  Allocate some lines to Fabrizio and the rest to Paul, paid once
 *   3  Same-day bookings that don't overlap, and the ones that do
 *   4  Outside 6:00 am-6:00 pm needs a confirm, and it is recorded
 *   5  Never a silent swap of installer
 *   6  Day rates per contractor, off by default, history kept
 *   7  Contractor labor - per hour: $0.00 blocks, agreed rate kept, no double pay
 *   8  Nosing never paid on top of a stair rate; the migration file
 *   9  $0.00 is "Rate not set" (Damien, 7 Nov): blocks the picker, offers,
 *      booking, allocation and pay approval, never an hourly man's hourly
 *      rate; and the job 4297 stairs line (sql/2026-12-04), 30 steps at the
 *      installer's stair rate, nosing included, paid once
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "installer-allocation-"));
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
const alerts: string[] = [];
const pushes: number[] = [];

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "test-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "test-office", name: "Test Office", email: "office@example.invalid" };
const FAB_LOGIN: Who = { id: "test-fabrizio", name: "Fabrizio", email: "fab@example.invalid" };
const PAUL_LOGIN: Who = { id: "test-paul", name: "Paul", email: "paul@example.invalid" };
const NORATE_LOGIN: Who = { id: "test-norate", name: "No Rate", email: "norate@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

// Ids as they are live.
const PAUL = 19;
const DAMIEN = 20;
const FAB = 24;
const HOURLY = 18; // the live hourly man, base $10
const NORATE = 31; // an hourly man whose rate was never set ($0.00)
const SK = { tiles: 2, stairs: 3, hybrid: 7, nosings: 26 };
const IT = { tiles: 4, stairs: 8, hybrid: 15, trims: 111, nosingFit: 67, nosingRefit: 68, dayOne: 73, dayTwo: 74, dayLead: 103 };

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  orm: typeof import("drizzle-orm");
  alloc: typeof import("../src/api/lib/allocate");
  avail: typeof import("../src/api/lib/availability");
  cal: typeof import("../src/api/lib/calendar-availability");
  hours: typeof import("../src/api/lib/outside-hours");
  hourly: typeof import("../src/api/lib/hourly");
  skills: typeof import("../src/api/lib/task-skills");
  tasksRoute: typeof import("../src/api/routes/tasks");
  installers: typeof import("../src/api/routes/installers").installers;
  labour: typeof import("../src/api/routes/labour").labour;
  offers: typeof import("../src/api/routes/offers").offers;
  dispatches: typeof import("../src/api/routes/dispatches").dispatches;
  invoices: typeof import("../src/api/routes/installerInvoices").installerInvoices;
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in installer-allocation tests: ${String(input)}`);
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
  // Damien's Google calendar, as if read live: busy 12:00-13:00 Brisbane on Friday 20 Nov.
  const realGoogle = await import("../src/api/lib/google-calendar");
  mock.module("../src/api/lib/google-calendar", () => ({
    ...realGoogle,
    freeBusy: async () => [{ startAt: Date.parse("2026-11-20T12:00:00+10:00"), endAt: Date.parse("2026-11-20T13:00:00+10:00") }],
  }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    orm: await import("drizzle-orm"),
    alloc: await import("../src/api/lib/allocate"),
    avail: await import("../src/api/lib/availability"),
    cal: await import("../src/api/lib/calendar-availability"),
    hours: await import("../src/api/lib/outside-hours"),
    hourly: await import("../src/api/lib/hourly"),
    skills: await import("../src/api/lib/task-skills"),
    tasksRoute: await import("../src/api/routes/tasks"),
    installers: (await import("../src/api/routes/installers")).installers,
    labour: (await import("../src/api/routes/labour")).labour,
    offers: (await import("../src/api/routes/offers")).offers,
    dispatches: (await import("../src/api/routes/dispatches")).dispatches,
    invoices: (await import("../src/api/routes/installerInvoices")).installerInvoices,
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
/** The error a call threw, so its reason can be read. */
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
const AGENT = () => actor({ userId: "system:retell-agent", name: "Phone agent", profileId: null, isMainAdmin: false });

/* --------------------------------- fixtures --------------------------------- */

let siteId = 0;
let jobSeq = 4297;
const JOB = 4297;

async function newJob(answered = true) {
  const [j] = await m.db
    .insert(schema.jobs)
    .values({ number: jobSeq++, siteId: answered ? siteId : null, furnitureMoving: answered ? false : null } as any)
    .returning();
  return j!.id;
}

async function newTask(jobId: number, title: string, skillId: number | null, lines: [number, number][], over: Record<string, unknown> = {}) {
  const [t] = await m.db
    .insert(schema.jobTasks)
    .values({ jobId, title, skillId, durationHours: 8, status: "unassigned", ...over } as any)
    .returning();
  let i = 0;
  for (const [itemId, qty] of lines) await m.db.insert(schema.taskLabourLines).values({ taskId: t!.id, itemId, qty, sortOrder: i++ } as any);
  return t!.id;
}

async function seed() {
  const { db } = m;
  // The admin is profile 1, so the actor above matches the signed-in Admin.
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true });
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: "Test Office", email: OFFICE!.email, role: "office" });

  for (const [id, name, groupName] of [
    [SK.tiles, "Carpet tiles", "carpet"],
    [SK.stairs, "Carpet stairs", "carpet"],
    [SK.hybrid, "Hybrid", "resilient"],
    [SK.nosings, "Nosings", "trades"],
  ] as const) {
    await db.insert(schema.skills).values({ id, name, groupName } as any);
  }
  for (const [id, name, crewCapacity, skills] of [
    [PAUL, "Paul", "own_offsider", [SK.tiles, SK.stairs, SK.hybrid]],
    [DAMIEN, "Damien", "solo", [SK.tiles, SK.hybrid]],
    [FAB, "Fabrizio", "solo", [SK.hybrid]],
    [HOURLY, "Hourly Man", "solo", [SK.hybrid]],
    [NORATE, "No Rate", "solo", [SK.hybrid]],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, crewCapacity, active: true } as any);
    for (const skillId of skills) await db.insert(schema.installerSkills).values({ installerId: id, skillId } as any);
  }
  for (const [login, installerId] of [
    [FAB_LOGIN, FAB],
    [PAUL_LOGIN, PAUL],
    [NORATE_LOGIN, NORATE],
  ] as const) {
    await db.insert(schema.profiles).values({ userId: login!.id, name: login!.name, email: login!.email, role: "field", installerId } as any);
  }
  // Only Damien has a calendar link live, with 15 minutes either side.
  const [admin] = await db.select().from(schema.profiles).where(m.orm.eq(schema.profiles.userId, ADMIN!.id));
  await db.insert(schema.calendarLinks).values({ installerId: DAMIEN, ownerProfileId: admin!.id, bufferBeforeMin: 15, bufferAfterMin: 15 } as any);

  // The live rate book rows. The three day rates are per contractor (restricted).
  for (const [id, name, unit, groupName, skillId, amount, restricted] of [
    [IT.tiles, "Carpet tile install", "m2", "carpet", SK.tiles, 10, false],
    [IT.stairs, "Carpet stairs, standard straight step", "step", "carpet", SK.stairs, 13, false],
    [IT.hybrid, "Hybrid installation", "m2", "resilient", SK.hybrid, 28, false],
    [IT.trims, "Install trims/scotia", "lm", "resilient", SK.hybrid, 8, false],
    [IT.nosingFit, "Nosing supply and fit", "lm", "trades", SK.nosings, null, false],
    [IT.nosingRefit, "Remove and reinstall existing nosing", "each", "trades", SK.nosings, null, false],
    [IT.dayOne, "Day rate, one man", "day", "other", null, 320, true],
    [IT.dayTwo, "Day rate, two man crew", "day", "other", null, 640, true],
    [IT.dayLead, "Day rate, leading hand", "day", "other", null, 580, true],
  ] as const) {
    await db.insert(schema.labourRateItems).values({ id, name, unit, groupName, skillId, kind: "work", active: true, restricted } as any);
    if (amount != null) await db.insert(schema.labourRates).values({ itemId: id, amount, effectiveFrom: "2026-01-01" } as any);
  }

  // Hourly terms: the live man at $10, and one whose rate was left at $0.00.
  await db.insert(schema.installerPayTerms).values({ installerId: HOURLY, baseRate: 10, defaultForNew: true, effectiveFrom: "2026-01-01" } as any);
  await db.insert(schema.installerPayTerms).values({ installerId: NORATE, baseRate: 0, defaultForNew: true, effectiveFrom: "2026-01-01" } as any);

  const [site] = await db.insert(schema.sites).values({ address: "1 Test St, Brisbane", propertyType: "house" } as any).returning();
  siteId = site!.id;

  // Job 4297 and its accepted quote 81, as live.
  const jobId = await newJob();
  const [quote] = await db.insert(schema.quotes).values({ number: 81, jobId, status: "accepted" } as any).returning();
  for (const [kind, description, qty, unit, rateItemId] of [
    ["supply", "Carpet tiles", 256, "m2", null],
    ["labour", "Carpet tile install", 256, "m2", IT.tiles],
    ["supplier_charge", "Supplier freight", 1, "each", null],
    ["supply", "Hybrid flooring", 135, "m2", null],
    ["labour", "Hybrid installation", 135, "m2", IT.hybrid],
    ["supplier_charge", "Supplier freight", 1, "each", null],
    ["supply", "Scotia", 105, "lm", null],
    ["labour", "Install trims/scotia", 105, "lm", IT.trims],
    ["supply", "Aluminium nosing", 36, "lm", null],
    ["supply", "Nosing end caps", 11, "each", null],
    ["labour", "Install carpet tiles to steps inc aluminium nosing install", 30, "each", null],
    ["delivery", "Delivery", 1, "each", null],
  ] as const) {
    await db.insert(schema.quoteItems).values({ quoteId: quote!.id, kind, description, qty, unit, rateItemId } as any);
  }
  // Dispatch 69: every labour line on one carpet tile dispatch, as split live.
  await newTask(jobId, "Carpet tiles", SK.tiles, [
    [IT.tiles, 256],
    [IT.hybrid, 135],
    [IT.trims, 105],
  ], { id: 69, areaM2: 391 });
}

// Mondays to Fridays in late November, so no weekend rule is involved.
const MON = "2026-11-16";
const TUE = "2026-11-17";
const WED = "2026-11-18";
const THU = "2026-11-19";
const FRI = "2026-11-20";

/* ---------------------------------- checks ---------------------------------- */

describe("1. Fabrizio in the installer picker", () => {
  test("cause: the old picker took the first line's skill and inner-joined on it, so Fabrizio was left out silently", async () => {
    // The old query, as it was: installers ticked for task.skillId, nobody else.
    const old = await q(
      `SELECT i.name FROM installers i JOIN installer_skills s ON s.installer_id = i.id
        WHERE s.skill_id = (SELECT skill_id FROM job_tasks WHERE id = 69) ORDER BY i.name`,
    );
    expect(old.map((r) => r.name)).not.toContain("Fabrizio");
    expect((await m.skills.skillsForTask(69)).map((s) => s.name).sort()).toEqual(["Carpet tiles", "Hybrid"]);
  });

  test("now everyone is listed: the whole dispatch shows Fabrizio with the reason, and the hybrid lines list him as eligible", async () => {
    const whole = await run<any[]>(m.installers.eligible, { taskId: 69 });
    const fab = whole.find((r) => r.id === FAB)!;
    expect(fab).toBeDefined();
    expect(fab.eligible).toBe(false);
    expect(fab.missingSkills).toEqual(["Carpet tiles"]);
    expect(fab.reasons).toContain("Not ticked for Carpet tiles");
    expect(whole.find((r) => r.id === PAUL)!.eligible).toBe(true);

    const hybrid = await run<any[]>(m.installers.eligible, { taskId: 69, itemIds: [IT.hybrid, IT.trims] });
    expect(hybrid.find((r) => r.id === FAB)!.eligible).toBe(true);
    expect(hybrid.find((r) => r.id === FAB)!.reasons).toEqual([]);
    const tiles = await run<any[]>(m.installers.eligible, { taskId: 69, itemIds: [IT.tiles] });
    expect(tiles.find((r) => r.id === FAB)!.eligible).toBe(false);
    expect(tiles.find((r) => r.id === PAUL)!.eligible).toBe(true);
  });

  test("Office sees the people and the reasons but never a rate", async () => {
    const rows = await as(OFFICE, () => run<any[]>(m.installers.eligible, { taskId: 69 }));
    expect(rows.every((r) => r.rate == null && r.rateType == null)).toBe(true);
  });

  test("booking or offering the whole carpet tile dispatch to Fabrizio is still refused, with the skill named", async () => {
    const e = await failure(m.tasksRoute.bookTask({ taskId: 69, installerId: FAB, dates: [MON], arrivalStart: "07:00", coordinateAfterFirst: false, perDay: [] } as any, actor()));
    expect(e.message).toContain("isn't ticked for Carpet tiles");
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = 69")).toEqual([{ n: 0 }] as any);
  });
});

let fabTask = 0;
describe("2. Allocate labour on job 4297", () => {
  test("the view lists the dispatch as unassigned, and materials, freight and delivery as not pay", async () => {
    const [job] = await q("SELECT id FROM jobs WHERE number = ?", [JOB]);
    const view = await run<any>(m.dispatches.allocation, { jobId: job.id });
    expect(view.dispatches.map((d: any) => [d.id, d.status])).toEqual([[69, "unassigned"]]);
    expect(view.notPay.map((l: any) => l.kind).sort()).toEqual(["delivery", "supplier_charge", "supplier_charge", "supply", "supply", "supply", "supply", "supply"]);
    // The stairs line has no rate book item, so nobody is paid for it yet (Damien decides).
    expect(view.unpricedWork.map((l: any) => l.description)).toEqual(["Install carpet tiles to steps inc aluminium nosing install"]);
  });

  test("review: hybrid and trims to Fabrizio, shown before anything is written", async () => {
    const before = await q("SELECT count(*) n FROM job_tasks");
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: 69, itemIds: [IT.hybrid, IT.trims], installerId: FAB, dates: [MON], arrivalStart: "07:00", arrivalEnd: "15:00" });
    expect(review.whole).toBe(false);
    expect(review.recipient).toEqual({ id: FAB, name: "Fabrizio" });
    expect(review.lines.map((l: any) => l.itemId)).toEqual([IT.hybrid, IT.trims]);
    expect(review.staying.map((l: any) => l.itemId)).toEqual([IT.tiles]);
    expect(review.stops).toEqual([]);
    expect(await q("SELECT count(*) n FROM job_tasks")).toEqual(before);
  });

  test("allocate splits them onto one visit for Fabrizio, and the carpet tiles go to Paul, each line paid once", async () => {
    const a = await run<any>(m.dispatches.allocate, { taskId: 69, itemIds: [IT.hybrid, IT.trims], installerId: FAB, dates: [MON], arrivalStart: "07:00", arrivalEnd: "15:00" });
    expect(a.split).toBe(true);
    fabTask = a.taskId;
    const b = await run<any>(m.dispatches.allocate, { taskId: 69, itemIds: [IT.tiles], installerId: PAUL, dates: [MON, TUE], arrivalStart: "07:00", arrivalEnd: "15:00" });
    expect(b.split).toBe(false);
    expect(b.taskId).toBe(69);

    const lines = await q("SELECT task_id, item_id, qty FROM task_labour_lines ORDER BY item_id");
    expect(lines).toEqual([
      { task_id: 69, item_id: IT.tiles, qty: 256 },
      { task_id: fabTask, item_id: IT.hybrid, qty: 135 },
      { task_id: fabTask, item_id: IT.trims, qty: 105 },
    ] as any);
    const tasks = await q("SELECT id, assigned_installer_id who, status, skill_id, labour_cost FROM job_tasks ORDER BY id");
    expect(tasks).toEqual([
      { id: 69, who: PAUL, status: "assigned", skill_id: SK.tiles, labour_cost: 2560 },
      { id: fabTask, who: FAB, status: "assigned", skill_id: SK.hybrid, labour_cost: 135 * 28 + 105 * 8 },
    ] as any);
    const [job] = await q("SELECT id FROM jobs WHERE number = ?", [JOB]);
    const view = await run<any>(m.dispatches.allocation, { jobId: job.id });
    expect(view.dispatches.map((d: any) => [d.installer?.name, d.status])).toEqual([
      ["Paul", "booked"],
      ["Fabrizio", "booked"],
    ]);
    // Nothing was sent to anyone.
    expect(pushes).toEqual([]);
    expect(await q("SELECT count(*) n FROM task_offers")).toEqual([{ n: 0 }] as any);
  });

  test("Fabrizio's own rate card shows his hybrid rates and no carpet tile rates", async () => {
    const mine = await as(FAB_LOGIN, () => run<any>(m.labour.myRates, {}));
    const text = JSON.stringify(mine);
    expect(text).toContain("Hybrid installation");
    expect(text).not.toContain("Carpet tile install");
  });

  test("a part allocation the booking then refuses is put back: no stray dispatch, lines home again", async () => {
    // Furniture and property type not answered: the review passes, the booking itself refuses.
    const jobId = await newJob(false);
    const taskId = await newTask(jobId, "Mixed", SK.tiles, [
      [IT.tiles, 20],
      [IT.hybrid, 30],
    ], { areaM2: 50 });
    const before = await q("SELECT count(*) n FROM job_tasks");
    const e = await failure(run(m.dispatches.allocate, { taskId, itemIds: [IT.hybrid], installerId: FAB, dates: [WED], arrivalStart: "07:00" }));
    expect(e.message).toContain("before booking the install");
    expect(await q("SELECT count(*) n FROM job_tasks")).toEqual(before);
    expect(await q("SELECT task_id, item_id FROM task_labour_lines WHERE task_id = ? ORDER BY item_id", [taskId])).toEqual([
      { task_id: taskId, item_id: IT.tiles },
      { task_id: taskId, item_id: IT.hybrid },
    ] as any);
    expect(await q("SELECT skill_id, area_m2 FROM job_tasks WHERE id = ?", [taskId])).toEqual([{ skill_id: SK.tiles, area_m2: 50 }] as any);
    expect(await q("SELECT count(*) n FROM activity_log WHERE action = 'dispatch_split' AND job_id = ?", [jobId])).toEqual([{ n: 0 }] as any);
  });

  test("Office can't allocate to someone missing a skill on the ticked lines", async () => {
    const jobId = await newJob();
    const taskId = await newTask(jobId, "Tiles", SK.tiles, [[IT.tiles, 40]]);
    const e = await failure(as(OFFICE, () => run(m.dispatches.allocate, { taskId, itemIds: [IT.tiles], installerId: FAB, dates: [WED], arrivalStart: "07:00" })));
    expect(e.message).toContain("Fabrizio isn't ticked for Carpet tiles");
  });
});

describe("3. Same-day bookings", () => {
  // Different jobs: dispatches on the same job never clash with each other (notes 18.61).
  test("06:00-08:00 and 09:00-11:00 the same day for Paul are both allowed", async () => {
    const early = await newTask(await newJob(), "Early", SK.hybrid, [[IT.hybrid, 10]], { durationHours: 2 });
    const late = await newTask(await newJob(), "Late", SK.hybrid, [[IT.hybrid, 10]], { durationHours: 2 });
    await run(m.dispatches.allocate, { taskId: early, itemIds: [IT.hybrid], installerId: PAUL, dates: [THU], arrivalStart: "06:00", arrivalEnd: "08:00", durationHours: 2 });
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: late, itemIds: [IT.hybrid], installerId: PAUL, dates: [THU], arrivalStart: "09:00", arrivalEnd: "11:00", durationHours: 2 });
    expect(review.clashes).toEqual([]);
    expect(review.sameDay.map((s: any) => s.when)).toEqual(["06:00-08:00"]);
    await run(m.dispatches.allocate, { taskId: late, itemIds: [IT.hybrid], installerId: PAUL, dates: [THU], arrivalStart: "09:00", arrivalEnd: "11:00", durationHours: 2 });
    expect(await q("SELECT count(*) n FROM task_days d JOIN job_tasks t ON t.id = d.task_id WHERE t.assigned_installer_id = ? AND d.date = ?", [PAUL, THU])).toEqual([{ n: 2 }] as any);
  });

  test("a real overlap is still caught, and needs a reason to book over", async () => {
    const third = await newTask(await newJob(), "Overlap", SK.hybrid, [[IT.hybrid, 10]], { durationHours: 2 });
    const input = { taskId: third, itemIds: [IT.hybrid], installerId: PAUL, dates: [THU], arrivalStart: "07:00", arrivalEnd: "09:00", durationHours: 2 };
    const review = await run<any>(m.dispatches.previewAllocate, input);
    expect(review.clashes.map((c: any) => c.when)).toEqual(["06:00-08:00"]);
    const e = await failure(run(m.dispatches.allocate, input));
    expect(e.data?.reason).toBe("clash");
    // The outside-hours confirm never stands in for the clash reason.
    const e2 = await failure(run(m.dispatches.allocate, { ...input, confirmOutsideHours: true }));
    expect(e2.data?.reason).toBe("clash");
  });

  test("the travel buffer counts: 15 minutes after Damien's 06:00-08:00 is a clash, 08:30 is clear", async () => {
    const j = await newJob();
    const t = await newTask(j, "Damien early", SK.hybrid, [[IT.hybrid, 5]], { durationHours: 2, status: "assigned", assignedInstallerId: DAMIEN, scheduledDate: FRI });
    await m.db.insert(schema.taskDays).values({ taskId: t, date: FRI, seq: 1, arrivalStart: "06:00", arrivalEnd: "08:00", status: "booked" } as any);
    const at = (start: string) =>
      m.avail.checkDays({ installerId: DAMIEN, dates: [FRI], times: { durationHours: 2, days: [{ date: FRI, arrivalStart: start, arrivalEnd: null }] } });
    expect((await at("08:10"))[0]!.clashes.length).toBe(1);
    expect((await at("08:30"))[0]!.clashes).toEqual([]);
    expect((await at("08:30"))[0]!.sameDay!.length).toBe(1);
    // Without the booking's own times, a same-day booking is still flagged, as before.
    expect((await m.avail.checkDays({ installerId: DAMIEN, dates: [FRI] }))[0]!.clashes.length).toBe(1);
  });

  test("his calendar check counts the buffer between his own bookings, and Google busy times still block", async () => {
    await q("UPDATE calendar_links SET refresh_token_sealed = 'sealed-test', calendar_ids = '[\"primary\"]' WHERE installer_id = ?", [DAMIEN]);
    const check = async (start: string) =>
      (await m.cal.checkAttendance({ taskId: null, durationHours: 2, days: [{ date: FRI, arrivalStart: start, arrivalEnd: null, coordinate: false, people: [DAMIEN] }], actor: actor() }))[0]!;
    const near = await check("08:10");
    expect([near.status, near.clashes.map((c) => c.kind)]).toEqual(["clash", ["booking"]]);
    expect((await check("09:00")).status).toBe("clear");
    const google = await check("10:30");
    expect([google.status, google.clashes.map((c) => c.kind)]).toEqual(["clash", ["personal"]]);
    await q("UPDATE calendar_links SET refresh_token_sealed = NULL WHERE installer_id = ?", [DAMIEN]);
  });
});

describe("4. Outside 6:00 am-6:00 pm (Brisbane)", () => {
  const book = (taskId: number, start: string | null, extra: Record<string, unknown> = {}, who = actor()) =>
    m.tasksRoute.bookTask({ taskId, installerId: FAB, dates: [WED], arrivalStart: start, durationHours: 2, coordinateAfterFirst: false, perDay: [], ...extra } as any, who);

  test("05:00 is refused with the brief's wording, and nothing is saved", async () => {
    const j = await newJob();
    const t = await newTask(j, "Early hybrid", SK.hybrid, [[IT.hybrid, 5]]);
    const e = await failure(book(t, "05:00"));
    expect(e.data?.reason).toBe("outside_hours");
    expect(e.message).toStartWith("This booking is outside standard working hours (6:00 am-6:00 pm). You selected");
    expect(e.message).toContain("5:00 am");
    expect(e.message).toEndWith("Are you sure you want to continue?");
    expect(await q("SELECT count(*) n FROM task_days WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
  });

  test("16:00 for 2 hours ends at 6:00 pm and is fine; 17:00 for 2 hours needs the confirm", async () => {
    const j = await newJob();
    const ok = await newTask(j, "Ends 6", SK.hybrid, [[IT.hybrid, 5]]);
    await book(ok, "16:00");
    const late = await newTask(j, "Ends 7", SK.hybrid, [[IT.hybrid, 5]]);
    expect((await failure(book(late, "17:00"))).data?.reason).toBe("outside_hours");
  });

  test("confirmed: booked, and who confirmed and when is on the job history", async () => {
    const j = await newJob();
    const t = await newTask(j, "Confirmed early", SK.hybrid, [[IT.hybrid, 5]]);
    await book(t, "05:00", { confirmOutsideHours: true });
    expect(await q("SELECT arrival_start FROM task_days WHERE task_id = ?", [t])).toEqual([{ arrival_start: "05:00" }] as any);
    const [log] = await q("SELECT detail, actor_name FROM activity_log WHERE task_id = ? AND action = 'outside_hours_confirmed'", [t]);
    expect(log.actor_name).toBe("Test Admin");
    expect(log.detail).toContain("confirmed by Test Admin (admin) at 20");
    expect(log.detail).toContain("5:00 am");
  });

  test("a blank start time saves as no time, never a silent midnight", async () => {
    const j = await newJob();
    const t = await newTask(j, "No time", SK.hybrid, [[IT.hybrid, 5]]);
    await book(t, "", { arrivalEnd: "" });
    expect(await q("SELECT arrival_start, arrival_end FROM task_days WHERE task_id = ?", [t])).toEqual([{ arrival_start: null, arrival_end: null }] as any);
  });

  test("the phone agent's bookings are left as they are (its hours are unchanged)", async () => {
    const j = await newJob();
    const t = await newTask(j, "Agent", SK.hybrid, [[IT.hybrid, 5]]);
    await book(t, "05:30", {}, AGENT());
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ? AND action = 'outside_hours_confirmed'", [t])).toEqual([{ n: 0 }] as any);
  });

  test("rescheduling to 19:00 asks too", async () => {
    const j = await newJob();
    const t = await newTask(j, "Move late", SK.hybrid, [[IT.hybrid, 5]]);
    await book(t, "08:00");
    const e = await failure(run(m.tasksRoute.tasks.reschedule, { id: t, scheduledDate: WED, startTime: "19:00" }));
    expect(e.data?.reason).toBe("outside_hours");
    await run(m.tasksRoute.tasks.reschedule, { id: t, scheduledDate: WED, startTime: "19:00", confirmOutsideHours: true });
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ? AND action = 'outside_hours_confirmed'", [t])).toEqual([{ n: 1 }] as any);
  });
});

describe("5. Never a silent swap of installer", () => {
  test("booking Fabrizio's hybrid visit to Paul needs the reviewed confirm, and keeps one dispatch and one set of lines", async () => {
    const book = (extra: Record<string, unknown> = {}) =>
      m.tasksRoute.bookTask({ taskId: fabTask, installerId: PAUL, dates: [MON], arrivalStart: "07:00", coordinateAfterFirst: false, perDay: [], ...extra } as any, actor());
    const e = await failure(book());
    expect(e.data?.reason).toBe("replace_installer");
    expect(e.message).toContain("is booked to Fabrizio");
    expect((await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [fabTask]))[0].who).toBe(FAB);

    await book({ replaceInstaller: true });
    expect((await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [fabTask]))[0].who).toBe(PAUL);
    const [log] = await q("SELECT detail FROM activity_log WHERE task_id = ? AND action = 'allocation_changed'", [fabTask]);
    expect(log.detail).toContain("taken off Fabrizio and given to Paul after review. Same dispatch, so it is paid once.");
    expect(await q("SELECT count(*) n FROM task_labour_lines WHERE item_id = ?", [IT.hybrid])).toEqual(
      await q("SELECT count(DISTINCT task_id) n FROM task_labour_lines WHERE item_id = ?", [IT.hybrid]),
    );
  });

  test("assign and reschedule ask the same way, and give it back to Fabrizio once confirmed", async () => {
    expect((await failure(run(m.tasksRoute.tasks.assign, { id: fabTask, installerId: FAB }))).data?.reason).toBe("replace_installer");
    await run(m.tasksRoute.tasks.assign, { id: fabTask, installerId: FAB, replaceInstaller: true });
    expect((await q("SELECT assigned_installer_id who FROM job_tasks WHERE id = ?", [fabTask]))[0].who).toBe(FAB);
    expect((await failure(run(m.tasksRoute.tasks.reschedule, { id: fabTask, scheduledDate: MON, startTime: "07:00", installerId: PAUL }))).data?.reason).toBe(
      "replace_installer",
    );
    await run(m.tasksRoute.tasks.reschedule, { id: fabTask, scheduledDate: MON, startTime: "07:00", installerId: FAB });
    expect(await q("SELECT count(*) n FROM activity_log WHERE task_id = ? AND action = 'allocation_changed'", [fabTask])).toEqual([{ n: 2 }] as any);
  });

  test("the allocation view refuses to give part of a booked dispatch away", async () => {
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: fabTask, itemIds: [IT.trims], installerId: PAUL, dates: [MON], arrivalStart: "07:00" });
    expect(review.stops.join(" ")).toContain("Lines can't be taken off it");
  });
});

describe("6. Day rates 73, 74 and 103: per contractor, off by default", () => {
  const names = ["Day rate, one man", "Day rate, two man crew", "Day rate, leading hand"];
  const hasDayRate = (x: unknown) => names.some((n) => JSON.stringify(x).includes(n));

  test("nobody's own rate card or the Admin card shows them until switched on", async () => {
    expect(hasDayRate(await as(FAB_LOGIN, () => run(m.labour.myRates, {})))).toBe(false);
    expect(hasDayRate(await as(PAUL_LOGIN, () => run(m.labour.myRates, {})))).toBe(false);
    const card = await run<any>(m.labour.card, { installerId: FAB });
    expect(hasDayRate(card.rows)).toBe(false);
    // The Admin card lists them only as switches, all off.
    expect(card.restrictedItems.map((i: any) => [i.itemId, i.enabled, i.rate])).toEqual([
      [IT.dayOne, false, null],
      [IT.dayTwo, false, null],
      [IT.dayLead, false, null],
    ]);
    // The quoting picker (Admin only) offers nobody for them.
    const picker = await run<any>(m.labour.picker, { search: "day rate" });
    expect(picker.rows.map((r: any) => [r.itemId, r.layers.length]).sort((x: number[], y: number[]) => x[0]! - y[0]!)).toEqual([
      [IT.dayOne, 0],
      [IT.dayTwo, 0],
      [IT.dayLead, 0],
    ]);
  });

  test("Office and crew can't switch one on; Admin can, from a date, and the history keeps every change", async () => {
    const input = { installerId: FAB, itemId: IT.dayOne, enabled: true, effectiveFrom: "2026-11-01", note: "Agreed for odd jobs" };
    expect((await failure(as(OFFICE, () => run(m.labour.setItemAccess, input)))).code).toBe("FORBIDDEN");
    expect((await failure(as(FAB_LOGIN, () => run(m.labour.setItemAccess, input)))).code).toBe("FORBIDDEN");
    await run(m.labour.setItemAccess, input);

    const fab = JSON.stringify(await as(FAB_LOGIN, () => run(m.labour.myRates, {})));
    expect(fab).toContain("Day rate, one man");
    expect(fab).not.toContain("Day rate, leading hand");
    expect(hasDayRate(await as(PAUL_LOGIN, () => run(m.labour.myRates, {})))).toBe(false);
    expect(hasDayRate((await run<any>(m.labour.card, { installerId: PAUL })).rows)).toBe(false);
    const picker = await run<any>(m.labour.picker, { search: "day rate, one man" });
    expect(picker.rows[0].layers.map((l: any) => l.name)).toEqual(["Fabrizio"]);

    await run(m.labour.setItemAccess, { ...input, enabled: false, effectiveFrom: "2026-11-05", note: "Finished" });
    expect(hasDayRate(await as(FAB_LOGIN, () => run(m.labour.myRates, {})))).toBe(false);
    const card = await run<any>(m.labour.card, { installerId: FAB });
    expect(card.accessLog.map((a: any) => [a.itemId, a.enabled, a.effectiveFrom])).toEqual([
      [IT.dayOne, false, "2026-11-05"],
      [IT.dayOne, true, "2026-11-01"],
    ]);
    expect(card.accessLog[0].by).toBe("Test Admin");
  });

  test("a dispatch with a day rate line can only go to someone it is switched on for", async () => {
    const j = await newJob();
    const t = await newTask(j, "Day work", null, [[IT.dayOne, 1]]);
    const rows = await run<any[]>(m.installers.eligible, { taskId: t });
    expect(rows.find((r) => r.id === PAUL)!.reasons).toContain("Day rate, one man not switched on for them");
    expect((await failure(run(m.tasksRoute.tasks.assign, { id: t, installerId: PAUL }))).message).toContain("isn't switched on");
    await run(m.labour.setItemAccess, { installerId: PAUL, itemId: IT.dayOne, enabled: true, effectiveFrom: "2026-11-01", note: null });
    await run(m.tasksRoute.tasks.assign, { id: t, installerId: PAUL });
  });

  test("only per-contractor items are switched one by one", async () => {
    const e = await failure(run(m.labour.setItemAccess, { installerId: FAB, itemId: IT.hybrid, enabled: true, note: null }));
    expect(e.message).toContain("is on every card already");
  });
});

describe("7. Contractor labor - per hour", () => {
  test("$0.00 shows as Rate not set, and blocks the picker, offers, booking and approval", async () => {
    expect(await m.hourly.hourlyRateBarrier(NORATE)).toBe(
      "Contractor labor - per hour: Rate not set ($0.00). Set the agreed hourly rate before giving this person hourly work.",
    );
    expect(await m.hourly.hourlyRateBarrier(HOURLY)).toBeNull();
    expect(await m.hourly.hourlyRateBarrier(FAB)).toBeNull();

    const j = await newJob();
    const t = await newTask(j, "Hourly hybrid", SK.hybrid, [[IT.hybrid, 20]]);
    const rows = await run<any[]>(m.installers.eligible, { taskId: t });
    const nr = rows.find((r) => r.id === NORATE)!;
    expect([nr.eligible, nr.reasons]).toEqual([false, ["Hourly rate not set ($0.00)"]]);
    expect((await failure(run(m.offers.sendDirect, { taskId: t, installerId: NORATE }))).message).toContain("Rate not set ($0.00)");
    expect((await failure(run(m.tasksRoute.tasks.assign, { id: t, installerId: NORATE }))).message).toContain("Rate not set ($0.00)");
    expect(pushes).toEqual([]);

    // Time already logged against a $0.00 rate can't be approved.
    const [s] = await m.db
      .insert(schema.workSessions)
      .values({
        installerId: NORATE, taskId: t, jobId: j, clientKey: "nr-1", workDate: "2026-11-02",
        startedAt: new Date("2026-11-02T22:00:00Z"), endedAt: new Date("2026-11-03T02:00:00Z"), status: "recorded",
      } as any)
      .returning();
    const e = await failure(m.hourly.approveSession(s!.id, { name: "Test Admin", role: "admin" }));
    expect(e.message).toContain("Contractor labor - per hour: Rate not set ($0.00). Set the agreed hourly rate before approving.");
  });

  test("approved time at $0.00 can't be invoiced", async () => {
    const j = await newJob();
    const t = await newTask(j, "Old hourly", SK.hybrid, [[IT.hybrid, 5]], { assignedInstallerId: NORATE, status: "complete", payType: "hourly" });
    await m.db.insert(schema.workSessions).values({
      installerId: NORATE, taskId: t, jobId: j, clientKey: "nr-2", workDate: "2026-11-03",
      startedAt: new Date("2026-11-03T22:00:00Z"), endedAt: new Date("2026-11-04T02:00:00Z"), status: "approved",
      payable: true, approvedMinutes: 240, rateBase: 0, approvedPay: 0,
      payLines: JSON.stringify([{ label: "Ordinary", minutes: 240, rate: 0, total: 0 }]),
    } as any);
    const preview = await as(NORATE_LOGIN, () => run<any>(m.invoices.preview, { taskId: t }));
    expect(JSON.stringify(preview)).toContain("Rate not set ($0.00)");
    expect((await failure(as(NORATE_LOGIN, () => run(m.invoices.submit, { taskId: t })))).message).toContain("Rate not set ($0.00)");
  });

  test("the rate agreed when the work is allocated is kept on the dispatch, whatever his terms say later", async () => {
    const j = await newJob();
    const t = await newTask(j, "Hourly agreed", SK.hybrid, [[IT.hybrid, 20]]);
    await m.tasksRoute.bookTask({ taskId: t, installerId: HOURLY, dates: [TUE], arrivalStart: "07:00", coordinateAfterFirst: false, perDay: [] } as any, actor());
    const [row] = await q("SELECT pay_type, agreed_hourly_rate, agreed_terms_id, labour_cost FROM job_tasks WHERE id = ?", [t]);
    expect([row.pay_type, row.agreed_hourly_rate, row.labour_cost]).toEqual(["hourly", 10, null]);
    expect(row.agreed_terms_id).toBeGreaterThan(0);

    const later = { ...(await m.hourly.termsOn(HOURLY))!, baseRate: 50 };
    const pay = (await m.hourly.taskPay([t])).get(t)!;
    expect(m.hourly.termsForTask(later, pay)!.baseRate).toBe(10);
    // His own screen shows his rate, never anyone else's.
    const card = JSON.stringify(await as({ id: "test-hourly", name: "Hourly", email: "h@example.invalid" }, async () => {
      await m.db.insert(schema.profiles).values({ userId: "test-hourly", name: "Hourly", email: "h@example.invalid", role: "field", installerId: HOURLY } as any);
      return run(m.labour.myRates, {});
    }));
    expect(card).not.toContain("Hybrid installation");
  });

  test("hours on work already paid by its agreed lines are never approved on top", async () => {
    const j = await newJob();
    const t = await newTask(j, "Unit rate", SK.hybrid, [[IT.hybrid, 20]], { assignedInstallerId: HOURLY, status: "assigned", payType: "per_job", labourCost: 560 });
    const terms = await m.hourly.termsOn(HOURLY);
    const session = {
      id: 999, installerId: HOURLY, taskId: t, jobId: j, category: "site", clientKey: "x", workDate: "2026-11-04",
      startedAt: new Date("2026-11-04T22:00:00Z"), endedAt: new Date("2026-11-05T02:00:00Z"), adjStartedAt: null, adjEndedAt: null, status: "recorded", bandSplit: null,
    } as any;
    const settings = await m.hourly.hourlySettings();
    const v = m.hourly.viewSession(session, [], settings, terms, Date.now(), (await m.hourly.taskPay([t])).get(t)!);
    expect(v.blockers).toContain("This work is paid by its agreed lines, not by the hour. Approving hours on it would pay it twice.");
    const h = m.hourly.viewSession(session, [], settings, terms, Date.now(), { id: t, payType: "hourly", labourCost: null, agreedHourlyRate: 10 });
    expect(h.blockers.join(" ")).not.toContain("pay it twice");
  });
});

describe("8. Nosing, stairs and the migration file", () => {
  test("a nosing fit line on top of a stair rate is stopped, so the stairs are paid once", async () => {
    const j = await newJob();
    const t = await newTask(j, "Stairs", SK.stairs, [
      [IT.stairs, 30],
      [IT.nosingFit, 36],
    ]);
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: t, itemIds: [IT.stairs, IT.nosingFit], installerId: PAUL, dates: [WED], arrivalStart: "07:00" });
    expect(review.stops.join(" ")).toContain("would pay the nosing again on top of Carpet stairs, standard straight step");
    expect((await failure(run(m.dispatches.allocate, { taskId: t, itemIds: [IT.stairs, IT.nosingFit], installerId: PAUL, dates: [WED], arrivalStart: "07:00" }))).data?.reason).toBe(
      "allocation_stopped",
    );
    // Stairs on their own go through.
    await m.db.delete(schema.taskLabourLines).where(m.orm.and(m.orm.eq(schema.taskLabourLines.taskId, t), m.orm.eq(schema.taskLabourLines.itemId, IT.nosingFit)));
    const ok = await run<any>(m.dispatches.previewAllocate, { taskId: t, itemIds: [IT.stairs], installerId: PAUL, dates: [WED], arrivalStart: "07:00" });
    expect(ok.stops).toEqual([]);
  });

  test("the migration has 6 statements and switching the day rates on twice changes nothing the second time", async () => {
    const sqlText = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-12-02-installer-allocation.sql"), "utf8");
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
      .filter(Boolean);
    expect(statements.length).toBe(6);
    const update = statements[5]!;
    expect(update).toStartWith("UPDATE labour_rate_items SET restricted = 1");
    await q("UPDATE labour_rate_items SET restricted = 0 WHERE id IN (73, 74, 103)");
    expect((await client.execute(update)).rowsAffected).toBe(3);
    expect((await client.execute(update)).rowsAffected).toBe(0);
    expect(await q("SELECT id FROM labour_rate_items WHERE restricted = 1 ORDER BY id")).toEqual([{ id: 73 }, { id: 74 }, { id: 103 }] as any);
  });
});

describe("9. $0.00 is Rate not set, and the job 4297 stairs line", () => {
  const ZERO = 40; // a contractor whose own carpet tile rate was left at $0.00
  let tilesTask = 0;

  test("a line at his own $0.00 rate keeps him out of the picker, offers, booking and the allocation review", async () => {
    await m.db.insert(schema.installers).values({ id: ZERO, name: "Zero Card", crewCapacity: "solo", active: true } as any);
    await m.db.insert(schema.installerSkills).values({ installerId: ZERO, skillId: SK.tiles } as any);
    await m.db.insert(schema.labourRates).values({ itemId: IT.tiles, installerId: ZERO, amount: 0, effectiveFrom: "2026-01-01" } as any);
    const j = await newJob();
    tilesTask = await newTask(j, "Tiles at $0", SK.tiles, [[IT.tiles, 10]]);

    const rows = await run<any[]>(m.installers.eligible, { taskId: tilesTask });
    const z = rows.find((r) => r.id === ZERO)!;
    expect([z.eligible, z.reasons]).toEqual([false, ["Rate not set for Carpet tile install ($0.00)"]]);
    // Terra's standard $10 is fine for anyone without his own row.
    expect(rows.find((r) => r.id === PAUL)!.eligible).toBe(true);

    const said = "Carpet tile install: Rate not set ($0.00). Set the agreed rate on this person's rate card before giving this person this work.";
    expect((await failure(run(m.offers.sendDirect, { taskId: tilesTask, installerId: ZERO }))).message).toBe(said);
    expect((await failure(run(m.tasksRoute.tasks.assign, { id: tilesTask, installerId: ZERO }))).message).toBe(said);
    const review = await run<any>(m.dispatches.previewAllocate, { taskId: tilesTask, itemIds: [IT.tiles], installerId: ZERO, dates: [THU], arrivalStart: "07:00" });
    expect(review.stops).toContain(said);
    expect(await q("SELECT count(*) n FROM task_offers WHERE task_id = ?", [tilesTask])).toEqual([{ n: 0 }] as any);

    // Once a real rate is on his card he can be given it.
    await q("UPDATE labour_rates SET amount = 12 WHERE installer_id = ? AND item_id = ?", [ZERO, IT.tiles]);
    expect((await run<any[]>(m.installers.eligible, { taskId: tilesTask })).find((r) => r.id === ZERO)!.eligible).toBe(true);
    await q("UPDATE labour_rates SET amount = 0 WHERE installer_id = ? AND item_id = ?", [ZERO, IT.tiles]);
  });

  test("a typed pay of $0.00 is refused on a direct offer and a broadcast", async () => {
    const j = await newJob();
    const t = await newTask(j, "Hybrid typed 0", SK.hybrid, [[IT.hybrid, 10]]);
    const said = "Pay: Rate not set ($0.00). Enter the agreed amount before sending this offer.";
    expect((await failure(run(m.offers.sendDirect, { taskId: t, installerId: FAB, payAmount: 0 }))).message).toBe(said);
    expect((await failure(run(m.offers.broadcast, { taskId: t, payAmount: 0 }))).message).toBe(said);
    expect(await q("SELECT count(*) n FROM task_offers WHERE task_id = ?", [t])).toEqual([{ n: 0 }] as any);
    expect(pushes).toEqual([]);
  });

  test("an hourly man is not stopped by a $0.00 unit line, and is still paid at his agreed hourly rate", async () => {
    await m.db.insert(schema.labourRates).values({ itemId: IT.hybrid, installerId: HOURLY, amount: 0, effectiveFrom: "2026-01-01" } as any);
    const j = await newJob();
    const t = await newTask(j, "Hourly with $0 line", SK.hybrid, [[IT.hybrid, 10]]);
    const h = (await run<any[]>(m.installers.eligible, { taskId: t })).find((r) => r.id === HOURLY)!;
    expect(h.reasons.join(" ")).not.toContain("Rate not set");
    await run(m.tasksRoute.tasks.assign, { id: t, installerId: HOURLY });
    const [row] = await q("SELECT pay_type, agreed_hourly_rate FROM job_tasks WHERE id = ?", [t]);
    expect([row.pay_type, row.agreed_hourly_rate]).toEqual(["hourly", 10]);
  });

  test("a day rate switched on for someone with his own $0.00 day rate shows Rate not set", async () => {
    await run(m.labour.setItemAccess, { installerId: ZERO, itemId: IT.dayOne, enabled: true, effectiveFrom: "2026-11-01", note: null });
    await m.db.insert(schema.labourRates).values({ itemId: IT.dayOne, installerId: ZERO, amount: 0, effectiveFrom: "2026-11-01" } as any);
    const j = await newJob();
    const t = await newTask(j, "Day at $0", null, [[IT.dayOne, 1]]);
    const rows = await run<any[]>(m.installers.eligible, { taskId: t });
    expect(rows.find((r) => r.id === ZERO)!.reasons).toEqual(["Rate not set for Day rate, one man ($0.00)"]);
    // Paul has it on at Terra's $320, so no rate reason for him.
    expect(rows.find((r) => r.id === PAUL)!.reasons.join(" ")).not.toContain("Rate not set");
    // The stored day rates are untouched.
    expect(await q("SELECT item_id, amount FROM labour_rates WHERE installer_id IS NULL AND item_id IN (73, 74, 103) ORDER BY item_id")).toEqual([
      { item_id: 73, amount: 320 },
      { item_id: 74, amount: 640 },
      { item_id: 103, amount: 580 },
    ] as any);
  });

  test("pay on a submitted bill with a $0.00 line can't be approved; a real rate can; approved bills are left as they are", async () => {
    const j = await newJob();
    const mk = async (n: number, rate: number, status = "submitted") => {
      const t = await newTask(j, `Bill ${n}`, SK.tiles, [], { assignedInstallerId: ZERO, status: "complete", payType: "per_job" });
      const [inv] = await m.db
        .insert(schema.installerInvoices)
        .values({
          taskId: t, jobId: j, installerId: ZERO, invoiceNumber: n, status,
          lineItems: JSON.stringify([{ description: "Carpet tile install", unit: "m2", qty: 10, rate, total: rate * 10 }]),
          subtotal: rate * 10, total: rate * 10,
        } as any)
        .returning();
      return inv!.id;
    };
    const zero = await mk(1, 0);
    const e = await failure(run(m.invoices.adminSetStatus, { invoiceId: zero, status: "approved" }));
    expect(e.message).toBe("Carpet tile install: Rate not set ($0.00). Set the agreed rate before approving this pay.");
    expect((await q("SELECT status FROM installer_invoices WHERE id = ?", [zero]))[0].status).toBe("submitted");
    const real = await mk(2, 12);
    expect((await run<any>(m.invoices.adminSetStatus, { invoiceId: real, status: "approved" })).status).toBe("approved");
    const old = await mk(3, 0, "approved");
    expect((await run<any>(m.invoices.adminSetStatus, { invoiceId: old, status: "paid" })).status).toBe("paid");
  });

  test("stairs: 30 steps at the installer's rate for Carpet stairs ($13.00) = $390.00, nosing included, shown on his completion summary", async () => {
    const j = await newJob();
    const t = await newTask(j, "Stairs", SK.stairs, [[IT.stairs, 30]]);
    await m.tasksRoute.bookTask({ taskId: t, installerId: PAUL, dates: [THU], arrivalStart: "07:00", coordinateAfterFirst: false, perDay: [] } as any, actor());
    const [row] = await q("SELECT labour_cost, labour_breakdown FROM job_tasks WHERE id = ?", [t]);
    expect(row.labour_cost).toBe(390);
    const lines = JSON.parse(row.labour_breakdown);
    expect(lines.map((l: any) => [l.name, l.qty, l.rate, l.total])).toEqual([["Carpet stairs, standard straight step", 30, 13, 390]]);

    await q("UPDATE job_tasks SET status = 'complete' WHERE id = ?", [t]);
    const preview = await as(PAUL_LOGIN, () => run<any>(m.invoices.preview, { taskId: t }));
    expect(JSON.stringify(preview)).not.toContain("Rate not set");
    const text = JSON.stringify(preview);
    expect(text).toContain("Carpet stairs, standard straight step");
    expect(text).toContain('"qty":30');
    expect(text).toContain('"rate":13');
    expect(text).toContain('"total":390');
    expect(text).not.toContain("Nosing supply and fit");
  });

  test("the 4297 stairs SQL: links the quote line, adds 30 steps once, no separate nosing pay, prices unchanged, twice changes nothing", async () => {
    const { drizzle } = await import("drizzle-orm/libsql");
    const f2 = join(dir, "stairs.db");
    const c2 = createClient({ url: `file:${f2}` });
    try {
      for (const s of await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any))) await c2.execute(s);
      const d2 = drizzle(c2, { schema });
      for (const [id, name] of [[SK.tiles, "Carpet tiles"], [SK.stairs, "Carpet stairs"]] as const) await d2.insert(schema.skills).values({ id, name, groupName: "carpet" } as any);
      for (const [id, name, unit] of [[IT.tiles, "Carpet tile install", "m2"], [IT.stairs, "Carpet stairs, standard straight step", "step"], [IT.hybrid, "Hybrid installation", "m2"], [IT.trims, "Install trims/scotia", "lm"], [IT.nosingFit, "Nosing supply and fit", "lm"]] as const) {
        await d2.insert(schema.labourRateItems).values({ id, name, unit, groupName: "carpet", kind: "work", active: true } as any);
      }
      await d2.insert(schema.jobs).values({ id: 4297, number: 188070 } as any);
      await d2.insert(schema.installers).values({ id: PAUL, name: "Paul", crewCapacity: "own_offsider", active: true } as any);
      await d2.insert(schema.quotes).values({ id: 81, number: 188070, jobId: 4297, status: "accepted", total: 34051.27 } as any);
      await d2.insert(schema.quoteItems).values({ id: 560, quoteId: 81, kind: "labour", description: "Install carpet tiles to steps inc aluminium nosing install", qty: 30, unit: "each", unitPrice: 55, total: 1650 } as any);
      await d2.insert(schema.jobTasks).values({ id: 69, jobId: 4297, title: "Carpet tiles", skillId: SK.tiles, durationHours: 8, status: "unassigned", description: "Also on the quote: Install carpet tiles to steps inc aluminium nosing install (30 each)." } as any);
      for (const [itemId, qty, i] of [[IT.tiles, 256, 0], [IT.hybrid, 135, 1], [IT.trims, 105, 2]]) await d2.insert(schema.taskLabourLines).values({ taskId: 69, itemId, qty, sortOrder: i } as any);

      const sqlText = readFileSync(join(import.meta.dir, "../src/api/database/sql/2026-12-04-job-4297-stairs-line.sql"), "utf8");
      const statements = sqlText
        .split("--> statement-breakpoint")
        .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean);
      expect(statements.length).toBe(4);
      const once = [];
      for (const st of statements) once.push((await c2.execute(st)).rowsAffected);
      expect(once).toEqual([1, 1, 1, 1]);
      const twice = [];
      for (const st of statements) twice.push((await c2.execute(st)).rowsAffected);
      expect(twice).toEqual([0, 0, 0, 0]);

      const r2 = async (sql: string) => (await c2.execute(sql)).rows.map((r) => ({ ...r }));
      expect(await r2("SELECT rate_item_id, qty, unit_price, total FROM quote_items WHERE id = 560")).toEqual([{ rate_item_id: 8, qty: 30, unit_price: 55, total: 1650 }]);
      expect(await r2("SELECT total FROM quotes WHERE id = 81")).toEqual([{ total: 34051.27 }]);
      expect(await r2("SELECT item_id, qty, sort_order FROM task_labour_lines WHERE task_id = 69 ORDER BY sort_order")).toEqual([
        { item_id: IT.tiles, qty: 256, sort_order: 0 },
        { item_id: IT.hybrid, qty: 135, sort_order: 1 },
        { item_id: IT.trims, qty: 105, sort_order: 2 },
        { item_id: IT.stairs, qty: 30, sort_order: 3 },
      ]);
      expect(await r2("SELECT count(*) n FROM task_labour_lines WHERE item_id = 67")).toEqual([{ n: 0 }]);
      expect(await r2("SELECT description, labour_cost, assigned_installer_id FROM job_tasks WHERE id = 69")).toEqual([{ description: null, labour_cost: null, assigned_installer_id: null }]);
      expect(await r2("SELECT action, actor_name FROM activity_log WHERE task_id = 69")).toEqual([{ action: "labour_line_linked", actor_name: "Damien Lacey" }]);

      // Once the dispatch is booked or priced, it never adds the line again.
      await c2.execute("DELETE FROM task_labour_lines WHERE item_id = 8");
      await c2.execute("UPDATE job_tasks SET status = 'assigned', assigned_installer_id = 19, labour_cost = 2560 WHERE id = 69");
      expect((await c2.execute(statements[1]!)).rowsAffected).toBe(0);
    } finally {
      c2.close();
    }
  });
});

test("nothing was sent", () => {
  expect(blocked).toEqual([]);
  expect(pushes).toEqual([]);
});
