import * as React from "react";
import { Link, useParams } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { errorText } from "../components/public-shell";
import { FollowupLine, FollowupPanel, duration, when } from "../components/phone-calls";
import { usePhoneCall } from "../queries/phoneCalls";

/**
 * One AI phone call (Retell, 5 Nov): who rang, what the agent did, what is
 * left and who was told. The transcript and recording load only on a button
 * press, only for roles allowed to, and opening them is audited.
 */

const ACTION_STATUS_COLOUR: Record<string, string> = { done: "#3F7D3A", failed: "#B23B2C", refused: "#D08A1E", running: "#7A736D", uncertain: "#D08A1E" };

export default function PhoneCallDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [withTranscript, setWithTranscript] = React.useState(false);
  const [open, setOpen] = React.useState<number | null>(null);
  const q = usePhoneCall(Number.isFinite(id) ? id : null, withTranscript);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) {
    return (
      <Page title="AI phone call">
        <Card>
          <Empty>{q.error ? errorText(q.error) : "Call not found."}</Empty>
        </Card>
      </Page>
    );
  }
  const c = q.data;
  const who = c.callerName || (c.withheld ? "Number withheld" : String(c.fromNumber ?? "Unknown caller"));

  return (
    <Page
      title={`Call from ${who}`}
      subtitle={
        <>
          {when(c.startedAt as string | null)}
          {c.durationSec != null ? ` · ${duration(c.durationSec as number)}` : ""} · {c.typeLabel}
          {" · "}
          <Link to="/phone-calls?tab=calls" className="text-primary hover:underline">
            All calls
          </Link>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="grid min-w-0 content-start gap-4">
          <Card>
            <CardHeader title="What happened" />
            <div className="grid gap-3 px-4 py-3 text-sm">
              <div className="flex flex-wrap gap-1.5">
                {c.newEnquiry ? <Badge colour="#4A7FA5">New enquiry</Badge> : null}
                {c.needsPerson ? <Badge colour="#D08A1E">Needs a person</Badge> : null}
                {c.status === "failed" ? <Badge colour="#B23B2C">Failed</Badge> : null}
                <Badge>{c.verified ? `Caller verified${c.verifyMethod ? ` (${c.verifyMethod})` : ""}` : "Caller not verified"}</Badge>
                {c.priority && c.priority !== "normal" ? <Badge colour="#B23B2C">{String(c.priority)}</Badge> : null}
              </div>
              <p className="whitespace-pre-wrap">{String(c.summary || "No summary yet. It arrives once Retell finishes analysing the call.")}</p>
              {c.outcome ? <p className="text-muted-foreground">Outcome: {String(c.outcome)}</p> : null}
              {c.disconnectionReason ? <p className="text-xs text-muted-foreground">How it ended: {c.disconnectionReason}</p> : null}
              <p className="text-xs text-muted-foreground">
                {c.jobId ? (
                  <Link to={`/jobs/${c.jobId}`} className="text-primary hover:underline">
                    Job {c.jobRef}
                  </Link>
                ) : (
                  "No job"
                )}
                {c.contactId ? (
                  <>
                    {" · "}
                    <Link to={`/clients/${c.contactId}`} className="text-primary hover:underline">
                      {c.callerName || "Customer card"}
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="What the agent did" subtitle="Only actions saved in Terra Ops were confirmed to the caller." />
            {c.actions.length === 0 ? (
              <Empty>No actions on this call.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {c.actions.map((a) => (
                  <li key={a.id} className="px-4 py-2.5 text-sm">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge colour={ACTION_STATUS_COLOUR[a.status] ?? null}>{a.status}</Badge>
                      <span className="font-medium">{a.name.replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">{when(a.at)}</span>
                    </span>
                    {a.say ? <p className="mt-0.5 text-muted-foreground">Told the caller: "{a.say}"</p> : null}
                    {a.error ? <p className="mt-0.5 text-xs text-destructive">{a.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Transcript and recording"
              action={
                c.mayReadTranscript && !withTranscript && (c.hasTranscript || c.hasRecording) ? (
                  <Button size="sm" variant="outline" onClick={() => setWithTranscript(true)}>
                    Open
                  </Button>
                ) : undefined
              }
            />
            <div className="px-4 py-3 text-sm">
              {!c.mayReadTranscript ? (
                <p className="text-muted-foreground">Your role can't open transcripts or recordings.</p>
              ) : !c.hasTranscript && !c.hasRecording ? (
                <p className="text-muted-foreground">None saved for this call.</p>
              ) : !withTranscript ? (
                <p className="text-muted-foreground">Opening it is recorded in the history.</p>
              ) : (
                <div className="grid gap-3">
                  {c.recordingUrl ? (
                    <audio controls src={c.recordingUrl} className="w-full" aria-label="Call recording">
                      {/* No caption file from Retell. The transcript below is the text version. */}
                      <track kind="captions" />
                    </audio>
                  ) : null}
                  {c.transcript ? <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md bg-secondary/60 px-3 py-2 font-sans text-[13px]">{c.transcript}</pre> : null}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="Still to do" />
            {c.followups.length === 0 ? (
              <Empty>Nothing left for a person.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {c.followups.map((f) => (
                  <FollowupLine key={f.id} f={f} onOpen={setOpen} />
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Who was told" />
            {c.notices.length === 0 ? (
              <Empty>No notifications.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {c.notices.map((n) => (
                  <li key={n.id} className="px-4 py-2 text-xs">
                    <span className={n.status === "sent" ? "" : "text-destructive"}>
                      {n.name ?? "Someone"} · {n.channel} · {n.status}
                    </span>
                    <span className="block text-muted-foreground">
                      {when(n.at)}
                      {n.detail ? ` · ${n.detail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <FollowupPanel id={open} onClose={() => setOpen(null)} />
    </Page>
  );
}
