import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Mail, Phone } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
import { Combobox } from "../components/ui/combobox";
import { money, pct, histDate } from "../lib/money";
import { useSupervisor } from "../queries/intel";
import { useCompanies } from "../queries/companies";
import { useMoveSupervisorCompany } from "../queries/contacts";

/**
 * ONE SUPERVISOR.
 *
 * Every job and quote this person sent, with the company each one came from,
 * so a supervisor who changes company keeps their whole history. Gross profit
 * and win rate arrive from the server only for people allowed to see costs.
 */

const monthLabel = (m: string) => {
  const [y, mo] = m.split("-");
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString("en-AU", { month: "short", year: "2-digit" });
};

export default function SupervisorDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const q = useSupervisor(Number.isFinite(id) ? id : null);
  const [moving, setMoving] = React.useState(false);

  if (q.isLoading) return <Loading label="Loading supervisor…" />;
  if (q.error || !q.data) {
    return (
      <Page title="Supervisor not found">
        <Card>
          <Empty>
            <Link to="/supervisors" className="text-primary hover:underline">Back to supervisors</Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const d = q.data;
  const c = d.contact;
  const s = d.summary;
  const costs = d.canSeeCosts;
  const series = d.months.map((m) => ({ ...m, label: monthLabel(m.month) }));
  const hasSeries = series.some((m) => m.jobs > 0 || m.quotes > 0);

  return (
    <Page
      title={`${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Supervisor"}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Link to="/supervisors" className="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowLeft className="size-3.5" /> All supervisors
          </Link>
          {d.quiet ? <Badge>Gone quiet, last sent {histDate(d.quiet.lastSent)}</Badge> : null}
        </span>
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
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Work sent" value={money(s.revenue)} hint={`${s.deliveredJobs} jobs delivered`} />
          {costs ? (
            <Stat
              label="Gross profit"
              value={s.grossProfit === null ? "incomplete" : money(s.grossProfit)}
              hint={
                s.gpIncompleteJobs > 0
                  ? `${s.gpIncompleteJobs} ${s.gpIncompleteJobs === 1 ? "job is" : "jobs are"} missing a cost`
                  : "Sell price less installer and material cost"
              }
            />
          ) : null}
          <Stat label="Quotes sent" value={s.quotesSent} hint={costs && s.winRate !== null ? `${s.quotesWon} won, ${pct(s.winRate)} win rate` : undefined} />
          <Stat label="Live now" value={s.pipelineValue > 0 ? money(s.pipelineValue) : "-"} hint={`Last sent ${histDate(s.lastSent)}`} />
        </div>

        <Card>
          <CardHeader title="Work sent per month" subtitle="Jobs and quote requests over the last 24 months." />
          {!hasSeries ? (
            <Empty>Nothing sent yet.</Empty>
          ) : (
            <div className="h-60 px-2 py-3">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ left: 0, right: 16, top: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={2} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} />
                  <Tooltip />
                  <Line type="monotone" dataKey="jobs" name="Jobs" stroke="#C0603F" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="quotes" name="Quotes" stroke="#5B7C99" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Companies"
            subtitle="Which company each stretch of work came from. History stays when they move."
            action={
              <Button size="sm" variant="ghost" onClick={() => setMoving((v) => !v)}>
                {moving ? "Cancel" : "Moved company?"}
              </Button>
            }
          />
          {moving ? <MoveForm contactId={c.id} email={c.email} onDone={() => setMoving(false)} /> : null}
          {d.history.length === 0 ? (
            <Empty>No work recorded yet.</Empty>
          ) : (
            <div className="divide-y divide-border">
              {d.history.map((h) => (
                <div key={h.companyId ?? 0} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <div>
                    {h.companyId ? (
                      <Link to={`/companies/${h.companyId}`} className="font-medium text-primary hover:underline">{h.name}</Link>
                    ) : (
                      <span className="font-medium">{h.name}</span>
                    )}
                    <p className="text-xs text-muted-foreground">{histDate(h.first)} to {histDate(h.last)}</p>
                  </div>
                  <p className="tabular text-xs text-muted-foreground">
                    {h.jobs} jobs, {h.quotes} quotes, {money(h.revenue)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Jobs they sent" subtitle="Newest first. Company shows where each job came from." action={<Badge>{d.jobs.length}</Badge>} />
          {d.jobs.length === 0 ? (
            <Empty>No jobs yet.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Job</th>
                    <th className="th px-4">Company</th>
                    <th className="th px-4">Status</th>
                    <th className="th px-4 text-right">Sell</th>
                    {costs ? <th className="th px-4 text-right">Gross profit</th> : null}
                    <th className="th px-4 text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {d.jobs.map((j) => (
                    <tr key={j.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">#{j.displayNumber ?? j.number}</Link>
                        <p className="max-w-[320px] truncate text-xs text-muted-foreground">{j.title}</p>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{j.companyName ?? "-"}</td>
                      <td className="px-4 py-2.5"><Badge>{j.status || "-"}</Badge></td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{money(j.value)}</td>
                      {costs ? (
                        <td className="tabular px-4 py-2.5 text-right">
                          {j.gpState === "incomplete" ? (
                            <span className="text-xs text-[var(--warning)]">incomplete</span>
                          ) : (
                            money(j.grossProfit)
                          )}
                        </td>
                      ) : null}
                      <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{histDate(j.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Quotes they asked for" subtitle="Including the ones that never landed." />
          {d.quotes.length === 0 ? (
            <Empty>No quotes yet.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Quote</th>
                    <th className="th px-4">Company</th>
                    <th className="th px-4">Status</th>
                    <th className="th px-4 text-right">Total</th>
                    <th className="th px-4 text-right">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {d.quotes.map((qt) => (
                    <tr key={qt.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/quotes/${qt.id}`} className="font-medium text-primary hover:underline">#{qt.number}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{qt.companyName ?? "-"}</td>
                      <td className="px-4 py-2.5"><Badge>{qt.status}</Badge></td>
                      <td className="tabular px-4 py-2.5 text-right font-medium">{money(qt.total)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{histDate(qt.date)}</td>
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

/** Moves the person to a new company. Old work keeps its old company, and Damien gets an email. */
function MoveForm({ contactId, email, onDone }: { contactId: number; email: string | null; onDone: () => void }) {
  const companies = useCompanies();
  const move = useMoveSupervisorCompany();
  const [companyId, setCompanyId] = React.useState("");
  const [newEmail, setNewEmail] = React.useState(email ?? "");
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setError(null);
    if (!companyId) {
      setError("Pick the new company.");
      return;
    }
    try {
      await move.mutateAsync({
        contactId,
        toCompanyId: Number(companyId),
        email: newEmail.trim() === (email ?? "") ? undefined : newEmail.trim() || null,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-3 border-b border-border bg-secondary/40 px-4 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="New company">
          <Combobox
            value={companyId}
            onChange={setCompanyId}
            placeholder="Search companies…"
            emptyLabel="Pick a company…"
            options={(companies.data ?? []).map((co) => ({ value: String(co.id), label: co.name }))}
          />
        </Field>
        <Field label="Email at the new company" hint="Leave as is if it did not change.">
          <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">
        Their old jobs and quotes stay under the old company. Damien gets an email so he can chase work at the new place.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <Button size="sm" onClick={save} disabled={move.isPending}>
        {move.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
        Save the move
      </Button>
    </div>
  );
}
