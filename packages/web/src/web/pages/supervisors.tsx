import * as React from "react";
import { Link } from "wouter";
import { BarChart3, Search, Table2 } from "lucide-react";
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/field";
import { money, moneyShort, pct, histDate } from "../lib/money";
import { useSupervisors, type IntelSort, type SupRange } from "../queries/intel";
import { useBootstrap } from "../queries/settings";

/**
 * SUPERVISORS.
 *
 * Starts clean. Only people picked on a job or quote count, so the numbers
 * build up from new work. Gross profit, win rate and the concentration donut
 * come from the server only for Admin, or Office with cost access on.
 */

const SORTS: { key: IntelSort; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "gp", label: "Gross profit" },
  { key: "jobs", label: "Jobs" },
  { key: "recent", label: "Most recent" },
];

const RANGES: { key: SupRange; label: string }[] = [
  { key: "12m", label: "Last 12 months" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

const COLOURS = ["#C0603F", "#BC9558", "#6B8F71", "#5B7C99", "#8E6C8A", "#B8B2A7"];

type View = "table" | "chart";

/** Remembered per person, on this device, under their own user id. */
function useStoredView(userId: string | undefined): [View, (v: View) => void] {
  const key = `terra.supervisors.view.${userId ?? "anon"}`;
  const [view, setView] = React.useState<View>(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    if (saved === "table" || saved === "chart") return saved;
    return typeof window !== "undefined" && window.innerWidth < 768 ? "chart" : "table";
  });
  React.useEffect(() => {
    const saved = window.localStorage.getItem(key);
    if (saved === "table" || saved === "chart") setView(saved);
  }, [key]);
  return [
    view,
    (v) => {
      setView(v);
      window.localStorage.setItem(key, v);
    },
  ];
}

const pillClass = (on: boolean) =>
  on
    ? "rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
    : "rounded-md border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground";

export default function SupervisorsPage() {
  const actor = useBootstrap().data?.actor;
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<IntelSort>("revenue");
  const [range, setRange] = React.useState<SupRange>("12m");
  const [view, setView] = useStoredView(actor?.userId);
  const [showQuiet, setShowQuiet] = React.useState(false);
  const q = useSupervisors({ search: search || undefined, sort, range });
  const d = q.data;
  const canCosts = d?.canSeeCosts ?? false;
  const sorts = canCosts ? SORTS : SORTS.filter((s) => s.key !== "gp");

  return (
    <Page title="Supervisors" subtitle="The people at builders and agencies, ranked by the work they sent Terra.">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setRange(r.key)} className={pillClass(range === r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="ml-auto inline-flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            onClick={() => setView("table")}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] ${view === "table" ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}
          >
            <Table2 className="size-4" /> Table
          </button>
          <button
            type="button"
            onClick={() => setView("chart")}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-[13px] ${view === "chart" ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}
          >
            <BarChart3 className="size-4" /> Chart
          </button>
        </div>
      </div>

      {/* Summary strip, in both views */}
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Stat label="Active supervisors" value={d?.summary.activeSupervisors ?? "…"} hint="Sent a job or quote in this period" />
        <Stat label="Revenue from supervisors" value={d ? money(d.summary.revenue) : "…"} hint="Delivered work they sent" />
        <button type="button" onClick={() => setShowQuiet((v) => !v)} className="text-left">
          <Stat
            label="Gone quiet"
            value={d?.summary.goneQuiet ?? "…"}
            tone={d && d.summary.goneQuiet > 0 ? "warning" : "default"}
            hint={d ? `Nothing for ${d.quietMonths}+ months. Tap to ${showQuiet ? "hide" : "see"} the list` : undefined}
          />
        </button>
      </div>

      {showQuiet && d ? (
        <Card className="mb-3">
          <CardHeader title="Gone quiet" subtitle={`Sent work before, nothing in the last ${d.quietMonths} months.`} />
          {d.quiet.length === 0 ? (
            <Empty>Nobody has gone quiet.</Empty>
          ) : (
            <div className="divide-y divide-border">
              {d.quiet.map((p) => (
                <Link key={p.id} to={`/supervisors/${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-secondary/60">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted-foreground">{p.companyName ?? "No company"}</p>
                  </div>
                  <span className="shrink-0 text-xs text-[var(--warning)]">Last sent {histDate(p.lastSent)}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {sorts.map((s) => (
            <button key={s.key} type="button" onClick={() => setSort(s.key)} className={pillClass(sort === s.key)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading || !d ? (
        <Card>
          <Loading label="Ranking supervisors…" />
        </Card>
      ) : view === "chart" ? (
        <ChartView d={d} sort={sort} />
      ) : (
        <>
          <div className="md:hidden">
            <CardList d={d} />
          </div>
          <div className="hidden md:block">
            <TableView d={d} />
          </div>
        </>
      )}
    </Page>
  );
}

type Data = NonNullable<ReturnType<typeof useSupervisors>["data"]>;

function GpCell({ r }: { r: Data["rows"][number] }) {
  if (r.gpState === "hidden") return null;
  if (r.gpState === "none") return <span className="text-xs text-muted-foreground">No delivered jobs</span>;
  if (r.grossProfit === null) return <span className="text-xs text-[var(--warning)]">incomplete</span>;
  return (
    <>
      {money(r.grossProfit)}
      {r.gpIncompleteJobs > 0 ? (
        <span className="ml-1 text-xs text-[var(--warning)]">+{r.gpIncompleteJobs} incomplete</span>
      ) : null}
    </>
  );
}

function NameCell({ r }: { r: Data["rows"][number] }) {
  return (
    <>
      <Link to={`/supervisors/${r.id}`} className="font-medium text-primary hover:underline">
        {r.name}
      </Link>
      {r.quiet ? <Badge className="ml-2">Gone quiet</Badge> : null}
      {r.mobile ? <p className="text-xs text-muted-foreground">{r.mobile}</p> : null}
    </>
  );
}

function TableView({ d }: { d: Data }) {
  return (
    <Card>
      <CardHeader title="Ranked by work sent" subtitle="Click a name for every job and quote that person sent." />
      {d.rows.length === 0 ? (
        <Empty>No supervisors yet. They appear here once a job or quote is saved with one picked.</Empty>
      ) : (
        <div className="board-scroll overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4">Supervisor</th>
                <th className="th px-4">Company</th>
                <th className="th px-4 text-right">Revenue</th>
                {d.canSeeCosts ? <th className="th px-4 text-right">Gross profit</th> : null}
                <th className="th px-4 text-right">Jobs</th>
                <th className="th px-4 text-right">Quotes sent</th>
                {d.canSeeCosts ? <th className="th px-4 text-right">Won</th> : null}
                {d.canSeeCosts ? <th className="th px-4 text-right">Win rate</th> : null}
                <th className="th px-4 text-right">Last sent</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                  <td className="px-4 py-2.5"><NameCell r={r} /></td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{r.companyName ?? "-"}</td>
                  <td className="tabular px-4 py-2.5 text-right font-semibold">{money(r.revenue)}</td>
                  {d.canSeeCosts ? <td className="tabular px-4 py-2.5 text-right"><GpCell r={r} /></td> : null}
                  <td className="tabular px-4 py-2.5 text-right">{r.jobs}</td>
                  <td className="tabular px-4 py-2.5 text-right">{r.quotesSent}</td>
                  {d.canSeeCosts ? <td className="tabular px-4 py-2.5 text-right">{r.quotesWon ?? 0}</td> : null}
                  {d.canSeeCosts ? <td className="tabular px-4 py-2.5 text-right">{r.winRate === null ? "-" : pct(r.winRate)}</td> : null}
                  <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{histDate(r.lastSent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function CardList({ d }: { d: Data }) {
  if (d.rows.length === 0) return <Card><Empty>No supervisors yet.</Empty></Card>;
  return (
    <div className="space-y-2">
      {d.rows.map((r) => (
        <Card key={r.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <NameCell r={r} />
              <p className="truncate text-xs text-muted-foreground">{r.companyName ?? "No company"}</p>
            </div>
            <p className="tabular shrink-0 text-base font-semibold">{money(r.revenue)}</p>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{r.jobs} jobs</span>
            <span>{r.quotesSent} quotes sent</span>
            {d.canSeeCosts ? <span>Win rate {r.winRate === null ? "-" : pct(r.winRate)}</span> : null}
            {d.canSeeCosts ? <span>GP <GpCell r={r} /></span> : null}
            <span>Last {histDate(r.lastSent)}</span>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ChartView({ d, sort }: { d: Data; sort: IntelSort }) {
  const metric = sort === "recent" ? "revenue" : sort;
  const label = metric === "gp" ? "Gross profit" : metric === "jobs" ? "Jobs" : "Revenue";
  const fmt = (n: number) => (metric === "jobs" ? String(n) : moneyShort(n));
  const data = d.top10.map((r) => ({ ...r, short: r.name.length > 18 ? `${r.name.slice(0, 17)}…` : r.name }));
  const c = d.concentration;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className={c ? "lg:col-span-2" : "lg:col-span-3"}>
        <CardHeader title={`Top 10 by ${label.toLowerCase()}`} subtitle={sort === "recent" ? "Most recent has no bars, so this shows revenue." : undefined} />
        {data.length === 0 ? (
          <Empty>Nothing to chart yet in this period.</Empty>
        ) : (
          <div className="px-2 py-3" style={{ height: Math.max(220, data.length * 36 + 30) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
                <XAxis type="number" tickFormatter={fmt} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="short" width={120} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v) => [metric === "jobs" ? String(v) : money(Number(v)), label]} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#C0603F" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {c ? (
        <Card>
          <CardHeader title="How concentrated" subtitle="Top 5 supervisors against everyone else, by revenue." />
          {c.top5Revenue + c.othersRevenue === 0 ? (
            <Empty>No revenue yet.</Empty>
          ) : (
            <div className="px-3 py-3">
              <div className="relative h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[{ name: "Top 5", value: c.top5Revenue }, { name: "Everyone else", value: c.othersRevenue }]}
                      dataKey="value"
                      innerRadius={55}
                      outerRadius={85}
                      startAngle={90}
                      endAngle={-270}
                    >
                      <Cell fill={COLOURS[0]} />
                      <Cell fill={COLOURS[5]} />
                    </Pie>
                    <Tooltip formatter={(v) => money(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <p className="tabular text-2xl font-bold">{Math.round(c.top5Percent)}%</p>
                  <p className="text-xs text-muted-foreground">from the top 5</p>
                </div>
              </div>
              <ul className="mt-2 space-y-1 text-xs">
                {c.top5.map((p) => (
                  <li key={p.id} className="flex justify-between gap-2">
                    <Link to={`/supervisors/${p.id}`} className="truncate hover:underline">{p.name}</Link>
                    <span className="tabular text-muted-foreground">{money(p.revenue)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      ) : null}
    </div>
  );
}
