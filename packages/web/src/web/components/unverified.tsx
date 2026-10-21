/**
 * Every figure here is Terra's own record: invoices read from email, less the
 * ones marked paid by a statement or by hand. Xero is not connected, so
 * payments, credits, reversals and voids entered only in Xero are not in it.
 * Damien's wording (21 Oct), shown wherever a supplier balance or amount owed is.
 */
export const UNVERIFIED_LEAD = "UNVERIFIED";
export const UNVERIFIED_REST = "Do not rely on this balance for payment decisions until Xero is connected. Payments, credits, reversals or voids may be missing.";
export const UNVERIFIED = `${UNVERIFIED_LEAD} \u2014 ${UNVERIFIED_REST}`;

/** The warning as a line of text, bold lead word. */
export function Unverified({ className = "" }: { className?: string }) {
  return (
    <span className={`block text-xs text-[var(--warning)] ${className}`} data-testid="balance-unverified">
      <span className="font-bold">{UNVERIFIED_LEAD}</span> {"\u2014"} {UNVERIFIED_REST}
    </span>
  );
}
