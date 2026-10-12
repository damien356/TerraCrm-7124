import * as React from "react";
import { PackageCheck, Paperclip, X } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { moneyExact } from "../lib/money";
import { uploadToStorage } from "../queries/media";
import { useDeliveryStatus, useMarkDelivered } from "../queries/delivery";

/**
 * MARK DELIVERED (188001 fix list item 13).
 *
 * Only on supply only jobs: the accepted quote has no labour, prep or removal
 * and there is no live dispatch, so crew never complete it on the phone. The
 * office adds the proof and the day it arrived. The job goes to Complete and
 * the final invoice is raised, ready to send from Client invoices.
 */

const todayIso = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const dateOf = (v: Date | string | null | undefined) => {
  if (!v) return null;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};

function MarkDeliveredModal({ jobId, open, onClose, onDone }: { jobId: number; open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const mark = useMarkDelivered();
  const [day, setDay] = React.useState(todayIso());
  const [files, setFiles] = React.useState<File[]>([]);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) return;
    setDay(todayIso());
    setFiles([]);
    setNote("");
    setError(null);
    setUploading(false);
  }, [open]);

  if (!open) return null;
  const busy = uploading || mark.isPending;

  async function save() {
    setError(null);
    if (!day) return setError("Pick the day it was delivered.");
    if (day > todayIso()) return setError("The delivered date cannot be in the future.");
    if (!files.length) return setError("Add a photo or proof of delivery.");
    setUploading(true);
    let proofs: { storageKey: string; filename: string; mime: string; sizeBytes: number }[];
    try {
      proofs = [];
      for (const f of files) {
        const key = await uploadToStorage(f, jobId, "completion");
        proofs.push({ storageKey: key, filename: f.name, mime: f.type || "application/octet-stream", sizeBytes: f.size });
      }
    } catch (e) {
      setUploading(false);
      return setError(errorText(e));
    }
    setUploading(false);
    mark.mutate(
      { jobId, deliveredOn: day, proofs, note: note.trim() || null },
      {
        onSuccess: (out) => {
          onDone(
            out.invoice
              ? `Marked delivered. The job is Complete. Final invoice ${out.invoice.ref} for ${moneyExact(out.invoice.total)} is raised and ready to send from Client invoices.`
              : `Marked delivered. The job is Complete. No invoice raised: ${out.invoiceNote ?? "nothing left to bill."}`,
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
      title="Mark delivered"
      subtitle="The proof goes in the job file under Completion. The job moves to Complete and the final invoice is raised. It is not emailed until you send it."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : <PackageCheck className="size-4" />}
            {uploading ? "Uploading" : "Mark delivered"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Delivered on">
          <Input type="date" value={day} max={todayIso()} onChange={(e) => setDay(e.target.value)} />
        </Field>
        <Field label="Photo or proof of delivery" hint="A photo of the goods on site, a signed docket or the carrier's proof. Several files are fine.">
          <div className="grid gap-2">
            <input
              ref={input}
              type="file"
              multiple
              accept="image/*,application/pdf"
              className="hidden"
              aria-label="Proof of delivery files"
              data-testid="delivery-proof-input"
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                setFiles((prev) => [...prev, ...picked].slice(0, 20));
                e.target.value = "";
              }}
            />
            <Button variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy}>
              <Paperclip className="size-3.5" />
              {files.length ? "Add another" : "Add proof"}
            </Button>
            {files.length ? (
              <ul className="grid gap-1">
                {files.map((f, i) => (
                  <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md bg-secondary px-2 py-1 text-xs">
                    <span className="truncate">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
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
          <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example, left with the site manager" />
        </Field>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

export function DeliveryCard({ jobId }: { jobId: number }) {
  const st = useDeliveryStatus(jobId);
  const [open, setOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const s = st.data;
  if (!s || !s.supplyOnly) return null;

  return (
    <Card>
      <CardHeader
        title="Delivery"
        subtitle="Supply only. No crew on this job, so it completes when you mark it delivered."
        action={
          s.canMark ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <PackageCheck className="size-3.5" />
              Mark delivered
            </Button>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        {s.completedAt ? (
          <>
            <Badge colour="#3F7D3A">{s.deliveredBy ? "Delivered" : "Complete"}</Badge>
            <span className="text-xs text-muted-foreground">
              {dateOf(s.completedAt)}
              {s.deliveredBy ? `. Marked by ${s.deliveredBy}. Proof is in the job file under Completion.` : "."}
            </span>
          </>
        ) : (
          <>
            <Badge colour="#D08A1E">Not delivered yet</Badge>
            <span className="text-xs text-muted-foreground">Mark it delivered with a photo or proof once the goods arrive.</span>
          </>
        )}
      </div>
      {notice ? <p className="border-t border-border px-4 py-2 text-xs text-[var(--success)]">{notice}</p> : null}
      <MarkDeliveredModal jobId={jobId} open={open} onClose={() => setOpen(false)} onDone={setNotice} />
    </Card>
  );
}
