import { z } from "zod";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { putObject, signGet } from "../lib/s3";
import { jobText } from "../lib/refs";
import { recalcVariation } from "../lib/variations";
import { recalc } from "./quotes";
import {
  acceptedRates,
  blockReason,
  decideReferral,
  feeView,
  jobReferralFor,
  LOCKED_QUOTE,
  quoteSnapshot,
  r2,
  rateLabel,
  rateOf,
  referrerNames,
  STATUS_LABEL,
  sweepReferrals,
} from "../lib/referral-fees";

/* ---------------------------------------------------------------------------
 * REFERRAL FEES (notes 18.47). Everything here is Admin only except three
 * things Office needs to pick the referrer on a job: the list of names, the
 * name on a job, and setting it. Office never gets a rate, a fee or a bank
 * account back from any of them. The maths is in lib/referral-fees.ts.
 * ------------------------------------------------------------------------- */

const REFERRAL_SOURCE = "referral";
const isReferralSource = (source: string | null | undefined) => (source ?? "").trim().toLowerCase() === REFERRAL_SOURCE;

const cardKey = z
  .object({ companyId: z.number().int().positive().optional(), contactId: z.number().int().positive().optional() })
  .refine((k) => (k.companyId != null) !== (k.contactId != null), { message: "Pick a company or a person." });

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

async function referrerFor(key: { companyId?: number; contactId?: number }) {
  const where = key.companyId != null ? eq(schema.referrers.companyId, key.companyId) : eq(schema.referrers.contactId, key.contactId!);
  const [r] = await db.select().from(schema.referrers).where(where);
  return r ?? null;
}

/** Draft quotes and draft variations on the job pick up a new referrer or rate. Sent and accepted ones never move. */
async function recalcJob(jobId: number) {
  const qs = await db.select({ id: schema.quotes.id, status: schema.quotes.status, sentAt: schema.quotes.sentAt }).from(schema.quotes).where(eq(schema.quotes.jobId, jobId));
  let quotes = 0;
  for (const q of qs) {
    if (LOCKED_QUOTE.includes(q.status) || q.sentAt || q.status === "sent") continue;
    await recalc(q.id);
    quotes++;
  }
  const vs = await db.select({ id: schema.variations.id, status: schema.variations.status, sentAt: schema.variations.sentAt }).from(schema.variations).where(eq(schema.variations.jobId, jobId));
  let variations = 0;
  for (const v of vs) {
    if (v.status !== "draft" || v.sentAt) continue;
    await recalcVariation(v.id);
    variations++;
  }
  return { quotes, variations };
}

/** The quote the job's fee reads from: the accepted one, else the newest. */
async function headlineQuote(jobId: number) {
  const qs = await db
    .select({ id: schema.quotes.id, status: schema.quotes.status, version: schema.quotes.version })
    .from(schema.quotes)
    .where(eq(schema.quotes.jobId, jobId))
    .orderBy(desc(schema.quotes.version), desc(schema.quotes.id));
  return qs.find((q) => q.status === "accepted") ?? qs.find((q) => !["cancelled", "replaced", "declined", "expired"].includes(q.status)) ?? qs[0] ?? null;
}

/** Both sides of one referrer: what they paid Terra on their own jobs, and the fees owed or paid to them. */
async function twoSides(ref: typeof schema.referrers.$inferSelect) {
  const billed =
    ref.companyId != null
      ? sql`i.bill_to_company_id = ${ref.companyId}`
      : sql`(i.bill_to_contact_id = ${ref.contactId} and coalesce(i.bill_to_type, 'contact') <> 'company')`;
  const [paid] = await db.all<{ invoiced: number; paid: number }>(sql`
    select coalesce(sum(i.total), 0) as invoiced, coalesce(sum(i.amount_paid), 0) as paid
    from invoices i where ${billed} and i.status not in ('void', 'draft')
  `);
  const jobs = await db
    .select({ jr: schema.jobReferrals, job: schema.jobs, statusName: schema.jobStatuses.name })
    .from(schema.jobReferrals)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobReferrals.jobId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(eq(schema.jobReferrals.referrerId, ref.id))
    .orderBy(desc(schema.jobs.number));
  const sum = (st: string) => r2(jobs.filter((j) => j.jr.status === st).reduce((a, j) => a + j.jr.amount, 0));
  const worked = await acceptedRates(jobs.map((j) => j.job.id));
  return {
    theyPaid: { invoiced: r2(Number(paid?.invoiced ?? 0)), paid: r2(Number(paid?.paid ?? 0)) },
    fees: { owed: sum("owed"), paid: sum("paid"), flagged: jobs.filter((j) => j.jr.status === "flagged").length },
    referredValue: r2(jobs.filter((j) => (j.statusName ?? "").toLowerCase() !== "cancelled").reduce((a, j) => a + (j.job.value ?? 0), 0)),
    jobs: jobs.map((j) => ({
      jobId: j.job.id,
      ref: jobText(j.job),
      title: j.job.title,
      status: j.statusName ?? "",
      value: r2(j.job.value ?? 0),
      feeStatus: j.jr.status,
      feeStatusLabel: STATUS_LABEL[j.jr.status] ?? j.jr.status,
      amount: j.jr.amount,
      rate: worked.get(j.job.id) ?? rateLabel(rateOf(j.jr, ref)),
      paidOn: j.jr.paidOn,
    })),
  };
}

const cardFields = z.object({
  active: z.boolean(),
  ratePercent: z.number().min(0).max(100),
  abn: z.string().max(40).nullable().optional(),
  gstRegistered: z.boolean(),
  bankAccountName: z.string().max(120).nullable().optional(),
  bankBsb: z.string().max(20).nullable().optional(),
  bankAccountNumber: z.string().max(30).nullable().optional(),
  remittanceEmail: z.string().max(200).nullable().optional(),
});

/** One owed, flagged or paid fee, the way the Referrers owed page reads it. */
async function owedRow(
  r: { jr: typeof schema.jobReferrals.$inferSelect; job: typeof schema.jobs.$inferSelect; ref: typeof schema.referrers.$inferSelect; statusName: string | null },
  name: string,
  worked: string | undefined,
) {
  return {
    id: r.jr.id,
    jobId: r.job.id,
    jobRef: jobText(r.job),
    jobTitle: r.job.title,
    jobStatus: r.statusName ?? "",
    referrerId: r.ref.id,
    referrerName: name,
    companyId: r.ref.companyId,
    contactId: r.ref.contactId,
    status: r.jr.status,
    statusLabel: STATUS_LABEL[r.jr.status] ?? r.jr.status,
    amount: r.jr.amount,
    gstRegistered: r.ref.gstRegistered,
    /** What their invoice should come to. */
    expectedInvoice: r.ref.gstRegistered ? r2(r.jr.amount * 1.1) : r.jr.amount,
    /** The rate on the accepted quote, which the fee was worked out at. */
    rate: worked ?? rateLabel(rateOf(r.jr, r.ref)),
    flagReason: r.jr.flagReason,
    abn: r.ref.abn,
    bankAccountName: r.ref.bankAccountName,
    bankBsb: r.ref.bankBsb,
    bankAccountNumber: r.ref.bankAccountNumber,
    remittanceEmail: r.ref.remittanceEmail,
    invoiceName: r.jr.invoiceName,
    invoiceUrl: r.jr.invoiceKey ? await signGet(r.jr.invoiceKey) : null,
    invoiceAmount: r.jr.invoiceAmount,
    paidOn: r.jr.paidOn,
    paidByName: r.jr.paidByName,
    taskId: r.jr.taskId,
    updatedAt: r.jr.updatedAt,
  };
}

async function owedRows(where: SQL) {
  const rows = await db
    .select({ jr: schema.jobReferrals, job: schema.jobs, ref: schema.referrers, statusName: schema.jobStatuses.name })
    .from(schema.jobReferrals)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobReferrals.jobId))
    .innerJoin(schema.referrers, eq(schema.referrers.id, schema.jobReferrals.referrerId))
    .leftJoin(schema.jobStatuses, eq(schema.jobStatuses.id, schema.jobs.statusId))
    .where(where)
    .orderBy(desc(schema.jobReferrals.updatedAt));
  const names = await referrerNames(rows.map((r) => r.ref.id));
  const worked = await acceptedRates(rows.map((r) => r.job.id));
  return Promise.all(rows.map((r) => owedRow(r, names.get(r.ref.id) ?? "Referrer", worked.get(r.job.id))));
}

async function oneOwed(id: number) {
  const [row] = await owedRows(eq(schema.jobReferrals.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "That referral fee is gone." });
  return row;
}

export const referrals = {
  /* ------------------------------ the card ------------------------------- */

  /** The "Also a referrer" tick and its fields, plus both sides. Admin only. */
  card: adminOnly.input(cardKey).handler(async ({ input }) => {
    const ref = await referrerFor(input);
    if (!ref) return { referrer: null, sides: null };
    return { referrer: ref, sides: await twoSides(ref) };
  }),

  saveCard: adminOnly.input(z.object({ key: cardKey, fields: cardFields })).handler(async ({ input }) => {
    const f = input.fields;
    const email = clean(f.remittanceEmail);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("That remittance email doesn't look right.");
    const bsb = clean(f.bankBsb)?.replace(/[\s-]/g, "") ?? null;
    if (bsb && !/^\d{6}$/.test(bsb)) throw bad("A BSB is 6 numbers.");
    const acct = clean(f.bankAccountNumber)?.replace(/[\s-]/g, "") ?? null;
    if (acct && !/^\d{4,12}$/.test(acct)) throw bad("An account number is 4 to 12 numbers.");
    if (input.key.companyId != null) {
      const [co] = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, input.key.companyId));
      if (!co) throw new ORPCError("NOT_FOUND", { message: "That company is gone." });
    } else {
      const [ct] = await db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.id, input.key.contactId!));
      if (!ct) throw new ORPCError("NOT_FOUND", { message: "That client is gone." });
    }
    const values = {
      active: f.active,
      ratePercent: r2(f.ratePercent),
      abn: clean(f.abn),
      gstRegistered: f.gstRegistered,
      bankAccountName: clean(f.bankAccountName),
      bankBsb: bsb ? `${bsb.slice(0, 3)}-${bsb.slice(3)}` : null,
      bankAccountNumber: acct,
      remittanceEmail: email,
      updatedAt: new Date(),
    };
    const before = await referrerFor(input.key);
    let ref: typeof schema.referrers.$inferSelect | undefined;
    if (before) {
      [ref] = await db.update(schema.referrers).set(values).where(eq(schema.referrers.id, before.id)).returning();
    } else {
      [ref] = await db
        .insert(schema.referrers)
        .values({ ...values, companyId: input.key.companyId ?? null, contactId: input.key.contactId ?? null })
        .returning();
    }
    if (!ref) throw new Error("Could not save the referrer.");
    // A new default rate, or the tick taken off, moves the draft quotes on their open jobs.
    let recalced = 0;
    if (before && (before.ratePercent !== ref.ratePercent || before.active !== ref.active)) {
      const open = await db
        .select({ jobId: schema.jobReferrals.jobId })
        .from(schema.jobReferrals)
        .where(and(eq(schema.jobReferrals.referrerId, ref.id), eq(schema.jobReferrals.status, "open")));
      for (const o of open) recalced += (await recalcJob(o.jobId)).quotes;
    }
    return { referrer: ref, sides: await twoSides(ref), recalced };
  }),

  /* ------------------------------ on a job ------------------------------- */

  /** Names only, for the picker on a job. Office can read it. */
  pickList: staffOnly.handler(async () => {
    const rows = await db.select({ id: schema.referrers.id, companyId: schema.referrers.companyId }).from(schema.referrers).where(eq(schema.referrers.active, true));
    const names = await referrerNames(rows.map((r) => r.id));
    return rows
      .map((r) => ({ id: r.id, name: names.get(r.id) ?? "Referrer", kind: r.companyId != null ? ("company" as const) : ("person" as const) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }),

  /** The referrer on a job. Office gets the name. An Admin also gets the rate, the fee and why it is blocked. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => {
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const j = await jobReferralFor(job.id);
    const isReferral = isReferralSource(job.source);
    const base = {
      jobId: job.id,
      isReferralSource: isReferral,
      /** Shown when the source is Referral, or a referrer is already on the job. */
      show: isReferral || !!j,
      referrerId: j?.ref.id ?? null,
      name: j?.name ?? null,
      /** Office can change the referrer until the fee is owed. */
      locked: !!j && j.jr.status !== "open",
    };
    if (context.actor.role !== "admin") return { ...base, admin: null };
    let admin = null;
    if (j) {
      const q = await headlineQuote(job.id);
      const snap = q ? await quoteSnapshot(q.id) : null;
      const rate = rateOf(j.jr, j.ref);
      admin = {
        feeType: j.jr.feeType as "default" | "percent" | "fixed",
        feeValue: j.jr.feeValue,
        defaultRate: j.ref.ratePercent,
        rate: rateLabel(rate),
        blockedReason: blockReason(j.ref, j.name, job),
        quote: snap ? feeView(snap) : null,
        status: j.jr.status,
        statusLabel: STATUS_LABEL[j.jr.status] ?? j.jr.status,
        amount: j.jr.amount,
        flagReason: j.jr.flagReason,
        paidOn: j.jr.paidOn,
        /** "Referral fee: Fix A Tile, 5%, $500.00", from the quote that counts. */
        label: snap ? feeView(snap)!.label : `Referral fee: ${j.name}, ${rateLabel(rate)}, no quote yet`,
      };
    }
    return { ...base, admin };
  }),

  /**
   * Set or clear the referrer on a job. Office can pick who. Only an Admin can
   * change the rate for the job. Draft quotes and variations recalculate.
   */
  setForJob: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        referrerId: z.number().nullable(),
        feeType: z.enum(["default", "percent", "fixed"]).optional(),
        feeValue: z.number().min(0).max(1_000_000).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const admin = context.actor.role === "admin";
      if (!admin && (input.feeType !== undefined || input.feeValue !== undefined)) {
        throw new ORPCError("FORBIDDEN", { message: "Only an Admin can change the referral rate." });
      }
      const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      const [had] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.jobId, input.jobId));
      if (had && had.status !== "open") throw bad("The referral fee on this job is already settled, so the referrer can't change now.");
      if (input.feeType === "percent" && (input.feeValue ?? 0) > 100) throw bad("A rate can't be over 100%.");

      if (input.referrerId == null) {
        if (had) await db.delete(schema.jobReferrals).where(eq(schema.jobReferrals.id, had.id));
      } else {
        const [ref] = await db.select().from(schema.referrers).where(eq(schema.referrers.id, input.referrerId));
        if (!ref || !ref.active) throw bad("That referrer isn't ticked as a referrer any more.");
        const sameReferrer = had?.referrerId === ref.id;
        // A different referrer starts on their own card rate. An Admin can set the job's rate.
        const feeType = admin && input.feeType ? input.feeType : sameReferrer ? had!.feeType : "default";
        const feeValue = feeType === "default" ? null : admin && input.feeValue !== undefined ? input.feeValue : sameReferrer ? had!.feeValue : null;
        if (feeType !== "default" && feeValue == null) throw bad("Type the rate or the amount for this job.");
        if (had) {
          await db
            .update(schema.jobReferrals)
            .set({ referrerId: ref.id, feeType, feeValue, setByName: context.actor.name, updatedAt: new Date() })
            .where(eq(schema.jobReferrals.id, had.id));
        } else {
          await db.insert(schema.jobReferrals).values({ jobId: input.jobId, referrerId: ref.id, feeType, feeValue, setByName: context.actor.name });
        }
      }
      // Logged by name only: the job's activity is read by Office too.
      const name = input.referrerId != null ? ((await referrerNames([input.referrerId])).get(input.referrerId) ?? "Referrer") : null;
      if ((had?.referrerId ?? null) !== input.referrerId) {
        await db.insert(schema.activityLog).values({
          jobId: input.jobId,
          entityType: "job",
          entityId: input.jobId,
          action: "referrer_set",
          detail: name ? `Referrer set to ${name}` : "Referrer taken off",
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }
      const moved = await recalcJob(input.jobId);
      return { ok: true, ...moved };
    }),

  /* --------------------------- Referrers owed --------------------------- */

  /** Finance, Referrers owed. Looks at every open referral first, so a payment that came in another way still counts. */
  owed: adminOnly.handler(async () => {
    await sweepReferrals();
    const rows = await owedRows(inArray(schema.jobReferrals.status, ["owed", "flagged", "paid"]));
    const owed = rows.filter((r) => r.status === "owed");
    return {
      toPay: owed,
      toDecide: rows.filter((r) => r.status === "flagged"),
      paid: rows.filter((r) => r.status === "paid").sort((a, b) => (b.paidOn ?? "").localeCompare(a.paidOn ?? "")),
      totals: { toPay: r2(owed.reduce((a, r) => a + r.amount, 0)), count: owed.length },
    };
  }),

  attachInvoice: adminOnly
    .input(
      z.object({
        id: z.number(),
        filename: z.string().min(1).max(200),
        base64: z.string().min(10).max(28_000_000),
        amount: z.number().min(0).max(10_000_000).nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.id, input.id));
      if (!jr) throw new ORPCError("NOT_FOUND", { message: "That referral fee is gone." });
      const bytes = Buffer.from(input.base64, "base64");
      const pdf = bytes.subarray(0, 5).toString() === "%PDF-";
      const png = bytes[0] === 0x89 && bytes[1] === 0x50;
      const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!pdf && !png && !jpg) throw bad("Attach their invoice as a PDF or a photo.");
      const ext = pdf ? "pdf" : png ? "png" : "jpg";
      const type = pdf ? "application/pdf" : png ? "image/png" : "image/jpeg";
      const key = `referral-invoices/${jr.jobId}/${jr.id}-${Date.now()}.${ext}`;
      await putObject(key, bytes, type, input.filename);
      await db
        .update(schema.jobReferrals)
        .set({ invoiceKey: key, invoiceName: input.filename, invoiceAmount: input.amount ?? jr.invoiceAmount, updatedAt: new Date() })
        .where(eq(schema.jobReferrals.id, jr.id));
      return oneOwed(jr.id);
    }),

  /** Damien paid it. Closes the task. Nothing is sent to anyone. */
  markPaid: adminOnly
    .input(
      z.object({
        id: z.number(),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        invoiceAmount: z.number().min(0).max(10_000_000).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.id, input.id));
      if (!jr) throw new ORPCError("NOT_FOUND", { message: "That referral fee is gone." });
      if (jr.status !== "owed") throw bad(jr.status === "paid" ? "That one is already marked paid." : "Decide this one first. It isn't owed yet.");
      const now = new Date();
      await db
        .update(schema.jobReferrals)
        .set({
          status: "paid",
          paidOn: input.paidOn,
          paidByName: context.actor.name,
          invoiceAmount: input.invoiceAmount ?? jr.invoiceAmount,
          updatedAt: now,
        })
        .where(eq(schema.jobReferrals.id, jr.id));
      if (jr.taskId) {
        await db
          .update(schema.officeTasks)
          .set({ status: "done", completedAt: now, completedByName: context.actor.name, updatedAt: now })
          .where(and(eq(schema.officeTasks.id, jr.taskId), eq(schema.officeTasks.status, "open")));
      }
      return oneOwed(jr.id);
    }),

  /** Undo a Mark paid typed by mistake. Back to owed, the task opens again. */
  unmarkPaid: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.id, input.id));
    if (!jr || jr.status !== "paid") throw bad("That one isn't marked paid.");
    await db.update(schema.jobReferrals).set({ status: "owed", paidOn: null, paidByName: null, updatedAt: new Date() }).where(eq(schema.jobReferrals.id, jr.id));
    if (jr.taskId) {
      await db.update(schema.officeTasks).set({ status: "open", completedAt: null, completedByName: null, updatedAt: new Date() }).where(eq(schema.officeTasks.id, jr.taskId));
    }
    return oneOwed(jr.id);
  }),

  /** A flagged one: owed after all (at the fee worked out, or an amount Damien types), or no fee. */
  decide: adminOnly
    .input(z.object({ id: z.number(), decision: z.enum(["owe", "no_fee"]), amount: z.number().min(0).max(1_000_000).nullable().optional() }))
    .handler(async ({ input, context }) => {
      const [jr] = await db.select().from(schema.jobReferrals).where(eq(schema.jobReferrals.id, input.id));
      if (!jr) throw new ORPCError("NOT_FOUND", { message: "That referral fee is gone." });
      if (jr.status === "paid") throw bad("That one is already paid.");
      if (input.decision === "owe" && input.amount != null && !(input.amount > 0)) throw bad("Type the fee to pay, or choose No fee.");
      const row = await decideReferral(jr.id, input.decision, input.amount ?? null, context.actor.name);
      if (!row) throw new Error("Could not save that.");
      return oneOwed(jr.id);
    }),

  /* ------------------------- the Referral fees tab ------------------------ */

  /** For each referrer: jobs referred, their value, fees owed and fees paid. Optional date range on the job. */
  report: adminOnly
    .input(z.object({ from: z.string().nullable().optional(), to: z.string().nullable().optional() }).default({}))
    .handler(async ({ input }) => {
      await sweepReferrals();
      const from = input.from ? Math.floor(new Date(`${input.from}T00:00:00+10:00`).getTime() / 1000) : null;
      const to = input.to ? Math.floor(new Date(`${input.to}T23:59:59+10:00`).getTime() / 1000) : null;
      const rows = await db.all<{
        id: number;
        company_id: number | null;
        contact_id: number | null;
        active: number;
        rate_percent: number;
        jobs: number;
        value: number;
        owed: number;
        paid: number;
        flagged: number;
      }>(sql`
        select r.id, r.company_id, r.contact_id, r.active, r.rate_percent,
          count(j.id) as jobs,
          coalesce(sum(case when lower(coalesce(s.name, '')) <> 'cancelled' then j.value else 0 end), 0) as value,
          coalesce(sum(case when jr.status = 'owed' then jr.amount else 0 end), 0) as owed,
          coalesce(sum(case when jr.status = 'paid' then jr.amount else 0 end), 0) as paid,
          coalesce(sum(case when jr.status = 'flagged' then 1 else 0 end), 0) as flagged
        from referrers r
        left join (
          select jr0.* from job_referrals jr0
          join jobs j0 on j0.id = jr0.job_id
          where 1 = 1
            ${from != null ? sql`and j0.created_at >= ${from}` : sql``}
            ${to != null ? sql`and j0.created_at <= ${to}` : sql``}
        ) jr on jr.referrer_id = r.id
        left join jobs j on j.id = jr.job_id
        left join job_statuses s on s.id = j.status_id
        group by r.id
      `);
      const names = await referrerNames(rows.map((r) => r.id));
      const out = rows
        .map((r) => ({
          id: r.id,
          name: names.get(r.id) ?? "Referrer",
          companyId: r.company_id,
          contactId: r.contact_id,
          active: !!r.active,
          rate: `${Number(Number(r.rate_percent).toFixed(2))}%`,
          jobs: Number(r.jobs),
          value: r2(Number(r.value)),
          owed: r2(Number(r.owed)),
          paid: r2(Number(r.paid)),
          flagged: Number(r.flagged),
        }))
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
      return {
        rows: out,
        totals: {
          jobs: out.reduce((a, r) => a + r.jobs, 0),
          value: r2(out.reduce((a, r) => a + r.value, 0)),
          owed: r2(out.reduce((a, r) => a + r.owed, 0)),
          paid: r2(out.reduce((a, r) => a + r.paid, 0)),
        },
        note: "Fees are ex GST.",
      };
    }),
};
