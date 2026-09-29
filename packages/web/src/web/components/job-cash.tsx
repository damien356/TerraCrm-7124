import * as React from "react";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/field";
import { Modal } from "./ui/modal";
import { money, moneyExact, longDate, shortDate } from "../lib/money";
import { useJobBudget, useSaveCost, useDeleteCost } from "../queries/finance";

/**
 * THE MONEY-OUT SIDE OF A JOB.
 *
 * "What this job makes" prices the job off the quote and the rate book, which
 * is the margin question. This card is the cash question, which is a different
 * one: what actually has to leave the account to deliver it, on what date, and
 * how much of Terra's own money the job eats before the customer pays.
 *
 * Damien's example: a $40,000 job with $11,500 of material due 15 Oct, $6,800
 * of installer pay due 4 Nov and $1,200 of other costs, invoiced 28 Oct on 30
 * days EOM, does not pay until 30 Nov. That is a $19,500 hole Terra carries
 * for six weeks. Nothing else in the system says that out loud, so this does.
 *
 * Every row written here lands in the cashflow forecast immediately, which is
 * why the states matter: a budget line forecasts as expected, an ordered or
 * booked line forecasts as committed, a paid line drops out entirely.
 */

const KINDS = [
  { key: "materials", label: "Material", hint: "Supplier invoice, 30 days EOM from the order" },
  { key: "installer", label: "Installer", hint: "Paid within 7 days of their invoice" },
  { key: "other", label: "Other direct", hint: "Skips, travel, rubbish, hire" },
] as const;

const STATES = [
  { key: "budget", label: "Budget", hint: "Terra's own estimate, no bill yet", colour: "#7A736D" },
  { key: "committed", label: "Committed", hint: "Ordered or booked, bill still to come", colour: "#4A7FA5" },
  { key: "invoiced", label: "Invoiced", hint: "Bill is in, real due date", colour: "#D08A1E" },
  { key: "paid", label: "Paid", hint: "Gone. Out of the forecast", colour: "#3F7D3A" },
] as const;

type Kind = (typeof KINDS)[number]["key"];
type State = (typeof STATES)[number]["key"];

const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.key, k.label]));
const STATE_META: Record<string, { label: string; colour: string }> = Object.fromEntries(
  STATES.map((s) => [s.key, { label: s.label, colour: s.colour }]),
);

type CostRow = {
  id: number;
  kind: string;
  description: string;
  supplierId: number | null;
  installerId: number | null;
  supplierName: string | null;
  installerName: string | null;
  amount: number;
  state: string;
  dueDate: string | null;
  dueDateLocked: boolean;
  invoiceRef: string | null;
  notes: string;
  computedDue: { date: string; basis: string };
};

type Draft = {
  id?: number;
  kind: Kind;
  description: string;
  supplierId: string;
  installerId: string;
  amount: string;
  state: State;
  dueDate: string;
  invoiceRef: string;
};

const blank = (kind: Kind = "materials"): Draft => ({
  kind,
  description: "",
  supplierId: "",
  installerId: "",
  amount: "",
  state: "budget",
  dueDate: "",
  invoiceRef: "",
});

const fromRow = (r: CostRow): Draft => ({
  id: r.id,
  kind: (KIND_LABEL[r.kind] ? r.kind : "other") as Kind,
  description: r.description,
  supplierId: r.supplierId ? String(r.supplierId) : "",
  installerId: r.installerId ? String(r.installerId) : "",
  amount: String(r.amount),
  state: (STATE_META[r.state] ? r.state : "budget") as State,
  dueDate: r.dueDate ?? "",
  invoiceRef: r.invoiceRef ?? "",
});

export function JobCashCard({ jobId }: { jobId: number }) {
  const q = useJobBudget(jobId);
  const save = useSaveCost();
  const del = useDeleteCost();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [confirm, setConfirm] = React.useState<CostRow | null>(null);

  const d = q.data;
  const s = d?.summary;
  const costs = (d?.costs ?? []) as CostRow[];

  function commit() {
    if (!draft) return;
    const amount = Number(draft.amount.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(amount) || amount < 0) return;
    save.mutate(
      {
        id: draft.id,
        jobId,
        kind: draft.kind,
        description: draft.description,
        supplierId: draft.kind === "materials" && draft.supplierId ? Number(draft.supplierId) : null,
        installerId: draft.kind === "installer" && draft.installerId ? Number(draft.installerId) : null,
        amount,
        state: draft.state,
        dueDate: draft.dueDate || null,
        dueDateLocked: !!draft.dueDate,
        invoiceRef: draft.invoiceRef || null,
        notes: "",
      },
      { onSuccess: () => setDraft(null) },
    );
  }

  return (
    <>
      <Card>
        <CardHeader
          title="Money out, and when it leaves"
          subtitle="Material, installer pay and direct costs. Every line here moves the cashflow forecast the moment it is saved."
          action={
            <Button size="sm" onClick={() => setDraft(blank())}>
              <Plus className="size-3.5" />
              Add cost
            </Button>
          }
        />

        {q.isLoading || !d || !s ? (
          <Loading label="Working the job's cash out…" />
        ) : (
          <div className="grid gap-4 px-4 py-3">
            {/* the six figures Damien reads in this order */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
              <Fig label="Contract" value={money(s.value)} hint="ex GST" />
              <Fig label="Material" value={s.materials ? money(s.materials) : "—"} />
              <Fig label="Installer" value={s.installer ? money(s.installer) : "—"} />
              <Fig label="Other" value={s.other ? money(s.other) : "—"} />
              <Fig
                label="Expected GP"
                value={s.hasCosts ? money(s.grossProfit) : "—"}
                hint={
                  s.hasCosts
                    ? s.marginPercent == null
                      ? undefined
                      : `${s.marginPercent.toFixed(1)}% margin`
                    : "no costs entered"
                }
                tone={s.hasCosts ? (s.grossProfit > 0 ? "good" : "bad") : undefined}
              />
              <Fig
                label="Cash requirement"
                value={s.hasCosts ? money(s.cashRequirement) : "—"}
                hint={s.hasCosts ? "Terra's money, before the customer pays" : "nothing to carry yet"}
                tone={s.cashRequirement > 0 ? "bad" : undefined}
              />
            </div>

            {/* the sentence, in Damien's words */}
            {s.hasCosts ? (
              <p className="rounded-md border border-border bg-secondary/60 px-3 py-2 text-xs leading-relaxed">
                {s.cashRequirement > 0 ? (
                  <>
                    <span className="font-semibold">
                      This job creates a {money(s.cashRequirement)} cash requirement before the customer pays.
                    </span>{" "}
                    {money(s.outBeforeReceipt)} of costs fall due before the {money(s.value)} lands on{" "}
                    {longDate(s.receiptDate)}
                    {s.deposit > 0 ? `, offset by a ${money(s.deposit)} deposit` : ", with no deposit to soften it"}.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">This job funds itself.</span> The {money(s.value)} lands on{" "}
                    {longDate(s.receiptDate)}
                    {s.outBeforeReceipt > 0
                      ? ` and only ${money(s.outBeforeReceipt)} of cost falls due before then`
                      : " and nothing has to leave the account before then"}
                    {s.deposit > 0 ? `, with a ${money(s.deposit)} deposit ahead of it` : ""}. Terra carries none
                    of it.
                  </>
                )}
              </p>
            ) : (
              <p className="flex items-start gap-2 rounded-md bg-[#B4472E]/10 px-3 py-2 text-xs text-[#B4472E]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">No costs on this job.</span> The forecast has{" "}
                  {money(s.value)} coming in on {longDate(s.receiptDate)} with nothing going out against it, so
                  every cash low point it shows is kinder than reality.
                </span>
              </p>
            )}

            {/* the lines */}
            {costs.length === 0 ? (
              <Empty>
                Nothing entered yet. Add the material order, the installer's price and any direct costs, and the
                gross profit and cash requirement above fill in.
              </Empty>
            ) : (
              <div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-2">Cost</th>
                      <th className="th px-2">State</th>
                      <th className="th px-2">Leaves the account</th>
                      <th className="th px-2 text-right">Amount</th>
                      <th aria-hidden="true" className="th px-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {costs.map((c) => {
                      const meta = STATE_META[c.state] ?? { label: c.state, colour: undefined as never };
                      const due = c.dueDate ?? c.computedDue.date;
                      return (
                        <tr key={c.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                          <td className="px-2 py-2.5">
                            <p className="font-medium">{c.description || KIND_LABEL[c.kind] || "Cost"}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {KIND_LABEL[c.kind] ?? c.kind}
                              {c.supplierName ? ` · ${c.supplierName}` : ""}
                              {c.installerName ? ` · ${c.installerName}` : ""}
                              {c.invoiceRef ? ` · ${c.invoiceRef}` : ""}
                            </p>
                          </td>
                          <td className="px-2 py-2.5">
                            <Badge colour={meta.colour}>{meta.label}</Badge>
                          </td>
                          <td className="px-2 py-2.5">
                            <p className="tabular text-[13px]">{shortDate(due)}</p>
                            <p className="text-[11px] text-muted-foreground">
                              {c.dueDate ? "date you set" : c.computedDue.basis}
                            </p>
                          </td>
                          <td className="tabular px-2 py-2.5 text-right font-medium">{moneyExact(c.amount)}</td>
                          <td className="px-2 py-2.5">
                            <div className="flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => setDraft(fromRow(c))}
                                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                                aria-label="Edit cost"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirm(c)}
                                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-destructive"
                                aria-label="Delete cost"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border bg-secondary/40">
                      <td className="px-2 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Total cost
                      </td>
                      <td aria-hidden="true" colSpan={2} />
                      <td className="tabular px-2 py-2.5 text-right font-semibold">{moneyExact(s.totalCost)}</td>
                      <td aria-hidden="true" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Payment in is worked out on{" "}
              <span className="font-medium text-foreground">
                {d.terms.structureLabel},{" "}
                {d.terms.termsDays === 0 && d.terms.termsFrom === "completion"
                  ? "paid on completion"
                  : `paid ${d.terms.label} from ${d.terms.termsFrom === "invoice" ? "the invoice" : "completion"}`}
              </span>
              {d.terms.level === "job"
                ? ", set on this job"
                : d.terms.level === "company"
                  ? ", the company's own terms"
                  : ", the standard because nothing is set on the company or the job"}
              . Leave a cost's date blank and the engine dates it: material 30 days EOM from the order, installer
              7 days after their invoice.
            </p>
          </div>
        )}
      </Card>

      {/* add / edit */}
      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit cost" : "Add a cost"}
        subtitle="This goes straight into the cashflow forecast."
        footer={
          <>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={commit} disabled={save.isPending || !draft?.amount.trim()}>
              {save.isPending ? <Spinner /> : null}
              {draft?.id ? "Save cost" : "Add cost"}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="grid gap-3">
            <Field label="What kind of cost" hint={KINDS.find((k) => k.key === draft.kind)?.hint}>
              <Select
                value={draft.kind}
                onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
              >
                {KINDS.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Description" hint="What Damien would call it on the phone.">
              <Input
                value={draft.description}
                placeholder={draft.kind === "installer" ? "Install, 3 days" : "Carpet and underlay"}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>

            {draft.kind === "materials" ? (
              <Field label="Supplier" hint="Optional, but it makes the expenses list readable.">
                <Select
                  value={draft.supplierId}
                  onChange={(e) => setDraft({ ...draft, supplierId: e.target.value })}
                >
                  <option value="">Not saying</option>
                  {(q.data?.suppliers ?? []).map((sup) => (
                    <option key={sup.id} value={sup.id}>
                      {sup.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {draft.kind === "installer" ? (
              <Field label="Installer" hint="Who is getting paid.">
                <Select
                  value={draft.installerId}
                  onChange={(e) => setDraft({ ...draft, installerId: e.target.value })}
                >
                  <option value="">Not saying</option>
                  {(q.data?.installers ?? []).map((ins) => (
                    <option key={ins.id} value={ins.id}>
                      {ins.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Amount ex GST">
                <Input
                  value={draft.amount}
                  inputMode="decimal"
                  placeholder="0.00"
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                  className="tabular"
                />
              </Field>
              <Field label="How certain is it" hint={STATES.find((st) => st.key === draft.state)?.hint}>
                <Select
                  value={draft.state}
                  onChange={(e) => setDraft({ ...draft, state: e.target.value as State })}
                >
                  {STATES.map((st) => (
                    <option key={st.key} value={st.key}>
                      {st.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field
              label="Date it leaves the account"
              hint="Leave it blank and the engine works it out off the schedule and the standard terms. Put a date in and it stops moving."
            >
              <Input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                className="tabular"
              />
            </Field>

            {draft.state === "invoiced" || draft.state === "paid" ? (
              <Field label="Invoice reference" hint="So this line can be matched back to the bill.">
                <Input
                  value={draft.invoiceRef}
                  placeholder="INV-4821"
                  onChange={(e) => setDraft({ ...draft, invoiceRef: e.target.value })}
                />
              </Field>
            ) : null}

            {save.isError ? (
              <p className="text-xs text-destructive">That did not save. Check the amount and try again.</p>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* delete */}
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Delete this cost"
        subtitle="It comes straight back out of the forecast."
        width="max-w-md"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                if (!confirm) return;
                del.mutate({ id: confirm.id }, { onSuccess: () => setConfirm(null) });
              }}
            >
              {del.isPending ? <Spinner /> : null}
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {confirm
            ? `${confirm.description || KIND_LABEL[confirm.kind] || "This cost"}, ${moneyExact(confirm.amount)}. The job's gross profit and cash requirement recalculate without it.`
            : null}
        </p>
      </Modal>
    </>
  );
}

function Fig({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  const colour = tone === "good" ? "text-[#3E6B4F]" : tone === "bad" ? "text-[#B4472E]" : "";
  return (
    <div>
      <p className="label-xs">{label}</p>
      <p className={`tabular mt-0.5 text-lg font-semibold ${colour}`}>{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
