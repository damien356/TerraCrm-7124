import * as React from "react";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { useSuppliers } from "../queries/suppliers";
import { type SupplyProduct, type SupplySettings, useSaveSupply, useSupplyProducts, useSupplyReview } from "../queries/stockSupply";

/* ---------------------------------------------------------------------------
 * A2: one product's supply setting, set by hand, one product at a time.
 * Never applied to a whole supplier or category (7F). Every product starts
 * on "Order for each job/sale", which is today's behaviour.
 * ------------------------------------------------------------------------- */

const MODES = [
  { id: "job", label: "Order for each job/sale" },
  { id: "reorder", label: "Stocked — reorder from supplier" },
  { id: "container", label: "Stocked — owner-approved bulk/container replenishment" },
  { id: "stock_only", label: "Stock only — no planned replenishment" },
] as const;
type Mode = (typeof MODES)[number]["id"];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const n = (s: string) => (s.trim() === "" ? null : Number(s));
const t = (x: number | null | undefined) => (x == null ? "" : String(x));

export function SupplySettingsTab() {
  const [q, setQ] = React.useState("");
  const found = useSupplyProducts(q);
  const [picked, setPicked] = React.useState<SupplyProduct | null>(null);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Find a product" subtitle="One product at a time. Nothing is set for a whole supplier or category." />
        <div className="px-4 pb-4">
          <Input placeholder="Type at least 2 letters of the product name" value={q} onChange={(e) => setQ(e.target.value)} />
          {found.data?.length ? (
            <div className="mt-2 divide-y divide-border rounded-md border border-border text-sm">
              {found.data.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`block w-full px-3 py-2 text-left hover:bg-muted ${picked?.id === p.id ? "bg-muted" : ""}`}
                  onClick={() => setPicked(p)}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground">
                    {p.size ? ` · ${p.size}` : ""} · {p.category} · {p.supplier ?? "no supplier"} · {MODES.find((m) => m.id === p.settings.supplyMode)?.label}
                  </span>
                </button>
              ))}
            </div>
          ) : q.trim().length >= 2 && !found.isLoading ? (
            <p className="mt-2 text-sm text-muted-foreground">No product matches.</p>
          ) : null}
        </div>
      </Card>
      {picked ? <SupplyForm key={picked.id} productId={picked.id} name={picked.name} unit={picked.unit} initial={picked.settings} /> : null}
    </div>
  );
}

function SupplyForm({ productId, name, unit, initial }: { productId: number; name: string; unit: string | null; initial: SupplySettings }) {
  const save = useSaveSupply();
  const suppliers = useSuppliers();
  const [mode, setMode] = React.useState<Mode>(initial.supplyMode);
  const [tracked, setTracked] = React.useState(initial.stockTracked);
  const [supplierId, setSupplierId] = React.useState(t(initial.preferredSupplierId));
  const [level, setLevel] = React.useState(t(initial.reorderLevel));
  const [method, setMethod] = React.useState<"fixed" | "target">(initial.reorderMethod);
  const [rq, setRq] = React.useState(t(initial.reorderQty));
  const [target, setTarget] = React.useState(t(initial.targetLevel));
  const [pu, setPu] = React.useState(initial.purchaseUnit);
  const [per, setPer] = React.useState(t(initial.stockPerPurchase));
  const [min, setMin] = React.useState(t(initial.reorderMinQty));
  const [mult, setMult] = React.useState(t(initial.orderMultiple));
  const [lead, setLead] = React.useState(t(initial.leadTimeDays));
  const [alerts, setAlerts] = React.useState(initial.lowStockAlerts);
  const [label, setLabel] = React.useState(initial.stockUnitLabel);
  const uid = React.useId();
  const [msg, setMsg] = React.useState<string | null>(null);
  const reorder = mode === "reorder";

  async function submit() {
    setMsg(null);
    try {
      const out = await save.mutateAsync({
        productId,
        supplyMode: mode,
        stockTracked: tracked,
        preferredSupplierId: supplierId ? Number(supplierId) : null,
        reorderLevel: n(level),
        reorderMethod: method,
        reorderQty: n(rq),
        targetLevel: n(target),
        purchaseUnit: pu,
        stockPerPurchase: n(per),
        reorderMinQty: n(min),
        orderMultiple: n(mult),
        leadTimeDays: lead.trim() === "" ? null : Math.round(Number(lead)),
        lowStockAlerts: alerts,
        stockUnitLabel: label,
      });
      setMsg(`Saved for ${name} only, by ${out.supplySetBy}. Applies from now on.`);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title={name}
        subtitle={initial.supplySetAt ? `Last set ${new Date(initial.supplySetAt).toLocaleString("en-AU")} by ${initial.supplySetBy}.` : "Not reviewed yet. On the default."}
      />
      <div className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
        <Field label="How we get more">
          <Select value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            {MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox id={`${uid}-tracked`} checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
          <label htmlFor={`${uid}-tracked`}>We count this</label>
        </div>
        {mode === "container" ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:col-span-2">
            Never shown as incoming and never reordered here. A shortage shows "Stock shortage — owner review required" before a quote goes out or a sale is raised.
          </p>
        ) : null}
        {mode === "stock_only" ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:col-span-2">
            Sold from what is on the shelf. A shortage shows "Insufficient stock — no replenishment planned".
          </p>
        ) : null}
        <Field label="Supplier for stock orders" hint="Blank: the price book's supplier.">
          <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Price book supplier</option>
            {(suppliers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stock unit name" hint={`For example "bags". Blank: ${unit ?? "each"}.`}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Reorder level" hint="Low stock now: available at or below this.">
          <Input value={level} onChange={(e) => setLevel(e.target.value)} inputMode="decimal" />
        </Field>
        <div className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox id={`${uid}-alerts`} checked={alerts} onChange={(e) => setAlerts(e.target.checked)} />
          <label htmlFor={`${uid}-alerts`}>Low-stock alert (once per low spell, S6 on only)</label>
        </div>
        {reorder ? (
          <>
            <Field label="How much to reorder">
              <Select value={method} onChange={(e) => setMethod(e.target.value as "fixed" | "target")}>
                <option value="fixed">A fixed quantity</option>
                <option value="target">Up to a target level</option>
              </Select>
            </Field>
            {method === "fixed" ? (
              <Field label="Reorder quantity (stock units)">
                <Input value={rq} onChange={(e) => setRq(e.target.value)} inputMode="decimal" />
              </Field>
            ) : (
              <Field label="Target level (stock units)">
                <Input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="decimal" />
              </Field>
            )}
            <Field label="Purchase unit" hint={'Optional, for example "pallet". Blank: bought in stock units.'}>
              <Input value={pu} onChange={(e) => setPu(e.target.value)} />
            </Field>
            <Field label="Stock units in one purchase unit">
              <Input value={per} onChange={(e) => setPer(e.target.value)} inputMode="decimal" disabled={!pu} />
            </Field>
            <Field label="Supplier minimum (purchase units)">
              <Input value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Order in multiples of (purchase units)" hint="Minimum 5 with multiple 4 orders 8.">
              <Input value={mult} onChange={(e) => setMult(e.target.value)} inputMode="decimal" />
            </Field>
            <Field label="Lead time (days, Monday to Friday only; public holidays not excluded)" hint="Blank: Lead time unknown — confirm with supplier.">
              <Input value={lead} onChange={(e) => setLead(e.target.value)} inputMode="numeric" />
            </Field>
          </>
        ) : null}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button onClick={submit} disabled={save.isPending}>
            Save for this product
          </Button>
          {msg ? <span className="text-sm">{msg}</span> : null}
        </div>
      </div>
    </Card>
  );
}

/** 7F: what to look at before anything goes live. Read only; nothing is converted. */
export function SupplyReview() {
  const r = useSupplyReview(true);
  if (r.isLoading) return <Loading />;
  if (r.error) return <p className="text-sm text-destructive">{r.error.message}</p>;
  const d = r.data!;
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title={`Marked "held in warehouse" (${d.heldInWarehouse.length})`}
          subtitle="These use the older cut-to-length flag. They are listed only and have not been converted. Set each one by hand on Supply settings."
        />
        {d.heldInWarehouse.length ? (
          <ul className="divide-y divide-border text-sm">
            {d.heldInWarehouse.map((h) => (
              <li key={h.id} className="px-4 py-2">
                {h.name}
                {h.size ? ` · ${h.size}` : ""} <span className="text-muted-foreground">· now {h.modeLabel}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>None.</Empty>
        )}
      </Card>
      <Card>
        <CardHeader title={`Products to review (${d.list.length})`} subtitle="Anything counted, on the shelf, held in warehouse, or not on the default. Most issues first." />
        {d.list.length ? (
          <div className="divide-y divide-border text-sm">
            {d.list.map((p) => (
              <div key={p.id} className="px-4 py-2">
                <p>
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground">
                    {p.size ? ` · ${p.size}` : ""} · {p.category} · {p.supplier ?? "no supplier"} · {p.modeLabel}
                    {p.onShelf ? ` · ${p.onShelf} on the shelf` : ""}
                    {p.reviewed ? ` · reviewed by ${p.reviewed.by}` : ""}
                  </span>
                </p>
                {p.issues.length ? (
                  <ul className="ml-4 list-disc text-amber-900">
                    {p.issues.map((i, k) => (
                      <li key={k}>{i}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-emerald-700">No issues.</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty>Nothing to review.</Empty>
        )}
      </Card>
    </div>
  );
}
