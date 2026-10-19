import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

/**
 * STARTUP GUARD AND CRASH REPORTS.
 *
 * Imported first in app/_layout.tsx, so it runs before the sign-in client
 * reads anything off the phone. Three jobs:
 *
 * 1. Safe storage. Every read of the saved login goes through safeGet. If an
 *    Android phone cannot read a saved value (it can lose the key it was
 *    locked with), the value is wiped and treated as signed out. It used to
 *    throw while the app was loading, which closed the app on every launch
 *    until it was reinstalled. An iPhone that says no is only locked, so
 *    nothing is wiped there (notes 18.63).
 * 2. Self repair. A crash before the first screen shows is counted. After two
 *    in a row the saved login is wiped before anything else loads, so the next
 *    launch starts clean on Sign in. No reinstall.
 * 3. Crash reports. Errors are kept on the phone (they survive the crash) and
 *    sent to Ops the next time the app is up. Admin > Team shows them.
 */

const native = Platform.OS !== "web";

/* ------------------------------ safe storage ----------------------------- */

const problemsSeen: string[] = [];
const ios = Platform.OS === "ios";

/** Where the sign-in clients keep the login. Matches @better-auth/expo and Runable managed auth. */
const LOGIN_KEYS = ["better-auth_cookie", "better-auth_session_data", "runable.managed-auth.token"];
const isLoginKey = (key: string) => LOGIN_KEYS.some((k) => key === k || key.startsWith(`${k}.`));

/**
 * Where everything here is kept on an iPhone (notes 18.63).
 *
 * The login used to sit in the default keychain slot, which iOS locks along
 * with the screen. When iOS woke Terra in the background with the phone locked
 * (Siri, a site circle, a swipe closed app being relaunched), every read
 * failed, and the old guard took a failed read as a broken value and wiped
 * it. That is the "signed out every time I close it". This slot can be read
 * with the screen locked once the phone has been unlocked once since it was
 * switched on, the same as the crew key (lib/crew-key.ts). Android keeps its
 * old slot: it never had the problem and a move there would mean re-keying.
 */
const IOS_OPTS: SecureStore.SecureStoreOptions = {
  keychainService: "terra.login",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/**
 * What has been read or written this run. A value only changes through
 * safeSet, so a read the keychain refuses later (locked again) still gets the
 * last good answer instead of "nothing saved".
 */
const memo = new Map<string, string | null>();

/** A saved login could not be read just now (iPhone still locked). Not a sign-out. */
let loginUnreadable = false;

export function savedLoginUnreadable() {
  return loginUnreadable;
}

/** Try the keychain again, for when the phone comes back to the front. */
export function retrySavedLogin() {
  if (!loginUnreadable) return;
  loginUnreadable = false;
  // Deleting while walking a Map is safe: removed entries are just not visited.
  for (const [key, value] of memo) if (isLoginKey(key) && value == null) memo.delete(key);
}

function readIos(key: string): string | null {
  const now = SecureStore.getItem(key, IOS_OPTS);
  if (now != null) return now;
  // Saved by an older copy of Terra in the slot that locks with the screen.
  // Move it across once, while the phone is unlocked enough to read it.
  const old = SecureStore.getItem(key);
  if (old == null) return null;
  SecureStore.setItem(key, old, IOS_OPTS);
  void SecureStore.deleteItemAsync(key).catch(() => undefined);
  return old;
}

/** Read a saved value. Never throws. */
export function safeGet(key: string): string | null {
  if (!native) return null;
  if (memo.has(key)) return memo.get(key) ?? null;
  try {
    const value = ios ? readIos(key) : SecureStore.getItem(key);
    memo.set(key, value);
    return value;
  } catch (e) {
    if (ios) {
      // A locked iPhone says no for now, not forever. Keep the value, answer
      // "unknown", and read again next time.
      if (isLoginKey(key)) loginUnreadable = true;
      return null;
    }
    // Android can lose the key a value was locked with, and then it never
    // reads again. Clear it so the next read is clean, then note it once.
    wipe(key);
    if (!problemsSeen.includes(key)) {
      problemsSeen.push(key);
      queueProblem({ kind: "storage_reset", message: `Could not read saved ${key}, cleared it. ${errText(e)}` });
      // Only a lost login is worth telling the person about on Sign in.
      if (isLoginKey(key)) loginNote = loginNote ?? "reset";
    }
    return null;
  }
}

/**
 * Blank a value now, so the next read is clean. Overwriting is synchronous, so
 * nothing written straight after can be lost to a delete that lands late. Only
 * if the phone will not even overwrite it is it deleted instead.
 */
function wipe(key: string) {
  memo.set(key, "");
  try {
    SecureStore.setItem(key, "", ios ? IOS_OPTS : undefined);
  } catch {
    void SecureStore.deleteItemAsync(key, ios ? IOS_OPTS : undefined).catch(() => undefined);
  }
  // The old iPhone slot too, so a stale login cannot come back from it.
  if (ios) void SecureStore.deleteItemAsync(key).catch(() => undefined);
}

/** Save a value. Never throws: a phone that cannot save keeps it for this run and saves it next time. */
export function safeSet(key: string, value: string) {
  if (!native) return;
  memo.set(key, value);
  try {
    SecureStore.setItem(key, value, ios ? IOS_OPTS : undefined);
  } catch {
    /* Nothing sensible to do. The next sign-in saves it again. */
  }
}

/** Marks a value @better-auth/expo split over several keys (a leading \x01, then "ba-chunks:N"). */
function chunkCount(v: string | null | undefined) {
  if (!v) return 0;
  const at = v.indexOf("ba-chunks:");
  if (at < 0 || at > 1) return 0;
  return Number(v.slice(at + 10)) || 0;
}

/* ------------------------------ saved login ------------------------------ */

/** Wipe the saved login, chunks included. Synchronous so it can run before the sign-in client loads. */
export function clearSavedLogin() {
  if (!native) return;
  for (const key of LOGIN_KEYS) {
    const chunks = chunkCount(safeGet(key));
    wipe(key);
    for (let i = 0; i < chunks; i++) wipe(`${key}.${i}`);
  }
}

/* ----------------------------- sign-in notes ----------------------------- */

export type LoginNote = "expired" | "reset" | "disabled";
let loginNote: LoginNote | null = null;

/** Say why the person has landed on Sign in. Read once by the Sign in screen. */
export function setLoginNote(note: LoginNote) {
  loginNote = note;
}

/** What Sign in should say, if anything. Read it, then clear it once shown. */
export function peekLoginNote(): LoginNote | null {
  return loginNote;
}

export function clearLoginNote() {
  loginNote = null;
}

/** Is a login saved on this phone at all? Says nothing about whether it still works. */
export function hasSavedLogin() {
  if (!native) return false;
  const cookie = safeGet("better-auth_cookie");
  if (chunkCount(cookie) > 0) return true;
  if (cookie) {
    try {
      const parsed = JSON.parse(cookie) as Record<string, unknown>;
      if (parsed && Object.keys(parsed).length > 0) return true;
    } catch {
      /* Not a cookie we can use. */
    }
  }
  return !!safeGet("runable.managed-auth.token");
}

const K_SIGNED_IN = "terra.wasSignedIn";

/** Remember this phone was signed in, so a login that runs out can say so. */
export function rememberSignedIn() {
  if (safeGet(K_SIGNED_IN) !== "1") safeSet(K_SIGNED_IN, "1");
}

export function wasSignedIn() {
  return safeGet(K_SIGNED_IN) === "1";
}

/** A sign-out the person chose. No "expired" note afterwards. */
export function forgetSignedIn() {
  safeSet(K_SIGNED_IN, "0");
}

/* ------------------------------ crash reports ---------------------------- */

export type ProblemKind = "fatal" | "error" | "screen" | "storage_reset" | "safe_start" | "emergency_launch" | "session_expired";
export type Problem = { kind: ProblemKind; message: string; stack?: string; at: string };

// Each problem gets its own saved slot (a ring of 10) because one saved value
// should stay under 2 KB. Message and stack are trimmed to fit.
const K_FIRST = "terra.problems.first";
const K_NEXT = "terra.problems.next";
const SLOTS = 10;
const slotKey = (n: number) => `terra.problems.${n % SLOTS}`;

function errText(e: unknown) {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? "unknown");
}

function counters() {
  const next = Math.max(0, Number(safeGet(K_NEXT) ?? "0") || 0);
  const first = Math.min(next, Math.max(next - SLOTS, Number(safeGet(K_FIRST) ?? "0") || 0));
  return { first, next };
}

function readSlot(n: number): Problem | null {
  const raw = safeGet(slotKey(n));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Problem;
    return p && typeof p.kind === "string" && typeof p.message === "string" ? p : null;
  } catch {
    return null;
  }
}

function readProblems(): Problem[] {
  const { first, next } = counters();
  const out: Problem[] = [];
  for (let n = first; n < next; n++) {
    const p = readSlot(n);
    if (p) out.push(p);
  }
  return out;
}

/** Keep a problem on the phone until it reaches Ops. Synchronous, so a crash cannot lose it. */
export function queueProblem(p: { kind: ProblemKind; message: string; stack?: string }) {
  if (!native) return;
  const message = p.message.slice(0, 300);
  const { first, next } = counters();
  // The same thing again (an update that keeps failing) is one report, not ten.
  if (next > first) {
    const last = readSlot(next - 1);
    if (last && last.kind === p.kind && last.message === message) return;
  }
  const item: Problem = { kind: p.kind, message, stack: p.stack?.slice(0, 1200), at: new Date().toISOString() };
  safeSet(slotKey(next), JSON.stringify(item));
  safeSet(K_NEXT, String(next + 1));
  if (next + 1 - first > SLOTS) safeSet(K_FIRST, String(next + 1 - SLOTS));
}

/** Problems waiting to go, oldest first. */
export function pendingProblems() {
  return readProblems();
}

/** The oldest `sent` problems reached Ops. */
export function clearProblems(sent: number) {
  const { first, next } = counters();
  const upTo = Math.min(next, first + sent);
  for (let n = first; n < upTo; n++) safeSet(slotKey(n), "");
  safeSet(K_FIRST, String(upTo));
}

/** What this phone is running, sent with every report. */
export function appInfo() {
  let updateId: string | null = null;
  let runtimeVersion: string | null = null;
  try {
    updateId = Updates.updateId ?? null;
    runtimeVersion = Updates.runtimeVersion ?? null;
  } catch {
    /* Not available. */
  }
  return {
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? ""),
    appVersion: Constants.expoConfig?.version ?? "",
    updateId,
    runtimeVersion,
    deviceName: Constants.deviceName ?? null,
  };
}

/* ------------------------------ boot counting ---------------------------- */

const K_FAILED_BOOTS = "terra.failedBoots";
let ready = false;
let recover: ((e: Error) => void) | null = null;

/** The first screen is up. Crashes from here on are not startup crashes. */
export function markReady() {
  if (ready) return;
  ready = true;
  if (safeGet(K_FAILED_BOOTS) !== "0") safeSet(K_FAILED_BOOTS, "0");
}

/** The on-screen recovery, registered by the startup boundary once it is mounted. */
export function onFatal(handler: ((e: Error) => void) | null) {
  recover = handler;
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsShape = { getGlobalHandler: () => GlobalHandler; setGlobalHandler: (h: GlobalHandler) => void };

function installGlobalHandler() {
  const EU = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (!EU) return;
  const previous = EU.getGlobalHandler();
  EU.setGlobalHandler((error, isFatal) => {
    const e = error instanceof Error ? error : new Error(String(error));
    queueProblem({ kind: isFatal ? "fatal" : "error", message: `${ready ? "" : "[starting] "}${errText(e)}`, stack: e.stack });
    if (!isFatal) return previous(error, isFatal);
    if (ready && recover) {
      // The app is up: show Terra's own recovery screen instead of closing.
      recover(e);
      return;
    }
    // Still loading. Count it, so two in a row wipe the saved login next time.
    const n = Number(safeGet(K_FAILED_BOOTS) ?? "0") || 0;
    safeSet(K_FAILED_BOOTS, String(n + 1));
    previous(error, isFatal);
  });
}

function startupChecks() {
  if (!native) return;
  // Move anything an older copy saved in the iPhone slot that locks with the
  // screen, now, while it can be read (see IOS_OPTS). A locked read just waits.
  if (ios) for (const key of [...LOGIN_KEYS, K_SIGNED_IN, K_FIRST, K_NEXT]) safeGet(key);
  const failed = Number(safeGet(K_FAILED_BOOTS) ?? "0") || 0;
  if (failed >= 2) {
    clearSavedLogin();
    safeSet(K_FAILED_BOOTS, "0");
    queueProblem({ kind: "safe_start", message: `Terra closed while starting ${failed} times in a row, so the saved login was cleared.` });
    loginNote = "reset";
  }
  try {
    if (Updates.isEmergencyLaunch) {
      queueProblem({
        kind: "emergency_launch",
        message: `The last app update failed to start, so the phone went back to the copy it shipped with. ${Updates.emergencyLaunchReason ?? ""}`.trim(),
      });
    }
  } catch {
    /* Updates not available in this build. */
  }
}

installGlobalHandler();
startupChecks();
