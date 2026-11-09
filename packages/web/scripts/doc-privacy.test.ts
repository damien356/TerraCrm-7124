/**
 * Document privacy (Damien's urgent brief, 9 Nov 2026).
 *
 *   bun test scripts/doc-privacy.test.ts      (from packages/web)
 *
 * Runs the real filing, reading, listing and crew code on a throwaway SQLite
 * file built from the schema. The job is a copy of job 4242 (188016) as it was:
 * Dion (installer 21) holds task 77, and Henry's reply with the quote PDF is
 * moved onto the job the way the office did it. Sign in is faked with real
 * profiles and roles (assigned Field installer, another installer, logged
 * out, Admin, Office without cost access), storage is an in-memory store, the
 * AI reader is a stub, and every network call is blocked. Nothing leaves the
 * machine.
 *
 * Set DOC_PRIVACY_REAL_QUOTE to a local copy of the Q188016 PDF to run test 1
 * on the real bytes. Without it a Terra quote of the same shape is used.
 *
 * Brief section 7, one describe block per row:
 *   1  Henry's reply on a safe copy
 *   2  A quote renamed floor-plan.pdf, and a photo of a quote
 *   3  A restricted quote put in Plans by hand
 *   4  Access photo + quote + quoted pricing in one email
 *   5  Key instructions with no attachment
 *   6  A safe plan on a quote-reply thread
 *   7  A mixed plan-and-price PDF, and a signed quote
 *   8  Read failure, unsupported file, still being read
 *   9  Crew with a copied link or a guessed file or job id
 *   10 Approval revoked, crew taken off the job
 *   11 The installer's own pay and own invoice still work
 *   12 The same email filed again and re-read
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "doc-privacy-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";
delete process.env.DOC_CLASSIFY_AI;

const realFetch = globalThis.fetch;
const blocked: string[] = [];
const alerts: string[] = [];
const pushes: number[] = [];

type Who = { id: string; name: string; email: string } | null;
const ADMIN: Who = { id: "t-admin", name: "Test Admin", email: "admin@example.invalid" };
const OFFICE: Who = { id: "t-office", name: "Test Office", email: "office@example.invalid" };
const DION_LOGIN: Who = { id: "t-dion", name: "Dion", email: "dion@example.invalid" };
const OTHER_LOGIN: Who = { id: "t-other", name: "Other Installer", email: "other@example.invalid" };
let who: Who = ADMIN;
async function as<T>(w: Who, fn: () => Promise<T>): Promise<T> {
  who = w;
  try {
    return await fn();
  } finally {
    who = ADMIN;
  }
}

const DION = 21;
const OTHER = 22;
const JOB = 4242;
const OTHER_JOB = 4300;
const TASK = 77;
const OTHER_TASK = 78;

/* ------------------------------ storage stub ------------------------------ */

const store = new Map<string, Buffer>();
const SIGNED = "https://store.invalid/";
/** What a browser gets from a link. Only a signed link opens: the bucket is private. */
function download(url: string) {
  if (!url.startsWith(SIGNED) || !url.includes("?sig=")) throw new Error("403 AccessDenied");
  const key = decodeURIComponent(url.slice(SIGNED.length, url.indexOf("?sig=")));
  const b = store.get(key);
  if (!b) throw new Error("404");
  return b;
}

/* -------------------------------- the reader ------------------------------ */

type Look = { showsPricesOrMoney: boolean; docType: string; category: string; sure: boolean };
let looks: Record<string, Look | "fail" | Promise<Look>> = {};
const readerCalls: string[] = [];

let m: {
  db: typeof import("../src/api/database").db;
  call: typeof import("@orpc/server").call;
  orm: typeof import("drizzle-orm");
  dc: typeof import("../src/api/lib/doc-classify");
  intake: typeof import("../src/api/lib/file-intake");
  filing: typeof import("../src/api/lib/mail-filing");
  prep: typeof import("../src/api/lib/prep");
  media: typeof import("../src/api/routes/media").media;
  field: typeof import("../src/api/routes/field").field;
  upload: typeof import("../src/api/routes/upload").upload;
  access: typeof import("../src/api/routes/access-notes").accessNotes;
  invoices: typeof import("../src/api/routes/installerInvoices").installerInvoices;
  jobMail: typeof import("../src/api/lib/job-mail");
};
let client: Client;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown) => {
    blocked.push(String(input));
    throw new Error(`Network blocked in doc-privacy tests: ${String(input)}`);
  }) as unknown as typeof fetch;
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);

  const realS3 = await import("../src/api/lib/s3");
  const signGet = async (key: string) => `${SIGNED}${encodeURIComponent(key)}?sig=1`;
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
    signGet,
    signMany: async <T extends { storageKey: string }>(rows: T[]) => Promise.all(rows.map(async (r) => ({ ...r, url: await signGet(r.storageKey) }))),
    signPut: async (key: string) => `${SIGNED}${encodeURIComponent(key)}?put=1`,
  }));
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
    pushToInstaller: async (id: number) => {
      pushes.push(id);
      return 0;
    },
    pushToOffice: async () => 0,
  }));
  mock.module("../src/api/auth", () => ({
    NO_LOGIN: "no login",
    auth: { api: { getSession: async () => (who ? { user: who, session: {} } : null) } },
  }));

  m = {
    db: (await import("../src/api/database")).db,
    call: (await import("@orpc/server")).call,
    orm: await import("drizzle-orm"),
    dc: await import("../src/api/lib/doc-classify"),
    intake: await import("../src/api/lib/file-intake"),
    filing: await import("../src/api/lib/mail-filing"),
    prep: await import("../src/api/lib/prep"),
    media: (await import("../src/api/routes/media")).media,
    field: (await import("../src/api/routes/field")).field,
    upload: (await import("../src/api/routes/upload")).upload,
    access: (await import("../src/api/routes/access-notes")).accessNotes,
    invoices: (await import("../src/api/routes/installerInvoices")).installerInvoices,
    jobMail: await import("../src/api/lib/job-mail"),
  };
  m.dc.aiReader.look = async (_bytes: Buffer, _mime: string, filename: string) => {
    readerCalls.push(filename);
    const l = looks[filename];
    if (!l || l === "fail") throw new Error("reader unavailable");
    return (await l) as any;
  };
  await seed();
}, 60_000);

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

/* --------------------------------- fixtures -------------------------------- */

async function pdf(lines: string[]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  lines.forEach((l, i) => page.drawText(l, { x: 40, y: 800 - i * 16, size: 10, font }));
  return Buffer.from(await doc.save());
}

const QUOTE_LINES = [
  "Terra Flooring - Arclan Pty Ltd",
  "Quote Q188016 for Soho Projects, 100 William St Woolloomooloo",
  "Interface Connected Ethos carpet tiles supply 55.00 m2 at $59.15 per m2",
  "Carpet tile install 50.00 m2 at $14.00 per m2",
  "Grinding and preparation of the substrate before installation",
  "Subtotal $4,120.00   GST $412.00   Total $4,532.00 inc GST",
  "Deposit 0%. Balance due on completion. Please pay to the account below.",
];

let siteId = 0;
let msgSeq = 0;

/** An email in, on the job's thread, with files already in storage, the way mail-replies left Henry's. */
async function emailIn(body: string, files: { name: string; mime: string; bytes: Buffer }[], subject = "Re: Terra Flooring Quote Q188016") {
  const [msg] = await m.db
    .insert(schema.messages)
    .values({ channel: "email", direction: "in", body, subject, authorName: "Henry Ripper", fromAddress: "henry@example.invalid" } as any)
    .returning();
  for (const f of files) {
    const key = `mail/in/${msg!.id}/${++msgSeq}-${f.name}`;
    store.set(key, f.bytes);
    await m.db.insert(schema.messageAttachments).values({ messageId: msg!.id, filename: f.name, mime: f.mime, sizeBytes: f.bytes.length, storageKey: key, url: key } as any);
  }
  return msg!.id;
}

async function seed() {
  const { db } = m;
  await db.insert(schema.profiles).values({ userId: ADMIN!.id, name: "Test Admin", email: ADMIN!.email, role: "admin", isMainAdmin: true } as any);
  await db.insert(schema.profiles).values({ userId: OFFICE!.id, name: "Test Office", email: OFFICE!.email, role: "office", canSeeCosts: false } as any);
  for (const [id, name] of [
    [DION, "Dion-Michael Mahia"],
    [OTHER, "Other Installer"],
  ] as const) {
    await db.insert(schema.installers).values({ id, name, active: true } as any);
  }
  await db.insert(schema.profiles).values({ userId: DION_LOGIN!.id, name: "Dion", email: DION_LOGIN!.email, role: "field", installerId: DION } as any);
  await db.insert(schema.profiles).values({ userId: OTHER_LOGIN!.id, name: "Other", email: OTHER_LOGIN!.email, role: "field", installerId: OTHER } as any);
  const [site] = await db.insert(schema.sites).values({ address: "100 William St", suburb: "Woolloomooloo" } as any).returning();
  siteId = site!.id;
  await db.insert(schema.jobs).values({ id: JOB, number: 188016, title: "Interface Connected Ethos", siteId } as any);
  await db.insert(schema.jobs).values({ id: OTHER_JOB, number: 188090, title: "Other job", siteId } as any);
  await db.insert(schema.jobTasks).values({ id: TASK, jobId: JOB, title: "Carpet tiles", status: "assigned", assignedInstallerId: DION, scheduledDate: "2026-11-13", labourCost: 800 } as any);
  await db.insert(schema.jobTasks).values({ id: OTHER_TASK, jobId: OTHER_JOB, title: "Hybrid", status: "assigned", assignedInstallerId: OTHER, scheduledDate: "2026-11-14", labourCost: 500 } as any);
}

/** Dion's job file on the phone, as the server sends it. */
const crewFile = (w: Who = DION_LOGIN, taskId = TASK) => as(w, () => run<any>(m.field.jobFile, { taskId }));
const crewIds = async (w: Who = DION_LOGIN, taskId = TASK) => (await crewFile(w, taskId)).media.map((x: any) => x.id as number);
const row = async (id: number) => (await q("select * from job_media where id = ?", [id]))[0];
const staffItems = async (w: Who = ADMIN, jobId = JOB) => (await as(w, () => run<any[]>(m.media.list, { jobId, includeArchived: true }))).flatMap((g) => g.items);

/* ================================== 1 ================================== */

let quoteId = 0;
let quoteBytes: Buffer;
describe("1. Henry's reply on a safe copy", () => {
  test("the quote filed off his reply is restricted, and Dion can't list, preview or download it", async () => {
    const real = process.env.DOC_PRIVACY_REAL_QUOTE;
    quoteBytes = real && existsSync(real) ? readFileSync(real) : await pdf(QUOTE_LINES);
    const msg = await emailIn("Signed the quote online just now. Thanks, Henry", [{ name: "Terra_Flooring_Quote_Q188016.pdf", mime: "application/pdf", bytes: quoteBytes }]);
    await m.filing.moveMessageToJob(msg, JOB, "Test Office");
    // The row exists office only before the read finishes.
    const [att] = await q("select media_id from message_attachments where message_id = ?", [msg]);
    quoteId = Number(att.media_id);
    expect((await row(quoteId)).visibility).toBe("office");
    await m.dc.checksSettled();

    const r = await row(quoteId);
    expect(r.sensitivity).toBe("restricted");
    expect(r.restrict_reason).toBe("customer_quote");
    expect(r.visibility).toBe("office");
    expect(r.source_message_id).toBe(msg);
    expect(r.content_sha256).toHaveLength(64);
    expect(readerCalls).not.toContain("Terra_Flooring_Quote_Q188016.pdf"); // read from its own text, never sent out

    const res = await crewFile();
    const text = JSON.stringify(res);
    expect(res.media.map((x: any) => x.id)).not.toContain(quoteId);
    expect(text).not.toContain("Q188016");
    expect(text).not.toContain(r.storage_key);
    // The callback "original" path too: a callback of 188016 never carries it.
    expect(m.dc.sha256(quoteBytes)).toBe(r.content_sha256);
  });

  test("Admin opens it and gets the exact bytes; the office sees it marked Restricted", async () => {
    const it = (await staffItems(ADMIN)).find((x) => x.id === quoteId);
    expect(it.restrictLabel).toBe("Customer quote");
    expect(download(it.url).equals(quoteBytes)).toBe(true);
    const office = (await staffItems(OFFICE)).find((x) => x.id === quoteId);
    // A customer quote is not a cost document: office without costs may open it, still restricted.
    expect(office.locked).toBe(false);
    expect(office.sensitivity).toBe("restricted");
  });

  test("Show to crew is refused for it", async () => {
    const e = await failure(as(ADMIN, () => run(m.media.approveForCrew, { id: quoteId })));
    expect(String(e.message)).toContain("stays office only");
    expect((await row(quoteId)).visibility).toBe("office");
  });
});

/* ================================== 2 ================================== */

describe("2. A quote renamed floor-plan.pdf, or a photo of a quote", () => {
  test("renamed PDF: the words decide, not the name", async () => {
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/plan/x-floor-plan.pdf", filename: "floor-plan.pdf", mime: "application/pdf", caption: "Emailed", uploaderName: "Henry", bytes: quoteBytes });
    store.set("jobs/4242/plan/x-floor-plan.pdf", quoteBytes);
    await m.dc.checksSettled();
    const r = await row(id);
    expect(r.sensitivity).toBe("restricted");
    expect(r.note ?? r.classify_note).toContain("same file as one already restricted");
    expect(await crewIds()).not.toContain(id);
  });

  test("renamed PDF with fresh bytes is still read as a quote", async () => {
    const bytes = await pdf([...QUOTE_LINES, "Revision 2"]);
    store.set("jobs/4242/plan/y-floor-plan.pdf", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/plan/y-floor-plan.pdf", filename: "floor-plan.pdf", mime: "application/pdf", caption: "Emailed", uploaderName: "Henry", bytes });
    await m.dc.checksSettled();
    expect((await row(id)).sensitivity).toBe("restricted");
    expect(await crewIds()).not.toContain(id);
  });

  test("a photo of the quote: the reader sees money, so it is restricted", async () => {
    const bytes = Buffer.from("fake-jpeg-of-a-quote");
    looks["IMG_quote.jpg"] = { showsPricesOrMoney: true, docType: "quote", category: "none", sure: true };
    store.set("jobs/4242/client_reported/q.jpg", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/client_reported/q.jpg", filename: "IMG_quote.jpg", mime: "image/jpeg", caption: "Emailed", uploaderName: "Henry", bytes });
    await m.dc.checksSettled();
    expect((await row(id)).sensitivity).toBe("restricted");
    expect(await crewIds()).not.toContain(id);
  });

  test("a photo the reader isn't sure about waits for review, office only", async () => {
    const bytes = Buffer.from("fake-blurry-jpeg");
    looks["IMG_blurry.jpg"] = { showsPricesOrMoney: false, docType: "unclear", category: "none", sure: false };
    store.set("jobs/4242/client_reported/b.jpg", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/client_reported/b.jpg", filename: "IMG_blurry.jpg", mime: "image/jpeg", caption: "Emailed", uploaderName: "Henry", bytes });
    await m.dc.checksSettled();
    const r = await row(id);
    expect(r.sensitivity).toBe("unknown");
    expect(r.review_status).toBe("needs_review");
    expect(r.visibility).toBe("office");
    expect(await crewIds()).not.toContain(id);
  });
});

/* ================================== 3 ================================== */

describe("3. A restricted quote put in Plans by hand", () => {
  test("moving the restricted quote into Plans gives the crew nothing", async () => {
    await as(ADMIN, () => run(m.media.move, { id: quoteId, bucket: "plan" }));
    const r = await row(quoteId);
    expect(r.bucket).toBe("plan");
    expect(r.sensitivity).toBe("restricted");
    expect(await crewIds()).not.toContain(quoteId);
  });

  test("the office uploading a quote straight into Plans: read, restricted, never shown", async () => {
    const bytes = await pdf([...QUOTE_LINES, "Office copy"]);
    const key = "jobs/4242/plan/office-quote.pdf";
    store.set(key, bytes);
    const made = await as(OFFICE, () => run<any>(m.media.attach, { jobId: JOB, bucket: "plan", kind: "doc", storageKey: key, filename: "Plans 188016.pdf", mime: "application/pdf" }));
    expect(made.visibility).toBe("office");
    expect(await crewIds()).not.toContain(made.id);
    await m.dc.checksSettled();
    expect((await row(made.id)).sensitivity).toBe("restricted");
    expect(await crewIds()).not.toContain(made.id);
  });

  test("an office photo of the floor goes to the crew once read clean", async () => {
    const bytes = Buffer.from("office-floor-photo");
    const key = "jobs/4242/area/floor.jpg";
    store.set(key, bytes);
    const made = await as(OFFICE, () => run<any>(m.media.attach, { jobId: JOB, bucket: "area", kind: "photo", storageKey: key, filename: "floor.jpg", mime: "image/jpeg" }));
    await m.dc.checksSettled();
    const r = await row(made.id);
    expect(r.visibility).toBe("crew");
    const it = (await crewFile()).media.find((x: any) => x.id === made.id);
    expect(download(it.url).equals(bytes)).toBe(true);
  });
});

/* ================================== 4 ================================== */

let accessPhotoId = 0;
describe("4. Access photo + quote + quoted pricing in one email", () => {
  test("each part is handled on its own, and only the approved photo reaches the crew", async () => {
    const photo = Buffer.from("photo-of-the-lockbox");
    looks["lockbox.jpg"] = { showsPricesOrMoney: false, docType: "site_photo", category: "access", sure: true };
    const body = [
      "The lockbox is on the left of the loading dock, code 4417. Keys are inside.",
      "",
      "> On 20 Oct, Terra Flooring wrote:",
      "> Total $4,532.00 inc GST. Carpet tile install 50 m2 at $14.00 per m2.",
    ].join("\n");
    const msg = await emailIn(body, [
      { name: "lockbox.jpg", mime: "image/jpeg", bytes: photo },
      { name: "Quote Q188016 copy.pdf", mime: "application/pdf", bytes: quoteBytes },
    ]);
    await m.filing.moveMessageToJob(msg, JOB, "Test Office");
    await m.dc.checksSettled();
    const atts = await q("select media_id, filename from message_attachments where message_id = ? order by id", [msg]);
    accessPhotoId = Number(atts[0].media_id);
    const quoteCopy = Number(atts[1].media_id);
    expect((await row(quoteCopy)).sensitivity).toBe("restricted");
    const p = await row(accessPhotoId);
    expect(p.sensitivity).toBe("normal");
    expect(p.review_status).toBe("needs_review"); // from outside: a person says yes first
    expect(await crewIds()).not.toContain(accessPhotoId);

    await m.prep.noteKeyReply({ jobId: JOB, contactId: null, body, channel: "email", name: "Henry Ripper", messageId: msg, mediaIds: [accessPhotoId, quoteCopy] });
    const props = await as(OFFICE, () => run<any>(m.access.list, { jobId: JOB }));
    const prop = props.pending[0];
    expect(prop.text).toContain("code 4417");
    expect(prop.text).not.toContain("4,532"); // the quoted pricing never becomes a note
    expect(prop.fileCount).toBe(2);

    await as(OFFICE, () => run(m.media.approveForCrew, { id: accessPhotoId }));
    const crew = await crewFile();
    expect(crew.media.map((x: any) => x.id)).toContain(accessPhotoId);
    expect(crew.media.map((x: any) => x.id)).not.toContain(quoteCopy);
    expect(JSON.stringify(crew)).not.toContain("4,532");
    expect(JSON.stringify(crew)).not.toContain("4417"); // not approved as a note yet
    expect(download(crew.media.find((x: any) => x.id === accessPhotoId).url).equals(photo)).toBe(true);
  });
});

/* ================================== 5 ================================== */

describe("5. Key instructions with no attachment", () => {
  const words = "Hi, the key safe is behind the green bin at the side gate. Code is 2580, turn left then pull.";
  test("a proposed Site access note with the exact words, nothing on the job until approved", async () => {
    const [before] = await q("select access_notes from jobs where id = ?", [OTHER_JOB]);
    expect(await m.prep.noteKeyReply({ jobId: OTHER_JOB, contactId: null, body: words, channel: "sms", name: "Client", messageId: null })).toBe(true);
    const [after] = await q("select access_notes from jobs where id = ?", [OTHER_JOB]);
    expect(after.access_notes).toBe(before.access_notes);
    const list = await as(OFFICE, () => run<any>(m.access.list, { jobId: OTHER_JOB }));
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0].text).toBe(words);
    const feed = await q("select detail from activity_log where entity_type = 'access_note_proposal'");
    for (const f of feed) expect(String(f.detail)).not.toContain("2580");
  });

  test("approved: the words go on the job as typed, the crew see them, the feed never shows the code", async () => {
    const list = await as(OFFICE, () => run<any>(m.access.list, { jobId: OTHER_JOB }));
    await as(OFFICE, () => run(m.access.approve, { id: list.pending[0].id }));
    const [j] = await q("select access_notes from jobs where id = ?", [OTHER_JOB]);
    expect(String(j.access_notes)).toContain(words);
    const card = await as(OTHER_LOGIN, () => run<any>(m.field.task, { id: OTHER_TASK }));
    expect(JSON.stringify(card)).toContain("Code is 2580");
    const feed = await q("select detail from activity_log where entity_type = 'access_note_proposal'");
    expect(feed.length).toBeGreaterThanOrEqual(2);
    for (const f of feed) expect(String(f.detail)).not.toContain("2580");
    // A second approve of the same proposal adds nothing.
    const e = await failure(as(OFFICE, () => run(m.access.approve, { id: list.pending[0].id })));
    expect(String(e.message)).toContain("Already approved");
  });
});

/* ================================== 6 ================================== */

describe("6. A safe plan on a quote-reply thread", () => {
  test("the plan is read on its own, waits for approval, and the thread stays private", async () => {
    const plan = await pdf([
      "Floor plan, Level 2, 100 William St",
      "Scale 1:100. Plan view of the office floor showing rooms to be carpeted.",
      "Room A open office area, Room B meeting room, Room C corridor to lift lobby.",
      "Set out from the north wall. Lift lobby stays as is. Doors swing inward.",
    ]);
    const msg = await emailIn("Here is the plan for level 2. As per the quote above.\n> Total $4,532.00 inc GST", [{ name: "L2-plan.pdf", mime: "application/pdf", bytes: plan }]);
    await m.filing.moveMessageToJob(msg, JOB, "Test Office");
    await m.dc.checksSettled();
    const [att] = await q("select media_id from message_attachments where message_id = ?", [msg]);
    const id = Number(att.media_id);
    const r = await row(id);
    expect(r.sensitivity).toBe("normal");
    expect(r.bucket).toBe("plan");
    expect(r.review_status).toBe("needs_review");
    expect(await crewIds()).not.toContain(id);
    await as(OFFICE, () => run(m.media.approveForCrew, { id }));
    const crew = await crewFile();
    expect(download(crew.media.find((x: any) => x.id === id).url).equals(plan)).toBe(true);
    // The email itself never goes to the crew: no message text, no subject.
    expect(JSON.stringify(crew)).not.toContain("As per the quote");
  });
});

/* ================================== 7 ================================== */

describe("7. A mixed plan-and-price PDF, or a signed quote", () => {
  test("mixed plan and prices: the whole file is restricted", async () => {
    const bytes = await pdf([
      "Floor plan Level 2, scale 1:100, plan view",
      "Room A 30 m2, Room B 20 m2, corridor to the lift lobby",
      "Pricing: carpet tiles $59.15 per m2, install $14.00 per m2, total $4,532.00 inc GST",
      "Please check the layout and the rates before we go ahead with the order.",
    ]);
    store.set("jobs/4242/plan/mixed.pdf", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/plan/mixed.pdf", filename: "plan-and-prices.pdf", mime: "application/pdf", caption: "Emailed", uploaderName: "Henry", bytes });
    await m.dc.checksSettled();
    expect((await row(id)).sensitivity).toBe("restricted");
    expect(await crewIds()).not.toContain(id);
  });

  test("a signed quote is restricted and moves to Signed documents", async () => {
    const bytes = await pdf([...QUOTE_LINES, "Signed by Henry Ripper (signed online) 9 Nov 2026 3:53 pm"]);
    store.set("jobs/4242/plan/signed.pdf", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/plan/signed.pdf", filename: "Q188016-signed.pdf", mime: "application/pdf", caption: "Emailed", uploaderName: "Henry", bytes });
    await m.dc.checksSettled();
    const r = await row(id);
    expect(r.sensitivity).toBe("restricted");
    expect(r.restrict_reason).toBe("signed");
    expect(r.bucket).toBe("signed");
    expect(await crewIds()).not.toContain(id);
  });
});

/* ================================== 8 ================================== */

describe("8. Read failure, unsupported file, still being read", () => {
  test("reader fails: private, with an office review item", async () => {
    looks["site.jpg"] = "fail";
    const bytes = Buffer.from("photo-the-reader-chokes-on");
    store.set("jobs/4300/client_reported/site.jpg", bytes);
    const id = await m.intake.fileInbound({ jobId: OTHER_JOB, storageKey: "jobs/4300/client_reported/site.jpg", filename: "site.jpg", mime: "image/jpeg", caption: "Emailed", uploaderName: "Client", bytes });
    await m.dc.checksSettled();
    const r = await row(id);
    expect(r.sensitivity).toBe("unknown");
    expect(r.visibility).toBe("office");
    expect(await crewIds(OTHER_LOGIN, OTHER_TASK)).not.toContain(id);
    const tasks = await q("select * from office_tasks where job_id = ? and status = 'open'", [OTHER_JOB]);
    expect(tasks).toHaveLength(1);
    expect(String(tasks[0].title)).toContain("Check new files");
  });

  test("an unsupported file (Word) is never read out, stays private and waits", async () => {
    const bytes = Buffer.from("PK-fake-docx");
    store.set("jobs/4300/plan/notes.docx", bytes);
    const id = await m.intake.fileInbound({ jobId: OTHER_JOB, storageKey: "jobs/4300/plan/notes.docx", filename: "notes.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", caption: "Emailed", uploaderName: "Client", bytes });
    await m.dc.checksSettled();
    const r = await row(id);
    expect(r.sensitivity).toBe("unknown");
    expect(r.review_status).toBe("needs_review");
    expect(readerCalls).not.toContain("notes.docx");
    expect(await crewIds(OTHER_LOGIN, OTHER_TASK)).not.toContain(id);
  });

  test("while the read is still running the file is not listed, even if the reader will say clean", async () => {
    let release!: (l: Look) => void;
    looks["slow.jpg"] = new Promise<Look>((r) => (release = r));
    const bytes = Buffer.from("slow-photo");
    const key = "jobs/4300/area/slow.jpg";
    store.set(key, bytes);
    const made = await as(ADMIN, () => run<any>(m.media.attach, { jobId: OTHER_JOB, bucket: "area", kind: "photo", storageKey: key, filename: "slow.jpg", mime: "image/jpeg" }));
    // Office photos skip the reader; this proves the row is still office only before the check stamps it.
    expect(made.visibility).toBe("office");
    release({ showsPricesOrMoney: false, docType: "site_photo", category: "area", sure: true });
    const id = await m.intake.fileInbound({ jobId: OTHER_JOB, storageKey: "jobs/4300/client_reported/slow2.jpg", filename: "slow.jpg", mime: "image/jpeg", caption: "Emailed", uploaderName: "Client", bytes });
    expect(await crewIds(OTHER_LOGIN, OTHER_TASK)).not.toContain(id);
    await m.dc.checksSettled();
    expect(await crewIds(OTHER_LOGIN, OTHER_TASK)).not.toContain(id); // from outside: still waits for a person
  });
});

/* ================================== 9 ================================== */

describe("9. Crew with a copied link or a guessed file or job id", () => {
  test("another installer can't open Dion's task file, and gets no names or links", async () => {
    const e = await failure(crewFile(OTHER_LOGIN, TASK));
    expect(e.code).toBe("FORBIDDEN");
    expect(JSON.stringify(e)).not.toContain("Q188016");
  });

  test("logged out: refused everywhere", async () => {
    expect((await failure(crewFile(null, TASK))).code).toBe("UNAUTHORIZED");
    expect((await failure(as(null, () => run(m.media.list, { jobId: JOB })))).code).toBe("UNAUTHORIZED");
    expect((await failure(as(null, () => run(m.access.list, { jobId: JOB })))).code).toBe("UNAUTHORIZED");
  });

  test("Field login on the office list, or on another job's upload slot: refused", async () => {
    expect((await failure(as(DION_LOGIN, () => run(m.media.list, { jobId: JOB })))).code).toBe("FORBIDDEN");
    expect((await failure(as(DION_LOGIN, () => run(m.media.approveForCrew, { id: quoteId })))).code).toBe("FORBIDDEN");
    expect((await failure(as(DION_LOGIN, () => run(m.upload.presign, { jobId: OTHER_JOB, bucket: "area", filename: "x.jpg", contentType: "image/jpeg" })))).code).toBe("FORBIDDEN");
    expect((await failure(as(DION_LOGIN, () => run(m.upload.presign, { jobId: JOB, bucket: "plan", filename: "x.pdf", contentType: "application/pdf" })))).code).toBe("FORBIDDEN");
    const ok = await as(DION_LOGIN, () => run<any>(m.upload.presign, { jobId: JOB, bucket: "area", filename: "x.jpg", contentType: "image/jpeg" }));
    expect(ok.key.startsWith(`jobs/${JOB}/area/`)).toBe(true);
    const e = await failure(as(DION_LOGIN, () => run(m.field.addMedia, { taskId: TASK, bucket: "area", storageKey: `jobs/${OTHER_JOB}/area/x.jpg` })));
    expect(e.code).toBe("BAD_REQUEST");
  });

  test("an unsigned (public style) link to any file is refused by storage", async () => {
    const r = await row(quoteId);
    expect(() => download(`${SIGNED}${encodeURIComponent(r.storage_key)}`)).toThrow("403");
  });

  test("office without cost access: a supplier invoice shows as Restricted with no link, name or note", async () => {
    const bytes = await pdf([
      "Tax Invoice INT-4471 from Interface Australia",
      "Interface Connected Ethos carpet tiles 55.00 m2 unit price $42.25",
      "Subtotal $2,323.75  GST $232.38  Amount due $2,556.13",
      "Payment terms 30 days end of month. Thank you for your business.",
    ]);
    store.set("jobs/4242/plan/supplier.pdf", bytes);
    const id = await m.intake.fileInbound({ jobId: JOB, storageKey: "jobs/4242/plan/supplier.pdf", filename: "INT-4471.pdf", mime: "application/pdf", caption: "Emailed by Interface", uploaderName: "Interface", bytes });
    await m.dc.checksSettled();
    expect((await row(id)).restrict_reason).toBe("supplier_cost");
    const office = (await staffItems(OFFICE)).find((x) => x.id === id);
    expect(office.locked).toBe(true);
    expect(office.url).toBe("");
    expect(office.filename).toBeNull();
    expect(office.caption).toBeNull();
    expect(office.classifyNote).toBeNull();
    expect(JSON.stringify(await staffItems(OFFICE))).not.toContain("INT-4471");
    const admin = (await staffItems(ADMIN)).find((x) => x.id === id);
    expect(download(admin.url).equals(bytes)).toBe(true);
    // Office without costs can't email it out either.
    const [op] = await q("select id from profiles where user_id = ?", [OFFICE!.id]);
    await expect(m.jobMail.filesFromMedia(JOB, [id], Number(op.id))).rejects.toThrow("restricted");
    const [ap] = await q("select id from profiles where user_id = ?", [ADMIN!.id]);
    expect((await m.jobMail.filesFromMedia(JOB, [id], Number(ap.id)))[0]!.content.equals(bytes)).toBe(true);
  });
});

/* ================================== 10 ================================= */

describe("10. Approval revoked, crew taken off the job", () => {
  test("Take off crew: the next request no longer lists it", async () => {
    expect(await crewIds()).toContain(accessPhotoId);
    await as(OFFICE, () => run(m.media.keepOffice, { id: accessPhotoId }));
    expect(await crewIds()).not.toContain(accessPhotoId);
    const [log] = await q("select action, actor_name from activity_log where entity_type = 'job_media' and entity_id = ? order by id desc limit 1", [accessPhotoId]);
    expect(log.action).toBe("file_crew_access_removed");
    expect(log.actor_name).toBe("Test Office");
  });

  test("Dion taken off the task: his job file, uploads and the task itself are refused", async () => {
    await q("update job_tasks set assigned_installer_id = ? where id = ?", [OTHER, TASK]);
    expect((await failure(crewFile(DION_LOGIN, TASK))).code).toBe("FORBIDDEN");
    expect((await failure(as(DION_LOGIN, () => run(m.upload.presign, { jobId: JOB, bucket: "area", filename: "x.jpg", contentType: "image/jpeg" })))).code).toBe("FORBIDDEN");
    expect((await failure(as(DION_LOGIN, () => run(m.field.task, { id: TASK })))).code).toBe("FORBIDDEN");
    await q("update job_tasks set assigned_installer_id = ? where id = ?", [DION, TASK]);
  });
});

/* ================================== 11 ================================= */

describe("11. The installer's own pay and own invoice still work", () => {
  test("Dion sees his own task pay, and opens his own invoice; not the other man's", async () => {
    const card = await as(DION_LOGIN, () => run<any>(m.field.task, { id: TASK }));
    expect(card.payTotalExGst).toBe(800);
    const pdfBytes = await pdf(["Invoice from Dion-Michael Mahia to Terra Flooring for task 77", "Labour $800.00 ex GST. Thank you."]);
    store.set("installer-invoices/21/1.pdf", pdfBytes);
    store.set("installer-invoices/22/2.pdf", pdfBytes);
    const [mine] = await m.db.insert(schema.installerInvoices).values({ installerId: DION, taskId: TASK, jobId: JOB, invoiceNumber: 1, pdfKey: "installer-invoices/21/1.pdf", total: 800 } as any).returning();
    const [his] = await m.db.insert(schema.installerInvoices).values({ installerId: OTHER, taskId: OTHER_TASK, jobId: OTHER_JOB, invoiceNumber: 2, pdfKey: "installer-invoices/22/2.pdf", total: 500 } as any).returning();
    const list = await as(DION_LOGIN, () => run<any[]>(m.invoices.myInvoices, {}));
    expect(list.map((i) => i.id)).toEqual([mine!.id]);
    const link = await as(DION_LOGIN, () => run<any>(m.invoices.downloadUrl, { invoiceId: mine!.id }));
    expect(download(link.url).equals(pdfBytes)).toBe(true);
    expect((await failure(as(DION_LOGIN, () => run(m.invoices.downloadUrl, { invoiceId: his!.id })))).code).toBe("NOT_FOUND");
  });

  test("Dion's own site photo goes straight to his job file", async () => {
    const key = `jobs/${JOB}/damage/scratch.jpg`;
    const bytes = Buffer.from("dion-damage-photo");
    store.set(key, bytes);
    const made = await as(DION_LOGIN, () => run<any>(m.field.addMedia, { taskId: TASK, bucket: "damage", storageKey: key, filename: "scratch.jpg", mime: "image/jpeg" }));
    const it = (await crewFile()).media.find((x: any) => x.id === made.id);
    expect(it.mine).toBe(true);
    expect(download(it.url).equals(bytes)).toBe(true);
  });
});

/* ================================== 12 ================================= */

describe("12. The same email filed again and re-read", () => {
  test("no duplicate rows, no relaxing, no second office task, nothing sent", async () => {
    const before = await q("select count(*) as n from job_media");
    const tasksBefore = await q("select count(*) as n from office_tasks");
    const msgs = await q("select distinct message_id from message_attachments");
    for (const r of msgs) await m.filing.moveMessageToJob(Number(r.message_id), JOB, "Test Office");
    await m.dc.checksSettled();
    expect((await q("select count(*) as n from job_media"))[0].n).toBe(before[0].n);
    expect((await q("select count(*) as n from office_tasks"))[0].n).toBe(tasksBefore[0].n);

    // Re-read every row: restricted stays restricted, an office decision is never undone.
    const kept = await row(accessPhotoId);
    for (const r of await q("select id from job_media")) await m.dc.classifyMedia(Number(r.id), "external");
    expect((await row(quoteId)).sensitivity).toBe("restricted");
    const after = await row(accessPhotoId);
    expect(after.review_status).toBe(kept.review_status);
    expect(after.visibility).toBe("office");

    // The same key note again makes no second proposal.
    const n0 = (await q("select count(*) as n from access_note_proposals"))[0].n;
    const body = "The lockbox is on the left of the loading dock, code 4417. Keys are inside.";
    await m.prep.noteKeyReply({ jobId: JOB, contactId: null, body, channel: "email", name: "Henry Ripper" });
    expect((await q("select count(*) as n from access_note_proposals"))[0].n).toBe(n0);

    expect(alerts).toEqual([]);
    expect(pushes).toEqual([]);
    expect(blocked).toEqual([]);
  });
});
