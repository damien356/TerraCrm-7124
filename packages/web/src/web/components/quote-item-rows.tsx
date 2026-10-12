import { moneyExact } from "../lib/money";
import { qtyText, unitText } from "../../api/lib/quote-layout";

/**
 * 188001 fix list item 1. The itemised layout a supply only quote shows the
 * client: one row per line, qty x rate and the line total, all ex GST.
 * Used on the public quote page and in the builder's preview.
 */

export type QuoteItemRow = { id: number; description: string; qty: number; unit: string; rate: number; total: number };

export function QuoteItemRows({ rows }: { rows: QuoteItemRow[] }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No lines yet.</p>;
  return (
    <div className="divide-y divide-border">
      {rows.map((r) => (
        <div key={r.id} className="flex items-baseline justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="text-sm font-medium">{r.description}</p>
            <p className="tabular text-xs text-muted-foreground">
              {qtyText(r.qty)} {unitText(r.unit)} at {moneyExact(r.rate)}
            </p>
          </div>
          <span className="tabular shrink-0 text-sm font-semibold">{moneyExact(r.total)}</span>
        </div>
      ))}
      <p className="pt-2 text-xs text-muted-foreground">All prices ex GST.</p>
    </div>
  );
}
