import * as React from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Copy, Eye, FileText, GripVertical, History, Pencil, Plus, Send, X } from "lucide-react";
import { Card, CardHeader, Empty, Loading } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/field";
import { Modal } from "../ui/modal";
import {
  useArchiveTemplate,
  useDuplicateTemplate,
  usePreviewPdf,
  usePublishTemplate,
  useSaveTemplate,
  useSwmsChanges,
  useSwmsPreview,
  useSwmsVersions,
} from "../../queries/swms-lib";
import {
  AMBER,
  ErrorLine,
  RUST,
  RiskPill,
  StatusBadge,
  WordList,
  fmtDate,
  fmtDateTime,
  openPdf,
  todayBrisbane,
  type Overview,
  type Template,
} from "./shared";

export function TemplatesTab({ data }: { data: Overview }) {
  const [edit, setEdit] = React.useState<Template | "new" | null>(null);
  const [publish, setPublish] = React.useState<Template | null>(null);
  const [preview, setPreview] = React.useState<Template | null>(null);
  const [history, setHistory] = React.useState<Template | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const dup = useDuplicateTemplate();
  const archive = useArchiveTemplate();

  const live = data.templates.filter((t) => !t.archived && t.status !== "draft");
  const drafts = data.templates.filter((t) => !t.archived && t.status === "draft");
  const archived = data.templates.filter((t) => t.archived);
  const nameOf = (k: string) => data.templates.find((t) => t.key === k)?.name ?? k;

  const row = (t: Template) => (
    <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {t.name} <StatusBadge t={t} />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t.everyJob
            ? "On every SWMS, whatever the work."
            : t.matchTerms.length || t.categoryTerms.length
              ? `Brought in by labour named: ${t.matchTerms.join(", ") || "nothing"}${t.categoryTerms.length ? `. Job category, when no labour matches: ${t.categoryTerms.join(", ")}` : ""}`
              : "No matching words. Only on jobs where Office adds it."}
          {t.alsoAdds.length ? `. Always brings in ${t.alsoAdds.map(nameOf).join(", ")}` : ""}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t.blockIds.length} task block{t.blockIds.length === 1 ? "" : "s"}
          {t.latest ? `. v${t.latest.version} published ${fmtDate(t.latest.publishedAt)} by ${t.latest.publishedByName || "System"}` : ""}
          {t.latest?.reviewedByName ? `, reviewed by ${t.latest.reviewedByName}` : ""}
        </p>
        {t.status === "draft" && t.replacesKey && !t.archived ? (
          <p className="mt-0.5 text-xs" style={{ color: AMBER }}>
            Publishing it takes over from {nameOf(t.replacesKey)}.
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {t.archived ? (
          <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: t.id, archived: false })}>
            Restore
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setPreview(t)}>
              <Eye className="size-3.5" /> Preview
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEdit(t)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            {t.status !== "published" ? (
              <Button size="sm" onClick={() => setPublish(t)}>
                <Send className="size-3.5" /> Publish
              </Button>
            ) : null}
          </>
        )}
        <Button size="sm" variant="ghost" aria-label="History" onClick={() => setHistory(t)}>
          <History className="size-3.5" />
        </Button>
        <Button size="sm" variant="ghost" aria-label="Duplicate" disabled={dup.isPending} onClick={() => dup.mutate({ id: t.id })}>
          <Copy className="size-3.5" />
        </Button>
        {!t.archived && !t.everyJob ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (confirm(`Archive ${t.name}? Crew stops getting it. Signed SWMS are unchanged.`)) archive.mutate({ id: t.id, archived: true });
            }}
          >
            Archive
          </Button>
        ) : null}
      </div>
    </li>
  );

  return (
    <div className="grid gap-4">
      {data.warnings.length ? (
        <Card>
          <CardHeader title="Needs attention" subtitle="Live templates that rely on a product with no current SDS, or one past its review date." />
          <ul className="divide-y divide-border">
            {data.warnings.map((w) => (
              <li key={`${w.kind}-${w.code}`} className="flex items-start gap-2 px-4 py-2.5 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" style={{ color: w.kind === "expired_sds" ? AMBER : RUST }} />
                <span>
                  <span className="font-medium">{w.product}</span>{" "}
                  {w.kind === "missing_sds" ? "has no SDS on file." : `SDS was due for review on ${w.reviewOn}.`}{" "}
                  <span className="text-muted-foreground">Used by {w.templates.join(", ")}.</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Live templates"
          subtitle="What Crew gets. Edits stay a draft until you publish, then Crew gets the new version on their next SWMS."
          action={
            <Button size="sm" onClick={() => setEdit("new")}>
              <Plus className="size-3.5" /> New template
            </Button>
          }
        />
        {live.length ? <ul className="divide-y divide-border">{live.map(row)}</ul> : <Empty>Nothing published yet.</Empty>}
      </Card>

      <Card>
        <CardHeader title="Drafts" subtitle="Not published yet. Crew can't see these." />
        {drafts.length ? <ul className="divide-y divide-border">{drafts.map(row)}</ul> : <Empty>No drafts.</Empty>}
      </Card>

      {archived.length ? (
        <Card>
          <CardHeader
            title={`Archived (${archived.length})`}
            subtitle="Kept for the record. Signed SWMS still show them."
            action={
              <Button size="sm" variant="ghost" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? "Hide" : "Show"}
              </Button>
            }
          />
          {showArchived ? <ul className="divide-y divide-border">{archived.map(row)}</ul> : null}
        </Card>
      ) : null}

      {edit ? <TemplateEditor data={data} t={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
      {publish ? <PublishModal data={data} t={publish} onClose={() => setPublish(null)} /> : null}
      {preview ? (
        <PreviewModal t={preview} sdsName={(c) => data.sds.find((x) => x.code === c)?.product ?? c} onClose={() => setPreview(null)} />
      ) : null}
      {history ? <HistoryModal t={history} onClose={() => setHistory(null)} /> : null}
    </div>
  );
}

function TemplateEditor({ data, t, onClose }: { data: Overview; t: Template | null; onClose: () => void }) {
  const save = useSaveTemplate();
  const [name, setName] = React.useState(t?.name ?? "");
  const [workType, setWorkType] = React.useState(t?.workType ?? "");
  const [activity, setActivity] = React.useState(t?.activity ?? "");
  const [ppe, setPpe] = React.useState<string[]>(t?.ppe ?? []);
  const [blockIds, setBlockIds] = React.useState<number[]>(t?.blockIds ?? []);
  const [matchTerms, setMatchTerms] = React.useState<string[]>(t?.matchTerms ?? []);
  const [categoryTerms, setCategoryTerms] = React.useState<string[]>(t?.categoryTerms ?? []);
  const [alsoAdds, setAlsoAdds] = React.useState<string[]>(t?.alsoAdds ?? []);
  const [drag, setDrag] = React.useState<number | null>(null);
  const [adding, setAdding] = React.useState("");

  const blocks = new Map(data.blocks.map((b) => [b.id, b]));
  const unused = data.blocks.filter((b) => !b.archived && !blockIds.includes(b.id));
  const others = data.templates.filter((x) => !x.archived && !x.everyJob && x.key !== t?.key);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= blockIds.length || from === to) return;
    const next = [...blockIds];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    setBlockIds(next);
  };

  async function go() {
    await save.mutateAsync({ id: t?.id ?? null, name, workType, activity, ppe, blockIds, matchTerms, categoryTerms, alsoAdds });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={t ? `Edit ${t.name}` : "New template"}
      subtitle="Saves as a draft. Crew keeps the published version until you publish."
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Hybrid / LVT install" />
          </Field>
          <Field label="Work type">
            <Input value={workType} onChange={(e) => setWorkType(e.target.value)} placeholder="Resilient floor coverings" />
          </Field>
        </div>
        <Field label="Activity" hint="One or two lines. Shows under the template name on the phone and the PDF.">
          <Textarea rows={2} value={activity} onChange={(e) => setActivity(e.target.value)} />
        </Field>
        <Field label="PPE" hint="On top of the PPE each task block lists.">
          <WordList value={ppe} onChange={setPpe} placeholder="Safety boots, knee pads" />
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium">Task blocks, in order</p>
          <p className="mb-2 text-xs text-muted-foreground">Drag to reorder. A block edited on the Task blocks tab changes every template that uses it, at its next publish.</p>
          <ol className="grid gap-1.5">
            {blockIds.map((id, i) => {
              const b = blocks.get(id);
              return (
                <li
                  key={id}
                  draggable
                  onDragStart={() => setDrag(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (drag !== null) move(drag, i);
                    setDrag(null);
                  }}
                  onDragEnd={() => setDrag(null)}
                  className={`flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm ${drag === i ? "opacity-50" : ""}`}
                >
                  <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                  <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {b?.title ?? "Missing block"}{" "}
                    <span className="text-xs text-muted-foreground">
                      {b ? `${b.items.length} hazard${b.items.length === 1 ? "" : "s"}` : ""}
                      {b?.archived ? ", archived, left out at publish" : ""}
                    </span>
                  </span>
                  <Button size="icon-sm" variant="ghost" aria-label="Move up" onClick={() => move(i, i - 1)} disabled={i === 0}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Move down" onClick={() => move(i, i + 1)} disabled={i === blockIds.length - 1}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Take out" onClick={() => setBlockIds(blockIds.filter((x) => x !== id))}>
                    <X className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ol>
          <div className="mt-2 flex gap-2">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="h-8 text-xs">
              <option value="">Add a task block</option>
              {unused.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={!adding}
              onClick={() => {
                setBlockIds([...blockIds, Number(adding)]);
                setAdding("");
              }}
            >
              Add
            </Button>
          </div>
        </div>

        {t?.everyJob ? null : (
          <div className="grid gap-3 rounded-lg bg-secondary/50 p-3">
            <p className="text-sm font-medium">Which jobs get it</p>
            <Field label="Labour names it matches" hint="Any labour line on the job whose name contains one of these words. Live as soon as you save.">
              <WordList value={matchTerms} onChange={setMatchTerms} placeholder="hybrid, vinyl plank, lvt" />
            </Field>
            <Field label="Job category words" hint="Only used when no labour on the job matched anything.">
              <WordList value={categoryTerms} onChange={setCategoryTerms} placeholder="carpet" />
            </Field>
            <Field label="Always brings in">
              <div className="flex flex-wrap gap-1.5">
                {others.map((o) => {
                  const on = alsoAdds.includes(o.key);
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => setAlsoAdds(on ? alsoAdds.filter((k) => k !== o.key) : [...alsoAdds, o.key])}
                      className={`rounded-full border px-2 py-0.5 text-xs ${on ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                    >
                      {o.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        )}

        <ErrorLine error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || name.trim().length < 2} onClick={() => void go().catch(() => {})}>
            {save.isPending ? "Saving" : "Save draft"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PublishModal({ data, t, onClose }: { data: Overview; t: Template; onClose: () => void }) {
  const pub = usePublishTemplate();
  const [whatChanged, setWhatChanged] = React.useState(t.status === "draft" ? "First version." : "");
  const [reviewedByName, setReviewedByName] = React.useState("");
  const [qual, setQual] = React.useState("");
  const [reviewedOn, setReviewedOn] = React.useState(todayBrisbane());
  const [done, setDone] = React.useState<string | null>(null);
  const old = t.replacesKey && !t.latest ? data.templates.find((x) => x.key === t.replacesKey && !x.archived) : undefined;

  async function go() {
    const r = await pub.mutateAsync({
      id: t.id,
      whatChanged,
      reviewedByName,
      reviewedByQualification: qual,
      reviewedOn: reviewedByName.trim() ? reviewedOn || null : null,
    });
    setDone(
      `Published version ${r.version}.${r.replaced ? (r.replaced.archived ? ` ${r.replaced.name} is archived.` : ` ${r.replaced.name} keeps the words this one doesn't cover.`) : ""}`,
    );
  }

  return (
    <Modal open onClose={onClose} title={`Publish ${t.name}`} subtitle={`This becomes version ${(t.latest?.version ?? 0) + 1}. Crew gets it on their next SWMS. Signed ones never change.`}>
      {done ? (
        <div className="grid gap-3">
          <p className="text-sm">{done}</p>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          {old ? (
            <p className="rounded-md bg-[#B7791F14] px-3 py-2 text-xs">
              This replaces <span className="font-medium">{old.name}</span>. Its matching words that this template also has move here.
              {" "}{old.name} is archived once it has no words left, never deleted.
            </p>
          ) : null}
          <Field label="What changed">
            <Textarea rows={2} value={whatChanged} onChange={(e) => setWhatChanged(e.target.value)} placeholder="Added the knee pad line to kneeling." />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Reviewed by">
              <Input value={reviewedByName} onChange={(e) => setReviewedByName(e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Qualification">
              <Input value={qual} onChange={(e) => setQual(e.target.value)} placeholder="Optional" />
            </Field>
            <Field label="Reviewed on">
              <Input type="date" value={reviewedOn} onChange={(e) => setReviewedOn(e.target.value)} />
            </Field>
          </div>
          <ErrorLine error={pub.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={pub.isPending || whatChanged.trim().length < 3} onClick={() => void go().catch(() => {})}>
              {pub.isPending ? "Publishing" : "Publish"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function PreviewModal({ t, sdsName, onClose }: { t: Template; sdsName: (code: string) => string; onClose: () => void }) {
  const q = useSwmsPreview(t.id);
  const pdf = usePreviewPdf();
  const crew = q.data?.crew;
  const sections = crew ? (t.everyJob ? [{ key: "common", title: "Common site hazards", task: "", items: crew.common, ppe: [] as string[] }] : crew.sections) : [];
  return (
    <Modal open onClose={onClose} width="max-w-xl" title={`Preview ${t.name}`} subtitle="The draft as Crew would see it on the phone. Everything starts ticked.">
      {q.isLoading ? (
        <Loading />
      ) : !crew ? (
        <Empty>Couldn't load the preview.</Empty>
      ) : (
        <div className="grid gap-3">
          <div className="mx-auto w-full max-w-[380px] rounded-[28px] border-[6px] border-[#1C1B1A] bg-[#F6F3EE] p-3 shadow-lg">
            {sections.map((s) => (
              <div key={s.key} className="mb-3 rounded-2xl bg-white p-3">
                <p className="text-[15px] font-semibold">{s.title}</p>
                {s.task ? <p className="mt-0.5 text-xs text-muted-foreground">{s.task}</p> : null}
                {s.ppe.length ? <p className="mt-1 text-xs text-muted-foreground">PPE: {s.ppe.join(", ")}</p> : null}
                <ul className="mt-2 grid gap-2">
                  {s.items.map((i) => (
                    <li key={i.id} className="flex gap-2 border-t border-border pt-2">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-[#3F7D3A] text-[11px] text-white">✓</span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-snug">{i.label}</p>
                        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{i.controls}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <RiskPill before={i.riskBefore} after={i.riskAfter} />
                          {i.sds ? <Badge>SDS {sdsName(i.sds)}</Badge> : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {!sections.length || !sections.some((s) => s.items.length) ? <p className="p-4 text-center text-xs text-muted-foreground">No hazards yet. Add a task block.</p> : null}
          </div>
          <ErrorLine error={pdf.error} />
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={pdf.isPending}
              onClick={() =>
                void pdf.mutateAsync({ id: t.id, pdf: true }).then((r) => {
                  if (r.pdfBase64) openPdf(r.pdfBase64);
                })
              }
            >
              <FileText className="size-3.5" /> {pdf.isPending ? "Making the PDF" : "Sample PDF"}
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function HistoryModal({ t, onClose }: { t: Template; onClose: () => void }) {
  const v = useSwmsVersions(t.id);
  const log = useSwmsChanges({ entityType: "template", entityId: t.id, limit: 100 });
  return (
    <Modal open onClose={onClose} width="max-w-2xl" title={`History of ${t.name}`}>
      <div className="grid gap-4">
        <div>
          <p className="mb-2 text-sm font-medium">Published versions</p>
          {v.isLoading ? (
            <Loading />
          ) : !v.data?.length ? (
            <p className="text-xs text-muted-foreground">Never published.</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {v.data.map((r) => (
                <li key={r.id} className="px-3 py-2 text-sm">
                  <p className="font-medium">
                    Version {r.version}{" "}
                    <span className="font-normal text-muted-foreground">
                      {fmtDate(r.publishedAt)} by {r.publishedByName || "System"}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs">{r.whatChanged}</p>
                  {r.reviewedByName ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Reviewed by {r.reviewedByName}
                      {r.reviewedByQualification ? `, ${r.reviewedByQualification}` : ""}
                      {r.reviewedOn ? `, ${r.reviewedOn}` : ""}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.content?.blocks.length ?? 0} blocks, {r.content?.blocks.reduce((n, b) => n + b.items.length, 0) ?? 0} hazards
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Changes</p>
          {log.isLoading ? <Loading /> : <ChangeList rows={log.data ?? []} />}
        </div>
      </div>
    </Modal>
  );
}

export function ChangeList({ rows }: { rows: Array<{ id: number; summary: string; actorName: string; createdAt: Date | string }> }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">Nothing yet.</p>;
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap justify-between gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{r.summary}</span>
          <span className="text-muted-foreground">
            {r.actorName}, {fmtDateTime(r.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}
