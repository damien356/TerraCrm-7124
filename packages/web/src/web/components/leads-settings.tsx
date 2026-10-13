import * as React from "react";
import { Copy, Pencil, Plus } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import {
  useAdSpend,
  useBlockedLeads,
  useLeadSettings,
  useReleaseLead,
  useSaveAdSpend,
  useSaveAutoReply,
  useSaveLandingPage,
  useSaveLeadSource,
} from "../queries/leads";
import { useSaveTimberSettings, useTimberPreview, useTimberSettings } from "../queries/timber";
import { moneyExact } from "../lib/money";

/* ---------------------------------------------------------------------------
 * Settings, Leads (spec 14 Oct, notes 18.38). Admin only.
 *
 *   Lead sources     the list every New job and quote picks from
 *   Landing pages    one row per page; adding a row is all a new page needs
 *   Client reply     the thank you email on a new lead, off unless switched on
 *   Ad spend         per page per month, for cost per lead and return per $1
 *   Blocked posts    form posts caught as spam, with Let through
 *   Timber repairs   markup, minimum, auto send, the 3 templates, SMS cost
 * ------------------------------------------------------------------------- */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Msg = { ok: boolean; text: string } | null;

function Note({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <p className={msg.ok ? "text-xs text-[var(--success)]" : "text-xs text-destructive"}>{msg.text}</p>;
}

export function LeadsSettingsTab() {
  const q = useLeadSettings();
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <p className="text-sm text-muted-foreground">Only an Admin can change lead settings.</p>;
  const d = q.data;
  return (
    <div className="space-y-4">
      <SourcesCard sources={d.sources} strays={d.strays} />
      <PagesCard pages={d.pages} sources={d.sources} clientTypes={d.clientTypes} siteUrl={d.siteUrl} />
      <AutoReplyCard on={d.autoReply} />
      <SpendCard pages={d.pages} />
      <BlockedCard />
      <TimberCard />
    </div>
  );
}

/* ------------------------------ lead sources ------------------------------ */

type SourceRow = { id: number; name: string; active: boolean; sortOrder: number; jobs: number };

function SourcesCard({ sources, strays }: { sources: SourceRow[]; strays: { name: string; jobs: number }[] }) {
  const save = useSaveLeadSource();
  const [editing, setEditing] = React.useState<SourceRow | null>(null);
  const [name, setName] = React.useState("");
  const [adding, setAdding] = React.useState("");
  const [msg, setMsg] = React.useState<Msg>(null);

  const run = async (input: { id?: number; name: string; active: boolean; sortOrder: number }, done?: () => void) => {
    setMsg(null);
    try {
      const out = await save.mutateAsync(input);
      setMsg({ ok: true, text: out.moved ? `Saved. ${out.moved} jobs moved to "${out.name}".` : "Saved." });
      done?.();
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };

  return (
    <Card>
      <CardHeader
        title="Lead sources"
        subtitle="Every job picks one of these. Renaming a source moves its jobs with it. Switched off sources stay on old jobs but leave the picker."
      />
      <div className="divide-y divide-border">
        {sources.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2">
            <div className="min-w-0 flex-1">
              <p className={s.active ? "text-sm font-medium" : "text-sm text-muted-foreground line-through"}>{s.name}</p>
              <p className="text-xs text-muted-foreground">{s.jobs} job{s.jobs === 1 ? "" : "s"}</p>
            </div>
            <label htmlFor={`lead_src_${s.id}`} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                id={`lead_src_${s.id}`}
                checked={s.active}
                onChange={(e) => run({ id: s.id, name: s.name, active: e.target.checked, sortOrder: s.sortOrder })}
              />
              In the picker
            </label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(s);
                setName(s.name);
              }}
            >
              <Pencil /> Rename
            </Button>
          </div>
        ))}
        {strays.length ? (
          <div className="px-4 py-3">
            <p className="label-xs mb-1">On jobs but not in the list</p>
            <div className="flex flex-wrap gap-1.5">
              {strays.map((s) => (
                <Badge key={s.name}>
                  {s.name}: {s.jobs}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <form
        className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!adding.trim()) return;
          void run({ name: adding.trim(), active: true, sortOrder: sources.length + 1 }, () => setAdding(""));
        }}
      >
        <Field label="New source" className="w-full sm:w-80">
          <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="e.g. Google Ads: Hospitals" />
        </Field>
        <Button type="submit" size="sm" disabled={save.isPending || !adding.trim()}>
          <Plus /> Add
        </Button>
        <Note msg={msg} />
      </form>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Rename lead source"
        subtitle={editing ? `${editing.jobs} jobs carry "${editing.name}". They move to the new name.` : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending || !name.trim()}
              onClick={() =>
                editing && run({ id: editing.id, name: name.trim(), active: editing.active, sortOrder: editing.sortOrder }, () => setEditing(null))
              }
            >
              Save
            </Button>
          </div>
        }
      >
        <Field label="Name">
          <Input id="lead_source_name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="mt-2">
          <Note msg={msg && !msg.ok ? msg : null} />
        </div>
      </Modal>
    </Card>
  );
}

/* ------------------------------ landing pages ------------------------------ */

type PageRow = {
  id: number;
  url: string;
  leadSource: string;
  clientType: string;
  tags: string[];
  followUpOn: boolean;
  formKey: string;
  conversionLabel: string;
  timber: boolean;
  active: boolean;
  jobs: number;
  postTo: string;
};

type PageDraft = Omit<PageRow, "id" | "jobs" | "postTo" | "tags"> & { id?: number; tags: string };

const blankPage = (): PageDraft => ({
  url: "",
  leadSource: "",
  clientType: "homeowner",
  tags: "",
  followUpOn: true,
  formKey: "",
  conversionLabel: "",
  timber: false,
  active: true,
});

function PagesCard({
  pages,
  sources,
  clientTypes,
  siteUrl,
}: {
  pages: PageRow[];
  sources: SourceRow[];
  clientTypes: { value: string; label: string }[];
  siteUrl: string;
}) {
  const save = useSaveLandingPage();
  const [draft, setDraft] = React.useState<PageDraft | null>(null);
  const [msg, setMsg] = React.useState<Msg>(null);
  const [copied, setCopied] = React.useState<string | null>(null);
  const typeLabel = (v: string) => clientTypes.find((c) => c.value === v)?.label ?? v;
  const set = <K extends keyof PageDraft>(k: K, v: PageDraft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const submit = async () => {
    if (!draft) return;
    setMsg(null);
    try {
      await save.mutateAsync({
        ...draft,
        tags: draft.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setDraft(null);
    } catch (e) {
      setMsg({ ok: false, text: errText(e) });
    }
  };

  return (
    <Card>
      <CardHeader
        title="Landing pages"
        subtitle="Each page posts its form to its own address below. Adding a row here is all a new page needs on the Terra side."
        action={
          <Button
            size="sm"
            onClick={() => {
              setMsg(null);
              setDraft(blankPage());
            }}
          >
            <Plus /> Add page
          </Button>
        }
      />
      {pages.length === 0 ? <Empty>No pages yet.</Empty> : null}
      <div className="divide-y divide-border">
        {pages.map((p) => {
          const post = `${siteUrl}${p.postTo}`;
          return (
            <div key={p.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 space-y-1">
                <p className={p.active ? "text-sm font-medium" : "text-sm text-muted-foreground line-through"}>{p.url || "(no address)"}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>{p.leadSource}</Badge>
                  <Badge>{typeLabel(p.clientType)}</Badge>
                  {p.tags.map((t) => (
                    <Badge key={t} colour="#8A6D3B">
                      {t}
                    </Badge>
                  ))}
                  {p.followUpOn ? null : <Badge>Follow up off</Badge>}
                  {p.conversionLabel ? null : <Badge colour="#B45309">No conversion label</Badge>}
                </div>
                <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  Posts to <code className="rounded bg-secondary px-1">{post}</code>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[var(--gold-deep)] hover:underline"
                    onClick={() => {
                      void navigator.clipboard?.writeText(post);
                      setCopied(post);
                    }}
                  >
                    <Copy className="size-3" /> {copied === post ? "Copied" : "Copy"}
                  </button>
                </p>
                <p className="text-xs text-muted-foreground">{p.jobs} job{p.jobs === 1 ? "" : "s"}</p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMsg(null);
                  setDraft({ ...p, tags: p.tags.join(", ") });
                }}
              >
                <Pencil /> Edit
              </Button>
            </div>
          );
        })}
      </div>

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit landing page" : "Add landing page"}
        width="max-w-xl"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Note msg={msg} />
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button disabled={save.isPending} onClick={submit}>
              {save.isPending ? <Spinner /> : null} Save
            </Button>
          </div>
        }
      >
        {draft ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Web address" className="sm:col-span-2">
              <Input id="lp_url" value={draft.url} onChange={(e) => set("url", e.target.value)} placeholder="hospitals.terraflooring.com.au" />
            </Field>
            <Field label="Lead source">
              <Select id="lp_source" value={draft.leadSource} onChange={(e) => set("leadSource", e.target.value)}>
                <option value="" disabled>
                  Pick one…
                </option>
                {sources.map((s) => (
                  <option key={s.id} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Client type">
              <Select id="lp_type" value={draft.clientType} onChange={(e) => set("clientType", e.target.value)}>
                {clientTypes.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Form key" hint="Letters, numbers and dashes. The page posts to /api/leads/<form key>.">
              <Input id="lp_key" value={draft.formKey} onChange={(e) => set("formKey", e.target.value)} placeholder="hospitals" />
            </Field>
            <Field label="Tags" hint="Comma between tags.">
              <Input id="lp_tags" value={draft.tags} onChange={(e) => set("tags", e.target.value)} />
            </Field>
            <Field label="Google Ads conversion label" className="sm:col-span-2" hint="For the record. The page fires its own tag.">
              <Input id="lp_conv" value={draft.conversionLabel} onChange={(e) => set("conversionLabel", e.target.value)} placeholder="AW-859821500/..." />
            </Field>
            <label htmlFor="lp_followup" className="flex items-center gap-2 text-sm">
              <Checkbox id="lp_followup" checked={draft.followUpOn} onChange={(e) => set("followUpOn", e.target.checked)} /> Follow up sequence on
            </label>
            <label htmlFor="lp_timber" className="flex items-center gap-2 text-sm">
              <Checkbox id="lp_timber" checked={draft.timber} onChange={(e) => set("timber", e.target.checked)} /> Timber repair page (texts Marc)
            </label>
            <label htmlFor="lp_active" className="flex items-center gap-2 text-sm">
              <Checkbox id="lp_active" checked={draft.active} onChange={(e) => set("active", e.target.checked)} /> Taking leads
            </label>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

/* ------------------------------- client reply ------------------------------- */

function AutoReplyCard({ on }: { on: boolean }) {
  const save = useSaveAutoReply();
  const [msg, setMsg] = React.useState<Msg>(null);
  return (
    <Card>
      <CardHeader title="Reply to the client" subtitle="A short thank you email to the client when a lead comes in. Off unless you switch it on." />
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <label htmlFor="lead_autoreply" className="flex items-center gap-2 text-sm">
          <Checkbox
            id="lead_autoreply"
            checked={on}
            disabled={save.isPending}
            onChange={async (e) => {
              setMsg(null);
              try {
                await save.mutateAsync({ on: e.target.checked });
                setMsg({ ok: true, text: e.target.checked ? "On. New leads with an email get the thank you." : "Off." });
              } catch (err) {
                setMsg({ ok: false, text: errText(err) });
              }
            }}
          />
          Send the thank you email
        </label>
        <Note msg={msg} />
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        It says we have the enquiry and someone will call within one business day. It goes from team@. No SMS.
      </p>
    </Card>
  );
}

/* --------------------------------- ad spend --------------------------------- */

function SpendCard({ pages }: { pages: PageRow[] }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = React.useState(thisYear);
  const spend = useAdSpend(year);
  const save = useSaveAdSpend();
  const [msg, setMsg] = React.useState<Msg>(null);
  const value = (pageId: number, m: string) => spend.data?.find((s) => s.landingPageId === pageId && s.month === m)?.amount ?? 0;

  return (
    <Card>
      <CardHeader
        title="Ad spend"
        subtitle="What each page cost per month, ex GST. The leads report turns it into cost per lead and return per $1."
        action={
          <Select className="w-24" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        }
      />
      {spend.isLoading ? <Loading /> : null}
      <div className="overflow-x-auto px-4 py-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="label-xs py-1 pr-2">Page</th>
              {MONTHS.map((m) => (
                <th key={m} className="label-xs px-1 py-1 text-right">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pages
              .filter((p) => p.active)
              .map((p) => (
                <tr key={p.id} className="border-t border-border">
                  <td className="py-1 pr-2 text-xs">{p.url.split(".")[0]}</td>
                  {MONTHS.map((_, i) => {
                    const m = `${year}-${String(i + 1).padStart(2, "0")}`;
                    const v = value(p.id, m);
                    return (
                      <td key={`${p.id}-${m}-${v}`} className="px-1 py-1">
                        <Input
                          aria-label={`${p.url} ${m}`}
                          className="h-8 w-20 px-1.5 text-right tabular"
                          inputMode="decimal"
                          defaultValue={v ? String(v) : ""}
                          onBlur={async (e) => {
                            const n = Number(e.target.value.replace(/[$,\s]/g, "") || 0);
                            if (!Number.isFinite(n) || n < 0) {
                              setMsg({ ok: false, text: "Type a dollar amount, e.g. 450" });
                              return;
                            }
                            if (n === v) return;
                            setMsg(null);
                            try {
                              await save.mutateAsync({ landingPageId: p.id, month: m, amount: n });
                              setMsg({ ok: true, text: "Saved." });
                            } catch (err) {
                              setMsg({ ok: false, text: errText(err) });
                            }
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
        <div className="mt-2">
          <Note msg={msg} />
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------ blocked posts ------------------------------ */

function BlockedCard() {
  const [open, setOpen] = React.useState(false);
  const q = useBlockedLeads(open);
  const release = useReleaseLead();
  const [msg, setMsg] = React.useState<Msg>(null);
  return (
    <Card>
      <CardHeader
        title="Blocked form posts"
        subtitle="Posts caught as spam make no job. If a real lead got caught, let it through and it becomes a job the normal way."
        action={
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"}
          </Button>
        }
      />
      {open ? (
        q.isLoading ? (
          <Loading />
        ) : !q.data?.rows.length ? (
          <Empty>Nothing blocked.</Empty>
        ) : (
          <div className="divide-y divide-border">
            {q.data.rows.map((r) => (
              <div key={r.id} className="flex flex-wrap items-start gap-3 px-4 py-2">
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    {r.name || "No name"} <span className="font-normal text-muted-foreground">{[r.phone, r.email].filter(Boolean).join(", ")}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.formKey}, {new Date(r.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })}. Why: {r.reason || "spam"}
                  </p>
                  {r.message ? <p className="mt-0.5 line-clamp-2 text-xs">{r.message}</p> : null}
                </div>
                {r.verdict === "released" ? (
                  <Badge colour="#15803D">Let through{r.jobId ? `, job made` : ""}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={release.isPending}
                    onClick={async () => {
                      setMsg(null);
                      try {
                        const out = await release.mutateAsync({ id: r.id });
                        setMsg({ ok: true, text: `Job ${out.jobNumber} made.` });
                      } catch (e) {
                        setMsg({ ok: false, text: errText(e) });
                      }
                    }}
                  >
                    Let through
                  </Button>
                )}
              </div>
            ))}
            <div className="px-4 py-2">
              <Note msg={msg} />
            </div>
          </div>
        )
      ) : null}
    </Card>
  );
}

/* ------------------------------ timber repairs ------------------------------ */

function TimberCard() {
  const q = useTimberSettings();
  const save = useSaveTimberSettings();
  const [markup, setMarkup] = React.useState("");
  const [minCharge, setMinCharge] = React.useState("");
  const [autoSend, setAutoSend] = React.useState("");
  const [templates, setTemplates] = React.useState<Record<string, string>>({});
  const [tryPrice, setTryPrice] = React.useState("350");
  const [msg, setMsg] = React.useState<Msg>(null);
  const s = q.data;
  const preview = useTimberPreview(Number(tryPrice) > 0 ? Number(tryPrice) : null);

  React.useEffect(() => {
    if (!s) return;
    setMarkup(String(s.markup));
    setMinCharge(s.minCharge ? String(s.minCharge) : "");
    setAutoSend(s.autoSendUnder ? String(s.autoSendUnder) : "");
    setTemplates(Object.fromEntries(s.templates.map((t) => [t.key, t.text])));
  }, [s]);

  if (q.isLoading) return <Loading />;
  if (!s) return null;

  return (
    <Card>
      <CardHeader
        title="Timber repairs"
        subtitle="Marc prices from the photos by text. The client price is his price times the markup, plus GST, to the nearest dollar. Every quote waits for your OK."
      />
      <form
        className="space-y-4 px-4 py-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          try {
            await save.mutateAsync({
              markup: Number(markup),
              minCharge: Number(minCharge || 0),
              autoSendUnder: Number(autoSend || 0),
              templates: s.templates.map((t) => ({ key: t.key as "scratches", text: templates[t.key] ?? t.text })),
            });
            setMsg({ ok: true, text: "Saved." });
          } catch (err) {
            setMsg({ ok: false, text: errText(err) });
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Timber repair markup" hint="Default 1.9">
            <Input id="timber_markup" inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} />
          </Field>
          <Field label="Minimum charge, ex GST" hint="Blank for no minimum">
            <Input id="timber_min" inputMode="decimal" value={minCharge} onChange={(e) => setMinCharge(e.target.value)} />
          </Field>
          <Field label="Auto send quotes under, incl GST" hint="Blank keeps it off. Every quote waits for you.">
            <Input id="timber_autosend" inputMode="decimal" value={autoSend} onChange={(e) => setAutoSend(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-md bg-secondary/60 px-3 py-2">
          <Field label="Try a price from Marc">
            <Input className="w-28" inputMode="decimal" value={tryPrice} onChange={(e) => setTryPrice(e.target.value)} />
          </Field>
          <p className="pb-2 text-sm">
            {preview.data ? (
              <>
                Client pays <strong>{moneyExact(preview.data.total)}</strong> incl GST (saved settings)
              </>
            ) : (
              <span className="text-muted-foreground">Type a price</span>
            )}
          </p>
        </div>

        {s.templates.map((t) => (
          <Field key={t.key} label={`Quote wording: ${t.label}`} hint="What is included, what is not, and how long it takes.">
            <Textarea
              id={`timber_tpl_${t.key}`}
              rows={5}
              value={templates[t.key] ?? ""}
              onChange={(e) => setTemplates((m) => ({ ...m, [t.key]: e.target.value }))}
            />
            {templates[t.key] !== t.defaultText ? (
              <button
                type="button"
                className="mt-1 text-xs text-[var(--gold-deep)] hover:underline"
                onClick={() => setTemplates((m) => ({ ...m, [t.key]: t.defaultText }))}
              >
                Put the starting wording back
              </button>
            ) : null}
          </Field>
        ))}
        <p className="text-xs text-muted-foreground">Every quote also says: "{s.photoSentence}"</p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : null} Save timber settings
          </Button>
          <Note msg={msg} />
        </div>
      </form>

      <div className="grid gap-3 border-t border-border px-4 py-3 text-sm sm:grid-cols-3">
        <div>
          <p className="label-xs">Who prices</p>
          <p>{s.pricer ? `${s.pricer.name}, ${s.pricer.mobile ?? "no mobile"}` : "Nobody with the Timber repair skill and a mobile yet"}</p>
          {s.skillId ? null : <p className="text-xs text-destructive">The Timber repair skill is missing or switched off.</p>}
        </div>
        <div>
          <p className="label-xs">SMS cost per lead</p>
          <p>
            {moneyExact(s.sms.perLead)} <span className="text-muted-foreground">({s.sms.texts} texts, {moneyExact(s.sms.cost)} over {s.sms.leads} leads)</span>
          </p>
        </div>
        <div>
          <p className="label-xs">What Marc gets</p>
          <p className="text-xs">{s.sample}</p>
        </div>
      </div>
    </Card>
  );
}
