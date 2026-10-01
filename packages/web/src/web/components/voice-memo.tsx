import * as React from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Briefcase,
  CalendarPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  ListTodo,
  Mail,
  MessageSquare,
  Plus,
  Mic,
  Pencil,
  RefreshCw,
  Send,
  Square,
  StickyNote,
  UserPlus,
  X,
} from "lucide-react";
import type { AppRouterClient } from "../../api";
import { cn } from "@/lib/utils";
import { Modal } from "./ui/modal";
import { Button } from "./ui/button";
import { Input, Label, Textarea } from "./ui/field";
import { Spinner } from "./ui/card";
import { clock, useRecorder } from "./voice-recorder";
import {
  useCardLabel,
  useConfirmStatus,
  useDismissAction,
  useAddDispatchFromMemo,
  useBookFromMemo,
  useMarkBooked,
  useMemoJobChoices,
  useRerunMemo,
  useResolveClient,
  useSetActionJob,
  useSendDraft,
  useStartMemo,
  useVoiceMemo,
} from "../queries/memos";
import { useParseCommand } from "../queries/tasks";

/* ---------------------------------------------------------------------------
 * VOICE MEMOS, the web side.
 *
 * Two ways in, one result:
 *   <MemoButton jobId contactId>   on a job or client card. Already knows who.
 *   <GlobalMemoButton>             always on screen. Works out who from what
 *                                  was said, offers a new client if nobody fits.
 *
 * Tap, talk, tap stop. It sends itself. What comes back is a list of what was
 * done and what is waiting for a tap (customer messages, bookings, status moves).
 * ------------------------------------------------------------------------- */

type MemoData = Awaited<ReturnType<AppRouterClient["memos"]["get"]>>;
type Memo = NonNullable<MemoData["memo"]>;
type Action = Memo["actions"][number];

type Target = { jobId: number | null; contactId: number | null } | { memoId: number };

const MemoCtx = React.createContext<{ open: (t: Target) => void }>({ open: () => {} });

export function useMemoLauncher() {
  return React.useContext(MemoCtx);
}

/** Wraps the app once, in the layout. Holds the one memo window. */
export function MemoProvider({ children }: { children: React.ReactNode }) {
  const [target, setTarget] = React.useState<Target | null>(null);
  // A fresh key per open, so a second memo never inherits the first one's state.
  const [nonce, setNonce] = React.useState(0);
  const open = React.useCallback((t: Target) => {
    setTarget(t);
    setNonce((n) => n + 1);
  }, []);
  return (
    <MemoCtx.Provider value={{ open }}>
      {children}
      {target ? <MemoWindow key={nonce} target={target} onClose={() => setTarget(null)} /> : null}
    </MemoCtx.Provider>
  );
}

/** The mic on a job or client card. */
export function MemoButton({
  jobId = null,
  contactId = null,
  compact,
  className,
}: {
  jobId?: number | null;
  contactId?: number | null;
  compact?: boolean;
  className?: string;
}) {
  const { open } = useMemoLauncher();
  if (compact) {
    return (
      <button
        type="button"
        title="Voice memo about this one"
        aria-label="Voice memo"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          open({ jobId, contactId });
        }}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--gold-wash)] hover:text-[var(--gold-deep)]",
          className,
        )}
      >
        <Mic className="size-4" />
      </button>
    );
  }
  return (
    <Button variant="secondary" onClick={() => open({ jobId, contactId })} className={className}>
      <Mic className="size-4" />
      Voice memo
    </Button>
  );
}

/** Always there, bottom right, phone and desktop. */
export function GlobalMemoButton() {
  const { open } = useMemoLauncher();
  return (
    <button
      type="button"
      aria-label="Voice memo"
      title="Voice memo: say who it's about and what you need"
      onClick={() => open({ jobId: null, contactId: null })}
      className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-40 flex size-14 items-center justify-center rounded-full bg-[var(--sidebar)] text-[var(--gold)] shadow-[0_8px_24px_rgba(28,27,26,0.35)] ring-1 ring-[var(--gold)]/40 transition-transform hover:scale-105 active:scale-95"
    >
      <Mic className="size-6" />
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * The window: record, then the result.
 * ------------------------------------------------------------------------- */

function MemoWindow({ target, onClose }: { target: Target; onClose: () => void }) {
  const [memoId, setMemoId] = React.useState<number | null>("memoId" in target ? target.memoId : null);
  const link = "memoId" in target ? { jobId: null, contactId: null } : target;
  const inContext = Boolean(link.jobId || link.contactId);
  const label = useCardLabel(link.jobId, link.contactId);
  const rec = useRecorder();
  const start = useStartMemo();
  const [error, setError] = React.useState<string | null>(null);

  // One tap to talk: the button that opened this already counts as the start.
  const autoStarted = React.useRef(false);
  React.useEffect(() => {
    if (memoId === null && !autoStarted.current) {
      autoStarted.current = true;
      void rec.start();
    }
  }, [memoId, rec]);

  // Stopping sends it. No playback step, it's usually said from the car.
  React.useEffect(() => {
    if (rec.stage !== "recorded" || !rec.blob) return;
    rec.setStage("uploading");
    setError(null);
    start
      .mutateAsync({ blob: rec.blob, seconds: rec.seconds, jobId: link.jobId, contactId: link.contactId })
      .then((r) => setMemoId(r.captureId))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "That recording didn't send. Try again.");
        rec.setStage("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.stage]);

  const close = () => {
    if (rec.stage === "recording") rec.cancel();
    onClose();
  };

  const who = label.data?.name;
  const title = memoId ? "Voice memo" : inContext ? `Voice memo${who ? ` about ${who}` : ""}` : "Voice memo";

  return (
    <Modal open onClose={close} title={title} width="max-w-xl" subtitle={memoId ? null : hintFor(inContext, who)}>
      {memoId ? (
        <MemoResult id={memoId} onAnother={() => { setMemoId(null); rec.reset(); autoStarted.current = false; }} />
      ) : (
        <div className="flex flex-col items-center gap-4 py-6">
          {rec.stage === "recording" ? (
            <>
              <button
                type="button"
                onClick={rec.stop}
                className="relative flex size-24 items-center justify-center rounded-full bg-destructive text-white shadow-md"
              >
                <span className="absolute inset-0 animate-ping rounded-full bg-destructive/30" />
                <Square className="relative size-8" />
              </button>
              <p className="text-lg font-semibold tabular-nums">{clock(rec.seconds)}</p>
              <p className="text-sm text-muted-foreground">Tap to stop and send</p>
              <button type="button" onClick={close} className="text-xs text-muted-foreground hover:underline">
                Cancel, don't send
              </button>
            </>
          ) : rec.stage === "uploading" ? (
            <>
              <Spinner className="size-8" />
              <p className="text-sm text-muted-foreground">Sending the recording…</p>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => void rec.start()}
                className="flex size-24 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md transition-transform hover:scale-105"
              >
                <Mic className="size-9" />
              </button>
              <p className="text-sm text-muted-foreground">Tap to start talking</p>
              {error || rec.error ? (
                <p className="flex items-center gap-1.5 text-center text-sm text-destructive">
                  <AlertTriangle className="size-4 shrink-0" /> {error ?? rec.error}
                </p>
              ) : null}
            </>
          )}
          <Examples inContext={inContext} />
        </div>
      )}
    </Modal>
  );
}

function hintFor(inContext: boolean, who: string | null | undefined) {
  if (inContext) return `${who ? `It's linked to ${who}, so` : "It's linked to this record, so"} there's no need to say their name.`;
  return "Say who it's about: a name, number, suburb or job number is enough.";
}

function Examples({ inContext }: { inContext: boolean }) {
  const lines = inContext
    ? [
        "Email them, we're delayed, new ETA is 3 days after the original date. Ask if that's OK or whether they'd rather pick a colour that's in stock for the same day.",
        "Note that the dog is out the back, and remind me Friday at 8 to confirm the start.",
        "Quote 42 square metres of hybrid to the living and hall, 14 stairs with two winders, uplift of old carpet.",
      ]
    : [
        "New client, Jane Doe, 0412 345 678, from Burleigh. Wants a quote on hybrid. Remind me in an hour to call her back.",
        "Text Carol Nguyen, we'll be there at 7 tomorrow.",
        "Book Pedro on job 4446 Thursday for 3 days.",
      ];
  return (
    <div className="w-full rounded-md bg-secondary/60 px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">For example</p>
      <ul className="mt-1 space-y-1">
        {lines.map((l) => (
          <li key={l} className="text-xs text-muted-foreground">
            "{l}"
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The result: who, then each thing it did or wants a tap on.
 * ------------------------------------------------------------------------- */

export function MemoResult({ id, onAnother }: { id: number; onAnother?: () => void }) {
  const q = useVoiceMemo(id);
  const d = q.data;

  if (!d || d.status === "transcribing" || d.status === "routing") {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <Spinner className="size-8" />
        <p className="text-sm text-muted-foreground">
          {!d || d.status === "transcribing" ? "Listening…" : "Working out what to do…"}
        </p>
        {d?.transcript ? <p className="max-w-md text-center text-xs text-muted-foreground">"{d.transcript}"</p> : null}
        <p className="text-[11px] text-muted-foreground">You can close this, it keeps going. It'll be in Voice drafts.</p>
      </div>
    );
  }

  if (d.status === "failed" || !d.memo) {
    return (
      <div className="space-y-3 py-4">
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertTriangle className="size-4" /> {d.errorMessage ?? "That memo could not be worked out."}
        </p>
        {d.transcript ? <HeardBox key={d.transcript} id={d.id} transcript={d.transcript} heardAs={null} /> : null}
        {onAnother ? (
          <Button variant="outline" onClick={onAnother}>
            <RefreshCw className="size-4" /> Record again
          </Button>
        ) : null}
      </div>
    );
  }

  const m = d.memo;
  const live = m.actions.filter((a) => a.state !== "dismissed");

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[15px] font-semibold leading-snug">{m.summary || "Voice memo"}</p>
        {d.transcript ? (
          <div className="mt-2">
            <HeardBox key={d.transcript} id={d.id} transcript={d.transcript} heardAs={m.heardAs ?? null} />
          </div>
        ) : null}
      </div>

      <ClientPanel memoId={d.id} memo={m} />

      <div className="space-y-2">
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to do from that one.</p>
        ) : (
          live.map((a) => <ActionCard key={a.id} memoId={d.id} memo={m} action={a} />)
        )}
      </div>

      {onAnother ? (
        <div className="flex justify-end border-t border-border pt-3">
          <Button variant="outline" size="sm" onClick={onAnother}>
            <Mic className="size-4" /> Another memo
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ what you said ------------------------------ */

/**
 * The words it heard, always on show, with one tap to fix a misheard name or
 * product and run it again. No re-recording.
 */
function HeardBox({ id, transcript, heardAs }: { id: number; transcript: string; heardAs: string | null }) {
  const rerun = useRerunMemo();
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(transcript);
  const [error, setError] = React.useState<string | null>(null);
  const changed = text.trim() !== transcript.trim() && text.trim().length > 2;
  const box = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    if (editing) box.current?.focus();
  }, [editing]);

  const redo = () => {
    setError(null);
    rerun
      .mutateAsync({ id, transcript: text.trim() })
      .then(() => setEditing(false))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="rounded-md bg-secondary/70 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">What you said</span>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-[var(--gold-deep)] hover:bg-[var(--gold-wash)]"
          >
            <Pencil className="size-3.5" /> Fix what I heard
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-1.5 space-y-2">
          <Textarea
            ref={box}
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="bg-card text-base sm:text-sm"
          />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Fix any names or words, then Redo. The notes, reminders and draft quote from the first go are taken back and
            worked out again. Anything already sent stays sent.
          </p>
          {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!changed || rerun.isPending} onClick={redo}>
              <RefreshCw className="size-3.5" /> {rerun.isPending ? "Redoing…" : "Redo"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setText(transcript);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-0.5 text-sm text-foreground/80">"{transcript}"</p>
      )}
      {heardAs && heardAs.trim() !== transcript.trim() ? (
        <p className="mt-1 text-[11px] text-muted-foreground">First heard as "{heardAs}"</p>
      ) : null}
    </div>
  );
}

/* --------------------------------- client --------------------------------- */

function ClientPanel({ memoId, memo }: { memoId: number; memo: Memo }) {
  const c = memo.client;
  const waiting = memo.actions.some((a) => a.state === "waiting_client" || (a.state === "draft" && !c.contactId));
  const [changing, setChanging] = React.useState(false);

  if ((c.kind === "context" || c.kind === "existing") && !changing) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
        <p className="text-sm">
          <span className="text-muted-foreground">Client </span>
          {c.contactId ? (
            <Link href={`/clients/${c.contactId}`} className="font-medium hover:underline">
              {c.name}
            </Link>
          ) : (
            <span className="font-medium">{c.name}</span>
          )}
        </p>
        {memo.source === "global" ? (
          <button type="button" onClick={() => setChanging(true)} className="text-xs text-muted-foreground hover:underline">
            Wrong person?
          </button>
        ) : null}
      </div>
    );
  }

  if (c.kind === "none" && !waiting && !changing) return null;

  return (
    <div className="rounded-md border-2 border-[var(--gold)]/50 bg-[var(--gold-wash)] px-3 py-3">
      <ClientChooser memoId={memoId} memo={memo} onDone={() => setChanging(false)} />
    </div>
  );
}

function ClientChooser({ memoId, memo, onDone }: { memoId: number; memo: Memo; onDone: () => void }) {
  const c = memo.client;
  const resolve = useResolveClient();
  const [mode, setMode] = React.useState<"pick" | "new">(c.kind === "new" || c.candidates.length === 0 ? "new" : "pick");
  const [form, setForm] = React.useState({
    firstName: c.firstName ?? "",
    lastName: c.lastName ?? "",
    mobile: c.mobile ?? "",
    email: c.email ?? "",
    address: c.address ?? "",
    suburb: c.suburb ?? "",
    postcode: c.postcode ?? "",
    notes: c.notes ?? "",
  });
  const [error, setError] = React.useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = (input: Parameters<typeof resolve.mutateAsync>[0]) => {
    setError(null);
    resolve
      .mutateAsync(input)
      .then(onDone)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const nullIfEmpty = (v: string) => (v.trim() ? v.trim() : null);

  return (
    <div>
      <p className="text-sm font-semibold">
        {mode === "new"
          ? c.kind === "new"
            ? "New client? Check the details, then create."
            : "Nobody matched. Create them as a new client?"
          : c.kind === "unsure"
            ? "Is it one of these?"
            : "Who is it about?"}
      </p>

      {mode === "pick" ? (
        <div className="mt-2 space-y-1.5">
          {c.candidates.map((x) => (
            <button
              key={x.id}
              type="button"
              disabled={resolve.isPending}
              onClick={() => run({ id: memoId, contactId: x.id })}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md border bg-card px-3 py-2 text-left transition-colors hover:border-[var(--gold)]",
                x.id === c.contactId ? "border-[var(--gold)]" : "border-border",
              )}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{x.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{x.detail}</span>
              </span>
              <span className="shrink-0 text-xs font-medium text-[var(--gold-deep)]">
                {x.id === c.contactId ? "Best match, use" : "Use"}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <Label>First name</Label>
            <Input value={form.firstName} onChange={set("firstName")} />
          </div>
          <div>
            <Label>Last name</Label>
            <Input value={form.lastName} onChange={set("lastName")} />
          </div>
          <div>
            <Label>Mobile</Label>
            <Input value={form.mobile} onChange={set("mobile")} inputMode="tel" />
          </div>
          <div>
            <Label>Email</Label>
            <Input value={form.email} onChange={set("email")} inputMode="email" />
          </div>
          <div className="col-span-2">
            <Label>Street address</Label>
            <Input value={form.address} onChange={set("address")} />
          </div>
          <div>
            <Label>Suburb</Label>
            <Input value={form.suburb} onChange={set("suburb")} />
          </div>
          <div>
            <Label>Postcode</Label>
            <Input value={form.postcode} onChange={set("postcode")} inputMode="numeric" />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea rows={2} value={form.notes} onChange={set("notes")} />
          </div>
          <div className="col-span-2">
            <Button
              disabled={!form.firstName.trim() || resolve.isPending}
              onClick={() =>
                run({
                  id: memoId,
                  create: {
                    firstName: form.firstName.trim(),
                    lastName: form.lastName.trim(),
                    mobile: nullIfEmpty(form.mobile),
                    email: nullIfEmpty(form.email),
                    address: nullIfEmpty(form.address),
                    suburb: nullIfEmpty(form.suburb),
                    postcode: nullIfEmpty(form.postcode),
                    notes: nullIfEmpty(form.notes),
                  },
                })
              }
            >
              <UserPlus className="size-4" />
              {resolve.isPending ? "Creating…" : "Create client"}
            </Button>
          </div>
        </div>
      )}

      {error ? <p className="mt-2 text-xs font-medium text-destructive">{error}</p> : null}

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {mode === "pick" ? (
          <button type="button" onClick={() => setMode("new")} className="font-medium text-[var(--gold-deep)] hover:underline">
            Someone new instead
          </button>
        ) : c.candidates.length ? (
          <button type="button" onClick={() => setMode("pick")} className="font-medium text-[var(--gold-deep)] hover:underline">
            Pick from {c.candidates.length} possible match{c.candidates.length === 1 ? "" : "es"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={resolve.isPending}
          onClick={() => run({ id: memoId, none: true })}
          className="text-muted-foreground hover:underline"
        >
          No client for this one
        </button>
      </div>
    </div>
  );
}

/* --------------------------------- actions -------------------------------- */

const KIND: Record<Action["kind"], { label: string; icon: typeof Mic }> = {
  note: { label: "Note", icon: StickyNote },
  task: { label: "Task", icon: ListTodo },
  reminder: { label: "Reminder", icon: Bell },
  create_job: { label: "New job", icon: Briefcase },
  quote: { label: "Quote", icon: FileText },
  email: { label: "Email", icon: Mail },
  sms: { label: "Text", icon: MessageSquare },
  schedule: { label: "Booking", icon: CalendarPlus },
  job_status: { label: "Job status", icon: Briefcase },
};

function ActionCard({ memoId, memo, action: a }: { memoId: number; memo: Memo; action: Action }) {
  const k = KIND[a.kind];
  const Icon = k.icon;
  const settled = a.state === "done" || a.state === "sent";
  const [picking, setPicking] = React.useState(false);
  const [moved, setMoved] = React.useState<string | null>(null);
  // A job made by this memo is the job itself; a sent message has already gone.
  const canMove =
    a.kind !== "create_job" && a.state !== "sent" && a.state !== "dismissed" && a.state !== "waiting_client";

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
            settled
              ? "bg-[var(--success)]/12 text-[var(--success)]"
              : a.state === "failed"
                ? "bg-destructive/10 text-destructive"
                : "bg-[var(--gold-wash)] text-[var(--gold-deep)]",
          )}
        >
          {settled ? <Check className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{k.label}</span>
            {canMove ? (
              <button
                type="button"
                onClick={() => setPicking((v) => !v)}
                aria-expanded={picking}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:border-[var(--gold)]"
              >
                <Briefcase className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{a.jobLabel ? `Job ${a.jobLabel}` : "No job, client only"}</span>
                <span className="shrink-0 font-semibold text-[var(--gold-deep)]">Change job</span>
                {picking ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
              </button>
            ) : a.jobLabel ? (
              <span className="text-[11px] text-muted-foreground">Job {a.jobLabel}</span>
            ) : null}
          </div>
          {picking ? (
            <JobPicker
              memoId={memoId}
              action={a}
              onDone={(note) => {
                setPicking(false);
                setMoved(note);
              }}
            />
          ) : null}
          {moved ? <p className="mt-1 text-[11px] font-medium text-[var(--success)]">{moved}</p> : null}
          <ActionBody memoId={memoId} memo={memo} action={a} />
        </div>
      </div>
    </div>
  );
}

/** Every job of the settled client, newest first, plus "client only". One tap moves the action. */
function JobPicker({ memoId, action: a, onDone }: { memoId: number; action: Action; onDone: (note: string) => void }) {
  const choices = useMemoJobChoices(memoId, true);
  const setJob = useSetActionJob();
  const [error, setError] = React.useState<string | null>(null);
  const needsJob = a.kind === "schedule" || a.kind === "job_status";
  const current = a.noJob ? null : (a.jobId ?? null);
  const list = choices.data ?? [];

  const pick = (jobId: number | null) => {
    setError(null);
    setJob
      .mutateAsync({ id: memoId, actionId: a.id, jobId })
      .then((r) => {
        const where = jobId ? `job ${r.jobLabel ?? ""}`.trim() : "the client, no job";
        onDone(
          a.state === "done"
            ? `Moved to ${where}.`
            : a.kind === "email" || a.kind === "sms"
              ? `Now on ${where}. Check the wording still suits it.`
              : `Now on ${where}.`,
        );
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mt-1.5 rounded-md border border-[var(--gold)]/50 bg-[var(--gold-wash)] p-2">
      <p className="px-1 pb-1 text-xs font-semibold">Which job is this for?</p>
      {choices.isLoading ? (
        <div className="flex justify-center py-2">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          No jobs on file for this client{needsJob ? "." : ", so it stays on their client record."}
        </p>
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {list.map((j, i) => (
            <button
              key={j.id}
              type="button"
              disabled={setJob.isPending}
              onClick={() => (j.id === current ? onDone("") : pick(j.id))}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-2 text-left transition-colors hover:border-[var(--gold)] disabled:opacity-60",
                j.id === current ? "border-[var(--gold)]" : "border-border",
              )}
            >
              <span className="min-w-0">
                <span className="block line-clamp-2 text-sm font-medium leading-snug">{j.label}</span>
                {j.detail || i === 0 ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {[i === 0 ? "Latest job" : null, j.detail].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium text-[var(--gold-deep)]">
                {j.id === current ? "On this one" : "Use"}
              </span>
            </button>
          ))}
        </div>
      )}
      {!needsJob ? (
        <button
          type="button"
          disabled={setJob.isPending || current === null}
          onClick={() => pick(null)}
          className="mt-1.5 w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-60"
        >
          {current === null ? "On the client only (no job)" : "No job, put it on the client only"}
        </button>
      ) : null}
      {error ? <p className="px-1 pt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

function ResultLine({ a }: { a: Action }) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm">
        {a.resultLabel ?? "Done"}
        {a.kind === "note" && a.detail ? <span className="block text-xs text-muted-foreground">{a.detail}</span> : null}
        {(a.kind === "task" || a.kind === "reminder") && a.title ? (
          <span className="block text-xs text-muted-foreground">{a.title}</span>
        ) : null}
      </p>
      {a.resultHref && a.resultHref !== "/" ? (
        <Link href={a.resultHref} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Open <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}

function ActionBody({ memoId, memo, action: a }: { memoId: number; memo: Memo; action: Action }) {
  if (a.state === "done" || a.state === "sent") return <ResultLine a={a} />;
  if (a.state === "waiting_client")
    return (
      <p className="mt-0.5 text-sm text-muted-foreground">
        {a.title || a.detail || "Ready to go"}. <span className="italic">Waiting for the client above.</span>
      </p>
    );
  if ((a.kind === "email" || a.kind === "sms") && (a.state === "draft" || a.state === "failed"))
    return <DraftEditor memoId={memoId} memo={memo} action={a} />;
  if (a.kind === "schedule" && a.state === "confirm")
    return <BookingConfirm key={`${a.jobId ?? "none"}-${a.bookingLine ?? ""}`} memoId={memoId} memo={memo} action={a} />;
  if (a.kind === "job_status" && a.state === "confirm") return <StatusConfirm memoId={memoId} action={a} />;
  if (a.state === "failed")
    return <p className="mt-0.5 text-sm text-destructive">{a.error ?? "That one didn't work."}</p>;
  return <p className="mt-0.5 text-sm text-muted-foreground">{a.title || a.detail || "Working…"}</p>;
}

function Dismiss({ memoId, actionId, label = "Leave it" }: { memoId: number; actionId: number; label?: string }) {
  const dismiss = useDismissAction();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={dismiss.isPending}
      onClick={() => dismiss.mutate({ id: memoId, actionId })}
    >
      <X className="size-3.5" /> {label}
    </Button>
  );
}

function DraftEditor({ memoId, memo, action: a }: { memoId: number; memo: Memo; action: Action }) {
  const send = useSendDraft();
  const [subject, setSubject] = React.useState(a.subject ?? "");
  const [body, setBody] = React.useState(a.body ?? "");
  const [error, setError] = React.useState<string | null>(a.state === "failed" ? a.error : null);
  const [typedTo, setTypedTo] = React.useState("");
  const settled = memo.client.kind === "context" || memo.client.kind === "existing";
  const noClient = !settled || !memo.client.contactId;
  const noAddress = !noClient && !a.to;

  const go = () => {
    setError(null);
    send
      .mutateAsync({
        id: memoId,
        actionId: a.id,
        subject: a.kind === "email" ? subject : null,
        body,
        toAddress: noAddress ? typedTo.trim() || null : null,
      })
      .then((r) => {
        if (!r.ok) setError(r.error ?? "It did not send.");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mt-1 space-y-2">
      <p className="text-xs text-muted-foreground">
        To{" "}
        <span className="font-medium text-foreground">
          {noClient ? "the client" : (memo.client.name ?? "the client")}
          {!noClient && a.to ? `, ${a.to}` : ""}
        </span>
      </p>
      {a.kind === "email" ? (
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" className="h-8 text-sm" />
      ) : null}
      <Textarea rows={a.kind === "email" ? 7 : 3} value={body} onChange={(e) => setBody(e.target.value)} className="text-sm" />
      {noClient ? (
        <p className="text-xs font-medium text-[#8A5A0B]">Pick or create the client above, then send.</p>
      ) : noAddress ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-[#8A5A0B]">
            No {a.kind === "email" ? "email address" : "mobile"} on file for {memo.client.name}. Type one in and it is
            saved to their record when this sends.
          </p>
          <Input
            value={typedTo}
            onChange={(e) => setTypedTo(e.target.value)}
            placeholder={a.kind === "email" ? "name@example.com" : "0412 345 678"}
            inputMode={a.kind === "email" ? "email" : "tel"}
            className="h-8 text-sm"
          />
        </div>
      ) : null}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={noClient || (noAddress && !typedTo.trim()) || !body.trim() || send.isPending} onClick={go}>
          <Send className="size-3.5" /> {send.isPending ? "Sending…" : a.kind === "email" ? "Send email" : "Send text"}
        </Button>
        <Dismiss memoId={memoId} actionId={a.id} label="Don't send" />
      </div>
    </div>
  );
}

function BookingConfirm({ memoId, memo, action: a }: { memoId: number; memo: Memo; action: Action }) {
  const [line, setLine] = React.useState(a.bookingLine ?? "");
  const addDispatch = useAddDispatchFromMemo();
  const jobId = a.jobId ?? memo.contextJobId ?? memo.newJobId ?? null;
  const [settled, setSettled] = React.useState(line);
  const [note, setNote] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(line), 250);
    return () => clearTimeout(t);
  }, [line]);
  const parse = useParseCommand(settled, null);
  const book = useBookFromMemo();
  const marked = useMarkBooked();
  const p = parse.data;
  const clash = (p?.dayChecks ?? []).some((d) => d.clashes.length > 0 || d.status !== "available");
  const noDispatch = Boolean(jobId && p && !p.task && p.problems.some((m) => m.startsWith("No open dispatch")));

  // Same trick as the board's booking box: point the line at one dispatch.
  const pickDispatch = (taskId: number) => {
    const next = /(?:^|\s)#?\d{2,}(?=\s|$)/.test(line)
      ? line.replace(/(?:^|\s)#?\d{2,}(?=\s|$)/, ` @${taskId}`).trim()
      : `${line} @${taskId}`.trim();
    setLine(next);
    setSettled(next);
  };

  const addAndUse = () => {
    if (!jobId) return;
    setError(null);
    addDispatch
      .mutateAsync({ jobId, title: "Install" })
      .then((row) => {
        if (row) pickDispatch(row.id);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const confirm = () => {
    if (!p?.ready || !p.task || !p.installer) return;
    setError(null);
    const installer = p.installer.name;
    const first = p.dayChecks[0]?.label ?? p.dates[0];
    const last = p.dayChecks[p.dayChecks.length - 1]?.label ?? p.dates[p.dates.length - 1];
    book
      .mutateAsync({
        taskId: p.task.id,
        installerId: p.installer.id,
        dates: p.dates,
        arrivalStart: p.arrivalStart,
        arrivalEnd: p.arrivalEnd,
        coordinateAfterFirst: p.coordinateAfterFirst,
        manualDays: p.daysByHand ? p.days : null,
        overrideNote: clash && note ? note : null,
      })
      .then(() =>
        marked.mutateAsync({
          id: memoId,
          actionId: a.id,
          taskId: p.task!.id,
          label: `${installer} booked on #${p.task!.jobNumber}, ${first}${p.dates.length > 1 ? ` to ${last}` : ""}`,
        }),
      )
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="mt-1 space-y-2">
      <Input value={line} onChange={(e) => setLine(e.target.value)} className="h-8 text-sm" />
      {p && settled.trim().length > 1 ? (
        <div className="text-xs">
          <p>
            <span className="font-semibold">{p.installer?.name ?? "Who?"}</span>
            <span className="text-muted-foreground"> on </span>
            <span className="font-medium">{p.task ? `#${p.task.jobNumber} ${p.task.title}` : "which job?"}</span>
            {p.dates.length ? (
              <span className="text-muted-foreground">
                , {p.dayChecks[0]?.label}
                {p.dates.length > 1 ? ` to ${p.dayChecks[p.dayChecks.length - 1]?.label}` : ""} ({p.dates.length}{" "}
                {p.dates.length === 1 ? "day" : "days"})
              </span>
            ) : null}
          </p>
          {p.problems.map((m) => (
            <p key={m} className="mt-0.5 font-medium text-destructive">
              {m}
            </p>
          ))}
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
          {noDispatch ? (
            <Button size="sm" variant="secondary" className="mt-1.5 h-7 text-xs" disabled={addDispatch.isPending} onClick={addAndUse}>
              <Plus className="size-3.5" /> {addDispatch.isPending ? "Adding…" : "Add an install dispatch and book that"}
            </Button>
          ) : null}
          {clash ? (
            <div className="mt-1.5">
              <p className="font-medium text-destructive">Clashes or a day they don't normally work. Say why to book anyway.</p>
              <Input className="mt-1 h-7 text-xs" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason, goes on the job record" />
            </div>
          ) : null}
        </div>
      ) : parse.isFetching ? (
        <Spinner />
      ) : null}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!p?.ready || book.isPending || marked.isPending} onClick={confirm}>
          <CalendarPlus className="size-3.5" /> {book.isPending ? "Booking…" : clash ? "Book anyway" : "Book it"}
        </Button>
        <Dismiss memoId={memoId} actionId={a.id} />
      </div>
    </div>
  );
}

function StatusConfirm({ memoId, action: a }: { memoId: number; action: Action }) {
  const confirm = useConfirmStatus();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="mt-0.5 space-y-2">
      <p className="text-sm">{a.resultLabel ?? "Change the job status"}</p>
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={confirm.isPending || !a.statusId}
          onClick={() =>
            confirm
              .mutateAsync({ id: memoId, actionId: a.id })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }
        >
          <CheckCircle2 className="size-3.5" /> Confirm
        </Button>
        <Dismiss memoId={memoId} actionId={a.id} />
      </div>
    </div>
  );
}
