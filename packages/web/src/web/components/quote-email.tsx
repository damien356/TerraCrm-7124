import * as React from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, Eye, Mail, PenLine } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { moneyExact } from "../lib/money";
import { useQuoteEmailDraft, useQuoteLink, useSendQuoteEmail } from "../queries/quoteSend";
import { needsScope, SCOPE_FILL } from "../../api/lib/quote-email-template";
import { EmailInput } from "./email-input";
import { CcList, EmailAttachments, NO_ATTACHMENTS, type MailAttachments } from "./email-attachments";
import { SendResult, SmsPanel, type SmsPerson, type SmsState } from "./quote-send-parts";
import { mobileForSms, scopeFromBody, showMobile } from "../../api/lib/quote-sms-text";

/** Same check as EMAIL_RE on the server. */
const EMAIL_OK = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const newSendKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;

/**
 * Email quote (spec 2.1): from team@ as "Damien from Terra", PDF attached,
 * with the no-login link. The office can change who it goes to, the subject
 * and the words. Marked sent only once it has actually gone.
 */
export function EmailQuoteButton({
  quoteId,
  again = false,
  resend = false,
  disabled,
  onSent,
  gate,
}: {
  quoteId: number;
  again?: boolean;
  /** Accepted quote with its wording fixed (188001 list item 7). */
  resend?: boolean;
  disabled?: boolean;
  onSent?: (msg: string) => void;
  /**
   * Runs before the email form opens. Return true to hold it, and call
   * openForm once ready (188001 list item 12: add the site first).
   */
  gate?: (openForm: () => void) => boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        variant={again || resend ? "outline" : "default"}
        onClick={() => {
          if (gate?.(() => setOpen(true))) return;
          setOpen(true);
        }}
        disabled={disabled}
        title={resend ? "Emails the client the updated copy. Logged as wording edited, re-sent." : undefined}
      >
        <Mail className="size-4" />
        {resend ? "Save and re-send" : again ? "Send again" : "Send quote"}
      </Button>
      {/* Portalled out of the dark page header, or its colour rules turn the form white on white. */}
      {open ? createPortal(<EmailQuoteDialog quoteId={quoteId} onClose={() => setOpen(false)} onSent={onSent} />, document.body) : null}
    </>
  );
}

function EmailQuoteDialog({ quoteId, onClose, onSent }: { quoteId: number; onClose: () => void; onSent?: (msg: string) => void }) {
  const draft = useQuoteEmailDraft(quoteId, true);
  const send = useSendQuoteEmail();
  const [to, setTo] = React.useState<string | null>(null);
  const [subject, setSubject] = React.useState<string | null>(null);
  const [body, setBody] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [cc, setCc] = React.useState<string[]>([]);
  const [files, setFiles] = React.useState<MailAttachments>(NO_ATTACHMENTS);
  /* One key per opening of this screen. A double click or a retried request sends once. */
  const sendKey = React.useRef(newSendKey());
  const [result, setResult] = React.useState<React.ComponentProps<typeof SendResult>["send"] | null>(null);
  /* The text half. Null until the draft is in. Typed fields stop following the email recipient. */
  const [sms, setSms] = React.useState<SmsState | null>(null);
  const [smsTouched, setSmsTouched] = React.useState<{ to: boolean; name: boolean; description: boolean }>({ to: false, name: false, description: false });

  const d = draft.data;
  const toValue = to ?? d?.to ?? "";
  const picked = d?.recipients.find((r) => r.email === toValue);
  const subjectValue = subject ?? d?.subject ?? "";
  const bodyValue = body ?? d?.body ?? "";
  const emailOk = EMAIL_OK.test(toValue.trim());
  const unfilled = !!d && emailOk && needsScope(subjectValue, bodyValue);
  const person: SmsPerson | null = d ? (d.sms.byEmail[toValue.trim().toLowerCase()] ?? d.sms.fallback) : null;
  const emailWarn = d?.sms.emailWarn[toValue.trim().toLowerCase()] ?? null;

  // The text follows whoever the email goes to, until the office types over it.
  React.useEffect(() => {
    if (!d) return;
    setSms((cur) => {
      const base: SmsState = cur ?? {
        on: d.sms.defaultOn && !person?.warn && !person?.blocked,
        to: "",
        contactId: null,
        firstName: "",
        description: d.sms.description,
        showOption: !!d.sms.option,
      };
      return {
        ...base,
        to: smsTouched.to && cur ? base.to : (person?.mobileShown ?? ""),
        contactId: smsTouched.to && cur ? base.contactId : (person?.contactId ?? null),
        firstName: smsTouched.name && cur ? base.firstName : (person?.firstName || picked?.name.split(" ")[0] || ""),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, person?.contactId, person?.mobileShown]);

  // What the quote is for: the words typed in the email's fill-in spot, unless typed for the text.
  React.useEffect(() => {
    if (!d || smsTouched.description) return;
    const scope = scopeFromBody(d.body, bodyValue, SCOPE_FILL);
    setSms((cur) => (cur ? { ...cur, description: scope || d.sms.description } : cur));
  }, [d, bodyValue, smsTouched.description]);

  // Opens with the fill-in spot selected, so typing replaces it.
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const selected = React.useRef(false);
  React.useEffect(() => {
    const el = bodyRef.current;
    if (!d || !el || selected.current) return;
    const at = el.value.indexOf(SCOPE_FILL);
    if (at < 0) return;
    selected.current = true;
    el.focus();
    el.setSelectionRange(at, at + SCOPE_FILL.length);
  }, [d]);

  const smsOn = !!sms?.on;
  const smsMobile = smsOn ? mobileForSms(sms!.to) : null;
  const smsBlocked = !!smsMobile && !!person && person.mobile === smsMobile && !!person.blocked;
  const smsGoing = smsOn && !!smsMobile && !smsBlocked && !!sms!.description.trim();
  const nothing = !emailOk && !smsGoing;
  const label = emailOk && smsGoing ? "Send email and text" : emailOk ? "Send email" : smsGoing ? "Send text only" : "Send";

  function onSmsChange(v: SmsState) {
    if (!sms) return;
    setSmsTouched((t) => ({ to: t.to || v.to !== sms.to, name: t.name || v.firstName !== sms.firstName, description: t.description || v.description !== sms.description }));
    setSms(v.to !== sms.to ? { ...v, contactId: person && mobileForSms(v.to) === person.mobile ? person.contactId : null } : v);
  }

  async function onSend() {
    if (!d || send.isPending || result) return;
    setError(null);
    try {
      const out = await send.mutateAsync({
        quoteId,
        sendKey: sendKey.current,
        to: emailOk ? toValue.trim() : "",
        subject: subjectValue,
        body: bodyValue,
        cc: emailOk ? cc.map((c) => c.trim()).filter(Boolean) : [],
        mediaIds: files.mediaIds,
        uploads: files.uploads,
        sms: smsOn && sms ? { to: sms.to, contactId: sms.contactId, firstName: sms.firstName, description: sms.description, showOption: sms.showOption } : null,
      });
      const r = out.send;
      if (!r) return;
      const emailFine = r.email.status === "sent" || (!emailOk && r.email.status === "skipped");
      const smsFine = r.sms.status === "sent" || (!smsOn && r.sms.status === "skipped");
      if (emailFine && smsFine) {
        const parts = [r.email.status === "sent" ? `emailed to ${r.email.to}` : "", r.sms.status === "sent" ? `texted to ${r.sms.toShown}` : ""].filter(Boolean).join(" and ");
        const what = d.resend ? `Wording edited, re-sent. Quote ${d.ref} ${parts}` : `Quote ${d.ref} ${parts}`;
        onSent?.(`${what}.${r.email.detail && r.email.status === "sent" ? ` ${r.email.detail}` : ""}${out.duplicate ? " (Pressed twice, sent once.)" : ""}`);
        onClose();
        return;
      }
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={d ? `${d.resend ? "Re-send quote" : "Send quote"} ${d.ref}` : "Send quote"}
      subtitle={
        d?.resend
          ? 'The updated copy goes from team@ as "Damien from Terra", PDF attached. The quote stays accepted and the price does not change.'
          : 'Email from team@ as "Damien from Terra", PDF attached. Replies come back to team@. A text with the link goes too, unless you turn it off.'
      }
      width="max-w-2xl"
      footer={
        result ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onSend} disabled={!d || send.isPending || nothing || unfilled}>
              {send.isPending ? <Spinner /> : <Mail className="size-4" />}
              {send.isPending ? "Sending…" : label}
            </Button>
          </>
        )
      }
    >
      {draft.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : draft.error ? (
        <p className="text-sm text-destructive">{draft.error.message}</p>
      ) : result ? (
        <div className="flex flex-col gap-3">
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {result.email.status === "sent" || result.sms.status === "sent"
              ? "Part of this went and part did not. The office has been told. Try again only sends the one that failed."
              : "Nothing went. The office has been told. Fix the detail and try again, or close and send again."}
          </p>
          <SendResult quoteId={quoteId} send={result} onChange={setResult} />
        </div>
      ) : d ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-border px-3 py-2 text-sm">
            <p className="label-xs mb-1">Going to</p>
            <p className="flex flex-wrap gap-x-4 gap-y-1">
              <span className={emailOk ? "" : "text-destructive"}>Email: {emailOk ? toValue.trim() : toValue.trim() ? `${toValue.trim()} (not valid)` : "none"}</span>
              <span className={smsGoing ? "" : "text-muted-foreground"}>
                Text: {!smsOn ? "off" : smsGoing ? showMobile(smsMobile) : smsBlocked ? "blocked, opted out" : !smsMobile ? "no valid mobile" : "add what it is for"}
              </span>
            </p>
          </div>
          {d.recipients.length ? (
            <Field label="Send to">
              <Select value={picked ? picked.email : "__other"} onChange={(e) => setTo(e.target.value === "__other" ? "" : e.target.value)}>
                {d.recipients.map((r) => (
                  <option key={r.email} value={r.email}>
                    {r.name ? `${r.name} <${r.email}>` : r.email} · {r.why}
                  </option>
                ))}
                <option value="__other">Someone else…</option>
              </Select>
            </Field>
          ) : (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">Nobody on this quote has an email address. Type one below, or send the text only.</p>
          )}
          <Field label="Email address">
            <EmailInput value={toValue} onValueChange={setTo} placeholder="name@example.com" />
          </Field>
          {toValue.trim() && !emailOk ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              "{toValue.trim()}" is not a valid email address, so no email will go.{smsGoing ? " The text still goes." : ""}
            </p>
          ) : null}
          {emailWarn ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{emailWarn}</p> : null}
          {sms ? (
            <SmsPanel draft={d.sms} value={sms} onChange={onSmsChange} person={person} url={d.url} emailGoing={emailOk} resend={d.resend} />
          ) : null}
          <Field label="CC">
            <CcList value={cc} onChange={setCc} suggestions={d.recipients.filter((r) => r.email !== toValue)} />
          </Field>
          <Field label="Subject">
            <Input value={subjectValue} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea
              ref={bodyRef}
              rows={14}
              value={bodyValue}
              onChange={(e) => setBody(e.target.value)}
              className="font-[inherit] text-[13px] leading-relaxed"
            />
          </Field>
          {unfilled ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Type what the quote is for in place of {SCOPE_FILL}, for example "carpet to 3 bedrooms and lounge". Send stays off until it is filled in.
            </p>
          ) : null}
          <EmailAttachments jobId={d.jobId} value={files} onChange={setFiles} note="The quote PDF is attached already. Add anything else here." />
          <p className="text-xs text-muted-foreground">
            The quote link is added at the bottom if you take it out: {d.url}
          </p>
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}

const when = (v: Date | string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

/** The client link: copy it, open it, how often the client has opened it, and the signature once signed. */
export function QuoteLinkCard({ quoteId, status }: { quoteId: number; status: string }) {
  const link = useQuoteLink(quoteId);
  const [copied, setCopied] = React.useState(false);
  const l = link.data;
  if (!l || (!l.url && !l.signature && !l.depositInvoice)) return null;
  return (
    <Card>
      <CardHeader title="Client link" subtitle="Opens without a login. Your own visits are not counted." />
      <div className="flex flex-col gap-2.5 px-4 py-3 text-sm">
        {l.url ? (
          <div className="flex items-center gap-1.5">
            <Input readOnly value={l.url} className="h-8 text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copy link"
              onClick={async () => {
                await navigator.clipboard.writeText(l.url!);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              <Copy className="size-3.5" />
            </Button>
            <a href={l.url} target="_blank" rel="noreferrer">
              <Button variant="outline" size="icon-sm" aria-label="Open link">
                <ExternalLink className="size-3.5" />
              </Button>
            </a>
          </div>
        ) : null}
        {copied ? <p className="text-xs text-[#3F7D3A]">Copied.</p> : null}
        {l.url ? (
          <p className="flex items-center gap-1.5">
            <Eye className="size-3.5 text-muted-foreground" />
            {l.views === 0 ? (
              <span className="text-muted-foreground">{status === "draft" || status === "needs_review" ? "Not sent yet." : "Not opened yet."}</span>
            ) : (
              <span>
                Opened {l.views} {l.views === 1 ? "time" : "times"}
                <span className="text-muted-foreground">, last {when(l.lastViewedAt)}</span>
              </span>
            )}
          </p>
        ) : null}
        {l.signature ? (
          <div className="rounded-md bg-[#3F7D3A]/8 px-3 py-2">
            <p className="flex items-center gap-1.5 font-medium text-[#2E6B4F]">
              <PenLine className="size-3.5" />
              Signed online by {l.signature.name}
              {l.signature.position ? `, ${l.signature.position}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {when(l.signature.signedAt)} · Supply Terms {l.signature.termsVersion}
              {l.signature.email ? ` · copy to ${l.signature.email}` : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {l.signature.hasPdf ? "The signed PDF is on the conversation." : "The signed PDF did not save. Check the conversation."}
            </p>
          </div>
        ) : null}
        {l.depositInvoice ? (
          <p className="text-[13px]">
            Deposit {l.depositInvoice.ref}: {moneyExact(l.depositInvoice.total)}
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {l.depositInvoice.status === "paid"
                ? "paid"
                : l.depositInvoice.status === "void"
                  ? "void"
                  : l.depositInvoice.amountPaid > 0
                    ? `${moneyExact(l.depositInvoice.amountPaid)} received`
                    : "waiting"}
            </span>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
