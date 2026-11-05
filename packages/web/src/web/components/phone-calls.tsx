import * as React from "react";
import { Link } from "wouter";
import { PhoneCall } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import {
  useAssignFollowup,
  useClaimFollowup,
  useJobManager,
  usePhoneConfig,
  usePhoneFollowup,
  usePhoneForContact,
  usePhoneForJob,
  usePhoneStatus,
  useReopenFollowup,
  useResolveFollowup,
  useSetJobManager,
  useStartFollowup,
} from "../queries/phoneCalls";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * AI phone calls: the shared pieces (Retell, 5 Nov). The follow-up row and its
 * panel, a call row, and the cards on a job and on a person.
 * ------------------------------------------------------------------------- */

export const FOLLOWUP_STATE_LABEL: Record<string, string> = {
  new: "New",
  assigned: "Assigned",
  in_progress: "In progress",
  resolved: "Resolved",
};
const FOLLOWUP_STATE_COLOUR: Record<string, string> = {
  new: "#C0603F",
  assigned: "#4A7FA5",
  in_progress: "#D08A1E",
  resolved: "#3F7D3A",
};
const PRIORITY_COLOUR: Record<string, string> = { normal: "#7A736D", high: "#D08A1E", urgent: "#B23B2C" };

export const when = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" })
    : "";

export const duration = (sec: number | null | undefined) => {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
};

export type FollowupRow = {
  id: number;
  title: string;
  detail: string;
  status: string;
  priority: string;
  ownerProfileId: number | null;
  ownerName: string;
  queueKey: string;
  typeLabel: string;
  dueLabel: string;
  overdue: boolean;
  jobId: number | null;
  jobRef: string | null;
  callId: number | null;
  escalationLevel: number;
};

export function StateBadge({ status }: { status: string }) {
  return <Badge colour={FOLLOWUP_STATE_COLOUR[status] ?? null}>{FOLLOWUP_STATE_LABEL[status] ?? status}</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  if (priority === "normal") return null;
  return <Badge colour={PRIORITY_COLOUR[priority] ?? null}>{priority === "urgent" ? "Urgent" : "High"}</Badge>;
}

/** One follow-up line. Opens the panel. */
export function FollowupLine({ f, onOpen }: { f: FollowupRow; onOpen: (id: number) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(f.id)} className="flex w-full flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-secondary/60">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <StateBadge status={f.status} />
            <PriorityBadge priority={f.priority} />
            {f.escalationLevel > 0 ? <Badge colour="#B23B2C">Escalated</Badge> : null}
            <span className="text-sm font-medium">{f.title}</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {f.typeLabel}
            {f.jobRef ? ` · Job ${f.jobRef}` : ""}
            {" · "}
            {f.ownerProfileId ? f.ownerName : `Waiting in the ${f.queueKey || "office"} queue`}
          </span>
        </span>
        {f.status !== "resolved" && f.dueLabel ? (
          <span className={cn("shrink-0 text-xs", f.overdue ? "font-semibold text-destructive" : "text-muted-foreground")}>
            {f.overdue ? "Overdue, was due " : "Due "}
            {f.dueLabel}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The follow-up panel: what it is, who has it, and the buttons to move it along. */
export function FollowupPanel({ id, onClose }: { id: number | null; onClose: () => void }) {
  const fu = usePhoneFollowup(id);
  const status = usePhoneStatus();
  const cfg = usePhoneConfig();
  const claim = useClaimFollowup();
  const assign = useAssignFollowup();
  const start = useStartFollowup();
  const resolve = useResolveFollowup();
  const reopen = useReopenFollowup();
  const [to, setTo] = React.useState("");
  const [note, setNote] = React.useState("");
  const [resolution, setResolution] = React.useState("");
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    setTo("");
    setNote("");
    setResolution("");
    setMsg(null);
  }, [id]);

  const busy = claim.isPending || assign.isPending || start.isPending || resolve.isPending || reopen.isPending;
  const done = (text: string) => ({ onSuccess: () => setMsg({ ok: true, text }), onError: (e: unknown) => setMsg({ ok: false, text: errorText(e) }) });
  const f = fu.data;
  const me = status.data?.me ?? null;
  const mine = !!f && f.ownerProfileId === me;
  const canReassign = !!status.data?.canReassign;
  const people = cfg.data?.people ?? [];

  return (
    <Modal open={id !== null} onClose={onClose} title={f ? f.title : "Follow-up"} subtitle={f ? f.typeLabel : undefined} width="max-w-2xl">
      {fu.isLoading ? (
        <Loading />
      ) : fu.error ? (
        <p className="text-sm text-destructive">{errorText(fu.error)}</p>
      ) : f ? (
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <StateBadge status={f.status} />
            <PriorityBadge priority={f.priority} />
            {f.escalationLevel > 0 ? <Badge colour="#B23B2C">Escalated {f.escalationLevel > 1 ? `x${f.escalationLevel}` : ""}</Badge> : null}
            {f.jobId ? (
              <Link to={`/jobs/${f.jobId}`} className="text-xs font-medium text-primary hover:underline">
                Job {f.jobRef}
              </Link>
            ) : null}
            {f.callId ? (
              <Link to={`/phone-calls/${f.callId}`} className="text-xs font-medium text-primary hover:underline">
                Open the call
              </Link>
            ) : null}
          </div>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[130px_1fr]">
            <dt className="label-xs">Owner</dt>
            <dd>{f.ownerProfileId ? f.ownerName : `Nobody yet, waiting in the ${f.queueKey || "office"} queue`}</dd>
            <dt className="label-xs">How it got there</dt>
            <dd className="text-muted-foreground">{f.routedVia || "Not recorded"}</dd>
            {f.status !== "resolved" ? (
              <>
                <dt className="label-xs">Deadline</dt>
                <dd className={f.overdue ? "font-semibold text-destructive" : ""}>{f.dueLabel || "None"}</dd>
              </>
            ) : (
              <>
                <dt className="label-xs">Resolved</dt>
                <dd>
                  {when(f.resolvedAt)} by {f.resolvedByName}. {f.resolution}
                </dd>
              </>
            )}
          </dl>
          {f.detail ? <p className="whitespace-pre-wrap rounded-md bg-secondary/60 px-3 py-2">{f.detail}</p> : null}

          {f.status !== "resolved" ? (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <div className="flex flex-wrap gap-2">
                {!mine ? (
                  <Button size="sm" disabled={busy || (!!f.ownerProfileId && !canReassign)} onClick={() => claim.mutate({ id: f.id }, done("It's yours now."))}>
                    Take it
                  </Button>
                ) : null}
                {mine && f.status !== "in_progress" ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => start.mutate({ id: f.id }, done("Marked in progress."))}>
                    Start
                  </Button>
                ) : null}
              </div>
              {mine || canReassign ? (
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div>
                    <p className="label-xs">Pass it to</p>
                    <Select className="mt-0.5 h-8" value={to} onChange={(e) => setTo(e.target.value)}>
                      <option value="">Choose someone</option>
                      {people
                        .filter((p) => p.id !== f.ownerProfileId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </Select>
                  </div>
                  <div>
                    <label htmlFor={`fu-note-${f.id}`} className="label-xs block">
                      Note for them (optional)
                    </label>
                    <input id={`fu-note-${f.id}`} aria-label="Note for them" className="mt-0.5 h-8 w-full rounded-md border border-border bg-card px-2 text-sm" value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                  <Button size="sm" variant="outline" disabled={busy || !to} onClick={() => assign.mutate({ id: f.id, toProfileId: Number(to), note }, done("Passed on. They have been told, and the deadline is unchanged."))}>
                    Pass on
                  </Button>
                </div>
              ) : null}
              <div className="grid gap-2">
                <p className="label-xs">What was done</p>
                <Textarea rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} placeholder="Rang them back and booked the measure for Tuesday." />
                <div>
                  <Button size="sm" disabled={busy || resolution.trim().length < 3} onClick={() => resolve.mutate({ id: f.id, resolution: resolution.trim() }, done("Resolved."))}>
                    Resolve
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => reopen.mutate({ id: f.id, why: "" }, done("Reopened."))}>
                Reopen
              </Button>
            </div>
          )}
          {msg ? <p className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</p> : null}

          <div>
            <p className="label-xs">Who was told</p>
            {f.notices.length === 0 ? (
              <p className="text-xs text-muted-foreground">No notifications yet.</p>
            ) : (
              <ul className="mt-1 grid gap-1 text-xs">
                {f.notices.map((n) => (
                  <li key={n.id} className={n.status === "failed" || n.status === "not_connected" || n.status === "no_device" ? "text-destructive" : "text-muted-foreground"}>
                    {when(n.at)} · {n.name ?? "Someone"} · {n.channel} · {n.status}
                    {n.detail ? ` · ${n.detail}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="label-xs">History</p>
            <ul className="mt-1 grid gap-1 text-xs text-muted-foreground">
              {f.history.map((h) => (
                <li key={h.id}>
                  {when(h.at)} · {h.actorName || "System"} · {h.detail}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export type CallRow = {
  id: number;
  callerName: string | null;
  fromNumber: unknown;
  withheld: unknown;
  startedAt: unknown;
  durationSec: unknown;
  typeLabel: string;
  summary: unknown;
  outcome: unknown;
  status: unknown;
  needsPerson: unknown;
  newEnquiry: unknown;
  verified: boolean;
  jobRef: string | null;
  jobId: unknown;
};

export function CallLine({ c }: { c: CallRow }) {
  const who = c.callerName || (c.withheld ? "Number withheld" : String(c.fromNumber ?? "Unknown caller"));
  return (
    <li>
      <Link to={`/phone-calls/${c.id}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 py-3 hover:bg-secondary/60">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{who}</span>
            {c.newEnquiry ? <Badge colour="#4A7FA5">New enquiry</Badge> : null}
            {c.needsPerson ? <Badge colour="#D08A1E">Needs a person</Badge> : null}
            {c.status === "failed" ? <Badge colour="#B23B2C">Failed</Badge> : null}
            {c.callerName && !c.verified ? <Badge>Not verified</Badge> : null}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {c.typeLabel}
            {c.jobRef ? ` · Job ${c.jobRef}` : ""}
            {c.summary ? ` · ${String(c.summary).slice(0, 140)}` : ""}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {when(c.startedAt as string | null)}
          {c.durationSec != null ? ` · ${duration(c.durationSec as number)}` : ""}
        </span>
      </Link>
    </li>
  );
}

function PhoneCard({ data, title, children }: { data: ReturnType<typeof usePhoneForJob>["data"]; title: string; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState<number | null>(null);
  if (!data || (data.hidden && !children)) return null;
  return (
    <Card>
      <CardHeader title={title} subtitle="Calls the AI phone agent took, and anything still to do." />
      {children}
      {data.hidden ? null : (
        <>
          {data.followups.length ? (
            <ul className="divide-y divide-border border-b border-border">
              {data.followups.map((f) => (
                <FollowupLine key={f.id} f={f} onOpen={setOpen} />
              ))}
            </ul>
          ) : null}
          {data.calls.length === 0 ? (
            <Empty>
              <PhoneCall className="mx-auto mb-1 size-4" />
              No AI phone calls yet.
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {data.calls.slice(0, 8).map((c) => (
                <CallLine key={c.id} c={c} />
              ))}
            </ul>
          )}
          <FollowupPanel id={open} onClose={() => setOpen(null)} />
        </>
      )}
    </Card>
  );
}

/** Who looks after this job for phone calls. Calls about it go to them first. */
function JobManagerPicker({ jobId }: { jobId: number }) {
  const jm = useJobManager(jobId);
  const cfg = usePhoneConfig();
  const set = useSetJobManager();
  const [err, setErr] = React.useState("");
  if (!jm.data || jm.data.tablesMissing) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 text-sm">
      <span className="label-xs">Job manager</span>
      <Select
        className="h-8 w-auto min-w-[180px]"
        value={jm.data.profileId ?? ""}
        disabled={set.isPending}
        onChange={(e) => {
          setErr("");
          set.mutate({ jobId, profileId: e.target.value ? Number(e.target.value) : null }, { onError: (x) => setErr(errorText(x)) });
        }}
      >
        <option value="">Nobody set</option>
        {(cfg.data?.people ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      {err ? <span className="text-xs text-destructive">{err}</span> : null}
    </div>
  );
}

export function JobPhoneCard({ jobId }: { jobId: number }) {
  const q = usePhoneForJob(jobId);
  const jm = useJobManager(jobId);
  const showPicker = !!jm.data && !jm.data.tablesMissing;
  return (
    <PhoneCard data={q.data} title="AI phone calls">
      {showPicker ? <JobManagerPicker jobId={jobId} /> : null}
    </PhoneCard>
  );
}

export function ContactPhoneCard({ contactId }: { contactId: number }) {
  const q = usePhoneForContact(contactId);
  return <PhoneCard data={q.data} title="AI phone calls" />;
}

/** What is set up and what is not, in plain words, above every tab. */
export function PhoneSetupNotes() {
  const s = usePhoneStatus();
  if (!s.data) return null;
  const d = s.data;
  const notes: { bad: boolean; text: string }[] = [];
  if (d.tablesMissing.length) notes.push({ bad: true, text: "The phone tables aren't set up yet. They need the approved database update before anything here works." });
  if (!d.retellKeySet) notes.push({ bad: true, text: "The Retell key isn't set, so Retell can't reach Terra Ops yet." });
  notes.push({ bad: !d.enabled, text: d.enabled ? "The agent is switched on." : "The agent is switched off. Every call is handed to a person." });
  if (!d.emailConnected) notes.push({ bad: true, text: "Email sending isn't connected, so email notifications can't go out. In app and phone push still work." });
  const noPush = d.channels.filter((c) => c.push !== "connected").map((c) => c.name);
  if (noPush.length) notes.push({ bad: true, text: `No phone signed in for push: ${noPush.join(", ")}.` });
  if (!d.sweepRunning && !d.tablesMissing.length) notes.push({ bad: true, text: "Reminders and escalation aren't running on this server." });
  return (
    <ul className="grid gap-1 rounded-md border border-border bg-card px-4 py-3 text-xs">
      {notes.map((n, i) => (
        <li key={i} className={n.bad ? "text-destructive" : "text-muted-foreground"}>
          {n.text}
        </li>
      ))}
    </ul>
  );
}
