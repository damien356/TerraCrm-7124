import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { TERRA_PRINT } from "./quotePdf";
import { drawSignature, type Signature } from "./signature";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";

/**
 * A variation as a PDF (fix list 11 Oct, item 12). The same print layout as
 * the quote: logo and business details, the title, number and total on the
 * right, who it is to, why, the photos, the lines and the acceptance block.
 *
 * The client sees each line's description and quantity, never a rate, a line
 * price, a cost or a markup. Lines come in with no money on them.
 *
 * Sign only: no bank details and no card link. It goes on the final or end
 * invoice. The signed copy (onePage) is always one page: no photos, the reason
 * cut short and any lines that do not fit counted at the end of the table.
 */

export type VariationPdfInput = {
  /** V188000-01 */
  ref: string;
  date: string;
  jobRef: string;
  quoteRef: string | null;
  to: { name: string; company: string | null; address: string | null; email: string | null; phone: string | null };
  siteAddress: string | null;
  /** Why the variation is needed, in the office's words. */
  reason: string;
  lines: { description: string; qty: number; unit: string }[];
  subtotal: number;
  gst: number;
  total: number;
  /** "Added to your final invoice." or "Added to the end invoice." */
  billNote: string;
  showPosition?: boolean;
  /** The signed copy: kept to one page. */
  onePage?: boolean;
  signed?: { name: string; position: string; date: string; signature: Signature } | null;
  /** Up to four photos, already read from storage. */
  photos?: { bytes: Buffer; type: "png" | "jpg" }[];
};

export const VARIATION_ACCEPT_HEADING = "VARIATION ACCEPTANCE (PLEASE SIGN THE SECTION BELOW)";
export const variationAcceptText = (jobRef: string) =>
  `Your signed acceptance approves this variation to job ${jobRef} and adds the amount above to your job price. The Supply Terms and Conditions you agreed to on your quote apply to this work as well.`;

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

const clean = (s: string) =>
  s
    .replace(/[‐-―]/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF‘’“”•…]/g, "");

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyText = (qty: number, unit: string) => `${Number(qty.toFixed(2))} ${unit === "m2" ? "m2" : unit}`.trim();

function wrap(textIn: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(textIn).split(/\n/)) {
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

type Ctx = { doc: PDFDocument; reg: PDFFont; bold: PDFFont; logo: PDFImage; page: PDFPage; y: number; input: VariationPdfInput };

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(clean(s), { x, y, size, font, color });
}
function textRight(page: PDFPage, s: string, right: number, y: number, font: PDFFont, size: number, color = INK) {
  const c = clean(s);
  page.drawText(c, { x: right - font.widthOfTextAtSize(c, size), y, size, font, color });
}

const BOTTOM = M + 24;

function need(ctx: Ctx, h: number) {
  if (ctx.y - h >= BOTTOM) return;
  if (ctx.input.onePage) return;
  ctx.page = ctx.doc.addPage([W, H]);
  ctx.y = H - M;
  text(ctx.page, `Variation ${ctx.input.ref} (continued)`, M, ctx.y - 10, ctx.bold, 10);
  textRight(ctx.page, TERRA_PRINT.legal, W - M, ctx.y - 10, ctx.reg, 8.5, MUTED);
  ctx.y -= 28;
}

function header(ctx: Ctx) {
  const { page, reg, bold, logo, input } = ctx;
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
  textRight(page, "Variation", r, H - M - 18, bold, 24);
  textRight(page, `No. ${input.ref}`, r, H - M - 34, reg, 10, MUTED);
  textRight(page, "TOTAL (INC GST)", r, H - M - 54, bold, 7.5, LABEL);
  textRight(page, money(input.total), r, H - M - 76, bold, 20);
  ctx.y = H - M - Math.max(logoH, 90) - 18;
  page.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 1.2, color: GOLD });
  ctx.y -= 18;
}

function addressed(ctx: Ctx) {
  const { page, reg, bold, input } = ctx;
  const top = ctx.y;
  text(page, "VARIATION TO", M, top, bold, 7.5, LABEL);
  let y = top - 14;
  const toLines = [input.to.name, input.to.company, input.to.address, input.to.email, input.to.phone].filter(
    (l): l is string => !!l && !!l.trim(),
  );
  toLines.forEach((l, i) => {
    for (const w of wrap(l, i === 0 ? bold : reg, 9.5, CW * 0.48)) {
      text(page, w, M, y, i === 0 ? bold : reg, 9.5, i === 0 ? INK : MUTED);
      y -= 12.5;
    }
  });
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
  pair("DATE", input.date);
  pair("JOB", input.quoteRef ? `${input.jobRef}, quote ${input.quoteRef}` : input.jobRef);
  if (input.siteAddress && input.siteAddress.trim() !== (input.to.address ?? "").trim()) pair("SITE", input.siteAddress);
  ctx.y = Math.min(y, ry) - 12;
}

function reason(ctx: Ctx) {
  let body = wrap(ctx.input.reason || "", ctx.reg, 9.5, CW - 20);
  if (!body.some((l) => l.trim())) return;
  if (ctx.input.onePage && body.length > 6) body = [...body.slice(0, 5), `${body[5]!.replace(/\s*\S*$/, "")}...`];
  need(ctx, 30 + Math.min(body.length, 6) * 12.5);
  text(ctx.page, "WHY THIS VARIATION", M, ctx.y, ctx.bold, 7.5, LABEL);
  ctx.y -= 14;
  for (const l of body) {
    need(ctx, 13);
    if (l) text(ctx.page, l, M, ctx.y, ctx.reg, 9.5, INK);
    ctx.y -= 12.5;
  }
  ctx.y -= 10;
}

async function photos(ctx: Ctx) {
  const list = (ctx.input.photos ?? []).slice(0, 4);
  if (!list.length) return;
  const images: PDFImage[] = [];
  for (const p of list) {
    try {
      images.push(p.type === "png" ? await ctx.doc.embedPng(p.bytes) : await ctx.doc.embedJpg(p.bytes));
    } catch {
      // A photo that will not embed is left out. The online page still shows it.
    }
  }
  if (!images.length) return;
  const gap = 10;
  const boxW = (CW - gap) / 2;
  const boxH = 150;
  need(ctx, 18 + boxH);
  text(ctx.page, "PHOTOS", M, ctx.y, ctx.bold, 7.5, LABEL);
  ctx.y -= 10;
  for (let i = 0; i < images.length; i += 2) {
    need(ctx, boxH + gap);
    for (let j = 0; j < 2 && i + j < images.length; j++) {
      const img = images[i + j]!;
      const scale = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = M + j * (boxW + gap) + (boxW - w) / 2;
      ctx.page.drawRectangle({ x: M + j * (boxW + gap), y: ctx.y - boxH, width: boxW, height: boxH, color: FILL });
      ctx.page.drawImage(img, { x, y: ctx.y - boxH + (boxH - h) / 2, width: w, height: h });
    }
    ctx.y -= boxH + gap;
  }
  ctx.y -= 6;
}

function table(ctx: Ctx) {
  const descW = CW * 0.72;
  const qtyR = W - M - 8;
  const head = () => {
    ctx.page.drawRectangle({ x: M, y: ctx.y - 6, width: CW, height: 20, color: FILL });
    text(ctx.page, "ITEM DESCRIPTION", M + 8, ctx.y, ctx.bold, 7.5, LABEL);
    textRight(ctx.page, "QTY", qtyR, ctx.y, ctx.bold, 7.5, LABEL);
    ctx.y -= 24;
  };
  need(ctx, 60);
  head();
  // One page: leave room for the totals and the acceptance block under the table.
  const floor = ctx.input.onePage ? BOTTOM + totalsHeight(ctx) + acceptanceHeight(ctx) : -Infinity;
  const list = ctx.input.lines;
  for (let i = 0; i < list.length; i++) {
    const l = list[i]!;
    const rows = wrap(l.description, ctx.reg, 9.5, descW);
    const left = list.length - i - 1;
    if (ctx.y - (rows.length * 12.5 + 12) - (left ? 16 : 0) < floor) {
      const more = list.length - i;
      text(ctx.page, `Plus ${more} more line${more === 1 ? "" : "s"}, as on the variation sent to you.`, M + 8, ctx.y, ctx.reg, 9, MUTED);
      ctx.y -= 16;
      break;
    }
    need(ctx, rows.length * 12.5 + 10);
    const top = ctx.y;
    for (const r of rows) {
      text(ctx.page, r, M + 8, ctx.y, ctx.reg, 9.5);
      ctx.y -= 12.5;
    }
    textRight(ctx.page, qtyText(l.qty, l.unit), qtyR, top, ctx.reg, 9.5, MUTED);
    ctx.y -= 4;
    ctx.page.drawLine({ start: { x: M, y: ctx.y + 4 }, end: { x: W - M, y: ctx.y + 4 }, thickness: 0.6, color: RULE });
    ctx.y -= 8;
  }
}

function totalsHeight(ctx: Ctx) {
  return 14 + 14 + 2 + 18 + wrap(ctx.input.billNote, ctx.reg, 9, CW * 0.42).length * 12 + 10;
}
function acceptanceHeight(ctx: Ctx) {
  return 16 + 15 + wrap(variationAcceptText(ctx.input.jobRef), ctx.reg, 8.5, CW).length * 11 + 22 + 26 + 16;
}

function totals(ctx: Ctx) {
  const { input } = ctx;
  need(ctx, 80);
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
  line("Variation Total (inc GST)", money(input.total), true);
  for (const l of wrap(input.billNote, ctx.reg, 9, CW * 0.42)) {
    text(ctx.page, l, lx, ctx.y, ctx.reg, 9, MUTED);
    ctx.y -= 12;
  }
  ctx.y -= 10;
}

function acceptance(ctx: Ctx) {
  const body = wrap(variationAcceptText(ctx.input.jobRef), ctx.reg, 8.5, CW);
  need(ctx, 40 + body.length * 11 + 60);
  ctx.page.drawLine({ start: { x: M, y: ctx.y }, end: { x: W - M, y: ctx.y }, thickness: 1.2, color: GOLD });
  ctx.y -= 16;
  text(ctx.page, VARIATION_ACCEPT_HEADING, M, ctx.y, ctx.bold, 9.5);
  ctx.y -= 15;
  for (const l of body) {
    text(ctx.page, l, M, ctx.y, ctx.reg, 8.5, MUTED);
    ctx.y -= 11;
  }
  ctx.y -= 22;
  const signed = ctx.input.signed ?? null;
  const field = (label: string, x: number, w: number, value?: string) => {
    text(ctx.page, label, x, ctx.y, ctx.bold, 8.5);
    const lx = x + ctx.bold.widthOfTextAtSize(label, 8.5) + 6;
    ctx.page.drawLine({ start: { x: lx, y: ctx.y - 2 }, end: { x: x + w, y: ctx.y - 2 }, thickness: 0.7, color: INK });
    if (value) text(ctx.page, value.slice(0, 60), lx + 2, ctx.y + 1, ctx.reg, 9, INK);
    return lx;
  };
  field("Name:", M, CW * 0.45, signed?.name);
  const sx = field("Signed:", M + CW * 0.5, CW * 0.5);
  if (signed) drawSignature(ctx.page, signed.signature, { x: sx + 4, y: ctx.y - 1, w: M + CW - sx - 8, h: 22 });
  ctx.y -= 26;
  const pos = ctx.input.showPosition === true;
  if (pos) field("Position / Company:", M, CW * 0.45, signed?.position);
  field("Date:", pos ? M + CW * 0.5 : M, pos ? CW * 0.5 : CW * 0.45, signed ? `${signed.date} (signed online)` : undefined);
  ctx.y -= 16;
}

function footers(doc: PDFDocument, reg: PDFFont, input: VariationPdfInput) {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    text(p, `Terra Flooring  |  ABN ${TERRA_PRINT.abn}  |  ${TERRA_PRINT.qbcc}`, M, 22, reg, 7, LABEL);
    textRight(p, `Variation ${input.ref}  |  Page ${i + 1} of ${pages.length}`, W - M, 22, reg, 7, LABEL);
  });
}

export async function renderVariationPdf(input: VariationPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Terra Flooring variation ${input.ref}`);
  doc.setAuthor("Terra Flooring");
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await doc.embedPng(Buffer.from(TERRA_LOGO_PRINT_PNG_BASE64, "base64"));
  const ctx: Ctx = { doc, reg, bold, logo, page: doc.addPage([W, H]), y: H - M, input };
  header(ctx);
  addressed(ctx);
  reason(ctx);
  await photos(ctx);
  table(ctx);
  totals(ctx);
  acceptance(ctx);
  footers(doc, reg, input);
  return Buffer.from(await doc.save());
}
