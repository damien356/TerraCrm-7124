import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightLeft, Inbox, MapPin, Plus, Search, X } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { orpc } from "../lib/api";
import { useDismissUnfiled, useFileUnfiled, useMoveMessage, useNewEnquiry, useUnfiled } from "../queries/conversations";
import { useBootstrap } from "../queries/settings";

/* ---------------------------------------------------------------------------
 * Putting email on the right job by hand (job email thread, spec 15 Oct):
 * "Move to another job" on any email, and the Unfiled tray with
 * "Which job is this for?", one tap filing and "New enquiry".
 * ------------------------------------------------------------------------- */

type JobHit = { id: number; number: number; displayNumber: string | null; title: string; status?: string | null };

const jobLabel = (j: { number: number; displayNumber: string | null }) => `#${j.displayNumber || j.number}`;

/** Type a job number, a name or an address, pick the job. */
export function JobFinder({ onPick, busy, exclude }: { onPick: (job: JobHit) => void; busy?: boolean; exclude?: number | null }) {
  const [q, setQ] = React.useState("");
  const [settled, setSettled] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setSettled(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery(
    orpc.jobs.list.queryOptions({ input: { search: settled, limit: 8 }, enabled: settled.length >= 2, staleTime: 15_000 }),
  );
  const hits = (found.data ?? []).filter((j) => j.id !== exclude);
  return (
    <div className="grid gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" aria-label="Find a job" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Job number, client or address" />
      </div>
      {settled.length >= 2 ? (
        found.isLoading ? (
          <p className="text-xs text-muted-foreground">Looking…</p>
        ) : hits.length === 0 ? (
          <p className="text-xs text-muted-foreground">No job found.</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {hits.map((j) => (
              <li key={j.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPick({ id: j.id, number: j.number, displayNumber: j.displayNumber, title: j.title, status: j.status?.name })}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-secondary/60 disabled:opacity-60"
                >
                  <span className="font-medium">{jobLabel(j)}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{j.title || "Untitled"}</span>
                  {j.status?.name ? <Badge>{j.status.name}</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/** The button on each email in a thread. */
export function MoveToJobButton({ messageId, currentJobId }: { messageId: number; currentJobId?: number | null }) {
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const move = useMoveMessage();
  return (
    <>
      <Button variant="ghost" size="icon-sm" title="Move to another job" aria-label="Move to another job" onClick={() => setOpen(true)}>
        <ArrowRightLeft className="size-3.5" />
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Move to another job" subtitle="The email and the files that came with it move to that job's thread.">
        <div className="px-5 py-4">
          <JobFinder
            busy={move.isPending}
            exclude={currentJobId}
            onPick={(j) => {
              setError(null);
              move.mutate(
                { messageId, jobId: j.id },
                { onSuccess: () => setOpen(false), onError: (e) => setError(e instanceof Error ? e.message : "It did not move.") },
              );
            }}
          />
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
      </Modal>
    </>
  );
}

const when = (v: string | Date | null) =>
  v ? new Date(v).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";

/** Email Terra could not place. On the Conversations page and the Dashboard. */
export function UnfiledTray({ limit = 50, hideWhenEmpty = false }: { limit?: number; hideWhenEmpty?: boolean }) {
  const role = useBootstrap().data?.actor.role;
  const staff = role === "admin" || role === "office";
  const list = useUnfiled(staff);
  const file = useFileUnfiled();
  const enquiry = useNewEnquiry();
  const dismiss = useDismissUnfiled();
  const [dismissing, setDismissing] = React.useState<number | null>(null);
  const [finding, setFinding] = React.useState<number | null>(null);
  const [reading, setReading] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const rows = list.data ?? [];
  if (!staff || (hideWhenEmpty && rows.length === 0)) return null;
  const busy = file.isPending || enquiry.isPending || dismiss.isPending;
  const onErr = (e: unknown) => setError(e instanceof Error ? e.message : "That did not work.");

  const fileTo = (conversationId: number, job: { id: number; number: number; displayNumber: string | null }) => {
    setError(null);
    file.mutate(
      { conversationId, jobId: job.id },
      {
        onSuccess: () => {
          setFinding(null);
          setDone(`Filed on job ${jobLabel(job)}.`);
        },
        onError: onErr,
      },
    );
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Inbox className="size-4" /> Unfiled{rows.length ? ` (${rows.length})` : ""}
          </span>
        }
        subtitle="Emails and texts Terra could not match to a job. Which job is this for?"
      />
      {list.isLoading ? (
        <Empty>Loading…</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing to file.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {rows.slice(0, limit).map((r) => (
            <li key={r.conversationId} className="px-4 py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{r.name || r.email || "Unknown sender"}</span>
                {r.email && r.name !== r.email ? <span className="text-xs text-muted-foreground">{r.email}</span> : null}
                <span className="ml-auto text-[11px] text-muted-foreground">{when(r.lastMessageAt)}</span>
              </div>
              <p className="mt-0.5 text-sm">{r.subject || "(no subject)"}</p>
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.preview}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {r.jobs.slice(0, 6).map((j) => (
                  <Button
                    key={j.id}
                    size="sm"
                    variant={j.open ? "default" : "outline"}
                    disabled={busy}
                    title={j.byAddress ? "The job's site address is in this email" : undefined}
                    onClick={() => fileTo(r.conversationId, j)}
                  >
                    {j.byAddress ? <MapPin className="size-3.5" /> : null}
                    {jobLabel(j)} {j.title ? <span className="max-w-[160px] truncate font-normal opacity-80">{j.title}</span> : null}
                  </Button>
                ))}
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setFinding(finding === r.conversationId ? null : r.conversationId)}>
                  <Search className="size-3.5" /> Another job
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    enquiry.mutate(
                      { conversationId: r.conversationId },
                      { onSuccess: (out) => setDone(`New enquiry made, job #${out.jobNumber}.`), onError: onErr },
                    );
                  }}
                >
                  {enquiry.isPending ? <Spinner /> : <Plus className="size-3.5" />} New enquiry
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDismissing(dismissing === r.conversationId ? null : r.conversationId)}>
                  <X className="size-3.5" /> Not a job
                </Button>
                <button
                  type="button"
                  className="self-center text-xs text-primary hover:underline"
                  onClick={() => setReading(reading === r.conversationId ? null : r.conversationId)}
                >
                  {reading === r.conversationId ? "Hide it" : "Read it"}
                </button>
              </div>
              {reading === r.conversationId ? (
                <ul className="mt-2 grid gap-2 rounded-md border border-border bg-secondary/30 p-2.5">
                  {[...r.messages].reverse().map((m) => (
                    <li key={m.id}>
                      <p className="text-[11px] text-muted-foreground">
                        {m.authorName || m.fromAddress || "Them"} · {when(m.createdAt)}
                      </p>
                      {m.subject ? <p className="text-xs font-medium">{m.subject}</p> : null}
                      <p className="whitespace-pre-wrap text-xs">{m.body}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              {dismissing === r.conversationId ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-secondary/30 p-2.5">
                  <span className="text-xs">Take it off the tray? It stays on record.</span>
                  {(
                    [
                      [false, "Just this one"],
                      ...(r.email ? ([[true, `Ignore ${r.email} from now on`]] as const) : []),
                    ] as const
                  ).map(([ignoreSender, label]) => (
                    <Button
                      key={label}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        dismiss.mutate(
                          { conversationId: r.conversationId, ignoreSender },
                          {
                            onSuccess: (out) => {
                              setDismissing(null);
                              setDone(out.ignored ? `Taken off. Email from ${out.ignored} will be ignored from now on.` : "Taken off the tray.");
                            },
                            onError: onErr,
                          },
                        );
                      }}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {finding === r.conversationId ? (
                <div className="mt-2">
                  <JobFinder busy={busy} onPick={(j) => fileTo(r.conversationId, j)} />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="px-4 pb-3 text-xs text-destructive">{error}</p> : null}
      {done ? <p className="px-4 pb-3 text-xs text-[#3E6B4F]">{done}</p> : null}
    </Card>
  );
}
