import { z } from "zod";
import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { bad, cm, notFound, productKind, r4, stockPerms, switches } from "../lib/stock/core";
import {
  leadFlag,
  LEAD_UNKNOWN_TEXT,
  lineUnitOf,
  modeOf,
  productName,
  productNumbers,
  SHORT_LABEL,
  stockUnitText,
  SUPPLY_LABEL,
  SUPPLY_MODES,
  supplierOf,
  supplyState,
  type Product,
} from "../lib/stock/replenish";
import { addShortageToWarehouse, closeLine, draftSuggestions, editDraftLine, editWarehouseTerms, removeShortageLink, shortageToJobPo, warehouseOrders } from "../lib/stock/warehouse-po";
import { approveSupplyShort, quoteSupplyLines, supplyShorts } from "../lib/stock/supply-check";
import { recordCustomerArrangement } from "../lib/stock/shortage";

/* ---------------------------------------------------------------------------
 * A2: supply settings, the Reorder list and warehouse orders. Admin only,
 * every procedure that shows a purchase price or changes an order. Thin:
 * the rules live in lib/stock/replenish, warehouse-po and supply-check.
 * Nothing here sends a PO, emails a supplier or texts anyone. Sending is the
 * ordinary PO button, pressed by a person.
 * ------------------------------------------------------------------------- */

const num = z.number().min(0).max(1_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const supplyInput = z.object({
  productId: z.number().int(),
  supplyMode: z.enum(SUPPLY_MODES),
  stockTracked: z.boolean(),
  preferredSupplierId: z.number().int().nullable(),
  reorderLevel: num.nullable(),
  reorderMethod: z.enum(["fixed", "target"]),
  reorderQty: num.nullable(),
  targetLevel: num.nullable(),
  purchaseUnit: z.string().trim().max(30),
  stockPerPurchase: z.number().positive().max(100_000).nullable(),
  reorderMinQty: num.nullable(),
  orderMultiple: num.nullable(),
  leadTimeDays: z.number().int().min(0).max(365).nullable(),
  lowStockAlerts: z.boolean(),
  stockUnitLabel: z.string().trim().max(20),
});

const settingsOf = (p: Product) => ({
  supplyMode: modeOf(p),
  stockTracked: p.stockTracked,
  preferredSupplierId: p.preferredSupplierId,
  reorderLevel: p.reorderLevel,
  reorderMethod: p.reorderMethod === "target" ? ("target" as const) : ("fixed" as const),
  reorderQty: p.reorderQty,
  targetLevel: p.targetLevel,
  purchaseUnit: p.purchaseUnit,
  stockPerPurchase: p.stockPerPurchase,
  reorderMinQty: p.reorderMinQty,
  orderMultiple: p.orderMultiple,
  leadTimeDays: p.leadTimeDays,
  lowStockAlerts: p.lowStockAlerts,
  stockUnitLabel: p.stockUnitLabel,
  supplySetAt: p.supplySetAt,
  supplySetBy: p.supplySetBy,
});

async function supplierNames() {
  const rows = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers);
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Products on the Reorder list: anything not on the default, or counted with a reorder level. */
async function listProducts() {
  const rows = await db
    .select()
    .from(schema.products)
    .where(or(ne(schema.products.supplyMode, "job"), and(eq(schema.products.stockTracked, true), isNotNull(schema.products.reorderLevel))));
  return rows;
}

/** Issues for the review list (7F). Words only; nothing is changed. */
function reviewIssues(p: Product, onShelf: number) {
  const mode = modeOf(p);
  const out: string[] = [];
  if (!p.supplySetAt) out.push("Not reviewed yet. Still on the default unless set by hand.");
  if (productKind(p) === "carpet" && mode !== "container") out.push(`Carpet: if this is imported, set it to "${SUPPLY_LABEL.container}" before it goes through the stock workflow.`);
  if (mode === "job" && onShelf > 0) out.push(`Has stock on the shelf but is still "${SUPPLY_LABEL.job}". Clearance stock should be "${SUPPLY_LABEL.stock_only}".`);
  if (p.heldInWarehouse) out.push("Marked held in warehouse (cut-to-length ordering). Not converted. Review its supply setting.");
  if (mode !== "job" && !p.stockTracked) out.push('"We count this" is not ticked.');
  if (mode === "reorder") {
    if (p.reorderLevel == null) out.push("Reorder level missing.");
    if (p.reorderMethod === "target" ? p.targetLevel == null : !p.reorderQty) out.push(p.reorderMethod === "target" ? "Target level missing." : "Reorder quantity missing.");
    if (!supplierOf(p)) out.push("Supplier missing.");
    if (p.leadTimeDays == null) out.push(LEAD_UNKNOWN_TEXT);
  }
  if (p.purchaseUnit && !p.stockPerPurchase) out.push(`Purchase unit "${p.purchaseUnit}" has no conversion to the stock unit.`);
  if (p.reorderLevel != null && !p.lowStockAlerts && mode !== "job") out.push("Low-stock alert is off.");
  return out;
}

export const stockSupply = {
  /** The Reorder list, grouped by supplier, and every warehouse order. S6 off or paused: shown, nothing new can be done. */
  reorderList: adminOnly.handler(async ({ context }) => {
    const perms = await stockPerms(context.actor);
    const sw = await switches();
    const products = await listProducts();
    const nums = await productNumbers(products);
    const sups = await supplierNames();

    const allShort = [...nums.values()].flatMap((n) => n.shortages);
    const jobIds = [...new Set(allShort.map((s) => s.jobId))];
    const jobs = jobIds.length ? await db.select({ id: schema.jobs.id, number: schema.jobs.number, title: schema.jobs.title }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds)) : [];
    const poIds = [...new Set(allShort.flatMap((s) => [s.link?.poId, s.jobPo?.id]).filter((x): x is number => x != null))];
    const pos = poIds.length ? await db.select({ id: schema.purchaseOrders.id, sentAt: schema.purchaseOrders.sentAt, status: schema.purchaseOrders.status }).from(schema.purchaseOrders).where(inArray(schema.purchaseOrders.id, poIds)) : [];

    const rows = [];
    for (const p of products) {
      const n = nums.get(p.id)!;
      const st = supplyState(p, n);
      const mode = modeOf(p);
      const shortages = [];
      for (const s of n.shortages) {
        const job = jobs.find((j) => j.id === s.jobId);
        const viaPo = s.link ? pos.find((x) => x.id === s.link!.poId) : s.jobPo ? pos.find((x) => x.id === s.jobPo!.id) : undefined;
        const sentAt = viaPo && viaPo.status !== "draft" ? (viaPo.sentAt ?? null) : null;
        let route: "choose" | "on_warehouse" | "on_job_po" | "on_sent_job_po" | "owner_review" | "job_po_only";
        let routeText: string;
        if (mode === "container" || mode === "stock_only") {
          route = "owner_review";
          routeText = `${SHORT_LABEL[mode]}. Not reordered here; no small top-up PO is drafted.`;
        } else if (s.link) {
          route = "on_warehouse";
          routeText = `On ${s.link.poNumber}${s.link.poStatus === "draft" ? " (draft, not sent yet)" : " — ordered, awaiting receipt"}: ${cm(s.link.qty - s.link.receivedQty)} ${stockUnitText(p)} kept for this job.`;
        } else if (s.jobPo && s.jobPo.status !== "draft") {
          route = "on_sent_job_po";
          routeText = `Already on ${s.jobPo.number}, which has gone to the supplier. Check it with the supplier if anything needs to change. Nothing here changes it.`;
        } else if (s.jobPo) {
          route = "on_job_po";
          routeText = `On draft ${s.jobPo.number} for this job.`;
        } else if (mode === "job" || s.qty == null) {
          route = "job_po_only";
          routeText = s.qty == null ? "Its unit does not convert to the stock unit. Use the job's own PO." : "Ordered for each job. Use the job's own PO.";
        } else {
          route = "choose";
          routeText = "Not ordered yet. Choose: the job's own PO (A), or add it to the warehouse order (B).";
        }
        const stillToCome = route !== "owner_review" && !(s.link && s.link.qty - s.link.receivedQty <= 0.0001);
        shortages.push({
          holdId: s.holdId,
          jobId: s.jobId,
          jobNumber: job?.number ?? null,
          jobTitle: job?.title ?? "",
          qty: s.qty,
          qtyText: s.qty == null ? `${r4(s.lineQty)} ${s.lineUnit ?? ""}`.trim() : `${cm(s.qty)} ${stockUnitText(p)}`,
          link: s.link,
          jobPo: s.jobPo,
          route,
          routeText,
          lead: stillToCome ? await leadFlag(p, s, sentAt) : null,
        });
      }
      rows.push({
        id: p.id,
        name: productName(p),
        size: p.size,
        category: p.category,
        supplierId: supplierOf(p),
        mode,
        modeLabel: SUPPLY_LABEL[mode],
        unit: stockUnitText(p),
        purchaseUnit: p.purchaseUnit,
        reorderLevel: p.reorderLevel,
        leadTimeDays: p.leadTimeDays,
        costPrice: perms.viewCosts ? p.costPrice : null,
        numbers: {
          physical: n.physical,
          available: n.available,
          committed: n.committed,
          incomingJob: n.incomingJob,
          incomingFree: n.incomingFree,
          draftJob: n.draftJob,
          draftFree: n.draftFree,
          shortLinked: n.shortLinked,
          shortOnJobPo: n.shortOnJobPo,
          shortUncovered: n.shortUncovered,
          sentPos: n.sentPos,
          draftPos: n.draftPos,
        },
        state: st,
        shortages,
        settings: settingsOf(p),
      });
    }

    const groups = new Map<number | null, typeof rows>();
    for (const r of rows) groups.set(r.supplierId, [...(groups.get(r.supplierId) ?? []), r]);
    const orders = await warehouseOrders(false);
    const view = orders.map((o) =>
      perms.viewCosts
        ? o
        : {
            ...o,
            goodsExGst: null,
            chargesExGst: null,
            freightExGst: null,
            totalExGst: null,
            supplierDepositExGst: null,
            lines: o.lines.map((l) => ({ ...l, unitCostExGst: null, totalExGst: null, standardUnitCostExGst: null })),
            bills: o.bills.map((b) => ({ ...b, totalIncGst: null, totalExGst: null })),
          },
    );
    return {
      s6: sw.s6,
      s1: sw.s1,
      canSeeCosts: perms.viewCosts,
      isMainAdmin: context.actor.isMainAdmin,
      suppliers: [...groups.entries()]
        .map(([id, products]) => ({
          supplierId: id,
          supplierName: id == null ? "No supplier set" : (sups.get(id) ?? "Supplier"),
          draft: orders.find((o) => o.supplierId === id && o.status === "draft") ? { id: orders.find((o) => o.supplierId === id && o.status === "draft")!.id, number: orders.find((o) => o.supplierId === id && o.status === "draft")!.number } : null,
          products,
        }))
        .sort((a, b) => a.supplierName.localeCompare(b.supplierName)),
      orders: view,
    };
  }),

  /** Products to set up, by name (one row at a time; never a whole supplier or category). */
  products: adminOnly.input(z.object({ q: z.string().trim().max(80) })).handler(async ({ input }) => {
    const q = input.q.toLowerCase();
    if (q.length < 2) return [];
    const rows = await db.select().from(schema.products).where(eq(schema.products.active, true)).limit(4000);
    const sups = await supplierNames();
    return rows
      .filter((p) => `${productName(p)} ${p.size ?? ""}`.toLowerCase().includes(q))
      .slice(0, 25)
      .map((p) => ({ id: p.id, name: productName(p), size: p.size, category: p.category, unit: p.unit, supplier: sups.get(p.supplierId ?? -1) ?? null, settings: settingsOf(p) }));
  }),

  /** Save one product's supply settings. Stamps who and when. Never applied to other products. */
  saveSupply: adminOnly.input(supplyInput).handler(async ({ input, context }) => {
    const [p] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
    if (!p) throw notFound("Product not found");
    if (input.supplyMode !== "job" && !input.stockTracked) throw bad('Tick "We count this" for a stocked product.');
    if (input.supplyMode === "reorder") {
      if (input.reorderLevel == null) throw bad("Enter the reorder level.");
      if (input.reorderMethod === "target" && !(input.targetLevel != null && input.targetLevel > input.reorderLevel)) throw bad("The target level must be above the reorder level.");
      if (input.reorderMethod === "fixed" && !(input.reorderQty && input.reorderQty > 0)) throw bad("Enter the reorder quantity.");
    }
    if (input.purchaseUnit && !input.stockPerPurchase) throw bad(`How many ${input.stockUnitLabel || "stock units"} are in one ${input.purchaseUnit}?`);
    // A2c: a product counted in whole units says what one is, so every screen uses the same word.
    if ((input.stockTracked || input.supplyMode !== "job") && lineUnitOf(p) === "unit" && !input.stockUnitLabel) throw bad("Enter the stock unit word, for example bags or pails.");
    if (input.preferredSupplierId != null) {
      const [s] = await db.select({ id: schema.suppliers.id }).from(schema.suppliers).where(eq(schema.suppliers.id, input.preferredSupplierId));
      if (!s) throw bad("Supplier not found.");
    }
    const { productId, ...rest } = input;
    await db
      .update(schema.products)
      .set({ ...rest, supplySetAt: new Date(), supplySetBy: context.actor.name, updatedAt: new Date() })
      .where(eq(schema.products.id, productId));
    await db.insert(schema.activityLog).values({
      entityType: "product",
      entityId: productId,
      action: "stock_supply",
      detail: `Supply set to "${SUPPLY_LABEL[input.supplyMode]}"${input.reorderLevel != null ? `, reorder level ${input.reorderLevel}` : ""}.`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    const [after] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
    return settingsOf(after!);
  }),

  /** 7F: the products to look at before anything goes live. Read only. */
  reviewList: adminOnly.handler(async () => {
    const items = await db.select({ productId: schema.stockItems.productId, qty: schema.stockItems.qty }).from(schema.stockItems).where(eq(schema.stockItems.status, "available"));
    const onShelf = new Map<number, number>();
    for (const i of items) onShelf.set(i.productId, r4((onShelf.get(i.productId) ?? 0) + i.qty));
    const ids = [...onShelf.keys()];
    const rows = await db
      .select()
      .from(schema.products)
      .where(
        or(
          eq(schema.products.stockTracked, true),
          eq(schema.products.heldInWarehouse, true),
          ne(schema.products.supplyMode, "job"),
          ...(ids.length ? [inArray(schema.products.id, ids)] : []),
        ),
      );
    const sups = await supplierNames();
    const list = rows
      .map((p) => ({
        id: p.id,
        name: productName(p),
        size: p.size,
        category: p.category,
        supplier: sups.get(supplierOf(p) ?? -1) ?? null,
        modeLabel: SUPPLY_LABEL[modeOf(p)],
        stockTracked: p.stockTracked,
        heldInWarehouse: p.heldInWarehouse,
        onShelf: onShelf.get(p.id) ?? 0,
        reviewed: p.supplySetAt ? { at: p.supplySetAt, by: p.supplySetBy } : null,
        issues: reviewIssues(p, onShelf.get(p.id) ?? 0),
        settings: settingsOf(p),
      }))
      .sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
    return { list, heldInWarehouse: list.filter((r) => r.heldInWarehouse).map((r) => ({ id: r.id, name: r.name, size: r.size, modeLabel: r.modeLabel })) };
  }),

  /* ------------------------------ orders -------------------------------- */

  draftSuggestions: adminOnly
    .input(z.object({ supplierId: z.number().int(), productIds: z.array(z.number().int()).max(200).nullish() }))
    .handler(({ input, context }) => draftSuggestions(input.supplierId, input.productIds ?? null, context.actor)),
  editDraftLine: adminOnly
    .input(z.object({ poId: z.number().int(), productId: z.number().int(), generalQty: z.number().min(0).max(1_000_000), unitCostExGst: z.number().min(0).max(1_000_000).nullish() }))
    .handler(({ input, context }) => editDraftLine(input, context.actor)),
  editTerms: adminOnly
    .input(
      z.object({
        poId: z.number().int(),
        freightExGst: z.number().min(0).max(1_000_000).nullish(),
        expectedPayDate: day.or(z.literal("")).nullish(),
        supplierDepositExGst: z.number().min(0).max(10_000_000).nullish(),
        supplierDepositDue: day.or(z.literal("")).nullish(),
        notes: z.string().max(2000).optional(),
      }),
    )
    .handler(({ input, context }) => editWarehouseTerms(input, context.actor)),
  /** Route B: the shortage goes on the supplier's warehouse draft, kept for that job. */
  toWarehouse: adminOnly.input(z.object({ holdId: z.number().int() })).handler(({ input, context }) => addShortageToWarehouse(input.holdId, context.actor)),
  /** Route A: the job's own PO (a draft; sending stays a button). */
  toJobPo: adminOnly.input(z.object({ holdId: z.number().int() })).handler(({ input, context }) => shortageToJobPo(input.holdId, context.actor)),
  removeLink: adminOnly.input(z.object({ linkId: z.number().int() })).handler(({ input, context }) => removeShortageLink(input.linkId, context.actor)),
  closeLine: adminOnly
    .input(z.object({ lineId: z.number().int(), note: z.string().trim().min(3).max(300) }))
    .handler(({ input, context }) => closeLine(input.lineId, input.note, context.actor)),

  /* ------------------- container and stock-only (7D) ------------------- */

  /** Shortages on a quote before it goes out. Staff see them; only the main admin can approve. */
  quoteSupply: staffOnly.input(z.object({ quoteId: z.number().int() })).handler(async ({ input, context }) => {
    const [q] = await db.select({ id: schema.quotes.id, jobId: schema.quotes.jobId }).from(schema.quotes).where(eq(schema.quotes.id, input.quoteId));
    if (!q) throw notFound("Quote not found");
    const shorts = await supplyShorts(await quoteSupplyLines(q.id), q.jobId, { entityType: "quote", entityKey: String(q.id) });
    return { shorts, canApprove: context.actor.isMainAdmin };
  }),
  approveShort: staffOnly
    .input(z.object({ entityType: z.enum(["quote", "sale"]), entityKey: z.string().trim().min(1).max(80), productId: z.number().int(), shortQty: z.number().positive(), note: z.string().trim().min(5).max(500) }))
    .handler(({ input, context }) => approveSupplyShort(input, context.actor)),
  /** A2c: the arrangement the customer agreed to for a short product. Main admin only (checked in lib). Kept apart from the internal note. */
  customerArrangement: staffOnly
    .input(
      z.object({ orderId: z.number().int().nullish(), invoiceId: z.number().int().nullish(), productId: z.number().int(), arrangement: z.string().trim().min(10).max(500), customerAgreed: z.boolean() }),
    )
    .handler(({ input, context }) => {
      const base = { productId: input.productId, arrangement: input.arrangement, customerAgreed: input.customerAgreed };
      if (input.orderId != null) return recordCustomerArrangement({ ...base, orderId: input.orderId }, context.actor);
      if (input.invoiceId != null) return recordCustomerArrangement({ ...base, invoiceId: input.invoiceId }, context.actor);
      throw bad("Choose the order or invoice.");
    }),
};
