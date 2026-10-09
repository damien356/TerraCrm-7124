import { z } from "zod";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, installerOnly } from "../middleware/auth";
import { crewVoice, hashSecret, newConfirmToken, newVoiceKey } from "../middleware/voice";
import { ownTaskOrThrow } from "./field";
import { pushToOffice } from "../lib/push";
import { normaliseMobile, sendSms, SMS_OPT_OUT, type SmsOutcome } from "../lib/sms";
import { contactByMobile, ensureForJob, logMessage } from "../lib/conversations";
import { draftLateText, gsmSafe } from "../agent/late-text";
import {
  bookedStart,
  briefFor,
  currentOrNext,
  nextWorkDay,
  officePlace,
  sayPlace,
  sayWhen,
  textPlace,
  type Brief,
} from "../lib/crew-brief";
import { sayMinutes } from "../lib/local-date";

/* ---------------------------------------------------------------------------
 * HANDS-FREE CREW, for Siri and CarPlay.
 *
 * Read-only questions answer straight away. Anything that DOES something, a
 * text, a call, a note, goes through confirm-back, and that rule lives here on
 * the server rather than trusting the phone:
 *
 *   prepare  works out exactly what would happen and returns the words Siri
 *            reads back, plus a one-time code good for 2 minutes. It sends
 *            nothing and writes nothing but its own record.
 *   confirm  the code, once, by the same installer, inside 2 minutes. Only
 *            then does the text go or the note save.
 *   cancel   a "no", or silence. Recorded as such.
 *
 * Every reply carries `speech`: the exact sentence for Siri to say, so the
 * phone side stays dumb and the wording can change without an app build.
 * ------------------------------------------------------------------------- */

const CONFIRM_WINDOW_MS = 2 * 60_000;
const NAV_APPS = ["apple", "google", "waze"] as const;
type NavApp = (typeof NAV_APPS)[number];

const KINDS = ["late_client", "late_office", "call_contact", "call_office", "note"] as const;
type Kind = (typeof KINDS)[number];

/** Says no without throwing, so Siri can speak it rather than "something went wrong". */
const refuse = (speech: string) => ({ ok: false as const, speech });

async function setting(key: string) {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value ?? null;
}

const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";

function navUrl(app: NavApp, destination: string) {
  const q = encodeURIComponent(destination);
  if (app === "google") return `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
  if (app === "waze") return `https://waze.com/ul?q=${q}&navigate=yes`;
  return `https://maps.apple.com/?daddr=${q}&dirflg=d`;
}

/** Testing hook: on a scratch copy, texts are logged but never leave the building. */
async function sendVoiceSms(to: string, body: string): Promise<SmsOutcome> {
  if (String(process.env.VOICE_SMS_DRY_RUN ?? "").toLowerCase() === "true") {
    return { ok: true, providerId: `dry-run-${Date.now()}`, price: 0 };
  }
  return sendSms({ to, body, sender: "number", needsReply: true });
}

async function smsOptedOut(mobile: string) {
  const [row] = await db
    .select({ id: schema.unsubscribes.id })
    .from(schema.unsubscribes)
    .where(and(eq(schema.unsubscribes.mobile, mobile), inArray(schema.unsubscribes.channel, ["sms", "all"])))
    .limit(1);
  return Boolean(row);
}

async function navAppFor(installerId: number): Promise<NavApp> {
  const [row] = await db
    .select({ navApp: schema.installers.navApp })
    .from(schema.installers)
    .where(eq(schema.installers.id, installerId));
  return (NAV_APPS as readonly string[]).includes(row?.navApp ?? "") ? (row!.navApp as NavApp) : "apple";
}

/** Which task a command is about: the one named, else the one they're at, else the next. */
async function resolveTask(installerId: number, taskId: number | null | undefined, prefer: "next" | "current") {
  if (taskId) {
    await ownTaskOrThrow(taskId, installerId);
    const b = await briefFor(taskId);
    return b ? { brief: b, day: null } : null;
  }
  return prefer === "current" ? currentOrNext(installerId) : nextWorkDay(installerId);
}

function describeJobSheet(b: Brief) {
  const parts: string[] = [];
  parts.push(`${b.title}${b.skillName && !b.title.toLowerCase().includes(b.skillName.toLowerCase()) ? `, ${b.skillName}` : ""}.`);
  if (b.areaM2) parts.push(`About ${Math.round(b.areaM2)} square metres.`);
  if (b.description) {
    const d = b.description.replace(/\s+/g, " ").trim();
    parts.push(d.length > 420 ? `${d.slice(0, 400).replace(/\s\S*$/, "")}, and more on the job card.` : d);
  }
  if (b.furnitureOnSite) parts.push("There is furniture on site to move.");
  if (b.accessNotes.length) parts.push(`Access: ${b.accessNotes.join(". ")}`);
  return parts.join(" ");
}

export const voice = {
  /* ------------------------------ reading ------------------------------ */

  /** "Hey Siri, what's my next job in Terra." */
  nextJob: crewVoice.handler(async ({ context }) => {
    const next = await nextWorkDay(context.installerId);
    if (!next) {
      return {
        found: false as const,
        speech: "You've got nothing booked in the next two weeks.",
      };
    }
    const { day, brief } = next;
    const contact = brief.contact?.firstName ? ` The site contact is ${brief.contact.firstName}.` : "";
    const run = day.dayCount > 1 ? ` It's day ${day.daySeq} of ${day.dayCount}.` : "";
    const app = await navAppFor(context.installerId);
    return {
      found: true as const,
      taskId: brief.taskId,
      jobId: brief.jobId,
      date: day.date,
      bookedStart: bookedStart(day, brief)?.toISOString() ?? null,
      destination: brief.destination,
      navApp: app,
      navUrl: brief.destination ? navUrl(app, brief.destination) : null,
      speech: `Your next job is ${sayWhen(day, brief)}, ${sayPlace(brief)}.${contact}${run}`,
    };
  }),

  /** "Hey Siri, direct me to my next job in Terra." Same lookup, the phone opens the URL. */
  directions: crewVoice.handler(async ({ context }) => {
    const next = await nextWorkDay(context.installerId);
    if (!next) return { found: false as const, navUrl: null, speech: "You've got nothing booked in the next two weeks." };
    const app = await navAppFor(context.installerId);
    if (!next.brief.destination) {
      return {
        found: true as const,
        navUrl: null,
        speech: `Your next job is ${sayPlace(next.brief)}, but there's no address on it. Call the office.`,
      };
    }
    const appName = app === "google" ? "Google Maps" : app === "waze" ? "Waze" : "Apple Maps";
    return {
      found: true as const,
      taskId: next.brief.taskId,
      navUrl: navUrl(app, next.brief.destination),
      speech: `Opening ${appName} to ${sayPlace(next.brief)}.`,
    };
  }),

  /** "Hey Siri, what's on the job sheet in Terra." The job they are at, else the next one. */
  jobSheet: crewVoice
    .input(z.object({ taskId: z.number().nullable().optional() }).default({}))
    .handler(async ({ input, context }) => {
      const r = await resolveTask(context.installerId, input.taskId, "current");
      if (!r) return { found: false as const, speech: "You've got nothing booked in the next two weeks." };
      return { found: true as const, taskId: r.brief.taskId, speech: `${sayPlace(r.brief)}. ${describeJobSheet(r.brief)}` };
    }),

  /* --------------------------- confirm-back --------------------------- */

  /**
   * Step one of anything that acts. Returns what Siri reads back and a code.
   * Nothing is sent and nothing is saved, apart from the record of the ask.
   */
  prepare: crewVoice
    .input(
      z.object({
        kind: z.enum(KINDS),
        taskId: z.number().nullable().optional(),
        /** Said by them, or worked out on the phone from the Maps ETA. */
        minutesLate: z.number().int().min(1).max(600).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const kind: Kind = input.kind;
      const installerFirst = firstWord(context.installerName) || "Your installer";

      /* Old asks that nobody answered are expired, not left hanging. */
      await db
        .update(schema.voiceActions)
        .set({ status: "expired", answer: "silence", updatedAt: new Date() })
        .where(
          and(
            eq(schema.voiceActions.installerId, context.installerId),
            eq(schema.voiceActions.status, "pending"),
            lt(schema.voiceActions.expiresAt, new Date()),
          ),
        );

      let target: { brief: Brief } | null = null;
      if (kind !== "call_office") {
        target = await resolveTask(context.installerId, input.taskId, kind === "note" ? "current" : "next");
        if (!target) return refuse("You've got nothing booked in the next two weeks.");
      }
      const b = target?.brief ?? null;

      let readBack = "";
      let payload: Record<string, unknown> = {};

      if (kind === "late_client" || kind === "late_office") {
        if (!input.minutesLate) return { ok: false as const, needsMinutes: true, speech: "How late, roughly?" };
        const mins = input.minutesLate;
        if (kind === "late_client") {
          const c = b!.contact;
          const mobile = normaliseMobile(c?.mobile);
          if (!c || !mobile) {
            return refuse(`There's no mobile for the site contact on ${sayPlace(b!)}. You can tell the office instead.`);
          }
          if (await smsOptedOut(mobile)) {
            return refuse(`${c.firstName || "The site contact"} has opted out of texts. You can tell the office instead.`);
          }
          const draft = await draftLateText({ firstName: c.firstName, installerFirst, minutes: mins, place: textPlace(b!) });
          readBack = `I'll text ${c.firstName || c.name}: ${draft.body} Send it?`;
          payload = { to: mobile, contactName: c.name, body: draft.body, minutes: mins, drafted: draft.drafted };
        } else {
          const body = `Running about ${mins} minutes late to ${officePlace(b!)}.`;
          readBack = `I'll tell the office you're about ${sayMinutes(mins)} late to ${sayPlace(b!)}. Send it?`;
          payload = { body, minutes: mins };
        }
      } else if (kind === "call_contact") {
        // The site contact is only someone the office ticked Show to Crew on the job.
        const c = b!.contact;
        const number = c?.mobile || c?.phone;
        if (!c || !number) return refuse(`There's no number for the site contact on ${sayPlace(b!)}.`);
        readBack = `Calling ${c.firstName || c.name} about ${sayPlace(b!)}. OK?`;
        payload = { phone: number.replace(/[^\d+]/g, ""), contactName: c.name };
      } else if (kind === "call_office") {
        const number = (await setting("business_phone"))?.trim();
        if (!number) return refuse("There's no office number saved in Terra.");
        readBack = "Calling the Terra office. OK?";
        payload = { phone: number.replace(/[^\d+]/g, "") };
      } else {
        const note = gsmSafe(input.note ?? "");
        if (note.length < 2) return { ok: false as const, needsNote: true, speech: "What's the note?" };
        readBack = `I'll add this note to ${sayPlace(b!)}: ${note}. Save it?`;
        payload = { note };
      }

      const token = newConfirmToken();
      const expiresAt = new Date(Date.now() + CONFIRM_WINDOW_MS);
      await db.insert(schema.voiceActions).values({
        tokenHash: hashSecret(token),
        installerId: context.installerId,
        taskId: b?.taskId ?? null,
        jobId: b?.jobId ?? null,
        kind,
        readBack,
        payload: JSON.stringify(payload),
        expiresAt,
      });
      return { ok: true as const, token, readBack, speech: readBack, expiresAt: expiresAt.toISOString() };
    }),

  /** The "yes". One use, same installer, inside the window. */
  confirm: crewVoice.input(z.object({ token: z.string().min(10) })).handler(async ({ input, context }) => {
    const [action] = await db
      .select()
      .from(schema.voiceActions)
      .where(eq(schema.voiceActions.tokenHash, hashSecret(input.token)));
    /* Someone else's code reads the same as no code at all. */
    if (!action || action.installerId !== context.installerId) {
      throw new ORPCError("NOT_FOUND", { message: "That confirmation isn't valid." });
    }
    if (action.status !== "pending") {
      return refuse(action.status === "confirmed" ? "That's already done." : "That was cancelled, nothing was sent.");
    }
    if (action.expiresAt.getTime() < Date.now()) {
      await db
        .update(schema.voiceActions)
        .set({ status: "expired", answer: "silence", updatedAt: new Date() })
        .where(eq(schema.voiceActions.id, action.id));
      return refuse("That took too long, so nothing was sent. Ask me again.");
    }

    /* Claim it atomically, so a double tap or a retry cannot send twice. */
    const [claimed] = await db
      .update(schema.voiceActions)
      .set({ status: "confirmed", answer: "yes", answeredAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.voiceActions.id, action.id), eq(schema.voiceActions.status, "pending")))
      .returning({ id: schema.voiceActions.id });
    if (!claimed) return refuse("That's already done.");

    const p = JSON.parse(action.payload) as Record<string, any>;
    const who = context.installerName || "Installer";
    const finish = async (status: "confirmed" | "failed", detail: string) =>
      db
        .update(schema.voiceActions)
        .set({ status, resultDetail: detail, updatedAt: new Date() })
        .where(eq(schema.voiceActions.id, action.id));
    const brief = action.taskId ? await briefFor(action.taskId) : null;

    if (action.kind === "late_client") {
      const body = String(p.body) + SMS_OPT_OUT;
      const out = await sendVoiceSms(String(p.to), body);
      if (action.jobId) {
        const conv = await ensureForJob(action.jobId);
        const contact = await contactByMobile(String(p.to));
        await logMessage({
          conversationId: conv.id,
          jobId: action.jobId,
          contactId: contact?.id ?? null,
          installerId: context.installerId,
          channel: "sms",
          audience: "customer",
          direction: "out",
          body,
          authorName: `${who} (by Siri)`,
          toAddress: String(p.to),
          providerId: out.ok ? out.providerId : null,
          status: out.ok ? "sent" : "failed",
          statusDetail: out.ok ? null : out.reason,
          failedAt: out.ok ? null : new Date(),
        });
        await db.insert(schema.activityLog).values({
          jobId: action.jobId,
          taskId: action.taskId,
          entityType: "task",
          entityId: action.taskId,
          action: out.ok ? "voice_late_client" : "voice_late_client_failed",
          detail: out.ok
            ? `${who} texted ${p.contactName} they're running about ${p.minutes} min late`
            : `${who} tried to text ${p.contactName} they're running late, it failed: ${out.reason}`,
          actorName: who,
          actorRole: "installer",
        });
      }
      if (!out.ok) {
        await finish("failed", out.reason);
        return refuse("The text didn't go through. Do you want to call the office?");
      }
      await finish("confirmed", `sent ${out.providerId}`);
      void pushToOffice({
        title: "Running late",
        body: `${who} texted ${p.contactName}: about ${p.minutes} min late`,
        data: { kind: "job", jobId: action.jobId },
      });
      return { ok: true as const, speech: `Sent. ${String(p.contactName).split(" ")[0]}'s replies will go to the office.` };
    }

    if (action.kind === "late_office") {
      if (action.jobId) {
        const conv = await ensureForJob(action.jobId);
        await logMessage({
          conversationId: conv.id,
          jobId: action.jobId,
          installerId: context.installerId,
          channel: "app",
          audience: "installer",
          direction: "in",
          body: String(p.body),
          authorName: `${who} (by Siri)`,
        });
        await db.insert(schema.activityLog).values({
          jobId: action.jobId,
          taskId: action.taskId,
          entityType: "task",
          entityId: action.taskId,
          action: "voice_late_office",
          detail: `${who}: ${p.body}`,
          actorName: who,
          actorRole: "installer",
        });
      }
      await finish("confirmed", "logged");
      void pushToOffice({
        title: `${who} is running late`,
        body: String(p.body),
        data: { kind: "job", jobId: action.jobId },
      });
      return { ok: true as const, speech: "Done. The office knows." };
    }

    if (action.kind === "call_contact" || action.kind === "call_office") {
      await db.insert(schema.activityLog).values({
        jobId: action.jobId,
        taskId: action.taskId,
        entityType: action.taskId ? "task" : "installer",
        entityId: action.taskId ?? context.installerId,
        action: "voice_call",
        detail: action.kind === "call_office" ? `${who} called the office from Siri` : `${who} called ${p.contactName} from Siri`,
        actorName: who,
        actorRole: "installer",
      });
      await finish("confirmed", `dial ${p.phone}`);
      return { ok: true as const, dial: String(p.phone), speech: "Calling." };
    }

    /* note */
    if (action.jobId && action.taskId) {
      await db.insert(schema.activityLog).values({
        jobId: action.jobId,
        taskId: action.taskId,
        entityType: "task",
        entityId: action.taskId,
        action: "field_note",
        detail: `${p.note} (said to Siri)`,
        actorName: who,
        actorRole: "installer",
      });
      void pushToOffice({
        title: `Note from ${who}`,
        body: String(p.note).slice(0, 140),
        data: { kind: "job", jobId: action.jobId },
      });
    }
    await finish("confirmed", "saved");
    return { ok: true as const, speech: `Saved to ${brief ? sayPlace(brief) : "the job"}.` };
  }),

  /** The "no", or nothing said at all. */
  cancel: crewVoice
    .input(z.object({ token: z.string().min(10), answer: z.enum(["no", "silence"]).default("no") }))
    .handler(async ({ input, context }) => {
      const [row] = await db
        .update(schema.voiceActions)
        .set({ status: "cancelled", answer: input.answer, answeredAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.voiceActions.tokenHash, hashSecret(input.token)),
            eq(schema.voiceActions.installerId, context.installerId),
            eq(schema.voiceActions.status, "pending"),
          ),
        )
        .returning({ id: schema.voiceActions.id });
      return { ok: Boolean(row), speech: "OK, nothing sent." };
    }),

  /* --------------------------- phone settings -------------------------- */

  /** What the app shows on the Me tab, and what Siri needs to know. */
  settings: crewVoice.handler(async ({ context }) => {
    const keys = await db
      .select({
        id: schema.voiceKeys.id,
        deviceName: schema.voiceKeys.deviceName,
        lastUsedAt: schema.voiceKeys.lastUsedAt,
        createdAt: schema.voiceKeys.createdAt,
      })
      .from(schema.voiceKeys)
      .where(and(eq(schema.voiceKeys.installerId, context.installerId), isNull(schema.voiceKeys.revokedAt)))
      .orderBy(desc(schema.voiceKeys.createdAt));
    return { navApp: await navAppFor(context.installerId), officePhone: await setting("business_phone"), keys };
  }),

  setNavApp: crewVoice.input(z.object({ app: z.enum(NAV_APPS) })).handler(async ({ input, context }) => {
    await db
      .update(schema.installers)
      .set({ navApp: input.app, updatedAt: new Date() })
      .where(eq(schema.installers.id, context.installerId));
    return { navApp: input.app };
  }),

  /**
   * A Siri key for this phone. Needs the real app sign-in, never another key,
   * so a leaked key cannot mint more. One live key per phone name.
   */
  issueKey: installerOnly
    .input(z.object({ deviceName: z.string().max(120).default("") }))
    .handler(async ({ input, context }) => {
      const deviceName = input.deviceName.trim() || "iPhone";
      await db
        .update(schema.voiceKeys)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(schema.voiceKeys.userId, context.actor.userId),
            eq(schema.voiceKeys.deviceName, deviceName),
            isNull(schema.voiceKeys.revokedAt),
          ),
        );
      const key = newVoiceKey();
      await db.insert(schema.voiceKeys).values({
        installerId: context.installerId,
        userId: context.actor.userId,
        keyHash: hashSecret(key),
        deviceName,
      });
      return { key };
    }),

  /** Sign out, or "turn Siri off on this phone". */
  revokeKey: crewVoice.input(z.object({ id: z.number().nullable().optional() }).default({})).handler(async ({ input, context }) => {
    const id = input.id ?? context.voiceKeyId;
    if (!id) return { revoked: 0 };
    const rows = await db
      .update(schema.voiceKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(schema.voiceKeys.id, id), eq(schema.voiceKeys.installerId, context.installerId), isNull(schema.voiceKeys.revokedAt)),
      )
      .returning({ id: schema.voiceKeys.id });
    return { revoked: rows.length };
  }),

  /* ------------------------------ office ------------------------------- */

  /** Every phone that can talk to Terra through Siri, for the Logins page. */
  keys: adminOnly.handler(async () => {
    return db
      .select({
        id: schema.voiceKeys.id,
        installerId: schema.voiceKeys.installerId,
        installerName: schema.installers.name,
        deviceName: schema.voiceKeys.deviceName,
        lastUsedAt: schema.voiceKeys.lastUsedAt,
        createdAt: schema.voiceKeys.createdAt,
        revokedAt: schema.voiceKeys.revokedAt,
      })
      .from(schema.voiceKeys)
      .innerJoin(schema.installers, eq(schema.installers.id, schema.voiceKeys.installerId))
      .orderBy(desc(schema.voiceKeys.createdAt))
      .limit(200);
  }),

  adminRevokeKey: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const rows = await db
      .update(schema.voiceKeys)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.voiceKeys.id, input.id), isNull(schema.voiceKeys.revokedAt)))
      .returning({ id: schema.voiceKeys.id });
    return { revoked: rows.length };
  }),
};
