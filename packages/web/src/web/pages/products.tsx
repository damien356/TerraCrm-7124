import * as React from "react";
import { AlertTriangle, CalendarClock, ChevronLeft, PackageCheck, Search, Tag, TrendingDown } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select } from "../components/ui/field";
import { BulkEditPriceModal, BulkSpecialModal } from "../components/bulk-price";
import { Modal } from "../components/ui/modal";
import {
  useCreateSpecial,
  useEndSpecial,
  useExtendRangeSpecials,
  useProduct,
  useProductRanges,
  useProducts,
  useRollQuote,
  useSpecialsBoard,
  useSetSoldAs,
} from "../queries/products";
import { PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS } from "../../api/lib/product-categories";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const UNIT_LABEL: Record<string, string> = { m2: "m²", lm: "lm", each: "each", roll: "roll" };
const unit = (u: string) => UNIT_LABEL[u] ?? u;

/** One list for the whole app, so the tabs and the editor never drift (item 10, 11 Oct). */
const CATEGORY_LABEL = PRODUCT_CATEGORY_LABELS;

const TONE = { danger: "#B4342A", warn: "#D08A1E", good: "#3F7D3A", info: "#4A7FA5" };

/** Red inside a week, amber inside a fortnight. The office needs the warning early. */
function countdownTone(daysLeft: number) {
  if (daysLeft <= 7) return TONE.danger;
  if (daysLeft <= 21) return TONE.warn;
  return TONE.good;
}

function countdownLabel(daysLeft: number) {
  if (daysLeft < 0) return "ended";
  if (daysLeft === 0) return "last day today";
  if (daysLeft === 1) return "last day tomorrow";
  return `${daysLeft} days left`;
}

/**
 * Whether the office can get it, read off the three fields the seeds already
 * write: `madeToOrder`, `leadTimeDays`, `availabilityNote`.
 *
 * This matters most on Tarkett sheet vinyl, where 70 of 180 colours are import
 * only at 8-10 weeks and cost exactly the same per m2 as the 110 held in
 * Australian stock. On price alone the two read identically, so the warning has
 * to sit on the row itself.
 *
 * `availabilityNote` is a SHARED soft-warning field, not a stock field. Mitre 10
 * puts an expired-quote warning in it, Sunstar a confirm-the-fit warning,
 * Chameleon an owner-supplied-price warning. So the tone is inferred from the
 * wording rather than assumed, and anything unrecognised stays a quiet
 * check-before-order note instead of claiming something about stock.
 */
function availability(p: { madeToOrder?: boolean | null; leadTimeDays?: number | null; availabilityNote?: string | null }) {
  const note = (p.availabilityNote ?? "").trim();
  /** Not on the floor anywhere. The supplier's own window is in the note. */
  if (p.madeToOrder) {
    return { tone: TONE.warn, label: "Made to order", note, leadTimeDays: p.leadTimeDays ?? null, alert: true };
  }
  if (!note) return null;
  if (/^price expired/i.test(note)) {
    return { tone: TONE.danger, label: "Price expired", note, leadTimeDays: p.leadTimeDays ?? null, alert: true };
  }
  if (/australian stock|held in stock|in stock/i.test(note)) {
    return { tone: TONE.good, label: "In stock", note, leadTimeDays: p.leadTimeDays ?? null, alert: false };
  }
  return { tone: TONE.info, label: "Check before order", note, leadTimeDays: p.leadTimeDays ?? null, alert: true };
}

function prettyDate(iso: string) {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(new Date());
}

function plusDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ------------------------- specials about to lapse ------------------------ */

function ExpiryBanner({ endingWithinDays }: { endingWithinDays: number }) {
  const board = useSpecialsBoard(endingWithinDays);
  const extend = useExtendRangeSpecials();
  const groups = board.data?.endingSoonByRange ?? [];
  if (!groups.length) return null;

  return (
    <Card className="mb-4 border-l-[3px] border-l-[#B4342A]">
      <CardHeader
        title="Specials about to run out"
        subtitle="Your buying price goes back to standard on its own, so the extra margin or client discount stops. Extend them if the supplier has rolled the deal over."
        action={
          <Badge colour={TONE.danger}>
            <AlertTriangle className="size-3" />
            {groups.length} {groups.length === 1 ? "range" : "ranges"}
          </Badge>
        }
      />
      <div className="divide-y divide-border">
        {groups.map((g) => (
          <div key={`${g.supplier}-${g.range}-${g.endsOn}`} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <div className="min-w-[220px] flex-1">
              <p className="text-sm font-semibold">
                {g.range} <span className="font-normal text-muted-foreground">· {g.supplier}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {g.colours} {g.colours === 1 ? "colour" : "colours"} on special, ends {prettyDate(g.endsOn)}
              </p>
            </div>
            <Badge colour={countdownTone(g.daysLeft)}>
              <CalendarClock className="size-3" />
              {countdownLabel(g.daysLeft)}
            </Badge>
            <ExtendButton supplier={g.supplier} range={g.range} endsOn={g.endsOn} pending={extend.isPending} />
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExtendButton({
  supplier,
  range,
  endsOn,
  pending,
}: {
  supplier: string;
  range: string;
  endsOn: string;
  pending: boolean;
}) {
  const ranges = useProductRanges();
  const extend = useExtendRangeSpecials();
  const [open, setOpen] = React.useState(false);
  const [newEnd, setNewEnd] = React.useState(plusDays(endsOn, 30));
  const [error, setError] = React.useState<string | null>(null);

  const supplierId = ranges.data?.find((r) => r.supplier === supplier && r.range === range)?.supplierId ?? null;

  async function submit() {
    if (supplierId === null) return;
    setError(null);
    try {
      await extend.mutateAsync({ supplierId, range, endsOn: newEnd });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not extend that special");
    }
  }

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)} disabled={pending || supplierId === null}>
        Extend
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Extend ${range}`}
        subtitle={`Every live special on this range moves to the new end date. It still reverts on its own after that.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={extend.isPending}>
              Extend to {prettyDate(newEnd)}
            </Button>
          </>
        }
      >
        <Field label="New end date" hint="Inclusive: the special still applies all of that day.">
          <Input type="date" value={newEnd} min={todayISO()} onChange={(e) => setNewEnd(e.target.value)} />
        </Field>
        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </Modal>
    </>
  );
}

/* ------------------------------ range browser ----------------------------- */

function RangeGrid({ onOpen }: { onOpen: (supplierId: number | null, range: string) => void }) {
  const ranges = useProductRanges();
  const [category, setCategory] = React.useState("");

  if (ranges.isLoading) return <Loading label="Loading the price book…" />;
  const rows = (ranges.data ?? []).filter((r) => !category || r.category === category);
  // In the price book's own order, so Engineered and Solid timber sit side by side.
  const order = (c: string) => {
    const i = (PRODUCT_CATEGORIES as readonly string[]).indexOf(c);
    return i < 0 ? 99 : i;
  };
  const categories = [...new Set((ranges.data ?? []).map((r) => r.category))].sort((a, b) => order(a) - order(b));

  if (!rows.length) return <Empty>No ranges in the price book yet.</Empty>;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant={category === "" ? "primary" : "ghost"} onClick={() => setCategory("")}>
          Everything
        </Button>
        {categories.map((c) => (
          <Button key={c} variant={category === c ? "primary" : "ghost"} onClick={() => setCategory(c)}>
            {CATEGORY_LABEL[c] ?? c}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => onOpen(r.supplierId, r.range)}
            className="card-surface cursor-pointer px-4 py-3 text-left transition-colors hover:border-primary/40"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold tracking-[-0.01em]">{r.range}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {r.supplier} · {CATEGORY_LABEL[r.category] ?? r.category}
                  {r.tier ? ` · ${r.tier.toLowerCase()}` : ""}
                </p>
              </div>
              {r.onSpecial > 0 ? (
                <Badge colour={TONE.good}>
                  <Tag className="size-3" />
                  +{money(r.bestExtraMargin)} margin
                </Badge>
              ) : null}
            </div>
            <p className="tabular mt-2.5 text-[15px] font-semibold">
              {r.sellFrom === r.sellTo ? money(r.sellFrom) : `${money(r.sellFrom)} to ${money(r.sellTo)}`}
              <span className="text-xs font-normal text-muted-foreground"> /{unit(r.unit)} sell ex GST</span>
            </p>
            <p className="tabular mt-0.5 text-xs text-muted-foreground">
              buying at {r.costFrom === r.costTo ? money(r.costFrom) : `${money(r.costFrom)} to ${money(r.costTo)}`}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {r.colourCount} {r.colourCount === 1 ? "colour" : "colours"}
              {r.backings.length ? ` · ${r.backings.join(", ")}` : ""}
              {r.variants !== r.colourCount ? ` · ${r.variants} variants` : ""}
            </p>
            {r.soonestEnd && r.daysLeft !== null ? (
              <p className="mt-1.5 text-xs" style={{ color: countdownTone(r.daysLeft) }}>
                {r.onSpecial} on special, {countdownLabel(r.daysLeft)}
              </p>
            ) : null}
          </button>
        ))}
      </div>
    </>
  );
}

/* ----------------------------- variant listing ---------------------------- */

type SoldAsFilter = "" | "box" | "broadloom" | "none";
const SOLD_AS_FILTERS: { value: SoldAsFilter; label: string }[] = [
  { value: "", label: "Box and broadloom" },
  { value: "box", label: "Box only" },
  { value: "broadloom", label: "Broadloom only" },
  { value: "none", label: "Neither (not tagged)" },
];

/** Item 9. Box goods round up to full boxes on a quote; broadloom comes off the roll. */
function SoldAsCell({ id, soldAs }: { id: number; soldAs: string | null }) {
  const save = useSetSoldAs();
  return (
    <Select
      aria-label="Sold as"
      className="h-8 w-[112px] text-xs"
      value={soldAs ?? ""}
      disabled={save.isPending}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) =>
        save.mutate({ id, soldAs: e.target.value === "box" || e.target.value === "broadloom" ? e.target.value : null })
      }
    >
      <option value="box">Box</option>
      <option value="broadloom">Broadloom</option>
      <option value="">Neither</option>
    </Select>
  );
}

function VariantTable({
  supplierId,
  range,
  search,
  onSpecialOnly,
  soldAs = "",
  onSelect,
}: {
  supplierId: number | null;
  range: string;
  search: string;
  onSpecialOnly: boolean;
  soldAs?: SoldAsFilter;
  onSelect: (id: number) => void;
}) {
  const products = useProducts({ supplierId, range, search, onSpecialOnly, soldAs });
  const [picked, setPicked] = React.useState<Set<number>>(new Set());
  const [bulk, setBulk] = React.useState<null | "edit" | "special">(null);
  // A new search is a new list. Never carry ticks over to rows you cannot see.
  React.useEffect(() => setPicked(new Set()), [supplierId, range, search, onSpecialOnly, soldAs]);

  if (products.isLoading) return <Loading label="Pricing…" />;
  const rows = products.data ?? [];
  if (!rows.length) return <Empty>Nothing matches that.</Empty>;

  const allTicked = rows.every((r) => picked.has(r.id));
  const ids = [...picked];
  const toggle = (id: number) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="overflow-x-auto">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-4 py-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={allTicked}
            onChange={() => setPicked(allTicked ? new Set() : new Set(rows.map((r) => r.id)))}
          />
          {picked.size ? `${picked.size} of ${rows.length} ticked` : `Select all ${rows.length}`}
        </label>
        {picked.size ? (
          <>
            <Button onClick={() => setBulk("edit")}>Edit price</Button>
            <Button variant="outline" onClick={() => setBulk("special")}>
              <Tag className="size-3.5" />
              On special
            </Button>
            <Button variant="ghost" onClick={() => setPicked(new Set())}>
              Clear
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Tick products to change their price in bulk.</span>
        )}
      </div>
      <BulkEditPriceModal
        ids={ids}
        open={bulk === "edit"}
        onClose={() => setBulk(null)}
        onDone={() => {
          setBulk(null);
          setPicked(new Set());
        }}
      />
      <BulkSpecialModal
        ids={ids}
        open={bulk === "special"}
        onClose={() => setBulk(null)}
        onDone={() => {
          setBulk(null);
          setPicked(new Set());
        }}
      />
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="w-10 px-4 py-2">
              <span className="sr-only">Pick</span>
            </th>
            <th className="label-xs px-4 py-2">Colour</th>
            <th className="label-xs px-4 py-2">Variant</th>
            <th className="label-xs px-4 py-2 text-right">Cost today</th>
            <th className="label-xs px-4 py-2 text-right">Sell ex GST</th>
            <th className="label-xs px-4 py-2">Special</th>
            <th className="label-xs px-4 py-2" title="Box: rounded up to full boxes on a quote. Broadloom: off the roll.">
              Sold as
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((p) => {
            const avail = availability(p);
            return (
            <tr
              key={p.id}
              onClick={() => onSelect(p.id)}
              className="cursor-pointer transition-colors hover:bg-secondary/50"
            >
              <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                <Checkbox aria-label={`Pick ${p.colour || "product"}`} checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
              </td>
              <td className="px-4 py-2.5">
                <p className="font-medium">{p.colour || "-"}</p>
                <p className="text-xs text-muted-foreground">
                  {p.range} · {p.supplier}
                </p>
                {/* Stock or no stock, on the row. An import-only colour used to
                    look exactly like a stocked one here. */}
                {avail ? (
                  <Badge colour={avail.tone} className="mt-1">
                    {avail.alert ? <AlertTriangle className="size-3" /> : <PackageCheck className="size-3" />}
                    {avail.label}
                  </Badge>
                ) : null}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {[p.backing, p.size, p.weight].filter(Boolean).join(" · ") || "-"}
                {p.unitsPerPack ? (
                  <span className="block">
                    {p.unitsPerPack} per carton · {p.packM2} m²
                  </span>
                ) : null}
              </td>
              <td className="tabular px-4 py-2.5 text-right">
                {p.onSpecial ? (
                  <>
                    <span className="text-muted-foreground line-through">{money(p.standardCostExGst)}</span>{" "}
                    <span className="font-semibold" style={{ color: TONE.good }}>
                      {money(p.costExGst)}
                    </span>
                  </>
                ) : (
                  <span className="font-medium">{money(p.costExGst)}</span>
                )}
                <span className="block text-xs text-muted-foreground">
                  /{unit(p.unit)}
                  {p.costPerM2 !== null ? ` · ${money(p.costPerM2)}/m²` : ""}
                </span>
                {/* Sheet vinyl has a second, dearer rate for a part roll. */}
                {p.hasCutRate ? (
                  <span className="block text-xs" style={{ color: TONE.warn }}>
                    cut {money(p.cutRateExGst)}/{unit(p.unit)}
                  </span>
                ) : null}
              </td>
              <td className="tabular px-4 py-2.5 text-right font-medium">
                {money(p.sellExGst)}
                <span className="block text-xs text-muted-foreground">{money(p.sellIncGst)} inc</span>
              </td>
              <td className="px-4 py-2.5">
                {p.special ? (
                  <div className="flex flex-col items-start gap-1">
                    <Badge colour={TONE.good}>
                      <TrendingDown className="size-3" />
                      {p.passedOnToCustomer ? "discount to customer" : `+${money(p.extraMarginPerUnit)} margin`}
                    </Badge>
                    <span className="text-xs" style={{ color: countdownTone(p.special.daysLeft) }}>
                      {countdownLabel(p.special.daysLeft)} · to {prettyDate(p.special.endsOn)}
                    </span>
                  </div>
                ) : p.reverted ? (
                  <span className="text-xs text-muted-foreground">
                    cost back to standard {prettyDate(p.reverted.endsOn)}
                  </span>
                ) : p.upcoming ? (
                  <Badge colour={TONE.info}>starts {prettyDate(p.upcoming.startsOn)}</Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">standard price</span>
                )}
              </td>
              <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                <SoldAsCell id={p.id} soldAs={p.soldAs} />
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------- one variant, drawer -------------------------- */

/**
 * Roll or cut, for a real quantity. Sheet vinyl comes off a fixed roll, so the
 * same colour has two costs and the quantity decides which one applies — and
 * sometimes taking the whole roll is the cheaper order. This works that out on
 * the spot instead of in someone's head at the counter.
 */
function RollQuote({
  id,
  productUnit,
  unitLabel,
  rollM2,
  rollLm,
  rollM2Covered,
  rollRate,
  cutRate,
  breakEvenQty,
  breakEvenLm,
  hasCutRate,
  volumeQty,
  volumeRate,
}: {
  id: number;
  productUnit: string;
  unitLabel: string;
  rollM2: number | null;
  rollLm: number | null;
  rollM2Covered: number | null;
  rollRate: number | null;
  cutRate: number | null;
  breakEvenQty: number | null;
  breakEvenLm: number | null;
  /** false on a product whose only break is the volume one (MJS carpet tile). */
  hasCutRate: boolean;
  volumeQty: number | null;
  volumeRate: number | null;
}) {
  // Show whichever unit ISN'T the product's own, so a carpet priced per lineal
  // metre reads "20 lm a roll (72 m²)" and sheet vinyl priced per m2 still
  // reads "40 m² a roll (20 lm)". Without this an lm-priced line renders the
  // same number twice, because its roll figure is already in lineal metres.
  const isLm = productUnit === "lm";
  const rollAlt = isLm ? rollM2Covered : rollLm;
  const rollAltUnit = isLm ? "m²" : "lm";
  // The break-even is in the product's own unit too, so the lm restatement is
  // only worth showing when that unit is not already lm.
  const breakEvenAlt = isLm ? null : breakEvenLm;
  const [raw, setRaw] = React.useState("");
  const [qtyUnit, setQtyUnit] = React.useState<"m2" | "lm">("m2");
  const qty = Number.parseFloat(raw);
  const quote = useRollQuote({ id, qty: Number.isFinite(qty) && qty > 0 ? qty : 0, qtyUnit });
  const q = quote.data?.quote;

  return (
    <div className="rounded-md border border-border p-3">
      {/* "Roll or cut" is the wrong heading on a product whose only break is
          the volume one — there is no cut rate to weigh it against. */}
      <p className="label-xs mb-2">{hasCutRate ? "Roll or cut" : "Quantity break"}</p>
      <p className="mb-3 text-xs text-muted-foreground">
        {rollM2 ? `${rollM2} ${unitLabel} a roll${rollAlt ? ` (${rollAlt} ${rollAltUnit})` : ""} · ` : ""}
        {hasCutRate ? (
          <>
            roll {money(rollRate)} · cut {money(cutRate)} a {unitLabel}
          </>
        ) : (
          <>
            {money(rollRate)} a {unitLabel}
          </>
        )}
        {breakEvenQty
          ? ` · a roll pays for itself above ${breakEvenQty} ${unitLabel}${breakEvenAlt ? ` (${breakEvenAlt} lm)` : ""}`
          : ""}
        {volumeQty && volumeRate ? ` · over ${volumeQty} ${unitLabel} it drops to ${money(volumeRate)}` : ""}
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="How much does the job need?" className="min-w-[160px] flex-1">
          <Input
            type="number"
            min={0}
            step="0.1"
            inputMode="decimal"
            placeholder="e.g. 46"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </Field>
        <div className="flex gap-1 pb-[1px]">
          {(["m2", "lm"] as const).map((u) => (
            <Button
              key={u}
              size="sm"
              variant={qtyUnit === u ? "default" : "outline"}
              onClick={() => setQtyUnit(u)}
            >
              {u === "m2" ? "m²" : "lm"}
            </Button>
          ))}
        </div>
      </div>

      {quote.isFetching && !q ? (
        <Loading />
      ) : !q ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Put a quantity in and it works out whether it bills as a roll or a cut.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat
              label={
                q.onVolumeRate
                  ? "Billing at the volume rate"
                  : q.onRollRate
                    ? "Billing at the roll rate"
                    : "Billing at the cut rate"
              }
              value={money(q.rateExGst)}
              tone={q.onRollRate ? "success" : "default"}
              hint={`per ${unitLabel} ex GST${q.qtyLm ? ` · ${q.qty} ${unitLabel} = ${q.qtyLm} lm` : ""}`}
            />
            {/* One slot, two opposite facts: what a cut is costing extra, or
                what the volume break is saving. They can never both be live —
                a volume order has cleared the roll break by definition. */}
            {q.onVolumeRate ? (
              <Stat
                label="Volume saving"
                value={q.volumeSavingTotal ? `-${money(q.volumeSavingTotal)}` : "-"}
                tone="success"
                hint={`against ${money(q.rollRateExGst)} a ${unitLabel} at the roll rate`}
              />
            ) : (
              <Stat
                label="Cut premium"
                value={q.cutPremiumTotal ? `+${money(q.cutPremiumTotal)}` : "-"}
                tone={q.cutPremiumTotal ? "warning" : "success"}
                hint={
                  q.cutPremiumTotal ? `${money(q.cutPremiumPerUnit)} a ${unitLabel} extra` : "no premium on this qty"
                }
              />
            )}
            <Stat label="Cost this line" value={money(q.costExGst)} hint="ex GST" />
            <Stat
              label="Sell this line"
              value={money(q.sellExGst)}
              hint={`${money(q.sellIncGst)} inc GST · ${money(q.sellPerUnitExGst)} a ${unitLabel}`}
            />
          </div>

          <p
            className="rounded-md px-3 py-2 text-xs"
            style={{
              backgroundColor: `${q.betterAsFullRoll || q.betterAtVolume ? TONE.warn : q.onRollRate ? TONE.good : TONE.info}14`,
              color: q.betterAsFullRoll || q.betterAtVolume ? TONE.warn : q.onRollRate ? TONE.good : TONE.info,
            }}
          >
            {q.note}
          </p>

          {quote.data?.onSpecial ? (
            <p className="text-xs" style={{ color: TONE.good }}>
              A special is live at {money(quote.data.specialCostExGst)} a {unitLabel}. That lowers the roll rate Terra
              pays, the cut premium still sits on top, and the sell price above does not move.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

function VariantModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const product = useProduct(id);
  const endSpecial = useEndSpecial();
  const [adding, setAdding] = React.useState(false);
  const p = product.data;
  const avail = p ? availability(p) : null;

  return (
    <Modal
      open={id !== null}
      onClose={onClose}
      title={p ? `${p.range} ${p.colour}` : "Loading…"}
      subtitle={p ? [p.supplier, p.backing, p.size, p.weight].filter(Boolean).join(" · ") : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {p ? <Button onClick={() => setAdding(true)}>Put on special</Button> : null}
        </>
      }
    >
      {!p ? (
        <Loading />
      ) : (
        <div className="space-y-4">
          {/* Two by two, not four across: inside the modal four columns clip a
              figure like "+$19.00" at the card edge. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Standard cost" value={money(p.standardCostExGst)} hint={`per ${unit(p.unit)} ex GST`} />
            <Stat
              label="Buying at today"
              value={money(p.costExGst)}
              tone={p.onSpecial ? "success" : "default"}
              hint={p.onSpecial ? "special price is live" : "no special running"}
            />
            <Stat
              label="Sell ex GST"
              value={money(p.sellExGst)}
              hint={p.onSpecial ? "unchanged by the special" : `${money(p.sellIncGst)} inc GST`}
            />
            <Stat
              label="Extra margin"
              value={p.onSpecial ? `+${money(p.extraMarginPerUnit)}` : "-"}
              tone={p.onSpecial ? "success" : "default"}
              hint={p.onSpecial ? `per ${unit(p.unit)}, yours to keep` : "nothing running"}
            />
          </div>

          {/* Availability before price notes. A colour nobody can get for ten
              weeks is the first thing the office needs to know, ahead of what
              it costs. */}
          {avail ? (
            <div
              className="rounded-md px-3 py-2"
              style={{ backgroundColor: `${avail.tone}14`, borderLeft: `3px solid ${avail.tone}` }}
            >
              <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: avail.tone }}>
                {avail.alert ? <AlertTriangle className="size-3.5" /> : <PackageCheck className="size-3.5" />}
                {avail.label}
              </p>
              {avail.note ? (
                <p className="mt-0.5 text-xs" style={{ color: avail.tone }}>
                  {avail.note}
                </p>
              ) : null}
              {avail.leadTimeDays ? (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Allow {avail.leadTimeDays} days when scheduling the job. Planning figure only, quote the supplier's
                  own window above.
                </p>
              ) : null}
            </div>
          ) : null}

          {p.priceNote ? (
            <p
              className="rounded-md px-3 py-2 text-xs"
              style={{
                backgroundColor: `${p.onSpecial ? TONE.good : TONE.info}14`,
                color: p.onSpecial ? TONE.good : TONE.info,
              }}
            >
              {p.priceNote}
            </p>
          ) : null}

          {p.hasCutRate || p.hasVolumeRate ? (
            <RollQuote
              id={p.id}
              productUnit={p.unit}
              unitLabel={unit(p.unit)}
              rollM2={p.rollM2}
              rollLm={p.rollLm}
              rollM2Covered={p.rollM2Covered}
              rollRate={p.standardCostExGst}
              cutRate={p.cutRateExGst}
              breakEvenQty={p.rollBreakEvenQty}
              breakEvenLm={p.rollBreakEvenLm}
              hasCutRate={p.hasCutRate}
              volumeQty={p.hasVolumeRate ? p.volumeQty : null}
              volumeRate={p.hasVolumeRate ? p.volumeCostPrice : null}
            />
          ) : null}

          {p.minOrderQty ? (
            <p className="text-xs text-muted-foreground">
              Minimum order {p.minOrderQty} {unit(p.unit)}.
            </p>
          ) : null}

          <div>
            <p className="label-xs mb-2">Specials history</p>
            {!p.history.length ? (
              <p className="text-xs text-muted-foreground">
                Never been on special. The standard price is what gets quoted.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-md border border-border">
                {p.history.map((h) => (
                  <div key={h.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <div className="min-w-[180px] flex-1">
                      <p className="text-sm font-medium">
                        {money(h.costPriceExGst)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          /{unit(p.unit)} · +{money(h.savingPerUnit)} margin a {unit(p.unit)}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {h.label} · {prettyDate(h.startsOn)} to {prettyDate(h.endsOn)}
                      </p>
                    </div>
                    <Badge
                      colour={
                        h.status === "live"
                          ? TONE.good
                          : h.status === "scheduled"
                            ? TONE.info
                            : h.status === "cancelled"
                              ? TONE.warn
                              : null
                      }
                    >
                      {h.status === "live" ? countdownLabel(h.daysLeft) : h.status}
                    </Badge>
                    {h.status === "live" ? (
                      <Button
                        variant="ghost"
                        onClick={() => endSpecial.mutate({ id: h.id, reason: "Ended early in the office" })}
                        disabled={endSpecial.isPending}
                      >
                        End now
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {p.sourceNote || p.notes ? (
            <p className="text-xs text-muted-foreground">{[p.notes, p.sourceNote].filter(Boolean).join(" · ")}</p>
          ) : null}

          <NewSpecialModal
            productId={p.id}
            standard={p.standardCostExGst}
            unitLabel={unit(p.unit)}
            open={adding}
            onClose={() => setAdding(false)}
          />
        </div>
      )}
    </Modal>
  );
}

function NewSpecialModal({
  productId,
  standard,
  unitLabel,
  open,
  onClose,
}: {
  productId: number;
  standard: number | null;
  unitLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateSpecial();
  const today = todayISO();
  const [form, setForm] = React.useState({
    label: "Clearance",
    costPriceExGst: "",
    startsOn: today,
    endsOn: plusDays(today, 30),
  });
  const [error, setError] = React.useState<string | null>(null);

  const price = Number(form.costPriceExGst);
  const valid = Number.isFinite(price) && price > 0 && (standard === null || price <= standard);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        productId,
        label: form.label || "Clearance",
        kind: "clearance",
        costPriceExGst: price,
        startsOn: form.startsOn,
        endsOn: form.endsOn,
        source: "Entered in the office",
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that special");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Put this on special"
      subtitle={`Your buying price only. The sell price stays where it is, so the saving is yours. Cost reverts to ${money(standard)} per ${unitLabel} on its own the day after it ends.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || create.isPending}>
            Save special
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="What to call it">
          <Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        </Field>
        <Field
          label={`Special cost per ${unitLabel} ex GST`}
          hint={standard === null ? undefined : `Standard is ${money(standard)}. A special has to be under it.`}
        >
          <Input
            type="number"
            step="0.01"
            value={form.costPriceExGst}
            onChange={(e) => setForm({ ...form, costPriceExGst: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starts">
            <Input
              type="date"
              value={form.startsOn}
              onChange={(e) => setForm({ ...form, startsOn: e.target.value })}
            />
          </Field>
          <Field label="Ends" hint="Inclusive.">
            <Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} />
          </Field>
        </div>
        {price > 0 && standard !== null ? (
          <p className="text-xs" style={{ color: TONE.good }}>
            Keeps selling at {money(Math.round(standard * 1.3 * 1.05 * 1.4 * 100) / 100)} ex GST, and puts{" "}
            +{money(Math.round((standard - price) * 100) / 100)} a {unitLabel} of extra margin in your pocket while it
            runs.
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* --------------------------------- specials -------------------------------- */

function SpecialsTab({ onSelect }: { onSelect: (id: number) => void }) {
  const board = useSpecialsBoard(14);
  if (board.isLoading) return <Loading label="Checking what is on special…" />;
  const b = board.data;
  if (!b) return <Empty>Nothing to show.</Empty>;

  const section = (
    title: string,
    subtitle: string,
    rows: typeof b.live,
    tone: string | null,
  ) => (
    <Card className="mb-4">
      <CardHeader title={title} subtitle={subtitle} action={<Badge colour={tone}>{rows.length}</Badge>} />
      {!rows.length ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((r) => (
            <button
              key={r.specialId}
              type="button"
              onClick={() => onSelect(r.productId)}
              className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50"
            >
              <div className="min-w-[200px] flex-1">
                <p className="text-sm font-medium">
                  {r.range} {r.colour}
                  {r.backing ? <span className="text-muted-foreground"> · {r.backing}</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.supplier} · {r.label} · {prettyDate(r.startsOn)} to {prettyDate(r.endsOn)}
                </p>
              </div>
              <p className="tabular text-sm">
                <span className="text-muted-foreground line-through">{money(r.standardCostExGst)}</span>{" "}
                <span className="font-semibold" style={{ color: TONE.good }}>
                  {money(r.specialCostExGst)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  /{unit(r.unit)} · +{money(r.savingPerUnit)} margin
                </span>
              </p>
              <Badge colour={r.daysLeft >= 0 ? countdownTone(r.daysLeft) : null}>
                {r.daysLeft >= 0 ? countdownLabel(r.daysLeft) : `ended ${prettyDate(r.endsOn)}`}
              </Badge>
            </button>
          ))}
        </div>
      )}
    </Card>
  );

  return (
    <>
      {section(
        "Live now",
        `Buying under standard today, ${prettyDate(b.today)}. The sell price is not discounted, the margin is yours.`,
        b.live,
        TONE.good,
      )}
      {b.scheduled.length
        ? section("Scheduled", "Loaded and waiting. Switches itself on.", b.scheduled, TONE.info)
        : null}
      {b.recentlyEnded.length
        ? section(
            "Reverted in the last 60 days",
            "Back to paying the standard cost, so the extra margin is gone. Sell prices never moved.",
            b.recentlyEnded,
            null,
          )
        : null}
    </>
  );
}

/* ---------------------------------- page ---------------------------------- */

export default function ProductsPage() {
  const [tab, setTab] = React.useState<"book" | "specials">("book");
  const [range, setRange] = React.useState<{ supplierId: number | null; range: string } | null>(null);
  const [search, setSearch] = React.useState("");
  const [onSpecialOnly, setOnSpecialOnly] = React.useState(false);
  const [soldAs, setSoldAs] = React.useState<SoldAsFilter>("");
  const [selected, setSelected] = React.useState<number | null>(null);

  const ranges = useProductRanges();
  const board = useSpecialsBoard(14);
  const totals = React.useMemo(() => {
    const rows = ranges.data ?? [];
    return {
      variants: rows.reduce((t, r) => t + r.variants, 0),
      ranges: rows.length,
      suppliers: new Set(rows.map((r) => r.supplier)).size,
    };
  }, [ranges.data]);

  const searching = search.trim().length > 1 || onSpecialOnly || soldAs !== "";

  return (
    <Page
      title="Price book"
      subtitle="Sell prices come off the standard supplier cost. A special cuts what you pay for a set window, then reverts on its own."
      actions={
        <>
          <Button variant={tab === "book" ? "primary" : "ghost"} onClick={() => setTab("book")}>
            Price book
          </Button>
          <Button variant={tab === "specials" ? "primary" : "ghost"} onClick={() => setTab("specials")}>
            Specials
            {board.data?.counts.live ? ` (${board.data.counts.live})` : ""}
          </Button>
        </>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Variants priced" value={totals.variants} hint={`${totals.ranges} ranges`} />
        <Stat label="Suppliers in the book" value={totals.suppliers} />
        <Stat
          label="Buying under standard"
          value={board.data?.counts.live ?? 0}
          tone={board.data?.counts.live ? "success" : "default"}
          hint="extra margin, or a discount passed on"
        />
        <Stat
          label="Ending within 14 days"
          value={board.data?.counts.endingSoon ?? 0}
          tone={board.data?.counts.endingSoon ? "warning" : "default"}
          hint="then you pay standard again"
        />
      </div>

      <ExpiryBanner endingWithinDays={14} />

      {tab === "specials" ? (
        <SpecialsTab onSelect={setSelected} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search a range, colour or backing"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button variant={onSpecialOnly ? "primary" : "ghost"} onClick={() => setOnSpecialOnly((v) => !v)}>
              <Tag className="size-3.5" />
              On special only
            </Button>
            <Select
              aria-label="Sold as filter"
              className="w-auto"
              value={soldAs}
              onChange={(e) => setSoldAs(e.target.value as SoldAsFilter)}
            >
              {SOLD_AS_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.value === "" ? "Sold as: any" : f.label}
                </option>
              ))}
            </Select>
          </div>

          {range && !searching ? (
            <Card>
              <CardHeader
                title={range.range}
                subtitle="Every buyable variant. Price can differ by backing or width, so each line is priced on its own."
                action={
                  <Button variant="ghost" onClick={() => setRange(null)}>
                    <ChevronLeft className="size-3.5" />
                    All ranges
                  </Button>
                }
              />
              <VariantTable
                supplierId={range.supplierId}
                range={range.range}
                search=""
                onSpecialOnly={false}
                onSelect={setSelected}
              />
            </Card>
          ) : searching ? (
            <Card>
              <CardHeader
                title={onSpecialOnly ? "On special" : "Search results"}
                subtitle={
                  onSpecialOnly
                    ? "Live specials only, cheapest cost first."
                    : soldAs
                      ? `${SOLD_AS_FILTERS.find((f) => f.value === soldAs)?.label}. First 2000.`
                      : "Matching variants."
                }
              />
              <VariantTable
                supplierId={null}
                range=""
                search={search.trim()}
                onSpecialOnly={onSpecialOnly}
                soldAs={soldAs}
                onSelect={setSelected}
              />
            </Card>
          ) : (
            <RangeGrid onOpen={(supplierId, r) => setRange({ supplierId, range: r })} />
          )}
        </>
      )}

      <VariantModal id={selected} onClose={() => setSelected(null)} />
    </Page>
  );
}
