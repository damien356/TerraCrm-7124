import * as React from "react";
import { AlertTriangle, Eye, FileDown, PencilLine, Sparkles } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input, Select, Textarea } from "./ui/field";
import { openPdf } from "./purchase-orders";
import { CATEGORY_LABELS, LINE_CATEGORIES } from "../../api/lib/bundleCatalog";
import { isSupplyOnly, LAYOUT_LABELS, QUOTE_LAYOUTS, type QuoteLayout } from "../../api/lib/quote-layout";
import { QuoteItemRows, type QuoteItemRow } from "./quote-item-rows";
import {
  useQuotePdf,
  useRegenerateBundle,
  useSetBundleMode,
  useSetLineCategory,
  useSetQuoteLayout,
  useUpdateBundle,
} from "../queries/quoteBundles";

/**
 * What the client reads on the quote, the PDF and the online quote.
 * Sections: titles, wording and totals, never qty, m2, rates or line prices.
 * Itemised (item 1, supply only): one row per line with qty, rate and total.
 */

type Bundle = {
  key: string;
  title: string;
  /** "X supply" when the section has no install line (item 2). */
  defaultTitle: string;
  wording: string;
  wordingSource: string;
  total: number;
  lineIds: number[];
  stale: boolean;
};

type Line = { id: number; kind: string; description: string; floorCategory?: string | null; total: number };

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

function ModeToggle({ mode, disabled, onChange }: { mode: string; disabled: boolean; onChange: (m: "combined" | "split") => void }) {
  const opts = [
    { value: "combined" as const, label: "Combined", title: "One section for the whole job" },
    { value: "split" as const, label: "Split by floor", title: "One section per floor type, plus prep and removal" },
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-secondary/40 p-0.5" aria-label="Client view">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={mode === o.value}
          title={o.title}
          disabled={disabled}
          onClick={() => mode !== o.value && onChange(o.value)}
          className={
            mode === o.value
              ? "rounded px-2.5 py-1 text-xs font-semibold text-[var(--sidebar)] shadow-xs bg-[var(--gold)]"
              : "rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BundleEditor({
  quoteId,
  bundle,
  lines,
  split,
  locked,
  wordingOpen,
  onError,
}: {
  quoteId: number;
  bundle: Bundle;
  lines: Line[];
  split: boolean;
  locked: boolean;
  /** Accepted quote: the title and wording can still be fixed (188001 list item 7). */
  wordingOpen: boolean;
  onError: (msg: string | null) => void;
}) {
  const textLocked = locked && !wordingOpen;
  const update = useUpdateBundle();
  const regenerate = useRegenerateBundle();
  const setCategory = useSetLineCategory();
  const [title, setTitle] = React.useState(bundle.title);
  const [wording, setWording] = React.useState(bundle.wording);
  const [askHint, setAskHint] = React.useState(false);
  const [hint, setHint] = React.useState("");

  React.useEffect(() => setTitle(bundle.title), [bundle.title]);
  React.useEffect(() => setWording(bundle.wording), [bundle.wording]);

  const inBundle = lines.filter((l) => bundle.lineIds.includes(l.id));
  const busy = update.isPending || regenerate.isPending;

  async function save(patch: { title?: string; wording?: string }) {
    onError(null);
    try {
      await update.mutateAsync({ quoteId, key: bundle.key, ...patch });
    } catch (e) {
      onError(errText(e));
    }
  }

  async function write(withHint: boolean) {
    if (!withHint && bundle.wording.trim() && bundle.wordingSource === "manual") {
      if (!window.confirm("This replaces the wording you typed. Go ahead?")) return;
    }
    onError(null);
    try {
      await regenerate.mutateAsync({ quoteId, key: bundle.key, hint: withHint && hint.trim() ? hint.trim() : undefined });
      setAskHint(false);
      setHint("");
    } catch (e) {
      onError(errText(e));
    }
  }

  return (
    <div className="border-b border-border px-4 py-3 last:border-0">
      <div className="flex items-center gap-3">
        <Input
          className="h-8 flex-1 font-semibold"
          value={title}
          disabled={textLocked || busy}
          aria-label="Section title"
          placeholder={bundle.defaultTitle || "Section title"}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() !== bundle.title && save({ title })}
        />
        <span className="tabular shrink-0 text-sm font-semibold" title="Ex GST">
          {money(bundle.total)}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        {bundle.wordingSource === "ai" ? <Badge colour="#8A6D1E">AI draft</Badge> : null}
        {bundle.wordingSource === "manual" ? <Badge colour="#3F6F8F">Typed</Badge> : null}
        {!bundle.wording.trim() ? (
          <span className="inline-flex items-center gap-1 text-[#B4342A]">
            <AlertTriangle className="size-3.5" /> No wording yet. The client would see the title only.
          </span>
        ) : bundle.stale ? (
          <span className="inline-flex items-center gap-1 text-[#D08A1E]">
            <AlertTriangle className="size-3.5" /> Lines changed since this was written. Check it or write it again.
          </span>
        ) : null}
      </div>

      <Textarea
        className="mt-2 text-sm"
        rows={Math.min(8, Math.max(3, Math.ceil(wording.length / 90)))}
        value={wording}
        disabled={textLocked || busy}
        aria-label={`Wording for ${bundle.title}`}
        placeholder="What the client reads for this section. No qty or prices. You can type the meterage in if you want it shown."
        onChange={(e) => setWording(e.target.value)}
        onBlur={() => wording.trim() !== bundle.wording.trim() && save({ wording })}
      />

      {textLocked ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy || inBundle.length === 0} onClick={() => write(false)}>
            {regenerate.isPending ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
            {bundle.wording.trim() ? "Write again" : "Write it for me"}
          </Button>
          {bundle.wording.trim() ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAskHint((v) => !v)}>
              <PencilLine className="size-3.5" />
              Change it with a note
            </Button>
          ) : null}
          {update.isPending ? <span className="text-xs text-muted-foreground">Saving…</span> : null}
        </div>
      )}

      {askHint && !textLocked ? (
        <div className="mt-2 flex items-center gap-2">
          <Input
            className="h-8 flex-1"
            value={hint}
            placeholder="For example: mention the stairs, make it shorter"
            onChange={(e) => setHint(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && hint.trim() && write(true)}
          />
          <Button size="sm" disabled={busy || !hint.trim()} onClick={() => write(true)}>
            Rewrite
          </Button>
        </div>
      ) : null}

      {split && inBundle.length ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            {inBundle.length} line{inBundle.length === 1 ? "" : "s"} in this section
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {inBundle.map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-muted-foreground">{l.kind}</span>
                <span className="min-w-0 flex-1 truncate" title={l.description}>
                  {l.description}
                </span>
                <Select
                  className="h-7 w-[170px] text-xs"
                  value={l.floorCategory ?? ""}
                  disabled={locked || setCategory.isPending}
                  aria-label={`Section for ${l.description}`}
                  onChange={(e) =>
                    setCategory
                      .mutateAsync({
                        itemId: l.id,
                        floorCategory: (e.target.value || null) as (typeof LINE_CATEGORIES)[number] | null,
                      })
                      .then(() => onError(null))
                      .catch((err) => onError(errText(err)))
                  }
                >
                  <option value="">Auto</option>
                  {LINE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c] ?? c}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const LAYOUT_HINTS: Record<QuoteLayout, string> = {
  auto: "Itemised when the quote is supply only, else sections",
  itemised: "One row per line: qty, unit, rate and total",
  sections: "Section titles, wording and totals",
};

/** used: what Auto would give for these lines, so the label stays right when Itemised or Sections is picked by hand. */
function LayoutSelect({ value, used, disabled, onChange }: { value: string; used: string; disabled: boolean; onChange: (l: QuoteLayout) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={LAYOUT_HINTS[value as QuoteLayout] ?? LAYOUT_HINTS.auto}>
      Layout
      <Select
        aria-label="Client layout"
        className="h-7 w-auto py-0 text-xs"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as QuoteLayout)}
      >
        {QUOTE_LAYOUTS.map((l) => (
          <option key={l} value={l}>
            {l === "auto" ? `Auto (${used === "itemised" ? "itemised" : "sections"})` : LAYOUT_LABELS[l]}
          </option>
        ))}
      </Select>
    </label>
  );
}

function PreviewTotals({ subtotal, gst, total }: { subtotal: number; gst: number; total: number }) {
  return (
    <div className="ml-auto mt-2 flex w-56 flex-col gap-1 text-[13px]">
      <div className="flex justify-between">
        <span className="text-[#6A6A6A]">Sub Total (ex GST)</span>
        <span className="tabular">{money(subtotal)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-[#6A6A6A]">GST</span>
        <span className="tabular">{money(gst)}</span>
      </div>
      <div className="flex justify-between font-semibold">
        <span>Grand Total</span>
        <span className="tabular">{money(total)}</span>
      </div>
    </div>
  );
}

/** Itemised: the rows the client gets, with the totals. */
function ItemisedPreview({ rows, subtotal, gst, total }: { rows: QuoteItemRow[]; subtotal: number; gst: number; total: number }) {
  return (
    <div className="mx-4 my-3 rounded-md border border-border bg-white px-4 py-3 text-[#1F1F1F]">
      <QuoteItemRows rows={rows} />
      <PreviewTotals subtotal={subtotal} gst={gst} total={total} />
    </div>
  );
}

/** How it reads to the client. Same content as the PDF page, no line detail. */
function ClientPreview({ bundles, subtotal, gst, total }: { bundles: Bundle[]; subtotal: number; gst: number; total: number }) {
  return (
    <div className="mx-4 my-3 rounded-md border border-border bg-white px-4 py-3 text-[#1F1F1F]">
      <div className="flex justify-between border-b border-[#E7E2D6] pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8A8A8A]">
        <span>Item description</span>
        <span>Total</span>
      </div>
      {bundles.map((b) => (
        <div key={b.key} className="border-b border-[#E7E2D6] py-2.5 last:border-0">
          <div className="flex justify-between gap-4 text-sm font-semibold">
            <span>{b.title}</span>
            <span className="tabular">{money(b.total)}</span>
          </div>
          {b.wording.trim() ? <p className="mt-1 whitespace-pre-line text-[13px] text-[#4A4A4A]">{b.wording}</p> : null}
        </div>
      ))}
      <PreviewTotals subtotal={subtotal} gst={gst} total={total} />
    </div>
  );
}

export function QuoteBundlesCard({
  quote,
  locked,
  wordingOpen = false,
}: {
  quote: {
    id: number;
    bundleMode: string;
    layout: string;
    layoutUsed: string;
    itemRows: QuoteItemRow[];
    bundles: Bundle[];
    items: Line[];
    subtotal: number;
    gst: number;
    total: number;
  };
  locked: boolean;
  wordingOpen?: boolean;
}) {
  const setMode = useSetBundleMode();
  const setLayout = useSetQuoteLayout();
  const itemised = quote.layoutUsed === "itemised";
  const pdf = useQuotePdf();
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState(false);
  const split = quote.bundleMode === "split";
  const missing = quote.bundles.filter((b) => !b.wording.trim()).length;
  const stale = quote.bundles.filter((b) => b.stale && b.wording.trim()).length;

  async function download() {
    setError(null);
    setNotice(null);
    try {
      await openPdf(async () => {
        const r = await pdf.mutateAsync({ quoteId: quote.id });
        const warn = [
          r.missing.length ? `No wording on: ${r.missing.join(", ")}.` : "",
          r.stale.length ? `Out of date wording on: ${r.stale.join(", ")}.` : "",
        ]
          .filter(Boolean)
          .join(" ");
        if (warn) setNotice(`PDF made. ${warn}`);
        return r;
      });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title="What the client sees"
        subtitle={
          itemised
            ? "Itemised: one row per line with qty, unit, rate and total, ex GST. Delivery prints last."
            : "Section titles, wording and totals only. Never qty, m², rates or line prices."
        }
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <LayoutSelect
              value={quote.layout}
              used={isSupplyOnly(quote.items) ? "itemised" : "sections"}
              disabled={locked || setLayout.isPending}
              onChange={(layout) =>
                setLayout
                  .mutateAsync({ quoteId: quote.id, layout })
                  .then(() => setError(null))
                  .catch((e) => setError(errText(e)))
              }
            />
            {itemised ? null : (
            <ModeToggle
              mode={quote.bundleMode}
              disabled={locked || setMode.isPending}
              onChange={(mode) =>
                setMode
                  .mutateAsync({ quoteId: quote.id, mode })
                  .then(() => setError(null))
                  .catch((e) => setError(errText(e)))
              }
            />
            )}
            {itemised ? null : (
            <Button size="sm" variant="outline" onClick={() => setPreview((v) => !v)}>
              <Eye className="size-3.5" />
              {preview ? "Edit" : "Preview"}
            </Button>
            )}
            <Button size="sm" variant="outline" disabled={pdf.isPending || quote.items.length === 0} onClick={download}>
              {pdf.isPending ? <Spinner className="size-3.5" /> : <FileDown className="size-3.5" />}
              PDF
            </Button>
          </div>
        }
      />
      {error ? (
        <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      {notice ? (
        <div className="mx-4 mt-3 rounded-md border border-[#D08A1E]/40 bg-[#D08A1E]/10 px-3 py-2 text-sm">{notice}</div>
      ) : null}
      {quote.items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Add lines first. The sections build from them.</p>
      ) : itemised ? (
        <ItemisedPreview rows={quote.itemRows} subtotal={quote.subtotal} gst={quote.gst} total={quote.total} />
      ) : preview ? (
        <ClientPreview bundles={quote.bundles} subtotal={quote.subtotal} gst={quote.gst} total={quote.total} />
      ) : (
        <>
          {missing || stale ? (
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              {[missing ? `${missing} section${missing === 1 ? "" : "s"} with no wording` : "", stale ? `${stale} out of date` : ""]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          ) : null}
          {quote.bundles.map((b) => (
            <BundleEditor
              key={b.key}
              quoteId={quote.id}
              bundle={b}
              lines={quote.items}
              split={split}
              locked={locked}
              wordingOpen={wordingOpen}
              onError={setError}
            />
          ))}
        </>
      )}
    </Card>
  );
}
