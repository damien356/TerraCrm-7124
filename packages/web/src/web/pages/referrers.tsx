import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Input } from "../components/ui/field";
import { histDate, money } from "../lib/money";
import { useReferrers } from "../queries/people";
import { COMPANY_TYPE_LABELS, tagLabel } from "../../api/lib/person-tags";

/**
 * REFERRERS.
 *
 * Who sends Terra work. Only people tagged Supervisor or Property manager on a
 * job or quote count, plus the company they acted for. A job counts once per
 * company even when two of its people are tagged.
 *
 * Quoted is the latest sent version of each quote. Invoiced leaves out draft
 * and void invoices. Both are ex GST. Sales figures only, never cost.
 * Starts clean: it builds up as people get tagged on new work.
 */

type Tab = "people" | "companies";
type Preset = "12m" | "year" | "all" | "custom";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });

function presetRange(p: Preset): { from: string | null; to: string | null } {
  const t = today();
  if (p === "all") return { from: null, to: null };
  if (p === "year") return { from: `${t.slice(0, 4)}-01-01`, to: t };
  const d = new Date(`${t}T00:00:00`);
  d.setFullYear(d.getFullYear() - 1);
  d.setDate(d.getDate() + 1);
  return { from: d.toLocaleDateString("en-CA"), to: t };
}

const pillClass = (on: boolean) =>
  on
    ? "rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
    : "rounded-md border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground";

type Data = NonNullable<ReturnType<typeof useReferrers>["data"]>;
type Row = Data["people"][number];

export default function ReferrersPage() {
  const [tab, setTab] = React.useState<Tab>("people");
  const [preset, setPreset] = React.useState<Preset>("12m");
  const [range, setRange] = React.useState(() => presetRange("12m"));
  const [search, setSearch] = React.useState("");
  const q = useReferrers(range);
  const d = q.data;

  const pick = (p: Preset) => {
    setPreset(p);
    if (p !== "custom") setRange(presetRange(p));
  };

  const all = d ? (tab === "people" ? d.people : d.companies) : [];
  const s = search.trim().toLowerCase();
  const rows = s ? all.filter((r) => `${r.name} ${r.detail}`.toLowerCase().includes(s)) : all;
  const totals = d ? (tab === "people" ? d.totals.people : d.totals.companies) : null;
  const won = rows.reduce((n, r) => n + r.quotesWon, 0);

  return (
    <Page
      title="Referrers"
      subtitle="Supervisors and property managers who send work, and the companies they act for. Ex GST, sales only."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          {(["people", "companies"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`px-3 py-2 text-[13px] ${tab === t ? "bg-primary font-semibold text-primary-foreground" : "text-muted-foreground"}`}
            >
              {t === "people" ? "People" : "Companies"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["12m", "Last 12 months"],
              ["year", "This year"],
              ["all", "All time"],
              ["custom", "Dates"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" onClick={() => pick(k)} className={pillClass(preset === k)}>
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <label htmlFor="ref-from" className="flex items-center gap-1.5">
              From
              <Input
                id="ref-from"
                type="date"
                className="w-[150px]"
                value={range.from ?? ""}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value || null }))}
              />
            </label>
            <label htmlFor="ref-to" className="flex items-center gap-1.5">
              To
              <Input
                id="ref-to"
                type="date"
                className="w-[150px]"
                value={range.to ?? ""}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value || null }))}
              />
            </label>
          </div>
        ) : null}
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Stat label={tab === "people" ? "Referrers" : "Companies"} value={d ? rows.length : "…"} hint="Sent at least one quote or job in this period" />
        <Stat label="Quoted (ex GST)" value={totals ? money(s ? rows.reduce((n, r) => n + r.quotedTotal, 0) : totals.quotedTotal) : "…"} hint={d ? `${won} ${won === 1 ? "quote" : "quotes"} won` : undefined} />
        <Stat label="Invoiced (ex GST)" value={totals ? money(s ? rows.reduce((n, r) => n + r.invoicedTotal, 0) : totals.invoicedTotal) : "…"} hint="Draft and void invoices left out" />
      </div>

      <div className="mb-3 max-w-xs">
        <Input placeholder="Name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search referrers" />
      </div>

      {q.isLoading || !d ? (
        <Card>
          <Loading label="Adding up referrals…" />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <Empty>
            Nobody yet. People show here once they are tagged Supervisor or Property manager on a quote or job.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="space-y-2 md:hidden">
            {rows.map((r) => (
              <RowCard key={r.id} r={r} tab={tab} />
            ))}
          </div>
          <Card className="hidden md:block">
            <CardHeader title="Ranked by invoiced" subtitle="A job counts once per company, even when two of its people are tagged." />
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">{tab === "people" ? "Person" : "Company"}</th>
                    <th className="th px-4">{tab === "people" ? "Acted for" : "Type"}</th>
                    <th className="th px-4 text-right">Quotes sent</th>
                    <th className="th px-4 text-right">Quoted</th>
                    <th className="th px-4 text-right">Won</th>
                    <th className="th px-4 text-right">Jobs</th>
                    <th className="th px-4 text-right">Invoiced</th>
                    <th className="th px-4 text-right">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <NameCell r={r} tab={tab} />
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{detailText(r, tab)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{r.quotesSent}</td>
                      <td className="tabular px-4 py-2.5 text-right">{money(r.quotedTotal)}</td>
                      <td className="tabular px-4 py-2.5 text-right">{r.quotesWon}</td>
                      <td className="tabular px-4 py-2.5 text-right">{r.jobs}</td>
                      <td className="tabular px-4 py-2.5 text-right font-semibold">{money(r.invoicedTotal)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{histDate(r.lastActivity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </Page>
  );
}

function detailText(r: Row, tab: Tab) {
  if (tab === "companies") return COMPANY_TYPE_LABELS[r.detail] ?? r.detail ?? "";
  return r.detail || "No company";
}

function NameCell({ r, tab }: { r: Row; tab: Tab }) {
  return (
    <>
      <Link to={tab === "people" ? `/clients/${r.id}` : `/companies/${r.id}`} className="font-medium text-primary hover:underline">
        {r.name}
      </Link>
      {tab === "people" && r.tags.length ? (
        <p className="text-xs text-muted-foreground">{r.tags.map((t) => tagLabel(t)).join(", ")}</p>
      ) : null}
    </>
  );
}

function RowCard({ r, tab }: { r: Row; tab: Tab }) {
  return (
    <Card className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <NameCell r={r} tab={tab} />
          <p className="truncate text-xs text-muted-foreground">{detailText(r, tab)}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="tabular text-base font-semibold">{money(r.invoicedTotal)}</p>
          <p className="text-[11px] text-muted-foreground">invoiced</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{money(r.quotedTotal)} quoted</span>
        <span>
          {r.quotesWon} of {r.quotesSent} quotes won
        </span>
        <span>{r.jobs} jobs</span>
        <span>Last {histDate(r.lastActivity)}</span>
      </div>
    </Card>
  );
}
