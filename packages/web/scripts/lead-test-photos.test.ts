/**
 * TEST enquiries with photos (Damien, 12 Nov 2026).
 *
 *   bun test scripts/lead-test-photos.test.ts      (from packages/web)
 *
 * The herringbone page check found that a TEST enquiry with photos still put
 * "Check new files before the crew see them" on the office list. A TEST must
 * tell nobody and add nothing to the office list. A real enquiry with photos
 * keeps both its tasks and its alert.
 *
 * Runs the real form intake on a throwaway SQLite file built from the schema.
 * Storage is an in-memory store, the alert, push and email senders are stubs,
 * the AI reader is a stub, and every network call is blocked. Nothing leaves
 * the machine.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "lead-test-photos-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
delete process.env.GOOGLE_PLACES_API_KEY;
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.DOC_CLASSIFY_AI;

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const alerts: string[] = [];
const emails: string[] = [];
const store = new Map<string, Buffer>();
let readerFails = false;

let m: {
  intake: typeof import("../src/api/lib/lead-intake");
  dc: typeof import("../src/api/lib/doc-classify");
};
let client: Client;
const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];

// A tiny real JPEG header is enough: the intake checks the type and size, the reader is a stub.
const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000 + n, n)]);
const photos = () => [
  { name: "lounge.jpg", type: "image/jpeg", bytes: jpeg(1) },
  { name: "hall.jpg", type: "image/jpeg", bytes: jpeg(2) },
];
let seq = 0;
const post = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  mobile: `049157${String(1000 + ++seq).slice(-4)}`,
  email: `lead-${seq}@example.invalid`,
  suburb: "Robina 4226",
  message: "Living and kitchen, about 40 sqm.",
  enquiryRef: `herringbone-t${seq}`,
  _elapsed: 15000,
  ...extra,
});

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in lead-test-photos tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realS3 = await import("../src/api/lib/s3");
  mock.module("../src/api/lib/s3", () => ({
    ...realS3,
    getObject: async (key: string) => {
      const b = store.get(key);
      if (!b) throw new Error("NoSuchKey");
      return b;
    },
    putObject: async (key: string, body: Buffer) => {
      store.set(key, Buffer.from(body));
    },
  }));
  const realNotify = await import("../src/api/lib/notify");
  mock.module("../src/api/lib/notify", () => ({
    ...realNotify,
    notifyOffice: async (kind: string) => {
      alerts.push(kind);
    },
  }));
  const realPush = await import("../src/api/lib/push");
  mock.module("../src/api/lib/push", () => ({ ...realPush, sendPush: async () => 0, pushToInstaller: async () => 0, pushToOffice: async () => 0 }));
  const realMail = await import("../src/api/lib/agent-mail");
  mock.module("../src/api/lib/agent-mail", () => ({
    ...realMail,
    sendAsTeam: async (a: { to: string }) => {
      emails.push(a.to);
      return { ok: true } as any;
    },
  }));

  m = { intake: await import("../src/api/lib/lead-intake"), dc: await import("../src/api/lib/doc-classify") };
  m.dc.aiReader.look = async () => {
    if (readerFails) throw new Error("reader unavailable");
    return { showsPricesOrMoney: false, docType: "photo", category: "client_reported", sure: true } as any;
  };

  await client.execute({
    sql: "insert into landing_pages (url, lead_source, client_type, tags, follow_up_on, form_key, conversion_label, timber, active, created_at, updated_at) values (?, ?, 'homeowner', '[]', 1, 'herringbone', '', 0, 1, unixepoch(), unixepoch())",
    args: ["herringbone.terraflooring.com.au", "Google Ads: Herringbone"],
  });
}, 60_000);

afterAll(() => {
  client?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

async function take(raw: Record<string, unknown>, files = photos()) {
  const out = await m.intake.takeLead("herringbone", raw, files, { ip: "203.0.113.20", userAgent: "test", origin: "https://herringbone.terraflooring.com.au" });
  await m.dc.checksSettled();
  return out;
}
const tasksOf = (jobId: number) => q("select title from office_tasks where job_id = ? order by id", [jobId]);
const mediaOf = (jobId: number) => q("select visibility, review_status from job_media where job_id = ? order by id", [jobId]);

describe("A TEST enquiry with photos tells nobody", () => {
  test("2 photos kept office only, no office task, no alert, no email", async () => {
    const before = { alerts: alerts.length, emails: emails.length };
    const out = await take(post("TEST herringbone QA desktop"));
    expect(out.verdict).toBe("ok");
    expect(out.jobRef).toBeTruthy();
    const jobId = out.jobId!;
    const [job] = await q("select title, tags from jobs where id = ?", [jobId]);
    expect(job.title.startsWith("TEST: ")).toBe(true);
    expect(JSON.parse(job.tags)).toContain("TEST enquiry");
    const media = await mediaOf(jobId);
    expect(media.length).toBe(2);
    for (const r of media) {
      expect(r.visibility).toBe("office");
      expect(r.review_status).toBe("needs_review");
    }
    expect(await tasksOf(jobId)).toEqual([]);
    expect(alerts.length).toBe(before.alerts);
    expect(emails.length).toBe(before.emails);
  });

  test("still no office task when the photo reader fails", async () => {
    readerFails = true;
    try {
      const out = await take(post("TEST herringbone QA reader down"));
      expect((await mediaOf(out.jobId!)).length).toBe(2);
      expect(await tasksOf(out.jobId!)).toEqual([]);
    } finally {
      readerFails = false;
    }
  });

  test("the retry of the same TEST is the same job and adds nothing", async () => {
    const raw = post("TEST herringbone QA retry");
    const first = await take(raw);
    const again = await take(raw);
    expect(again.verdict).toBe("duplicate");
    expect(again.jobRef).toBe(first.jobRef);
    expect(await tasksOf(first.jobId!)).toEqual([]);
  });
});

describe("A real enquiry with photos is unchanged", () => {
  test("call task, photo check task and the new lead alert", async () => {
    const before = alerts.length;
    const out = await take(post("Sam Example"));
    expect(out.verdict).toBe("ok");
    const titles = (await tasksOf(out.jobId!)).map((r) => r.title as string);
    expect(titles.some((t) => t.startsWith("Call new lead: Sam Example"))).toBe(true);
    expect(titles.some((t) => t.startsWith("Check new files before the crew see them"))).toBe(true);
    expect(titles.length).toBe(2);
    expect(alerts.slice(before)).toEqual(["lead_new"]);
  });

  test("a real enquiry whose reader fails still gets its photo check task", async () => {
    readerFails = true;
    try {
      const out = await take(post("Alex Example"));
      const titles = (await tasksOf(out.jobId!)).map((r) => r.title as string);
      expect(titles.filter((t) => t.startsWith("Check new files")).length).toBe(1);
    } finally {
      readerFails = false;
    }
  });
});

test("nothing reached the network", () => {
  expect(blocked).toEqual([]);
});
