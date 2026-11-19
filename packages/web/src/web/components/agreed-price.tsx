import * as React from "react";
import { BadgeCheck, Handshake, Undo2 } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { moneyExact } from "../lib/money";
import { useBootstrap } from "../queries/settings";
import { useConfirmPriceRevision, usePriceRevision, useRecordPriceRevision, useWithdrawPriceRevision } from "../queries/priceRevisions";

/**
 * THE AGREED PRICE CARD (Damien, 18 Nov 2026, job 188070).
 *
 * An agreed whole-job price in place of the accepted quote plus the
 * variations it covers. The scope is unchanged, so nothing is re-quoted. The
 * card keeps the original figure, the new one, the difference, the reason and
 * the builder's position. While the builder has only called it a budget or
 * allowance, invoices on it cannot be emailed or sent to Xero; Confirm price
 * lifts that. The balance shows the job value, then invoices, credits and
 * payments separately, then what is left to invoice and what is owing.
 * Only an Admin records, confirms or withdraws.
 */

type View = NonNullable<ReturnType<typeof usePriceRevision>["data"]>;
type Draft = NonNullable<View["draft"]>;

const DEFAULT_REASON = "Agreed whole-job price revision, builder's figure, scope unchanged";
const FLAG = "#B7791F";
const OK = "#2F855A";
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const signed = (n: number) => `${n < 0 ? "-" : "+"}${moneyExact(Math.abs(n))}`;
const dayOf = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
const STATUS_WORD: Record<string, string> = { sent: "Issued", part_paid: "Part paid", paid: "Paid", overdue: "Overdue", void: "Void", draft: "Draft" };

function Figure({ label, main, sub, tone }: { label: string; main: string; sub?: string; tone?: string }) {
  return (
    <div>
      <p className="label-xs">{label}</p>
      <p className="tabular mt-0.5 text-sm font-semibold" style={tone ? { color: tone } : undefined}>
        {main}
      </p>
      {sub ? <p className="tabular text-xs text-muted-foreground">{sub}</p> : null}
    </div>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: number; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 text-sm ${strong ? "font-semibold" : ""} ${muted ? "text-muted-foreground" : ""}`}>
      <span>{label}</span>
      <span className="tabular">{moneyExact(value)}</span>
    </div>
  );
}

export function RecordPriceModal({ jobId, draft, onClose }: { jobId: number; draft: Draft; onClose: () => void }) {
  const record = useRecordPriceRevision();
  const [price, setPrice] = React.useState("");
  const [ids, setIds] = React.useState<number[]>(draft.variations.map((v) => v.id));
  const [position, setPosition] = React.useState<"budget_allowance" | "confirmed">("budget_allowance");
  const [reason, setReason] = React.useState(DEFAULT_REASON);
  const [note, setNote] = React.useState("");
  const [wording, setWording] = React.useState(draft.wording);
  const [error, setError] = React.useState<string | null>(null);

  const ex = r2(Number(price) || 0);
  const gst = r2(ex * 0.1);
  const inc = r2(ex + gst);
  const covered = draft.variations.filter((v) => ids.includes(v.id));
  const fromEx = r2(draft.quote.subtotal + covered.reduce((s, v) => s + v.subtotal, 0));
  const fromInc = r2(draft.quote.total + covered.reduce((s, v) => s + v.total, 0));

  const save = () => {
    setError(null);
    if (!(ex > 0)) return setError("Enter the agreed price, ex GST.");
    record.mutate(
      { jobId, toSubtotal: ex, reason, builderPosition: position, builderNote: note.trim() || null, invoiceWording: wording, includedVariationIds: ids },
      { onSuccess: onClose, onError: (e) => setError(errorText(e)) },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-2xl"
      title="Record an agreed price"
      subtitle="One figure for the whole job, in place of the quote and the variations it covers. It replaces the figure, it is not added on top. The quote and everything already sent stay as they are."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={record.isPending}>
            {record.isPending ? <Spinner /> : <Handshake className="size-4" />}
            Record agreed price
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Agreed price, ex GST" hint={ex > 0 ? `GST ${moneyExact(gst)}. ${moneyExact(inc)} inc GST.` : "GST goes on at 10%."}>
          <Input type="number" inputMode="decimal" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <div className="rounded-md border border-border px-3 py-2 text-sm">
          <p className="label-xs mb-1">What it replaces</p>
          <p>
            Quote {draft.quote.ref}, {moneyExact(draft.quote.total)} inc GST
          </p>
          {draft.variations.map((v) => (
            <label key={v.id} className="mt-1 flex items-start gap-2">
              <Checkbox checked={ids.includes(v.id)} onChange={(e) => setIds((xs) => (e.target.checked ? [...xs, v.id] : xs.filter((x) => x !== v.id)))} />
              <span>
                Variation {v.ref}, {moneyExact(v.total)} inc GST
                <span className="block text-xs text-muted-foreground">{v.description}</span>
              </span>
            </label>
          ))}
          <p className="mt-2 text-muted-foreground">
            Was {moneyExact(fromInc)} inc GST ({moneyExact(fromEx)} ex).
            {ex > 0 ? ` Difference ${signed(r2(inc - fromInc))} inc GST (${signed(r2(ex - fromEx))} ex).` : ""}
          </p>
          {draft.variations.length ? (
            <p className="mt-1 text-xs text-muted-foreground">A ticked variation is covered by the agreed price. One left unticked still adds on top.</p>
          ) : null}
        </div>
        <Field label="The builder's position">
          <Select value={position} onChange={(e) => setPosition(e.target.value as typeof position)}>
            <option value="budget_allowance">Budget or allowance, price not confirmed</option>
            <option value="confirmed">Confirmed by the builder</option>
          </Select>
        </Field>
        <Field label="Reason">
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Note (optional, office only)">
          <Textarea rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Field label="Scope words on the invoice" hint="Shown under one fixed price line. No breakdown or extra lines.">
          <Textarea rows={6} value={wording} maxLength={4000} onChange={(e) => setWording(e.target.value)} />
        </Field>
        {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

/** A quiet link for the Client invoices card: only an Admin, only with an accepted quote and no agreed price yet. */
export function RecordAgreedPriceLink({ jobId }: { jobId: number }) {
  const bootstrap = useBootstrap();
  const isAdmin = bootstrap.data?.actor.role === "admin";
  const view = usePriceRevision(jobId);
  const [open, setOpen] = React.useState(false);
  const draft = view.data?.draft;
  if (!isAdmin || !draft || view.data?.active) return null;
  return (
    <>
      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(true)}>
        Record an agreed price
      </button>
      {open ? <RecordPriceModal jobId={jobId} draft={draft} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function AgreedPriceCard({ jobId }: { jobId: number }) {
  const bootstrap = useBootstrap();
  const isAdmin = bootstrap.data?.actor.role === "admin";
  const view = usePriceRevision(jobId);
  const confirm = useConfirmPriceRevision();
  const withdraw = useWithdrawPriceRevision();
  const [confirming, setConfirming] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [why, setWhy] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  if (view.isLoading) return null;
  const d = view.data;
  if (!d || (!d.active && !d.history.length)) return null;
  const a = d.active;
  const b = d.balance;
  const flagged = a?.builderPosition === "budget_allowance";

  return (
    <Card>
      <CardHeader
        title="Agreed price"
        subtitle="An agreed whole-job price in place of the quote and its variations. The scope is unchanged."
        action={
          a ? (
            <Badge colour={flagged ? FLAG : OK}>{flagged ? "Budget or allowance, price not confirmed" : "Price confirmed"}</Badge>
          ) : null
        }
      />
      {!a ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No agreed price is active. The job is priced from its quote and variations.</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 border-b border-border px-4 py-3">
            <Figure label="Original" main={moneyExact(a.fromTotal)} sub={`${moneyExact(a.fromSubtotal)} ex GST`} />
            <Figure label="Agreed price" main={moneyExact(a.toTotal)} sub={`${moneyExact(a.toSubtotal)} ex, ${moneyExact(a.toGst)} GST`} />
            <Figure label="Difference" main={signed(a.diffTotal)} sub={`${signed(a.diffSubtotal)} ex GST`} />
          </div>
          <div className="grid gap-1 border-b border-border px-4 py-3 text-sm">
            <p>
              <span className="text-muted-foreground">Replaces </span>
              {[d.draft?.quote.ref ? `quote ${d.draft.quote.ref}` : "the quote", ...a.coveredRefs.map((r) => `variation ${r}`)].join(" and ")}.
            </p>
            <p>
              <span className="text-muted-foreground">Reason: </span>
              {a.reason}
            </p>
            {a.laterVariations.length ? (
              <p>
                <span className="text-muted-foreground">Added on top, approved later: </span>
                {a.laterVariations.map((v) => `${v.ref} ${moneyExact(v.total)}`).join(", ")}
              </p>
            ) : null}
            {a.builderNote ? <p className="whitespace-pre-line text-muted-foreground">{a.builderNote}</p> : null}
            <p className="text-xs text-muted-foreground">
              Recorded by {a.createdByName || "the office"} on {dayOf(a.createdAt)}.
              {a.confirmedAt ? ` Confirmed by ${a.confirmedByName || "the office"} on ${dayOf(a.confirmedAt)}.` : ""}
              {flagged ? " Invoices on this price cannot be emailed or sent to Xero until it is confirmed." : ""}
            </p>
            <details className="mt-1 text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">Scope words on the invoice</summary>
              <p className="mt-1 whitespace-pre-line">{a.invoiceWording}</p>
            </details>
            {isAdmin ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {flagged ? (
                  <Button size="sm" onClick={() => setConfirming(true)}>
                    <BadgeCheck className="size-3.5" />
                    Confirm price
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => setWithdrawing(true)}>
                  <Undo2 className="size-3.5" />
                  Withdraw
                </Button>
              </div>
            ) : null}
          </div>
        </>
      )}

      <div className="grid gap-1 px-4 py-3">
        <p className="label-xs mb-1">Balance, inc GST</p>
        <Row label={a ? "Revised job value" : "Job value"} value={b.jobValue} strong />
        <Row label="Invoiced" value={b.invoiced} />
        {b.credits ? <Row label="Credits" value={b.credits} /> : null}
        <Row label="Payments received" value={b.received} />
        <div className="my-1 border-t border-border" />
        <Row label="Amount to invoice" value={b.toInvoice} strong />
        <Row label="Amount owing" value={b.owing} strong />
        {b.invoices.length ? (
          <ul className="mt-2 grid gap-0.5 text-xs text-muted-foreground">
            {b.invoices.map((i) => (
              <li key={i.ref} className="flex justify-between gap-3">
                <span>
                  {i.ref}, {STATUS_WORD[i.status] ?? i.status}
                  {i.revised ? ", agreed price" : ""}
                  {i.replaces ? `, replaces ${i.replaces}` : ""}
                </span>
                <span className="tabular">
                  {moneyExact(i.total)}
                  {i.status === "void" ? ", nothing owing" : `, ${moneyExact(i.outstanding)} owing`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {d.history.length ? (
        <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <p className="label-xs mb-1">Earlier agreed prices</p>
          {d.history.map((h) => (
            <p key={h.id}>
              {moneyExact(h.toTotal)} inc GST, {h.reason}. Withdrawn{h.withdrawnByName ? ` by ${h.withdrawnByName}` : ""} {dayOf(h.withdrawnAt)}.
            </p>
          ))}
        </div>
      ) : null}

      {confirming && a ? (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title="Confirm the agreed price"
          subtitle={`Only once the builder has confirmed ${moneyExact(a.toTotal)} inc GST as the price, not a budget or allowance. Invoices on it can then be emailed.`}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                disabled={confirm.isPending}
                onClick={() => {
                  setError(null);
                  confirm.mutate(
                    { id: a.id, note: note.trim() || null },
                    { onSuccess: () => setConfirming(false), onError: (e) => setError(errorText(e)) },
                  );
                }}
              >
                {confirm.isPending ? <Spinner /> : <BadgeCheck className="size-4" />}
                Confirm price
              </Button>
            </>
          }
        >
          <Field label="How it was confirmed (optional)">
            <Textarea rows={2} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {error ? <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </Modal>
      ) : null}

      {withdrawing && a ? (
        <Modal
          open
          onClose={() => setWithdrawing(false)}
          title="Withdraw the agreed price"
          subtitle="The job goes back to the quote and its variations. An invoice on this price has to be voided first."
          footer={
            <>
              <Button variant="outline" onClick={() => setWithdrawing(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={withdraw.isPending || why.trim().length < 3}
                onClick={() => {
                  setError(null);
                  withdraw.mutate({ id: a.id, reason: why }, { onSuccess: () => setWithdrawing(false), onError: (e) => setError(errorText(e)) });
                }}
              >
                {withdraw.isPending ? <Spinner /> : <Undo2 className="size-4" />}
                Withdraw
              </Button>
            </>
          }
        >
          <Field label="Why">
            <Input value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} />
          </Field>
          {error ? <p className="mt-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        </Modal>
      ) : null}
      {view.isFetching && !view.data ? <Loading /> : null}
    </Card>
  );
}
