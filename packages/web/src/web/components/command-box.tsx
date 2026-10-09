import * as React from "react";
import { AlertTriangle, Ban, Check, CornerDownLeft, Info, Search, TriangleAlert, X } from "lucide-react";
import { Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { useBookTask, useParseCommand } from "../queries/tasks";

/**
 * Book a job by saying it, not clicking it.
 *
 * "Pedro 4446 thu 3 days 7-11" is one line and about four seconds. The preview
 * underneath shows what it resolved to before anything is written, so the
 * office reads it back rather than trusting it.
 *
 * Nothing here hard-blocks except a genuine gap: no installer, no job, or a
 * name two people answer to. A clash, a day off, a word it could not place all
 * come through loud and still book, because the office knows things the data
 * does not.
 */
export function CommandBox({
  onBooked,
  onOpenTask,
}: {
  onBooked: (summary: { taskId: number; days: number; from: string; to: string; installer: string }) => void;
  onOpenTask: (taskId: number) => void;
}) {
  const [text, setText] = React.useState("");
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const book = useBookTask();

  // The preview trails the typing by a beat. Without this every keystroke is a
  // round trip, and the line is usually only half said.
  const [settled, setSettled] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(text), 220);
    return () => clearTimeout(t);
  }, [text]);

  const parse = useParseCommand(settled, null);
  const p = parse.data;
  const typing = settled !== text;

  const clashDays = (p?.dayChecks ?? []).filter((d) => d.clashes.length > 0);
  const offDays = (p?.dayChecks ?? []).filter((d) => d.status !== "available");
  const loud = clashDays.length > 0 || offDays.length > 0;

  function reset() {
    setText("");
    setSettled("");
    setNote("");
  }

  function confirm() {
    if (!p?.ready || !p.task || !p.installer) return;
    setError(null);
    const installerName = p.installer.name;
    book
      .mutateAsync({
        taskId: p.task.id,
        installerId: p.installer.id,
        dates: p.dates,
        arrivalStart: p.arrivalStart,
        arrivalEnd: p.arrivalEnd,
        coordinateAfterFirst: p.coordinateAfterFirst,
        // A day count said out loud is the office's own call, so it sticks to
        // the task and beats the rates from here on, same as on the panel.
        manualDays: p.daysByHand ? p.days : null,
        overrideNote: loud && note ? note : null,
      })
      .then(() => {
        onBooked({
          taskId: p.task!.id,
          days: p.dates.length,
          from: p.dates[0]!,
          to: p.dates[p.dates.length - 1]!,
          installer: installerName,
        });
        reset();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  /** Swap the ambiguous job number for the exact dispatch the office picked. */
  function pickDispatch(taskId: number) {
    setText((t) => t.replace(/(?:^|\s)#?\d{2,}(?=\s|$)/, ` @${taskId}`).trim());
  }

  return (
    <div className="mb-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && p?.ready && !book.isPending) confirm();
            if (e.key === "Escape") reset();
          }}
          placeholder="Book it in one line: Pedro 4446 thu 3 days 7-11"
          className="h-10 pl-8 pr-24 text-sm"
        />
        <span className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
          {parse.isFetching || typing ? <Spinner /> : null}
          {text ? (
            <button type="button" onClick={reset} className="text-muted-foreground hover:text-foreground">
              <X className="size-4" />
            </button>
          ) : null}
        </span>
      </div>

      {!text ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Name, job number, day, how long, arrival window. Any order, and only the name and the job are needed.
        </p>
      ) : null}

      {/* ------------------------------ the preview ------------------------------ */}
      {p && settled.trim().length > 1 ? (
        <div className="mt-2 rounded-md border border-border bg-card px-3 py-2">
          {/* What it resolved to, read back in one line. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{p.installer ? p.installer.name : "Who?"}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-sm">
              {p.task ? (
                <button type="button" onClick={() => onOpenTask(p.task!.id)} className="hover:underline">
                  {p.task.ref} {p.task.title}
                </button>
              ) : (
                "Which job?"
              )}
            </span>
            {p.dates.length ? (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="tabular text-sm">
                  {p.dayChecks[0]?.label}
                  {p.dates.length > 1 ? ` to ${p.dayChecks[p.dayChecks.length - 1]?.label}` : ""}
                </span>
                <span className="text-xs text-muted-foreground">
                  {p.dates.length} {p.dates.length === 1 ? "day" : "days"}
                  {p.coordinateAfterFirst
                    ? ", rings the site"
                    : p.arrivalStart
                      ? `, ${p.arrivalStart} to ${p.arrivalEnd ?? "?"}`
                      : ", no window said"}
                </span>
              </>
            ) : null}
          </div>

          {/* Genuine gaps. Nothing books until these are answered. */}
          {p.problems.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {p.problems.map((m) => (
                <li key={m} className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  {m}
                </li>
              ))}
            </ul>
          ) : null}

          {/* One job, several dispatches: pick the one they meant. */}
          {p.jobChoices.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {p.jobChoices.map((c) => (
                <button
                  key={c.taskId}
                  type="button"
                  onClick={() => pickDispatch(c.taskId)}
                  className="rounded border border-border px-2 py-1 text-xs hover:bg-secondary"
                >
                  {c.label}
                </button>
              ))}
            </div>
          ) : null}

          {/* Filled in for them. Said out loud, never in the way. */}
          {p.notes.length ? (
            <ul className="mt-1.5 space-y-0.5">
              {p.notes.map((m) => (
                <li key={m} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="size-3 shrink-0" />
                  {m}
                </li>
              ))}
            </ul>
          ) : null}

          {/* Every day it lands on, and what is already there. Only means
              anything once we know whose days they are. */}
          {p.installer && (p.dates.length > 1 || loud) ? (
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {p.dayChecks.map((d) => (
                <li key={d.date} className="flex items-center gap-1">
                  {d.clashes.length > 0 ? (
                    <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                  ) : d.status === "available" ? (
                    <Check className="size-3.5 shrink-0 text-[var(--success)]" />
                  ) : d.status === "normally_unavailable" ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-[#D08A1E]" />
                  ) : (
                    <Ban className="size-3.5 shrink-0 text-destructive" />
                  )}
                  <span className="tabular text-[11px] font-medium">{d.label}</span>
                  {d.clashes.length > 0 ? (
                    <span className="text-[11px] font-medium text-destructive">
                      on #{d.clashes[0]!.jobNumber}
                      {d.clashes.length > 1 ? ` +${d.clashes.length - 1}` : ""}
                    </span>
                  ) : d.status !== "available" ? (
                    <span className="text-[11px] font-medium text-[#8A5A0B]">{d.reason ?? "Unavailable"}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}

          {/* A clash books anyway, with the reason on the record. */}
          {loud ? (
            <div className="mt-2 rounded-md border-2 border-destructive bg-destructive/10 px-2.5 py-1.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                <TriangleAlert className="size-3.5" />
                {clashDays.length
                  ? `Already booked ${clashDays.length === 1 ? "that day" : `on ${clashDays.length} of those days`}`
                  : "Days they don't normally work"}
              </p>
              <p className="mt-0.5 text-[11px] text-destructive/80">
                You can still book it. Say why and it goes on the job record.
              </p>
              <Input
                className="mt-1.5 h-8 text-xs"
                placeholder="e.g. both jobs are in Robina, he's fine"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          ) : null}

          {error ? (
            <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" disabled={!p.ready || book.isPending} onClick={confirm}>
              {book.isPending ? "Booking…" : loud ? "Book it anyway" : "Book it"}
              <CornerDownLeft className="ml-1 size-3.5" />
            </Button>
            {p.ready ? (
              <span className="text-[11px] text-muted-foreground">Or just press enter.</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
