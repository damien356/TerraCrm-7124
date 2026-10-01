import { Link } from "wouter";
import { AlertTriangle, ArrowRight, Clock, MapPin, Radio, Users2 } from "lucide-react";
import { Page } from "../components/layout";
import { OfficeTasksCard } from "../components/office-tasks";
import { CrewUpdatesCard } from "../components/crew-updates";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge, TASK_STATUS_COLOUR, TASK_STATUS_LABEL } from "../components/ui/badge";
import { useDashboard } from "../queries/dashboard";
import { useExpiringDocs } from "../queries/installers";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

function countdown(expiresAt: string | Date) {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
}

export default function DashboardPage() {
  const dash = useDashboard();
  const expiring = useExpiringDocs();

  if (dash.isLoading) return <Loading label="Loading today…" />;
  if (dash.isError) return <Page title="Dashboard"><Card><Empty>Couldn't load the dashboard. {String(dash.error)}</Empty></Card></Page>;

  const d = dash.data!;
  const today = new Date(`${d.today}T00:00:00`).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <Page
      title="Today"
      subtitle={today}
      actions={
        <Link
          to="/schedule"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
        >
          Open the board
          <ArrowRight className="size-4" />
        </Link>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="On today" value={d.todayTasks.length} hint="dispatches scheduled" />
        <Stat
          label="Needs a body"
          value={d.unfilled.length}
          tone={d.unfilled.length ? "warning" : "default"}
          hint="next 7 days, nobody on it"
        />
        <Stat
          label="Waiting on installers"
          value={d.pendingOffers.length}
          tone={d.pendingOffers.length ? "warning" : "default"}
          hint="offers still open"
        />
        <Stat
          label="Overdue"
          value={d.atRisk.length}
          tone={d.atRisk.length ? "danger" : "default"}
          hint="past their day, not finished"
        />
        <Stat label="Open jobs" value={d.counts.openJobs} hint={`${money(d.pipelineValue)} last 30 days`} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader title="On the tools today" subtitle={`${d.todayTasks.length} dispatches`} />
          {d.todayTasks.length === 0 ? (
            <Empty>Nothing scheduled for today.</Empty>
          ) : (
            <div className="divide-y divide-border">
              {d.todayTasks.map((t) => (
                <div key={t.id} className="flex items-start gap-3 px-4 py-3">
                  <div
                    className="mt-0.5 size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: t.installerColour ?? "#C0603F" }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{t.title}</p>
                      <Badge colour={TASK_STATUS_COLOUR[t.status]}>{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
                      {t.crewSize > 1 ? (
                        <Badge>
                          <Users2 className="size-3" />2 man
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>#{t.jobNumber}</span>
                      {t.startTime ? (
                        <span className="tabular inline-flex items-center gap-1">
                          <Clock className="size-3" />
                          {t.startTime}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="size-3" />
                        {t.siteSuburb || t.siteAddress || "No site"}
                      </span>
                      {t.skillName ? <span>{t.skillName}</span> : null}
                    </p>
                  </div>
                  <p className="shrink-0 text-xs font-medium">{t.installerName ?? "Unassigned"}</p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <CrewUpdatesCard />
        </div>

        <div className="space-y-4">
          <OfficeTasksCard />

          <Card>
            <CardHeader
              title="Offers out"
              subtitle="2 hours, then it comes back to you"
              action={<Radio className="size-4 text-[var(--warning)]" />}
            />
            {d.pendingOffers.length === 0 ? (
              <Empty>No offers waiting.</Empty>
            ) : (
              <div className="divide-y divide-border">
                {d.pendingOffers.slice(0, 6).map((o) => (
                  <Link key={o.id} to="/schedule" className="block px-4 py-2.5 transition-colors hover:bg-secondary/60">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{o.taskTitle}</p>
                      {o.payAmount != null ? (
                        <span className="tabular shrink-0 text-sm font-semibold">{money(o.payAmount)}</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      #{o.jobNumber} · {o.installerName} · {o.mode === "broadcast" ? "broadcast" : "direct"} ·{" "}
                      <span className="text-[var(--warning)]">{countdown(o.expiresAt)}</span>
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Needs a body" subtitle="Scheduled, nobody on it" />
            {d.unfilled.length === 0 ? (
              <Empty>Everything's covered.</Empty>
            ) : (
              <div className="divide-y divide-border">
                {d.unfilled.slice(0, 6).map((t) => (
                  <Link key={t.id} to="/schedule" className="block px-4 py-2.5 transition-colors hover:bg-secondary/60">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      #{t.jobNumber} · {t.scheduledDate ?? "unscheduled"} · {t.skillName ?? "no skill"}
                      {t.furnitureOnSite ? " · furniture" : ""}
                      {t.crewSize > 1 ? " · 2 man" : ""}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {d.atRisk.length > 0 ? (
            <Card>
              <CardHeader
                title="Overdue"
                subtitle="Day has passed, still not finished"
                action={<AlertTriangle className="size-4 text-destructive" />}
              />
              <div className="divide-y divide-border">
                {d.atRisk.slice(0, 5).map((t) => (
                  <div key={t.id} className="px-4 py-2.5">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      #{t.jobNumber} · {t.scheduledDate} · {t.installerName ?? "unassigned"} ·{" "}
                      {TASK_STATUS_LABEL[t.status] ?? t.status}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {expiring.data && expiring.data.length > 0 ? (
            <Card>
              <CardHeader title="Insurance expiring" subtitle="Inside 60 days" />
              <div className="divide-y divide-border">
                {expiring.data.map((i) => (
                  <div key={i.id} className="flex items-center justify-between px-4 py-2.5">
                    <p className="text-sm font-medium">{i.name}</p>
                    <p className="tabular text-xs text-[var(--warning)]">
                      {i.insuranceExpiry ? new Date(i.insuranceExpiry).toLocaleDateString("en-AU") : "—"}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}
        </div>
      </div>

      <Card className="mt-4">
        <CardHeader title="Activity" subtitle="Everything that's moved, newest first" />
        {d.recent.length === 0 ? (
          <Empty>Nothing logged yet.</Empty>
        ) : (
          <div className="divide-y divide-border">
            {d.recent.map((a) => (
              <div key={a.id} className="flex items-baseline gap-3 px-4 py-2">
                <p className="tabular w-28 shrink-0 text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleString("en-AU", {
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </p>
                <p className="min-w-0 flex-1 text-sm">
                  {a.detail}
                  <span className="ml-2 text-xs text-muted-foreground">{a.actorName}</span>
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Page>
  );
}
