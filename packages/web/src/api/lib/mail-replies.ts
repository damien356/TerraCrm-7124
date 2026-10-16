import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { mediaKey, putObject } from "./s3";
import { getAttachment, getMessage, header, listMessageIds, MailboxNotConnected, mailboxFor, DAMIEN_MAILBOX, SEND_FROM, type GmailMessage, type GmailPart } from "./gmail";
import { ensureForJob, ensureForQuote, logMessage, openUnassigned, refInSubject } from "./conversations";
import { NOTIFY_FROM_ADDRESS, isTerraOpsMail } from "./notify-kinds";
import { notifyOffice } from "./notify";
import { noteKeyReply } from "./prep";
import { bucketForMime } from "./job-mail";

/* ---------------------------------------------------------------------------
 * The reply pass (job email thread, spec 15 Oct). Every round of the email
 * agent it reads new mail in team@ and damien@ and files each email on the job
 * it belongs to, so the job's Conversation tab shows every email in and out.
 *
 * Where an email goes, in this order:
 *   1. In-Reply-To / References matching an email already on a thread
 *   2. the same Gmail thread as an email already on a thread, same mailbox
 *   3. the X-Terra-Job header, or the [#188042] tag in the subject
 *   4. the sender has exactly one open job (not Paid, not Cancelled)
 * Anything else in team@ goes to Unfiled for the office to place by hand.
 * Anything else in damien@ is his own mail and is left alone.
 *
 * Auto replies, out of office, newsletters and no-reply senders never go to
 * Unfiled. An auto reply to a job email is logged on the job, with no task.
 * Supplier mail and supplier paperwork stay with invoice reading.
 * It only ever reads Gmail. Nothing is marked read, moved or labelled.
 * ------------------------------------------------------------------------- */

const OVERLAP_S = 2 * 86_400;
/** The first look only goes back one day, so old jobs' mail is never pulled in. */
const FIRST_LOOK_S = 86_400;
const PER_RUN = 40;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 12;
const CLOSED_STATUSES = [8, 9]; // Paid, Cancelled

export const REPLY_MAILBOXES = [SEND_FROM, DAMIEN_MAILBOX] as const;

export type ReplyRun = { address: string; looked: number; filed: number; unfiled: number; ignored: number; errors: number; note: string };

/** "Jo Smith <jo@x.com>" to "jo@x.com". */
export function addressOf(from: string) {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim().toLowerCase();
}
export function nameOf(from: string) {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m?.[1] ?? "").trim();
}

/**
 * What kind of email is this? "auto" is an out of office or other automatic
 * reply: it may be logged on a job but never makes a task. "bulk" is a
 * newsletter, a list or a no-reply sender: never filed at all.
 */
export function junkKind(msg: GmailMessage): "auto" | "bulk" | null {
  const h = (n: string) => header(msg, n).trim().toLowerCase();
  const from = addressOf(header(msg, "From"));
  const subject = h("Subject");
  const local = from.split("@")[0] ?? "";
  if (/^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|marketing|news|notifications?|notify|alerts?|automated)([-_.+].*)?$/.test(local)) return "bulk";
  if (h("List-Unsubscribe") || h("List-Id")) return "bulk";
  const prec = h("Precedence");
  if (prec === "bulk" || prec === "list" || prec === "junk") return "bulk";
  const auto = h("Auto-Submitted");
  if ((auto && auto !== "no") || h("X-Autoreply") || h("X-Autorespond") || h("X-Auto-Response-Suppress").includes("all") || prec === "auto_reply") return "auto";
  if (/^(automatic reply|auto[- ]?reply|autoreply|out of (the )?office|ooo\b|away from (the )?office|on (annual )?leave|i am (currently )?(away|out))/i.test(subject)) return "auto";
  if (/^(undeliverable|delivery status notification|mail delivery (failed|subsystem))/i.test(subject)) return "bulk";
  /* A form or a shop saying it got something: nobody wrote it. */
  if (/^(.{0,80}[-:] )?(thank you for (your )?(submission|enquiry|inquiry|order|contacting|registering)|thanks for (your )?(submission|order|contacting)|we('ve| have) received your)/i.test(subject)) return "auto";
  return null;
}

/** Supplier paperwork, read by invoice reading and never filed as a client email. */
const PAPERWORK = /(invoice|statement|work[\s_-]*order|remittance|credit[\s_-]*note|purchase[\s_-]*order)/i;
/** A bill or invoice by its subject, when the PDF itself has a meaningless name. */
const PAPERWORK_SUBJECT = /\b(bill|invoice|statement|remittance|receipt|account summary)\b/i;

/** Senders someone marked "Not a job, ignore this sender" in the Unfiled tray. */
export const IGNORE_SENDERS_KEY = "mail_ignore_senders";
export async function ignoredSenders(): Promise<string[]> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, IGNORE_SENDERS_KEY)).limit(1);
  try {
    const list = JSON.parse(row?.value ?? "[]");
    return Array.isArray(list) ? list.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Every attached file, however deep, with what is needed to fetch it. */
export function fileParts(msg: GmailMessage) {
  const out: GmailPart[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.data)) {
      const disp = (p.headers?.find((x) => x.name.toLowerCase() === "content-disposition")?.value ?? "").toLowerCase();
      const cid = p.headers?.some((x) => x.name.toLowerCase() === "content-id");
      /* A logo in someone's signature is not a file they sent. */
      const signatureBit = (disp.startsWith("inline") || cid) && (p.mimeType ?? "").startsWith("image/") && (p.body?.size ?? 0) < 40_000;
      if (!signatureBit) out.push(p);
    }
    p.parts?.forEach(walk);
  };
  walk(msg.payload);
  return out;
}

const decode = (data?: string) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

function findPart(p: GmailPart | undefined, mime: string): GmailPart | null {
  if (!p) return null;
  if (p.mimeType === mime && !p.filename && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const f = findPart(c, mime);
    if (f) return f;
  }
  return null;
}

const stripHtml = (html: string) =>
  html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n[ \t\u00a0]+/g, "\n");

/** The words of the email, with the quoted history cut off so the thread reads cleanly. */
export function bodyOf(msg: GmailMessage) {
  const plainPart = findPart(msg.payload, "text/plain");
  /* Some senders put an empty plain part next to the real HTML one. */
  const plain = plainPart && decode(plainPart.body?.data).trim() ? plainPart : null;
  const html = plain ? null : findPart(msg.payload, "text/html");
  let text = plain ? decode(plain.body?.data) : html ? stripHtml(decode(html.body?.data)) : msg.payload?.body?.data ? decode(msg.payload.body.data) : msg.snippet ?? "";
  text = text.replace(/\r\n/g, "\n");
  const cuts = [/^On .{4,200}wrote:\s*$/m, /^-{2,}\s*Original Message\s*-{2,}/im, /^From: .+\n(Sent|Date): /m, /^_{10,}\s*$/m];
  let end = text.length;
  for (const re of cuts) {
    const m = re.exec(text);
    if (m && m.index > 0 && m.index < end) end = m.index;
  }
  const fresh = text.slice(0, end).replace(/\n{3,}/g, "\n\n").trim();
  return (fresh || text.trim() || "(no text)").slice(0, 20_000);
}

type Match = { conversationId: number; how: "headers" | "thread" | "tag" | "sender" | "unfiled" };

/** Steps 1 to 3: the ones that can be trusted for an automatic reply too. */
async function matchByMail(msg: GmailMessage, address: string): Promise<Match | null> {
  const ids = [header(msg, "In-Reply-To"), ...header(msg, "References").split(/\s+/)].map((s) => s.trim()).filter(Boolean);
  if (ids.length) {
    const [hit] = await db
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(inArray(schema.messages.messageIdHeader, ids))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (hit?.conversationId) return { conversationId: hit.conversationId, how: "headers" };
  }
  if (msg.threadId) {
    const [hit] = await db
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(and(eq(schema.messages.gmailThreadId, msg.threadId), eq(schema.messages.mailbox, address)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (hit?.conversationId) return { conversationId: hit.conversationId, how: "thread" };
  }
  const xJob = header(msg, "X-Terra-Job").trim().replace(/^#/, "");
  const fromHeader = xJob ? refInSubject(`[#${xJob}]`) : {};
  const r = fromHeader.job || fromHeader.repair || fromHeader.quote ? fromHeader : refInSubject(header(msg, "Subject"));
  if (r.repair) {
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.displayNumber, r.repair)).limit(1);
    if (job) return { conversationId: (await ensureForJob(job.id)).id, how: "tag" };
  }
  if (r.job) {
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.number, r.job)).limit(1);
    if (job) return { conversationId: (await ensureForJob(job.id)).id, how: "tag" };
  }
  if (r.quote) {
    const [q] = await db.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.number, r.quote)).limit(1);
    if (q) return { conversationId: (await ensureForQuote(q.id)).id, how: "tag" };
  }
  return null;
}

/** Contacts with this email, and their jobs that are still open. A repair counts as its parent. */
export async function openJobsFor(email: string) {
  const contacts = await db
    .select()
    .from(schema.contacts)
    .where(sql`lower(trim(coalesce(${schema.contacts.email}, ''))) = ${email.trim().toLowerCase()}`);
  if (!contacts.length) return { contacts, jobIds: [] as number[] };
  const ids = contacts.map((c) => c.id);
  const linked = await db.select({ jobId: schema.jobContacts.jobId }).from(schema.jobContacts).where(inArray(schema.jobContacts.contactId, ids));
  const rows = await db
    .select({ id: schema.jobs.id, parentJobId: schema.jobs.parentJobId })
    .from(schema.jobs)
    .where(
      and(
        or(inArray(schema.jobs.contactId, ids), linked.length ? inArray(schema.jobs.id, linked.map((l) => l.jobId)) : sql`0`),
        or(isNull(schema.jobs.statusId), notInArray(schema.jobs.statusId, CLOSED_STATUSES)),
      ),
    );
  return { contacts, jobIds: [...new Set(rows.map((r) => r.parentJobId ?? r.id))] };
}

/** "Re: Fwd: Tiles" and "tiles" are the same conversation. */
export const baseSubject = (s: string | null | undefined) =>
  (s ?? "")
    .replace(/^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * A holding thread already open for this same conversation: same sender and
 * the same Gmail thread or the same subject. A builder writing about two
 * sites gets two Unfiled items, so each can go on its own job.
 */
async function unfiledFor(email: string, contactId: number | null, threadId: string | null, subject: string) {
  const rows = await db
    .select({ id: schema.conversations.id, gmailThreadId: schema.messages.gmailThreadId, subject: schema.messages.subject })
    .from(schema.conversations)
    .innerJoin(schema.messages, eq(schema.messages.conversationId, schema.conversations.id))
    .where(
      and(
        eq(schema.conversations.state, "unassigned"),
        or(sql`lower(${schema.messages.fromAddress}) = ${email}`, contactId ? eq(schema.conversations.contactId, contactId) : sql`0`),
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(100);
  const want = baseSubject(subject);
  const hit = rows.find((r) => (threadId && r.gmailThreadId === threadId) || (want && baseSubject(r.subject) === want));
  return hit?.id ?? null;
}

async function supplierEmail(email: string) {
  const [s] = await db
    .select({ id: schema.suppliers.id })
    .from(schema.suppliers)
    .where(sql`lower(trim(coalesce(${schema.suppliers.email}, ''))) = ${email}`)
    .limit(1);
  return s ?? null;
}

async function mark(accountId: number, gmailId: string, priorId: number | null, values: Partial<typeof schema.mailReplies.$inferInsert>) {
  if (priorId) {
    await db
      .update(schema.mailReplies)
      .set({ ...values, attempts: sql`${schema.mailReplies.attempts} + 1`, updatedAt: new Date() })
      .where(eq(schema.mailReplies.id, priorId));
  } else {
    await db
      .insert(schema.mailReplies)
      .values({ accountId, gmailId, ...values })
      .onConflictDoUpdate({ target: [schema.mailReplies.accountId, schema.mailReplies.gmailId], set: { ...values, updatedAt: new Date() } });
  }
}

/** Read one email and put it where it belongs. Returns what happened to it. */
export async function fileReply(accountId: number, address: string, gmailId: string, priorId: number | null = null) {
  const msg = await getMessage(address, gmailId);
  const fromRaw = header(msg, "From");
  const from = addressOf(fromRaw);
  const subject = header(msg, "Subject").slice(0, 300);
  const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)) : new Date();
  const base = { threadId: msg.threadId ?? null, fromAddress: fromRaw.slice(0, 300), subject, receivedAt };
  const done = async (status: "filed" | "unfiled" | "ignored", how: string, note: string, messageId: number | null = null) => {
    await mark(accountId, gmailId, priorId, { ...base, status, how, note: note.slice(0, 500), messageId });
    return status;
  };

  if (from === SEND_FROM || from === DAMIEN_MAILBOX || from.endsWith("@terraflooring.com.au")) return done("ignored", "", "from Terra");
  if (isTerraOpsMail(fromRaw, subject)) return done("ignored", "", "Terra Ops' own email");
  const messageIdHeader = header(msg, "Message-ID").trim();
  if (messageIdHeader) {
    const [known] = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.messageIdHeader, messageIdHeader)).limit(1);
    if (known) return done("ignored", "", "already on a thread (came to both mailboxes)", known.id);
  }
  const [knownGmail] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.gmailId, gmailId), eq(schema.messages.mailbox, address)))
    .limit(1);
  if (knownGmail) return done("ignored", "", "already on a thread", knownGmail.id);

  const junk = junkKind(msg);
  if (junk === "bulk") return done("ignored", "", "newsletter, list or no-reply sender");
  if (await supplierEmail(from)) return done("ignored", "", "supplier, left for invoice reading");

  const files = fileParts(msg);
  let match = await matchByMail(msg, address);
  /* Paperwork that is not a reply to a Terra email belongs to invoice reading. */
  if (!match && files.some((f) => PAPERWORK.test(f.filename ?? ""))) return done("ignored", "", "invoice, statement or work order, left for invoice reading");
  if (!match && PAPERWORK_SUBJECT.test(subject) && files.some((f) => /pdf/i.test(f.mimeType ?? "") || /\.pdf$/i.test(f.filename ?? "")))
    return done("ignored", "", "a bill or invoice, left for invoice reading");
  if (!match && junk === "auto") return done("ignored", "", "automatic reply, not to a job email");
  /* Marked "Not a job" in the tray: only a reply to a Terra email gets through. */
  if (!match && (await ignoredSenders()).includes(from)) return done("ignored", "", "sender marked Not a job");

  const { contacts, jobIds } = await openJobsFor(from);
  if (!match && jobIds.length === 1) match = { conversationId: (await ensureForJob(jobIds[0]!)).id, how: "sender" };
  if (!match) {
    if (address !== SEND_FROM) return done("ignored", "", "damien@ mail that is not about a job");
    const contactId = contacts.length === 1 ? contacts[0]!.id : null;
    const existing = await unfiledFor(from, contactId, msg.threadId ?? null, subject);
    const conversationId = existing ?? (await openUnassigned({ subject: subject || "Email", contactId })).id;
    match = { conversationId, how: "unfiled" };
  }

  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, match.conversationId)).limit(1);
  if (!conv) throw new Error("thread went missing");
  const jobId = conv.state === "unassigned" ? null : conv.jobId ?? null;
  const contact = contacts.find((c) => c.id === conv.contactId) ?? contacts[0] ?? null;
  const name = nameOf(fromRaw) || (contact ? `${contact.firstName} ${contact.lastName}`.trim() : "") || from;
  const auto = junk === "auto";

  const message = await logMessage({
    conversationId: conv.id,
    jobId,
    contactId: contact?.id ?? null,
    channel: "email",
    audience: "customer",
    direction: "in",
    subject,
    body: bodyOf(msg),
    authorName: name,
    fromAddress: from,
    toAddress: header(msg, "To").slice(0, 500) || address,
    ccAddress: header(msg, "Cc").slice(0, 500) || null,
    mailbox: address,
    gmailId,
    gmailThreadId: msg.threadId ?? null,
    autoReply: auto,
    messageIdHeader: messageIdHeader || null,
    inReplyTo: header(msg, "In-Reply-To") || null,
    referencesHeader: header(msg, "References") || null,
    status: "received",
  });

  /* Files: into the job file when there is a job, held with the email until it is filed when not. */
  let stored = 0;
  for (const part of files.slice(0, MAX_FILES)) {
    if ((part.body?.size ?? 0) > MAX_FILE_BYTES) continue;
    const bytes = part.body?.data ? Buffer.from(part.body.data, "base64url") : await getAttachment(address, gmailId, part.body!.attachmentId!);
    const mime = part.mimeType || "application/octet-stream";
    const filename = (part.filename || "file").slice(0, 200);
    const bucket = bucketForMime(mime);
    const key = jobId ? mediaKey(jobId, bucket, filename) : `mail/in/${conv.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-60)}`;
    await putObject(key, bytes, mime, filename);
    let mediaId: number | null = null;
    if (jobId) {
      const [m] = await db
        .insert(schema.jobMedia)
        .values({
          jobId,
          bucket,
          kind: mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "doc",
          storageKey: key,
          url: key,
          filename,
          mime,
          sizeBytes: bytes.length,
          caption: `Emailed by ${name}`.slice(0, 200),
          uploaderName: name.slice(0, 120),
        })
        .returning({ id: schema.jobMedia.id });
      mediaId = m?.id ?? null;
    }
    await db.insert(schema.messageAttachments).values({ messageId: message.id, mediaId, filename, mime, sizeBytes: bytes.length, storageKey: key, url: "" });
    stored++;
  }
  // Notes 18.56: where the key is, in answer to a prep email, goes on the job's access notes.
  if (jobId && !auto) await noteKeyReply({ jobId, contactId: contact?.id ?? null, body: bodyOf(msg), channel: "email", name, photos: stored });

  if (contact) {
    await db.insert(schema.activityLog).values({
      jobId,
      contactId: contact.id,
      entityType: jobId ? "job" : "contact",
      entityId: jobId ?? contact.id,
      action: auto ? "email_auto_reply" : "email_reply",
      detail: `${auto ? "Automatic reply" : "Email"} from ${name}: ${subject || "(no subject)"}${stored ? `, ${stored} file${stored === 1 ? "" : "s"}` : ""}`.slice(0, 500),
      actorName: name.slice(0, 120),
      actorRole: "customer",
    });
  }

  /* A reply into an email that is itself still Unfiled stays Unfiled. */
  const holding = conv.state === "unassigned";
  if (!auto) {
    const filed = !holding;
    if (filed) {
      await db.insert(schema.officeTasks).values({
        jobId,
        conversationId: conv.id,
        sourceMessageId: message.id,
        title: `Reply to email from ${name}: ${subject || "(no subject)"}`.slice(0, 300),
        detail: message.body.slice(0, 600),
        createdByName: "Email",
      });
    }
    void notifyOffice("client_email", {
      title: filed ? `Email from ${name}` : `Email to file: ${name}`,
      body: `${subject || "(no subject)"}\n${message.body.slice(0, 400)}`,
      jobId,
      path: filed && jobId ? `/jobs/${jobId}?tab=conversation` : "/conversations?kind=unmatched",
    });
  }

  return done(holding ? "unfiled" : "filed", match.how, auto ? "automatic reply" : "", message.id);
}

/** One round over one mailbox. Its own place in the mailbox, apart from invoice reading. */
export async function checkReplies(address: string, limit = PER_RUN): Promise<ReplyRun> {
  const run: ReplyRun = { address, looked: 0, filed: 0, unfiled: 0, ignored: 0, errors: 0, note: "" };
  if (!(REPLY_MAILBOXES as readonly string[]).includes(address)) return { ...run, note: "not a reply mailbox" };
  const [acct] = await db.select().from(schema.mailAccounts).where(eq(schema.mailAccounts.address, address));
  if (!acct?.refreshTokenSealed || !mailboxFor(address)) return { ...run, note: "not connected" };

  const startedAt = Math.floor(Date.now() / 1000);
  const since = acct.repliesSyncedThrough ? acct.repliesSyncedThrough - OVERLAP_S : startedAt - FIRST_LOOK_S;
  const ids = (await listMessageIds(address, `-in:sent -in:drafts -in:chats -from:me -from:${NOTIFY_FROM_ADDRESS} after:${since}`, 300)).reverse();

  const seen = await db
    .select({ gmailId: schema.mailReplies.gmailId, status: schema.mailReplies.status, attempts: schema.mailReplies.attempts, id: schema.mailReplies.id })
    .from(schema.mailReplies)
    .where(eq(schema.mailReplies.accountId, acct.id));
  const seenMap = new Map(seen.map((s) => [s.gmailId, s]));

  let capped = false;
  for (const id of ids) {
    const prior = seenMap.get(id);
    if (prior && (prior.status !== "error" || prior.attempts >= 3)) continue;
    if (run.looked >= limit) {
      capped = true;
      break;
    }
    run.looked++;
    try {
      const status = await fileReply(acct.id, address, id, prior?.id ?? null);
      run[status === "filed" ? "filed" : status === "unfiled" ? "unfiled" : "ignored"]++;
    } catch (e) {
      if (e instanceof MailboxNotConnected) throw e;
      run.errors++;
      const note = String((e as Error).message ?? e).slice(0, 500);
      await mark(acct.id, id, prior?.id ?? null, { status: "error", note });
    }
  }

  await db
    .update(schema.mailAccounts)
    .set({ ...(capped ? {} : { repliesSyncedThrough: startedAt }), updatedAt: new Date() })
    .where(eq(schema.mailAccounts.id, acct.id));
  run.note = capped ? "more to read, carrying on next round" : "up to date";
  return run;
}
