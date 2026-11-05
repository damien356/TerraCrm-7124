import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { emailConfigured, sendEmail } from "../email";
import { NOTIFY_FROM, NOTIFY_SUBJECT_TAG, type AlertKind } from "../notify-kinds";
import { OPS_URL } from "../notify";
import { sendPush } from "../push";
import type { Channel, PhoneConfig } from "./config";
import { personOf, queueWatchers } from "./routing";

/* ---------------------------------------------------------------------------
 * Telling one person about phone work (Retell, 5 Nov).
 *
 * Uses the channels Terra Ops already has: the in-app alert (Dashboard bell),
 * push to the person's own phones, and email from the fixed office sender.
 * Every attempt is written to phone_notifications with what happened, so a
 * push to someone with no phone or an email that bounced is visible on the
 * follow-up, not lost.
 *
 * Previews are short: who, what kind, and a link. No transcript, no address,
 * no amounts leave in a push or an email. The link needs a sign-in.
 *
 * Fallback: when the owner was reached on no channel at all, everyone who
 * watches the queue gets the push instead, and that is recorded too.
 * ------------------------------------------------------------------------- */

export type NotifyReason = "outcome" | "new_owner" | "reminder" | "escalation" | "urgent" | "fallback" | "failure";

export type PhoneNotice = {
  kind: AlertKind;
  reason: NotifyReason;
  title: string;
  /** One short line. Kept brief on purpose. */
  body: string;
  path: string;
  callId?: number | null;
  followupId?: number | null;
  jobId?: number | null;
  urgent?: boolean;
};

type Attempt = { profileId: number | null; channel: Channel; status: "sent" | "failed" | "no_device" | "not_connected" | "skipped"; detail: string };

async function record(n: PhoneNotice, a: Attempt, alertId: number | null) {
  await db.insert(schema.phoneNotifications).values({
    callId: n.callId ?? null,
    followupId: n.followupId ?? null,
    profileId: a.profileId,
    reason: n.reason,
    channel: a.channel,
    status: a.status,
    detail: a.detail.slice(0, 500),
    alertId,
  });
}

async function devicesOf(userId: string) {
  const rows = await db
    .select({ id: schema.deviceTokens.id })
    .from(schema.deviceTokens)
    .where(and(eq(schema.deviceTokens.userId, userId), eq(schema.deviceTokens.active, true)));
  return rows.length;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The in-app alert: one row per event, shown on the Dashboard and the phone page. */
async function alertRow(n: PhoneNotice) {
  const data = { kind: "phone", path: n.path, callId: n.callId ?? null, followupId: n.followupId ?? null };
  const [row] = await db
    .insert(schema.alerts)
    .values({ kind: n.kind, title: n.title.slice(0, 300), body: n.body.slice(0, 600), jobId: n.jobId ?? null, data: JSON.stringify(data) })
    .returning({ id: schema.alerts.id });
  return row?.id ?? null;
}

async function pushOne(profileId: number, n: PhoneNotice, alertId: number | null): Promise<Attempt> {
  const p = await personOf(profileId);
  if (!p) return { profileId, channel: "push", status: "failed", detail: "Person not found" };
  const devices = await devicesOf(p.userId);
  if (!devices) return { profileId, channel: "push", status: "no_device", detail: `${p.name} has no phone signed in to Terra Ops` };
  const n2 = await sendPush([p.userId], { title: n.title, body: n.body, data: { kind: "phone", path: n.path, alertId, followupId: n.followupId ?? null } });
  return n2 > 0
    ? { profileId, channel: "push", status: "sent", detail: `${n2} device${n2 === 1 ? "" : "s"} accepted it` }
    : { profileId, channel: "push", status: "failed", detail: "No device accepted the push" };
}

async function emailOne(profileId: number, n: PhoneNotice): Promise<Attempt> {
  if (!emailConfigured()) return { profileId, channel: "email", status: "not_connected", detail: "Email sending is not connected (RESEND_API_KEY)" };
  const p = await personOf(profileId);
  if (!p?.email) return { profileId, channel: "email", status: "failed", detail: "No email on their login" };
  const url = `${OPS_URL}${n.path}`;
  const out = await sendEmail({
    to: p.email,
    from: NOTIFY_FROM,
    subject: `${NOTIFY_SUBJECT_TAG} ${n.title}`.slice(0, 200),
    text: `${n.body}\n\nOpen it in Terra Ops (sign-in needed):\n${url}`,
    html: `<p style="margin:0 0 12px;">${esc(n.body)}</p><p>Open it in Terra Ops (sign-in needed):<br><a href="${esc(url)}">${esc(url)}</a></p>`,
  });
  return out.ok ? { profileId, channel: "email", status: "sent", detail: "Handed to the mail service" } : { profileId, channel: "email", status: "failed", detail: out.reason };
}

/**
 * Tell one person (or the queue, when `profileId` is null) on the channels
 * asked for. Urgent always adds push and email. Never throws.
 */
export async function notifyPhone(cfg: PhoneConfig, profileId: number | null, n: PhoneNotice, channels: Channel[]) {
  const out = { alertId: null as number | null, reached: false, attempts: [] as Attempt[] };
  try {
    const want = new Set<Channel>(channels);
    want.add("in_app");
    if (n.urgent) {
      want.add("push");
      want.add("email");
    }
    out.alertId = await alertRow(n);
    const inApp: Attempt = { profileId, channel: "in_app", status: "sent", detail: "On the Dashboard and the phone calls page" };
    out.attempts.push(inApp);
    await record(n, inApp, out.alertId);

    const targets = profileId ? [profileId] : await queueWatchers(cfg);
    let reachedOff = false;
    for (const id of targets) {
      if (want.has("push")) {
        const a = await pushOne(id, n, out.alertId);
        out.attempts.push(a);
        await record(n, a, out.alertId);
        if (a.status === "sent") reachedOff = true;
      }
      if (want.has("email")) {
        const a = await emailOne(id, n);
        out.attempts.push(a);
        await record(n, a, out.alertId);
        if (a.status === "sent") reachedOff = true;
      }
    }
    out.reached = reachedOff || (!want.has("push") && !want.has("email"));

    // Nobody got it off-screen when they should have: the queue's people get the push.
    if (!out.reached && profileId) {
      const watchers = (await queueWatchers(cfg)).filter((x) => x !== profileId);
      const fb: PhoneNotice = { ...n, reason: "fallback", title: `Not delivered to owner: ${n.title}`.slice(0, 200) };
      for (const id of watchers) {
        const a = await pushOne(id, fb, out.alertId);
        out.attempts.push(a);
        await record(fb, a, out.alertId);
        if (a.status === "sent") out.reached = true;
      }
      if (!watchers.length) {
        const a: Attempt = { profileId: null, channel: "push", status: "skipped", detail: "No one else watches the queue to fall back to" };
        out.attempts.push(a);
        await record(fb, a, out.alertId);
      }
    }
    if (out.alertId) {
      const pushed = out.attempts.filter((a) => a.channel === "push" && a.status === "sent").length;
      const emailed = out.attempts.some((a) => a.channel === "email" && a.status === "sent");
      await db
        .update(schema.alerts)
        .set({ pushed, emailedAt: emailed ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.alerts.id, out.alertId));
    }
  } catch (e) {
    console.error("[phone] notify failed:", (e as Error).message ?? e);
  }
  return out;
}

/** Per person, which channels can reach them right now. For the settings screen. */
export async function channelStatus(profileIds: number[]) {
  if (!profileIds.length) return [];
  const people = await db.select().from(schema.profiles).where(inArray(schema.profiles.id, profileIds));
  const out = [];
  for (const p of people) {
    out.push({
      profileId: p.id,
      name: p.name || p.email,
      push: (await devicesOf(p.userId)) > 0 ? "connected" : "no phone signed in",
      email: !emailConfigured() ? "email not connected" : p.email ? "connected" : "no email on login",
    });
  }
  return out;
}
