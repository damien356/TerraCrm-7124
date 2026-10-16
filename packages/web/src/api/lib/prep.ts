import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { ensureForJob, logMessage } from "./conversations";
import { sendJobEmail } from "./job-mail";
import { jobRef } from "./job-ref";
import { addLocalDays, localDate } from "./local-date";
import { clientAutoSmsOn } from "./notify";
import { isBuilderType, parseTags } from "./person-tags";
import { isMeasureSkill, isUnitType, parseAptChecks, propertyTypeAnswered, propertyTypeLabel } from "./property-types";
import {
  PREP_DEFAULTS,
  parsePrepTemplates,
  renderDaySms,
  renderInstallEmail,
  renderOmwSms,
  type PrepFacts,
  type PrepTemplates,
} from "./prep-templates";
import { isLiveServer } from "./runtime";
import { normaliseMobile, sendSms } from "./sms";

/* ---------------------------------------------------------------------------
 * CLIENT PREP MESSAGES (notes 18.56).
 *
 * The one place Terra messages a client on its own:
 *   install email   3 days before the first install day, once a job
 *   day before text before every booked install day
 *   on my way text  when the installer (or the office) taps On my way
 *
 * Rules, all from Damien:
 *   - Only scheduled installs, never a measure, never a cancelled job or task.
 *   - Off for builder and insurance builder jobs unless the job is switched on.
 *   - Never to the builder's office: owners, tenants and the site contact only.
 *   - Owner and Tenant both on the job: the Tenant gets everything, the Owner
 *     gets the install email only.
 *   - Property type or Furniture moving not answered: everything holds and the
 *     job goes on the 7am email to be answered.
 *   - Sends from 10am Gold Coast time. Nothing goes out after 7pm.
 *   - Every send is a prep_sends row claimed before it goes, keyed by job,
 *     kind, day and person, so nothing goes twice and a changed date sends
 *     again with the new date. A Stop is a row with no person.
 * ------------------------------------------------------------------------- */

export const PREP_ON_KEY = "prep_on";
export const PREP_WINDOW_START_KEY = "prep_window_start";
export const PREP_WINDOW_END_KEY = "prep_window_end";
export const PREP_SEND_HOUR_KEY = "prep_send_hour";
export const PREP_TEMPLATES_KEY = "prep_templates";

const LAST_HOUR = 19;
const CLOSED_STATUS_NAMES = ["paid", "cancelled"];

export type PrepKind = "install_email" | "day_sms" | "omw_sms";
export const PREP_KIND_LABELS: Record<PrepKind, string> = {
  install_email: "Install email",
  day_sms: "Day before text",
  omw_sms: "On my way text",
};

export type PrepSettings = {
  on: boolean;
  windowStart: string;
  windowEnd: string;
  sendHour: number;
  templates: PrepTemplates;
};

export async function prepSettings(): Promise<PrepSettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [PREP_ON_KEY, PREP_WINDOW_START_KEY, PREP_WINDOW_END_KEY, PREP_SEND_HOUR_KEY, PREP_TEMPLATES_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const hhmm = (s: string | undefined, d: string) => (/^\d{2}:\d{2}$/.test(s ?? "") ? s! : d);
  const hour = Number(v.get(PREP_SEND_HOUR_KEY));
  return {
    on: v.get(PREP_ON_KEY) !== "0",
    windowStart: hhmm(v.get(PREP_WINDOW_START_KEY), "07:00"),
    windowEnd: hhmm(v.get(PREP_WINDOW_END_KEY), "11:00"),
    sendHour: Number.isInteger(hour) && hour >= 6 && hour < LAST_HOUR ? hour : 10,
    templates: parsePrepTemplates(v.get(PREP_TEMPLATES_KEY)),
  };
}

export async function savePrepSettings(s: PrepSettings) {
  const put = (key: string, value: string) =>
    db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
  /* Wording that matches the default is not stored, so a later fix to the default reaches it. */
  const changed = Object.fromEntries(Object.entries(s.templates).filter(([k, val]) => val.trim() && val !== PREP_DEFAULTS[k as keyof PrepTemplates]));
  await put(PREP_ON_KEY, s.on ? "1" : "0");
  await put(PREP_WINDOW_START_KEY, s.windowStart);
  await put(PREP_WINDOW_END_KEY, s.windowEnd);
  await put(PREP_SEND_HOUR_KEY, String(s.sendHour));
  await put(PREP_TEMPLATES_KEY, JSON.stringify(changed));
}

/** Gold Coast hour, 0 to 23. Queensland has no daylight saving. */
const qldHour = (now: Date) => Number(new Date(now.getTime() + 10 * 3600_000).toISOString().slice(11, 13));

/* ------------------------------ the job ---------------------------------- */

type Person = {
  key: string;
  contactId: number;
  name: string;
  firstName: string;
  email: string | null;
  mobile: string | null;
  /** What this person gets. */
  kinds: PrepKind[];
  why: string;
};

/** Tags that mean the builder's or agent's side, never the people living there. */
const NOT_THE_HOUSEHOLD = new Set(["supervisor", "builder_contact", "accounts", "property_manager"]);

async function loadJob(jobId: number) {
  const [row] = await db
    .select({ job: schema.jobs, site: schema.sites, statusName: schema.jobStatuses.name, companyType: schema.companies.type })
    .from(schema.jobs)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
    .where(eq(schema.jobs.id, jobId));
  return row ?? null;
}
type LoadedJob = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

const isClosed = (statusName: string | null | undefined) => CLOSED_STATUS_NAMES.includes((statusName ?? "").trim().toLowerCase());
const isCancelled = (statusName: string | null | undefined) => (statusName ?? "").trim().toLowerCase() === "cancelled";

export const builderJob = (j: Pick<LoadedJob, "companyType">) => isBuilderType(j.companyType);
/** The job's switch, or the rule when nobody has touched it. */
export const jobPrepOn = (j: Pick<LoadedJob, "job" | "companyType">) => j.job.prepOn ?? !builderJob(j);

/** What is still to answer before an install can be booked or a prep message can go. */
export function missingAnswers(j: { siteId: number | null; furnitureMoving: boolean | null }, propertyType: string | null | undefined) {
  const out: string[] = [];
  if (!j.siteId) out.push("site address and property type");
  else if (!propertyTypeAnswered(propertyType)) out.push("property type");
  if (j.furnitureMoving == null) out.push("furniture moving Yes or No");
  return out;
}

async function recipients(j: LoadedJob): Promise<Person[]> {
  const links = await db
    .select({ link: schema.jobContacts, c: schema.contacts })
    .from(schema.jobContacts)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.jobContacts.contactId))
    .where(eq(schema.jobContacts.jobId, j.job.id))
    .orderBy(asc(schema.jobContacts.id));
  const people = links.map((l) => ({ ...l, tags: parseTags(l.link.tags) as string[] }));
  const make = (c: typeof schema.contacts.$inferSelect, kinds: PrepKind[], why: string): Person => ({
    key: `c:${c.id}`,
    contactId: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.email || c.mobile || "Client",
    firstName: (c.firstName || "").trim().split(/\s+/)[0] || "",
    email: c.email?.trim() || null,
    mobile: normaliseMobile(c.mobile),
    kinds,
    why,
  });
  const ALL: PrepKind[] = ["install_email", "day_sms", "omw_sms"];
  const tenants = people.filter((p) => p.tags.includes("tenant"));
  const owners = people.filter((p) => p.tags.includes("owner") && !p.tags.includes("tenant"));
  if (tenants.length) {
    return [...tenants.map((p) => make(p.c, ALL, "Tenant")), ...owners.map((p) => make(p.c, ["install_email"], "Owner, install email only"))];
  }
  if (owners.length) return owners.map((p) => make(p.c, ALL, "Owner"));
  const onSite = people.filter((p) => p.link.onSiteContact && !p.tags.some((t) => NOT_THE_HOUSEHOLD.has(t)));
  if (onSite.length) return onSite.map((p) => make(p.c, ALL, "Site contact"));
  /* The job's customer, only on a private job. On a builder's job that is the builder. */
  if (j.job.contactId && !builderJob(j)) {
    const linked = people.find((p) => p.c.id === j.job.contactId);
    if (linked && linked.tags.some((t) => NOT_THE_HOUSEHOLD.has(t))) return [];
    const [c] = linked ? [linked.c] : await db.select().from(schema.contacts).where(eq(schema.contacts.id, j.job.contactId));
    if (c) return [make(c, ALL, "Customer")];
  }
  return [];
}

type InstallDay = {
  date: string;
  taskId: number;
  installerId: number | null;
  /** Null: the installer and the site sort the time out. */
  window: { start: string; end: string } | null;
  booked: boolean;
};

/** Every install day on the job, one per date, oldest first. Measures and cancelled work left out. */
export async function installDays(jobId: number, s: Pick<PrepSettings, "windowStart" | "windowEnd">): Promise<InstallDay[]> {
  const tasks = await db
    .select({ task: schema.jobTasks, skillName: schema.skills.name })
    .from(schema.jobTasks)
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .where(and(eq(schema.jobTasks.jobId, jobId), ne(schema.jobTasks.status, "cancelled")));
  const installs = tasks.filter((t) => !isMeasureSkill(t.skillName ?? t.task.title));
  if (!installs.length) return [];
  const days = await db
    .select()
    .from(schema.taskDays)
    .where(and(inArray(schema.taskDays.taskId, installs.map((t) => t.task.id)), ne(schema.taskDays.status, "cancelled")));
  type Raw = { date: string; taskId: number; installerId: number | null; start: string | null; end: string | null; coordinate: boolean; booked: boolean };
  const raw: Raw[] = [];
  for (const t of installs) {
    const mine = days.filter((d) => d.taskId === t.task.id);
    if (mine.length) {
      for (const d of mine)
        raw.push({
          date: d.date,
          taskId: t.task.id,
          installerId: d.installerId ?? t.task.assignedInstallerId,
          start: d.arrivalStart,
          end: d.arrivalEnd,
          coordinate: d.coordinate,
          booked: d.status === "booked",
        });
    } else if (t.task.scheduledDate) {
      /* Booked before day rows existed: one day, the default window. */
      raw.push({
        date: t.task.scheduledDate,
        taskId: t.task.id,
        installerId: t.task.assignedInstallerId,
        start: null,
        end: null,
        coordinate: false,
        booked: t.task.status !== "complete",
      });
    }
  }
  const byDate = new Map<string, Raw[]>();
  for (const r of raw) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rs]) => {
      const timed = rs.filter((r) => !r.coordinate);
      const withWindow = timed.filter((r) => r.start && r.end);
      const window = !timed.length
        ? null
        : withWindow.length
          ? { start: withWindow.map((r) => r.start!).sort()[0]!, end: withWindow.map((r) => r.end!).sort().reverse()[0]! }
          : { start: s.windowStart, end: s.windowEnd };
      const lead = timed[0] ?? rs[0]!;
      return { date, taskId: lead.taskId, installerId: lead.installerId, window, booked: rs.some((r) => r.booked) };
    });
}

/* ------------------------------ the plan --------------------------------- */

export type PlanItem = {
  kind: PrepKind;
  forDate: string;
  /** The day it goes (it goes the next morning tick when this is already past). */
  sendOn: string;
  taskId: number;
  stopped: { byName: string; at: Date } | null;
  preview: { subject: string | null; body: string; to: string };
  people: Array<{ key: string; name: string; why: string; channel: "email" | "sms"; to: string | null; status: string; detail: string | null; at: Date | null }>;
};

export type JobPlan = Awaited<ReturnType<typeof jobPlan>>;

/** Everything the job's prep panel shows, and everything the timer sends from. */
export async function jobPlan(jobId: number, now = new Date()) {
  const j = await loadJob(jobId);
  if (!j) return null;
  const s = await prepSettings();
  const today = localDate(now);
  const people = await recipients(j);
  const days = await installDays(jobId, s);
  const sends = await db.select().from(schema.prepSends).where(eq(schema.prepSends.jobId, jobId)).orderBy(asc(schema.prepSends.id));
  const missing = missingAnswers(j.job, j.site?.propertyType);
  const unit = isUnitType(j.site?.propertyType);
  const smsOn = await clientAutoSmsOn();
  const on = s.on && jobPrepOn(j);
  const cancelled = isCancelled(j.statusName);

  const hold = !s.on
    ? "Client prep messages are off in Settings."
    : cancelled
      ? "The job is cancelled. Nothing sends."
      : !jobPrepOn(j)
        ? builderJob(j) && j.job.prepOn == null
          ? "Off: builder and insurance jobs are off unless switched on here."
          : "Switched off on this job."
        : missing.length
          ? `Held: answer the ${missing.join(" and ")} on the job.`
          : !people.length
            ? "Nobody to send to: tag the Owner or Tenant on the job, or tick the site contact."
            : null;

  const facts = (date: string, window: PrepFacts["window"], p?: Person): PrepFacts => ({
    firstName: p?.firstName ?? people[0]?.firstName ?? "",
    date,
    window,
    furnitureMoving: j.job.furnitureMoving ?? false,
    unit,
  });

  const items: PlanItem[] = [];
  const stopOf = (kind: PrepKind, forDate: string) => {
    const r = sends.find((x) => x.kind === kind && x.forDate === forDate && x.recipient === "");
    return r ? { byName: r.byName, at: r.createdAt } : null;
  };
  const peopleFor = (kind: PrepKind, forDate: string, channel: "email" | "sms") =>
    people
      .filter((p) => p.kinds.includes(kind))
      .map((p) => {
        const to = channel === "email" ? p.email : p.mobile;
        const row = sends.find((x) => x.kind === kind && x.forDate === forDate && x.recipient === p.key);
        const status = row
          ? row.status
          : !to
            ? channel === "email"
              ? "no email"
              : "no mobile"
            : channel === "sms" && !smsOn
              ? "texts off"
              : "waiting";
        return { key: p.key, name: p.name, why: p.why, channel, to, status, detail: row?.detail ?? null, at: row?.updatedAt ?? null };
      });

  const first = days[0];
  if (first && first.date > today) {
    const r = renderInstallEmail(s.templates, facts(first.date, first.window));
    items.push({
      kind: "install_email",
      forDate: first.date,
      sendOn: addLocalDays(first.date, -3),
      taskId: first.taskId,
      stopped: stopOf("install_email", first.date),
      preview: { subject: r.subject, body: r.body, to: "" },
      people: peopleFor("install_email", first.date, "email"),
    });
  }
  for (const d of days) {
    if (!d.booked || d.date <= today) continue;
    items.push({
      kind: "day_sms",
      forDate: d.date,
      sendOn: addLocalDays(d.date, -1),
      taskId: d.taskId,
      stopped: stopOf("day_sms", d.date),
      preview: { subject: null, body: renderDaySms(s.templates, facts(d.date, d.window)), to: "" },
      people: peopleFor("day_sms", d.date, "sms"),
    });
  }

  /* No install booked yet: show what it would say, so the office can check the wording on the job. */
  const exampleDate = addLocalDays(today, 3);
  const example = days.length
    ? null
    : {
        date: exampleDate,
        email: renderInstallEmail(s.templates, facts(exampleDate, { start: s.windowStart, end: s.windowEnd })),
        sms: renderDaySms(s.templates, facts(exampleDate, { start: s.windowStart, end: s.windowEnd })),
      };

  const checks = parseAptChecks(j.job.aptChecks);
  return {
    jobId,
    ref: jobRef(j.job),
    today,
    settingsOn: s.on,
    jobOn: jobPrepOn(j),
    prepOnSet: j.job.prepOn,
    builder: builderJob(j),
    on,
    cancelled,
    closed: isClosed(j.statusName),
    hold,
    missing,
    propertyType: j.site?.propertyType ?? null,
    propertyLabel: propertyTypeLabel(j.site?.propertyType),
    furnitureMoving: j.job.furnitureMoving,
    unit,
    aptChecks: checks,
    sendHour: s.sendHour,
    smsOn,
    people: people.map((p) => ({ key: p.key, contactId: p.contactId, name: p.name, why: p.why, email: p.email, mobile: p.mobile, kinds: p.kinds })),
    days,
    items,
    example,
    log: sends
      .filter((x) => x.recipient !== "")
      .map((x) => ({ id: x.id, kind: x.kind as PrepKind, forDate: x.forDate, channel: x.channel, to: x.toAddress, status: x.status, detail: x.detail, byName: x.byName, at: x.updatedAt })),
    _people: people,
    _job: j,
  };
}

/** The plan without the server-only parts, for the office. */
export function planForOffice(p: NonNullable<JobPlan>) {
  const { _people, _job, ...rest } = p;
  void _people;
  void _job;
  return rest;
}

/* ------------------------------ sending ---------------------------------- */

type ClaimArgs = { jobId: number; taskId: number | null; kind: PrepKind; forDate: string; person: Person; channel: "email" | "sms"; to: string; byName: string };

/** Claim the row first. Two servers, or two taps, and only one gets it. */
async function claim(a: ClaimArgs) {
  const rows = await db
    .insert(schema.prepSends)
    .values({
      jobId: a.jobId,
      taskId: a.taskId,
      kind: a.kind,
      forDate: a.forDate,
      recipient: a.person.key,
      contactId: a.person.contactId,
      channel: a.channel,
      toAddress: a.to,
      status: "sending",
      byName: a.byName,
    })
    .onConflictDoNothing()
    .returning({ id: schema.prepSends.id });
  return rows[0]?.id ?? null;
}

async function settle(id: number, status: "sent" | "failed", detail: string | null, messageId: number | null) {
  await db.update(schema.prepSends).set({ status, detail: detail?.slice(0, 500) ?? null, messageId, updatedAt: new Date() }).where(eq(schema.prepSends.id, id));
}

async function smsOptedOut(mobile: string, contactId: number) {
  const local = mobile.startsWith("+61") ? `0${mobile.slice(3)}` : mobile;
  const [row] = await db
    .select({ id: schema.unsubscribes.id })
    .from(schema.unsubscribes)
    .where(
      and(
        inArray(schema.unsubscribes.channel, ["sms", "all"]),
        sql`(${schema.unsubscribes.mobile} in (${mobile}, ${local}) or ${schema.unsubscribes.contactId} = ${contactId})`,
      ),
    )
    .limit(1);
  return !!row;
}

/** One text to one person, logged on the job's thread and timeline. */
async function sendPrepSms(a: ClaimArgs & { body: string }) {
  const id = await claim(a);
  if (!id) return { sent: false as const, why: "already" };
  if (await smsOptedOut(a.to, a.person.contactId)) {
    await settle(id, "failed", "Opted out of texts (replied STOP).", null);
    return { sent: false as const, why: "opted out" };
  }
  const out = await sendSms({ to: a.to, body: a.body, sender: "number", needsReply: true });
  if (!out.ok && out.deferred) {
    /* Temporary (no credit, ClickSend down): give the claim back so the next tick tries again. */
    await db.delete(schema.prepSends).where(eq(schema.prepSends.id, id));
    console.error(`[prep] ${a.kind} job ${a.jobId} to ${a.to} deferred: ${out.reason}`);
    return { sent: false as const, why: out.reason };
  }
  const conv = await ensureForJob(a.jobId);
  const msg = await logMessage({
    conversationId: conv.id,
    jobId: a.jobId,
    contactId: a.person.contactId,
    channel: "sms",
    audience: "customer",
    direction: "out",
    body: a.body,
    authorName: a.byName,
    toAddress: a.to,
    label: PREP_KIND_LABELS[a.kind],
    providerId: out.ok ? out.providerId : null,
    status: out.ok ? "sent" : "failed",
    statusDetail: out.ok ? null : out.reason,
    failedAt: out.ok ? null : new Date(),
  });
  await settle(id, out.ok ? "sent" : "failed", out.ok ? null : out.reason, msg.id);
  await db.insert(schema.activityLog).values({
    jobId: a.jobId,
    taskId: a.taskId,
    contactId: a.person.contactId,
    entityType: "job",
    entityId: a.jobId,
    action: out.ok ? "prep_sent" : "prep_failed",
    detail: `${PREP_KIND_LABELS[a.kind]} ${out.ok ? "sent" : "not sent"} to ${a.person.name} (${a.to})${out.ok ? "" : `: ${out.reason}`}`.slice(0, 500),
    actorName: a.byName,
    actorRole: "system",
  });
  return out.ok ? { sent: true as const, messageId: msg.id } : { sent: false as const, why: out.reason };
}

async function sendPrepEmail(a: ClaimArgs & { subject: string; body: string }) {
  const id = await claim(a);
  if (!id) return { sent: false as const, why: "already" };
  try {
    const conv = await ensureForJob(a.jobId);
    const out = await sendJobEmail({
      conv,
      jobId: a.jobId,
      to: a.to,
      subject: a.subject,
      text: a.body,
      authorName: a.byName,
      audience: "customer",
      contactId: a.person.contactId,
      label: PREP_KIND_LABELS[a.kind],
    });
    await settle(id, "sent", null, out.message.id);
    await db.insert(schema.activityLog).values({
      jobId: a.jobId,
      taskId: a.taskId,
      contactId: a.person.contactId,
      entityType: "job",
      entityId: a.jobId,
      action: "prep_sent",
      detail: `${PREP_KIND_LABELS[a.kind]} sent to ${a.person.name} (${a.to})`.slice(0, 500),
      actorName: a.byName,
      actorRole: "system",
    });
    return { sent: true as const, messageId: out.message.id };
  } catch (e) {
    const why = (e as Error).message ?? String(e);
    await settle(id, "failed", why, null);
    await db.insert(schema.activityLog).values({
      jobId: a.jobId,
      taskId: a.taskId,
      contactId: a.person.contactId,
      entityType: "job",
      entityId: a.jobId,
      action: "prep_failed",
      detail: `${PREP_KIND_LABELS[a.kind]} not sent to ${a.person.name} (${a.to}): ${why}`.slice(0, 500),
      actorName: a.byName,
      actorRole: "system",
    });
    return { sent: false as const, why };
  }
}

const SENDER_NAME = "Terra (client prep)";

/** Send what is due on one job now. Returns how many went. */
export async function sendDueForJob(jobId: number, now = new Date(), opts: { byName?: string; ignoreHour?: boolean } = {}) {
  const plan = await jobPlan(jobId, now);
  if (!plan || !plan.on || plan.hold || plan.closed) return { sent: 0, failed: 0 };
  const s = await prepSettings();
  const hour = qldHour(now);
  if (!opts.ignoreHour && (hour < s.sendHour || hour >= LAST_HOUR)) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const item of plan.items) {
    if (item.stopped || item.sendOn > plan.today || item.forDate <= plan.today) continue;
    for (const who of item.people) {
      if (who.status !== "waiting" || !who.to) continue;
      const person = plan._people.find((p) => p.key === who.key)!;
      const base = { jobId, taskId: item.taskId, kind: item.kind, forDate: item.forDate, person, to: who.to, byName: opts.byName ?? SENDER_NAME };
      const day = plan.days.find((d) => d.date === item.forDate);
      const facts: PrepFacts = { firstName: person.firstName, date: item.forDate, window: day?.window ?? null, furnitureMoving: plan.furnitureMoving ?? false, unit: plan.unit };
      const out =
        who.channel === "email"
          ? await sendPrepEmail({ ...base, channel: "email", ...renderInstallEmail(s.templates, facts) })
          : await sendPrepSms({ ...base, channel: "sms", body: renderDaySms(s.templates, facts) });
      if (out.sent) sent++;
      else if (out.why !== "already") failed++;
    }
  }
  return { sent, failed };
}

/** Jobs with an install day coming up in the next 3 days. Cheap enough to run every 5 minutes. */
async function jobsWithInstallsSoon(today: string) {
  const to = addLocalDays(today, 3);
  const fromDays = await db
    .selectDistinct({ jobId: schema.jobTasks.jobId })
    .from(schema.taskDays)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskDays.taskId))
    .where(and(gte(schema.taskDays.date, today), lte(schema.taskDays.date, to), ne(schema.taskDays.status, "cancelled"), ne(schema.jobTasks.status, "cancelled")));
  const fromTasks = await db
    .selectDistinct({ jobId: schema.jobTasks.jobId })
    .from(schema.jobTasks)
    .where(and(gte(schema.jobTasks.scheduledDate, today), lte(schema.jobTasks.scheduledDate, to), ne(schema.jobTasks.status, "cancelled")));
  return [...new Set([...fromDays, ...fromTasks].map((r) => r.jobId))].sort((a, b) => a - b);
}

let running = false;

export async function tickPrep(now = new Date()) {
  if (running) return { jobs: 0, sent: 0, failed: 0 };
  running = true;
  const out = { jobs: 0, sent: 0, failed: 0 };
  try {
    const s = await prepSettings();
    const hour = qldHour(now);
    if (!s.on || hour < s.sendHour || hour >= LAST_HOUR) return out;
    for (const jobId of await jobsWithInstallsSoon(localDate(now))) {
      try {
        const r = await sendDueForJob(jobId, now);
        out.jobs++;
        out.sent += r.sent;
        out.failed += r.failed;
      } catch (e) {
        console.error(`[prep] job ${jobId} failed:`, (e as Error).message ?? e);
      }
    }
    return out;
  } finally {
    running = false;
  }
}

let booted = false;
export function bootPrep() {
  if (booted) return;
  booted = true;
  const mode = process.env.PREP_TIMER;
  if (mode === "off") return void console.log("[prep] client prep timer disabled by PREP_TIMER=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[prep] client prep timer idle, not the published server");
  console.log("[prep] client prep checks every 5 minutes, sends from 10am");
  setInterval(() => void tickPrep(), 5 * 60_000);
  setTimeout(() => void tickPrep(), 45_000);
}

/* ------------------------------ Stop ------------------------------------- */

export async function stopPrep(jobId: number, kind: PrepKind, forDate: string, byName: string) {
  await db
    .insert(schema.prepSends)
    .values({ jobId, kind, forDate, recipient: "", channel: "", status: "stopped", byName })
    .onConflictDoNothing();
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "job",
    entityId: jobId,
    action: "prep_stopped",
    detail: `${PREP_KIND_LABELS[kind]} for ${forDate.split("-").reverse().join("/")} stopped`,
    actorName: byName,
    actorRole: "office",
  });
}

export async function unstopPrep(jobId: number, kind: PrepKind, forDate: string, byName: string) {
  await db
    .delete(schema.prepSends)
    .where(and(eq(schema.prepSends.jobId, jobId), eq(schema.prepSends.kind, kind), eq(schema.prepSends.forDate, forDate), eq(schema.prepSends.recipient, "")));
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "job",
    entityId: jobId,
    action: "prep_unstopped",
    detail: `${PREP_KIND_LABELS[kind]} for ${forDate.split("-").reverse().join("/")} back on`,
    actorName: byName,
    actorRole: "office",
  });
}

/** A failed send can go again: the failed row is cleared and the item sends now. */
export async function retryFailed(jobId: number, kind: PrepKind, forDate: string, byName: string, now = new Date()) {
  await db
    .delete(schema.prepSends)
    .where(and(eq(schema.prepSends.jobId, jobId), eq(schema.prepSends.kind, kind), eq(schema.prepSends.forDate, forDate), eq(schema.prepSends.status, "failed")));
  return sendDueForJob(jobId, now, { byName, ignoreHour: true });
}

/* ------------------------------ On my way -------------------------------- */

/**
 * The installer (or the office for them) is leaving for the job. Goes to the
 * person who gets the day texts. Once per job per day per person.
 */
export async function onMyWay(taskId: number, by: { name: string; installerId: number | null }, now = new Date()) {
  const [task] = await db.select().from(schema.jobTasks).where(eq(schema.jobTasks.id, taskId));
  if (!task) return { ok: false as const, reason: "Task not found." };
  const plan = await jobPlan(task.jobId, now);
  if (!plan) return { ok: false as const, reason: "Job not found." };
  if (plan.cancelled || plan.closed) return { ok: false as const, reason: "This job is closed, so no text goes." };
  if (!plan.settingsOn) return { ok: false as const, reason: "Client prep texts are off in Settings. Call the client instead." };
  if (!plan.jobOn) return { ok: false as const, reason: "Client texts are off on this job. Call the client instead." };
  const people = plan._people.filter((p) => p.kinds.includes("omw_sms"));
  if (!people.length) return { ok: false as const, reason: "Nobody on the job to text. Call the office." };
  const installerId = by.installerId ?? task.assignedInstallerId;
  const [installer] = installerId ? await db.select().from(schema.installers).where(eq(schema.installers.id, installerId)) : [];
  const installerFirstName = (installer?.name ?? by.name).trim().split(/\s+/)[0] ?? "";
  const s = await prepSettings();
  const today = plan.today;
  const results: Array<{ name: string; to: string | null; status: string }> = [];
  for (const p of people) {
    if (!p.mobile) {
      results.push({ name: p.name, to: null, status: "no mobile" });
      continue;
    }
    const body = renderOmwSms(s.templates, { firstName: p.firstName, installerFirstName });
    const out = await sendPrepSms({ jobId: task.jobId, taskId, kind: "omw_sms", forDate: today, person: p, channel: "sms", to: p.mobile, byName: by.name, body });
    results.push({ name: p.name, to: p.mobile, status: out.sent ? "sent" : out.why === "already" ? "already sent today" : `not sent: ${out.why}` });
  }
  const sent = results.filter((r) => r.status === "sent").length;
  const already = results.filter((r) => r.status === "already sent today").length;
  return {
    ok: sent > 0 || already > 0,
    sent,
    results,
    reason: sent ? null : already ? "Already sent today." : results.map((r) => `${r.name}: ${r.status}`).join(". "),
  };
}

/* ------------------------------ Apartment checklist ---------------------- */

export async function tickAptCheck(jobId: number, key: "fire" | "lift" | "parking", done: boolean, byName: string, role: string) {
  const [job] = await db.select({ aptChecks: schema.jobs.aptChecks }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new Error("Job not found");
  let checks: Record<string, unknown> = {};
  try {
    checks = JSON.parse(job.aptChecks || "{}") ?? {};
  } catch {
    checks = {};
  }
  if (done) checks[key] = { at: new Date().toISOString(), by: byName };
  else delete checks[key];
  await db.update(schema.jobs).set({ aptChecks: JSON.stringify(checks), updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
  const label = { fire: "Fire alarm isolated", lift: "Lift booked and padded", parking: "Parking/access sorted" }[key];
  await db.insert(schema.activityLog).values({
    jobId,
    entityType: "job",
    entityId: jobId,
    action: "apt_check",
    detail: `${label}: ${done ? "ticked" : "unticked"}`,
    actorName: byName,
    actorRole: role,
  });
  return parseAptChecks(JSON.stringify(checks));
}

/* ------------------------------ Key replies ------------------------------ */

const KEY_WORDS = /\b(keys?|lock ?box|key ?safe|under the (door ?)?mat|letter ?box|mail ?box|neighbou?rs?|safe spot|spare)\b/i;

/** The client's own words, without quoted history. */
function freshText(body: string) {
  let text = body
    .split("\n")
    .filter((l) => !l.trim().startsWith(">"))
    .join("\n");
  /* Our own words quoted back without ">" (some mail apps): cut from the first one. */
  const ours = [/Terra Flooring here\./i, /Can't be home\?/i, /Leave a key somewhere safe/i, /Your new flooring goes in on/i, /Getting ready for your flooring install/i];
  let end = text.length;
  for (const re of ours) {
    const m = re.exec(text);
    if (m && m.index < end) end = m.index;
  }
  text = text.slice(0, end);
  return text.trim();
}

export const looksLikeKeyReply = (body: string) => KEY_WORDS.test(freshText(body));

/**
 * A client answering a prep message with where the key is. Saved onto the
 * job's access notes, which the installer's task card shows. Only on a job
 * that has had a prep message in the last 30 days, so a stray "keys" in some
 * other email never lands there. Never throws.
 */
export async function noteKeyReply(args: { jobId: number | null; contactId: number | null; body: string; channel: "sms" | "email"; name: string; photos?: number }) {
  try {
    if (!args.jobId) return false;
    const text = freshText(args.body);
    if (!text || !KEY_WORDS.test(text)) return false;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [recent] = await db
      .select({ id: schema.prepSends.id })
      .from(schema.prepSends)
      .where(and(eq(schema.prepSends.jobId, args.jobId), eq(schema.prepSends.status, "sent"), gte(schema.prepSends.updatedAt, since)))
      .limit(1);
    if (!recent) return false;
    const [job] = await db.select({ accessNotes: schema.jobs.accessNotes }).from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
    if (!job) return false;
    const day = localDate(new Date()).split("-").reverse().join("/");
    const words = text.replace(/\s+/g, " ").slice(0, 400);
    const line = `Key, from the client ${day} (${args.channel === "sms" ? "text" : "email"}, ${args.name}): ${words}${args.photos ? " Photo in the job files." : ""}`;
    const notes = [job.accessNotes?.trim(), line].filter(Boolean).join("\n");
    await db.update(schema.jobs).set({ accessNotes: notes, updatedAt: new Date() }).where(eq(schema.jobs.id, args.jobId));
    await db.insert(schema.activityLog).values({
      jobId: args.jobId,
      contactId: args.contactId,
      entityType: "job",
      entityId: args.jobId,
      action: "key_note_saved",
      detail: `Saved to access notes: ${words}`.slice(0, 500),
      actorName: args.name.slice(0, 120) || "Client",
      actorRole: "customer",
    });
    return true;
  } catch (e) {
    console.error("[prep] key reply not saved:", (e as Error).message ?? e);
    return false;
  }
}

/* ------------------------------ Lists ------------------------------------ */

/** Open jobs with an install booked from today on, still missing an answer. */
export async function jobsToFill(now = new Date()) {
  const today = localDate(now);
  const s = await prepSettings();
  const fromDays = await db
    .selectDistinct({ jobId: schema.jobTasks.jobId })
    .from(schema.taskDays)
    .innerJoin(schema.jobTasks, eq(schema.jobTasks.id, schema.taskDays.taskId))
    .where(and(gte(schema.taskDays.date, today), ne(schema.taskDays.status, "cancelled"), ne(schema.jobTasks.status, "cancelled")));
  const fromTasks = await db
    .selectDistinct({ jobId: schema.jobTasks.jobId })
    .from(schema.jobTasks)
    .where(and(gte(schema.jobTasks.scheduledDate, today), ne(schema.jobTasks.status, "cancelled")));
  const ids = [...new Set([...fromDays, ...fromTasks].map((r) => r.jobId))];
  const out: Array<{ jobId: number; ref: string; title: string; address: string; firstDay: string; missing: string[]; siteId: number | null; propertyType: string | null; furnitureMoving: boolean | null }> = [];
  for (const id of ids) {
    const j = await loadJob(id);
    if (!j || isClosed(j.statusName)) continue;
    const missing = missingAnswers(j.job, j.site?.propertyType);
    if (!missing.length) continue;
    const days = (await installDays(id, s)).filter((d) => d.date >= today);
    if (!days.length) continue;
    out.push({
      jobId: id,
      ref: jobRef(j.job),
      title: j.job.title,
      address: [j.site?.address, j.site?.suburb].filter(Boolean).join(", "),
      firstDay: days[0]!.date,
      missing,
      siteId: j.site?.id ?? null,
      propertyType: j.site?.propertyType ?? null,
      furnitureMoving: j.job.furnitureMoving,
    });
  }
  return out.sort((a, b) => a.firstDay.localeCompare(b.firstDay));
}

/** The two 7am email sections: what goes today, and what is held for an answer. Never throws. */
export async function prepForSummary(now = new Date()) {
  const sendingToday: Array<{ jobId: number; ref: string; kind: PrepKind; forDate: string; who: string }> = [];
  const needsAnswer: Array<{ jobId: number; ref: string; firstDay: string; missing: string[] }> = [];
  try {
    const s = await prepSettings();
    const today = localDate(now);
    for (const jobId of await jobsWithInstallsSoon(today)) {
      const plan = await jobPlan(jobId, now);
      if (!plan || plan.closed) continue;
      const soon = plan.days.find((d) => d.date >= today);
      if (plan.missing.length && soon) {
        needsAnswer.push({ jobId, ref: plan.ref, firstDay: soon.date, missing: plan.missing });
        continue;
      }
      if (!s.on || !plan.on || plan.hold) continue;
      for (const item of plan.items) {
        if (item.stopped || item.sendOn > today || item.forDate <= today) continue;
        const who = item.people.filter((p) => p.status === "waiting").map((p) => p.name);
        if (who.length) sendingToday.push({ jobId, ref: plan.ref, kind: item.kind, forDate: item.forDate, who: who.join(", ") });
      }
    }
  } catch (e) {
    console.error("[prep] summary failed:", (e as Error).message ?? e);
  }
  return { sendingToday, needsAnswer };
}

/* ------------------------------ Booking guard ---------------------------- */

/**
 * An install can't be booked until the job has its property type and the
 * furniture answer. Measures always book. Returns the message to show, or null.
 */
export async function bookingBlock(taskId: number): Promise<string | null> {
  const [row] = await db
    .select({ task: schema.jobTasks, skillName: schema.skills.name, job: schema.jobs, propertyType: schema.sites.propertyType })
    .from(schema.jobTasks)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobTasks.jobId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .leftJoin(schema.skills, eq(schema.skills.id, schema.jobTasks.skillId))
    .where(eq(schema.jobTasks.id, taskId));
  if (!row) return null;
  return bookingBlockFor(row.job, row.propertyType, row.skillName ?? row.task.title);
}

export function bookingBlockFor(job: { siteId: number | null; furnitureMoving: boolean | null }, propertyType: string | null | undefined, skillOrTitle: string | null | undefined) {
  if (isMeasureSkill(skillOrTitle)) return null;
  const missing = missingAnswers(job, propertyType);
  return missing.length ? `Answer the ${missing.join(" and ")} on the job before booking the install.` : null;
}

/** The same check for a task that doesn't exist yet. */
export async function bookingBlockNew(jobId: number, skillId: number | null | undefined, title: string) {
  const [row] = await db
    .select({ job: schema.jobs, propertyType: schema.sites.propertyType })
    .from(schema.jobs)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobs.id, jobId));
  if (!row) return null;
  const [skill] = skillId ? await db.select({ name: schema.skills.name }).from(schema.skills).where(eq(schema.skills.id, skillId)) : [];
  return bookingBlockFor(row.job, row.propertyType, skill?.name ?? title);
}
