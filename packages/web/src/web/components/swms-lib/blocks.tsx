import * as React from "react";
import { ArrowDown, ArrowUp, Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, Input, Select, Textarea } from "../ui/field";
import { Modal } from "../ui/modal";
import { useArchiveBlock, useDuplicateBlock, useSaveBlock } from "../../queries/swms-lib";
import { ErrorLine, RiskPill, WordList, type Block, type Item, type Overview } from "./shared";

export function BlocksTab({ data }: { data: Overview }) {
  const [q, setQ] = React.useState("");
  const [edit, setEdit] = React.useState<Block | "new" | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const dup = useDuplicateBlock();
  const archive = useArchiveBlock();
  const needle = q.trim().toLowerCase();
  const list = data.blocks
    .filter((b) => showArchived || !b.archived)
    .filter(
      (b) =>
        !needle ||
        b.title.toLowerCase().includes(needle) ||
        b.items.some((i) => i.label.toLowerCase().includes(needle) || i.controls.toLowerCase().includes(needle)),
    );
  const sdsName = (c: string) => data.sds.find((x) => x.code === c)?.product ?? c;

  return (
    <Card>
      <CardHeader
        title="Task blocks"
        subtitle="One task, its hazards, risk before and after, controls, PPE and SDS. Write it once, every template that uses it picks it up at its next publish."
        action={
          <Button size="sm" onClick={() => setEdit("new")}>
            <Plus className="size-3.5" /> New block
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search blocks and hazards" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" aria-label="Show archived" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>
      {list.length === 0 ? (
        <Empty>No blocks match.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((b) => (
            <li key={b.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {b.title}
                  {b.archived ? <Badge>Archived</Badge> : null}
                  {!b.archived && b.usedBy.length === 0 ? <Badge>Not in any template</Badge> : null}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {b.items.length} hazard{b.items.length === 1 ? "" : "s"}
                  {b.ppe.length ? `. PPE: ${b.ppe.join(", ")}` : ""}
                  {b.usedBy.length ? `. Used by ${b.usedBy.join(", ")}` : ""}
                </p>
                {new Set(b.items.map((i) => i.sds).filter(Boolean)).size ? (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {[...new Set(b.items.map((i) => i.sds).filter((c): c is string => Boolean(c)))].map((c) => (
                      <Badge key={c}>SDS {sdsName(c)}</Badge>
                    ))}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                {b.archived ? (
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: b.id, archived: false })}>
                    Restore
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => setEdit(b)}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button size="sm" variant="ghost" aria-label="Duplicate" disabled={dup.isPending} onClick={() => dup.mutate({ id: b.id })}>
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        archive.mutate(
                          { id: b.id, archived: true },
                          { onError: (e) => alert(e instanceof Error ? e.message : "Couldn't archive") },
                        )
                      }
                    >
                      Archive
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {edit ? <BlockEditor data={data} b={edit === "new" ? null : edit} onClose={() => setEdit(null)} /> : null}
    </Card>
  );
}

type Draft = Omit<Item, "id"> & { id: string | null; _k: string };
let seq = 0;
const blank = (): Draft => ({ id: null, label: "", controls: "", riskBefore: null, riskAfter: null, sds: null, _k: `n${++seq}` });

function BlockEditor({ data, b, onClose }: { data: Overview; b: Block | null; onClose: () => void }) {
  const save = useSaveBlock();
  const [title, setTitle] = React.useState(b?.title ?? "");
  const [task, setTask] = React.useState(b?.task ?? "");
  const [ppe, setPpe] = React.useState<string[]>(b?.ppe ?? []);
  const [items, setItems] = React.useState<Draft[]>(() => (b?.items.length ? b.items.map((i) => ({ ...i, _k: i.id })) : [blank()]));
  const sds = data.sds.filter((s) => !s.archived);

  const set = (k: string, patch: Partial<Draft>) => setItems((list) => list.map((i) => (i._k === k ? { ...i, ...patch } : i)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    setItems(next);
  };

  async function go() {
    await save.mutateAsync({
      id: b?.id ?? null,
      title,
      task,
      ppe,
      items: items
        .filter((i) => i.label.trim() || i.controls.trim())
        .map(({ _k, ...i }) => ({ ...i, riskBefore: i.riskBefore || null, riskAfter: i.riskAfter || null, sds: i.sds || null })),
    });
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-3xl"
      title={b ? `Edit ${b.title}` : "New task block"}
      subtitle={b?.usedBy.length ? `Used by ${b.usedBy.join(", ")}. They show "unpublished changes" until each is published again.` : undefined}
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Task">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Slab grinding" />
          </Field>
          <Field label="PPE">
            <WordList value={ppe} onChange={setPpe} placeholder="P2 mask, eye protection" />
          </Field>
        </div>
        <Field label="What the task is" hint="Optional, one line.">
          <Input value={task} onChange={(e) => setTask(e.target.value)} />
        </Field>

        <div className="grid gap-2">
          <p className="text-sm font-medium">Hazards</p>
          {items.map((i, n) => (
            <div key={i._k} className="grid gap-2 rounded-lg border border-border p-3">
              <div className="flex items-start gap-2">
                <Textarea
                  rows={2}
                  className="flex-1"
                  value={i.label}
                  placeholder="The hazard, for example Silica dust from grinding"
                  onChange={(e) => set(i._k, { label: e.target.value })}
                />
                <div className="flex flex-col">
                  <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={n === 0} onClick={() => move(n, n - 1)}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={n === items.length - 1} onClick={() => move(n, n + 1)}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              </div>
              <Textarea rows={2} value={i.controls} placeholder="Controls" onChange={(e) => set(i._k, { controls: e.target.value })} />
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Risk before" className="w-32">
                  <Select className="h-8 text-xs" value={i.riskBefore ?? ""} onChange={(e) => set(i._k, { riskBefore: (e.target.value || null) as Draft["riskBefore"] })}>
                    <option value="">Not set</option>
                    <option value="H">High</option>
                    <option value="M">Medium</option>
                    <option value="L">Low</option>
                  </Select>
                </Field>
                <Field label="Risk after" className="w-32">
                  <Select className="h-8 text-xs" value={i.riskAfter ?? ""} onChange={(e) => set(i._k, { riskAfter: (e.target.value || null) as Draft["riskAfter"] })}>
                    <option value="">Not set</option>
                    <option value="H">High</option>
                    <option value="M">Medium</option>
                    <option value="L">Low</option>
                  </Select>
                </Field>
                <Field label="Relies on SDS" className="min-w-[180px] flex-1">
                  <Select className="h-8 text-xs" value={i.sds ?? ""} onChange={(e) => set(i._k, { sds: e.target.value || null })}>
                    <option value="">None</option>
                    {sds.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.product}
                      </option>
                    ))}
                  </Select>
                </Field>
                <RiskPill before={i.riskBefore} after={i.riskAfter} />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Remove hazard"
                  onClick={() => {
                    if (!i.id || confirm("Remove this hazard? Signed SWMS keep it.")) setItems(items.filter((x) => x._k !== i._k));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
          <div>
            <Button size="sm" variant="outline" onClick={() => setItems([...items, blank()])}>
              <Plus className="size-3.5" /> Add a hazard
            </Button>
          </div>
        </div>

        <ErrorLine error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || title.trim().length < 2} onClick={() => void go().catch(() => {})}>
            {save.isPending ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
