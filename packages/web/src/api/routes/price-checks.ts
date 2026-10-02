import { z } from "zod";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { approveFlag, checkInvoicePrices, FlagError, ignoreFlag } from "../lib/price-check";

/**
 * PRICE CHECKS. Invoice rates that differ from the Ops price list or the
 * supplier's charges. Damien approves or ignores each one. Nothing changes a
 * price without that.
 */

type Flag = typeof schema.priceFlags.$inferSelect;

async function shape(rows: Flag[]) {
  const invIds = [...new Set(rows.map((r) => r.invoiceId))];
  const supIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is number => !!x))];
  const [invs, sups] = await Promise.all([
    invIds.length
      ? db
          .select({ id: schema.supplierInvoices.id, invoiceNumber: schema.supplierInvoices.invoiceNumber, invoiceDate: schema.supplierInvoices.invoiceDate, supplierNameRaw: schema.supplierInvoices.supplierNameRaw })
          .from(schema.supplierInvoices)
          .where(inArray(schema.supplierInvoices.id, invIds))
      : [],
    supIds.length ? db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(inArray(schema.suppliers.id, supIds)) : [],
  ]);
  const inv = new Map(invs.map((i) => [i.id, i]));
  const sup = new Map(sups.map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    invoiceId: r.invoiceId,
    invoiceNumber: inv.get(r.invoiceId)?.invoiceNumber ?? "",
    invoiceDate: inv.get(r.invoiceId)?.invoiceDate ?? null,
    supplierId: r.supplierId,
    supplierName: (r.supplierId && sup.get(r.supplierId)) || inv.get(r.invoiceId)?.supplierNameRaw || "Supplier",
    productId: r.productId,
    feeRuleId: r.feeRuleId,
    lineText: r.lineText,
    opsValue: r.opsValue,
    invoiceValue: r.invoiceValue,
    unit: r.unit,
    qty: r.qty,
    impactExGst: r.impactExGst,
    title: r.title,
    detail: r.detail,
    canApprove: Boolean(r.change),
    status: r.status,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
    outcome: r.outcome,
  }));
}

const fail = (e: unknown): never => {
  if (e instanceof FlagError) throw new ORPCError("BAD_REQUEST", { message: e.message });
  throw e;
};

export const priceChecks = {
  /** Open checks, newest first, plus the last few decided so Damien can see what changed. */
  list: adminOnly.handler(async () => {
    const open = await db.select().from(schema.priceFlags).where(eq(schema.priceFlags.status, "open")).orderBy(desc(schema.priceFlags.createdAt), desc(schema.priceFlags.id));
    const decided = await db.select().from(schema.priceFlags).where(ne(schema.priceFlags.status, "open")).orderBy(desc(schema.priceFlags.decidedAt)).limit(10);
    return { open: await shape(open), decided: await shape(decided) };
  }),

  forInvoice: adminOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input }) => {
    const rows = await db.select().from(schema.priceFlags).where(eq(schema.priceFlags.invoiceId, input.invoiceId)).orderBy(desc(schema.priceFlags.id));
    return shape(rows);
  }),

  approve: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    try {
      return await approveFlag(input.id, context.actor.name || "Office");
    } catch (e) {
      return fail(e);
    }
  }),

  ignore: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    try {
      await ignoreFlag(input.id, context.actor.name || "Office");
      return { ok: true };
    } catch (e) {
      return fail(e);
    }
  }),

  /** Read one invoice against the price list again, after a price was fixed by hand. */
  recheck: adminOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input }) => {
    const [i] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(and(eq(schema.supplierInvoices.id, input.invoiceId)));
    if (!i) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    return { flags: await checkInvoicePrices(i.id) };
  }),
};
