import * as React from "react";
import { Link } from "wouter";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { moneyExact as money } from "../lib/money";
import { invoiceStatusText } from "../lib/invoice-status";
import { useSalesByCategory } from "../queries/finance";

/**
 * SALES BY CATEGORY (Task H, Damien 29 Oct).
 *
 * Customer sales and installer materials sales apart, by the sales category
 * on each invoice. How it was paid (bank, card, contra) is shown under each,
 * so a contra never moves a materials sale out of materials sales.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function ranges() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const fyStart = m >= 6 ? y : y - 1;
  return [
    { key: "month", label: "This month", from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) },
    { key: "last", label: "Last month", from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) },
    { key: "fy", label: "This financial year", from: `${fyStart}-07-01`, to: `${fyStart + 1}-06-30` },
    { key: "all", label: "All", from: null, to: null },
  ] as const;
}

export function SalesByCategoryCard() {
  const opts = React.useMemo(ranges, []);
  const [key, setKey] = React.useState<(typeof opts)[number]["key"]>("fy");
  const r = opts.find((o) => o.key === key) ?? opts[0];
  const q = useSalesByCategory({ from: r.from, to: r.to });
  const d = q.data;

  return (
    <Card data-testid="sales-by-category">
      <CardHeader
        title="Sales by category"
        subtitle="By the sales category on each invoice, not by who it is billed to or how it was paid. Invoices raised in the period, not draft or void. Amounts inc GST."
      />
      <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setKey(o.key)}
            className={
              key === o.key
                ? "rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                : "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {o.label}
          </button>
        ))}
      </div>
      {q.isLoading || !d ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-px bg-border sm:grid-cols-2">
            {d.order.map((cat) => {
              const c = d.categories[cat];
              const a = d.accounts[cat];
              const rows: [string, number][] = [
                ["Paid by bank", c.paid.bank],
                ["Paid by card", c.paid.card],
                ["Paid by cash or other", c.paid.cash + c.paid.other],
                ["Settled by contra", c.paid.contra],
                ["Paid, method not split", c.paid.notSplit],
              ];
              return (
                <div key={cat} className="bg-card px-4 py-3" data-testid={`sales-cat-${cat}`}>
                  <p className="label-xs">
                    {a.label} · Xero {a.name}
                  </p>
                  <p className="tabular mt-1.5 text-xl font-bold leading-none">{money(c.total)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {c.count} invoice{c.count === 1 ? "" : "s"}. {money(c.exGst)} ex GST, GST {money(c.gst)}.
                  </p>
                  <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
                    {rows
                      .filter(([label, v]) => v > 0.004 || label !== "Paid, method not split")
                      .map(([label, v]) => (
                        <React.Fragment key={label}>
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="tabular text-right">{money(v)}</dd>
                        </React.Fragment>
                      ))}
                    <dt className="font-medium">Still owing</dt>
                    <dd className="tabular text-right font-medium">{money(c.owing)}</dd>
                  </dl>
                </div>
              );
            })}
          </div>
          <div className="border-t border-border">
            <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">Installer materials invoices</p>
            {d.materials.length === 0 ? (
              <Empty>None in this period.</Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">Invoice</th>
                      <th className="th px-4">Billed to</th>
                      <th className="th px-4 text-right">Total</th>
                      <th className="th px-4 text-right">GST</th>
                      <th className="th px-4 text-right">Bank</th>
                      <th className="th px-4 text-right">Card</th>
                      <th className="th px-4 text-right">Contra</th>
                      <th className="th px-4 text-right">Owing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.materials.map((m) => (
                      <tr key={m.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">
                          {m.jobId ? (
                            <Link to={`/jobs/${m.jobId}`} className="font-medium text-primary hover:underline">
                              {m.number}
                            </Link>
                          ) : (
                            <span className="font-medium">{m.number}</span>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {m.date} · {invoiceStatusText({ status: m.status, total: m.total, amountPaid: m.total - m.owing, emailedAt: m.emailedAt, inXero: m.inXero })}
                            {m.inXero ? (
                              <>
                                {" "}
                                <Badge colour="#13B5EA">Xero {m.xeroSalesAccount ?? ""}</Badge>
                              </>
                            ) : null}
                          </p>
                        </td>
                        <td className="px-4 py-2">{m.who || "-"}</td>
                        <td className="tabular px-4 py-2 text-right">{money(m.total)}</td>
                        <td className="tabular px-4 py-2 text-right text-muted-foreground">{money(m.gst)}</td>
                        <td className="tabular px-4 py-2 text-right">{m.paid.bank ? money(m.paid.bank) : "-"}</td>
                        <td className="tabular px-4 py-2 text-right">{m.paid.card ? money(m.paid.card) : "-"}</td>
                        <td className="tabular px-4 py-2 text-right">{m.paid.contra ? money(m.paid.contra) : "-"}</td>
                        <td className="tabular px-4 py-2 text-right font-semibold">{m.owing > 0 ? money(m.owing) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
