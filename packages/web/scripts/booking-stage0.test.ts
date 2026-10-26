/**
 * Measure booking stage 0: the booking write, request keys, stale edits, the
 * clash rule and the permission table.
 *
 * Runs on its own throwaway database file, built from schema.ts, so it never
 * touches a real one. Run: bun test scripts/booking-stage0.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";
import { writeBooking, type BookingWrite } from "../src/api/lib/booking-write";
import { RequestKeyError, runOnce, STALE_MS } from "../src/api/lib/request-keys";
import { ACTIONS, can, PERMISSIONS, parseDuties, rolesOf, type PermActor, type PermRole } from "../src/api/lib/permissions";

const dir = mkdtempSync(join(tmpdir(), "stage0-"));
const file = join(dir, "test.db");
// lib/availability reads the app's own db, which is opened from DATABASE_URL on first import.
process.env.DATABASE_URL = `file:${file}`;
let client: Client;
let dayProblems: typeof import("../src/api/lib/booking-safety").dayProblems;

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];

beforeAll(async () => {
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);
  // Seed: two installers, two jobs, the task under test and one other booking.
  await client.batch(
    [
      "INSERT INTO installers (id, name, created_at, updated_at) VALUES (1, 'Ana', 0, 0), (2, 'Ben', 0, 0)",
      "INSERT INTO sites (id, address, suburb, created_at, updated_at) VALUES (1, '1 Test St', 'Testville', 0, 0)",
      "INSERT INTO jobs (id, number, site_id, created_at, updated_at) VALUES (1, 900001, 1, 0, 0), (2, 900002, 1, 0, 0)",
      "INSERT INTO job_tasks (id, job_id, title, status, assigned_installer_id, created_at, updated_at) VALUES (10, 1, 'Lay vinyl', 'assigned', 1, 0, 0)",
      "INSERT INTO job_tasks (id, job_id, title, status, assigned_installer_id, scheduled_date, scheduled_from, scheduled_to, created_at, updated_at) VALUES (20, 2, 'Other job', 'assigned', 1, '2026-11-10', '2026-11-10', '2026-11-10', 0, 0)",
      "INSERT INTO task_days (task_id, date, seq, status, created_at, updated_at) VALUES (10, '2026-11-03', 1, 'booked', 0, 0), (10, '2026-11-04', 2, 'booked', 0, 0)",
      "INSERT INTO task_days (task_id, date, seq, status, created_at, updated_at) VALUES (20, '2026-11-10', 1, 'booked', 0, 0)",
    ],
    "write",
  );
  ({ dayProblems } = await import("../src/api/lib/booking-safety"));
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const version = async (taskId = 10) => Number((await q("SELECT version FROM job_tasks WHERE id = ?", [taskId]))[0].version);
const daysOf = async (taskId = 10) => (await q("SELECT date FROM task_days WHERE task_id = ? ORDER BY date", [taskId])).map((r) => r.date as string);
const auditCount = async (taskId = 10) => Number((await q("SELECT count(*) AS n FROM audit_events WHERE task_id = ?", [taskId]))[0].n);

function booking(expectedVersion: number, dates: string[], extra: Partial<BookingWrite> = {}): BookingWrite {
  return {
    taskId: 10,
    jobId: 1,
    expectedVersion,
    days: dates.map((date, i) => ({ date, seq: i + 1, arrivalStart: "07:00", arrivalEnd: "08:00", coordinate: false, installerId: null, overrideNote: null })),
    patch: {
      assignedInstallerId: 1,
      status: "assigned",
      scheduledDate: dates[0]!,
      scheduledFrom: dates[0]!,
      scheduledTo: dates[dates.length - 1]!,
      startTime: "07:00",
    },
    activity: { action: "booked", detail: "test" },
    audit: { action: "task.book", before: null, after: { dates }, reason: null, requestKey: null },
    actor: { userId: "u1", name: "Tester", role: "office" },
    ...extra,
  };
}

describe("booking write is all or nothing", () => {
  test("a failure right after the old days are cleared keeps the old days, 10 of 10", async () => {
    const before = await daysOf();
    const v = await version();
    const logs = Number((await q("SELECT count(*) AS n FROM activity_log"))[0].n);
    let failed = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await writeBooking(client, booking(v, ["2026-12-01", "2026-12-02", "2026-12-03"], { faultAfterClear: true }));
      } catch {
        failed++;
      }
      expect(await daysOf()).toEqual(before);
    }
    expect(failed).toBe(10);
    expect(before).toEqual(["2026-11-03", "2026-11-04"]);
    expect(await version()).toBe(v);
    expect(await auditCount()).toBe(0);
    expect(Number((await q("SELECT count(*) AS n FROM activity_log"))[0].n)).toBe(logs);
  });

  test("a good write replaces the days, logs once, audits once and bumps the version", async () => {
    const v = await version();
    const res = await writeBooking(client, booking(v, ["2026-11-05", "2026-11-06"]));
    expect(res).toEqual({ ok: true, version: v + 1 });
    expect(await daysOf()).toEqual(["2026-11-05", "2026-11-06"]);
    expect(await version()).toBe(v + 1);
    expect(await auditCount()).toBe(1);
    const [t] = await q("SELECT scheduled_from, scheduled_to, status FROM job_tasks WHERE id = 10");
    expect(t).toMatchObject({ scheduled_from: "2026-11-05", scheduled_to: "2026-11-06", status: "assigned" });
  });
});

describe("stale edits", () => {
  test("a save from an old version is refused and writes nothing", async () => {
    const v = await version();
    const days = await daysOf();
    const audits = await auditCount();
    const res = await writeBooking(client, booking(v - 1, ["2026-12-20"]));
    expect(res).toEqual({ ok: false, reason: "stale", version: v });
    expect(await daysOf()).toEqual(days);
    expect(await version()).toBe(v);
    expect(await auditCount()).toBe(audits);
  });

  test("20 saves from the same version at once: exactly one lands", async () => {
    const v = await version();
    const audits = await auditCount();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => writeBooking(client, booking(v, [`2026-12-${String(i + 1).padStart(2, "0")}`]))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(19);
    expect(await version()).toBe(v + 1);
    expect(await auditCount()).toBe(audits + 1);
    expect(await daysOf()).toHaveLength(1);
  });
});

describe("request keys", () => {
  test("20 identical keyed bookings at once: one run of days, one audit row, same answer for all", async () => {
    await writeBooking(client, booking(await version(), ["2026-11-03"]));
    const audits = await auditCount();
    const dates = ["2026-11-17", "2026-11-18", "2026-11-19"];
    let ran = 0;
    const one = () =>
      runOnce(
        client,
        { key: "panel-key-aaaa-0001", actorUserId: "u1", action: "task.book:10" },
        async () => {
          ran++;
          const res = await writeBooking(client, { ...booking(await version(), dates), audit: { action: "task.book", before: null, after: { dates }, reason: null, requestKey: "panel-key-aaaa-0001" } });
          if (!res.ok) throw new Error("stale");
          return { result: { dates, version: res.version }, stored: { dates, version: res.version } };
        },
        async (stored) => stored as { dates: string[]; version: number },
      );
    const results = await Promise.all(Array.from({ length: 20 }, one));
    expect(ran).toBe(1);
    expect(await daysOf()).toEqual(dates);
    expect(await auditCount()).toBe(audits + 1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    const [k] = await q("SELECT status FROM request_keys WHERE actor_user_id = 'u1' AND key = 'panel-key-aaaa-0001'");
    expect(k.status).toBe("done");
  });

  test("a first try that fails lets go of its key, so a retry runs", async () => {
    const opts = { key: "retry-key-0002", actorUserId: "u1", action: "task.book:10" };
    await expect(runOnce(client, opts, async () => Promise.reject(new Error("dropped")), async () => "replayed")).rejects.toThrow("dropped");
    expect(await q("SELECT * FROM request_keys WHERE key = 'retry-key-0002'")).toHaveLength(0);
    const out = await runOnce(client, opts, async () => ({ result: "ran", stored: "ran" }), async (s) => `replayed ${s}`);
    expect(out).toBe("ran");
    expect(await runOnce(client, opts, async () => ({ result: "ran again", stored: null }), async (s) => `replayed ${s}`)).toBe("replayed ran");
  });

  test("a key used for something else is refused", async () => {
    const err = await runOnce(client, { key: "retry-key-0002", actorUserId: "u1", action: "task.book:99" }, async () => ({ result: 1, stored: 1 }), async () => 2).catch((e) => e);
    expect(err).toBeInstanceOf(RequestKeyError);
    expect(err.code).toBe("KEY_REUSED");
  });

  test("the same key from another login is its own request", async () => {
    const out = await runOnce(client, { key: "retry-key-0002", actorUserId: "u2", action: "task.book:10" }, async () => ({ result: "u2 ran", stored: null }), async () => "replayed");
    expect(out).toBe("u2 ran");
  });

  test("a claim left pending by a dead server is taken over after the stale time", async () => {
    const t0 = Date.now();
    await q("INSERT INTO request_keys (actor_user_id, key, action, status, created_at) VALUES ('u1', 'dead-key-0003', 'task.book:10', 'pending', ?)", [Math.floor(t0 / 1000)]);
    const waiting = await runOnce(client, { key: "dead-key-0003", actorUserId: "u1", action: "task.book:10", waitMs: 200 }, async () => ({ result: "x", stored: null }), async () => "y").catch((e) => e);
    expect(waiting).toBeInstanceOf(RequestKeyError);
    expect(waiting.code).toBe("STILL_RUNNING");
    const later = () => t0 + STALE_MS + 5000;
    const out = await runOnce(client, { key: "dead-key-0003", actorUserId: "u1", action: "task.book:10", now: later }, async () => ({ result: "took over", stored: null }), async () => "y");
    expect(out).toBe("took over");
  });

  test("no key: the work just runs, every time", async () => {
    let n = 0;
    for (let i = 0; i < 3; i++) await runOnce(client, { key: null, actorUserId: "u1", action: "a" }, async () => ({ result: ++n, stored: null }), async () => -1);
    expect(n).toBe(3);
  });
});

describe("clash rule", () => {
  test("another job's booking on the day is a problem, this task and this job are not", async () => {
    // Task 10 holds 17 to 19 Nov from the request key test. Task 20 (job 2) holds 10 Nov.
    const own = await dayProblems({ taskId: 10, jobId: 1, installerId: 1, dates: ["2026-11-17", "2026-11-18"] });
    expect(own).toEqual([]);
    const clash = await dayProblems({ taskId: 10, jobId: 1, installerId: 1, dates: ["2026-11-10", "2026-11-11"] });
    expect(clash).toHaveLength(1);
    expect(clash[0]).toMatchObject({ date: "2026-11-10", installerId: 1 });
    expect(clash[0]!.what).toContain("Job #");
    // Same day handed to Ben: no clash for him.
    const handed = await dayProblems({ taskId: 10, jobId: 1, installerId: 1, dates: ["2026-11-10"], perDayInstaller: new Map([["2026-11-10", 2]]) });
    expect(handed).toEqual([]);
  });

  test("a day off is a problem", async () => {
    await q("INSERT INTO installer_unavailability (installer_id, kind, from_date, to_date, reason, created_at, updated_at) VALUES (2, 'range', '2026-11-24', '2026-11-25', 'Leave', 0, 0)");
    const off = await dayProblems({ taskId: 10, jobId: 1, installerId: 2, dates: ["2026-11-24", "2026-11-26"] });
    expect(off.map((p) => p.date)).toEqual(["2026-11-24"]);
  });

  test("with a reason the reason is on the audit row", async () => {
    const reason = "Ana confirmed she can do both, short job";
    const v = await version();
    await writeBooking(client, { ...booking(v, ["2026-11-10"]), audit: { action: "task.book", before: null, after: null, reason, requestKey: null } });
    const [row] = await q("SELECT reason, actor_name, before_json, after_json FROM audit_events WHERE task_id = 10 ORDER BY id DESC LIMIT 1");
    expect(row.reason).toBe(reason);
    expect(row.actor_name).toBe("Tester");
  });
});

describe("permission table", () => {
  const login = (role: PermActor["role"], duties: string[] = [], canSeeCosts = role === "admin"): PermActor => ({ role, duties, canSeeCosts });
  const people: Record<PermRole, PermActor> = {
    admin: login("admin"),
    office: login("office", [], true),
    estimator: login("office", ["estimator"], false),
    supervisor: login("office", ["supervisor"], false),
    installer: login("field"),
  };
  // Expected answer for every action and role, written out by hand so a change to the table has to change this too.
  const expected: Record<string, PermRole[]> = {
    "task.book": ["admin", "office", "estimator", "supervisor"],
    "task.bookOverClash": ["admin", "office", "estimator", "supervisor"],
    "measure.book": ["admin", "office", "estimator", "supervisor"],
    "measure.reassign": ["admin", "office", "estimator", "supervisor"],
    "measure.capture": ["admin", "estimator", "installer"],
    "quote.own": ["admin", "office", "estimator", "supervisor"],
    "quote.changeDueDate": ["admin", "office", "estimator", "supervisor"],
    "handover.authoriseException": ["admin", "supervisor"],
    "queue.viewOffice": ["admin", "office", "estimator", "supervisor"],
    "measureFee.set": ["admin", "office"],
    "measureFee.chooseCredit": ["admin", "office"],
    "costs.view": ["admin", "office"],
    "audit.view": ["admin"],
    "settings.bookingSafety": ["admin"],
  };

  test("every action has an expected row", () => {
    expect(Object.keys(expected).sort()).toEqual([...ACTIONS].sort());
  });

  for (const action of ACTIONS) {
    for (const role of Object.keys(people) as PermRole[]) {
      const want = expected[action]!.includes(role);
      test(`${action} / ${role}: ${want ? "allowed" : "refused"}`, () => {
        expect(can(people[role], action)).toBe(want);
      });
    }
  }

  test("a field login never gets office actions, whatever duties it carries", () => {
    const fieldWithDuties = login("field", ["estimator", "supervisor"]);
    for (const action of ACTIONS) {
      const rule = PERMISSIONS[action] as { field?: boolean };
      if (!rule.field) expect(can(fieldWithDuties, action)).toBe(false);
    }
    expect(can(fieldWithDuties, "measure.capture")).toBe(true);
  });

  test("office without cost access can't see or set costs", () => {
    const office = login("office", [], false);
    expect(can(office, "costs.view")).toBe(false);
    expect(can(office, "measureFee.set")).toBe(false);
    expect(can(office, "measureFee.chooseCredit")).toBe(false);
    expect(can(office, "task.book")).toBe(true);
  });

  test("a builder's site supervisor has no login, so nothing is allowed", () => {
    for (const action of ACTIONS) {
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action)).toBe(false);
    }
  });

  test("duties: unknown words dropped, admin is just admin", () => {
    expect(parseDuties(" Estimator, boss ,supervisor,estimator")).toEqual(["estimator", "supervisor"]);
    expect(parseDuties(null)).toEqual([]);
    expect([...rolesOf(login("admin", ["supervisor"]))]).toEqual(["admin"]);
    expect([...rolesOf(login("field", ["estimator"]))].sort()).toEqual(["estimator", "installer"]);
  });
});
