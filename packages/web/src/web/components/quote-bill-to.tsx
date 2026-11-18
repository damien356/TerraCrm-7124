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
 * Deposit for this quote, as a % or a fixed $ amount. The % comes from the
 * Bill to's card. Typed here it is for this quote only, and the card stays. A
 * card with no % yet is asked once and the % saves on the card. Saves on Enter
 * or when you leave the box.
 *
 * Damien, 18 Nov 2026: the $ amount is GST inclusive and for this quote only.
 * Typing a % or "Use the card %" goes back to a %.
 */
export function QuoteDepositRows({
  quoteId,
  percent,
  source,
  card,
  deposit,
  balance,
  fixed,
  total,
  locked,
  onError,
}: {
  quoteId: number;
  percent: number;
  source: string;
  card: BillToCard | null;
  deposit: number;
  balance: number;
  fixed: number | null;
  total: number;
  locked: boolean;
  onError: (msg: string | null) => void;
}) {
  const update = useUpdateQuote();
  const setCard = useSetCardDeposit();
  const isFixed = fixed != null && fixed > 0;
  const [mode, setMode] = React.useState<"percent" | "amount">(isFixed ? "amount" : "percent");
  React.useEffect(() => setMode(isFixed ? "amount" : "percent"), [isFixed]);
  const waiting = source === "none" && !isFixed;
  const shownPct = waiting || isFixed ? "" : String(percent);
  const shownAmt = isFixed ? fixed.toFixed(2) : "";
  const shown = mode === "amount" ? shownAmt : shownPct;
  const [draft, setDraft] = React.useState(shown);
  React.useEffect(() => setDraft(shown), [shown]);
  const pending = update.isPending || setCard.isPending;
  const realPct = total > 0 ? Math.round((deposit / total) * 10000) / 100 : 0;

  function savePercent(t: string) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setDraft(shown);
      onError("Deposit has to be between 0 and 100%.");
      return;
    }
    if (!waiting && !isFixed && n === percent) return;
    onError(null);
    // Asked once: a card with no % gets it, and this quote follows the card.
    if (card && card.percent == null && !isFixed) {
      setCard.mutate({ billTo: { type: card.type, id: card.id }, percent: n }, { onError: (e) => onError(e.message) });
      return;
    }
    update.mutate({ id: quoteId, depositPercent: n }, { onError: (e) => onError(e.message) });
  }

  function saveAmount(t: string) {
    const n = Number(t.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      setDraft(shown);
      onError("Type the deposit in dollars, more than $0.");
      return;
    }
    const cents = Math.round(n * 100) / 100;
    if (total > 0 && cents > total) {
      setDraft(shown);
      onError(`The deposit can't be more than the quote total (${money(total)}).`);
      return;
    }
    if (isFixed && cents === fixed) return;
    onError(null);
    update.mutate({ id: quoteId, depositFixed: cents }, { onError: (e) => onError(e.message) });
  }

  function save() {
    const t = draft.trim();
    if (t === "") {
      setDraft(shown);
      return;
    }
    if (mode === "amount") saveAmount(t);
    else savePercent(t);
  }

  const cardSays = card?.percent != null ? ` ${card.name}'s card says ${card.percent}%.` : "";
  const note = !card
    ? "Pick who pays first. The % comes from their card."
    : mode === "amount"
      ? isFixed
        ? fixed > deposit
          ? `${money(fixed)} is more than the quote total now, so the deposit is the full ${money(total)}. Type a smaller amount.`
          : `Fixed amount for this quote only, inc GST.${cardSays}`
        : "Type the deposit in dollars, inc GST. For this quote only."
      : isFixed
        ? `This quote has a fixed ${money(fixed)} deposit. Type a % to use a % instead.`
        : card.percent == null
          ? "Asked once. It saves on their card."
          : source === "quote"
            ? `Typed for this quote only.${cardSays}`
            : `From ${card.name}'s card.`;

  const toggle = (m: "percent" | "amount", label: string) => (
    <button
      type="button"
      aria-pressed={mode === m}
      disabled={locked || pending || !card}
      onClick={() => {
        onError(null);
        setMode(m);
      }}
      className={`h-8 px-2 text-xs font-medium disabled:opacity-50 ${mode === m ? "bg-primary text-primary-foreground" : "bg-transparent text-muted-foreground hover:bg-muted"}`}
    >
      {label}
    </button>
  );

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground">Deposit</span>
        <span className="flex items-center gap-2">
          {!locked ? (
            <fieldset aria-label="Deposit as a % or a $ amount" className="m-0 flex min-w-0 overflow-hidden rounded-md border border-border p-0">
              {toggle("percent", "%")}
              {toggle("amount", "$")}
            </fieldset>
          ) : null}
          <Input
            aria-label={
              mode === "amount"
                ? "Deposit in dollars for this quote"
                : card && card.percent == null
                  ? `Deposit % for ${card.name}`
                  : "Deposit % for this quote"
            }
            aria-invalid={waiting || undefined}
            className={`tabular h-8 text-right ${mode === "amount" ? "w-[100px]" : "w-[70px]"} ${waiting && mode === "percent" ? "border-destructive" : ""}`}
            inputMode="decimal"
            placeholder={mode === "amount" ? "$" : "%"}
            value={draft}
            disabled={locked || pending || !card}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="tabular text-muted-foreground">{mode === "amount" ? `= ${realPct}%` : `% = ${money(deposit)}`}</span>
        </span>
      </div>
      {!locked ? (
        <div className="flex flex-col items-end gap-0.5 text-right">
          <p className={waiting && mode === "percent" ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
            {waiting && card && mode === "percent" ? `${card.name} has no deposit % yet. Type it once. It saves on their card.` : note}
          </p>
          {(source === "quote" || isFixed) && card?.percent != null ? (
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
