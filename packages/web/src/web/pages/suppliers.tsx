import * as React from "react";
import { useSearch } from "wouter";
import { AlertTriangle, Calculator, ChevronDown, ChevronUp, Fuel, Mail, Pencil, Plus, Trash2, Truck } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useCreateSupplier,
  useCreateSupplierFee,
  useDeleteSupplierFee,
  useSupplier,
  useSupplierOrderCost,
  useSuppliers,
  useUpdateSupplier,
  useUpdateSupplierFee,
} from "../queries/suppliers";

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

/**
 * What a charge is charged PER. Every supplier words this differently, so the
 * list has to cover all of them: Terramater charge fuel as a percentage,
 * Chaparral charge it at $2.00 a lineal metre.
 */
const BASIS_LABEL: Record<string, string> = {
  percent_of_order: "% of the goods",
  m2: "per m²",
  lm: "per lineal metre",
  box: "per box",
  roll: "per roll",
  each: "per item / length",
  order: "flat, per order",
  shipment: "per shipment",
  pallet: "per pallet",
  week: "per pallet / week",
};

/** Short form for a rate under an input, e.g. "$2.00 /lm". */
const BASIS_SHORT: Record<string, string> = {
  percent_of_order: "%",
  m2: "/m²",
  lm: "/lm",
  box: "/box",
  roll: "/roll",
  each: "/item",
  order: "/order",
  shipment: "/shipment",
  pallet: "/pallet",
  week: "/pallet/wk",
};

const KIND_LABEL: Record<string, string> = {
  fuel: "fuel surcharge",
  delivery: "delivery / freight",
  handling: "handling",
  baling: "baling / packing",
  storage: "storage",
  cutting: "cutting",
  premium: "premium",
  levy: "levy (Resiloop etc)",
  reschedule: "reschedule",
  credit: "credit",
  other: "other",
};

const KINDS = [
  "fuel",
  "delivery",
  "handling",
  "baling",
  "storage",
  "cutting",
  "premium",
  "levy",
  "reschedule",
  "credit",
  "other",
];
const BASES = ["percent_of_order", "m2", "lm", "box", "roll", "each", "order", "shipment", "pallet", "week"];

/** How a charge's dated window reads on the card. No end = until further notice. */
function windowLabel(from: string | null | undefined, until: string | null | undefined) {
  const pretty = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  if (!from && !until) return "No dates recorded";
  if (from && !until) return `From ${pretty(from)}, until further notice`;
  if (!from && until) return `Until ${pretty(until)}`;
  return `${pretty(from as string)} to ${pretty(until as string)}`;
}

/** true once today is past the charge's end date — it should not be costing. */
function windowLapsed(until: string | null | undefined) {
  if (!until) return false;
  return until < new Date().toISOString().slice(0, 10);
}

function dateInput(value: Date | string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

function listAge(value: Date | string | null | undefined) {
  if (!value) return { tone: "#D08A1E", label: "no date recorded" };
  const d = new Date(value);
  const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  const printed = d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  if (months >= 12) return { tone: "#B4342A", label: `${printed} · over a year old` };
  if (months >= 6) return { tone: "#D08A1E", label: `${printed} · ${Math.round(months)} months old` };
  return { tone: "#3F7D3A", label: printed };
}

/* ------------------------------ new supplier ------------------------------ */

function NewSupplierModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateSupplier();
  const blank = { name: "", code: "", shipsFrom: "", email: "", phone: "", accountNumber: "", notes: "" };
  const [form, setForm] = React.useState(blank);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        name: form.name,
        code: form.code || form.name,
        shipsFrom: form.shipsFrom || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
        accountNumber: form.accountNumber.trim() || undefined,
        notes: form.notes,
      });
      setForm(blank);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that supplier");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a supplier"
      subtitle="Cost prices, surcharges and freight all hang off this record."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.name.trim() || create.isPending}>
            Save supplier
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Supplier name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Terramater" />
        </Field>
        <Field label="Order email" hint="Purchase orders are emailed here.">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="orders@supplier.com.au" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </Field>
          <Field label="Our account number" hint="Printed on every PO.">
            <Input value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} />
          </Field>
        </div>
        <Field label="Short code" hint="Used on price-list imports. Leave blank to use the name.">
          <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="terramater" />
        </Field>
        <Field label="Ships from" hint="Decides the freight charge — e.g. South Australia.">
          <Input value={form.shipsFrom} onChange={(e) => setForm({ ...form, shipsFrom: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------- new fee --------------------------------- */

function NewFeeModal({ supplierId, open, onClose }: { supplierId: number; open: boolean; onClose: () => void }) {
  const create = useCreateSupplierFee();
  const [form, setForm] = React.useState({
    name: "",
    kind: "fuel",
    basis: "lm",
    amount: "",
    percent: "",
    amountIncludesGst: false,
    isCredit: false,
    autoApply: true,
    effectiveFrom: "",
    /** Left blank on purpose: blank means until further notice. */
    effectiveUntil: "",
    condition: "",
    notes: "",
  });

  const isPercent = form.basis === "percent_of_order";

  async function submit() {
    await create.mutateAsync({
      supplierId,
      name: form.name,
      kind: form.kind as "fuel",
      basis: form.basis as "lm",
      amount: isPercent ? null : Number(form.amount || 0),
      percent: isPercent ? Number(form.percent || 0) : null,
      amountIncludesGst: form.amountIncludesGst,
      isCredit: form.isCredit,
      autoApply: form.autoApply,
      effectiveFrom: form.effectiveFrom || null,
      effectiveUntil: form.effectiveUntil || null,
      condition: form.condition,
      notes: form.notes,
      sortOrder: 0,
    });
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a supplier charge"
      subtitle="Charged per supplier order — not per line on the quote. A supplier can run several of these at once."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.name.trim() || create.isPending}>
            Save charge
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="What the supplier calls it">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fuel Surcharge" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Charge type" hint="What the amount is charged per.">
            <Select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value })}>
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {BASIS_LABEL[b]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {isPercent ? (
          <Field label="Percentage" hint="Read off the goods total, never off the other charges.">
            <Input
              type="number"
              step="0.1"
              value={form.percent}
              onChange={(e) => setForm({ ...form, percent: e.target.value })}
              placeholder="15"
            />
          </Field>
        ) : (
          <Field label={`Amount ${BASIS_SHORT[form.basis] ?? ""}`} hint="Ex GST, unless you tick the box below.">
            <Input
              type="number"
              step="0.01"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              placeholder="2.00"
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective from" hint="The date on their letter or price list.">
            <Input
              type="date"
              value={form.effectiveFrom}
              onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })}
            />
          </Field>
          <Field label="Effective until" hint="Leave blank for until further notice.">
            <Input
              type="date"
              value={form.effectiveUntil}
              onChange={(e) => setForm({ ...form, effectiveUntil: e.target.value })}
            />
          </Field>
        </div>
        <Field label="When it applies" hint="Plain English — this is what shows next to the tickbox on an order.">
          <Input value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} />
        </Field>
        <Field label="Notes" hint="What their letter or price list actually said.">
          <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
        <div className="space-y-2 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
          <label htmlFor="fee_auto_apply" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="fee_auto_apply"
              checked={form.autoApply}
              onChange={(e) => setForm({ ...form, autoApply: e.target.checked })}
            />
            Add to every order automatically
          </label>
          <label htmlFor="fee_inc_gst" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="fee_inc_gst"
              checked={form.amountIncludesGst}
              onChange={(e) => setForm({ ...form, amountIncludesGst: e.target.checked })}
              disabled={isPercent}
            />
            The amount above already includes GST
          </label>
          <label htmlFor="fee_is_credit" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="fee_is_credit"
              checked={form.isCredit}
              onChange={(e) => setForm({ ...form, isCredit: e.target.checked })}
            />
            This is a credit back, not a charge
          </label>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------- freight card ----------------------------- */

/**
 * How stock actually reaches Terra, and whether the supplier's own delivery
 * charge is Terra's cost at all.
 *
 * This replaced a fuel-surcharge card that could only edit one percentage.
 * A fuel surcharge is now just another row under "their charges", because
 * Chaparral charge theirs per lineal metre and run a baling charge beside it.
 */
function FreightCard({
  supplier,
}: {
  supplier: {
    id: number;
    name: string;
    deliversDirect: boolean;
    freightMethod: string;
    freightNote: string;
  };
}) {
  const update = useUpdateSupplier();

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Truck className="size-4 text-[var(--gold)]" />
            How it gets here
          </span>
        }
        subtitle="Whether they deliver decides whether their delivery charge is ever our cost."
        action={
          supplier.deliversDirect ? (
            <Badge colour="#3F7D3A">delivers to us</Badge>
          ) : (
            <Badge colour="#D08A1E">on-forwarded</Badge>
          )
        }
      />
      <div className="space-y-3 px-4 py-3.5">
        <label className="flex items-start gap-2.5 text-sm font-medium">
          <Checkbox
            className="mt-0.5"
            checked={supplier.deliversDirect}
            onChange={(e) => update.mutate({ id: supplier.id, deliversDirect: e.target.checked })}
          />
          <span>
            {supplier.name} delivers direct to us
            <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
              Untick it and any delivery charge on their schedule is kept on file but never costed — the carrier
              invoices us for that leg instead, so costing both would bill the same freight twice.
            </span>
          </span>
        </label>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Comes to us via" hint="The carrier or on-forwarder, where it is not the supplier.">
            <Input
              defaultValue={supplier.freightMethod}
              placeholder="Jocks Transport / on-forwarder"
              onBlur={(e) => update.mutate({ id: supplier.id, freightMethod: e.target.value })}
            />
          </Field>
          <Field label="Who pays, and how" hint="Plain English. Shows on the supplier card.">
            <Input
              defaultValue={supplier.freightNote}
              placeholder="Terra arranges and pays the carrier separately"
              onBlur={(e) => update.mutate({ id: supplier.id, freightNote: e.target.value })}
            />
          </Field>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------ contact card ------------------------------ */

/**
 * Who we order from and where POs go. The PO email box and the PO PDF read
 * these: email is where a PO is sent, account number prints on every PO.
 */
function ContactCard({
  supplier,
}: {
  supplier: {
    id: number;
    name: string;
    email: string | null;
    phone: string | null;
    accountNumber: string | null;
    shipsFrom: string | null;
    active: boolean;
  };
}) {
  const update = useUpdateSupplier();
  const [saved, setSaved] = React.useState<string | null>(null);
  type Patch = { name?: string; email?: string | null; phone?: string | null; accountNumber?: string | null; active?: boolean };
  const save = (patch: Patch, label: string) =>
    update.mutate(
      { id: supplier.id, ...patch },
      { onSuccess: () => setSaved(`${label} saved`), onError: (e) => setSaved(e instanceof Error ? e.message : "Could not save") },
    );

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Mail className="size-4 text-[var(--gold)]" />
            {supplier.name}
          </span>
        }
        subtitle={supplier.shipsFrom ? `Ships from ${supplier.shipsFrom}` : "Contact and ordering details"}
        action={
          supplier.email ? (
            <Badge colour="#3F7D3A">POs go to {supplier.email}</Badge>
          ) : (
            <Badge colour="#D08A1E">no order email yet</Badge>
          )
        }
      />
      <div className="grid gap-3 px-4 py-3.5 md:grid-cols-2">
        <Field label="Supplier name">
          <Input
            defaultValue={supplier.name}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== supplier.name) save({ name: v }, "Name");
            }}
          />
        </Field>
        <Field label="Order email" hint="Purchase orders are emailed here.">
          <Input
            type="email"
            defaultValue={supplier.email ?? ""}
            placeholder="orders@supplier.com.au"
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== (supplier.email ?? null)) save({ email: v }, "Order email");
            }}
          />
        </Field>
        <Field label="Phone">
          <Input
            defaultValue={supplier.phone ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== (supplier.phone ?? null)) save({ phone: v }, "Phone");
            }}
          />
        </Field>
        <Field label="Our account number" hint="Printed on every PO.">
          <Input
            defaultValue={supplier.accountNumber ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== (supplier.accountNumber ?? null)) save({ accountNumber: v }, "Account number");
            }}
          />
        </Field>
        <label htmlFor={`sup_active_${supplier.id}`} className="flex items-center gap-2 text-sm md:col-span-2">
          <Checkbox
            id={`sup_active_${supplier.id}`}
            checked={supplier.active}
            onChange={(e) => save({ active: e.target.checked }, e.target.checked ? "Active" : "Hidden")}
          />
          Still buying from them
          <span className="text-xs text-muted-foreground">Untick to hide them from supplier pick lists.</span>
        </label>
        {saved ? <p className="text-xs text-muted-foreground md:col-span-2">{saved}</p> : null}
      </div>
    </Card>
  );
}

/** Long text folded to two lines, with a toggle to read the rest. */
function ClampText({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const long = text.length > 160;
  return (
    <div className={className}>
      <p className={`whitespace-pre-line text-muted-foreground ${open || !long ? "" : "line-clamp-2"}`}>{text}</p>
      {long ? (
        <button type="button" className="mt-0.5 font-medium text-[var(--gold)] hover:underline" onClick={() => setOpen((o) => !o)}>
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/** Long price list notes, folded to two lines until opened. Editable. */
function SupplierNotes({ supplierId, notes }: { supplierId: number; notes: string }) {
  const update = useUpdateSupplier();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(notes);

  if (editing) {
    return (
      <div className="space-y-2 md:col-span-2">
        <Field label="Notes">
          <Textarea rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setDraft(notes); setEditing(false); }}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ id: supplierId, notes: draft }, { onSuccess: () => setEditing(false) })}
          >
            Save notes
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md bg-secondary/50 px-3 py-2 md:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <p className="label-xs">Notes</p>
        <div className="flex gap-1">
          {notes.length > 160 ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronUp /> : <ChevronDown />} {open ? "Show less" : "Show all"}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => { setDraft(notes); setEditing(true); }}>
            <Pencil /> {notes ? "Edit" : "Add notes"}
          </Button>
        </div>
      </div>
      {notes ? (
        <p className={`mt-1 whitespace-pre-line text-xs text-muted-foreground ${open ? "" : "line-clamp-2"}`}>{notes}</p>
      ) : null}
    </div>
  );
}

/* ----------------------------- order cost check --------------------------- */

/**
 * The breakdown Damien asked for, live:
 *
 *   base material + supplier surcharge(s) + baling/packing + transport
 *     = true material cost ex GST
 *
 * Every charge keeps its own line and its own maths, so he can see what a
 * supplier is adding and argue with them about it. The quantity boxes are the
 * order measured in every unit a charge might be quoted per — a supplier who
 * charges per lineal metre never reads the pallet count.
 */
function OrderCostCard({
  supplierId,
  supplierName,
  fees,
}: {
  supplierId: number;
  supplierName: string;
  fees: Array<{ id: number; name: string; autoApply: boolean; active: boolean }>;
}) {
  // Closed by default: it is a what-if calculator, not something to fill in.
  const [open, setOpen] = React.useState(false);
  const [goods, setGoods] = React.useState("");
  const [m2, setM2] = React.useState("0");
  const [lm, setLm] = React.useState("0");
  const [boxes, setBoxes] = React.useState("0");
  const [rolls, setRolls] = React.useState("0");
  const [items, setItems] = React.useState("0");
  const [pallets, setPallets] = React.useState("1");
  const [shipments, setShipments] = React.useState("1");
  const [weeks, setWeeks] = React.useState("0");
  const [transport, setTransport] = React.useState("0");
  const [ticked, setTicked] = React.useState<number[]>([]);

  const optional = fees.filter((f) => f.active && !f.autoApply);
  const cost = useSupplierOrderCost({
    supplierId,
    goodsExGst: Number(goods || 0),
    m2: Number(m2 || 0),
    lm: Number(lm || 0),
    boxes: Number(boxes || 0),
    rolls: Number(rolls || 0),
    items: Number(items || 0),
    pallets: Number(pallets || 0),
    shipments: Number(shipments || 0),
    weeksStored: Number(weeks || 0),
    transportExGst: Number(transport || 0),
    feeIds: ticked,
  });

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Calculator className="size-4 text-[var(--gold)]" />
            Order cost check
          </span>
        }
        subtitle={`A calculator only, nothing is saved. Type in an order to see what ${supplierName} really charge once their fuel, baling and freight are added on top of the product price.`}
        action={
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronUp /> : <ChevronDown />} {open ? "Close" : "Open"}
          </Button>
        }
      />
      {open ? (
      <div className="grid gap-4 px-4 py-3.5 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Product total on the order (ex GST)" hint="What the flooring itself costs at their roll or cut rate, e.g. 2000.">
            <Input type="number" value={goods} placeholder="2000" onChange={(e) => setGoods(e.target.value)} />
          </Field>
          <div>
            <p className="label-xs mb-1.5">How much is on the order</p>
            <div className="grid grid-cols-3 gap-2">
              <Field label="m²">
                <Input type="number" className="h-8" value={m2} onChange={(e) => setM2(e.target.value)} />
              </Field>
              <Field label="Lineal m">
                <Input type="number" className="h-8" value={lm} onChange={(e) => setLm(e.target.value)} />
              </Field>
              <Field label="Rolls">
                <Input type="number" className="h-8" value={rolls} onChange={(e) => setRolls(e.target.value)} />
              </Field>
              <Field label="Boxes">
                <Input type="number" className="h-8" value={boxes} onChange={(e) => setBoxes(e.target.value)} />
              </Field>
              <Field label="Items">
                <Input type="number" className="h-8" value={items} onChange={(e) => setItems(e.target.value)} />
              </Field>
              <Field label="Pallets">
                <Input type="number" className="h-8" value={pallets} onChange={(e) => setPallets(e.target.value)} />
              </Field>
              <Field label="Shipments">
                <Input type="number" className="h-8" value={shipments} onChange={(e) => setShipments(e.target.value)} />
              </Field>
              <Field label="Weeks stored">
                <Input type="number" className="h-8" value={weeks} onChange={(e) => setWeeks(e.target.value)} />
              </Field>
              <Field label="Our transport $">
                <Input type="number" className="h-8" value={transport} onChange={(e) => setTransport(e.target.value)} />
              </Field>
            </div>
          </div>
          {optional.length ? (
            <div className="space-y-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
              <p className="label-xs">Tick any that apply to this order</p>
              {optional.map((f) => (
                <label key={f.id} className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    checked={ticked.includes(f.id)}
                    onChange={(e) =>
                      setTicked((t) => (e.target.checked ? [...t, f.id] : t.filter((x) => x !== f.id)))
                    }
                  />
                  {f.name}
                </label>
              ))}
            </div>
          ) : null}
        </div>

        <div className="rounded-md border border-border bg-card px-3.5 py-3">
          {cost.isPending ? (
            <Loading label="Working it out…" />
          ) : cost.data ? (
            <div className="space-y-1.5 text-[13px]">
              {cost.data.priceListWarning ? (
                <p className="mb-2 flex items-start gap-1.5 rounded-md bg-[#B4342A1A] px-2 py-1.5 text-xs text-destructive">
                  <AlertTriangle className="mt-[1px] size-3.5 shrink-0" />
                  {cost.data.priceListWarning}
                </p>
              ) : null}
              <Row label="Base material" value={money(cost.data.goodsExGst)} />
              {cost.data.charges.map((c) => (
                <div key={c.id}>
                  <Row label={c.name} value={money(c.exGst)} />
                  <p className="text-[11px] text-muted-foreground">{c.note}</p>
                </div>
              ))}
              {cost.data.transportExGst > 0 ? (
                <Row label="Our transport" value={money(cost.data.transportExGst)} />
              ) : null}
              <div className="my-1.5 h-px bg-border" />
              <Row label="True material cost ex GST" value={money(cost.data.totalExGst)} strong />
              <Row label="GST" value={money(cost.data.gst)} muted />
              <Row label="Total inc GST" value={money(cost.data.totalIncGst)} strong />
              {cost.data.excludedCharges.length ? (
                <div className="mt-2.5 space-y-1 rounded-md bg-secondary/50 px-2.5 py-2">
                  <p className="label-xs">On file, deliberately not costed</p>
                  {cost.data.excludedCharges.map((x) => (
                    <p key={x.id} className="text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">{x.name}</span> — {x.reason}
                    </p>
                  ))}
                </div>
              ) : null}
              <p className="mt-2 text-[11px] text-muted-foreground">{cost.data.note}</p>
            </div>
          ) : (
            <Empty>Enter a product total.</Empty>
          )}
        </div>
      </div>
      ) : null}
    </Card>
  );
}

function Row({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={muted ? "text-muted-foreground" : strong ? "font-semibold" : ""}>{label}</span>
      <span className={`tabular ${strong ? "font-semibold" : muted ? "text-muted-foreground" : ""}`}>{value}</span>
    </div>
  );
}

/* --------------------------------- page ---------------------------------- */

export default function SuppliersPage() {
  const list = useSuppliers(true);
  // ?id=12 opens that supplier, e.g. from Suppliers owed.
  const wanted = Number(new URLSearchParams(useSearch()).get("id")) || null;
  const [selectedId, setSelectedId] = React.useState<number | null>(wanted);
  const [newOpen, setNewOpen] = React.useState(false);
  const [newFeeOpen, setNewFeeOpen] = React.useState(false);

  const currentId = selectedId ?? list.data?.[0]?.id ?? null;
  const detail = useSupplier(currentId);
  const update = useUpdateSupplier();
  const feeUpdate = useUpdateSupplierFee();
  const feeDelete = useDeleteSupplierFee();

  const supplier = detail.data?.supplier;
  const fees = (detail.data?.fees ?? []).filter((f) => f.active);

  return (
    <Page
      title="Suppliers"
      subtitle="Cost lists, surcharges and freight — every charge that sits on top of the per-m² rate."
      actions={
        <Button onClick={() => setNewOpen(true)}>
          <Plus /> Add supplier
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit">
          <CardHeader title="Who we buy from" subtitle={`${list.data?.length ?? 0} on file`} />
          {list.isPending ? (
            <Loading />
          ) : !list.data?.length ? (
            <Empty>No suppliers yet.</Empty>
          ) : (
            <div className="p-1.5">
              {list.data.map((sup) => {
                const active = sup.id === currentId;
                return (
                  <button
                    key={sup.id}
                    type="button"
                    onClick={() => setSelectedId(sup.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${
                      active ? "bg-secondary font-medium" : "hover:bg-secondary/60"
                    }`}
                  >
                    <span className="truncate">{sup.name}</span>
                    {sup.deliversDirect ? null : <Badge colour="#D08A1E">on-fwd</Badge>}
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {sup.feeCount} {sup.feeCount === 1 ? "charge" : "charges"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          {detail.isPending || !supplier ? (
            <Card>
              <Loading />
            </Card>
          ) : (
            <React.Fragment key={supplier.id}>
              <ContactCard supplier={supplier} />
              <Card>
                <CardHeader
                  title="Price list"
                  subtitle="The dates and source of their cost list."
                  action={
                    <Badge colour={listAge(supplier.priceListEffectiveFrom).tone}>
                      Price list: {listAge(supplier.priceListEffectiveFrom).label}
                    </Badge>
                  }
                />
                <div className="grid gap-3 px-4 py-3.5 md:grid-cols-2">
                  <Field label="Price list dated" hint="The date printed on their list — not the day it was imported.">
                    <Input
                      type="date"
                      defaultValue={dateInput(supplier.priceListEffectiveFrom)}
                      onBlur={(e) =>
                        update.mutate({ id: supplier.id, priceListEffectiveFrom: e.target.value || null })
                      }
                    />
                  </Field>
                  <Field label="Prices expire" hint="Where they state one. Quoting warns past this date.">
                    <Input
                      type="date"
                      defaultValue={dateInput(supplier.priceListValidUntil)}
                      onBlur={(e) => update.mutate({ id: supplier.id, priceListValidUntil: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Ships from">
                    <Input
                      defaultValue={supplier.shipsFrom ?? ""}
                      onBlur={(e) => update.mutate({ id: supplier.id, shipsFrom: e.target.value || null })}
                    />
                  </Field>
                  <Field label="Source document" hint="Kept as evidence if a price is ever disputed.">
                    <Input
                      defaultValue={supplier.priceListSource}
                      onBlur={(e) => update.mutate({ id: supplier.id, priceListSource: e.target.value })}
                    />
                  </Field>
                  <label className="flex items-start gap-2 text-sm md:col-span-2">
                    <Checkbox
                      className="mt-0.5"
                      checked={supplier.dealerPricingEligible}
                      onChange={(e) => update.mutate({ id: supplier.id, dealerPricingEligible: e.target.checked })}
                    />
                    <span>
                      We qualify for their dealer / display-stand price
                      {supplier.dealerPricingNote ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">{supplier.dealerPricingNote}</span>
                      ) : null}
                    </span>
                  </label>
                  <SupplierNotes supplierId={supplier.id} notes={supplier.notes} />
                </div>
              </Card>

              <FreightCard supplier={supplier} />

              <Card>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      <Fuel className="size-4 text-[var(--gold)]" />
                      Their charges
                    </span>
                  }
                  subtitle="Fuel, baling, freight. As many as they run at once, each on its own basis. Never baked into a product price."
                  action={
                    <Button size="sm" variant="outline" onClick={() => setNewFeeOpen(true)}>
                      <Plus /> Add charge
                    </Button>
                  }
                />
                {!fees.length ? (
                  <Empty>No charges recorded for {supplier.name}.</Empty>
                ) : (
                  <div className="divide-y divide-border">
                    {fees.map((f) => (
                      <div key={f.id} className="flex items-start gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-[13.5px] font-medium">{f.name}</p>
                            <Badge>{KIND_LABEL[f.kind] ?? f.kind}</Badge>
                            {f.isCredit ? <Badge colour="#3F7D3A">credit</Badge> : null}
                            {f.autoApply ? <Badge colour="#4A7FA5">every order</Badge> : <Badge>optional</Badge>}
                            {windowLapsed(f.effectiveUntil) ? <Badge colour="#B4342A">lapsed</Badge> : null}
                          </div>
                          {f.condition ? <ClampText text={f.condition} className="mt-0.5 text-xs" /> : null}
                          {/* Blank end date reads as "until further notice", not as forever. */}
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {windowLabel(f.effectiveFrom, f.effectiveUntil)}
                          </p>
                          <div className="mt-1.5 grid max-w-[320px] grid-cols-2 gap-2">
                            <Field label="From">
                              <Input
                                type="date"
                                className="h-8"
                                defaultValue={f.effectiveFrom ?? ""}
                                onBlur={(e) => feeUpdate.mutate({ id: f.id, effectiveFrom: e.target.value || null })}
                              />
                            </Field>
                            <Field label="Until">
                              <Input
                                type="date"
                                className="h-8"
                                defaultValue={f.effectiveUntil ?? ""}
                                onBlur={(e) => feeUpdate.mutate({ id: f.id, effectiveUntil: e.target.value || null })}
                              />
                            </Field>
                          </div>
                          {f.notes ? <ClampText text={f.notes} className="mt-1.5 text-[11px]" /> : null}
                        </div>
                        <div className="w-[130px] shrink-0">
                          {f.basis === "percent_of_order" ? (
                            <Input
                              type="number"
                              step="0.1"
                              className="h-8 text-right"
                              defaultValue={f.percent ?? 0}
                              onBlur={(e) => feeUpdate.mutate({ id: f.id, percent: Number(e.target.value || 0) })}
                            />
                          ) : (
                            <Input
                              type="number"
                              step="0.01"
                              className="h-8 text-right"
                              defaultValue={f.amount ?? 0}
                              onBlur={(e) => feeUpdate.mutate({ id: f.id, amount: Number(e.target.value || 0) })}
                            />
                          )}
                          <p className="mt-1 text-right text-[11px] text-muted-foreground">
                            {f.basis === "percent_of_order" && f.percentBase === "goods_and_charges" ? "% of goods and charges" : BASIS_LABEL[f.basis]}
                            {f.amountIncludesGst ? " · inc GST" : ""}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => feeDelete.mutate({ id: f.id })}
                          title="Remove charge"
                        >
                          <Trash2 className="text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <OrderCostCard supplierId={supplier.id} supplierName={supplier.name} fees={detail.data?.fees ?? []} />
              <NewFeeModal supplierId={supplier.id} open={newFeeOpen} onClose={() => setNewFeeOpen(false)} />
            </React.Fragment>
          )}
        </div>
      </div>

      <NewSupplierModal open={newOpen} onClose={() => setNewOpen(false)} />
    </Page>
  );
}
