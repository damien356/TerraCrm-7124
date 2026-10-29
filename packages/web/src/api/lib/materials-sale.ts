import { ORPCError } from "@orpc/server";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { createQuoteRecord } from "../routes/quotes";
import { raiseJobInvoice } from "./final-invoice";
import { billToOfLink, buyerLinkOf } from "./installer-buyer";
import { moveJobForward } from "./job-stage";

/* ---------------------------------------------------------------------------
 * New materials invoice (Damien, 29 Oct): an agreed product sale to an
 * installer, raised in one step. No quote is sent and nobody presses
 * Accepted.
 *
 * Behind the scenes Ops still keeps the shape every invoice has, so the PDF,
 * the Xero lines and the read back work as they do for any supply invoice:
 *   - an internal quote with the lines, straight to accepted, deposit 0
 *   - an internal supply only job, Won, with no dispatches, no materials to
 *     order, no draft POs and no Order product task
 *   - the final invoice for the full amount, on his Billed as record
 *
 * Nothing on it can message anyone by itself:
 *   - the quote never goes to "sent", so quote follow-ups never see it
 *   - the quote and job carry no client contact or company (only a Bill to),
 *     so journeys (quote accepted, job completed, anniversary) skip it
 *   - care is marked skipped on the job and client prep is off
 *   - there are no dispatches, so no crew, installation or prep messages
 * The invoice is only emailed when someone presses Email on the job, the
 * same as every other invoice.
 *
 * A double click sends the same request key, and gets the same invoice back.
 * ------------------------------------------------------------------------- */

export const MATERIALS_SOURCE = "Installer (materials)";
const CLAIM = "materials_request";

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type MaterialsLine = { productId?: number | null; description: string; qty: number; unit: string; unitPrice: number };

/** One at a time per installer, so two clicks never race each other. */
const locks = new Map<number, Promise<void>>();
async function oneAtATime<T>(key: number, fn: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = before.then(() => new Promise<void>((r) => (release = r)));
  locks.set(key, mine);
  await before;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

async function claimOf(installerId: number, requestKey: string) {
  const [row] = await db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, CLAIM), eq(schema.activityLog.action, CLAIM), eq(schema.activityLog.detail, `${installerId}:${requestKey}`)));
  return row ?? null;
}

async function invoiceOnJob(jobId: number) {
  const [inv] = await db
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.jobId, jobId), eq(schema.invoices.kind, "final"), ne(schema.invoices.status, "void")));
  return inv ?? null;
}

export async function raiseMaterialsInvoice(
  input: { installerId: number; requestKey: string; lines: MaterialsLine[]; note?: string | null },
  actor: Actor,
) {
  const lines = input.lines
    .map((l) => ({ ...l, description: l.description.replace(/\s+/g, " ").trim(), unit: (l.unit || "each").trim() }))
    .filter((l) => l.description);
  if (!lines.length) throw bad("Add at least one line.");
  for (const l of lines) {
    if (!(l.qty > 0)) throw bad(`"${l.description}" needs a quantity over 0.`);
    if (!(l.unitPrice > 0)) throw bad(`"${l.description}" needs a price over $0.`);
  }

  return oneAtATime(input.installerId, async () => {
    // The same click again: hand back what the first one made.
    const seen = await claimOf(input.installerId, input.requestKey);
    if (seen) {
      const inv = seen.entityId ? await invoiceOnJob(seen.entityId) : null;
      if (!inv) throw bad("This invoice is still being raised, or the first try stopped part way. Refresh the page before trying again.");
      return { invoiceId: inv.id, number: inv.number, jobId: inv.jobId!, total: r2(inv.total), reused: true, salesCategory: inv.salesCategory === "installer_materials" ? ("installer_materials" as const) : ("customer" as const) };
    }

    const link = await buyerLinkOf(input.installerId);
    if (!link) throw bad("Set who he is billed as first.");
    const [installer] = await db.select({ name: schema.installers.name }).from(schema.installers).where(eq(schema.installers.id, input.installerId));
    if (!installer) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
    const ref = billToOfLink(link);

    const [claim] = await db
      .insert(schema.activityLog)
      .values({ entityType: CLAIM, action: CLAIM, detail: `${input.installerId}:${input.requestKey}`, actorName: actor.name, actorRole: actor.role })
      .returning();

    // The internal quote and job. No client contact or company on purpose: only the Bill to.
    const q = await createQuoteRecord(
      {
        jobId: null,
        contactId: null,
        companyId: null,
        supervisorContactId: null,
        people: [],
        makeJob: true,
        source: MATERIALS_SOURCE,
        siteId: null,
        billTo: ref,
        depositPercent: 0,
        validDays: 30,
        notes: input.note?.trim() || null,
        terms: null,
        items: lines.map((l) => ({
          productId: l.productId ?? null,
          kind: "supply",
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          unitPrice: l.unitPrice,
          unitCost: null,
          flagged: false,
          flagReason: null,
        })),
      },
      actor,
    );
    const jobId = q.jobId;
    if (!jobId) throw new Error("The internal job was not made.");
    const now = new Date();
    const [quote] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, q.id));
    const total = r2(quote?.total ?? 0);
    if (!(total > 0)) throw bad("The lines come to $0.");

    // Agreed already: accepted without the accept routine (no deposit, no work, no POs, no Order product task).
    await db.update(schema.quotes).set({ status: "accepted", acceptedAt: now, updatedAt: now }).where(eq(schema.quotes.id, q.id));
    await db
      .update(schema.jobs)
      .set({
        title: `Materials sale to ${link.buyerName}`.slice(0, 200),
        description: `Internal supply only job for a materials sale to installer ${installer.name}. Nothing to install.`,
        value: total,
        depositAmount: 0,
        prepOn: false,
        careState: "skipped",
        careNote: "Internal materials sale to an installer. No care emails.",
        updatedAt: now,
      })
      .where(eq(schema.jobs.id, jobId));
    await moveJobForward({ jobId, target: "won", why: "materials sale to an installer, agreed", actor });

    const inv = await raiseJobInvoice({
      jobId,
      kind: "final",
      label: `Materials supplied to ${link.buyerName}`,
      actor: { name: actor.name, role: actor.role },
    });

    // Task H (Damien, 29 Oct): this workflow is what makes it an installer materials sale (Xero 204). Nothing else does.
    await db.update(schema.invoices).set({ salesCategory: "installer_materials", updatedAt: new Date() }).where(eq(schema.invoices.id, inv.id));
    await db.update(schema.activityLog).set({ entityId: jobId }).where(eq(schema.activityLog.id, claim!.id));
    const summary = `${inv.number} raised for materials, ${money(inv.total)}, ${lines.length} line${lines.length === 1 ? "" : "s"}, billed to ${link.buyerName}. No quote sent, no crew work.`;
    await db.insert(schema.activityLog).values([
      { jobId, entityType: "job", entityId: jobId, action: "materials_sale", detail: summary, actorName: actor.name, actorRole: actor.role },
      { entityType: "installer", entityId: input.installerId, action: "materials_invoice_raised", detail: summary, actorName: actor.name, actorRole: actor.role },
    ]);
    return { invoiceId: inv.id, number: inv.number, jobId, total: r2(inv.total), reused: false, salesCategory: "installer_materials" as const };
  });
}
