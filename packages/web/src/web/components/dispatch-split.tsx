import * as React from "react";
import { Button } from "./ui/button";
import { Checkbox, Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { useJobDispatchLines, useMergeDispatches, useSplitDispatch } from "../queries/dispatches";
import { taskRef } from "../../api/lib/refs";

/* ---------------------------------------------------------------------------
 * Split by trade and Merge (fix list item 13). A quote makes one dispatch per
 * job with the uplift, disposal and prep on it. The office splits it when two
 * crews do the work and can put dispatches back together. Only free
 * dispatches can move: nothing offered, booked or started.
 * ------------------------------------------------------------------------- */

type DispatchRow = NonNullable<ReturnType<typeof useJobDispatchLines>["data"]>[number];
type WorkLine = DispatchRow["lines"][number];

const qtyText = (l: WorkLine) => `${Number(l.qty.toFixed(2))} ${l.unit === "m2" ? "m²" : l.unit}`;

/** "Carpet uplift 13.2 lm, Carpet disposal 48.3 m²" under a dispatch on the job page. */
export function DispatchWork({ lines }: { lines: WorkLine[] | undefined }) {
  if (!lines?.length) return null;
  return (
    <p className="mt-0.5 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Work:</span> {lines.map((l) => `${l.name} ${qtyText(l)}`).join(", ")}
    </p>
  );
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "That did not work. Try again.";
}

export function SplitDispatchModal({
  jobId,
  jobRef,
  taskId,
  open,
  onClose,
}: {
  jobId: number;
  jobRef: string;
  taskId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const rows = useJobDispatchLines(jobId);
  const split = useSplitDispatch();
  const task = rows.data?.find((t) => t.id === taskId) ?? null;
  const [picked, setPicked] = React.useState<number[]>([]);
  const [title, setTitle] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setPicked([]);
      setTitle("");
      split.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId]);

  const names = task?.lines.filter((l) => picked.includes(l.itemId)).map((l) => l.name) ?? [];
  const tooMany = task ? picked.length >= task.lines.length : false;

  function toggle(itemId: number) {
    setPicked((p) => (p.includes(itemId) ? p.filter((i) => i !== itemId) : [...p, itemId]));
  }

  function submit() {
    if (!task || !picked.length || tooMany) return;
    split.mutate({ taskId: task.id, itemIds: picked, title: title.trim() || null }, { onSuccess: onClose });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split by trade"
      subtitle={task ? `${taskRef(jobRef, task.seq)} ${task.title}. Tick the work that goes on a new dispatch.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!task || !picked.length || tooMany || !!task?.lock || split.isPending}>
            {split.isPending ? "Splitting" : "Split"}
          </Button>
        </>
      }
    >
      {rows.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the work lines.</p>
      ) : !task ? (
        <p className="text-sm text-muted-foreground">That dispatch is not on the job any more.</p>
      ) : task.lock ? (
        <p className="text-sm text-muted-foreground">This dispatch is {task.lock}, so it cannot be split. Take it back off the crew first.</p>
      ) : task.lines.length < 2 ? (
        <p className="text-sm text-muted-foreground">
          This dispatch has {task.lines.length ? "one work line" : "no work lines"}, so there is nothing to split. Use Measure up to add work to it.
        </p>
      ) : (
        <div className="space-y-4">
          <ul className="divide-y divide-border rounded-md border border-border">
            {task.lines.map((l) => (
              <li key={l.itemId}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <Checkbox checked={picked.includes(l.itemId)} onChange={() => toggle(l.itemId)} />
                  <span className="flex-1">{l.name}</span>
                  <span className="tabular text-xs text-muted-foreground">{qtyText(l)}</span>
                </label>
              </li>
            ))}
          </ul>
          <Field label="New dispatch name" hint="Leave it blank to name it after the work.">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={names.join(", ") || "e.g. Uplift and prep"} />
          </Field>
          {tooMany ? <p className="text-xs text-destructive">Leave at least one line on this dispatch.</p> : null}
          {split.error ? <p className="text-xs text-destructive">{errorText(split.error)}</p> : null}
        </div>
      )}
    </Modal>
  );
}

export function MergeDispatchesModal({
  jobId,
  jobRef,
  open,
  onClose,
}: {
  jobId: number;
  jobRef: string;
  open: boolean;
  onClose: () => void;
}) {
  const rows = useJobDispatchLines(jobId);
  const merge = useMergeDispatches();
  const list = (rows.data ?? []).filter((t) => t.status !== "cancelled");
  const [picked, setPicked] = React.useState<number[]>([]);
  const [into, setInto] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (open) {
      setPicked([]);
      setInto(null);
      merge.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const keep = into != null && picked.includes(into) ? into : (picked[0] ?? null);

  function toggle(id: number) {
    setPicked((p) => (p.includes(id) ? p.filter((i) => i !== id) : [...p, id]));
  }

  function submit() {
    if (keep == null || picked.length < 2) return;
    merge.mutate({ intoId: keep, taskIds: picked }, { onSuccess: onClose });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge dispatches"
      subtitle="Tick the dispatches to put back into one. The one you keep holds all the work."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={picked.length < 2 || merge.isPending}>
            {merge.isPending ? "Merging" : `Merge ${picked.length || ""}`.trim()}
          </Button>
        </>
      }
    >
      {rows.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the dispatches.</p>
      ) : (
        <div className="space-y-3">
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.map((t) => (
              <li key={t.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={picked.includes(t.id)}
                  disabled={!!t.lock}
                  onChange={() => toggle(t.id)}
                  aria-label={`Merge ${t.title}`}
                />
                <div className="min-w-0 flex-1">
                  <p className={t.lock ? "text-muted-foreground" : ""}>
                    <span className="tabular mr-1.5 text-xs font-semibold text-muted-foreground">{taskRef(jobRef, t.seq)}</span>
                    {t.title}
                  </p>
                  {t.lock ? (
                    <p className="text-xs text-muted-foreground">{`Can't merge, it is ${t.lock}.`}</p>
                  ) : t.lines.length ? (
                    <p className="text-xs text-muted-foreground">{t.lines.map((l) => `${l.name} ${qtyText(l)}`).join(", ")}</p>
                  ) : null}
                </div>
                {picked.includes(t.id) && picked.length > 1 ? (
                  <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input type="radio" name="merge-into" aria-label={`Keep ${t.title}`} checked={keep === t.id} onChange={() => setInto(t.id)} className="accent-[var(--primary)]" />
                    Keep
                  </label>
                ) : null}
              </li>
            ))}
          </ul>
          {merge.error ? <p className="text-xs text-destructive">{errorText(merge.error)}</p> : null}
        </div>
      )}
    </Modal>
  );
}
