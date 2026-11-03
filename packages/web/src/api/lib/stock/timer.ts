import { isLiveServer } from "../runtime";
import { switches } from "./core";
import { recheckAll } from "./recheck";

/* ---------------------------------------------------------------------------
 * The stock check timer: once at start-up (after 20 s) and every 10 minutes.
 * Does nothing while S1 Stock register is off, so on live today it only
 * reads the switches.
 *
 *   STOCK_TIMER=off   never run
 *   STOCK_TIMER=on    run outside the live server too (test copy only)
 * ------------------------------------------------------------------------- */

const EVERY_MS = 10 * 60 * 1000;

let booted = false;
let ticking = false;
let running = false;
export const stockTimerTicking = () => ticking;

export async function stockTick() {
  if (running) return null;
  running = true;
  try {
    if ((await switches()).s1.state === "off") return null;
    const r = await recheckAll();
    const firmed = r.results.reduce((s, x) => s + x.firmed, 0);
    const failed = r.results.filter((x) => x.error).length;
    if (r.expired + r.warned + firmed + failed + r.resent > 0) {
      console.log(`[stock] check: ${firmed} firmed, ${r.expired} expired, ${r.warned} warned, ${r.resent} resent, ${failed} failed`);
    }
    return r;
  } catch (e) {
    console.error("[stock] check failed", e);
    return null;
  } finally {
    running = false;
  }
}

export function bootStockTimer() {
  if (booted) return;
  booted = true;
  const mode = process.env.STOCK_TIMER;
  if (mode === "off") return void console.log("[stock] timer disabled by STOCK_TIMER=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[stock] timer idle, not the published server");
  ticking = true;
  setInterval(() => void stockTick(), EVERY_MS);
  setTimeout(() => void stockTick(), 20_000);
}
