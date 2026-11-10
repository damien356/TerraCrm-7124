import * as React from "react";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { OUTSIDE_HOURS } from "../../api/lib/work-hours";

/* ---------------------------------------------------------------------------
 * The confirms a booking can come back with (Damien's brief, 7 Nov 2026).
 *
 * The server is the one that decides. A booking or a move outside 6:00 am to
 * 6:00 pm Brisbane is refused with reason "outside_hours" and the brief's
 * wording; taking a booked dispatch off one installer for another is refused
 * with reason "replace_installer". The panel shows the matching confirm and
 * sends the same booking again with the answer. Nothing else is bypassed.
 *
 * Assign anyway (11 Nov): a person with a warning (a work category not
 * ticked, a per-person item not switched on, a missing rate) is refused with
 * reason "assign_check" and the exact warnings. "Check assignment" shows them
 * with how the person is paid, and Assign anyway sends the same booking again
 * with those warnings acknowledged and the optional note. The server checks
 * them again and writes the override on the job history.
 * ------------------------------------------------------------------------- */

/** Same words as the server (api/lib/assign-check.ts). */
const ASSIGN_CHECK = "assign_check";

export type AssignWarningView = { kind: string; text: string; detail: string };
export type PayMethodView = { kind: string; label: string; rate: string | null; payToConfirm: boolean };
export type AssignAck = { installerId: number; warnings: string[]; note?: string | null };

export type BookingAsk =
  | { kind: "outside_hours" | "replace_installer"; message: string }
  | {
      kind: "assign_check";
      message: string;
      installerId: number;
      name: string;
      warnings: AssignWarningView[];
      payMethod: PayMethodView | null;
    };

/** The confirm a refused booking is asking for, or null for an ordinary error. */
export function bookingAsk(error: unknown): BookingAsk | null {
  const data = (error as { data?: Record<string, unknown> & { reason?: unknown } } | null)?.data;
  const message = error instanceof Error ? error.message : "";
  if (data?.reason === OUTSIDE_HOURS) return { kind: "outside_hours", message };
  if (data?.reason === ASSIGN_CHECK && Array.isArray(data.warnings) && typeof data.installerId === "number") {
    return {
      kind: "assign_check",
      message,
      installerId: data.installerId,
      name: typeof data.name === "string" ? data.name : "this person",
      warnings: data.warnings as AssignWarningView[],
      payMethod: (data.payMethod as PayMethodView | undefined) ?? null,
    };
  }
  if (data?.reason === "replace_installer") return { kind: "replace_installer", message };
  return null;
}

export type BookingFlags = { confirmOutsideHours?: boolean; replaceInstaller?: boolean; assignAnyway?: AssignAck[] };

/**
 * Runs a booking, and when the server asks for a confirm, holds it until the
 * office answers. `send` is called again with the answers so far.
 */
export function useBookingAsks(send: (flags: BookingFlags) => Promise<unknown>, onError: (message: string) => void) {
  const [ask, setAsk] = React.useState<BookingAsk | null>(null);
  const flags = React.useRef<BookingFlags>({});
  const [pending, setPending] = React.useState(false);
  const [note, setNote] = React.useState("");

  const run = React.useCallback(
    async (fresh = true) => {
      if (fresh) flags.current = {};
      setNote("");
      setPending(true);
      try {
        await send({ ...flags.current });
        setAsk(null);
      } catch (e) {
        const next = bookingAsk(e);
        if (next) setAsk(next);
        else {
          setAsk(null);
          onError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setPending(false);
      }
    },
    [send, onError],
  );

  const confirm = React.useCallback(() => {
    if (!ask) return;
    if (ask.kind === "outside_hours") flags.current.confirmOutsideHours = true;
    else if (ask.kind === "assign_check") {
      // One acknowledgement per person: a second person's warnings come back as their own check.
      const rest = (flags.current.assignAnyway ?? []).filter((a) => a.installerId !== ask.installerId);
      flags.current.assignAnyway = [...rest, { installerId: ask.installerId, warnings: ask.warnings.map((w) => w.text), note: note.trim() || null }];
    } else flags.current.replaceInstaller = true;
    void run(false);
  }, [ask, run, note]);

  const dialog =
    ask?.kind === "assign_check" ? (
      <AssignCheckDialog ask={ask} pending={pending} note={note} onNote={setNote} onCancel={() => setAsk(null)} onConfirm={confirm} />
    ) : (
      <BookingAskDialog ask={ask} pending={pending} onCancel={() => setAsk(null)} onConfirm={confirm} />
    );
  return { run, dialog, pending };
}

export function BookingAskDialog({
  ask,
  pending,
  onCancel,
  onConfirm,
}: {
  ask: BookingAsk | null;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!ask) return null;
  const outside = ask.kind === "outside_hours";
  return (
    <Modal
      open
      onClose={onCancel}
      title={outside ? "Outside standard working hours" : "Change who has this dispatch"}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {outside ? "Change time" : "Keep as it is"}
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {outside ? "Confirm outside-hours booking" : "Confirm the change"}
          </Button>
        </>
      }
    >
      <p className="text-sm">{ask.message}</p>
      {outside ? (
        <p className="mt-2 text-xs text-muted-foreground">Your name and the time you confirmed go on the job record. A clash is still a clash.</p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">The change and who made it go on the job record. The pay stays on one dispatch, never two.</p>
      )}
    </Modal>
  );
}

/** How the person is paid, said plainly, with the rate for those allowed to see it. */
export function PayMethodLine({ pay }: { pay: PayMethodView | null | undefined }) {
  if (!pay) return null;
  return (
    <p className={`text-xs ${pay.payToConfirm ? "font-medium text-amber-700" : "text-muted-foreground"}`}>
      Payment: {pay.label}
      {pay.rate ? `, ${pay.rate}` : ""}
    </p>
  );
}

/** The warnings for one person, the same words the server checks. */
export function AssignWarningList({ warnings, compact }: { warnings: AssignWarningView[]; compact?: boolean }) {
  if (!warnings.length) return null;
  return (
    <ul className="space-y-1.5">
      {warnings.map((w) => (
        <li key={w.text} className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-amber-900">
          <p className={compact ? "text-xs font-medium" : "text-sm font-medium"}>{w.text}</p>
          {compact ? null : <p className="mt-0.5 text-xs text-amber-800">{w.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

function AssignCheckDialog({
  ask,
  pending,
  note,
  onNote,
  onCancel,
  onConfirm,
}: {
  ask: Extract<BookingAsk, { kind: "assign_check" }>;
  pending?: boolean;
  note: string;
  onNote: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Check assignment — ${ask.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Choose someone else
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            Assign anyway
          </Button>
        </>
      }
    >
      <AssignWarningList warnings={ask.warnings} />
      <div className="mt-3 rounded-md border border-border bg-secondary/40 px-2.5 py-2">
        <PayMethodLine pay={ask.payMethod} />
      </div>
      <label className="mt-3 block text-xs font-medium">
        Note (optional)
        <textarea
          value={note}
          onChange={(e) => onNote(e.target.value)}
          maxLength={500}
          rows={2}
          aria-label="Note (optional)"
          placeholder="Why this person is right for it"
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm font-normal"
        />
      </label>
      <p className="mt-2 text-xs text-muted-foreground">
        The warning, your name, the time and the note go on the job history. Their profile, skills and pay terms are not changed.
      </p>
    </Modal>
  );
}
