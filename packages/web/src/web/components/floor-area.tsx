import * as React from "react";
import { Wrench } from "lucide-react";
import { Checkbox, Input, Select } from "./ui/field";
import { Spinner } from "./ui/card";
import { useBootstrap } from "../queries/settings";
import { useAddQuoteLabour, useUpdateQuoteItem } from "../queries/quotes";
import {
  defaultInstall,
  floorQty,
  floorTypeOf,
  INSTALL_ITEMS,
  wastageFromSettings,
  type FloorType,
  type ProductShape,
} from "../../api/lib/flooring-qty";

/**
 * Items 8 and 9 on the quote builder: one measured m2 per floor, Damien's own
 * wastage %, and the install that goes on with it. The sums are the server's
 * own (api/lib/flooring-qty.ts), so what this shows is what gets saved.
 */

export const ROLL_WIDTHS = [3.66, 4];

const num = (s: string) => {
  const n = Number(s);
  return s.trim() !== "" && Number.isFinite(n) ? n : null;
};

/* ------------------------- adding a product line ------------------------- */

export type AreaDraft = {
  /** Measure the floor (true) or type the qty straight in (false). */
  byArea: boolean;
  measured: string;
  wastage: string;
  width: string;
  install: boolean;
  /** Rate book item id as text. "" = none picked. */
  installId: string;
  installTouched: boolean;
};

export type AreaSubmit = {
  measuredM2?: number;
  wastagePct?: number;
  rollWidthM?: number | null;
  labour?: { itemId: number } | null;
};

/** Area state for the product picked in the supply picker. Resets when the product changes. */
export function useAreaDraft(product: (ProductShape & { id: number }) | null) {
  const settings = useBootstrap().data?.settings ?? {};
  const floor = product ? floorTypeOf(product) : null;
  const startWastage = String(wastageFromSettings(settings, floor));
  const fresh = React.useCallback((): AreaDraft => {
    const pick = defaultInstall(floor, product?.widthM ?? null);
    return {
      byArea: Boolean(floor),
      measured: "",
      wastage: startWastage,
      width: "",
      install: floor ? INSTALL_ITEMS[floor].length > 0 : false,
      installId: pick.kind === "item" ? String(pick.itemId) : "",
      installTouched: false,
    };
  }, [floor, product?.widthM, startWastage]);
  const [draft, setDraft] = React.useState<AreaDraft>(fresh);
  const productId = product?.id ?? null;
  React.useEffect(() => setDraft(fresh()), [productId, fresh]);

  const set = (patch: Partial<AreaDraft>) =>
    setDraft((d) => {
      const next = { ...d, ...patch };
      // A roll width picked on a carpet with none in the price book sets its install.
      if (patch.width !== undefined && !next.installTouched && floor === "carpet") {
        const pick = defaultInstall(floor, product?.widthM ?? num(next.width));
        next.installId = pick.kind === "item" ? String(pick.itemId) : "";
      }
      return next;
    });

  const reset = () => setDraft(fresh());
  const active = Boolean(floor && draft.byArea);
  const measured = num(draft.measured);
  const result =
    active && product && measured != null
      ? floorQty(product, measured, num(draft.wastage) ?? 0, product.widthM ? null : num(draft.width))
      : null;

  const submit = (): AreaSubmit => {
    if (!active || measured == null) return {};
    return {
      measuredM2: measured,
      wastagePct: num(draft.wastage) ?? 0,
      rollWidthM: product?.widthM ? null : num(draft.width),
      labour: !draft.install ? null : draft.installId ? { itemId: Number(draft.installId) } : undefined,
    };
  };

  return { floor, draft, set, reset, active, measured, result, submit };
}

type InstallChoice = { id: number; name: string; unit: string };

/** The measured m2, wastage, roll width and install fields under the supply picker. */
export function ProductAreaFields({
  product,
  area,
  installNames,
}: {
  product: ProductShape;
  area: ReturnType<typeof useAreaDraft>;
  installNames: Map<number, InstallChoice>;
}) {
  const uid = React.useId();
  const { floor, draft, set, result } = area;
  if (!floor) return null;
  const needsWidth = product.soldAs === "broadloom" && !product.widthM;
  const choices = INSTALL_ITEMS[floor as FloorType];

  if (!draft.byArea) {
    return (
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => set({ byArea: true })}
      >
        Work it out from the measured m² instead
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-end gap-3">
        <label htmlFor={`${uid}-m`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          Measured m²
          <Input
            id={`${uid}-m`}
            className="tabular h-8 w-[96px] text-right"
            aria-label="Measured m²"
            inputMode="decimal"
            value={draft.measured}
            onChange={(e) => set({ measured: e.target.value })}
          />
        </label>
        <label htmlFor={`${uid}-w`} className="flex flex-col gap-1 text-xs text-muted-foreground">
          Wastage %
          <Input
            id={`${uid}-w`}
            className="tabular h-8 w-[72px] text-right"
            aria-label="Wastage %"
            inputMode="decimal"
            value={draft.wastage}
            onChange={(e) => set({ wastage: e.target.value })}
          />
        </label>
        {needsWidth ? (
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Roll width
            <Select
              className="h-8 w-[120px]"
              aria-label="Roll width"
              value={draft.width}
              onChange={(e) => set({ width: e.target.value })}
            >
              <option value="">Pick a width</option>
              {ROLL_WIDTHS.map((w) => (
                <option key={w} value={String(w)}>
                  {w.toFixed(2)} m
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <button
          type="button"
          className="pb-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => set({ byArea: false })}
        >
          Type the quantity instead
        </button>
      </div>

      {result ? (
        <p className={result.problem ? "text-xs text-[#D08A1E]" : "text-xs text-muted-foreground"}>{result.note}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {product.soldAs === "box"
            ? "Sold by the box. Material is rounded up to full boxes, labour is on the measured m² only."
            : "Off the roll. Material and labour both include the wastage."}
          {needsWidth ? " No roll width in the price book, so pick one." : ""}
        </p>
      )}

      {choices.length ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor={`${uid}-i`} className="flex items-center gap-1.5">
            <Checkbox id={`${uid}-i`} checked={draft.install} onChange={(e) => set({ install: e.target.checked })} />
            Add the install
          </label>
          {draft.install ? (
            <Select
              className="h-8 w-auto min-w-[220px]"
              aria-label="Install"
              value={draft.installId}
              onChange={(e) => set({ installId: e.target.value, installTouched: true })}
            >
              <option value="">Pick the install</option>
              {choices.map((id) => (
                <option key={id} value={String(id)}>
                  {installNames.get(id)?.name ?? `Rate item ${id}`}
                </option>
              ))}
            </Select>
          ) : null}
          {draft.install && !draft.installId ? (
            <span className="text-[#D08A1E]">The line goes on flagged until you pick one.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------- a line already on the quote ------------------------ */

export type LineArea = {
  floorType: string;
  floorLabel: string;
  soldAs: string;
  note: string | null;
  problem: "no_width" | "no_box_size" | null;
  productWidthM: number | null;
  linkedLabourIds: number[];
  installChoices: InstallChoice[];
};

type AreaLine = {
  id: number;
  quoteId: number;
  measuredM2?: number | null;
  wastagePct?: number | null;
  rollWidthM?: number | null;
  area?: LineArea | null;
};

/** Under a Box or Broadloom product line: its measured m2, wastage, width, the sums, and an install button. */
export function LineAreaStrip({ item, locked }: { item: AreaLine; locked: boolean }) {
  const update = useUpdateQuoteItem();
  const addLabour = useAddQuoteLabour();
  const area = item.area;
  const [measured, setMeasured] = React.useState(item.measuredM2 == null ? "" : String(item.measuredM2));
  const [wastage, setWastage] = React.useState(item.wastagePct == null ? "" : String(item.wastagePct));
  const [installId, setInstallId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const uid = React.useId();
  React.useEffect(() => setMeasured(item.measuredM2 == null ? "" : String(item.measuredM2)), [item.measuredM2]);
  React.useEffect(() => setWastage(item.wastagePct == null ? "" : String(item.wastagePct)), [item.wastagePct]);
  if (!area) return null;

  const hasInstall = area.linkedLabourIds.length > 0;
  const needsWidth = area.productWidthM == null && area.soldAs === "broadloom";
  const run = (p: Promise<unknown>) => {
    setError(null);
    p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1 rounded-md bg-secondary/40 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-muted-foreground">{area.floorLabel}</span>
        <label htmlFor={`${uid}-m`} className="flex items-center gap-1 text-muted-foreground">
          Measured
          <Input
            id={`${uid}-m`}
            className="tabular h-7 w-[72px] text-right text-xs"
            aria-label="Measured m²"
            inputMode="decimal"
            value={measured}
            disabled={locked}
            onChange={(e) => setMeasured(e.target.value)}
            onBlur={() => {
              const n = num(measured);
              if (n !== (item.measuredM2 ?? null)) run(update.mutateAsync({ id: item.id, measuredM2: n }));
            }}
          />
          m²
        </label>
        <label htmlFor={`${uid}-w`} className="flex items-center gap-1 text-muted-foreground">
          Wastage
          <Input
            id={`${uid}-w`}
            className="tabular h-7 w-[56px] text-right text-xs"
            aria-label="Wastage %"
            inputMode="decimal"
            value={wastage}
            disabled={locked || item.measuredM2 == null}
            onChange={(e) => setWastage(e.target.value)}
            onBlur={() => {
              const n = num(wastage) ?? 0;
              if (n !== (item.wastagePct ?? null)) run(update.mutateAsync({ id: item.id, wastagePct: n }));
            }}
          />
          %
        </label>
        {needsWidth ? (
          <Select
            className="h-7 w-[118px] text-xs"
            aria-label="Roll width"
            value={item.rollWidthM == null ? "" : String(item.rollWidthM)}
            disabled={locked || item.measuredM2 == null}
            onChange={(e) =>
              run(
                update.mutateAsync({
                  id: item.id,
                  rollWidthM: e.target.value ? Number(e.target.value) : null,
                  // Damien's rule: the install is ticked on. It goes on once the width is known.
                  addInstall: !hasInstall,
                }),
              )
            }
          >
            <option value="">Roll width?</option>
            {ROLL_WIDTHS.map((w) => (
              <option key={w} value={String(w)}>
                {w.toFixed(2)} m roll
              </option>
            ))}
          </Select>
        ) : null}
        {update.isPending ? <Spinner /> : null}
      </div>
      {area.note ? <p className={area.problem ? "text-[#D08A1E]" : "text-muted-foreground"}>{area.note}</p> : null}
      {!hasInstall && !locked && area.installChoices.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            className="h-7 w-auto min-w-[200px] text-xs"
            aria-label="Install to add"
            value={installId}
            onChange={(e) => setInstallId(e.target.value)}
          >
            <option value="">No install on this line</option>
            {area.installChoices.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </Select>
          <button
            type="button"
            disabled={!installId || addLabour.isPending}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--gold-deep)] hover:bg-[var(--gold-wash)] disabled:opacity-50"
            onClick={() =>
              run(
                addLabour
                  .mutateAsync({ quoteId: item.quoteId, itemId: Number(installId), qty: 1, installerId: null, forItemId: item.id })
                  .then(() => setInstallId("")),
              )
            }
          >
            <Wrench className="size-3.5" /> Add install
          </button>
        </div>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

/** On an install line added with a product line. */
export function LinkedInstallMark() {
  return (
    <span
      className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground"
      title="Added with the product line above. Its quantity follows that line's measured m² until you type over it. Deleting the product line deletes this too."
    >
      <Wrench className="size-3" /> Install for the line above, follows its m²
    </span>
  );
}
