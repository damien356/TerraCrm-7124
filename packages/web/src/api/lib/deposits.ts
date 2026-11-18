import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/**
 * Where a quote's deposit % comes from. Damien's rules, notes 18.54:
 *
 *   The % lives on the card of whoever the quote is billed to (its Bill to).
 *   A company billed: the company's %. A person billed: that person's %,
 *   even when they also work for a company. No guessing: a card with no %
 *   gives null, and the office is asked for it (it then saves on the card).
 *
 * The % stays editable on a single quote without touching the card.
 */
export type DepositSource = "company" | "contact" | "none";

export function depositDefaultOf(
  company: { depositPercent: number | null } | null | undefined,
  contact: { depositPercent: number | null } | null | undefined,
): { percent: number | null; source: DepositSource } {
  if (company) return company.depositPercent != null ? { percent: company.depositPercent, source: "company" } : { percent: null, source: "none" };
  if (contact?.depositPercent != null) return { percent: contact.depositPercent, source: "contact" };
  return { percent: null, source: "none" };
}

/** The card % of a Bill to. A company id wins when both are passed, the same as billing a company. */
export async function depositDefaultFor(ids: { companyId?: number | null; contactId?: number | null }) {
  const [company] = ids.companyId
    ? await db.select({ depositPercent: schema.companies.depositPercent }).from(schema.companies).where(eq(schema.companies.id, ids.companyId))
    : [];
  const [contact] =
    !company && ids.contactId
      ? await db.select({ depositPercent: schema.contacts.depositPercent }).from(schema.contacts).where(eq(schema.contacts.id, ids.contactId))
      : [];
  return depositDefaultOf(company, contact);
}

/** The % a quote's figures use. A quote still waiting for its payer's % (source none) has no deposit yet. */
export function quotePercent(q: { depositPercent: number | null; depositSource?: string | null }) {
  return q.depositSource === "none" ? 0 : (q.depositPercent ?? 0);
}

/** Deposit is taken off the GST inclusive total, the figure the customer pays. */
export function depositSplit(total: number, percent: number) {
  const deposit = Math.round(total * percent) / 100;
  return { deposit, balance: Math.round((total - deposit) * 100) / 100 };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const moneyText = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type QuoteDepositInput = {
  total: number | null;
  depositPercent: number | null;
  depositSource?: string | null;
  depositFixed?: number | null;
};

/**
 * Damien, 18 Nov 2026. A quote's deposit, as a % of the total or a fixed $
 * amount (GST inclusive) typed for that quote. Every figure the customer and
 * the office see comes from here, so the PDF, the link, the emails, the
 * deposit invoice and the forecast always agree.
 *
 * A fixed amount over the total is capped at the total. percent is the real
 * % for a fixed deposit (to 2 places), for anything that works in percent,
 * like stock holds. words is how the quote says it: "50%" or "$1,000.00".
 */
export function quoteDeposit(q: QuoteDepositInput) {
  const total = round2(q.total ?? 0);
  if (q.depositSource !== "none" && q.depositFixed != null && q.depositFixed > 0) {
    const deposit = round2(Math.max(0, Math.min(q.depositFixed, total)));
    const percent = total > 0 ? Math.round((deposit / total) * 10000) / 100 : 0;
    return { deposit, balance: round2(total - deposit), percent, fixed: deposit as number | null, words: moneyText(deposit) };
  }
  const percent = quotePercent(q);
  const { deposit, balance } = depositSplit(total, percent);
  return { deposit, balance, percent, fixed: null as number | null, words: `${percent}%` };
}
