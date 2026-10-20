import * as React from "react";
import { Link } from "wouter";
import { Copy, Send } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Select } from "../ui/field";
import { Modal } from "../ui/modal";
import {
  newKey,
  useApplyCredit,
  useCreateCredit,
  useCreditPdf,
  useFulfil,
  useKeepAsCredit,
  useRecordPayment,
  useRecordRefund,
  useRecordReturn,
  useReversePayment,
  useSendCredit,
  useSetArrangement,
  useSetFulfilmentMethod,
  useTradeSales,
} from "../../queries/trade";
import { ErrorLine, PdfButton, Row, auDate, auDateTime, m2, qtyText, todayYmd } from "./shared";
import type { Sale } from "./sale-draft";

const METHOD: Record<string, string> = { card: "Card", bank: "Bank", cash: "Cash", other: "Other", credit: "Credit from another sale" };
const KIND: Record<string, string> = { payment: "Payment", refund: "Refund", payment_reversal: "Payment reversed", refund_reversal: "Refund reversed" };

/* ---------------------------------- money ---------------------------------- */

export function MoneyCard({ sale }: { sale: Sale }) {
  const m = sale.money;
  const [modal, setModal] = React.useState<null | "pay" | "refund" | "keep" | "apply" | "arrange">(null);
  const [undo, setUndo] = React.useState<number | null>(null);
  const [copied, setCopied] = React.useState(false);
  const credit = m.balance < -0.005 ? -m.balance : 0;
  const owing = m.balance > 0.005 ? m.balance : 0;
  const reversed = new Set(sale.payments.filter((p) => p.reversesId).map((p) => p.reversesId!));

  return (
    <Card>
      <CardHeader title="Money" subtitle="Cash in is money received. Offsets come off an installer's bill and are not cash." />
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        <dl className="flex flex-col gap-1.5">
          <Row label="Invoice total" value={m2(m.total)} />
          {m.credited ? <Row label="Credit notes" value={`less ${m2(m.credited)}`} /> : null}
          <Row label="Cash received" value={`less ${m2(m.cashIn)}`} />
          {m.refunded ? <Row label="Refunded" value={`plus ${m2(m.refunded)}`} /> : null}
          {m.offsetConfirmed ? <Row label="Offset off their bill" value={`less ${m2(m.offsetConfirmed)}`} /> : null}
          {m.offsetPending ? <Row label="Offset waiting (not counted yet)" value={m2(m.offsetPending)} /> : null}
          <div className="my-1 border-t border-border" />
          {credit ? <Row strong tone="danger" label="Credit balance" value={m2(credit)} /> : <Row strong label="Still owing" value={m2(owing)} />}
          <p className="mt-1 text-xs text-muted-foreground">
            {sale.terms.payBeforeCollection && !sale.arrangement
              ? "Pay before collection. The goods cannot go out until it is paid or an arrangement is recorded."
              : sale.terms.dueDate
                ? `Due ${auDate(sale.terms.dueDate)} (${sale.terms.termsDays} days).`
                : ""}
          </p>
          {sale.arrangement ? (
            <p className="text-xs text-muted-foreground">
              Arrangement: {sale.arrangement.note} ({sale.arrangement.by}, {auDateTime(sale.arrangement.at)})
            </p>
          ) : null}
        </dl>
        <div className="flex flex-col gap-2">
          {sale.status === "finalised" ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!owing} onClick={() => setModal("pay")}>
                  Record payment
                </Button>
                {sale.terms.payBeforeCollection && !sale.arrangement && !sale.fulfilment ? (
                  <Button size="sm" variant="outline" onClick={() => setModal("arrange")}>
                    Record arrangement
                  </Button>
                ) : null}
              </div>
              {owing ? (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Card pay link:</span>
                  <code className="truncate rounded bg-secondary px-1.5 py-0.5 text-xs">{sale.payUrl}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await navigator.clipboard.writeText(sale.payUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    <Copy className="size-4" />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
              ) : null}
              {credit ? (
                <div className="rounded-md border border-border p-3 text-sm">
                  <p className="mb-2 font-medium">What happens to the {m2(credit)} credit?</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => setModal("refund")}>
                      Refund it
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setModal("keep")}>
                      Keep as credit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setModal("apply")}>
                      Use on another sale
                    </Button>
                  </div>
                  {sale.offsets.some((o) => o.status === "confirmed") ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      This sale was offset against a bill. If that bill is still unpaid you can also reverse part of the offset below, so the installer gets it in cash with the bill.
                      Each choice checks the live balance, so the same credit is never used twice.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
      {sale.payments.length ? (
        <table className="w-full border-t border-border text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="th px-4 py-2 text-left">Date</th>
              <th className="th px-4 py-2 text-left">Entry</th>
              <th className="th px-4 py-2 text-left">Method</th>
              <th className="th px-4 py-2 text-left">Reference</th>
              <th className="th px-4 py-2 text-right">Amount</th>
              <th aria-hidden="true" className="th px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {sale.payments.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{auDate(p.paidDate)}</td>
                <td className="px-4 py-2">
                  {KIND[p.kind] ?? p.kind}
                  {reversed.has(p.id) ? <Badge className="ml-1.5">Reversed</Badge> : null}
                </td>
                <td className="px-4 py-2">{METHOD[p.method] ?? p.method}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {p.reference}
                  {p.byName ? `. ${p.byName}` : ""}
                </td>
                <td className="tabular px-4 py-2 text-right">{m2(p.amount)}</td>
                <td className="px-4 py-2 text-right">
                  {(p.kind === "payment" || p.kind === "refund") && p.method !== "credit" && !reversed.has(p.id) ? (
                    <Button size="sm" variant="ghost" onClick={() => setUndo(p.id)}>
                      Reverse
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <PaymentModal open={modal === "pay"} sale={sale} max={owing} onClose={() => setModal(null)} />
      <RefundModal open={modal === "refund"} sale={sale} max={credit} onClose={() => setModal(null)} />
      <KeepModal open={modal === "keep"} sale={sale} onClose={() => setModal(null)} />
      <ApplyModal open={modal === "apply"} sale={sale} max={credit} onClose={() => setModal(null)} />
      <ArrangeModal open={modal === "arrange"} sale={sale} onClose={() => setModal(null)} />
      <ReverseModal saleId={sale.id} paymentId={undo} onClose={() => setUndo(null)} />
    </Card>
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

function PaymentModal({ open, sale, max, onClose }: { open: boolean; sale: Sale; max: number; onClose: () => void }) {
  const pay = useRecordPayment();
  const [f, setF] = React.useState({ method: "bank" as "bank" | "cash" | "other", amount: "", date: todayYmd(), ref: "" });
  const key = React.useRef(newKey());
  React.useEffect(() => {
    if (open) {
      setF({ method: "bank", amount: max.toFixed(2), date: todayYmd(), ref: "" });
      key.current = newKey();
      pay.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [open]);
  const n = Number(f.amount);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a payment received"
      subtitle="Bank, cash or other. Card payments come in through the pay link on their own."
      footer={
        <Foot
          onClose={onClose}
          busy={pay.isPending}
          ok={n > 0 && n <= max + 0.005 && !!f.ref.trim()}
          label="Record payment"
          onSave={async () => {
            await pay.mutateAsync({ saleId: sale.id, method: f.method, amount: n, paidDate: f.date, reference: f.ref.trim(), key: key.current });
            onClose();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as typeof f.method })}>
            <option value="bank">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label={`Amount (owing ${m2(max)})`}>
          <Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Date received">
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Bank or receipt reference">
          <Input value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} />
        </Field>
      </div>
      <ErrorLine error={pay.error} />
    </Modal>
  );
}

function RefundModal({ open, sale, max, onClose }: { open: boolean; sale: Sale; max: number; onClose: () => void }) {
  const refund = useRecordRefund();
  const [f, setF] = React.useState({ method: "bank" as "bank" | "card" | "cash" | "other", amount: "", date: todayYmd(), ref: "" });
  const key = React.useRef(newKey());
  React.useEffect(() => {
    if (open) {
      setF({ method: "bank", amount: max.toFixed(2), date: todayYmd(), ref: "" });
      key.current = newKey();
      refund.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [open]);
  const n = Number(f.amount);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a refund paid out"
      subtitle="Records a refund Terra has already made. It does not send any money."
      footer={
        <Foot
          onClose={onClose}
          busy={refund.isPending}
          ok={n > 0 && n <= max + 0.005 && !!f.ref.trim()}
          label="Record refund"
          onSave={async () => {
            await refund.mutateAsync({ saleId: sale.id, method: f.method, amount: n, paidDate: f.date, reference: f.ref.trim(), key: key.current });
            onClose();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as typeof f.method })}>
            <option value="bank">Bank transfer</option>
            <option value="card">Card (refunded in Stripe)</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <Field label={`Amount (credit ${m2(max)})`}>
          <Input type="number" step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Date refunded">
          <Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </Field>
        <Field label="Refund reference">
          <Input value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} />
        </Field>
      </div>
      <ErrorLine error={refund.error} />
    </Modal>
  );
}

function KeepModal({ open, sale, onClose }: { open: boolean; sale: Sale; onClose: () => void }) {
  const keep = useKeepAsCredit();
  const [note, setNote] = React.useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keep it as credit"
      subtitle="Nothing moves. The credit stays on this sale and shows on the buyer's card until it is used or refunded."
      footer={
        <Foot
          onClose={onClose}
          busy={keep.isPending}
          ok
          label="Keep as credit"
          onSave={async () => {
            await keep.mutateAsync({ saleId: sale.id, note });
            onClose();
          }}
        />
      }
    >
      <Field label="Note (optional)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorLine error={keep.error} />
    </Modal>
  );
}

function ApplyModal({ open, sale, max, onClose }: { open: boolean; sale: Sale; max: number; onClose: () => void }) {
  const apply = useApplyCredit();
  const others = useTradeSales({ buyerId: sale.buyer.id, status: "finalised" });
  const [to, setTo] = React.useState(0);
  const [amount, setAmount] = React.useState("");
  const key = React.useRef(newKey());
  React.useEffect(() => {
    if (open) {
      key.current = newKey();
      setTo(0);
      setAmount(max.toFixed(2));
      apply.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [open]);
  const choices = (others.data ?? []).filter((s) => s.id !== sale.id && s.money.balance > 0.005);
  const n = Number(amount);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Use the credit on another sale"
      subtitle="Same buyer only. Two linked entries, no cash."
      footer={
        <Foot
          onClose={onClose}
          busy={apply.isPending}
          ok={to > 0 && n > 0 && n <= max + 0.005}
          label="Apply credit"
          onSave={async () => {
            await apply.mutateAsync({ fromSaleId: sale.id, toSaleId: to, amount: n, key: key.current });
            onClose();
          }}
        />
      }
    >
      {others.data && !choices.length ? <p className="text-sm text-muted-foreground">This buyer has no other invoice with money owing.</p> : null}
      {choices.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Invoice">
            <Select value={to} onChange={(e) => setTo(Number(e.target.value))}>
              <option value={0}>Pick an invoice</option>
              {choices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.invoiceRef}, owing {m2(s.money.balance)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`Amount (credit ${m2(max)})`}>
            <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      ) : null}
      <ErrorLine error={apply.error} />
    </Modal>
  );
}

function ArrangeModal({ open, sale, onClose }: { open: boolean; sale: Sale; onClose: () => void }) {
  const set = useSetArrangement();
  const [note, setNote] = React.useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record an arrangement"
      subtitle="Lets the goods go out before payment. Write down what was agreed. Your name and the time are kept."
      footer={
        <Foot
          onClose={onClose}
          busy={set.isPending}
          ok={!!note.trim()}
          label="Save arrangement"
          onSave={async () => {
            await set.mutateAsync({ saleId: sale.id, note: note.trim() });
            onClose();
          }}
        />
      }
    >
      <Field label="What was agreed">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <ErrorLine error={set.error} />
    </Modal>
  );
}

function ReverseModal({ saleId, paymentId, onClose }: { saleId: number; paymentId: number | null; onClose: () => void }) {
  const rev = useReversePayment();
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open={paymentId != null}
      onClose={onClose}
      title="Reverse this entry"
      subtitle="For an entry made by mistake. The original stays on the record with a reversal next to it."
      footer={
        <Foot
          onClose={onClose}
          busy={rev.isPending}
          ok={!!reason.trim()}
          label="Reverse"
          onSave={async () => {
            await rev.mutateAsync({ saleId, paymentId: paymentId!, reason: reason.trim() });
            setReason("");
            onClose();
          }}
        />
      }
    >
      <Field label="Why">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={rev.error} />
    </Modal>
  );
}

/* --------------------------------- credits --------------------------------- */

export function CreditsCard({ sale }: { sale: Sale }) {
  const pdf = useCreditPdf();
  const send = useSendCredit();
  const [open, setOpen] = React.useState(false);
  const canCredit = sale.status === "finalised" && sale.lines.some((l) => l.kind !== "fee" && l.qty - l.credited.qty > 0.0005);
  return (
    <Card>
      <CardHeader
        title="Credit notes"
        subtitle="A credit note takes money off the invoice. It does not refund anything or put stock back; those are separate."
        action={
          canCredit ? (
            <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
              New credit note
            </Button>
          ) : null
        }
      />
      {sale.credits.length ? (
        <table className="w-full text-sm">
          <tbody>
            {sale.credits.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2 font-medium">{c.ref}</td>
                <td className="px-4 py-2">{auDate(c.createdAt)}</td>
                <td className="px-4 py-2 text-muted-foreground">{c.reason}</td>
                <td className="tabular px-4 py-2 text-right">{m2(c.total)}</td>
                <td className="px-4 py-2 text-right">
                  <span className="inline-flex items-center gap-2">
                    <PdfButton label="PDF" get={() => pdf.mutateAsync({ creditId: c.id })} />
                    <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate({ creditId: c.id, to: null })}>
                      <Send className="size-4" />
                      {c.sentAt ? "Send again" : "Send"}
                    </Button>
                  </span>
                  {c.sentAt ? <p className="text-xs text-muted-foreground">Sent {auDateTime(c.sentAt)}</p> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No credit notes.</Empty>
      )}
      <div className="px-4 pb-2">
        <ErrorLine error={send.error} />
      </div>
      <CreditModal open={open} sale={sale} onClose={() => setOpen(false)} />
    </Card>
  );
}

function CreditModal({ open, sale, onClose }: { open: boolean; sale: Sale; onClose: () => void }) {
  const create = useCreateCredit();
  const [reason, setReason] = React.useState("");
  const [qty, setQty] = React.useState<Record<number, string>>({});
  const key = React.useRef(newKey());
  React.useEffect(() => {
    if (open) {
      key.current = newKey();
      setQty({});
      setReason("");
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [open]);
  const lines = sale.lines.filter((l) => l.kind !== "fee");
  const picked = Object.entries(qty)
    .map(([id, v]) => ({ saleLineId: Number(id), qty: Number(v) }))
    .filter((x) => x.qty > 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title="New credit note"
      subtitle="Pick what is credited. A product's fees are credited with it, pro rata. Numbered after the invoice, e.g. S188000-2."
      footer={
        <Foot
          onClose={onClose}
          busy={create.isPending}
          ok={!!reason.trim() && picked.length > 0}
          label="Create credit note"
          onSave={async () => {
            await create.mutateAsync({ saleId: sale.id, reason: reason.trim(), lines: picked, key: key.current });
            onClose();
          }}
        />
      }
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="th py-1.5 text-left">Line</th>
            <th className="th py-1.5 text-right">Sold</th>
            <th className="th py-1.5 text-right">Credited</th>
            <th className="th py-1.5 text-right">Credit now</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const left = Math.max(0, l.qty - l.credited.qty);
            return (
              <tr key={l.id} className="border-b border-border last:border-0">
                <td className="py-1.5">
                  {l.description} <span className="text-muted-foreground">{l.detail}</span>
                </td>
                <td className="tabular py-1.5 text-right">
                  {qtyText(l.qty)} {l.unitLabel || l.sellUnit}
                </td>
                <td className="tabular py-1.5 text-right">{qtyText(l.credited.qty)}</td>
                <td className="py-1.5 text-right">
                  <Input
                    className="ml-auto w-20 text-right"
                    type="number"
                    step="any"
                    min={0}
                    max={left}
                    disabled={left <= 0}
                    value={qty[l.id] ?? ""}
                    onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Field label="Reason (on the credit note)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={create.error} />
    </Modal>
  );
}

/* ---------------------------------- goods ---------------------------------- */

export function GoodsCard({ sale }: { sale: Sale }) {
  const fulfil = useFulfil();
  const switchIt = useSetFulfilmentMethod();
  const [method, setMethod] = React.useState<"collected" | "dispatched">("collected");
  const [override, setOverride] = React.useState<string | null>(null);
  const [ret, setRet] = React.useState<number | null>(null);
  const f = sale.fulfilment;
  const short = fulfil.error && /Not enough stock/.test(String((fulfil.error as { message?: string }).message ?? ""));
  const products = sale.lines.filter((l) => l.kind === "product");

  return (
    <Card>
      <CardHeader
        title="Goods"
        subtitle="One collection or dispatch per sale. It takes the stock off once. Collected or dispatched is a label and can be switched without touching stock."
      />
      <div className="flex flex-col gap-3 p-4">
        {f ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge colour="#2E6B4F">{f.method === "collected" ? "Collected" : "Dispatched"}</Badge>
            <span className="text-muted-foreground">
              {f.byName}, {auDateTime(f.createdAt)}
            </span>
            {f.stockOverrideReason ? <span className="text-[var(--warning)]">Below zero override: {f.stockOverrideReason}</span> : null}
            <Button size="sm" variant="ghost" disabled={switchIt.isPending} onClick={() => switchIt.mutate({ saleId: sale.id, method: f.method === "collected" ? "dispatched" : "collected" })}>
              Change to {f.method === "collected" ? "dispatched" : "collected"}
            </Button>
          </div>
        ) : sale.status === "finalised" ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Goods went out by">
              <Select value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                <option value="collected">Collected</option>
                <option value="dispatched">Dispatched</option>
              </Select>
            </Field>
            <Button size="sm" disabled={fulfil.isPending} onClick={() => fulfil.mutate({ saleId: sale.id, method })}>
              {fulfil.isPending ? <Spinner /> : null}
              Mark {method}
            </Button>
          </div>
        ) : null}
        <ErrorLine error={fulfil.error ?? switchIt.error} />
        {short ? (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
            <Field label="Admin override: why it can go below zero">
              <Input className="w-80" value={override ?? ""} onChange={(e) => setOverride(e.target.value)} />
            </Field>
            <Button size="sm" variant="destructive" disabled={!override?.trim() || fulfil.isPending} onClick={() => fulfil.mutate({ saleId: sale.id, method, overrideReason: override!.trim() })}>
              Let it go below zero
            </Button>
            <p className="w-full text-xs text-muted-foreground">Your name, the time and the reason are kept, and the product is flagged until a count fixes it.</p>
          </div>
        ) : null}
        {f && products.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th py-1.5 text-left">Product</th>
                <th className="th py-1.5 text-right">Went out</th>
                <th className="th py-1.5 text-right">Returned</th>
                <th aria-hidden="true" className="th py-1.5" />
              </tr>
            </thead>
            <tbody>
              {products.map((l) => (
                <tr key={l.id} className="border-b border-border last:border-0">
                  <td className="py-1.5">
                    {l.description} <span className="text-muted-foreground">{l.detail}</span>
                  </td>
                  <td className="tabular py-1.5 text-right">
                    {qtyText(l.qty)} {l.unitLabel || l.sellUnit}
                  </td>
                  <td className="tabular py-1.5 text-right">{qtyText(l.returnedQty)}</td>
                  <td className="py-1.5 text-right">
                    {l.qty - l.returnedQty > 0.0005 ? (
                      <Button size="sm" variant="ghost" onClick={() => setRet(l.id)}>
                        Record return
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {sale.returns.length ? (
          <ul className="text-xs text-muted-foreground">
            {sale.returns.map((r) => (
              <li key={r.id}>
                {auDateTime(r.createdAt)}: {qtyText(r.qty)} back on line {sale.lines.find((l) => l.id === r.saleLineId)?.description ?? r.saleLineId}. {r.reason} ({r.byName})
              </li>
            ))}
          </ul>
        ) : null}
        {f ? <p className="text-xs text-muted-foreground">A return puts stock back only. Credit the money with a credit note if needed.</p> : null}
      </div>
      <ReturnModal sale={sale} lineId={ret} onClose={() => setRet(null)} />
    </Card>
  );
}

function ReturnModal({ sale, lineId, onClose }: { sale: Sale; lineId: number | null; onClose: () => void }) {
  const rec = useRecordReturn();
  const line = sale.lines.find((l) => l.id === lineId);
  const [qty, setQty] = React.useState("");
  const [reason, setReason] = React.useState("");
  const key = React.useRef(newKey());
  React.useEffect(() => {
    if (lineId) {
      key.current = newKey();
      setQty("");
      setReason("");
      rec.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per open
  }, [lineId]);
  const left = line ? Math.max(0, line.qty - line.returnedQty) : 0;
  const n = Number(qty);
  return (
    <Modal
      open={!!line}
      onClose={onClose}
      title="Record a return"
      subtitle={line ? `${line.description}. Up to ${qtyText(left)} ${line.unitLabel || line.sellUnit} can come back.` : ""}
      footer={
        <Foot
          onClose={onClose}
          busy={rec.isPending}
          ok={n > 0 && n <= left + 0.0005 && !!reason.trim()}
          label="Record return"
          onSave={async () => {
            await rec.mutateAsync({ saleId: sale.id, saleLineId: line!.id, qty: n, reason: reason.trim(), key: key.current });
            onClose();
          }}
        />
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Quantity back">
          <Input type="number" step="any" min={0} max={left} value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Why">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <ErrorLine error={rec.error} />
    </Modal>
  );
}

export function BuyerLink({ sale }: { sale: Sale }) {
  const href = sale.buyer.kind === "installer" ? "/team" : sale.buyer.kind === "company" ? `/companies/${sale.buyer.refId}` : `/clients/${sale.buyer.refId}`;
  return (
    <Link href={href} className="text-[var(--gold-deep)] hover:underline">
      {sale.buyer.name}
    </Link>
  );
}
