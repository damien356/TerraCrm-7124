import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { logAiAction } from "./ai-actions";
import { jobText } from "./refs";
import { nextPoNumber, pricePo, siteAddressFor, WAREHOUSE_ADDRESS, writeLines, type PoLineInput } from "./purchase-orders";

/* ---------------------------------------------------------------------------
 * Step 2 (20 Oct): the supplier PO helper.
 *
 * When a quote is accepted, Ops drafts one PO per supplier for the job's
 * materials that are still to order and not on a PO yet. It only drafts.
 * A person checks each draft on the job page and sends it. Nothing here
 * emails or calls anyone.
 *
 *   Each draft goes on the "Waiting for you" tray until it is sent, marked
 *   sent, removed or cancelled (routes/purchasing.ts takes it off).
 *   Materials with no supplier in the price book are listed on the tray too,
 *   so they are not forgotten.
 *   A supplier ticked "No PO needed" gets no draft. That is logged only.
 * ------------------------------------------------------------------------- */

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type PoHelperResult = { drafted: Array<{ poId: number; number: string; supplierId: number; totalExGst: number }>; skipped: number };

type Material = { id: number; description: string; qty: number; unit: string; productId: number | null; supplierId: number | null };

/** Materials on the job still to order and not on a live PO (a draft counts as live). */
async function openMaterials(jobId: number): Promise<Material[]> {
  const rows = await db
    .select({
      id: schema.jobMaterials.id,
      description: schema.jobMaterials.description,
      qty: schema.jobMaterials.qty,
      unit: schema.jobMaterials.unit,
      productId: schema.jobMaterials.productId,
      supplierId: schema.products.supplierId,
    })
    .from(schema.jobMaterials)
    .leftJoin(schema.products, eq(schema.products.id, schema.jobMaterials.productId))
    .where(and(eq(schema.jobMaterials.jobId, jobId), eq(schema.jobMaterials.status, "to_order")))
    .orderBy(asc(schema.jobMaterials.id));
  if (!rows.length) return [];
  const onPo = await db
    .select({ jobMaterialId: schema.purchaseOrderLines.jobMaterialId })
    .from(schema.purchaseOrderLines)
    .innerJoin(schema.purchaseOrders, eq(schema.purchaseOrders.id, schema.purchaseOrderLines.poId))
    .where(
      and(
        inArray(
          schema.purchaseOrderLines.jobMaterialId,
          rows.map((r) => r.id),
        ),
        ne(schema.purchaseOrders.status, "cancelled"),
      ),
    );
  const taken = new Set(onPo.map((r) => r.jobMaterialId));
  return rows.filter((r) => r.qty > 0 && !taken.has(r.id));
}

/**
 * True if these same materials were already reported left off a PO for this
 * job (any status: a person may have said "leave it"). Stops a second accept
 * on the same job putting the same item on the tray twice.
 */
async function alreadyReported(jobId: number, supplierId: number | null, materialIds: number[]) {
  const want = JSON.stringify([...materialIds].sort((a, b) => a - b));
  const rows = await db
    .select({ data: schema.aiActions.data })
    .from(schema.aiActions)
    .where(
      and(
        eq(schema.aiActions.jobId, jobId),
        eq(schema.aiActions.kind, "po_skipped"),
        supplierId ? eq(schema.aiActions.supplierId, supplierId) : sql`${schema.aiActions.supplierId} is null`,
      ),
    );
  return rows.some((r) => {
    try {
      const ids = (JSON.parse(r.data) as { materialIds?: number[] }).materialIds ?? [];
      return JSON.stringify([...ids].sort((a, b) => a - b)) === want;
    } catch {
      return false;
    }
  });
}

/**
 * Draft the POs for a job. Safe to call more than once: anything already on
 * a PO is left alone. Never throws; a failure is logged and the accept goes on.
 */
export async function draftPosForJob(args: { jobId: number; quoteRef: string }): Promise<PoHelperResult> {
  // One pass per job at a time (21 Oct). Two accepts landing together, or a
  // retry while the first is still pricing, wait their turn. The second then
  // finds the materials already on the first one's drafts and drafts nothing.
  const prev = jobLocks.get(args.jobId) ?? Promise.resolve();
  const run = prev.then(() => draftPosForJobNow(args));
  const tail = run.catch(() => undefined);
  jobLocks.set(args.jobId, tail);
  try {
    return await run;
  } finally {
    if (jobLocks.get(args.jobId) === tail) jobLocks.delete(args.jobId);
  }
}
const jobLocks = new Map<number, Promise<unknown>>();

async function draftPosForJobNow(args: { jobId: number; quoteRef: string }): Promise<PoHelperResult> {
  const out: PoHelperResult = { drafted: [], skipped: 0 };
  try {
    const materials = await openMaterials(args.jobId);
    if (!materials.length) return out;

    const [job] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, args.jobId));
    if (!job) return out;
    const jobRef = jobText(job);
    const path = `/jobs/${args.jobId}`;

    const bySupplier = new Map<number, Material[]>();
    const noSupplier: Material[] = [];
    for (const m of materials) {
      if (m.supplierId) bySupplier.set(m.supplierId, [...(bySupplier.get(m.supplierId) ?? []), m]);
      else noSupplier.push(m);
    }

    const supplierRows = bySupplier.size
      ? await db
          .select({
            id: schema.suppliers.id,
            name: schema.suppliers.name,
            active: schema.suppliers.active,
            deliversTo: schema.suppliers.deliversTo,
            noPoNeeded: schema.suppliers.noPoNeeded,
          })
          .from(schema.suppliers)
          .where(inArray(schema.suppliers.id, [...bySupplier.keys()]))
      : [];
    const suppliers = new Map(supplierRows.map((s) => [s.id, s]));

    let siteAddress: string | null = null;
    for (const [supplierId, items] of bySupplier) {
      const sup = suppliers.get(supplierId);
      if (!sup || !sup.active) {
        noSupplier.push(...items);
        continue;
      }
      if (sup.noPoNeeded) {
        out.skipped += items.length;
        if (await alreadyReported(args.jobId, supplierId, items.map((m) => m.id))) continue;
        await logAiAction({
          kind: "po_skipped",
          title: `No PO for ${sup.name}, job ${jobRef}`,
          detail: `${sup.name} is ticked "No PO needed". Left off: ${items.map((m) => m.description).join(", ")}.`,
          path,
          jobId: args.jobId,
          supplierId,
          data: { materialIds: items.map((m) => m.id) },
        });
        continue;
      }
      try {
        const deliverTo = sup.deliversTo === "site" ? "site" : "warehouse";
        if (deliverTo === "site" && siteAddress === null) siteAddress = await siteAddressFor(args.jobId);
        const lines: PoLineInput[] = items.map((m) => ({ kind: "goods", jobMaterialId: m.id, productId: m.productId, description: m.description, qty: m.qty, unit: m.unit }));
        const priced = await pricePo({ supplierId, deliverTo, lines });
        const number = await nextPoNumber(args.jobId);
        const [po] = await db
          .insert(schema.purchaseOrders)
          .values({
            number,
            jobId: args.jobId,
            supplierId,
            status: "draft",
            deliverTo,
            deliveryAddress: deliverTo === "site" ? (siteAddress ?? "") : WAREHOUSE_ADDRESS,
            goodsExGst: priced.goodsExGst,
            chargesExGst: priced.chargesExGst,
            freightExGst: priced.freightExGst,
            totalExGst: priced.totalExGst,
            notes: "",
            // Same shape purchasing.create keeps, so the draft reopens as written.
            pricingInputs: JSON.stringify({ ...priced.pricingInputs, lines }),
            createdByProfileId: null,
          })
          .returning();
        if (!po) continue;
        await writeLines(po.id, priced.lines);
        out.drafted.push({ poId: po.id, number: po.number, supplierId, totalExGst: priced.totalExGst });

        const toCheck = priced.lines.filter((l) => l.note).map((l) => `${l.description}: ${l.note}`);
        const noAddress = deliverTo === "site" && !siteAddress;
        await logAiAction({
          kind: "po_drafted",
          waiting: true,
          title: `PO ${po.number} to ${sup.name} drafted, job ${jobRef}`,
          detail: [
            `Drafted when quote ${args.quoteRef} was accepted. ${plural(items.length, "line")}, ${money(priced.totalExGst)} ex GST, to ${deliverTo === "site" ? "site" : "the warehouse"}.`,
            noAddress ? "The job has no site address. Type one before sending." : "",
            priced.totalExGst <= 0 ? "It comes to $0. Put the costs in before sending." : "",
            ...toCheck.map((t) => `Check: ${t}`),
            "Not sent. Check it on the job and send it.",
          ]
            .filter(Boolean)
            .join("\n"),
          path,
          jobId: args.jobId,
          supplierId,
          poId: po.id,
          data: { quoteRef: args.quoteRef, materialIds: items.map((m) => m.id) },
        });
        await db.insert(schema.activityLog).values({
          jobId: args.jobId,
          entityType: "purchase_order",
          entityId: po.id,
          action: "po_drafted",
          detail: `PO ${po.number} to ${sup.name} drafted by the Purchasing helper, ${money(priced.totalExGst)} ex GST. Not sent.`,
          actorName: "Purchasing helper",
          actorRole: "system",
        });
      } catch (e) {
        console.error(`[po-helper] job ${args.jobId} supplier ${supplierId}:`, (e as Error).message ?? e);
        out.skipped += items.length;
        await logAiAction({
          kind: "po_skipped",
          waiting: true,
          title: `Could not draft the PO to ${sup.name}, job ${jobRef}`,
          detail: `${(e as Error).message ?? "Unknown error"}\nRaise it by hand: ${items.map((m) => m.description).join(", ")}.`,
          path,
          jobId: args.jobId,
          supplierId,
        });
      }
    }

    if (noSupplier.length) {
      out.skipped += noSupplier.length;
      if (await alreadyReported(args.jobId, null, noSupplier.map((m) => m.id))) return out;
      await logAiAction({
        kind: "po_skipped",
        waiting: true,
        title: `${plural(noSupplier.length, "material")} with no supplier, job ${jobRef}`,
        detail: `No supplier in the price book, so no PO was drafted. Raise these by hand:\n${noSupplier.map((m) => `- ${m.description}, ${m.qty} ${m.unit}`).join("\n")}`,
        path,
        jobId: args.jobId,
        data: { materialIds: noSupplier.map((m) => m.id) },
      });
    }
  } catch (e) {
    console.error(`[po-helper] job ${args.jobId}:`, (e as Error).message ?? e);
  }
  return out;
}
