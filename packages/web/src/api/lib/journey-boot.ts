import { startEngine } from "./journey-engine";
import { isLiveServer } from "./runtime";

/* ---------------------------------------------------------------------------
 * Booting the journey engine.
 *
 * The engine ticks inside the published server process, and ONLY there.
 *
 * The API module is also loaded by the Vite dev server, and a sandbox dev
 * server points at the same database as production. An engine ticking there
 * would send real marketing email to real customers off a developer's laptop.
 * So the boot is gated on the process actually being the published server,
 * using isLiveServer() in lib/runtime.ts. The old check looked for the entry
 * script `__server.ts`, which live never uses, so the engine never ran.
 *
 * Two env vars override the gate, both read at boot:
 *   MARKETING_ENGINE=off   never tick, even on the published server
 *   MARKETING_ENGINE=on    tick regardless of the entry script
 *
 * `on` exists so the engine can be forced up for a test. Nothing else is
 * needed in the normal case.
 * ------------------------------------------------------------------------- */

let booted = false;
let ticking = false;
/** For the deploy check: did this process start the journey engine? */
export const journeysTicking = () => ticking;

export function bootJourneyEngine() {
  if (booted) return;
  booted = true;

  const mode = process.env.MARKETING_ENGINE;

  if (mode === "off") {
    console.log("[journeys] engine disabled by MARKETING_ENGINE=off");
    return;
  }

  if (mode !== "on" && !isLiveServer()) {
    console.log("[journeys] engine idle, not the published server, nothing will be sent");
    return;
  }

  ticking = true;
  startEngine();
}
