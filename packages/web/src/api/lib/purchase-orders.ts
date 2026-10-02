import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import {
  lmForQty,
  m2ForQty,
  packM2,
  priceProduct,
  resolveSupplierCharges,
  round2,
  todayISO,
  type ResolvedCharge,
  type SpecialRow,
} from "./pricing";
import { rebuildForecast, settleDate, SUPPLIER_TERMS } from "./cashflow";

/* ---------------------------------------------------------------------------
 * Purchase orders: what Terra PAYS a supplier for one job.
 *
 *  - Goods are costed at what Terra pays today. A live special lowers it. The
 *    standard cost is kept on the line so the saving can be seen. The sell
 *    price the customer was quoted never comes into it.
 *  - Supplier charges come off the supplier's fee rules, the same function
 *    the quote screen uses, so the PO and the quote agree.
 *  - Freight rules (Damien's):
 *      warehouse delivery is $0
 *      Hurford's solids to site are $320 flat, solids only
 *      a supplier that does not deliver gets no supplier freight, Terra books
 *      its own carrier and that bill is not on the supplier's PO
 * ------------------------------------------------------------------------- */

export const WAREHOUSE_ADDRESS = "2/22 Lawrence Dr, Nerang QLD 4211";

export type PoLineInput = {
  kind: "goods" | "charge" | "freight";
  jobMaterialId?: number | null;
  productId?: number | null;
  description?: string | null;
  qty: number;
  unit?: string | null;
  /** Typed by the office. Wins over the price book. */
  unitCostExGst?: number | null;
};

export type PoPricingInput = {
  supplierId: number;
  deliverTo: "warehouse" | "site";
  lines: PoLineInput[];
  /** Optional fee rules the office ticked on. */
  feeIds?: number[];
  /** Automatic fee rules the office ticked off for this order. */
  skipFeeIds?: number[];
  boxes?: number | null;
  rolls?: number | null;
  pallets?: number | null;
};

export type PricedLine = {
  kind: "goods" | "charge" | "freight";
  jobMaterialId: number | null;
  productId: number | null;
  description: string;
  qty: number;
  unit: string;
  unitCostExGst: number;
  totalExGst: number;
  standardUnitCostExGst: number | null;
  note: string | null;
};

export type PricedPo = {
  lines: PricedLine[];
  charges: ResolvedCharge[];
  excluded: Array<{ id: number; name: string; reason: string }>;
  goodsExGst: number;
  chargesExGst: number;
  freightExGst: number;
  totalExGst: number;
  /** Saving from live specials, ex GST. Terra's, never the customer's. */
  specialSavingExGst: number;
  measures: { m2: number; lm: number; boxes: number; rolls: number; items: number; pallets: number };
  notes: string[];
  /** Fee ids actually used, so a re-price lands on the same answer. */
  pricingInputs: { feeIds: number[]; skipFeeIds: number[]; boxes: number | null; rolls: number | null; pallets: number | null };
};

const isHurfords = (name: string) => /hurford/i.test(name);
const isSolid = (p: { tier: string; category: string } | undefined) => Boolean(p && p.category === "timber" && /solid/i.test(p.tier));

async function specialsFor(ids: number[]) {
  const map = new Map<number, SpecialRow[]>();
  if (!ids.length) return map;
  const rows = await db.select().from(schema.productSpecials).where(inArray(schema.productSpecials.productId, ids));
  for (const r of rows) map.set(r.productId, [...(map.get(r.productId) ?? []), r]);
  return map;
}

/** Quantity in the unit the product is priced in. Null when it cannot be converted. */
function qtyInProductUnit(qty: number, lineUnit: string, productUnit: string, widthM: number | null) {
  if (lineUnit === productUnit) return qty;
  if (productUnit === "lm" && lineUnit === "m2") return lmForQty(qty, "m2", widthM);
  if (productUnit === "m2" && lineUnit === "lm") return m2ForQty(qty, "lm", widthM);
  return null;
}

export async function pricePo(input: PoPricingInput, today = todayISO()): Promise<PricedPo> {
  const [supplier] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, input.supplierId));
  if (!supplier) throw new Error("Supplier not found");

  const productIds = [...new Set(input.lines.map((l) => l.productId).filter((x): x is number => !!x))];
  const products = productIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, productIds)) : [];
  const byId = new Map(products.map((p) => [p.id, p]));
  const specials = await specialsFor(productIds);

  const notes: string[] = [];
  const lines: PricedLine[] = [];
  let m2 = 0;
  let lm = 0;
  let items = 0;
  let autoBoxes = 0;
  let specialSaving = 0;
  let anySolid = false;

  for (const l of input.lines) {
    const p = l.productId ? byId.get(l.productId) : undefined;
    const lineUnit = l.unit || p?.unit || "m2";
    let qty = l.qty;
    let unit = lineUnit;
    let note: string | null = null;
    let unitCost = l.unitCostExGst ?? null;
    let standard: number | null = null;

    if (l.kind === "goods" && p) {
      if (p.supplierId && p.supplierId !== supplier.id) note = `Price book has this under ${p.supplier || "another supplier"}.`;
      const converted = qtyInProductUnit(l.qty, lineUnit, p.unit, p.widthM);
      if (converted !== null) {
        qty = converted;
        unit = p.unit;
      } else if (unitCost === null) {
        note = `Job has ${l.qty} ${lineUnit}, the price book prices it per ${p.unit}. Type the cost.`;
      }
      const priced = priceProduct(p, specials.get(p.id) ?? [], today);
      if (unitCost === null && converted !== null) unitCost = priced.costExGst;
      if (priced.onSpecial && priced.standardCostExGst !== null) {
        standard = priced.standardCostExGst;
        if (unitCost !== null) specialSaving += (priced.standardCostExGst - unitCost) * qty;
        note = note ?? `On special${priced.special?.label ? ` (${priced.special.label})` : ""}, standard $${priced.standardCostExGst.toFixed(2)}.`;
      }
      if (unitCost === null && converted !== null) note = note ?? "No cost in the price book. Type the cost.";
      if (p.cutCostPrice !== null && p.cutCostPrice !== undefined && l.unitCostExGst == null) {
        note = [note, `Full roll price used. Cut price is $${p.cutCostPrice.toFixed(2)}, type it in if this is a cut.`].filter(Boolean).join(" ");
      }

      const lineM2 = m2ForQty(qty, unit, p.widthM);
      const lineLm = lmForQty(qty, unit, p.widthM);
      if (lineM2 !== null) m2 += lineM2;
      if (lineLm !== null) lm += lineLm;
      if (unit === "each") items += qty;
      const pm2 = packM2(p.unitsPerPack, p.unitM2) ?? p.packM2Printed;
      if (pm2 && lineM2) autoBoxes += Math.ceil(lineM2 / pm2 - 1e-9);
      if (isSolid(p)) anySolid = true;
    } else if (l.kind === "goods") {
      if (unit === "m2") m2 += qty;
      if (unit === "lm") lm += qty;
      if (unit === "each") items += qty;
      if (unitCost === null) note = "Not in the price book. Type the cost.";
    }

    const cost = round2(unitCost ?? 0);
    lines.push({
      kind: l.kind,
      jobMaterialId: l.jobMaterialId ?? null,
      productId: l.productId ?? null,
      description: (l.description || (p ? [p.brand, p.range, p.colour].filter(Boolean).join(" ") : "") || "Item").slice(0, 300),
      qty: round2(qty),
      unit,
      unitCostExGst: cost,
      totalExGst: round2(qty * cost),
      standardUnitCostExGst: standard,
      note,
    });
  }

  const goodsExGst = round2(lines.filter((l) => l.kind === "goods").reduce((a, l) => a + l.totalExGst, 0));
  const manualCharges = round2(lines.filter((l) => l.kind === "charge").reduce((a, l) => a + l.totalExGst, 0));
  const manualFreight = round2(lines.filter((l) => l.kind === "freight").reduce((a, l) => a + l.totalExGst, 0));

  /* ------------------------------ supplier rules ----------------------------- */
  const skip = new Set(input.skipFeeIds ?? []);
  let rules = (
    await db
      .select()
      .from(schema.supplierFeeRules)
      .where(and(eq(schema.supplierFeeRules.supplierId, supplier.id), eq(schema.supplierFeeRules.active, true)))
      .orderBy(asc(schema.supplierFeeRules.sortOrder))
  ).filter((r) => !(r.autoApply && skip.has(r.id)));

  const picked = new Set(input.feeIds ?? []);
  if (input.deliverTo === "warehouse") {
    const dropped = rules.filter((r) => r.kind === "delivery" && (r.autoApply || picked.has(r.id)));
    rules = rules.filter((r) => r.kind !== "delivery");
    if (dropped.length) notes.push("Going to the warehouse, so no delivery charge.");
  } else if (isHurfords(supplier.name)) {
    const crane = rules.find((r) => r.kind === "delivery" && /crane|site/i.test(r.name));
    if (anySolid && crane) {
      picked.add(crane.id);
      notes.push(`Hurford's solids to site: ${crane.name} $${(crane.amount ?? 0).toFixed(2)}.`);
    } else {
      rules = rules.filter((r) => r.kind !== "delivery");
      notes.push("Hurford's only deliver solids to site. Book a carrier for this one, that bill is not on this PO.");
    }
  }
  if (!supplier.deliversDirect) notes.push(`${supplier.name} don't deliver. Terra books the carrier, that bill is not on this PO.`);

  const boxes = input.boxes ?? autoBoxes;
  const measures = { m2: round2(m2), lm: round2(lm), boxes, rolls: input.rolls ?? 0, items: round2(items), pallets: input.pallets ?? 0 };
  const quote = resolveSupplierCharges(
    supplier,
    rules,
    { goodsExGst, ...measures, shipments: 1 },
    { pickedIds: [...picked], today },
  );

  const chargeLines: PricedLine[] = quote.charges.map((c) => ({
    kind: c.kind === "delivery" ? "freight" : "charge",
    jobMaterialId: null,
    productId: null,
    description: c.name,
    qty: c.units,
    unit: c.basis === "percent_of_order" ? "%" : c.basis,
    unitCostExGst: c.basis === "percent_of_order" ? round2(c.percent ?? 0) : round2(c.isCredit ? -(c.rateExGst ?? 0) : (c.rateExGst ?? 0)),
    totalExGst: c.exGst,
    standardUnitCostExGst: null,
    note: c.note,
  }));

  const freightExGst = round2(quote.freightExGst + manualFreight);
  const chargesExGst = round2(quote.chargesExGst - quote.freightExGst + manualCharges);
  return {
    lines: [...lines, ...chargeLines],
    charges: quote.charges,
    excluded: quote.excluded,
    goodsExGst,
    chargesExGst,
    freightExGst,
    totalExGst: round2(goodsExGst + chargesExGst + freightExGst),
    specialSavingExGst: round2(specialSaving),
    measures,
    notes,
    pricingInputs: {
      feeIds: [...picked],
      skipFeeIds: [...skip],
      boxes: input.boxes ?? null,
      rolls: input.rolls ?? null,
      pallets: input.pallets ?? null,
    },
  };
}

/* ------------------------------- numbering -------------------------------- */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Next free letter on the job: 4113-A, then 4113-B. A letter is never reused, a removed draft is kept as cancelled. */
export async function nextPoNumber(jobId: number) {
  const [job] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  if (!job) throw new Error("Job not found");
  const taken = await db.select({ number: schema.purchaseOrders.number }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.jobId, jobId));
  const used = taken.map((t) => LETTERS.indexOf(t.number.split("-").pop() ?? "")).filter((i) => i >= 0);
  const next = used.length ? Math.max(...used) + 1 : 0;
  if (next >= LETTERS.length) throw new Error("This job already has 26 POs.");
  return `${job.number}-${LETTERS[next]}`;
}

/* ----------------------------- write and commit ---------------------------- */

export async function writeLines(poId: number, lines: PricedLine[]) {
  await db.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  if (!lines.length) return;
  await db.insert(schema.purchaseOrderLines).values(
    lines.map((l, i) => ({
      poId,
      jobMaterialId: l.jobMaterialId,
      productId: l.productId,
      kind: l.kind,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitCostExGst: l.unitCostExGst,
      totalExGst: l.totalExGst,
      standardUnitCostExGst: l.standardUnitCostExGst,
      sortOrder: i,
    })),
  );
}

/**
 * A PO has gone to the supplier: it is now money Terra owes. Feeds the forecast
 * as a committed materials cost on the job, and the job's materials move to
 * ordered.
 */
export async function commitPo(poId: number, via: "email" | "other", to: string | null) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po) throw new Error("PO not found");
  const [sup] = await db.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
  const today = todayISO();
  const cost = {
    jobId: po.jobId,
    kind: "materials",
    description: `PO ${po.number} ${sup?.name ?? ""}`.trim(),
    supplierId: po.supplierId,
    amount: po.totalExGst,
    notes: "From the purchase order.",
    updatedAt: new Date(),
  };
  let jobCostId = po.jobCostId;
  if (jobCostId) {
    await db.update(schema.jobCosts).set(cost).where(eq(schema.jobCosts.id, jobCostId));
  } else {
    const [row] = await db
      .insert(schema.jobCosts)
      .values({ ...cost, state: "committed", dueDate: settleDate(today, SUPPLIER_TERMS.days, SUPPLIER_TERMS.eom) })
      .returning();
    jobCostId = row!.id;
  }
  await db
    .update(schema.purchaseOrders)
    .set({ status: po.status === "invoiced" ? "invoiced" : "sent", sentVia: via, sentTo: to, sentAt: new Date(), jobCostId, updatedAt: new Date() })
    .where(eq(schema.purchaseOrders.id, poId));

  const matIds = (await db.select({ id: schema.purchaseOrderLines.jobMaterialId }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId)))
    .map((r) => r.id)
    .filter((x): x is number => !!x);
  if (matIds.length) {
    await db
      .update(schema.jobMaterials)
      .set({ status: "ordered", updatedAt: new Date() })
      .where(and(inArray(schema.jobMaterials.id, matIds), eq(schema.jobMaterials.status, "to_order")));
  }
  await rebuildForecast();
}

/** Cancel a PO nobody has invoiced. Its forecast line goes, its materials go back to "to order". */
export async function cancelPo(poId: number) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po) throw new Error("PO not found");
  const [inv] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.poId, poId)).limit(1);
  if (inv) throw new Error("An invoice is already matched to this PO. Unmatch it first.");

  const matIds = (await db.select({ id: schema.purchaseOrderLines.jobMaterialId }).from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId)))
    .map((r) => r.id)
    .filter((x): x is number => !!x);
  // Only put a material back if no other live PO still has it on order.
  if (matIds.length) {
    const stillOrdered = await db
      .select({ id: schema.purchaseOrderLines.jobMaterialId })
      .from(schema.purchaseOrderLines)
      .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
      .where(and(inArray(schema.purchaseOrderLines.jobMaterialId, matIds), ne(schema.purchaseOrders.id, poId), inArray(schema.purchaseOrders.status, ["sent", "invoiced"])));
    const keep = new Set(stillOrdered.map((r) => r.id));
    const back = matIds.filter((id) => !keep.has(id));
    if (back.length) {
      await db
        .update(schema.jobMaterials)
        .set({ status: "to_order", updatedAt: new Date() })
        .where(and(inArray(schema.jobMaterials.id, back), eq(schema.jobMaterials.status, "ordered")));
    }
  }
  await db.update(schema.purchaseOrders).set({ status: "cancelled", jobCostId: null, updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, poId));
  if (po.jobCostId) {
    await db.delete(schema.jobCosts).where(eq(schema.jobCosts.id, po.jobCostId));
    await rebuildForecast();
  }
}
