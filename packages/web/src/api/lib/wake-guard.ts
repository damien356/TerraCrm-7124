import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Guard for GET /api/wake, the outside call (cron-job.org) that nudges the
 * 7am summary (22 Oct, Damien's conditions before it goes live):
 *
 * - The caller must send the secret in the `X-Terra-Wake-Key` header. The value
 *   lives only in the WAKE_SECRET env var and in cron-job.org. Never in a query
 *   string, so it never lands in access logs. With no WAKE_SECRET set, or one
 *   shorter than 32 characters, the endpoint stays switched off.
 * - Compared as SHA-256 digests with timingSafeEqual, so length and timing give
 *   nothing away.
 * - Rate limited in memory. Wrong or missing keys: 10 per 10 minutes for one
 *   address and 100 per 10 minutes across all of them. Right key: 12 an hour.
 *   The two are counted apart, so a flood of bad calls can't block the real one.
 * - Every answer is only {ok} or {ok, ticking}. No business data.
 *
 * Sending stays guarded by the once a day database claim in notify.ts, so
 * repeated or simultaneous calls with the right key still send one email.
 */

export const WAKE_HEADER = "x-terra-wake-key";
export const WAKE_MIN_SECRET = 32;

export const WAKE_LIMITS = {
  badPerAddress: { max: 10, windowMs: 10 * 60_000 },
  badOverall: { max: 100, windowMs: 10 * 60_000 },
  good: { max: 12, windowMs: 60 * 60_000 },
};

const hits = new Map<string, number[]>();
const MAX_KEYS = 2000;

/** Counts one hit in a sliding window. False once the window is full. */
function take(key: string, max: number, windowMs: number, now: number) {
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > MAX_KEYS) {
    const first = hits.keys().next().value;
    if (first !== undefined && first !== key) hits.delete(first);
  }
  return true;
}

/** Peeks without counting. */
function full(key: string, max: number, windowMs: number, now: number) {
  return (hits.get(key) ?? []).filter((t) => now - t < windowMs).length >= max;
}

export function resetWakeLimits() {
  hits.clear();
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

function secret() {
  const s = (process.env.WAKE_SECRET ?? "").trim();
  return s.length >= WAKE_MIN_SECRET ? s : "";
}

export function wakeConfigured() {
  return secret() !== "";
}

/** The caller's address as the proxy reports it. Only used to count. */
export function callerAddress(h: Headers) {
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || h.get("x-real-ip")?.trim() || h.get("cf-connecting-ip")?.trim() || "unknown";
}

export type WakeVerdict = { status: 200 | 401 | 429 | 503; retryAfterSec?: number };

/** Decides whether this call may run the timer. Never throws. */
export function judgeWake(h: Headers, now = Date.now()): WakeVerdict {
  const want = secret();
  if (!want) return { status: 503 };
  const addr = callerAddress(h);
  const given = h.get(WAKE_HEADER) ?? "";
  const right = given.length > 0 && timingSafeEqual(digest(given), digest(want));
  if (right) {
    const g = WAKE_LIMITS.good;
    if (!take("good", g.max, g.windowMs, now)) return { status: 429, retryAfterSec: Math.ceil(g.windowMs / 1000) };
    return { status: 200 };
  }
  const a = WAKE_LIMITS.badPerAddress;
  const o = WAKE_LIMITS.badOverall;
  if (full(`bad:${addr}`, a.max, a.windowMs, now) || full("bad", o.max, o.windowMs, now)) {
    return { status: 429, retryAfterSec: Math.ceil(a.windowMs / 1000) };
  }
  take(`bad:${addr}`, a.max, a.windowMs, now);
  take("bad", o.max, o.windowMs, now);
  return { status: 401 };
}
