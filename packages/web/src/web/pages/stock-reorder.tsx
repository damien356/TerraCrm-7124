import * as React from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Textarea } from "../components/ui/field";
import { orpc } from "../lib/api";
import { useMarkPoSent, useSendPo } from "../queries/purchasing";
import {
  type ReorderList,
  type ReorderProduct,
  type ReorderShortage,
  type WarehouseOrder,
  useCloseLine,
  useDraftSuggestions,
  useEditDraftLine,
  useEditTerms,
  useRemoveLink,
  useReorderList,
  useToJobPo,
  useToWarehouse,
} from "../queries/stockSupply";
import { SupplyReview, SupplySettingsTab } from "../components/stock-supply-settings";

/**
 * A2: LOW-STOCK ALERTS AND WAREHOUSE ORDERS (S6). Admin only.
 *
 * The Reorder list, grouped by supplier, with each job shortage and its
 * route (A: the job's own PO, B: the warehouse order). The warehouse orders
 * themselves (PO-W…), their terms for the cash forecast, and the product
 * settings. Nothing here sends anything by itself. Send and Mark sent are
 * buttons a person presses.
 */

type Tab = "list" | "orders" | "settings" | "review";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "list", label: "Reorder list" },
  { id: "orders", label: "Warehouse orders" },
  { id: "settings", label: "Supply settings" },
  { id: "review", label: "Review before go-live" },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const money = (n: number | null | undefined) => (n == null ? "" : `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const qty = (n: number) => `${Math.round(n * 100) / 100}`;
const auDate = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "");
const STATUS: Record<string, string> = { draft: "Draft, not sent", sent: "Ordered — awaiting receipt", invoiced: "Bill matched", received: "Received", cancelled: "Cancelled" };

function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    for (const k of [orpc.stockSupply.key(), orpc.stock.key(), orpc.purchasing.key(), orpc.finance.key(), orpc.payables.key()]) qc.invalidateQueries({ queryKey: k });
  };
}

export default function StockReorderPage() {
  const initial = (new URLSearchParams(window.location.search).get("tab") as Tab | null) ?? "list";
  const [tab, setTab] = React.useState<Tab>(TABS.some((t) => t.id === initial) ? initial : "list");
  const data = useReorderList();
  const d = data.data;

  return (
    <Page
      title="Reorder list and warehouse orders"
      subtitle="Admin only. Suggestions and drafts only. Nothing here sends a PO, an email or a text unless you press Send."
      actions={
        <Link href="/stock" className="text-sm text-primary underline-offset-2 hover:underline">
          Back to warehouse stock
        </Link>
      }
    >
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button key={t.id} size="sm" variant={tab === t.id ? "default" : "outline"} onClick={() => setTab(t.id)}>
            {t.label}
          </Button>
        ))}
      </div>
      {data.isLoading ? (
        <Loading />
      ) : data.error ? (
        <p className="text-sm text-destructive">
          {/Admin/i.test(data.error.message) ? "The Reorder list and warehouse orders are Admin only. Ask Damien or an Admin." : data.error.message}
        </p>
      ) : null}
      {d ? <S6Strip d={d} /> : null}
      {d && tab === "list" ? <ReorderTab d={d} /> : null}
      {d && tab === "orders" ? <OrdersTab d={d} /> : null}
      {tab === "settings" ? <SupplySettingsTab /> : null}
      {tab === "review" ? <SupplyReview /> : null}
    </Page>
  );
}

function S6Strip({ d }: { d: ReorderList }) {
  const on = d.s6.state === "on";
  return (
    <div className={`mb-4 rounded-md px-3 py-2 text-sm ${on ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
      {on
        ? "S6 Low-stock alerts and warehouse orders is on. Suggestions can go on a draft. A draft only goes to the supplier when you press Send or Mark sent."
        : `S6 Low-stock alerts and warehouse orders is ${d.s6.state}. You can look, set products up and review. Nothing new can be drafted or sent. Orders already sent stay in purchasing, Suppliers owed and the cash forecast.`}
      {!d.canSeeCosts ? " Purchase prices are hidden for your login." : ""}
    </div>
  );
}

/* ------------------------------ reorder list ------------------------------ */

function ReorderTab({ d }: { d: ReorderList }) {
  const draft = useDraftSuggestions();
  const [msg, setMsg] = React.useState<Record<string, string>>({});
  if (!d.suppliers.length)
    return (
      <Card>
        <Empty>No product is set up for stock yet. Every product is still "Order for each job/sale". Set one up on the Supply settings tab.</Empty>
      </Card>
    );
  return (
    <div className="grid gap-4">
      {d.suppliers.map((s) => {
        const key = String(s.supplierId);
        const canSuggest = s.supplierId != null && s.products.some((p) => p.mode === "reorder" && p.state.suggestStock > 0 && p.state.needMore);
        return (
          <Card key={key}>
            <CardHeader
              title={s.supplierName}
              subtitle={s.draft ? `Draft ${s.draft.number} is open for this supplier. Suggestions are added to it, not to a new order.` : "No draft warehouse order for this supplier yet."}
              action={
                canSuggest ? (
                  <Button
                    size="sm"
                    disabled={draft.isPending || d.s6.state !== "on"}
                    onClick={async () => {
                      try {
                        const out = await draft.mutateAsync({ supplierId: s.supplierId! });
                        setMsg((m) => ({ ...m, [key]: out.po ? `Draft ${out.po.number}: ${out.changed.length ? out.changed.join("; ") : "already covers the suggestion"}. Not sent.` : "Nothing to add." }));
                      } catch (e) {
                        setMsg((m) => ({ ...m, [key]: errText(e) }));
                      }
                    }}
                  >
                    Put suggestions on the draft
                  </Button>
                ) : null
              }
            />
            {msg[key] ? <p className="mx-4 mb-2 rounded-md bg-muted px-3 py-2 text-sm">{msg[key]}</p> : null}
            <div className="divide-y divide-border">
              {s.products.map((p) => (
                <ProductRow key={p.id} p={p} s6On={d.s6.state === "on"} />
              ))}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ProductRow({ p, s6On }: { p: ReorderProduct; s6On: boolean }) {
  const n = p.numbers;
  const u = p.unit;
  const facts = [
    `On the shelf ${qty(n.physical)} ${u}`,
    `held ${qty(n.committed)}`,
    `available ${qty(n.available)}`,
    n.incomingJob > 0 ? `incoming for jobs ${qty(n.incomingJob)}` : "",
    n.incomingFree > 0 ? `incoming for general stock ${qty(n.incomingFree)}` : "",
    n.draftJob + n.draftFree > 0 ? `on a draft ${qty(n.draftJob + n.draftFree)} (proposed, not incoming)` : "",
  ].filter(Boolean);
  return (
    <div className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {p.name}
          {p.size ? <span className="font-normal text-muted-foreground"> · {p.size}</span> : null}
        </p>
        <span className="rounded-full border border-border px-2 py-0.5 text-xs">{p.modeLabel}</span>
      </div>
      <p className="mt-1 text-muted-foreground">
        {facts.join(" · ")}
        {p.reorderLevel != null ? ` · reorder level ${p.reorderLevel}` : ""}
        {p.leadTimeDays != null ? ` · lead time ${p.leadTimeDays} business days` : " · lead time unknown"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {p.state.lowNow ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Low stock now</span> : null}
        {p.state.needMore ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-900">Another order needed</span> : null}
        {p.state.lowNow && !p.state.needMore && p.mode === "reorder" ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-900">
            {n.draftJob + n.draftFree > 0 ? "Covered once the draft is sent" : "Covered by what is ordered"}
          </span>
        ) : null}
      </div>
      {p.state.text.map((t, i) => (
        <p key={i} className="mt-1">
          {t}
        </p>
      ))}
      {p.shortages.length ? (
        <div className="mt-2 grid gap-2">
          {p.shortages.map((s) => (
            <ShortageRow key={s.holdId} s={s} s6On={s6On} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ShortageRow({ s, s6On }: { s: ReorderShortage; s6On: boolean }) {
  const a = useToJobPo();
  const b = useToWarehouse();
  const rm = useRemoveLink();
  const [msg, setMsg] = React.useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await f();
      setMsg(ok);
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const busy = a.isPending || b.isPending || rm.isPending;
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p>
        <span className="font-medium">Job {s.jobNumber ?? s.jobId}</span>
        {s.jobTitle ? <span className="text-muted-foreground"> · {s.jobTitle}</span> : null} · short {s.qtyText}
      </p>
      <p className="text-muted-foreground">{s.routeText}</p>
      {s.lead ? <p className="mt-1 text-amber-800">{s.lead}</p> : null}
      {s.route === "choose" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => a.mutateAsync({ holdId: s.holdId }), "Put on a draft PO for this job. Not sent.")}>
            A: the job's own PO
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !s6On}
            title={s6On ? undefined : "S6 is off"}
            onClick={() => run(() => b.mutateAsync({ holdId: s.holdId }), "Added to the warehouse draft, kept for this job. Not sent.")}
          >
            B: add to the warehouse order
          </Button>
        </div>
      ) : null}
      {s.route === "on_warehouse" && s.link && s.link.poStatus === "draft" ? (
        <div className="mt-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => rm.mutateAsync({ linkId: s.link!.id }), "Taken off the warehouse draft. Choose again.")}>
            Take it off the warehouse draft
          </Button>
        </div>
      ) : null}
      {msg ? <p className="mt-1 text-xs">{msg}</p> : null}
    </div>
  );
}

/* ---------------------------- warehouse orders ---------------------------- */

function OrdersTab({ d }: { d: ReorderList }) {
  if (!d.orders.length)
    return (
      <Card>
        <Empty>No warehouse orders yet. They are numbered PO-W0001, PO-W0002 and so on, separate from job POs.</Empty>
      </Card>
    );
  return (
    <div className="grid gap-4">
      {d.orders.map((o) => (
        <OrderCard key={o.id} o={o} canSeeCosts={d.canSeeCosts} s6On={d.s6.state === "on"} />
      ))}
    </div>
  );
}

function OrderCard({ o, canSeeCosts, s6On }: { o: WarehouseOrder; canSeeCosts: boolean; s6On: boolean }) {
  const send = useSendPo();
  const mark = useMarkPoSent();
  const refresh = useRefreshAll();
  const [msg, setMsg] = React.useState<string | null>(null);
  const [how, setHow] = React.useState("phoned");
  const draft = o.status === "draft";
  const goods = o.lines.filter((l) => l.kind === "goods");
  const outstanding = goods.some((l) => !l.closedAt && l.qty - l.receivedQty > 0.0001);

  async function act(f: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await f();
      refresh();
      setMsg(ok);
    } catch (e) {
      setMsg(errText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title={`${o.number} · ${o.supplierName}`}
        subtitle={`${STATUS[o.status] ?? o.status}${o.sentAt ? `, sent ${auDate(o.sentAt)}${o.sentVia ? ` (${o.sentVia === "email" ? "emailed" : (o.sentTo ?? "marked sent")})` : ""}` : ""}. Delivered to the warehouse.`}
        action={
          canSeeCosts && o.totalExGst != null ? <span className="text-sm font-medium">{money(o.totalExGst)} ex GST</span> : null
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Line</th>
              <th className="px-4 py-2 text-right">Ordered</th>
              <th className="px-4 py-2 text-right">Received</th>
              <th className="px-4 py-2">For</th>
              {canSeeCosts ? <th className="px-4 py-2 text-right">Unit ex GST</th> : null}
              <th className="px-4 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {o.lines.map((l) => (
              <LineRow key={l.id} l={l} poId={o.id} draft={draft} canSeeCosts={canSeeCosts} />
            ))}
          </tbody>
        </table>
      </div>
      <Terms o={o} canSeeCosts={canSeeCosts} />
      {o.bills.length ? (
        <div className="border-t border-border px-4 py-3 text-sm">
          <p className="label-xs mb-1">Supplier bills matched</p>
          {o.bills.map((b) => (
            <p key={b.id}>
              {b.invoiceNumber || "Bill"} · {b.payState}
              {canSeeCosts && b.totalIncGst != null ? ` · ${money(b.totalIncGst)} inc GST` : ""}
              {b.dueDate ? ` · due ${auDate(b.dueDate)}` : ""}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {draft ? (
          <>
            <Button
              size="sm"
              disabled={!s6On || send.isPending || !o.supplierHasEmail}
              title={!o.supplierHasEmail ? "No email on file for this supplier" : !s6On ? "S6 is off" : undefined}
              onClick={() => {
                if (!window.confirm(`Email ${o.number} to ${o.supplierName} now? The PDF goes from team@.`)) return;
                act(() => send.mutateAsync({ id: o.id }), `${o.number} emailed. It is now in the cash forecast and Suppliers owed.`);
              }}
            >
              Send to supplier
            </Button>
            <Input className="h-8 w-40" value={how} onChange={(e) => setHow(e.target.value)} aria-label="How it was sent" />
            <Button
              size="sm"
              variant="outline"
              disabled={!s6On || mark.isPending}
              onClick={() => {
                if (!window.confirm(`Mark ${o.number} as sent (${how})? No email goes.`)) return;
                act(() => mark.mutateAsync({ id: o.id, how: how || "phoned" }), `${o.number} marked sent. It is now in the cash forecast and Suppliers owed.`);
              }}
            >
              Mark sent
            </Button>
          </>
        ) : outstanding ? (
          <Link href={`/stock?tab=receive`} className="text-sm text-primary underline-offset-2 hover:underline">
            Receive it on the Receive tab ({o.number})
          </Link>
        ) : null}
        {msg ? <span className="text-sm">{msg}</span> : null}
      </div>
    </Card>
  );
}

function LineRow({ l, poId, draft, canSeeCosts }: { l: WarehouseOrder["lines"][number]; poId: number; draft: boolean; canSeeCosts: boolean }) {
  const edit = useEditDraftLine();
  const close = useCloseLine();
  const [general, setGeneral] = React.useState(String(l.generalQty));
  const [cost, setCost] = React.useState(l.unitCostExGst != null ? String(l.unitCostExGst) : "");
  const [note, setNote] = React.useState("");
  const [closing, setClosing] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const uid = React.useId();
  const goods = l.kind === "goods";
  const left = Math.max(0, l.qty - l.receivedQty);

  return (
    <tr className={l.closedAt ? "text-muted-foreground" : ""}>
      <td className="px-4 py-2">
        {l.description}
        {l.closedAt ? <span className="block text-xs">Closed: {l.closedNote}</span> : null}
      </td>
      <td className="px-4 py-2 text-right">
        {qty(l.qty)} {l.unitText}
      </td>
      <td className="px-4 py-2 text-right">{goods ? `${qty(l.receivedQty)}` : ""}</td>
      <td className="px-4 py-2">{goods ? (l.split ?? `${qty(l.qty)} ${l.unitText} for general warehouse stock`) : ""}</td>
      {canSeeCosts ? <td className="px-4 py-2 text-right">{money(l.unitCostExGst)}</td> : null}
      <td className="px-4 py-2">
        {goods && draft && l.productId != null ? (
          <div className="flex flex-wrap items-center gap-1">
            <label htmlFor={`${uid}-gen`} className="text-xs text-muted-foreground">
              General stock
            </label>
            <Input id={`${uid}-gen`} className="h-7 w-20" value={general} onChange={(e) => setGeneral(e.target.value)} />
            {canSeeCosts ? (
              <>
                <label htmlFor={`${uid}-cost`} className="text-xs text-muted-foreground">
                  Unit $ ex GST
                </label>
                <Input id={`${uid}-cost`} className="h-7 w-20" value={cost} onChange={(e) => setCost(e.target.value)} />
              </>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={edit.isPending}
              onClick={async () => {
                setMsg(null);
                try {
                  await edit.mutateAsync({ poId, productId: l.productId!, generalQty: Number(general), unitCostExGst: canSeeCosts && cost ? Number(cost) : undefined });
                  setMsg("Saved. Job shares are not changed.");
                } catch (e) {
                  setMsg(errText(e));
                }
              }}
            >
              Save general qty
            </Button>
          </div>
        ) : goods && !draft && !l.closedAt && left > 0.0001 ? (
          closing ? (
            <div className="flex flex-wrap items-center gap-1">
              <Input className="h-7 w-56" placeholder="Why (supplier cannot supply…)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button
                size="sm"
                variant="outline"
                disabled={close.isPending}
                onClick={async () => {
                  setMsg(null);
                  try {
                    await close.mutateAsync({ lineId: l.id, note });
                    setMsg("Closed. The rest no longer counts as incoming.");
                    setClosing(false);
                  } catch (e) {
                    setMsg(errText(e));
                  }
                }}
              >
                Close {qty(left)} not coming
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
              Close the rest…
            </Button>
          )
        ) : null}
        {msg ? <span className="block text-xs">{msg}</span> : null}
      </td>
    </tr>
  );
}

function Terms({ o, canSeeCosts }: { o: WarehouseOrder; canSeeCosts: boolean }) {
  const save = useEditTerms();
  const [freight, setFreight] = React.useState(o.freightExGst != null ? String(o.freightExGst) : "");
  const [pay, setPay] = React.useState(o.expectedPayDate ?? "");
  const [dep, setDep] = React.useState(o.supplierDepositExGst != null ? String(o.supplierDepositExGst) : "");
  const [depDue, setDepDue] = React.useState(o.supplierDepositDue ?? "");
  const [notes, setNotes] = React.useState(o.notes ?? "");
  const [msg, setMsg] = React.useState<string | null>(null);
  const uid = React.useId();
  if (!canSeeCosts) return null;
  const open = o.status === "draft" || o.status === "sent";
  return (
    <div className="grid gap-2 border-t border-border px-4 py-3 text-sm">
      <p className="label-xs">For the cash forecast</p>
      <p className="text-muted-foreground">
        {o.status === "draft"
          ? "A draft shows as a planned purchase, not committed."
          : "Sent, so it counts in the forecast. That is not the day the money goes out."}{" "}
        The date used is the expected payment date below, else the supplier's terms. With neither it is flagged, not guessed.
      </p>
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="grid gap-1" htmlFor={`${uid}-freight`}>
          <span className="text-xs text-muted-foreground">Freight ex GST</span>
          <Input id={`${uid}-freight`} className="h-8" value={freight} onChange={(e) => setFreight(e.target.value)} disabled={o.status !== "draft"} />
        </label>
        <label className="grid gap-1" htmlFor={`${uid}-pay`}>
          <span className="text-xs text-muted-foreground">Expected payment date</span>
          <Input id={`${uid}-pay`} className="h-8" type="date" value={pay} onChange={(e) => setPay(e.target.value)} disabled={!open} />
        </label>
        <label className="grid gap-1" htmlFor={`${uid}-dep`}>
          <span className="text-xs text-muted-foreground">Supplier deposit ex GST</span>
          <Input id={`${uid}-dep`} className="h-8" value={dep} onChange={(e) => setDep(e.target.value)} disabled={!open} />
        </label>
        <label className="grid gap-1" htmlFor={`${uid}-depDue`}>
          <span className="text-xs text-muted-foreground">Deposit due</span>
          <Input id={`${uid}-depDue`} className="h-8" type="date" value={depDue} onChange={(e) => setDepDue(e.target.value)} disabled={!open} />
        </label>
      </div>
      <Textarea rows={2} placeholder="Notes on the PO" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={o.status !== "draft"} />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!open || save.isPending}
          onClick={async () => {
            setMsg(null);
            try {
              await save.mutateAsync({
                poId: o.id,
                freightExGst: o.status === "draft" ? (freight ? Number(freight) : null) : undefined,
                expectedPayDate: pay || "",
                supplierDepositExGst: dep ? Number(dep) : null,
                supplierDepositDue: depDue || "",
                notes: o.status === "draft" ? notes : undefined,
              });
              setMsg("Saved.");
            } catch (e) {
              setMsg(errText(e));
            }
          }}
        >
          Save terms
        </Button>
        {o.supplierDepositExGst ? (
          <span className="text-muted-foreground">
            Deposit {money(o.supplierDepositExGst)} and balance {money(Math.max(0, (o.totalExGst ?? 0) - o.supplierDepositExGst))} show separately in the forecast.
          </span>
        ) : null}
        {msg ? <span>{msg}</span> : null}
      </div>
    </div>
  );
}
