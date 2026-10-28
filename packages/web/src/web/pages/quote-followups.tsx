import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Checkbox, Select } from "../components/ui/field";
import { errorText } from "../components/public-shell";
import { useBootstrap } from "../queries/settings";
import { useFollowupBacklog, useFollowupMetrics, useFollowupSettings, useSaveFollowupSettings } from "../queries/quote-followups";
import { money } from "../lib/money";
import { cn } from "@/lib/utils";

/**
 * QUOTE FOLLOW-UPS BACKLOG (28 Oct).
 *
 * Read only. Every quote out with a customer: how old, what has happened
 * since, whether follow-ups could start and from which step, with the draft.
 * Starting them is one quote at a time from the quote or the job, never from
 * here in bulk, and never with missed steps sent together.
 */

const ADVICE_COLOUR: Record<string, string> = {
  start: "#2f7d4f",
  enrolled: "#4b5563",
  replied: "#9a6b12",
  expires_soon: "#9a6b12",
  expired: "#b23b2c",
  too_old: "#b23b2c",
  no_contact: "#b23b2c",
  no_consent: "#b23b2c",
  has_job_stage: "#9a6b12",
};
const ADVICE_LABEL: Record<string, string> = {
  start: "Could start",
  enrolled: "Has follow-ups",
  replied: "Customer replied",
  expires_soon: "Expires soon",
  expired: "Expired",
  too_old: "Past day 25",
  no_contact: "No contact",
  no_consent: "No consent",
  has_job_stage: "Job moved on",
};

const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const ddmm = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const when = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Australia/Brisbane" }) : "");

function SettingsCard() {
  const s = useFollowupSettings();
  const save = useSaveFollowupSettings();
  const [note, setNote] = React.useState<{ ok: boolean; text: string } | null>(null);
  if (!s.data) return null;
  const v = s.data;
  const put = (patch: Partial<typeof v>) =>
    save.mutate({ ...v, ...patch }, { onSuccess: () => setNote({ ok: true, text: "Saved." }), onError: (e) => setNote({ ok: false, text: errorText(e) }) });
  return (
    <Card>
      <CardHeader title="Settings" subtitle="Admin only. Everything is off until switched on here." />
      <div className="grid gap-3 px-4 py-3 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox checked={v.on} disabled={save.isPending} onChange={(e) => window.confirm(e.target.checked ? "Switch quote follow-ups on? Started sequences will send on their days." : "Switch quote follow-ups off? Nothing sends until switched back on.") && put({ on: e.target.checked })} />
          Send quote follow-ups
        </label>
        <label className="flex items-center gap-2">
          <Checkbox checked={v.autoEnrol} disabled={save.isPending} onChange={(e) => put({ autoEnrol: e.target.checked })} />
          Start them when a quote is emailed (otherwise by hand on each quote)
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="label-xs">Who can get them</p>
            <Select className="mt-0.5 h-8" value={v.consent} disabled={save.isPending} onChange={(e) => put({ consent: e.target.value as typeof v.consent })}>
              <option value="marketing">Marketing consent only</option>
              <option value="quote_request">Anyone who asked for the quote</option>
            </Select>
          </div>
          <div>
            <p className="label-xs">Show day holiday</p>
            <Select className="mt-0.5 h-8" value={v.showDays} disabled={save.isPending} onChange={(e) => put({ showDays: e.target.value as typeof v.showDays })}>
              <option value="gold_coast">Gold Coast show day</option>
              <option value="brisbane">Brisbane Ekka</option>
              <option value="both">Both</option>
              <option value="none">Neither</option>
            </Select>
          </div>
          <div>
            <p className="label-xs">Send time (customer's time)</p>
            <Select className="mt-0.5 h-8" value={String(v.sendHour)} disabled={save.isPending} onChange={(e) => put({ sendHour: Number(e.target.value) })}>
              {[8, 9, 10, 11, 12, 13, 14, 15, 16].map((h) => (
                <option key={h} value={h}>
                  {h > 12 ? `${h - 12}pm` : h === 12 ? "12pm" : `${h}am`}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {note ? <p className={cn("text-xs", note.ok ? "text-muted-foreground" : "text-destructive")}>{note.text}</p> : null}
      </div>
    </Card>
  );
}

function Metrics() {
  const m = useFollowupMetrics();
  if (!m.data) return null;
  const d = m.data;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Stat label="Quotes with follow-ups" value={d.sequences.total} hint={`${d.sequences.withASend} have had one sent`} />
      <Stat label="Replied after one" value={d.followedUp.replied} />
      <Stat label="Accepted after one" value={d.followedUp.accepted} hint={d.followedUp.medianDaysToAccept != null ? `median ${days(d.followedUp.medianDaysToAccept)} to accept` : "no acceptances yet"} />
      <Stat label="Unsubscribed" value={d.followedUp.unsubscribed} tone={d.followedUp.unsubscribed ? "warning" : "default"} />
      <Stat label="Failed to send" value={d.failures} tone={d.failures ? "danger" : "default"} hint={`${d.steps.attempts} send attempts in all`} />
      <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">
        Without follow-ups (sent in the last 180 days): {d.withoutFollowups.quotes} quotes, {d.withoutFollowups.accepted} accepted later
        {d.withoutFollowups.acceptedWithinTheHour ? ` (plus ${d.withoutFollowups.acceptedWithinTheHour} signed within the hour they were sent)` : ""}
        {d.withoutFollowups.medianDaysToAccept != null ? `, median ${days(d.withoutFollowups.medianDaysToAccept)} to accept` : ""}. {d.notTracked.join(" ")}
      </p>
    </div>
  );
}

export default function QuoteFollowupsPage() {
  const q = useFollowupBacklog();
  const isAdmin = useBootstrap().data?.actor?.role === "admin";
  const [filter, setFilter] = React.useState("all");
  const rows = (q.data?.rows ?? []).filter((r) => filter === "all" || r.advice === filter);

  return (
    <Page
      title="Quote follow-ups"
      subtitle="Every quote out with a customer. Read only: start follow-ups one quote at a time from the quote or the job. Missed steps are never sent together."
    >
      <div className="grid gap-4">
        {isAdmin ? <SettingsCard /> : null}
        <Metrics />
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <p className="text-sm text-destructive">{q.error.message}</p>
        ) : (
          <Card>
            <CardHeader
              title="Backlog"
              subtitle={`${q.data!.rows.length} quotes out with a customer`}
              action={
                <Select aria-label="Show" className="h-8 w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="all">All</option>
                  {Object.entries(q.data!.counts).map(([k, n]) => (
                    <option key={k} value={k} disabled={!n}>
                      {ADVICE_LABEL[k] ?? k} ({n})
                    </option>
                  ))}
                </Select>
              }
            />
            {rows.length === 0 ? (
              <Empty>Nothing here.</Empty>
            ) : (
              <div className="divide-y divide-border">
                {rows.map((r) => (
                  <div key={r.number} className="grid gap-1.5 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link to={`/quotes/${r.quoteId}`} className="font-medium text-primary hover:underline">
                          Quote {r.ref}
                        </Link>
                        <span>{r.customer ?? "No customer"}</span>
                        {r.audience === "trade" ? <Badge>Builder</Badge> : null}
                        <span className="tabular text-muted-foreground">{money(r.total)}</span>
                      </div>
                      <Badge colour={ADVICE_COLOUR[r.advice]}>{ADVICE_LABEL[r.advice] ?? r.advice}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Sent {ddmm(r.sentDate)} ({days(r.ageDays)} ago).{" "}
                      {r.validUntil ? `Valid until ${ddmm(r.validUntil)}${r.daysLeft != null ? ` (${r.daysLeft < 0 ? `${days(-r.daysLeft)} ago` : `${days(r.daysLeft)} left`})` : ""}. ` : "No valid-until date. "}
                      {r.versions.length > 1 ? `Versions: ${r.versions.map((v) => `${v.version} ${v.status}`).join(", ")}. ` : ""}
                      Opened {r.views} {r.views === 1 ? "time" : "times"}
                      {r.lastViewedAt ? `, last ${when(r.lastViewedAt)}` : ""}.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Last from the customer: {r.lastIn ? `${when(r.lastIn.at)} (${r.lastIn.channel})` : "nothing since it went"}. Last from Terra:{" "}
                      {r.lastOut ? `${when(r.lastOut.at)} (${r.lastOut.label || r.lastOut.channel}${r.lastOut.author ? `, ${r.lastOut.author}` : ""}${r.lastOut.status === "failed" ? ", failed" : ""})` : "nothing"}.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      To {r.to ?? "nobody"}. Consent: marketing {r.consent.marketing}, quote request {r.consent.quoteRequest}.
                      {r.followups ? ` Follow-ups ${r.followups.status}, ${r.followups.sent} sent${r.followups.failed ? `, ${r.followups.failed} failed` : ""}.` : ""}
                    </p>
                    {r.errors.length ? (
                      <ul className="text-xs text-destructive">
                        {r.errors.map((e, i) => (
                          <li key={i}>
                            Failed {when(e.at)} {e.label ? `(${e.label})` : ""}: {e.detail}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="text-xs">{r.adviceText}</p>
                    {r.draft ? (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-primary">
                          Draft for day {r.draft.step} ({r.draft.words} words)
                        </summary>
                        <div className="mt-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
                          <p className="mb-1.5 font-medium">{r.draft.subject}</p>
                          <p className="whitespace-pre-wrap text-muted-foreground">{r.draft.text}</p>
                        </div>
                        {r.draft.review.length ? <p className="mt-1 text-[#9a6b12]">Check before it goes: {r.draft.review.join(" ")}</p> : null}
                        {r.draft.notes.length ? <p className="mt-1 text-muted-foreground">{r.draft.notes.join(" ")}</p> : null}
                        {r.draft.skip ? <p className="mt-1 text-muted-foreground">Would be skipped: {r.draft.skip}</p> : null}
                      </details>
                    ) : null}
                    {r.jobId ? (
                      <Link to={`/jobs/${r.jobId}`} className="text-xs text-primary hover:underline">
                        Open the job
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        {q.data?.tidy.length ? (
          <Card>
            <CardHeader title="Old versions still marked sent" subtitle="These never get follow-ups. Worth tidying so the quote list is right." />
            <ul className="divide-y divide-border text-sm">
              {q.data.tidy.map((t) => (
                <li key={t.quoteId} className="px-4 py-2">
                  <Link to={`/quotes/${t.quoteId}`} className="text-primary hover:underline">
                    {t.ref}
                  </Link>{" "}
                  <span className="text-xs text-muted-foreground">{t.note}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {q.data ? <p className="text-xs text-muted-foreground">{q.data.notes.join(" ")}</p> : null}
      </div>
    </Page>
  );
}
