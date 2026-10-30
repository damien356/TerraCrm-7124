import * as React from "react";
import { CalendarCheck, CheckCircle2, Link2Off, LogIn, RefreshCw, TriangleAlert, UserPlus } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input } from "./ui/field";
import { useBootstrap } from "../queries/settings";
import {
  useCalendarConnectUrl,
  useCalendarOverrides,
  useDisconnectCalendar,
  useMakeBookable,
  useMyCalendar,
  useRefreshCalendar,
  useSetBuffers,
  useSetCalendars,
  useStaffBookable,
  useStopCalendar,
} from "../queries/calendar";

/**
 * MY CALENDAR (Schedule, My calendar).
 *
 * Makes an Office or Admin person bookable for measures, site visits and
 * jobs, and links their own Google calendar so bookings check their
 * personal commitments. Ops only ever reads busy times. Event titles,
 * descriptions, places and guests are never read or shown.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const when = (ms: number | Date | string | null | undefined) =>
  ms
    ? new Date(ms).toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

/** "2026-11-10" to "Tue 10 Nov". */
const dayText = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
};
/** "08:30" to "8:30am". */
const hmText = (hm: string) => {
  const [h, mi] = hm.split(":").map(Number);
  return `${((h! + 11) % 12) + 1}:${String(mi).padStart(2, "0")}${h! < 12 ? "am" : "pm"}`;
};

/** The ?cal=connected|error&reason=&address= Google sends the person back with. Read once, then cleared. */
function useReturnNotice() {
  const [notice] = React.useState(() => {
    const p = new URLSearchParams(window.location.search);
    const x = p.get("cal");
    if (!x) return null;
    if (x === "connected") return { ok: true, text: `Connected ${p.get("address") || "your Google calendar"}. Now tick the calendars that count.` };
    return { ok: false, text: p.get("reason") || "Google sign-in didn't finish." };
  });
  React.useEffect(() => {
    if (!notice) return;
    const p = new URLSearchParams(window.location.search);
    for (const k of ["cal", "reason", "address"]) p.delete(k);
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, [notice]);
  return notice;
}

function Notice({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <p
      className={
        ok
          ? "flex items-start gap-2 rounded-md bg-[var(--success)]/10 px-3 py-2 text-sm text-[var(--success)]"
          : "flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
      }
    >
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

export function CalendarCard() {
  const q = useMyCalendar();
  const boot = useBootstrap();
  const isAdmin = boot.data?.actor.role === "admin";
  const notice = useReturnNotice();
  const makeBookable = useMakeBookable();
  const connect = useCalendarConnectUrl();
  const setCalendars = useSetCalendars();
  const setBuffers = useSetBuffers();
  const refresh = useRefreshCalendar();
  const disconnect = useDisconnectCalendar();
  const stop = useStopCalendar();
  const [error, setError] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [ticks, setTicks] = React.useState<string[] | null>(null);
  const [buf, setBuf] = React.useState<{ before: string; after: string } | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (window.location.hash === "#calendar") ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const s = q.data;
  const link = s?.link ?? null;

  React.useEffect(() => {
    if (link && ticks === null) setTicks(link.ticked);
    if (link && buf === null) setBuf({ before: String(link.bufferBeforeMin), after: String(link.bufferAfterMin) });
  }, [link, ticks, buf]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setError("");
    setMsg("");
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function go() {
    await run(async () => {
      const { url } = await connect.mutateAsync({});
      window.location.href = url;
    });
  }

  const ticksDirty = !!link && !!ticks && (ticks.length !== link.ticked.length || ticks.some((t) => !link.ticked.includes(t)));
  const bufDirty = !!link && !!buf && (Number(buf.before) !== link.bufferBeforeMin || Number(buf.after) !== link.bufferAfterMin);
  const bufValid = !!buf && [buf.before, buf.after].every((v) => /^\d{1,3}$/.test(v) && Number(v) <= 180);

  return (
    <div id="calendar" ref={ref} className="scroll-mt-4 space-y-4">
      <Card>
        <CardHeader
          title="My calendar"
          subtitle="Be booked for measures, site visits and jobs, and have bookings check your own Google calendar. Ops reads busy times only, never what the event is."
          action={
            link?.connected ? (
              <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => run(() => refresh.mutateAsync({}), "Calendar read again.")}>
                {refresh.isPending ? <Spinner /> : <RefreshCw />}
                Check now
              </Button>
            ) : null
          }
        />
        {q.isLoading ? (
          <Loading />
        ) : !s ? (
          <p className="px-4 py-4 text-sm text-destructive">{errText(q.error) || "Couldn't load your calendar."}</p>
        ) : (
          <div className="space-y-4 px-4 py-4" data-testid="calendar-card">
            {notice ? <Notice ok={notice.ok}>{notice.text}</Notice> : null}

            {/* Step 1. A card to be booked on. */}
            {!s.installerId ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-3">
                <div className="min-w-[220px] flex-1">
                  <p className="text-sm font-medium">You can't be booked yet</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    This adds you to the board and the booking panel, ticked for Measure & quote and Site visit / inspection. You can tick more skills on your
                    card under Installers.
                  </p>
                </div>
                <Button size="sm" disabled={makeBookable.isPending} onClick={() => run(() => makeBookable.mutateAsync({}), "You can be booked now.")}>
                  <UserPlus /> Make me bookable
                </Button>
              </div>
            ) : (
              <>
                {/* Step 2. Link Google. */}
                <div className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-3">
                  <div className="min-w-[220px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{link?.googleEmail || s.email}</span>
                      {!link ? (
                        <Badge>Not checked</Badge>
                      ) : !link.connected ? (
                        <Badge colour="#B5452E">Not connected</Badge>
                      ) : link.state === "ok" ? (
                        <Badge colour="#3F7D3A">Checked</Badge>
                      ) : link.state === "stale" ? (
                        <Badge colour="#D08A1E">Needs a check</Badge>
                      ) : (
                        <Badge colour="#B5452E">Not checked</Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Booked as {s.cardName}.{" "}
                      {link?.connected
                        ? link.lastSyncOkAt
                          ? `Last read ${when(link.lastSyncOkAt)}.`
                          : "Not read yet."
                        : "Sign in with your own Google account. Only you can do this."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {link?.connected ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={!s.googleReady || connect.isPending} onClick={go}>
                          Reconnect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disconnect.isPending}
                          onClick={() => {
                            if (!window.confirm("Disconnect Google? Until you connect again, bookings with you are blocked unless you approve them yourself.")) return;
                            void run(() => disconnect.mutateAsync({}), "Disconnected. You show as not checked, never as free.");
                          }}
                        >
                          <Link2Off /> Disconnect
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" disabled={!s.googleReady || connect.isPending} onClick={go}>
                        <LogIn /> Connect Google calendar
                      </Button>
                    )}
                  </div>
                </div>

                {!s.googleReady ? (
                  <Notice ok={false}>Google sign-in isn't set up on this copy of Ops yet, so calendars can't be connected.</Notice>
                ) : null}

                {link && link.problem ? (
                  <div
                    className="flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/[0.08] px-3 py-2.5 text-[13px]"
                    data-testid="calendar-unchecked"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                    <div>
                      <p className="font-medium text-foreground">You are not shown as available.</p>
                      <p className="mt-0.5 text-muted-foreground">
                        {link.problem} Until this is fixed, bookings with you are blocked. Only you can book over it, with a reason.
                      </p>
                    </div>
                  </div>
                ) : null}

                {/* Step 3. Which calendars count. */}
                {link?.connected ? (
                  <div className="rounded-md border border-border px-3 py-3">
                    <p className="text-sm font-medium">Calendars that count as busy</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Events marked Free don't block. All-day events in Google are Free unless you set them to Busy.
                    </p>
                    {link.calendars.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">No calendars found. Press Check now.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        {link.calendars.map((c) => (
                          <label key={c.id} className="flex cursor-pointer items-center gap-2 text-sm">
                            <Checkbox
                              checked={(ticks ?? []).includes(c.id)}
                              onChange={(e) =>
                                setTicks((t) => {
                                  const cur = t ?? [];
                                  return e.target.checked ? [...cur, c.id] : cur.filter((x) => x !== c.id);
                                })
                              }
                            />
                            {c.name}
                            {c.primary ? <span className="text-xs text-muted-foreground">(main)</span> : null}
                          </label>
                        ))}
                      </div>
                    )}
                    {ticksDirty ? (
                      <Button
                        size="sm"
                        className="mt-3"
                        disabled={setCalendars.isPending}
                        onClick={() => run(() => setCalendars.mutateAsync({ ids: ticks ?? [] }), "Saved. Busy times read again.")}
                      >
                        {setCalendars.isPending ? <Spinner /> : null}
                        Save calendars
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {/* Step 4. Buffers. */}
                {link && buf ? (
                  <div className="rounded-md border border-border px-3 py-3">
                    <p className="text-sm font-medium">Time kept clear</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Minutes either side of each busy time, for travel and parking.</p>
                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <Field label="Before" className="w-28">
                        <Input inputMode="numeric" value={buf.before} onChange={(e) => setBuf({ ...buf, before: e.target.value.trim() })} />
                      </Field>
                      <Field label="After" className="w-28">
                        <Input inputMode="numeric" value={buf.after} onChange={(e) => setBuf({ ...buf, after: e.target.value.trim() })} />
                      </Field>
                      {bufDirty ? (
                        <Button
                          size="sm"
                          disabled={!bufValid || setBuffers.isPending}
                          onClick={() => run(() => setBuffers.mutateAsync({ beforeMin: Number(buf.before), afterMin: Number(buf.after) }), "Saved.")}
                        >
                          Save
                        </Button>
                      ) : null}
                    </div>
                    {!bufValid ? <p className="mt-1 text-xs text-destructive">Use whole minutes from 0 to 180.</p> : null}
                  </div>
                ) : null}

                {link ? (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={stop.isPending}
                      onClick={() => {
                        if (!window.confirm("Stop checking your calendar? Bookings with you will no longer look at Google at all.")) return;
                        void run(async () => {
                          await stop.mutateAsync({});
                          setTicks(null);
                          setBuf(null);
                        }, "Stopped. Bookings with you no longer check Google.");
                      }}
                    >
                      Stop checking my calendar
                    </Button>
                  </div>
                ) : null}

                {s.installerId ? <MyOverrides installerId={s.installerId} /> : null}
              </>
            )}

            {msg ? <Notice ok>{msg}</Notice> : null}
            {error ? <Notice ok={false}>{error}</Notice> : null}
          </div>
        )}
      </Card>

      {isAdmin ? <StaffBookable /> : null}
    </div>
  );
}

/** Bookings made over my own time, newest first. */
function MyOverrides({ installerId }: { installerId: number }) {
  const q = useCalendarOverrides(installerId);
  const rows = (q.data ?? []).slice(0, 10);
  if (!rows.length) return null;
  return (
    <div className="rounded-md border border-border px-3 py-3">
      <p className="text-sm font-medium">Booked over your time</p>
      <ul className="mt-2 space-y-1.5 text-[13px]">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap gap-x-2 text-muted-foreground">
            <span className="font-medium text-foreground">
              {dayText(r.date)}
              {r.slotStart ? `, ${hmText(r.slotStart)}${r.slotEnd ? ` to ${hmText(r.slotEnd)}` : ""}` : ""}
            </span>
            <span>
              approved by {r.approvedByName || "you"} {when(r.createdAt)}
            </span>
            <span className="w-full text-foreground">"{r.reason}"</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CAL_LABEL: Record<string, { text: string; colour: string | null }> = {
  none: { text: "Calendar not checked", colour: null },
  not_connected: { text: "Google not connected", colour: "#B5452E" },
  no_calendars: { text: "No calendars ticked", colour: "#D08A1E" },
  connected: { text: "Calendar checked", colour: "#3F7D3A" },
};

/** Admin only. Who in the office can be booked. Each person links their own calendar. */
function StaffBookable() {
  const q = useStaffBookable();
  const make = useMakeBookable();
  const [error, setError] = React.useState("");
  return (
    <Card>
      <CardHeader title="Office and admin people" subtitle="Who can be booked for measures, site visits and jobs. Each person connects their own calendar from Schedule, My calendar." />
      {q.isLoading ? (
        <Loading />
      ) : (
        <div className="divide-y divide-border">
          {(q.data ?? []).map((p) => (
            <div key={p.profileId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-[180px] flex-1">
                <p className="text-sm font-medium">{p.name}</p>
                <p className="text-xs capitalize text-muted-foreground">{p.role}</p>
              </div>
              {p.installerId ? (
                <div className="flex items-center gap-2">
                  <Badge colour="#7A6A58">
                    <CalendarCheck className="size-3" /> Bookable
                  </Badge>
                  <Badge colour={CAL_LABEL[p.calendar]?.colour ?? null}>{CAL_LABEL[p.calendar]?.text ?? p.calendar}</Badge>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={make.isPending}
                  onClick={async () => {
                    setError("");
                    try {
                      await make.mutateAsync({ profileId: p.profileId });
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  <UserPlus /> Make bookable
                </Button>
              )}
            </div>
          ))}
          {error ? <p className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Card>
  );
}
