/**
 * Copy from previous job (Damien, 16 Oct, notes 18.46).
 *
 * Start a new quote off an old one: search, tick the lines, and the copy is
 * priced fresh off today's price book and rate book. The original quote and
 * its job are only ever read here. The only thing written about them is a
 * history row on the original job.
 *
 * Never copied: site notes, photos, SWMS, access notes, job dates, the quote's
 * own notes, bundles, and the supplier charge lines (rebuilt by recalc).
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { createQuoteRecord, lineTypeOf, productLineName, recalc } from "../routes/quotes";
import { liveSellFor } from "./live-sell";
import { markupOf } from "./pricing";
import { floorQty, floorTypeOf, type QtyResult } from "./flooring-qty";
import { linkedQty, qtyFlag, qtyForLine, standardLabour, wastageDefaultFor } from "./quote-labour";
import { followsAFloor, refollow, wholeUnits } from "./quote-sizes";
import { isChargeLine } from "./charge-fold";
import { LEGACY_SOURCE_NAMES } from "./lead-codes";
import { parseQuoteRef } from "./refs";
import { quoteRefOf } from "./quote-number";
import { sameClientOf } from "./quote-copy-links";

type Quote = typeof schema.quotes.$inferSelect;
type Line = typeof schema.quoteItems.$inferSelect;
type Product = typeof schema.products.$inferSelect;
type RateItem = typeof schema.labourRateItems.$inferSelect;

/** The stored source a follow-on job gets. The Settings list carries this exact name. */
export const REPEAT_SOURCE = LEGACY_SOURCE_NAMES.repeat ?? "Repeat client";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** m2 and lm lines are measured on site, so a copy is checked before it goes out. */
const MEASURE_UNIT = /^(m2|m²|sqm|lm|m)$/i;

/** Lines a copy asks someone to look at again: anything measured, all labour, and hand priced lines. */
export function needsCheck(l: { unit: string; lineType: string; measuredM2: number | null; productId: number | null; rateItemId: number | null }) {
  return MEASURE_UNIT.test(l.unit.trim()) || l.lineType === "labour" || l.measuredM2 != null || (l.productId == null && l.rateItemId == null);
}

/** Total floor m2 on a quote: measured m2, or the qty of an m2 line. Underlay and labour are left out so nothing counts twice. */
export function totalM2Of(lines: Line[]) {
  let m2 = 0;
  for (const l of lines) {
    if (isChargeLine(l) || l.lineType === "labour" || l.followsItemId != null || l.productId == null) continue;
    if (l.measuredM2 != null) m2 += l.measuredM2;
    else if (/^(m2|m²|sqm)$/i.test(l.unit.trim())) m2 += l.qty;
  }
  return round2(m2);
}

/** The biggest product lines by value, the way they read on the quote. */
export function mainProductsOf(lines: Line[], n = 3) {
  return lines
    .filter((l) => l.productId != null && l.lineType !== "labour" && !isChargeLine(l))
    .sort((a, b) => b.total - a.total)
    .slice(0, n)
    .map((l) => l.description);
}

function clientNameOf(contact: { firstName: string; lastName: string } | null, company: { name: string } | null) {
  const person = contact ? `${contact.firstName} ${contact.lastName}`.trim() : "";
  if (company && person) return `${company.name} (${person})`;
  return company?.name || person || "No client";
}

/* ------------------------------------------------------------------ search */

export type CopySearchHit = {
  id: number;
  ref: string;
  status: string;
  date: Date;
  client: string;
  contactId: number | null;
  companyId: number | null;
  address: string | null;
  mainProducts: string[];
  totalM2: number;
  total: number;
  /** The client already picked on the New quote screen. Listed first. */
  pickedClient: boolean;
};

/**
 * Past quotes to copy from. Matches the client's name, the site address, a
 * product on the quote, or the quote number. Only quotes with lines (the old
 * ServiceM8 jobs have none) and only the newest version of each number.
 */
export async function copySearch(input: { q: string; contactId?: number | null; companyId?: number | null; limit?: number }) {
  const rows = await db
    .select({ quote: schema.quotes, contact: schema.contacts, company: schema.companies, site: schema.sites })
    .from(schema.quotes)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.quotes.contactId))
    .leftJoin(schema.companies, eq(schema.companies.id, schema.quotes.companyId))
    .leftJoin(schema.sites, eq(schema.sites.id, schema.quotes.siteId))
    .where(
      and(
        sql`exists (select 1 from quote_items qi where qi.quote_id = ${schema.quotes.id} and qi.kind <> 'supplier_charge')`,
        sql`${schema.quotes.version} = (select max(q2.version) from quotes q2 where q2.number = ${schema.quotes.number})`,
      ),
    )
    .orderBy(desc(schema.quotes.createdAt))
    .limit(500);
  if (!rows.length) return [];

  const ids = rows.map((r) => r.quote.id);
  const lines = await db.select().from(schema.quoteItems).where(inArray(schema.quoteItems.quoteId, ids));
  const byQuote = new Map<number, Line[]>();
  for (const l of lines) byQuote.set(l.quoteId, [...(byQuote.get(l.quoteId) ?? []), l]);

  const q = input.q.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const ref = parseQuoteRef(input.q.trim());
  const digits = /^\d{3,}$/.test(q) ? Number(q) : null;

  const hits: (CopySearchHit & { score: number })[] = [];
  for (const r of rows) {
    const qLines = byQuote.get(r.quote.id) ?? [];
    const client = clientNameOf(r.contact, r.company);
    const address = r.site ? [r.site.address, r.site.suburb].filter(Boolean).join(", ") : null;
    let score = 0;
    if (words.length) {
      if ((ref && ref.number === r.quote.number) || (digits != null && digits === r.quote.number)) score = 4;
      else {
        const hay = [
          client,
          r.contact?.email ?? "",
          address ?? "",
          r.site?.postcode ?? "",
          ...qLines.filter((l) => !isChargeLine(l)).map((l) => l.description),
        ]
          .join(" ")
          .toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
        score = 1;
      }
    }
    const picked =
      (input.companyId != null && r.quote.companyId === input.companyId) ||
      (input.contactId != null && r.quote.contactId === input.contactId);
    hits.push({
      id: r.quote.id,
      ref: await quoteRefOf(r.quote),
      status: r.quote.status,
      date: r.quote.createdAt,
      client,
      contactId: r.quote.contactId,
      companyId: r.quote.companyId,
      address,
      mainProducts: mainProductsOf(qLines),
      totalM2: totalM2Of(qLines),
      total: r.quote.total,
      pickedClient: picked,
      score,
    });
  }
  // The picked client's quotes first, then a quote number match, then newest.
  hits.sort((a, b) => Number(b.pickedClient) - Number(a.pickedClient) || b.score - a.score || +b.date - +a.date);
  return hits.slice(0, input.limit ?? 30).map(({ score: _score, ...h }) => h);
}

/* ----------------------------------------------------------------- preview */

export type CopyLinePreview = {
  itemId: number;
  description: string;
  qty: number;
  unit: string;
  lineType: string;
  measuredM2: number | null;
  /** The sell it went out at, and today's. Today's is null when it cannot be priced. */
  oldUnitPrice: number;
  newUnitPrice: number | null;
  /** Ticked by default. Site prep starts unticked. */
  ticked: boolean;
  sitePrep: boolean;
  /** Red: gone from the price book, discontinued, or no standard rate. A product can be swapped. */
  missing: string | null;
  canReplace: boolean;
  productId: number | null;
  /** The floor line this install or underlay goes with. */
  linkedTo: number | null;
  /** Yellow on the new quote. */
  checkRequired: boolean;
  /** Hand priced: no price book product and no rate. Keeps the price it had. */
  keepsOldPrice: boolean;
};

type Facts = { product: Product | null; rate: RateItem | null; missing: string | null; sitePrep: boolean };

async function factsFor(lines: Line[]): Promise<Map<number, Facts>> {
  const pIds = [...new Set(lines.map((l) => l.productId).filter((v): v is number => v != null))];
  const rIds = [...new Set(lines.map((l) => l.rateItemId).filter((v): v is number => v != null))];
  const products = pIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, pIds)) : [];
  const rates = rIds.length ? await db.select().from(schema.labourRateItems).where(inArray(schema.labourRateItems.id, rIds)) : [];
  const pById = new Map(products.map((p) => [p.id, p]));
  const rById = new Map(rates.map((r) => [r.id, r]));
  const out = new Map<number, Facts>();
  for (const l of lines) {
    // A product on a quote is never deleted (lib/product-delete.ts), only switched off.
    const product = l.productId != null ? (pById.get(l.productId) ?? null) : null;
    const rate = l.rateItemId != null ? (rById.get(l.rateItemId) ?? null) : null;
    let missing: string | null = null;
    if (l.productId != null && !product) missing = "No longer in the price book";
    else if (product && !product.active) missing = "Discontinued";
    else if (l.rateItemId != null && !rate) missing = "No longer in the rate book";
    else if (rate && !rate.active) missing = "This labour item is switched off in the rate book";
    out.set(l.id, { product, rate, missing, sitePrep: Boolean(product?.sitePrep || rate?.sitePrep) });
  }
  return out;
}

/** Lines that are copied at all. The supplier charge lines are always rebuilt. */
const copyable = (lines: Line[]) => lines.filter((l) => !isChargeLine(l));

async function sourceOrThrow(id: number) {
  const [q] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, id));
  if (!q) throw new ORPCError("NOT_FOUND", { message: "Quote not found" });
  const lines = await db
    .select()
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, id))
    .orderBy(asc(schema.quoteItems.sortOrder), asc(schema.quoteItems.id));
  return { quote: q, lines: copyable(lines) };
}

/** Every line on the old quote, with its tick, today's price, and red when it cannot be copied as it is. */
export async function copyPreview(quoteId: number) {
  const { quote, lines } = await sourceOrThrow(quoteId);
  const facts = await factsFor(lines);
  const [contact] = quote.contactId ? await db.select().from(schema.contacts).where(eq(schema.contacts.id, quote.contactId)) : [];
  const [company] = quote.companyId ? await db.select().from(schema.companies).where(eq(schema.companies.id, quote.companyId)) : [];
  const [site] = quote.siteId ? await db.select().from(schema.sites).where(eq(schema.sites.id, quote.siteId)) : [];

  const out: CopyLinePreview[] = [];
  for (const l of lines) {
    const f = facts.get(l.id)!;
    let newUnitPrice: number | null = null;
    let missing = f.missing;
    if (!missing && f.product) newUnitPrice = await liveSellFor(f.product);
    else if (!missing && f.rate) {
      try {
        newUnitPrice = (await standardLabour(f.rate.id, l.qty)).sell;
      } catch (e) {
        missing = e instanceof Error ? e.message : "No standard rate";
      }
    } else if (!missing) newUnitPrice = l.unitPrice;
    out.push({
      itemId: l.id,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      lineType: l.lineType,
      measuredM2: l.measuredM2,
      oldUnitPrice: l.unitPrice,
      newUnitPrice,
      ticked: !f.sitePrep,
      sitePrep: f.sitePrep,
      missing,
      canReplace: l.productId != null,
      productId: l.productId,
      linkedTo: l.labourForItemId ?? l.followsItemId ?? null,
      checkRequired: needsCheck(l),
      keepsOldPrice: l.productId == null && l.rateItemId == null,
    });
  }
  return {
    quote: {
      id: quote.id,
      ref: await quoteRefOf(quote),
      status: quote.status,
      date: quote.createdAt,
      client: clientNameOf(contact ?? null, company ?? null),
      contactId: quote.contactId,
      companyId: quote.companyId,
      address: site ? [site.address, site.suburb].filter(Boolean).join(", ") : null,
      hasClient: quote.contactId != null || quote.companyId != null,
    },
    lines: out,
  };
}

/* ------------------------------------------------------------------ create */

export type CopyCreateInput = {
  fromQuoteId: number;
  /** same: follow-on for the same client and site. other: products and qty only, nobody on it yet. */
  mode: "same" | "other";
  /** The ticked lines. A red product line needs replaceProductId. */
  lines: { itemId: number; replaceProductId?: number | null }[];
};

type NewLine = typeof schema.quoteItems.$inferInsert;

/** Make the copy. Returns the new quote. Nothing on the original quote or job changes. */
export async function copyCreate(input: CopyCreateInput, actor: Actor) {
  const { quote: src, lines: all } = await sourceOrThrow(input.fromQuoteId);
  const picked = new Map(input.lines.map((l) => [l.itemId, l]));
  const lines = all.filter((l) => picked.has(l.id));
  if (!lines.length) throw new ORPCError("BAD_REQUEST", { message: "Tick at least one line to copy." });
  if (input.lines.some((l) => !all.some((a) => a.id === l.itemId))) {
    throw new ORPCError("BAD_REQUEST", { message: "A ticked line is not on that quote." });
  }
  if (input.mode === "same" && src.contactId == null && src.companyId == null) {
    throw new ORPCError("BAD_REQUEST", { message: "That quote has no client on it. Copy it for another client instead." });
  }

  const facts = await factsFor(lines);
  // Replacements: an active product off the price book.
  const swapIds = [...new Set(input.lines.map((l) => l.replaceProductId).filter((v): v is number => v != null))];
  const swaps = swapIds.length ? await db.select().from(schema.products).where(inArray(schema.products.id, swapIds)) : [];
  const swapById = new Map(swaps.map((p) => [p.id, p]));
  for (const id of swapIds) {
    const p = swapById.get(id);
    if (!p || !p.active) throw new ORPCError("BAD_REQUEST", { message: "A replacement product is not in the price book. Pick another one." });
  }

  // Work every line out before anything is written, so a red line stops the copy cleanly.
  const productFor = new Map<number, Product>();
  const problems: string[] = [];
  for (const l of lines) {
    const f = facts.get(l.id)!;
    const swap = picked.get(l.id)?.replaceProductId;
    if (swap != null) {
      if (l.rateItemId != null) problems.push(`${l.description}: labour cannot take a product. Untick it.`);
      else productFor.set(l.id, swapById.get(swap)!);
      continue;
    }
    if (f.missing) {
      problems.push(`${l.description}: ${f.missing.toLowerCase()}. ${l.rateItemId != null ? "Untick it." : "Pick a replacement or untick it."}`);
      continue;
    }
    if (f.product) productFor.set(l.id, f.product);
  }
  if (problems.length) throw new ORPCError("BAD_REQUEST", { message: `Fix these before copying. ${problems.join(" ")}` });

  // Product lines first: their qty comes off the measured m2 again, on the product as it is today,
  // never below the old qty on the same product.
  const values = new Map<number, NewLine>();
  const measuredRes = new Map<number, QtyResult | null>();
  for (const [idx, l] of lines.entries()) {
    const product = productFor.get(l.id);
    if (!product) continue;
    const swapped = product.id !== l.productId;
    const unitPrice = await liveSellFor(product);
    const measured = l.measuredM2 != null && floorTypeOf(product) ? l.measuredM2 : null;
    const wastagePct = measured != null ? (l.wastagePct ?? (await wastageDefaultFor(product))) : null;
    const rollWidthM = measured != null && !product.widthM ? (l.rollWidthM ?? null) : null;
    const res = measured != null ? floorQty(product, measured, wastagePct ?? 0, rollWidthM) : null;
    measuredRes.set(l.id, res);
    const sized = !res && !followsAFloor(product) ? wholeUnits(product, l.qty) : null;
    // A floor qty someone bumped up by hand (carpet cuts, extra boxes) is kept, unless the product was swapped.
    const keepsOld = res != null && !swapped && l.qty > res.qty;
    const qty = res ? (keepsOld ? l.qty : res.qty) : (sized?.qty ?? l.qty);
    const flag = qtyFlag(res) ?? sized?.flag ?? (unitPrice === 0 ? "That product has no sell price yet. Put the price in." : null);
    const kind = swapped ? (product.category === "labour" ? "labour" : "supply") : l.kind;
    values.set(l.id, {
      quoteId: 0,
      productId: product.id,
      kind,
      lineType: lineTypeOf(kind),
      description: swapped ? productLineName(product) || product.sku || l.description : l.description,
      qty,
      unit: product.unit || l.unit,
      unitPrice,
      listUnitPrice: null,
      unitCost: product.costPrice ?? null,
      markupPercent: markupOf(product.costPrice, unitPrice),
      total: round2(qty * unitPrice),
      sortOrder: idx,
      measuredM2: measured,
      wastagePct,
      rollWidthM,
      floorCategory: l.floorCategory,
      flagged: Boolean(flag),
      flagReason: flag,
    });
  }

  // Then labour: today's standard rate, and an install's qty off its floor line as copied, never below its old qty.
  for (const [idx, l] of lines.entries()) {
    if (values.has(l.id)) continue;
    const f = facts.get(l.id)!;
    if (f.rate) {
      const parent = l.labourForItemId != null ? values.get(l.labourForItemId) : undefined;
      const parentProduct = l.labourForItemId != null ? productFor.get(l.labourForItemId) : undefined;
      const worked =
        parent && parentProduct
          ? linkedQty(
              measuredRes.get(l.labourForItemId!) ??
                qtyForLine(parentProduct, { measuredM2: parent.measuredM2 ?? null, wastagePct: parent.wastagePct ?? null, rollWidthM: parent.rollWidthM ?? null }),
              f.rate.unit,
              parent.qty ?? l.qty,
            )
          : l.qty;
      // Same as the floor: a hand bumped install qty is kept, unless its floor was swapped for another product.
      const parentSwapped = parentProduct != null && lines.find((x) => x.id === l.labourForItemId)?.productId !== parentProduct.id;
      const qty = parent && parentProduct && !parentSwapped ? Math.max(worked, l.qty) : worked;
      const priced = await standardLabour(f.rate.id, qty).catch((e: unknown) => {
        throw new ORPCError("BAD_REQUEST", { message: `${l.description}: ${e instanceof Error ? e.message : "no standard rate"} Untick it.` });
      });
      values.set(l.id, {
        quoteId: 0,
        ...priced.values,
        description: l.description,
        floorCategory: l.floorCategory,
        sortOrder: idx,
      });
      continue;
    }
    // Typed by hand: no price book product and no rate, so it keeps the price it had. Checked like the rest.
    values.set(l.id, {
      quoteId: 0,
      productId: null,
      kind: l.kind,
      lineType: l.lineType,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unitPrice,
      listUnitPrice: l.listUnitPrice,
      unitCost: l.unitCost,
      markupPercent: l.markupPercent,
      priceBy: l.priceBy,
      total: round2(l.qty * l.unitPrice),
      floorCategory: l.floorCategory,
      sortOrder: idx,
    });
  }

  // The new quote. Same client: a new job at Lead, new number, same client and site, Repeat client.
  const same = input.mode === "same";
  const created = await createQuoteRecord(
    {
      jobId: null,
      contactId: same ? src.contactId : null,
      companyId: same ? src.companyId : null,
      supervisorContactId: same ? src.supervisorContactId : null,
      siteId: same ? src.siteId : null,
      people: [],
      makeJob: same,
      source: same ? REPEAT_SOURCE : undefined,
      validDays: 30,
      notes: null,
      items: [],
    },
    actor,
    same ? { noAccessNotes: true } : { waitForClient: true },
  );

  await db.update(schema.quotes).set({ copiedFromQuoteId: src.id, layout: src.layout, updatedAt: new Date() }).where(eq(schema.quotes.id, created.id));

  const ordered = lines.map((l) => {
    const v = values.get(l.id)!;
    return { ...v, quoteId: created.id, checkRequired: needsCheck({ unit: v.unit ?? "", lineType: v.lineType ?? "", measuredM2: v.measuredM2 ?? null, productId: v.productId ?? null, rateItemId: v.rateItemId ?? null }) };
  });
  const inserted = await db.insert(schema.quoteItems).values(ordered).returning({ id: schema.quoteItems.id, sortOrder: schema.quoteItems.sortOrder });
  const newIdAt = new Map(inserted.map((r) => [r.sortOrder, r.id]));
  const newIdFor = new Map(lines.map((l, idx) => [l.id, newIdAt.get(idx)]));
  // Installs and underlay stay with their own floor line, when that line came across too.
  const underlays: number[] = [];
  for (const [idx, l] of lines.entries()) {
    const self = newIdAt.get(idx);
    if (!self) continue;
    const parent = l.labourForItemId != null ? newIdFor.get(l.labourForItemId) : undefined;
    const floor = l.followsItemId != null ? newIdFor.get(l.followsItemId) : undefined;
    if (parent || floor) {
      await db
        .update(schema.quoteItems)
        .set({ ...(parent ? { labourForItemId: parent } : {}), ...(floor ? { followsItemId: floor } : {}) })
        .where(eq(schema.quoteItems.id, self));
    }
    const p = productFor.get(l.id);
    if (floor && p && followsAFloor(p)) underlays.push(self);
  }
  // Underlay works its qty out off its copied floor, as on any quote.
  for (const id of underlays) await refollow(id);

  // Freight, baling and the other supplier charges come back on their own lines, pallets counted off the new qty.
  const totals = await recalc(created.id);

  const [fresh] = await db.select().from(schema.quotes).where(eq(schema.quotes.id, created.id));
  const newRef = await quoteRefOf(fresh!);
  const oldRef = await quoteRefOf(src);
  const label = same ? `Follow-on from ${oldRef}` : `Copied from ${oldRef}`;
  await db.insert(schema.activityLog).values([
    {
      jobId: fresh!.jobId,
      contactId: fresh!.contactId,
      entityType: "quote",
      entityId: created.id,
      action: "copied_from",
      detail: `${label}. ${lines.length} line${lines.length === 1 ? "" : "s"} copied, priced today.`,
      actorName: actor.name,
      actorRole: actor.role,
    },
    {
      jobId: src.jobId,
      contactId: src.contactId,
      entityType: "quote",
      entityId: src.id,
      action: "copied_to",
      detail: `Copied to ${newRef}${same ? " as a follow-on" : " for another client"}`,
      actorName: actor.name,
      actorRole: actor.role,
    },
  ]);

  return { id: created.id, ref: newRef, jobId: fresh!.jobId, sameClient: same, totals };
}

/** The client record: their quotes, with each copy listed under the quote it came from. */
export async function quotesForClient(input: { contactId?: number | null; companyId?: number | null }) {
  // A company also owns quotes on its jobs, even when the quote itself only names the contact.
  const where =
    input.companyId != null
      ? or(
          eq(schema.quotes.companyId, input.companyId),
          inArray(
            schema.quotes.jobId,
            db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.companyId, input.companyId)),
          ),
        )
      : input.contactId != null
        ? eq(schema.quotes.contactId, input.contactId)
        : null;
  if (!where) return [];
  const rows = await db.select().from(schema.quotes).where(where).orderBy(desc(schema.quotes.number), desc(schema.quotes.version));
  // Newest version per number only.
  const newest = new Map<number, Quote>();
  for (const r of rows) if (!newest.has(r.number)) newest.set(r.number, r);
  const list = [...newest.values()];
  const numberOfId = new Map(rows.map((r) => [r.id, r.number]));
  const all = new Map(list.map((q) => [q.number, q]));
  // Each copy hangs under the original's number, when that original is on this record.
  const parentOf = (q: Quote) => {
    if (q.copiedFromQuoteId == null) return null;
    const n = numberOfId.get(q.copiedFromQuoteId);
    return n != null && n !== q.number && all.has(n) ? n : null;
  };
  // A copy of a copy still sits under the first quote in the chain.
  const rootOf = (q: Quote) => {
    let cur = q;
    for (let hops = 0; hops < 20; hops++) {
      const n = parentOf(cur);
      if (n == null) break;
      cur = all.get(n)!;
    }
    return cur.number;
  };
  const out = [];
  for (const q of list) {
    if (parentOf(q) != null) continue;
    const kids = list.filter((k) => k.number !== q.number && rootOf(k) === q.number);
    out.push({
      ...(await rowOf(q, null)),
      copies: await Promise.all(kids.map((k) => rowOf(k, q))),
    });
  }
  return out;
}

async function rowOf(q: Quote, parent: Quote | null) {
  return {
    id: q.id,
    ref: await quoteRefOf(q),
    status: q.status,
    total: q.total,
    jobId: q.jobId,
    createdAt: q.createdAt,
    copiedFromQuoteId: q.copiedFromQuoteId,
    sameClient: parent ? sameClientOf(q, parent) : null,
  };
}
