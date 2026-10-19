import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { boxM2Of, FLOOR_TYPES } from "./flooring-qty";
import { wholeUnits } from "./order-sizes";

/**
 * The materials list on the crew app (notes 18.61).
 *
 * Every supply line on the job, said the way it turns up on site: the product
 * and colour, the count in the unit it is sold in (bags, boxes, rolls), the m2
 * where it is a floor, and where it is right now. Quantities only. Nothing in
 * here ever carries a price or a cost.
 */

export type CrewWhere = "on_site" | "warehouse" | "to_site" | "to_warehouse" | "to_order" | "installed" | "by_others";

export const WHERE_LABEL: Record<CrewWhere, string> = {
  on_site: "On site",
  warehouse: "In the warehouse",
  to_site: "Ordered, coming to site",
  to_warehouse: "Ordered, coming to the warehouse",
  to_order: "Still to arrive",
  installed: "Installed",
  by_others: "Supplied by others",
};

export type CrewMaterial = {
  id: number;
  /** Kept for older app builds: the whole line in one string. */
  description: string;
  /** Kept for older app builds, which show `${qty} ${unit}`. */
  qty: number;
  unit: string;
  status: string;
  original: boolean;
  /** "Sika Sikafloor Level TOP". */
  product: string;
  /** "20kg bag", blank when the product has none. */
  colour: string;
  /** "10 bags", "13 boxes", "2 rolls". */
  count: string;
  /** "39.6 m²" on floors, null otherwise. */
  m2: string | null;
  where: CrewWhere;
  whereLabel: string;
};

const FLOORS = new Set<string>([...FLOOR_TYPES, "timber", "vinyl"]);
const FLOOR_WORDS = /carpet|timber|hybrid|laminate|vinyl|plank|parquet|turf|lino|floorboard/i;
const r2 = (n: number) => Math.round(n * 100) / 100;
const plural = (n: number, one: string, many: string) => `${r2(n)} ${n === 1 ? one : many}`;

/** The word a whole-unit product comes in, read off its own name where the unit only says "each". */
function packWord(unit: string, words: string): [string, string] {
  if (unit === "box") return ["box", "boxes"];
  if (unit === "roll") return ["roll", "rolls"];
  if (unit === "pail") return ["pail", "pails"];
  if (unit === "pack") return ["pack", "packs"];
  if (unit === "sheet") return ["sheet", "sheets"];
  const w = words.toLowerCase();
  if (/\bbags?\b/.test(w)) return ["bag", "bags"];
  if (/\b(pails?|buckets?)\b/.test(w)) return ["pail", "pails"];
  if (/\b(tubes?|sausages?|cartridges?)\b/.test(w)) return ["tube", "tubes"];
  if (/\brolls?\b/.test(w)) return ["roll", "rolls"];
  if (/\b(boxes|box|cartons?)\b/.test(w)) return ["box", "boxes"];
  if (/\b(tins?|cans?)\b/.test(w)) return ["tin", "tins"];
  if (/\b(packs?|packets?)\b/.test(w)) return ["pack", "packs"];
  if (/\bsheets?\b/.test(w)) return ["sheet", "sheets"];
  if (/\b(bottles?|litres?|\d+\s?l)\b/.test(w)) return ["bottle", "bottles"];
  return ["piece", "pieces"];
}

type Product = typeof schema.products.$inferSelect;

/** The count and m2 for one line, in the unit it is bought in. */
export function crewQty(qty: number, unit: string, p: Product | null): { count: string; m2: string | null; n: number; word: string } {
  if (!p) {
    if (unit === "m2") return { count: `${r2(qty)} m²`, m2: `${r2(qty)} m²`, n: r2(qty), word: "m²" };
    if (unit === "lm") return { count: `${r2(qty)} lm`, m2: null, n: r2(qty), word: "lm" };
    const [one, many] = packWord(unit, "");
    return { count: plural(qty, one, many), m2: null, n: r2(qty), word: qty === 1 ? one : many };
  }
  const shape = {
    category: p.category,
    unit: p.unit,
    soldAs: p.soldAs,
    widthM: p.widthM,
    unitsPerPack: p.unitsPerPack,
    unitM2: p.unitM2,
    packM2Printed: p.packM2Printed,
    rollM2: p.rollM2,
    brand: p.brand,
    range: p.range,
    colour: p.colour,
    lengthMm: p.lengthMm,
    pieceLengthM: p.pieceLengthM,
    rollLengthM: p.rollLengthM,
  };

  // Floors in boxes: whole boxes, and the m2 those boxes cover.
  if (p.soldAs === "box" && unit === "m2") {
    const boxM2 = boxM2Of(shape);
    if (!boxM2) return { count: `${r2(qty)} m²`, m2: `${r2(qty)} m²`, n: r2(qty), word: "m²" };
    const boxes = Math.ceil(qty / boxM2 - 1e-9);
    const m2 = Math.floor(boxes * boxM2 * 10_000 + 1e-6) / 10_000;
    return { count: plural(boxes, "box", "boxes"), m2: `${r2(m2)} m²`, n: boxes, word: boxes === 1 ? "box" : "boxes" };
  }
  // Off the roll: carpet in lineal metres off a known width.
  if (p.soldAs === "broadloom" || (FLOORS.has(p.category) && (unit === "lm" || unit === "m2"))) {
    if (unit === "lm") {
      const m2 = p.widthM ? r2(qty * p.widthM) : null;
      const width = p.widthM ? ` off a ${r2(p.widthM)} m roll` : "";
      return { count: `${r2(qty)} lm${width}`, m2: m2 != null ? `${m2} m²` : null, n: r2(qty), word: "lm" };
    }
    return { count: `${r2(qty)} m²`, m2: `${r2(qty)} m²`, n: r2(qty), word: "m²" };
  }
  // Trims in lengths.
  if (unit === "lm") {
    const w = wholeUnits(shape, qty);
    return { count: w.note ?? `${r2(qty)} lm`, m2: null, n: r2(w.qty), word: "lm" };
  }
  if (unit === "m2") return { count: `${r2(qty)} m²`, m2: `${r2(qty)} m²`, n: r2(qty), word: "m²" };
  // Everything else comes whole: bags, pails, tubes, rolls.
  const n = Math.ceil(qty - 1e-9);
  const [one, many] = packWord(unit, `${p.colour} ${p.range} ${p.size} ${p.weight}`);
  return { count: plural(n, one, many), m2: null, n, word: n === 1 ? one : many };
}

function productName(p: Product | null, fallback: string) {
  if (!p) return fallback;
  const name = [p.brand, p.range].map((s) => (s ?? "").trim()).filter(Boolean);
  // "Sika Sika..." reads twice; keep the range when it already starts with the brand.
  if (name.length === 2 && name[1]!.toLowerCase().startsWith(name[0]!.toLowerCase())) name.shift();
  return name.join(" ") || fallback;
}

/**
 * Stock held for these lines. Terra Stock owns the table, so it is read plainly
 * and an empty list comes back if it isn't there.
 */
async function reservedFor(ids: number[]): Promise<{ jobMaterialId: number | null; status: string }[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await db.all<{ job_material_id: number | null; status: string }>(
      sql`select job_material_id, status from stock_reservations where job_material_id in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`,
    );
    return rows.map((r) => ({ jobMaterialId: r.job_material_id, status: r.status }));
  } catch {
    return [];
  }
}

/** Every supply line for these jobs, with where it is. `original` marks a callback's parent job. */
export async function crewMaterials(jobId: number, parentJobId: number | null): Promise<CrewMaterial[]> {
  const jobIds = parentJobId ? [jobId, parentJobId] : [jobId];
  const rows = await db
    .select({ m: schema.jobMaterials, p: schema.products })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(inArray(schema.jobMaterials.jobId, jobIds));

  const ids = rows.map((r) => r.m.id);
  const [poLines, reserved] = await Promise.all([
    ids.length
      ? db
          .select({ jobMaterialId: schema.purchaseOrderLines.jobMaterialId, deliverTo: schema.purchaseOrders.deliverTo })
          .from(schema.purchaseOrderLines)
          .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
          .where(and(inArray(schema.purchaseOrderLines.jobMaterialId, ids), ne(schema.purchaseOrders.status, "cancelled")))
      : Promise.resolve([]),
    reservedFor(ids),
  ]);
  const deliverTo = new Map(poLines.map((l) => [l.jobMaterialId!, l.deliverTo]));
  const held = new Set(reserved.filter((r) => r.status !== "cancelled" && r.status !== "released").map((r) => r.jobMaterialId!));

  const out: CrewMaterial[] = rows.map(({ m, p }) => {
    let where: CrewWhere;
    if (m.status === "installed") where = "installed";
    else if (m.status === "on_site") where = "on_site";
    else if (held.has(m.id)) where = "warehouse";
    else if (m.status === "ordered") where = deliverTo.get(m.id) === "site" ? "to_site" : "to_warehouse";
    else where = "to_order";
    const q = crewQty(m.qty, m.unit, p);
    const product = productName(p, m.description);
    const colour = (p?.colour ?? "").trim();
    return {
      id: m.id,
      description: [product, colour].filter(Boolean).join(", ") || m.description,
      qty: q.n,
      unit: q.word,
      status: m.status,
      original: m.jobId !== jobId,
      product,
      colour,
      count: q.count,
      m2: q.m2,
      where,
      whereLabel: WHERE_LABEL[where],
    };
  });

  // A floor the quote lays but does not supply is still on the job: the crew
  // needs to know it is coming from the builder or the client, not from us.
  const hasFloorSupply = rows.some(({ m, p }) => m.jobId === jobId && p && FLOORS.has(p.category));
  if (!hasFloorSupply) {
    const [quote] = await db
      .select({ id: schema.quotes.id })
      .from(schema.quotes)
      .where(and(eq(schema.quotes.jobId, jobId), eq(schema.quotes.status, "accepted")))
      .orderBy(desc(schema.quotes.version))
      .limit(1);
    if (quote) {
      const lines = await db
        .select({ id: schema.quoteItems.id, kind: schema.quoteItems.kind, description: schema.quoteItems.description, qty: schema.quoteItems.qty, unit: schema.quoteItems.unit })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quote.id));
      for (const l of lines) {
        if (l.kind !== "labour" || l.unit !== "m2" || !FLOOR_WORDS.test(l.description)) continue;
        const name = l.description.split(",")[0]!.trim();
        out.push({
          // Negative so it can never collide with a real material id.
          id: -l.id,
          description: `${name}, supplied by others`,
          qty: r2(l.qty),
          unit: "m²",
          status: "by_others",
          original: false,
          product: name,
          colour: "",
          count: `${r2(l.qty)} m²`,
          m2: `${r2(l.qty)} m²`,
          where: "by_others",
          whereLabel: WHERE_LABEL.by_others,
        });
      }
    }
  }
  return out;
}
