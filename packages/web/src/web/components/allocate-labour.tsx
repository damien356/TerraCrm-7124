import * as React from "react";
import { AlertTriangle, Ban, Check, Info } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { Badge } from "./ui/badge";
import { useAllocate, useJobAllocation, usePreviewAllocate } from "../queries/dispatches";
import { useEligible } from "../queries/installers";
import { useBookingAsks } from "./outside-hours";
import { IneligibleNote } from "./book-installer";
import { hmToMin, sayClock, sayDay } from "../../api/lib/work-hours";

/* ---------------------------------------------------------------------------
 * Allocate / Dispatch labour (Damien's brief, 7 Nov 2026, section 1).
 *
 * On the job: tick some or all of a dispatch's labour lines, pick who, the
 * day and the start and finish, review it, then book it as one visit. Lines
 * ticked off a bigger dispatch go onto their own dispatch first, so each
 * person is paid once, for their own lines. Review shows the scope and the
 * recipient before anything is written. Booking sends no offer, text or
 * email: the visit shows in the installer's app as any booking does.
 * ------------------------------------------------------------------------- */

const STATUS: Record<string, { label: string; colour: string }> = {
  unassigned: { label: "Unassigned", colour: "#C0603F" },
  assigned: { label: "Assigned", colour: "#4A7FA5" },
  offered: { label: "Offered", colour: "#D08A1E" },
  accepted: { label: "Accepted", colour: "#5B8C5A" },
  booked: { label: "Booked", colour: "#3D7A5C" },
  completed: { label: "Completed", colour: "#6B6B6B" },
  cancelled: { label: "Cancelled", colour: "#9A9A9A" },
};

const qtyText = (qty: number, unit: string) => `${Number(qty.toFixed(2))} ${unit === "m2" ? "m²" : unit}`;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Review = Awaited<ReturnType<ReturnType<typeof usePreviewAllocate>["mutateAsync"]>>;

export function AllocateLabourModal({ jobId, open, onClose }: { jobId: number; open: boolean; onClose: () => void }) {
  const view = useJobAllocation(open ? jobId : 0);
  const preview = usePreviewAllocate();
  const allocate = useAllocate();

  const [taskId, setTaskId] = React.useState<number | null>(null);
  const [picked, setPicked] = React.useState<number[]>([]);
  const [installerId, setInstallerId] = React.useState("");
  const [date, setDate] = React.useState(today);
  const [start, setStart] = React.useState("07:00");
  const [finish, setFinish] = React.useState("15:00");
  const [overrideNote, setOverrideNote] = React.useState("");
  const [review, setReview] = React.useState<Review | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setTaskId(null);
    setPicked([]);
    setInstallerId("");
    setOverrideNote("");
    setReview(null);
    setError(null);
  }, [open]);

  // Any change means the review on screen is out of date.
  React.useEffect(() => {
    setReview(null);
    setError(null);
  }, [taskId, picked, installerId, date, start, finish]);

  const eligible = useEligible(null, date, 1, taskId && picked.length ? { taskId, itemIds: picked } : null);
  const dispatches = (view.data?.dispatches ?? []).filter((d) => d.status !== "cancelled");
  const mins = (hmToMin(finish) ?? 0) - (hmToMin(start) ?? 0);
  const timesBad = hmToMin(start) == null || hmToMin(finish) == null || mins < 15;
  const input = {
    taskId: taskId ?? 0,
    itemIds: picked,
    installerId: Number(installerId),
    dates: date ? [date] : [],
    arrivalStart: start || null,
    arrivalEnd: finish || null,
    durationHours: timesBad ? null : Math.round((mins / 60) * 100) / 100,
  };
  const ready = taskId != null && picked.length > 0 && Boolean(installerId) && Boolean(date) && !timesBad;

  function tick(dispatchId: number, itemId: number) {
    if (dispatchId !== taskId) {
      // One visit is one dispatch's lines. Ticking another dispatch starts again there.
      setTaskId(dispatchId);
      setPicked([itemId]);
      return;
    }
    setPicked((p) => (p.includes(itemId) ? p.filter((i) => i !== itemId) : [...p, itemId]));
  }

  function runReview() {
    if (!ready) return;
    setError(null);
    preview
      .mutateAsync(input)
      .then(setReview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  const asks = useBookingAsks(
    (flags) => allocate.mutateAsync({ ...input, ...flags, overrideNote: overrideNote.trim() || null }).then(() => onClose()),
    setError,
  );

  const needsNote = Boolean(review?.clashes.length);
  const canBook = Boolean(review && !review.stops.length && (!needsNote || overrideNote.trim().length >= 3)) && !asks.pending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width="max-w-3xl"
      title="Allocate labour"
      subtitle="Tick the work going on one visit, pick who and when, then review it before it is booked."
      footer={
        <>
          <span className="mr-auto text-xs text-muted-foreground">Booking sends no offer, text or email.</span>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {review ? (
            <Button onClick={() => void asks.run()} disabled={!canBook}>
              {asks.pending ? "Booking" : `Book to ${review.recipient.name}`}
            </Button>
          ) : (
            <Button onClick={runReview} disabled={!ready || preview.isPending}>
              {preview.isPending ? "Checking" : "Review"}
            </Button>
          )}
        </>
      }
    >
      {view.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the dispatches.</p>
      ) : !dispatches.length ? (
        <p className="text-sm text-muted-foreground">No dispatches on this job yet.</p>
      ) : (
        <div className="space-y-4">
          {/* --------------------------- the work --------------------------- */}
          <ul className="divide-y divide-border rounded-md border border-border">
            {dispatches.map((d) => {
              const st = STATUS[d.status] ?? { label: d.status, colour: "#6B6B6B" };
              const partLocked = Boolean(d.lock);
              return (
                <li key={d.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{d.title}</span>
                    <Badge colour={st.colour}>{st.label}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {d.installer ? `on ${d.installer.name}` : "nobody on it"}
                      {d.days[0] ? ` · ${sayDay(d.days[0].date)}${d.days[0].arrivalStart ? ` ${sayClock(d.days[0].arrivalStart)}` : ""}` : ""}
                    </span>
                  </div>
                  {d.lines.length ? (
                    <ul className="mt-1 space-y-0.5">
                      {d.lines.map((l) => (
                        <li key={l.itemId}>
                          <label className="flex cursor-pointer items-center gap-2 text-sm">
                            <Checkbox checked={taskId === d.id && picked.includes(l.itemId)} onChange={() => tick(d.id, l.itemId)} />
                            <span className="flex-1">{l.name}</span>
                            {l.skill ? <span className="text-[11px] text-muted-foreground">{l.skill}</span> : null}
                            <span className="tabular w-20 text-right text-xs text-muted-foreground">{qtyText(l.qty, l.unit)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">No work lines. Use Measure up to add work, or Book it on its own.</p>
                  )}
                  {partLocked ? <p className="mt-1 text-[11px] text-muted-foreground">This dispatch is {d.lock}: it can only move as a whole.</p> : null}
                </li>
              );
            })}
          </ul>

          {view.data?.notPay.length ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Not pay:</span> {view.data.notPay.map((l) => l.description).join(", ")}. Materials, freight,
              delivery and disposal are never on an installer's pay.
            </p>
          ) : null}
          {view.data?.unpricedWork.length ? (
            <p className="flex gap-1.5 rounded-md bg-[#D08A1E]/10 px-2.5 py-1.5 text-xs text-[#8A5A0B]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                On the quote with no rate book line, so nobody is paid for it yet: {view.data.unpricedWork.map((l) => `${l.description} (${qtyText(l.qty, l.unit)})`).join(", ")}.
                Add it with Measure up before allocating it.
              </span>
            </p>
          ) : null}

          {/* --------------------------- who and when --------------------------- */}
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Who" className="sm:col-span-2">
              <Select value={installerId} onChange={(e) => setInstallerId(e.target.value)} disabled={!picked.length}>
                <option value="">{picked.length ? "Pick someone…" : "Tick the work first"}</option>
                {(eligible.data ?? []).map((i) => (
                  <option key={i.id} value={i.id} disabled={!i.eligible}>
                    {i.name}
                    {!i.eligible ? ` · can't: ${i.reasons.filter((r) => /ticked|switched on|rate not set/i.test(r)).join(", ")}` : ""}
                  </option>
                ))}
              </Select>
              {picked.length ? <IneligibleNote people={eligible.data} picked={installerId} /> : null}
            </Field>
            <Field label="Date">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Start">
                <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </Field>
              <Field label="Finish">
                <Input type="time" value={finish} onChange={(e) => setFinish(e.target.value)} />
              </Field>
            </div>
          </div>
          {timesBad && start && finish ? <p className="text-xs text-destructive">Finish must be at least 15 minutes after the start.</p> : null}

          {/* ------------------------------ review ------------------------------ */}
          {review ? <ReviewBox review={review} /> : null}
          {review?.clashes.length ? (
            <Field label="Reason to book over it" hint="Goes on the job record.">
              <Textarea rows={2} value={overrideNote} onChange={(e) => setOverrideNote(e.target.value)} />
            </Field>
          ) : null}
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
          {asks.dialog}
        </div>
      )}
    </Modal>
  );
}

function ReviewBox({ review }: { review: Review }) {
  const when = `${review.dates.map(sayDay).join(", ")}, ${sayClock(review.arrivalStart)}${review.arrivalEnd ? ` to ${sayClock(review.arrivalEnd)}` : ""}`;
  return (
    <div className="space-y-2 rounded-md border border-border bg-secondary/40 px-3 py-3 text-sm">
      <p className="font-medium">
        {review.recipient.name}, {when}, one visit
      </p>
      <p className="text-xs">
        <span className="font-medium">Scope:</span> {review.lines.map((l) => `${l.name} ${qtyText(l.qty, l.unit)}`).join(", ")}
      </p>
      {review.staying.length ? (
        <p className="text-xs text-muted-foreground">
          Goes on its own dispatch. Staying where it is: {review.staying.map((l) => `${l.name} ${qtyText(l.qty, l.unit)}`).join(", ")}.
        </p>
      ) : null}
      {review.skills.length ? <p className="text-xs text-muted-foreground">Skills it needs: {review.skills.join(", ")}.</p> : null}
      {review.replacing ? (
        <Line tone="warn">
          Booked to {review.replacing} now. Booking it to {review.recipient.name} takes it off {review.replacing}: you will be asked to confirm, and the change is kept on
          the job record.
        </Line>
      ) : null}
      {review.sameDay.map((s, i) => (
        <Line key={`s${i}`} tone="info">
          Also booked {sayDay(s.date)}: {s.title} {s.when}. Clear of this time, so not a clash.
        </Line>
      ))}
      {review.clashes.map((c, i) => (
        <Line key={`c${i}`} tone="stop">
          Clash {sayDay(c.date)}: {c.title}
          {c.when ? ` ${c.when}` : c.untimed ? " (no time on it)" : ""}. Pick another time, or give a reason below.
        </Line>
      ))}
      {review.unavailable.map((u, i) => (
        <Line key={`u${i}`} tone="warn">
          {sayDay(u.date)}: {u.reason ?? "unavailable"}.
        </Line>
      ))}
      {review.outsideHours.length ? (
        <Line tone="warn">Outside standard working hours (6:00 am-6:00 pm). You will be asked to confirm before it is booked.</Line>
      ) : null}
      {review.stops.map((s, i) => (
        <Line key={`x${i}`} tone="stop">
          {s}
        </Line>
      ))}
      {!review.stops.length && !review.clashes.length ? <Line tone="ok">Ready to book.</Line> : null}
    </div>
  );
}

function Line({ tone, children }: { tone: "ok" | "info" | "warn" | "stop"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? Check : tone === "info" ? Info : tone === "warn" ? AlertTriangle : Ban;
  const cls =
    tone === "ok" ? "text-[var(--success)]" : tone === "info" ? "text-muted-foreground" : tone === "warn" ? "text-[#8A5A0B]" : "text-destructive";
  return (
    <p className={`flex gap-1.5 text-xs ${cls}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
