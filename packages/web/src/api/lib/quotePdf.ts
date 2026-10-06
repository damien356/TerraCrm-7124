import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { SUPPLY_TERMS, SUPPLY_TERMS_TITLE, SUPPLY_TERMS_VERSION } from "./supplyTerms";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";

/**
 * The client's quote, as a PDF. pdf-lib for the same reason as invoicePdf.ts:
 * it bundles cleanly.
 *
 * THE CLIENT ONLY EVER SEES BUNDLES: a title, the wording and a total per
 * bundle. Never qty, m2, rates, line prices, cost or markup. This file takes
 * no line items at all, so it cannot leak them.
 *
 * Layout follows the agreed print layout: header with logo and business
 * details, Quote title, number and large total on the right, Quote To block,
 * Item Description / Total table, Sub Total / GST / Grand Total, deposit and
 * bank transfer details, then the acceptance block. The Supply Terms and
 * Conditions follow on their own pages ("overleaf").
 */

export type QuotePdfInput = {
  number: number;
  version: number;
  /** Already formatted, e.g. 6/10/2026. */
  date: string;
  validUntil: string | null;
  to: {
    name: string;
    company: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
  };
  /** Site address when it differs from the client's own. */
  siteAddress: string | null;
  bundles: { title: string; wording: string; total: number }[];
  subtotal: number;
  gst: number;
  total: number;
  depositPercent: number;
  deposit: number;
  balance: number;
};

export const TERRA_PRINT = {
  legal: "Arclan Pty Ltd t/a Terra Flooring",
  address: "2/22 Lawrence Dr, Nerang QLD 4211",
  abn: "82 651 012 001",
  phones: "1300 183 772  |  0468 366 555",
  email: "damien@terraflooring.com.au",
  website: "www.terraflooring.com.au",
  qbcc: "QBCC-15497829",
  bank: { name: "Arclan Pty Ltd", bsb: "064 844", account: "10102345" },
} as const;

export const ACCEPTANCE_HEADING = "QUOTE ACCEPTANCE (PLEASE COMPLETE AND SIGN THE SECTION BELOW)";
export const ACCEPTANCE_TEXT =
  "Your signed acceptance of this quotation acknowledges that you have read and agreed to our terms and conditions overleaf, and agree to be bound by them, and will be deemed as a purchase order from the customer to the supplier, which cannot be cancelled.";
export const ACCEPTANCE_NOTE =
  "Please note that your order cannot be processed until we have received your signed acceptance of this quote along with your deposit.";

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

/** WinAnsi only. Smart quotes and dashes are fine in Helvetica, emoji etc are not. */
const clean = (s: string) =>
  s
    .replace(/[‐‑‒―]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•…]/g, "");

const money = (n: number) =>
  `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split(/\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        // A single word wider than the column: hard break it.
        let w = word;
        while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
          let i = w.length - 1;
          while (i > 1 && font.widthOfTextAtSize(w.slice(0, i), size) > width) i--;
          out.push(w.slice(0, i));
          w = w.slice(i);
        }
        line = w;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

type Ctx = { doc: PDFDocument; reg: PDFFont; bold: PDFFont; logo: PDFImage; page: PDFPage; y: number; input: QuotePdfInput };

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(clean(s), { x, y, size, font, color });
}
function textRight(page: PDFPage, s: string, right: number, y: number, font: PDFFont, size: number, color = INK) {
  const c = clean(s);
  page.drawText(c, { x: right - font.widthOfTextAtSize(c, size), y, size, font, color });
}

function newPage(ctx: Ctx, continued: boolean) {
  ctx.page = ctx.doc.addPage([W, H]);
  ctx.y = H - M;
  if (continued) {
    text(ctx.page, `Quote ${ctx.input.number}${ctx.input.version > 1 ? ` v${ctx.input.version}` : ""} (continued)`, M, ctx.y - 10, ctx.bold, 10);
    textRight(ctx.page, TERRA_PRINT.legal, W - M, ctx.y - 10, ctx.reg, 8.5, MUTED);
    ctx.y -= 28;
  }
}

/** Make room for `h` points, starting a new page if needed. */
function need(ctx: Ctx, h: number) {
  if (ctx.y - h < M + 24) newPage(ctx, true);
}

function header(ctx: Ctx) {
  const { page, reg, bold, logo, input } = ctx;
  const logoH = 78;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: M, y: H - M - logoH, width: logoW, height: logoH });

  const dx = M + logoW + 16;
  let y = H - M - 10;
  text(page, TERRA_PRINT.legal, dx, y, bold, 9.5);
  for (const l of [
    TERRA_PRINT.address,
    `ABN ${TERRA_PRINT.abn}`,
    TERRA_PRINT.phones,
    TERRA_PRINT.email,
    TERRA_PRINT.website,
    TERRA_PRINT.qbcc,
  ]) {
    y -= 11.5;
    text(page, l, dx, y, reg, 8.5, MUTED);
  }

  // Title, number and the big total on the right.
  const r = W - M;
  textRight(page, "Quote", r, H - M - 18, bold, 24);
  textRight(page, `No. ${input.number}${input.version > 1 ? ` v${input.version}` : ""}`, r, H - M - 34, reg, 10, MUTED);
  textRight(page, "TOTAL (INC GST)", r, H - M - 54, bold, 7.5, LABEL);
  textRight(page, money(input.total), r, H - M - 76, bold, 20);

  ctx.y = H - M - Math.max(logoH, 90) - 18;
  page.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 1.2, color: GOLD });
  ctx.y -= 18;
}

function quoteTo(ctx: Ctx) {
  const { page, reg, bold, input } = ctx;
  const top = ctx.y;
  text(page, "QUOTE TO", M, top, bold, 7.5, LABEL);
  let y = top - 14;
  const toLines = [
    input.to.name,
    input.to.company,
    input.to.address,
    input.to.email,
    input.to.phone,
  ].filter((l): l is string => !!l && !!l.trim());
  toLines.forEach((l, i) => {
    for (const w of wrap(l, i === 0 ? bold : reg, 9.5, CW * 0.48)) {
      text(page, w, M, y, i === 0 ? bold : reg, 9.5, i === 0 ? INK : MUTED);
      y -= 12.5;
    }
  });

  // Right hand: dates and site.
  const rx = M + CW * 0.56;
  let ry = top;
  const pair = (label: string, value: string) => {
    text(page, label, rx, ry, bold, 7.5, LABEL);
    ry -= 12.5;
    for (const w of wrap(value, reg, 9.5, CW * 0.44)) {
      text(page, w, rx, ry, reg, 9.5);
      ry -= 12.5;
    }
    ry -= 4;
  };
  pair("QUOTE DATE", input.date);
  if (input.validUntil) pair("VALID UNTIL", input.validUntil);
  if (input.siteAddress && input.siteAddress.trim() !== (input.to.address ?? "").trim()) pair("SITE", input.siteAddress);

  ctx.y = Math.min(y, ry) - 12;
}

function table(ctx: Ctx) {
  const descW = CW * 0.74;
  const totalR = W - M - 8;
  const row = () => {
    ctx.page.drawRectangle({ x: M, y: ctx.y - 6, width: CW, height: 20, color: FILL });
    text(ctx.page, "ITEM DESCRIPTION", M + 8, ctx.y, ctx.bold, 7.5, LABEL);
    textRight(ctx.page, "TOTAL", totalR, ctx.y, ctx.bold, 7.5, LABEL);
    ctx.y -= 24;
  };
  row();

  for (const b of ctx.input.bundles) {
    const titleLines = wrap(b.title, ctx.bold, 10, descW);
    const body = wrap(b.wording || "", ctx.reg, 9, descW);
    // Keep the title and the first few lines together.
    need(ctx, titleLines.length * 13 + Math.min(body.length, 4) * 12 + 10);
    if (ctx.y > H - M - 40) row();

    const top = ctx.y;
    for (const l of titleLines) {
      text(ctx.page, l, M + 8, ctx.y, ctx.bold, 10);
      ctx.y -= 13;
    }
    textRight(ctx.page, money(b.total), totalR, top, ctx.bold, 10);
    for (const l of body) {
      need(ctx, 12);
      if (l) text(ctx.page, l, M + 8, ctx.y, ctx.reg, 9, MUTED);
      ctx.y -= 12;
    }
    ctx.y -= 6;
    ctx.page.drawLine({ start: { x: M, y: ctx.y + 4 }, end: { x: W - M, y: ctx.y + 4 }, thickness: 0.6, color: RULE });
    ctx.y -= 10;
  }
}

function totals(ctx: Ctx) {
  const { input } = ctx;
  need(ctx, 70);
  const lx = M + CW * 0.58;
  const r = W - M - 8;
  const line = (label: string, value: string, big = false) => {
    text(ctx.page, label, lx, ctx.y, big ? ctx.bold : ctx.reg, big ? 11 : 9.5, big ? INK : MUTED);
    textRight(ctx.page, value, r, ctx.y, big ? ctx.bold : ctx.reg, big ? 11 : 9.5);
    ctx.y -= big ? 18 : 14;
  };
  line("Sub Total (ex GST)", money(input.subtotal));
  line("GST", money(input.gst));
  ctx.page.drawLine({ start: { x: lx, y: ctx.y + 9 }, end: { x: W - M, y: ctx.y + 9 }, thickness: 0.8, color: RULE });
  ctx.y -= 2;
  line("Grand Total (inc GST)", money(input.total), true);
  if (input.depositPercent > 0) {
    line(`Deposit required (${input.depositPercent}%)`, money(input.deposit));
    line("Balance on completion", money(input.balance));
  }
  ctx.y -= 8;
}

function payment(ctx: Ctx) {
  const { input } = ctx;
  need(ctx, 80);
  const top = ctx.y;
  const h = 66;
  ctx.page.drawRectangle({ x: M, y: top - h + 12, width: CW, height: h, color: FILL });
  let y = top;
  text(ctx.page, "PAYMENT BY BANK TRANSFER", M + 10, y, ctx.bold, 7.5, LABEL);
  y -= 14;
  const cols: [string, string][] = [
    ["Account Name", TERRA_PRINT.bank.name],
    ["BSB", TERRA_PRINT.bank.bsb],
    ["Account", TERRA_PRINT.bank.account],
    ["Reference", `Quote ${input.number}`],
  ];
  const cw = (CW - 20) / cols.length;
  cols.forEach(([k, v], i) => {
    text(ctx.page, k, M + 10 + i * cw, y, ctx.reg, 8, MUTED);
    text(ctx.page, v, M + 10 + i * cw, y - 12, ctx.bold, 10);
  });
  y -= 30;
  text(ctx.page, "Prices are in Australian dollars. Card payments incur a 1.5% surcharge.", M + 10, y, ctx.reg, 8, MUTED);
  ctx.y = top - h - 6;
}

function acceptance(ctx: Ctx) {
  const body = wrap(ACCEPTANCE_TEXT, ctx.reg, 8.5, CW);
  const note = wrap(ACCEPTANCE_NOTE, ctx.reg, 8.5, CW);
  need(ctx, 40 + body.length * 11 + note.length * 11 + 70);
  ctx.page.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 1.2, color: GOLD });
  ctx.y -= 16;
  text(ctx.page, ACCEPTANCE_HEADING, M, ctx.y, ctx.bold, 9.5);
  ctx.y -= 15;
  for (const l of body) {
    text(ctx.page, l, M, ctx.y, ctx.reg, 8.5, MUTED);
    ctx.y -= 11;
  }
  ctx.y -= 22;
  const field = (label: string, x: number, w: number) => {
    text(ctx.page, label, x, ctx.y, ctx.bold, 8.5);
    const lx = x + ctx.bold.widthOfTextAtSize(label, 8.5) + 6;
    ctx.page.drawLine({ start: { x: lx, y: ctx.y - 2 }, end: { x: x + w, y: ctx.y - 2 }, thickness: 0.7, color: INK });
  };
  field("Name:", M, CW * 0.45);
  field("Signed:", M + CW * 0.5, CW * 0.5);
  ctx.y -= 26;
  field("Position / Company:", M, CW * 0.45);
  field("Date:", M + CW * 0.5, CW * 0.5);
  ctx.y -= 22;
  for (const l of note) {
    text(ctx.page, l, M, ctx.y, ctx.bold, 8.5, INK);
    ctx.y -= 11;
  }
}

/** The supply terms, two columns of small type on their own pages. */
function terms(ctx: Ctx) {
  const size = 7.2;
  const lead = 8.9;
  const gap = 16;
  const colW = (CW - gap) / 2;
  const startPage = () => {
    newPage(ctx, false);
    text(ctx.page, SUPPLY_TERMS_TITLE, M, ctx.y - 6, ctx.bold, 11);
    textRight(ctx.page, `Version ${SUPPLY_TERMS_VERSION}`, W - M, ctx.y - 6, ctx.reg, 7.5, LABEL);
    ctx.y -= 16;
    ctx.page.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 0.8, color: GOLD });
    ctx.y -= 12;
    return ctx.y;
  };
  let top = startPage();
  let col = 0;
  let y = top;
  const bottom = M + 20;
  const advance = (h: number) => {
    if (y - h < bottom) {
      if (col === 0) {
        col = 1;
        y = top;
      } else {
        top = startPage();
        col = 0;
        y = top;
      }
    }
  };
  for (const b of SUPPLY_TERMS) {
    const font = b.t === "h" ? ctx.bold : ctx.reg;
    const indent = b.t === "i" ? 10 : 0;
    const lines = wrap(b.x, font, b.t === "h" ? size + 1 : size, colW - indent);
    if (b.t === "h") advance(lead * 2 + lead * 2); // never strand a heading at the foot
    if (b.t === "h") y -= 4;
    for (const l of lines) {
      advance(lead);
      text(ctx.page, l, M + col * (colW + gap) + indent, y, font, b.t === "h" ? size + 1 : size, b.t === "h" ? INK : MUTED);
      y -= lead;
    }
    y -= b.t === "h" ? 1 : 3;
  }
}

function footers(doc: PDFDocument, reg: PDFFont, input: QuotePdfInput) {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    text(p, `Terra Flooring  |  ABN ${TERRA_PRINT.abn}  |  ${TERRA_PRINT.qbcc}`, M, 22, reg, 7, LABEL);
    textRight(p, `Quote ${input.number}  |  Page ${i + 1} of ${pages.length}`, W - M, 22, reg, 7, LABEL);
  });
}

export async function renderQuotePdf(input: QuotePdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Terra Flooring quote ${input.number}`);
  doc.setAuthor("Terra Flooring");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(Buffer.from(TERRA_LOGO_PRINT_PNG_BASE64, "base64"));
  const ctx: Ctx = { doc, reg, bold, logo, page: doc.addPage([W, H]), y: H - M, input };

  header(ctx);
  quoteTo(ctx);
  table(ctx);
  totals(ctx);
  payment(ctx);
  acceptance(ctx);
  terms(ctx);
  footers(doc, reg, input);

  return Buffer.from(await doc.save());
}
