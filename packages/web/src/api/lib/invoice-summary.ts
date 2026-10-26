import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { INVOICE_KINDS } from "./client-invoices";
import { quoteRefOf } from "./quote-number";
import { acceptedQuoteFor, COUNTED_STATUSES } from "./variations";

/* ---------------------------------------------------------------------------
 * The billing summary on a client invoice (Damien, 26 Oct). One calculation:
 *
 *   contract   the job's accepted quote (newest version) plus its approved
 *              variations. The same rule lib/job-value.ts uses for the job's
 *              value, so the two must agree.
 *   invoiced   every other invoice on the job that has been issued: sent,
 *              part paid, paid or overdue. Void and draft ones are left out.
 *   remaining  contract less every issued invoice, this one included.
 *
 * "Previously invoiced" is invoices raised, never money received. Payments on
 * the job are not shown here at all.
 *
 * It is withheld, never drawn, when the figures do not hold together: the
 * job's value differs from quote plus variations, the invoices come to more
 * than the contract, a credit or an invoice type it cannot show, or the
 * invoice bills a quote version that is not the accepted one. The office is
 * told why (lib/invoice-email.ts).
 * ------------------------------------------------------------------------- */

export type SummaryLine = {
  kind: "quote" | "variation" | "contract" | "previous" | "since" | "this" | "remaining";
  label: string;
  amount: number;
};

export type BillingSummary =
  | { state: "shown"; lines: SummaryLine[]; contract: number; previous: number; since: number; thisInvoice: number; remaining: number }
  | { state: "hidden"; reason: string }
  | { state: "withheld"; reason: string };

/** Issued invoices. Void and draft never count. */
export const ISSUED_STATUSES = ["sent", "part_paid", "paid", "overdue"] as const;
const LEFT_OUT = new Set(["void", "draft"]);

type Inv = { id: number; number: string; seq: number; status: string; kind: string; label: string; total: number; quoteId: number | null };

export type SummaryInput = {
  invoice: Inv;
  /** The job's accepted quote, newest version. Null when it has none. */
  quote: { id: number; ref: string; total: number } | null;
  /** Approved variations on the job. */
  variations: { ref: string; description: string; total: number }[];
  jobValue: number;
  /** Every other invoice on the job, any status. */
  others: Inv[];
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const firstLine = (t: string) => {
  const l = (t.split(/\n/).find((x) => x.trim()) ?? "").trim();
  return l.length > 90 ? `${l.slice(0, 87).trimEnd()}...` : l;
};
const invLabel = (i: Inv) => `${i.number}${i.label ? `, ${i.label}` : ""}`;

/** The rule, on plain figures. */
export function summarise(input: SummaryInput): BillingSummary {
  const { invoice: inv, quote } = input;
  if (!quote) return { state: "hidden", reason: "The job has no accepted quote." };
  if (!inv.quoteId) return { state: "hidden", reason: "This invoice is not raised against a quote." };
  if (inv.quoteId !== quote.id) {
    return { state: "withheld", reason: `${inv.number} bills an earlier version of the quote. The accepted version is now ${quote.ref}.` };
  }
  const known = (i: Inv) => (INVOICE_KINDS as readonly string[]).includes(i.kind);
  if (!(ISSUED_STATUSES as readonly string[]).includes(inv.status) || !known(inv) || !(inv.total > 0)) {
    return { state: "withheld", reason: `${inv.number} is ${inv.status}, ${inv.kind}, ${money(inv.total)}. The summary only covers an issued invoice over $0.` };
  }
  const counted: Inv[] = [];
  for (const o of input.others) {
    if (LEFT_OUT.has(o.status)) continue;
    if (!(ISSUED_STATUSES as readonly string[]).includes(o.status)) {
      return { state: "withheld", reason: `${o.number} has the status "${o.status}", which the summary does not know how to count.` };
    }
    if (!(o.total > 0) || !known(o)) {
      return { state: "withheld", reason: `${o.number} is a credit or an adjustment (${o.kind}, ${money(o.total)}). The summary cannot show it yet.` };
    }
    counted.push(o);
  }
  const contract = r2(quote.total + input.variations.reduce((s, v) => s + v.total, 0));
  const jobValue = r2(input.jobValue);
  if (Math.abs(jobValue - contract) > 0.005) {
    return {
      state: "withheld",
      reason: `The job value is ${money(jobValue)}, but quote ${quote.ref} and its approved variations come to ${money(contract)}.`,
    };
  }
  const previous = counted.filter((o) => o.seq < inv.seq).sort((a, b) => a.seq - b.seq);
  const since = counted.filter((o) => o.seq > inv.seq).sort((a, b) => a.seq - b.seq);
  const sum = (xs: Inv[]) => r2(xs.reduce((s, x) => s + x.total, 0));
  const remaining = r2(contract - sum(previous) - sum(since) - inv.total);
  if (remaining < -0.005) {
    return {
      state: "withheld",
      reason: `Invoices on this job come to ${money(-remaining)} more than quote ${quote.ref} and its approved variations (${money(contract)}).`,
    };
  }
  if (!previous.length && !since.length && !input.variations.length && remaining <= 0.005) {
    return { state: "hidden", reason: "One invoice for the whole quote. The quote total says it all." };
  }
  const lines: SummaryLine[] = [{ kind: "quote", label: `Quote ${quote.ref}`, amount: r2(quote.total) }];
  for (const v of input.variations) {
    lines.push({ kind: "variation", label: `Approved variation ${v.ref}${firstLine(v.description) ? `: ${firstLine(v.description)}` : ""}`, amount: r2(v.total) });
  }
  if (input.variations.length) lines.push({ kind: "contract", label: "Quote and approved variations", amount: contract });
  for (const p of previous) lines.push({ kind: "previous", label: invLabel(p), amount: r2(p.total) });
  for (const s of since) lines.push({ kind: "since", label: invLabel(s), amount: r2(s.total) });
  lines.push({ kind: "this", label: `This invoice ${inv.number}`, amount: r2(inv.total) });
  lines.push({ kind: "remaining", label: "Remaining to invoice after this invoice", amount: Math.max(0, remaining) });
  return { state: "shown", lines, contract, previous: sum(previous), since: sum(since), thisInvoice: r2(inv.total), remaining: Math.max(0, remaining) };
}

/** The summary for an invoice, read from the job as it stands now. */
export async function billingSummaryFor(inv: typeof schema.invoices.$inferSelect): Promise<BillingSummary> {
  if (!inv.jobId) return { state: "hidden", reason: "This invoice is not on a job." };
  const [job] = await db.select({ value: schema.jobs.value }).from(schema.jobs).where(eq(schema.jobs.id, inv.jobId));
  if (!job) return { state: "hidden", reason: "The job is gone." };
  const [quote, variations, rows] = await Promise.all([
    acceptedQuoteFor(inv.jobId),
    db
      .select({ ref: schema.variations.ref, description: schema.variations.description, total: schema.variations.total })
      .from(schema.variations)
      .where(and(eq(schema.variations.jobId, inv.jobId), inArray(schema.variations.status, [...COUNTED_STATUSES])))
      .orderBy(asc(schema.variations.seq)),
    db.select().from(schema.invoices).where(eq(schema.invoices.jobId, inv.jobId)),
  ]);
  const shape = (i: typeof schema.invoices.$inferSelect): Inv => ({
    id: i.id,
    number: i.number,
    seq: i.seq,
    status: i.status,
    kind: i.kind,
    label: i.label,
    total: i.total,
    quoteId: i.quoteId,
  });
  return summarise({
    invoice: shape(inv),
    quote: quote ? { id: quote.id, ref: await quoteRefOf(quote), total: quote.total } : null,
    variations,
    jobValue: Number(job.value ?? 0),
    others: rows.filter((r) => r.id !== inv.id).map(shape),
  });
}
