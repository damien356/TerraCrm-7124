import { CheckCircle2 } from "lucide-react";
import { isDefaultWarning, coveredLineOf, appliedOf, TRIM_KEY } from "../../api/lib/quote-default-rules";
import { useCoverTrim, useReviewDefault, useTrimChoices } from "../queries/quote-defaults";
import { Select } from "./ui/field";

type DefaultLine = {
  id: number;
  quoteId: number;
  flagged?: boolean;
  flagReason?: string | null;
  defaultsApplied?: string | null;
  defaultReviewedBy?: string | null;
  defaultReviewedAt?: Date | string | null;
  defaultReviewNote?: string | null;
};

const when = (d: Date | string) =>
  new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Quote defaults (7 Nov). Under a line's warning: Mark reviewed, and on a
 * trim covered by an area's Install trims/scotia, which area it goes with.
 * A warning nobody has dealt with stops Send, Accept and Convert.
 */
export function DefaultWarningActions({ item, locked, onNotice }: { item: DefaultLine; locked: boolean; onNotice: (t: string) => void }) {
  const review = useReviewDefault();
  const warned = Boolean(item.flagged && isDefaultWarning(item.flagReason));
  const reviewed = item.defaultReviewedAt ? { by: item.defaultReviewedBy ?? "someone", at: item.defaultReviewedAt } : null;
  const covered = coveredLineOf(appliedOf(item.defaultsApplied));
  const isTrim = appliedOf(item.defaultsApplied).includes(TRIM_KEY);
  if (!warned && !(isTrim && covered != null)) return null;
  return (
    <div className="mb-1 flex flex-wrap items-center gap-2">
      {warned && reviewed ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700" title={item.defaultReviewNote ?? undefined}>
          <CheckCircle2 className="size-3.5" /> Reviewed by {reviewed.by}, {when(reviewed.at)}
          {item.defaultReviewNote ? `: ${item.defaultReviewNote}` : ""}
        </span>
      ) : warned && !locked ? (
        <button
          type="button"
          disabled={review.isPending}
          onClick={() =>
            review.mutate(
              { itemId: item.id },
              { onSuccess: () => onNotice("Marked reviewed. It no longer stops the quote going out."), onError: (e) => onNotice(e.message) },
            )
          }
          className="rounded-md border border-[#D08A1E] px-2 py-0.5 text-[11px] font-semibold text-[#8A5A00] hover:bg-[#FFF4E0]"
          title="You have checked this line. The warning stays on the line as a record, with your name and the time."
        >
          Mark reviewed
        </button>
      ) : null}
      {isTrim && covered != null && !locked ? <InstallWith item={item} covered={covered} onNotice={onNotice} /> : null}
    </div>
  );
}

function InstallWith({ item, covered, onNotice }: { item: DefaultLine; covered: number; onNotice: (t: string) => void }) {
  const choices = useTrimChoices(item.quoteId);
  const move = useCoverTrim();
  const list = choices.data ?? [];
  if (list.length < 2 && list.some((c) => c.id === covered)) {
    return <span className="text-[11px] text-muted-foreground">Install with {list[0]?.area}</span>;
  }
  return (
    <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      Install with
      <Select
        className="h-7 w-auto text-[11px]"
        value={list.some((c) => c.id === covered) ? String(covered) : ""}
        disabled={move.isPending || !list.length}
        onChange={(e) =>
          e.target.value &&
          move.mutate(
            { itemId: item.id, installId: Number(e.target.value) },
            { onSuccess: (r) => onNotice(`Install now covered by ${r.area}. Nothing added, no extra charge.`), onError: (er) => onNotice(er.message) },
          )
        }
      >
        {list.some((c) => c.id === covered) ? null : <option value="">Pick an area</option>}
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.area} ({c.qty} lm)
          </option>
        ))}
      </Select>
    </label>
  );
}
