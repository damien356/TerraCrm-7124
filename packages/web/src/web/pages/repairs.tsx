import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useRepairs } from "../queries/timber";

/**
 * TIMBER REPAIRS (spec 14 Oct, Part B, notes 18.38). Every repair lead Marc
 * has been asked to price, newest first. Open shows only the ones still
 * waiting on Marc or on an approval. Marc's price shows only to someone
 * who can see costs.
 */

export const REPAIR_STATUS_COLOUR: Record<string, string> = {
  new: "#8A8A8A",
  asked: "#8A6D1E",
  not_sent: "#B4442C",
  see: "#8E6C8A",
  priced: "#5B7C99",
  quoted: "#C0603F",
  sent: "#5B7C99",
  accepted: "#2F7A4B",
  offered: "#2F7A4B",
};

const money = (n: number | null | undefined) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const day = (d: Date | string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Brisbane" });

export default function RepairsPage() {
  const [open, setOpen] = React.useState(true);
  const list = useRepairs(open);
  const rows = list.data ?? [];
  const showMarc = rows.some((r) => r.marcPrice != null);

  return (
    <Page
      title="Timber repairs"
      subtitle="Repair leads priced by Marc from the photos. Approve sends the quote to the client."
      actions={
        <div className="flex gap-1.5">
          <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(true)}>
            Open
          </Button>
          <Button size="sm" variant={open ? "outline" : "default"} onClick={() => setOpen(false)}>
            All
          </Button>
        </div>
      }
    >
      <Card>
        <CardHeader title={open ? "Waiting on Marc or on you" : "Every repair"} subtitle={list.data ? `${rows.length} repair${rows.length === 1 ? "" : "s"}` : undefined} />
        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>{open ? "Nothing waiting. New repair leads show here as they come in." : "No timber repair leads yet."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-2 py-2 font-medium">Repair</th>
                  <th className="px-2 py-2 font-medium">Suburb</th>
                  <th className="px-2 py-2 font-medium">Status</th>
                  {showMarc ? <th className="px-2 py-2 text-right font-medium">Marc ex GST</th> : null}
                  <th className="px-2 py-2 text-right font-medium">Client incl GST</th>
                  <th className="px-4 py-2 text-right font-medium">In</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2">
                      <Link to={`/repairs/${r.id}`} className="font-medium text-primary hover:underline">
                        #{r.jobNumber}
                      </Link>
                      <p className="max-w-[240px] truncate text-xs text-muted-foreground">{r.jobTitle}</p>
                    </td>
                    <td className="px-2 py-2">{r.repairType}</td>
                    <td className="px-2 py-2">{r.suburb || "-"}</td>
                    <td className="px-2 py-2">
                      <Badge colour={REPAIR_STATUS_COLOUR[r.status] ?? null}>{r.statusLabel}</Badge>
                    </td>
                    {showMarc ? <td className="tabular px-2 py-2 text-right">{money(r.marcPrice)}</td> : null}
                    <td className="tabular px-2 py-2 text-right">{money(r.clientPrice)}</td>
                    <td className="tabular px-4 py-2 text-right text-muted-foreground">{day(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
