import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * The installer's own invoice to Terra, rendered in their business name.
 *
 * WHY pdf-lib AND NOT @react-pdf/renderer: react-pdf pulls in pdfkit, and
 * pdfkit loads its built in fonts through a Node "imports" specifier,
 * "#standard-fonts/Helvetica". That specifier only resolves relative to
 * pdfkit's own package. Once the server is bundled into a single file for
 * deployment the importing file is the bundle, not pdfkit, so the lookup fails
 * and the server dies at boot with "Cannot find module '#standard-fonts/
 * Helvetica'". pdf-lib carries its standard font metrics inside the package as
 * plain data, so nothing is resolved at runtime and the bundle is self
 * contained. Do not reintroduce react-pdf or pdfkit here.
 *
 * Layout is written out in points because that is what a PDF is measured in.
 * A4 is 595.28 x 841.89pt, the page padding is 36pt, so the content column is
 * 523.28pt wide. The percentages in COLS below are of that content width and
 * mirror the column widths this invoice has always had.
 */

export interface InvoiceLineItem {
  description: string;
  unit: string;
  qty: number;
  rate: number | null;
  total: number | null;
}

export interface InvoicePdfInput {
  invoiceNumber: number;
  invoiceDate: string;
  tradingName: string;
  installerName: string;
  abn: string | null;
  gstRegistered: boolean;
  businessAddress: string | null;
  invoiceEmail: string | null;
  mobile: string | null;
  logoDataUri: string | null;
  bankAccountName: string | null;
  bankBsb: string | null;
  bankAccountNumber: string | null;
  jobNumber: number | string;
  siteAddress: string | null;
  taskTitle: string;
  lineItems: InvoiceLineItem[];
  subtotal: number;
  gstAmount: number;
  total: number;
}

const TERRA_BILL_TO = {
  name: "Arclan Pty Ltd t/a Terra Flooring",
  abn: "82 651 012 001",
  address: "2/22 Lawrence Dr, Nerang QLD 4211",
} as const;

const PAGE = { width: 595.28, height: 841.89 } as const;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

/** Ink, matching the on screen invoice. */
const INK = rgb(0x1f / 255, 0x1d / 255, 0x1b / 255);
const MUTED = rgb(0x4a / 255, 0x45 / 255, 0x40 / 255);
const LABEL = rgb(0x8a / 255, 0x84 / 255, 0x7c / 255);
const RULE = rgb(0xeb / 255, 0xe7 / 255, 0xe2 / 255);
const TOP_RULE = rgb(0xdd / 255, 0xd8 / 255, 0xd2 / 255);
const BANK_FILL = rgb(0xf5 / 255, 0xf4 / 255, 0xf2 / 255);

/** Column x offsets and widths, taken off the content width. */
const COLS = {
  desc: { x: 0, w: CONTENT_WIDTH * 0.4 },
  unit: { x: CONTENT_WIDTH * 0.4, w: CONTENT_WIDTH * 0.12 },
  qty: { x: CONTENT_WIDTH * 0.52, w: CONTENT_WIDTH * 0.12 },
  rate: { x: CONTENT_WIDTH * 0.64, w: CONTENT_WIDTH * 0.18 },
  total: { x: CONTENT_WIDTH * 0.82, w: CONTENT_WIDTH * 0.18 },
} as const;

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * The standard fonts encode WinAnsi and throw on anything outside it, and an
 * installer's own business name or a site address is free text that has come
 * out of a phone keyboard. A curly quote must not be the reason an invoice
 * fails to generate, so the common typographic characters are folded to their
 * plain equivalents and anything still unencodable is dropped.
 */
function winAnsi(value: string) {
  return value
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  regular: PDFFont;
  bold: PDFFont;
  y: number;
}

function text(
  ctx: Ctx,
  value: string,
  opts: { x: number; size: number; bold?: boolean; color?: ReturnType<typeof rgb>; y?: number },
) {
  const font = opts.bold ? ctx.bold : ctx.regular;
  const clean = winAnsi(value);
  ctx.page.drawText(clean, {
    x: MARGIN + opts.x,
    y: (opts.y ?? ctx.y) - opts.size,
    size: opts.size,
    font,
    color: opts.color ?? INK,
  });
}

/** Right aligned inside a column box, which is how every number on this invoice sits. */
function textRight(
  ctx: Ctx,
  value: string,
  opts: { x: number; w: number; size: number; bold?: boolean; color?: ReturnType<typeof rgb>; y?: number },
) {
  const font = opts.bold ? ctx.bold : ctx.regular;
  const clean = winAnsi(value);
  const width = font.widthOfTextAtSize(clean, opts.size);
  ctx.page.drawText(clean, {
    x: MARGIN + opts.x + opts.w - width,
    y: (opts.y ?? ctx.y) - opts.size,
    size: opts.size,
    font,
    color: opts.color ?? INK,
  });
}

function textCentre(ctx: Ctx, value: string, opts: { size: number; color?: ReturnType<typeof rgb>; y?: number }) {
  const clean = winAnsi(value);
  const width = ctx.regular.widthOfTextAtSize(clean, opts.size);
  ctx.page.drawText(clean, {
    x: MARGIN + (CONTENT_WIDTH - width) / 2,
    y: (opts.y ?? ctx.y) - opts.size,
    size: opts.size,
    font: ctx.regular,
    color: opts.color ?? INK,
  });
}

function rule(ctx: Ctx, y: number, color: ReturnType<typeof rgb>, thickness = 0.75) {
  ctx.page.drawLine({
    start: { x: MARGIN, y },
    end: { x: MARGIN + CONTENT_WIDTH, y },
    thickness,
    color,
  });
}

/** Break a description onto as many lines as the column needs. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number) {
  const words = winAnsi(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than the column gets cut character by character.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = "";
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    } else {
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE.width, PAGE.height]);
  ctx.y = PAGE.height - MARGIN;
}

/**
 * The logo is whatever the installer uploaded. A bad or unsupported file must
 * cost them the logo, never the invoice, so anything that will not embed is
 * skipped silently.
 */
async function embedLogo(doc: PDFDocument, dataUri: string) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(dataUri.trim());
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  try {
    return match[1].toLowerCase() === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch {
    return null;
  }
}

function tableHead(ctx: Ctx) {
  rule(ctx, ctx.y, TOP_RULE);
  ctx.y -= 6;
  const opts = { size: 8, color: LABEL } as const;
  text(ctx, "DESCRIPTION", { x: COLS.desc.x, ...opts });
  textRight(ctx, "UNIT", { ...COLS.unit, ...opts });
  textRight(ctx, "QTY", { ...COLS.qty, ...opts });
  textRight(ctx, "RATE", { ...COLS.rate, ...opts });
  textRight(ctx, "TOTAL", { ...COLS.total, ...opts });
  ctx.y -= 12;
  rule(ctx, ctx.y, INK);
}

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${input.invoiceNumber}`);
  doc.setProducer("Terra Ops");
  doc.setCreator("Terra Ops");

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE.width, PAGE.height]),
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    y: PAGE.height - MARGIN,
  };

  /* Header, the installer's details on the left and the invoice number on the right. */
  const headerTop = ctx.y;
  let leftY = headerTop;

  if (input.logoDataUri) {
    const logo = await embedLogo(doc, input.logoDataUri);
    if (logo) {
      const box = 90;
      const scale = Math.min(box / logo.width, box / logo.height);
      const w = logo.width * scale;
      const h = logo.height * scale;
      ctx.page.drawImage(logo, { x: MARGIN, y: leftY - h, width: w, height: h });
      leftY -= h + 10;
    }
  }

  text(ctx, input.tradingName || input.installerName, { x: 0, size: 16, bold: true, y: leftY });
  leftY -= 20;

  const smallLines = [
    input.installerName && input.installerName !== input.tradingName ? input.installerName : null,
    input.abn ? `ABN ${input.abn}` : null,
    input.businessAddress,
    input.invoiceEmail,
    input.mobile,
  ].filter((v): v is string => Boolean(v));

  for (const line of smallLines) {
    text(ctx, line, { x: 0, size: 9, color: MUTED, y: leftY });
    leftY -= 12;
  }

  let rightY = headerTop;
  const title = input.gstRegistered ? "Tax Invoice" : "Invoice";
  textRight(ctx, title, { x: 0, w: CONTENT_WIDTH, size: 20, bold: true, y: rightY });
  rightY -= 26;
  textRight(ctx, `Invoice # ${input.invoiceNumber}`, { x: 0, w: CONTENT_WIDTH, size: 9, color: MUTED, y: rightY });
  rightY -= 12;
  textRight(ctx, `Date ${input.invoiceDate}`, { x: 0, w: CONTENT_WIDTH, size: 9, color: MUTED, y: rightY });
  rightY -= 12;

  ctx.y = Math.min(leftY, rightY) - 12;

  /* Bill to and the job it is for, side by side. */
  const blockTop = ctx.y;
  const rightBlockX = CONTENT_WIDTH * 0.52;

  const block = (x: number, label: string, lines: string[]) => {
    let y = blockTop;
    text(ctx, label.toUpperCase(), { x, size: 8, color: LABEL, y });
    y -= 12;
    for (const line of lines) {
      text(ctx, line, { x, size: 10, y });
      y -= 12;
    }
    return y;
  };

  const billBottom = block(0, "Bill to", [TERRA_BILL_TO.name, `ABN ${TERRA_BILL_TO.abn}`, TERRA_BILL_TO.address]);
  const jobBottom = block(
    rightBlockX,
    "Job",
    [`Job #${input.jobNumber}`, input.taskTitle, input.siteAddress].filter((v): v is string => Boolean(v)),
  );

  ctx.y = Math.min(billBottom, jobBottom) - 14;

  /* Line items. */
  tableHead(ctx);

  for (const line of input.lineItems) {
    const descLines = wrap(line.description, ctx.regular, 10, COLS.desc.w - 8);
    const rowHeight = 6 + descLines.length * 12;

    // Keep a row whole: if it will not fit, carry it to a fresh page under a
    // repeated header rather than splitting it across the page break.
    if (ctx.y - rowHeight < MARGIN + 140) {
      newPage(ctx);
      tableHead(ctx);
    }

    ctx.y -= 6;
    const rowTop = ctx.y;
    descLines.forEach((dl, i) => text(ctx, dl, { x: COLS.desc.x, size: 10, y: rowTop - i * 12 }));
    textRight(ctx, line.unit, { ...COLS.unit, size: 10, y: rowTop });
    textRight(ctx, String(line.qty), { ...COLS.qty, size: 10, y: rowTop });
    textRight(ctx, line.rate != null ? money(line.rate) : "-", { ...COLS.rate, size: 10, y: rowTop });
    textRight(ctx, line.total != null ? money(line.total) : "-", { ...COLS.total, size: 10, y: rowTop });
    ctx.y = rowTop - descLines.length * 12;
    rule(ctx, ctx.y, RULE);
  }

  /* Totals, right aligned in a 220pt column. */
  const totalsX = CONTENT_WIDTH - 220;
  ctx.y -= 16;

  const totalsRow = (label: string, value: string) => {
    text(ctx, label, { x: totalsX, size: 10 });
    textRight(ctx, value, { x: totalsX, w: 220, size: 10 });
    ctx.y -= 15;
  };

  totalsRow("Subtotal", money(input.subtotal));
  if (input.gstRegistered) totalsRow("GST (10%)", money(input.gstAmount));

  ctx.page.drawLine({
    start: { x: MARGIN + totalsX, y: ctx.y },
    end: { x: MARGIN + totalsX + 220, y: ctx.y },
    thickness: 0.75,
    color: INK,
  });
  ctx.y -= 6;
  text(ctx, "Total due", { x: totalsX, size: 12, bold: true });
  textRight(ctx, money(input.total), { x: totalsX, w: 220, size: 12, bold: true });
  ctx.y -= 20;

  /* How to pay them, only when they have given bank details. */
  if (input.bankBsb && input.bankAccountNumber) {
    const lines = [
      `Account name: ${input.bankAccountName ?? ""}`,
      `BSB: ${input.bankBsb}`,
      `Account number: ${input.bankAccountNumber}`,
    ];
    const boxHeight = 12 + 12 + lines.length * 12;

    if (ctx.y - boxHeight < MARGIN + 40) newPage(ctx);

    ctx.y -= 18;
    ctx.page.drawRectangle({
      x: MARGIN,
      y: ctx.y - boxHeight,
      width: CONTENT_WIDTH,
      height: boxHeight,
      color: BANK_FILL,
    });
    ctx.y -= 12;
    text(ctx, "PAYMENT DETAILS", { x: 12, size: 8, color: LABEL });
    ctx.y -= 14;
    for (const line of lines) {
      text(ctx, line, { x: 12, size: 10 });
      ctx.y -= 12;
    }
    ctx.y -= 6;
  }

  ctx.y -= 18;
  if (ctx.y < MARGIN + 20) newPage(ctx);
  textCentre(ctx, "Generated by Terra Ops on behalf of the contractor named above.", { size: 8, color: LABEL });

  return Buffer.from(await doc.save());
}
