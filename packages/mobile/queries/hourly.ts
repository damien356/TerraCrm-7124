import { Platform } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "@/lib/api";
import { safeGet, safeSet } from "@/lib/crash-guard";

/**
 * Hourly time: Start work, Break, Resume, Finish work today and "ask the
 * office to fix". All of it on `orpc.hourly.*`, installer scoped on the
 * server: his own time, his own rates, his own pay. Never a vehicle
 * allowance, a benchmark or anyone else's rate.
 *
 * A tap that fails for want of signal is kept on the phone with the time it
 * was made and the same clientKey, so tapping again sends the same tap. The
 * server treats a repeated key as the same entry, never a second one.
 */

export function useMyTime(taskId: number, enabled = true) {
  return useQuery(
    orpc.hourly.myTime.queryOptions({
      input: { taskId },
      enabled: enabled && Number.isFinite(taskId),
      retry: false,
      refetchInterval: 60_000,
    }),
  );
}

export function useMyHourlySummary(enabled = true) {
  return useQuery(orpc.hourly.mySummary.queryOptions({ enabled, retry: false, staleTime: 30_000 }));
}

function useInvalidateTime() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.hourly.key() });
    void qc.invalidateQueries({ queryKey: orpc.field.key() });
  };
}

export function useStartWork() {
  const invalidate = useInvalidateTime();
  return useMutation(orpc.hourly.start.mutationOptions({ onSuccess: invalidate }));
}

export function usePauseWork() {
  const invalidate = useInvalidateTime();
  return useMutation(orpc.hourly.pause.mutationOptions({ onSuccess: invalidate }));
}

export function useResumeWork() {
  const invalidate = useInvalidateTime();
  return useMutation(orpc.hourly.resume.mutationOptions({ onSuccess: invalidate }));
}

export function useFinishWork() {
  const invalidate = useInvalidateTime();
  return useMutation(orpc.hourly.finish.mutationOptions({ onSuccess: invalidate }));
}

export function useAskOfficeToFix() {
  const invalidate = useInvalidateTime();
  return useMutation(orpc.hourly.requestCorrection.mutationOptions({ onSuccess: invalidate }));
}

/* ------------------------------ saved taps ------------------------------ */

export type TapKind = "start" | "pause" | "resume" | "finish";
export type SavedTap = { kind: TapKind; clientKey: string; at: string; sessionId?: number | null };

const MAX_AGE_MS = 11 * 60 * 60 * 1000;
const storeKey = (taskId: number) => `hourly_tap_${taskId}`;

function readRaw(k: string): string | null {
  if (Platform.OS === "web") {
    try {
      return typeof localStorage === "undefined" ? null : localStorage.getItem(k);
    } catch {
      return null;
    }
  }
  return safeGet(k);
}

function writeRaw(k: string, v: string) {
  if (Platform.OS === "web") {
    try {
      if (typeof localStorage !== "undefined") {
        if (v) localStorage.setItem(k, v);
        else localStorage.removeItem(k);
      }
    } catch {
      /* private mode: kept for this run only */
    }
    return;
  }
  safeSet(k, v);
}

/** A tap that did not get through, if it is recent enough to send again. */
export function savedTap(taskId: number): SavedTap | null {
  const raw = readRaw(storeKey(taskId));
  if (!raw) return null;
  try {
    const t = JSON.parse(raw) as SavedTap;
    if (!t?.clientKey || !t.at || Date.now() - Date.parse(t.at) > MAX_AGE_MS) return null;
    return t;
  } catch {
    return null;
  }
}

export function saveTap(taskId: number, tap: SavedTap) {
  writeRaw(storeKey(taskId), JSON.stringify(tap));
}

export function clearTap(taskId: number) {
  writeRaw(storeKey(taskId), "");
}

export function newClientKey() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `app-${Date.now().toString(36)}-${rand}`;
}

/** True when the server answered (a real "no"), false when the tap never got there. */
export function serverAnswered(e: unknown) {
  if (!e || typeof e !== "object") return false;
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && status > 0;
}

export function errorText(e: unknown, fallback: string) {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/* ------------------------------ display ------------------------------ */

const BNE_OFFSET_MS = 10 * 60 * 60 * 1000; // Brisbane has no daylight saving.

/** "7:02am", Brisbane time, from an ISO instant. */
export function clock(iso?: string | null) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + BNE_OFFSET_MS);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

/** "7h 30m" from minutes. */
export function hrsMins(minutes?: number | null) {
  const m = Math.max(0, Math.round(minutes ?? 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}

/** "$1,234.50" */
export function dollars(n?: number | null) {
  if (n == null) return "-";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const STATUS_TEXT: Record<string, string> = {
  open: "On the clock",
  recorded: "Waiting for the office",
  approved: "Approved",
  rejected: "Not counted",
};
