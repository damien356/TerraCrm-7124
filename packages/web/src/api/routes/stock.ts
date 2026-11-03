import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  AWAITING_CONFIRM,
  bad,
  cardCheck,
  COST_UNKNOWN,
  CONDITION_LABEL,
  need,
  needOn,
  saveStockRules,
  setCardCheck,
  setStockPermission,
  setSwitch,
  STAGE_LABEL,
  stockPerms,
  stockRules,
  SWITCHES,
  switches,
  type SwitchKey,
} from "../lib/stock/core";
import { approveCount, approveItem, createItem, ITEM_TYPES, itemById, movementsOf, recordCount, setItemCost, writeOff } from "../lib/stock/items";
import { allocate, availableOn, cutHold, extendHold, holdsOfOrder, holdsOnItem, outstanding, pickHold, releaseHold, replaceItem, takeOut } from "../lib/stock/holds";
import { bringIntoWorkflow, completePercent, confirmForStock, depositState, kindOfJob, orderOfJob, startPosition, stockLinesOf, switchFor } from "../lib/stock/orders";
import { recheckAfterPayment, recheckAll, recheckOrder, reserveStatus } from "../lib/stock/recheck";
import { receiveLine } from "../lib/stock/receiving";
import { approveReturn, returnFromJob } from "../lib/stock/returns";
import { approveFree, declineFree } from "../lib/stock/remainders";
import { generalStockValue, jobMaterialTotal } from "../lib/stock/costs";

/* ---------------------------------------------------------------------------
 * Warehouse stock (v3 + amendment A1). Thin: every rule, permission tick and
 * switch is checked in lib/stock. Off switches mean these screens show, but
 * nothing new can be done.
 * ------------------------------------------------------------------------- */

const key = z.string().trim().min(6).max(80);
const productName = (p: { brand: string | null; range: string | null; colour: string | null } | null) =>
  p ? [p.brand, p.range, p.colour].filter(Boolean).join(" ") || "Product" : "Product";

/** Costs only for people who may see them. */
async function itemView(it: typeof schema.stockItems.$inferSelect, showCost: boolean) {
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, it.productId));
  const [loc] = it.locationId ? await db.select().from(schema.stockLocations).where(eq(schema.stockLocations.id, it.locationId)) : [];
  return {
    id: it.id,
    code: it.code,
    type: it.type,
    product: productName(p ?? null),
    productId: it.productId,
    colour: it.colour,
    batch: it.batch,
    unit: it.unit,
    qty: it.qty,
    widthM: it.widthM,
    available: await availableOn(it.id),
    status: it.status,
    condition: it.condition,
    conditionLabel: CONDITION_LABEL[it.condition] ?? it.condition,
    location: loc?.name ?? null,
    terraOwned: it.terraOwned,
    costLabel: showCost ? (it.costStatus === "unknown" ? COST_UNKNOWN : it.unitCost != null ? `$${it.unitCost.toFixed(2)} per ${it.costPer} (${it.costStatus})` : null) : null,
    costUnknown: it.costStatus === "unknown",
  };
}

async function holdView(h: typeof schema.stockReservations.$inferSelect) {
  const it = h.stockItemId ? await itemById(h.stockItemId).catch(() => null) : null;
  const [job] = h.jobId ? await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, h.jobId)) : [];
  return {
    id: h.id,
    jobId: h.jobId,
    jobNumber: job?.number ?? null,
    itemId: h.stockItemId,
    itemCode: it?.code ?? null,
    unit: it?.unit ?? h.lineUnit,
    qty: h.qty,
    outstanding: outstanding(h),
    collectedQty: h.collectedQty,
    orderedQty: h.orderedQty,
    lineUnit: h.lineUnit,
    freeQty: h.freeQty,
    freeState: h.freeState,
    status: h.status,
    statusLabel: STAGE_LABEL[h.status] ?? h.status,
    expiresAt: h.expiresAt,
    note: h.confirmNote ?? h.releaseReason ?? null,
    byName: h.appliedByName,
  };
}

const actorOf = (a: { role: "admin" | "office" | "field"; profileId: number | null; canSeeCosts: boolean; isMainAdmin: boolean; name: string }) => a;

export const stock = {
  /** The stock list: switches, my ticks, items with what is free. */
  overview: staffOnly.input(z.object({ q: z.string().trim().max(80).optional(), includeEnded: z.boolean().optional() }).optional()).handler(async ({ input, context }) => {
    const perms = await stockPerms(context.actor);
    const rows = await db
      .select()
      .from(schema.stockItems)
      .where(input?.includeEnded ? undefined : inArray(schema.stockItems.status, ["available", "to_check"]))
      .orderBy(desc(schema.stockItems.id))
      .limit(300);
    const items = [];
    for (const it of rows) {
      const v = await itemView(it, perms.viewCosts);
      if (input?.q && !`${v.code} ${v.product} ${v.colour ?? ""} ${v.batch ?? ""}`.toLowerCase().includes(input.q.toLowerCase())) continue;
      items.push(v);
    }
    const alerts = await db.select().from(schema.stockAlerts).orderBy(desc(schema.stockAlerts.id)).limit(20);
    return {
      switches: await switches(),
      switchLabels: Object.fromEntries(Object.entries(SWITCHES).map(([k, v]) => [k, v.label])) as Record<SwitchKey, string>,
      cardCheck: await cardCheck(),
      rules: await stockRules(),
      perms,
      isMainAdmin: context.actor.isMainAdmin,
      role: context.actor.role,
      items,
      value: perms.viewCosts ? await generalStockValue() : null,
      alerts: alerts.map((a) => ({ id: a.id, kind: a.kind, title: a.title, body: a.body, jobId: a.jobId, at: a.createdAt, sent: !!a.sentAt })),
      locations: await db.select().from(schema.stockLocations).orderBy(schema.stockLocations.name),
    };
  }),

  item: staffOnly.input(z.object({ id: z.number().int() })).handler(async ({ input, context }) => {
    const perms = await stockPerms(context.actor);
    const it = await itemById(input.id);
    const holds = await Promise.all((await holdsOnItem(it.id)).map(holdView));
    const counts = await db.select().from(schema.stockCounts).where(eq(schema.stockCounts.stockItemId, it.id)).orderBy(desc(schema.stockCounts.id));
    // The cost on each movement row only for people who may see costs (v3 11.4).
    const movements = (await movementsOf(it.id)).map((m) => (perms.viewCosts ? m : { ...m, unitCostExGst: null }));
    return { item: await itemView(it, perms.viewCosts), holds, movements, counts, perms };
  }),

  /** Products that can be stocked, for opening stock and allocation. */
  products: staffOnly.input(z.object({ q: z.string().trim().max(80) })).handler(async ({ input }) => {
    const rows = await db.select().from(schema.products).where(eq(schema.products.active, true)).limit(2000);
    const q = input.q.toLowerCase();
    return rows
      .filter((p) => !q || productName(p).toLowerCase().includes(q))
      .slice(0, 30)
      .map((p) => ({ id: p.id, name: productName(p), unit: p.unit, category: p.category, widthM: p.widthM }));
  }),

  /** Opening stock: each piece starts "to check" until an Admin approves it. */
  openingStock: staffOnly
    .input(
      z.object({
        productId: z.number().int(),
        type: z.enum(ITEM_TYPES),
        unit: z.string().trim().min(1).max(10),
        qty: z.number().positive(),
        widthM: z.number().positive().nullish(),
        batch: z.string().trim().max(60).nullish(),
        colour: z.string().trim().max(60).optional(),
        locationId: z.number().int().nullish(),
        costPer: z.enum(["lm", "m2", "unit"]).optional(),
        unitCost: z.number().positive().nullish(),
        costUnknown: z.boolean(),
        note: z.string().trim().max(300).optional(),
        requestKey: key,
      }),
    )
    .handler(async ({ input, context }) => {
      await need(context.actor, "handle");
      await needOn("s1");
      if (input.unitCost == null && !input.costUnknown) throw bad(`Enter the cost, or tick "${COST_UNKNOWN}".`);
      const { requestKey, costUnknown, ...rest } = input;
      return createItem(
        { ...rest, unitCost: costUnknown ? null : (rest.unitCost ?? null), costStatus: costUnknown ? "unknown" : "provisional", terraOwned: true },
        context.actor,
        { status: "to_check", kind: "opening", requestKey },
      );
    }),

  approveItem: adminOnly.input(z.object({ id: z.number().int() })).handler(({ input, context }) => approveItem(input.id, context.actor)),

  setCost: adminOnly
    .input(z.object({ id: z.number().int(), unitCost: z.number().positive().nullable(), costStatus: z.enum(["final", "provisional", "estimate", "unknown"]), note: z.string().trim().min(3).max(300) }))
    .handler(({ input, context }) => setItemCost(input.id, input, context.actor)),

  count: staffOnly.input(z.object({ id: z.number().int(), counted: z.number().min(0) })).handler(({ input, context }) => recordCount(input.id, input.counted, context.actor)),
  approveCount: adminOnly.input(z.object({ countId: z.number().int() })).handler(({ input, context }) => approveCount(input.countId, context.actor)),
  writeOff: adminOnly
    .input(z.object({ id: z.number().int(), qty: z.number().positive(), reason: z.string().trim().min(3).max(300) }))
    .handler(({ input, context }) => writeOff(input.id, input.qty, input.reason, context.actor)),

  /** PO lines waiting to be received. Drafts are never received. */
  receivable: staffOnly.input(z.object({ poId: z.number().int() })).handler(async ({ input }) => {
    const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, input.poId));
    if (!po) throw bad("PO not found.");
    const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id));
    return { po: { id: po.id, number: po.number, status: po.status, jobId: po.jobId }, lines: lines.map((l) => ({ id: l.id, description: l.description, qty: l.qty, unit: l.unit, productId: l.productId })) };
  }),
  receive: staffOnly
    .input(
      z.object({
        poLineId: z.number().int(),
        pieces: z
          .array(
            z.object({
              qty: z.number().positive(),
              labelQty: z.number().positive().nullish(),
              widthM: z.number().positive().nullish(),
              batch: z.string().trim().max(60).nullish(),
              supplierRollNo: z.string().trim().max(60).optional(),
              packSize: z.number().positive().nullish(),
              locationId: z.number().int().nullish(),
            }),
          )
          .min(1)
          .max(50),
        requestKey: key,
      }),
    )
    .handler(({ input, context }) => receiveLine(input, context.actor)),

  /** The stock panel on a job or a product sale. */
  jobPanel: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input, context }) => {
    const perms = await stockPerms(context.actor);
    const { kind } = await kindOfJob(input.jobId);
    const sw = (await switches())[switchFor(kind)];
    const order = await orderOfJob(input.jobId);
    const dep = order ? await depositState(order) : null;
    const rawHolds = order ? await holdsOfOrder(order.id) : [];
    const holds = await Promise.all(rawHolds.map(holdView));
    const productIds = new Set<number>();
    for (const r of await db.select({ p: schema.quoteItems.productId }).from(schema.quoteItems).innerJoin(schema.quotes, eq(schema.quotes.id, schema.quoteItems.quoteId)).where(eq(schema.quotes.jobId, input.jobId))) if (r.p) productIds.add(r.p);
    for (const r of await db.select({ p: schema.jobMaterials.productId }).from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, input.jobId))) if (r.p) productIds.add(r.p);
    const candidates = productIds.size
      ? await db.select().from(schema.stockItems).where(and(inArray(schema.stockItems.productId, [...productIds]), eq(schema.stockItems.status, "available")))
      : [];
    const choices = [];
    for (const it of candidates) choices.push(await itemView(it, perms.viewCosts));
    const accepted = !!(await db.select({ id: schema.quotes.id }).from(schema.quotes).where(and(eq(schema.quotes.jobId, input.jobId), eq(schema.quotes.status, "accepted"))).limit(1))[0];
    return {
      kind,
      switchKey: switchFor(kind),
      switchState: sw.state,
      order,
      deposit: dep
        ? {
            code: dep.code,
            label: dep.label,
            percent: dep.percent,
            required: dep.required,
            confirmed: dep.confirmed,
            recordedUnconfirmed: dep.recordedUnconfirmed,
            stillToPay: dep.stillToPay,
            payments: dep.payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, source: p.source, paidOn: p.paidOn, counts: p.counts, why: p.why, confirmedBy: p.confirmedBy })),
          }
        : null,
      awaitingConfirmLabel: AWAITING_CONFIRM,
      reserveStatus: reserveStatus(rawHolds),
      holds,
      choices,
      lines: await stockLinesOf(input.jobId),
      perms,
      canBringIn: context.actor.role === "admin" && (!order || order.status === "planned") && accepted && sw.state !== "off",
      startPosition: order?.startPosition ? JSON.parse(order.startPosition) : null,
      materialTotal: perms.viewCosts ? await jobMaterialTotal(input.jobId) : null,
    };
  }),

  allocate: staffOnly
    .input(
      z.object({
        jobId: z.number().int(),
        itemId: z.number().int().nullable(),
        orderedQty: z.number().positive(),
        lineUnit: z.string().trim().min(1).max(10),
        productId: z.number().int().nullish(),
        quoteItemId: z.number().int().nullish(),
        saleLineId: z.number().int().nullish(),
        jobMaterialId: z.number().int().nullish(),
        temporary: z.boolean().optional(),
        batchApproved: z.boolean().optional(),
        requestKey: key,
      }),
    )
    .handler(({ input, context }) => allocate(input, actorOf(context.actor))),

  extendHold: staffOnly.input(z.object({ holdId: z.number().int(), reason: z.string().trim().min(3).max(300) })).handler(({ input, context }) => extendHold(input.holdId, input.reason, context.actor)),
  releaseHold: staffOnly.input(z.object({ holdId: z.number().int(), reason: z.string().trim().min(3).max(300) })).handler(({ input, context }) => releaseHold(input.holdId, input.reason, context.actor)),
  cutHold: staffOnly.input(z.object({ holdId: z.number().int(), requestKey: key })).handler(({ input, context }) => cutHold(input.holdId, input.requestKey, context.actor)),
  pickHold: staffOnly.input(z.object({ holdId: z.number().int() })).handler(({ input, context }) => pickHold(input.holdId, context.actor)),
  takeOut: staffOnly.input(z.object({ holdId: z.number().int(), qty: z.number().positive(), requestKey: key })).handler(({ input, context }) => takeOut(input.holdId, input.qty, input.requestKey, context.actor)),
  replaceItem: staffOnly.input(z.object({ holdId: z.number().int(), newItemId: z.number().int(), requestKey: key })).handler(({ input, context }) => replaceItem(input.holdId, input.newItemId, input.requestKey, context.actor)),
  approveFree: adminOnly.input(z.object({ holdId: z.number().int() })).handler(({ input, context }) => approveFree(input.holdId, context.actor)),
  declineFree: staffOnly.input(z.object({ holdId: z.number().int() })).handler(({ input, context }) => declineFree(input.holdId, context.actor)),

  /** "Recheck stock" on one order, worked out again from the facts. */
  recheck: staffOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input }) => {
    const o = await orderOfJob(input.jobId);
    if (!o) throw bad("No stock order on this job yet.");
    return recheckOrder(o.id);
  }),
  recheckAll: adminOnly.handler(() => recheckAll()),

  /** Admin: "Confirm for stock" on a payment already recorded. No new payment is made. */
  confirmPayment: adminOnly.input(z.object({ paymentId: z.number().int(), note: z.string().trim().max(300).optional() })).handler(async ({ input, context }) => {
    const out = await confirmForStock(input.paymentId, input.note || "I have checked the bank: confirm for stock", context.actor);
    const results = await recheckAfterPayment(out.confirmation.invoiceId);
    return { ...out, results };
  }),

  completePercent: staffOnly.input(z.object({ orderId: z.number().int(), percent: z.number().min(0).max(100) })).handler(async ({ input, context }) => {
    const o = await completePercent(input.orderId, input.percent, context.actor);
    await recheckOrder(o.id);
    return o;
  }),

  startPosition: adminOnly.input(z.object({ jobId: z.number().int() })).handler(({ input }) => startPosition(input.jobId)),
  bringIn: adminOnly.input(z.object({ jobId: z.number().int() })).handler(async ({ input, context }) => {
    const out = await bringIntoWorkflow(input.jobId, context.actor);
    await recheckOrder(out.order.id);
    return out;
  }),

  /** Stock waiting on this invoice: shows the Admin tick on Mark paid. */
  invoiceStock: staffOnly.input(z.object({ invoiceId: z.number().int() })).handler(async ({ input }) => {
    const { ordersForInvoice } = await import("../lib/stock/orders");
    const orders = await ordersForInvoice(input.invoiceId);
    for (const o of orders) {
      const d = await depositState(o);
      if (d.code !== "confirmed" && d.code !== "cancelled") return { waiting: true, label: d.label };
    }
    return { waiting: false, label: null };
  }),

  returnFromJob: staffOnly
    .input(
      z.object({
        holdId: z.number().int(),
        kind: z.enum(["unopened", "opened", "leftover"]),
        qty: z.number().positive(),
        widthM: z.number().positive().nullish(),
        terraOwned: z.boolean().optional(),
        note: z.string().trim().max(300).optional(),
        requestKey: key,
      }),
    )
    .handler(({ input, context }) => returnFromJob(input, context.actor)),
  approveReturn: adminOnly.input(z.object({ itemId: z.number().int() })).handler(({ input, context }) => approveReturn(input.itemId, context.actor)),

  /* ------------------------------ settings ------------------------------- */

  setSwitch: adminOnly
    .input(z.object({ key: z.enum(["s1", "s2", "s3", "s4", "s5"]), state: z.enum(["off", "on", "paused"]) }))
    .handler(({ input, context }) => setSwitch(input.key, input.state, context.actor)),
  setCardCheck: adminOnly.input(z.object({ done: z.boolean(), note: z.string().trim().max(300) })).handler(({ input, context }) => setCardCheck(input.done, input.note, context.actor)),
  saveRules: adminOnly
    .input(z.object({ carpetKeepMinM: z.number().optional(), vinylFreeMaxM: z.number().optional(), holdHours: z.number().optional(), warnHours: z.number().optional() }))
    .handler(({ input }) => saveStockRules(input)),
  permissions: adminOnly.handler(async () => {
    const people = await db.select().from(schema.profiles).where(and(eq(schema.profiles.active, true), isNull(schema.profiles.archivedAt)));
    const ticks = await db.select().from(schema.stockPermissions);
    const by = new Map(ticks.map((t) => [t.profileId, t]));
    return people.map((p) => ({ profileId: p.id, name: p.name, role: p.role, handle: by.get(p.id)?.handle ?? false, allocate: by.get(p.id)?.allocate ?? false, changeCosts: by.get(p.id)?.changeCosts ?? false }));
  }),
  setPermission: adminOnly
    .input(z.object({ profileId: z.number().int(), handle: z.boolean().optional(), allocate: z.boolean().optional(), changeCosts: z.boolean().optional() }))
    .handler(({ input, context }) => setStockPermission(input.profileId, input, context.actor)),
};
