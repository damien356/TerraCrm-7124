import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, Mail, Play, RotateCcw, Send } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { errorText } from "../components/public-shell";
import { useBootstrap } from "../queries/settings";
import {
  useCareMember,
  useCarePreview,
  useCareReport,
  useCareResetTemplate,
  useCareRetryJob,
  useCareRunNow,
  useCareSaveTemplate,
  useCareSendTest,
  useCareSetMemberStatus,
  useCareSetOn,
  useCareSetWoolRanges,
  useCareTemplates,
  useCareWoolAnswer,
} from "../queries/care";

/**
 * Marketing, Care (section 18.37). The after job care series: plain emails
 * from Damien to the homeowner after a job is Completed, on a timetable per
 * floor type, with the holiday emails on top.
 *
 * Who is in, which email each person is up to, opens and unsubscribes, the
 * jobs waiting on the wool question, and the copy of every email.
 */

const STATUS_COLOUR: Record<string, string> = {
  active: "#3F7D3A",
  stopped: "#7A736D",
  unsubscribed: "#C0603F",
};
const STATUS_LABEL: Record<string, string> = { active: "Active", stopped: "Taken out", unsubscribed: "Unsubscribed" };
const KIND_LABEL: Record<string, string> = { series: "Series", fixed: "Floor email", holiday: "Holiday", bank: "Extra" };

const day = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "Australia/Brisbane" }) : "";
const when = (ms: number | null | undefined) =>
  ms
    ? new Date(ms).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" })
    : "";
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "none yet");

function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[] }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-border">
      {items.map((i) => (
        <button
          key={i.value}
          type="button"
          onClick={() => onChange(i.value)}
          className={
            value === i.value
              ? "-mb-px border-b-2 border-[var(--gold)] px-3 py-2 text-sm font-medium"
              : "px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
          }
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export default function CarePage() {
  const report = useCareReport();
  const isAdmin = useBootstrap().data?.actor.role === "admin";
  const [tab, setTab] = React.useState<"people" | "emails" | "settings">("people");

  if (report.isLoading) return <Loading label="Loading the care series…" />;
  if (report.error || !report.data) {
    return (
      <Page title="Care emails">
        <Card>
          <Empty>Could not load the care series. {report.error ? errorText(report.error) : ""}</Empty>
        </Card>
      </Page>
    );
  }
  const r = report.data;

  return (
    <Page
      title="Care emails"
      subtitle="Plain emails from Damien to the homeowner after a job is Completed. One timetable per floor, plus the holiday emails."
      actions={<EngineSwitch settings={r.settings} isAdmin={isAdmin} />}
    >
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="In the series" value={r.totals.active} hint={`${r.totals.members} added so far`} />
        <Stat label="Emails sent" value={r.totals.sent} hint={`${r.totals.sent30} in the last 30 days`} />
        <Stat label="Opened" value={pct(r.totals.opened, r.totals.sent)} hint={`${r.totals.opened} of ${r.totals.sent}`} />
        <Stat label="Unsubscribed" value={r.totals.unsubscribed} tone={r.totals.unsubscribed ? "warning" : "default"} />
        <Stat label="Needs a look" value={r.attention.length} tone={r.attention.length ? "warning" : "default"} hint="Wool question or skipped" />
      </div>

      {r.slowGroups.length ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <p>
            Slowed to one extra email every 12 weeks: {r.slowGroups.join(", ")}. Unsubscribes went above 1% an email or opens fell below 30% over the
            last 90 days.
          </p>
        </div>
      ) : null}

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "people", label: "People" },
          { value: "emails", label: "Emails" },
          { value: "settings", label: "Wool ranges" },
        ]}
      />

      {tab === "people" ? (
        <div className="grid gap-4">
          <AttentionCard rows={r.attention} />
          <MembersCard rows={r.members} />
        </div>
      ) : tab === "emails" ? (
        <TemplatesCard perCode={r.perCode} isAdmin={isAdmin} />
      ) : (
        <WoolRangesCard ranges={r.settings.woolRanges} isAdmin={isAdmin} />
      )}
    </Page>
  );
}

/* ---------------------------------------------------------------------------
 * The switch
 * ------------------------------------------------------------------------- */

type Settings = {
  on: boolean;
  startedAt: number | null;
  woolRanges: string[];
  ticking: boolean;
  lastRun: { at: number; error: string | null } | null;
};

function EngineSwitch({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const setOn = useCareSetOn();
  const runNow = useCareRunNow();
  const [confirm, setConfirm] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ran, setRan] = React.useState<string | null>(null);

  async function flip(on: boolean) {
    setError(null);
    try {
      await setOn.mutateAsync({ on });
      setConfirm(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function run() {
    setError(null);
    setRan(null);
    try {
      const out = (await runNow.mutateAsync({})) as { error?: string } | undefined;
      setRan(out && "error" in out && out.error ? `Ran with an error: ${out.error}` : "Ran just now.");
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Badge colour={settings.on ? "#3F7D3A" : "#7A736D"}>{settings.on ? "Sending" : "Off"}</Badge>
        {isAdmin ? (
          settings.on ? (
            <Button size="sm" variant="outline" onClick={() => flip(false)} disabled={setOn.isPending}>
              Switch off
            </Button>
          ) : (
            <Button size="sm" onClick={() => setConfirm(true)}>
              Switch on
            </Button>
          )
        ) : null}
        {isAdmin && settings.on && settings.ticking ? (
          <Button size="sm" variant="outline" onClick={run} disabled={runNow.isPending}>
            <Play className="size-3.5" /> Run now
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {settings.startedAt ? `Jobs completed from ${day(settings.startedAt)} on. ` : "Never switched on yet. "}
        {settings.lastRun ? `Last run ${when(settings.lastRun.at)}${settings.lastRun.error ? `, error: ${settings.lastRun.error}` : ""}.` : ""}
        {!settings.ticking ? " Only the live site sends." : ""}
      </p>
      {ran ? <p className="text-xs text-[var(--success)]">{ran}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Switch the care emails on?"
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Not yet
            </Button>
            <Button onClick={() => flip(true)} disabled={setOn.isPending}>
              Switch on
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm">
          <p>Every 10 minutes the live site looks for jobs that have gone to Completed and adds the person living in the house. On builder, insurance and agency jobs that is only someone tagged Owner or Landlord on the job. On rentals it is the Landlord tagged on the job, never the tenant or the property manager. Builder, agency and bill-to contacts are never added.</p>
          <p>People already added from earlier jobs start from the day you switch on. Emails whose date has gone are passed over.</p>
          <p>
            {settings.startedAt
              ? `Jobs completed since ${day(settings.startedAt)} are looked at.`
              : "Only jobs completed from now on are looked at. Older jobs need the backfill."}
          </p>
          <p>Series emails go at 9am Brisbane time and holiday emails at 7am. Nobody gets more than one a day.</p>
          {error ? <p className="text-destructive">{error}</p> : null}
        </div>
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Jobs that need a look
 * ------------------------------------------------------------------------- */

type AttentionRow = { id: number; ref: string; title: string; careState: string; careNote: string; completedAt: number | null; client?: string | null };

function AttentionCard({ rows }: { rows: AttentionRow[] }) {
  const wool = useCareWoolAnswer();
  const retry = useCareRetryJob();
  const [error, setError] = React.useState<string | null>(null);
  const [showSkipped, setShowSkipped] = React.useState(false);
  const waiting = rows.filter((r) => r.careState === "waiting_wool");
  const skipped = rows.filter((r) => r.careState === "skipped");

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Card>
      <CardHeader
        title="Needs a look"
        subtitle="Carpet jobs wait for the wool answer before any care email goes. Skipped jobs say why."
        action={
          skipped.length ? (
            <Button size="sm" variant="ghost" onClick={() => setShowSkipped((v) => !v)}>
              {showSkipped ? "Hide skipped" : `Show skipped (${skipped.length})`}
            </Button>
          ) : null
        }
      />
      {error ? <p className="px-4 pt-3 text-sm text-destructive">{error}</p> : null}
      {waiting.length === 0 && (!showSkipped || skipped.length === 0) ? (
        <Empty>Nothing waiting on the wool question.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {waiting.map((j) => (
            <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                {j.ref}
              </Link>
              <span className="min-w-0 flex-1 truncate">
                {j.client ? <span className="font-medium">{j.client}. </span> : null}
                {j.title}
              </span>
              <span className="text-xs text-muted-foreground">Is this carpet wool?</span>
              <span className="flex gap-1">
                <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId: j.id, answer: "wool" }))}>
                  Yes
                </Button>
                <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId: j.id, answer: "wool_blend" }))}>
                  Wool blend
                </Button>
                <Button size="sm" variant="outline" disabled={wool.isPending} onClick={() => act(() => wool.mutateAsync({ jobId: j.id, answer: "not_wool" }))}>
                  No
                </Button>
              </span>
            </li>
          ))}
          {showSkipped
            ? skipped.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                  <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                    {j.ref}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {j.title} <span className="text-foreground">Skipped: {j.careNote}</span>
                  </span>
                  <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => act(() => retry.mutateAsync({ jobId: j.id }))}>
                    <RotateCcw className="size-3.5" /> Try again
                  </Button>
                </li>
              ))
            : null}
        </ul>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------------------
 * Who is in, and what they are up to
 * ------------------------------------------------------------------------- */

type MemberRow = {
  id: number;
  name: string;
  email: string;
  status: string;
  stopReason: string;
  floors: { floor: string; label: string }[];
  landlord: boolean;
  startedAt: number;
  sent: number;
  opened: number;
  last: { code: string; title: string; at: number; opened: boolean } | null;
  next: { code: string; title: string; kind: string; dueAt: number } | null;
  slow: boolean;
};

function MembersCard({ rows }: { rows: MemberRow[] }) {
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("active");
  const [open, setOpen] = React.useState<number | null>(null);
  const shown = rows.filter(
    (r) => (status === "all" || r.status === status) && (!q.trim() || `${r.name} ${r.email}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  return (
    <Card>
      <CardHeader
        title="Who is in the series"
        subtitle="Which email each person is up to, and when the next one goes."
        action={
          <div className="flex gap-2">
            <Input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-48" />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-8 w-36">
              <option value="active">Active</option>
              <option value="unsubscribed">Unsubscribed</option>
              <option value="stopped">Taken out</option>
              <option value="all">Everyone</option>
            </Select>
          </div>
        }
      />
      {shown.length === 0 ? (
        <Empty>{rows.length === 0 ? "Nobody yet. People are added when their job goes to Completed with the engine on." : "Nobody matches."}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Person</th>
                <th className="px-4 py-2 font-medium">Floors</th>
                <th className="px-4 py-2 font-medium">Up to</th>
                <th className="px-4 py-2 font-medium">Next</th>
                <th className="px-4 py-2 text-right font-medium">Opened</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((m) => (
                <tr key={m.id} className="cursor-pointer hover:bg-secondary/50" onClick={() => setOpen(m.id)}>
                  <td className="px-4 py-2">
                    <p className="font-medium">{m.name || "No name"}</p>
                    <p className="text-xs text-muted-foreground">{m.email}</p>
                  </td>
                  <td className="px-4 py-2">
                    {m.floors.map((f) => f.label).join(", ")}
                    {m.landlord ? <span className="text-xs text-muted-foreground"> (landlord)</span> : null}
                  </td>
                  <td className="px-4 py-2">
                    {m.last ? (
                      <>
                        <p>
                          {m.last.code} {m.last.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {day(m.last.at)}
                          {m.last.opened ? ", opened" : ""}
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Nothing yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {m.next ? (
                      <>
                        <p>
                          {m.next.code} {m.next.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {day(m.next.dueAt)}
                          {m.slow ? ", slowed" : ""}
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{m.status === "active" ? "Series finished" : ""}</span>
                    )}
                  </td>
                  <td className="tabular px-4 py-2 text-right">
                    {m.opened} of {m.sent}
                  </td>
                  <td className="px-4 py-2">
                    <Badge colour={STATUS_COLOUR[m.status]}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <MemberModal memberId={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

function MemberModal({ memberId, onClose }: { memberId: number | null; onClose: () => void }) {
  const q = useCareMember(memberId);
  const setStatus = useCareSetMemberStatus();
  const [error, setError] = React.useState<string | null>(null);
  const m = q.data;

  async function flip(active: boolean) {
    if (!m) return;
    setError(null);
    try {
      await setStatus.mutateAsync({ memberId: m.id, active });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal
      open={memberId != null}
      onClose={onClose}
      width="max-w-2xl"
      title={m ? m.name || "No name" : "Loading…"}
      subtitle={m ? `${m.email}. ${m.floors.map((f) => f.label).join(", ")}${m.landlord ? ", landlord" : ""}` : undefined}
      footer={
        m && m.status !== "unsubscribed" ? (
          m.status === "active" ? (
            <Button variant="outline" onClick={() => flip(false)} disabled={setStatus.isPending}>
              Take out of the series
            </Button>
          ) : (
            <Button onClick={() => flip(true)} disabled={setStatus.isPending}>
              Put back in
            </Button>
          )
        ) : null
      }
    >
      {!m ? (
        <Loading />
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge colour={STATUS_COLOUR[m.status]}>{STATUS_LABEL[m.status] ?? m.status}</Badge>
            {m.stopReason ? <span className="text-xs text-muted-foreground">{m.stopReason}</span> : null}
            <Link to={`/clients/${m.contactId}`} className="ml-auto text-xs text-primary hover:underline">
              Open contact
            </Link>
          </div>
          {error ? <p className="text-destructive">{error}</p> : null}

          <div>
            <p className="label-xs mb-1">Sent so far</p>
            {m.history.length === 0 ? (
              <p className="text-muted-foreground">Nothing sent yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {m.history.map((h) => (
                  <li key={h.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-10 font-medium">{h.code}</span>
                    <span className="min-w-0 flex-1 truncate">{h.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {h.status === "sent" ? day(h.sentAt) : `${h.status}${h.note ? `: ${h.note}` : ""}`}
                      {h.resent ? `, sent again ${day(h.resentAt)}` : ""}
                    </span>
                    {h.status === "sent" ? <Badge colour={h.openedAt ? "#3F7D3A" : undefined}>{h.openedAt ? "Opened" : "Not opened"}</Badge> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {m.status === "active" ? (
            <div>
              <p className="label-xs mb-1">Coming up in the next 12 months</p>
              {m.plan.length === 0 ? (
                <p className="text-muted-foreground">Nothing left to send.</p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {m.plan.map((p, i) => (
                    <li key={`${p.code}-${i}`} className="flex items-center gap-3 px-3 py-2">
                      <span className="w-10 font-medium">{p.code}</span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <span className="text-xs text-muted-foreground">{KIND_LABEL[p.kind] ?? p.kind}</span>
                      <span className="w-28 text-right text-xs">{day(p.dueAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-xs text-muted-foreground">Dates move if an email is held back or the series slows down.</p>
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * The emails
 * ------------------------------------------------------------------------- */

const KIND_ORDER = ["series", "fixed", "bank", "holiday"];
const codeSort = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function TemplatesCard({ perCode, isAdmin }: { perCode: { code: string; sent: number; opened: number }[]; isAdmin: boolean }) {
  const list = useCareTemplates();
  const [editing, setEditing] = React.useState<string | null>(null);
  const stats = new Map(perCode.map((p) => [p.code, p]));

  if (list.isLoading) return <Loading />;
  const rows = [...(list.data ?? [])].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || codeSort(a.code, b.code));

  return (
    <Card>
      <CardHeader title="The emails" subtitle="Every email in the series. Click one to read it, change the words or send yourself a test." />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Subject</th>
              <th className="px-4 py-2 font-medium">Kind</th>
              <th className="px-4 py-2 text-right font-medium">Sent</th>
              <th className="px-4 py-2 text-right font-medium">Opened</th>
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Flags</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((t) => {
              const s = stats.get(t.code);
              return (
                <tr key={t.code} className="cursor-pointer hover:bg-secondary/50" onClick={() => setEditing(t.code)}>
                  <td className="px-4 py-2">
                    <span className="font-medium">{t.code}</span> {t.title}
                    <p className="text-xs text-muted-foreground">{t.audience}</p>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2">{t.subject}</td>
                  <td className="px-4 py-2">{KIND_LABEL[t.kind] ?? t.kind}</td>
                  <td className="tabular px-4 py-2 text-right">{s?.sent ?? 0}</td>
                  <td className="tabular px-4 py-2 text-right">{s ? pct(s.opened, s.sent) : ""}</td>
                  <td className="px-4 py-2">
                    <span className="flex gap-1">
                      {t.edited ? <Badge>Edited</Badge> : null}
                      {!t.active ? <Badge colour="#C0603F">Not sending</Badge> : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing ? (
        <TemplateModal template={rows.find((t) => t.code === editing) ?? null} onClose={() => setEditing(null)} isAdmin={isAdmin} />
      ) : null}
    </Card>
  );
}

type LiveTemplate = {
  code: string;
  title: string;
  audience: string;
  subject: string;
  body: string;
  active: boolean;
  edited: boolean;
  kind: string;
  baseSubject: string;
  baseBody: string;
};

function TemplateModal({ template, onClose, isAdmin }: { template: LiveTemplate | null; onClose: () => void; isAdmin: boolean }) {
  const save = useCareSaveTemplate();
  const reset = useCareResetTemplate();
  const preview = useCarePreview();
  const sendTest = useCareSendTest();
  const [subject, setSubject] = React.useState(template?.subject ?? "");
  const [body, setBody] = React.useState(template?.body ?? "");
  const [active, setActive] = React.useState(template?.active ?? true);
  const [fibre, setFibre] = React.useState("");
  const [pile, setPile] = React.useState("");
  const [resend, setResend] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const previewMutate = preview.mutate;

  React.useEffect(() => {
    if (!template) return;
    const t = setTimeout(() => previewMutate({ code: template.code, subject, body, fibre, pile, resend }), 350);
    return () => clearTimeout(t);
  }, [template, subject, body, fibre, pile, resend, previewMutate]);

  if (!template) return null;
  const hasBranches = /\{if /i.test(body);
  const dirty = subject !== template.subject || body !== template.body || active !== template.active;

  async function run(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={`${template.code} ${template.title}`}
      subtitle={`${KIND_LABEL[template.kind] ?? template.kind}, for ${template.audience}. From damien@, plain text, sign-off and unsubscribe added on send.`}
      footer={
        isAdmin ? (
          <>
            {template.edited ? (
              <Button
                variant="ghost"
                className="mr-auto"
                disabled={reset.isPending}
                onClick={() =>
                  run(async () => {
                    await reset.mutateAsync({ code: template.code });
                    setSubject(template.baseSubject);
                    setBody(template.baseBody);
                  }, "Back to the starting copy.")
                }
              >
                <RotateCcw className="size-3.5" /> Back to the starting copy
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={sendTest.isPending || dirty}
              title={dirty ? "Save first, the test sends the saved copy" : undefined}
              onClick={() =>
                run(async () => {
                  const r = await sendTest.mutateAsync({ code: template.code, fibre, pile });
                  return r;
                }, "Test sent to your email.")
              }
            >
              <Send className="size-3.5" /> Send me a test
            </Button>
            <Button disabled={save.isPending || !dirty} onClick={() => run(() => save.mutateAsync({ code: template.code, subject, body, active }), "Saved.")}>
              Save
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!isAdmin} />
          </Field>
          <Field label="Email">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={18} disabled={!isAdmin} className="font-mono text-xs" />
          </Field>
          <p className="text-xs text-muted-foreground">
            {"{{first_name}}"} is their first name. Parts inside {"{if Wool}"} and {"{/if}"} only go to the people they fit, the same for {"{if Loop pile}"}.
          </p>
          {isAdmin ? (
            <label htmlFor="care_tpl_active" className="flex items-center gap-2 text-sm">
              <Checkbox id="care_tpl_active" checked={active} onChange={(e) => setActive(e.target.checked)} />
              Send this email
            </label>
          ) : null}
          {msg ? <p className={msg.ok ? "text-sm text-[var(--success)]" : "text-sm text-destructive"}>{msg.text}</p> : null}
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Preview for Sarah</span>
            {hasBranches ? (
              <>
                <Select value={fibre} onChange={(e) => setFibre(e.target.value)} className="h-8 w-36">
                  <option value="">Any fibre</option>
                  <option value="wool">Wool</option>
                  <option value="wool_blend">Wool blend</option>
                  <option value="nylon">Nylon</option>
                  <option value="polypropylene">Polypropylene</option>
                  <option value="polyester">Polyester</option>
                </Select>
                <Select value={pile} onChange={(e) => setPile(e.target.value)} className="h-8 w-32">
                  <option value="">Any pile</option>
                  <option value="cut">Cut pile</option>
                  <option value="loop">Loop pile</option>
                  <option value="cut_loop">Cut and loop</option>
                </Select>
              </>
            ) : null}
            {template.kind !== "holiday" ? (
              <label htmlFor="care_tpl_resend" className="flex items-center gap-1 text-xs">
                <Checkbox id="care_tpl_resend" checked={resend} onChange={(e) => setResend(e.target.checked)} />
                As the resend
              </label>
            ) : null}
          </div>
          <p className="text-sm">
            <span className="text-muted-foreground">Subject:</span> {preview.data?.subject ?? subject}
          </p>
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={preview.data?.html ?? ""}
            className="h-[460px] w-full rounded-md border border-border bg-white"
          />
          {preview.error ? <p className="text-xs text-destructive">{errorText(preview.error)}</p> : null}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
 * Wool ranges
 * ------------------------------------------------------------------------- */

function WoolRangesCard({ ranges, isAdmin }: { ranges: string[]; isAdmin: boolean }) {
  const save = useCareSetWoolRanges();
  const [text, setText] = React.useState(ranges.join("\n"));
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    setMsg(null);
    try {
      const r = await save.mutateAsync({ ranges: text.split("\n") });
      setText(r.ranges.join("\n"));
      setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Card>
      <CardHeader
        title="Wool ranges"
        subtitle="Carpet ranges that are wool even when the price book does not say so. A job with one of these skips the wool question."
      />
      <div className="space-y-3 px-4 py-4">
        <p className="text-sm text-muted-foreground">
          One range name per line. The fibre set on a product in the Price book wins over this list, and the answer on a job wins over both.
        </p>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} disabled={!isAdmin} className="max-w-md" />
        {isAdmin ? (
          <div className="flex items-center gap-3">
            <Button onClick={submit} disabled={save.isPending || text.trim() === ranges.join("\n")}>
              Save
            </Button>
            {msg ? <span className={msg.ok ? "text-sm text-[var(--success)]" : "text-sm text-destructive"}>{msg.text}</span> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
