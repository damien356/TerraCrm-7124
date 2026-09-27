import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { money, pct, histDate } from "../lib/money";
import { useSupervisor } from "../queries/intel";

/**
 * ONE SUPERVISOR.
 *
 * Every job and quote this person personally sent, with revenue and gross
 * profit side by side. Both numbers, always: someone who sent $600k at bad
 * margins is not automatically better than someone who sent $350k at good
 * ones and paid on time.
 */

const roleLabel = (r: string | null) => (r ?? "").replace(/_/g, " ");

export default function SupervisorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const q = useSupervisor(Number.isFinite(id) ? id : null);

  if (q.isLoading) return <Loading label="Loading supervisor…" />;
  if (q.error || !q.data) {
    return (
      <Page title="Supervisor not found">
        <Card>
          <Empty>
            <Link to="/supervisors" className="text-primary hover:underline">
              Back to supervisors
            </Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const d = q.data;
  const c = d.contact as unknown as {
    id: number;
    first_name: string;
    last_name: string;
    mobile: string | null;
    email: string | null;
    job_title: string | null;
  };
  const lt = d.lifetime;

  return (
    <Page
      title={`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Supervisor"}
      subtitle={
        <Link to="/supervisors" className="inline-flex items-center gap-1 text-primary hover:underline">
          <ArrowLeft className="size-3.5" /> All supervisors
        </Link>
      }
      actions={
        <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
          {c.mobile ? (
            <a href={`tel:${c.mobile}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
              <Phone className="size-3.5" /> {c.mobile}
            </a>
          ) : null}
          {c.email ? (
            <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
              <Mail className="size-3.5" /> {c.email}
            </a>
          ) : null}
        </div>
      }
    >
      <div className="space-y-4">
        {/* ------------------------- what they are worth ------------------------ */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Work sent" value={money(lt.revenue)} hint={`${lt.deliveredJobs} jobs delivered`} />
          <Stat
            label="Gross profit"
            value={lt.grossProfit === null ? "No cost data" : money(lt.grossProfit)}
            hint={
              lt.grossProfit === null
                ? "No costs recorded against these jobs"
                : `${pct(lt.marginPercent)} on ${money(lt.costedRevenue)} costed`
            }
          />
          <Stat label="Average job" value={money(lt.avgJobValue)} hint="Across delivered jobs" />
          <Stat
            label="Live now"
            value={lt.liveJobs === 0 ? "—" : money(lt.pipelineValue)}
            hint={
              lt.liveJobs === 0 ? "Nothing open" : `${lt.liveJobs} ${lt.liveJobs === 1 ? "job" : "jobs"} open`
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="px-4 py-3">
            <p className="label-xs">First job</p>
            <p className="tabular mt-1 text-sm font-medium">{histDate(lt.firstJob)}</p>
          </Card>
          <Card className="px-4 py-3">
            <p className="label-xs">Last job</p>
            <p className="tabular mt-1 text-sm font-medium">{histDate(lt.lastJob)}</p>
          </Card>
          <Card className="px-4 py-3">
            <p className="label-xs">Cancelled</p>
            <p className="tabular mt-1 text-sm font-medium">
              {lt.cancelledJobs === 0
                ? "None"
                : `${lt.cancelledJobs} ${lt.cancelledJobs === 1 ? "job" : "jobs"}`}
            </p>
          </Card>
        </div>

        {/* ----------------------------- companies ---------------------------- */}
        {d.companies.length > 0 ? (
          <Card>
            <CardHeader title="Works for" subtitle="The companies this person sits inside." />
            <div className="flex flex-wrap gap-2 px-4 py-3">
              {d.companies.map((co) => (
                <Link
                  key={co.id}
                  to={`/companies/${co.id}`}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[13px] hover:bg-secondary/60"
                >
                  <span className="font-medium">{co.name}</span>
                  {co.role ? <Badge>{roleLabel(co.role)}</Badge> : null}
                </Link>
              ))}
            </div>
          </Card>
        ) : null}

        {/* ------------------------------- jobs ------------------------------- */}
        <Card>
          <CardHeader
            title="Jobs they sent"
            subtitle="Every job attributed to this person, newest first."
            action={<Badge>{d.jobs.length}</Badge>}
          />
          {d.jobs.length === 0 ? (
            <Empty>No jobs are attributed to this person yet.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Job</th>
                    <th className="th px-4">Company</th>
                    <th className="th px-4">Status</th>
                    <th className="th px-4 text-right">Value</th>
                    <th className="th px-4 text-right">Gross profit</th>
                    <th className="th px-4 text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {d.jobs.map((j) => (
                    <tr key={j.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                          #{j.number}
                        </Link>
                        <p className="max-w-[320px] truncate text-xs text-muted-foreground">{j.title}</p>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {j.company_id ? (
                          <Link to={`/companies/${j.company_id}`} className="hover:text-foreground hover:underline">
                            {j.company_name ?? "—"}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge>{j.status ?? "—"}</Badge>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{money(j.value)}</td>
                      <td className="tabular px-4 py-2.5 text-right">
                        {j.grossProfit === null ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          money(j.grossProfit)
                        )}
                      </td>
                      <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
                        {histDate(j.date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ------------------------------ quotes ------------------------------ */}
        <Card>
          <CardHeader title="Quotes they asked for" subtitle="Including the ones that never landed." />
          {d.quotes.length === 0 ? (
            <Empty>No quotes recorded against this person.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Quote</th>
                    <th className="th px-4">Company</th>
                    <th className="th px-4">Status</th>
                    <th className="th px-4 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {d.quotes.map((qt) => (
                    <tr key={qt.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/quotes/${qt.id}`} className="font-medium text-primary hover:underline">
                          #{qt.number}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{qt.company_name ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <Badge>{qt.status}</Badge>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{money(qt.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Page>
  );
}
