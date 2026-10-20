import { eq } from "drizzle-orm";
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "../database";
import * as schema from "../database/schema";
import { round2 } from "./pricing";
import { TERRA_PRINT } from "./quotePdf";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";
import { notFound, oneSaleMoney } from "./trade-core";
import { cardPaymentsOn } from "./stripe";
import { tradePayUrl } from "./trade-pay";
import { creditRef, invoiceRef } from "./trade-pricing";
import { remittanceData } from "./trade-settle";

/* ---------------------------------------------------------------------------
 * Trade documents as PDFs (notes 18.65). Same look as the client invoice:
 *
 *   Tax Invoice S188000-1   every line with name, colour or size, unit, qty,
 *                           rate and total. Fees itemised, or one "Freight
 *                           and levies" line. Only the layout changes; the
 *                           totals are the stored ones either way.
 *   CREDIT NOTE S188000-2   linked to the original, which is never changed.
 *   Remittance Advice       the installer's bill: original, materials offsets,
 *                           cash paid and net.
 *
 * Everything is read from the snapshot taken on finalise. Nothing here works
 * a price out again.
 * ------------------------------------------------------------------------- */

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

export const pdfMoney = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (n: number) => String(Math.round(n * 1000) / 1000);
const auDate = (d: Date | string | null | undefined) => {
  if (!d) return "";
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : d;
  }
  const z = new Date(d.getTime() + 10 * 3600 * 1000); // Brisbane, no daylight saving
  return `${z.getUTCDate()}/${z.getUTCMonth() + 1}/${z.getUTCFullYear()}`;
};

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

const text = (p: PDFPage, s: string, x: number, y: number, f: PDFFont, size: number, color = INK) => p.drawText(clean(s), { x, y, size, font: f, color });
const textRight = (p: PDFPage, s: string, r: number, y: number, f: PDFFont, size: number, color = INK) => {
  const c = clean(s);
  p.drawText(c, { x: r - f.widthOfTextAtSize(c, size), y, size, font: f, color });
};

function link(doc: PDFDocument, page: PDFPage, x: number, y: number, w: number, h: number, url: string) {
  const ref = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(url) } }));
  const annots = page.node.lookup(PDFName.of("Annots"));
  if (annots instanceof PDFArray) annots.push(ref);
  else page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
}

/* ------------------------------ the renderer ------------------------------ */

export type DocRow = { desc: string; detail?: string; unit?: string; qty?: string; rate?: string; total: string; indent?: boolean; bold?: boolean };
export type DocTotal = { label: string; value: string; big?: boolean };

export type TradeDocInput = {
  title: string;
  number: string;
  headLabel: string;
  headValue: string;
  to: { name: string; lines: string[] };
  meta: [string, string][];
  intro: string[];
  /** "lines" has unit, qty and rate columns. "simple" is description and amount. */
  layout: "lines" | "simple";
  amountLabel: string;
  rows: DocRow[];
  totals: DocTotal[];
  bankReference: string | null;
  payUrl: string | null;
  footNote: string;
};

export async function renderTradeDoc(input: TradeDocInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Terra Flooring ${input.title} ${input.number}`);
  doc.setAuthor("Terra Flooring");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(Buffer.from(TERRA_LOGO_PRINT_PNG_BASE64, "base64"));
  const r = W - M;
  const pages: PDFPage[] = [];
  let page = doc.addPage([W, H]);
  pages.push(page);

  /* Header on page 1 only. */
  const logoH = 78;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: M, y: H - M - logoH, width: logoW, height: logoH });
  const dx = M + logoW + 16;
  let y = H - M - 10;
  text(page, TERRA_PRINT.legal, dx, y, bold, 9.5);
  for (const l of [TERRA_PRINT.address, `ABN ${TERRA_PRINT.abn}`, TERRA_PRINT.phones, TERRA_PRINT.email, TERRA_PRINT.website]) {
    y -= 11.5;
    text(page, l, dx, y, reg, 8.5, MUTED);
  }
  const titleSize = input.title === "CREDIT NOTE" ? 26 : 22;
  textRight(page, input.title, r, H - M - 18, bold, titleSize);
  textRight(page, `No. ${input.number}`, r, H - M - 34, reg, 10, MUTED);
  textRight(page, input.headLabel, r, H - M - 54, bold, 7.5, LABEL);
  textRight(page, input.headValue, r, H - M - 76, bold, 20);
  y = H - M - Math.max(logoH, 90) - 18;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: GOLD });
  y -= 22;

  /* To, and the dates on the right. */
  const top = y;
  text(page, "TO", M, y, bold, 7.5, LABEL);
  y -= 14;
  for (const w of wrap(input.to.name, bold, 9.5, CW * 0.5)) {
    text(page, w, M, y, bold, 9.5);
    y -= 12.5;
  }
  for (const l of input.to.lines.filter((x) => x && x.trim())) {
    for (const w of wrap(l, reg, 9.5, CW * 0.5)) {
      text(page, w, M, y, reg, 9.5);
      y -= 12.5;
    }
  }
  let ry = top;
  for (const [k, v] of input.meta) {
    text(page, k, M + CW * 0.58, ry, reg, 8.5, MUTED);
    textRight(page, v, r, ry, bold, 9.5);
    ry -= 14;
  }
  y = Math.min(y, ry) - 8;
  for (const l of input.intro) {
    for (const w of wrap(l, bold, 10, CW)) {
      y -= 4;
      text(page, w, M, y, bold, 10);
      y -= 10;
    }
  }
  y -= 10;

  /* Columns. */
  const lines = input.layout === "lines";
  const cTotal = r - 8;
  const cRate = r - 90;
  const cQty = r - 170;
  const cUnit = M + CW * 0.47;
  const descW = lines ? cUnit - M - 16 : CW * 0.7;
  const unitW = cQty - 40 - cUnit;
  const head = () => {
    page.drawRectangle({ x: M, y: y - 6, width: CW, height: 20, color: FILL });
    text(page, "DESCRIPTION", M + 8, y, bold, 7.5, LABEL);
    if (lines) {
      text(page, "UNIT", cUnit, y, bold, 7.5, LABEL);
      textRight(page, "QTY", cQty, y, bold, 7.5, LABEL);
      textRight(page, "RATE (EX GST)", cRate, y, bold, 7.5, LABEL);
    }
    textRight(page, input.amountLabel, cTotal, y, bold, 7.5, LABEL);
    y -= 22;
  };
  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - M - 10;
    text(page, `${input.title} ${input.number} (continued)`, M, y, bold, 10);
    y -= 24;
    head();
  };
  head();
  for (const row of input.rows) {
    const x = M + 8 + (row.indent ? 12 : 0);
    const f = row.bold ? bold : reg;
    const d = wrap(row.desc, f, row.indent ? 9 : 9.5, descW - (row.indent ? 12 : 0));
    const det = row.detail ? wrap(row.detail, reg, 8, descW - (row.indent ? 12 : 0)) : [];
    const u = row.unit ? wrap(row.unit, reg, 8.5, unitW) : [];
    const h = Math.max(d.length * 12 + det.length * 10, u.length * 10.5) + 6;
    if (y - h < 120) newPage();
    d.forEach((l, i) => text(page, l, x, y - i * 12, f, row.indent ? 9 : 9.5, row.indent ? MUTED : INK));
    det.forEach((l, i) => text(page, l, x, y - d.length * 12 - i * 10 + 1, reg, 8, MUTED));
    if (lines) {
      u.forEach((l, i) => text(page, l, cUnit, y - i * 10.5, reg, 8.5, MUTED));
      if (row.qty) textRight(page, row.qty, cQty, y, reg, 9.5);
      if (row.rate) textRight(page, row.rate, cRate, y, reg, 9.5);
    }
    textRight(page, row.total, cTotal, y, f, 9.5);
    y -= h;
    page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.5, color: RULE });
    y -= 6;
  }
  y -= 8;

  /* Totals. */
  const need = input.totals.length * 16 + (input.bankReference ? 70 : 0) + (input.payUrl ? 56 : 0) + 30;
  if (y - need < 40) {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = H - M - 10;
    text(page, `${input.title} ${input.number} (continued)`, M, y, bold, 10);
    y -= 28;
  }
  const lx = M + CW * 0.52;
  for (const t of input.totals) {
    if (t.big) page.drawLine({ start: { x: lx, y: y + 11 }, end: { x: W - M, y: y + 11 }, thickness: 0.8, color: RULE });
    text(page, t.label, lx, y, t.big ? bold : reg, t.big ? 11 : 9.5, t.big ? INK : MUTED);
    textRight(page, t.value, cTotal, y, t.big ? bold : reg, t.big ? 11 : 9.5);
    y -= t.big ? 18 : 14;
  }
  y -= 10;

  if (input.bankReference) {
    const bh = 58;
    page.drawRectangle({ x: M, y: y - bh + 12, width: CW, height: bh, color: FILL });
    text(page, "PAYMENT BY BANK TRANSFER", M + 10, y, bold, 7.5, LABEL);
    const cols: [string, string][] = [
      ["Account Name", TERRA_PRINT.bank.name],
      ["BSB", TERRA_PRINT.bank.bsb],
      ["Account", TERRA_PRINT.bank.account],
      ["Reference", input.bankReference],
    ];
    const cw = (CW - 20) / cols.length;
    cols.forEach(([k, v], i) => {
      text(page, k, M + 10 + i * cw, y - 14, reg, 8, MUTED);
      text(page, v, M + 10 + i * cw, y - 26, bold, 10);
    });
    y -= bh + 6;
  }
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
  for (const l of wrap(input.footNote, reg, 8.5, CW)) {
    text(page, l, M, y, reg, 8.5, MUTED);
    y -= 11;
  }
  pages.forEach((p, i) => {
    text(p, `Terra Flooring  |  ABN ${TERRA_PRINT.abn}`, M, 22, reg, 7, LABEL);
    textRight(p, `${input.title} ${input.number}  |  Page ${i + 1} of ${pages.length}`, W - M, 22, reg, 7, LABEL);
  });
  return Buffer.from(await doc.save());
}

/* ---------------------------- invoice and credit --------------------------- */

type SaleLine = typeof schema.tradeSaleLines.$inferSelect;

const rateText = (l: SaleLine) => (l.discountPct > 0 ? `${pdfMoney(l.unitPriceExGst)} less ${qtyText(l.discountPct)}%` : pdfMoney(l.unitPriceExGst));

/** The rows of a sale in the buyer's chosen layout. The money is the stored line money either way. */
export function invoiceRows(lines: SaleLine[], presentation: string): DocRow[] {
  const rows: DocRow[] = [];
  const fees = lines.filter((l) => l.kind === "fee");
  const combined = presentation === "combined";
  for (const l of lines.filter((x) => x.kind === "product")) {
    rows.push({ desc: l.description, detail: l.detail || undefined, unit: l.unitLabel || l.sellUnit, qty: qtyText(l.qty), rate: rateText(l), total: pdfMoney(l.lineExGst) });
    if (!combined) {
      for (const f of fees.filter((x) => x.parentLineId === l.id)) {
        rows.push({ desc: f.description, unit: f.unitLabel || f.sellUnit, qty: qtyText(f.qty), rate: pdfMoney(f.unitPriceExGst), total: pdfMoney(f.lineExGst), indent: true });
      }
    }
  }
  if (!combined) {
    // A fee whose product line is gone would still be on the invoice. It is shown, never dropped.
    const shown = new Set(lines.filter((x) => x.kind === "product").map((x) => x.id));
    for (const f of fees.filter((x) => !x.parentLineId || !shown.has(x.parentLineId))) {
      rows.push({ desc: f.description, unit: f.unitLabel || f.sellUnit, qty: qtyText(f.qty), rate: pdfMoney(f.unitPriceExGst), total: pdfMoney(f.lineExGst), indent: true });
    }
  } else if (fees.length) {
    rows.push({ desc: "Freight and levies", total: pdfMoney(round2(fees.reduce((a, f) => a + f.lineExGst, 0))) });
  }
  for (const l of lines.filter((x) => x.kind !== "product" && x.kind !== "fee")) {
    rows.push({ desc: l.description, unit: l.unitLabel || l.sellUnit, qty: qtyText(l.qty), rate: pdfMoney(l.unitPriceExGst), total: pdfMoney(l.lineExGst) });
  }
  return rows;
}

async function saleFor(saleId: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!s) throw notFound("Sale not found");
  return s;
}

/** External buyers never see offsets. Installer buyers see a confirmed offset as a settlement. */
export async function tradeInvoicePdf(saleId: number) {
  const s = await saleFor(saleId);
  if (s.status === "draft") throw notFound("A draft has no invoice yet. Finalise it first.");
  const lines = await db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, saleId)).orderBy(schema.tradeSaleLines.sort, schema.tradeSaleLines.id);
  const m = await oneSaleMoney(saleId);
  const owing = s.status === "finalised" ? Math.max(0, m.balance) : 0;
  const ref = invoiceRef(s.number);
  const totals: DocTotal[] = [
    { label: "Sub Total (ex GST)", value: pdfMoney(s.subtotal) },
    { label: "GST", value: pdfMoney(s.gst) },
    { label: "Total (inc GST)", value: pdfMoney(s.total), big: true },
  ];
  if (m.credited > 0.005) totals.push({ label: "Less credit notes", value: pdfMoney(-m.credited) });
  const paid = round2(m.cashIn - m.refunded);
  if (paid > 0.005) totals.push({ label: "Paid", value: pdfMoney(-paid) });
  if (m.offsetConfirmed > 0.005) totals.push({ label: "Settled against your bill", value: pdfMoney(-m.offsetConfirmed) });
  totals.push({ label: "Amount due", value: pdfMoney(owing), big: true });
  const terms = s.termsDays != null && !s.payBeforeCollection ? `${s.termsDays} day terms` : "Payment before collection";
  const pdf = await renderTradeDoc({
    title: s.status === "cancelled" ? "Tax Invoice (cancelled)" : "Tax Invoice",
    number: ref,
    headLabel: "AMOUNT DUE (INC GST)",
    headValue: pdfMoney(owing),
    to: { name: s.billName || "Trade buyer", lines: [s.billAbn ? `ABN ${s.billAbn}` : "", s.billAddress ?? "", s.billEmail ?? ""] },
    meta: [
      ["Invoice date", auDate(s.finalisedAt)],
      ...(s.dueDate ? ([["Due date", auDate(s.dueDate)]] as [string, string][]) : []),
      ["Terms", terms],
    ],
    intro: [],
    layout: "lines",
    amountLabel: "TOTAL (EX GST)",
    rows: invoiceRows(lines, s.feePresentation),
    totals,
    bankReference: owing > 0.005 ? ref : null,
    payUrl: owing > 0.005 && cardPaymentsOn() && s.status === "finalised" ? tradePayUrl(s.id) : null,
    footNote: "Prices are in Australian dollars and ex GST unless shown. GST is 10% on each line. Thank you for your business.",
  });
  return { pdf, filename: `Terra Flooring Tax Invoice ${ref}.pdf`, ref, owing, sale: s };
}

export async function tradeCreditPdf(creditId: number) {
  const [c] = await db.select().from(schema.tradeCreditNotes).where(eq(schema.tradeCreditNotes.id, creditId));
  if (!c) throw notFound("Credit note not found");
  const s = await saleFor(c.saleId);
  const cls = await db.select().from(schema.tradeCreditLines).where(eq(schema.tradeCreditLines.creditId, c.id)).orderBy(schema.tradeCreditLines.id);
  const sl = await db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, s.id));
  const lineOf = new Map(sl.map((l) => [l.id, l]));
  const rows: DocRow[] = cls.map((cl) => {
    const l = lineOf.get(cl.saleLineId);
    const fee = l?.kind === "fee";
    return {
      desc: l ? l.description : `Line ${cl.saleLineId}`,
      detail: l?.detail || undefined,
      unit: l ? l.unitLabel || l.sellUnit : "",
      qty: cl.qty > 0 ? qtyText(cl.qty) : "",
      rate: l && cl.qty > 0 ? pdfMoney(round2(cl.lineExGst / cl.qty)) : "",
      total: pdfMoney(cl.lineExGst),
      indent: fee,
    };
  });
  const ref = creditRef(s.number, c.seq);
  const orig = invoiceRef(s.number);
  const pdf = await renderTradeDoc({
    title: "CREDIT NOTE",
    number: ref,
    headLabel: "CREDIT (INC GST)",
    headValue: pdfMoney(c.total),
    to: { name: s.billName || "Trade buyer", lines: [s.billAbn ? `ABN ${s.billAbn}` : "", s.billAddress ?? "", s.billEmail ?? ""] },
    meta: [
      ["Credit date", auDate(c.createdAt)],
      ["Credits invoice", orig],
    ],
    intro: [`Credits invoice ${orig}.`, ...(c.reason ? [`Reason: ${c.reason}`] : [])],
    layout: "lines",
    amountLabel: "CREDIT (EX GST)",
    rows,
    totals: [
      { label: "Sub Total (ex GST)", value: pdfMoney(c.subtotal) },
      { label: "GST", value: pdfMoney(c.gst) },
      { label: "Total credit (inc GST)", value: pdfMoney(c.total), big: true },
    ],
    bankReference: null,
    payUrl: null,
    footNote: `This credit note reduces invoice ${orig}. The original invoice is unchanged.`,
  });
  return { pdf, filename: `Terra Flooring Credit Note ${ref}.pdf`, ref, credit: c, sale: s };
}

/* -------------------------------- remittance ------------------------------- */

export async function remittancePdf(billId: number) {
  const d = await remittanceData(billId);
  const rows: DocRow[] = [{ desc: `Your invoice ${d.invoiceNumber}${d.jobNumber ? ` (job ${d.jobNumber})` : ""}`, total: pdfMoney(d.original), bold: true }];
  for (const o of d.offsets) rows.push({ desc: `Less materials invoice ${o.ref}${o.date ? ` (${auDate(o.date)})` : ""}`, total: pdfMoney(-o.amount), indent: true });
  for (const c of d.cash) rows.push({ desc: `Paid${c.date ? ` ${auDate(c.date)}` : ""}${c.reference ? `, ref ${c.reference}` : ""}`, total: pdfMoney(-c.amount), indent: true });
  const settledByOffset = d.offsetTotal > 0.005 && d.remaining <= 0.005 && d.cashTotal <= 0.005;
  const totals: DocTotal[] = [
    { label: "Original bill", value: pdfMoney(d.original) },
    { label: "Less materials offsets", value: pdfMoney(-d.offsetTotal) },
    { label: "Net to pay", value: pdfMoney(d.net), big: true },
    { label: "Cash paid", value: pdfMoney(d.cashTotal) },
    { label: d.remaining > 0.005 ? "Still to pay" : "Remaining", value: pdfMoney(d.remaining), big: true },
  ];
  const pdf = await renderTradeDoc({
    title: "Remittance Advice",
    number: String(d.invoiceNumber),
    headLabel: d.remaining > 0.005 ? "STILL TO PAY" : "NET PAID",
    headValue: pdfMoney(d.remaining > 0.005 ? d.remaining : d.cashTotal),
    to: { name: d.payee, lines: [d.abn ? `ABN ${d.abn}` : "", d.email ?? ""] },
    meta: [
      ["Date", auDate(new Date())],
      ["Your invoice", String(d.invoiceNumber)],
    ],
    intro: settledByOffset ? ["Settled by offset. No cash payment was needed."] : [],
    layout: "simple",
    amountLabel: "AMOUNT",
    rows,
    totals,
    bankReference: null,
    payUrl: null,
    footNote: "Materials offsets are amounts you owed Terra for trade materials, set against this invoice with your agreement. Any questions, call 1300 183 772.",
  });
  return { pdf, filename: `Terra Flooring Remittance ${d.invoiceNumber}.pdf`, data: d };
}
