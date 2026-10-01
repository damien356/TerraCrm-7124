import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { crewClient } from "./api";
import { hasAutoArrive } from "./crew-key";

/**
 * ARRIVING AND LEAVING SITE, BY LOCATION.
 *
 * The phone watches a circle round each site the installer is booked at today
 * or tomorrow (iOS region monitoring, so no constant GPS and no blue bar).
 * Crossing in or out is reported to visits.enter / visits.leave. The server
 * does the judging: a fence only counts on a booked day, under 5 minutes
 * inside is a drive past, and arriving never starts the task.
 *
 * Needs "Always" location. If the installer says no, nothing here runs and
 * they tap Arrived and Left site on the job instead.
 *
 * Sites have no stored coordinates, so the phone geocodes the address itself
 * and keeps the answer, which also keeps it under Apple's geocoding limits.
 */

export const FENCE_TASK = "terra-site-fences";
const MAX_REGIONS = 18; // iOS allows 20 per app; leave room.

const OPTS: SecureStore.SecureStoreOptions = {
  keychainService: "terra.voice",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};
const K_QUEUE = "fenceQueue";
const K_GEO = "fenceGeo";

export const fencesSupported = Platform.OS === "ios";

type FenceEvent = { kind: "enter" | "leave"; taskId: number; at: string };

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(name, OPTS);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(name: string, value: unknown) {
  try {
    await SecureStore.setItemAsync(name, JSON.stringify(value), OPTS);
  } catch {
    /* A full or locked keychain only costs us the cache. */
  }
}

async function send(e: FenceEvent) {
  const input = { taskId: e.taskId, at: e.at, source: "geofence" as const };
  if (e.kind === "enter") await crewClient.visits.enter(input);
  else await crewClient.visits.leave(input);
}

/**
 * Send anything that failed earlier (no signal on site is normal), oldest
 * first, so an enter always lands before its leave. Keeps the last 30.
 */
export async function flushFenceQueue() {
  const queue = await readJson<FenceEvent[]>(K_QUEUE, []);
  if (!queue.length) return;
  const left: FenceEvent[] = [];
  for (let i = 0; i < queue.length; i++) {
    try {
      await send(queue[i]!);
    } catch (err) {
      /* A 4xx means the server has judged it, retrying will not change that. */
      const status = (err as { status?: number })?.status;
      if (status && status >= 400 && status < 500) continue;
      left.push(...queue.slice(i));
      break;
    }
  }
  await writeJson(K_QUEUE, left.slice(-30));
}

async function report(e: FenceEvent) {
  const queue = await readJson<FenceEvent[]>(K_QUEUE, []);
  await writeJson(K_QUEUE, [...queue, e].slice(-30));
  await flushFenceQueue();
}

/* Must be defined at module load, before React mounts, so iOS can wake the
 * app straight into it. Imported from app/_layout.tsx for that reason. */
if (fencesSupported) {
  TaskManager.defineTask(FENCE_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { eventType, region } = data as { eventType: Location.GeofencingEventType; region: Location.LocationRegion };
    const taskId = Number(String(region?.identifier ?? "").replace(/^t/, ""));
    if (!Number.isFinite(taskId) || taskId <= 0) return;
    const kind = eventType === Location.GeofencingEventType.Enter ? "enter" : "leave";
    await report({ kind, taskId, at: new Date().toISOString() });
  });
}

async function coordsFor(destination: string, cache: Record<string, [number, number] | null>) {
  if (destination in cache) return cache[destination];
  try {
    const [hit] = await Location.geocodeAsync(destination);
    cache[destination] = hit ? [hit.latitude, hit.longitude] : null;
  } catch {
    return null; // Don't cache a network failure as "no such place".
  }
  return cache[destination];
}

async function stopFences() {
  if (!fencesSupported) return;
  if (await Location.hasStartedGeofencingAsync(FENCE_TASK).catch(() => false)) {
    await Location.stopGeofencingAsync(FENCE_TASK).catch(() => undefined);
  }
}

export type FenceState = "off" | "unsupported" | "needs_always" | "watching" | "nothing_booked" | "error";

/**
 * Point the circles at today's and tomorrow's sites. Called when the app comes
 * to the front, after sign in, and when the switch on the Me tab changes.
 */
export async function syncSiteFences(): Promise<{ state: FenceState; count: number }> {
  if (!fencesSupported) return { state: "unsupported", count: 0 };
  if (!(await hasAutoArrive())) {
    await stopFences();
    return { state: "off", count: 0 };
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (!bg.granted) {
    await stopFences();
    return { state: "needs_always", count: 0 };
  }
  try {
    await flushFenceQueue();
    const { targets } = await crewClient.visits.targets();
    const cache = await readJson<Record<string, [number, number] | null>>(K_GEO, {});
    const seen = new Set<number>();
    const regions: Location.LocationRegion[] = [];
    for (const t of targets) {
      if (seen.has(t.taskId) || !t.destination || regions.length >= MAX_REGIONS) continue;
      seen.add(t.taskId);
      const at = await coordsFor(t.destination, cache);
      if (!at) continue;
      regions.push({
        identifier: `t${t.taskId}`,
        latitude: at[0],
        longitude: at[1],
        radius: t.radiusM,
        notifyOnEnter: true,
        notifyOnExit: true,
      });
    }
    /* Keep the cache to the addresses in play, so it never grows. */
    const keep: Record<string, [number, number] | null> = {};
    for (const t of targets) if (t.destination && t.destination in cache) keep[t.destination] = cache[t.destination]!;
    await writeJson(K_GEO, keep);

    if (!regions.length) {
      await stopFences();
      return { state: "nothing_booked", count: 0 };
    }
    await Location.startGeofencingAsync(FENCE_TASK, regions);
    return { state: "watching", count: regions.length };
  } catch {
    return { state: "error", count: 0 };
  }
}

/** Switched off on the Me tab, or signing out. */
export async function stopSiteFences() {
  await stopFences();
}
