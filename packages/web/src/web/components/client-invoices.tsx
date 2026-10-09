import * as React from "react";
import { Ban, CheckCircle2, ExternalLink, Send } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { moneyExact } from "../lib/money";
import { useBootstrap } from "../queries/settings";
import {
  useClientInvoices,
  useMarkInvoicePaid,
  useMaterialSelection,
  useSendSelection,
  useVoidInvoice,
} from "../queries/clientInvoices";

/**
 * THE MONEY-IN SIDE OF A JOB (spec section 2).
 *
 * Every client invoice on the job, numbered off the job (IQ...). Until Stripe
 * is connected, money is marked received here by hand: Admin and Office can
 * mark paid, only Admin can void, and nothing with money on it can be voided.
 */

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

export function ClientInvoicesCard({ jobId }: { jobId: number }) {
  const bootstrap = useBootstrap();
  const isAdmin = bootstrap.data?.actor.role === "admin";
  const data = useClientInvoices(jobId);
  const [paying, setPaying] = React.useState<Invoice | null>(null);
  const [voiding, setVoiding] = React.useState<Invoice | null>(null);

  const rows = data.data?.invoices ?? [];

  return (
    <Card>
      <CardHeader
        title="Client invoices"
        subtitle="What the client has been billed, and what has come in. Mark payments here until card payments are connected."
      />
      {data.isLoading ? (
        <Loading />
      ) : data.isError ? (
        <Empty>{errorText(data.error)}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No client invoices yet. The deposit invoice is raised when the quote is accepted.</Empty>
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
                    <div className="flex shrink-0 gap-1.5">
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
      <MarkPaidModal invoice={paying} onClose={() => setPaying(null)} />
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
        subtitle="The client picks product and colour for each room before anything is ordered."
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
        <Empty>No form yet. It goes out by itself when the quote is accepted, or send it now.</Empty>
      ) : (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
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
          {filled.length ? (
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
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@example.com" />
        </Field>
        {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      </Modal>
    </Card>
  );
}
