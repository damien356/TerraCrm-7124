import * as React from "react";
import { Link } from "wouter";
import { Bell, BellRing, Check, Clock, ListTodo, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardHeader, Empty, Loading } from "./ui/card";
import { useCompleteOfficeTask, useOfficeTasks, useSnoozeOfficeTask } from "../queries/memos";

/* ---------------------------------------------------------------------------
 * Office to-dos and reminders, mostly from voice memos.
 *
 *   <OfficeTasksCard>   the list, on the dashboard
 *   <DueReminders>      a pop-up in the corner when a reminder's time comes,
 *                       on every page, so it lands even with no phone set up
 * ------------------------------------------------------------------------- */

const TZ = "Australia/Brisbane";

function when(d: Date | string) {
  const date = new Date(d);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const thatDay = date.toLocaleDateString("en-CA", { timeZone: TZ });
  const time = date.toLocaleTimeString("en-AU", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  if (thatDay === today) return `today ${time}`;
  return `${date.toLocaleDateString("en-AU", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

function dueLabel(dueDate: string) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  if (dueDate < today) return { text: `overdue, ${dueDate}`, late: true };
  if (dueDate === today) return { text: "due today", late: false };
  return { text: `due ${new Date(`${dueDate}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}`, late: false };
}

type Row = NonNullable<ReturnType<typeof useOfficeTasks>["data"]>[number];

function TaskRow({ t }: { t: Row }) {
  const done = useCompleteOfficeTask();
  const snooze = useSnoozeOfficeTask();
  const due = t.dueDate ? dueLabel(t.dueDate) : null;
  return (
    <div className={cn("flex items-start gap-2.5 px-4 py-2.5", t.due ? "bg-[var(--gold-wash)]" : "")}>
      <button
        type="button"
        title="Done"
        aria-label="Mark done"
        disabled={done.isPending}
        onClick={() => done.mutate({ id: t.id })}
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-transparent transition-colors hover:border-[var(--success)] hover:text-[var(--success)]"
      >
        <Check className="size-3" />
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{t.title || "Follow up"}</p>
        {t.detail ? <p className="mt-0.5 line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{t.detail}</p> : null}
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          {t.remindAt ? (
            <span className={cn("inline-flex items-center gap-1", t.due ? "font-semibold text-[var(--gold-deep)]" : "")}>
              {t.due ? <BellRing className="size-3" /> : <Bell className="size-3" />}
              {when(t.remindAt)}
            </span>
          ) : due ? (
            <span className={due.late ? "font-medium text-destructive" : ""}>{due.text}</span>
          ) : null}
          {t.jobId ? (
            <Link href={`/jobs/${t.jobId}`} className="text-primary hover:underline">
              #{t.jobNumber}
            </Link>
          ) : null}
          {t.due ? (
            <button
              type="button"
              disabled={snooze.isPending}
              onClick={() => snooze.mutate({ id: t.id, minutes: 30 })}
              className="inline-flex items-center gap-0.5 font-medium text-[var(--gold-deep)] hover:underline"
            >
              <Clock className="size-3" /> 30 min
            </button>
          ) : null}
        </p>
      </div>
    </div>
  );
}

export function OfficeTasksCard() {
  const q = useOfficeTasks();
  const rows = q.data ?? [];
  const dueCount = rows.filter((r) => r.due).length;
  return (
    <Card>
      <CardHeader
        title="Reminders and to-dos"
        subtitle={dueCount ? `${dueCount} due now` : "From your voice memos, tick them off here"}
        action={<ListTodo className="size-4 text-[var(--gold-deep)]" />}
      />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>Nothing on. Tap the mic and say "remind me in an hour to…"</Empty>
      ) : (
        <div className="board-scroll max-h-[420px] divide-y divide-border overflow-y-auto">
          {rows.map((t) => (
            <TaskRow key={t.id} t={t} />
          ))}
        </div>
      )}
    </Card>
  );
}

/** Corner pop-up for reminders that have come due. Closing it only hides it on this screen. */
export function DueReminders() {
  const q = useOfficeTasks();
  const done = useCompleteOfficeTask();
  const snooze = useSnoozeOfficeTask();
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  // Keyed on the reminder time too, so a snoozed one pops again when it is due again.
  const key = (t: Row) => `${t.id}:${t.remindAt ? new Date(t.remindAt).getTime() : 0}`;
  const due = (q.data ?? []).filter((t) => t.due && !hidden.has(key(t))).slice(0, 3);
  if (due.length === 0) return null;

  return (
    <div className="fixed bottom-[max(5.5rem,calc(env(safe-area-inset-bottom)+4.5rem))] right-5 z-40 flex w-[min(360px,calc(100vw-2.5rem))] flex-col gap-2">
      {due.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="animate-in fade-in slide-in-from-bottom-2 rounded-lg border border-[var(--gold)]/50 bg-card px-3.5 py-3 shadow-lg"
        >
          <div className="flex items-start gap-2">
            <BellRing className="mt-0.5 size-4 shrink-0 text-[var(--gold-deep)]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug">{t.title || "Reminder"}</p>
              {t.detail ? <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-xs text-muted-foreground">{t.detail}</p> : null}
              <div className="mt-2 flex flex-wrap items-center gap-3 text-xs font-medium">
                <button type="button" onClick={() => done.mutate({ id: t.id })} className="text-[var(--success)] hover:underline">
                  Done
                </button>
                <button type="button" onClick={() => snooze.mutate({ id: t.id, minutes: 15 })} className="text-[var(--gold-deep)] hover:underline">
                  15 min
                </button>
                <button type="button" onClick={() => snooze.mutate({ id: t.id, minutes: 60 })} className="text-[var(--gold-deep)] hover:underline">
                  1 hour
                </button>
                {t.jobId ? (
                  <Link href={`/jobs/${t.jobId}`} className="text-primary hover:underline">
                    Job #{t.jobNumber}
                  </Link>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              aria-label="Hide"
              onClick={() => setHidden((h) => new Set(h).add(key(t)))}
              className="rounded p-0.5 text-muted-foreground hover:bg-secondary"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
