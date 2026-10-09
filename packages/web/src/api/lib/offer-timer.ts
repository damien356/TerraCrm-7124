import { tickOffers } from "../routes/offers";
import { isLiveServer } from "./runtime";

/* ---------------------------------------------------------------------------
 * The offer timer.
 *
 * Offers expire after 2 hours and a lower-star installer's hold locks after
 * 2 hours. Both used to happen only when someone opened an offer list or
 * accepted, so a hold could sit past its time with nobody told. This runs
 * them once a minute on the live server.
 *
 *   OFFER_TIMER=off   never run
 *   OFFER_TIMER=on    run outside the live server too (scratch tests only)
 * ------------------------------------------------------------------------- */

const EVERY_MS = 60 * 1000;

let booted = false;
let ticking = false;
let running = false;
/** For the deploy check: did this process start the offer timer? */
export const offerTimerTicking = () => ticking;

async function tick() {
  if (running) return;
  running = true;
  try {
    const r = await tickOffers();
    if (r.expired + r.settled > 0) console.log(`[offers] expired ${r.expired} task(s), settled ${r.settled} hold(s)`);
  } catch (e) {
    console.error("[offers] tick failed", e);
  } finally {
    running = false;
  }
}

export function bootOfferTimer() {
  if (booted) return;
  booted = true;
  const mode = process.env.OFFER_TIMER;
  if (mode === "off") return void console.log("[offers] timer disabled by OFFER_TIMER=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[offers] timer idle, not the published server");
  ticking = true;
  console.log("[offers] settling holds and expiring offers every minute");
  setInterval(() => void tick(), EVERY_MS);
  setTimeout(() => void tick(), 20_000);
}
