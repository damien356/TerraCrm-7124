import { z } from "zod";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { jobNumberSql } from "../lib/job-ref";
import { ALERT_KIND_KEYS, ALERT_KINDS, NOTIFY_FROM, type AlertKind } from "../lib/notify-kinds";
import { buildDailySummary, dailySummaryText, lastSummarySend, notifySettings, saveNotifySettings, sendDailySummary } from "../lib/notify";
import { emailConfigured } from "../lib/email";

/* ---------------------------------------------------------------------------
 * Alerts to the office and the Notifications settings. Fix list 11 Oct, item 15.
 * See lib/notify.ts for how an alert is made.
 * ------------------------------------------------------------------------- */

/** Supplier cost detail. Office logins that cannot see costs never see these. */
const COST_KINDS: AlertKind[] = ["price_flag", "price_flag_big", "missing_invoice"];

const hiddenFor = (canSeeCosts: boolean) => (canSeeCosts ? [] : COST_KINDS);

export const alerts = {
  /** Alerts nobody has cleared yet, newest first. */
  open: staffOnly.handler(async ({ context }) => {
    const hide = hiddenFor(context.actor.canSeeCosts);
    const where = and(isNull(schema.alerts.readAt), hide.length ? notInArray(schema.alerts.kind, hide) : undefined);
    const [rows, [count]] = await Promise.all([
      db
        .select({
          id: schema.alerts.id,
          kind: schema.alerts.kind,
          title: schema.alerts.title,
          body: schema.alerts.body,
          jobId: schema.alerts.jobId,
          jobNumber: jobNumberSql,
          data: schema.alerts.data,
          emailedAt: schema.alerts.emailedAt,
          pushed: schema.alerts.pushed,
          createdAt: schema.alerts.createdAt,
        })
        .from(schema.alerts)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.alerts.jobId))
        .where(where)
        .orderBy(desc(schema.alerts.createdAt), desc(schema.alerts.id))
        .limit(40),
      db.select({ n: sql<number>`count(*)` }).from(schema.alerts).where(where),
    ]);
    return {
      total: Number(count?.n ?? 0),
      alerts: rows.map((r) => {
        let path: string | null = null;
        try {
          const d = JSON.parse(r.data) as { path?: unknown };
          if (typeof d.path === "string" && d.path.startsWith("/")) path = d.path;
        } catch {
          /* old or broken payload, fall back to the job */
        }
        const { data: _data, ...rest } = r;
        return { ...rest, label: ALERT_KINDS[r.kind as AlertKind]?.label ?? r.kind, path: path ?? (r.jobId ? `/jobs/${r.jobId}` : null) };
      }),
    };
  }),

  /** Clear one alert. */
  clear: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input, context }) => {
    const hide = hiddenFor(context.actor.canSeeCosts);
    const rows = await db
      .update(schema.alerts)
      .set({ readAt: new Date(), readByName: context.actor.name, updatedAt: new Date() })
      .where(and(eq(schema.alerts.id, input.id), isNull(schema.alerts.readAt), hide.length ? notInArray(schema.alerts.kind, hide) : undefined))
      .returning({ id: schema.alerts.id });
    return { cleared: rows.length };
  }),

  /** Clear every alert this login can see. */
  clearAll: staffOnly.handler(async ({ context }) => {
    const hide = hiddenFor(context.actor.canSeeCosts);
    const rows = await db
      .update(schema.alerts)
      .set({ readAt: new Date(), readByName: context.actor.name, updatedAt: new Date() })
      .where(and(isNull(schema.alerts.readAt), hide.length ? notInArray(schema.alerts.kind, hide) : undefined))
      .returning({ id: schema.alerts.id });
    return { cleared: rows.length };
  }),

  /** Settings, Notifications. */
  settings: adminOnly.handler(async () => {
    const s = await notifySettings();
    return {
      ...s,
      from: NOTIFY_FROM,
      emailReady: emailConfigured(),
      lastScheduled: await lastSummarySend(),
      kinds: ALERT_KIND_KEYS.map((k) => ({ key: k, label: ALERT_KINDS[k].label, group: ALERT_KINDS[k].group })),
    };
  }),

  saveSettings: adminOnly
    .input(
      z.object({
        emailTo: z.string().trim().email("That isn't an email address.").max(200),
        dailyOn: z.boolean(),
        urgent: z.array(z.string()).max(60),
        clientAutoSms: z.boolean(),
      }),
    )
    .handler(async ({ input }) => {
      const urgent = input.urgent.filter((k): k is AlertKind => k in ALERT_KINDS);
      await saveNotifySettings({ ...input, urgent });
      return notifySettings();
    }),

  /** What tomorrow's 7am email would say, right now. */
  previewSummary: adminOnly.handler(async () => ({ lines: dailySummaryText(await buildDailySummary()) })),

  /** Send the daily summary now, so Damien can see it land. */
  sendSummaryNow: adminOnly.handler(async () => {
    const out = await sendDailySummary();
    return { ok: out.ok, to: out.to, reason: out.ok ? "" : out.reason };
  }),
};
