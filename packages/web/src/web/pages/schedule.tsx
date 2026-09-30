import * as React from "react";
import { Link } from "wouter";
import { Calendar, ChevronLeft, ChevronRight, Radio, Send, Sofa, UserMinus, Users2, X } from "lucide-react";
import { Page } from "../components/layout";
import { BookInstallerPanel } from "../components/book-installer";
import { Loading, Spinner } from "../components/ui/card";
import { Badge, TASK_STATUS_COLOUR, TASK_STATUS_LABEL, tintFor } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import {
  useAssignTask,
  useBoard,
  useRescheduleTask,
  useSetTaskStatus,
  useTask,
  useUnassignTask,
} from "../queries/tasks";
import { useInstallers, useEligible } from "../queries/installers";
import { useBroadcast, useOffersForTask, useSendDirect, useWithdrawOffers } from "../queries/offers";

const money = (n?: number | null) =>
  n == null ? "—" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

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
  onOpen,
  onDragStart,
  compact,
  note,
}: {
  task: any;
  onOpen: () => void;
  onDragStart: (e: React.DragEvent) => void;
  compact?: boolean;
  /** "Day 2 of 4" on a run that spans more than one day. */
  note?: string;
}) {
  const tint = tintFor(task.skill?.groupName);
  return (
    <button
      type="button"
      draggable
      onDragStart={onDragStart}
      onClick={onOpen}
      className="w-full cursor-grab rounded-md border-l-[3px] px-2 py-1.5 text-left transition-shadow hover:shadow-sm active:cursor-grabbing"
      style={{ backgroundColor: tint.fill, borderLeftColor: tint.edge }}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="truncate text-[12px] font-semibold leading-tight text-[#1C1B1A]">{task.title}</p>
        {task.crewSize > 1 ? <Users2 className="mt-0.5 size-3 shrink-0 text-[#1C1B1A]/60" /> : null}
      </div>
      <p className="mt-0.5 truncate text-[11px] leading-tight text-[#1C1B1A]/65">
        #{task.jobNumber} · {task.siteSuburb || task.siteAddress || "no site"}
      </p>
      {note ? (
        <p className="mt-0.5 truncate text-[10px] font-semibold uppercase leading-tight text-[#1C1B1A]/55">{note}</p>
      ) : null}
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
              Job #{t.job.number} · open job
            </Link>
          ) : null}
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary">
          <X className="size-4" />
        </button>
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
              <dd className="tabular font-medium">{t.areaM2 ? `${t.areaM2} m²` : "—"}</dd>
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
              Broadcast — first to accept wins
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
                      {o.offer.declineReason ? ` — "${o.offer.declineReason}"` : ""}
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
  const [selected, setSelected] = React.useState<number | null>(null);
  const [panel, setPanel] = React.useState<"book" | "offers">("book");
  const [dragId, setDragId] = React.useState<number | null>(null);
  const [dropError, setDropError] = React.useState<string | null>(null);

  const tasks = board.data?.tasks ?? [];
  const unassigned = board.data?.unassigned ?? [];

  function open(id: number) {
    setSelected(id);
    setPanel("book");
  }

  function drop(installerId: number | null, date: string | null) {
    if (dragId == null) return;
    setDropError(null);
    reschedule
      .mutateAsync({ id: dragId, scheduledDate: date, installerId })
      .catch((e: unknown) => setDropError(e instanceof Error ? e.message : String(e)));
    setDragId(null);
  }

  if (board.isLoading || installers.isLoading) return <Loading label="Loading the board…" />;

  return (
    <div className="flex">
      <div className="min-w-0 flex-1">
        <Page
          wide
          title="Schedule"
          subtitle="Drag a dispatch onto an installer's day. Skill ticks and the 2-man rule are enforced on drop."
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
          {dropError ? (
            <div className="mb-3 flex items-start justify-between gap-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <span>{dropError}</span>
              <button type="button" onClick={() => setDropError(null)}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}

          <div className="card-surface board-scroll overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 w-40 border-b border-r border-border bg-card px-3 py-2 text-left">
                    <span className="label-xs">Installer</span>
                  </th>
                  {week.days.map((d) => {
                    const isToday = iso(d) === iso(new Date());
                    return (
                      <th
                        key={iso(d)}
                        className={`border-b border-border px-2 py-2 text-left ${isToday ? "bg-primary/5" : ""}`}
                      >
                        <p className="label-xs">{d.toLocaleDateString("en-AU", { weekday: "short" })}</p>
                        <p className={`tabular text-sm font-semibold ${isToday ? "text-primary" : ""}`}>
                          {d.getDate()}/{d.getMonth() + 1}
                        </p>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(installers.data ?? []).map((inst) => (
                  <tr key={inst.id}>
                    <th
                      aria-label={inst.name}
                      className="sticky left-0 z-10 border-b border-r border-border bg-card px-3 py-2 text-left align-top"
                    >
                      <Link to={`/installers?open=${inst.id}`} className="flex items-start gap-2">
                        <span
                          className="mt-1 size-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: inst.colour }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold">{inst.name}</span>
                          <span className="block truncate text-[11px] font-normal text-muted-foreground">
                            {inst.crewCapacity === "own_offsider"
                              ? "brings offsider"
                              : inst.crewCapacity === "needs_partner"
                                ? "needs a partner"
                                : "solo"}
                          </span>
                        </span>
                      </Link>
                    </th>
                    {week.days.map((d) => {
                      const date = iso(d);
                      // A booking can run over several days, so the task shows on
                      // every day it holds, and a day handed to someone else
                      // shows on that person's row instead.
                      const cell = tasks.filter((t) => {
                        const day = t.days.find((d) => d.date === date);
                        if (!day && !t.dates.includes(date)) return false;
                        const lead = day?.installerId ?? t.assignedInstallerId;
                        return lead === inst.id || t.secondInstallerId === inst.id;
                      });
                      return (
                        <td
                          key={date}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => drop(inst.id, date)}
                          className="h-20 border-b border-border px-1.5 py-1.5 align-top transition-colors hover:bg-secondary/50"
                        >
                          <div className="space-y-1">
                            {cell.map((t) => {
                              const seq = t.dates.indexOf(date) + 1;
                              return (
                                <TaskBlock
                                  key={t.id}
                                  task={t}
                                  note={t.dates.length > 1 && seq > 0 ? `Day ${seq} of ${t.dates.length}` : undefined}
                                  onOpen={() => open(t.id)}
                                  onDragStart={() => setDragId(t.id)}
                                />
                              );
                            })}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}

                {/* Unassigned queue lives at the bottom, exactly like the mockup. */}
                <tr>
                  <th className="sticky left-0 z-10 border-r border-border bg-[#F3EFEA] px-3 py-2 text-left align-top">
                    <span className="block text-[13px] font-semibold text-[#C0603F]">Unassigned</span>
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {unassigned.length} waiting
                    </span>
                  </th>
                  <td colSpan={week.days.length} className="bg-[#F3EFEA]/60 px-2 py-2 align-top">
                    {unassigned.length === 0 ? (
                      <p className="px-1 py-2 text-xs text-muted-foreground">
                        Nothing waiting — every dispatch has someone on it.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {unassigned.map((t) => (
                          <div key={t.id} className="w-[190px]">
                            <TaskBlock task={t} onOpen={() => open(t.id)} onDragStart={() => setDragId(t.id)} />
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            Drop a dispatch on a cell to schedule and assign it in one move. Drop it back on the unassigned row to
            pull someone off.
          </p>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drop(null, null)}
            className="mt-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground"
          >
            Drag here to unschedule and free the installer
          </div>
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
