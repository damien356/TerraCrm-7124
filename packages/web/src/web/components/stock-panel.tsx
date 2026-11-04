import * as React from "react";
import { Link } from "wouter";
import { Card, CardHeader, Empty } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { moneyExact } from "../lib/money";
import {
  newRequestKey,
  type StockHold,
  type StockPanel as Panel,
  useAllocate,
  useApproveFree,
  useBringIn,
  useCompletePercent,
  useConfirmPayment,
  useCutHold,
  useDeclineFree,
  useExtendHold,
  usePickHold,
  useRecheck,
  useReleaseHold,
  useStockPanel,
} from "../queries/stock";
import { useCustomerArrangement } from "../queries/stockSupply";

/**
 * The stock card on a job or a product sale (v3 section 4, A1.2 to A1.4).
 *
 * Deposit status is worked out from the payment rows every time. Money typed
 * in by hand, or read back from Xero, counts for stock only once an Admin
 * presses "Confirm for stock" on that payment. Hidden while the switch for
 * this kind of order is off and no order exists.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function StockPanelCard({ jobId }: { jobId: number }) {
  const q = useStockPanel(jobId);
  const [msg, setMsg] = React.useState<string | null>(null);
  const p = q.data;
  if (!p || (p.switchState === "off" && !p.order)) return null;

  async function run(fn: () => Promise<unknown>, done: string) {
    setMsg(null);
    try {
      await fn();
      setMsg(done);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  const label = p.kind === "job" ? "S4 Installation jobs" : "S3 Stock-backed sales";
  return (
    <Card>
      <CardHeader
        title="Stock for this order"
        subtitle={`${label}: ${p.switchState}. Stock is firm only once the deposit is confirmed. Nothing here sends a PO, an email or a text.`}
        action={p.order ? <RecheckButton jobId={jobId} onMsg={setMsg} /> : null}
      />
      <DepositBox p={p} run={run} />
      <ShortageBox p={p} run={run} />
      <HoldList p={p} run={run} />
      {p.switchState === "on" && p.order?.status !== "cancelled" && p.order?.status !== "review" ? <AllocateForm p={p} jobId={jobId} run={run} /> : null}
      {p.canBringIn ? <BringIn jobId={jobId} run={run} /> : null}
      {msg ? <p className="border-t border-border px-4 py-2 text-sm">{msg}</p> : null}
    </Card>
  );
}

type Run = (fn: () => Promise<unknown>, done: string) => Promise<void>;

function RecheckButton({ jobId, onMsg }: { jobId: number; onMsg: (s: string) => void }) {
  const recheck = useRecheck();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={recheck.isPending}
      onClick={async () => {
        try {
          const r = await recheck.mutateAsync({ jobId });
          onMsg(r.skipped ? `Not changed: the order is ${r.skipped}.` : `Rechecked. ${r.firmed} made firm, ${r.short} short.`);
        } catch (e) {
          onMsg(errText(e));
        }
      }}
    >
      Recheck stock
    </Button>
  );
}

function DepositBox({ p, run }: { p: Panel; run: Run }) {
  const confirm = useConfirmPayment();
  const complete = useCompletePercent();
  const [pct, setPct] = React.useState("");
  if (!p.order) return <div className="px-4 py-3 text-sm text-muted-foreground">No stock chosen yet.</div>;
  const d = p.deposit;
  const isAdmin = p.perms.confirm;
  return (
    <div className="border-b border-border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-3">
        <span className={`font-semibold ${d?.code === "confirmed" ? "text-emerald-700" : d?.code === "awaiting_confirm" ? "text-amber-700" : ""}`}>{d?.label ?? "Not accepted yet"}</span>
        {d?.required != null ? (
          <span className="text-muted-foreground">
            Deposit {d.percent}% = {moneyExact(d.required)}. Confirmed {moneyExact(d.confirmed)}
            {d.recordedUnconfirmed > 0 ? `, recorded and not confirmed ${moneyExact(d.recordedUnconfirmed)}` : ""}.
          </span>
        ) : null}
        {p.reserveStatus ? <span className={`font-medium ${p.reserveStatus === "Fully reserved" ? "text-emerald-700" : "text-amber-700"}`}>{p.reserveStatus}</span> : null}
        {p.order.status === "review" ? <span className="text-amber-700">{p.order.reviewNote}</span> : null}
        {p.order.joinedVia === "brought_in" ? <span className="text-xs text-muted-foreground">Brought in by {p.order.broughtInByName}</span> : null}
      </div>
      {d?.code === "to_complete" ? (
        <div className="mt-2 flex items-center gap-2">
          <Input className="h-8 w-20" value={pct} onChange={(e) => setPct(e.target.value)} placeholder="%" />
          <Button size="sm" onClick={() => run(() => complete.mutateAsync({ orderId: p.order!.id, percent: Number(pct) }), "Deposit % saved.")}>
            Save the deposit %
          </Button>
          <span className="text-xs text-muted-foreground">Deposit % to complete. Stock is not reserved until it is filled in and paid.</span>
        </div>
      ) : null}
      {d && d.payments.length ? (
        <div className="mt-2 grid gap-1">
          {d.payments.map((pay) => (
            <div key={pay.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-24 font-medium">{moneyExact(pay.amount)}</span>
              <span className="w-16">{pay.method}</span>
              <span className={pay.counts ? "text-emerald-700" : "text-muted-foreground"}>{pay.why}</span>
              {!pay.counts && isAdmin && pay.method !== "contra" ? (
                <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => confirm.mutateAsync({ paymentId: pay.id }), "Confirmed for stock. No new payment was recorded.")}>
                  Confirm for stock
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A2c: material on this order that is short right now. Container and
 * stock-only shortages stop the customer paying online until the shortage is
 * resolved or the main admin writes down what the customer agreed to. That
 * record is separate from the internal approval note.
 */
function ShortageBox({ p, run }: { p: Panel; run: Run }) {
  if (!p.shortages.length) return null;
  return (
    <div className="grid gap-2 border-b border-border bg-amber-50 px-4 py-3 text-sm">
      {p.shortages.map((s) => (
        <ShortageRow key={`${s.target.orderId ?? "i" + s.target.invoiceId}-${s.productId}`} s={s} canRecord={p.canRecordArrangement} run={run} />
      ))}
    </div>
  );
}

function ShortageRow({ s, canRecord, run }: { s: Panel["shortages"][number]; canRecord: boolean; run: Run }) {
  const save = useCustomerArrangement();
  const [text, setText] = React.useState("");
  const [agreed, setAgreed] = React.useState(false);
  const id = `arr-${s.target.orderId ?? "i" + s.target.invoiceId}-${s.productId}`;
  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium">{s.product}</span>
        <span className="text-amber-800">{s.label}</span>
        {s.blocksPayment && !s.arrangement ? <span className="text-xs text-amber-800">Online payment is paused until this is resolved or the customer's arrangement is recorded.</span> : null}
      </div>
      {s.arrangement ? (
        <p className="text-xs text-muted-foreground">
          Customer agreed: {s.arrangement.text} ({s.arrangement.byName ?? "main admin"}
          {s.arrangement.at ? `, ${new Date(s.arrangement.at).toLocaleDateString("en-AU")}` : ""})
        </p>
      ) : s.blocksPayment && canRecord ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="h-8 min-w-64 flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="What the customer agreed to, for example: 40 bags now, 10 in December" />
          <label htmlFor={id} className="flex items-center gap-1.5 text-xs">
            <Checkbox id={id} checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> The customer agreed to this
          </label>
          <Button size="sm" variant="outline" className="h-8" disabled={save.isPending} onClick={() => run(() => save.mutateAsync({ orderId: s.target.orderId ?? null, invoiceId: s.target.invoiceId ?? null, productId: s.productId, arrangement: text, customerAgreed: agreed }), "Customer arrangement recorded.")}>
            Record arrangement
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HoldList({ p, run }: { p: Panel; run: Run }) {
  if (!p.order) return null;
  if (!p.holds.length) return <Empty>No stock chosen for this order yet.</Empty>;
  return (
    <div className="divide-y divide-border text-sm">
      {p.holds.map((h) => (
        <HoldRow key={h.id} h={h} p={p} run={run} />
      ))}
    </div>
  );
}

function HoldRow({ h, p, run }: { h: StockHold; p: Panel; run: Run }) {
  const cut = useCutHold();
  const pick = usePickHold();
  const release = useReleaseHold();
  const extend = useExtendHold();
  const approveFree = useApproveFree();
  const declineFree = useDeclineFree();
  // A2: a shortage row can be withdrawn when the job no longer needs it.
  const ended = ["released", "cancelled", "issued", "handed_over"].includes(h.status);
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
      <span className="w-32 font-medium">{h.statusLabel}</span>
      {h.itemId ? (
        <Link href={`/stock/${h.itemId}`} className="w-20 font-mono text-primary underline-offset-2 hover:underline">
          {h.itemCode}
        </Link>
      ) : (
        <span className="w-20 text-muted-foreground">to come in</span>
      )}
      <span className="w-28">
        {h.outstanding} {h.unitLabel}
        {h.collectedQty > 0 ? ` (${h.collectedQty} out)` : ""}
      </span>
      {h.freeQty > 0 ? <span className="text-xs">Free remainder {h.freeQty} {h.unitLabel} ({h.freeState})</span> : null}
      {h.expiresAt && h.status === "temporary" ? <span className="text-xs text-muted-foreground">until {new Date(h.expiresAt).toLocaleString("en-AU")}</span> : null}
      {h.note ? <span className="text-xs text-muted-foreground">{h.note}</span> : null}
      <span className="ml-auto flex flex-wrap gap-1.5">
        {h.freeState === "proposed" && p.perms.approve ? (
          <>
            <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => approveFree.mutateAsync({ holdId: h.id }), "Free remainder approved.")}>
              Approve free
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => run(() => declineFree.mutateAsync({ holdId: h.id }), "Free remainder declined.")}>
              Decline
            </Button>
          </>
        ) : null}
        {h.status === "temporary" && p.perms.allocate ? (
          <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => extend.mutateAsync({ holdId: h.id, reason: "Customer asked for more time" }), "Hold extended.")}>
            Extend
          </Button>
        ) : null}
        {h.status === "reserved" && p.perms.handle ? (
          <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => cut.mutateAsync({ holdId: h.id, requestKey: newRequestKey() }), "Cut.")}>
            Cut
          </Button>
        ) : null}
        {(h.status === "reserved" || h.status === "cut") && p.perms.handle ? (
          <Button size="sm" variant="outline" className="h-7" onClick={() => run(() => pick.mutateAsync({ holdId: h.id }), "Picked.")}>
            Picked
          </Button>
        ) : null}
        {!ended && p.perms.allocate ? (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => run(() => release.mutateAsync({ holdId: h.id, reason: "Released by the office" }), "Released.")}>
            Release
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function AllocateForm({ p, jobId, run }: { p: Panel; jobId: number; run: Run }) {
  const allocate = useAllocate();
  const [itemId, setItemId] = React.useState<string>("");
  const [qty, setQty] = React.useState("");
  const [unit, setUnit] = React.useState("lm");
  const [temporary, setTemporary] = React.useState(false);
  const [batchOk, setBatchOk] = React.useState(false);
  const [key, setKey] = React.useState(newRequestKey);
  const [lineKey, setLineKey] = React.useState("");
  if (!p.perms.allocate) return null;
  const chosen = p.choices.find((c) => String(c.id) === itemId);
  const lineChoices = p.lines.filter((l) => !chosen || l.productId === chosen.productId);
  const line = lineChoices.find((l) => l.key === lineKey) ?? (lineChoices.length === 1 ? lineChoices[0] : null);
  return (
    <div className="grid gap-3 border-t border-border p-4 sm:grid-cols-5">
      <Field label="For line" className="sm:col-span-5">
        <Select value={line?.key ?? ""} onChange={(e) => setLineKey(e.target.value)}>
          <option value="">{lineChoices.length ? "Pick the quote line or material" : "No matching line on this job"}</option>
          {lineChoices.map((l) => (
            <option key={l.key} value={l.key}>
              {l.label} · {l.qty} {l.unitLabel}
              {l.conversion ? ` (${l.conversion})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Stock item" className="sm:col-span-2">
        <Select
          value={itemId}
          onChange={(e) => {
            setItemId(e.target.value);
            const c = p.choices.find((x) => String(x.id) === e.target.value);
            if (c) setUnit(c.unit);
          }}
        >
          <option value="">Pick a roll, box or lot</option>
          {p.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} {c.product} · batch {c.batch ?? "unknown"} · {c.available} {c.unitLabel} free{c.conversion ? ` (${c.conversion})` : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Quantity">
        <div className="flex gap-2">
          <Input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="5" />
          <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="lm">m</option>
            <option value="m2">m²</option>
            <option value="box">boxes</option>
            <option value="each">{chosen && !["lm", "m2", "box"].includes(chosen.unit) ? chosen.unitLabel : "each"}</option>
          </Select>
        </div>
      </Field>
      <div className="grid gap-1 text-sm">
        <label htmlFor="stock-temporary-hold" className="flex items-center gap-2">
          <Checkbox id="stock-temporary-hold" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} /> Temporary hold
        </label>
        <label htmlFor="stock-batch-approved" className="flex items-center gap-2">
          <Checkbox id="stock-batch-approved" checked={batchOk} onChange={(e) => setBatchOk(e.target.checked)} /> Batch approved
        </label>
      </div>
      <div className="flex items-end">
        <Button
          disabled={allocate.isPending}
          onClick={() =>
            run(async () => {
              const out = await allocate.mutateAsync({
                jobId,
                itemId: chosen ? chosen.id : null,
                productId: chosen?.productId ?? line?.productId ?? null,
                quoteItemId: line?.quoteItemId ?? null,
                saleLineId: line?.saleLineId ?? null,
                jobMaterialId: line?.jobMaterialId ?? null,
                orderedQty: Number(qty),
                lineUnit: unit,
                temporary,
                batchApproved: batchOk,
                requestKey: key,
              });
              setKey(newRequestKey());
              setQty("");
              setItemId("");
              if (out.warning) throw new Error(out.warning);
            }, "Stock chosen.")
          }
        >
          Choose this stock
        </Button>
      </div>
    </div>
  );
}

function BringIn({ jobId, run }: { jobId: number; run: Run }) {
  const bring = useBringIn();
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 text-sm">
      <span>This order was accepted before the stock workflow was on. Bringing it in saves where it stands now. Nothing is re-ordered, re-reserved or re-costed.</span>
      <Button size="sm" onClick={() => run(() => bring.mutateAsync({ jobId }), "Brought into the stock workflow.")}>
        Bring into stock workflow
      </Button>
    </div>
  );
}
