import { and, eq } from "drizzle-orm";
import { db } from "../../database";
import * as schema from "../../database/schema";
import { BLOCKING, bad, cm, ENDED, need, type PermActor, productKind, r4, stockRules } from "./core";
import { availableOn, holdById, holdsOnItem } from "./holds";
import { itemById } from "./items";
import { orderById } from "./orders";

/* ---------------------------------------------------------------------------
 * Free remainders (v3 section 3).
 *
 *   Carpet  supplying the order would leave less than 2.7 m: offer that piece free.
 *   Vinyl   2 m or less left: offer it free. Billed in m² = lm × actual width.
 *
 * Only supply-only buyers (installers included), never our installation
 * jobs. Never offered when another hold sits on the stock. Proposed by Ops,
 * held only once the office approves. The billed quantity and price band
 * never change: the free part is held, deducted and costed, never billed.
 * ------------------------------------------------------------------------- */

export type FreeOffer = { offer: boolean; freeQty: number; why: string };

/** The rule on its own, for the worked examples. Lengths compared to the centimetre. */
export function freeRule(kind: "carpet" | "vinyl" | "other", rollLeftM: number, orderedM: number, rules: { carpetKeepMinM: number; vinylFreeMaxM: number }): FreeOffer {
  const left = cm(rollLeftM - orderedM);
  if (left <= 0) return { offer: false, freeQty: 0, why: "Nothing left on the roll." };
  if (kind === "carpet") {
    return left < rules.carpetKeepMinM - 0.0001
      ? { offer: true, freeQty: left, why: `Would leave ${left} m, under ${rules.carpetKeepMinM} m.` }
      : { offer: false, freeQty: 0, why: `${left} m stays in stock.` };
  }
  if (kind === "vinyl") {
    return left <= rules.vinylFreeMaxM + 0.0001
      ? { offer: true, freeQty: left, why: `Would leave ${left} m, ${rules.vinylFreeMaxM} m or less.` }
      : { offer: false, freeQty: 0, why: `${left} m stays in stock.` };
  }
  return { offer: false, freeQty: 0, why: "Free remainders are for carpet and vinyl rolls only." };
}

async function offerFor(holdId: number): Promise<FreeOffer> {
  const h = await holdById(holdId);
  if (!h.stockItemId || !h.orderId) return { offer: false, freeQty: 0, why: "No roll chosen." };
  const order = await orderById(h.orderId);
  if (order.kind === "job") return { offer: false, freeQty: 0, why: "Installation jobs use issue and return, not free remainders." };
  const it = await itemById(h.stockItemId);
  if (it.unit !== "lm") return { offer: false, freeQty: 0, why: "Not a roll." };
  const others = (await holdsOnItem(it.id)).filter((o) => o.id !== h.id && !(ENDED as string[]).includes(o.status) && o.status !== "handed_over" && o.status !== "issued");
  if (others.length) return { offer: false, freeQty: 0, why: "Another hold sits on this roll." };
  const [p] = await db.select().from(schema.products).where(eq(schema.products.id, it.productId));
  return freeRule(productKind(p!), it.qty, h.qty - (h.freeState === "approved" ? h.freeQty : 0), await stockRules());
}

/** Ops proposes. Nothing extra is held until the office approves. */
export async function proposeFree(holdId: number) {
  const h = await holdById(holdId);
  if (h.freeState !== "none") return h;
  const offer = await offerFor(holdId);
  if (!offer.offer) return h;
  await db
    .update(schema.stockReservations)
    .set({ freeState: "proposed", freeQty: offer.freeQty, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.freeState, "none")));
  return holdById(h.id);
}

/** Office approves: the free part is added to what is held. Billed stays the same. */
export async function approveFree(holdId: number, actor: PermActor & { profileId: number | null }) {
  await need(actor, "allocate");
  const h = await holdById(holdId);
  if (h.freeState === "approved") return h;
  if (h.freeState !== "proposed") throw bad("No free remainder is proposed on this hold.");
  const offer = await offerFor(holdId);
  if (!offer.offer || Math.abs(offer.freeQty - h.freeQty) > 0.005) {
    await db.update(schema.stockReservations).set({ freeState: "none", freeQty: 0, updatedAt: new Date() }).where(eq(schema.stockReservations.id, h.id));
    throw bad(`The roll has changed, so the free remainder no longer applies. ${offer.why}`);
  }
  if ((BLOCKING as string[]).includes(h.status) && (await availableOn(h.stockItemId!, h.id)) < h.qty + h.freeQty - 0.0001) throw bad("The rest of the roll is no longer free.");
  const [row] = await db
    .update(schema.stockReservations)
    .set({ qty: cm(h.qty + h.freeQty), freeState: "approved", freeByName: actor.name, updatedAt: new Date() })
    .where(and(eq(schema.stockReservations.id, h.id), eq(schema.stockReservations.freeState, "proposed")))
    .returning();
  const { afterChange } = await import("./holds");
  await afterChange(h.jobId);
  return row ?? (await holdById(h.id));
}

export async function declineFree(holdId: number, actor: PermActor) {
  await need(actor, "allocate");
  const h = await holdById(holdId);
  if (h.freeState !== "proposed") throw bad("No free remainder is proposed on this hold.");
  await db.update(schema.stockReservations).set({ freeState: "declined", freeQty: 0, freeByName: actor.name, updatedAt: new Date() }).where(eq(schema.stockReservations.id, h.id));
  return holdById(h.id);
}

/** The five quantities for a hold, as shown on the order and the docket. */
export async function quantitiesOf(holdId: number) {
  const h = await holdById(holdId);
  const it = h.stockItemId ? await itemById(h.stockItemId) : null;
  const free = h.freeState === "approved" ? h.freeQty : 0;
  const supplied = h.qty;
  const width = it?.widthM ?? null;
  return {
    ordered: h.orderedQty,
    billed: h.billedQty,
    lineUnit: h.lineUnit,
    supplied,
    free,
    freeArea: width ? r4(free * width) : null,
    suppliedUnit: it?.unit ?? h.lineUnit,
    leftOnItem: it ? cm(it.qty - (h.status === "cut" || h.status === "picked" ? 0 : h.qty - h.collectedQty)) : null,
    note: free > 0 ? `Additional ${free} m${width && h.lineUnit === "m2" ? ` (${r4(free * width)} m²)` : ""} supplied at no charge.` : "",
  };
}
