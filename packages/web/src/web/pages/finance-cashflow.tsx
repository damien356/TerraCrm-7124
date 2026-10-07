import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, RefreshCw, TriangleAlert, Wallet } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CashflowChart, ChartLegend } from "../components/ui/cashflow-chart";
import { money, moneyExact, longDate, shortDate, daysBetween } from "../lib/money";
import { useForecast, useRebuildForecast, type ForecastWindow } from "../queries/finance";

/**
 * CASHFLOW.
 *
 * Built off agreed work, not off invoice due dates. A job that has been
 * accepted and scheduled is already in here, weeks before anyone invoices it,
 * because that is when the money is actually committed.
 *
 * Three rules the screen keeps:
 *   1. Committed, expected and pipeline money are shown apart. Never one total.
 *   2. The lowest cash point is the headline, not the closing balance. Closing
 *      balance looks fine on the day you cannot pay the installer.
 *   3. Missing cost data is stated on the screen, so nobody reads a forecast as
 *      complete when the costs behind it were never entered.
 */

const WINDOWS: { key: ForecastWindow; label: string; blurb: string }[] = [
  { key: "12w", label: "12 weeks", blurb: "Running the business day to day" },
  { key: "6m", label: "6 months", blurb: "Planning" },
  { key: "12m", label: "12 months", blurb: "The big picture" },
];

export default function CashflowPage() {
  const [window, setWindow] = React.useState<ForecastWindow>("12w");
  const [includePipeline, setIncludePipeline] = React.useState(false);
  const forecast = useForecast({ window, includePipeline });
  const rebuild = useRebuildForecast();
  const d = forecast.data;

  return (
    <Page
      title="Cashflow"
      subtitle="Every accepted job feeds this before it is invoiced. Committed, expected and pipeline money are never added together."
      actions={
        <>
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
          <Button variant="ghost" onClick={() => rebuild.mutate({})} disabled={rebuild.isPending}>
            {rebuild.isPending ? <Spinner /> : <RefreshCw className="size-4" />}
            Recalculate
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-1.5">
        {WINDOWS.map((w) => (
          <button
            key={w.key}
            type="button"
            onClick={() => setWindow(w.key)}
            title={w.blurb}
            className={
              window === w.key
                ? "rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground"
                : "rounded-md border border-border px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {w.label}
          </button>
        ))}
      </div>

      {forecast.isLoading || !d ? (
        <Loading label="Building the forecast…" />
      ) : (
        <div className="space-y-4">
          {/* ---------------------- the headline numbers ---------------------- */}
          <div className="grid gap-3 lg:grid-cols-3">
            <CashPosition
              amount={d.opening.amount}
              date={d.opening.date}
              source={d.opening.source}
            />
            <LowestPoint lowest={d.lowest} today={d.today} closing30={d.closing30} closing30Date={d.closing30Date} />
          </div>

          {/* ------------------------- confidence split ------------------------ */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ConfidenceCard
              title="Committed"
              blurb="Agreed work and placed orders. The date can move, the money is real."
              inAmount={d.totals.inCommitted}
              outAmount={d.totals.outCommitted}
            />
            <ConfidenceCard
              title="Expected"
              blurb="Accepted but not yet scheduled or ordered."
              inAmount={d.totals.inExpected}
              outAmount={d.totals.outExpected}
            />
            <ConfidenceCard
              title="Pipeline"
              blurb="Quotes nobody has accepted. Never added to the two above."
              inAmount={d.totals.inPipeline}
              outAmount={d.totals.outPipeline}
              muted={!includePipeline}
              mutedNote={includePipeline ? undefined : "Excluded from the forecast"}
            />
          </div>

          {/* ------------------------------ chart ----------------------------- */}
          <Card>
            <CardHeader
              title={`Cashflow forecast, next ${WINDOWS.find((w) => w.key === window)!.label}`}
              subtitle={`${longDate(d.from)} to ${longDate(d.to)}`}
              action={<ChartLegend includePipeline={includePipeline} />}
            />
            <div className="px-3 pb-2 pt-4">
              <CashflowChart buckets={d.buckets} includePipeline={includePipeline} />
            </div>
          </Card>

          {d.gaps.jobsMissingCosts > 0 ? <CostGap gaps={d.gaps} /> : null}

          {/* ----------------------- what is coming/going --------------------- */}
          <div className="grid gap-3 lg:grid-cols-2">
            <EventTable
              title="Upcoming payments in"
              subtitle="Customer money, from agreed work as well as issued invoices"
              rows={d.upcomingIn}
              tone="in"
              today={d.today}
            />
            <EventTable
              title="Upcoming expenses out"
              subtitle="Material, installers and other direct costs"
              rows={d.upcomingOut}
              tone="out"
              today={d.today}
            />
          </div>
        </div>
      )}
    </Page>
  );
}

/* -------------------------------------------------------------------------- */

function CashPosition({
  amount,
  date,
  source,
}: {
  amount: number;
  date: string;
  source: "manual" | "unset";
}) {
  return (
    <Card className="relative overflow-hidden px-4 py-3.5">
      <span className="absolute inset-x-0 top-0 h-[2px] bg-[linear-gradient(90deg,var(--gold),rgba(188,149,88,0))]" />
      <div className="flex items-center justify-between">
        <p className="label-xs">Cash position</p>
        <Wallet className="size-4 text-[var(--gold)]" />
      </div>
      {source === "unset" ? (
        <>
          <p className="tabular mt-1.5 text-[26px] font-bold leading-none text-muted-foreground">Not set</p>
          <p className="mt-2 text-xs text-muted-foreground">
            The forecast is running from zero. Put today's bank balance in{" "}
            <Link to="/settings?tab=business" className="text-primary hover:underline">
              Settings
            </Link>{" "}
            and every number on this page starts from the truth.
          </p>
        </>
      ) : (
        <>
          <p className="tabular mt-1.5 text-[26px] font-bold leading-none tracking-[-0.02em]">
            {moneyExact(amount)}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Entered by hand as at {longDate(date)}. Xero takes over this tile once it is connected.
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * The number Damien actually asked for. Not "you will be fine at the end of
 * the month", but "on 17 November you are down to $48,620 and here is why".
 */
function LowestPoint({
  lowest,
  today,
  closing30,
  closing30Date,
}: {
  lowest: { date: string; balance: number; outBefore: number; inBefore: number; inAfter: number; inAfterTo: string };
  today: string;
  closing30: number;
  closing30Date: string;
}) {
  const tight = lowest.balance < 0;
  const days = daysBetween(today, lowest.date);
  return (
    <Card className={`lg:col-span-2 ${tight ? "border-destructive/50" : ""}`}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md ${
            tight ? "bg-destructive/15 text-destructive" : "bg-[var(--warning)]/15 text-[var(--warning)]"
          }`}
        >
          {tight ? <AlertTriangle className="size-4" /> : <TriangleAlert className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="label-xs">{tight ? "Cash crunch" : "Lowest cash point"}</p>
          <div className="mt-1.5 flex flex-wrap items-end gap-x-6 gap-y-2">
            <div>
              <p
                className={`tabular text-[26px] font-bold leading-none tracking-[-0.02em] ${
                  tight ? "text-destructive" : ""
                }`}
              >
                {moneyExact(lowest.balance)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Lowest projected balance, {longDate(lowest.date)}
                {days >= 0 ? ` (${days} day${days === 1 ? "" : "s"} away)` : ""}
              </p>
            </div>
            <div>
              <p className="tabular text-[20px] font-bold leading-none tracking-[-0.02em]">
                {moneyExact(closing30)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                30 day projected closing balance, {shortDate(closing30Date)}
              </p>
            </div>
          </div>
          <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Why: </span>
            {money(lowest.outBefore)} of supplier and installer payments fall due before{" "}
            {money(lowest.inBefore)} of customer receipts land. {money(lowest.inAfter)} comes in over the three
            weeks after, by {shortDate(lowest.inAfterTo)}.
          </p>
        </div>
      </div>
    </Card>
  );
}

function ConfidenceCard({
  title,
  blurb,
  inAmount,
  outAmount,
  muted,
  mutedNote,
}: {
  title: string;
  blurb: string;
  inAmount: number;
  outAmount: number;
  muted?: boolean;
  mutedNote?: string;
}) {
  return (
    <Card className={`px-4 py-3.5 ${muted ? "opacity-70" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="label-xs">{title}</p>
        {mutedNote ? <Badge>{mutedNote}</Badge> : null}
      </div>
      <div className="mt-2 flex items-end gap-5">
        <div>
          <p className="tabular text-[20px] font-bold leading-none text-[var(--success)]">{money(inAmount)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">in</p>
        </div>
        <div>
          <p className="tabular text-[20px] font-bold leading-none text-destructive">{money(outAmount)}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">out</p>
        </div>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{blurb}</p>
    </Card>
  );
}

/** Says out loud what the forecast does not know. */
function CostGap({ gaps }: { gaps: { jobsMissingCosts: number; valueMissingCosts: number } }) {
  return (
    <Card className="border-[var(--warning)]/40 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div>
          <p className="text-[13px] font-semibold">
            {gaps.jobsMissingCosts} live job{gaps.jobsMissingCosts === 1 ? "" : "s"} have no costs entered
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {money(gaps.valueMissingCosts)} of work in this forecast shows money coming in with nothing going
            out against it, so the low points above are kinder than reality. Enter material, installer and
            other direct costs on the job for the forecast to mean anything.
          </p>
        </div>
      </div>
    </Card>
  );
}

interface EventRow {
  id: number;
  confidence: string;
  kind: string;
  label: string;
  amount: number;
  dueDate: string;
  basis: string;
  jobId: number | null;
  jobNumber: number | string | null;
  who: string;
  overdue: boolean;
}

const CONF_TONE: Record<string, string> = {
  committed: "text-foreground",
  expected: "text-muted-foreground",
  pipeline: "text-muted-foreground/70",
};

function EventTable({
  title,
  subtitle,
  rows,
  tone,
  today,
}: {
  title: string;
  subtitle: string;
  rows: EventRow[];
  tone: "in" | "out";
  today: string;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      {rows.length === 0 ? (
        <Empty>
          {tone === "in"
            ? "Nothing due in over this window."
            : "No costs recorded against upcoming work yet."}
        </Empty>
      ) : (
        <div className="board-scroll max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border">
                <th className="th px-4">Due</th>
                <th className="th px-4">Who</th>
                <th className="th px-4">What</th>
                <th className="th px-4 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                  <td className="tabular whitespace-nowrap px-4 py-2.5">
                    <span className={e.dueDate < today ? "font-medium text-destructive" : ""}>
                      {shortDate(e.dueDate)}
                    </span>
                    {e.dueDate < today ? <p className="text-[11px] text-destructive">overdue</p> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className="truncate font-medium">{e.who || "—"}</p>
                    {e.jobNumber ? (
                      <Link to={`/jobs/${e.jobId}`} className="text-[11px] text-primary hover:underline">
                        Job #{e.jobNumber}
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <p className={`truncate text-[13px] ${CONF_TONE[e.confidence] ?? ""}`}>{e.label}</p>
                    <p className="truncate text-[11px] text-muted-foreground" title={e.basis}>
                      {e.confidence} · {e.basis}
                    </p>
                  </td>
                  <td
                    className={`tabular whitespace-nowrap px-4 py-2.5 text-right font-semibold ${
                      tone === "in" ? "text-[var(--success)]" : "text-destructive"
                    }`}
                  >
                    {tone === "in" ? "" : "-"}
                    {money(e.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
