import * as React from "react";
import { AlertTriangle, CalendarClock, Check, Search, Send, UserRound, Users } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardHeader, Empty } from "./ui/card";
import { Checkbox, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { Badge } from "./ui/badge";
import { AssignWarningList, PayMethodLine, useBookingAsks } from "./outside-hours";
import { useBoardAssign, useBoardPeople, useInstallerBoard, useRestoreLabour } from "../queries/installer-board";
import { useSendDirect } from "../queries/offers";
import { money } from "../lib/money";
import { sayClock, sayDay } from "../../api/lib/work-hours";

/* ---------------------------------------------------------------------------
 * Installers & bookings (Damien, 11 Nov 2026, job 188070).
 *
 * Near the top of the job. The office works with the labour lines and the
 * people: tick lines, pick a person, Assign selected work. One card per
 * person shows their own lines, day and time, status and (for logins that
 * can see costs) their own pay, with Book, Send offer and Change assignment
 * acting only on that person's work. The dispatch records underneath are
 * split and merged by the server. Assigning sends nothing and needs no date.
 * ------------------------------------------------------------------------- */

const STATE_COLOUR: Record<string, string> = {
  unassigned: "#C0603F",
  assigned: "#4A7FA5",
  offered: "#D08A1E",
  accepted: "#5B8C5A",
  booked: "#3D7A5C",
  started: "#7A5C3D",
  completed: "#6B6B6B",
};

const qtyText = (qty: number, unit: string) => `${Number(qty.toFixed(2))} ${unit === "m2" ? "m²" : unit}`;
const NOBODY = -1;

type Board = NonNullable<ReturnType<typeof useInstallerBoard>["data"]>;
type Visit = Board["cards"][number]["visits"][number];

function whenText(v: Visit) {
  if (!v.days.length) return "No date yet";
  const first = v.days[0]!;
  const time = first.arrivalStart ? `, ${sayClock(first.arrivalStart)}${first.arrivalEnd ? ` to ${sayClock(first.arrivalEnd)}` : ""}` : "";
  const more = v.days.length > 1 ? ` (+${v.days.length - 1} more day${v.days.length > 2 ? "s" : ""})` : "";
  return `${sayDay(first.date)}${time}${more}`;
}

export function InstallersBookingsCard({ jobId, onBook }: { jobId: number; onBook: (taskId: number) => void }) {
  const board = useInstallerBoard(jobId);
  const restore = useRestoreLabour();
  const [picking, setPicking] = React.useState(false);
  const [ticked, setTicked] = React.useState<number[]>([]);
  const [offering, setOffering] = React.useState<{ taskId: number; installerId: number; name: string; title: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const pickerRef = React.useRef<HTMLDivElement>(null);

  const b = board.data;
  const lines = b?.lines ?? [];
  const live = new Set(lines.map((l) => l.lineId));
  const tickedLive = ticked.filter((id) => live.has(id));
  const unassigned = lines.filter((l) => l.state === "unassigned");

  function openWith(ids: number[]) {
    setTicked(ids);
    setPicking(true);
    setError(null);
    requestAnimationFrame(() => pickerRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }
  const toggle = (id: number) => setTicked((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]));

  if (board.isLoading) return null;
  if (!b) return null;
  const outstanding = b.counts.unassigned + b.counts.unbooked;

  return (
    <Card>
      <CardHeader
        title="Installers & bookings"
        subtitle="Who does which work on this job. Tick lines and give them to someone. Saving sends nothing."
        action={
          <div className="flex shrink-0 items-center gap-2">
            {b.counts.lines ? (
              <Badge colour={outstanding ? "#C0603F" : "#3D7A5C"}>
                {outstanding ? `${b.counts.unassigned} unassigned · ${b.counts.unbooked} not booked` : "All labour booked"}
              </Badge>
            ) : null}
            <Button size="sm" onClick={() => (picking ? setPicking(false) : openWith(unassigned.map((l) => l.lineId)))} disabled={!lines.length}>
              {picking ? "Done" : "Assign / book installers"}
            </Button>
          </div>
        }
      />

      {b.missing.length ? (
        <div className="flex flex-wrap items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">On the accepted quote but on no dispatch, so nobody can be given it:</p>
            <p className="mt-0.5">{b.missing.map((m) => `${m.name} ${qtyText(m.missing, m.unit)}`).join(", ")}</p>
            <p className="mt-1 text-xs text-amber-800">Putting it back uses the quote's own quantities. No price, quote or invoice changes, and nobody is messaged.</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={restore.isPending}
            onClick={() => {
              setError(null);
              restore.mutateAsync({ jobId }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {restore.isPending ? "Putting back" : "Put back on the job"}
          </Button>
        </div>
      ) : null}

      {error ? <p className="border-b border-border bg-red-50 px-4 py-2 text-sm text-red-800">{error}</p> : null}

      {!lines.length ? (
        <Empty>No labour on this job yet. Accepting the quote puts it here.</Empty>
      ) : (
        <>
          {/* ------------------------------ the lines ------------------------------ */}
          <div className="border-b border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
              <p className="label-xs">Labour lines</p>
              {picking ? (
                <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => setTicked(unassigned.map((l) => l.lineId))}>
                  Select all unassigned labour
                </button>
              ) : null}
            </div>
            <ul className="divide-y divide-border">
              {lines.map((l) => (
                <li key={l.lineId} className="flex items-center gap-3 px-4 py-2">
                  {picking ? (
                    <Checkbox
                      aria-label={`Tick ${l.name}`}
                      checked={ticked.includes(l.lineId)}
                      onChange={() => toggle(l.lineId)}
                      disabled={l.state === "started" || l.state === "completed"}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{l.name}</span> <span className="tabular text-muted-foreground">{qtyText(l.qty, l.unit)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {l.skill ?? "No work category"} · {l.ref}
                      {l.note ? ` · ${l.note}` : ""}
                    </p>
                  </div>
                  <span className="hidden text-xs sm:inline">{l.installer ? l.installer.name : <span className="text-muted-foreground">Nobody</span>}</span>
                  <Badge colour={STATE_COLOUR[l.state]}>{l.stateLabel}</Badge>
                  {l.state !== "started" && l.state !== "completed" ? (
                    <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => openWith([l.lineId])}>
                      {l.installer ? "Change" : "Assign"}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          {picking ? (
            <div ref={pickerRef}>
              <PeoplePicker jobId={jobId} lineIds={tickedLive} onDone={() => { setTicked([]); setPicking(false); }} />
            </div>
          ) : null}

          {/* ------------------------------ the people ------------------------------ */}
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {b.cards.map((c) => (
              <div key={c.installer.id} className="rounded-lg border border-border bg-background p-3" data-testid="installer-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <UserRound className="size-4 text-muted-foreground" />
                    <p className="text-sm font-semibold">{c.installer.name}</p>
                  </div>
                  {b.canSeePay ? (
                    <p className="tabular text-sm font-medium" title="Their own pay for this job">
                      {c.pay != null ? money(c.pay) : "Pay to confirm"}
                    </p>
                  ) : null}
                </div>
                <div className="mt-2 space-y-3">
                  {c.visits.map((v) => (
                    <div key={v.taskId} className="rounded-md bg-secondary/40 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular text-xs font-semibold text-muted-foreground">{v.ref}</span>
                        <Badge colour={STATE_COLOUR[v.state]}>{v.state === "offered" && v.offeredTo ? `Offered to ${v.offeredTo}` : v.stateLabel}</Badge>
                        {b.canSeePay && v.pay != null && c.visits.length > 1 ? <span className="tabular text-xs text-muted-foreground">{money(v.pay)}</span> : null}
                        {b.canSeePay && v.hourly ? <span className="text-xs text-muted-foreground">Hourly, paid on approved time</span> : null}
                      </div>
                      <ul className="mt-1 text-xs">
                        {v.lines.map((l) => (
                          <li key={l.lineId}>
                            {l.name} <span className="tabular text-muted-foreground">{qtyText(l.qty, l.unit)}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarClock className="size-3" /> {whenText(v)}
                        {v.days.length ? ` · ${v.durationHours}h` : ""}
                      </p>
                      {v.state !== "started" && v.state !== "completed" ? (
                        <div className="mt-2 flex flex-wrap gap-3">
                          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => onBook(v.taskId)}>
                            {v.state === "booked" ? "Change booking" : "Book"}
                          </button>
                          {v.state === "assigned" ? (
                            <button
                              type="button"
                              className="text-xs font-medium text-primary hover:underline"
                              onClick={() => setOffering({ taskId: v.taskId, installerId: c.installer.id, name: c.installer.name, title: v.title })}
                            >
                              Send offer
                            </button>
                          ) : null}
                          <button type="button" className="text-xs font-medium text-primary hover:underline" onClick={() => openWith(v.lines.map((l) => l.lineId))}>
                            Change assignment
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!b.cards.length ? <p className="text-sm text-muted-foreground md:col-span-2">Nobody has work on this job yet.</p> : null}
          </div>
        </>
      )}

      <SendOfferDialog offer={offering} onClose={() => setOffering(null)} />
    </Card>
  );
}

/* --------------------------- who gets the ticked work --------------------------- */

function PeoplePicker({ jobId, lineIds, onDone }: { jobId: number; lineIds: number[]; onDone: () => void }) {
  const people = useBoardPeople(jobId, lineIds);
  const assign = useBoardAssign();
  const [query, setQuery] = React.useState("");
  const [chosen, setChosen] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);

  const tickedKey = lineIds.join(",");
  React.useEffect(() => {
    setError(null);
    setDone(null);
  }, [tickedKey, chosen]);

  const list = (people.data ?? []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const picked = (people.data ?? []).find((p) => p.id === chosen) ?? null;
  const suitable = list.filter((p) => p.suitable);
  const rest = list.filter((p) => !p.suitable);

  const asks = useBookingAsks(
    (flags) =>
      assign
        .mutateAsync({
          jobId,
          lineIds,
          installerId: chosen === NOBODY ? null : chosen,
          assignAnyway: flags.assignAnyway,
          replaceInstaller: flags.replaceInstaller,
        })
        .then(() => {
          setDone(chosen === NOBODY ? "Put back to unassigned." : `Given to ${picked?.name ?? "them"}. Not booked yet, and nobody was messaged.`);
          setChosen(null);
          onDone();
        }),
    setError,
  );

  const row = (p: NonNullable<typeof people.data>[number]) => (
    <li key={p.id}>
      <label className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 ${chosen === p.id ? "bg-primary/10" : "hover:bg-secondary/60"}`}>
        <input type="radio" name="board-person" aria-label={p.name} className="mt-1 accent-[var(--primary)]" checked={chosen === p.id} onChange={() => setChosen(p.id)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {p.name}
            {p.crewCapacity === "own_offsider" ? (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-muted-foreground">
                <Users className="size-3" /> brings an offsider
              </span>
            ) : null}
            {p.suitable ? <Check className="size-3.5 text-emerald-700" aria-label="Suitable" /> : null}
          </span>
          {p.stops.length ? <span className="block text-xs text-red-700">{p.stops.join(" ")}</span> : null}
          {!p.suitable && p.warnings.length ? <span className="block text-xs text-amber-800">Check: {p.warnings.map((w) => w.text).join(" ")}</span> : null}
        </span>
      </label>
    </li>
  );

  return (
    <div className="border-b border-border bg-secondary/30 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {lineIds.length ? `${lineIds.length} line${lineIds.length === 1 ? "" : "s"} ticked. Who does it?` : "Tick the lines above, then pick who does them."}
        </p>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search installers" aria-label="Search installers" className="pl-8" />
        </div>
      </div>

      {lineIds.length ? (
        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background p-1">
            {people.isLoading ? <p className="p-2 text-sm text-muted-foreground">Checking who suits this work.</p> : null}
            {suitable.length ? <p className="label-xs px-2 pt-1">Suited to the ticked work</p> : null}
            <ul>{suitable.map(row)}</ul>
            {rest.length ? <p className="label-xs px-2 pt-2">Everyone else (needs a check)</p> : null}
            <ul>{rest.map(row)}</ul>
            <ul>
              <li>
                <label className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${chosen === NOBODY ? "bg-primary/10" : "hover:bg-secondary/60"}`}>
                  <input type="radio" name="board-person" aria-label="Nobody (back to unassigned)" className="accent-[var(--primary)]" checked={chosen === NOBODY} onChange={() => setChosen(NOBODY)} />
                  Nobody (back to unassigned)
                </label>
              </li>
            </ul>
          </div>
          <div className="space-y-2">
            {picked ? (
              <div className="rounded-md border border-border bg-background px-3 py-2">
                <p className="text-sm font-medium">{picked.name}</p>
                {picked.warnings.length ? (
                  <>
                    <p className="mt-1 text-xs font-medium text-amber-800">Assigning asks you to confirm:</p>
                    <div className="mt-1">
                      <AssignWarningList warnings={picked.warnings} compact />
                    </div>
                  </>
                ) : picked.stops.length ? null : (
                  <p className="mt-1 text-xs text-emerald-800">Ticked for all of this work.</p>
                )}
                <div className="mt-1">
                  <PayMethodLine pay={picked.payMethod} />
                </div>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Saves as a draft for them: no date needed, no offer or message sent. Book or Send offer from their card when ready.
            </p>
            {error ? <p className="text-sm text-red-700">{error}</p> : null}
            {done ? <p className="text-sm text-emerald-800">{done}</p> : null}
            <Button onClick={() => void asks.run()} disabled={chosen == null || asks.pending || Boolean(picked?.stops.length)}>
              {asks.pending ? "Saving" : "Assign selected work"}
            </Button>
          </div>
        </div>
      ) : null}
      {asks.dialog}
    </div>
  );
}

/* ------------------------------ Send offer, confirmed ------------------------------ */

function SendOfferDialog({
  offer,
  onClose,
}: {
  offer: { taskId: number; installerId: number; name: string; title: string } | null;
  onClose: () => void;
}) {
  const send = useSendDirect();
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setError(null), [offer?.taskId]);
  if (!offer) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Send offer to ${offer.name}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={send.isPending}>
            Not now
          </Button>
          <Button
            disabled={send.isPending}
            onClick={() =>
              send
                .mutateAsync({ taskId: offer.taskId, installerId: offer.installerId })
                .then(onClose)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            <Send className="size-3.5" /> {send.isPending ? "Sending" : "Send offer"}
          </Button>
        </>
      }
    >
      <p className="text-sm">
        This sends "{offer.title}" to {offer.name}'s phone now, for their own lines only. Nobody else's work is in it.
      </p>
      {error ? <p className="mt-2 text-sm text-red-700">{error}</p> : null}
    </Modal>
  );
}
