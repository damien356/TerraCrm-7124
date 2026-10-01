import { crewClient } from "./api";
import { forgetCrewKey, readCrewKey } from "./crew-key";
import { stopSiteFences } from "./site-fences";

/**
 * Signing out hands the phone back. Stop watching sites, revoke this phone's
 * crew key on the server and forget it here, so Siri on this phone stops
 * answering as this installer and the next person to sign in starts clean.
 * Best effort: offline, the office can still revoke it from the Team page.
 */
export async function releaseCrewPhone() {
  await stopSiteFences().catch(() => undefined);
  if (await readCrewKey()) {
    await crewClient.voice.revokeKey({}).catch(() => undefined);
  }
  await forgetCrewKey().catch(() => undefined);
}
