import * as React from "react";
import { Merge } from "lucide-react";
import { useLocation } from "wouter";
import { Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { JobFinder, type JobHit } from "./mail-filing";
import { useMergeJobs, useMergePreview } from "../queries/jobMerge";

/**
 * Merge into another job (notes 18.48). Admin only. Pick the job to keep,
 * read exactly what moves, then confirm. This job is marked merged and a
 * search for its number opens the kept job.
 */
export function MergeJobButton({ jobId }: { jobId: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Merge className="size-4" />
        Merge into another job
      </Button>
      {open ? <MergeJobModal jobId={jobId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Lines({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="mt-3">
      <p className="label-xs mb-1">{title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function MergeJobModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [, navigate] = useLocation();
  const [target, setTarget] = React.useState<JobHit | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const preview = useMergePreview(jobId, target?.id ?? null);
  const run = useMergeJobs();
  const p = preview.data;

  function go() {
    if (!target) return;
    setError(null);
    run.mutate(
      { fromJobId: jobId, intoJobId: target.id },
      {
        onSuccess: (out) => {
          onClose();
          navigate(`/jobs/${out.intoJobId}`);
        },
        onError: (e) => setError(errorText(e)),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={p ? `Merge ${p.from.ref} into ${p.into.ref}` : "Merge into another job"}
      subtitle="The job you pick is kept. Everything on this job moves onto it. Nothing changes until you press Merge."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {target ? (
            <Button variant="destructive" onClick={go} disabled={run.isPending || !p || !!p.block}>
              {run.isPending ? <Spinner /> : <Merge className="size-4" />}
              Merge
            </Button>
          ) : null}
        </>
      }
      width="max-w-2xl"
    >
      {!target ? (
        <div className="grid gap-2">
          <p className="text-sm">Which job should this one go into?</p>
          <JobFinder exclude={jobId} onPick={setTarget} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2 rounded-md bg-secondary/60 px-3 py-2 text-sm">
            <span>
              Keep <span className="font-medium">#{target.displayNumber ?? target.number}</span>
              {target.title ? `, ${target.title}` : ""}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setTarget(null)} disabled={run.isPending}>
              Pick another
            </Button>
          </div>
          {preview.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Working out what moves
            </div>
          ) : preview.error || !p ? (
            <p className="text-sm text-destructive">{errorText(preview.error ?? "Could not read the jobs.")}</p>
          ) : p.block ? (
            <p className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">{p.block}</p>
          ) : (
            <>
              <Lines title="What happens" lines={p.moves} />
              <Lines title="Kept as it is" lines={p.kept} />
            </>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
