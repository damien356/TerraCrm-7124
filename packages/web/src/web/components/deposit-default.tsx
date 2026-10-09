import * as React from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { useUpdateCompany } from "../queries/companies";
import { useUpdateContact } from "../queries/contacts";

/**
 * The deposit % new quotes start at, set on a company or contact card.
 * Mirrors api/lib/deposits.ts: blank on a company means 0% for a builder and
 * the QBCC cap for anyone else, blank on a contact means the QBCC cap. For
 * anyone but a builder the quote never starts above the cap, whatever the
 * card says. A company on the quote always beats the contact. Existing
 * quotes are never changed by this.
 */
export function DepositDefault({
  kind,
  id,
  value,
  companyType,
}: {
  kind: "company" | "contact";
  id: number;
  value: number | null;
  companyType?: string;
}) {
  const company = useUpdateCompany();
  const contact = useUpdateContact();
  const pending = company.isPending || contact.isPending;
  const [draft, setDraft] = React.useState(value == null ? "" : String(value));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(value == null ? "" : String(value)), [value]);

  const isBuilder = kind === "company" && companyType === "builder";
  const fallbackLabel = isBuilder ? "0%, the builder default" : "the QBCC cap for the quote total";

  async function save(next: number | null) {
    setError(null);
    try {
      if (kind === "company") await company.mutateAsync({ id, depositPercent: next });
      else await contact.mutateAsync({ id, depositPercent: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function commit() {
    const t = draft.trim();
    if (t === "") {
      if (value !== null) void save(null);
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

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Deposit on new quotes</p>
          <p className="text-xs text-muted-foreground">
            {value == null ? `Not set, so ${fallbackLabel}.` : "Set on this card."}
            {!isBuilder && value != null ? " Never above the QBCC cap for the quote total." : ""}
            {kind === "contact" ? " A company on the quote wins." : ""}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Input
            aria-label="Deposit % on new quotes"
            className="tabular h-8 w-[64px] text-right"
            inputMode="decimal"
            placeholder={isBuilder ? "0" : "cap"}
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <span className="text-xs text-muted-foreground">%</span>
        </span>
      </div>
      {value != null ? (
        <Button variant="ghost" className="h-6 self-start px-1.5 text-xs" disabled={pending} onClick={() => save(null)}>
          Use the default ({isBuilder ? "0%" : "QBCC cap"})
        </Button>
      ) : null}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
