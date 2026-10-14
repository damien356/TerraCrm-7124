import { eq } from "drizzle-orm";
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "../database";
import * as schema from "../database/schema";
import { INVOICE_KIND_LABEL } from "./client-invoices";
import { TERRA_PRINT } from "./quotePdf";
import { cardPaymentsOn, owingOn, payUrl } from "./stripe";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";

/**
 * The client's tax invoice, as a PDF, sent with the invoice email (spec 15 Oct).
 * Same look as the quote: logo and business details, the number and amount
 * owing on the right, Bill To, the line, totals, then how to pay.
 *
 * Not lib/invoicePdf.ts: that one is the installer's invoice to Terra.
 */

export type ClientInvoicePdfInput = {
  number: string;
  date: string;
  dueDate: string | null;
  to: { name: string; company: string | null; address: string | null; email: string | null };
  siteAddress: string | null;
  jobRef: string;
  description: string;
  subtotal: number;
  gst: number;
  total: number;
  paid: number;
  owing: number;
  payUrl: string | null;
};

const W = 595.28;
const H = 841.89;
const M = 40;
const CW = W - M * 2;
const INK = rgb(0.12, 0.11, 0.1);
const MUTED = rgb(0.36, 0.34, 0.31);
const LABEL = rgb(0.54, 0.52, 0.49);
const RULE = rgb(0.87, 0.85, 0.82);
const FILL = rgb(0.965, 0.957, 0.945);
const GOLD = rgb(0.76, 0.58, 0.29);

/** WinAnsi only, and no long dashes. */
const clean = (s: string) =>
  s
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF\u2018\u2019\u201c\u201d\u2022\u2026]/g, "");

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const auDate = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;

function wrap(s: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(s).split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const text = (p: PDFPage, s: string, x: number, y: number, f: PDFFont, size: number, color = INK) =>
  p.drawText(clean(s), { x, y, size, font: f, color });
const textRight = (p: PDFPage, s: string, r: number, y: number, f: PDFFont, size: number, color = INK) => {
  const c = clean(s);
  p.drawText(c, { x: r - f.widthOfTextAtSize(c, size), y, size, font: f, color });
};

function link(doc: PDFDocument, page: PDFPage, x: number, y: number, w: number, h: number, url: string) {
  const ref = doc.context.register(
    doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(url) } }),
  );
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

export async function renderClientInvoicePdf(input: ClientInvoicePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Terra Flooring invoice ${input.number}`);
  doc.setAuthor("Terra Flooring");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(Buffer.from(TERRA_LOGO_PRINT_PNG_BASE64, "base64"));
  const page = doc.addPage([W, H]);

  /* Header: logo and business details left, title and amount owing right. */
  const logoH = 78;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: M, y: H - M - logoH, width: logoW, height: logoH });
  const dx = M + logoW + 16;
  let y = H - M - 10;
  text(page, TERRA_PRINT.legal, dx, y, bold, 9.5);
  for (const l of [TERRA_PRINT.address, `ABN ${TERRA_PRINT.abn}`, TERRA_PRINT.phones, TERRA_PRINT.email, TERRA_PRINT.website, TERRA_PRINT.qbcc]) {
    y -= 11.5;
    text(page, l, dx, y, reg, 8.5, MUTED);
  }
  const r = W - M;
  textRight(page, "Tax Invoice", r, H - M - 18, bold, 22);
  textRight(page, `No. ${input.number}`, r, H - M - 34, reg, 10, MUTED);
  textRight(page, "AMOUNT DUE (INC GST)", r, H - M - 54, bold, 7.5, LABEL);
  textRight(page, money(input.owing), r, H - M - 76, bold, 20);
  y = H - M - Math.max(logoH, 90) - 18;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: GOLD });
  y -= 22;

  /* Bill To, and the dates and job on the right. */
  const top = y;
  text(page, "BILL TO", M, y, bold, 7.5, LABEL);
  y -= 14;
  for (const l of [input.to.name, input.to.company, input.to.address, input.to.email].filter((x): x is string => Boolean(x && x.trim()))) {
    for (const w of wrap(l, reg, 9.5, CW * 0.5)) {
      text(page, w, M, y, l === input.to.name ? bold : reg, 9.5);
      y -= 12.5;
    }
  }
  let ry = top;
  const meta: [string, string][] = [
    ["Invoice date", input.date],
    ...(input.dueDate ? ([["Due date", input.dueDate]] as [string, string][]) : []),
    ["Job", input.jobRef],
  ];
  for (const [k, v] of meta) {
    text(page, k, M + CW * 0.58, ry, reg, 8.5, MUTED);
    textRight(page, v, r, ry, bold, 9.5);
    ry -= 14;
  }
  if (input.siteAddress) {
    text(page, "Site", M + CW * 0.58, ry, reg, 8.5, MUTED);
    for (const w of wrap(input.siteAddress, reg, 9, CW * 0.3)) {
      textRight(page, w, r, ry, reg, 9);
      ry -= 12;
    }
  }
  y = Math.min(y, ry) - 16;

  /* The line. */
  page.drawRectangle({ x: M, y: y - 6, width: CW, height: 20, color: FILL });
  text(page, "DESCRIPTION", M + 8, y, bold, 7.5, LABEL);
  textRight(page, "AMOUNT (EX GST)", r - 8, y, bold, 7.5, LABEL);
  y -= 24;
  const desc = wrap(input.description, reg, 10, CW * 0.7);
  desc.forEach((l, i) => text(page, l, M + 8, y - i * 13, reg, 10));
  textRight(page, money(input.subtotal), r - 8, y, reg, 10);
  y -= desc.length * 13 + 8;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: RULE });
  y -= 18;

  /* Totals. */
  const lx = M + CW * 0.58;
  const line = (label: string, value: string, big = false) => {
    text(page, label, lx, y, big ? bold : reg, big ? 11 : 9.5, big ? INK : MUTED);
    textRight(page, value, r - 8, y, big ? bold : reg, big ? 11 : 9.5);
    y -= big ? 18 : 14;
  };
  line("Sub Total (ex GST)", money(input.subtotal));
  line("GST", money(input.gst));
  line("Total (inc GST)", money(input.total), true);
  if (input.paid > 0) line("Paid so far", money(input.paid));
  page.drawLine({ start: { x: lx, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.8, color: RULE });
  y -= 2;
  line("Amount due", money(input.owing), true);
  y -= 10;

  /* Bank transfer. */
  const bh = 58;
  page.drawRectangle({ x: M, y: y - bh + 12, width: CW, height: bh, color: FILL });
  text(page, "PAYMENT BY BANK TRANSFER", M + 10, y, bold, 7.5, LABEL);
  const cols: [string, string][] = [
    ["Account Name", TERRA_PRINT.bank.name],
    ["BSB", TERRA_PRINT.bank.bsb],
    ["Account", TERRA_PRINT.bank.account],
    ["Reference", input.number],
  ];
  const cw = (CW - 20) / cols.length;
  cols.forEach(([k, v], i) => {
    text(page, k, M + 10 + i * cw, y - 14, reg, 8, MUTED);
    text(page, v, M + 10 + i * cw, y - 26, bold, 10);
  });
  y -= bh + 6;

  /* Pay by card, when it is switched on. */
  if (input.payUrl) {
    const h = 44;
    page.drawRectangle({ x: M, y: y - h + 12, width: CW, height: h, color: FILL });
    text(page, "PAY BY CARD", M + 10, y, bold, 7.5, LABEL);
    const bw = 104;
    const by = y - 26;
    page.drawRectangle({ x: M + 10, y: by, width: bw, height: 18, color: GOLD });
    const label = "Pay by card";
    text(page, label, M + 10 + (bw - bold.widthOfTextAtSize(label, 9.5)) / 2, by + 5.5, bold, 9.5, rgb(1, 1, 1));
    link(doc, page, M + 10, by, bw, 18, input.payUrl);
    const tx = M + 10 + bw + 12;
    text(page, "Pay securely online with a card.", tx, by + 10, reg, 8, MUTED);
    const shown = input.payUrl.replace(/^https?:\/\//, "");
    text(page, shown, tx, by, reg, 7.5, GOLD);
    link(doc, page, tx, by - 2, Math.min(CW - bw - 30, reg.widthOfTextAtSize(clean(shown), 7.5)), 10, input.payUrl);
    y -= h + 6;
  }

  y -= 6;
  text(page, "Prices are in Australian dollars. Thank you for your business.", M, y, reg, 8.5, MUTED);
  text(page, `Terra Flooring  |  ABN ${TERRA_PRINT.abn}  |  ${TERRA_PRINT.qbcc}`, M, 22, reg, 7, LABEL);
  textRight(page, `Invoice ${input.number}  |  Page 1 of 1`, W - M, 22, reg, 7, LABEL);

  return Buffer.from(await doc.save());
}

const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();

/** Everything the invoice PDF needs, read from the invoice, its job and who it is billed to. */
export async function clientInvoicePdfFor(invoiceId: number) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) throw new Error("Invoice not found");
  const [contact] = inv.billToContactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, inv.billToContactId)) : [];
  const [company] = inv.billToCompanyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, inv.billToCompanyId)) : [];
  const [job] = inv.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, inv.jobId)) : [];
  const [site] = job?.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [];
  const siteAddress = site ? [site.address, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null;
  const owing = owingOn(inv);
  const pdf = await renderClientInvoicePdf({
    number: inv.number,
    date: auDate(inv.createdAt),
    dueDate: inv.dueDate ? auDate(inv.dueDate) : null,
    to: {
      name: fullName(contact) || company?.name || "Client",
      company: company?.name && fullName(contact) ? company.name : null,
      address: company?.billingAddress || contact?.address || siteAddress,
      email: contact?.email || company?.email || null,
    },
    siteAddress,
    jobRef: job ? String(job.displayNumber || job.number) : String(inv.jobNumber),
    description: inv.label || INVOICE_KIND_LABEL[inv.kind] || "Flooring",
    subtotal: inv.subtotal,
    gst: inv.gst,
    total: inv.total,
    paid: inv.amountPaid,
    owing,
    payUrl: cardPaymentsOn() && owing > 0 ? payUrl(inv.id) : null,
  });
  return { pdf, filename: `Terra Flooring Invoice ${inv.number}.pdf` };
}
