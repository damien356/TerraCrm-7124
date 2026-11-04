import * as React from "react";
import { Link } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select } from "../components/ui/field";
import {
  newRequestKey,
  type StockOverview,
  useOpeningStock,
  useReceivable,
  useReceive,
  useRecheckAll,
  useSaveRules,
  useSetCardCheck,
  useSetPermission,
  useSetSwitch,
  useStockOverview,
  useStockPermissions,
  useStockProducts,
} from "../queries/stock";

/**
 * WAREHOUSE STOCK (v3 + amendment A1).
 *
 * The list of what is on the shelf and what is free, opening stock (each piece
 * "to check" until an Admin approves it), receiving a PO line, and the
 * switches. Every switch starts off. Off means today's behaviour.
 */

type Tab = "list" | "opening" | "receive" | "settings";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "list", label: "Stock list" },
  { id: "opening", label: "Opening stock" },
  { id: "receive", label: "Receive" },
  { id: "settings", label: "Switches and permissions" },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function StockPage() {
  const initial = (new URLSearchParams(window.location.search).get("tab") as Tab | null) ?? "list";
  const [tab, setTab] = React.useState<Tab>(TABS.some((t) => t.id === initial) ? initial : "list");
  const [q, setQ] = React.useState("");
  const data = useStockOverview({ q: q || undefined });
  const o = data.data;

  return (
    <Page title="Warehouse stock" subtitle="What is on the shelf, what is held, and what is free. Nothing here sends a PO, an email or a text.">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <Button key={t.id} size="sm" variant={tab === t.id ? "default" : "outline"} onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
        {o?.perms.approve ? (
          <Link href="/stock/reorder" className="ml-auto text-sm text-primary underline-offset-2 hover:underline">
            Reorder list and warehouse orders
          </Link>
        ) : null}
      </div>
      {data.isLoading ? <Loading /> : data.error ? <p className="text-sm text-destructive">{data.error.message}</p> : null}
      {o ? <SwitchStrip o={o} /> : null}
      {o && tab === "list" ? <StockList o={o} q={q} setQ={setQ} /> : null}
      {o && tab === "opening" ? <OpeningStock o={o} /> : null}
      {o && tab === "receive" ? <ReceiveTab o={o} /> : null}
      {o && tab === "settings" ? <SettingsTab o={o} /> : null}
    </Page>
  );
}

function SwitchStrip({ o }: { o: StockOverview }) {
  const keys = Object.keys(o.switches) as Array<keyof StockOverview["switches"]>;
  return (
    <div className="mb-4 flex flex-wrap gap-2 text-xs">
      {keys.map((k) => (
        <span
          key={k}
          className={`rounded-full border px-2.5 py-1 ${o.switches[k].state === "on" ? "border-emerald-500 text-emerald-700" : o.switches[k].state === "paused" ? "border-amber-500 text-amber-700" : "border-border text-muted-foreground"}`}
        >
          {o.switchLabels[k]}: {o.switches[k].state}
        </span>
      ))}
      <span className={`rounded-full border px-2.5 py-1 ${o.cardCheck.done ? "border-emerald-500 text-emerald-700" : "border-border text-muted-foreground"}`}>
        Live card check (step F): {o.cardCheck.done ? "recorded" : "not recorded"}
      </span>
    </div>
  );
}

function StockList({ o, q, setQ }: { o: StockOverview; q: string; setQ: (s: string) => void }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title={`Stock (${o.items.length})`}
          subtitle={o.value != null ? `General stock value $${o.value.toLocaleString("en-AU", { minimumFractionDigits: 2 })} ex GST. Items with Cost unknown are not counted.` : "Costs are hidden for your login."}
          action={<Input className="h-8 w-56" placeholder="Search code, product, batch" value={q} onChange={(e) => setQ(e.target.value)} />}
        />
        {o.items.length === 0 ? (
          <Empty>No stock yet. Opening stock goes in on the Opening stock tab.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2">Code</th>
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2">Batch</th>
                  <th className="px-4 py-2 text-right">On hand</th>
                  <th className="px-4 py-2 text-right">Free</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Where</th>
                  {o.perms.viewCosts ? <th className="px-4 py-2">Cost</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {o.items.map((it) => (
                  <tr key={it.id}>
                    <td className="px-4 py-2 font-mono">
                      <Link href={`/stock/${it.id}`} className="text-primary underline-offset-2 hover:underline">
                        {it.code}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{it.product}</td>
                    <td className="px-4 py-2">{it.batch ?? "unknown"}</td>
                    <td className="px-4 py-2 text-right">
                      {it.qty} {it.unitLabel}
                    </td>
                    <td className="px-4 py-2 text-right font-medium">
                      {it.available} {it.unitLabel}
                    </td>
                    <td className="px-4 py-2">
                      {it.status === "to_check" ? "To check" : it.status}
                      {it.condition !== "good" ? ` · ${it.conditionLabel}` : ""}
                    </td>
                    <td className="px-4 py-2">{it.location ?? ""}</td>
                    {o.perms.viewCosts ? <td className={`px-4 py-2 ${it.costUnknown || it.costReview ? "text-amber-700" : ""}`}>{it.costLabel}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Stock alerts" subtitle="Each alert has a fixed key and is sent once. On the test copy nothing leaves the building." />
        {o.alerts.length === 0 ? (
          <Empty>No stock alerts yet.</Empty>
        ) : (
          <div className="divide-y divide-border text-sm">
            {o.alerts.map((a) => (
              <div key={a.id} className="px-4 py-2">
                <span className="font-medium">{a.title}</span> <span className="text-muted-foreground">{a.body}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function OpeningStock({ o }: { o: StockOverview }) {
  const [search, setSearch] = React.useState("");
  const products = useStockProducts(search);
  const save = useOpeningStock();
  const [productId, setProductId] = React.useState<number | null>(null);
  const [type, setType] = React.useState<"roll" | "remnant" | "box_lot" | "loose" | "unit_lot" | "cut_piece">("roll");
  const [unit, setUnit] = React.useState("lm");
  const [qty, setQty] = React.useState("");
  const [width, setWidth] = React.useState("");
  const [batch, setBatch] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [costPer, setCostPer] = React.useState<"lm" | "m2" | "unit">("lm");
  const [unknown, setUnknown] = React.useState(false);
  const [locationId, setLocationId] = React.useState<string>("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [requestKey, setRequestKey] = React.useState(newRequestKey);

  async function submit() {
    setMsg(null);
    if (!productId) return setMsg("Pick the product.");
    try {
      const out = await save.mutateAsync({
        productId,
        type,
        unit,
        qty: Number(qty),
        widthM: width ? Number(width) : null,
        batch: batch || null,
        locationId: locationId ? Number(locationId) : null,
        costPer,
        unitCost: unknown || !cost ? null : Number(cost),
        costUnknown: unknown,
        requestKey,
      });
      setMsg(`${out.item.code} saved as "To check". An Admin approves it before it can be used.`);
      setRequestKey(newRequestKey());
      setQty("");
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader title="Opening stock" subtitle="One piece at a time. Each starts as To check. A cost is never $0: enter it, or tick Cost unknown." />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Product">
          <Input placeholder="Search the price list" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select className="mt-2" value={productId ?? ""} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick one</option>
            {(products.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.unitLabel}
                {p.conversion ? `, ${p.conversion}` : ""})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="roll">Roll</option>
            <option value="remnant">Remnant</option>
            <option value="cut_piece">Cut piece</option>
            <option value="box_lot">Boxes</option>
            <option value="loose">Loose pieces</option>
            <option value="unit_lot">Units</option>
          </Select>
        </Field>
        <Field label="Quantity and unit">
          <div className="flex gap-2">
            <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="25" />
            <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="lm">m (roll length)</option>
              <option value="m2">m²</option>
              <option value="box">boxes</option>
              <option value="each">each</option>
            </Select>
          </div>
        </Field>
        <Field label="Roll width (m)" hint="Needed for rolls measured in metres.">
          <Input value={width} onChange={(e) => setWidth(e.target.value)} placeholder="3.66" />
        </Field>
        <Field label="Batch" hint="Leave blank if unknown. Unknown never matches another batch.">
          <Input value={batch} onChange={(e) => setBatch(e.target.value)} />
        </Field>
        <Field label="Where">
          <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Unsorted</option>
            {o.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
        {o.perms.viewCosts ? (
          <Field label="Cost ex GST">
            <div className="flex items-center gap-2">
              <Input value={cost} disabled={unknown} onChange={(e) => setCost(e.target.value)} placeholder="38.50" />
              <Select value={costPer} onChange={(e) => setCostPer(e.target.value as typeof costPer)}>
                <option value="lm">per m</option>
                <option value="m2">per m²</option>
                <option value="unit">per unit</option>
              </Select>
            </div>
            <label htmlFor="stock-cost-unknown-a" className="mt-2 flex items-center gap-2 text-sm">
              <Checkbox id="stock-cost-unknown-a" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> Cost unknown — review required
            </label>
          </Field>
        ) : (
          <label htmlFor="stock-cost-unknown-b" className="flex items-center gap-2 text-sm">
            <Checkbox id="stock-cost-unknown-b" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} /> Cost unknown — review required
          </label>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Button onClick={submit} disabled={save.isPending}>
          Save as To check
        </Button>
        {msg ? <span className="text-sm">{msg}</span> : null}
      </div>
    </Card>
  );
}

function ReceiveTab({ o }: { o: StockOverview }) {
  const [poId, setPoId] = React.useState("");
  const po = useReceivable(poId ? Number(poId) : null);
  const receive = useReceive();
  const [lineId, setLineId] = React.useState<number | null>(null);
  const [len, setLen] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [width, setWidth] = React.useState("");
  const [batch, setBatch] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const [requestKey, setRequestKey] = React.useState(newRequestKey);

  async function submit() {
    setMsg(null);
    if (!lineId) return setMsg("Pick the PO line.");
    try {
      const out = await receive.mutateAsync({
        poLineId: lineId,
        pieces: [{ qty: Number(len), labelQty: label ? Number(label) : null, widthM: width ? Number(width) : null, batch: batch || null, locationId: o.locations[0]?.id ?? null }],
        requestKey,
      });
      setMsg(`Received ${out.items.map((i) => i.code).join(", ")}.${out.shortRolls.length ? ` Short roll: ${out.shortRolls.join(", ")}.` : ""}`);
      setRequestKey(newRequestKey());
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader title="Receive a PO line" subtitle="Measure each roll. A roll shorter than its label is flagged. Receiving never sends anything to the supplier." />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="PO id">
          <Input value={poId} onChange={(e) => setPoId(e.target.value)} placeholder="e.g. 3" />
        </Field>
        <Field label="Line">
          <Select value={lineId ?? ""} onChange={(e) => setLineId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Pick one</option>
            {(po.data?.lines ?? []).map((l) => (
              <option key={l.id} value={l.id}>
                {l.description} ({l.qty} {l.unitLabel})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Measured (m, or count)">
          <Input value={len} onChange={(e) => setLen(e.target.value)} />
        </Field>
        <Field label="Label says">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Width (m)">
          <Input value={width} onChange={(e) => setWidth(e.target.value)} />
        </Field>
        <Field label="Batch">
          <Input value={batch} onChange={(e) => setBatch(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-3">
        <Button onClick={submit} disabled={receive.isPending}>
          Receive
        </Button>
        {po.data ? <span className="text-xs text-muted-foreground">{/^PO/i.test(po.data.po.number) ? "" : "PO "}{po.data.po.number} ({po.data.po.status})</span> : null}
        {msg ? <span className="text-sm">{msg}</span> : null}
      </div>
    </Card>
  );
}

function SettingsTab({ o }: { o: StockOverview }) {
  const setSwitch = useSetSwitch();
  const card = useSetCardCheck();
  const recheckAll = useRecheckAll();
  const rules = useSaveRules();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [r, setR] = React.useState(o.rules);
  const admin = o.role === "admin";
  const keys = Object.keys(o.switches) as Array<keyof StockOverview["switches"]>;

  async function run(fn: () => Promise<unknown>, done: string) {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Switches" subtitle="Each starts off. Off means Ops works as it does today. Paused keeps existing holds but nothing new can be done." />
        <div className="divide-y divide-border">
          {keys.map((k) => (
            <div key={k} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="w-56 font-medium">{o.switchLabels[k]}</span>
              <span className="w-20">{o.switches[k].state}</span>
              {admin
                ? (["off", "on", "paused"] as const).map((s) => (
                    <Button key={s} size="sm" variant={o.switches[k].state === s ? "default" : "outline"} onClick={() => run(() => setSwitch.mutateAsync({ key: k, state: s }), `${o.switchLabels[k]} set to ${s}.`)}>
                      {s === "on" ? "Turn on" : s === "off" ? "Turn off" : "Pause"}
                    </Button>
                  ))
                : null}
              {o.switches[k].by ? <span className="text-xs text-muted-foreground">by {o.switches[k].by}</span> : null}
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Live card check (step F)"
          subtitle="Needed before card payments reserve stock by themselves, for both S3 Stock-backed sales and S4 Installation jobs. Only the main admin records it."
        />
        <div className="flex flex-wrap items-center gap-3 p-4 text-sm">
          <span>{o.cardCheck.done ? `Recorded by ${o.cardCheck.by}: ${o.cardCheck.note}` : "Not recorded. Card payments wait for an Admin to confirm them for stock."}</span>
          {o.isMainAdmin ? (
            <>
              <Input className="h-8 w-72" placeholder="What was checked" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" onClick={() => run(() => card.mutateAsync({ done: !o.cardCheck.done, note }), o.cardCheck.done ? "Card check cleared." : "Card check recorded.")}>
                {o.cardCheck.done ? "Clear" : "Record the card check"}
              </Button>
            </>
          ) : null}
        </div>
      </Card>
      <Card>
        <CardHeader title="Rules" />
        <div className="grid gap-3 p-4 sm:grid-cols-4">
          <Field label="Carpet: keep pieces from (m)">
            <Input value={r.carpetKeepMinM} onChange={(e) => setR({ ...r, carpetKeepMinM: Number(e.target.value) })} />
          </Field>
          <Field label="Vinyl: free up to (m)">
            <Input value={r.vinylFreeMaxM} onChange={(e) => setR({ ...r, vinylFreeMaxM: Number(e.target.value) })} />
          </Field>
          <Field label="Temporary hold (hours)">
            <Input value={r.holdHours} onChange={(e) => setR({ ...r, holdHours: Number(e.target.value) })} />
          </Field>
          <Field label="Warn before it ends (hours)">
            <Input value={r.warnHours} onChange={(e) => setR({ ...r, warnHours: Number(e.target.value) })} />
          </Field>
        </div>
        {admin ? (
          <div className="flex gap-3 border-t border-border px-4 py-3">
            <Button size="sm" onClick={() => run(() => rules.mutateAsync(r), "Rules saved.")}>
              Save rules
            </Button>
            <Button size="sm" variant="outline" onClick={() => run(() => recheckAll.mutateAsync(undefined), "Every order rechecked.")}>
              Recheck all stock
            </Button>
          </div>
        ) : null}
      </Card>
      {admin ? <PermissionsCard isMainAdmin={o.isMainAdmin} onMsg={setMsg} /> : null}
      {msg ? <p className="text-sm">{msg}</p> : null}
    </div>
  );
}

function PermissionsCard({ isMainAdmin, onMsg }: { isMainAdmin: boolean; onMsg: (s: string) => void }) {
  const people = useStockPermissions();
  const save = useSetPermission();
  async function tick(profileId: number, patch: { handle?: boolean; allocate?: boolean; changeCosts?: boolean }) {
    try {
      await save.mutateAsync({ profileId, ...patch });
      onMsg("Saved.");
    } catch (e) {
      onMsg(errText(e));
    }
  }
  return (
    <Card>
      <CardHeader title="Stock permissions" subtitle="Admins can do everything except Change stock costs, a separate tick only the main admin grants, and only to an Admin." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Person</th>
              <th className="px-4 py-2">Role</th>
              <th className="px-4 py-2">Handle stock</th>
              <th className="px-4 py-2">Allocate and hold</th>
              <th className="px-4 py-2">Change stock costs</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {(people.data ?? []).map((p) => (
              <tr key={p.profileId}>
                <td className="px-4 py-2">{p.name}</td>
                <td className="px-4 py-2">{p.role}</td>
                <td className="px-4 py-2">
                  <Checkbox checked={p.role === "admin" || p.handle} disabled={p.role === "admin"} onChange={(e) => tick(p.profileId, { handle: e.target.checked })} />
                </td>
                <td className="px-4 py-2">
                  <Checkbox checked={p.role === "admin" || p.allocate} disabled={p.role !== "office"} onChange={(e) => tick(p.profileId, { allocate: e.target.checked })} />
                </td>
                <td className="px-4 py-2">
                  <Checkbox checked={p.changeCosts} disabled={!isMainAdmin || p.role !== "admin"} onChange={(e) => tick(p.profileId, { changeCosts: e.target.checked })} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
