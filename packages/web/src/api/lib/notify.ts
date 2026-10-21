import { dayDate } from "./prep-templates";
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendEmail } from "./email";
import { localDate, localDayBounds, addLocalDays } from "./local-date";
import {
  ALERT_KINDS,
  CLIENT_AUTO_SMS_KEY,
  NOTIFY_DAILY_KEY,
  NOTIFY_DAILY_LAST_KEY,
  NOTIFY_DAILY_SENT_KEY,
  NOTIFY_EMAIL_TO_DEFAULT,
  NOTIFY_EMAIL_TO_KEY,
  NOTIFY_FROM,
  NOTIFY_SUBJECT_TAG,
  NOTIFY_URGENT_KEY,
  parseUrgent,
  type AlertKind,
} from "./notify-kinds";
import { pushToOffice } from "./push";
import { isLiveServer } from "./runtime";
import { feesWaiting } from "./referral-fees";
import { openAbnTasks } from "./abn-check";
import { crewBoard } from "./task-run";

/* ---------------------------------------------------------------------------
 * Telling the office something happened. Fix list 11 Oct, item 15.
 *
 * One way in: notifyOffice(kind, ...). It always
 *   1. writes an alert row, so it shows on the Dashboard even with no phone,
 *   2. pushes to every office phone (free),
 *   3. emails only when the kind is on the urgent list in Settings.
 * Nothing here ever sends a text. Every email goes from one fixed address with
 * a "[Terra Ops]" subject, so the mail agent can tell it is ours and skip it.
 *
 * On top of that, one summary email a day at 7am Gold Coast time: open tasks,
 * today's jobs and anything overdue. Same published-server-only gate as the
 * reminder timer, see lib/runtime.ts.
 *
 *   NOTIFY_DAILY=off   never send the summary
 *   NOTIFY_DAILY=on    tick regardless of the entry script
 * ------------------------------------------------------------------------- */

export const OPS_URL = (process.env.MAIL_OAUTH_BASE ?? "https://ops.terraflooring.com.au").replace(/\/+$/, "");

async function readSetting(key: string): Promise<string | null> {
  const [row] = await db.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key));
  return row?.value ?? null;
}

async function writeSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

export type NotifySettings = {
  emailTo: string;
  dailyOn: boolean;
  urgent: AlertKind[];
  clientAutoSms: boolean;
};

export async function notifySettings(): Promise<NotifySettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [NOTIFY_EMAIL_TO_KEY, NOTIFY_DAILY_KEY, NOTIFY_URGENT_KEY, CLIENT_AUTO_SMS_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  return {
    emailTo: (v.get(NOTIFY_EMAIL_TO_KEY) ?? "").trim() || NOTIFY_EMAIL_TO_DEFAULT,
    dailyOn: v.get(NOTIFY_DAILY_KEY) !== "0",
    urgent: parseUrgent(v.get(NOTIFY_URGENT_KEY)),
    clientAutoSms: v.get(CLIENT_AUTO_SMS_KEY) !== "0",
  };
}

export async function saveNotifySettings(s: NotifySettings) {
  await writeSetting(NOTIFY_EMAIL_TO_KEY, s.emailTo.trim());
  await writeSetting(NOTIFY_DAILY_KEY, s.dailyOn ? "1" : "0");
  await writeSetting(NOTIFY_URGENT_KEY, JSON.stringify(s.urgent.filter((k) => k in ALERT_KINDS)));
  await writeSetting(CLIENT_AUTO_SMS_KEY, s.clientAutoSms ? "1" : "0");
}

/** Client texts that go out on their own (journeys). Office and crew texts are not affected. */
export async function clientAutoSmsOn(): Promise<boolean> {
  return (await readSetting(CLIENT_AUTO_SMS_KEY)) !== "0";
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const tagged = (subject: string) => `${NOTIFY_SUBJECT_TAG} ${subject}`.slice(0, 200);

/** Every email to the office goes through here: fixed from, tagged subject. */
async function emailOffice(to: string, subject: string, lines: string[], url: string | null) {
  const text = [...lines, url ?? ""].filter(Boolean).join("\n\n");
  const html =
    lines.map((l) => `<p style="margin:0 0 12px;">${esc(l).replace(/\n/g, "<br>")}</p>`).join("") +
    (url ? `<p><a href="${esc(url)}">${esc(url)}</a></p>` : "");
  return sendEmail({ to, from: NOTIFY_FROM, replyTo: to, subject: tagged(subject), text, html });
}

export type NotifyMessage = {
  title: string;
  body: string;
  jobId?: number | null;
  /** Where the phone opens when the push is tapped. */
  data?: Record<string, unknown>;
  /** Page the email and the Dashboard link open, e.g. "/finance/suppliers-owed". The job page when left out. */
  path?: string;
  /** Email even when the kind is not on the urgent list. */
  forceEmail?: boolean;
};

/**
 * Tell the office. Never throws: a notification failing must not take down the
 * thing that triggered it. Returns what happened, for tests and logs.
 */
export async function notifyOffice(kind: AlertKind, msg: NotifyMessage) {
  const out = { alertId: null as number | null, pushed: 0, emailed: false };
  try {
    const jobId = msg.jobId ?? (typeof msg.data?.jobId === "number" ? (msg.data.jobId as number) : null);
    const data = { ...(msg.data ?? (jobId ? { kind: "job", jobId } : {})), ...(msg.path ? { path: msg.path } : {}) };
    const [row] = await db
      .insert(schema.alerts)
      .values({ kind, title: msg.title.slice(0, 300), body: msg.body.slice(0, 2000), jobId, data: JSON.stringify(data) })
      .returning({ id: schema.alerts.id });
    out.alertId = row?.id ?? null;

    out.pushed = await pushToOffice({ title: msg.title, body: msg.body, data: { ...data, alertId: out.alertId } });

    const s = await notifySettings();
    if (msg.forceEmail || s.urgent.includes(kind)) {
      const url = `${OPS_URL}${msg.path ?? (jobId ? `/jobs/${jobId}` : "/")}`;
      const sent = await emailOffice(s.emailTo, msg.title, [msg.body], url);
      out.emailed = sent.ok;
      if (!sent.ok) console.error(`[notify] ${kind} email not sent: ${sent.reason}`);
    }
    if (out.alertId) {
      await db
        .update(schema.alerts)
        .set({ pushed: out.pushed, emailedAt: out.emailed ? new Date() : null, updatedAt: new Date() })
        .where(eq(schema.alerts.id, out.alertId));
    }
  } catch (e) {
    console.error(`[notify] ${kind} failed:`, (e as Error).message ?? e);
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * The 7am summary
 * ------------------------------------------------------------------------- */

const SEND_FROM_HOUR = 7;
/** A server that was down at 7 still sends, but not once the morning is over. */
const SEND_UNTIL_HOUR = 12;

const auDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const shortDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Everything the summary says, as data. Exported for tests. */
export async function buildDailySummary(now = new Date()) {
  const today = localDate(now);
  const { start: dayStart } = localDayBounds(today);

  const [tasks, board, lateInvoices, recentAlerts] = await Promise.all([
    db
      .select({ id: schema.officeTasks.id, title: schema.officeTasks.title, dueDate: schema.officeTasks.dueDate, assignedName: schema.officeTasks.assignedName, jobId: schema.officeTasks.jobId })
      .from(schema.officeTasks)
      // Notes 18.47: Admin only tasks (referral fees) are one line of their own below, never listed.
      .where(and(eq(schema.officeTasks.status, "open"), eq(schema.officeTasks.adminOnly, false)))
      .orderBy(asc(sql`coalesce(${schema.officeTasks.dueDate}, '9999')`), asc(schema.officeTasks.id))
      .limit(60),
    // Same rule as the dashboard (lib/task-run.ts): working days on today's Brisbane date.
    crewBoard(today, { lateSince: addLocalDays(today, -60) }),
    db
      .select({ id: schema.invoices.id, number: schema.invoices.number, total: schema.invoices.total, amountPaid: schema.invoices.amountPaid, dueDate: schema.invoices.dueDate })
      .from(schema.invoices)
      .where(and(inArray(schema.invoices.status, ["sent", "part_paid", "overdue"]), lt(schema.invoices.dueDate, dayStart)))
      .orderBy(asc(schema.invoices.dueDate))
      .limit(20),
    db
      .select({ id: schema.alerts.id, title: schema.alerts.title })
      .from(schema.alerts)
      .where(and(isNull(schema.alerts.readAt), gte(schema.alerts.createdAt, new Date(now.getTime() - 86_400_000))))
      .orderBy(asc(schema.alerts.createdAt))
      .limit(30),
  ]);

  const todayJobs = board.todayTasks.map((t) => ({
    id: t.id,
    title: t.title,
    startTime: t.startTime,
    installerName: t.installerName,
    jobNumber: t.jobNumber,
    ref: t.ref,
    suburb: t.siteSuburb,
    dayLabel: t.dayLabel,
    dayCount: t.dayCount,
    scheduleIncomplete: t.scheduleIncomplete,
  }));
  const lateCrew = board.late.slice(0, 20).map((t) => ({ id: t.id, title: t.title, scheduledDate: t.lastDay, ref: t.ref, installerName: t.installerName }));
  const scheduleIncomplete = board.incomplete.slice(0, 20).map((t) => ({ id: t.id, title: t.title, ref: t.ref, installerName: t.installerName, reason: t.reason }));
  const overdueTasks = tasks.filter((t) => t.dueDate && t.dueDate < today);
  const otherTasks = tasks.filter((t) => !(t.dueDate && t.dueDate < today));
  const referralFees = await referralLine();
  const abnChecks = await abnLine();
  // Notes 18.56: client prep. Imported here, not at the top, because lib/prep imports this file.
  const prep = await (await import("./prep")).prepForSummary(now);
  return { today, overdueTasks, otherTasks, todayJobs, lateCrew, scheduleIncomplete, lateInvoices, recentAlerts, referralFees, prep, abnChecks };
}

/**
 * Notes 18.47: referral fees owed and not yet paid. The dollar amount only
 * goes in when every address the summary goes to is an Admin's, so Office
 * never reads it. Never throws: the summary always goes.
 */
async function referralLine() {
  try {
    const w = await feesWaiting();
    if (!w.count && !w.flagged) return null;
    return { ...w, showAmount: await everyRecipientAdmin() };
  } catch (e) {
    console.error("[notify] referral line failed:", (e as Error).message ?? e);
    return null;
  }
}

/** True only when every address the summary goes to is an Admin's. */
async function everyRecipientAdmin() {
  const to = (await notifySettings()).emailTo
    .split(/[,;\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const admins = to.length
    ? await db.select({ email: schema.profiles.email }).from(schema.profiles).where(and(eq(schema.profiles.role, "admin"), inArray(sql`lower(${schema.profiles.email})`, to)))
    : [];
  return to.length > 0 && to.every((x) => admins.some((a) => a.email.trim().toLowerCase() === x));
}

/**
 * Notes 18.64: open ABN check tasks, one line like the referral fees. The
 * names only go in when the summary goes to Admins only. Never throws.
 */
async function abnLine() {
  try {
    const open = await openAbnTasks();
    if (!open.length) return null;
    return { count: open.length, titles: (await everyRecipientAdmin()) ? open.map((t) => t.title) : [] };
  } catch (e) {
    console.error("[notify] ABN line failed:", (e as Error).message ?? e);
    return null;
  }
}

export function dailySummaryText(s: Awaited<ReturnType<typeof buildDailySummary>>) {
  const out: string[] = [];
  const overdueCount = s.overdueTasks.length + s.lateCrew.length + s.lateInvoices.length;
  out.push(`Good morning. ${auDay(s.today)}.`);
  out.push(
    `${s.todayJobs.length} job${s.todayJobs.length === 1 ? "" : "s"} on today. ` +
      `${s.overdueTasks.length + s.otherTasks.length} open task${s.overdueTasks.length + s.otherTasks.length === 1 ? "" : "s"}. ` +
      `${overdueCount} overdue.`,
  );

  out.push(
    "TODAY'S JOBS\n" +
      (s.todayJobs.length
        ? s.todayJobs
            .map(
              (j) =>
                `${j.startTime ? `${j.startTime} ` : ""}${j.ref ?? j.jobNumber}: ${j.title}${j.suburb ? `, ${j.suburb}` : ""}.` +
                `${j.scheduleIncomplete ? " Schedule incomplete." : j.dayCount && j.dayCount > 1 ? ` ${j.dayLabel}.` : ""} ${j.installerName ?? "Nobody on it yet"}`,
            )
            .join("\n")
        : "Nothing booked."),
  );

  const overdue: string[] = [
    ...s.overdueTasks.map((t) => `Task: ${t.title || "Follow up"} (due ${shortDay(t.dueDate!)}${t.assignedName ? `, ${t.assignedName}` : ""})`),
    ...s.lateCrew.map((t) => `Crew task not finished: ${t.ref ?? ""} ${t.title} (last day ${t.scheduledDate ? shortDay(t.scheduledDate) : "no date"}${t.installerName ? `, ${t.installerName}` : ""})`),
    ...s.lateInvoices.map(
      (i) => `Invoice ${i.number}: ${money(Math.max(0, i.total - i.amountPaid))} owing, due ${i.dueDate ? i.dueDate.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Brisbane" }) : "?"}`,
    ),
  ];
  out.push("OVERDUE\n" + (overdue.length ? overdue.join("\n") : "Nothing overdue."));

  if (s.scheduleIncomplete.length) {
    out.push(
      "SCHEDULE INCOMPLETE\n" +
        s.scheduleIncomplete.map((t) => `${t.ref ?? ""} ${t.title}${t.installerName ? `, ${t.installerName}` : ""}: ${t.reason} Book the days on the job.`).join("\n"),
    );
  }

  out.push(
    "OPEN TASKS\n" +
      (s.otherTasks.length
        ? s.otherTasks.map((t) => `${t.title || "Follow up"}${t.dueDate ? ` (due ${shortDay(t.dueDate)})` : ""}${t.assignedName ? `, ${t.assignedName}` : ""}`).join("\n")
        : "None."),
  );

  if (s.recentAlerts.length) {
    out.push("NOT CLEARED FROM THE LAST DAY\n" + s.recentAlerts.map((a) => a.title).join("\n"));
  }

  /* Notes 18.56: no one-tap Stop here, because mail scanners open links. Stop is on the job. */
  const p = s.prep;
  if (p?.sendingToday.length) {
    const kindWord = { install_email: "Install email", day_sms: "Day before text", omw_sms: "On my way text" } as const;
    out.push(
      "CLIENT PREP SENDING TODAY\n" +
        p.sendingToday.map((x) => `${x.ref}: ${kindWord[x.kind]} for ${dayDate(x.forDate)} to ${x.who}. ${OPS_URL}/jobs/${x.jobId}`).join("\n") +
        "\nTo stop one, open the job and press Stop in Client prep.",
    );
  }
  if (p?.needsAnswer.length) {
    out.push(
      "NEEDS PROPERTY TYPE / FURNITURE ANSWER\n" +
        p.needsAnswer.map((x) => `${x.ref}: install ${dayDate(x.firstDay)}, needs the ${x.missing.join(" and ")}. Prep messages held. ${OPS_URL}/jobs/${x.jobId}`).join("\n"),
    );
  }

  const r = s.referralFees;
  if (r && (r.count || r.flagged)) {
    const parts: string[] = [];
    if (r.count) parts.push(`Referral fees waiting to be paid: ${r.count}${r.showAmount ? `, ${money(r.total)} ex GST` : ""}.`);
    if (r.flagged) parts.push(`Referral fees for you to decide: ${r.flagged}.`);
    out.push("REFERRAL FEES\n" + parts.join("\n") + "\nFinance, Referrers owed.");
  }
  const a = s.abnChecks;
  if (a?.count) {
    out.push(
      "ABN CHECKS\n" +
        `Installer ABN changes for you to look at: ${a.count}.` +
        (a.titles.length ? `\n${a.titles.map((t) => t.replace(/^ABN check: /, "")).join("\n")}` : "") +
        "\nPeople, ABN checks.",
    );
  }
  return out;
}

/** How a summary went out: the 5 minute timer, the outside wake call, or Send it to me now. */
export type SummaryVia = "timer" | "wake" | "by_hand";
const VIA_WORDS: Record<SummaryVia, string> = { timer: "the 5 minute timer", wake: "the outside wake call", by_hand: "Send it to me now" };

/** Send the summary now. Exported so it can be sent by hand from Settings. */
export async function sendDailySummary(now = new Date(), via: SummaryVia = "by_hand") {
  const s = await notifySettings();
  const summary = await buildDailySummary(now);
  const lines = dailySummaryText(summary);
  const late = via === "by_hand" ? null : lateLine(now);
  if (late) lines.splice(1, 0, late);
  const sent = await emailOffice(s.emailTo, `Daily summary, ${shortDay(summary.today)}`, lines, `${OPS_URL}/`);
  await recordSummarySend(via, s.emailTo, sent);
  return { ...sent, to: s.emailTo };
}

/**
 * Write down every send and every failure, with the real time it happened,
 * so a backup of live shows when the 7am email actually left (21 Oct). The
 * Resend key can only send, so this is the only record Ops has. Never throws.
 */
async function recordSummarySend(via: SummaryVia, to: string, out: { ok: boolean; providerId?: string; reason?: string }) {
  try {
    const at = new Date();
    const clock = clockOf(at);
    // The scheduled send only. Send it to me now is logged below but never stands in for 7am.
    if (out.ok && via !== "by_hand") {
      const value = JSON.stringify({ at: at.toISOString(), day: localDate(at), via, to, providerId: out.providerId ?? "" });
      await db.insert(schema.settings).values({ key: NOTIFY_DAILY_LAST_KEY, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: at } });
    }
    await db.insert(schema.activityLog).values({
      entityType: "notify",
      action: out.ok ? "daily_summary_sent" : "daily_summary_failed",
      detail: out.ok
        ? `Daily summary sent to ${to} at ${clock}, by ${VIA_WORDS[via]}. Resend id ${out.providerId || "none"}.`
        : `Daily summary not sent at ${clock}, by ${VIA_WORDS[via]}: ${out.reason ?? "unknown reason"}.`,
      actorName: "Daily summary",
      actorRole: "system",
    });
  } catch (e) {
    console.error("[notify] could not record the summary send:", (e as Error).message ?? e);
  }
}

/** The last scheduled summary that went out, for Settings. Null before the first one. */
export async function lastSummarySend(): Promise<{ at: string; day: string; via: SummaryVia; to: string; providerId: string } | null> {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, NOTIFY_DAILY_LAST_KEY));
  try {
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

/** Minutes past midnight, Gold Coast time (UTC+10, no daylight saving). */
const gcMinutes = (now: Date) => {
  const t = new Date(now.getTime() + 10 * 3600_000);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
};

/**
 * Said at the top of the email when it goes after 7:15, so a late summary
 * explains itself instead of looking like the 7am one. Exported for tests.
 */
export function lateLine(now: Date): string | null {
  const m = gcMinutes(now);
  if (m < SEND_FROM_HOUR * 60 + 15) return null;
  // The time only. Why it was late is not known from here, so it never guesses (21 Oct).
  return `Sent late, at ${clockOf(now)} instead of 7am.`;
}

/** "7:03am", Gold Coast time. */
function clockOf(now: Date) {
  const m = gcMinutes(now);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h > 12 ? h - 12 : h === 0 ? 12 : h}:${mm}${h >= 12 ? "pm" : "am"}`;
}

let running = false;

/** One pass of the timer. Sends at most once per Gold Coast day. */
export async function tickDailySummary(now = new Date(), via: Exclude<SummaryVia, "by_hand"> = "timer") {
  if (running) return false;
  running = true;
  try {
    const hour = Number(new Date(now.getTime() + 10 * 3600_000).toISOString().slice(11, 13));
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return false;
    const s = await notifySettings();
    if (!s.dailyOn) return false;
    const today = localDate(now);
    // Claim the day first, so two servers or a slow send never mail twice.
    const claimed = await db
      .insert(schema.settings)
      .values({ key: NOTIFY_DAILY_SENT_KEY, value: today })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: today, updatedAt: new Date() },
        setWhere: ne(schema.settings.value, today),
      })
      .returning({ key: schema.settings.key });
    if (!claimed.length) return false;
    const out = await sendDailySummary(now, via);
    if (!out.ok) {
      console.error(`[notify] daily summary not sent: ${out.reason}`);
      // Give the day back so the next tick tries again, still only until noon.
      await db
        .update(schema.settings)
        .set({ value: "", updatedAt: new Date() })
        .where(and(eq(schema.settings.key, NOTIFY_DAILY_SENT_KEY), eq(schema.settings.value, today)));
    }
    return out.ok;
  } catch (e) {
    console.error("[notify] daily summary failed:", (e as Error).message ?? e);
    return false;
  } finally {
    running = false;
  }
}

let booted = false;
let ticking = false;
export const dailySummaryTicking = () => ticking;

/**
 * The outside wake call (cron-job.org at 6:58 and 7:05). Loading the URL wakes
 * a sleeping server; this then runs one pass of the timer straight away rather
 * than waiting up to 5 minutes for the next one. The pass itself still sends at
 * most once per day (the notify_daily_sent_on claim) and only 7am to noon, so
 * calling this any number of times never sends a second email.
 */
export async function wakeDailySummary(now = new Date()) {
  if (!ticking) return { ticking: false, sent: false };
  const sent = await tickDailySummary(now, "wake");
  return { ticking: true, sent };
}

export function bootDailySummary() {
  if (booted) return;
  booted = true;
  const mode = process.env.NOTIFY_DAILY;
  if (mode === "off") {
    console.log("[notify] daily summary disabled by NOTIFY_DAILY=off");
    return;
  }
  if (mode !== "on" && !isLiveServer()) {
    console.log("[notify] daily summary idle, not the published server");
    return;
  }
  ticking = true;
  console.log("[notify] daily summary checks every 5 minutes, sends at 7am");
  setInterval(() => void tickDailySummary(), 5 * 60_000);
  setTimeout(() => void tickDailySummary(), 30_000);
}
