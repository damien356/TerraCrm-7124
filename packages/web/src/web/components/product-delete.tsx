import * as React from "react";
import { History, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/card";
import {
  useProductDeleteApply,
  useProductDeleteLog,
  useProductDeletePreview,
  useProductDeleteRows,
  useProductDeleteUndo,
} from "../queries/product-delete";

/**
 * 15 Oct. Settings, Price list: delete products. The bin on a row and Delete
 * selected both open DeleteConfirmModal, which shows what will go and what
 * is hidden instead because it is used, and waits for a confirm. Undo last
 * delete and the delete log sit next to the import buttons. Admin only (the
 * page checks, and so do the routes).
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Try again.");
const when = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
const n = (k: number, one: string, many: string) => `${k.toLocaleString("en-AU")} ${k === 1 ? one : many}`;
const SHOW = 100;

export function DeleteConfirmModal({
  ids,
  onClose,
  onDone,
}: {
  ids: number[] | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const preview = useProductDeletePreview(ids);
  const apply = useProductDeleteApply();
  const p = preview.data;
  const single = ids?.length === 1;
  const close = () => {
    apply.reset();
    onClose();
  };
  const action = !p ? "" : p.toDelete ? `Delete ${n(p.toDelete, "product", "products")}` : p.toHide ? `Hide ${n(p.toHide, "product", "products")} instead` : "";
  const hideList = p?.notDeleted.filter((i) => i.outcome === "hide") ?? [];
  const keptList = p?.notDeleted.filter((i) => i.outcome === "kept") ?? [];

  return (
    <Modal
      open={!!ids}
      onClose={close}
      width="max-w-2xl"
      title={single ? "Delete product" : "Delete selected products"}
      subtitle={ids && !single ? `${n(ids.length, "product", "products")} selected.` : undefined}
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-delete"
            disabled={!p || !action || apply.isPending}
            onClick={() =>
              ids &&
              apply.mutate(
                { ids },
                {
                  onSuccess: (r) => {
                    onDone(r.note);
                    onClose();
                  },
                },
              )
            }
          >
            {apply.isPending ? <Spinner /> : <Trash2 className="size-4" />}
            {action || "Nothing to delete"}
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <Spinner />
      ) : preview.isError ? (
        <p className="text-sm text-destructive">{errText(preview.error)}</p>
      ) : p ? (
        <div className="space-y-3 text-sm" data-testid="delete-preview">
          {single && p.selected === 1 ? (
            <p className="font-medium">
              {(p.deleteSample[0] ?? p.notDeleted[0])?.name}
              {(p.deleteSample[0] ?? p.notDeleted[0])?.supplier ? (
                <span className="font-normal text-muted-foreground"> · {(p.deleteSample[0] ?? p.notDeleted[0])?.supplier}</span>
              ) : null}
            </p>
          ) : null}

          {p.toDelete ? (
            <p>
              <span className="font-semibold">{n(p.toDelete, "product", "products")}</span> will be deleted for good. {p.toDelete === 1 ? "It has" : "They have"} never
              been on a quote, job, invoice or purchase order.
            </p>
          ) : (
            <p className="font-medium">Nothing here can be deleted.</p>
          )}

          {p.toHide ? (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
              <span className="font-semibold">{n(p.toHide, "product is", "products are")}</span> used on a quote, job, invoice or purchase
              order, so {p.toHide === 1 ? "it" : "they"} will be hidden instead (Active unticked). Old quotes and invoices keep{" "}
              {p.toHide === 1 ? "it" : "them"}.
            </p>
          ) : null}
          {p.alreadyHidden ? (
            <p className="text-muted-foreground">
              {n(p.alreadyHidden, "used product is", "used products are")} already hidden and stay{p.alreadyHidden === 1 ? "s" : ""} as{" "}
              {p.alreadyHidden === 1 ? "it is" : "they are"}.
            </p>
          ) : null}
          {p.kept ? (
            <p className="text-muted-foreground">
              {n(p.kept, "product is", "products are")} in an underlay upgrade pair in Settings, Business rules, so{" "}
              {p.kept === 1 ? "it is" : "they are"} left as {p.kept === 1 ? "it is" : "they are"}. Take {p.kept === 1 ? "it" : "them"} out of
              the pair first.
            </p>
          ) : null}
          {p.missing ? <p className="text-muted-foreground">{n(p.missing, "was", "were")} already gone.</p> : null}

          {hideList.length || keptList.length ? (
            <div>
              <p className="label-xs mb-1">Not deleted, and why</p>
              <div className="max-h-56 overflow-y-auto rounded border border-border bg-secondary/30">
                {[...hideList, ...keptList].slice(0, SHOW).map((i) => (
                  <div key={i.id} className="border-b border-border px-2 py-1 text-xs last:border-0">
                    <span className="font-medium">{i.name}</span>
                    {i.supplier ? <span className="text-muted-foreground"> · {i.supplier}</span> : null}
                    {!i.active ? <span className="text-muted-foreground"> · already hidden</span> : null}
                    <div className="text-muted-foreground">{i.reason}</div>
                  </div>
                ))}
                {hideList.length + keptList.length > SHOW ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">And {hideList.length + keptList.length - SHOW} more.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {p.toDelete && !single ? (
            <div>
              <p className="label-xs mb-1">To be deleted</p>
              <div className="max-h-40 overflow-y-auto rounded border border-border bg-secondary/30">
                {p.deleteSample.map((i) => (
                  <div key={i.id} className="border-b border-border px-2 py-1 text-xs last:border-0">
                    <span className="font-medium">{i.name}</span>
                    {i.supplier ? <span className="text-muted-foreground"> · {i.supplier}</span> : null}
                  </div>
                ))}
                {p.toDelete > p.deleteSample.length ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">And {p.toDelete - p.deleteSample.length} more.</p>
                ) : null}
              </div>
            </div>
          ) : null}

          {action ? <p className="text-xs text-muted-foreground">Undo last delete puts it all back.</p> : null}
        </div>
      ) : null}
      {apply.isError ? <p className="mt-2 text-sm text-destructive">{errText(apply.error)}</p> : null}
    </Modal>
  );
}

/** Undo last delete and Delete log, next to the import buttons. */
export function ProductDeleteTools({ notice, onNotice }: { notice: string | null; onNotice: (msg: string | null) => void }) {
  const [undoOpen, setUndoOpen] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="delete-tools">
        <Button variant="outline" size="sm" onClick={() => setUndoOpen(true)}>
          <RotateCcw className="size-4" />
          Undo last delete
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setLogOpen(true)}>
          <History className="size-4" />
          Delete log
        </Button>
        {notice ? (
          <span className="text-sm text-[var(--success)]" data-testid="delete-notice">
            {notice}
          </span>
        ) : null}
      </div>
      <UndoDeleteModal open={undoOpen} onClose={() => setUndoOpen(false)} onDone={onNotice} />
      <DeleteLogModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

function UndoDeleteModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const log = useProductDeleteLog(open);
  const undo = useProductDeleteUndo();
  const last = log.data?.find((r) => r.canUndo) ?? log.data?.[0];
  const can = !!last?.canUndo;
  const close = () => {
    undo.reset();
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Undo last delete"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          <Button
            variant="destructive"
            data-testid="confirm-undo-delete"
            disabled={!can || undo.isPending}
            onClick={() =>
              undo.mutate(undefined, {
                onSuccess: (r) => {
                  onDone(`Delete undone. ${r.note}`);
                  onClose();
                },
              })
            }
          >
            {undo.isPending ? <Spinner /> : <RotateCcw className="size-4" />}
            Undo delete
          </Button>
        </>
      }
    >
      {log.isLoading ? (
        <Spinner />
      ) : !last ? (
        <p className="text-sm text-muted-foreground">No deletes yet.</p>
      ) : !can ? (
        <p className="text-sm text-muted-foreground">Every delete is already undone. The last one was {when(last.createdAt)}.</p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            Deleted by <span className="font-medium">{last.actorName}</span> on {when(last.createdAt)}: {n(last.deleted, "product", "products")}{" "}
            deleted, {n(last.hidden, "product", "products")} hidden instead.
          </p>
          <p>
            Undo puts every deleted product back with its prices, specials and swatch, and ticks Active again on the ones this delete hid.
            One you ticked again by hand is left as it is.
          </p>
        </div>
      )}
      {undo.isError ? <p className="mt-2 text-sm text-destructive">{errText(undo.error)}</p> : null}
    </Modal>
  );
}

function DeleteLogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const log = useProductDeleteLog(open);
  const [openId, setOpenId] = React.useState<number | null>(null);
  return (
    <Modal open={open} onClose={onClose} width="max-w-3xl" title="Delete log" subtitle="The last 20 price list deletes: who, when and which products.">
      {log.isLoading ? (
        <Spinner />
      ) : !log.data?.length ? (
        <p className="text-sm text-muted-foreground">No deletes yet.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {log.data.map((r) => (
            <div key={r.id} className="px-3 py-2 text-sm">
              <button
                type="button"
                className="flex w-full flex-wrap items-baseline gap-x-3 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
              >
                <span className="font-medium">
                  {when(r.createdAt)} · {r.actorName}
                </span>
                <span className="text-xs">
                  {n(r.deleted, "deleted", "deleted")}, {n(r.hidden, "hidden", "hidden")} instead
                </span>
                {r.status === "undone" ? (
                  <span className="text-xs text-destructive">
                    Undone {when(r.undoneAt)} by {r.undoneBy}
                  </span>
                ) : null}
              </button>
              {r.status === "undone" && r.undoNote ? <p className="mt-1 text-xs text-muted-foreground">{r.undoNote}</p> : null}
              {openId === r.id ? <DeleteLogRows deleteId={r.id} /> : null}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = { deleted: "Deleted", hidden: "Hidden instead", kept: "Left as it is" };

function DeleteLogRows({ deleteId }: { deleteId: number }) {
  const rows = useProductDeleteRows(deleteId);
  if (rows.isLoading) return <Spinner />;
  const list = rows.data ?? [];
  return (
    <div className="mt-2 max-h-72 overflow-y-auto rounded border border-border bg-secondary/30">
      {list.slice(0, 300).map((r) => (
        <div key={`${r.action}-${r.productId}`} className="border-b border-border px-2 py-1 text-xs last:border-0">
          <span className="font-medium">{r.name}</span> <span className="text-muted-foreground">{ACTION_LABEL[r.action] ?? r.action}</span>
          {r.reason ? <span className="text-muted-foreground">. {r.reason}</span> : null}
        </div>
      ))}
      {list.length > 300 ? <p className="px-2 py-1 text-xs text-muted-foreground">And {list.length - 300} more.</p> : null}
    </div>
  );
}
