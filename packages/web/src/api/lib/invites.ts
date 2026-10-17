import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { db } from "../database";
import * as schema from "../database/schema";
import { normaliseRole } from "../middleware/auth";
import { emailConfigured, sendEmail } from "./email";
import { OPS_URL } from "./notify";
import { normaliseMobile, sendSms, smsConfigured } from "./sms";

/* ---------------------------------------------------------------------------
 * Staff invites (notes 18.55). Admin sends one by text or email. It carries
 * the download page (/app) and a one-time set-up link (/setup/<token>) where
 * the person picks their own password. Nobody in the office ever sees it.
 *
 *   48 hours, one use. A newer invite replaces every older one for that person.
 *   Only the sha256 of the link is stored.
 *   A switched-off person can't be invited and can't use an old link.
 * ------------------------------------------------------------------------- */

export const INVITE_HOURS = 48;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;
export const OFFICE_PHONE = "1300 183 772";
export const APP_LINK_IOS_KEY = "app_link_ios";
export const APP_LINK_ANDROID_KEY = "app_link_android";

export type InviteChannel = "sms" | "email";
export type InviteState = "waiting" | "set_up" | "expired" | "replaced" | "failed";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
export const downloadUrl = () => `${OPS_URL}/app`;
export const setupUrl = (token: string) => `${OPS_URL}/setup/${token}`;
const firstName = (name: string, email: string) => (name.trim().split(/\s+/)[0] || email.split("@")[0] || "there").trim();

/** The text, word for word as Damien wrote it. */
export function inviteSmsText(a: { firstName: string; email: string; token: string }) {
  return (
    `Hi ${a.firstName}, welcome to Terra Flooring. Download the Terra app here: ${downloadUrl()}. ` +
    `Then set up your login here: ${setupUrl(a.token)}. Your username is ${a.email}. ` +
    `Any questions, call the office on ${OFFICE_PHONE}.`
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The same words by email, for people who'd rather have it there. */
export function inviteEmail(a: { firstName: string; email: string; token: string }) {
  const subject = "Welcome to Terra Flooring: set up your login";
  const text =
    `Hi ${a.firstName},\n\n` +
    `Welcome to Terra Flooring.\n\n` +
    `Download the Terra app here: ${downloadUrl()}\n\n` +
    `Then set up your login here: ${setupUrl(a.token)}\n` +
    `This link works once and runs out after ${INVITE_HOURS} hours.\n\n` +
    `Your username is ${a.email}.\n\n` +
    `Any questions, call the office on ${OFFICE_PHONE}.\n\n` +
    `Terra Flooring`;
  const link = (href: string) => `<a href="${esc(href)}" style="color:#8a6a2f;">${esc(href)}</a>`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f5f4f2;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f1d1b;">
  <div style="font-size:20px;font-weight:600;padding-bottom:20px;">Terra Flooring</div>
  <p>Hi ${esc(a.firstName)},</p>
  <p>Welcome to Terra Flooring.</p>
  <p>Download the Terra app here: ${link(downloadUrl())}</p>
  <p>Then set up your login here: ${link(setupUrl(a.token))}<br><span style="font-size:13px;color:#6b655f;">This link works once and runs out after ${INVITE_HOURS} hours.</span></p>
  <p>Your username is <strong>${esc(a.email)}</strong>.</p>
  <p>Any questions, call the office on ${OFFICE_PHONE}.</p>
  <p style="margin-top:28px;">Terra Flooring</p>
</div>
</body></html>`;
  return { subject, text, html };
}

/* ------------------------------ App links -------------------------------- */

export class InviteError extends Error {}

async function readSettings(keys: string[]) {
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, keys));
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function appLinks() {
  const v = await readSettings([APP_LINK_IOS_KEY, APP_LINK_ANDROID_KEY]);
  return { ios: (v.get(APP_LINK_IOS_KEY) ?? "").trim(), android: (v.get(APP_LINK_ANDROID_KEY) ?? "").trim() };
}

export function cleanLink(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new InviteError("That link does not look right. It should start with https://");
  }
  if (u.protocol !== "https:") throw new InviteError("The link must start with https://");
  return u.toString();
}

export async function saveAppLinks(links: { ios: string; android: string }) {
  const ios = cleanLink(links.ios);
  const android = cleanLink(links.android);
  const now = new Date();
  for (const [key, value] of [
    [APP_LINK_IOS_KEY, ios],
    [APP_LINK_ANDROID_KEY, android],
  ] as const) {
    await db
      .insert(schema.settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
  }
  return { ios, android };
}

/* ------------------------------ Sending ---------------------------------- */

async function loadPerson(profileId: number) {
  const [row] = await db
    .select({ profile: schema.profiles, email: schema.user.email, userName: schema.user.name })
    .from(schema.profiles)
    .innerJoin(schema.user, eq(schema.user.id, schema.profiles.userId))
    .where(eq(schema.profiles.id, profileId));
  return row ?? null;
}

/**
 * Make a fresh link and send it. Older links for this person stop working
 * once the new one has gone. A send that fails is logged, and its link is
 * dead from the start, so the older one they may still hold keeps working.
 */
export async function sendInvite(profileId: number, channel: InviteChannel, byName: string) {
  const person = await loadPerson(profileId);
  if (!person) throw new InviteError("Person not found.");
  if (!person.profile.active) throw new InviteError("This login is switched off. Switch it on before sending an invite.");
  const email = person.email.trim().toLowerCase();
  const name = person.profile.name || person.userName || "";
  const first = firstName(name, email);

  let to = "";
  if (channel === "sms") {
    const mobile = normaliseMobile(person.profile.phone);
    if (!mobile) throw new InviteError("There is no Australian mobile on this person. Add one with Edit name, mobile, email.");
    if (!smsConfigured()) throw new InviteError("Texting is not set up, so the invite cannot be texted.");
    to = mobile;
  } else {
    if (!email) throw new InviteError("There is no email on this person.");
    if (!emailConfigured()) throw new InviteError("Email is not set up, so the invite cannot be emailed.");
    to = email;
  }

  const token = newToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3_600_000);
  const [row] = await db
    .insert(schema.invites)
    .values({
      profileId,
      userId: person.profile.userId,
      tokenHash: hashToken(token),
      channel,
      sentTo: channel === "sms" ? (person.profile.phone ?? to).trim() : to,
      status: "sending",
      sentByName: byName,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: schema.invites.id });
  const inviteId = row!.id;

  let ok = false;
  let reason = "";
  try {
    if (channel === "sms") {
      const sent = await sendSms({ to, body: inviteSmsText({ firstName: first, email, token }), sender: "auto" });
      ok = sent.ok;
      if (!sent.ok) reason = sent.reason;
    } else {
      const mail = inviteEmail({ firstName: first, email, token });
      const sent = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
      ok = sent.ok;
      if (!sent.ok) reason = sent.reason;
    }
  } catch (e) {
    reason = (e as Error).message ?? String(e);
  }

  const done = new Date();
  if (ok) {
    await db.batch([
      db.update(schema.invites).set({ status: "sent", updatedAt: done }).where(eq(schema.invites.id, inviteId)),
      db
        .update(schema.invites)
        .set({ voidedAt: done, updatedAt: done })
        .where(and(eq(schema.invites.profileId, profileId), ne(schema.invites.id, inviteId), isNull(schema.invites.usedAt), isNull(schema.invites.voidedAt))),
    ]);
    return { ok: true as const, inviteId, channel, to, expiresAt: expiresAt.toISOString() };
  }
  await db
    .update(schema.invites)
    .set({ status: "failed", detail: reason.slice(0, 500) || "Not sent", voidedAt: done, updatedAt: done })
    .where(eq(schema.invites.id, inviteId));
  return { ok: false as const, inviteId, channel, to, reason: reason || "Not sent" };
}

/* ------------------------------ The log ---------------------------------- */

export function inviteState(r: { status: string; usedAt: Date | null; voidedAt: Date | null; expiresAt: Date }, now = new Date()): InviteState {
  if (r.status === "failed") return "failed";
  if (r.usedAt) return "set_up";
  if (r.voidedAt) return "replaced";
  if (r.expiresAt.getTime() <= now.getTime()) return "expired";
  return "waiting";
}

/** Every invite for these people, newest first, with what became of it. */
export async function inviteLog(profileIds: number[]) {
  if (!profileIds.length) return new Map<number, ReturnType<typeof shape>[]>();
  const rows = await db
    .select()
    .from(schema.invites)
    .where(inArray(schema.invites.profileId, profileIds))
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));
  const now = new Date();
  const out = new Map<number, ReturnType<typeof shape>[]>();
  for (const r of rows) {
    const list = out.get(r.profileId) ?? [];
    list.push(shape(r, now));
    out.set(r.profileId, list);
  }
  return out;
}

function shape(r: typeof schema.invites.$inferSelect, now: Date) {
  return {
    id: r.id,
    channel: r.channel as InviteChannel,
    sentTo: r.sentTo,
    sentAt: r.createdAt.toISOString(),
    sentByName: r.sentByName,
    expiresAt: r.expiresAt.toISOString(),
    usedAt: r.usedAt ? r.usedAt.toISOString() : null,
    state: inviteState(r, now),
    detail: r.detail,
  };
}

/** Which of these logins have a password at all. */
export async function hasPasswordFor(userIds: string[]) {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .select({ userId: schema.account.userId })
    .from(schema.account)
    .where(and(inArray(schema.account.userId, userIds), eq(schema.account.providerId, "credential")));
  return new Set(rows.map((r) => r.userId));
}

/* ------------------------------ The set-up page -------------------------- */

export type LinkCheck =
  | { state: "ok"; firstName: string; email: string; expiresAt: string }
  | { state: "used" | "expired" | "replaced" | "invalid" | "off" };

async function findByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null;
  const [row] = await db.select().from(schema.invites).where(eq(schema.invites.tokenHash, hashToken(token)));
  return row ?? null;
}

export async function checkLink(token: string, now = new Date()): Promise<LinkCheck> {
  const inv = await findByToken(token);
  if (!inv || inv.status !== "sent") return { state: "invalid" };
  if (inv.usedAt) return { state: "used" };
  if (inv.voidedAt) return { state: "replaced" };
  if (inv.expiresAt.getTime() <= now.getTime()) return { state: "expired" };
  const person = await loadPerson(inv.profileId);
  if (!person || person.profile.userId !== inv.userId) return { state: "invalid" };
  if (!person.profile.active) return { state: "off" };
  const email = person.email.trim().toLowerCase();
  return { state: "ok", firstName: firstName(person.profile.name || person.userName || "", email), email, expiresAt: inv.expiresAt.toISOString() };
}

const LINK_WORDS: Record<Exclude<LinkCheck["state"], "ok">, string> = {
  used: "This link has already been used. Sign in with the password you chose, or call the office on 1300 183 772 for a new invite.",
  expired: "This link has run out. Links last 48 hours. Call the office on 1300 183 772 and they'll send you a new one.",
  replaced: "A newer invite was sent, so this link no longer works. Use the link in the latest text or email.",
  invalid: "This link is not valid. Call the office on 1300 183 772 and they'll send you a new one.",
  off: "This login is switched off. Call the office on 1300 183 772.",
};
export const linkWords = (s: Exclude<LinkCheck["state"], "ok">) => LINK_WORDS[s];

/** Password rules, the same for the set-up link and an Admin setting one. */
export function passwordProblem(password: string) {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD) return `Use ${MAX_PASSWORD} characters or fewer.`;
  return null;
}

/** Store a new password on a login, replacing any old one. */
async function writePassword(userId: string, password: string, now: Date) {
  const hash = await hashPassword(password);
  const [existing] = await db
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, "credential")));
  if (existing) {
    await db.update(schema.account).set({ password: hash, updatedAt: now }).where(eq(schema.account.id, existing.id));
  } else {
    await db.insert(schema.account).values({
      id: randomUUID().replace(/-/g, ""),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hash,
      createdAt: now,
      updatedAt: now,
    });
  }
  await db.update(schema.user).set({ emailVerified: true, updatedAt: now }).where(eq(schema.user.id, userId));
}

/**
 * An Admin sets a password on a login (Damien 17 Oct, notes 18.58). For the
 * store reviewer login, and for crew who can't get an invite through. The
 * Admin types it, so they know it: the invite link is still the normal way.
 * Phones already signed in stay signed in, the same as the set-up link.
 * The password itself is never logged, only that it was set and by whom.
 */
export async function adminSetPassword(
  userId: string,
  password: string,
  who: { actorName: string; label: string; profileId: number | null },
  now = new Date(),
) {
  const problem = passwordProblem(password);
  if (problem) throw new InviteError(problem);
  const [u] = await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.id, userId));
  if (!u) throw new InviteError("That login no longer exists.");
  await writePassword(userId, password, now);
  await db.insert(schema.activityLog).values({
    entityType: "profile",
    entityId: who.profileId,
    action: "password_set",
    detail: `Password set for ${who.label} by ${who.actorName}`,
    actorName: who.actorName,
    actorRole: "admin",
  });
}

/**
 * Set the password from the link. The link is claimed first, in one write
 * that only succeeds while it is still good, so two taps can't both use it.
 * An existing password is replaced. Sessions already signed in stay signed in.
 */
export async function setupLogin(token: string, password: string, now = new Date()) {
  const problem = passwordProblem(password);
  if (problem) throw new InviteError(problem);
  const check = await checkLink(token, now);
  if (check.state !== "ok") throw new InviteError(linkWords(check.state));
  const inv = (await findByToken(token))!;

  const claimed = await db
    .update(schema.invites)
    .set({ usedAt: now, updatedAt: now })
    .where(and(eq(schema.invites.id, inv.id), isNull(schema.invites.usedAt), isNull(schema.invites.voidedAt), gt(schema.invites.expiresAt, now)))
    .returning({ id: schema.invites.id });
  if (!claimed.length) throw new InviteError(linkWords("used"));

  try {
    await writePassword(inv.userId, password, now);
  } catch (e) {
    await db.update(schema.invites).set({ usedAt: null, updatedAt: new Date() }).where(eq(schema.invites.id, inv.id));
    throw e;
  }
  /* Any other link still out there for this person stops working. */
  await db
    .update(schema.invites)
    .set({ voidedAt: now, updatedAt: now })
    .where(and(eq(schema.invites.profileId, inv.profileId), ne(schema.invites.id, inv.id), isNull(schema.invites.usedAt), isNull(schema.invites.voidedAt)));

  const person = await loadPerson(inv.profileId);
  return { email: check.email, role: normaliseRole(person?.profile.role) };
}
