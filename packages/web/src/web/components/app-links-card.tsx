import * as React from "react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { errorText } from "./public-shell";
import { useAppLinksAdmin, useSaveAppLinks } from "../queries/invites";

/**
 * Settings, Staff app (notes 18.55). Where the download link in every staff
 * invite goes. The invite always says ops.terraflooring.com.au/app, and that
 * page sends an iPhone to the first link and an Android phone to the second.
 * Change them here any time without resending anything.
 */
export function AppLinksCard() {
  const q = useAppLinksAdmin();
  const save = useSaveAppLinks();
  const [form, setForm] = React.useState<{ ios: string; android: string } | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  React.useEffect(() => {
    if (q.data && !form) setForm({ ios: q.data.ios, android: q.data.android });
  }, [q.data, form]);

  if (q.error) return <Card className="p-4 text-sm text-destructive">{errorText(q.error)}</Card>;
  if (q.isLoading || !form || !q.data) return <Loading />;

  async function submit() {
    if (!form) return;
    setMsg(null);
    try {
      const r = await save.mutateAsync({ ios: form.ios, android: form.android });
      setForm({ ios: r.ios, android: r.android });
      setMsg({ ok: true, text: "Saved. The download page uses these straight away." });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="Staff app download links"
        subtitle="Every staff invite has one download link. It opens the right one of these for the phone it is tapped on."
      />
      <div className="grid gap-4 px-4 pb-4">
        <p className="text-sm text-muted-foreground">
          The link in the invite is{" "}
          <a href={q.data.downloadUrl} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
            {q.data.downloadUrl}
          </a>
          . On a computer it shows both links. Leave one empty and that phone is told to call the office.
        </p>
        <Field label="iPhone link" hint="For example your TestFlight public link, or the App Store link once the app is out.">
          <Input
            value={form.ios}
            onChange={(e) => setForm({ ...form, ios: e.target.value })}
            placeholder="https://testflight.apple.com/join/..."
            aria-label="iPhone link"
          />
        </Field>
        <Field label="Android link" hint="For example your Google Play testing link.">
          <Input
            value={form.android}
            onChange={(e) => setForm({ ...form, android: e.target.value })}
            placeholder="https://play.google.com/apps/testing/..."
            aria-label="Android link"
          />
        </Field>
        {msg ? <p className={msg.ok ? "text-sm text-emerald-700" : "text-sm text-destructive"}>{msg.text}</p> : null}
        <div>
          <Button onClick={submit} disabled={save.isPending}>
            Save links
          </Button>
        </div>
      </div>
    </Card>
  );
}
