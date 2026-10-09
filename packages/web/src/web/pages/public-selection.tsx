import * as React from "react";
import { useParams } from "wouter";
import { Check, Plus, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Field, Input, Textarea } from "../components/ui/field";
import { Spinner } from "../components/ui/card";
import { PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { usePublicSelection, useSubmitSelection } from "../queries/publicPages";

/**
 * /m/<token>: the material selection form, sent after a quote is accepted.
 * Per room: product, colour, notes. No login. Kept simple on purpose.
 */

type Row = { areaId: number | null; room: string; product: string; colour: string; notes: string };

const blank = (): Row => ({ areaId: null, room: "", product: "", colour: "", notes: "" });

export default function PublicSelectionPage() {
  const { token = "" } = useParams<{ token: string }>();
  const sel = usePublicSelection(token);
  const submit = useSubmitSelection();
  const [rows, setRows] = React.useState<Row[] | null>(null);
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  React.useEffect(() => {
    if (!sel.data || rows) return;
    setRows(sel.data.items.length ? sel.data.items.map((i) => ({ ...i, areaId: i.areaId ?? null })) : [blank()]);
    if (sel.data.submittedName) setName(sel.data.submittedName);
  }, [sel.data, rows]);

  if (sel.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }
  if (sel.error || !sel.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open this form">{errorText(sel.error ?? "This link is not valid.")}</PublicMessage>
      </PublicShell>
    );
  }
  const d = sel.data;
  if (d.superseded) {
    return (
      <PublicShell>
        <PublicMessage title="This form has been replaced">We sent you a newer one. Open the newest email from us.</PublicMessage>
      </PublicShell>
    );
  }
  if (sent) {
    return (
      <PublicShell>
        <PublicMessage title="Thank you, we have your choices">
          We will check them against your quote and call you if anything needs a second look. You can open this link again to make changes
          before we order.
        </PublicMessage>
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setSent(false)}>
            Change my choices
          </Button>
        </div>
      </PublicShell>
    );
  }

  const list = rows ?? [];
  const set = (i: number, patch: Partial<Row>) => setRows(list.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  async function onSubmit() {
    setError(null);
    if (name.trim().length < 2) return setError("Type your name so we know who chose.");
    const filled = list.filter((r) => r.room.trim() || r.product.trim() || r.colour.trim() || r.notes.trim());
    if (!filled.length) return setError("Fill in at least one room.");
    try {
      await submit.mutateAsync({ token, name: name.trim(), items: filled });
      setSent(true);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <PublicShell>
      <PublicCard>
        <p className="label-xs">Job {d.jobRef}</p>
        <h1 className="text-2xl font-bold tracking-[-0.015em]">Choose your flooring</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {d.firstName ? `Hi ${d.firstName}. ` : ""}Tell us the product and colour you want in each room
          {d.siteAddress ? ` at ${d.siteAddress}` : ""}. Not sure yet? Fill in what you know and add a note. We will call you about the rest.
        </p>
        {d.status === "submitted" && d.submittedAt ? (
          <p className="mt-3 rounded-md bg-[#3F7D3A]/10 px-3 py-2 text-sm text-[#2E6B4F]">
            {d.submittedName || "You"} sent this on {new Date(d.submittedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long" })}. You can
            still change it below.
          </p>
        ) : null}
      </PublicCard>

      {list.map((r, i) => (
        <PublicCard key={i}>
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <Field label="Room" className="flex-1">
                <Input value={r.room} onChange={(e) => set(i, { room: e.target.value })} placeholder="e.g. Living and dining" />
              </Field>
              {list.length > 1 ? (
                <Button variant="ghost" size="icon" aria-label="Remove room" onClick={() => setRows(list.filter((_, n) => n !== i))}>
                  <Trash2 className="size-4" />
                </Button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Product">
                <Input value={r.product} onChange={(e) => set(i, { product: e.target.value })} placeholder="e.g. Sunstar Hybrid" />
              </Field>
              <Field label="Colour">
                <Input value={r.colour} onChange={(e) => set(i, { colour: e.target.value })} placeholder="e.g. Coastal Oak" />
              </Field>
            </div>
            <Field label="Notes">
              <Textarea rows={2} value={r.notes} onChange={(e) => set(i, { notes: e.target.value })} placeholder="Anything we should know" />
            </Field>
          </div>
        </PublicCard>
      ))}

      <div className="mb-4">
        <Button variant="outline" onClick={() => setRows([...list, blank()])} disabled={list.length >= 60}>
          <Plus className="size-4" />
          Add a room
        </Button>
      </div>

      <PublicCard>
        <div className="flex flex-col gap-3">
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <Button size="lg" onClick={onSubmit} disabled={submit.isPending} className="w-full sm:w-auto sm:self-end">
            {submit.isPending ? <Spinner /> : <Check className="size-4" />}
            Send my choices
          </Button>
        </div>
      </PublicCard>
    </PublicShell>
  );
}
