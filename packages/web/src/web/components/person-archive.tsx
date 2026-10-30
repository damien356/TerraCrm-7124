import * as React from "react";
import { createPortal } from "react-dom";
import { Link } from "wouter";
import { Archive, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Loading, Spinner } from "./ui/card";
import { Modal } from "./ui/modal";
import { useBootstrap } from "../queries/settings";
import { useArchivePerson, useDeletePerson, usePersonCheck, type PersonRef } from "../queries/team";

/**
 * Archive and Delete for one person (Damien, 30 Oct). Only the main admin sees
 * these, and never on the main admin's own row. The server checks all of it
 * again: who may do it, and that Delete is only for someone with no past work.
 */

export function useIsMainAdmin() {
  const bootstrap = useBootstrap();
  return Boolean(bootstrap.data?.actor.isMainAdmin);
}

type Upcoming = { taskId: number; jobId: number; title: string; date: string | null; jobNumber: string | null };

function sayDay(date: string | null) {
  if (!date) return "No date yet";
  const d = new Date(`${date}T00:00:00`);
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function UpcomingList({ rows }: { rows: Upcoming[] }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-background p-2 text-sm">
      {rows.map((r) => (
        <li key={r.taskId} className="flex flex-wrap items-baseline gap-x-2">
          <span className="w-24 shrink-0 text-muted-foreground">{sayDay(r.date)}</span>
          <Link to={`/jobs/${r.jobId}`} className="font-medium text-primary hover:underline">
            {r.jobNumber ? `Job ${r.jobNumber}` : `Job ${r.jobId}`}
          </Link>
          <span className="text-muted-foreground">{r.title}</span>
        </li>
      ))}
    </ul>
  );
}

type Open = {
  mode: "archive" | "delete";
  person: PersonRef;
  name: string;
  onDone?: (what: "archived" | "deleted") => void;
};

/*
 * The open modal lives here, not inside the row that opened it. Archiving
 * takes the person off the People list straight away, and the result (with
 * their bookings still ahead) has to stay on screen after their row is gone.
 */
let current: Open | null = null;
const listeners = new Set<() => void>();
function setOpen(next: Open | null) {
  current = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Mounted once in the layout. Draws on top of everything, including the installer card. */
export function PersonActionHost() {
  const open = React.useSyncExternalStore(subscribe, () => current);
  if (!open) return null;
  return createPortal(
    <PersonActionModal
      key={`${open.mode}-${JSON.stringify(open.person)}`}
      mode={open.mode}
      person={open.person}
      name={open.name}
      onArchiveInstead={() => setOpen({ ...open, mode: "archive" })}
      onClose={(what) => {
        setOpen(null);
        if (what) open.onDone?.(what);
      }}
    />,
    document.body,
  );
}

export function PersonActions({
  person,
  name,
  isMainAdminRow,
  onDone,
  compact,
}: {
  person: PersonRef;
  name: string;
  isMainAdminRow?: boolean;
  /** After a delete, the panel showing this person should close. */
  onDone?: (what: "archived" | "deleted") => void;
  compact?: boolean;
}) {
  const mainAdmin = useIsMainAdmin();
  if (!mainAdmin || isMainAdminRow) return null;
  const open = (mode: "archive" | "delete") => setOpen({ mode, person, name, onDone });
  return (
    <div className={compact ? "flex flex-wrap justify-end gap-1" : "flex flex-wrap gap-2"}>
      <Button variant="ghost" size={compact ? "sm" : "default"} onClick={() => open("archive")}>
        <Archive className="size-3.5" />
        Archive
      </Button>
      <Button variant="ghost" size={compact ? "sm" : "default"} className="text-destructive hover:text-destructive" onClick={() => open("delete")}>
        <Trash2 className="size-3.5" />
        Delete
      </Button>
    </div>
  );
}

function PersonActionModal({
  mode,
  person,
  name,
  onArchiveInstead,
  onClose,
}: {
  mode: "archive" | "delete";
  person: PersonRef;
  name: string;
  onArchiveInstead: () => void;
  onClose: (what?: "archived" | "deleted") => void;
}) {
  const check = usePersonCheck(person);
  const archive = useArchivePerson();
  const remove = useDeletePerson();
  const [error, setError] = React.useState<string | null>(null);
  const [archived, setArchived] = React.useState<{ upcoming: Upcoming[]; offersPulled: number } | null>(null);
  const [deleted, setDeleted] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const busy = archive.isPending || remove.isPending;
  const c = check.data;

  // This can sit on top of the installer card. Escape closes only this one, not both.
  const dismiss = () => onClose(deleted ? "deleted" : archived ? "archived" : undefined);
  const closeRef = React.useRef(dismiss);
  closeRef.current = dismiss;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  async function go() {
    setError(null);
    try {
      if (mode === "archive") {
        const r = await archive.mutateAsync(person);
        setArchived({ upcoming: r.upcoming, offersPulled: r.offersPulled });
      } else {
        await remove.mutateAsync(person);
        setDeleted(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const finished = archived !== null || deleted;
  const title = finished ? (deleted ? `${name} deleted` : `${name} archived`) : mode === "archive" ? `Archive ${name}?` : `Delete ${name}?`;

  let body: React.ReactNode;
  if (deleted) {
    body = <p className="text-sm">{name} is gone from Ops. They had no history in Ops, so nothing else changed.</p>;
  } else if (archived) {
    body = (
      <div className="space-y-2 text-sm">
        <p>
          {name} can't sign in any more and won't show up for new bookings or offers. Their details and history are kept.
          {archived.offersPulled ? ` ${archived.offersPulled} open offer${archived.offersPulled === 1 ? " was" : "s were"} pulled back.` : ""}
        </p>
        {archived.upcoming.length ? (
          <div>
            <p className="font-medium">
              They are still on {archived.upcoming.length} booking{archived.upcoming.length === 1 ? "" : "s"} ahead. Move these to someone else:
            </p>
            <UpcomingList rows={archived.upcoming} />
          </div>
        ) : (
          <p className="text-muted-foreground">They have no bookings ahead.</p>
        )}
        <p className="text-muted-foreground">To bring them back, open Admin, then Archived people, then press Restore.</p>
      </div>
    );
  } else if (check.isPending) {
    body = <Loading label="Checking their history…" />;
  } else if (check.isError || !c) {
    body = <p className="text-sm text-destructive">{check.error?.message ?? "Could not check this person."}</p>;
  } else if (c.isMainAdmin) {
    body = <p className="text-sm">This is the main admin's card. The main admin can't be archived or deleted.</p>;
  } else if (mode === "archive") {
    body = (
      <div className="space-y-2 text-sm">
        <ul className="list-inside list-disc space-y-1">
          {c.hasLogin ? <li>Their login stops working straight away. The crew app signs them out.</li> : null}
          <li>They come off every booking list and any open offers to them are pulled back.</li>
          <li>Their details stay: ABN, rates, skills, and their name on past jobs, pay and safety records.</li>
          <li>The main admin, or someone ticked "Can restore people", can bring them back.</li>
        </ul>
        {c.upcoming.length ? (
          <div>
            <p className="font-medium">
              They are on {c.upcoming.length} booking{c.upcoming.length === 1 ? "" : "s"} ahead. These stay as they are, so move them to someone else after:
            </p>
            <UpcomingList rows={c.upcoming} />
          </div>
        ) : null}
      </div>
    );
  } else if (!c.canDelete) {
    body = (
      <div className="space-y-2 text-sm">
        <p>
          {name} can't be deleted. They have history in Ops: {c.historyText}.
        </p>
        <p>Archive them instead. That turns off their login and keeps the record of who did the work.</p>
      </div>
    );
  } else {
    body = (
      <div className="space-y-2 text-sm">
        <p>{name} has no history in Ops, so they can be deleted for good.</p>
        <p>This removes their {c.hasLogin ? "login, " : ""}card, skills and rates. It can't be undone.</p>
        <label className="block">
          <span className="text-muted-foreground">Type DELETE to confirm</span>
          <input
            className="mt-1 w-40 rounded border border-border px-2 py-1 text-sm"
            aria-label="Type DELETE to confirm"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </div>
    );
  }

  const canGo = !finished && c && !c.isMainAdmin && (mode === "archive" || (c.canDelete && typed.trim().toUpperCase() === "DELETE"));

  return (
    <Modal
      open
      onClose={dismiss}
      title={title}
      footer={
        finished ? (
          <Button onClick={() => onClose(deleted ? "deleted" : "archived")}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onClose()}>
              Cancel
            </Button>
            {mode === "delete" && c && !c.canDelete && !c.isMainAdmin ? (
              <Button onClick={onArchiveInstead}>
                <Archive className="size-4" />
                Archive instead
              </Button>
            ) : (
              <Button variant={mode === "delete" ? "destructive" : "default"} disabled={!canGo || busy} onClick={go}>
                {busy ? <Spinner className="border-white/40 border-t-white" /> : null}
                {mode === "archive" ? "Archive" : "Delete for good"}
              </Button>
            )}
          </>
        )
      }
    >
      {body}
      {error ? <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}
