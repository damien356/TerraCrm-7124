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
 * ------------------------------------------------------------------------- */

export type BookingAsk = { kind: "outside_hours" | "replace_installer"; message: string };

/** The confirm a refused booking is asking for, or null for an ordinary error. */
export function bookingAsk(error: unknown): BookingAsk | null {
  const data = (error as { data?: { reason?: unknown } } | null)?.data;
  const message = error instanceof Error ? error.message : "";
  if (data?.reason === OUTSIDE_HOURS) return { kind: "outside_hours", message };
  if (data?.reason === "replace_installer") return { kind: "replace_installer", message };
  return null;
}

export type BookingFlags = { confirmOutsideHours?: boolean; replaceInstaller?: boolean };

/**
 * Runs a booking, and when the server asks for a confirm, holds it until the
 * office answers. `send` is called again with the answers so far.
 */
export function useBookingAsks(send: (flags: BookingFlags) => Promise<unknown>, onError: (message: string) => void) {
  const [ask, setAsk] = React.useState<BookingAsk | null>(null);
  const flags = React.useRef<BookingFlags>({});
  const [pending, setPending] = React.useState(false);

  const run = React.useCallback(
    async (fresh = true) => {
      if (fresh) flags.current = {};
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
    else flags.current.replaceInstaller = true;
    void run(false);
  }, [ask, run]);

  const dialog = (
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
