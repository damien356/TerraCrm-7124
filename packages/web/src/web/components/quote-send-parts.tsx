import * as React from "react";
import { AlertTriangle, CheckCircle2, Clock, Mail, MessageSquare, RotateCcw, XCircle } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input } from "./ui/field";
import { moneyExact } from "../lib/money";
import { useQuoteSends, useRetryQuoteSend } from "../queries/quoteSend";
import { mobileForSms, quoteSmsPartCount, quoteSmsText, showMobile } from "../../api/lib/quote-sms-text";

/* ---------------------------------------------------------------------------
 * The text half of the Send screen, the result of a send, and the quote's
 * send history (30 Oct, after 188048). Email and text are always shown apart.
 * ------------------------------------------------------------------------- */

export type SmsDraft = {
  defaultOn: boolean;
  ready: boolean;
  byEmail: Record<string, SmsPerson>;
  fallback: SmsPerson | null;
  emailWarn: Record<string, string>;
  description: string;
  option: { n: number; of: number; ref: string } | null;
  others: { id: number; ref: string; total: number; status: string; isThis: boolean }[];
};
export type SmsPerson = {
  contactId: number | null;
  name: string;
  firstName: string;
  mobile: string;
  mobileShown: string;
  blocked: string | null;
  warn: string | null;
};
export type SmsState = {
  on: boolean;
  to: string;
  contactId: number | null;
  firstName: string;
  description: string;
  showOption: boolean;
};

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-sm font-medium"
    >
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--primary)]" : "bg-border"}`}>
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </span>
      {label}
    </button>
  );
}

const Warn = ({ children, tone = "amber" }: { children: React.ReactNode; tone?: "amber" | "red" }) => (
  <p
    className={`flex items-start gap-1.5 rounded-md px-3 py-2 text-sm ${tone === "red" ? "bg-destructive/10 text-destructive" : "bg-amber-50 text-amber-900"}`}
  >
    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
    <span>{children}</span>
  </p>
);

/** The "Also send by SMS" part: who, the number, the words, and the text exactly as it will read. */
export function SmsPanel({
  draft,
  value,
  onChange,
  person,
  url,
  emailGoing,
  resend,
}: {
  draft: SmsDraft;
  value: SmsState;
  onChange: (v: SmsState) => void;
  person: SmsPerson | null;
  url: string;
  emailGoing: boolean;
  resend: boolean;
}) {
  const mobile = mobileForSms(value.to);
  const samePerson = !!person && !!mobile && person.mobile === mobile;
  const blocked = samePerson ? person!.blocked : null;
  const text = quoteSmsText({
    firstName: value.firstName,
    description: value.description,
    url,
    emailed: emailGoing,
    option: value.showOption ? draft.option : null,
    resend,
  });
  const parts = quoteSmsPartCount(text);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-secondary/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Switch id="also-sms" checked={value.on} onChange={(on) => onChange({ ...value, on })} label="Also send by SMS" />
        <span className="text-xs text-muted-foreground">{value.on ? "Text goes from Terra's mobile number. Replies come back to Terra Ops." : "No text this time."}</span>
      </div>
      {value.on ? (
        <>
          {!draft.ready ? <Warn tone="red">Texts are not set up on this server, so the text will fail. The email still goes.</Warn> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Mobile">
              <Input value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} placeholder="04xx xxx xxx" inputMode="tel" />
            </Field>
            <Field label="Name in the text">
              <Input value={value.firstName} onChange={(e) => onChange({ ...value, firstName: e.target.value })} placeholder="First name" />
            </Field>
          </div>
          {!value.to.trim() ? (
            <Warn>No mobile on file. Type one, or turn the text off. {emailGoing ? "The email still goes." : ""}</Warn>
          ) : !mobile ? (
            <Warn>"{value.to.trim()}" is not an Australian mobile, so no text will go. {emailGoing ? "The email still goes." : ""}</Warn>
          ) : null}
          {blocked ? <Warn tone="red">{blocked} No text will go. {emailGoing ? "The email still goes." : ""}</Warn> : null}
          {samePerson && person!.warn ? <Warn>{person!.warn} Check before texting.</Warn> : null}
          <Field label="What the quote is for (goes in the text)">
            <Input
              value={value.description}
              onChange={(e) => onChange({ ...value, description: e.target.value })}
              placeholder="hybrid flooring to the living areas"
              maxLength={160}
            />
          </Field>
          {draft.option ? (
            <div className="rounded-md bg-card px-3 py-2 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox checked={value.showOption} onChange={(e) => onChange({ ...value, showOption: e.target.checked })} />
                Say which one this is: {draft.option.ref} (option {draft.option.n} of {draft.option.of})
              </label>
              <ul className="mt-1.5 flex flex-col gap-0.5 pl-6 text-xs text-muted-foreground">
                {draft.others.map((o) => (
                  <li key={o.id} className={o.isThis ? "font-medium text-foreground" : ""}>
                    {o.ref} · {moneyExact(o.total)} · {o.isThis ? "this one" : o.status}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="label-xs mb-1">The text, as it will read</p>
            <p className="whitespace-pre-wrap rounded-lg bg-card px-3 py-2 text-[13px] leading-relaxed shadow-sm">{text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {text.length} characters, {parts} SMS part{parts === 1 ? "" : "s"}.
              {emailGoing ? ' "We\'ve also emailed it to you" is taken out if the email does not go.' : ""}
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

type Summary = {
  id: number;
  createdAt: Date | string;
  byName: string;
  email: { status: string; to: string | null; detail: string | null; at: Date | string | null };
  sms: { status: string; to: string | null; toShown: string; detail: string | null; at: Date | string | null };
};

const when = (v: Date | string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

function ChannelLine({
  channel,
  status,
  to,
  detail,
  onRetry,
  retrying,
}: {
  channel: "email" | "sms";
  status: string;
  to: string;
  detail: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const what = channel === "email" ? "Email" : "Text";
  const Icon = channel === "email" ? Mail : MessageSquare;
  const look =
    status === "sent"
      ? { icon: <CheckCircle2 className="size-4 text-[#3F7D3A]" />, line: `${what} sent to ${to}`, note: channel === "email" ? `${detail ?? "Gmail took it."} We can not see if it reached the inbox.` : `${detail ? `${detail} ` : ""}ClickSend took it. We can not see if it reached the phone.` }
      : status === "failed"
        ? { icon: <XCircle className="size-4 text-destructive" />, line: `${what} to ${to || "nobody"} did not go`, note: detail }
        : status === "blocked"
          ? { icon: <XCircle className="size-4 text-amber-700" />, line: `${what} not sent`, note: detail }
          : status === "sending"
            ? { icon: <Clock className="size-4 text-muted-foreground" />, line: `${what} still sending`, note: "Check Conversations before trying again." }
            : { icon: <Icon className="size-4 text-muted-foreground" />, line: `${what} not sent`, note: detail };
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5">{look.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{look.line}</p>
        {look.note ? <p className="text-xs text-muted-foreground">{look.note}</p> : null}
      </div>
      {status === "failed" && onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          {retrying ? <Spinner /> : <RotateCcw className="size-3.5" />}
          Try {channel === "email" ? "email" : "text"} again
        </Button>
      ) : null}
    </div>
  );
}

/** One send: the email and the text, each with its own result and its own Try again. */
export function SendResult({ quoteId, send, onChange }: { quoteId: number; send: Summary; onChange?: (s: Summary) => void }) {
  const retry = useRetryQuoteSend();
  const [busy, setBusy] = React.useState<"email" | "sms" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  async function go(channel: "email" | "sms") {
    if (busy) return;
    setBusy(channel);
    setError(null);
    try {
      const out = await retry.mutateAsync({ quoteId, sendId: send.id, channel });
      onChange?.(out.send);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <ChannelLine channel="email" status={send.email.status} to={send.email.to ?? ""} detail={send.email.detail} onRetry={() => go("email")} retrying={busy === "email"} />
      <ChannelLine channel="sms" status={send.sms.status} to={send.sms.toShown || send.sms.to || ""} detail={send.sms.detail} onRetry={() => go("sms")} retrying={busy === "sms"} />
      {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

/** On the quote: every send, newest first, so a text that did not go is plain to see. */
export function QuoteSendsCard({ quoteId }: { quoteId: number }) {
  const sends = useQuoteSends(quoteId);
  const rows = sends.data ?? [];
  if (!rows.length) return null;
  const problem = rows.some((r) => r.email.status === "failed" || r.sms.status === "failed");
  return (
    <Card>
      <CardHeader title="Sent by email and text" subtitle={problem ? "Something did not go. Try again only sends the one that failed." : "Each send, the email and the text shown apart."} />
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {when(r.createdAt)} by {r.byName || "the office"}
            </p>
            <SendResult quoteId={quoteId} send={r} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export { showMobile };
