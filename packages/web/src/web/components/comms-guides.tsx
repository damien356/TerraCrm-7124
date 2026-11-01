import * as React from "react";
import { BookOpen, RotateCcw, Send } from "lucide-react";
import { Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { errorText } from "./public-shell";
import { useCommsPanel, useGuideDrafts, useGuideRetry, useGuideSend } from "../queries/customer-comms";

/* ---------------------------------------------------------------------------
 * Care guides sent by hand (Damien, 31 Oct). Never automatic.
 *   1. Pick one person on the job and one or more guides. Indoor flooring and
 *      Exterior timber decking are separate groups.
 *   2. Preview: read and change each one. Sentences about an install are
 *      flagged on supply only jobs.
 *   3. Send: one email each. A guide already sent on this job needs "Send
 *      again" ticked. Each press of Send has its own key, so a double click
 *      sends once. A failure shows the reason and Retry.
 * ------------------------------------------------------------------------- */

type Panel = NonNullable<ReturnType<typeof useCommsPanel>["data"]>;
type Drafts = Awaited<ReturnType<ReturnType<typeof useGuideDrafts>["mutateAsync"]>>;
type Outcome = Awaited<ReturnType<ReturnType<typeof useGuideSend>["mutateAsync"]>>[number];

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`);

export function GuidePickerModal({ jobId, open, onClose, onSent }: { jobId: number; open: boolean; onClose: () => void; onSent?: (msg: string) => void }) {
  const panel = useCommsPanel(open ? jobId : null);
  const drafts = useGuideDrafts();
  const send = useGuideSend();
  const retry = useGuideRetry();
  const [contactId, setContactId] = React.useState<number | null>(null);
  const [codes, setCodes] = React.useState<string[]>([]);
  const [d, setD] = React.useState<Drafts | null>(null);
  const [edits, setEdits] = React.useState<Record<string, { subject: string; body: string }>>({});
  const [again, setAgain] = React.useState<string[]>([]);
  const [results, setResults] = React.useState<Outcome[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const key = React.useRef(newKey());

  React.useEffect(() => {
    if (!open) return;
    setContactId(null);
    setCodes([]);
    setD(null);
    setEdits({});
    setAgain([]);
    setResults(null);
    setError(null);
    key.current = newKey();
  }, [open]);

  if (!open) return null;
  const p = panel.data;
  const busy = drafts.isPending || send.isPending || retry.isPending;
  const person = p?.people.find((x) => x.contactId === contactId) ?? null;
  const groups = groupGuides(p);

  async function preview() {
    setError(null);
    setResults(null);
    if (!contactId) return setError("Pick who gets it. Nobody is picked for you.");
    if (!codes.length) return setError("Tick at least one guide.");
    try {
      const out = await drafts.mutateAsync({ jobId, contactId, codes });
      setD(out);
      setEdits(Object.fromEntries(out.drafts.map((x) => [x.code, { subject: x.subject, body: x.body }])));
      setAgain([]);
      key.current = newKey();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function go() {
    if (!d || !contactId) return;
    setError(null);
    try {
      const out = await send.mutateAsync({
        jobId,
        contactId,
        items: d.drafts.map((x) => ({ code: x.code, subject: edits[x.code]?.subject ?? x.subject, body: edits[x.code]?.body ?? x.body })),
        sendAgain: again,
        requestKey: key.current,
      });
      setResults(out);
      key.current = newKey();
      const sent = out.filter((r) => r.outcome === "sent").length;
      if (sent) onSent?.(`${sent} care guide${sent === 1 ? "" : "s"} sent to ${person?.name ?? "them"}. ${sent === 1 ? "It is" : "They are"} in the job's conversation.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function doRetry(id: number) {
    setError(null);
    try {
      const r = await retry.mutateAsync({ id });
      setResults((xs) => (xs ?? []).map((x) => (x.id === id ? r : x)));
    } catch (e) {
      setError(errorText(e));
    }
  }

  const needsAgain = d ? d.drafts.filter((x) => x.alreadySent && !again.includes(x.code)) : [];
  const confirm = d && person ? `Send ${d.drafts.length === 1 ? d.drafts[0]!.title : `${d.drafts.length} care guides`} to ${person.name} · ${person.mainRoleLabel} · ${d.to || "(no email)"}` : null;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title="Send care guides"
      subtitle="Sent by hand only. Nothing goes until you press Send. No automatic follow-up."
      width="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {results ? "Close" : "Cancel"}
          </Button>
          {!d ? (
            <Button onClick={preview} disabled={busy || !contactId || !codes.length} data-testid="guide-preview">
              {drafts.isPending ? <Spinner className="border-white/40 border-t-white" /> : <BookOpen className="size-4" />}
              Preview
            </Button>
          ) : results ? null : (
            <Button onClick={go} disabled={busy || !!d.block || needsAgain.length > 0 || !d.to} data-testid="guide-send">
              {send.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="size-4" />}
              Send
            </Button>
          )}
        </>
      }
    >
      <div className="grid min-w-0 grid-cols-1 gap-3 text-sm" data-testid="guide-picker">
        {!p ? <Spinner /> : null}
        {p && !d ? (
          <>
            <div>
              <p className="label-xs">Who gets it</p>
              <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                {p.people.map((x) => (
                  <li key={x.contactId} className="flex items-start gap-2 px-3 py-2">
                    <input
                      type="radio"
                      name="guide-to"
                      className="mt-1 size-4 accent-[var(--primary)]"
                      checked={contactId === x.contactId}
                      disabled={!!x.can.careGuide}
                      onChange={() => setContactId(x.contactId)}
                      aria-label={`Send to ${x.name}`}
                    />
                    <div className="min-w-0">
                      <p className="font-medium">
                        {x.name} <span className="font-normal text-muted-foreground">· {x.mainRoleLabel}</span>
                      </p>
                      <p className="break-all text-xs text-muted-foreground">{x.email || "No email"}</p>
                      {x.can.careGuide ? <p className="text-xs text-destructive">Can't get it: {x.can.careGuide}</p> : null}
                    </div>
                  </li>
                ))}
                {!p.people.length ? <li className="px-3 py-2 text-xs text-destructive">Nobody on this job yet. Add people on the job first.</li> : null}
              </ul>
            </div>
            {groups.map((g) => (
              <div key={g.name}>
                <p className="label-xs">{g.name}</p>
                {g.name === "Exterior timber decking" ? (
                  <p className="text-xs text-muted-foreground">General deck care only. Coating questions go to Terra Flooring. Can be ticked with indoor guides.</p>
                ) : null}
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {g.items.map((it) => {
                    const sent = p.guides.sent.find((s) => s.code === it.code && s.status === "sent");
                    return (
                      <label key={it.code} className="flex items-start gap-2">
                        <Checkbox className="mt-0.5" checked={codes.includes(it.code)} onChange={(e) => setCodes((c) => (e.target.checked ? [...c, it.code] : c.filter((x) => x !== it.code)))} />
                        <span>
                          {it.title}
                          {sent ? <span className="block text-xs text-muted-foreground">Sent before on this job</span> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </>
        ) : null}

        {d ? (
          <>
            {d.block ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">Can't send: {d.block}</p> : null}
            <p className="text-xs text-muted-foreground">To: {person ? `${person.name} · ${person.mainRoleLabel} · ${d.to || "no email"}` : d.to}. CC: none. BCC: none (not used).</p>
            {d.drafts.map((x) => {
              const e = edits[x.code] ?? { subject: x.subject, body: x.body };
              const still = x.flagged.filter((s) => e.body.includes(s));
              const r = results?.find((y) => y.code === x.code);
              return (
                <div key={x.code} className="grid gap-2 rounded-md border border-border p-3" data-testid={`guide-draft-${x.code}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium">{x.title}</p>
                    {r ? <Badge colour={r.outcome === "sent" ? "#2f7d4f" : r.outcome === "failed" ? "#b23b2c" : undefined}>{r.outcome === "sent" ? "Sent" : r.outcome === "failed" ? "Failed" : "Already sending"}</Badge> : null}
                  </div>
                  {x.alreadySent ? (
                    <label className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <Checkbox checked={again.includes(x.code)} disabled={!!results} onChange={(ev) => setAgain((a) => (ev.target.checked ? [...a, x.code] : a.filter((c) => c !== x.code)))} />
                      {x.alreadySent.text} Tick to send again.
                    </label>
                  ) : null}
                  {still.length ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                      <p className="font-medium">Talks about an install. This job had none, so change or remove:</p>
                      <ul className="mt-1 list-disc pl-5">
                        {still.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {results ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-primary">What it said</summary>
                      <p className="mt-1 font-medium">{e.subject}</p>
                      <p className="whitespace-pre-wrap text-muted-foreground">{e.body}</p>
                    </details>
                  ) : (
                    <>
                      <Field label="Subject">
                        <Input value={e.subject} maxLength={200} onChange={(ev) => setEdits((m) => ({ ...m, [x.code]: { ...e, subject: ev.target.value } }))} />
                      </Field>
                      <Field label="Message" hint="Plain text. The signature is already at the bottom.">
                        <Textarea rows={10} value={e.body} onChange={(ev) => setEdits((m) => ({ ...m, [x.code]: { ...e, body: ev.target.value } }))} />
                      </Field>
                    </>
                  )}
                  {r ? (
                    <p className={r.outcome === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                      {r.outcome === "sent" ? `Sent: the mail service accepted it. ${r.detail}` : r.detail}
                    </p>
                  ) : null}
                  {r?.outcome === "failed" && r.id ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => doRetry(r.id!)}>
                      <RotateCcw className="size-3.5" /> Retry
                    </Button>
                  ) : null}
                </div>
              );
            })}
            {confirm && !results ? (
              <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium" data-testid="confirm-line">
                {confirm}
              </p>
            ) : null}
            {!results ? (
              <Button size="sm" variant="ghost" onClick={() => setD(null)} disabled={busy}>
                Back to the list
              </Button>
            ) : null}
          </>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </Modal>
  );
}

function groupGuides(p: Panel | undefined) {
  const list = p?.guides.list ?? [];
  return (["Indoor flooring", "Exterior timber decking"] as const)
    .map((name) => ({ name, items: list.filter((g) => g.group === name) }))
    .filter((g) => g.items.length);
}

/** The button used on the job's delivery card and the comms card. */
export function GuideButton({ jobId, onSent, label = "Send care guides" }: { jobId: number; onSent?: (msg: string) => void; label?: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="care-guide">
        <BookOpen className="size-3.5" />
        {label}
      </Button>
      <GuidePickerModal jobId={jobId} open={open} onClose={() => setOpen(false)} onSent={onSent} />
    </>
  );
}
