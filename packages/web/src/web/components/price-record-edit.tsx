import * as React from "react";
import { ArrowLeft, Check, Lock, Pencil, Plus, X } from "lucide-react";
import { Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { ProductFinder, productName, useCanSeeCosts } from "./product-finder";
import { unitLabel } from "./quote-pickers";
import { moneyExact } from "../lib/money";
import type { FoundProduct } from "../queries/productFind";
import {
  useEditPriceRecord,
  usePreviewPriceRecordEdit,
  usePriceRecord,
  type PriceRecord,
  type PriceRecordLineIn,
  type PriceRecordPreview,
} from "../queries/productSales";

/* ---------------------------------------------------------------------------
 * EDIT PRICE RECORD (Damien, 11 Nov 2026, job 188083).
 *
 * Sell products, Raise invoice now, keeps its lines as a price record behind
 * the invoice. While nothing has left Terra (invoice not emailed, not in
 * Xero, nothing paid, every PO still a draft) the lines can change here: qty,
 * price, cost, wording, From stock now, add or remove a line. Preview first,
 * then Save. The invoice keeps its number. Nothing is emailed or sent.
 * ------------------------------------------------------------------------- */

type Line = {
  key: string;
  quoteItemId: number | null;
  productId: number | null;
  name: string;
  detail: string;
  qty: string;
  unit: string;
  price: string;
  /** Blank on a new line means the price book cost. */
  cost: string;
  fromStock: string;
  stocked: boolean;
};

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);
const num = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() !== "" && Number.isFinite(n) ? n : NaN;
};
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const str = (n: number | null | undefined) => (n == null ? "" : String(Number(n.toFixed(4))));

function linesOf(rec: PriceRecord): Line[] {
  return rec.lines.map((l) => ({
    key: `q${l.quoteItemId}`,
    quoteItemId: l.quoteItemId,
    productId: l.productId,
    name: l.description,
    detail: l.detail,
    qty: str(l.qty),
    unit: l.unit,
    price: str(l.unitPrice),
    // A blank cost starts at the price book cost, so Save puts it on (it was blank on every sale before 11 Nov).
    cost: str(l.unitCost ?? l.bookCost),
    fromStock: l.fromStock > 0 ? str(l.fromStock) : "",
    stocked: l.stocked,
  }));
}

function priceOf(p: FoundProduct): string {
  const v = p.passedOnToCustomer && p.sellExGst != null ? p.sellExGst : (p.sellPrice ?? p.sellExGst ?? null);
  return v != null ? String(r2(v)) : "";
}

/** The button for the quote builder banner and the job page. Opens the window, or says why it is locked. */
export function EditPriceRecordButton({ jobId, size = "sm" }: { jobId: number; size?: "sm" | "default" }) {
  const rec = usePriceRecord(jobId);
  const [open, setOpen] = React.useState(false);
  if (!rec.data?.isPriceRecord) return null;
  return (
    <>
      <Button size={size} variant={rec.data.editable ? "default" : "outline"} onClick={() => setOpen(true)} data-testid="edit-price-record">
        {rec.data.editable ? <Pencil className="size-3.5" /> : <Lock className="size-3.5" />}
        Edit price record
      </Button>
      {open ? <PriceRecordModal rec={rec.data} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function PriceRecordModal({ rec, onClose }: { rec: PriceRecord; onClose: () => void }) {
  const canSeeCosts = useCanSeeCosts();
  const preview = usePreviewPriceRecordEdit();
  const save = useEditPriceRecord();
  const [lines, setLines] = React.useState<Line[]>(() => linesOf(rec));
  const [finder, setFinder] = React.useState<FoundProduct | null>(null);
  const [note, setNote] = React.useState("");
  const [step, setStep] = React.useState<"form" | "check" | "done">("form");
  const [shown, setShown] = React.useState<PriceRecordPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [log, setLog] = React.useState("");
  const busy = preview.isPending || save.isPending;
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));

  function payload(): PriceRecordLineIn[] | string {
    if (!lines.length) return "Keep at least one line. To cancel the whole sale, void the invoice instead.";
    const out: PriceRecordLineIn[] = [];
    for (const [i, l] of lines.entries()) {
      const label = l.name.trim() || `Line ${i + 1}`;
      const qty = num(l.qty);
      const price = num(l.price);
      const stock = l.fromStock.trim() === "" ? 0 : num(l.fromStock);
      if (!l.productId && !l.name.trim()) return `Line ${i + 1} needs a description.`;
      if (!(qty > 0)) return `"${label}" needs a quantity over 0.`;
      if (!(price > 0)) return `"${label}" needs a price over $0.`;
      if (!(stock >= 0)) return `"${label}": From stock now must be 0 or more.`;
      if (stock > qty) return `"${label}": From stock now is more than the quantity.`;
      const line: PriceRecordLineIn = {
        quoteItemId: l.quoteItemId,
        productId: l.productId,
        description: l.name.trim(),
        qty,
        unit: l.unit,
        unitPrice: price,
        fromStock: stock,
      };
      if (canSeeCosts) {
        const cost = l.cost.trim() === "" ? null : num(l.cost);
        if (cost != null && !(cost >= 0)) return `"${label}": cost must be $0 or more.`;
        // A new line with a blank cost gets the price book cost on the server.
        if (!(l.quoteItemId == null && cost == null)) line.unitCost = cost;
      }
      out.push(line);
    }
    return out;
  }

  async function check() {
    setError(null);
    const p = payload();
    if (typeof p === "string") return setError(p);
    try {
      setShown(await preview.mutateAsync({ jobId: rec.jobId, lines: p }));
      setStep("check");
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function confirm() {
    setError(null);
    const p = payload();
    if (typeof p === "string" || !shown) return setError(typeof p === "string" ? p : "Check the changes first.");
    try {
      const out = await save.mutateAsync({ jobId: rec.jobId, lines: p, stamp: rec.stamp, expectedTotal: shown.after.total, note: note.trim() || null });
      setLog(out.changed ? out.log : "Nothing changed.");
      setStep("done");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const title = `Edit price record ${rec.quoteRef}`;
  const subtitle = rec.invoice ? `Behind invoice ${rec.invoice.number}, ${moneyExact(rec.invoice.total)} inc GST. Not a customer acceptance.` : "Not a customer acceptance.";

  if (!rec.editable) {
    return (
      <Modal open onClose={onClose} title={title} subtitle={subtitle} footer={<Button onClick={onClose}>Close</Button>} width="max-w-xl">
        <div className="grid gap-2 text-sm" data-testid="price-record-locked">
          <p>This price record can not be changed now:</p>
          <ul className="list-disc pl-5">
            {rec.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">It can be changed while the invoice is not emailed, not in Xero and not paid, and every PO on the job is still a draft.</p>
        </div>
      </Modal>
    );
  }

  const typedTotal = lines.reduce((t, l) => {
    const q = num(l.qty);
    const p = num(l.price);
    return t + (q > 0 && p > 0 ? r2(q * p) : 0);
  }, 0);

  const footer =
    step === "form" ? (
      <>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={check} disabled={busy} data-testid="price-record-check">
          {preview.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
          Check changes
        </Button>
      </>
    ) : step === "check" ? (
      <>
        <Button variant="outline" onClick={() => setStep("form")} disabled={busy}>
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Button onClick={confirm} disabled={busy || !!shown?.nothing} data-testid="price-record-save">
          {save.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Check className="size-4" />}
          Save changes
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>Close</Button>
    );

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={title} subtitle={subtitle} footer={footer} width="max-w-4xl">
      {step === "form" ? (
        <div className="grid gap-3" data-testid="price-record-form">
          <div className="grid gap-2">
            <div className={`hidden gap-2 text-xs font-medium text-muted-foreground sm:grid ${canSeeCosts ? "sm:grid-cols-[1fr_4.5rem_3.5rem_6rem_6rem_5rem_1.75rem]" : "sm:grid-cols-[1fr_4.5rem_3.5rem_6rem_5rem_1.75rem]"}`}>
              <span>Item</span>
              <span className="text-right">Qty</span>
              <span>Unit</span>
              <span className="text-right">Price ex GST</span>
              {canSeeCosts ? <span className="text-right">Cost ex GST</span> : null}
              <span className="text-right">From stock now</span>
              <span />
            </div>
            {lines.map((l, i) => (
              <div
                key={l.key}
                className={`grid grid-cols-2 gap-2 border-b border-border pb-2 sm:items-center ${canSeeCosts ? "sm:grid-cols-[1fr_4.5rem_3.5rem_6rem_6rem_5rem_1.75rem]" : "sm:grid-cols-[1fr_4.5rem_3.5rem_6rem_5rem_1.75rem]"}`}
                data-testid="price-record-line"
              >
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <Input value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} aria-label={`Line ${i + 1} description`} placeholder="Description" />
                  {l.detail || l.stocked || l.quoteItemId == null ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[l.detail, l.stocked ? "usually in the warehouse" : "", l.quoteItemId == null ? "new line" : ""].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Input className="tabular text-right" inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label={`Line ${i + 1} quantity`} />
                {l.productId ? (
                  <span className="text-xs text-muted-foreground">{unitLabel(l.unit)}</span>
                ) : (
                  <Input value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} aria-label={`Line ${i + 1} unit`} />
                )}
                <Input className="tabular text-right" inputMode="decimal" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} aria-label={`Line ${i + 1} price ex GST`} />
                {canSeeCosts ? (
                  <Input
                    className="tabular text-right"
                    inputMode="decimal"
                    placeholder={l.quoteItemId == null && l.productId ? "price book" : "no cost"}
                    value={l.cost}
                    onChange={(e) => setLine(i, { cost: e.target.value })}
                    aria-label={`Line ${i + 1} cost ex GST`}
                  />
                ) : null}
                <Input className="tabular text-right" inputMode="decimal" placeholder="0" value={l.fromStock} onChange={(e) => setLine(i, { fromStock: e.target.value })} aria-label={`Line ${i + 1} from stock now`} />
                <button type="button" className="justify-self-end text-muted-foreground hover:text-foreground" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
                  <X className="size-4" />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((ls) => [...ls, { key: newKey(), quoteItemId: null, productId: null, name: "", detail: "", qty: "1", unit: "each", price: "", cost: "", fromStock: "", stocked: false }].slice(0, 60))}
              >
                <Plus className="size-3.5" />
                Typed line
              </Button>
              <span className="tabular">
                Lines {moneyExact(r2(typedTotal))} ex GST, {moneyExact(r2(typedTotal * 1.1))} inc GST
              </span>
            </div>
          </div>
          <div className="grid gap-1">
            <p className="text-xs font-medium text-muted-foreground">Add a product</p>
            <ProductFinder
              picked={finder}
              onPick={(p) => {
                if (!p) return setFinder(null);
                setLines((ls) =>
                  [
                    ...ls,
                    {
                      key: newKey(),
                      quoteItemId: null,
                      productId: p.id,
                      name: productName(p),
                      detail: [p.supplier, p.size, p.sku ? `SKU ${p.sku}` : ""].filter(Boolean).join(" · "),
                      qty: "1",
                      unit: p.unit,
                      price: priceOf(p),
                      cost: "",
                      fromStock: "",
                      stocked: !!p.heldInWarehouse,
                    },
                  ].slice(0, 60),
                );
                setFinder(null);
              }}
            />
          </div>
          <Field label="Why (goes on the job history, optional)">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} placeholder="For example: installer took 23 lm, not 25" />
          </Field>
          <p className="text-xs text-muted-foreground">
            To swap a product, remove its line and add the new one. Check changes shows what moves on the invoice and the draft POs before anything is saved.
          </p>
          {error ? <p className="text-sm text-destructive" data-testid="price-record-error">{error}</p> : null}
        </div>
      ) : step === "check" && shown ? (
        <div className="grid gap-3 text-sm" data-testid="price-record-preview">
          {shown.nothing ? (
            <p>Nothing changed. Go back to change a line.</p>
          ) : (
            <>
              <ul className="list-disc pl-5">
                {[...shown.changes, ...shown.stock].map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <div className="grid gap-1 rounded-md border border-border p-3">
                <p>
                  Total {moneyExact(shown.before.total)} to <strong>{moneyExact(shown.after.total)}</strong> inc GST ({moneyExact(shown.after.subtotal)} ex GST, GST {moneyExact(shown.after.gst)}).
                </p>
                <p>
                  Invoice {shown.invoice.number} keeps its number and becomes {moneyExact(shown.invoice.after)}. It is not emailed.
                </p>
                {shown.drafts.map((d) => (
                  <p key={d.number}>
                    {d.removed
                      ? `Draft ${d.number} is removed (nothing left on it). It was never sent.`
                      : `Draft ${d.number}: ${moneyExact(d.before)} to ${moneyExact(d.after)} ex GST. Not sent.`}
                    {d.notes.length ? <span className="block text-xs text-muted-foreground">{d.notes.join(" ")}</span> : null}
                  </p>
                ))}
                {shown.ordersNew ? <p>New lines are drafted on a PO. Not sent.</p> : null}
              </div>
              {shown.byHand.length || shown.qtyNotes.length ? (
                <ul className="list-disc pl-5 text-xs text-muted-foreground">
                  {[...shown.qtyNotes, ...shown.byHand].map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">Nothing is emailed, sent to Xero or sent to a supplier. The change goes on the job history.</p>
            </>
          )}
          {error ? <p className="text-sm text-destructive" data-testid="price-record-error">{error}</p> : null}
        </div>
      ) : (
        <div className="grid gap-2 text-sm" data-testid="price-record-done">
          <p className="font-medium text-[var(--success)]">Saved.</p>
          <pre className="whitespace-pre-wrap font-sans text-sm">{log}</pre>
        </div>
      )}
    </Modal>
  );
}
