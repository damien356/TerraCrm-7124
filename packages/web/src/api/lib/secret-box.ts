import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Seals a mailbox sign-in (the Google refresh token) before it touches the
 * database, so a copy of the database alone cannot read anyone's email.
 *
 * AES-256-GCM, key from MAIL_TOKEN_KEY (32 random bytes, base64). Changing or
 * losing the key simply means each mailbox has to be connected again.
 */

function key(): Buffer {
  const raw = process.env.MAIL_TOKEN_KEY ?? "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("MAIL_TOKEN_KEY is not set");
  return k;
}

export const sealConfigured = () => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function unseal(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable sealed value");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}

/** Signed, expiring blob for the OAuth `state` round trip. */
export function signState(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function readState<T>(state: string): T | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function mac(body: string) {
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.MAIL_TOKEN_KEY ?? "";
  if (!secret) throw new Error("No signing secret");
  return createHmac("sha256", secret).update(body).digest("base64url");
}
