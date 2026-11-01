import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { dateIn, onOrAfterBusinessDay, zonedTimeOn } from "./business-days";
import { CARE_FLOOR_LABELS } from "./care-codes";
import { careSettings, completedStatusIds, jobCareFacts } from "./care-engine";
import { blockFor, commsEvent, confirmLine, jobComms, snapshotChange, snapshotOf, type CommsRole, type JobCommsContext, type JobPerson } from "./comms-people";
import { addLocalDays } from "./local-date";
import { isLiveServer } from "./runtime";
import { sendMarketing } from "./marketing";
import { smsParts } from "./sms";

/* ---------------------------------------------------------------------------
 * REVIEW REQUESTS (Damien, 31 Oct). One sequence per job.
 *
 *   - Nothing goes until BOTH the job is confirmed complete (completed date set
 *     and the status is Complete, Invoiced or Paid) AND a person has approved
 *     who gets it. Approving never sends at once: it shows the next planned
 *     send, which is always a later 10am on a business day.
 *   - Insurance jobs: the homeowner only, one text, no reminder. The next
 *     business day at 10am after completion and approval.
 *   - Everyone else: 2 business days after completion at 10am, then one
 *     reminder 7 days later. At most 2 requests across email and text.
 *   - Builder type jobs (builder, property manager, real estate, commercial):
 *     the supervisor OR the homeowner, never both.
 *   - One sequence per job. Changing the person or the channel never resets
 *     the count.
 *   - A reply pauses it for the office to look at. A review on Google is not
 *     detected, so the office presses "Review received — stop reminders". A link
 *     click is not a review.
 *   - Every send goes through sendMarketing: unsubscribes, quiet hours, the 24
 *     hour rule and the unsubscribe footer all apply.
 *   - A send missed by more than a day is never sent late in a burst: the first
 *     request moves to the next 10am slot, a late reminder is not sent.
 * ------------------------------------------------------------------------- */

export const REVIEW_ON_KEY = "review_on";
export const REVIEW_LINK_KEY = "review_link";
export const REVIEW_STARTED_KEY = "review_started_at";
export const REVIEW_AUTHOR = "Terra Ops (review requests)";
const SEND_HOUR = "10:00";
const TZ = "Australia/Brisbane";
const REMINDER_DAYS = 7;
const LATE_MS = 26 * 3600_000;
const STALE_SENDING_MS = 10 * 60_000;

type Review = typeof schema.reviewRequests.$inferSelect;
type Patch = Partial<typeof schema.reviewRequests.$inferInsert>;

/* ------------------------------ settings --------------------------------- */

export type ReviewSettings = { on: boolean; link: string; startedAt: Date | null };

export async function reviewSettings(): Promise<ReviewSettings> {
  const rows = await db.select().from(schema.settings).where(inArray(schema.settings.key, [REVIEW_ON_KEY, REVIEW_LINK_KEY, REVIEW_STARTED_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const started = Number(v.get(REVIEW_STARTED_KEY) ?? "");
  return {
    /* Off unless someone switched it on. */
    on: v.get(REVIEW_ON_KEY) === "1",
    link: (v.get(REVIEW_LINK_KEY) ?? "").trim(),
    startedAt: Number.isFinite(started) && started > 0 ? new Date(started) : null,
  };
}

async function writeSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export async function saveReviewSettings(a: { on?: boolean; link?: string }) {
  if (a.link !== undefined) {
    const link = a.link.trim();
    if (link && !/^https:\/\/\S+$/i.test(link)) throw new Error("The review link must start with https://");
    await writeSetting(REVIEW_LINK_KEY, link);
  }
  if (a.on !== undefined) {
    if (a.on && !(await reviewSettings()).link) throw new Error("Add the Google review link first.");
    await writeSetting(REVIEW_ON_KEY, a.on ? "1" : "0");
    /* The first switch on sets the start, so old jobs are never asked by surprise. */
    if (a.on && !(await reviewSettings()).startedAt) await writeSetting(REVIEW_STARTED_KEY, String(Date.now()));
  }
  return reviewSettings();
}

/* ------------------------------ rules ------------------------------------ */

export const maxSendsFor = (ctx: Pick<JobCommsContext, "type">) => (ctx.type === "insurance" ? 1 : 2);
export const channelsFor = (ctx: Pick<JobCommsContext, "type">): Array<"email" | "sms"> => (ctx.type === "insurance" ? ["sms"] : ["email", "sms"]);

/** Confirmed completion: a completed date AND a Complete, Invoiced or Paid status. */
export async function completionOf(job: Pick<typeof schema.jobs.$inferSelect, "completedAt" | "statusId">): Promise<Date | null> {
  if (!job.completedAt) return null;
  const ids = await completedStatusIds();
  return job.statusId != null && ids.includes(job.statusId) ? job.completedAt : null;
}

/** n business days after a moment, at 10am Brisbane. Never the same day. */
export function businessDaysAfter(at: Date, n: number) {
  let d = dateIn(TZ, at);
  for (let i = 0; i < n; i++) d = onOrAfterBusinessDay(addLocalDays(d, 1));
  return zonedTimeOn(d, SEND_HOUR, TZ);
}

/** The first request: from completion, and never before the business day after approval. */
export function planInitial(ctx: Pick<JobCommsContext, "type">, completedAt: Date, approvedAt: Date) {
  const base = businessDaysAfter(completedAt, ctx.type === "insurance" ? 1 : 2);
  const afterApproval = businessDaysAfter(approvedAt, 1);
  return base.getTime() >= afterApproval.getTime() ? base : afterApproval;
}

/** The reminder: 7 days after the first went, on a business day, at 10am. */
export function planReminder(lastSentAt: Date) {
  const d = onOrAfterBusinessDay(addLocalDays(dateIn(TZ, lastSentAt), REMINDER_DAYS));
  return zonedTimeOn(d, SEND_HOUR, TZ);
}

/* ------------------------------ wording (section 7) ---------------------- */

const FLOOR_WORDS: Record<string, string> = {
  carpet: "carpet",
  vinyl_plank: "vinyl plank flooring",
  hybrid: "hybrid flooring",
  laminate: "laminate flooring",
  engineered_timber: "engineered timber flooring",
  sanding: "floor sanding and coating",
  carpet_tiles: "carpet tiles",
  sheet_vinyl: "sheet vinyl",
};

/** "hybrid flooring", from what went down on the job. The office can change it. */
export async function whatOf(job: typeof schema.jobs.$inferSelect) {
  const facts = await jobCareFacts(job, (await careSettings()).woolRanges).catch(() => null);
  const words = (facts?.floors ?? []).map((f) => FLOOR_WORDS[f] ?? CARE_FLOOR_LABELS[f]?.toLowerCase()).filter(Boolean);
  const list = [...new Set(words)];
  return list.length ? (list.length === 1 ? list[0]! : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`) : "";
}

const cleanFirst = (s: string) => {
  const f = (s ?? "").trim().split(/\s+/)[0] ?? "";
  if (!f || /^(mr|mrs|ms|miss|dr)\.?$/i.test(f) || /[@\d]/.test(f)) return "";
  return f.charAt(0).toUpperCase() + f.slice(1);
};

/** The supervisor and property manager get "the hybrid flooring at 12 Smith St", everyone else "your hybrid flooring". */
const onBehalf = (role: CommsRole) => role === "supervisor" || role === "property_manager" || role === "billing";

export type ReviewFacts = {
  first: string;
  what: string;
  role: CommsRole;
  type: JobCommsContext["type"];
  suburb: string;
  siteAddress: string;
  builder: string;
  link: string;
};

export type ReviewDraft = { subject: string; body: string; problems: string[]; smsParts: number | null };

type EmailTemplate = { subject: string; body: string; active: boolean } | null;

export const REVIEW_EMAIL_SUBJECT = "How did we go, {{first_name}}?";
export const REVIEW_EMAIL_BODY =
  "Hi {{first_name}},\n\nThanks for choosing Terra Flooring for {{job_phrase}}. If you'd like to share your experience, we'd appreciate a review. It takes about a minute: {{review_link}}\n\nIf there's anything you'd like us to look at, just reply to this email.\n\nThanks, Damien, Terra Flooring";

export function renderReview(kind: "initial" | "reminder", channel: "email" | "sms", f: ReviewFacts, template: EmailTemplate): ReviewDraft {
  const problems: string[] = [];
  if (!f.first) problems.push("No first name on their card. Add one so the message doesn't start \"Hi ,\".");
  if (!f.what) problems.push("Say what was done (for example \"hybrid flooring\").");
  if (!f.link) problems.push("No Google review link saved yet.");
  const behalf = onBehalf(f.role);
  if (behalf && !f.siteAddress) problems.push("No site address on the job, so the supervisor version can't say which job.");
  const first = f.first || "there";
  const link = f.link || "[review link]";
  const yours = behalf ? `the ${f.what} at ${f.siteAddress}` : `your ${f.what}`;
  const jobPhrase = behalf ? `the ${f.what} at ${f.siteAddress}` : `your ${f.what}${f.suburb ? ` in ${f.suburb}` : ""}`;
  const fill = (s: string) =>
    s
      .replace(/\{\{\s*first_name\s*\}\}/gi, first)
      .replace(/\{\{\s*job_phrase\s*\}\}/gi, jobPhrase)
      .replace(/\{\{\s*review_link\s*\}\}/gi, link)
      .replace(/\{\{\s*suburb\s*\}\}/gi, f.suburb)
      .replace(/\{\{\s*product\s*\}\}/gi, f.what);

  const reminder = `Hi ${first}, just a gentle reminder in case it slipped by. If you'd like to leave a review of ${yours}, here's the link: ${link}. No worries if not, this is the last you'll hear from us about it.`;

  if (channel === "sms") {
    let body: string;
    if (kind === "reminder") body = reminder;
    else if (f.type === "insurance") {
      if (!f.builder) problems.push("No builder on the job for \"through [builder]\".");
      body = `Hi ${first}, it's Damien from Terra Flooring. We recently completed ${yours} through ${f.builder || "[builder]"}. If you'd like to share your experience, we'd appreciate a review: ${link}. No pressure at all, thank you.`;
    } else body = `Hi ${first}, it's Damien from Terra Flooring. Thanks for having us for ${yours}. If you'd like to share your experience, we'd appreciate a review: ${link}. Thank you.`;
    /* sendMarketing adds the opt-out line. However many parts it takes, it counts as one request. */
    return { subject: "", body, problems, smsParts: smsParts(`${body} Reply STOP to opt out.`) };
  }

  if (template && !template.active) problems.push("The Review request template is switched off under Marketing, Templates.");
  const subject = fill(template?.subject?.trim() ? template.subject : REVIEW_EMAIL_SUBJECT);
  const body = kind === "reminder" ? `${reminder}\n\nThanks, Damien, Terra Flooring` : fill(template?.body?.trim() ? template.body : REVIEW_EMAIL_BODY);
  if (/\{\{|\[review link\]/i.test(body.replace(link, ""))) problems.push("The template has a blank it can't fill. Check it under Marketing, Templates.");
  return { subject, body, problems, smsParts: null };
}

async function reviewTemplate(): Promise<EmailTemplate> {
  const [t] = await db.select().from(schema.emailTemplates).where(eq(schema.emailTemplates.id, 1));
  return t && /review/i.test(t.name) ? { subject: t.subject ?? "", body: t.body, active: !!t.active } : null;
}

export async function factsFor(r: Pick<Review, "what" | "role">, ctx: JobCommsContext, p: JobPerson | null): Promise<ReviewFacts> {
  const s = await reviewSettings();
  return {
    first: cleanFirst(p?.firstName ?? ""),
    what: r.what.trim(),
    role: (r.role || p?.mainRole || "other") as CommsRole,
    type: ctx.type,
    suburb: (ctx.site?.suburb ?? "").trim(),
    siteAddress: ctx.siteAddress,
    builder: ctx.company?.name ?? "",
    link: s.link,
  };
}

/* ------------------------------ helpers ---------------------------------- */

async function rowOrThrow(id: number) {
  const [r] = await db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.id, id));
  if (!r) throw new Error("Review request not found.");
  return r;
}

async function setRow(r: Pick<Review, "id">, patch: Patch) {
  await db.update(schema.reviewRequests).set({ ...patch, updatedAt: new Date() }).where(eq(schema.reviewRequests.id, r.id));
}

const ended = (r: Review) => r.status === "stopped" || r.status === "sent" || r.status === "skipped";
const auDay = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const auWhen = (d: Date) => `${auDay(d)}, ${d.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" })}`;

/** The person a review can be suggested for: only when exactly one fits. Never approved here. */
function suggestFor(ctx: JobCommsContext): JobPerson | null {
  const pick = (roles: CommsRole[]) => {
    const xs = ctx.people.filter((p) => p.roles.some((r) => roles.includes(r)));
    return xs.length === 1 ? xs[0]! : null;
  };
  if (ctx.type === "insurance") return pick(["homeowner"]);
  if (ctx.type === "direct") return pick(["customer", "homeowner"]);
  return pick(["supervisor"]);
}

/** The person a row points at, as they are on the job now. */
function personOf(ctx: JobCommsContext, r: Pick<Review, "contactId">) {
  return r.contactId ? (ctx.people.find((p) => p.contactId === r.contactId) ?? null) : null;
}

const addressOf = (p: JobPerson, channel: string) => (channel === "sms" ? (p.mobile ?? "") : p.email);

/* ------------------------------ setting up ------------------------------- */

/** One review sequence per job. Created Awaiting approval, with a suggestion only when one person clearly fits. */
export async function setupReview(jobId: number, byName: string) {
  const [had] = await db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.jobId, jobId));
  if (had) return had;
  const ctx = await jobComms(jobId);
  if (!ctx) throw new Error("Job not found.");
  if (ctx.job.parentJobId) throw new Error("This is a callback. The review request belongs to the original job.");
  const p = suggestFor(ctx);
  const channel = ctx.type === "insurance" ? "sms" : p && !p.email && p.mobile ? "sms" : "email";
  const now = new Date();
  const [row] = await db
    .insert(schema.reviewRequests)
    .values({
      jobId,
      contactId: p?.contactId ?? null,
      role: p?.mainRole ?? "",
      channel,
      toAddress: p ? addressOf(p, channel) : "",
      status: "awaiting_approval",
      reason: p ? `Suggested ${p.name}. Check who gets it, then approve. Nothing goes until then.` : "Pick who gets it, then approve. Nothing goes until then.",
      maxSends: maxSendsFor(ctx),
      what: await whatOf(ctx.job),
      createdByName: byName,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  const out = row ?? (await db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.jobId, jobId)))[0]!;
  if (row) await commsEvent({ jobId, kind: "review", refId: row.id, event: "set_up", detail: row.reason, byName });
  return out;
}

/** Pick who is asked and how. Back to Awaiting approval. The count of requests already sent stays. */
export async function setReviewRecipient(id: number, byName: string, contactId: number, channel: "email" | "sms", what?: string) {
  const r = await rowOrThrow(id);
  if (ended(r)) throw new Error("This review request has ended.");
  if (r.sendingAt) throw new Error("It is being sent right now. Try again in a minute.");
  const ctx = await jobComms(r.jobId);
  if (!ctx) throw new Error("Job not found.");
  const p = ctx.people.find((x) => x.contactId === contactId);
  if (!p) throw new Error("Pick someone on this job.");
  if (!channelsFor(ctx).includes(channel)) throw new Error("On an insurance job the review request is one text to the homeowner.");
  /* Builder type jobs: the supervisor OR the homeowner, never both. */
  if (r.sentCount > 0 && r.contactId && r.contactId !== contactId && ctx.type !== "direct") {
    throw new Error("Someone on this job has already been asked. On builder jobs only one person is asked.");
  }
  const block = await blockFor(ctx, p, "review", channel);
  if (block) throw new Error(block);
  const changed = r.contactId !== contactId || r.channel !== channel;
  await setRow(r, {
    contactId,
    role: p.mainRole,
    channel,
    toAddress: addressOf(p, channel),
    ...(what !== undefined ? { what: what.trim().slice(0, 120) } : {}),
    /* A different person never gets "just a gentle reminder" for a request they never saw. */
    nextKind: r.sentCount > 0 && r.contactId !== contactId ? "initial" : r.nextKind,
    status: r.sentCount >= r.maxSends ? r.status : "awaiting_approval",
    approvedAt: null,
    approvedByName: "",
    approvalSnapshot: "",
    nextSendAt: null,
    reason: `${changed ? "Recipient changed" : "Details changed"} by ${byName}. Approve to send.`,
  });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "recipient", detail: `${confirmLine(p, addressOf(p, channel))} by ${channel === "sms" ? "text" : "email"}.`, channel, toAddress: addressOf(p, channel), byName });
}

/** Change what the message says was done, without changing who gets it. Needs approving again. */
export async function setReviewWhat(id: number, byName: string, what: string) {
  const r = await rowOrThrow(id);
  if (!r.contactId) {
    await setRow(r, { what: what.trim().slice(0, 120) });
    return;
  }
  await setReviewRecipient(id, byName, r.contactId, r.channel as "email" | "sms", what);
}

/* ------------------------------ approval --------------------------------- */

/** Why it can't be approved or sent, or null. */
async function sendProblem(r: Review, ctx: JobCommsContext, opts: { checkSnapshot: boolean }): Promise<{ text: string; approval: boolean } | null> {
  if (!r.contactId) return { text: "Pick who gets it.", approval: true };
  const p = personOf(ctx, r);
  if (!p) return { text: "The person picked is no longer on this job.", approval: true };
  if (r.sentCount >= r.maxSends) return { text: `Already asked ${r.sentCount === 1 ? "once" : `${r.sentCount} times`} on this job. No more requests.`, approval: false };
  if (!channelsFor(ctx).includes(r.channel as "email" | "sms")) return { text: "On an insurance job the review request is one text to the homeowner.", approval: true };
  if (opts.checkSnapshot) {
    if (!r.approvedAt || !r.approvalSnapshot) return { text: "Not approved yet.", approval: true };
    const changed = snapshotChange(ctx, r.approvalSnapshot);
    if (changed) return { text: changed, approval: true };
    if (addressOf(p, r.channel) !== r.toAddress) return { text: `${p.name}'s ${r.channel === "sms" ? "mobile" : "email"} changed since this was approved.`, approval: true };
  }
  const block = await blockFor(ctx, p, "review", r.channel as "email" | "sms");
  return block ? { text: block, approval: true } : null;
}

export async function approveReview(id: number, byName: string, now = new Date()) {
  const r = await rowOrThrow(id);
  if (r.status !== "awaiting_approval") throw new Error(r.status === "scheduled" ? "Already approved." : "This review request can't be approved now.");
  const ctx = await jobComms(r.jobId);
  if (!ctx) throw new Error("Job not found.");
  const problem = await sendProblem(r, ctx, { checkSnapshot: false });
  if (problem) throw new Error(problem.text);
  const p = personOf(ctx, r)!;
  const facts = await factsFor(r, ctx, p);
  const draft = renderReview(r.sentCount > 0 && r.nextKind === "reminder" ? "reminder" : "initial", r.channel as "email" | "sms", { ...facts, link: facts.link || "x" }, await reviewTemplate());
  const wording = draft.problems.filter((x) => !/review link/.test(x));
  if (wording.length) throw new Error(wording.join(" "));
  const done = await completionOf(ctx.job);
  const next = !done ? null : r.sentCount > 0 && r.lastSentAt ? maxDate(planReminder(r.lastSentAt), businessDaysAfter(now, 1)) : planInitial(ctx, done, now);
  await setRow(r, {
    status: "scheduled",
    approvedAt: now,
    approvedByName: byName,
    approvalSnapshot: snapshotOf(ctx, [p.contactId]),
    toAddress: addressOf(p, r.channel),
    role: r.role || p.mainRole,
    nextSendAt: next,
    reason: next ? `Approved. Next planned send ${auWhen(next)}.` : "Approved. Waits for the job to be confirmed complete.",
  });
  await commsEvent({
    jobId: r.jobId,
    kind: "review",
    refId: r.id,
    event: "approved",
    detail: `${confirmLine(p, addressOf(p, r.channel))} approved. ${next ? `Next planned send ${auWhen(next)}.` : "Waits for the job to be confirmed complete."}`,
    channel: r.channel,
    toAddress: addressOf(p, r.channel),
    byName,
  });
  return { nextSendAt: next };
}

const maxDate = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

async function needsApproval(r: Review, reason: string, byName: string) {
  await setRow(r, { status: "awaiting_approval", approvedAt: null, approvedByName: "", approvalSnapshot: "", nextSendAt: null, reason, sendingAt: null });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "awaiting_approval", detail: reason, byName });
}

/* ------------------------------ office controls -------------------------- */

export type ReviewPauseArgs = { note: string; pauseProfileId: number | null; pauseName: string; reviewDate: string };

export async function pauseReview(id: number, byName: string, a: ReviewPauseArgs) {
  const r = await rowOrThrow(id);
  if (ended(r)) throw new Error("This review request has ended.");
  if (a.reviewDate < dateIn(TZ)) throw new Error("Pick a review date from today on.");
  if (!a.pauseName.trim()) throw new Error("Pick who looks after it.");
  const reason = `Paused by ${byName}${a.note ? `: ${a.note}` : "."}`;
  await setRow(r, { status: "paused", reason, pauseProfileId: a.pauseProfileId, pauseName: a.pauseName.trim(), reviewDate: a.reviewDate, nextSendAt: null });
  await officeTask(r, `Review request paused. Review, then resume or stop`, reason, a.pauseProfileId, a.pauseName.trim(), a.reviewDate, byName);
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "paused", detail: `${reason} Looked after by ${a.pauseName}, review ${a.reviewDate.split("-").reverse().join("/")}. Does not resume on its own.`, byName });
}

/** Back on. Never sends at once: the next send is planned from the next business day. */
export async function resumeReview(id: number, byName: string, now = new Date()) {
  const r = await rowOrThrow(id);
  if (r.status !== "paused" && r.status !== "failed") throw new Error("Only a paused or failed request can be resumed.");
  const ctx = await jobComms(r.jobId);
  if (!ctx) throw new Error("Job not found.");
  const problem = await sendProblem(r, ctx, { checkSnapshot: true });
  if (problem) {
    if (!problem.approval) throw new Error(problem.text);
    return needsApproval(r, `Resumed by ${byName}, but needs approving again: ${problem.text}`, byName);
  }
  const done = await completionOf(ctx.job);
  const soonest = businessDaysAfter(now, 1);
  const next = !done ? null : r.sentCount > 0 && r.lastSentAt ? maxDate(planReminder(r.lastSentAt), soonest) : maxDate(planInitial(ctx, done, r.approvedAt ?? now), soonest);
  await setRow(r, { status: "scheduled", reason: next ? `Resumed by ${byName}. Next planned send ${auWhen(next)}.` : `Resumed by ${byName}. Waits for the job to be confirmed complete.`, repliesSeenAt: now, nextSendAt: next, reviewDate: null, lastError: "" });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "resumed", detail: next ? `Next planned send ${auWhen(next)}.` : "Waits for completion.", byName });
}

export async function stopReview(id: number, byName: string, reason: string) {
  const r = await rowOrThrow(id);
  if (ended(r)) return;
  await setRow(r, { status: "stopped", reason: `Stopped by ${byName}${reason ? `: ${reason}` : "."}`, nextSendAt: null });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "stopped", detail: reason, byName });
}

/** The prominent button. Google reviews are not detected, so a person says so. */
export async function reviewReceived(id: number, byName: string) {
  const r = await rowOrThrow(id);
  /* A second click changes nothing: the first person and time stay. */
  if (r.receivedAt) return { already: true, byName: r.receivedByName, at: r.receivedAt.getTime() };
  /* Whole seconds, as stored, so a second click reports the same time. */
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await setRow(r, { status: "stopped", receivedAt: now, receivedByName: byName, reason: `Review received. Marked by ${byName} on ${auWhen(now)}. No more reminders.`, nextSendAt: null });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "review_received", detail: `Review received. Marked by ${byName}. Any remaining reminder is stopped.`, byName });
  return { already: false, byName, at: now.getTime() };
}

/** The person said no thanks. Stops for good on this job and records who said so and when. */
export async function reviewDeclined(id: number, byName: string, note: string) {
  const r = await rowOrThrow(id);
  if (r.declinedAt) return { already: true, byName: r.declinedByName, at: r.declinedAt.getTime() };
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const reason = `Declined. They said they don't want to leave a review${note.trim() ? ` (${note.trim().slice(0, 200)})` : ""}. Marked by ${byName} on ${auWhen(now)}. No more requests on this job.`;
  await setRow(r, { status: "stopped", declinedAt: now, declinedByName: byName, reason, nextSendAt: null });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "declined", detail: reason, byName });
  return { already: false, byName, at: now.getTime() };
}

async function officeTask(r: Review, title: string, detail: string, profileId: number | null, name: string, due: string, byName: string) {
  const [job] = await db.select({ number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(eq(schema.jobs.id, r.jobId));
  await db.insert(schema.officeTasks).values({
    jobId: r.jobId,
    title: `Job ${job?.displayNumber ?? job?.number ?? r.jobId}: ${title}`.slice(0, 300),
    detail: detail.slice(0, 600),
    assignedProfileId: profileId,
    assignedName: name,
    dueDate: due,
    createdByName: byName,
  });
}

/* ------------------------------ hooks ------------------------------------ */

/** A reply from the person asked pauses the reminder for the office to read. Never throws. */
export async function pauseReviewForInbound(msg: typeof schema.messages.$inferSelect) {
  try {
    if (msg.direction !== "in") return;
    const from = (msg.fromAddress ?? "").trim().toLowerCase();
    const conds = [msg.contactId ? eq(schema.reviewRequests.contactId, msg.contactId) : sql`0`, from ? sql`lower(${schema.reviewRequests.toAddress}) = ${from}` : sql`0`];
    const rows = await db
      .select()
      .from(schema.reviewRequests)
      .where(and(eq(schema.reviewRequests.status, "scheduled"), gt(schema.reviewRequests.sentCount, 0), or(...conds)));
    for (const r of rows) {
      if (r.lastSentAt && msg.createdAt.getTime() < r.lastSentAt.getTime()) continue;
      const due = onOrAfterBusinessDay(addLocalDays(dateIn(TZ), 1));
      const reason = `Replied on ${auDay(msg.createdAt)}. Read the reply. If they left a review, press "Review received — stop reminders". Google reviews are not detected.`;
      /* Only if still scheduled: a STOP handled at the same moment must win. */
      const done = await db
        .update(schema.reviewRequests)
        .set({ status: "paused", reason, nextSendAt: null, reviewDate: due, pauseName: "Office", pauseProfileId: null, repliesSeenAt: msg.createdAt, updatedAt: new Date() })
        .where(and(eq(schema.reviewRequests.id, r.id), eq(schema.reviewRequests.status, "scheduled")))
        .returning({ id: schema.reviewRequests.id });
      if (!done.length) continue;
      await officeTask(r, "Review request: they replied. Read it, then resume or stop", reason, null, "", due, REVIEW_AUTHOR);
      await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "paused", detail: reason, channel: msg.channel, messageId: msg.id, byName: REVIEW_AUTHOR });
    }
  } catch (e) {
    console.error("[review] pause for reply failed", e);
  }
}

/** Unsubscribed (email link or a STOP text): their review requests on that channel stop. */
export async function stopReviewsFor(a: { contactId?: number | null; mobile?: string | null; channel: "email" | "sms" | "all"; reason: string }) {
  const conds = [a.contactId ? eq(schema.reviewRequests.contactId, a.contactId) : sql`0`, a.mobile ? eq(schema.reviewRequests.toAddress, a.mobile) : sql`0`];
  const rows = await db
    .select()
    .from(schema.reviewRequests)
    .where(and(inArray(schema.reviewRequests.status, ["awaiting_approval", "scheduled", "paused", "failed"]), or(...conds)));
  for (const r of rows) {
    if (a.channel !== "all" && r.channel !== a.channel) continue;
    await setRow(r, { status: "stopped", reason: a.reason, nextSendAt: null });
    await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "stopped", detail: a.reason, byName: REVIEW_AUTHOR });
  }
  return rows.length;
}

/* ------------------------------ sending ---------------------------------- */

export type ReviewSendResult = { outcome: "sent" | "held" | "failed" | "busy"; detail: string };

/**
 * Sends the next request for one row. Claimed first (sending_at), so two
 * ticks or a double click never send twice. Every rule is checked again here.
 */
export async function sendReview(id: number, now = new Date(), byName = REVIEW_AUTHOR): Promise<ReviewSendResult> {
  const claimed = await db
    .update(schema.reviewRequests)
    .set({ sendingAt: now, updatedAt: now })
    .where(and(eq(schema.reviewRequests.id, id), isNull(schema.reviewRequests.sendingAt), eq(schema.reviewRequests.status, "scheduled")))
    .returning();
  const r = claimed[0];
  if (!r) return { outcome: "busy", detail: "not scheduled, or already being sent" };
  const release = (patch: Patch) => setRow(r, { ...patch, sendingAt: null });

  const s = await reviewSettings();
  if (!s.on) {
    await release({ reason: "Review requests are switched off in Settings. Nothing is sent." });
    return { outcome: "held", detail: "off" };
  }
  if (!s.link) {
    await release({ reason: "No Google review link saved yet. Nothing is sent until it is added." });
    return { outcome: "held", detail: "no link" };
  }
  const ctx = await jobComms(r.jobId);
  if (!ctx) {
    await release({ status: "skipped", reason: "The job is gone." });
    return { outcome: "held", detail: "no job" };
  }
  const done = await completionOf(ctx.job);
  if (!done) {
    await release({ nextSendAt: null, reason: "The job is no longer confirmed complete. It waits until it is." });
    return { outcome: "held", detail: "not complete" };
  }
  const problem = await sendProblem(r, ctx, { checkSnapshot: true });
  if (problem) {
    if (problem.approval) await needsApproval(r, problem.text, REVIEW_AUTHOR);
    else await release({ status: "sent", nextSendAt: null, reason: problem.text });
    return { outcome: "held", detail: problem.text };
  }
  const p = personOf(ctx, r)!;
  const kind = r.sentCount > 0 && r.nextKind === "reminder" ? "reminder" : "initial";
  const draft = renderReview(kind, r.channel as "email" | "sms", await factsFor(r, ctx, p), await reviewTemplate());
  if (draft.problems.length) {
    await needsApproval(r, draft.problems.join(" "), REVIEW_AUTHOR);
    return { outcome: "held", detail: draft.problems.join(" ") };
  }
  const [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, p.contactId));
  if (!contact) {
    await needsApproval(r, "The contact card is gone.", REVIEW_AUTHOR);
    return { outcome: "held", detail: "no contact" };
  }
  /*
   * Consent: they were on a job Terra completed, the same footing as the care
   * emails. Opt-outs, do not market and archived cards still stop it.
   */
  const res = await sendMarketing({
    contact: { ...contact, email: p.email, marketingBasis: contact.marketingOptIn ? contact.marketingBasis : "completed_job" },
    channel: r.channel as "email" | "sms",
    subject: draft.subject,
    body: draft.body,
    useWrapper: true,
  });
  const at = new Date();
  if (res.ok) {
    const count = r.sentCount + 1;
    const more = count < r.maxSends;
    const next = more ? planReminder(at) : null;
    /* The count always lands. The status only moves on if nobody stopped it while it was sending. */
    await release({ sentCount: count, lastSentAt: at, repliesSeenAt: at, nextKind: "reminder", lastError: "" });
    await db
      .update(schema.reviewRequests)
      .set({
        status: more ? "scheduled" : "sent",
        nextSendAt: next,
        updatedAt: new Date(),
        reason: more ? `Request ${count} of ${r.maxSends} accepted for sending. Reminder planned ${auWhen(next!)} unless they reply or you stop it.` : `Request ${count} of ${r.maxSends} accepted for sending. No more requests on this job.`,
      })
      .where(and(eq(schema.reviewRequests.id, r.id), eq(schema.reviewRequests.status, "scheduled")));
    await commsEvent({
      jobId: r.jobId,
      kind: "review",
      refId: r.id,
      event: "sent",
      detail: `${kind === "reminder" ? "Reminder" : "Request"} ${count} of ${r.maxSends} accepted by the ${r.channel === "sms" ? "text" : "email"} provider${draft.smsParts && draft.smsParts > 1 ? ` (${draft.smsParts} text parts, one message)` : ""}.`,
      channel: r.channel,
      toAddress: r.toAddress,
      sendId: res.sendId,
      byName,
    });
    return { outcome: "sent", detail: r.toAddress };
  }
  if (res.deferred) {
    await release({ reason: `Held: ${res.reason}. Tries again at the next sending time.` });
    return { outcome: "held", detail: res.reason };
  }
  const stop = /unsubscribed|do not market|archived/i.test(res.reason);
  await release({ status: stop ? "stopped" : "failed", lastError: res.reason.slice(0, 300), reason: stop ? `Not sent: ${res.reason}.` : `Failed: ${res.reason}. Press Retry to try again.`, nextSendAt: stop ? null : r.nextSendAt });
  await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "failed", detail: res.reason, channel: r.channel, toAddress: r.toAddress, sendId: res.sendId, byName });
  return { outcome: "failed", detail: res.reason };
}

/** Retry after a failure: planned again from the next business day. Never sent at the press of the button. */
export const retryReview = (id: number, byName: string) => resumeReview(id, byName);

/* ------------------------------ the timer -------------------------------- */

let ticking = false;

export async function tickReviews(now = new Date()) {
  if (ticking) return { sent: 0, held: 0, created: 0, note: "busy" };
  ticking = true;
  const out = { sent: 0, held: 0, created: 0, note: "" };
  try {
    const s = await reviewSettings();
    if (!s.on || !s.startedAt) return { ...out, note: "off" };

    /* Left mid-send: the server stopped. Never sent again on its own. */
    const stale = await db
      .select()
      .from(schema.reviewRequests)
      .where(lte(schema.reviewRequests.sendingAt, new Date(now.getTime() - STALE_SENDING_MS)));
    for (const r of stale) {
      await setRow(r, { sendingAt: null, status: "failed", lastError: "Was being sent when the server stopped.", reason: "Was being sent when the server stopped. Check the history before pressing Retry." });
    }

    /* Jobs completed since review requests went on, with no request yet: set up Awaiting approval. Never approved here. */
    const ids = await completedStatusIds();
    if (ids.length) {
      const jobs = await db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .leftJoin(schema.reviewRequests, eq(schema.reviewRequests.jobId, schema.jobs.id))
        .where(and(isNull(schema.reviewRequests.id), isNull(schema.jobs.parentJobId), inArray(schema.jobs.statusId, ids), sql`${schema.jobs.completedAt} >= ${Math.floor(s.startedAt.getTime() / 1000)}`))
        .orderBy(asc(schema.jobs.id))
        .limit(50);
      for (const j of jobs) {
        await setupReview(j.id, REVIEW_AUTHOR).catch((e) => console.error("[review] set up failed", j.id, e));
        out.created++;
      }
    }

    /* Approved and waiting for completion: plan the first send once it is confirmed. */
    const waiting = await db.select().from(schema.reviewRequests).where(and(eq(schema.reviewRequests.status, "scheduled"), isNull(schema.reviewRequests.nextSendAt)));
    for (const r of waiting) {
      const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, r.jobId));
      const done = job ? await completionOf(job) : null;
      if (!done || !r.approvedAt) continue;
      const ctx = await jobComms(r.jobId);
      if (!ctx) continue;
      const next = r.sentCount > 0 && r.lastSentAt ? maxDate(planReminder(r.lastSentAt), businessDaysAfter(now, 1)) : maxDate(planInitial(ctx, done, r.approvedAt), businessDaysAfter(now, 1));
      await setRow(r, { nextSendAt: next, reason: `Job confirmed complete. Next planned send ${auWhen(next)}.` });
    }

    const due = await db
      .select()
      .from(schema.reviewRequests)
      .where(and(eq(schema.reviewRequests.status, "scheduled"), isNull(schema.reviewRequests.sendingAt), lte(schema.reviewRequests.nextSendAt, now)))
      .orderBy(asc(schema.reviewRequests.nextSendAt))
      .limit(25);
    for (const r of due) {
      /* Missed by more than a day: never a late burst. */
      if (r.nextSendAt && now.getTime() - r.nextSendAt.getTime() > LATE_MS) {
        if (r.sentCount > 0) {
          await setRow(r, { status: "sent", nextSendAt: null, reason: "Reminder not sent late. It was due more than a day ago." });
          await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "skipped", detail: "Reminder not sent late.", byName: REVIEW_AUTHOR });
        } else {
          const next = businessDaysAfter(now, 1);
          await setRow(r, { nextSendAt: next, reason: `Missed its time, so it moved to ${auWhen(next)}. Not sent late.` });
          await commsEvent({ jobId: r.jobId, kind: "review", refId: r.id, event: "moved", detail: `Missed its time, moved to ${auWhen(next)}.`, byName: REVIEW_AUTHOR });
        }
        out.held++;
        continue;
      }
      /* A reply that came in by a path that skipped the hook. */
      if (r.sentCount > 0 && (await replySince(r))) {
        out.held++;
        continue;
      }
      const res = await sendReview(r.id, now);
      if (res.outcome === "sent") out.sent++;
      else out.held++;
    }
    return out;
  } catch (e) {
    console.error("[review] tick failed", e);
    return { ...out, note: String((e as Error)?.message ?? e) };
  } finally {
    ticking = false;
  }
}

async function replySince(r: Review) {
  const since = r.repliesSeenAt ?? r.lastSentAt;
  if (!since) return false;
  const [m] = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, "in"),
        gt(schema.messages.createdAt, since),
        or(r.contactId ? eq(schema.messages.contactId, r.contactId) : sql`0`, r.toAddress ? sql`lower(${schema.messages.fromAddress}) = ${r.toAddress.toLowerCase()}` : sql`0`),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);
  if (!m) return false;
  await pauseReviewForInbound(m);
  return true;
}

let booted = false;
export function bootReviews() {
  if (booted) return;
  booted = true;
  const mode = process.env.REVIEW_TIMER;
  if (mode === "off") return;
  if (mode !== "on" && !isLiveServer()) return void console.log("[review] timer idle, not the published server");
  setInterval(() => void tickReviews(), 5 * 60_000);
  setTimeout(() => void tickReviews(), 90_000);
}

/* ------------------------------ what the office sees --------------------- */

export async function reviewView(jobId: number, ctx: JobCommsContext) {
  const [r] = await db.select().from(schema.reviewRequests).where(eq(schema.reviewRequests.jobId, jobId));
  const s = await reviewSettings();
  const done = await completionOf(ctx.job);
  const base = {
    settings: { on: s.on, hasLink: !!s.link, link: s.link },
    completedAt: done?.getTime() ?? null,
    maxSends: maxSendsFor(ctx),
    channels: channelsFor(ctx),
    rule:
      ctx.type === "insurance"
        ? "Insurance job: the homeowner only, one text, no reminder. The next business day at 10am after completion and approval."
        : ctx.type === "direct"
          ? "2 business days after completion at 10am, then one reminder 7 days later. At most 2 requests."
          : "The supervisor or the homeowner, never both. 2 business days after completion at 10am, then one reminder 7 days later. At most 2 requests.",
  };
  if (!r) return { ...base, row: null };
  const p = personOf(ctx, r);
  const facts = await factsFor(r, ctx, p);
  const kind = r.sentCount > 0 && r.nextKind === "reminder" ? "reminder" : "initial";
  const draft = r.sentCount < r.maxSends ? renderReview(kind, r.channel as "email" | "sms", facts, await reviewTemplate()) : null;
  /* What changed since approval, shown on load so nobody waits for the send to find out. */
  let changed: string | null = null;
  if (r.status === "scheduled" || r.status === "paused") {
    const prob = await sendProblem(r, ctx, { checkSnapshot: true });
    if (prob && prob.approval) changed = prob.text;
  }
  const block = p && !ended(r) ? await blockFor(ctx, p, "review", r.channel as "email" | "sms") : null;
  /* Approved but waiting on completion: the first send it would plan, if completed today. */
  const planned = r.nextSendAt?.getTime() ?? (r.status === "scheduled" && done && r.approvedAt ? planInitial(ctx, done, r.approvedAt).getTime() : null);
  return {
    ...base,
    row: {
      id: r.id,
      status: r.status,
      reason: r.reason,
      contactId: r.contactId,
      who: p ? { name: p.name, role: p.roleLabel, mainRole: p.mainRole, address: addressOf(p, r.channel), confirm: confirmLine(p, addressOf(p, r.channel)) } : null,
      channel: r.channel,
      what: r.what,
      sentCount: r.sentCount,
      maxSends: r.maxSends,
      nextKind: kind,
      nextSendAt: planned,
      lastSentAt: r.lastSentAt?.getTime() ?? null,
      lastError: r.lastError,
      approvedAt: r.approvedAt?.getTime() ?? null,
      approvedByName: r.approvedByName,
      pauseName: r.pauseName,
      reviewDate: r.reviewDate,
      receivedAt: r.receivedAt?.getTime() ?? null,
      receivedByName: r.receivedByName,
      declinedAt: r.declinedAt?.getTime() ?? null,
      declinedByName: r.declinedByName,
      changed,
      block,
      draft,
    },
  };
}
