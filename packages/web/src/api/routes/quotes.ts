import { z } from "zod";
import { assertSupervisor, SUPERVISOR_REQUIRED_MESSAGE } from "../lib/supervisors";
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly, type Actor } from "../middleware/auth";
import { markupOf, markupPctUsed, sellAtMarkup, sellExGstWithMarkup } from "../lib/pricing";
import { depositDefaultFor, depositSplit } from "../lib/deposits";
import { liveSellFor } from "../lib/live-sell";
import { suggestProducts } from "../agent/price";
import { customerCandidates, SAID_DETAILS_NOTE, spokenForQuote, UNMATCHED_NOTE } from "../lib/quote-customer";
import { forgetNames } from "../lib/memo-context";
import { normaliseMobile } from "../lib/sms";
import { createContact } from "./contacts";

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

/** Labour, prep and removal lines are Labour. Everything else is Material. */
export const lineTypeOf = (kind: string) => (["labour", "prep", "removal"].includes(kind) ? "labour" : "material");

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

/** Append one history row per product line on this quote. Called when the quote is sent. */
async function recordPriceHistory(quote: typeof schema.quotes.$inferSelect, byName: string) {
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
  const items = await db
    .select({ total: schema.quoteItems.total })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId));

  const subtotal = round2(items.reduce((sum, i) => sum + (i.total ?? 0), 0));
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);

  await db
    .update(schema.quotes)
    .set({ subtotal, gst, total, updatedAt: new Date() })
    .where(eq(schema.quotes.id, quoteId));

  return { subtotal, gst, total };
}

/** "Andes Peak in Merida", the way it reads on the customer's quote. */
function productLineName(p: { brand: string | null; range: string | null; colour: string | null }) {
  const named = [p.brand, p.range].filter(Boolean).join(" ");
  return p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named;
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function quoteOrThrow(id: number) {
  const [row] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  return row;
}

/** Accepted, declined and expired quotes are history. Change them by making a new version. */
const LOCKED_STATUSES = ["accepted", "declined", "expired"];
async function editableQuoteOrThrow(id: number) {
  const quote = await quoteOrThrow(id);
  if (LOCKED_STATUSES.includes(quote.status)) {
    throw new ORPCError("BAD_REQUEST", { message: "This quote is locked. Make a new version to change it." });
  }
  return quote;
}

type DiscountLine = { id?: number; qty: number; unitPrice: number; listUnitPrice: number | null };

/** Office cannot go past the discount limit, or past what an Admin approved. Admin is never blocked. */
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

/** The checks every path to a customer goes through: Send, Accept and Convert to job. */
async function assertReadyToGoOut(quote: typeof schema.quotes.$inferSelect, actor: Actor) {
  if (quote.companyId && !quote.supervisorContactId) {
    throw new ORPCError("BAD_REQUEST", { message: `Supervisor missing. ${SUPERVISOR_REQUIRED_MESSAGE}` });
  }
  const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quote.id));
  await assertDiscountAllowed(quote, items, actor);
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
function hideCost<T extends { unitCost: number | null; markupPercent: number | null }>(row: T | undefined, actor: Actor): T | undefined {
  return row && !actor.canSeeCosts ? { ...row, unitCost: null, markupPercent: null } : row;
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
        const asNumber = Number(input.search.replace(/\D/g, ""));
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
          job: { id: schema.jobs.id, number: schema.jobs.number },
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
        job: { id: schema.jobs.id, number: schema.jobs.number, title: schema.jobs.title },
      })
      .from(schema.quotes)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
      .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
      .leftJoin(schema.jobs, eq(schema.jobs.id, schema.quotes.jobId))
      .where(eq(schema.quotes.id, input.id));

    if (!row) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });

    const [items, activity, versions] = await Promise.all([
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
    ]);

    const cost = items.reduce((sum, i) => sum + (i.unitCost ?? 0) * (i.qty ?? 0), 0);
    const showCosts = context.actor.canSeeCosts;
    const limit = await discountLimit();
    const discountPercent = discountPercentOf(items);
    const needsApproval =
      context.actor.role !== "admin" && discountPercent > limit && discountPercent > row.quote.discountApprovedPercent;

    return {
      ...row.quote,
      discountPercent,
      discountLimit: limit,
      discountNeedsApproval: needsApproval,
      costsHidden: !showCosts,
      contact: row.contact,
      company: row.company,
      site: row.site,
      job: row.job?.id ? row.job : null,
      items: showCosts
        ? items.map((i) => ({ ...i, markupPercent: i.markupPercent ?? markupOf(i.unitCost, i.unitPrice) }))
        : items.map((i) => ({ ...i, unitCost: null, markupPercent: null })),
      ...depositSplit(row.quote.total, row.quote.depositPercent),
      activity,
      versions,
      /** Only for Admin, or Office with the cost switch on. Never expose these through field.ts. */
      estimatedCost: showCosts ? round2(cost) : null,
      estimatedMargin: showCosts ? round2(row.quote.subtotal - cost) : null,
      estimatedMarginPercent: !showCosts ? null : row.quote.subtotal > 0 ? round2(((row.quote.subtotal - cost) / row.quote.subtotal) * 100) : 0,
    };
  }),

  /** The deposit % a new quote for this company or contact starts at, and why. */
  depositDefault: staffOnly
    .input(z.object({ companyId: z.number().nullable().optional(), contactId: z.number().nullable().optional() }))
    .handler(({ input }) => depositDefaultFor(input)),

  create: staffOnly
    .input(
      z.object({
        jobId: z.number().nullable().optional(),
        contactId: z.number().nullable().optional(),
        companyId: z.number().nullable().optional(),
        /** Required when companyId is set. */
        supervisorContactId: z.number().nullable().optional(),
        siteId: z.number().nullable().optional(),
        /** Left out, it comes off the company or contact card (lib/deposits.ts). */
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
      }),
    )
    .handler(async ({ input, context }) => {
      await assertSupervisor(input.companyId, input.supervisorContactId);
      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quotes.number}), 1000)` })
        .from(schema.quotes);
      const number = Number(maxRow?.max ?? 1000) + 1;

      const [settingRow] = await db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "quote_terms"));

      const validUntil = new Date();
      validUntil.setDate(validUntil.getDate() + input.validDays);
      const depositPercent =
        input.depositPercent ?? (await depositDefaultFor({ companyId: input.companyId, contactId: input.contactId })).percent;

      const [row] = await db
        .insert(schema.quotes)
        .values({
          number,
          version: 1,
          jobId: input.jobId ?? null,
          contactId: input.contactId ?? null,
          companyId: input.companyId ?? null,
          supervisorContactId: input.companyId ? (input.supervisorContactId ?? null) : null,
          siteId: input.siteId ?? null,
          status: "draft",
          depositPercent,
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
            unitCost: context.actor.role === "admin" ? (item.unitCost ?? null) : null,
            markupPercent: context.actor.role === "admin" ? markupOf(item.unitCost, item.unitPrice) : null,
            total: round2(item.qty * item.unitPrice),
            sortOrder: i,
            flagged: item.flagged,
            flagReason: item.flagReason ?? null,
          })),
        );
      }

      const totals = await recalc(row.id);

      await db.insert(schema.activityLog).values({
        jobId: input.jobId ?? null,
        contactId: input.contactId ?? null,
        entityType: "quote",
        entityId: row.id,
        action: "created",
        detail: `Quote #${number} created`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { ...row, ...totals };
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
        depositPercent: z.number().min(0).max(100).optional(),
        validUntil: z.date().nullable().optional(),
        notes: z.string().nullable().optional(),
        terms: z.string().nullable().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const { id, ...rest } = input;
      const current = await quoteOrThrow(id);
      if (rest.status === "sent" || rest.status === "accepted") {
        throw new ORPCError("BAD_REQUEST", { message: "Use Send or Accepted on the quote, so the checks run." });
      }
      if (current.status === "accepted") {
        throw new ORPCError("BAD_REQUEST", { message: "This quote is accepted and locked. Make a new version to change it." });
      }
      const onlyStatus = Object.entries(rest).every(([k, v]) => k === "status" || v === undefined);
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
      const [row] = await db
        .update(schema.quotes)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.quotes.id, id))
        .returning();
      return row;
    }),

  remove: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const quote = await quoteOrThrow(input.id);
    if (quote.status === "accepted") {
      throw new ORPCError("BAD_REQUEST", { message: "An accepted quote can't be deleted — void it instead" });
    }
    await db.delete(schema.quotes).where(eq(schema.quotes.id, input.id));
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
      if (context.actor.role !== "admin") input.unitCost = null;
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

  /** Add a line straight off the price list, carrying sell price and cost across. */
  addProduct: staffOnly
    .input(z.object({ quoteId: z.number(), productId: z.number(), qty: z.number().default(1) }))
    .handler(async ({ input, context }) => {
      await editableQuoteOrThrow(input.quoteId);
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.quoteItems.sortOrder}), -1)` })
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, input.quoteId));

      const unitPrice = await liveSellFor(product);
      // Reads the way Damien says it out loud: "Andes Peak in Merida", not a
      // string of dashes. This line goes out on the customer's quote.
      const named = [product.brand, product.range].filter(Boolean).join(" ");
      const description = product.colour
        ? named
          ? `${named} in ${product.colour}`
          : product.colour
        : named;

      const [row] = await db
        .insert(schema.quoteItems)
        .values({
          quoteId: input.quoteId,
          productId: product.id,
          kind: product.category === "labour" ? "labour" : "supply",
          lineType: product.category === "labour" ? "labour" : "material",
          description: description || product.sku || "Product",
          qty: input.qty,
          unit: product.unit,
          unitPrice,
          unitCost: product.costPrice ?? null,
          markupPercent: markupOf(product.costPrice, unitPrice),
          total: round2(input.qty * unitPrice),
          sortOrder: Number(maxRow?.max ?? -1) + 1,
        })
        .returning();

      const totals = await recalc(input.quoteId);
      return { item: hideCost(row, context.actor), totals };
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
      }),
    )
    .handler(async ({ input, context }) => {
      await editableQuoteOrThrow(input.quoteId);

      const [item] = await db
        .select()
        .from(schema.labourRateItems)
        .where(eq(schema.labourRateItems.id, input.itemId));
      if (!item) throw new ORPCError("NOT_FOUND", { message: "That work item is not in the rate book" });

      const on = new Date().toISOString().slice(0, 10);
      const rates = await db
        .select()
        .from(schema.labourRates)
        .where(and(eq(schema.labourRates.itemId, input.itemId), isNull(schema.labourRates.installerId)));
      const live = rates
        .filter((r) => r.effectiveFrom <= on && (!r.effectiveTo || r.effectiveTo >= on))
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];

      if (!live) {
        throw new ORPCError("BAD_REQUEST", {
          message: `${item.name} has no standard rate yet. Price it in the rate book first, otherwise it quotes at zero.`,
        });
      }

      const cost = live.amount;
      /**
       * The item's own markup if it has one, the standard chain if it does not.
       * Almost every item is on the chain. Disposal and a tip run are not:
       * getting rid of the old floor is money passed through, so Damien's rule
       * is cost plus 15% there and the full chain everywhere else.
       */
      const sell = sellExGstWithMarkup(cost, item.markupPercent);
      // A minimum charge is a floor on the LINE, not on the rate: two stairs
      // still pays a call out, so the line cannot come in under it.
      const lineCost = Math.max(round2(input.qty * cost), live.minimumCharge ?? 0);
      const lineSell = Math.max(
        round2(input.qty * sell),
        // The floor is marked up the SAME way as the rate above it. Marking a
        // minimum on the standard chain while the rate ran at 15% would put the
        // line above its own arithmetic.
        live.minimumCharge ? sellExGstWithMarkup(live.minimumCharge, item.markupPercent) : 0,
      );
      const minApplied = live.minimumCharge != null && round2(input.qty * cost) < live.minimumCharge;

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
        lineType: z.enum(["material", "labour"]).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const { id, ...rest } = input;
      const [before] = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.id, id));
      if (!before) throw new ORPCError("NOT_FOUND", { message: "Line not found" });
      const quote = await editableQuoteOrThrow(before.quoteId);
      // Only an Admin can change what Terra pays or the markup on it. Office edits price and quantity only.
      const { markupPercent: markupIn, ...fields } = rest;
      if (context.actor.role !== "admin") delete fields.unitCost;
      const setMarkup = context.actor.role === "admin" ? markupIn : undefined;

      if (fields.kind !== undefined && fields.lineType === undefined) fields.lineType = lineTypeOf(fields.kind) as "material" | "labour";
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
      if (setMarkup !== undefined) {
        if (cost == null || cost <= 0) throw new ORPCError("BAD_REQUEST", { message: "Put a cost on the line first. Markup works off the cost." });
        unitPrice = sellAtMarkup(cost, setMarkup);
        markupPercent = setMarkup;
      } else if (fields.unitCost !== undefined && fields.unitPrice === undefined && before.unitCost != null && beforeMarkup != null && cost != null && cost > 0) {
        unitPrice = sellAtMarkup(cost, beforeMarkup);
        markupPercent = beforeMarkup;
      } else {
        markupPercent = markupOf(cost, unitPrice);
      }
      if (unitPrice !== before.unitPrice) fields.unitPrice = unitPrice;
      // Remember the price book price the first time a price is hand-edited.
      // The gap between it and the new price is the discount.
      const listUnitPrice =
        fields.unitPrice !== undefined && fields.unitPrice !== before.unitPrice && before.listUnitPrice === null
          ? before.unitPrice
          : undefined;
      await assertSentEditAllowed(
        quote,
        { id, qty, unitPrice, listUnitPrice: listUnitPrice ?? before.listUnitPrice },
        context.actor,
      );

      const [row] = await db
        .update(schema.quoteItems)
        .set({ ...fields, markupPercent, ...(listUnitPrice !== undefined ? { listUnitPrice } : {}), total: round2(qty * unitPrice), updatedAt: new Date() })
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

      const totals = await recalc(before.quoteId);
      return { item: hideCost(row, context.actor), totals };
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
      await db
        .update(schema.voiceQuoteCaptures)
        .set({ contactId: contact.id, updatedAt: new Date() })
        .where(eq(schema.voiceQuoteCaptures.quoteId, input.id));
      const name = `${contact.firstName} ${contact.lastName}`.trim();
      await db.insert(schema.activityLog).values({
        contactId: contact.id,
        jobId: quote.jobId,
        entityType: "quote",
        entityId: quote.id,
        action: "customer_set",
        detail: `${name} put on quote #${quote.number}${input.create ? " as a new client" : ""}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });
      return { contactId: contact.id, name };
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
      const [product] = await db.select().from(schema.products).where(eq(schema.products.id, input.productId));
      if (!product) throw new ORPCError("NOT_FOUND", { message: "Product not found" });

      const unitPrice = await liveSellFor(product);
      // Compare with the unit he said, not a wrong pick made a moment ago.
      const said = before.flagReason?.match(/^Was ([\d.]+) (\S+), this product sells by/);
      const saidUnit = said?.[2] ?? before.unit;
      const unitClash = Boolean(product.unit && saidUnit && product.unit !== saidUnit);
      const flagReason = unitClash
        ? `Was ${said?.[1] ?? before.qty} ${saidUnit}, this product sells by ${product.unit}. Check the quantity.`
        : unitPrice === 0
          ? "That product has no sell price yet. Put the price in."
          : null;

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
          total: round2(before.qty * unitPrice),
          flagged: Boolean(flagReason),
          flagReason,
          updatedAt: new Date(),
        })
        .where(eq(schema.quoteItems.id, input.id))
        .returning();

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
    await db.delete(schema.quoteItems).where(eq(schema.quoteItems.id, input.id));
    const totals = await recalc(before.quoteId);
    return { totals };
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
    await quoteOrThrow(input.id);
    const items = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, input.id));
    const pct = discountPercentOf(items);
    const [row] = await db
      .update(schema.quotes)
      .set({ discountApprovedPercent: pct, discountApprovedBy: context.actor.name, discountApprovedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.quotes.id, input.id))
      .returning();
    return row;
  }),

  send: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await editableQuoteOrThrow(input.id);
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
      detail: `Quote #${quote.number} marked as sent`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });

    return row;
  }),

  accept: staffOnly
    .input(z.object({ id: z.number(), note: z.string().optional() }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      if (quote.status === "accepted") throw new ORPCError("BAD_REQUEST", { message: "This quote is already accepted." });
      if (quote.status === "expired") throw new ORPCError("BAD_REQUEST", { message: "This version has expired. Accept the current version." });
      await assertReadyToGoOut(quote, context.actor);

      const [row] = await db
        .update(schema.quotes)
        .set({ status: "accepted", acceptedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.quotes.id, input.id))
        .returning();

      // Sibling versions of the same quote number lose.
      await db
        .update(schema.quotes)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(schema.quotes.number, quote.number),
            inArray(schema.quotes.status, ["draft", "sent"]),
            sql`${schema.quotes.id} != ${quote.id}`,
          ),
        );

      // Keep the linked job's value honest with the accepted price.
      if (quote.jobId) {
        await db
          .update(schema.jobs)
          .set({ value: quote.total, updatedAt: new Date() })
          .where(eq(schema.jobs.id, quote.jobId));
      }

      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "accepted",
        detail: input.note?.trim() || `Quote #${quote.number} accepted — $${quote.total.toFixed(2)}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  decline: staffOnly
    .input(z.object({ id: z.number(), reason: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const quote = await quoteOrThrow(input.id);
      if (quote.status === "accepted") throw new ORPCError("BAD_REQUEST", { message: "This quote is accepted and locked." });
      const [row] = await db
        .update(schema.quotes)
        .set({ status: "declined", updatedAt: new Date() })
        .where(eq(schema.quotes.id, input.id))
        .returning();

      await db.insert(schema.activityLog).values({
        jobId: quote.jobId,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "declined",
        detail: `Quote #${quote.number} declined — ${input.reason}`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return row;
    }),

  /** Copy a quote into a new version so the original stays as sent history. */
  revise: staffOnly.input(z.object({ id: z.number() })).handler(async ({ input, context }) => {
    const quote = await quoteOrThrow(input.id);
    const items = await db
      .select()
      .from(schema.quoteItems)
      .where(eq(schema.quoteItems.quoteId, quote.id))
      .orderBy(asc(schema.quoteItems.sortOrder));

    const [maxRow] = await db
      .select({ max: sql<number>`coalesce(max(${schema.quotes.version}), 1)` })
      .from(schema.quotes)
      .where(eq(schema.quotes.number, quote.number));

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
        depositPercent: quote.depositPercent,
        validUntil: quote.validUntil,
        notes: quote.notes,
        terms: quote.terms,
      })
      .returning();

    if (!row) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Revision not created" });

    if (items.length) {
      await db.insert(schema.quoteItems).values(
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
          total: i.total,
          sortOrder: idx,
        })),
      );
    }

    const totals = await recalc(row.id);

    await db.insert(schema.activityLog).values({
      jobId: quote.jobId,
      contactId: quote.contactId,
      entityType: "quote",
      entityId: row.id,
      action: "revised",
      detail: `Quote #${quote.number} v${row.version} created from v${quote.version}`,
      actorName: context.actor.name,
      actorRole: context.actor.role,
    });

    return { ...row, ...totals };
  }),

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

      const items = await db
        .select()
        .from(schema.quoteItems)
        .where(eq(schema.quoteItems.quoteId, quote.id))
        .orderBy(asc(schema.quoteItems.sortOrder));

      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${schema.jobs.number}), 200)` })
        .from(schema.jobs);
      const number = Number(maxRow?.max ?? 200) + 1;

      const [status] = await db
        .select({ id: schema.jobStatuses.id })
        .from(schema.jobStatuses)
        .where(eq(schema.jobStatuses.active, true))
        .orderBy(asc(schema.jobStatuses.sortOrder))
        .limit(1);

      const [site] = quote.siteId
        ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId))
        : [undefined];

      const [job] = await db
        .insert(schema.jobs)
        .values({
          number,
          title: input.title || site?.address || `Quote #${quote.number}`,
          statusId: status?.id ?? null,
          siteId: quote.siteId,
          contactId: quote.contactId,
          companyId: quote.companyId,
          // Billing is decided per job, not per person: a company on the quote
          // means the company pays, otherwise the person does.
          billToType: quote.companyId ? "company" : "contact",
          billToContactId: quote.companyId ? null : quote.contactId,
          billToCompanyId: quote.companyId ?? null,
          furnitureOnSite: input.furnitureOnSite,
          accessNotes: site?.accessNotes ?? null,
          value: quote.total,
          // The deposit the customer accepted. Drives the forecast and, later, the invoices.
          depositAmount: depositSplit(quote.total ?? 0, quote.depositPercent ?? 0).deposit,
        })
        .returning();

      if (!job) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Job not created" });

      if (quote.contactId) {
        await db
          .insert(schema.jobContacts)
          .values({
            jobId: job.id,
            contactId: quote.contactId,
            role: "job_contact",
            isPrimary: true,
            onSiteContact: true,
            receivesSms: true,
            receivesEmail: true,
            canApproveQuote: true,
          })
          .onConflictDoNothing();
      }

      if (quote.companyId && quote.supervisorContactId) {
        await db
          .insert(schema.jobContacts)
          .values({
            jobId: job.id,
            contactId: quote.supervisorContactId,
            role: "supervisor",
            isPrimary: true,
            receivesEmail: true,
            canApproveQuote: true,
          })
          .onConflictDoNothing();
      }

      // Supply lines become materials to order.
      const supplyLines = items.filter((i) => i.kind === "supply" || i.kind === "accessory");
      if (supplyLines.length) {
        await db.insert(schema.jobMaterials).values(
          supplyLines.map((i) => ({
            jobId: job.id,
            productId: i.productId,
            description: i.description,
            qty: i.qty,
            unit: i.unit,
            status: "to_order",
          })),
        );
      }

      // Work lines become unassigned tasks — one dispatch each.
      let tasksCreated = 0;
      if (input.createTasks) {
        const workLines = items.filter((i) => i.kind === "labour" || i.kind === "prep" || i.kind === "removal");
        const skills = await db
          .select()
          .from(schema.skills)
          .where(eq(schema.skills.active, true))
          .orderBy(asc(schema.skills.sortOrder));

        for (const [idx, line] of workLines.entries()) {
          const haystack = line.description.toLowerCase();
          const skill =
            skills.find((s) => haystack.includes(s.name.toLowerCase())) ??
            skills.find((s) => (line.kind === "removal" ? s.groupName === "demolition" : s.groupName === "prep"));

          const crewSize = input.furnitureOnSite ? 2 : (skill?.defaultCrewSize ?? 1);

          await db.insert(schema.jobTasks).values({
            jobId: job.id,
            skillId: skill?.id ?? null,
            title: line.description,
            status: "unassigned",
            areaM2: line.unit === "m2" ? line.qty : null,
            crewSize,
            seq: idx + 1,
          });
          tasksCreated += 1;
        }
      }

      await db
        .update(schema.quotes)
        .set({ jobId: job.id, updatedAt: new Date() })
        .where(eq(schema.quotes.id, quote.id));

      await db.insert(schema.activityLog).values({
        jobId: job.id,
        contactId: quote.contactId,
        entityType: "quote",
        entityId: quote.id,
        action: "converted",
        detail: `Quote #${quote.number} converted to job #${number} — ${tasksCreated} task(s), ${supplyLines.length} material line(s)`,
        actorName: context.actor.name,
        actorRole: context.actor.role,
      });

      return { job, tasksCreated, materialsCreated: supplyLines.length };
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
