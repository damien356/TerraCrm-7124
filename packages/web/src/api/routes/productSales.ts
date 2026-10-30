import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { CARE_SIGNOFF, applyConditions, careBodyText } from "../lib/care-render";
import { CARE_TEMPLATES, CARE_TEMPLATE_MAP } from "../lib/care-templates";
import { rebuildForecast } from "../lib/cashflow";
import { deliveryStatus } from "../lib/delivery";
import { orderPlan, previewSale, raiseSale, saleOfJob, setStockAndOrder } from "../lib/product-sale";
import { quoteRefOf } from "../lib/quote-number";
import { jobText } from "../lib/refs";

/* ---------------------------------------------------------------------------
 * Sell products (Damien, 30 Oct). The form, the sales lists on installer,
 * contact and company pages, ordering on a sale, and the hand sent care guide
 * for supply only jobs. See lib/product-sale.ts for the rules.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after product sale failed:", e));

const buyerInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("installer"), installerId: z.number().int().positive() }),
  z.object({ kind: z.literal("contact"), contactId: z.number().int().positive() }),
  z.object({ kind: z.literal("company"), companyId: z.number().int().positive() }),
]);

const saleInput = z.object({
  buyer: buyerInput,
  mode: z.enum(["quote", "invoice"]),
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive().nullish(),
        description: z.string().max(300).default(""),
        qty: z.number().min(0).max(100_000),
        unit: z.string().trim().max(20).default("each"),
        unitPrice: z.number().min(0).max(1_000_000),
        fromStock: z.number().min(0).max(100_000).nullish(),
      }),
    )
    .min(1)
    .max(60),
  orderNeeded: z.boolean().default(false),
  depositPercent: z.number().min(0).max(100).nullish(),
  note: z.string().max(500).nullish(),
});

/** Care guides that read fine for a sale with no install. Seasonal ones are left out. */
const GUIDE_CODES = CARE_TEMPLATES.filter((t) => !/^H\d/.test(t.code)).map((t) => t.code);
const INSTALL_WORDS = /\b(install(ed|ing|er|ers|ation)?|we left|after we|our (crew|team|installers?))\b/i;

async function salesList(where: { installerId?: number; contactId?: number; companyId?: number }) {
  const cond = where.installerId
    ? eq(schema.productSales.installerId, where.installerId)
    : where.contactId
      ? eq(schema.productSales.contactId, where.contactId)
      : where.companyId
        ? eq(schema.productSales.companyId, where.companyId)
        : null;
  if (!cond) throw new ORPCError("BAD_REQUEST", { message: "Pick an installer, contact or company." });
  const sales = await db.select().from(schema.productSales).where(cond).orderBy(desc(schema.productSales.id)).limit(50);
  const jobIds = sales.map((s) => s.jobId).filter((x): x is number => x != null);
  const quoteIds = sales.map((s) => s.quoteId).filter((x): x is number => x != null);
  const [jobs, quotes, invoices] = await Promise.all([
    jobIds.length ? db.select().from(schema.jobs).where(inArray(schema.jobs.id, jobIds)) : [],
    quoteIds.length ? db.select().from(schema.quotes).where(inArray(schema.quotes.id, quoteIds)) : [],
    jobIds.length
      ? db
          .select()
          .from(schema.invoices)
          .where(and(inArray(schema.invoices.jobId, jobIds), ne(schema.invoices.status, "void")))
      : [],
  ]);
  const out = [];
  for (const s of sales) {
    const job = jobs.find((j) => j.id === s.jobId);
    const quote = quotes.find((q) => q.id === s.quoteId);
    const invs = invoices.filter((i) => i.jobId === s.jobId);
    const handover = job ? await deliveryStatus(job.id).catch(() => null) : null;
    out.push({
      saleId: s.id,
      createdAt: s.createdAt,
      createdBy: s.createdByName,
      mode: s.mode,
      salesCategory: s.salesCategory,
      orderNeeded: s.orderNeeded,
      jobId: job?.id ?? null,
      jobRef: job ? jobText(job) : null,
      quoteRef: quote ? await quoteRefOf(quote) : null,
      quoteStatus: quote?.status ?? null,
      total: r2(quote?.total ?? 0),
      invoices: invs.map((i) => ({ id: i.id, number: i.number, total: r2(i.total), paid: r2(i.amountPaid), status: i.status, inXero: !!i.xeroInvoiceId })),
      /** Handover is its own thing. Paid comes only from the invoices. */
      handover: handover
        ? {
            complete: !!handover.completedAt,
            outstanding: handover.outstanding,
            lines: handover.lines.length,
          }
        : null,
    });
  }
  return out;
}

export const productSales = {
  /** What Confirm will do. Writes nothing. */
  preview: staffOnly.input(saleInput).handler(async ({ input }) => previewSale(input)),

  /** Saves the quote, or raises the invoice. The same requestKey twice gives the first sale back. */
  raise: staffOnly
    .input(saleInput.extend({ requestKey: z.string().min(8).max(80), expectedTotal: z.number() }))
    .handler(async ({ input, context }) => {
      const out = await raiseSale(input, context.actor);
      if (!out.reused) await rebuild();
      return out;
    }),

  list: staffOnly
    .input(z.object({ installerId: z.number().optional(), contactId: z.number().optional(), companyId: z.number().optional() }))
    .handler(async ({ input }) => salesList(input)),

  /** The sale behind a job, with its order plan. Null when the job is not a product sale. */
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const sale = await saleOfJob(input.jobId);
    if (!sale) return null;
    const [quote] = sale.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, sale.quoteId)) : [];
    return {
      saleId: sale.id,
      mode: sale.mode,
      salesCategory: sale.salesCategory,
      orderNeeded: sale.orderNeeded,
      quoteAccepted: quote?.status === "accepted",
      plan: await orderPlan(sale.id),
    };
  }),

  /** Change "From stock now" and order the rest as draft POs. Nothing already on order is ordered again. */
  setStockAndOrder: staffOnly
    .input(z.object({ jobId: z.number(), fromStock: z.array(z.object({ lineId: z.number(), qty: z.number().min(0) })).max(60) }))
    .handler(async ({ input, context }) => {
      const out = await setStockAndOrder({ jobId: input.jobId, fromStock: input.fromStock, actor: context.actor });
      await rebuild();
      return out;
    }),

  /** The care guides that can be sent by hand. */
  careGuides: staffOnly.handler(async () =>
    GUIDE_CODES.map((c) => CARE_TEMPLATE_MAP.get(c)!).map((t) => ({ code: t.code, title: t.title, audience: t.audience })),
  ),

  /**
   * One care guide filled in for this job's client, ready to edit. Nothing
   * is sent here: the office reads it, changes it, then presses Send, which
   * goes through the job's conversation like any other email.
   */
  careGuideDraft: staffOnly.input(z.object({ jobId: z.number(), code: z.string() })).handler(async ({ input }) => {
    const t = CARE_TEMPLATE_MAP.get(input.code);
    if (!t || !GUIDE_CODES.includes(t.code)) throw new ORPCError("BAD_REQUEST", { message: "Pick a care guide from the list." });
    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
    if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
    const contactId = job.contactId ?? job.billToContactId ?? null;
    const [contact] = contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)) : [];
    const companyId = job.companyId ?? job.billToCompanyId ?? null;
    const [company] = !contact && companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)) : [];
    const first = contact?.firstName?.trim() || "there";
    const body = careBodyText(applyConditions(t.body, { fibre: "", pile: "" }).replaceAll("{{first_name}}", first));
    const text = `${body}\n\n${CARE_SIGNOFF.join("\n")}`;
    const flagged = text
      .split(/\n+/)
      .flatMap((p) => p.split(/(?<=[.!?])\s+/))
      .filter((s) => INSTALL_WORDS.test(s))
      .map((s) => s.trim())
      .slice(0, 8);
    return {
      code: t.code,
      subject: t.subject,
      body: text,
      /** Sentences that talk about an install. This sale had none, so change or remove them. */
      flagged,
      contactId: contact?.id ?? null,
      to: contact?.email?.trim() || company?.email?.trim() || null,
      toName: contact ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() : (company?.name ?? null),
      supplyOnly: (await deliveryStatus(job.id)).supplyOnly,
    };
  }),
};
