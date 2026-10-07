import * as React from "react";
import { Mail, OctagonAlert, Plus, X } from "lucide-react";
import { Button } from "./ui/button";
import { Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { useClearSwmsFlag, useEmailSwms, useSwmsEmailPeople, useSwmsJob } from "../queries/swms";
import { swmsDay, swmsTime } from "./swms";

const RED = "#B3261E";
const ANSWER: Record<string, string> = { yes: "Yes", no: "No", unsure: "Unsure", na: "N/A" };
export const answerLabel = (a: string) => ANSWER[a] ?? a;

type JobData = NonNullable<ReturnType<typeof useSwmsJob>["data"]>;
type Flag = JobData["flags"][number];
type SwmsRecord = JobData["records"][number];

function when(d: Date | string) {
  const x = new Date(d);
  const date = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short" }).format(x);
  return `${date}, ${swmsTime(x)}`;
}

/**
 * Open SWMS red cards, at the top of the job. A card that stops the job means
 * Crew cannot sign or start until someone here clears it with a note.
 */
export function SwmsRedCards({ jobId }: { jobId: number }) {
  const q = useSwmsJob(jobId);
  const [clearing, setClearing] = React.useState<Flag | null>(null);
  const open = (q.data?.flags ?? []).filter((f) => !f.clearedAt);
  if (!open.length) return null;
  return (
    <div className="grid gap-2">
      {open.map((f) => (
        <div
          key={f.id}
          className="flex flex-wrap items-start justify-between gap-3 rounded-xl border-2 px-4 py-3"
          style={{ borderColor: RED, background: "#B3261E0F" }}
          role="alert"
        >
          <div className="flex min-w-0 flex-1 gap-2.5">
            <OctagonAlert className="mt-0.5 size-5 shrink-0" style={{ color: RED }} />
            <div className="min-w-0">
              <p className="text-sm font-semibold" style={{ color: RED }}>
                SWMS red card{f.blocks ? ": job stopped" : ""}
              </p>
              <p className="mt-0.5 text-sm">
                {f.question} <span className="font-semibold">{answerLabel(f.answer)}</span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {f.installerName || "Crew"}, {when(f.createdAt)}.{" "}
                {f.blocks
                  ? "Crew cannot sign the SWMS or start until this is cleared. Call them."
                  : "Crew can still start. Check it and clear it."}
                {f.emailed ? " Emailed to team@." : ""}
              </p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setClearing(f)}>
            Clear
          </Button>
        </div>
      ))}
      {clearing ? <ClearFlagModal flag={clearing} onClose={() => setClearing(null)} /> : null}
    </div>
  );
}

function ClearFlagModal({ flag, onClose }: { flag: Flag; onClose: () => void }) {
  const clear = useClearSwmsFlag();
  const [note, setNote] = React.useState("");
  async function go() {
    await clear.mutateAsync({ id: flag.id, note });
    onClose();
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Clear the red card"
      subtitle={`${flag.question} ${answerLabel(flag.answer)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={clear.isPending || note.trim().length < 3} onClick={() => void go()}>
            Clear it
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="What was sorted">
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Spoke to David. Builder confirmed the slab test passed, OK to lay."
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          {flag.blocks ? "Crew can sign and start once this is cleared. " : ""}
          Your name, the time and this note are kept on the job. The card is not deleted.
        </p>
        {clear.error ? <p className="text-xs text-destructive">{clear.error.message}</p> : null}
      </div>
    </Modal>
  );
}

/** Cleared red cards, for the record. */
export function ClearedFlags({ flags }: { flags: Flag[] }) {
  const done = flags.filter((f) => f.clearedAt);
  if (!done.length) return null;
  return (
    <div className="border-t border-border px-4 py-2.5 text-xs">
      <p className="mb-1 font-medium text-muted-foreground">Cleared red cards</p>
      <ul className="grid gap-1">
        {done.map((f) => (
          <li key={f.id}>
            <span className="font-medium">{f.question}</span> {answerLabel(f.answer)}, from {f.installerName || "Crew"} {when(f.createdAt)}.{" "}
            <span className="text-muted-foreground">
              Cleared by {f.clearedByName} {when(f.clearedAt!)}: {f.clearNote}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Email a signed SWMS to the builder. Prefilled, editable, every send logged. */
export function EmailSwmsModal({
  jobId,
  records,
  recordId,
  onClose,
}: {
  jobId: number;
  records: SwmsRecord[];
  recordId: number | null;
  onClose: () => void;
}) {
  const people = useSwmsEmailPeople(jobId, true);
  const send = useEmailSwms();
  const withPdf = records.filter((r) => r.pdfUrl);
  const [pick, setPick] = React.useState<number | null>(recordId ?? withPdf[0]?.id ?? null);
  const [to, setTo] = React.useState<string[] | null>(null);
  const [adding, setAdding] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [result, setResult] = React.useState<Array<{ to: string; ok: boolean; error: string | null }> | null>(null);

  React.useEffect(() => {
    if (to === null && people.data) setTo(people.data.prefill);
  }, [people.data, to]);

  const list = to ?? [];
  const others = (people.data?.candidates ?? []).filter((c) => !list.includes(c.email));
  const addOne = () => {
    const e = adding.trim().toLowerCase();
    if (!e || list.includes(e)) return setAdding("");
    setTo([...list, e]);
    setAdding("");
  };

  async function go() {
    if (!pick) return;
    const extra = adding.trim().toLowerCase();
    const all = extra && !list.includes(extra) ? [...list, extra] : list;
    const out = await send.mutateAsync({ recordId: pick, to: all, message });
    setResult(out.results);
  }

  if (result) {
    const failed = result.filter((r) => !r.ok);
    return (
      <Modal
        open
        onClose={onClose}
        title={failed.length ? "Not all sent" : "SWMS sent"}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <ul className="grid gap-1 text-sm">
          {result.map((r) => (
            <li key={r.to}>
              {r.ok ? "Sent to" : "Not sent to"} {r.to}
              {r.error ? <span className="text-xs text-destructive"> ({r.error})</span> : null}
            </li>
          ))}
        </ul>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Email SWMS"
      subtitle="Sends the signed PDF from team@. Replies come back to team@."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={send.isPending || !pick || (list.length === 0 && !adding.trim())} onClick={() => void go()}>
            <Mail className="size-3.5" /> {send.isPending ? "Sending" : "Send"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Which SWMS">
          <Select value={pick ?? ""} onChange={(e) => setPick(Number(e.target.value) || null)}>
            {withPdf.map((r) => (
              <option key={r.id} value={r.id}>
                {r.installerName}, {swmsDay(r.workDate)}, {r.kind === "reconfirm" ? "re-confirm" : "full review"}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <div className="grid gap-2">
            {people.isLoading ? <p className="text-xs text-muted-foreground">Loading the job's people…</p> : null}
            {list.length ? (
              <div className="flex flex-wrap gap-1.5">
                {list.map((e) => (
                  <span key={e} className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs">
                    {e}
                    <button type="button" aria-label={`Remove ${e}`} onClick={() => setTo(list.filter((x) => x !== e))}>
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : people.data ? (
              <p className="text-xs text-muted-foreground">No builder contact, supervisor or builder email on this job. Type one in.</p>
            ) : null}
            <div className="flex gap-1.5">
              <Input
                type="email"
                value={adding}
                placeholder="Add an email"
                onChange={(e) => setAdding(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOne();
                  }
                }}
              />
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={addOne} aria-label="Add email">
                <Plus className="size-3.5" />
              </Button>
            </div>
            {others.length ? (
              <div className="flex flex-wrap gap-1.5 text-xs">
                {others.map((c) => (
                  <button
                    key={c.email}
                    type="button"
                    className="rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => setTo([...list, c.email])}
                  >
                    + {c.name ? `${c.name}, ` : ""}
                    {c.why}: {c.email}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </Field>
        <Field label="Note (optional)">
          <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Added to the email above the sign-off." />
        </Field>
        {send.error ? <p className="text-xs text-destructive">{send.error.message}</p> : null}
      </div>
    </Modal>
  );
}
