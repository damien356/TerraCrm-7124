import * as React from "react";
import { Ban, Eraser } from "lucide-react";
import { Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { useCancelJob, useCancelPreview } from "../queries/jobCancel";

/**
 * Cancel a job (Damien, 12 Oct). One confirm screen with two buttons. Each
 * lists exactly what it will do before anything runs: Real cancel for a job
 * that is called off, Clear everything for a test job (Admin, type the number).
 */
export function CancelJobButton({ jobId, label = "Cancel job", show = true }: { jobId: number; label?: string; show?: boolean }) {
  const [open, setOpen] = React.useState(false);
  // `show` hides the button once the quote is cancelled, but the open screen stays up to show what was done.
  return (
    <>
      {show ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Ban className="size-4" />
          {label}
        </Button>
      ) : null}
      {open ? <CancelJobModal jobId={jobId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Done = { mode: "real" | "clear"; jobRef: string; steps: string[]; kept: string[]; toSort: string[]; crewTold: number };

function Lines({ title, lines, tone }: { title: string; lines: string[]; tone?: "warn" }) {
  if (!lines.length) return null;
  return (
    <div className="mt-3">
      <p className="label-xs mb-1">{title}</p>
      <ul className={`list-disc space-y-1 pl-5 text-sm ${tone === "warn" ? "text-[#8A5A12]" : ""}`}>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

function CancelJobModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const preview = useCancelPreview(jobId);
  const run = useCancelJob();
  const [typed, setTyped] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<Done | null>(null);
  const p = preview.data;

  function go(mode: "real" | "clear") {
    setError(null);
    run.mutate(
      { jobId, mode, confirmNumber: mode === "clear" ? typed : null },
      { onSuccess: (out) => setDone(out), onError: (e) => setError(errorText(e)) },
    );
  }

  if (done) {
    return (
      <Modal
        open
        onClose={onClose}
        title={done.mode === "clear" ? `Test job ${done.jobRef} cleared` : `Job ${done.jobRef} cancelled`}
        footer={<Button onClick={onClose}>Close</Button>}
        width="max-w-2xl"
      >
        <Lines title="These steps ran" lines={done.steps} />
        <Lines title="Kept as it is" lines={done.kept} />
        {done.toSort.length ? <Lines title="Office task made, to sort by hand" lines={done.toSort} tone="warn" /> : null}
        {done.crewTold ? <p className="mt-3 text-sm text-muted-foreground">Crew notifications sent: {done.crewTold}.</p> : null}
      </Modal>
    );
  }

  const matches = !!p && typed.trim().replace(/^#/, "").toUpperCase() === p.jobRef.toUpperCase();
  const busy = run.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={p ? `Cancel job ${p.jobRef}` : "Cancel job"}
      subtitle={p?.statusName ? `It is ${p.statusName} now. Nothing changes until you press a button below.` : "Nothing changes until you press a button below."}
      footer={
        <Button variant="outline" onClick={onClose}>
          Keep the job
        </Button>
      }
      width="max-w-2xl"
    >
      {preview.isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Working out what a cancel touches
        </div>
      ) : preview.error || !p ? (
        <p className="text-sm text-destructive">{errorText(preview.error ?? "Could not read the job.")}</p>
      ) : p.noStatus ? (
        <p className="text-sm text-destructive">There is no Cancelled job status. Add one in Settings first.</p>
      ) : p.nothingToDo ? (
        <p className="text-sm text-muted-foreground">This job is already cancelled and has nothing open on it.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <section className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold">Real cancel</h3>
            <p className="text-xs text-muted-foreground">The job is called off. Money that is real stays on record.</p>
            <Lines title="What happens" lines={p.real.steps} />
            <Lines title="Kept as it is" lines={p.real.kept} />
            {p.real.toSort.length ? <Lines title="One office task, to sort by hand" lines={p.real.toSort} tone="warn" /> : null}
            <div className="mt-4 flex justify-end">
              <Button variant="destructive" onClick={() => go("real")} disabled={busy}>
                {busy && run.variables?.mode === "real" ? <Spinner /> : <Ban className="size-4" />}
                Real cancel
              </Button>
            </div>
          </section>

          <section className="rounded-lg border border-border p-4">
            <h3 className="text-sm font-semibold">Test job, clear everything</h3>
            <p className="text-xs text-muted-foreground">For a job made to test with. Everything on it is cleared and it is logged as a test job clear.</p>
            {p.clearBlocked ? (
              <p className="mt-3 rounded-md bg-secondary/60 px-3 py-2 text-sm">{p.clearBlocked}</p>
            ) : (
              <>
                <Lines title="What happens" lines={p.clear.steps} />
                <Field label={`Type the job number ${p.jobRef} to confirm`} className="mt-4">
                  <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={p.jobRef} autoComplete="off" />
                </Field>
                <div className="mt-4 flex justify-end">
                  <Button variant="destructive" onClick={() => go("clear")} disabled={busy || !p.clearAllowed || !matches}>
                    {busy && run.variables?.mode === "clear" ? <Spinner /> : <Eraser className="size-4" />}
                    Clear everything
                  </Button>
                </div>
              </>
            )}
          </section>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
