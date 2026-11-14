import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { WidgetCache } from "./widget-model";

/**
 * WHERE THE PHONE KEEPS THE WIDGETS' LAST SYNC (Damien, 14 Nov 2026).
 *
 * In the keychain (iPhone) or encrypted storage (Android), filed under the
 * login it belongs to. Only one login's copy is ever kept: saving a different
 * login's sync wipes the old one first, and signing out wipes it all.
 *
 * Stored in pieces, because the iPhone keychain does not promise to take one
 * long value. AFTER_FIRST_UNLOCK so the Android widget can read it when it
 * redraws in the background.
 */

const OPTS: SecureStore.SecureStoreOptions = {
  keychainService: "terra.widget",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

const K_CURRENT = "current";
const PIECE = 1500;
const native = Platform.OS === "ios" || Platform.OS === "android";

/** Keychain names take letters, digits, dot, dash and underscore only. */
const slot = (accountId: string) => `w_${accountId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`;

async function get(name: string) {
  try {
    return await SecureStore.getItemAsync(name, OPTS);
  } catch {
    return null;
  }
}

async function drop(name: string) {
  await SecureStore.deleteItemAsync(name, OPTS).catch(() => undefined);
}

async function wipe(accountId: string) {
  const base = slot(accountId);
  const n = Number(await get(`${base}_n`)) || 0;
  for (let i = 0; i < Math.max(n, 1); i++) await drop(`${base}_${i}`);
  await drop(`${base}_n`);
}

/** The login the saved copy belongs to, if any. */
export async function cachedAccount() {
  if (!native) return null;
  return get(K_CURRENT);
}

export async function readCache(): Promise<WidgetCache | null> {
  if (!native) return null;
  const current = await get(K_CURRENT);
  if (!current) return null;
  const base = slot(current);
  const n = Number(await get(`${base}_n`)) || 0;
  if (n < 1) return null;
  let text = "";
  for (let i = 0; i < n; i++) {
    const piece = await get(`${base}_${i}`);
    if (piece == null) return null;
    text += piece;
  }
  try {
    const cache = JSON.parse(text) as WidgetCache;
    // Never hand one login's jobs to another, whatever the file says.
    return cache?.snap?.accountId === current ? cache : null;
  } catch {
    return null;
  }
}

export async function writeCache(cache: WidgetCache) {
  if (!native) return;
  const accountId = cache.snap.accountId;
  const previous = await get(K_CURRENT);
  if (previous && previous !== accountId) await wipe(previous);
  const base = slot(accountId);
  const before = Number(await get(`${base}_n`)) || 0;
  const text = JSON.stringify(cache);
  const pieces = Math.ceil(text.length / PIECE);
  // Hide the copy while it is half written, so a reader never joins old and new pieces.
  await drop(`${base}_n`);
  for (let i = 0; i < pieces; i++) await SecureStore.setItemAsync(`${base}_${i}`, text.slice(i * PIECE, (i + 1) * PIECE), OPTS);
  for (let i = pieces; i < before; i++) await drop(`${base}_${i}`);
  await SecureStore.setItemAsync(`${base}_n`, String(pieces), OPTS);
  await SecureStore.setItemAsync(K_CURRENT, accountId, OPTS);
}

/** Forget every saved widget copy on this phone. */
export async function clearCache() {
  if (!native) return;
  const current = await get(K_CURRENT);
  if (current) await wipe(current);
  await drop(K_CURRENT);
}
