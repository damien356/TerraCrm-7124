import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { cancelPo, commitPo, nextPoNumber, pricePo, siteAddressFor, supplierDeliversTo, WAREHOUSE_ADDRESS, writeLines, type PoLineInput, type PoPricingInput } from "../lib/purchase-orders";
import { resolveAiActionsForPo } from "../lib/ai-actions";
import { renderPoPdf } from "../lib/poPdf";
import { sendAsTeam } from "../lib/agent-mail";
import { INVOICES_TO } from "../lib/gmail";
import { putObject, signGet } from "../lib/s3";
import { auDate, safeJson } from "../lib/invoice-match";
import { todayISO } from "../lib/pricing";
import { depotsFor, matchingDepot, pickupLines, PickupError, resolvePickup } from "../lib/pickup";

/**
 * PURCHASE ORDERS, raised from a job.
 *
 * 4113-A, 4113-B: the job number plus a letter. Sent to the supplier from
 * team@ with the PO as a PDF, asking them to quote the number and send the
 * invoice to billing@. That is what lets the email agent match the invoice
 * back to the job without a person.
 */

const lineInput = z.object({
  kind: z.enum(["goods", "charge", "freight"]).default("goods"),
  jobMaterialId: z.number().nullable().optional(),
  productId: z.number().nullable().optional(),
  description: z.string().max(300).nullable().optional(),
  qty: z.number().min(0),
  unit: z.string().max(20).nullable().optional(),
  unitCostExGst: z.number().nullable().optional(),
});

const pickupInput = z
  .object({
    mode: z.enum(["depot", "new", "tbc"]),
    depotId: z.number().nullable().optional(),
    name: z.string().max(120).optional(),
    address: z.string().max(300).optional(),
    save: z.boolean().optional(),
    updateSaved: z.boolean().optional(),
  })
  .nullable()
  .default(null);

const poInput = z.object({
  supplierId: z.number(),
  /** pickup: collected from the supplier (9 Nov 2026). */
  deliverTo: z.enum(["warehouse", "site", "pickup"]).default("warehouse"),
  deliveryAddress: z.string().max(300).default(""),
  /** Pickup only: a saved depot, a place typed now, or to be confirmed. */
  pickup: pickupInput,
  /** Editing a draft: the office has seen how the charges change with the new delivery or collection choice. */
  chargesConfirmed: z.boolean().default(false),
  notes: z.string().max(2000).default(""),
  lines: z.array(lineInput).min(1).max(80),
  feeIds: z.array(z.number()).default([]),
  skipFeeIds: z.array(z.number()).default([]),
  boxes: z.number().min(0).nullable().default(null),
  rolls: z.number().min(0).nullable().default(null),
  pallets: z.number().min(0).nullable().default(null),
});
type PoInput = z.infer<typeof poInput>;

/** What a draft was priced off, kept so it reopens as written. Older rows may lack `lines`. */
type SavedInputs = {
  feeIds?: number[];
  skipFeeIds?: number[];
  boxes?: number | null;
  rolls?: number | null;
  pallets?: number | null;
  lines?: PoLineInput[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function profileIdFor(userId: string) {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, userId));
  return p?.id ?? null;
}

function pricingOf(input: Pick<PoInput, "supplierId" | "deliverTo" | "lines" | "feeIds" | "skipFeeIds" | "boxes" | "rolls" | "pallets">): PoPricingInput {
  return {
    supplierId: input.supplierId,
    deliverTo: input.deliverTo,
    lines: input.lines,
    feeIds: input.feeIds,
    skipFeeIds: input.skipFeeIds,
    boxes: input.boxes,
    rolls: input.rolls,
    pallets: input.pallets,
  };
}

/** Fix list 11 Oct, item 14: a supplier that only delivers to one place can't be sent the other way. */
async function assertDeliverable(input: PoInput) {
  // Collected from the supplier: where they deliver does not matter.
  if (input.deliverTo === "pickup") return;
  const [sup] = await db
    .select({ name: schema.suppliers.name, deliversTo: schema.suppliers.deliversTo })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, input.supplierId));
  if (sup && !supplierDeliversTo(sup.deliversTo, input.deliverTo)) {
    const only = sup.deliversTo === "site" ? "site" : "the warehouse";
    throw new ORPCError("BAD_REQUEST", { message: `${sup.name} only deliver to ${only}. Change where it's going.` });
  }
}

async function deliveryFor(jobId: number, input: PoInput) {
  // A pickup has no delivery address. Its pickup place is kept apart, never the site or the warehouse.
  if (input.deliverTo === "pickup") return "";
  if (input.deliverTo === "warehouse") return WAREHOUSE_ADDRESS;
  return input.deliveryAddress.trim() || (await siteAddressFor(jobId));
}

/** Pickup place for the PO. Saves or updates a depot only when the office asked to. */
async function pickupFor(input: PoInput, byName: string) {
  try {
    return await resolvePickup(input.supplierId, input.deliverTo, input.pickup, byName);
  } catch (e) {
    if (e instanceof PickupError) throw new ORPCError("BAD_REQUEST", { message: e.message });
    throw e;
  }
}

/** A2: a warehouse draft only goes out while S6 is on. One already sent stays as it is. */
async function warehouseSendCheck(status: string) {
  if (status !== "draft") return;
  const { isOn } = await import("../lib/stock/core");
  if (!(await isOn("s6"))) throw new ORPCError("BAD_REQUEST", { message: "Warehouse orders are paused (S6 is off). Turn S6 back on to send this draft." });
}

/** Send and Mark sent: the stock overlap check (A2 follow-up). Main admin may go past it with a reason. */
const overrideInput = z.object({ reason: z.string().max(500) }).nullable().optional();
async function overlapCheck(poId: number, how: "send" | "mark_sent", override: { reason: string } | null | undefined, actor: Parameters<typeof import("../lib/stock/po-send-gate").assertPoSendable>[3]) {
  const { assertPoSendable } = await import("../lib/stock/po-send-gate");
  return assertPoSendable(poId, how, override, actor);
}

async function logOverride(...a: Parameters<typeof import("../lib/stock/po-send-gate").logPoOverride>) {
  const { logPoOverride } = await import("../lib/stock/po-send-gate");
  return logPoOverride(...a);
}

/** One send per PO at a time, so a double press or a retry while the first is still going cannot email twice. */
const sending = new Set<number>();

/** The Send button. The email goes first; the PO only counts as sent once the email is accepted. */
async function sendOne(input: { id: number; to?: string; saveEmail: boolean; overlapOverride?: { reason: string } | null }, actor: Parameters<typeof overlapCheck>[3]) {
  const po = await loadPo(input.id);
  if (po.status === "cancelled") throw new ORPCError("BAD_REQUEST", { message: "This PO is cancelled." });
  if (po.totalExGst <= 0) throw new ORPCError("BAD_REQUEST", { message: "This PO is $0. Put the costs in first." });
  const [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
  const to = (input.to?.trim() || sup?.email || "").trim();
  if (!to) throw new ORPCError("BAD_REQUEST", { message: `No email on file for ${sup?.name ?? "this supplier"}. Type one in, or add it on the Suppliers page.` });
  if (!EMAIL.test(to)) throw new ORPCError("BAD_REQUEST", { message: `"${to}" is not an email address.` });
  if (po.jobId == null) await warehouseSendCheck(po.status);
  const overridden = await overlapCheck(po.id, "send", input.overlapOverride, actor);
  // Saved only once the checks pass, so a refused send changes nothing.
  if (input.saveEmail && sup && to !== sup.email) {
    await db.update(schema.suppliers).set({ email: to, updatedAt: new Date() }).where(eq(schema.suppliers.id, sup.id));
  }
  const [job] = po.jobId != null ? await db.select({ number: jobNumberSql }).from(schema.jobs).where(eq(schema.jobs.id, po.jobId)) : [];
  const { pdf, filename } = await pdfFor(po.id);
  const mail = poEmailText(sup?.name ?? "there", po.number, po.jobId == null ? null : (job?.number ?? 0), po.deliverTo, po.deliverTo === "pickup" ? pickupLines(po).join("\n") : po.deliveryAddress);
  try {
    await sendAsTeam({ to, subject: mail.subject, text: mail.text, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
  } catch (e) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `Email did not go: ${(e as Error).message}. ${po.status === "draft" ? `${po.number} is still a draft, not sent, and nothing was ordered.` : `${po.number} was not emailed again.`} Press Send again once it is fixed.`,
    });
  }
  await putObject(`purchase-orders/${po.number}.pdf`, pdf, "application/pdf", filename).catch(() => {});
  try {
    await commitPo(po.id, "email", to);
    await logOverride(po.id, "send", input.overlapOverride, overridden, actor);
  } catch (e) {
    // The supplier has it. Do not invite a second email of the same order.
    console.error("[po] sent but not saved as sent", po.number, (e as Error).message);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `The email to ${to} went, but ${po.number} could not be saved as sent. Do not press Send again. Use Mark sent (emailed from another inbox) instead.`,
    });
  }
  await resolveAiActionsForPo(po.id, actor.name);
  return { ok: true, to, overridden };
}

/** Send, one at a time per PO. Exported for the stock tests (scripts/stock). */
export async function sendPoNow(input: Parameters<typeof sendOne>[0], actor: Parameters<typeof sendOne>[1]) {
  if (sending.has(input.id)) throw new ORPCError("CONFLICT", { message: "This PO is already being sent. Wait a moment, then refresh." });
  sending.add(input.id);
  try {
    return await sendOne(input, actor);
  } finally {
    sending.delete(input.id);
  }
}

/** Mark sent: phoned through or put in on the supplier's portal. No email. Exported for the stock tests. */
export async function markPoSentNow(input: { id: number; how: string; overlapOverride?: { reason: string } | null }, actor: Parameters<typeof sendOne>[1]) {
  const po = await loadPo(input.id);
  if (po.status === "cancelled") throw new ORPCError("BAD_REQUEST", { message: "This PO is cancelled." });
  if (po.jobId == null) await warehouseSendCheck(po.status);
  const overridden = await overlapCheck(po.id, "mark_sent", input.overlapOverride, actor);
  await commitPo(po.id, "other", input.how);
  await logOverride(po.id, "mark_sent", input.overlapOverride, overridden, actor);
  await resolveAiActionsForPo(po.id, actor.name);
  return { ok: true, overridden };
}

async function loadPo(id: number) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  if (!po) throw new ORPCError("NOT_FOUND", { message: "PO not found" });
  return po;
}

const EACH_UNITS = new Set(["unit", "each", "ea", "item"]);
/**
 * A2 follow-up and A2c: a line counted in "unit" inside Ops prints the
 * product's own stock unit (for example "pails"), on warehouse and job POs
 * alike, the same word as the stock list, receiving and the crew. m², m and
 * boxes print as they always have.
 */
async function warehouseUnits(_jobId: number | null, lines: { productId: number | null; unit: string }[]) {
  const ids = [...new Set(lines.filter((l) => EACH_UNITS.has(l.unit) && l.productId != null).map((l) => l.productId!))];
  if (!ids.length) return (l: { unit: string }) => l.unit;
  const { unitWord } = await import("../lib/stock/replenish");
  const prods = await db.select().from(schema.products).where(inArray(schema.products.id, ids));
  return (l: { productId: number | null; unit: string }) => {
    const p = EACH_UNITS.has(l.unit) ? prods.find((x) => x.id === l.productId) : undefined;
    return p && p.stockUnitLabel ? unitWord(p, l.unit) : l.unit;
  };
}

async function pdfFor(poId: number) {
  const po = await loadPo(poId);
  const [job] = po.jobId != null ? await db.select({ number: jobNumberSql }).from(schema.jobs).where(eq(schema.jobs.id, po.jobId)) : [];
  const [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
  const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId)).orderBy(asc(schema.purchaseOrderLines.sortOrder));
  const date = po.sentAt ? po.sentAt.toISOString().slice(0, 10) : todayISO();
  // A2 follow-up: a warehouse line is counted in "unit" inside Ops. The supplier sees the product's own stock unit (for example "pails"), never "unit".
  const unitOf = await warehouseUnits(po.jobId, lines);
  const pdf = await renderPoPdf({
    number: po.number,
    date: auDate(date),
    supplierName: sup?.name ?? "Supplier",
    supplierAccount: sup?.accountNumber ?? null,
    jobNumber: po.jobId == null ? null : (job?.number ?? 0),
    deliverTo: po.deliverTo === "site" ? "site" : po.deliverTo === "pickup" ? "pickup" : "warehouse",
    deliveryAddress: po.deliveryAddress,
    pickup: po.deliverTo === "pickup" ? pickupLines(po) : null,
    notes: po.notes,
    lines: lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unit: unitOf(l),
      unitCostExGst: l.unitCostExGst,
      totalExGst: l.totalExGst,
    })),
    goodsExGst: po.goodsExGst,
    chargesExGst: po.chargesExGst,
    freightExGst: po.freightExGst,
    totalExGst: po.totalExGst,
  });
  return { po, sup, pdf, filename: `Terra PO ${po.number}.pdf` };
}

/** jobNumber null: a warehouse stock order (A2). Same PO number on the email, PDF and invoice. */
export function poEmailText(supplierName: string, number: string, jobNumber: number | string | null, deliverTo: string, address: string) {
  return {
    subject: `Purchase order ${number}, Terra Flooring`,
    text: [
      `Hi ${supplierName},`,
      "",
      jobNumber == null ? `Please find attached purchase order ${number} for warehouse stock.` : `Please find attached purchase order ${number} for job ${jobNumber}.`,
      "",
      // Pickup (9 Nov 2026): collected from the supplier. No delivery wording at all.
      deliverTo === "pickup" ? address : `Deliver to: ${deliverTo === "site" ? `site, ${address}` : `our warehouse, ${address}`}`,
      "",
      `Please quote ${number} on your invoice and send the invoice to ${INVOICES_TO}.`,
      "",
      "Reply to this email with any questions about the order.",
      "",
      "Thanks,",
      "Terra Flooring",
      "1300 183 772",
    ].join("\n"),
  };
}

/** How the supplier charges and freight on a draft change, as "Removed X $10.00", "Added Y $5.00". Goods are not compared. */
async function chargeChanges(poId: number, next: { kind: string; description: string; totalExGst: number }[]) {
  const before = (await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId))).filter((l) => l.kind !== "goods");
  const after = next.filter((l) => l.kind !== "goods");
  const key = (l: { description: string; totalExGst: number }) => `${l.description}|${l.totalExGst.toFixed(2)}`;
  const out: string[] = [];
  for (const l of before) if (!after.some((a) => key(a) === key(l))) out.push(`removed ${l.description} $${l.totalExGst.toFixed(2)}`);
  for (const l of after) if (!before.some((b) => key(b) === key(l))) out.push(`added ${l.description} $${l.totalExGst.toFixed(2)}`);
  return out;
}

async function logDepot(what: "created" | "reused" | "updated", depotId: number | null, poNumber: string, supplierId: number, actor: { name: string; role: string }) {
  if (what === "reused" || depotId == null) return;
  await db.insert(schema.activityLog).values({
    entityType: "supplier",
    entityId: supplierId,
    action: what === "created" ? "depot_saved" : "depot_updated",
    detail: `${what === "created" ? "Pickup location saved" : "Saved pickup location changed"} from ${poNumber}.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
}

export const purchasing = {
  /** A supplier's saved pickup locations, for the pickup choice on a PO. */
  depots: adminOnly.input(z.object({ supplierId: z.number() })).handler(({ input }) => depotsFor(input.supplierId)),

  /** A saved depot at the address being typed, so the office reuses it instead of saving a copy. */
  depotMatch: adminOnly.input(z.object({ supplierId: z.number(), address: z.string().max(300) })).handler(async ({ input }) => {
    const d = await matchingDepot(input.supplierId, input.address);
    return d && d.active ? { id: d.id, name: d.name, address: d.address } : null;
  }),

  /** Everything the PO card on a job needs. */
  forJob: adminOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    // A removed draft is kept only to hold its letter. Nobody needs to see it.
    const pos = (await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.jobId, input.jobId)).orderBy(asc(schema.purchaseOrders.number))).filter(
      (p) => !(p.status === "cancelled" && !p.sentAt),
    );
    const poIds = pos.map((p) => p.id);
    const lines = poIds.length
      ? await db.select().from(schema.purchaseOrderLines).where(inArray(schema.purchaseOrderLines.poId, poIds)).orderBy(asc(schema.purchaseOrderLines.sortOrder))
      : [];
    const invoices = poIds.length
      ? await db
          .select({
            id: schema.supplierInvoices.id,
            poId: schema.supplierInvoices.poId,
            invoiceNumber: schema.supplierInvoices.invoiceNumber,
            docType: schema.supplierInvoices.docType,
            totalIncGst: schema.supplierInvoices.totalIncGst,
            totalExGst: schema.supplierInvoices.totalExGst,
            matchStatus: schema.supplierInvoices.matchStatus,
            matchNote: schema.supplierInvoices.matchNote,
            payState: schema.supplierInvoices.payState,
            checkedAt: schema.supplierInvoices.checkedAt,
          })
          .from(schema.supplierInvoices)
          .where(inArray(schema.supplierInvoices.poId, poIds))
      : [];

    const materials = await db
      .select({
        id: schema.jobMaterials.id,
        productId: schema.jobMaterials.productId,
        description: schema.jobMaterials.description,
        qty: schema.jobMaterials.qty,
        unit: schema.jobMaterials.unit,
        status: schema.jobMaterials.status,
        supplierId: schema.products.supplierId,
      })
      .from(schema.jobMaterials)
      .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
      .where(eq(schema.jobMaterials.jobId, input.jobId))
      .orderBy(asc(schema.jobMaterials.id));

    // Which materials are already on a live PO.
    const livePoIds = new Set(pos.filter((p) => p.status !== "cancelled").map((p) => p.id));
    const onPo = new Map<number, string>();
    for (const l of lines) if (l.jobMaterialId && livePoIds.has(l.poId)) onPo.set(l.jobMaterialId, pos.find((p) => p.id === l.poId)!.number);

    const suppliers = await db
      .select({
        id: schema.suppliers.id,
        name: schema.suppliers.name,
        email: schema.suppliers.email,
        deliversDirect: schema.suppliers.deliversDirect,
        freightMethod: schema.suppliers.freightMethod,
        deliversTo: schema.suppliers.deliversTo,
      })
      .from(schema.suppliers)
      .where(eq(schema.suppliers.active, true))
      .orderBy(asc(schema.suppliers.name));

    return {
      siteAddress: await siteAddressFor(input.jobId),
      warehouseAddress: WAREHOUSE_ADDRESS,
      pos: pos.map((p) => ({
        ...p,
        pricingInputs: safeJson<SavedInputs>(p.pricingInputs, {}),
        supplierName: suppliers.find((s) => s.id === p.supplierId)?.name ?? "Supplier",
        lines: lines.filter((l) => l.poId === p.id),
        invoices: invoices.filter((i) => i.poId === p.id),
      })),
      materials: materials.map((m) => ({ ...m, onPo: onPo.get(m.id) ?? null })),
      suppliers,
    };
  }),

  /** Fee rules for the tickboxes when raising a PO to this supplier. */
  feeRules: adminOnly.input(z.object({ supplierId: z.number() })).handler(async ({ input }) => {
    return db
      .select({
        id: schema.supplierFeeRules.id,
        name: schema.supplierFeeRules.name,
        kind: schema.supplierFeeRules.kind,
        basis: schema.supplierFeeRules.basis,
        amount: schema.supplierFeeRules.amount,
        percent: schema.supplierFeeRules.percent,
        autoApply: schema.supplierFeeRules.autoApply,
        condition: schema.supplierFeeRules.condition,
        appliesTo: schema.supplierFeeRules.appliesTo,
      })
      .from(schema.supplierFeeRules)
      .where(and(eq(schema.supplierFeeRules.supplierId, input.supplierId), eq(schema.supplierFeeRules.active, true)))
      .orderBy(asc(schema.supplierFeeRules.sortOrder));
  }),

  /** What the PO would come to, without saving anything. */
  preview: adminOnly.input(poInput.extend({ jobId: z.number() })).handler(async ({ input }) => {
    try {
      return await pricePo(pricingOf(input));
    } catch (e) {
      throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
    }
  }),

  create: adminOnly.input(poInput.extend({ jobId: z.number() })).handler(async ({ input, context }) => {
    await assertDeliverable(input);
    const priced = await pricePo(pricingOf(input)).catch((e: Error) => {
      throw new ORPCError("BAD_REQUEST", { message: e.message });
    });
    const pickup = await pickupFor(input, context.actor.name);
    const number = await nextPoNumber(input.jobId).catch((e: Error) => {
      throw new ORPCError("BAD_REQUEST", { message: e.message });
    });
    const [po] = await db
      .insert(schema.purchaseOrders)
      .values({
        number,
        jobId: input.jobId,
        supplierId: input.supplierId,
        status: "draft",
        deliverTo: input.deliverTo,
        deliveryAddress: await deliveryFor(input.jobId, input),
        pickupDepotId: pickup.pickupDepotId,
        pickupName: pickup.pickupName,
        pickupAddress: pickup.pickupAddress,
        goodsExGst: priced.goodsExGst,
        chargesExGst: priced.chargesExGst,
        freightExGst: priced.freightExGst,
        totalExGst: priced.totalExGst,
        notes: input.notes,
        // The lines as typed go with it, so a draft reopens exactly as it was written.
        pricingInputs: JSON.stringify({ ...priced.pricingInputs, lines: input.lines }),
        createdByProfileId: await profileIdFor(context.actor.userId),
      })
      .returning();
    await writeLines(po!.id, priced.lines);
    if (pickup.saved) await logDepot(pickup.saved, pickup.pickupDepotId, po!.number, input.supplierId, context.actor);
    return { ...po!, priced, depotSaved: pickup.saved };
  }),

  /** Change a draft. Once a PO has gone to the supplier, cancel it and raise a new one instead. */
  update: adminOnly.input(poInput.extend({ id: z.number() })).handler(async ({ input, context }) => {
    const po = await loadPo(input.id);
    if (po.status !== "draft") throw new ORPCError("BAD_REQUEST", { message: `PO ${po.number} has gone to the supplier. Cancel it and raise a new one.` });
    if (po.jobId == null) throw new ORPCError("BAD_REQUEST", { message: `${po.number} is a warehouse order. Change it on the Reorder list.` });
    const jobId = po.jobId;
    await assertDeliverable(input);
    const priced = await pricePo(pricingOf(input)).catch((e: Error) => {
      throw new ORPCError("BAD_REQUEST", { message: e.message });
    });
    // Switching between delivery and pickup: charge changes are shown and confirmed first, never slipped in.
    if (po.deliverTo !== input.deliverTo && !input.chargesConfirmed) {
      const change = await chargeChanges(po.id, priced.lines);
      if (change.length) {
        throw new ORPCError("CONFLICT", { message: `Charges change with this switch: ${change.join("; ")}. Check them, then save again to confirm.`, data: { chargeChanges: change } });
      }
    }
    const pickup = await pickupFor(input, context.actor.name);
    const [row] = await db
      .update(schema.purchaseOrders)
      .set({
        supplierId: input.supplierId,
        deliverTo: input.deliverTo,
        deliveryAddress: await deliveryFor(jobId, input),
        pickupDepotId: pickup.pickupDepotId,
        pickupName: pickup.pickupName,
        pickupAddress: pickup.pickupAddress,
        goodsExGst: priced.goodsExGst,
        chargesExGst: priced.chargesExGst,
        freightExGst: priced.freightExGst,
        totalExGst: priced.totalExGst,
        notes: input.notes,
        // The lines as typed go with it, so a draft reopens exactly as it was written.
        pricingInputs: JSON.stringify({ ...priced.pricingInputs, lines: input.lines }),
        updatedAt: new Date(),
      })
      .where(eq(schema.purchaseOrders.id, po.id))
      .returning();
    await writeLines(po.id, priced.lines);
    if (pickup.saved) await logDepot(pickup.saved, pickup.pickupDepotId, po.number, input.supplierId, context.actor);
    return { ...row!, priced, depotSaved: pickup.saved };
  }),

  removeDraft: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const po = await loadPo(input.id);
    if (po.status !== "draft") throw new ORPCError("BAD_REQUEST", { message: "Only a draft can be deleted. Cancel it instead." });
    // Kept as cancelled, not deleted, so its letter is never handed out again. A printed draft can't clash.
    await db.update(schema.purchaseOrders).set({ status: "cancelled", notes: [po.notes, "Draft removed, never sent."].filter(Boolean).join(" "), updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, po.id));
    // A2: job shares on a removed warehouse draft stop counting.
    await db.update(schema.stockPoLinks).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(schema.stockPoLinks.poId, po.id), eq(schema.stockPoLinks.status, "open")));
    await resolveAiActionsForPo(po.id, context.actor.name, "dismissed");
    return { ok: true };
  }),

  /** The PDF, for a look before sending or to print. */
  pdf: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const { pdf, filename } = await pdfFor(input.id);
    return { filename, base64: pdf.toString("base64") };
  }),

  /**
   * Email the PO to the supplier from team@, PDF attached. `to` is a one-off
   * address; `saveEmail` also puts it on the supplier so the next one just goes.
   */
  send: adminOnly
    .input(z.object({ id: z.number(), to: z.string().max(200).optional(), saveEmail: z.boolean().default(false), overlapOverride: overrideInput }))
    .handler(({ input, context }) => sendPoNow(input, context.actor)),

  /** Phoned through, or put in on the supplier's portal. Same effect as sending, no email. */
  markSent: adminOnly
    .input(z.object({ id: z.number(), how: z.string().max(100).default("phoned"), overlapOverride: overrideInput }))
    .handler(({ input, context }) => markPoSentNow(input, context.actor)),

  cancel: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    try {
      await cancelPo(input.id);
    } catch (e) {
      throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
    }
    await resolveAiActionsForPo(input.id, context.actor.name, "dismissed");
    return { ok: true };
  }),

  /** Open POs to one supplier, for matching an invoice by hand. */
  openForSupplier: adminOnly.input(z.object({ supplierId: z.number() })).handler(async ({ input }) => {
    return db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        status: schema.purchaseOrders.status,
        totalExGst: schema.purchaseOrders.totalExGst,
        sentAt: schema.purchaseOrders.sentAt,
        jobNumber: jobNumberSql,
        jobTitle: schema.jobs.title,
      })
      .from(schema.purchaseOrders)
      // Left join: a warehouse order (A2) has no job and must still be matchable.
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
      .where(and(eq(schema.purchaseOrders.supplierId, input.supplierId), ne(schema.purchaseOrders.status, "cancelled"), ne(schema.purchaseOrders.status, "draft")))
      .orderBy(desc(schema.purchaseOrders.createdAt))
      .limit(100);
  }),

  /** A stored copy of a sent PO. */
  storedPdfUrl: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const po = await loadPo(input.id);
    if (!po.sentAt) throw new ORPCError("BAD_REQUEST", { message: "Not sent yet." });
    return { url: await signGet(`purchase-orders/${po.number}.pdf`) };
  }),
};
