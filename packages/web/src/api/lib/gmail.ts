import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { readState, seal, sealConfigured, signState, unseal } from "./secret-box";

/* ---------------------------------------------------------------------------
 * Gmail, read and send only.
 *
 * The rules, fixed here in code and not in a setting:
 *   billing@  read only. Invoices and statements. Never sends.
 *   damien@   read only. Never sends.
 *   team@     read, and the ONLY mailbox anything is ever sent from.
 *
 * Google is asked for gmail.readonly, plus gmail.send for team@ only. Neither
 * scope can delete, move, label or mark anything as read, so Hubdoc and Xero
 * see billing@ exactly as before. No domain-wide delegation: each mailbox is
 * signed in to once, by a person, and can be cut off from Workspace Admin.
 * ------------------------------------------------------------------------- */

export const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const SEND_FROM = "team@terraflooring.com.au";
export const INVOICES_TO = "billing@terraflooring.com.au";

export const MAILBOXES = [
  { address: "billing@terraflooring.com.au", canSend: false, purpose: "Supplier invoices and statements. Read only." },
  { address: "damien@terraflooring.com.au", canSend: false, purpose: "Catches invoices sent to Damien. Read only." },
  { address: "team@terraflooring.com.au", canSend: true, purpose: "Supplier replies, and every email the agent sends." },
] as const;

export type MailboxAddress = (typeof MAILBOXES)[number]["address"];

export function mailboxFor(address: string) {
  const a = address.trim().toLowerCase();
  return MAILBOXES.find((m) => m.address === a) ?? null;
}

export function scopesFor(address: string): string[] {
  const m = mailboxFor(address);
  if (!m) throw new Error(`${address} is not a mailbox the agent may use`);
  return m.canSend ? [READ_SCOPE, SEND_SCOPE] : [READ_SCOPE];
}

export const oauthConfigured = () =>
  Boolean(process.env.GOOGLE_MAIL_CLIENT_ID && process.env.GOOGLE_MAIL_CLIENT_SECRET) && sealConfigured();

/** Google only accepts redirect addresses registered in advance, so this is fixed to the live site. */
export function redirectUri() {
  const base = (process.env.MAIL_OAUTH_BASE ?? "https://ops.terraflooring.com.au").replace(/\/+$/, "");
  return `${base}/api/mail/oauth/callback`;
}

type OAuthState = { a: string; p: number | null; e: number };

export function connectUrl(address: string, profileId: number | null) {
  const m = mailboxFor(address);
  if (!m) throw new Error("Not an allowed mailbox");
  const state = signState({ a: m.address, p: profileId, e: Date.now() + 10 * 60_000 } satisfies OAuthState);
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_MAIL_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: scopesFor(m.address).join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    login_hint: m.address,
    hd: "terraflooring.com.au",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenCall(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_MAIL_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_MAIL_CLIENT_SECRET ?? "",
      ...body,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  if (!res.ok) {
    const err = new Error(String(json.error_description ?? json.error ?? `Google said ${res.status}`));
    (err as Error & { code?: string }).code = String(json.error ?? "");
    throw err;
  }
  return json as { access_token: string; refresh_token?: string; scope?: string; expires_in?: number };
}

async function revoke(token: string) {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

/**
 * The OAuth return. Checks three things before anything is stored: the state
 * is ours and fresh, the person signed in to the mailbox that was asked for
 * (not their own), and Google granted nothing beyond read (and send for team@).
 */
export async function finishConnect(code: string, state: string) {
  const s = readState<OAuthState>(state);
  if (!s || s.e < Date.now()) throw new Error("That sign-in link has expired. Start again from Settings.");
  const m = mailboxFor(s.a);
  if (!m) throw new Error("Not an allowed mailbox");

  const tok = await tokenCall({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const granted = (tok.scope ?? "").split(/\s+/).filter(Boolean);
  const allowed = new Set(scopesFor(m.address));
  const extra = granted.filter((g) => !allowed.has(g));
  if (!granted.includes(READ_SCOPE) || extra.length) {
    await revoke(tok.refresh_token ?? tok.access_token);
    throw new Error(
      extra.length
        ? `Google granted more than read and send (${extra.join(", ")}). Nothing was saved.`
        : "Google did not grant read access. Tick the box to allow reading email and try again.",
    );
  }

  const prof = await gmailFetch(tok.access_token, "profile");
  const signedInAs = String((prof as { emailAddress?: string }).emailAddress ?? "").toLowerCase();
  if (signedInAs !== m.address) {
    await revoke(tok.refresh_token ?? tok.access_token);
    throw new Error(`You signed in as ${signedInAs || "a different account"}. Sign in as ${m.address} instead.`);
  }
  if (!tok.refresh_token) throw new Error("Google did not hand back a lasting sign-in. Try connecting again.");

  const canSend = m.canSend && granted.includes(SEND_SCOPE);
  const values = {
    address: m.address,
    canSend,
    refreshTokenSealed: seal(tok.refresh_token),
    scopes: granted.join(" "),
    lastError: null,
    connectedByProfileId: s.p,
    connectedAt: new Date(),
    updatedAt: new Date(),
  };
  const [existing] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, m.address));
  if (existing) await db.update(schema.mailAccounts).set(values).where(eq(schema.mailAccounts.id, existing.id));
  else await db.insert(schema.mailAccounts).values(values);
  accessCache.set(m.address, { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 3600) - 120) * 1000 });
  return { address: m.address, canSend };
}

export async function disconnect(address: string) {
  const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, address));
  if (!row) return;
  if (row.refreshTokenSealed) {
    try {
      await revoke(unseal(row.refreshTokenSealed));
    } catch {
      /* already gone at Google's end, still clear ours */
    }
  }
  accessCache.delete(address);
  await db
    .update(schema.mailAccounts)
    .set({ refreshTokenSealed: null, scopes: "", canSend: false, lastError: null, updatedAt: new Date() })
    .where(eq(schema.mailAccounts.id, row.id));
}

/* ------------------------------ access tokens ----------------------------- */

const accessCache = new Map<string, { token: string; exp: number }>();

export class MailboxNotConnected extends Error {}

async function accessToken(address: string): Promise<string> {
  const hit = accessCache.get(address);
  if (hit && hit.exp > Date.now()) return hit.token;
  const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, address));
  if (!row?.refreshTokenSealed) throw new MailboxNotConnected(`${address} is not connected`);
  try {
    const tok = await tokenCall({ grant_type: "refresh_token", refresh_token: unseal(row.refreshTokenSealed) });
    accessCache.set(address, { token: tok.access_token, exp: Date.now() + ((tok.expires_in ?? 3600) - 120) * 1000 });
    return tok.access_token;
  } catch (e) {
    if ((e as { code?: string }).code === "invalid_grant") {
      await db
        .update(schema.mailAccounts)
        .set({ refreshTokenSealed: null, lastError: "Google access was removed or expired. Connect it again.", updatedAt: new Date() })
        .where(eq(schema.mailAccounts.id, row.id));
      throw new MailboxNotConnected(`${address} needs connecting again`);
    }
    throw e;
  }
}

async function gmailFetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } }).error?.message ?? `Gmail said ${res.status}`;
    throw new Error(msg);
  }
  return json as Record<string, unknown>;
}

const call = async (address: string, path: string, init?: RequestInit) => gmailFetch(await accessToken(address), path, init);

/* --------------------------------- reading -------------------------------- */

export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
};
export type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  payload?: GmailPart;
};

export async function listMessageIds(address: string, q: string, max = 100) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) p.set("pageToken", pageToken);
    const res = (await call(address, `messages?${p}`)) as { messages?: Array<{ id: string }>; nextPageToken?: string };
    for (const m of res.messages ?? []) ids.push(m.id);
    pageToken = res.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

export async function getMessage(address: string, id: string) {
  return (await call(address, `messages/${id}?format=full`)) as GmailMessage;
}

export async function getAttachment(address: string, messageId: string, attachmentId: string) {
  const res = (await call(address, `messages/${messageId}/attachments/${attachmentId}`)) as { data?: string };
  return Buffer.from(res.data ?? "", "base64url");
}

export function header(msg: GmailMessage, name: string) {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** Every PDF in the message, however deep it is nested. */
export function pdfParts(msg: GmailMessage) {
  const out: GmailPart[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    const isPdf = p.mimeType === "application/pdf" || /\.pdf$/i.test(p.filename ?? "");
    if (isPdf && (p.body?.attachmentId || p.body?.data)) out.push(p);
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  return out;
}

export async function pdfBytes(address: string, msg: GmailMessage, part: GmailPart) {
  if (part.body?.data) return Buffer.from(part.body.data, "base64url");
  return getAttachment(address, msg.id, part.body!.attachmentId!);
}

/** https link that opens the email in Gmail, for whoever is signed in as that mailbox. */
export function gmailLink(address: string, gmailId: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(address)}#all/${gmailId}`;
}

/* --------------------------------- sending -------------------------------- */

export type OutgoingMail = {
  to: string;
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
};

const b64Header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildMime(from: string, mail: OutgoingMail) {
  const to = oneLine(mail.to);
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) throw new Error(`"${to}" is not a single email address`);
  const boundary = `terra_${Math.random().toString(36).slice(2)}`;
  const lines = [
    `From: Terra Flooring <${from}>`,
    `To: ${to}`,
    `Subject: ${b64Header(oneLine(mail.subject))}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(mail.text).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  for (const a of mail.attachments ?? []) {
    const name = oneLine(a.filename).replace(/"/g, "'");
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.contentType ?? "application/pdf"}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      a.content.toString("base64").replace(/.{76}/g, "$&\r\n"),
    );
  }
  lines.push(`--${boundary}--`, "");
  return lines.join("\r\n");
}

/**
 * The one way anything leaves through Gmail. Hard-wired to team@: there is no
 * `from` argument, so no caller can ask for billing@ or damien@.
 */
export async function sendFromTeam(mail: OutgoingMail): Promise<{ id: string }> {
  const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, SEND_FROM));
  if (!row?.refreshTokenSealed || !row.canSend || !row.scopes.split(" ").includes(SEND_SCOPE)) {
    throw new MailboxNotConnected("team@ is not connected for sending");
  }
  const raw = Buffer.from(buildMime(SEND_FROM, mail)).toString("base64url");
  const res = (await call(SEND_FROM, "messages/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw }),
  })) as { id?: string };
  return { id: res.id ?? "" };
}

export async function teamCanSend() {
  const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, SEND_FROM));
  return Boolean(row?.refreshTokenSealed && row.canSend);
}
