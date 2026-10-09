import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Where a new quote's deposit % comes from. Damien's rules, 2026-10-06:
 *
 *   1. A company on the quote always wins. Its own % if one is set, otherwise
 *      0% for a builder and 50% for any other kind of company.
 *   2. No company: the contact's own %, otherwise 50%.
 *
 * This only ever PREFILLS a new quote. Changing a card never touches a quote
 * that already exists, and the % stays editable on every quote.
 */
export const STANDARD_DEPOSIT_PERCENT = 50;
export const BUILDER_DEPOSIT_PERCENT = 0;

export type DepositSource = "company" | "company_type" | "contact" | "standard";

export function depositDefaultOf(
  company: { type: string; depositPercent: number | null } | null | undefined,
  contact: { depositPercent: number | null } | null | undefined,
): { percent: number; source: DepositSource } {
  if (company) {
    if (company.depositPercent != null) return { percent: company.depositPercent, source: "company" };
    return {
      percent: company.type === "builder" ? BUILDER_DEPOSIT_PERCENT : STANDARD_DEPOSIT_PERCENT,
      source: "company_type",
    };
  }
  if (contact?.depositPercent != null) return { percent: contact.depositPercent, source: "contact" };
  return { percent: STANDARD_DEPOSIT_PERCENT, source: "standard" };
}

export async function depositDefaultFor(ids: { companyId?: number | null; contactId?: number | null }) {
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
  return depositDefaultOf(company, contact);
}

/** Deposit is taken off the GST inclusive total, the figure the customer pays. */
export function depositSplit(total: number, percent: number) {
  const deposit = Math.round(total * percent) / 100;
  return { deposit, balance: Math.round((total - deposit) * 100) / 100 };
}
