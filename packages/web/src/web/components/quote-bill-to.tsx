import * as React from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { BillToPicker, type BillToCard } from "./bill-to";
import { useUpdateQuote } from "../queries/quotes";
import { useSetCardDeposit } from "../queries/billTo";

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Who pays this quote (notes 18.54). Each quote has its own Bill to, which can
 * differ from its job's. A draft billed to someone else takes their card %.
 */
export function QuoteBillTo({
  quoteId,
  jobId,
  card,
  locked,
  onError,
}: {
  quoteId: number;
  jobId: number | null;
  card: BillToCard | null;
  locked: boolean;
  onError: (msg: string | null) => void;
}) {
  const update = useUpdateQuote();
  return (
    <div className="flex flex-col gap-1">
      <span className="label-xs">Bill to</span>
      {locked ? (
        <p className="text-sm font-medium">{card?.name ?? "Nobody picked"}</p>
      ) : (
        <BillToPicker
          quoteId={quoteId}
          jobId={jobId}
          value={card ? { type: card.type, id: card.id } : null}
          disabled={update.isPending}
          onChange={(next) => {
            if (!next) return onError("Every quote needs a Bill to. Pick a company or a person.");
            onError(null);
            update.mutate({ id: quoteId, billTo: { type: next.type, id: next.id } }, { onError: (e) => onError(e.message) });
          }}
        />
      )}
    </div>
  );
}

/**
 * Deposit % for this quote. It comes from the Bill to's card. Typed here it is
 * for this quote only, and the card stays. A card with no % yet is asked once
 * and the % saves on the card. Saves on Enter or when you leave the box.
 */
export function QuoteDepositRows({
  quoteId,
  percent,
  source,
  card,
  deposit,
  balance,
  locked,
  onError,
}: {
  quoteId: number;
  percent: number;
  source: string;
  card: BillToCard | null;
  deposit: number;
  balance: number;
  locked: boolean;
  onError: (msg: string | null) => void;
}) {
  const update = useUpdateQuote();
  const setCard = useSetCardDeposit();
  const waiting = source === "none";
  const shown = waiting ? "" : String(percent);
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => setDraft(shown), [shown]);
  const pending = update.isPending || setCard.isPending;

  function save() {
    const t = draft.trim();
    if (t === "") {
      setDraft(shown);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setDraft(shown);
      onError("Deposit has to be between 0 and 100%.");
      return;
    }
    if (!waiting && n === percent) return;
    onError(null);
    // Asked once: a card with no % gets it, and this quote follows the card.
    if (card && card.percent == null) {
      setCard.mutate({ billTo: { type: card.type, id: card.id }, percent: n }, { onError: (e) => onError(e.message) });
      return;
    }
    update.mutate({ id: quoteId, depositPercent: n }, { onError: (e) => onError(e.message) });
  }

  const note = !card
    ? "Pick who pays first. The % comes from their card."
    : card.percent == null
      ? "Asked once. It saves on their card."
      : source === "quote"
        ? `Typed for this quote only. ${card.name}'s card says ${card.percent}%.`
        : `From ${card.name}'s card.`;

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground">Deposit</span>
        <span className="flex items-center gap-2">
          <Input
            aria-label={card && card.percent == null ? `Deposit % for ${card.name}` : "Deposit % for this quote"}
            aria-invalid={waiting || undefined}
            className={`tabular h-8 w-[70px] text-right ${waiting ? "border-destructive" : ""}`}
            inputMode="decimal"
            placeholder="%"
            value={draft}
            disabled={locked || pending || !card}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="tabular text-muted-foreground">% = {money(deposit)}</span>
        </span>
      </div>
      {!locked ? (
        <div className="flex flex-col items-end gap-0.5 text-right">
          <p className={waiting ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            {waiting && card ? `${card.name} has no deposit % yet. Type it once. It saves on their card.` : note}
          </p>
          {source === "quote" && card?.percent != null ? (
            <Button
              variant="ghost"
              className="h-6 px-1.5 text-xs"
              disabled={pending}
              onClick={() => update.mutate({ id: quoteId, depositFromCard: true }, { onError: (e) => onError(e.message) })}
            >
              Use the card % ({card.percent}%)
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-between">
        <span className="text-muted-foreground">Balance</span>
        <span className="tabular">{money(balance)}</span>
      </div>
    </>
  );
}

