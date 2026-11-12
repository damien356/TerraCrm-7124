import * as React from "react";
import { AlertTriangle, Check, Copy, Layers, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { DateField } from "./ui/date-field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { moneyExact, shortDate } from "../lib/money";
import { useInstallers } from "../queries/installers";
import {
  previewStages,
  proposeStages,
  useAgreeStages,
  useApproveStagePay,
  useCancelStages,
  useCompleteStage,
  useConfirmStages,
  useJobStages,
  useRaiseStageInvoice,
  useReassignRemaining,
  useSaveStages,
  type StagePlanInput,
  type StagesCard as CardData,
} from "../queries/stages";

/* ---------------------------------------------------------------------------
 * STAGES CARD (Damien, 12 Nov 2026). "Split into stages / Record partial
 * completion". The full agreed material amount is due when staging is
 * agreed, labour is billed per finished stage, and the installer claims only
 * the pay the office approved for a finished stage. The accepted quote is
 * never changed. Raising an invoice here only writes it: review, email and
 * Xero stay on the Client invoices card.
 * ------------------------------------------------------------------------- */

const today = () => new Date().toLocaleDateString("en-CA");
const qtyText = (n: number) => String(+n.toFixed(4));
const num = (s: string) => {
  const n = Number(s);
  return s.trim() === "" || !Number.isFinite(n) ? null : n;
};

type Stage = CardData["stages"][number];

export function StagesCard({ jobId }: { jobId: number }) {
  const q = useJobStages(jobId);
  const [setup, setSetup] = React.useState(false);
  if (q.isLoading) return null;
  if (q.error || !q.data) return null;
  const d = q.data;
  const plan = d.plan;

  if (!plan) {
    return (
      <Card>
        <CardHeader
          title="Stages"
          subtitle="For a job done in parts: a planned staged job, or work held part way because the site is not ready."
          action={
            d.blocked ? null : (
              <Button size="sm" variant="outline" onClick={() => setSetup(true)}>
                <Layers className="size-3.5" /> Split into stages / Record partial completion
              </Button>
            )
          }
        />
        {d.blocked ? <p className="px-4 py-3 text-xs text-muted-foreground">{d.blocked}</p> : null}
        {setup ? <SetupModal data={d} onClose={() => setSetup(false)} /> : null}
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Stages"
        subtitle={`${d.labels.kinds[plan.kind] ?? plan.kind}. ${d.labels.reasons[plan.reason] ?? plan.reason}${plan.reasonNote ? `: ${plan.reasonNote}` : ""}`}
        action={
          <div className="flex items-center gap-2">
            <Badge colour={plan.status === "draft" ? "#B5651D" : "#2E7D32"}>
              {plan.status === "complete" ? "All stages finished" : plan.status === "agreed" ? "Agreed" : "Draft"}
            </Badge>
            {plan.status === "complete" ? null : (
              <Button size="sm" variant="outline" onClick={() => setSetup(true)}>
                Edit setup
              </Button>
            )}
          </div>
        }
      />
      <div className="space-y-4 px-4 py-3 text-sm">
        <PlanFacts d={d} />
        {plan.status === "draft" ? <DraftSteps d={d} /> : null}
        <StageList d={d} />
        <BillingPanel d={d} />
        <Reconciliation d={d} />
        <Materials d={d} />
        <Wording d={d} />
        <ReassignAndCancel d={d} />
      </div>
      {setup ? <SetupModal data={d} onClose={() => setSetup(false)} /> : null}
    </Card>
  );
}

/* ------------------------------ plan facts ------------------------------ */

function PlanFacts({ d }: { d: CardData }) {
  const p = d.plan!;
  const rows: [string, React.ReactNode][] = [
    ["Requested by", p.requestedBy ? `${p.requestedBy}${p.requestedOn ? `, ${shortDate(p.requestedOn)}` : ""}` : "Not recorded"],
    ["Arrangement", p.arrangement || "Not recorded"],
    ["Follow up", p.followUpDate ? shortDate(p.followUpDate) : "No date set"],
    [
      "Customer confirmation",
      p.confirmedByName ? `${p.confirmedByName}, ${shortDate(p.confirmedOn)} by ${p.confirmedHow}` : <span key="none" className="text-[var(--warning)]">Not recorded</span>,
    ],
    [
      "Split",
      `Materials ${moneyExact(p.materialsInc)} and labour ${moneyExact(p.labourInc)} inc GST${p.splitSource === "office" ? " (office split)" : " (from the quote lines)"}${
        p.splitApprovedAt ? `, approved by ${p.splitApprovedByName}` : d.split?.needsApproval ? ", needs approval" : ""
      }`,
    ],
    ["Variations", d.labels.variationTimings[p.variationTiming] ?? p.variationTiming],
  ];
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[150px_1fr]">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/* ------------------------- draft: confirm, agree ------------------------ */

function DraftSteps({ d }: { d: CardData }) {
  const p = d.plan!;
  const confirm = useConfirmStages();
  const agree = useAgreeStages();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(p.confirmedByName ?? "");
  const [on, setOn] = React.useState(p.confirmedOn ?? today());
  const [how, setHow] = React.useState<(typeof d.labels.confirmHows)[number]>("email");
  const [text, setText] = React.useState(p.confirmationText ?? "");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <div className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3">
      <p className="text-xs font-semibold">Before the staging is agreed</p>
      {p.agreeBlocks.length ? (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {p.agreeBlocks.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs">Everything is recorded. Agree the staging to start invoicing by stage.</p>
      )}
      {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Record customer confirmation
        </Button>
        <Button
          size="sm"
          disabled={p.agreeBlocks.length > 0 || agree.isPending}
          onClick={() => {
            setErr(null);
            agree.mutate({ planId: p.id }, { onError: (e) => setErr(errorText(e)) });
          }}
        >
          {agree.isPending ? <Spinner className="size-3" /> : <Check className="size-3.5" />} Agree staging
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Customer's written confirmation"
        subtitle="Who agreed to the staging and the payment arrangement, when, and how."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!name.trim() || !on || confirm.isPending}
              onClick={() =>
                confirm.mutate(
                  { planId: p.id, name, on, how, text },
                  { onSuccess: () => setOpen(false), onError: (e) => setErr(errorText(e)) },
                )
              }
            >
              Save confirmation
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <DateField value={on} onChange={(e) => setOn(e.target.value)} />
            </Field>
            <Field label="How">
              <Select value={how} onChange={(e) => setHow(e.target.value as typeof how)}>
                {d.labels.confirmHows.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Their words (paste the reply)">
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/* -------------------------------- stages -------------------------------- */

function StageList({ d }: { d: CardData }) {
  const [finishing, setFinishing] = React.useState<Stage | null>(null);
  const approve = useApproveStagePay();
  const [err, setErr] = React.useState<string | null>(null);
  const firstOpen = d.stages.find((s) => s.status !== "complete");
  return (
    <div>
      <p className="label-xs mb-1.5">Stages</p>
      {err ? <p className="mb-2 text-xs text-destructive">{err}</p> : null}
      <div className="space-y-2">
        {d.stages.map((s) => {
          const done = s.status === "complete";
          const unapproved = s.pay.filter((p) => p.approvedAt == null && p.lineKey !== "hourly" && (p.amount ?? 0) > 0);
          return (
            <div key={s.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  <Badge colour={done ? "#2E7D32" : "#6B6B6B"}>
                    {done ? `Finished ${shortDate(s.completedOn)}` : s.plannedDate ? `Expected ${shortDate(s.plannedDate)}` : "Awaiting readiness"}
                  </Badge>
                  {s.invoiceId ? <Badge>Invoiced</Badge> : null}
                </div>
                <div className="flex gap-2">
                  {!done && firstOpen?.id === s.id && d.plan?.status === "agreed" ? (
                    <Button size="sm" variant="outline" onClick={() => setFinishing(s)}>
                      Record as finished
                    </Button>
                  ) : null}
                  {done && unapproved.length ? (
                    <Button
                      size="sm"
                      disabled={approve.isPending}
                      onClick={() => {
                        setErr(null);
                        approve.mutate({ stageId: s.id }, { onError: (e) => setErr(errorText(e)) });
                      }}
                    >
                      Approve installer pay
                    </Button>
                  ) : null}
                </div>
              </div>
              {s.scope ? <p className="mt-1 text-xs text-muted-foreground">{s.scope}</p> : null}
              <div className="mt-2 grid gap-3 text-xs md:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">Customer labour</p>
                  {s.lines.length ? (
                    s.lines.map((l) => (
                      <p key={l.id} className="tabular">
                        {qtyText(l.qty)} {l.unit} {l.description}: {moneyExact(l.amountInc)}
                      </p>
                    ))
                  ) : (
                    <p>Nothing</p>
                  )}
                </div>
                <div>
                  <p className="text-muted-foreground">Installer pay (ex GST)</p>
                  {s.pay.length ? (
                    s.pay.map((p) => (
                      <p key={p.id} className="tabular">
                        {p.installerName ?? "Unassigned"}: {p.lineKey === "hourly" ? `about ${p.estimatedHours ?? 0} h, timesheets only` : `${qtyText(p.qty)} ${p.unit} ${moneyExact(p.amount)}`}
                        {p.claimInvoiceId ? " · claimed" : p.approvedAt ? " · approved" : done && p.lineKey !== "hourly" ? " · to approve" : ""}
                        {p.changeNote ? ` · ${p.changeNote}` : ""}
                      </p>
                    ))
                  ) : (
                    <p>Nothing</p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {finishing ? <FinishModal stage={finishing} onClose={() => setFinishing(null)} /> : null}
    </div>
  );
}

function FinishModal({ stage, onClose }: { stage: Stage; onClose: () => void }) {
  const complete = useCompleteStage();
  const [on, setOn] = React.useState(today());
  const [lines, setLines] = React.useState(() => Object.fromEntries(stage.lines.map((l) => [l.quoteItemId, qtyText(l.qty)])));
  const [pay, setPay] = React.useState(() => Object.fromEntries(stage.pay.filter((p) => p.lineKey !== "hourly").map((p) => [`${p.taskId}:${p.lineKey}`, qtyText(p.qty)])));
  const [err, setErr] = React.useState<string | null>(null);

  const submit = () => {
    setErr(null);
    const changedLines = stage.lines
      .map((l) => ({ quoteItemId: l.quoteItemId, qty: num(lines[l.quoteItemId] ?? "") ?? -1, was: l.qty }))
      .filter((l) => Math.abs(l.qty - l.was) > 1e-9);
    const changedPay = stage.pay
      .filter((p) => p.lineKey !== "hourly")
      .map((p) => ({ taskId: p.taskId, lineKey: p.lineKey, qty: num(pay[`${p.taskId}:${p.lineKey}`] ?? "") ?? -1, was: p.qty }))
      .filter((p) => Math.abs(p.qty - p.was) > 1e-9);
    if ([...changedLines, ...changedPay].some((x) => x.qty < 0)) return setErr("Type a quantity of 0 or more on every line.");
    complete.mutate(
      {
        stageId: stage.id,
        completedOn: on,
        lines: changedLines.length ? changedLines.map(({ quoteItemId, qty }) => ({ quoteItemId, qty })) : undefined,
        pay: changedPay.length ? changedPay.map(({ taskId, lineKey, qty }) => ({ taskId, lineKey, qty })) : undefined,
      },
      { onSuccess: onClose, onError: (e) => setErr(errorText(e)) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Record ${stage.name} as finished`}
      subtitle="The quantities actually done. Anything not done moves to the next stage."
      width="max-w-xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={complete.isPending} onClick={submit}>
            {complete.isPending ? <Spinner className="size-3" /> : null} Record as finished
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="Finished on">
          <DateField value={on} onChange={(e) => setOn(e.target.value)} />
        </Field>
        {stage.lines.length ? <p className="label-xs">Customer labour done</p> : null}
        {stage.lines.map((l) => (
          <div key={l.id} className="grid grid-cols-[1fr_110px] items-center gap-2">
            <span className="text-xs">
              {l.description} (planned {qtyText(l.qty)} {l.unit})
            </span>
            <Input inputMode="decimal" value={lines[l.quoteItemId] ?? ""} onChange={(e) => setLines({ ...lines, [l.quoteItemId]: e.target.value })} />
          </div>
        ))}
        {stage.pay.some((p) => p.lineKey !== "hourly") ? <p className="label-xs">Installer work done</p> : null}
        {stage.pay
          .filter((p) => p.lineKey !== "hourly")
          .map((p) => (
            <div key={p.id} className="grid grid-cols-[1fr_110px] items-center gap-2">
              <span className="text-xs">
                {p.installerName ?? "Unassigned"}: {p.description} (planned {qtyText(p.qty)} {p.unit})
              </span>
              <Input inputMode="decimal" value={pay[`${p.taskId}:${p.lineKey}`] ?? ""} onChange={(e) => setPay({ ...pay, [`${p.taskId}:${p.lineKey}`]: e.target.value })} />
            </div>
          ))}
        {stage.pay.some((p) => p.lineKey === "hourly") ? <p className="text-xs text-muted-foreground">Hourly work is paid from approved timesheets, so there is nothing to type here.</p> : null}
        {err ? <p className="text-xs text-destructive">{err}</p> : null}
      </div>
    </Modal>
  );
}

/* ------------------------------- billing -------------------------------- */

function BillingPanel({ d }: { d: CardData }) {
  const b = d.billing;
  const raise = useRaiseStageInvoice();
  const [err, setErr] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  // A finished plan still raises its Final (Damien, 12 Nov 2026).
  const agreed = d.plan?.status === "agreed" || d.plan?.status === "complete";
  const cells: [string, number, string?][] = [
    ["Already invoiced", b.alreadyInvoiced],
    ["Payments received", b.paymentsReceived],
    ["Outstanding on existing invoices", b.outstandingExisting],
    ["New invoice", b.newInvoice, "font-semibold"],
    ["Remaining after this", b.remainingAfter],
  ];
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="label-xs">Next customer invoice: {b.label}</p>
        <Button
          size="sm"
          disabled={!agreed || b.newInvoice <= 0 || raise.isPending}
          onClick={() => {
            setErr(null);
            setDone(null);
            raise.mutate(
              { planId: d.plan!.id, expectedSeq: d.plan!.invoiceSeq },
              {
                onSuccess: (r) => setDone(r.already ? `Already raised: ${r.invoice.ref}. Nothing new was made.` : `Raised ${r.invoice.ref}. Review and send it on the Client invoices card.`),
                onError: (e) => setErr(errorText(e)),
              },
            );
          }}
        >
          {raise.isPending ? <Spinner className="size-3" /> : null} Raise {b.kind === "final" ? "final" : "progress"} invoice {moneyExact(b.newInvoice)}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Target {moneyExact(b.target)} = materials {moneyExact(b.materialsInc)}
        {b.variationMaterialsNow ? ` + variation materials ${moneyExact(b.variationMaterialsNow)}` : ""} + labour done {moneyExact(b.labourDone)}. Contract {moneyExact(b.contractTotal)}
        {b.variationsTotal ? ` (quote ${moneyExact(b.quoteTotal)} + variations ${moneyExact(b.variationsTotal)})` : ""}.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {cells.map(([k, v, cls]) => (
          <div key={k} className="rounded-md bg-secondary/60 px-2 py-1.5">
            <p className="text-[11px] text-muted-foreground">{k}</p>
            <p className={`tabular text-sm ${cls ?? ""}`}>{moneyExact(v)}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs">After this invoice the customer owes {moneyExact(b.outstandingAfter)} across their invoices.</p>
      {b.overBilledBy > 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5" /> Earlier invoices are {moneyExact(b.overBilledBy)} over what is due at this stage. Nothing new will be raised. Check the earlier invoices.
        </p>
      ) : null}
      {b.notes.map((n) => (
        <p key={n} className="mt-1 text-xs text-[var(--warning)]">
          {n}
        </p>
      ))}
      {!agreed ? <p className="mt-1 text-xs text-muted-foreground">Agree the staging first. Then the progress invoice can be raised.</p> : null}
      {err ? <p className="mt-1 text-xs text-destructive">{err}</p> : null}
      {done ? <p className="mt-1 text-xs text-[var(--success)]">{done}</p> : null}
    </div>
  );
}

function Reconciliation({ d }: { d: CardData }) {
  const r = d.reconciliation;
  if (!r) return null;
  return (
    <div className="text-xs">
      <p className="label-xs mb-1">Checks</p>
      {r.ok ? (
        <p className="text-[var(--success)]">The stages add back to the accepted quote, and every task's pay adds back to his authorised pay.</p>
      ) : (
        <ul className="list-disc pl-5 text-destructive">
          {r.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="mt-1 space-y-0.5">
        {r.pay
          .filter((p) => p.mode !== "employee")
          .map((p) => (
            <p key={p.taskId} className="tabular">
              {p.title}: authorised {moneyExact(p.authorised)}
              {p.extras ? ` (extras ${moneyExact(p.extras)})` : ""}
              {p.rateChanges ? ` (rate changes ${moneyExact(p.rateChanges)})` : ""}, approved {moneyExact(p.approved)}, claimed {moneyExact(p.claimed)}, claimable now{" "}
              {moneyExact(p.claimable)}, not yet approved {moneyExact(p.notApproved)}
              {p.note ? `. ${p.note}` : ""}
            </p>
          ))}
      </div>
    </div>
  );
}

function Materials({ d }: { d: CardData }) {
  if (!d.materials.length && !d.plan?.materialsLocation) return null;
  return (
    <div className="text-xs">
      <p className="label-xs mb-1">Materials for the remaining work</p>
      {d.plan?.materialsLocation ? <p>Kept at: {d.plan.materialsLocation}</p> : <p className="text-[var(--warning)]">Where the remaining material is kept is not recorded.</p>}
      {d.materials.map((m) => (
        <p key={m.id}>
          {m.description}: {qtyText(m.qty ?? 0)} {m.unit}, {m.status}
        </p>
      ))}
    </div>
  );
}

function Wording({ d }: { d: CardData }) {
  const kind = d.plan?.kind === "hold" ? "hold" : "planned";
  const text = d.wording[kind];
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="rounded-lg bg-secondary/50 p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="label-xs">Wording for the customer</p>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-primary hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function ReassignAndCancel({ d }: { d: CardData }) {
  const [reassign, setReassign] = React.useState<number | null>(null);
  const [cancelling, setCancelling] = React.useState(false);
  const cancel = useCancelStages();
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const tasks = d.tasks.filter((t) => t.mode === "lines" || t.mode === "flat" || t.mode === "hourly");
  const hasOpen = d.stages.some((s) => s.status !== "complete");
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs">
      {hasOpen && d.plan?.status === "agreed"
        ? tasks.map((t) => (
            <button key={t.taskId} type="button" className="text-primary hover:underline" onClick={() => setReassign(t.taskId)}>
              Give remaining work on {t.title} to another installer
            </button>
          ))
        : null}
      <button type="button" className="ml-auto text-destructive hover:underline" onClick={() => setCancelling(true)}>
        Cancel staging
      </button>
      {reassign != null ? <ReassignModal d={d} taskId={reassign} onClose={() => setReassign(null)} /> : null}
      <Modal
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel the staging"
        subtitle="Invoices already raised stay as they are. Finished stages stay in the history."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCancelling(false)}>
              Close
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim() || cancel.isPending}
              onClick={() => cancel.mutate({ planId: d.plan!.id, reason }, { onSuccess: () => setCancelling(false), onError: (e) => setErr(errorText(e)) })}
            >
              Cancel staging
            </Button>
          </div>
        }
      >
        <Field label="Why">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
      </Modal>
    </div>
  );
}

function ReassignModal({ d, taskId, onClose }: { d: CardData; taskId: number; onClose: () => void }) {
  const tp = d.tasks.find((t) => t.taskId === taskId)!;
  const installers = useInstallers();
  const go = useReassignRemaining();
  const [to, setTo] = React.useState<number | null>(null);
  const [changeRates, setChangeRates] = React.useState(false);
  const [rates, setRates] = React.useState<Record<string, string>>(() => Object.fromEntries(tp.lines.map((l) => [l.lineKey, String(l.rate ?? "")])));
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const list = (installers.data ?? []).filter((i) => i.id !== tp.installerId);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Remaining work on ${tp.title}`}
      subtitle={`${tp.installerName ?? "The first installer"} keeps the pay for the stages he finished. Only the open stages move.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={to == null || go.isPending || (changeRates && !note.trim())}
            onClick={() => {
              setErr(null);
              const r = changeRates ? tp.lines.map((l) => ({ lineKey: l.lineKey, rate: num(rates[l.lineKey] ?? "") ?? -1 })) : null;
              if (r?.some((x) => x.rate < 0)) return setErr("Type a rate for every line.");
              go.mutate({ planId: d.plan!.id, taskId, toInstallerId: to!, rates: r, note }, { onSuccess: onClose, onError: (e) => setErr(errorText(e)) });
            }}
          >
            Move remaining work
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="New installer">
          <Select value={to ?? ""} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Choose</option>
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        {tp.mode !== "hourly" ? (
          <label htmlFor="st-change-rates" className="flex items-center gap-2 text-xs">
            <Checkbox id="st-change-rates" checked={changeRates} onChange={(e) => setChangeRates(e.target.checked)} /> The office has decided on a different rate for the new installer
          </label>
        ) : null}
        {changeRates
          ? tp.lines.map((l) => (
              <div key={l.lineKey} className="grid grid-cols-[1fr_110px] items-center gap-2">
                <span className="text-xs">
                  {l.description} (was {moneyExact(l.rate)} per {l.unit})
                </span>
                <Input inputMode="decimal" value={rates[l.lineKey] ?? ""} onChange={(e) => setRates({ ...rates, [l.lineKey]: e.target.value })} />
              </div>
            ))
          : null}
        <Field label={changeRates ? "The office decision (required)" : "Note"}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err ? <p className="text-xs text-destructive">{err}</p> : null}
      </div>
    </Modal>
  );
}

/* --------------------------------- setup -------------------------------- */

type Draft = StagePlanInput;
type DraftStage = Draft["stages"][number];

function SetupModal({ data, onClose }: { data: CardData; onClose: () => void }) {
  const save = useSaveStages();
  const [draft, setDraft] = React.useState<Draft | null>(() => (data.input ? (structuredClone(data.input) as Draft) : null));
  const [err, setErr] = React.useState<string | null>(null);
  const [prev, setPrev] = React.useState<CardData | null>(null);
  const [prevErr, setPrevErr] = React.useState<string | null>(null);
  const locked = data.stages.filter((s) => s.status === "complete").length;

  // No plan yet: start from a proposal with every quantity in the last stage.
  React.useEffect(() => {
    if (draft) return;
    proposeStages(data.jobId, "hold")
      .then((p) => setDraft(p as Draft))
      .catch((e) => setErr(errorText(e)));
  }, [data.jobId, draft]);

  // The preview and every check, a moment after typing stops. Writes nothing.
  const key = JSON.stringify(draft);
  React.useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      previewStages(draft)
        .then((r) => {
          setPrev(r);
          setPrevErr(null);
        })
        .catch((e) => setPrevErr(errorText(e)));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!draft) {
    return (
      <Modal open onClose={onClose} title="Split into stages / Record partial completion">
        {err ? <p className="text-sm text-destructive">{err}</p> : <Loading />}
      </Modal>
    );
  }

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setStage = (i: number, patch: Partial<DraftStage>) => set({ stages: draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const last = draft.stages.length - 1;

  /** A quantity in one stage. Typing in any stage but the last puts what is left in the last one. */
  const setLineQty = (i: number, quoteItemId: number, total: number, value: number | null) => {
    const stages = draft.stages.map((s) => ({ ...s, lines: [...s.lines] }));
    const put = (s: DraftStage, qty: number) => {
      const at = s.lines.findIndex((l) => l.quoteItemId === quoteItemId);
      if (at >= 0) s.lines[at] = { ...s.lines[at]!, qty };
      else s.lines.push({ quoteItemId, qty });
    };
    put(stages[i]!, value ?? 0);
    if (i !== last && last >= locked) {
      const others = stages.slice(0, last).reduce((sum, s) => sum + (s.lines.find((l) => l.quoteItemId === quoteItemId)?.qty ?? 0), 0);
      put(stages[last]!, Math.max(0, +(total - others).toFixed(4)));
    }
    set({ stages });
  };
  const setPayQty = (i: number, taskId: number, lineKey: string, total: number, field: "qty" | "estimatedHours", value: number | null) => {
    const stages = draft.stages.map((s) => ({ ...s, pay: [...s.pay] }));
    const put = (s: DraftStage, v: number) => {
      const at = s.pay.findIndex((p) => p.taskId === taskId && p.lineKey === lineKey);
      if (at >= 0) s.pay[at] = { ...s.pay[at]!, [field]: v };
      else s.pay.push({ taskId, lineKey, qty: 0, [field]: v });
    };
    put(stages[i]!, value ?? 0);
    if (field === "qty" && i !== last && last >= locked) {
      const others = stages.slice(0, last).reduce((sum, s) => sum + (s.pay.find((p) => p.taskId === taskId && p.lineKey === lineKey)?.qty ?? 0), 0);
      put(stages[last]!, Math.max(0, +(total - others).toFixed(4)));
    }
    set({ stages });
  };
  const addStage = () => {
    const n = draft.stages.length + 1;
    set({
      stages: [
        ...draft.stages,
        {
          name: `Stage ${n}`,
          scope: "",
          plannedDate: null,
          awaitingReadiness: true,
          lines: data.quoteLabour.map((l) => ({ quoteItemId: l.quoteItemId, qty: 0 })),
          pay: draft.stages[last]?.pay.map((p) => ({ taskId: p.taskId, lineKey: p.lineKey, qty: 0 })) ?? [],
        },
      ],
    });
  };
  const removeStage = (i: number) => {
    // Its quantities go back to the stage before, so nothing quoted is lost.
    const gone = draft.stages[i]!;
    const to = draft.stages[i - 1]!;
    const merged: DraftStage = {
      ...to,
      lines: to.lines.map((l) => ({ ...l, qty: +(l.qty + (gone.lines.find((g) => g.quoteItemId === l.quoteItemId)?.qty ?? 0)).toFixed(4), amountInc: null })),
      pay: to.pay.map((p) => ({ ...p, qty: +(p.qty + (gone.pay.find((g) => g.taskId === p.taskId && g.lineKey === p.lineKey)?.qty ?? 0)).toFixed(4), amount: null })),
    };
    set({ stages: draft.stages.flatMap((s, j) => (j === i ? [] : j === i - 1 ? [merged] : [s])) });
  };

  const issues = prev?.built?.issues ?? [];
  const notes = prev?.built?.notes ?? [];
  const split = data.split;
  const payTasks = data.tasks;

  return (
    <Modal
      open
      onClose={onClose}
      title="Split into stages / Record partial completion"
      subtitle="The accepted quote is not changed. The prices stay the same and there is no extra fee."
      width="max-w-4xl"
      footer={
        <div className="flex items-center justify-end gap-2">
          {err ? <span className="mr-auto text-xs text-destructive">{err}</span> : null}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={save.isPending || issues.length > 0}
            onClick={() => {
              setErr(null);
              save.mutate(draft, { onSuccess: onClose, onError: (e) => setErr(errorText(e)) });
            }}
          >
            {save.isPending ? <Spinner className="size-3" /> : null} Save {data.plan?.status === "agreed" ? "changes" : "as draft"}
          </Button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">
        {/* what kind, why, who */}
        <section className="grid gap-3 md:grid-cols-2">
          <Field label="Type">
            <Select value={draft.kind} onChange={(e) => set({ kind: e.target.value as Draft["kind"] })}>
              {Object.entries(data.labels.kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason">
            <Select value={draft.reason} onChange={(e) => set({ reason: e.target.value as Draft["reason"] })}>
              {Object.entries(data.labels.reasons).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reason detail">
            <Input value={draft.reasonNote} onChange={(e) => set({ reasonNote: e.target.value })} />
          </Field>
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <Field label="Requested by">
              <Input value={draft.requestedBy} onChange={(e) => set({ requestedBy: e.target.value })} />
            </Field>
            <Field label="Requested on">
              <DateField value={draft.requestedOn ?? ""} onChange={(e) => set({ requestedOn: e.target.value || null })} />
            </Field>
          </div>
          <Field label="Arrangement agreed" className="md:col-span-2">
            <Textarea rows={2} value={draft.arrangement} onChange={(e) => set({ arrangement: e.target.value })} />
          </Field>
          <Field label="Follow-up date" hint="Required while a stage is awaiting readiness.">
            <DateField value={draft.followUpDate ?? ""} onChange={(e) => set({ followUpDate: e.target.value || null })} />
          </Field>
          <Field label="Where the remaining material is kept">
            <Input value={draft.materialsLocation} onChange={(e) => set({ materialsLocation: e.target.value })} />
          </Field>
          {data.variations.length ? (
            <Field label="Approved variations are billed" className="md:col-span-2">
              <Select value={draft.variationTiming} onChange={(e) => set({ variationTiming: e.target.value as Draft["variationTiming"] })}>
                {Object.entries(data.labels.variationTimings).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </section>

        {/* the selling split */}
        {split ? (
          <section className="rounded-lg border border-border p-3">
            <p className="label-xs">Materials and labour from the accepted quote {split.quoteRef}</p>
            <p className="mt-1 text-xs">
              Quote total {moneyExact(split.quoteTotal)}. From the quote lines: materials {moneyExact(split.materialsInc)}, labour {moneyExact(split.labourInc)} inc GST
              {split.roundingOnLabour ? ` (includes ${moneyExact(split.roundingOnLabour)} rounding on labour)` : ""}.
            </p>
            {split.bundled ? <p className="mt-1 text-xs text-[var(--warning)]">The quote shows a bundled price, so the office must approve the split before it is used.</p> : null}
            {split.issue ? <p className="mt-1 text-xs text-destructive">{split.issue}</p> : null}
            <label className="mt-2 flex items-center gap-2 text-xs">
              <Checkbox
                checked={draft.split != null}
                onChange={(e) =>
                  set({ split: e.target.checked ? { materialsInc: split.materialsInc ?? 0, labourInc: split.labourInc ?? 0, note: "" } : null, approveSplit: false })
                }
              />{" "}
              Type a different split
            </label>
            {draft.split ? (
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                <Field label="Materials inc GST">
                  <Input inputMode="decimal" value={String(draft.split.materialsInc)} onChange={(e) => set({ split: { ...draft.split!, materialsInc: num(e.target.value) ?? 0 } })} />
                </Field>
                <Field label="Labour inc GST">
                  <Input inputMode="decimal" value={String(draft.split.labourInc)} onChange={(e) => set({ split: { ...draft.split!, labourInc: num(e.target.value) ?? 0 } })} />
                </Field>
                <Field label="Why">
                  <Input value={draft.split.note} onChange={(e) => set({ split: { ...draft.split!, note: e.target.value } })} />
                </Field>
              </div>
            ) : null}
            {split.needsApproval || draft.split ? (
              <label className="mt-2 flex items-center gap-2 text-xs font-medium">
                <Checkbox checked={draft.approveSplit} onChange={(e) => set({ approveSplit: e.target.checked })} /> Office approves this split (it must add back to {moneyExact(split.quoteTotal)})
              </label>
            ) : null}
          </section>
        ) : null}

        {/* the stages */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="label-xs">Stages</p>
            <Button size="sm" variant="outline" onClick={addStage}>
              <Plus className="size-3.5" /> Add a stage
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Type what is in each stage. The last stage takes whatever is left, so every quoted quantity sits in one stage.</p>
          {draft.stages.map((s, i) => {
            const isLocked = i < locked;
            return (
              <div key={i} className={`rounded-lg border p-3 ${isLocked ? "border-border bg-secondary/40" : "border-border"}`}>
                <div className="grid gap-2 md:grid-cols-[1fr_160px_auto_auto]">
                  <Input disabled={isLocked} value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} placeholder={`Stage ${i + 1}`} />
                  <DateField disabled={isLocked || s.awaitingReadiness} value={s.plannedDate ?? ""} onChange={(e) => setStage(i, { plannedDate: e.target.value || null })} />
                  <label htmlFor={`st-await-${i}`} className="flex items-center gap-1.5 text-xs">
                    <Checkbox id={`st-await-${i}`} disabled={isLocked} checked={s.awaitingReadiness} onChange={(e) => setStage(i, { awaitingReadiness: e.target.checked, plannedDate: e.target.checked ? null : s.plannedDate })} />
                    Awaiting readiness
                  </label>
                  {!isLocked && i >= Math.max(1, locked) && draft.stages.length > 2 ? (
                    <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove stage" onClick={() => removeStage(i)}>
                      <Trash2 className="size-4" />
                    </button>
                  ) : (
                    <span />
                  )}
                </div>
                {isLocked ? <p className="mt-1 text-xs text-muted-foreground">Finished. It cannot be changed.</p> : null}
                <Textarea className="mt-2" rows={1} disabled={isLocked} value={s.scope} placeholder="Areas in this stage, e.g. lounge and hallway" onChange={(e) => setStage(i, { scope: e.target.value })} />
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Customer labour (quantity, and an amount if it is not pro rata)</p>
                    {data.quoteLabour.map((l) => {
                      const cur = s.lines.find((x) => x.quoteItemId === l.quoteItemId);
                      return (
                        <div key={l.quoteItemId} className="grid grid-cols-[1fr_80px_90px] items-center gap-1.5">
                          <span className="truncate text-xs" title={l.description}>
                            {l.description} of {qtyText(l.qty)} {l.unit}
                          </span>
                          <Input disabled={isLocked} inputMode="decimal" value={qtyText(cur?.qty ?? 0)} onChange={(e) => setLineQty(i, l.quoteItemId, l.qty, num(e.target.value))} />
                          <Input
                            disabled={isLocked}
                            inputMode="decimal"
                            placeholder="auto"
                            value={cur?.amountInc != null ? String(cur.amountInc) : ""}
                            onChange={(e) => setStage(i, { lines: s.lines.map((x) => (x.quoteItemId === l.quoteItemId ? { ...x, amountInc: num(e.target.value) } : x)) })}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">Installer pay (quantity, or estimated hours for hourly work)</p>
                    {payTasks.map((t) =>
                      t.mode === "lines" || t.mode === "flat" ? (
                        t.lines.map((l) => {
                          const cur = s.pay.find((p) => p.taskId === t.taskId && p.lineKey === l.lineKey);
                          return (
                            <div key={`${t.taskId}:${l.lineKey}`} className="grid grid-cols-[1fr_80px] items-center gap-1.5">
                              <span className="truncate text-xs" title={l.description}>
                                {t.installerName ?? "Unassigned"}: {l.description} of {qtyText(l.qty)} {l.unit}
                              </span>
                              <Input disabled={isLocked} inputMode="decimal" value={qtyText(cur?.qty ?? 0)} onChange={(e) => setPayQty(i, t.taskId, l.lineKey, l.qty, "qty", num(e.target.value))} />
                            </div>
                          );
                        })
                      ) : t.mode === "hourly" ? (
                        <div key={`${t.taskId}:hourly`} className="grid grid-cols-[1fr_80px] items-center gap-1.5">
                          <span className="text-xs">{t.installerName ?? "Unassigned"}: estimated hours (timesheets decide the pay)</span>
                          <Input
                            disabled={isLocked}
                            inputMode="decimal"
                            value={String(s.pay.find((p) => p.taskId === t.taskId && p.lineKey === "hourly")?.estimatedHours ?? "")}
                            onChange={(e) => setPayQty(i, t.taskId, "hourly", 0, "estimatedHours", num(e.target.value))}
                          />
                        </div>
                      ) : i === 0 ? (
                        <p key={t.taskId} className="text-xs text-muted-foreground">
                          {t.title}: {t.note}
                        </p>
                      ) : null,
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        {/* checks and the preview */}
        {prevErr ? <p className="text-xs text-destructive">{prevErr}</p> : null}
        {issues.length ? (
          <ul className="list-disc rounded-lg bg-destructive/5 p-3 pl-7 text-xs text-destructive">
            {issues.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : null}
        {notes.length ? (
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {notes.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : null}
        {prev?.preview ? (
          <section>
            <p className="label-xs mb-1">Preview</p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary/60 text-left">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Area</th>
                    <th className="px-2 py-1.5 font-medium">Completed or current stage{prev.preview.currentName ? ` (${prev.preview.currentName})` : ""}</th>
                    <th className="px-2 py-1.5 font-medium">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {prev.preview.rows.map((r) => (
                    <tr key={r.row} className="border-t border-border align-top">
                      <td className="px-2 py-1.5 font-medium">{r.label}</td>
                      <td className="px-2 py-1.5">{r.current}</td>
                      <td className="px-2 py-1.5">{r.remaining}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}
