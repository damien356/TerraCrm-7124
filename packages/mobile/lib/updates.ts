import { Platform } from "react-native";
import * as Updates from "expo-updates";

/**
 * Over-the-air updates.
 *
 * The phone boots whatever copy it already has, then looks for a new one in the
 * background. A crew member standing in a house with one bar never waits on the
 * network to start work.
 *
 * Nothing here ever reloads the app while someone is using it. A download is
 * staged and takes effect the next time the app is opened cold. Reloading
 * mid-shift would throw away a half-written note or a photo still uploading,
 * which is worse than running yesterday's build for another hour.
 */

/** OTA only exists in a real build. Expo Go and the web preview have no updates. */
export const updatesSupported = Platform.OS !== "web" && Updates.isEnabled;

/** What this phone is currently running. Read this out when diagnosing a report. */
export function currentUpdate() {
  return {
    /** Fingerprint of the native build. Must match for an update to be offered. */
    runtimeVersion: Updates.runtimeVersion ?? "unknown",
    /** Which lane this binary listens on: development, preview or production. */
    channel: Updates.channel ?? "embedded",
    /** Id of the running update, or null when running the copy baked into the build. */
    updateId: Updates.updateId ?? null,
    /** True when running the JS that shipped inside the binary. */
    isEmbedded: Updates.isEmbeddedLaunch,
    createdAt: Updates.createdAt ? Updates.createdAt.toISOString() : null,
    /** True when the last launch rolled back to the embedded copy after a crash. */
    isEmergencyLaunch: Updates.isEmergencyLaunch,
  };
}

/**
 * Look for a new update and stage it for next launch.
 * Returns true when one was downloaded. Never throws: a failed check is not
 * worth interrupting anyone over, and it will try again next time.
 */
export async function stageUpdate(): Promise<boolean> {
  if (!updatesSupported) return false;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply a staged update immediately by restarting the app.
 * Only call this from a deliberate button press, never on a timer, and never
 * while a job is part-way through being written up.
 */
export async function applyUpdateNow(): Promise<void> {
  if (!updatesSupported) return;
  try {
    await Updates.reloadAsync();
  } catch {
    // Still on the old copy, which is a safe place to be.
  }
}
