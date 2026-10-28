import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { readOpenToken, readUnsubscribeToken } from "./marketing";

/* ---------------------------------------------------------------------------
 * The unsubscribe link and the open pixel, behind the plain routes in
 * api/index.ts:
 *
 *   GET  /api/unsubscribe/:token   a small page with one button
 *   POST /api/unsubscribe/:token   the button, and Gmail's one-click unsubscribe
 *   GET  /api/o/:token.gif         the care emails' open pixel
 *
 * The GET does not unsubscribe on its own. Mail scanners (Outlook Safe Links,
 * work spam filters) open every link in an email before the person does, and
 * a GET that unsubscribed would quietly drop people who never asked. One tap
 * on the button does it, and Gmail's own Unsubscribe button posts straight to
 * the same address (RFC 8058), so nobody has to do more than one click.
 *
 * An unsubscribe stops everything at once: every marketing email and text, and
 * the care series. That is what the footer promises.
 * ------------------------------------------------------------------------- */

export type UnsubResult = { ok: true; already: boolean; contactId: number } | { ok: false; reason: string };

export async function unsubscribeContact(token: string, source: "link" | "one_click" = "link"): Promise<UnsubResult> {
  const contactId = readUnsubscribeToken(token);
  if (!contactId) return { ok: false, reason: "That link is not one of ours, or it was cut short." };

  const [contact] = await db
    .select({ id: schema.contacts.id, email: schema.contacts.email, mobile: schema.contacts.mobile })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId));
  /* A deleted contact has nothing left to send to. Still a success to the person. */
  if (!contact) return { ok: true, already: true, contactId };

  const email = (contact.email ?? "").trim().toLowerCase();
  const [had] = await db
    .select({ id: schema.unsubscribes.id })
    .from(schema.unsubscribes)
    .where(and(eq(schema.unsubscribes.contactId, contactId), eq(schema.unsubscribes.channel, "all")))
    .limit(1);

  if (!had) {
    await db.insert(schema.unsubscribes).values({
      contactId,
      email,
      mobile: "",
      channel: "all",
      token: token.slice(0, 200),
      source,
    });
    /* Against the last email they got, so the report can say which one lost them. */
    const [last] = await db
      .select({ id: schema.sends.id })
      .from(schema.sends)
      .where(and(eq(schema.sends.contactId, contactId), eq(schema.sends.channel, "email"), inArray(schema.sends.status, ["sent"])))
      .orderBy(desc(schema.sends.sentAt), desc(schema.sends.id))
      .limit(1);
    if (last) {
      await db.insert(schema.emailEvents).values({ sendId: last.id, type: "unsubscribed", detail: source === "one_click" ? "one-click" : "link" });
    }
  }

  await db
    .update(schema.careMembers)
    .set({ status: "unsubscribed", stopReason: "Unsubscribed from the link in an email", updatedAt: new Date() })
    .where(and(eq(schema.careMembers.contactId, contactId), inArray(schema.careMembers.status, ["active", "stopped"])));

  /* Quote follow-ups stop too. The check before each send would catch it anyway; this shows it on the job at once. */
  await import("./quote-followup")
    .then((m) => m.stopForContact(contactId, "The customer unsubscribed."))
    .catch((e) => console.error("[unsubscribe] quote follow-ups", e));

  return { ok: true, already: !!had, contactId };
}

/** The open pixel was loaded. Marks the care email opened, once. Never throws. */
export async function recordOpen(token: string) {
  try {
    const sendId = readOpenToken(token);
    if (!sendId) return false;
    const [already] = await db
      .select({ id: schema.emailEvents.id })
      .from(schema.emailEvents)
      .where(and(eq(schema.emailEvents.sendId, sendId), eq(schema.emailEvents.type, "opened")))
      .limit(1);
    if (!already) {
      const [send] = await db.select({ id: schema.sends.id }).from(schema.sends).where(eq(schema.sends.id, sendId));
      if (!send) return false;
      await db.insert(schema.emailEvents).values({ sendId, type: "opened" });
    }
    const now = new Date();
    const rows = await db
      .select({ id: schema.careSends.id, openedAt: schema.careSends.openedAt })
      .from(schema.careSends)
      .where(inArray(schema.careSends.id, await careSendIdsFor(sendId)));
    for (const r of rows) {
      if (!r.openedAt) await db.update(schema.careSends).set({ openedAt: now, updatedAt: now }).where(eq(schema.careSends.id, r.id));
    }
    return true;
  } catch (e) {
    console.error("[open pixel]", (e as Error).message ?? e);
    return false;
  }
}

async function careSendIdsFor(sendId: number) {
  const a = await db.select({ id: schema.careSends.id }).from(schema.careSends).where(eq(schema.careSends.sendId, sendId));
  const b = await db.select({ id: schema.careSends.id }).from(schema.careSends).where(eq(schema.careSends.resendSendId, sendId));
  const ids = [...a, ...b].map((r) => r.id);
  return ids.length ? ids : [-1];
}

/** A 1 by 1 transparent GIF. */
export const PIXEL_GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The small page behind the link. Plain, like the emails. */
export function unsubscribePage(state: "ask" | "done" | "bad", message = "") {
  const body =
    state === "ask"
      ? `<p>Tap the button and you won't get any more emails from Terra Flooring.</p>
<form method="post"><button type="submit" style="font:inherit;padding:10px 18px;border:1px solid #222;border-radius:6px;background:#fff;cursor:pointer;">Unsubscribe me</button></form>`
      : state === "done"
        ? `<p>You're unsubscribed. No hard feelings.</p><p>If you ever need us, we're on 1300 183 772.</p>`
        : `<p>${esc(message || "Something went wrong.")}</p><p>Reply to any of our emails with "unsubscribe" and Damien will take you off himself.</p>`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title></head>
<body style="margin:0;background:#fff;"><div style="max-width:480px;padding:32px 20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#222;">
<p style="font-weight:bold;">Terra Flooring</p>${body}</div></body></html>`;
}
