import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { quoteRefOf } from "./quote-number";

/**
 * Copy from previous job (16 Oct, notes 18.46). The links between a quote and
 * the quotes copied from it, read both ways. Read only: nothing here changes
 * a quote or a job.
 */

type QuoteRow = typeof schema.quotes.$inferSelect;

/** Same client: the same person, or the same company, on both quotes. */
export function sameClientOf(a: Pick<QuoteRow, "contactId" | "companyId">, b: Pick<QuoteRow, "contactId" | "companyId">) {
  if (a.companyId != null || b.companyId != null) return a.companyId != null && a.companyId === b.companyId;
  return a.contactId != null && a.contactId === b.contactId;
}

export type CopyLink = {
  id: number;
  ref: string;
  jobId: number | null;
  status: string;
  total: number;
  createdAt: Date;
  /** Follow-on for the same client, or a copy for another one. */
  sameClient: boolean;
};

async function linkOf(q: QuoteRow, other: QuoteRow): Promise<CopyLink> {
  return {
    id: q.id,
    ref: await quoteRefOf(q),
    jobId: q.jobId,
    status: q.status,
    total: q.total,
    createdAt: q.createdAt,
    sameClient: sameClientOf(q, other),
  };
}

/** Where this quote was copied from, and the copies made from any version of it. */
export async function copyLinksFor(quote: QuoteRow): Promise<{ from: CopyLink | null; copies: CopyLink[] }> {
  let from: CopyLink | null = null;
  if (quote.copiedFromQuoteId != null) {
    const [src] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.copiedFromQuoteId));
    if (src) from = await linkOf(src, quote);
  }
  const versions = await db.select({ id: schema.quotes.id }).from(schema.quotes).where(eq(schema.quotes.number, quote.number));
  const copies = await copiesOf(versions.map((v) => v.id), quote);
  return { from, copies };
}

/** Copies made from these quotes. Only the newest version of each copy. */
async function copiesOf(ids: number[], original: QuoteRow): Promise<CopyLink[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(schema.quotes)
    .where(inArray(schema.quotes.copiedFromQuoteId, ids))
    .orderBy(desc(schema.quotes.createdAt));
  const newest = new Map<number, QuoteRow>();
  for (const r of rows) {
    const cur = newest.get(r.number);
    if (!cur || r.version > cur.version) newest.set(r.number, r);
  }
  return Promise.all([...newest.values()].map((r) => linkOf(r, original)));
}

/** The job page: per quote on the job, where it came from and the copies made from it. */
export async function copyLinksForJob(jobId: number) {
  const onJob = await db.select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(desc(schema.quotes.version));
  if (!onJob.length) return { from: [] as CopyLink[], copies: [] as CopyLink[] };
  const from: CopyLink[] = [];
  const seen = new Set<number>();
  for (const q of onJob) {
    if (q.copiedFromQuoteId == null || seen.has(q.copiedFromQuoteId)) continue;
    seen.add(q.copiedFromQuoteId);
    const [src] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, q.copiedFromQuoteId));
    if (src) from.push(await linkOf(src, q));
  }
  const copies = await copiesOf(
    onJob.map((q) => q.id),
    onJob[0]!,
  );
  return { from, copies: copies.filter((c) => c.jobId !== jobId) };
}
