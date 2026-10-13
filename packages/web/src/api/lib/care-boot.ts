import { careSettings, careTick, scanCompleted } from "./care-engine";
import { isLiveServer } from "./runtime";

/* ---------------------------------------------------------------------------
 * Booting the care series engine (lib/care-engine.ts). Section 18.37.
 *
 * Same gate as the journey engine (lib/journey-boot.ts): the timer only runs
 * in the published server, never in the sandbox dev server, which points at
 * the live database and would email real customers.
 *
 *   CARE_ENGINE=off   never tick, even on the published server
 *   CARE_ENGINE=on    tick regardless (tests only)
 *
 * On top of that, Damien's switch on the Care page (settings care_engine_on)
 * is read every tick. It starts OFF, so nothing goes until he turns it on, and
 * turning it off stops the next tick with no restart.
 * ------------------------------------------------------------------------- */

const EVERY_MS = 10 * 60_000;

let booted = false;
let ticking = false;
let busy = false;
let last: { at: Date; scan: unknown; tick: unknown; error?: string } | null = null;

export const careTicking = () => ticking;
export const careLastRun = () => last;

/** One run: add newly completed jobs, then send what is due. Skipped when switched off. */
export async function careRunOnce(now = new Date()) {
  if (busy) return { skipped: "already running" as const };
  busy = true;
  try {
    const s = await careSettings();
    if (!s.on) return { skipped: "switched off" as const };
    const scan = await scanCompleted(now);
    const tick = await careTick(now, { pauseMs: 600 });
    last = { at: now, scan, tick };
    if (scan.looked || tick.sent || tick.resent || tick.failed) console.log("[care]", JSON.stringify({ scan, tick }));
    return { scan, tick };
  } catch (e) {
    const error = String((e as Error).message ?? e);
    last = { at: now, scan: null, tick: null, error };
    console.error("[care] run failed:", error);
    return { error };
  } finally {
    busy = false;
  }
}

export function bootCareEngine() {
  if (booted) return;
  booted = true;
  const mode = process.env.CARE_ENGINE;
  if (mode === "off") {
    console.log("[care] engine disabled by CARE_ENGINE=off");
    return;
  }
  if (mode !== "on" && !isLiveServer()) {
    console.log("[care] engine idle, not the published server, nothing will be sent");
    return;
  }
  ticking = true;
  setTimeout(() => void careRunOnce(), 60_000);
  setInterval(() => void careRunOnce(), EVERY_MS);
}
