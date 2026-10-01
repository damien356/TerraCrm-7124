import * as React from "react";
import { Link } from "wouter";
import { Mic, Square, Upload, AlertTriangle, CheckCircle2, ArrowRight, FileText } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useRecorder, usePlaybackUrl } from "../components/voice-recorder";
import { useProcessVoiceQuote, uploadVoiceRecording } from "../queries/voiceQuotes";
import { useVoiceDrafts } from "../queries/memos";
import { useMemoLauncher } from "../components/voice-memo";

function fmtDateTime(value: Date | string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}


function Recorder({ onProcessed }: { onProcessed: (result: unknown) => void }) {
  const rec = useRecorder();
  const playbackUrl = usePlaybackUrl(rec.blob);
  const process = useProcessVoiceQuote();

  const submit = async () => {
    if (!rec.blob) return;
    rec.setStage("uploading");
    try {
      const ext = rec.blob.type.includes("webm") ? "webm" : "m4a";
      const key = await uploadVoiceRecording(rec.blob, `capture.${ext}`, rec.blob.type);
      rec.setStage("processing");
      const result = await process.mutateAsync({ audioKey: key, durationSeconds: rec.seconds });
      rec.setStage("done");
      onProcessed(result);
    } catch (err) {
      rec.setError(err instanceof Error ? err.message : "That recording could not be processed.");
      rec.setStage("error");
    }
  };

  return (
    <Card>
      <CardHeader
        title="New voice quote"
        subtitle='Talk through the job like you would to Damien on site. Materials, stairs, anything with a dollar figure, say the customer&apos;s name if you know it.'
      />
      <div className="flex flex-col items-center gap-4 px-4 py-10">
        {rec.stage === "idle" || rec.stage === "error" ? (
          <>
            <button
              onClick={rec.start}
              className="flex size-20 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform hover:scale-105"
            >
              <Mic className="size-8" />
            </button>
            <p className="text-sm text-muted-foreground">Tap to start recording</p>
            {rec.error ? (
              <p className="flex items-center gap-1.5 text-sm text-destructive">
                <AlertTriangle className="size-4" /> {rec.error}
              </p>
            ) : null}
          </>
        ) : null}

        {rec.stage === "recording" ? (
          <>
            <button
              onClick={rec.stop}
              className="flex size-20 items-center justify-center rounded-full bg-destructive text-white shadow-sm"
            >
              <Square className="size-7" />
            </button>
            <p className="text-sm font-medium tabular-nums">
              {String(Math.floor(rec.seconds / 60)).padStart(2, "0")}:{String(rec.seconds % 60).padStart(2, "0")}
            </p>
            <p className="text-xs text-muted-foreground">Recording, tap to stop</p>
          </>
        ) : null}

        {rec.stage === "recorded" ? (
          <>
            {/* The user's own just-recorded note, so there are no captions to offer. */}
            <audio controls src={playbackUrl ?? undefined} aria-label="Play back your recording" className="w-full max-w-sm">
              <track kind="captions" />
            </audio>
            <div className="flex gap-2">
              <Button variant="outline" onClick={rec.reset}>
                Record again
              </Button>
              <Button onClick={submit}>
                <Upload className="size-4" /> Turn into a quote
              </Button>
            </div>
          </>
        ) : null}

        {rec.stage === "uploading" || rec.stage === "processing" ? (
          <>
            <Spinner className="size-8" />
            <p className="text-sm text-muted-foreground">
              {rec.stage === "uploading" ? "Uploading recording…" : "Listening, matching the price book, pricing the quote…"}
            </p>
          </>
        ) : null}
      </div>
    </Card>
  );
}

type ProcessResult = {
  captureId: number;
  quote: { id: number; number: number; status: string };
  transcript: string;
  flaggedCount: number;
  lineCount: number;
  matchedCustomerName: string | null;
};

function ResultCard({ result, onDismiss }: { result: ProcessResult; onDismiss: () => void }) {
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <CheckCircle2 className="size-4 text-[#3F7D3A]" /> Quote #{result.quote.number} created
          </span>
        }
        subtitle={`${result.lineCount} line${result.lineCount === 1 ? "" : "s"} priced from the recording`}
      />
      <div className="space-y-3 px-4 py-4">
        <p className="rounded-md bg-secondary px-3 py-2 text-sm text-muted-foreground">"{result.transcript}"</p>
        {result.flaggedCount > 0 ? (
          <p className="flex items-center gap-1.5 text-sm text-[#D08A1E]">
            <AlertTriangle className="size-4" />
            {result.flaggedCount} line{result.flaggedCount === 1 ? "" : "s"} need a look before this goes out.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Every line matched with confidence.</p>
        )}
        {result.matchedCustomerName ? (
          <p className="text-sm text-muted-foreground">Matched to existing customer: {result.matchedCustomerName}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No customer was matched. Open the quote and attach one before sending.
          </p>
        )}
        <div className="flex items-center gap-2 pt-2">
          <Link href={`/quotes/${result.quote.id}`}>
            <Button>
              Open quote <ArrowRight className="size-4" />
            </Button>
          </Link>
          <Button variant="outline" onClick={onDismiss}>
            Record another
          </Button>
        </div>
      </div>
    </Card>
  );
}

type Draft = NonNullable<ReturnType<typeof useVoiceDrafts>["data"]>[number];

/** What on this memo still wants a tap from him. */
function openCount(d: Draft) {
  const m = d.memo;
  if (!m) return 0;
  const clientOpen = m.client.kind === "unsure" || m.client.kind === "new" ? 1 : 0;
  return clientOpen + m.actions.filter((a) => a.state === "draft" || a.state === "confirm" || a.state === "waiting_client" || a.state === "failed").length;
}

const ACTION_WORD: Record<string, string> = {
  note: "note",
  task: "task",
  reminder: "reminder",
  create_job: "new job",
  quote: "quote",
  email: "email",
  sms: "text",
  schedule: "booking",
  job_status: "status",
};

type Filter = "all" | "open" | "memo" | "quote";

function DraftsList() {
  const { data, isLoading } = useVoiceDrafts();
  const { open } = useMemoLauncher();
  const [filter, setFilter] = React.useState<Filter>("all");
  const rows = (data ?? []).filter((d) =>
    filter === "all" ? true : filter === "open" ? openCount(d) > 0 : d.kind === filter,
  );
  const openTotal = (data ?? []).filter((d) => openCount(d) > 0).length;

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "open", label: `Needs a tap${openTotal ? ` (${openTotal})` : ""}` },
    { key: "memo", label: "Memos" },
    { key: "quote", label: "Quotes" },
  ];

  return (
    <Card>
      <CardHeader
        title="Voice drafts"
        subtitle="Every recording, from a job, a client or the mic button, and what it made"
        action={
          <div className="flex flex-wrap gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setFilter(t.key)}
                className={
                  filter === t.key
                    ? "rounded-md bg-[var(--sidebar)] px-2.5 py-1 text-xs font-medium text-white"
                    : "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary"
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        }
      />
      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>{filter === "open" ? "Nothing waiting on you." : "Nothing recorded yet. Tap the mic, bottom right."}</Empty>
      ) : (
        <div className="divide-y divide-border">
          {rows.map((d) => {
            const m = d.memo;
            const waiting = openCount(d);
            const working = d.status === "transcribing" || d.status === "routing";
            const kinds = m ? [...new Set(m.actions.filter((a) => a.state !== "dismissed").map((a) => ACTION_WORD[a.kind] ?? a.kind))] : [];
            const inner = (
              <div className="flex items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {m?.summary || d.transcript || (working ? "Working on it…" : "(no transcript)")}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {fmtDateTime(d.createdAt)} · {d.capturedByName}
                    {m?.client.name ? ` · ${m.client.name}` : ""}
                    {m ? ` · ${m.source === "global" ? "mic button" : m.source === "job" ? "from a job" : "from a client"}` : ""}
                    {kinds.length ? ` · ${kinds.join(", ")}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge colour={d.kind === "memo" ? "#906F3C" : "#4A6A8A"}>{d.kind === "memo" ? "Memo" : "Quote"}</Badge>
                  {working ? (
                    <Spinner />
                  ) : d.status === "failed" ? (
                    <Badge colour="#B4342A">failed</Badge>
                  ) : waiting > 0 ? (
                    <Badge colour="#D08A1E">{waiting} to do</Badge>
                  ) : d.kind === "quote" && d.quote ? (
                    <span className="text-xs font-medium text-primary">Quote #{d.quote.number}</span>
                  ) : (
                    <CheckCircle2 className="size-4 text-[#3F7D3A]" />
                  )}
                </div>
              </div>
            );
            if (d.kind === "memo")
              return (
                <button key={d.id} type="button" className="block w-full" onClick={() => open({ memoId: d.id })}>
                  {inner}
                </button>
              );
            return d.quoteId ? (
              <Link key={d.id} href={`/quotes/${d.quoteId}`} className="block">
                {inner}
              </Link>
            ) : (
              <div key={d.id}>{inner}</div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export default function VoiceDraftsPage() {
  const [result, setResult] = React.useState<ProcessResult | null>(null);
  const [quoting, setQuoting] = React.useState(false);
  const { open } = useMemoLauncher();

  return (
    <Page
      title="Voice drafts"
      subtitle="Memos and quotes you've recorded, and anything still waiting on a tap"
      actions={
        <>
          <Button variant="secondary" onClick={() => setQuoting((v) => !v)}>
            <FileText className="size-4" /> {quoting ? "Hide voice quote" : "Voice quote"}
          </Button>
          <Button onClick={() => open({ jobId: null, contactId: null })}>
            <Mic className="size-4" /> Voice memo
          </Button>
        </>
      }
    >
      <div className="mx-auto max-w-[900px] space-y-4">
        {result ? (
          <ResultCard result={result} onDismiss={() => setResult(null)} />
        ) : quoting ? (
          <Recorder onProcessed={(r) => setResult(r as ProcessResult)} />
        ) : null}
        <DraftsList />
      </div>
    </Page>
  );
}
