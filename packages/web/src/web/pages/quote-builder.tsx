import * as React from "react";
import { Link, useLocation, useParams } from "wouter";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Plus, Send, Trash2, X } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useAcceptQuote,
  useAddQuoteItem,
  useAddQuoteProduct,
  useConvertQuote,
  useDeclineQuote,
  useQuote,
  useRemoveQuoteItem,
  useReviseQuote,
  useSendQuote,
  useUpdateQuote,
  useUpdateQuoteItem,
} from "../queries/quotes";
import { useProducts } from "../queries/settings";
import { QUOTE_STATUS_COLOUR } from "./quotes";

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const KINDS = ["supply", "labour", "prep", "removal", "accessory", "other"];
const UNITS = ["m2", "lm", "each", "hour", "job"];

function fmtDateTime(value: Date | string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
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
  total: number;
  flagged?: boolean;
  flagReason?: string | null;
  voicePhrase?: string | null;
};

function LineRow({ item, locked }: { item: Item; locked: boolean }) {
  const update = useUpdateQuoteItem();
  const remove = useRemoveQuoteItem();
  const products = useProducts();
  const [fixProductId, setFixProductId] = React.useState("");
  const [draft, setDraft] = React.useState({
    description: item.description,
    qty: String(item.qty),
    unitPrice: String(item.unitPrice),
    unitCost: item.unitCost == null ? "" : String(item.unitCost),
  });

  React.useEffect(() => {
    setDraft({
      description: item.description,
      qty: String(item.qty),
      unitPrice: String(item.unitPrice),
      unitCost: item.unitCost == null ? "" : String(item.unitCost),
    });
  }, [item.id, item.description, item.qty, item.unitPrice, item.unitCost]);

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
      </td>
      <td className="px-2 py-1.5">
        {item.flagged ? (
          <span className="mb-1 flex items-center gap-1 text-xs text-[#D08A1E]" title={item.flagReason ?? "Needs review"}>
            <AlertTriangle className="size-3.5" /> {item.flagReason ?? "Needs review"}
          </span>
        ) : null}
        {item.flagged && item.voicePhrase ? (
          <div className="mb-1 flex items-center gap-1.5">
            <Select
              className="h-7 min-w-[220px] flex-1 text-xs"
              value={fixProductId}
              disabled={locked}
              onChange={(e) => setFixProductId(e.target.value)}
            >
              <option value="">Pick the right product…</option>
              {(products.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.brand, p.range, p.colour].filter(Boolean).join(" — ")}
                  {p.sellPrice ? ` · ${money(p.sellPrice)}/${p.unit}` : ""}
                </option>
              ))}
            </Select>
            <Button
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!fixProductId || update.isPending}
              onClick={() => {
                const chosen = (products.data ?? []).find((p) => String(p.id) === fixProductId);
                if (!chosen) return;
                update.mutate({
                  id: item.id,
                  productId: chosen.id,
                  description: [chosen.brand, chosen.range, chosen.colour].filter(Boolean).join(", ") || item.description,
                  unit: chosen.unit || item.unit,
                  unitPrice: chosen.sellPrice ?? item.unitPrice,
                  unitCost: chosen.costPrice ?? item.unitCost,
                  flagged: false,
                  flagReason: null,
                });
                setFixProductId("");
              }}
            >
              <Check className="size-3.5" /> Confirm
            </Button>
          </div>
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
      <td className="px-2 py-1.5">
        <Input
          className="tabular h-8 w-[92px] text-right"
          placeholder="cost"
          value={draft.unitCost}
          disabled={locked}
          onChange={(e) => setDraft((d) => ({ ...d, unitCost: e.target.value }))}
          onBlur={() =>
            update.mutate({ id: item.id, unitCost: draft.unitCost === "" ? null : Number(draft.unitCost) })
          }
        />
      </td>
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

/* ------------------------------ add-line row ----------------------------- */

function AddLine({ quoteId }: { quoteId: number }) {
  const add = useAddQuoteItem();
  const addProduct = useAddQuoteProduct();
  const products = useProducts();
  const [form, setForm] = React.useState({
    kind: "supply",
    description: "",
    qty: "1",
    unit: "m2",
    unitPrice: "",
    unitCost: "",
  });
  const [productId, setProductId] = React.useState("");
  const [productQty, setProductQty] = React.useState("1");

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
          placeholder="Description — e.g. Supply & lay carpet, lounge + hall"
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
        <Input
          className="tabular w-[96px] text-right"
          placeholder="cost"
          value={form.unitCost}
          onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))}
        />
        <Button onClick={submit} disabled={!form.description || add.isPending}>
          {add.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Plus className="size-4" />}
          Add line
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Select className="h-9 min-w-[280px] flex-1" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">…or pull a product off the price list</option>
          {(products.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {[p.brand, p.range, p.colour].filter(Boolean).join(" — ")}
              {p.sellPrice ? ` · ${money(p.sellPrice)}/${p.unit}` : ""}
            </option>
          ))}
        </Select>
        <Input
          className="tabular w-[76px] text-right"
          value={productQty}
          onChange={(e) => setProductQty(e.target.value)}
        />
        <Button
          variant="outline"
          disabled={!productId || addProduct.isPending}
          onClick={async () => {
            await addProduct.mutateAsync({ quoteId, productId: Number(productId), qty: Number(productQty) || 1 });
            setProductId("");
            setProductQty("1");
          }}
        >
          Add product
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
  const customer = q.contact ? `${q.contact.firstName} ${q.contact.lastName}` : "No customer set";
  const deposit = q.total * (q.depositPercent / 100);

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
      title={`Quote #${q.number}${q.version > 1 ? ` · v${q.version}` : ""}`}
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
            {q.company ? ` · billed to ${q.company.name}` : ""}
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
          {q.status === "draft" ? (
            <Button variant="outline" onClick={() => run(() => send.mutateAsync({ id: q.id }))} disabled={send.isPending}>
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

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title="Lines"
            subtitle={locked ? "Locked — make a new version to change the price." : "Cost is yours only. It never leaves this screen."}
          />
          {q.items.length === 0 ? (
            <Empty>No lines yet. Add the supply and the labour — labour lines become the dispatches on the job.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-2">Kind</th>
                    <th className="th px-2">Description</th>
                    <th className="th px-2 text-right">Qty</th>
                    <th className="th px-2">Unit</th>
                    <th className="th px-2 text-right">Sell</th>
                    <th className="th px-2 text-right">Cost</th>
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
          {locked ? null : <AddLine quoteId={q.id} />}
        </Card>

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
              <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                <span className="text-muted-foreground">Deposit</span>
                <span className="flex items-center gap-2">
                  <Input
                    className="tabular h-8 w-[70px] text-right"
                    value={String(q.depositPercent)}
                    disabled={locked}
                    onChange={(e) =>
                      update.mutate({ id: q.id, depositPercent: Number(e.target.value) || 0 })
                    }
                  />
                  <span className="tabular text-muted-foreground">% = {money(deposit)}</span>
                </span>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Your margin" subtitle="Admin only. Installers and customers never see this." />
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
                  style={{ color: q.estimatedMarginPercent < 20 ? "#B4342A" : "#3F7D3A" }}
                >
                  {q.estimatedMarginPercent}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Only lines with a cost entered count. Blank cost reads as zero cost.
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Notes on the quote" />
            <div className="px-4 py-3">
              <Textarea
                rows={3}
                value={notes ?? q.notes ?? ""}
                disabled={locked}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => notes !== null && run(() => update.mutateAsync({ id: q.id, notes: notes || null }))}
                placeholder="Anything the customer should read — timing, prep, exclusions."
              />
            </div>
          </Card>

          {q.versions.length > 1 ? (
            <Card>
              <CardHeader title="Versions" subtitle={`${q.versions.length} versions of quote #${q.number}`} />
              <ul className="divide-y divide-border">
                {q.versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span className="flex items-center gap-2">
                      {v.id === q.id ? (
                        <span className="font-medium">v{v.version} (this one)</span>
                      ) : (
                        <Link to={`/quotes/${v.id}`} className="text-primary hover:underline">
                          v{v.version}
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
              placeholder={q.site?.address ?? `Quote #${q.number}`}
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
                Forces every install dispatch to 2 men — nobody can be sent on their own.
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
