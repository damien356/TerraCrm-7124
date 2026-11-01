import * as React from "react";
import { CheckCircle2, Hand, Pause, Play, RotateCcw, Square, Star, ThumbsDown } from "lucide-react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Input } from "./ui/field";
import { errorText } from "./public-shell";
import { CareCard } from "./care-card";
import { PauseForm } from "./comms-pause";
import { RecipientApprovalModal, type RecipientPerson } from "./comms-recipients";
import { GuideButton } from "./comms-guides";
import { JobQuoteFollowups } from "./quote-followups";
import { useCareApproveMember, useCareSetMemberStatus } from "../queries/care";
import {
  useCommsPanel,
  useGuideRetry,
  useReviewApprove,
  useReviewDeclined,
  useReviewPause,
  useReviewReceived,
  useReviewRecipient,
  useReviewResume,
  useReviewRetry,
  useReviewSetup,
  useReviewStop,
  useReviewWhat,
  useSetBuilderRef,
  useSetDirectContactOk,
} from "../queries/customer-comms";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * CUSTOMER COMMUNICATIONS on a job (Damien, 31 Oct). One card that says who
 * gets what, when it sends, and how to stop it. In order:
 *   People on this job, Quote follow-ups, Care guides, Review request.
 * Nothing on this card sends the moment a button is pressed, except "Send"
 * in the care guide picker, which the office reads first.
 * ------------------------------------------------------------------------- */

type Panel = NonNullable<ReturnType<typeof useCommsPanel>["data"]>;
type Person = Panel["people"][number];
type ReviewRow = NonNullable<Panel["review"]["row"]>;

/** The statuses the office sees (31 Oct). */
const STATUS: Record<string, { label: string; colour?: string }> = {
  not_configured: { label: "Not configured" },
  awaiting_approval: { label: "Awaiting approval", colour: "#9a6b12" },
  scheduled: { label: "Scheduled", colour: "#2f7d4f" },
  active: { label: "Scheduled", colour: "#2f7d4f" },
  sent: { label: "Sent", colour: "#2f5f9e" },
  failed: { label: "Failed", colour: "#b23b2c" },
  skipped: { label: "Skipped" },
  stopped: { label: "Stopped", colour: "#b23b2c" },
  unsubscribed: { label: "Stopped (unsubscribed)", colour: "#b23b2c" },
  paused: { label: "Paused", colour: "#9a6b12" },
  done: { label: "Finished" },
};

const StatusBadge = ({ s }: { s: string }) => <Badge colour={STATUS[s]?.colour}>{STATUS[s]?.label ?? s}</Badge>;

const when = (d: number | string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" }) : "";
const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

function Section({ title, subtitle, children, id }: { title: string; subtitle?: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="grid min-w-0 gap-2 border-t border-border px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function CustomerCommsCard({ jobId, isAdmin, showFollowups = true, showCareFacts = true }: { jobId: number; isAdmin: boolean; showFollowups?: boolean; showCareFacts?: boolean }) {
  const q = useCommsPanel(jobId);
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  if (q.isLoading) {
    return (
      <Card>
        <CardHeader title="Customer communications" />
        <Loading />
      </Card>
    );
  }
  if (!q.data) return null;
  const p = q.data;
  const done = (text: string) => setNote({ ok: true, text });
  const fail = (e: unknown) => setNote({ ok: false, text: errorText(e) });

  return (
    <Card id="customer-comms" className="min-w-0 scroll-mt-4 overflow-hidden" data-testid="customer-comms">
      <CardHeader
        title="Customer communications"
        subtitle={`${p.job.typeLabel} job. Who gets what, when it sends, and how to stop it. Nothing goes to anyone who isn't approved here.`}
        action={<Badge>{p.job.typeLabel}</Badge>}
      />
      {note ? <p className={cn("px-4 pb-2 text-xs", note.ok ? "text-[var(--success)]" : "text-destructive")}>{note.text}</p> : null}
      <AtAGlance p={p} />
      <PeopleSection p={p} onDone={done} onFail={fail} />
      {showFollowups ? (
        <Section title="Quote follow-ups" subtitle="Emails after a quote goes out. Approve who gets them first.">
          {p.followups.length ? <JobQuoteFollowups jobId={jobId} /> : <p className="text-xs text-muted-foreground">Not configured. No quote on this job is out with the customer.</p>}
        </Section>
      ) : null}
      <CareSection p={p} isAdmin={isAdmin} showCareFacts={showCareFacts} onDone={done} onFail={fail} />
      <ReviewSection p={p} onDone={done} onFail={fail} />
      <HistorySection p={p} />
    </Card>
  );
}

/* ------------------------------ at a glance ------------------------------ */

function AtAGlance({ p }: { p: Panel }) {
  const rows: Array<{ what: string; who: string; status: string; next: string; stop: string }> = [];
  for (const f of p.followups) {
    const seq = f.sequence;
    const nextStep = f.steps.find((s) => s.isNext);
    rows.push({
      what: `Quote ${f.ref} follow-ups`,
      who: seq ? `${seq.toAddress ?? "nobody"}${seq.ccAddresses.length ? `, CC ${seq.ccAddresses.join(", ")}` : ""}` : "Not picked",
      status: seq ? seq.status : "not_configured",
      next: seq?.status === "active" && nextStep ? `Day ${nextStep.step}, ${ddmm(nextStep.dueDate)} 10am` : seq?.status === "awaiting_approval" ? "After approval" : "None",
      stop: seq && ["active", "paused", "awaiting_approval"].includes(seq.status) ? "Pause or Stop under Quote follow-ups" : "",
    });
  }
  for (const m of p.care.members.filter((x) => x.onThisJob)) {
    rows.push({
      what: "Care emails",
      who: `${m.who.name} · ${m.who.email}`,
      status: m.status,
      next: m.status === "active" && m.next ? `${m.next.title}, ${when(m.next.at)}` : m.status === "awaiting_approval" ? "After approval" : "None",
      stop: m.status === "active" || m.status === "awaiting_approval" ? "Take out under Care" : "",
    });
  }
  const r = p.review.row;
  rows.push({
    what: "Review request",
    who: r?.who ? r.who.confirm : "Not picked",
    status: r ? r.status : "not_configured",
    next: r?.nextSendAt && r.status === "scheduled" ? when(r.nextSendAt) : r?.status === "scheduled" ? "When the job is confirmed complete" : "None",
    stop: r && !["stopped", "sent", "skipped"].includes(r.status) ? "Review received, Declined or Stop under Review request" : "",
  });
  return (
    <div className="overflow-x-auto px-4 pb-3" data-testid="comms-glance">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-medium">What</th>
            <th className="py-1 pr-2 font-medium">Who gets it</th>
            <th className="py-1 pr-2 font-medium">Status</th>
            <th className="py-1 pr-2 font-medium">Next send</th>
            <th className="py-1 font-medium">How to stop it</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((x, i) => (
            <tr key={i} className="align-top">
              <td className="py-1.5 pr-2 font-medium">{x.what}</td>
              <td className="break-all py-1.5 pr-2">{x.who}</td>
              <td className="py-1.5 pr-2">
                <StatusBadge s={x.status} />
              </td>
              <td className="py-1.5 pr-2">{x.next}</td>
              <td className="py-1.5 text-muted-foreground">{x.stop || "Nothing to stop"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ people ----------------------------------- */

const CAN_LABEL: Array<[keyof Person["can"], string]> = [
  ["followup", "Quote follow-ups"],
  ["careGuide", "Care guides"],
  ["careSeries", "Care emails"],
  ["reviewEmail", "Review by email"],
  ["reviewSms", "Review by text"],
];

function PeopleSection({ p, onDone, onFail }: { p: Panel; onDone: (t: string) => void; onFail: (e: unknown) => void }) {
  const setRef = useSetBuilderRef();
  const setOk = useSetDirectContactOk();
  const [ref, setRefValue] = React.useState(p.job.builderRef ?? "");
  React.useEffect(() => setRefValue(p.job.builderRef ?? ""), [p.job.builderRef]);

  return (
    <Section title="People on this job" subtitle="Each person, their role, the actual email and mobile, and what they can get. Change people on the People card.">
      {p.homeownerAmbiguity ? <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{p.homeownerAmbiguity}</p> : null}
      {p.billing ? <p className="text-xs text-muted-foreground">Billing: {p.billing.name}. The bill-to company is never sent these.</p> : null}
      <ul className="divide-y divide-border rounded-md border border-border" data-testid="comms-people">
        {p.people.map((x) => (
          <li key={x.contactId} className="grid gap-1 px-3 py-2 text-sm">
            <p className="font-medium">
              {x.name} <span className="font-normal text-muted-foreground">· {x.roleLabel}</span>
              {x.company ? <span className="font-normal text-muted-foreground"> · {x.company}</span> : null}
            </p>
            <p className="break-all text-xs text-muted-foreground">
              Email: {x.email || "none"}
              {x.receivesEmail ? "" : " (doesn't get emails)"} · Mobile: {x.mobile || "none"}
              {x.mobile && !x.mobileOk ? " (not a valid mobile)" : ""}
              {x.receivesSms ? "" : " (doesn't get texts)"}
            </p>
            <div className="flex flex-wrap gap-1">
              {CAN_LABEL.map(([k, label]) => (
                <span
                  key={k}
                  title={x.can[k] ?? "Can get it once approved"}
                  className={cn("rounded px-1.5 py-0.5 text-[11px]", x.can[k] ? "bg-secondary text-muted-foreground line-through" : "bg-[#2f7d4f]/10 text-[#2f7d4f]")}
                >
                  {label}
                </span>
              ))}
            </div>
          </li>
        ))}
        {!p.people.length ? <li className="px-3 py-2 text-xs text-destructive">Nobody on this job. Nothing can be sent until someone is added.</li> : null}
      </ul>
      {p.job.isCompanyJob ? (
        <div className="grid gap-2 rounded-md border border-border px-3 py-2">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1">
              <p className="label-xs">Builder ref / work order no.</p>
              <Input className="mt-0.5 h-8" value={ref} maxLength={80} onChange={(e) => setRefValue(e.target.value)} placeholder={p.job.builderRefHint || "The builder's own number"} />
              <p className="mt-0.5 text-[11px] text-muted-foreground">Kept apart from Terra's job number and the customer PO. Insurance follow-ups show it next to the site address.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={setRef.isPending || ref === (p.job.builderRef ?? "")}
              onClick={() => setRef.mutate({ jobId: p.job.id, ref }, { onSuccess: () => onDone("Builder ref saved."), onError: onFail })}
            >
              Save
            </Button>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={p.job.directContactOk}
              disabled={setOk.isPending}
              onChange={(e) => {
                const ok = e.target.checked;
                if (!ok && !window.confirm("Turn off direct contact? Anything approved for the homeowner goes back to Awaiting approval.")) return;
                setOk.mutate({ jobId: p.job.id, ok }, { onSuccess: () => onDone(ok ? "Recorded: builder has OK'd direct contact." : "Direct contact turned off."), onError: onFail });
              }}
            />
            <span>
              Builder has OK'd direct contact with the homeowner
              <span className="block text-xs text-muted-foreground">
                {p.job.directContactOk ? `Recorded by ${p.job.directContactOkBy || "someone"} on ${when(p.job.directContactOkAt)}.` : "Without this, the homeowner gets nothing from Terra on this job."}
              </span>
            </span>
          </label>
        </div>
      ) : null}
    </Section>
  );
}

/* ------------------------------ care ------------------------------------- */

function CareSection({ p, isAdmin, showCareFacts, onDone, onFail }: { p: Panel; isAdmin: boolean; showCareFacts: boolean; onDone: (t: string) => void; onFail: (e: unknown) => void }) {
  const approve = useCareApproveMember();
  const setStatus = useCareSetMemberStatus();
  const retry = useGuideRetry();
  const members = p.care.members;
  return (
    <Section title="Care guides" subtitle="Care emails over the next few years, and guides sent by hand. Each person is approved before anything goes.">
      {!p.care.on ? <p className="text-xs text-muted-foreground">Care emails are switched off in Settings, so none of the series sends yet.</p> : null}
      {members.length ? (
        <ul className="divide-y divide-border rounded-md border border-border" data-testid="care-members">
          {members.map((m) => (
            <li key={m.id} className="grid gap-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  Care emails to {m.who.name} <span className="font-normal text-muted-foreground">· {m.who.role} · {m.who.email || "no email"}</span>
                </p>
                <StatusBadge s={m.status} />
              </div>
              {!m.onThisJob ? <p className="text-xs text-muted-foreground">On the care emails from a later job.</p> : null}
              {m.reason ? <p className="text-xs text-muted-foreground">{m.reason}</p> : null}
              {m.changed ? <p className="text-xs text-destructive">Changed since approval: {m.changed}</p> : null}
              {m.status === "active" && m.next ? <p className="text-xs">Next: {m.next.title}, {when(m.next.at)}.</p> : null}
              {m.approvedAt ? <p className="text-xs text-muted-foreground">Approved by {m.approvedByName} on {when(m.approvedAt)}.</p> : null}
              {m.sent.length ? <p className="text-xs text-muted-foreground">Sent: {m.sent.map((s) => `${s.title} (${when(s.at)})`).join("; ")}.</p> : <p className="text-xs text-muted-foreground">Nothing sent yet.</p>}
              {m.notSentLate.length ? <p className="text-xs text-muted-foreground">Will not be sent late: {m.notSentLate.map((s) => s.title).join(", ")}.</p> : null}
              {m.failed ? <p className="text-xs text-destructive">{m.failed} failed. See Care emails in Marketing.</p> : null}
              <div className="flex flex-wrap gap-2">
                {m.status === "awaiting_approval" ? (
                  <Button
                    size="sm"
                    disabled={approve.isPending || !!m.approveBlock}
                    title={m.approveBlock ?? undefined}
                    onClick={() =>
                      window.confirm(`Send care emails to ${m.who.name} · ${m.who.role} · ${m.who.email}? Anything already due is not sent late.`) &&
                      approve.mutate({ memberId: m.id }, { onSuccess: () => onDone(`Care emails approved for ${m.who.name}.`), onError: onFail })
                    }
                  >
                    <CheckCircle2 className="size-3.5" /> Approve
                  </Button>
                ) : null}
                {m.status === "active" || m.status === "awaiting_approval" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setStatus.isPending}
                    onClick={() => window.confirm(`Take ${m.who.name} out of the care emails?`) && setStatus.mutate({ memberId: m.id, active: false }, { onSuccess: () => onDone("Taken out."), onError: onFail })}
                  >
                    <Square className="size-3.5" /> Take out
                  </Button>
                ) : null}
              </div>
              {m.approveBlock && m.status === "awaiting_approval" ? <p className="text-xs text-destructive">Can't approve yet: {m.approveBlock}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Not configured. Nobody on this job is on the care emails.</p>
      )}
      {showCareFacts && !p.job.isCallback ? <CareCard jobId={p.job.id} isAdmin={isAdmin} embedded /> : null}

      <div className="grid gap-1.5 rounded-md border border-border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Sent by hand</p>
          <GuideButton jobId={p.job.id} onSent={onDone} />
        </div>
        <p className="text-xs text-muted-foreground">Pick one person and any guides, indoor flooring or exterior timber decking. Never automatic, no follow-up. Works on supply only jobs.</p>
        {p.guides.sent.length ? (
          <ul className="grid gap-1 text-xs" data-testid="guides-sent">
            {p.guides.sent.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2">
                <StatusBadge s={g.status === "sending" ? "scheduled" : g.status} />
                <span>
                  {g.title} to {g.to} · {when(g.at)}
                  {g.byName ? ` · by ${g.byName}` : ""}
                </span>
                {g.status === "failed" ? (
                  <>
                    <span className="text-destructive">{g.error}</span>
                    <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ id: g.id }, { onSuccess: (r) => onDone(r.outcome === "sent" ? `Sent again to ${g.to}.` : `Still failed: ${r.detail}`), onError: onFail })}>
                      <RotateCcw className="size-3.5" /> Retry
                    </Button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">None sent by hand on this job.</p>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------ review ----------------------------------- */

function ReviewSection({ p, onDone, onFail }: { p: Panel; onDone: (t: string) => void; onFail: (e: unknown) => void }) {
  const v = p.review;
  const r = v.row;
  const setup = useReviewSetup();
  return (
    <Section id="review-request" title="Review request" subtitle={v.rule}>
      {!v.settings.on ? <p className="text-xs text-muted-foreground">Review requests are switched off in Settings. Nothing sends until they are on.</p> : null}
      {!v.settings.hasLink ? <p className="text-xs text-destructive">No Google review link saved yet. Nothing can send until it is added in Settings.</p> : null}
      <p className="text-xs text-muted-foreground">
        {v.completedAt ? `Confirmed complete on ${when(v.completedAt)}.` : "Not confirmed complete yet. Nothing goes before the job is complete and approved."}
      </p>
      {p.job.isCallback ? (
        <p className="text-xs text-muted-foreground">This is a callback. The review request belongs to the original job.</p>
      ) : !r ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge s="not_configured" />
          <Button size="sm" variant="outline" disabled={setup.isPending} onClick={() => setup.mutate({ jobId: p.job.id }, { onSuccess: () => onDone("Set up. Pick who gets it and approve."), onError: onFail })}>
            Set up review request
          </Button>
        </div>
      ) : (
        <ReviewRowView p={p} r={r} onDone={onDone} onFail={onFail} />
      )}
    </Section>
  );
}

function ReviewRowView({ p, r, onDone, onFail }: { p: Panel; r: ReviewRow; onDone: (t: string) => void; onFail: (e: unknown) => void }) {
  const v = p.review;
  const approve = useReviewApprove();
  const recipient = useReviewRecipient();
  const what = useReviewWhat();
  const pause = useReviewPause();
  const resume = useReviewResume();
  const retry = useReviewRetry();
  const stop = useReviewStop();
  const received = useReviewReceived();
  const declined = useReviewDeclined();
  const [choosing, setChoosing] = React.useState(false);
  const [pausing, setPausing] = React.useState(false);
  const [whatText, setWhatText] = React.useState(r.what);
  React.useEffect(() => setWhatText(r.what), [r.what]);
  const ended = ["stopped", "sent", "skipped"].includes(r.status);
  const busy = approve.isPending || recipient.isPending || pause.isPending || resume.isPending || retry.isPending || stop.isPending || received.isPending || declined.isPending;

  const people: RecipientPerson[] = p.people.map((x) => ({
    contactId: x.contactId,
    name: x.name,
    roleLabel: x.mainRoleLabel,
    email: x.email,
    mobile: x.mobile ?? "",
    block: { email: x.can.reviewEmail, sms: x.can.reviewSms },
  }));
  const previous = p.history
    .filter((h) => h.kind === "review" && h.event === "sent")
    .map((h) => ({ at: h.at, to: h.to, what: h.detail.split(" accepted")[0] ?? "Request" }));
  const nextText = r.sentCount >= r.maxSends
    ? "No more requests on this job."
    : !v.completedAt
      ? "Waits for the job to be confirmed complete, then the planned day at 10am."
      : `The ${r.nextKind === "reminder" ? "reminder" : "first request"} is planned once you approve. Never on the day you approve: the earliest is the next business day at 10am.`;

  return (
    <div className="grid gap-2 text-sm" data-testid="review-controls">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge s={r.status} />
        <span className="text-xs text-muted-foreground">
          {r.sentCount} of {r.maxSends} sent on this job. {r.channel === "sms" ? "By text." : "By email."}
        </span>
      </div>
      {r.who ? (
        <p className="font-medium" data-testid="review-confirm">
          Send review request to {r.who.confirm}
        </p>
      ) : (
        <p className="text-xs text-destructive">Nobody picked. Press Check and approve to pick who gets it.</p>
      )}
      {r.reason && !(r.status === "scheduled" && r.reason.startsWith("Approved.")) ? <p className="text-xs text-muted-foreground">{r.reason}</p> : null}
      {r.changed ? <p className="text-xs text-destructive">Changed since approval: {r.changed} It needs approving again before anything goes.</p> : null}
      {r.block ? <p className="text-xs text-destructive">Blocked: {r.block}</p> : null}
      {r.status === "scheduled" ? (
        <p className="text-xs">
          Next planned send: {r.nextSendAt ? when(r.nextSendAt) : "when the job is confirmed complete"}
          {r.nextKind === "reminder" ? " (the reminder)" : ""}.
        </p>
      ) : null}
      {r.approvedAt ? <p className="text-xs text-muted-foreground">Approved by {r.approvedByName} on {when(r.approvedAt)}.</p> : null}
      {r.lastSentAt ? <p className="text-xs text-muted-foreground">Last sent {when(r.lastSentAt)} (accepted by the provider).</p> : null}
      {r.status === "paused" ? (
        <p className="text-xs">
          Looked after by {r.pauseName || "the office"}
          {r.reviewDate ? `, review on ${ddmm(r.reviewDate)}` : ""}. Does not resume on its own.
        </p>
      ) : null}
      {r.lastError && r.status === "failed" ? <p className="text-xs text-destructive">Error: {r.lastError}</p> : null}
      {r.receivedAt ? (
        <p className="rounded-md bg-[#2f7d4f]/10 px-3 py-2 text-xs text-[#2f7d4f]">
          Review received. Marked by {r.receivedByName} on {when(r.receivedAt)}. No more reminders.
        </p>
      ) : null}
      {r.declinedAt ? (
        <p className="rounded-md bg-secondary px-3 py-2 text-xs">
          Declined. Marked by {r.declinedByName} on {when(r.declinedAt)}. No more requests.
        </p>
      ) : null}

      {!ended && r.sentCount === 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <p className="label-xs">What was done (goes in the message)</p>
            <Input className="mt-0.5 h-8" value={whatText} maxLength={120} onChange={(e) => setWhatText(e.target.value)} placeholder="hybrid flooring" />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={what.isPending || whatText === r.what}
            onClick={() => what.mutate({ id: r.id, what: whatText }, { onSuccess: () => onDone(r.contactId ? "Saved. Approve it again." : "Saved."), onError: onFail })}
          >
            Save
          </Button>
        </div>
      ) : null}

      {r.draft ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-primary">What the {r.nextKind === "reminder" ? "reminder" : "request"} says</summary>
          <div className="mt-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
            {r.draft.subject ? <p className="mb-1.5 font-medium">{r.draft.subject}</p> : null}
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{r.draft.body}</p>
            {r.draft.smsParts && r.draft.smsParts > 1 ? <p className="mt-1 text-muted-foreground">{r.draft.smsParts} text parts, counted as one request.</p> : null}
          </div>
          {r.draft.problems.map((x) => (
            <p key={x} className="mt-1 text-[#9a6b12]">
              Check: {x}
            </p>
          ))}
        </details>
      ) : null}

      {!ended ? (
        <div className="flex flex-wrap items-center gap-2">
          {r.status === "awaiting_approval" ? (
            <Button size="sm" disabled={busy} onClick={() => setChoosing(true)} data-testid="review-approve">
              <CheckCircle2 className="size-3.5" /> Check and approve
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setChoosing(true)}>
              Change who gets it
            </Button>
          )}
          {r.status === "scheduled" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPausing((x) => !x)}>
              <Pause className="size-3.5" /> Pause
            </Button>
          ) : null}
          {r.status === "paused" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => resume.mutate({ id: r.id }, { onSuccess: () => onDone("Resumed. The next send is planned from the next business day, never at once."), onError: onFail })}>
              <Play className="size-3.5" /> Resume
            </Button>
          ) : null}
          {r.status === "failed" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => retry.mutate({ id: r.id }, { onSuccess: () => onDone("Planned again from the next business day at 10am."), onError: onFail })}>
              <RotateCcw className="size-3.5" /> Retry
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              const why = window.prompt("Stop the review request on this job? Say why (optional).", "");
              if (why === null) return;
              stop.mutate({ id: r.id, reason: why }, { onSuccess: () => onDone("Stopped."), onError: onFail });
            }}
          >
            <Square className="size-3.5" /> Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            data-testid="review-declined"
            onClick={() => {
              const why = window.prompt("They said they don't want to leave a review? Add a note (optional).", "");
              if (why === null) return;
              declined.mutate({ id: r.id, note: why }, { onSuccess: () => onDone("Recorded as declined. No more requests."), onError: onFail });
            }}
          >
            <ThumbsDown className="size-3.5" /> Declined
          </Button>
        </div>
      ) : null}
      {!r.receivedAt && (r.sentCount > 0 || !ended) ? (
        <Button
          className="w-full sm:w-auto"
          disabled={busy}
          data-testid="review-received"
          onClick={() => received.mutate({ id: r.id }, { onSuccess: (x) => onDone(x.already ? `Already marked by ${x.byName}.` : "Recorded. Any remaining reminder is stopped."), onError: onFail })}
        >
          <Star className="size-4" /> Review received — stop reminders
        </Button>
      ) : null}
      {pausing ? (
        <PauseForm
          allowResumeDate={false}
          allowApprovalPending={false}
          busy={pause.isPending}
          onCancel={() => setPausing(false)}
          onSave={(pv) =>
            pause.mutate(
              { id: r.id, note: pv.note, pauseProfileId: pv.pauseProfileId, pauseName: pv.pauseName, reviewDate: pv.reviewDate },
              {
                onSuccess: () => {
                  setPausing(false);
                  onDone("Paused. It stays paused until someone presses Resume.");
                },
                onError: onFail,
              },
            )
          }
        />
      ) : null}
      <RecipientApprovalModal
        open={choosing}
        onClose={() => setChoosing(false)}
        what="the review request"
        people={people}
        allowCc={false}
        channels={v.channels}
        initial={{ toContactId: r.contactId ?? null, ccContactIds: [], channel: r.channel as "email" | "sms" }}
        preview={r.draft ? { subject: r.draft.subject || null, text: r.draft.body } : null}
        previous={previous}
        nextSend={nextText}
        notes={[v.rule, ...(p.homeownerAmbiguity ? [p.homeownerAmbiguity] : [])]}
        busy={busy}
        onApprove={async (x) => {
          if (x.changed || r.status !== "awaiting_approval") await recipient.mutateAsync({ id: r.id, contactId: x.toContactId, channel: x.channel });
          const out = await approve.mutateAsync({ id: r.id });
          onDone(out.nextSendAt ? "Approved. Nothing sends now. The planned time is below." : "Approved. Waits for the job to be confirmed complete.");
        }}
      />
    </div>
  );
}

/* ------------------------------ history ---------------------------------- */

const KIND_LABEL: Record<string, string> = { quote_followup: "Follow-ups", care: "Care emails", care_guide: "Care guide", review: "Review", job: "Job", people: "People" };

function HistorySection({ p }: { p: Panel }) {
  const [all, setAll] = React.useState(false);
  const rows = all ? p.history : p.history.slice(0, 8);
  return (
    <Section title="History" subtitle="Every approval, pause, send and stop on this job. Sent means the provider accepted it.">
      {rows.length ? (
        <ul className="grid gap-1 text-xs" data-testid="comms-history">
          {rows.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-2">
              <span className="tabular text-muted-foreground">{when(h.at)}</span>
              <span className="font-medium">{KIND_LABEL[h.kind] ?? h.kind}</span>
              <span className="min-w-0 break-words">{h.detail}</span>
              {h.by ? <span className="text-muted-foreground">· {h.by}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing yet.</p>
      )}
      {p.history.length > 8 ? (
        <Button size="sm" variant="ghost" onClick={() => setAll((x) => !x)}>
          <Hand className="size-3.5" /> {all ? "Show fewer" : `Show all ${p.history.length}`}
        </Button>
      ) : null}
    </Section>
  );
}
