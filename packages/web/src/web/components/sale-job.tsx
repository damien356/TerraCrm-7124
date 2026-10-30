import * as React from "react";
import { BookOpen, Send, ShoppingCart } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { unitLabel } from "./quote-pickers";
import { useSendMessage } from "../queries/conversations";
import { useCareGuideDraft, useCareGuides, useSaleForJob, useSetStockAndOrder, type CareDraft } from "../queries/productSales";

/* ---------------------------------------------------------------------------
 * On the job of a product sale (Damien, 30 Oct):
 * - Stock and ordering: change "From stock now" and draft POs for the rest.
 *   Nothing already on order is ordered again. Drafts only, never sent.
 * - Send a care guide by hand. Supply only jobs get no automatic care emails,
 *   so the office picks a guide, fixes the install wording and sends it
 *   through the job's conversation like any other email.
 * ------------------------------------------------------------------------- */

const qtyText = (n: number, unit: string) => `${Number(n.toFixed(4))} ${unitLabel(unit)}`;

/**
 * Raise invoice now saves the lines as a quote and marks it accepted inside Ops
 * so the invoice has something to bill from. It was never sent and the customer
 * never accepted it (Damien, 31 Oct, job 188054).
 */
export const priceRecordText = (invoiceNumber: string | null | undefined) =>
  `Internal price record for invoice ${invoiceNumber ?? "raised with Sell products"}, not a customer acceptance.`;

export function SaleOrderCard({ jobId }: { jobId: number }) {
  const q = useSaleForJob(jobId);
  const order = useSetStockAndOrder();
  const [stock, setStock] = React.useState<Record<number, string>>({});
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const sale = q.data;

  // Reset only when the saved numbers change, not on every refetch while typing.
  const saved = sale ? JSON.stringify(sale.plan.map((l) => [l.lineId, l.fromStock])) : "";
  React.useEffect(() => {
    if (!saved) return;
    setStock(Object.fromEntries((JSON.parse(saved) as [number, number][]).map(([id, v]) => [id, String(v)])));
  }, [saved]);

  if (!sale || !sale.plan.length) return null;
  const want = (lineId: number, qty: number) => {
    const v = Number(stock[lineId] ?? "0");
    return Math.max(0, qty - (Number.isFinite(v) ? Math.min(qty, Math.max(0, v)) : 0));
  };
  const toOrder = sale.plan.map((l) => ({ l, more: Math.max(0, want(l.lineId, l.qty) - l.onOrder) })).filter((x) => x.more > 0.00005);

  async function go() {
    setMsg(null);
    for (const l of sale!.plan) {
      const v = Number(stock[l.lineId] ?? "0");
      if (!Number.isFinite(v) || v < 0) return setMsg({ ok: false, text: `"${l.description}": From stock now must be 0 or more.` });
      if (v > l.qty) return setMsg({ ok: false, text: `"${l.description}": From stock now is more than the ${qtyText(l.qty, l.unit)} sold.` });
    }
    try {
      const out = await order.mutateAsync({ jobId, fromStock: sale!.plan.map((l) => ({ lineId: l.lineId, qty: Number(stock[l.lineId] ?? "0") })) });
      setMsg({
        ok: true,
        text: out.added.length
          ? `Put on Materials to order: ${out.added.join("; ")}.${out.drafted.length ? ` Draft POs ${out.drafted.join(", ")}. Not sent.` : " No PO drafted, see the Purchase orders card."}`
          : "Nothing new to order. Everything is covered by stock or an existing order.",
      });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Card>
      <CardHeader
        title="Stock and ordering"
        subtitle={`Product sale, ${sale.salesCategory === "installer_materials" ? "installer materials" : "customer sale"}. ${sale.orderNeeded ? "Ordering is on." : "\"We need to order this\" was not ticked when it was sold. Draft POs below if it has to come from a supplier."}`}
      />
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full text-sm" data-testid="sale-plan">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border text-left">
              <th className="py-1.5 pr-2 font-medium">Line</th>
              <th className="py-1.5 pr-2 text-right font-medium">Sold</th>
              <th className="py-1.5 pr-2 text-right font-medium">From stock now</th>
              <th className="py-1.5 pr-2 text-right font-medium">On order</th>
              <th className="py-1.5 text-right font-medium">Still to order</th>
            </tr>
          </thead>
          <tbody>
            {sale.plan.map((l) => {
              const left = Math.max(0, want(l.lineId, l.qty) - l.onOrder);
              return (
                <tr key={l.lineId} className="border-b border-border align-top">
                  <td className="py-1.5 pr-2">
                    {l.description}
                    {l.pos.length ? <span className="block text-xs text-muted-foreground">{l.pos.map((p) => `${p.number} (${p.status})`).join(", ")}</span> : null}
                  </td>
                  <td className="tabular py-1.5 pr-2 text-right">{qtyText(l.qty, l.unit)}</td>
                  <td className="py-1.5 pr-2 text-right">
                    <Input
                      className="tabular ml-auto w-20 text-right"
                      inputMode="decimal"
                      value={stock[l.lineId] ?? ""}
                      onChange={(e) => setStock((s) => ({ ...s, [l.lineId]: e.target.value }))}
                      aria-label={`${l.description} from stock now`}
                      disabled={!sale.quoteAccepted}
                    />
                  </td>
                  <td className="tabular py-1.5 pr-2 text-right">{l.onOrder > 0 ? qtyText(l.onOrder, l.unit) : "none"}</td>
                  <td className="tabular py-1.5 text-right">{left > 0.00005 ? qtyText(left, l.unit) : "none"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Ops keeps no stock counts. Type what comes off the shelf. Only the rest is ordered, less anything already on order. A smaller "From stock now" never cancels an order.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          {!sale.quoteAccepted ? <span className="text-xs text-muted-foreground">Order once the quote is accepted.</span> : <span />}
          <Button size="sm" onClick={go} disabled={!sale.quoteAccepted || order.isPending || !toOrder.length} data-testid="sale-order">
            {order.isPending ? <Spinner className="border-white/40 border-t-white" /> : <ShoppingCart className="size-3.5" />}
            {toOrder.length ? `Draft POs for ${toOrder.length} line${toOrder.length === 1 ? "" : "s"}` : "Nothing to order"}
          </Button>
        </div>
        {msg ? <p className={`mt-2 text-xs ${msg.ok ? "text-[var(--success)]" : "text-destructive"}`}>{msg.text}</p> : null}
      </div>
    </Card>
  );
}

/* ------------------------------ care guide ------------------------------- */

function CareGuideModal({ jobId, open, onClose, onSent }: { jobId: number; open: boolean; onClose: () => void; onSent: (msg: string) => void }) {
  const guides = useCareGuides(open);
  const draft = useCareGuideDraft();
  const send = useSendMessage();
  const [code, setCode] = React.useState("");
  const [d, setD] = React.useState<CareDraft | null>(null);
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setCode("");
    setD(null);
    setSubject("");
    setBody("");
    setError(null);
  }, [open]);

  if (!open) return null;
  const busy = draft.isPending || send.isPending;
  const stillFlagged = d ? d.flagged.filter((s) => body.includes(s)) : [];

  async function fill(c: string) {
    setCode(c);
    setError(null);
    if (!c) return setD(null);
    try {
      const out = await draft.mutateAsync({ jobId, code: c });
      setD(out);
      setSubject(out.subject);
      setBody(out.body);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function go() {
    if (!d) return;
    setError(null);
    if (!d.to) return setError("There is no email on file for this client. Add one on their card first.");
    if (!subject.trim() || !body.trim()) return setError("The email needs a subject and a message.");
    try {
      await send.mutateAsync({
        jobId,
        audience: "customer",
        channel: "email",
        subject: subject.trim(),
        body: body.trim(),
        contactId: d.contactId,
        ...(d.contactId ? {} : { to: d.to }),
      });
      onSent(`Care guide sent to ${d.toName ?? d.to}. It is in the job's conversation.`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Send a care guide"
      subtitle="Nothing is sent until you press Send. Read it first: these guides were written for installs."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={go} disabled={busy || !d || !d.to} data-testid="care-send">
            {send.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="size-4" />}
            {d?.to ? `Send to ${d.to}` : "Send"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Care guide">
          <Select value={code} onChange={(e) => fill(e.target.value)} disabled={busy} aria-label="Care guide">
            <option value="">Pick one</option>
            {(guides.data ?? []).map((g) => (
              <option key={g.code} value={g.code}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
        {draft.isPending ? <Spinner /> : null}
        {d ? (
          <>
            {stillFlagged.length ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="care-flagged">
                <p className="font-medium">
                  {stillFlagged.length} sentence{stillFlagged.length === 1 ? " talks" : "s talk"} about an install. This sale had none, so change or remove {stillFlagged.length === 1 ? "it" : "them"}:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {stillFlagged.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            ) : d.flagged.length ? (
              <p className="text-xs text-[var(--success)]">Install wording removed.</p>
            ) : null}
            <Field label="Subject">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
            </Field>
            <Field label="Message" hint="Plain text. The signature is already at the bottom.">
              <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

export function CareGuideButton({ jobId, onSent }: { jobId: number; onSent: (msg: string) => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="care-guide">
        <BookOpen className="size-3.5" />
        Send a care guide
      </Button>
      <CareGuideModal jobId={jobId} open={open} onClose={() => setOpen(false)} onSent={onSent} />
    </>
  );
}
