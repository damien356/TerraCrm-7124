/** Run from the app root: bun --env-file=.env tools/supabase-backup.ts */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runOffsiteBackup, ensureBucket, sbPut, sbGetJson } from "../packages/web/src/api/lib/offsite-backup";

type FileEntry = { path: string; bytes: number; sha256: string };
type Inventory = { included: FileEntry[]; excluded: unknown[]; failed: unknown[]; totalBytes: number; redactedFiles: number };
type SandboxManifest = { takenAt: string; files: Record<string, FileEntry & { object: string }>; excluded: unknown[]; failed: unknown[] };

// Two simultaneous runs must not race on the latest pointers in this sandbox.
const lock = "/tmp/terra-offsite-backup.lock";
let lockFd: number;
const fs = await import("node:fs");
try { lockFd = fs.openSync(lock, "wx"); fs.writeSync(lockFd, String(process.pid)); }
catch {
  const pid = Number(fs.readFileSync(lock, "utf8"));
  try { process.kill(pid, 0); throw new Error("A sandbox backup is already running"); }
  catch (e: any) { if (e.code !== "ESRCH") throw e; }
  fs.unlinkSync(lock);
  lockFd = fs.openSync(lock, "wx"); fs.writeSync(lockFd, String(process.pid));
}
const stage = mkdtempSync(join(tmpdir(), "terra-offsite-stage-"));
try {
  const info = await runOffsiteBackup({ source: "sandbox" });
  if (info.postgres !== "ok" || info.media?.failed.length || info.media?.tooBig.length) {
    throw new Error("Database copy exists, but browsable tables or media are incomplete. Check database/latest.json in Supabase.");
  }
  const child = Bun.spawn(["python3", "tools/stage-sandbox-backup.py", stage], { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  const inv = JSON.parse(readFileSync(join(stage, "_inventory.json"), "utf8")) as Inventory;
  await ensureBucket();
  const old = await sbGetJson<SandboxManifest>("sandbox/latest.json");
  const files = { ...old?.files };
  // Include only today's files in the new manifest. Old snapshots still reference deleted files.
  const current: SandboxManifest["files"] = {};
  let uploaded = 0;
  const queue = [...inv.included];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const entry = queue.shift()!;
      if (files[entry.path]?.sha256 === entry.sha256) {
        current[entry.path] = files[entry.path]; continue;
      }
      const raw = readFileSync(join(stage, entry.path));
      // Object names never include credentials or private filenames. Hash verifies restore content.
      const object = `sandbox/objects/${entry.sha256}.gz`;
      const compressed = Bun.gzipSync(raw);
      if (compressed.length > 49 * 1024 * 1024) throw new Error(`File exceeds free-plan upload limit: ${entry.path}`);
      await sbPut(object, compressed, "application/gzip");
      // Full read-back for every new sandbox object, not just a successful HTTP response.
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/terra-backup/${object}`, {
        headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY! },
      });
      if (!r.ok) throw new Error(`Read-back failed: ${entry.path}`);
      const check = Bun.gunzipSync(new Uint8Array(await r.arrayBuffer()));
      if (createHash("sha256").update(check).digest("hex") !== entry.sha256) throw new Error(`Read-back checksum failed: ${entry.path}`);
      current[entry.path] = { ...entry, object };
      uploaded++;
      if (uploaded % 100 === 0) console.log(`[sandbox] ${uploaded} copied and verified`);
    }
  }));
  const manifest: SandboxManifest = { takenAt: new Date().toISOString(), files: current, excluded: inv.excluded, failed: inv.failed };
  const key = `sandbox/manifests/${manifest.takenAt.replaceAll(":", "-")}.json`;
  await sbPut(key, JSON.stringify(manifest, null, 2), "application/json");
  if (code === 0) await sbPut("sandbox/latest.json", JSON.stringify(manifest, null, 2), "application/json");
  else await sbPut("sandbox/latest-incomplete.json", JSON.stringify(manifest, null, 2), "application/json");
  console.log(JSON.stringify({ database: info, sandbox: { files: Object.keys(current).length, uploaded, bytes: inv.totalBytes, excluded: inv.excluded.length, failed: inv.failed, manifest: key } }, null, 2));
  if (code !== 0) throw new Error("Some sandbox files need review. See sandbox/latest-incomplete.json. No complete status was written.");
} finally {
  rmSync(stage, { recursive: true, force: true });
  fs.closeSync(lockFd);
  fs.unlinkSync(lock);
}