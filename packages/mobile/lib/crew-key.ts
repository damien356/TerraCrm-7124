import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import { Platform } from "react-native";

/**
 * THIS PHONE'S CREW KEY.
 *
 * Siri runs with the app closed and the phone locked in a pocket or on a
 * CarPlay dash, and a geofence wakes the app in the background the same way.
 * The normal sign-in cookie lives in a keychain slot that is unreadable while
 * the phone is locked, so neither can lean on it. Each phone gets its own key
 * instead (see voice.issueKey on the server, which stores only a hash).
 *
 * Stored with AFTER_FIRST_UNLOCK so it can be read with the screen locked once
 * the phone has been unlocked once since it was switched on.
 *
 * The Swift Siri intents (plugins/terra-siri) read these same keychain items:
 * service "terra.voice:no-auth", accounts "voiceKey", "apiUrl" and "siriOn".
 * Change a name here and you must change it there too.
 */

const OPTS: SecureStore.SecureStoreOptions = {
  keychainService: "terra.voice",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const K_KEY = "voiceKey";
const K_API = "apiUrl";
const K_SIRI = "siriOn";
const K_AUTO = "autoArrive";

const native = Platform.OS !== "web";

async function get(name: string) {
  if (!native) return null;
  try {
    return await SecureStore.getItemAsync(name, OPTS);
  } catch {
    return null;
  }
}

async function put(name: string, value: string | null) {
  if (!native) return;
  if (value == null) await SecureStore.deleteItemAsync(name, OPTS).catch(() => undefined);
  else await SecureStore.setItemAsync(name, value, OPTS);
}

export const crewKeySupported = native;

export const readCrewKey = () => get(K_KEY);

export async function hasSiri() {
  return (await get(K_SIRI)) === "1" && Boolean(await get(K_KEY));
}

export async function hasAutoArrive() {
  return (await get(K_AUTO)) === "1" && Boolean(await get(K_KEY));
}

export function phoneName() {
  return (Device.deviceName || Device.modelName || "iPhone").slice(0, 120);
}

/**
 * Make sure this phone has a key. Needs the real sign-in, the server will not
 * let one key mint another. `issue` is the voice.issueKey call, passed in so
 * this file does not import the API client (and the client can import this).
 */
export async function ensureCrewKey(apiUrl: string, issue: (deviceName: string) => Promise<{ key: string }>) {
  const existing = await get(K_KEY);
  if (existing) {
    await put(K_API, apiUrl);
    return existing;
  }
  const { key } = await issue(phoneName());
  await put(K_KEY, key);
  await put(K_API, apiUrl);
  return key;
}

export async function setSiriFlag(on: boolean) {
  await put(K_SIRI, on ? "1" : null);
}

export async function setAutoArriveFlag(on: boolean) {
  await put(K_AUTO, on ? "1" : null);
}

/** True when nothing on this phone still needs the key. */
export async function keyUnused() {
  return (await get(K_SIRI)) !== "1" && (await get(K_AUTO)) !== "1";
}

/** Forget the key locally. The caller revokes it on the server first. */
export async function forgetCrewKey() {
  await put(K_KEY, null);
  await put(K_SIRI, null);
  await put(K_AUTO, null);
}
