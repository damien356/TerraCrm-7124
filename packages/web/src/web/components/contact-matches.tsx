import { UserCheck } from "lucide-react";
import { Button } from "./ui/button";
import { useContactMatches, type MatchInput } from "../queries/people";

/**
 * "Already in Ops" box, shown while a new card is typed.
 *
 * A person should exist once. When the mobile, email or full name typed in
 * already belongs to a card, this offers that card instead of a second one.
 * The caller decides what "use that card" means (open it, pick it, file it
 * under a company).
 */

export interface ContactMatch {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  suburb: string | null;
  reasons: string[];
}

const REASON: Record<string, string> = { mobile: "same mobile", email: "same email", name: "same name" };

export function ContactMatches({
  input,
  onUse,
  busyId,
  useLabel = "Use that card",
}: {
  input: MatchInput;
  onUse: (m: ContactMatch) => void;
  /** Card being used right now, shows a busy button. */
  busyId?: number | null;
  useLabel?: string;
}) {
  const q = useContactMatches(input);
  const rows = (q.data ?? []) as ContactMatch[];
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-[var(--gold)]/60 bg-[var(--gold)]/10 p-3" aria-live="polite">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
        <UserCheck className="size-4" /> Already in Ops
      </p>
      <ul className="mt-2 space-y-2">
        {rows.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{m.name || "No name"}</span>
              <span className="text-xs text-muted-foreground"> card #{m.id}</span>
              <span className="text-muted-foreground">
                {[m.mobile, m.email, m.suburb].filter(Boolean).length ? ` · ${[m.mobile, m.email, m.suburb].filter(Boolean).join(" · ")}` : ""}
              </span>
              <span className="block text-xs text-muted-foreground">{m.reasons.map((r) => REASON[r] ?? r).join(", ")}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => onUse(m)} disabled={busyId === m.id}>
              {useLabel}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
