import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { stockAlert } from "./alerts";
import { BLOCKING, cm, isOn, r4, unitText } from "./core";

/* ---------------------------------------------------------------------------
 * A2: supply settings, the numbers per product, and the reorder suggestion.
 *
 * Read only. Nothing here orders, sends, contacts a supplier or changes a
 * date. A suggestion is a number on a screen until an Admin presses a button.
 *
 * Numbers per product, all in the stock unit:
 *   physical         good, unopened stock on the shelf (opened is internal use only)
 *   committed        what firm and temporary holds still take off that stock
 *   available        physical less committed
 *   incomingJob      sent warehouse orders, the part kept for named jobs (not free)
 *   incomingFree     sent warehouse orders, the rest (general warehouse stock)
 *   draftJob/Free    the same on unsent drafts: proposed, never "incoming"
 *   shortLinked      job shortages already on a warehouse order (route B)
 *   shortOnJobPo     job shortages on the job's own PO (route A)
 *   shortUncovered   job shortages nobody has chosen a route for yet
 *
 * A job shortage is counted once: as linked incoming, on a job PO, or as
 * uncovered. Never as two of them, and never against general stock.
 * ------------------------------------------------------------------------- */

export const SUPPLY_MODES = ["job", "reorder", "container", "stock_only"] as const;
export type SupplyMode = (typeof SUPPLY_MODES)[number];
export const SUPPLY_LABEL: Record<SupplyMode, string> = {
  job: "Order for each job/sale",
  reorder: "Stocked — reorder from supplier",
  container: "Stocked — owner-approved bulk/container replenishment",
  stock_only: "Stock only — no planned replenishment",
};
/** What the crew and the job page see for a quantity that is not on the shelf yet. */
export const SHORT_LABEL: Record<SupplyMode, string> = {
  job: "Not ordered yet",
  reorder: "Not ordered yet",
  container: "Stock shortage — owner review required",
  stock_only: "Insufficient stock — no replenishment planned",
};
export const LOW_CONTAINER_TEXT = "Low stock — owner review required for bulk/container replenishment.";
export const LEAD_LATE_TEXT = "Material may arrive after the required date — check with supplier";
export const LEAD_UNKNOWN_TEXT = "Lead time unknown — confirm with supplier.";

export type Product = typeof schema.products.$inferSelect;
export const modeOf = (p: Pick<Product, "supplyMode">): SupplyMode => ((SUPPLY_MODES as readonly string[]).includes(p.supplyMode) ? (p.supplyMode as SupplyMode) : "job");
/** Display name. Tidies price-book spacing and never repeats the brand or colour ("Cemimax  Cemimax  A2000" reads "Cemimax A2000"). */
export const productName = (p: Pick<Product, "brand" | "range" | "colour"> | null | undefined) => {
  if (!p) return "Product";
  const tidy = (x: string | null | undefined) => (x ?? "").replace(/\s+/g, " ").trim();
  const brand = tidy(p.brand);
  const range = tidy(p.range);
  const colour = tidy(p.colour);
  const parts = [range.toLowerCase().startsWith(brand.toLowerCase()) ? "" : brand, range];
  if (colour && colour.toLowerCase() !== "standard" && !range.toLowerCase().endsWith(colour.toLowerCase())) parts.push(colour);
  return parts.filter(Boolean).join(" ") || "Product";
};
/** The supplier a warehouse order goes to: the one chosen for stock, else the price book's. */
export const supplierOf = (p: Pick<Product, "preferredSupplierId" | "supplierId">) => p.preferredSupplierId ?? p.supplierId ?? null;
/** The unit a warehouse PO line is written in, which is also what receiving counts. */
export const lineUnitOf = (p: Pick<Product, "unit">) => (p.unit === "m2" || p.unit === "lm" || p.unit === "box" ? p.unit : "unit");
export const stockUnitText = (p: Pick<Product, "stockUnitLabel" | "unit">) => p.stockUnitLabel || unitText(lineUnitOf(p) === "unit" ? "each" : lineUnitOf(p));

/**
 * A shortage row is written in the order line's unit. Warehouse orders count
 * in the stock unit. Null: the two do not convert safely (m² against a box
 * of unknown size), so the shortage has to go on the job's own PO.
 */
export function toStockUnits(qty: number, lineUnit: string | null, p: Pick<Product, "unit" | "widthM">): number | null {
  const stock = lineUnitOf(p);
  const u = lineUnit ?? stock;
  const each = (x: string) => x === "unit" || x === "each" || x === "ea" || x === "item";
  if (u === stock || (each(u) && each(stock))) return r4(qty);
  if (u === "m2" && stock === "lm" && p.widthM) return r4(qty / p.widthM);
  return null;
}

/**
 * How many stock units one unit of a stock item is. Rolls are counted in
 * metres and boxes as boxes, but a product sold by the m² is counted in m²:
 * a 4 m wide roll gives 4 m² per metre, a box of 2.2 m² gives 2.2 m².
 */
export function itemFactor(it: { unit: string; widthM: number | null; packSize: number | null }, p: Pick<Product, "unit">) {
  const stock = lineUnitOf(p);
  if (it.unit === stock) return 1;
  if (it.unit === "lm" && stock === "m2" && it.widthM) return it.widthM;
  if (it.unit === "box" && stock === "m2" && it.packSize) return it.packSize;
  return 1;
}

/* ------------------------------ order sizes ------------------------------- */

/**
 * The order quantity for a need, in stock units. Converts to purchase units,
 * then takes the smallest quantity that is at least the need AND meets both
 * the minimum and the multiple (min 5, multiple 4 gives 8). A need of 0 stays 0.
 */
export function roundOrder(needStock: number, p: Pick<Product, "stockPerPurchase" | "reorderMinQty" | "orderMultiple">) {
  if (!(needStock > 0.0001)) return { purchaseQty: 0, stockQty: 0 };
  const per = p.stockPerPurchase && p.stockPerPurchase > 0 ? p.stockPerPurchase : 1;
  let q = Math.ceil(needStock / per - 1e-9);
  const min = p.reorderMinQty && p.reorderMinQty > 0 ? p.reorderMinQty : 0;
  if (q < min) q = min;
  const mult = p.orderMultiple && p.orderMultiple > 0 ? p.orderMultiple : 0;
  if (mult) q = Math.ceil(q / mult - 1e-9) * mult;
  q = r4(q);
  return { purchaseQty: q, stockQty: r4(q * per) };
}

/* -------------------------------- numbers --------------------------------- */

export type Shortage = {
  holdId: number;
  jobId: number;
  orderId: number | null;
  jobMaterialId: number | null;
  quoteItemId: number | null;
  saleLineId: number | null;
  /** In the stock unit. Null: does not convert (route A only). */
  qty: number | null;
  lineQty: number;
  lineUnit: string | null;
  /** open link on a warehouse order */
  link: { id: number; poId: number; poNumber: string; poStatus: string; qty: number; receivedQty: number } | null;
  /** the job material is on the job's own PO */
  jobPo: { id: number; number: string; status: string } | null;
};

export type Numbers = {
  productId: number;
  physical: number;
  committed: number;
  available: number;
  incomingJob: number;
  incomingFree: number;
  draftJob: number;
  draftFree: number;
  shortLinked: number;
  shortOnJobPo: number;
  shortUncovered: number;
  /** Shortages that do not convert to the stock unit. */
  shortOther: number;
  shortages: Shortage[];
  sentPos: string[];
  draftPos: string[];
};

const empty = (productId: number): Numbers => ({
  productId,
  physical: 0,
  committed: 0,
  available: 0,
  incomingJob: 0,
  incomingFree: 0,
  draftJob: 0,
  draftFree: 0,
  shortLinked: 0,
  shortOnJobPo: 0,
  shortUncovered: 0,
  shortOther: 0,
  shortages: [],
  sentPos: [],
  draftPos: [],
});

export async function productNumbers(products: Product[]): Promise<Map<number, Numbers>> {
  const out = new Map<number, Numbers>(products.map((p) => [p.id, empty(p.id)]));
  if (!products.length) return out;
  const ids = products.map((p) => p.id);
  const byId = new Map(products.map((p) => [p.id, p]));

  // Physical and committed: good, unopened, available items, less the blocking holds still to come off them.
  const items = await db
    .select()
    .from(schema.stockItems)
    .where(and(inArray(schema.stockItems.productId, ids), eq(schema.stockItems.status, "available"), eq(schema.stockItems.condition, "good")));
  const itemIds = items.map((i) => i.id);
  const holds = itemIds.length
    ? await db
        .select()
        .from(schema.stockReservations)
        .where(and(inArray(schema.stockReservations.stockItemId, itemIds), inArray(schema.stockReservations.status, BLOCKING)))
    : [];
  for (const it of items) {
    const n = out.get(it.productId)!;
    n.physical = cm(n.physical + it.qty * itemFactor(it, byId.get(it.productId)!));
  }
  for (const h of holds) {
    const it = items.find((i) => i.id === h.stockItemId);
    if (!it) continue;
    const n = out.get(it.productId)!;
    n.committed = cm(n.committed + Math.max(0, h.qty - h.collectedQty) * itemFactor(it, byId.get(it.productId)!));
  }
  for (const n of out.values()) n.available = cm(Math.max(0, n.physical - n.committed));

  // Warehouse orders. Cancelled orders and closed lines stop counting; part receipts come off.
  const lines = await db
    .select({ line: schema.purchaseOrderLines, po: schema.purchaseOrders })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .where(
      and(
        inArray(schema.purchaseOrderLines.productId, ids),
        eq(schema.purchaseOrders.kind, "warehouse"),
        inArray(schema.purchaseOrders.status, ["draft", "sent", "invoiced"]),
        eq(schema.purchaseOrderLines.kind, "goods"),
        isNull(schema.purchaseOrderLines.closedAt),
      ),
    );
  const lineIds = lines.map((l) => l.line.id);
  const links = lineIds.length
    ? await db
        .select()
        .from(schema.stockPoLinks)
        .where(and(inArray(schema.stockPoLinks.poLineId, lineIds), eq(schema.stockPoLinks.status, "open")))
    : [];
  for (const { line, po } of lines) {
    const n = out.get(line.productId!)!;
    const linked = links.filter((k) => k.poLineId === line.id).reduce((s, k) => s + Math.max(0, k.qty - k.receivedQty), 0);
    if (po.status === "draft") {
      const job = Math.min(linked, line.qty);
      n.draftJob = r4(n.draftJob + job);
      n.draftFree = r4(n.draftFree + Math.max(0, line.qty - job));
      if (!n.draftPos.includes(po.number)) n.draftPos.push(po.number);
    } else {
      const left = Math.max(0, line.qty - line.receivedQty);
      if (left <= 0.0001) continue;
      const job = Math.min(linked, left);
      n.incomingJob = r4(n.incomingJob + job);
      n.incomingFree = r4(n.incomingFree + (left - job));
      if (!n.sentPos.includes(po.number)) n.sentPos.push(po.number);
    }
  }

  // Job shortages ("short" rows), and what each is already covered by.
  const shorts = await db
    .select()
    .from(schema.stockReservations)
    .where(and(inArray(schema.stockReservations.productId, ids), eq(schema.stockReservations.status, "short")));
  if (shorts.length) {
    const shortLinks = await db
      .select({ link: schema.stockPoLinks, po: schema.purchaseOrders })
      .from(schema.stockPoLinks)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.stockPoLinks.poId))
      .where(
        and(
          inArray(
            schema.stockPoLinks.reservationId,
            shorts.map((s) => s.id),
          ),
          eq(schema.stockPoLinks.status, "open"),
        ),
      );
    const matIds = shorts.map((s) => s.jobMaterialId).filter((x): x is number => x != null);
    const onJobPo = matIds.length
      ? await db
          .select({ jobMaterialId: schema.purchaseOrderLines.jobMaterialId, id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status })
          .from(schema.purchaseOrderLines)
          .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
          .where(and(inArray(schema.purchaseOrderLines.jobMaterialId, matIds), ne(schema.purchaseOrders.status, "cancelled"), ne(schema.purchaseOrders.kind, "warehouse")))
      : [];
    for (const s of shorts) {
      const n = out.get(s.productId)!;
      const p = byId.get(s.productId)!;
      const lineQty = s.orderedQty ?? s.qty;
      const qty = toStockUnits(lineQty, s.lineUnit, p);
      const l = shortLinks.find((x) => x.link.reservationId === s.id);
      const jp = s.jobMaterialId != null ? onJobPo.find((x) => x.jobMaterialId === s.jobMaterialId) : undefined;
      n.shortages.push({
        holdId: s.id,
        jobId: s.jobId,
        orderId: s.orderId,
        jobMaterialId: s.jobMaterialId,
        quoteItemId: s.quoteItemId,
        saleLineId: s.saleLineId,
        qty,
        lineQty,
        lineUnit: s.lineUnit,
        link: l ? { id: l.link.id, poId: l.po.id, poNumber: l.po.number, poStatus: l.po.status, qty: l.link.qty, receivedQty: l.link.receivedQty } : null,
        jobPo: jp ? { id: jp.id, number: jp.number, status: jp.status } : null,
      });
      if (qty == null) {
        n.shortOther = r4(n.shortOther + lineQty);
        continue;
      }
      if (l) n.shortLinked = r4(n.shortLinked + Math.max(0, l.link.qty - l.link.receivedQty));
      else if (jp) n.shortOnJobPo = r4(n.shortOnJobPo + qty);
      else n.shortUncovered = r4(n.shortUncovered + qty);
    }
  }
  return out;
}

/* ---------------------------- the two states ------------------------------ */

export type SupplyState = {
  mode: SupplyMode;
  /** Available at or below the reorder level, now. */
  lowNow: boolean;
  /** Counting sent orders, drafts and shortages, more needs buying or choosing. */
  needMore: boolean;
  /** General stock to have on the supplier's draft (stock units, rounded). 0: none. */
  suggestStock: number;
  suggestPurchase: number;
  /** One or two plain lines for the screen. */
  text: string[];
  /** Setting gaps that stop a suggestion. */
  missing: string[];
};

/**
 * Two separate answers (7A): "Low stock now" looks only at what is free on
 * the shelf. "Another order needed" also counts sent orders, the draft and
 * the shortages. A product can be low now and still need nothing more.
 */
export function supplyState(p: Product, n: Numbers): SupplyState {
  const mode = modeOf(p);
  const u = stockUnitText(p);
  const q = (x: number) => `${r4(x)} ${u}`.trim();
  const level = p.reorderLevel;
  const lowNow = level != null && n.available <= level + 0.0001;
  const text: string[] = [];
  const missing: string[] = [];
  let suggestStock = 0;
  let suggestPurchase = 0;
  let needMore = false;

  if (mode === "container") {
    if (lowNow) text.push(LOW_CONTAINER_TEXT);
    if (n.shortUncovered + n.shortOther > 0) text.push(`${SHORT_LABEL.container}: ${q(n.shortUncovered + n.shortOther)} short on jobs.`);
    return { mode, lowNow, needMore: false, suggestStock, suggestPurchase, text, missing };
  }
  if (mode === "stock_only") {
    if (lowNow) text.push(`Low stock now: ${q(n.available)} available. No replenishment planned.`);
    if (n.shortUncovered + n.shortOther > 0) text.push(`${SHORT_LABEL.stock_only}: ${q(n.shortUncovered + n.shortOther)} short on jobs.`);
    return { mode, lowNow, needMore: false, suggestStock, suggestPurchase, text, missing };
  }
  if (mode === "job") {
    if (lowNow) text.push(`Low stock now: ${q(n.available)} available.`);
    return { mode, lowNow, needMore: false, suggestStock, suggestPurchase, text, missing };
  }

  // reorder
  if (level == null) missing.push("reorder level");
  if (p.reorderMethod === "target" && !(p.targetLevel != null && level != null && p.targetLevel > level)) missing.push("target level above the reorder level");
  if (p.reorderMethod !== "target" && !(p.reorderQty && p.reorderQty > 0)) missing.push("reorder quantity");
  if (!supplierOf(p)) missing.push("supplier");

  // General stock only: job shares on orders are kept for their jobs and never count here.
  const afterSent = r4(n.available + n.incomingFree);
  if (!missing.length && level != null && afterSent <= level + 0.0001) {
    let need = 0;
    if (p.reorderMethod === "target") need = (p.targetLevel ?? 0) - afterSent;
    else {
      const each = p.reorderQty!;
      need = each * Math.max(1, Math.floor((level - afterSent) / each) + 1);
    }
    const r = roundOrder(need, p);
    suggestStock = r.stockQty;
    suggestPurchase = r.purchaseQty;
  }
  const draftCovers = suggestStock > 0 && n.draftFree >= suggestStock - 0.0001;
  needMore = (suggestStock > 0 && !draftCovers) || n.shortUncovered > 0 || n.shortOther > 0;

  const parts: string[] = [];
  if (lowNow) parts.push(`Low stock now: ${q(n.available)} available.`);
  if (n.incomingFree + n.incomingJob > 0) parts.push(`${q(n.incomingFree + n.incomingJob)} ordered — awaiting receipt.`);
  if (n.draftFree + n.draftJob > 0) parts.push(`${q(n.draftFree + n.draftJob)} on draft ${n.draftPos.join(", ")} — not sent yet.`);
  if (suggestStock > 0 && !draftCovers) {
    const per = p.stockPerPurchase && p.stockPerPurchase > 0 && p.purchaseUnit ? ` (${r4(suggestPurchase)} ${p.purchaseUnit})` : "";
    parts.push(`Another order needed: ${q(suggestStock)}${per} for general warehouse stock.`);
  } else if (lowNow && !missing.length) parts.push("No additional purchase currently suggested.");
  if (parts.length) text.push(parts.join(" "));
  if (n.shortUncovered > 0) text.push(`${q(n.shortUncovered)} short on jobs — choose a job PO or the warehouse order for each.`);
  if (n.shortOther > 0) text.push(`${r4(n.shortOther)} short in a unit that does not convert — use the job's own PO.`);
  if (lowNow && missing.length) text.push(`Settings missing: ${missing.join(", ")}.`);
  return { mode, lowNow, needMore, suggestStock, suggestPurchase, text, missing };
}

/* ------------------------------ low alerts -------------------------------- */

/**
 * One alert per low spell (7A): sent when a product with alerts ticked first
 * reaches its reorder level, and not again until it has gone back above it.
 * The low state itself stays on screen the whole time. Only while S6 is on.
 */
export async function checkLowAlerts(productIds?: number[]) {
  const s6 = await isOn("s6");
  const where = productIds?.length ? inArray(schema.products.id, productIds) : eq(schema.products.lowStockAlerts, true);
  const rows = (await db.select().from(schema.products).where(where)).filter((p) => p.reorderLevel != null);
  if (!rows.length) return { sent: 0, reset: 0 };
  const nums = await productNumbers(rows);
  let sent = 0;
  let reset = 0;
  for (const p of rows) {
    const n = nums.get(p.id)!;
    const low = n.available <= (p.reorderLevel ?? 0) + 0.0001;
    if (!low && p.lowStockAlertedAt) {
      await db.update(schema.products).set({ lowStockAlertedAt: null }).where(eq(schema.products.id, p.id));
      reset += 1;
      continue;
    }
    if (!low || !p.lowStockAlerts || !s6 || p.lowStockAlertedAt) continue;
    const at = new Date();
    const [claimed] = await db
      .update(schema.products)
      .set({ lowStockAlertedAt: at })
      .where(and(eq(schema.products.id, p.id), isNull(schema.products.lowStockAlertedAt)))
      .returning({ id: schema.products.id });
    if (!claimed) continue;
    const st = supplyState(p, n);
    await stockAlert(`low:${p.id}:${at.getTime()}`, "stock_low", {
      title: `Low stock: ${productName(p)}`,
      body: [`${r4(n.available)} ${stockUnitText(p)} available, reorder level ${p.reorderLevel}.`, ...st.text].join(" "),
      path: "/stock/reorder",
    });
    sent += 1;
  }
  return { sent, reset };
}

/* -------------------------------- lead time ------------------------------- */

/** Working days: Monday to Friday. Public holidays are not counted out. */
export function addBusinessDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  let left = Math.max(0, Math.round(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

const brisbaneToday = () => new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);

/** The date the job needs it: its first booked task, else the job's start. Null: no date yet. */
export async function neededDate(jobId: number): Promise<{ date: string; basis: string } | null> {
  const tasks = await db
    .select({ d: schema.jobTasks.scheduledDate, status: schema.jobTasks.status })
    .from(schema.jobTasks)
    .where(eq(schema.jobTasks.jobId, jobId));
  const dates = tasks.filter((t) => t.d && !["cancelled", "complete", "completed"].includes(t.status)).map((t) => t.d!.slice(0, 10)).sort();
  if (dates[0]) return { date: dates[0], basis: "first booked task" };
  const [j] = await db.select({ s: schema.jobs.scheduledStart }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (j?.s) return { date: new Date(j.s.getTime() + 10 * 3600_000).toISOString().slice(0, 10), basis: "job start" };
  return null;
}

/**
 * A warning only (decision 5): for a shortage still to order or receive.
 * An unsent draft has not started the lead time, so it counts from today.
 * Nothing here moves a date, contacts anyone or sends anything.
 */
export async function leadFlag(p: Pick<Product, "leadTimeDays">, s: Shortage, sentAt: Date | null): Promise<string | null> {
  const need = await neededDate(s.jobId);
  if (p.leadTimeDays == null) return LEAD_UNKNOWN_TEXT;
  if (!need) return null;
  const from = sentAt ? new Date(sentAt.getTime() + 10 * 3600_000).toISOString().slice(0, 10) : brisbaneToday();
  const eta = addBusinessDays(from, p.leadTimeDays);
  return eta > need.date ? `${LEAD_LATE_TEXT} (about ${eta}, needed ${need.date}, ${need.basis}; lead time counts Monday to Friday only; public holidays not excluded).` : null;
}

export const qtyLine = (qty: number, p: Pick<Product, "stockUnitLabel" | "unit">) => `${cm(qty)} ${stockUnitText(p)}`.trim();
