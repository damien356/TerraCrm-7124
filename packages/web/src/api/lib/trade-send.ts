import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { sendAsTeam } from "./agent-mail";
import { TERRA_PRINT } from "./quotePdf";
import { auditRow, bad, type Who } from "./trade-core";
import { cardPaymentsOn } from "./stripe";
import { tradePayUrl } from "./trade-pay";
import { pdfMoney, remittancePdf, tradeCreditPdf, tradeInvoicePdf } from "./tradePdf";

/* ---------------------------------------------------------------------------
 * Sending trade documents (notes 18.65). Only when Admin presses Send. Goes
 * from team@ like every other client email, with the PDF attached. Nothing is
 * sent on finalise, on a credit or on a bill being paid.
 * ------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const SIGN_OFF = ["", "Any questions, just reply to this email or call me on 1300 183 772.", "", "Kind regards,", "Damien", "Terra Flooring"];

function pickTo(typed: string | null | undefined, onFile: string | null | undefined) {
  const to = (typed ?? "").trim() || (onFile ?? "").trim();
  if (!EMAIL_RE.test(to)) throw bad(to ? `"${to}" is not an email address.` : "No email address on file. Type one in.");
  return to;
}

export async function sendTradeInvoice(input: { saleId: number; to?: string | null }, who: Who) {
  const { pdf, filename, ref, owing, sale } = await tradeInvoicePdf(input.saleId);
  if (sale.status !== "finalised") throw bad("Only a finalised invoice can be sent.");
  const to = pickTo(input.to, sale.billEmail);
  const url = owing > 0.005 && cardPaymentsOn() ? tradePayUrl(sale.id) : null;
  const lines = [`Hi ${sale.billName || "there"},`, "", `Here is your Terra Flooring tax invoice ${ref}. Amount due ${pdfMoney(owing)} including GST.`, ""];
  if (owing > 0.005) {
    if (url) lines.push("Pay by card online:", url, "", "Or pay by bank transfer:");
    else lines.push("Please pay by bank transfer:");
    lines.push(`Account name: ${TERRA_PRINT.bank.name}`, `BSB: ${TERRA_PRINT.bank.bsb}`, `Account: ${TERRA_PRINT.bank.account}`, `Reference: ${ref}`);
  } else lines.push("Nothing is owing on this invoice. It is for your records.");
  const sent = await sendAsTeam({ to, subject: `Terra Flooring tax invoice ${ref}`, text: [...lines, ...SIGN_OFF].join("\n"), attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
  const now = new Date();
  await db.batch([
    db.update(schema.tradeSales).set({ sentAt: now, sentTo: to, updatedAt: now }).where(eq(schema.tradeSales.id, sale.id)),
    auditRow({ entityType: "sale", entityId: sale.id, saleId: sale.id, action: "invoice_sent", detail: `${ref} sent to ${to}${url ? " with the Pay by card link" : ""}`, who }),
  ]);
  return { to, via: sent.via, id: sent.id };
}

export async function sendTradeCredit(input: { creditId: number; to?: string | null }, who: Who) {
  const { pdf, filename, ref, credit, sale } = await tradeCreditPdf(input.creditId);
  const to = pickTo(input.to, sale.billEmail);
  const text = [`Hi ${sale.billName || "there"},`, "", `Here is credit note ${ref} for ${pdfMoney(credit.total)} including GST. It credits invoice S${sale.number}-1.`, ...SIGN_OFF].join("\n");
  const sent = await sendAsTeam({ to, subject: `Terra Flooring credit note ${ref}`, text, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
  const now = new Date();
  await db.batch([
    db.update(schema.tradeCreditNotes).set({ sentAt: now, sentTo: to, updatedAt: now }).where(eq(schema.tradeCreditNotes.id, credit.id)),
    auditRow({ entityType: "credit", entityId: credit.id, saleId: sale.id, action: "credit_sent", detail: `${ref} sent to ${to}`, who }),
  ]);
  return { to, via: sent.via, id: sent.id };
}

export async function sendRemittance(input: { billId: number; to?: string | null }, who: Who) {
  const { pdf, filename, data } = await remittancePdf(input.billId);
  const to = pickTo(input.to, data.email);
  const offs = data.offsets.map((o) => `Less materials invoice ${o.ref}: ${pdfMoney(o.amount)}`);
  const text = [
    `Hi ${data.payee || "there"},`,
    "",
    `Here is the remittance for your invoice ${data.invoiceNumber}.`,
    "",
    `Original invoice: ${pdfMoney(data.original)}`,
    ...offs,
    `Net to pay: ${pdfMoney(data.net)}`,
    `Paid: ${pdfMoney(data.cashTotal)}`,
    ...(data.remaining > 0.005 ? [`Still to pay: ${pdfMoney(data.remaining)}`] : []),
    ...SIGN_OFF,
  ].join("\n");
  const sent = await sendAsTeam({ to, subject: `Terra Flooring remittance for invoice ${data.invoiceNumber}`, text, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
  await auditRow({ entityType: "bill", entityId: data.billId, billId: data.billId, action: "remittance_sent", detail: `Remittance for ${data.invoiceNumber} sent to ${to}`, who });
  return { to, via: sent.via, id: sent.id };
}
