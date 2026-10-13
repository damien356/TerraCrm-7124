import { z } from "zod";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { staffOnly } from "../middleware/auth";
import { priceProduct, todayISO, type SpecialRow } from "../lib/pricing";
import { quoteRef } from "../lib/refs";

/**
 * Fix list items 3, 4 and 18 (188001 list, 17 Oct).
 *
 * find: one search box for the supply pickers (quote and variation). Every
 * word typed has to match somewhere in brand, range, colour, supplier,
 * backing, SKU or size. Filters for type, thickness and a sell price range,
 * sorted by name, cheapest or dearest. Staff only, and no cost fields, so
 * Office can use it too.
 *
 * lastQuoted: what this range (supplier, brand and range, any colour) was
 * last quoted at, read from quote_price_history (written when a quote is
 * sent). This client first, then anyone. Cost viewers only.
 */

const SORTS = ["name", "cheapest", "dearest"] as const;

/** Lower case words, so "karndean  oak" is two words. */
export function searchWords(s: string) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 8);
}

const haystack = sql`lower(${schema.products.brand} || ' ' || ${schema.products.range} || ' ' || ${schema.products.colour} || ' ' || ${schema.products.supplier} || ' ' || ${schema.products.backing} || ' ' || coalesce(${schema.products.sku}, '') || ' ' || ${schema.products.size})`;

/** Same range: supplier (by id where there is one), brand and range. Blank range means the product alone. */
export function rangeKey(p: { id: number; supplierId: number | null; supplier: string; brand: string; range: string }) {
  if (!p.range.trim()) return `p${p.id}`;
  return [p.supplierId ?? p.supplier.trim().toLowerCase(), p.brand.trim().toLowerCase(), p.range.trim().toLowerCase()].join("|");
}

const findInput = z.object({
  search: z.string().max(200).default(""),
  category: z.string().max(60).default(""),
  /** Exact stored thickness in mm. Null = any. */
  thicknessMm: z.number().positive().max(100).nullable().default(null),
  /** Sell ex GST per unit. Null = no limit. */
  minSell: z.number().min(0).nullable().default(null),
  maxSell: z.number().min(0).nullable().default(null),
  sort: z.enum(SORTS).default("name"),
  limit: z.number().int().min(1).max(200).default(40),
});

export const productFind = {
  find: staffOnly.input(findInput).handler(async ({ input }) => {
    const clauses = [eq(schema.products.active, true)];
    if (input.category) clauses.push(eq(schema.products.category, input.category));
    for (const w of searchWords(input.search)) clauses.push(sql`${haystack} like ${`%${w}%`}`);

    const rows = await db
      .select({
        id: schema.products.id,
        supplierId: schema.products.supplierId,
        supplier: schema.products.supplier,
        brand: schema.products.brand,
        range: schema.products.range,
        colour: schema.products.colour,
        category: schema.products.category,
        unit: schema.products.unit,
        soldAs: schema.products.soldAs,
        backing: schema.products.backing,
        size: schema.products.size,
        sku: schema.products.sku,
        widthM: schema.products.widthM,
        unitsPerPack: schema.products.unitsPerPack,
        unitM2: schema.products.unitM2,
        packM2Printed: schema.products.packM2Printed,
        rollM2: schema.products.rollM2,
        thicknessMm: schema.products.thicknessMm,
        wearLayerMm: schema.products.wearLayerMm,
        costPrice: schema.products.costPrice,
        priceOnApplication: schema.products.priceOnApplication,
      })
      .from(schema.products)
      .where(and(...clauses));

    // Specials move the sell on a few lines. One read of the live ones, not one per product.
    const today = todayISO();
    const specials = new Map<number, SpecialRow[]>();
    const ids = new Set(rows.map((r) => r.id));
    if (ids.size) {
      const live = await db
        .select()
        .from(schema.productSpecials)
        .where(sql`${schema.productSpecials.cancelledAt} is null and ${schema.productSpecials.endsOn} >= ${today}`);
      for (const s of live) {
        if (!ids.has(s.productId)) continue;
        specials.set(s.productId, [...(specials.get(s.productId) ?? []), s]);
      }
    }

    const priced = rows.map(({ costPrice, ...r }) => {
      const p = priceProduct({ costPrice, priceOnApplication: r.priceOnApplication, unit: r.unit }, specials.get(r.id) ?? [], today);
      return { ...r, sellExGst: p.sellExGst, onSpecial: p.onSpecial };
    });

    // Thickness choices come from what matches the search and type, before the thickness pick itself.
    const counts = new Map<number, number>();
    for (const r of priced) if (r.thicknessMm != null) counts.set(r.thicknessMm, (counts.get(r.thicknessMm) ?? 0) + 1);
    const thicknesses = [...counts].map(([mm, n]) => ({ mm, n })).sort((a, b) => a.mm - b.mm);

    let out = priced;
    if (input.thicknessMm != null) out = out.filter((r) => r.thicknessMm != null && Math.abs(r.thicknessMm - input.thicknessMm!) < 0.001);
    if (input.minSell != null) out = out.filter((r) => r.sellExGst != null && r.sellExGst >= input.minSell! - 0.005);
    if (input.maxSell != null) out = out.filter((r) => r.sellExGst != null && r.sellExGst <= input.maxSell! + 0.005);

    const name = (r: (typeof out)[number]) => `${r.supplier} ${r.brand} ${r.range} ${r.colour}`.toLowerCase();
    out = [...out].sort((a, b) => {
      if (input.sort !== "name") {
        // No sell price goes last either way.
        if (a.sellExGst == null || b.sellExGst == null) return a.sellExGst == null ? (b.sellExGst == null ? 0 : 1) : -1;
        const d = input.sort === "cheapest" ? a.sellExGst - b.sellExGst : b.sellExGst - a.sellExGst;
        if (Math.abs(d) > 0.0001) return d;
      }
      return name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0;
    });

    return { rows: out.slice(0, input.limit), total: out.length, thicknesses };
  }),

  lastQuoted: staffOnly
    .input(
      z.object({
        productIds: z.array(z.number().int()).max(200),
        companyId: z.number().int().nullable().default(null),
        contactId: z.number().int().nullable().default(null),
        /** The quote on screen. Its own versions are never "last quoted". */
        excludeQuoteNumber: z.number().int().nullable().default(null),
      }),
    )
    .handler(async ({ input, context }) => {
      const out: Record<
        number,
        {
          last: LastQuotedRow;
          recent: LastQuotedRow[];
        }
      > = {};
      if (!context.actor.canSeeCosts || !input.productIds.length) return out;

      const asked = await db
        .select({
          id: schema.products.id,
          supplierId: schema.products.supplierId,
          supplier: schema.products.supplier,
          brand: schema.products.brand,
          range: schema.products.range,
        })
        .from(schema.products)
        .where(inArray(schema.products.id, [...new Set(input.productIds)]));
      if (!asked.length) return out;
      const ranges = [...new Set(asked.map((p) => p.range).filter((r) => r.trim()))];
      const lone = asked.filter((p) => !p.range.trim()).map((p) => p.id);

      const hist = await db
        .select({
          productId: schema.quotePriceHistory.productId,
          unit: schema.quotePriceHistory.unit,
          unitPrice: schema.quotePriceHistory.unitPrice,
          quotedAt: schema.quotePriceHistory.quotedAt,
          companyId: schema.quotePriceHistory.companyId,
          contactId: schema.quotePriceHistory.contactId,
          companyName: schema.companies.name,
          firstName: schema.contacts.firstName,
          lastName: schema.contacts.lastName,
          quoteNumber: schema.quotes.number,
          quoteVersion: schema.quotes.version,
          pid: schema.products.id,
          supplierId: schema.products.supplierId,
          supplier: schema.products.supplier,
          brand: schema.products.brand,
          range: schema.products.range,
          colour: schema.products.colour,
        })
        .from(schema.quotePriceHistory)
        .innerJoin(schema.products, eq(schema.products.id, schema.quotePriceHistory.productId))
        .leftJoin(schema.quotes, eq(schema.quotes.id, schema.quotePriceHistory.quoteId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.quotePriceHistory.companyId))
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotePriceHistory.contactId))
        .where(
          sql`(${ranges.length ? sql`${inArray(schema.products.range, ranges)}` : sql`0`} or ${lone.length ? sql`${inArray(schema.products.id, lone)}` : sql`0`})`,
        )
        .orderBy(desc(schema.quotePriceHistory.quotedAt), desc(schema.quotePriceHistory.id));

      const byKey = new Map<string, typeof hist>();
      for (const h of hist) {
        if (input.excludeQuoteNumber != null && h.quoteNumber === input.excludeQuoteNumber) continue;
        const k = rangeKey({ id: h.pid, supplierId: h.supplierId, supplier: h.supplier, brand: h.brand, range: h.range });
        byKey.set(k, [...(byKey.get(k) ?? []), h]);
      }

      const sameClient = (h: (typeof hist)[number]) =>
        input.companyId != null ? h.companyId === input.companyId : input.contactId != null && h.contactId === input.contactId && h.companyId == null;

      for (const p of asked) {
        const list = byKey.get(rangeKey(p)) ?? [];
        if (!list.length) continue;
        const shape = (h: (typeof hist)[number]): LastQuotedRow => ({
          unitPrice: h.unitPrice,
          unit: h.unit,
          quotedAt: h.quotedAt.toISOString(),
          customer: h.companyName || [h.firstName, h.lastName].filter(Boolean).join(" ").trim() || "No customer",
          quoteRef: h.quoteNumber != null ? quoteRef(h.quoteNumber, h.quoteVersion ?? 1) : "",
          colour: h.colour,
          sameProduct: h.productId === p.id,
          sameClient: sameClient(h),
        });
        const recent = list.slice(0, 5).map(shape);
        const mine = list.find(sameClient);
        out[p.id] = { last: mine ? shape(mine) : recent[0]!, recent };
      }
      return out;
    }),
};

export type LastQuotedRow = {
  unitPrice: number;
  unit: string;
  quotedAt: string;
  customer: string;
  quoteRef: string;
  colour: string;
  sameProduct: boolean;
  sameClient: boolean;
};
