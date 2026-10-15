import { createClient, type Client } from "@libsql/client";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { SQL } from "bun";
import { createHash } from "node:crypto";
import { backupValue, credentialName, scrubBackupText } from "./backup-redaction";

/* ---------------------------------------------------------------------------
 * Off-site backup to Supabase (Damien, 5 Oct 2026).
 *
 * Supabase is a COPY. The live app keeps running on Turso and Tigris. Every
 * run sends three things to the Supabase project:
 *
 *   1. A restorable SQLite file of the whole Terra Ops database, gzipped, to
 *      Storage bucket "terra-backup" under database/. Same tables, indexes
 *      and rows as live, so it can be loaded straight back into Turso. Not
 *      uploaded again when nothing changed since the last run.
 *   2. The same data as browsable Postgres tables in schema "terra_backup".
 *      Only new, changed and removed rows are sent (see syncPostgres). That
 *      schema is not exposed to the Supabase API, so the public anon key
 *      cannot read it.
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

type LiveTable = { name: string; createSql: string; columns: string[]; rows: Row[]; pk: string | null };
type PgTypeName = "bigint" | "double precision" | "text";
const TYPE_RANK: Record<string, number> = { bigint: 0, "double precision": 1, text: 2 };

/** Tables the sync keeps for itself. Never a copy of a live table. */
const SYNC_TABLES = "_sync_tables";
const SYNC_ROWS = "_sync_rows";
const INFO_TABLE = "_backup_info";
const OWN_TABLES = new Set([SYNC_TABLES, SYNC_ROWS, INFO_TABLE]);
/**
 * Rows per statement. Same statement text every time, so Postgres keeps one
 * stats entry per table. Under 1 MB a batch, so the Nano plan's 2 MB work_mem
 * holds it without spilling to temp files on disk.
 */
const BATCH_ROWS = 500;
const BATCH_BYTES = 1_000_000;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Row id as text, the same way on both sides. */
const idText = (v: unknown) => String(pgValue(v));

/** Fingerprints used to send only what changed. Cheap: computed from the live read, no Supabase reads. */
export function fingerprintTable(t: LiveTable) {
  const rowHash = new Map<string, string>();
  let pk = t.pk;
  const all: string[] = [];
  for (const r of t.rows) {
    const h = sha1(JSON.stringify(t.columns.map((c) => pgValue(r[c]))));
    all.push(h);
    if (!pk) continue;
    const v = r[pk];
    const id = v === null || v === undefined ? null : idText(v);
    if (id === null || rowHash.has(id)) pk = null;
    else rowHash.set(id, h);
  }
  const body = pk ? [...rowHash].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e.join(":")) : all;
  const hash = sha1(JSON.stringify({ columns: t.columns, pk, rows: body }));
  return { pk, hash, rowHash };
}

function batches<T>(items: T[], size: (x: T) => number) {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const n = size(it);
    if (cur.length && (cur.length >= BATCH_ROWS || bytes + n > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type SyncResult = { changedTables: string[]; rebuilt: string[]; upserted: number; deleted: number; dropped: string[] };

/**
 * Keeps schema terra_backup in step with live, sending only new, changed and
 * removed rows (Damien, 15 Oct 2026). The old way dropped and rebuilt every
 * table every 6 hours, which spent the Supabase Nano disk budget and filled
 * the query stats with thousands of giant one-off insert statements.
 *
 * Each table has a primary key, and _sync_rows holds a fingerprint of every
 * row, so a run that finds nothing changed only reads _sync_tables (one row
 * per table). A table is rebuilt on its own when it is new, lost its key, or
 * its row count does not match live after the update. Column types only
 * widen (whole number, then decimal, then text), so nothing fails to fit.
 * One transaction: a failed run leaves the previous copy as it was.
 */
export async function syncPostgres(pg: SQL, tables: LiveTable[], log: Log, opts: { schema?: string; full?: boolean } = {}) {
  const S = qi(opts.schema ?? "terra_backup");
  const schemaName = opts.schema ?? "terra_backup";
  const res: SyncResult = { changedTables: [], rebuilt: [], upserted: 0, deleted: 0, dropped: [] };
  await pg.begin(async (tx) => {
    await tx.unsafe("set local statement_timeout = '10min'");
    await tx.unsafe("select pg_advisory_xact_lock(4207211)");
    const created: string[] = [];
    const ns = await tx.unsafe("select 1 from pg_namespace where nspname = $1", [schemaName]);
    if (!ns.length) await tx.unsafe(`create schema ${S}`);
    const have = new Map<string, Map<string, string>>();
    for (const r of (await tx.unsafe(
      `select c.relname t, a.attname col, format_type(a.atttypid, a.atttypmod) typ
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped`,
      [schemaName],
    )) as { t: string; col: string; typ: string }[]) {
      if (!have.has(r.t)) have.set(r.t, new Map());
      have.get(r.t)!.set(r.col, r.typ);
    }
    const keys = new Map<string, string>();
    for (const r of (await tx.unsafe(
      `select c.relname t, string_agg(a.attname, ',') cols
         from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
        where n.nspname = $1 and i.indisprimary group by c.relname`,
      [schemaName],
    )) as { t: string; cols: string }[])
      keys.set(r.t, r.cols);

    if (!have.has(SYNC_TABLES) || keys.get(SYNC_TABLES) !== "tbl") {
      await tx.unsafe(`drop table if exists ${S}.${SYNC_TABLES}`);
      await tx.unsafe(
        `create table ${S}.${SYNC_TABLES} (tbl text primary key, hash text not null, pk text, row_count integer not null, synced_at timestamptz not null default now())`,
      );
      created.push(SYNC_TABLES);
    }
    if (!have.has(SYNC_ROWS) || !keys.has(SYNC_ROWS)) {
      await tx.unsafe(`drop table if exists ${S}.${SYNC_ROWS}`);
      await tx.unsafe(`create table ${S}.${SYNC_ROWS} (tbl text not null, id text not null, hash text not null, primary key (tbl, id))`);
      created.push(SYNC_ROWS);
    }
    if (!have.has(INFO_TABLE)) {
      await tx.unsafe(`create table ${S}.${INFO_TABLE} (taken_at timestamptz, note text)`);
      created.push(INFO_TABLE);
    }
    const stored = new Map<string, { hash: string; pk: string | null }>();
    for (const r of (await tx.unsafe(`select tbl, hash, pk from ${S}.${SYNC_TABLES}`)) as { tbl: string; hash: string; pk: string | null }[])
      stored.set(r.tbl, { hash: r.hash, pk: r.pk });

    const upsertSql = (t: LiveTable, pk: string | null) => {
      const cols = t.columns.map(qi).join(",");
      const base = `insert into ${S}.${qi(t.name)} (${cols}) select ${cols} from jsonb_populate_recordset(null::${S}.${qi(t.name)}, $1::text::jsonb)`;
      if (!pk) return base;
      const rest = t.columns.filter((c) => c !== pk);
      return rest.length
        ? `${base} on conflict (${qi(pk)}) do update set ${rest.map((c) => `${qi(c)} = excluded.${qi(c)}`).join(", ")}`
        : `${base} on conflict (${qi(pk)}) do nothing`;
    };
    const sendRows = async (t: LiveTable, pk: string | null, rows: Row[]) => {
      const sql = upsertSql(t, pk);
      const json = rows.map((r) => {
        const o: Row = {};
        for (const c of t.columns) o[c] = pgValue(r[c]);
        return JSON.stringify(o);
      });
      for (const b of batches(json, (s) => s.length)) await tx.unsafe(sql, [`[${b.join(",")}]`]);
      res.upserted += rows.length;
    };
    const putHashes = async (tbl: string, entries: [string, string][]) => {
      for (const b of batches(entries, (e) => e[0].length + 48))
        await tx.unsafe(
          `insert into ${S}.${SYNC_ROWS} (tbl, id, hash) select $1, x->>0, x->>1 from jsonb_array_elements($2::text::jsonb) x
           on conflict (tbl, id) do update set hash = excluded.hash`,
          [tbl, JSON.stringify(b)],
        );
    };
    const delHashes = async (tbl: string, ids: string[]) => {
      for (const b of batches(ids, (s) => s.length + 4))
        await tx.unsafe(`delete from ${S}.${SYNC_ROWS} where tbl = $1 and id in (select jsonb_array_elements_text($2::text::jsonb))`, [tbl, JSON.stringify(b)]);
    };
    const markTable = (tbl: string, hash: string, pk: string | null, n: number) =>
      tx.unsafe(
        `insert into ${S}.${SYNC_TABLES} (tbl, hash, pk, row_count, synced_at) values ($1, $2, $3, $4, now())
         on conflict (tbl) do update set hash = excluded.hash, pk = excluded.pk, row_count = excluded.row_count, synced_at = now()`,
        [tbl, hash, pk, n],
      );

    const rebuild = async (t: LiveTable, fp: ReturnType<typeof fingerprintTable>, types: PgTypeName[]) => {
      await tx.unsafe(`drop table if exists ${S}.${qi(t.name)}`);
      const colDefs = t.columns.map((c, i) => `${qi(c)} ${types[i]}`);
      if (fp.pk) colDefs.push(`primary key (${qi(fp.pk)})`);
      await tx.unsafe(`create table ${S}.${qi(t.name)} (${colDefs.join(", ")})`);
      created.push(t.name);
      await sendRows(t, fp.pk, t.rows);
      await tx.unsafe(`delete from ${S}.${SYNC_ROWS} where tbl = $1`, [t.name]);
      if (fp.pk) await putHashes(t.name, [...fp.rowHash]);
      res.rebuilt.push(t.name);
    };

    const live = new Set(tables.map((t) => t.name));
    for (const t of tables) {
      if (OWN_TABLES.has(t.name)) throw new Error(`Live table ${t.name} clashes with a backup bookkeeping table`);
      const fp = fingerprintTable(t);
      const want = t.columns.map((c) => pgType(t.rows.map((r) => r[c])) as PgTypeName);
      const cur = have.get(t.name);
      const prev = stored.get(t.name);
      const keyOk = fp.pk ? keys.get(t.name) === fp.pk : !keys.has(t.name);
      if (opts.full || !cur || !prev || prev.pk !== fp.pk || !keyOk || (fp.pk && cur.get(fp.pk) === undefined)) {
        await rebuild(t, fp, want);
        await markTable(t.name, fp.hash, fp.pk, t.rows.length);
        res.changedTables.push(t.name);
        continue;
      }
      // Columns: add new ones, drop removed ones, widen a type that no longer fits.
      let shapeChanged = false;
      for (const [i, c] of t.columns.entries()) {
        const typ = cur.get(c);
        if (typ === undefined) {
          await tx.unsafe(`alter table ${S}.${qi(t.name)} add column ${qi(c)} ${want[i]}`);
          shapeChanged = true;
        } else if ((TYPE_RANK[want[i]] ?? 2) > (TYPE_RANK[typ] ?? 2)) {
          await tx.unsafe(`alter table ${S}.${qi(t.name)} alter column ${qi(c)} type ${want[i]} using ${qi(c)}::${want[i]}`);
          shapeChanged = true;
        }
      }
      for (const c of cur.keys()) {
        if (t.columns.includes(c)) continue;
        await tx.unsafe(`alter table ${S}.${qi(t.name)} drop column ${qi(c)}`);
        shapeChanged = true;
      }
      if (!shapeChanged && prev.hash === fp.hash) continue;
      res.changedTables.push(t.name);
      if (!fp.pk) {
        await tx.unsafe(`delete from ${S}.${qi(t.name)}`);
        await sendRows(t, null, t.rows);
        await markTable(t.name, fp.hash, null, t.rows.length);
        continue;
      }
      const old = new Map<string, string>();
      for (const r of (await tx.unsafe(`select id, hash from ${S}.${SYNC_ROWS} where tbl = $1`, [t.name])) as { id: string; hash: string }[])
        old.set(r.id, r.hash);
      const changed: Row[] = [];
      const changedHashes: [string, string][] = [];
      for (const r of t.rows) {
        const id = idText(r[fp.pk]);
        const h = fp.rowHash.get(id)!;
        // A renamed or added column changes every row, even when the values line up the same.
        if (!shapeChanged && old.get(id) === h) continue;
        changed.push(r);
        changedHashes.push([id, h]);
      }
      const gone = [...old.keys()].filter((id) => !fp.rowHash.has(id));
      const pkType = cur.get(fp.pk) ?? "text";
      if (changed.length) await sendRows(t, fp.pk, changed);
      for (const b of batches(gone, (s) => s.length + 4))
        await tx.unsafe(
          `delete from ${S}.${qi(t.name)} where ${qi(fp.pk)} in (select (jsonb_array_elements_text($1::text::jsonb))::${pkType})`,
          [JSON.stringify(b)],
        );
      res.deleted += gone.length;
      await putHashes(t.name, changedHashes);
      await delHashes(t.name, gone);
      const n = ((await tx.unsafe(`select count(*)::int n from ${S}.${qi(t.name)}`)) as { n: number }[])[0].n;
      if (n !== t.rows.length) {
        log(`postgres: ${t.name} had ${n} rows, live has ${t.rows.length}, rebuilding that table`);
        await rebuild(t, fp, want.map((w, i) => {
          const typ = cur.get(t.columns[i]);
          return (typ && (TYPE_RANK[typ] ?? 2) > TYPE_RANK[w] ? typ : w) as PgTypeName;
        }));
      }
      await markTable(t.name, fp.hash, fp.pk, t.rows.length);
    }
    // Tables removed from live.
    for (const name of have.keys()) {
      if (live.has(name) || OWN_TABLES.has(name)) continue;
      await tx.unsafe(`drop table ${S}.${qi(name)}`);
      res.dropped.push(name);
    }
    for (const name of stored.keys()) {
      if (live.has(name)) continue;
      await tx.unsafe(`delete from ${S}.${SYNC_TABLES} where tbl = $1`, [name]);
      await tx.unsafe(`delete from ${S}.${SYNC_ROWS} where tbl = $1`, [name]);
    }
    if (res.changedTables.length || res.dropped.length || created.length) {
      await tx.unsafe(`delete from ${S}.${INFO_TABLE}`);
      await tx.unsafe(
        `insert into ${S}.${INFO_TABLE} values (now(), 'Copy of Terra Ops, kept in step with live every run. Edits here are overwritten when the row changes on live.')`,
      );
    }
    if (created.length || !ns.length) {
      // Not exposed to the Supabase REST API, and the anon/authenticated roles get nothing.
      await tx.unsafe(`revoke all on schema ${S} from public, anon, authenticated`);
      await tx.unsafe(`revoke all on all tables in schema ${S} from public, anon, authenticated`);
      for (const name of new Set([...created, INFO_TABLE])) await tx.unsafe(`alter table ${S}.${qi(name)} enable row level security`);
    }
  });
  log(
    `postgres: ${tables.length} tables in schema ${schemaName}, ${res.changedTables.length} changed, ${res.rebuilt.length} rebuilt, ${res.upserted} rows sent, ${res.deleted} removed`,
  );
  return res;
}

/* -------------------------------- Database -------------------------------- */

const BUN_SQLITE = ["bun", "sqlite"].join(":");

function turso(): Client {
  return createClient({ url: process.env.DATABASE_URL!, authToken: process.env.DATABASE_AUTH_TOKEN });
}

export async function readLive(log: Log) {
  const c = turso();
  const tx = await c.transaction("read");
  try {
    const master = await tx.execute(
      "select type, name, tbl_name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and name not like '_litestream%' and tbl_name not like '_litestream%' order by case type when 'table' then 0 else 1 end, name",
    );
    const tables: LiveTable[] = [];
    // Primary key per table, so the Postgres copy can send only changed rows. Single-column keys only.
    const pkCols = new Map<string, string[]>();
    for (const r of (await tx.execute(
      "select m.name t, p.name c from sqlite_master m join pragma_table_info(m.name) p where m.type = 'table' and p.pk > 0 order by m.name, p.pk",
    )).rows) {
      const t = String(r.t);
      pkCols.set(t, [...(pkCols.get(t) ?? []), String(r.c)]);
    }
    const pkOf = (t: string) => (pkCols.get(t)?.length === 1 ? pkCols.get(t)![0] : null);
    const indexes: string[] = [];
    const skipped: string[] = [];
    for (const m of master.rows) {
      const name = String(m.name);
      const tbl = String(m.tbl_name);
      if (SKIP_TABLES.has(tbl)) {
        if (m.type === "table") {
          skipped.push(name);
          const res = await tx.execute(`select * from ${qi(name)} limit 0`);
          tables.push({ name, createSql: String(m.sql), columns: res.columns, rows: [], pk: pkOf(name) });
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
      tables.push({ name, createSql: String(m.sql), columns: res.columns, rows, pk: pkOf(name) });
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
/** Supabase's default global upload limit is 50 MB. Set SUPABASE_MAX_FILE_MB to match if it is raised in Storage settings. */
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
  // Only rewrite the manifest when something was copied. Each upload is a Storage database write.
  if (copied % 25 !== 0) await sbPut(MEDIA_MANIFEST, JSON.stringify(manifest), "application/json");
  log(`files: ${seen} on live, ${copied} new or changed copied, ${tooBig.length} too big, ${failed.length} failed`);
  return { seen, copied, tooBig, failed };
}

/* -------------------------------- Retention ------------------------------- */

async function prune(log: Log, keepFile?: string) {
  const days = (await sbList("database/")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name);
  const now = Date.now();
  let remove: string[] = [];
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
  // The copy latest.json points at stays, even when nothing has changed for weeks.
  const keep = keepFile ? [keepFile, keepFile.replace(".sqlite.gz", ".json")] : [];
  remove = remove.filter((k) => !keep.includes(k));
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
  /** When this run happened. takenAt is when the database file was made, which is older if nothing changed. */
  checkedAt?: string;
  /** Fingerprint of every table, index and row. Same as the last run means nothing changed. */
  dataHash?: string;
  /** True when live had not changed, so no new database file was uploaded. */
  unchanged?: boolean;
  sync?: SyncResult;
};

/**
 * One off-site backup run. Throws only if the restorable database copy fails.
 * When live has not changed since the last run, the database file is not
 * uploaded again and only latest.json is refreshed, so the 6 hour timer works.
 * SUPABASE_BACKUP_FULL=1 forces a new file and a rebuild of every Postgres table.
 */
export async function runOffsiteBackup(opts: { source: string; log?: Log; media?: boolean; full?: boolean }) {
  const log = opts.log ?? ((l: string) => console.log(`[offsite-backup] ${l}`));
  const full = opts.full ?? process.env.SUPABASE_BACKUP_FULL === "1";
  await ensureBucket();
  const data = await readLive(log);
  const checkedAt = new Date().toISOString();
  const dataHash = sha1(
    JSON.stringify({
      schema: data.tables.map((t) => t.createSql),
      indexes: data.indexes,
      tables: data.tables.map((t) => [t.name, fingerprintTable(t).hash]),
    }),
  );
  const last = await sbGetJson<BackupInfo>("database/latest.json").catch(() => null);
  const unchanged = !full && last?.dataHash === dataHash && Boolean(last.file);
  let file: string;
  let takenAt: string;
  if (unchanged) {
    file = last!.file;
    takenAt = last!.takenAt;
    log(`database file: live unchanged since ${takenAt}, keeping ${file}`);
  } else {
    const bytes = await buildSqlite(data);
    const gz = Bun.gzipSync(new Uint8Array(bytes));
    takenAt = checkedAt;
    const day = takenAt.slice(0, 10);
    const stamp = takenAt.slice(11, 23).split(":").join("").replace(".", "");
    file = `database/${day}/${stamp}-utc.sqlite.gz`;
    await sbPut(file, gz, "application/gzip");
    await sbPut("database/latest.sqlite.gz", gz, "application/gzip");
    log(`database file: ${(bytes.length / 1e6).toFixed(1)} MB, ${(gz.length / 1e6).toFixed(1)} MB gzipped, ${file}`);
  }

  let postgres = "skipped";
  let sync: SyncResult | undefined;
  const pg = supabasePg();
  if (pg) {
    try {
      sync = await syncPostgres(pg, data.tables, log, { full });
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
    checkedAt,
    dataHash,
    unchanged,
    sync,
  };
  if (!unchanged) await sbPut(file.replace(".sqlite.gz", ".json"), JSON.stringify(info, null, 2), "application/json");
  await sbPut("database/latest.json", JSON.stringify(info, null, 2), "application/json");
  // Retention is opt-in. Never delete older backups without Damien's approval.
  if (process.env.SUPABASE_BACKUP_PRUNE === "on") {
    await prune(log, file).catch((e) => log(`retention skipped: ${scrubBackupText((e as Error).message)}`));
  }
  return info;
}
