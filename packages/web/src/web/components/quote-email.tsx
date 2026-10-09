import * as React from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, Eye, Mail, PenLine } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { moneyExact } from "../lib/money";
import { useQuoteEmailDraft, useQuoteLink, useSendQuoteEmail } from "../queries/quoteSend";

/**
 * Email quote (spec 2.1): from team@ as "Damien from Terra", PDF attached,
 * with the no-login link. The office can change who it goes to, the subject
 * and the words. Marked sent only once it has actually gone.
 */
export function EmailQuoteButton({
  quoteId,
  again = false,
  disabled,
  onSent,
}: {
  quoteId: number;
  again?: boolean;
  disabled?: boolean;
  onSent?: (msg: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant={again ? "outline" : "default"} onClick={() => setOpen(true)} disabled={disabled}>
        <Mail className="size-4" />
        {again ? "Email again" : "Email quote"}
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

  const d = draft.data;
  const toValue = to ?? d?.to ?? "";
  const picked = d?.recipients.find((r) => r.email === toValue);

  async function onSend() {
    if (!d) return;
    setError(null);
    try {
      const out = await send.mutateAsync({ quoteId, to: toValue.trim(), subject: subject ?? d.subject, body: body ?? d.body });
      onSent?.(`Quote ${d.ref} emailed to ${out.to}${out.via === "relay" ? " (sent through the backup mailer, team@ is not connected)" : ""}.`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={d ? `Email quote ${d.ref}` : "Email quote"}
      subtitle='From team@ as "Damien from Terra". Replies come back to team@. The PDF is attached.'
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSend} disabled={!d || send.isPending || !toValue.trim()}>
            {send.isPending ? <Spinner /> : <Mail className="size-4" />}
            Send
          </Button>
        </>
      }
    >
      {draft.isLoading ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : draft.error ? (
        <p className="text-sm text-destructive">{draft.error.message}</p>
      ) : d ? (
        <div className="flex flex-col gap-3">
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
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">Nobody on this quote has an email address. Type one below.</p>
          )}
          {!picked ? (
            <Field label="Email address">
              <Input type="email" value={toValue} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" />
            </Field>
          ) : null}
          <Field label="Subject">
            <Input value={subject ?? d.subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message">
            <Textarea rows={14} value={body ?? d.body} onChange={(e) => setBody(e.target.value)} className="font-[inherit] text-[13px] leading-relaxed" />
          </Field>
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
              <span className="text-muted-foreground">{status === "sent" ? "Not opened yet." : "Not sent yet."}</span>
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
