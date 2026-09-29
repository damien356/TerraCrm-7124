import { and, eq, gte, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  MARKETING_DAILY_BUDGET,
  fillMergeFields,
  footerText,
  sendEmail,
  wrapEmail,
} from "./email";
import { SMS_OPT_OUT, normaliseMobile, sendSms, smsParts } from "./sms";

/* ---------------------------------------------------------------------------
 * The gate every marketing message passes through.
 *
 * lib/email.ts and lib/sms.ts are raw senders. They know how to put a message
 * on the wire and nothing else, on purpose. This file is the part that decides
 * whether a message is ALLOWED to go at all, and it is the only thing the
 * journey engine is permitted to call.
 *
 * Read the rails in section "Rails" below before changing anything here. They
 * are not preferences. Three of them are Australian law and the fines are real.
 * ------------------------------------------------------------------------- */

/** Where unsubscribe links point. Same origin as the app. */
const siteUrl = () => (process.env.WEBSITE_URL ?? "").replace(/\/+$/, "");

/* ---------------------------------------------------------------------------
 * Rails
 * ------------------------------------------------------------------------- */

/** Nothing sends outside these hours, local Queensland time. */
export const QUIET_HOURS = { startSending: 8, stopSending: 20 } as const;

/** One marketing email per contact per 24h, across every journey at once. */
export const CONTACT_COOLDOWN_HOURS = 24;

/**
 * Queensland does not observe daylight saving, so the offset is fixed at +10
 * all year. No timezone library, no DST bug in October.
 */
function brisbaneHour(at = new Date()) {
  return new Date(at.getTime() + 10 * 3600_000).getUTCHours();
}

function brisbaneDay(at = new Date()) {
  /* 0 is Sunday. */
  return new Date(at.getTime() + 10 * 3600_000).getUTCDay();
}

export function withinSendingHours(at = new Date()) {
  const h = brisbaneHour(at);
  return h >= QUIET_HOURS.startSending && h < QUIET_HOURS.stopSending;
}

/** No texts on a Sunday. A marketing SMS on a weekend morning is a complaint. */
export function smsAllowedNow(at = new Date()) {
  return withinSendingHours(at) && brisbaneDay(at) !== 0;
}

/* ---------------------------------------------------------------------------
 * Consent
 *
 * Australian Spam Act terms, not marketing terms. There are two lawful bases
 * and Terra has both:
 *
 *   EXPRESS    the contact ticked a box. `marketingOptIn` is true.
 *   INFERRED   an existing customer relationship. Terra installed their floor,
 *              so they reasonably expect to hear from Terra about flooring.
 *              Carried as `marketingBasis = 'completed_job'`.
 *
 * Inferred consent is real consent under the Act, and it is what makes the
 * 262 completed-job contacts reachable. It is also narrower: it covers flooring,
 * it does not cover anything Terra decides to sell later.
 *
 * `doNotMarket` beats both, always, and so does an unsubscribe row.
 * ------------------------------------------------------------------------- */

export type ConsentBasis = "express" | "inferred" | "none";

export interface ConsentCheck {
  allowed: boolean;
  basis: ConsentBasis;
  /** Plain English, written into the enrolment's exit reason. */
  reason: string;
}

type ContactRow = typeof schema.contacts.$inferSelect;

export function consentBasis(contact: ContactRow): ConsentBasis {
  if (contact.marketingOptIn) return "express";
  if (contact.marketingBasis === "completed_job") return "inferred";
  return "none";
}

/**
 * Synchronous part of the check: everything readable off the contact row.
 * The unsubscribe table is a separate query, done in `checkConsent`.
 */
function consentFromRow(contact: ContactRow): ConsentCheck {
  if (!contact.active) return { allowed: false, basis: "none", reason: "contact is archived" };
  if (contact.doNotMarket) {
    const why = contact.doNotMarketReason ? `: ${contact.doNotMarketReason}` : "";
    return { allowed: false, basis: "none", reason: `marked do not market${why}` };
  }
  const basis = consentBasis(contact);
  if (basis === "none") {
    return { allowed: false, basis, reason: "no consent basis, never opted in and no completed job" };
  }
  return { allowed: true, basis, reason: basis === "express" ? "express opt-in" : "existing customer" };
}

/**
 * The full check, including the opt-out table. Called before EVERY send with no
 * exceptions, including one-off blasts the office writes by hand.
 */
export async function checkConsent(
  contact: ContactRow,
  channel: "email" | "sms",
): Promise<ConsentCheck> {
  const row = consentFromRow(contact);
  if (!row.allowed) return row;

  const address = channel === "email" ? (contact.email ?? "").trim().toLowerCase() : "";
  const mobile = channel === "sms" ? normaliseMobile(contact.mobile ?? contact.phone) : null;

  if (channel === "email" && !address) {
    return { allowed: false, basis: row.basis, reason: "no email address" };
  }
  if (channel === "sms" && !mobile) {
    return { allowed: false, basis: row.basis, reason: "no valid Australian mobile" };
  }

  /* Opt-outs are held against the address itself as well as the contact id, so
   * deleting and re-importing a contact cannot resurrect consent. */
  const opted = await db
    .select({ id: schema.unsubscribes.id, channel: schema.unsubscribes.channel })
    .from(schema.unsubscribes)
    .where(
      or(
        eq(schema.unsubscribes.contactId, contact.id),
        address ? eq(schema.unsubscribes.email, address) : sql`0`,
        mobile ? eq(schema.unsubscribes.mobile, mobile) : sql`0`,
      ),
    );

  const blocked = opted.some((o) => o.channel === "all" || o.channel === channel);
  if (blocked) return { allowed: false, basis: row.basis, reason: "unsubscribed" };

  return row;
}

/* ---------------------------------------------------------------------------
 * Unsubscribe tokens
 *
 * One stable token per contact. Stable so the link in an email sent last year
 * still works, which the Act effectively requires.
 * ------------------------------------------------------------------------- */

export async function unsubscribeToken(contactId: number): Promise<string> {
  const [existing] = await db
    .select({ token: schema.unsubscribes.token })
    .from(schema.unsubscribes)
    .where(and(eq(schema.unsubscribes.contactId, contactId), sql`${schema.unsubscribes.token} != ''`))
    .limit(1);
  if (existing?.token) return existing.token;

  /* Not an opt-out row yet. The token is minted here and only becomes an
   * opt-out when the link is actually clicked. */
  return `u${contactId}-${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function unsubscribeUrl(token: string) {
  return `${siteUrl()}/api/unsubscribe/${token}`;
}

/* ---------------------------------------------------------------------------
 * Budget and pacing
 * ------------------------------------------------------------------------- */

const startOfUtcDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

/** How many marketing emails have gone out today, against the Resend free cap. */
export async function emailsSentToday(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.sends)
    .where(
      and(
        eq(schema.sends.channel, "email"),
        eq(schema.sends.status, "sent"),
        gte(schema.sends.sentAt, startOfUtcDay()),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Has this contact already had a marketing message in the cooldown window? */
export async function recentlyMessaged(contactId: number): Promise<boolean> {
  const since = new Date(Date.now() - CONTACT_COOLDOWN_HOURS * 3600_000);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.sends)
    .where(
      and(
        eq(schema.sends.contactId, contactId),
        eq(schema.sends.status, "sent"),
        gte(schema.sends.sentAt, since),
      ),
    );
  return Number(row?.n ?? 0) > 0;
}

/* ---------------------------------------------------------------------------
 * Merge fields
 * ------------------------------------------------------------------------- */

export interface MergeContext {
  contact: ContactRow;
  /** `jobs.number` is an integer column, so a number is the common case. */
  jobNumber?: string | number | null;
  product?: string | null;
}

/**
 * Every value is coerced rather than assumed to be a string. `jobs.number` is
 * an integer in the schema, and a caller passing it straight through used to
 * throw at send time — the worst possible place to find out.
 */
const str = (v: string | number | null | undefined) => (v == null ? "" : String(v).trim());

export function mergeFieldsFor({ contact, jobNumber, product }: MergeContext) {
  return {
    first_name: str(contact.firstName),
    last_name: str(contact.lastName),
    full_name: `${str(contact.firstName)} ${str(contact.lastName)}`.trim(),
    suburb: str(contact.suburb),
    job_number: str(jobNumber),
    product: str(product),
  } satisfies Record<string, string>;
}

/** The fields the office can type into a template, shown beside the editor. */
export const MERGE_FIELDS = [
  { key: "first_name", label: "First name", sample: "Sarah" },
  { key: "last_name", label: "Last name", sample: "Mitchell" },
  { key: "full_name", label: "Full name", sample: "Sarah Mitchell" },
  { key: "suburb", label: "Suburb", sample: "Mermaid Waters" },
  { key: "job_number", label: "Job number", sample: "1042" },
  { key: "product", label: "Product", sample: "Terramater Oak" },
] as const;

/**
 * Body text to the exact HTML that goes on the wire.
 *
 * Shared by the real send and the office preview on purpose. If these two ever
 * drift, the office approves one email and the homeowner receives a different
 * one, which is the whole reason a preview exists.
 */
export function renderMarketingEmail(
  bodyText: string,
  unsubUrl: string,
  useWrapper = true,
) {
  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 16px;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  return useWrapper === false ? paragraphs : wrapEmail(paragraphs, unsubUrl);
}

/* ---------------------------------------------------------------------------
 * The gated send
 * ------------------------------------------------------------------------- */

export interface MarketingSendArgs {
  contact: ContactRow;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  useWrapper?: boolean;
  journeyId?: number | null;
  stepId?: number | null;
  enrolmentId?: number | null;
  segmentId?: number | null;
  merge?: MergeContext;
  /** Bypasses consent and rails. Test sends to Terra's own staff only. */
  test?: boolean;
  /** SMS copy that asks a question, which forces the two-way number. */
  needsReply?: boolean;
}

export type MarketingResult =
  | { ok: true; sendId: number; providerId: string }
  | { ok: false; sendId: number | null; deferred: boolean; reason: string };

/**
 * The only way a marketing message may leave Terra Ops.
 *
 * Order matters. Consent is checked before anything is written, because a send
 * row for a message that was never allowed is misleading in the audit trail.
 * Everything that IS attempted gets a row, including failures, because a review
 * request that silently vanished is the exact thing this table exists to catch.
 */
export async function sendMarketing(args: MarketingSendArgs): Promise<MarketingResult> {
  const { contact, channel, test = false } = args;

  /* ---- 1. Consent, unless this is a test to Terra's own address ---- */
  if (!test) {
    const consent = await checkConsent(contact, channel);
    if (!consent.allowed) {
      return { ok: false, sendId: null, deferred: false, reason: consent.reason };
    }
  }

  /* ---- 2. Quiet hours ---- */
  if (!test) {
    if (channel === "email" && !withinSendingHours()) {
      return { ok: false, sendId: null, deferred: true, reason: "outside sending hours" };
    }
    if (channel === "sms" && !smsAllowedNow()) {
      return { ok: false, sendId: null, deferred: true, reason: "outside SMS sending hours" };
    }
  }

  /* ---- 3. Per-contact cooldown ---- */
  if (!test && (await recentlyMessaged(contact.id))) {
    return {
      ok: false,
      sendId: null,
      deferred: true,
      reason: `already messaged within ${CONTACT_COOLDOWN_HOURS}h`,
    };
  }

  /* ---- 4. Daily budget, email only. SMS is billed per message, not capped. ---- */
  if (!test && channel === "email" && (await emailsSentToday()) >= MARKETING_DAILY_BUDGET) {
    return { ok: false, sendId: null, deferred: true, reason: "daily email budget reached" };
  }

  /* ---- 5. Fill the copy ---- */
  const fields = mergeFieldsFor(args.merge ?? { contact });
  const subject = fillMergeFields(args.subject ?? "", fields);
  const bodyText = fillMergeFields(args.body, fields);

  const token = await unsubscribeToken(contact.id);
  const unsubUrl = unsubscribeUrl(token);

  /* ---- 6. Write the row BEFORE sending ---- */
  const toAddress =
    channel === "email"
      ? (contact.email ?? "").trim()
      : (normaliseMobile(contact.mobile ?? contact.phone) ?? "");

  const [row] = await db
    .insert(schema.sends)
    .values({
      contactId: contact.id,
      journeyId: args.journeyId ?? null,
      stepId: args.stepId ?? null,
      enrolmentId: args.enrolmentId ?? null,
      segmentId: args.segmentId ?? null,
      channel,
      toAddress,
      subject,
      /* Snapshot as sent. A later template edit must never rewrite history. */
      body: bodyText,
      status: "queued",
      attempts: 1,
    })
    .returning();

  const sendId = row!.id;

  /* ---- 7. On the wire ---- */
  if (channel === "email") {
    const html = renderMarketingEmail(bodyText, unsubUrl, args.useWrapper !== false);
    const text = bodyText + footerText(unsubUrl);

    const out = await sendEmail({ to: toAddress, subject, html, text, unsubscribeUrl: unsubUrl });

    if (out.ok) {
      await db
        .update(schema.sends)
        .set({ status: "sent", providerId: out.providerId, sentAt: new Date() })
        .where(eq(schema.sends.id, sendId));
      return { ok: true, sendId, providerId: out.providerId };
    }

    await db
      .update(schema.sends)
      .set({ status: out.deferred ? "deferred" : "failed", failReason: out.reason })
      .where(eq(schema.sends.id, sendId));
    return { ok: false, sendId, deferred: out.deferred, reason: out.reason };
  }

  /* SMS. Every Terra text carries the opt-out line, by law and by manners. */
  const smsBody = bodyText.includes("STOP") ? bodyText : bodyText + SMS_OPT_OUT;
  const out = await sendSms({ to: toAddress, body: smsBody, sender: "auto", needsReply: args.needsReply });

  if (out.ok) {
    await db
      .update(schema.sends)
      .set({
        status: "sent",
        providerId: out.providerId,
        cost: out.price,
        body: smsBody,
        sentAt: new Date(),
      })
      .where(eq(schema.sends.id, sendId));
    return { ok: true, sendId, providerId: out.providerId };
  }

  await db
    .update(schema.sends)
    .set({ status: out.deferred ? "deferred" : "failed", failReason: out.reason, body: smsBody })
    .where(eq(schema.sends.id, sendId));
  return { ok: false, sendId, deferred: out.deferred, reason: out.reason };
}

/** What an SMS step will cost before it runs, for the office to see. */
export const smsCostEstimate = (body: string, recipients: number) =>
  smsParts(body + SMS_OPT_OUT) * recipients * 0.079;
