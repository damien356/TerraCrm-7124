import { isLiveServer } from "../runtime";
import { sweepOnce } from "./webhook";

/* ---------------------------------------------------------------------------
 * The phone sweep.
 *
 * Once a minute on the live server: marks phone actions that never finished
 * as uncertain, closes off calls whose end-of-call report never came, and
 * sends reminders and escalations for follow-ups that are near or past due.
 *
 *   PHONE_SWEEP=off   never run
 *   PHONE_SWEEP=on    run outside the live server too (scratch tests only)
 * ------------------------------------------------------------------------- */

const EVERY_MS = 60 * 1000;

let booted = false;
let ticking = false;
let running = false;
/** For the deploy check: did this process start the phone sweep? */
export const phoneSweepTicking = () => ticking;

async function tick() {
  if (running) return;
  running = true;
  try {
    await sweepOnce(new Date());
  } catch (e) {
    console.error("[phone] sweep failed", e);
  } finally {
    running = false;
  }
}

export function bootPhoneSweep() {
  if (booted) return;
  booted = true;
  const mode = process.env.PHONE_SWEEP;
  if (mode === "off") return void console.log("[phone] sweep disabled by PHONE_SWEEP=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[phone] sweep idle, not the published server");
  ticking = true;
  console.log("[phone] checking calls and follow-ups every minute");
  setInterval(() => void tick(), EVERY_MS);
  setTimeout(() => void tick(), 30_000);
}
