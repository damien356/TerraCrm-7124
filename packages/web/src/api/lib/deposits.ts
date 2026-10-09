import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Where a new quote's deposit % comes from. Damien's rules, 2026-10-06,
 * with the Queensland caps added 2026-10-09 (spec 0.1):
 *
 *   1. A company on the quote always wins. Its own % if one is set, otherwise
 *      0% for a builder and the QBCC cap for any other kind of company.
 *   2. No company: the contact's own %, otherwise the QBCC cap.
 *   3. For anyone who is not a builder, the default never goes above the cap
 *      for the quote total, even when the card says more.
 *
 * QBCC caps by quote total (GST inclusive):
 *   up to $3,300           20%
 *   $3,301 to $19,999      10%
 *   $20,000 and over        5%
 * More is allowed only where off-site work is over half the contract. There
 * is no tick for that yet, so the quote shows a warning and the office decides.
 *
 * This only ever PREFILLS a quote. The % stays editable on every quote. A
 * draft quote whose % is still on the default follows the cap as lines are
 * added (see recalc in routes/quotes.ts). A typed % stays put.
 */
export const BUILDER_DEPOSIT_PERCENT = 0;
/** The old flat default. Still used by the cash forecast, which has no quote total to cap against. */
export const STANDARD_DEPOSIT_PERCENT = 50;

/** Highest deposit % QBCC allows for a non-builder quote of this total. */
export function depositCapFor(total: number): number {
  if (total <= 3300) return 20;
  if (total < 20000) return 10;
  return 5;
}

export type DepositSource = "company" | "company_type" | "contact" | "standard";

/**
 * With `total`, the answer for a quote of that total, capped for non-builders.
 * Without it, the card % or the old flat 50% (the cash forecast only).
 */
export function depositDefaultOf(
  company: { type: string; depositPercent: number | null } | null | undefined,
  contact: { depositPercent: number | null } | null | undefined,
  total?: number,
): { percent: number; source: DepositSource; cap: number | null } {
  const isBuilder = company?.type === "builder";
  const cap = isBuilder || total === undefined ? null : depositCapFor(total);
  const capped = (n: number) => (cap === null ? n : Math.min(n, cap));
  const fallback = cap ?? STANDARD_DEPOSIT_PERCENT;
  if (company) {
    if (company.depositPercent != null) return { percent: capped(company.depositPercent), source: "company", cap };
    return { percent: isBuilder ? BUILDER_DEPOSIT_PERCENT : fallback, source: "company_type", cap };
  }
  if (contact?.depositPercent != null) return { percent: capped(contact.depositPercent), source: "contact", cap };
  return { percent: fallback, source: "standard", cap };
}

export async function depositDefaultFor(
  ids: { companyId?: number | null; contactId?: number | null },
  /** The quote total. A new quote starts at 0, so the cap starts at 20%. */
  total = 0,
) {
  const [company] = ids.companyId
    ? await db
        .select({ type: schema.companies.type, depositPercent: schema.companies.depositPercent })
        .from(schema.companies)
        .where(eq(schema.companies.id, ids.companyId))
    : [];
  const [contact] =
    !company && ids.contactId
      ? await db
          .select({ depositPercent: schema.contacts.depositPercent })
          .from(schema.contacts)
          .where(eq(schema.contacts.id, ids.contactId))
      : [];
  return depositDefaultOf(company, contact, total);
}

/** Deposit is taken off the GST inclusive total, the figure the customer pays. */
export function depositSplit(total: number, percent: number) {
  const deposit = Math.round(total * percent) / 100;
  return { deposit, balance: Math.round((total - deposit) * 100) / 100 };
}
