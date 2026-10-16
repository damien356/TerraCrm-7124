import * as React from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { FileText } from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/card";
import { Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { BillToField, readyBillTo, type BillToCard } from "./bill-to";
import { useSetCardDeposit } from "../queries/billTo";
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
  // Who pays (notes 18.54). Starts as the copied version's Bill to, or the job's.
  const [picked, setPicked] = React.useState<BillToCard | null | undefined>(undefined);
  const [cardPercent, setCardPercent] = React.useState("");
  const setCard = useSetCardDeposit();

  const mode = from ?? (s?.latest ? "copy" : "blank");
  const startBill = mode === "copy" && s?.latest?.billTo ? s.latest.billTo : s?.billTo ?? null;
  const startCard: BillToCard | null = startBill
    ? { type: startBill.type, id: startBill.id, name: s?.billTo && s.billTo.type === startBill.type && s.billTo.id === startBill.id ? s.billTo.name : "", percent: s?.billTo && s.billTo.type === startBill.type && s.billTo.id === startBill.id ? s.billTo.percent : null }
    : null;
  const billTo = picked === undefined ? startCard : picked;
  const known = [
    ...(s?.billTo ? [{ type: s.billTo.type, id: s.billTo.id, role: "The job's Bill to" }] : []),
    ...(s?.latest?.billTo ? [{ type: s.latest.billTo.type, id: s.latest.billTo.id, role: `Bill to on ${s.latest.ref}` }] : []),
  ];
  const typed = deposit.trim() !== "";
  const hint = typed
    ? "Typed for this quote only. The card stays."
    : mode === "copy" && s?.latest?.depositSource === "quote"
      ? `${s.latest.ref} had ${s.latest.depositPercent}% typed for it only. Leave blank to use the card %.`
      : "Leave blank to use the Bill to's card %.";

  function pick(next: "blank" | "copy") {
    setFrom(next);
    setDeposit("");
    setPicked(undefined);
  }

  async function submit() {
    setError(null);
    const n = typed ? Number(deposit) : undefined;
    if (n !== undefined && (!Number.isFinite(n) || n < 0 || n > 100)) return setError("Deposit has to be between 0 and 100%.");
    const ready = readyBillTo(billTo, cardPercent, "quote");
    if ("error" in ready || !billTo) return setError("error" in ready ? ready.error : "Pick who pays this quote (Bill to).");
    try {
      if (ready.save != null) await setCard.mutateAsync({ billTo: { type: billTo.type, id: billTo.id }, percent: ready.save });
      const q = await create.mutateAsync({ jobId, from: mode, billTo: { type: billTo.type, id: billTo.id }, depositPercent: n });
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
            <Button onClick={submit} disabled={create.isPending || setCard.isPending}>
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

          <Field label="Bill to (required)" hint="Who pays this quote. It can differ from the job.">
            <BillToField
              id="createquote_billto"
              jobId={jobId}
              value={billTo}
              onChange={setPicked}
              percent={cardPercent}
              onPercent={setCardPercent}
              known={known}
            />
          </Field>

          <Field label="Deposit % for this quote" hint={hint}>
            <Input
              id="createquote_deposit"
              type="number"
              min={0}
              max={100}
              placeholder={billTo?.percent != null ? String(billTo.percent) : "%"}
              value={deposit}
              onChange={(e) => setDeposit(e.target.value)}
            />
          </Field>

          {s.billsCompany && !s.hasSupervisor ? (
            <p className="text-xs text-muted-foreground">No supervisor on the job yet. You can add one on the quote.</p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
