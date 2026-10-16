import { assertBillable } from "../lib/callbacks";
import { convertQuoteToJob, createJobForQuote, fillJobFromQuote } from "../lib/quote-convert";
import { acceptQuote } from "../lib/quote-accept";
import { latestQuoteOnJob, quoteDefaultsForJob, quoteStartForJob } from "../lib/quote-for-job";
import { rebuildForecast } from "../lib/cashflow";
import { DELIVERY, isDeliveryText, lineTypeOfKind } from "../lib/line-kinds";
import { quoteNumberFor, quoteRefById, quoteRefOf } from "../lib/quote-number";
import { parseQuoteRef, quoteRef } from "../lib/refs";
import { jobNumberSql } from "../lib/job-ref";
import { z } from "zod";
import { assertSupervisor } from "../lib/supervisors";
import { and, asc, desc, eq, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly, type Actor } from "../middleware/auth";
import { markupOf, markupPctUsed, sellAtMarkup } from "../lib/pricing";
import { depositSplit, quotePercent } from "../lib/deposits";
import {
  assertBillToReady,
  assertCard,
  billToFields,
  billToInput,
  cardOf,
  defaultQuoteBillTo,
  depositFieldsFor,
  quoteBillTo,
  quoteBillToPatch,
} from "../lib/bill-to";
import { liveSellFor } from "../lib/live-sell";
import { assertNoAcceptedQuote } from "../lib/variations";
import { suggestProducts } from "../agent/price";
import { customerCandidates, SAID_DETAILS_NOTE, spokenForQuote, UNMATCHED_NOTE } from "../lib/quote-customer";
import { forgetNames } from "../lib/memo-context";
import { normaliseMobile } from "../lib/sms";
import { createContact } from "./contacts";
import { bundlesFor, copyBundles } from "./quoteBundles";
import { leadToQuotedOnSend } from "../lib/job-stage";
import { addJobPerson, addQuotePerson, copyQuotePeople, personInput } from "../lib/job-people";
import { UNSET_SOURCE } from "../lib/lead-codes";
import { syncJobValue, syncJobValueFromQuote } from "../lib/job-value";
import { floorQty, floorTypeOf, isInstallFlag, isOwnFlag, NO_WIDTH_FLAG } from "../lib/flooring-qty";
import {
  addLinkedLabour,
  followLinkedLabour,
  installFor,
  lineAreas,
  nextFlag,
  nextSortOrder,
  qtyFlag,
  qtyForLine,
  standardLabour,
  wastageDefaultFor,
} from "../lib/quote-labour";
import { floorLineFor, followsAFloor, followUnderlay, lineSizes, refollow, sizeFlag, startLine, wholeUnits } from "../lib/quote-sizes";
import { isUnderlayCategory, underlayName } from "../lib/order-sizes";
import { foldForClient, quoteFreightView, refreshQuoteFreight, supplierChargesMarkupPct } from "../lib/quote-freight";
import { isChargeLine } from "../lib/charge-fold";
import { fromPhoneApp, PHONE_PRICE_MESSAGE } from "../lib/phone-app";
import { copyLinksFor } from "../lib/quote-copy-links";
import { feeOnQuoteRecalc } from "../lib/referral-fees";
import { feeForStaff, feeLinesForStaff, typedPriceWithoutFee } from "../lib/referral-quote-view";

/**
 * Quotes are for Admin and Office. Field crew must never reach any procedure
 * in this file. Cost and margin figures are hidden from anyone whose actor has
 * canSeeCosts false, and only an Admin can set a unit cost.
 *
 * Money rules: line total = qty × unitPrice. Subtotal is the sum of lines,
 * GST is 10% (Australia), total = subtotal + gst. Every write recalculates the
 * header from the lines so the two can never drift apart.
 */

const GST_RATE = 0.1;

/** Labour, prep and removal lines are Labour. Delivery is Delivery (188001 list item 6). Everything else is Material. */
export const lineTypeOf = lineTypeOfKind;

export const DISCOUNT_LIMIT_KEY = "office_discount_limit_percent";

/** Office can discount a quote up to this % without Admin approval. Default 5. */
export async function discountLimit(): Promise<number> {
  const [r] = await db.select().from(schema.settings).where(eq(schema.settings.key, DISCOUNT_LIMIT_KEY));
  const n = r ? Number(r.value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

/** Overall discount % on a quote: how far hand-edited lines sit below the price book price. */
export function discountPercentOf(items: { qty: number; unitPrice: number; listUnitPrice: number | null }[]): number {
  let list = 0;
  let off = 0;
  for (const i of items) {
    // A credit or minus line is a discount too, so it cannot slip past the limit.
    const listAmount = Math.max(0, (i.listUnitPrice ?? i.unitPrice) * i.qty);
    const sellAmount = i.unitPrice * i.qty;
    list += listAmount;
    off += Math.max(0, listAmount - sellAmount);
  }
  return list > 0 ? Math.round((off / list) * 10000) / 100 : 0;
}

/**
 * 188001 list item 5: a line priced by markup that sits under the price list
 * sell is "markup below standard", not a hand discount. Standard is the
 * markup the price list sell works out at on this cost, to the whole percent.
 * Older lines with no price_by count as markup priced when their stored
 * markup is not the one worked back from the price (a typed price always
 * stores the worked back one).
 */
export function markupBelowStandard(i: {
  unitPrice: number;
  unitCost: number | null;
  markupPercent: number | null;
  listUnitPrice: number | null;
  priceBy?: string | null;
}): { markup: number; standard: number } | null {
  if (i.listUnitPrice == null || i.unitCost == null || i.unitCost <= 0 || i.markupPercent == null) return null;
  if (i.unitPrice >= i.listUnitPrice - 0.005) return null;
  const byMarkup = i.priceBy === "markup" || (!i.priceBy && i.markupPercent !== markupOf(i.unitCost, i.unitPrice));
  if (!byMarkup) return null;
  return { markup: Math.round(i.markupPercent * 10) / 10, standard: Math.round((i.listUnitPrice / i.unitCost - 1) * 100) };
}

/** How the quote sits under the price list: all markup lines, all hand discounts, or both. */
export function belowListKind(items: Parameters<typeof markupBelowStandard>[0][]): "markup" | "discount" | "mixed" | null {
  const under = items.filter((i) => i.listUnitPrice != null && i.unitPrice < i.listUnitPrice - 0.005);
  if (!under.length) return null;
  const m = under.filter((i) => markupBelowStandard(i)).length;
  return m === under.length ? "markup" : m === 0 ? "discount" : "mixed";
}

/** Append one history row per product line on this quote. Called when the quote is sent. */
export async function recordPriceHistory(quote: typeof schema.quotes.$inferSelect, byName: string) {
  const lines = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id));
  const already = await db
    .select({ itemId: schema.quotePriceHistory.quoteItemId, unitPrice: schema.quotePriceHistory.unitPrice, unit: schema.quotePriceHistory.unit })
    .from(schema.quotePriceHistory)
    .where(eq(schema.quotePriceHistory.quoteId, quote.id));
  const seen = new Set(already.map((h) => `${h.itemId}|${h.unitPrice}|${h.unit}`));
  // Sending the same quote twice does not write the same price twice.
  const priced = lines.filter((l) => l.productId && l.unitPrice > 0 && !seen.has(`${l.id}|${l.unitPrice}|${l.unit}`));
  if (!priced.length) return;
  await db.insert(schema.quotePriceHistory).values(
    priced.map((l) => ({
      quoteId: quote.id,
      quoteItemId: l.id,
      productId: l.productId,
      contactId: quote.contactId,
      companyId: quote.companyId,
      supervisorContactId: quote.supervisorContactId,
      unit: l.unit,
      unitPrice: l.unitPrice,
      quotedByName: byName,
      source: "quote",
    })),
  );
}

/** Recalculate a quote header from its own line items. Returns the new totals.
 *  Exported for the voice quote pipeline, which inserts lines directly and
 *  then needs the same header maths this file already does. */
export async function recalc(quoteId: number) {
  // Notes 18.33: the supplier charge lines (freight and fees) are put right first.
  await refreshQuoteFreight(quoteId);
  const items = await db
    .select({ total: schema.quoteItems.total })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId));

  const lineSum = round2(items.reduce((sum, i) => sum + (i.total ?? 0), 0));
  // Notes 18.47: a referral fee goes on top of the lines, never in them.
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quoteId));
  const fee = q ? await feeOnQuoteRecalc(q, lineSum) : 0;
  const subtotal = round2(lineSum + fee);
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);

  await db
    .update(schema.quotes)
    .set({ subtotal, gst, total, updatedAt: new Date() })
    .where(eq(schema.quotes.id, quoteId));
  // A job made by this quote shows its total until a quote is accepted (Damien, 16 Oct).
  await syncJobValueFromQuote(quoteId);

  return { subtotal, gst, total };
}

/**
 * "Andes Peak in Merida", the way it reads on the customer's quote. Underlay
 * reads "Carpetmate Standard underlay" (fix list 11 Oct, item 3).
 */
export function productLineName(p: { brand: string | null; range: string | null; colour: string | null; category?: string | null }) {
  if (isUnderlayCategory(p.category)) return underlayName(p);
  const named = [p.brand, p.range].filter(Boolean).join(" ");
  return p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named;
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function quoteOrThrow(id: number) {
  const [row] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  return row;
}

/** Wording typed on an accepted quote: trimmed, and long dashes swapped for a comma. */
export function cleanWording(text: string) {
  return text.replace(/\s*[\u2013\u2014]\s*/g, ", ").trim();
}

/** Accepted, declined, expired and cancelled quotes are history. Change them by making a new version. */
const LOCKED_STATUSES = ["accepted", "declined", "expired", "replaced", "cancelled"];
export async function editableQuoteOrThrow(id: number) {
  const quote = await quoteOrThrow(id);
  if (LOCKED_STATUSES.includes(quote.status)) {
    throw new ORPCError("BAD_REQUEST", { message: "This quote is locked. Make a new version to change it." });
  }
  return quote;
}

type DiscountLine = { id?: number; qty: number; unitPrice: number; listUnitPrice: number | null };

/** Office cannot edit past the discount limit, or past what an Admin approved. Admin can edit. */
async function assertDiscountAllowed(quote: typeof schema.quotes.$inferSelect, items: DiscountLine[], actor: Actor) {
  if (actor.role === "admin") return;
  const pct = discountPercentOf(items);
  const limit = await discountLimit();
  if (pct > limit && pct > quote.discountApprovedPercent) {
    throw new ORPCError("FORBIDDEN", {
      message: `This quote is discounted ${pct}%. Office can go up to ${limit}%. An Admin needs to approve it first.`,
    });
  }
}

/**
 * The checks every path to a customer goes through: Send, Accept and Convert
 * to job. 188001 list item 5: a discount over the limit that nobody approved
 * stops it for everyone, Admin too. Admin approves with one tap, then sends.
 */
export async function assertReadyToGoOut(quote: typeof schema.quotes.$inferSelect, actor: Actor) {
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id));
  // Copy from previous job (16 Oct): every copied m2, lm and labour line is confirmed or edited first.
  const toCheck = items.filter((i) => i.checkRequired).length;
  if (toCheck) {
    throw new ORPCError("BAD_REQUEST", {
      message: `${toCheck} copied line${toCheck === 1 ? "" : "s"} still say${toCheck === 1 ? "s" : ""} Check required. Confirm or edit each one first.`,
    });
  }
  if (!quote.contactId && !quote.companyId) {
    throw new ORPCError("BAD_REQUEST", { message: "Pick who this quote is for first." });
  }
  // Notes 18.54: who pays, and their deposit %, before anything goes out.
  await assertBillToReady(quote);
  const pct = discountPercentOf(items);
  const limit = await discountLimit();
  if (pct > limit && pct > quote.discountApprovedPercent) {
    const what = belowListKind(items) === "markup" ? `priced ${pct}% under the price list (markup below standard)` : `discounted ${pct}%`;
    throw new ORPCError("FORBIDDEN", {
      message:
        actor.role === "admin"
          ? `This quote is ${what}, over the ${limit}% limit. Approve it first, then send.`
          : `This quote is ${what}. Office can go up to ${limit}%. An Admin needs to approve it first.`,
    });
  }
}

/** A quote that has gone out cannot be edited past the discount Office is allowed. */
async function assertSentEditAllowed(
  quote: typeof schema.quotes.$inferSelect,
  change: DiscountLine,
  actor: Actor,
) {
  if (quote.status !== "sent" || actor.role === "admin") return;
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id));
  const next = change.id ? items.map((i) => (i.id === change.id ? { ...i, ...change } : i)) : [...items, change];
  await assertDiscountAllowed(quote, next, actor);
}

/** Cost is never sent to someone who is not allowed to see it. */
function hideCost<T extends { unitCost: number | null; markupPercent: number | null; freightUnitCost?: number | null }>(row: T | undefined, actor: Actor): T | undefined {
  return row && !actor.canSeeCosts ? { ...row, unitCost: null, markupPercent: null, freightUnitCost: null } : row;
}

export const createQuoteInput = z.object({
  jobId: z.number().nullable().optional(),
  contactId: z.number().nullable().optional(),
  companyId: z.number().nullable().optional(),
  /** Required when companyId is set. */
  supervisorContactId: z.number().nullable().optional(),
  /** Job contacts beyond the customer and supervisor. They go on the job's list of people. */
  people: z.array(personInput).max(20).default([]),
  /**
   * New quote on the Quotes page (item 7): make the job in the same step, so
   * the quote and the job share one number and one list of people.
   */
  makeJob: z.boolean().default(false),
  /** Where the job came from. Required with makeJob, same as New job. */
  source: z.string().trim().optional(),
  siteId: z.number().nullable().optional(),
  /** Who pays (notes 18.54). Left out: the job's Bill to, else the company, else the person. */
  billTo: billToInput.nullable().optional(),
  /** Left out, it comes off the Bill to's card. Typed, it is for this quote only. */
  depositPercent: z.number().min(0).max(100).optional(),
  validDays: z.number().int().min(1).max(365).default(30),
  notes: z.string().nullable().optional(),
  terms: z.string().nullable().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().nullable().optional(),
        kind: z.string().default("supply"),
        description: z.string().min(1),
        qty: z.number().default(1),
        unit: z.string().default("m2"),
        unitPrice: z.number().default(0),
        unitCost: z.number().nullable().optional(),
        flagged: z.boolean().default(false),
        flagReason: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

/** Make a draft quote. New quote on the Quotes page and Create quote on the job page both come here. */
export async function createQuoteRecord(
  input: z.infer<typeof createQuoteInput>,
  actor: Actor,
  /**
   * Copy from previous job (16 Oct). waitForClient: a copy for another client
   * waits with nobody on it, and its job is made when the client is picked
   * (setCustomer). noAccessNotes: the job starts with no access notes.
   */
  opts: { waitForClient?: boolean; noAccessNotes?: boolean } = {},
) {
  if (input.makeJob && !input.jobId && !input.source) {
    throw new ORPCError("BAD_REQUEST", { message: "Pick where the job came from. Unknown is fine." });
  }
  await assertBillable(input.jobId);
  // Item 12 and 188001 item 7: a job with an accepted quote never gets another quote.
  if (input.jobId) await assertNoAcceptedQuote({ jobId: input.jobId });
  await assertSupervisor(input.companyId, input.supervisorContactId);
  // The job's own number, or the next job number when there is no job yet.
  const { number, version } = await quoteNumberFor(input.jobId);

  const [settingRow] = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, "quote_terms"));

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + input.validDays);
  // Notes 18.54: the Bill to's card gives the %. A card with no % waits (source none).
  const billTo = input.billTo ?? (await defaultQuoteBillTo({ jobId: input.jobId, companyId: input.companyId, contactId: input.contactId }));
  const card = billTo ? await assertCard(billTo) : null;

  const [row] = await db
    .insert(schema.quotes)
    .values({
      number,
      version,
      jobId: input.jobId ?? null,
      contactId: input.contactId ?? null,
      companyId: input.companyId ?? null,
      supervisorContactId: input.companyId ? (input.supervisorContactId ?? null) : null,
      siteId: input.siteId ?? null,
      status: "draft",
      ...billToFields(billTo),
      ...depositFieldsFor(card, input.depositPercent),
      validUntil,
      notes: input.notes ?? null,
      terms: input.terms ?? settingRow?.value ?? null,
    })
    .returning();

  if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Quote not created" });

  if (input.items.length) {
    // A price book product typed in at a lower price is still a discount off the price book.
    const listPrices = await Promise.all(
      input.items.map(async (item) => {
        if (item.productId == null) return null;
        const [product] = await db.select().from(schema.products).where(eq(schema.products.id, item.productId));
        if (!product) return null;
        const sell = await liveSellFor(product);
        return sell !== item.unitPrice ? sell : null;
      }),
    );
    await db.insert(schema.quoteItems).values(
      input.items.map((item, i) => ({
        quoteId: row.id,
        productId: item.productId ?? null,
        kind: item.kind,
        lineType: lineTypeOf(item.kind),
        description: item.description,
        qty: item.qty,
        unit: item.unit,
        unitPrice: item.unitPrice,
        listUnitPrice: listPrices[i] ?? null,
        unitCost: actor.role === "admin" ? (item.unitCost ?? null) : null,
        markupPercent: actor.role === "admin" ? markupOf(item.unitCost, item.unitPrice) : null,
        total: round2(item.qty * item.unitPrice),
        sortOrder: i,
        flagged: item.flagged,
        flagReason: item.flagReason ?? null,
      })),
    );
  }

  for (const p of input.people) {
    if (p.tags.includes("supervisor")) continue; // the supervisor comes only through supervisorContactId
    // A quote on a job keeps its people on the job: one list, not two.
    if (input.jobId) await addJobPerson(input.jobId, p.contactId, p);
    else await addQuotePerson(row.id, p.contactId, p);
  }

  const totals = await recalc(row.id);

  // New quote: the job is made now, at Lead, with the quote's number and people.
  // A quote never stands without its job (Damien, 16 Oct), so any caller
  // that left out both the job and makeJob gets one too, source Unknown.
  let jobId = input.jobId ?? null;
  if (!jobId && !opts.waitForClient) {
    const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, row.id));
    const { job } = await createJobForQuote(fresh ?? row, { source: input.source || UNSET_SOURCE, noAccessNotes: opts.noAccessNotes });
    jobId = job.id;
    await db.insert(schema.activityLog).values({
      jobId,
      contactId: input.contactId ?? null,
      entityType: "job",
      entityId: jobId,
      action: "created",
      detail: `Job made with quote ${await quoteRefById(row.id)}`,
      actorName: actor.name,
      actorRole: actor.role,
    });
  }

  await db.insert(schema.activityLog).values({
    jobId,
    contactId: input.contactId ?? null,
    entityType: "quote",
    entityId: row.id,
    action: "created",
    detail: `Quote ${await quoteRefById(row.id)} created`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  return { ...row, jobId, ...totals };
}

/** The next version of a quote, lines, bundles and people copied. The deposit can be set for the new version. */
export async function reviseQuoteRecord(
  quote: typeof schema.quotes.$inferSelect,
  actor: Actor,
  opts: { depositPercent?: number } = {},
) {
  await assertBillable(quote.jobId);
  if (quote.status === "cancelled") {
    throw new ORPCError("BAD_REQUEST", { message: "This quote was cancelled with its job. Start a new quote for the client instead." });
  }
  // Item 12: after acceptance, only variations.
  await assertNoAcceptedQuote({ number: quote.number, jobId: quote.jobId });
  const items = await db
    .select()
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quote.id))
    .orderBy(asc(schema.quoteItems.sortOrder));

  const [maxRow] = await db
    .select({ max: sql<number>`coalesce(max(${schema.quotes.version}), 1)` })
    .from(schema.quotes)
    .where(eq(schema.quotes.number, quote.number));
  const revBillTo = quoteBillTo(quote) ?? (await defaultQuoteBillTo({ jobId: quote.jobId, companyId: quote.companyId, contactId: quote.contactId }));
  const revCard = revBillTo ? await cardOf(revBillTo) : null;

  const [row] = await db
    .insert(schema.quotes)
    .values({
      number: quote.number,
      version: Number(maxRow?.max ?? 1) + 1,
      jobId: quote.jobId,
      contactId: quote.contactId,
      companyId: quote.companyId,
      supervisorContactId: quote.supervisorContactId,
      siteId: quote.siteId,
      status: "draft",
      // Notes 18.54: a new version keeps its Bill to and takes the card's % (or the one typed now).
      ...billToFields(revBillTo),
      ...depositFieldsFor(revCard, opts.depositPercent),
      validUntil: quote.validUntil,
      notes: quote.notes,
      terms: quote.terms,
      bundleMode: quote.bundleMode,
      layout: quote.layout,
      copiedFromQuoteId: quote.copiedFromQuoteId,
    })
    .returning();

  if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Revision not created" });

  if (items.length) {
    const copied = await db
      .insert(schema.quoteItems)
      .values(
        items.map((i, idx) => ({
          quoteId: row.id,
          productId: i.productId,
          kind: i.kind,
          lineType: i.lineType,
          description: i.description,
          qty: i.qty,
          unit: i.unit,
          unitPrice: i.unitPrice,
          listUnitPrice: i.listUnitPrice,
          unitCost: i.unitCost,
          markupPercent: i.markupPercent,
          priceBy: i.priceBy,
          total: i.total,
          floorCategory: i.floorCategory,
          sortOrder: idx,
          measuredM2: i.measuredM2,
          wastagePct: i.wastagePct,
          rollWidthM: i.rollWidthM,
          rateItemId: i.rateItemId,
          freightUnitCost: i.freightUnitCost,
          chargeSupplierId: i.chargeSupplierId,
          chargeKey: i.chargeKey,
          chargeTyped: i.chargeTyped,
          // A copied line still to check stays to check on the next version.
          checkRequired: i.checkRequired,
          ...(isChargeLine(i) ? { flagged: i.flagged, flagReason: i.flagReason } : {}),
        })),
      )
      .returning({ id: schema.quoteItems.id, sortOrder: schema.quoteItems.sortOrder });
    // Item 8 and fix list item 3: installs and underlay stay linked to their own floor line on the new version.
    // Item 8: each install stays linked to its own product line on the new version.
    const newIdAt = new Map(copied.map((c) => [c.sortOrder, c.id]));
    const newIdFor = new Map(items.map((i, idx) => [i.id, newIdAt.get(idx)]));
    for (const [idx, i] of items.entries()) {
      const self = newIdAt.get(idx);
      const parent = i.labourForItemId != null ? newIdFor.get(i.labourForItemId) : undefined;
      const floor = i.followsItemId != null ? newIdFor.get(i.followsItemId) : undefined;
      if (self && (parent || floor)) {
        await db
          .update(schema.quoteItems)
          .set({ ...(parent ? { labourForItemId: parent } : {}), ...(floor ? { followsItemId: floor } : {}) })
          .where(eq(schema.quoteItems.id, self));
      }
    }
  }

  await copyBundles(quote.id, row.id);
  // A quote on a job reads the job's people, so there is nothing to copy.
  if (!quote.jobId) await copyQuotePeople(quote.id, row.id);
  const totals = await recalc(row.id);

  await db.insert(schema.activityLog).values({
    jobId: quote.jobId,
    contactId: quote.contactId,
    entityType: "quote",
    entityId: row.id,
    action: "revised",
    detail: `Quote ${await quoteRefOf(row)} created from ${await quoteRefOf(quote)}`,
    actorName: actor.name,
    actorRole: actor.role,
  });

  return { ...row, ...totals };
}

export const quotes = {
  list: staffOnly
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.string().optional(),
          contactId: z.number().optional(),
          companyId: z.number().optional(),
          jobId: z.number().optional(),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ limit: 200 }),
    )
    .handler(async ({ input }) => {
      const where = [];
      if (input.status) where.push(eq(schema.quotes.status, input.status));
      if (input.contactId) where.push(eq(schema.quotes.contactId, input.contactId));
      if (input.companyId) where.push(eq(schema.quotes.companyId, input.companyId));
      if (input.jobId) where.push(eq(schema.quotes.jobId, input.jobId));
      if (input.search) {
        const q = `%${input.search.toLowerCase()}%`;
        // "Q188000-2" finds quote 188000. A bare number finds the quote with it.
        const asQuote = parseQuoteRef(input.search);
        const asNumber = asQuote ? asQuote.number : Number(input.search.match(/\d+/)?.[0] ?? "");
        where.push(
          or(
            like(sql`lower(coalesce(${schema.sites.address}, ''))`, q),
            like(sql`lower(coalesce(${schema.contacts.firstName} || ' ' || ${schema.contacts.lastName}, ''))`, q),
            like(sql`lower(coalesce(${schema.companies.name}, ''))`, q),
            Number.isFinite(asNumber) && asNumber > 0 ? eq(schema.quotes.number, asNumber) : sql`0`,
          ),
        );
      }

      const rows = await db
        .select({
          quote: schema.quotes,
          contact: schema.contacts,
          company: schema.companies,
          site: schema.sites,
          job: { id: schema.jobs.id, number: jobNumberSql },
          itemCount: sql<number>`(select count(*) from quote_items qi where qi.quote_id = quotes.id)`,
        })
        .from(schema.quotes)
        .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
        .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
        .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.quotes.jobId))
        .where(where.length ? and(...where) : undefined)
        .orderBy(desc(schema.quotes.number), desc(schema.quotes.version))
        .limit(input.limit);

      return rows.map((r) => ({
        ...r.quote,
        ref: quoteRef(r.quote.number, r.quote.version, r.job?.id ? r.job.number : null),
        contact: r.contact,
        company: r.company,
        site: r.site,
        job: r.job?.id ? r.job : null,
        itemCount: Number(r.itemCount ?? 0),
      }));
    }),

  get: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const [row] = await db
      .select({
        quote: schema.quotes,
        contact: schema.contacts,
        company: schema.companies,
        site: schema.sites,
        job: { id: schema.jobs.id, number: jobNumberSql, title: schema.jobs.title },
      })
      .from(schema.quotes)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
      .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.quotes.jobId))
      .where(eq(schema.quotes.id, input.id));

    if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });

    const [items, activity, versions, bundleView] = await Promise.all([
      db
        .select()
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.id))
        .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id)),
      db
        .select()
        .from(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "quote"), eq(schema.activityLog.entityId, input.id)))
        .orderBy(desc(schema.activityLog.createdAt))
        .limit(50),
      db
        .select({
          id: schema.quotes.id,
          version: schema.quotes.version,
          status: schema.quotes.status,
          total: schema.quotes.total,
          createdAt: schema.quotes.createdAt,
        })
        .from(schema.quotes)
        .where(eq(schema.quotes.number, row.quote.number))
        .orderBy(desc(schema.quotes.version)),
      bundlesFor(row.quote),
    ]);
    const freightIncluded = context.actor.canSeeCosts ? await quoteFreightView(row.quote.id) : null;
    // Copy from previous job (16 Oct): where this one came from, and the copies made from it.
    const copyLinks = await copyLinksFor(row.quote);

    const cost = items.reduce((sum, i) => sum + (i.unitCost ?? 0) * (i.qty ?? 0), 0);
    const showCosts = context.actor.canSeeCosts;
    // Notes 18.47: the referral fee. An Admin reads it as its own line. Everyone else has it spread into the lines.
    const fee = await feeForStaff(row.quote.id, context.actor);
    // Notes 18.33: no cost, no supplier charge lines. Their sell sits in the supplier's lines, as on the client copy.
    const shown = feeLinesForStaff(showCosts ? items : (await foldForClient(items)).lines, fee, context.actor);
    const mine = context.actor.role === "admin" ? items : shown;
    const areas = await lineAreas(items);
    const sizes = await lineSizes(items);
    const limit = await discountLimit();
    const discountPercent = discountPercentOf(items);
    // Item 5: waiting on approval stops Send for everyone, Admin too.
    const needsApproval = discountPercent > limit && discountPercent > row.quote.discountApprovedPercent;

    const jobRefText = row.job?.id ? row.job.number : null;
    return {
      ...row.quote,
      ref: quoteRef(row.quote.number, row.quote.version, jobRefText),
      discountPercent,
      discountLimit: limit,
      discountNeedsApproval: needsApproval,
      discountKind: belowListKind(items),
      costsHidden: !showCosts,
      contact: row.contact,
      company: row.company,
      site: row.site,
      job: row.job?.id ? row.job : null,
      items: showCosts
        ? mine.map((i) => ({ ...i, markupPercent: i.markupPercent ?? markupOf(i.unitCost, i.unitPrice), belowStandard: markupBelowStandard(i), area: areas[i.id] ?? null, size: sizes[i.id] ?? null }))
        : shown.map((i) => ({ ...i, unitCost: null, markupPercent: null, freightUnitCost: null, belowStandard: null, area: areas[i.id] ?? null, size: sizes[i.id] ?? null })),
      ...depositSplit(row.quote.total, quotePercent(row.quote)),
      /** Notes 18.54: who pays this quote and the % on their card. */
      billToCard: await cardOf(quoteBillTo(row.quote)),
      activity,
      versions: versions.map((v) => ({ ...v, ref: quoteRef(row.quote.number, v.version, jobRefText) })),
      copiedFrom: copyLinks.from,
      copies: copyLinks.copies,
      /** What the client sees: titles, wording and totals only. */
      bundles: bundleView.bundles,
      /** Item 1: the layout the client gets now, and the rows when itemised. */
      layoutUsed: bundleView.layout,
      itemRows: bundleView.items,
      /** Only for Admin, or Office with the cost switch on. Never expose these through field.ts. */
      estimatedCost: showCosts ? round2(cost) : null,
      /** Notes 18.33: the supplier charge lines per supplier, and what the client copy spreads. Cost viewers only. */
      freightIncluded,
      /** Settings, Business rules. What the charge lines sell at over cost. Cost viewers only. */
      supplierChargesPct: showCosts ? await supplierChargesMarkupPct() : null,
      // The fee is on top, so Terra's margin is on the price before it (notes 18.47).
      estimatedMargin: showCosts ? round2(row.quote.subtotal - fee.adminAmount - cost) : null,
      estimatedMarginPercent: !showCosts ? null : row.quote.subtotal - fee.adminAmount > 0 ? round2(((row.quote.subtotal - fee.adminAmount - cost) / (row.quote.subtotal - fee.adminAmount)) * 100) : 0,
      /** Admin only: "Referral fee: Fix A Tile, 5%, $500.00", its own line on the internal view. Null for everyone else. */
      referralFee: fee.view,
    };
  }),

  create: staffOnly
    .input(createQuoteInput)
    .handler(({ input, context }) => createQuoteRecord(input, context.actor)),

  /** What Create quote on the job page offers: open the draft, copy the latest, or start blank. */
  jobStart: staffOnly.input(z.object({ jobId: z.number() })).handler(({ input }) => quoteStartForJob(input.jobId)),

  /** Create quote on the job page. Takes the job's number and people. */
  createForJob: staffOnly
    .input(
      z.object({
        jobId: z.number(),
        from: z.enum(["blank", "copy"]),
        /** Who pays (notes 18.54). Left out: the job's Bill to, or the copied version's. */
        billTo: billToInput.optional(),
        /** Left out: the Bill to's card %. Typed, it is for this quote only. */
        depositPercent: z.number().min(0).max(100).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.from === "copy") {
        const latest = await latestQuoteOnJob(input.jobId);
        if (!latest) throw new ORPCError("BAD_REQUEST", { message: "There is no quote on this job to copy yet. Start a blank one." });
        const rev = await reviseQuoteRecord(latest, context.actor, { depositPercent: input.depositPercent });
        // A different payer picked for the copy: its card gives the % unless one was typed.
        const old = quoteBillTo(latest);
        if (input.billTo && (input.billTo.type !== old?.type || input.billTo.id !== old?.id)) {
          return { ...rev, ...(await quoteBillToPatch(rev.id, input.billTo, input.depositPercent, true)) };
        }
        return rev;
      }
      await assertNoAcceptedQuote({ jobId: input.jobId });
      const d = await quoteDefaultsForJob(input.jobId);
      return createQuoteRecord(
        createQuoteInput.parse({
          jobId: input.jobId,
          contactId: d.contactId,
          companyId: d.companyId,
          supervisorContactId: d.supervisorContactId,
          siteId: d.siteId,
          billTo: input.billTo,
          depositPercent: input.depositPercent,
        }),
        context.actor,
      );
    }),

  update: staffOnly
    .input(
      z.object({
        id: z.number(),
        jobId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        supervisorContactId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        status: z.enum(["draft", "needs_review", "sent", "accepted", "declined", "expired"]).optional(),
        /** Typed for this quote only, unless it matches the card (notes 18.54). */
        depositPercent: z.number().min(0).max(100).optional(),
        /** Who pays this quote (notes 18.54). A draft takes the new card's %. */
        billTo: billToInput.optional(),
        /** Follow the Bill to's card % again after one was typed. */
        depositFromCard: z.boolean().optional(),
        validUntil: z.date().nullable().optional(),
        notes: z.string().nullable().optional(),
        terms: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      if (input.jobId) await assertBillable(input.jobId);
      const { id, billTo, depositFromCard, depositPercent, ...rest } = input;
      const current = await quoteOrThrow(id);
      if (rest.status === "sent" || rest.status === "accepted") {
        throw new ORPCError("BAD_REQUEST", { message: "Use Send or Accepted on the quote, so the checks run." });
      }
      if (current.status === "accepted") {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is accepted and locked. Make a new version to change it." });
      }
      // The job and its quote share one number, so a quote cannot be moved to
      // another job. Make a new quote on that job instead.
      if (rest.jobId !== undefined && (rest.jobId ?? null) !== current.jobId) {
        const [target] = rest.jobId
          ? await db.select({ number: schema.jobs.number }).from(schema.jobs).where(eq(schema.jobs.id, rest.jobId))
          : [];
        if (!target || target.number !== current.number) {
          throw new ORPCError("BAD_REQUEST", {
            message: "A quote keeps its job's number, so it can't move to another job. Make a new quote on that job.",
          });
        }
      }
      const onlyStatus =
        Object.entries(rest).every(([k, v]) => k === "status" || v === undefined) && billTo === undefined && depositPercent === undefined && !depositFromCard;
      if (LOCKED_STATUSES.includes(current.status) && !onlyStatus) {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is locked. Make a new version to change it." });
      }
      const touchesWho = rest.companyId !== undefined || rest.supervisorContactId !== undefined;
      if (touchesWho) {
        const companyId = rest.companyId !== undefined ? rest.companyId : current.companyId;
        let supervisorId = rest.supervisorContactId !== undefined ? rest.supervisorContactId : current.supervisorContactId;
        // Moving the quote to another company drops a supervisor who is not in it.
        if (rest.companyId !== undefined && rest.companyId !== current.companyId && rest.supervisorContactId === undefined) {
          supervisorId = null;
          rest.supervisorContactId = null;
        }
        if (!companyId) rest.supervisorContactId = null;
        else if (supervisorId) await assertSupervisor(companyId, supervisorId);
      }
      let [row] = await db
        .update(schema.quotes)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.quotes.id, id))
        .returning();
      // Notes 18.54: the Bill to and its %. A quote with nobody billed yet bills who it is now for.
      const own = quoteBillTo(current);
      const fill = !own && (rest.companyId || rest.contactId) ? { type: rest.companyId ? "company" : "contact", id: (rest.companyId ?? rest.contactId)! } as const : null;
      if (billTo || fill || depositPercent !== undefined || depositFromCard) {
        row = await quoteBillToPatch(id, billTo ?? fill ?? own, depositPercent, depositFromCard);
      }
      // A job made with the quote takes the customer, company and site it is missing.
      const touchesJob = rest.contactId !== undefined || rest.companyId !== undefined || rest.supervisorContactId !== undefined || rest.siteId !== undefined;
      if (row?.jobId && touchesJob) await fillJobFromQuote(row.id);
      // Notes 18.53: every save keeps the job's value on its quote, whatever changed.
      if (row?.jobId) await syncJobValue(row.jobId);
      if (current.jobId && current.jobId !== row?.jobId) await syncJobValue(current.jobId);
      return row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const quote = await quoteOrThrow(input.id);
    if (quote.status === "accepted" || quote.status === "replaced" || quote.status === "cancelled") {
      throw new ORPCError("BAD_REQUEST", {
        message: "An accepted quote can't be deleted. Use Cancel job on the quote or the job page instead.",
      });
    }
    await db.delete(schema.quotes).where(eq(schema.quotes.id, input.id));
    // The job made by these quotes goes back to the newest one left.
    if (quote.jobId) await syncJobValue(quote.jobId);
    return { ok: true };
  }),

  /* ----------------------------- line items ----------------------------- */

  addItem: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        productId: z.number().nullable().optional(),
        kind: z.string().default("supply"),
        description: z.string().min(1),
        qty: z.number().default(1),
        unit: z.string().default("m2"),
        unitPrice: z.number().default(0),
        unitCost: z.number().nullable().optional(),
        flagged: z.boolean().default(false),
        flagReason: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await editableQuoteOrThrow(input.quoteId);
      // Notes 18.44. A line typed by hand sets its own price, so it is a website job.
      if (fromPhoneApp(context.headers) && (input.unitPrice !== 0 || (input.unitCost ?? null) !== null)) {
        throw new ORPCError("FORBIDDEN", { message: PHONE_PRICE_MESSAGE });
      }
      if (context.actor.role !== "admin") input.unitCost = null;
      // A delivery charge typed in by hand is a delivery line, not a product (188001 list item 6).
      if (input.productId == null && (input.kind === "supply" || input.kind === "other") && isDeliveryText(input.description)) {
        input.kind = DELIVERY;
      }
      // A price book product typed in at a lower price is still a discount off the price book.
      let listUnitPrice: number | null = null;
      if (input.productId != null) {
        const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
        if (product) {
          const sell = await liveSellFor(product);
          if (sell !== input.unitPrice) listUnitPrice = sell;
        }
      }
      await assertSentEditAllowed(quote, { qty: input.qty, unitPrice: input.unitPrice, listUnitPrice }, context.actor);
      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.quoteId));

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          productId: input.productId ?? null,
          kind: input.kind,
          lineType: lineTypeOf(input.kind),
          description: input.description,
          qty: input.qty,
          unit: input.unit,
          unitPrice: input.unitPrice,
          listUnitPrice,
          unitCost: input.unitCost ?? null,
          markupPercent: markupOf(input.unitCost, input.unitPrice),
          total: round2(input.qty * input.unitPrice),
          sortOrder: Number(maxRow?.max ?? -1) + 1,
          flagged: input.flagged,
          flagReason: input.flagReason ?? null,
        })
        .returning();

      const totals = await recalc(input.quoteId);
      return { item: hideCost(row, context.actor), totals };
    }),

  /**
   * Add a line straight off the price list, carrying sell price and cost across.
   *
   * Items 8 and 9: a Box or Broadloom product takes the measured m2 and a
   * wastage % (Settings starts it), and its qty is worked out from them. Its
   * install labour goes on underneath, linked, unless `labour` is null
   * (unticked). `labour.itemId` swaps it. Timber, and carpet with no roll
   * width, have no default: the line is flagged until Damien picks.
   */
  addProduct: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        productId: z.number(),
        qty: z.number().default(1),
        measuredM2: z.number().min(0).nullable().optional(),
        wastagePct: z.number().min(0).max(100).nullable().optional(),
        rollWidthM: z.number().positive().nullable().optional(),
        /** Undefined = the default install. Null = unticked. */
        labour: z.object({ itemId: z.number() }).nullable().optional(),
        /** Underlay: the floor line it goes with. Left out, the latest floor of its kind. */
        followsItemId: z.number().nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await editableQuoteOrThrow(input.quoteId);
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const unitPrice = await liveSellFor(product);
      // Reads the way Damien says it out loud: "Andes Peak in Merida", not a
      // string of dashes. This line goes out on the customer's quote.
      const description = productLineName(product);

      const measured = floorTypeOf(product) && input.measuredM2 != null ? input.measuredM2 : null;
      const wastagePct = measured != null ? (input.wastagePct ?? (await wastageDefaultFor(product))) : null;
      const rollWidthM = measured != null && !product.widthM ? (input.rollWidthM ?? null) : null;
      const res = measured != null ? floorQty(product, measured, wastagePct ?? 0, rollWidthM) : null;
      // Fix list 11 Oct, items 2 and 3: whole boxes, lengths and pails; underlay off its floor.
      const start = res ? null : await startLine(input.quoteId, product, input.qty, input.followsItemId);
      const qty = res ? res.qty : start!.qty;

      // Which install, if any. Only on a measured floor line.
      let installId: number | null = null;
      let flag = qtyFlag(res) ?? start?.flag ?? null;
      if (res && input.labour !== null) {
        if (input.labour) installId = input.labour.itemId;
        else {
          const pick = installFor(product, res);
          if (pick.kind === "item") installId = pick.itemId;
          else if (pick.kind === "ask") flag = flag ?? pick.reason;
        }
      }
      // Carpet with no width cannot be measured off yet, so its install waits for the width too.
      if (res?.problem === "no_width") installId = null;

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          productId: product.id,
          kind: product.category === "labour" ? "labour" : "supply",
          lineType: product.category === "labour" ? "labour" : "material",
          description: description || product.sku || "Product",
          qty,
          unit: product.unit,
          unitPrice,
          unitCost: product.costPrice ?? null,
          markupPercent: markupOf(product.costPrice, unitPrice),
          total: round2(qty * unitPrice),
          sortOrder: start?.sortOrder ?? (await nextSortOrder(input.quoteId)),
          measuredM2: measured,
          wastagePct,
          rollWidthM,
          followsItemId: start?.followsItemId ?? null,
          flagged: Boolean(flag),
          flagReason: flag,
        })
        .returning();
      if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Line not added" });

      let labour: typeof row | undefined;
      let item = row;
      if (installId != null) {
        // A missing rate must not leave the product line half added: it is flagged instead.
        try {
          labour = await addLinkedLabour(row, product, installId);
        } catch (e) {
          const reason = `Install not added. ${e instanceof Error ? e.message : ""}`.trim();
          [item = row] = await db
            .update(schema.quoteItems)
            .set({ flagged: true, flagReason: reason, updatedAt: new Date() })
            .where(eq(schema.quoteItems.id, row.id))
            .returning();
        }
      }

      const totals = await recalc(input.quoteId);
      return {
        item: hideCost(item, context.actor),
        labour: hideCost(labour, context.actor),
        qtyNote: res?.note ?? start?.note ?? null,
        totals,
      };
    }),

  /**
   * Add a labour line off the rate book.
   *
   * The rate is resolved HERE, not passed in, for two reasons. The sell price
   * has to come off the one markup chain, and Terra's cost has to be the real
   * number rather than whatever a form posted. Damien's rule holds: the line
   * quotes at Terra's STANDARD rate whoever is pencilled against it, so the
   * margin does not move depending on who the office had in mind.
   *
   * `installerId` is a note of intent, nothing more. It does not book him, it
   * does not offer him the work, and it does not reprice the line.
   */
  addLabour: staffOnly
    .input(
      z.object({
        quoteId: z.number(),
        itemId: z.number(),
        qty: z.number().default(1),
        installerId: z.number().nullable().default(null),
        /** Overrides the item's own name on the customer-facing line. */
        description: z.string().optional(),
        /**
         * Item 8: the product line this is the install for. Links it, puts it
         * underneath, and works the qty out from that line's measured m2.
         */
        forItemId: z.number().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      await editableQuoteOrThrow(input.quoteId);

      if (input.forItemId != null) {
        const [productLine] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.forItemId));
        if (!productLine || productLine.quoteId !== input.quoteId || !productLine.productId)
          throw new ORPCError("BAD_REQUEST", { message: "That product line is not on this quote." });
        const [product] = await db.select().from(schema.products).where(eq(schema.products.id, productLine.productId));
        if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });
        const row = await addLinkedLabour(productLine, product, input.itemId);
        if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "The install line did not save." });
        const totals = await recalc(input.quoteId);
        const showCost = context.actor.canSeeCosts;
        return {
          item: hideCost(row, context.actor),
          totals,
          rateItem: { id: input.itemId, name: row.description, unit: row.unit, groupName: "" },
          cost: showCost ? row.unitCost : null,
          sell: row.unitPrice,
          lineCost: null,
          minApplied: false,
          minimumCharge: null,
          installerName: null,
        };
      }

      const { item, live, cost, sell, lineCost, lineSell, minApplied } = await standardLabour(input.itemId, input.qty);

      let installerName: string | null = null;
      if (input.installerId != null) {
        const [who] = await db
          .select({ name: schema.installers.name })
          .from(schema.installers)
          .where(eq(schema.installers.id, input.installerId));
        installerName = who?.name ?? null;
      }

      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.quoteId));

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          kind: item.kind === "work" ? "labour" : item.kind === "allowance" ? "other" : "labour",
          lineType: "labour",
          description: input.description?.trim() || item.name,
          qty: input.qty,
          unit: item.unit,
          // Unit figures, so editing qty on the row still behaves. The minimum
          // charge is folded into the stored total instead.
          unitPrice: sell,
          unitCost: cost,
          markupPercent: markupPctUsed(item.markupPercent),
          total: lineSell,
          sortOrder: Number(maxRow?.max ?? -1) + 1,
          rateItemId: item.id,
        })
        .returning();

      const totals = await recalc(input.quoteId);
      const showCost = context.actor.canSeeCosts;
      return {
        item: hideCost(row, context.actor),
        totals,
        rateItem: { id: item.id, name: item.name, unit: item.unit, groupName: item.groupName },
        cost: showCost ? cost : null,
        sell,
        lineCost: showCost ? lineCost : null,
        minApplied,
        minimumCharge: live.minimumCharge,
        installerName,
      };
    }),

  updateItem: staffOnly
    .input(
      z.object({
        id: z.number(),
        kind: z.string().optional(),
        description: z.string().min(1).optional(),
        qty: z.number().optional(),
        unit: z.string().optional(),
        unitPrice: z.number().optional(),
        unitCost: z.number().nullable().optional(),
        /** Admin only. Sets sell from cost. Needs a cost on the line. */
        markupPercent: z.number().min(-100).max(1000).optional(),
        sortOrder: z.number().int().optional(),
        flagged: z.boolean().optional(),
        flagReason: z.string().nullable().optional(),
        productId: z.number().nullable().optional(),
        lineType: z.enum(["material", "labour", "delivery"]).optional(),
        /** Item 9: the measured m2 on a Box or Broadloom line. Qty is worked out from it. */
        measuredM2: z.number().min(0).nullable().optional(),
        wastagePct: z.number().min(0).max(100).nullable().optional(),
        /** Roll width for this line, when the carpet has none in the price book. */
        rollWidthM: z.number().positive().nullable().optional(),
        /** Item 8: put the default install on now, if the line has none linked. Used with a width pick. */
        addInstall: z.boolean().optional(),
        /** Fix list item 3: on an underlay line, the floor line it follows. Null = stop following. */
        followsItemId: z.number().nullable().optional(),
        /** Copy from previous job (16 Oct). False = Confirm on a Check required line. Only clears. */
        checkRequired: z.literal(false).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, addInstall, ...rest } = input;
      const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      // Notes 18.44. On the phone the price book sets the price. Qty, words and
      // product swaps still go through, a new sell, cost or markup does not.
      if (
        fromPhoneApp(context.headers) &&
        ((rest.unitPrice !== undefined && rest.unitPrice !== before.unitPrice) ||
          (rest.unitCost !== undefined && rest.unitCost !== before.unitCost) ||
          (rest.markupPercent !== undefined && rest.markupPercent !== before.markupPercent))
      ) {
        throw new ORPCError("FORBIDDEN", { message: PHONE_PRICE_MESSAGE });
      }
      const current = await quoteOrThrow(before.quoteId);
      // 188001 list item 7: an accepted quote keeps its prices, qty and lines.
      // Only the words on a line can change. Anything else is a variation.
      if (current.status === "accepted") {
        const touched = Object.entries(rest).filter(([, v]) => v !== undefined).map(([k]) => k);
        if (addInstall || touched.length !== 1 || touched[0] !== "description") {
          throw new ORPCError("BAD_REQUEST", {
            message: "This quote is accepted. Only the wording can change. Prices, qty and lines go through a variation on the job.",
          });
        }
        const text = cleanWording(rest.description ?? "");
        if (!text) throw new ORPCError("BAD_REQUEST", { message: "A line needs some words." });
        const [row] = await db
          .update(schema.quoteItems)
          .set({ description: text, updatedAt: new Date() })
          .where(eq(schema.quoteItems.id, id))
          .returning();
        return {
          item: hideCost(row, context.actor),
          labour: undefined as typeof row | undefined,
          totals: { subtotal: current.subtotal, gst: current.gst, total: current.total },
        };
      }
      const quote = await editableQuoteOrThrow(before.quoteId);
      // Notes 18.33. A supplier charge line keeps its kind and has no product.
      // Typing over its qty, price or words keeps it as typed.
      const charge = isChargeLine(before);
      if (charge) {
        if (!context.actor.canSeeCosts) throw new ORPCError("FORBIDDEN", { message: "Supplier charge lines are for cost viewers only." });
        delete rest.kind;
        delete rest.lineType;
        delete rest.productId;
        delete rest.measuredM2;
        delete rest.wastagePct;
        delete rest.rollWidthM;
        delete rest.followsItemId;
      } else if (context.actor.role !== "admin" && rest.unitPrice !== undefined && rest.unitPrice !== before.unitPrice && before.qty > 0) {
        // Staff without costs see this line with the supplier charges spread in, and nobody but an
        // Admin sees the referral fee (notes 18.47). Take both back out of a typed price.
        rest.unitPrice = await typedPriceWithoutFee(before, rest.unitPrice, context.actor);
      }
      // Only an Admin can change what Terra pays or the markup on it. Office edits price and quantity only.
      const { markupPercent: markupIn, ...fields } = rest;
      if (context.actor.role !== "admin") delete fields.unitCost;
      // A typed cost is the supplier price. On an older line with freight built in, the freight goes with it.
      const freightReset = fields.unitCost !== undefined ? { freightUnitCost: null } : {};
      const setMarkup = context.actor.role === "admin" ? markupIn : undefined;

      if (fields.kind !== undefined && fields.lineType === undefined) fields.lineType = lineTypeOf(fields.kind);
      // A delivery line is always Delivery, never tagged Material or Labour (188001 list item 6).
      const kindNow = fields.kind ?? before.kind;
      if (kindNow === DELIVERY) fields.lineType = "delivery";
      else if (fields.lineType === "delivery") fields.lineType = lineTypeOf(kindNow);

      if (fields.followsItemId != null) {
        const [floor] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, fields.followsItemId));
        if (!floor || floor.quoteId !== before.quoteId || floor.id === id || !floor.productId)
          throw new ORPCError("BAD_REQUEST", { message: "That floor line is not on this quote." });
      }

      // Item 9. A new area, wastage or width works the qty out again.
      const areaTouched = fields.measuredM2 !== undefined || fields.wastagePct !== undefined || fields.rollWidthM !== undefined;
      const sizeTouched = areaTouched || fields.qty !== undefined || fields.followsItemId !== undefined;
      let product: typeof schema.products.$inferSelect | null = null;
      let areaRes: ReturnType<typeof qtyForLine> = null;
      if (sizeTouched && before.productId) {
        [product] = await db.select().from(schema.products).where(eq(schema.products.id, before.productId));
        product = product ?? null;
      }
      if (areaTouched && product) {
        if (floorTypeOf(product)) {
          const next = {
            measuredM2: fields.measuredM2 !== undefined ? fields.measuredM2 : before.measuredM2,
            wastagePct: fields.wastagePct !== undefined ? fields.wastagePct : before.wastagePct,
            rollWidthM: product.widthM ? null : fields.rollWidthM !== undefined ? fields.rollWidthM : before.rollWidthM,
          };
          if (next.measuredM2 != null && next.wastagePct == null) next.wastagePct = await wastageDefaultFor(product);
          Object.assign(fields, next);
          areaRes = qtyForLine(product, next);
          if (areaRes) fields.qty = areaRes.qty;
          if (fields.flagged === undefined) {
            const pendingInstall = before.flagged && isOwnFlag(before.flagReason) && !qtyFlag(qtyForLine(product, before)) ? before.flagReason : null;
            const f = nextFlag(before, qtyFlag(areaRes) ?? pendingInstall);
            fields.flagged = f.flagged;
            fields.flagReason = f.flagReason;
          }
        }
      }
      // Fix list items 2 and 3: a typed qty goes up to whole boxes, lengths or pails.
      // A typed qty on underlay is taken as typed, and the floor stops moving it.
      if (product && !areaRes && fields.qty !== undefined && !followsAFloor(product)) {
        const r = wholeUnits(product, fields.qty);
        fields.qty = r.qty;
        if (fields.flagged === undefined) Object.assign(fields, sizeFlag(before, r.flag));
      }
      const qty = fields.qty ?? before.qty;
      const cost = fields.unitCost !== undefined ? fields.unitCost : before.unitCost;
      const beforeMarkup = before.markupPercent ?? markupOf(before.unitCost, before.unitPrice);
      /**
       * Cost, markup and sell move together:
       *  - markup typed: sell = cost + markup.
       *  - cost changed on a line that already had a cost and no new sell:
       *    the markup holds and sell follows it.
       *  - otherwise sell is what was typed, and the markup is worked back.
       */
      let unitPrice = fields.unitPrice ?? before.unitPrice;
      let markupPercent: number | null;
      let priceBy: string | undefined;
      if (setMarkup !== undefined) {
        if (cost == null || cost <= 0) throw new ORPCError("BAD_REQUEST", { message: "Put a cost on the line first. Markup works off the cost." });
        unitPrice = sellAtMarkup(cost, setMarkup);
        markupPercent = setMarkup;
        priceBy = "markup";
      } else if (fields.unitCost !== undefined && fields.unitPrice === undefined && before.unitCost != null && beforeMarkup != null && cost != null && cost > 0) {
        unitPrice = sellAtMarkup(cost, beforeMarkup);
        markupPercent = beforeMarkup;
      } else {
        markupPercent = markupOf(cost, unitPrice);
        if (fields.unitPrice !== undefined && fields.unitPrice !== before.unitPrice) priceBy = "hand";
      }
      if (unitPrice !== before.unitPrice) fields.unitPrice = unitPrice;
      // Remember the price book price the first time a price is hand-edited.
      // The gap between it and the new price is the discount.
      const listUnitPrice =
        !charge && fields.unitPrice !== undefined && fields.unitPrice !== before.unitPrice && before.listUnitPrice === null
          ? before.unitPrice
          : undefined;
      const typedOver =
        charge &&
        ((fields.qty !== undefined && fields.qty !== before.qty) ||
          (fields.unitPrice !== undefined && fields.unitPrice !== before.unitPrice) ||
          (fields.unitCost !== undefined && fields.unitCost !== before.unitCost) ||
          (fields.description !== undefined && fields.description !== before.description) ||
          setMarkup !== undefined);
      await assertSentEditAllowed(
        quote,
        { id, qty, unitPrice, listUnitPrice: listUnitPrice ?? before.listUnitPrice },
        context.actor,
      );

      // Copy from previous job (16 Oct): editing a copied line counts as checking it.
      if (before.checkRequired && fields.checkRequired === undefined) {
        const edited = (["qty", "measuredM2", "wastagePct", "rollWidthM", "unitPrice", "productId", "description"] as const).some(
          (k) => input[k] !== undefined && input[k] !== before[k],
        );
        if (edited || setMarkup !== undefined) fields.checkRequired = false;
      }
      const [row] = await db
        .update(schema.quoteItems)
        .set({ ...fields, ...freightReset, markupPercent, ...(priceBy !== undefined ? { priceBy } : {}), ...(listUnitPrice !== undefined ? { listUnitPrice } : {}), ...(typedOver ? { chargeTyped: true } : {}), total: round2(qty * unitPrice), updatedAt: new Date() })
        .where(eq(schema.quoteItems.id, id))
        .returning();

      // A human picking (or confirming) the right product for a line that
      // carries a spoken phrase is exactly the signal worth learning from —
      // next time that phrase comes up, price.ts matches it outright.
      if (fields.productId != null && before.voicePhrase) {
        await db
          .insert(schema.voicePhraseProductMatches)
          .values({
            phrase: before.voicePhrase,
            productId: fields.productId,
            confirmCount: 1,
            lastConfirmedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [schema.voicePhraseProductMatches.phrase, schema.voicePhraseProductMatches.productId],
            set: { confirmCount: sql`${schema.voicePhraseProductMatches.confirmCount} + 1`, lastConfirmedAt: new Date(), updatedAt: new Date() },
          });
      }

      // Fix list item 3. Underlay under this floor follows it; an underlay given a floor works its qty out.
      if (sizeTouched && product && row) {
        await followUnderlay({ line: before, product }, { line: row, product });
        if (fields.followsItemId != null && input.qty === undefined) await refollow(row.id);
      }

      // Item 8. The install lines linked to it follow the new area.
      let labour: typeof row | undefined;
      if (areaTouched && product && row) {
        await followLinkedLabour({ line: before, product }, { line: row, product });
        if (addInstall && areaRes && !areaRes.problem) {
          const [already] = await db
            .select({ id: schema.quoteItems.id })
            .from(schema.quoteItems)
            .where(eq(schema.quoteItems.labourForItemId, row.id));
          const pick = installFor(product, areaRes);
          if (!already && pick.kind === "item") {
            try {
              labour = await addLinkedLabour(row, product, pick.itemId);
            } catch (e) {
              await db
                .update(schema.quoteItems)
                .set({ flagged: true, flagReason: `Install not added. ${e instanceof Error ? e.message : ""}`.trim() })
                .where(eq(schema.quoteItems.id, row.id));
            }
          } else if (!already && pick.kind === "ask" && (!row.flagged || isOwnFlag(row.flagReason)))
            await db.update(schema.quoteItems).set({ flagged: true, flagReason: pick.reason }).where(eq(schema.quoteItems.id, row.id));
        }
      }

      const totals = await recalc(before.quoteId);
      return { item: hideCost(row, context.actor), labour: hideCost(labour, context.actor), totals };
    }),

  /**
   * The handful of price book products closest to what a line says, for the
   * Change product list. Reads the line's own words and, on a voice line,
   * what was said.
   */
  /**
   * For a quote with nobody on it: what Damien said about the customer and
   * the closest clients already in the system, so the quote page can show
   * "Customer not found" with matches and a filled-in new client form.
   */
  customerHelp: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await quoteOrThrow(input.id);
    const spoken = await spokenForQuote(input.id);
    const candidates = spoken ? (await customerCandidates(spoken)).slice(0, 4) : [];
    return { spoken, candidates };
  }),

  /** Put a customer on a quote: someone already in the system, or a new client made here. */
  setCustomer: staffOnly
    .input(
      z.object({
        id: z.number(),
        contactId: z.number().optional(),
        create: z
          .object({
            firstName: z.string().trim().min(1),
            lastName: z.string().trim().default(""),
            mobile: z.string().trim().nullable().optional(),
            email: z.string().trim().nullable().optional(),
            address: z.string().trim().nullable().optional(),
            suburb: z.string().trim().nullable().optional(),
            postcode: z.string().trim().nullable().optional(),
          })
          .optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      let contact: typeof schema.contacts.$inferSelect | undefined;
      if (input.create) {
        const mobile = input.create.mobile ? (normaliseMobile(input.create.mobile) ?? input.create.mobile) : null;
        contact = await createContact({ ...input.create, mobile, source: "phone" }, context.actor);
        forgetNames();
      } else if (input.contactId) {
        [contact] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, input.contactId));
      }
      if (!contact) throw new ORPCError("BAD_REQUEST", { message: "Pick a client or fill in a new one." });

      await db
        .update(schema.quotes)
        .set({
          contactId: contact.id,
          notes: quote.notes?.replace(UNMATCHED_NOTE, "").replace(SAID_DETAILS_NOTE, "") ?? null,
          updatedAt: new Date(),
        })
        .where(eq(schema.quotes.id, input.id));
      // Notes 18.54: a quote with nobody billed yet bills the client picked now.
      if (!quoteBillTo(quote)) await quoteBillToPatch(quote.id, { type: "contact", id: contact.id });
      await db
        .update(schema.voiceQuoteCaptures)
        .set({ contactId: contact.id, updatedAt: new Date() })
        .where(eq(schema.voiceQuoteCaptures.quoteId, input.id));
      if (quote.jobId) await fillJobFromQuote(quote.id);
      // Copy from previous job (16 Oct): a copy for another client waited with no job. It gets one now, at Lead.
      let jobId = quote.jobId;
      if (!jobId) {
        const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id));
        const { job } = await createJobForQuote(fresh ?? quote, { source: UNSET_SOURCE, noAccessNotes: quote.copiedFromQuoteId != null });
        jobId = job.id;
        await db.insert(schema.activityLog).values({
          jobId,
          contactId: contact.id,
          entityType: "job",
          entityId: jobId,
          action: "created",
          detail: `Job made with quote ${await quoteRefById(quote.id)}`,
          actorName: context.actor.name,
          actorRole: context.actor.role,
        });
      }
      const name = `${contact.firstName} ${contact.lastName}`.trim();
      await db.insert(schema.activityLog).values({
        contactId: contact.id,
        jobId,
        entityType: "quote",
        entityId: quote.id,
        action: "customer_set",
        detail: `${name} put on quote ${await quoteRefById(quote.id)}${input.create ? " as a new client" : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return { contactId: contact.id, name, jobId };
    }),

  suggestProducts: staffOnly.input(z.object({ itemId: z.number() })).handler(async ({ input }) => {
    const [item] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.itemId));
    if (!item) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
    const rows = await suggestProducts(`${item.description} ${item.voicePhrase ?? ""}`, 6);
    return rows
      .filter((p) => p.id !== item.productId)
      .map((p) => ({
        id: p.id,
        label: productLineName(p) || p.supplier,
        supplier: p.supplier,
        backing: p.backing,
        unit: p.unit,
        sellPrice: p.sellPrice,
      }));
  }),

  /**
   * Swap the product on a line in one tap: name, unit, sell and cost come off
   * the price book, the quantity stays. On a voice line the pick is learned,
   * so the same words find this product next time.
   */
  changeProduct: staffOnly
    .input(z.object({ id: z.number(), productId: z.number() }))
    .handler(async ({ input, context }) => {
      const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await quoteOrThrow(before.quoteId);
      if (quote.status !== "draft" && quote.status !== "needs_review")
        throw new ORPCError("BAD_REQUEST", { message: "This quote has gone out. Revise it to change a product." });
      if (isChargeLine(before)) throw new ORPCError("BAD_REQUEST", { message: "A supplier charge line has no product." });
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const unitPrice = await liveSellFor(product);
      const [oldProduct] = before.productId
        ? await db.select().from(schema.products).where(eq(schema.products.id, before.productId))
        : [];
      // Item 9. A measured line keeps its area and wastage; the new product's
      // box size or roll width gives the qty.
      const measured = before.measuredM2 != null && floorTypeOf(product) ? before : null;
      const areaRes = measured ? qtyForLine(product, { ...measured, rollWidthM: product.widthM ? null : measured.rollWidthM }) : null;
      // Fix list item 2: the new product's box, length or pail size rounds the qty.
      const sized = !areaRes && !followsAFloor(product) ? wholeUnits(product, before.qty) : null;
      const qty = areaRes ? areaRes.qty : (sized?.qty ?? before.qty);
      // Compare with the unit he said, not a wrong pick made a moment ago.
      const said = before.flagReason?.match(/^Was ([\d.]+) (\S+), this product sells by/);
      const saidUnit = said?.[2] ?? before.unit;
      // A measured line has just been worked out again in the new unit, so there is nothing to check.
      const unitClash = !areaRes && !followsAFloor(product) && Boolean(product.unit && saidUnit && product.unit !== saidUnit);
      const flagReason = unitClash
        ? `Was ${said?.[1] ?? before.qty} ${saidUnit}, this product sells by ${product.unit}. Check the quantity.`
        : unitPrice === 0
          ? "That product has no sell price yet. Put the price in."
          : null;
      // Still waiting on an install pick on the new floor (timber to timber): the flag stays.
      const newPick = installFor(product, areaRes);
      const stillWaiting =
        before.flagged && isInstallFlag(before.flagReason) && newPick.kind === "ask" && !areaRes?.problem ? newPick.reason : null;
      const ownFlag = qtyFlag(areaRes) ?? stillWaiting ?? sized?.flag ?? null;

      const [row] = await db
        .update(schema.quoteItems)
        .set({
          productId: product.id,
          kind: product.category === "labour" ? "labour" : "supply",
          description: productLineName(product) || product.sku || before.description,
          unit: product.unit || before.unit,
          unitPrice,
          listUnitPrice: null,
          unitCost: product.costPrice ?? null,
          markupPercent: markupOf(product.costPrice, unitPrice),
          freightUnitCost: null,
          // Copy from previous job (16 Oct): picking the product again counts as checking the line.
          checkRequired: false,
          qty,
          total: round2(qty * unitPrice),
          ...(areaRes ? {} : { measuredM2: null, wastagePct: null, rollWidthM: null }),
          flagged: Boolean(flagReason ?? ownFlag),
          flagReason: flagReason ?? ownFlag,
          updatedAt: new Date(),
        })
        .where(eq(schema.quoteItems.id, input.id))
        .returning();

      // Fix list item 3. Underlay under this floor follows the new product's
      // width. An underlay line works its qty out off its floor again, and a
      // line that has just become underlay finds its floor.
      if (row) {
        await followUnderlay({ line: before, product: oldProduct ?? null }, { line: row, product });
        if (followsAFloor(product)) {
          if (row.followsItemId == null) {
            const floor = await floorLineFor(row.quoteId, product);
            if (floor.line) await db.update(schema.quoteItems).set({ followsItemId: floor.line.id }).where(eq(schema.quoteItems.id, row.id));
          }
          await refollow(row.id);
        } else if (row.followsItemId != null) {
          await db.update(schema.quoteItems).set({ followsItemId: null }).where(eq(schema.quoteItems.id, row.id));
        }
      }

      // Item 8. The linked install follows. If it was the old floor's default
      // and the new floor has a different one, it swaps over too.
      if (row) {
        await followLinkedLabour({ line: before, product: oldProduct ?? null }, { line: row, product });
        const oldPick = oldProduct ? installFor(oldProduct, oldProduct ? qtyForLine(oldProduct, before) : null) : null;
        if (oldPick?.kind === "item" && newPick.kind === "item" && oldPick.itemId !== newPick.itemId) {
          const linked = await db
            .select()
            .from(schema.quoteItems)
            .where(and(eq(schema.quoteItems.labourForItemId, row.id), eq(schema.quoteItems.rateItemId, oldPick.itemId)));
          // Added before the old one goes, so a missing rate leaves the old install in place.
          for (const l of linked) {
            try {
              await addLinkedLabour(row, product, newPick.itemId);
              await db.delete(schema.quoteItems).where(eq(schema.quoteItems.id, l.id));
            } catch (e) {
              await db
                .update(schema.quoteItems)
                .set({ flagged: true, flagReason: `Install not swapped. ${e instanceof Error ? e.message : ""}`.trim() })
                .where(eq(schema.quoteItems.id, row.id));
            }
          }
        }
        // The old floor was waiting on an install pick (timber, no roll width).
        // The new one has a clear default, so it goes on now.
        const waiting = before.flagged && (isInstallFlag(before.flagReason) || before.flagReason === NO_WIDTH_FLAG);
        if (areaRes && !areaRes.problem && waiting && newPick.kind === "item") {
          const [already] = await db
            .select({ id: schema.quoteItems.id })
            .from(schema.quoteItems)
            .where(eq(schema.quoteItems.labourForItemId, row.id));
          if (!already) {
            await addLinkedLabour(row, product, newPick.itemId).catch((e: unknown) =>
              db
                .update(schema.quoteItems)
                .set({ flagged: true, flagReason: `Install not added. ${e instanceof Error ? e.message : ""}`.trim() })
                .where(eq(schema.quoteItems.id, row.id)),
            );
          }
        }
      }

      const totals = await recalc(before.quoteId);

      // Next time he says the same thing, this is the pick. A failure here
      // must not undo the swap he just made.
      if (before.voicePhrase) {
        await db
          .insert(schema.voicePhraseProductMatches)
          .values({ phrase: before.voicePhrase, productId: product.id, confirmCount: 1, lastConfirmedAt: new Date() })
          .onConflictDoUpdate({
            target: [schema.voicePhraseProductMatches.phrase, schema.voicePhraseProductMatches.productId],
            set: { confirmCount: sql`${schema.voicePhraseProductMatches.confirmCount} + 1`, lastConfirmedAt: new Date(), updatedAt: new Date() },
          })
          .catch((e: unknown) => console.error("[quotes] could not learn product pick:", e));
        // And the one he swapped away from was wrong for these words.
        if (before.productId && before.productId !== product.id) {
          const wrong = and(
            eq(schema.voicePhraseProductMatches.phrase, before.voicePhrase),
            eq(schema.voicePhraseProductMatches.productId, before.productId),
          );
          await db
            .update(schema.voicePhraseProductMatches)
            .set({ confirmCount: sql`${schema.voicePhraseProductMatches.confirmCount} - 1`, updatedAt: new Date() })
            .where(wrong)
            .then(() => db.delete(schema.voicePhraseProductMatches).where(and(wrong, sql`${schema.voicePhraseProductMatches.confirmCount} <= 0`)))
            .catch((e: unknown) => console.error("[quotes] could not unlearn product pick:", e));
        }
      }
      return { item: hideCost(row, context.actor), totals };
    }),

  removeItem: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
    if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
    await editableQuoteOrThrow(before.quoteId);
    // Notes 18.33. A worked out supplier charge comes back on the next change, so removing it does nothing.
    // A typed over one can go: it comes back as worked out while the supplier's goods are on the quote.
    if (isChargeLine(before) && !before.chargeTyped) {
      throw new ORPCError("BAD_REQUEST", {
        message: "This line is worked out from the supplier's charges and comes back on its own. Type over the qty or price to change it, or set the price to 0.",
      });
    }
    // Item 8: the install added with a product line goes with it.
    const linked = await db
      .delete(schema.quoteItems)
      .where(eq(schema.quoteItems.labourForItemId, input.id))
      .returning({ id: schema.quoteItems.id });
    // Fix list item 3: so does the underlay under it.
    const underlay = await db
      .delete(schema.quoteItems)
      .where(eq(schema.quoteItems.followsItemId, input.id))
      .returning({ id: schema.quoteItems.id });
    await db.delete(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
    const totals = await recalc(before.quoteId);
    return { totals, removedLabour: linked.length, removedUnderlay: underlay.length };
  }),

  /** Drag-reorder the lines on a quote. */
  reorderItems: staffOnly
    .input(z.object({ quoteId: z.number(), orderedIds: z.array(z.number()) }))
    .handler(async ({ input }) => {
      await editableQuoteOrThrow(input.quoteId);
      await Promise.all(
        input.orderedIds.map((id, i) =>
          db
            .update(schema.quoteItems)
            .set({ sortOrder: i, updatedAt: new Date() })
            .where(and(eq(schema.quoteItems.id, id), eq(schema.quoteItems.quoteId, input.quoteId))),
        ),
      );
      return { ok: true };
    }),

  /* ------------------------------ lifecycle ----------------------------- */

  /** Admin signs off the quote's current discount so Office can send it. */
  approveDiscount: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await quoteOrThrow(input.id);
    const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, input.id));
    const pct = discountPercentOf(items);
    const [row] = await db
      .update(schema.quotes)
      .set({ discountApprovedPercent: pct, discountApprovedBy: context.actor.name, discountApprovedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.quotes.id, input.id))
      .returning();
    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: quote.id,
      action: "discount_approved",
      detail: `${belowListKind(items) === "markup" ? "Markup below standard" : "Discount"} of ${pct}% approved on quote ${await quoteRefOf(quote)}`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    return row;
  }),

  send: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await editableQuoteOrThrow(input.id);
    await assertBillable(quote.jobId);
    await assertReadyToGoOut(quote, context.actor);
    await recordPriceHistory(quote, context.actor.name);
    const [row] = await db
      .update(schema.quotes)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.quotes.id, input.id))
      .returning();

    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: quote.id,
      action: "sent",
      detail: `Quote ${await quoteRefOf(quote)} marked as sent`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });
    // Notes 18.53: a sent quote always leaves its job on the right value.
    if (quote.jobId) await syncJobValue(quote.jobId);
    await leadToQuotedOnSend({ jobId: quote.jobId, quoteNumber: await quoteRefOf(quote), actor: context.actor });

    return row;
  }),

  accept: staffOnly
    .input(z.object({ id: z.number(), note: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      await assertReadyToGoOut(quote, context.actor);
      // The same routine a client signing online goes through (lib/quote-accept.ts).
      const out = await acceptQuote({ quoteId: quote.id, actor: context.actor, via: "staff", note: input.note });
      await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after accept failed:", e));
      return {
        ...out.quote,
        jobId: out.jobId,
        invoiceRef: out.invoice?.number ?? null,
        replacedRef: out.replaced?.ref ?? null,
        /** Dispatches and materials a later version could not swap over on its own. */
        toSort: out.rework?.flags.length ?? 0,
        workChanges: out.rework?.changes.length ?? 0,
      };
    }),

  decline: staffOnly
    .input(z.object({ id: z.number(), reason: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      if (quote.status === "accepted") throw new ORPCError("BAD_REQUEST", { message: "This quote is accepted and locked." });
      if (quote.status === "replaced") throw new ORPCError("BAD_REQUEST", { message: "This version was replaced by a newer accepted one." });
      if (quote.status === "cancelled") throw new ORPCError("BAD_REQUEST", { message: "This quote is cancelled and locked." });
      const [row] = await db
        .update(schema.quotes)
        .set({ status: "declined", updatedAt: new Date() })
        .where(eq(schema.quotes.id, input.id))
        .returning();
      if (quote.jobId) await syncJobValue(quote.jobId);

      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "declined",
        detail: `Quote ${await quoteRefOf(quote)} declined: ${input.reason}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  /** Copy a quote into a new version so the original stays as sent history. */
  revise: staffOnly
    .input(z.object({ id: z.number() }))
    .handler(async ({ input, context }) => reviseQuoteRecord(await quoteOrThrow(input.id), context.actor)),

  /**
   * Turn an accepted quote into a job. Labour/prep/removal lines become
   * unassigned TASKS (the dispatch unit) and supply lines become materials.
   */
  convertToJob: staffOnly
    .input(
      z.object({
        id: z.number(),
        title: z.string().optional(),
        furnitureOnSite: z.boolean().default(false),
        createTasks: z.boolean().default(true),
      }),
    )
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      if (quote.jobId) {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is already attached to a job" });
      }
      await assertReadyToGoOut(quote, context.actor);
      return convertQuoteToJob(quote, input, context.actor);
    }),

  /** Dashboard/pipeline figures for the quotes screen. */
  stats: staffOnly.handler(async () => {
    const rows = await db
      .select({
        status: schema.quotes.status,
        count: sql<number>`count(*)`,
        value: sql<number>`coalesce(sum(${schema.quotes.total}), 0)`,
      })
      .from(schema.quotes)
      .groupBy(schema.quotes.status);

    const byStatus = Object.fromEntries(
      rows.map((r) => [r.status, { count: Number(r.count), value: Number(r.value) }]),
    ) as Record<string, { count: number; value: number }>;

    return {
      byStatus,
      outstandingValue: round2(byStatus.sent?.value ?? 0),
      draftCount: byStatus.draft?.count ?? 0,
      sentCount: byStatus.sent?.count ?? 0,
      acceptedValue: round2(byStatus.accepted?.value ?? 0),
    };
  }),
};
