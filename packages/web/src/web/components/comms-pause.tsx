import * as React from "react";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/field";
import { useStaffBookable } from "../queries/calendar";

/* ---------------------------------------------------------------------------
 * The pause form shared by quote follow-ups and review requests (31 Oct).
 * A pause always has a reason, the office person looking after it and a
 * review date. It never resumes on its own unless a resume date is approved
 * here (follow-ups only).
 * ------------------------------------------------------------------------- */

export type PauseValue = {
  kind: "pause" | "approval_pending";
  note: string;
  pauseProfileId: number | null;
  pauseName: string;
  reviewDate: string;
  resumeOn: string | null;
};

const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function PauseForm({
  allowResumeDate,
  allowApprovalPending,
  busy,
  onSave,
  onCancel,
}: {
  allowResumeDate: boolean;
  allowApprovalPending: boolean;
  busy: boolean;
  onSave: (v: PauseValue) => void;
  onCancel: () => void;
}) {
  const staff = useStaffBookable();
  const [kind, setKind] = React.useState<PauseValue["kind"]>("pause");
  const [note, setNote] = React.useState("");
  const [who, setWho] = React.useState("");
  const [reviewDate, setReviewDate] = React.useState(plusDays(todayIso(), 7));
  const [resumeOn, setResumeOn] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const people = staff.data ?? [];

  function save() {
    setError(null);
    if (!note.trim()) return setError("Say why it is paused.");
    const p = people.find((x) => String(x.profileId) === who);
    if (!p) return setError("Pick the office person looking after it.");
    if (!reviewDate || reviewDate < todayIso()) return setError("Pick a review date from today on.");
    if (resumeOn && resumeOn <= todayIso()) return setError("A resume date has to be after today.");
    onSave({ kind, note: note.trim(), pauseProfileId: p.profileId, pauseName: p.name, reviewDate, resumeOn: allowResumeDate && resumeOn ? resumeOn : null });
  }

  return (
    <div className="grid gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2" data-testid="pause-form">
      <div className="grid gap-2 sm:grid-cols-2">
        {allowApprovalPending ? (
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value as PauseValue["kind"])}>
              <option value="pause">Paused</option>
              <option value="approval_pending">Approval pending (with the insurer or builder)</option>
            </Select>
          </Field>
        ) : null}
        <Field label="Reason">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Customer is away until March" />
        </Field>
        <Field label="Office person looking after it">
          <Select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Pick one</option>
            {people.map((p) => (
              <option key={p.profileId} value={p.profileId}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Review date" hint="An office task is made for this day.">
          <Input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
        </Field>
        {allowResumeDate ? (
          <Field label="Approved resume date (optional)" hint="Leave empty and it stays paused until someone presses Resume.">
            <Input type="date" value={resumeOn} onChange={(e) => setResumeOn(e.target.value)} />
          </Field>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={save}>
          Save pause
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
