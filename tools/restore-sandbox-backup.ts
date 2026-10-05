/** Restore into a NEW, EMPTY directory, never overwrite a working app. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, sep, dirname } from "node:path";
import { createHash } from "node:crypto";
import { sbGetJson } from "../packages/web/src/api/lib/offsite-backup";

const target = process.argv[2];
if (!target) throw new Error('Use bun --env-file=.env tools/restore-sandbox-backup.ts /absolute/empty/directory [manifest-key]');
const dest = resolve(target);
if (existsSync(dest) && readdirSync(dest).length) throw new Error('Restore destination must be empty. Nothing was overwritten.');
const key = process.argv[3] ?? 'sandbox/latest.json';
const manifest = await sbGetJson<{files: Record<string, {object: string; sha256: string; bytes: number}>; failed: unknown[]}>(key);
if (!manifest || manifest.failed.length) throw new Error('No complete sandbox manifest at that key');
mkdirSync(dest, {recursive: true});
let count = 0;
const queue = Object.entries(manifest.files);
await Promise.all(Array.from({length: 4}, async () => {
  while (queue.length) {
    const [name, f] = queue.shift()!;
    const path = resolve(dest, name);
    if (!path.startsWith(dest + sep)) throw new Error('Unsafe relative path in manifest');
    const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/terra-backup/${f.object}`, {
      headers: {Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!},
    });
    if (!r.ok) throw new Error(`Download failed for ${name}, HTTP ${r.status}`);
    const raw = Bun.gunzipSync(new Uint8Array(await r.arrayBuffer()));
    if (raw.length !== f.bytes || createHash('sha256').update(raw).digest('hex') !== f.sha256) throw new Error(`Checksum mismatch for ${name}`);
    mkdirSync(dirname(path), {recursive:true});
    writeFileSync(path, raw);
    count++;
    if (count % 100 === 0) console.log(`Restored and verified ${count} files`);
  }
}));
console.log(`Restored ${count} files into ${dest}. Credentials and reinstallable dependencies are intentionally absent.`);