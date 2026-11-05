import { createHmac, timingSafeEqual } from "node:crypto";

/* ---------------------------------------------------------------------------
 * Retell's request signature. Every webhook and every custom-function call
 * carries X-Retell-Signature: "v=<ms timestamp>,d=<hex HMAC-SHA256>", where
 * the HMAC is over the raw body followed by the timestamp, keyed with the
 * Retell API key that has the webhook badge. Older than 5 minutes is refused.
 *
 * The key is RETELL_API_KEY in the root .env. It is never logged or returned.
 * ------------------------------------------------------------------------- */

export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;

export const retellKey = () => (process.env.RETELL_API_KEY ?? "").trim();
export const retellConfigured = () => retellKey().length > 0;

export function signBody(body: string, key: string, ts = Date.now()) {
  const d = createHmac("sha256", key).update(body + ts).digest("hex");
  return `v=${ts},d=${d}`;
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function checkSignature(body: string, header: string | null | undefined, now = Date.now(), key = retellKey()): SignatureCheck {
  if (!key) return { ok: false, reason: "not configured" };
  const m = /^v=(\d+),d=([0-9a-f]+)$/i.exec((header ?? "").trim());
  if (!m) return { ok: false, reason: "missing or malformed signature" };
  const ts = Number(m[1]);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_MAX_AGE_MS) return { ok: false, reason: "signature too old" };
  const want = createHmac("sha256", key).update(body + m[1]).digest();
  const got = Buffer.from(m[2]!, "hex");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

/** Only calls to the agent we set up, when RETELL_AGENT_ID is set. */
export function agentAllowed(agentId: string | null | undefined) {
  const want = (process.env.RETELL_AGENT_ID ?? "").trim();
  return !want || agentId === want;
}
