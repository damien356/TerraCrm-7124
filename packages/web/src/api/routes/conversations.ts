import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, type Actor } from "../middleware/auth";
import { parseTags } from "../lib/person-tags";
import { mailUploadKey, bucketForMime } from "../lib/job-mail";
import { dismissHolding, fileHolding, holdingSender, moveMessageToJob, unfiledList } from "../lib/mail-filing";
import { mediaKey, signGet, signPut } from "../lib/s3";
import { createJob } from "./jobs";
import { jobFamily, pickedFiles, sendersFor, sendJobEmail, uploadInput } from "../lib/job-mail";
import { SEND_FROM } from "../lib/gmail";
import { normaliseMobile, sendSms, smsParts, SMS_OPT_OUT } from "../lib/sms";
import {
  addParticipant,
  ensureForJob,
  ensureForQuote,
  logMessage,
  subjectWithRef,
} from "../lib/conversations";

/**
 * CONVERSATIONS — the office side.
 *
 * One thread per piece of work, read as one story and sent down separate
 * channels. The separation is the whole point: `audience` decides where a
 * message goes, and "internal" has no send path at all, so an internal note
 * cannot be emailed to a customer by accident.
 *
 * What the office is shown is only ever what actually happened. An email that
 * Resend accepted says "sent", not "delivered", and no email is ever marked
 * read, because there is no honest way to know.
 */

const AUDIENCE = ["customer", "installer", "supplier", "internal"] as const;
const CHANNEL = ["sms", "email", "note", "app"] as const;

/** Who may be talked to down each channel. Internal has no outside path. */
const ALLOWED: Record<(typeof AUDIENCE)[number], readonly (typeof CHANNEL)[number][]> = {
  customer: ["email", "sms"],
  installer: ["sms", "app"],
  supplier: ["email"],
  internal: ["note"],
};

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

const fullName = (c: { firstName: string; lastName: string } | null | undefined) =>
  c ? `${c.firstName} ${c.lastName}`.trim() : "";

/** Pull @mentions out of an internal note and match them to staff by name. */
async function resolveMentions(body: string) {
  const handles = [...body.matchAll(/@([a-z][a-z0-9._-]*)/gi)].map((m) => m[1]!.toLowerCase());
  if (!handles.length) return [];
  const staff = await db
    .select({ id: schema.profiles.id, name: schema.profiles.name, email: schema.profiles.email })
    .from(schema.profiles)
    .where(eq(schema.profiles.active, true));

  const hit = new Set<number>();
  for (const h of handles) {
    for (const s of staff) {
      const first = s.name.split(/\s+/)[0]?.toLowerCase() ?? "";
      const handle = s.name.toLowerCase().replace(/\s+/g, "");
      const local = s.email.split("@")[0]?.toLowerCase() ?? "";
      if (h === first || h === handle || h === local) hit.add(s.id);
    }
  }
  return [...hit];
}

/** Everything the thread view needs, in one round trip. */
async function readThread(conversationId: number) {
  const [conv] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.id, conversationId))
    .limit(1);
  if (!conv) throw new ORPCError("NOT_FOUND", { message: "Conversation not found" });

  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));

  const ids = rows.map((r) => r.id);
  const stored = ids.length
    ? await db.select().from(schema.messageAttachments).where(inArray(schema.messageAttachments.messageId, ids))
    : [];
  /* Files sit in private storage, so each one gets a short-lived link. A row
   * with no storage key keeps whatever url it was written with. */
  const files = await Promise.all(
    stored.map(async (f) => ({ ...f, url: f.storageKey ? await signGet(f.storageKey) : f.url })),
  );
  const mentions = ids.length
    ? await db
        .select({
          messageId: schema.messageMentions.messageId,
          profileId: schema.messageMentions.profileId,
          name: schema.profiles.name,
        })
        .from(schema.messageMentions)
        .leftJoin(schema.profiles, eq(schema.profiles.id, schema.messageMentions.profileId))
        .where(inArray(schema.messageMentions.messageId, ids))
    : [];

  const participants = await db
    .select()
    .from(schema.conversationParticipants)
    .where(eq(schema.conversationParticipants.conversationId, conversationId));

  const messages = rows.map((m) => ({
    ...m,
    attachments: files.filter((f) => f.messageId === m.id),
    mentions: mentions.filter((x) => x.messageId === m.id).map((x) => x.name ?? ""),
  }));

  return {
    conversation: conv,
    /* Pinned is a view of the same messages, never a copy of them. */
    pinned: messages.filter((m) => m.pinnedAt != null),
    messages,
    participants,
  };
}

/**
 * Inbound messages this staff member has not seen, for the inbox.
 *
 * Read state is personal: it comes off your own participant row. But the office
 * shares the inbox, and somebody who was never added to a thread should not be
 * shouted at by every thread in the business, so when you have no row of your
 * own we fall back to the newest read by any staff member. Read by the office,
 * in other words. Once you open it, your own row governs.
 */
const unreadForSql = (me: number) => sql`(
  select count(*) from messages m
  where m.conversation_id = conversations.id
    and m.direction = 'in'
    and m.created_at > coalesce(
      (select p.last_read_at from conversation_participants p
        where p.conversation_id = conversations.id and p.profile_id = ${me}),
      (select max(p.last_read_at) from conversation_participants p
        where p.conversation_id = conversations.id and p.profile_id is not null),
      0)
)`;

/** Shared by the thread composer and by voice memo drafts, so a memo's email
 * or SMS goes out exactly the way a typed one does: logged on the thread, opt-out
 * on customer texts, two-way number, threaded email headers. */
export const sendInput = z.object({
  conversationId: z.number().optional(),
  jobId: z.number().optional(),
  quoteId: z.number().optional(),
  audience: z.enum(AUDIENCE),
  channel: z.enum(CHANNEL),
  subject: z.string().optional(),
  body: z.string().min(1),
  contactId: z.number().nullish(),
  installerId: z.number().nullish(),
  supplierId: z.number().nullish(),
  /** Email only. A typed address, used in place of the contact's own. */
  to: z.string().trim().max(200).optional(),
  cc: z.array(z.string().trim().max(200)).max(10).optional(),
  /** team@ unless Damien picks himself. Checked against who is sending. */
  mailbox: z.string().optional(),
  /** Files from the job file, and from the device (already in storage). */
  mediaIds: z.array(z.number().int()).max(20).optional(),
  uploads: z.array(uploadInput).max(20).optional(),
});

export async function sendConversationMessage(input: z.infer<typeof sendInput>, actor: Actor) {
  if (!ALLOWED[input.audience].includes(input.channel)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `A ${input.audience} message cannot go out as ${input.channel}.`,
    });
  }

  const conv = input.conversationId
    ? (await db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId)).limit(1))[0]
    : input.jobId
      ? await ensureForJob(input.jobId)
      : input.quoteId
        ? await ensureForQuote(input.quoteId)
        : null;
  if (!conv) throw new ORPCError("BAD_REQUEST", { message: "No conversation to send on." });

  const [profile] = await db
    .select({ id: schema.profiles.id })
    .from(schema.profiles)
    .where(eq(schema.profiles.userId, actor.userId))
    .limit(1);

  const common = {
    conversationId: conv.id,
    jobId: conv.jobId,
    contactId: input.contactId ?? null,
    installerId: input.installerId ?? null,
    supplierId: input.supplierId ?? null,
    authorName: actor.name || "Office",
    authorProfileId: profile?.id ?? null,
    direction: "out" as const,
  };

  /* ---------------- internal note: never leaves the building ------------- */
  if (input.audience === "internal") {
    const msg = await logMessage({
      ...common,
      channel: "note",
      audience: "internal",
      body: input.body,
      status: "sent",
    });
    const mentioned = await resolveMentions(input.body);
    if (mentioned.length) {
      await db
        .insert(schema.messageMentions)
        .values(mentioned.map((profileId) => ({ messageId: msg.id, profileId })));
    }
    return { ok: true as const, messageId: msg.id, mentioned: mentioned.length };
  }

  /* ---------------------------- SMS ------------------------------------- */
  if (input.channel === "sms") {
    const to =
      input.audience === "installer"
        ? (await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId ?? 0)).limit(1))[0]
            ?.mobile
        : (await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId ?? 0)).limit(1))[0]
            ?.mobile;

    if (!normaliseMobile(to)) {
      throw new ORPCError("BAD_REQUEST", { message: "No mobile on file for that recipient." });
    }

    /* A customer text gets the opt-out. Crew are staff, not a marketing
     * list, so theirs does not. */
    const body = input.audience === "customer" ? input.body + SMS_OPT_OUT : input.body;
    /* Operational texts invite a reply, so they must go from the two-way
     * number. Anything else sends a question into a void. */
    const out = await sendSms({ to: to!, body, sender: "number", needsReply: true });

    const msg = await logMessage({
      ...common,
      channel: "sms",
      audience: input.audience,
      body,
      toAddress: normaliseMobile(to),
      providerId: out.ok ? out.providerId : null,
      status: out.ok ? "sent" : "failed",
      statusDetail: out.ok ? null : out.reason,
      failedAt: out.ok ? null : new Date(),
    });

    if (input.contactId) {
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId)).limit(1);
      await addParticipant(conv.id, {
        role: "customer",
        contactId: input.contactId,
        name: fullName(c),
        email: c?.email ?? null,
        mobile: c?.mobile ?? null,
      });
    }
    if (input.installerId) {
      const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId)).limit(1);
      await addParticipant(conv.id, {
        role: "installer",
        installerId: input.installerId,
        name: i?.name ?? "",
        mobile: i?.mobile ?? null,
      });
    }

    if (!out.ok) return { ok: false as const, messageId: msg.id, reason: out.reason };
    return { ok: true as const, messageId: msg.id };
  }

  /* --------------------------- email ------------------------------------ */
  if (input.channel === "email") {
    const person =
      input.audience === "supplier"
        ? (await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId ?? 0)).limit(1))[0]
        : (await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId ?? 0)).limit(1))[0];
    const to = input.to?.trim() || (person as { email?: string | null } | undefined)?.email?.trim();
    if (!to) throw new ORPCError("BAD_REQUEST", { message: "No email address on file for that recipient." });
    for (const addr of [to, ...(input.cc ?? [])]) {
      if (!EMAIL_RE.test(addr)) throw new ORPCError("BAD_REQUEST", { message: `"${addr}" is not an email address.` });
    }

    /* damien@ is only offered to Damien, and only once it can send. */
    const mailbox = (input.mailbox || SEND_FROM).toLowerCase();
    if (mailbox !== SEND_FROM) {
      const allowed = (await sendersFor(actor.email)).find((s) => s.address === mailbox);
      if (!allowed) throw new ORPCError("FORBIDDEN", { message: "You can not send from that mailbox." });
      if (!allowed.ready) throw new ORPCError("BAD_REQUEST", { message: `${mailbox} ${allowed.note.charAt(0).toLowerCase()}${allowed.note.slice(1)}` });
    }

    /* A repair talks on its parent's thread, so its own job id rides along. It
     * must be one of this thread's jobs. */
    const jobId = input.jobId ?? conv.jobId ?? null;
    if (input.jobId && conv.jobId && input.jobId !== conv.jobId && !(await jobFamily(conv.jobId)).includes(input.jobId)) {
      throw new ORPCError("BAD_REQUEST", { message: "That job is not on this thread." });
    }

    const files = await pickedFiles({
      jobId,
      mediaIds: input.mediaIds,
      uploads: input.uploads,
      byName: common.authorName,
      byProfileId: common.authorProfileId,
    }).catch((e: unknown) => {
      throw new ORPCError("BAD_REQUEST", { message: String((e as Error)?.message ?? e) });
    });

    try {
      const sent = await sendJobEmail({
        conv,
        jobId,
        mailbox,
        to,
        cc: input.cc,
        subject: input.subject?.trim() || conv.subject,
        text: input.body,
        files,
        audience: input.audience === "supplier" ? "supplier" : "customer",
        contactId: input.contactId ?? null,
        supplierId: input.supplierId ?? null,
        authorName: common.authorName,
        authorProfileId: common.authorProfileId,
      });
      return { ok: true as const, messageId: sent.message.id, linked: sent.linked };
    } catch (e) {
      /* It did not go. Logged as failed so the thread is honest about it. */
      const reason = String((e as Error)?.message ?? e).slice(0, 300);
      const msg = await logMessage({
        ...common,
        channel: "email",
        audience: input.audience,
        subject: subjectWithRef(input.subject?.trim() || conv.subject, conv.ref),
        body: input.body,
        fromAddress: mailbox,
        toAddress: to,
        ccAddress: input.cc?.length ? input.cc.join(", ") : null,
        status: "failed",
        statusDetail: reason,
        failedAt: new Date(),
      });
      return { ok: false as const, messageId: msg.id, reason };
    }
  }

  throw new ORPCError("BAD_REQUEST", { message: "Nothing sends on that channel yet." });
}

export const conversations = {
  /** The thread on a job. Opens it, or adopts the quote's thread, on first look. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const conv = await ensureForJob(input.jobId);
    return readThread(conv.id);
  }),

  /** The thread on a quote, before the job exists. */
  forQuote: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const conv = await ensureForQuote(input.quoteId);
    return readThread(conv.id);
  }),

  thread: staffOnly.input(z.object({ conversationId: z.number() })).handler(({ input }) => readThread(input.conversationId)),

  /**
   * Who can be written to on this job, and how. The UI asks for this rather
   * than guessing, because a contact with `receivesSms` off is not a recipient
   * no matter how the office picks the channel.
   */
  recipients: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const contactRows = await db
      .select({ link: schema.jobContacts, contact: schema.contacts })
      .from(schema.jobContacts)
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
      .where(eq(schema.jobContacts.jobId, input.jobId));

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId)).limit(1);
    if (job?.contactId && !contactRows.some((r) => r.contact.id === job.contactId)) {
      const [owner] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId)).limit(1);
      if (owner) {
        contactRows.unshift({
          link: {
            id: -1,
            jobId: input.jobId,
            contactId: owner.id,
            role: job.companyId ? "other" : "owner",
            tags: JSON.stringify([job.companyId ? "other" : "owner"]),
            isPrimary: true,
            onSiteContact: false,
            receivesSms: true,
            receivesEmail: true,
            canApproveQuote: true,
            showToCrew: false,
            whenToContact: null,
            actedForCompanyId: null,
            createdAt: owner.createdAt,
            updatedAt: owner.updatedAt,
          },
          contact: owner,
        });
      }
    }

    // Crew on the job: whoever is on a task, lead or second.
    const taskRows = await db
      .select({
        lead: schema.jobTasks.assignedInstallerId,
        second: schema.jobTasks.secondInstallerId,
      })
      .from(schema.jobTasks)
      .where(eq(schema.jobTasks.jobId, input.jobId));

    const installerIds = [
      ...new Set(
        taskRows.flatMap((r) => [r.lead, r.second]).filter((id): id is number => typeof id === "number"),
      ),
    ];

    const crew = installerIds.length
      ? await db.select().from(schema.installers).where(inArray(schema.installers.id, installerIds))
      : [];

    return {
      customers: contactRows.map(({ link, contact }) => ({
        contactId: contact.id,
        name: fullName(contact),
        role: link.role,
        tags: parseTags(link.tags),
        email: contact.email,
        mobile: contact.mobile,
        receivesEmail: Boolean(link.receivesEmail) && Boolean(contact.email),
        receivesSms: Boolean(link.receivesSms) && Boolean(normaliseMobile(contact.mobile)),
      })),
      crew: crew.map((i) => ({ installerId: i.id, name: i.name, mobile: i.mobile })),
    };
  }),

  /** What a text will cost and how many parts it is, asked before sending. */
  smsCost: staffOnly.input(z.object({ body: z.string() })).handler(({ input }) => ({
    parts: smsParts(input.body + SMS_OPT_OUT),
    characters: input.body.length,
  })),

  /**
   * Send one message out, or write an internal note.
   *
   * Audience and channel are checked against each other server-side. Asking to
   * send an internal note to a customer is rejected rather than reinterpreted.
   */
  send: staffOnly
    .input(sendInput)
    .handler(({ input, context }) => sendConversationMessage(input, context.actor)),

  /**
   * Pin a message into "Important job information". Access codes, the colour
   * that was confirmed, the variation that was agreed: the things that must not
   * be twenty messages back when somebody needs them.
   */
  pin: staffOnly
    .input(z.object({ messageId: z.number(), label: z.string().max(60).optional() }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(schema.messages)
        .set({
          pinnedAt: new Date(),
          pinnedLabel: input.label ?? null,
          pinnedByName: context.actor.name || "Office",
          updatedAt: new Date(),
        })
        .where(eq(schema.messages.id, input.messageId))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND");
      return row;
    }),

  unpin: staffOnly.input(z.object({ messageId: z.number() })).handler(async ({ input }) => {
    await db
      .update(schema.messages)
      .set({ pinnedAt: null, pinnedLabel: null, pinnedByName: null, updatedAt: new Date() })
      .where(eq(schema.messages.id, input.messageId));
    return { ok: true };
  }),

  /** Mark the thread read for whoever is looking at it. Per person, not global. */
  markRead: staffOnly.input(z.object({ conversationId: z.number() })).handler(async ({ input, context }) => {
    const [profile] = await db
      .select({ id: schema.profiles.id, name: schema.profiles.name })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, context.actor.userId))
      .limit(1);
    if (!profile) return { ok: true };

    const existing = await addParticipant(input.conversationId, {
      role: "staff",
      profileId: profile.id,
      name: profile.name,
    });
    if (existing) {
      await db
        .update(schema.conversationParticipants)
        .set({ lastReadAt: new Date() })
        .where(eq(schema.conversationParticipants.id, existing.id));
    }
    return { ok: true };
  }),

  /** Every conversation Terra has ever had with one contact, newest first. */
  forContact: staffOnly.input(z.object({ contactId: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .select({
        conversation: schema.conversations,
        jobNumber: jobNumberSql,
        jobTitle: schema.jobs.title,
      })
      .from(schema.conversations)
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.conversations.jobId))
      .where(
        sql`conversations.contact_id = ${input.contactId} or exists (
          select 1 from conversation_participants p
          where p.conversation_id = conversations.id and p.contact_id = ${input.contactId})`,
      )
      .orderBy(desc(schema.conversations.lastMessageAt));
    return rows;
  }),

  /**
   * THE MASTER INBOX — every thread in the business in one list.
   *
   * Two dimensions, because they answer different questions.
   *
   * `lane` is WHO the talking is with: customers, installers, suppliers, or
   * the office talking among itself. It matches on the messages actually in
   * the thread, not on who happens to be listed on it, so "Customers" means
   * a customer has been written to or has written in.
   *
   * `kind` is WHAT it hangs off: a job, a quote not yet won, a client with no
   * work on the books, or an inbound nobody has matched to anything.
   *
   * Unread is personal, off your own read marker.
   */
  inbox: staffOnly
    .input(
      z
        .object({
          /** all · unread · customers · installers · suppliers · internal */
          lane: z
            .enum(["all", "unread", "customers", "installers", "suppliers", "internal"])
            .default("all"),
          /** all · jobs · quotes · clients · unmatched */
          kind: z.enum(["all", "jobs", "quotes", "clients", "unmatched"]).default("all"),
          search: z.string().optional(),
          /** Narrow to one company's threads, one staff member's, one date window. */
          companyId: z.number().int().optional(),
          staffProfileId: z.number().int().optional(),
          /** Job status name, e.g. "Scheduled". */
          jobStatus: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(60),
        })
        .default({ lane: "all", kind: "all", limit: 60 }),
    )
    .handler(async ({ input, context }) => {
      const [profile] = await db
        .select({ id: schema.profiles.id })
        .from(schema.profiles)
        .where(eq(schema.profiles.userId, context.actor.userId))
        .limit(1);
      const me = profile?.id ?? 0;

      const where: SQL[] = [];

      /* WHO the talking is with. Judged on the messages, not the guest list. */
      const hasAudience = (audience: string) => sql`exists (
        select 1 from messages m
        where m.conversation_id = conversations.id and m.audience = ${audience})`;
      if (input.lane === "customers") where.push(hasAudience("customer"));
      if (input.lane === "installers") where.push(hasAudience("installer"));
      if (input.lane === "suppliers") where.push(hasAudience("supplier"));
      if (input.lane === "internal") where.push(hasAudience("internal"));
      if (input.lane === "unread") where.push(sql`${unreadForSql(me)} > 0`);

      /* WHAT it hangs off. */
      if (input.kind === "jobs") where.push(sql`conversations.job_id is not null`);
      if (input.kind === "quotes")
        where.push(sql`conversations.job_id is null and conversations.quote_id is not null`);
      if (input.kind === "clients")
        where.push(sql`conversations.job_id is null and conversations.quote_id is null
          and conversations.contact_id is not null`);
      if (input.kind === "unmatched") where.push(sql`conversations.state = 'unassigned'`);

      if (input.companyId) {
        const cid = input.companyId;
        where.push(sql`(conversations.company_id = ${cid}
          or exists (select 1 from jobs j where j.id = conversations.job_id and j.company_id = ${cid}))`);
      }
      if (input.staffProfileId) {
        const sid = input.staffProfileId;
        where.push(sql`(
          exists (select 1 from conversation_participants p
            where p.conversation_id = conversations.id and p.profile_id = ${sid})
          or exists (select 1 from messages m
            where m.conversation_id = conversations.id and m.author_profile_id = ${sid}))`);
      }
      if (input.jobStatus)
        where.push(sql`exists (
          select 1 from jobs j join job_statuses st on st.id = j.status_id
          where j.id = conversations.job_id and st.name = ${input.jobStatus})`);
      if (input.from) {
        const from = Math.floor(new Date(`${input.from}T00:00:00`).getTime() / 1000);
        where.push(sql`coalesce(conversations.last_message_at, 0) >= ${from}`);
      }
      if (input.to) {
        const to = Math.floor(new Date(`${input.to}T23:59:59`).getTime() / 1000);
        where.push(sql`coalesce(conversations.last_message_at, 0) <= ${to}`);
      }

      /*
       * Search means search everything: the handle, the people, the job number
       * and address, the company, what was actually written, and the names of
       * the files that came with it.
       */
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        where.push(sql`(
          lower(conversations.subject) like ${q}
          or lower(conversations.ref) like ${q}
          or lower(coalesce(conversations.origin_quote_number, '')) like ${q}
          or lower(conversations.last_message_preview) like ${q}
          or exists (
            select 1 from conversation_participants p
            where p.conversation_id = conversations.id
              and (lower(p.name) like ${q} or lower(coalesce(p.email, '')) like ${q}
                or replace(coalesce(p.mobile, ''), ' ', '') like ${q}))
          or exists (
            select 1 from companies co
            where co.id = conversations.company_id and lower(co.name) like ${q})
          or exists (
            select 1 from jobs j
            left join sites s on s.id = j.site_id
            left join companies jco on jco.id = j.company_id
            where j.id = conversations.job_id
              and (cast(j.number as text) like ${q}
                or lower(coalesce(j.title, '')) like ${q}
                or lower(coalesce(s.address, '')) like ${q}
                or lower(coalesce(s.suburb, '')) like ${q}
                or lower(coalesce(jco.name, '')) like ${q}))
          or exists (
            select 1 from messages m
            where m.conversation_id = conversations.id
              and (lower(m.body) like ${q} or lower(coalesce(m.subject, '')) like ${q}
                or lower(coalesce(m.author_name, '')) like ${q}))
          or exists (
            select 1 from messages m join message_attachments a on a.message_id = m.id
            where m.conversation_id = conversations.id and lower(a.filename) like ${q})
        )`);
      }

      const rows = await db
        .select({
          conversation: schema.conversations,
          jobNumber: jobNumberSql,
          jobTitle: schema.jobs.title,
          jobStatus: schema.jobStatuses.name,
          siteAddress: schema.sites.address,
          siteSuburb: schema.sites.suburb,
          contactName: sql<string>`(
            select c.first_name || ' ' || c.last_name from contacts c where c.id = conversations.contact_id
          )`,
          companyName: sql<string>`(
            select co.name from companies co where co.id = conversations.company_id
          )`,
          /** The crew on the thread, so a row reads "Installer: John Smith". */
          installerNames: sql<string>`(
            select group_concat(p.name, ', ') from conversation_participants p
            where p.conversation_id = conversations.id and p.installer_id is not null
          )`,
          supplierNames: sql<string>`(
            select group_concat(p.name, ', ') from conversation_participants p
            where p.conversation_id = conversations.id and p.supplier_id is not null
          )`,
          /** Inbound messages you personally have not looked at yet. */
          unread: unreadForSql(me).mapWith(Number),
          messageCount: sql<number>`(
            select count(*) from messages m where m.conversation_id = conversations.id
          )`,
          /** How the last message travelled, so the row can show the right icon. */
          lastChannel: sql<string>`(
            select m.channel from messages m
            where m.conversation_id = conversations.id
            order by m.created_at desc, m.id desc limit 1
          )`,
          lastAudience: sql<string>`(
            select m.audience from messages m
            where m.conversation_id = conversations.id
            order by m.created_at desc, m.id desc limit 1
          )`,
          lastDirection: sql<string>`(
            select m.direction from messages m
            where m.conversation_id = conversations.id
            order by m.created_at desc, m.id desc limit 1
          )`,
          /** Who said it, so a row can read "Chris Doyle, installer". */
          lastAuthor: sql<string>`(
            select m.author_name from messages m
            where m.conversation_id = conversations.id
            order by m.created_at desc, m.id desc limit 1
          )`,
          /**
           * Email or text to someone that failed and has not gone since on the
           * same channel (30 Oct, 188048). "email", "sms", "email,sms" or null.
           */
          failedOut: sql<string | null>`(
            select group_concat(distinct f.channel) from messages f
            where f.conversation_id = conversations.id and f.direction = 'out' and f.status = 'failed'
              and f.channel in ('email', 'sms')
              and not exists (
                select 1 from messages s
                where s.conversation_id = f.conversation_id and s.channel = f.channel and s.direction = 'out'
                  and s.status = 'sent' and (s.created_at > f.created_at or (s.created_at = f.created_at and s.id > f.id))
              )
          )`,
          /** Whether anything is filed on this thread, shown as a clip. */
          attachmentCount: sql<number>`(
            select count(*) from messages m join message_attachments a on a.message_id = m.id
            where m.conversation_id = conversations.id
          )`,
        })
        .from(schema.conversations)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.conversations.jobId))
        .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.conversations.lastMessageAt), desc(schema.conversations.id))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r.conversation,
        jobNumber: r.jobNumber ?? null,
        jobTitle: r.jobTitle ?? "",
        jobStatus: r.jobStatus ?? "",
        siteAddress: r.siteAddress ?? "",
        siteSuburb: r.siteSuburb ?? "",
        contactName: (r.contactName ?? "").trim(),
        companyName: r.companyName ?? "",
        installerNames: r.installerNames ?? "",
        supplierNames: r.supplierNames ?? "",
        unread: Number(r.unread ?? 0),
        messageCount: Number(r.messageCount ?? 0),
        lastChannel: r.lastChannel ?? "note",
        lastAudience: r.lastAudience ?? "internal",
        lastDirection: r.lastDirection ?? "out",
        lastAuthor: r.lastAuthor ?? "",
        attachmentCount: Number(r.attachmentCount ?? 0),
        failedOut: (r.failedOut ?? "").split(",").filter(Boolean),
      }));
    }),

  /* ------------------------- job email thread (spec 15 Oct) ------------------------- */

  /** Which mailboxes you can send a job email from. damien@ only shows for Damien. */
  senders: staffOnly.handler(({ context }) => sendersFor(context.actor.email)),

  /** Somewhere for the browser to put a file picked from the device for an email. */
  uploadSlot: staffOnly
    .input(z.object({ filename: z.string().min(1).max(200), contentType: z.string().min(1).max(120), jobId: z.number().int().nullish() }))
    .handler(async ({ input }) => {
      const key = input.jobId ? mediaKey(input.jobId, bucketForMime(input.contentType), input.filename) : mailUploadKey(input.filename);
      return { url: await signPut(key, input.contentType), key };
    }),

  /** "Move to another job" on any email. The email and its files move, never copied. */
  moveMessage: staffOnly
    .input(z.object({ messageId: z.number().int(), jobId: z.number().int() }))
    .handler(async ({ input, context }) => {
      try {
        return await moveMessageToJob(input.messageId, input.jobId, context.actor.name);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
      }
    }),

  /** Email Terra could not place, with the sender's jobs to pick from. */
  unfiled: staffOnly.handler(() => unfiledList()),

  /** One tap filing from Unfiled. */
  fileUnfiled: staffOnly
    .input(z.object({ conversationId: z.number().int(), jobId: z.number().int() }))
    .handler(async ({ input, context }) => {
      try {
        return await fileHolding(input.conversationId, input.jobId, context.actor.name);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
      }
    }),

  /** "Not a job": off the Unfiled tray, kept for the record, and the sender ignored from now on if asked. */
  dismissUnfiled: staffOnly
    .input(z.object({ conversationId: z.number().int(), ignoreSender: z.boolean().default(false) }))
    .handler(async ({ input, context }) => {
      try {
        return await dismissHolding(input.conversationId, input.ignoreSender, context.actor.name);
      } catch (e) {
        throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
      }
    }),

  /** "New enquiry": a new job for the sender, and the email filed on it. */
  newEnquiry: staffOnly
    .input(z.object({ conversationId: z.number().int() }))
    .handler(async ({ input, context }) => {
      const who = await holdingSender(input.conversationId);
      if (!who || who.conv.state !== "unassigned") throw new ORPCError("BAD_REQUEST", { message: "That email has already been filed." });
      let contactId = who.contact?.id ?? null;
      if (!contactId) {
        if (!who.email) throw new ORPCError("BAD_REQUEST", { message: "There is no sender to make the enquiry for." });
        const parts = (who.name || who.email.split("@")[0] || "").trim().split(/\s+/);
        const [c] = await db
          .insert(schema.contacts)
          .values({ firstName: (parts[0] || who.email).slice(0, 80), lastName: parts.slice(1).join(" ").slice(0, 80), email: who.email, source: "email" })
          .returning({ id: schema.contacts.id });
        contactId = c!.id;
      }
      const job = await createJob(
        { title: (who.subject || "Email enquiry").slice(0, 200), contactId, source: "email", description: who.body.slice(0, 4000) },
        context.actor,
      );
      if (!job) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "The job was not made." });
      const out = await fileHolding(input.conversationId, job.id, context.actor.name);
      return { ...out, jobNumber: job.number };
    }),

  /** The numbers on the inbox filter chips, both dimensions at once. */
  inboxCounts: staffOnly.handler(async ({ context }) => {
    const [profile] = await db
      .select({ id: schema.profiles.id })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, context.actor.userId))
      .limit(1);
    const me = profile?.id ?? 0;

    const unreadExpr = sql`${unreadForSql(me)} > 0`;

    const lane = (audience: string) => sql<number>`sum(case when exists (
      select 1 from messages m
      where m.conversation_id = conversations.id and m.audience = ${audience}) then 1 else 0 end)`;

    const [row] = await db
      .select({
        all: sql<number>`count(*)`,
        unread: sql<number>`sum(case when ${unreadExpr} then 1 else 0 end)`,
        customers: lane("customer"),
        installers: lane("installer"),
        suppliers: lane("supplier"),
        internal: lane("internal"),
        jobs: sql<number>`sum(case when conversations.job_id is not null then 1 else 0 end)`,
        quotes: sql<number>`sum(case when conversations.job_id is null and conversations.quote_id is not null then 1 else 0 end)`,
        clients: sql<number>`sum(case when conversations.job_id is null and conversations.quote_id is null
          and conversations.contact_id is not null then 1 else 0 end)`,
        unmatched: sql<number>`sum(case when conversations.state = 'unassigned' then 1 else 0 end)`,
      })
      .from(schema.conversations);

    const n = (v: unknown) => Number(v ?? 0);
    return {
      all: n(row?.all),
      unread: n(row?.unread),
      customers: n(row?.customers),
      installers: n(row?.installers),
      suppliers: n(row?.suppliers),
      internal: n(row?.internal),
      jobs: n(row?.jobs),
      quotes: n(row?.quotes),
      clients: n(row?.clients),
      unmatched: n(row?.unmatched),
    };
  }),
};
