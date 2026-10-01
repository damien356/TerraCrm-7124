import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { contactByMobile, ensureForContact, logMessage, openUnassigned } from "./conversations";
import { normaliseMobile } from "./sms";
import { pushToOffice } from "./push";

/* ---------------------------------------------------------------------------
 * TEXTS COMING BACK IN.
 *
 * ClickSend posts every reply to the two-way number here (Messaging Settings,
 * SMS, Inbound Rules, action URL). The URL carries a secret, because ClickSend
 * does not sign its posts:
 *
 *   https://ops.terraflooring.com.au/api/webhooks/clicksend/inbound/<CLICKSEND_INBOUND_SECRET>
 *
 * Where a reply goes, most trusted first:
 *   1. the exact text it answers (ClickSend sends the original message id),
 *   2. the newest text Terra sent that number,
 *   3. the contact with that mobile, on their client-level thread,
 *   4. an Unassigned thread for the office to place by hand.
 *
 * STOP and friends become an SMS opt-out, the same table the marketing side
 * and the Siri late-text both check before sending.
 * ------------------------------------------------------------------------- */

const STOP_WORDS = new Set(["stop", "stop all", "stopall", "unsubscribe", "opt out", "optout", "cancel", "end", "quit"]);

export function inboundSecretOk(given: string | undefined): boolean {
  const want = (process.env.CLICKSEND_INBOUND_SECRET ?? "").trim();
  if (!want || want.length < 16 || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** ClickSend has posted both v2 (`message`, `originalmessageid`) and v3 (`body`, `original_message_id`) shapes. */
export function readInbound(raw: Record<string, unknown>) {
  const s = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string) : raw[k] == null ? "" : String(raw[k]));
  return {
    from: s("from"),
    body: (s("body") || s("message")).trim(),
    messageId: s("message_id") || s("messageid") || null,
    originalMessageId: s("original_message_id") || s("originalmessageid") || null,
  };
}

export const isStop = (body: string) => STOP_WORDS.has(body.trim().toLowerCase().replace(/[.!]+$/, ""));

export async function handleInboundSms(raw: Record<string, unknown>) {
  const msg = readInbound(raw);
  const mobile = normaliseMobile(msg.from) ?? (msg.from.replace(/[^\d+]/g, "") || null);
  if (!mobile || !msg.body) return { stored: false as const, reason: "empty" };

  /* ClickSend retries on a slow answer. The same reply twice is one reply. */
  if (msg.messageId) {
    const [dupe] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.providerId, msg.messageId), eq(schema.messages.direction, "in")))
      .limit(1);
    if (dupe) return { stored: false as const, reason: "duplicate" };
  }

  let original: { conversationId: number | null; jobId: number | null; contactId: number | null } | null = null;
  if (msg.originalMessageId) {
    const [row] = await db
      .select({
        conversationId: schema.messages.conversationId,
        jobId: schema.messages.jobId,
        contactId: schema.messages.contactId,
      })
      .from(schema.messages)
      .where(and(eq(schema.messages.providerId, msg.originalMessageId), eq(schema.messages.channel, "sms")))
      .limit(1);
    original = row ?? null;
  }
  if (!original?.conversationId) {
    const local = mobile.startsWith("+61") ? `0${mobile.slice(3)}` : mobile;
    const [row] = await db
      .select({
        conversationId: schema.messages.conversationId,
        jobId: schema.messages.jobId,
        contactId: schema.messages.contactId,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channel, "sms"),
          eq(schema.messages.direction, "out"),
          or(eq(schema.messages.toAddress, mobile), eq(schema.messages.toAddress, local)),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (row?.conversationId) original = row;
  }

  const contact = original?.contactId
    ? ((await db.select().from(schema.contacts).where(eq(schema.contacts.id, original.contactId)))[0] ?? null)
    : await contactByMobile(mobile);

  let conversationId = original?.conversationId ?? null;
  let jobId = original?.jobId ?? null;
  if (!conversationId) {
    const conv = contact
      ? await ensureForContact(contact.id, `Texts with ${contact.firstName || contact.lastName || mobile}`)
      : await openUnassigned({ subject: `Text from ${mobile}` });
    conversationId = conv.id;
    jobId = conv.jobId ?? null;
  }

  const name = contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() : "";
  const stop = isStop(msg.body);

  await logMessage({
    conversationId,
    jobId,
    contactId: contact?.id ?? null,
    channel: "sms",
    audience: "customer",
    direction: "in",
    body: msg.body,
    authorName: name || mobile,
    fromAddress: mobile,
    providerId: msg.messageId,
  });

  if (stop) {
    const [already] = await db
      .select({ id: schema.unsubscribes.id })
      .from(schema.unsubscribes)
      .where(and(eq(schema.unsubscribes.mobile, mobile), inArray(schema.unsubscribes.channel, ["sms", "all"])))
      .limit(1);
    if (!already) {
      await db.insert(schema.unsubscribes).values({
        mobile,
        contactId: contact?.id ?? null,
        channel: "sms",
        source: "reply_stop",
      });
    }
  }

  await db.insert(schema.activityLog).values({
    jobId,
    contactId: contact?.id ?? null,
    entityType: jobId ? "job" : "contact",
    entityId: jobId ?? contact?.id ?? null,
    action: stop ? "sms_opt_out" : "sms_reply",
    detail: stop ? `${name || mobile} replied STOP and is opted out of texts` : `${name || mobile} texted: ${msg.body.slice(0, 300)}`,
    actorName: name || mobile,
    actorRole: "customer",
  });

  void pushToOffice({
    title: stop ? "Text opt-out" : `Text from ${name || mobile}`,
    body: stop ? `${name || mobile} replied STOP.` : msg.body.slice(0, 140),
    data: jobId ? { kind: "job", jobId } : { kind: "conversation", conversationId },
  });

  return { stored: true as const, conversationId, jobId, optOut: stop };
}
