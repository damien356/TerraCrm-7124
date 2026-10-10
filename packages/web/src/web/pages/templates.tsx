import * as React from "react";
import { AlertTriangle, Eye, Mail, Plus, Send, Trash2 } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useCreateTemplate,
  useDeleteTemplate,
  useSendTestTemplate,
  useTemplate,
  useTemplatePreview,
  useTemplates,
  useUpdateTemplate,
} from "../queries/templates";

/**
 * Email templates — the words Terra sends.
 *
 * Plain text with `{{merge_fields}}` on purpose. A review request that reads
 * like Damien typed it gets replies; one that looks like a newsletter lands in
 * the promotions tab. The preview renders through the same function the real
 * send uses, so what is approved here is what the homeowner receives.
 */

const STARTERS: { name: string; subject: string; body: string }[] = [
  {
    name: "Review request",
    subject: "How did we go, {{first_name}}?",
    body: `Hi {{first_name}},

Now the dust has settled on the new floor in {{suburb}}, how are you finding it?

If you're happy with it, a quick Google review makes a real difference to a small local business like ours. It takes about a minute:

[review link]

And if anything isn't right, reply to this email and I'll sort it out.

Thanks,
Damien
Terra Flooring`,
  },
  {
    name: "Quote follow-up, first nudge",
    subject: "Your flooring quote, {{first_name}}",
    body: `Hi {{first_name}},

Just checking you got the quote I sent through for {{suburb}}.

Happy to walk you through it, tweak the spec, or look at a different product if the number isn't where you hoped. Just reply or give me a call.

Thanks,
Damien
Terra Flooring`,
  },
  {
    name: "Quote follow-up, last nudge",
    subject: "Still thinking it over?",
    body: `Hi {{first_name}},

I won't keep chasing. Just wanted to leave the door open on your flooring quote.

If the timing isn't right, no problem at all. And if you'd like me to take another look at it, reply any time and I'll pick it straight up.

Thanks,
Damien
Terra Flooring`,
  },
];

const BLANK = { name: "", subject: "", body: "", useWrapper: true, active: true };

type Draft = { name: string; subject: string; body: string; useWrapper: boolean; active: boolean };

/** Debounce, so the preview isn't refetched on every keystroke. */
function useDebounced<T>(value: T, ms = 400) {
  const [held, setHeld] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}

export default function TemplatesPage() {
  const list = useTemplates(true);
  const [editingId, setEditingId] = React.useState<number | null>(null);
  const [creating, setCreating] = React.useState(false);

  return (
    <Page
      title="Email templates"
      subtitle="The words Terra sends. Journeys point at these, so editing one changes what goes out tomorrow."
      actions={
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New template
        </Button>
      }
    >
      <Card>
        <CardHeader
          title="Templates"
          subtitle={
            list.data
              ? `${list.data.length} template${list.data.length === 1 ? "" : "s"}`
              : undefined
          }
        />
        {list.isPending ? (
          <Loading label="Loading templates…" />
        ) : !list.data?.length ? (
          <Empty>
            No templates yet. Start from one of Terra's, or write your own.
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {STARTERS.map((s) => (
                <StarterButton key={s.name} starter={s} />
              ))}
            </div>
          </Empty>
        ) : (
          <div className="divide-y divide-border">
            {list.data.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setEditingId(t.id)}
                className="flex w-full items-start justify-between gap-4 px-4 py-3 text-left hover:bg-accent/50"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Mail className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{t.name}</span>
                    {!t.active ? <Badge>inactive</Badge> : null}
                    {t.usedByStepCount > 0 ? (
                      <Badge colour="#BC9558">
                        in {t.usedByStepCount} step{t.usedByStepCount === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 truncate pl-6 text-xs text-muted-foreground">
                    {t.subject || "No subject line"}
                  </p>
                </div>
                <span className="shrink-0 pt-1 text-xs text-muted-foreground">
                  {new Date(t.updatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {list.data?.length ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Starters:{" "}
          {STARTERS.map((s, i) => (
            <React.Fragment key={s.name}>
              {i > 0 ? " · " : ""}
              <StarterButton starter={s} inline />
            </React.Fragment>
          ))}
        </p>
      ) : null}

      {creating ? <Editor onClose={() => setCreating(false)} /> : null}
      {editingId !== null ? (
        <Editor id={editingId} onClose={() => setEditingId(null)} />
      ) : null}
    </Page>
  );
}

/** Drops one of Terra's starting points straight in as a new template. */
function StarterButton({
  starter,
  inline,
}: {
  starter: { name: string; subject: string; body: string };
  inline?: boolean;
}) {
  const create = useCreateTemplate();
  const onClick = () =>
    create.mutate({ ...starter, useWrapper: true, active: true });

  if (inline) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={create.isPending}
        className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
      >
        add "{starter.name}"
      </button>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={onClick} disabled={create.isPending}>
      <Plus className="size-3.5" />
      {starter.name}
    </Button>
  );
}

function Editor({ id, onClose }: { id?: number; onClose: () => void }) {
  const loaded = useTemplate(id ?? null);
  const create = useCreateTemplate();
  const update = useUpdateTemplate();
  const remove = useDeleteTemplate();
  const sendTest = useSendTestTemplate();

  const [draft, setDraft] = React.useState<Draft>(BLANK);
  const [ready, setReady] = React.useState(id === undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [testedTo, setTestedTo] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  /* Fill the form once the record arrives, and not again on every refetch. */
  React.useEffect(() => {
    if (id === undefined || ready || !loaded.data) return;
    const t = loaded.data.template;
    setDraft({
      name: t.name,
      subject: t.subject,
      body: t.body,
      useWrapper: t.useWrapper,
      active: t.active,
    });
    setReady(true);
  }, [id, ready, loaded.data]);

  const debounced = useDebounced(draft);
  const preview = useTemplatePreview({
    subject: debounced.subject,
    body: debounced.body,
    useWrapper: debounced.useWrapper,
    enabled: ready,
  });

  const mergeFields = loaded.data?.mergeFields ?? FALLBACK_FIELDS;
  const usedBy = loaded.data?.usedBy ?? [];
  const liveUses = usedBy.filter((u) => u.journeyStatus === "active");

  /** Drops a merge field in at the cursor, not at the end. */
  const insertField = (key: string) => {
    const el = bodyRef.current;
    const token = `{{${key}}}`;
    if (!el) {
      setDraft((d) => ({ ...d, body: d.body + token }));
      return;
    }
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? start;
    const next = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft((d) => ({ ...d, body: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    setError(null);
    if (!draft.name.trim()) {
      setError("Give the template a name.");
      return;
    }
    try {
      if (id === undefined) await create.mutateAsync(draft);
      else await update.mutateAsync({ id, ...draft });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that.");
    }
  };

  const test = async () => {
    setError(null);
    setTestedTo(null);
    try {
      const out = await sendTest.mutateAsync({
        subject: draft.subject,
        body: draft.body,
        useWrapper: draft.useWrapper,
      });
      setTestedTo(out.sentTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the test.");
    }
  };

  const del = async () => {
    setError(null);
    if (id === undefined) return;
    try {
      const out = await remove.mutateAsync({ id });
      if (out.deactivated) {
        setError("A journey step still points at this, so it was switched off rather than deleted.");
        return;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete that.");
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-5xl"
      title={id === undefined ? "New template" : draft.name || "Template"}
      subtitle="The preview on the right is rendered by the same code that sends the real email."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {id !== undefined ? (
              <Button variant="ghost" size="sm" onClick={del} disabled={remove.isPending}>
                <Trash2 className="size-4" />
                Delete
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={test} disabled={sendTest.isPending}>
              <Send className="size-4" />
              {sendTest.isPending ? "Sending…" : "Send test to me"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      {id !== undefined && !ready ? (
        <Loading label="Loading template…" />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ---- Left: the words ---- */}
          <div className="space-y-4">
            <Field label="Name" hint="Internal only. The homeowner never sees this.">
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Review request"
              />
            </Field>

            <Field label="Subject">
              <Input
                value={draft.subject}
                onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
                placeholder="How did we go, {{first_name}}?"
              />
            </Field>

            <Field label="Body" hint="Blank line between paragraphs. Write it like an email, not a brochure.">
              <Textarea
                ref={bodyRef}
                rows={16}
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                placeholder={"Hi {{first_name}},\n\n…"}
                className="font-mono text-[13px]"
              />
            </Field>

            <div>
              <p className="label-xs mb-1.5">Insert a merge field</p>
              <div className="flex flex-wrap gap-1.5">
                {mergeFields.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => insertField(f.key)}
                    title={`e.g. ${f.sample}`}
                    className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] hover:bg-accent"
                  >
                    {`{{${f.key}}}`}
                  </button>
                ))}
              </div>
            </div>

            <label htmlFor="template-use-wrapper" className="flex items-start gap-2 text-sm">
              <Checkbox
                id="template-use-wrapper"
                checked={draft.useWrapper}
                onChange={(e) => setDraft((d) => ({ ...d, useWrapper: e.target.checked }))}
              />
              <span>
                Terra letterhead and unsubscribe footer
                <span className="block text-xs text-muted-foreground">
                  Leave this on for anything marketing. Off is for a plain reply only.
                </span>
              </span>
            </label>

            <label htmlFor="template-active" className="flex items-center gap-2 text-sm">
              <Checkbox
                id="template-active"
                checked={draft.active}
                onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
              />
              <span>Active</span>
            </label>

            {liveUses.length ? (
              <div className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/35 bg-[var(--warning)]/8 px-3 py-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                <span>
                  This is live in{" "}
                  <strong>{liveUses.map((u) => u.journeyName).join(", ")}</strong>. Saving changes what
                  goes out on the next send.
                </span>
              </div>
            ) : null}
          </div>

          {/* ---- Right: what actually arrives ---- */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Eye className="size-4 text-muted-foreground" />
              <p className="label-xs">
                Preview{preview.data ? ` · ${preview.data.renderedAgainst}` : ""}
              </p>
            </div>

            {preview.data?.warnings.length ? (
              <div className="space-y-1.5">
                {preview.data.warnings.map((w) => (
                  <div
                    key={w}
                    className="flex items-start gap-2 rounded-lg border border-border bg-secondary/60 px-3 py-2 text-xs text-muted-foreground"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="overflow-hidden rounded-lg border border-border">
              <div className="border-b border-border bg-secondary/60 px-3 py-2">
                <p className="text-[11px] text-muted-foreground">Subject</p>
                <p className="truncate text-sm font-medium">
                  {preview.data?.subject || <span className="text-muted-foreground">-</span>}
                </p>
              </div>
              {preview.isPending ? (
                <Loading label="Rendering…" />
              ) : (
                <iframe
                  title="Email preview"
                  className="h-[520px] w-full bg-white"
                  /* Sandboxed with no allow-* flags: the preview must not be
                   * able to run script or navigate the office out of the app. */
                  sandbox=""
                  srcDoc={preview.data?.html ?? ""}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {testedTo ? (
        <p className="mt-4 rounded-lg border border-[var(--success)]/35 bg-[var(--success)]/8 px-3 py-2 text-xs">
          Test sent to {testedTo}.
        </p>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** Used until the record loads, so the buttons never flash empty. */
const FALLBACK_FIELDS = [
  { key: "first_name", label: "First name", sample: "Sarah" },
  { key: "last_name", label: "Last name", sample: "Mitchell" },
  { key: "full_name", label: "Full name", sample: "Sarah Mitchell" },
  { key: "suburb", label: "Suburb", sample: "Mermaid Waters" },
  { key: "job_number", label: "Job number", sample: "1042" },
  { key: "product", label: "Product", sample: "Terramater Oak" },
] as const;
