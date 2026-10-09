import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { conversationIdFromAddress } from "./email";

/* ---------------------------------------------------------------------------
 * The conversation service. Everything that writes to a thread goes through
 * here, so the rules hold no matter which screen or webhook is calling.
 *
 * The one that matters most: a quote and the job it becomes share ONE thread.
 * `ensureForJob` will ADOPT the quote's existing conversation rather than open
 * a new one, which is why the office can scroll back past the conversion and
 * still read what was agreed before the job existed.
 * ------------------------------------------------------------------------- */

/** The handle that goes in a subject line. Humans read it, code never trusts it. */
export const jobRef = (job: { number: number; displayNumber?: string | null }) => `Terra #${job.displayNumber || job.number}`;
/** "Terra Q188000". Older threads carry "Terra Q-1042", and both read back the same. */
export const quoteRef = (number: number) => `Terra Q${number}`;

/** Pull a job, repair or quote number back out of a subject line, if it is still intact. */
export function refInSubject(subject: string): { job?: number; repair?: string; quote?: number } {
  const repair = subject.match(/terra\s*#\s*r\s*(\d+)\s*-\s*(\d+)/i);
  if (repair?.[1] && repair[2]) return { repair: `R${repair[1]}-${repair[2]}` };
  const job = subject.match(/terra\s*#\s*(\d+)/i);
  if (job?.[1]) return { job: Number(job[1]) };
  const quote = subject.match(/terra\s*q-?\s*(\d+)/i);
  if (quote?.[1]) return { quote: Number(quote[1]) };
  return {};
}

/** Put the handle on the subject once, never twice. */
export function subjectWithRef(subject: string, ref: string) {
  const clean = subject.replace(/\[?\s*terra\s*#?\s*q?-?\s*\d+\s*\]?/gi, "").trim();
  return `[${ref}] ${clean || "Your job with Terra Flooring"}`.trim();
}

const preview = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 160);

/**
 * The thread for a job. Opens one if there is none, and adopts the quote's
 * thread when the job came from a quote, so the history is continuous.
 */
export async function ensureForJob(jobId: number) {
  const [existing] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.jobId, jobId))
    .limit(1);
  if (existing) return existing;

  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) throw new Error(`job ${jobId} not found`);

  /* Did this job come from a quote that people were already talking on? */
  const quoteRows = await db
    .select({ id: schema.quotes.id, number: schema.quotes.number })
    .from(schema.quotes)
    .where(eq(schema.quotes.jobId, jobId));

  if (quoteRows.length) {
    const [adoptable] = await db
      .select()
      .from(schema.conversations)
      .where(
        and(
          inArray(
            schema.conversations.quoteId,
            quoteRows.map((q) => q.id),
          ),
          isNull(schema.conversations.jobId),
        ),
      )
      .orderBy(desc(schema.conversations.lastMessageAt))
      .limit(1);

    if (adoptable) {
      /* The same row moves across. A second thread is never started, because
       * the customer never started a second conversation. */
      const [moved] = await db
        .update(schema.conversations)
        .set({
          jobId,
          ref: jobRef(job),
          state: "open",
          contactId: adoptable.contactId ?? job.contactId ?? null,
          companyId: adoptable.companyId ?? job.companyId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.conversations.id, adoptable.id))
        .returning();
      /* Backfill the job onto the messages that were written before it existed. */
      await db
        .update(schema.messages)
        .set({ jobId })
        .where(eq(schema.messages.conversationId, adoptable.id));
      return moved!;
    }
  }

  const firstQuote = quoteRows[0];
  const [created] = await db
    .insert(schema.conversations)
    .values({
      ref: jobRef(job),
      subject: job.title || `Job ${job.number}`,
      jobId,
      quoteId: firstQuote?.id ?? null,
      originQuoteNumber: firstQuote ? `Q${firstQuote.number}` : null,
      contactId: job.contactId ?? null,
      companyId: job.companyId ?? null,
      state: "open",
    })
    .returning();
  return created!;
}

/** The thread for a quote, before any job exists. */
export async function ensureForQuote(quoteId: number) {
  const [existing] = await db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.quoteId, quoteId))
    .limit(1);
  if (existing) return existing;

  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId)).limit(1);
  if (!quote) throw new Error(`quote ${quoteId} not found`);

  if (quote.jobId) return ensureForJob(quote.jobId);

  const [created] = await db
    .insert(schema.conversations)
    .values({
      ref: quoteRef(quote.number),
      subject: `Quote Q${quote.number}`,
      quoteId,
      originQuoteNumber: `Q${quote.number}`,
      contactId: quote.contactId ?? null,
      companyId: quote.companyId ?? null,
      state: "open",
    })
    .returning();
  return created!;
}

/** Make sure somebody is on the participant list, without duplicating them. */
export async function addParticipant(
  conversationId: number,
  who: {
    role: "customer" | "installer" | "supplier" | "staff" | "other";
    contactId?: number | null;
    installerId?: number | null;
    supplierId?: number | null;
    profileId?: number | null;
    name?: string;
    email?: string | null;
    mobile?: string | null;
  },
) {
  const match = [eq(schema.conversationParticipants.conversationId, conversationId)];
  const identity = who.contactId
    ? eq(schema.conversationParticipants.contactId, who.contactId)
    : who.installerId
      ? eq(schema.conversationParticipants.installerId, who.installerId)
      : who.supplierId
        ? eq(schema.conversationParticipants.supplierId, who.supplierId)
        : who.profileId
          ? eq(schema.conversationParticipants.profileId, who.profileId)
          : who.email
            ? eq(schema.conversationParticipants.email, who.email)
            : null;
  if (!identity) return null;

  const [found] = await db
    .select()
    .from(schema.conversationParticipants)
    .where(and(...match, identity))
    .limit(1);
  if (found) return found;

  const [created] = await db
    .insert(schema.conversationParticipants)
    .values({
      conversationId,
      role: who.role,
      contactId: who.contactId ?? null,
      installerId: who.installerId ?? null,
      supplierId: who.supplierId ?? null,
      profileId: who.profileId ?? null,
      name: who.name ?? "",
      email: who.email ?? null,
      mobile: who.mobile ?? null,
    })
    .returning();
  return created!;
}

export interface LogArgs {
  conversationId: number;
  jobId?: number | null;
  contactId?: number | null;
  installerId?: number | null;
  supplierId?: number | null;
  channel: "sms" | "email" | "note" | "app";
  audience: "customer" | "installer" | "supplier" | "internal";
  direction: "in" | "out";
  body: string;
  bodyHtml?: string | null;
  subject?: string | null;
  authorName?: string;
  authorProfileId?: number | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  messageIdHeader?: string | null;
  inReplyTo?: string | null;
  referencesHeader?: string | null;
  providerId?: string | null;
  status?: string;
  statusDetail?: string | null;
  deliveredAt?: Date | null;
  failedAt?: Date | null;
}

/** Write one message and move the thread's clock forward. */
export async function logMessage(args: LogArgs) {
  const [row] = await db
    .insert(schema.messages)
    .values({
      conversationId: args.conversationId,
      jobId: args.jobId ?? null,
      contactId: args.contactId ?? null,
      installerId: args.installerId ?? null,
      supplierId: args.supplierId ?? null,
      channel: args.channel,
      audience: args.audience,
      direction: args.direction,
      subject: args.subject ?? null,
      body: args.body,
      bodyHtml: args.bodyHtml ?? null,
      authorName: args.authorName ?? "",
      authorProfileId: args.authorProfileId ?? null,
      fromAddress: args.fromAddress ?? null,
      toAddress: args.toAddress ?? null,
      messageIdHeader: args.messageIdHeader ?? null,
      inReplyTo: args.inReplyTo ?? null,
      referencesHeader: args.referencesHeader ?? null,
      providerId: args.providerId ?? null,
      status: args.status ?? (args.direction === "in" ? "received" : "sent"),
      statusDetail: args.statusDetail ?? null,
      deliveredAt: args.deliveredAt ?? null,
      failedAt: args.failedAt ?? null,
    })
    .returning();

  await db
    .update(schema.conversations)
    .set({
      lastMessageAt: row!.createdAt,
      lastMessagePreview: preview(args.body),
      updatedAt: new Date(),
    })
    .where(eq(schema.conversations.id, args.conversationId));

  return row!;
}

/**
 * The headers an outgoing reply needs so the customer's mail client threads it
 * under what they already have. Built off the newest message on the thread that
 * actually carried a Message-ID.
 */
export async function threadHeaders(conversationId: number) {
  const [last] = await db
    .select({
      messageIdHeader: schema.messages.messageIdHeader,
      referencesHeader: schema.messages.referencesHeader,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.channel, "email"),
        sql`${schema.messages.messageIdHeader} is not null`,
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);

  if (!last?.messageIdHeader) return {};
  const refs = [last.referencesHeader, last.messageIdHeader].filter(Boolean).join(" ").trim();
  return { inReplyTo: last.messageIdHeader, references: refs };
}

/**
 * Where does an inbound email belong? Tried in order of how much we can trust
 * it: the real headers first, the subject handle second, the sender's address
 * last. Returning null is a legitimate answer and means "unassigned", which the
 * office resolves by hand rather than the code guessing.
 */
export async function matchInboundEmail(input: {
  subject: string;
  inReplyTo?: string | null;
  references?: string | null;
  fromEmail: string;
  /** Every address the mail was addressed to, including the reply-to we set. */
  toAddresses?: string[];
}) {
  /* 0. The address they replied TO. The strongest signal there is, because we
   * put the conversation id in it ourselves. */
  for (const addr of input.toAddresses ?? []) {
    const id = conversationIdFromAddress(addr);
    if (!id) continue;
    const [conv] = await db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, id))
      .limit(1);
    if (conv) return { conversationId: conv.id, how: "reply-address" as const };
  }

  /* 1. Headers. Reliable on the second reply onwards. */
  const ids = [
    ...(input.inReplyTo ? [input.inReplyTo] : []),
    ...(input.references ?? "").split(/\s+/).filter(Boolean),
  ].map((s) => s.trim());

  if (ids.length) {
    const [hit] = await db
      .select({ conversationId: schema.messages.conversationId })
      .from(schema.messages)
      .where(inArray(schema.messages.messageIdHeader, ids))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (hit?.conversationId) return { conversationId: hit.conversationId, how: "headers" as const };
  }

  /* 2. The handle in the subject, when it survived the round trip. */
  const ref = refInSubject(input.subject);
  if (ref.repair) {
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.displayNumber, ref.repair)).limit(1);
    if (job) {
      const conv = await ensureForJob(job.id);
      return { conversationId: conv.id, how: "subject" as const };
    }
  }
  if (ref.job) {
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.number, ref.job)).limit(1);
    if (job) {
      const conv = await ensureForJob(job.id);
      return { conversationId: conv.id, how: "subject" as const };
    }
  }
  if (ref.quote) {
    const [quote] = await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(eq(schema.quotes.number, ref.quote))
      .limit(1);
    if (quote) {
      const conv = await ensureForQuote(quote.id);
      return { conversationId: conv.id, how: "subject" as const };
    }
  }

  return null;
}

/**
 * Who sent this, if Terra knows them. Used to suggest jobs for an unassigned
 * email rather than to file it automatically: one builder's office address is
 * on thirty jobs, so the address narrows the list, it does not pick.
 */
export async function contactByEmail(email: string) {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  const [found] = await db
    .select()
    .from(schema.contacts)
    .where(sql`lower(coalesce(${schema.contacts.email}, '')) = ${e}`)
    .limit(1);
  return found ?? null;
}

/** Same question for an SMS, by mobile number. */
export async function contactByMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, "").slice(-9);
  if (digits.length < 8) return null;
  const [found] = await db
    .select()
    .from(schema.contacts)
    .where(
      or(
        sql`replace(replace(replace(coalesce(${schema.contacts.mobile}, ''), ' ', ''), '+', ''), '-', '') like ${"%" + digits}`,
        sql`replace(replace(replace(coalesce(${schema.contacts.phone}, ''), ' ', ''), '+', ''), '-', '') like ${"%" + digits}`,
      ),
    )
    .limit(1);
  return found ?? null;
}

/** Open a holding thread for mail Terra cannot place. A real state, not a bin. */
export async function openUnassigned(input: {
  subject: string;
  contactId?: number | null;
  companyId?: number | null;
}) {
  const [created] = await db
    .insert(schema.conversations)
    .values({
      ref: "Unassigned",
      subject: input.subject.slice(0, 200),
      state: "unassigned",
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
    })
    .returning();
  return created!;
}

/**
 * The client-level thread: a person with no job or quote to hang the talk off,
 * e.g. a voice memo email to a brand new enquiry. Reuses their open one.
 */
export async function ensureForContact(contactId: number, subject: string) {
  const [existing] = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.contactId, contactId),
        isNull(schema.conversations.jobId),
        isNull(schema.conversations.quoteId),
        eq(schema.conversations.state, "open"),
      ),
    )
    .orderBy(desc(schema.conversations.lastMessageAt))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(schema.conversations)
    .values({
      ref: "Terra Flooring",
      subject: subject.slice(0, 200) || "Terra Flooring",
      contactId,
      state: "open",
    })
    .returning();
  return created!;
}
