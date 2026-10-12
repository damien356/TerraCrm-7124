import { and, asc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { DELIVERY } from "./line-kinds";
import { quoteRefById } from "./quote-number";

/* ---------------------------------------------------------------------------
 * 188001 fix list item 11. A delivery line is not a material: it never goes
 * on Materials to order or a supplier PO. Its cost goes to Money out as an
 * Other cost, at the line's cost price (qty x unit cost, ex GST).
 *
 * The rows Terra makes carry DELIVERY_NOTE, so a later quote version can
 * find them again. Only rows still at "budget" are changed or removed. One
 * already committed, invoiced or paid is left alone and the office is told.
 * ------------------------------------------------------------------------- */

export const DELIVERY_NOTE = "From the delivery line on the quote.";
const NO_COST_NOTE = "From the delivery line on the quote. The line has no cost price, so add the amount.";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Line = { description: string; qty: number; unitCost: number | null };

const costOf = (l: Line) => (l.unitCost == null ? 0 : round2(l.unitCost * l.qty));
const noteOf = (l: Line) => (l.unitCost == null ? NO_COST_NOTE : DELIVERY_NOTE);
const descOf = (l: Line, ref: string) => `Delivery, ${ref}: ${l.description}`.slice(0, 300);
const isOurs = (notes: string) => notes === DELIVERY_NOTE || notes === NO_COST_NOTE;

export async function deliveryLinesOf(quoteId: number) {
  return db
    .select()
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.quoteId, quoteId), eq(schema.quoteItems.kind, DELIVERY)))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
}

/** New Other costs for delivery lines, for example off an accepted variation. */
export async function addDeliveryCosts(jobId: number, lines: Line[], ref: string) {
  if (!lines.length) return 0;
  await db.insert(schema.jobCosts).values(
    lines.map((l) => ({ jobId, kind: "other", description: descOf(l, ref), amount: costOf(l), state: "budget", notes: noteOf(l) })),
  );
  return lines.length;
}

/**
 * Make the job's delivery costs match the quote's delivery lines. Used when a
 * quote's work is made on accept, and again when a later version replaces it.
 * Returns what the office needs to sort by hand.
 */
export async function syncDeliveryCosts(jobId: number, quoteId: number) {
  const lines = await deliveryLinesOf(quoteId);
  const ref = lines.length ? await quoteRefById(quoteId) : "";
  const rows = (await db.select().from(schema.jobCosts).where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.kind, "other"))).orderBy(asc(schema.jobCosts.id))).filter(
    (r) => isOurs(r.notes),
  );
  const flags: string[] = [];
  const now = new Date();
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (let i = 0; i < Math.max(lines.length, rows.length); i++) {
    const l = lines[i];
    const r = rows[i];
    if (l && r) {
      const want = { description: descOf(l, ref), amount: costOf(l), notes: noteOf(l) };
      if (r.description === want.description && r.amount === want.amount && r.notes === want.notes) continue;
      if (r.state !== "budget") {
        if (r.amount !== want.amount) flags.push(`Delivery cost "${r.description}" is ${r.state} at $${r.amount.toFixed(2)}. The new quote has $${want.amount.toFixed(2)}. Not changed.`);
        continue;
      }
      await db.update(schema.jobCosts).set({ ...want, updatedAt: now }).where(eq(schema.jobCosts.id, r.id));
      changed += 1;
    } else if (l) {
      await db.insert(schema.jobCosts).values({ jobId, kind: "other", description: descOf(l, ref), amount: costOf(l), state: "budget", notes: noteOf(l) });
      added += 1;
    } else if (r) {
      if (r.state !== "budget") {
        flags.push(`Delivery cost "${r.description}" is not on the new quote but is ${r.state}. Kept.`);
        continue;
      }
      await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, r.id));
      removed += 1;
    }
  }
  return { added, changed, removed, flags };
}
