import * as React from "react";
import { Input } from "./ui/field";
import { useSetCardDeposit } from "../queries/billTo";

/**
 * The deposit % on a company or person card (notes 18.54). Quotes billed to
 * the card take it. Nothing is guessed: a card with no % says so, and the
 * office is asked the first time it is someone's Bill to. A % once set can be
 * changed but never blanked. Draft quotes billed to the card follow a change,
 * sent ones stay as they went out.
 */
export function DepositDefault({ kind, id, value }: { kind: "company" | "contact"; id: number; value: number | null }) {
  const setCard = useSetCardDeposit();
  const [draft, setDraft] = React.useState(value == null ? "" : String(value));
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(value == null ? "" : String(value)), [value]);

  async function save(next: number) {
    setError(null);
    setNote(null);
    try {
      const out = await setCard.mutateAsync({ billTo: { type: kind, id }, percent: next });
      if (out.quotesUpdated) setNote(`${out.quotesUpdated} draft quote${out.quotesUpdated === 1 ? "" : "s"} updated.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function commit() {
    const t = draft.trim();
    if (t === "") {
      if (value != null) {
        setError("A deposit % once set can't be blanked. Type 0 for no deposit.");
        setDraft(String(value));
      }
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setError("Between 0 and 100%.");
      setDraft(value == null ? "" : String(value));
      return;
    }
    if (n !== value) void save(n);
  }

  const missing = value == null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Deposit %</p>
          <p className={missing ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            {missing
              ? kind === "company"
                ? "Not set yet. Every company needs one. Quotes billed here wait for it."
                : "Not asked yet. Quotes billed to this person wait for it."
              : "Quotes billed to this card take it. Drafts follow a change, sent quotes stay."}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Input
            aria-label="Deposit % on this card"
            aria-invalid={missing || undefined}
            className={`tabular h-8 w-[64px] text-right ${missing ? "border-destructive" : ""}`}
            inputMode="decimal"
            placeholder="%"
            value={draft}
            disabled={setCard.isPending}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </span>
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
