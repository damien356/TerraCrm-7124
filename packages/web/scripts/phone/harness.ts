/**
 * Shared set-up for the AI phone agent tests (Retell, 5 Nov).
 *
 * A throwaway database file built from schema.ts. Push, email, SMS, the job
 * mailer, the quote PDF, the Google address lookup and the Google calendar
 * are replaced with recorders, and fetch is blocked, so no test can reach
 * Retell, Resend, Google, the SMS gateway or anyone's phone.
 *
 * Imported by phone.test.ts only. Run from packages/web: bun test scripts/phone
 */
import { mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../../src/api/database/schema";

export { schema };

export const dir = mkdtempSync(join(tmpdir(), "phone-test-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY = "re_test_not_used";
process.env.RETELL_API_KEY = "retell_test_key_not_real";
delete process.env.RETELL_AGENT_ID;
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.XERO_CLIENT_ID;
delete process.env.XERO_CLIENT_SECRET;

/** Everything that tried to leave the machine, and the switches that make the fakes misbehave. */
export const outside = {
  fetch: [] as string[],
  push: [] as { userIds: string[]; title: string }[],
  email: [] as { to: string; subject: string }[],
  sms: [] as { to: unknown }[],
  jobMail: [] as { to: string; subject: string; jobId: number | null }[],
  /** Calendar reads, by link id. */
  freeBusy: [] as number[],
  /** Private busy times Google would return, per calendar link id. Epoch ms. */
  busy: new Map<number, { startAt: number; endAt: number }[]>(),
  /** Make the next createJob throw, as a database error would. */
  failCreateJob: 0,
  /** What the Google address lookup finds. Null: nothing. */
  place: null as null | { address: string; suburb: string; state: string; postcode: string; lat: number; lng: number; placeId: string },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? input);
  outside.fetch.push(url);
  throw new Error(`Network blocked in phone tests: ${url}`);
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
    // One "device" per signed-in phone. Counted from device_tokens, as the real one would.
    sendPush: async (userIds: string[], m: { title: string }) => {
      outside.push.push({ userIds, title: m.title });
      return userIds.length;
    },
    pushToInstaller: async () => 0,
    pushToOffice: async () => 0,
  }));
  const realEmail = await import("../../src/api/lib/email");
  mock.module("../../src/api/lib/email", () => ({
    ...realEmail,
    sendEmail: async (a: { to: string; subject: string }) => {
      if (!/@[a-z0-9.-]+\.invalid$/i.test(String(a.to))) throw new Error(`Test email must go to a .invalid address, not ${String(a.to)}`);
      outside.email.push({ to: String(a.to), subject: String(a.subject) });
      return { ok: true, id: `test-${outside.email.length}` };
    },
  }));
  const realS3 = await import("../../src/api/lib/s3");
  mock.module("../../src/api/lib/s3", () => ({ ...realS3, putObject: async () => {} }));
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
    sendJobEmail: async (a: { to: string; subject: string; jobId: number | null }) => {
      if (!/@[a-z0-9.-]+\.invalid$/i.test(a.to)) throw new Error(`Test quote email must go to a .invalid address, not ${a.to}`);
      outside.jobMail.push({ to: a.to, subject: a.subject, jobId: a.jobId });
      return { via: "test", message: { id: outside.jobMail.length }, linked: [] };
    },
  }));
  const realBundles = await import("../../src/api/routes/quoteBundles");
  mock.module("../../src/api/routes/quoteBundles", () => ({
    ...realBundles,
    clientPdfFor: async (quoteId: number) => ({ pdf: Buffer.from(`%PDF-test ${quoteId}`), filename: `quote-${quoteId}.pdf`, ref: `Q${quoteId}` }),
  }));
  const realIntake = await import("../../src/api/lib/lead-intake");
  mock.module("../../src/api/lib/lead-intake", () => ({ ...realIntake, lookUpAddress: async () => outside.place }));
  const realCal = await import("../../src/api/lib/google-calendar");
  mock.module("../../src/api/lib/google-calendar", () => ({
    ...realCal,
    freeBusy: async (linkId: number, calendarIds: string[]) => {
      outside.freeBusy.push(linkId);
      return (outside.busy.get(linkId) ?? []).map((b) => ({ calendarId: calendarIds[0] ?? "c1", ...b }));
    },
  }));
  const realJobs = await import("../../src/api/routes/jobs");
  // mock.module patches the live namespace, so hold on to the real function first.
  const realCreateJob = realJobs.createJob;
  mock.module("../../src/api/routes/jobs", () => ({
    ...realJobs,
    createJob: async (...a: Parameters<typeof realJobs.createJob>) => {
      if (outside.failCreateJob > 0) {
        outside.failCreateJob--;
        throw new Error("Test: the database refused the write");
      }
      return realCreateJob(...a);
    },
  }));

  return {
    db: (await import("../../src/api/database")).db,
    drizzle: await import("drizzle-orm"),
    localDate: await import("../../src/api/lib/local-date"),
    config: await import("../../src/api/lib/phone/config"),
    calls: await import("../../src/api/lib/phone/calls"),
    caller: await import("../../src/api/lib/phone/caller"),
    fns: await import("../../src/api/lib/phone/functions"),
    webhook: await import("../../src/api/lib/phone/webhook"),
    followups: await import("../../src/api/lib/phone/followups"),
    routing: await import("../../src/api/lib/phone/routing"),
    visits: await import("../../src/api/lib/phone/visits"),
    notify: await import("../../src/api/lib/phone/notify"),
    signature: await import("../../src/api/lib/phone/signature"),
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

/* --------------------------------- seeds --------------------------------- */

export type Seed = Awaited<ReturnType<typeof seed>>;

/**
 * The office as the tests need it: Damien as admin, three office people
 * (one switched off, one archived), a duty person, a measurer with a linked
 * calendar, and two customers. A has one job, B has two.
 */
export async function seed() {
  const { db } = m();
  const [lead] = await db.insert(schema.jobStatuses).values({ name: "Lead", stage: "open", sortOrder: 1 }).returning();
  await db.insert(schema.jobStatuses).values([
    { name: "Quoted", stage: "open", sortOrder: 2 },
    { name: "Complete", stage: "complete", sortOrder: 8 },
  ]);
  await db.insert(schema.leadSources).values([{ name: "Phone" }, { name: "AI phone call" }]);

  const person = async (key: string, role: "admin" | "office" | "field", extra: Partial<typeof schema.profiles.$inferInsert> = {}) => {
    const [p] = await db
      .insert(schema.profiles)
      .values({ userId: `u-${key}`, name: `Test ${key}`, email: `${key}@example.invalid`, role, isMainAdmin: key === "damien", canSeeCosts: role === "admin", ...extra })
      .returning();
    return p!;
  };
  const damien = await person("damien", "admin");
  const sam = await person("sam", "office", { phone: "0400 000 111" });
  const kim = await person("kim", "office");
  const lou = await person("lou", "office");
  const off = await person("off", "office", { active: false });
  const gone = await person("gone", "office", { archivedAt: new Date() });
  const duty = await person("duty", "office");
  const field = await person("field", "field");
  // Sam and the duty person have a phone signed in. Kim and Lou don't.
  await db.insert(schema.deviceTokens).values([
    { userId: sam.userId, token: "ExponentPushToken[test-sam]" },
    { userId: duty.userId, token: "ExponentPushToken[test-duty]" },
  ]);

  const [skill] = await db.insert(schema.skills).values({ name: "Measure & quote" }).returning();
  const [measurer] = await db.insert(schema.installers).values({ name: "Mo Measurer", worksWeekendDays: "[]" }).returning();
  const [measurer2] = await db.insert(schema.installers).values({ name: "Cal Calendar", worksWeekendDays: "[]" }).returning();
  await db.insert(schema.installerSkills).values([
    { installerId: measurer!.id, skillId: skill!.id },
    { installerId: measurer2!.id, skillId: skill!.id },
  ]);
  const calOwner = await person("calowner", "field");
  const [link] = await db
    .insert(schema.calendarLinks)
    .values({ installerId: measurer2!.id, ownerProfileId: calOwner.id, refreshTokenSealed: "sealed-test-not-real", calendarIds: '["c1"]', bufferBeforeMin: 0, bufferAfterMin: 0 })
    .returning();

  const contact = async (first: string, last: string, mobile: string, email: string) => {
    const [c] = await db.insert(schema.contacts).values({ firstName: first, lastName: last, mobile, email }).returning();
    return c!;
  };
  const alice = await contact("Alice", "Anders", "0411 111 111", "alice@example.invalid");
  const bob = await contact("Bob", "Brown", "0422 222 222", "bob@example.invalid");
  // Shares Alice's number (a couple on one mobile). The number alone must not unlock either card.
  const andy = await contact("Andy", "Anders", "0411 111 111", "andy@example.invalid");

  const site = async (address: string, suburb: string, contactId: number) => {
    const [s] = await db.insert(schema.sites).values({ address, suburb, contactId }).returning();
    return s!;
  };
  const sA = await site("12 Smith Street, Robina", "Robina", alice.id);
  const sB1 = await site("5 Ocean Parade, Burleigh", "Burleigh", bob.id);
  const sB2 = await site("88 Hill Road, Mudgeeraba", "Mudgeeraba", bob.id);

  const job = async (number: number, contactId: number, siteId: number, title: string) => {
    const [j] = await db
      .insert(schema.jobs)
      .values({ number, contactId, siteId, title, statusId: lead!.id, billToType: "contact", billToContactId: contactId, value: 0 })
      .returning();
    return j!;
  };
  const jobA = await job(4101, alice.id, sA.id, "Carpet, three bedrooms");
  const jobB1 = await job(4102, bob.id, sB1.id, "Hybrid, living");
  const jobB2 = await job(4103, bob.id, sB2.id, "Timber, stairs");

  return { lead: lead!, damien, sam, kim, lou, off, gone, duty, field, calOwner, skill: skill!, measurer: measurer!, measurer2: measurer2!, link: link!, alice, bob, andy, sA, sB1, sB2, jobA, jobB1, jobB2 };
}

/** Phone settings as Damien would set them on the screen, switched on. */
export async function configure(s: Seed, patch: Record<string, unknown> = {}) {
  const { config } = m();
  const base = config.defaultConfig();
  const team = (key: string, memberIds: number[]) => ({ ...base.teams.find((t) => t.key === key)!, memberIds });
  const cfg = config.phoneConfigSchema.parse({
    ...base,
    enabled: true,
    // Open every day, all day, so office-time deadlines are plain minutes in these tests.
    officeHours: { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" },
    teams: [team("office", [s.sam.id, s.kim.id]), team("sales", [s.sam.id]), team("scheduling", [s.kim.id]), team("accounts", [s.lou.id]), team("managers", [s.damien.id])],
    dutyProfileId: s.duty.id,
    visits: { ...base.visits, minNoticeHours: 0, bufferMins: 0, durationMins: 60, startTimes: ["08:00", "10:00", "13:00"], daysAhead: 21 },
    ...patch,
  });
  await config.savePhoneConfig(cfg);
  return cfg;
}

let callNo = 0;
/** A Retell call object, as Retell posts it. */
export function call(from: string | null, extra: Record<string, unknown> = {}) {
  return { call_id: `call_test_${++callNo}_${Date.now()}`, agent_id: "agent_test", direction: "inbound", from_number: from, to_number: "+61756905370", start_timestamp: Date.now(), ...extra };
}

export const MIN = 60_000;
