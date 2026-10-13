import * as React from "react";
import { Check, ChevronDown, ChevronUp, History, Search, SlidersHorizontal, X } from "lucide-react";
import { Input, Select } from "./ui/field";
import { Spinner } from "./ui/card";
import { GroupToggles, PRODUCT_CATEGORIES, unitLabel, useDebounced } from "./quote-pickers";
import { moneyExact } from "../lib/money";
import { useBootstrap } from "../queries/settings";
import { useLastQuoted, useProductFind, type FindSort, type FoundProduct, type LastQuoted } from "../queries/productFind";

/**
 * Fix list items 3, 4 and 18 (188001 list). One search box with the matches
 * listed under it as you type, tap one to pick it. A Filter button for type,
 * thickness, a sell price range and cheapest or dearest first. Cost viewers
 * also see what the range was last quoted at.
 */

export type LastQuotedContext = {
  companyId?: number | null;
  contactId?: number | null;
  excludeQuoteNumber?: number | null;
};

// Built on first use, not at load: quote-pickers imports this file back.
let categoryLabels: Record<string, string> | null = null;
const CATEGORY = () => (categoryLabels ??= Object.fromEntries(PRODUCT_CATEGORIES.map((c) => [c.name, c.label])));
const PAGE = 40;

const numOrNull = (s: string) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

const mm = (n: number) => `${Number(n.toFixed(2))} mm`;

export function productName(p: { brand: string; range: string; colour: string; supplier: string }) {
  return [p.brand, p.range, p.colour].filter(Boolean).join(" · ") || p.supplier;
}

function productDetail(p: FoundProduct) {
  return [
    p.supplier,
    p.thicknessMm != null ? mm(p.thicknessMm) : "",
    p.wearLayerMm != null ? `${mm(p.wearLayerMm)} wear` : "",
    p.size,
    p.sku ? `SKU ${p.sku}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "12 Oct", or "12 Oct 2025" when it is not this year. */
function quotedDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-AU", thisYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export function lastQuotedText(r: LastQuoted["last"]) {
  return `Last quoted ${moneyExact(r.unitPrice)}/${unitLabel(r.unit)}, ${r.customer}, ${quotedDate(r.quotedAt)}`;
}

/** Cost viewers only. The server sends nothing to anyone else either. */
export function useCanSeeCosts() {
  return Boolean(useBootstrap().data?.actor?.canSeeCosts);
}

/** The note, and a tap to see the last five. Never on anything the client sees. */
export function LastQuotedNote({ entry, className = "" }: { entry: LastQuoted | undefined; className?: string }) {
  const [open, setOpen] = React.useState(false);
  if (!entry) return null;
  return (
    <div className={`text-[11px] ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[var(--gold-deep)] underline-offset-2 hover:underline"
        title="Same range, any colour. This client first, then anyone. Tap for the last 5."
      >
        <History className="size-3" />
        {lastQuotedText(entry.last)}
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-0.5 rounded-md border border-border bg-card px-2 py-1.5">
          {entry.recent.map((r, i) => (
            <li key={`${r.quotedAt}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>
                {quotedDate(r.quotedAt)} · {r.customer}
                {r.sameClient ? " (this client)" : ""}
                {r.colour ? ` · ${r.colour}` : ""}
                {r.quoteRef ? ` · ${r.quoteRef}` : ""}
              </span>
              <span className="tabular font-medium">
                {moneyExact(r.unitPrice)}/{unitLabel(r.unit)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ProductFinder({
  picked,
  onPick,
  context,
}: {
  picked: FoundProduct | null;
  onPick: (p: FoundProduct | null) => void;
  /** Whose quote this is, for "last quoted". */
  context?: LastQuotedContext;
}) {
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [thickness, setThickness] = React.useState("");
  const [minSell, setMinSell] = React.useState("");
  const [maxSell, setMaxSell] = React.useState("");
  const [sort, setSort] = React.useState<FindSort>("name");
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [limit, setLimit] = React.useState(PAGE);
  const [hi, setHi] = React.useState(0);
  const uid = React.useId();

  const q = useDebounced(search);
  const min = useDebounced(minSell);
  const max = useDebounced(maxSell);
  const found = useProductFind({
    search: q,
    category,
    thicknessMm: thickness ? Number(thickness) : null,
    minSell: numOrNull(min),
    maxSell: numOrNull(max),
    sort,
    limit,
  });
  const rows = React.useMemo(() => found.data?.rows ?? [], [found.data]);
  const total = found.data?.total ?? 0;
  const thicknesses = found.data?.thicknesses ?? [];

  // A new search starts at the top of a fresh first page.
  React.useEffect(() => {
    setLimit(PAGE);
    setHi(0);
  }, [q, category, thickness, min, max, sort]);

  const canSeeCosts = useCanSeeCosts();
  const last = useLastQuoted(
    {
      productIds: [...rows.map((r) => r.id), ...(picked ? [picked.id] : [])],
      companyId: context?.companyId,
      contactId: context?.contactId,
      excludeQuoteNumber: context?.excludeQuoteNumber,
    },
    canSeeCosts,
  );

  const activeFilters = [category, thickness, numOrNull(minSell) != null ? "a" : "", numOrNull(maxSell) != null ? "b" : "", sort !== "name" ? "s" : ""].filter(Boolean).length;

  function clearFilters() {
    setCategory("");
    setThickness("");
    setMinSell("");
    setMaxSell("");
    setSort("name");
  }

  function pick(p: FoundProduct) {
    onPick(p);
  }

  if (picked) {
    return (
      <div className="flex flex-col gap-1 rounded-md border border-primary/40 bg-card px-3 py-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Check className="size-3.5 text-primary" />
              {productName(picked)}
            </div>
            <div className="text-xs text-muted-foreground">{productDetail(picked)}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="tabular text-sm">
              {picked.sellExGst != null ? `${moneyExact(picked.sellExGst)}/${unitLabel(picked.unit)}` : "no sell price"}
            </span>
            <button
              type="button"
              onClick={() => onPick(null)}
              className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Change
            </button>
          </div>
        </div>
        {canSeeCosts ? <LastQuotedNote entry={last.data?.[picked.id]} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9 pr-8"
            placeholder="Search range, colour, supplier, SKU or brand"
            aria-label="Search the price list"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(h + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(h - 1, 0));
              } else if (e.key === "Enter" && rows[hi]) {
                e.preventDefault();
                pick(rows[hi]!);
              }
            }}
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen((o) => !o)}
          className={
            activeFilters
              ? "inline-flex h-9 items-center gap-1.5 rounded-md border border-primary bg-primary/10 px-3 text-sm font-medium text-primary"
              : "inline-flex h-9 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          <SlidersHorizontal className="size-3.5" />
          Filter{activeFilters ? ` (${activeFilters})` : ""}
        </button>
      </div>

      {filtersOpen ? (
        <div className="flex flex-col gap-2.5 rounded-md border border-border bg-card px-3 py-2.5">
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">Type</span>
            <GroupToggles
              groups={PRODUCT_CATEGORIES}
              labels={CATEGORY()}
              value={category}
              onChange={(v) => {
                setCategory(v);
                setThickness("");
              }}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label htmlFor={`${uid}-th`} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Thickness</span>
              <Select id={`${uid}-th`} className="h-9 w-[150px]" value={thickness} onChange={(e) => setThickness(e.target.value)}>
                <option value="">Any</option>
                {thicknesses.map((t) => (
                  <option key={t.mm} value={String(t.mm)}>
                    {mm(t.mm)} ({t.n})
                  </option>
                ))}
              </Select>
            </label>
            <label htmlFor={`${uid}-min`} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Sell from $</span>
              <Input id={`${uid}-min`} className="tabular h-9 w-[90px] text-right" inputMode="decimal" value={minSell} onChange={(e) => setMinSell(e.target.value)} />
            </label>
            <label htmlFor={`${uid}-max`} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">to $</span>
              <Input id={`${uid}-max`} className="tabular h-9 w-[90px] text-right" inputMode="decimal" value={maxSell} onChange={(e) => setMaxSell(e.target.value)} />
            </label>
            <label htmlFor={`${uid}-sort`} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Sort</span>
              <Select id={`${uid}-sort`} className="h-9 w-[150px]" value={sort} onChange={(e) => setSort(e.target.value as FindSort)}>
                <option value="name">By name</option>
                <option value="cheapest">Cheapest first</option>
                <option value="dearest">Dearest first</option>
              </Select>
            </label>
            {activeFilters ? (
              <button type="button" onClick={clearFilters} className="pb-2 text-xs text-muted-foreground underline hover:text-foreground">
                Clear filters
              </button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">Sell is ex GST, per unit the product is sold in.</p>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            {found.isLoading
              ? "Loading the price list"
              : total === 0
                ? "Nothing matches that"
                : `Showing ${rows.length} of ${total}`}
          </span>
          {found.isFetching && !found.isLoading ? <Spinner /> : null}
        </div>
        <ul className="max-h-[320px] overflow-y-auto" aria-label="Price list matches">
          {rows.map((p, i) => {
            const lq = canSeeCosts ? last.data?.[p.id] : undefined;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  aria-current={i === hi ? "true" : undefined}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(p)}
                  className={`flex w-full items-start justify-between gap-3 border-b border-border px-3 py-2 text-left last:border-0 ${
                    i === hi ? "bg-[var(--gold-wash)]" : "hover:bg-secondary/50"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{productName(p)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {CATEGORY()[p.category] ?? p.category} · {productDetail(p)}
                    </span>
                    {lq ? <span className="block text-[11px] text-[var(--gold-deep)]">{lastQuotedText(lq.last)}</span> : null}
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular block text-sm">
                      {p.sellExGst != null ? `${moneyExact(p.sellExGst)}/${unitLabel(p.unit)}` : "no sell price"}
                    </span>
                    {p.onSpecial ? <span className="block text-[11px] text-primary">on special</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {rows.length < total ? (
          <button
            type="button"
            disabled={limit >= 200}
            onClick={() => setLimit((l) => Math.min(l + PAGE, 200))}
            className="w-full border-t border-border px-3 py-1.5 text-xs text-primary hover:bg-secondary/50 disabled:text-muted-foreground"
          >
            {limit >= 200 ? "Type more or filter to see the rest" : "Show more"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
