import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Select } from "./ui/field";
import { Modal } from "./ui/modal";

/* ---------------------------------------------------------------------------
 * The recipient approval screen (Damien, 31 Oct). Used for quote follow-ups
 * and the review request. It shows, before anything is approved:
 *   - each person's name, role and the actual email or mobile it goes to
 *   - To, CC and "BCC: none (not used)"
 *   - what it says
 *   - what has already gone
 *   - the next planned send
 * Nobody is filled in for them, and there is no fallback address.
 * ------------------------------------------------------------------------- */

export type RecipientPerson = {
  contactId: number;
  name: string;
  roleLabel: string;
  email: string;
  mobile: string;
  /** Why this person can't get it on this channel, or null when they can. */
  block: { email: string | null; sms: string | null };
};

export type PreviousSend = { at: number | string | Date | null; to: string; what: string };

const when = (d: number | string | Date | null) =>
  d ? new Date(d).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" }) : "";

export function RecipientApprovalModal({
  open,
  onClose,
  what,
  people,
  allowCc,
  channels,
  initial,
  preview,
  previous,
  nextSend,
  notes,
  approveLabel = "Approve",
  busy,
  onApprove,
}: {
  open: boolean;
  onClose: () => void;
  /** "quote follow-ups", "the review request". */
  what: string;
  people: RecipientPerson[];
  allowCc: boolean;
  channels: Array<"email" | "sms">;
  initial: { toContactId: number | null; ccContactIds: number[]; channel: "email" | "sms" };
  preview: { subject: string | null; text: string | null } | null;
  previous: PreviousSend[];
  nextSend: string;
  notes?: string[];
  approveLabel?: string;
  busy: boolean;
  onApprove: (v: { toContactId: number; ccContactIds: number[]; channel: "email" | "sms"; changed: boolean }) => Promise<void>;
}) {
  const [to, setTo] = React.useState<number | null>(initial.toContactId);
  const [cc, setCc] = React.useState<number[]>(initial.ccContactIds);
  const [channel, setChannel] = React.useState<"email" | "sms">(initial.channel);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setTo(initial.toContactId);
    setCc(initial.ccContactIds);
    setChannel(initial.channel);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const addr = (p: RecipientPerson) => (channel === "sms" ? p.mobile : p.email);
  const toP = people.find((p) => p.contactId === to) ?? null;
  const toBlock = toP ? toP.block[channel] : null;
  const ccPeople = people.filter((p) => cc.includes(p.contactId) && p.contactId !== to);
  const changed = to !== initial.toContactId || channel !== initial.channel || [...cc].sort().join() !== [...initial.ccContactIds].sort().join();
  const confirm = toP ? `Send ${what} to ${toP.name} · ${toP.roleLabel} · ${addr(toP) || "(none on file)"}` : null;

  async function go() {
    setError(null);
    if (!toP) return setError("Pick who gets it. Nobody is picked for you.");
    if (toBlock) return setError(`Can't send to ${toP.name}: ${toBlock}`);
    const badCc = ccPeople.find((p) => p.block.email);
    if (badCc) return setError(`Can't copy in ${badCc.name}: ${badCc.block.email}`);
    try {
      await onApprove({ toContactId: toP.contactId, ccContactIds: ccPeople.map((p) => p.contactId), channel, changed });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={`Who gets ${what}`}
      subtitle="Check every person and address. Nothing goes until you approve, and it never sends the moment you approve."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={go} disabled={busy || !toP || !!toBlock} data-testid="recipients-approve">
            {busy ? <Spinner className="border-white/40 border-t-white" /> : <CheckCircle2 className="size-4" />}
            {approveLabel}
          </Button>
        </>
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-3 text-sm" data-testid="recipient-approval">
        {channels.length > 1 ? (
          <Field label="How">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as "email" | "sms")}>
              {channels.map((c) => (
                <option key={c} value={c}>
                  {c === "sms" ? "Text message" : "Email"}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <div>
          <p className="label-xs">To</p>
          <ul className="mt-1 divide-y divide-border rounded-md border border-border">
            {people.map((p) => {
              const b = p.block[channel];
              return (
                <li key={p.contactId} className="flex items-start gap-2 px-3 py-2">
                  <input
                    type="radio"
                    name="to"
                    className="mt-1 size-4 accent-[var(--primary)]"
                    checked={to === p.contactId}
                    disabled={!!b}
                    onChange={() => {
                      setTo(p.contactId);
                      setCc((x) => x.filter((id) => id !== p.contactId));
                    }}
                    aria-label={`To ${p.name}`}
                  />
                  <div className="min-w-0">
                    <p className="font-medium">
                      {p.name} <span className="font-normal text-muted-foreground">· {p.roleLabel}</span>
                    </p>
                    <p className="break-all text-xs text-muted-foreground">{addr(p) || (channel === "sms" ? "No mobile" : "No email")}</p>
                    {b ? <p className="text-xs text-destructive">Can't get it: {b}</p> : null}
                  </div>
                </li>
              );
            })}
            {!people.length ? <li className="px-3 py-2 text-xs text-destructive">Nobody on this job yet. Add people on the job first.</li> : null}
          </ul>
        </div>

        {allowCc && channel === "email" ? (
          <div>
            <p className="label-xs">CC</p>
            <div className="mt-1 grid gap-1">
              {people
                .filter((p) => p.contactId !== to)
                .map((p) => (
                  <label key={p.contactId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={cc.includes(p.contactId)}
                      disabled={!!p.block.email}
                      onChange={(e) => setCc((x) => (e.target.checked ? [...x, p.contactId] : x.filter((id) => id !== p.contactId)))}
                    />
                    {p.name} · {p.roleLabel} · <span className="break-all text-muted-foreground">{p.email || "No email"}</span>
                    {p.block.email ? <span className="text-xs text-destructive">({p.block.email})</span> : null}
                  </label>
                ))}
              {people.filter((p) => p.contactId !== to).length === 0 ? <p className="text-xs text-muted-foreground">Nobody else on the job.</p> : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">CC: {ccPeople.length ? ccPeople.map((p) => `${p.name} (${p.email})`).join(", ") : "none"}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">CC: none ({channel === "sms" ? "a text goes to one person" : "this one goes to one person only"})</p>
        )}
        <p className="text-xs text-muted-foreground">BCC: none (not used)</p>

        {notes?.map((n) => (
          <p key={n} className="rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
            {n}
          </p>
        ))}

        <div>
          <p className="label-xs">Already sent</p>
          {previous.length ? (
            <ul className="mt-1 grid gap-0.5 text-xs text-muted-foreground">
              {previous.map((s, i) => (
                <li key={i}>
                  {when(s.at)}: {s.what} to {s.to}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing yet.</p>
          )}
        </div>

        <div>
          <p className="label-xs">Next planned send</p>
          <p className="text-xs">{nextSend}</p>
        </div>

        {preview?.text ? (
          <details className="text-xs" open>
            <summary className="cursor-pointer text-primary">What it says</summary>
            <div className="mt-1.5 rounded-md border border-border bg-secondary/40 px-3 py-2">
              {preview.subject ? <p className="mb-1.5 font-medium">{preview.subject}</p> : null}
              <p className="whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{preview.text}</p>
            </div>
          </details>
        ) : null}

        {confirm ? (
          <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium" data-testid="confirm-line">
            {confirm}
            {ccPeople.length ? `, CC ${ccPeople.map((p) => `${p.name} · ${p.roleLabel} · ${p.email}`).join("; ")}` : ""}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}
