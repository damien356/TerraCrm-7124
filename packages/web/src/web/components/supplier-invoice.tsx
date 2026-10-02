import * as React from "react";
import { Link } from "wouter";
import { Check, FileText, Mail, RotateCcw, Send, TriangleAlert, Upload, X } from "lucide-react";
import { Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { moneyExact, shortDate } from "../lib/money";
import { PAIR_META } from "./purchase-orders";
import { InvoicePriceChecks } from "./price-checks";
import { useOpenPosForSupplier } from "../queries/purchasing";
import { useSuppliers } from "../queries/suppliers";
import {
  useCancelRequest,
  useEditRequest,
  useInvoiceRequest,
  useMarkInvoiceChecked,
  useMarkInvoicePaid,
  useMatchInvoice,
  useRematchInvoice,
  useSendRequest,
  useSetInvoiceSupplier,
  useSupplierInvoice,
  useUploadSupplierPdf,
} from "../queries/payables";

/**
 * ONE SUPPLIER INVOICE, AND THE MISSING-INVOICE REQUESTS.
 *
 * The side panel shows what the agent read off the PDF next to the PO it was
 * matched to, and the four things a person does with it: tie it to a PO,
 * okay a price difference, say which supplier an unknown name is, mark paid.
 */

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ================================ invoice ================================ */

export function InvoicePanel({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useSupplierInvoice(id);
  const inv = q.data;
  const match = useMatchInvoice();
  const rematch = useRematchInvoice();
  const checked = useMarkInvoiceChecked();
  const paid = useMarkInvoicePaid();
  const setSupplier = useSetInvoiceSupplier();
  const suppliers = useSuppliers(false);
  const openPos = useOpenPosForSupplier(inv?.supplierId ?? null);
  const [poPick, setPoPick] = React.useState("");
  const [supPick, setSupPick] = React.useState("");
  const [error, setError] = React.useState("");
  const busy = match.isPending || rematch.isPending || checked.isPending || paid.isPending || setSupplier.isPending;

  async function run(f: () => Promise<unknown>) {
    setError("");
    try {
      await f();
    } catch (e) {
      setError(errText(e));
    }
  }

  const title = inv ? `${inv.docType === "credit" ? "Credit" : "Invoice"} ${inv.invoiceNumber}` : "Invoice";
  const pair = inv ? (PAIR_META[inv.pair] ?? PAIR_META.no_po!) : null;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={title}
      subtitle={inv ? `${inv.supplierNameRaw || "Unknown supplier"}${inv.invoiceDate ? ` · ${shortDate(inv.invoiceDate)}` : ""}` : undefined}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : !inv ? (
        <p className="text-sm text-destructive">{errText(q.error) || "Couldn't load this invoice."}</p>
      ) : (
        <div className="space-y-5">
          {/* the headline */}
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {pair ? <Badge colour={pair.colour}>{pair.label}</Badge> : null}
                {inv.payState === "paid" ? <Badge colour="#3F7D3A">Paid</Badge> : null}
                {inv.checkedBy ? <span className="text-xs text-muted-foreground">Checked by {inv.checkedBy}</span> : null}
              </div>
              {inv.matchNote
                ? inv.matchNote.split(" | ").map((t, i) => (
                    <p key={i} className={i ? "text-xs text-muted-foreground" : "mt-1.5 text-xs text-muted-foreground"}>
                      {t}
                    </p>
                  ))
                : null}
            </div>
            <div className="text-right">
              <p className="tabular text-lg font-bold">{moneyExact(inv.totalIncGst)}</p>
              <p className="text-[11px] text-muted-foreground">
                inc GST · {moneyExact(inv.exGst)} ex · due {inv.due ? shortDate(inv.due) : "unknown"}
                {inv.dueDate ? "" : inv.due ? " (30 days EOM)" : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {inv.pdfUrl ? (
              <Button size="sm" variant="outline" asChild>
                <a href={inv.pdfUrl} target="_blank" rel="noreferrer">
                  <FileText /> Open the PDF
                </a>
              </Button>
            ) : null}
            {inv.gmailLink ? (
              <Button size="sm" variant="outline" asChild>
                <a href={inv.gmailLink} target="_blank" rel="noreferrer">
                  <Mail /> Open the email
                </a>
              </Button>
            ) : null}
          </div>

          {/* invoice next to PO */}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-border">
              <p className="border-b border-border px-3 py-2 text-xs font-semibold">On the invoice</p>
              <div className="space-y-1 px-3 py-2 text-xs">
                <KV k="Order ref printed" v={inv.poRefRaw || "none"} />
                {inv.goodsExGst != null ? <KV k="Goods ex GST" v={moneyExact(inv.goodsExGst)} /> : null}
                {inv.freightExGst != null ? <KV k="Freight ex GST" v={moneyExact(inv.freightExGst)} /> : null}
                <KV k="Total ex GST" v={moneyExact(inv.exGst)} strong />
              </div>
              {inv.lines.length ? (
                <ul className="divide-y divide-border border-t border-border">
                  {inv.lines.map((l, i) => (
                    <li key={i} className="flex gap-2 px-3 py-1.5 text-xs">
                      <span className="min-w-0 flex-1">
                        {l.description}
                        {l.qty != null ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · {l.qty} {l.unit ?? ""}
                            {l.unitPriceExGst != null ? ` × ${moneyExact(l.unitPriceExGst)}` : ""}
                          </span>
                        ) : null}
                      </span>
                      <span className="tabular">{l.totalExGst != null ? moneyExact(l.totalExGst) : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="rounded-md border border-border">
              <p className="border-b border-border px-3 py-2 text-xs font-semibold">{inv.po ? `On PO ${inv.po.number}` : "No PO"}</p>
              {inv.po ? (
                <>
                  <div className="space-y-1 px-3 py-2 text-xs">
                    <KV k="Goods ex GST" v={moneyExact(inv.po.goodsExGst)} />
                    {inv.po.chargesExGst ? <KV k="Charges ex GST" v={moneyExact(inv.po.chargesExGst)} /> : null}
                    <KV k="Freight ex GST" v={moneyExact(inv.po.freightExGst)} />
                    <KV k="Total ex GST" v={moneyExact(inv.po.totalExGst)} strong />
                    {inv.diffExGst != null && Math.abs(inv.diffExGst) >= 0.01 ? (
                      <p className={inv.diffExGst > 0 ? "pt-1 font-semibold text-[var(--warning)]" : "pt-1 font-semibold text-[var(--success)]"}>
                        Invoice is {moneyExact(Math.abs(inv.diffExGst))} {inv.diffExGst > 0 ? "over" : "under"} the PO.
                      </p>
                    ) : null}
                  </div>
                  <ul className="divide-y divide-border border-t border-border">
                    {inv.po.lines.map((l) => (
                      <li key={l.id} className="flex gap-2 px-3 py-1.5 text-xs">
                        <span className="min-w-0 flex-1">
                          {l.description}
                          <span className="text-muted-foreground">
                            {" "}
                            · {l.unit === "%" ? `${l.unitCostExGst}%` : `${l.qty} ${l.unit} × ${moneyExact(l.unitCostExGst)}`}
                          </span>
                        </span>
                        <span className="tabular">{moneyExact(l.totalExGst)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="px-3 py-3 text-xs text-muted-foreground">Not tied to a PO. Pick one below, or okay it if there was never going to be one.</p>
              )}
            </div>
          </div>

          {inv.docType !== "credit" ? <InvoicePriceChecks invoiceId={inv.id} /> : null}

          {/* actions */}
          <div className="space-y-3 border-t border-border pt-4">
            {!inv.supplierId ? (
              <div>
                <p className="label-xs mb-1.5">Which supplier is "{inv.supplierNameRaw}"?</p>
                <div className="flex flex-wrap gap-2">
                  <Select className="w-auto min-w-[220px]" value={supPick} onChange={(e) => setSupPick(e.target.value)}>
                    <option value="">Pick a supplier</option>
                    {(suppliers.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" disabled={!supPick || busy} onClick={() => run(() => setSupplier.mutateAsync({ invoiceId: inv.id, supplierId: Number(supPick) }))}>
                    Save
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">Ops remembers this name, so the next one from them goes straight through.</p>
              </div>
            ) : (
              <div>
                <p className="label-xs mb-1.5">{inv.po ? "Tie to a different PO" : "Tie to a PO"}</p>
                <div className="flex flex-wrap gap-2">
                  <Select className="w-auto min-w-[260px]" value={poPick} onChange={(e) => setPoPick(e.target.value)}>
                    <option value="">{openPos.isLoading ? "Loading POs…" : "Pick a PO"}</option>
                    {(openPos.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.number} · {p.jobTitle} · {moneyExact(p.totalExGst)} ex{p.status === "invoiced" ? " · has an invoice" : ""}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" disabled={!poPick || busy} onClick={() => run(() => match.mutateAsync({ invoiceId: inv.id, poId: Number(poPick) }).then(() => setPoPick("")))}>
                    Tie to PO
                  </Button>
                  {inv.po ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => match.mutateAsync({ invoiceId: inv.id, poId: null }))}>
                      <X /> Untie from {inv.po.number}
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => rematch.mutateAsync({ invoiceId: inv.id }))}>
                      <RotateCcw /> Try matching again
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {(inv.pair === "different" || inv.pair === "no_po") && !inv.checkedAt ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => checked.mutateAsync({ invoiceId: inv.id, checked: true }))}>
                  <Check /> {inv.pair === "different" ? "Okay the difference" : "Okay with no PO"}
                </Button>
              ) : null}
              {inv.checkedAt ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => checked.mutateAsync({ invoiceId: inv.id, checked: false }))}>
                  Undo okay
                </Button>
              ) : null}
              {inv.payState === "unpaid" ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => paid.mutateAsync({ invoiceId: inv.id, paid: true, note: "" }))}>
                  Mark paid
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => paid.mutateAsync({ invoiceId: inv.id, paid: false, note: "" }))}>
                  Mark unpaid
                </Button>
              )}
              {busy ? <Spinner className="self-center" /> : null}
            </div>
            {inv.paidNote ? <p className="text-xs text-muted-foreground">{inv.paidNote}</p> : null}
            {inv.jobId ? (
              <Link to={`/jobs/${inv.jobId}`} className="text-xs font-medium text-primary hover:underline">
                Open the job
              </Link>
            ) : null}
            {error ? <ErrorLine text={error} /> : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

function KV({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className={strong ? "flex justify-between font-semibold" : "flex justify-between text-muted-foreground"}>
      <span>{k}</span>
      <span className="tabular">{v}</span>
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-destructive">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </p>
  );
}

/* ============================ missing-invoice request ============================ */

const REQ_STATUS: Record<string, { label: string; colour: string }> = {
  waiting_ok: { label: "Waiting for your okay", colour: "#D08A1E" },
  no_email: { label: "No email on file", colour: "#C0603F" },
  sent: { label: "Sent", colour: "#4A7FA5" },
  received: { label: "Invoice received", colour: "#3F7D3A" },
  cancelled: { label: "Cancelled", colour: "#A9A29B" },
};
export const requestStatus = (s: string) => REQ_STATUS[s] ?? { label: s, colour: "#7A736D" };

export function RequestModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useInvoiceRequest(id);
  const r = q.data;
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={r ? `Ask for invoice ${r.invoiceNumber}` : "Invoice request"} subtitle={r ? `${r.supplierNameRaw} · from team@terraflooring.com.au` : undefined}>
      {q.isLoading ? <Loading /> : !r ? <p className="text-sm text-destructive">{errText(q.error) || "Couldn't load this request."}</p> : <RequestForm key={r.id} r={r} onClose={onClose} />}
    </Modal>
  );
}

type Req = NonNullable<ReturnType<typeof useInvoiceRequest>["data"]>;

function RequestForm({ r, onClose }: { r: Req; onClose: () => void }) {
  const [to, setTo] = React.useState(r.toAddress ?? "");
  const [body, setBody] = React.useState(r.body);
  const [saveEmail, setSaveEmail] = React.useState(!r.toAddress);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState("");
  const edit = useEditRequest();
  const send = useSendRequest();
  const cancel = useCancelRequest();
  const open = r.status === "waiting_ok" || r.status === "no_email";
  const changed = to.trim() !== (r.toAddress ?? "") || body !== r.body;
  const busy = edit.isPending || send.isPending || cancel.isPending;
  const st = requestStatus(r.status);

  async function saveEdits() {
    if (!changed) return;
    await edit.mutateAsync({ id: r.id, toAddress: to.trim(), body, saveEmail: saveEmail && !!r.supplierId });
  }

  if (done) {
    return (
      <div className="space-y-4">
        <p className="text-sm">{done}</p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge colour={st.colour}>{st.label}</Badge>
        {r.invoiceDate ? <span>Dated {shortDate(r.invoiceDate)}</span> : null}
        {r.amountIncGst != null ? <span>· {moneyExact(r.amountIncGst)} inc GST on their statement</span> : null}
        {r.sentAt ? <span>· sent {new Date(r.sentAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}</span> : null}
      </div>
      {open ? (
        <>
          <Field label="Send to">
            <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="accounts@supplier.com.au" />
          </Field>
          {r.supplierId && to.trim() && to.trim() !== (r.toAddress ?? "") ? (
            <label htmlFor="req_save_email" className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox id="req_save_email" checked={saveEmail} onChange={(e) => setSaveEmail(e.target.checked)} />
              Save this email on the supplier for next time
            </label>
          ) : null}
          <Field label="Subject">
            <Input value={r.subject} disabled />
          </Field>
          <Field label="Message" hint="It asks them to send the invoice to billing@terraflooring.com.au.">
            <Textarea rows={9} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">To {r.toAddress ?? "nobody"}</p>
          <pre className="whitespace-pre-wrap rounded-md bg-secondary/60 px-3 py-2 font-sans text-xs">{r.body}</pre>
        </div>
      )}
      {r.error ? <ErrorLine text={r.error} /> : null}
      {error ? <ErrorLine text={error} /> : null}

      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        {open ? (
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                setError("");
                try {
                  await cancel.mutateAsync({ id: r.id });
                  setDone("Request cancelled. Nothing was sent.");
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              Don't send
            </Button>
            {changed ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setError("");
                  if (to.trim() && !EMAIL_RE.test(to.trim())) return setError(`"${to.trim()}" is not an email address.`);
                  try {
                    await saveEdits();
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Save changes
              </Button>
            ) : null}
            <Button
              disabled={busy || !EMAIL_RE.test(to.trim())}
              onClick={async () => {
                setError("");
                try {
                  await saveEdits();
                  const res = await send.mutateAsync({ id: r.id });
                  setDone(res.status === "sent" ? `Sent to ${to.trim()} from team@.` : `Status now: ${requestStatus(res.status).label}.`);
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              {send.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send />}
              Okay, send it
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

/* ================================ upload ================================ */

/** Drop in a supplier PDF by hand. Read and matched like one from email. */
export function UploadPdfButton() {
  const upload = useUploadSupplierPdf();
  const ref = React.useRef<HTMLInputElement>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function onFile(f: File) {
    setMsg(null);
    if (f.size > 20_000_000) return setMsg({ ok: false, text: "That PDF is over 20 MB." });
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await upload.mutateAsync({ filename: f.name, base64: btoa(bin) });
      const bits = [r.invoices ? `${r.invoices} ${r.invoices === 1 ? "invoice" : "invoices"}` : "", r.statements ? `${r.statements} ${r.statements === 1 ? "statement" : "statements"}` : ""].filter(Boolean);
      setMsg(bits.length ? { ok: true, text: `Read ${bits.join(" and ")} from ${f.name}.` } : { ok: false, text: r.found.join(". ") || "Nothing useful in that PDF." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={ref}
        type="file"
        accept="application/pdf,.pdf"
        aria-label="Upload invoice PDF"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onFile(f);
        }}
      />
      <Button variant="outline" onClick={() => ref.current?.click()} disabled={upload.isPending}>
        {upload.isPending ? <Spinner /> : <Upload />}
        {upload.isPending ? "Reading…" : "Upload a PDF"}
      </Button>
      {msg ? <p className={msg.ok ? "max-w-xs text-right text-xs text-[var(--success)]" : "max-w-xs text-right text-xs text-destructive"}>{msg.text}</p> : null}
    </div>
  );
}
