import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SwmsSnapshot } from "./swms-content";
import { drawSignature, type Signature } from "./signature";
import { TERRA_PRINT } from "./quotePdf";
import { TERRA_LOGO_PRINT_PNG_BASE64 } from "./terraLogoPrint";
import type { FooterTemplate, SiteAnswer } from "./swms-checks";

/**
 * The signed SWMS as a PDF that lives against the job. pdf-lib, same as the
 * PO and installer invoice. One page for most jobs, more if a commercial
 * vinyl job with levelling runs long.
 */

export type SwmsPdfInput = {
  jobNumber: number | string;
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
  /** Stage 3. Optional so the library preview and older callers still render. */
  builder?: string | null;
  supervisor?: { name: string; mobile: string } | null;
  /** Undefined: no location line at all (preview). Otherwise ok, or why not. */
  gps?: { status: string; lat: number | null; lng: number | null; accuracy: number | null } | null;
  siteAnswers?: SiteAnswer[];
  /** Templates and the exact versions signed, for the footer on every page. */
  templates?: FooterTemplate[];
};

const TERRA = {
  name: TERRA_PRINT.legal,
  abn: TERRA_PRINT.abn,
  phone: TERRA_PRINT.phones,
  address: TERRA_PRINT.address,
  email: TERRA_PRINT.email,
  qbcc: TERRA_PRINT.qbcc,
};

const ANSWER: Record<string, string> = { yes: "Yes", no: "No", unsure: "Unsure", na: "N/A" };

function day(d: Date) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** One line per template for the footer: name, version, publish date, reviewer. */
export function footerLines(templates: FooterTemplate[]): string[] {
  return templates.map((t) => {
    const v = t.version ? `v${t.version}` : "built-in wording";
    const pub = t.publishedAt ? `published ${day(t.publishedAt)}` : "not published";
    const rev = t.reviewedByName
      ? `reviewed by ${t.reviewedByName}${t.reviewedByQualification ? ` (${t.reviewedByQualification})` : ""}${t.reviewedOn ? ` on ${t.reviewedOn}` : ""}`
      : "Reviewed by: not recorded";
    return `${t.name} ${v}, ${pub}. ${rev}`;
  });
}

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
  const logo = await doc.embedPng(Buffer.from(TERRA_LOGO_PRINT_PNG_BASE64, "base64"));
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  // The footer is drawn on every page at the end. Work out its height first so
  // nothing on the page runs into it.
  const FOOT_SIZE = 6.8;
  const footTemplates = input.templates?.length ? footerLines(input.templates) : [];
  const footWrapped = footTemplates.flatMap((l) => wrap(l, reg, FOOT_SIZE, W - M * 2 - 70));
  const footH = 14 + Math.max(1, footWrapped.length) * 8.5;
  const BOTTOM = M + footH;

  const t = (s: string, x: number, size = 9.5, f: PDFFont = reg, color = INK) =>
    page.drawText(clean(s), { x, y: y - size, size, font: f, color });
  const right = (s: string, xr: number, size = 9.5, f: PDFFont = reg, color = INK) =>
    t(s, xr - f.widthOfTextAtSize(clean(s), size), size, f, color);
  const need = (h: number) => {
    if (y - h < BOTTOM) {
      page = doc.addPage([W, H]);
      y = H - M;
      t(`SWMS Job ${input.jobNumber}, ${input.workDate}, continued`, M, 9, reg, MUTED);
      y -= 20;
    }
  };

  // Header: logo and company on the left, the document on the right.
  const logoH = 58;
  const logoW = (logo.width / logo.height) * logoH;
  page.drawImage(logo, { x: M, y: y - logoH, width: logoW, height: logoH });
  const dx = M + logoW + 12;
  const top = y;
  t(TERRA.name, dx, 9.5, bold);
  y -= 12.5;
  for (const l of [TERRA.address, `ABN ${TERRA.abn}   ${TERRA.qbcc}`, TERRA.phone, TERRA.email]) {
    t(l, dx, 8.2, reg, MUTED);
    y -= 10.5;
  }
  y = top;
  right("SAFE WORK METHOD STATEMENT", W - M, 13, bold);
  y -= 17;
  right(`Job ${input.jobNumber}`, W - M, 13, bold);
  y -= 17;
  right(`Work date ${input.workDate}`, W - M, 9.5);
  y -= 12;
  right(input.kind === "reconfirm" ? "Daily re-confirm" : "Full review", W - M, 9.5, bold);
  y = top - Math.max(logoH, 58) - 14;

  // Site block
  const valW = W - M * 2 - 100;
  const rows: Array<[string, string[]]> = [];
  rows.push(["SITE", wrap(input.siteAddress || "No site address on the job", reg, 9.5, valW)]);
  if (input.jobTitle) rows.push(["JOB", wrap(input.jobTitle, reg, 9.5, valW)]);
  if (input.builder !== undefined) rows.push(["BUILDER", [input.builder || "Not on the job card"]]);
  if (input.supervisor !== undefined)
    rows.push([
      "SITE SUPERVISOR",
      [input.supervisor ? [input.supervisor.name, input.supervisor.mobile].filter(Boolean).join(", ") : "Not on the job card"],
    ]);
  rows.push(["WORKER", [input.installerName]]);
  const boxH = 10 + rows.reduce((n, [, l]) => n + l.length, 0) * 12 + 6;
  page.drawRectangle({ x: M, y: y - boxH, width: W - M * 2, height: boxH, color: FILL });
  y -= 8;
  for (const [label, lines] of rows) {
    for (let i = 0; i < lines.length; i++) {
      if (i === 0) t(label, M + 10, 8, bold, MUTED);
      t(lines[i]!, M + 100, 9.5);
      y -= 12;
    }
  }
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
      const risk = it.riskBefore ? `Risk ${it.riskBefore}${it.riskAfter ? `, after controls ${it.riskAfter}` : ""}` : "";
      const hl = [...wrap(it.label, reg, 8.8, hazW), ...(risk ? [risk] : [])];
      const cl = wrap(it.controls, reg, 8.8, ctlW);
      const h = Math.max(hl.length, cl.length) * 11 + 6;
      need(h);
      const color = it.checked ? INK : MUTED;
      t(it.checked ? "[x]" : "[  ]", M, 8.5, bold, color);
      const rowTop = y;
      hl.forEach((l, i) => page.drawText(l, { x: colHaz, y: rowTop - 9 - i * 11, size: 8.8, font: reg, color }));
      const ctl = it.checked ? cl : ["Not applicable on this site"];
      ctl.forEach((l, i) => page.drawText(clean(l), { x: colCtl, y: rowTop - 9 - i * 11, size: 8.8, font: reg, color }));
      y -= h;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.4, color: RULE });
    }
  };
  const heading = (title: string, sub?: string, ppe?: string[]) => {
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
    if (ppe?.length) {
      for (const l of wrap(`PPE: ${ppe.join(", ")}`, reg, 8.5, W - M * 2)) {
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
    heading(s.title, s.task, s.ppe);
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

  // Site checks, as answered on the phone.
  if (input.siteAnswers?.length) {
    y -= 8;
    need(40);
    t("SITE CHECKS", M, 9, bold);
    y -= 14;
    const qW = W - M * 2 - 150;
    for (const a of input.siteAnswers) {
      const ql = wrap(a.question, reg, 8.8, qW);
      const note = a.flagged ? (a.cleared ? "Flagged before, cleared by the office" : a.blocks ? "Flagged, job stopped" : "Flagged, office told") : "";
      const h = Math.max(ql.length, note ? 2 : 1) * 11 + 5;
      need(h);
      const rowTop = y;
      ql.forEach((l, i) => page.drawText(l, { x: M, y: rowTop - 9 - i * 11, size: 8.8, font: reg, color: INK }));
      const ax = W - M - 140;
      page.drawText(clean(ANSWER[a.answer] ?? a.answer), { x: ax, y: rowTop - 9, size: 8.8, font: bold, color: a.flagged ? WARN : INK });
      if (note) page.drawText(clean(note), { x: ax, y: rowTop - 20, size: 7.5, font: reg, color: a.flagged && !a.cleared ? WARN : MUTED });
      y -= h;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.4, color: RULE });
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
  need(input.gps !== undefined ? 175 : 150);
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
  if (input.gps !== undefined) {
    y -= 16;
    t("LOCATION AT SIGNING", sx, 7.5, bold, MUTED);
    y -= 11;
    const g = input.gps;
    if (g && g.status === "ok" && g.lat !== null && g.lng !== null) {
      t(`${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}${g.accuracy ? `, within ${Math.round(g.accuracy)} m` : ""}`, sx, 9.5);
    } else {
      t("Location not shared", sx, 9.5, reg, MUTED);
    }
  }

  // Footer on every page.
  const pages = doc.getPages();
  pages.forEach((pg, n) => {
    const fy = M - 6 + footH;
    pg.drawLine({ start: { x: M, y: fy }, end: { x: W - M, y: fy }, thickness: 0.5, color: RULE });
    const pageLabel = `Page ${n + 1} of ${pages.length}`;
    pg.drawText(pageLabel, { x: W - M - reg.widthOfTextAtSize(pageLabel, 7.5), y: fy - 10, size: 7.5, font: reg, color: MUTED });
    const lines = footWrapped.length ? footWrapped : [`SWMS Job ${input.jobNumber}, ${input.workDate}`];
    lines.forEach((l, i) => pg.drawText(clean(l), { x: M, y: fy - 10 - i * 8.5, size: FOOT_SIZE, font: reg, color: MUTED }));
  });

  return Buffer.from(await doc.save());
}
