import { and, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/*
 * When each client invoice was last emailed (Damien, 31 Oct, job 188054).
 *
 * The invoice row's status starts as "sent" the moment it is raised, which
 * only means "open, waiting on payment". It says nothing about email. The
 * only proof an invoice went out is the "invoice_emailed" activity row that
 * lib/invoice-email.ts writes after the email has actually gone. So email
 * status comes from here, payment status from the amounts, and Xero status
 * from xero_invoice_id. Three separate things.
 */
export async function emailedAtFor(invoiceIds: number[]): Promise<Map<number, Date>> {
  const out = new Map<number, Date>();
  const ids = [...new Set(invoiceIds.filter((i) => Number.isFinite(i)))];
  if (!ids.length) return out;
  for (let k = 0; k < ids.length; k += 500) {
    const rows = await db
      .select({ id: schema.activityLog.entityId, at: schema.activityLog.createdAt })
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "invoice"),
          eq(schema.activityLog.action, "invoice_emailed"),
          inArray(schema.activityLog.entityId, ids.slice(k, k + 500)),
        ),
      );
    for (const r of rows) {
      if (r.id == null || !r.at) continue;
      const prev = out.get(r.id);
      if (!prev || r.at > prev) out.set(r.id, r.at);
    }
  }
  return out;
}
