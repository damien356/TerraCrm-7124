/**
 * Fix list 11 Oct, items 4 and 5: the price list sheet, as CSV or Excel.
 *
 * Pure code. No database in here, so the preview and the confirm run the exact
 * same plan and cannot disagree. lib/price-import.ts feeds it the products and
 * suppliers and writes what it decides.
 *
 * Damien's spec (terra-price-import-spec): the columns in his order, matching on
 * sku then supplier + brand + range + colour, blank keeps the current value,
 * errors skip the row, warnings still import, nothing is written until Confirm.
 * Added on top: `terra_id` (the product's own number, so an exported sheet always
 * finds its row, even where two products share a name or a code) and
 * `trim_length_m`. Then `thickness_mm` and `wear_layer_mm` (188001 list item 4).
 * Then `board_length_mm` and `pieces_per_box` (13 Oct): with board width and
 * thickness they fill the Sizes line, "2200 x 194 x 12mm, 5 per carton".
 */
import type { products } from "../database/schema";
import { boxM2Of, floorTypeOf } from "./flooring-qty";
import { derivedBoardFields } from "./board-size";
import { carpetWidthByRule, isAccessoryCategory } from "./product-categories";
import { roundTo, sellExGst } from "./bulk-price";

export type Product = typeof products.$inferSelect;
export type SupplierLite = { id: number; name: string };

/** Damien's columns, his order, then ours at the end. */
export const SHEET_COLUMNS = [
  "sku",
  "supplier",
  "brand",
  "range",
  "colour",
  "category",
  "unit",
  "sold_as",
  "format",
  "box_m2",
  "roll_width_m",
  "roll_length_m",
  "board_width_mm",
  "board_length_mm",
  "pieces_per_box",
  "cost",
  "sell",
  "cut_price",
  "roll_price",
  "default_wastage_pct",
  "lead_time_days",
  "stocked",
  "discontinued",
  "notes",
  "terra_id",
  "trim_length_m",
  "thickness_mm",
  "wear_layer_mm",
] as const;
export type SheetColumn = (typeof SHEET_COLUMNS)[number];

/** Required on a new product. On a product already in the list a blank keeps what is there. */
const REQUIRED: SheetColumn[] = ["supplier", "brand", "range", "colour", "category", "unit", "sold_as", "format", "cost"];

/* ------------------------------- category ------------------------------- */

const CATEGORY_IN: Record<string, string> = {
  carpet: "carpet",
  carpets: "carpet",
  "broadloom carpet": "carpet",
  "outdoor carpet": "outdoor_carpet",
  "carpet tile": "carpet_tile",
  "carpet tiles": "carpet_tile",
  vinyl: "vinyl",
  "vinyl plank": "vinyl",
  "sheet vinyl": "vinyl",
  hybrid: "hybrid",
  laminate: "laminate",
  "engineered timber": "engineered_timber",
  "solid timber": "solid_timber",
  "carpet underlay": "carpet_underlay",
  "timber underlay": "hard_floor_underlay",
  "hard floor underlay": "hard_floor_underlay",
  accessories: "accessory",
  accessory: "accessory",
  turf: "turf",
  "synthetic turf": "turf",
  "sheet goods": "sheet_goods",
  plywood: "sheet_goods",
  // Import fixes 26 Oct (Damien): trims, scotia, stair nosing and skirting.
  trim: "trim",
  trims: "trim",
  scotia: "scotia",
  scotias: "scotia",
  "stair nosing": "stair_nosing",
  "stair nosings": "stair_nosing",
  "stair nose": "stair_nosing",
  nosing: "stair_nosing",
  nosings: "stair_nosing",
  skirting: "skirting",
  skirtings: "skirting",
  "skirting board": "skirting",
  "skirting boards": "skirting",
};

/** What the sheet says for a category. Damien's words where his list has one. */
export function categoryOut(p: Pick<Product, "category" | "soldAs">) {
  switch (p.category) {
    case "carpet":
      return "carpet";
    case "carpet_tile":
      return "carpet tiles";
    case "vinyl":
      return p.soldAs === "broadloom" ? "sheet vinyl" : "vinyl";
    case "hard_floor_underlay":
      return "timber underlay";
    case "accessory":
      return "accessories";
    case "trim":
      return "trims";
    case "turf":
      return "synthetic turf";
    default:
      return p.category.replace(/_/g, " ");
  }
}

/**
 * "length" (26 Oct): priced per length, the length in trim_length_m. It is
 * saved per lm (cost / length), so quotes and orders take lineal metres and
 * round up to whole lengths, "4 lengths of 3.4 m (13.6 lm)", at the same money.
 */
const UNIT_IN: Record<string, string> = {
  m2: "m2",
  "m²": "m2",
  sqm: "m2",
  lm: "lm",
  "lin m": "lm",
  each: "each",
  ea: "each",
  roll: "roll",
  length: "length",
  lengths: "length",
  "per length": "length",
  len: "length",
};

const FORMAT_IN: Record<string, "box" | "broadloom" | null> = {
  box: "box",
  broadloom: "broadloom",
  roll: null,
  each: null,
  length: null,
  lengths: null,
};
const SOLD_AS_IN = new Set(["box", "roll", "each", "broadloom", "length", "lengths"]);

const isRollGood = (p: Pick<Product, "category" | "unit" | "rollLengthM">) =>
  p.unit === "roll" || (p.rollLengthM ?? 0) > 0 || p.category === "carpet_underlay" || p.category === "hard_floor_underlay";

type FormatShape = Pick<Product, "soldAs" | "category" | "unit" | "rollLengthM"> & { pieceLengthM?: number | null };

/** A trim, scotia, nosing or skirting priced per lm and bought in whole lengths. */
const isLengthGood = (p: FormatShape) => !p.soldAs && p.unit === "lm" && isAccessoryCategory(p.category) && (p.pieceLengthM ?? 0) > 0;

export function formatOut(p: FormatShape) {
  if (p.soldAs === "box") return "Box";
  if (p.soldAs === "broadloom") return "Broadloom";
  if (isLengthGood(p)) return "Length";
  return isRollGood(p) ? "Roll" : "Each";
}

export function soldAsOut(p: FormatShape) {
  if (p.soldAs === "box") return "Box";
  if (p.soldAs === "broadloom") return "Roll";
  if (isLengthGood(p)) return "Length";
  return isRollGood(p) ? "Roll" : "Each";
}

/* ------------------------------- CSV text ------------------------------- */

/** RFC 4180, with Excel's habits: a BOM, CRLF, quoted fields with "" inside. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const csvCell = (v: string) => (/[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv(grid: string[][]) {
  return "﻿" + grid.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/* -------------------------------- export -------------------------------- */

const num = (n: number | null | undefined, places = 4) => (n == null ? "" : String(Math.round(n * 10 ** places) / 10 ** places));
const yn = (b: boolean) => (b ? "Y" : "N");

/** One product as a sheet row, in SHEET_COLUMNS order. */
export function productRow(p: Product): string[] {
  const cells: Record<SheetColumn, string> = {
    sku: p.sku ?? "",
    supplier: p.supplier,
    brand: p.brand,
    range: p.range,
    colour: p.colour,
    category: categoryOut(p),
    unit: p.unit,
    sold_as: soldAsOut(p),
    format: formatOut(p),
    box_m2: num(boxM2Of(p)),
    roll_width_m: num(p.widthM),
    roll_length_m: num(p.rollLengthM),
    board_width_mm: num(p.widthMm),
    board_length_mm: num(p.lengthMm),
    pieces_per_box: p.unitsPerPack == null ? "" : String(p.unitsPerPack),
    cost: num(p.costPrice),
    sell: num(p.sellPrice),
    cut_price: num(p.cutCostPrice),
    roll_price: num(p.rollPrice),
    default_wastage_pct: num(p.defaultWastagePct),
    lead_time_days: p.leadTimeDays == null ? "" : String(p.leadTimeDays),
    stocked: yn(p.heldInWarehouse),
    discontinued: yn(!p.active),
    notes: p.notes,
    terra_id: String(p.id),
    trim_length_m: num(p.pieceLengthM),
    thickness_mm: num(p.thicknessMm),
    wear_layer_mm: num(p.wearLayerMm),
  };
  return SHEET_COLUMNS.map((c) => cells[c]);
}

export function exportGrid(list: Product[]): string[][] {
  return [[...SHEET_COLUMNS], ...list.map(productRow)];
}

/* --------------------------------- plan --------------------------------- */

/** Product fields the sheet can set. */
export type Patch = Partial<{
  supplierId: number | null;
  supplier: string;
  brand: string;
  range: string;
  colour: string;
  category: string;
  unit: string;
  soldAs: "box" | "broadloom" | null;
  sku: string | null;
  packM2Printed: number | null;
  widthM: number | null;
  rollLengthM: number | null;
  widthMm: number | null;
  lengthMm: number | null;
  unitsPerPack: number | null;
  /** Worked out, never typed: length x width of one board, and the size text. */
  unitM2: number | null;
  size: string;
  costPrice: number | null;
  sellPrice: number | null;
  cutCostPrice: number | null;
  rollPrice: number | null;
  defaultWastagePct: number | null;
  leadTimeDays: number | null;
  heldInWarehouse: boolean;
  active: boolean;
  notes: string;
  pieceLengthM: number | null;
  thicknessMm: number | null;
  wearLayerMm: number | null;
}>;
type PatchKey = keyof Patch;

export const FIELD_LABELS: Record<PatchKey, string> = {
  supplierId: "Supplier",
  supplier: "Supplier",
  brand: "Brand",
  range: "Range",
  colour: "Colour",
  category: "Category",
  unit: "Unit",
  soldAs: "Format",
  sku: "SKU",
  packM2Printed: "Box m²",
  widthM: "Roll width (m)",
  rollLengthM: "Roll length (m)",
  widthMm: "Board width (mm)",
  lengthMm: "Board length (mm)",
  unitsPerPack: "Pieces per box",
  unitM2: "Board m²",
  size: "Size",
  costPrice: "Cost",
  sellPrice: "Sell",
  cutCostPrice: "Cut price",
  rollPrice: "Roll price",
  defaultWastagePct: "Wastage %",
  leadTimeDays: "Lead time (days)",
  heldInWarehouse: "Stocked",
  active: "Discontinued",
  notes: "Notes",
  pieceLengthM: "Trim length (m)",
  thicknessMm: "Thickness (mm)",
  wearLayerMm: "Wear layer (mm)",
};

export const PRICE_FIELDS: PatchKey[] = ["costPrice", "sellPrice", "cutCostPrice", "rollPrice"];

export type Change = { field: PatchKey; label: string; from: string; to: string; price: boolean };

export type PlanUpdate = {
  row: number;
  productId: number;
  name: string;
  before: Patch;
  after: Patch;
  changes: Change[];
  warnings: string[];
  discontinues: boolean;
};

export type PlanCreate = {
  row: number;
  name: string;
  values: Patch & { supplierId: number; supplier: string };
  warnings: string[];
};

export type RowProblem = { row: number; name: string; message: string };

export type Plan = {
  updates: PlanUpdate[];
  creates: PlanCreate[];
  unchanged: number;
  errors: RowProblem[];
  warnings: RowProblem[];
  /** Whole-file problems: no header, a required column missing. Nothing imports. */
  fileErrors: string[];
  ignoredColumns: string[];
  totalRows: number;
  /** Changes when anything about what would be written changes. Confirm checks it. */
  hash: string;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const nameOf = (p: { brand?: string; range?: string; colour?: string }) =>
  [p.brand, p.range, p.colour].filter((x) => x && x.trim()).join(" ").trim() || "(no name)";
const keyOf = (brand: string, range: string, colour: string) => `${norm(brand)}|${norm(range)}|${norm(colour)}`;

const money = (n: number | null | undefined) => (n == null ? "none" : `$${n.toFixed(2)}`);

function show(field: PatchKey, v: unknown, suppliers: Map<number, string>): string {
  if (v === null || v === undefined || v === "") return "blank";
  if (field === "active") return v ? "N" : "Y";
  if (field === "heldInWarehouse") return v ? "Y" : "N";
  if (field === "supplierId") return suppliers.get(Number(v)) ?? `#${v}`;
  if (field === "soldAs") return v === "box" ? "Box" : v === "broadloom" ? "Broadloom" : String(v);
  if ((PRICE_FIELDS as string[]).includes(field)) return money(Number(v));
  return String(v);
}

/** Header cell to column name: "Roll width (m)" style headers are not ours, but "Roll Width M" is. */
const headerKey = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Text in a number cell: "$1,234.50" is fine, "about 4" is not. */
function parseNum(raw: string): number | "bad" | null {
  const s = raw.trim().replace(/^\$/, "").replace(/,/g, "").replace(/%$/, "").trim();
  if (s === "") return null;
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return "bad";
  const n = Number(s);
  return Number.isFinite(n) ? n : "bad";
}

function parseYn(raw: string): boolean | "bad" | null {
  const s = raw.trim().toLowerCase();
  if (s === "") return null;
  if (["y", "yes", "true", "1"].includes(s)) return true;
  if (["n", "no", "false", "0"].includes(s)) return false;
  return "bad";
}

/** Small string hash. Not security, just "is this still the same plan". */
function hashOf(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length.toString(36);
}

const same = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.0005;
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === "")) return true;
  return a === b;
};

type Index = {
  byId: Map<number, Product>;
  bySupplier: Map<string, { sku: Map<string, Product[]>; key: Map<string, Product[]> }>;
};

function buildIndex(list: Product[]): Index {
  const byId = new Map<number, Product>();
  const bySupplier: Index["bySupplier"] = new Map();
  const push = (m: Map<string, Product[]>, k: string, p: Product) => {
    const l = m.get(k);
    if (l) l.push(p);
    else m.set(k, [p]);
  };
  for (const p of list) {
    byId.set(p.id, p);
    const sk = p.supplierId != null ? `s:${p.supplierId}` : `n:${norm(p.supplier)}`;
    let g = bySupplier.get(sk);
    if (!g) bySupplier.set(sk, (g = { sku: new Map(), key: new Map() }));
    if (p.sku && p.sku.trim()) push(g.sku, norm(p.sku), p);
    push(g.key, keyOf(p.brand, p.range, p.colour), p);
  }
  return { byId, bySupplier };
}

function lookup(ix: Index, sup: SupplierLite, pick: "sku" | "key", k: string): Product[] {
  const a = ix.bySupplier.get(`s:${sup.id}`)?.[pick].get(k) ?? [];
  const b = ix.bySupplier.get(`n:${norm(sup.name)}`)?.[pick].get(k) ?? [];
  return [...a, ...b];
}

/** Weld rod comes on a coil, not in lengths. Same test as order-sizes. */
const isCoil = (p: Partial<Product>) => (p.lengthMm ?? 0) > 0 || /weld\s*rod/i.test(`${p.brand ?? ""} ${p.range ?? ""} ${p.colour ?? ""}`);

/**
 * Sizes the quote maths needs. Spec: missing size = flag it and ask, never guess.
 * Import fixes 26 Oct, item 5: box_m2 is only asked for on a boxed FLOOR. A trim,
 * scotia or anything sold each never needs one.
 */
function sizeWarnings(p: Patch & { category?: string; unit?: string }, merged: Partial<Product>): string[] {
  const out: string[] = [];
  if (merged.soldAs === "box" && floorTypeOf(merged as Product) && !boxM2Of(merged as Product))
    out.push("No box size (box_m2). Quotes will flag it and not round to whole boxes.");
  if (merged.unit === "lm" && !merged.soldAs && isAccessoryCategory(merged.category) && !(merged.pieceLengthM && merged.pieceLengthM > 0) && !isCoil(merged))
    out.push("No length size (trim_length_m). Quotes will flag it and not round to whole lengths.");
  if (merged.soldAs === "broadloom" && !(merged.widthM && merged.widthM > 0))
    out.push("No roll width (roll_width_m). Quotes will ask for it.");
  if (merged.category === "carpet_underlay" && !(merged.widthM && merged.widthM > 0))
    out.push("Carpet underlay with no roll width. Quotes cannot work out the metres.");
  if (p.unit === "roll" && !(merged.rollLengthM && merged.rollLengthM > 0)) out.push("Sold by the roll with no roll length.");
  return out;
}

/** Quotes use boards x board m² when both are known, so a box_m2 that disagrees is only kept on file. */
function boxMismatch(p: Partial<Product>): string[] {
  if (!p.packM2Printed || !p.unitsPerPack || !p.unitM2) return [];
  const box = boxM2Of(p as Product);
  if (box == null || Math.abs(box - p.packM2Printed) / box < 0.01) return [];
  return [`Box size comes from ${p.unitsPerPack} boards x ${p.unitM2} m², so box_m2 ${p.packM2Printed} is saved but quotes use ${box} m².`];
}

type UnitSizes = Partial<Pick<Product, "category" | "unit" | "soldAs" | "rollLengthM" | "widthM" | "pieceLengthM" | "unitsPerPack" | "unitM2" | "packM2Printed">>;

const unitWord = (u: string) => (u === "m2" ? "m²" : u);
const perUnit = (u: string) => (u === "each" ? "each" : `a ${unitWord(u)}`);

/**
 * How many `to` units one `from` unit holds, off the sizes on file: a 50 m x
 * 1.1 m roll is 55 m², one 3.4 m length is 3.4 lm. Null when they do not convert.
 */
export function unitsIn(from: string, to: string, s: UnitSizes): { n: number; how: string } | null {
  if (from === to) return { n: 1, how: "" };
  const L = s.rollLengthM && s.rollLengthM > 0 ? s.rollLengthM : null;
  const W = s.widthM && s.widthM > 0 ? s.widthM : null;
  const piece = s.pieceLengthM && s.pieceLengthM > 0 ? s.pieceLengthM : null;
  const box = s.soldAs === "box" ? boxM2Of(s as Product) : null;
  const f = (a: string, b: string): { n: number; how: string } | null => {
    if (a === "roll" && b === "m2" && L && W) return { n: L * W, how: `${L} m x ${W} m roll` };
    if (a === "roll" && b === "lm" && L) return { n: L, how: `${L} m roll` };
    if (a === "lm" && b === "m2" && W) return { n: W, how: `${W} m wide` };
    if (a === "each" && b === "lm" && piece) return { n: piece, how: `one ${piece} m length` };
    if ((a === "each" || a === "box") && b === "m2" && box) return { n: box, how: `${box} m² a box` };
    return null;
  };
  const there = f(from, to);
  if (there) return there;
  const back = f(to, from);
  return back ? { n: 1 / back.n, how: back.how } : null;
}

/**
 * Import fixes 26 Oct, item 3. A cost that moves with its unit (per roll to per
 * m²) is compared like for like, not called a 98% drop.
 */
function costWarnings(old: (UnitSizes & { costPrice?: number | null }) | null, merged: UnitSizes & { costPrice?: number | null; sellPrice?: number | null }): string[] {
  const cost = merged.costPrice;
  const unitMoved = !!old && !!old.unit && !!merged.unit && old.unit !== merged.unit;
  if (!unitMoved) return priceWarnings(old?.costPrice, cost, merged.sellPrice);
  const out: string[] = [];
  const from = old!.unit!;
  const to = merged.unit!;
  const oldCost = old!.costPrice;
  const conv = unitsIn(from, to, { ...old, ...merged });
  if (oldCost == null || cost == null) out.push(`Unit changed from ${unitWord(from)} to ${unitWord(to)}.`);
  else if (!conv) {
    out.push(`Unit changed from ${unitWord(from)} to ${unitWord(to)}, so the cost is not compared: was ${money(oldCost)} ${perUnit(from)}, now ${money(cost)} ${perUnit(to)}.`);
  } else {
    const like = oldCost / conv.n;
    const pct = like > 0 ? ((cost - like) / like) * 100 : 0;
    const move = Math.abs(pct) < 0.5 ? "the same like for like" : `${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% like for like`;
    out.push(
      `Unit changed from ${unitWord(from)} to ${unitWord(to)}. ${money(oldCost)} ${perUnit(from)} is ${money(like)} ${perUnit(to)} (${conv.how}). Now ${money(cost)} ${perUnit(to)}, ${move}.`,
    );
  }
  return [...out, ...priceWarnings(null, cost, merged.sellPrice)];
}

function priceWarnings(oldCost: number | null | undefined, cost: number | null | undefined, sell: number | null | undefined): string[] {
  const out: string[] = [];
  if (oldCost != null && oldCost > 0 && cost != null && Math.abs(cost - oldCost) / oldCost > 0.1) {
    const pct = ((cost - oldCost) / oldCost) * 100;
    out.push(`Cost ${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% (${money(oldCost)} to ${money(cost)}).`);
  }
  if (cost != null && sell != null) {
    if (sell < cost) out.push(`Sell ${money(sell)} is below cost ${money(cost)}.`);
    else if (sell > 0 && ((sell - cost) / sell) * 100 < 20) out.push(`Margin ${(((sell - cost) / sell) * 100).toFixed(0)}%, under 20%.`);
  }
  return out;
}

/**
 * The whole plan for one sheet. `grid` is the file as rows of text, header first
 * (CSV parsed, or the first Excel sheet read as text).
 */
export function planImport(grid: string[][], productsList: Product[], suppliers: SupplierLite[]): Plan {
  const plan: Plan = {
    updates: [],
    creates: [],
    unchanged: 0,
    errors: [],
    warnings: [],
    fileErrors: [],
    ignoredColumns: [],
    totalRows: Math.max(0, grid.length - 1),
    hash: "",
  };
  const supNames = new Map(suppliers.map((s) => [s.id, s.name]));
  const supByName = new Map(suppliers.map((s) => [norm(s.name), s]));

  const header = (grid[0] ?? []).map(headerKey);
  if (!header.length) {
    plan.fileErrors.push("The file is empty.");
    return finish(plan);
  }
  const col = new Map<SheetColumn, number>();
  header.forEach((h, i) => {
    if ((SHEET_COLUMNS as readonly string[]).includes(h) && !col.has(h as SheetColumn)) col.set(h as SheetColumn, i);
    else if (h) plan.ignoredColumns.push(grid[0][i]);
  });
  const missing = REQUIRED.filter((c) => !col.has(c));
  if (missing.length) {
    plan.fileErrors.push(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Start from Download template.`);
    return finish(plan);
  }

  const ix = buildIndex(productsList);
  const claimed = new Map<number, number>(); // productId -> sheet row
  const newKeys = new Map<string, number>();

  for (let r = 1; r < grid.length; r++) {
    const rowNo = r + 1; // as Excel numbers it, header is row 1
    const raw = grid[r];
    const cell = (c: SheetColumn) => {
      const i = col.get(c);
      return i === undefined ? "" : String(raw[i] ?? "").trim();
    };
    const label = nameOf({ brand: cell("brand"), range: cell("range"), colour: cell("colour") });
    const problems: string[] = [];

    // ---- numbers and flags first, so a typo is an error, not a silent blank
    const nums: Partial<Record<SheetColumn, number | null>> = {};
    for (const c of [
      "box_m2",
      "roll_width_m",
      "roll_length_m",
      "board_width_mm",
      "board_length_mm",
      "pieces_per_box",
      "cost",
      "sell",
      "cut_price",
      "roll_price",
      "default_wastage_pct",
      "lead_time_days",
      "trim_length_m",
      "thickness_mm",
      "wear_layer_mm",
      "terra_id",
    ] as SheetColumn[]) {
      const v = parseNum(cell(c));
      if (v === "bad") problems.push(`${c} "${cell(c)}" is not a number`);
      else if (v !== null && v < 0) problems.push(`${c} cannot be negative`);
      else nums[c] = v;
    }
    const wp = nums.default_wastage_pct;
    if (wp != null && wp > 100) problems.push("default_wastage_pct is over 100");
    for (const c of ["thickness_mm", "wear_layer_mm"] as const) {
      const v = nums[c];
      if (v != null && v > 100) problems.push(`${c} is over 100 mm`);
    }
    const ppb = nums.pieces_per_box;
    if (ppb != null && (ppb < 1 || Math.abs(ppb - Math.round(ppb)) > 1e-9)) problems.push(`pieces_per_box "${cell("pieces_per_box")}" should be a whole number, 1 or more`);
    const flags: Partial<Record<"stocked" | "discontinued", boolean | null>> = {};
    for (const c of ["stocked", "discontinued"] as const) {
      const v = parseYn(cell(c));
      if (v === "bad") problems.push(`${c} "${cell(c)}" should be Y or N`);
      else flags[c] = v;
    }

    const catRaw = norm(cell("category")).replace(/_/g, " ");
    const category = catRaw ? CATEGORY_IN[catRaw] : undefined;
    if (catRaw && !category) {
      problems.push(
        catRaw === "timber" || catRaw === "underlay"
          ? `category "${cell("category")}": say which kind (${catRaw === "timber" ? "engineered timber or solid timber" : "carpet underlay or timber underlay"})`
          : `unknown category "${cell("category")}"`,
      );
    }
    const unitRaw = norm(cell("unit"));
    const unit = unitRaw ? UNIT_IN[unitRaw] : undefined;
    if (unitRaw && !unit) problems.push(`unknown unit "${cell("unit")}" (use m2, lm, each, roll or length)`);
    const fmtRaw = norm(cell("format"));
    if (fmtRaw && !(fmtRaw in FORMAT_IN)) problems.push(`unknown format "${cell("format")}" (use Box, Broadloom, Roll, Each or Length)`);
    const soldRaw = norm(cell("sold_as"));
    if (soldRaw && !SOLD_AS_IN.has(soldRaw)) problems.push(`unknown sold_as "${cell("sold_as")}" (use Box, Roll, Each or Length)`);

    // ---- which product is this row?
    const supRaw = cell("supplier");
    const sup = supRaw ? supByName.get(norm(supRaw)) : undefined;
    let match: Product | undefined;
    let matchProblem = "";
    /** Said about the match, shown with the row's warnings. */
    const matchNotes: string[] = [];
    const tid = nums.terra_id;
    const sku = norm(cell("sku"));
    const key = keyOf(cell("brand"), cell("range"), cell("colour"));
    const byName = (s: SupplierLite) => {
      let hits = sku ? lookup(ix, s, "sku", sku) : [];
      if (hits.length > 1) {
        const narrowed = hits.filter((p) => keyOf(p.brand, p.range, p.colour) === key);
        hits = narrowed.length ? narrowed : hits;
      }
      if (!hits.length && key !== "||") hits = lookup(ix, s, "key", key);
      return hits;
    };
    const many = (hits: Product[]) =>
      `matches ${hits.length} products (ids ${hits.slice(0, 5).map((p) => p.id).join(", ")}${hits.length > 5 ? "..." : ""}). Add terra_id to pick one`;
    if (tid != null) {
      match = ix.byId.get(Math.round(tid));
      if (match) {
        // A terra_id copied down from the row above points at the wrong product.
        // Catch it when the row's own SKU or name belongs to a different one.
        const s = sup ?? (match.supplierId != null ? { id: match.supplierId, name: match.supplier } : null);
        const other = s ? byName(s).filter((p) => p.id !== match!.id) : [];
        const skuDiffers = !!sku && !!match.sku && norm(match.sku) !== sku;
        const nameDiffers = key !== "||" && keyOf(match.brand, match.range, match.colour) !== key;
        if (other.length && (skuDiffers || nameDiffers)) {
          matchProblem = `terra_id ${cell("terra_id")} is ${match.sku ? `${match.sku} ` : ""}${nameOf(match)}, but this row's ${skuDiffers ? `SKU ${cell("sku")}` : "name"} is id ${other[0].id} (${nameOf(other[0])}). Fix the terra_id or clear it`;
          match = undefined;
        }
      } else if (sup) {
        // Deleted since the sheet was made. Find it by SKU or name, or add it new.
        const hits = byName(sup);
        if (hits.length > 1) matchProblem = `terra_id ${cell("terra_id")} is not in the price list any more, and the SKU or name ${many(hits)}`;
        else if (hits.length === 1) {
          match = hits[0];
          matchNotes.push(`terra_id ${cell("terra_id")} is not in the price list any more. Matched on ${sku ? "SKU" : "name"} to id ${match.id} instead.`);
        } else matchNotes.push(`terra_id ${cell("terra_id")} is not in the price list any more (deleted), so this row adds it as a new product.`);
      } else matchProblem = `terra_id ${cell("terra_id")} is not in the price list (deleted?), and supplier is blank so it cannot be added again. Fill in supplier or clear the terra_id`;
    } else if (sup) {
      const hits = byName(sup);
      if (hits.length > 1) matchProblem = many(hits);
      else match = hits[0];
    }
    if (matchProblem) problems.push(matchProblem);

    // ---- supplier: must be a known one, unless this is the product's own current name
    if (!supRaw && !match) problems.push("supplier is blank");
    else if (supRaw && !sup && !(match && norm(match.supplier) === norm(supRaw))) problems.push(`unknown supplier "${supRaw}"`);

    if (!match && !matchProblem) {
      // unit length says the format itself, so sold_as and format can be left blank
      const blank = REQUIRED.filter((c) => cell(c) === "" && !(unit === "length" && (c === "sold_as" || c === "format")));
      if (blank.length) problems.push(`new product needs ${blank.join(", ")}`);
    }
    if (match) {
      const prev = claimed.get(match.id);
      if (prev) problems.push(`row ${prev} already updates this product (id ${match.id}, ${nameOf(match)}). Check the terra_id and SKU on both rows`);
    }

    // ---- unit and format that go together (26 Oct: "length")
    const fmtLength = fmtRaw === "length" || fmtRaw === "lengths";
    const pieceLen = nums.trim_length_m ?? match?.pieceLengthM ?? null;
    const unitNow = unit ?? match?.unit;
    // Priced per length: unit length, or format Length on a unit each row.
    const byLength = unit === "length" || (fmtLength && unitNow === "each");
    if (byLength) {
      if (!(pieceLen && pieceLen > 0))
        problems.push(`${unit === "length" ? "unit length" : "format Length with unit each"} needs trim_length_m, how long one length is (e.g. 3.4)`);
      if (fmtRaw && !fmtLength) problems.push(`unit length goes with format Length, not "${cell("format")}"`);
    } else if (fmtLength) {
      if (unitNow && unitNow !== "lm") problems.push(`format Length goes with unit length, lm or each, not "${unitWord(unitNow)}"`);
    }

    if (problems.length) {
      plan.errors.push({ row: rowNo, name: label, message: problems.join("; ") + "." });
      continue;
    }

    // ---- what the row says, blanks left out
    const said: Patch = {};
    // a product with no supplier link but the same supplier name is left as it is
    const sameUnlinked = !!match && match.supplierId == null && !!sup && norm(match.supplier) === norm(sup.name);
    if (sup && !sameUnlinked && (!match || match.supplierId !== sup.id)) {
      said.supplierId = sup.id;
      said.supplier = sup.name;
    }
    for (const [c, f] of [
      ["brand", "brand"],
      ["range", "range"],
      ["colour", "colour"],
      ["notes", "notes"],
    ] as const) {
      if (cell(c) !== "") said[f] = cell(c);
    }
    if (cell("sku") !== "") said.sku = cell("sku");
    if (category) said.category = category;
    if (unit) said.unit = unit;
    if (fmtRaw) said.soldAs = FORMAT_IN[fmtRaw];
    const numField: [SheetColumn, PatchKey, number][] = [
      ["box_m2", "packM2Printed", 4],
      ["roll_width_m", "widthM", 4],
      ["roll_length_m", "rollLengthM", 4],
      ["board_width_mm", "widthMm", 2],
      ["board_length_mm", "lengthMm", 2],
      ["cost", "costPrice", 4],
      ["cut_price", "cutCostPrice", 4],
      ["roll_price", "rollPrice", 4],
      ["default_wastage_pct", "defaultWastagePct", 2],
      ["trim_length_m", "pieceLengthM", 4],
      ["thickness_mm", "thicknessMm", 2],
      ["wear_layer_mm", "wearLayerMm", 2],
    ];
    for (const [c, f, places] of numField) {
      const v = nums[c];
      if (v != null) (said as Record<string, number>)[f] = Math.round(v * 10 ** places) / 10 ** places;
    }
    if (nums.lead_time_days != null) said.leadTimeDays = Math.round(nums.lead_time_days);
    if (ppb != null) said.unitsPerPack = Math.round(ppb);
    if (flags.stocked != null) said.heldInWarehouse = flags.stocked;
    if (flags.discontinued != null) said.active = !flags.discontinued;

    // Sell: the file's number, rounded to 10c when it is a new number.
    // The same number as now is left alone (most sells are to the cent).
    let sellIn = nums.sell;
    /** Said about how the row was saved, shown with the row's warnings. */
    const saveNotes: string[] = [...matchNotes];

    // Priced per length (26 Oct, item 4): saved per lm, the length kept, so quotes
    // take lineal metres and round up to whole lengths at the same money.
    let perLm = false;
    if (byLength && pieceLen && pieceLen > 0) {
      const len = Math.round(pieceLen * 1e4) / 1e4;
      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      said.unit = "lm";
      said.soldAs = null;
      said.pieceLengthM = len;
      // a length is not a box: drop the box size a boxed row carried (box_m2 1, 1 a box)
      if (match?.soldAs === "box") {
        if (match.packM2Printed != null) said.packM2Printed = null;
        if (match.unitsPerPack != null) said.unitsPerPack = null;
      }
      const bits: string[] = [];
      if (nums.cost != null) {
        said.costPrice = r4(nums.cost / len);
        bits.push(`cost ${money(nums.cost)} a ${len} m length is ${money(said.costPrice)}/lm`);
      }
      if (nums.cut_price != null) said.cutCostPrice = r4(nums.cut_price / len);
      if (sellIn != null) {
        sellIn = r4(sellIn / len);
        bits.push(`sell ${money(nums.sell)} a length is ${money(sellIn)}/lm`);
      }
      perLm = true;
      saveNotes.push(`Saved per lm in ${len} m lengths${bits.length ? `: ${bits.join(", ")}` : ""}.`);
    }
    // A sell worked out per lm is kept to the cent fraction, not rounded to 10c,
    // so a length still costs what the sheet says.
    const sellRound = (n: number) => (perLm ? n : roundTo(n, "10c"));

    if (match) {
      claimed.set(match.id, rowNo);
      if (sellIn != null && !same(sellIn, match.sellPrice)) said.sellPrice = sellRound(sellIn);
      // Item 2, 26 Oct: a roll product moved to m² or lm keeps its full roll price
      // on file, so orders still know what a roll costs.
      if (match.unit === "roll" && said.unit && said.unit !== "roll" && match.rollPrice == null && said.rollPrice === undefined && match.costPrice != null) {
        said.rollPrice = match.costPrice;
        saveNotes.push(`Roll price kept: ${money(match.costPrice)} a roll (the old cost), with the roll size on file.`);
      }
      // Box size: compare against the size quotes actually use.
      // An exported sheet says boards x board m², which can be a hair off the printed figure.
      if (said.packM2Printed != null && (same(said.packM2Printed, boxM2Of(match)) || same(said.packM2Printed, match.packM2Printed)))
        delete said.packM2Printed;
      // The Sizes line: size text and board m² from length x width (x thickness),
      // when the row moves one of them. An exported sheet sent back changes nothing.
      const m = match;
      if ((["lengthMm", "widthMm", "thicknessMm"] as const).some((k) => said[k] !== undefined && !same(said[k], m[k])))
        Object.assign(said, derivedBoardFields(m, said));

      const before: Patch = {};
      const after: Patch = {};
      const changes: Change[] = [];
      for (const k of Object.keys(said) as PatchKey[]) {
        const now = (match as Record<string, unknown>)[k];
        const next = said[k];
        if (k === "supplier" && said.supplierId !== undefined) {
          (before as Record<string, unknown>)[k] = now;
          (after as Record<string, unknown>)[k] = next;
          continue; // shown once, as the supplier id
        }
        if (same(now, next)) continue;
        (before as Record<string, unknown>)[k] = now ?? null;
        (after as Record<string, unknown>)[k] = next;
        changes.push({
          field: k,
          label: FIELD_LABELS[k],
          from: show(k, now, supNames),
          to: show(k, next, supNames),
          price: PRICE_FIELDS.includes(k),
        });
      }
      if (!changes.length) {
        plan.unchanged++;
        continue;
      }
      const merged = { ...match, ...after } as Product;
      const warnings = [
        ...saveNotes,
        ...costWarnings(match, merged),
        ...(after.soldAs !== undefined ||
        after.packM2Printed !== undefined ||
        after.widthM !== undefined ||
        after.unit !== undefined ||
        after.unitsPerPack !== undefined ||
        after.unitM2 !== undefined
          ? sizeWarnings(after, merged)
          : []),
        ...(after.packM2Printed !== undefined || after.unitsPerPack !== undefined || after.unitM2 !== undefined ? boxMismatch(merged) : []),
      ];
      plan.updates.push({
        row: rowNo,
        productId: match.id,
        name: nameOf(merged),
        before,
        after,
        changes,
        warnings,
        discontinues: after.active === false,
      });
      for (const w of warnings) plan.warnings.push({ row: rowNo, name: nameOf(merged), message: w });
      continue;
    }

    // ---- new product
    const s = sup as SupplierLite;
    const dupKey = `${s.id}|${keyOf(cell("brand"), cell("range"), cell("colour"))}`;
    const dupSku = said.sku ? `${s.id}|sku|${norm(said.sku)}` : "";
    const prevRow = newKeys.get(dupKey) ?? (dupSku ? newKeys.get(dupSku) : undefined);
    if (prevRow) {
      plan.errors.push({ row: rowNo, name: label, message: `Same new product as row ${prevRow}. Skipped.` });
      continue;
    }
    newKeys.set(dupKey, rowNo);
    if (dupSku) newKeys.set(dupSku, rowNo);

    const cost = said.costPrice ?? null;
    const values: PlanCreate["values"] = {
      ...said,
      supplierId: s.id,
      supplier: s.name,
      sellPrice: sellIn != null ? sellRound(sellIn) : cost != null ? roundTo(sellExGst(cost), "10c") : null,
    };
    values.widthM = values.widthM ?? carpetWidthByRule({ category: values.category ?? "", supplier: s.name, brand: values.brand, range: values.range });
    // Trims come in 2.4 m lengths (Damien, 11 Oct). Weld rod is sold by the metre off a reel.
    if (values.pieceLengthM == null && (values.category === "accessory" || values.category === "trim") && values.unit === "lm" && !/weld/i.test(`${values.range} ${values.colour}`)) {
      values.pieceLengthM = 2.4;
    }
    Object.assign(values, derivedBoardFields({}, values));
    const warnings = [
      ...saveNotes,
      ...priceWarnings(null, cost, values.sellPrice),
      ...sizeWarnings(values, values as Partial<Product>),
      ...boxMismatch(values as Partial<Product>),
    ];
    plan.creates.push({ row: rowNo, name: label, values, warnings });
    for (const w of warnings) plan.warnings.push({ row: rowNo, name: label, message: w });
  }
  return finish(plan);
}

function finish(plan: Plan): Plan {
  plan.hash = hashOf(
    JSON.stringify([
      plan.updates.map((u) => [u.productId, u.before, u.after]),
      plan.creates.map((c) => c.values),
      plan.fileErrors,
    ]),
  );
  return plan;
}

export function planCounts(plan: Plan) {
  const discontinued = plan.updates.filter((u) => u.discontinues).length;
  return {
    rows: plan.totalRows,
    updated: plan.updates.length - discontinued,
    created: plan.creates.length,
    discontinued,
    unchanged: plan.unchanged,
    errors: plan.errors.length,
    warnings: plan.warnings.length,
  };
}
