import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { jobText } from "./refs";

/* ---------------------------------------------------------------------------
 * REFERRAL FEES (notes 18.47).
 *
 * A builder or company sends Terra a client and asks for a cut. Damien's
 * rules, all of them Admin only except picking the referrer:
 *
 *  - The referrer card carries a default rate. A job can take a different %,
 *    a fixed $ amount, or 0.
 *  - The fee is on top, worked out on the quote ex GST before the fee:
 *    $10,000 at 5% is $500, so the client pays $10,500 plus GST. Terra's own
 *    lines and margin do not move. The fee is never a quote line. It sits in
 *    referral_snapshots and in the quote's subtotal, and the client copy
 *    spreads it over every line (lib/referral-fold.ts).
 *  - A draft quote follows the job's rate. A quote that has gone out keeps
 *    the rate it went out with, and an accepted one keeps its fee as it is.
 *    A new rate only lands on a re-quote.
 *  - Variations take the job's % too. A fixed fee is for the job, so it sits
 *    on the quote only.
 *  - No fee when the referrer is the bill-to, the client or the company on
 *    the job. The snapshot keeps the reason, in plain words.
 *  - Paid in full (every live invoice paid, a final among them, nothing
 *    owing) makes an Admin only task and a Referrers owed entry. Cancelled,
 *    or closed without being paid in full, is flagged for Damien. Nothing is
 *    paid, sent or taken off a bill automatically.
 * ------------------------------------------------------------------------- */

export type Referrer = typeof schema.referrers.$inferSelect;
export type JobReferral = typeof schema.jobReferrals.$inferSelect;
export type ReferralSnapshot = typeof schema.referralSnapshots.$inferSelect;
export type FeeRate = { feeType: "percent" | "fixed"; feeValue: number };

export const LOCKED_QUOTE = ["accepted", "declined", "expired", "replaced", "cancelled"];
const VARIATION_EDITABLE = ["draft", "sent"];
const VARIATION_COUNTED = ["approved", "invoiced"];
export const JOB_FEE_TYPES = ["default", "percent", "fixed"] as const;
export const REFERRAL_STATUSES = ["open", "owed", "flagged", "paid", "no_fee"] as const;
export const STATUS_LABEL: Record<string, string> = {
  open: "Not paid in full yet",
  owed: "Owed",
  flagged: "For you to decide",
  paid: "Paid",
  no_fee: "No fee",
};
const SYSTEM = "Terra Ops";

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "$500", "$512.50". The task title reads the way Damien wrote it. */
export const feeMoney = (n: number) => (Number.isInteger(r2(n)) ? `$${r2(n).toLocaleString("en-AU")}` : money(n));

export function rateLabel(r: { feeType: string; feeValue: number }) {
  if (r.feeType === "fixed") return `${feeMoney(r.feeValue)} fixed`;
  return `${Number(r.feeValue.toFixed(2))}%`;
}

/** The rate a job's referral uses: its own, or the card default. */
export function rateOf(jr: Pick<JobReferral, "feeType" | "feeValue">, ref: Pick<Referrer, "ratePercent">): FeeRate {
  if (jr.feeType === "fixed") return { feeType: "fixed", feeValue: Math.max(0, jr.feeValue ?? 0) };
  if (jr.feeType === "percent") return { feeType: "percent", feeValue: Math.max(0, jr.feeValue ?? 0) };
  return { feeType: "percent", feeValue: Math.max(0, ref.ratePercent ?? 0) };
}

/** The fee on a total ex GST before the fee. A fixed fee goes on the quote, never a variation. */
export function feeAmount(rate: FeeRate, base: number, on: "quote" | "variation") {
  if (!(base > 0)) return 0;
  if (rate.feeType === "fixed") return on === "quote" ? r2(rate.feeValue) : 0;
  return r2((base * rate.feeValue) / 100);
}

/** Names for referrer ids: the company name, or the person's name. */
export async function referrerNames(ids: number[]) {
  const out = new Map<number, string>();
  const list = [...new Set(ids)].filter((x) => Number.isFinite(x));
  if (!list.length) return out;
  const rows = await db
    .select({ id: schema.referrers.id, co: schema.companies.name, first: schema.contacts.firstName, last: schema.contacts.lastName })
    .from(schema.referrers)
    .leftJoin(schema.companies, eq(schema.companies.id, schema.referrers.companyId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.referrers.contactId))
    .where(inArray(schema.referrers.id, list));
  for (const r of rows) out.set(r.id, r.co ?? ([r.first, r.last].filter(Boolean).join(" ").trim() || "Referrer"));
  return out;
}

export async function referrerById(id: number) {
  const [r] = await db.select().from(schema.referrers).where(eq(schema.referrers.id, id));
  return r ?? null;
}

/** The referrer on a job, with their name. Null when there is none. */
export async function jobReferralFor(jobId: number) {
  const [row] = await db
    .select({ jr: schema.jobReferrals, ref: schema.referrers })
    .from(schema.jobReferrals)
    .innerJoin(schema.referrers, eq(schema.referrers.id, schema.jobReferrals.referrerId))
    .where(eq(schema.jobReferrals.jobId, jobId));
  if (!row) return null;
  const name = (await referrerNames([row.ref.id])).get(row.ref.id) ?? "Referrer";
  return { ...row, name };
}

type JobWho = Pick<typeof schema.jobs.$inferSelect, "contactId" | "companyId" | "billToType" | "billToContactId" | "billToCompanyId">;

/**
 * Why there is no fee: the referrer pays for this job, or is the client or
 * the company on it. Null when the fee stands.
 */
export function blockReason(ref: Pick<Referrer, "companyId" | "contactId">, name: string, job: JobWho | null, quote?: { contactId: number | null; companyId: number | null } | null) {
  const tail = "There is no referral fee on a job they are part of.";
  if (ref.companyId != null) {
    const billCo = job ? (job.billToCompanyId ?? (job.billToType === "company" ? job.companyId : null)) : null;
    if (billCo === ref.companyId) return `${name} is the bill-to on this job. ${tail}`;
    if (job?.companyId === ref.companyId || quote?.companyId === ref.companyId) return `${name} is the company on this job. ${tail}`;
  }
  if (ref.contactId != null) {
    const billPerson = job ? (job.billToContactId ?? (job.billToType !== "company" ? job.contactId : null)) : null;
    if (billPerson === ref.contactId) return `${name} is the bill-to on this job. ${tail}`;
    if (job?.contactId === ref.contactId || quote?.contactId === ref.contactId) return `${name} is the client on this job. ${tail}`;
  }
  return null;
}

async function jobWho(jobId: number | null) {
  if (!jobId) return null;
  const [j] = await db
    .select({
      contactId: schema.jobs.contactId,
      companyId: schema.jobs.companyId,
      billToType: schema.jobs.billToType,
      billToContactId: schema.jobs.billToContactId,
      billToCompanyId: schema.jobs.billToCompanyId,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId));
  return j ?? null;
}

async function writeSnapshot(key: { quoteId: number } | { variationId: number }, values: Omit<typeof schema.referralSnapshots.$inferInsert, "quoteId" | "variationId">) {
  const now = new Date();
  if ("quoteId" in key) {
    await db
      .insert(schema.referralSnapshots)
      .values({ ...values, quoteId: key.quoteId, updatedAt: now })
      .onConflictDoUpdate({ target: schema.referralSnapshots.quoteId, set: { ...values, updatedAt: now } });
  } else {
    await db
      .insert(schema.referralSnapshots)
      .values({ ...values, variationId: key.variationId, updatedAt: now })
      .onConflictDoUpdate({ target: schema.referralSnapshots.variationId, set: { ...values, updatedAt: now } });
  }
}

export async function quoteSnapshot(quoteId: number) {
  const [s] = await db.select().from(schema.referralSnapshots).where(eq(schema.referralSnapshots.quoteId, quoteId));
  return s ?? null;
}

export async function variationSnapshot(variationId: number) {
  const [s] = await db.select().from(schema.referralSnapshots).where(eq(schema.referralSnapshots.variationId, variationId));
  return s ?? null;
}

/** The fee in a quote's subtotal. 0 when there is none. */
export async function quoteFee(quoteId: number) {
  return (await quoteSnapshot(quoteId))?.amount ?? 0;
}

/**
 * Called by recalc() in routes/quotes.ts with the line sum ex GST. Writes the
 * snapshot and returns the fee to add on top. A locked quote is never touched.
 */
export async function feeOnQuoteRecalc(quote: Pick<typeof schema.quotes.$inferSelect, "id" | "status" | "sentAt" | "jobId" | "contactId" | "companyId">, base: number) {
  const snap = await quoteSnapshot(quote.id);
  if (LOCKED_QUOTE.includes(quote.status)) return snap?.amount ?? 0;
  const wentOut = quote.sentAt != null || quote.status === "sent";

  let src: { referrerId: number | null; name: string; rate: FeeRate; ref: Referrer | null } | null = null;
  if (!wentOut) {
    const j = quote.jobId ? await jobReferralFor(quote.jobId) : null;
    if (j && j.ref.active) src = { referrerId: j.ref.id, name: j.name, rate: rateOf(j.jr, j.ref), ref: j.ref };
  } else if (snap) {
    // It has gone out: the rate it went out with stays. Only the lines can move the fee.
    src = {
      referrerId: snap.referrerId,
      name: snap.name,
      rate: { feeType: snap.feeType === "fixed" ? "fixed" : "percent", feeValue: snap.feeValue },
      ref: snap.referrerId ? await referrerById(snap.referrerId) : null,
    };
  }
  if (!src) {
    if (snap && !wentOut) await db.delete(schema.referralSnapshots).where(eq(schema.referralSnapshots.id, snap.id));
    return 0;
  }
  const block = src.ref ? blockReason(src.ref, src.name, await jobWho(quote.jobId), quote) : null;
  const amount = block ? 0 : feeAmount(src.rate, r2(base), "quote");
  await writeSnapshot(
    { quoteId: quote.id },
    { referrerId: src.referrerId, name: src.name, feeType: src.rate.feeType, feeValue: src.rate.feeValue, base: r2(base), amount, blockedReason: block },
  );
  return amount;
}

/** The same for a variation, from recalcVariation() in lib/variations.ts. */
export async function feeOnVariationRecalc(v: { id: number; jobId: number; status: string; sentAt?: Date | null }, base: number) {
  const snap = await variationSnapshot(v.id);
  if (!VARIATION_EDITABLE.includes(v.status)) return snap?.amount ?? 0;
  const wentOut = v.sentAt != null || v.status === "sent";
  let src: { referrerId: number | null; name: string; rate: FeeRate; ref: Referrer | null } | null = null;
  if (!wentOut) {
    const j = await jobReferralFor(v.jobId);
    if (j && j.ref.active) src = { referrerId: j.ref.id, name: j.name, rate: rateOf(j.jr, j.ref), ref: j.ref };
  } else if (snap) {
    // Sent: the rate it went out with stays, the same as a quote.
    src = {
      referrerId: snap.referrerId,
      name: snap.name,
      rate: { feeType: snap.feeType === "fixed" ? "fixed" : "percent", feeValue: snap.feeValue },
      ref: snap.referrerId ? await referrerById(snap.referrerId) : null,
    };
  }
  if (!src) {
    if (snap && !wentOut) await db.delete(schema.referralSnapshots).where(eq(schema.referralSnapshots.id, snap.id));
    return 0;
  }
  const block = src.ref ? blockReason(src.ref, src.name, await jobWho(v.jobId)) : null;
  const amount = block ? 0 : feeAmount(src.rate, r2(base), "variation");
  await writeSnapshot(
    { variationId: v.id },
    { referrerId: src.referrerId, name: src.name, feeType: src.rate.feeType, feeValue: src.rate.feeValue, base: r2(base), amount, blockedReason: block },
  );
  return amount;
}

/** What an Admin reads on the quote or variation: "Referral fee: Fix A Tile, 5%, $500.00". Admin only. */
export function feeView(s: ReferralSnapshot | null) {
  if (!s) return null;
  const rate = rateLabel(s);
  return {
    name: s.name,
    rate,
    feeType: s.feeType,
    feeValue: s.feeValue,
    base: s.base,
    amount: s.amount,
    blockedReason: s.blockedReason,
    label: s.blockedReason ? `Referral fee: ${s.name}, blocked` : `Referral fee: ${s.name}, ${rate}, ${money(s.amount)}`,
  };
}

/* ------------------------------ paid in full ------------------------------ */

/** Every live invoice paid, a final among them, and nothing owing. */
export async function paidInFull(jobId: number) {
  const live = await db
    .select({ kind: schema.invoices.kind, status: schema.invoices.status, total: schema.invoices.total, amountPaid: schema.invoices.amountPaid })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, jobId), sql`${schema.invoices.status} not in ('void','draft')`));
  if (!live.length) return false;
  const owing = live.reduce((a, i) => a + Math.max(0, i.total - i.amountPaid), 0);
  return live.some((i) => i.kind === "final") && live.every((i) => i.status === "paid") && owing < 0.005;
}

/** The fee owed on a job: the accepted quote's plus each accepted variation's. */
export async function feeDueOn(jobId: number) {
  const quotes = await db
    .select({ id: schema.quotes.id, version: schema.quotes.version })
    .from(schema.quotes)
    .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
  const vars = await db
    .select({ id: schema.variations.id })
    .from(schema.variations)
    .where(and(eq(schema.variations.jobId, jobId), inArray(schema.variations.status, VARIATION_COUNTED)));
  const quoteSnap = quotes[0] ? await quoteSnapshot(quotes[0].id) : null;
  const varSnaps = vars.length
    ? await db.select().from(schema.referralSnapshots).where(inArray(schema.referralSnapshots.variationId, vars.map((v) => v.id)))
    : [];
  const amount = r2((quoteSnap?.amount ?? 0) + varSnaps.reduce((a, s) => a + s.amount, 0));
  const blocked = quoteSnap?.blockedReason ?? varSnaps.find((s) => s.blockedReason)?.blockedReason ?? null;
  return { amount, blocked, hasQuote: !!quotes[0] };
}

/**
 * The rate each job's fee was worked out at: the accepted quote's, which
 * never moves. Jobs with no accepted quote are left out (use the job's rate).
 */
export async function acceptedRates(jobIds: number[]) {
  const out = new Map<number, string>();
  const ids = [...new Set(jobIds)];
  if (!ids.length) return out;
  const rows = await db
    .select({ jobId: schema.quotes.jobId, version: schema.quotes.version, snap: schema.referralSnapshots })
    .from(schema.quotes)
    .innerJoin(schema.referralSnapshots, eq(schema.referralSnapshots.quoteId, schema.quotes.id))
    .where(and(inArray(schema.quotes.jobId, ids), eq(schema.quotes.status, "accepted")))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
  for (const r of rows) if (r.jobId != null && !out.has(r.jobId)) out.set(r.jobId, r.snap.blockedReason ? "blocked" : rateLabel(r.snap));
  return out;
}

async function jobFacts(jobId: number) {
  const [row] = await db
    .select({ job: schema.jobs, stage: schema.jobStatuses.stage, statusName: schema.jobStatuses.name })
    .from(schema.jobs)
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(eq(schema.jobs.id, jobId));
  return row ?? null;
}

/** Owed: the Admin only task and the Referrers owed entry. */
async function markOwed(jr: JobReferral, amount: number, byName: string) {
  const facts = await jobFacts(jr.jobId);
  if (!facts) return null;
  const ref = await referrerById(jr.referrerId);
  const name = (await referrerNames([jr.referrerId])).get(jr.referrerId) ?? "the referrer";
  const jobRef = jobText(facts.job);
  const gst = ref?.gstRegistered ? ` They are GST registered, so their invoice should be ${money(r2(amount * 1.1))} with GST.` : " They are not GST registered.";
  const title = `Pay ${name} ${feeMoney(amount)} referral fee for job ${jobRef}`;
  const detail = `Job ${jobRef} is paid in full. The referral fee is ${money(amount)} ex GST.${gst} Attach their invoice and mark it paid under Finance, Referrers owed.`;
  // Already owed with a task (a new amount typed in): that task is updated, never a second one.
  const [had] = jr.taskId ? await db.select({ id: schema.officeTasks.id }).from(schema.officeTasks).where(eq(schema.officeTasks.id, jr.taskId)) : [];
  const [task] = had
    ? await db
        .update(schema.officeTasks)
        .set({ title, detail, status: "open", completedAt: null, completedByName: null, updatedAt: new Date() })
        .where(eq(schema.officeTasks.id, had.id))
        .returning({ id: schema.officeTasks.id })
    : await db
        .insert(schema.officeTasks)
        .values({ jobId: jr.jobId, title, detail, createdByName: SYSTEM, adminOnly: true })
        .returning({ id: schema.officeTasks.id });
  const [row] = await db
    .update(schema.jobReferrals)
    .set({ status: "owed", amount, flagReason: null, taskId: task?.id ?? null, decidedByName: byName === SYSTEM ? null : byName, updatedAt: new Date() })
    .where(eq(schema.jobReferrals.id, jr.id))
    .returning();
  return row ?? null;
}

/**
 * Looks at one job's referral and moves it on when the job says so. Called
 * when an invoice is paid, when a job is cancelled, and by the sweep. Never
 * throws into the caller's work: a payment always stands.
 */
export async function checkReferral(jobId: number) {
  try {
    const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.jobId, jobId));
    if (!jr || jr.status !== "open") return jr ?? null;
    const facts = await jobFacts(jobId);
    if (!facts) return jr;
    const cancelled = (facts.statusName ?? "").trim().toLowerCase() === "cancelled";
    if (!cancelled && (await paidInFull(jobId))) {
      const due = await feeDueOn(jobId);
      if (due.amount > 0) return await markOwed(jr, due.amount, SYSTEM);
      const reason = due.blocked ?? (due.hasQuote ? "The fee on this job came to $0." : "There is no accepted quote in Terra Ops with a fee on it.");
      const [row] = await db
        .update(schema.jobReferrals)
        .set({ status: due.blocked ? "no_fee" : "flagged", amount: 0, flagReason: reason, updatedAt: new Date() })
        .where(eq(schema.jobReferrals.id, jr.id))
        .returning();
      return row ?? jr;
    }
    if (cancelled || facts.stage === "closed") {
      const due = await feeDueOn(jobId);
      const [row] = await db
        .update(schema.jobReferrals)
        .set({
          status: due.amount > 0 ? "flagged" : "no_fee",
          amount: due.amount,
          flagReason: cancelled ? "The job was cancelled. No fee is owed unless you decide otherwise." : "The job is closed but not paid in full. No fee is owed unless you decide otherwise.",
          updatedAt: new Date(),
        })
        .where(eq(schema.jobReferrals.id, jr.id))
        .returning();
      return row ?? jr;
    }
    return jr;
  } catch (e) {
    console.error("[referral] check failed:", (e as Error).message ?? e);
    return null;
  }
}

/** Every open referral looked at again. Run by the Referrers owed page and the 7am summary. */
export async function sweepReferrals() {
  const open = await db.select({ jobId: schema.jobReferrals.jobId }).from(schema.jobReferrals).where(eq(schema.jobReferrals.status, "open"));
  for (const o of open) await checkReferral(o.jobId);
}

/** Damien's call on a flagged one: the fee is owed after all, or there is none. */
export async function decideReferral(id: number, decision: "owe" | "no_fee", amount: number | null, byName: string) {
  const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.id, id));
  if (!jr) return null;
  if (decision === "owe") {
    const due = amount != null ? r2(amount) : (await feeDueOn(jr.jobId)).amount;
    return markOwed(jr, due, byName);
  }
  if (jr.taskId) {
    await db
      .update(schema.officeTasks)
      .set({ status: "done", completedAt: new Date(), completedByName: byName, updatedAt: new Date() })
      .where(and(eq(schema.officeTasks.id, jr.taskId), eq(schema.officeTasks.status, "open")));
  }
  const [row] = await db
    .update(schema.jobReferrals)
    .set({ status: "no_fee", decidedByName: byName, updatedAt: new Date() })
    .where(eq(schema.jobReferrals.id, id))
    .returning();
  return row ?? null;
}

/** A job that was cancelled: open turns flagged. A test clear takes the referral off unless it was paid. */
export async function referralOnCancel(jobId: number, clear: boolean) {
  if (clear) {
    const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.jobId, jobId));
    if (jr && jr.status !== "paid") {
      if (jr.taskId) await db.delete(schema.officeTasks).where(eq(schema.officeTasks.id, jr.taskId));
      await db.update(schema.jobReferrals).set({ status: "open", amount: 0, flagReason: null, taskId: null, updatedAt: new Date() }).where(eq(schema.jobReferrals.id, jr.id));
    }
    return;
  }
  await checkReferral(jobId);
}

/** For the 7am summary: fees owed and not yet marked paid. */
export async function feesWaiting() {
  await sweepReferrals();
  const rows = await db
    .select({ id: schema.jobReferrals.id, amount: schema.jobReferrals.amount })
    .from(schema.jobReferrals)
    .where(eq(schema.jobReferrals.status, "owed"));
  const flagged = await db.select({ id: schema.jobReferrals.id }).from(schema.jobReferrals).where(eq(schema.jobReferrals.status, "flagged"));
  return { count: rows.length, total: r2(rows.reduce((a, r) => a + r.amount, 0)), flagged: flagged.length };
}
