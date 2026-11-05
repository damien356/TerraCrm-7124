import * as React from "react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Input, Select } from "./ui/field";
import { errorText } from "./public-shell";
import { usePhoneConfig, usePhoneStatus, useSavePhoneConfig, useTestRoute } from "../queries/phoneCalls";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * AI PHONE CALLS AND ROUTING: the settings and the routing test (Retell, 5 Nov).
 *
 * Every destination is picked here: a person, a team, everyone with a role,
 * the duty person, or the queue. Nobody is written into the code. The test
 * runs against what is on screen, saved or not, and writes nothing.
 * ------------------------------------------------------------------------- */

type ConfigData = NonNullable<ReturnType<typeof usePhoneConfig>["data"]>;
type Cfg = ConfigData["config"];
type Dest = NonNullable<NonNullable<Cfg["rules"]["other"]>["dest"]>;
type CallType = ConfigData["callTypes"][number]["key"];
type Person = ConfigData["people"][number];

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CHANNEL_LABEL: Record<string, string> = { in_app: "In app", push: "Phone push", email: "Email" };
const ACTION_LABEL: Record<keyof Cfg["actions"], string> = {
  lookup: "Look up a customer's job",
  enquiry: "Take a new enquiry",
  note: "Add a note to a job",
  update: "Make a permitted update (after reading it back)",
  measureBooking: "Book a measure or site visit",
  installChange: "Install date changes",
  quoteResend: "Resend the current quote",
  callback: "Book a callback",
  transfer: "Live transfer to a person",
};
const PERM_LABEL: Record<keyof Cfg["permissions"], string> = {
  viewCalls: "See calls and follow-ups",
  transcripts: "Open transcripts and recordings",
  routing: "Change these settings",
  reassign: "Reassign other people's work",
};

const encode = (d: Dest | null | undefined) => {
  if (!d) return "";
  if (d.kind === "profile") return `profile:${d.profileId}`;
  if (d.kind === "team") return `team:${d.teamKey}`;
  if (d.kind === "role") return `role:${d.role}`;
  return d.kind;
};
const decode = (v: string): Dest | null => {
  if (!v) return null;
  const [kind, rest] = [v.split(":")[0], v.split(":").slice(1).join(":")];
  if (kind === "profile") return { kind: "profile", profileId: Number(rest) };
  if (kind === "team") return { kind: "team", teamKey: rest };
  if (kind === "role") return { kind: "role", role: rest === "admin" ? "admin" : "office" };
  if (kind === "duty") return { kind: "duty" };
  return { kind: "queue" };
};

function DestSelect({ value, onChange, cfg, people, allowNone, noneLabel = "Nobody" }: { value: Dest | null | undefined; onChange: (d: Dest | null) => void; cfg: Cfg; people: Person[]; allowNone?: boolean; noneLabel?: string }) {
  return (
    <Select className="h-8" value={encode(value)} onChange={(e) => onChange(decode(e.target.value))}>
      {allowNone ? <option value="">{noneLabel}</option> : null}
      <optgroup label="Teams">
        {cfg.teams.map((t) => (
          <option key={t.key} value={`team:${t.key}`}>
            {t.name} team
          </option>
        ))}
      </optgroup>
      <optgroup label="People">
        {people.map((p) => (
          <option key={p.id} value={`profile:${p.id}`}>
            {p.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="Roles">
        <option value="role:office">Everyone in Office</option>
        <option value="role:admin">Everyone in Admin</option>
      </optgroup>
      <optgroup label="Other">
        <option value="duty">The duty person</option>
        <option value="queue">The queue (nobody owns it until claimed)</option>
      </optgroup>
    </Select>
  );
}

function PersonSelect({ value, onChange, people, noneLabel }: { value: number | null; onChange: (id: number | null) => void; people: Person[]; noneLabel: string }) {
  return (
    <Select className="h-8" value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      <option value="">{noneLabel}</option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="grid gap-3 px-4 py-3 text-sm">{children}</div>
    </Card>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);

export function PhoneSettings() {
  const q = usePhoneConfig();
  const status = usePhoneStatus();
  const save = useSavePhoneConfig();
  const [draft, setDraft] = React.useState<Cfg | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [newTeam, setNewTeam] = React.useState("");

  React.useEffect(() => {
    if (q.data && !draft) setDraft(structuredClone(q.data.config));
  }, [q.data, draft]);

  if (q.isLoading || !draft) return <Loading />;
  if (q.error) return <p className="text-sm text-destructive">{errorText(q.error)}</p>;
  const data = q.data!;
  const people = data.people;
  const ro = !data.canEdit;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.config);
  const put = (fn: (c: Cfg) => void) => {
    const next = structuredClone(draft);
    fn(next);
    setDraft(next);
    setMsg(null);
  };
  const ruleOf = (k: CallType) => draft.rules[k] ?? { dest: { kind: "queue" as const }, backupProfileId: null, escalateTo: null, deadlineMins: 120, channels: ["in_app", "push"] as ("in_app" | "push" | "email")[], priority: "normal" as const };
  const putRule = (k: CallType, patch: Partial<ReturnType<typeof ruleOf>>) => put((c) => void (c.rules[k] = { ...ruleOf(k), ...patch }));

  const onSave = () => {
    if (draft.enabled !== data.config.enabled && !window.confirm(draft.enabled ? "Switch the AI phone agent ON? It will start taking actions on real calls." : "Switch the AI phone agent OFF? Every call will be handed to a person.")) return;
    save.mutate(
      { config: draft },
      {
        onSuccess: (r) => {
          setMsg({ ok: true, text: r.changed.length ? "Saved." : "Nothing had changed." });
          setDraft(null);
        },
        onError: (e) => setMsg({ ok: false, text: errorText(e) }),
      },
    );
  };

  const blockers: string[] = [];
  if (status.data?.tablesMissing.length) blockers.push("The phone tables aren't set up yet.");
  if (status.data && !status.data.retellKeySet) blockers.push("The Retell key isn't set, so Retell can't reach Terra Ops.");

  return (
    <div className="grid gap-4">
      {ro ? <p className="rounded-md bg-secondary px-3 py-2 text-sm">You can look, but your role can't change these settings.</p> : null}

      <Section title="Master switch" subtitle="Off means every action is refused and the agent hands the caller to a person.">
        <label htmlFor="ph-enabled" className="flex items-center gap-2">
          <Checkbox id="ph-enabled" checked={draft.enabled} disabled={ro} onChange={(e) => put((c) => void (c.enabled = e.target.checked))} />
          The AI phone agent may take actions in Terra Ops
        </label>
        {blockers.length ? <p className="text-xs text-destructive">Even when this is on, nothing will work yet: {blockers.join(" ")}</p> : null}
        <div className="grid gap-1.5 sm:grid-cols-2">
          {(Object.keys(ACTION_LABEL) as (keyof Cfg["actions"])[]).map((k) => (
            <label htmlFor={`ph-action-${k}`} key={k} className="flex items-center gap-2">
              <Checkbox id={`ph-action-${k}`} checked={draft.actions[k]} disabled={ro} onChange={(e) => put((c) => void (c.actions[k] = e.target.checked))} />
              {ACTION_LABEL[k]}
            </label>
          ))}
        </div>
        <label htmlFor="ph-install-auto" className="flex items-center gap-2">
          <Checkbox id="ph-install-auto" checked={draft.installAutoMove} disabled={ro} onChange={(e) => put((c) => void (c.installAutoMove = e.target.checked))} />
          Let the agent move an install date itself when every readiness rule passes (otherwise every install change becomes a scheduling task)
        </label>
      </Section>

      <Section title="Office hours" subtitle="Brisbane time. Deadlines count office minutes, except urgent work, which counts real minutes.">
        <div className="flex flex-wrap gap-3">
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1.5">
              <Checkbox
                checked={draft.officeHours.days.includes(i)}
                disabled={ro}
                onChange={(e) => put((c) => void (c.officeHours.days = e.target.checked ? [...c.officeHours.days, i].sort() : c.officeHours.days.filter((x) => x !== i)))}
              />
              {d}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input type="time" className="h-8 w-32" value={draft.officeHours.start} disabled={ro} onChange={(e) => put((c) => void (c.officeHours.start = e.target.value))} />
          <span>to</span>
          <Input type="time" className="h-8 w-32" value={draft.officeHours.end} disabled={ro} onChange={(e) => put((c) => void (c.officeHours.end = e.target.value))} />
        </div>
      </Section>

      <Section title="Teams and the queue" subtitle="Tick who is in each team. Work for a team goes to the first available person in it.">
        {people.length < 2 ? <p className="text-xs text-muted-foreground">Only {people.length} office login so far. Add people in Admin, People, and they appear here.</p> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th className="label-xs py-1 pr-3">Team</th>
                {people.map((p) => (
                  <th key={p.id} className="label-xs px-2 py-1 text-center">
                    {p.name}
                  </th>
                ))}
                <th aria-label="Remove team" />
              </tr>
            </thead>
            <tbody>
              {draft.teams.map((t, ti) => (
                <tr key={t.key} className="border-t border-border">
                  <td className="py-1.5 pr-3">
                    <Input className="h-8" value={t.name} disabled={ro} onChange={(e) => put((c) => void (c.teams[ti]!.name = e.target.value))} />
                  </td>
                  {people.map((p) => (
                    <td key={p.id} className="px-2 text-center">
                      <Checkbox
                        checked={t.memberIds.includes(p.id)}
                        disabled={ro}
                        onChange={(e) => put((c) => void (c.teams[ti]!.memberIds = e.target.checked ? [...t.memberIds, p.id] : t.memberIds.filter((x) => x !== p.id)))}
                      />
                    </td>
                  ))}
                  <td className="pl-2 text-right">
                    <Button size="sm" variant="ghost" disabled={ro || draft.defaultQueue === t.key} title={draft.defaultQueue === t.key ? "This is the queue" : ""} onClick={() => put((c) => void (c.teams = c.teams.filter((x) => x.key !== t.key)))}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!ro ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input className="h-8 w-56" placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
            <Button
              size="sm"
              variant="outline"
              disabled={!slug(newTeam) || draft.teams.some((t) => t.key === slug(newTeam))}
              onClick={() => {
                put((c) => void c.teams.push({ key: slug(newTeam), name: newTeam.trim(), memberIds: [] }));
                setNewTeam("");
              }}
            >
              Add team
            </Button>
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="label-xs">The queue (where unowned work waits)</p>
            <Select className="mt-0.5 h-8" value={draft.defaultQueue} disabled={ro} onChange={(e) => put((c) => void (c.defaultQueue = e.target.value))}>
              {draft.teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <p className="label-xs">Duty person (catches anything nobody else can take)</p>
            <div className="mt-0.5">
              <PersonSelect value={draft.dutyProfileId} people={people} noneLabel="Nobody, it waits in the queue" onChange={(id) => put((c) => void (c.dutyProfileId = id))} />
            </div>
          </div>
        </div>
        <label htmlFor="ph-job-manager-first" className="flex items-center gap-2">
          <Checkbox id="ph-job-manager-first" checked={draft.jobManagerFirst} disabled={ro} onChange={(e) => put((c) => void (c.jobManagerFirst = e.target.checked))} />
          Calls about a job go to that job's manager first, when it has one
        </label>
        <label htmlFor="ph-notify-every" className="flex items-center gap-2">
          <Checkbox id="ph-notify-every" checked={draft.notifyEveryCall} disabled={ro} onChange={(e) => put((c) => void (c.notifyEveryCall = e.target.checked))} />
          Tell the owner about every finished call, not only the ones that leave work
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span>Remind the owner</span>
          <Input type="number" min={0} className="h-8 w-20" value={draft.reminderBeforeEscalateMins} disabled={ro} onChange={(e) => put((c) => void (c.reminderBeforeEscalateMins = Number(e.target.value) || 0))} />
          <span>minutes before it escalates</span>
        </div>
      </Section>

      <Section title="Where each kind of call goes" subtitle="If nobody there can take it: the backup, then the duty person, then the queue. Past the deadline it escalates.">
        <div className="grid gap-3">
          {data.callTypes.map(({ key, label }) => {
            const r = ruleOf(key);
            return (
              <div key={key} className="grid gap-2 rounded-md border border-border p-3">
                <p className="font-medium">{label}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div>
                    <p className="label-xs">Goes to</p>
                    <DestSelect value={r.dest} cfg={draft} people={people} onChange={(d) => putRule(key, { dest: d ?? { kind: "queue" } })} />
                  </div>
                  <div>
                    <p className="label-xs">Backup</p>
                    <PersonSelect value={r.backupProfileId} people={people} noneLabel="No backup" onChange={(id) => putRule(key, { backupProfileId: id })} />
                  </div>
                  <div>
                    <p className="label-xs">Escalates to</p>
                    <DestSelect value={r.escalateTo} cfg={draft} people={people} allowNone noneLabel="Doesn't escalate" onChange={(d) => putRule(key, { escalateTo: d })} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label htmlFor={`ph-deadline-${key}`} className="flex items-center gap-1.5">
                    Deadline
                    <Input id={`ph-deadline-${key}`} type="number" min={5} className="h-8 w-20" value={r.deadlineMins} disabled={ro} onChange={(e) => putRule(key, { deadlineMins: Math.max(5, Number(e.target.value) || 5) })} />
                    minutes
                  </label>
                  <label htmlFor={`ph-priority-${key}`} className="flex items-center gap-1.5">
                    Priority
                    <Select id={`ph-priority-${key}`} className="h-8 w-28" value={r.priority} disabled={ro} onChange={(e) => putRule(key, { priority: e.target.value as typeof r.priority })}>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </Select>
                  </label>
                  {data.channels.map((ch) => (
                    <label key={ch} className="flex items-center gap-1.5">
                      <Checkbox checked={r.channels.includes(ch)} disabled={ro} onChange={(e) => putRule(key, { channels: e.target.checked ? [...r.channels, ch] : r.channels.filter((x) => x !== ch) })} />
                      {CHANNEL_LABEL[ch] ?? ch}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Live transfer" subtitle="Who the agent rings while the caller is on the line. This is separate from who owns the follow-up.">
        <div className="grid gap-2 sm:grid-cols-2">
          {data.callTypes.map(({ key, label }) => (
            <div key={key}>
              <p className="label-xs">{label}</p>
              <DestSelect
                value={draft.transfers.byCallType[key] ?? null}
                cfg={draft}
                people={people}
                allowNone
                noneLabel="No transfer, book a callback"
                onChange={(d) =>
                  put((c) => {
                    if (d) c.transfers.byCallType[key] = d;
                    else delete c.transfers.byCallType[key];
                  })
                }
              />
            </div>
          ))}
        </div>
        <label htmlFor="ph-transfer-hours" className="flex items-center gap-2">
          <Checkbox id="ph-transfer-hours" checked={draft.transfers.onlyInHours} disabled={ro} onChange={(e) => put((c) => void (c.transfers.onlyInHours = e.target.checked))} />
          Only transfer during office hours (otherwise book a callback)
        </label>
        <label htmlFor="ph-transfer-callback" className="flex items-center gap-2">
          <Checkbox id="ph-transfer-callback" checked={draft.transfers.noAnswerCallback} disabled={ro} onChange={(e) => put((c) => void (c.transfers.noAnswerCallback = e.target.checked))} />
          If nobody answers the transfer, book a callback follow-up
        </label>
        {people.some((p) => !p.hasPhone) ? (
          <p className="text-xs text-muted-foreground">No phone number on their login, so a transfer can't ring them: {people.filter((p) => !p.hasPhone).map((p) => p.name).join(", ")}.</p>
        ) : null}
      </Section>

      <Section title="Measure and site visits" subtitle="What the agent may book. It checks existing bookings and private calendar busy times, and never says what the busy time is.">
        <div className="grid gap-3 sm:grid-cols-3">
          <label htmlFor="ph-visit-length">
            <span className="label-xs">Visit length (minutes)</span>
            <Input id="ph-visit-length" type="number" className="mt-0.5 h-8" value={draft.visits.durationMins} disabled={ro} onChange={(e) => put((c) => void (c.visits.durationMins = Number(e.target.value) || 60))} />
          </label>
          <label htmlFor="ph-visit-buffer">
            <span className="label-xs">Travel buffer either side (minutes)</span>
            <Input id="ph-visit-buffer" type="number" className="mt-0.5 h-8" value={draft.visits.bufferMins} disabled={ro} onChange={(e) => put((c) => void (c.visits.bufferMins = Number(e.target.value) || 0))} />
          </label>
          <label htmlFor="ph-visit-starts">
            <span className="label-xs">Start times (comma separated)</span>
            <Input id="ph-visit-starts"
              className="mt-0.5 h-8"
              defaultValue={draft.visits.startTimes.join(", ")}
              disabled={ro}
              onBlur={(e) => put((c) => void (c.visits.startTimes = e.target.value.split(",").map((s) => s.trim()).filter((s) => /^\d{2}:\d{2}$/.test(s))))}
            />
          </label>
          <label htmlFor="ph-visit-days">
            <span className="label-xs">How far ahead (days)</span>
            <Input id="ph-visit-days" type="number" className="mt-0.5 h-8" value={draft.visits.daysAhead} disabled={ro} onChange={(e) => put((c) => void (c.visits.daysAhead = Number(e.target.value) || 14))} />
          </label>
          <label htmlFor="ph-visit-notice">
            <span className="label-xs">Minimum notice (hours)</span>
            <Input id="ph-visit-notice" type="number" className="mt-0.5 h-8" value={draft.visits.minNoticeHours} disabled={ro} onChange={(e) => put((c) => void (c.visits.minNoticeHours = Number(e.target.value) || 0))} />
          </label>
          <label>
            <span className="label-xs">Skill on the visit</span>
            <Select className="mt-0.5 h-8" value={draft.visits.skillId ?? ""} disabled={ro} onChange={(e) => put((c) => void (c.visits.skillId = e.target.value ? Number(e.target.value) : null))}>
              <option value="">Measure &amp; quote (by name)</option>
              {data.skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div>
          <p className="label-xs">Who may be booked (none ticked: everyone with the skill)</p>
          <div className="mt-1 flex flex-wrap gap-3">
            {data.installers.map((i) => (
              <label key={i.id} className="flex items-center gap-1.5">
                <Checkbox
                  checked={draft.visits.installerIds.includes(i.id)}
                  disabled={ro}
                  onChange={(e) => put((c) => void (c.visits.installerIds = e.target.checked ? [...c.visits.installerIds, i.id] : c.visits.installerIds.filter((x) => x !== i.id)))}
                />
                {i.name}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Bookable now: {data.visitPeople.map((p) => p.name).join(", ") || "nobody"}.</p>
        </div>
      </Section>

      <Section title="Who may do what" subtitle="Field crew never see any of this.">
        <table className="text-sm">
          <thead>
            <tr className="text-left">
              <th className="label-xs py-1 pr-4" aria-label="Permission" />
              <th className="label-xs px-3 py-1">Admin</th>
              <th className="label-xs px-3 py-1">Office</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(PERM_LABEL) as (keyof Cfg["permissions"])[]).map((k) => (
              <tr key={k} className="border-t border-border">
                <td className="py-1.5 pr-4">{PERM_LABEL[k]}</td>
                {(["admin", "office"] as const).map((role) => (
                  <td key={role} className="px-3 text-center">
                    <Checkbox
                      checked={draft.permissions[k].includes(role)}
                      disabled={ro || (k === "routing" && role === "admin")}
                      onChange={(e) => put((c) => void (c.permissions[k] = e.target.checked ? [...c.permissions[k], role] : c.permissions[k].filter((x) => x !== role)))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {!ro ? (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 py-3">
          <Button disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? "Saving…" : "Save settings"}
          </Button>
          <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => setDraft(structuredClone(data.config))}>
            Undo changes
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes. The routing test uses what's on screen.</span> : null}
          {msg ? <span className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</span> : null}
        </div>
      ) : null}

      <RoutingTest draft={draft} callTypes={data.callTypes} />
    </div>
  );
}

/** Who would get this call right now, step by step. Writes nothing and sends nothing. */
export function RoutingTest({ draft, callTypes }: { draft?: Cfg; callTypes?: ConfigData["callTypes"] }) {
  const cfg = usePhoneConfig();
  const test = useTestRoute();
  const [callType, setCallType] = React.useState<CallType>("enquiry");
  const [jobRef, setJobRef] = React.useState("");
  const [at, setAt] = React.useState("");
  const types = callTypes ?? cfg.data?.callTypes ?? [];
  const run = () =>
    test.mutate({
      callType,
      jobRef: jobRef.trim() || undefined,
      at: at ? new Date(`${at}:00+10:00`).toISOString() : undefined,
      draft,
    });
  const r = test.data;
  return (
    <Card>
      <CardHeader title="Routing test" subtitle="Pick a call and see who would own it, step by step. Nothing is written or sent." />
      <div className="grid gap-3 px-4 py-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-[1fr_140px_200px_auto] sm:items-end">
          <div>
            <p className="label-xs">Kind of call</p>
            <Select className="h-8" value={callType} onChange={(e) => setCallType(e.target.value as CallType)}>
              {types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <p className="label-xs">Job number (optional)</p>
            <Input className="h-8" value={jobRef} onChange={(e) => setJobRef(e.target.value)} placeholder="1042" />
          </div>
          <div>
            <label htmlFor="ph-test-when" className="label-xs block">
              When (Brisbane, blank is now)
            </label>
            <input id="ph-test-when" aria-label="When" type="datetime-local" className="h-8 w-full rounded-md border border-border bg-card px-2 text-sm" value={at} onChange={(e) => setAt(e.target.value)} />
          </div>
          <Button size="sm" disabled={test.isPending} onClick={run}>
            Test
          </Button>
        </div>
        {test.error ? <p className="text-xs text-destructive">{errorText(test.error)}</p> : null}
        {r ? (
          <div className="grid gap-2 rounded-md bg-secondary/60 px-3 py-2">
            <p className="font-medium">{r.owner ? `Owner: ${r.owner}` : `Nobody owns it: it waits in the ${r.queue} queue`}</p>
            <ol className="list-decimal pl-5 text-xs text-muted-foreground">
              {r.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <p className="text-xs">
              Deadline {r.deadline} · {r.priority} priority · told by {r.channels.map((c) => CHANNEL_LABEL[c] ?? c).join(", ")} · escalates to {r.escalatesTo || "nobody"}
              {r.officeOpen ? "" : " · office closed at that time"}
            </p>
            <p className="text-xs">{r.transfer}</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
