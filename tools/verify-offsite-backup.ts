/** Checks downloaded backups, never writes to live. */
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sbGetJson, supabasePg, type BackupInfo } from "../packages/web/src/api/lib/offsite-backup";

async function download(key: string) {
  const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/terra-backup/${key.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! },
  });
  if (!r.ok) throw new Error(`Download ${key}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
let checks = 0;
function check(ok: boolean, message: string) { if (!ok) throw new Error(message); checks++; console.log(`PASS ${message}`); }
const dir = mkdtempSync(join(tmpdir(), 'terra-backup-verify-'));
try {
  const info = (await sbGetJson<BackupInfo>('database/latest.json'))!;
  check(Boolean(info), 'database manifest exists');
  const bytes = Bun.gunzipSync(await download(info.file));
  const path = join(dir, 'restored.db');
  writeFileSync(path, bytes);
  const db = new Database(path, { readonly: true });
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
  check((db.query('pragma integrity_check').get() as any).integrity_check === 'ok', 'downloaded SQLite integrity');
  for (const [t, n] of Object.entries(info.counts)) check((db.query(`select count(*) n from ${q(t)}`).get() as any).n === n, `${t}: restored row count ${n}`);
  check((db.query('select count(*) n from account where password is not null or access_token is not null or refresh_token is not null or id_token is not null').get() as any).n === 0, 'no login passwords or account tokens in restored DB');
  check((db.query('select count(*) n from session').get() as any).n === 0, 'no sessions in restored DB');
  check((db.query('select count(*) n from verification').get() as any).n === 0, 'no verification codes in restored DB');
  db.close();
  const pg = supabasePg()!;
  try {
    for (const [t, n] of Object.entries(info.counts)) {
      const r = await pg.unsafe(`select count(*)::int n from terra_backup.${q(t)}`);
      check(r[0].n === n, `${t}: Postgres row count ${n}`);
    }
    const access = await pg`select has_schema_privilege('anon','terra_backup','USAGE') a, has_schema_privilege('authenticated','terra_backup','USAGE') b`;
    check(!access[0].a && !access[0].b, 'anon and authenticated roles cannot access backup schema');
  } finally { await pg.close(); }
  const bucket = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket/terra-backup`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! } });
  check(bucket.ok, 'bucket metadata readable with service credentials');
  check((await bucket.json()).public === false, 'backup bucket is private');
  const s3 = new S3Client({ region: 'auto', endpoint: process.env.S3_ENDPOINT, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, ContinuationToken: token }));
    for (const o of page.Contents ?? []) {
      const got = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: o.Key }));
      const src = await got.Body!.transformToByteArray();
      const copy = await download(`app-files/${o.Key}`);
      check(createHash('sha256').update(src).digest('hex') === createHash('sha256').update(copy).digest('hex'), `media checksum: ${o.Key}`);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const manifest = await sbGetJson<{files: Record<string, {object: string; sha256: string; bytes: number}>; failed: unknown[]}>('sandbox/latest.json');
  if (manifest) {
    check(manifest.failed.length === 0, 'sandbox manifest has no failed files');
    // Representative restore checks. The uploader read back every object at first copy.
    for (const name of ['terra-ops/package.json', 'terra-ops/packages/web/src/api/index.ts', 'backups/terra-live-pre-swms-2026-10-05.db', 'Attachments/content_13fYMw.md']) {
      const f = manifest.files[name]; check(Boolean(f), `sandbox contains ${name}`);
      const restored = Bun.gunzipSync(await download(f.object));
      check(restored.length === f.bytes && createHash('sha256').update(restored).digest('hex') === f.sha256, `sandbox restore checksum: ${name}`);
    }
    check(!Object.keys(manifest.files).some(p => p.split('/').some(x => x.startsWith('.env') || x === '.secrets' || x === '.ssh')), 'no credential files in sandbox manifest');
  } else console.log('Sandbox copy still in progress, not verified yet.');
  console.log(`VERIFIED ${checks} checks`);
} finally { rmSync(dir, {recursive:true, force:true}); }