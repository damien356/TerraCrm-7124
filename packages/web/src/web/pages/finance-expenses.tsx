import * as React from "react";
import { Link } from "wouter";
import { TriangleAlert } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { money, shortDate } from "../lib/money";
import { useExpenses } from "../queries/finance";

/**
 * EXPENSES.
 *
 * What Terra owes out, by the date it actually leaves the account. Materials
 * on 30 days end of month, installers within 7 days of their invoice, so the
 * same job pays out on two different dates and the forecast needs both.
 *
 * State matters more than it looks. A budget line is Terra's own estimate with
 * no bill behind it, a committed line is ordered, an invoiced line has a real
 * due date. They are shown apart, never as one "owed" total.
 */

const RANGES = [
  { days: 30, label: "30 days" },
  { days: 60, label: "60 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
];

const STATE_LABEL: Record<string, string> = {
  budget: "Budget",
  committed: "Committed",
  invoiced: "Invoiced",
  paid: "Paid",
};

const STATE_COLOUR: Record<string, string> = {
  budget: "#7A736D",
  committed: "#4A7FA5",
  invoiced: "#D08A1E",
  paid: "#3F7D3A",
};

const KIND_LABEL: Record<string, string> = {
  materials: "Materials",
  installer: "Installer",
  other: "Other",
};

export default function ExpensesPage() {
  const [days, setDays] = React.useState(60);
  const q = useExpenses(days);
  const rows = q.data ?? [];

  const sum = (f: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(f).reduce((a, r) => a + (r.amount ?? 0), 0);

  const overdue = sum((r) => r.overdue);
  const invoiced = sum((r) => r.state === "invoiced");
  const committed = sum((r) => r.state === "committed");
  const budget = sum((r) => r.state === "budget");
  const noDate = rows.filter((r) => !r.dueDate);

  return (
    <Page
      title="Expenses"
      subtitle="Supplier and installer money going out, by the date it leaves the account."
      actions={
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              onClick={() => setDays(r.days)}
              className={
                days === r.days
                  ? "rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
                  : "rounded-md border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      {q.isLoading ? (
        <Loading label="Loading expenses…" />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Overdue"
              value={money(overdue)}
              tone={overdue > 0 ? "danger" : "default"}
              hint="Past the date it should have gone out"
            />
            <Stat label="Invoiced" value={money(invoiced)} hint="Bill is in, real due date" />
            <Stat label="Committed" value={money(committed)} hint="Ordered or booked, not yet billed" />
            <Stat label="Budget" value={money(budget)} hint="Terra's own estimate, no bill yet" />
          </div>

          {noDate.length > 0 ? (
            <Card className="border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-4 py-3.5">
              <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-semibold text-foreground">
                    {noDate.length} {noDate.length === 1 ? "cost has" : "costs have"} no due date
                  </span>{" "}
                  ({money(noDate.reduce((a, r) => a + (r.amount ?? 0), 0))}). They are listed at the bottom and
                  the forecast dates them off the job, not off a real bill.
                </p>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Owed out"
              subtitle={`Everything unpaid with a date inside the next ${days} days, soonest first.`}
              action={<Badge>{rows.length}</Badge>}
            />
            {rows.length === 0 ? (
              <Empty>
                No costs recorded yet. Materials, installer pay and other direct costs get entered on the job,
                and they appear here and in the cashflow forecast the moment they are.
              </Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table className="w-full min-w-[880px] text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">Due</th>
                      <th className="th px-4">Who</th>
                      <th className="th px-4">What</th>
                      <th className="th px-4">Job</th>
                      <th className="th px-4">State</th>
                      <th className="th px-4 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2.5">
                          <span className={r.overdue ? "tabular font-medium text-destructive" : "tabular"}>
                            {r.dueDate ? shortDate(r.dueDate) : "No date"}
                          </span>
                          {r.overdue ? (
                            <p className="text-xs font-medium text-destructive">overdue</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-2.5">{r.who || "—"}</td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs text-muted-foreground">
                            {KIND_LABEL[r.kind] ?? r.kind}
                          </span>
                          {r.description ? (
                            <p className="max-w-[280px] truncate">{r.description}</p>
                          ) : null}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">
                          <Link to={`/jobs/${r.jobId}`} className="text-primary hover:underline">
                            #{r.jobNumber}
                          </Link>
                          <p className="max-w-[200px] truncate">{r.jobTitle}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <Badge colour={STATE_COLOUR[r.state]}>{STATE_LABEL[r.state] ?? r.state}</Badge>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right font-semibold">{money(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}
