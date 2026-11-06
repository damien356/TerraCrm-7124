import * as React from "react";
import { Card, CardHeader } from "./ui/card";
import { Field, Input } from "./ui/field";
import { DISPOSAL_COST_KEY, DISPOSAL_MARKUP_KEY, settingNumber } from "../../api/lib/quote-default-rules";
import { sellAtMarkup } from "../../api/lib/pricing";

/**
 * Quote defaults (6 Nov): Terra's carpet disposal through the shop skip bin.
 * Per m² of carpet uplifted. Admin only (the keys say cost and markup).
 * Blank means not set: a new disposal line then goes on at $0, flagged.
 */
export function CarpetDisposalCard({
  draft,
  setDraft,
  commit,
  tick,
}: {
  draft: Record<string, string>;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  commit: (key: string, value: string) => void;
  tick: (key: string) => React.ReactNode;
}) {
  const cost = settingNumber(draft[DISPOSAL_COST_KEY]);
  const pct = settingNumber(draft[DISPOSAL_MARKUP_KEY]);
  const tidy = (raw: string, max: number) => {
    const n = Number(raw);
    return raw.trim() === "" || !Number.isFinite(n) ? "" : String(Math.min(max, Math.max(0, Math.round(n * 100) / 100)));
  };
  return (
    <Card>
      <CardHeader
        title="Carpet disposal"
        subtitle="Carpet uplift brings a Terra disposal line with it, for the shop skip bin. It is a job cost, not installer pay, and never a PO or a bill."
      />
      <div className="space-y-4 px-4 py-4">
        <Field label="Cost per m² ($, ex GST)" hint="What disposal costs Terra for each m² of carpet uplifted. Blank means not set, and a new disposal line is flagged.">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Carpet disposal cost per m²"
              inputMode="decimal"
              value={draft[DISPOSAL_COST_KEY] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [DISPOSAL_COST_KEY]: e.target.value }))}
              onBlur={(e) => commit(DISPOSAL_COST_KEY, tidy(e.target.value, 10000))}
              className="tabular w-24"
            />
            {tick(DISPOSAL_COST_KEY)}
          </div>
        </Field>
        <Field label="Markup (%)" hint="What the client pays over cost. New disposal lines only. Lines already on a quote keep their price.">
          <div className="flex items-center gap-2">
            <Input
              aria-label="Carpet disposal markup %"
              inputMode="decimal"
              value={draft[DISPOSAL_MARKUP_KEY] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [DISPOSAL_MARKUP_KEY]: e.target.value }))}
              onBlur={(e) => commit(DISPOSAL_MARKUP_KEY, tidy(e.target.value, 1000))}
              className="tabular w-24"
            />
            {tick(DISPOSAL_MARKUP_KEY)}
          </div>
        </Field>
        <p className="text-xs text-muted-foreground">
          {cost != null && pct != null
            ? `Quotes at $${sellAtMarkup(cost, pct).toFixed(2)} per m², ex GST.`
            : "Not set. Disposal lines go on at $0 and are flagged until this is filled in."}
        </p>
      </div>
    </Card>
  );
}
