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

/** Rows in print order: the quote's own order, delivery last. */
export function itemRows(
  lines: { id: number; kind: string; description: string; qty: number; unit: string; unitPrice: number; total: number; sortOrder?: number }[],
): ItemRow[] {
  const ordered = [...lines].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
  const rows = ordered.map((l) => ({
    id: l.id,
    description: l.description,
    qty: l.qty,
    unit: l.unit,
    rate: round2(l.unitPrice),
    total: round2(l.total),
    delivery: l.kind === "delivery",
  }));
  return [...rows.filter((r) => !r.delivery), ...rows.filter((r) => r.delivery)];
}

/** "82.26", "3", "2.5". */
export const qtyText = (n: number) => String(round2(n));

/** m2 reads as m². */
export const unitText = (u: string) => (u === "m2" ? "m²" : u);
