import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import dedent from "dedent";

/**
 * Reads one supplier PDF and says what is in it: invoices, credit notes, a
 * statement, or nothing Terra pays.
 *
 * Direct to OpenAI, not through the Runable gateway: the gateway rejects PDF
 * file parts (tested 2 Oct 2026, "invalid_union" on the file data), while
 * OpenAI reads the PDF itself, scanned pages included.
 *
 * Flat schema with nullable fields, because OpenAI structured output rejects
 * `oneOf`. `docType` says which fields apply.
 */

const lineSchema = z.object({
  description: z.string(),
  qty: z.number().nullable(),
  unit: z.string().nullable().describe("m2, lm, each, box, roll, as printed. Null if not shown."),
  unitPriceExGst: z.number().nullable(),
  totalExGst: z.number().nullable(),
});

const statementLineSchema = z.object({
  invoiceNumber: z.string().describe("The invoice or credit note number on this statement row."),
  date: z.string().nullable().describe("YYYY-MM-DD"),
  amountIncGst: z.number().nullable().describe("Original amount inc GST. Negative for credits and payments."),
  outstandingIncGst: z.number().nullable().describe("Still owing on this row, if the statement shows it."),
  isPayment: z.boolean().describe("True for a payment or receipt row rather than an invoice or credit."),
});

const docSchema = z.object({
  docType: z.enum(["invoice", "credit", "statement", "remittance", "quote_or_order", "other"]),
  supplierName: z.string().nullable().describe("The business that ISSUED the document, as printed."),
  supplierAbn: z.string().nullable(),
  billedTo: z.string().nullable().describe("Who the document is addressed or billed to."),
  invoiceNumber: z.string().nullable().describe("Invoice or credit note number. Invoice and credit only."),
  poReference: z
    .string()
    .nullable()
    .describe(
      "The customer's order reference: 'Your order', 'Customer PO', 'Order no', 'Cust ref', 'Your ref', 'Reference'. Exactly as printed. Not the supplier's own sales order number.",
    ),
  otherReferences: z
    .string()
    .nullable()
    .describe("Any job name, customer name or delivery address printed on it, comma separated."),
  invoiceDate: z.string().nullable().describe("YYYY-MM-DD"),
  dueDate: z.string().nullable().describe("YYYY-MM-DD"),
  goodsExGst: z.number().nullable().describe("Goods only, ex GST, before freight."),
  freightExGst: z.number().nullable().describe("Freight, delivery or cartage ex GST. 0 if printed as nil."),
  totalExGst: z.number().nullable(),
  gst: z.number().nullable(),
  totalIncGst: z.number().nullable().describe("Positive number, even on a credit note."),
  lines: z.array(lineSchema).describe("Invoice and credit only. Empty for anything else."),
  statementDate: z.string().nullable().describe("YYYY-MM-DD. Statement only."),
  statementBalanceIncGst: z.number().nullable().describe("Total owing on the statement. Statement only."),
  statementOverdueIncGst: z.number().nullable().describe("Overdue part, if shown. Statement only."),
  statementLines: z.array(statementLineSchema).describe("Statement only. Empty for anything else."),
});

export const supplierDocsSchema = z.object({
  documents: z.array(docSchema).describe("One entry per separate invoice, credit note or statement in the PDF."),
});

export type SupplierDoc = z.infer<typeof docSchema>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = (d: string | null) => (d && ISO.test(d) ? d : null);

export async function readSupplierPdf(pdf: Buffer, ctx: { filename: string; from: string; subject: string }) {
  const { object } = await generateObject({
    model: openai(process.env.SUPPLIER_DOC_MODEL ?? "gpt-5.4"),
    schema: supplierDocsSchema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: dedent`
              This PDF arrived in the accounts inbox of Terra Flooring (Arclan Pty Ltd), a
              flooring business on the Gold Coast. Pull out every supplier invoice, credit
              note and statement in it. A PDF can hold several.

              Rules:
              - Money is in dollars as plain numbers. Never guess a figure that is not printed.
              - Dates as YYYY-MM-DD. Australian dates are day first: 03/10/2026 is 2026-10-03.
              - Terra raises its orders with numbers like 4113-A (job number, dash, letter).
                Copy the customer order reference exactly as printed into poReference.
              - A document issued BY Terra Flooring or Arclan is "other".
              - Quotes, order confirmations and delivery dockets are "quote_or_order".
              - A remittance advice is "remittance".

              Email it came in: from ${ctx.from}, subject "${ctx.subject}", file ${ctx.filename}.
            `,
          },
          { type: "file", data: new Uint8Array(pdf), mediaType: "application/pdf", filename: ctx.filename },
        ],
      },
    ],
  });
  return object.documents.map((d) => ({
    ...d,
    invoiceDate: cleanDate(d.invoiceDate),
    dueDate: cleanDate(d.dueDate),
    statementDate: cleanDate(d.statementDate),
    statementLines: d.statementLines.map((l) => ({ ...l, date: cleanDate(l.date) })),
  }));
}
