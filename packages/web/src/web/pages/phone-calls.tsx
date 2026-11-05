import * as React from "react";
import { useLocation, useSearch } from "wouter";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Select } from "../components/ui/field";
import { errorText } from "../components/public-shell";
import { CallLine, FollowupLine, FollowupPanel, PhoneSetupNotes } from "../components/phone-calls";
import { PhoneSettings, RoutingTest } from "../components/phone-settings";
import { useAddCover, useCancelCover, usePhoneCallList, usePhoneConfig, usePhoneCovers, usePhoneFollowups, usePhoneStatus } from "../queries/phoneCalls";
import { cn } from "@/lib/utils";

/**
 * AI PHONE CALLS AND ROUTING (Retell, 5 Nov).
 *
 * Follow-ups the AI phone agent left for a person, every call it took, leave
 * cover, and (for whoever may change it) where each kind of call goes.
 * ?followup=<id> opens that follow-up, which is where notifications link to.
 */

const TABS = [
  { key: "mine", label: "My follow-ups" },
  { key: "queue", label: "Queue" },
  { key: "open", label: "All open" },
  { key: "resolved", label: "Resolved" },
  { key: "calls", label: "Calls" },
  { key: "cover", label: "Leave cover" },
  { key: "settings", label: "Settings" },
  { key: "test", label: "Routing test" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function FollowupList({ scope, onOpen }: { scope: "mine" | "queue" | "open" | "resolved"; onOpen: (id: number) => void }) {
  const q = usePhoneFollowups(scope);
  const empty = { mine: "Nothing waiting for you.", queue: "The queue is empty.", open: "No open follow-ups.", resolved: "Nothing resolved yet." }[scope];
  return (
    <Card>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <Empty>{errorText(q.error)}</Empty>
      ) : !q.data?.length ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {q.data.map((f) => (
            <FollowupLine key={f.id} f={f} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function CallList() {
  const q = usePhoneCallList();
  return (
    <Card>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <Empty>{errorText(q.error)}</Empty>
      ) : !q.data?.length ? (
        <Empty>No calls yet.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {q.data.map((c) => (
            <CallLine key={c.id} c={c} />
          ))}
        </ul>
      )}
    </Card>
  );
}

const todayBne = () => new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);
const ddmm = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

function CoverTab() {
  const covers = usePhoneCovers();
  const cfg = usePhoneConfig();
  const status = usePhoneStatus();
  const add = useAddCover();
  const cancel = useCancelCover();
  const me = status.data?.me ?? null;
  const [form, setForm] = React.useState({ profileId: "", coverProfileId: "", kind: "leave" as "leave" | "delegation", fromDate: todayBne(), toDate: "", reason: "" });
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const people = cfg.data?.people ?? [];
  const forWho = form.profileId || (me ? String(me) : "");
  const submit = () => {
    setMsg(null);
    add.mutate(
      { profileId: Number(forWho), coverProfileId: Number(form.coverProfileId), kind: form.kind, fromDate: form.fromDate, toDate: form.toDate || null, reason: form.reason },
      {
        onSuccess: (r) => setMsg({ ok: true, text: r.moved ? `Saved. ${r.moved} open item${r.moved === 1 ? "" : "s"} moved to ${r.coverName} now, deadlines kept.` : `Saved. ${r.coverName} will get new work${form.fromDate > todayBne() ? " from the start date" : ""}.` }),
        onError: (e) => setMsg({ ok: false, text: errorText(e) }),
      },
    );
  };
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="Set leave or a delegation" subtitle="While it runs, new and open work goes to the cover person. Deadlines and history stay with each item." />
        <div className="grid gap-3 px-4 py-3 text-sm sm:grid-cols-3">
          <label>
            <span className="label-xs">Who is away</span>
            <Select className="mt-0.5 h-8" value={forWho} disabled={!status.data?.canReassign} onChange={(e) => setForm({ ...form, profileId: e.target.value })}>
              <option value="">Choose</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="label-xs">Who covers</span>
            <Select className="mt-0.5 h-8" value={form.coverProfileId} onChange={(e) => setForm({ ...form, coverProfileId: e.target.value })}>
              <option value="">Choose</option>
              {people
                .filter((p) => String(p.id) !== forWho)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </label>
          <label htmlFor="cover-kind">
            <span className="label-xs">Kind</span>
            <Select id="cover-kind" className="mt-0.5 h-8" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "leave" | "delegation" })}>
              <option value="leave">Leave (dated)</option>
              <option value="delegation">Delegation (until cancelled)</option>
            </Select>
          </label>
          <label htmlFor="cover-from">
            <span className="label-xs">From</span>
            <Input id="cover-from" type="date" className="mt-0.5 h-8" value={form.fromDate} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
          </label>
          <label htmlFor="cover-to">
            <span className="label-xs">To{form.kind === "delegation" ? " (optional)" : ""}</span>
            <Input id="cover-to" type="date" className="mt-0.5 h-8" value={form.toDate} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
          </label>
          <label htmlFor="cover-reason">
            <span className="label-xs">Reason (optional)</span>
            <Input id="cover-reason" className="mt-0.5 h-8" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </label>
          <div className="flex items-center gap-3 sm:col-span-3">
            <Button size="sm" disabled={add.isPending || !forWho || !form.coverProfileId || (form.kind === "leave" && !form.toDate)} onClick={submit}>
              Save cover
            </Button>
            {msg ? <span className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-destructive")}>{msg.text}</span> : null}
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title="Current and upcoming" />
        {covers.isLoading ? (
          <Loading />
        ) : covers.error ? (
          <Empty>{errorText(covers.error)}</Empty>
        ) : !covers.data?.length ? (
          <Empty>Nobody is away.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {covers.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                <span>
                  <span className="font-medium">{c.personName}</span> {c.kind === "leave" ? "on leave" : "delegated"} {ddmm(c.fromDate)}
                  {c.toDate ? ` to ${ddmm(c.toDate)}` : " onwards"}, covered by <span className="font-medium">{c.coverName}</span>
                  {c.current ? " (now)" : ""}
                  {c.reason ? <span className="text-muted-foreground"> · {c.reason}</span> : null}
                </span>
                {c.profileId === me || status.data?.canReassign ? (
                  <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => window.confirm("Cancel this cover? Work already passed on stays with its new owner.") && cancel.mutate({ id: c.id })}>
                    Cancel
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export default function PhoneCallsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const openId = params.get("followup") ? Number(params.get("followup")) : null;
  const status = usePhoneStatus();
  const [tab, setTab] = React.useState<Tab>((params.get("tab") as Tab) || "mine");
  const setOpen = (id: number | null) => navigate(id ? `/phone-calls?tab=${tab}&followup=${id}` : `/phone-calls?tab=${tab}`, { replace: true });
  const tabs = TABS.filter((t) => (t.key === "settings" || t.key === "test" ? true : status.data?.canView !== false));

  return (
    <Page title="AI phone calls" subtitle="What the phone agent did, what's left for a person, and where each kind of call goes.">
      <div className="grid gap-4">
        <PhoneSetupNotes />
        {status.data && !status.data.canView ? <p className="text-sm text-muted-foreground">Your role can't see AI phone calls. An admin can change that in Settings below.</p> : null}
        <div className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                navigate(`/phone-calls?tab=${t.key}`, { replace: true });
              }}
              className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "mine" || tab === "queue" || tab === "open" || tab === "resolved" ? <FollowupList scope={tab} onOpen={setOpen} /> : null}
        {tab === "calls" ? <CallList /> : null}
        {tab === "cover" ? <CoverTab /> : null}
        {tab === "settings" ? <PhoneSettings /> : null}
        {tab === "test" ? <RoutingTest /> : null}
      </div>
      <FollowupPanel id={openId} onClose={() => setOpen(null)} />
    </Page>
  );
}
