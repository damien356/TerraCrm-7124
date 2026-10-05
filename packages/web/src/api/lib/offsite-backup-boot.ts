import { runOffsiteBackup, sbGetJson, supabaseConfigured, type BackupInfo } from "./offsite-backup";

/* ---------------------------------------------------------------------------
 * Runs the Supabase off-site backup every 6 hours inside the published
 * server, so the copy keeps going even if the sandbox is lost. Same gate as
 * the journey engine: only when the entry script is __server.ts.
 *
 *   OFFSITE_BACKUP=off   never run
 *   OFFSITE_BACKUP=on    run regardless of the entry script
 *
 * A restart does not trigger an extra run: it reads when the last copy was
 * taken (by this server or the sandbox job) and waits until 6 hours have gone.
 * ------------------------------------------------------------------------- */

const EVERY_MS = 6 * 60 * 60 * 1000;
const CHECK_MS = 15 * 60 * 1000;

function isPublishedServer() {
  const argv = (process as unknown as { argv?: string[] }).argv ?? [];
  return (argv[1] ?? "").endsWith("__server.ts");
}

let booted = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const last = await sbGetJson<BackupInfo>("database/latest.json").catch(() => null);
    const age = last ? Date.now() - Date.parse(last.takenAt) : Infinity;
    if (age < EVERY_MS - CHECK_MS) return;
    const info = await runOffsiteBackup({ source: "published-server" });
    console.log(`[offsite-backup] done, ${info.tables} tables, ${info.rows} rows, postgres ${info.postgres}`);
  } catch (e) {
    console.error("[offsite-backup] failed", e);
  } finally {
    running = false;
  }
}

export function bootOffsiteBackup() {
  if (booted) return;
  booted = true;
  const mode = process.env.OFFSITE_BACKUP;
  if (mode === "off") return void console.log("[offsite-backup] disabled by OFFSITE_BACKUP=off");
  if (!supabaseConfigured()) return void console.log("[offsite-backup] idle, Supabase is not set up");
  if (mode !== "on" && !isPublishedServer()) return void console.log("[offsite-backup] idle, not the published server");
  console.log("[offsite-backup] copying to Supabase every 6 hours");
  setTimeout(() => void tick(), 5 * 60 * 1000);
  setInterval(() => void tick(), CHECK_MS);
}
