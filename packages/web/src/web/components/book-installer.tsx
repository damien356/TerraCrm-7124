import * as React from "react";
import { AlertTriangle, Ban, Calendar, Check, Clock, Minus, Plus, TriangleAlert, X } from "lucide-react";
import { Loading, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { useBookTask, usePlanBooking, useTask } from "../queries/tasks";
import { useEligible } from "../queries/installers";

/**
 * BOOK INSTALLER. The whole booking in one panel, not a wizard.
 *
 * The bar this was built to: one job booked in about fifteen seconds. So every
 * field carries a working default, the day list and the conflicts update while
 * you set it up, and there is exactly one button at the bottom.
 *
 * A clash or a day off never blocks the booking. The office can know something
 * the system doesn't, so the warning is loud and the override is recorded.
 */

/** The windows the office actually gives customers. */
const WINDOWS = [
  { label: "7:00am to 11:00am", start: "07:00", end: "11:00" },
  { label: "8:00am to 12:00pm", start: "08:00", end: "12:00" },
  { label: "9:00am to 1:00pm", start: "09:00", end: "13:00" },
  { label: "11:00am to 3:00pm", start: "11:00", end: "15:00" },
  { label: "12:00pm to 4:00pm", start: "12:00", end: "16:00" },
  { label: "1:00pm to 5:00pm", start: "13:00", end: "17:00" },
  { label: "All day, 7:00am to 5:00pm", start: "07:00", end: "17:00" },
];

const DURATIONS = [
  { label: "Half day", hours: 4 },
  { label: "Full day", hours: 8 },
  { label: "Long day", hours: 10 },
];

const money = (n?: number | null) =>
  n == null ? "-" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2 });

const iso = (d: Date) => {
  const c = new Date(d);
  c.setHours(12, 0, 0, 0);
  return c.toISOString().slice(0, 10);
};

const longDate = (date: string) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" });

type Mode = "one" | "multi";
type Following = "same" | "coordinate" | "each";

export function BookInstallerPanel({
  taskId,
  onClose,
  onBooked,
  onOffers,
}: {
  taskId: number;
  onClose: () => void;
  onBooked?: () => void;
  /** Shown as a way out of the panel when the job is going out as an offer instead. */
  onOffers?: () => void;
}) {
  const task = useTask(taskId);
  const t = task.data;

  const [mode, setMode] = React.useState<Mode>("one");
  const [installerId, setInstallerId] = React.useState<string>("");
  const [startDate, setStartDate] = React.useState<string>(() => iso(new Date()));
  const [dayCount, setDayCount] = React.useState(1);
  const [skipNonWorking, setSkipNonWorking] = React.useState(true);
  const [dropped, setDropped] = React.useState<string[]>([]);
  const [windowIdx, setWindowIdx] = React.useState(0);
  const [following, setFollowing] = React.useState<Following>("same");
  const [perDay, setPerDay] = React.useState<Record<string, number>>({});
  const [durationHours, setDurationHours] = React.useState(8);
  const [payOverride, setPayOverride] = React.useState("");
  const [overrideNote, setOverrideNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [seeded, setSeeded] = React.useState(false);

  const eligible = useEligible(t?.skillId ?? null, startDate, t?.crewSize ?? 1);
  const book = useBookTask();
  // True once the office has put the day count in themselves. That number then
  // sticks on the job and beats the rate-based recommendation next time, since
  // they are the ones who know about the furniture and the stairs.
  const [daysByHand, setDaysByHand] = React.useState(false);

  // Prefill from whatever the job already knows: the day it was pencilled in
  // for, and the day count the measure implies. Both stay editable.
  React.useEffect(() => {
    if (!t || seeded) return;
    if (t.scheduledDate) setStartDate(t.scheduledDate);
    if (t.assignedInstallerId) setInstallerId(String(t.assignedInstallerId));
    if (t.durationHours) setDurationHours(t.durationHours);
    const suggested = t.suggested?.days ?? null;
    if (suggested && suggested > 1) {
      setDayCount(suggested);
      setMode("multi");
    }
    if (t.days?.length) {
      setDayCount(t.days.length);
      setMode(t.days.length > 1 ? "multi" : "one");
      const w = WINDOWS.findIndex((x) => x.start === t.days[0]!.arrivalStart && x.end === t.days[0]!.arrivalEnd);
      if (w >= 0) setWindowIdx(w);
    }
    setSeeded(true);
  }, [t, seeded]);

  const days = mode === "one" ? 1 : dayCount;
  const plan = usePlanBooking({
    taskId,
    installerId: installerId ? Number(installerId) : null,
    startDate,
    days,
    skipNonWorking: mode === "multi" && skipNonWorking,
    excludeDates: mode === "multi" ? dropped : [],
  });

  const planned = plan.data;
  const dates = planned?.dates ?? [];
  const clashes = (planned?.days ?? []).filter((d) => d.clashes.length > 0);
  const offDays = (planned?.days ?? []).filter((d) => d.status !== "available");
  const loud = clashes.length > 0 || offDays.length > 0;

  const win = WINDOWS[windowIdx]!;
  const pay = payOverride ? Number(payOverride) : (t?.labourCost ?? t?.payAmount ?? null);

  function submit() {
    if (!t || !installerId) return;
    setError(null);
    book
      .mutateAsync({
        taskId,
        installerId: Number(installerId),
        dates,
        arrivalStart: win.start,
        arrivalEnd: win.end,
        coordinateAfterFirst: mode === "multi" && following === "coordinate",
        perDay:
          mode === "multi" && following === "each"
            ? dates.slice(1).map((date) => {
                const w = WINDOWS[perDay[date] ?? windowIdx]!;
                return { date, arrivalStart: w.start, arrivalEnd: w.end };
              })
            : [],
        durationHours,
        payAmount: payOverride ? Number(payOverride) : null,
        overrideNote: loud && overrideNote ? overrideNote : null,
        manualDays: daysByHand ? dates.length : null,
      })
      .then(() => {
        onBooked?.();
        onClose();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  if (task.isLoading || !t) {
    return (
      <aside className="w-[380px] shrink-0 border-l border-border bg-card">
        <Loading />
      </aside>
    );
  }

  const approx = t.suggested
    ? t.suggested.days === 1
      ? "Approx. 1 day"
      : `Approx. ${t.suggested.days} days`
    : `${t.durationHours}h`;

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-card">
      {/* ---------------------------- job context ---------------------------- */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {t.ref} · {t.title}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t.site?.suburb || "no site"}
            {t.areaM2 ? ` · ${t.areaM2}m²` : ""} · {approx}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary">
          <X className="size-4" />
        </button>
      </div>

      <div className="board-scroll flex-1 overflow-y-auto px-4 py-3">
        {/* ------------------------------ installer ------------------------------ */}
        <Field label="Installer">
          <Select value={installerId} onChange={(e) => setInstallerId(e.target.value)}>
            <option value="">Pick an installer…</option>
            {(eligible.data ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
                {!i.canCoverAlone ? " · can't do 2-man alone" : ""}
              </option>
            ))}
          </Select>
        </Field>

        {/* ---------------------------- booking type ---------------------------- */}
        <div className="mt-3">
          <p className="label-xs mb-1">Booking type</p>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["one", "One day"],
                ["multi", "Multi-day"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  if (value === "multi" && dayCount < 2) setDayCount(Math.max(2, t.suggested?.days ?? 2));
                }}
                className={
                  mode === value
                    ? "rounded-md border-2 border-primary bg-primary/10 px-3 py-2 text-sm font-semibold text-primary"
                    : "rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary"
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* -------------------------------- date -------------------------------- */}
        <Field label={mode === "one" ? "Date" : "Start date"} className="mt-3">
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        {mode === "one" && startDate ? (
          <p className="mt-1 text-xs font-medium text-foreground">{longDate(startDate)}</p>
        ) : null}

        {/* ------------------------------ day count ------------------------------ */}
        {mode === "multi" ? (
          <div className="mt-3">
            <p className="label-xs mb-1">Number of days</p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={dayCount <= 1}
                onClick={() => {
                  setDaysByHand(true);
                  setDayCount((n) => Math.max(1, n - 1));
                }}
              >
                <Minus className="size-4" />
              </Button>
              <span className="tabular w-10 text-center text-lg font-semibold">{dayCount}</span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={dayCount >= 30}
                onClick={() => {
                  setDaysByHand(true);
                  setDayCount((n) => n + 1);
                }}
              >
                <Plus className="size-4" />
              </Button>
              {t.suggested ? (
                <button
                  type="button"
                  onClick={() => {
                    setDaysByHand(false);
                    setDayCount(t.suggested!.days);
                  }}
                  className="ml-1 text-left text-xs text-primary hover:underline"
                >
                  {t.suggested.basis === "manual"
                    ? `Set by hand at ${t.suggested.days} ${t.suggested.days === 1 ? "day" : "days"}`
                    : `Terra reckons ${t.suggested.days} ${t.suggested.days === 1 ? "day" : "days"}`}
                  <span className="block text-[11px] text-muted-foreground">
                    {t.suggested.basis === "manual" ? (
                      "Someone put this in themselves, not off the rates"
                    ) : (
                      <>
                        {t.suggested.qty}
                        {t.suggested.unit === "m2" ? "m²" : ` ${t.suggested.unit}`} at {t.suggested.perDay}/day
                        {t.suggested.basis === "area" ? ", off the area" : ", off the measure"}
                      </>
                    )}
                  </span>
                </button>
              ) : null}
            </div>

            <label htmlFor="book_skip_non_working" className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox
                id="book_skip_non_working"
                checked={skipNonWorking}
                onChange={(e) => setSkipNonWorking(e.target.checked)}
              />
              Skip days they don't work
            </label>
          </div>
        ) : null}

        {/* ------------------------- the days it lands on ------------------------- */}
        {dates.length > 0 ? (
          <div className="mt-3 rounded-md border border-border">
            <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
              <span className="label-xs">
                {mode === "one" ? "The day" : `${dates.length} ${dates.length === 1 ? "day" : "days"}`}
              </span>
              {plan.isFetching ? <Spinner /> : null}
              {mode === "multi" && dropped.length > 0 ? (
                <button type="button" onClick={() => setDropped([])} className="text-[11px] text-primary hover:underline">
                  Put {dropped.length} back
                </button>
              ) : null}
            </div>
            <ul className="divide-y divide-border">
              {(planned?.days ?? []).map((d) => (
                <li key={d.date} className="px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    {d.clashes.length > 0 ? (
                      <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                    ) : d.status === "available" ? (
                      <Check className="size-3.5 shrink-0 text-[var(--success)]" />
                    ) : d.status === "normally_unavailable" ? (
                      <AlertTriangle className="size-3.5 shrink-0 text-[#D08A1E]" />
                    ) : (
                      <Ban className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <span className="tabular text-xs font-medium">{d.label}</span>
                    <span
                      className={
                        d.clashes.length > 0
                          ? "text-[11px] font-medium text-destructive"
                          : d.status === "available"
                            ? "text-[11px] text-muted-foreground"
                            : d.status === "normally_unavailable"
                              ? "text-[11px] font-medium text-[#8A5A0B]"
                              : "text-[11px] font-medium text-destructive"
                      }
                    >
                      {d.clashes.length > 0
                        ? `On Job #${d.clashes[0]!.jobNumber} already${d.clashes.length > 1 ? ` +${d.clashes.length - 1}` : ""}`
                        : d.status === "available"
                          ? "Available"
                          : (d.reason ?? "Unavailable")}
                    </span>
                    {mode === "multi" && dates.length > 1 ? (
                      <button
                        type="button"
                        title="Take this day out of the run"
                        onClick={() => setDropped((x) => [...x, d.date])}
                        className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-destructive"
                      >
                        <X className="size-3.5" />
                      </button>
                    ) : null}
                  </div>

                  {/* Per-day window, only when the office asked to set each one. */}
                  {mode === "multi" && following === "each" && d.date !== dates[0] ? (
                    <Select
                      className="mt-1 h-7 text-xs"
                      value={String(perDay[d.date] ?? windowIdx)}
                      onChange={(e) => setPerDay((p) => ({ ...p, [d.date]: Number(e.target.value) }))}
                    >
                      {WINDOWS.map((w, i) => (
                        <option key={w.label} value={i}>
                          {w.label}
                        </option>
                      ))}
                    </Select>
                  ) : null}
                </li>
              ))}
            </ul>
            {planned && planned.skipped.length > 0 ? (
              <p className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
                Stepped over {planned.skipped.length} {planned.skipped.length === 1 ? "day" : "days"} they don't work.
              </p>
            ) : null}
          </div>
        ) : null}

        {/* ------------------------------- clashes ------------------------------- */}
        {clashes.length > 0 ? (
          <div className="mt-3 rounded-md border-2 border-destructive bg-destructive/10 px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
              <TriangleAlert className="size-4" />
              Already booked
            </p>
            <ul className="mt-1 space-y-0.5">
              {clashes.map((d) =>
                d.clashes.map((c) => (
                  <li key={`${d.date}-${c.taskId}`} className="text-xs text-destructive">
                    {(eligible.data ?? []).find((i) => i.id === Number(installerId))?.name ?? "This installer"} has Job #
                    {c.jobNumber}
                    {c.suburb ? ` ${c.suburb}` : ""} on {d.label}
                  </li>
                )),
              )}
            </ul>
            <p className="mt-1.5 text-[11px] text-destructive/80">
              You can still book it. Say why and it goes on the job record.
            </p>
            <Input
              className="mt-1.5 h-8 text-xs"
              placeholder="e.g. both jobs are in Robina, he's fine"
              value={overrideNote}
              onChange={(e) => setOverrideNote(e.target.value)}
            />
          </div>
        ) : null}

        {/* --------------------------- arrival window --------------------------- */}
        <Field
          label={mode === "one" ? "Customer arrival window" : "First day arrival window"}
          className="mt-3"
        >
          <Select value={String(windowIdx)} onChange={(e) => setWindowIdx(Number(e.target.value))}>
            {WINDOWS.map((w, i) => (
              <option key={w.label} value={i}>
                {w.label}
              </option>
            ))}
          </Select>
        </Field>

        {/* ---------------------------- following days ---------------------------- */}
        {mode === "multi" && dates.length > 1 ? (
          <div className="mt-3">
            <p className="label-xs mb-1">Following days</p>
            <div className="space-y-1">
              {(
                [
                  ["same", "Same window every day"],
                  ["coordinate", "Installer and site to sort it out"],
                  ["each", "Set each day myself"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex cursor-pointer items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="following"
                    aria-label={label}
                    checked={following === value}
                    onChange={() => setFollowing(value)}
                    className="size-3.5 cursor-pointer accent-[var(--primary)]"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {/* ------------------------------- duration ------------------------------- */}
        <Field label={mode === "one" ? "Estimated duration" : "Hours a day"} className="mt-3">
          <Select value={String(durationHours)} onChange={(e) => setDurationHours(Number(e.target.value))}>
            {DURATIONS.map((d) => (
              <option key={d.hours} value={d.hours}>
                {d.label}, {d.hours}h
              </option>
            ))}
          </Select>
        </Field>

        {/* --------------------------------- pay --------------------------------- */}
        <Field
          label="Installer pay"
          hint={
            t.labourCost != null && !payOverride
              ? `Off the rate book${t.labourPricedOn ? `, priced ${t.labourPricedOn}` : ""}. He invoices the lot at the end.`
              : "Leave blank to use the rate book."
          }
          className="mt-3"
        >
          <Input
            type="number"
            inputMode="decimal"
            placeholder={pay != null ? money(pay) : "Use their own rate"}
            value={payOverride}
            onChange={(e) => setPayOverride(e.target.value)}
          />
        </Field>

        {error ? (
          <p className="mt-3 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      {/* -------------------------------- book it -------------------------------- */}
      <div className="border-t border-border px-4 py-3">
        <Button
          className="h-11 w-full text-sm font-semibold"
          disabled={!installerId || dates.length === 0 || book.isPending}
          onClick={submit}
        >
          {book.isPending ? (
            <Spinner className="border-white/40 border-t-white" />
          ) : loud ? (
            <TriangleAlert className="size-4" />
          ) : (
            <Calendar className="size-4" />
          )}
          {dates.length > 1 ? `Book ${dates.length} days` : "Book installer"}
        </Button>
        {dates.length > 0 && installerId ? (
          <p className="mt-1.5 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
            <Clock className="size-3" />
            {dates.length > 1
              ? `${planned?.days[0]?.label} to ${planned?.days[planned.days.length - 1]?.label}`
              : planned?.days[0]?.label}
            {following === "coordinate" && dates.length > 1 ? ", first day only" : ""} · {win.label}
          </p>
        ) : null}
        {onOffers ? (
          <button
            type="button"
            onClick={onOffers}
            className="mt-2 w-full text-center text-xs text-primary hover:underline"
          >
            Offers, status and checklist
          </button>
        ) : null}
      </div>
    </aside>
  );
}
