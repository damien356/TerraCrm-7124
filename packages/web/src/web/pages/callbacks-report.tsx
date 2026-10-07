import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Field, Input } from "../components/ui/field";
import { useCallbackReport } from "../queries/callbacks";

/**
 * CALLBACKS REPORT. Admin only. Every callback opened in the range, who did
 * the original work, and what fixing it cost. Report only: nothing here is
 * charged to the installer.
 */

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

function brisbaneDay(d: Date) {
  return d.toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
}

export default function CallbacksReportPage() {
  const [from, setFrom] = React.useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return brisbaneDay(d);
  });
  const [to, setTo] = React.useState(() => brisbaneDay(new Date()));
  const report = useCallbackReport({ from: from || null, to: to || null });
  const d = report.data;

  return (
    <Page
      title="Callbacks"
      subtitle="Return visits, who did the original work, and what fixing them cost. For tracking only. Nobody is charged."
      actions={
        <div className="flex items-end gap-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      }
    >
      {report.isLoading ? (
        <Loading label="Loading callbacks…" />
      ) : !d ? (
        <Card>
          <Empty>Couldn't load the report.</Empty>
        </Card>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Callbacks" value={d.totals.callbacks} />
            <Stat label="Not chargeable" value={d.totals.notChargeable} hint="Done free for the client" />
            <Stat label="Rework cost" value={money(d.totals.cost)} tone={d.totals.cost > 0 ? "warning" : "default"} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="By installer" subtitle="Held against whoever did the original work." />
              {d.perInstaller.length === 0 ? (
                <Empty>No callbacks in this range.</Empty>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Installer</th>
                      <th className="px-2 py-2 text-right font-medium">Callbacks</th>
                      <th className="px-2 py-2 text-right font-medium">Installer error</th>
                      <th className="px-4 py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.perInstaller.map((r) => (
                      <tr key={r.installerId ?? "none"} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">{r.name}</td>
                        <td className="tabular px-2 py-2 text-right">{r.callbacks}</td>
                        <td className="tabular px-2 py-2 text-right">{r.installerError}</td>
                        <td className="tabular px-4 py-2 text-right">{money(r.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card>
              <CardHeader title="By cause" />
              {d.perCause.length === 0 ? (
                <Empty>No callbacks in this range.</Empty>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {d.perCause.map((c) => (
                      <tr key={c.cause} className="border-b border-border last:border-0">
                        <td className="px-4 py-2">{c.label}</td>
                        <td className="tabular px-2 py-2 text-right">{c.callbacks}</td>
                        <td className="tabular px-4 py-2 text-right">{money(c.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader title="Every callback" />
            {d.callbacks.length === 0 ? (
              <Empty>No callbacks opened between these dates.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Callback</th>
                      <th className="px-2 py-2 font-medium">Cause</th>
                      <th className="px-2 py-2 font-medium">Original work by</th>
                      <th className="px-2 py-2 font-medium">Opened</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.callbacks.map((c) => (
                      <tr key={c.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                        <td className="px-4 py-2">
                          <Link to={`/jobs/${c.id}`} className="font-medium text-primary hover:underline">
                            #{c.ref}
                          </Link>
                          <p className="max-w-[260px] truncate text-xs text-muted-foreground">{c.title}</p>
                        </td>
                        <td className="px-2 py-2">
                          <span className="flex flex-wrap items-center gap-1.5">
                            {c.causeLabel}
                            {c.chargeable === false ? <Badge colour="#8A6D1E">Free</Badge> : null}
                            {c.cause === "installer_error" && c.payInstaller === false ? <Badge colour="#B4442C">Unpaid visit</Badge> : null}
                          </span>
                        </td>
                        <td className="px-2 py-2">{c.originalInstallerName ?? "Nobody recorded"}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {new Date(c.createdAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                        </td>
                        <td className="px-2 py-2 text-xs">{c.status ?? "No status"}</td>
                        <td className="tabular px-4 py-2 text-right">{money(c.cost)}</td>
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
