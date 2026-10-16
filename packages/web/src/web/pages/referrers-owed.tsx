import * as React from "react";
import { Link } from "wouter";
import { FileText, Upload } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { FEE_STATUS_COLOUR, errText } from "../components/referrals";
import { money, moneyExact, shortDate } from "../lib/money";
import {
  useAttachReferralInvoice,
  useDecideReferral,
  useMarkReferralPaid,
  useReferrersOwed,
  useUnmarkReferralPaid,
} from "../queries/referrals";

/**
 * REFERRERS OWED (notes 18.47). Admin only.
 *
 * A fee lands here when every invoice on the referred job is paid, a final
 * among them. Damien attaches the referrer's invoice (with GST if they are
 * registered) and marks it paid with the date. Nothing is paid or sent from
 * here, and a fee is never taken off a bill the referrer owes Terra.
 * Cancelled or part paid jobs come in as "to decide".
 */

type Owed = NonNullable<ReturnType<typeof useReferrersOwed>["data"]>;
type Row = Owed["toPay"][number];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });

function toBase64(f: File) {
  return f.arrayBuffer().then((ab) => {
    const buf = new Uint8Array(ab);
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

export default function ReferrersOwedPage() {
  const q = useReferrersOwed();
  const d = q.data;
  const [paying, setPaying] = React.useState<Row | null>(null);
  const [deciding, setDeciding] = React.useState<Row | null>(null);

  return (
    <Page title="Referrers owed" subtitle="Referral fees on jobs paid in full. Attach their invoice, pay it from the bank, then mark it paid here. Fees are ex GST.">
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Stat label="To pay" value={d ? money(d.totals.toPay) : "…"} tone={d && d.totals.toPay > 0 ? "warning" : "default"} hint={d ? `${d.totals.count} ${d.totals.count === 1 ? "fee" : "fees"}, ex GST` : undefined} />
        <Stat label="To decide" value={d ? d.toDecide.length : "…"} tone={d && d.toDecide.length ? "warning" : "default"} hint="Cancelled, or not paid in full" />
        <Stat label="Paid" value={d ? money(d.paid.reduce((a, r) => a + r.amount, 0)) : "…"} hint="Ex GST, all time" />
      </div>

      {q.isLoading || !d ? (
        <Card>
          <Loading label="Opening referral fees…" />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {d.toDecide.length ? (
            <Card>
              <CardHeader title="For you to decide" subtitle="These jobs were cancelled or not paid in full. Pay a fee, or no fee." />
              <ul className="divide-y divide-border">
                {d.toDecide.map((r) => (
                  <OwedItem key={r.id} r={r} onDecide={() => setDeciding(r)} />
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="To pay" subtitle="Their invoice should come to the fee, plus GST if they are registered." />
            {d.toPay.length === 0 ? (
              <Empty>Nothing to pay. A fee shows here once its job is paid in full.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {d.toPay.map((r) => (
                  <OwedItem key={r.id} r={r} onPay={() => setPaying(r)} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Paid" subtitle="Newest first." />
            {d.paid.length === 0 ? (
              <Empty>No referral fees paid yet.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {d.paid.map((r) => (
                  <OwedItem key={r.id} r={r} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {paying ? <PayModal r={paying} onClose={() => setPaying(null)} /> : null}
      {deciding ? <DecideModal r={deciding} onClose={() => setDeciding(null)} /> : null}
    </Page>
  );
}

function OwedItem({ r, onPay, onDecide }: { r: Row; onPay?: () => void; onDecide?: () => void }) {
  const attach = useAttachReferralInvoice();
  const unmark = useUnmarkReferralPaid();
  const ref = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function onFile(f: File) {
    setError(null);
    if (f.size > 20_000_000) return setError("That file is over 20 MB.");
    try {
      await attach.mutateAsync({ id: r.id, filename: f.name, base64: await toBase64(f) });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm">
          <Link to={r.companyId != null ? `/companies/${r.companyId}` : `/clients/${r.contactId}`} className="font-medium text-primary hover:underline">
            {r.referrerName}
          </Link>
          <span className="text-muted-foreground"> for </span>
          <Link to={`/jobs/${r.jobId}`} className="font-medium text-primary hover:underline">
            job {r.jobRef}
          </Link>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {r.jobTitle}
          {r.jobStatus ? ` · ${r.jobStatus}` : ""} · {r.rate}
        </p>
        {r.flagReason ? <p className="mt-1 text-xs text-[var(--warning)]">{r.flagReason}</p> : null}
        {r.status !== "paid" ? (
          <p className="tabular mt-1 text-xs text-muted-foreground">
            {[
              r.bankAccountName ? r.bankAccountName : null,
              r.bankBsb ? `BSB ${r.bankBsb}` : null,
              r.bankAccountNumber ? `Acc ${r.bankAccountNumber}` : null,
              r.abn ? `ABN ${r.abn}` : null,
              r.remittanceEmail ? `Remittance ${r.remittanceEmail}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "No bank details on their card yet."}
          </p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {r.invoiceUrl ? (
            <a href={r.invoiceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              <FileText className="size-3.5" />
              {r.invoiceName ?? "Their invoice"}
            </a>
          ) : r.status === "owed" ? (
            <span className="text-muted-foreground">No invoice attached yet.</span>
          ) : null}
          {r.paidOn ? (
            <span className="text-muted-foreground">
              Paid {shortDate(r.paidOn)}
              {r.paidByName ? ` by ${r.paidByName}` : ""}
              {r.invoiceAmount != null ? `, invoice ${moneyExact(r.invoiceAmount)}` : ""}
            </span>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
        <div className="text-left sm:text-right">
          <Badge colour={FEE_STATUS_COLOUR[r.status]}>{r.statusLabel}</Badge>
          <p className="tabular mt-1 text-base font-semibold">{moneyExact(r.amount)}</p>
          <p className="tabular text-xs text-muted-foreground">
            {r.gstRegistered ? `Their invoice ${moneyExact(r.expectedInvoice)} inc GST` : "Not GST registered"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.status !== "paid" ? (
            <>
              <input
                ref={ref}
                type="file"
                accept="application/pdf,.pdf,image/png,image/jpeg"
                aria-label="Attach their invoice"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void onFile(f);
                }}
              />
              <Button size="sm" variant="outline" onClick={() => ref.current?.click()} disabled={attach.isPending}>
                {attach.isPending ? <Spinner /> : <Upload />}
                {r.invoiceUrl ? "Replace invoice" : "Attach invoice"}
              </Button>
            </>
          ) : null}
          {onPay ? (
            <Button size="sm" onClick={onPay}>
              Mark paid
            </Button>
          ) : null}
          {onDecide ? (
            <Button size="sm" onClick={onDecide}>
              Decide
            </Button>
          ) : null}
          {r.status === "paid" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                setError(null);
                try {
                  await unmark.mutateAsync({ id: r.id });
                } catch (e) {
                  setError(errText(e));
                }
              }}
              disabled={unmark.isPending}
            >
              Undo paid
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function PayModal({ r, onClose }: { r: Row; onClose: () => void }) {
  const mark = useMarkReferralPaid();
  const [paidOn, setPaidOn] = React.useState(today());
  const [amount, setAmount] = React.useState(r.invoiceAmount != null ? String(r.invoiceAmount) : String(r.expectedInvoice));
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setError(null);
    const n = amount.trim() ? Number(amount) : null;
    if (n != null && (!Number.isFinite(n) || n < 0)) return setError("Type the invoice amount as a number.");
    try {
      await mark.mutateAsync({ id: r.id, paidOn, invoiceAmount: n });
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark paid: ${r.referrerName}`}
      subtitle={`Job ${r.jobRef}. Fee ${moneyExact(r.amount)} ex GST.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={mark.isPending || !paidOn}>
            {mark.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Mark paid
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="Date paid">
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Their invoice came to" hint={r.gstRegistered ? "Inc GST, as they are GST registered." : "They are not GST registered."}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">This only records it. Pay it from the bank yourself. The task to pay it closes.</p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function DecideModal({ r, onClose }: { r: Row; onClose: () => void }) {
  const decide = useDecideReferral();
  const [amount, setAmount] = React.useState(r.amount ? String(r.amount) : "");
  const [error, setError] = React.useState<string | null>(null);

  async function go(decision: "owe" | "no_fee") {
    setError(null);
    const n = decision === "owe" && amount.trim() ? Number(amount) : null;
    if (decision === "owe" && (n == null || !Number.isFinite(n) || n <= 0)) return setError("Type the fee to pay, or choose No fee.");
    try {
      await decide.mutateAsync({ id: r.id, decision, amount: n });
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Decide: ${r.referrerName}`}
      subtitle={`Job ${r.jobRef}. ${r.flagReason ?? ""}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => void go("no_fee")} disabled={decide.isPending}>
            No fee
          </Button>
          <Button onClick={() => void go("owe")} disabled={decide.isPending}>
            {decide.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Pay this fee
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="Fee to pay, ex GST" hint={`Worked out at ${r.rate} on what the client was charged. Change it if you like.`}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">Pay this fee moves it to To pay and makes the task. No fee closes it.</p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
