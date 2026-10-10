import * as React from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { AlertTriangle, FileText } from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/card";
import { Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { depositHint } from "./deposit-default";
import { useCreateQuoteForJob, useQuoteJobStart } from "../queries/quotes";

/**
 * Create quote on the job page (item 6). The quote takes the job's number and
 * its customer, company, supervisor and site. When the job already has a quote
 * it offers the open draft first, then copy the latest or start blank.
 */
export function CreateQuoteButton({ jobId, size, variant = "outline" }: { jobId: number; size?: "sm"; variant?: "outline" | "default" }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <FileText className="size-4" />
        Create quote
      </Button>
      {/* Portalled out of the dark page header, or its colour rules turn the form white on white. */}
      {open ? createPortal(<CreateQuoteModal jobId={jobId} onClose={() => setOpen(false)} />, document.body) : null}
    </>
  );
}

function CreateQuoteModal({ jobId, onClose }: { jobId: number; onClose: () => void }) {
  const [, navigate] = useLocation();
  const start = useQuoteJobStart(jobId, true);
  const create = useCreateQuoteForJob();
  const s = start.data;
  const [from, setFrom] = React.useState<"blank" | "copy" | null>(null);
  const [deposit, setDeposit] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const mode = from ?? (s?.latest ? "copy" : "blank");
  const prefill = mode === "copy" && s?.latest ? s.latest.depositPercent : (s?.cardDeposit.percent ?? 0);
  const typed = deposit.trim() !== "";
  const cardLine = s ? `${s.cardDeposit.percent}% (${depositHint(s.cardDeposit.source) ?? "card default"})` : "";
  const hint = typed
    ? "Typed for this quote only"
    : mode === "copy" && s?.latest
      ? s.latest.depositPercent === s.cardDeposit.percent
        ? `Copied from ${s.latest.ref}. Same as the card: ${cardLine}`
        : `Copied from ${s.latest.ref}. The card says ${cardLine}`
      : depositHint(s?.cardDeposit.source);

  function pick(next: "blank" | "copy") {
    setFrom(next);
    setDeposit("");
  }

  async function submit() {
    setError(null);
    const n = typed ? Number(deposit) : undefined;
    if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 100)) return setError("Deposit has to be between 0 and 100%.");
    try {
      const q = await create.mutateAsync({ jobId, from: mode, depositPercent: n });
      onClose();
      if (q?.id) navigate(`/quotes/${q.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={s ? `Create quote ${s.nextRef}` : "Create quote"}
      subtitle="Uses this job's number. The customer, site and supervisor come off the job."
      width="max-w-lg"
      footer={
        <>
          {error ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {s && !s.blocked ? (
            <Button onClick={submit} disabled={create.isPending}>
              {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Create {s.nextRef}
            </Button>
          ) : null}
        </>
      }
    >
      {start.isLoading ? <Spinner /> : null}
      {start.error ? <p className="text-sm text-destructive">{start.error.message}</p> : null}
      {s?.blocked ? <p className="text-sm text-destructive">{s.blocked}</p> : null}
      {s && !s.blocked ? (
        <div className="grid gap-3">
          {s.draft ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-secondary/60 px-3 py-2 text-sm">
              <span>
                <b>{s.draft.ref}</b> is still a draft. Carry on with that one?
              </span>
              <Button
                size="sm"
                onClick={() => {
                  onClose();
                  navigate(`/quotes/${s.draft?.id}`);
                }}
              >
                Open {s.draft.ref}
              </Button>
            </div>
          ) : null}

          {s.latest ? (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Start from</legend>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="quote_from"
                  className="mt-1"
                  aria-label={`Copy ${s.latest.ref}`}
                  checked={mode === "copy"}
                  onChange={() => pick("copy")}
                />
                <span>
                  <b>Copy {s.latest.ref}.</b> Its lines, bundles and people, as the next version.
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2 text-sm has-[:checked]:border-primary">
                <input
                  type="radio"
                  name="quote_from"
                  className="mt-1"
                  aria-label="Blank"
                  checked={mode === "blank"}
                  onChange={() => pick("blank")}
                />
                <span>
                  <b>Blank.</b> No lines yet.
                </span>
              </label>
            </fieldset>
          ) : null}

          <Field label="Deposit %" hint={hint}>
            <Input
              id="createquote_deposit"
              type="number"
              min={0}
              max={100}
              value={typed ? deposit : String(prefill)}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </Field>

          <p className="text-xs text-muted-foreground">
            {s.billsCompany ? "The job bills the company, so the quote does too." : "The job bills the person, so the quote does too."}
            {s.billsCompany && !s.hasSupervisor ? " No supervisor on the job yet. You can add one on the quote." : ""}
          </p>

          {s.holdMessage ? (
            <div role="note" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{s.holdMessage}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
