import * as React from "react";
import { Link } from "wouter";
import { Card, CardHeader, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { errorText } from "./public-shell";
import { usePrepSettings, useSavePrepSettings } from "../queries/prep";
import { useBootstrap } from "../queries/settings";
import {
  PREP_DEFAULTS,
  PREP_TEMPLATE_LABELS,
  renderDaySms,
  renderInstallEmail,
  renderOmwSms,
  type PrepTemplates,
} from "../../api/lib/prep-templates";

/* Settings, Client prep (notes 18.56): on or off, the arrival window, the send time, and every word. */

type Form = { on: boolean; windowStart: string; windowEnd: string; sendHour: number; templates: PrepTemplates };

const HOURS = Array.from({ length: 13 }, (_, i) => i + 6);
const hourLabel = (h: number) => (h === 12 ? "12pm" : h > 12 ? `${h - 12}pm` : `${h}am`);

export function PrepSettingsCard() {
  const q = usePrepSettings();
  const save = useSavePrepSettings();
  const boot = useBootstrap();
  const isAdmin = boot.data?.actor.role === "admin";
  const [form, setForm] = React.useState<Form | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [sample, setSample] = React.useState({ unit: false, furniture: true, window: true });

  React.useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  if (q.isLoading || !form) return <Loading />;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const setT = (k: keyof PrepTemplates, v: string) => setForm({ ...form, templates: { ...form.templates, [k]: v } });

  const day = (() => {
    const d = new Date(Date.now() + 3 * 86_400_000);
    return d.toISOString().slice(0, 10);
  })();
  const facts = {
    firstName: "Sam",
    date: day,
    window: sample.window ? { start: form.windowStart, end: form.windowEnd } : null,
    furnitureMoving: sample.furniture,
    unit: sample.unit,
  };
  const email = renderInstallEmail(form.templates, facts);
  const sms = renderDaySms(form.templates, facts);
  const omw = renderOmwSms(form.templates, { firstName: "Sam", installerFirstName: "Marc" });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <Card>
        <CardHeader
          title="Client prep messages"
          subtitle="The install email 3 days before the first day, a text the day before each day, and On my way. Builder and insurance jobs are off unless switched on on the job."
        />
        <div className="grid gap-4 px-4 py-3">
          <label htmlFor="prep_on" className="flex items-center gap-2 text-sm">
            <Checkbox id="prep_on" checked={form.on} disabled={!isAdmin} onChange={(e) => set({ on: e.target.checked })} />
            Send client prep messages
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Arrival window from" hint="When a day has no window of its own.">
              <Input type="time" value={form.windowStart} disabled={!isAdmin} onChange={(e) => set({ windowStart: e.target.value })} />
            </Field>
            <Field label="Arrival window to">
              <Input type="time" value={form.windowEnd} disabled={!isAdmin} onChange={(e) => set({ windowEnd: e.target.value })} />
            </Field>
            <Field label="Send from" hint="Gold Coast time. Nothing goes after 7pm.">
              <Select value={form.sendHour} disabled={!isAdmin} onChange={(e) => set({ sendHour: Number(e.target.value) })}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Words in square brackets fill in by themselves: [first name], [day, date], [arrival], [window], [furniture], [unit section], [unit line],
            [installer first name].
          </p>
          {PREP_TEMPLATE_LABELS.map(([key, label, long]) => (
            <Field key={key} label={label}>
              {long ? (
                <Textarea rows={key === "emailBody" ? 16 : key === "emailUnitSection" ? 8 : 3} value={form.templates[key]} disabled={!isAdmin} onChange={(e) => setT(key, e.target.value)} />
              ) : (
                <Input value={form.templates[key]} disabled={!isAdmin} onChange={(e) => setT(key, e.target.value)} />
              )}
              {form.templates[key] !== PREP_DEFAULTS[key] && isAdmin ? (
                <button type="button" className="mt-1 text-xs text-primary hover:underline" onClick={() => setT(key, PREP_DEFAULTS[key])}>
                  Back to the standard wording
                </button>
              ) : null}
            </Field>
          ))}
          {msg ? <p className={msg.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{msg.text}</p> : null}
          {isAdmin ? (
            <div>
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(form, {
                    onSuccess: (s) => {
                      setForm(s);
                      setMsg({ ok: true, text: "Saved." });
                    },
                    onError: (e) => setMsg({ ok: false, text: errorText(e) }),
                  })
                }
              >
                Save
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Only an Admin can change these.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Jobs with an install booked that still need an answer: <Link href="/prep-to-fill" className="text-primary hover:underline">Property type / furniture to fill</Link>.
          </p>
        </div>
      </Card>

      <Card className="h-fit">
        <CardHeader title="How it reads" subtitle="A made-up client, 3 days from today." />
        <div className="grid gap-3 px-4 py-3 text-xs">
          <div className="flex flex-wrap gap-3">
            <label htmlFor="s_unit" className="flex items-center gap-1.5">
              <Checkbox id="s_unit" checked={sample.unit} onChange={(e) => setSample({ ...sample, unit: e.target.checked })} /> Unit or apartment
            </label>
            <label htmlFor="s_furn" className="flex items-center gap-1.5">
              <Checkbox id="s_furn" checked={sample.furniture} onChange={(e) => setSample({ ...sample, furniture: e.target.checked })} /> We move furniture
            </label>
            <label htmlFor="s_win" className="flex items-center gap-1.5">
              <Checkbox id="s_win" checked={sample.window} onChange={(e) => setSample({ ...sample, window: e.target.checked })} /> Day has a window
            </label>
          </div>
          <div>
            <p className="label-xs">Install email</p>
            <p className="mt-1 font-medium">{email.subject}</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{email.body}</p>
          </div>
          <div>
            <p className="label-xs">Day before text ({sms.length} characters)</p>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{sms}</p>
          </div>
          <div>
            <p className="label-xs">On my way text</p>
            <p className="mt-1 text-muted-foreground">{omw}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
