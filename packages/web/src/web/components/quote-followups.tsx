import * as React from "react";
import { Link } from "wouter";
import { Pause, Play, Send, SkipForward, Square } from "lucide-react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Textarea } from "./ui/field";
import { errorText } from "./public-shell";
import {
  useFollowupEdit,
  useFollowupEnrol,
  useFollowupPause,
  useFollowupResume,
  useFollowupSetDate,
  useFollowupSkip,
  useFollowupStop,
  useJobFollowups,
  useQuoteFollowups,
} from "../queries/quote-followups";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * Quote follow-ups on the quote and the job (28 Oct). Shows every step, the
 * date it goes, what it says, why it is held, and what went. Preview, edit,
 * move a date, skip, pause, resume, stop. Nothing here sends: the timer does,
 * after its checks, and only when follow-ups are switched on in Settings.
 * ------------------------------------------------------------------------- */

type View = NonNullable<ReturnType<typeof useQuoteFollowups>["data"]>;
type SentStep = View["steps"][number];
type PlanStep = View["plan"][number];

const SEQ_LABEL: Record<string, string> = { active: "On", paused: "Paused", stopped: "Stopped", done: "Finished" };
const SEQ_COLOUR: Record<string, string> = { active: "#2f7d4f", paused: "#9a6b12", stopped: "#b23b2c", done: "#4b5563" };
const STEP_LABEL: Record<string, string> = {
  scheduled: "Waiting",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  needs_review: "Needs a look",
  skipped: "Skipped",
  stopped: "Stopped",
};
const STEP_COLOUR: Record<string, string | undefined> = { sent: "#2f7d4f", failed: "#b23b2c", needs_review: "#9a6b12", stopped: "#b23b2c" };

const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const when = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" }) : "";
const weekday = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-AU", { weekday: "short", timeZone: "UTC" });

function Preview({ subject, text, words, open }: { subject: string | null; text: string | null; words?: number | null; open?: boolean }) {
  if (!text) return null;
  return (
    <details className="mt-1.5 text-xs" open={open}>
      <summary className="cursor-pointer text-primary">What it says{words ? ` (${words} words)` : ""}</summary>
      <div className="mt-1.5 min-w-0 overflow-hidden rounded-md border border-border bg-secondary/40 px-3 py-2">
        {subject ? <p className="mb-1.5 break-words font-medium">{subject}</p> : null}
        <p className="whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">{text}</p>
      </div>
    </details>
  );
}

function Flags({ review, notes, warnings, skip }: { review: string[]; notes: string[]; warnings: string[]; skip: string | null }) {
  if (!review.length && !notes.length && !warnings.length && !skip) return null;
  return (
    <ul className="mt-1 grid gap-0.5 text-xs">
      {skip ? <li className="text-muted-foreground">Will be skipped: {skip}</li> : null}
      {warnings.map((w) => (
        <li key={w} className="text-destructive">
          {w}
        </li>
      ))}
      {review.map((w) => (
        <li key={w} className="text-[#9a6b12]">
          Check before it goes: {w}
        </li>
      ))}
      {notes.map((w) => (
        <li key={w} className="text-muted-foreground">
          {w}
        </li>
      ))}
    </ul>
  );
}

/** One step of a running sequence, with its own controls. */
function StepRow({ st, live, onDone, onFail }: { st: SentStep; live: boolean; onDone: (t: string) => void; onFail: (e: unknown) => void }) {
  const skip = useFollowupSkip();
  const edit = useFollowupEdit();
  const setDate = useFollowupSetDate();
  const [editing, setEditing] = React.useState(false);
  const [subject, setSubject] = React.useState(st.subject ?? "");
  const [body, setBody] = React.useState(st.text ?? "");
  const [moving, setMoving] = React.useState(false);
  const [date, setDateValue] = React.useState(st.dueDate);
  const open = ["scheduled", "needs_review", "failed"].includes(st.status);

  return (
    <li className={cn("min-w-0 break-words px-3 py-2", st.isNext && "bg-secondary/30")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            Day {st.step}: {st.purpose}
          </p>
          <p className="text-xs text-muted-foreground">
            {st.status === "sent"
              ? `Sent ${when(st.sentAt)} to ${st.to ?? ""}${st.cc ? `, copying in ${st.cc}` : ""}`
              : `${weekday(st.dueDate)} ${ddmm(st.dueDate)}${st.dateAgreed ? ", date agreed with the customer" : ""}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge colour={STEP_COLOUR[st.status]}>{STEP_LABEL[st.status] ?? st.status}</Badge>
          {st.isNext ? <Badge>Next</Badge> : null}
          {open && live ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEditing((x) => !x)}>
                Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setMoving((x) => !x)}>
                Move date
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={skip.isPending}
                onClick={() => window.confirm(`Skip the day ${st.step} follow-up? It will not be sent.`) && skip.mutate({ stepId: st.id }, { onSuccess: () => onDone("Skipped."), onError: onFail })}
              >
                <SkipForward className="size-3.5" /> Skip
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {st.reason ? <p className="mt-1 text-xs text-muted-foreground">{st.reason}</p> : null}
      {st.error ? <p className="mt-1 text-xs text-destructive">Error: {st.error}</p> : null}
      {st.message ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Logged on the thread as {st.message.status}
          {st.message.statusDetail ? ` (${st.message.statusDetail})` : ""}, via {st.message.via}. Delivery and opens are not reported back.
        </p>
      ) : null}
      {st.status !== "sent" ? <Flags review={st.review} notes={st.notes} warnings={st.warnings} skip={st.skip} /> : null}
      {moving ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <p className="label-xs">Date the customer agreed</p>
            <Input type="date" className="mt-0.5 h-8" value={date} onChange={(e) => setDateValue(e.target.value)} />
          </div>
          <Button
            size="sm"
            disabled={setDate.isPending || !date}
            onClick={() =>
              setDate.mutate(
                { stepId: st.id, date },
                {
                  onSuccess: () => {
                    setMoving(false);
                    onDone("Date saved. A weekend or holiday moves to the next business day.");
                  },
                  onError: onFail,
                },
              )
            }
          >
            Save date
          </Button>
        </div>
      ) : null}
      {editing ? (
        <div className="mt-2 grid gap-2">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
          <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Email" />
          <p className="text-xs text-muted-foreground">Keep the quote link and the unsubscribe line. Edited wording is not changed by a new version: check it again if the quote is revised.</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={edit.isPending}
              onClick={() =>
                edit.mutate(
                  { stepId: st.id, subject, body },
                  {
                    onSuccess: () => {
                      setEditing(false);
                      onDone("Wording saved.");
                    },
                    onError: onFail,
                  },
                )
              }
            >
              Save wording
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Preview subject={st.subject} text={st.text} words={st.status === "sent" ? null : st.words} />
      )}
    </li>
  );
}

/** People copied in on the quote who are left off the follow-ups, and why. */
function LeftOff({ list }: { list: Array<{ email: string; why: string }> }) {
  if (!list.length) return null;
  return (
    <p className="text-amber-700 dark:text-amber-400">
      Not copied in: {list.map((l) => `${l.email} (${l.why})`).join("; ")}.
    </p>
  );
}

function PlanRow({ p }: { p: PlanStep }) {
  return (
    <li className="min-w-0 break-words px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            Day {p.step}: {p.purpose}
          </p>
          <p className="text-xs text-muted-foreground">
            {p.status === "skipped" ? "Already passed. Not sent." : `${weekday(p.dueDate)} ${ddmm(p.dueDate)}${p.moved ? `, ${p.moved}` : ""}`}
          </p>
        </div>
        <Badge>{p.status === "skipped" ? "Passed" : p.skip ? "Would skip" : "Would go"}</Badge>
      </div>
      {p.status !== "skipped" ? (
        <>
          <Flags review={p.review} notes={p.notes} warnings={p.warnings} skip={p.skip} />
          <Preview subject={p.subject} text={p.text} words={p.words} />
        </>
      ) : null}
    </li>
  );
}

/** The card for one quote number. */
export function QuoteFollowupsCard({ quoteId, title }: { quoteId: number; title?: string }) {
  const q = useQuoteFollowups(quoteId);
  if (q.isLoading) {
    return (
      <Card>
        <CardHeader title={title ?? "Quote follow-ups"} />
        <Loading />
      </Card>
    );
  }
  /* A draft, or a quote that never went and has no follow-ups: nothing to show. */
  if (!q.data || (!q.data.sequence && !q.data.plan.length)) return null;
  return <FollowupsBody view={q.data} quoteId={quoteId} title={title} />;
}

function FollowupsBody({ view: v, quoteId, title }: { view: View; quoteId: number; title?: string }) {
  const enrol = useFollowupEnrol();
  const pause = useFollowupPause();
  const resume = useFollowupResume();
  const stop = useFollowupStop();
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [pausing, setPausing] = React.useState(false);
  const [until, setUntil] = React.useState("");
  const [why, setWhy] = React.useState("");
  const done = (text: string) => setNote({ ok: true, text });
  const fail = (e: unknown) => setNote({ ok: false, text: errorText(e) });
  const seq = v.sequence;
  const live = !!seq && (seq.status === "active" || seq.status === "paused");

  return (
    <Card id="quote-followups" className="min-w-0 scroll-mt-4 overflow-hidden">
      <CardHeader
        title={title ?? "Quote follow-ups"}
        subtitle={`Days 3, 7, 14 and 25 after the quote goes, at ${v.settings.sendHour}am customer time. Weekends and holidays move to the next business day.`}
        action={seq ? <Badge colour={SEQ_COLOUR[seq.status]}>{SEQ_LABEL[seq.status] ?? seq.status}</Badge> : <Badge>Not started</Badge>}
      />
      <div className="grid min-w-0 gap-3 break-words px-4 py-3 text-sm [overflow-wrap:anywhere]">
        {note ? <p className={cn("text-xs", note.ok ? "text-muted-foreground" : "text-destructive")}>{note.text}</p> : null}
        {v.cautions.map((c) => (
          <p key={c} className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
            {c}
          </p>
        ))}
        {v.blockers.map((b) => (
          <p key={b} className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {b}
          </p>
        ))}

        {seq ? (
          <>
            <div className="grid gap-0.5 text-xs text-muted-foreground">
              <p>
                To {v.to ?? "nobody"}
                {v.cc.length ? `, copying in ${v.cc.join(", ")}` : ""}. Signed by {seq.assignedName || "the office"}. Consent: {seq.consentBasis || "not recorded"}. Started {seq.enrolledHow === "backlog" ? "by hand" : "on send"}
                {seq.enrolledByName ? ` by ${seq.enrolledByName}` : ""}.
              </p>
              <LeftOff list={v.ccLeftOff} />
              {seq.reason ? <p className={cn(seq.status === "active" ? "" : "text-destructive")}>{seq.reason}</p> : null}
              {seq.pausedUntil ? <p>Nothing goes before {ddmm(seq.pausedUntil)}.</p> : null}
              {seq.nextCheck ? <p>Next one, checked now: {seq.nextCheck}</p> : null}
              {v.validUntil ? <p>Quote valid until {ddmm(v.validUntil)}.</p> : null}
            </div>
            <ul className="min-w-0 divide-y divide-border rounded-md border border-border">
              {v.steps.map((st) => (
                <StepRow key={st.id} st={st} live={live} onDone={done} onFail={fail} />
              ))}
            </ul>
            {live ? (
              <div className="flex flex-wrap items-center gap-2">
                {seq.status === "active" ? (
                  <Button size="sm" variant="outline" onClick={() => setPausing((x) => !x)}>
                    <Pause className="size-3.5" /> Pause
                  </Button>
                ) : (
                  <Button size="sm" disabled={resume.isPending} onClick={() => resume.mutate({ id: seq.id }, { onSuccess: () => done("Resumed. The next step goes on its day, never two at once."), onError: fail })}>
                    <Play className="size-3.5" /> Resume
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={stop.isPending}
                  onClick={() => {
                    const reason = window.prompt("Stop all follow-ups on this quote? Say why (optional).", "");
                    if (reason === null) return;
                    stop.mutate({ id: seq.id, reason }, { onSuccess: () => done("Stopped."), onError: fail });
                  }}
                >
                  <Square className="size-3.5" /> Stop
                </Button>
              </div>
            ) : null}
            {pausing ? (
              <div className="grid gap-2 rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">Leave the date empty to pause until someone resumes. Pick a date for "contact me next month": nothing goes before it, then the next step goes once.</p>
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <p className="label-xs">Wait until (optional)</p>
                    <Input type="date" className="mt-0.5 h-8" value={until} onChange={(e) => setUntil(e.target.value)} />
                  </div>
                  <div className="min-w-48 flex-1">
                    <p className="label-xs">Note</p>
                    <Input className="mt-0.5 h-8" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Customer is away until March" />
                  </div>
                  <Button
                    size="sm"
                    disabled={pause.isPending}
                    onClick={() =>
                      pause.mutate(
                        { id: seq.id, until: until || null, note: why },
                        {
                          onSuccess: () => {
                            setPausing(false);
                            done(until ? `Waiting until ${ddmm(until)}.` : "Paused.");
                          },
                          onError: fail,
                        },
                      )
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : v.plan.length ? (
          <>
            <p className="text-xs text-muted-foreground">
              If started today{v.to ? `, to ${v.to}` : ""}
              {v.cc.length ? `, copying in ${v.cc.join(", ")}` : ""}. Steps that have passed are not sent late.
            </p>
            <div className="text-xs text-muted-foreground">
              <LeftOff list={v.ccLeftOff} />
            </div>
            <ul className="min-w-0 divide-y divide-border rounded-md border border-border">
              {v.plan.map((p) => (
                <PlanRow key={p.step} p={p} />
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={enrol.isPending || v.blockers.length > 0 || !v.startFrom}
                onClick={() =>
                  v.startFrom &&
                  window.confirm(`Start follow-ups on this quote from day ${v.startFrom}? Each one is checked again before it goes.`) &&
                  enrol.mutate({ quoteId, firstStep: v.startFrom as 3 | 7 | 14 | 25 }, { onSuccess: () => done("Started."), onError: fail })
                }
              >
                <Send className="size-3.5" /> Start follow-ups{v.startFrom ? ` from day ${v.startFrom}` : ""}
              </Button>
            </div>
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">
          A reply, text or call logged on the job pauses them. Every quote out with a customer is on the <Link href="/marketing/quote-followups" className="text-primary hover:underline">follow-ups backlog</Link>.
        </p>
      </div>
    </Card>
  );
}

/** Every quote on a job that is out with the customer or has follow-ups. Nothing shows when there are none. */
export function JobQuoteFollowups({ jobId }: { jobId: number }) {
  const q = useJobFollowups(jobId);
  if (!q.data?.length) return null;
  return (
    <>
      {q.data.map((v) => (
        <FollowupsBody key={v.quoteId} view={v} quoteId={v.quoteId} title={`Quote ${v.ref} follow-ups`} />
      ))}
    </>
  );
}
