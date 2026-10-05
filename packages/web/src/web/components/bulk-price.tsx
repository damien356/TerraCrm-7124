import * as React from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { Modal } from "./ui/modal";
import {
  useBulkEditApply,
  useBulkEditPreview,
  useBulkSpecialApply,
  useBulkSpecialPreview,
  type BulkEditInput,
  type BulkSpecialInput,
} from "../queries/products";

const money = (n: number | null | undefined) =>
  n === null || n === undefined ? "n/a" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

const ROUNDING = [
  { v: "none", label: "No rounding, exact cents" },
  { v: "5c", label: "Nearest 5 cents" },
  { v: "10c", label: "Nearest 10 cents" },
  { v: "dollar", label: "Nearest dollar" },
] as const;

function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
}

type PreviewRow = {
  id: number;
  name: string;
  unit: string;
  change: "change" | "skip";
  reason: string | null;
  oldCost: number | null;
  oldSell: number | null;
  newCost?: number | null;
  specialCost?: number | null;
  newSell: number | null;
  warning: string | null;
};

function PreviewTable({ rows, kind }: { rows: PreviewRow[]; kind: "edit" | "special" }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border text-left">
            <th className="label-xs px-3 py-2">Product</th>
            <th className="label-xs px-3 py-2 text-right">{kind === "edit" ? "Cost" : "Cost during special"}</th>
            <th className="label-xs px-3 py-2 text-right">Sell ex GST</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const nextCost = kind === "edit" ? r.newCost : r.specialCost;
            return (
              <tr key={r.id} className={r.change === "skip" ? "opacity-50" : ""}>
                <td className="px-3 py-1.5">
                  {r.name}
                  {r.reason ? <span className="block text-muted-foreground">Skipped: {r.reason}</span> : null}
                  {r.warning ? <span className="block text-[#D08A1E]">{r.warning}</span> : null}
                </td>
                <td className="tabular px-3 py-1.5 text-right">
                  {money(r.oldCost)} {r.change === "change" ? <>→ <b>{money(nextCost)}</b></> : null}
                </td>
                <td className="tabular px-3 py-1.5 text-right">
                  {money(r.oldSell)}{" "}
                  {r.change === "change" && r.newSell !== r.oldSell ? <>→ <b>{money(r.newSell)}</b></> : null}
                  {r.change === "change" && r.newSell === r.oldSell ? <span className="text-muted-foreground">unchanged</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------- edit price ------------------------------- */

export function BulkEditPriceModal({
  ids,
  open,
  onClose,
  onDone,
}: {
  ids: number[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = React.useState<BulkEditInput["mode"]>("percent");
  const [amount, setAmount] = React.useState("");
  const [rounding, setRounding] = React.useState<BulkEditInput["rounding"]>("none");
  const [scale, setScale] = React.useState(true);
  const [step, setStep] = React.useState<"form" | "confirm">("form");
  const [error, setError] = React.useState<string | null>(null);
  const apply = useBulkEditApply();

  React.useEffect(() => {
    if (open) {
      setStep("form");
      setError(null);
    }
  }, [open]);

  const n = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(n) && (mode !== "set" || n >= 0);
  const input: BulkEditInput = { ids, mode, amount: n, rounding, scaleOtherRates: scale };
  const preview = useBulkEditPreview(step === "confirm" && valid ? input : null);

  async function confirm() {
    setError(null);
    try {
      await apply.mutateAsync(input);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save those prices");
    }
  }

  const p = preview.data;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={step === "form" ? `Edit price on ${ids.length} products` : "Check before you change anything"}
      subtitle={
        step === "form"
          ? "Changes the standard supplier cost. Sell price follows by the usual markup."
          : "Nothing is saved until you press the red button."
      }
      footer={
        step === "form" ? (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={!valid} onClick={() => setStep("confirm")}>Preview changes</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("form")}>Back</Button>
            <Button variant="destructive" disabled={!p || p.willChange === 0 || apply.isPending} onClick={confirm}>
              {apply.isPending ? "Saving…" : `Change ${p?.willChange ?? 0} prices`}
            </Button>
          </>
        )
      }
    >
      {step === "form" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="How">
              <Select value={mode} onChange={(e) => setMode(e.target.value as BulkEditInput["mode"])}>
                <option value="percent">Percent up or down</option>
                <option value="add">Add or take off a dollar amount</option>
                <option value="set">Set one exact cost</option>
              </Select>
            </Field>
            <Field
              label={mode === "percent" ? "Percent (use a minus to lower)" : mode === "add" ? "Dollars (minus to lower)" : "New cost ex GST"}
            >
              <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={mode === "percent" ? "e.g. 5 or -5" : "e.g. 1.50"} />
            </Field>
          </div>
          <Field label="Round the new cost">
            <Select value={rounding} onChange={(e) => setRounding(e.target.value as BulkEditInput["rounding"])}>
              {ROUNDING.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </Select>
          </Field>
          {mode === "percent" ? (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={scale} onChange={(e) => setScale(e.target.checked)} />
              Move the cut-roll and volume rates by the same percent
            </label>
          ) : null}
        </div>
      ) : preview.isLoading || !p ? (
        <p className="text-sm text-muted-foreground">Working it out…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge colour="#3F7D3A">{p.willChange} will change</Badge>
            {p.willSkip ? <Badge colour="#7A736D">{p.willSkip} skipped</Badge> : null}
            {p.warnings ? <Badge colour="#D08A1E">{p.warnings} warnings</Badge> : null}
          </div>
          <PreviewTable rows={p.rows as PreviewRow[]} kind="edit" />
          <p className="text-xs text-muted-foreground">
            Quotes already written keep the price they have. Only new quotes use the new prices.
          </p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}

/* -------------------------------- on special ------------------------------- */

export function BulkSpecialModal({
  ids,
  open,
  onClose,
  onDone,
}: {
  ids: number[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const today = todayISO();
  const [mode, setMode] = React.useState<BulkSpecialInput["mode"]>("percent_off");
  const [amount, setAmount] = React.useState("");
  const [rounding, setRounding] = React.useState<BulkSpecialInput["rounding"]>("none");
  const [label, setLabel] = React.useState("Special");
  const [kind, setKind] = React.useState<BulkSpecialInput["kind"]>("promo");
  // No defaults on purpose. A special without both dates cannot be saved.
  const [startsOn, setStartsOn] = React.useState("");
  const [endsOn, setEndsOn] = React.useState("");
  const [passOn, setPassOn] = React.useState(false);
  const [step, setStep] = React.useState<"form" | "confirm">("form");
  const [error, setError] = React.useState<string | null>(null);
  const apply = useBulkSpecialApply();

  React.useEffect(() => {
    if (open) {
      setStep("form");
      setError(null);
      setStartsOn("");
      setEndsOn("");
    }
  }, [open]);

  const n = Number(amount);
  const datesOk = /^\d{4}-\d{2}-\d{2}$/.test(startsOn) && /^\d{4}-\d{2}-\d{2}$/.test(endsOn) && endsOn >= startsOn && endsOn >= today;
  const valid = amount.trim() !== "" && Number.isFinite(n) && n >= 0 && datesOk && label.trim() !== "";
  const input: BulkSpecialInput = { ids, mode, amount: n, rounding, label: label.trim(), kind, startsOn, endsOn, passOnToCustomer: passOn };
  const preview = useBulkSpecialPreview(step === "confirm" && valid ? input : null);
  const p = preview.data;

  async function confirm() {
    setError(null);
    try {
      await apply.mutateAsync(input);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save those specials");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={step === "form" ? `Put ${ids.length} products on special` : "Check before you change anything"}
      subtitle={
        step === "form"
          ? "A dated special. The standard price comes back by itself the day after it ends."
          : "Nothing is saved until you press the red button."
      }
      footer={
        step === "form" ? (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={!valid} onClick={() => setStep("confirm")}>Preview changes</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setStep("form")}>Back</Button>
            <Button variant="destructive" disabled={!p || p.willChange === 0 || apply.isPending} onClick={confirm}>
              {apply.isPending ? "Saving…" : `Start ${p?.willChange ?? 0} specials`}
            </Button>
          </>
        )
      }
    >
      {step === "form" ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="How">
              <Select value={mode} onChange={(e) => setMode(e.target.value as BulkSpecialInput["mode"])}>
                <option value="percent_off">Percent off the standard cost</option>
                <option value="dollar_off">Dollars off the standard cost</option>
                <option value="set_cost">Set one exact special cost</option>
              </Select>
            </Field>
            <Field label={mode === "percent_off" ? "Percent off" : mode === "dollar_off" ? "Dollars off" : "Special cost ex GST"}>
              <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What to call it">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Type">
              <Select value={kind} onChange={(e) => setKind(e.target.value as BulkSpecialInput["kind"])}>
                <option value="promo">Promotion</option>
                <option value="clearance">Clearance</option>
                <option value="run_out">Run out</option>
                <option value="negotiated">Negotiated</option>
              </Select>
            </Field>
            <Field label="Start date (required)"><Input type="date" required value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
            <Field label="End date (required, inclusive)"><Input type="date" required value={endsOn} min={startsOn || today} onChange={(e) => setEndsOn(e.target.value)} /></Field>
          </div>
          {!datesOk ? (
            <p className="text-xs text-muted-foreground">
              {!startsOn || !endsOn
                ? "Pick a start and an end date. A special can't be saved without both."
                : "The end date can't be before the start date, or in the past."}
            </p>
          ) : null}
          <Field label="Round the special cost">
            <Select value={rounding} onChange={(e) => setRounding(e.target.value as BulkSpecialInput["rounding"])}>
              {ROUNDING.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </Select>
          </Field>
          <div className="rounded-md border border-border p-3">
            <p className="label-xs mb-2">Who gets the saving</p>
            <label className="mb-2 flex items-start gap-2 text-sm">
              <input type="radio" className="mt-1" checked={!passOn} onChange={() => setPassOn(false)} />
              <span><b>Keep the profit.</b> Sell price stays the same, the saving is extra margin for Terra.</span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="radio" className="mt-1" checked={passOn} onChange={() => setPassOn(true)} />
              <span><b>Give the client the discount.</b> New quotes are priced off the special cost until it ends. Quotes already written do not change.</span>
            </label>
          </div>
        </div>
      ) : preview.isLoading || !p ? (
        <p className="text-sm text-muted-foreground">Working it out…</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge colour="#3F7D3A">{p.willChange} will start</Badge>
            {p.willSkip ? <Badge colour="#7A736D">{p.willSkip} skipped</Badge> : null}
            {p.warnings ? <Badge colour="#D08A1E">{p.warnings} warnings</Badge> : null}
            <Badge colour={passOn ? "#4A7FA5" : "#3F7D3A"}>{passOn ? "Customer gets the discount" : "Terra keeps the profit"}</Badge>
          </div>
          <PreviewTable rows={p.rows as PreviewRow[]} kind="special" />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
