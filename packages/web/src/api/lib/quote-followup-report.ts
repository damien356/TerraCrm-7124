import { and, desc, eq, gt, inArray, like, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { dateIn, onOrAfterBusinessDay } from "./business-days";
import { addLocalDays, daysApart } from "./local-date";
import {
  FOLLOWUP_AUTHOR,
  MIN_GAP_DAYS,
  auDate,
  consentFor,
  followupSettings,
  type FollowupSettings,
  latestSent,
  layoutSteps,
  quoteFacts,
  quoteRefOf,
  threadsFor,
} from "./quote-followup";
import { FOLLOWUP_STEPS, renderFollowup, type FollowupStep } from "./quote-followup-wording";

/* ---------------------------------------------------------------------------
 * QUOTE FOLLOW-UPS: the backlog report and the numbers (28 Oct).
 *
 * Read only. Nothing here writes, enrols or sends. The backlog shows every
 * quote that is out with a customer, what has happened since, and what a
 * person could do about it. Starting follow-ups is one quote at a time from
 * the job, and never from a step that has already passed.
 * ------------------------------------------------------------------------- */

type Quote = typeof schema.quotes.$inferSelect;

export type BacklogAdvice =
  | "enrolled"
  | "start"
  | "replied"
  | "expired"
  | "expires_soon"
  | "too_old"
  | "no_contact"
  | "no_consent"
  | "has_job_stage";

const ADVICE_TEXT: Record<BacklogAdvice, string> = {
  enrolled: "Already has follow-ups.",
  start: "Could start follow-ups from the step shown. Read the draft first.",
  replied: "The customer has been in touch since it went. Answer them by hand. No follow-ups.",
  expired: "Expired. Review the prices and send a new version before any contact.",
  expires_soon: "Expires before the next follow-up would go. Call them, or review and send a new version.",
  too_old: "Past day 25. Too late for the sequence. Call them, or close it off.",
  no_contact: "Nobody on the quote with an email and a contact card. Fix the contact first.",
  no_consent: "The consent setting does not allow it for this contact.",
  has_job_stage: "The job has moved past Quoted. Check the quote status.",
};

const STAGE_PAST_QUOTED = new Set([3, 4, 5, 6, 7, 8, 9]);

/** The newest message in or out for a quote's people and threads, since a date. */
async function lastMessage(q: Quote, contactId: number | null, email: string | null, direction: "in" | "out", since: Date, alsoFrom: string[] = []) {
  const threads = await threadsFor({ quoteId: q.id, jobId: q.jobId });
  const who = [
    threads.length ? inArray(schema.messages.conversationId, threads) : null,
    contactId ? eq(schema.messages.contactId, contactId) : null,
    q.jobId ? eq(schema.messages.jobId, q.jobId) : null,
    email ? sql`lower(${direction === "in" ? schema.messages.fromAddress : schema.messages.toAddress}) like ${`%${email.toLowerCase()}%`}` : null,
    /* People copied in on the quote: a reply from any of them counts. */
    ...(direction === "in" ? alsoFrom.map((e) => sql`lower(${schema.messages.fromAddress}) like ${`%${e.toLowerCase()}%`}`) : []),
  ].filter(Boolean) as ReturnType<typeof eq>[];
  if (!who.length) return null;
  const [m] = await db
    .select({
      id: schema.messages.id,
      at: schema.messages.createdAt,
      channel: schema.messages.channel,
      author: schema.messages.authorName,
      label: schema.messages.label,
      status: schema.messages.status,
      subject: schema.messages.subject,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, direction),
        inArray(schema.messages.channel, ["email", "sms", "app"]),
        ne(schema.messages.audience, "installer"),
        ne(schema.messages.audience, "supplier"),
        direction === "in" ? eq(schema.messages.autoReply, false) : sql`1`,
        gt(schema.messages.createdAt, since),
        or(...who),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);
  return m ?? null;
}

async function failedTo(email: string | null, jobId: number | null) {
  const who = [email ? sql`lower(${schema.messages.toAddress}) = ${email.toLowerCase()}` : null, jobId ? eq(schema.messages.jobId, jobId) : null].filter(Boolean) as ReturnType<
    typeof eq
  >[];
  if (!who.length) return [];
  return db
    .select({ id: schema.messages.id, at: schema.messages.createdAt, detail: schema.messages.statusDetail, label: schema.messages.label })
    .from(schema.messages)
    .where(and(eq(schema.messages.direction, "out"), eq(schema.messages.status, "failed"), or(...who)))
    .orderBy(desc(schema.messages.id))
    .limit(5);
}

/** One quote number for the backlog, or null when it is not out with the customer. */
async function backlogRowFor(number: number, s: FollowupSettings, now: Date, tidy: Array<{ quoteId: number; ref: string; note: string }>) {
    const versions = await db.select().from(schema.quotes).where(eq(schema.quotes.number, number)).orderBy(desc(schema.quotes.version));
    const won = versions.find((v) => v.status === "accepted" || v.status === "replaced");
    const sent = latestSent(versions);
    /* Older versions left on "sent" after a newer one went or one was accepted. Shown so a person can tidy them. */
    for (const v of versions)
      if (v.status === "sent" && ((won && v.id !== won.id) || (sent && v.id !== sent.id)))
        tidy.push({ quoteId: v.id, ref: quoteRefOf(v), note: won ? `Still marked sent, but ${quoteRefOf(won)} was accepted.` : `Still marked sent, but ${quoteRefOf(sent!)} replaced it.` });
    if (won || !sent) return null;

    const qf = await quoteFacts(sent.id, { makeLink: false });
    if (!qf) return null;
    const today = dateIn(qf.timeZone, now);
    const ageDays = daysApart(qf.sentDate, today);
    const firstSentAt = versions.reduce<Date | null>((a, v) => (v.sentAt && (!a || v.sentAt < a) ? v.sentAt : a), null) ?? sent.sentAt!;
    const email = qf.recipient?.email ?? null;
    const contactId = qf.contact?.id ?? null;
    const lastIn = await lastMessage(sent, contactId, email, "in", sent.sentAt ?? firstSentAt, qf.cc.map((c) => c.email));
    const lastOut = await lastMessage(sent, contactId, email, "out", firstSentAt);
    const [link] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.quoteId, sent.id));
    const [seq] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.quoteNumber, number));
    const seqSteps = seq ? await db.select().from(schema.quoteFollowupSteps).where(eq(schema.quoteFollowupSteps.followupId, seq.id)) : [];
    const failed = await failedTo(email, sent.jobId);
    const consentMarketing = qf.contact ? await consentFor(qf.contact, "marketing") : null;
    const consentRequest = qf.contact ? await consentFor(qf.contact, "quote_request") : null;
    const consentNow = s.consent === "marketing" ? consentMarketing : consentRequest;
    const daysLeft = qf.validUntilDate ? daysApart(today, qf.validUntilDate) : null;

    /* The step it could start from: the first one still ahead, laid out from tomorrow, and only if it lands before expiry. */
    let startStep: FollowupStep | null = null;
    let startDate: string | null = null;
    const ahead = FOLLOWUP_STEPS.filter((st) => st > ageDays);
    let plan: ReturnType<typeof layoutSteps> = [];
    if (ahead.length) {
      plan = layoutSteps(
        qf.sentDate,
        FOLLOWUP_STEPS.map((step) => ({ step, status: step > ageDays ? "scheduled" : "skipped" })),
        { showDays: s.showDays, floor: onOrAfterBusinessDay(addLocalDays(today, 1), s.showDays) },
      );
      const first = plan.find((p) => p.status === "scheduled")!;
      if (!qf.validUntilDate || first.dueDate < qf.validUntilDate) {
        startStep = first.step;
        startDate = first.dueDate;
      }
    }

    let advice: BacklogAdvice;
    if (seq) advice = "enrolled";
    else if (qf.validUntilDate && qf.validUntilDate <= today) advice = "expired";
    else if (qf.jobStatusId && STAGE_PAST_QUOTED.has(qf.jobStatusId)) advice = "has_job_stage";
    else if (lastIn) advice = "replied";
    else if (!qf.recipient || !qf.contact) advice = "no_contact";
    else if (!consentNow?.allowed) advice = "no_consent";
    else if (!ahead.length) advice = "too_old";
    else if (!startStep) advice = "expires_soon";
    else advice = "start";

    let draft = null;
    if (startStep && (advice === "start" || advice === "no_consent")) {
      /* The first email that would actually go: a day 7 with no prep is skipped, so the draft is the one after. */
      for (const p of plan) {
        if (p.status !== "scheduled" || p.step < startStep) continue;
        if (qf.validUntilDate && p.dueDate >= qf.validUntilDate) break;
        const r = renderFollowup(p.step, { ...qf.facts, link: qf.facts.link ?? "(the quote link goes in when it sends)" }, Math.max(1, Math.round(daysApart(qf.sentDate, p.dueDate) / 7)));
        if (r.skip) continue;
        draft = { step: p.step, date: p.dueDate, subject: r.subject, text: r.text, words: r.words, review: r.review, notes: r.notes, skip: null };
        break;
      }
    }

    return {
      number,
      quoteId: sent.id,
      ref: quoteRefOf(sent),
      jobId: sent.jobId,
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, sentAt: v.sentAt })),
      customer: qf.facts.companyName ?? (qf.contact ? `${qf.contact.firstName ?? ""} ${qf.contact.lastName ?? ""}`.trim() : null),
      audience: qf.audience,
      to: email,
      total: sent.total,
      sentDate: qf.sentDate,
      ageDays,
      validUntil: qf.validUntilDate,
      daysLeft,
      views: link?.views ?? 0,
      lastViewedAt: link?.lastViewedAt ?? null,
      lastIn: lastIn ? { at: lastIn.at, channel: lastIn.channel, subject: lastIn.subject } : null,
      lastOut: lastOut ? { at: lastOut.at, channel: lastOut.channel, author: lastOut.author, label: lastOut.label, status: lastOut.status } : null,
      consent: {
        marketing: consentMarketing ? (consentMarketing.allowed ? "ok" : consentMarketing.reason) : "no contact",
        quoteRequest: consentRequest ? (consentRequest.allowed ? "ok" : consentRequest.reason) : "no contact",
      },
      followups: seq ? { status: seq.status, reason: seq.reason, sent: seqSteps.filter((x) => x.status === "sent").length, failed: seqSteps.filter((x) => x.status === "failed").length } : null,
      errors: failed.map((f) => ({ at: f.at, label: f.label, detail: (f.detail ?? "").slice(0, 200) })),
      advice,
      adviceText: ADVICE_TEXT[advice] + (advice === "start" && startStep ? ` Day ${startStep} on ${auDate(startDate!)}.` : ""),
      draft,
    };
  }

export type BacklogRow = NonNullable<Awaited<ReturnType<typeof backlogRowFor>>>;

/** Every quote out with a customer, newest send first. Read only. */
export async function followupBacklog(now: Date = new Date()) {
  const s = await followupSettings();
  const sentRows = await db.select().from(schema.quotes).where(eq(schema.quotes.status, "sent"));
  const numbers = [...new Set(sentRows.map((q) => q.number))];
  const rows: BacklogRow[] = [];
  const tidy: Array<{ quoteId: number; ref: string; note: string }> = [];
  for (const number of numbers) {
    const row = await backlogRowFor(number, s, now, tidy);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => (a.sentDate < b.sentDate ? 1 : a.sentDate > b.sentDate ? -1 : b.number - a.number));
  return {
    settings: s,
    rows,
    tidy,
    counts: Object.fromEntries((Object.keys(ADVICE_TEXT) as BacklogAdvice[]).map((k) => [k, rows.filter((r) => r.advice === k).length])) as Record<BacklogAdvice, number>,
    notes: [
      `No two follow-ups are ever closer than ${MIN_GAP_DAYS} days. Steps that have passed are skipped, never sent late.`,
      "Delivered, bounced and spam complaints are not reported back to Terra Ops (no mail webhook). Only sent or failed is known.",
    ],
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

/**
 * What the follow-ups did. Replies, acceptances and time to accept, against
 * quotes sent in the same period without follow-ups. Opens are not counted:
 * these emails carry no tracking pixel.
 */
export async function followupMetrics(now: Date = new Date()) {
  const seqs = await db.select().from(schema.quoteFollowups);
  const steps = await db.select().from(schema.quoteFollowupSteps);
  const byStatus = (xs: { status: string }[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x.status] = (a[x.status] ?? 0) + 1), a), {});
  const seqNumbers = new Set(seqs.map((x) => x.quoteNumber));

  let replied = 0;
  let accepted = 0;
  let unsubscribed = 0;
  const daysToAccept: number[] = [];
  for (const seq of seqs) {
    const mine = steps.filter((x) => x.followupId === seq.id && x.status === "sent" && x.sentAt);
    const first = mine.reduce<Date | null>((a, x) => (!a || x.sentAt! < a ? x.sentAt! : a), null);
    if (!first) continue;
    const versions = await db.select().from(schema.quotes).where(eq(schema.quotes.number, seq.quoteNumber));
    const paused = await db
      .select({ id: schema.activityLog.id })
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "quote"),
          inArray(schema.activityLog.entityId, versions.map((v) => v.id)),
          eq(schema.activityLog.action, "followup_paused"),
          eq(schema.activityLog.actorName, FOLLOWUP_AUTHOR),
          like(schema.activityLog.detail, "%The customer sent%"),
          gt(schema.activityLog.createdAt, first),
        ),
      )
      .limit(1);
    if (paused.length) replied++;
    const won = versions.find((v) => v.acceptedAt && (v.status === "accepted" || v.status === "replaced"));
    if (won?.acceptedAt && won.acceptedAt > first) {
      accepted++;
      daysToAccept.push(daysApart(seq.anchorDate, dateIn(seq.timeZone, won.acceptedAt)));
    }
    if (seq.contactId) {
      const [u] = await db
        .select({ id: schema.unsubscribes.id })
        .from(schema.unsubscribes)
        .where(and(eq(schema.unsubscribes.contactId, seq.contactId), gt(schema.unsubscribes.createdAt, first)))
        .limit(1);
      if (u) unsubscribed++;
    }
  }
  const withSent = seqs.filter((seq) => steps.some((x) => x.followupId === seq.id && x.status === "sent")).length;

  /* The comparison: quotes first sent in the last 180 days that never had follow-ups. */
  const since = new Date(now.getTime() - 180 * 86400_000);
  const recent = await db.select().from(schema.quotes).where(and(gt(schema.quotes.sentAt, since)));
  const groups = new Map<number, (typeof recent)[number][]>();
  for (const q of recent) if (!seqNumbers.has(q.number)) groups.set(q.number, [...(groups.get(q.number) ?? []), q]);
  const baseDays: number[] = [];
  let baseAccepted = 0;
  /* Signed within the hour it was sent: accepted with the office, not a decision a follow-up could change. */
  let onTheSpot = 0;
  for (const [, vs] of groups) {
    const firstSent = vs.reduce<Date | null>((a, v) => (v.sentAt && (!a || v.sentAt < a) ? v.sentAt : a), null);
    const won = vs.find((v) => v.acceptedAt && (v.status === "accepted" || v.status === "replaced"));
    if (won?.acceptedAt && firstSent && won.acceptedAt.getTime() - firstSent.getTime() < 3600_000) onTheSpot++;
    else if (won?.acceptedAt && firstSent) {
      baseAccepted++;
      baseDays.push(daysApart(dateIn("Australia/Brisbane", firstSent), dateIn("Australia/Brisbane", won.acceptedAt)));
    }
  }
  const failedMsgs = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.messages)
    .where(and(eq(schema.messages.authorName, FOLLOWUP_AUTHOR), eq(schema.messages.status, "failed")));

  return {
    sequences: { total: seqs.length, byStatus: byStatus(seqs), withASend: withSent },
    steps: {
      byStatus: byStatus(steps),
      attempts: steps.reduce((a, x) => a + x.attempts, 0),
    },
    followedUp: {
      replied,
      accepted,
      unsubscribed,
      medianDaysToAccept: median(daysToAccept),
    },
    withoutFollowups: { quotes: groups.size, accepted: baseAccepted, acceptedWithinTheHour: onTheSpot, medianDaysToAccept: median(baseDays) },
    failures: Number(failedMsgs[0]?.n ?? 0),
    notTracked: ["Delivered, bounced and complaints: no mail webhook, so only sent or failed is known.", "Opens: no tracking pixel on these emails."],
  };
}
