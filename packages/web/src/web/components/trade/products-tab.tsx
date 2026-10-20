import * as React from "react";
import { Card, CardHeader, Empty, Loading, Spinner } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox, Field, Input, Select } from "../ui/field";
import { Modal } from "../ui/modal";
import { useDebounced } from "../quote-pickers";
import { useSaveProductRule, useTradeProducts } from "../../queries/trade";
import { ErrorLine, m2 } from "./shared";

type Product = NonNullable<ReturnType<typeof useTradeProducts>["data"]>[number];

/**
 * The trade list. A product is listed when it, its category or its supplier
 * is ticked, unless the product itself is excluded. The rate is standard cost
 * ex GST times the trade markup, or the fixed trade price when set. Per unit
 * supplier fees are their own lines, never inside the rate.
 */
export function TradeProductsTab() {
  const [search, setSearch] = React.useState("");
  const [listedOnly, setListedOnly] = React.useState(true);
  const term = useDebounced(search);
  const list = useTradeProducts({ search: term || undefined, listedOnly, limit: 400 });
  const [edit, setEdit] = React.useState<Product | null>(null);

  return (
    <Card>
      <CardHeader
        title="Trade list"
        subtitle="Rates are ex GST per selling unit. Fees show per unit and are added as their own lines."
        action={
          <div className="flex items-center gap-3">
            <label htmlFor="trade_cb2" className="flex items-center gap-1.5 text-sm">
              <Checkbox id="trade_cb2" checked={listedOnly} onChange={(e) => setListedOnly(e.target.checked)} />
              Listed only
            </label>
            <Input className="w-56" placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      />
      {list.isLoading ? <Loading /> : null}
      <ErrorLine error={list.error} />
      {list.data && !list.data.length ? <Empty>No products match.</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4 py-2 text-left">Product</th>
                <th className="th px-4 py-2 text-left">Supplier</th>
                <th className="th px-4 py-2 text-right">Cost ex GST</th>
                <th className="th px-4 py-2 text-right">Trade rate</th>
                <th className="th px-4 py-2 text-left">Fees per unit</th>
                <th className="th px-4 py-2 text-right">On hand</th>
                <th className="th px-4 py-2 text-left">Status</th>
                <th aria-hidden="true" className="th px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.productId} className="border-b border-border align-top last:border-0">
                  <td className="px-4 py-2">
                    <p className="font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.detail}</p>
                  </td>
                  <td className="px-4 py-2">{p.supplier}</td>
                  <td className="tabular px-4 py-2 text-right">
                    {p.costPrice != null ? m2(p.costPrice) : "-"}
                    <span className="text-xs text-muted-foreground"> /{p.unit}</span>
                  </td>
                  <td className="tabular px-4 py-2 text-right">
                    {p.priced ? (
                      <>
                        {m2(p.priced.rateExGst)}
                        <span className="text-xs text-muted-foreground"> /{p.priced.unitLabel || p.priced.sellUnit}</span>
                        {p.priced.source === "override" ? <p className="text-xs text-[var(--gold-deep)]">Fixed trade price</p> : null}
                        {p.priced.m2PerBox ? <p className="text-xs text-muted-foreground">{p.priced.m2PerBox} m2 per box</p> : null}
                        {p.priced.rollWidthM ? <p className="text-xs text-muted-foreground">{p.priced.rollWidthM} m wide</p> : null}
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {p.priced?.feesPerUnit.length
                      ? p.priced.feesPerUnit.map((f) => (
                          <p key={f.name}>
                            {f.name} {m2(f.chargeExGst)}
                          </p>
                        ))
                      : <span className="text-muted-foreground">None</span>}
                  </td>
                  <td className={`tabular px-4 py-2 text-right ${p.onHand < -0.0005 ? "text-destructive" : ""}`}>{p.onHand}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {p.onList ? <Badge colour="#2E6B4F">Listed</Badge> : <Badge>Not listed</Badge>}
                      {p.flags.map((f) => (
                        <Badge key={f} colour="#B23B2C">
                          {f}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="outline" onClick={() => setEdit(p)}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {edit ? <RuleModal p={edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function RuleModal({ p, onClose }: { p: Product; onClose: () => void }) {
  const save = useSaveProductRule();
  const [mode, setMode] = React.useState<"auto" | "include" | "exclude">((p.rule?.mode as "auto" | "include" | "exclude") ?? "auto");
  const [override, setOverride] = React.useState(p.rule?.priceOverride != null ? String(p.rule.priceOverride) : "");
  const [gst, setGst] = React.useState(!!p.rule?.gstConfirmed);
  const [label, setLabel] = React.useState(p.rule?.unitLabel ?? "");
  const [feesIncluded, setFeesIncluded] = React.useState(!!p.rule?.feesIncluded);

  return (
    <Modal
      open
      onClose={onClose}
      title={p.name}
      subtitle={p.detail}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={save.isPending}
            onClick={async () => {
              await save.mutateAsync({
                productId: p.productId,
                mode,
                priceOverride: override.trim() ? Number(override) : null,
                gstConfirmed: gst,
                unitLabel: label,
                feesIncluded: override.trim() ? feesIncluded : false,
              });
              onClose();
            }}
          >
            {save.isPending ? <Spinner /> : null}
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Trade list">
          <Select value={mode} onChange={(e) => setMode(e.target.value as "auto" | "include" | "exclude")}>
            <option value="auto">Follow its category and supplier ticks</option>
            <option value="include">Always on the trade list</option>
            <option value="exclude">Never on the trade list</option>
          </Select>
        </Field>
        <Field label="Fixed trade price, ex GST per selling unit" hint="Blank means standard cost plus the trade markup. A fixed price is final: no markup is added.">
          <Input type="number" step="0.01" min={0} value={override} onChange={(e) => setOverride(e.target.value)} placeholder="Calculated" />
        </Field>
        <label htmlFor="trade_cb3" className="flex items-center gap-2 text-sm">
          <Checkbox id="trade_cb3" checked={feesIncluded} disabled={!override.trim()} onChange={(e) => setFeesIncluded(e.target.checked)} />
          Supplier fees are included in the fixed price (no fee lines added)
        </label>
        <label htmlFor="trade_cb4" className="flex items-center gap-2 text-sm">
          <Checkbox id="trade_cb4" checked={gst} onChange={(e) => setGst(e.target.checked)} />
          GST 10% confirmed for this product
        </label>
        <Field label="Unit label (optional)" hint='For example "4.5kg bag" or "15L tub".'>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {p.priced?.skippedFees.length ? (
          <div className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium">Fees not added automatically</p>
            {p.priced.skippedFees.map((f) => (
              <p key={f.ruleId}>
                {f.name}: {f.reason}
              </p>
            ))}
          </div>
        ) : null}
        <ErrorLine error={save.error} />
      </div>
    </Modal>
  );
}
