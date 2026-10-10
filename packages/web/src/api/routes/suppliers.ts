import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { resolveSupplierCharges, round2 } from "../lib/pricing";

/**
 * Suppliers and everything they add ON TOP of the per-m2 rate.
 *
 * Three hard rules live here:
 *  1. A surcharge is STORED DATA with its own basis, amount and dates, never a
 *     constant and never a single percentage. Terramater charge a percentage,
 *     Chaparral charge $2.00 per lineal metre, and a supplier can run a fuel
 *     surcharge and a baling charge at once. Damien edits rows, not code.
 *  2. Fees are charged PER SUPPLIER ORDER, not per estimate line. One $30
 *     baling fee on an order, however many ranges are on it.
 *  3. A surcharge is never folded into a product's cost price, so switching it
 *     off is one toggle instead of a price-list re-import.
 * Every rate change is written to the activity log, so the old number and who
 * changed it survive a dispute.
 */

const FEE_KINDS = [
  "fuel",
  "delivery",
  "handling",
  "baling",
  "storage",
  "cutting",
  "premium",
  "levy",
  "reschedule",
  "credit",
  "other",
] as const;

/** What the amount is charged PER. See the `basis` comment in schema.ts. */
const FEE_BASES = [
  "percent_of_order",
  "m2",
  "lm",
  "box",
  "roll",
  "each",
  "order",
  "shipment",
  "pallet",
  "week",
] as const;

/** YYYY-MM-DD, or empty/null for "no date" / "until further notice". */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .nullable()
  .default(null);

const feeInput = z.object({
  name: z.string().min(1),
  kind: z.enum(FEE_KINDS).default("other"),
  basis: z.enum(FEE_BASES).default("order"),
  amount: z.number().nullable().default(null),
  percent: z.number().nullable().default(null),
  amountIncludesGst: z.boolean().default(false),
  isCredit: z.boolean().default(false),
  autoApply: z.boolean().default(false),
  /** Null = applies already. */
  effectiveFrom: dateOnly,
  /** Null = until further notice, which is how a supplier words a fuel levy. */
  effectiveUntil: dateOnly,
  condition: z.string().default(""),
  notes: z.string().default(""),
  sortOrder: z.number().int().default(0),
});

async function logSupplier(supplierId: number, action: string, detail: string, actorName: string) {
  await db.insert(schema.activityLog).values({
    entityType: "supplier",
    entityId: supplierId,
    action,
    detail,
    actorName,
    actorRole: "admin",
  });
}

export const suppliers = {
  list: staffOnly
    .input(z.object({ includeInactive: z.boolean().default(false) }).default({ includeInactive: false }))
    .handler(async ({ input }) => {
      const where = input.includeInactive ? undefined : eq(schema.suppliers.active, true);
      const rows = await db
        .select({
          supplier: schema.suppliers,
          feeCount: sql<number>`(
            select count(*) from supplier_fee_rules f
            where f.supplier_id = suppliers.id and f.active = 1
          )`,
        })
        .from(schema.suppliers)
        .where(where)
        .orderBy(asc(schema.suppliers.name));

      return rows.map((r) => ({ ...r.supplier, feeCount: Number(r.feeCount ?? 0) }));
    }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.id));
    if (!supplier) throw new ORPCError("NOT_FOUND", { message: "Supplier not found" });
    // Supplier charges are costs. Office sees the supplier, not what they charge us.
    if (context.actor.role !== "admin") return { supplier, fees: [] as (typeof schema.supplierFeeRules.$inferSelect)[] };
    const fees = await db
      .select()
      .from(schema.supplierFeeRules)
      .where(eq(schema.supplierFeeRules.supplierId, input.id))
      .orderBy(asc(schema.supplierFeeRules.sortOrder), asc(schema.supplierFeeRules.name));
    return { supplier, fees };
  }),

  create: adminOnly
    .input(
      z.object({
        name: z.string().min(1),
        code: z.string().min(1),
        shipsFrom: z.string().optional(),
        accountNumber: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const code = input.code.trim().toLowerCase().replace(/\s+/g, "-");
      const [existing] = await db.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.code, code));
      if (existing) throw new ORPCError("CONFLICT", { message: `Supplier code "${code}" already exists` });
      const [row] = await db.insert(schema.suppliers).values({ ...input, code }).returning();
      await logSupplier(row.id, "supplier_created", row.name, context.actor.name || "Office");
      return row;
    }),

  update: adminOnly
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        shipsFrom: z.string().nullable().optional(),
        accountNumber: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        dealerPricingEligible: z.boolean().optional(),
        dealerPricingNote: z.string().optional(),
        /** false = their published delivery charge is never Terra's cost. */
        deliversDirect: z.boolean().optional(),
        freightMethod: z.string().optional(),
        freightNote: z.string().optional(),
        priceListExGst: z.boolean().optional(),
        /** ISO date strings — the date printed on the list, not today. */
        priceListEffectiveFrom: z.string().nullable().optional(),
        priceListValidUntil: z.string().nullable().optional(),
        priceListSource: z.string().optional(),
        notes: z.string().optional(),
        active: z.boolean().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, priceListEffectiveFrom, priceListValidUntil, ...rest } = input;
      const [row] = await db
        .update(schema.suppliers)
        .set({
          ...rest,
          ...(priceListEffectiveFrom !== undefined
            ? { priceListEffectiveFrom: priceListEffectiveFrom ? new Date(priceListEffectiveFrom) : null }
            : {}),
          ...(priceListValidUntil !== undefined
            ? { priceListValidUntil: priceListValidUntil ? new Date(priceListValidUntil) : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.suppliers.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Supplier not found" });
      await logSupplier(id, "supplier_updated", row.name, context.actor.name || "Office");
      return row;
    }),

  /**
   * LEGACY. Writes the four superseded fuel-surcharge columns on the supplier
   * row and nothing else — `quoteOrderCost` no longer reads them.
   *
   * A fuel surcharge is now a `supplierFeeRules` row with `kind: "fuel"`, so it
   * can be charged per lineal metre or per m2 instead of only as a percentage,
   * and can sit alongside a baling charge. This stays only so the historical
   * note ("was 1.2%, letter dated March") remains editable.
   */
  setFuelSurcharge: adminOnly
    .input(
      z.object({
        id: z.number(),
        active: z.boolean(),
        /** Percent of the supplier order total. 2 = 2%. */
        pct: z.number().min(0).max(100),
        note: z.string().default(""),
      }),
    )
    .handler(async ({ input, context }) => {
      const [before] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Supplier not found" });

      const [row] = await db
        .update(schema.suppliers)
        .set({
          fuelSurchargeActive: input.active,
          fuelSurchargePct: input.pct,
          fuelSurchargeNote: input.note,
          fuelSurchargeUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.suppliers.id, input.id))
        .returning();

      const was = before.fuelSurchargeActive ? `${before.fuelSurchargePct}%` : "off";
      const now = input.active ? `${input.pct}%` : "off";
      if (was !== now) {
        await logSupplier(
          input.id,
          "fuel_surcharge_changed",
          `${row.name} fuel surcharge ${was} -> ${now}`,
          context.actor.name || "Office",
        );
      }
      return row;
    }),

  /* ------------------------------- fees ------------------------------- */

  feeCreate: adminOnly
    .input(feeInput.extend({ supplierId: z.number() }))
    .handler(async ({ input, context }) => {
      const [row] = await db.insert(schema.supplierFeeRules).values(input).returning();
      await logSupplier(input.supplierId, "supplier_fee_added", row.name, context.actor.name || "Office");
      return row;
    }),

  feeUpdate: adminOnly
    .input(feeInput.partial().extend({ id: z.number(), active: z.boolean().optional() }))
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const [row] = await db
        .update(schema.supplierFeeRules)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.supplierFeeRules.id, id))
        .returning();
      if (!row) throw new ORPCError("NOT_FOUND", { message: "Fee not found" });
      await logSupplier(row.supplierId, "supplier_fee_updated", row.name, context.actor.name || "Office");
      return row;
    }),

  feeDelete: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db
      .update(schema.supplierFeeRules)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(schema.supplierFeeRules.id, input.id))
      .returning();
    if (!row) throw new ORPCError("NOT_FOUND", { message: "Fee not found" });
    await logSupplier(row.supplierId, "supplier_fee_removed", row.name, context.actor.name || "Office");
    return { ok: true };
  }),

  /**
   * What a supplier order actually costs once the supplier's own charges land.
   *
   * Deterministic, no AI, no rounding surprises, and the breakdown Damien asked
   * for stays readable end to end:
   *
   *   base material + supplier surcharge(s) + baling/packing + freight
   *     = true material cost ex GST
   *
   * Every charge is computed off its OWN basis, so $2.00/lm fuel and $20/roll
   * baling can both land on the same order without one being expressed as a
   * fudged percentage of the other. Nothing compounds.
   *
   * `transportExGst` is Terra's own carrier leg, passed in rather than stored:
   * for a supplier who does not deliver (Chaparral via Jocks Transport) the
   * freight is a carrier invoice, not a supplier charge, and the supplier's own
   * published delivery rate is excluded on purpose.
   */
  quoteOrderCost: adminOnly
    .input(
      z.object({
        supplierId: z.number(),
        /** Goods total, ex-GST, at the rate that already applies (roll or cut). */
        goodsExGst: z.number().min(0),
        /* The order measured in every unit a charge might be quoted per. */
        m2: z.number().min(0).default(0),
        lm: z.number().min(0).default(0),
        boxes: z.number().min(0).default(0),
        rolls: z.number().min(0).default(0),
        items: z.number().min(0).default(0),
        pallets: z.number().min(0).default(0),
        shipments: z.number().min(0).default(1),
        weeksStored: z.number().min(0).default(0),
        /** Terra's own transport leg for this order, ex-GST, where it is known. */
        transportExGst: z.number().min(0).default(0),
        /** Optional fees the office ticked on for this order. */
        feeIds: z.array(z.number()).default([]),
      }),
    )
    .handler(async ({ input }) => {
      const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId));
      if (!supplier) throw new ORPCError("NOT_FOUND", { message: "Supplier not found" });

      const rules = await db
        .select()
        .from(schema.supplierFeeRules)
        .where(and(eq(schema.supplierFeeRules.supplierId, input.supplierId), eq(schema.supplierFeeRules.active, true)))
        .orderBy(asc(schema.supplierFeeRules.sortOrder));

      const quote = resolveSupplierCharges(supplier, rules, input, { pickedIds: input.feeIds });

      /**
       * Terra's carrier leg is added AFTER the supplier's charges, never inside
       * them, because it is a different invoice from a different company.
       */
      const transportExGst = round2(input.transportExGst);
      const totalExGst = round2(quote.totalExGst + transportExGst);

      return {
        supplier: {
          id: supplier.id,
          name: supplier.name,
          deliversDirect: supplier.deliversDirect,
          freightMethod: supplier.freightMethod,
          freightNote: supplier.freightNote,
        },
        goodsExGst: quote.goodsExGst,
        /** Each charge, still its own line, with the maths spelled out. */
        charges: quote.charges,
        surchargesExGst: quote.surchargesExGst,
        packingExGst: quote.packingExGst,
        supplierFreightExGst: quote.freightExGst,
        otherChargesExGst: quote.otherExGst,
        creditsExGst: quote.creditsExGst,
        chargesExGst: quote.chargesExGst,
        transportExGst,
        /** Material cost before Terra's transport. */
        materialCostExGst: quote.totalExGst,
        totalExGst,
        gst: round2(totalExGst * 0.1),
        totalIncGst: round2(totalExGst * 1.1),
        /** Charges on file that deliberately did NOT apply, and why. */
        excludedCharges: quote.excluded,
        note: quote.note,
        /** Set when the list Terra is quoting off has expired or has no date. */
        priceListWarning: priceListWarning(supplier),
      };
    }),
};

function priceListWarning(s: typeof schema.suppliers.$inferSelect): string | null {
  if (s.priceListValidUntil && s.priceListValidUntil.getTime() < Date.now()) {
    return `${s.name} prices expired ${s.priceListValidUntil.toISOString().slice(0, 10)}. Confirm before quoting.`;
  }
  if (!s.priceListEffectiveFrom) return `${s.name} has no price-list date recorded.`;
  const months = (Date.now() - s.priceListEffectiveFrom.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months >= 12) {
    return `${s.name} prices are dated ${s.priceListEffectiveFrom.toISOString().slice(0, 10)}, over a year old.`;
  }
  return null;
}
