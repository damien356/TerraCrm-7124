import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Send, XCircle } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { DraftEditor, type Sale, type SaleLine } from "../components/trade/sale-draft";
import { BuyerLink, CreditsCard, GoodsCard, MoneyCard } from "../components/trade/sale-money";
import { OffsetsCard } from "../components/trade/sale-offsets";
import { ErrorLine, OffsetBadge, PdfButton, SaleState, auDate, auDateTime, errText, m2, qtyText } from "../components/trade/shared";
import { useCancelSale, useInvoicePdf, useSendInvoice, useTradeSale } from "../queries/trade";

/**
 * One trade sale (notes 18.65). Admin only. A draft is edited here; once
 * finalised the lines are frozen and the money, goods, credit notes and
 * offsets are recorded against it. Nothing is ever deleted.
 */
export default function TradeSalePage() {
  const params = useParams<{ id: string }>();
  const saleId = Number(params.id);
  const q = useTradeSale(saleId);

  if (!Number.isInteger(saleId) || saleId <= 0) return <Page title="Trade sale"><Empty>That sale does not exist.</Empty></Page>;
  if (q.isLoading) return <Page title="Trade sale"><Loading /></Page>;
  if (q.error || !q.data) {
    return (
      <Page title="Trade sale">
        <Card>
          <Empty>{q.error ? errText(q.error) : "That sale does not exist."}</Empty>
        </Card>
      </Page>
    );
  }
  return <SaleBody sale={q.data} />;
}

function SaleBody({ sale }: { sale: Sale }) {
  const pdf = useInvoicePdf();
  const [sending, setSending] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const draft = sale.status === "draft";
  const cancelled = sale.status === "cancelled";
  const state = cancelled ? "cancelled" : draft ? "draft" : sale.money.state;
  const openOffset = sale.offsets.find((o) => o.status === "proposed" || o.status === "approved" || o.status === "confirmed");

  return (
    <Page
      title={sale.invoiceRef ?? sale.ref}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-2">
          <BuyerLink sale={sale} />
          <span className="text-muted-foreground">{sale.buyer.kind === "installer" ? "installer" : sale.buyer.kind === "company" ? "company" : "contact"}</span>
          <SaleState state={state} />
          {openOffset ? <OffsetBadge status={openOffset.status} /> : null}
          {sale.settleBy === "deduct" ? <Badge colour="#4A7FA5">Off their bill</Badge> : null}
        </span>
      }
      actions={
        <>
          <Link href="/finance/trade">
            <Button variant="outline" size="sm">
              <ArrowLeft className="size-4" />
              All sales
            </Button>
          </Link>
          {!draft ? <PdfButton label="Invoice PDF" get={() => pdf.mutateAsync({ saleId: sale.id })} /> : null}
          {sale.status === "finalised" ? (
            <Button size="sm" onClick={() => setSending(true)}>
              <Send className="size-4" />
              Send invoice
            </Button>
          ) : null}
          {!cancelled ? (
            <Button variant="outline" size="sm" onClick={() => setCancelling(true)}>
              <XCircle className="size-4" />
              Cancel sale
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Facts sale={sale} />
        {draft ? (
          <DraftEditor sale={sale} />
        ) : (
          <>
            <ReadLines sale={sale} />
            {!cancelled ? (
              <>
                <MoneyCard sale={sale} />
                <GoodsCard sale={sale} />
                <CreditsCard sale={sale} />
                {sale.buyer.kind === "installer" ? <OffsetsCard sale={sale} /> : null}
              </>
            ) : null}
          </>
        )}
        <Audit sale={sale} />
      </div>
      {sending ? <SendModal sale={sale} onClose={() => setSending(false)} /> : null}
      {cancelling ? <CancelModal sale={sale} onClose={() => setCancelling(false)} /> : null}
    </Page>
  );
}

function Facts({ sale }: { sale: Sale }) {
  const items: Array<[string, React.ReactNode]> = [];
  if (sale.bill.name) items.push(["Bill to", sale.bill.name]);
  if (sale.bill.abn) items.push(["ABN", sale.bill.abn]);
  if (sale.bill.email) items.push(["Email", sale.bill.email]);
  if (sale.finalisedAt) items.push(["Finalised", `${auDateTime(sale.finalisedAt)}${sale.finalisedByName ? ` by ${sale.finalisedByName}` : ""}`]);
  if (sale.status !== "draft") {
    items.push([
      "Terms",
      sale.terms.payBeforeCollection ? "Pay before collection" : sale.terms.dueDate ? `${sale.terms.termsDays} days, due ${auDate(sale.terms.dueDate)}` : `${sale.terms.termsDays} days`,
    ]);
  }
  if (sale.sentAt) items.push(["Sent", `${auDateTime(sale.sentAt)}${sale.sentTo ? ` to ${sale.sentTo}` : ""}`]);
  if (sale.cancelledAt) items.push(["Cancelled", `${auDateTime(sale.cancelledAt)}${sale.cancelledByName ? ` by ${sale.cancelledByName}` : ""}. ${sale.cancelReason ?? ""}`]);
  if (!items.length) return null;
  return (
    <Card>
      <dl className="grid gap-x-6 gap-y-2 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The frozen invoice lines, laid out the way the buyer's invoice shows fees. */
function ReadLines({ sale }: { sale: Sale }) {
  const combined = sale.feePresentation === "combined";
  const products = sale.lines.filter((l) => l.kind === "product");
  const fees = sale.lines.filter((l) => l.kind === "fee");
  const delivery = sale.lines.filter((l) => l.kind === "delivery");
  const feesOf = (id: number) => fees.filter((f) => f.parentLineId === id);
  const feeEx = fees.reduce((a, f) => a + f.lineExGst, 0);
  const feeGst = fees.reduce((a, f) => a + f.gstAmount, 0);

  return (
    <Card>
      <CardHeader
        title="Invoice lines"
        subtitle={`Frozen when finalised. Markup ${qtyText(sale.markupPct)}%. Fees ${combined ? 'shown as one "Freight and levies" line' : "shown under each product"}; the total is the same either way.`}
      />
      {products.length || delivery.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4 py-2 text-left">Item</th>
                <th className="th px-3 py-2 text-right">Qty</th>
                <th className="th px-3 py-2 text-left">Unit</th>
                <th className="th px-3 py-2 text-right">Rate ex GST</th>
                <th className="th px-3 py-2 text-right">Ex GST</th>
                <th className="th px-3 py-2 text-right">GST</th>
                <th className="th px-3 py-2 text-right">Credited</th>
              </tr>
            </thead>
            <tbody>
              {products.map((l) => (
                <React.Fragment key={l.id}>
                  <LineRow line={l} />
                  {!combined
                    ? feesOf(l.id).map((f) => <LineRow key={f.id} line={f} fee />)
                    : null}
                </React.Fragment>
              ))}
              {combined && fees.length ? (
                <tr className="border-b border-border">
                  <td className="px-4 py-2">Freight and levies</td>
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <td className="tabular px-3 py-2 text-right">{m2(feeEx)}</td>
                  <td className="tabular px-3 py-2 text-right">{m2(feeGst)}</td>
                  <td aria-hidden="true" />
                </tr>
              ) : null}
              {delivery.map((l) => (
                <LineRow key={l.id} line={l} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4} className="px-4 pt-3 text-right text-muted-foreground">
                  Subtotal ex GST
                </td>
                <td className="tabular px-3 pt-3 text-right">{m2(sale.subtotal)}</td>
                <td aria-hidden="true" />
                <td aria-hidden="true" />
              </tr>
              <tr>
                <td colSpan={4} className="px-4 text-right text-muted-foreground">
                  GST
                </td>
                <td className="tabular px-3 text-right">{m2(sale.gst)}</td>
                <td aria-hidden="true" />
                <td aria-hidden="true" />
              </tr>
              <tr>
                <td colSpan={4} className="px-4 pb-3 text-right font-bold">
                  Total inc GST
                </td>
                <td className="tabular px-3 pb-3 text-right font-bold">{m2(sale.total)}</td>
                <td aria-hidden="true" />
                <td aria-hidden="true" />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <Empty>No lines.</Empty>
      )}
      {sale.notes ? <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground">Notes: {sale.notes}</p> : null}
    </Card>
  );
}

function LineRow({ line, fee }: { line: SaleLine; fee?: boolean }) {
  const how =
    line.kind === "fee"
      ? `fee ${m2(line.feeCostExGst)} plus ${qtyText(line.markupPct)}%`
      : line.kind === "delivery"
        ? "delivery, typed"
        : line.priceSource === "override"
          ? "fixed trade price"
          : line.priceSource === "typed"
            ? `typed price${line.typedReason ? `: ${line.typedReason}` : ""}`
            : line.standardCostExGst != null
              ? `cost ${m2(line.costPerSellUnit ?? line.standardCostExGst)} plus ${qtyText(line.markupPct)}%`
              : "";
  return (
    <tr className={`border-b border-border ${fee ? "text-muted-foreground" : ""}`}>
      <td className={`py-2 pr-4 ${fee ? "pl-8" : "pl-4"}`}>
        <div>{line.description}</div>
        {line.detail ? <div className="text-xs text-muted-foreground">{line.detail}</div> : null}
        {how ? <div className="text-xs text-muted-foreground">{how}</div> : null}
        {line.returnedQty ? <div className="text-xs text-muted-foreground">Returned {qtyText(line.returnedQty)}</div> : null}
      </td>
      <td className="tabular px-3 py-2 text-right">{qtyText(line.qty)}</td>
      <td className="px-3 py-2">{line.unitLabel || line.sellUnit}</td>
      <td className="tabular px-3 py-2 text-right">{m2(line.unitPriceExGst)}</td>
      <td className="tabular px-3 py-2 text-right">{m2(line.lineExGst)}</td>
      <td className="tabular px-3 py-2 text-right">{m2(line.gstAmount)}</td>
      <td className="tabular px-3 py-2 text-right">{line.credited.inc ? m2(line.credited.inc) : ""}</td>
    </tr>
  );
}

function Audit({ sale }: { sale: Sale }) {
  const [all, setAll] = React.useState(false);
  const rows = all ? sale.audit : sale.audit.slice(0, 12);
  return (
    <Card>
      <CardHeader title="History" subtitle="Every change on this sale, newest first. Nothing here is ever deleted." />
      {rows.length ? (
        <ul className="divide-y divide-border text-sm">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap justify-between gap-2 px-4 py-2">
              <span>{a.detail || a.action.replace(/_/g, " ")}</span>
              <span className="text-xs text-muted-foreground">
                {auDateTime(a.createdAt)}
                {a.actorName ? ` by ${a.actorName}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>Nothing yet.</Empty>
      )}
      {sale.audit.length > 12 && !all ? (
        <div className="border-t border-border p-3">
          <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
            Show all {sale.audit.length}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function SendModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const send = useSendInvoice();
  const [to, setTo] = React.useState(sale.bill.email ?? "");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Send ${sale.invoiceRef ?? sale.ref}`}
      subtitle="Emails the PDF. If money is owing and card payments are on, it carries the Pay by card link."
      footer={
        send.isSuccess ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={send.isPending || !to.trim()} onClick={() => send.mutate({ saleId: sale.id, to: to.trim() || null })}>
              {send.isPending ? <Spinner /> : <Send className="size-4" />}
              Send
            </Button>
          </>
        )
      }
    >
      {send.isSuccess ? (
        <p className="text-sm">Sent to {send.data.to}.</p>
      ) : (
        <Field label="Send to">
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      )}
      <ErrorLine error={send.error} />
    </Modal>
  );
}

function CancelModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const cancel = useCancelSale();
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel ${sale.invoiceRef ?? sale.ref}`}
      subtitle={
        sale.status === "draft"
          ? "The draft is kept, marked cancelled."
          : "Only possible before any money, offset, credit or goods are recorded. Otherwise use a credit note. The invoice is kept, marked cancelled."
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={cancel.isPending || !reason.trim()}
            onClick={() => cancel.mutate({ saleId: sale.id, reason: reason.trim() }, { onSuccess: onClose })}
          >
            {cancel.isPending ? <Spinner /> : null}
            Cancel sale
          </Button>
        </>
      }
    >
      <Field label="Why">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <ErrorLine error={cancel.error} />
    </Modal>
  );
}
