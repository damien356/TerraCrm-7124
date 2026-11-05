import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";

/* ---------------------------------------------------------------------------
 * AI phone calls and routing: the settings (Retell, 5 Nov).
 *
 * One JSON value in settings key phone_ai_config, edited in Admin, AI phone
 * calls and routing. Nobody is hardcoded: every destination is a person, a
 * team or a role picked on that screen. Off until someone switches it on, and
 * every action has its own switch.
 * ------------------------------------------------------------------------- */

export const PHONE_CONFIG_KEY = "phone_ai_config";

export const CALL_TYPES = ["enquiry", "measure", "existing_job", "booking", "accounts", "complaint", "urgent", "failure", "other"] as const;
export type CallType = (typeof CALL_TYPES)[number];

export const CALL_TYPE_LABELS: Record<CallType, string> = {
  enquiry: "New enquiry",
  measure: "Measure or site visit",
  existing_job: "Question or update on an existing job",
  booking: "Install booking or reschedule",
  accounts: "Invoices and payments",
  complaint: "Complaint",
  urgent: "Urgent problem",
  failure: "Call or action failed",
  other: "Anything else",
};

export const CHANNELS = ["in_app", "push", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Where work goes: one person, a team, everyone with a role, the job's manager, or the duty person. */
export const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile"), profileId: z.number().int() }),
  z.object({ kind: z.literal("team"), teamKey: z.string().min(1).max(40) }),
  z.object({ kind: z.literal("role"), role: z.enum(["admin", "office"]) }),
  z.object({ kind: z.literal("duty") }),
  z.object({ kind: z.literal("queue") }),
]);
export type Destination = z.infer<typeof destination>;

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

const rule = z.object({
  dest: destination,
  /** Tried when the destination has nobody available. */
  backupProfileId: z.number().int().nullable().default(null),
  /** Who it goes to when the deadline passes unresolved. */
  escalateTo: destination.nullable().default(null),
  /** Minutes of office time to pick it up. */
  deadlineMins: z.number().int().min(5).max(7 * 24 * 60).default(120),
  /** How the owner hears about it. Urgent work always pushes and emails as well. */
  channels: z.array(z.enum(CHANNELS)).default(["in_app", "push"]),
  /** The priority a follow-up of this type starts at. */
  priority: z.enum(["normal", "high", "urgent"]).default("normal"),
});
export type Rule = z.infer<typeof rule>;

const team = z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(60), memberIds: z.array(z.number().int()).default([]) });

export const phoneConfigSchema = z.object({
  /** The master switch. Off means every tool call is refused and the agent hands over to a person. */
  enabled: z.boolean().default(false),
  actions: z
    .object({
      lookup: z.boolean().default(true),
      enquiry: z.boolean().default(true),
      note: z.boolean().default(true),
      update: z.boolean().default(true),
      measureBooking: z.boolean().default(true),
      installChange: z.boolean().default(true),
      quoteResend: z.boolean().default(true),
      callback: z.boolean().default(true),
      transfer: z.boolean().default(true),
    })
    .prefault({}),
  officeHours: z
    .object({
      /** 0 Sunday … 6 Saturday. */
      days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      start: hhmm.default("07:30"),
      end: hhmm.default("16:30"),
    })
    .prefault({}),
  teams: z.array(team).max(20).default([]),
  /** Owns unassigned and fallen-through work. Null means the default queue holds it. */
  dutyProfileId: z.number().int().nullable().default(null),
  /** The team key unowned work waits in. */
  defaultQueue: z.string().max(40).default("office"),
  rules: z.partialRecord(z.enum(CALL_TYPES), rule).default({}),
  /** Calls about an existing job go to that job's manager first, when it has one. */
  jobManagerFirst: z.boolean().default(true),
  /** Push every finished call to whoever it routed to, not only the ones that need work. */
  notifyEveryCall: z.boolean().default(true),
  /** Remind the owner this many minutes before escalating. */
  reminderBeforeEscalateMins: z.number().int().min(0).max(24 * 60).default(30),
  permissions: z
    .object({
      viewCalls: z.array(z.enum(["admin", "office"])).default(["admin", "office"]),
      transcripts: z.array(z.enum(["admin", "office"])).default(["admin"]),
      routing: z.array(z.enum(["admin", "office"])).default(["admin"]),
      reassign: z.array(z.enum(["admin", "office"])).default(["admin", "office"]),
    })
    .prefault({}),
  /** Live transfer. Separate from who owns the follow-up. */
  transfers: z
    .object({
      /** Per call type, who a live transfer rings. A person's phone comes from their profile. */
      byCallType: z.partialRecord(z.enum(CALL_TYPES), destination).default({}),
      /** Out of hours a transfer is not tried: a callback is booked instead. */
      onlyInHours: z.boolean().default(true),
      /** No answer on the transfer: book a callback follow-up. */
      noAnswerCallback: z.boolean().default(true),
    })
    .prefault({}),
  /** Measure and site visits the agent may book. */
  visits: z
    .object({
      durationMins: z.number().int().min(15).max(480).default(60),
      /** Travel either side, on top of a person's own calendar buffers. */
      bufferMins: z.number().int().min(0).max(240).default(30),
      startTimes: z.array(hhmm).max(12).default(["08:00", "10:00", "13:00", "15:00"]),
      daysAhead: z.number().int().min(1).max(60).default(14),
      /** Not sooner than this many hours from the call. */
      minNoticeHours: z.number().int().min(0).max(168).default(18),
      /** The skill the visit task carries. Null: the "Measure & quote" skill by name. */
      skillId: z.number().int().nullable().default(null),
      /** Who may be booked. Empty: every active installer ticked for the skill. */
      installerIds: z.array(z.number().int()).default([]),
    })
    .prefault({}),
  /** Install changes the agent may make itself. Off means every install change is a scheduling task. */
  installAutoMove: z.boolean().default(false),
});
export type PhoneConfig = z.infer<typeof phoneConfigSchema>;

/** Suggested defaults from the brief. Teams start empty: people are added on the screen. */
export function defaultConfig(): PhoneConfig {
  const t = (teamKey: string) => ({ kind: "team" as const, teamKey });
  return phoneConfigSchema.parse({
    teams: [
      { key: "office", name: "Office", memberIds: [] },
      { key: "sales", name: "Sales", memberIds: [] },
      { key: "scheduling", name: "Scheduling", memberIds: [] },
      { key: "accounts", name: "Accounts", memberIds: [] },
      { key: "managers", name: "Managers", memberIds: [] },
    ],
    rules: {
      enquiry: { dest: t("sales"), escalateTo: t("managers"), deadlineMins: 60 },
      measure: { dest: t("sales"), escalateTo: t("managers"), deadlineMins: 120 },
      existing_job: { dest: t("office"), escalateTo: t("managers"), deadlineMins: 240 },
      booking: { dest: t("scheduling"), escalateTo: t("managers"), deadlineMins: 240 },
      accounts: { dest: t("accounts"), escalateTo: t("managers"), deadlineMins: 480 },
      complaint: { dest: t("managers"), escalateTo: { kind: "duty" }, deadlineMins: 60, priority: "high", channels: ["in_app", "push", "email"] },
      urgent: { dest: t("managers"), escalateTo: { kind: "duty" }, deadlineMins: 15, priority: "urgent", channels: ["in_app", "push", "email"] },
      failure: { dest: { kind: "duty" }, escalateTo: t("managers"), deadlineMins: 30, priority: "high", channels: ["in_app", "push", "email"] },
      other: { dest: t("office"), escalateTo: t("managers"), deadlineMins: 480 },
    },
  });
}

/** The rule for a call type, falling back to "other", then to the default queue. */
export function ruleFor(cfg: PhoneConfig, type: CallType): Rule {
  return cfg.rules[type] ?? cfg.rules.other ?? rule.parse({ dest: { kind: "queue" } });
}

export async function loadPhoneConfig(): Promise<PhoneConfig> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, PHONE_CONFIG_KEY));
  if (!row) return defaultConfig();
  try {
    return phoneConfigSchema.parse(JSON.parse(row.value));
  } catch (e) {
    // A broken value never switches the agent on.
    console.error("[phone] config unreadable, using defaults (off):", (e as Error).message);
    return defaultConfig();
  }
}

export async function savePhoneConfig(cfg: PhoneConfig) {
  const value = JSON.stringify(phoneConfigSchema.parse(cfg));
  await db
    .insert(schema.settings)
    .values({ key: PHONE_CONFIG_KEY, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

/* --------------------------- office hours -------------------------------- */

const BNE_OFFSET_MS = 10 * 3600_000;
const MIN = 60_000;

/** Brisbane wall clock parts of an instant. Brisbane has no daylight saving. */
export function bneParts(at: Date) {
  const d = new Date(at.getTime() + BNE_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const atBne = (date: string, minutes: number) => new Date(Date.parse(`${date}T00:00:00+10:00`) + minutes * MIN);

export function inOfficeHours(cfg: PhoneConfig, at = new Date()) {
  const p = bneParts(at);
  const { days, start, end } = cfg.officeHours;
  return days.includes(p.weekday) && p.minutes >= toMin(start) && p.minutes < toMin(end);
}

/** The next moment the office is open, or `at` itself when it already is. */
export function nextOpen(cfg: PhoneConfig, at = new Date()): Date {
  if (inOfficeHours(cfg, at)) return at;
  const { days, start } = cfg.officeHours;
  if (!days.length) return at;
  for (let i = 0; i < 14; i++) {
    const t = new Date(at.getTime() + i * 86_400_000);
    const p = bneParts(t);
    if (!days.includes(p.weekday)) continue;
    const open = atBne(p.date, toMin(start));
    if (open.getTime() > at.getTime()) return open;
  }
  return at;
}

/**
 * A deadline counted in office minutes: after hours the clock starts when the
 * office opens. Urgent work is counted in real minutes, day or night.
 */
export function deadlineFrom(cfg: PhoneConfig, mins: number, at = new Date(), urgent = false): Date {
  if (urgent) return new Date(at.getTime() + mins * MIN);
  const { days, end } = cfg.officeHours;
  if (!days.length) return new Date(at.getTime() + mins * MIN);
  let cursor = nextOpen(cfg, at);
  let left = mins;
  for (let guard = 0; guard < 60 && left > 0; guard++) {
    const p = bneParts(cursor);
    const close = atBne(p.date, toMin(end));
    const room = Math.max(0, (close.getTime() - cursor.getTime()) / MIN);
    if (left <= room) return new Date(cursor.getTime() + left * MIN);
    left -= room;
    cursor = nextOpen(cfg, new Date(close.getTime() + MIN));
  }
  return new Date(cursor.getTime() + left * MIN);
}
