import { ORPCError } from "@orpc/server";
import { and, desc, eq, gte, inArray, isNull, like, ne, or } from "drizzle-orm";
import { db, inDemo } from "../database";
import * as schema from "../database/schema";
import { addParticipant, contactByMobile, ensureForQuote, logMessage } from "./conversations";
import { leadToQuotedOnSend } from "./job-stage";
import type { MailUpload } from "./job-mail";
import { syncJobValue } from "./job-value";
import { notifyOffice } from "./notify";
import { EMAIL_RE, quoteRecipients, sendQuoteEmail } from "./quote-email";
import { onQuoteSent } from "./quote-followup";
import { linkForQuote, quoteUrl } from "./quote-links";
import { quoteRefOf } from "./quote-number";
import { quoteSmsText, showMobile } from "./quote-sms-text";
import { normaliseMobile, sendSms, smsConfigured } from "./sms";

/* ---------------------------------------------------------------------------
 * A quote going out by email and by text (Damien, 30 Oct, after 188048).
 *
 *   - The email goes first, exactly as before. The text goes second, so it
 *     only says "we've also emailed it" when Gmail actually took the email.
 *   - Each channel has its own result on a quote_sends row. One failing never
 *     stops the other, and only the failed one can be tried again.
 *   - The Send screen makes a send key when it opens. A double click or a
 *     retried request carries the same key and gets the first result back.
 *   - A STOP reply or an unsubscribe blocks the text. Nothing here ever texts
 *     a quote nobody pressed Send on: there is no bulk or catch-up path.
 *
 * "sent" means the provider accepted it. Neither Gmail nor ClickSend tells us
 * it reached the inbox or the phone, and nothing here says it did.
 * ------------------------------------------------------------------------- */

type Quote = typeof schema.quotes.$inferSelect;
type SendRow = typeof schema.quoteSends.$inferSelect;
type Who = { name: string; role: string; profileId: number | null };

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const firstOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "";
const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();

/* ------------------------------ opt-outs --------------------------------- */

const auDay = (d: Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" }) : "";

/** Why this person must not get a text, or null. A STOP reply and an unsubscribe both count. */
export async function smsBlockFor(contactId: number | null, mobile: string | null): Promise<string | null> {
  const rows = await db
    .select()
    .from(schema.unsubscribes)
    .where(
      and(
        inArray(schema.unsubscribes.channel, ["sms", "all"]),
        or(contactId ? eq(schema.unsubscribes.contactId, contactId) : undefined, ne(schema.unsubscribes.mobile, "")),
      ),
    );
  const hit = rows.find((r) => (contactId && r.contactId === contactId) || (mobile && normaliseMobile(r.mobile) === mobile));
  if (!hit) return null;
  return hit.channel === "sms"
    ? `They replied STOP to our texts${hit.createdAt ? ` on ${auDay(hit.createdAt)}` : ""}.`
    : `They unsubscribed from Terra messages${hit.createdAt ? ` on ${auDay(hit.createdAt)}` : ""}.`;
}

/** Things the office should know before texting, that do not block it on their own. */
async function smsWarnFor(contactId: number | null) {
  if (!contactId) return null;
  const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId));
  if (!c) return null;
  if (!c.active) return "This contact is marked inactive.";
  if (c.doNotMarket) return `Marked do not contact for marketing${c.doNotMarketReason ? ` (${c.doNotMarketReason})` : ""}.`;
  return null;
}

/** An unsubscribe from marketing email. The quote email still goes, because they asked for the quote. */
async function emailWarnFor(contactId: number | null, email: string) {
  const e = email.trim().toLowerCase();
  const rows = await db
    .select()
    .from(schema.unsubscribes)
    .where(and(inArray(schema.unsubscribes.channel, ["email", "all"]), or(contactId ? eq(schema.unsubscribes.contactId, contactId) : undefined, eq(schema.unsubscribes.email, e))));
  return rows.length ? `They unsubscribed from Terra marketing email${rows[0]!.createdAt ? ` on ${auDay(rows[0]!.createdAt)}` : ""}. The quote email still goes, as they asked for the quote.` : null;
}

/* --------------------------- who and which ------------------------------- */

/** Which of the client's quotes this is, when they have more than one out (188048 had four). */
export async function quoteOptionOf(quote: Quote) {
  const rows = await db
    .select()
    .from(schema.quotes)
    .where(quote.jobId ? eq(schema.quotes.jobId, quote.jobId) : eq(schema.quotes.number, quote.number));
  const out = rows
    .filter((r) => r.id === quote.id || r.status === "sent")
    .sort((a, b) => a.number - b.number || a.version - b.version);
  const list = [];
  for (const r of out) list.push({ id: r.id, ref: await quoteRefOf(r), total: r.total, status: r.status, isThis: r.id === quote.id });
  const at = list.findIndex((r) => r.isThis);
  return { list, option: list.length > 1 && at >= 0 ? { n: at + 1, of: list.length, ref: list[at]!.ref } : null };
}

/** The Send screen's text half: each person's mobile, whether a text may go, and the words around the link. */
export async function quoteSmsDraft(quote: Quote, resend: boolean) {
  const recipients = await quoteRecipients(quote);
  const ids = [...new Set([...recipients.map((r) => r.contactId), quote.contactId].filter((v): v is number => !!v))];
  const people = ids.length ? await db.select().from(schema.contacts).where(inArray(schema.contacts.id, ids)) : [];
  const forPerson = async (contactId: number | null, name: string) => {
    const c = people.find((p) => p.id === contactId);
    const mobile = normaliseMobile(c?.mobile?.trim() || c?.phone?.trim() || null);
    return {
      contactId,
      name: name || fullName(c),
      firstName: firstOf(c?.firstName || name),
      mobile: mobile ?? "",
      mobileShown: mobile ? showMobile(mobile) : (c?.mobile ?? "").trim(),
      blocked: await smsBlockFor(contactId, mobile),
      warn: await smsWarnFor(contactId),
    };
  };
  const byEmail: Record<string, Awaited<ReturnType<typeof forPerson>>> = {};
  for (const r of recipients) byEmail[r.email.toLowerCase()] = await forPerson(r.contactId, r.name);
  const fallback = quote.contactId ? await forPerson(quote.contactId, "") : null;
  const emailWarn: Record<string, string> = {};
  for (const r of recipients) {
    const w = await emailWarnFor(r.contactId, r.email);
    if (w) emailWarn[r.email.toLowerCase()] = w;
  }
  const [job] = quote.jobId ? await db.select({ title: schema.jobs.title }).from(schema.jobs).where(eq(schema.jobs.id, quote.jobId)) : [];
  const { list, option } = await quoteOptionOf(quote);
  return {
    /** Off for a wording re-send, on for every normal send. */
    defaultOn: !resend,
    ready: smsConfigured() || inDemo(),
    byEmail,
    fallback,
    emailWarn,
    description: (job?.title ?? "").trim(),
    option,
    others: list,
  };
}

/* ------------------------------ the send --------------------------------- */

export type EmailPart = { to: string; subject: string; body: string; cc?: string[]; mediaIds?: number[]; uploads?: MailUpload[] };
export type SmsPart = { to: string; firstName: string; description: string; showOption: boolean; contactId?: number | null };

/** What the screen and the quote card show for one send. */
export function sendSummary(r: SendRow) {
  return {
    id: r.id,
    quoteId: r.quoteId,
    kind: r.kind,
    byName: r.byName,
    createdAt: r.createdAt,
    email: { status: r.emailStatus, to: r.emailTo, detail: r.emailDetail, at: r.emailAt },
    sms: { status: r.smsStatus, to: r.smsTo, toShown: showMobile(r.smsTo), detail: r.smsDetail, at: r.smsAt },
  };
}
export type SendSummary = ReturnType<typeof sendSummary>;

async function setRow(id: number, patch: Partial<SendRow>) {
  const [row] = await db
    .update(schema.quoteSends)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.quoteSends.id, id))
    .returning();
  return row!;
}

export async function sendByKey(sendKey: string) {
  const [row] = await db.select().from(schema.quoteSends).where(eq(schema.quoteSends.sendKey, sendKey));
  return row ?? null;
}

/** A second press while the first is still going: wait for the first to finish (up to 30s) and hand back what it did. */
export async function sendByKeySettled(sendKey: string) {
  let row = await sendByKey(sendKey);
  for (let i = 0; i < 60 && row && (row.emailStatus === "sending" || row.smsStatus === "sending"); i++) {
    await new Promise((r) => setTimeout(r, 500));
    row = await sendByKey(sendKey);
  }
  return row;
}

/**
 * Claim the key. Null when this key has been pressed already, so the caller
 * hands back what that press did instead of sending again.
 */
export async function claimSend(args: { quote: Quote; sendKey: string; kind: "first" | "resend"; byName: string }) {
  const [row] = await db
    .insert(schema.quoteSends)
    .values({
      quoteId: args.quote.id,
      sendKey: args.sendKey,
      quoteTotal: args.quote.total,
      kind: args.kind,
      byName: args.byName,
      emailStatus: "sending",
      smsStatus: "sending",
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** A check before sending failed (deposit, copied lines): the key can be used again once fixed. */
export async function releaseSend(id: number) {
  /* Only a row where nothing has gone or is going. A row with a sent or sending channel is never removed. */
  await db
    .delete(schema.quoteSends)
    .where(and(eq(schema.quoteSends.id, id), inArray(schema.quoteSends.emailStatus, ["sending", "skipped"]), inArray(schema.quoteSends.smsStatus, ["sending", "skipped", "blocked"]), isNull(schema.quoteSends.emailMessageId), isNull(schema.quoteSends.smsMessageId)));
}

/** The email half. Never throws: a failure is recorded on the row and the thread. */
async function doEmail(row: SendRow, quote: Quote, e: EmailPart, who: Who) {
  const to = e.to.trim();
  try {
    const out = await sendQuoteEmail({
      quote,
      to,
      subject: e.subject,
      body: e.body,
      cc: e.cc,
      mediaIds: e.mediaIds,
      uploads: e.uploads,
      byName: who.name,
      byProfileId: who.profileId,
    });
    const r = await setRow(row.id, { emailStatus: "sent", emailDetail: out.via === "relay" ? "Sent through the backup mailer, team@ is not connected." : null, emailMessageId: out.messageId, emailAt: new Date() });
    return { row: r, out };
  } catch (err) {
    const detail = errText(err);
    /* Logged on the thread as failed, so Conversations shows it too. sendJobEmail logs only what went. */
    let messageId: number | null = null;
    try {
      const conv = await ensureForQuote(quote.id);
      const msg = await logMessage({
        conversationId: conv.id,
        jobId: quote.jobId,
        contactId: quote.contactId,
        channel: "email",
        audience: "customer",
        direction: "out",
        subject: e.subject,
        body: e.body,
        authorName: who.name,
        authorProfileId: who.profileId,
        toAddress: to,
        label: `Quote ${await quoteRefOf(quote)}`,
        status: "failed",
        statusDetail: detail,
        failedAt: new Date(),
      });
      messageId = msg.id;
    } catch (logErr) {
      console.error("[quote-send] failed email not logged", errText(logErr));
    }
    const r = await setRow(row.id, { emailStatus: "failed", emailDetail: detail, emailMessageId: messageId, emailAt: new Date() });
    return { row: r, out: null };
  }
}

/** The text half. The "also emailed" line only goes in when the email went. Never throws. */
async function doSms(row: SendRow, quote: Quote, s: SmsPart & { mobile: string; contactId: number | null }, emailed: boolean, who: Who) {
  const ref = await quoteRefOf(quote);
  const link = await linkForQuote(quote.id);
  const { option } = s.showOption ? await quoteOptionOf(quote) : { option: null };
  const text = quoteSmsText({ firstName: s.firstName, description: s.description, url: quoteUrl(link.token), emailed, option, resend: row.kind === "resend" });
  let out: Awaited<ReturnType<typeof sendSms>>;
  try {
    out = await sendSms({ to: s.mobile, body: text, sender: "number", needsReply: true });
  } catch (err) {
    out = { ok: false, deferred: true, reason: errText(err) };
  }
  /* Whatever happens logging it, the row must say what ClickSend said, or a retry could text twice. */
  let messageId: number | null = null;
  try {
    messageId = await logSms(quote, s, text, ref, out, who);
  } catch (logErr) {
    console.error("[quote-send] text not logged", errText(logErr));
  }
  return setRow(row.id, {
    smsStatus: out.ok ? "sent" : "failed",
    smsDetail: out.ok ? (out.providerId === "demo-not-sent" ? "Demo: not really sent." : null) : out.reason,
    smsMessageId: messageId,
    smsProviderId: out.ok ? out.providerId : null,
    smsAt: new Date(),
  });
}

async function logSms(quote: Quote, s: { mobile: string; contactId: number | null }, text: string, ref: string, out: Awaited<ReturnType<typeof sendSms>>, who: Who) {
  const conv = await ensureForQuote(quote.id);
  const msg = await logMessage({
    conversationId: conv.id,
    jobId: quote.jobId,
    contactId: s.contactId,
    channel: "sms",
    audience: "customer",
    direction: "out",
    body: text,
    authorName: who.name,
    authorProfileId: who.profileId,
    toAddress: s.mobile,
    label: `Quote ${ref}`,
    providerId: out.ok ? out.providerId : null,
    status: out.ok ? "sent" : "failed",
    statusDetail: out.ok ? null : out.reason,
    failedAt: out.ok ? null : new Date(),
  });
  if (s.contactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, s.contactId));
    if (c) await addParticipant(conv.id, { role: "customer", contactId: c.id, name: fullName(c), email: c.email, mobile: c.mobile });
  }
  return msg.id;
}

/** After a channel went: the quote is sent, logged, and the job moves on. Same steps the email send always ran. */
async function afterWent(quote: Quote, row: SendRow, channel: "email" | "sms", who: Who, email?: { to: string; cc?: string[] }) {
  const ref = await quoteRefOf(quote);
  const how = channel === "email" ? `emailed to ${row.emailTo}` : `texted to ${showMobile(row.smsTo)}`;
  if (row.kind === "resend") {
    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: quote.id,
      action: "wording_resent",
      detail: `Wording edited, re-sent. Quote ${ref} ${how}`,
      actorName: who.name,
      actorRole: who.role,
    });
    return;
  }
  const now = new Date();
  const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id));
  if (fresh && fresh.status !== "sent") {
    await db.update(schema.quotes).set({ status: "sent", sentAt: fresh.sentAt ?? now, updatedAt: now }).where(eq(schema.quotes.id, quote.id));
  }
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action: "sent",
    detail: `Quote ${ref} ${how}`,
    actorName: who.name,
    actorRole: who.role,
  });
  if (quote.jobId) await syncJobValue(quote.jobId);
  await leadToQuotedOnSend({ jobId: quote.jobId, quoteNumber: ref, actor: who });
  /* Follow-ups are emails, so only an email that went starts or moves them. A text alone does not. */
  if (channel === "email" && email) void onQuoteSent(quote.id, who.name, { to: email.to, cc: email.cc });
}

/** One went and one did not, or neither: the office hears about it, not just whoever pressed Send. */
async function alertIfProblem(quote: Quote, row: SendRow) {
  const failed = [row.emailStatus === "failed" ? "email" : null, row.smsStatus === "failed" ? "text" : null].filter(Boolean) as string[];
  if (!failed.length) return;
  const went = [row.emailStatus === "sent" ? "email" : null, row.smsStatus === "sent" ? "text" : null].filter(Boolean) as string[];
  const ref = await quoteRefOf(quote);
  const title = went.length ? `Quote ${ref}: the ${went[0]} went, the ${failed[0]} did not` : `Quote ${ref} did not go`;
  const lines = [
    row.emailStatus === "failed" ? `Email to ${row.emailTo} failed: ${row.emailDetail ?? "no reason given"}.` : null,
    row.smsStatus === "failed" ? `Text to ${showMobile(row.smsTo)} failed: ${row.smsDetail ?? "no reason given"}.` : null,
    "Open the quote and press Try again on the one that failed. The one that went is not sent again.",
  ].filter(Boolean);
  await notifyOffice("quote_send_problem", { title, body: lines.join(" "), jobId: quote.jobId, path: `/quotes/${quote.id}`, forceEmail: true });
}

/**
 * Run a claimed send. Email first, then the text. Returns the row as it ended.
 * Bad or missing details skip that channel with the reason, they never stop the other one.
 */
export async function runSend(args: { row: SendRow; quote: Quote; email: EmailPart | null; sms: SmsPart | null; who: Who }) {
  let row = args.row;
  const { quote, who } = args;

  /* Work out each channel before anything leaves, so the row says why one was skipped. */
  const emailTo = args.email?.to.trim() ?? "";
  const emailOk = !!args.email && EMAIL_RE.test(emailTo);
  const mobile = args.sms ? normaliseMobile(args.sms.to) : null;
  /* The person picked on the screen, when the number is theirs. Otherwise whoever has that number. */
  let smsContactId: number | null = null;
  if (mobile && args.sms?.contactId) {
    const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, args.sms.contactId));
    if (c && (normaliseMobile(c.mobile) === mobile || normaliseMobile(c.phone) === mobile)) smsContactId = c.id;
  }
  if (mobile && !smsContactId) smsContactId = (await contactByMobile(mobile))?.id ?? null;
  const blocked = mobile ? await smsBlockFor(smsContactId, mobile) : null;
  row = await setRow(row.id, {
    emailTo: emailTo || null,
    emailStatus: emailOk ? "sending" : "skipped",
    emailDetail: !args.email ? "No email address." : emailOk ? null : emailTo ? `"${emailTo}" is not an email address.` : "No email address.",
    emailJson: args.email ? JSON.stringify({ ...args.email, to: emailTo }) : null,
    smsTo: mobile ?? (args.sms?.to.trim() || null),
    smsStatus: !args.sms ? "skipped" : !mobile ? "skipped" : blocked ? "blocked" : "sending",
    smsDetail: !args.sms ? "Text turned off for this send." : !mobile ? (args.sms.to.trim() ? `"${args.sms.to.trim()}" is not an Australian mobile.` : "No mobile number.") : blocked,
    smsJson: args.sms ? JSON.stringify({ ...args.sms, mobile, contactId: smsContactId }) : null,
  });
  if (row.emailStatus !== "sending" && row.smsStatus !== "sending") {
    await releaseSend(row.id);
    throw bad("Nothing to send: there is no usable email address and no text going. Check the details.");
  }

  if (row.emailStatus === "sending") {
    const { row: r, out } = await doEmail(row, quote, { ...args.email!, to: emailTo }, who);
    row = r;
    if (out) await afterWent(quote, row, "email", who, { to: out.to, cc: args.email!.cc });
  }
  if (row.smsStatus === "sending") {
    row = await doSms(row, quote, { ...args.sms!, mobile: mobile!, contactId: smsContactId }, row.emailStatus === "sent", who);
    if (row.smsStatus === "sent") await afterWent(quote, row, "sms", who);
  }
  await alertIfProblem(quote, row);
  return row;
}

/**
 * Try one failed channel again. The claim is one UPDATE from failed to
 * sending, so two quick presses can not both send. The channel that went is
 * never touched.
 */
export async function retryChannel(args: { sendId: number; channel: "email" | "sms"; quote: Quote; who: Who }) {
  const col = args.channel === "email" ? schema.quoteSends.emailStatus : schema.quoteSends.smsStatus;
  const [row] = await db
    .update(schema.quoteSends)
    .set(args.channel === "email" ? { emailStatus: "sending", updatedAt: new Date() } : { smsStatus: "sending", updatedAt: new Date() })
    .where(and(eq(schema.quoteSends.id, args.sendId), eq(schema.quoteSends.quoteId, args.quote.id), eq(col, "failed")))
    .returning();
  if (!row) {
    const [now] = await db.select().from(schema.quoteSends).where(eq(schema.quoteSends.id, args.sendId));
    if (!now) throw bad("That send is not on this quote.");
    const st = args.channel === "email" ? now.emailStatus : now.smsStatus;
    throw bad(st === "sent" ? `The ${args.channel === "email" ? "email" : "text"} already went. Not sent again.` : st === "sending" ? "Already trying. Give it a moment." : `The ${args.channel === "email" ? "email" : "text"} did not fail, so there is nothing to try again.`);
  }
  const putBack = () => setRow(row.id, args.channel === "email" ? { emailStatus: "failed" } : { smsStatus: "failed" });
  if (Math.abs(args.quote.total - row.quoteTotal) > 0.005) {
    await putBack();
    throw bad("The quote has changed since this send. Use Send again so the client gets the new one.");
  }
  let out = row;
  if (args.channel === "email") {
    const e = JSON.parse(row.emailJson ?? "null") as EmailPart | null;
    if (!e) {
      await putBack();
      throw bad("The email details were not kept. Use Send again.");
    }
    /*
     * Gmail may have taken it and a step after that failed. If the thread has
     * an email to the same address carrying this quote's own link, sent since
     * this send began, it went. The link is per quote, so another version
     * emailed to the same person does not count.
     */
    const conv = await ensureForQuote(args.quote.id);
    const link = quoteUrl((await linkForQuote(args.quote.id)).token);
    const [went] = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conv.id),
          eq(schema.messages.channel, "email"),
          eq(schema.messages.direction, "out"),
          eq(schema.messages.status, "sent"),
          eq(schema.messages.toAddress, e.to.trim()),
          gte(schema.messages.createdAt, row.createdAt),
          like(schema.messages.body, `%${link}%`),
        ),
      )
      .limit(1);
    if (went) {
      await setRow(row.id, { emailStatus: "sent", emailDetail: "Gmail took it the first time. Not sent again.", emailMessageId: went.id });
      throw bad("The email already went the first time, it shows as sent on the thread. Not sent again.");
    }
    /* Device files went into the job file on the first try. Use those, so they are not filed twice. */
    if (e.uploads?.length && args.quote.jobId) {
      const media = await db
        .select({ id: schema.jobMedia.id, key: schema.jobMedia.storageKey })
        .from(schema.jobMedia)
        .where(and(eq(schema.jobMedia.jobId, args.quote.jobId), inArray(schema.jobMedia.storageKey, e.uploads.map((u) => u.storageKey))));
      const filed = new Set(media.map((m) => m.key));
      e.mediaIds = [...(e.mediaIds ?? []), ...media.map((m) => m.id)];
      e.uploads = e.uploads.filter((u) => !filed.has(u.storageKey));
    }
    const { row: r, out: sent } = await doEmail(row, args.quote, e, args.who);
    out = r;
    if (sent) await afterWent(args.quote, out, "email", args.who, { to: sent.to, cc: e.cc });
  } else {
    const s = JSON.parse(row.smsJson ?? "null") as (SmsPart & { mobile: string; contactId: number | null }) | null;
    if (!s?.mobile) {
      await putBack();
      throw bad("The text details were not kept. Use Send again.");
    }
    const blocked = await smsBlockFor(s.contactId, s.mobile);
    if (blocked) return setRow(row.id, { smsStatus: "blocked", smsDetail: blocked });
    out = await doSms(row, args.quote, s, row.emailStatus === "sent", args.who);
    if (out.smsStatus === "sent") await afterWent(args.quote, out, "sms", args.who);
  }
  await alertIfProblem(args.quote, out);
  return out;
}

/** The last few sends on a quote, newest first, for the quote card. */
export async function sendsFor(quoteId: number) {
  const rows = await db.select().from(schema.quoteSends).where(eq(schema.quoteSends.quoteId, quoteId)).orderBy(desc(schema.quoteSends.createdAt), desc(schema.quoteSends.id)).limit(10);
  return rows.map(sendSummary);
}
