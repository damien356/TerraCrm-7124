import * as React from "react";
import { Ban, CheckCircle2, Copy, ExternalLink, FilePlus2, Mail, Send } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { moneyExact } from "../lib/money";
import { useBootstrap } from "../queries/settings";
import { EmailInput } from "./email-input";
import { CcList, EmailAttachments, NO_ATTACHMENTS, type MailAttachments } from "./email-attachments";
import {
  useClientInvoices,
  useEmailInvoice,
  useJobBilling,
  useMarkInvoicePaid,
  useRaiseInvoice,
  useMaterialSelection,
  useSendSelection,
  useVoidInvoice,
} from "../queries/clientInvoices";

/**
 * THE MONEY-IN SIDE OF A JOB (spec section 2).
 *
 * Every client invoice on the job, numbered off the job (IQ...). A card
 * payment through the invoice's Pay by card link marks itself paid (Stripe).
 * Bank transfers and cash are marked here by hand: Admin and Office can mark
 * paid, only Admin can void, and nothing with money on it can be voided.
 */

function EmailInvoiceModal({ invoice, jobId, onClose }: { invoice: Invoice | null; jobId: number; onClose: () => void }) {
  const send = useEmailInvoice();
  const [to, setTo] = React.useState("");
  const [cc, setCc] = React.useState<string[]>([]);
  const [files, setFiles] = React.useState<MailAttachments>(NO_ATTACHMENTS);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setTo("");
    setCc([]);
    setFiles(NO_ATTACHMENTS);
    setError(null);
    send.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id]);
  if (!invoice) return null;
  return (
    <Modal open={!!invoice} onClose={onClose} title={`Email ${invoice.ref} to the client`}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Sends {moneyExact(invoice.outstanding)} owing with the invoice PDF, the Pay by card link and our bank details, from team@. Logged on the job's thread.
        </p>
        <Field label="Send to (leave empty for the client's email on file)">
          <EmailInput value={to} onValueChange={setTo} placeholder="client@example.com" />
        </Field>
        <Field label="CC">
          <CcList value={cc} onChange={setCc} />
        </Field>
        <EmailAttachments jobId={jobId} value={files} onChange={setFiles} note="The invoice PDF is attached already. Add anything else here." />
        {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        {send.data ? (
          <p className="text-sm text-[var(--success)]">
            Sent to {send.data.to}.
            {send.data.linked?.length ? ` ${send.data.linked.length} file${send.data.linked.length === 1 ? "" : "s"} went as download links, too big to attach.` : ""}
          </p>
        ) : null}
        {send.data?.summaryWithheld ? (
          <p className="rounded-md bg-warning/10 px-3 py-2 text-sm">
            The billing summary was left off the PDF because the figures did not agree: {send.data.summaryWithheld} The invoice and its amount due are right. An office task is on the job to check it.
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {send.data ? "Close" : "Cancel"}
          </Button>
          {!send.data ? (
            <Button
              disabled={send.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await send.mutateAsync({
                    id: invoice.id,
                    to: to.trim() || null,
                    cc: cc.map((c) => c.trim()).filter(Boolean),
                    mediaIds: files.mediaIds,
                    uploads: files.uploads,
                  });
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {send.isPending ? <Spinner /> : <Send className="size-3.5" />}
              Send
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

const STATUS_META: Record<string, { label: string; colour: string }> = {
  draft: { label: "Draft", colour: "#7A736D" },
  sent: { label: "Owing", colour: "#D08A1E" },
  part_paid: { label: "Part paid", colour: "#4A7FA5" },
  paid: { label: "Paid", colour: "#3F7D3A" },
  void: { label: "Void", colour: "#9B3B32" },
};

const METHODS = [
  { key: "bank", label: "Bank transfer" },
  { key: "card", label: "Card" },
  { key: "cash", label: "Cash" },
  { key: "other", label: "Other" },
] as const;

const METHOD_LABEL: Record<string, string> = Object.fromEntries(METHODS.map((m) => [m.key, m.label]));

type Invoice = NonNullable<ReturnType<typeof useClientInvoices>["data"]>["invoices"][number];

const todayIso = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const dateOf = (v: Date | string | null | undefined) => {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

function MarkPaidModal({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const mark = useMarkInvoicePaid();
  const [method, setMethod] = React.useState<(typeof METHODS)[number]["key"]>("bank");
  const [part, setPart] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(todayIso());
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!invoice) return;
    setMethod("bank");
    setPart(false);
    setAmount("");
    setPaidOn(todayIso());
    setError(null);
  }, [invoice]);

  if (!invoice) return null;

  function save() {
    if (!invoice) return;
    setError(null);
    let value: number | null = null;
    if (part) {
      value = Number(amount);
      if (!(value > 0)) return setError("Enter the amount that came in.");
      if (value > invoice.outstanding + 0.005) return setError(`That is more than the ${moneyExact(invoice.outstanding)} still owing.`);
    }
    if (!paidOn) return setError("Pick the day the money arrived.");
    if (paidOn > todayIso()) return setError("The paid date cannot be in the future.");
    mark.mutate(
      { id: invoice.id, method, amount: value, paidOn },
      { onSuccess: onClose, onError: (e) => setError(errorText(e)) },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark ${invoice.ref} paid`}
      subtitle={`${invoice.label || invoice.kindLabel}. ${moneyExact(invoice.outstanding)} still owing.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={mark.isPending}>
            {mark.isPending ? <Spinner /> : <CheckCircle2 className="size-4" />}
            {part ? "Record part payment" : "Mark paid in full"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="How it was paid">
          <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            {METHODS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount">
          <Select value={part ? "part" : "full"} onChange={(e) => setPart(e.target.value === "part")}>
            <option value="full">Paid in full, {moneyExact(invoice.outstanding)}</option>
            <option value="part">Part payment</option>
          </Select>
        </Field>
        {part ? (
          <Field label="Amount received, inc GST">
            <Input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.00"
            />
          </Field>
        ) : null}
        <Field label="Day the money arrived">
          <Input type="date" value={paidOn} max={todayIso()} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function VoidModal({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  const voidIt = useVoidInvoice();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReason("");
    setError(null);
  }, [invoice]);

  if (!invoice) return null;

  function save() {
    if (!invoice) return;
    if (reason.trim().length < 3) return setError("Say why it is being voided.");
    voidIt.mutate({ id: invoice.id, reason: reason.trim() }, { onSuccess: onClose, onError: (e) => setError(errorText(e)) });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Void ${invoice.ref}`}
      subtitle="The invoice stays on record as void. It no longer counts as owing."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={save} disabled={voidIt.isPending}>
            {voidIt.isPending ? <Spinner /> : <Ban className="size-4" />}
            Void invoice
          </Button>
        </>
      }
    >
      <Field label="Reason">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example, raised in error" />
      </Field>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

type Billing = NonNullable<ReturnType<typeof useJobBilling>["data"]>;

const prettyIsoDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

const labelFor = (kind: "final" | "stage", b: Billing) => {
  const ref = b.quoteRef ? `quote ${b.quoteRef}` : `job ${b.jobRef}`;
  return kind === "final" ? `Final invoice, ${ref}` : `Progress invoice, ${ref}`;
};

/**
 * Raise a final or progress invoice (fix list item 9). The amount starts at
 * what is left to bill and can be changed. Emailed with the Pay by card link
 * straight away unless the box is unticked.
 */
function RaiseInvoiceModal({
  jobId,
  billing,
  open,
  onClose,
  onDone,
}: {
  jobId: number;
  billing: Billing;
  open: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const raise = useRaiseInvoice();
  const [kind, setKind] = React.useState<"final" | "stage">("final");
  const [amount, setAmount] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [labelEdited, setLabelEdited] = React.useState(false);
  const [email, setEmail] = React.useState(true);
  const [to, setTo] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [mailFail, setMailFail] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const k = billing.finalRef ? "stage" : "final";
    setKind(k);
    setAmount(billing.toBill.toFixed(2));
    setLabel(labelFor(k, billing));
    setLabelEdited(false);
    setEmail(true);
    setTo("");
    setError(null);
    setMailFail(null);
    raise.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const value = Number(amount);
  const exGst = value > 0 ? Math.round((value / 1.1) * 100) / 100 : 0;

  function save() {
    setError(null);
    if (!(value > 0)) return setError("Enter an amount over $0.");
    if (value > billing.toBill + 0.005) return setError(`That is more than the ${moneyExact(billing.toBill)} not billed yet.`);
    if (email && !to.trim() && !billing.recipient) return setError("No email address on file for this client. Type one in, or untick Email it now.");
    raise.mutate(
      { jobId, kind, amount: value, label: label.trim() || null, email, to: email ? to.trim() || null : null },
      {
        onSuccess: (out) => {
          if (out.emailError) {
            setMailFail(`${out.invoice.ref} is raised, but the email did not go: ${out.emailError} Use Email on the invoice to try again.`);
            return;
          }
          const withheld = out.summaryWithheld ? ` The billing summary was left off the PDF: ${out.summaryWithheld} An office task is on the job.` : "";
          onDone(out.emailedTo ? `${out.invoice.ref} raised and emailed to ${out.emailedTo}.${withheld}` : `${out.invoice.ref} raised. Use Email on it when you are ready to send.`);
          onClose();
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Raise an invoice"
      subtitle={`Job value ${moneyExact(billing.jobValue)} inc GST. Billed so far ${moneyExact(billing.billed)}. Not billed yet ${moneyExact(billing.toBill)}.`}
      footer={
        mailFail ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={raise.isPending}>
              {raise.isPending ? <Spinner /> : email ? <Send className="size-4" /> : <FilePlus2 className="size-4" />}
              {email ? "Raise and email" : "Raise invoice"}
            </Button>
          </>
        )
      }
    >
      {mailFail ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{mailFail}</p>
      ) : (
        <div className="grid gap-3">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as "final" | "stage";
                setKind(k);
                if (!labelEdited) setLabel(labelFor(k, billing));
              }}
            >
              <option value="final" disabled={!!billing.finalRef}>
                {billing.finalRef ? `Final (already raised as ${billing.finalRef})` : "Final"}
              </option>
              <option value="stage">Progress</option>
            </Select>
          </Field>
          <Field
            label="Amount, inc GST"
            hint={value > 0 ? `${moneyExact(exGst)} ex GST plus ${moneyExact(Math.round((value - exGst) * 100) / 100)} GST.` : undefined}
          >
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" />
          </Field>
          <Field label="Wording on the invoice">
            <Input
              value={label}
              maxLength={200}
              onChange={(e) => {
                setLabel(e.target.value);
                setLabelEdited(true);
              }}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Due {prettyIsoDay(billing.dueDay)} ({billing.termsText}).
          </p>
          <label htmlFor={`raise_inv_email_${jobId}`} className="flex items-center gap-2 text-sm">
            <Checkbox id={`raise_inv_email_${jobId}`} checked={email} onChange={(e) => setEmail(e.target.checked)} />
            Email it now with the Pay by card link
          </label>
          {email ? (
            <Field
              label="Send to"
              hint={billing.recipient ? `Leave empty to send to ${billing.recipient.who}, ${billing.recipient.email}.` : "No email on file for this client. Type one in."}
            >
              <EmailInput value={to} onValueChange={setTo} placeholder={billing.recipient?.email ?? "client@example.com"} />
            </Field>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}

export function ClientInvoicesCard({ jobId }: { jobId: number }) {
  const bootstrap = useBootstrap();
  const isAdmin = bootstrap.data?.actor.role === "admin";
  const data = useClientInvoices(jobId);
  const [paying, setPaying] = React.useState<Invoice | null>(null);
  const [voiding, setVoiding] = React.useState<Invoice | null>(null);
  const [emailing, setEmailing] = React.useState<Invoice | null>(null);
  const [copied, setCopied] = React.useState<number | null>(null);
  const billing = useJobBilling(jobId);
  const [raising, setRaising] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const bill = billing.data;

  const rows = data.data?.invoices ?? [];

  return (
    <Card>
      <CardHeader
        title="Client invoices"
        subtitle={
          data.data?.cardPayments
            ? "What the client has been billed, and what has come in. Card payments mark themselves paid. Mark bank transfers here."
            : "What the client has been billed, and what has come in. Mark payments here."
        }
        action={
          bill ? (
            <Button size="sm" onClick={() => setRaising(true)} disabled={!bill.canRaise} title={bill.reason ?? undefined}>
              <FilePlus2 className="size-3.5" />
              Raise invoice
            </Button>
          ) : null
        }
      />
      {bill && bill.jobValue > 0 ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Job value {moneyExact(bill.jobValue)} inc GST, accepted variations included.{" "}
          {bill.toBill > 0.005 ? (
            <span className="font-medium text-foreground">Not billed yet {moneyExact(bill.toBill)}.</span>
          ) : (
            "All of it is billed."
          )}
          {bill.reason && bill.toBill > 0.005 ? ` ${bill.reason}` : ""}
        </p>
      ) : null}
      {notice ? <p className="border-b border-border px-4 py-2 text-xs text-[var(--success)]">{notice}</p> : null}
      {data.isLoading ? (
        <Loading />
      ) : data.isError ? (
        <Empty>{errorText(data.error)}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No client invoices yet. A deposit invoice is raised by itself when a quote with a deposit is accepted. Use Raise invoice to bill the rest.</Empty>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="label-xs">Billed</p>
              <p className="tabular mt-0.5 text-sm font-semibold">{moneyExact(data.data?.billed)}</p>
            </div>
            <div>
              <p className="label-xs">Received</p>
              <p className="tabular mt-0.5 text-sm font-semibold text-[var(--success)]">{moneyExact(data.data?.received)}</p>
            </div>
            <div>
              <p className="label-xs">Owing</p>
              <p className={`tabular mt-0.5 text-sm font-semibold ${(data.data?.owing ?? 0) > 0 ? "text-[var(--warning)]" : ""}`}>
                {moneyExact(data.data?.owing)}
              </p>
            </div>
          </div>
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const meta = STATUS_META[r.status] ?? { label: r.status, colour: "#7A736D" };
              const open = r.status !== "paid" && r.status !== "void";
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="tabular">{r.ref}</span>
                      <span className="text-muted-foreground">{r.label || r.kindLabel}</span>
                      <Badge colour={meta.colour}>{meta.label}</Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {moneyExact(r.total)} inc GST
                      {r.dueDate ? `. Due ${dateOf(r.dueDate)}` : ""}
                      {r.amountPaid > 0 && r.status !== "void" ? `. ${moneyExact(r.amountPaid)} received` : ""}
                      {r.outstanding > 0 ? `, ${moneyExact(r.outstanding)} owing` : ""}
                    </p>
                    {open ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.emailedAt ? `Emailed ${dateOf(r.emailedAt) ?? ""}` : "Not emailed yet"}
                      </p>
                    ) : null}
                    {r.status === "paid" ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Paid {dateOf(r.paidAt) ?? ""}
                        {r.paymentMethod ? ` by ${METHOD_LABEL[r.paymentMethod]?.toLowerCase() ?? r.paymentMethod}` : ""}
                        {r.markedPaidByName ? `. Marked by ${r.markedPaidByName}` : ""}
                      </p>
                    ) : null}
                    {r.status === "void" ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Voided {dateOf(r.voidedAt) ?? ""}
                        {r.voidReason ? `: ${r.voidReason}` : ""}
                      </p>
                    ) : null}
                  </div>
                  {open ? (
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {r.payUrl ? (
                        <Button
                          size="sm"
                          variant="outline"
                          title="Copy the Pay by card link"
                          onClick={async () => {
                            await navigator.clipboard.writeText(r.payUrl ?? "");
                            setCopied(r.id);
                            setTimeout(() => setCopied(null), 2000);
                          }}
                        >
                          <Copy className="size-3.5" />
                          {copied === r.id ? "Copied" : "Pay link"}
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => setEmailing(r)}>
                        <Mail className="size-3.5" />
                        Email
                      </Button>
                      <Button size="sm" onClick={() => setPaying(r)}>
                        <CheckCircle2 className="size-3.5" />
                        Mark paid
                      </Button>
                      {isAdmin && r.amountPaid === 0 ? (
                        <Button size="sm" variant="outline" onClick={() => setVoiding(r)}>
                          <Ban className="size-3.5" />
                          Void
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {bill ? <RaiseInvoiceModal jobId={jobId} billing={bill} open={raising} onClose={() => setRaising(false)} onDone={setNotice} /> : null}
      <MarkPaidModal invoice={paying} onClose={() => setPaying(null)} />
      <EmailInvoiceModal invoice={emailing} jobId={jobId} onClose={() => setEmailing(null)} />
      {isAdmin ? <VoidModal invoice={voiding} onClose={() => setVoiding(null)} /> : null}
    </Card>
  );
}

/* --------------------------- material selection -------------------------- */

export function MaterialSelectionCard({ jobId }: { jobId: number }) {
  const sel = useMaterialSelection(jobId);
  const send = useSendSelection();
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const s = sel.data;

  function openSend() {
    setTo(s?.sentTo ?? "");
    setError(null);
    setOpen(true);
  }

  function doSend() {
    setError(null);
    send.mutate(
      { jobId, to: to.trim() || null },
      {
        onSuccess: (out) => {
          setOpen(false);
          setNotice(`Sent to ${out.to}.`);
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  const filled = (s?.items ?? []).filter((i) => i.product || i.colour || i.notes);

  return (
    <Card>
      <CardHeader
        title="Material selection"
        subtitle="The client checks the colour of each floor on the accepted quote before anything is ordered. Only sent from here."
        action={
          sel.isLoading ? null : (
            <Button size="sm" variant="outline" onClick={openSend}>
              <Send className="size-3.5" />
              {s?.sentAt ? "Send again" : "Send form"}
            </Button>
          )
        }
      />
      {sel.isLoading ? (
        <Loading />
      ) : sel.isError ? (
        <Empty>{errorText(sel.error)}</Empty>
      ) : !s ? (
        <Empty>No form yet. It never goes by itself. Send it once the quote is accepted.</Empty>
      ) : (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {s.locked && s.kind === "products" ? <Badge>Locked, materials ordered</Badge> : null}
            {s.status === "submitted" ? (
              <Badge colour="#3F7D3A">Filled in</Badge>
            ) : s.sentAt ? (
              <Badge colour="#D08A1E">Waiting on client</Badge>
            ) : (
              <Badge>Not sent</Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {s.status === "submitted"
                ? `By ${s.submittedName || "the client"}, ${dateOf(s.submittedAt) ?? ""}`
                : s.sentAt
                  ? `Sent to ${s.sentTo ?? "the client"}, ${dateOf(s.sentAt) ?? ""}`
                  : s.sentTo
                    ? `Will go to ${s.sentTo}`
                    : "No email address yet"}
            </span>
            <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline">
              Open form <ExternalLink className="size-3" />
            </a>
          </div>
          {notice ? <p className="mt-2 text-xs text-[var(--success)]">{notice}</p> : null}
          {s.kind === "products" ? (
            <SelectionSections s={s} />
          ) : filled.length ? (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {filled.map((i) => (
                <li key={i.id} className="px-3 py-2 text-sm">
                  <p className="font-medium">{i.room || "Room"}</p>
                  <p className="text-xs text-muted-foreground">
                    {[i.product, i.colour].filter(Boolean).join(", ") || "No product given"}
                  </p>
                  {i.notes ? <p className="mt-0.5 text-xs">{i.notes}</p> : null}
                </li>
              ))}
            </ul>
          ) : s.items.length ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Rooms on the form: {s.items.map((i) => i.room).filter(Boolean).join(", ")}
            </p>
          ) : null}
        </div>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={s?.sentAt ? "Send the form again" : "Send the material selection form"}
        subtitle="Emailed from team@ as Damien from Terra. Replies come back to team@."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={doSend} disabled={send.isPending}>
              {send.isPending ? <Spinner /> : <Send className="size-4" />}
              Send
            </Button>
          </>
        }
      >
        <Field label="Send to" hint="Leave blank to use the decision-maker's email on the job.">
          <EmailInput value={to} onValueChange={setTo} placeholder="client@example.com" />
        </Field>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </Modal>
    </Card>
  );
}

type SelectionView = NonNullable<ReturnType<typeof useMaterialSelection>["data"]>;

const CHANGE_LABEL: Record<string, string> = { swap: "Changed, same price", cheaper: "Changed, cheaper", dearer: "Changed, dearer" };

/** Item 8: the product form's sections, what the client picked and what it made. */
function SelectionSections({ s }: { s: SelectionView }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      <ul className="divide-y divide-border rounded-md border border-border">
        {s.sections.map((x) => (
          <li key={x.id} className="px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{x.title}</p>
              <span className="text-xs text-muted-foreground">{[x.kindLabel, x.qtyText].filter(Boolean).join(", ")}</span>
              {x.change !== "same" ? (
                <Badge colour={x.change === "dearer" ? "#D08A1E" : x.change === "cheaper" ? "#2E6B8F" : "#3F7D3A"}>{CHANGE_LABEL[x.change]}</Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              {x.change === "same" ? (
                <>Colour {x.colour}{s.status === "submitted" ? ", as quoted" : ""}</>
              ) : (
                <>
                  {x.quotedColour} to <span className="font-semibold text-foreground">{x.colour}</span>
                  {x.change === "dearer" || x.change === "cheaper"
                    ? `, ${moneyExact(Math.abs(x.extraIncGst))} inc GST ${x.change === "dearer" ? "more" : "less"}`
                    : ""}
                </>
              )}
            </p>
            {x.variation ? (
              <p className="mt-0.5 text-xs">
                Variation {x.variation.ref}, {x.variation.status}
                {x.variation.status === "draft" ? ". Check it and send it from Variations." : ""}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {s.upgrades.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {s.upgrades.map((u) => (
            <li key={u.id} className="px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Underlay upgrade offer</p>
                <Badge colour={u.answer === "yes" ? "#3F7D3A" : u.answer === "no" ? "#6B6B6B" : "#D08A1E"}>
                  {u.answer === "yes" ? "Yes, upgrade" : u.answer === "no" ? "No thanks" : "Not answered"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {u.fromName} to <span className="font-semibold text-foreground">{u.toName}</span>
                {u.qtyText ? `, ${u.qtyText}` : ""}, {moneyExact(u.extraIncGst)} inc GST extra
              </p>
              {u.variation ? (
                <p className="mt-0.5 text-xs">
                  Variation {u.variation.ref}, {u.variation.status}
                  {u.variation.status === "draft" ? ". Check it and send it from Variations." : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {s.notes ? (
        <p className="rounded-md bg-secondary px-3 py-2 text-xs">
          <span className="font-semibold">Client note:</span> {s.notes}
        </p>
      ) : null}
      {s.task ? (
        <p className="text-xs text-muted-foreground">
          Task: {s.task.title} ({s.task.status})
        </p>
      ) : null}
    </div>
  );
}
