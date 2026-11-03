import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { notifyOffice } from "../notify";
import type { AlertKind } from "../notify-kinds";

/**
 * Send a stock alert once. The key is fixed (e.g. "reserved:12"), so a retry,
 * a restart or a second payment never sends it twice. If the send did not
 * land, the row stays unsent and the 10 minute check tries again.
 */
export async function stockAlert(key: string, kind: AlertKind, msg: { orderId?: number | null; jobId?: number | null; title: string; body: string; path?: string }) {
  await db
    .insert(schema.stockAlerts)
    .values({ key, kind, orderId: msg.orderId ?? null, jobId: msg.jobId ?? null, title: msg.title.slice(0, 300), body: msg.body.slice(0, 2000) })
    .onConflictDoNothing();
  const [claimed] = await db
    .update(schema.stockAlerts)
    .set({ sentAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.stockAlerts.key, key), isNull(schema.stockAlerts.sentAt)))
    .returning();
  if (!claimed) return { sent: false, already: true };
  const out = await notifyOffice(kind, { title: claimed.title, body: claimed.body, jobId: claimed.jobId, path: msg.path });
  if (!out.alertId) {
    await db.update(schema.stockAlerts).set({ sentAt: null, updatedAt: new Date() }).where(eq(schema.stockAlerts.id, claimed.id));
    return { sent: false, already: false };
  }
  await db.update(schema.stockAlerts).set({ alertId: out.alertId, updatedAt: new Date() }).where(eq(schema.stockAlerts.id, claimed.id));
  return { sent: true, already: false };
}

/** Alerts made but not sent (a crash between the two). The timer sends them. */
export async function resendUnsent() {
  const rows = await db.select().from(schema.stockAlerts).where(isNull(schema.stockAlerts.sentAt));
  let sent = 0;
  for (const r of rows) {
    const out = await stockAlert(r.key, r.kind as AlertKind, { orderId: r.orderId, jobId: r.jobId, title: r.title, body: r.body });
    if (out.sent) sent += 1;
  }
  return sent;
}
