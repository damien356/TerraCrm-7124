import { createClient, type Client } from "@libsql/client";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { SQL } from "bun";
import { backupValue, credentialName, scrubBackupText } from "./backup-redaction";

/* ---------------------------------------------------------------------------
 * Off-site backup to Supabase (Damien, 5 Oct 2026).
 *
 * Supabase is a COPY. The live app keeps running on Turso and Tigris. Every
 * run sends three things to the Supabase project:
 *
 *   1. A restorable SQLite file of the whole Terra Ops database, gzipped, to
 *      Storage bucket "terra-backup" under database/. Same tables, indexes
 *      and rows as live, so it can be loaded straight back into Turso.
 *   2. The same data as browsable Postgres tables in schema "terra_backup",
 *      rebuilt each run. That schema is not exposed to the Supabase API, so
 *      the public anon key cannot read it.
 *   3. Every photo, video, PDF and recording in the Tigris bucket, copied to
 *      app-files/<same key>. New and changed files only. Nothing is ever
 *      deleted from the copy, so a file removed on live is still here.
 *
 * Damien's rule: passwords, API keys and access tokens never leave. Login
 * sessions and verification codes are skipped, and the credential columns
 * below are blanked. A restore therefore needs people to reset passwords and
 * reconnect Gmail, which is the point.
 *
 * Self-contained on purpose (own Turso and S3 clients), so the sandbox
 * script can run it without the demo routing or the dev server.
 * ------------------------------------------------------------------------- */

export const BUCKET = "terra-backup";

/** Tables that are nothing but credentials. Not copied at all. */
const SKIP_TABLES = new Set(["session", "verification"]);

/** Credential columns, blanked in both copies. Rows are kept so a restore still knows who is who. */
const REDACT: Record<string, string[]> = {
  account: ["access_token", "refresh_token", "id_token", "password"],
  mail_accounts: ["refresh_token_sealed"],
  voice_keys: ["key_hash"],
  voice_actions: ["token_hash"],
  device_tokens: ["token"],
  unsubscribes: ["token"],
};

/** Retention: every run for 7 days, then one a day for 90 days. */
const KEEP_ALL_DAYS = 7;
const KEEP_DAILY_DAYS = 90;

type Log = (line: string) => void;
type Row = Record<string, unknown>;

export function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/* ----------------------------- Supabase Storage ---------------------------- */

function sbUrl(path: string) {
  return `${process.env.SUPABASE_URL!.replace(/\/+$/, "")}/storage/v1/${path}`;
}

function sbHeaders(extra: Record<string, string> = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return { Authorization: `Bearer ${k}`, apikey: k, ...extra };
}

function objPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export async function ensureBucket() {
  const r = await fetch(sbUrl(`bucket/${BUCKET}`), { headers: sbHeaders() });
  if (r.ok) return;
  const c = await fetch(sbUrl("bucket"), {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }),
  });
  if (!c.ok && c.status !== 409) throw new Error(`Could not create bucket: ${c.status} ${await c.text()}`);
}

export async function sbPut(key: string, body: Uint8Array | string, contentType = "application/octet-stream") {
  const r = await fetch(sbUrl(`object/${BUCKET}/${objPath(key)}`), {
    method: "POST",
    headers: sbHeaders({ "Content-Type": contentType, "x-upsert": "true", "cache-control": "no-cache" }),
    body: typeof body === "string" ? body : new Uint8Array(body).buffer,
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
}

export async function sbGetJson<T>(key: string): Promise<T | null> {
  const r = await fetch(sbUrl(`object/authenticated/${BUCKET}/${objPath(key)}`), { headers: sbHeaders() });
  if (r.status === 400 || r.status === 404) return null;
  if (!r.ok) throw new Error(`Read ${key}: ${r.status}`);
  return (await r.json()) as T;
}

async function sbList(prefix: string) {
  const out: { name: string; id: string | null }[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(sbUrl(`object/list/${BUCKET}`), {
      method: "POST",
      headers: sbHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!r.ok) throw new Error(`List ${prefix}: ${r.status}`);
    const page = (await r.json()) as { name: string; id: string | null }[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

async function sbDelete(keys: string[]) {
  if (!keys.length) return;
  const r = await fetch(sbUrl(`object/${BUCKET}`), {
    method: "DELETE",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ prefixes: keys }),
  });
  if (!r.ok) throw new Error(`Delete: ${r.status}`);
}

/* -------------------------------- Postgres -------------------------------- */

/**
 * The project's direct host is IPv6 only, so connect through the Sydney
 * session pooler. Password is base64 in .env because it contains "$", which
 * the env loader would otherwise expand.
 */
export function supabasePg() {
  const b64 = process.env.SUPABASE_DB_PASSWORD_B64;
  if (!b64) return null;
  const ref = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
  // Bun global, not an import: the dev preview runs under Node and cannot load "bun".
  const BunRt = (globalThis as { Bun?: typeof import("bun") }).Bun;
  if (!BunRt) throw new Error("The off-site backup needs the Bun runtime.");
  return new BunRt.SQL({
    adapter: "postgres",
    hostname: process.env.SUPABASE_POOLER_HOST ?? "aws-0-ap-southeast-2.pooler.supabase.com",
    port: 5432,
    username: `postgres.${ref}`,
    password: Buffer.from(b64, "base64").toString("utf8"),
    database: "postgres",
    tls: true,
    max: 2,
    connectionTimeout: 20,
  });
}

const qi = (s: string) => `"${s.split('"').join('""')}"`;

function pgType(values: unknown[]) {
  let sawNum = false;
  let allInt = true;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number" || typeof v === "bigint") {
      sawNum = true;
      if (typeof v === "number" && !Number.isInteger(v)) allInt = false;
    } else return "text";
  }
  if (!sawNum) return "text";
  return allInt ? "bigint" : "double precision";
}

function pgValue(v: unknown) {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString("base64");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  if (typeof v === "bigint") return v.toString();
  return v ?? null;
}

async function loadPostgres(pg: SQL, tables: { name: string; columns: string[]; rows: Row[] }[], log: Log) {
  const tmp = "terra_backup_new";
  await pg.begin(async (tx) => {
    await tx.unsafe("select pg_advisory_xact_lock(4207211)");
    await tx.unsafe(`drop schema if exists ${tmp} cascade`);
    await tx.unsafe(`create schema ${tmp}`);
    for (const t of tables) {
      const types = t.columns.map((c) => pgType(t.rows.map((r) => r[c])));
      await tx.unsafe(
        `create table ${tmp}.${qi(t.name)} (${t.columns.map((c, i) => `${qi(c)} ${types[i]}`).join(", ")})`,
      );
      const per = Math.max(1, Math.floor(30000 / Math.max(1, t.columns.length)));
      for (let i = 0; i < t.rows.length; i += per) {
        const chunk = t.rows.slice(i, i + per);
        const params: unknown[] = [];
        const tuples = chunk.map((r) => {
          const ph = t.columns.map((c) => {
            params.push(pgValue(r[c]));
            return `$${params.length}`;
          });
          return `(${ph.join(",")})`;
        });
        await tx.unsafe(
          `insert into ${tmp}.${qi(t.name)} (${t.columns.map(qi).join(",")}) values ${tuples.join(",")}`,
          params as never[],
        );
      }
    }
    await tx.unsafe(
      `create table ${tmp}._backup_info as select now() as taken_at, 'Copy of Terra Ops. Rebuilt every run. Edits here are overwritten.'::text as note`,
    );
    await tx.unsafe("drop schema if exists terra_backup cascade");
    await tx.unsafe(`alter schema ${tmp} rename to terra_backup`);
    // Not exposed to the Supabase REST API, and the anon/authenticated roles get nothing.
    await tx.unsafe("revoke all on schema terra_backup from public, anon, authenticated");
    await tx.unsafe("revoke all on all tables in schema terra_backup from public, anon, authenticated");
    for (const t of tables) await tx.unsafe(`alter table terra_backup.${qi(t.name)} enable row level security`);
  });
  log(`postgres: ${tables.length} tables in schema terra_backup`);
}

/* -------------------------------- Database -------------------------------- */

const BUN_SQLITE = ["bun", "sqlite"].join(":");

function turso(): Client {
  return createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
}

async function readLive(log: Log) {
  const c = turso();
  const tx = await c.transaction("read");
  try {
    const master = await tx.execute(
      "select type, name, tbl_name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and name not like '_litestream%' and tbl_name not like '_litestream%' order by case type when 'table' then 0 else 1 end, name",
    );
    const tables: { name: string; createSql: string; columns: string[]; rows: Row[] }[] = [];
    const indexes: string[] = [];
    const skipped: string[] = [];
    for (const m of master.rows) {
      const name = String(m.name);
      const tbl = String(m.tbl_name);
      if (SKIP_TABLES.has(tbl)) {
        if (m.type === "table") {
          skipped.push(name);
          const res = await tx.execute(`select * from ${qi(name)} limit 0`);
          tables.push({ name, createSql: String(m.sql), columns: res.columns, rows: [] });
        } else indexes.push(String(m.sql));
        continue;
      }
      if (m.type !== "table") {
        indexes.push(String(m.sql));
        continue;
      }
      const res = await tx.execute(`select * from ${qi(name)}`);
      const rows = res.rows.map((r) => {
        const o: Row = {};
        for (const col of res.columns) o[col] = backupValue(name, col, r);
        return o;
      });
      tables.push({ name, createSql: String(m.sql), columns: res.columns, rows });
    }
    await tx.commit();
    log(`read live: ${tables.length} tables, ${tables.reduce((n, t) => n + t.rows.length, 0)} rows, omitted credential rows in ${skipped.join(", ") || "none"}`);
    return { tables, indexes, skipped };
  } finally {
    tx.close();
    c.close();
  }
}

/** Build a real SQLite file. Credential columns that are NOT NULL get "" instead of null. */
async function buildSqlite(data: Awaited<ReturnType<typeof readLive>>) {
  // Loaded only when a backup runs. The dev preview runs under Node, which cannot load "bun:" modules.
  const { Database } = (await import(/* @vite-ignore */ BUN_SQLITE)) as typeof import("bun:sqlite");
  const file = new Database(":memory:");
  file.exec("PRAGMA foreign_keys=OFF");
  for (const t of data.tables) file.exec(t.createSql);
  for (const t of data.tables) {
    if (!t.rows.length) continue;
    const notNull = new Set(
      (file.query(`pragma table_info(${qi(t.name)})`).all() as { name: string; notnull: number }[])
        .filter((c) => c.notnull)
        .map((c) => c.name),
    );
    const ins = file.prepare(
      `insert into ${qi(t.name)} (${t.columns.map(qi).join(",")}) values (${t.columns.map(() => "?").join(",")})`,
    );
    file.transaction(() => {
      for (const r of t.rows) {
        ins.run(
          ...(t.columns.map((c) => {
            const v = r[c];
            if (credentialName.test(c)) return notNull.has(c) ? `RESET-REQUIRED-${String(r.id ?? "")}` : null;
            if (v instanceof ArrayBuffer) return new Uint8Array(v);
            return v as string | number | null;
          }) as never[]),
        );
      }
    })();
  }
  for (const ix of data.indexes) file.exec(ix);
  const ok = (file.query("pragma integrity_check").get() as { integrity_check: string }).integrity_check;
  if (ok !== "ok") throw new Error(`Backup file failed integrity check: ${ok}`);
  const bytes = file.serialize();
  file.close();
  return bytes;
}

/* --------------------------------- Files ---------------------------------- */

type Manifest = Record<string, { size: number; etag?: string; at: string }>;
const MEDIA_MANIFEST = "app-files/_manifest.json";
/** Supabase free plan rejects single files over 50 MB. Raise this if the plan allows more. */
const MAX_FILE_BYTES = Number(process.env.SUPABASE_MAX_FILE_MB ?? 50) * 1024 * 1024;

async function backupMedia(log: Log) {
  const s3 = new S3Client({
    region: "auto",
    endpoint: process.env.S3_ENDPOINT,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
  });
  const bucket = process.env.S3_BUCKET!;
  const manifest = (await sbGetJson<Manifest>(MEDIA_MANIFEST)) ?? {};
  let token: string | undefined;
  let seen = 0;
  let copied = 0;
  const tooBig: string[] = [];
  const failed: string[] = [];
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      if (!o.Key) continue;
      seen++;
      const prev = manifest[o.Key];
      if (prev && prev.size === o.Size && prev.etag === o.ETag) continue;
      if ((o.Size ?? 0) > MAX_FILE_BYTES) {
        tooBig.push(o.Key);
        continue;
      }
      try {
        const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: o.Key }));
        const body = await got.Body!.transformToByteArray();
        await sbPut(`app-files/${o.Key}`, body, got.ContentType ?? "application/octet-stream");
        manifest[o.Key] = { size: o.Size ?? body.length, etag: o.ETag, at: new Date().toISOString() };
        copied++;
        if (copied % 25 === 0) await sbPut(MEDIA_MANIFEST, JSON.stringify(manifest), "application/json");
      } catch (e) {
        failed.push(`${o.Key}: ${(e as Error).message}`);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await sbPut(MEDIA_MANIFEST, JSON.stringify(manifest), "application/json");
  log(`files: ${seen} on live, ${copied} new or changed copied, ${tooBig.length} too big, ${failed.length} failed`);
  return { seen, copied, tooBig, failed };
}

/* -------------------------------- Retention ------------------------------- */

async function prune(log: Log) {
  const days = (await sbList("database/")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name);
  const now = Date.now();
  const remove: string[] = [];
  for (const day of days) {
    const age = (now - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
    const files = (await sbList(`database/${day}/`)).filter((f) => f.id).map((f) => f.name).sort();
    if (age > KEEP_DAILY_DAYS) remove.push(...files.map((f) => `database/${day}/${f}`));
    else if (age > KEEP_ALL_DAYS) {
      const dbs = files.filter((f) => f.endsWith(".sqlite.gz"));
      const keep = dbs[dbs.length - 1];
      remove.push(
        ...files
          .filter((f) => f !== keep && f !== keep?.replace(".sqlite.gz", ".json"))
          .map((f) => `database/${day}/${f}`),
      );
    }
  }
  await sbDelete(remove);
  if (remove.length) log(`retention: removed ${remove.length} old copies`);
}

/* ---------------------------------- Run ----------------------------------- */

export type BackupInfo = {
  takenAt: string;
  file: string;
  tables: number;
  rows: number;
  counts: Record<string, number>;
  skippedTables: string[];
  redacted: Record<string, string[]>;
  postgres: "ok" | "skipped" | string;
  media?: { seen: number; copied: number; tooBig: string[]; failed: string[] };
  source: string;
};

/** One full off-site backup run. Throws only if the restorable database copy fails. */
export async function runOffsiteBackup(opts: { source: string; log?: Log; media?: boolean }) {
  const log = opts.log ?? ((l: string) => console.log(`[offsite-backup] ${l}`));
  await ensureBucket();
  const data = await readLive(log);
  const bytes = await buildSqlite(data);
  const gz = Bun.gzipSync(new Uint8Array(bytes));
  const takenAt = new Date().toISOString();
  const day = takenAt.slice(0, 10);
  const stamp = takenAt.slice(11, 23).split(":").join("").replace(".", "");
  const file = `database/${day}/${stamp}-utc.sqlite.gz`;
  await sbPut(file, gz, "application/gzip");
  await sbPut("database/latest.sqlite.gz", gz, "application/gzip");
  log(`database file: ${(bytes.length / 1e6).toFixed(1)} MB, ${(gz.length / 1e6).toFixed(1)} MB gzipped, ${file}`);

  let postgres = "skipped";
  const pg = supabasePg();
  if (pg) {
    try {
      await loadPostgres(pg, data.tables, log);
      postgres = "ok";
    } catch (e) {
      postgres = `failed: ${scrubBackupText((e as Error).message)}`;
      log(`postgres ${postgres}`);
    } finally {
      await pg.close();
    }
  }

  const media = opts.media === false ? undefined : await backupMedia(log);
  const counts = Object.fromEntries(data.tables.map((t) => [t.name, t.rows.length]));
  const info: BackupInfo = {
    takenAt,
    file,
    tables: data.tables.length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    skippedTables: data.skipped,
    redacted: REDACT,
    postgres,
    media,
    source: opts.source,
  };
  await sbPut(file.replace(".sqlite.gz", ".json"), JSON.stringify(info, null, 2), "application/json");
  await sbPut("database/latest.json", JSON.stringify(info, null, 2), "application/json");
  // Retention is opt-in. Never delete older backups without Damien's approval.
  if (process.env.SUPABASE_BACKUP_PRUNE === "on") {
    await prune(log).catch((e) => log(`retention skipped: ${scrubBackupText((e as Error).message)}`));
  }
  return info;
}
