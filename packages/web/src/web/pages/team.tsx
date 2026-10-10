import * as React from "react";
import { HardHat, KeyRound, ShieldCheck, Smartphone, Briefcase, UserPlus, TriangleAlert } from "lucide-react";
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
import { useRevokeVoiceKey, useVoiceKeys } from "../queries/visits";

function when(iso: string | null) {
  if (!iso) return "—";
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
            Add person makes the login and texts the password to their mobile. New sign-ups start as Field crew.
            "Switch off" only blocks login. It never deletes anything.
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
          <table className="w-full min-w-[960px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4">Person</th>
                <th className="th px-4">Access level</th>
                <th className="th px-4">Details</th>
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

      <AddPersonModal open={adding} onClose={() => setAdding(false)} />

      <VoiceKeys />
      <PhoneProblems />
      {openId !== null ? <InstallerPanel id={openId} onClose={() => setOpenId(null)} /> : null}
    </Page>
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
 * Add a person with a login. The password is made on the server and texted to
 * their mobile, so nobody in the office sees it.
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

  async function submit() {
    setError(null);
    try {
      await add.mutateAsync({
        name: form.name.trim(),
        email: form.email.trim(),
        mobile: form.mobile.trim(),
        role: form.role,
        installerId: form.role === "field" && form.installerId ? Number(form.installerId) : null,
      });
      setDone(`${form.name.trim()} is added. Their password was texted to ${form.mobile.trim()}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const ready = form.name.trim() && form.email.trim() && form.mobile.trim();

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add person"
      subtitle="Terra makes their login and texts the password to their mobile."
      footer={
        done ? (
          <Button onClick={close}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!ready || add.isPending}>
              {add.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Add and text password
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
            <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Mobile" hint="The password is texted here.">
            <Input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="0412 345 678" />
          </Field>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      )}
    </Modal>
  );
}
