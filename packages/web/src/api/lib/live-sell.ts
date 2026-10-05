import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { priceProduct, todayISO } from "./pricing";

/**
 * The sell price a NEW quote line should carry today.
 *
 * Normally this is the stored `sellPrice`. The one exception is a live special
 * the office chose to hand to the customer: then the line is marked up off the
 * special cost instead. Lines already on a quote are never recalculated, so a
 * sent quote keeps the price the customer saw.
 */
export async function liveSellFor(product: {
  id: number;
  costPrice: number | null;
  sellPrice: number | null;
  priceOnApplication?: boolean;
  unit?: string | null;
}): Promise<number> {
  const specials = await db
    .select()
    .from(schema.productSpecials)
    .where(eq(schema.productSpecials.productId, product.id));
  if (specials.some((s) => s.passOnToCustomer)) {
    const priced = priceProduct(product, specials, todayISO());
    if (priced.passedOnToCustomer && priced.sellExGst !== null) return priced.sellExGst;
  }
  return product.sellPrice ?? 0;
}
