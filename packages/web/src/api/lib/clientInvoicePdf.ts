import { and, asc, eq } from "drizzle-orm";
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { db } from "../database";
import * as schema from "../database/schema";
import { INVOICE_KIND_LABEL } from "./client-invoices";
import { drawQuoteWorks, TERRA_PRINT } from "./quotePdf";
import { quoteRefOf } from "./quote-number";
import { billingSummaryFor, type BillingSummary, type SummaryLine } from "./invoice-summary";
import { bundlesFor } from "../routes/quoteBundles";
import { cardPaymentsOn, owingOn, payUrl } from "./stripe";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";

/**
 * The client's tax invoice, as a PDF, sent with the invoice email (spec 15 Oct).
 * Same look as the quote: logo and business details, the number and amount
 * owing on the right, Bill To, the line, totals, then how to pay.
 *
 * An invoice raised against a quote also carries that quote's works, the
 * sections and wording (or the itemised rows) exactly as the quote PDF shows
 * them, then the billing summary from lib/invoice-summary.ts: the quote,
 * approved variations, what was previously invoiced, this invoice and what
 * remains to invoice (Damien, 26 Oct). Amount due on this invoice is the
 * payment figure, never a job balance.
 *
 * What the invoice says is saved on it at the first email (issued_snapshot),
 * and a re-send draws from that, so revised scope or figures on the job or
 * quote never reach an invoice already issued. Only this invoice's own
 * payments move, the same figure the pay page shows (owingOn). Every PDF
 * that is emailed is also stored with the message.
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
  /** The quote this invoice bills, drawn as the quote PDF draws it. */
  works?: InvoiceWorks | null;
  /** Inc GST. Only given when it holds together (lib/invoice-summary.ts). */
  summary?: SummaryLine[] | null;
};

export type InvoiceWorks = {
  /** As people read it, e.g. Q188032. */
  quoteRef: string;
  bundles: { title: string; wording: string; total: number }[];
  /** The itemised layout. Drawn in place of the bundles. Ex GST. */
  items?: { description: string; qty: number; unit: string; rate: number; total: number }[];
  subtotal: number;
  gst: number;
  total: number;
};

/** What an invoice said when it was first emailed. A re-send draws from this. */
export type IssuedSnapshot = {
  v: 1;
  issuedAt: string;
  to: ClientInvoicePdfInput["to"];
  siteAddress: string | null;
  jobRef: string;
  description: string;
  works: InvoiceWorks | null;
  summary: BillingSummary;
  /** Emailed before snapshots were kept: redrawn as it first went, one line, no works or summary. */
  legacy?: true;
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
  let page = doc.addPage([W, H]);

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
  textRight(page, "AMOUNT DUE ON THIS INVOICE (INC GST)", r, H - M - 54, bold, 7.5, LABEL);
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

  let cur = { page, y };
  const running = `Invoice ${input.number}`;
  /** Room for `h` points, or a new page headed like the quote's continued pages. */
  const need = (h: number, floor = M + 24) => {
    if (cur.y - h >= floor) return;
    const p = doc.addPage([W, H]);
    text(p, `${running} (continued)`, M, H - M - 10, bold, 10);
    textRight(p, TERRA_PRINT.legal, W - M, H - M - 10, reg, 8.5, MUTED);
    cur = { page: p, y: H - M - 28 };
  };
  const right = W - M - 8;

  /* The quote's works, as the quote shows them, and the quote's totals. */
  const works = input.works;
  if (works) {
    need(60);
    text(cur.page, `WORKS AS QUOTED, QUOTE ${works.quoteRef}`, M, cur.y, bold, 7.5, LABEL);
    cur.y -= 16;
    cur = drawQuoteWorks({ doc, reg, bold, page: cur.page, y: cur.y, running }, works);
    need(56);
    const lx = M + CW * 0.58;
    const qline = (label: string, value: string, big = false) => {
      text(cur.page, label, lx, cur.y, big ? bold : reg, big ? 10.5 : 9.5, big ? INK : MUTED);
      textRight(cur.page, value, right, cur.y, big ? bold : reg, big ? 10.5 : 9.5);
      cur.y -= big ? 18 : 14;
    };
    qline("Quote Sub Total (ex GST)", money(works.subtotal));
    qline("GST", money(works.gst));
    cur.page.drawLine({ start: { x: lx, y: cur.y + 9 }, end: { x: W - M, y: cur.y + 9 }, thickness: 0.8, color: RULE });
    cur.y -= 2;
    qline("Quote total (inc GST)", money(works.total), true);
    cur.y -= 10;
  }

  /* The billing summary: previously invoiced, this invoice, remaining. Not payments. */
  const summary = input.summary ?? [];
  if (summary.length) {
    const groups = new Set(summary.map((b) => b.kind).filter((k) => k === "previous" || k === "since")).size;
    need(60 + summary.length * 14 + groups * 13);
    cur.page.drawRectangle({ x: M, y: cur.y - 6, width: CW, height: 20, color: FILL });
    text(cur.page, "BILLING SUMMARY FOR THIS JOB", M + 8, cur.y, bold, 7.5, LABEL);
    textRight(cur.page, "INC GST", right, cur.y, bold, 7.5, LABEL);
    cur.y -= 22;
    let group: string | null = null;
    for (const b of summary) {
      const heading = b.kind === "previous" ? "Previously invoiced" : b.kind === "since" ? "Also invoiced on this job, after this invoice" : null;
      if (heading && group !== b.kind) {
        need(14);
        text(cur.page, heading, M + 8, cur.y, bold, 9, MUTED);
        cur.y -= 13;
      }
      group = b.kind;
      if (b.kind === "contract" || b.kind === "remaining") {
        cur.page.drawLine({ start: { x: M + 8, y: cur.y + 10 }, end: { x: W - M, y: cur.y + 10 }, thickness: 0.5, color: RULE });
        cur.y -= 2;
      }
      const strong = b.kind === "this" || b.kind === "remaining" || b.kind === "contract";
      const indent = b.kind === "previous" || b.kind === "since" ? 14 : 0;
      const lines = wrap(b.label, strong ? bold : reg, 9.5, CW * 0.72 - indent);
      need(lines.length * 12 + 6);
      textRight(cur.page, money(b.amount), right, cur.y, strong ? bold : reg, 9.5);
      for (const l of lines) {
        text(cur.page, l, M + 8 + indent, cur.y, strong ? bold : reg, 9.5);
        cur.y -= 12;
      }
      cur.y -= 2;
    }
    if (summary.some((b) => b.kind === "previous" || b.kind === "since")) {
      need(14);
      cur.y -= 2;
      text(cur.page, "Previously invoiced means invoices issued, not payments received.", M + 8, cur.y, reg, 8, MUTED);
      cur.y -= 10;
    }
    cur.page.drawLine({ start: { x: M, y: cur.y + 4 }, end: { x: W - M, y: cur.y + 4 }, thickness: 0.6, color: RULE });
    cur.y -= 16;
  }

  /* The line. */
  const desc = wrap(input.description, reg, 10, CW * 0.7);
  // The invoice line, its totals and how to pay stay together on one page, so
  // the payment boxes never sit alone on the last page.
  const bh = 58;
  const payH = bh + 6 + (input.payUrl ? 50 : 0) + 6;
  need(142 + desc.length * 13 + (input.paid > 0 ? 14 : 0) + payH, 34);
  cur.page.drawRectangle({ x: M, y: cur.y - 6, width: CW, height: 20, color: FILL });
  text(cur.page, works ? "THIS INVOICE" : "DESCRIPTION", M + 8, cur.y, bold, 7.5, LABEL);
  textRight(cur.page, "AMOUNT (EX GST)", r - 8, cur.y, bold, 7.5, LABEL);
  cur.y -= 24;
  desc.forEach((l, i) => text(cur.page, l, M + 8, cur.y - i * 13, reg, 10));
  textRight(cur.page, money(input.subtotal), r - 8, cur.y, reg, 10);
  cur.y -= desc.length * 13 + 8;
  cur.page.drawLine({ start: { x: M, y: cur.y }, end: { x: W - M, y: cur.y }, thickness: 0.8, color: RULE });
  cur.y -= 18;

  /* Totals. */
  const lx = M + CW * 0.58;
  const line = (label: string, value: string, big = false) => {
    text(cur.page, label, lx, cur.y, big ? bold : reg, big ? 11 : 9.5, big ? INK : MUTED);
    textRight(cur.page, value, r - 8, cur.y, big ? bold : reg, big ? 11 : 9.5);
    cur.y -= big ? 18 : 14;
  };
  line("Sub Total (ex GST)", money(input.subtotal));
  line("GST", money(input.gst));
  line("Total (inc GST)", money(input.total), true);
  if (input.paid > 0) line("Paid on this invoice", money(input.paid));
  // The figure to pay, the same one the pay page shows. Never a job balance.
  cur.y -= 4;
  const dueH = 28;
  // Wider than the totals column so the label and a six figure amount never meet.
  const bx = M + CW * 0.4;
  cur.page.drawRectangle({ x: bx, y: cur.y - 10, width: W - M - bx, height: dueH, color: FILL });
  cur.page.drawRectangle({ x: bx, y: cur.y - 10, width: 3, height: dueH, color: GOLD });
  text(cur.page, "Amount due on this invoice", bx + 13, cur.y, bold, 11);
  textRight(cur.page, money(input.owing), r - 8, cur.y - 1, bold, 14);
  cur.y -= dueH + 6;

  /* Bank transfer. */
  // The footer sits at 22, so the payment boxes can run closer to it than the works do.
  need(payH, 34);
  page = cur.page;
  y = cur.y;
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
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    text(p, `Terra Flooring  |  ABN ${TERRA_PRINT.abn}  |  ${TERRA_PRINT.qbcc}`, M, 22, reg, 7, LABEL);
    textRight(p, `Invoice ${input.number}  |  Page ${i + 1} of ${pages.length}`, W - M, 22, reg, 7, LABEL);
  });

  return Buffer.from(await doc.save());
}

const fullName = (c: { firstName?: string | null; lastName?: string | null } | null | undefined) =>
  [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim();

type InvoiceRow = typeof schema.invoices.$inferSelect;

/** The quote an invoice bills, as the client reads it on the quote PDF. No cost leaves here (bundlesFor). */
async function worksFor(inv: InvoiceRow) {
  if (!inv.quoteId) return null;
  const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, inv.quoteId));
  if (!quote) return null;
  const { bundles, layout, items } = await bundlesFor(quote);
  if (!bundles.length && !items.length) return null;
  const works: InvoiceWorks = {
    quoteRef: await quoteRefOf(quote),
    bundles: bundles.map((b) => ({ title: b.title, wording: b.wording, total: b.total })),
    items: layout === "itemised" ? items.map((i) => ({ description: i.description, qty: i.qty, unit: i.unit, rate: i.rate, total: i.total })) : undefined,
    subtotal: quote.subtotal,
    gst: quote.gst,
    total: quote.total,
  };
  return { quote, works };
}

/** The snapshot saved on an invoice, or null. One that will not read stops the send rather than redraw from today's data. */
export function storedSnapshot(inv: InvoiceRow): IssuedSnapshot | null {
  if (!inv.issuedSnapshot) return null;
  try {
    const s = JSON.parse(inv.issuedSnapshot) as IssuedSnapshot;
    if (s?.v === 1 && s.summary && typeof s.description === "string") return s;
  } catch {
    /* falls through */
  }
  throw new Error(`The saved copy of ${inv.number} cannot be read, so it was not re-sent. Nothing was changed.`);
}

/** What the invoice says now, from the job, quote and billing as they stand. Only for a first send. */
async function freshSnapshot(inv: InvoiceRow): Promise<IssuedSnapshot> {
  const [contact] = inv.billToContactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, inv.billToContactId)) : [];
  const [company] = inv.billToCompanyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, inv.billToCompanyId)) : [];
  const [job] = inv.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, inv.jobId)) : [];
  const [site] = job?.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, job.siteId)) : [];
  const siteAddress = site ? [site.address, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null;
  const quoted = await worksFor(inv);
  const summary: BillingSummary = quoted ? await billingSummaryFor(inv) : { state: "hidden", reason: "No quote works on this invoice." };
  return {
    v: 1,
    issuedAt: new Date().toISOString(),
    to: {
      name: fullName(contact) || company?.name || "Client",
      company: company?.name && fullName(contact) ? company.name : null,
      address: company?.billingAddress || contact?.address || siteAddress,
      email: contact?.email || company?.email || null,
    },
    siteAddress,
    jobRef: job ? String(job.displayNumber || job.number) : String(inv.jobNumber),
    description: inv.label || INVOICE_KIND_LABEL[inv.kind] || "Flooring",
    works: quoted?.works ?? null,
    summary,
  };
}

/** The PDF input: the issued snapshot, plus this invoice's own payments as they are now. */
export function pdfInputFrom(inv: InvoiceRow, snap: IssuedSnapshot): ClientInvoicePdfInput {
  const owing = owingOn(inv);
  return {
    number: inv.number,
    date: auDate(inv.createdAt),
    dueDate: inv.dueDate ? auDate(inv.dueDate) : null,
    to: snap.to,
    siteAddress: snap.siteAddress,
    jobRef: snap.jobRef,
    description: snap.description,
    subtotal: inv.subtotal,
    gst: inv.gst,
    total: inv.total,
    paid: inv.amountPaid,
    owing,
    payUrl: cardPaymentsOn() && owing > 0 ? payUrl(inv.id) : null,
    works: snap.works,
    summary: snap.summary.state === "shown" ? snap.summary.lines : null,
  };
}

/**
 * The invoice PDF. A first send draws it from the job now and hands back the
 * snapshot to save once the email has gone (`fresh`). A re-send draws it from
 * the saved snapshot.
 */
export async function clientInvoicePdfFor(invoiceId: number) {
  const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
  if (!inv) throw new Error("Invoice not found");
  const stored = storedSnapshot(inv);
  const snapshot = stored ?? (await legacySnapshot(inv)) ?? (await freshSnapshot(inv));
  const pdf = await renderClientInvoicePdf(pdfInputFrom(inv, snapshot));
  return { pdf, filename: `Terra Flooring Invoice ${inv.number}.pdf`, snapshot, fresh: !stored };
}

/**
 * An invoice emailed before snapshots were kept went as one line, with no
 * quote works and no billing summary. A re-send keeps it that way rather than
 * add scope and figures the client never had on it.
 */
async function legacySnapshot(inv: InvoiceRow): Promise<IssuedSnapshot | null> {
  const [first] = await db
    .select({ at: schema.activityLog.createdAt })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "invoice"), eq(schema.activityLog.entityId, inv.id), eq(schema.activityLog.action, "invoice_emailed")))
    .orderBy(asc(schema.activityLog.id))
    .limit(1);
  if (!first) return null;
  const now = await freshSnapshot(inv);
  return {
    ...now,
    issuedAt: new Date(first.at ?? Date.now()).toISOString(),
    works: null,
    summary: { state: "hidden", reason: "Emailed before the quote works and billing summary were added to invoices." },
    legacy: true,
  };
}
