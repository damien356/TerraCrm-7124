import * as React from "react";
import { Mail, Send } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Input } from "./ui/field";
import { useNotifySettings, useSaveNotifySettings, useSendSummaryNow, useSummaryPreview } from "../queries/alerts";

/* ---------------------------------------------------------------------------
 * Settings, Notifications (fix list 11 Oct, item 15).
 *
 * Everything Terra Ops tells the office is an alert on the Dashboard plus a
 * push to the phone. On top of that: one summary email at 7am, an instant
 * email for the kinds ticked as urgent, and the switch for texts to clients.
 * Nothing here texts Damien or the office.
 * ------------------------------------------------------------------------- */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export function NotifySettingsCard() {
  const q = useNotifySettings();
  const save = useSaveNotifySettings();
  const sendNow = useSendSummaryNow();
  const [emailTo, setEmailTo] = React.useState("");
  const [dailyOn, setDailyOn] = React.useState(true);
  const [urgent, setUrgent] = React.useState<string[]>([]);
  const [clientSms, setClientSms] = React.useState(true);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [showPreview, setShowPreview] = React.useState(false);
  const preview = useSummaryPreview(showPreview);

  const s = q.data;
  React.useEffect(() => {
    if (!s) return;
    setEmailTo(s.emailTo);
    setDailyOn(s.dailyOn);
    setUrgent(s.urgent);
    setClientSms(s.clientAutoSms);
  }, [s]);

  if (q.isLoading) return <Loading />;
  if (q.error || !s) return <p className="text-sm text-muted-foreground">Only an Admin can change notifications.</p>;

  const dirty =
    emailTo.trim() !== s.emailTo ||
    dailyOn !== s.dailyOn ||
    clientSms !== s.clientAutoSms ||
    [...urgent].sort().join(",") !== [...s.urgent].sort().join(",");

  const groups = [...new Set(s.kinds.map((k) => k.group))];
  const toggle = (key: string, on: boolean) => setUrgent((u) => (on ? [...new Set([...u, key])] : u.filter((k) => k !== key)));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="How Terra Ops tells you things"
          subtitle="Every alert shows on the Dashboard and pushes to your phone. No texts to you or the office."
          action={<Mail className="size-4 text-[var(--gold-deep)]" />}
        />
        <form
          className="space-y-5 px-4 py-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg(null);
            try {
              await save.mutateAsync({ emailTo: emailTo.trim(), dailyOn, urgent, clientAutoSms: clientSms });
              setMsg({ ok: true, text: "Saved." });
            } catch (err) {
              setMsg({ ok: false, text: errText(err) });
            }
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="notify_email_to" className="block text-sm font-medium">
              Email alerts to
            </label>
            <Input
              id="notify_email_to"
              type="email"
              className="w-full sm:w-80"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Every email comes from {s.from} with a subject starting [Terra Ops]. The email agent ignores these, so they never turn
              into tasks, jobs or invoices.
            </p>
            {!s.emailReady ? <p className="text-xs text-destructive">Email isn't set up on this server, so nothing will send yet.</p> : null}
          </div>

          <div className="border-t border-border pt-4">
            <label htmlFor="notify_daily_on" className="flex cursor-pointer items-start gap-2.5">
              <Checkbox id="notify_daily_on" className="mt-0.5" checked={dailyOn} onChange={(e) => setDailyOn(e.target.checked)} />
              <span>
                <span className="block text-sm font-medium">Daily summary at 7am</span>
                <span className="block text-xs text-muted-foreground">One email a day: today's jobs, open tasks and anything overdue.</span>
              </span>
            </label>
            <p className="mt-1.5 pl-6 text-xs text-muted-foreground" data-testid="summary-last-sent">
              {s.lastScheduled
                ? `Last 7am email left ${new Date(s.lastScheduled.at).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}, by ${
                    s.lastScheduled.via === "wake" ? "the wake call" : "the timer"
                  }, to ${s.lastScheduled.to}.`
                : "No 7am email recorded yet. The send time is kept from 21 Oct on."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 pl-6 text-xs">
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => setShowPreview((v) => !v)}>
                {showPreview ? "Hide preview" : "Preview today's"}
              </button>
              <button
                type="button"
                disabled={sendNow.isPending}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
                onClick={async () => {
                  setMsg(null);
                  try {
                    const r = await sendNow.mutateAsync(undefined);
                    setMsg(r.ok ? { ok: true, text: `Summary sent to ${r.to}.` } : { ok: false, text: `Not sent: ${r.reason}` });
                  } catch (err) {
                    setMsg({ ok: false, text: errText(err) });
                  }
                }}
              >
                {sendNow.isPending ? <Spinner className="size-3" /> : <Send className="size-3" />} Send it to me now
              </button>
            </div>
            {showPreview ? (
              <div className="mt-2 ml-6 rounded-md border border-border bg-secondary/40 p-3 text-xs" data-testid="summary-preview">
                {preview.isLoading ? (
                  <Spinner className="size-3.5" />
                ) : (
                  (preview.data?.lines ?? []).map((l, i) => (
                    <p key={i} className="mb-2 whitespace-pre-line last:mb-0">
                      {l}
                    </p>
                  ))
                )}
              </div>
            ) : null}
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-sm font-medium">Email me straight away for</p>
            <p className="mb-3 text-xs text-muted-foreground">Ticked ones also email you the moment they happen. The rest wait for the Dashboard, your phone and the 7am summary.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {groups.map((g) => (
                <div key={g} className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
                  {s.kinds
                    .filter((k) => k.group === g)
                    .map((k) => (
                      <label key={k.key} htmlFor={`urgent_${k.key}`} className="flex cursor-pointer items-start gap-2 text-sm">
                        <Checkbox
                          id={`urgent_${k.key}`}
                          className="mt-0.5"
                          checked={urgent.includes(k.key)}
                          onChange={(e) => toggle(k.key, e.target.checked)}
                        />
                        <span>{k.label}</span>
                      </label>
                    ))}
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <label htmlFor="client_auto_sms" className="flex cursor-pointer items-start gap-2.5">
              <Checkbox id="client_auto_sms" className="mt-0.5" checked={clientSms} onChange={(e) => setClientSms(e.target.checked)} />
              <span>
                <span className="block text-sm font-medium">Automatic texts to clients</span>
                <span className="block text-xs text-muted-foreground">
                  Texts the marketing journeys send by themselves, like a booking confirmation or a follow up. Off stops them. Texts you
                  send from a conversation, a variation, the crew's running late text and staff login texts still go.
                </span>
              </span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button type="submit" size="sm" disabled={!dirty || save.isPending}>
              {save.isPending ? <Spinner className="size-3.5" /> : null}
              Save
            </Button>
            {msg ? <p className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{msg.text}</p> : null}
          </div>
        </form>
      </Card>
    </div>
  );
}
