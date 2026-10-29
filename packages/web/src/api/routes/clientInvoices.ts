import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { rebuildForecast } from "../lib/cashflow";
import { invoicesForJob, markInvoicePaid, PAYMENT_METHODS, shapeInvoice, voidInvoice } from "../lib/client-invoices";
import { createSelection, selectionForJob, sendSelection } from "../lib/material-selection";
import { isProductForm, lockState, staffSections } from "../lib/selection-colours";
import { staffOffers } from "../lib/underlay-upgrade";
import { EMAIL_RE } from "../lib/quote-email";
import { sendInvoiceEmail } from "../lib/invoice-email";
import { uploadInput } from "../lib/job-mail";
import { cardPaymentsOn, payUrl } from "../lib/stripe";
import { billingOnJob, RAISE_KINDS, raiseJobInvoice } from "../lib/final-invoice";
import { pushingToXero, SALES_CATEGORIES, SALES_CATEGORY_LABEL, salesAccountFor, salesAccountsView, xeroSettings } from "../lib/xero-invoices";


/* ---------------------------------------------------------------------------
 * The job page's money-in card and material selection card (spec section 2).
 * Admin and Office mark a client invoice paid. Only Admin voids one.
 * Card payments through Stripe mark themselves paid (lib/stripe.ts). Bank,
 * cash and anything else are still marked here by hand.
 * ------------------------------------------------------------------------- */

const rebuild = () => rebuildForecast().catch((e) => console.error("[cashflow] rebuild after invoice change failed:", e));

/** The card's view. New forms (item 8) carry one section per product; old room by room ones carry items. */
async function shapeSelection(s: Awaited<ReturnType<typeof selectionForJob>>) {
  if (!s) return null;
  const productForm = isProductForm(s.items);
  const [lock, sections, upgrades, variation, task] = await Promise.all([
    lockState(s.jobId),
    productForm ? staffSections(s.items) : Promise.resolve([]),
    productForm ? staffOffers(s.items) : Promise.resolve([]),
    s.variationId
      ? db.select({ id: schema.variations.id, ref: schema.variations.ref, status: schema.variations.status }).from(schema.variations).where(eq(schema.variations.id, s.variationId))
      : Promise.resolve([]),
    s.taskId
      ? db.select({ id: schema.officeTasks.id, title: schema.officeTasks.title, status: schema.officeTasks.status }).from(schema.officeTasks).where(eq(schema.officeTasks.id, s.taskId))
      : Promise.resolve([]),
  ]);
  return {
    id: s.id,
    status: s.status,
    url: s.url,
    sentTo: s.sentTo,
    sentAt: s.sentAt,
    submittedAt: s.submittedAt,
    submittedName: s.submittedName,
    kind: productForm ? ("products" as const) : ("rooms" as const),
    notes: s.notes,
    locked: lock.locked,
    sections,
    upgrades,
    variation: variation[0] ?? null,
    task: task[0] ?? null,
    items: s.items.map((i) => ({ id: i.id, areaId: i.areaId, room: i.room, product: i.product, colour: i.colour, notes: i.notes })),
  };
}

export const clientInvoices = {
  forJob: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    const rows = await invoicesForJob(input.jobId);
    const live = rows.filter((r) => r.status !== "void");
    // When each invoice was last emailed (lib/invoice-email.ts logs it), so the job shows what has gone out.
    const emails = await db
      .select({ id: schema.activityLog.entityId, at: schema.activityLog.createdAt })
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.jobId, input.jobId), eq(schema.activityLog.entityType, "invoice"), eq(schema.activityLog.action, "invoice_emailed")));
    const emailedAt = new Map<number, Date>();
    for (const e of emails) {
      if (e.id == null || !e.at) continue;
      const prev = emailedAt.get(e.id);
      if (!prev || e.at > prev) emailedAt.set(e.id, e.at);
    }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const card = cardPaymentsOn();
    return {
      invoices: rows.map((r) => ({ ...r, emailedAt: emailedAt.get(r.id) ?? null, payUrl: card && r.outstanding > 0 ? payUrl(r.id) : null })),
      cardPayments: card,
      salesAccounts: await salesAccountsView(),
      billed: round2(live.reduce((s, r) => s + r.total, 0)),
      received: round2(live.reduce((s, r) => s + r.amountPaid, 0)),
      owing: round2(live.reduce((s, r) => s + r.outstanding, 0)),
    };
  }),

  /** What is left to bill on the job, its default due date and who the invoice goes to. */
  billing: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => billingOnJob(input.jobId)),

  /**
   * Raise a final or progress invoice (fix list item 9). Defaults to what is
   * left to bill. Emailed with the Pay by card link when asked. If the email
   * fails the invoice still stands and the reason comes back.
   */
  raise: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        kind: z.enum(RAISE_KINDS),
        amount: z.number().positive().nullish(),
        label: z.string().trim().max(200).nullish(),
        email: z.boolean().default(false),
        to: z.string().trim().max(200).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.email && input.to && !EMAIL_RE.test(input.to)) {
        throw new ORPCError("BAD_REQUEST", { message: `"${input.to}" is not an email address.` });
      }
      const row = await raiseJobInvoice({
        jobId: input.jobId,
        kind: input.kind,
        amount: input.amount ?? null,
        label: input.label ?? null,
        actor: { name: context.actor.name, role: context.actor.role },
      });
      await rebuild();
      let emailedTo: string | null = null;
      let emailError: string | null = null;
      let summaryWithheld: string | null = null;
      if (input.email) {
        try {
          const sent = await sendInvoiceEmail({ invoiceId: row.id, to: input.to ?? null, byName: context.actor.name, actorRole: context.actor.role });
          emailedTo = sent.to;
          summaryWithheld = sent.summaryWithheld;
        } catch (e) {
          emailError = e instanceof Error ? e.message : String(e);
        }
      }
      return { invoice: shapeInvoice(row), emailedTo, emailError, summaryWithheld };
    }),

  /** Money landed. Paid in full unless a part amount is given. */
  markPaid: staffOnly
    .input(
      z.object({
        id: z.number(),
        method: z.enum(PAYMENT_METHODS),
        amount: z.number().positive().nullish(),
        /** YYYY-MM-DD, the day the money arrived. Today if left out. */
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
      }),
    )
    .handler(async ({ input, context }) => {
      const paidOn = input.paidOn ? new Date(`${input.paidOn}T12:00:00+10:00`) : null;
      if (paidOn && paidOn.getTime() > Date.now() + 86_400_000) {
        throw new ORPCError("BAD_REQUEST", { message: "The paid date cannot be in the future." });
      }
      const row = await markInvoicePaid({
        id: input.id,
        amount: input.amount ?? null,
        method: input.method,
        paidOn,
        byName: context.actor.name,
        actorRole: context.actor.role,
      });
      await rebuild();
      return shapeInvoice(row);
    }),

  /** Email the invoice to the client with its Pay by card link and the bank details. */
  email: staffOnly
    .input(
      z.object({
        id: z.number(),
        to: z.string().trim().max(200).nullish(),
        cc: z.array(z.string().trim().max(200)).max(10).optional(),
        mediaIds: z.array(z.number().int()).max(30).optional(),
        uploads: z.array(uploadInput).max(20).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      return sendInvoiceEmail({
        invoiceId: input.id,
        to: input.to ?? null,
        cc: input.cc,
        mediaIds: input.mediaIds,
        uploads: input.uploads,
        byName: context.actor.name,
        actorRole: context.actor.role,
      });
    }),

  /**
   * Task H (Damien, 29 Oct): which sales account this invoice goes to in
   * Xero. A person chooses it. Ops never sets it from an installer link: an
   * installer buying a floor for his own home stays Customer sales. Fixed
   * once the invoice is in Xero.
   */
  setSalesCategory: staffOnly
    .input(z.object({ id: z.number().int(), category: z.enum(SALES_CATEGORIES) }))
    .handler(async ({ input, context }) => {
      const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, input.id));
      if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
      if (inv.status === "void") throw new ORPCError("BAD_REQUEST", { message: "This invoice is void." });
      if (inv.xeroInvoiceId || pushingToXero(inv.id)) {
        throw new ORPCError("BAD_REQUEST", { message: "This invoice is already in Xero, so its sales account can not change here. Ask the bookkeeper to change it in Xero." });
      }
      if (inv.salesCategory === input.category) return shapeInvoice(inv);
      const [row] = await db
        .update(schema.invoices)
        .set({ salesCategory: input.category, updatedAt: new Date() })
        .where(and(eq(schema.invoices.id, inv.id), eq(schema.invoices.salesCategory, inv.salesCategory), isNull(schema.invoices.xeroInvoiceId)))
        .returning();
      if (!row) throw new ORPCError("CONFLICT", { message: "Someone else just changed this invoice. Refresh and try again." });
      const s = await xeroSettings();
      await db.insert(schema.activityLog).values({
        jobId: inv.jobId,
        entityType: "invoice",
        entityId: inv.id,
        action: "invoice_sales_category",
        detail: `${inv.number}: sales category set to ${SALES_CATEGORY_LABEL[input.category]} (account ${salesAccountFor(input.category, s)}), was ${SALES_CATEGORY_LABEL[inv.salesCategory === "installer_materials" ? "installer_materials" : "customer"]}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return shapeInvoice(row);
    }),

  void: adminOnly
    .input(z.object({ id: z.number(), reason: z.string().trim().min(3).max(300) }))
    .handler(async ({ input, context }) => {
      const row = await voidInvoice({ id: input.id, reason: input.reason, byName: context.actor.name, actorRole: context.actor.role });
      await rebuild();
      return row ? shapeInvoice(row) : null;
    }),

  selection: staffOnly.input(z.object({ jobId: z.number() })).handler(async ({ input }) => {
    return shapeSelection(await selectionForJob(input.jobId));
  }),

  /**
   * Send (or send again) the selection form. Only ever from this button
   * (fix list item 10). Makes the product form first if the job has none.
   */
  sendSelection: staffOnly
    .input(z.object({ jobId: z.number(), to: z.string().trim().max(200).nullish() }))
    .handler(async ({ input, context }) => {
      const [job] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.id, input.jobId));
      if (!job) throw new ORPCError("NOT_FOUND", { message: "Job not found" });
      if (input.to && !EMAIL_RE.test(input.to)) throw new ORPCError("BAD_REQUEST", { message: `"${input.to}" is not an email address.` });
      // A new product form unless the newest one already is one (lib/material-selection.ts).
      const sel = await createSelection({ jobId: job.id });
      if (input.to) {
        await db
          .update(schema.materialSelections)
          .set({ sentTo: input.to, updatedAt: new Date() })
          .where(eq(schema.materialSelections.id, sel.id));
      }
      const out = await sendSelection(sel.id, { name: context.actor.name });
      if (!out.sent) throw new ORPCError("BAD_REQUEST", { message: `Not sent: ${out.reason ?? "unknown reason"}` });
      return { ...out, selection: await shapeSelection(await selectionForJob(job.id)) };
    }),
};
