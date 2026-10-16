import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { billedCompanyId } from "../lib/bill-to";
import { staffOnly } from "../middleware/auth";
import {
  BUNDLE_MODES,
  BUNDLE_TITLES,
  bundleCategoryOf,
  buildBundles,
  LINE_CATEGORIES,
  type BundleLine,
} from "../lib/bundles";
import { draftBundleWording } from "../agent/bundle-wording";
import { renderQuotePdf, type QuotePdfInput } from "../lib/quotePdf";
import { depositSplit, quotePercent } from "../lib/deposits";
import { todayISO } from "../lib/pricing";
import { auDate } from "../lib/invoice-match";
import { quoteRefOf } from "../lib/quote-number";
import { depositInvoiceFor } from "../lib/client-invoices";
import { linkForQuote, quoteUrl } from "../lib/quote-links";
import { itemRows, LAYOUT_LABELS, layoutUsed, QUOTE_LAYOUTS, type ItemRow } from "../lib/quote-layout";
import { cardPaymentsOn, owingOn, payUrl } from "../lib/stripe";
import { foldCharges } from "../lib/charge-fold";
import { foldFee } from "../lib/referral-fold";
import { quoteFee } from "../lib/referral-fees";

/**
 * Client bundles on a quote: the mode, which bundle each line sits in, and
 * the wording the client reads. Admin and Office only (staffOnly), the same
 * as the rest of quoting. Nothing here returns cost.
 */

const LOCKED = ["accepted", "declined", "expired", "replaced", "cancelled"];

/**
 * editable "wording": titles and wording, which can still change on an
 * accepted quote (188001 list item 7). Bundle mode and which section a line
 * sits in stay locked, the same as prices.
 */
async function quoteRow(id: number, editable: boolean | "wording") {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!q) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  if (editable === "wording" && q.status === "accepted") return q;
  if (editable && LOCKED.includes(q.status)) {
    throw new ORPCError("BAD_REQUEST", { message: "This quote is locked. Make a new version to change it." });
  }
  return q;
}

/**
 * The client's lines: supplier charge lines folded into that supplier's
 * product lines (notes 18.33, lib/charge-fold.ts), then any referral fee
 * spread over all of them (notes 18.47). Everything client facing reads its
 * lines through here.
 */
async function clientLines(quoteId: number) {
  const rows = await db
    .select({
      id: schema.quoteItems.id,
      kind: schema.quoteItems.kind,
      description: schema.quoteItems.description,
      productId: schema.quoteItems.productId,
      floorCategory: schema.quoteItems.floorCategory,
      qty: schema.quoteItems.qty,
      unit: schema.quoteItems.unit,
      unitPrice: schema.quoteItems.unitPrice,
      unitCost: schema.quoteItems.unitCost,
      total: schema.quoteItems.total,
      sortOrder: schema.quoteItems.sortOrder,
      productCategory: schema.products.category,
      soldAs: schema.products.soldAs,
      supplierId: schema.products.supplierId,
      chargeSupplierId: schema.quoteItems.chargeSupplierId,
      labourForItemId: schema.quoteItems.labourForItemId,
      followsItemId: schema.quoteItems.followsItemId,
    })
    .from(schema.quoteItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .where(eq(schema.quoteItems.quoteId, quoteId))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  // Notes 18.47: then the referral fee, spread over every line by its price. No fee line, no footer line.
  return foldFee(foldCharges(rows).lines, await quoteFee(quoteId)).lines;
}

/** Lines in the shape the bundle maths needs, with each product's category. */
export async function bundleLinesFor(quoteId: number): Promise<BundleLine[]> {
  const items = await clientLines(quoteId);
  return items.map((i) => ({
    id: i.id,
    kind: i.kind,
    description: i.description,
    productId: i.productId,
    floorCategory: i.floorCategory,
    total: i.total,
    sortOrder: i.sortOrder,
    productCategory: bundleCategoryOf(i.productCategory, i.soldAs),
    labourForItemId: i.labourForItemId,
    followsItemId: i.followsItemId,
  }));
}

/**
 * 188001 list item 2 changed the default section title ("X supply" when the
 * section has no install line). A quote that went out before that keeps the
 * title it went out with.
 */
export const TITLES_CHANGED_AT = new Date("2026-10-12T11:51:00Z");

type QuoteLike = {
  id: number;
  bundleMode: string;
  status?: string;
  layout?: string;
  sentAt?: Date | null;
  acceptedAt?: Date | null;
  createdAt?: Date | null;
};

function wentOutBeforeTitleChange(q: QuoteLike) {
  const when = q.sentAt ?? (q.status === "accepted" ? (q.acceptedAt ?? q.createdAt ?? null) : null);
  return !!when && when.getTime() < TITLES_CHANGED_AT.getTime();
}

/** One row per line for the itemised layout (item 1). The client sees these, so no cost. */
export async function itemRowsFor(quoteId: number): Promise<ItemRow[]> {
  return itemRows(await clientLines(quoteId));
}

/**
 * The bundles for a quote as the client would see them now, and the layout
 * the client gets (item 1). Itemised also returns the rows.
 */
export async function bundlesFor(quote: QuoteLike) {
  const [lines, saved] = await Promise.all([
    bundleLinesFor(quote.id),
    db.select().from(schema.quoteBundles).where(eq(schema.quoteBundles.quoteId, quote.id)),
  ]);
  const built = buildBundles(quote.bundleMode, lines, saved, { legacyTitles: wentOutBeforeTitleChange(quote) });
  // Accepted: the lines are fixed, so a fixed line description never makes the wording out of date.
  const bundles = quote.status === "accepted" ? built.map((b) => ({ ...b, stale: false })) : built;
  const layout = layoutUsed(quote.layout, lines);
  const items = layout === "itemised" ? await itemRowsFor(quote.id) : [];
  return { lines, bundles, layout, layoutSetting: quote.layout ?? "auto", items };
}

export async function saveBundle(
  quoteId: number,
  key: string,
  patch: { title?: string; wording?: string; wordingSource?: string; lineSignature?: string },
) {
  const values = { quoteId, bundleKey: key, title: "", wording: "", wordingSource: "", lineSignature: "", ...patch };
  await db
    .insert(schema.quoteBundles)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.quoteBundles.quoteId, schema.quoteBundles.bundleKey],
      set: { ...patch, updatedAt: new Date() },
    });
}

async function logActivity(quote: typeof schema.quotes.$inferSelect, action: string, detail: string, actor: { name: string; role: string }) {
  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: quote.id,
    action,
    detail,
    actorName: actor.name,
    actorRole: actor.role,
  });
}

const fullName = (c: { firstName: string; lastName: string } | null | undefined) =>
  c ? [c.firstName, c.lastName].filter(Boolean).join(" ").trim() : "";

/** Everything the client PDF needs. Bundles only: no line, qty, rate or cost leaves this function. */
/** Pay by card on the PDF: the deposit's pay link once accepted, else the quote's online link. */
async function cardPayForPdf(quote: typeof schema.quotes.$inferSelect) {
  if (!cardPaymentsOn() || !(quotePercent(quote) > 0)) return null;
  const dep = await depositInvoiceFor(quote.id);
  if (dep && owingOn(dep) > 0) return { url: payUrl(dep.id), note: `Pay deposit ${dep.number} online. No card surcharge.` };
  if (dep) return null;
  if (quote.status === "accepted") return null;
  const link = await linkForQuote(quote.id);
  return { url: quoteUrl(link.token), note: "Accept online, then pay your deposit by card. No card surcharge." };
}

async function jobBillsCompany(jobId: number | null, quoteType?: string | null) {
  if (quoteType) return quoteType === "company";
  if (!jobId) return false;
  const [job] = await db.select({ t: schema.jobs.billToType }).from(schema.jobs).where(eq(schema.jobs.id, jobId));
  return job?.t === "company";
}

export async function clientPdfFor(quoteId: number, signed?: QuotePdfInput["signed"]) {
  const quote = await quoteRow(quoteId, false);
  const [contact] = quote.contactId
    ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.contactId))
    : [];
  const [supervisor] = quote.supervisorContactId
    ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.supervisorContactId))
    : [];
  // Notes 18.54: the company on the paperwork follows the quote's Bill to.
  const companyId = billedCompanyId(quote);
  const [company] = companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)) : [];
  const [site] = quote.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId)) : [];
  const { bundles, layout, items } = await bundlesFor(quote);

  const person = supervisor ?? contact;
  const siteAddress = site
    ? [site.address, [site.suburb, site.state, site.postcode].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    : null;
  const isoDay = (d: Date) => todayISO(d);
  const { deposit, balance } = depositSplit(quote.total, quotePercent(quote));

  const ref = await quoteRefOf(quote);
  const pdf = await renderQuotePdf({
    number: quote.number,
    version: quote.version,
    ref,
    date: auDate(isoDay(quote.sentAt ?? new Date())),
    validUntil: quote.validUntil ? auDate(isoDay(quote.validUntil)) : null,
    to: {
      name: fullName(person) || company?.name || "Client",
      company: company?.name ?? null,
      address: company?.billingAddress || contact?.address || siteAddress,
      email: person?.email || company?.email || null,
      phone: person?.mobile || person?.phone || company?.phone || null,
    },
    siteAddress,
    bundles: bundles.map((b) => ({ title: b.title, wording: b.wording, total: b.total })),
    items: layout === "itemised" ? items.map((r) => ({ description: r.description, qty: r.qty, unit: r.unit, rate: r.rate, total: r.total })) : undefined,
    subtotal: quote.subtotal,
    gst: quote.gst,
    total: quote.total,
    depositPercent: quotePercent(quote),
    deposit,
    balance,
    cardPay: await cardPayForPdf(quote),
    showPosition: Boolean(company) || (await jobBillsCompany(quote.jobId, quote.billToType)) || Boolean(signed?.position?.trim()),
    signed: signed ?? null,
  });
  // Itemised: the client reads the rows, so section wording is not needed.
  const missing = layout === "itemised" ? [] : bundles.filter((b) => !b.wording.trim()).map((b) => b.title);
  const stale = layout === "itemised" ? [] : bundles.filter((b) => b.stale).map((b) => b.title);
  return {
    pdf,
    filename: signed ? `Terra Flooring Quote ${ref} signed.pdf` : `Terra Flooring Quote ${ref}.pdf`,
    ref,
    missing,
    stale,
  };
}

export const quoteBundles = {
  get: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const quote = await quoteRow(input.quoteId, false);
    const { bundles, layout, layoutSetting, items } = await bundlesFor(quote);
    return { mode: quote.bundleMode, bundles, layout, layoutSetting, items };
  }),

  /**
   * Item 1: Auto (itemised when supply only), Itemised or Sections. Locked
   * once accepted, the same as the bundle mode.
   */
  setLayout: staffOnly
    .input(z.object({ quoteId: z.number(), layout: z.enum(QUOTE_LAYOUTS) }))
    .handler(async ({ input, context }) => {
      const quote = await quoteRow(input.quoteId, true);
      if (quote.layout !== input.layout) {
        await db.update(schema.quotes).set({ layout: input.layout, updatedAt: new Date() }).where(eq(schema.quotes.id, quote.id));
        await logActivity(quote, "bundles", `Client layout set to ${LAYOUT_LABELS[input.layout]}`, context.actor);
      }
      const { bundles, layout, layoutSetting, items } = await bundlesFor({ ...quote, layout: input.layout });
      return { mode: quote.bundleMode, bundles, layout, layoutSetting, items };
    }),

  /** The client PDF. Warnings come back with it: sections with no wording, or wording written for other lines. */
  pdf: staffOnly.input(z.object({ quoteId: z.number() })).handler(async ({ input }) => {
    const { pdf, filename, missing, stale } = await clientPdfFor(input.quoteId);
    return { filename, base64: pdf.toString("base64"), missing, stale };
  }),

  /** Combined (one bundle) or split (one per floor type, plus extras). */
  setMode: staffOnly
    .input(z.object({ quoteId: z.number(), mode: z.enum(BUNDLE_MODES) }))
    .handler(async ({ input, context }) => {
      const quote = await quoteRow(input.quoteId, true);
      if (quote.bundleMode !== input.mode) {
        await db
          .update(schema.quotes)
          .set({ bundleMode: input.mode, updatedAt: new Date() })
          .where(eq(schema.quotes.id, quote.id));
        await logActivity(
          quote,
          "bundles",
          input.mode === "split" ? "Client view split by floor type" : "Client view combined into one",
          context.actor,
        );
      }
      return bundlesFor({ ...quote, bundleMode: input.mode });
    }),

  /** Put a line in a bundle by hand. Null goes back to automatic. */
  setLineCategory: staffOnly
    .input(z.object({ itemId: z.number(), floorCategory: z.enum(LINE_CATEGORIES).nullable() }))
    .handler(async ({ input }) => {
      const [item] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
      if (!item) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await quoteRow(item.quoteId, true);
      await db
        .update(schema.quoteItems)
        .set({ floorCategory: input.floorCategory, updatedAt: new Date() })
        .where(eq(schema.quoteItems.id, item.id));
      return bundlesFor(quote);
    }),

  /** Save wording or a title typed by hand. Marks the wording current. */
  update: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        key: z.string().min(1).max(40),
        title: z.string().max(200).optional(),
        wording: z.string().max(6000).optional(),
      }),
    )
    .handler(async ({ input }) => {
      const quote = await quoteRow(input.quoteId, "wording");
      const { bundles } = await bundlesFor(quote);
      const b = bundles.find((x) => x.key === input.key);
      if (!b) throw new ORPCError("BAD_REQUEST", { message: "That section is not on this quote." });
      const patch: Parameters<typeof saveBundle>[2] = {};
      // The default title (either form) is saved as blank, so it follows the lines.
      if (input.title !== undefined) {
        const t = input.title.trim();
        patch.title = t === BUNDLE_TITLES[input.key] || t === b.defaultTitle ? "" : t;
      }
      if (input.wording !== undefined) {
        // Ops may type meterage in on purpose. Only dashes are swapped out.
        patch.wording = input.wording.replace(/\s*[—–]\s*/g, ", ").trim();
        patch.wordingSource = patch.wording ? "manual" : "";
        patch.lineSignature = b.signature;
      }
      await saveBundle(quote.id, input.key, patch);
      return bundlesFor(quote);
    }),

  /** Have the AI write (or rewrite) one section's wording. */
  regenerate: staffOnly
    .input(z.object({ quoteId: z.number(), key: z.string().min(1).max(40), hint: z.string().max(500).optional() }))
    .handler(async ({ input, context }) => {
      const quote = await quoteRow(input.quoteId, "wording");
      const { lines, bundles } = await bundlesFor(quote);
      const b = bundles.find((x) => x.key === input.key);
      if (!b) throw new ORPCError("BAD_REQUEST", { message: "That section is not on this quote." });
      if (!b.lineIds.length) throw new ORPCError("BAD_REQUEST", { message: "Add some lines first." });
      const inBundle = lines.filter((l) => b.lineIds.includes(l.id));
      let wording: string;
      try {
        wording = await draftBundleWording({
          title: b.title,
          lines: inBundle,
          notes: quote.notes,
          hint: input.hint,
          current: input.hint ? b.wording : null,
        });
      } catch (e) {
        console.error("[bundles] wording failed", e);
        throw new ORPCError("BAD_GATEWAY", { message: "The AI could not write it just now. Try again." });
      }
      if (!wording) throw new ORPCError("BAD_GATEWAY", { message: "The AI came back empty. Try again." });
      await saveBundle(quote.id, b.key, { wording, wordingSource: "ai", lineSignature: b.signature });
      await logActivity(quote, "bundles", `AI wrote the wording for "${b.title}"`, context.actor);
      return bundlesFor(quote);
    }),
};

/** Copy bundle wording and line categories onto a new version of a quote. */
export async function copyBundles(fromQuoteId: number, toQuoteId: number) {
  const saved = await db.select().from(schema.quoteBundles).where(eq(schema.quoteBundles.quoteId, fromQuoteId));
  if (saved.length) {
    await db.insert(schema.quoteBundles).values(
      saved.map((s) => ({
        quoteId: toQuoteId,
        bundleKey: s.bundleKey,
        title: s.title,
        wording: s.wording,
        wordingSource: s.wordingSource,
        lineSignature: s.lineSignature,
        sortOrder: s.sortOrder,
      })),
    );
  }
}
