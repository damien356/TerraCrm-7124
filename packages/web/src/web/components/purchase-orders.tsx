import * as React from "react";
import { FileText, Info, Mail, Pencil, Plus, Send, Trash2, TriangleAlert, X } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { moneyExact } from "../lib/money";
import {
  type PoPreviewInput,
  useCancelPo,
  useCreatePo,
  useFeeRules,
  useMarkPoSent,
  usePoPdf,
  usePoPreview,
  usePurchasingForJob,
  useRemovePoDraft,
  useSendPo,
  useStoredPoPdfUrl,
  useUpdatePo,
} from "../queries/purchasing";

/**
 * PURCHASE ORDERS ON A JOB.
 *
 * 4113-A, 4113-B. Costed at what Terra pays today, so a live special lowers
 * the PO and never the customer's price. Sent from team@ with the PDF, asking
 * the supplier to quote the PO number and send the invoice to billing@. That
 * is what lets the email agent match the invoice back to this job.
 */

type ForJob = NonNullable<ReturnType<typeof usePurchasingForJob>["data"]>;
type Po = ForJob["pos"][number];
type Supplier = ForJob["suppliers"][number];
type Kind = "goods" | "charge" | "freight";
type LineDraft = {
  key: string;
  kind: Kind;
  jobMaterialId: number | null;
  productId: number | null;
  description: string;
  qty: string;
  unit: string;
  /** Typed cost ex GST. Empty means use the price book. */
  cost: string;
};

const PO_STATUS: Record<string, { label: string; colour: string }> = {
  draft: { label: "Draft", colour: "#7A736D" },
  sent: { label: "Sent", colour: "#4A7FA5" },
  invoiced: { label: "Invoiced", colour: "#3F7D3A" },
  cancelled: { label: "Cancelled", colour: "#A9A29B" },
};

export const PAIR_META: Record<string, { label: string; colour: string }> = {
  matched: { label: "Matched", colour: "#3F7D3A" },
  different: { label: "Price different", colour: "#D08A1E" },
  checked: { label: "Checked", colour: "#4A7FA5" },
  no_po: { label: "No PO", colour: "#C0603F" },
  no_invoice: { label: "No invoice yet", colour: "#7A736D" },
};

const UNITS = ["m2", "lm", "each", "roll", "box"];
const unitLabel = (u: string) => (u === "m2" ? "m²" : u);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
let keySeq = 0;
const nextKey = () => `l${++keySeq}`;

/** "3 Oct", in the browser's own time zone. A UTC slice would show the day before for anything sent before 10am. */
const dayOf = (d: Date | string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

function pairOf(i: { matchStatus: string; checkedAt: Date | string | null; poId: number | null }) {
  if (!i.poId) return "no_po";
  if (i.matchStatus === "matched") return "matched";
  if (i.matchStatus === "different") return i.checkedAt ? "checked" : "different";
  return "no_po";
}

/** Open a PDF in a new tab. The tab is opened first, before the wait, so the browser doesn't block it. */
export async function openPdf(get: () => Promise<{ base64?: string; url?: string; filename?: string }>) {
  const w = window.open("about:blank", "_blank");
  try {
    const r = await get();
    let href = r.url ?? "";
    if (r.base64) {
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    }
    if (w) w.location.href = href;
    else window.location.href = href;
  } catch (e) {
    w?.close();
    throw e;
  }
}

/* ================================== card ================================== */

export function PurchaseOrdersCard({ jobId }: { jobId: number }) {
  const q = usePurchasingForJob(jobId);
  const [editing, setEditing] = React.useState<Po | "new" | null>(null);
  const [sendingId, setSendingId] = React.useState<number | null>(null);
  const [cancelling, setCancelling] = React.useState<Po | null>(null);
  const [error, setError] = React.useState("");
  const removeDraft = useRemovePoDraft();
  const pdf = usePoPdf();
  const stored = useStoredPoPdfUrl();

  const data = q.data;
  const notOnPo = (data?.materials ?? []).filter((m) => !m.onPo);
  const supplierById = (id: number) => data?.suppliers.find((s) => s.id === id) ?? null;
  const sendingPo = sendingId == null ? null : (data?.pos.find((p) => p.id === sendingId) ?? null);

  async function lookAt(po: Po) {
    setError("");
    try {
      if (po.sentAt) {
        await openPdf(async () => {
          try {
            return await stored.mutateAsync({ id: po.id });
          } catch {
            return pdf.mutateAsync({ id: po.id });
          }
        });
      } else await openPdf(() => pdf.mutateAsync({ id: po.id }));
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Purchase orders"
        subtitle="Order from the supplier. Each PO goes from team@ with the PDF and asks for the invoice at billing@."
        action={
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")} disabled={!data}>
            <Plus /> New PO
          </Button>
        }
      />
      {q.isLoading ? (
        <Loading label="Loading POs…" />
      ) : !data ? (
        <Empty>Couldn't load purchase orders.</Empty>
      ) : (
        <>
          {data.pos.length === 0 ? (
            <Empty>
              No POs on this job yet.
              {notOnPo.length ? ` ${notOnPo.length} ${notOnPo.length === 1 ? "material is" : "materials are"} ready to order.` : ""}
            </Empty>
          ) : (
            <ul className="divide-y divide-border">
              {data.pos.map((po) => {
                const st = PO_STATUS[po.status] ?? PO_STATUS.draft!;
                const goods = po.lines.filter((l) => l.kind === "goods");
                const live = po.status === "sent" || po.status === "invoiced";
                return (
                  <li key={po.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="tabular text-sm font-semibold">{po.number}</span>
                          <span className="text-sm">{po.supplierName}</span>
                          <Badge colour={st.colour}>{st.label}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {goods.length} {goods.length === 1 ? "line" : "lines"} · to {po.deliverTo === "site" ? "site" : "warehouse"}
                          {po.sentAt ? ` · sent ${dayOf(po.sentAt)}${po.sentTo ? ` to ${po.sentTo}` : ""}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="tabular text-sm font-semibold">{moneyExact(po.totalExGst)}</p>
                        <p className="text-[11px] text-muted-foreground">ex GST</p>
                      </div>
                    </div>

                    {live ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {po.invoices.length === 0 ? (
                          <Badge colour={PAIR_META.no_invoice!.colour}>No invoice yet</Badge>
                        ) : (
                          po.invoices.map((i) => {
                            const p = PAIR_META[pairOf(i)] ?? PAIR_META.no_po!;
                            return (
                              <Badge key={i.id} colour={p.colour}>
                                {i.docType === "credit" ? "Credit" : "Invoice"} {i.invoiceNumber} · {moneyExact(i.totalExGst)} ex · {p.label}
                                {i.payState === "paid" ? " · paid" : ""}
                              </Badge>
                            );
                          })
                        )}
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {po.status === "draft" ? (
                        <>
                          <Button size="sm" onClick={() => setSendingId(po.id)}>
                            <Send /> Send
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditing(po)}>
                            <Pencil /> Edit
                          </Button>
                        </>
                      ) : null}
                      {po.status !== "cancelled" ? (
                        <Button size="sm" variant="outline" onClick={() => lookAt(po)} disabled={pdf.isPending || stored.isPending}>
                          <FileText /> PDF
                        </Button>
                      ) : null}
                      {po.status === "draft" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={removeDraft.isPending}
                          onClick={async () => {
                            if (!window.confirm(`Remove draft ${po.number}? It was never sent.`)) return;
                            setError("");
                            try {
                              await removeDraft.mutateAsync({ id: po.id });
                            } catch (e) {
                              setError(errText(e));
                            }
                          }}
                        >
                          <Trash2 /> Remove
                        </Button>
                      ) : null}
                      {live ? (
                        <Button size="sm" variant="ghost" onClick={() => setCancelling(po)}>
                          <X /> Cancel PO
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {error ? <p className="border-t border-border px-4 py-2 text-xs text-destructive">{error}</p> : null}
          {data.pos.length > 0 && notOnPo.length > 0 ? (
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {notOnPo.length} {notOnPo.length === 1 ? "material is" : "materials are"} not on a PO yet.
            </p>
          ) : null}
        </>
      )}

      {data && editing ? (
        <PoEditor
          jobId={jobId}
          data={data}
          po={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            // Straight to sending a fresh one. A re-edit just closes.
            if (editing === "new") setSendingId(id);
          }}
        />
      ) : null}
      {data && sendingId != null ? (
        sendingPo ? (
          // Keyed so the email box fills from the supplier once the new PO has loaded.
          <SendPoModal key={sendingPo.id} po={sendingPo} supplier={supplierById(sendingPo.supplierId)} onClose={() => setSendingId(null)} />
        ) : (
          <Modal open onClose={() => setSendingId(null)} title="Send PO">
            <Loading label="Loading…" />
          </Modal>
        )
      ) : null}
      {cancelling ? <CancelPoModal po={cancelling} onClose={() => setCancelling(null)} /> : null}
    </Card>
  );
}

/* ================================= editor ================================= */

function linesFrom(po: Po | null, data: ForJob, supplierId: number | null): LineDraft[] {
  const saved = po?.pricingInputs.lines;
  if (po && saved?.length) {
    return saved.map((l) => ({
      key: nextKey(),
      kind: (l.kind ?? "goods") as Kind,
      jobMaterialId: l.jobMaterialId ?? null,
      productId: l.productId ?? null,
      description: l.description ?? "",
      qty: String(l.qty ?? ""),
      unit: l.unit ?? "m2",
      cost: l.unitCostExGst == null ? "" : String(l.unitCostExGst),
    }));
  }
  if (po) {
    // Older draft without its typed lines. Goods only, at the cost on the PO.
    return po.lines
      .filter((l) => l.kind === "goods")
      .map((l) => ({
        key: nextKey(),
        kind: "goods" as const,
        jobMaterialId: l.jobMaterialId,
        productId: l.productId,
        description: l.description,
        qty: String(l.qty),
        unit: l.unit,
        cost: String(l.unitCostExGst),
      }));
  }
  return data.materials
    .filter((m) => !m.onPo && supplierId != null && m.supplierId === supplierId)
    .map((m) => ({
      key: nextKey(),
      kind: "goods" as const,
      jobMaterialId: m.id,
      productId: m.productId,
      description: m.description,
      qty: String(m.qty ?? 0),
      unit: m.unit || "m2",
      cost: "",
    }));
}

function guessSupplier(data: ForJob): number | null {
  const counts = new Map<number, number>();
  for (const m of data.materials) if (!m.onPo && m.supplierId) counts.set(m.supplierId, (counts.get(m.supplierId) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best?.[0] ?? null;
}

const num = (s: string) => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function PoEditor({
  jobId,
  data,
  po,
  onClose,
  onSaved,
}: {
  jobId: number;
  data: ForJob;
  po: Po | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const initialSupplier = po?.supplierId ?? guessSupplier(data) ?? data.suppliers[0]?.id ?? null;
  const [supplierId, setSupplierId] = React.useState<number | null>(initialSupplier);
  const [deliverTo, setDeliverTo] = React.useState<"warehouse" | "site">((po?.deliverTo as "warehouse" | "site") ?? "warehouse");
  const [address, setAddress] = React.useState(po?.deliverTo === "site" ? po.deliveryAddress : data.siteAddress);
  const [notes, setNotes] = React.useState(po?.notes.replace(/\s*Draft removed, never sent\.\s*/g, "") ?? "");
  const [lines, setLines] = React.useState<LineDraft[]>(() => linesFrom(po, data, initialSupplier));
  const [picked, setPicked] = React.useState<Set<number>>(new Set(po?.pricingInputs.feeIds ?? []));
  const [skipped, setSkipped] = React.useState<Set<number>>(new Set(po?.pricingInputs.skipFeeIds ?? []));
  const [counts, setCounts] = React.useState({
    boxes: po?.pricingInputs.boxes != null ? String(po.pricingInputs.boxes) : "",
    rolls: po?.pricingInputs.rolls != null ? String(po.pricingInputs.rolls) : "",
    pallets: po?.pricingInputs.pallets != null ? String(po.pricingInputs.pallets) : "",
  });
  const [error, setError] = React.useState("");

  const supplier = data.suppliers.find((s) => s.id === supplierId) ?? null;
  const fees = useFeeRules(supplierId);
  const create = useCreatePo();
  const update = useUpdatePo();
  const saving = create.isPending || update.isPending;

  const usable = lines.filter((l) => (num(l.qty) ?? 0) > 0 || l.kind !== "goods");
  const input: PoPreviewInput | null =
    supplierId && usable.length
      ? {
          jobId,
          supplierId,
          deliverTo,
          deliveryAddress: deliverTo === "site" ? address : "",
          notes,
          lines: usable.map((l) => ({
            kind: l.kind,
            jobMaterialId: l.jobMaterialId,
            productId: l.productId,
            description: l.description || null,
            // A charge or freight line is one lot at the typed amount.
            qty: l.kind === "goods" ? (num(l.qty) ?? 0) : 1,
            unit: l.kind === "goods" ? l.unit : "each",
            unitCostExGst: num(l.cost),
          })),
          feeIds: [...picked],
          skipFeeIds: [...skipped],
          boxes: num(counts.boxes),
          rolls: num(counts.rolls),
          pallets: num(counts.pallets),
        }
      : null;
  const debounced = useDebounced(input, 350);
  const preview = usePoPreview(debounced);
  const pv = preview.data;
  const stale = JSON.stringify(input) !== JSON.stringify(debounced) || preview.isFetching;

  const setLine = (key: string, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key: string) => setLines((ls) => ls.filter((l) => l.key !== key));
  const toggleMaterial = (m: ForJob["materials"][number], on: boolean) => {
    if (!on) return setLines((ls) => ls.filter((l) => l.jobMaterialId !== m.id));
    setLines((ls) => [
      ...ls,
      { key: nextKey(), kind: "goods", jobMaterialId: m.id, productId: m.productId, description: m.description, qty: String(m.qty ?? 0), unit: m.unit || "m2", cost: "" },
    ]);
  };

  function changeSupplier(id: number) {
    setSupplierId(id);
    setPicked(new Set());
    setSkipped(new Set());
    // A new PO picks up that supplier's materials. Lines typed by hand stay.
    if (!po) {
      setLines((ls) => [
        ...ls.filter((l) => l.jobMaterialId == null),
        ...linesFrom(null, data, id),
      ]);
    }
  }

  const needsCounts = (fees.data ?? []).some((r) => ["roll", "pallet", "week"].includes(r.basis));

  async function save() {
    if (!input) return;
    setError("");
    try {
      const r = po ? await update.mutateAsync({ ...input, id: po.id }) : await create.mutateAsync(input);
      onSaved(r.id);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-4xl"
      title={po ? `Edit ${po.number}` : "New purchase order"}
      subtitle="Costed at what Terra pays today. A live special lowers this PO, never the customer's price."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={save} disabled={!input || saving || (!!pv && pv.totalExGst <= 0)}>
            {saving ? <Spinner className="border-white/40 border-t-white" /> : null}
            {po ? "Save changes" : "Save, then send"}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier">
              <Select value={supplierId ?? ""} onChange={(e) => changeSupplier(Number(e.target.value))}>
                {data.suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Deliver to">
              <div className="flex gap-1.5">
                {(["warehouse", "site"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDeliverTo(d)}
                    className={
                      deliverTo === d
                        ? "h-9 flex-1 rounded-md bg-primary text-[13px] font-semibold text-primary-foreground"
                        : "h-9 flex-1 rounded-md border border-border text-[13px] font-medium text-muted-foreground hover:text-foreground"
                    }
                  >
                    {d === "warehouse" ? "Warehouse" : "Site"}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          {deliverTo === "site" ? (
            <Field label="Site address">
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, suburb" />
            </Field>
          ) : (
            <p className="-mt-2 text-xs text-muted-foreground">Warehouse: {data.warehouseAddress}. No delivery charge.</p>
          )}
          {supplier && !supplier.email ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-3 py-2 text-xs text-muted-foreground">
              <Mail className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
              <span>
                No email on file for <span className="font-semibold text-foreground">{supplier.name}</span>. You'll type one in when you send, and it can be saved for next time.
              </span>
            </div>
          ) : null}

          {/* materials */}
          <div>
            <p className="label-xs mb-1.5">From this job</p>
            {data.materials.length === 0 ? (
              <p className="text-xs text-muted-foreground">No materials on the job. Add lines below, or add materials to the job first.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.materials.map((m) => {
                  const line = lines.find((l) => l.jobMaterialId === m.id);
                  const otherPo = m.onPo && m.onPo !== po?.number ? m.onPo : null;
                  const otherSupplier = m.supplierId && m.supplierId !== supplierId ? data.suppliers.find((s) => s.id === m.supplierId)?.name : null;
                  return (
                    <li key={m.id} className="px-3 py-2">
                      <label htmlFor={`po_mat_${m.id}`} className="flex cursor-pointer items-start gap-2.5">
                        <Checkbox id={`po_mat_${m.id}`} className="mt-0.5" checked={!!line} onChange={(e) => toggleMaterial(m, e.target.checked)} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{m.description}</span>
                          <span className="block text-xs text-muted-foreground">
                            {m.qty} {unitLabel(m.unit)}
                            {otherPo ? ` · already on ${otherPo}` : ""}
                            {otherSupplier ? ` · price book: ${otherSupplier}` : ""}
                            {!m.productId ? " · not in the price book" : ""}
                          </span>
                        </span>
                      </label>
                      {line ? <LineInputs line={line} onChange={(p) => setLine(line.key, p)} /> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* extra lines */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="label-xs">Other lines</p>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLines((ls) => [...ls, { key: nextKey(), kind: "goods", jobMaterialId: null, productId: null, description: "", qty: "", unit: "m2", cost: "" }])}
                >
                  <Plus /> Item
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLines((ls) => [...ls, { key: nextKey(), kind: "freight", jobMaterialId: null, productId: null, description: "Freight", qty: "1", unit: "each", cost: "" }])}
                >
                  <Plus /> Freight or charge
                </Button>
              </div>
            </div>
            {lines.filter((l) => l.jobMaterialId == null).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Only add freight here if the supplier bills it on their invoice. A carrier Terra books sends its own bill.
              </p>
            ) : (
              <ul className="space-y-2">
                {lines
                  .filter((l) => l.jobMaterialId == null)
                  .map((l) =>
                    l.kind === "goods" ? (
                      <li key={l.key} className="rounded-md border border-border px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Input value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="What to order" />
                          <button type="button" onClick={() => removeLine(l.key)} className="text-muted-foreground hover:text-destructive">
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <LineInputs line={l} onChange={(p) => setLine(l.key, p)} />
                      </li>
                    ) : (
                      <li key={l.key} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                        <Select className="w-28" value={l.kind} onChange={(e) => setLine(l.key, { kind: e.target.value as Kind })}>
                          <option value="freight">Freight</option>
                          <option value="charge">Charge</option>
                        </Select>
                        <Input className="min-w-[140px] flex-1" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Description" />
                        <Input
                          className="w-28"
                          type="number"
                          inputMode="decimal"
                          value={l.cost}
                          onChange={(e) => setLine(l.key, { cost: e.target.value })}
                          placeholder="$ ex GST"
                        />
                        <button type="button" onClick={() => removeLine(l.key)} className="text-muted-foreground hover:text-destructive">
                          <Trash2 className="size-3.5" />
                        </button>
                      </li>
                    ),
                  )}
              </ul>
            )}
          </div>

          {/* supplier charges */}
          <div>
            <p className="label-xs mb-1.5">Supplier charges</p>
            {fees.isLoading ? (
              <Loading label="Loading charges…" />
            ) : (fees.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No charges on file for this supplier.</p>
            ) : (
              <ul className="space-y-1.5">
                {(fees.data ?? []).map((r) => {
                  const isDelivery = r.kind === "delivery";
                  const off = isDelivery && deliverTo === "warehouse";
                  const checked = r.autoApply ? !skipped.has(r.id) : picked.has(r.id);
                  const rate = r.basis === "percent_of_order" ? `${r.percent ?? 0}%` : `$${(r.amount ?? 0).toFixed(2)}${r.basis === "order" ? "" : ` / ${r.basis}`}`;
                  return (
                    <li key={r.id}>
                      <label className={off ? "flex items-center gap-2.5 text-sm opacity-50" : "flex cursor-pointer items-center gap-2.5 text-sm"}>
                        <Checkbox
                          checked={checked && !off}
                          disabled={off}
                          onChange={(e) => {
                            const on = e.target.checked;
                            if (r.autoApply) {
                              setSkipped((s) => {
                                const n = new Set(s);
                                if (on) n.delete(r.id);
                                else n.add(r.id);
                                return n;
                              });
                            } else {
                              setPicked((s) => {
                                const n = new Set(s);
                                if (on) n.add(r.id);
                                else n.delete(r.id);
                                return n;
                              });
                            }
                          }}
                        />
                        <span className="flex-1">{r.name}</span>
                        <span className="tabular text-xs text-muted-foreground">{rate}</span>
                        <span className="w-20 text-right text-[11px] text-muted-foreground">{off ? "not to warehouse" : r.autoApply ? "every order" : "tick to add"}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {needsCounts ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Field label="Rolls">
                  <Input type="number" inputMode="numeric" value={counts.rolls} onChange={(e) => setCounts((c) => ({ ...c, rolls: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Pallets">
                  <Input type="number" inputMode="numeric" value={counts.pallets} onChange={(e) => setCounts((c) => ({ ...c, pallets: e.target.value }))} placeholder="0" />
                </Field>
                <Field label="Boxes">
                  <Input type="number" inputMode="numeric" value={counts.boxes} onChange={(e) => setCounts((c) => ({ ...c, boxes: e.target.value }))} placeholder="auto" />
                </Field>
              </div>
            ) : null}
          </div>

          <Field label="Notes for the supplier" hint="Printed on the PO. Delivery times, contact on site, cut sizes.">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        {/* preview */}
        <div className="lg:sticky lg:top-0 lg:self-start">
          <div className="rounded-lg border border-border bg-secondary/40">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="text-sm font-semibold">What Terra pays</p>
              {stale && input ? <Spinner /> : null}
            </div>
            {!input ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">Tick a material or add a line.</p>
            ) : preview.error && !pv ? (
              <p className="px-3 py-4 text-xs text-destructive">{errText(preview.error)}</p>
            ) : !pv ? (
              <Loading label="Pricing…" />
            ) : (
              <div className="space-y-3 px-3 py-3">
                <ul className="space-y-2">
                  {pv.lines.map((l, i) => (
                    <li key={i} className="text-xs">
                      <div className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate">{l.description}</span>
                        <span className="tabular font-medium">{moneyExact(l.totalExGst)}</span>
                      </div>
                      <p className="text-muted-foreground">
                        {l.unit === "%" ? `${l.unitCostExGst}% of ${/goods and charges/.test(l.note ?? "") ? "goods and charges" : "goods"}` : `${l.qty} ${unitLabel(l.unit)} × ${moneyExact(l.unitCostExGst)}`}
                        {l.standardUnitCostExGst != null ? <span className="line-through"> {moneyExact(l.standardUnitCostExGst)}</span> : null}
                      </p>
                      {l.note ? <p className="text-[var(--warning)]">{l.note}</p> : null}
                    </li>
                  ))}
                </ul>
                <div className="space-y-1 border-t border-border pt-2 text-xs">
                  <Row label="Goods" value={pv.goodsExGst} />
                  {pv.chargesExGst ? <Row label="Charges" value={pv.chargesExGst} /> : null}
                  <Row label="Freight" value={pv.freightExGst} />
                  <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
                    <span>Total ex GST</span>
                    <span className="tabular">{moneyExact(pv.totalExGst)}</span>
                  </div>
                </div>
                {pv.specialSavingExGst > 0 ? (
                  <p className="rounded-md bg-[var(--success)]/10 px-2 py-1.5 text-xs text-[var(--success)]">
                    Specials save Terra {moneyExact(pv.specialSavingExGst)} on this order. The customer's price doesn't change.
                  </p>
                ) : null}
                {pv.notes.length ? (
                  <ul className="space-y-1">
                    {pv.notes.map((n) => (
                      <li key={n} className="flex gap-1.5 text-xs text-muted-foreground">
                        <Info className="mt-0.5 size-3 shrink-0" />
                        {n}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {preview.error ? <p className="text-xs text-destructive">{errText(preview.error)}</p> : null}
              </div>
            )}
          </div>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <span>{label}</span>
      <span className="tabular">{moneyExact(value)}</span>
    </div>
  );
}

function LineInputs({ line, onChange }: { line: LineDraft; onChange: (p: Partial<LineDraft>) => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
      <Input className="w-24" type="number" inputMode="decimal" value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} placeholder="Qty" />
      <Select className="w-20" value={line.unit} onChange={(e) => onChange({ unit: e.target.value })}>
        {[...new Set([line.unit, ...UNITS])].map((u) => (
          <option key={u} value={u}>
            {unitLabel(u)}
          </option>
        ))}
      </Select>
      <Input
        className="w-36"
        type="number"
        inputMode="decimal"
        value={line.cost}
        onChange={(e) => onChange({ cost: e.target.value })}
        placeholder={line.productId ? "Price book cost" : "Cost ex GST"}
      />
      <span className="text-[11px] text-muted-foreground">{line.cost ? "typed cost" : line.productId ? "from price book" : "type a cost"}</span>
    </div>
  );
}

/* ================================== send ================================== */

const HOW = ["phoned", "supplier portal", "in person", "emailed from another inbox"];

function SendPoModal({ po, supplier, onClose }: { po: Po; supplier: Supplier | null; onClose: () => void }) {
  const [to, setTo] = React.useState(supplier?.email ?? "");
  const [saveEmail, setSaveEmail] = React.useState(!supplier?.email);
  const [how, setHow] = React.useState(HOW[0]!);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState("");
  const send = useSendPo();
  const markSent = useMarkPoSent();
  const pdf = usePoPdf();

  return (
    <Modal
      open
      onClose={onClose}
      title={`Send ${po.number} to ${po.supplierName}`}
      subtitle={`${moneyExact(po.totalExGst)} ex GST, to ${po.deliverTo === "site" ? "site" : "the warehouse"}.`}
      footer={
        done ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not yet
            </Button>
            <Button
              disabled={!to.trim() || send.isPending}
              onClick={async () => {
                setError("");
                try {
                  const r = await send.mutateAsync({ id: po.id, to: to.trim(), saveEmail });
                  setDone(`Sent to ${r.to} from team@.`);
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              {send.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send />}
              Send from team@
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm">{done} The cost is now committed on this job and in the forecast.</p>
      ) : (
        <div className="space-y-4">
          <Field label="Supplier email">
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="orders@supplier.com.au" />
          </Field>
          {!supplier?.email || (to.trim() && to.trim() !== supplier.email) ? (
            <label htmlFor="po_save_email" className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox id="po_save_email" checked={saveEmail} onChange={(e) => setSaveEmail(e.target.checked)} />
              Save this email on {po.supplierName} for next time
            </label>
          ) : null}
          <div className="rounded-md bg-secondary/60 px-3 py-2.5 text-xs text-muted-foreground">
            Goes from team@terraflooring.com.au with the PO as a PDF. It asks them to quote {po.number} on the invoice and send it to
            billing@terraflooring.com.au, so it matches back to this job by itself.
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={pdf.isPending}
            onClick={() => openPdf(() => pdf.mutateAsync({ id: po.id })).catch((e) => setError(errText(e)))}
          >
            <FileText /> Look at the PDF first
          </Button>

          <div className="border-t border-border pt-3">
            <p className="label-xs mb-1.5">Already ordered another way?</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select className="w-auto" value={how} onChange={(e) => setHow(e.target.value)}>
                {HOW.map((h) => (
                  <option key={h} value={h}>
                    {h[0]!.toUpperCase() + h.slice(1)}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                disabled={markSent.isPending}
                onClick={async () => {
                  setError("");
                  try {
                    await markSent.mutateAsync({ id: po.id, how });
                    setDone(`Marked as ordered (${how}). No email went.`);
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Mark as ordered
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">Tell them the PO number, {po.number}, so it ends up on their invoice.</p>
          </div>
          {error ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function CancelPoModal({ po, onClose }: { po: Po; onClose: () => void }) {
  const cancel = useCancelPo();
  const [error, setError] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Cancel ${po.number}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={cancel.isPending}
            onClick={async () => {
              setError("");
              try {
                await cancel.mutateAsync({ id: po.id });
                onClose();
              } catch (e) {
                setError(errText(e));
              }
            }}
          >
            Cancel PO
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm">
        <p>This takes the cost off the job and the forecast, and puts its materials back to "to order".</p>
        <p className="font-medium">It does not tell {po.supplierName}. Call or email them to stop the order.</p>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
