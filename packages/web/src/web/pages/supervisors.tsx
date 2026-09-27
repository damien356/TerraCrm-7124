import * as React from "react";
import { Link } from "wouter";
import { Search, TriangleAlert } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Input } from "../components/ui/field";
import { money, pct, histDate } from "../lib/money";
import { useSupervisors, type IntelSort } from "../queries/intel";

/**
 * SUPERVISORS.
 *
 * Ambrose might be worth $500k, but one supervisor may have personally sent
 * $350k of it. That person is who to look after, and this page ranks them.
 *
 * It leads with what it cannot attribute. The imported history almost never
 * records who sent a job, so the ranked list below is a sliver of the real
 * picture, and saying so is the whole point. A page that showed the top 15
 * silently would be read as the answer.
 */

const SORTS: { key: IntelSort; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "gp", label: "Gross profit" },
  { key: "jobs", label: "Jobs" },
  { key: "recent", label: "Most recent" },
];

export default function SupervisorsPage() {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<IntelSort>("revenue");
  const q = useSupervisors({ search: search || undefined, sort });
  const all = q.data?.rows ?? [];
  const gap = q.data?.attribution;

  /**
   * People whose only link is quoted or cancelled work have nothing to rank on,
   * and a page of $0 rows buries the handful of names that matter. They are
   * counted under the table rather than dropped silently.
   */
  const rows = all.filter((r) => r.revenue > 0 || r.pipelineValue > 0);
  const quotedOnly = all.length - rows.length;

  return (
    <Page
      title="Supervisors"
      subtitle="The people inside builders and agencies, ranked by the work they personally sent Terra."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              className={
                sort === s.key
                  ? "rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
                  : "rounded-md border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {gap && gap.unattributedJobs > 0 ? <AttributionGap gap={gap} /> : null}

      <Card>
        <CardHeader
          title="Ranked by work sent"
          subtitle="Click a name for every job and quote that person personally put through."
        />
        {q.isLoading ? (
          <Loading label="Ranking supervisors…" />
        ) : rows.length === 0 ? (
          <Empty>
            Nobody is linked to a company job yet. Set a contact on a job, or add a supervisor to the job's
            people, and they will appear here.
          </Empty>
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Supervisor</th>
                  <th className="th px-4">Company</th>
                  <th className="th px-4 text-right">Revenue</th>
                  <th className="th px-4 text-right">Gross profit</th>
                  <th className="th px-4 text-right">Jobs</th>
                  <th className="th px-4 text-right">Avg job</th>
                  <th className="th px-4 text-right">Pipeline</th>
                  <th className="th px-4 text-right">Last job</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <Link to={`/supervisors/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.name}
                      </Link>
                      {r.mobile ? <p className="text-xs text-muted-foreground">{r.mobile}</p> : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {r.companies.length === 0 ? "—" : r.companies.slice(0, 2).join(", ")}
                      {r.companies.length > 2 ? ` +${r.companies.length - 2}` : ""}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-semibold">{money(r.revenue)}</td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {r.grossProfit === null ? (
                        <span className="text-xs text-muted-foreground">no cost data</span>
                      ) : (
                        <>
                          {money(r.grossProfit)}
                          <span className="ml-1 text-xs text-muted-foreground">{pct(r.marginPercent)}</span>
                        </>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{r.deliveredJobs}</td>
                    <td className="tabular px-4 py-2.5 text-right">{money(r.avgJobValue)}</td>
                    <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                      {r.pipelineValue > 0 ? money(r.pipelineValue) : "—"}
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
        {quotedOnly > 0 ? (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            {quotedOnly} more {quotedOnly === 1 ? "person is" : "people are"} linked only to quoted or
            cancelled work, so they have nothing to rank on yet.
          </p>
        ) : null}
      </Card>
    </Page>
  );
}

/**
 * The honest header. Of the company-billed jobs in the system, this says how
 * many have a named person behind them and how many do not, in money as well
 * as count, so the table below is read for what it is.
 */
function AttributionGap({
  gap,
}: {
  gap: {
    unattributedJobs: number;
    unattributedValue: number;
    attributedJobs: number;
    attributedValue: number;
  };
}) {
  const totalJobs = gap.attributedJobs + gap.unattributedJobs;
  const share = totalJobs > 0 ? Math.round((gap.attributedJobs / totalJobs) * 100) : 0;
  return (
    <Card className="mb-4 border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-4 py-3.5">
      <div className="flex items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">
            Only {gap.attributedJobs} of {totalJobs.toLocaleString("en-AU")} company jobs have a person
            attached to them.
          </p>
          <p className="text-[13px] text-muted-foreground">
            {money(gap.attributedValue)} of delivered work is attributed to a named supervisor.{" "}
            {money(gap.unattributedValue)} across {gap.unattributedJobs.toLocaleString("en-AU")} jobs is not,
            because the ServiceM8 import arrived with the company on the job but nobody's name. The ranking
            below is real, it is just {share}% of the picture.
          </p>
          <p className="text-[13px] text-muted-foreground">
            It fixes itself going forward: set the supervisor on a job, or link them under the company's
            people, and the numbers here fill in.
          </p>
        </div>
      </div>
    </Card>
  );
}
