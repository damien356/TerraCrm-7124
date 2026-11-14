import * as React from "react";
import { Card, CardHeader, Loading } from "./ui/card";
import { Button } from "./ui/button";
import { usePaperwork, useSetPaperwork } from "../queries/paperwork";

/* ---------------------------------------------------------------------------
 * Who gets what (Damien, 14 Nov 2026, after quote 188101). Bold, under the
 * job's header. Each person on the job and the company, ticked for quotes,
 * variations and invoices. The server checks every send against these ticks,
 * To, CC and text. Anyone with all three off is listed under "Never gets
 * paperwork". Material selection is not paperwork, but its page only shows
 * prices to someone ticked for Quotes.
 * ------------------------------------------------------------------------- */

type Doc = "quote" | "variation" | "invoice";
const COLS: Array<{ doc: Doc; label: string }> = [
  { doc: "quote", label: "Quotes" },
  { doc: "variation", label: "Variations" },
  { doc: "invoice", label: "Invoices" },
];

export function WhoGetsWhatCard({ jobId }: { jobId: number }) {
  const q = usePaperwork(jobId);
  const set = useSetPaperwork();
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  if (q.isLoading) return <Card><Loading /></Card>;
  if (!q.data) return null;
  const rows = q.data.rows;
  const never = rows.filter((r) => !r.quote.on && !r.variation.on && !r.invoice.on);

  const change = (r: (typeof rows)[number], doc: Doc, on: boolean | null) => {
    setError(null);
    setBusy(`${r.key}:${doc}`);
    set.mutate(
      { jobId, contactId: r.contactId, companyId: r.companyId, doc, on },
      { onError: (e) => setError(e instanceof Error ? e.message : String(e)), onSettled: () => setBusy(null) },
    );
  };
  const reset = (r: (typeof rows)[number]) => {
    for (const c of COLS) if (r[c.doc].set) change(r, c.doc, null);
  };

  return (
    <Card className="border-2 border-foreground/70">
      <CardHeader
        title={<span className="text-base font-bold">Who gets what</span>}
        subtitle={`Who can be sent quotes, variations and invoices on this ${q.data.typeLabel.toLowerCase()} job. Checked on every email and text. Anyone not on this list can never be sent them.`}
      />
      <div className="overflow-x-auto px-4 py-3">
        {rows.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Person</th>
                {COLS.map((c) => (
                  <th key={c.doc} className="pb-2 px-2 text-center font-semibold text-foreground">{c.label}</th>
                ))}
                <th className="pb-2 pl-2">
                  <span className="sr-only">Reset</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const changed = r.quote.set || r.variation.set || r.invoice.set;
                return (
                  <tr key={r.key} className="border-t border-border align-top">
                    <td className="py-2 pr-3">
                      <p className="font-bold">{r.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {r.roleLabel}
                        {r.kind === "person" && !r.onJob ? ", not on People yet" : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">{[r.email, r.mobileShown].filter(Boolean).join(" · ") || "No email or mobile"}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{changed ? "Changed by hand. " : "Default. "}{r.defaultWhy}</p>
                    </td>
                    {COLS.map((c) => {
                      const t = r[c.doc];
                      return (
                        <td key={c.doc} className="px-2 py-2 text-center">
                          <label className="inline-flex cursor-pointer flex-col items-center gap-0.5">
                            <input
                              type="checkbox"
                              className="h-5 w-5 accent-[var(--gold)]"
                              checked={t.on}
                              disabled={busy === `${r.key}:${c.doc}`}
                              aria-label={`${r.name} gets ${c.label}`}
                              onChange={(e) => change(r, c.doc, e.target.checked)}
                            />
                            <span className={t.on ? "text-[11px] font-semibold" : "text-[11px] font-semibold text-red-700"}>{t.on ? "Yes" : "Never"}</span>
                          </label>
                        </td>
                      );
                    })}
                    <td className="py-2 pl-2 text-right">
                      {changed ? (
                        <Button size="sm" variant="outline" disabled={set.isPending} onClick={() => reset(r)}>
                          Back to default
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody on this job yet. Add people under People.</p>
        )}

        <div className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2">
          <p className="text-sm font-bold text-red-800">Never gets paperwork</p>
          {never.length ? (
            <ul className="mt-1 space-y-0.5">
              {never.map((r) => (
                <li key={r.key} className="text-sm font-bold text-red-800">
                  {r.name} <span className="font-normal">({r.roleLabel})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-red-800">Nobody. Everyone above gets at least one kind.</p>
          )}
          <p className="mt-1 text-xs text-red-800">They can still be sent the material selection form. It shows no prices to anyone not ticked for Quotes.</p>
        </div>

        {error ? <p className="mt-2 text-sm font-medium text-red-700">{error}</p> : null}
      </div>
    </Card>
  );
}
