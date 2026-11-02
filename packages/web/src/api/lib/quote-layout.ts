/**
 * 188001 fix list item 1. How the client sees a quote.
 *
 *   sections  today's layout: a title, the wording and a total per section.
 *   itemised  one row per line: the product and colour, qty, unit, rate and
 *             the line total. Delivery gets its own row, last.
 *   auto      itemised when the quote is supply only, else sections.
 *
 * Supply only means the quote has lines and none of them is labour, prep or
 * removal. No server imports here, so the web app uses the same rule.
 */

import { boxM2Of } from "./flooring-qty";
import { isCountedPack, packNameOf, packsFor, packWord } from "./pack-name";

export const QUOTE_LAYOUTS = ["auto", "itemised", "sections"] as const;
export type QuoteLayout = (typeof QUOTE_LAYOUTS)[number];

export const LAYOUT_LABELS: Record<QuoteLayout, string> = {
  auto: "Auto",
  itemised: "Itemised",
  sections: "Sections",
};

const WORK = new Set(["labour", "prep", "removal"]);

export function isSupplyOnly(lines: { kind: string }[]): boolean {
  return lines.length > 0 && !lines.some((l) => WORK.has(l.kind));
}

/** The layout the client actually gets. */
export function layoutUsed(layout: string | null | undefined, lines: { kind: string }[]): "itemised" | "sections" {
  if (layout === "itemised") return "itemised";
  if (layout === "sections") return "sections";
  return isSupplyOnly(lines) ? "itemised" : "sections";
}

export type ItemRow = {
  id: number;
  description: string;
  qty: number;
  unit: string;
  /** Ex GST, per unit. */
  rate: number;
  /** Ex GST. */
  total: number;
  delivery: boolean;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type PackShape = {
  /** Pack name (2 Nov). The line is shown to the client in packs, not m2. */
  clientPacks?: boolean | null;
  packName?: string | null;
  unitsPerPack?: number | null;
  unitM2?: number | null;
  packM2Printed?: number | null;
};

/**
 * Pack name (2 Nov). A sheet, carton or bag line the office switched to
 * packs: "10 sheets at $29.62" instead of "10.8 m² at $27.43". Same total,
 * the rate is the line total over the packs. Anything else as it is.
 */
function clientQty(l: { qty: number; unit: string; total: number; unitPrice: number } & PackShape) {
  const plain = { qty: l.qty, unit: l.unit, rate: round2(l.unitPrice) };
  if (!l.clientPacks || !isCountedPack(l) || l.qty <= 0) return plain;
  const name = packNameOf(l);
  const packM2 = boxM2Of({ ...l, category: "" });
  const packs = l.unit === "m2" ? (packM2 ? packsFor(l.qty, packM2) : null) : l.unit === name || l.unit === "each" ? l.qty : null;
  if (!packs) return plain;
  return { qty: packs, unit: packWord(name, packs), rate: round2(l.total / packs) };
}

/** Rows in print order: the quote's own order, delivery last. */
export function itemRows(
  lines: ({ id: number; kind: string; description: string; qty: number; unit: string; unitPrice: number; total: number; sortOrder?: number } & PackShape)[],
): ItemRow[] {
  const ordered = [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const rows = ordered.map((l) => ({
    id: l.id,
    description: l.description,
    ...clientQty(l),
    total: round2(l.total),
    delivery: l.kind === "delivery",
  }));
  return [...rows.filter((r) => !r.delivery), ...rows.filter((r) => r.delivery)];
}

/** "82.26", "3", "2.5". */
export const qtyText = (n: number) => String(round2(n));

/** m2 reads as m². */
export const unitText = (u: string) => (u === "m2" ? "m²" : u);
