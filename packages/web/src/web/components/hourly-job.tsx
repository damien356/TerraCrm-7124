import * as React from "react";
import { Link } from "wouter";
import { Clock } from "lucide-react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/field";
import { useBootstrap } from "../queries/settings";
import { dayLabel, hours, money, useHourlyJob, useTaskPlan } from "../queries/hourly";

/**
 * Hourly work on one job, for a login that may see costs. Everything is
 * labelled "so far" until the task is complete and every entry is approved,
 * and the comparison with the normal subcontract price stays "provisional"
 * until the office says whether that price already covers the vehicle.
 * The vehicle allowance is a Terra cost only. It is never paid to the worker.
 */
export function HourlyJobCard({ jobId }: { jobId: number }) {
  const canSeeCosts = Boolean(useBootstrap().data?.actor?.canSeeCosts);
  const q = useHourlyJob(jobId, canSeeCosts);
  if (!canSeeCosts) return null;
  if (q.isLoading) {
    return (
      <Card>
        <CardHeader title="Hourly work" />
        <Loading />
      </Card>
    );
  }
  const d = q.data;
  if (!d || !d.tasks.length) return null;
  const m = d.margin;

  return (
    <Card>
      <CardHeader
        title="Hourly work"
        subtitle="Approved time at the rate it was approved at, plus the vehicle allowance (a Terra cost, never paid to the worker)."
        action={
          <Link href={`/hourly?job=${jobId}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            <Clock className="size-3.5" /> Check and approve time
          </Link>
        }
      />
      <div className="grid gap-4 px-4 py-3">
        {d.tasks.map((t) => (
          <HourlyTask key={t.taskId} t={t} />
        ))}

        <div className="rounded-md border border-border px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold">Job margin after allowances</p>
            {m.final ? <Badge colour="#3E6B4F">final</Badge> : <Badge colour="#B7791F">so far, with the plan for what is left</Badge>}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <Row label="Sale ex GST" value={money(m.revenue)} />
            <Row label="Materials" value={money(m.materials)} />
            <Row label="Hourly labour" value={money(m.hourlyLabour)} />
            <Row label="Vehicle allowance" value={money(m.vehicleAllowance)} />
            <Row label="Other labour" value={money(m.otherLabour)} />
            <Row label="Other direct costs" value={money(m.otherDirect)} />
            <Row label="Total cost" value={money(m.cost)} />
            <Row
              label="Margin"
              value={`${money(m.marginAfterAllowances)}${m.marginPct == null ? "" : ` (${m.marginPct}%)`}`}
              tone={m.marginAfterAllowances >= 0 ? "good" : "bad"}
            />
          </div>
        </div>

        {d.pending.length ? (
          <div className="rounded-md bg-[#B7791F]/10 px-3 py-2 text-xs text-[#8a5a12]">
            <p className="font-semibold">Still to be decided by the office</p>
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

type JobData = NonNullable<ReturnType<typeof useHourlyJob>["data"]>;
type TaskView = JobData["tasks"][number];

function HourlyTask({ t }: { t: TaskView }) {
  const [editing, setEditing] = React.useState(false);
  const c = t.comparison;
  const so = t.soFar;
  const rates = t.leadRates;

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">{t.title}</p>
          <span className="text-xs text-muted-foreground">{t.installerName ?? "unassigned"}</span>
          {rates ? (
            <span className="text-xs text-muted-foreground">
              {money(rates.standardRate)} / {money(rates.weekendRate)} / {money(rates.nightRate)} an hour
              {rates.gstRegistered ? " +GST" : ", not GST registered"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {t.final ? <Badge colour="#3E6B4F">final</Badge> : <Badge colour="#B7791F">so far</Badge>}
          {c.provisional ? <Badge colour="#8A8580">comparison provisional</Badge> : null}
        </div>
      </div>

      <div className="grid gap-3 px-3 py-2.5 text-xs md:grid-cols-3">
        <div className="space-y-1">
          <p className="label-xs">{t.final ? "Actual" : "So far"}</p>
          <Row label="Approved hours" value={hours(so.approvedMinutes)} />
          <Row label="Approved labour" value={money(so.approvedLabour)} />
          {so.recordedMinutes ? <Row label="Recorded, not approved" value={`${hours(so.recordedMinutes)} (about ${money(so.recordedEstimate)})`} /> : null}
          <Row label={`Vehicle allowance (${so.vehicleDays} day${so.vehicleDays === 1 ? "" : "s"})`} value={money(so.vehicle)} />
          <Row label="Labour plus vehicle" value={money(so.combined)} strong />
        </div>

        <div className="space-y-1">
          <p className="label-xs">{t.final ? "Finished" : "Projected"}</p>
          {!t.final ? (
            <>
              <Row label="Planned hours" value={t.plan.hours == null ? "not set" : `${t.plan.hours} h`} />
              <Row label="Planned vehicle days" value={t.plan.vehicleDays == null ? "not set" : String(t.plan.vehicleDays)} />
              <Row label="Labour left (plan)" value={t.remaining.labour == null ? "-" : money(t.remaining.labour)} />
              <Row label="Vehicle left (plan)" value={t.remaining.vehicle == null ? "-" : money(t.remaining.vehicle)} />
            </>
          ) : null}
          <Row label="Labour" value={money(t.projected.labour)} />
          <Row label="Vehicle" value={money(t.projected.vehicle)} />
          <Row label="Combined" value={money(t.projected.combined)} strong />
        </div>

        <div className="space-y-1">
          <p className="label-xs">Against the normal subcontract price</p>
          <Row
            label="Terra standard rate"
            value={t.benchmark.amount == null ? "not priced" : money(t.benchmark.amount)}
            hint={t.benchmark.pricedOn ? `frozen ${t.benchmark.pricedOn}` : undefined}
          />
          <Row label="Saving before vehicle" value={money(c.savingBeforeVehicle)} tone={tone(c.savingBeforeVehicle)} strong={c.likeForLike === "before"} />
          <Row label="Saving after vehicle" value={money(c.savingAfterVehicle)} tone={tone(c.savingAfterVehicle)} strong={c.likeForLike === "after"} />
          <p className="pt-1 text-[11px] text-muted-foreground">
            {t.benchmark.vehicle === "unknown"
              ? "Not yet known if the normal price includes the subbie's vehicle. Both lines shown."
              : t.benchmark.vehicle === "included"
                ? "Normal price includes the vehicle: compare after vehicle."
                : "Normal price excludes the vehicle: compare before vehicle."}
          </p>
        </div>
      </div>

      {t.workers.length ? (
        <div className="border-t border-border px-3 py-2 text-xs">
          <p className="label-xs mb-1">Approved hours by band</p>
          {t.workers.map((w) => (
            <div key={w.installerId} className="flex flex-wrap gap-x-4 gap-y-0.5">
              <span className="font-medium">{w.name}</span>
              {w.lines.map((l) => (
                <span key={l.band} className="tabular">
                  {l.label}: {hours(l.minutes)}, {money(l.pay)}
                </span>
              ))}
              {w.unpaidMinutes ? <span className="text-muted-foreground">{hours(w.unpaidMinutes)} approved as unpaid</span> : null}
            </div>
          ))}
        </div>
      ) : null}

      {t.vehicleRows.length ? (
        <div className="border-t border-border px-3 py-2 text-xs">
          <p className="label-xs mb-1">Vehicle days on this task</p>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            {t.vehicleRows.map((r) => (
              <span key={`${r.vehicleDayId}`} className="tabular">
                {dayLabel(r.useDate)} {r.vehicleName}: {money(r.share)}
                {r.share !== r.allowance ? ` of ${money(r.allowance)}` : ""}
                {r.override ? " (set by office)" : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {t.reconciliation.some((r) => r.invoice || r.unbilledPay) ? (
        <div className="border-t border-border px-3 py-2 text-xs">
          <p className="label-xs mb-1">Contractor invoice against approved time</p>
          {t.reconciliation.map((r) =>
            r.invoice ? (
              <p key={r.installerId}>
                {r.name}: invoice {r.invoice.number ?? r.invoice.id}, {money(r.invoicedHourly)} for {r.invoicedHours} h, GST {money(r.invoice.gst)}.{" "}
                {r.matched ? (
                  <span className="text-[#3E6B4F]">Matches approved time.</span>
                ) : (
                  <span className="text-[#B4472E]">Does not match. Approved time on this invoice is {money(r.linkedPay)}.</span>
                )}
                {r.unbilledPay ? ` ${money(r.unbilledPay)} approved but not billed yet.` : ""}
              </p>
            ) : r.unbilledPay ? (
              <p key={r.installerId}>
                {r.name}: no invoice for this task yet. {money(r.unbilledPay)} approved and not billed.
              </p>
            ) : null,
          )}
        </div>
      ) : null}

      <div className="border-t border-border px-3 py-2">
        {editing ? <PlanForm t={t} onDone={() => setEditing(false)} /> : (
          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setEditing(true)}>
            Set planned hours, vehicle days, and whether the normal price includes the vehicle
          </button>
        )}
      </div>
    </div>
  );
}

function PlanForm({ t, onDone }: { t: TaskView; onDone: () => void }) {
  const plan = useTaskPlan();
  const [h, setH] = React.useState(t.plan.hours == null ? "" : String(t.plan.hours));
  const [vd, setVd] = React.useState(t.plan.vehicleDays == null ? "" : String(t.plan.vehicleDays));
  const [bv, setBv] = React.useState<"unknown" | "included" | "excluded">(t.benchmark.vehicle);
  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Planned hours" className="w-[120px]">
        <Input type="number" min={0} step="0.25" value={h} onChange={(e) => setH(e.target.value)} className="h-8" />
      </Field>
      <Field label="Planned vehicle days" className="w-[140px]">
        <Input type="number" min={0} step="1" value={vd} onChange={(e) => setVd(e.target.value)} className="h-8" />
      </Field>
      <Field label="Normal price includes vehicle?" className="w-[200px]">
        <Select value={bv} onChange={(e) => setBv(e.target.value as typeof bv)} className="h-8">
          <option value="unknown">Not known yet</option>
          <option value="included">Yes, includes vehicle</option>
          <option value="excluded">No, excludes vehicle</option>
        </Select>
      </Field>
      <Button
        size="sm"
        disabled={plan.isPending}
        onClick={() =>
          plan.mutate({ taskId: t.taskId, plannedHours: num(h), plannedVehicleDays: num(vd), benchmarkVehicle: bv }, { onSuccess: onDone })
        }
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {plan.error ? <p className="w-full text-xs text-destructive">{plan.error.message}</p> : null}
    </div>
  );
}

const tone = (n: number | null) => (n == null ? undefined : n >= 0 ? "good" : "bad");

function Row({ label, value, hint, tone, strong }: { label: string; value: string; hint?: string; tone?: "good" | "bad"; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">
        {label}
        {hint ? <span className="ml-1 text-[10px]">({hint})</span> : null}
      </span>
      <span
        className={`tabular ${strong ? "font-semibold" : ""} ${tone === "good" ? "text-[#3E6B4F]" : tone === "bad" ? "text-[#B4472E]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
