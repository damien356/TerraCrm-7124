import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "./schema";
/* Live here: only used inside build(), which always runs under onLive. */
import { db as liveDb } from "./__client";
import { onLive, type DemoDb, type TerraDb } from "./routed";
import { seedDemo, DEMO_INSTALLER_ID } from "./demo-seed";
import { todayLocal } from "../lib/local-date";

/**
 * THE GOOGLE PLAY REVIEWER'S DATABASE.
 *
 * Google needs a login that opens every screen of the Android app. Handing it a
 * real login would show real customers, addresses, phone numbers and prices, so
 * the reviewer login is pointed at a separate, made up Terra instead.
 *
 * - The sign-in itself is a normal live login (auth tables are always live).
 * - Every request from that login runs against this demo database.
 * - The demo is a local SQLite file built on first use: the table layout is
 *   copied from the live database (structure only, no rows) so it always
 *   matches the code, then filled with invented jobs, crew and customers.
 * - It is rebuilt each new Gold Coast day so "Today" always has work on it.
 *   The reviewer's phone registrations and Siri or geofence keys carry over.
 * - Background engines (journeys, reminders, the mail agent) only ever run on
 *   live, so they never see a demo row.
 * - Texts and emails are switched off in demo mode at the one place each is
 *   sent from (lib/sms.ts, lib/email.ts, lib/gmail.ts). Uploads go under demo/.
 */

/** The reviewer's sign-in. A username only, there is no mailbox behind it. */
export const PLAY_REVIEW_EMAIL = "google-review@terraflooring.com.au";

export const isPlayReviewer = (email: string | null | undefined) =>
  (email ?? "").trim().toLowerCase() === PLAY_REVIEW_EMAIL;

const DIR = process.env.PLAY_DEMO_DIR || join(tmpdir(), "terra-play-demo");
const FILE_PREFIX = "terra-play-demo-";

type Built = DemoDb & { date: string; file: string | null };

let current: Built | null = null;
let building: Promise<Built> | null = null;

/** The demo database for today, built on first call of the day. */
export async function demoDatabase(): Promise<DemoDb> {
  const today = todayLocal();
  if (current && current.date === today) return current;
  if (!building) {
    /* Built on live (it reads the table layout) even if asked from a demo request. */
    building = onLive(() => build(today, current)).finally(() => {
      building = null;
    });
  }
  return building;
}

/** For the scratch tests and the status line in diag. */
export const demoBuiltOn = () => current?.date ?? null;

async function openClient(today: string): Promise<{ client: Client; file: string | null }> {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    if (!current) {
      /* A fresh process: anything left in the folder is from a previous run. */
      for (const f of readdirSync(DIR)) if (f.startsWith(FILE_PREFIX)) rmSync(join(DIR, f), { force: true });
    }
    const file = join(DIR, `${FILE_PREFIX}${today}-${Date.now()}.db`);
    const client = createClient({ url: `file:${file}` });
    await client.execute("select 1");
    return { client, file };
  } catch (e) {
    /* No writable disk: keep it in memory. It is rebuilt daily anyway. */
    console.error("[play-demo] no writable folder, using memory", e);
    return { client: createClient({ url: ":memory:" }), file: null };
  }
}

/** Table and index definitions from live. Structure only, never a row. */
async function liveStructure() {
  const res = await liveDb.$client.execute(
    "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and name not like 'libsql_%' and name not like '_litestream%'",
  );
  const order: Record<string, number> = { table: 0, index: 1, view: 2, trigger: 3 };
  return res.rows
    .map((r) => ({ type: String(r.type), sql: String(r.sql) }))
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));
}

/** Small reference lists that hold no customer, price or pay data. */
async function liveReference() {
  const [skills, statuses] = await Promise.all([
    liveDb.select().from(schema.skills),
    liveDb.select().from(schema.jobStatuses),
  ]);
  return { skills, statuses };
}

async function build(today: string, previous: Built | null): Promise<Built> {
  const started = Date.now();
  const [ddl, reference] = await Promise.all([liveStructure(), liveReference()]);
  const { client, file } = await openClient(today);
  for (const stmt of ddl) await client.execute(stmt.sql);
  const target = drizzle(client, { schema }) as unknown as TerraDb;

  await seedDemo(target, today, reference);
  if (previous) await carryOver(previous.db, target);

  const built: Built = { db: target, client, date: today, file };
  current = built;
  console.log(`[play-demo] built for ${today} in ${Date.now() - started}ms${file ? ` at ${file}` : " in memory"}`);

  if (previous) {
    /* Let any request still running on yesterday's copy finish first. */
    setTimeout(() => {
      previous.client.close();
      if (previous.file) rmSync(previous.file, { force: true });
    }, 10 * 60_000).unref?.();
  }
  return built;
}

/**
 * The reviewer's own registrations survive the daily rebuild: the phone's push
 * token, and the crew key the geofence and Siri use. Losing them would sign
 * the phone's background features out every night.
 */
async function carryOver(from: TerraDb, to: TerraDb) {
  const devices = await from.select().from(schema.deviceTokens);
  if (devices.length) await to.insert(schema.deviceTokens).values(devices.map(({ id: _id, ...d }) => d)).onConflictDoNothing();

  const keys = await from.select().from(schema.voiceKeys).where(eq(schema.voiceKeys.installerId, DEMO_INSTALLER_ID));
  if (keys.length) await to.insert(schema.voiceKeys).values(keys.map(({ id: _id, ...k }) => k)).onConflictDoNothing();

  const profiles = await from.select().from(schema.profiles);
  for (const { id: _id, ...p } of profiles) {
    if (p.role === "admin") await ensureReviewerProfile(to, p.userId, p.name, p.email);
  }
}

/**
 * The reviewer is both office and crew: admin, linked to the demo installer
 * "Mick R.", so the Office tab and Today, Coming up and Offers all show.
 * Put back on every request in case the reviewer edits their own login.
 */
export async function ensureReviewerProfile(target: TerraDb, userId: string, name: string, email: string) {
  const [row] = await target.select().from(schema.profiles).where(eq(schema.profiles.userId, userId));
  if (!row) {
    await target
      .insert(schema.profiles)
      .values({ userId, name: name || "Play Reviewer", email, role: "admin", installerId: DEMO_INSTALLER_ID, active: true })
      .onConflictDoNothing();
    await target
      .update(schema.installers)
      .set({ userId })
      .where(eq(schema.installers.id, DEMO_INSTALLER_ID));
    return;
  }
  if (row.role !== "admin" || row.installerId !== DEMO_INSTALLER_ID || !row.active) {
    await target
      .update(schema.profiles)
      .set({ role: "admin", installerId: DEMO_INSTALLER_ID, active: true, updatedAt: new Date() })
      .where(eq(schema.profiles.id, row.id));
  }
}
