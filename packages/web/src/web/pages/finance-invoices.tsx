import * as React from "react";
import { Link } from "wouter";
import { Info } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { money, shortDate } from "../lib/money";
import { useInvoiceList } from "../queries/finance";

/**
 * INVOICES.
 *
 * Money already billed, with its ageing. Deliberately a different number from
 * the cashflow forecast: the forecast also carries agreed work nobody has
 * invoiced yet. The two disagreeing is normal, and useful.
 */

const FILTERS: { key: "unpaid" | "overdue" | "paid" | "all"; label: string }[] = [
  { key: "unpaid", label: "Unpaid" },
  { key: "overdue", label: "Overdue" },
  { key: "paid", label: "Paid" },
  { key: "all", label: "All" },
];

const AGEING_TONE: Record<string, string> = {
  current: "#4A7FA5",
  "1-30": "#D08A1E",
  "31-60": "#C0603F",
  "60+": "#A33A2A",
};

export default function InvoicesPage() {
  const [status, setStatus] = React.useState<"unpaid" | "overdue" | "paid" | "all">("unpaid");
  const q = useInvoiceList({ status });
  const rows = q.data?.rows ?? [];
  const s = q.data?.summary;

  return (
    <Page
      title="Invoices"
      subtitle="What has been billed and what is still owed. Cashflow is the wider number, it includes work not yet invoiced."
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setStatus(f.key)}
            className={
              status === f.key
                ? "rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground"
                : "rounded-md border border-border px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <Loading label="Loading invoices…" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Outstanding" value={money(s?.outstanding ?? 0)} hint="Billed and not yet paid" />
            <Stat
              label="Overdue"
              value={money(s?.overdue ?? 0)}
              tone={(s?.overdue ?? 0) > 0 ? "danger" : "default"}
              hint="Past the due date"
            />
            <Stat
              label="Not yet due"
              value={money(s?.ageing.current ?? 0)}
              hint="Within terms, nothing to chase"
            />
            <Stat label="Invoices" value={s?.count ?? 0} hint="Issued in total" />
          </div>

          {(s?.outstanding ?? 0) > 0 ? (
          <Card>
            <CardHeader
              title="Ageing"
              subtitle="How long the unpaid money has been unpaid. This is the chase list."
            />
            <div className="grid gap-px bg-border sm:grid-cols-4">
              {[
                { label: "Current", value: s?.ageing.current ?? 0, key: "current" },
                { label: "1 to 30 days", value: s?.ageing.d30 ?? 0, key: "1-30" },
                { label: "31 to 60 days", value: s?.ageing.d60 ?? 0, key: "31-60" },
                { label: "Over 60 days", value: s?.ageing.older ?? 0, key: "60+" },
              ].map((b) => (
                <div key={b.key} className="bg-card px-4 py-3">
                  <p className="label-xs">{b.label}</p>
                  <p
                    className="tabular mt-1.5 text-xl font-bold leading-none"
                    style={{ color: b.value > 0 ? AGEING_TONE[b.key] : undefined }}
                  >
                    {money(b.value)}
                  </p>
                </div>
              ))}
            </div>
          </Card>
          ) : null}

          <Card>
            <CardHeader
              title={FILTERS.find((f) => f.key === status)?.label ?? "Invoices"}
              action={<Badge>{rows.length}</Badge>}
            />
            {rows.length === 0 ? (
              <Empty>
                {status === "unpaid"
                  ? "Nothing outstanding. No invoices have been raised in Terra Ops yet, so this stays empty until they are, or until Xero is connected."
                  : "No invoices match that filter."}
              </Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">Invoice</th>
                      <th className="th px-4">Who</th>
                      <th className="th px-4">Job</th>
                      <th className="th px-4">Due</th>
                      <th className="th px-4 text-right">Total</th>
                      <th className="th px-4 text-right">Paid</th>
                      <th className="th px-4 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{r.number}</span>
                          <p className="text-xs text-muted-foreground">
                            {r.label || r.kind} · {r.status.replace("_", " ")}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">{r.who || "—"}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          {r.jobId ? (
                            <Link to={`/jobs/${r.jobId}`} className="text-primary hover:underline">
                              #{r.jobNumber}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="tabular">{shortDate(r.dueDate)}</span>
                          {r.daysOverdue > 0 ? (
                            <p className="text-xs font-medium text-destructive">
                              {r.daysOverdue} days overdue
                            </p>
                          ) : null}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">{money(r.total)}</td>
                        <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                          {r.amountPaid > 0 ? money(r.amountPaid) : "—"}
                        </td>
                        <td
                          className={
                            r.daysOverdue > 0
                              ? "tabular px-4 py-2.5 text-right font-semibold text-destructive"
                              : "tabular px-4 py-2.5 text-right font-semibold"
                          }
                        >
                          {r.settled ? "—" : money(r.outstanding)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="flex items-start gap-3 px-4 py-3.5">
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">
              Invoices are raised against jobs. Once Xero is connected it becomes the source for paid and
              unpaid status, and this page reads from it instead of being maintained by hand.
            </p>
          </Card>
        </div>
      )}
    </Page>
  );
}
