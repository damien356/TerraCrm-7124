import * as React from "react";
import { ShoppingCart } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { errorText } from "./public-shell";
import { unitLabel } from "./quote-pickers";
import { useSaleForJob, useSetStockAndOrder } from "../queries/productSales";

/* ---------------------------------------------------------------------------
 * On the job of a product sale (Damien, 30 Oct):
 * - Stock and ordering: change "From stock now" and draft POs for the rest.
 *   Nothing already on order is ordered again. Drafts only, never sent.
 * - Care guides by hand are in components/comms-guides.tsx (31 Oct): one
 *   picker for every job, with the recipient checks and "Send again".
 * ------------------------------------------------------------------------- */

const qtyText = (n: number, unit: string) => `${Number(n.toFixed(4))} ${unitLabel(unit)}`;

/**
 * Raise invoice now saves the lines as a quote and marks it accepted inside Ops
 * so the invoice has something to bill from. It was never sent and the customer
 * never accepted it (Damien, 31 Oct, job 188054).
 */
export const priceRecordText = (invoiceNumber: string | null | undefined) =>
  `Internal price record for invoice ${invoiceNumber ?? "raised with Sell products"}, not a customer acceptance.`;

export function SaleOrderCard({ jobId }: { jobId: number }) {
  const q = useSaleForJob(jobId);
  const order = useSetStockAndOrder();
  const [stock, setStock] = React.useState<Record<number, string>>({});
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const sale = q.data;

  // Reset only when the saved numbers change, not on every refetch while typing.
  const saved = sale ? JSON.stringify(sale.plan.map((l) => [l.lineId, l.fromStock])) : "";
  React.useEffect(() => {
    if (!saved) return;
    setStock(Object.fromEntries((JSON.parse(saved) as [number, number][]).map(([id, v]) => [id, String(v)])));
  }, [saved]);

  if (!sale || !sale.plan.length) return null;
  const want = (lineId: number, qty: number) => {
    const v = Number(stock[lineId] ?? "0");
    return Math.max(0, qty - (Number.isFinite(v) ? Math.min(qty, Math.max(0, v)) : 0));
  };
  const toOrder = sale.plan.map((l) => ({ l, more: Math.max(0, want(l.lineId, l.qty) - l.onOrder) })).filter((x) => x.more > 0.00005);

  async function go() {
    setMsg(null);
    for (const l of sale!.plan) {
      const v = Number(stock[l.lineId] ?? "0");
      if (!Number.isFinite(v) || v < 0) return setMsg({ ok: false, text: `"${l.description}": From stock now must be 0 or more.` });
      if (v > l.qty) return setMsg({ ok: false, text: `"${l.description}": From stock now is more than the ${qtyText(l.qty, l.unit)} sold.` });
    }
    try {
      const out = await order.mutateAsync({ jobId, fromStock: sale!.plan.map((l) => ({ lineId: l.lineId, qty: Number(stock[l.lineId] ?? "0") })) });
      setMsg({
        ok: true,
        text: out.added.length
          ? `Put on Materials to order: ${out.added.join("; ")}.${out.drafted.length ? ` Draft POs ${out.drafted.join(", ")}. Not sent.` : " No PO drafted, see the Purchase orders card."}`
          : "Nothing new to order. Everything is covered by stock or an existing order.",
      });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Card>
      <CardHeader
        title="Stock and ordering"
        subtitle={`Product sale, ${sale.salesCategory === "installer_materials" ? "installer materials" : "customer sale"}. ${sale.orderNeeded ? "Ordering is on." : "\"We need to order this\" was not ticked when it was sold. Draft POs below if it has to come from a supplier."}`}
      />
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full text-sm" data-testid="sale-plan">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border text-left">
              <th className="py-1.5 pr-2 font-medium">Line</th>
              <th className="py-1.5 pr-2 text-right font-medium">Sold</th>
              <th className="py-1.5 pr-2 text-right font-medium">From stock now</th>
              <th className="py-1.5 pr-2 text-right font-medium">On order</th>
              <th className="py-1.5 text-right font-medium">Still to order</th>
            </tr>
          </thead>
          <tbody>
            {sale.plan.map((l) => {
              const left = Math.max(0, want(l.lineId, l.qty) - l.onOrder);
              return (
                <tr key={l.lineId} className="border-b border-border align-top">
                  <td className="py-1.5 pr-2">
                    {l.description}
                    {l.pos.length ? <span className="block text-xs text-muted-foreground">{l.pos.map((p) => `${p.number} (${p.status})`).join(", ")}</span> : null}
                  </td>
                  <td className="tabular py-1.5 pr-2 text-right">{qtyText(l.qty, l.unit)}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <Input
                      className="tabular ml-auto w-20 text-right"
                      inputMode="decimal"
                      value={stock[l.lineId] ?? ""}
                      onChange={(e) => setStock((s) => ({ ...s, [l.lineId]: e.target.value }))}
                      aria-label={`${l.description} from stock now`}
                      disabled={!sale.quoteAccepted}
                    />
                  </td>
                  <td className="tabular py-1.5 pr-2 text-right">{l.onOrder > 0 ? qtyText(l.onOrder, l.unit) : "none"}</td>
                  <td className="tabular py-1.5 text-right">{left > 0.00005 ? qtyText(left, l.unit) : "none"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Ops keeps no stock counts. Type what comes off the shelf. Only the rest is ordered, less anything already on order. A smaller "From stock now" never cancels an order.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {!sale.quoteAccepted ? <span className="text-xs text-muted-foreground">Order once the quote is accepted.</span> : <span />}
          <Button size="sm" onClick={go} disabled={!sale.quoteAccepted || order.isPending || !toOrder.length} data-testid="sale-order">
            {order.isPending ? <Spinner className="border-white/40 border-t-white" /> : <ShoppingCart className="size-3.5" />}
            {toOrder.length ? `Draft POs for ${toOrder.length} line${toOrder.length === 1 ? "" : "s"}` : "Nothing to order"}
          </Button>
        </div>
        {msg ? <p className={`mt-2 text-xs ${msg.ok ? "text-[var(--success)]" : "text-destructive"}`}>{msg.text}</p> : null}
      </div>
    </Card>
  );
}

