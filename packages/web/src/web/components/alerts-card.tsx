import { Link } from "wouter";
import { BellDot, Check, Mail } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { useClearAlert, useClearAllAlerts, useOpenAlerts } from "../queries/alerts";

/* ---------------------------------------------------------------------------
 * Alerts on the Dashboard (fix list 11 Oct, item 15). Every notification Terra
 * Ops sends the office lands here as well as on the phone, so nothing is lost
 * when no phone has push set up. Tick one to clear it, or clear them all.
 * ------------------------------------------------------------------------- */

const TZ = "Australia/Brisbane";

function ago(d: Date | string) {
  const date = new Date(d);
  const mins = Math.round((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const time = date.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  if (date.toLocaleDateString("en-CA", { timeZone: TZ }) === today) return `today ${time}`;
  return `${date.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function AlertsCard() {
  const q = useOpenAlerts();
  const clear = useClearAlert();
  const clearAll = useClearAllAlerts();
  const rows = q.data?.alerts ?? [];
  const total = q.data?.total ?? 0;
  return (
    <Card>
      <CardHeader
        title="Alerts"
        subtitle={total ? `${total} not cleared` : "What happened while you were out"}
        action={
          total > 1 ? (
            <button
              type="button"
              disabled={clearAll.isPending}
              onClick={() => clearAll.mutate(undefined)}
              className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
            >
              Clear all
            </button>
          ) : (
            <BellDot className="size-4 text-[var(--gold-deep)]" />
          )
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>No alerts. Crew offers, client replies, payments and price checks show here.</Empty>
      ) : (
        <div className="board-scroll max-h-[420px] divide-y divide-border overflow-y-auto" data-testid="alerts-list">
          {rows.map((a) => (
            <div key={a.id} className="flex items-start gap-2.5 px-4 py-2.5">
              <button
                type="button"
                title="Clear"
                aria-label="Clear alert"
                disabled={clear.isPending}
                onClick={() => clear.mutate({ id: a.id })}
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-transparent transition-colors hover:border-[var(--success)] hover:text-[var(--success)]"
              >
                <Check className="size-3" />
              </button>
              <div className="min-w-0 flex-1">
                {a.path ? (
                  <Link href={a.path} className="text-sm font-medium leading-snug hover:underline">
                    {a.title}
                  </Link>
                ) : (
                  <p className="text-sm font-medium leading-snug">{a.title}</p>
                )}
                {a.body ? <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{a.body}</p> : null}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span>{ago(a.createdAt)}</span>
                  {a.jobId && a.jobNumber ? <span>#{a.jobNumber}</span> : null}
                  {a.emailedAt ? (
                    <span className="inline-flex items-center gap-0.5" title="Also emailed, it is on your urgent list">
                      <Mail className="size-3" /> emailed
                    </span>
                  ) : null}
                </p>
              </div>
            </div>
          ))}
          {total > rows.length ? <p className="px-4 py-2 text-xs text-muted-foreground">And {total - rows.length} older.</p> : null}
        </div>
      )}
    </Card>
  );
}
