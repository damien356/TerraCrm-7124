import * as React from "react";
import { Link } from "wouter";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { useLeadDrill, useLeadReport } from "../queries/leads";
import { useTimberReport } from "../queries/timber";

/**
 * LEADS AND MONEY BY SOURCE (spec 14 Oct, Part A item 4 and Part B item 10).
 * Admin only. Leads, quotes sent, jobs won, win rate, won value and paid value
 * per lead source, by month or year, with ad spend turned into cost per lead
 * and return per $1. Sub jobs and the ZZTEST jobs are left out by the server.
 */

const COLOURS = ["#C0603F", "#BC9558", "#6B8F71", "#5B7C99", "#8E6C8A", "#B8B2A7", "#A0522D", "#2F6F6A"];
const money = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });
const money2 = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortMoney = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `$${Number((n / 1_000_000).toFixed(1))}m`;
  if (a >= 1000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
};
const brisbaneDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => (m.length === 7 ? `${MONTH_NAMES[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}` : m);

type Cell = { leads: number; quotesSent: number; won: number; wonValue: number; paidValue: number; spend: number };
type Period = Cell & { period: string; winRate: number; costPerLead: number | null };

/** Months rolled up to years when asked. */
function periods(months: Array<Cell & { month: string }>, by: "month" | "year"): Period[] {
  const out = new Map<string, Cell>();
  for (const m of months) {
    const k = by === "year" ? m.month.slice(0, 4) : m.month;
    const c = out.get(k) ?? { leads: 0, quotesSent: 0, won: 0, wonValue: 0, paidValue: 0, spend: 0 };
    c.leads += m.leads;
    c.quotesSent += m.quotesSent;
    c.won += m.won;
    c.wonValue += m.wonValue;
    c.paidValue += m.paidValue;
    c.spend += m.spend;
    out.set(k, c);
  }
  return [...out.entries()].map(([period, c]) => ({
    period,
    ...c,
    winRate: c.quotesSent ? Math.round((c.won / c.quotesSent) * 100) : 0,
    costPerLead: c.spend && c.leads ? Math.round((c.spend / c.leads) * 100) / 100 : null,
  }));
}

export default function LeadsReportPage() {
  const [from, setFrom] = React.useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 11, 1);
    return brisbaneDay(d);
  });
  const [to, setTo] = React.useState(() => brisbaneDay(new Date()));
  const [clientType, setClientType] = React.useState("");
  const [tab, setTab] = React.useState<"sources" | "timber">("sources");
  const range = { from: from || undefined, to: to || undefined, clientType: clientType || undefined };
  const report = useLeadReport(range);
  const d = report.data;

  return (
    <Page
      title="Leads and money by source"
      subtitle="Where jobs come from, what they win and what the ads cost. Old jobs from before tracking show as Unknown."
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Client type">
            <Select id="leads_client_type" value={clientType} onChange={(e) => setClientType(e.target.value)}>
              <option value="">All</option>
              {(d?.clientTypes ?? []).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      }
    >
      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-card p-1 sm:w-fit">
        {(
          [
            ["sources", "By source"],
            ["timber", "Timber repairs"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={
              tab === id
                ? "rounded-md bg-[var(--sidebar)] px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "timber" ? (
        <TimberReport />
      ) : report.isLoading ? (
        <Loading label="Loading the leads report…" />
      ) : !d ? (
        <Card>
          <Empty>Couldn't load the report.</Empty>
        </Card>
      ) : (
        <SourcesReport d={d} range={range} />
      )}
    </Page>
  );
}

type Report = NonNullable<ReturnType<typeof useLeadReport>["data"]>;

function SourcesReport({ d, range }: { d: Report; range: { from?: string; to?: string; clientType?: string } }) {
  const [by, setBy] = React.useState<"month" | "year">("month");
  const [metric, setMetric] = React.useState<"leads" | "won">("leads");
  const [open, setOpen] = React.useState<string | null>(null);
  const [drill, setDrill] = React.useState<{ source: string; month?: string } | null>(null);
  const t = d.total;

  const bars = d.sources.filter((s) => s.wonValue > 0).map((s) => ({ name: s.source.replace(/^Google Ads: /, "GA: "), full: s.source, value: s.wonValue }));
  /* The over time chart: the 6 busiest sources, one line each. */
  const top = [...d.sources].sort((a, b) => b.leads - a.leads).slice(0, 6);
  const periodKeys = [...new Set(d.months.map((m) => (by === "year" ? m.slice(0, 4) : m)))].sort();
  const lineData = periodKeys.map((p) => {
    const row: Record<string, number | string> = { period: by === "year" ? p : monthLabel(p) };
    for (const s of top) {
      const ps = periods(s.months, by).find((x) => x.period === p);
      row[s.source] = ps ? ps[metric] : 0;
    }
    return row;
  });

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Leads" value={t.leads} />
        <Stat label="Quotes sent" value={t.quotesSent} />
        <Stat label="Jobs won" value={t.won} hint={`Win rate ${t.winRate}%`} />
        <Stat label="Won value" value={money(t.wonValue)} tone="success" />
        <Stat label="Paid" value={money(t.paidValue)} />
        <Stat
          label="Ad spend"
          value={money(t.spend)}
          hint={t.spend ? `Paid sources: ${money2(t.costPerLead)} a lead, ${money2(t.returnPerDollar ?? 0)} won per $1` : "Enter it in Settings, Leads"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Won value by source" subtitle="Click a bar to see its jobs." />
          {bars.length === 0 ? (
            <Empty>Nothing won in this range.</Empty>
          ) : (
            <div className="px-3 py-3" style={{ height: Math.max(180, bars.length * 34 + 40) }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={bars} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                  <XAxis type="number" tickFormatter={shortMoney} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => [money(Number(v)), "Won value"]} />
                  <Bar
                    dataKey="value"
                    radius={[0, 4, 4, 0]}
                    fill="#C0603F"
                    cursor="pointer"
                    onClick={(e: unknown) => {
                      const full = (e as { payload?: { full?: string } })?.payload?.full;
                      if (full) setDrill({ source: full });
                    }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title={metric === "leads" ? "Leads by source over time" : "Wins by source over time"}
            subtitle="The six busiest sources."
            action={
              <div className="flex gap-1">
                <Select className="h-8 w-24 text-xs" value={metric} onChange={(e) => setMetric(e.target.value as "leads" | "won")}>
                  <option value="leads">Leads</option>
                  <option value="won">Wins</option>
                </Select>
                <Select className="h-8 w-24 text-xs" value={by} onChange={(e) => setBy(e.target.value as "month" | "year")}>
                  <option value="month">By month</option>
                  <option value="year">By year</option>
                </Select>
              </div>
            }
          />
          {lineData.length === 0 ? (
            <Empty>No leads in this range.</Empty>
          ) : (
            <div className="h-72 px-3 py-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={lineData} margin={{ left: 0, right: 16, top: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E7E2DA" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {top.map((s, i) => (
                    <Line key={s.source} type="linear" dataKey={s.source} stroke={COLOURS[i % COLOURS.length]} strokeWidth={2} dot={{ r: 2 }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Every source"
          subtitle="Click a source to see its months. Click the jobs count to see the jobs."
          action={
            <Select className="h-8 w-24 text-xs" value={by} onChange={(e) => setBy(e.target.value as "month" | "year")}>
              <option value="month">By month</option>
              <option value="year">By year</option>
            </Select>
          }
        />
        {d.sources.length === 0 ? (
          <Empty>No leads in this range.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  {["Source", "Leads", "Quotes sent", "Won", "Win rate", "Won value", "Paid", "Spend", "Per lead", "Back per $1"].map((h, i) => (
                    <th key={h} className={`label-xs px-3 py-2 ${i ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.sources.map((s) => (
                  <React.Fragment key={s.source}>
                    <tr className="cursor-pointer border-b border-border hover:bg-secondary/50" onClick={() => setOpen(open === s.source ? null : s.source)}>
                      <td className="px-3 py-2 font-medium">
                        <span className="mr-1 inline-block w-3 text-muted-foreground">{open === s.source ? "▾" : "▸"}</span>
                        {s.source}
                      </td>
                      <td className="tabular px-3 py-2 text-right">
                        <button
                          type="button"
                          className="text-[var(--gold-deep)] hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDrill({ source: s.source });
                          }}
                        >
                          {s.leads}
                        </button>
                      </td>
                      <td className="tabular px-3 py-2 text-right">{s.quotesSent}</td>
                      <td className="tabular px-3 py-2 text-right">{s.won}</td>
                      <td className="tabular px-3 py-2 text-right">{s.winRate}%</td>
                      <td className="tabular px-3 py-2 text-right">{money(s.wonValue)}</td>
                      <td className="tabular px-3 py-2 text-right">{money(s.paidValue)}</td>
                      <td className="tabular px-3 py-2 text-right">{s.spend ? money(s.spend) : "-"}</td>
                      <td className="tabular px-3 py-2 text-right">{money2(s.costPerLead)}</td>
                      <td className="tabular px-3 py-2 text-right">{s.returnPerDollar == null ? "-" : `$${s.returnPerDollar.toFixed(2)}`}</td>
                    </tr>
                    {open === s.source
                      ? periods(s.months, by)
                          .filter((p) => p.leads || p.spend)
                          .reverse()
                          .map((p) => (
                            <tr key={p.period} className="border-b border-border bg-secondary/30 text-xs">
                              <td className="px-3 py-1.5 pl-9">{by === "year" ? p.period : monthLabel(p.period)}</td>
                              <td className="tabular px-3 py-1.5 text-right">
                                {by === "month" ? (
                                  <button type="button" className="text-[var(--gold-deep)] hover:underline" onClick={() => setDrill({ source: s.source, month: p.period })}>
                                    {p.leads}
                                  </button>
                                ) : (
                                  p.leads
                                )}
                              </td>
                              <td className="tabular px-3 py-1.5 text-right">{p.quotesSent}</td>
                              <td className="tabular px-3 py-1.5 text-right">{p.won}</td>
                              <td className="tabular px-3 py-1.5 text-right">{p.winRate}%</td>
                              <td className="tabular px-3 py-1.5 text-right">{money(p.wonValue)}</td>
                              <td className="tabular px-3 py-1.5 text-right">{money(p.paidValue)}</td>
                              <td className="tabular px-3 py-1.5 text-right">{p.spend ? money(p.spend) : "-"}</td>
                              <td className="tabular px-3 py-1.5 text-right">{money2(p.costPerLead)}</td>
                              <td className="px-3 py-1.5" aria-label="No action" />
                            </tr>
                          ))
                      : null}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Won is a quote accepted or the job past Quoted. Win rate is won over quotes sent. Paid is what has come in on the invoices. Test jobs{" "}
          {d.excludedJobNumbers.join(", ")} are left out.
        </p>
      </Card>

      <DrillModal drill={drill} range={range} onClose={() => setDrill(null)} />
    </div>
  );
}

function DrillModal({
  drill,
  range,
  onClose,
}: {
  drill: { source: string; month?: string } | null;
  range: { from?: string; to?: string; clientType?: string };
  onClose: () => void;
}) {
  const q = useLeadDrill({ ...range, source: drill?.source ?? null, month: drill?.month });
  return (
    <Modal
      open={!!drill}
      onClose={onClose}
      width="max-w-3xl"
      title={drill?.source ?? ""}
      subtitle={drill?.month ? monthLabel(drill.month) : "Every job in the range"}
    >
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.length ? (
        <Empty>No jobs.</Empty>
      ) : (
        <div className="-mx-5 -my-4 max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b border-border text-left">
                {["Job", "Client", "Made", "Status", "Won value", "Paid"].map((h, i) => (
                  <th key={h} className={`label-xs px-3 py-2 ${i > 3 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.map((j) => (
                <tr key={j.id} className="border-b border-border">
                  <td className="px-3 py-1.5">
                    <Link to={`/jobs/${j.id}`} className="font-medium hover:underline">
                      {j.number}
                    </Link>
                    <p className="max-w-[220px] truncate text-xs text-muted-foreground">{j.title}</p>
                  </td>
                  <td className="px-3 py-1.5 text-xs">
                    {j.client || "-"}
                    {j.clientType ? <p className="text-muted-foreground">{j.clientType}</p> : null}
                  </td>
                  <td className="px-3 py-1.5 text-xs">{new Date(j.createdAt).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane" })}</td>
                  <td className="px-3 py-1.5 text-xs">
                    {j.won ? <Badge colour="#15803D">Won</Badge> : j.quoteSent ? <Badge colour="#B45309">Quoted</Badge> : null} {j.status}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right">{j.won ? money(j.wonValue) : "-"}</td>
                  <td className="tabular px-3 py-1.5 text-right">{j.paidValue ? money(j.paidValue) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function TimberReport() {
  const q = useTimberReport();
  if (q.isLoading) return <Loading />;
  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader
        title="Timber repairs by repair type"
        subtitle="All time. Marc's price is ex GST. The client price is incl GST. Open repairs are on the Timber repairs screen."
        action={
          <Link to="/repairs">
            <Button size="sm" variant="outline">
              Open repairs
            </Button>
          </Link>
        }
      />
      {rows.length === 0 ? (
        <Empty>No timber repair leads yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                {["Repair type", "Leads", "Quotes", "Won", "Win rate", "Avg Marc price", "Avg client price", "Won value", "SMS cost"].map((h, i) => (
                  <th key={h} className={`label-xs px-3 py-2 ${i ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.repairType || "none"} className="border-b border-border">
                  <td className="px-3 py-2 font-medium">{r.label}</td>
                  <td className="tabular px-3 py-2 text-right">{r.leads}</td>
                  <td className="tabular px-3 py-2 text-right">{r.quotes}</td>
                  <td className="tabular px-3 py-2 text-right">{r.won}</td>
                  <td className="tabular px-3 py-2 text-right">{r.winRate}%</td>
                  <td className="tabular px-3 py-2 text-right">{money(r.avgMarc)}</td>
                  <td className="tabular px-3 py-2 text-right">{money(r.avgClient)}</td>
                  <td className="tabular px-3 py-2 text-right">{money(r.wonClient)}</td>
                  <td className="tabular px-3 py-2 text-right">{money2(r.smsCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
