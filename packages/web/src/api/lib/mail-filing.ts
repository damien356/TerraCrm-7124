import { and, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { ensureForJob } from "./conversations";
import { bucketForMime, tagForJob } from "./job-mail";
import { IGNORE_SENDERS_KEY, ignoredSenders } from "./mail-replies";

/* ---------------------------------------------------------------------------
 * Putting an email on the right job by hand (job email thread, spec 15 Oct):
 * "Move to another job" on any email, filing an Unfiled email, and turning an
 * Unfiled email into a new enquiry. The email row moves, it is never copied,
 * so it is only ever in one place.
 * ------------------------------------------------------------------------- */

const fullName = (c: { firstName?: string | null; lastName?: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim();

/** Move one message, its files and its task onto a job's thread. Returns the thread it is on now. */
export async function moveMessageToJob(messageId: number, jobId: number, byName: string) {
  const [m] = await db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).limit(1);
  if (!m) throw new Error("That email is not there any more.");
  const [job] = await db.select({ id: schema.jobs.id, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) throw new Error("That job is not there.");
  const target = await ensureForJob(jobId);
  const from = m.conversationId;
  const { label } = await tagForJob(target, jobId);

  await db
    .update(schema.messages)
    .set({ conversationId: target.id, jobId, label: label ?? m.label, updatedAt: new Date() })
    .where(eq(schema.messages.id, m.id));

  /* Files that came in on this email follow it into the new job's file. A
   * file Terra sent from a job file stays on the job it came from. */
  const files = await db.select().from(schema.messageAttachments).where(eq(schema.messageAttachments.messageId, m.id));
  for (const f of files) {
    if (m.direction !== "in") continue;
    if (f.mediaId) {
      await db.update(schema.jobMedia).set({ jobId, updatedAt: new Date() }).where(eq(schema.jobMedia.id, f.mediaId));
    } else if (f.storageKey) {
      const mime = f.mime || "application/octet-stream";
      const [row] = await db
        .insert(schema.jobMedia)
        .values({
          jobId,
          bucket: bucketForMime(mime),
          kind: mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "doc",
          storageKey: f.storageKey,
          url: f.storageKey,
          filename: f.filename,
          mime,
          sizeBytes: f.sizeBytes,
          caption: `Emailed by ${m.authorName || m.fromAddress || "client"}`.slice(0, 200),
          uploaderName: (m.authorName || "").slice(0, 120),
        })
        .returning({ id: schema.jobMedia.id });
      await db.update(schema.messageAttachments).set({ mediaId: row?.id ?? null }).where(eq(schema.messageAttachments.id, f.id));
    }
  }

  await db
    .update(schema.officeTasks)
    .set({ jobId, conversationId: target.id, updatedAt: new Date() })
    .where(eq(schema.officeTasks.sourceMessageId, m.id));

  /* Both threads' clocks follow what is on them now. */
  for (const convId of [from, target.id]) {
    if (!convId) continue;
    const [last] = await db
      .select({ createdAt: schema.messages.createdAt, body: schema.messages.body })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, convId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (last) {
      await db
        .update(schema.conversations)
        .set({ lastMessageAt: last.createdAt, lastMessagePreview: last.body.replace(/\s+/g, " ").trim().slice(0, 160), updatedAt: new Date() })
        .where(eq(schema.conversations.id, convId));
    }
  }

  await db.insert(schema.activityLog).values({
    jobId,
    contactId: m.contactId,
    entityType: "job",
    entityId: jobId,
    action: "email_moved",
    detail: `Email "${(m.subject || "(no subject)").slice(0, 200)}" moved to job ${job.displayNumber || job.number}`,
    actorName: byName,
    actorRole: "office",
  });
  return { conversationId: target.id, fromConversationId: from };
}

/** Everything in an Unfiled holding thread goes onto the job. The holding thread then goes. */
export async function fileHolding(conversationId: number, jobId: number, byName: string) {
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1);
  if (!conv) throw new Error("That email has already been filed.");
  if (conv.state !== "unassigned") throw new Error("That email is already on a job.");
  const rows = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
  let target = conversationId;
  for (const m of rows) target = (await moveMessageToJob(m.id, jobId, byName)).conversationId;
  /* A filed client email is a task like any other, unless it was an automatic reply. */
  for (const m of rows) {
    if (m.direction !== "in" || m.autoReply) continue;
    const [has] = await db.select({ id: schema.officeTasks.id }).from(schema.officeTasks).where(eq(schema.officeTasks.sourceMessageId, m.id)).limit(1);
    if (has) continue;
    await db.insert(schema.officeTasks).values({
      jobId,
      conversationId: target,
      sourceMessageId: m.id,
      title: `Reply to email from ${m.authorName || m.fromAddress || "client"}: ${m.subject || "(no subject)"}`.slice(0, 300),
      detail: m.body.slice(0, 600),
      createdByName: byName,
    });
  }
  await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
  return { conversationId: target, jobId, moved: rows.length };
}

/** Who sent the mail in a holding thread: its contact, or the first sender it has. */
export async function holdingSender(conversationId: number) {
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId)).limit(1);
  if (!conv) return null;
  const [first] = await db
    .select({ fromAddress: schema.messages.fromAddress, authorName: schema.messages.authorName, subject: schema.messages.subject, body: schema.messages.body })
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "in")))
    .orderBy(schema.messages.createdAt)
    .limit(1);
  const email = (first?.fromAddress ?? "").trim().toLowerCase();
  let contact = conv.contactId
    ? ((await db.select().from(schema.contacts).where(eq(schema.contacts.id, conv.contactId)).limit(1))[0] ?? null)
    : null;
  if (!contact && email) {
    contact = (await db.select().from(schema.contacts).where(sql`lower(trim(coalesce(${schema.contacts.email}, ''))) = ${email}`).limit(1))[0] ?? null;
  }
  return { conv, email, name: first?.authorName ?? "", subject: first?.subject || conv.subject, body: first?.body ?? "", contact };
}

/** The client's jobs, newest first, open ones first, for "Which job is this for?". */
export async function jobsForContact(contactId: number) {
  const linked = await db.select({ jobId: schema.jobContacts.jobId }).from(schema.jobContacts).where(eq(schema.jobContacts.contactId, contactId));
  const rows = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      displayNumber: schema.jobs.displayNumber,
      title: schema.jobs.title,
      statusId: schema.jobs.statusId,
      parentJobId: schema.jobs.parentJobId,
      status: schema.jobStatuses.name,
      createdAt: schema.jobs.createdAt,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(
      and(
        or(eq(schema.jobs.contactId, contactId), linked.length ? inArray(schema.jobs.id, linked.map((l) => l.jobId)) : sql`0`),
        // A merged job is never offered: its work is on the job it went into (notes 18.48).
        isNull(schema.jobs.mergedIntoJobId),
      ),
    )
    .orderBy(desc(schema.jobs.createdAt))
    .limit(30);
  const open = (r: (typeof rows)[number]) => r.statusId == null || ![8, 9].includes(r.statusId);
  return [...rows.filter(open), ...rows.filter((r) => !open(r))].map((r) => ({ ...r, open: open(r), byAddress: false }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "248/42 Goldmine Rd" to its number and street name, for spotting it in an email. */
export function addressKey(address: string) {
  const tokens = address.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean);
  // The street is the first word straight after a number ("6/42 Boundary"), so "unit 4 and 6/42 Boundary St" keys on 6/42.
  for (let i = 1; i < tokens.length; i++) {
    const num = tokens[i - 1]!.replace(/^(unit|lot|u)/, "");
    const street = tokens[i]!;
    if (/\d/.test(num) && /^[a-z][a-z'-]{2,}$/.test(street) && !/^(and|the|unit|lot|shop|level|suite|to|of)$/.test(street)) return { num, street };
  }
  return null;
}

/** Open jobs whose site address is written in the email, number and street both. */
export async function jobsByAddress(text: string, skip: number[] = []) {
  const hay = ` ${text.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ")} `;
  const rows = await db
    .select({
      id: schema.jobs.id,
      number: schema.jobs.number,
      displayNumber: schema.jobs.displayNumber,
      title: schema.jobs.title,
      statusId: schema.jobs.statusId,
      parentJobId: schema.jobs.parentJobId,
      status: schema.jobStatuses.name,
      createdAt: schema.jobs.createdAt,
      address: schema.sites.address,
    })
    .from(schema.jobs)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(and(or(isNull(schema.jobs.statusId), notInArray(schema.jobs.statusId, [8, 9])), isNull(schema.jobs.mergedIntoJobId)))
    .orderBy(desc(schema.jobs.createdAt))
    .limit(400);
  const out = [];
  for (const r of rows) {
    if (skip.includes(r.id) || r.parentJobId) continue;
    const k = addressKey(r.address);
    if (!k) continue;
    // Number and street together, as they are written on an address ("248/42 Goldmine Road").
    const re = new RegExp(`(^|[^\\d/])${escapeRe(k.num)} ${escapeRe(k.street)}\\b`);
    if (re.test(hay)) {
      const { address: _a, ...job } = r;
      out.push({ ...job, open: true, byAddress: true });
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** "Not a job": the holding thread is closed, kept for the record. Optionally its sender is ignored from now on. */
export async function dismissHolding(conversationId: number, ignoreSender: boolean, byName: string) {
  const who = await holdingSender(conversationId);
  if (!who) throw new Error("That email has already been filed.");
  if (who.conv.state !== "unassigned") throw new Error("That email is already on a job.");
  await db.update(schema.conversations).set({ state: "closed", updatedAt: new Date() }).where(eq(schema.conversations.id, conversationId));
  const ids = (await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.conversationId, conversationId))).map((m) => m.id);
  if (ids.length) {
    await db
      .update(schema.officeTasks)
      .set({ status: "done", completedAt: new Date(), completedByName: byName, updatedAt: new Date() })
      .where(and(inArray(schema.officeTasks.sourceMessageId, ids), eq(schema.officeTasks.status, "open")));
  }
  let ignored: string | null = null;
  if (ignoreSender && who.email && who.email.includes("@")) {
    const list = await ignoredSenders();
    if (!list.includes(who.email)) {
      const value = JSON.stringify([...list, who.email].slice(-500));
      await db
        .insert(schema.settings)
        .values({ key: IGNORE_SENDERS_KEY, value })
        .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    }
    ignored = who.email;
  }
  return { conversationId, ignored };
}

/** Unfiled email, for the tray: each holding thread with its sender and their jobs. */
export async function unfiledList() {
  const convs = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.state, "unassigned"))
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(50);
  const out = [];
  for (const c of convs) {
    const who = await holdingSender(c.id);
    const msgs = await db
      .select({ id: schema.messages.id, channel: schema.messages.channel, subject: schema.messages.subject, body: schema.messages.body, createdAt: schema.messages.createdAt, fromAddress: schema.messages.fromAddress, authorName: schema.messages.authorName })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, c.id))
      .orderBy(desc(schema.messages.createdAt))
      .limit(3);
    out.push({
      conversationId: c.id,
      subject: who?.subject || c.subject,
      email: who?.email ?? "",
      name: who?.contact ? fullName(who.contact) : who?.name || who?.email || "",
      contactId: who?.contact?.id ?? null,
      lastMessageAt: c.lastMessageAt,
      preview: msgs[0]?.body.replace(/\s+/g, " ").trim().slice(0, 200) ?? c.lastMessagePreview,
      messages: msgs.map((m) => ({ ...m, body: m.body.slice(0, 3000) })),
      count: Number((await db.select({ n: sql<number>`count(*)` }).from(schema.messages).where(eq(schema.messages.conversationId, c.id)))[0]?.n ?? 0),
      jobs: await (async () => {
        const mine = who?.contact ? await jobsForContact(who.contact.id) : [];
        const text = [who?.subject, ...msgs.map((m) => `${m.subject ?? ""} ${m.body.slice(0, 2000)}`)].join(" ");
        const near = await jobsByAddress(text, mine.map((j) => j.id));
        return [...near, ...mine];
      })(),
    });
  }
  return out;
}

