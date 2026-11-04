import * as React from "react";
import { Link, useRoute } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/field";
import { useApproveItem, useSetCost, useStockItem } from "../queries/stock";

/**
 * One stock item: what is on it, every hold on it (several holds can share a
 * roll, clarification 1) and every movement. Approve, and cost changes for the
 * Admin with the "Change stock costs" tick.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function StockItemPage() {
  const [, params] = useRoute("/stock/:id");
  const id = Number(params?.id);
  const q = useStockItem(id);
  const approve = useApproveItem();
  const setCost = useSetCost();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [cost, setCostText] = React.useState("");
  const [status, setStatus] = React.useState<"final" | "provisional" | "estimate" | "unknown">("final");
  const [note, setNote] = React.useState("");

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <p className="p-6 text-sm text-destructive">{q.error?.message ?? "Not found"}</p>;
  const { item, holds, movements, perms } = q.data;
  const active = holds.filter((h) => ["temporary", "reserved", "cut", "picked"].includes(h.status));
  const heldTotal = active.reduce((s, h) => s + h.outstanding, 0);

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
    <Page
      title={`${item.code} · ${item.product}`}
      subtitle={
        <>
          <Link href="/stock" className="underline-offset-2 hover:underline">
            Warehouse stock
          </Link>{" "}
          · {item.type.replace("_", " ")} · batch {item.batch ?? "unknown"} · {item.location ?? "Unsorted"}
        </>
      }
    >
      <div className="grid gap-4">
        <Card>
          <CardHeader title="On this item" />
          <div className="grid grid-cols-2 gap-4 p-4 text-sm sm:grid-cols-4">
            <Fact label="On hand" value={`${item.qty} ${item.unitLabel}`} />
            <Fact label="Held (blocking)" value={`${Math.round(heldTotal * 100) / 100} ${item.unitLabel}`} />
            <Fact label="Free" value={`${item.available} ${item.unitLabel}`} strong />
            <Fact label="Status" value={`${item.status === "to_check" ? "To check" : item.status} · ${item.conditionLabel}`} />
            {perms.viewCosts ? <Fact label="Cost" value={item.costLabel ?? ""} warn={item.costUnknown || item.costReview} /> : null}
            {item.conversion ? <Fact label="Bought as" value={item.conversion} /> : null}
          </div>
          {item.status === "to_check" && perms.approve ? (
            <div className="border-t border-border px-4 py-3">
              <Button size="sm" onClick={() => run(() => approve.mutateAsync({ id: item.id }), "Approved. It can now be used.")}>
                Approve
              </Button>
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader title={`Holds (${holds.length})`} subtitle="Several orders can hold part of one roll. Holds that block stock never add up to more than is on hand." />
          {holds.length === 0 ? (
            <Empty>Nothing held on this item.</Empty>
          ) : (
            <div className="divide-y divide-border text-sm">
              {holds.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
                  <span className="w-28 font-medium">{h.statusLabel}</span>
                  <span className="w-24">
                    {h.outstanding} {h.unitLabel}
                  </span>
                  {h.jobId ? (
                    <Link href={`/jobs/${h.jobId}`} className="text-primary underline-offset-2 hover:underline">
                      Job {h.jobNumber}
                    </Link>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{h.byName}</span>
                  {h.note ? <span className="text-xs text-muted-foreground">{h.note}</span> : null}
                </div>
              ))}
            </div>
          )}
        </Card>

        {perms.changeCosts ? (
          <Card>
            <CardHeader title="Change the cost" subtitle="Admin with Change stock costs only. A dated note goes on the item. A cost is never $0." />
            <div className="flex flex-wrap items-center gap-2 p-4">
              <Input className="w-28" placeholder="38.50" value={cost} onChange={(e) => setCostText(e.target.value)} />
              <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="final">Final</option>
                <option value="provisional">Provisional</option>
                <option value="estimate">Estimate</option>
                <option value="unknown">Cost unknown</option>
              </Select>
              <Input className="w-72" placeholder="Why" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button size="sm" onClick={() => run(() => setCost.mutateAsync({ id: item.id, unitCost: status === "unknown" || !cost ? null : Number(cost), costStatus: status, note }), "Cost saved.")}>
                Save cost
              </Button>
            </div>
          </Card>
        ) : null}

        <Card>
          <CardHeader title="Movements" />
          <div className="divide-y divide-border text-sm">
            {movements.map((m) => (
              <div key={m.id} className="flex flex-wrap gap-3 px-4 py-2">
                <span className="w-32">{m.kind.replace(/_/g, " ")}</span>
                <span className="w-24">{m.qty > 0 ? `+${m.qty}` : m.qty}</span>
                <span className="text-muted-foreground">{m.note}</span>
                <span className="text-xs text-muted-foreground">{m.byName}</span>
              </div>
            ))}
          </div>
        </Card>
        {msg ? <p className="text-sm">{msg}</p> : null}
      </div>
    </Page>
  );
}

function Fact({ label, value, strong, warn }: { label: string; value: string; strong?: boolean; warn?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`${strong ? "text-base font-semibold" : ""} ${warn ? "text-amber-700" : ""}`}>{value}</div>
    </div>
  );
}
