/**
 * Fix list 11 Oct, item 4: the price list as an Excel file, both ways.
 * Server only. The browser sends and gets base64; exceljs never ships to it.
 */
import ExcelJS from "exceljs";
import { SHEET_COLUMNS } from "./price-sheet";

/** Text columns Excel must not turn into numbers ("00412" stays "00412"). */
const TEXT_COLS = new Set(["sku", "supplier", "brand", "range", "colour", "notes"]);
const NUMBER_COLS = new Set([
  "box_m2",
  "roll_width_m",
  "roll_length_m",
  "board_width_mm",
  "cost",
  "sell",
  "cut_price",
  "roll_price",
  "default_wastage_pct",
  "lead_time_days",
  "terra_id",
  "trim_length_m",
]);

export async function gridToXlsx(grid: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Terra Ops";
  const ws = wb.addWorksheet("Price list", { views: [{ state: "frozen", ySplit: 1 }] });
  const header = grid[0] ?? [...SHEET_COLUMNS];
  ws.columns = header.map((h) => ({
    header: h,
    key: h,
    width: h === "notes" ? 40 : ["brand", "range", "colour", "supplier"].includes(h) ? 24 : 12,
    style: TEXT_COLS.has(h) ? { numFmt: "@" } : {},
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of grid.slice(1)) {
    ws.addRow(
      r.map((v, i) => {
        const h = header[i];
        if (NUMBER_COLS.has(h) && v !== "" && Number.isFinite(Number(v))) return Number(v);
        return v;
      }),
    );
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer).toString("base64");
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "Y" : "N";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;
    if ("result" in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
  }
  return String(v);
}

/** The first sheet as rows of text, header first, same shape as a parsed CSV. */
export async function xlsxToGrid(base64: string): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  const bytes = Buffer.from(base64, "base64");
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const width = ws.getRow(1).cellCount;
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const out: string[] = [];
    for (let c = 1; c <= Math.max(width, row.cellCount); c++) out.push(cellText(row.getCell(c).value).trim());
    if (out.some((x) => x !== "")) rows.push(out);
  });
  return rows;
}
