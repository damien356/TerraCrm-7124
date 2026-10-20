import { eq } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import { captureEmail } from "./email-capture";
import { readState, seal, sealConfigured, signState, unseal } from "./secret-box";

/* ---------------------------------------------------------------------------
 * Gmail, read and send only.
 *
 * The rules, fixed here in code and not in a setting:
 *   billing@  read only. Invoices and statements. Never sends.
 *   damien@   read, and sends a job email only when Damien picks himself as
 *             the sender on his own job (spec 15 Oct). Nothing automatic.
 *   team@     read, and every other email Terra sends.
 *
 * Google is asked for gmail.readonly, plus gmail.send for team@ and damien@. Neither
 * scope can delete, move, label or mark anything as read, so Hubdoc and Xero
 * see billing@ exactly as before. No domain-wide delegation: each mailbox is
 * signed in to once, by a person, and can be cut off from Workspace Admin.
 * ------------------------------------------------------------------------- */

export const READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export const SEND_FROM = "team@terraflooring.com.au";
export const DAMIEN_MAILBOX = "damien@terraflooring.com.au";
/** The only two mailboxes anything may ever be sent from. */
export const SENDING_MAILBOXES = [SEND_FROM, DAMIEN_MAILBOX] as const;
export const INVOICES_TO = "billing@terraflooring.com.au";

export const MAILBOXES = [
  { address: "billing@terraflooring.com.au", canSend: false, purpose: "Supplier invoices and statements. Read only." },
  {
    address: "damien@terraflooring.com.au",
    canSend: true,
    purpose: "Catches invoices sent to Damien, files client replies on the job, and sends a job email when Damien picks himself as the sender.",
  },
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
  if (inDemo()) throw new Error("Mailboxes can't be connected in the demo.");
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
  /* The demo never reads or sends real mail, even with a live token cached. */
  if (inDemo()) throw new MailboxNotConnected("Mailboxes are not connected in the demo");
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
  /** Copied in, each one a single address. */
  cc?: string[];
  subject: string;
  text: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
  /** Display name only, e.g. "Damien from Terra". The address is always the mailbox's own. */
  fromName?: string;
  /** Extra hidden headers, e.g. X-Terra-Job. */
  headers?: Record<string, string>;
  /** Threading: the Message-ID being replied to, and the chain before it. */
  inReplyTo?: string;
  references?: string;
  /** Gmail's thread to put it in, from the same mailbox. */
  threadId?: string;
};

export type SentMail = { id: string; threadId: string; messageIdHeader: string };

const b64Header = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

const SINGLE_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
/** Header values are one line of plain ASCII, so nothing can be smuggled in. */
const safeHeader = (s: string) => oneLine(s).replace(/[^\x20-\x7e]/g, "").slice(0, 900);

export function buildMime(from: string, mail: OutgoingMail) {
  const to = oneLine(mail.to);
  if (!SINGLE_ADDRESS.test(to)) throw new Error(`"${to}" is not a single email address`);
  const cc = (mail.cc ?? []).map(oneLine).filter(Boolean);
  for (const c of cc) if (!SINGLE_ADDRESS.test(c)) throw new Error(`"${c}" is not a single email address`);
  const boundary = `terra_${Math.random().toString(36).slice(2)}`;
  const extra: string[] = [];
  if (cc.length) extra.push(`Cc: ${cc.join(", ")}`);
  if (mail.inReplyTo) extra.push(`In-Reply-To: ${safeHeader(mail.inReplyTo)}`);
  if (mail.references) extra.push(`References: ${safeHeader(mail.references)}`);
  for (const [k, v] of Object.entries(mail.headers ?? {})) {
    if (/^X-[A-Za-z0-9-]+$/.test(k)) extra.push(`${k}: ${safeHeader(v)}`);
  }
  const lines = [
    `From: ${b64Header(oneLine(mail.fromName || "Terra Flooring").replace(/[<>"]/g, ""))} <${from}>`,
    `To: ${to}`,
    ...extra,
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

/** Over this the JSON send is refused by Google, so the message goes up as a file instead. */
const JSON_SEND_LIMIT = 4 * 1024 * 1024;

/** Is this mailbox signed in with send permission right now? */
export async function canSendFrom(address: string) {
  if (!(SENDING_MAILBOXES as readonly string[]).includes(address)) return false;
  const [row] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, address));
  return Boolean(row?.refreshTokenSealed && row.canSend && row.scopes.split(" ").includes(SEND_SCOPE));
}

/**
 * The one way anything leaves through Gmail. Only team@ or damien@, checked
 * here, so no caller can ever send as billing@. After it goes, the real
 * Message-ID is read back, because Gmail writes its own and replies quote it.
 */
export async function sendFromMailbox(address: string, mail: OutgoingMail): Promise<SentMail> {
  if (!(SENDING_MAILBOXES as readonly string[]).includes(address)) throw new Error(`${address} may not send`);
  /* Test runs write the email to a folder and send nothing (notes 18.65). */
  const captured = captureEmail({ via: `gmail ${address}`, from: address, to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.text, attachments: mail.attachments });
  if (captured) return { id: `captured-${captured}`, threadId: "", messageIdHeader: "" };
  if (!(await canSendFrom(address))) throw new MailboxNotConnected(`${address.split("@")[0]}@ is not connected for sending`);
  const mime = buildMime(address, mail);
  let res: { id?: string; threadId?: string };
  if (mime.length < JSON_SEND_LIMIT) {
    res = (await call(address, "messages/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url"), ...(mail.threadId ? { threadId: mail.threadId } : {}) }),
    })) as typeof res;
  } else {
    const b = `terra_up_${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${b}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(mail.threadId ? { threadId: mail.threadId } : {}),
      `--${b}`,
      "Content-Type: message/rfc822",
      "",
      mime,
      `--${b}--`,
      "",
    ].join("\r\n");
    const token = await accessToken(address);
    const r = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": `multipart/related; boundary=${b}` },
      body,
    });
    const json = (await r.json().catch(() => ({}))) as typeof res & { error?: { message?: string } };
    if (!r.ok) throw new Error(json.error?.message ?? `Gmail said ${r.status}`);
    res = json;
  }
  const id = res.id ?? "";
  let messageIdHeader = "";
  if (id) {
    try {
      const meta = (await call(address, `messages/${id}?format=metadata&metadataHeaders=Message-ID`)) as GmailMessage;
      messageIdHeader = header(meta, "Message-ID");
    } catch {
      /* Sent is sent. Without the id a reply still matches on the thread or the tag. */
    }
  }
  return { id, threadId: res.threadId ?? "", messageIdHeader };
}

/** Kept for the callers that only ever send as team@. */
export async function sendFromTeam(mail: OutgoingMail): Promise<SentMail> {
  return sendFromMailbox(SEND_FROM, mail);
}

export async function teamCanSend() {
  return canSendFrom(SEND_FROM);
}
