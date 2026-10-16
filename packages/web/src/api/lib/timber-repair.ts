import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { syncJobValue } from "./job-value";
import { assertReadyToGoOut, createQuoteRecord, editableQuoteOrThrow, recalc, recordPriceHistory } from "../routes/quotes";
import { assertBillable } from "./callbacks";
import { leadToQuotedOnSend } from "./job-stage";
import { quoteRefOf } from "./quote-number";
import { quoteEmailDraft, sendQuoteEmail } from "./quote-email";
import { SCOPE_FILL } from "./quote-email-template";
import { bad } from "./variations";
import { saveBundle } from "../routes/quoteBundles";
import { sendDirectOffer } from "../routes/offers";
import { ALL, lineSignature } from "./bundles";
import { ensureForJob, logMessage } from "./conversations";
import { GST_RATE } from "./gst";
import {
  PHOTO_PRICE_SENTENCE,
  TIMBER_LINK_DAYS,
  TIMBER_MARKUP_DEFAULT,
  TIMBER_MARKUP_KEY,
  TIMBER_MIN_KEY,
  TIMBER_NUDGE_HOURS,
  TIMBER_SKILL,
  TIMBER_TEMPLATE_DEFAULTS,
  TIMBER_TEMPLATE_KEY,
  floorTypeLabel,
  readMarcReply,
  repairTypeLabel,
  timberClientPrice,
  type RepairType,
} from "./lead-codes";
import { notifyOffice, OPS_URL } from "./notify";
import { isLiveServer } from "./runtime";
import { normaliseMobile, sendSms } from "./sms";
import { jobText } from "./refs";

/* ---------------------------------------------------------------------------
 * TIMBER REPAIRS PRICED BY MARC (spec 14 Oct, Part B, notes 18.38).
 *
 *   1. A timber repair lead texts Marc from the two-way number, with a
 *      no-login link to the photos (repair type, area, floor and suburb only).
 *   2. His reply is read with rules: a number is his price ex GST, anything
 *      after it is his note. SEE makes an inspection task. Anything else
 *      pushes the office and asks him again.
 *   3. A price makes a draft quote: his price x the markup, never under the
 *      minimum, plus GST, to the dollar. The wording comes from the template
 *      for the repair type. It waits for Damien to approve it.
 *   4. The client accepts: the dispatch is set to Timber repair, Marc's price
 *      as the pay, and offered straight to him.
 *
 * This is the one text that ever goes to an installer, on purpose. Marc never
 * sees the client price, the markup or the margin: none of it is in his texts,
 * on the photo page or in the offer.
 * ------------------------------------------------------------------------- */

type RepairRow = typeof schema.repairRequests.$inferSelect;

export const hashRepairToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const repairLink = (token: string) => `${OPS_URL}/r/${token}`;

const SYSTEM: Actor = {
  userId: "",
  name: "Terra Ops (timber repair)",
  email: "",
  role: "admin",
  installerId: null,
  canSeeCosts: true,
};

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const moneyPrice = (n: number) => (Number.isInteger(n) ? money0(n) : `$${n.toFixed(2)}`);

const num = (v: string | null, fallback: number) => {
  const n = Number(String(v ?? "").trim());
  return v != null && String(v).trim() !== "" && Number.isFinite(n) ? n : fallback;
};

/** Markup, minimum charge (ex GST) and the three templates. Nothing auto sends to a client (notes 18.54). */
export async function timberSettings() {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(
      inArray(schema.settings.key, [
        TIMBER_MARKUP_KEY,
        TIMBER_MIN_KEY,
        ...Object.keys(TIMBER_TEMPLATE_DEFAULTS).map(TIMBER_TEMPLATE_KEY),
      ]),
    );
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? null;
  const markup = num(get(TIMBER_MARKUP_KEY), TIMBER_MARKUP_DEFAULT);
  const templates = Object.fromEntries(
    (Object.keys(TIMBER_TEMPLATE_DEFAULTS) as RepairType[]).map((t) => [t, get(TIMBER_TEMPLATE_KEY(t)) ?? TIMBER_TEMPLATE_DEFAULTS[t]]),
  ) as Record<RepairType, string>;
  return {
    markup: markup > 0 ? markup : TIMBER_MARKUP_DEFAULT,
    minCharge: Math.max(0, num(get(TIMBER_MIN_KEY), 0)),
    templates,
  };
}

/** The active Timber repair skill, if Settings still has it. */
export async function timberSkillId() {
  const [s] = await db
    .select({ id: schema.skills.id })
    .from(schema.skills)
    .where(and(eq(schema.skills.active, true), sql`lower(trim(${schema.skills.name})) = ${TIMBER_SKILL.toLowerCase()}`))
    .limit(1);
  return s?.id ?? null;
}

/** Who prices timber repairs: the first active installer ticked for Timber repair with a mobile. */
export async function repairPricer() {
  const skillId = await timberSkillId();
  if (!skillId) return null;
  const rows = await db
    .select({ installer: schema.installers })
    .from(schema.installerSkills)
    .innerJoin(schema.installers, eq(schema.installers.id, schema.installerSkills.installerId))
    .where(and(eq(schema.installerSkills.skillId, skillId), eq(schema.installers.active, true), isNull(schema.installers.archivedAt)))
    .orderBy(schema.installers.id);
  return rows.map((r) => r.installer).find((i) => normaliseMobile(i.mobile ?? "")) ?? null;
}

/** "approx 2 m2". Plain m2, not the squared sign, which would make the text twice the price. */
export function areaText(raw: string) {
  const v = String(raw ?? "").trim().replace(/m²/gi, "m2").replace(/\s+/g, " ");
  if (!v) return "size not given";
  const bare = /^(\d+(?:\.\d+)?)\s*(m2|sqm|square metres?|square meters?)?$/i.exec(v);
  if (bare) return `approx ${bare[1]} m2`;
  return /^(approx|about|around|roughly)\b/i.test(v) ? v.slice(0, 40) : `approx ${v.slice(0, 40)}`;
}

/** What Marc reads. No client name, phone or address. */
export function marcText(r: { repairType: string; area: string; floorType: string; suburb: string }, link: string) {
  const what = r.repairType ? repairTypeLabel(r.repairType) : "Repair type not picked";
  const floor = r.floorType && r.floorType !== "not_sure" ? floorTypeLabel(r.floorType).toLowerCase() : "floor type not known";
  const parts = [what, areaText(r.area), floor, r.suburb.trim()].filter(Boolean).join(", ");
  return `Terra timber repair: ${parts}. Photos: ${link}. Reply with your price ex GST (e.g. 350), or SEE if you need to look first.`;
}

async function textMarc(req: RepairRow, installer: typeof schema.installers.$inferSelect, body: string) {
  const out = await sendSms({ to: installer.mobile ?? "", body, sender: "number", needsReply: true });
  const conv = await ensureForJob(req.jobId);
  await logMessage({
    conversationId: conv.id,
    jobId: req.jobId,
    installerId: installer.id,
    channel: "sms",
    audience: "installer",
    direction: "out",
    body,
    authorName: SYSTEM.name,
    toAddress: normaliseMobile(installer.mobile ?? "") ?? installer.mobile ?? null,
    providerId: out.ok ? out.providerId : null,
    status: out.ok ? "sent" : "failed",
    statusDetail: out.ok ? null : out.reason,
    failedAt: out.ok ? null : new Date(),
  });
  if (out.ok) {
    await db
      .update(schema.repairRequests)
      .set({
        smsCost: sql`${schema.repairRequests.smsCost} + ${out.price || 0}`,
        smsCount: sql`${schema.repairRequests.smsCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.repairRequests.id, req.id));
  }
  return out;
}

/**
 * A new timber repair lead: keep the request and text Marc. Never throws, so a
 * text that fails never loses the lead. Returns the request id.
 */
export async function startRepairRequest(args: {
  jobId: number;
  repairType: string;
  area: string;
  floorType: string;
  floorTypeRaw?: string;
  suburb: string;
  now?: Date;
}): Promise<number | null> {
  const now = args.now ?? new Date();
  const token = randomBytes(24).toString("base64url");
  try {
    const installer = await repairPricer();
    const [req] = await db
      .insert(schema.repairRequests)
      .values({
        jobId: args.jobId,
        installerId: installer?.id ?? null,
        repairType: args.repairType,
        area: String(args.area ?? "").slice(0, 80),
        floorType: args.floorType,
        suburb: String(args.suburb ?? "").slice(0, 80),
        tokenHash: hashRepairToken(token),
        expiresAt: new Date(now.getTime() + TIMBER_LINK_DAYS * 86_400_000),
        status: "new",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!req) return null;

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
    const ref = job ? jobText(job) : String(args.jobId);
    if (!installer) {
      await db.update(schema.repairRequests).set({ status: "not_sent", lastReply: "No one has the Timber repair skill with a mobile", updatedAt: new Date() }).where(eq(schema.repairRequests.id, req.id));
      await notifyOffice("repair_no_reply", {
        title: `Timber repair ${ref}: nobody to price it`,
        body: "No active installer has the Timber repair skill and a mobile, so the price text was not sent. Tick the skill on Marc's card, then press Text Marc again on the repair.",
        jobId: args.jobId,
        path: `/repairs/${req.id}`,
      });
      return req.id;
    }

    const out = await textMarc(req, installer, marcText(req, repairLink(token)));
    await db
      .update(schema.repairRequests)
      .set(
        out.ok
          ? { status: "asked", smsOutId: out.providerId, askedAt: new Date(), updatedAt: new Date() }
          : { status: "not_sent", lastReply: `Text not sent: ${out.reason}`.slice(0, 300), updatedAt: new Date() },
      )
      .where(eq(schema.repairRequests.id, req.id));
    if (!out.ok) {
      await notifyOffice("repair_no_reply", {
        title: `Timber repair ${ref}: the text to ${installer.name} did not go`,
        body: `${out.reason}. Press Text Marc again on the repair once it is sorted.`,
        jobId: args.jobId,
        path: `/repairs/${req.id}`,
      });
    }
    await db.insert(schema.activityLog).values({
      jobId: args.jobId,
      entityType: "job",
      entityId: args.jobId,
      action: out.ok ? "repair_asked" : "repair_not_sent",
      detail: out.ok ? `Timber repair photos texted to ${installer.name} for a price` : `Price text to ${installer.name} not sent: ${out.reason}`,
      actorName: SYSTEM.name,
      actorRole: "system",
    });
    return req.id;
  } catch (e) {
    console.error("[timber-repair] start failed", (e as Error).message);
    return null;
  }
}

/** Send the price text again with a fresh link, from the repair screen. */
export async function resendRepairText(id: number) {
  const [req] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.id, id));
  if (!req) return { ok: false as const, reason: "Repair not found" };
  const installer = await repairPricer();
  if (!installer) return { ok: false as const, reason: "No active installer has the Timber repair skill and a mobile." };
  const token = randomBytes(24).toString("base64url");
  const now = new Date();
  await db
    .update(schema.repairRequests)
    .set({ tokenHash: hashRepairToken(token), expiresAt: new Date(now.getTime() + TIMBER_LINK_DAYS * 86_400_000), installerId: installer.id, updatedAt: now })
    .where(eq(schema.repairRequests.id, id));
  const out = await textMarc(req, installer, marcText(req, repairLink(token)));
  if (!out.ok) return { ok: false as const, reason: out.reason };
  const keep = ["priced", "quoted", "sent", "accepted", "offered"].includes(req.status);
  await db
    .update(schema.repairRequests)
    .set({ status: keep ? req.status : "asked", smsOutId: out.providerId, askedAt: now, nudgedAt: null, updatedAt: now })
    .where(eq(schema.repairRequests.id, id));
  return { ok: true as const };
}

/* ------------------------------ Marc replies ------------------------------ */

/** Requests still waiting on Marc, or with a draft quote he may want to change. */
const OPEN_FOR_REPLY = ["asked", "see", "quoted"];

/**
 * The request a text from Marc answers. A reply to the price text itself is
 * always his answer. A text matched only on his mobile counts when a request
 * is waiting on him, or when it is a new price for one he already priced: he
 * also texts the number about booked jobs, and those must go the normal way.
 */
async function requestForReply(mobile: string, originalMessageId: string | null) {
  if (originalMessageId) {
    const [r] = await db
      .select()
      .from(schema.repairRequests)
      .where(and(eq(schema.repairRequests.smsOutId, originalMessageId), inArray(schema.repairRequests.status, OPEN_FOR_REPLY)))
      .limit(1);
    if (r) return { req: r, direct: true };
  }
  const crew = await db
    .select({ id: schema.installers.id, mobile: schema.installers.mobile })
    .from(schema.installers)
    .where(sql`${schema.installers.mobile} is not null and ${schema.installers.mobile} != ''`);
  const ids = crew.filter((c) => normaliseMobile(c.mobile ?? "") === mobile).map((c) => c.id);
  if (!ids.length) return null;
  const [r] = await db
    .select()
    .from(schema.repairRequests)
    .where(and(inArray(schema.repairRequests.installerId, ids), inArray(schema.repairRequests.status, OPEN_FOR_REPLY)))
    // Still waiting on a price comes first, newest ask first.
    .orderBy(
      sql`case when ${schema.repairRequests.status} in ('asked', 'see') then 0 else 1 end`,
      desc(schema.repairRequests.askedAt),
      desc(schema.repairRequests.id),
    )
    .limit(1);
  return r ? { req: r, direct: false } : null;
}

/**
 * A text in from Marc. Called by lib/sms-inbound.ts before the normal routing.
 * Returns null when it is not a timber repair reply, so the text goes the
 * usual way.
 */
export async function handleMarcReply(args: { mobile: string; body: string; messageId: string | null; originalMessageId: string | null }) {
  const found = await requestForReply(args.mobile, args.originalMessageId);
  if (!found) return null;
  const { req } = found;
  const reply = readMarcReply(args.body);
  // Matched on his mobile only: past the waiting stage, only a new price is about the repair.
  if (!found.direct && req.status !== "asked" && reply.kind !== "price") return null;
  const installer = req.installerId ? (await db.select().from(schema.installers).where(eq(schema.installers.id, req.installerId)))[0] : undefined;
  if (!installer) return null;
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, req.jobId));
  const ref = job ? jobText(job) : String(req.jobId);
  const now = new Date();

  const conv = await ensureForJob(req.jobId);
  await logMessage({
    conversationId: conv.id,
    jobId: req.jobId,
    installerId: installer.id,
    channel: "sms",
    audience: "installer",
    direction: "in",
    body: args.body,
    authorName: installer.name,
    fromAddress: args.mobile,
    providerId: args.messageId,
  });
  await db
    .update(schema.repairRequests)
    .set({ lastReply: args.body.slice(0, 500), repliedAt: now, updatedAt: now })
    .where(eq(schema.repairRequests.id, req.id));

  const first = installer.name.split(" ")[0] || installer.name;

  if (reply.kind === "price") {
    const priced = await priceRepair(req.id, reply.price, reply.note, SYSTEM);
    await textMarc(req, installer, `Got it, ${moneyPrice(reply.price)}. Thanks ${first}.`);
    return { handled: true as const, kind: "price" as const, repairId: req.id, ...priced };
  }

  if (reply.kind === "see") {
    if (req.status !== "see") {
      await db.update(schema.repairRequests).set({ status: "see", updatedAt: now }).where(eq(schema.repairRequests.id, req.id));
      const [task] = await db
        .insert(schema.officeTasks)
        .values({
          jobId: req.jobId,
          title: `Inspect timber repair, job ${ref}`.slice(0, 300),
          detail: [
            `${installer.name} needs to see the floor before pricing it.`,
            [req.repairType ? repairTypeLabel(req.repairType) : "", areaText(req.area), req.suburb].filter(Boolean).join(", "),
            "Book a look with the client, then ask him to text his price.",
          ].join("\n"),
          createdByName: SYSTEM.name,
        })
        .returning({ id: schema.officeTasks.id });
      await db.insert(schema.activityLog).values({
        jobId: req.jobId,
        entityType: "job",
        entityId: req.jobId,
        action: "repair_see",
        detail: `${installer.name} replied SEE. Inspection task made${task ? ` (#${task.id})` : ""}`,
        actorName: installer.name,
        actorRole: "installer",
      });
    }
    return { handled: true as const, kind: "see" as const, repairId: req.id };
  }

  await notifyOffice("repair_bad_reply", {
    title: `Timber repair ${ref}: ${first}'s reply not understood`,
    body: `${installer.name} texted: "${args.body.slice(0, 200)}". He has been asked to reply with just a price or SEE.`,
    jobId: req.jobId,
    path: `/repairs/${req.id}`,
  });
  await textMarc(req, installer, "Sorry, reply with just a price (e.g. 350) or SEE.");
  return { handled: true as const, kind: "other" as const, repairId: req.id };
}

/* -------------------------------- the quote ------------------------------- */

const titleFor = (repairType: string) => `Timber floor repair: ${repairType ? repairTypeLabel(repairType) : "repair"}`;
const lineFor = (repairType: string) => `${repairType ? repairTypeLabel(repairType) : "Timber floor"} repair`;

/** The wording the client reads: the template for the repair type, always with the photo sentence. */
export function repairWording(template: string) {
  const t = template.trim();
  return t.includes(PHOTO_PRICE_SENTENCE) ? t : [t, PHOTO_PRICE_SENTENCE].filter(Boolean).join("\n");
}

/**
 * Marc's price is in: make (or update) the draft quote and tell Damien. The
 * quote waits for approval unless the auto send setting is on and it is
 * under the amount.
 */
export async function priceRepair(id: number, marcPrice: number, note: string, actor: Actor) {
  const [req] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.id, id));
  if (!req) throw new Error("Repair not found");
  const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, req.jobId));
  if (!job) throw new Error("Job not found");
  const s = await timberSettings();
  const { total, unitEx } = timberClientPrice(marcPrice, s.markup, s.minCharge, GST_RATE);
  const repairType = (req.repairType || "") as RepairType | "";
  const wording = repairWording(repairType ? s.templates[repairType] : "Timber floor repair as shown in your photos.");
  const line = { kind: "labour", description: lineFor(repairType), qty: 1, unit: "job", unitPrice: unitEx };

  let quoteId = req.quoteId;
  const [existing] = quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId)) : [];
  if (existing && (existing.status === "draft" || existing.status === "needs_review")) {
    // Marc changed his mind before the quote went out: the one line follows him.
    await db.delete(schema.quoteItems).where(eq(schema.quoteItems.quoteId, existing.id));
    await db.insert(schema.quoteItems).values({
      quoteId: existing.id,
      kind: line.kind,
      lineType: "labour",
      description: line.description,
      qty: 1,
      unit: line.unit,
      unitPrice: unitEx,
      total: unitEx,
      sortOrder: 0,
    });
    await recalc(existing.id);
  } else {
    const made = await createQuoteRecord(
      {
        jobId: job.id,
        contactId: job.contactId ?? null,
        companyId: job.companyId ?? null,
        supervisorContactId: null,
        siteId: job.siteId ?? null,
        people: [],
        makeJob: false,
        validDays: 30,
        notes: null,
        items: [{ ...line, productId: null, unitCost: null, flagged: false, flagReason: null }],
      },
      actor,
    );
    quoteId = made.id;
  }
  await saveBundle(quoteId!, ALL, {
    title: titleFor(repairType),
    wording,
    wordingSource: "timber_template",
    lineSignature: lineSignature([{ kind: line.kind, productId: null, description: line.description }]),
  });

  const now = new Date();
  await db
    .update(schema.repairRequests)
    .set({ status: "quoted", marcPrice, marcNote: note.slice(0, 500), clientPrice: total, quoteId, updatedAt: now })
    .where(eq(schema.repairRequests.id, id));
  await db.insert(schema.activityLog).values({
    jobId: job.id,
    entityType: "job",
    entityId: job.id,
    action: "repair_priced",
    detail: `Timber repair priced at ${moneyPrice(marcPrice)} ex GST${note ? ` (${note.slice(0, 120)})` : ""}. Draft quote ${money0(total)} incl GST waits for approval`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  // Notes 18.54: nothing goes to a client on its own. The office always approves.
  await notifyOffice("repair_price_ready", {
    title: `Timber repair quote ready: ${money0(total)} incl GST`,
    body: `Job ${jobText(job)}. Marc's price ${moneyPrice(marcPrice)} ex GST${note ? `, "${note.slice(0, 80)}"` : ""}. Approve or Edit.`,
    jobId: job.id,
    path: `/repairs/${id}`,
    data: { kind: "repair", repairId: id, quoteId, jobId: job.id },
  });
  return { quoteId: quoteId!, clientPrice: total, unitEx, autoSent: false };
}

/**
 * Approve: email the quote the same way the Email quote dialog does, with the
 * online accept, sign and Pay by card link. The "[what the quote is for]" gap
 * in the email template is filled with the repair type.
 */
export async function approveRepairQuote(id: number, actor: Actor) {
  const [req] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.id, id));
  if (!req?.quoteId) throw bad("There is no quote on this repair yet. It is made when Marc texts his price.");
  const quote = await editableQuoteOrThrow(req.quoteId);
  if (quote.status === "sent") throw bad("This quote has already gone to the client.");
  await assertBillable(quote.jobId);
  await assertReadyToGoOut(quote, actor);
  const ref = await quoteRefOf(quote);
  const draft = await quoteEmailDraft(quote, ref);
  if (!draft.to) throw bad("The client has no email address. Add one on their card, or open the quote and send it another way.");
  const scope = `the ${lineFor(req.repairType).toLowerCase()} to your timber floor`;
  const fill = (t: string) => t.split(SCOPE_FILL).join(scope);
  await recordPriceHistory(quote, actor.name);
  const out = await sendQuoteEmail({ quote, to: draft.to, subject: fill(draft.subject), body: fill(draft.body), byName: actor.name });
  const now = new Date();
  await db.update(schema.quotes).set({ status: "sent", sentAt: quote.sentAt ?? now, updatedAt: now }).where(eq(schema.quotes.id, quote.id));
  if (quote.jobId) await syncJobValue(quote.jobId);
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action: "sent",
    detail: `Timber repair quote ${out.ref} approved and emailed to ${out.to}`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  await leadToQuotedOnSend({ jobId: quote.jobId, quoteNumber: out.ref, actor });
  await db.update(schema.repairRequests).set({ status: "sent", updatedAt: now }).where(eq(schema.repairRequests.id, id));
  return { to: out.to, url: out.url, ref: out.ref };
}

/* ------------------------------ the 2 hour push ------------------------------ */

/** Requests Marc has not answered in 2 hours get one push to the office. */
export async function nudgeUnanswered(now = new Date()) {
  const cutoff = new Date(now.getTime() - TIMBER_NUDGE_HOURS * 3600_000);
  const due = await db
    .select()
    .from(schema.repairRequests)
    .where(and(eq(schema.repairRequests.status, "asked"), isNull(schema.repairRequests.repliedAt), isNull(schema.repairRequests.nudgedAt), lte(schema.repairRequests.askedAt, cutoff)));
  for (const r of due) {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, r.jobId));
    await db.update(schema.repairRequests).set({ nudgedAt: now, updatedAt: now }).where(eq(schema.repairRequests.id, r.id));
    await notifyOffice("repair_no_reply", {
      title: `Timber repair ${job ? jobText(job) : r.jobId}: no price from Marc after ${TIMBER_NUDGE_HOURS} hours`,
      body: [r.repairType ? repairTypeLabel(r.repairType) : "", areaText(r.area), r.suburb].filter(Boolean).join(", "),
      jobId: r.jobId,
      path: `/repairs/${r.id}`,
    });
  }
  return due.map((r) => r.id);
}

let booted = false;
let running = false;
export function bootTimberRepair() {
  if (booted) return;
  booted = true;
  const mode = process.env.TIMBER_REPAIR;
  if (mode === "off") return void console.log("[timber-repair] timer disabled by TIMBER_REPAIR=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[timber-repair] timer idle, not the published server");
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await nudgeUnanswered();
    } catch (e) {
      console.error("[timber-repair] tick failed", e);
    } finally {
      running = false;
    }
  };
  console.log("[timber-repair] checking for unanswered price texts every 5 minutes");
  setInterval(() => void tick(), 5 * 60_000);
  setTimeout(() => void tick(), 20_000);
}

/* ---------------------------- the client accepts ---------------------------- */

/**
 * Called by lib/quote-accept.ts once the dispatch is made. The repair task is
 * set to Timber repair with Marc's price as the pay, and offered to him. He
 * accepts in Crew as normal, and only then sees the client and the address.
 */
export async function afterRepairAccepted(quoteId: number, jobId: number, actor: { name: string; role: string }) {
  const [req] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.quoteId, quoteId));
  if (!req) return null;
  const now = new Date();
  await db.update(schema.repairRequests).set({ status: "accepted", updatedAt: now }).where(eq(schema.repairRequests.id, req.id));
  const { quoteDispatchIds } = await import("./dispatch-build");
  const ids = [...(await quoteDispatchIds(jobId))];
  const tasks = ids.length
    ? await db.select().from(schema.jobTasks).where(and(eq(schema.jobTasks.jobId, jobId), inArray(schema.jobTasks.id, ids)))
    : [];
  const task = tasks.sort((a, b) => b.id - a.id)[0];
  if (!task) return { repairId: req.id, taskId: null, offered: false };
  const skillId = await timberSkillId();
  await db
    .update(schema.jobTasks)
    .set({ skillId: skillId ?? task.skillId, payType: "per_job", payAmount: req.marcPrice ?? task.payAmount, updatedAt: now })
    .where(eq(schema.jobTasks.id, task.id));
  await db.update(schema.repairRequests).set({ taskId: task.id }).where(eq(schema.repairRequests.id, req.id));
  if (!req.installerId) return { repairId: req.id, taskId: task.id, offered: false };
  try {
    await sendDirectOffer({ taskId: task.id, installerId: req.installerId, payAmount: req.marcPrice }, actor);
    await db.update(schema.repairRequests).set({ status: "offered", updatedAt: new Date() }).where(eq(schema.repairRequests.id, req.id));
    return { repairId: req.id, taskId: task.id, offered: true };
  } catch (e) {
    console.error("[timber-repair] offer to Marc failed", (e as Error).message);
    await notifyOffice("repair_no_reply", {
      title: `Timber repair job ${jobId}: accepted, but the offer to Marc did not go`,
      body: `${(e as Error).message}. Offer the task from the job page.`,
      jobId,
    });
    return { repairId: req.id, taskId: task.id, offered: false };
  }
}
