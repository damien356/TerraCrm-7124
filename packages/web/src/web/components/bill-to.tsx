import * as React from "react";
import { Button } from "./ui/button";
import { Combobox, type ComboboxOption } from "./ui/combobox";
import { Input } from "./ui/field";
import { useBillToCards, useBillToOptions, useBillToSearch, useSetCardDeposit, type BillToValue } from "../queries/billTo";

/* ---------------------------------------------------------------------------
 * Bill to (notes 18.54). Every job and every quote names who pays: one
 * company or one person. The deposit % lives on that card. Empty is red and
 * can't be saved. Nothing is picked for the office.
 * ------------------------------------------------------------------------- */

export type BillToCard = BillToValue & { name: string; percent: number | null };
type Option = BillToCard & { role: string };

const keyOf = (b: BillToValue | null | undefined) => (b ? `${b.type}:${b.id}` : "");
function parseKey(k: string): BillToValue | null {
  const [t, id] = k.split(":");
  if ((t !== "company" && t !== "contact") || !Number(id)) return null;
  return { type: t, id: Number(id) };
}

export const percentText = (p: number | null | undefined) => (p == null ? "no deposit % yet" : `${p}% deposit`);

export function BillToPicker({
  jobId,
  quoteId,
  value,
  onChange,
  disabled,
  id,
  extra = [],
}: {
  jobId?: number | null;
  quoteId?: number | null;
  value: BillToValue | null;
  /** The picked card with its name and %, or null when cleared. */
  onChange: (card: BillToCard | null) => void;
  disabled?: boolean;
  id?: string;
  /** Cards the screen knows about that the server can't yet (picked on a New job screen). */
  extra?: Option[];
}) {
  const [query, setQuery] = React.useState("");
  const short = useBillToOptions({ jobId: jobId ?? null, quoteId: quoteId ?? null }, !!(jobId || quoteId));
  const found = useBillToSearch(query);
  const typed = query.trim().length >= 2;

  const all = React.useMemo(() => {
    const map = new Map<string, Option>();
    for (const o of [...extra, ...(short.data?.options ?? []), ...(found.data ?? [])]) if (!map.has(keyOf(o))) map.set(keyOf(o), o);
    return map;
  }, [extra, short.data, found.data]);

  const list: Option[] = typed ? (found.data ?? []) : [...extra, ...(short.data?.options ?? [])].filter((o, i, a) => a.findIndex((x) => keyOf(x) === keyOf(o)) === i);
  const options: ComboboxOption[] = list.map((o) => ({
    value: keyOf(o),
    label: o.name,
    sublabel: `${o.role}, ${percentText(o.percent)}`,
  }));
  const current = value ? all.get(keyOf(value)) ?? (short.data?.current && keyOf(short.data.current) === keyOf(value) ? short.data.current : null) : null;
  const empty = !value;

  return (
    <div className="flex flex-col gap-1" id={id}>
      <div className={empty ? "rounded-md ring-2 ring-destructive" : undefined} data-required-empty={empty || undefined}>
        <Combobox
          value={keyOf(value)}
          onChange={(k) => {
            const b = parseKey(k);
            const card = b ? all.get(k) : null;
            onChange(b ? { ...b, name: card?.name ?? "", percent: card?.percent ?? null } : null);
          }}
          options={options}
          placeholder="Pick who pays…"
          emptyLabel="Nobody (not allowed)"
          disabled={disabled}
          onQueryChange={setQuery}
          selectedLabel={current?.name}
          loading={found.isFetching}
        />
      </div>
      {empty ? (
        <p className="text-xs font-medium text-destructive">Required. Pick a company or a person.</p>
      ) : current ? (
        <p className="text-xs text-muted-foreground">
          {current.type === "company" ? "Company" : "Person"}, {percentText(current.percent)}. Type a name to find anyone else.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Type a name to find anyone else</p>
      )}
    </div>
  );
}

/**
 * Asked once when the Bill to's card has no % yet. "Save on card" writes it
 * to the card, and every draft quote billed to that card follows.
 */
export function CardDepositPrompt({
  card,
  onSaved,
  saveLater,
  value,
  onValue,
}: {
  card: BillToCard;
  onSaved?: (percent: number) => void;
  /** New job and New quote: the % is kept in the form and saved on the card with the save. */
  saveLater?: boolean;
  value?: string;
  onValue?: (v: string) => void;
}) {
  const setCard = useSetCardDeposit();
  const [own, setOwn] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const draft = value ?? own;
  const setDraft = onValue ?? setOwn;
  const name = card.name || (card.type === "company" ? "This company" : "This person");

  async function save() {
    setError(null);
    const n = Number(draft.trim());
    if (draft.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) return setError("Type a % between 0 and 100.");
    try {
      await setCard.mutateAsync({ billTo: { type: card.type, id: card.id }, percent: n });
      onSaved?.(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
      <p className="text-xs font-medium">{name} has no deposit % yet. Type it once. It saves on their card.</p>
      <div className="flex items-center gap-2">
        <Input
          aria-label={`Deposit % for ${name}`}
          className="tabular h-8 w-[72px] text-right"
          inputMode="decimal"
          placeholder="%"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saveLater) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <span className="text-xs text-muted-foreground">%</span>
        {saveLater ? (
          <span className="text-xs text-muted-foreground">Saves on the card when you save.</span>
        ) : (
          <Button size="sm" variant="outline" disabled={setCard.isPending} onClick={() => void save()}>
            Save on card
          </Button>
        )}
      </div>
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Bill to on a New job, New quote or Create quote screen. The picker plus the
 * one-time % ask when the card has none. The % is held in the form and saved
 * on the card when the form saves (see readyBillTo).
 */
export function BillToField({
  jobId,
  value,
  onChange,
  percent,
  onPercent,
  known = [],
  id,
}: {
  jobId?: number | null;
  value: BillToCard | null;
  onChange: (card: BillToCard | null) => void;
  percent: string;
  onPercent: (v: string) => void;
  /** People and companies already on the form, offered first. */
  known?: Array<BillToValue & { role: string }>;
  id?: string;
}) {
  const list = React.useMemo(() => known.filter((k) => k.id > 0), [known]);
  const cards = useBillToCards(list);
  const extra: Option[] = list.flatMap((k, i) => {
    const c = cards.data?.[i];
    return c ? [{ ...c, role: k.role }] : [];
  });
  // The name and % come from the server, so a card picked before they load is filled in.
  const fresh = value ? extra.find((o) => o.type === value.type && o.id === value.id) : undefined;
  const card = value && fresh && (!value.name || value.percent !== fresh.percent) ? { ...value, name: fresh.name, percent: fresh.percent } : value;
  return (
    <div className="flex flex-col gap-1.5">
      <BillToPicker jobId={jobId} value={value} onChange={onChange} extra={extra} id={id} />
      {card && card.percent == null ? <CardDepositPrompt card={card} saveLater value={percent} onValue={onPercent} /> : null}
    </div>
  );
}

/**
 * Checks a Bill to before a form saves. Returns the error to show, or what to
 * save on the card first (null when the card already has its %).
 */
export function readyBillTo(card: BillToCard | null, percent: string, what: "job" | "quote"): { error: string } | { save: number | null } {
  if (!card) return { error: `Pick who pays this ${what} (Bill to).` };
  if (card.percent != null) return { save: null };
  const n = Number(percent.trim());
  if (percent.trim() === "" || !Number.isFinite(n) || n < 0 || n > 100) {
    return { error: `Type the deposit % for ${card.name || "the Bill to"}. It saves on their card.` };
  }
  return { save: n };
}
