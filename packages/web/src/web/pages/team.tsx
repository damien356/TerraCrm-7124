import * as React from "react";
import { HardHat, KeyRound, ShieldCheck, Smartphone, Briefcase, UserPlus, TriangleAlert, Send } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useAddPerson,
  useLogins,
  usePhoneProblems,
  useSetAccess,
  useSetCostAccess,
  useSetLoginActive,
  useUnlinkedCards,
  useUpdatePerson,
} from "../queries/team";
import { InstallerPanel } from "./installers";
import { AbnChaseList } from "../components/abn-check";
import { useRevokeVoiceKey, useVoiceKeys } from "../queries/visits";
import { EmailInput } from "../components/email-input";
import { useSendInvite, useSetPassword } from "../queries/invites";
import { SetPasswordModal } from "../components/set-password-modal";
import { ReviewerLoginCard } from "../components/reviewer-login-card";

function when(iso: string | null) {
  if (!iso) return "-";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

type Level = "admin" | "office" | "field";

const LEVELS: { value: Level; label: string }[] = [
  { value: "admin", label: "Admin" },
  { value: "office", label: "Office" },
  { value: "field", label: "Field crew" },
];

export default function TeamPage() {
  const people = useLogins();
  const setAccess = useSetAccess();
  const setCosts = useSetCostAccess();
  const setActive = useSetLoginActive();
  const updatePerson = useUpdatePerson();
  const [error, setError] = React.useState<string | null>(null);
  const [openId, setOpenId] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [draft, setDraft] = React.useState({ name: "", phone: "", email: "" });

  React.useEffect(() => {
    const m = /[?&]open=(\d+)/.exec(window.location.search);
    if (m) setOpenId(Number(m[1]));
  }, []);

  const busy = setAccess.isPending || setCosts.isPending || setActive.isPending || updatePerson.isPending;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function changeLevel(row: NonNullable<typeof people.data>[number], level: Level) {
    if (level === row.role) return;
    if (row.role === "field" && level !== "field") {
      const ok = window.confirm(
        `Move ${row.name || row.email} to ${level === "admin" ? "Admin" : "Office"}? Their installer card leaves dispatch. Past jobs, photos, notes and sign-offs stay on those jobs, and switching back to Field crew restores everything.`,
      );
      if (!ok) return;
    }
    if (level === "admin") {
      const ok = window.confirm(`Make ${row.name || row.email} an Admin? Admins can see and change everything, including prices and other logins.`);
      if (!ok) return;
    }
    run(() => setAccess.mutateAsync({ profileId: row.id, role: level }));
  }

  return (
    <Page
      title="People"
      subtitle="One record per person. The access level decides what they are. Set someone to Field crew and their installer card is made for you."
      actions={
        <Button onClick={() => setAdding(true)}>
          <UserPlus className="size-4" />
          Add person
        </Button>
      }
    >
      <Card className="mb-4 p-4 text-sm leading-relaxed text-muted-foreground">
        <p className="mb-2 flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="size-4 text-primary" />
          The three access levels
        </p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <strong className="text-foreground">Admin</strong> sees and changes everything: price book, costs, markups,
            specials, logins, settings, integrations and deleting records. Only an Admin can change anyone's level.
            There is always at least one Admin.
          </li>
          <li>
            <strong className="text-foreground">Office</strong> runs the day: customers, conversations, jobs, schedule,
            dispatch and quotes at price book prices. Costs and margins are hidden unless you switch them on for that
            person. Quote discounts above the limit need an Admin to approve.
          </li>
          <li>
            <strong className="text-foreground">Field crew</strong> uses the installer app only and sees only their own
            dispatched tasks. Enforced on the server.
          </li>
          <li>
            Add person makes the login and sends an invite by text or email. The invite has the app download link and a
            one-time link where they choose their own password, so nobody in the office ever sees it. The link works
            once and runs out after 48 hours. Sending a new invite stops the older one working. There is no public
            sign-up. Only an Admin can make a login or send an invite. "Switch off" only blocks login. It never deletes
            anything.
          </li>
          <li>
            Set password is for when an invite can't get through. You type the password, so tell them it in person.
            The invite is still the better way.
          </li>
        </ul>
      </Card>

      {error ? (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {people.isPending ? (
        <Loading label="Loading people…" />
      ) : !people.data || people.data.length === 0 ? (
        <Empty>No one yet. The first person to create an account becomes the Admin.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4">Person</th>
                <th className="th px-4">Access level</th>
                <th className="th px-4">Details</th>
                <th className="th px-4">Login and invite</th>
                <th className="th px-4">Last signed in</th>
                <th className="th px-4" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {people.data.map((row) => (
                <tr key={row.id} className="border-b border-border/40 align-top last:border-0">
                  <td className="px-4 py-3">
                    {editing === row.id ? (
                      <div className="space-y-1">
                        <input className="w-52 rounded border border-border px-2 py-1 text-sm" placeholder="Name" aria-label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        <input className="w-52 rounded border border-border px-2 py-1 text-sm" placeholder="Mobile" aria-label="Mobile" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
                        <input className="w-52 rounded border border-border px-2 py-1 text-sm" placeholder="Email" aria-label="Email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
                        <div className="flex gap-2 pt-1">
                          <Button
                            disabled={busy || !draft.name.trim()}
                            onClick={() =>
                              run(async () => {
                                await updatePerson.mutateAsync({ profileId: row.id, name: draft.name.trim(), phone: draft.phone.trim() || null, email: draft.email.trim() });
                                setEditing(null);
                              })
                            }
                          >
                            Save
                          </Button>
                          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="font-medium">{row.name || row.email}</div>
                        <div className="text-xs text-muted-foreground">{row.email}</div>
                        <div className="text-xs text-muted-foreground">{row.phone ?? "No mobile"}</div>
                        <button
                          type="button"
                          className="mt-1 text-xs text-primary hover:underline"
                          onClick={() => {
                            setDraft({ name: row.name, phone: row.phone ?? "", email: row.email });
                            setEditing(row.id);
                          }}
                        >
                          Edit name, mobile, email
                        </button>
                        {!row.active ? <Badge className="ml-2 bg-destructive/10 text-destructive">Switched off</Badge> : null}
                      </>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={row.role}
                      disabled={busy}
                      onChange={(e) => changeLevel(row, e.target.value as Level)}
                      className="w-[150px]"
                    >
                      {LEVELS.map((l) => (
                        <option key={l.value} value={l.value}>{l.label}</option>
                      ))}
                    </Select>
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      {row.role === "admin" ? (
                        <><ShieldCheck className="size-3" /> Sees everything</>
                      ) : row.role === "office" ? (
                        <><Briefcase className="size-3" /> Runs the day, no price changes</>
                      ) : (
                        <><HardHat className="size-3" /> Own tasks only</>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.role === "office" ? (
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          aria-label="Can see cost prices and margins"
                          checked={row.canSeeCosts}
                          disabled={busy}
                          onChange={(e) => run(() => setCosts.mutateAsync({ profileId: row.id, canSeeCosts: e.target.checked }))}
                        />
                        Can see cost prices and margins
                      </label>
                    ) : null}
                    {row.role === "field" && row.installerId ? (
                      <div className="space-y-1">
                        <Button variant="ghost" onClick={() => setOpenId(row.installerId)}>
                          Skills, service area and rates
                        </Button>
                      </div>
                    ) : null}
                    {row.role !== "field" && row.installerId ? (
                      <div className="text-xs text-muted-foreground">
                        Installer card archived. History kept, restored if switched back to Field crew.
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <InviteCell row={row} onError={setError} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{when(row.lastSeenAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => run(() => setActive.mutateAsync({ profileId: row.id, active: !row.active }))}
                    >
                      {busy ? <Spinner className="border-foreground/20 border-t-foreground" /> : null}
                      {row.active ? "Switch off" : "Switch on"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <ReviewerLoginCard />

      <AddPersonModal open={adding} onClose={() => setAdding(false)} />

      <AbnChaseList onOpen={setOpenId} />
      <VoiceKeys />
      <PhoneProblems />
      {openId !== null ? <InstallerPanel id={openId} onClose={() => setOpenId(null)} /> : null}
    </Page>
  );
}

type Person = NonNullable<ReturnType<typeof useLogins>["data"]>[number];
type InviteRow = Person["invites"][number];

const INVITE_STATE: Record<InviteRow["state"], { label: string; colour: string | null }> = {
  waiting: { label: "Waiting", colour: "#B45309" },
  set_up: { label: "Set up", colour: "#15803D" },
  expired: { label: "Expired", colour: null },
  replaced: { label: "Replaced", colour: null },
  failed: { label: "Not sent", colour: "#C2410C" },
};

const viaWord = (c: InviteRow["channel"]) => (c === "sms" ? "Texted" : "Emailed");

/** One line of the invite log: how it went, when, and what became of it. */
function inviteLine(i: InviteRow) {
  const sent = `${viaWord(i.channel)} to ${i.sentTo} ${stamp(i.sentAt)}`;
  if (i.state === "failed") return `${i.channel === "sms" ? "Text" : "Email"} to ${i.sentTo} did not go ${stamp(i.sentAt)}${i.detail ? `: ${i.detail}` : ""}`;
  if (i.state === "set_up") return `${sent}. Set up ${stamp(i.usedAt)}`;
  if (i.state === "waiting") return `${sent}. Runs out ${stamp(i.expiresAt)}`;
  if (i.state === "expired") return `${sent}. Ran out ${stamp(i.expiresAt)}`;
  return `${sent}. Replaced by a newer invite`;
}

/**
 * Send or resend the invite, and the log of every invite this person has had
 * (notes 18.55). Shown for everyone, including logins that already have a
 * password: setting up from the link replaces it.
 */
function InviteCell({ row, onError }: { row: Person; onError: (m: string | null) => void }) {
  const send = useSendInvite();
  const setPassword = useSetPassword();
  const [pwOpen, setPwOpen] = React.useState(false);
  const [showLog, setShowLog] = React.useState(false);
  const [sentNote, setSentNote] = React.useState<string | null>(null);
  const latest = row.invites[0] ?? null;
  const again = row.invites.some((i) => i.state !== "failed");

  async function go(channel: "sms" | "email") {
    onError(null);
    setSentNote(null);
    const who = row.name || row.email;
    const to = channel === "sms" ? row.phone : row.email;
    if (!to) {
      onError(channel === "sms" ? `${who} has no mobile. Add one with Edit name, mobile, email.` : `${who} has no email.`);
      return;
    }
    const lines = [`${channel === "sms" ? "Text" : "Email"} an invite to ${who} at ${to}?`];
    if (row.hasPassword) lines.push("They already have a password. Setting up from the new link replaces it.");
    if (latest?.state === "waiting") lines.push("The invite they already have stops working.");
    if (!window.confirm(lines.join("\n\n"))) return;
    try {
      const r = await send.mutateAsync({ profileId: row.id, channel });
      setSentNote(`${channel === "sms" ? "Texted" : "Emailed"} to ${r.to}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={row.hasPassword ? "text-foreground" : "text-muted-foreground"}>
          {row.hasPassword ? "Has a password" : "No password yet"}
        </span>
        {latest ? <Badge colour={INVITE_STATE[latest.state].colour}>{INVITE_STATE[latest.state].label}</Badge> : null}
      </div>
      {latest ? <p className="max-w-[260px] text-muted-foreground">{inviteLine(latest)}</p> : null}
      {row.active ? (
        <div className="flex flex-wrap gap-1">
          <Button variant="ghost" disabled={send.isPending} onClick={() => go("sms")}>
            {send.isPending && send.variables?.channel === "sms" ? <Spinner className="border-foreground/20 border-t-foreground" /> : <Send className="size-3.5" />}
            {again ? "Resend by text" : "Send invite by text"}
          </Button>
          <Button variant="ghost" disabled={send.isPending} onClick={() => go("email")}>
            {send.isPending && send.variables?.channel === "email" ? <Spinner className="border-foreground/20 border-t-foreground" /> : <Send className="size-3.5" />}
            {again ? "Resend by email" : "Send invite by email"}
          </Button>
          <Button variant="ghost" onClick={() => setPwOpen(true)}>
            <KeyRound className="size-3.5" />
            Set password
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">Switched off. Switch on to send an invite.</p>
      )}
      {sentNote ? <p className="text-emerald-700">{sentNote}</p> : null}
      <SetPasswordModal
        open={pwOpen}
        who={`${row.name || row.email} · signs in with ${row.email}`}
        note={row.hasPassword ? "They already have a password. This replaces it." : null}
        onClose={() => setPwOpen(false)}
        onSave={(password) => setPassword.mutateAsync({ profileId: row.id, password })}
      />
      {row.invites.length ? (
        <button type="button" className="text-primary hover:underline" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide invite log" : `Invite log (${row.invites.length})`}
        </button>
      ) : null}
      {showLog ? (
        <ul className="max-w-[300px] space-y-1 border-l border-border pl-2">
          {row.invites.map((i) => (
            <li key={i.id}>
              <span className="font-medium text-foreground">{INVITE_STATE[i.state].label}</span>
              <span className="text-muted-foreground">
                {" "}
                · {inviteLine(i)}
                {i.sentByName ? ` · by ${i.sentByName}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Siri works while the app is closed, so each crew phone holds its own key.
 * Turning one off here cuts that phone off Siri straight away. Switching the
 * login off, or moving it to another installer card, does the same.
 */
function VoiceKeys() {
  const keys = useVoiceKeys();
  const revoke = useRevokeVoiceKey();
  const live = (keys.data ?? []).filter((k) => !k.revokedAt);
  const off = (keys.data ?? []).filter((k) => k.revokedAt).slice(0, 5);

  return (
    <Card className="mt-4">
      <CardHeader
        title="Siri on crew phones"
        subtitle="Each phone that has turned on Hey Siri for Terra. Turn one off if a phone is lost or changes hands."
        action={<Smartphone className="size-4 text-muted-foreground" />}
      />
      {keys.isPending ? (
        <Loading label="Loading phones…" />
      ) : live.length === 0 && off.length === 0 ? (
        <Empty>No phones yet. An installer turns Siri on from the Me tab in the Terra app.</Empty>
      ) : (
        <div className="divide-y divide-border">
          {live.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {k.installerName} <span className="font-normal text-muted-foreground">· {k.deviceName || "iPhone"}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Turned on {when(k.createdAt ? new Date(k.createdAt).toISOString() : null)} · last used{" "}
                  {k.lastUsedAt ? when(new Date(k.lastUsedAt).toISOString()).toLowerCase() : "never"}
                </p>
              </div>
              <Button variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: k.id })}>
                Turn off
              </Button>
            </div>
          ))}
          {off.map((k) => (
            <div key={k.id} className="px-4 py-2 text-xs text-muted-foreground opacity-70">
              {k.installerName} · {k.deviceName || "iPhone"} · turned off {when(new Date(k.revokedAt!).toISOString()).toLowerCase()}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const PROBLEM_LABEL: Record<string, string> = {
  fatal: "App closed",
  error: "Error",
  screen: "Screen broke",
  storage_reset: "Saved login unreadable",
  safe_start: "Safe start",
  emergency_launch: "Update failed to start",
  session_expired: "Login expired",
};

const SERIOUS = new Set(["fatal", "screen", "safe_start", "emergency_launch"]);

function stamp(v: string | Date | null) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/**
 * Crash reports from the Terra app. Each phone keeps what went wrong (even
 * when it closed) and sends it the next time it is open with signal.
 */
function PhoneProblems() {
  const problems = usePhoneProblems();
  const [open, setOpen] = React.useState<number | null>(null);
  const [all, setAll] = React.useState(false);
  const rows = problems.data ?? [];
  const shown = all ? rows : rows.slice(0, 8);

  return (
    <Card className="mt-4">
      <CardHeader
        title="Phone problems"
        subtitle="What the Terra app has sent in: crashes, screens that broke, logins a phone could not read. Newest first."
        action={<TriangleAlert className="size-4 text-muted-foreground" />}
      />
      {problems.isPending ? (
        <Loading label="Loading reports…" />
      ) : problems.isError ? (
        <Empty>Couldn't load the reports. {problems.error.message}</Empty>
      ) : rows.length === 0 ? (
        <Empty>Nothing sent in. Phones report here on their own when something goes wrong.</Empty>
      ) : (
        <div className="divide-y divide-border">
          {shown.map((r) => (
            <div key={r.id} className="px-4 py-2.5">
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
                onClick={() => setOpen(open === r.id ? null : r.id)}
              >
                <Badge colour={SERIOUS.has(r.kind) ? "#C2410C" : null}>{PROBLEM_LABEL[r.kind] ?? r.kind}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{r.message}</span>
                <span className="text-xs text-muted-foreground">
                  {r.who} · {stamp(r.happenedAt ?? r.receivedAt)}
                </span>
              </button>
              {open === r.id ? (
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <p className="break-words text-foreground">{r.message}</p>
                  <p>{r.phone}</p>
                  <p>Received {stamp(r.receivedAt)}</p>
                  {r.stack ? (
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">
                      {r.stack}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {rows.length > shown.length ? (
            <div className="px-4 py-2">
              <Button variant="ghost" onClick={() => setAll(true)}>
                Show {rows.length - shown.length} more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

/**
 * Add a person with a login and send their invite (notes 18.55). No password
 * is made here. They choose their own from the one-time link.
 */
function AddPersonModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const add = useAddPerson();
  const blank = { name: "", email: "", mobile: "", role: "field" as Level, installerId: "" };
  const [form, setForm] = React.useState(blank);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const cards = useUnlinkedCards(open && form.role === "field");

  function close() {
    setForm(blank);
    setError(null);
    setDone(null);
    onClose();
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /* Picking an existing card fills in what it already knows. */
  function pickCard(id: string) {
    const card = (cards.data ?? []).find((c) => String(c.id) === id);
    setForm((f) => ({
      ...f,
      installerId: id,
      name: f.name || card?.name.trim() || "",
      email: f.email || card?.email || "",
      mobile: f.mobile || card?.mobile || "",
    }));
  }

  async function submit(sendBy: "sms" | "email") {
    setError(null);
    try {
      const r = await add.mutateAsync({
        name: form.name.trim(),
        email: form.email.trim(),
        mobile: form.mobile.trim(),
        role: form.role,
        installerId: form.role === "field" && form.installerId ? Number(form.installerId) : null,
        sendBy,
      });
      const who = form.name.trim();
      if (r.invite?.ok) {
        setDone(`${who} is added. Their invite was ${sendBy === "sms" ? "texted" : "emailed"} to ${r.invite.to}. It runs out in 48 hours.`);
      } else {
        setDone(
          `${who} is added, but the invite did not go (${r.invite?.reason ?? "not sent"}). Fix the ${sendBy === "sms" ? "mobile" : "email"} if needed, then use Send invite on their row.`,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const ready = Boolean(form.name.trim() && form.email.trim());

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add person"
      subtitle="Terra makes their login and sends an invite. They choose their own password from the link."
      footer={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="ghost" onClick={() => submit("email")} disabled={!ready || add.isPending}>
              {add.isPending && add.variables?.sendBy === "email" ? <Spinner className="border-foreground/20 border-t-foreground" /> : null}
              Add and send invite by email
            </Button>
            <Button onClick={() => submit("sms")} disabled={!ready || !form.mobile.trim() || add.isPending}>
              {add.isPending && add.variables?.sendBy === "sms" ? <Spinner className="border-white/40 border-t-white" /> : null}
              Add and send invite by SMS
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm">{done}</p>
      ) : (
        <div className="grid gap-3">
          <Field label="Access level">
            <Select value={form.role} onChange={(e) => set("role", e.target.value as Level)}>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          {form.role === "field" && (cards.data ?? []).length > 0 ? (
            <Field label="Installer card" hint="Pick their existing card to keep their jobs and history, or make a new one.">
              <Select value={form.installerId} onChange={(e) => pickCard(e.target.value)}>
                <option value="">Make a new card</option>
                {(cards.data ?? []).map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name.trim()}
                    {c.mobile ? ` · ${c.mobile}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Email" hint="This is what they sign in with.">
            <EmailInput value={form.email} onValueChange={(v) => set("email", v)} />
          </Field>
          <Field label="Mobile" hint="The invite is texted here if you send it by SMS.">
            <Input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="0412 345 678" />
          </Field>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
