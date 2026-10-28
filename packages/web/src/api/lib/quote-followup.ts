import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { dateIn, hourIn, notBusinessDay, onOrAfterBusinessDay, timeZoneForPostcode, zonedTimeOn, type ShowDays } from "./business-days";
import { ensureForQuote, logMessage } from "./conversations";
import { SEND_FROM } from "./gmail";
import { contactsByEmails, sendJobEmail } from "./job-mail";
import { addLocalDays, daysApart, localDate } from "./local-date";
import { checkConsent, unsubscribeToken, unsubscribeUrl } from "./marketing";
import { notifyOffice } from "./notify";
import { quoteRecipients, EMAIL_RE } from "./quote-email";
import { quoteUrl } from "./quote-links";
import { isLiveServer } from "./runtime";
import {
  FLOOR_CATEGORIES,
  FOLLOWUP_STEPS,
  FOLLOWUP_PHONE,
  STEP_PURPOSE,
  TRADE_STEP_PURPOSE,
  renderFollowup,
  type FloorFact,
  type FollowupFacts,
  type FollowupStep,
  type PrepFact,
  type RenderedFollowup,
} from "./quote-followup-wording";

/* ---------------------------------------------------------------------------
 * QUOTE FOLLOW-UP EMAILS (28 Oct).
 *
 * After a quote is emailed, up to four follow-ups: days 3, 7, 14 and 25, at
 * 10am in the customer's time zone (Brisbane unless the site postcode says
 * otherwise). A weekend, a Queensland public holiday or the Christmas
 * shutdown moves a step to the next business day, and no two steps are ever
 * closer than MIN_GAP_DAYS. Day 7 only goes when prep or removal was quoted.
 * Day 25 is the last.
 *
 * Kept apart from the prep messages (lib/prep.ts) and the after-job care
 * emails (lib/care-engine.ts): its own tables, its own timer, its own switch.
 *
 * Rules, all from Damien:
 *   - One sequence per quote NUMBER. A revised version moves the sequence on
 *     to the new version and re-spaces what is left. Nothing already sent goes
 *     again, and no burst of catch-up emails ever goes.
 *   - Each step is a row claimed (scheduled to sending) before it goes.
 *   - Everything is checked again right before each send: quote status, later
 *     versions, expiry, job stage, deposit, unsubscribe, consent, bounces,
 *     replies, recent manual contact.
 *   - A reply, text or app message from the customer pauses it at once, tells
 *     the office and makes a task. A person resumes or stops it.
 *   - Never enrolled from the backlog without a person picking the quote.
 *   - Off until switched on in Settings, and the timer only runs on the
 *     published server (or QUOTE_FOLLOWUP_TIMER=on in a scratch copy).
 * ------------------------------------------------------------------------- */

export const FU_ON_KEY = "quote_followup_on";
export const FU_AUTO_KEY = "quote_followup_auto_enrol";
export const FU_CONSENT_KEY = "quote_followup_consent";
export const FU_SHOW_DAYS_KEY = "quote_followup_show_days";
export const FU_HOUR_KEY = "quote_followup_send_hour";

export const MIN_GAP_DAYS = 3;
/** Nothing goes after this hour in the customer's time zone. A late tick waits for the next business day. */
const LAST_HOUR = 17;
/** Follow-ups a day, across every quote. Well under the mail limits. */
export const DAILY_CAP = 40;
/** Another email or text to the customer this recently pushes a step back. */
const RECENT_CONTACT_HOURS = 48;
/** Two quotes for one person: their follow-ups are at least this far apart. */
const SAME_PERSON_GAP_HOURS = 72;
/** A step left "sending" this long means the server stopped mid-send. A person checks it. */
const STALE_SENDING_MS = 15 * 60_000;

export const FOLLOWUP_AUTHOR = "Terra Ops (quote follow-up)";
export const followupLabel = (step: number) => `Quote follow-up, day ${step}`;

const JOB_STAGE_STOP: Record<number, string> = {
  3: "Won",
  4: "Scheduled",
  5: "In Progress",
  6: "Complete",
  7: "Invoiced",
  8: "Paid",
  9: "Cancelled",
};

type Quote = typeof schema.quotes.$inferSelect;
type Seq = typeof schema.quoteFollowups.$inferSelect;
type Step = typeof schema.quoteFollowupSteps.$inferSelect;
type Contact = typeof schema.contacts.$inferSelect;

/* ------------------------------ settings --------------------------------- */

export type ConsentMode = "marketing" | "quote_request";
export type FollowupSettings = { on: boolean; autoEnrol: boolean; consent: ConsentMode; showDays: ShowDays; sendHour: number };

export async function followupSettings(): Promise<FollowupSettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [FU_ON_KEY, FU_AUTO_KEY, FU_CONSENT_KEY, FU_SHOW_DAYS_KEY, FU_HOUR_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const hour = Number(v.get(FU_HOUR_KEY));
  const show = v.get(FU_SHOW_DAYS_KEY);
  return {
    /* Off unless someone switched it on. */
    on: v.get(FU_ON_KEY) === "1",
    autoEnrol: v.get(FU_AUTO_KEY) === "1",
    consent: v.get(FU_CONSENT_KEY) === "quote_request" ? "quote_request" : "marketing",
    showDays: show === "none" || show === "brisbane" || show === "both" ? show : "gold_coast",
    sendHour: Number.isInteger(hour) && hour >= 8 && hour < LAST_HOUR ? hour : 10,
  };
}

export async function saveFollowupSettings(s: FollowupSettings) {
  const put = (key: string, value: string) =>
    db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  await put(FU_ON_KEY, s.on ? "1" : "0");
  await put(FU_AUTO_KEY, s.autoEnrol ? "1" : "0");
  await put(FU_CONSENT_KEY, s.consent);
  await put(FU_SHOW_DAYS_KEY, s.showDays);
  await put(FU_HOUR_KEY, String(s.sendHour));
}

/* ------------------------------ schedule --------------------------------- */

export type PlannedStep = { step: FollowupStep; dueDate: string; status: string; agreed: boolean; sentDate: string | null; moved: string | null };

/**
 * The dates for every step. Sent, skipped and stopped steps stay put. An
 * agreed date stays put. The rest count from the anchor, never closer than
 * MIN_GAP_DAYS to the step before, never before `floor`, and always on a
 * business day.
 */
export function layoutSteps(
  anchor: string,
  steps: Array<{ step: FollowupStep; status: string; dueDate?: string | null; agreed?: boolean; sentDate?: string | null }>,
  opts: { showDays: ShowDays; floor?: string },
): PlannedStep[] {
  let prev = anchor;
  const out: PlannedStep[] = [];
  for (const s of [...steps].sort((a, b) => a.step - b.step)) {
    if (s.status === "sent" && s.sentDate) {
      prev = s.sentDate;
      out.push({ step: s.step, dueDate: s.dueDate ?? s.sentDate, status: s.status, agreed: !!s.agreed, sentDate: s.sentDate, moved: null });
      continue;
    }
    if (s.status === "skipped" || s.status === "stopped") {
      out.push({ step: s.step, dueDate: s.dueDate ?? addLocalDays(anchor, s.step), status: s.status, agreed: !!s.agreed, sentDate: null, moved: null });
      continue;
    }
    if (s.agreed && s.dueDate) {
      prev = s.dueDate;
      out.push({ step: s.step, dueDate: s.dueDate, status: s.status, agreed: true, sentDate: null, moved: null });
      continue;
    }
    const raw = addLocalDays(anchor, s.step);
    let d = raw;
    if (d < addLocalDays(prev, MIN_GAP_DAYS)) d = addLocalDays(prev, MIN_GAP_DAYS);
    if (opts.floor && d < opts.floor) d = opts.floor;
    const firstTry = d;
    d = onOrAfterBusinessDay(d, opts.showDays);
    const why = d !== firstTry ? notBusinessDay(firstTry, opts.showDays) : null;
    const moved = d !== raw ? (why ? `moved from ${auDate(raw)}: ${why}` : `moved from ${auDate(raw)} to keep ${MIN_GAP_DAYS} days between emails`) : null;
    prev = d;
    out.push({ step: s.step, dueDate: d, status: s.status, agreed: false, sentDate: null, moved });
  }
  return out;
}

export const auDate = (d: string) => d.split("-").reverse().join("/");
/** A local YYYY-MM-DD as "28 October". The date is already local, so it is read as UTC. */
const longDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-AU", { timeZone: "UTC", day: "numeric", month: "long" });
const startDay = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long" });

/* ------------------------------ the quote -------------------------------- */

/** Every version of a quote number, newest first. */
async function versionsOf(quoteNumber: number) {
  return db.select().from(schema.quotes).where(eq(schema.quotes.number, quoteNumber)).orderBy(desc(schema.quotes.version));
}

/** The newest version that went out. */
export function latestSent(versions: Quote[]) {
  return versions.find((q) => q.status === "sent" && q.sentAt) ?? null;
}

export const quoteRefOf = (q: Pick<Quote, "number" | "version">) => (q.version > 1 ? `${q.number}-${q.version}` : String(q.number));

/** "a@b.com, Name <c@d.com>" to ["a@b.com", "c@d.com"]: lower case, each once, only real addresses. */
export function splitAddresses(s: string | null | undefined) {
  return [
    ...new Set(
      (s ?? "")
        .split(/[,;]/)
        .map((x) => (x.match(/<([^>]+)>/)?.[1] ?? x).trim().toLowerCase())
        .filter((x) => EMAIL_RE.test(x)),
    ),
  ];
}

export type SentTo = { to: string; cc: string[] };

/** Who the quote email for this version actually went to, from the last send logged with its PDF. */
export async function quoteSentTo(quote: Pick<Quote, "id" | "number">): Promise<SentTo | null> {
  const [m] = await db
    .select({ to: schema.messages.toAddress, cc: schema.messages.ccAddress })
    .from(schema.messages)
    .innerJoin(schema.messageAttachments, eq(schema.messageAttachments.messageId, schema.messages.id))
    .where(
      and(
        eq(schema.messages.direction, "out"),
        eq(schema.messages.status, "sent"),
        sql`${schema.messageAttachments.storageKey} like ${`quotes/${quote.number}/${quote.id}/sent-%`}`,
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);
  const to = splitAddresses(m?.to)[0];
  return to ? { to, cc: splitAddresses(m?.cc).filter((c) => c !== to) } : null;
}

/** What a sequence has saved, or null for an old row with nothing saved (read from the quote email instead). */
export const seqSentTo = (seq: Pick<Seq, "toAddress" | "ccAddresses">): SentTo | null =>
  seq.toAddress ? { to: seq.toAddress.toLowerCase(), cc: splitAddresses(seq.ccAddresses) } : null;

const PROVISIONAL_RE = /provisional|allowance|\bp\.?\s?c\.?\s+(sum|item)\b|\bprov\.?\b/i;

/** Who signs it: whoever emailed the quote, else Damien. */
async function assignedFor(quote: Quote) {
  const [sent] = await db
    .select({ actorName: schema.activityLog.actorName })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "quote"), eq(schema.activityLog.entityId, quote.id), eq(schema.activityLog.action, "sent")))
    .orderBy(desc(schema.activityLog.id))
    .limit(1);
  const staff = await db
    .select({ id: schema.profiles.id, name: schema.profiles.name, role: schema.profiles.role, active: schema.profiles.active })
    .from(schema.profiles)
    .where(inArray(schema.profiles.role, ["admin", "office"]));
  const byName = staff.find((p) => p.active && sent?.actorName && p.name.trim().toLowerCase() === sent.actorName.trim().toLowerCase());
  const fallback = staff.find((p) => p.id === 1) ?? staff.find((p) => p.role === "admin");
  const p = byName ?? fallback ?? null;
  return { profileId: p?.id ?? null, name: p?.name ?? "Damien Lacey" };
}

export type QuoteFacts = {
  quote: Quote;
  versions: Quote[];
  facts: FollowupFacts;
  audience: "homeowner" | "trade";
  /** The To of the quote email, when it has a contact card. */
  recipient: { contactId: number | null; name: string; email: string } | null;
  /** Why there is no recipient, in words for the card. */
  recipientIssue: string | null;
  contact: Contact | null;
  /** Everyone copied in on the quote email, with their card when there is one. */
  cc: Array<{ email: string; contact: Contact | null }>;
  jobStatusId: number | null;
  depositPaid: boolean;
  timeZone: string;
  validUntilDate: string | null;
  sentDate: string;
  assigned: { profileId: number | null; name: string };
  linkExists: boolean;
};

/**
 * Everything the wording needs, read from the quote, the job and the contact.
 * `makeLink` false never writes: a quote with no link yet shows a placeholder.
 */
export async function quoteFacts(
  quoteId: number,
  opts: { makeLink: boolean; assigned?: { profileId: number | null; name: string }; sentTo?: SentTo | null },
): Promise<QuoteFacts | null> {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote) return null;
  const versions = await versionsOf(quote.number);
  const company = quote.companyId ? (await db.select().from(schema.companies).where(eq(schema.companies.id, quote.companyId)))[0] ?? null : null;
  const audience: "homeowner" | "trade" = company ? "trade" : "homeowner";
  const [job] = quote.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, quote.jobId)) : [];
  const siteId = quote.siteId ?? job?.siteId ?? null;
  const [site] = siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)) : [];

  /*
   * The people the quote email went to (Damien, 28 Oct): the To, and everyone
   * copied in. Each needs a contact card, because each needs their own
   * unsubscribe link. A quote with no logged send falls back to the first
   * person on it with a card.
   */
  const sentTo = opts.sentTo ?? (await quoteSentTo(quote));
  const fallback = sentTo ? null : ((await quoteRecipients(quote)).find((r) => r.contactId && EMAIL_RE.test(r.email)) ?? null);
  const toEmail = sentTo?.to ?? fallback?.email.trim().toLowerCase() ?? null;
  const ccEmails = (sentTo?.cc ?? []).filter((e) => e !== toEmail);
  const cards = await contactsByEmails([toEmail ?? "", ...ccEmails].filter(Boolean));
  const preferIds = [quote.contactId, quote.supervisorContactId].filter((x): x is number => !!x);
  const cardFor = (email: string) => {
    const xs = cards.filter((c) => (c.email ?? "").trim().toLowerCase() === email).sort((a, b) => a.id - b.id);
    return xs.find((c) => preferIds.includes(c.id)) ?? xs[0] ?? null;
  };
  const contact: Contact | null = fallback?.contactId
    ? ((await db.select().from(schema.contacts).where(eq(schema.contacts.id, fallback.contactId)))[0] ?? null)
    : toEmail
      ? cardFor(toEmail)
      : null;
  const pick = toEmail && contact ? { contactId: contact.id, name: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim(), email: toEmail } : null;
  const recipientIssue = pick
    ? null
    : toEmail
      ? `The quote went to ${toEmail}, which has no contact card, so they would have no way to unsubscribe. Add them as a contact.`
      : "Nobody on the quote with an email and a contact card.";
  const cc = ccEmails.map((email) => ({ email, contact: cardFor(email) }));

  const items = await db
    .select({ item: schema.quoteItems, product: schema.products, rate: schema.labourRateItems })
    .from(schema.quoteItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .leftJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.quoteItems.rateItemId))
    .where(eq(schema.quoteItems.quoteId, quote.id))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));

  const floors: FloorFact[] = [];
  for (const r of [...items].sort((a, b) => b.item.total - a.item.total)) {
    const cat = r.product?.category ?? "";
    if (r.item.kind !== "supply" || !r.product || !FLOOR_CATEGORIES.includes(cat)) continue;
    const f = { brand: r.product.brand ?? "", range: r.product.range ?? "", colour: r.product.colour ?? "", category: cat };
    if (!floors.some((x) => x.brand === f.brand && x.range === f.range && x.colour === f.colour)) floors.push(f);
  }
  const prepLines: PrepFact[] = [];
  let prepProducts = false;
  for (const r of items) {
    const isPrepLabour =
      r.item.kind === "prep" ||
      r.item.kind === "removal" ||
      ["prep", "demolition"].includes(r.rate?.groupName ?? "") ||
      (r.item.kind === "labour" && !!r.rate?.sitePrep && /level|grind|moist|remov|uplift|strip|demol|rubbish|dispos|prime|screed|sand/i.test(r.item.description));
    if (isPrepLabour) {
      const description = r.item.description.replace(/\s+/g, " ").trim();
      if (description && !prepLines.some((p) => p.description.toLowerCase() === description.toLowerCase()))
        prepLines.push({ description, provisional: PROVISIONAL_RE.test(description) });
    } else if (r.item.kind === "supply" && r.product?.sitePrep) prepProducts = true;
  }

  const rooms = quote.jobId
    ? (await db.select({ name: schema.jobAreas.name }).from(schema.jobAreas).where(eq(schema.jobAreas.jobId, quote.jobId)).orderBy(asc(schema.jobAreas.sortOrder)))
        .map((a) => a.name.trim())
        .filter(Boolean)
    : [];

  const chosen = await db
    .select({ colour: schema.materialSelectionItems.colour })
    .from(schema.materialSelections)
    .innerJoin(schema.materialSelectionItems, eq(schema.materialSelectionItems.selectionId, schema.materialSelections.id))
    .where(
      and(
        eq(schema.materialSelections.status, "submitted"),
        or(eq(schema.materialSelections.quoteId, quote.id), quote.jobId ? eq(schema.materialSelections.jobId, quote.jobId) : sql`0`),
      ),
    );
  const coloursChosen = [...new Set(chosen.map((c) => (c.colour ?? "").trim()).filter(Boolean))];

  const [link] = await db.select().from(schema.quoteLinks).where(eq(schema.quoteLinks.quoteId, quote.id));
  let url: string | null = link ? quoteUrl(link.token) : null;
  if (!url && opts.makeLink) {
    const { linkForQuote } = await import("./quote-links");
    url = quoteUrl((await linkForQuote(quote.id)).token);
  }

  const assigned = opts.assigned ?? (await assignedFor(quote));
  const timeZone = timeZoneForPostcode(site?.postcode);
  const sentDate = dateIn(timeZone, quote.sentAt ?? quote.createdAt);
  const facts: FollowupFacts = {
    audience,
    firstName: (contact?.firstName ?? "").trim() || null,
    companyName: company?.name?.trim() || null,
    quoteRef: quoteRefOf(quote),
    sentOn: longDay(sentDate),
    link: url,
    suburb: (site?.suburb ?? "").trim() || null,
    floors,
    rooms,
    prepLines,
    prepProductsOnly: prepProducts,
    coloursChosen,
    validUntil: quote.validUntil ? longDay(dateIn(timeZone, quote.validUntil)) : null,
    startDate: job?.scheduledStart ? startDay(job.scheduledStart) : null,
    signature: { name: assigned.name.split(" ")[0] || assigned.name, phone: FOLLOWUP_PHONE, email: SEND_FROM },
    unsubscribeUrl: contact ? unsubscribeUrl(await unsubscribeToken(contact.id)) : null,
    toEmail,
    ccUnsubscribe: [],
  };
  return {
    quote,
    versions,
    facts,
    audience,
    recipient: pick,
    recipientIssue,
    contact: contact ?? null,
    cc,
    jobStatusId: job?.statusId ?? null,
    depositPaid: !!job?.depositPaid,
    timeZone,
    validUntilDate: quote.validUntil ? dateIn(timeZone, quote.validUntil) : null,
    sentDate,
    assigned,
    linkExists: !!link,
  };
}

/* ------------------------------ checks ----------------------------------- */

export type Decision =
  | { ok: true; basis: string }
  | { ok: false; action: "stop" | "pause" | "review" | "skip" | "defer"; reason: string; until?: string };

/** What allows it, under the consent setting. */
export async function consentFor(contact: Contact | null, mode: ConsentMode) {
  if (!contact) return { allowed: false, basis: "", reason: "no contact card to send to" };
  if (mode === "marketing") {
    const c = await checkConsent(contact, "email");
    return { allowed: c.allowed, basis: c.basis, reason: c.reason };
  }
  /* Quote request: the customer asked for this quote. Opt-outs, do not market and archived still block. */
  const c = await checkConsent({ ...contact, marketingBasis: contact.marketingOptIn ? contact.marketingBasis : "completed_job" }, "email");
  return { allowed: c.allowed, basis: c.allowed ? (contact.marketingOptIn ? "express" : "quote_request") : c.basis, reason: c.reason };
}

export type CcPlan = { send: Array<{ email: string; contactId: number }>; leftOff: Array<{ email: string; why: string }> };

/**
 * Who is copied in on a follow-up. Each person needs a contact card (for
 * their own unsubscribe link), consent under the setting, and no bounce.
 * Anyone who fails is left off that email and shown on the card. The To is
 * never decided here: checkStep does that. Fills in the footer links.
 */
export async function ccPlanFor(qf: QuoteFacts, s: FollowupSettings): Promise<CcPlan> {
  const out: CcPlan = { send: [], leftOff: [] };
  const links: Array<{ email: string; url: string }> = [];
  for (const c of qf.cc) {
    if (!c.contact) {
      out.leftOff.push({ email: c.email, why: "no contact card, so no unsubscribe link. Add them as a contact to copy them in" });
      continue;
    }
    const consent = await consentFor(c.contact, s.consent);
    if (!consent.allowed) {
      out.leftOff.push({ email: c.email, why: consent.reason });
      continue;
    }
    if (await hardBounce(c.email)) {
      out.leftOff.push({ email: c.email, why: "an earlier email to them bounced" });
      continue;
    }
    out.send.push({ email: c.email, contactId: c.contact.id });
    links.push({ email: c.email, url: unsubscribeUrl(await unsubscribeToken(c.contact.id)) });
  }
  qf.facts.ccUnsubscribe = links;
  return out;
}

const leftOffText = (p: CcPlan) => (p.leftOff.length ? ` Left off: ${p.leftOff.map((l) => `${l.email} (${l.why})`).join("; ")}.` : "");

/** The last failure to this address that reads like a hard bounce. Complaints are never reported to Terra (no webhook). */
const HARD_BOUNCE_RE = /bounce|does not exist|no such user|mailbox unavailable|invalid recipient|recipient address rejected|user unknown|\b550\b/i;
async function hardBounce(email: string) {
  const rows = await db
    .select({ detail: schema.messages.statusDetail })
    .from(schema.messages)
    .where(and(eq(schema.messages.direction, "out"), eq(schema.messages.status, "failed"), sql`lower(${schema.messages.toAddress}) = ${email.toLowerCase()}`))
    .orderBy(desc(schema.messages.id))
    .limit(20);
  return rows.find((r) => HARD_BOUNCE_RE.test(r.detail ?? ""))?.detail ?? null;
}

/** The conversations a sequence's replies can land on. */
export async function threadsFor(seq: Pick<Seq, "quoteId" | "jobId">) {
  const ids = new Set<number>();
  if (seq.quoteId) {
    const rows = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.quoteId, seq.quoteId));
    rows.forEach((r) => ids.add(r.id));
  }
  if (seq.jobId) {
    const rows = await db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.jobId, seq.jobId));
    rows.forEach((r) => ids.add(r.id));
  }
  return [...ids];
}

/** The first message from the customer after `since`: an email, a text or an app message. Out of office replies do not count. */
async function inboundSince(seq: Pick<Seq, "quoteId" | "jobId" | "contactId">, since: Date, people: { emails: string[]; contactIds: number[] }) {
  const threads = await threadsFor(seq);
  const contactIds = [...new Set([seq.contactId, ...people.contactIds].filter((x): x is number => !!x))];
  const emails = [...new Set(people.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const who = [
    threads.length ? inArray(schema.messages.conversationId, threads) : null,
    contactIds.length ? inArray(schema.messages.contactId, contactIds) : null,
    seq.jobId ? eq(schema.messages.jobId, seq.jobId) : null,
    ...emails.map((e) => sql`lower(${schema.messages.fromAddress}) like ${`%${e}%`}`),
  ].filter(Boolean) as ReturnType<typeof eq>[];
  if (!who.length) return null;
  const [m] = await db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, "in"),
        eq(schema.messages.autoReply, false),
        ne(schema.messages.audience, "installer"),
        ne(schema.messages.audience, "supplier"),
        gt(schema.messages.createdAt, since),
        or(...who),
      ),
    )
    .orderBy(asc(schema.messages.id))
    .limit(1);
  return m ?? null;
}

/** An email or text Terra sent this person by hand recently. Follow-ups themselves do not count. */
async function recentManualContact(contactId: number | null, email: string, now: Date) {
  const since = new Date(now.getTime() - RECENT_CONTACT_HOURS * 3600_000);
  const [m] = await db
    .select({ at: schema.messages.createdAt, channel: schema.messages.channel, author: schema.messages.authorName })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, "out"),
        eq(schema.messages.status, "sent"),
        inArray(schema.messages.channel, ["email", "sms"]),
        gte(schema.messages.createdAt, since),
        ne(schema.messages.authorName, FOLLOWUP_AUTHOR),
        or(contactId ? eq(schema.messages.contactId, contactId) : sql`0`, sql`lower(${schema.messages.toAddress}) = ${email.toLowerCase()}`),
      ),
    )
    .orderBy(desc(schema.messages.id))
    .limit(1);
  return m ?? null;
}

/**
 * Everything, right before a send. Also used for the preview, so what the
 * office sees is what the timer will do.
 */
export async function checkStep(seq: Seq, _step: Step, qf: QuoteFacts | null, now: Date, s: FollowupSettings): Promise<Decision> {
  if (!qf) return { ok: false, action: "stop", reason: "The quote is gone." };
  const { versions } = qf;
  const accepted = versions.find((v) => v.status === "accepted" || v.status === "replaced");
  if (accepted) return { ok: false, action: "stop", reason: `Quote ${quoteRefOf(accepted)} was accepted.` };
  const newest = versions[0]!;
  if (newest.status === "declined") return { ok: false, action: "stop", reason: "The quote was declined." };
  if (newest.status === "cancelled") return { ok: false, action: "stop", reason: "The quote was cancelled." };
  if (newest.status === "expired") return { ok: false, action: "stop", reason: "The quote is marked expired." };
  const sent = latestSent(versions);
  if (!sent) return { ok: false, action: "stop", reason: `No version is out with the customer (latest is ${newest.status}).` };
  if (sent.id !== qf.quote.id) return { ok: false, action: "review", reason: `Version ${sent.version} went out after this was written. Check the wording.` };
  if ((newest.status === "draft" || newest.status === "needs_review") && newest.version > sent.version)
    return { ok: false, action: "review", reason: `Version ${newest.version} is being drafted. Check this still fits before it goes.` };
  if (qf.jobStatusId && JOB_STAGE_STOP[qf.jobStatusId]) return { ok: false, action: "stop", reason: `The job is ${JOB_STAGE_STOP[qf.jobStatusId]}.` };
  if (qf.depositPaid) return { ok: false, action: "stop", reason: "The deposit is paid." };

  const today = dateIn(seq.timeZone, now);
  if (qf.validUntilDate && qf.validUntilDate <= today)
    return { ok: false, action: "stop", reason: `The quote ${qf.validUntilDate < today ? "expired" : "expires"} on ${auDate(qf.validUntilDate)}. It needs a review before the customer is told it can still be accepted.` };

  if (!qf.recipient) return { ok: false, action: "review", reason: qf.recipientIssue ?? "Nobody on the quote with an email and a contact card." };
  const email = qf.recipient.email;
  const consent = await consentFor(qf.contact, s.consent);
  if (!consent.allowed)
    return consent.reason === "unsubscribed" || consent.reason.startsWith("marked do not market")
      ? { ok: false, action: "stop", reason: `The customer is ${consent.reason}.` }
      : { ok: false, action: "stop", reason: `No consent to follow up: ${consent.reason}.` };
  const bounce = await hardBounce(email);
  if (bounce) return { ok: false, action: "stop", reason: `Email to ${email} bounced: ${bounce.slice(0, 160)}` };

  const reply = await inboundSince(seq, seq.repliesSeenAt, peopleOf(qf));
  if (reply) return { ok: false, action: "pause", reason: `The customer got in touch on ${auDate(localDate(reply.createdAt))} (${reply.channel}). Answer them first.` };

  if (seq.pausedUntil && seq.pausedUntil > today) return { ok: false, action: "defer", reason: `Asked to wait until ${auDate(seq.pausedUntil)}.`, until: seq.pausedUntil };

  const manual = await recentManualContact(qf.contact?.id ?? null, email, now);
  if (manual) {
    const until = onOrAfterBusinessDay(addLocalDays(dateIn(seq.timeZone, manual.at), 2), s.showDays);
    if (until > today) return { ok: false, action: "defer", reason: `${manual.author || "Terra"} sent a ${manual.channel === "sms" ? "text" : "email"} on ${auDate(localDate(manual.at))}.`, until };
  }

  if (qf.contact) {
    const [other] = await db
      .select({ at: schema.quoteFollowupSteps.sentAt, n: schema.quoteFollowupSteps.quoteNumber })
      .from(schema.quoteFollowupSteps)
      .innerJoin(schema.quoteFollowups, eq(schema.quoteFollowups.id, schema.quoteFollowupSteps.followupId))
      .where(
        and(
          eq(schema.quoteFollowups.contactId, qf.contact.id),
          ne(schema.quoteFollowups.quoteNumber, seq.quoteNumber),
          eq(schema.quoteFollowupSteps.status, "sent"),
          gte(schema.quoteFollowupSteps.sentAt, new Date(now.getTime() - SAME_PERSON_GAP_HOURS * 3600_000)),
        ),
      )
      .limit(1);
    if (other?.at) {
      const until = onOrAfterBusinessDay(addLocalDays(dateIn(seq.timeZone, other.at), 3), s.showDays);
      if (until > today) return { ok: false, action: "defer", reason: `A follow-up for quote ${other.n} went to the same person on ${auDate(localDate(other.at))}.`, until };
    }
  }

  if (notBusinessDay(today, s.showDays)) return { ok: false, action: "defer", reason: `Today is not a business day (${notBusinessDay(today, s.showDays)}).`, until: onOrAfterBusinessDay(today, s.showDays) };
  const hour = hourIn(seq.timeZone, now);
  if (hour >= LAST_HOUR) return { ok: false, action: "defer", reason: "Too late in the day to send.", until: onOrAfterBusinessDay(addLocalDays(today, 1), s.showDays) };
  if (hour < s.sendHour) return { ok: false, action: "defer", reason: "Before the send time.", until: today };
  return { ok: true, basis: consent.basis };
}

/** Everyone on the quote email, for the reply check: a reply from anyone copied in pauses it too. */
const peopleOf = (qf: QuoteFacts) => ({
  emails: [qf.recipient?.email ?? "", ...qf.cc.map((c) => c.email)].filter(Boolean),
  contactIds: qf.cc.map((c) => c.contact?.id).filter((x): x is number => !!x),
});

/* ------------------------------ rendering -------------------------------- */

/** The email for a step, from the saved edit if there is one. */
export function draftFor(step: Step, qf: QuoteFacts, today: string): RenderedFollowup {
  const weeks = Math.max(1, Math.round(daysApart(qf.sentDate, today > step.dueDate ? today : step.dueDate) / 7));
  const r = renderFollowup(step.step as FollowupStep, qf.facts, weeks);
  if (step.edited && step.subject && step.body) {
    return { ...r, subject: step.subject, text: step.body, body: step.body, review: [], notes: ["Edited by hand."], skip: null };
  }
  return r;
}

/* ------------------------------ enrol ------------------------------------ */

async function logQuote(quote: Pick<Quote, "id" | "jobId" | "contactId">, action: string, detail: string, actorName: string) {
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action,
    detail: detail.slice(0, 500),
    actorName,
    actorRole: "office",
  });
}

async function stepsOf(followupId: number) {
  return db.select().from(schema.quoteFollowupSteps).where(eq(schema.quoteFollowupSteps.followupId, followupId)).orderBy(asc(schema.quoteFollowupSteps.step));
}

/** Put every unsent step on the dates the layout gives. */
async function respace(seq: Seq, s: FollowupSettings, now: Date, floor?: string) {
  const steps = await stepsOf(seq.id);
  const plan = layoutSteps(
    seq.anchorDate,
    steps.map((x) => ({
      step: x.step as FollowupStep,
      status: x.status,
      dueDate: x.dueDate,
      agreed: x.dateAgreed,
      sentDate: x.sentAt ? dateIn(seq.timeZone, x.sentAt) : null,
    })),
    { showDays: s.showDays, floor: floor ?? addLocalDays(dateIn(seq.timeZone, now), 1) },
  );
  for (const p of plan) {
    const row = steps.find((x) => x.step === p.step)!;
    if (!["scheduled", "needs_review", "failed"].includes(row.status) || p.agreed) continue;
    const dueAt = zonedTimeOn(p.dueDate, `${String(s.sendHour).padStart(2, "0")}:00`, seq.timeZone);
    if (row.dueDate !== p.dueDate || row.dueAt.getTime() !== dueAt.getTime())
      await db
        .update(schema.quoteFollowupSteps)
        .set({ dueDate: p.dueDate, dueAt, reason: p.moved ?? row.reason, updatedAt: new Date() })
        .where(eq(schema.quoteFollowupSteps.id, row.id));
  }
}

export type EnrolResult = { ok: true; followupId: number; created: boolean } | { ok: false; reason: string };

/**
 * Start the follow-ups for a quote. On send (the setting decides) or by hand
 * from the backlog, never in bulk. From the backlog, `firstStep` is where it
 * starts: the steps before it are skipped, never sent late.
 */
export async function enrolQuote(
  quoteId: number,
  args: { byName: string; how: "on_send" | "backlog"; firstStep?: FollowupStep; now?: Date; sentTo?: SentTo | null },
): Promise<EnrolResult> {
  const now = args.now ?? new Date();
  const s = await followupSettings();
  const qf = await quoteFacts(quoteId, { makeLink: false, sentTo: args.sentTo });
  if (!qf) return { ok: false, reason: "Quote not found." };
  const sent = latestSent(qf.versions);
  if (!sent || sent.id !== qf.quote.id) return { ok: false, reason: "Only the newest version that went out can be followed up." };
  const [existing] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.quoteNumber, qf.quote.number));
  if (existing) return { ok: true, followupId: existing.id, created: false };
  if (!qf.recipient || !qf.contact) return { ok: false, reason: qf.recipientIssue ?? "Nobody on the quote with an email and a contact card." };
  const consent = await consentFor(qf.contact, s.consent);
  if (!consent.allowed) return { ok: false, reason: `Not enrolled: ${consent.reason}.` };
  if (qf.validUntilDate && qf.validUntilDate <= dateIn(qf.timeZone, now)) return { ok: false, reason: "The quote has expired. Review it first." };

  const [seq] = await db
    .insert(schema.quoteFollowups)
    .values({
      quoteNumber: qf.quote.number,
      quoteId: qf.quote.id,
      jobId: qf.quote.jobId,
      contactId: qf.contact.id,
      companyId: qf.quote.companyId,
      toAddress: qf.recipient.email,
      ccAddresses: qf.cc.map((c) => c.email).join(","),
      audience: qf.audience,
      anchorDate: qf.sentDate,
      timeZone: qf.timeZone,
      status: "active",
      repliesSeenAt: args.how === "backlog" ? now : (qf.quote.sentAt ?? now),
      assignedProfileId: qf.assigned.profileId,
      assignedName: qf.assigned.name,
      consentBasis: consent.basis,
      enrolledByName: args.byName,
      enrolledHow: args.how,
    })
    .onConflictDoNothing()
    .returning();
  if (!seq) {
    const [again] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.quoteNumber, qf.quote.number));
    return again ? { ok: true, followupId: again.id, created: false } : { ok: false, reason: "Could not start the follow-ups." };
  }
  const first = args.firstStep ?? 3;
  for (const step of FOLLOWUP_STEPS) {
    const skipped = step < first;
    await db
      .insert(schema.quoteFollowupSteps)
      .values({
        followupId: seq.id,
        quoteNumber: seq.quoteNumber,
        step,
        dueDate: addLocalDays(seq.anchorDate, step),
        dueAt: zonedTimeOn(addLocalDays(seq.anchorDate, step), "10:00", seq.timeZone),
        status: skipped ? "skipped" : "scheduled",
        reason: skipped ? "Started late from the backlog, so this step is not sent." : null,
        quoteId: qf.quote.id,
        toAddress: qf.recipient.email,
        byName: args.byName,
      })
      .onConflictDoNothing();
  }
  await respace(seq, s, now);
  await logQuote(qf.quote, "followup_enrolled", `Quote follow-ups started (${args.how === "backlog" ? `by hand, from day ${first}` : "on send"}) for ${qf.recipient.email}${qf.cc.length ? `, copying in ${qf.cc.map((c) => c.email).join(", ")}` : ""}`, args.byName);
  return { ok: true, followupId: seq.id, created: true };
}

/**
 * A quote was emailed. A new version moves the sequence on to it and re-spaces
 * what is left (nothing sent goes again). A first send enrols it when the
 * setting is on. Never throws: the quote has already gone.
 */
export async function onQuoteSent(quoteId: number, byName: string, sent?: { to: string; cc?: string[] }) {
  try {
    const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
    if (!quote) return;
    const [seq] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.quoteNumber, quote.number));
    const s = await followupSettings();
    /* Exactly who this send went to. The log is the fallback. */
    const to = sent ? splitAddresses(sent.to)[0] : undefined;
    const sentTo: SentTo | null = to ? { to, cc: splitAddresses((sent?.cc ?? []).join(",")).filter((c) => c !== to) } : await quoteSentTo(quote);
    if (seq) {
      if (seq.status === "stopped" || seq.status === "done") return;
      const [prev] = seq.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, seq.quoteId)) : [];
      if (prev && prev.version > quote.version) return;
      /* The follow-ups go to whoever this latest send went to. */
      const people = sentTo
        ? { toAddress: sentTo.to, ccAddresses: sentTo.cc.join(","), contactId: (await contactsByEmails([sentTo.to])).sort((a, b) => a.id - b.id)[0]?.id ?? seq.contactId }
        : {};
      if (seq.quoteId === quote.id) {
        /* The same version sent again, perhaps to someone else. Same steps, new people. */
        if (sentTo) await setSeq(seq, people);
        return;
      }
      const anchor = dateIn(seq.timeZone, new Date());
      await db.update(schema.quoteFollowups).set({ quoteId: quote.id, anchorDate: anchor, ...people, updatedAt: new Date() }).where(eq(schema.quoteFollowups.id, seq.id));
      await db
        .update(schema.quoteFollowupSteps)
        .set({ status: "scheduled", reason: `Moved to version ${quote.version}, sent ${auDate(anchor)}.`, quoteId: quote.id, edited: false, subject: null, body: null, updatedAt: new Date() })
        .where(and(eq(schema.quoteFollowupSteps.followupId, seq.id), inArray(schema.quoteFollowupSteps.status, ["scheduled", "needs_review"])));
      const [fresh] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.id, seq.id));
      await respace(fresh!, s, new Date());
      await logQuote(quote, "followup_moved", `Quote follow-ups moved to version ${quote.version}. Steps already sent stay sent.`, byName);
      return;
    }
    if (s.autoEnrol) await enrolQuote(quote.id, { byName, how: "on_send", sentTo });
  } catch (e) {
    console.error("[quote-followup] onQuoteSent failed", e);
  }
}

/* ------------------------------ pause and stop --------------------------- */

async function setSeq(seq: Seq, patch: Partial<typeof schema.quoteFollowups.$inferInsert>) {
  await db.update(schema.quoteFollowups).set({ ...patch, updatedAt: new Date() }).where(eq(schema.quoteFollowups.id, seq.id));
}

/** Stop the sequence: every step not sent is stopped with the reason. */
export async function stopSequence(seq: Seq, reason: string, byName: string) {
  await setSeq(seq, { status: "stopped", reason });
  await db
    .update(schema.quoteFollowupSteps)
    .set({ status: "stopped", reason, byName, updatedAt: new Date() })
    .where(and(eq(schema.quoteFollowupSteps.followupId, seq.id), inArray(schema.quoteFollowupSteps.status, ["scheduled", "needs_review", "failed"])));
  if (seq.quoteId) await logQuote({ id: seq.quoteId, jobId: seq.jobId, contactId: seq.contactId }, "followup_stopped", `Quote follow-ups stopped: ${reason}`, byName);
}

/** Pause, tell the office, and make the next action a task for the person it is assigned to. */
export async function pauseSequence(seq: Seq, reason: string, byName: string, source?: { messageId?: number | null; conversationId?: number | null; notify?: boolean }) {
  if (seq.status === "stopped" || seq.status === "done") return;
  await setSeq(seq, { status: "paused", reason });
  if (seq.quoteId) await logQuote({ id: seq.quoteId, jobId: seq.jobId, contactId: seq.contactId }, "followup_paused", `Quote follow-ups paused: ${reason}`, byName);
  if (source?.notify === false) return;
  const title = `Quote ${seq.quoteNumber} follow-ups paused`;
  void notifyOffice("quote_followup", { title, body: `${reason}\nAssigned to ${seq.assignedName || "the office"}.`, jobId: seq.jobId, path: seq.jobId ? `/jobs/${seq.jobId}` : seq.quoteId ? `/quotes/${seq.quoteId}` : "/" });
  /* The reply pass makes its own "Reply to email" task for the same message. One task per message. */
  if (source?.messageId) {
    const [open] = await db
      .select({ id: schema.officeTasks.id })
      .from(schema.officeTasks)
      .where(and(eq(schema.officeTasks.sourceMessageId, source.messageId), eq(schema.officeTasks.status, "open")))
      .limit(1);
    if (open) {
      await db
        .update(schema.officeTasks)
        .set({ assignedProfileId: seq.assignedProfileId, assignedName: seq.assignedName, updatedAt: new Date() })
        .where(and(eq(schema.officeTasks.id, open.id), isNull(schema.officeTasks.assignedProfileId)));
      return;
    }
  }
  await db.insert(schema.officeTasks).values({
    jobId: seq.jobId,
    conversationId: source?.conversationId ?? null,
    sourceMessageId: source?.messageId ?? null,
    title: `${title}: get back to the customer, then resume or stop`.slice(0, 300),
    detail: reason.slice(0, 600),
    assignedProfileId: seq.assignedProfileId,
    assignedName: seq.assignedName,
    dueDate: localDate(),
    createdByName: FOLLOWUP_AUTHOR,
  });
}

/**
 * A customer message was just logged (conversations.logMessage). Pause every
 * live sequence it belongs to. Never throws.
 */
export async function pauseForInbound(msg: typeof schema.messages.$inferSelect) {
  try {
    if (msg.direction !== "in" || msg.autoReply || msg.audience === "installer" || msg.audience === "supplier") return;
    const threads = msg.conversationId
      ? await db.select({ quoteId: schema.conversations.quoteId, jobId: schema.conversations.jobId }).from(schema.conversations).where(eq(schema.conversations.id, msg.conversationId))
      : [];
    const jobIds = [msg.jobId, ...threads.map((t) => t.jobId)].filter((x): x is number => !!x);
    const quoteIds = threads.map((t) => t.quoteId).filter((x): x is number => !!x);
    /* From the To or anyone copied in on the quote. */
    const from = splitAddresses(msg.fromAddress)[0];
    const conds = [
      msg.contactId ? eq(schema.quoteFollowups.contactId, msg.contactId) : null,
      jobIds.length ? inArray(schema.quoteFollowups.jobId, jobIds) : null,
      quoteIds.length ? inArray(schema.quoteFollowups.quoteId, quoteIds) : null,
      from ? sql`lower(coalesce(${schema.quoteFollowups.toAddress}, '')) = ${from}` : null,
      from ? sql`(',' || ${schema.quoteFollowups.ccAddresses} || ',') like ${`%,${from},%`}` : null,
    ].filter(Boolean) as ReturnType<typeof eq>[];
    if (!conds.length) return;
    const seqs = await db
      .select()
      .from(schema.quoteFollowups)
      .where(and(eq(schema.quoteFollowups.status, "active"), or(...conds)));
    for (const seq of seqs) {
      const what = msg.channel === "sms" ? "a text" : msg.channel === "app" ? "a message" : "an email";
      await pauseSequence(seq, `The customer sent ${what} on ${auDate(localDate(msg.createdAt))}: "${(msg.body ?? "").replace(/\s+/g, " ").slice(0, 120)}"`, FOLLOWUP_AUTHOR, {
        messageId: msg.id,
        conversationId: msg.conversationId,
      });
    }
  } catch (e) {
    console.error("[quote-followup] pauseForInbound failed", e);
  }
}

/** Every live sequence for a contact stops (an unsubscribe). Never throws. */
export async function stopForContact(contactId: number, reason: string) {
  const seqs = await db
    .select()
    .from(schema.quoteFollowups)
    .where(and(eq(schema.quoteFollowups.contactId, contactId), inArray(schema.quoteFollowups.status, ["active", "paused"])));
  for (const seq of seqs) await stopSequence(seq, reason, FOLLOWUP_AUTHOR);
  return seqs.length;
}

/* ------------------------------ the office's controls -------------------- */

async function seqOrThrow(id: number) {
  const [seq] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.id, id));
  if (!seq) throw new Error("Follow-ups not found.");
  return seq;
}

export async function pauseByHand(id: number, byName: string, until: string | null, note: string) {
  const seq = await seqOrThrow(id);
  if (seq.status === "stopped" || seq.status === "done") throw new Error("These follow-ups have ended.");
  if (until) {
    /* "Contact me next month": stays active, nothing goes before the date, then the next step goes once. */
    await setSeq(seq, { pausedUntil: until, reason: `Customer asked to wait until ${auDate(until)}${note ? `: ${note}` : ""}` });
    const s = await followupSettings();
    await respace({ ...seq, pausedUntil: until }, s, new Date(), onOrAfterBusinessDay(until, s.showDays));
    if (seq.quoteId) await logQuote({ id: seq.quoteId, jobId: seq.jobId, contactId: seq.contactId }, "followup_paused", `Quote follow-ups wait until ${auDate(until)}`, byName);
    return;
  }
  await pauseSequence(seq, note || "Paused by hand.", byName, { notify: false });
}

export async function resumeByHand(id: number, byName: string) {
  const seq = await seqOrThrow(id);
  if (seq.status === "stopped" || seq.status === "done") throw new Error("These follow-ups have ended. Start them again from the backlog.");
  const now = new Date();
  /* Replies before now have been seen. Failed and review steps go back on the schedule, once, from tomorrow. */
  await setSeq(seq, { status: "active", reason: null, repliesSeenAt: now });
  await db
    .update(schema.quoteFollowupSteps)
    .set({ status: "scheduled", error: null, updatedAt: now })
    .where(and(eq(schema.quoteFollowupSteps.followupId, seq.id), inArray(schema.quoteFollowupSteps.status, ["failed", "needs_review"])));
  await respace({ ...seq, repliesSeenAt: now }, await followupSettings(), now);
  if (seq.quoteId) await logQuote({ id: seq.quoteId, jobId: seq.jobId, contactId: seq.contactId }, "followup_resumed", "Quote follow-ups resumed", byName);
}

export async function stopByHand(id: number, byName: string, reason: string) {
  await stopSequence(await seqOrThrow(id), reason || "Stopped by hand.", byName);
}

export async function skipStep(stepId: number, byName: string) {
  const [row] = await db
    .update(schema.quoteFollowupSteps)
    .set({ status: "skipped", reason: `Skipped by ${byName}.`, byName, updatedAt: new Date() })
    .where(and(eq(schema.quoteFollowupSteps.id, stepId), inArray(schema.quoteFollowupSteps.status, ["scheduled", "needs_review", "failed"])))
    .returning();
  if (!row) throw new Error("Only a step that has not gone can be skipped.");
  const seq = await seqOrThrow(row.followupId);
  await respace(seq, await followupSettings(), new Date());
}

/** The office's own words for a step. Checked for the link and the unsubscribe. */
export async function editStep(stepId: number, byName: string, subject: string, body: string) {
  const [row] = await db.select().from(schema.quoteFollowupSteps).where(eq(schema.quoteFollowupSteps.id, stepId));
  if (!row || !["scheduled", "needs_review", "failed"].includes(row.status)) throw new Error("Only a step that has not gone can be edited.");
  if (!/\/q\/|quote/i.test(body)) throw new Error("Keep the quote link in the email.");
  if (!/unsubscribe/i.test(body)) throw new Error("Keep the unsubscribe line at the bottom.");
  await db
    .update(schema.quoteFollowupSteps)
    .set({ subject: subject.trim(), body: body.trim(), edited: true, status: "scheduled", reason: `Wording edited by ${byName}.`, byName, updatedAt: new Date() })
    .where(eq(schema.quoteFollowupSteps.id, stepId));
}

/** A date the customer agreed. It is kept through revisions and spacing. */
export async function setStepDate(stepId: number, byName: string, date: string) {
  const [row] = await db.select().from(schema.quoteFollowupSteps).where(eq(schema.quoteFollowupSteps.id, stepId));
  if (!row || !["scheduled", "needs_review"].includes(row.status)) throw new Error("Only a step that has not gone can be moved.");
  const seq = await seqOrThrow(row.followupId);
  const s = await followupSettings();
  const day = onOrAfterBusinessDay(date, s.showDays);
  if (day <= dateIn(seq.timeZone)) throw new Error("Pick a day after today.");
  await db
    .update(schema.quoteFollowupSteps)
    .set({
      dueDate: day,
      dueAt: zonedTimeOn(day, `${String(s.sendHour).padStart(2, "0")}:00`, seq.timeZone),
      dateAgreed: true,
      reason: `Date agreed with the customer, set by ${byName}${day !== date ? ` (moved to the next business day)` : ""}.`,
      byName,
      updatedAt: new Date(),
    })
    .where(eq(schema.quoteFollowupSteps.id, stepId));
  await respace(seq, s, new Date());
}

/* ------------------------------ sending ---------------------------------- */

/** Apply a check that said no. */
async function applyDecision(seq: Seq, step: Step, d: Exclude<Decision, { ok: true }>, s: FollowupSettings) {
  const now = new Date();
  if (d.action === "stop") {
    /* The claimed step goes back first, so the stop covers it too and it is never left "sending". */
    await db.update(schema.quoteFollowupSteps).set({ status: "scheduled", updatedAt: now }).where(eq(schema.quoteFollowupSteps.id, step.id));
    return stopSequence(seq, d.reason, FOLLOWUP_AUTHOR);
  }
  if (d.action === "pause") {
    await db.update(schema.quoteFollowupSteps).set({ status: "scheduled", updatedAt: now }).where(eq(schema.quoteFollowupSteps.id, step.id));
    return pauseSequence(seq, d.reason, FOLLOWUP_AUTHOR);
  }
  if (d.action === "review") {
    await db.update(schema.quoteFollowupSteps).set({ status: "needs_review", reason: d.reason, updatedAt: now }).where(eq(schema.quoteFollowupSteps.id, step.id));
    return;
  }
  if (d.action === "skip") {
    await db.update(schema.quoteFollowupSteps).set({ status: "skipped", reason: d.reason, updatedAt: now }).where(eq(schema.quoteFollowupSteps.id, step.id));
    return respace(seq, s, now);
  }
  /* Defer: the step moves to the day given, and everything after it moves with it. */
  const until = d.until ?? onOrAfterBusinessDay(addLocalDays(dateIn(seq.timeZone, now), 1), s.showDays);
  const dueAt = zonedTimeOn(until, `${String(s.sendHour).padStart(2, "0")}:00`, seq.timeZone);
  const later = dueAt.getTime() > step.dueAt.getTime();
  await db
    .update(schema.quoteFollowupSteps)
    .set({ status: "scheduled", ...(later ? { dueDate: until, dueAt, reason: `Waiting: ${d.reason}` } : {}), updatedAt: now })
    .where(eq(schema.quoteFollowupSteps.id, step.id));
  if (later) await respace(seq, s, now, until);
}

export type SendResult = { stepId: number; outcome: "sent" | "failed" | "held" | "not_claimed"; detail: string };

/**
 * Send one step if it is still right to. The row is claimed first, so two
 * ticks or two servers can never both send it.
 */
export async function sendStep(stepId: number, now: Date = new Date()): Promise<SendResult> {
  const s = await followupSettings();
  const [claimed] = await db
    .update(schema.quoteFollowupSteps)
    .set({ status: "sending", attempts: sql`${schema.quoteFollowupSteps.attempts} + 1`, updatedAt: now })
    .where(and(eq(schema.quoteFollowupSteps.id, stepId), eq(schema.quoteFollowupSteps.status, "scheduled")))
    .returning();
  if (!claimed) return { stepId, outcome: "not_claimed", detail: "Already taken or not scheduled." };
  const seq = await seqOrThrow(claimed.followupId);
  if (seq.status !== "active") {
    await db.update(schema.quoteFollowupSteps).set({ status: "scheduled", updatedAt: now }).where(eq(schema.quoteFollowupSteps.id, stepId));
    return { stepId, outcome: "held", detail: `Sequence is ${seq.status}.` };
  }
  /* The newest version that went out. If it is not the one written for, checkStep sends it to review. */
  const qf = seq.quoteId
    ? await quoteFacts(seq.quoteId, { makeLink: true, assigned: { profileId: seq.assignedProfileId, name: seq.assignedName }, sentTo: seqSentTo(seq) })
    : null;
  const d = await checkStep(seq, claimed, qf, now, s);
  if (!d.ok) {
    await applyDecision(seq, claimed, d, s);
    return { stepId, outcome: "held", detail: `${d.action}: ${d.reason}` };
  }
  /* Who is copied in. Worked out before the wording, so each of them has their own unsubscribe link in the footer. */
  const ccp = await ccPlanFor(qf!, s);
  const draft = draftFor(claimed, qf!, dateIn(seq.timeZone, now));
  /* Wording edited by hand before someone was copied in has no link for them: they are left off rather than sent without one. */
  for (const c of [...ccp.send]) {
    const link = qf!.facts.ccUnsubscribe?.find((l) => l.email === c.email)?.url;
    if (!link || !draft.text.includes(link)) {
      ccp.send = ccp.send.filter((x) => x !== c);
      ccp.leftOff.push({ email: c.email, why: "the edited wording has no unsubscribe link for them" });
    }
  }
  const cc = ccp.send.map((c) => c.email);
  if (draft.skip) {
    await applyDecision(seq, claimed, { ok: false, action: "skip", reason: draft.skip }, s);
    return { stepId, outcome: "held", detail: `skip: ${draft.skip}` };
  }
  if (draft.review.length) {
    await applyDecision(seq, claimed, { ok: false, action: "review", reason: draft.review.join(" ") }, s);
    return { stepId, outcome: "held", detail: `review: ${draft.review.join(" ")}` };
  }
  const to = qf!.recipient!.email;
  const conv = await ensureForQuote(qf!.quote.id);
  const first = (seq.assignedName || "Damien").split(" ")[0];
  try {
    const out = await sendJobEmail({
      conv,
      jobId: qf!.quote.jobId,
      to,
      cc,
      subject: draft.subject,
      text: draft.text,
      fromName: `${first} from Terra`,
      label: followupLabel(claimed.step),
      contactId: qf!.contact?.id ?? null,
      authorName: FOLLOWUP_AUTHOR,
      authorProfileId: null,
      /*
       * The one-click header unsubscribes whoever's link it carries. With people
       * copied in, any of them could press it, so it is left off and each person
       * uses their own link in the footer.
       */
      headers:
        qf!.facts.unsubscribeUrl && !cc.length
          ? { "List-Unsubscribe": `<${qf!.facts.unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
          : undefined,
    });
    await db
      .update(schema.quoteFollowupSteps)
      .set({
        status: "sent",
        sentAt: now,
        messageId: out.message.id,
        subject: out.subject,
        body: draft.text,
        toAddress: to,
        ccAddress: cc.length ? cc.join(", ") : null,
        quoteId: qf!.quote.id,
        error: null,
        reason: `Sent (${out.via}).${leftOffText(ccp)}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.quoteFollowupSteps.id, stepId));
    await respace(seq, s, now);
    if (claimed.step === 25) await setSeq(seq, { status: "done", reason: "All follow-ups sent." });
    return { stepId, outcome: "sent", detail: `${out.via} to ${to}${cc.length ? `, cc ${cc.join(", ")}` : ""}` };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 400);
    await db.update(schema.quoteFollowupSteps).set({ status: "failed", error, updatedAt: new Date() }).where(eq(schema.quoteFollowupSteps.id, stepId));
    /* Logged on the thread as failed, so Conversations shows the error where the office looks. */
    await logMessage({
      conversationId: conv.id,
      jobId: qf!.quote.jobId,
      contactId: qf!.contact?.id ?? null,
      channel: "email",
      audience: "customer",
      direction: "out",
      subject: draft.subject,
      body: draft.text,
      authorName: FOLLOWUP_AUTHOR,
      toAddress: to,
      ccAddress: cc.length ? cc.join(", ") : null,
      label: followupLabel(claimed.step),
      status: "failed",
      statusDetail: error,
      failedAt: new Date(),
    }).catch(() => null);
    await pauseSequence(seq, `Day ${claimed.step} follow-up did not send: ${error}`, FOLLOWUP_AUTHOR);
    return { stepId, outcome: "failed", detail: error };
  }
}

/* ------------------------------ the timer -------------------------------- */

let ticking = false;

export async function tickFollowups(now: Date = new Date()) {
  if (ticking) return { sent: 0, held: 0, note: "busy" };
  ticking = true;
  try {
    const s = await followupSettings();
    if (!s.on) return { sent: 0, held: 0, note: "off in Settings" };

    /* A step left mid-send means the server stopped. Never sent again on its own. */
    await db
      .update(schema.quoteFollowupSteps)
      .set({ status: "needs_review", reason: "Was being sent when the server stopped. Check the thread before sending it again.", updatedAt: now })
      .where(and(eq(schema.quoteFollowupSteps.status, "sending"), lte(schema.quoteFollowupSteps.updatedAt, new Date(now.getTime() - STALE_SENDING_MS))));

    /* Replies that came in by a path that skipped the hook. */
    const live = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.status, "active"));
    for (const seq of live) {
      const st = seqSentTo(seq);
      const reply = await inboundSince(seq, seq.repliesSeenAt, { emails: st ? [st.to, ...st.cc] : [], contactIds: [] });
      if (reply) await pauseForInbound(reply);
    }

    const [{ n: sentToday } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.quoteFollowupSteps)
      .where(and(eq(schema.quoteFollowupSteps.status, "sent"), gte(schema.quoteFollowupSteps.sentAt, new Date(now.getTime() - 24 * 3600_000))));
    let room = Math.max(0, DAILY_CAP - Number(sentToday));

    /* The earliest due step per active sequence, and only that one: missed steps never go together. */
    const due = await db
      .select({ step: schema.quoteFollowupSteps })
      .from(schema.quoteFollowupSteps)
      .innerJoin(schema.quoteFollowups, eq(schema.quoteFollowups.id, schema.quoteFollowupSteps.followupId))
      .where(and(eq(schema.quoteFollowups.status, "active"), eq(schema.quoteFollowupSteps.status, "scheduled"), lte(schema.quoteFollowupSteps.dueAt, now)))
      .orderBy(asc(schema.quoteFollowupSteps.dueAt), asc(schema.quoteFollowupSteps.step));
    const seen = new Set<number>();
    let sent = 0;
    let held = 0;
    for (const { step } of due) {
      if (seen.has(step.followupId)) continue;
      seen.add(step.followupId);
      if (room <= 0) break;
      const r = await sendStep(step.id, now);
      if (r.outcome === "sent") {
        sent++;
        room--;
      } else held++;
    }
    return { sent, held, note: "" };
  } catch (e) {
    console.error("[quote-followup] tick failed", e);
    return { sent: 0, held: 0, note: String((e as Error)?.message ?? e) };
  } finally {
    ticking = false;
  }
}

let booted = false;
export function bootQuoteFollowups() {
  if (booted) return;
  booted = true;
  const mode = process.env.QUOTE_FOLLOWUP_TIMER;
  if (mode === "off") return void console.log("[quote-followup] timer disabled by QUOTE_FOLLOWUP_TIMER=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[quote-followup] timer idle, not the published server");
  console.log("[quote-followup] checks every 5 minutes, sends nothing until switched on in Settings");
  setInterval(() => void tickFollowups(), 5 * 60_000);
  setTimeout(() => void tickFollowups(), 60_000);
}

/* ------------------------------ what the office sees --------------------- */

const purposeOf = (audience: string, step: number) => (audience === "trade" ? TRADE_STEP_PURPOSE : STEP_PURPOSE)[step as FollowupStep] ?? "";

/** The follow-ups card: every step, its date, its wording, why it is held, and what went. */
export async function followupView(quoteId: number, now: Date = new Date()) {
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  if (!quote) return null;
  const s = await followupSettings();
  const [seq] = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.quoteNumber, quote.number));
  if (!seq) {
    const qf = await quoteFacts(quoteId, { makeLink: false });
    const sent = qf ? latestSent(qf.versions) : null;
    const consent = qf ? await consentFor(qf.contact, s.consent) : { allowed: false, reason: "" };
    const ccp = qf ? await ccPlanFor(qf, s) : { send: [], leftOff: [] };
    const blockers = [
      !sent ? "Not sent yet." : sent.id !== quote.id ? `Version ${sent.version} is the one out with the customer.` : "",
      qf && !qf.recipient ? (qf.recipientIssue ?? "Nobody on the quote with an email and a contact card.") : "",
      qf?.recipient && !consent.allowed ? `No consent: ${consent.reason}.` : "",
    ].filter(Boolean);
    const cautions: string[] = [];
    if (qf && sent?.sentAt) {
      const reply = await inboundSince({ quoteId: sent.id, jobId: sent.jobId, contactId: qf.contact?.id ?? null }, sent.sentAt, peopleOf(qf));
      if (reply) cautions.push(`The customer got in touch on ${auDate(localDate(reply.createdAt))} (${reply.channel}). Answer them before starting follow-ups.`);
    }
    if (!s.on) cautions.push("Follow-ups are off in Settings. Starting them here saves the plan, and nothing goes until they are switched on.");
    /* Started today, the steps already passed are skipped, never sent late. */
    const today = qf ? dateIn(qf.timeZone, now) : localDate(now);
    const age = qf ? daysApart(qf.sentDate, today) : 0;
    const startFrom = FOLLOWUP_STEPS.find((st) => st > age) ?? null;
    if (qf && sent && !startFrom) blockers.push("More than 25 days since it went. Too late for follow-ups.");
    const laid =
      qf && sent
        ? layoutSteps(qf.sentDate, FOLLOWUP_STEPS.map((step) => ({ step, status: startFrom && step >= startFrom ? "scheduled" : "skipped" })), {
            showDays: s.showDays,
            floor: onOrAfterBusinessDay(addLocalDays(today, 1), s.showDays),
          })
        : [];
    if (qf && !qf.facts.link) qf.facts.link = "(the quote link goes in when it sends)";
    const plan = laid.map((p) => {
      const r = qf && p.status === "scheduled" ? renderFollowup(p.step, qf.facts, Math.max(1, Math.round(daysApart(qf.sentDate, p.dueDate) / 7))) : null;
      const expiresFirst = !!qf?.validUntilDate && p.status === "scheduled" && p.dueDate >= qf.validUntilDate;
      return {
        ...p,
        purpose: purposeOf(qf?.audience ?? "homeowner", p.step),
        subject: r?.subject ?? null,
        text: r?.text ?? null,
        words: r?.words ?? null,
        review: r?.review ?? [],
        notes: r?.notes ?? [],
        skip: r?.skip ?? null,
        warnings: expiresFirst ? [`The quote expires on ${auDate(qf!.validUntilDate!)}, before this is due. It would stop instead of sending.`] : [],
      };
    });
    return {
      settings: s,
      sequence: null,
      blockers,
      cautions,
      startFrom,
      plan,
      steps: [],
      to: qf?.recipient?.email ?? null,
      cc: ccp.send.map((c) => c.email),
      ccLeftOff: ccp.leftOff,
      validUntil: qf?.validUntilDate ?? null,
    };
  }
  const steps = await stepsOf(seq.id);
  const qf = seq.quoteId
    ? await quoteFacts(seq.quoteId, { makeLink: false, assigned: { profileId: seq.assignedProfileId, name: seq.assignedName }, sentTo: seqSentTo(seq) })
    : null;
  if (qf && !qf.facts.link) qf.facts.link = "(the quote link goes in when it sends)";
  const ccp = qf ? await ccPlanFor(qf, s) : { send: [], leftOff: [] };
  const today = dateIn(seq.timeZone, now);
  const next = steps.find((x) => x.status === "scheduled" || x.status === "needs_review");
  const out = [];
  for (const st of steps) {
    const draft = qf && st.status !== "sent" ? draftFor(st, qf, today) : null;
    const message = st.messageId ? (await db.select().from(schema.messages).where(eq(schema.messages.id, st.messageId)))[0] : null;
    const expiresFirst = qf?.validUntilDate && st.status !== "sent" && st.dueDate >= qf.validUntilDate;
    out.push({
      id: st.id,
      step: st.step,
      purpose: purposeOf(seq.audience, st.step),
      dueDate: st.dueDate,
      dueAt: st.dueAt,
      dateAgreed: st.dateAgreed,
      status: st.status,
      reason: st.reason,
      error: st.error,
      sentAt: st.sentAt,
      to: st.toAddress,
      cc: st.ccAddress,
      subject: st.status === "sent" ? st.subject : (draft?.subject ?? null),
      text: st.status === "sent" ? st.body : (draft?.text ?? null),
      words: draft?.words ?? null,
      review: draft?.review ?? [],
      notes: draft?.notes ?? [],
      skip: draft?.skip ?? null,
      edited: st.edited,
      warnings: expiresFirst ? [`The quote expires on ${auDate(qf!.validUntilDate!)}, before this is due. It will stop instead of sending.`] : [],
      message: message ? { id: message.id, status: message.status, statusDetail: message.statusDetail, conversationId: message.conversationId, via: message.mailbox ? "gmail" : "relay" } : null,
      isNext: next?.id === st.id,
    });
  }
  /* What the timer would do with the next one, right now. */
  let nextCheck: string | null = null;
  if (next && qf && seq.status === "active") {
    const d = await checkStep(seq, next, qf, new Date(Math.max(now.getTime(), next.dueAt.getTime())), s);
    nextCheck = d.ok ? "Goes on the day if nothing changes." : `${d.action}: ${d.reason}`;
  }
  return {
    settings: s,
    sequence: {
      id: seq.id,
      quoteNumber: seq.quoteNumber,
      quoteId: seq.quoteId,
      status: seq.status,
      reason: seq.reason,
      pausedUntil: seq.pausedUntil,
      audience: seq.audience,
      anchorDate: seq.anchorDate,
      timeZone: seq.timeZone,
      assignedName: seq.assignedName,
      consentBasis: seq.consentBasis,
      enrolledHow: seq.enrolledHow,
      enrolledByName: seq.enrolledByName,
      nextCheck,
    },
    blockers: [] as string[],
    cautions: s.on ? [] : ["Follow-ups are off in Settings. Nothing goes until they are switched on."],
    startFrom: null,
    plan: [],
    steps: out,
    to: qf?.recipient?.email ?? seq.toAddress ?? null,
    cc: ccp.send.map((c) => c.email),
    ccLeftOff: ccp.leftOff,
    validUntil: qf?.validUntilDate ?? null,
  };
}

/** Follow-ups for every quote on a job, for the job page and its Conversation tab. Quotes out but not started show too. */
export async function followupsForJob(jobId: number, now: Date = new Date()) {
  const seqs = await db.select().from(schema.quoteFollowups).where(eq(schema.quoteFollowups.jobId, jobId));
  const quotes = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(desc(schema.quotes.version));
  const ids: number[] = [];
  for (const seq of seqs) if (seq.quoteId) ids.push(seq.quoteId);
  const numbers = new Set(seqs.map((x) => x.quoteNumber));
  for (const q of quotes) {
    if (numbers.has(q.number)) continue;
    const versions = quotes.filter((v) => v.number === q.number);
    if (versions.some((v) => v.status === "accepted" || v.status === "replaced")) continue;
    const sent = latestSent(versions);
    if (sent && sent.id === q.id) {
      ids.push(q.id);
      numbers.add(q.number);
    }
  }
  const out = [];
  for (const id of ids) {
    const v = await followupView(id, now);
    const [q] = await db.select({ number: schema.quotes.number, version: schema.quotes.version }).from(schema.quotes).where(eq(schema.quotes.id, id));
    if (v && q) out.push({ quoteId: id, ref: quoteRefOf(q), ...v });
  }
  return out;
}
