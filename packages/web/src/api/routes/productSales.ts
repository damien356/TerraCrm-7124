import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { deliveryStatus } from "../lib/delivery";
import { orderPlan, previewSale, raiseSale, saleOfJob, setStockAndOrder, syncSaleLines } from "../lib/product-sale";
import { quoteRefOf } from "../lib/quote-number";
import { emailedAtFor } from "../lib/invoice-emailed";
import { editPriceRecord, previewPriceRecordEdit, priceRecordState, type EditLineIn } from "../lib/price-record-edit";
import { jobText } from "../lib/refs";

/**
 * Quote states whose lines the sale follows on open. An accepted quote is
 * brought into line by the accept itself and by Order, both actions a person
 * takes, never by just opening the job. A replaced or declined quote is history.
 */
const SYNCED = new Set(["draft", "needs_review", "sent"]);

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

/* Edit price record (Damien, 11 Nov 2026, job 188083). See lib/price-record-edit.ts. */
const editLinesInput = z
  .array(
    z.object({
      quoteItemId: z.number().int().positive().nullish(),
      productId: z.number().int().positive().nullish(),
      description: z.string().max(300).default(""),
      qty: z.number().min(0).max(100_000),
      unit: z.string().trim().max(20).default("each"),
      unitPrice: z.number().min(0).max(1_000_000),
      unitCost: z.number().min(0).max(1_000_000).nullish(),
      fromStock: z.number().min(0).max(100_000).nullish(),
    }),
  )
  .min(1)
  .max(60);

/** A login that can not see costs never changes one: the line keeps its cost, a new line gets the price book cost. */
function editLinesFor(lines: z.infer<typeof editLinesInput>, canSeeCosts: boolean): EditLineIn[] {
  return lines.map((l) => {
    const { unitCost, ...rest } = l;
    return canSeeCosts && unitCost !== undefined ? { ...rest, unitCost } : rest;
  });
}

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
  const emailed = await emailedAtFor(invoices.map((i) => i.id));
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
      invoices: invs.map((i) => ({ id: i.id, number: i.number, total: r2(i.total), paid: r2(i.amountPaid), status: i.status, inXero: !!i.xeroInvoiceId, emailedAt: emailed.get(i.id) ?? null })),
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
  preview: staffOnly
    .input(saleInput.extend({ requestKey: z.string().max(80).nullish() }))
    // A2 (7D): only the main admin sees the approve control for a container or stock-only shortage.
    .handler(async ({ input, context }) => ({ ...(await previewSale(input, { canSeeCosts: context.actor.canSeeCosts })), canApproveShort: context.actor.isMainAdmin })),

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
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => {
    const sale = await saleOfJob(input.jobId);
    if (!sale) return null;
    const [quote] = sale.quoteId ? await db.select().from(schema.quotes).where(eq(schema.quotes.id, sale.quoteId)) : [];
    // 188065: before acceptance the order plan is the quote as it is now. A product changed in the quote builder shows straight away.
    if (quote && SYNCED.has(quote.status)) await syncSaleLines(sale.id, quote.id, context.actor);
    /*
     * Raise invoice now (Damien, 31 Oct, job 188054): raiseSale saves the
     * lines as a quote and marks it accepted so the invoice has something to
     * bill from. Nobody sent it and the customer never accepted it. Every
     * screen that shows that quote says so.
     */
    const internal = sale.mode === "invoice" && quote?.status === "accepted";
    const invs = internal
      ? await db
          .select({ number: schema.invoices.number })
          .from(schema.invoices)
          .where(and(eq(schema.invoices.jobId, input.jobId), ne(schema.invoices.status, "void")))
          .orderBy(schema.invoices.id)
      : [];
    return {
      saleId: sale.id,
      mode: sale.mode,
      salesCategory: sale.salesCategory,
      orderNeeded: sale.orderNeeded,
      quoteAccepted: quote?.status === "accepted",
      quoteId: sale.quoteId ?? null,
      quoteRef: quote ? await quoteRefOf(quote) : null,
      /** The quote is only the price record behind a direct invoice, not a customer acceptance. */
      internalPriceRecord: internal,
      invoiceNumber: invs[0]?.number ?? null,
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

  /** Edit price record: what the window opens with, and why it is locked when it is. Null when the job is not a product sale. */
  priceRecord: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input, context }) => priceRecordState(input.jobId, context.actor)),

  /** What Save would change. Writes nothing. */
  previewPriceRecordEdit: staffOnly
    .input(z.object({ jobId: z.number(), lines: editLinesInput }))
    .handler(async ({ input, context }) => previewPriceRecordEdit({ jobId: input.jobId, lines: editLinesFor(input.lines, context.actor.canSeeCosts), canSeeCosts: context.actor.canSeeCosts })),

  /** Changes the price record, the invoice (same number), the sale lines, materials and draft POs together. Nothing is emailed or sent. */
  editPriceRecord: staffOnly
    .input(z.object({ jobId: z.number(), lines: editLinesInput, stamp: z.string().max(20_000), expectedTotal: z.number(), note: z.string().max(300).nullish() }))
    .handler(async ({ input, context }) => {
      const out = await editPriceRecord({ ...input, lines: editLinesFor(input.lines, context.actor.canSeeCosts) }, context.actor);
      if (out.changed) await rebuild();
      return out;
    }),

  /* Care guides by hand moved to customerComms.guideDrafts / guideSend (31 Oct), with the recipient checks. */
};
