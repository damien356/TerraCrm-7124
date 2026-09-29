import { startEngine } from "./journey-engine";

/* ---------------------------------------------------------------------------
 * Booting the journey engine.
 *
 * The engine ticks inside the published server process, and ONLY there.
 *
 * The API module is also loaded by the Vite dev server, and a sandbox dev
 * server points at the same database as production. An engine ticking there
 * would send real marketing email to real customers off a developer's laptop.
 * So the boot is gated on the process actually being the published server:
 * the entry script is `__server.ts`, which is how pm2 and `bun run start`
 * launch it. Under Vite the entry is the Vite binary, so the gate closes.
 *
 * Two env vars override the gate, both read at boot:
 *   MARKETING_ENGINE=off   never tick, even on the published server
 *   MARKETING_ENGINE=on    tick regardless of the entry script
 *
 * `on` exists so the engine can be forced up if the published server is ever
 * launched some other way. Nothing else is needed in the normal case.
 * ------------------------------------------------------------------------- */

/** Was this process launched as the published web server? */
function isPublishedServer() {
  /* Cast because this module is also type-checked against React Native's
   * narrower `process`, which declares env and nothing else. */
  const argv = (process as unknown as { argv?: string[] }).argv ?? [];
  return (argv[1] ?? "").endsWith("__server.ts");
}

let booted = false;

export function bootJourneyEngine() {
  if (booted) return;
  booted = true;

  const mode = process.env.MARKETING_ENGINE;

  if (mode === "off") {
    console.log("[journeys] engine disabled by MARKETING_ENGINE=off");
    return;
  }

  if (mode !== "on" && !isPublishedServer()) {
    console.log("[journeys] engine idle — not the published server, nothing will be sent");
    return;
  }

  startEngine();
}
