import * as React from "react";
import { Download, FileSpreadsheet, History, RotateCcw, Upload } from "lucide-react";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { Spinner } from "./ui/card";
import { downloadText } from "../queries/backups";
import {
  downloadBase64,
  readSheetFile,
  usePriceExport,
  usePriceImportConfirm,
  usePriceImportLog,
  usePriceImportPreview,
  usePriceImportRows,
  usePriceImportUndo,
  usePriceTemplate,
} from "../queries/price-import";

/**
 * Fix list 11 Oct, items 4 and 5. The four price list buttons on Settings,
 * Price list, plus the import log. Shown to Admin only (the page checks).
 */

type SheetFile = Awaited<ReturnType<typeof readSheetFile>>;
type Preview = NonNullable<ReturnType<typeof usePriceImportPreview>["data"]>;

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHOW = 200;

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

export function PriceListTools({ search, includeDiscontinued }: { search: string; includeDiscontinued: boolean }) {
  const template = usePriceTemplate();
  const exp = usePriceExport();
  const preview = usePriceImportPreview();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [file, setFile] = React.useState<SheetFile | null>(null);
  const [undoOpen, setUndoOpen] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setNotice(null);
    if (!/\.(csv|xlsx)$/i.test(f.name)) {
      setNotice("Pick a .csv or .xlsx file.");
      return;
    }
    const sheet = await readSheetFile(f);
    setFile(sheet);
    preview.mutate(sheet);
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="price-tools">
        <Button
          variant="outline"
          size="sm"
          disabled={template.isPending}
          onClick={() => template.mutate(undefined, { onSuccess: (r) => downloadText(r.filename, r.csv) })}
        >
          <Download className="size-4" />
          Download template
        </Button>
        <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
          <FileSpreadsheet className="size-4" />
          Export price list
        </Button>
        <Button variant="outline" size="sm" disabled={preview.isPending} onClick={() => fileRef.current?.click()}>
          {preview.isPending ? <Spinner /> : <Upload className="size-4" />}
          Import CSV
        </Button>
        <Button variant="outline" size="sm" onClick={() => setUndoOpen(true)}>
          <RotateCcw className="size-4" />
          Undo last import
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setLogOpen(true)}>
          <History className="size-4" />
          Import log
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="hidden"
          aria-label="Price list file"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {notice ? <span className="text-sm text-[var(--success)]">{notice}</span> : null}
        {preview.isError ? <span className="text-sm text-destructive">{errText(preview.error)}</span> : null}
      </div>

      <Modal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        title="Export price list"
        subtitle={
          search.trim()
            ? `Products matching "${search.trim()}"${includeDiscontinued ? ", discontinued included" : ""}.`
            : `All products${includeDiscontinued ? ", discontinued included" : ", not the discontinued ones"}.`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Close
            </Button>
            {(["csv", "xlsx"] as const).map((format) => (
              <Button
                key={format}
                disabled={exp.isPending}
                onClick={() =>
                  exp.mutate(
                    { search, includeDiscontinued, format },
                    {
                      onSuccess: (r) => {
                        if (r.xlsxBase64) downloadBase64(r.filename, r.xlsxBase64, XLSX_MIME);
                        else if (r.csv) downloadText(r.filename, r.csv);
                        setExportOpen(false);
                        setNotice(`Exported ${r.count} products.`);
                      },
                    },
                  )
                }
              >
                {exp.isPending ? <Spinner /> : <Download className="size-4" />}
                {format === "csv" ? "CSV" : "Excel"}
              </Button>
            ))}
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Edit it in Excel and import it back. Keep the terra_id column: it is how each row finds its product. Leave a cell
          blank to keep what is there now.
        </p>
        {exp.isError ? <p className="mt-2 text-sm text-destructive">{errText(exp.error)}</p> : null}
      </Modal>

      {file && preview.data ? (
        <PreviewModal
          file={file}
          data={preview.data}
          onClose={() => {
            setFile(null);
            preview.reset();
          }}
          onDone={(msg) => {
            setFile(null);
            preview.reset();
            setNotice(msg);
          }}
        />
      ) : null}

      <UndoModal open={undoOpen} onClose={() => setUndoOpen(false)} onDone={(msg) => setNotice(msg)} />
      <LogModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

/* -------------------------------- preview ------------------------------- */

type Tab = "updates" | "creates" | "discontinued" | "errors" | "warnings";

function PreviewModal({
  file,
  data,
  onClose,
  onDone,
}: {
  file: SheetFile;
  data: Preview;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const confirm = usePriceImportConfirm();
  const c = data.counts;
  const first: Tab = c.updated ? "updates" : c.created ? "creates" : c.discontinued ? "discontinued" : c.errors ? "errors" : "warnings";
  const [tab, setTab] = React.useState<Tab>(first);
  const nothing = c.updated + c.created + c.discontinued === 0;
  const tiles: [Tab | null, string, number, string][] = [
    ["updates", "Updates", c.updated, ""],
    ["creates", "New", c.created, ""],
    ["discontinued", "Discontinued", c.discontinued, ""],
    [null, "Same as now", c.unchanged, ""],
    ["errors", "Errors (skipped)", c.errors, "text-destructive"],
    ["warnings", "Warnings", c.warnings, "text-amber-700"],
  ];

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-4xl"
      title={`Import preview: ${data.fileName}`}
      subtitle={`${c.rows} rows read. Nothing is saved until you press Confirm import.`}
      footer={
        <>
          {confirm.isError ? <span className="mr-auto self-center text-sm text-destructive">{errText(confirm.error)}</span> : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={nothing || data.fileErrors.length > 0 || confirm.isPending}
            onClick={() =>
              confirm.mutate(
                { file, hash: data.hash },
                {
                  onSuccess: (r) =>
                    onDone(
                      `Imported: ${r.counts.updated} updated, ${r.counts.created} new, ${r.counts.discontinued} discontinued${r.counts.errors ? `, ${r.counts.errors} rows skipped` : ""}.`,
                    ),
                },
              )
            }
          >
            {confirm.isPending ? <Spinner /> : null}
            Confirm import
          </Button>
        </>
      }
    >
      {data.fileErrors.length ? (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {data.fileErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      ) : null}
      {data.ignoredColumns.length ? (
        <p className="mb-3 text-xs text-muted-foreground">Columns not used: {data.ignoredColumns.join(", ")}.</p>
      ) : null}

      <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {tiles.map(([key, label, n, tint]) => (
          <button
            key={label}
            type="button"
            disabled={!key}
            onClick={() => key && setTab(key)}
            className={`rounded-lg border px-3 py-2 text-left transition-colors ${key && tab === key ? "border-primary bg-primary/5" : "border-border"} ${key ? "hover:bg-secondary" : "cursor-default"}`}
          >
            <div className={`text-lg font-semibold tabular-nums ${n ? tint : ""}`}>{n}</div>
            <div className="text-[11px] text-muted-foreground">{label}</div>
          </button>
        ))}
      </div>

      <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-border" data-testid={`preview-${tab}`}>
        {tab === "updates" || tab === "discontinued" ? (
          <ChangeList items={tab === "updates" ? data.updates : data.discontinued} />
        ) : tab === "creates" ? (
          <NewList items={data.creates} />
        ) : (
          <ProblemList items={tab === "errors" ? data.errors : data.warnings} tone={tab === "errors" ? "error" : "warn"} />
        )}
      </div>
    </Modal>
  );
}

function More({ total }: { total: number }) {
  return total > SHOW ? <p className="px-3 py-2 text-xs text-muted-foreground">And {total - SHOW} more.</p> : null;
}

function ChangeList({ items }: { items: Preview["updates"] }) {
  if (!items.length) return <p className="p-4 text-sm text-muted-foreground">None.</p>;
  return (
    <div className="divide-y divide-border">
      {items.slice(0, SHOW).map((u) => (
        <div key={u.row} className="px-3 py-2 text-sm">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{u.name}</span>
            <span className="text-[11px] text-muted-foreground">
              row {u.row} · id {u.productId}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {u.changes.map((ch) => (
              <span
                key={ch.field}
                className={`rounded px-1.5 py-0.5 text-xs ${ch.price ? "bg-amber-100 font-medium text-amber-900" : "bg-secondary text-muted-foreground"}`}
              >
                {ch.label}: {ch.from} → {ch.to}
              </span>
            ))}
          </div>
          {u.warnings.map((w) => (
            <p key={w} className="mt-1 text-xs text-amber-700">
              {w}
            </p>
          ))}
        </div>
      ))}
      <More total={items.length} />
    </div>
  );
}

function NewList({ items }: { items: Preview["creates"] }) {
  if (!items.length) return <p className="p-4 text-sm text-muted-foreground">None.</p>;
  const m = (n: number | null) => (n == null ? "none" : `$${n.toFixed(2)}`);
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-left">
          <th className="th px-3">Row</th>
          <th className="th px-3">Product</th>
          <th className="th px-3">Supplier</th>
          <th className="th px-3">Category</th>
          <th className="th px-3 text-right">Cost</th>
          <th className="th px-3 text-right">Sell</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {items.slice(0, SHOW).map((n) => (
          <tr key={n.row}>
            <td className="px-3 py-1.5 text-xs text-muted-foreground">{n.row}</td>
            <td className="px-3 py-1.5">
              {n.name}
              {n.sizes ? <p className="text-xs text-muted-foreground">{n.sizes}</p> : null}
              {n.warnings.map((w) => (
                <p key={w} className="text-xs text-amber-700">
                  {w}
                </p>
              ))}
            </td>
            <td className="px-3 py-1.5">{n.supplier}</td>
            <td className="px-3 py-1.5">{n.category.replace(/_/g, " ")}</td>
            <td className="px-3 py-1.5 text-right tabular-nums">
              {m(n.cost)}/{n.unit}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums">{m(n.sell)}</td>
          </tr>
        ))}
      </tbody>
      {items.length > SHOW ? (
        <tfoot>
          <tr>
            <td colSpan={6}>
              <More total={items.length} />
            </td>
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

/**
 * Import fixes 26 Oct, item 6. Every skipped row is listed, never cut off, with
 * each reason on its own line so the full reason can be read.
 */
function ProblemList({ items, tone }: { items: Preview["errors"]; tone: "error" | "warn" }) {
  if (!items.length) return <p className="p-4 text-sm text-muted-foreground">None.</p>;
  const shown = tone === "error" ? items : items.slice(0, SHOW);
  const reasons = (m: string) =>
    m
      .replace(/\.$/, "")
      .split("; ")
      .map((x) => x.trim())
      .filter(Boolean);
  return (
    <div className="divide-y divide-border">
      {tone === "error" ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {items.length} row{items.length === 1 ? "" : "s"} will be skipped. Nothing on these rows is imported. Fix the reasons below and import again.
        </p>
      ) : null}
      {shown.map((p, i) => {
        const list = tone === "error" ? reasons(p.message) : [p.message];
        return (
          <div key={`${p.row}-${i}`} className="px-3 py-2 text-sm" data-testid={tone === "error" ? "import-error-row" : undefined}>
            <span className="text-[11px] text-muted-foreground">row {p.row} · </span>
            <span className="font-medium">{p.name}</span>
            {list.length > 1 ? (
              <ul className={`mt-0.5 list-disc pl-4 text-xs ${tone === "error" ? "text-destructive" : "text-amber-700"}`}>
                {list.map((x) => (
                  <li key={x} className="whitespace-pre-wrap break-words">
                    {x}.
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`whitespace-pre-wrap break-words text-xs ${tone === "error" ? "text-destructive" : "text-amber-700"}`}>
                {tone === "error" ? `${list[0] ?? p.message}.` : p.message}
              </p>
            )}
          </div>
        );
      })}
      {tone === "error" ? null : <More total={items.length} />}
    </div>
  );
}

/* --------------------------------- undo --------------------------------- */

function UndoModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const log = usePriceImportLog(open);
  const undo = usePriceImportUndo();
  const last = log.data?.find((r) => r.canUndo) ?? log.data?.[0];
  const can = !!last?.canUndo;
  return (
    <Modal
      open={open}
      onClose={() => {
        undo.reset();
        onClose();
      }}
      title="Undo last import"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            disabled={!can || undo.isPending}
            onClick={() =>
              undo.mutate(undefined, {
                onSuccess: (r) => {
                  onDone(`Import undone. ${r.note}`);
                  onClose();
                },
              })
            }
          >
            {undo.isPending ? <Spinner /> : <RotateCcw className="size-4" />}
            Undo import
          </Button>
        </>
      }
    >
      {log.isLoading ? (
        <Spinner />
      ) : !last ? (
        <p className="text-sm text-muted-foreground">No imports yet.</p>
      ) : !can ? (
        <p className="text-sm text-muted-foreground">
          Every import is already undone. The last one was {last.fileName}, {when(last.createdAt)}.
        </p>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            <span className="font-medium">{last.fileName}</span>, imported by {last.actorName} on {when(last.createdAt)}.
          </p>
          <p className="text-muted-foreground">
            {last.counts.updated ?? 0} updated, {last.counts.created ?? 0} new, {last.counts.discontinued ?? 0} discontinued.
          </p>
          <p>
            Undo puts every changed product back the way it was and removes the new ones. A new product a quote or order
            already uses is kept as discontinued instead. Anything changed by hand since the import is left as it is.
          </p>
        </div>
      )}
      {undo.isError ? <p className="mt-2 text-sm text-destructive">{errText(undo.error)}</p> : null}
    </Modal>
  );
}

/* ---------------------------------- log --------------------------------- */

function LogModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const log = usePriceImportLog(open);
  const [openId, setOpenId] = React.useState<number | null>(null);
  return (
    <Modal open={open} onClose={onClose} width="max-w-3xl" title="Import log" subtitle="The last 20 price list imports.">
      {log.isLoading ? (
        <Spinner />
      ) : !log.data?.length ? (
        <p className="text-sm text-muted-foreground">No imports yet.</p>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {log.data.map((r) => (
            <div key={r.id} className="px-3 py-2 text-sm">
              <button
                type="button"
                className="flex w-full flex-wrap items-baseline gap-x-3 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}
              >
                <span className="font-medium">{r.fileName}</span>
                <span className="text-xs text-muted-foreground">
                  {when(r.createdAt)} · {r.actorName}
                </span>
                <span className="text-xs">
                  {r.counts.updated ?? 0} updated, {r.counts.created ?? 0} new, {r.counts.discontinued ?? 0} discontinued,{" "}
                  {r.counts.errors ?? 0} skipped
                </span>
                {r.status === "undone" ? (
                  <span className="text-xs text-destructive">
                    Undone {when(r.undoneAt)} by {r.undoneBy}
                  </span>
                ) : null}
              </button>
              {r.status === "undone" && r.undoNote ? <p className="mt-1 text-xs text-muted-foreground">{r.undoNote}</p> : null}
              {openId === r.id ? <LogRows importId={r.id} /> : null}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const PRICE_KEYS: [string, string][] = [
  ["costPrice", "Cost"],
  ["sellPrice", "Sell"],
  ["cutCostPrice", "Cut price"],
  ["rollPrice", "Roll price"],
];

function LogRows({ importId }: { importId: number }) {
  const rows = usePriceImportRows(importId);
  if (rows.isLoading) return <Spinner />;
  const list = rows.data ?? [];
  const m = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(2)}` : "none");
  return (
    <div className="mt-2 max-h-72 overflow-y-auto rounded border border-border bg-secondary/30">
      {list.slice(0, 300).map((r) => {
        const prices = PRICE_KEYS.filter(([k]) => k in r.after);
        const others = Object.keys(r.after).filter((k) => !PRICE_KEYS.some(([p]) => p === k));
        return (
          <div key={`${r.action}-${r.productId}`} className="border-b border-border px-2 py-1 text-xs last:border-0">
            <span className="font-medium">{r.name}</span>{" "}
            {r.action === "create" ? (
              <span className="text-muted-foreground">new, cost {m(r.after.costPrice)}, sell {m(r.after.sellPrice)}</span>
            ) : (
              <span className="text-muted-foreground">
                {prices.map(([k, label]) => `${label} ${m(r.before?.[k])} → ${m(r.after[k])}`).join(", ")}
                {prices.length && others.length ? ", " : ""}
                {others.length ? `${others.length} other field${others.length > 1 ? "s" : ""}` : ""}
              </span>
            )}
          </div>
        );
      })}
      {list.length > 300 ? <p className="px-2 py-1 text-xs text-muted-foreground">And {list.length - 300} more.</p> : null}
    </div>
  );
}
