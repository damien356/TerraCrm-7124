import { inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Hourly invoices by dates, as seen by the older task-based readers (Damien,
 * 13 Nov 2026). A period invoice is stored on its first entry's task so the
 * invoice row stays complete, but it is not "the invoice for that task": it
 * can bill many tasks and jobs. The task readers (task submit, the installer
 * board, staged jobs, job costing) use these to tell the two apart. Kept on
 * its own, with no other lib imports, so lib/hourly.ts can use it too.
 * ------------------------------------------------------------------------- */

/*
 * Until the database step has run, the new tables do not exist, and nothing
 * changes. Once seen, the tables are remembered; a miss is looked at again
 * after 30 s.
 */
let seen = false;
let lastMiss = 0;
export async function hourlyInvoicingReady(): Promise<boolean> {
  if (seen) return true;
  if (Date.now() - lastMiss < 30_000) return false;
  try {
    const rows = await db.all<{ n: number }>(
      sql`select count(*) as n from sqlite_master where type = 'table' and name in ('installer_invoice_details', 'installer_invoice_sessions', 'installer_invoice_payments')`,
    );
    seen = Number(rows[0]?.n ?? 0) === 3;
  } catch {
    seen = false;
  }
  if (!seen) lastMiss = Date.now();
  return seen;
}

/** Tests only: forget what was seen. */
export function resetHourlyInvoicingReady() {
  seen = false;
  lastMiss = 0;
}

/** Which of these invoices are hourly invoices by dates. */
export async function periodInvoiceIds(invoiceIds: number[]): Promise<Set<number>> {
  if (!invoiceIds.length || !(await hourlyInvoicingReady())) return new Set();
  const rows = await db
    .select({ id: schema.installerInvoiceDetails.invoiceId, kind: schema.installerInvoiceDetails.kind })
    .from(schema.installerInvoiceDetails)
    .where(inArray(schema.installerInvoiceDetails.invoiceId, [...new Set(invoiceIds)]));
  return new Set(rows.filter((r) => r.kind === "period").map((r) => r.id));
}

/** Leave out invoices by dates, for readers that mean "the invoice for this task". */
export async function taskInvoicesOnly<T extends { id: number }>(rows: T[]): Promise<T[]> {
  const period = await periodInvoiceIds(rows.map((r) => r.id));
  return period.size ? rows.filter((r) => !period.has(r.id)) : rows;
}

/** The billed time entries on these tasks, one row each (from invoices by dates). */
export async function linksForTasks(taskIds: number[]) {
  if (!taskIds.length || !(await hourlyInvoicingReady())) return [] as Array<typeof schema.installerInvoiceSessions.$inferSelect>;
  return db.select().from(schema.installerInvoiceSessions).where(inArray(schema.installerInvoiceSessions.taskId, [...new Set(taskIds)]));
}
