import * as React from "react";
import { AlertTriangle, Lock, LockOpen, Plus, Ruler, Trash2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, Input, Select } from "./ui/field";
import { Modal } from "./ui/modal";
import { UNIT_LABEL, today } from "./labour";
import {
  useForecast,
  useFreezeLabour,
  useRemoveLine,
  useSetLine,
  useTaskLines,
  useUnfreezeLabour,
} from "../queries/costing";

const dollars = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 2 });

const dollars0 = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

const unit = (u: string) => UNIT_LABEL[u] ?? u;

/** Where the rate came from. His own number, Terra's default, or nobody's. */
function SourceBadge({ source }: { source: string }) {
  if (source === "installer") return <Badge colour="#3E6B4F">his rate</Badge>;
  if (source === "terra") return <Badge>Terra rate</Badge>;
  return <Badge colour="#B4472E">no rate</Badge>;
}

/* ------------------------------------------------------------------ *
 * A quantity cell. Blank takes the line off.
 * ------------------------------------------------------------------ */

function QtyInput({
  value,
  onSave,
  pending,
}: {
  value: number;
  onSave: (qty: number) => void;
  pending?: boolean;
}) {
  const [text, setText] = React.useState(String(value));
  React.useEffect(() => setText(String(value)), [value]);

  function commit() {
    const trimmed = text.trim();
    const n = trimmed === "" ? 0 : Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n === value) {
      setText(String(value));
      return;
    }
    onSave(Number(n.toFixed(2)));
  }

  return (
    <div className="relative">
      <Input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 w-20 px-2 text-right"
      />
      {pending ? (
        <span className="absolute -right-5 top-1/2 -translate-y-1/2">
          <Spinner />
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Measure the work up on one task, and see what it costs.
 * ------------------------------------------------------------------ */

export function MeasureUpModal({
  taskId,
  title,
  open,
  onClose,
}: {
  taskId: number | null;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const lines = useTaskLines(open ? taskId : null);
  const setLine = useSetLine();
  const removeLine = useRemoveLine();
  const freeze = useFreezeLabour();
  const unfreeze = useUnfreezeLabour();

  const [addItem, setAddItem] = React.useState("");
  const [addQty, setAddQty] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setAddItem("");
      setAddQty("");
      setError(null);
    }
  }, [open]);

  const d = lines.data;
  const measured = (d?.lines ?? []).filter((l) => l.lineId != null);
  const suggestions = d?.suggestions ?? [];
  const onList = new Set(measured.map((l) => l.itemId));
  const pickable = suggestions.filter((s) => !onList.has(s.id));
  const frozen = d?.frozen ?? null;

  async function add() {
    setError(null);
    const id = Number(addItem);
    const qty = Number(addQty);
    if (!id) return setError("Pick a work item first.");
    if (!Number.isFinite(qty) || qty <= 0) return setError("Put a quantity in.");
    try {
      await setLine.mutateAsync({ taskId: taskId!, itemId: id, qty: Number(qty.toFixed(2)), note: null });
      setAddItem("");
      setAddQty("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wouldn't save.");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Measure up: ${title}`}
      subtitle="Quantities live on the dispatch. The money is worked out off the rate book, per installer."
      width="max-w-3xl"
      footer={
        <>
          {frozen ? (
            <Button
              variant="secondary"
              onClick={() => unfreeze.mutate({ taskId: taskId! })}
              disabled={unfreeze.isPending}
            >
              <LockOpen className="size-3.5" />
              Back to live rates
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => freeze.mutate({ taskId: taskId! })}
              disabled={freeze.isPending || measured.length === 0}
            >
              <Lock className="size-3.5" />
              Lock this labour in
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {lines.isLoading ? (
        <Loading />
      ) : !d ? (
        <Empty>Couldn't read this dispatch.</Empty>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{d.skill?.name ?? "No skill on this dispatch"}</span>
            <span>·</span>
            <span>
              priced against {d.installer ? d.installer.name : "Terra's standard, nobody is on it yet"}
            </span>
            <span>·</span>
            <span>
              crew of {d.crewSize}
              {d.days != null ? ` · about ${d.days} day${d.days === 1 ? "" : "s"} on site` : ""}
            </span>
          </div>

          {frozen ? (
            <p className="flex items-start gap-2 rounded-md bg-secondary px-3 py-2 text-xs">
              <Lock className="mt-0.5 size-3.5 shrink-0" />
              <span>
                Locked at {dollars(frozen.cost)} on the rates of {frozen.pricedOn}. A rate change now won't touch
                this dispatch.
              </span>
            </p>
          ) : null}

          {d.incomplete ? (
            <p className="flex items-start gap-2 rounded-md bg-[#B4472E]/10 px-3 py-2 text-xs text-[#B4472E]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                No rate for {d.unpriced.join(", ")}. The total below is short by whatever those come to. Set the rate
                in Settings, or on the installer's card.
              </span>
            </p>
          ) : null}

          {measured.length === 0 ? (
            <Empty>Nothing measured yet. Add the first line below.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 pr-3 label-xs font-normal">Work</th>
                    <th className="pb-2 pr-3 label-xs font-normal">Qty</th>
                    <th className="pb-2 pr-3 label-xs font-normal">Rate</th>
                    <th className="pb-2 pr-3 label-xs font-normal text-right">Total</th>
                    <th aria-hidden="true" className="pb-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {measured.map((l) => (
                    <tr key={l.lineId}>
                      <td className="py-2 pr-3">
                        <p className="font-medium">{l.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {l.unit === "percent" ? "% of the labour" : `per ${unit(l.unit)}`}
                          {l.kind !== "work" ? ` · ${l.kind}` : ""}
                          {l.minimumApplied ? " · minimum charge applied" : ""}
                        </p>
                      </td>
                      <td className="py-2 pr-3">
                        <QtyInput
                          value={l.qty}
                          pending={setLine.isPending}
                          onSave={(qty) =>
                            setLine.mutate({ taskId: taskId!, itemId: l.itemId, qty, note: null })
                          }
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          <span className="tabular text-sm">
                            {l.rate == null ? "—" : l.unit === "percent" ? `${l.rate}%` : dollars(l.rate)}
                          </span>
                          <SourceBadge source={l.source} />
                        </div>
                      </td>
                      <td className="tabular py-2 pr-3 text-right font-medium">{dollars(l.total)}</td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine.mutate({ id: l.lineId! })}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                          title="Take this line off"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border">
                    <td className="pt-2 text-xs text-muted-foreground" colSpan={3}>
                      Labour {dollars(d.labour)}
                      {d.other > 0 ? ` · surcharges and allowances ${dollars(d.other)}` : ""}
                    </td>
                    <td className="tabular pt-2 text-right text-base font-semibold">{dollars(d.total)}</td>
                    <td aria-hidden="true" />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {/* add a line */}
          <div className="rounded-lg border border-border bg-secondary/40 p-3">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Add work" className="min-w-[220px] flex-1">
                <Select value={addItem} onChange={(e) => setAddItem(e.target.value)}>
                  <option value="">Pick from the rate book</option>
                  {pickable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({unit(s.unit)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity" className="w-28">
                <Input
                  value={addQty}
                  inputMode="decimal"
                  placeholder="0"
                  onChange={(e) => setAddQty(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void add();
                  }}
                />
              </Field>
              <Button variant="secondary" onClick={() => void add()} disabled={setLine.isPending}>
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
            {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
            {pickable.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Everything for this skill is already measured on.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * What the job makes. Office only, never an installer.
 * ------------------------------------------------------------------ */

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad";
}) {
  const colour = tone === "good" ? "text-[#3E6B4F]" : tone === "bad" ? "text-[#B4472E]" : "";
  return (
    <div>
      <p className="label-xs">{label}</p>
      <p className={`tabular mt-0.5 text-lg font-semibold ${colour}`}>{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function JobForecastCard({ jobId }: { jobId: number }) {
  const [against, setAgainst] = React.useState("");
  const [on, setOn] = React.useState(today());
  const [measuring, setMeasuring] = React.useState<{ id: number; title: string } | null>(null);

  const forecast = useForecast(jobId, { installerId: against ? Number(against) : null, on });
  const f = forecast.data;

  const gaps: string[] = [];
  if (f) {
    if (f.revenue === 0) gaps.push("no sell price yet, quote it or put a value on the job");
    if (f.materialsUnknown) gaps.push("some quote lines have no cost price");
    const nothingMeasured = f.tasks.filter((t) => t.measured === 0);
    if (nothingMeasured.length) gaps.push(`${nothingMeasured.length} dispatch(es) not measured up`);
    const short = Array.from(new Set(f.tasks.flatMap((t) => t.unpriced)));
    if (short.length) gaps.push(`no rate for ${short.join(", ")}`);
  }

  return (
    <>
      <Card>
        <CardHeader
          title="What this job makes"
          subtitle="Sale off the quote, materials off its cost prices, labour off the rate book."
          action={
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Price all labour against" className="w-[190px]">
                <Select value={against} onChange={(e) => setAgainst(e.target.value)} className="h-8">
                  <option value="">Whoever is on each one</option>
                  {(f?.comparison ?? []).map((c) => (
                    <option key={c.installerId} value={c.installerId}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rates as at" className="w-[140px]">
                <Input id="forecast_on" type="date" value={on} onChange={(e) => setOn(e.target.value)} className="h-8" />
              </Field>
            </div>
          }
        />

        {forecast.isLoading ? (
          <Loading />
        ) : !f ? (
          <Empty>Couldn't work this job's numbers out.</Empty>
        ) : (
          <div className="grid gap-4 px-4 py-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <Figure
                label="Sale ex GST"
                value={dollars0(f.revenue)}
                hint={f.quote ? `quote ${f.quote.number} v${f.quote.version}, ${f.quote.status}` : "off the job value"}
              />
              <Figure
                label="Materials"
                value={dollars0(f.materials)}
                hint={f.materialsUnknown ? "some costs missing" : "cost price"}
              />
              <Figure label="Labour" value={dollars0(f.labour)} hint="rate book" />
              <Figure label="Other" value={dollars0(f.other)} hint="surcharges, travel" />
              <Figure label="Total cost" value={dollars0(f.cost)} />
              <Figure
                label="Gross profit"
                value={dollars0(f.gp)}
                tone={f.gp > 0 ? "good" : "bad"}
                hint={f.incomplete ? "not the real number yet" : undefined}
              />
              <Figure
                label="Margin"
                value={f.margin == null ? "—" : `${f.margin}%`}
                tone={f.margin != null && f.margin >= 30 ? "good" : f.margin != null ? "bad" : undefined}
                hint={f.days != null ? `about ${f.days} day${f.days === 1 ? "" : "s"} of work` : undefined}
              />
            </div>

            {gaps.length ? (
              <p className="flex items-start gap-2 rounded-md bg-[#B4472E]/10 px-3 py-2 text-xs text-[#B4472E]">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">Treat this as a guess until it's fixed:</span> {gaps.join(" · ")}.
                </span>
              </p>
            ) : null}

            {/* per dispatch */}
            <div>
              <p className="label-xs mb-1">Labour, dispatch by dispatch</p>
              {f.tasks.length === 0 ? (
                <Empty>No dispatches on this job yet, so there is no labour to price.</Empty>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {f.tasks.map((t) => (
                    <li key={t.taskId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{t.title}</p>
                          {t.frozen ? (
                            <Badge>
                              <Lock className="size-3" /> locked {t.pricedOn}
                            </Badge>
                          ) : null}
                          {t.measured === 0 ? <Badge colour="#B4472E">not measured</Badge> : null}
                          {t.unpriced.length ? <Badge colour="#B4472E">{t.unpriced.length} unpriced</Badge> : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t.skill?.name ?? "no skill"} ·{" "}
                          {t.installer ? `on ${t.installer.name}` : "nobody on it, Terra's rates"} · {t.measured} line
                          {t.measured === 1 ? "" : "s"}
                          {t.days != null ? ` · ${t.days}d` : ""}
                        </p>
                      </div>
                      <span className="tabular text-sm font-medium">{dollars(t.total)}</span>
                      <Button variant="secondary" onClick={() => setMeasuring({ id: t.taskId, title: t.title })}>
                        <Ruler className="size-3.5" />
                        Measure up
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* swap the installer */}
            {f.comparison.length ? (
              <div>
                <p className="label-xs mb-1">What it costs on each installer, whole job</p>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-secondary/40 text-left">
                        <th className="px-3 py-2 label-xs font-normal">Installer</th>
                        <th className="px-3 py-2 label-xs font-normal text-right">Labour</th>
                        <th className="px-3 py-2 label-xs font-normal text-right">GP</th>
                        <th className="px-3 py-2 label-xs font-normal text-right">Margin</th>
                        <th className="px-3 py-2 label-xs font-normal">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {f.comparison.map((c) => (
                        <tr key={c.installerId} className={c.canDoAll ? "" : "opacity-60"}>
                          <td className="px-3 py-2 font-medium">{c.name}</td>
                          <td className="tabular px-3 py-2 text-right">{dollars0(c.labour)}</td>
                          <td className="tabular px-3 py-2 text-right">{dollars0(c.gp)}</td>
                          <td className="tabular px-3 py-2 text-right">{c.margin == null ? "—" : `${c.margin}%`}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {!c.canDoAll ? `not ticked for ${c.missingSkills} skill on this job` : null}
                            {c.canDoAll && c.incomplete ? "some work has no rate on his card" : null}
                            {c.canDoAll && !c.incomplete ? "can do the lot" : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Labour only. Materials don't change with who lays it.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <MeasureUpModal
        taskId={measuring?.id ?? null}
        title={measuring?.title ?? ""}
        open={measuring != null}
        onClose={() => setMeasuring(null)}
      />
    </>
  );
}
