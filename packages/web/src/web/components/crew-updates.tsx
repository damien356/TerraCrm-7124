import { Link } from "wouter";
import {
  AlertTriangle,
  Camera,
  Clock,
  LogIn,
  LogOut,
  MessageSquareReply,
  MessageSquareText,
  Phone,
  StickyNote,
  UserX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { useCrewUpdates, useJobVisits } from "../queries/visits";

/* ---------------------------------------------------------------------------
 * What the crew did without touching a screen.
 *
 *   <CrewUpdatesCard>  dashboard: red photo flags, who is on site, and the feed
 *   <JobVisits>        job page: every arrival and departure on that job
 *
 * Red means someone left site without that day's completion photos. It stays
 * red until the photos land or they go back the same day.
 * ------------------------------------------------------------------------- */

const TZ = "Australia/Brisbane";

function clock(d: Date | string) {
  return new Date(d).toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}

function stamp(d: Date | string) {
  const date = new Date(d);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const day = date.toLocaleDateString("en-CA", { timeZone: TZ });
  if (day === today) return clock(date);
  return `${date.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })} ${clock(date)}`;
}

function dayLabel(iso: string) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  if (iso === today) return "today";
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function minutesBetween(a: Date | string, b: Date | string | null) {
  const end = b ? new Date(b).getTime() : Date.now();
  const m = Math.max(0, Math.round((end - new Date(a).getTime()) / 60000));
  return m >= 60 ? (m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`) : `${m} min`;
}

const ICON: Record<string, typeof Clock> = {
  site_arrived: LogIn,
  site_left: LogOut,
  site_left_no_photos: Camera,
  voice_late_client: Clock,
  voice_late_client_failed: AlertTriangle,
  voice_late_office: Clock,
  voice_call: Phone,
  field_note: StickyNote,
  sms_reply: MessageSquareReply,
  sms_opt_out: UserX,
};

const LABEL: Record<string, string> = {
  site_arrived: "Arrived",
  site_left: "Left site",
  site_left_no_photos: "No photos",
  voice_late_client: "Late, client texted",
  voice_late_client_failed: "Text failed",
  voice_late_office: "Running late",
  voice_call: "Call",
  field_note: "Crew note",
  sms_reply: "Client text",
  sms_opt_out: "Opted out",
};

export function CrewUpdatesCard() {
  const q = useCrewUpdates(3);
  const d = q.data;
  const reds = d?.flags.length ?? 0;

  return (
    <Card className={cn(reds ? "ring-1 ring-destructive/40" : "")}>
      <CardHeader
        title="Crew updates"
        subtitle="Arrivals, late messages, notes and client texts. Last 3 days."
        action={reds ? <Badge colour="#b23b2c" className="shrink-0 whitespace-nowrap">{reds} red</Badge> : <MessageSquareText className="size-4 text-muted-foreground" />}
      />
      {q.isLoading ? (
        <Loading label="Loading crew updates…" />
      ) : q.isError ? (
        <Empty>Couldn't load crew updates.</Empty>
      ) : (
        <>
          {reds ? (
            <div className="border-b border-border bg-destructive/[0.06]">
              {d!.flags.map((f) => (
                <Link
                  key={f.id}
                  to={`/jobs/${f.jobId}`}
                  className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-destructive/[0.1]"
                >
                  <Camera className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-destructive">
                      {f.installerName} left without {dayLabel(f.visitDate) === "today" ? "today's" : `${dayLabel(f.visitDate)}'s`} photos
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      #{f.jobNumber} {f.taskTitle} · {f.suburb ? `${f.suburb} · ` : ""}{f.photosHad ?? 0} of {f.photosNeeded ?? "?"} completion photos
                      {f.leftAt ? ` · left ${stamp(f.leftAt)}` : ""}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          ) : null}

          {d!.onSite.length ? (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
              <span className="label-xs mr-1 self-center">On site now</span>
              {d!.onSite.map((v) => (
                <Link
                  key={v.id}
                  to={`/jobs/${v.jobId}`}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--success)]/10 px-2.5 py-1 text-xs font-medium text-[var(--success)] transition-colors hover:bg-[var(--success)]/20"
                >
                  <span className="size-1.5 rounded-full bg-[var(--success)]" />
                  {v.installerName.split(" ")[0]} · {v.suburb || `#${v.jobNumber}`} · {minutesBetween(v.arrivedAt, null)}
                </Link>
              ))}
            </div>
          ) : null}

          {d!.events.length === 0 ? (
            <Empty>Nothing from the crew yet. Siri messages and site arrivals show up here.</Empty>
          ) : (
            <div className="max-h-[420px] divide-y divide-border overflow-y-auto">
              {d!.events.map((e) => {
                const Icon = ICON[e.action] ?? MessageSquareText;
                const body = (
                  <>
                    <Icon
                      className={cn(
                        "mt-0.5 size-4 shrink-0",
                        e.tone === "red" ? "text-destructive" : e.tone === "amber" ? "text-[var(--warning)]" : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">{e.detail}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {LABEL[e.action] ?? e.action}
                        {e.jobNumber ? ` · #${e.jobNumber}` : ""}
                      </p>
                    </div>
                    <p className="tabular shrink-0 text-[11px] text-muted-foreground">{stamp(e.createdAt)}</p>
                  </>
                );
                return e.jobId ? (
                  <Link key={e.id} to={`/jobs/${e.jobId}`} className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-secondary/60">
                    {body}
                  </Link>
                ) : (
                  <Link key={e.id} to="/conversations" className="flex items-start gap-2.5 px-4 py-2.5 transition-colors hover:bg-secondary/60">
                    {body}
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function JobVisits({ jobId }: { jobId: number }) {
  const q = useJobVisits(jobId);
  const rows = q.data ?? [];
  if (q.isLoading || rows.length === 0) return null;
  const reds = rows.filter((v) => v.flagged).length;

  return (
    <Card className={cn(reds ? "ring-1 ring-destructive/40" : "")}>
      <CardHeader
        title="Site visits"
        subtitle="Arrived and left, by the phone's location or tapped by hand"
        action={reds ? <Badge colour="#b23b2c" className="shrink-0 whitespace-nowrap">{reds} red</Badge> : null}
      />
      <div className="divide-y divide-border">
        {rows.map((v) => (
          <div
            key={v.id}
            className={cn("flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5", v.flagged ? "bg-destructive/[0.06]" : "", v.voided ? "opacity-55" : "")}
          >
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", v.flagged ? "text-destructive" : "")}>
                {v.installerName} · {dayLabel(v.visitDate)}
                <span className="ml-1.5 font-normal text-muted-foreground">{v.taskTitle}</span>
              </p>
              <p className="tabular mt-0.5 text-xs text-muted-foreground">
                {clock(v.arrivedAt)}
                {v.arriveSource === "manual" ? " (tapped)" : ""}
                {" to "}
                {v.leftAt ? `${clock(v.leftAt)}${v.leaveSource === "manual" ? " (tapped)" : ""}` : "still on site"}
                {" · "}
                {minutesBetween(v.arrivedAt, v.leftAt)}
              </p>
              {v.voided ? <p className="mt-0.5 text-xs text-muted-foreground">{v.voidReason ?? "Not counted"}</p> : null}
              {v.flagged ? (
                <p className="mt-0.5 text-xs text-destructive">Left without that day's completion photos. The dispatch stays open until they're in.</p>
              ) : null}
            </div>
            {v.flagged ? (
              <Badge colour="#b23b2c">
                <Camera className="size-3" />
                {v.photosHad ?? 0} of {v.photosNeeded ?? "?"} photos
              </Badge>
            ) : v.flag && v.flagClearedAt ? (
              <Badge colour="#3f7d3a">Photos sorted, {v.flagClearedReason}</Badge>
            ) : v.leftAt && !v.voided && v.photosNeeded ? (
              <Badge>
                {v.photosHad} of {v.photosNeeded} photos
              </Badge>
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}
