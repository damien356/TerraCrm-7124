import * as React from "react";
import { useBootstrap } from "../queries/settings";
import { Link, useLocation, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Plus, Repeat, Search, Send, Trash2, X } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { LabourPicker, ProductPicker } from "../components/quote-pickers";
import { SupervisorPicker } from "../components/supervisor-picker";
import { QuotePeopleCard } from "../components/job-people";
import { QuoteCustomerPanel } from "../components/quote-customer";
import { QuoteBundlesCard } from "../components/quote-bundles";
import { QuoteAgentCard } from "../components/quote-agent";
import {
  useAcceptQuote,
  useAddQuoteItem,
  useChangeQuoteProduct,
  useConvertQuote,
  useDeclineQuote,
  useQuote,
  useRemoveQuoteItem,
  useReviseQuote,
  useSendQuote,
  useApproveDiscount,
  useSuggestedProducts,
  useUpdateQuote,
  useUpdateQuoteItem,
} from "../queries/quotes";
import { useProducts } from "../queries/products";
import { QUOTE_STATUS_COLOUR } from "./quotes";

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

/** The price book chain, 1.3 x 1.05 x 1.4, as a markup on cost. Mirrors STANDARD_MARKUP_PCT in api/lib/pricing.ts. */
const STANDARD_MARKUP = "91.1%";

/** Spec section 6. Shown once a quote is accepted, so the customer can pay the deposit. */
const BANK = { name: "Arclan Pty Ltd", bsb: "064 844", account: "10102345" };

const KINDS = ["supply", "labour", "prep", "removal", "accessory", "other"];
const UNITS = ["m2", "lm", "each", "hour", "job"];

function fmtDateTime(value: Date | string | null) {
  if (!value) return "Not yet";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "Not yet";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/* ------------------------------- line row ------------------------------- */

type Item = {
  id: number;
  kind: string;
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  unitCost: number | null;
  markupPercent?: number | null;
  total: number;
  flagged?: boolean;
  flagReason?: string | null;
  voicePhrase?: string | null;
  productId?: number | null;
  lineType?: string;
};

/* ---------------------------- change product ---------------------------- */

/** Typing should not fire a query per keystroke. */
function useDebounced(value: string, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

type Choice = { id: number; label: string; detail: string };

/** Price list search, only mounted once something is typed. */
function SearchResults({ q, render }: { q: string; render: (rows: Choice[]) => React.ReactNode }) {
  const found = useProducts({ search: q });
  const rows: Choice[] = (found.data ?? []).slice(0, 40).map((p) => {
    const named = [p.brand, p.range].filter(Boolean).join(" ");
    return {
      id: p.id,
      label: (p.colour ? (named ? `${named} in ${p.colour}` : p.colour) : named) || p.supplier,
      detail: [p.supplier, p.backing, p.sellPrice != null ? `${money(p.sellPrice)}/${p.unit}` : "no sell price"]
        .filter(Boolean)
        .join(" · "),
    };
  });
  return (
    <div className="mt-2 max-h-72 overflow-y-auto">
      {found.isLoading ? (
        <Spinner />
      ) : rows.length ? (
        render(rows)
      ) : (
        <p className="text-sm text-muted-foreground">Nothing matches that.</p>
      )}
    </div>
  );
}

/**
 * One window to put the right product on a line: the closest few first, a
 * search under them for anything else. A tap swaps it, price and all.
 */
function ChangeProduct({ item, onClose }: { item: Item; onClose: () => void }) {
  const suggested = useSuggestedProducts(item.id, true);
  const change = useChangeQuoteProduct();
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search.trim());
  const [error, setError] = React.useState<string | null>(null);

  const near: Choice[] = (suggested.data ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    detail: [p.supplier, p.backing, p.sellPrice != null ? `${money(p.sellPrice)}/${p.unit}` : "no sell price"]
      .filter(Boolean)
      .join(" · "),
  }));

  const use = (productId: number) => {
    setError(null);
    change
      .mutateAsync({ id: item.id, productId })
      .then(onClose)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const list = (rows: Choice[]) => (
    <div className="space-y-1.5">
      {rows.map((c) => (
        <button
          key={c.id}
          type="button"
          disabled={change.isPending}
          onClick={() => use(c.id)}
          className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left transition-colors hover:border-[var(--gold)] disabled:opacity-60"
        >
          <span className="min-w-0">
            <span className="block line-clamp-2 text-sm font-medium leading-snug">{c.label}</span>
            <span className="block truncate text-xs text-muted-foreground">{c.detail}</span>
          </span>
          <span className="shrink-0 text-xs font-semibold text-[var(--gold-deep)]">Use</span>
        </button>
      ))}
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Change product"
      subtitle={`${item.description}, ${item.qty} ${item.unit}. The quantity stays, the price comes off the price book.`}
      width="max-w-lg"
    >
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Closest matches</p>
          {suggested.isLoading ? (
            <Spinner />
          ) : near.length ? (
            list(near)
          ) : (
            <p className="text-sm text-muted-foreground">Nothing close in the price book. Search below, or close this and type the price in.</p>
          )}
        </div>
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Or search the price list</p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9 text-base sm:text-sm"
              placeholder="A range, a colour or a supplier"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {debounced.length >= 2 ? <SearchResults q={debounced} render={list} /> : null}
        </div>
        {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** show: cost column visible. edit: may change costs (Admin only). */
function useCostView() {
  const actor = useBootstrap().data?.actor;
  return { show: Boolean(actor?.canSeeCosts), edit: actor?.role === "admin" };
}

function LineRow({ item, locked }: { item: Item; locked: boolean }) {
  const cost = useCostView();
  const update = useUpdateQuoteItem();
  const remove = useRemoveQuoteItem();
  const [changing, setChanging] = React.useState(false);
  const isProductLine = item.kind === "supply" || item.productId != null || Boolean(item.voicePhrase);
  const [draft, setDraft] = React.useState({
    description: item.description,
    qty: String(item.qty),
    unitPrice: String(item.unitPrice),
    unitCost: item.unitCost == null ? "" : String(item.unitCost),
    markup: item.markupPercent == null ? "" : String(item.markupPercent),
  });

  React.useEffect(() => {
    setDraft({
      description: item.description,
      qty: String(item.qty),
      unitPrice: String(item.unitPrice),
      unitCost: item.unitCost == null ? "" : String(item.unitCost),
      markup: item.markupPercent == null ? "" : String(item.markupPercent),
    });
  }, [item.id, item.description, item.qty, item.unitPrice, item.unitCost, item.markupPercent]);

  return (
    <tr className={item.flagged ? "border-b border-border bg-[#D08A1E]/10 last:border-0" : "border-b border-border last:border-0"}>
      <td className="px-2 py-1.5">
        <Select
          className="h-8 w-[104px]"
          value={item.kind}
          disabled={locked}
          onChange={(e) => update.mutate({ id: item.id, kind: e.target.value })}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <button
          type="button"
          disabled={locked}
          className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline disabled:no-underline"
          title="Tap to switch between Material and Labour"
          onClick={() => update.mutate({ id: item.id, lineType: item.lineType === "labour" ? "material" : "labour" })}
        >
          {item.lineType === "labour" ? "Labour" : "Material"}
        </button>
      </td>
      <td className="min-w-[240px] px-2 py-1.5">
        {item.flagged ? (
          <span className="mb-1 flex items-center gap-1 text-xs text-[#D08A1E]" title={item.flagReason ?? "Needs review"}>
            <AlertTriangle className="size-3.5" /> {item.flagReason ?? "Needs review"}
          </span>
        ) : null}
        <Input
          className="h-8"
          value={draft.description}
          disabled={locked}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
          onBlur={() =>
            draft.description &&
            draft.description !== item.description &&
            update.mutate({ id: item.id, description: draft.description })
          }
        />
        {isProductLine && !locked ? (
          <button
            type="button"
            onClick={() => setChanging(true)}
            className={
              item.flagged
                ? "mt-1 inline-flex items-center gap-1 rounded-md bg-[var(--gold)] px-2.5 py-1 text-xs font-semibold text-[var(--sidebar)]"
                : "mt-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--gold-deep)] hover:bg-[var(--gold-wash)]"
            }
          >
            <Repeat className="size-3.5" /> Change product
          </button>
        ) : null}
        {changing ? <ChangeProduct item={item} onClose={() => setChanging(false)} /> : null}
      </td>
      <td className="px-2 py-1.5">
        <Input
          className="tabular h-8 w-[76px] text-right"
          value={draft.qty}
          disabled={locked}
          onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))}
          onBlur={() => Number(draft.qty) !== item.qty && update.mutate({ id: item.id, qty: Number(draft.qty) || 0 })}
        />
      </td>
      <td className="px-2 py-1.5">
        <Select
          className="h-8 w-[80px]"
          value={item.unit}
          disabled={locked}
          onChange={(e) => update.mutate({ id: item.id, unit: e.target.value })}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-2 py-1.5">
        <Input
          className="tabular h-8 w-[92px] text-right"
          value={draft.unitPrice}
          disabled={locked}
          onChange={(e) => setDraft((d) => ({ ...d, unitPrice: e.target.value }))}
          onBlur={() =>
            Number(draft.unitPrice) !== item.unitPrice &&
            update.mutate({ id: item.id, unitPrice: Number(draft.unitPrice) || 0 })
          }
        />
      </td>
      {cost.show ? (
      <td className="px-2 py-1.5">
        <Input
          className="tabular h-8 w-[92px] text-right"
          placeholder="cost"
          value={draft.unitCost}
          disabled={locked || !cost.edit}
          onChange={(e) => setDraft((d) => ({ ...d, unitCost: e.target.value }))}
          onBlur={() => {
            const next = draft.unitCost === "" ? null : Number(draft.unitCost);
            if (next !== item.unitCost) update.mutate({ id: item.id, unitCost: next });
          }}
        />
      </td>
      ) : null}
      {cost.show ? (
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Input
            className="tabular h-8 w-[68px] text-right"
            placeholder={item.unitCost ? "" : "no cost"}
            title={cost.edit ? "Markup on cost. Changing it sets the sell price." : "Only an Admin can change markup"}
            value={draft.markup}
            disabled={locked || !cost.edit || !item.unitCost}
            onChange={(e) => setDraft((d) => ({ ...d, markup: e.target.value }))}
            onBlur={() => {
              if (draft.markup === "" || !Number.isFinite(Number(draft.markup))) {
                setDraft((d) => ({ ...d, markup: item.markupPercent == null ? "" : String(item.markupPercent) }));
                return;
              }
              if (Number(draft.markup) !== item.markupPercent) update.mutate({ id: item.id, markupPercent: Number(draft.markup) });
            }}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
      </td>
      ) : null}
      <td className="tabular px-3 py-1.5 text-right font-medium">{money(item.total)}</td>
      <td className="px-2 py-1.5 text-right">
        {locked ? null : (
          <button
            type="button"
            onClick={() => remove.mutate({ id: item.id })}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            title="Delete line"
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------- deposit -------------------------------- */

/** Deposit % for this quote. Saves when you leave the box, not on every key. */
function DepositRows({
  quoteId,
  percent,
  deposit,
  balance,
  locked,
  onError,
}: {
  quoteId: number;
  percent: number;
  deposit: number;
  balance: number;
  locked: boolean;
  onError: (msg: string | null) => void;
}) {
  const update = useUpdateQuote();
  const [draft, setDraft] = React.useState(String(percent));
  React.useEffect(() => setDraft(String(percent)), [percent]);

  function save() {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) {
      setDraft(String(percent));
      onError("Deposit has to be between 0 and 100%.");
      return;
    }
    if (n === percent) return;
    onError(null);
    update.mutate({ id: quoteId, depositPercent: n }, { onError: (e) => onError(e.message) });
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground">Deposit</span>
        <span className="flex items-center gap-2">
          <Input
            className="tabular h-8 w-[70px] text-right"
            inputMode="decimal"
            value={draft}
            disabled={locked}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="tabular text-muted-foreground">% = {money(deposit)}</span>
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">Balance</span>
        <span className="tabular">{money(balance)}</span>
      </div>
    </>
  );
}

/* ------------------------------ add-line row ----------------------------- */

function AddLine({ quoteId }: { quoteId: number }) {
  const cost = useCostView();
  const add = useAddQuoteItem();
  const [form, setForm] = React.useState({
    kind: "supply",
    description: "",
    qty: "1",
    unit: "m2",
    unitPrice: "",
    unitCost: "",
  });

  async function submit() {
    if (!form.description) return;
    await add.mutateAsync({
      quoteId,
      kind: form.kind,
      description: form.description,
      qty: Number(form.qty) || 0,
      unit: form.unit,
      unitPrice: Number(form.unitPrice) || 0,
      unitCost: form.unitCost === "" ? null : Number(form.unitCost),
    });
    setForm({ kind: form.kind, description: "", qty: "1", unit: form.unit, unitPrice: "", unitCost: "" });
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-secondary/40 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">By hand</span>
        <span className="text-xs text-muted-foreground">for anything not on a list</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Select className="h-9 w-[110px]" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))}>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
        <Input
          className="min-w-[200px] flex-1"
          placeholder="Description, e.g. Supply & lay carpet, lounge + hall"
          value={form.description}
          onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <Input
          className="tabular w-[76px] text-right"
          placeholder="qty"
          value={form.qty}
          onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
        />
        <Select className="h-9 w-[84px]" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </Select>
        <Input
          className="tabular w-[96px] text-right"
          placeholder="sell"
          value={form.unitPrice}
          onChange={(e) => setForm((f) => ({ ...f, unitPrice: e.target.value }))}
        />
        {cost.edit ? (
        <Input
          className="tabular w-[96px] text-right"
          placeholder="cost"
          value={form.unitCost}
          onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
        />
        ) : null}
        <Button onClick={submit} disabled={!form.description || add.isPending}>
          {add.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Plus className="size-4" />}
          Add line
        </Button>
      </div>

    </div>
  );
}

/* --------------------------------- page --------------------------------- */

export default function QuoteBuilderPage() {
  const params = useParams();
  const [, navigate] = useLocation();
  const id = Number(params.id);
  const quote = useQuote(Number.isFinite(id) ? id : null);
  const update = useUpdateQuote();
  const send = useSendQuote();
  const approveDiscount = useApproveDiscount();
  const actor = useBootstrap().data?.actor;
  const cost = useCostView();
  const accept = useAcceptQuote();
  const decline = useDeclineQuote();
  const revise = useReviseQuote();
  const convert = useConvertQuote();

  const [error, setError] = React.useState<string | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [declineReason, setDeclineReason] = React.useState("");
  const [converting, setConverting] = React.useState(false);
  const [convertForm, setConvertForm] = React.useState({ title: "", furnitureOnSite: false, createTasks: true });
  const [notes, setNotes] = React.useState<string | null>(null);

  if (quote.isLoading) return <Loading label="Opening quote…" />;
  if (!quote.data) {
    return (
      <Page title="Quote not found">
        <Card>
          <Empty>
            That quote isn't there.{" "}
            <Link to="/quotes" className="text-primary hover:underline">
              Back to quotes
            </Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const q = quote.data;
  const locked = q.status === "accepted" || q.status === "declined" || q.status === "expired";
  const customer = q.contact ? `${q.contact.firstName} ${q.contact.lastName}` : q.company ? "" : "No customer yet";

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page
      title={`Quote ${q.ref}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Link to="/quotes" className="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowLeft className="size-3.5" />
            Quotes
          </Link>
          <span className="text-muted-foreground">·</span>
          <Badge colour={QUOTE_STATUS_COLOUR[q.status]}>{q.status}</Badge>
          <span className="text-muted-foreground">
            {customer}
            {q.company ? `${customer ? " · " : ""}billed to ${q.company.name}` : ""}
            {q.site ? ` · ${q.site.address}` : ""}
          </span>
        </span>
      }
      actions={
        <>
          {q.job ? (
            <Link to={`/jobs/${q.job.id}`}>
              <Button variant="outline">Job #{q.job.number}</Button>
            </Link>
          ) : null}
          {q.status === "needs_review" ? (
            <Button
              variant="outline"
              disabled={q.items.some((i: Item) => i.flagged) || update.isPending}
              title={q.items.some((i: Item) => i.flagged) ? "Fix every flagged line first" : undefined}
              onClick={() => run(() => update.mutateAsync({ id: q.id, status: "draft" }))}
            >
              <Check className="size-4" />
              Mark as reviewed
            </Button>
          ) : null}
          {q.discountNeedsApproval ? (
            <span className="text-xs text-amber-700">
              Discount {q.discountPercent}% is over your {q.discountLimit}% limit. An Admin needs to approve it.
            </span>
          ) : null}
          {q.discountPercent > 0 && actor?.role === "admin" && q.discountPercent > q.discountApprovedPercent && q.discountPercent > q.discountLimit ? (
            <Button variant="outline" onClick={() => run(() => approveDiscount.mutateAsync({ id: q.id }))} disabled={approveDiscount.isPending}>
              <Check className="size-4" />
              Approve {q.discountPercent}% discount
            </Button>
          ) : null}
          {q.status === "draft" ? (
            <Button variant="outline" onClick={() => run(() => send.mutateAsync({ id: q.id }))} disabled={send.isPending || q.discountNeedsApproval}>
              <Send className="size-4" />
              Mark as sent
            </Button>
          ) : null}
          {q.status === "sent" ? (
            <>
              <Button variant="outline" onClick={() => setDeclining(true)}>
                <X className="size-4" />
                Declined
              </Button>
              <Button onClick={() => run(() => accept.mutateAsync({ id: q.id }))} disabled={accept.isPending}>
                <Check className="size-4" />
                Accepted
              </Button>
            </>
          ) : null}
          {locked ? (
            <Button
              variant="outline"
              onClick={() =>
                run(async () => {
                  const next = await revise.mutateAsync({ id: q.id });
                  if (next?.id) navigate(`/quotes/${next.id}`);
                })
              }
              disabled={revise.isPending}
            >
              New version
            </Button>
          ) : null}
          {q.status === "accepted" && !q.job ? (
            <Button onClick={() => setConverting(true)}>
              Turn into a job
              <ArrowRight className="size-4" />
            </Button>
          ) : null}
        </>
      }
      wide
    >
      {error ? (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {q.company && !locked && !q.supervisorContactId ? (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3">
          <p className="mb-2 text-sm text-muted-foreground">No supervisor on this quote. Optional. Pick one if this company works through supervisors.</p>
          <SupervisorPicker
            companyId={q.company.id}
            value=""
            onChange={(v) => v && run(() => update.mutateAsync({ id: q.id, supervisorContactId: Number(v) }))}
          />
        </div>
      ) : null}

      {!q.contact && !q.company && !locked ? (
        <div className="mb-4">
          <QuoteCustomerPanel quoteId={q.id} />
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
        <Card>
          <CardHeader
            title="Lines"
            subtitle={locked ? "Locked. Make a new version to change the price." : "Prices come off the price book."}
          />
          {q.items.length === 0 ? (
            <Empty>No lines yet. Add the supply and the labour. Labour lines become the dispatches on the job.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[1000px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-2">Kind</th>
                    <th className="th px-2">Description</th>
                    <th className="th px-2 text-right">Qty</th>
                    <th className="th px-2">Unit</th>
                    <th className="th px-2 text-right">Sell</th>
                    {cost.show ? <th className="th px-2 text-right">Cost</th> : null}
                    {cost.show ? <th className="th px-2 text-right" title={`Standard price book markup is ${STANDARD_MARKUP} on cost`}>Markup</th> : null}
                    <th className="th text-right">Line total</th>
                    <th aria-label="Row actions" />
                  </tr>
                </thead>
                <tbody>
                  {q.items.map((item) => (
                    <LineRow key={item.id} item={item} locked={locked} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {locked ? null : (
            <>
              <ProductPicker quoteId={q.id} />
              <LabourPicker quoteId={q.id} category={q.job?.category ?? null} />
              <AddLine quoteId={q.id} />
            </>
          )}
        </Card>

        <QuoteAgentCard quoteId={q.id} locked={locked} />

        <QuoteBundlesCard quote={q} locked={locked} />
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Totals" />
            <div className="flex flex-col gap-2 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular">{money(q.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">GST 10%</span>
                <span className="tabular">{money(q.gst)}</span>
              </div>
              <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                <span>Total</span>
                <span className="tabular">{money(q.total)}</span>
              </div>
              <DepositRows
                quoteId={q.id}
                percent={q.depositPercent}
                deposit={q.deposit}
                balance={q.balance}
                locked={locked}
                onError={setError}
              />
            </div>
          </Card>

          {q.status === "accepted" && q.deposit > 0 ? (
            <Card>
              <CardHeader title="Deposit due" subtitle="What the customer pays before we order and book in" />
              <div className="flex flex-col gap-1.5 px-4 py-3 text-sm">
                <div className="flex justify-between text-base font-semibold">
                  <span>{q.depositPercent}% deposit</span>
                  <span className="tabular">{money(q.deposit)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Balance on completion</span>
                  <span className="tabular">{money(q.balance)}</span>
                </div>
                <div className="mt-2 rounded-md bg-secondary/60 px-3 py-2 text-[13px]">
                  <p className="font-medium">Bank transfer</p>
                  <p>Account name: {BANK.name}</p>
                  <p className="tabular">BSB: {BANK.bsb}</p>
                  <p className="tabular">Account: {BANK.account}</p>
                  <p className="tabular">Reference: {q.ref}</p>
                </div>
              </div>
            </Card>
          ) : null}

          {cost.show && q.estimatedCost != null ? (
          <Card>
            <CardHeader title="Your margin" subtitle="Staff with cost access only. Installers and customers never see this." />
            <div className="flex flex-col gap-2 px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estimated cost</span>
                <span className="tabular">{money(q.estimatedCost)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Margin</span>
                <span className="tabular font-medium">{money(q.estimatedMargin)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Margin %</span>
                <span
                  className="tabular font-medium"
                  style={{ color: (q.estimatedMarginPercent ?? 0) < 20 ? "#B4342A" : "#3F7D3A" }}
                >
                  {q.estimatedMarginPercent}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Only lines with a cost entered count. Blank cost reads as zero cost.
              </p>
            </div>
          </Card>
          ) : null}

          <QuotePeopleCard quoteId={q.id} locked={q.status === "accepted"} />

          <Card>
            <CardHeader title="Notes on the quote" />
            <div className="px-4 py-3">
              <Textarea
                rows={3}
                value={notes ?? q.notes ?? ""}
                disabled={locked}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes !== null && run(() => update.mutateAsync({ id: q.id, notes: notes || null }))}
                placeholder="Anything the customer should read: timing, prep, exclusions."
              />
            </div>
          </Card>

          {q.versions.length > 1 ? (
            <Card>
              <CardHeader title="Versions" subtitle={`${q.versions.length} versions of this quote`} />
              <ul className="divide-y divide-border">
                {q.versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      {v.id === q.id ? (
                        <span className="font-medium">{v.ref} (this one)</span>
                      ) : (
                        <Link to={`/quotes/${v.id}`} className="text-primary hover:underline">
                          {v.ref}
                        </Link>
                      )}
                      <Badge colour={QUOTE_STATUS_COLOUR[v.status]}>{v.status}</Badge>
                    </span>
                    <span className="tabular text-muted-foreground">{money(v.total)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="History" />
            {q.activity.length === 0 ? (
              <Empty>Nothing logged yet.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {q.activity.map((a) => (
                  <li key={a.id} className="px-4 py-2">
                    <p className="text-sm">{a.detail}</p>
                    <p className="text-xs text-muted-foreground">
                      {a.actorName} · {fmtDateTime(a.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Modal
        open={declining}
        onClose={() => setDeclining(false)}
        title="Customer knocked it back"
        subtitle="The reason gets logged so you can see why you're losing work."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeclining(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                run(async () => {
                  await decline.mutateAsync({ id: q.id, reason: declineReason });
                  setDeclining(false);
                  setDeclineReason("");
                })
              }
              disabled={!declineReason || decline.isPending}
            >
              Log it
            </Button>
          </>
        }
      >
        <Field label="Reason">
          <Textarea
            rows={3}
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Too dear · went with someone cheaper · put the job off · no answer"
          />
        </Field>
      </Modal>

      <Modal
        open={converting}
        onClose={() => setConverting(false)}
        title="Turn this quote into a job"
        subtitle="Supply lines become materials to order. Labour, prep and removal lines each become their own dispatch."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConverting(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                run(async () => {
                  const result = await convert.mutateAsync({
                    id: q.id,
                    title: convertForm.title || undefined,
                    furnitureOnSite: convertForm.furnitureOnSite,
                    createTasks: convertForm.createTasks,
                  });
                  setConverting(false);
                  if (result?.job?.id) navigate(`/jobs/${result.job.id}`);
                })
              }
              disabled={convert.isPending}
            >
              {convert.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Create the job
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Job title" hint="Blank uses the site address">
            <Input
              value={convertForm.title}
              onChange={(e) => setConvertForm((f) => ({ ...f, title: e.target.value }))}
              placeholder={q.site?.address ?? `Quote ${q.ref}`}
            />
          </Field>
          <label htmlFor={`quote_builder_cb1`} className="flex items-start gap-2 text-sm">
            <Checkbox id={`quote_builder_cb1`}
              className="mt-0.5"
              checked={convertForm.furnitureOnSite}
              onChange={(e) => setConvertForm((f) => ({ ...f, furnitureOnSite: e.target.checked }))}
            />
            <span>
              Furniture is on site
              <span className="block text-xs text-muted-foreground">
                Forces every install dispatch to 2 men. Nobody can be sent on their own.
              </span>
            </span>
          </label>
          <label htmlFor={`quote_builder_cb2`} className="flex items-start gap-2 text-sm">
            <Checkbox id={`quote_builder_cb2`}
              className="mt-0.5"
              checked={convertForm.createTasks}
              onChange={(e) => setConvertForm((f) => ({ ...f, createTasks: e.target.checked }))}
            />
            <span>
              Create the dispatches from the labour lines
              <span className="block text-xs text-muted-foreground">
                They land unassigned on the schedule board, ready to offer out.
              </span>
            </span>
          </label>
        </div>
      </Modal>
    </Page>
  );
}
