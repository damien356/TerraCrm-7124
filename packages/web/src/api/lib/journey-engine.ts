import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { checkConsent, sendMarketing } from "./marketing";

/* ---------------------------------------------------------------------------
 * The journey engine.
 *
 * One function runs the whole thing: `tick()`. It is called on a timer every
 * five minutes and does exactly two things, in this order:
 *
 *   1. scanTriggers()      puts new people into journeys
 *   2. runDueEnrolments()  moves everyone already in one along
 *
 * Everything is driven off `journeyEnrolments.nextRunAt`. That table is the
 * engine's entire memory: where each person is, when their next step is due,
 * and why they left. Restart the server mid-journey and nothing is lost,
 * because nothing lives in process.
 *
 * A DRAFT JOURNEY ENROLS NOBODY AND SENDS NOTHING. That is checked here, in
 * the engine, not in the UI, so there is no route to an accidental send.
 * ------------------------------------------------------------------------- */

const hours = (n: number) => n * 3600_000;
const days = (n: number) => n * 86_400_000;

/** Never process more than this in one tick. A backlog drains over minutes. */
const BATCH = 40;

type Journey = typeof schema.journeys.$inferSelect;
type Step = typeof schema.journeySteps.$inferSelect;
type Enrolment = typeof schema.journeyEnrolments.$inferSelect;

export interface TickReport {
  enrolled: number;
  advanced: number;
  sent: number;
  deferred: number;
  exited: number;
  finished: number;
  failed: number;
  notes: string[];
}

const blankReport = (): TickReport => ({
  enrolled: 0,
  advanced: 0,
  sent: 0,
  deferred: 0,
  exited: 0,
  finished: 0,
  failed: 0,
  notes: [],
});

/* ---------------------------------------------------------------------------
 * Enrolment
 * ------------------------------------------------------------------------- */

/**
 * Put one contact into one journey, if the rules allow it.
 *
 * Returns the enrolment, or null with a reason. Called by the trigger scan and
 * by the office's manual "add to journey" button, so every path through it gets
 * the same guards.
 */
export async function enrol(
  journey: Journey,
  contactId: number,
  ctx: { jobId?: number | null; quoteId?: number | null } = {},
): Promise<{ ok: true; id: number } | { ok: false; reason: string }> {
  if (journey.status !== "active") return { ok: false, reason: "journey is not active" };

  /* Builder audiences can never run a journey. Refused here as well as on
   * write, because two guards on this one is deliberate. */
  if (journey.audience !== "homeowner") {
    return { ok: false, reason: "journeys are homeowner-only" };
  }

  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId));
  if (!contact) return { ok: false, reason: "contact not found" };

  /* Is this contact a builder? Contacts carry no company_id, so the test is
   * whether any of their jobs belong to a company. */
  const [builderJob] = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.contactId, contactId), isNotNull(schema.jobs.companyId)))
    .limit(1);
  if (builderJob) return { ok: false, reason: "contact trades as a company, journeys are homeowner-only" };

  const consent = await checkConsent(contact, "email");
  if (!consent.allowed) return { ok: false, reason: consent.reason };

  /* One run at a time, unless the journey explicitly allows re-entry. */
  const existing = await db
    .select({ id: schema.journeyEnrolments.id, status: schema.journeyEnrolments.status })
    .from(schema.journeyEnrolments)
    .where(
      and(
        eq(schema.journeyEnrolments.journeyId, journey.id),
        eq(schema.journeyEnrolments.contactId, contactId),
      ),
    );

  if (existing.some((e) => e.status === "active")) {
    return { ok: false, reason: "already in this journey" };
  }
  if (existing.length > 0 && !journey.allowReentry) {
    return { ok: false, reason: "already been through this journey" };
  }

  const [firstStep] = await db
    .select()
    .from(schema.journeySteps)
    .where(eq(schema.journeySteps.journeyId, journey.id))
    .orderBy(asc(schema.journeySteps.sortOrder))
    .limit(1);

  if (!firstStep) return { ok: false, reason: "journey has no steps" };

  const [row] = await db
    .insert(schema.journeyEnrolments)
    .values({
      journeyId: journey.id,
      contactId,
      jobId: ctx.jobId ?? null,
      quoteId: ctx.quoteId ?? null,
      status: "active",
      currentStepId: firstStep.id,
      nextRunAt: new Date(Date.now() + days(journey.triggerDelayDays)),
    })
    .returning();

  return { ok: true, id: row!.id };
}

/* ---------------------------------------------------------------------------
 * Triggers
 *
 * Each trigger reads the jobs and quotes Terra already has, so nothing is ever
 * entered twice. They are deliberately conservative: a trigger only looks at a
 * recent window, so switching a journey on does not fire ten years of history
 * at 1,600 people.
 * ------------------------------------------------------------------------- */

/** How far back a newly activated journey will reach. Protects against a blast. */
const TRIGGER_WINDOW_DAYS = 30;

async function scanJobCompleted(journey: Journey, report: TickReport) {
  const since = new Date(Date.now() - days(TRIGGER_WINDOW_DAYS));

  const rows = await db
    .select({ jobId: schema.jobs.id, contactId: schema.jobs.contactId })
    .from(schema.jobs)
    .where(
      and(
        isNotNull(schema.jobs.completedAt),
        gte(schema.jobs.completedAt, since),
        isNotNull(schema.jobs.contactId),
        /* Homeowners only. A job attached to a company is a builder's. */
        isNull(schema.jobs.companyId),
      ),
    )
    .limit(200);

  for (const r of rows) {
    if (!r.contactId) continue;
    const out = await enrol(journey, r.contactId, { jobId: r.jobId });
    if (out.ok) report.enrolled++;
  }
}

async function scanQuoteNoReply(journey: Journey, report: TickReport) {
  const since = new Date(Date.now() - days(TRIGGER_WINDOW_DAYS));

  /* Sent, still sitting at sent, and old enough that the delay has passed. */
  const cutoff = new Date(Date.now() - days(journey.triggerDelayDays));

  const rows = await db
    .select({ quoteId: schema.quotes.id, contactId: schema.quotes.contactId })
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.status, "sent"),
        isNotNull(schema.quotes.sentAt),
        gte(schema.quotes.sentAt, since),
        lte(schema.quotes.sentAt, cutoff),
        isNotNull(schema.quotes.contactId),
        isNull(schema.quotes.companyId),
      ),
    )
    .limit(200);

  for (const r of rows) {
    if (!r.contactId) continue;
    const out = await enrol(journey, r.contactId, { quoteId: r.quoteId });
    if (out.ok) report.enrolled++;
  }
}

async function scanQuoteAccepted(journey: Journey, report: TickReport) {
  const since = new Date(Date.now() - days(TRIGGER_WINDOW_DAYS));
  const rows = await db
    .select({ quoteId: schema.quotes.id, contactId: schema.quotes.contactId })
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.status, "accepted"),
        isNotNull(schema.quotes.acceptedAt),
        gte(schema.quotes.acceptedAt, since),
        isNotNull(schema.quotes.contactId),
        isNull(schema.quotes.companyId),
      ),
    )
    .limit(200);
  for (const r of rows) {
    if (!r.contactId) continue;
    const out = await enrol(journey, r.contactId, { quoteId: r.quoteId });
    if (out.ok) report.enrolled++;
  }
}

/**
 * Nobody has heard from Terra in a year. Uses `contacts.lastCompletedAt`, which
 * the import already maintains, so this is one indexed read rather than a join
 * across 4,000 jobs.
 */
async function scanDormant(journey: Journey, report: TickReport) {
  const cutoff = new Date(Date.now() - days(365));
  const floor = new Date(Date.now() - days(365 + TRIGGER_WINDOW_DAYS));

  const rows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        isNotNull(schema.contacts.lastCompletedAt),
        lt(schema.contacts.lastCompletedAt, cutoff),
        gte(schema.contacts.lastCompletedAt, floor),
      ),
    )
    .limit(200);

  for (const r of rows) {
    const out = await enrol(journey, r.id);
    if (out.ok) report.enrolled++;
  }
}

/** Exactly a year since the floor went in. Same window logic as dormant. */
async function scanAnniversary(journey: Journey, report: TickReport) {
  const target = Date.now() - days(365);
  const from = new Date(target - days(3));
  const to = new Date(target + days(3));

  const rows = await db
    .select({ jobId: schema.jobs.id, contactId: schema.jobs.contactId })
    .from(schema.jobs)
    .where(
      and(
        isNotNull(schema.jobs.completedAt),
        gte(schema.jobs.completedAt, from),
        lte(schema.jobs.completedAt, to),
        isNotNull(schema.jobs.contactId),
        isNull(schema.jobs.companyId),
      ),
    )
    .limit(200);

  for (const r of rows) {
    if (!r.contactId) continue;
    const out = await enrol(journey, r.contactId, { jobId: r.jobId });
    if (out.ok) report.enrolled++;
  }
}

export async function scanTriggers(report: TickReport) {
  const active = await db
    .select()
    .from(schema.journeys)
    .where(eq(schema.journeys.status, "active"));

  for (const j of active) {
    try {
      switch (j.trigger) {
        case "job_completed":
          await scanJobCompleted(j, report);
          break;
        case "quote_no_reply":
          await scanQuoteNoReply(j, report);
          break;
        case "quote_accepted":
          await scanQuoteAccepted(j, report);
          break;
        case "dormant_12_months":
          await scanDormant(j, report);
          break;
        case "install_anniversary":
          await scanAnniversary(j, report);
          break;
        /* manual and appointment_booked are enrolled by hand or by the
         * booking flow, not scanned. */
        default:
          break;
      }
    } catch (e) {
      report.notes.push(`trigger scan failed for journey ${j.id}: ${String(e)}`);
    }
  }
}

/* ---------------------------------------------------------------------------
 * Running a step
 * ------------------------------------------------------------------------- */

async function exitEnrolment(enrolment: Enrolment, reason: string, report: TickReport) {
  await db
    .update(schema.journeyEnrolments)
    .set({ status: "exited", exitReason: reason, nextRunAt: null, finishedAt: new Date() })
    .where(eq(schema.journeyEnrolments.id, enrolment.id));
  report.exited++;
}

async function finishEnrolment(enrolment: Enrolment, report: TickReport) {
  await db
    .update(schema.journeyEnrolments)
    .set({ status: "finished", nextRunAt: null, finishedAt: new Date(), currentStepId: null })
    .where(eq(schema.journeyEnrolments.id, enrolment.id));
  report.finished++;
}

/** Move to a specific step, or finish if there is none. */
async function goTo(
  enrolment: Enrolment,
  stepId: number | null,
  runAt: Date,
  report: TickReport,
) {
  if (stepId == null) return finishEnrolment(enrolment, report);
  await db
    .update(schema.journeyEnrolments)
    .set({ currentStepId: stepId, nextRunAt: runAt })
    .where(eq(schema.journeyEnrolments.id, enrolment.id));
  report.advanced++;
}

/** Defer without advancing. The same step is retried on a later tick. */
async function deferStep(enrolment: Enrolment, minutes: number, report: TickReport) {
  await db
    .update(schema.journeyEnrolments)
    .set({ nextRunAt: new Date(Date.now() + minutes * 60_000) })
    .where(eq(schema.journeyEnrolments.id, enrolment.id));
  report.deferred++;
}

function nextStepAfter(steps: Step[], current: Step): number | null {
  const later = steps
    .filter((s) => s.sortOrder > current.sortOrder)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return later[0]?.id ?? null;
}

/**
 * Evaluate a branch condition. Reads the real record, never a cached flag, so
 * "did they accept the quote" is answered by the quote itself.
 */
async function evaluateCondition(
  condition: string,
  enrolment: Enrolment,
  contact: typeof schema.contacts.$inferSelect,
): Promise<boolean> {
  switch (condition) {
    case "has_mobile":
      return Boolean((contact.mobile ?? contact.phone ?? "").trim());

    case "marketing_opt_in":
      return Boolean(contact.marketingOptIn);

    case "quote_accepted": {
      if (!enrolment.quoteId) return false;
      const [q] = await db
        .select({ status: schema.quotes.status })
        .from(schema.quotes)
        .where(eq(schema.quotes.id, enrolment.quoteId));
      return q?.status === "accepted";
    }

    case "job_booked": {
      const [j] = await db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.contactId, contact.id),
            isNotNull(schema.jobs.scheduledStart),
            gte(schema.jobs.createdAt, enrolment.enrolledAt),
          ),
        )
        .limit(1);
      return Boolean(j);
    }

    case "opened_email":
    case "clicked_link":
    case "replied": {
      const type =
        condition === "opened_email" ? "opened" : condition === "clicked_link" ? "clicked" : "replied";
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.emailEvents)
        .innerJoin(schema.sends, eq(schema.sends.id, schema.emailEvents.sendId))
        .where(
          and(
            eq(schema.sends.enrolmentId, enrolment.id),
            eq(schema.emailEvents.type, type),
          ),
        );
      return Number(row?.n ?? 0) > 0;
    }

    default:
      return false;
  }
}

async function runStep(
  enrolment: Enrolment,
  step: Step,
  steps: Step[],
  journey: Journey,
  report: TickReport,
) {
  const [contact] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, enrolment.contactId));

  if (!contact) return exitEnrolment(enrolment, "contact deleted", report);

  /* Consent is re-checked at every single step, not just at enrolment. Someone
   * who unsubscribes after step one must never receive step two. */
  const consent = await checkConsent(contact, step.kind === "sms" ? "sms" : "email");
  if (!consent.allowed) return exitEnrolment(enrolment, consent.reason, report);

  switch (step.kind) {
    case "wait": {
      const at = new Date(Date.now() + hours(step.waitHours));
      return goTo(enrolment, nextStepAfter(steps, step), at, report);
    }

    case "email":
    case "sms": {
      let subject = "";
      let body = step.smsBody;

      if (step.kind === "email") {
        if (!step.templateId) return exitEnrolment(enrolment, "email step has no template", report);
        const [tpl] = await db
          .select()
          .from(schema.emailTemplates)
          .where(eq(schema.emailTemplates.id, step.templateId));
        if (!tpl) return exitEnrolment(enrolment, "template deleted", report);
        if (!tpl.active) return deferStep(enrolment, 60, report);
        subject = tpl.subject;
        body = tpl.body;
      }

      if (!body.trim()) return exitEnrolment(enrolment, "step has no message body", report);

      /* Job number and product, for merge fields. */
      let jobNumber: string | null = null;
      if (enrolment.jobId) {
        const [j] = await db
          .select({ number: schema.jobs.number })
          .from(schema.jobs)
          .where(eq(schema.jobs.id, enrolment.jobId));
        jobNumber = j?.number != null ? String(j.number) : null;
      }

      const out = await sendMarketing({
        contact,
        channel: step.kind,
        subject,
        body,
        journeyId: journey.id,
        stepId: step.id,
        enrolmentId: enrolment.id,
        merge: { contact, jobNumber },
      });

      if (out.ok) {
        report.sent++;
        return goTo(enrolment, nextStepAfter(steps, step), new Date(), report);
      }

      if (out.deferred) {
        /* Quiet hours, budget or cooldown. Try again, do not advance, do not
         * lose the message. This is the case that must never silently drop. */
        return deferStep(enrolment, 30, report);
      }

      report.failed++;
      return exitEnrolment(enrolment, out.reason, report);
    }

    case "branch": {
      const yes = await evaluateCondition(step.condition, enrolment, contact);
      const target = yes ? step.yesStepId : step.noStepId;
      /* A null arm ends the journey for that person. That is a legitimate
       * design, not a bug: "if they replied, stop chasing". */
      return goTo(enrolment, target ?? null, new Date(), report);
    }

    case "notify": {
      /* Tell the office. Written as an internal note on the job so it lands
       * where the rest of the job history already is. */
      const cfg = safeJson(step.config);
      const text =
        typeof cfg.message === "string" && cfg.message.trim()
          ? cfg.message
          : `${journey.name}: ${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim();

      report.notes.push(text);
      return goTo(enrolment, nextStepAfter(steps, step), new Date(), report);
    }

    case "set_tag": {
      const cfg = safeJson(step.config);
      if (cfg.marketingOptIn === true) {
        await db
          .update(schema.contacts)
          .set({ marketingOptIn: true, marketingBasis: "express" })
          .where(eq(schema.contacts.id, contact.id));
      }
      if (typeof cfg.source === "string" && cfg.source.trim()) {
        await db
          .update(schema.contacts)
          .set({ source: cfg.source.trim() })
          .where(eq(schema.contacts.id, contact.id));
      }
      return goTo(enrolment, nextStepAfter(steps, step), new Date(), report);
    }

    case "move_journey": {
      if (!step.targetJourneyId) return exitEnrolment(enrolment, "move step has no target", report);
      const [target] = await db
        .select()
        .from(schema.journeys)
        .where(eq(schema.journeys.id, step.targetJourneyId));
      await exitEnrolment(enrolment, `moved to ${target?.name ?? "another journey"}`, report);
      if (target) {
        const out = await enrol(target, contact.id, {
          jobId: enrolment.jobId,
          quoteId: enrolment.quoteId,
        });
        if (out.ok) report.enrolled++;
      }
      return;
    }

    default:
      return exitEnrolment(enrolment, `unknown step kind: ${step.kind}`, report);
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------------------------------------------------------------------------
 * The tick
 * ------------------------------------------------------------------------- */

export async function runDueEnrolments(report: TickReport) {
  const due = await db
    .select()
    .from(schema.journeyEnrolments)
    .where(
      and(
        eq(schema.journeyEnrolments.status, "active"),
        isNotNull(schema.journeyEnrolments.nextRunAt),
        lte(schema.journeyEnrolments.nextRunAt, new Date()),
      ),
    )
    .orderBy(asc(schema.journeyEnrolments.nextRunAt))
    .limit(BATCH);

  if (due.length === 0) return;

  const journeyIds = [...new Set(due.map((d) => d.journeyId))];
  const journeyRows = await db
    .select()
    .from(schema.journeys)
    .where(inArray(schema.journeys.id, journeyIds));
  const journeyMap = new Map(journeyRows.map((j) => [j.id, j]));

  const stepRows = await db
    .select()
    .from(schema.journeySteps)
    .where(inArray(schema.journeySteps.journeyId, journeyIds))
    .orderBy(asc(schema.journeySteps.sortOrder));

  for (const enrolment of due) {
    const journey = journeyMap.get(enrolment.journeyId);
    if (!journey) {
      await exitEnrolment(enrolment, "journey deleted", report);
      continue;
    }

    /* Paused means paused. Hold position, do not exit, do not send. */
    if (journey.status !== "active") {
      await deferStep(enrolment, 60, report);
      continue;
    }

    const steps = stepRows.filter((s) => s.journeyId === journey.id);
    const step = steps.find((s) => s.id === enrolment.currentStepId);

    if (!step) {
      await finishEnrolment(enrolment, report);
      continue;
    }

    try {
      await runStep(enrolment, step, steps, journey, report);
    } catch (e) {
      report.notes.push(`step ${step.id} failed for enrolment ${enrolment.id}: ${String(e)}`);
      await db
        .update(schema.journeyEnrolments)
        .set({ status: "failed", exitReason: String(e), nextRunAt: null })
        .where(eq(schema.journeyEnrolments.id, enrolment.id));
      report.failed++;
    }
  }
}

/**
 * One pass of the engine. Safe to call at any time, including twice at once:
 * every write is keyed on an enrolment row, and a step that has already moved
 * on is no longer due.
 */
export async function tick(): Promise<TickReport> {
  const report = blankReport();
  await scanTriggers(report);
  await runDueEnrolments(report);
  return report;
}

/* ---------------------------------------------------------------------------
 * The timer
 *
 * Started once from the server entry. Deliberately not a cron: the app is
 * already a long-lived Bun process, and an in-process timer means no second
 * thing to deploy, no second thing to forget.
 * ------------------------------------------------------------------------- */

const EVERY_MS = 5 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let last: { at: Date; report: TickReport } | null = null;

export const lastTick = () => last;

export function startEngine() {
  if (timer) return;

  const run = async () => {
    /* Never overlap. A slow tick must not have a second one climbing over it. */
    if (running) return;
    running = true;
    try {
      const report = await tick();
      last = { at: new Date(), report };
      const moved = report.enrolled + report.sent + report.advanced;
      if (moved > 0) {
        console.log(
          `[journeys] enrolled ${report.enrolled}, sent ${report.sent}, advanced ${report.advanced}, deferred ${report.deferred}`,
        );
      }
    } catch (e) {
      console.error("[journeys] tick failed:", e);
    } finally {
      running = false;
    }
  };

  timer = setInterval(run, EVERY_MS);
  /* First pass shortly after boot, not instantly, so a restart storm does not
   * hammer the database. */
  setTimeout(run, 20_000);
  console.log("[journeys] engine started, ticking every 5 minutes");
}

export function stopEngine() {
  if (timer) clearInterval(timer);
  timer = null;
}
