import * as React from "react";
import { Link } from "wouter";
import { ArrowLeft, Check, Plus, Search, ShoppingBag, UserPlus, X } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { ProductFinder, productName } from "./product-finder";
import { unitLabel } from "./quote-pickers";
import { ContactMatches, type ContactMatch } from "./contact-matches";
import { money, moneyExact } from "../lib/money";
import { emailState, xeroState } from "../lib/invoice-status";
import { useContactSearch, useCreateContact } from "../queries/contacts";
import type { FoundProduct } from "../queries/productFind";
import { useRaiseSale, useSalePreview, useSales, type SaleInput, type SalePreview, type SaleResult, type SaleRow } from "../queries/productSales";

/* ---------------------------------------------------------------------------
 * SELL PRODUCTS (Damien, 30 Oct). One form for a quote or a straight invoice,
 * opened from the installer card, a contact, a company, or Clients for a walk
 * in. Preview first, then Confirm. Confirm saves or raises only: emailing,
 * Xero and payment stay as their own steps on the job.
 * ------------------------------------------------------------------------- */

export type SaleBuyer = SaleInput["buyer"];

type Line = {
  key: string;
  productId: number | null;
  name: string;
  detail: string;
  qty: string;
  unit: string;
  price: string;
  fromStock: string;
  stocked: boolean;
};

const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
const num = (v: string) => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() !== "" && Number.isFinite(n) ? n : NaN;
};
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const qtyText = (n: number, unit: string) => `${Number(n.toFixed(4))} ${unitLabel(unit)}`;
const dateOf = (v: Date | string | null | undefined) => {
  if (!v) return "";
  const d = typeof v === "string" ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

/**
 * The same price a quote line gets (liveSellFor on the server): the stored
 * sell price, unless a live special is passed on to the customer.
 */
function priceOf(p: FoundProduct): string {
  const v = p.passedOnToCustomer && p.sellExGst != null ? p.sellExGst : (p.sellPrice ?? p.sellExGst ?? null);
  return v != null ? String(r2(v)) : "";
}

function lineOf(p: FoundProduct): Line {
  return {
    key: newKey(),
    productId: p.id,
    name: productName(p),
    detail: [p.supplier, p.size, p.sku ? `SKU ${p.sku}` : ""].filter(Boolean).join(" · "),
    qty: "1",
    unit: p.unit,
    price: priceOf(p),
    // Starts blank on purpose (Damien, 31 Oct): Ops keeps no stock counts, so staff type what comes off the shelf.
    fromStock: "",
    stocked: !!p.heldInWarehouse,
  };
}
const typedLine = (): Line => ({ key: newKey(), productId: null, name: "", detail: "", qty: "1", unit: "each", price: "", fromStock: "", stocked: false });

/* ------------------------------- the buyer ------------------------------- */

type Picked = { buyer: SaleBuyer; name: string };

function BuyerPicker({ onPick }: { onPick: (p: Picked) => void }) {
  const [search, setSearch] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [form, setForm] = React.useState({ firstName: "", lastName: "", mobile: "", email: "" });
  const [error, setError] = React.useState<string | null>(null);
  const found = useContactSearch(adding ? "" : search);
  const create = useCreateContact();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const nameOf = (c: { firstName?: string | null; lastName?: string | null }) => `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "No name";

  async function add() {
    setError(null);
    try {
      const row = await create.mutateAsync({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        mobile: form.mobile.trim() || null,
        email: form.email.trim() || null,
        source: "walk_in",
      });
      if (!row) throw new Error("The new card did not save. Try again.");
      onPick({ buyer: { kind: "contact", contactId: row.id }, name: nameOf(row) });
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (adding) {
    return (
      <div className="grid gap-2 rounded-md border border-border p-3" data-testid="walkin-form">
        <p className="text-xs text-muted-foreground">New person. If they are already in Ops, a match shows below. Use it instead of adding them twice.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="First name">
            <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} autoFocus />
          </Field>
          <Field label="Last name">
            <Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
          </Field>
          <Field label="Mobile">
            <Input value={form.mobile} inputMode="tel" onChange={(e) => set("mobile", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input value={form.email} type="email" onChange={(e) => set("email", e.target.value)} />
          </Field>
        </div>
        <ContactMatches
          input={{ firstName: form.firstName, lastName: form.lastName, mobile: form.mobile, email: form.email }}
          onUse={(m: ContactMatch) => onPick({ buyer: { kind: "contact", contactId: m.id }, name: m.name || "No name" })}
          useLabel="Sell to this person"
        />
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setAdding(false)} disabled={create.isPending}>
            Back to search
          </Button>
          <Button size="sm" onClick={add} disabled={!form.firstName.trim() || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : <UserPlus className="size-3.5" />}
            Add and sell to them
          </Button>
        </div>
      </div>
    );
  }

  const rows = search.trim() ? (found.data ?? []) : [];
  return (
    <div className="grid gap-2" data-testid="buyer-picker">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-8" placeholder="Name, mobile or email" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus aria-label="Find the buyer" />
      </div>
      {rows.length ? (
        <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {rows.slice(0, 12).map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="flex w-full flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-secondary"
                onClick={() => onPick({ buyer: { kind: "contact", contactId: c.id }, name: nameOf(c) })}
              >
                <span className="font-medium">{nameOf(c)}</span>
                <span className="text-xs text-muted-foreground">{[c.mobile, c.email, c.suburb].filter(Boolean).join(" · ")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : search.trim() && !found.isFetching ? (
        <p className="text-xs text-muted-foreground">Nobody matches "{search.trim()}".</p>
      ) : null}
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const words = search.trim().split(/\s+/);
            const looksMobile = /^[\d\s+()-]{8,}$/.test(search.trim());
            const looksEmail = search.includes("@");
            setForm({
              firstName: looksMobile || looksEmail ? "" : (words[0] ?? ""),
              lastName: looksMobile || looksEmail ? "" : words.slice(1).join(" "),
              mobile: looksMobile ? search.trim() : "",
              email: looksEmail ? search.trim() : "",
            });
            setAdding(true);
          }}
        >
          <UserPlus className="size-3.5" />
          Walk in, add someone new
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- the lines ------------------------------- */

function LineRow({ l, i, set, remove, ordering }: { l: Line; i: number; set: (p: Partial<Line>) => void; remove: () => void; ordering: boolean }) {
  const qty = num(l.qty);
  const stock = num(l.fromStock);
  const toOrder = Number.isFinite(qty) ? Math.max(0, qty - (Number.isFinite(stock) ? stock : 0)) : 0;
  return (
    <div className="grid grid-cols-2 gap-2 border-b border-border pb-2 sm:grid-cols-[1fr_4.5rem_4rem_6.5rem_5.5rem_1.75rem] sm:items-center" data-testid="sale-line">
      <div className="col-span-2 min-w-0 sm:col-span-1">
        {l.productId ? (
          <>
            <p className="truncate text-sm font-medium">{l.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {l.detail}
              {l.stocked ? " · usually in the warehouse" : ""}
            </p>
          </>
        ) : (
          <Input placeholder="Typed line, product and colour" value={l.name} onChange={(e) => set({ name: e.target.value })} aria-label={`Line ${i + 1} item`} />
        )}
      </div>
      <Input
        className="tabular text-right"
        inputMode="decimal"
        value={l.qty}
        onChange={(e) => set({ qty: e.target.value })}
        aria-label={`Line ${i + 1} quantity`}
      />
      {l.productId ? (
        <span className="text-xs text-muted-foreground">{unitLabel(l.unit)}</span>
      ) : (
        <Input value={l.unit} onChange={(e) => set({ unit: e.target.value })} aria-label={`Line ${i + 1} unit`} />
      )}
      <Input className="tabular text-right" inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => set({ price: e.target.value })} aria-label={`Line ${i + 1} price ex GST`} />
      <div>
        <Input className="tabular text-right" inputMode="decimal" placeholder="?" value={l.fromStock} onChange={(e) => set({ fromStock: e.target.value })} aria-label={`Line ${i + 1} from stock now`} />
        {ordering && l.fromStock.trim() !== "" && toOrder > 0 ? <p className="mt-0.5 text-right text-[11px] text-muted-foreground">order {Number(toOrder.toFixed(4))}</p> : null}
      </div>
      <button type="button" className="justify-self-end text-muted-foreground hover:text-foreground" onClick={remove} aria-label={`Remove line ${i + 1}`}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/* ------------------------------- the form -------------------------------- */

export function SellProductsModal({
  open,
  onClose,
  buyer: fixed,
  buyerName,
  note: hint,
}: {
  open: boolean;
  onClose: () => void;
  /** Set when opened from a card. Left out on Clients, for a walk in. */
  buyer?: SaleBuyer;
  buyerName?: string;
  note?: string;
}) {
  const preview = useSalePreview();
  const raise = useRaiseSale();
  const [picked, setPicked] = React.useState<Picked | null>(null);
  const [mode, setMode] = React.useState<"quote" | "invoice">("invoice");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [finder, setFinder] = React.useState<FoundProduct | null>(null);
  const [orderNeeded, setOrderNeeded] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [step, setStep] = React.useState<"form" | "preview" | "done">("form");
  const [shown, setShown] = React.useState<SalePreview | null>(null);
  const [done, setDone] = React.useState<SaleResult | null>(null);
  const [requestKey, setRequestKey] = React.useState(newKey);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPicked(fixed ? { buyer: fixed, name: buyerName ?? "" } : null);
    setMode("invoice");
    setLines([]);
    setFinder(null);
    setOrderNeeded(false);
    setNote("");
    setStep("form");
    setShown(null);
    setDone(null);
    setRequestKey(newKey());
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const busy = preview.isPending || raise.isPending;
  const setLine = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const ex = r2(lines.reduce((s, l) => s + (num(l.qty) || 0) * (num(l.price) || 0), 0));

  function input(): SaleInput | string {
    if (!picked) return "Pick who is buying first.";
    if (!lines.length) return "Add at least one product or typed line.";
    for (const [i, l] of lines.entries()) {
      const name = l.name.trim() || `Line ${i + 1}`;
      if (!l.productId && !l.name.trim()) return `Line ${i + 1} needs a description.`;
      if (!(num(l.qty) > 0)) return `"${name}" needs a quantity over 0.`;
      if (!(num(l.price) > 0)) return `"${name}" needs a price over $0.`;
      if (l.fromStock.trim() === "") return `"${name}": confirm how many come off the shelf in From stock now. Type 0 if none. Ops keeps no stock counts.`;
      const fs = num(l.fromStock);
      if (!(fs >= 0)) return `"${name}": From stock now must be 0 or more.`;
      if (fs > num(l.qty)) return `"${name}": From stock now is more than the quantity.`;
    }
    return {
      buyer: picked.buyer,
      mode,
      orderNeeded,
      note: note.trim() || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        description: l.productId ? "" : l.name.trim(),
        qty: num(l.qty),
        unit: l.unit.trim() || "each",
        unitPrice: num(l.price),
        fromStock: num(l.fromStock),
      })),
    };
  }

  async function showPreview() {
    setError(null);
    const i = input();
    if (typeof i === "string") return setError(i);
    try {
      setShown(await preview.mutateAsync(i));
      setStep("preview");
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function confirm() {
    setError(null);
    const i = input();
    if (typeof i === "string" || !shown) return setError(typeof i === "string" ? i : "Preview it again.");
    try {
      setDone(await raise.mutateAsync({ ...i, requestKey, expectedTotal: shown.total }));
      setStep("done");
    } catch (e) {
      setError(errorText(e));
    }
  }

  const title = step === "done" ? (done?.mode === "invoice" ? "Invoice raised" : "Quote saved") : step === "preview" ? "Check before you confirm" : "Sell products";
  const subtitle =
    step === "form"
      ? "Products only, no install. Prices are ex GST. Nothing is saved until you Confirm on the next screen."
      : step === "preview"
        ? "This is what Confirm does. Nothing has been saved yet."
        : undefined;

  const footer =
    step === "form" ? (
      <>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={showPreview} disabled={busy || !picked || !lines.length} data-testid="sale-preview">
          {preview.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
          Preview
        </Button>
      </>
    ) : step === "preview" ? (
      <>
        <Button
          variant="outline"
          onClick={() => {
            setStep("form");
            setRequestKey(newKey());
            setError(null);
          }}
          disabled={busy}
        >
          <ArrowLeft className="size-4" />
          Back to edit
        </Button>
        <Button onClick={confirm} disabled={busy} data-testid="sale-confirm">
          {raise.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Check className="size-4" />}
          {mode === "invoice" ? "Confirm, raise invoice" : "Confirm, save quote"}
          {shown && shown.orderNeeded && shown.ordering.some((o) => !o.note)
            ? mode === "invoice"
              ? shown.ordering.filter((o) => !o.note).length === 1
                ? " and draft a PO"
                : " and draft POs"
              : " (POs on accept)"
            : ""}
        </Button>
      </>
    ) : (
      <Button onClick={onClose}>Close</Button>
    );

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={title} subtitle={subtitle} footer={footer} width="max-w-3xl">
      {step === "form" ? (
        <div className="grid gap-4" data-testid="sell-form">
          <section className="grid gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Who is buying</h4>
            {picked ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-secondary px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{picked.name || "Picked"}</span>
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    {picked.buyer.kind === "installer" ? "installer, billed as set on his card" : picked.buyer.kind === "company" ? "company" : "contact"}
                  </span>
                </span>
                {!fixed ? (
                  <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                    Change
                  </Button>
                ) : null}
              </div>
            ) : (
              <BuyerPicker onPick={setPicked} />
            )}
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          </section>

          <section className="grid gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quote or invoice</h4>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Quote or invoice">
              {(
                [
                  ["invoice", "Raise invoice now", "Sold today. One invoice, ready to email when you choose."],
                  ["quote", "Save as quote", "Send it later from the quote. Normal Send and Accept."],
                ] as const
              ).map(([m, label, text]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => setMode(m)}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${mode === m ? "border-[var(--primary)] bg-[var(--primary)]/5" : "border-border hover:bg-secondary"}`}
                >
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{text}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="grid gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Products</h4>
            <div className="rounded-md border border-border bg-secondary/30 p-2">
              <ProductFinder
                picked={finder}
                onPick={(p) => {
                  if (!p) return setFinder(null);
                  setLines((ls) => [...ls, lineOf(p)].slice(0, 60));
                  setFinder(null);
                }}
                context={picked?.buyer.kind === "contact" ? { contactId: picked.buyer.contactId } : picked?.buyer.kind === "company" ? { companyId: picked.buyer.companyId } : undefined}
              />
            </div>
            {lines.length ? (
              <div className="grid gap-2">
                <div className="hidden grid-cols-[1fr_4.5rem_4rem_6.5rem_5.5rem_1.75rem] gap-2 text-xs font-medium text-muted-foreground sm:grid">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span>Unit</span>
                  <span className="text-right">Price ex GST</span>
                  <span className="text-right">From stock now</span>
                  <span />
                </div>
                {lines.map((l, i) => (
                  <LineRow key={l.key} l={l} i={i} set={(p) => setLine(i, p)} remove={() => setLines((ls) => ls.filter((_, j) => j !== i))} ordering={orderNeeded} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Search the price list above and tap a product to add it.</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, typedLine()])} disabled={lines.length >= 60}>
                <Plus className="size-3.5" />
                Add a typed line
              </Button>
              <span className="text-sm" data-testid="sale-running-total">
                {moneyExact(ex)} ex GST
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              From stock now: how much you hand over from the showroom or warehouse. Ops keeps no stock counts, so type what you have checked on the shelf, 0 if none. Every line needs a number before Preview.
            </p>
          </section>

          <section className="grid gap-2 rounded-md border border-border p-3">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={orderNeeded} onChange={(e) => setOrderNeeded(e.target.checked)} className="mt-0.5" data-testid="sale-order-tick" />
              <span>
                <span className="font-medium">We need to order this</span>
                <span className="block text-xs text-muted-foreground">
                  Drafts purchase orders for what is not coming from stock{mode === "quote" ? ", once the quote is accepted" : ""}. Drafts only. Ops never sends them. Leave it off when it is all coming from stock.
                </span>
              </span>
            </label>
          </section>

          <Field label="Note on the job (optional, not on the invoice)">
            <Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      ) : step === "preview" && shown ? (
        <PreviewBody p={shown} error={error} />
      ) : done ? (
        <DoneBody r={done} />
      ) : null}
    </Modal>
  );
}

function PreviewBody({ p, error }: { p: SalePreview; error: string | null }) {
  const drafting = p.orderNeeded ? p.ordering.filter((o) => !o.note) : [];
  return (
    <div className="grid gap-3 text-sm" data-testid="sale-preview-body">
      {drafting.length ? (
        // Loud on purpose (Damien, 31 Oct): stock sales must never order by accident.
        <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-amber-900" data-testid="sale-po-warning">
          <p className="font-semibold">
            {p.mode === "invoice" ? "Confirm will also draft" : "When the quote is accepted, Ops drafts"} {drafting.length === 1 ? "a purchase order" : "purchase orders"} for {drafting.length} line{drafting.length === 1 ? "" : "s"}.
          </p>
          <p className="text-xs">
            &quot;We need to order this&quot; is ticked and From stock now is less than the quantity. If it is coming from stock, press Back to edit and untick it, or put the full quantity in From stock now.
          </p>
        </div>
      ) : null}
      <div className="grid gap-1 rounded-md bg-secondary px-3 py-2">
        <p>
          <span className="text-muted-foreground">Buyer: </span>
          <span className="font-medium">{p.buyer.billToName}</span>
          {p.buyer.kind === "installer" && p.buyer.name !== p.buyer.billToName ? <span className="text-muted-foreground"> (for {p.buyer.name})</span> : null}
        </p>
        <p>
          <span className="text-muted-foreground">Email on file: </span>
          {p.buyer.email ?? <span className="text-amber-700">none. Add one before you email it.</span>}
        </p>
        <p data-testid="sale-account">
          <span className="text-muted-foreground">Xero account: </span>
          <span className="font-medium">
            {p.account.name.startsWith(p.account.code) ? p.account.name : `${p.account.code} ${p.account.name}`}
          </span>{" "}
          <span className="text-muted-foreground">({p.account.label})</span>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b border-border text-left">
              <th className="py-1.5 pr-2 font-medium">Item</th>
              <th className="py-1.5 pr-2 text-right font-medium">Qty</th>
              <th className="py-1.5 pr-2 text-right font-medium">Each ex GST</th>
              <th className="py-1.5 pr-2 text-right font-medium">Total</th>
              <th className="py-1.5 text-right font-medium">From stock</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map((l, i) => (
              <tr key={i} className="border-b border-border align-top">
                <td className="py-1.5 pr-2">
                  {l.description}
                  {l.qtyNote ? <span className="block text-xs text-amber-700">{l.qtyNote}</span> : null}
                  {l.listPrice != null && Math.abs(l.listPrice - l.unitPrice) > 0.004 ? (
                    <span className="block text-xs text-muted-foreground">Normal sell price {moneyExact(l.listPrice)}</span>
                  ) : null}
                </td>
                <td className="tabular py-1.5 pr-2 text-right">{qtyText(l.qty, l.unit)}</td>
                <td className="tabular py-1.5 pr-2 text-right">{moneyExact(l.unitPrice)}</td>
                <td className="tabular py-1.5 pr-2 text-right">{moneyExact(l.total)}</td>
                <td className="tabular py-1.5 text-right">{l.fromStock > 0 ? qtyText(l.fromStock, l.unit) : "none"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="py-1 pr-2 text-right text-muted-foreground">
                Ex GST
              </td>
              <td className="tabular py-1 pr-2 text-right">{moneyExact(p.subtotal)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={3} className="py-1 pr-2 text-right text-muted-foreground">
                GST
              </td>
              <td className="tabular py-1 pr-2 text-right">{moneyExact(p.gst)}</td>
              <td />
            </tr>
            <tr>
              <td colSpan={3} className="py-1 pr-2 text-right font-semibold">
                Total
              </td>
              <td className="tabular py-1 pr-2 text-right font-semibold" data-testid="sale-total">
                {moneyExact(p.total)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {p.orderNeeded && p.ordering.length ? (
        <div className="rounded-md border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">To order</p>
          <ul className="mt-1 grid gap-1">
            {p.ordering.map((o, i) => (
              <li key={i}>
                {o.description}: {qtyText(o.qty, o.unit)}
                {o.supplierName ? <span className="text-muted-foreground"> from {o.supplierName}</span> : null}
                {o.note ? <span className="block text-xs text-amber-700">{o.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="rounded-md border border-[var(--primary)]/40 bg-[var(--primary)]/5 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">When you press Confirm</p>
        <ul className="mt-1 grid list-disc gap-1 pl-5" data-testid="sale-happens">
          {p.happens.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

function DoneBody({ r }: { r: SaleResult }) {
  return (
    <div className="grid gap-3 text-sm" data-testid="sale-done">
      <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900">
        {r.mode === "invoice" && r.invoice
          ? `Invoice ${r.invoice.number} raised for ${moneyExact(r.invoice.total)}.`
          : `Quote ${r.quoteRef} saved for ${moneyExact(r.total)}.`}
        {r.reused ? " This was already done by the first click, so nothing new was made." : ""}
      </p>
      {r.poDrafts.length ? <p>{r.poDrafts.length === 1 ? `Draft purchase order ${r.poDrafts[0]}. Check it in Purchasing. It has not been sent.` : `Draft purchase orders ${r.poDrafts.join(", ")}. Check them in Purchasing. They have not been sent.`}</p> : null}
      {r.note ? <p className="text-muted-foreground">{r.note}</p> : null}
      <p className="text-muted-foreground">
        {r.mode === "invoice"
          ? "Nothing has been emailed and nothing is in Xero. On the job, use Email to send it, Send to Xero when you are ready, and record the payment when it comes in."
          : "Nothing has been sent. Open the quote and press Send when you are ready."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link href={`/jobs/${r.jobId}`}>
          <Button variant="outline" size="sm">
            Open the job
          </Button>
        </Link>
        <Link href={`/quotes/${r.quoteId}`}>
          <Button variant="outline" size="sm">
            Open quote {r.quoteRef}
          </Button>
        </Link>
      </div>
    </div>
  );
}

/* ---------------------------- button and list ---------------------------- */

export function SellProductsButton({
  buyer,
  buyerName,
  disabled,
  size = "sm",
  label = "Sell products",
  note,
}: {
  buyer?: SaleBuyer;
  buyerName?: string;
  disabled?: boolean;
  size?: "sm" | "default";
  label?: string;
  note?: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)} disabled={disabled} data-testid="sell-products">
        <ShoppingBag className="size-3.5" />
        {label}
      </Button>
      <SellProductsModal open={open} onClose={() => setOpen(false)} buyer={buyer} buyerName={buyerName} note={note} />
    </>
  );
}

function payState(s: SaleRow) {
  if (!s.invoices.length) return s.quoteStatus === "accepted" ? { text: "Accepted, no invoice yet", colour: "#D08A1E" } : { text: `Quote ${s.quoteStatus ?? ""}`.trim(), colour: "#8A8580" };
  const total = s.invoices.reduce((a, i) => a + i.total, 0);
  const paid = s.invoices.reduce((a, i) => a + i.paid, 0);
  if (paid >= total - 0.005) return { text: "Paid", colour: "#3F7D3A" };
  if (paid > 0.005) return { text: `Part paid, ${money(total - paid)} owing`, colour: "#D08A1E" };
  return { text: `${money(total)} owing`, colour: "#B4462E" };
}

function handState(s: SaleRow) {
  if (!s.handover) return null;
  if (s.handover.complete) return { text: "All supplied", colour: "#3F7D3A" };
  if (!s.handover.lines) return null;
  return { text: `${s.handover.outstanding} of ${s.handover.lines} line${s.handover.lines === 1 ? "" : "s"} to hand over`, colour: "#D08A1E" };
}

/** Sales for one buyer. Paid comes from the invoices only. Handed over is its own badge. */
export function SalesList({ where }: { where: { installerId?: number; contactId?: number; companyId?: number } }) {
  const q = useSales(where);
  if (q.isLoading) return <div className="px-4 py-3"><Spinner /></div>;
  if (q.error) return <p className="px-4 py-3 text-sm text-destructive">{errorText(q.error)}</p>;
  const rows = q.data ?? [];
  if (!rows.length) return <Empty>No product sales yet.</Empty>;
  return (
    <ul className="divide-y divide-border" data-testid="sales-list">
      {rows.map((s) => {
        const pay = payState(s);
        const hand = handState(s);
        return (
          <li key={s.saleId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
            <span className="min-w-0">
              {s.jobId ? (
                <Link href={`/jobs/${s.jobId}`} className="font-medium text-[var(--primary)] hover:underline">
                  {s.invoices[0]?.number ?? s.quoteRef ?? s.jobRef}
                </Link>
              ) : (
                <span className="font-medium">{s.quoteRef}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {" "}
                {dateOf(s.createdAt)} · {s.mode === "invoice" ? "invoice" : "quote"} · {moneyExact(s.total)}
                {s.orderNeeded ? " · ordering" : ""}
              </span>
              {s.invoices.length ? (
                // Email and Xero are separate from paid (Damien, 31 Oct). Not sent until it has actually been emailed.
                <span className="block text-xs text-muted-foreground" data-testid="sale-invoice-states">
                  {s.invoices
                    .map((i) => {
                      const st = { status: i.status, total: i.total, amountPaid: i.paid, emailedAt: i.emailedAt, inXero: i.inXero };
                      return `${i.number}: ${emailState(st).label}, ${xeroState(st).label}`;
                    })
                    .join("; ")}
                </span>
              ) : null}
            </span>
            <span className="flex flex-wrap gap-1.5">
              <Badge colour={pay.colour}>{pay.text}</Badge>
              {hand ? <Badge colour={hand.colour}>{hand.text}</Badge> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Card for contact and company pages. */
export function SalesCard({ buyer, buyerName }: { buyer: SaleBuyer; buyerName: string }) {
  const where = buyer.kind === "contact" ? { contactId: buyer.contactId } : buyer.kind === "company" ? { companyId: buyer.companyId } : { installerId: buyer.installerId };
  return (
    <Card>
      <CardHeader
        title="Product sales"
        subtitle="Products sold with no install. Paid comes from the invoice. Handed over is shown on its own."
        action={<SellProductsButton buyer={buyer} buyerName={buyerName} />}
      />
      <SalesList where={where} />
    </Card>
  );
}

