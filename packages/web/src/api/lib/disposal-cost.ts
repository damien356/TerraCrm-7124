import { and, asc, eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { INTERNAL_CHARGE } from "./line-kinds";
import { quoteRefById } from "./quote-number";

/* ---------------------------------------------------------------------------
 * Quote defaults (Damien, 6 Nov 2026). Terra's carpet disposal allowance
 * (kind internal_charge, lib/quote-defaults.ts) is a Terra cost: the shop
 * skip bin. It is not installer pay, not a material to order, and never a
 * PO, a supplier bill or anything in Xero. On accept its cost goes to Money
 * out as an Other cost at "budget", the same way delivery does
 * (lib/delivery-cost.ts), marked as an estimate so a real skip bin bill put
 * against the job later is told apart from it.
 *
 * Only rows still at "budget" are changed or removed by a later version.
 * ------------------------------------------------------------------------- */

export const DISPOSAL_COST_NOTE = "Estimated carpet disposal allowance, from the quote. Not a bill.";
const NO_COST_NOTE = "Estimated carpet disposal allowance, from the quote. The line has no cost, so add the amount. Not a bill.";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Line = { description: string; qty: number; unit?: string | null; unitCost: number | null };

const costOf = (l: Line) => (l.unitCost == null ? 0 : round2(l.unitCost * l.qty));
const noteOf = (l: Line) => (l.unitCost == null ? NO_COST_NOTE : DISPOSAL_COST_NOTE);
const m2Text = (l: Line) => `${Number(l.qty.toFixed(2))} ${l.unit === "m2" || !l.unit ? "m²" : l.unit}`;
const descOf = (l: Line, ref: string) => `Carpet disposal (estimate), ${ref}: ${m2Text(l)}`.slice(0, 300);
const isOurs = (notes: string) => notes === DISPOSAL_COST_NOTE || notes === NO_COST_NOTE;

export async function disposalLinesOf(quoteId: number) {
  return db
    .select()
    .from(schema.quoteItems)
    .where(and(eq(schema.quoteItems.quoteId, quoteId), eq(schema.quoteItems.kind, INTERNAL_CHARGE)))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
}

/** New Other costs for disposal lines, for example off an accepted variation. */
export async function addDisposalCosts(jobId: number, lines: Line[], ref: string) {
  if (!lines.length) return 0;
  await db.insert(schema.jobCosts).values(
    lines.map((l) => ({ jobId, kind: "other", description: descOf(l, ref), amount: costOf(l), state: "budget", notes: noteOf(l) })),
  );
  return lines.length;
}

/**
 * Make the job's disposal estimates match the quote's disposal lines. On
 * accept, and again when a later version replaces the quote. Returns what
 * the office needs to sort by hand.
 */
export async function syncDisposalCosts(jobId: number, quoteId: number) {
  const lines = await disposalLinesOf(quoteId);
  const ref = lines.length ? await quoteRefById(quoteId) : "";
  const rows = (
    await db
      .select()
      .from(schema.jobCosts)
      .where(and(eq(schema.jobCosts.jobId, jobId), eq(schema.jobCosts.kind, "other")))
      .orderBy(asc(schema.jobCosts.id))
  ).filter((r) => isOurs(r.notes));
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
        if (r.amount !== want.amount) flags.push(`Disposal cost "${r.description}" is ${r.state} at $${r.amount.toFixed(2)}. The new quote has $${want.amount.toFixed(2)}. Not changed.`);
        continue;
      }
      await db.update(schema.jobCosts).set({ ...want, updatedAt: now }).where(eq(schema.jobCosts.id, r.id));
      changed += 1;
    } else if (l) {
      await db.insert(schema.jobCosts).values({ jobId, kind: "other", description: descOf(l, ref), amount: costOf(l), state: "budget", notes: noteOf(l) });
      added += 1;
    } else if (r) {
      if (r.state !== "budget") {
        flags.push(`Disposal cost "${r.description}" is not on the new quote but is ${r.state}. Kept.`);
        continue;
      }
      await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, r.id));
      removed += 1;
    }
  }
  return { added, changed, removed, flags };
}
