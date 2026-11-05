import { z } from "zod";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly, type Actor } from "../middleware/auth";
import { jobText } from "../lib/refs";
import { localDate } from "../lib/local-date";
import { emailConfigured } from "../lib/email";
import { actionsFor, audit, phoneTablesMissing } from "../lib/phone/calls";
import {
  CALL_TYPES,
  CALL_TYPE_LABELS,
  CHANNELS,
  deadlineFrom,
  inOfficeHours,
  loadPhoneConfig,
  nextOpen,
  phoneConfigSchema,
  ruleFor,
  savePhoneConfig,
  type Destination,
  type PhoneConfig,
} from "../lib/phone/config";
import {
  assignFollowup,
  claimFollowup,
  followupById,
  moveOpenWork,
  openFollowups,
  reopenFollowup,
  resolveFollowup,
  sayWhen,
  startFollowup,
  type StaffActor,
} from "../lib/phone/followups";
import { channelStatus } from "../lib/phone/notify";
import { coverFor, destLabel, membersOf, personOf, resolveRoute, settlePerson } from "../lib/phone/routing";
import { retellConfigured } from "../lib/phone/signature";
import { TOOL_NAMES } from "../lib/phone/functions";
import { phoneSweepTicking } from "../lib/phone/sweep";
import { visitPeople, visitSkillId } from "../lib/phone/visits";

/**
 * AI PHONE CALLS AND ROUTING (Retell, 5 Nov). Admin and Office only; Field
 * crew never reach any of it.
 *
 * Who may do what comes from the settings, not from code: viewing calls,
 * reading transcripts and recordings, changing routing, and reassigning
 * someone else's work each have their own role list on the settings screen.
 */

type Perm = keyof PhoneConfig["permissions"];
const can = (cfg: PhoneConfig, actor: Actor, p: Perm) => actor.role !== "field" && (cfg.permissions[p] as string[]).includes(actor.role);

async function need(p: Perm, actor: Actor) {
  const cfg = await loadPhoneConfig();
  if (!can(cfg, actor, p)) {
    const what = { viewCalls: "view AI phone calls", transcripts: "open call transcripts", routing: "change call routing", reassign: "reassign other people's follow-ups" }[p];
    throw new ORPCError("FORBIDDEN", { message: `Your role can't ${what}. An admin can change that in AI phone calls and routing.` });
  }
  return cfg;
}

/** Fails clearly before the SQL file has been run, instead of a database error. */
async function ready() {
  const missing = await phoneTablesMissing();
  if (missing.length) throw new ORPCError("PRECONDITION_FAILED", { message: `The AI phone tables aren't set up yet (${missing.join(", ")}). They need the 2026-11-25-phone-calls.sql update.` });
}

const staffOf = (a: Actor): StaffActor => ({ name: a.name, role: a.role, profileId: a.profileId });

/** Library errors are plain messages meant for the screen. */
async function friendly<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ORPCError) throw e;
    throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
  }
}

/** Office and admin logins who can own phone work, for every picker. */
async function officePeople() {
  const rows = await db
    .select({ id: schema.profiles.id, name: schema.profiles.name, email: schema.profiles.email, role: schema.profiles.role, phone: schema.profiles.phone })
    .from(schema.profiles)
    .where(and(inArray(schema.profiles.role, ["admin", "office"]), eq(schema.profiles.active, true), isNull(schema.profiles.archivedAt)))
    .orderBy(schema.profiles.name);
  return rows.map((r) => ({ id: r.id, name: r.name || r.email, role: r.role, hasPhone: !!(r.phone ?? "").trim() }));
}

async function mustBeOfficePerson(id: number) {
  const p = await personOf(id);
  if (!p || p.archived || !p.active) throw new ORPCError("BAD_REQUEST", { message: "That person can't take work right now." });
  if (p.role !== "admin" && p.role !== "office") throw new ORPCError("BAD_REQUEST", { message: "Only office staff can own phone work." });
  return p;
}

/* ----------------------------- call records ------------------------------ */

const callListCols = {
  id: schema.phoneCalls.id,
  fromNumber: schema.phoneCalls.fromNumber,
  withheld: schema.phoneCalls.withheld,
  status: schema.phoneCalls.status,
  startedAt: schema.phoneCalls.startedAt,
  endedAt: schema.phoneCalls.endedAt,
  durationSec: schema.phoneCalls.durationSec,
  callType: schema.phoneCalls.callType,
  priority: schema.phoneCalls.priority,
  summary: schema.phoneCalls.summary,
  outcome: schema.phoneCalls.outcome,
  needsPerson: schema.phoneCalls.needsPerson,
  newEnquiry: schema.phoneCalls.newEnquiry,
  verified: sql<number>`${schema.phoneCalls.verifiedContactId} is not null`,
  jobId: schema.phoneCalls.jobId,
  jobNumber: schema.jobs.number,
  jobDisplay: schema.jobs.displayNumber,
  contactId: schema.phoneCalls.contactId,
  firstName: schema.contacts.firstName,
  lastName: schema.contacts.lastName,
  ownerProfileId: schema.phoneCalls.ownerProfileId,
  createdAt: schema.phoneCalls.createdAt,
};

async function listCalls(where: ReturnType<typeof and> | undefined, limit: number) {
  const rows = await db
    .select(callListCols)
    .from(schema.phoneCalls)
    .leftJoin(schema.jobs, eq(schema.jobs.id, schema.phoneCalls.jobId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.phoneCalls.contactId))
    .where(where)
    .orderBy(desc(schema.phoneCalls.id))
    .limit(limit);
  return rows.map((r) => {
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
    return {
      ...r,
      callerName: name || null,
      jobRef: r.jobNumber != null ? jobText({ number: r.jobNumber, displayNumber: r.jobDisplay }) : null,
      verified: !!r.verified,
      typeLabel: CALL_TYPE_LABELS[r.callType as keyof typeof CALL_TYPE_LABELS] ?? String(r.callType),
    };
  });
}

async function shapeFollowups(rows: Awaited<ReturnType<typeof openFollowups>>) {
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is number => !!x))];
  const jobs = jobIds.length ? await db.select({ id: schema.jobs.id, number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds)) : [];
  const ref = new Map(jobs.map((j) => [j.id, jobText(j)]));
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    jobRef: r.jobId ? (ref.get(r.jobId) ?? null) : null,
    typeLabel: CALL_TYPE_LABELS[r.callType as keyof typeof CALL_TYPE_LABELS] ?? r.callType,
    dueLabel: sayWhen(r.dueAt),
    overdue: r.status !== "resolved" && !!r.dueAt && r.dueAt.getTime() < now,
  }));
}

/* --------------------------------- routes -------------------------------- */

const followupScope = z.enum(["mine", "queue", "open", "resolved", "all"]);

export const phoneCalls = {
  /** What is set up and what is still missing. Shown on the Terra AI page and the top of the phone screen. */
  status: staffOnly.handler(async ({ context }) => {
    const missing = await phoneTablesMissing();
    const cfg = await loadPhoneConfig();
    const people = await officePeople();
    const channels = missing.length ? [] : await channelStatus(people.map((p) => p.id));
    const now = new Date();
    return {
      tablesMissing: missing,
      retellKeySet: retellConfigured(),
      agentIdSet: !!(process.env.RETELL_AGENT_ID ?? "").trim(),
      enabled: cfg.enabled,
      actions: cfg.actions,
      sweepRunning: phoneSweepTicking(),
      emailConnected: emailConfigured(),
      officeOpen: inOfficeHours(cfg, now),
      nextOpen: sayWhen(nextOpen(cfg, now)),
      channels,
      webhookPath: "/api/webhooks/retell",
      functionPath: "/api/retell/fn/<name>",
      tools: TOOL_NAMES,
      canRouting: can(cfg, context.actor, "routing"),
      canTranscripts: can(cfg, context.actor, "transcripts"),
      canReassign: can(cfg, context.actor, "reassign"),
      canView: can(cfg, context.actor, "viewCalls"),
      me: context.actor.profileId,
    };
  }),

  /** The settings screen: the config plus everything its pickers need. */
  config: staffOnly.handler(async ({ context }) => {
    const cfg = await loadPhoneConfig();
    const skills = await db.select({ id: schema.skills.id, name: schema.skills.name }).from(schema.skills).orderBy(schema.skills.name);
    const skillId = await visitSkillId(cfg);
    const visitors = await visitPeople(cfg, skillId);
    const installers = await db
      .select({ id: schema.installers.id, name: schema.installers.name })
      .from(schema.installers)
      .where(and(eq(schema.installers.active, true), isNull(schema.installers.archivedAt)))
      .orderBy(schema.installers.name);
    return {
      config: cfg,
      canEdit: can(cfg, context.actor, "routing"),
      people: await officePeople(),
      skills,
      installers,
      visitSkillId: skillId,
      visitPeople: installers.filter((i) => visitors.includes(i.id)),
      callTypes: CALL_TYPES.map((key) => ({ key, label: CALL_TYPE_LABELS[key] })),
      channels: CHANNELS,
    };
  }),

  /** Save the settings. Every reference is checked, and the change is audited. */
  saveConfig: staffOnly.input(z.object({ config: phoneConfigSchema })).handler(async ({ input, context }) => {
    const before = await need("routing", context.actor);
    const cfg = input.config;
    const people = new Map((await officePeople()).map((p) => [p.id, p]));
    const teams = new Set(cfg.teams.map((t) => t.key));
    const problems: string[] = [];
    const checkDest = (d: Destination | null | undefined, where: string) => {
      if (!d) return;
      if (d.kind === "profile" && !people.has(d.profileId)) problems.push(`${where}: that person isn't an active office login.`);
      if (d.kind === "team" && !teams.has(d.teamKey)) problems.push(`${where}: team "${d.teamKey}" doesn't exist.`);
    };
    if (new Set(cfg.teams.map((t) => t.key)).size !== cfg.teams.length) problems.push("Two teams have the same key.");
    for (const t of cfg.teams) for (const id of t.memberIds) if (!people.has(id)) problems.push(`${t.name}: person ${id} isn't an active office login.`);
    if (cfg.dutyProfileId && !people.has(cfg.dutyProfileId)) problems.push("Duty person isn't an active office login.");
    if (!teams.has(cfg.defaultQueue)) problems.push(`The queue "${cfg.defaultQueue}" isn't one of the teams.`);
    for (const [k, r] of Object.entries(cfg.rules)) {
      const label = CALL_TYPE_LABELS[k as keyof typeof CALL_TYPE_LABELS];
      checkDest(r?.dest, label);
      checkDest(r?.escalateTo, `${label} escalation`);
      if (r?.backupProfileId && !people.has(r.backupProfileId)) problems.push(`${label} backup isn't an active office login.`);
    }
    for (const [k, d] of Object.entries(cfg.transfers.byCallType)) checkDest(d, `${CALL_TYPE_LABELS[k as keyof typeof CALL_TYPE_LABELS]} transfer`);
    if (cfg.officeHours.start >= cfg.officeHours.end) problems.push("Office hours end before they start.");
    // Nobody can lock every role out of routing.
    if (!cfg.permissions.routing.includes("admin")) problems.push("Admin must keep the routing permission.");
    if (problems.length) throw new ORPCError("BAD_REQUEST", { message: problems.slice(0, 6).join(" ") });

    await savePhoneConfig(cfg);
    const changed = (Object.keys(cfg) as (keyof PhoneConfig)[]).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(before[k]));
    await audit(
      "phone_routing",
      null,
      "phone_config_saved",
      `Changed: ${changed.join(", ") || "nothing"}.${before.enabled !== cfg.enabled ? ` Agent switched ${cfg.enabled ? "ON" : "OFF"}.` : ""}`,
      context.actor,
    );
    return { ok: true, changed };
  }),

  /**
   * The routing test: who would own this right now, step by step, and who a
   * live transfer would ring. Nothing is written or sent.
   */
  testRoute: staffOnly
    .input(z.object({ callType: z.enum(CALL_TYPES), jobRef: z.string().max(30).optional(), at: z.string().datetime({ offset: true }).optional(), draft: phoneConfigSchema.optional() }))
    .handler(async ({ input, context }) => {
      const saved = await need("viewCalls", context.actor);
      await ready();
      const cfg = input.draft ?? saved;
      const now = input.at ? new Date(input.at) : new Date();
      let jobId: number | null = null;
      let jobNote = "";
      if (input.jobRef?.trim()) {
        const ref = input.jobRef.trim().replace(/^#/, "");
        const [j] = await db
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(sql`${schema.jobs.displayNumber} = ${ref} or cast(${schema.jobs.number} as text) = ${ref}`)
          .limit(1);
        jobId = j?.id ?? null;
        jobNote = j ? "" : `No job ${ref} found, tested without one.`;
      }
      const route = await resolveRoute(cfg, input.callType, { jobId, now });
      const rule = ruleFor(cfg, input.callType);
      const due = deadlineFrom(cfg, rule.deadlineMins, now, rule.priority === "urgent");
      const names = new Map((await officePeople()).map((p) => [p.id, p.name]));
      // Transfer is its own setting: who the agent rings live, not who owns the follow-up.
      const tDest = cfg.transfers.byCallType[input.callType] ?? null;
      let transfer = "No live transfer set for this call type. The agent books a callback instead.";
      if (tDest) {
        const steps: string[] = [];
        const ids = await membersOf(cfg, tDest, steps);
        let rung = "";
        for (const id of ids) {
          const { person } = await settlePerson(id, localDate(now));
          if (person?.phone?.trim()) {
            rung = person.name;
            break;
          }
        }
        const hours = cfg.transfers.onlyInHours && !inOfficeHours(cfg, now) ? " Office is closed at that time, so it would book a callback instead." : "";
        transfer = rung ? `Live transfer rings ${rung} (${destLabel(cfg, tDest, names)}).${hours}` : `Live transfer to ${destLabel(cfg, tDest, names)}, but nobody there has a phone number on their login.`;
      }
      return {
        owner: route.ownerName || null,
        queue: route.ownerProfileId ? null : (cfg.teams.find((t) => t.key === route.queueKey)?.name ?? route.queueKey),
        steps: [...(jobNote ? [jobNote] : []), ...route.steps],
        deadline: sayWhen(due),
        priority: rule.priority,
        channels: rule.channels,
        escalatesTo: destLabel(cfg, rule.escalateTo, names),
        officeOpen: inOfficeHours(cfg, now),
        transfer,
      };
    }),

  /** Recent calls, or the calls on one job or one person. */
  calls: staffOnly
    .input(z.object({ jobId: z.number().optional(), contactId: z.number().optional(), limit: z.number().min(1).max(300).default(100) }))
    .handler(async ({ input, context }) => {
      await need("viewCalls", context.actor);
      await ready();
      const conds = [];
      if (input.jobId) conds.push(eq(schema.phoneCalls.jobId, input.jobId));
      if (input.contactId) conds.push(eq(schema.phoneCalls.contactId, input.contactId));
      return listCalls(conds.length ? and(...conds) : undefined, input.limit);
    }),

  /** One call: what was done, what's left, who was told. Transcript and recording only with that permission, and opening them is audited. */
  call: staffOnly.input(z.object({ id: z.number(), withTranscript: z.boolean().default(false) })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const [row] = await listCalls(eq(schema.phoneCalls.id, input.id), 1);
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Call not found" });
    const [full] = await db.select().from(schema.phoneCalls).where(eq(schema.phoneCalls.id, input.id));
    const actions = (await actionsFor(input.id)).map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status,
      error: a.error,
      say: (() => {
        try {
          return String((JSON.parse(a.result) as { say?: string }).say ?? "");
        } catch {
          return "";
        }
      })(),
      entityType: a.entityType,
      entityId: a.entityId,
      at: a.createdAt,
    }));
    const followups = await shapeFollowups(await db.select().from(schema.phoneFollowups).where(eq(schema.phoneFollowups.callId, input.id)).orderBy(schema.phoneFollowups.id));
    const notices = await db
      .select({ id: schema.phoneNotifications.id, reason: schema.phoneNotifications.reason, channel: schema.phoneNotifications.channel, status: schema.phoneNotifications.status, detail: schema.phoneNotifications.detail, name: schema.profiles.name, at: schema.phoneNotifications.createdAt })
      .from(schema.phoneNotifications)
      .leftJoin(schema.profiles, eq(schema.profiles.id, schema.phoneNotifications.profileId))
      .where(eq(schema.phoneNotifications.callId, input.id))
      .orderBy(schema.phoneNotifications.id);
    const mayRead = can(cfg, context.actor, "transcripts");
    let transcript: string | null = null;
    let recordingUrl: string | null = null;
    if (input.withTranscript) {
      if (!mayRead) throw new ORPCError("FORBIDDEN", { message: "Your role can't open call transcripts." });
      transcript = full!.transcript;
      recordingUrl = full!.recordingUrl;
      await audit("phone_call", input.id, "phone_transcript_opened", "Opened the transcript and recording", context.actor, full!.jobId);
    }
    return {
      ...row,
      toNumber: full!.toNumber,
      verifyMethod: full!.verifyMethod,
      disconnectionReason: full!.disconnectionReason,
      sentiment: full!.sentiment,
      analysisState: full!.analysisState,
      hasTranscript: !!full!.transcript,
      hasRecording: !!full!.recordingUrl,
      mayReadTranscript: mayRead,
      transcript,
      recordingUrl,
      actions,
      followups,
      notices,
    };
  }),

  /** Follow-ups: mine, the unowned queue, all open, or resolved. */
  followups: staffOnly.input(z.object({ scope: followupScope.default("mine"), jobId: z.number().optional(), contactId: z.number().optional() })).handler(async ({ input, context }) => {
    await need("viewCalls", context.actor);
    await ready();
    const open = ["new", "assigned", "in_progress"];
    const rows =
      input.jobId || input.contactId
        ? await openFollowups({ jobId: input.jobId, contactId: input.contactId })
        : input.scope === "mine"
          ? context.actor.profileId
            ? await openFollowups({ ownerProfileId: context.actor.profileId, status: open })
            : []
          : input.scope === "queue"
            ? await openFollowups({ ownerProfileId: null })
            : input.scope === "open"
              ? await openFollowups({ status: open })
              : input.scope === "resolved"
                ? await openFollowups({ status: ["resolved"], limit: 100 })
                : await openFollowups({ limit: 300 });
    return shapeFollowups(rows);
  }),

  followup: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    await need("viewCalls", context.actor);
    await ready();
    const fu = await followupById(input.id);
    if (!fu) throw new ORPCError("NOT_FOUND", { message: "Follow-up not found" });
    const [shaped] = await shapeFollowups([fu]);
    const history = await db
      .select({ id: schema.activityLog.id, action: schema.activityLog.action, detail: schema.activityLog.detail, actorName: schema.activityLog.actorName, at: schema.activityLog.createdAt })
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "phone_followup"), eq(schema.activityLog.entityId, input.id)))
      .orderBy(schema.activityLog.id);
    const notices = await db
      .select({ id: schema.phoneNotifications.id, reason: schema.phoneNotifications.reason, channel: schema.phoneNotifications.channel, status: schema.phoneNotifications.status, detail: schema.phoneNotifications.detail, name: schema.profiles.name, at: schema.phoneNotifications.createdAt })
      .from(schema.phoneNotifications)
      .leftJoin(schema.profiles, eq(schema.profiles.id, schema.phoneNotifications.profileId))
      .where(eq(schema.phoneNotifications.followupId, input.id))
      .orderBy(schema.phoneNotifications.id);
    return { ...shaped!, history, notices };
  }),

  /** Take it yourself. Unowned work anyone can take; someone else's needs the reassign permission. */
  claim: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const me = context.actor.profileId;
    if (!me) throw new ORPCError("BAD_REQUEST", { message: "Your login has no profile." });
    const fu = await followupById(input.id);
    if (!fu) throw new ORPCError("NOT_FOUND", { message: "Follow-up not found" });
    if (fu.ownerProfileId && fu.ownerProfileId !== me && !can(cfg, context.actor, "reassign")) {
      throw new ORPCError("FORBIDDEN", { message: `${fu.ownerName} owns this. Ask them, or someone who can reassign, to pass it to you.` });
    }
    const cover = await coverFor(me, localDate());
    if (cover?.kind === "leave") throw new ORPCError("BAD_REQUEST", { message: `You're on leave in Terra Ops until ${cover.toDate}. Cancel the leave first to take work.` });
    return friendly(() => claimFollowup(cfg, input.id, { ...staffOf(context.actor), profileId: me }));
  }),

  /** Pass it to someone. The owner can pass their own; anyone else's needs the reassign permission. Deadline and history stay. */
  assign: staffOnly.input(z.object({ id: z.number(), toProfileId: z.number(), note: z.string().max(500).default("") })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const fu = await followupById(input.id);
    if (!fu) throw new ORPCError("NOT_FOUND", { message: "Follow-up not found" });
    const mine = fu.ownerProfileId === context.actor.profileId;
    if (!mine && fu.ownerProfileId && !can(cfg, context.actor, "reassign")) throw new ORPCError("FORBIDDEN", { message: "Your role can't reassign other people's follow-ups." });
    if (!fu.ownerProfileId && !can(cfg, context.actor, "reassign")) throw new ORPCError("FORBIDDEN", { message: "Your role can't hand out queue work. Claim it yourself instead." });
    const to = await mustBeOfficePerson(input.toProfileId);
    const cover = await coverFor(to.id, localDate());
    if (cover) {
      const c = await personOf(cover.coverProfileId);
      throw new ORPCError("BAD_REQUEST", { message: `${to.name} ${cover.kind === "leave" ? `is on leave until ${cover.toDate}` : "has delegated their work"}. Give it to ${c?.name ?? "their cover"} instead.` });
    }
    return friendly(() => assignFollowup(cfg, input.id, to.id, staffOf(context.actor), input.note.trim()));
  }),

  start: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const fu = await followupById(input.id);
    if (!fu) throw new ORPCError("NOT_FOUND", { message: "Follow-up not found" });
    if (fu.ownerProfileId !== context.actor.profileId) {
      if (fu.ownerProfileId && !can(cfg, context.actor, "reassign")) throw new ORPCError("FORBIDDEN", { message: `${fu.ownerName} owns this one.` });
      // Starting unowned or someone else's work makes you the owner: one accountable person.
      if (!context.actor.profileId) throw new ORPCError("BAD_REQUEST", { message: "Your login has no profile." });
      return friendly(() => claimFollowup(cfg, input.id, { ...staffOf(context.actor), profileId: context.actor.profileId! }));
    }
    return friendly(() => startFollowup(input.id, staffOf(context.actor)));
  }),

  resolve: staffOnly.input(z.object({ id: z.number(), resolution: z.string().min(3).max(2000) })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const fu = await followupById(input.id);
    if (!fu) throw new ORPCError("NOT_FOUND", { message: "Follow-up not found" });
    if (fu.ownerProfileId && fu.ownerProfileId !== context.actor.profileId && !can(cfg, context.actor, "reassign")) {
      throw new ORPCError("FORBIDDEN", { message: `${fu.ownerName} owns this one. Only they, or someone who can reassign, can resolve it.` });
    }
    return friendly(() => resolveFollowup(input.id, staffOf(context.actor), input.resolution));
  }),

  reopen: staffOnly.input(z.object({ id: z.number(), why: z.string().max(500).default("") })).handler(async ({ input, context }) => {
    await need("viewCalls", context.actor);
    await ready();
    return friendly(() => reopenFollowup(input.id, staffOf(context.actor), input.why.trim()));
  }),

  /* ------------------------- leave cover and delegation ------------------------- */

  covers: staffOnly.handler(async ({ context }) => {
    await need("viewCalls", context.actor);
    await ready();
    const rows = await db.select().from(schema.staffCover).where(isNull(schema.staffCover.cancelledAt)).orderBy(desc(schema.staffCover.id)).limit(200);
    const names = new Map((await officePeople()).map((p) => [p.id, p.name]));
    const today = localDate();
    return rows
      .filter((r) => !r.toDate || r.toDate >= today)
      .map((r) => ({ ...r, personName: names.get(r.profileId) ?? `Person ${r.profileId}`, coverName: names.get(r.coverProfileId) ?? `Person ${r.coverProfileId}`, current: r.fromDate <= today }));
  }),

  /**
   * Set leave cover (dated) or a delegation (no end). Your own needs nothing
   * extra; someone else's needs the reassign permission. When it starts today
   * their open work moves now, deadlines kept; later leave moves on its day.
   */
  addCover: staffOnly
    .input(
      z.object({
        profileId: z.number(),
        coverProfileId: z.number(),
        kind: z.enum(["leave", "delegation"]),
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        reason: z.string().max(300).default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const cfg = await need("viewCalls", context.actor);
      await ready();
      if (input.profileId !== context.actor.profileId && !can(cfg, context.actor, "reassign")) throw new ORPCError("FORBIDDEN", { message: "You can set your own cover. Someone else's needs the reassign permission." });
      if (input.profileId === input.coverProfileId) throw new ORPCError("BAD_REQUEST", { message: "Someone can't cover themselves." });
      if (input.kind === "leave" && !input.toDate) throw new ORPCError("BAD_REQUEST", { message: "Leave needs an end date. Use a delegation for no end." });
      if (input.toDate && input.toDate < input.fromDate) throw new ORPCError("BAD_REQUEST", { message: "The end date is before the start." });
      const person = await mustBeOfficePerson(input.profileId);
      const cover = await mustBeOfficePerson(input.coverProfileId);
      const today = localDate();
      // A cover who is away themselves would loop or strand the work.
      const { person: lands, steps } = await settlePerson(cover.id, input.fromDate > today ? input.fromDate : today);
      if (!lands) throw new ORPCError("BAD_REQUEST", { message: `${cover.name} can't take it then. ${steps.join(" ")}` });
      const [row] = await db
        .insert(schema.staffCover)
        .values({ profileId: person.id, coverProfileId: cover.id, kind: input.kind, fromDate: input.fromDate, toDate: input.toDate, reason: input.reason.trim(), createdByName: context.actor.name })
        .returning();
      await audit("staff_cover", row!.id, "staff_cover_set", `${person.name}: ${input.kind} ${input.fromDate}${input.toDate ? ` to ${input.toDate}` : " onwards"}, covered by ${cover.name}.${input.reason ? ` ${input.reason}` : ""}`, context.actor);
      let moved = 0;
      if (input.fromDate <= today) moved = await friendly(() => moveOpenWork(cfg, person.id, lands.id, staffOf(context.actor), `${input.kind === "leave" ? "Leave cover" : "Delegation"} set by ${context.actor.name}.`));
      return { id: row!.id, moved, coverName: lands.name };
    }),

  cancelCover: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const cfg = await need("viewCalls", context.actor);
    await ready();
    const [row] = await db.select().from(schema.staffCover).where(eq(schema.staffCover.id, input.id));
    if (!row || row.cancelledAt) throw new ORPCError("NOT_FOUND", { message: "Cover not found" });
    if (row.profileId !== context.actor.profileId && !can(cfg, context.actor, "reassign")) throw new ORPCError("FORBIDDEN", { message: "Only the person, or someone who can reassign, can cancel this." });
    await db.update(schema.staffCover).set({ cancelledAt: new Date(), cancelledByName: context.actor.name, updatedAt: new Date() }).where(eq(schema.staffCover.id, input.id));
    // Work already moved stays with the cover: it is theirs now, and they were told.
    await audit("staff_cover", row.id, "staff_cover_cancelled", `Cancelled by ${context.actor.name}. Work already passed on stays with its new owner.`, context.actor);
    return { ok: true };
  }),

  /* ------------------------------ job manager ------------------------------ */

  jobManager: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    if ((await phoneTablesMissing()).length) return { profileId: null, name: null, tablesMissing: true };
    const [row] = await db.select().from(schema.jobManagers).where(eq(schema.jobManagers.jobId, input.jobId));
    const p = row ? await personOf(row.profileId) : null;
    return { profileId: row?.profileId ?? null, name: p?.name ?? null, tablesMissing: false };
  }),

  setJobManager: staffOnly.input(z.object({ jobId: z.number(), profileId: z.number().nullable() })).handler(async ({ input, context }) => {
    await ready();
    const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const [prior] = await db.select().from(schema.jobManagers).where(eq(schema.jobManagers.jobId, input.jobId));
    const before = prior ? ((await personOf(prior.profileId))?.name ?? "someone") : "nobody";
    if (input.profileId === null) {
      await db.delete(schema.jobManagers).where(eq(schema.jobManagers.jobId, input.jobId));
    } else {
      const p = await mustBeOfficePerson(input.profileId);
      await db
        .insert(schema.jobManagers)
        .values({ jobId: input.jobId, profileId: p.id, setByName: context.actor.name })
        .onConflictDoUpdate({ target: schema.jobManagers.jobId, set: { profileId: p.id, setByName: context.actor.name, updatedAt: new Date() } });
    }
    const after = input.profileId ? ((await personOf(input.profileId))?.name ?? "") : "nobody";
    await db.insert(schema.activityLog).values({ jobId: input.jobId, entityType: "job", entityId: input.jobId, action: "job_manager_set", detail: `Job manager: ${before} → ${after}. New phone calls about this job go to them first.`, actorName: context.actor.name, actorRole: context.actor.role });
    return { ok: true };
  }),

  /** The job card: its calls and open follow-ups in one go. Empty (not an error) before the SQL runs or without permission. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => {
    const cfg = await loadPhoneConfig();
    if ((await phoneTablesMissing()).length || !can(cfg, context.actor, "viewCalls")) return { calls: [], followups: [], hidden: true };
    const calls = await listCalls(eq(schema.phoneCalls.jobId, input.jobId), 50);
    const followups = await shapeFollowups(
      await db
        .select()
        .from(schema.phoneFollowups)
        .where(and(eq(schema.phoneFollowups.jobId, input.jobId), ne(schema.phoneFollowups.status, "resolved")))
        .orderBy(desc(schema.phoneFollowups.id)),
    );
    return { calls, followups, hidden: false };
  }),

  /** The same for a person's card. */
  forContact: staffOnly.input(z.object({ contactId: z.number() })).handler(async ({ input, context }) => {
    const cfg = await loadPhoneConfig();
    if ((await phoneTablesMissing()).length || !can(cfg, context.actor, "viewCalls")) return { calls: [], followups: [], hidden: true };
    const calls = await listCalls(eq(schema.phoneCalls.contactId, input.contactId), 50);
    const followups = await shapeFollowups(
      await db
        .select()
        .from(schema.phoneFollowups)
        .where(and(eq(schema.phoneFollowups.contactId, input.contactId), ne(schema.phoneFollowups.status, "resolved")))
        .orderBy(desc(schema.phoneFollowups.id)),
    );
    return { calls, followups, hidden: false };
  }),
};
