import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SwmsSnapshot } from "./swms-library";
import { drawSignature, type Signature } from "./signature";

/**
 * The signed SWMS as a PDF that lives against the job. pdf-lib, same as the
 * PO and installer invoice. One page for most jobs, more if a commercial
 * vinyl job with levelling runs long.
 */

export type SwmsPdfInput = {
  jobNumber: number;
  jobTitle: string;
  siteAddress: string;
  workDate: string;
  installerName: string;
  signedName: string;
  signedAt: Date;
  kind: "full" | "reconfirm";
  basedOnDate: string | null;
  snapshot: SwmsSnapshot;
  customHazard: string;
  sds: Array<{ product: string; revision: string; issuedOn: string | null; note: string }>;
  missingSds: string[];
  signature: Signature;
};

const TERRA = {
  name: "Arclan Pty Ltd t/a Terra Flooring",
  abn: "82 651 012 001",
  phone: "1300 183 772",
};

const INK = rgb(0.12, 0.11, 0.1);
const MUTED = rgb(0.38, 0.36, 0.34);
const RULE = rgb(0.86, 0.84, 0.81);
const FILL = rgb(0.96, 0.95, 0.94);
const WARN = rgb(0.62, 0.22, 0.12);
const W = 595.28;
const H = 841.89;
const M = 40;

const clean = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");

/** Gold Coast clock time for the stamp. */
function stamp(d: Date) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = clean(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export async function renderSwmsPdf(input: SwmsPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`SWMS Job ${input.jobNumber} ${input.workDate}`);
  doc.setAuthor(TERRA.name);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const t = (s: string, x: number, size = 9.5, f: PDFFont = reg, color = INK) =>
    page.drawText(clean(s), { x, y: y - size, size, font: f, color });
  const right = (s: string, xr: number, size = 9.5, f: PDFFont = reg, color = INK) =>
    t(s, xr - f.widthOfTextAtSize(clean(s), size), size, f, color);
  const need = (h: number) => {
    if (y - h < M + 20) {
      page = doc.addPage([W, H]);
      y = H - M;
      t(`SWMS Job ${input.jobNumber}, ${input.workDate}, continued`, M, 9, reg, MUTED);
      y -= 20;
    }
  };

  // Header
  t("SAFE WORK METHOD STATEMENT", M, 17, bold);
  right(`Job ${input.jobNumber}`, W - M, 17, bold);
  y -= 24;
  t(TERRA.name, M, 9.5, bold);
  right(`Work date ${input.workDate}`, W - M, 9.5);
  y -= 12;
  t(`ABN ${TERRA.abn}   ${TERRA.phone}`, M, 8.5, reg, MUTED);
  right(input.kind === "reconfirm" ? "Daily re-confirm" : "Full review", W - M, 9.5, bold);
  y -= 20;

  // Site block
  const siteLines = wrap(input.siteAddress || "No site address on the job", reg, 9.5, W - M * 2 - 90);
  const titleLines = input.jobTitle ? wrap(input.jobTitle, reg, 9.5, W - M * 2 - 90) : [];
  const boxH = 16 + (siteLines.length + titleLines.length + 1) * 12;
  page.drawRectangle({ x: M, y: y - boxH, width: W - M * 2, height: boxH, color: FILL });
  y -= 8;
  const row = (label: string, lines: string[]) => {
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) t(label, M + 10, 8.5, bold, MUTED);
      t(lines[i]!, M + 90, 9.5);
      y -= 12;
    }
  };
  row("SITE", siteLines);
  if (titleLines.length) row("JOB", titleLines);
  row("WORKER", [input.installerName]);
  y -= 12;

  if (input.kind === "reconfirm" && input.basedOnDate) {
    t(`Same hazards and controls as the SWMS signed on ${input.basedOnDate}, reviewed and re-confirmed today.`, M, 8.5, reg, MUTED);
    y -= 16;
  }

  // Hazard tables
  const colHaz = M + 16;
  const colCtl = M + 260;
  const hazW = colCtl - colHaz - 10;
  const ctlW = W - M - colCtl;
  const items = (list: SwmsSnapshot["common"]) => {
    for (const it of list) {
      const hl = wrap(it.label, reg, 8.8, hazW);
      const cl = wrap(it.controls, reg, 8.8, ctlW);
      const h = Math.max(hl.length, cl.length) * 11 + 6;
      need(h);
      const color = it.checked ? INK : MUTED;
      t(it.checked ? "[x]" : "[  ]", M, 8.5, bold, color);
      const top = y;
      hl.forEach((l, i) => page.drawText(l, { x: colHaz, y: top - 9 - i * 11, size: 8.8, font: reg, color }));
      const ctl = it.checked ? cl : ["Not applicable on this site"];
      ctl.forEach((l, i) => page.drawText(clean(l), { x: colCtl, y: top - 9 - i * 11, size: 8.8, font: reg, color }));
      y -= h;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.4, color: RULE });
    }
  };
  const heading = (title: string, sub?: string) => {
    need(40);
    y -= 6;
    t(title.toUpperCase(), M, 9, bold);
    y -= 13;
    if (sub) {
      for (const l of wrap(`Task: ${sub}`, reg, 8.5, W - M * 2)) {
        t(l, M, 8.5, reg, MUTED);
        y -= 11;
      }
    }
    t("HAZARD", colHaz, 7.5, bold, MUTED);
    t("CONTROLS", colCtl, 7.5, bold, MUTED);
    y -= 11;
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.6, color: RULE });
  };

  heading("Common site hazards");
  items(input.snapshot.common);
  for (const s of input.snapshot.sections) {
    y -= 6;
    heading(s.title, s.task);
    items(s.items);
  }

  if (input.customHazard.trim()) {
    y -= 6;
    need(40);
    t("ADDED ON SITE", M, 9, bold);
    y -= 14;
    for (const l of wrap(input.customHazard, reg, 9, W - M * 2)) {
      need(12);
      t(l, M, 9);
      y -= 12;
    }
  }

  // SDS
  y -= 8;
  need(30 + (input.sds.length + input.missingSds.length) * 12);
  t("SAFETY DATA SHEETS FOR THIS JOB", M, 9, bold);
  y -= 14;
  if (input.sds.length === 0 && input.missingSds.length === 0) {
    t("No adhesives or chemicals ticked on this SWMS.", M, 8.8, reg, MUTED);
    y -= 12;
  }
  for (const s of input.sds) {
    const bits = [s.product, s.revision, s.issuedOn ? `issued ${s.issuedOn}` : "", s.note].filter(Boolean).join(", ");
    for (const l of wrap(bits, reg, 8.8, W - M * 2 - 12)) {
      t(l, M + 12, 8.8);
      y -= 11;
    }
  }
  for (const m of input.missingSds) {
    t(`${m}: SDS not on file yet, ask the office.`, M + 12, 8.8, reg, WARN);
    y -= 11;
  }

  // Declaration and signature
  y -= 10;
  need(150);
  const decl =
    "I have read this SWMS, I understand the hazards and controls for today's work, and I will follow them. " +
    "If the work or the site changes I will stop, review this SWMS and tell the office.";
  for (const l of wrap(decl, reg, 9, W - M * 2)) {
    t(l, M, 9);
    y -= 12;
  }
  y -= 8;
  const sigBox = { x: M, y: y - 80, w: 240, h: 80 };
  page.drawRectangle({ x: sigBox.x, y: sigBox.y, width: sigBox.w, height: sigBox.h, borderColor: RULE, borderWidth: 0.8 });
  drawSignature(page, input.signature, { x: sigBox.x + 6, y: sigBox.y + 6, w: sigBox.w - 12, h: sigBox.h - 12 });
  const sx = M + 260;
  t("SIGNED BY", sx, 7.5, bold, MUTED);
  y -= 11;
  t(input.signedName, sx, 11, bold);
  y -= 18;
  t("SIGNED AT", sx, 7.5, bold, MUTED);
  y -= 11;
  t(`${stamp(input.signedAt)} (Gold Coast)`, sx, 9.5);
  y -= 16;
  t("COVERS", sx, 7.5, bold, MUTED);
  y -= 11;
  t(`${input.workDate} only`, sx, 9.5);

  return Buffer.from(await doc.save());
}
