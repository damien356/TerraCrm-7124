import { z } from "zod";
import { adminOnly } from "../middleware/auth";
import { tradeSettings, whoOf } from "../lib/trade-core";
import {
  buyerCard,
  createDraft,
  editDraft,
  finalise,
  lastPrices,
  listBuyers,
  listSales,
  saleView,
  saveBuyer,
  saveProductRule,
  saveSettings,
  tradeProducts,
  verifyEntity,
} from "../lib/trade-sales";
import {
  applyCredit,
  cancelSale,
  createCredit,
  fulfil,
  keepAsCredit,
  recordPayment,
  recordRefund,
  recordReturn,
  reversePayment,
  setArrangement,
  setFulfilmentMethod,
} from "../lib/trade-money";
import { movementsFor, postLedger, stockLevels, STOCK_KIND_LABEL } from "../lib/trade-stock";
import { tradeCashTotals, tradePayUrl } from "../lib/trade-pay";
import { sendTradeCredit, sendTradeInvoice } from "../lib/trade-send";
import { tradeCreditPdf, tradeInvoicePdf } from "../lib/tradePdf";

/* ---------------------------------------------------------------------------
 * Trade sales (notes 18.65). Admin only, every procedure. Office, Crew and the
 * public pay link never reach any of this: Office sees only the net to pay
 * line on a bill, from installerInvoices.adminList.
 *
 * The money rules live in lib/trade-*.ts. These are thin wrappers that check
 * the input and pass the actor along for the audit trail.
 * ------------------------------------------------------------------------- */

const id = z.number().int().positive();
const key = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "Reload and try again.");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");
const money = z.number().finite();
const kind = z.enum(["installer", "contact", "company"]);
const email = z.string().max(200).nullable().optional();

const draftChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), productId: id, qty: z.number().finite() }),
  z.object({
    op: z.literal("update"),
    lineId: id,
    qty: z.number().finite(),
    discountPct: z.number().finite().default(0),
    typedPrice: z.number().finite().nullable().default(null),
    typedReason: z.string().max(300).nullable().default(null),
  }),
  z.object({ op: z.literal("remove"), lineId: id }),
  z.object({ op: z.literal("delivery"), lineId: id.optional(), description: z.string().max(200), amountExGst: money }),
  z.object({ op: z.literal("settle"), settleBy: z.enum(["pay", "deduct"]) }),
  z.object({ op: z.literal("notes"), notes: z.string().max(2000) }),
]);

const pdfOut = (r: { pdf: Buffer; filename: string }) => ({ filename: r.filename, base64: r.pdf.toString("base64") });

export const trade = {
  /* ------------------------------ settings ------------------------------ */
  settings: adminOnly.handler(() => tradeSettings()),
  saveSettings: adminOnly
    .input(
      z.object({
        enabled: z.boolean().optional(),
        markupPct: z.number().finite().optional(),
        categories: z.array(z.string().max(80)).max(100).optional(),
        supplierIds: z.array(z.number().int()).max(500).optional(),
        nextNumber: z.number().int().optional(),
      }),
    )
    .handler(({ input, context }) => saveSettings(input, whoOf(context.actor))),

  /* ------------------------------ products ------------------------------ */
  products: adminOnly
    .input(z.object({ search: z.string().max(100).optional(), listedOnly: z.boolean().optional(), buyerId: id.optional(), limit: z.number().int().min(1).max(1000).optional() }).default({}))
    .handler(({ input }) => tradeProducts(input)),
  saveProductRule: adminOnly
    .input(
      z.object({
        productId: id,
        mode: z.enum(["auto", "include", "exclude"]),
        priceOverride: z.number().finite().nullable(),
        gstConfirmed: z.boolean(),
        unitLabel: z.string().max(80).default(""),
        feesIncluded: z.boolean().default(false),
      }),
    )
    .handler(async ({ input, context }) => {
      await saveProductRule(input, whoOf(context.actor));
      return { ok: true };
    }),
  lastPrices: adminOnly.input(z.object({ productId: id, buyerId: id.nullable().optional() })).handler(({ input }) => lastPrices(input.productId, input.buyerId ?? null)),

  /* ------------------------------- buyers ------------------------------- */
  buyers: adminOnly.handler(() => listBuyers()),
  buyerCard: adminOnly.input(z.object({ kind, refId: id })).handler(({ input }) => buyerCard(input.kind, input.refId)),
  saveBuyer: adminOnly
    .input(
      z.object({
        kind,
        refId: id,
        active: z.boolean(),
        categories: z.array(z.string().max(80)).max(100),
        creditApproved: z.boolean(),
        termsDays: z.number().int(),
        feePresentation: z.enum(["itemised", "combined"]),
        notes: z.string().max(2000).default(""),
      }),
    )
    .handler(({ input, context }) => saveBuyer(input, whoOf(context.actor))),
  verifyEntity: adminOnly.input(z.object({ buyerId: id })).handler(({ input, context }) => verifyEntity(input.buyerId, whoOf(context.actor))),

  /* -------------------------------- sales ------------------------------- */
  sales: adminOnly
    .input(z.object({ buyerId: id.optional(), status: z.enum(["draft", "finalised", "cancelled"]).optional(), limit: z.number().int().min(1).max(500).optional() }).default({}))
    .handler(({ input }) => listSales(input)),
  sale: adminOnly.input(z.object({ saleId: id })).handler(async ({ input }) => ({ ...(await saleView(input.saleId)), payUrl: tradePayUrl(input.saleId) })),
  createDraft: adminOnly
    .input(z.object({ buyerId: id, settleBy: z.enum(["pay", "deduct"]).default("pay"), notes: z.string().max(2000).optional() }))
    .handler(({ input, context }) => createDraft(input, whoOf(context.actor))),
  editDraft: adminOnly.input(z.object({ saleId: id, change: draftChange })).handler(async ({ input, context }) => {
    await editDraft(input.saleId, input.change, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  finalise: adminOnly.input(z.object({ saleId: id, rev: z.number().int() })).handler(async ({ input, context }) => {
    await finalise(input.saleId, input.rev, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  cancel: adminOnly.input(z.object({ saleId: id, reason: z.string().min(1).max(500) })).handler(async ({ input, context }) => {
    await cancelSale(input.saleId, input.reason, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  invoicePdf: adminOnly.input(z.object({ saleId: id })).handler(async ({ input }) => pdfOut(await tradeInvoicePdf(input.saleId))),
  send: adminOnly.input(z.object({ saleId: id, to: email })).handler(({ input, context }) => sendTradeInvoice(input, whoOf(context.actor))),

  /* -------------------------------- money ------------------------------- */
  recordPayment: adminOnly
    .input(z.object({ saleId: id, method: z.enum(["bank", "cash", "other"]), amount: money, paidDate: ymd, reference: z.string().max(200).default(""), key }))
    .handler(async ({ input, context }) => {
      await recordPayment(input, whoOf(context.actor));
      return saleView(input.saleId);
    }),
  recordRefund: adminOnly
    .input(z.object({ saleId: id, method: z.enum(["bank", "card", "cash", "other"]), amount: money, paidDate: ymd, reference: z.string().max(200).default(""), key }))
    .handler(async ({ input, context }) => {
      await recordRefund(input, whoOf(context.actor));
      return saleView(input.saleId);
    }),
  keepAsCredit: adminOnly.input(z.object({ saleId: id, note: z.string().max(500).default("") })).handler(async ({ input, context }) => {
    await keepAsCredit(input.saleId, input.note, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  applyCredit: adminOnly.input(z.object({ fromSaleId: id, toSaleId: id, amount: money, key })).handler(async ({ input, context }) => {
    await applyCredit(input, whoOf(context.actor));
    return saleView(input.fromSaleId);
  }),
  reversePayment: adminOnly.input(z.object({ saleId: id, paymentId: id, reason: z.string().min(1).max(500) })).handler(async ({ input, context }) => {
    await reversePayment(input, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  createCredit: adminOnly
    .input(z.object({ saleId: id, reason: z.string().min(1).max(500), lines: z.array(z.object({ saleLineId: id, qty: z.number().finite() })).min(1).max(200), key }))
    .handler(async ({ input, context }) => {
      await createCredit(input, whoOf(context.actor));
      return saleView(input.saleId);
    }),
  creditPdf: adminOnly.input(z.object({ creditId: id })).handler(async ({ input }) => pdfOut(await tradeCreditPdf(input.creditId))),
  sendCredit: adminOnly.input(z.object({ creditId: id, to: email })).handler(({ input, context }) => sendTradeCredit(input, whoOf(context.actor))),
  setArrangement: adminOnly.input(z.object({ saleId: id, note: z.string().min(1).max(500) })).handler(async ({ input, context }) => {
    await setArrangement(input.saleId, input.note, whoOf(context.actor));
    return saleView(input.saleId);
  }),

  /* ------------------------- fulfilment and returns ---------------------- */
  fulfil: adminOnly
    .input(z.object({ saleId: id, method: z.enum(["collected", "dispatched"]), overrideReason: z.string().max(500).nullable().optional() }))
    .handler(async ({ input, context }) => {
      const out = await fulfil(input, whoOf(context.actor));
      return { ...out, sale: await saleView(input.saleId) };
    }),
  setFulfilmentMethod: adminOnly.input(z.object({ saleId: id, method: z.enum(["collected", "dispatched"]) })).handler(async ({ input, context }) => {
    await setFulfilmentMethod(input.saleId, input.method, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  recordReturn: adminOnly
    .input(z.object({ saleId: id, saleLineId: id, qty: z.number().finite(), reason: z.string().min(1).max(500), key }))
    .handler(async ({ input, context }) => {
      await recordReturn(input, whoOf(context.actor));
      return saleView(input.saleId);
    }),

  /* -------------------------------- stock ------------------------------- */
  stock: adminOnly.input(z.object({ productIds: z.array(id).max(1000).default([]) }).default({ productIds: [] })).handler(async ({ input }) => ({
    levels: await stockLevels(input.productIds),
    kinds: STOCK_KIND_LABEL,
  })),
  movements: adminOnly.input(z.object({ productId: id, limit: z.number().int().min(1).max(1000).optional() })).handler(({ input }) => movementsFor(input.productId, input.limit)),
  postStock: adminOnly
    .input(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("opening"), productId: id, qty: z.number().finite(), note: z.string().max(500).optional() }),
        z.object({ kind: z.literal("received"), productId: id, qty: z.number().finite(), supplier: z.string().max(200), ref: z.string().max(200), date: ymd, note: z.string().max(500).optional() }),
        z.object({ kind: z.literal("job_used"), productId: id, qty: z.number().finite(), jobId: id, note: z.string().max(500).optional() }),
        z.object({ kind: z.literal("adjustment"), productId: id, qty: z.number().finite(), reason: z.string().max(500) }),
        z.object({ kind: z.literal("stocktake"), productId: id, counted: z.number().finite(), note: z.string().max(500).optional(), expectOnHand: z.number().finite() }),
        z.object({ kind: z.literal("reversal"), movementId: id, reason: z.string().min(1).max(500) }),
      ]),
    )
    .handler(async ({ input, context }) => {
      await postLedger(input, whoOf(context.actor));
      return { ok: true };
    }),

  /* ------------------------------ cash figure ---------------------------- */
  /** Admin cash in from trade sales, by method, plus offsets as non cash. */
  cashTotals: adminOnly.input(z.object({ from: ymd, to: ymd })).handler(({ input }) => tradeCashTotals(input.from, input.to)),
};
