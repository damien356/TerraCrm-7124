import { useState } from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/field";
import { useAccessProposals, useApproveAccessNote, useDismissAccessNote } from "../queries/media";

/**
 * Site access details a client sent in (a lockbox, gate code, where the key
 * is). They wait here until someone in the office checks and approves them.
 * Only then do they join the job's access notes the crew see.
 */
export function AccessNoteProposals({ jobId }: { jobId: number }) {
  const q = useAccessProposals(jobId);
  const approve = useApproveAccessNote();
  const dismiss = useDismissAccessNote();
  const [editing, setEditing] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const pending = q.data?.pending ?? [];
  if (!pending.length) return null;

  return (
    <div className="border-b border-border bg-[var(--gold-wash)]/60 px-4 py-3" data-testid="access-proposals">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRound className="size-4" /> Site access from the client, to check
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">The crew can't see these until you approve them. Edit the words first if you need to.</p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      <ul className="mt-2.5 space-y-2.5">
        {pending.map((p) => {
          const text = editing[p.id] ?? p.text;
          return (
            <li key={p.id} className="rounded-lg border border-border bg-card p-3">
              <p className="text-[11px] text-muted-foreground">
                From {p.fromName || "the client"} by {p.channel === "sms" ? "text" : "email"}, {new Date(p.createdAt).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                {p.fileCount ? `. ${p.fileCount} file${p.fileCount === 1 ? "" : "s"} came with it, marked Needs review below.` : ""}
              </p>
              {p.conflicts ? (
                <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-[#B4232A]/10 px-2 py-1.5 text-xs text-[#8F1D22]">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    This job already has access notes. Check the two agree before you approve.
                    {q.data?.current ? <span className="mt-1 block whitespace-pre-wrap text-foreground">Now: {q.data.current}</span> : null}
                  </span>
                </p>
              ) : null}
              <Textarea
                aria-label="Access note to add"
                className="mt-2 min-h-[64px] text-sm"
                value={text}
                onChange={(e) => setEditing((m) => ({ ...m, [p.id]: e.target.value }))}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  disabled={approve.isPending || !text.trim()}
                  onClick={async () => {
                    setError(null);
                    try {
                      await approve.mutateAsync({ id: p.id, text: text.trim() });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "That didn't save.");
                    }
                  }}
                >
                  Approve, add to access notes
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={dismiss.isPending}
                  onClick={async () => {
                    setError(null);
                    try {
                      await dismiss.mutateAsync({ id: p.id });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "That didn't save.");
                    }
                  }}
                >
                  Don't add
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
