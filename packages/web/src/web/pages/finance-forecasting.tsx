import * as React from "react";
import { Link } from "wouter";
import { Info } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { CashflowChart, ChartLegend } from "../components/ui/cashflow-chart";
import { money, longDate, shortDate } from "../lib/money";
import { useForecast, useTermsList, type ForecastWindow } from "../queries/finance";

/**
 * FORECASTING.
 *
 * The same engine as the Cashflow page, read period by period instead of day
 * by day. This is the planning view: can Terra carry the work it has already
 * won, and what does the shape of the next six to twelve months look like.
 *
 * The terms table at the bottom is here because it is the input that decides
 * every date above it. A builder moved from 30 days to 30 days EOM changes the
 * whole picture, and it should be obvious where that is set.
 */

const WINDOWS: { key: ForecastWindow; label: string; blurb: string }[] = [
  { key: "12w", label: "12 weeks", blurb: "Week by week, the operating window" },
  { key: "6m", label: "6 months", blurb: "Month by month, planning" },
  { key: "12m", label: "12 months", blurb: "Month by month, the big picture" },
];

export default function ForecastingPage() {
  const [window, setWindow] = React.useState<ForecastWindow>("6m");
  const [includePipeline, setIncludePipeline] = React.useState(false);
  const forecast = useForecast({ window, includePipeline });
  const terms = useTermsList();
  const d = forecast.data;
  const current = WINDOWS.find((w) => w.key === window)!;

  return (
    <Page
      title="Forecasting"
      subtitle="Where the money lands period by period, split by how certain it is."
      actions={
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-[13px]">
          <input
            type="checkbox"
            aria-label="Include pipeline"
            checked={includePipeline}
            onChange={(e) => setIncludePipeline(e.target.checked)}
            className="size-3.5 accent-[var(--gold)]"
          />
          Include pipeline
        </label>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => setWindow(w.key)}
            className={
              window === w.key
                ? "rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground"
                : "rounded-md border border-border px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {w.label}
          </button>
        ))}
        <p className="self-center pl-2 text-xs text-muted-foreground">{current.blurb}</p>
      </div>

      {forecast.isLoading || !d ? (
        <Loading label="Building the forecast…" />
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title={`Forecast, ${current.label}`}
              subtitle={`${longDate(d.from)} to ${longDate(d.to)}. Opening balance ${money(d.opening.amount)}${
                d.opening.source === "unset" ? ", not set yet" : ""
              }`}
              action={<ChartLegend includePipeline={includePipeline} />}
            />
            <div className="px-3 pb-2 pt-4">
              <CashflowChart buckets={d.buckets} includePipeline={includePipeline} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title={window === "12w" ? "Week by week" : "Month by month"}
              subtitle="Committed, expected and pipeline kept apart. The closing column is the running projected balance."
            />
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Period</th>
                    <th className="th px-4 text-right">In, committed</th>
                    <th className="th px-4 text-right">In, expected</th>
                    <th className="th px-4 text-right">In, pipeline</th>
                    <th className="th px-4 text-right">Out</th>
                    <th className="th px-4 text-right">Net</th>
                    <th className="th px-4 text-right">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {d.buckets.map((b) => {
                    const out = b.outCommitted + b.outExpected + (includePipeline ? b.outPipeline : 0);
                    return (
                      <tr key={b.start} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{b.label}</span>
                          <p className="text-[11px] text-muted-foreground">
                            {shortDate(b.start)} – {shortDate(b.end)}
                          </p>
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-[var(--success)]">
                          {b.inCommitted ? money(b.inCommitted) : "—"}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-[var(--success)]/70">
                          {b.inExpected ? money(b.inExpected) : "—"}
                        </td>
                        <td
                          className={`tabular px-4 py-2.5 text-right ${
                            includePipeline ? "text-muted-foreground" : "text-muted-foreground/50 line-through"
                          }`}
                        >
                          {b.inPipeline ? money(b.inPipeline) : "—"}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right text-destructive">
                          {out ? `-${money(out)}` : "—"}
                        </td>
                        <td
                          className={`tabular px-4 py-2.5 text-right font-medium ${
                            b.net < 0 ? "text-destructive" : ""
                          }`}
                        >
                          {money(b.net)}
                        </td>
                        <td
                          className={`tabular px-4 py-2.5 text-right font-semibold ${
                            b.closing < 0 ? "text-destructive" : ""
                          }`}
                        >
                          {money(b.closing)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-secondary/40">
                    <td className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Window total
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold text-[var(--success)]">
                      {money(d.totals.inCommitted)}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold text-[var(--success)]/70">
                      {money(d.totals.inExpected)}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold text-muted-foreground">
                      {d.totals.inPipeline ? money(d.totals.inPipeline) : "—"}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold text-destructive">
                      {(() => {
                        const out =
                          d.totals.outCommitted +
                          d.totals.outExpected +
                          (includePipeline ? d.totals.outPipeline : 0);
                        return out ? `-${money(out)}` : "—";
                      })()}
                    </td>
                    <td aria-hidden="true" className="px-4 py-2.5" />
                    <td className="tabular px-4 py-2.5 text-right font-semibold">
                      {money(d.buckets[d.buckets.length - 1]?.closing ?? 0)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>

          {d.gaps.jobsMissingCosts > 0 ? (
            <Card className="border-[var(--warning)]/40 px-4 py-3">
              <div className="flex items-start gap-2.5">
                <Info className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  <span className="font-semibold text-foreground">Read the out column carefully. </span>
                  {d.gaps.jobsMissingCosts} live {d.gaps.jobsMissingCosts === 1 ? "job" : "jobs"} worth{" "}
                  {money(d.gaps.valueMissingCosts)} {d.gaps.jobsMissingCosts === 1 ? "has" : "have"} no costs
                  entered against {d.gaps.jobsMissingCosts === 1 ? "it" : "them"}, so money out is understated
                  by whatever those jobs will cost to deliver.
                </p>
              </div>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Payment terms driving these dates"
              subtitle="Set per company, overridable on any single job. Anything not listed falls back to 30 days EOM for companies, 50% deposit and balance on completion for direct customers."
            />
            {terms.isLoading ? (
              <Loading />
            ) : (terms.data ?? []).length === 0 ? (
              <Empty>
                No company has its own terms yet, so every company is being forecast on 30 days end of month.
                Set a company's real terms on its page under{" "}
                <Link to="/companies" className="text-primary hover:underline">
                  Companies
                </Link>
                .
              </Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">Company</th>
                      <th className="th px-4">Structure</th>
                      <th className="th px-4">Terms</th>
                      <th className="th px-4 text-right">Deposit</th>
                      <th className="th px-4 text-right">Retention</th>
                      <th className="th px-4 text-right">Observed late</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(terms.data ?? []).map((t) => (
                      <tr key={t.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2.5 font-medium">{t.companyName || "—"}</td>
                        <td className="px-4 py-2.5">
                          <Badge>{t.structure.replace(/_/g, " ")}</Badge>
                        </td>
                        <td className="px-4 py-2.5 text-[13px]">
                          {t.label} from {t.termsFrom}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">
                          {t.depositPercent ? `${t.depositPercent}%` : "—"}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">
                          {t.retentionPercent ? `${t.retentionPercent}%` : "—"}
                        </td>
                        <td className="tabular px-4 py-2.5 text-right">
                          {t.observedDaysLate ? `${t.observedDaysLate.toFixed(0)} days` : "—"}
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
