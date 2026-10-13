import { eq } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";

/* ---------------------------------------------------------------------------
 * Supplier payment terms (188001 fix list item 16).
 *
 * Each supplier can carry its own terms on the supplier card, for example
 * Karndean 30 days EOM, or COD (0 days, no EOM: due the day it is ordered
 * or billed). Until a supplier's terms are set, Terra uses the one
 * rule it always used: 30 days EOM.
 *
 * No import from cashflow.ts here: cashflow reads these.
 * ------------------------------------------------------------------------- */

export type SupplierTerms = { days: number; eom: boolean; set: boolean };

/** The rule for a supplier with no terms set. */
export const DEFAULT_SUPPLIER_TERMS: SupplierTerms = { days: 30, eom: true, set: false };

type TermsCols = { termsDays: number | null; termsEom: boolean | null } | null | undefined;

export function termsOf(s: TermsCols): SupplierTerms {
  if (!s || s.termsDays == null || !Number.isFinite(s.termsDays) || s.termsDays < 0) return DEFAULT_SUPPLIER_TERMS;
  return { days: Math.round(s.termsDays), eom: s.termsEom ?? true, set: true };
}

export const supplierTermsText = (t: SupplierTerms): string =>
  t.eom ? `${t.days} days EOM` : t.days === 0 ? "COD" : `${t.days} days`;

/** One supplier's terms. A missing supplier gets the default. */
export async function termsForSupplier(supplierId: number | null | undefined): Promise<SupplierTerms> {
  if (!supplierId) return DEFAULT_SUPPLIER_TERMS;
  const [s] = await db
    .select({ termsDays: schema.suppliers.termsDays, termsEom: schema.suppliers.termsEom })
    .from(schema.suppliers)
    .where(eq(schema.suppliers.id, supplierId));
  return termsOf(s);
}

/** Every supplier's terms, for the forecast build. */
export async function supplierTermsMap(): Promise<Map<number, SupplierTerms>> {
  const rows = await db
    .select({ id: schema.suppliers.id, termsDays: schema.suppliers.termsDays, termsEom: schema.suppliers.termsEom })
    .from(schema.suppliers);
  return new Map(rows.map((r) => [r.id, termsOf(r)]));
}
