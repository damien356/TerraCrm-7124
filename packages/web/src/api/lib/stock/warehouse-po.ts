import { and, asc, eq, inArray, like, ne } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { WAREHOUSE_ADDRESS } from "../purchase-orders";
import { rebuildForecast } from "../cashflow";
import { stockAlert } from "./alerts";
import { bad, cm, forbid, isOn, notFound, type PermActor, r2, r4 } from "./core";
import { afterChange } from "./holds";
import type { Item } from "./items";
import { depositState, orderById } from "./orders";
import { itemFactor, lineUnitOf, modeOf, productName, productNumbers, roundOrder, stockUnitText, supplierOf, supplyState, toStockUnits, type Product } from "./replenish";

/* ---------------------------------------------------------------------------
 * A2: warehouse purchase orders (PO-W0001, PO-W0002 ...).
 *
 *  - Admin only, every action. Nothing here sends: sending and "mark sent"
 *    are the ordinary PO buttons, pressed by a person.
 *  - One draft per supplier. Pressing again updates that draft, never a second.
 *  - A job's shortage can be put on the draft (route B). The job's share is
 *    kept on a link: shown on the PO, not free for other jobs, not physical
 *    until it is received, costed to the job once on receipt (its share only).
 *  - A sent PO is never changed here, except closing a line the supplier will
 *    not deliver (which stops it counting as incoming).
 * ------------------------------------------------------------------------- */

type Actor = PermActor & { profileId: number | null };
type Po = typeof schema.purchaseOrders.$inferSelect;
type Line = typeof schema.purchaseOrderLines.$inferSelect;

const adminOnly = (actor: PermActor) => {
  if (actor.role !== "admin") throw forbid("Warehouse orders are Admin only.");
};
const needS6 = async () => {
  if (!(await isOn("s6"))) throw bad("Warehouse orders are paused or off (S6). Existing orders stay as they are.");
};

/** The next PO-W number. Counts cancelled ones too, so a number is never handed out twice. */
export async function nextWarehouseNumber() {
  const rows = await db.select({ number: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(like(schema.purchaseOrders.number, "PO-W%"));
  const used = rows.map((r) => Number(r.number.slice(4))).filter((n) => Number.isInteger(n) && n > 0);
  return `PO-W${String((used.length ? Math.max(...used) : 0) + 1).padStart(4, "0")}`;
}

export async function warehousePo(id: number) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  if (!po || po.kind !== "warehouse") throw notFound("Warehouse order not found");
  return po;
}

async function draftOf(supplierId: number) {
  const [po] = await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.kind, "warehouse"), eq(schema.purchaseOrders.supplierId, supplierId), eq(schema.purchaseOrders.status, "draft")))
    .orderBy(asc(schema.purchaseOrders.id));
  return po ?? null;
}

/** The supplier's one draft, made if there is none. Two presses at once still end with one. */
async function ensureDraft(supplierId: number, actor: Actor) {
  const seen = await draftOf(supplierId);
  if (seen) return seen;
  const [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, supplierId));
  if (!sup) throw bad("Supplier not found.");
  for (let i = 0; i < 3; i++) {
    const number = await nextWarehouseNumber();
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        number,
        kind: "warehouse",
        jobId: null,
        supplierId,
        status: "draft",
        deliverTo: "warehouse",
        deliveryAddress: WAREHOUSE_ADDRESS,
        notes: "",
        pricingInputs: "{}",
        createdByProfileId: actor.profileId,
      })
      .onConflictDoNothing()
      .returning();
    if (po) {
      // Someone else made one in the same moment: keep the older, mark this one removed (its number stays used).
      const all = await db
        .select()
        .from(schema.purchaseOrders)
        .where(and(eq(schema.purchaseOrders.kind, "warehouse"), eq(schema.purchaseOrders.supplierId, supplierId), eq(schema.purchaseOrders.status, "draft")))
        .orderBy(asc(schema.purchaseOrders.id));
      if (all[0] && all[0].id !== po.id) {
        await db.update(schema.purchaseOrders).set({ status: "cancelled", notes: "Draft removed, never sent (made twice at once).", updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, po.id));
        return all[0];
      }
      return po;
    }
  }
  throw bad("Could not number the warehouse order. Try again.");
}

const lineDescription = (p: Product, stockQty: number) => {
  const per = p.stockPerPurchase && p.stockPerPurchase > 0 ? p.stockPerPurchase : null;
  const packs = per && p.purchaseUnit ? `, ${r4(stockQty / per)} ${p.purchaseUnit} of ${per}` : "";
  return `${productName(p)}${p.size ? ` ${p.size}` : ""} (${r4(stockQty)} ${stockUnitText(p)}${packs})`;
};

async function linksOn(lineId: number) {
  return db.select().from(schema.stockPoLinks).where(and(eq(schema.stockPoLinks.poLineId, lineId), eq(schema.stockPoLinks.status, "open")));
}
const jobShare = async (lineId: number) => r4((await linksOn(lineId)).reduce((s, k) => s + Math.max(0, k.qty - k.receivedQty), 0));

/** Totals follow the lines. Only ever on a draft. */
async function retotal(po: Po) {
  const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id));
  const goods = r2(lines.filter((l) => l.kind === "goods").reduce((s, l) => s + l.totalExGst, 0));
  const charges = r2(lines.filter((l) => l.kind === "charge").reduce((s, l) => s + l.totalExGst, 0));
  const freight = r2(lines.filter((l) => l.kind === "freight").reduce((s, l) => s + l.totalExGst, 0));
  await db
    .update(schema.purchaseOrders)
    .set({ goodsExGst: goods, chargesExGst: charges, freightExGst: freight, totalExGst: r2(goods + charges + freight), updatedAt: new Date() })
    .where(eq(schema.purchaseOrders.id, po.id));
}

/**
 * Set a product's line on the supplier's draft: general stock plus whatever
 * job shares are linked to it. The line is changed in place, so links keep
 * pointing at it. A line with nothing left is removed.
 */
async function setLine(po: Po, p: Product, generalQty: number, unitCost?: number | null) {
  if (po.status !== "draft") throw bad(`${po.number} has gone to the supplier. It is not changed here.`);
  const [line] = await db
    .select()
    .from(schema.purchaseOrderLines)
    .where(and(eq(schema.purchaseOrderLines.poId, po.id), eq(schema.purchaseOrderLines.productId, p.id), eq(schema.purchaseOrderLines.kind, "goods")));
  const jobs = line ? await jobShare(line.id) : 0;
  const qty = r4(Math.max(0, generalQty) + jobs);
  const cost = unitCost ?? line?.unitCostExGst ?? p.costPrice ?? 0;
  if (line) {
    if (qty <= 0.0001) await db.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, line.id));
    else
      await db
        .update(schema.purchaseOrderLines)
        .set({ qty, unitCostExGst: cost, totalExGst: r2(qty * cost), description: lineDescription(p, qty), updatedAt: new Date() })
        .where(eq(schema.purchaseOrderLines.id, line.id));
  } else if (qty > 0.0001) await insertGoodsLine(po, p, qty, cost);
  await retotal(po);
  const [after] = await db
    .select()
    .from(schema.purchaseOrderLines)
    .where(and(eq(schema.purchaseOrderLines.poId, po.id), eq(schema.purchaseOrderLines.productId, p.id), eq(schema.purchaseOrderLines.kind, "goods")));
  return after ?? null;
}

/** A new goods line on a draft, at the exact quantity. */
async function insertGoodsLine(po: Po, p: Product, qty: number, unitCost?: number | null) {
  const cost = unitCost ?? p.costPrice ?? 0;
  const n = (await db.select({ id: schema.purchaseOrderLines.id }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id))).length;
  const [line] = await db
    .insert(schema.purchaseOrderLines)
    .values({
      poId: po.id,
      productId: p.id,
      kind: "goods",
      description: lineDescription(p, qty),
      qty,
      unit: lineUnitOf(p),
      unitCostExGst: cost,
      totalExGst: r2(qty * cost),
      standardUnitCostExGst: p.costPrice ?? cost,
      sortOrder: n,
    })
    .returning();
  return line!;
}

async function product(id: number) {
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, id));
  if (!p) throw notFound("Product not found");
  return p;
}

/**
 * "Add to draft" on the Reorder list: put the suggested general-stock
 * quantity for each product on its supplier's draft. Pressing it again
 * gives the same draft. A product already covered by its draft is left alone.
 */
export async function draftSuggestions(supplierId: number, productIds: number[] | null, actor: Actor) {
  adminOnly(actor);
  await needS6();
  const rows = (await db.select().from(schema.products).where(eq(schema.products.supplyMode, "reorder"))).filter(
    (p) => supplierOf(p) === supplierId && (!productIds || productIds.includes(p.id)),
  );
  const nums = await productNumbers(rows);
  const changed: string[] = [];
  let po: Po | null = await draftOf(supplierId);
  for (const p of rows) {
    const st = supplyState(p, nums.get(p.id)!);
    if (st.suggestStock <= 0) continue;
    const n = nums.get(p.id)!;
    if (n.draftFree >= st.suggestStock - 0.0001) continue;
    po = po ?? (await ensureDraft(supplierId, actor));
    await setLine(po, p, st.suggestStock);
    changed.push(`${productName(p)}: ${r4(st.suggestStock)} ${stockUnitText(p)}`);
  }
  return { po: po ? await warehousePo(po.id) : null, changed };
}

/** Admin edits a draft line: general quantity (job shares stay) and unit cost ex GST. */
export async function editDraftLine(input: { poId: number; productId: number; generalQty: number; unitCostExGst?: number | null }, actor: Actor) {
  adminOnly(actor);
  const po = await warehousePo(input.poId);
  const p = await product(input.productId);
  if (input.generalQty < 0) throw bad("Quantity cannot be below 0.");
  const general = input.generalQty > 0 ? roundOrder(input.generalQty, p).stockQty : 0;
  const line = await setLine(po, p, general, input.unitCostExGst ?? null);
  return { line, rounded: general !== input.generalQty ? general : null };
}

/** Freight, payment date and supplier deposit on a warehouse order. Dates are typed, never guessed. */
export async function editWarehouseTerms(
  input: { poId: number; freightExGst?: number | null; expectedPayDate?: string | null; supplierDepositExGst?: number | null; supplierDepositDue?: string | null; notes?: string },
  actor: Actor,
) {
  adminOnly(actor);
  const po = await warehousePo(input.poId);
  if (po.status === "cancelled") throw bad(`${po.number} is cancelled.`);
  const day = (s: string | null | undefined) => {
    if (s == null || s === "") return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad("Dates are YYYY-MM-DD.");
    return s;
  };
  const dep = input.supplierDepositExGst != null && input.supplierDepositExGst > 0 ? r2(input.supplierDepositExGst) : null;
  if (dep != null && dep > po.totalExGst + 0.005 && po.totalExGst > 0) throw bad("The deposit is more than the order.");
  await db
    .update(schema.purchaseOrders)
    .set({
      ...(input.expectedPayDate !== undefined ? { expectedPayDate: day(input.expectedPayDate) } : {}),
      ...(input.supplierDepositExGst !== undefined ? { supplierDepositExGst: dep } : {}),
      ...(input.supplierDepositDue !== undefined ? { supplierDepositDue: day(input.supplierDepositDue) } : {}),
      ...(input.notes !== undefined && po.status === "draft" ? { notes: input.notes.slice(0, 2000) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.purchaseOrders.id, po.id));
  if (input.freightExGst !== undefined && input.freightExGst !== null) {
    if (po.status !== "draft") throw bad(`${po.number} has gone to the supplier. Freight is not changed here.`);
    const f = r2(Math.max(0, input.freightExGst));
    await db.delete(schema.purchaseOrderLines).where(and(eq(schema.purchaseOrderLines.poId, po.id), eq(schema.purchaseOrderLines.kind, "freight")));
    if (f > 0) await db.insert(schema.purchaseOrderLines).values({ poId: po.id, kind: "freight", description: "Freight", qty: 1, unit: "each", unitCostExGst: f, totalExGst: f, sortOrder: 99 });
    await retotal(po);
  }
  await rebuildForecast();
  return warehousePo(po.id);
}

/* ------------------------------ route choice ------------------------------ */

async function shortRow(holdId: number) {
  const [h] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.id, holdId));
  if (!h || h.status !== "short") throw bad("That shortage is no longer open. Refresh.");
  return h;
}

/** Is this job's material already on the job's own PO? Draft or sent, it must not go on a warehouse order too. */
async function jobPoFor(jobMaterialId: number | null) {
  if (jobMaterialId == null) return null;
  const [row] = await db
    .select({ id: schema.purchaseOrders.id, number: schema.purchaseOrders.number, status: schema.purchaseOrders.status, jobId: schema.purchaseOrders.jobId })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .where(and(eq(schema.purchaseOrderLines.jobMaterialId, jobMaterialId), ne(schema.purchaseOrders.status, "cancelled"), ne(schema.purchaseOrders.kind, "warehouse")));
  return row ?? null;
}

/**
 * Route B: put one job shortage on the supplier's warehouse draft. Refused
 * when it is already on a job PO (a sent one is flagged for the owner and
 * left exactly as it is), already on a warehouse order, or the product is
 * container or stock only.
 */
export async function addShortageToWarehouse(holdId: number, actor: Actor) {
  adminOnly(actor);
  await needS6();
  const h = await shortRow(holdId);
  const p = await product(h.productId);
  const mode = modeOf(p);
  if (mode !== "reorder") throw bad(mode === "container" || mode === "stock_only" ? "Container and stock-only products are not reordered here. Owner review." : "This product is ordered for each job. Use the job's PO.");
  const supplierId = supplierOf(p);
  if (!supplierId) throw bad("Pick the product's supplier first.");
  const [seen] = await db
    .select()
    .from(schema.stockPoLinks)
    .where(and(eq(schema.stockPoLinks.reservationId, h.id), inArray(schema.stockPoLinks.status, ["open", "received"])));
  if (seen) {
    const po = await warehousePo(seen.poId);
    return { link: seen, po, reused: true };
  }
  const onJobPo = await jobPoFor(h.jobMaterialId);
  if (onJobPo) {
    if (onJobPo.status !== "draft") {
      await stockAlert(`on-sent-po:${h.id}:${onJobPo.id}`, "stock_on_sent_po", {
        jobId: h.jobId,
        title: `Shortage already on ${onJobPo.number}`,
        body: `${productName(p)} for this job is already on ${onJobPo.number}, which has gone to the supplier. It was not put on a warehouse order and ${onJobPo.number} was not changed. Check with the supplier if anything needs to change.`,
        path: `/jobs/${h.jobId}`,
      });
      throw bad(`Already on ${onJobPo.number}, which has been sent. Nothing changed. You have been sent a note to check it.`);
    }
    throw bad(`Already on draft ${onJobPo.number} for this job. Take it off that draft first, or keep it there.`);
  }
  const qty = toStockUnits(h.orderedQty ?? h.qty, h.lineUnit, p);
  if (qty == null || qty <= 0) throw bad("This shortage is in a unit the warehouse order cannot count. Use the job's PO.");

  const po = await ensureDraft(supplierId, actor);
  const [line0] = await db
    .select()
    .from(schema.purchaseOrderLines)
    .where(and(eq(schema.purchaseOrderLines.poId, po.id), eq(schema.purchaseOrderLines.productId, p.id), eq(schema.purchaseOrderLines.kind, "goods")));
  const general = line0 ? r4(Math.max(0, line0.qty - (await jobShare(line0.id)))) : 0;
  // A line has to exist for the link to point at. A new one starts at exactly the job's share.
  const line = line0 ?? (await insertGoodsLine(po, p, qty));
  // Whatever happens next, the line ends as general stock plus the open job shares, nothing more.
  const settle = () => setLine(po, p, general);
  try {
    return await linkShortage(po, line, p, h, qty, actor, settle);
  } catch (e) {
    await settle().catch(() => undefined);
    throw e;
  }
}

async function linkShortage(
  po: Po,
  line: Line,
  p: Product,
  h: typeof schema.stockReservations.$inferSelect,
  qty: number,
  actor: Actor,
  settle: () => Promise<unknown>,
) {
  const [link] = await db
    .insert(schema.stockPoLinks)
    .values({
      poId: po.id,
      poLineId: line.id,
      productId: p.id,
      jobId: h.jobId,
      orderId: h.orderId,
      reservationId: h.id,
      jobMaterialId: h.jobMaterialId,
      quoteItemId: h.quoteItemId,
      saleLineId: h.saleLineId,
      qty,
      createdByName: actor.name,
      requestKey: `short:${h.id}`,
    })
    .onConflictDoNothing()
    .returning();
  if (!link) {
    const [again] = await db.select().from(schema.stockPoLinks).where(eq(schema.stockPoLinks.requestKey, `short:${h.id}`));
    if (again && again.status !== "cancelled") {
      await settle();
      return { link: again, po: await warehousePo(po.id), reused: true };
    }
    // An older link was cancelled with its PO: a new key for the new one.
    const [fresh] = await db
      .insert(schema.stockPoLinks)
      .values({ poId: po.id, poLineId: line.id, productId: p.id, jobId: h.jobId, orderId: h.orderId, reservationId: h.id, jobMaterialId: h.jobMaterialId, quoteItemId: h.quoteItemId, saleLineId: h.saleLineId, qty, createdByName: actor.name, requestKey: `short:${h.id}:${Date.now()}` })
      .returning();
    await settle();
    return { link: fresh!, po: await warehousePo(po.id), reused: false };
  }
  await settle();
  return { link, po: await warehousePo(po.id), reused: false };
}

/** Take a job share off a warehouse draft. The shortage shows as open again. */
export async function removeShortageLink(linkId: number, actor: Actor) {
  adminOnly(actor);
  const [k] = await db.select().from(schema.stockPoLinks).where(eq(schema.stockPoLinks.id, linkId));
  if (!k || k.status !== "open") throw bad("That link is not open.");
  const po = await warehousePo(k.poId);
  if (po.status !== "draft") throw bad(`${po.number} has gone to the supplier. It is not changed here.`);
  const p = await product(k.productId);
  const [line] = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, k.poLineId));
  const general = line ? r4(Math.max(0, line.qty - (await jobShare(line.id)))) : 0;
  await db.update(schema.stockPoLinks).set({ status: "cancelled", updatedAt: new Date() }).where(eq(schema.stockPoLinks.id, k.id));
  await setLine(po, p, general);
  return { ok: true };
}

/**
 * Route A from the Reorder list: the job's own PO. Uses the ordinary PO
 * helper, which only drafts and skips anything already on a PO or a
 * warehouse order.
 */
export async function shortageToJobPo(holdId: number, actor: Actor) {
  adminOnly(actor);
  const h = await shortRow(holdId);
  const [k] = await db.select().from(schema.stockPoLinks).where(and(eq(schema.stockPoLinks.reservationId, h.id), eq(schema.stockPoLinks.status, "open")));
  if (k) throw bad("This shortage is on a warehouse order. Take it off there first.");
  const p = await product(h.productId);
  const mode = modeOf(p);
  if (mode === "container" || mode === "stock_only") throw bad("Container and stock-only products are not ordered for one job. Owner review.");
  const on = await jobPoFor(h.jobMaterialId);
  if (on) return { already: on.number, drafted: [] as string[] };
  if (h.jobMaterialId == null) throw bad("This line has no job material. Raise the PO on the job's Purchase orders card.");
  const { draftPosForJob } = await import("../po-helper");
  const r = await draftPosForJob({ jobId: h.jobId, quoteRef: "stock shortage" });
  return { already: null, drafted: r.drafted.map((d) => d.number) };
}

/* -------------------------------- sent POs -------------------------------- */

/** The supplier will not send the rest of a line. It stops counting as incoming; job shares go back to short. */
export async function closeLine(lineId: number, note: string, actor: Actor) {
  adminOnly(actor);
  const [line] = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, lineId));
  if (!line) throw notFound("Line not found");
  const po = await warehousePo(line.poId);
  if (po.status === "draft") throw bad("On a draft, change the quantity instead.");
  if (line.closedAt) return { ok: true, already: true };
  if (note.trim().length < 3) throw bad("Say why the rest is not coming.");
  await db.update(schema.purchaseOrderLines).set({ closedAt: new Date(), closedNote: note.trim().slice(0, 300), updatedAt: new Date() }).where(eq(schema.purchaseOrderLines.id, line.id));
  await db.update(schema.stockPoLinks).set({ status: "closed", note: note.trim().slice(0, 300), updatedAt: new Date() }).where(and(eq(schema.stockPoLinks.poLineId, line.id), eq(schema.stockPoLinks.status, "open")));
  await rebuildForecast();
  return { ok: true, already: false };
}

/* -------------------------------- receiving ------------------------------- */

/**
 * Goods arrived on a warehouse line (called from receiveLine). Each open job
 * share, oldest first, becomes that job's hold on the new stock. Firm only if
 * the deposit rules say so; otherwise it waits like any other unpaid hold.
 * These are normal stock holds, so the job is costed for its share at the
 * stock cost, once, and never again on issue. The rest is general stock.
 */
export async function fillLinksFromReceipt(po: Po, line: Line, items: Item[], key: string, actor: Actor) {
  const links = (await linksOn(line.id)).sort((a, b) => a.id - b.id);
  if (!links.length || !items.length) return;
  const prod = await product(line.productId!);
  // Links count in the stock unit; a hold counts in the item's own unit (metres of roll, boxes).
  const factor = new Map(items.map((i) => [i.id, itemFactor(i, prod)]));
  const left = new Map(items.map((i) => [i.id, r4(i.qty * factor.get(i.id)!)]));
  const jobs = new Set<number>();
  for (const k of links) {
    let want = r4(k.qty - k.receivedQty);
    let took = 0;
    const order = k.orderId ? await orderById(k.orderId).catch(() => null) : null;
    const firm = order ? order.status === "active" && (await depositState(order)).code === "confirmed" : false;
    const stage = firm ? "reserved" : order?.status === "planned" ? "planned" : "awaiting";
    for (const it of items) {
      if (want <= 0.0001) break;
      const free = left.get(it.id) ?? 0;
      if (free <= 0.0001) continue;
      const part = r4(Math.min(free, want));
      await db
        .insert(schema.stockReservations)
        .values({
          productId: k.productId,
          jobId: k.jobId,
          orderId: k.orderId,
          jobMaterialId: k.jobMaterialId,
          quoteItemId: k.quoteItemId,
          saleLineId: k.saleLineId,
          stockItemId: it.id,
          qty: r4(part / factor.get(it.id)!),
          lineUnit: line.unit,
          orderedQty: part,
          billedQty: part,
          status: stage,
          costOnPo: false,
          confirmedAt: firm ? new Date() : null,
          confirmedByName: firm ? `Job share received on ${po.number}` : null,
          confirmNote: `Job share on ${po.number}.`,
          appliedByProfileId: actor.profileId,
          appliedByName: actor.name,
          requestKey: `${key}:link:${k.id}:${it.id}`,
        })
        .onConflictDoNothing();
      left.set(it.id, r4(free - part));
      want = r4(want - part);
      took = r4(took + part);
    }
    if (took <= 0) continue;
    const got = r4(k.receivedQty + took);
    await db
      .update(schema.stockPoLinks)
      .set({ receivedQty: got, status: got >= k.qty - 0.0001 ? "received" : "open", updatedAt: new Date() })
      .where(eq(schema.stockPoLinks.id, k.id));
    // The shortage it covered comes down by what arrived; gone once all of it is here.
    if (k.reservationId) {
      const [s] = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.id, k.reservationId));
      if (s && s.status === "short") {
        // The short row is in the job line's unit; what arrived is in the stock unit. Take off the same share.
        const lineQty = s.orderedQty ?? s.qty;
        const asStock = toStockUnits(lineQty, s.lineUnit, prod);
        const rest = asStock && asStock > 0 ? r4(lineQty * Math.max(0, asStock - took) / asStock) : r4(lineQty - took);
        if (rest <= 0.0001)
          await db
            .update(schema.stockReservations)
            .set({ status: "released", releasedAt: new Date(), releaseReason: `Received on ${po.number}.`, updatedAt: new Date() })
            .where(eq(schema.stockReservations.id, s.id));
        else await db.update(schema.stockReservations).set({ qty: rest, orderedQty: rest, billedQty: rest, updatedAt: new Date() }).where(eq(schema.stockReservations.id, s.id));
      }
    }
    jobs.add(k.jobId);
  }
  for (const j of jobs) await afterChange(j);
  if (jobs.size) {
    const { recheckOrder } = await import("./recheck");
    for (const k of links) if (k.orderId) await recheckOrder(k.orderId).catch(() => null);
  }
}

/* --------------------------------- views ---------------------------------- */

export async function warehouseOrders(includeCancelled = false) {
  const pos = (await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.kind, "warehouse")).orderBy(asc(schema.purchaseOrders.number))).filter(
    (p) => includeCancelled || p.status !== "cancelled",
  );
  const ids = pos.map((p) => p.id);
  const lines = ids.length ? await db.select().from(schema.purchaseOrderLines).where(inArray(schema.purchaseOrderLines.poId, ids)).orderBy(asc(schema.purchaseOrderLines.sortOrder)) : [];
  const links = ids.length ? await db.select().from(schema.stockPoLinks).where(inArray(schema.stockPoLinks.poId, ids)) : [];
  const bills = ids.length ? await db.select().from(schema.supplierInvoices).where(inArray(schema.supplierInvoices.poId, ids)) : [];
  const jobIds = [...new Set(links.map((k) => k.jobId))];
  const jobs = jobIds.length ? await db.select({ id: schema.jobs.id, number: schema.jobs.number, title: schema.jobs.title }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds)) : [];
  const sups = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name, email: schema.suppliers.email }).from(schema.suppliers);
  const prodIds = [...new Set(lines.map((l) => l.productId).filter((x): x is number => x != null))];
  const prods = prodIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, prodIds)) : [];
  return pos.map((po) => ({
    ...po,
    supplierName: sups.find((s) => s.id === po.supplierId)?.name ?? "Supplier",
    supplierHasEmail: !!sups.find((s) => s.id === po.supplierId)?.email,
    lines: lines
      .filter((l) => l.poId === po.id)
      .map((l) => {
        const p = prods.find((x) => x.id === l.productId) ?? null;
        const mine = links.filter((k) => k.poLineId === l.id && k.status !== "cancelled");
        const jobQty = r4(mine.filter((k) => k.status === "open" || k.status === "received").reduce((s, k) => s + k.qty, 0));
        const unit = p ? stockUnitText(p) : l.unit;
        const general = r4(Math.max(0, l.qty - jobQty));
        return {
          ...l,
          unitText: unit,
          generalQty: general,
          jobQty,
          split: mine.length
            ? [...mine.map((k) => `${cm(k.qty)} ${unit} expected for Job ${jobs.find((j) => j.id === k.jobId)?.number ?? k.jobId}`), `${cm(general)} ${unit} for general warehouse stock`].join(" + ")
            : null,
          links: mine.map((k) => ({ ...k, jobNumber: jobs.find((j) => j.id === k.jobId)?.number ?? null, jobTitle: jobs.find((j) => j.id === k.jobId)?.title ?? "" })),
        };
      }),
    bills: bills
      .filter((b) => b.poId === po.id)
      .map((b) => ({ id: b.id, invoiceNumber: b.invoiceNumber, docType: b.docType, totalIncGst: b.totalIncGst, totalExGst: b.totalExGst, payState: b.payState, dueDate: b.dueDate })),
  }));
}
