import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { feeView, quoteSnapshot, type ReferralSnapshot } from "./referral-fees";
import { foldFee, priceWithoutFee } from "./referral-fold";
import { foldForClient } from "./quote-freight";

/* ---------------------------------------------------------------------------
 * Notes 18.47. The referral fee on the office quote view. An Admin reads it as
 * its own line. Office (and anyone who is not an Admin) gets the lines with
 * the fee spread in, the same as the client copy, and never the fee itself.
 * ------------------------------------------------------------------------- */

export type StaffFee = { snap: ReferralSnapshot | null; view: ReturnType<typeof feeView>; adminAmount: number };

export async function feeForStaff(quoteId: number, actor: Pick<Actor, "role">): Promise<StaffFee> {
  const snap = await quoteSnapshot(quoteId);
  const admin = actor.role === "admin";
  return { snap, view: admin ? feeView(snap) : null, adminAmount: admin ? (snap?.amount ?? 0) : 0 };
}

/** The lines a non-Admin reads: the fee spread in. An Admin gets them as they are. */
export function feeLinesForStaff<T extends { id: number; qty: number; unitPrice: number; total: number }>(lines: T[], fee: StaffFee, actor: Pick<Actor, "role">) {
  if (actor.role === "admin" || !fee.snap?.amount) return lines;
  return foldFee(lines, fee.snap.amount).lines;
}

/**
 * A price typed on a line by someone who reads it with the fee (and, without
 * costs, the supplier charges) spread in, taken back to Terra's own price.
 */
export async function typedPriceWithoutFee(before: typeof schema.quoteItems.$inferSelect, typed: number, actor: Pick<Actor, "role" | "canSeeCosts">) {
  const peers = await db.select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, before.quoteId));
  const charged = actor.canSeeCosts ? { lines: peers, shares: new Map<number, number>() } : await foldForClient(peers);
  const snap = actor.role === "admin" ? null : await quoteSnapshot(before.quoteId);
  let price = typed;
  if (snap && snap.amount > 0) {
    const share = foldFee(charged.lines, snap.amount).shares.get(before.id) ?? 0;
    price = priceWithoutFee(price, before.qty, snap, share);
  }
  const chargeShare = charged.shares.get(before.id) ?? 0;
  if (chargeShare && before.qty > 0) price = Math.round((price - chargeShare / before.qty) * 100) / 100;
  return price;
}
