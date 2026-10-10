import * as React from "react";
import { Plus, Search } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { Spinner } from "./ui/card";
import { Combobox } from "./ui/combobox";
import { useProducts } from "../queries/products";
import { useRatePicker } from "../queries/labour";
import { useAddQuoteLabour, useAddQuoteProduct } from "../queries/quotes";
import { ProductAreaFields, useAreaDraft } from "./floor-area";

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

/** How a unit reads on the end of a price. */
const UNIT_LABEL: Record<string, string> = {
  m2: "m²",
  lm: "lm",
  each: "each",
  step: "step",
  hour: "hr",
  day: "day",
  job: "job",
  percent: "%",
  km: "km",
  roll: "roll",
};
const unitLabel = (u: string) => UNIT_LABEL[u] ?? u;

/** Typing should not fire a query per keystroke. */
function useDebounced(value: string, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/* ------------------------------ the toggles ------------------------------ */

/**
 * The category row. These are the rate book's own groups, relabelled to what
 * the office calls them. "demolition" is the column name, nobody says it.
 */
const GROUP_LABEL: Record<string, string> = {
  carpet: "Carpet",
  resilient: "Vinyl / hybrid",
  timber: "Timber",
  prep: "Prep",
  demolition: "Removal",
  trades: "Trades",
  surcharge: "Loadings",
  other: "Other",
};

/**
 * The price book's own categories, fixed. They are NOT read off the rows on
 * screen: the list comes back capped, so whatever the cap cut off would
 * silently lose its own button.
 */
const PRODUCT_CATEGORIES = [
  { name: "carpet", label: "Carpet" },
  { name: "carpet_tile", label: "Carpet tile" },
  { name: "vinyl", label: "Vinyl" },
  { name: "hybrid", label: "Hybrid" },
  { name: "laminate", label: "Laminate" },
  { name: "timber", label: "Timber" },
  { name: "underlay", label: "Underlay" },
  { name: "accessory", label: "Accessories" },
];

function GroupToggles({
  groups,
  labels,
  value,
  onChange,
}: {
  groups: { name: string }[];
  labels: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {groups.map((g) => {
        const on = value === g.name;
        return (
          <button
            key={g.name}
            type="button"
            onClick={() => onChange(on ? "" : g.name)}
            className={
              on
                ? "rounded-full border border-primary bg-primary px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            }
          >
            {labels[g.name] ?? g.name}
          </button>
        );
      })}
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="px-2 py-1 text-xs text-muted-foreground underline hover:text-foreground"
        >
          Show everything
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------- product picker ---------------------------- */

/**
 * Supply, off the price list. A search box rather than a dropdown: a native
 * select only jumps to whatever starts with the last key pressed, which is no
 * use at all against a few thousand variants.
 */
export function ProductPicker({ quoteId }: { quoteId: number }) {
  const add = useAddQuoteProduct();
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search);
  const [category, setCategory] = React.useState("");
  const [picked, setPicked] = React.useState<number | null>(null);
  const [qty, setQty] = React.useState("1");
  const [error, setError] = React.useState<string | null>(null);

  const products = useProducts({ search: debounced, category });

  const rows = React.useMemo(() => products.data ?? [], [products.data]);
  const chosen = rows.find((r) => r.id === picked) ?? null;
  // Items 8 and 9: a Box or Broadloom product is measured, not counted.
  const area = useAreaDraft(chosen);
  const rates = useRatePicker({ includeUnpriced: true });
  const installNames = React.useMemo(
    () => new Map((rates.data?.rows ?? []).map((r) => [r.itemId, { id: r.itemId, name: r.name, unit: r.unit }])),
    [rates.data],
  );
  const [done, setDone] = React.useState<string | null>(null);
  const canAdd = picked != null && (!area.active || (area.measured != null && area.measured > 0));
  // Measuring: the line is what the area works out to, nothing until an area is in.
  const lineQty = area.active ? (area.result?.qty ?? 0) : Number(qty) || 0;

  async function submit() {
    if (picked == null || !canAdd) return;
    setError(null);
    setDone(null);
    try {
      const r = await add.mutateAsync({ quoteId, productId: picked, qty: Number(qty) || 1, ...area.submit() });
      const bits = [r.qtyNote, r.labour ? `${r.labour.description} added underneath.` : null, r.item?.flagged ? r.item.flagReason : null];
      setDone(bits.filter(Boolean).join(" ") || null);
      setPicked(null);
      setQty("1");
      area.reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Supply</span>
        <span className="text-xs text-muted-foreground">off the price list</span>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search the price list, a range, a colour, a supplier"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <GroupToggles
        groups={PRODUCT_CATEGORIES}
        labels={Object.fromEntries(PRODUCT_CATEGORIES.map((c) => [c.name, c.label]))}
        value={category}
        onChange={(v) => {
          setCategory(v);
          setPicked(null);
        }}
      />

      <div className="flex flex-wrap items-end gap-2">
        <Combobox
          className="min-w-[320px] flex-1"
          value={picked == null ? "" : String(picked)}
          onChange={(v) => setPicked(v ? Number(v) : null)}
          emptyLabel="Nothing picked"
          placeholder={
            products.isLoading
              ? "Loading the price list…"
              : rows.length === 0
                ? "Nothing matches that"
                : `Pick one of ${rows.length}`
          }
          options={rows.map((p) => ({
            value: String(p.id),
            label: [p.brand, p.range, p.colour].filter(Boolean).join(" · ") || p.supplier,
            sublabel: [
              p.supplier,
              p.sellExGst != null ? `${money(p.sellExGst)}/${unitLabel(p.unit)}` : "no sell price",
              p.onSpecial ? "on special" : "",
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
        />
        {area.active ? null : (
          <>
            <Input
              className="tabular w-[80px] text-right"
              aria-label="Quantity"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <span className="pb-2 text-xs text-muted-foreground">{chosen ? unitLabel(chosen.unit) : ""}</span>
          </>
        )}
        <Button variant="outline" disabled={!canAdd || add.isPending} onClick={submit}>
          {add.isPending ? <Spinner /> : <Plus className="size-4" />}
          Add supply
        </Button>
      </div>

      {rows.length >= 500 ? (
        <p className="text-xs text-muted-foreground">
          First 500 only. Type a range, a colour or a supplier, or tap a category, to get at the rest.
        </p>
      ) : null}

      {chosen ? <ProductAreaFields product={chosen} area={area} installNames={installNames} /> : null}

      {chosen ? (
        <p className="text-xs text-muted-foreground">
          {chosen.sellExGst != null
            ? `${money(chosen.sellExGst)} a ${unitLabel(chosen.unit)} sell. ${
                lineQty > 0 ? `${money(chosen.sellExGst * lineQty)} on the line.`
                  : ""
              }`
            : "That one has no sell price on it yet, so it would come in at zero."}
          {chosen.onSpecial ? " On special, which is yours to keep, not the customer's." : ""}
        </p>
      ) : null}

      {done && !chosen ? <p className="text-xs text-muted-foreground">{done}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/* ----------------------------- labour picker ---------------------------- */

/**
 * Labour, off the rate book. Two ways in and they narrow the same list: the
 * category toggle for when you know the trade, the search box for when you
 * only know the word. Pick the trade on the job and it opens on it.
 *
 * The rate quoted is always Terra's standard. Picking a layer is a note of
 * intent, it does not book him and it does not move the price.
 */
export function LabourPicker({ quoteId, category }: { quoteId: number; category?: string | null }) {
  const add = useAddQuoteLabour();
  const [group, setGroup] = React.useState(category ?? "");
  const [search, setSearch] = React.useState("");
  const debounced = useDebounced(search);
  const [itemId, setItemId] = React.useState<number | null>(null);
  const [qty, setQty] = React.useState("1");
  const [installerId, setInstallerId] = React.useState<string>("");
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const picker = useRatePicker({ groupName: group, search: debounced });
  const rows = React.useMemo(() => picker.data?.rows ?? [], [picker.data]);
  const groups = picker.data?.groups ?? [];
  const item = rows.find((r) => r.itemId === itemId) ?? null;

  // A trade change can drop the picked item out of the list.
  React.useEffect(() => {
    if (itemId != null && !picker.isLoading && !rows.some((r) => r.itemId === itemId)) {
      setItemId(null);
      setInstallerId("");
    }
  }, [itemId, rows, picker.isLoading]);

  const qtyNum = Number(qty) || 0;
  const lineSell = item?.sell != null ? item.sell * qtyNum : null;

  async function submit() {
    if (itemId == null) return;
    setError(null);
    setNote(null);
    try {
      const r = await add.mutateAsync({
        quoteId,
        itemId,
        qty: qtyNum,
        installerId: installerId ? Number(installerId) : null,
      });
      const bits = [`${r.rateItem.name} on at ${money(r.item?.total ?? 0)}.`];
      if (r.minApplied && r.minimumCharge != null) {
        bits.push(`That is the minimum charge, ${money(r.minimumCharge)} cost, not the metre rate.`);
      }
      if (r.installerName) bits.push(`${r.installerName} pencilled against it, not booked.`);
      setNote(bits.join(" "));
      setItemId(null);
      setQty("1");
      setInstallerId("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-2.5 border-t border-border bg-secondary/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Labour</span>
        <span className="text-xs text-muted-foreground">off the rate book, sells at the standard rate</span>
      </div>

      {groups.length > 0 ? (
        <GroupToggles
          groups={groups}
          labels={GROUP_LABEL}
          value={group}
          onChange={(v) => {
            setGroup(v);
            setItemId(null);
          }}
        />
      ) : null}

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Or search it, stairs, uplift, furniture, welding"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Combobox
          className="min-w-[300px] flex-1"
          value={itemId == null ? "" : String(itemId)}
          onChange={(v) => {
            setItemId(v ? Number(v) : null);
            setInstallerId("");
          }}
          emptyLabel="Nothing picked"
          placeholder={
            picker.isLoading
              ? "Loading the rate book…"
              : rows.length === 0
                ? "Nothing priced matches that"
                : `Pick one of ${rows.length}`
          }
          options={rows.map((r) => ({
            value: String(r.itemId),
            label: r.name,
            sublabel: [
              r.sell != null ? `${money(r.sell)}/${unitLabel(r.unit)}` : "unpriced",
              r.layers.length > 0 ? `${r.layers.length} can lay it` : "nobody ticked for it",
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
        />
        <Input
          className="tabular w-[80px] text-right"
          aria-label="Quantity"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <span className="pb-2 text-xs text-muted-foreground">{item ? unitLabel(item.unit) : ""}</span>
        <Button variant="outline" disabled={itemId == null || add.isPending} onClick={submit}>
          {add.isPending ? <Spinner /> : <Plus className="size-4" />}
          Add labour
        </Button>
      </div>

      {item ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-medium">{item.name}</span>
            <span className="tabular text-muted-foreground">
              {item.sell != null ? `${money(item.sell)} a ${unitLabel(item.unit)}` : "unpriced"}
              {lineSell != null && qtyNum > 0 ? ` · ${money(lineSell)} on the line` : ""}
            </span>
          </div>

          {item.minimumCharge != null ? (
            <p className="text-xs text-muted-foreground">
              Minimum charge on this one, {money(item.minimumCharge)} cost. A small quantity still pays it.
            </p>
          ) : null}

          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[220px] flex-1">
              <span className="mb-1 block text-xs text-muted-foreground">
                {item.layers.length > 0
                  ? `Who lays it (${item.layers.length} at or under the standard rate)`
                  : "Nobody is ticked for this work yet"}
              </span>
              <Combobox
                value={installerId}
                onChange={setInstallerId}
                emptyLabel="Nobody yet"
                placeholder={item.layers.length > 0 ? "Pick a layer" : "Nobody ticked for it"}
                disabled={item.layers.length === 0}
                options={item.layers.map((l) => ({
                  value: String(l.installerId),
                  label: l.name,
                  sublabel: l.ownRate ? "on his own rate, under standard" : "on the standard rate",
                }))}
              />
            </div>
          </div>

          {item.dearer.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {item.dearer.length === 1
                ? `${item.dearer[0]!.name} is left out, he charges more than standard on this.`
                : `${item.dearer.length} left out for charging over standard: ${item.dearer.map((d) => d.name).join(", ")}.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {note ? <p className="text-xs text-primary">{note}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
