import { z } from "zod";
import { adminOnly } from "../middleware/auth";
import { whoOf } from "../lib/trade-core";
import {
  addAgreement,
  agreementUrl,
  approveOffset,
  archiveAgreement,
  billSettlementView,
  billsForOffset,
  cancelOffset,
  confirmOffset,
  listAgreements,
  offsetFileUrl,
  openOffsets,
  proposeOffset,
  remittanceData,
  reverseOffset,
} from "../lib/trade-settle";
import { saleView } from "../lib/trade-sales";
import { sendRemittance } from "../lib/trade-send";
import { remittancePdf } from "../lib/tradePdf";

/* ---------------------------------------------------------------------------
 * Materials offsets against an installer's bill, agreements and remittances
 * (notes 18.65). Admin only, every procedure. Office never approves, confirms
 * or reverses an offset; it only sees the net to pay line on the bill.
 * ------------------------------------------------------------------------- */

const id = z.number().int().positive();
const file = z.object({
  filename: z.string().min(1).max(200),
  mime: z.string().max(100),
  // 8 MB of file is about 11 MB of base64. The lib checks the real size.
  base64: z.string().max(11_500_000),
});

export const tradeSettle = {
  /* ----------------------------- agreements ----------------------------- */
  agreements: adminOnly.input(z.object({ installerId: id })).handler(({ input }) => listAgreements(input.installerId)),
  addAgreement: adminOnly
    .input(
      z.object({
        installerId: id,
        title: z.string().max(200).default("Standing materials offset agreement"),
        signedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
        note: z.string().max(1000).default(""),
        file,
      }),
    )
    .handler(({ input, context }) => addAgreement(input, whoOf(context.actor))),
  archiveAgreement: adminOnly.input(z.object({ id })).handler(async ({ input, context }) => {
    await archiveAgreement(input.id, whoOf(context.actor));
    return { ok: true };
  }),
  agreementUrl: adminOnly.input(z.object({ id })).handler(({ input }) => agreementUrl(input.id)),

  /* ------------------------------- offsets ------------------------------ */
  openOffsets: adminOnly.handler(() => openOffsets()),
  billsForOffset: adminOnly.input(z.object({ saleId: id })).handler(({ input }) => billsForOffset(input.saleId)),
  propose: adminOnly.input(z.object({ saleId: id, billId: id, amount: z.number().finite() })).handler(async ({ input, context }) => {
    await proposeOffset(input, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  approve: adminOnly
    .input(z.object({ saleId: id, offsetId: id, agreementRef: z.string().max(200), agreementId: id.nullable().optional(), file: file.nullable().optional() }))
    .handler(async ({ input, context }) => {
      await approveOffset(input, whoOf(context.actor));
      return saleView(input.saleId);
    }),
  confirm: adminOnly
    .input(z.object({ saleId: id, offsetId: id, xeroRef: z.string().max(200), amount: z.number().finite().nullable().optional() }))
    .handler(async ({ input, context }) => {
      const out = await confirmOffset(input, whoOf(context.actor));
      return { ...out, sale: await saleView(input.saleId) };
    }),
  cancel: adminOnly.input(z.object({ saleId: id, offsetId: id, reason: z.string().min(1).max(500) })).handler(async ({ input, context }) => {
    await cancelOffset(input, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  reverse: adminOnly.input(z.object({ saleId: id, offsetId: id, amount: z.number().finite(), reason: z.string().min(1).max(500) })).handler(async ({ input, context }) => {
    await reverseOffset(input, whoOf(context.actor));
    return saleView(input.saleId);
  }),
  offsetFileUrl: adminOnly.input(z.object({ offsetId: id })).handler(({ input }) => offsetFileUrl(input.offsetId)),

  /* -------------------------------- bills ------------------------------- */
  bill: adminOnly.input(z.object({ billId: id })).handler(({ input }) => billSettlementView(input.billId)),
  remittance: adminOnly.input(z.object({ billId: id })).handler(({ input }) => remittanceData(input.billId)),
  remittancePdf: adminOnly.input(z.object({ billId: id })).handler(async ({ input }) => {
    const r = await remittancePdf(input.billId);
    return { filename: r.filename, base64: r.pdf.toString("base64") };
  }),
  sendRemittance: adminOnly.input(z.object({ billId: id, to: z.string().max(200).nullable().optional() })).handler(({ input, context }) => sendRemittance(input, whoOf(context.actor))),
};
