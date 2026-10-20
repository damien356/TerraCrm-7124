import * as React from "react";
import { Link, useLocation } from "wouter";
import { Plus } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { useDebounced } from "../components/quote-pickers";
import { TradeProductsTab } from "../components/trade/products-tab";
import { ErrorLine, OffsetBadge, SaleState, TRADE_CATEGORIES, auDate, auDateTime, m2, qtyText, todayYmd } from "../components/trade/shared";
import { useSuppliers } from "../queries/suppliers";
import { useJobs } from "../queries/jobs";
import {
  useCreateDraft,
  useMovements,
  useOpenOffsets,
  usePostStock,
  useSaveTradeSettings,
  useStockLevels,
  useTradeBuyers,
  useTradeCashTotals,
  useTradeProducts,
  useTradeSales,
  useTradeSettings,
} from "../queries/trade";

/**
 * TRADE SALES (notes 18.65). Admin only: the nav hides it from Office and
 * every procedure behind it refuses anyone but Admin.
 *
 * Terra sells materials to installers, builders and other buyers. The buyer
 * pays by card, bank or cash, or (installers only, same entity verified and a
 * signed agreement) the amount comes off their labour bill. Nothing here ever
 * makes a payment or writes to Xero; it records what happened.
 */

const TABS = [
  { key: "sales", label: "Sales" },
  { key: "offsets", label: "Open offsets" },
  { key: "products", label: "Trade list" },
  { key: "stock", label: "Stock" },
  { key: "settings", label: "Settings" },
  { key: "cash", label: "Admin cash" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function TradePage() {
  const first = (new URLSearchParams(window.location.search).get("tab") ?? "sales") as TabKey;
  const [tab, setTab] = React.useState<TabKey>(TABS.some((t) => t.key === first) ? first : "sales");
  const settings = useTradeSettings();
  const pick = (k: TabKey) => {
    setTab(k);
    window.history.replaceState(null, "", k === "sales" ? window.location.pathname : `${window.location.pathname}?tab=${k}`);
  };

  return (
    <Page title="Trade sales" subtitle="Materials sold to installers and other buyers. Admin only. Records payments and offsets, never makes them.">
      {settings.data && !settings.data.enabled ? (
        <p className="mb-4 rounded-md border border-border bg-secondary px-3 py-2 text-sm text-muted-foreground">
          Trade sales is switched off. New sales, finalising, new offsets and offset confirms are paused. Pay links already sent still work.
        </p>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => pick(t.key)}
            className={
              tab === t.key
                ? "rounded-md bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground"
                : "rounded-md border border-border px-3.5 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "sales" ? <SalesTab /> : null}
      {tab === "offsets" ? <OffsetsTab /> : null}
      {tab === "products" ? <TradeProductsTab /> : null}
      {tab === "stock" ? <StockTab /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
      {tab === "cash" ? <CashTab /> : null}
    </Page>
  );
}

/* --------------------------------- sales --------------------------------- */

function SalesTab() {
  const [status, setStatus] = React.useState<"" | "draft" | "finalised" | "cancelled">("");
  const list = useTradeSales(status ? { status } : {});
  const settings = useTradeSettings();
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <CardHeader
        title="Sales"
        subtitle="Owing is after credits, cash and confirmed offsets."
        action={
          <div className="flex items-center gap-2">
            <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="">All</option>
              <option value="draft">Drafts</option>
              <option value="finalised">Finalised</option>
              <option value="cancelled">Cancelled</option>
            </Select>
            <Button size="sm" disabled={!settings.data?.enabled} onClick={() => setOpen(true)}>
              <Plus className="size-4" />
              New sale
            </Button>
          </div>
        }
      />
      {list.isLoading ? <Loading /> : null}
      <ErrorLine error={list.error} />
      {list.data && !list.data.length ? <Empty>No trade sales yet. Tick a card as a trade buyer, then start a sale.</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4 py-2 text-left">Invoice</th>
                <th className="th px-4 py-2 text-left">Buyer</th>
                <th className="th px-4 py-2 text-left">Date</th>
                <th className="th px-4 py-2 text-right">Total</th>
                <th className="th px-4 py-2 text-right">Owing</th>
                <th className="th px-4 py-2 text-left">Due</th>
                <th className="th px-4 py-2 text-left">State</th>
                <th className="th px-4 py-2 text-left">Goods</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <Link href={`/finance/trade/${s.id}`} className="font-medium text-[var(--gold-deep)] hover:underline">
                      {s.invoiceRef ?? s.ref}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {s.buyerName}
                    <span className="ml-1.5 text-xs text-muted-foreground">{s.buyerKind}</span>
                  </td>
                  <td className="px-4 py-2">{auDate(s.finalisedAt ?? s.createdAt)}</td>
                  <td className="tabular px-4 py-2 text-right">{m2(s.total)}</td>
                  <td className={`tabular px-4 py-2 text-right ${s.money.balance < -0.005 ? "text-destructive" : ""}`}>
                    {s.status === "finalised" ? m2(s.money.balance) : ""}
                  </td>
                  <td className="px-4 py-2">{s.status === "finalised" ? (s.dueDate ? auDate(s.dueDate) : "Before collection") : ""}</td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      <SaleState state={s.status === "finalised" ? s.money.state : s.status} />
                      <OffsetBadge status={s.offsetState} />
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{s.fulfilment === "collected" ? "Collected" : s.fulfilment === "dispatched" ? "Dispatched" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <NewSaleModal open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}

function NewSaleModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const buyers = useTradeBuyers();
  const create = useCreateDraft();
  const [, navigate] = useLocation();
  const [buyerId, setBuyerId] = React.useState(0);
  const [settleBy, setSettleBy] = React.useState<"pay" | "deduct">("pay");
  const active = (buyers.data ?? []).filter((b) => b.active);
  const chosen = active.find((b) => b.id === buyerId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New trade sale"
      subtitle="Starts a draft. Prices are worked out when lines are added and fixed when you finalise."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={!chosen || create.isPending}
            onClick={async () => {
              const id = await create.mutateAsync({ buyerId, settleBy: chosen?.kind === "installer" ? settleBy : "pay" });
              onClose();
              navigate(`/finance/trade/${id}`);
            }}
          >
            {create.isPending ? <Spinner /> : null}
            Start draft
          </Button>
        </div>
      }
    >
      {buyers.isLoading ? <Loading /> : null}
      {buyers.data && !active.length ? (
        <p className="text-sm text-muted-foreground">No trade buyers yet. Open a contact, company or installer card and tick Trade buyer on its Trade tab.</p>
      ) : null}
      {active.length ? (
        <div className="flex flex-col gap-3">
          <Field label="Buyer">
            <Select value={buyerId} onChange={(e) => setBuyerId(Number(e.target.value))}>
              <option value={0}>Pick a buyer</option>
              {active.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name} ({b.kind}){b.owing > 0 ? `, owing ${m2(b.owing)}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          {chosen?.kind === "installer" ? (
            <Field label="How it is settled" hint="Taking it off a bill needs the same entity check and a signed agreement.">
              <Select value={settleBy} onChange={(e) => setSettleBy(e.target.value as "pay" | "deduct")}>
                <option value="pay">Buyer pays</option>
                <option value="deduct">Take it off their bill</option>
              </Select>
            </Field>
          ) : null}
          {chosen && !chosen.categories.length ? <p className="text-sm text-[var(--warning)]">This buyer has no categories ticked, so no product can go on the sale yet.</p> : null}
        </div>
      ) : null}
      <ErrorLine error={create.error} />
    </Modal>
  );
}

/* -------------------------------- offsets -------------------------------- */

function OffsetsTab() {
  const list = useOpenOffsets();
  return (
    <Card>
      <CardHeader title="Open offsets" subtitle="Proposed or approved. The bill they sit on cannot be marked paid or scheduled until each is confirmed or cancelled." />
      {list.isLoading ? <Loading /> : null}
      <ErrorLine error={list.error} />
      {list.data && !list.data.length ? <Empty>No offsets waiting.</Empty> : null}
      {list.data?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="th px-4 py-2 text-left">Sale</th>
              <th className="th px-4 py-2 text-left">Buyer</th>
              <th className="th px-4 py-2 text-right">Amount</th>
              <th className="th px-4 py-2 text-left">State</th>
              <th className="th px-4 py-2 text-left">Proposed</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((o) => (
              <tr key={o.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  <Link href={`/finance/trade/${o.saleId}`} className="font-medium text-[var(--gold-deep)] hover:underline">
                    {o.ref}
                  </Link>
                </td>
                <td className="px-4 py-2">{o.buyerName}</td>
                <td className="tabular px-4 py-2 text-right">{m2(o.amount)}</td>
                <td className="px-4 py-2">
                  <span className="flex flex-wrap gap-1">
                    <OffsetBadge status={o.status} />
                    {o.conflict ? <Badge colour="#B23B2C">Flagged</Badge> : null}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">
                  {o.proposedByName}, {auDateTime(o.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Card>
  );
}

/* --------------------------------- stock --------------------------------- */

type StockKind = "opening" | "received" | "job_used" | "adjustment" | "stocktake";

function StockTab() {
  const levels = useStockLevels();
  const [productId, setProductId] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const rows = levels.data?.levels ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Stock on hand"
          subtitle="From the stock ledger only. A count is never made up: a product with no opening count shows what the ledger says."
          action={
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="size-4" />
              Stock entry
            </Button>
          }
        />
        {levels.isLoading ? <Loading /> : null}
        <ErrorLine error={levels.error} />
        {levels.data && !rows.length ? <Empty>No stock entries yet. Start with an opening count.</Empty> : null}
        {rows.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4 py-2 text-left">Product</th>
                <th className="th px-4 py-2 text-left">Supplier</th>
                <th className="th px-4 py-2 text-right">On hand</th>
                <th className="th px-4 py-2 text-right">Value at cost</th>
                <th aria-hidden="true" className="th px-4 py-2 text-left" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId} className={`border-b border-border last:border-0 ${productId === r.productId ? "bg-secondary" : ""}`}>
                  <td className="px-4 py-2">
                    <button type="button" className="text-left font-medium text-[var(--gold-deep)] hover:underline" onClick={() => setProductId(r.productId)}>
                      {r.name}
                    </button>
                    {r.detail ? <span className="ml-1.5 text-xs text-muted-foreground">{r.detail}</span> : null}
                  </td>
                  <td className="px-4 py-2">{r.supplier}</td>
                  <td className={`tabular px-4 py-2 text-right ${r.negative ? "font-semibold text-destructive" : ""}`}>
                    {qtyText(r.onHand)} {r.unit}
                  </td>
                  <td className="tabular px-4 py-2 text-right">{r.value != null ? m2(r.value) : "No cost"}</td>
                  <td className="px-4 py-2">
                    <span className="flex flex-wrap gap-1">
                      {r.negative ? <Badge colour="#B23B2C">Below zero, count it</Badge> : null}
                      {!r.hasOpening ? <Badge>No opening count</Badge> : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      {productId ? <MovementsCard productId={productId} /> : null}
      <StockEntryModal open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function MovementsCard({ productId }: { productId: number }) {
  const list = useMovements(productId);
  const post = usePostStock();
  const [undo, setUndo] = React.useState<{ id: number; reason: string } | null>(null);
  return (
    <Card>
      <CardHeader title="Ledger" subtitle="Nothing is ever deleted. A mistake is fixed with a reversal entry." />
      {list.isLoading ? <Loading /> : null}
      {list.data && !list.data.length ? <Empty>No entries.</Empty> : null}
      {list.data?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="th px-4 py-2 text-left">When</th>
              <th className="th px-4 py-2 text-left">Entry</th>
              <th className="th px-4 py-2 text-right">Qty</th>
              <th className="th px-4 py-2 text-right">After</th>
              <th className="th px-4 py-2 text-left">Note</th>
              <th aria-hidden="true" className="th px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {list.data.map((m) => (
              <tr key={m.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{auDateTime(m.createdAt)}</td>
                <td className="px-4 py-2">
                  {m.label}
                  {m.saleRef && m.saleId ? (
                    <Link href={`/finance/trade/${m.saleId}`} className="ml-1.5 text-[var(--gold-deep)] hover:underline">
                      {m.saleRef}
                    </Link>
                  ) : null}
                </td>
                <td className="tabular px-4 py-2 text-right">{m.qty > 0 ? `+${qtyText(m.qty)}` : qtyText(m.qty)}</td>
                <td className="tabular px-4 py-2 text-right">{m.balanceAfter != null ? qtyText(m.balanceAfter) : ""}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  {[m.note, m.byName].filter(Boolean).join(". ")}
                  {m.reversed ? " (reversed)" : ""}
                </td>
                <td className="px-4 py-2 text-right">
                  {!m.reversed && m.kind !== "reversal" && !m.saleId ? (
                    <Button size="sm" variant="ghost" onClick={() => setUndo({ id: m.id, reason: "" })}>
                      Reverse
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Modal
        open={!!undo}
        onClose={() => setUndo(null)}
        title="Reverse this entry"
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setUndo(null)}>
              Close
            </Button>
            <Button
              size="sm"
              disabled={!undo?.reason.trim() || post.isPending}
              onClick={async () => {
                await post.mutateAsync({ kind: "reversal", movementId: undo!.id, reason: undo!.reason.trim() });
                setUndo(null);
              }}
            >
              Reverse
            </Button>
          </div>
        }
      >
        <Field label="Why">
          <Input value={undo?.reason ?? ""} onChange={(e) => setUndo(undo ? { ...undo, reason: e.target.value } : null)} />
        </Field>
        <ErrorLine error={post.error} />
      </Modal>
    </Card>
  );
}

function StockEntryModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [search, setSearch] = React.useState("");
  const term = useDebounced(search);
  const products = useTradeProducts({ search: term || undefined, listedOnly: false, limit: 30 }, open && term.length >= 2);
  const [product, setProduct] = React.useState<{ id: number; label: string; onHand: number; unit: string } | null>(null);
  const [kind, setKind] = React.useState<StockKind>("opening");
  const [qty, setQty] = React.useState("");
  const [supplier, setSupplier] = React.useState("");
  const [ref, setRef] = React.useState("");
  const [date, setDate] = React.useState(todayYmd());
  const [note, setNote] = React.useState("");
  const [jobId, setJobId] = React.useState(0);
  const post = usePostStock();

  const reset = () => {
    setProduct(null);
    setQty("");
    setNote("");
    setRef("");
    setJobId(0);
    post.reset();
  };
  const n = Number(qty);
  const valid =
    !!product &&
    qty.trim() !== "" &&
    Number.isFinite(n) &&
    (kind === "adjustment" ? n !== 0 && note.trim() !== "" : kind === "stocktake" ? n >= 0 : n > 0) &&
    (kind !== "received" || (supplier.trim() !== "" && ref.trim() !== "")) &&
    (kind !== "job_used" || jobId > 0);

  const submit = async () => {
    if (!product) return;
    if (kind === "opening") await post.mutateAsync({ kind, productId: product.id, qty: n, note: note || undefined });
    else if (kind === "received") await post.mutateAsync({ kind, productId: product.id, qty: n, supplier: supplier.trim(), ref: ref.trim(), date, note: note || undefined });
    else if (kind === "job_used") await post.mutateAsync({ kind, productId: product.id, qty: n, jobId, note: note || undefined });
    else if (kind === "adjustment") await post.mutateAsync({ kind, productId: product.id, qty: n, reason: note.trim() });
    else await post.mutateAsync({ kind, productId: product.id, counted: n, note: note || undefined, expectOnHand: product.onHand });
    reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-xl"
      title="Stock entry"
      subtitle="Received needs the supplier and their delivery ref. Used on job only records the stock; it never changes the job."
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" disabled={!valid || post.isPending} onClick={submit}>
            {post.isPending ? <Spinner /> : null}
            Save entry
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {product ? (
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
            <span>
              {product.label} <span className="text-muted-foreground">(on hand {qtyText(product.onHand)} {product.unit})</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => setProduct(null)}>
              Change
            </Button>
          </div>
        ) : (
          <Field label="Product">
            <Input placeholder="Type 2 letters to search" value={search} onChange={(e) => setSearch(e.target.value)} />
            {products.data?.length ? (
              <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border text-sm">
                {products.data.map((p) => (
                  <li key={p.productId}>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left hover:bg-secondary"
                      onClick={() => setProduct({ id: p.productId, label: [p.name, p.detail].filter(Boolean).join(", "), onHand: p.onHand ?? 0, unit: p.unit ?? "" })}
                    >
                      {p.name} <span className="text-muted-foreground">{p.detail}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Entry">
            <Select value={kind} onChange={(e) => setKind(e.target.value as StockKind)}>
              <option value="opening">Opening count</option>
              <option value="received">Stock received</option>
              <option value="job_used">Used on job</option>
              <option value="adjustment">Adjustment (plus or minus)</option>
              <option value="stocktake">Stocktake (counted)</option>
            </Select>
          </Field>
          <Field label={kind === "stocktake" ? "Counted" : kind === "adjustment" ? "Change (use minus to take off)" : "Quantity"}>
            <Input type="number" step="any" value={qty} onChange={(e) => setQty(e.target.value)} />
          </Field>
        </div>
        {kind === "received" ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Supplier">
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} />
            </Field>
            <Field label="Delivery or invoice ref">
              <Input value={ref} onChange={(e) => setRef(e.target.value)} />
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>
        ) : null}
        {kind === "job_used" ? (
          <JobPicker jobId={jobId} onPick={setJobId} />
        ) : null}
        <Field label={kind === "adjustment" ? "Reason" : "Note (optional)"}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {kind === "stocktake" && product ? (
          <p className="text-xs text-muted-foreground">The ledger says {qtyText(product.onHand)}. Saving posts the difference. If someone posts in the meantime, it asks you to recount.</p>
        ) : null}
        <ErrorLine error={post.error} />
      </div>
    </Modal>
  );
}

function JobPicker({ jobId, onPick }: { jobId: number; onPick: (id: number) => void }) {
  const [search, setSearch] = React.useState("");
  const term = useDebounced(search);
  return (
    <Field label="Job">
      <Input placeholder="Search job number or address" value={search} onChange={(e) => setSearch(e.target.value)} />
      {term.length >= 2 ? <JobOptions term={term} jobId={jobId} onPick={onPick} /> : null}
    </Field>
  );
}

function JobOptions({ term, jobId, onPick }: { term: string; jobId: number; onPick: (id: number) => void }) {
  const jobs = useJobs({ search: term });
  if (!jobs.data?.length) return jobs.isLoading ? <Loading /> : <p className="mt-1 text-xs text-muted-foreground">No job matches.</p>;
  return (
    <Select className="mt-1" value={jobId} onChange={(e) => onPick(Number(e.target.value))}>
      <option value={0}>Pick the job</option>
      {jobs.data.slice(0, 30).map((j) => (
        <option key={j.id} value={j.id}>
          {j.displayNumber ?? j.number} {j.site?.address ?? j.title}
        </option>
      ))}
    </Select>
  );
}

/* ------------------------------- settings -------------------------------- */

function SettingsTab() {
  const s = useTradeSettings();
  const suppliers = useSuppliers();
  const save = useSaveTradeSettings();
  const [form, setForm] = React.useState<{ enabled: boolean; markupPct: string; categories: string[]; supplierIds: number[]; nextNumber: string } | null>(null);

  React.useEffect(() => {
    if (!s.data) return;
    setForm({
      enabled: s.data.enabled,
      markupPct: String(s.data.markupPct),
      categories: s.data.categories,
      supplierIds: s.data.supplierIds,
      nextNumber: String(s.data.nextNumber),
    });
  }, [s.data]);

  if (s.isLoading || !form) return <Loading />;
  const mk = Number(form.markupPct);
  return (
    <Card>
      <CardHeader
        title="Trade settings"
        subtitle={s.data?.updatedByName ? `Last changed by ${s.data.updatedByName}, ${auDateTime(s.data.updatedAt)}` : "Applies to new drafts. A finalised invoice keeps what it was sold at."}
      />
      <div className="flex flex-col gap-4 p-4">
        <label htmlFor="trade_cb5" className="flex items-center gap-2 text-sm font-medium">
          <Checkbox id="trade_cb5" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Trade sales on
        </label>
        <p className="-mt-2 text-xs text-muted-foreground">
          Off stops new sales, finalising, new offsets and offset confirms. Records stay readable, pay links and card payments keep working, and the bill payment guard never switches
          off.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Trade markup %" hint="On standard cost ex GST, and once on each supplier fee. Not used where a fixed trade price is set.">
            <Input type="number" step="0.1" min={0} max={300} value={form.markupPct} onChange={(e) => setForm({ ...form, markupPct: e.target.value })} />
          </Field>
          <Field label="Next invoice number" hint="Only moves up. Numbers already used are never given out again.">
            <Input type="number" value={form.nextNumber} onChange={(e) => setForm({ ...form, nextNumber: e.target.value })} />
          </Field>
        </div>
        <div>
          <p className="label-xs mb-1">Categories on the trade list</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {TRADE_CATEGORIES.map((c) => (
              <label key={c.name} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={form.categories.includes(c.name)}
                  onChange={(e) => setForm({ ...form, categories: e.target.checked ? [...form.categories, c.name] : form.categories.filter((x) => x !== c.name) })}
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>
        <div>
          <p className="label-xs mb-1">Suppliers on the trade list</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {(suppliers.data ?? []).map((sp) => (
              <label key={sp.id} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={form.supplierIds.includes(sp.id)}
                  onChange={(e) => setForm({ ...form, supplierIds: e.target.checked ? [...form.supplierIds, sp.id] : form.supplierIds.filter((x) => x !== sp.id) })}
                />
                {sp.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">A product is listed when it, its category or its supplier is ticked. Excluding a product on the trade list always wins.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={save.isPending || !Number.isFinite(mk)}
            onClick={() =>
              save.mutate({
                enabled: form.enabled,
                markupPct: mk,
                categories: form.categories,
                supplierIds: form.supplierIds,
                nextNumber: Number(form.nextNumber) || undefined,
              })
            }
          >
            {save.isPending ? <Spinner /> : null}
            Save settings
          </Button>
          {save.isSuccess ? <span className="text-xs text-[var(--success)]">Saved</span> : null}
        </div>
        <ErrorLine error={save.error} />
      </div>
    </Card>
  );
}

/* ------------------------------- Admin cash ------------------------------ */

function CashTab() {
  const today = todayYmd();
  const [from, setFrom] = React.useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = React.useState(today);
  const q = useTradeCashTotals(from, to);
  const d = q.data;
  return (
    <Card>
      <CardHeader
        title="Admin cash from trade sales"
        subtitle="Money that actually came in, by the date it was paid. Offsets are shown apart: they reduce what Terra pays an installer, they are not cash in."
        action={
          <div className="flex items-center gap-2">
            <Input type="date" className="w-40" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span className="text-sm text-muted-foreground">to</span>
            <Input type="date" className="w-40" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        }
      />
      {q.isLoading ? <Loading /> : null}
      <ErrorLine error={q.error} />
      {d ? (
        <div className="grid gap-3 p-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Cash in" value={m2(d.cashIn)} />
          <Stat label="Refunds out" value={m2(d.refunds)} />
          <Stat label="Net cash" value={m2(d.netCash)} tone="success" />
          <Stat label="Card" value={m2(d.byMethod.card)} />
          <Stat label="Bank" value={m2(d.byMethod.bank)} />
          <Stat label="Cash" value={m2(d.byMethod.cash)} />
          <Stat label="Offsets (not cash)" value={m2(d.nonCashOffsets)} hint="Taken off installer bills" />
        </div>
      ) : null}
    </Card>
  );
}
