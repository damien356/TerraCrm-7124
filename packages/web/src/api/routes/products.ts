import { z } from "zod";
import { and, asc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import {
  ENDING_SOON_DAYS,
  daysBetween,
  isSpecialLive,
  packM2,
  perM2FromPerLm,
  priceProduct,
  cutRateFor,
  resolveRollCut,
  m2FromLm,
  lmForQty,
  m2ForQty,
  sellExGst,
  round2,
  todayISO,
  type SpecialRow,
} from "../lib/pricing";
import { editedCost, specialCost } from "../lib/bulk-price";

/**
 * The price book: one row per buyable variant, with dated specials on top.
 *
 * A special is never written into the product row, so an expired clearance
 * cannot keep quoting itself. Every read resolves the live price against
 * today's Brisbane date and falls back to the supplier's standard price the
 * day after the window closes. `specialsBoard` is what warns the office before
 * that happens.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = z.string().regex(ISO_DATE, "Use YYYY-MM-DD");

const SPECIAL_KINDS = ["clearance", "run_out", "promo", "negotiated"] as const;

async function logProduct(productId: number, action: string, detail: string, actorName: string) {
  await db.insert(schema.activityLog).values({
    entityType: "product",
    entityId: productId,
    action,
    detail,
    actorName,
    actorRole: "admin",
  });
}

/** Every special for the given products, keyed by product id. */
async function specialsFor(productIds: number[]): Promise<Map<number, SpecialRow[]>> {
  const map = new Map<number, SpecialRow[]>();
  if (!productIds.length) return map;
  const rows = await db
    .select()
    .from(schema.productSpecials)
    .where(inArray(schema.productSpecials.productId, productIds))
    .orderBy(asc(schema.productSpecials.startsOn));
  for (const r of rows) {
    const list = map.get(r.productId) ?? [];
    list.push(r);
    map.set(r.productId, list);
  }
  return map;
}

type ProductRow = typeof schema.products.$inferSelect;

/** Product + resolved price + derived pack/lm maths, ready for a screen. */
function decorate(p: ProductRow, specials: SpecialRow[], today: string) {
  const priced = priceProduct(p, specials, today);
  const cutRate = cutRateFor(p);
  /** Above this quantity a cut costs more than taking the whole roll. */
  const breakEven = cutRate && p.rollM2 && p.costPrice ? round2((p.rollM2 * p.costPrice) / cutRate) : null;
  return {
    ...p,
    ...priced,
    /* ----- roll vs cut. Set only on roll goods with a published cut rate. ----- */
    /** true = this product costs more per unit when the supplier cuts a part roll. */
    hasCutRate: cutRate !== null && Boolean(p.rollM2),
    /** The cut rate, whether published outright or derived from a % uplift. */
    cutRateExGst: cutRate,
    /** Cut rate marked up, for the quote screen. */
    cutSellExGst: cutRate === null ? null : sellExGst(cutRate),
    /** What a part roll costs Terra extra, per unit. */
    cutPremiumPerUnit: cutRate === null || p.costPrice === null ? null : round2(cutRate - p.costPrice),
    /**
     * Lineal metres on a full roll — 20 for a 2m x 20m sheet. On a carpet line
     * the threshold is ALREADY in lineal metres (Chaparral's break is 20 lm),
     * so it passes straight through instead of being divided by the width.
     */
    rollLm: p.rollM2 === null ? null : lmForQty(p.rollM2, p.unit, p.widthM),
    /** Area a full roll covers, once the width is known. 20 lm of 3.6m = 72 m². */
    rollM2Covered: p.rollM2 === null ? null : m2ForQty(p.rollM2, p.unit, p.widthM),
    rollBreakEvenQty: breakEven,
    rollBreakEvenLm: breakEven === null ? null : lmForQty(breakEven, p.unit, p.widthM),
    /* ------------------------------ volume break ------------------------------
     * A third, deeper rate the ORDER SIZE earns (MJS publish one over 300 m2).
     * Null on every two-rate supplier, and only true when the published figure
     * is actually below the roll rate — MJS's weld rods print the same number
     * in all three columns, which is not a break. */
    hasVolumeRate: Boolean(
      p.volumeQty && p.volumeCostPrice !== null && p.costPrice !== null && p.volumeCostPrice < p.costPrice,
    ),
    /** The volume rate marked up, for the quote screen. */
    volumeSellExGst: p.volumeCostPrice === null ? null : sellExGst(p.volumeCostPrice),
    /** Derived, never the supplier's printed figure. Null when not a pack good. */
    packM2: packM2(p.unitsPerPack, p.unitM2),
    /** Set for roll goods so lm and m2 can be shown side by side. */
    costPerM2: p.unit === "lm" && priced.costExGst !== null ? perM2FromPerLm(priced.costExGst, p.widthM) : null,
    sellPerM2: p.unit === "lm" && priced.sellExGst !== null ? perM2FromPerLm(priced.sellExGst, p.widthM) : null,
    specialsCount: specials.length,
  };
}

/* ------------------------------- bulk planners ------------------------------ */

const rounding = z.enum(["none", "5c", "10c", "dollar"]).default("none");
const idList = z.array(z.number().int()).min(1).max(2000);

const bulkEditInput = z.object({
  ids: idList,
  mode: z.enum(["percent", "add", "set"]),
  amount: z.number(),
  rounding,
  /** Percent only: scale the cut-roll and volume rates by the same amount. */
  scaleOtherRates: z.boolean().default(true),
});

const bulkSpecialInput = z.object({
  ids: idList,
  mode: z.enum(["percent_off", "dollar_off", "set_cost"]),
  amount: z.number().min(0),
  rounding,
  label: z.string().min(1).default("Special"),
  kind: z.enum(SPECIAL_KINDS).default("promo"),
  startsOn: isoDate,
  endsOn: isoDate,
  /** false = keep the saving as margin. true = customer gets the discount on new quotes. */
  passOnToCustomer: z.boolean().default(false),
});

const nameOf = (p: ProductRow) => [p.supplier, p.range, p.colour].filter(Boolean).join(" · ");

async function planPriceEdit(input: z.infer<typeof bulkEditInput>) {
  const today = todayISO();
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, input.ids));
  const specials = await specialsFor(products.map((p) => p.id));
  const scale = input.mode === "percent" && input.scaleOtherRates;

  const rows = products.map((p) => {
    const base = { id: p.id, name: nameOf(p), unit: p.unit, oldCost: p.costPrice, oldSell: p.sellPrice };
    if (p.costPrice === null || p.priceOnApplication) {
      return { ...base, change: "skip" as const, reason: "No price to change (price on application)", newCost: null, newSell: null, warning: null };
    }
    const next = editedCost(p.costPrice, input.mode, input.amount, input.rounding);
    if (next === null) {
      return { ...base, change: "skip" as const, reason: "Would go below $0", newCost: null, newSell: null, warning: null };
    }
    if (next === p.costPrice) {
      return { ...base, change: "skip" as const, reason: "Price would not change", newCost: next, newSell: p.sellPrice, warning: null };
    }
    const live = (specials.get(p.id) ?? []).find((s) => isSpecialLive(s, today));
    const warning = live && live.costPriceExGst >= next ? `Live special ($${live.costPriceExGst.toFixed(2)}) is no longer below the new standard` : null;
    const factor = p.costPrice === 0 ? 1 : next / p.costPrice;
    return {
      ...base,
      change: "change" as const,
      reason: null,
      newCost: next,
      newSell: sellExGst(next),
      newCutCost: scale && p.cutCostPrice !== null ? round2(p.cutCostPrice * factor) : undefined,
      newVolumeCost: scale && p.volumeCostPrice !== null ? round2(p.volumeCostPrice * factor) : undefined,
      warning,
    };
  });

  const missing = input.ids.length - products.length;
  return {
    rows,
    willChange: rows.filter((r) => r.change === "change").length,
    willSkip: rows.filter((r) => r.change === "skip").length + missing,
    warnings: rows.filter((r) => r.warning).length,
  };
}

async function planBulkSpecial(input: z.infer<typeof bulkSpecialInput>) {
  if (input.endsOn < input.startsOn) {
    throw new ORPCError("BAD_REQUEST", { message: "The special cannot end before it starts." });
  }
  if (input.endsOn < todayISO()) {
    throw new ORPCError("BAD_REQUEST", { message: "The end date is in the past." });
  }
  const today = todayISO();
  const products = await db.select().from(schema.products).where(inArray(schema.products.id, input.ids));
  const specials = await specialsFor(products.map((p) => p.id));

  const rows = products.map((p) => {
    const base = { id: p.id, name: nameOf(p), unit: p.unit, oldCost: p.costPrice, oldSell: p.sellPrice };
    if (p.costPrice === null || p.priceOnApplication) {
      return { ...base, change: "skip" as const, reason: "No standard price to take a special off", specialCost: null, newSell: null, warning: null };
    }
    const cost = specialCost(p.costPrice, input.mode, input.amount, input.rounding);
    if (cost < 0 || cost >= p.costPrice) {
      return { ...base, change: "skip" as const, reason: "Special must be below the standard cost", specialCost: cost, newSell: null, warning: null };
    }
    const overlap = (specials.get(p.id) ?? []).some(
      (s) => !s.cancelledAt && s.startsOn <= input.endsOn && input.startsOn <= s.endsOn && s.endsOn >= today,
    );
    return {
      ...base,
      change: "change" as const,
      reason: null,
      specialCost: cost,
      extraMargin: input.passOnToCustomer ? 0 : round2(p.costPrice - cost),
      newSell: input.passOnToCustomer ? sellExGst(cost) : p.sellPrice,
      warning: overlap ? "Already has a special in that window. The cheaper one wins." : null,
    };
  });

  return {
    rows,
    willChange: rows.filter((r) => r.change === "change").length,
    willSkip: rows.filter((r) => r.change === "skip").length + (input.ids.length - products.length),
    warnings: rows.filter((r) => r.warning).length,
  };
}

export const products = {
  /** The price book, flat. Filters are all optional and combine with AND. */
  list: adminOnly
    .input(
      z
        .object({
          supplierId: z.number().nullable().default(null),
          category: z.string().default(""),
          range: z.string().default(""),
          search: z.string().default(""),
          /** Only variants whose special window contains today. */
          onSpecialOnly: z.boolean().default(false),
          includeInactive: z.boolean().default(false),
          /** Item 9: box, broadloom, or "none" for untagged. Empty = all. */
          soldAs: z.enum(["", "box", "broadloom", "none"]).default(""),
          limit: z.number().int().min(1).max(2000).default(500),
        })
        .default({
          supplierId: null,
          category: "",
          range: "",
          search: "",
          onSpecialOnly: false,
          includeInactive: false,
          soldAs: "",
          limit: 500,
        }),
    )
    .handler(async ({ input }) => {
      const today = todayISO();
      const clauses = [];
      if (!input.includeInactive) clauses.push(eq(schema.products.active, true));
      if (input.supplierId !== null) clauses.push(eq(schema.products.supplierId, input.supplierId));
      if (input.category) clauses.push(eq(schema.products.category, input.category));
      if (input.range) clauses.push(eq(schema.products.range, input.range));
      if (input.soldAs === "none") clauses.push(isNull(schema.products.soldAs));
      else if (input.soldAs) clauses.push(eq(schema.products.soldAs, input.soldAs));
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        clauses.push(
          or(
            like(sql`lower(${schema.products.range})`, q),
            like(sql`lower(${schema.products.colour})`, q),
            like(sql`lower(${schema.products.supplier})`, q),
            like(sql`lower(${schema.products.backing})`, q),
          ),
        );
      }

      const rows = await db
        .select()
        .from(schema.products)
        .where(clauses.length ? and(...clauses) : undefined)
        .orderBy(asc(schema.products.supplier), asc(schema.products.range), asc(schema.products.colour))
        .limit(input.limit);

      const specials = await specialsFor(rows.map((r) => r.id));
      const priced = rows.map((r) => decorate(r, specials.get(r.id) ?? [], today));
      return input.onSpecialOnly ? priced.filter((p) => p.onSpecial) : priced;
    }),

  /**
   * Ranges, grouped, for the browse screen. A range spans several variants at
   * several prices (Belgotex Academia is one price on Flexbac and another on
   * ProBac), so a range carries a price RANGE, not a price.
   */
  ranges: adminOnly
    .input(z.object({ supplierId: z.number().nullable().default(null) }).default({ supplierId: null }))
    .handler(async ({ input }) => {
      const today = todayISO();
      const rows = await db
        .select()
        .from(schema.products)
        .where(
          input.supplierId === null
            ? eq(schema.products.active, true)
            : and(eq(schema.products.active, true), eq(schema.products.supplierId, input.supplierId)),
        )
        .orderBy(asc(schema.products.supplier), asc(schema.products.category), asc(schema.products.range));

      const specials = await specialsFor(rows.map((r) => r.id));

      const groups = new Map<
        string,
        {
          key: string;
          supplierId: number | null;
          supplier: string;
          category: string;
          tier: string;
          range: string;
          unit: string;
          colours: Set<string>;
          backings: Set<string>;
          variants: number;
          costs: number[];
          sells: number[];
          onSpecial: number;
          soonestEnd: string | null;
          bestDiscountPct: number;
          bestExtraMargin: number;
        }
      >();

      for (const r of rows) {
        const key = `${r.supplierId ?? 0}|${r.category}|${r.range}`;
        const g =
          groups.get(key) ??
          {
            key,
            supplierId: r.supplierId,
            supplier: r.supplier,
            category: r.category,
            tier: r.tier,
            range: r.range,
            unit: r.unit,
            colours: new Set<string>(),
            backings: new Set<string>(),
            variants: 0,
            costs: [] as number[],
            sells: [] as number[],
            onSpecial: 0,
            soonestEnd: null as string | null,
            bestDiscountPct: 0,
            bestExtraMargin: 0,
          };
        const priced = priceProduct(r, specials.get(r.id) ?? [], today);
        g.variants += 1;
        if (r.colour) g.colours.add(r.colour);
        if (r.backing) g.backings.add(r.backing);
        if (priced.costExGst !== null) g.costs.push(priced.costExGst);
        if (priced.sellExGst !== null) g.sells.push(priced.sellExGst);
        if (priced.special) {
          g.onSpecial += 1;
          g.bestDiscountPct = Math.max(g.bestDiscountPct, priced.special.discountPct);
          g.bestExtraMargin = Math.max(g.bestExtraMargin, priced.extraMarginPerUnit);
          if (!g.soonestEnd || priced.special.endsOn < g.soonestEnd) g.soonestEnd = priced.special.endsOn;
        }
        groups.set(key, g);
      }

      return [...groups.values()].map((g) => ({
        key: g.key,
        supplierId: g.supplierId,
        supplier: g.supplier,
        category: g.category,
        tier: g.tier,
        range: g.range,
        unit: g.unit,
        colourCount: g.colours.size,
        backings: [...g.backings].sort(),
        variants: g.variants,
        costFrom: g.costs.length ? round2(Math.min(...g.costs)) : null,
        costTo: g.costs.length ? round2(Math.max(...g.costs)) : null,
        /** Sell is off the standard cost, so this range does not move on a special. */
        sellFrom: g.sells.length ? round2(Math.min(...g.sells)) : null,
        sellTo: g.sells.length ? round2(Math.max(...g.sells)) : null,
        onSpecial: g.onSpecial,
        soonestEnd: g.soonestEnd,
        daysLeft: g.soonestEnd ? daysBetween(today, g.soonestEnd) : null,
        bestDiscountPct: g.bestDiscountPct,
        bestExtraMargin: round2(g.bestExtraMargin),
      }));
    }),

  /** One variant with its whole specials history, newest window first. */
  get: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const today = todayISO();
    const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.id));
    if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

    const history = await db
      .select()
      .from(schema.productSpecials)
      .where(eq(schema.productSpecials.productId, input.id))
      .orderBy(asc(schema.productSpecials.startsOn));

    return {
      ...decorate(product, history, today),
      history: history
        .slice()
        .reverse()
        .map((s) => ({
          ...s,
          live: isSpecialLive(s, today),
          status: s.cancelledAt
            ? ("cancelled" as const)
            : isSpecialLive(s, today)
              ? ("live" as const)
              : s.startsOn > today
                ? ("scheduled" as const)
                : ("ended" as const),
          daysLeft: daysBetween(today, s.endsOn),
          savingPerUnit: product.costPrice === null ? 0 : round2(product.costPrice - s.costPriceExGst),
        })),
    };
  }),

  /**
   * Quote-time price lookup. This is what the estimate calls, so the answer is
   * always resolved against today — an ended special reverts here first.
   */
  priceFor: adminOnly
    .input(z.object({ id: z.number(), qty: z.number().min(0).default(0) }))
    .handler(async ({ input }) => {
      const today = todayISO();
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.id));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
      const history = await db
        .select()
        .from(schema.productSpecials)
        .where(eq(schema.productSpecials.productId, input.id));

      const priced = decorate(product, history, today);
      const lineExGst = priced.sellExGst === null ? null : round2(priced.sellExGst * input.qty);
      /** Under the supplier minimum the order will be bumped up, so warn here. */
      const belowMinimum =
        product.minOrderQty !== null && input.qty > 0 && input.qty < product.minOrderQty ? product.minOrderQty : null;

      return {
        product: priced,
        qty: input.qty,
        lineExGst,
        lineIncGst: lineExGst === null ? null : round2(lineExGst * 1.1),
        belowMinimum,
        /** Blocks the line: there is no price to quote. */
        blocked: product.priceOnApplication || product.costPrice === null,
      };
    }),

  /**
   * Every live special, what is about to lapse, and what just did.
   * Drives the specials screen and the dashboard warning.
   */
  specialsBoard: adminOnly
    .input(
      z
        .object({ endingWithinDays: z.number().int().min(1).max(120).default(ENDING_SOON_DAYS) })
        .default({ endingWithinDays: ENDING_SOON_DAYS }),
    )
    .handler(async ({ input }) => {
      const today = todayISO();
      const rows = await db
        .select({ product: schema.products, special: schema.productSpecials })
        .from(schema.productSpecials)
        .innerJoin(schema.products, eq(schema.products.id, schema.productSpecials.productId))
        .orderBy(asc(schema.productSpecials.endsOn));

      const shape = (r: (typeof rows)[number]) => ({
        specialId: r.special.id,
        productId: r.product.id,
        supplier: r.product.supplier,
        category: r.product.category,
        range: r.product.range,
        colour: r.product.colour,
        backing: r.product.backing,
        unit: r.product.unit,
        label: r.special.label,
        kind: r.special.kind,
        standardCostExGst: r.product.costPrice,
        specialCostExGst: r.special.costPriceExGst,
        savingPerUnit: r.product.costPrice === null ? 0 : round2(r.product.costPrice - r.special.costPriceExGst),
        discountPct:
          r.product.costPrice && r.product.costPrice > 0
            ? Math.round(((r.product.costPrice - r.special.costPriceExGst) / r.product.costPrice) * 1000) / 10
            : 0,
        startsOn: r.special.startsOn,
        endsOn: r.special.endsOn,
        daysLeft: daysBetween(today, r.special.endsOn),
        cancelledAt: r.special.cancelledAt,
        source: r.special.source,
      });

      const live = rows.filter((r) => isSpecialLive(r.special, today)).map(shape);
      const scheduled = rows
        .filter((r) => !r.special.cancelledAt && r.special.startsOn > today)
        .map(shape);
      const ended = rows
        .filter((r) => !r.special.cancelledAt && r.special.endsOn < today)
        .map(shape)
        .reverse();

      const endingSoon = live.filter((l) => l.daysLeft <= input.endingWithinDays);

      /** One line per range, because 7 colours ending the same day is one event. */
      const byRange = new Map<string, { supplier: string; range: string; endsOn: string; colours: number; daysLeft: number }>();
      for (const l of endingSoon) {
        const key = `${l.supplier}|${l.range}|${l.endsOn}`;
        const g = byRange.get(key) ?? { supplier: l.supplier, range: l.range, endsOn: l.endsOn, colours: 0, daysLeft: l.daysLeft };
        g.colours += 1;
        byRange.set(key, g);
      }

      return {
        today,
        live,
        scheduled,
        endingSoon,
        endingSoonByRange: [...byRange.values()].sort((a, b) => a.daysLeft - b.daysLeft),
        recentlyEnded: ended.filter((e) => daysBetween(e.endsOn, today) <= 60),
        counts: { live: live.length, scheduled: scheduled.length, endingSoon: endingSoon.length, ended: ended.length },
      };
    }),

  /** Put a variant on special for a dated window. Overlaps are allowed; cheapest wins. */
  specialCreate: adminOnly
    .input(
      z.object({
        productId: z.number(),
        label: z.string().min(1).default("Clearance"),
        kind: z.enum(SPECIAL_KINDS).default("clearance"),
        costPriceExGst: z.number().min(0),
        startsOn: isoDate,
        /** Inclusive. The standard price is back the next morning. */
        endsOn: isoDate,
        source: z.string().default(""),
        notes: z.string().default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.endsOn < input.startsOn) {
        throw new ORPCError("BAD_REQUEST", { message: "The special cannot end before it starts." });
      }
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
      if (product.costPrice !== null && input.costPriceExGst > product.costPrice) {
        throw new ORPCError("BAD_REQUEST", {
          message: `A special has to be below the standard price of $${product.costPrice.toFixed(2)}.`,
        });
      }

      const [row] = await db.insert(schema.productSpecials).values(input).returning();
      await logProduct(
        input.productId,
        "special_created",
        `${input.label} $${input.costPriceExGst.toFixed(2)}/${product.unit} on ${product.range} ${product.colour}, ${input.startsOn} to ${input.endsOn}. Standard $${product.costPrice?.toFixed(2) ?? "?"} returns after that.`,
        context.actor.name || "Office",
      );
      return row;
    }),

  specialUpdate: adminOnly
    .input(
      z.object({
        id: z.number(),
        label: z.string().min(1).optional(),
        costPriceExGst: z.number().min(0).optional(),
        startsOn: isoDate.optional(),
        endsOn: isoDate.optional(),
        notes: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...patch } = input;
      const [existing] = await db.select().from(schema.productSpecials).where(eq(schema.productSpecials.id, id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Special not found" });

      const startsOn = patch.startsOn ?? existing.startsOn;
      const endsOn = patch.endsOn ?? existing.endsOn;
      if (endsOn < startsOn) {
        throw new ORPCError("BAD_REQUEST", { message: "The special cannot end before it starts." });
      }

      const [row] = await db
        .update(schema.productSpecials)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.productSpecials.id, id))
        .returning();

      const changes = [
        patch.costPriceExGst !== undefined && patch.costPriceExGst !== existing.costPriceExGst
          ? `price $${existing.costPriceExGst.toFixed(2)} -> $${patch.costPriceExGst.toFixed(2)}`
          : null,
        endsOn !== existing.endsOn ? `ends ${existing.endsOn} -> ${endsOn}` : null,
        startsOn !== existing.startsOn ? `starts ${existing.startsOn} -> ${startsOn}` : null,
      ].filter(Boolean);
      if (changes.length) {
        await logProduct(existing.productId, "special_updated", changes.join(", "), context.actor.name || "Office");
      }
      return row;
    }),

  /**
   * Kill a special early. The window is left as it was — the history has to
   * still show what the price was and when — so this stamps `cancelledAt` and
   * the next read falls straight back to the standard price.
   */
  specialEnd: adminOnly
    .input(z.object({ id: z.number(), reason: z.string().default("") }))
    .handler(async ({ input, context }) => {
      const [existing] = await db.select().from(schema.productSpecials).where(eq(schema.productSpecials.id, input.id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Special not found" });
      if (existing.cancelledAt) return existing;

      const [row] = await db
        .update(schema.productSpecials)
        .set({ cancelledAt: new Date(), notes: input.reason || existing.notes, updatedAt: new Date() })
        .where(eq(schema.productSpecials.id, input.id))
        .returning();
      await logProduct(
        existing.productId,
        "special_ended",
        `${existing.label} ended early (was due ${existing.endsOn})${input.reason ? `: ${input.reason}` : ""}. Standard price applies from now.`,
        context.actor.name || "Office",
      );
      return row;
    }),

  /** Extend a whole range's live specials in one go — suppliers roll them over. */
  specialsExtendRange: adminOnly
    .input(z.object({ supplierId: z.number(), range: z.string().min(1), endsOn: isoDate }))
    .handler(async ({ input, context }) => {
      const today = todayISO();
      const rows = await db
        .select({ product: schema.products, special: schema.productSpecials })
        .from(schema.productSpecials)
        .innerJoin(schema.products, eq(schema.products.id, schema.productSpecials.productId))
        .where(and(eq(schema.products.supplierId, input.supplierId), eq(schema.products.range, input.range)));

      const live = rows.filter((r) => isSpecialLive(r.special, today));
      if (!live.length) throw new ORPCError("NOT_FOUND", { message: "No live specials on that range." });
      if (input.endsOn < today) throw new ORPCError("BAD_REQUEST", { message: "New end date is in the past." });

      await db
        .update(schema.productSpecials)
        .set({ endsOn: input.endsOn, updatedAt: new Date() })
        .where(inArray(schema.productSpecials.id, live.map((l) => l.special.id)));

      await logProduct(
        live[0].product.id,
        "special_extended",
        `${input.range}: ${live.length} colours extended to ${input.endsOn}.`,
        context.actor.name || "Office",
      );
      return { updated: live.length, endsOn: input.endsOn };
    }),

  /** Change the STANDARD price. This is the price a special reverts to. */
  setStandardPrice: adminOnly
    .input(z.object({ id: z.number(), costPrice: z.number().min(0).nullable() }))
    .handler(async ({ input, context }) => {
      const [existing] = await db.select().from(schema.products).where(eq(schema.products.id, input.id));
      if (!existing) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const [row] = await db
        .update(schema.products)
        .set({
          costPrice: input.costPrice,
          sellPrice: input.costPrice === null ? null : round2(input.costPrice * 1.3 * 1.05 * 1.4),
          updatedAt: new Date(),
        })
        .where(eq(schema.products.id, input.id))
        .returning();

      await logProduct(
        input.id,
        "standard_price_changed",
        `$${existing.costPrice?.toFixed(2) ?? "none"} -> $${input.costPrice?.toFixed(2) ?? "none"} per ${existing.unit}`,
        context.actor.name || "Office",
      );
      return row;
    }),

  /* ------------------------------ bulk tools ------------------------------
   * Preview and apply share one planner, so what the confirm screen shows is
   * exactly what gets written. Apply re-reads the rows and recomputes; it never
   * trusts prices sent from the browser. */

  bulkPriceEditPreview: adminOnly.input(bulkEditInput).handler(async ({ input }) => planPriceEdit(input)),

  /** Change the STANDARD cost on many variants. Sell follows by the fixed markup chain. */
  bulkPriceEditApply: adminOnly.input(bulkEditInput).handler(async ({ input, context }) => {
    const plan = await planPriceEdit(input);
    const todo = plan.rows.filter((r) => r.change === "change");
    const actor = context.actor.name || "Office";
    for (let i = 0; i < todo.length; i += 20) {
      await Promise.all(
        todo.slice(i, i + 20).map(async (r) => {
          await db
            .update(schema.products)
            .set({
              costPrice: r.newCost,
              sellPrice: r.newSell,
              ...(r.newCutCost !== undefined ? { cutCostPrice: r.newCutCost } : {}),
              ...(r.newVolumeCost !== undefined ? { volumeCostPrice: r.newVolumeCost } : {}),
              updatedAt: new Date(),
            })
            .where(eq(schema.products.id, r.id));
          await logProduct(
            r.id,
            "standard_price_changed",
            `Bulk edit: $${r.oldCost?.toFixed(2)} -> $${r.newCost?.toFixed(2)} per ${r.unit}. Sell $${r.oldSell?.toFixed(2)} -> $${r.newSell?.toFixed(2)}.`,
            actor,
          );
        }),
      );
    }
    return { changed: todo.length, skipped: plan.rows.length - todo.length };
  }),

  bulkSpecialPreview: adminOnly.input(bulkSpecialInput).handler(async ({ input }) => planBulkSpecial(input)),

  /** Put many variants on special in one go, keeping the profit or giving the customer the discount. */
  bulkSpecialApply: adminOnly.input(bulkSpecialInput).handler(async ({ input, context }) => {
    const plan = await planBulkSpecial(input);
    const todo = plan.rows.filter((r) => r.change === "change");
    const actor = context.actor.name || "Office";
    for (let i = 0; i < todo.length; i += 20) {
      await Promise.all(
        todo.slice(i, i + 20).map(async (r) => {
          await db.insert(schema.productSpecials).values({
            productId: r.id,
            label: input.label,
            kind: input.kind,
            costPriceExGst: r.specialCost!,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            passOnToCustomer: input.passOnToCustomer,
            source: "Bulk special in the office",
          });
          await logProduct(
            r.id,
            "special_created",
            `${input.label} (bulk) cost $${r.specialCost!.toFixed(2)}/${r.unit}, ${input.startsOn} to ${input.endsOn}. ${
              input.passOnToCustomer
                ? `Discount passed to customer, sell $${r.oldSell?.toFixed(2)} -> $${r.newSell?.toFixed(2)} while it runs.`
                : "Saving kept as margin, sell unchanged."
            }`,
            actor,
          );
        }),
      );
    }
    return { created: todo.length, skipped: plan.rows.length - todo.length };
  }),

  /**
   * Roll vs cut for ONE variant at a real order quantity.
   *
   * The office types how much the job needs — in m2 or in lineal metres off the
   * roll — and this answers which rate the supplier will actually charge, what
   * the cut premium costs, and whether taking the whole roll is cheaper than
   * the cut being asked for. Quantity is deliberately an input, not a column:
   * the same product has two prices and only the order decides which is live.
   */
  rollQuote: adminOnly
    .input(
      z.object({
        id: z.number(),
        qty: z.number().min(0).max(100_000),
        /** m2 or lm — lm is converted off the roll width before pricing. */
        qtyUnit: z.enum(["m2", "lm"]).default("m2"),
      }),
    )
    .handler(async ({ input }) => {
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.id));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      // The product is priced per m2; lineal metres are converted off the width.
      const qtyM2 =
        input.qtyUnit === "lm" && product.unit === "m2" ? (m2FromLm(input.qty, product.widthM) ?? input.qty) : input.qty;

      const quote = resolveRollCut(product, qtyM2);
      const specials = await specialsFor([product.id]);
      const priced = priceProduct(product, specials.get(product.id) ?? [], todayISO());

      return {
        product: {
          id: product.id,
          supplier: product.supplier,
          range: product.range,
          colour: product.colour,
          unit: product.unit,
          size: product.size,
        },
        entered: { qty: input.qty, unit: input.qtyUnit },
        quote,
        /** A live special still lowers the ROLL rate; the cut premium sits on top. */
        onSpecial: priced.onSpecial,
        specialCostExGst: priced.onSpecial ? priced.costExGst : null,
      };
    }),
};
