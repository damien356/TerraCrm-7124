import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { INVOICES_TO } from "./gmail";

/**
 * Terra's purchase order, as a PDF the supplier can file. pdf-lib for the
 * same reason as the installer invoice (see invoicePdf.ts): it bundles cleanly.
 *
 * Shows what Terra will pay, ex GST, and says in two places where the invoice
 * has to go and which number to quote on it. That line is what makes the
 * matching work.
 */

export type PoPdfInput = {
  number: string;
  date: string;
  supplierName: string;
  supplierAccount: string | null;
  jobNumber: number;
  jobTitle: string;
  deliverTo: "warehouse" | "site";
  deliveryAddress: string;
  notes: string;
  lines: Array<{ description: string; qty: number; unit: string; unitCostExGst: number; totalExGst: number }>;
  goodsExGst: number;
  chargesExGst: number;
  freightExGst: number;
  totalExGst: number;
};

const TERRA = {
  name: "Arclan Pty Ltd t/a Terra Flooring",
  abn: "82 651 012 001",
  address: "2/22 Lawrence Dr, Nerang QLD 4211",
  phone: "1300 183 772",
  orders: "team@terraflooring.com.au",
};

const INK = rgb(0.12, 0.11, 0.1);
const MUTED = rgb(0.35, 0.33, 0.31);
const RULE = rgb(0.88, 0.86, 0.83);
const FILL = rgb(0.96, 0.95, 0.94);
const W = 595.28;
const H = 841.89;
const M = 40;

const clean = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
const money = (n: number) => `$${n.toFixed(2)}`;

export async function renderPoPdf(po: PoPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([W, H]);
  let y = H - M;

  const t = (s: string, x: number, size = 10, f: PDFFont = reg, color = INK, p: PDFPage = page) =>
    p.drawText(clean(s), { x, y: y - size, size, font: f, color });
  const right = (s: string, xr: number, size = 10, f: PDFFont = reg) => t(s, xr - f.widthOfTextAtSize(clean(s), size), size, f);

  t("PURCHASE ORDER", M, 20, bold);
  right(po.number, W - M, 20, bold);
  y -= 28;
  t(TERRA.name, M, 10, bold);
  right(`Date ${po.date}`, W - M, 10);
  y -= 13;
  t(`ABN ${TERRA.abn}`, M, 9, reg, MUTED);
  right(`Job ${po.jobNumber}`, W - M, 10);
  y -= 12;
  t(TERRA.address, M, 9, reg, MUTED);
  y -= 12;
  t(`${TERRA.phone}   ${TERRA.orders}`, M, 9, reg, MUTED);
  y -= 26;

  // The line that makes matching work.
  page.drawRectangle({ x: M, y: y - 40, width: W - M * 2, height: 40, color: FILL });
  y -= 9;
  t(`Please quote ${po.number} on your invoice.`, M + 10, 11, bold);
  y -= 15;
  t(`Send invoices to ${INVOICES_TO}`, M + 10, 10);
  y -= 34;

  t("Supplier", M, 9, bold, MUTED);
  t(po.deliverTo === "site" ? "Deliver to site" : "Deliver to", W / 2, 9, bold, MUTED);
  y -= 13;
  t(po.supplierName, M, 10);
  for (const [i, l] of wrap(po.deliveryAddress || (po.deliverTo === "warehouse" ? TERRA.address : ""), 48).entries()) {
    if (i) y -= 13;
    t(l, W / 2, 10);
  }
  if (po.supplierAccount) {
    y -= 13;
    t(`Account ${po.supplierAccount}`, M, 9, reg, MUTED);
  }
  y -= 13;
  t(`Job: ${po.jobTitle}`.slice(0, 70), M, 9, reg, MUTED);
  y -= 26;

  const cols = { desc: M, qty: M + 300, unit: M + 350, rate: W - M - 90, total: W - M };
  const head = () => {
    t("Description", cols.desc, 9, bold, MUTED);
    right("Qty", cols.qty + 30, 9, bold);
    t("Unit", cols.unit, 9, bold, MUTED);
    right("Rate ex GST", cols.rate + 30, 9, bold);
    right("Total ex GST", cols.total, 9, bold);
    y -= 14;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: RULE });
    y -= 6;
  };
  head();
  for (const l of po.lines) {
    const rows = wrap(l.description, 55);
    if (y - rows.length * 13 < M + 120) {
      page = doc.addPage([W, H]);
      y = H - M;
      head();
    }
    t(rows[0] ?? "", cols.desc, 10);
    right(fmtQty(l.qty), cols.qty + 30, 10);
    t(l.unit, cols.unit, 10);
    right(money(l.unitCostExGst), cols.rate + 30, 10);
    right(money(l.totalExGst), cols.total, 10);
    for (const r of rows.slice(1)) {
      y -= 13;
      t(r, cols.desc, 10);
    }
    y -= 18;
  }
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.6, color: RULE });
  y -= 6;
  const sum = (label: string, v: number, b = false) => {
    right(label, cols.rate + 30, 10, b ? bold : reg);
    right(money(v), cols.total, 10, b ? bold : reg);
    y -= 15;
  };
  sum("Goods", po.goodsExGst);
  if (po.chargesExGst) sum("Supplier charges", po.chargesExGst);
  sum(po.deliverTo === "warehouse" && !po.freightExGst ? "Freight (to our warehouse, no charge)" : "Freight", po.freightExGst);
  sum("Total ex GST", po.totalExGst, true);
  sum("GST", Math.round(po.totalExGst * 10) / 100);
  sum("Total inc GST", Math.round(po.totalExGst * 110) / 100, true);

  if (po.notes) {
    y -= 10;
    t("Notes", M, 9, bold, MUTED);
    for (const r of wrap(po.notes, 95)) {
      y -= 13;
      t(r, M, 10);
    }
  }
  return Buffer.from(await doc.save());
}

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function wrap(s: string, max: number) {
  const out: string[] = [];
  for (const para of s.split(/\n/)) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      if ((line + " " + w).trim().length > max) {
        if (line) out.push(line);
        line = w;
      } else line = (line + " " + w).trim();
    }
    out.push(line);
  }
  return out.filter((l, i) => l || i === 0);
}
