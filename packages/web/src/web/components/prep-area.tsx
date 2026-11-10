import * as React from "react";
import { AlertTriangle, CheckCircle2, Wrench } from "lucide-react";
import { useConfirmPartial, useFollowArea, usePrepLinks } from "../queries/quote-defaults";
import { Input, Select } from "./ui/field";

type PrepLine = {
  id: number;
  quoteId: number;
  defaultReviewedBy?: string | null;
  defaultReviewedAt?: Date | string | null;
  defaultReviewNote?: string | null;
};

const when = (d: Date | string) =>
  new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Area prep (10 Nov, job 188016). Under a grinding or other m2 prep line:
 * the floor area it follows, and when the qty does not match, Follow area or
 * Confirm partial (a qty and a reason, never just a click).
 */
export function PrepAreaStrip({ item, locked, onNotice }: { item: PrepLine; locked: boolean; onNotice: (t: string) => void }) {
  const links = usePrepLinks(item.quoteId);
  const follow = useFollowArea();
  const partial = useConfirmPartial();
  const [floorId, setFloorId] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [qty, setQty] = React.useState("");
  const [reason, setReason] = React.useState("");
  const link = links.data?.lines.find((l) => l.id === item.id);
  const floors = links.data?.floors ?? [];
  if (!link) return null;
  const chosen = floorId ? Number(floorId) : (link.floorId ?? (floors.length === 1 ? floors[0]!.id : undefined));
  const busy = follow.isPending || partial.isPending;
  const fail = (e: Error) => onNotice(e.message);
  return (
    <div className="mt-1 flex flex-col gap-1 text-[11px]">
      {link.mode === "follows" ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Wrench className="size-3" /> {link.label}
          {link.floorName ? ` (${link.floorName})` : ""}
        </span>
      ) : link.mode === "partial" ? (
        <span className="inline-flex flex-wrap items-center gap-1 text-emerald-700">
          <CheckCircle2 className="size-3.5" /> {link.label}
          {item.defaultReviewedAt ? `, confirmed by ${item.defaultReviewedBy ?? "someone"} ${when(item.defaultReviewedAt)}` : ""}
          {item.defaultReviewNote ? `. ${item.defaultReviewNote}` : ""}
        </span>
      ) : link.mode === "unlinked" ? (
        <span className="text-muted-foreground">Not linked to a floor area.</span>
      ) : null}
      {link.wordingNote ? (
        <span className="inline-flex items-center gap-1 text-[#8A5A00]">
          <AlertTriangle className="size-3.5" /> {link.wordingNote}
        </span>
      ) : null}
      {locked || link.mode === "follows" ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {floors.length > 1 ? (
            <Select className="h-7 w-auto text-[11px]" aria-label="Floor area" value={chosen ? String(chosen) : ""} onChange={(e) => setFloorId(e.target.value)}>
              {chosen ? null : <option value="">Pick the floor area</option>}
              {floors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({Math.round(f.m2 * 100) / 100} m2)
                </option>
              ))}
            </Select>
          ) : null}
          <button
            type="button"
            disabled={busy || !chosen}
            onClick={() =>
              follow.mutate(
                { itemId: item.id, floorItemId: chosen },
                { onSuccess: (r) => onNotice(`Now follows the floor area: ${r.item?.qty ?? ""} m2.`), onError: fail },
              )
            }
            className="rounded-md bg-[var(--gold)] px-2 py-0.5 font-semibold text-[var(--sidebar)] disabled:opacity-50"
          >
            Follow area
          </button>
          <button
            type="button"
            disabled={busy || !chosen}
            onClick={() => setOpen((o) => !o)}
            className="rounded-md border border-border px-2 py-0.5 font-medium hover:bg-secondary disabled:opacity-50"
          >
            Confirm partial
          </button>
        </div>
      )}
      {open && !locked && chosen ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5">
          <Input className="tabular h-7 w-[80px] text-right text-[11px]" aria-label="Partial area m2" placeholder="m2" value={qty} onChange={(e) => setQty(e.target.value)} />
          <Input className="h-7 min-w-[200px] flex-1 text-[11px]" aria-label="Reason" placeholder="Reason, e.g. only the hallway needs grinding" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            type="button"
            disabled={busy || !(Number(qty) > 0) || reason.trim().length < 3}
            onClick={() =>
              partial.mutate(
                { itemId: item.id, qty: Number(qty), reason: reason.trim(), floorItemId: chosen },
                {
                  onSuccess: () => {
                    setOpen(false);
                    onNotice("Partial area confirmed. Your name, the time and the reason are kept.");
                  },
                  onError: fail,
                },
              )
            }
            className="rounded-md bg-[var(--gold)] px-2 py-0.5 font-semibold text-[var(--sidebar)] disabled:opacity-50"
          >
            Save partial
          </button>
        </div>
      ) : null}
    </div>
  );
}
