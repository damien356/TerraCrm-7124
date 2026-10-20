import * as React from "react";
import { FileText, Send } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Select } from "../ui/field";
import { Modal } from "../ui/modal";
import {
  useAgreements,
  useApproveOffset,
  useBillsForOffset,
  useCancelOffset,
  useConfirmOffset,
  useOffsetFileUrl,
  useProposeOffset,
  useRemittancePdf,
  useReverseOffset,
  useSendRemittance,
} from "../../queries/trade";
import { ErrorLine, OffsetBadge, PdfButton, auDate, auDateTime, errText, fileToUpload, m2 } from "./shared";
import type { Sale } from "./sale-draft";

type Offset = Sale["offsets"][number];

const SETTLE_KIND: Record<string, string> = { cash: "Cash paid", cash_reversal: "Cash reversed", offset: "Materials offset", offset_reversal: "Offset reversed" };

/**
 * Taking a trade sale off an installer's labour bill. Four steps, all Admin:
 * propose (the bill is held), approve (agreement on file), confirm (the Xero
 * reference, once it is done there by hand) and, if needed, reverse. Nothing
 * here writes to Xero or pays anyone.
 */
export function OffsetsCard({ sale }: { sale: Sale }) {
  const [propose, setPropose] = React.useState(false);
  const [approve, setApprove] = React.useState<Offset | null>(null);
  const [confirm, setConfirm] = React.useState<Offset | null>(null);
  const [cancel, setCancel] = React.useState<Offset | null>(null);
  const [reverse, setReverse] = React.useState<Offset | null>(null);
  const fileUrl = useOffsetFileUrl();
  const open = sale.offsets.some((o) => o.status === "proposed" || o.status === "approved");
  const canPropose = sale.status === "finalised" && !open && sale.money.balance > 0.005;
  const billIds = [...new Set(sale.offsets.filter((o) => o.status === "confirmed" && o.billId).map((o) => o.billId!))];

  return (
    <Card>
      <CardHeader
        title="Offset against their bill"
        subtitle={
          sale.buyer.entityOk
            ? `Same entity verified on ABN ${sale.buyer.entityAbn}.`
            : "Same entity not verified. Verify it on the installer's Trade tab before any offset is approved."
        }
        action={
          canPropose ? (
            <Button size="sm" variant="outline" onClick={() => setPropose(true)}>
              Propose offset
            </Button>
          ) : null
        }
      />
      {sale.offsets.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="th px-4 py-2 text-left">Bill</th>
              <th className="th px-4 py-2 text-right">Amount</th>
              <th className="th px-4 py-2 text-left">State</th>
              <th className="th px-4 py-2 text-left">Trail</th>
              <th aria-hidden="true" className="th px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {sale.offsets.map((o) => (
              <tr key={o.id} className="border-b border-border align-top last:border-0">
                <td className="px-4 py-2">
                  {o.bill ? `${o.bill.number || `Bill ${o.bill.id}`}${o.bill.jobNumber ? ` (job ${o.bill.jobNumber})` : ""}` : "No bill"}
                  {o.bill ? <p className="text-xs text-muted-foreground">Bill total {m2(o.bill.total)}, {o.bill.status.replace(/_/g, " ")}</p> : null}
                </td>
                <td className="tabular px-4 py-2 text-right">{m2(o.status === "confirmed" ? (o.confirmedAmount ?? o.amount) : o.amount)}</td>
                <td className="px-4 py-2">
                  <OffsetBadge status={o.status} />
                  {o.conflict ? <p className="mt-1 text-xs text-destructive">Flagged: {o.conflict}</p> : null}
                </td>
                <td className="px-4 py-2 text-xs text-muted-foreground">
                  <p>Proposed by {o.proposedByName}, {auDateTime(o.createdAt)}</p>
                  {o.approvedAt ? (
                    <p>
                      Approved by {o.approvedByName}, {auDateTime(o.approvedAt)}. Agreement {o.agreementRef}
                    </p>
                  ) : null}
                  {o.confirmedAt ? (
                    <p>
                      Confirmed by {o.confirmedByName}, {auDateTime(o.confirmedAt)}. Xero ref {o.xeroRef}
                    </p>
                  ) : null}
                  {o.cancelledAt ? (
                    <p>
                      Cancelled by {o.cancelledByName}, {auDateTime(o.cancelledAt)}. {o.cancelReason}
                    </p>
                  ) : null}
                </td>
                <td className="px-4 py-2 text-right">
                  <span className="inline-flex flex-wrap justify-end gap-1">
                    {o.agreementFileKey || o.agreementId ? (
                      <Button size="sm" variant="ghost" title="Agreement file" onClick={async () => window.open((await fileUrl.mutateAsync({ offsetId: o.id })).url, "_blank")}>
                        <FileText className="size-4" />
                      </Button>
                    ) : null}
                    {o.status === "proposed" ? (
                      <Button size="sm" onClick={() => setApprove(o)}>
                        Approve
                      </Button>
                    ) : null}
                    {o.status === "approved" ? (
                      <Button size="sm" onClick={() => setConfirm(o)}>
                        Confirm
                      </Button>
                    ) : null}
                    {o.status === "proposed" || o.status === "approved" ? (
                      <Button size="sm" variant="ghost" onClick={() => setCancel(o)}>
                        Cancel
                      </Button>
                    ) : null}
                    {o.status === "confirmed" ? (
                      <Button size="sm" variant="ghost" onClick={() => setReverse(o)}>
                        Reverse
                      </Button>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{sale.settleBy === "deduct" ? "Meant to come off their bill. Propose the offset once the bill is in." : "No offset. This buyer pays."}</Empty>
      )}
      <ErrorLine error={fileUrl.error} />
      {sale.settlements.length ? (
        <div className="border-t border-border px-4 py-3">
          <p className="label-xs mb-1">On the bill</p>
          <ul className="text-sm">
            {sale.settlements.map((s) => (
              <li key={s.id} className="flex justify-between gap-4">
                <span>
                  {SETTLE_KIND[s.kind] ?? s.kind}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {auDateTime(s.createdAt)}
                    {s.reference ? `, ref ${s.reference}` : ""}
                    {s.reason ? `. ${s.reason}` : ""}
                  </span>
                </span>
                <span className="tabular">{s.kind.endsWith("reversal") ? `minus ${m2(s.amount)}` : m2(s.amount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {billIds.length ? (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          {billIds.map((id) => (
            <Remittance key={id} billId={id} label={`bill #${sale.offsets.find((o) => o.billId === id)?.bill?.number ?? id}`} />
          ))}
        </div>
      ) : null}
      <ProposeModal open={propose} sale={sale} onClose={() => setPropose(false)} />
      <ApproveModal sale={sale} offset={approve} onClose={() => setApprove(null)} />
      <ConfirmModal sale={sale} offset={confirm} onClose={() => setConfirm(null)} />
      <CancelModal sale={sale} offset={cancel} onClose={() => setCancel(null)} />
      <ReverseOffsetModal sale={sale} offset={reverse} onClose={() => setReverse(null)} />
    </Card>
  );
}

function Remittance({ billId, label }: { billId: number; label: string }) {
  const pdf = useRemittancePdf();
  const send = useSendRemittance();
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Remittance for {label}:</span>
      <PdfButton label="Preview PDF" get={() => pdf.mutateAsync({ billId })} />
      <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate({ billId, to: null })}>
        <Send className="size-4" />
        Send remittance
      </Button>
      {send.isSuccess ? <span className="text-xs text-[var(--success)]">Sent to {send.data?.to}</span> : null}
      <ErrorLine error={send.error} />
    </span>
  );
}

function Foot({ onClose, onSave, ok, busy, label }: { onClose: () => void; onSave: () => void; ok: boolean; busy: boolean; label: string }) {
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" onClick={onClose}>
        Close
      </Button>
      <Button size="sm" disabled={!ok || busy} onClick={onSave}>
        {busy ? <Spinner /> : null}
        {label}
      </Button>
    </div>
  );
}

function ProposeModal({ open, sale, onClose }: { open: boolean; sale: Sale; onClose: () => void }) {
  const bills = useBillsForOffset(sale.id, open);
  const propose = useProposeOffset();
  const [billId, setBillId] = React.useState(0);
  const [amount, setAmount] = React.useState("");
  const bill = bills.data?.find((b) => b.id === billId);
  React.useEffect(() => {
    if (bill) setAmount(Math.min(sale.money.balance, bill.remaining).toFixed(2));
  }, [bill, sale.money.balance]);
  const n = Number(amount);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Propose an offset"
      subtitle="Holds the bill: it cannot be scheduled or marked paid until this is confirmed or cancelled."
      footer={
        <Foot
          onClose={onClose}
          busy={propose.isPending}
          ok={!!bill && n > 0 && n <= Math.min(sale.money.balance, bill.remaining) + 0.005}
          label="Propose"
          onSave={async () => {
            await propose.mutateAsync({ saleId: sale.id, billId, amount: n });
            onClose();
          }}
        />
      }
    >
      {bills.isLoading ? <Loading /> : null}
      {bills.data && !bills.data.length ? <p className="text-sm text-muted-foreground">This installer has no submitted or approved bill to take it off.</p> : null}
      {bills.data?.length ? (
        <div className="flex flex-col gap-3">
          <Field label="Bill">
            <Select value={billId} onChange={(e) => setBillId(Number(e.target.value))}>
              <option value={0}>Pick a bill</option>
              {bills.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.invoiceNumber || `Bill ${b.id}`}
                  {b.jobNumber ? `, job ${b.jobNumber}` : ""}, {m2(b.total)}, left to pay {m2(b.remaining)}
                </option>
              ))}
            </Select>
          </Field>
          {bill && !bill.abnMatches ? (
            <p className="text-sm text-[var(--warning)]">This bill&apos;s ABN ({bill.abn || "blank"}) does not match the verified entity. It cannot be approved as it stands.</p>
          ) : null}
          <Field label={`Amount (owing ${m2(sale.money.balance)})`}>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <ErrorLine error={propose.error ?? bills.error} />
    </Modal>
  );
}

function ApproveModal({ sale, offset, onClose }: { sale: Sale; offset: Offset | null; onClose: () => void }) {
  const approve = useApproveOffset();
  const agreements = useAgreements(sale.buyer.refId);
  const [ref, setRef] = React.useState("");
  const [agreementId, setAgreementId] = React.useState(0);
  const [file, setFile] = React.useState<File | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (offset) {
      setRef("");
      setAgreementId(0);
      setFile(null);
      setErr(null);
      approve.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [offset?.id]);
  const inDate = (agreements.data ?? []).filter((a) => a.inDate && !a.archivedAt);
  return (
    <Modal
      open={!!offset}
      onClose={onClose}
      title="Approve the offset"
      subtitle="Needs the same entity check, matching ABNs, and either a signed file for this offset or an in-date standing agreement."
      footer={
        <Foot
          onClose={onClose}
          busy={approve.isPending}
          ok={!!ref.trim() && (agreementId > 0 || !!file)}
          label="Approve"
          onSave={async () => {
            setErr(null);
            try {
              await approve.mutateAsync({
                saleId: sale.id,
                offsetId: offset!.id,
                agreementRef: ref.trim(),
                agreementId: agreementId || null,
                file: file && !agreementId ? await fileToUpload(file) : null,
              });
              onClose();
            } catch (e) {
              setErr(errText(e));
            }
          }}
        />
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Agreement reference">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. signed authority 20 Oct" />
        </Field>
        {inDate.length ? (
          <Field label="Standing agreement">
            <Select value={agreementId} onChange={(e) => setAgreementId(Number(e.target.value))}>
              <option value={0}>None, I will upload a file</option>
              {inDate.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.filename}, signed {auDate(a.signedDate)}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground">No in-date standing agreement on this installer&apos;s card.</p>
        )}
        {!agreementId ? (
          <Field label="Signed file for this offset">
            <Input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        ) : null}
        {err ? <p className="text-sm text-destructive">{err}</p> : null}
      </div>
    </Modal>
  );
}

function ConfirmModal({ sale, offset, onClose }: { sale: Sale; offset: Offset | null; onClose: () => void }) {
  const confirm = useConfirmOffset();
  const [xero, setXero] = React.useState("");
  const [amount, setAmount] = React.useState("");
  React.useEffect(() => {
    if (offset) {
      setXero("");
      setAmount(offset.amount.toFixed(2));
      confirm.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [offset?.id]);
  const n = Number(amount);
  return (
    <Modal
      open={!!offset}
      onClose={onClose}
      title="Confirm the offset"
      subtitle="Do the offset in Xero by hand first, then record its reference here. This records it; it does not write to Xero."
      footer={
        <Foot
          onClose={onClose}
          busy={confirm.isPending}
          ok={!!xero.trim() && n > 0 && n <= (offset?.amount ?? 0) + 0.005}
          label="Confirm"
          onSave={async () => {
            const out = await confirm.mutateAsync({ saleId: sale.id, offsetId: offset!.id, xeroRef: xero.trim(), amount: n });
            if (!("conflict" in out) || !out.conflict) onClose();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Xero reference">
          <Input value={xero} onChange={(e) => setXero(e.target.value)} />
        </Field>
        <Field label={`Amount (approved ${m2(offset?.amount)})`}>
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      </div>
      {confirm.data && "conflict" in confirm.data && confirm.data.conflict ? (
        <p className="mt-2 text-sm text-destructive">Flagged: {String(confirm.data.conflict)}. Nothing was applied.</p>
      ) : null}
      <ErrorLine error={confirm.error} />
    </Modal>
  );
}

function CancelModal({ sale, offset, onClose }: { sale: Sale; offset: Offset | null; onClose: () => void }) {
  const cancel = useCancelOffset();
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open={!!offset}
      onClose={onClose}
      title="Cancel the offset"
      subtitle="Releases the bill. Nothing was applied, so no money changes."
      footer={
        <Foot
          onClose={onClose}
          busy={cancel.isPending}
          ok={!!reason.trim()}
          label="Cancel offset"
          onSave={async () => {
            await cancel.mutateAsync({ saleId: sale.id, offsetId: offset!.id, reason: reason.trim() });
            setReason("");
            onClose();
          }}
        />
      }
    >
      <Field label="Why">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={cancel.error} />
    </Modal>
  );
}

function ReverseOffsetModal({ sale, offset, onClose }: { sale: Sale; offset: Offset | null; onClose: () => void }) {
  const rev = useReverseOffset();
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (offset) {
      const credit = sale.money.balance < 0 ? -sale.money.balance : 0;
      setAmount((credit > 0 ? Math.min(credit, offset.confirmedAmount ?? offset.amount) : (offset.confirmedAmount ?? offset.amount)).toFixed(2));
      setReason("");
      rev.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [offset?.id]);
  const n = Number(amount);
  return (
    <Modal
      open={!!offset}
      onClose={onClose}
      title="Reverse the offset"
      subtitle="Only while the bill is unpaid. The installer is then paid that amount in cash with the bill, and it goes back on to this sale. Logged as a reversal row."
      footer={
        <Foot
          onClose={onClose}
          busy={rev.isPending}
          ok={n > 0 && !!reason.trim()}
          label="Reverse"
          onSave={async () => {
            await rev.mutateAsync({ saleId: sale.id, offsetId: offset!.id, amount: n, reason: reason.trim() });
            onClose();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount">
          <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Why">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      {offset?.bill && offset.bill.status !== "submitted" && offset.bill.status !== "approved" ? (
        <Badge colour="#B23B2C" className="mt-2">
          The bill is {offset.bill.status.replace(/_/g, " ")}. Reversal will be refused.
        </Badge>
      ) : null}
      <ErrorLine error={rev.error} />
    </Modal>
  );
}
