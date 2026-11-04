import { ORPCError } from "@orpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { bad, BLOCKING, forbid, isLive, type PermActor, r4 } from "./core";
import { itemFactor, modeOf, productName, productNumbers, qtyLine, SHORT_LABEL, toStockUnits, type SupplyMode } from "./replenish";

/* ---------------------------------------------------------------------------
 * A2 (7D): container and stock-only products are never promised past what is
 * on the shelf. The shortage shows before a quote goes out or a sale is raised.
 *
 *  - An internal draft is fine. Sending the quote, or raising the sale as an
 *    invoice, stops until the line is changed or the main admin approves the
 *    shortage with a note (stock_supply_approvals).
 *  - Nothing here orders anything, refunds anything or says "incoming".
 *  - Only products set to "Stocked — owner-approved bulk/container
 *    replenishment" or "Stock only — no planned replenishment", that are
 *    counted ("We count this"), and only while stock (S1) is not off.
 *    Every product today is "Order for each job/sale", so nothing changes
 *    until a product is set by hand.
 * ------------------------------------------------------------------------- */

export type SupplyEntity = { entityType: "quote" | "sale"; entityKey: string };
export type SupplyLine = { productId: number | null; qty: number; unit: string | null };

export type SupplyShort = {
  productId: number;
  product: string;
  mode: SupplyMode;
  label: string;
  /** In the stock unit. Null: the line's unit does not convert, so it can not be compared. */
  need: number | null;
  available: number;
  heldForThis: number;
  short: number | null;
  text: string;
  approved: { byName: string; note: string; at: Date | null } | null;
};

const OWNER_REVIEW: SupplyMode[] = ["container", "stock_only"];

/** Shortages on these lines, for container and stock-only products only. Reads only. */
export async function supplyShorts(lines: SupplyLine[], jobId: number | null, entity: SupplyEntity | null): Promise<SupplyShort[]> {
  if (!(await isLive("s1"))) return [];
  const ids = [...new Set(lines.map((l) => l.productId).filter((x): x is number => x != null))];
  if (!ids.length) return [];
  const products = (await db.select().from(schema.products).where(inArray(schema.products.id, ids))).filter((p) => p.stockTracked && OWNER_REVIEW.includes(modeOf(p)));
  if (!products.length) return [];
  const nums = await productNumbers(products);
  const own = jobId
    ? await db
        .select()
        .from(schema.stockReservations)
        .where(and(eq(schema.stockReservations.jobId, jobId), inArray(schema.stockReservations.status, [...BLOCKING, "handed_over", "issued"])))
    : [];
  const ownItemIds = [...new Set(own.map((h) => h.stockItemId).filter((x): x is number => x != null))];
  const ownItems = ownItemIds.length ? await db.select().from(schema.stockItems).where(inArray(schema.stockItems.id, ownItemIds)) : [];
  const approvals = entity
    ? await db
        .select()
        .from(schema.stockSupplyApprovals)
        .where(and(eq(schema.stockSupplyApprovals.entityType, entity.entityType), eq(schema.stockSupplyApprovals.entityKey, entity.entityKey)))
    : [];

  const out: SupplyShort[] = [];
  for (const p of products) {
    const mine = lines.filter((l) => l.productId === p.id);
    let need: number | null = 0;
    for (const l of mine) {
      const s = toStockUnits(l.qty, l.unit, p);
      need = s == null || need == null ? null : r4(need + s);
    }
    const n = nums.get(p.id)!;
    const held = r4(
      own
        .filter((h) => h.productId === p.id)
        .reduce((a, h) => {
          const it = ownItems.find((i) => i.id === h.stockItemId);
          return a + Math.max(0, h.qty - h.collectedQty) * (it ? itemFactor(it, p) : 1);
        }, 0),
    );
    const short = need == null ? null : r4(Math.max(0, need - held - n.available));
    if (short != null && short <= 0.0001) continue;
    const mode = modeOf(p);
    const ok = approvals.find((a) => a.productId === p.id);
    const approved = ok && short != null && short <= ok.shortQty + 0.0001 ? { byName: ok.byName, note: ok.note, at: ok.createdAt ?? null } : null;
    out.push({
      productId: p.id,
      product: productName(p),
      mode,
      label: SHORT_LABEL[mode],
      need,
      available: n.available,
      heldForThis: held,
      short,
      text:
        short == null
          ? `${SHORT_LABEL[mode]}: ${productName(p)}. The line's unit does not compare with the stock count. Check the stock.`
          : `${SHORT_LABEL[mode]}: ${productName(p)} needs ${qtyLine(need!, p)}, ${qtyLine(n.available, p)} available${held > 0 ? `, ${qtyLine(held, p)} already held for this` : ""}. ${qtyLine(short, p)} short.`,
      approved,
    });
  }
  return out;
}

/** Throws when an unapproved shortage would go out to a customer. */
export async function assertSupplyOk(lines: SupplyLine[], jobId: number | null, entity: SupplyEntity) {
  const shorts = await supplyShorts(lines, jobId, entity);
  const open = shorts.filter((s) => !s.approved);
  if (!open.length) return shorts;
  throw new ORPCError("BAD_REQUEST", {
    message: `${open.map((s) => s.text).join(" ")} Change the ${entity.entityType === "quote" ? "quote" : "sale"}, or the owner approves the shortage first.`,
    data: { supplyShort: open },
  });
}

/** The main admin's explicit OK for one product's shortage on one quote or sale. Logged with a note. */
export async function approveSupplyShort(input: SupplyEntity & { productId: number; shortQty: number; note: string }, actor: PermActor) {
  if (!actor.isMainAdmin) throw forbid("Only the main admin can approve a stock shortage.");
  const note = input.note.trim();
  if (note.length < 5) throw bad("Say why it is OK to go ahead short.");
  if (!(input.shortQty > 0)) throw bad("Nothing is short.");
  await db
    .insert(schema.stockSupplyApprovals)
    .values({ entityType: input.entityType, entityKey: input.entityKey, productId: input.productId, shortQty: r4(input.shortQty), note: note.slice(0, 500), byName: actor.name })
    .onConflictDoUpdate({
      target: [schema.stockSupplyApprovals.entityType, schema.stockSupplyApprovals.entityKey, schema.stockSupplyApprovals.productId],
      set: { shortQty: r4(input.shortQty), note: note.slice(0, 500), byName: actor.name, updatedAt: new Date() },
    });
  return { ok: true };
}

/** A quote's supply lines, for the check. */
export async function quoteSupplyLines(quoteId: number): Promise<SupplyLine[]> {
  const items = await db
    .select({ productId: schema.quoteItems.productId, qty: schema.quoteItems.qty, unit: schema.quoteItems.unit, kind: schema.quoteItems.kind })
    .from(schema.quoteItems)
    .where(eq(schema.quoteItems.quoteId, quoteId));
  return items.filter((i) => i.kind !== "labour" && i.productId != null && i.qty > 0).map((i) => ({ productId: i.productId, qty: i.qty, unit: i.unit }));
}
