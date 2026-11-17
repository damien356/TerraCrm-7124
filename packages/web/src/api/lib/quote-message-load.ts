import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { depositInvoiceFor } from "./client-invoices";
import { jobRef, quoteRef, tagFromRef } from "./conversations";
import { depositSplit, quotePercent } from "./deposits";
import { tagForJob } from "./job-mail";
import { quoteMessageContext, type MessageFacts, type MessageLine } from "./quote-message-context";

/* ---------------------------------------------------------------------------
 * Reads what quote-message-context needs from the database (Damien, 17 Nov
 * 2026). Read only: nothing here writes, so the Send screen can call it as
 * often as it likes.
 * ------------------------------------------------------------------------- */

type Quote = typeof schema.quotes.$inferSelect;

/** The facts for one quote, from its own saved lines, job, photos and deposit. */
export async function quoteMessageFacts(quote: Quote): Promise<MessageFacts> {
  const items = await db
    .select({ item: schema.quoteItems, product: schema.products, rate: schema.labourRateItems })
    .from(schema.quoteItems)
    .leftJoin(schema.products, eq(schema.products.id, schema.quoteItems.productId))
    .leftJoin(schema.labourRateItems, eq(schema.labourRateItems.id, schema.quoteItems.rateItemId))
    .where(eq(schema.quoteItems.quoteId, quote.id))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  const lines: MessageLine[] = items.map((r) => ({
    kind: r.item.kind,
    description: r.item.description,
    category: r.product?.category ?? null,
    colour: r.product?.colour ?? null,
    hasProduct: !!r.product,
    rateGroup: r.rate?.groupName ?? null,
  }));

  const [job] = quote.jobId ? await db.select().from(schema.jobs).where(eq(schema.jobs.id, quote.jobId)) : [];

  /* Photos or video the client sent in: no crew member or office login on them. */
  const photos = quote.jobId
    ? await db
        .select({ id: schema.jobMedia.id })
        .from(schema.jobMedia)
        .where(
          and(
            eq(schema.jobMedia.jobId, quote.jobId),
            or(eq(schema.jobMedia.kind, "photo"), eq(schema.jobMedia.kind, "video")),
            isNull(schema.jobMedia.archivedAt),
            isNull(schema.jobMedia.uploadedByInstallerId),
            isNull(schema.jobMedia.uploadedByProfileId),
            or(isNull(schema.jobMedia.uploaderName), ne(schema.jobMedia.uploaderName, "Terra Ops")),
          ),
        )
        .limit(1)
    : [];

  /* A real visit: someone arrived on site, and it was not voided as a drive past. */
  const visits = quote.jobId
    ? await db
        .select({ id: schema.siteVisits.id })
        .from(schema.siteVisits)
        .where(and(eq(schema.siteVisits.jobId, quote.jobId), isNull(schema.siteVisits.voidedAt)))
        .limit(1)
    : [];

  const [rr] = await db
    .select()
    .from(schema.repairRequests)
    .where(quote.jobId ? or(eq(schema.repairRequests.quoteId, quote.id), eq(schema.repairRequests.jobId, quote.jobId)) : eq(schema.repairRequests.quoteId, quote.id))
    .limit(1);

  /* The suburb: the quote's site, then the job's, then the repair form. */
  let suburb = "";
  for (const siteId of [quote.siteId, job?.siteId]) {
    if (suburb || !siteId) continue;
    const [site] = await db.select({ suburb: schema.sites.suburb }).from(schema.sites).where(eq(schema.sites.id, siteId));
    suburb = (site?.suburb ?? "").trim();
  }
  if (!suburb) suburb = (rr?.suburb ?? "").trim();

  const { deposit } = depositSplit(quote.total, quotePercent(quote));
  const invoice = await depositInvoiceFor(quote.id);
  const depositPaid = invoice?.status === "paid" || !!job?.depositPaid;

  const picked = await db
    .select({ colour: schema.materialSelectionItems.colour })
    .from(schema.materialSelections)
    .innerJoin(schema.materialSelectionItems, eq(schema.materialSelectionItems.selectionId, schema.materialSelections.id))
    .where(
      and(
        eq(schema.materialSelections.status, "submitted"),
        or(eq(schema.materialSelections.quoteId, quote.id), quote.jobId ? eq(schema.materialSelections.jobId, quote.jobId) : sql`0`),
      ),
    );
  const coloursChosen = [...new Set(picked.map((c) => (c.colour ?? "").trim()).filter(Boolean))];

  /* Damien, 17 Nov 2026: the job's POs say pickup or delivery on a supply only quote. Cancelled ones never count. */
  const pos = quote.jobId
    ? await db
        .select({ deliverTo: schema.purchaseOrders.deliverTo, pickupName: schema.purchaseOrders.pickupName, pickupAddress: schema.purchaseOrders.pickupAddress })
        .from(schema.purchaseOrders)
        .where(and(eq(schema.purchaseOrders.jobId, quote.jobId), ne(schema.purchaseOrders.status, "cancelled")))
    : [];

  return {
    lines,
    photosReceived: photos.length > 0,
    siteVisitDone: visits.length > 0,
    suburb: suburb || null,
    repair: rr ? { type: rr.repairType, floorType: rr.floorType } : null,
    depositAmount: quotePercent(quote) > 0 ? deposit : 0,
    depositPaid,
    coloursChosen,
    trade: !!(quote.companyId ?? job?.companyId),
    fulfilment: quote.fulfilment === "pickup" || quote.fulfilment === "delivery" ? quote.fulfilment : null,
    pos,
  };
}

/** The wording for one quote. */
export async function quoteMessageContextFor(quote: Quote) {
  const facts = await quoteMessageFacts(quote);
  return { facts, ctx: quoteMessageContext(facts) };
}

/**
 * The tag the send adds to the end of the subject, such as "[#188116]".
 * Read only: it looks the thread up, it never opens one.
 */
export async function subjectTagFor(quote: Quote) {
  let [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.quoteId, quote.id)).limit(1);
  if (!conv && quote.jobId) [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.jobId, quote.jobId)).limit(1);
  if (conv) {
    const tag = tagFromRef((await tagForJob(conv, quote.jobId ?? conv.jobId)).ref);
    return tag ? `[${tag}]` : "";
  }
  if (quote.jobId) {
    const [j] = await db.select({ number: schema.jobs.number, displayNumber: schema.jobs.displayNumber }).from(schema.jobs).where(eq(schema.jobs.id, quote.jobId));
    if (j) return `[${tagFromRef(jobRef(j))}]`;
  }
  return `[${tagFromRef(quoteRef(quote.number))}]`;
}
