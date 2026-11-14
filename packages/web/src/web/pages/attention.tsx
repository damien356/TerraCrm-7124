import { Link, useSearch } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { useAttention } from "../queries/attention";
import { auDay, cn } from "../lib/utils";

/* ---------------------------------------------------------------------------
 * Needs attention (Damien, 14 Nov 2026). What the Terra Today widget opens.
 *
 * Enquiries needing action (his rule, see api/lib/widget.ts), then the
 * dashboard's own lists, whole: Needs a body, Waiting on installers, Overdue
 * and Schedule incomplete. ?show=enquiries|unfilled|offers|overdue|incomplete
 * opens one of them. No new rules and no money.
 * ------------------------------------------------------------------------- */

const SUBTITLE: Record<string, string> = {
  enquiries: "Lead or Quoted, with a first call, office task or callback due now. The date is when it came in.",
  unfilled: "Scheduled in the next week or not dated, nobody on it",
  offers: "Offer sent, waiting for an answer",
  overdue: "Final working day has passed, still not finished",
  incomplete: "Booked, but the working days are not set",
};

export default function AttentionPage() {
  const q = useAttention();
  const show = new URLSearchParams(useSearch()).get("show");

  if (q.isLoading) return <Loading label="Loading…" />;
  if (q.isError) {
    return (
      <Page title="Needs attention">
        <Card>
          <Empty>Couldn't load the list. {String(q.error)}</Empty>
        </Card>
      </Page>
    );
  }

  const sections = q.data!.sections;
  const picked = sections.find((s) => s.key === show);
  const visible = picked ? [picked] : sections;
  const total = new Set(sections.flatMap((s) => s.rows.map((r) => r.key))).size;

  return (
    <Page title="Needs attention" subtitle={`${total} ${total === 1 ? "item" : "items"}, each counted once`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Link
          to="/attention"
          className={cn("rounded-full border px-3 py-1 text-xs font-medium", !picked ? "border-primary bg-primary text-white" : "border-border hover:bg-secondary/60")}
        >
          All
        </Link>
        {sections.map((s) => (
          <Link
            key={s.key}
            to={`/attention?show=${s.key}`}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium",
              picked?.key === s.key ? "border-primary bg-primary text-white" : "border-border hover:bg-secondary/60",
            )}
          >
            {s.label} ({s.rows.length})
          </Link>
        ))}
      </div>

      <div className="grid gap-4">
        {visible.map((s) => (
          <Card key={s.key}>
            <CardHeader title={`${s.label} (${s.rows.length})`} subtitle={SUBTITLE[s.key]} />
            {s.rows.length === 0 ? (
              <Empty>Nothing here.</Empty>
            ) : (
              <div className="divide-y divide-border">
                {s.rows.map((r) => (
                  <Link key={`${s.key}-${r.key}`} to={r.path} className="block px-4 py-2.5 transition-colors hover:bg-secondary/60">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[r.ref, r.suburb, r.date ? auDay(r.date) : "Not dated", r.note].filter(Boolean).join(" · ")}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </Page>
  );
}
