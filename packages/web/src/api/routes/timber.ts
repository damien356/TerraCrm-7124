import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly, withUser } from "../middleware/auth";
import {
  PHOTO_PRICE_SENTENCE,
  REPAIR_TYPES,
  TIMBER_AUTOSEND_KEY,
  TIMBER_MARKUP_KEY,
  TIMBER_MIN_KEY,
  TIMBER_TEMPLATE_DEFAULTS,
  TIMBER_TEMPLATE_KEY,
  floorTypeLabel,
  repairTypeLabel,
  timberClientPrice,
  type RepairType,
} from "../lib/lead-codes";
import { signGet } from "../lib/s3";
import { GST_RATE } from "../lib/gst";
import { jobText } from "../lib/refs";
import { quoteRefOf } from "../lib/quote-number";
import { approveRepairQuote, areaText, hashRepairToken, marcText, priceRepair, repairPricer, resendRepairText, timberSettings, timberSkillId } from "../lib/timber-repair";
import { bad } from "../lib/variations";

/* ---------------------------------------------------------------------------
 * Timber repairs priced by Marc (spec 14 Oct, Part B, notes 18.38).
 *
 *   timber.settings / saveSettings   Settings, Leads: markup, minimum, auto send, the 3 templates. Admin.
 *   timber.list / get                The repair screen at /repairs/:id. Staff.
 *   timber.approve                   One tap: the quote goes to the client with accept, sign and pay.
 *   timber.resend / setPrice         Text Marc again, or type his price in when he rang.
 *   timber.report                    Leads, quotes, wins and prices per repair type. Admin.
 *   timber.photos                    /r/<token>: Marc's no-login photo page.
 *
 * The photo page never returns a client name, phone, email or street
 * address, and never a price.
 * ------------------------------------------------------------------------- */

const repairTypeEnum = z.enum(REPAIR_TYPES.map(([k]) => k) as [RepairType, ...RepairType[]]);
const STATUS_LABELS: Record<string, string> = {
  new: "New",
  asked: "Waiting on Marc",
  not_sent: "Text not sent",
  see: "Marc needs to see it",
  priced: "Priced",
  quoted: "Quote waiting for approval",
  sent: "Quote sent to client",
  accepted: "Client accepted",
  offered: "Offered to Marc",
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;
const WON = new Set(["accepted", "offered"]);
const QUOTED = new Set(["quoted", "sent", "accepted", "offered"]);
const cents = (n: number) => Math.round(n * 100) / 100;

const notFound = () => new ORPCError("NOT_FOUND", { message: "This link is not valid. Ask Terra to text it again." });

async function putSetting(key: string, value: string) {
  const now = new Date();
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: now } });
}

/** Photos on the repair's job, signed for an hour. */
async function damagePhotos(jobId: number) {
  const rows = await db
    .select({ id: schema.jobMedia.id, storageKey: schema.jobMedia.storageKey, caption: schema.jobMedia.caption, tags: schema.jobMedia.tags, mime: schema.jobMedia.mime })
    .from(schema.jobMedia)
    .where(and(eq(schema.jobMedia.jobId, jobId), eq(schema.jobMedia.bucket, "damage"), eq(schema.jobMedia.kind, "photo"), isNull(schema.jobMedia.archivedAt)))
    .orderBy(asc(schema.jobMedia.id));
  return Promise.all(
    rows.map(async (r) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags || "[]") as string[];
      } catch {
        /* no tags */
      }
      return { id: r.id, url: await signGet(r.storageKey), tags };
    }),
  );
}

export const timber = {
  /* --------------------------------- settings --------------------------------- */

  settings: adminOnly.handler(async () => {
    const s = await timberSettings();
    const pricer = await repairPricer();
    const skillId = await timberSkillId();
    const all = await db.select({ smsCost: schema.repairRequests.smsCost, smsCount: schema.repairRequests.smsCount }).from(schema.repairRequests);
    const cost = all.reduce((a, r) => a + (r.smsCost || 0), 0);
    const texts = all.reduce((a, r) => a + (r.smsCount || 0), 0);
    return {
      markup: s.markup,
      minCharge: s.minCharge,
      templates: REPAIR_TYPES.map(([key, label]) => ({ key, label, text: s.templates[key], defaultText: TIMBER_TEMPLATE_DEFAULTS[key] })),
      photoSentence: PHOTO_PRICE_SENTENCE,
      pricer: pricer ? { id: pricer.id, name: pricer.name, mobile: pricer.mobile } : null,
      skillId,
      sms: { leads: all.length, texts, cost: cents(cost), perLead: all.length ? cents(cost / all.length) : 0 },
      sample: marcText({ repairType: "water_damage", area: "2", floorType: "engineered", suburb: "Mudgeeraba" }, "https://ops.terraflooring.com.au/r/..."),
    };
  }),

  saveSettings: adminOnly
    .input(
      z.object({
        markup: z.number().min(1, "The markup is at least 1").max(10),
        minCharge: z.number().min(0).max(100_000),
        templates: z.array(z.object({ key: repairTypeEnum, text: z.string().trim().min(1, "A template cannot be empty").max(4000) })).max(3),
      }),
    )
    .handler(async ({ input }) => {
      await putSetting(TIMBER_MARKUP_KEY, String(input.markup));
      await putSetting(TIMBER_MIN_KEY, String(input.minCharge));
      // Notes 18.54: timber repair quotes never auto send. The old ceiling is kept at 0 (off).
      await putSetting(TIMBER_AUTOSEND_KEY, "0");
      for (const t of input.templates) await putSetting(TIMBER_TEMPLATE_KEY(t.key), t.text);
      return { ok: true };
    }),

  /** What a price from Marc turns into, for the settings preview and the repair screen. */
  preview: staffOnly.input(z.object({ marcPrice: z.number().min(0).max(100_000) })).handler(async ({ input, context }) => {
    if (!context.actor.canSeeCosts) throw bad("Only someone who can see costs can check this.");
    const s = await timberSettings();
    return timberClientPrice(input.marcPrice, s.markup, s.minCharge, GST_RATE);
  }),

  /* ------------------------------- the repairs ------------------------------- */

  list: staffOnly.input(z.object({ open: z.boolean().default(false) }).default({ open: false })).handler(async ({ input, context }) => {
    const rows = await db
      .select({ r: schema.repairRequests, jobNumber: schema.jobs.number, displayNumber: schema.jobs.displayNumber, jobTitle: schema.jobs.title })
      .from(schema.repairRequests)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.repairRequests.jobId))
      .where(input.open ? inArray(schema.repairRequests.status, ["new", "asked", "not_sent", "see", "priced", "quoted"]) : undefined)
      .orderBy(desc(schema.repairRequests.createdAt), desc(schema.repairRequests.id))
      .limit(200);
    const costs = context.actor.canSeeCosts;
    return rows.map(({ r, jobNumber, displayNumber, jobTitle }) => ({
      id: r.id,
      jobId: r.jobId,
      jobNumber: displayNumber || String(jobNumber),
      jobTitle,
      repairType: repairTypeLabel(r.repairType) || "Not picked",
      suburb: r.suburb,
      status: r.status,
      statusLabel: statusLabel(r.status),
      marcPrice: costs ? r.marcPrice : null,
      clientPrice: r.clientPrice,
      createdAt: r.createdAt,
    }));
  }),

  get: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input, context }) => {
    const [r] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.id, input.id));
    if (!r) throw bad("That repair is not there any more.");
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, r.jobId));
    const [contact] = job?.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, job.contactId)) : [];
    const [installer] = r.installerId ? await db.select({ id: schema.installers.id, name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, r.installerId)) : [];
    const [quote] = r.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, r.quoteId)) : [];
    const [bundle] = quote
      ? await db.select({ wording: schema.quoteBundles.wording, title: schema.quoteBundles.title }).from(schema.quoteBundles).where(eq(schema.quoteBundles.quoteId, quote.id)).limit(1)
      : [];
    const costs = context.actor.canSeeCosts;
    return {
      id: r.id,
      status: r.status,
      statusLabel: statusLabel(r.status),
      repairType: r.repairType,
      repairTypeLabel: repairTypeLabel(r.repairType) || "Not picked",
      area: areaText(r.area),
      floorType: r.floorType ? floorTypeLabel(r.floorType) : "Not known",
      suburb: r.suburb,
      job: job ? { id: job.id, ref: jobText(job), title: job.title } : null,
      client: contact ? { name: `${contact.firstName} ${contact.lastName}`.trim(), email: contact.email, mobile: contact.mobile } : null,
      installer: installer ?? null,
      marcPrice: costs ? r.marcPrice : null,
      marcNote: r.marcNote,
      lastReply: r.lastReply,
      clientPrice: r.clientPrice,
      askedAt: r.askedAt,
      repliedAt: r.repliedAt,
      nudgedAt: r.nudgedAt,
      expiresAt: r.expiresAt,
      smsCost: costs ? r.smsCost : null,
      smsCount: r.smsCount,
      quote: quote
        ? { id: quote.id, ref: await quoteRefOf(quote), status: quote.status, total: quote.total, sentAt: quote.sentAt, acceptedAt: quote.acceptedAt, wording: bundle?.wording ?? "", title: bundle?.title ?? "" }
        : null,
      photos: job ? await damagePhotos(job.id) : [],
      taskId: r.taskId,
    };
  }),

  /** Approve: email the quote with the online accept, sign and Pay by card. */
  approve: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input, context }) => approveRepairQuote(input.id, context.actor)),

  /** Text Marc again with a fresh 14 day link. */
  resend: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input }) => {
    const out = await resendRepairText(input.id);
    if (!out.ok) throw bad(out.reason);
    return out;
  }),

  /** Marc rang or texted somewhere else: type his price in. Makes or updates the draft quote. */
  setPrice: staffOnly
    .input(z.object({ id: z.number().int(), marcPrice: z.number().positive("Type Marc's price ex GST").max(100_000), note: z.string().trim().max(500).default("") }))
    .handler(async ({ input, context }) => {
      if (!context.actor.canSeeCosts) throw bad("Only someone who can see costs can enter Marc's price.");
      const [r] = await db.select({ status: schema.repairRequests.status }).from(schema.repairRequests).where(eq(schema.repairRequests.id, input.id));
      if (!r) throw bad("That repair is not there any more.");
      if (["sent", "accepted", "offered"].includes(r.status)) throw bad("The quote has gone to the client. Change it on the quote itself.");
      return priceRepair(input.id, input.marcPrice, input.note, context.actor);
    }),

  /** Timber repair leads, quotes, wins and prices per repair type. */
  report: adminOnly.handler(async () => {
    const rows = await db.select().from(schema.repairRequests);
    const types = [...REPAIR_TYPES.map(([k]) => k as string), ""];
    const out = types.map((t) => {
      const mine = rows.filter((r) => (r.repairType || "") === t);
      const quoted = mine.filter((r) => QUOTED.has(r.status));
      const won = mine.filter((r) => WON.has(r.status));
      const priced = mine.filter((r) => r.marcPrice != null && r.clientPrice != null);
      const sum = (xs: typeof mine, f: (r: (typeof mine)[number]) => number) => cents(xs.reduce((a, r) => a + f(r), 0));
      return {
        repairType: t,
        label: t ? repairTypeLabel(t) : "Not picked",
        leads: mine.length,
        quotes: quoted.length,
        won: won.length,
        winRate: quoted.length ? Math.round((won.length / quoted.length) * 100) : 0,
        marcTotal: sum(priced, (r) => r.marcPrice ?? 0),
        clientTotal: sum(priced, (r) => r.clientPrice ?? 0),
        avgMarc: priced.length ? cents(sum(priced, (r) => r.marcPrice ?? 0) / priced.length) : null,
        avgClient: priced.length ? cents(sum(priced, (r) => r.clientPrice ?? 0) / priced.length) : null,
        wonClient: sum(won, (r) => r.clientPrice ?? 0),
        smsCost: sum(mine, (r) => r.smsCost || 0),
      };
    });
    return out.filter((r) => r.repairType || r.leads);
  }),

  /* ------------------------------ /r/<token> ------------------------------ */

  /** Marc's photo page. No login. Repair type, area, floor type, suburb and the photos. Nothing else. */
  photos: withUser.input(z.object({ token: z.string().min(20).max(80) })).handler(async ({ input }) => {
    const [r] = await db.select().from(schema.repairRequests).where(eq(schema.repairRequests.tokenHash, hashRepairToken(input.token)));
    if (!r) throw notFound();
    if (r.expiresAt.getTime() < Date.now()) return { expired: true as const };
    return {
      expired: false as const,
      repairType: r.repairType ? repairTypeLabel(r.repairType) : "Repair type not picked",
      area: areaText(r.area),
      floorType: r.floorType && r.floorType !== "not_sure" ? floorTypeLabel(r.floorType) : "Not known",
      suburb: r.suburb,
      expiresAt: r.expiresAt,
      photos: (await damagePhotos(r.jobId)).map((p) => ({ id: p.id, url: p.url })),
    };
  }),
};

