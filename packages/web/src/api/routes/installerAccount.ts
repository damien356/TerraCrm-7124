import { z } from "zod";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
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
import { xeroSettings } from "../lib/xero-invoices";
import { createQuoteRecord } from "./quotes";

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

const MATERIALS_SOURCE = "Installer (materials)";
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
    const [cands, invoices, bills, quotes, contras, settings] = await Promise.all([
      link ? Promise.resolve(null) : buyerCandidates(i.id),
      link ? invoicesForLink(link) : Promise.resolve([]),
      openInstallerBills(i.id),
      link ? materialsQuotes(link) : Promise.resolve([]),
      flags.workflow && isAdmin ? contrasFor(i.id) : Promise.resolve([]),
      flags.workflow && isAdmin ? xeroSettings() : Promise.resolve(null),
    ]);
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
        .map((r) => ({ id: r.id, number: r.number, jobId: r.jobId, label: r.label, status: r.status, total: r2(r.total), paid: r2(r.amountPaid), due: r2(r.total - r.amountPaid), inXero: !!r.xeroInvoiceId, dueDate: r.dueDate })),
      weOweHim: bills.map((b) => ({ id: b.id, number: b.invoiceNumber, jobId: b.jobId, status: b.status, total: r2(b.total), submittedAt: b.submittedAt })),
      materialsQuotes: quotes,
      contras: contras.map((c) => ({ ...c, phrase: approvalPhrase(c.amount) })),
      flags: { workflow: flags.workflow && isAdmin, posting: flags.posting && isAdmin },
      contraAccount: settings?.contraAccount ?? null,
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
   * Bill him for materials: a supply quote to his linked record, deposit 0,
   * with its job. The quote page does the lines. Accept it, then raise the
   * invoice on the job. A second click within 5 minutes opens the same one.
   */
  startMaterials: staffOnly.input(z.object({ installerId: z.number() })).handler(async ({ input, context }) => {
    const link = await buyerLinkOf(input.installerId);
    if (!link) throw new ORPCError("BAD_REQUEST", { message: "Link him to the record he is billed as first." });
    const ref = billToOfLink(link);
    const since = new Date(Date.now() - 5 * 60_000);
    const [recent] = await db
      .select()
      .from(schema.quotes)
      .where(
        and(
          eq(schema.quotes.status, "draft"),
          eq(schema.quotes.billToType, ref.type),
          ref.type === "company" ? eq(schema.quotes.billToCompanyId, ref.id) : eq(schema.quotes.billToContactId, ref.id),
          gte(schema.quotes.createdAt, since),
        ),
      )
      .orderBy(desc(schema.quotes.id))
      .limit(1);
    if (recent) {
      const n = await db.select({ id: schema.quoteItems.id }).from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, recent.id)).limit(1);
      if (!n.length) return { quoteId: recent.id, jobId: recent.jobId, reused: true };
    }
    const q = await createQuoteRecord(
      {
        jobId: null,
        contactId: ref.type === "contact" ? ref.id : null,
        companyId: ref.type === "company" ? ref.id : null,
        supervisorContactId: null,
        people: [],
        makeJob: true,
        source: MATERIALS_SOURCE,
        siteId: null,
        billTo: ref,
        depositPercent: 0,
        validDays: 30,
        notes: null,
        terms: null,
        items: [],
      },
      context.actor,
    );
    await db.insert(schema.activityLog).values({
      jobId: q.jobId,
      entityType: "installer",
      entityId: input.installerId,
      action: "materials_quote_started",
      detail: `Materials quote started for ${link.buyerName}, deposit 0%.`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    return { quoteId: q.id, jobId: q.jobId, reused: false };
  }),

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
