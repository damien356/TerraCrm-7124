import * as React from "react";
import { CalendarClock, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { useClearTerms, useSetMilestones, useSetTerms, useTerms } from "../queries/finance";

/**
 * PAYMENT TERMS, COMPANY OR JOB.
 *
 * The forecast is only as honest as this card. Terms live on the company as
 * their standard, and any single job can override them. Nothing here is a
 * guess: when nothing is set the card says so and names the fallback it is
 * using, so a wrong forecast date can always be traced back to a real rule.
 */

type Structure = "deposit_balance" | "on_completion" | "progress_claims";
type Trigger = "acceptance" | "order" | "delivery" | "start" | "completion" | "fixed_date";

const STRUCTURES: { value: Structure; label: string; hint: string }[] = [
  {
    value: "deposit_balance",
    label: "Deposit, then the balance",
    hint: "A deposit before material is ordered, the rest when the job is finished.",
  },
  {
    value: "on_completion",
    label: "One invoice on completion",
    hint: "The whole contract invoiced once, when the work is done.",
  },
  {
    value: "progress_claims",
    label: "Progress claims",
    hint: "Claimed in stages. Set the stages below once the terms are saved.",
  },
];

const TRIGGERS: { value: Trigger; label: string }[] = [
  { value: "acceptance", label: "Quote accepted" },
  { value: "order", label: "Material ordered" },
  { value: "delivery", label: "Material delivered" },
  { value: "start", label: "Work starts" },
  { value: "completion", label: "Work complete" },
  { value: "fixed_date", label: "A fixed date" },
];

const structureLabel = (s: string) => STRUCTURES.find((x) => x.value === s)?.label ?? s;
const triggerLabel = (t: string) => TRIGGERS.find((x) => x.value === t)?.label ?? t;

const LEVEL: Record<string, { text: string; colour: string }> = {
  job: { text: "Set on this job", colour: "#C05A2B" },
  company: { text: "Company's terms", colour: "#3F7D3A" },
  default: { text: "Terra's standard", colour: "#7A736D" },
};

/** "30 days end of month", "on completion", "14 days". */
function daysPhrase(days: number, eom: boolean, from: string) {
  const base = days === 0 ? "" : eom ? `${days} days end of month` : `${days} days`;
  const anchor = from === "invoice" ? "from the invoice" : "from completion";
  if (!base) return from === "completion" ? "on completion" : "on invoice";
  return `${base} ${anchor}`;
}

export function PaymentTermsCard({
  companyId,
  jobId,
  companyName,
}: {
  companyId?: number;
  jobId?: number;
  companyName?: string | null;
}) {
  const scope = jobId ? "job" : "company";
  const q = useTerms(jobId ? { jobId } : { companyId: companyId! });
  const clear = useClearTerms();
  const [editing, setEditing] = React.useState(false);
  const [claiming, setClaiming] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  const d = q.data;
  const t = d?.resolved;
  const level = LEVEL[t?.level ?? "default"]!;

  return (
    <Card>
      <CardHeader
        title="Payment terms"
        subtitle={
          scope === "job"
            ? "What this one job gets paid on. Overrides the company."
            : "The standard for every job billed to this company."
        }
        action={
          <span className="flex items-center gap-2">
            {t ? <Badge colour={level.colour}>{level.text}</Badge> : null}
            {t?.level === scope ? (
              <Button
                variant="ghost"
                onClick={() => (scope === "job" ? clear.mutateAsync({ jobId: jobId! }) : setClearing(true))}
                disabled={clear.isPending}
              >
                {clear.isPending ? <Spinner /> : <RotateCcw className="size-3.5" />}
                {scope === "job" ? (companyName ? "Use the company's" : "Back to standard") : "Clear terms"}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setEditing(true)} disabled={!d}>
              <Pencil className="size-3.5" />
              {t && t.level !== "default" ? "Edit terms" : "Set terms"}
            </Button>
          </span>
        }
      />

      {!d || !t ? (
        <div className="px-4 py-6">
          <Spinner />
        </div>
      ) : (
        <>
          <div className="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
            <Fact label="Structure">{structureLabel(t.structure)}</Fact>
            <Fact label="Deposit">
              {t.structure === "deposit_balance" && t.depositPercent > 0
                ? `${t.depositPercent}% up front`
                : "None"}
            </Fact>
            <Fact label="Terms">{daysPhrase(t.termsDays, t.endOfMonth, t.termsFrom)}</Fact>
            <Fact label="Runs late by">
              {t.observedDaysLate > 0 ? `${Math.round(t.observedDaysLate)} days` : "On time"}
            </Fact>
            {t.retentionPercent > 0 ? (
              <Fact label="Retention">
                {t.retentionPercent}% held, released after {t.retentionDays} days
              </Fact>
            ) : null}
            {t.notes ? <Fact label="Notes" className="sm:col-span-2">{t.notes}</Fact> : null}
          </div>

          {/* --------------------------- progress claims -------------------------- */}
          {t.structure === "progress_claims" ? (
            <div className="border-t border-border px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <p className="label-xs">Claim stages</p>
                {t.id ? (
                  <Button variant="ghost" onClick={() => setClaiming(true)}>
                    <Plus className="size-3.5" />
                    {d.milestones.length ? "Edit stages" : "Add stages"}
                  </Button>
                ) : null}
              </div>
              {!t.id ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Save the terms first, then the stages can be set against them.
                </p>
              ) : d.milestones.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  No stages yet, so the whole contract is still forecast as one payment on completion.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {d.milestones.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span>
                        {m.label || `Claim ${m.seq}`}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {m.trigger === "fixed_date"
                            ? (m.onDate ?? "no date set")
                            : `${triggerLabel(m.trigger)}${m.offsetDays ? ` + ${m.offsetDays} days` : ""}`}
                        </span>
                      </span>
                      <span className="tabular font-medium">{m.percent}%</span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="label-xs">Total claimed</span>
                    <span className="tabular font-medium">
                      {d.milestones.reduce((s, m) => s + m.percent, 0)}%
                    </span>
                  </li>
                </ul>
              )}
            </div>
          ) : null}

          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            {t.level === "default" ? (
              <>
                Nothing is set
                {scope === "job" ? (companyName ? " on this job or its company" : " on this job") : " yet"}, so
                the forecast is
                using Terra's standard for {companyId || companyName ? "a company" : "a direct customer"}:{" "}
                {structureLabel(t.structure).toLowerCase()}, {daysPhrase(t.termsDays, t.endOfMonth, t.termsFrom)}.
                Set the real ones and every date in the cashflow moves with them.
              </>
            ) : (
              <>
                <CalendarClock className="mr-1 inline size-3.5 align-[-2px]" />
                Every receipt date in the cashflow forecast for{" "}
                {scope === "job" ? "this job" : "this company's jobs"} comes off these terms.
              </>
            )}
          </p>
        </>
      )}

      {d ? (
        <TermsModal
          key={`${t?.id ?? "new"}-${editing}`}
          open={editing}
          onClose={() => setEditing(false)}
          scope={scope}
          companyId={companyId ?? null}
          jobId={jobId ?? null}
          current={t!}
        />
      ) : null}

      {d && t?.id ? (
        <ClaimsModal
          key={`claims-${t.id}-${claiming}`}
          open={claiming}
          onClose={() => setClaiming(false)}
          termsId={t.id}
          stages={d.milestones}
        />
      ) : null}

      <Modal
        open={clearing}
        onClose={() => setClearing(false)}
        title="Clear this company's terms?"
        subtitle="Their jobs go back to Terra's standard until new terms are set."
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearing(false)}>
              Keep them
            </Button>
            <Button
              variant="destructive"
              disabled={clear.isPending}
              onClick={async () => {
                await clear.mutateAsync({ companyId: companyId! });
                setClearing(false);
              }}
            >
              {clear.isPending ? <Spinner /> : <Trash2 className="size-3.5" />}
              Clear terms
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          {d && d.milestones.length
            ? `The ${d.milestones.length} claim stages saved against them go too. `
            : ""}
          Any job with its own terms keeps them. Every other job for{" "}
          {companyName ?? "this company"} will be forecast on{" "}
          {d ? daysPhrase(d.defaults.termsDays, d.defaults.endOfMonth, d.defaults.termsFrom) : "the standard"}{" "}
          again.
        </p>
      </Modal>
    </Card>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="label-xs">{label}</p>
      <p className="mt-0.5 text-sm">{children}</p>
    </div>
  );
}

/* ------------------------------ terms modal ------------------------------ */

function TermsModal({
  open,
  onClose,
  scope,
  companyId,
  jobId,
  current,
}: {
  open: boolean;
  onClose: () => void;
  scope: "company" | "job";
  companyId: number | null;
  jobId: number | null;
  current: {
    structure: string;
    depositPercent: number;
    termsFrom: string;
    termsDays: number;
    endOfMonth: boolean;
    retentionPercent: number;
    retentionDays: number;
    observedDaysLate: number;
    notes: string;
  };
}) {
  const save = useSetTerms();
  const [form, setForm] = React.useState({
    structure: current.structure as Structure,
    depositPercent: String(current.depositPercent),
    termsFrom: current.termsFrom as "invoice" | "completion",
    termsDays: String(current.termsDays),
    endOfMonth: current.endOfMonth,
    retentionPercent: String(current.retentionPercent),
    retentionDays: String(current.retentionDays),
    observedDaysLate: String(current.observedDaysLate),
    notes: current.notes,
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const structureHint = STRUCTURES.find((s) => s.value === form.structure)?.hint ?? "";

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync({
        companyId: scope === "company" ? companyId : null,
        jobId: scope === "job" ? jobId : null,
        structure: form.structure,
        depositPercent: form.structure === "deposit_balance" ? Number(form.depositPercent) || 0 : 0,
        termsFrom: form.termsFrom,
        termsDays: Number(form.termsDays) || 0,
        endOfMonth: form.endOfMonth,
        retentionPercent: Number(form.retentionPercent) || 0,
        retentionDays: Number(form.retentionDays) || 0,
        observedDaysLate: Number(form.observedDaysLate) || 0,
        notes: form.notes,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={scope === "job" ? "Terms for this job" : "Terms for this company"}
      subtitle={
        scope === "job"
          ? "This overrides the company's standard for this job only."
          : "Used for every job billed to them, unless a job says otherwise."
      }
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Save terms
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How they pay" hint={structureHint} className="sm:col-span-2">
          <Select value={form.structure} onChange={(e) => set("structure", e.target.value as Structure)}>
            {STRUCTURES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>

        {form.structure === "deposit_balance" ? (
          <Field label="Deposit %" hint="Same setting as Deposit on new quotes on the company card. Taken on acceptance, before material is ordered.">
            <Input
              type="number"
              min={0}
              max={100}
              value={form.depositPercent}
              onChange={(e) => set("depositPercent", e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Clock starts from" hint="A builder counts from your invoice, a homeowner from the day you finish.">
          <Select
            value={form.termsFrom}
            onChange={(e) => set("termsFrom", e.target.value as "invoice" | "completion")}
          >
            <option value="invoice">The invoice</option>
            <option value="completion">Completion</option>
          </Select>
        </Field>

        <Field label="Days to pay" hint="0 means on the day.">
          <Input
            type="number"
            min={0}
            max={180}
            value={form.termsDays}
            onChange={(e) => set("termsDays", e.target.value)}
          />
        </Field>

        <Field
          label="End of month"
          hint="30 days EOM is not 30 days. An invoice on 2 Oct is not due until 30 Nov, and that drift is what catches people out."
        >
          <label htmlFor="terms-end-of-month" className="flex h-9 items-center gap-2 text-sm">
            <Checkbox
              id="terms-end-of-month"
              checked={form.endOfMonth}
              onChange={(e) => set("endOfMonth", e.target.checked)}
            />
            Count to the end of the month first
          </label>
        </Field>

        <Field label="Days they actually run late" hint="Leave 0 to forecast them paying to terms.">
          <Input
            type="number"
            min={0}
            max={120}
            value={form.observedDaysLate}
            onChange={(e) => set("observedDaysLate", e.target.value)}
          />
        </Field>

        <Field label="Retention %" hint="Held back on practical completion. 0 for none.">
          <Input
            type="number"
            min={0}
            max={100}
            value={form.retentionPercent}
            onChange={(e) => set("retentionPercent", e.target.value)}
          />
        </Field>

        <Field label="Retention released after (days)">
          <Input
            type="number"
            min={0}
            max={730}
            value={form.retentionDays}
            onChange={(e) => set("retentionDays", e.target.value)}
          />
        </Field>

        <Field label="Notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            placeholder="Claims due by the 25th, paid the following month."
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ------------------------------ claims modal ----------------------------- */

type StageForm = {
  seq: number;
  label: string;
  percent: string;
  trigger: Trigger;
  offsetDays: string;
  onDate: string;
};

function ClaimsModal({
  open,
  onClose,
  termsId,
  stages,
}: {
  open: boolean;
  onClose: () => void;
  termsId: number;
  stages: {
    id: number;
    seq: number;
    label: string;
    percent: number;
    trigger: string;
    offsetDays: number;
    onDate: string | null;
  }[];
}) {
  const save = useSetMilestones();
  const [rows, setRows] = React.useState<StageForm[]>(
    stages.length
      ? stages.map((s) => ({
          seq: s.seq,
          label: s.label,
          percent: String(s.percent),
          trigger: s.trigger as Trigger,
          offsetDays: String(s.offsetDays),
          onDate: s.onDate ?? "",
        }))
      : [
          { seq: 1, label: "Deposit", percent: "20", trigger: "acceptance", offsetDays: "0", onDate: "" },
          { seq: 2, label: "Material delivered", percent: "40", trigger: "delivery", offsetDays: "0", onDate: "" },
          { seq: 3, label: "Final claim", percent: "40", trigger: "completion", offsetDays: "0", onDate: "" },
        ],
  );
  const [error, setError] = React.useState<string | null>(null);

  const total = rows.reduce((s, r) => s + (Number(r.percent) || 0), 0);

  function patch(i: number, patchRow: Partial<StageForm>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patchRow } : r)));
  }

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync({
        termsId,
        stages: rows.map((r, i) => ({
          seq: i + 1,
          label: r.label,
          percent: Number(r.percent) || 0,
          trigger: r.trigger,
          offsetDays: Number(r.offsetDays) || 0,
          onDate: r.trigger === "fixed_date" ? r.onDate || null : null,
        })),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Claim stages"
      subtitle="Each stage claims a share of the contract, dated off what triggers it."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Save stages
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_88px_1fr_96px_36px]">
            <Field label={i === 0 ? "Stage" : ""}>
              <Input value={r.label} placeholder={`Claim ${i + 1}`} onChange={(e) => patch(i, { label: e.target.value })} />
            </Field>
            <Field label={i === 0 ? "Percent" : ""}>
              <Input type="number" min={0} max={100} value={r.percent} onChange={(e) => patch(i, { percent: e.target.value })} />
            </Field>
            <Field label={i === 0 ? "Claimed when" : ""}>
              <Select value={r.trigger} onChange={(e) => patch(i, { trigger: e.target.value as Trigger })}>
                {TRIGGERS.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={i === 0 ? (r.trigger === "fixed_date" ? "Date" : "+ days") : ""}>
              {r.trigger === "fixed_date" ? (
                <Input type="date" value={r.onDate} onChange={(e) => patch(i, { onDate: e.target.value })} />
              ) : (
                <Input type="number" min={0} value={r.offsetDays} onChange={(e) => patch(i, { offsetDays: e.target.value })} />
              )}
            </Field>
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
              className="mb-0.5 flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive hover:text-destructive"
              title="Remove stage"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          onClick={() =>
            setRows((rs) => [
              ...rs,
              { seq: rs.length + 1, label: "", percent: "0", trigger: "completion", offsetDays: "0", onDate: "" },
            ])
          }
        >
          <Plus className="size-3.5" />
          Add stage
        </Button>
        <p className={`text-sm ${total === 100 ? "text-muted-foreground" : "text-[#C05A2B]"}`}>
          {total}% of the contract claimed
          {total === 100 ? "" : total < 100 ? `, ${100 - total}% unclaimed` : `, ${total - 100}% over`}
        </p>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}
