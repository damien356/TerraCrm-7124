import * as React from "react";
import { AlertTriangle, Check, ClipboardCheck, Info, Mic, Minus, Octagon, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { Card, CardHeader, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Textarea } from "./ui/field";
import { clock, useRecorder } from "./voice-recorder";
import type { client } from "../lib/api";
import { uploadVoiceRecording } from "../queries/voiceQuotes";
import {
  useApplyQuoteAgent,
  useAskQuoteAgent,
  useClearQuoteAgent,
  useQuoteAgentHistory,
  useQuoteCheck,
} from "../queries/quoteAgent";

/**
 * The quote assistant. Type or say what the job needs and it proposes lines
 * and wording. Nothing goes on the quote until someone ticks the changes and
 * taps Apply, and Apply runs as that person, so their limits still hold.
 */

type History = Awaited<ReturnType<typeof client.quoteAgent.history>>;
type Message = History["messages"][number];
type Step = NonNullable<Message["proposal"]>["actions"][number];
type CheckResult = Awaited<ReturnType<typeof client.quoteAgent.check>>;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

const LEVEL = {
  stop: { label: "Stop", colour: "#B4342A", icon: Octagon },
  warn: { label: "Check", colour: "#B87414", icon: AlertTriangle },
  info: { label: "Note", colour: "#5A6B7B", icon: Info },
} as const;

function CheckPanel({ result, loading, onClose }: { result: CheckResult | undefined; loading: boolean; onClose: () => void }) {
  return (
    <div className="mx-4 mt-3 rounded-md border border-border bg-secondary/40 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {loading && !result
            ? "Checking…"
            : result?.items.length
              ? result.ok
                ? "Fine to send, worth a look first"
                : "Fix these before sending"
              : "All clear to send"}
        </p>
        <Button size="icon-sm" variant="ghost" aria-label="Close the check" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      {result?.items.length ? (
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {result.items.map((it, i) => {
            const l = LEVEL[it.level];
            const Icon = l.icon;
            return (
              <li key={`${it.code}-${i}`} className="flex items-start gap-2 text-[13px]">
                <Badge colour={l.colour} className="mt-px shrink-0">
                  <Icon className="size-3" />
                  {l.label}
                </Badge>
                <span>{it.message}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function StepRow({
  step,
  index,
  applied,
  ticked,
  disabled,
  onToggle,
}: {
  step: Step;
  index: number;
  applied: boolean;
  ticked: boolean;
  disabled: boolean;
  onToggle: (i: number) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const wording = step.type === "set_wording" ? step.wording : null;
  return (
    <li className="flex items-start gap-2 py-1.5 text-[13px]">
      {applied ? (
        step.status === "applied" ? (
          <Check className="mt-0.5 size-4 shrink-0 text-[#3F7D3A]" aria-label="Applied" />
        ) : step.status === "failed" ? (
          <X className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Did not go on" />
        ) : (
          <Minus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Skipped" />
        )
      ) : (
        <Checkbox
          className="mt-0.5 shrink-0"
          checked={ticked}
          disabled={disabled}
          aria-label={`Include: ${step.label}`}
          onChange={() => onToggle(index)}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className={applied && step.status === "skipped" ? "text-muted-foreground line-through" : undefined}>{step.label}</p>
        {applied && step.status === "failed" && step.error ? (
          <p className="text-xs text-destructive">{step.error}</p>
        ) : null}
        {wording ? (
          <>
            <p
              className={`mt-1 whitespace-pre-line rounded bg-white/70 px-2 py-1.5 text-[12.5px] text-[#4A4A4A] ${open ? "" : "line-clamp-3"}`}
            >
              {wording}
            </p>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => setOpen((v) => !v)}>
              {open ? "Show less" : "Read it all"}
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function ProposalBlock({
  message,
  locked,
  superseded,
  onError,
}: {
  message: Message;
  locked: boolean;
  superseded: boolean;
  onError: (m: string | null) => void;
}) {
  const apply = useApplyQuoteAgent();
  const [skip, setSkip] = React.useState<Set<number>>(() => new Set());
  const proposal = message.proposal!;
  const applied = !!message.appliedAt;
  const count = proposal.actions.length - skip.size;

  const toggle = (i: number) =>
    setSkip((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  async function go() {
    onError(null);
    try {
      const r = await apply.mutateAsync({ messageId: message.id, skip: [...skip] });
      if (r.failed) onError(`${r.failed} change${r.failed === 1 ? "" : "s"} did not go on. The reason is under each one.`);
    } catch (e) {
      onError(errText(e));
    }
  }

  const done = applied ? proposal.actions.filter((a) => a.status === "applied").length : 0;

  // A newer suggestion replaces this one. Applying old wording would undo the new.
  if (superseded && !applied) {
    return (
      <div className="mt-2 rounded-md border border-border bg-secondary/30 px-3 py-2 text-[13px] text-muted-foreground">
        <p className="text-xs font-semibold uppercase tracking-wide">Replaced by a newer suggestion</p>
        <ul className="mt-1 list-disc pl-5">
          {proposal.actions.map((a, i) => (
            <li key={i}>{a.label}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-[var(--gold)]/50 bg-[var(--gold)]/[0.07] px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {applied ? `Applied ${done} of ${proposal.actions.length}` : "Proposed changes"}
        </p>
        {applied ? null : (
          <Button size="sm" disabled={locked || apply.isPending || count === 0} onClick={go}>
            {apply.isPending ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />}
            {count === proposal.actions.length ? (count === 1 ? "Apply" : "Apply all") : `Apply ${count}`}
          </Button>
        )}
      </div>
      <ul className="divide-y divide-border/60">
        {proposal.actions.map((a, i) => (
          <StepRow
            key={i}
            step={a}
            index={i}
            applied={applied}
            ticked={!skip.has(i)}
            disabled={locked || apply.isPending}
            onToggle={toggle}
          />
        ))}
      </ul>
      {!applied && locked ? <p className="pt-1 text-xs text-muted-foreground">The quote is locked, so this can't go on.</p> : null}
    </div>
  );
}

function Bubble({
  m,
  locked,
  superseded,
  onError,
}: {
  m: Message;
  locked: boolean;
  superseded: boolean;
  onError: (e: string | null) => void;
}) {
  if (m.role === "user") {
    return (
      <div className="flex flex-col items-end">
        {m.userName && !m.mine ? <span className="mb-0.5 text-[11px] text-muted-foreground">{m.userName}</span> : null}
        <div className="max-w-[85%] whitespace-pre-line rounded-lg rounded-br-sm bg-secondary px-3 py-2 text-sm">
          {m.content || <span className="italic text-muted-foreground">Listening to the recording…</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start">
      <div className="w-full max-w-[92%]">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-1 size-3.5 shrink-0 text-[var(--gold)]" />
          <div className="min-w-0 flex-1 whitespace-pre-line text-sm">{m.content}</div>
        </div>
        {m.proposal?.actions.length ? <ProposalBlock message={m} locked={locked} superseded={superseded} onError={onError} /> : null}
      </div>
    </div>
  );
}

export function QuoteAgentCard({ quoteId, locked }: { quoteId: number; locked: boolean }) {
  const history = useQuoteAgentHistory(quoteId);
  const ask = useAskQuoteAgent();
  const clear = useClearQuoteAgent();
  const rec = useRecorder();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [showCheck, setShowCheck] = React.useState(false);
  const check = useQuoteCheck(quoteId, showCheck);
  const listRef = React.useRef<HTMLDivElement>(null);

  const messages = history.data?.messages ?? [];
  const latestProposal = messages.reduce((id, m) => (m.proposal?.actions.length ? m.id : id), 0);
  const working = ask.isPending || rec.stage === "uploading" || !!history.data?.runningFor;

  // Keep the newest message in view.
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, working]);

  async function send(message: string, audioKey?: string) {
    setError(null);
    try {
      await ask.mutateAsync({ quoteId, message, audioKey: audioKey ?? null });
    } catch (e) {
      setError(errText(e));
    }
  }

  function submit() {
    const m = text.trim();
    if (!m || working) return;
    setText("");
    void send(m);
  }

  // A finished recording goes straight up and in, with anything typed alongside it.
  React.useEffect(() => {
    if (rec.stage !== "recorded" || !rec.blob) return;
    const blob = rec.blob;
    const typed = text.trim();
    rec.setStage("uploading");
    (async () => {
      try {
        const ext = blob.type.includes("webm") ? "webm" : "m4a";
        const key = await uploadVoiceRecording(blob, `assistant.${ext}`, blob.type);
        setText("");
        rec.reset();
        await send(typed, key);
      } catch (e) {
        rec.reset();
        setError(errText(e));
      }
    })();
    // Runs once per finished recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec.stage]);

  async function startOver() {
    if (!window.confirm("Clear your conversation on this quote? Changes already applied stay on the quote.")) return;
    setError(null);
    try {
      await clear.mutateAsync({ quoteId });
    } catch (e) {
      setError(errText(e));
    }
  }

  const mine = messages.some((m) => m.mine);
  const runningOther = !!history.data?.runningFor && !messages.some((m) => m.id === history.data?.runningFor);

  return (
    <Card>
      <CardHeader
        title="Quote assistant"
        subtitle="Tell it the job and it proposes lines and wording. Nothing changes until you tap Apply."
        action={
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => (showCheck ? void check.refetch() : setShowCheck(true))}
              disabled={check.isFetching}
            >
              {check.isFetching ? <Spinner className="size-3.5" /> : <ClipboardCheck className="size-3.5" />}
              <span className="hidden sm:inline">Check before sending</span>
              <span className="sm:hidden">Check</span>
            </Button>
            {mine ? (
              <Button size="icon-sm" variant="ghost" aria-label="Clear the conversation" title="Clear your conversation" onClick={startOver} disabled={working || clear.isPending}>
                <Trash2 className="size-3.5" />
              </Button>
            ) : null}
          </div>
        }
      />

      {showCheck ? (
        <CheckPanel result={check.data} loading={check.isFetching} onClose={() => setShowCheck(false)} />
      ) : null}
      {check.error && showCheck ? (
        <div className="mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errText(check.error)}
        </div>
      ) : null}

      <div ref={listRef} className="flex max-h-[460px] flex-col gap-3 overflow-y-auto px-4 py-3">
        {history.data?.hiddenCount ? (
          <p className="text-center text-xs text-muted-foreground">
            {history.data.hiddenCount} message{history.data.hiddenCount === 1 ? "" : "s"} from an Admin's conversation hidden.
          </p>
        ) : null}
        {history.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : messages.length === 0 && !working && locked ? (
          <p className="text-sm text-muted-foreground">No conversation on this version.</p>
        ) : messages.length === 0 && !working ? (
          <div className="text-sm text-muted-foreground">
            <p>Try something like:</p>
            <ul className="mt-1 list-disc pl-5">
              <li>Add underlay for 30 m², carpet labour for 9 lm and 14 stairs.</li>
              <li>Write the wording for the client.</li>
              <li>How much is Riverhill floor protection?</li>
            </ul>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} locked={locked} superseded={m.id !== latestProposal} onError={setError} />)
        )}
        {working ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {rec.stage === "uploading" ? "Sending the recording…" : runningOther ? "Answering someone else's question on this quote…" : "Working on it…"}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      ) : null}
      {rec.error ? <p className="mx-4 mb-2 text-sm text-destructive">{rec.error}</p> : null}

      {locked ? (
        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          This quote is locked. Make a new version to change it. The check above still works.
        </p>
      ) : (
        <div className="flex items-end gap-2 border-t border-border px-4 py-3">
          {rec.stage === "recording" ? (
            <div className="flex h-[62px] flex-1 items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 text-sm">
              <span className="size-2.5 animate-pulse rounded-full bg-destructive" />
              <span className="tabular">{clock(rec.seconds)}</span>
              <span className="text-muted-foreground">Listening. Tap stop when you are done.</span>
            </div>
          ) : (
            <Textarea
              rows={2}
              value={text}
              disabled={working}
              placeholder="Type or tap the mic. Enter sends, Shift+Enter for a new line."
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="min-h-[62px] flex-1 resize-none"
            />
          )}
          <div className="flex flex-col gap-1.5">
            {rec.stage === "recording" ? (
              <>
                <Button size="icon-sm" variant="default" aria-label="Stop and send" title="Stop and send" onClick={rec.stop}>
                  <Square className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Throw the recording away" title="Cancel" onClick={rec.cancel}>
                  <X className="size-3.5" />
                </Button>
              </>
            ) : (
              <>
                <Button size="icon-sm" variant="outline" aria-label="Record" title="Say it instead" disabled={working} onClick={rec.start}>
                  <Mic className="size-3.5" />
                </Button>
                <Button size="icon-sm" aria-label="Send" title="Send" disabled={working || !text.trim()} onClick={submit}>
                  <Send className="size-3.5" />
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
