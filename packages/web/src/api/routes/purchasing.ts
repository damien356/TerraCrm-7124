import { z } from "zod";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { cancelPo, commitPo, nextPoNumber, pricePo, WAREHOUSE_ADDRESS, writeLines, type PoLineInput, type PoPricingInput } from "../lib/purchase-orders";
import { renderPoPdf } from "../lib/poPdf";
import { sendAsTeam } from "../lib/agent-mail";
import { INVOICES_TO } from "../lib/gmail";
import { putObject, signGet } from "../lib/s3";
import { auDate, safeJson } from "../lib/invoice-match";
import { todayISO } from "../lib/pricing";

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

const poInput = z.object({
  supplierId: z.number(),
  deliverTo: z.enum(["warehouse", "site"]).default("warehouse"),
  deliveryAddress: z.string().max(300).default(""),
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

async function siteAddressFor(jobId: number) {
  const [row] = await db
    .select({ address: schema.sites.address, suburb: schema.sites.suburb, state: schema.sites.state, postcode: schema.sites.postcode })
    .from(schema.jobs)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
    .where(eq(schema.jobs.id, jobId));
  if (!row?.address) return "";
  return [row.address, [row.suburb, row.state, row.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function pricingOf(input: PoInput): PoPricingInput {
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

async function deliveryFor(jobId: number, input: PoInput) {
  if (input.deliverTo === "warehouse") return WAREHOUSE_ADDRESS;
  return input.deliveryAddress.trim() || (await siteAddressFor(jobId));
}

async function loadPo(id: number) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));
  if (!po) throw new ORPCError("NOT_FOUND", { message: "PO not found" });
  return po;
}

async function pdfFor(poId: number) {
  const po = await loadPo(poId);
  const [job] = await db.select({ number: schema.jobs.number, title: schema.jobs.title }).from(schema.jobs).where(eq(schema.jobs.id, po.jobId));
  const [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
  const lines = await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId)).orderBy(asc(schema.purchaseOrderLines.sortOrder));
  const date = po.sentAt ? po.sentAt.toISOString().slice(0, 10) : todayISO();
  const pdf = await renderPoPdf({
    number: po.number,
    date: auDate(date),
    supplierName: sup?.name ?? "Supplier",
    supplierAccount: sup?.accountNumber ?? null,
    jobNumber: job?.number ?? 0,
    jobTitle: job?.title ?? "",
    deliverTo: po.deliverTo === "site" ? "site" : "warehouse",
    deliveryAddress: po.deliveryAddress,
    notes: po.notes,
    lines: lines.map((l) => ({
      description: l.description,
      qty: l.qty,
      unit: l.unit,
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

export function poEmailText(supplierName: string, number: string, jobNumber: number, deliverTo: string, address: string) {
  return {
    subject: `Purchase order ${number}, Terra Flooring`,
    text: [
      `Hi ${supplierName},`,
      "",
      `Please find attached purchase order ${number} for job ${jobNumber}.`,
      "",
      `Deliver to: ${deliverTo === "site" ? `site, ${address}` : `our warehouse, ${address}`}`,
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

export const purchasing = {
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
    const priced = await pricePo(pricingOf(input)).catch((e: Error) => {
      throw new ORPCError("BAD_REQUEST", { message: e.message });
    });
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
    return { ...po!, priced };
  }),

  /** Change a draft. Once a PO has gone to the supplier, cancel it and raise a new one instead. */
  update: adminOnly.input(poInput.extend({ id: z.number() })).handler(async ({ input }) => {
    const po = await loadPo(input.id);
    if (po.status !== "draft") throw new ORPCError("BAD_REQUEST", { message: `PO ${po.number} has gone to the supplier. Cancel it and raise a new one.` });
    const priced = await pricePo(pricingOf(input)).catch((e: Error) => {
      throw new ORPCError("BAD_REQUEST", { message: e.message });
    });
    const [row] = await db
      .update(schema.purchaseOrders)
      .set({
        supplierId: input.supplierId,
        deliverTo: input.deliverTo,
        deliveryAddress: await deliveryFor(po.jobId, input),
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
    return { ...row!, priced };
  }),

  removeDraft: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const po = await loadPo(input.id);
    if (po.status !== "draft") throw new ORPCError("BAD_REQUEST", { message: "Only a draft can be deleted. Cancel it instead." });
    // Kept as cancelled, not deleted, so its letter is never handed out again. A printed draft can't clash.
    await db.update(schema.purchaseOrders).set({ status: "cancelled", notes: [po.notes, "Draft removed, never sent."].filter(Boolean).join(" "), updatedAt: new Date() }).where(eq(schema.purchaseOrders.id, po.id));
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
    .input(z.object({ id: z.number(), to: z.string().max(200).optional(), saveEmail: z.boolean().default(false) }))
    .handler(async ({ input }) => {
      const po = await loadPo(input.id);
      if (po.status === "cancelled") throw new ORPCError("BAD_REQUEST", { message: "This PO is cancelled." });
      if (po.totalExGst <= 0) throw new ORPCError("BAD_REQUEST", { message: "This PO is $0. Put the costs in first." });
      const [sup] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
      const to = (input.to?.trim() || sup?.email || "").trim();
      if (!to) throw new ORPCError("BAD_REQUEST", { message: `No email on file for ${sup?.name ?? "this supplier"}. Type one in, or add it on the Suppliers page.` });
      if (!EMAIL.test(to)) throw new ORPCError("BAD_REQUEST", { message: `"${to}" is not an email address.` });
      if (input.saveEmail && sup && to !== sup.email) {
        await db.update(schema.suppliers).set({ email: to, updatedAt: new Date() }).where(eq(schema.suppliers.id, sup.id));
      }

      const [job] = await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, po.jobId));
      const { pdf, filename } = await pdfFor(po.id);
      const mail = poEmailText(sup?.name ?? "there", po.number, job?.number ?? 0, po.deliverTo, po.deliveryAddress);
      try {
        await sendAsTeam({ to, subject: mail.subject, text: mail.text, attachments: [{ filename, content: pdf, contentType: "application/pdf" }] });
      } catch (e) {
        throw new ORPCError("BAD_GATEWAY", { message: `Email did not go: ${(e as Error).message}` });
      }
      await putObject(`purchase-orders/${po.number}.pdf`, pdf, "application/pdf", filename).catch(() => {});
      await commitPo(po.id, "email", to);
      return { ok: true, to };
    }),

  /** Phoned through, or put in on the supplier's portal. Same effect as sending, no email. */
  markSent: adminOnly.input(z.object({ id: z.number(), how: z.string().max(100).default("phoned") })).handler(async ({ input }) => {
    const po = await loadPo(input.id);
    if (po.status === "cancelled") throw new ORPCError("BAD_REQUEST", { message: "This PO is cancelled." });
    await commitPo(po.id, "other", input.how);
    return { ok: true };
  }),

  cancel: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    try {
      await cancelPo(input.id);
    } catch (e) {
      throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
    }
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
        jobNumber: schema.jobs.number,
        jobTitle: schema.jobs.title,
      })
      .from(schema.purchaseOrders)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
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
