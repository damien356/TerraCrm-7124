import * as React from "react";
import { Pencil, Plus } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox, Field, Textarea } from "../ui/field";
import { Modal } from "../ui/modal";
import { useArchiveSiteCheck, useSaveSiteCheck, useSwmsChanges } from "../../queries/swms-lib";
import { AMBER, ErrorLine, RUST, type Overview, type SiteCheck } from "./shared";
import { ChangeList } from "./templates";

const ANSWERS = [
  ["yes", "Yes"],
  ["no", "No"],
  ["unsure", "Unsure"],
  ["na", "N/A"],
] as const;
type Answer = (typeof ANSWERS)[number][0];
const label = (a: string) => ANSWERS.find(([k]) => k === a)?.[1] ?? a;

export function SiteChecksTab({ data }: { data: Overview }) {
  const [edit, setEdit] = React.useState<SiteCheck | "new" | null>(null);
  const archive = useArchiveSiteCheck();
  const [showArchived, setShowArchived] = React.useState(false);
  const nameOf = (k: string) => data.templates.find((t) => t.key === k)?.name ?? k;
  const list = data.siteChecks.filter((c) => showArchived || !c.archived);
  return (
    <Card>
      <CardHeader
        title="Site checks"
        subtitle="Questions the crew answers on site before they start. Crew sees these from Stage 3, along with the red job card and the email to team@."
        action={
          <Button size="sm" onClick={() => setEdit("new")}>
            <Plus className="size-3.5" /> New check
          </Button>
        }
      />
      <div className="border-b border-border px-4 py-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" aria-label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      {list.length === 0 ? (
        <Empty>No site checks.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {c.question} {c.archived ? <Badge>Archived</Badge> : null}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{c.answers.map(label).join(", ")}</span>
                  {c.flagOn.length ? (
                    <Badge colour={c.blocks ? RUST : AMBER}>
                      {c.flagOn.map(label).join(" or ")} {c.blocks ? "stops the job" : "flags the job"}
                    </Badge>
                  ) : null}
                  <span>{c.appliesAll ? "Every SWMS" : `Only on ${c.templateKeys.map(nameOf).join(", ")}`}</span>
                </p>
              </div>
              <div className="flex gap-1.5">
                {c.archived ? (
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: c.id, archived: false })}>
                    Restore
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEdit(c)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: c.id, archived: true })}>
                      Archive
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit ? <CheckEditor data={data} c={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

function CheckEditor({ data, c, onClose }: { data: Overview; c: SiteCheck | null; onClose: () => void }) {
  const save = useSaveSiteCheck();
  const [question, setQuestion] = React.useState(c?.question ?? "");
  const [answers, setAnswers] = React.useState<Answer[]>((c?.answers as Answer[]) ?? ["yes", "no", "unsure"]);
  const [flagOn, setFlagOn] = React.useState<Answer[]>((c?.flagOn as Answer[]) ?? ["no", "unsure"]);
  const [blocks, setBlocks] = React.useState(c?.blocks ?? false);
  const [appliesAll, setAppliesAll] = React.useState(c?.appliesAll ?? true);
  const [keys, setKeys] = React.useState<string[]>(c?.templateKeys ?? []);
  const templates = data.templates.filter((t) => !t.archived && !t.everyJob);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function go() {
    await save.mutateAsync({
      id: c?.id ?? null,
      question,
      answers,
      flagOn: flagOn.filter((f) => answers.includes(f)),
      blocks,
      appliesAll,
      templateKeys: appliesAll ? [] : keys,
    });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={c ? "Edit site check" : "New site check"}>
      <div className="grid gap-3">
        <Field label="Question">
          <Textarea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Is the slab dry enough to lay on?" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Answers">
            <div className="grid gap-1">
              {ANSWERS.map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={answers.includes(k)} onChange={() => setAnswers(toggle(answers, k))} /> {l}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Flags the job when the answer is">
            <div className="grid gap-1">
              {ANSWERS.filter(([k]) => answers.includes(k)).map(([k, l]) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={flagOn.includes(k)} onChange={() => setFlagOn(toggle(flagOn, k))} /> {l}
                </label>
              ))}
            </div>
          </Field>
        </div>
        <label htmlFor="check-blocks" className="flex items-start gap-2 text-sm">
          <Checkbox id="check-blocks" checked={blocks} onChange={(e) => setBlocks(e.target.checked)} />
          <span>
            Stop the job, not just flag it
            <span className="block text-xs text-muted-foreground">Crew can't start until Office clears it.</span>
          </span>
        </label>
        <div className="grid gap-1.5">
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" aria-label="Every SWMS" checked={appliesAll} onChange={() => setAppliesAll(true)} /> Every SWMS
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" aria-label="Only on some templates" checked={!appliesAll} onChange={() => setAppliesAll(false)} /> Only on some templates
          </label>
          {!appliesAll ? (
            <div className="ml-6 flex flex-wrap gap-1.5">
              {templates.map((t) => {
                const on = keys.includes(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setKeys(toggle(keys, t.key))}
                    className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <ErrorLine error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || question.trim().length < 5 || answers.length < 2} onClick={() => void go().catch(() => {})}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ChangeLogTab() {
  const q = useSwmsChanges({ limit: 300 });
  return (
    <Card>
      <CardHeader title="Change log" subtitle="Who changed what in the SWMS library, newest first." />
      <div className="p-4">{q.isLoading ? <Loading /> : <ChangeList rows={q.data ?? []} />}</div>
    </Card>
  );
}
