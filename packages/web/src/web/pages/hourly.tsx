import * as React from "react";
import { Link, useSearch } from "wouter";
import { AlertTriangle, Clock, History, Plus } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { useBootstrap } from "../queries/settings";
import { useInstallers } from "../queries/installers";
import {
  STATUS_COLOUR,
  STATUS_LABEL,
  dayLabel,
  fromLocalInput,
  hm,
  hours,
  money,
  toLocalInput,
  useAddPayTerms,
  useApproveTime,
  useCorrectTime,
  useDecideBreak,
  useHourlyQueue,
  useHourlySettings,
  useHourlyWorkers,
  useManualTime,
  usePayTerms,
  useRejectTime,
  useSaveHourlySettings,
  useSaveVehicle,
  useTimeHistory,
  useUnapproveTime,
  useVehicleNames,
  useVehicles,
  useWorkerTasks,
  type QueueStatus,
} from "../queries/hourly";

/**
 * Hourly time: the office checks, corrects and approves what the phone
 * recorded. Nothing is paid until it is approved here, and nothing undecided
 * (a break, a travel category, a rate band) is ever quietly dropped: it sits
 * here, blocking, until someone decides it.
 */
export default function HourlyPage() {
  const boot = useBootstrap();
  const actor = boot.data?.actor;
  const canSeeCosts = Boolean(actor?.canSeeCosts);
  const isAdmin = actor?.role === "admin";
  const [tab, setTab] = React.useState<"time" | "vehicles" | "settings" | "terms">("time");
  const tabs = [
    { id: "time" as const, label: "Time to check", show: true },
    { id: "vehicles" as const, label: "Vehicles", show: canSeeCosts },
    { id: "settings" as const, label: "Settings", show: canSeeCosts },
    { id: "terms" as const, label: "Pay terms", show: isAdmin },
  ].filter((t) => t.show);

  return (
    <Page title="Hourly time" subtitle="Time recorded on the phone. Check it, fix it if needed, then approve it. Only approved time is paid.">
      <div className="mx-auto grid max-w-[1400px] gap-4 px-6 py-5">
        <div className="flex flex-wrap gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t.id ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-secondary/80"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "time" ? <TimeTab canSeeCosts={canSeeCosts} /> : null}
        {tab === "vehicles" && canSeeCosts ? <VehiclesTab /> : null}
        {tab === "settings" && canSeeCosts ? <SettingsTab isAdmin={isAdmin} /> : null}
        {tab === "terms" && isAdmin ? <TermsTab /> : null}
      </div>
    </Page>
  );
}

/* ================================================================== *
 * Time
 * ================================================================== */

type Queue = NonNullable<ReturnType<typeof useHourlyQueue>["data"]>;
type Row = Queue["rows"][number];

function TimeTab({ canSeeCosts }: { canSeeCosts: boolean }) {
  const search = new URLSearchParams(useSearch());
  const jobParam = search.get("job");
  const [status, setStatus] = React.useState<QueueStatus>("todo");
  const [installerId, setInstallerId] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const workers = useHourlyWorkers();
  const q = useHourlyQueue({ status, installerId: installerId ? Number(installerId) : undefined, jobId: jobParam ? Number(jobParam) : undefined });
  const d = q.data;

  return (
    <>
      {d?.pending.length ? (
        <div className="rounded-md bg-[#B7791F]/10 px-4 py-3 text-xs text-[#8a5a12]">
          <p className="flex items-center gap-1.5 font-semibold">
            <AlertTriangle className="size-3.5" /> Business answers still needed. Time they affect can't be approved until each is decided.
          </p>
          <ul className="mt-1 list-disc pl-5">
            {d.pending.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <CardHeader
          title="Time entries"
          subtitle={
            jobParam ? (
              <>
                One job only. <Link href="/hourly" className="text-primary hover:underline">Show every job</Link>
              </>
            ) : (
              "Oldest first. Times are Brisbane time."
            )
          }
          action={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Show" className="w-[150px]">
                <Select value={status} onChange={(e) => setStatus(e.target.value as QueueStatus)} className="h-8">
                  <option value="todo">To check</option>
                  <option value="approved">Approved</option>
                  <option value="rejected">Rejected</option>
                  <option value="all">Everything</option>
                </Select>
              </Field>
              <Field label="Worker" className="w-[170px]">
                <Select value={installerId} onChange={(e) => setInstallerId(e.target.value)} className="h-8">
                  <option value="">Everyone hourly</option>
                  {(workers.data ?? []).map((w) => (
                    <option key={w.installerId} value={w.installerId}>
                      {w.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-3.5" /> Add missed time
              </Button>
            </div>
          }
        />
        {q.isLoading ? (
          <Loading />
        ) : !d || !d.rows.length ? (
          <Empty>{status === "todo" ? "Nothing waiting to be checked." : "No time entries here."}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {d.rows.map((r) => (
              <SessionRow key={r.id} r={r} q={d} canSeeCosts={canSeeCosts} />
            ))}
          </ul>
        )}
      </Card>
      {adding ? <ManualModal onClose={() => setAdding(false)} categories={d?.categories ?? []} /> : null}
    </>
  );
}

const BAND_BLOCKER = /^Rate band not confirmed|^Confirmed band minutes/;

function SessionRow({ r, q, canSeeCosts }: { r: Row; q: Queue; canSeeCosts: boolean }) {
  const [mode, setMode] = React.useState<null | "correct" | "reject" | "unapprove" | "history">(null);
  const decide = useDecideBreak();
  const approve = useApproveTime();
  const split = r.confirmedSplit ?? r.suggestedSplit;
  const [mins, setMins] = React.useState<Record<string, string>>(() => Object.fromEntries(q.bands.map((b) => [b.id, String(split.find((s) => s.band === b.id)?.minutes ?? 0)])));
  React.useEffect(() => {
    setMins(Object.fromEntries(q.bands.map((b) => [b.id, String(split.find((s) => s.band === b.id)?.minutes ?? 0)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(split), r.payableMinutes]);
  const others = r.blockers.filter((b) => !BAND_BLOCKER.test(b));
  const sum = Object.values(mins).reduce((a, v) => a + (Number(v) || 0), 0);
  const editable = r.status === "open" || r.status === "recorded";
  const label = (band: string) => q.bands.find((b) => b.id === band)?.label ?? band;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{dayLabel(r.workDate)}</span>
            <span className="text-sm">{r.installerName}</span>
            <span className="tabular text-xs text-muted-foreground">{r.taskRef}</span>
            <span className="text-xs text-muted-foreground">{r.taskTitle}</span>
            <Badge colour={STATUS_COLOUR[r.status]}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
            {r.category !== "site" ? <Badge colour={r.categoryPay === "pending" ? "#B7791F" : undefined}>{r.categoryLabel}</Badge> : null}
            {r.source === "office" ? <Badge>office entry</Badge> : null}
            {r.corrected ? <Badge colour="#2F6690">corrected</Badge> : null}
            {r.invoiceId ? <Badge colour="#3E6B4F">billed</Badge> : null}
          </div>
          <p className="mt-1 text-xs">
            <span className="tabular font-medium">
              {hm(r.start)} to {hm(r.end)}
            </span>
            {r.corrected ? (
              <span className="text-muted-foreground">
                {" "}
                (phone recorded {hm(r.recordedStart)} to {hm(r.recordedEnd)})
              </span>
            ) : null}
            <span className="text-muted-foreground">
              {" "}
              · {hours(r.payableMinutes)} payable
              {r.unpaidBreakMinutes ? ` · ${hours(r.unpaidBreakMinutes)} unpaid break` : ""}
              {r.paidBreakMinutes ? ` · ${hours(r.paidBreakMinutes)} paid break` : ""}
              {r.vehicleName ? ` · ${r.vehicleName}` : " · no vehicle"}
            </span>
          </p>
          {r.correctionRequestedAt ? (
            <p className="mt-1 text-xs text-[#2F6690]">
              He asked for a fix: "{r.correctionNote}"
            </p>
          ) : null}
          {r.note && r.source === "office" ? <p className="mt-0.5 text-xs text-muted-foreground">Why entered: {r.note}</p> : null}

          {r.breaks.length ? (
            <div className="mt-1.5 flex flex-wrap gap-2">
              {r.breaks.map((b) => (
                <span key={b.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                  Break {hm(b.start)} to {hm(b.end)}
                  {b.effectivePaid == null ? (
                    editable ? (
                      <>
                        <button type="button" className="font-medium text-primary hover:underline" disabled={decide.isPending} onClick={() => decide.mutate({ breakId: b.id, paid: true })}>
                          paid
                        </button>
                        <button type="button" className="font-medium text-primary hover:underline" disabled={decide.isPending} onClick={() => decide.mutate({ breakId: b.id, paid: false })}>
                          unpaid
                        </button>
                      </>
                    ) : (
                      <span className="text-[#B7791F]">undecided</span>
                    )
                  ) : (
                    <span className={b.effectivePaid ? "text-[#3E6B4F]" : "text-muted-foreground"}>
                      {b.effectivePaid ? "paid" : "unpaid"}
                      {b.paid == null ? " (policy)" : ""}
                    </span>
                  )}
                  {b.paid != null && editable ? (
                    <button type="button" className="text-muted-foreground hover:underline" onClick={() => decide.mutate({ breakId: b.id, paid: null })}>
                      undo
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {decide.error ? <p className="mt-1 text-xs text-destructive">{decide.error.message}</p> : null}

          {others.length ? (
            <ul className="mt-1.5 space-y-0.5 text-xs text-[#8a5a12]">
              {others.map((b) => (
                <li key={b} className="flex items-start gap-1">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {b}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="text-right text-xs">
          {r.status === "approved" ? (
            <>
              <p className="tabular">
                {hours(r.approvedMinutes)} approved{r.payable === false ? " (unpaid time)" : ""}
              </p>
              {canSeeCosts ? <p className="tabular text-sm font-semibold">{money(r.approvedPay)}</p> : null}
              {r.payLines ? (
                <p className="text-muted-foreground">
                  {r.payLines.map((l) => `${label(l.band)} ${hours(l.minutes)}${canSeeCosts ? ` at ${money(l.rate)}` : ""}`).join(", ")}
                </p>
              ) : null}
              <p className="text-muted-foreground">by {r.approvedByName}</p>
            </>
          ) : canSeeCosts && r.estimate ? (
            <p className="tabular text-muted-foreground">about {money(r.estimate.total)} at today's terms</p>
          ) : null}
        </div>
      </div>

      {r.status === "recorded" ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-secondary/50 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {r.confirmedSplit ? `Band confirmed by ${r.bandConfirmedBy}.` : q.nightWindow ? "Suggested from the night hours setting." : "Night hours not set: confirm the band."}
          </span>
          {q.bands.map((b) => (
            <Field key={b.id} label={`${b.label} minutes`} className="w-[120px]">
              <Input type="number" min={0} step={1} value={mins[b.id] ?? "0"} onChange={(e) => setMins({ ...mins, [b.id]: e.target.value })} className="h-8" />
            </Field>
          ))}
          <span className={`text-xs ${sum === r.payableMinutes ? "text-muted-foreground" : "text-destructive"}`}>
            {sum} of {r.payableMinutes} min
          </span>
          <Button
            size="sm"
            disabled={approve.isPending || others.length > 0 || sum !== r.payableMinutes}
            onClick={() =>
              approve.mutate({
                sessionId: r.id,
                split: q.bands.map((b) => ({ band: b.id, minutes: Number(mins[b.id]) || 0 })).filter((p) => p.minutes > 0),
              })
            }
          >
            Approve
          </Button>
          {others.length ? <span className="text-xs text-[#8a5a12]">Clear the items above first.</span> : null}
          {approve.error ? <p className="w-full text-xs text-destructive">{approve.error.message}</p> : null}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-3 text-xs">
        {editable ? (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setMode("correct")}>
            Correct times
          </button>
        ) : null}
        {editable ? (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setMode("reject")}>
            Reject (not real time)
          </button>
        ) : null}
        {r.status === "approved" && !r.invoiceId ? (
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setMode("unapprove")}>
            Un-approve
          </button>
        ) : null}
        <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:underline" onClick={() => setMode("history")}>
          <History className="size-3" /> History
        </button>
      </div>

      {mode === "correct" ? <CorrectModal r={r} categories={q.categories} onClose={() => setMode(null)} /> : null}
      {mode === "reject" || mode === "unapprove" ? <ReasonModal r={r} kind={mode} onClose={() => setMode(null)} /> : null}
      {mode === "history" ? <HistoryModal sessionId={r.id} onClose={() => setMode(null)} /> : null}
    </li>
  );
}

function CorrectModal({ r, categories, onClose }: { r: Row; categories: Queue["categories"]; onClose: () => void }) {
  const correct = useCorrectTime();
  const tasks = useWorkerTasks(r.installerId);
  const vehicles = useVehicleNames();
  const [start, setStart] = React.useState(toLocalInput(r.start));
  const [end, setEnd] = React.useState(toLocalInput(r.end));
  const [taskId, setTaskId] = React.useState(String(r.taskId));
  const [category, setCategory] = React.useState(r.category);
  const [vehicleId, setVehicleId] = React.useState(r.vehicleId ? String(r.vehicleId) : "");
  const [reason, setReason] = React.useState("");
  const save = () =>
    correct.mutate(
      {
        sessionId: r.id,
        start: start !== toLocalInput(r.start) ? fromLocalInput(start) : undefined,
        end: end !== toLocalInput(r.end) ? (end ? fromLocalInput(end) : null) : undefined,
        taskId: Number(taskId) !== r.taskId ? Number(taskId) : undefined,
        category: category !== r.category ? category : undefined,
        vehicleId: (vehicleId ? Number(vehicleId) : null) !== r.vehicleId ? (vehicleId ? Number(vehicleId) : null) : undefined,
        reason,
      },
      { onSuccess: onClose },
    );
  return (
    <Modal
      open
      onClose={onClose}
      title="Correct this time"
      subtitle={`${r.installerName}, ${dayLabel(r.workDate)}. The phone's times stay on record beside yours.`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={correct.isPending || reason.trim().length < 3} onClick={save}>
            Save correction
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start (Brisbane)">
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Finish (Brisbane)">
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <Field label="Task">
          <Select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            {(tasks.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.ref} {t.title}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="What the time was">
            <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vehicle">
            <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">No vehicle</option>
              {(vehicles.data ?? []).filter((v) => v.active).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Why" hint="Kept in the history with who changed it.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Pedro forgot to finish. Left site 3pm." />
        </Field>
        {correct.error ? <p className="text-xs text-destructive">{correct.error.message}</p> : null}
      </div>
    </Modal>
  );
}

function ReasonModal({ r, kind, onClose }: { r: Row; kind: "reject" | "unapprove"; onClose: () => void }) {
  const reject = useRejectTime();
  const unapprove = useUnapproveTime();
  const m = kind === "reject" ? reject : unapprove;
  const [reason, setReason] = React.useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === "reject" ? "Reject this time" : "Un-approve this time"}
      subtitle={kind === "reject" ? "For a test tap or a duplicate. It stays on record, never paid." : "Back to 'to check' so it can be corrected and approved again."}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === "reject" ? "destructive" : "default"}
            disabled={m.isPending || reason.trim().length < 3}
            onClick={() => (kind === "reject" ? reject : unapprove).mutate({ sessionId: r.id, reason }, { onSuccess: onClose })}
          >
            {kind === "reject" ? "Reject" : "Un-approve"}
          </Button>
        </div>
      }
    >
      <Field label="Why">
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      {m.error ? <p className="mt-2 text-xs text-destructive">{m.error.message}</p> : null}
    </Modal>
  );
}

const ACTION_LABEL: Record<string, string> = {
  start: "Started on the phone",
  break_start: "Break",
  break_end: "Back from break",
  finish: "Finished for the day",
  correction_requested: "Asked for a fix",
  corrected: "Corrected",
  band_confirmed: "Band confirmed",
  break_decided: "Break decided",
  approved: "Approved",
  unapproved: "Un-approved",
  rejected: "Rejected",
  manual_entry: "Entered by the office",
};

function HistoryModal({ sessionId, onClose }: { sessionId: number; onClose: () => void }) {
  const h = useTimeHistory(sessionId);
  const show = (v: string | null) => {
    if (!v) return null;
    try {
      const o = JSON.parse(v) as Record<string, unknown>;
      if (o && typeof o === "object" && ("start" in o || "end" in o)) {
        return `${hm((o.start as string) ?? null)} to ${hm((o.end as string) ?? null)}`;
      }
      return JSON.stringify(o);
    } catch {
      return v;
    }
  };
  return (
    <Modal open onClose={onClose} title="Who changed what" width="max-w-2xl">
      {h.isLoading ? (
        <Loading />
      ) : !h.data?.length ? (
        <Empty>No history.</Empty>
      ) : (
        <ul className="divide-y divide-border text-xs">
          {h.data.map((e) => (
            <li key={e.id} className="py-2">
              <p>
                <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span> by {e.actorName} ({e.actorRole}),{" "}
                {new Date(e.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" })}
              </p>
              {e.action === "corrected" ? (
                <p className="text-muted-foreground">
                  {show(e.before)} became {show(e.after)}
                </p>
              ) : null}
              {e.reason ? <p className="text-muted-foreground">Why: {e.reason}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function ManualModal({ onClose, categories }: { onClose: () => void; categories: Queue["categories"] }) {
  const manual = useManualTime();
  const workers = useHourlyWorkers();
  const vehicles = useVehicleNames();
  const [installerId, setInstallerId] = React.useState("");
  const tasks = useWorkerTasks(installerId ? Number(installerId) : null);
  const [taskId, setTaskId] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [category, setCategory] = React.useState("site");
  const [vehicleId, setVehicleId] = React.useState("");
  const [bStart, setBStart] = React.useState("");
  const [bEnd, setBEnd] = React.useState("");
  const [reason, setReason] = React.useState("");
  const ready = installerId && taskId && start && end && reason.trim().length >= 3 && (!bStart === !bEnd);
  return (
    <Modal
      open
      onClose={onClose}
      title="Add time the phone missed"
      subtitle="No signal, or he forgot the app. It goes in as 'to check', never straight to approved."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready || manual.isPending}
            onClick={() =>
              manual.mutate(
                {
                  installerId: Number(installerId),
                  taskId: Number(taskId),
                  start: fromLocalInput(start),
                  end: fromLocalInput(end),
                  category: category as (typeof categories)[number]["id"],
                  vehicleId: vehicleId ? Number(vehicleId) : null,
                  breaks: bStart && bEnd ? [{ start: fromLocalInput(bStart), end: fromLocalInput(bEnd), paid: null }] : [],
                  reason,
                },
                { onSuccess: onClose },
              )
            }
          >
            Add time
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Worker">
            <Select value={installerId} onChange={(e) => (setInstallerId(e.target.value), setTaskId(""))}>
              <option value="">Pick</option>
              {(workers.data ?? []).map((w) => (
                <option key={w.installerId} value={w.installerId}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Task">
            <Select value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!installerId}>
              <option value="">Pick</option>
              {(tasks.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.ref} {t.title}
                  {t.hourly ? "" : " (not hourly)"}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Start (Brisbane)">
            <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Finish (Brisbane)">
            <Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          <Field label="Break start (optional)">
            <Input type="datetime-local" value={bStart} onChange={(e) => setBStart(e.target.value)} />
          </Field>
          <Field label="Break end">
            <Input type="datetime-local" value={bEnd} onChange={(e) => setBEnd(e.target.value)} />
          </Field>
          <Field label="What the time was">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vehicle">
            <Select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
              <option value="">No vehicle</option>
              {(vehicles.data ?? []).filter((v) => v.active).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Why it's being entered by hand">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {manual.error ? <p className="text-xs text-destructive">{manual.error.message}</p> : null}
      </div>
    </Modal>
  );
}

/* ================================================================== *
 * Vehicles
 * ================================================================== */

type Vehicle = NonNullable<ReturnType<typeof useVehicles>["data"]>[number];

function VehiclesTab() {
  const v = useVehicles();
  const [editing, setEditing] = React.useState<Vehicle | "new" | null>(null);
  return (
    <Card>
      <CardHeader
        title="Vehicles"
        subtitle="Daily allowance is a Terra cost per vehicle per working day, split across that day's jobs by time. Never paid to the worker, never shown on the phone."
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="size-3.5" /> Add vehicle
          </Button>
        }
      />
      {v.isLoading ? (
        <Loading />
      ) : !v.data?.length ? (
        <Empty>No vehicles yet.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="label-xs px-4 py-2 font-normal">Name</th>
              <th className="label-xs px-4 py-2 font-normal">Usual driver</th>
              <th className="label-xs px-4 py-2 text-right font-normal">Daily allowance</th>
              <th className="label-xs px-4 py-2 font-normal">
                <span className="sr-only">Edit</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {v.data.map((x) => (
              <tr key={x.id} className={x.active ? "" : "opacity-60"}>
                <td className="px-4 py-2 font-medium">
                  {x.name} {x.isTest ? <Badge colour="#B4472E">test only</Badge> : null} {x.active ? null : <Badge>retired</Badge>}
                </td>
                <td className="px-4 py-2">{x.usualDriverName ?? "-"}</td>
                <td className="tabular px-4 py-2 text-right">{money(x.dailyAllowance)}</td>
                <td className="px-4 py-2 text-right">
                  <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setEditing(x)}>
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? <VehicleModal v={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function VehicleModal({ v, onClose }: { v: Vehicle | null; onClose: () => void }) {
  const save = useSaveVehicle();
  const installers = useInstallers();
  const [name, setName] = React.useState(v?.name ?? "");
  const [driver, setDriver] = React.useState(v?.usualDriverId ? String(v.usualDriverId) : "");
  const [allowance, setAllowance] = React.useState(String(v?.dailyAllowance ?? 50));
  const [isTest, setIsTest] = React.useState(v?.isTest ?? false);
  const [active, setActive] = React.useState(v?.active ?? true);
  return (
    <Modal
      open
      onClose={onClose}
      title={v ? "Edit vehicle" : "Add vehicle"}
      subtitle="A new allowance applies to days not used yet. A day already used keeps its allowance."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || save.isPending}
            onClick={() =>
              save.mutate(
                { id: v?.id, name: name.trim(), usualDriverId: driver ? Number(driver) : null, dailyAllowance: Number(allowance) || 0, isTest, active, notes: v?.notes ?? null },
                { onSuccess: onClose },
              )
            }
          >
            Save
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pedro's van" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Usual driver">
            <Select value={driver} onChange={(e) => setDriver(e.target.value)}>
              <option value="">Nobody set</option>
              {(installers.data ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Daily allowance ($)">
            <Input type="number" min={0} step="1" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
          </Field>
        </div>
        <label htmlFor="veh-is-test" className="flex items-center gap-2 text-sm">
          <Checkbox id="veh-is-test" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} /> Test record (dev only)
        </label>
        <label htmlFor="veh-active" className="flex items-center gap-2 text-sm">
          <Checkbox id="veh-active" checked={active} onChange={(e) => setActive(e.target.checked)} /> In use
        </label>
        {save.error ? <p className="text-xs text-destructive">{save.error.message}</p> : null}
      </div>
    </Modal>
  );
}

/* ================================================================== *
 * Settings
 * ================================================================== */

const POLICY_LABEL: Record<string, string> = {
  pending: "Not decided yet (each break blocks until marked)",
  per_break: "Office decides each break",
  paid: "Breaks are paid",
  unpaid: "Breaks are unpaid",
};

function SettingsTab({ isAdmin }: { isAdmin: boolean }) {
  const s = useHourlySettings();
  const save = useSaveHourlySettings();
  const [night, setNight] = React.useState<{ on: boolean; start: string; end: string } | null>(null);
  const [policy, setPolicy] = React.useState<string | null>(null);
  const [cats, setCats] = React.useState<Record<string, string> | null>(null);
  const [allowance, setAllowance] = React.useState<string | null>(null);
  const [bv, setBv] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  if (s.isLoading || !s.data) return <Loading />;
  const d = s.data;
  const n = night ?? { on: Boolean(d.nightWindow), start: d.nightWindow?.start ?? "", end: d.nightWindow?.end ?? "" };
  const c = cats ?? (d.categories as Record<string, string>);
  const dis = !isAdmin;

  return (
    <Card>
      <CardHeader title="Hourly settings" subtitle={isAdmin ? "Each answer left 'not decided' keeps blocking the time it affects." : "Admin changes these. Shown so you know what is still undecided."} />
      <div className="grid gap-5 px-4 py-4 text-sm">
        <section>
          <p className="font-medium">Night / after-hours</p>
          <p className="text-xs text-muted-foreground">Night replaces the weekend rate, never on top of it. Until set, the office confirms the band on every entry.</p>
          <div className="mt-2 flex flex-wrap items-end gap-3">
            <label htmlFor="night-set" className="flex items-center gap-2">
              <Checkbox id="night-set" disabled={dis} checked={n.on} onChange={(e) => setNight({ ...n, on: e.target.checked })} /> Night hours are set
            </label>
            {n.on ? (
              <>
                <Field label="Starts" className="w-[120px]">
                  <Input disabled={dis} type="time" value={n.start} onChange={(e) => setNight({ ...n, start: e.target.value })} />
                </Field>
                <Field label="Ends" className="w-[120px]">
                  <Input disabled={dis} type="time" value={n.end} onChange={(e) => setNight({ ...n, end: e.target.value })} />
                </Field>
              </>
            ) : (
              <Badge colour="#B7791F">not decided</Badge>
            )}
          </div>
        </section>

        <section>
          <p className="font-medium">Breaks</p>
          <Select disabled={dis} className="mt-1 max-w-md" value={policy ?? d.breakPolicy} onChange={(e) => setPolicy(e.target.value)}>
            {d.breakPolicies.map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p] ?? p}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">Nothing is ever deducted automatically.</p>
        </section>

        <section>
          <p className="font-medium">Time off site</p>
          <p className="text-xs text-muted-foreground">Which of these are paid. Home to work travel is kept separate.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {Object.entries(d.categoryLabels)
              .filter(([k]) => k !== "site")
              .map(([k, label]) => (
                <div key={k} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-1.5">
                  <span className="text-xs">{label}</span>
                  <Select disabled={dis} className="h-8 w-[150px]" value={c[k] ?? "pending"} onChange={(e) => setCats({ ...c, [k]: e.target.value })}>
                    <option value="pending">Not decided</option>
                    <option value="paid">Paid</option>
                    <option value="unpaid">Unpaid</option>
                  </Select>
                </div>
              ))}
          </div>
        </section>

        <section className="flex flex-wrap items-end gap-4">
          <Field label="Default vehicle allowance per day ($)" className="w-[240px]">
            <Input disabled={dis} type="number" min={0} value={allowance ?? String(d.vehicleAllowanceDefault)} onChange={(e) => setAllowance(e.target.value)} />
          </Field>
          <Field label="Normal subcontract price includes the vehicle?" className="w-[300px]">
            <Select disabled={dis} value={bv ?? d.benchmarkVehicleDefault} onChange={(e) => setBv(e.target.value)}>
              <option value="unknown">Not known yet (comparison provisional)</option>
              <option value="included">Yes, includes vehicle</option>
              <option value="excluded">No, excludes vehicle</option>
            </Select>
          </Field>
        </section>

        {isAdmin ? (
          <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
            <Field label="Note (kept in the history)" className="min-w-[280px] flex-1">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Damien confirmed breaks are unpaid" />
            </Field>
            <Button
              disabled={save.isPending || (n.on && (!n.start || !n.end))}
              onClick={() =>
                save.mutate(
                  {
                    nightWindow: n.on ? { start: n.start, end: n.end } : null,
                    breakPolicy: (policy ?? d.breakPolicy) as (typeof d.breakPolicies)[number],
                    categories: c as Record<string, "pending" | "paid" | "unpaid">,
                    vehicleAllowanceDefault: Number(allowance ?? d.vehicleAllowanceDefault),
                    benchmarkVehicleDefault: (bv ?? d.benchmarkVehicleDefault) as "unknown" | "included" | "excluded",
                    reason: reason || undefined,
                  },
                  { onSuccess: () => (setNight(null), setPolicy(null), setCats(null), setAllowance(null), setBv(null), setReason("")) },
                )
              }
            >
              Save settings
            </Button>
            {save.error ? <p className="w-full text-xs text-destructive">{save.error.message}</p> : null}
          </div>
        ) : null}

        {d.pending.length ? (
          <div className="rounded-md bg-[#B7791F]/10 px-3 py-2 text-xs text-[#8a5a12]">
            <p className="font-semibold">Still not decided</p>
            <ul className="mt-1 list-disc pl-4">
              {d.pending.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/* ================================================================== *
 * Pay terms
 * ================================================================== */

function TermsTab() {
  const installers = useInstallers();
  const [installerId, setInstallerId] = React.useState("");
  const terms = usePayTerms(installerId ? Number(installerId) : null);
  const add = useAddPayTerms();
  const [f, setF] = React.useState({ baseRate: "47", weekend: "1.5", night: "2", gst: false, gstNote: "", from: "", note: "" });
  const base = Number(f.baseRate) || 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;

  return (
    <Card>
      <CardHeader
        title="Hourly pay terms"
        subtitle="Effective dated. A new row ends the old one the day before. Approved time always keeps the rate it was approved at. Applies to new assignments only."
        action={
          <Field label="Worker" className="w-[220px]">
            <Select value={installerId} onChange={(e) => setInstallerId(e.target.value)} className="h-8">
              <option value="">Pick a worker</option>
              {(installers.data ?? []).map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          </Field>
        }
      />
      {!installerId ? (
        <Empty>Pick a worker to see or add his hourly terms.</Empty>
      ) : (
        <div className="grid gap-4 px-4 py-3">
          {terms.isLoading ? (
            <Loading />
          ) : !terms.data?.length ? (
            <p className="text-sm text-muted-foreground">No hourly terms. He is paid the usual way.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="label-xs py-1.5 font-normal">From</th>
                  <th className="label-xs py-1.5 font-normal">To</th>
                  <th className="label-xs py-1.5 text-right font-normal">Standard</th>
                  <th className="label-xs py-1.5 text-right font-normal">Weekend</th>
                  <th className="label-xs py-1.5 text-right font-normal">Night</th>
                  <th className="label-xs py-1.5 font-normal">GST</th>
                  <th className="label-xs py-1.5 font-normal">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {terms.data.map((t) => (
                  <tr key={t.id}>
                    <td className="py-1.5">{t.effectiveFrom}</td>
                    <td className="py-1.5">{t.effectiveTo ?? "ongoing"}</td>
                    <td className="tabular py-1.5 text-right">{money(t.baseRate)}</td>
                    <td className="tabular py-1.5 text-right">{money(r2(t.baseRate * t.weekendMultiplier))}</td>
                    <td className="tabular py-1.5 text-right">{money(r2(t.baseRate * t.nightMultiplier))}</td>
                    <td className="py-1.5 text-xs">
                      {t.gstRegistered ? "registered" : "not registered"}
                      <span className="block text-muted-foreground">{t.gstNote}</span>
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground">{t.createdByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="rounded-md border border-border px-3 py-3">
            <p className="text-sm font-medium">New terms from a date</p>
            <div className="mt-2 flex flex-wrap items-end gap-3">
              <Field label="Base $/hour" className="w-[110px]">
                <Input type="number" min={0} step="0.5" value={f.baseRate} onChange={(e) => setF({ ...f, baseRate: e.target.value })} />
              </Field>
              <Field label="Weekend x" className="w-[90px]">
                <Input type="number" min={1} step="0.25" value={f.weekend} onChange={(e) => setF({ ...f, weekend: e.target.value })} />
              </Field>
              <Field label="Night x" className="w-[90px]">
                <Input type="number" min={1} step="0.25" value={f.night} onChange={(e) => setF({ ...f, night: e.target.value })} />
              </Field>
              <Field label="From" className="w-[160px]">
                <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
              </Field>
              <label htmlFor="terms-gst" className="flex items-center gap-2 pb-2 text-sm">
                <Checkbox id="terms-gst" checked={f.gst} onChange={(e) => setF({ ...f, gst: e.target.checked })} /> GST registered
              </label>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {money(base)} standard, {money(r2(base * (Number(f.weekend) || 1)))} weekend, {money(r2(base * (Number(f.night) || 1)))} night. Night replaces weekend.
            </p>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="GST note (who confirmed it, when)">
                <Input value={f.gstNote} onChange={(e) => setF({ ...f, gstNote: e.target.value })} />
              </Field>
              <Field label="Note">
                <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
              </Field>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                disabled={add.isPending || !f.from || base <= 0 || f.gstNote.trim().length < 3}
                onClick={() =>
                  add.mutate(
                    {
                      installerId: Number(installerId),
                      baseRate: base,
                      weekendMultiplier: Number(f.weekend),
                      nightMultiplier: Number(f.night),
                      gstRegistered: f.gst,
                      gstNote: f.gstNote,
                      defaultForNew: true,
                      effectiveFrom: f.from,
                      note: f.note || null,
                    },
                    { onSuccess: () => setF({ ...f, from: "", note: "" }) },
                  )
                }
              >
                <Clock className="size-3.5" /> Add terms
              </Button>
              {add.error ? <p className="text-xs text-destructive">{add.error.message}</p> : null}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
