import * as React from "react";
import { Link } from "wouter";
import { ArrowDown, Info } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { money, pct, histDate } from "../lib/money";
import { useProfitability, useSupervisorAttribution, type ProfitabilityScope } from "../queries/intel";

/**
 * PROFITABILITY.
 *
 * Revenue, gross profit, margin, days to pay, outstanding, quote conversion,
 * repeat frequency. Sortable, so the question being asked decides the order.
 *
 * There is deliberately no single "client score". A builder who has given
 * Terra $600k at bad margins is not automatically worth more than one who has
 * given $350k at good margins and pays on time, and no weighted average
 * settles that argument honestly. The numbers are shown, the call is Damien's.
 */

type SortKey =
  | "revenue"
  | "grossProfit"
  | "marginPercent"
  | "avgJobValue"
  | "deliveredJobs"
  | "outstanding"
  | "avgDaysToPay"
  | "quoteConversion"
  | "jobsPerYear";

const COLUMNS: { key: SortKey; label: string; hint: string }[] = [
  { key: "revenue", label: "Revenue", hint: "Delivered work, lifetime" },
  { key: "grossProfit", label: "Gross profit", hint: "Revenue less recorded costs" },
  { key: "marginPercent", label: "Margin", hint: "GP over the revenue that has costs behind it" },
  { key: "avgJobValue", label: "Avg job", hint: "Revenue over delivered jobs" },
  { key: "deliveredJobs", label: "Jobs", hint: "Delivered, cancelled excluded" },
  { key: "outstanding", label: "Owing", hint: "Invoiced and unpaid" },
  { key: "avgDaysToPay", label: "Days to pay", hint: "Average, invoice raised to money in" },
  { key: "quoteConversion", label: "Quote win", hint: "Accepted over quoted" },
  { key: "jobsPerYear", label: "Jobs/yr", hint: "Over the span they have been a customer" },
];

export default function ProfitabilityPage() {
  const [scope, setScope] = React.useState<ProfitabilityScope>("companies");
  const [sort, setSort] = React.useState<SortKey>("revenue");
  const q = useProfitability({ scope });
  const attribution = useSupervisorAttribution(scope === "supervisors");

  const rows = React.useMemo(() => {
    const data = [...(q.data ?? [])];
    // Nulls sink. "No data" is never the top of a ranking.
    data.sort((a, b) => {
      const av = a[sort];
      const bv = b[sort];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      // Paying fast is good, so days to pay sorts the other way.
      return sort === "avgDaysToPay" ? Number(av) - Number(bv) : Number(bv) - Number(av);
    });
    return data;
  }, [q.data, sort]);

  const anyCosts = rows.some((r) => r.grossProfit !== null);

  return (
    <Page
      title="Profitability"
      subtitle="The numbers behind who is actually worth having. No single score, on purpose."
      actions={
        <div className="flex flex-wrap gap-1.5">
          {(["companies", "clients", "supervisors"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={
                scope === s
                  ? "rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold capitalize text-primary-foreground"
                  : "rounded-md border border-border px-3.5 py-2 text-[13px] font-medium capitalize text-muted-foreground hover:text-foreground"
              }
            >
              {s}
            </button>
          ))}
        </div>
      }
    >
      {q.isLoading ? (
        <Loading label="Crunching the numbers…" />
      ) : (
        <div className="space-y-4">
          {!anyCosts ? (
            <Card className="flex items-start gap-3 px-4 py-3.5">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">
                <span className="font-semibold text-foreground">No gross profit yet.</span> Nothing in the
                system has costs recorded against it, so margin cannot be calculated and is left blank rather
                than guessed. Enter materials, installer pay and other direct costs on jobs and every GP column
                here fills in. Days to pay and quote conversion need invoices and quotes the same way.
              </p>
            </Card>
          ) : null}

          {scope === "supervisors" && attribution.data && attribution.data.withoutSupervisor > 0 ? (
            <Card className="flex items-start gap-3 px-4 py-3.5">
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {attribution.data.withoutSupervisor.toLocaleString()} of{" "}
                  {attribution.data.totalJobs.toLocaleString()} jobs have no supervisor recorded.
                </span>{" "}
                Those jobs are left out of the table below, so this is only the work where someone is named.
                Nothing that came across from ServiceM8 carries a supervisor, so this fills in as supervisors
                get put on jobs from here on.
              </p>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title={
                scope === "companies"
                  ? "Companies"
                  : scope === "clients"
                    ? "Individual clients"
                    : "Supervisors"
              }
              subtitle="Click a column to sort by it. Days to pay sorts fastest first, everything else biggest first."
              action={<Badge>{rows.length}</Badge>}
            />
            {rows.length === 0 ? (
              <Empty>No delivered work to measure yet.</Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table
                  className={
                    scope === "supervisors"
                      ? "w-full min-w-[1240px] text-sm"
                      : "w-full min-w-[1080px] text-sm"
                  }
                >
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">
                        {scope === "companies" ? "Company" : scope === "clients" ? "Client" : "Supervisor"}
                      </th>
                      {scope === "supervisors" ? (
                        <th className="th px-3" title="The company this person works for">
                          Company
                        </th>
                      ) : null}
                      {COLUMNS.map((c) => (
                        <th key={c.key} className="th px-3 text-right" title={c.hint}>
                          <button
                            type="button"
                            onClick={() => setSort(c.key)}
                            className={
                              sort === c.key
                                ? "inline-flex items-center gap-1 font-semibold text-foreground"
                                : "inline-flex items-center gap-1 hover:text-foreground"
                            }
                          >
                            {c.label}
                            {sort === c.key ? <ArrowDown className="size-3" /> : null}
                          </button>
                        </th>
                      ))}
                      <th className="th px-4 text-right">Last job</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2.5">
                          <Link
                            to={
                              scope === "companies"
                                ? `/companies/${r.id}`
                                : scope === "clients"
                                  ? `/clients/${r.id}`
                                  : `/supervisors/${r.id}`
                            }
                            className="font-medium text-primary hover:underline"
                          >
                            {r.name}
                          </Link>
                        </td>
                        {scope === "supervisors" ? (
                          <td className="px-3 py-2.5 text-[13px] text-muted-foreground">
                            {r.company ?? "Not recorded"}
                          </td>
                        ) : null}
                        <td className="tabular px-3 py-2.5 text-right font-semibold">{money(r.revenue)}</td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.grossProfit === null ? (
                            <span className="text-xs text-muted-foreground">-</span>
                          ) : (
                            money(r.grossProfit)
                          )}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.marginPercent === null ? (
                            <span className="text-xs text-muted-foreground">-</span>
                          ) : (
                            pct(r.marginPercent)
                          )}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">{money(r.avgJobValue)}</td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.deliveredJobs}
                          {/* Supervisors can be brand new, so say what is still open. */}
                          {scope === "supervisors" && r.liveJobs > 0 ? (
                            <span className="ml-1 text-xs text-muted-foreground">+{r.liveJobs} live</span>
                          ) : null}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.outstanding > 0 ? (
                            <span className="font-medium text-[var(--warning)]">{money(r.outstanding)}</span>
                          ) : (
                            <span className="text-xs text-muted-foreground">-</span>
                          )}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.avgDaysToPay === null ? (
                            <span className="text-xs text-muted-foreground">-</span>
                          ) : (
                            `${r.avgDaysToPay}d`
                          )}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.quoteConversion === null ? (
                            <span className="text-xs text-muted-foreground">-</span>
                          ) : (
                            pct(r.quoteConversion)
                          )}
                        </td>
                        <td className="tabular px-3 py-2.5 text-right">
                          {r.jobsPerYear === null ? (
                            <span className="text-xs text-muted-foreground">-</span>
                          ) : (
                            r.jobsPerYear
                          )}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                          {histDate(r.lastJob)}
                        </td>
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
