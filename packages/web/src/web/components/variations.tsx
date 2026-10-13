import * as React from "react";
import { createPortal } from "react-dom";
import { useSearch } from "wouter";
import { AlertTriangle, Ban, Check, Copy, ExternalLink, FileText, ImagePlus, Mail, MessageSquare, Plus, Search, Send, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { downloadBase64, errorText } from "./public-shell";
import { GROUP_LABEL, GroupToggles, unitLabel, useDebounced } from "./quote-pickers";
import { moneyExact } from "../lib/money";
import type { FoundProduct } from "../queries/productFind";
import { ProductFinder } from "./product-finder";
import { useRatePicker } from "../queries/labour";
import { uploadToStorage, useAttachMedia, useJobMedia } from "../queries/media";
import {
  useAcceptVariation,
  useAddVariationLabour,
  useAddVariationOther,
  useAddVariationProduct,
  useCreateVariation,
  useDeleteVariation,
  useJobVariations,
  useRejectVariation,
  useRemoveVariationLine,
  useSendVariation,
  useUpdateVariation,
  useUpdateVariationLine,
  useVariationDraft,
  useVariationPdf,
} from "../queries/variations";

/**
 * VARIATIONS (fix list 11 Oct, item 12). After a quote is accepted, extra
 * work or a dearer product is a variation the client approves. Priced off the
 * price book and the rate book, numbered off the job (V188000-01), sent by
 * email or SMS with a link where the client signs and accepts. Sign only,
 * nothing to pay. Accepting adds it to the job value and makes its dispatch
 * and materials. It goes on the final invoice (homeowner) or the end invoice
 * (company billed), never its own invoice and never a new deposit. A company
 * billed job needs an updated work order before invoicing, so it says so.
 */

type List = NonNullable<ReturnType<typeof useJobVariations>["data"]>;
type Variation = List["variations"][number];
type Line = Variation["items"][number];

const STATUS_COLOUR: Record<string, string> = {
  draft: "#7A736D",
  sent: "#4A7FA5",
  approved: "#3F7D3A",
  invoiced: "#3F7D3A",
  rejected: "#A0453A",
};

const KIND_LABEL: Record<string, string> = {
  supply: "Supply",
  accessory: "Accessory",
  labour: "Labour",
  prep: "Prep",
  removal: "Removal",
  delivery: "Delivery",
  other: "Other",
};

const editable = (v: Variation) => v.status === "draft" || v.status === "sent";
const dateOf = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : null;
const num = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/* --------------------------------- the card -------------------------------- */

export function VariationsCard({ jobId }: { jobId: number }) {
  const data = useJobVariations(jobId);
  const search = useSearch();
  const [creating, setCreating] = React.useState(false);
  const [openId, setOpenId] = React.useState<number | null>(null);

  // "Create variation" on an accepted quote lands here with ?variation=new.
  React.useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("variation") === "new") {
      setCreating(true);
      params.delete("variation");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    }
  }, [search]);

  const rows = data.data?.variations ?? [];
  const open = rows.find((v) => v.id === openId) ?? null;

  return (
    <Card>
      <CardHeader
        title="Variations"
        subtitle={
          data.data?.acceptedQuote
            ? `Changes after quote ${data.data.acceptedQuote.ref} was accepted. The client approves each one and it adds to the job.`
            : "Extra work or a dearer product. The client approves it and it adds to the job."
        }
        action={
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            Create variation
          </Button>
        }
      />
      {data.isLoading ? (
        <Loading />
      ) : data.isError ? (
        <Empty>{errorText(data.error)}</Empty>
      ) : rows.length === 0 ? (
        <Empty>No variations on this job.</Empty>
      ) : (
        <>
          {data.data && data.data.approvedTotal > 0 ? (
            <div className="border-b border-border px-4 py-2.5 text-sm">
              <span className="text-muted-foreground">Accepted variations: </span>
              <span className="tabular font-semibold">{moneyExact(data.data.approvedTotal)}</span>
              <span className="text-muted-foreground"> inc GST, in the job value.</span>
            </div>
          ) : null}
          <ul className="divide-y divide-border">
            {rows.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(v.id)}
                  className="flex w-full flex-wrap items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="tabular text-primary">{v.ref}</span>
                      <Badge colour={STATUS_COLOUR[v.status] ?? "#7A736D"}>{v.statusLabel}</Badge>
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{v.description || "No reason written yet"}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{rowNote(v)}</p>
                    {v.workOrderWarning && (v.status === "approved" || v.status === "invoiced") ? (
                      <p className="mt-1 flex items-start gap-1 text-xs font-medium text-amber-800">
                        <AlertTriangle className="mt-px size-3.5 shrink-0" />
                        {v.workOrderWarning}
                      </p>
                    ) : null}
                  </div>
                  <span className="tabular shrink-0 text-sm font-semibold">{moneyExact(v.total)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating ? createPortal(<CreateVariationModal jobId={jobId} onClose={() => setCreating(false)} onMade={(id) => setOpenId(id)} />, document.body) : null}
      {open ? createPortal(<VariationModal v={open} canSeeCosts={!!data.data?.canSeeCosts} onClose={() => setOpenId(null)} />, document.body) : null}
    </Card>
  );
}

function rowNote(v: Variation) {
  if (v.status === "approved" || v.status === "invoiced") {
    const how =
      v.approvalChannel === "online"
        ? `signed online by ${v.approvedByName ?? "the client"}`
        : v.approvalChannel === "form"
          ? `accepted on the material selection form by ${v.approvedByName ?? "the client"}`
          : `marked by ${v.approvedByName ?? "the office"}`;
    return [`Accepted ${dateOf(v.approvedAt) ?? ""}, ${how}`, v.billedToCompany ? "On the end invoice" : "On the final invoice"].join(". ");
  }
  if (v.status === "rejected") return `Declined ${dateOf(v.rejectedAt) ?? ""}`;
  if (v.status === "sent") return `Sent ${dateOf(v.sentAt) ?? ""}. Opened ${v.views} ${v.views === 1 ? "time" : "times"}`;
  const n = v.items.length;
  return v.sentAt ? `Changed since it was sent. Send it again.` : `${n} line${n === 1 ? "" : "s"}, not sent`;
}

/* ---------------------------------- create --------------------------------- */

function CreateVariationModal({ jobId, onClose, onMade }: { jobId: number; onClose: () => void; onMade: (id: number) => void }) {
  const create = useCreateVariation();
  const [description, setDescription] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      const v = await create.mutateAsync({ jobId, description });
      onClose();
      onMade(v.id);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Create variation"
      subtitle="Numbered off the job. You add the lines next."
      footer={
        <>
          {error ? <p className="mr-auto text-sm text-destructive">{error}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Why this variation (the client reads this)">
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Subfloor in the hallway is uneven, it needs levelling before the hybrid goes down."
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          The client signs it online. Nothing to pay now: it goes on the final invoice, or the end invoice when a company is billed.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------ the builder ------------------------------- */

function VariationModal({ v, canSeeCosts, onClose }: { v: Variation; canSeeCosts: boolean; onClose: () => void }) {
  const update = useUpdateVariation();
  const del = useDeleteVariation();
  const pdf = useVariationPdf();
  const [description, setDescription] = React.useState(v.description);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const [accepting, setAccepting] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const canEdit = editable(v);

  React.useEffect(() => setDescription(v.description), [v.id, v.description]);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const saveDescription = () =>
    description.trim() !== v.description.trim() ? run(() => update.mutateAsync({ id: v.id, description })) : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-4xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Variation {v.ref}
          <Badge colour={STATUS_COLOUR[v.status] ?? "#7A736D"}>{v.statusLabel}</Badge>
        </span>
      }
      subtitle={`${moneyExact(v.total)} inc GST. ${v.billNote}`}
      footer={
        <>
          {error ? <p className="mr-auto max-w-md text-sm text-destructive">{error}</p> : null}
          {v.status === "draft" && !v.sentAt ? (
            <Button
              variant="ghost"
              onClick={() =>
                run(async () => {
                  if (!window.confirm(`Delete draft ${v.ref}?`)) return;
                  await del.mutateAsync({ id: v.id });
                  onClose();
                })
              }
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          ) : null}
          <Button
            variant="outline"
            disabled={pdf.isPending}
            onClick={() =>
              run(async () => {
                const out = await pdf.mutateAsync({ id: v.id });
                downloadBase64(out.filename, out.base64);
              })
            }
          >
            {pdf.isPending ? <Spinner /> : <FileText className="size-4" />}
            PDF
          </Button>
          {canEdit ? (
            <>
              <Button variant="outline" onClick={() => setDeclining(true)}>
                <Ban className="size-4" />
                Declined
              </Button>
              <Button variant="outline" onClick={() => setAccepting(true)} disabled={!(v.total > 0)}>
                <Check className="size-4" />
                Accepted
              </Button>
              <Button onClick={() => setSending(true)} disabled={!v.items.length || !(v.total > 0)}>
                <Send className="size-4" />
                {v.sentAt ? "Send again" : "Send"}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="grid gap-4">
        {v.status === "sent" ? (
          <p className="rounded-md border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
            Sent {dateOf(v.sentAt)}. Opened {v.views} {v.views === 1 ? "time" : "times"}. Any change here takes it back to draft, so send it again after.
          </p>
        ) : null}
        {v.status === "draft" && v.sentAt ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Changed since it was sent. The client cannot accept it until you send it again.
          </p>
        ) : null}
        {v.status === "approved" || v.status === "invoiced" ? (
          <p className="rounded-md border border-[#3F7D3A]/30 bg-[#3F7D3A]/8 px-3 py-2 text-sm">
            Accepted {dateOf(v.approvedAt)}
            {v.signature ? `, signed online by ${v.signature.name}${v.signature.position ? `, ${v.signature.position}` : ""}` : v.approvedByName ? `, marked by ${v.approvedByName}` : ""}.{" "}
            {v.billedToCompany ? "It goes on the end invoice." : "It goes on the final invoice."}
          </p>
        ) : null}
        {v.workOrderWarning ? <WorkOrderWarning text={v.workOrderWarning} /> : null}
        {v.status === "rejected" ? (
          <p className="rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm">Declined {dateOf(v.rejectedAt)}. Make a new variation if it changes.</p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-[1fr_240px]">
          <Field label="Why this variation (the client reads this)">
            <Textarea rows={3} value={description} disabled={!canEdit} onChange={(e) => setDescription(e.target.value)} onBlur={saveDescription} />
          </Field>
          <div className="grid content-start gap-2">
            <p className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
              Sign only. {v.billedToCompany ? "Goes on the end invoice." : "Goes on the final invoice."} No new deposit.
            </p>
            {v.url ? (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(v.url ?? "");
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  <Copy className="size-3.5" />
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <a href={v.url} target="_blank" rel="noreferrer">
                  <Button size="sm" variant="outline">
                    <ExternalLink className="size-3.5" />
                    Client page
                  </Button>
                </a>
              </div>
            ) : null}
          </div>
        </div>

        <LinesTable v={v} canEdit={canEdit} canSeeCosts={canSeeCosts} onError={setError} />

        {canEdit ? (
          <div className="overflow-hidden rounded-lg border border-border">
            <VariationProductPicker variationId={v.id} />
            <VariationLabourPicker variationId={v.id} />
            <OtherLineForm variationId={v.id} canSeeCosts={canSeeCosts} />
          </div>
        ) : null}

        <PhotoPicker v={v} canEdit={canEdit} onError={setError} />
      </div>

      {sending ? createPortal(<SendModal v={v} onClose={() => setSending(false)} />, document.body) : null}
      {accepting ? createPortal(<AcceptModal v={v} onClose={() => setAccepting(false)} />, document.body) : null}
      {declining ? createPortal(<DeclineModal v={v} onClose={() => setDeclining(false)} />, document.body) : null}
    </Modal>
  );
}

/* ---------------------------------- lines --------------------------------- */

function LinesTable({ v, canEdit, canSeeCosts, onError }: { v: Variation; canEdit: boolean; canSeeCosts: boolean; onError: (e: string | null) => void }) {
  if (!v.items.length) {
    return <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">No lines yet. Add supply, labour or another line below.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-secondary/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Line</th>
            <th className="px-2 py-2 font-medium">Kind</th>
            <th className="px-2 py-2 text-right font-medium">Qty</th>
            <th className="px-2 py-2 text-right font-medium">Unit sell</th>
            {canSeeCosts ? <th className="px-2 py-2 text-right font-medium">Unit cost</th> : null}
            <th className="px-2 py-2 text-right font-medium">Total ex GST</th>
            {canEdit ? <th className="w-8"><span className="sr-only">Actions</span></th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {v.items.map((l) => (
            <LineRow key={l.id} line={l} canEdit={canEdit} canSeeCosts={canSeeCosts} onError={onError} />
          ))}
        </tbody>
        <tfoot className="border-t border-border text-sm">
          <tr>
            <td colSpan={canSeeCosts ? 5 : 4} className="px-3 py-1.5 text-right text-muted-foreground">
              Subtotal
            </td>
            <td className="tabular px-2 py-1.5 text-right">{moneyExact(v.subtotal)}</td>
            {canEdit ? <td aria-label="No actions" /> : null}
          </tr>
          <tr>
            <td colSpan={canSeeCosts ? 5 : 4} className="px-3 py-1.5 text-right text-muted-foreground">
              GST
            </td>
            <td className="tabular px-2 py-1.5 text-right">{moneyExact(v.gst)}</td>
            {canEdit ? <td aria-label="No actions" /> : null}
          </tr>
          <tr className="font-semibold">
            <td colSpan={canSeeCosts ? 5 : 4} className="px-3 py-1.5 text-right">
              Total inc GST
            </td>
            <td className="tabular px-2 py-1.5 text-right">{moneyExact(v.total)}</td>
            {canEdit ? <td aria-label="No actions" /> : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function LineRow({ line, canEdit, canSeeCosts, onError }: { line: Line; canEdit: boolean; canSeeCosts: boolean; onError: (e: string | null) => void }) {
  const update = useUpdateVariationLine();
  const remove = useRemoveVariationLine();
  const [description, setDescription] = React.useState(line.description);
  const [qty, setQty] = React.useState(String(line.qty));
  const [price, setPrice] = React.useState(line.unitPrice.toFixed(2));
  const [cost, setCost] = React.useState(line.unitCost != null ? line.unitCost.toFixed(2) : "");

  React.useEffect(() => {
    setDescription(line.description);
    setQty(String(line.qty));
    setPrice(line.unitPrice.toFixed(2));
    setCost(line.unitCost != null ? line.unitCost.toFixed(2) : "");
  }, [line.description, line.qty, line.unitPrice, line.unitCost]);

  async function save(fields: Parameters<typeof update.mutateAsync>[0]) {
    onError(null);
    try {
      await update.mutateAsync(fields);
    } catch (e) {
      onError(errorText(e));
    }
  }

  if (!canEdit) {
    return (
      <tr>
        <td className="px-3 py-2">{line.description}</td>
        <td className="px-2 py-2 text-xs text-muted-foreground">{KIND_LABEL[line.kind] ?? line.kind}</td>
        <td className="tabular px-2 py-2 text-right whitespace-nowrap">
          {line.qty} {unitLabel(line.unit)}
        </td>
        <td className="tabular px-2 py-2 text-right">{moneyExact(line.unitPrice)}</td>
        {canSeeCosts ? <td className="tabular px-2 py-2 text-right text-muted-foreground">{line.unitCost != null ? moneyExact(line.unitCost) : "-"}</td> : null}
        <td className="tabular px-2 py-2 text-right">{moneyExact(line.total)}</td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="px-2 py-1.5">
        <Input
          value={description}
          aria-label="Line description"
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description.trim() && description !== line.description && save({ id: line.id, description })}
        />
      </td>
      <td className="px-2 py-1.5">
        <Select
          className="w-[110px]"
          aria-label="Line kind"
          value={line.kind}
          onChange={(e) => save({ id: line.id, kind: e.target.value as Line["kind"] as never })}
        >
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center justify-end gap-1">
          <Input
            className="tabular w-[72px] text-right"
            aria-label="Quantity"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            onBlur={() => {
              const n = num(qty);
              if (n > 0 && n !== line.qty) save({ id: line.id, qty: n });
              else setQty(String(line.qty));
            }}
          />
          <span className="text-xs text-muted-foreground">{unitLabel(line.unit)}</span>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <Input
          className="tabular ml-auto w-[90px] text-right"
          aria-label="Unit sell"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          onBlur={() => {
            const n = num(price);
            if (n >= 0 && n !== line.unitPrice) save({ id: line.id, unitPrice: n });
            else setPrice(line.unitPrice.toFixed(2));
          }}
        />
      </td>
      {canSeeCosts ? (
        <td className="px-2 py-1.5">
          <Input
            className="tabular ml-auto w-[90px] text-right"
            aria-label="Unit cost"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            onBlur={() => {
              const n = cost.trim() === "" ? null : num(cost);
              if (n !== null && !(n >= 0)) return setCost(line.unitCost != null ? line.unitCost.toFixed(2) : "");
              if (n !== line.unitCost) save({ id: line.id, unitCost: n });
            }}
          />
        </td>
      ) : null}
      <td className="tabular px-2 py-1.5 text-right">{moneyExact(line.total)}</td>
      <td className="px-1 py-1.5">
        <button
          type="button"
          aria-label="Remove line"
          className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-destructive"
          disabled={remove.isPending}
          onClick={async () => {
            onError(null);
            try {
              await remove.mutateAsync({ id: line.id });
            } catch (e) {
              onError(errorText(e));
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </td>
    </tr>
  );
}

/* --------------------------------- pickers -------------------------------- */

function VariationProductPicker({ variationId }: { variationId: number }) {
  const add = useAddVariationProduct();
  const [chosen, setChosen] = React.useState<FoundProduct | null>(null);
  const [qty, setQty] = React.useState("1");
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (chosen == null) return;
    const n = num(qty);
    if (!(n > 0)) return setError("Type a quantity.");
    setError(null);
    setNote(null);
    try {
      const r = await add.mutateAsync({ variationId, productId: chosen.id, qty: n });
      setNote([r.note, r.flag].filter(Boolean).join(" ") || null);
      setChosen(null);
      setQty("1");
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supply</span>
        <span className="text-xs text-muted-foreground">off the price list, today's sell</span>
      </div>
      <ProductFinder
        picked={chosen}
        onPick={(p) => {
          setChosen(p);
          setNote(null);
          setError(null);
        }}
      />
      {chosen ? (
        <div className="flex flex-wrap items-end justify-end gap-2">
          <Input className="tabular w-[80px] text-right" aria-label="Supply quantity" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <span className="pb-2 text-xs text-muted-foreground">{unitLabel(chosen.unit)}</span>
          <Button variant="outline" disabled={add.isPending} onClick={submit}>
            {add.isPending ? <Spinner /> : <Plus className="size-4" />}
            Add supply
          </Button>
        </div>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function VariationLabourPicker({ variationId }: { variationId: number }) {
  const add = useAddVariationLabour();
  const [group, setGroup] = React.useState("");
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search);
  const [itemId, setItemId] = React.useState<number | null>(null);
  const [qty, setQty] = React.useState("1");
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const picker = useRatePicker({ groupName: group, search: debounced });
  const rows = React.useMemo(() => picker.data?.rows ?? [], [picker.data]);
  const item = rows.find((r) => r.itemId === itemId) ?? null;

  async function submit() {
    if (itemId == null) return;
    const n = num(qty);
    if (!(n > 0)) return setError("Type a quantity.");
    setError(null);
    setNote(null);
    try {
      const r = await add.mutateAsync({ variationId, itemId, qty: n });
      setNote(r.minApplied ? "That is the minimum charge, not the rate times the quantity." : null);
      setItemId(null);
      setQty("1");
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Labour</span>
        <span className="text-xs text-muted-foreground">off the rate book, at the standard rate. Makes a new dispatch when accepted.</span>
      </div>
      {(picker.data?.groups ?? []).length > 0 ? (
        <GroupToggles
          groups={picker.data?.groups ?? []}
          labels={GROUP_LABEL}
          value={group}
          onChange={(g) => {
            setGroup(g);
            setItemId(null);
          }}
        />
      ) : null}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Or search it, levelling, uplift, stairs" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Combobox
          className="min-w-[280px] flex-1"
          value={itemId == null ? "" : String(itemId)}
          onChange={(val) => setItemId(val ? Number(val) : null)}
          emptyLabel="Nothing picked"
          placeholder={picker.isLoading ? "Loading the rate book…" : rows.length === 0 ? "Nothing priced matches that" : `Pick one of ${rows.length}`}
          options={rows.map((r) => ({
            value: String(r.itemId),
            label: r.name,
            sublabel: r.sell != null ? `${moneyExact(r.sell)}/${unitLabel(r.unit)}` : "unpriced",
          }))}
        />
        <Input className="tabular w-[80px] text-right" aria-label="Labour quantity" value={qty} onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <span className="pb-2 text-xs text-muted-foreground">{item ? unitLabel(item.unit) : ""}</span>
        <Button variant="outline" disabled={itemId == null || add.isPending} onClick={submit}>
          {add.isPending ? <Spinner /> : <Plus className="size-4" />}
          Add labour
        </Button>
      </div>
      {note ? <p className="text-xs text-primary">{note}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function OtherLineForm({ variationId, canSeeCosts }: { variationId: number; canSeeCosts: boolean }) {
  const add = useAddVariationOther();
  const [kind, setKind] = React.useState("other");
  const [description, setDescription] = React.useState("");
  const [qty, setQty] = React.useState("1");
  const [unit, setUnit] = React.useState("each");
  const [price, setPrice] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    const q = num(qty);
    const p = num(price);
    const c = cost.trim() ? num(cost) : null;
    if (!description.trim()) return setError("Describe the line.");
    if (!(q > 0)) return setError("Type a quantity.");
    if (!(p >= 0) || price.trim() === "") return setError("Type the sell price ex GST.");
    if (c !== null && !(c >= 0)) return setError("The cost is not a number.");
    try {
      await add.mutateAsync({ variationId, kind: kind as never, description, qty: q, unit, unitPrice: p, unitCost: canSeeCosts ? c : null });
      setDescription("");
      setQty("1");
      setPrice("");
      setCost("");
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Other line</span>
        <span className="text-xs text-muted-foreground">anything not in the books, priced by hand</span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Select className="w-[120px]" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <Input className="min-w-[220px] flex-1" placeholder="Description the client reads" value={description} onChange={(e) => setDescription(e.target.value)} />
        <Input className="tabular w-[70px] text-right" aria-label="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} />
        <Select className="w-[90px]" aria-label="Unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
          {["each", "m2", "lm", "hour", "day", "job", "step"].map((u) => (
            <option key={u} value={u}>
              {unitLabel(u)}
            </option>
          ))}
        </Select>
        <Input className="tabular w-[100px] text-right" placeholder="Sell ex GST" aria-label="Unit sell" value={price} onChange={(e) => setPrice(e.target.value)} />
        {canSeeCosts ? (
          <Input className="tabular w-[100px] text-right" placeholder="Cost" aria-label="Unit cost" value={cost} onChange={(e) => setCost(e.target.value)} />
        ) : null}
        <Button variant="outline" disabled={add.isPending} onClick={submit}>
          {add.isPending ? <Spinner /> : <Plus className="size-4" />}
          Add line
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/* --------------------------------- photos --------------------------------- */

function PhotoPicker({ v, canEdit, onError }: { v: Variation; canEdit: boolean; onError: (e: string | null) => void }) {
  const media = useJobMedia(v.jobId);
  const attach = useAttachMedia();
  const update = useUpdateVariation();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const picked = React.useMemo(() => new Set(v.photos.map((p) => p.id)), [v.photos]);
  const photos = React.useMemo(
    () => (media.data ?? []).flatMap((g) => g.items.filter((m) => m.kind === "photo" && !m.archivedAt).map((m) => ({ ...m, bucketLabel: g.label }))),
    [media.data],
  );

  async function setIds(ids: number[]) {
    onError(null);
    try {
      await update.mutateAsync({ id: v.id, photoMediaIds: ids });
    } catch (e) {
      onError(errorText(e));
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    onError(null);
    try {
      const ids = [...picked];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        const key = await uploadToStorage(file, v.jobId, "found");
        const row = await attach.mutateAsync({
          jobId: v.jobId,
          bucket: "found",
          kind: "photo",
          storageKey: key,
          filename: file.name,
          mime: file.type || null,
          sizeBytes: file.size,
        });
        if (row?.id) ids.push(row.id);
      }
      await setIds(ids.slice(0, 12));
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const list = canEdit && showAll ? photos : v.photos;

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium">Photos that show why</p>
          <p className="text-xs text-muted-foreground">Optional. The client sees them on the page, and the first 4 go on the PDF.</p>
        </div>
        {canEdit ? (
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show picked" : `Pick from the job file (${photos.length})`}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <Spinner /> : <ImagePlus className="size-3.5" />}
              Upload
            </Button>
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" aria-label="Upload photos" onChange={(e) => onFiles(e.target.files)} />
          </div>
        ) : null}
      </div>
      {list.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground">
          {showAll ? "No photos in the job file yet." : "No photos picked."}
          {canEdit && !showAll ? " Uploads go to What we found in the job file." : ""}
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-5">
          {list.map((p) => {
            const on = picked.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                disabled={!canEdit || update.isPending}
                onClick={() => setIds(on ? [...picked].filter((id) => id !== p.id) : [...picked, p.id])}
                className={`relative overflow-hidden rounded-md border-2 ${on ? "border-primary" : "border-transparent"} bg-secondary/40`}
                title={p.caption ?? ""}
              >
                <img src={p.url} alt={p.caption ?? "Photo"} className="aspect-square w-full object-cover" loading="lazy" />
                {on && canEdit ? (
                  <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-primary text-white">
                    <Check className="size-3" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* --------------------------------- send it -------------------------------- */

function SendModal({ v, onClose }: { v: Variation; onClose: () => void }) {
  const draft = useVariationDraft(v.id);
  const send = useSendVariation();
  const [channel, setChannel] = React.useState<"email" | "sms">("email");
  const [to, setTo] = React.useState<string | null>(null);
  const [subject, setSubject] = React.useState<string | null>(null);
  const [body, setBody] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const d = draft.data;

  const toValue = to ?? (channel === "email" ? (d?.email ?? "") : (d?.mobile ?? ""));
  const bodyValue = body ?? (channel === "email" ? (d?.body ?? "") : (d?.sms ?? ""));

  function pickChannel(c: "email" | "sms") {
    setChannel(c);
    setTo(null);
    setBody(null);
  }

  async function submit() {
    setError(null);
    try {
      await send.mutateAsync({ id: v.id, channel, to: toValue, subject: channel === "email" ? (subject ?? d?.subject ?? "") : undefined, body: bodyValue });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const options = (d?.recipients ?? []).filter((r) => (channel === "email" ? r.email : r.mobile));

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-xl"
      title={`Send variation ${v.ref}`}
      subtitle="With the link where the client signs and accepts. Logged on the job's thread."
      footer={
        <>
          {error ? <p className="mr-auto max-w-xs text-sm text-destructive">{error}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            {send.data ? "Close" : "Cancel"}
          </Button>
          {!send.data ? (
            <Button onClick={submit} disabled={send.isPending || !d || !toValue.trim()}>
              {send.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="size-3.5" />}
              Send {channel === "email" ? "email" : "text"}
            </Button>
          ) : null}
        </>
      }
    >
      {draft.isLoading ? <Spinner /> : null}
      {draft.error ? <p className="text-sm text-destructive">{errorText(draft.error)}</p> : null}
      {send.data ? (
        <p className="text-sm text-[var(--success)]">
          Sent to {send.data.to}. The client can open it at {send.data.url}
        </p>
      ) : d ? (
        <div className="grid gap-3">
          <div className="flex gap-1.5">
            <Button size="sm" variant={channel === "email" ? "default" : "outline"} onClick={() => pickChannel("email")}>
              <Mail className="size-3.5" />
              Email with PDF
            </Button>
            <Button size="sm" variant={channel === "sms" ? "default" : "outline"} onClick={() => pickChannel("sms")}>
              <MessageSquare className="size-3.5" />
              SMS
            </Button>
          </div>
          {options.length ? (
            <div className="flex flex-wrap gap-1.5">
              {options.map((r, i) => {
                const addr = (channel === "email" ? r.email : r.mobile) ?? "";
                return (
                  <button
                    key={`${r.contactId}-${i}`}
                    type="button"
                    onClick={() => setTo(addr)}
                    className={`rounded-full border px-2.5 py-1 text-xs ${toValue === addr ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}
                  >
                    {r.name || addr} <span className="text-muted-foreground">· {r.why}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <Field label={channel === "email" ? "Email to" : "Mobile"}>
            <Input value={toValue} onChange={(e) => setTo(e.target.value)} placeholder={channel === "email" ? "client@example.com" : "04xx xxx xxx"} />
          </Field>
          {channel === "email" ? (
            <Field label="Subject">
              <Input value={subject ?? d.subject} onChange={(e) => setSubject(e.target.value)} />
            </Field>
          ) : null}
          <Field label={channel === "email" ? "Message" : "Text"} hint={channel === "sms" ? "The link stays in. The opt out line is added on the end." : undefined}>
            <Textarea rows={channel === "email" ? 10 : 4} value={bodyValue} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------------------- accept and decline --------------------------- */

function AcceptModal({ v, onClose }: { v: Variation; onClose: () => void }) {
  const accept = useAcceptVariation();
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const out = accept.data;
  const labour = v.items.some((l) => ["labour", "prep", "removal"].includes(l.kind));
  const supply = v.items.some((l) => ["supply", "accessory"].includes(l.kind));

  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark ${v.ref} accepted`}
      subtitle="When the client said yes another way: by email, on the phone or on site."
      footer={
        <>
          {error ? <p className="mr-auto max-w-xs text-sm text-destructive">{error}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            {out ? "Close" : "Cancel"}
          </Button>
          {!out ? (
            <Button
              disabled={accept.isPending}
              onClick={async () => {
                setError(null);
                try {
                  await accept.mutateAsync({ id: v.id, note: note.trim() || undefined });
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              {accept.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Check className="size-3.5" />}
              Accepted
            </Button>
          ) : null}
        </>
      }
    >
      {out ? (
        <p className="text-sm">
          Accepted. {moneyExact(v.total)} added to the job value.
          {v.billedToCompany ? " It goes on the end invoice." : " It goes on the final invoice."}
          {out.dispatchId ? " A new dispatch is on the job for the extra work." : ""}
          {out.materials ? ` ${out.materials} material${out.materials === 1 ? "" : "s"} to order.` : ""}
          {out.workOrderWarning ? (
            <span className="mt-3 block">
              <WorkOrderWarning text={out.workOrderWarning} />
            </span>
          ) : null}
        </p>
      ) : (
        <div className="grid gap-3 text-sm">
          <ul className="list-disc pl-5 text-muted-foreground">
            <li>{moneyExact(v.total)} inc GST is added to the job value.</li>
            <li>{v.billedToCompany ? "It goes on the end invoice." : "It goes on the final invoice."} No new invoice and no deposit.</li>
            {labour ? <li>Its labour becomes a new dispatch on the job.</li> : null}
            {supply ? <li>Its supply lines go on the materials list to order.</li> : null}
          </ul>
          {v.workOrderWarning ? <WorkOrderWarning text={v.workOrderWarning} /> : null}
          <Field label="How did they accept? (goes in the history)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Email from Sam, 14 Oct" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function WorkOrderWarning({ text }: { text: string }) {
  return (
    <span className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{text}</span>
    </span>
  );
}

function DeclineModal({ v, onClose }: { v: Variation; onClose: () => void }) {
  const reject = useRejectVariation();
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Mark ${v.ref} declined`}
      footer={
        <>
          {error ? <p className="mr-auto max-w-xs text-sm text-destructive">{error}</p> : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={reject.isPending}
            onClick={async () => {
              setError(null);
              try {
                await reject.mutateAsync({ id: v.id, reason: reason.trim() || undefined });
                onClose();
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {reject.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Ban className="size-3.5" />}
            Declined
          </Button>
        </>
      }
    >
      <Field label="Why (optional, goes in the history)">
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}
