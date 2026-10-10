import * as React from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Minus,
  Plus,
  Radio,
  Send,
  Sofa,
  UserMinus,
  Users2,
  X,
} from "lucide-react";
import { Page } from "../components/layout";
import { MemoButton } from "../components/voice-memo";
import { BookInstallerPanel } from "../components/book-installer";
import { CommandBox } from "../components/command-box";
import { Loading, Spinner } from "../components/ui/card";
import { Badge, TASK_STATUS_COLOUR, TASK_STATUS_LABEL, tintFor } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import {
  useAssignTask,
  useBoard,
  useExtendRun,
  useRescheduleTask,
  useSetTaskStatus,
  useTask,
  useUnassignTask,
} from "../queries/tasks";
import { useInstallers, useEligible } from "../queries/installers";
import { useBroadcast, useOffersForTask, useSendDirect, useWithdrawOffers } from "../queries/offers";

const money = (n?: number | null) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

const iso = (d: Date) => d.toISOString().slice(0, 10);

function mondayOf(date: Date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d;
}

function useWeek() {
  const [anchor, setAnchor] = React.useState(() => mondayOf(new Date()));
  const days = React.useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => {
        const d = new Date(anchor);
        d.setDate(d.getDate() + i);
        return d;
      }),
    [anchor],
  );
  return {
    days,
    from: iso(days[0]!),
    to: iso(days[days.length - 1]!),
    shift: (weeks: number) => {
      const d = new Date(anchor);
      d.setDate(d.getDate() + weeks * 7);
      setAnchor(mondayOf(d));
    },
    reset: () => setAnchor(mondayOf(new Date())),
  };
}

/* ------------------------------ task block ------------------------------ */

function TaskBlock({
  task,
  dragging,
  onOpen,
  onDragStart,
  onDragEnd,
  compact,
}: {
  task: any;
  dragging?: boolean;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  compact?: boolean;
}) {
  const tint = tintFor(task.skill?.groupName);
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className="w-full cursor-grab rounded-md border-l-[3px] px-2 py-1.5 text-left transition-shadow hover:shadow-sm active:cursor-grabbing"
      // Out of the way mid-drag, so the row behind it takes the drop.
      style={{ backgroundColor: tint.fill, borderLeftColor: tint.edge, pointerEvents: dragging ? "none" : undefined }}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="truncate text-[12px] font-semibold leading-tight text-[#1C1B1A]">{task.title}</p>
        {task.crewSize > 1 ? <Users2 className="mt-0.5 size-3 shrink-0 text-[#1C1B1A]/60" /> : null}
      </div>
      <p className="mt-0.5 truncate text-[11px] leading-tight text-[#1C1B1A]/65">
        {task.ref} · {task.siteSuburb || task.siteAddress || "no site"}
      </p>
      {!compact ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {task.startTime ? (
            <span className="tabular text-[10px] font-medium text-[#1C1B1A]/60">{task.startTime}</span>
          ) : null}
          {task.furnitureOnSite ? <Sofa className="size-3 text-[#1C1B1A]/50" /> : null}
          {task.pendingOffers > 0 ? (
            <span className="rounded-full bg-[#D08A1E]/20 px-1.5 text-[10px] font-semibold text-[#8A5A0B]">
              {task.pendingOffers} out
            </span>
          ) : null}
          {task.status === "complete" ? (
            <span className="rounded-full bg-[#3F7D3A]/20 px-1.5 text-[10px] font-semibold text-[#2C5A28]">done</span>
          ) : null}
          {task.status === "in_progress" ? (
            <span className="rounded-full bg-[#D08A1E]/20 px-1.5 text-[10px] font-semibold text-[#8A5A0B]">
              on site
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

/* -------------------------------- run bars -------------------------------- */

/** One booked day in the lane: 46px of bar, 4px of air under it. */
const LANE_H = 46;
const LANE_GAP = 4;

/** "Thu 1 Oct", the way the office says a date out loud. */
function sayDate(date: string) {
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
}

/** "07:00" the way the office says it: 7am, 12:30pm. */
function sayTime(hhmm?: string | null) {
  if (!hhmm) return null;
  const [rawH, rawM] = hhmm.split(":");
  const h = Number(rawH);
  const m = Number(rawM ?? 0);
  if (Number.isNaN(h)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
}

/**
 * A stretch of consecutive booked days on one installer's row, drawn as a
 * single bar. A four day run is one bar, not four blocks. A run that carries
 * on past Saturday runs off the edge instead of vanishing.
 */
type Run = {
  task: any;
  startIdx: number;
  span: number;
  openLeft: boolean;
  openRight: boolean;
  /** Where this stretch sits in the whole run, for "Day 3 to 5 of 6". */
  firstSeq: number;
  totalDays: number;
  window: string | null;
  lane: number;
  /** Days in this stretch this installer is also on another job for. */
  clashDates: string[];
};

function runsFor(tasks: any[], installerId: number, dates: string[]): Run[] {
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  const found: Omit<Run, "lane">[] = [];

  /** Which days this installer is on more than one live job for. */
  const onPerDay = new Map<string, number>();
  for (const task of tasks) {
    if (task.status === "complete" || task.status === "cancelled") continue;
    for (const date of (task.dates ?? []) as string[]) {
      const day = (task.days ?? []).find((d: any) => d.date === date);
      const lead = day?.installerId ?? task.assignedInstallerId;
      if (lead !== installerId && task.secondInstallerId !== installerId) continue;
      onPerDay.set(date, (onPerDay.get(date) ?? 0) + 1);
    }
  }

  for (const task of tasks) {
    const all: string[] = [...((task.dates ?? []) as string[])].sort();
    // A day handed to someone else belongs on their row, not the lead's.
    const mine = all.filter((date) => {
      const day = (task.days ?? []).find((d: any) => d.date === date);
      const lead = day?.installerId ?? task.assignedInstallerId;
      return lead === installerId || task.secondInstallerId === installerId;
    });
    if (mine.length === 0) continue;

    const visible = mine
      .map((d) => dates.indexOf(d))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (visible.length === 0) continue;

    const live = task.status !== "complete" && task.status !== "cancelled";
    const push = (startIdx: number, endIdx: number) => {
      const firstDate = dates[startIdx]!;
      const day = (task.days ?? []).find((d: any) => d.date === firstDate);
      const start = sayTime(day?.arrivalStart ?? task.startTime);
      const stretch = dates.slice(startIdx, endIdx + 1);
      found.push({
        task,
        startIdx,
        span: endIdx - startIdx + 1,
        openLeft: startIdx === 0 && mine.some((d) => d < from),
        openRight: endIdx === dates.length - 1 && mine.some((d) => d > to),
        firstSeq: all.indexOf(firstDate) + 1,
        totalDays: all.length,
        window: day?.coordinate ? "rings the site" : start,
        clashDates: live ? stretch.filter((d) => (onPerDay.get(d) ?? 0) > 1) : [],
      });
    };

    let start = visible[0]!;
    let prev = start;
    for (const i of visible.slice(1)) {
      if (i !== prev + 1) {
        push(start, prev);
        start = i;
      }
      prev = i;
    }
    push(start, prev);
  }

  // Two jobs on the same day stack instead of sitting on top of each other.
  const nextFree: number[] = [];
  return found
    .sort((a, b) => a.startIdx - b.startIdx || b.span - a.span)
    .map((run) => {
      let lane = nextFree.findIndex((free) => free <= run.startIdx);
      if (lane < 0) lane = nextFree.length;
      nextFree[lane] = run.startIdx + run.span;
      return { ...run, lane };
    });
}

function RunBar({
  run,
  cols,
  dragging,
  busy,
  onOpen,
  onExtend,
  onDragStart,
  onDragEnd,
}: {
  run: Run;
  cols: number;
  dragging: boolean;
  /** This bar has a day going on or off it right now. */
  busy: boolean;
  onOpen: () => void;
  /** A day on the end, or a day off it. One click, no dialog. */
  onExtend: (by: number) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const t = run.task;
  const tint = tintFor(t.skill?.groupName);
  const clash = run.clashDates.length > 0;
  const partial = run.span < run.totalDays;
  const dayLabel =
    run.totalDays === 1
      ? null
      : partial
        ? run.span === 1
          ? `Day ${run.firstSeq} of ${run.totalDays}`
          : `Day ${run.firstSeq} to ${run.firstSeq + run.span - 1} of ${run.totalDays}`
        : `${run.totalDays} days`;

  // The handles sit on the end of the run, so they only make sense when the end
  // of the run is on screen. A finished job does not need another day.
  const canExtend = !run.openRight && t.status !== "complete";

  return (
    <div
      className="group absolute"
      style={{
        left: `calc(${(run.startIdx / cols) * 100}% + 3px)`,
        width: `calc(${(run.span / cols) * 100}% - 6px)`,
        top: run.lane * (LANE_H + LANE_GAP) + LANE_GAP,
        height: LANE_H,
        // While another bar is being dragged this one steps out of the way, so a
        // day that already has a booking on it still takes the drop. The bar
        // being dragged keeps its pointer events or Chrome drops the gesture.
        pointerEvents: dragging ? "none" : undefined,
      }}
    >
      <button
        type="button"
        draggable
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={onOpen}
        title={
          clash
            ? `Double booked ${run.clashDates.length === 1 ? sayDate(run.clashDates[0]!) : `on ${run.clashDates.length} days`}. ${t.ref} ${t.title} · ${t.jobTitle ?? ""}`
            : `${t.ref} ${t.title} · ${t.jobTitle ?? ""}`
        }
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: tint.fill,
          // A double booking reads as a problem at a glance, before anyone clicks
          // it: red edge, red outline, warning triangle.
          borderLeftColor: clash ? "#C0362C" : tint.edge,
          borderLeftWidth: run.openLeft && !clash ? 0 : 3,
          ...(clash ? { outline: "1.5px solid #C0362C", outlineOffset: "-1.5px" } : {}),
          opacity: t.status === "complete" ? 0.7 : 1,
        }}
        className={`flex w-full cursor-grab flex-col justify-center overflow-hidden px-2 text-left transition-shadow group-hover:z-10 group-hover:shadow-md active:cursor-grabbing ${
          run.openLeft ? "rounded-l-none" : "rounded-l-md"
        } ${run.openRight ? "rounded-r-none" : "rounded-r-md"}`}
      >
        <div className="flex items-center gap-1">
          {run.openLeft && !clash ? <ChevronsLeft className="size-3 shrink-0 text-[#1C1B1A]/45" /> : null}
          {clash ? <AlertTriangle className="size-3.5 shrink-0 text-[#C0362C]" /> : null}
          <p className="truncate text-[12px] font-semibold leading-tight text-[#1C1B1A]">{t.title}</p>
          {t.crewSize > 1 ? <Users2 className="size-3 shrink-0 text-[#1C1B1A]/55" /> : null}
          {t.furnitureOnSite ? <Sofa className="size-3 shrink-0 text-[#1C1B1A]/45" /> : null}
          {t.status === "in_progress" ? (
            <span className="ml-auto shrink-0 rounded-full bg-[#D08A1E]/25 px-1.5 text-[10px] font-semibold text-[#8A5A0B]">
              on site
            </span>
          ) : null}
          {t.status === "complete" ? <Check className="ml-auto size-3 shrink-0 text-[#2C5A28]" /> : null}
          {run.openRight ? <ChevronsRight className="ml-auto size-3 shrink-0 text-[#1C1B1A]/45" /> : null}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] leading-tight text-[#1C1B1A]/65">
          <span className="truncate">
            {t.ref} · {t.siteSuburb || t.siteAddress || "no site"}
          </span>
          {/* One column of bar is too narrow for both, and which day it is beats
              the arrival time when the run is only part visible. */}
          {run.window && !(dayLabel && run.span === 1) ? (
            <span className="tabular shrink-0 text-[#1C1B1A]/55">{run.window}</span>
          ) : null}
          {dayLabel ? (
            // The day count and the extend handles want the same corner, so the
            // count steps aside while the cursor is on the bar.
            <span
              className={`ml-auto shrink-0 rounded-sm bg-[#1C1B1A]/8 px-1 text-[10px] font-semibold uppercase tracking-wide text-[#1C1B1A]/55 ${
                canExtend ? `transition-opacity ${busy ? "opacity-0" : "group-hover:opacity-0"}` : ""
              }`}
            >
              {dayLabel}
            </span>
          ) : null}
        </div>
      </button>

      {/* A day on or off the end of the run, from the board, one click, no
          dialog. Hidden until the bar is hovered so the board stays quiet, and
          it sits over the end of the run because that is the day it changes. */}
      {canExtend ? (
        <div
          className={`absolute right-0 top-0 z-20 flex h-full items-center gap-1 rounded-r-md pl-4 pr-1.5 transition-opacity ${
            busy ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
          }`}
          style={{ background: `linear-gradient(to right, transparent, ${tint.fill} 55%)` }}
        >
          {busy ? (
            <Spinner />
          ) : (
            <>
              <button
                type="button"
                title={run.totalDays === 1 ? "Only day on it, take the installer off instead" : "One day off the end"}
                disabled={run.totalDays === 1}
                onClick={(e) => {
                  e.stopPropagation();
                  onExtend(-1);
                }}
                className="flex size-6 items-center justify-center rounded-md border border-[#1C1B1A]/20 bg-white text-[#1C1B1A]/70 shadow-sm hover:border-[#1C1B1A]/35 hover:text-[#1C1B1A] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <Minus className="size-3.5" />
              </button>
              <button
                type="button"
                title="One more day on the end"
                onClick={(e) => {
                  e.stopPropagation();
                  onExtend(1);
                }}
                className="flex size-6 items-center justify-center rounded-md border border-[#1C1B1A]/20 bg-white text-[#1C1B1A]/70 shadow-sm hover:border-[#1C1B1A]/35 hover:text-[#1C1B1A]"
              >
                <Plus className="size-3.5" />
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ side panel ------------------------------ */

function DispatchPanel({
  taskId,
  onClose,
  onBook,
}: {
  taskId: number;
  onClose: () => void;
  /** Back to the booking panel, which is where most jobs get sorted. */
  onBook: () => void;
}) {
  const task = useTask(taskId);
  const offers = useOffersForTask(taskId);
  const [payOverride, setPayOverride] = React.useState("");
  const [directId, setDirectId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const t = task.data;
  const eligible = useEligible(t?.skillId ?? null, t?.scheduledDate ?? undefined, t?.crewSize ?? 1);

  const sendDirect = useSendDirect();
  const broadcast = useBroadcast();
  const withdraw = useWithdrawOffers();
  const assign = useAssignTask();
  const unassign = useUnassignTask();
  const setStatus = useSetTaskStatus();

  const busy =
    sendDirect.isPending || broadcast.isPending || withdraw.isPending || assign.isPending || unassign.isPending;

  function run(p: Promise<unknown>) {
    setError(null);
    p.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  const pay = payOverride ? Number(payOverride) : null;

  return (
    <aside className="w-[340px] shrink-0 border-l border-border bg-card">
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t?.title ?? "Task"}</p>
          {t ? (
            <Link to={`/jobs/${t.jobId}`} className="text-xs text-primary hover:underline">
              Job #{t.job.displayNumber ?? t.job.number} · open job
            </Link>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {t ? <MemoButton jobId={t.jobId} compact /> : null}
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary">
            <X className="size-4" />
          </button>
        </div>
      </div>

      {task.isLoading || !t ? (
        <Loading />
      ) : (
        <div className="board-scroll max-h-[calc(100vh-120px)] overflow-y-auto px-4 py-3">
          <Button size="sm" className="w-full" onClick={onBook}>
            <Calendar className="size-3.5" />
            Book an installer on it
          </Button>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Badge colour={TASK_STATUS_COLOUR[t.status]}>{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
            {t.skill ? <Badge>{t.skill.name}</Badge> : <Badge>no skill set</Badge>}
            {t.crewSize > 1 ? (
              <Badge>
                <Users2 className="size-3" />2 man
              </Badge>
            ) : null}
            {t.job.furnitureOnSite ? (
              <Badge colour="#C0603F">
                <Sofa className="size-3" />
                furniture
              </Badge>
            ) : null}
          </div>

          <dl className="mt-3 space-y-1.5 text-xs">
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">When</dt>
              <dd className="tabular font-medium">
                {t.scheduledDate ?? "unscheduled"} {t.startTime ?? ""} · {t.durationHours}h
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Site</dt>
              <dd className="font-medium">
                {t.site ? `${t.site.address}, ${t.site.suburb}` : "No site on the job"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Area</dt>
              <dd className="tabular font-medium">{t.areaM2 ? `${t.areaM2} m²` : "-"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Installer</dt>
              <dd className="font-medium">{t.installer?.name ?? "Nobody yet"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-20 shrink-0 text-muted-foreground">Their pay</dt>
              <dd className="tabular font-medium">{money(t.payAmount)}</dd>
            </div>
          </dl>

          {t.description ? (
            <p className="mt-3 rounded-md bg-secondary px-3 py-2 text-xs leading-relaxed">{t.description}</p>
          ) : null}

          {error ? (
            <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
          ) : null}

          {/* ------------------------- dispatch ------------------------- */}
          <div className="mt-4 border-t border-border pt-3">
            <p className="label-xs">Dispatch</p>
            <Field label="Pay for this one (optional)" className="mt-2">
              <Input
                type="number"
                inputMode="decimal"
                placeholder={t.payAmount != null ? String(t.payAmount) : "Use their own rate"}
                value={payOverride}
                onChange={(e) => setPayOverride(e.target.value)}
              />
            </Field>

            <Field label="Offer one installer" className="mt-2">
              <Select value={directId} onChange={(e) => setDirectId(e.target.value)}>
                <option value="">Pick someone ticked for {t.skill?.name ?? "this skill"}…</option>
                {(eligible.data ?? []).map((i) => (
                  <option key={i.id} value={i.id} disabled={!i.canCoverAlone}>
                    {i.name}
                    {i.busyThatDay ? " · already on a job" : ""}
                    {i.unavailableThatDay ? " · not available" : ""}
                    {!i.canCoverAlone ? " · can't do 2-man alone" : ""}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                size="sm"
                disabled={busy || !directId}
                onClick={() =>
                  run(
                    sendDirect.mutateAsync({
                      taskId: t.id,
                      installerId: Number(directId),
                      payAmount: pay,
                    }),
                  )
                }
              >
                {sendDirect.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="size-3.5" />}
                Offer
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !directId}
                onClick={() => run(assign.mutateAsync({ id: t.id, installerId: Number(directId), payAmount: pay }))}
              >
                Assign now
              </Button>
            </div>

            <Button
              size="sm"
              variant="secondary"
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => run(broadcast.mutateAsync({ taskId: t.id, payAmount: pay }))}
            >
              {broadcast.isPending ? <Spinner /> : <Radio className="size-3.5" />}
              Broadcast: first to accept wins
            </Button>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(withdraw.mutateAsync({ taskId: t.id }))}>
                Pull offers back
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || !t.assignedInstallerId}
                onClick={() => run(unassign.mutateAsync({ id: t.id }))}
              >
                <UserMinus className="size-3.5" />
                Take off
              </Button>
            </div>

            <Field label="Status" className="mt-3">
              <Select
                value={t.status}
                onChange={(e) => run(setStatus.mutateAsync({ id: t.id, status: e.target.value as any }))}
              >
                {Object.entries(TASK_STATUS_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* ------------------------- offer log ------------------------- */}
          <div className="mt-4 border-t border-border pt-3">
            <p className="label-xs">Offer history</p>
            {offers.isLoading ? (
              <Loading />
            ) : (offers.data ?? []).length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No offers sent yet.</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {(offers.data ?? []).map((o) => (
                  <li key={o.offer.id} className="rounded-md bg-secondary px-2.5 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{o.installer.name}</span>
                      <span className="tabular">{money(o.offer.payAmount)}</span>
                    </div>
                    <p className="mt-0.5 text-muted-foreground">
                      {o.offer.mode} · {o.offer.status}
                      {o.offer.declineReason ? `: "${o.offer.declineReason}"` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ------------------------- checklist ------------------------- */}
          {t.checklist.length > 0 ? (
            <div className="mt-4 border-t border-border pt-3">
              <p className="label-xs">Checklist</p>
              <ul className="mt-2 space-y-1">
                {t.checklist.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-xs">
                    <span
                      className={
                        c.done
                          ? "size-3.5 rounded-sm bg-[var(--success)]"
                          : "size-3.5 rounded-sm border border-border bg-card"
                      }
                    />
                    <span className={c.done ? "text-muted-foreground line-through" : ""}>{c.label}</span>
                    {c.required ? <span className="text-[10px] text-destructive">required</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}

/* -------------------------------- board -------------------------------- */

export default function SchedulePage() {
  const week = useWeek();
  const board = useBoard(week.from, week.to);
  const installers = useInstallers();
  const reschedule = useRescheduleTask();
  const extend = useExtendRun();
  const [selected, setSelected] = React.useState<number | null>(null);
  const [panel, setPanel] = React.useState<"book" | "offers">("book");
  const [dragId, setDragId] = React.useState<number | null>(null);
  const [dropError, setDropError] = React.useState<string | null>(null);
  /** What a drag just booked, when it booked more than the day it landed on. */
  const [dropNote, setDropNote] = React.useState<{ id: number; days: number; from: string; to: string } | null>(null);
  /** The cell under the cursor mid-drag, so the office can see where it lands. */
  const [hover, setHover] = React.useState<{ installerId: number; idx: number } | null>(null);
  /** What the typed line just booked, so it is confirmed rather than assumed. */
  const [cmdNote, setCmdNote] = React.useState<{
    taskId: number;
    days: number;
    from: string;
    to: string;
    installer: string;
  } | null>(null);
  /** Which bar has a day going on or off it, so only that one shows a spinner. */
  const [extBusyId, setExtBusyId] = React.useState<number | null>(null);
  const [extError, setExtError] = React.useState<string | null>(null);
  /** What the last +1 or -1 on the board did, said out loud and never blocking. */
  const [extNote, setExtNote] = React.useState<{
    taskId: number;
    installer: string;
    added: string[];
    removed: string[];
    total: number;
    clashCount: number;
    /** New days that are not clear, with the reason they are not. */
    flags: { label: string; reason: string }[];
    payNeedsLook: boolean;
  } | null>(null);

  const tasks = board.data?.tasks ?? [];
  const unassigned = board.data?.unassigned ?? [];
  const dates = React.useMemo(() => week.days.map(iso), [week.days]);
  const cols = dates.length;
  const today = iso(new Date());

  function open(id: number) {
    setSelected(id);
    setPanel("book");
  }

  /** Which day the cursor is over, from where it is across the lane. */
  function idxFromEvent(e: React.DragEvent) {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * cols);
    return Math.min(cols - 1, Math.max(0, i));
  }

  /** Let go anywhere, even off the board, and the bars come back to life. */
  function endDrag() {
    setDragId(null);
    setHover(null);
  }

  function drop(installerId: number | null, date: string | null) {
    setHover(null);
    if (dragId == null) return;
    const id = dragId;
    setDropError(null);
    setDropNote(null);
    reschedule
      .mutateAsync({ id, scheduledDate: date, installerId })
      .then((r: any) => {
        // A one-day drag that booked a whole run says so, rather than the
        // office finding three days on the board they didn't ask for.
        if (r?.bookedDays > 1 && r.dates?.length) {
          setDropNote({ id, days: r.bookedDays, from: r.dates[0], to: r.dates[r.dates.length - 1] });
        }
      })
      .catch((e: unknown) => setDropError(e instanceof Error ? e.message : String(e)));
    setDragId(null);
  }

  /**
   * A day on or off the end of a run, straight from the bar. No dialog and no
   * confirm, because the whole point is that it takes a second. A clash or a
   * day off shows up in the note underneath afterwards, loud but never in the
   * way, and the bar itself goes red on the board.
   */
  function extendRun(taskId: number, by: number) {
    setExtError(null);
    setExtNote(null);
    setDropNote(null);
    setCmdNote(null);
    setExtBusyId(taskId);
    extend
      .mutateAsync({ taskId, by, skipNonWorking: true })
      .then((r: any) => {
        setExtNote({
          taskId,
          installer: r.installerName ?? "the installer",
          added: (r.added ?? []).map((d: { label: string }) => d.label),
          removed: (r.removed ?? []).map((d: { label: string }) => d.label),
          total: r.dates?.length ?? 0,
          clashCount: r.clashCount ?? 0,
          flags: (r.added ?? [])
            .filter((d: { status: string }) => d.status !== "available")
            .map((d: { label: string; reason: string | null }) => ({
              label: d.label,
              reason: d.reason || "Not a day he normally works",
            })),
          payNeedsLook: Boolean(r.payNeedsLook),
        });
      })
      .catch((e: unknown) => setExtError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExtBusyId(null));
  }

  if (board.isLoading || installers.isLoading) return <Loading label="Loading the board…" />;

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <Page
          wide
          title="Schedule"
          subtitle="One row per installer, one bar per booking. Click a bar to change the booking, drag it to move it."
          actions={
            <div className="flex items-center gap-1">
              <Button variant="outline" size="icon-sm" onClick={() => week.shift(-1)}>
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={week.reset}>
                This week
              </Button>
              <Button variant="outline" size="icon-sm" onClick={() => week.shift(1)}>
                <ChevronRight className="size-4" />
              </Button>
            </div>
          }
        >
          <CommandBox
            onBooked={(s) => {
              setCmdNote(s);
              setDropNote(null);
              setDropError(null);
            }}
            onOpenTask={open}
          />

          {cmdNote ? (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-[var(--success)]/10 px-3 py-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Check className="size-4 shrink-0 text-[var(--success)]" />
                Booked {cmdNote.installer} for {cmdNote.days} {cmdNote.days === 1 ? "day" : "days"},{" "}
                {cmdNote.days === 1 ? sayDate(cmdNote.from) : `${sayDate(cmdNote.from)} to ${sayDate(cmdNote.to)}`}.
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => {
                    open(cmdNote.taskId);
                    setCmdNote(null);
                  }}
                >
                  Change it
                </button>
                <button type="button" onClick={() => setCmdNote(null)}>
                  <X className="size-4" />
                </button>
              </span>
            </div>
          ) : null}

          {dropError ? (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{dropError}</span>
              <button type="button" onClick={() => setDropError(null)}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          {dropNote ? (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-primary/10 px-3 py-2 text-sm">
              <span>
                Booked {dropNote.days} days, {sayDate(dropNote.from)} to {sayDate(dropNote.to)}. That is Terra's
                estimate for the work, not a lock.
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => {
                    open(dropNote.id);
                    setDropNote(null);
                  }}
                >
                  Change it
                </button>
                <button type="button" onClick={() => setDropNote(null)}>
                  <X className="size-4" />
                </button>
              </span>
            </div>
          ) : null}

          {extError ? (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{extError}</span>
              <button type="button" onClick={() => setExtError(null)}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          {extNote ? (
            <div
              className={`mb-3 flex items-start justify-between gap-3 rounded-md px-3 py-2 text-sm ${
                extNote.clashCount > 0 ? "bg-destructive/10" : "bg-primary/10"
              }`}
            >
              <span className="min-w-0">
                <span className="block">
                  {extNote.added.length > 0
                    ? `${extNote.installer} has ${
                        extNote.added.length === 1
                          ? extNote.added[0]
                          : `${extNote.added.length} more days, ${extNote.added[0]} to ${extNote.added[extNote.added.length - 1]}`
                      }${extNote.added.length === 1 ? " too" : ""}.`
                    : `Took ${
                        extNote.removed.length === 1
                          ? extNote.removed[0]
                          : `${extNote.removed.length} days, ${extNote.removed[0]} to ${extNote.removed[extNote.removed.length - 1]},`
                      } off ${extNote.installer}.`}{" "}
                  {extNote.total === 1 ? "1 day on it now." : `${extNote.total} days on it now.`}
                </span>
                {extNote.clashCount > 0 ? (
                  <span className="mt-0.5 flex items-center gap-1.5 font-semibold text-destructive">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {extNote.added.length === 1
                      ? extNote.clashCount === 1
                        ? `${extNote.installer} is already on another job that day. It is on the board in red.`
                        : `${extNote.installer} is already on ${extNote.clashCount} other jobs that day. It is on the board in red.`
                      : `${extNote.clashCount} double bookings on the new days. They are on the board in red.`}
                  </span>
                ) : null}
                {extNote.flags.map((f) => (
                  <span key={f.label} className="mt-0.5 block text-[#8A5A0B]">
                    {f.label}: {f.reason.toLowerCase()}.
                  </span>
                ))}
                {extNote.payNeedsLook ? (
                  <span className="mt-0.5 block text-[#8A5A0B]">
                    Day rate job, so the pay needs another look before it goes out.
                  </span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => {
                    open(extNote.taskId);
                    setExtNote(null);
                  }}
                >
                  Open it
                </button>
                <button type="button" onClick={() => setExtNote(null)}>
                  <X className="size-4" />
                </button>
              </span>
            </div>
          ) : null}

          <div className="card-surface board-scroll overflow-x-auto">
            <div className="min-w-[900px]">
              {/* Day headings, lined up with the lanes underneath. */}
              <div className="flex border-b border-border">
                <div className="sticky left-0 z-20 w-40 shrink-0 border-r border-border bg-card px-3 py-2">
                  <span className="label-xs">Installer</span>
                </div>
                <div className="grid flex-1" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                  {week.days.map((d) => {
                    const isToday = iso(d) === today;
                    return (
                      <div key={iso(d)} className={`px-2 py-2 ${isToday ? "bg-primary/5" : ""}`}>
                        <p className="label-xs">{d.toLocaleDateString("en-AU", { weekday: "short" })}</p>
                        <p className={`tabular text-sm font-semibold ${isToday ? "text-primary" : ""}`}>
                          {d.getDate()}/{d.getMonth() + 1}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              {(installers.data ?? []).map((inst) => {
                const runs = runsFor(tasks, inst.id, dates);
                const lanes = Math.max(1, ...runs.map((r) => r.lane + 1));
                const height = lanes * (LANE_H + LANE_GAP) + LANE_GAP;
                const clashDays = [...new Set(runs.flatMap((r) => r.clashDates))].sort();
                return (
                  <div key={inst.id} className="flex border-b border-border">
                    <div className="sticky left-0 z-20 w-40 shrink-0 border-r border-border bg-card px-3 py-2">
                      <Link to={`/team?open=${inst.id}`} className="flex items-start gap-2">
                        <span className="mt-1 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: inst.colour }} />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold">{inst.name}</span>
                          <span className="block truncate text-[11px] font-normal text-muted-foreground">
                            {inst.crewCapacity === "own_offsider"
                              ? "brings offsider"
                              : inst.crewCapacity === "needs_partner"
                                ? "needs a partner"
                                : "solo"}
                          </span>
                          {clashDays.length ? (
                            <span className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-[#C0362C]">
                              <AlertTriangle className="size-3 shrink-0" />
                              {clashDays.length === 1
                                ? `Double booked ${sayDate(clashDays[0]!).replace(/ \w+$/, "")}`
                                : `Double booked, ${clashDays.length} days`}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </div>

                    {/* One lane per installer. Bars float over the day grid, so a
                        run of days is a single bar instead of a block per cell. */}
                    <div
                      className="relative flex-1"
                      style={{ height }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setHover({ installerId: inst.id, idx: idxFromEvent(e) });
                      }}
                      onDragLeave={() => setHover(null)}
                      onDrop={(e) => drop(inst.id, dates[idxFromEvent(e)] ?? null)}
                    >
                      <div
                        className="absolute inset-0 grid"
                        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                      >
                        {dates.map((date, i) => (
                          <div
                            key={date}
                            className={`border-r border-border/50 last:border-r-0 ${
                              hover?.installerId === inst.id && hover.idx === i
                                ? "bg-primary/10"
                                : date === today
                                  ? "bg-primary/5"
                                  : ""
                            }`}
                          />
                        ))}
                      </div>

                      {runs.map((r) => (
                        <RunBar
                          key={`${r.task.id}-${r.startIdx}`}
                          run={r}
                          cols={cols}
                          dragging={dragId != null && dragId !== r.task.id}
                          busy={extBusyId === r.task.id}
                          onExtend={(by) => extendRun(r.task.id, by)}
                          onOpen={() => open(r.task.id)}
                          onDragStart={() => setDragId(r.task.id)}
                          onDragEnd={endDrag}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* Unassigned queue at the bottom, and the place to drop someone off a job. */}
              <div
                className="flex bg-[#F3EFEA]/60"
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => drop(null, null)}
              >
                <div className="sticky left-0 z-20 w-40 shrink-0 border-r border-border bg-[#F3EFEA] px-3 py-2">
                  <span className="block text-[13px] font-semibold text-[#C0603F]">Unassigned</span>
                  <span className="block text-[11px] font-normal text-muted-foreground">
                    {unassigned.length} waiting
                  </span>
                </div>
                <div className="min-w-0 flex-1 px-2 py-2">
                  {unassigned.length === 0 ? (
                    <p className="px-1 py-2 text-xs text-muted-foreground">
                      Nothing waiting, every dispatch has someone on it. Drop a bar here to take them off one.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {unassigned.map((t) => (
                        <div key={t.id} className="w-[190px]">
                          <TaskBlock
                            task={t}
                            dragging={dragId != null && dragId !== t.id}
                            onOpen={() => open(t.id)}
                            onDragStart={() => setDragId(t.id)}
                            onDragEnd={endDrag}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Drop a dispatch on a day to schedule and assign it in one move. A booked run moves as a whole, so dragging
            a 4 day bar to Wednesday shifts all four days. Drop it on the unassigned row to pull someone off.
          </p>
        </Page>
      </div>

      {selected == null ? null : panel === "book" ? (
        <BookInstallerPanel
          taskId={selected}
          onClose={() => setSelected(null)}
          onBooked={() => board.refetch()}
          onOffers={() => setPanel("offers")}
        />
      ) : (
        <DispatchPanel taskId={selected} onClose={() => setSelected(null)} onBook={() => setPanel("book")} />
      )}
    </div>
  );
}
