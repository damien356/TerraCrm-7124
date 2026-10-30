import { z } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import { billToOfLink, buyerCandidates, buyerLinkOf, createBuyerFromInstaller, invoicesForLink, linkBuyer, openInstallerBills, unlinkBuyer } from "../lib/installer-buyer";
import {
  approvalPhrase,
  approveContra,
  assertWorkflow,
  cancelContra,
  confirmContra,
  contraFlags,
  contrasFor,
  pinXeroContact,
  postContra,
  prepareContra,
  previewContra,
  readBills,
  xeroContactCandidates,
} from "../lib/contras";
import { quoteRefOf } from "../lib/quote-number";
import { emailedAtFor } from "../lib/invoice-emailed";
import { salesAccountsView, xeroSettings } from "../lib/xero-invoices";
import { raiseMaterialsInvoice } from "../lib/materials-sale";

/* ---------------------------------------------------------------------------
 * Installer Account tab (Task H, Damien 29 Oct).
 *
 * An installer who buys materials is billed as one existing contact or
 * company. Office or Admin only: his own field login never reaches any of
 * this, and the link gives his login nothing new.
 *
 * Contras (Xero bills, preview, approve, post) are Admin only and switched
 * off unless CONTRA_WORKFLOW=on. Posting also needs XERO_CONTRA_POSTING=on.
 * ------------------------------------------------------------------------- */

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const buyerInput = z.object({ type: z.enum(["contact", "company"]), id: z.number().int().positive() });

async function materialsQuotes(link: typeof schema.installerBuyerLinks.$inferSelect) {
  const ref = billToOfLink(link);
  const rows = await db
    .select()
    .from(schema.quotes)
    .where(
      and(
        eq(schema.quotes.billToType, ref.type),
        ref.type === "company" ? eq(schema.quotes.billToCompanyId, ref.id) : eq(schema.quotes.billToContactId, ref.id),
        inArray(schema.quotes.status, ["draft", "needs_review", "sent"]),
      ),
    )
    .orderBy(desc(schema.quotes.id))
    .limit(20);
  return Promise.all(rows.map(async (q) => ({ id: q.id, jobId: q.jobId, ref: await quoteRefOf(q), status: q.status, total: r2(q.total ?? 0), createdAt: q.createdAt })));
}

export const installerAccount = {
  /** Everything the Account tab shows. */
  overview: staffOnly.input(z.object({ installerId: z.number() })).handler(async ({ input, context }) => {
    const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, input.installerId));
    if (!i) throw new ORPCError("NOT_FOUND", { message: "Installer not found" });
    const link = await buyerLinkOf(i.id);
    const flags = contraFlags();
    const isAdmin = context.actor.role === "admin";
    const [cands, invoices, bills, quotes, contras, settings, salesAccounts] = await Promise.all([
      link ? Promise.resolve(null) : buyerCandidates(i.id),
      link ? invoicesForLink(link) : Promise.resolve([]),
      openInstallerBills(i.id),
      link ? materialsQuotes(link) : Promise.resolve([]),
      flags.workflow && isAdmin ? contrasFor(i.id) : Promise.resolve([]),
      flags.workflow && isAdmin ? xeroSettings() : Promise.resolve(null),
      salesAccountsView(),
    ]);
    const emailed = await emailedAtFor(invoices.map((r) => r.id));
    return {
      installer: { id: i.id, name: i.name, abn: i.abn, legalName: i.abnLegalName ?? null, tradingName: i.tradingName ?? null, email: i.invoiceEmail ?? i.email ?? null, mobile: i.mobile ?? null },
      link: link
        ? {
            billTo: billToOfLink(link),
            name: link.buyerName,
            abn: link.buyerAbn,
            basis: link.basis,
            reason: link.reason,
            confirmedByName: link.confirmedByName,
            confirmedAt: link.confirmedAt,
            xeroContactName: isAdmin ? link.xeroContactName : null,
            xeroPinned: isAdmin ? !!link.xeroContactId : false,
          }
        : null,
      candidates: cands?.candidates ?? [],
      owesUs: invoices
        .filter((r) => r.status !== "void")
        .map((r) => ({ id: r.id, number: r.number, jobId: r.jobId, label: r.label, status: r.status, emailedAt: emailed.get(r.id) ?? null, total: r2(r.total), paid: r2(r.amountPaid), due: r2(r.total - r.amountPaid), inXero: !!r.xeroInvoiceId, dueDate: r.dueDate, salesCategory: r.salesCategory === "installer_materials" ? ("installer_materials" as const) : ("customer" as const) })),
      weOweHim: bills.map((b) => ({ id: b.id, number: b.invoiceNumber, jobId: b.jobId, status: b.status, total: r2(b.total), submittedAt: b.submittedAt })),
      materialsQuotes: quotes,
      contras: contras.map((c) => ({ ...c, phrase: approvalPhrase(c.amount) })),
      flags: { workflow: flags.workflow && isAdmin, posting: flags.posting && isAdmin },
      contraAccount: settings?.contraAccount ?? null,
      /** Task H: where a materials invoice goes in Xero (204), shown on the form before it is raised. */
      salesAccounts,
    };
  }),

  candidates: staffOnly.input(z.object({ installerId: z.number() })).handler(({ input }) => buyerCandidates(input.installerId)),

  link: staffOnly
    .input(z.object({ installerId: z.number(), buyer: buyerInput, sameEntity: z.literal(true), reason: z.string().trim().max(300).nullish() }))
    .handler(({ input, context }) => linkBuyer(input, context.actor)),

  createBuyer: staffOnly
    .input(z.object({ installerId: z.number(), as: z.enum(["company", "contact"]), name: z.string().trim().min(2).max(200), noneOfThese: z.boolean().default(false) }))
    .handler(({ input, context }) => createBuyerFromInstaller(input, context.actor)),

  unlink: staffOnly
    .input(z.object({ installerId: z.number(), reason: z.string().trim().max(300) }))
    .handler(({ input, context }) => unlinkBuyer(input, context.actor)),

  /**
   * New materials invoice: an agreed product sale, raised in one step on an
   * internal supply only job (lib/materials-sale.ts). No quote is sent and
   * nothing is accepted by hand. The same request key twice gets the same
   * invoice back. Office or Admin.
   */
  materialsInvoice: staffOnly
    .input(
      z.object({
        installerId: z.number().int(),
        requestKey: z.string().trim().min(8).max(80),
        lines: z
          .array(
            z.object({
              productId: z.number().int().nullish(),
              description: z.string().trim().min(1).max(500),
              qty: z.number().positive().max(100000),
              unit: z.string().trim().max(20).default("each"),
              /** Ex GST, as quote lines are. */
              unitPrice: z.number().positive().max(1000000),
            }),
          )
          .min(1)
          .max(40),
        note: z.string().trim().max(1000).nullish(),
      }),
    )
    .handler(({ input, context }) => raiseMaterialsInvoice(input, context.actor)),

  /* ------------------------------ contras ------------------------------- */

  xeroContacts: adminOnly.input(z.object({ installerId: z.number() })).handler(({ input }) => xeroContactCandidates(input.installerId)),

  pinXero: adminOnly
    .input(z.object({ installerId: z.number(), xeroContactId: z.string().trim().min(8).max(64), repointInvoices: z.boolean().default(false) }))
    .handler(({ input, context }) => pinXeroContact(input, context.actor)),

  xeroBills: adminOnly.input(z.object({ installerId: z.number() })).handler(({ input }) => readBills(input.installerId)),

  contraPreview: adminOnly
    .input(z.object({ installerId: z.number(), invoiceId: z.number(), billXeroId: z.string().trim().min(8).max(64), amount: z.number().positive().nullish() }))
    .handler(({ input }) => previewContra(input)),

  contraPrepare: adminOnly
    .input(
      z.object({
        requestKey: z.string().trim().min(8).max(80),
        installerId: z.number(),
        invoiceId: z.number(),
        billXeroId: z.string().trim().min(8).max(64),
        amount: z.number().positive(),
        fingerprint: z.string().min(8).max(64),
        agreement: z.object({ how: z.enum(["email", "sms", "signed", "in_person", "phone"]), note: z.string().trim().max(1000), on: z.string().trim() }),
        sameEntity: z.literal(true),
      }),
    )
    .handler(({ input, context }) => prepareContra(input, context.actor)),

  contraApprove: adminOnly.input(z.object({ id: z.number(), confirm: z.string().max(40) })).handler(({ input, context }) => approveContra(input, context.actor)),

  contraPost: adminOnly.input(z.object({ id: z.number() })).handler(({ input, context }) => postContra(input.id, context.actor)),

  contraConfirm: adminOnly.input(z.object({ id: z.number() })).handler(({ input, context }) => confirmContra(input.id, context.actor)),

  contraCancel: adminOnly.input(z.object({ id: z.number(), reason: z.string().trim().max(300) })).handler(({ input, context }) => cancelContra(input, context.actor)),

  contraHistory: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    assertWorkflow();
    return db
      .select()
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "contra"), eq(schema.activityLog.entityId, input.id)))
      .orderBy(desc(schema.activityLog.id));
  }),
};
