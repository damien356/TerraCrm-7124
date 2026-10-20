import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/field";
import { Modal } from "../ui/modal";
import { useDebounced } from "../quote-pickers";
import { useEditDraft, useFinalise, useLastPrices, useTradeProducts, useTradeSale } from "../../queries/trade";
import { ErrorLine, auDate, errText, m2, qtyText } from "./shared";

export type Sale = NonNullable<ReturnType<typeof useTradeSale>["data"]>;
export type SaleLine = Sale["lines"][number];

/**
 * The draft. Every change goes to the server, which reprices the draft from
 * the price book and returns it. Nothing priced here is final until Finalise,
 * which snapshots the rates, fees, units, GST and terms onto the invoice.
 */
export function DraftEditor({ sale }: { sale: Sale }) {
  const edit = useEditDraft();
  const fin = useFinalise();
  const product = sale.lines.filter((l) => l.kind === "product");
  const delivery = sale.lines.filter((l) => l.kind === "delivery");
  const feesOf = (id: number) => sale.lines.filter((l) => l.kind === "fee" && l.parentLineId === id);
  const issueOf = (id: number) => sale.issues.filter((i) => i.lineId === id);
  const general = sale.issues.filter((i) => !i.lineId || !sale.lines.some((l) => l.id === i.lineId));
  const change = (c: Parameters<typeof edit.mutate>[0]["change"]) => edit.mutate({ saleId: sale.id, change: c });
  const [notes, setNotes] = React.useState(sale.notes ?? "");

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Lines"
          subtitle={`Rates ex GST per selling unit. Trade markup ${qtyText(sale.markupPct)}% on standard cost, once on each fee. A fixed trade price is used as is.`}
        />
        {product.length || delivery.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4 py-2 text-left">Item</th>
                  <th className="th px-3 py-2 text-right">Qty</th>
                  <th className="th px-3 py-2 text-left">Unit</th>
                  <th className="th px-3 py-2 text-right">Rate</th>
                  <th className="th px-3 py-2 text-right">Disc %</th>
                  <th className="th px-3 py-2 text-right">Ex GST</th>
                  <th className="th px-3 py-2 text-right">GST</th>
                  <th aria-hidden="true" className="th px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {product.map((l) => (
                  <React.Fragment key={l.id}>
                    <ProductLineRow line={l} busy={edit.isPending} onChange={change} issues={issueOf(l.id).map((i) => i.message)} />
                    {feesOf(l.id).map((f) => (
                      <tr key={f.id} className="border-b border-border text-muted-foreground">
                        <td className="py-1.5 pl-8 pr-4">
                          {f.description}
                          <span className="ml-1.5 text-xs">
                            fee {m2(f.feeCostExGst)} plus {qtyText(f.markupPct)}%
                          </span>
                        </td>
                        <td className="tabular px-3 py-1.5 text-right">{qtyText(f.qty)}</td>
                        <td className="px-3 py-1.5">{f.unitLabel || f.sellUnit}</td>
                        <td className="tabular px-3 py-1.5 text-right">{m2(f.unitPriceExGst)}</td>
                        <td aria-hidden="true" />
                        <td className="tabular px-3 py-1.5 text-right">{m2(f.lineExGst)}</td>
                        <td className="tabular px-3 py-1.5 text-right">{m2(f.gstAmount)}</td>
                        <td aria-hidden="true" />
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                {delivery.map((l) => (
                  <DeliveryRow key={l.id} line={l} busy={edit.isPending} onChange={change} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No lines yet. Add a product below.</Empty>
        )}
        <div className="border-t border-border p-4">
          <AddProduct sale={sale} busy={edit.isPending} onAdd={(productId, qty) => change({ op: "add", productId, qty })} />
          <AddDelivery busy={edit.isPending} onAdd={(description, amountExGst) => change({ op: "delivery", description, amountExGst })} />
          <ErrorLine error={edit.error} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Before you finalise" />
        <div className="flex flex-col gap-3 p-4">
          {sale.buyer.kind === "installer" ? (
            <Field label="How it is settled">
              <Select value={sale.settleBy} disabled={edit.isPending} onChange={(e) => change({ op: "settle", settleBy: e.target.value as "pay" | "deduct" })}>
                <option value="pay">Buyer pays</option>
                <option value="deduct">Take it off their bill (needs same entity check and a signed agreement)</option>
              </Select>
            </Field>
          ) : null}
          <Field label="Notes on the invoice">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (sale.notes ?? "") && change({ op: "notes", notes })} />
          </Field>
          <p className="text-sm text-muted-foreground">
            Terms when finalised:{" "}
            {sale.buyer.creditApproved ? `${sale.buyer.termsDays || 7} days (credit approved)` : "pay before collection, unless you record an arrangement after finalising"}. Fees show{" "}
            {sale.buyer.feePresentation === "combined" ? 'as one "Freight and levies" line' : "under each product"}.
          </p>
          {general.length ? (
            <ul className="list-disc pl-5 text-sm text-destructive">
              {general.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
            </ul>
          ) : null}
          {sale.issues.length > general.length ? (
            <p className="text-sm text-destructive">{sale.issues.length - general.length} line(s) above need fixing before this can be finalised.</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={fin.isPending || !!sale.issues.length || !sale.lines.some((l) => l.kind === "product")}
              onClick={() => fin.mutate({ saleId: sale.id, rev: sale.rev })}
            >
              {fin.isPending ? <Spinner /> : null}
              Finalise {m2(sale.total)}
            </Button>
            <span className="text-xs text-muted-foreground">Gives it the next invoice number and fixes every figure. After this, changes are credit notes.</span>
          </div>
          <ErrorLine error={fin.error} />
        </div>
      </Card>
    </div>
  );
}

type Change = Parameters<ReturnType<typeof useEditDraft>["mutate"]>[0]["change"];

function ProductLineRow({ line, busy, onChange, issues }: { line: SaleLine; busy: boolean; onChange: (c: Change) => void; issues: string[] }) {
  const [qty, setQty] = React.useState(String(line.qty));
  const [disc, setDisc] = React.useState(String(line.discountPct || 0));
  const [typing, setTyping] = React.useState(false);
  React.useEffect(() => {
    setQty(String(line.qty));
    setDisc(String(line.discountPct || 0));
  }, [line.qty, line.discountPct]);
  const typed = line.priceSource === "typed";
  const save = (over?: { typedPrice: number | null; typedReason: string | null }) =>
    onChange({
      op: "update",
      lineId: line.id,
      qty: Number(qty) || 0,
      discountPct: Number(disc) || 0,
      typedPrice: over ? over.typedPrice : typed ? line.unitPriceExGst : null,
      typedReason: over ? over.typedReason : typed ? line.typedReason : null,
    });
  const dirty = Number(qty) !== line.qty || (Number(disc) || 0) !== (line.discountPct || 0);

  return (
    <>
      <tr className={`border-b border-border ${issues.length ? "bg-destructive/5" : ""}`}>
        <td className="px-4 py-2">
          <span className="font-medium">{line.description}</span>
          {line.detail ? <span className="ml-1.5 text-muted-foreground">{line.detail}</span> : null}
          <span className="ml-2 inline-flex gap-1 align-middle">
            {line.priceSource === "override" ? <Badge colour="#4A7FA5">Fixed trade price</Badge> : null}
            {typed ? <Badge colour="#C08A24">Typed price</Badge> : null}
            {line.onHand != null ? <span className="text-xs text-muted-foreground">on hand {qtyText(line.onHand)}</span> : null}
          </span>
          {typed && line.typedReason ? <p className="text-xs text-muted-foreground">Reason: {line.typedReason}</p> : null}
          {issues.map((m, n) => (
            <p key={n} className="text-xs text-destructive">
              {m}
            </p>
          ))}
        </td>
        <td className="px-3 py-2 text-right">
          <Input className="w-20 text-right" type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} onBlur={() => dirty && save()} />
        </td>
        <td className="px-3 py-2">{line.unitLabel || line.sellUnit}</td>
        <td className="tabular px-3 py-2 text-right">
          <button type="button" className="hover:underline" title="Type a price for this sale" onClick={() => setTyping(true)}>
            {m2(line.unitPriceExGst)}
          </button>
        </td>
        <td className="px-3 py-2 text-right">
          <Input className="w-16 text-right" type="number" step="any" min={0} max={100} value={disc} onChange={(e) => setDisc(e.target.value)} onBlur={() => dirty && save()} />
        </td>
        <td className="tabular px-3 py-2 text-right">{m2(line.lineExGst)}</td>
        <td className="tabular px-3 py-2 text-right">{line.gstRate > 0 ? m2(line.gstAmount) : "GST free"}</td>
        <td className="px-3 py-2 text-right">
          <Button size="sm" variant="ghost" disabled={busy} title="Remove" onClick={() => onChange({ op: "remove", lineId: line.id })}>
            <Trash2 className="size-4" />
          </Button>
        </td>
      </tr>
      <TypedPriceModal
        open={typing}
        line={line}
        onClose={() => setTyping(false)}
        onSave={(p, r) => {
          save({ typedPrice: p, typedReason: r });
          setTyping(false);
        }}
      />
    </>
  );
}

function TypedPriceModal({ open, line, onClose, onSave }: { open: boolean; line: SaleLine; onClose: () => void; onSave: (price: number | null, reason: string | null) => void }) {
  const [price, setPrice] = React.useState("");
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setPrice(line.priceSource === "typed" ? String(line.unitPriceExGst) : "");
      setReason(line.typedReason ?? "");
    }
  }, [open, line]);
  const p = Number(price);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Type a price for this sale"
      subtitle="Ex GST per selling unit, for this line only. The price book is not changed. Fees are still added as their own lines."
      footer={
        <div className="flex justify-between gap-2">
          {line.priceSource === "typed" ? (
            <Button size="sm" variant="ghost" onClick={() => onSave(null, null)}>
              Back to the worked out price
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button size="sm" disabled={price.trim() === "" || !(p >= 0) || !reason.trim()} onClick={() => onSave(p, reason.trim())}>
              Use this price
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Rate ex GST per ${line.unitLabel || line.sellUnit}`}>
          <Input type="number" step="0.01" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label="Reason (kept on the record)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      {line.standardCostExGst != null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Standard cost {m2(line.costPerSellUnit ?? line.standardCostExGst)} per {line.unitLabel || line.sellUnit} ex GST.
        </p>
      ) : null}
    </Modal>
  );
}

function DeliveryRow({ line, busy, onChange }: { line: SaleLine; busy: boolean; onChange: (c: Change) => void }) {
  const [desc, setDesc] = React.useState(line.description);
  const [amt, setAmt] = React.useState(String(line.unitPriceExGst));
  const dirty = desc !== line.description || Number(amt) !== line.unitPriceExGst;
  const save = () => dirty && onChange({ op: "delivery", lineId: line.id, description: desc, amountExGst: Number(amt) || 0 });
  return (
    <tr className="border-b border-border">
      <td className="px-4 py-2">
        <Input value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={save} />
      </td>
      <td className="tabular px-3 py-2 text-right">1</td>
      <td className="px-3 py-2">each</td>
      <td className="px-3 py-2 text-right">
        <Input className="w-24 text-right" type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} onBlur={save} />
      </td>
      <td aria-hidden="true" />
      <td className="tabular px-3 py-2 text-right">{m2(line.lineExGst)}</td>
      <td className="tabular px-3 py-2 text-right">{m2(line.gstAmount)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" variant="ghost" disabled={busy} title="Remove" onClick={() => onChange({ op: "remove", lineId: line.id })}>
          <Trash2 className="size-4" />
        </Button>
      </td>
    </tr>
  );
}

function AddProduct({ sale, busy, onAdd }: { sale: Sale; busy: boolean; onAdd: (productId: number, qty: number) => void }) {
  const [search, setSearch] = React.useState("");
  const term = useDebounced(search);
  const list = useTradeProducts({ search: term || undefined, listedOnly: true, buyerId: sale.buyer.id, limit: 40 }, term.length >= 2);
  const [pick, setPick] = React.useState<NonNullable<typeof list.data>[number] | null>(null);
  const [qty, setQty] = React.useState("1");

  return (
    <div className="flex flex-col gap-2">
      <p className="label-xs">Add a product</p>
      {pick ? (
        <div className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-medium">
                {pick.name} <span className="text-muted-foreground">{pick.detail}</span>
              </p>
              {pick.priced ? (
                <p className="text-sm">
                  {m2(pick.priced.rateExGst)} ex GST per {pick.priced.unitLabel || pick.priced.sellUnit}
                  {pick.priced.feesPerUnit.length ? `, plus ${pick.priced.feesPerUnit.map((f) => `${f.name} ${m2(f.chargeExGst)}`).join(", ")}` : ""}
                  {pick.priced.whole ? ". Whole units only." : ""}
                </p>
              ) : (
                <p className="text-sm text-destructive">{pick.blocked}</p>
              )}
              <p className="text-xs text-muted-foreground">On hand {qtyText(pick.onHand)}</p>
              <LastPrice productId={pick.productId} buyerId={sale.buyer.id} />
            </div>
            <div className="flex items-end gap-2">
              <Field label={`Qty (${pick.priced?.unitLabel || pick.priced?.sellUnit || "units"})`}>
                <Input className="w-24" type="number" step={pick.priced?.whole ? 1 : "any"} min={0} value={qty} onChange={(e) => setQty(e.target.value)} />
              </Field>
              <Button
                size="sm"
                disabled={busy || !pick.priced || !(Number(qty) > 0)}
                onClick={() => {
                  onAdd(pick.productId, Number(qty));
                  setPick(null);
                  setSearch("");
                  setQty("1");
                }}
              >
                <Plus className="size-4" />
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPick(null)}>
                Back
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <Input placeholder="Search the trade list for this buyer" value={search} onChange={(e) => setSearch(e.target.value)} />
          {term.length >= 2 && list.isLoading ? <Loading /> : null}
          {term.length >= 2 && list.data && !list.data.length ? (
            <p className="text-sm text-muted-foreground">Nothing on this buyer&apos;s trade list matches. Check the buyer&apos;s categories and the trade list.</p>
          ) : null}
          {list.data?.length && term.length >= 2 ? (
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border text-sm">
              {list.data.map((p) => (
                <li key={p.productId} className="border-b border-border last:border-0">
                  <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left hover:bg-secondary" onClick={() => setPick(p)}>
                    <span>
                      {p.name} <span className="text-muted-foreground">{p.detail}</span>
                    </span>
                    <span className="tabular text-muted-foreground">
                      {p.priced ? `${m2(p.priced.rateExGst)} / ${p.priced.unitLabel || p.priced.sellUnit}` : <span className="text-destructive">Blocked</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Last price sold, for reference only. Never used to price the line. */
function LastPrice({ productId, buyerId }: { productId: number; buyerId: number }) {
  const q = useLastPrices(productId, buyerId);
  if (!q.data) return null;
  const { thisBuyer, anyBuyer } = q.data;
  if (!thisBuyer && !anyBuyer) return <p className="text-xs text-muted-foreground">Not sold before.</p>;
  const show = (r: NonNullable<typeof thisBuyer>, who: string) =>
    `${who}: ${m2(r.rateExGst)} ex GST per ${r.unitLabel || r.sellUnit}${r.discountPct ? ` less ${qtyText(r.discountPct)}%` : ""} on ${r.ref}, ${auDate(r.date)}`;
  return (
    <div className="text-xs text-muted-foreground">
      {thisBuyer ? <p>{show(thisBuyer, "Last sold to this buyer")}</p> : null}
      {anyBuyer && (!thisBuyer || anyBuyer.ref !== thisBuyer.ref) ? <p>{show(anyBuyer, `Last sold to anyone (${anyBuyer.buyerName})`)}</p> : null}
      <p>Reference only. The rate comes from the price book.</p>
    </div>
  );
}

function AddDelivery({ busy, onAdd }: { busy: boolean; onAdd: (description: string, amount: number) => void }) {
  const [open, setOpen] = React.useState(false);
  const [desc, setDesc] = React.useState("Delivery");
  const [amt, setAmt] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  if (!open)
    return (
      <Button className="mt-3" size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        Delivery line
      </Button>
    );
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <Field label="Delivery (typed by hand, never added automatically)">
        <Input className="w-72" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </Field>
      <Field label="Amount ex GST">
        <Input className="w-28" type="number" step="0.01" value={amt} onChange={(e) => setAmt(e.target.value)} />
      </Field>
      <Button
        size="sm"
        disabled={busy || !desc.trim() || !(Number(amt) > 0)}
        onClick={() => {
          try {
            onAdd(desc.trim(), Number(amt));
            setOpen(false);
            setAmt("");
          } catch (e) {
            setErr(errText(e));
          }
        }}
      >
        Add
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Close
      </Button>
      {err ? <p className="text-sm text-destructive">{err}</p> : null}
    </div>
  );
}
