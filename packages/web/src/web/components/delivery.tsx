import * as React from "react";
import { HandHelping, PackageCheck, Paperclip, X } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { CareGuideButton } from "./sale-job";
import { unitLabel } from "./quote-pickers";
import { moneyExact } from "../lib/money";
import { uploadToStorage } from "../queries/media";
import { useDeliveryStatus, useRecordHandover } from "../queries/delivery";

/**
 * DELIVERED OR COLLECTED (188001 fix list item 13, Damien 30 Oct Fix 1).
 *
 * Only on supply only jobs: no crew, so nobody completes it on the phone.
 * The office records each handover: delivered (needs proof) or collected
 * (who took it, photo optional), all of it or part, line by line. When
 * nothing is left outstanding the job goes to Complete and the final invoice
 * is raised for anything not billed yet. Handing goods over never marks
 * anything paid. Payment lives on Client invoices only.
 */

type Status = NonNullable<ReturnType<typeof useDeliveryStatus>["data"]>;
type Kind = "delivered" | "collected";

const todayIso = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;
const qtyText = (n: number, unit: string) => `${Number(n.toFixed(4))} ${unitLabel(unit)}`;

const dateOf = (v: Date | string | null | undefined) => {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00` : v) : v;
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

function HandoverModal({ jobId, kind, st, onClose, onDone }: { jobId: number; kind: Kind; st: Status; onClose: () => void; onDone: (msg: string) => void }) {
  const save = useRecordHandover();
  const open = st.lines.filter((l) => l.outstanding > 0.00005);
  const [day, setDay] = React.useState(todayIso());
  const [qty, setQty] = React.useState<Record<number, string>>(() => Object.fromEntries(open.map((l) => [l.quoteItemId, String(l.outstanding)])));
  const [who, setWho] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [batchKey] = React.useState(newKey);
  const [proofs, setProofs] = React.useState<{ storageKey: string; filename: string; mime: string; sizeBytes: number }[] | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const busy = uploading || save.isPending;
  const collected = kind === "collected";

  async function submit() {
    setError(null);
    if (!day) return setError(`Pick the day it was ${kind}.`);
    if (day > todayIso()) return setError(`The ${kind} date cannot be in the future.`);
    if (collected && !who.trim()) return setError("Type who collected it.");
    if (!collected && !files.length) return setError("Add a photo or proof of delivery.");
    const lines = open.map((l) => ({ l, n: Number((qty[l.quoteItemId] ?? "").trim() || "0") }));
    for (const { l, n } of lines) {
      if (!Number.isFinite(n) || n < 0) return setError(`"${l.description}": type a quantity of 0 or more.`);
      if (n > l.outstanding + 0.00005) return setError(`"${l.description}": only ${qtyText(l.outstanding, l.unit)} is still to go.`);
    }
    if (open.length && !lines.some((x) => x.n > 0)) return setError("Type how much of at least one line went.");

    // Upload once. A retry after an error reuses the files already up.
    let up = proofs;
    if (!up) {
      setUploading(true);
      try {
        up = [];
        for (const f of files) {
          const key = await uploadToStorage(f, jobId, "completion");
          up.push({ storageKey: key, filename: f.name, mime: f.type || "application/octet-stream", sizeBytes: f.size });
        }
        setProofs(up);
      } catch (e) {
        setUploading(false);
        return setError(errorText(e));
      }
      setUploading(false);
    }
    save.mutate(
      {
        jobId,
        kind,
        on: day,
        lines: open.length ? lines.map(({ l, n }) => ({ quoteItemId: l.quoteItemId, qty: n })) : null,
        collectedBy: collected ? who.trim() : null,
        proofs: up,
        note: note.trim() || null,
        batchKey,
      },
      {
        onSuccess: (out) => {
          const what = collected ? `Collected by ${who.trim()}` : "Delivered";
          if (out.reused) onDone(`${what}. This was already recorded by the first click.`);
          else if (out.outstanding > 0) onDone(`${what}, recorded. ${out.outstanding} line${out.outstanding === 1 ? "" : "s"} still to hand over. Payment is not changed.`);
          else
            onDone(
              out.invoice
                ? `${what}. Everything is supplied and the job is Complete. Final invoice ${out.invoice.ref} for ${moneyExact(out.invoice.total)} is raised, not emailed. Payment is not changed.`
                : `${what}. Everything is supplied and the job is Complete. ${out.invoiceNote ?? "Nothing left to bill."} Payment is not changed.`,
            );
          onClose();
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={collected ? "Collected" : "Delivered"}
      subtitle={
        collected
          ? "Who took it, when, and how much. A photo is optional. This does not mark anything paid."
          : "When it arrived and how much. Proof goes in the job file under Completion. This does not mark anything paid."
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="handover-save">
            {busy ? <Spinner /> : collected ? <HandHelping className="size-4" /> : <PackageCheck className="size-4" />}
            {uploading ? "Uploading" : collected ? "Record collected" : "Record delivered"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={collected ? "Collected on" : "Delivered on"}>
            <Input type="date" value={day} max={todayIso()} onChange={(e) => setDay(e.target.value)} />
          </Field>
          {collected ? (
            <Field label="Who collected it">
              <Input value={who} maxLength={120} onChange={(e) => setWho(e.target.value)} placeholder="Name, and company if a courier" data-testid="collected-by" />
            </Field>
          ) : null}
        </div>
        {open.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="handover-lines">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border text-left">
                  <th className="py-1.5 pr-2 font-medium">Line</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Still to go</th>
                  <th className="py-1.5 text-right font-medium">{collected ? "Collected now" : "Delivered now"}</th>
                </tr>
              </thead>
              <tbody>
                {open.map((l) => (
                  <tr key={l.quoteItemId} className="border-b border-border">
                    <td className="py-1.5 pr-2">{l.description}</td>
                    <td className="tabular py-1.5 pr-2 text-right">{qtyText(l.outstanding, l.unit)}</td>
                    <td className="py-1.5 text-right">
                      <Input
                        className="tabular ml-auto w-24 text-right"
                        inputMode="decimal"
                        value={qty[l.quoteItemId] ?? ""}
                        onChange={(e) => setQty((q) => ({ ...q, [l.quoteItemId]: e.target.value }))}
                        aria-label={`${l.description} quantity now`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted-foreground">Type 0 for anything not handed over this time. It stays outstanding.</p>
          </div>
        ) : null}
        <Field
          label={collected ? "Photo (optional)" : "Photo or proof of delivery"}
          hint={collected ? "A photo of what was taken, or a signed docket." : "A photo of the goods on site, a signed docket or the carrier's proof. Several files are fine."}
        >
          <div className="grid gap-2">
            <input
              ref={input}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              aria-label="Proof files"
              data-testid="delivery-proof-input"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((prev) => [...prev, ...picked].slice(0, 20));
                setProofs(null);
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
              <Paperclip className="size-3.5" />
              {files.length ? "Add another" : collected ? "Add photo" : "Add proof"}
            </Button>
            {files.length ? (
              <ul className="grid gap-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-secondary px-2 py-1 text-xs">
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => {
                        setFiles((prev) => prev.filter((_, j) => j !== i));
                        setProofs(null);
                      }}
                      className="text-muted-foreground hover:text-foreground"
                      disabled={busy}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Field>
        <Field label="Note (optional)">
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={collected ? "For example, rest to be collected Friday" : "For example, left with the site manager"} />
        </Field>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

export function DeliveryCard({ jobId }: { jobId: number }) {
  const st = useDeliveryStatus(jobId);
  const [kind, setKind] = React.useState<Kind | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const s = st.data;
  if (!s || !s.supplyOnly) return null;
  const part = !s.completedAt && s.handovers.length > 0;

  return (
    <Card>
      <CardHeader
        title="Delivered or collected"
        subtitle="Supply only, no crew. Record each handover. The job completes when nothing is left to hand over. Payment is tracked on Client invoices, not here."
        action={
          s.canMark ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setKind("delivered")} data-testid="mark-delivered">
                <PackageCheck className="size-3.5" />
                Delivered
              </Button>
              <Button size="sm" variant="outline" onClick={() => setKind("collected")} data-testid="mark-collected">
                <HandHelping className="size-3.5" />
                Collected
              </Button>
            </div>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        {s.completedAt ? (
          <>
            <Badge colour="#3F7D3A">All supplied</Badge>
            <span className="text-xs text-muted-foreground">
              {dateOf(s.completedAt)}
              {s.deliveredBy ? `. Recorded by ${s.deliveredBy}.` : "."}
            </span>
          </>
        ) : part ? (
          <>
            <Badge colour="#D08A1E">Part supplied</Badge>
            <span className="text-xs text-muted-foreground">
              {s.outstanding} line{s.outstanding === 1 ? "" : "s"} still to hand over.
            </span>
          </>
        ) : (
          <>
            <Badge colour="#D08A1E">Nothing handed over yet</Badge>
            <span className="text-xs text-muted-foreground">Record it when the goods are delivered or collected.</span>
          </>
        )}
      </div>
      {s.lines.length ? (
        <div className="overflow-x-auto border-t border-border px-4 py-2">
          <table className="w-full text-sm" data-testid="supply-lines">
            <thead className="text-xs text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 pr-2 font-medium">Line</th>
                <th className="py-1 pr-2 text-right font-medium">Sold</th>
                <th className="py-1 pr-2 text-right font-medium">Supplied</th>
                <th className="py-1 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {s.lines.map((l) => (
                <tr key={l.quoteItemId} className="border-t border-border">
                  <td className="py-1 pr-2">{l.description}</td>
                  <td className="tabular py-1 pr-2 text-right">{qtyText(l.qty, l.unit)}</td>
                  <td className="tabular py-1 pr-2 text-right">{qtyText(l.supplied, l.unit)}</td>
                  <td className={`tabular py-1 text-right ${l.outstanding > 0.00005 ? "font-medium text-amber-700" : "text-muted-foreground"}`}>
                    {l.outstanding > 0.00005 ? qtyText(l.outstanding, l.unit) : "none"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.legacy ? <p className="mt-1 text-xs text-muted-foreground">Marked delivered before part handovers were kept, so all of it is shown as supplied.</p> : null}
        </div>
      ) : null}
      {s.handovers.length ? (
        <ul className="divide-y divide-border border-t border-border" data-testid="handover-history">
          {s.handovers.map((h) => (
            <li key={h.batchKey} className="px-4 py-2 text-sm">
              <p>
                <span className="font-medium">{h.kind === "collected" ? `Collected by ${h.collectedBy}` : "Delivered"}</span>
                <span className="text-xs text-muted-foreground">
                  {" "}
                  {dateOf(h.handedOn)}
                  {h.by ? `, recorded by ${h.by}` : ""}
                </span>
              </p>
              {h.lines.length ? (
                <p className="text-xs text-muted-foreground">{h.lines.map((l) => `${l.description}: ${qtyText(l.qty, l.unit)}`).join("; ")}</p>
              ) : null}
              {h.note ? <p className="text-xs text-muted-foreground">{h.note}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">No automatic care emails on supply only jobs.</span>
        <CareGuideButton jobId={jobId} onSent={setNotice} />
      </div>
      {notice ? <p className="border-t border-border px-4 py-2 text-xs text-[var(--success)]">{notice}</p> : null}
      {kind ? <HandoverModal jobId={jobId} kind={kind} st={s} onClose={() => setKind(null)} onDone={setNotice} /> : null}
    </Card>
  );
}
