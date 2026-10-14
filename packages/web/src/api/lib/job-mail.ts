import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendAsTeam } from "./agent-mail";
import { addParticipant, jobRef, logMessage, subjectWithRef, tagFromRef, threadHeaders } from "./conversations";
import { canSendFrom, DAMIEN_MAILBOX, SEND_FROM, sendFromMailbox, type OutgoingMail } from "./gmail";
import { getObject, putObject, signGet } from "./s3";

/* ---------------------------------------------------------------------------
 * The job email thread (spec 15 Oct). Every email Terra sends about a job goes
 * through `sendJobEmail`, so they all:
 *   - go out of team@'s Gmail (or damien@'s, when Damien picks himself on a job),
 *   - carry the job tag in the subject ("... [#188042]") and in X-Terra-Job,
 *   - thread under the last email on the job, in Gmail and in the client's inbox,
 *   - are logged on the job's thread with every file, and on each contact's History.
 * Big files go as a download link instead of an attachment.
 * ------------------------------------------------------------------------- */

type Conversation = typeof schema.conversations.$inferSelect;

export const TEAM_NAME = "Team Terra";
export const DAMIEN_NAME = "Damien from Terra";
/** Gmail takes 25 MB once encoded. Files past this go as a link. */
export const ATTACH_LIMIT_BYTES = 18 * 1024 * 1024;
/** How long a download link in an email works. Storage links can not last longer. */
export const LINK_DAYS = 7;

export type MailFile = {
  filename: string;
  content: Buffer;
  contentType: string;
  /** The job file row it came from, if any. */
  mediaId?: number | null;
  /** Already in storage, so it is not written again. */
  storageKey?: string | null;
  /** Where to store it when it is not stored yet. */
  storeAt?: string | null;
};

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "-").slice(-80) || "file";
const fullName = (c: { firstName?: string | null; lastName?: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim();

/** The ref that tags the subject, and the label a repair carries on its parent's thread. */
export async function tagForJob(conv: Conversation, jobId: number | null | undefined) {
  if (jobId) {
    const [j] = await db
      .select({ number: schema.jobs.number, displayNumber: schema.jobs.displayNumber, parentJobId: schema.jobs.parentJobId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    if (j?.parentJobId) return { ref: jobRef(j), label: `Repair ${j.displayNumber || j.number}` as string | null };
    if (j && !conv.jobId) return { ref: jobRef(j), label: null };
  }
  return { ref: conv.ref, label: null as string | null };
}

/** Gmail's thread for the newest email on this job thread that went through the same mailbox. */
async function lastGmailThread(conversationId: number, mailbox: string) {
  const [row] = await db
    .select({ id: schema.messages.gmailThreadId })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.mailbox, mailbox), isNotNull(schema.messages.gmailThreadId)))
    .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
    .limit(1);
  return row?.id || undefined;
}

/** Contacts whose email is one of these, matched without case. */
export async function contactsByEmails(emails: string[]) {
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return [];
  return db
    .select()
    .from(schema.contacts)
    .where(sql`lower(trim(coalesce(${schema.contacts.email}, ''))) in (${sql.join(list.map((e) => sql`${e}`), sql`, `)})`);
}

/** Every job sharing one thread: the job, its parent, and the parent's repairs. */
export async function jobFamily(jobId: number) {
  const [j] = await db.select({ id: schema.jobs.id, parentJobId: schema.jobs.parentJobId }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!j) return [jobId];
  const root = j.parentJobId ?? j.id;
  const kids = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.parentJobId, root));
  return [root, ...kids.map((k) => k.id)];
}

/** Files picked from the job file, read back out of storage. Only from this job and its repairs. */
export async function filesFromMedia(jobId: number, mediaIds: number[]): Promise<MailFile[]> {
  const ids = [...new Set(mediaIds)];
  if (!ids.length) return [];
  const family = await jobFamily(jobId);
  const rows = await db
    .select()
    .from(schema.jobMedia)
    .where(and(inArray(schema.jobMedia.id, ids), inArray(schema.jobMedia.jobId, family), isNull(schema.jobMedia.archivedAt)));
  if (rows.length !== ids.length) throw new Error("One of the files is not on this job any more. Pick them again.");
  const out: MailFile[] = [];
  for (const id of ids) {
    const r = rows.find((x) => x.id === id)!;
    const ext = r.mime === "application/pdf" ? "pdf" : r.mime?.startsWith("image/") ? r.mime.split("/")[1]!.replace("jpeg", "jpg") : "bin";
    out.push({
      filename: r.filename || `${r.kind}-${r.id}.${ext}`,
      content: await getObject(r.storageKey),
      contentType: r.mime || "application/octet-stream",
      mediaId: r.id,
      storageKey: r.storageKey,
    });
  }
  return out;
}

/** A file the browser already put in storage, picked from the device. */
export const uploadInput = z.object({
  storageKey: z.string().min(1).max(400),
  filename: z.string().min(1).max(200),
  mime: z.string().max(120).default("application/octet-stream"),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type MailUpload = z.infer<typeof uploadInput>;

/** What files go in which part of the job file. Photos with the client photos, papers with the plans. */
export const bucketForMime = (mime: string) => (/^(image|video)\//.test(mime) ? "client_reported" : "plan");
const kindForMime = (mime: string) => (mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "doc");

/** Where a device file for an email with no job yet goes. The browser asks for a slot here. */
export const mailUploadKey = (filename: string) => `mail/uploads/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(filename)}`;

/**
 * Files picked for an email: from the job file, and from the device. A device
 * file on a job is saved to the job file first, so it is never only in an email.
 * Storage keys are checked to be this job's own or a mail upload slot, so a
 * picked file can not reach into another job.
 */
export async function pickedFiles(args: {
  jobId?: number | null;
  mediaIds?: number[];
  uploads?: MailUpload[];
  byName: string;
  byProfileId?: number | null;
}): Promise<MailFile[]> {
  const out: MailFile[] = [];
  if (args.mediaIds?.length) {
    if (!args.jobId) throw new Error("Files from the job file need a job.");
    out.push(...(await filesFromMedia(args.jobId, args.mediaIds)));
  }
  const family = args.jobId ? await jobFamily(args.jobId) : [];
  for (const u of args.uploads ?? []) {
    const ok = u.storageKey.startsWith("mail/uploads/") || family.some((id) => u.storageKey.startsWith(`jobs/${id}/`));
    if (!ok || u.storageKey.includes("..")) throw new Error(`${u.filename} did not upload to the right place. Attach it again.`);
    const content = await getObject(u.storageKey);
    let mediaId: number | null = null;
    if (args.jobId) {
      const [row] = await db
        .insert(schema.jobMedia)
        .values({
          jobId: args.jobId,
          bucket: bucketForMime(u.mime),
          kind: kindForMime(u.mime),
          storageKey: u.storageKey,
          url: u.storageKey,
          filename: u.filename,
          mime: u.mime,
          sizeBytes: content.length,
          caption: "Sent by email",
          uploadedByProfileId: args.byProfileId ?? null,
          uploaderName: args.byName,
        })
        .returning({ id: schema.jobMedia.id });
      mediaId = row?.id ?? null;
    }
    out.push({ filename: u.filename, content, contentType: u.mime, mediaId, storageKey: u.storageKey });
  }
  return out;
}

/** Which mailboxes this person may send a job email from. damien@ is Damien's alone. */
export async function sendersFor(profileEmail: string | null | undefined) {
  const out: Array<{ address: string; name: string; ready: boolean; note: string }> = [];
  out.push({ address: SEND_FROM, name: TEAM_NAME, ready: true, note: (await canSendFrom(SEND_FROM)) ? "" : "Goes through the backup mail service until team@ is signed in again." });
  if ((profileEmail ?? "").trim().toLowerCase() === DAMIEN_MAILBOX) {
    const ready = await canSendFrom(DAMIEN_MAILBOX);
    out.push({ address: DAMIEN_MAILBOX, name: DAMIEN_NAME, ready, note: ready ? "" : "Needs signing in again in Settings, Email agent, with send permission." });
  }
  return out;
}

export type SendJobEmail = {
  conv: Conversation;
  /** The job it is about. A repair here gets its own tag and a label on the parent's thread. */
  jobId?: number | null;
  /** team@ unless Damien picked himself. */
  mailbox?: string;
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  fromName?: string;
  files?: MailFile[];
  label?: string | null;
  audience?: "customer" | "supplier" | "installer";
  contactId?: number | null;
  supplierId?: number | null;
  authorName: string;
  authorProfileId?: number | null;
};

/**
 * Send one email on a job thread and log it. Throws if it did not go, so
 * nothing is shown as sent that was not.
 */
export async function sendJobEmail(args: SendJobEmail) {
  const mailbox = (args.mailbox || SEND_FROM).toLowerCase();
  if (mailbox !== SEND_FROM && mailbox !== DAMIEN_MAILBOX) throw new Error("Job emails go from team@ or damien@ only.");
  const to = args.to.trim();
  const cc = [...new Set((args.cc ?? []).map((c) => c.trim()).filter((c) => c && c.toLowerCase() !== to.toLowerCase()))];

  const tag = await tagForJob(args.conv, args.jobId ?? args.conv.jobId);
  const subject = subjectWithRef(args.subject, tag.ref);
  const label = args.label ?? tag.label;

  /* Everything is stored first, so a file sent as a link has somewhere to link to. */
  const files = args.files ?? [];
  const stored: Array<MailFile & { storageKey: string }> = [];
  for (const f of files) {
    if (f.storageKey) {
      stored.push({ ...f, storageKey: f.storageKey });
      continue;
    }
    const key = f.storeAt || `mail/out/${args.conv.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName(f.filename)}`;
    await putObject(key, f.content, f.contentType, f.filename);
    stored.push({ ...f, storageKey: key });
  }
  /* Smallest first, so the most files fit. The rest go as links. */
  const attach: typeof stored = [];
  const links: typeof stored = [];
  let total = 0;
  for (const f of [...stored].sort((a, b) => a.content.length - b.content.length)) {
    if (total + f.content.length <= ATTACH_LIMIT_BYTES) {
      attach.push(f);
      total += f.content.length;
    } else links.push(f);
  }
  let text = args.text;
  if (links.length) {
    const lines = await Promise.all(links.map(async (f) => `${f.filename}: ${await signGet(f.storageKey, LINK_DAYS * 86_400)}`));
    text = `${text.trimEnd()}\n\nToo big to attach, so here are download links (they work for ${LINK_DAYS} days):\n${lines.join("\n")}`;
  }

  const headers = await threadHeaders(args.conv.id);
  const threadId = await lastGmailThread(args.conv.id, mailbox);
  const jobTag = tagFromRef(tag.ref).replace(/^#/, "");
  const mail: OutgoingMail = {
    to,
    cc,
    subject,
    text,
    fromName: args.fromName || (mailbox === DAMIEN_MAILBOX ? DAMIEN_NAME : TEAM_NAME),
    attachments: attach.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })),
    headers: { ...(jobTag ? { "X-Terra-Job": jobTag } : {}), "X-Terra-Thread": String(args.conv.id) },
    inReplyTo: headers.inReplyTo,
    references: headers.references,
    threadId,
  };
  const out = mailbox === SEND_FROM ? await sendAsTeam(mail) : { via: "gmail" as const, ...(await sendFromMailbox(DAMIEN_MAILBOX, mail)) };

  const people = await contactsByEmails([to, ...cc]);
  const toContact = people.find((p) => (p.email ?? "").trim().toLowerCase() === to.toLowerCase());
  const jobId = args.jobId ?? args.conv.jobId ?? null;
  const message = await logMessage({
    conversationId: args.conv.id,
    jobId,
    contactId: args.contactId ?? toContact?.id ?? null,
    supplierId: args.supplierId ?? null,
    channel: "email",
    audience: args.audience ?? "customer",
    direction: "out",
    subject,
    body: text,
    authorName: args.authorName,
    authorProfileId: args.authorProfileId ?? null,
    fromAddress: mailbox,
    toAddress: to,
    ccAddress: cc.length ? cc.join(", ") : null,
    mailbox: out.via === "gmail" ? mailbox : null,
    gmailId: out.via === "gmail" ? out.id || null : null,
    gmailThreadId: out.via === "gmail" ? out.threadId || null : null,
    messageIdHeader: out.messageIdHeader || null,
    inReplyTo: headers.inReplyTo ?? null,
    referencesHeader: headers.references ?? null,
    providerId: out.id || null,
    label,
    status: "sent",
  });

  if (stored.length) {
    await db.insert(schema.messageAttachments).values(
      stored.map((f) => ({
        messageId: message.id,
        mediaId: f.mediaId ?? null,
        filename: f.filename.slice(0, 200),
        mime: f.contentType,
        sizeBytes: f.content.length,
        storageKey: f.storageKey,
        url: "",
      })),
    );
  }

  for (const p of people) {
    await addParticipant(args.conv.id, { role: "customer", contactId: p.id, name: fullName(p), email: p.email, mobile: p.mobile });
  }
  if (args.supplierId) await addParticipant(args.conv.id, { role: "supplier", supplierId: args.supplierId, email: to });
  for (const addr of [to, ...cc]) {
    if (!people.some((p) => (p.email ?? "").trim().toLowerCase() === addr.toLowerCase()) && !args.supplierId) {
      await addParticipant(args.conv.id, { role: "other", email: addr, name: addr });
    }
  }
  /* The contact's History shows every email sent to them, from whichever screen. */
  if (people.length) {
    await db.insert(schema.activityLog).values(
      people.map((p) => ({
        jobId,
        contactId: p.id,
        entityType: jobId ? "job" : "contact",
        entityId: jobId ?? p.id,
        action: "email_sent",
        detail: `Email sent${label ? ` (${label})` : ""}: ${subject}${stored.length ? `, ${stored.length} file${stored.length === 1 ? "" : "s"}` : ""}`.slice(0, 500),
        actorName: args.authorName,
        actorRole: "office",
      })),
    );
  }

  return { message, via: out.via, subject, attached: attach.length, linked: links.map((f) => f.filename) };
}

/** Is there anything with this Message-ID on a thread already? Stops the same email being filed twice. */
export async function knownMessageId(messageIdHeader: string) {
  const id = messageIdHeader.trim();
  if (!id) return null;
  const [row] = await db
    .select({ id: schema.messages.id, conversationId: schema.messages.conversationId })
    .from(schema.messages)
    .where(eq(schema.messages.messageIdHeader, id))
    .limit(1);
  return row ?? null;
}
