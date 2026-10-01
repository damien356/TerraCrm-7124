import * as React from "react";
import { History, Pencil, Plus, Search, Trash2, Undo2 } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Badge, tintFor } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Label, Select } from "./ui/field";
import { Modal } from "./ui/modal";
import {
  useClearOverride,
  useCreateRateItem,
  useDeleteRateItem,
  useRateBook,
  useRateCard,
  useRateHistory,
  useSetRate,
  useUpdateRateItem,
} from "../queries/labour";
import { useBootstrap } from "../queries/settings";
import { STANDARD_MARKUP_PCT, markupPctUsed, sellExGstWithMarkup } from "../../api/lib/pricing";

export const RATE_UNITS = ["m2", "lm", "each", "step", "hour", "day", "job", "percent", "km"] as const;
export const RATE_GROUPS = [
  "carpet",
  "resilient",
  "timber",
  "prep",
  "demolition",
  "trades",
  "surcharge",
  "other",
] as const;
const RATE_KINDS = ["work", "surcharge", "allowance"] as const;

/** How a unit reads on screen. The data keeps the plain code. */
export const UNIT_LABEL: Record<string, string> = {
  m2: "m²",
  lm: "lm",
  each: "each",
  step: "step",
  hour: "hour",
  day: "day",
  job: "job",
  percent: "%",
  km: "km",
};

export const today = () => new Date().toISOString().slice(0, 10);

/** A percent surcharge is a percentage, not dollars. Same table, different sign. */
function isPercent(unit: string) {
  return unit === "percent";
}

export function money(amount: number | null | undefined, unit: string) {
  if (amount == null) return "not set";
  return isPercent(unit) ? `${amount}%` : `$${amount.toFixed(2)}`;
}

/* ------------------------------------------------------------------ *
 * A rate cell. Blank means not set, and a blank is better than a
 * made up number sitting in a costing screen.
 * ------------------------------------------------------------------ */

function RateInput({
  value,
  unit,
  placeholder,
  onSave,
  pending,
  className,
}: {
  value: number | null;
  unit: string;
  placeholder?: string;
  onSave: (amount: number) => void;
  pending?: boolean;
  className?: string;
}) {
  const [text, setText] = React.useState(value == null ? "" : String(value));
  React.useEffect(() => setText(value == null ? "" : String(value)), [value]);

  function commit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      setText(value == null ? "" : String(value));
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n === value) {
      setText(value == null ? "" : String(value));
      return;
    }
    onSave(Number(n.toFixed(2)));
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        {isPercent(unit) ? "%" : "$"}
      </span>
      <Input
        value={text}
        inputMode="decimal"
        placeholder={placeholder ?? "not set"}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="h-8 pl-5 pr-2 text-right"
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
 * Markup, per rate item.
 *
 * Blank is the normal answer and means the standard chain, 91.1%. A number
 * here overrides it, which today exists for one reason: getting rid of the
 * old floor is money passed through, not work Terra profits on, so a tip run
 * goes out at cost plus 15%. Clearing the box puts the item back on standard.
 * ------------------------------------------------------------------ */

function MarkupInput({
  value,
  onSave,
  pending,
}: {
  value: number | null;
  onSave: (markupPercent: number | null) => void;
  pending?: boolean;
}) {
  const [text, setText] = React.useState(value == null ? "" : String(value));
  React.useEffect(() => setText(value == null ? "" : String(value)), [value]);

  function commit() {
    const trimmed = text.trim();
    if (trimmed === "") {
      // Empty box = back on the standard chain. Only a change if it was set.
      if (value != null) onSave(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n === value) {
      setText(value == null ? "" : String(value));
      return;
    }
    onSave(Number(n.toFixed(2)));
  }

  return (
    <div className="relative w-24">
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
        %
      </span>
      <Input
        value={text}
        inputMode="decimal"
        placeholder={`${STANDARD_MARKUP_PCT} std`}
        title="Markup on top of cost. Leave blank for Terra's standard 91.1%."
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`h-8 pl-2 pr-5 text-right ${value == null ? "" : "font-medium text-foreground"}`}
      />
      {pending ? (
        <span className="absolute -right-5 top-1/2 -translate-y-1/2">
          <Spinner />
        </span>
      ) : null}
    </div>
  );
}

/** What the customer pays for one unit of this item, at whatever markup it carries. */
function SellCell({ rate, unit, markupPercent }: { rate: number | null; unit: string; markupPercent: number | null }) {
  if (isPercent(unit)) return <div className="w-28" />;
  if (rate == null) {
    return <div className="w-28 text-right text-xs text-muted-foreground">no cost yet</div>;
  }
  const sell = sellExGstWithMarkup(rate, markupPercent);
  return (
    <div className="w-28 text-right text-xs leading-tight">
      <div className="text-foreground">
        ${sell.toFixed(2)}
        <span className="text-muted-foreground">/{UNIT_LABEL[unit] ?? unit}</span>
      </div>
      <div className="text-muted-foreground">
        sells ex GST, +{markupPctUsed(markupPercent)}%
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Edit mode text box: saves when you leave it, Enter saves too.
 * ------------------------------------------------------------------ */

function TextEdit({
  value,
  placeholder,
  onSave,
  required,
  className,
}: {
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
  required?: boolean;
  className?: string;
}) {
  const [text, setText] = React.useState(value);
  const cancelled = React.useRef(false);
  React.useEffect(() => setText(value), [value]);
  function commit() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const t = text.trim();
    if (t === value.trim()) return;
    if (required && !t) {
      setText(value);
      return;
    }
    onSave(t);
  }
  return (
    <Input
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          setText(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Settings -> Labour rates. Terra's own numbers.
 * ------------------------------------------------------------------ */

export function LabourRatesTab() {
  const [on, setOn] = React.useState(today());
  const [search, setSearch] = React.useState("");
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);
  const [historyFor, setHistoryFor] = React.useState<{ itemId: number; name: string } | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [deleting, setDeleting] = React.useState<{ id: number; name: string } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const book = useRateBook({ on, search: search.trim() || undefined, includeInactive });
  const setRate = useSetRate();
  const update = useUpdateRateItem();
  const boot = useBootstrap();
  const skillOptions = boot.data?.allSkills ?? [];

  const rows = book.data?.rows ?? [];
  const groups = RATE_GROUPS.filter((g) => rows.some((r) => r.groupName === g)).concat(
    Array.from(new Set(rows.map((r) => r.groupName).filter((g) => !RATE_GROUPS.includes(g as never)))) as never[],
  );

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a rate item"
            className="h-9 pl-8"
          />
        </div>
        <div>
          <Label htmlFor="labour_on">Rates as at</Label>
          <Input
            id="labour_on"
            type="date"
            value={on}
            onChange={(e) => setOn(e.target.value || today())}
            className="h-9 w-40"
          />
        </div>
        <label htmlFor="labour_inactive" className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            id="labour_inactive"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show switched off
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={editing}
          onClick={() => setEditing((v) => !v)}
          className="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm"
        >
          <span
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${editing ? "bg-[var(--gold)]" : "bg-border"}`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${editing ? "left-[18px]" : "left-0.5"}`}
            />
          </span>
          <Pencil className="size-3.5 text-muted-foreground" />
          Edit or delete items
        </button>
        <Button onClick={() => setNewOpen(true)}>
          <Plus className="size-4" />
          New rate item
        </Button>
      </div>

      {editing ? (
        <p className="mb-3 rounded-md border border-[var(--gold)]/40 bg-[var(--gold)]/5 px-3 py-2 text-xs text-foreground">
          Edit mode. Change the name, the note, the skill under it, or what it is priced per (m², lm, each, per job
          and so on). Text saves when you tap out of the box, the dropdowns save straight away. If you change what it
          is priced per, check the rate still makes sense, $40 a lm is not $40 a m². The skill decides which installers
          see the item on their rate card. The bin deletes the item. Quotes already made keep their own wording and
          price.
        </p>
      ) : null}
      {notice ? (
        <p className="mb-3 rounded-md border border-border bg-secondary px-3 py-2 text-xs text-foreground">
          {notice}{" "}
          <button type="button" onClick={() => setNotice(null)} className="ml-1 text-muted-foreground hover:underline">
            OK
          </button>
        </p>
      ) : null}

      <p className="mb-4 text-xs text-muted-foreground">
        These are Terra's rates, what the work COSTS. Every installer follows them unless he has his own number on his
        card. A new rate starts from the date you set it, it never rewrites a job that was already priced. The markup
        box is normally blank, meaning the standard {STANDARD_MARKUP_PCT}%. Put a number in it only where the line is
        money passed through rather than work Terra profits on, like a tip run.
        {book.data ? (
          <span className="ml-1 text-foreground">
            {book.data.priced} of {rows.length} priced.
          </span>
        ) : null}
      </p>

      {book.isLoading ? <Loading /> : null}

      <div className="space-y-4">
        {groups.map((group) => {
          const groupRows = rows.filter((r) => r.groupName === group);
          const tint = tintFor(group);
          return (
            <Card key={group}>
              <CardHeader
                title={<span className="capitalize">{group}</span>}
                subtitle={`${groupRows.filter((r) => r.rate != null).length} of ${groupRows.length} priced`}
                action={<span className="size-3 rounded-full" style={{ background: tint.fill }} />}
              />
              <div className="divide-y divide-border">
                {groupRows.map((row) => (
                  <div key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    {editing ? (
                      <div className="min-w-[200px] flex-1 space-y-1.5">
                        <TextEdit
                          value={row.name}
                          required
                          className="h-8 text-sm"
                          onSave={(name) => update.mutate({ id: row.id, name })}
                        />
                        <TextEdit
                          value={row.notes ?? ""}
                          placeholder="Note or description (optional)"
                          className="h-8 text-xs"
                          onSave={(notes) => update.mutate({ id: row.id, notes: notes || null })}
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Select
                            aria-label={`Skill for ${row.name}`}
                            value={row.skillId == null ? "" : String(row.skillId)}
                            onChange={(e) =>
                              update.mutate({ id: row.id, skillId: e.target.value ? Number(e.target.value) : null })
                            }
                            className="h-8 max-w-full flex-1 text-xs"
                          >
                            <option value="">No skill</option>
                            {skillOptions
                              .filter((sk) => sk.active || sk.id === row.skillId)
                              .map((sk) => (
                                <option key={sk.id} value={sk.id}>
                                  {sk.name}
                                  {sk.active ? "" : " (switched off)"}
                                </option>
                              ))}
                          </Select>
                          {row.active ? null : <span className="text-xs text-muted-foreground">switched off</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="min-w-[200px] flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm ${row.active ? "" : "text-muted-foreground line-through"}`}>
                            {row.name}
                          </span>
                          {row.kind !== "work" ? <Badge>{row.kind}</Badge> : null}
                        </div>
                        {row.notes ? <div className="mt-0.5 text-xs text-foreground/80">{row.notes}</div> : null}
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {row.skillName ?? "no skill"}
                          {row.effectiveFrom ? ` · rate set ${row.effectiveFrom}` : ""}
                        </div>
                      </div>
                    )}

                    <div className="flex w-28 items-center gap-1.5">
                      <Label className="mb-0">Per</Label>
                      {editing ? (
                        <Select
                          aria-label={`Unit for ${row.name}`}
                          value={row.unit}
                          onChange={(e) => update.mutate({ id: row.id, unit: e.target.value as never })}
                          className="h-8 w-20"
                        >
                          {RATE_UNITS.map((u) => (
                            <option key={u} value={u}>
                              {UNIT_LABEL[u] ?? u}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span className="text-sm font-medium text-foreground">{UNIT_LABEL[row.unit] ?? row.unit}</span>
                      )}
                    </div>

                    <RateInput
                      value={row.rate}
                      unit={row.unit}
                      className="w-28"
                      pending={setRate.isPending && setRate.variables?.itemId === row.id}
                      onSave={(amount) =>
                        setRate.mutate({
                          itemId: row.id,
                          installerId: null,
                          amount,
                          effectiveFrom: on,
                        })
                      }
                    />

                    {isPercent(row.unit) ? (
                      <div className="w-24" />
                    ) : (
                      <MarkupInput
                        value={row.markupPercent ?? null}
                        pending={update.isPending && update.variables?.id === row.id}
                        onSave={(markupPercent) => update.mutate({ id: row.id, markupPercent })}
                      />
                    )}

                    <SellCell rate={row.rate} unit={row.unit} markupPercent={row.markupPercent ?? null} />

                    <div className="w-32 text-right text-xs text-muted-foreground">
                      {row.overrides > 0 ? (
                        <span className="text-foreground">
                          {row.overrides} on own rate
                        </span>
                      ) : (
                        "all on standard"
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => setHistoryFor({ itemId: row.id, name: row.name })}
                      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                      title="Rate history"
                    >
                      <History className="size-4" />
                    </button>

                    {editing ? (
                      row.active ? (
                        <button
                          type="button"
                          onClick={() => setDeleting({ id: row.id, name: row.name })}
                          className="rounded-md p-1.5 text-[var(--destructive)] transition-colors hover:bg-[var(--destructive)]/10"
                          title="Delete this item"
                          aria-label={`Delete ${row.name}`}
                        >
                          <Trash2 className="size-4" />
                        </button>
                      ) : (
                        <Button size="sm" variant="outline" onClick={() => update.mutate({ id: row.id, active: true })}>
                          Turn back on
                        </Button>
                      )
                    ) : null}
                  </div>
                ))}
                {groupRows.length === 0 ? <Empty>Nothing here.</Empty> : null}
              </div>
            </Card>
          );
        })}
        {!book.isLoading && rows.length === 0 ? (
          <Card>
            <Empty>No rate items match that.</Empty>
          </Card>
        ) : null}
      </div>

      <NewRateItemModal open={newOpen} onClose={() => setNewOpen(false)} />
      <DeleteRateItemModal item={deleting} onClose={() => setDeleting(null)} onDone={setNotice} />
      <RateHistoryModal
        itemId={historyFor?.itemId ?? null}
        name={historyFor?.name ?? ""}
        onClose={() => setHistoryFor(null)}
      />
    </>
  );
}

function DeleteRateItemModal({
  item,
  onClose,
  onDone,
}: {
  item: { id: number; name: string } | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const del = useDeleteRateItem();
  const [error, setError] = React.useState<string | null>(null);

  async function confirm() {
    if (!item) return;
    setError(null);
    try {
      const r = await del.mutateAsync({ id: item.id });
      onDone(
        r.result === "switched_off"
          ? `"${item.name}" is measured on ${r.onJobs} job${r.onJobs === 1 ? "" : "s"}, so it was switched off instead of deleted, to keep those jobs right. It is hidden now. Tick "Show switched off" to bring it back.`
          : `"${item.name}" deleted.`,
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={item != null}
      onClose={onClose}
      title={`Delete ${item?.name ?? ""}?`}
      subtitle="It comes off the rate book and off every installer's card. Quotes already made keep their own wording and price."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={del.isPending}>
            {del.isPending ? <Spinner className="border-white/40 border-t-white" /> : <Trash2 className="size-4" />}
            Delete
          </Button>
        </>
      }
    >
      {error ? <p className="text-sm text-[var(--destructive)]">{error}</p> : null}
    </Modal>
  );
}

function NewRateItemModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateRateItem();
  const [name, setName] = React.useState("");
  const [groupName, setGroupName] = React.useState<(typeof RATE_GROUPS)[number]>("carpet");
  const [kind, setKind] = React.useState<(typeof RATE_KINDS)[number]>("work");
  const [unit, setUnit] = React.useState<(typeof RATE_UNITS)[number]>("m2");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({ name: name.trim(), groupName, kind, unit, skillId: null });
      setName("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New rate item"
      subtitle="A thing you pay for. Set Terra's rate on it after, or leave it blank until you know the number."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add item
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="What is it">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Carpet stairs, winder" />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Group">
            <Select value={groupName} onChange={(e) => setGroupName(e.target.value as never)}>
              {RATE_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as never)}>
              {RATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Paid per">
            <Select value={unit} onChange={(e) => setUnit(e.target.value as never)}>
              {RATE_UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABEL[u]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {error ? <p className="text-sm text-[var(--destructive)]">{error}</p> : null}
      </div>
    </Modal>
  );
}

export function RateHistoryModal({
  itemId,
  name,
  installerId = null,
  onClose,
}: {
  itemId: number | null;
  name: string;
  installerId?: number | null;
  onClose: () => void;
}) {
  const history = useRateHistory(itemId, installerId);

  return (
    <Modal
      open={itemId != null}
      onClose={onClose}
      title={`Rate history, ${name}`}
      subtitle="Every version, who it was for, and the dates it applied. Nothing here is ever overwritten."
      width="max-w-2xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {history.isLoading ? <Loading /> : null}
      {history.data?.length === 0 ? <Empty>No rate has ever been set on this one.</Empty> : null}
      {history.data && history.data.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 text-left">
              <tr className="label-xs">
                <th className="px-3 py-2">Who</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2">From</th>
                <th className="px-3 py-2">To</th>
                <th className="px-3 py-2">Set by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {history.data.map((r) => (
                <tr key={r.id} className={r.current ? "" : "text-muted-foreground"}>
                  <td className="px-3 py-2">
                    {r.who}
                    {r.current ? <Badge colour="#3f7d3a" className="ml-2">current</Badge> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    ${r.amount.toFixed(2)}
                    {r.minimumCharge != null ? (
                      <span className="ml-1 text-xs">min ${r.minimumCharge.toFixed(2)}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.effectiveFrom}</td>
                  <td className="px-3 py-2 tabular-nums">{r.effectiveTo ?? "open"}</td>
                  <td className="px-3 py-2 text-xs">{r.createdByName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * One installer's rate card.
 * ------------------------------------------------------------------ */

export function InstallerRatesTab({ installerId }: { installerId: number }) {
  const [on, setOn] = React.useState(today());
  const [allItems, setAllItems] = React.useState(false);
  const [historyFor, setHistoryFor] = React.useState<{ itemId: number; name: string } | null>(null);

  const card = useRateCard(installerId, { on, allItems });
  const setRate = useSetRate();
  const clear = useClearOverride();

  const rows = card.data?.rows ?? [];
  const groups = RATE_GROUPS.filter((g) => rows.some((r) => r.groupName === g));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="card_on">Card as at</Label>
          <Input
            id="card_on"
            type="date"
            value={on}
            onChange={(e) => setOn(e.target.value || today())}
            className="h-9 w-40"
          />
        </div>
        <label htmlFor="card_all" className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
          <Checkbox id="card_all" checked={allItems} onChange={(e) => setAllItems(e.target.checked)} />
          Show every item, not just his skills
        </label>
        {card.data ? (
          <div className="ml-auto text-xs text-muted-foreground">
            <span className="text-foreground">{card.data.customCount}</span> on his own rate,{" "}
            <span className="text-foreground">{rows.length - card.data.customCount}</span> following Terra
          </div>
        ) : null}
      </div>

      <p className="mb-4 text-xs text-muted-foreground">
        Blank means he is on Terra's standard rate and moves with it. Type a number and it sticks to him only, from
        the date above. Clearing an override puts him back on the standard without touching old jobs.
      </p>

      {card.data && card.data.upcoming.length > 0 ? (
        <Card className="mb-4 border-[var(--gold)]/40 bg-[var(--gold)]/5 px-4 py-2.5 text-sm">
          Rate changes already dated ahead: {card.data.upcoming.join(", ")}.{" "}
          {card.data.acknowledged.length > 0
            ? `He has acknowledged ${card.data.acknowledged.map((a) => a.effectiveFrom).join(", ")}.`
            : "Nothing acknowledged yet."}
        </Card>
      ) : null}

      {card.isLoading ? <Loading /> : null}

      <div className="space-y-4">
        {groups.map((group) => {
          const groupRows = rows.filter((r) => r.groupName === group);
          return (
            <Card key={group}>
              <CardHeader
                title={<span className="capitalize">{group}</span>}
                subtitle={`${groupRows.filter((r) => r.custom).length} of ${groupRows.length} on his own rate`}
              />
              <div className="divide-y divide-border">
                <div className="label-xs flex items-center gap-3 bg-secondary/40 px-4 py-1.5">
                  <span className="min-w-[200px] flex-1">Work item</span>
                  <span className="w-24 text-right">Terra</span>
                  <span className="w-28 text-right">His rate</span>
                  <span className="w-24 text-right">Difference</span>
                  <span className="w-16" />
                </div>
                {groupRows.map((row) => (
                  <div key={row.itemId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <div className="min-w-[200px] flex-1">
                      <div className="text-sm">{row.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        per {UNIT_LABEL[row.unit] ?? row.unit}
                        {row.custom && row.effectiveFrom ? ` · his rate from ${row.effectiveFrom}` : ""}
                        {!row.custom && row.source === "none" ? " · no rate set anywhere" : ""}
                      </div>
                    </div>

                    <div className="w-24 text-right text-sm tabular-nums text-muted-foreground">
                      {money(row.standard, row.unit)}
                    </div>

                    <RateInput
                      value={row.custom ? row.rate : null}
                      unit={row.unit}
                      placeholder={row.standard == null ? "not set" : "standard"}
                      className="w-28"
                      pending={setRate.isPending && setRate.variables?.itemId === row.itemId}
                      onSave={(amount) =>
                        setRate.mutate({ itemId: row.itemId, installerId, amount, effectiveFrom: on })
                      }
                    />

                    <div
                      className={`w-24 text-right text-sm tabular-nums ${
                        row.difference == null
                          ? "text-muted-foreground"
                          : row.difference > 0
                            ? "text-[var(--destructive)]"
                            : "text-[var(--success)]"
                      }`}
                    >
                      {row.difference == null
                        ? "—"
                        : `${row.difference > 0 ? "+" : ""}${money(row.difference, row.unit)}`}
                    </div>

                    <div className="flex w-16 items-center justify-end gap-1">
                      {row.custom ? (
                        <button
                          type="button"
                          onClick={() => clear.mutate({ itemId: row.itemId, installerId, effectiveFrom: on })}
                          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                          title="Put him back on Terra's standard"
                        >
                          <Undo2 className="size-4" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setHistoryFor({ itemId: row.itemId, name: row.name })}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        title="Rate history"
                      >
                        <History className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
        {!card.isLoading && rows.length === 0 ? (
          <Card>
            <Empty>
              Tick the skills he works in and his rate card fills itself from the rate book. Or show every item.
            </Empty>
          </Card>
        ) : null}
      </div>

      <RateHistoryModal
        itemId={historyFor?.itemId ?? null}
        name={historyFor?.name ?? ""}
        installerId={null}
        onClose={() => setHistoryFor(null)}
      />
    </>
  );
}
