import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { useIsMainAdmin } from "./person-archive";

/* ---------------------------------------------------------------------------
 * A2 follow-up: Send or Mark sent stopped because stock now covers part of
 * the PO. The office fixes the PO; only the main admin can go ahead with a
 * reason, which is kept in the activity log.
 * ------------------------------------------------------------------------- */

/** The overlap lines carried on a refused Send or Mark sent. Empty: some other error. */
export function overlapOf(e: unknown): string[] {
  const d = (e as { data?: { poOverlap?: unknown } } | null)?.data?.poOverlap;
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === "string") : [];
}

export function PoOverlapNotice({ lines, action, busy, onOverride }: { lines: string[]; action: string; busy: boolean; onOverride: (reason: string) => void }) {
  const mainAdmin = useIsMainAdmin();
  const [reason, setReason] = React.useState("");
  if (!lines.length) return null;
  return (
    <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="po-overlap">
      <p className="flex items-start gap-1.5 font-semibold">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        Not {action}. Stock now covers part of this PO.
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {mainAdmin ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input className="h-8 w-72 bg-white" placeholder="Why it is OK to go ahead as it is" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button size="sm" variant="outline" disabled={busy || reason.trim().length < 5} onClick={() => onOverride(reason.trim())}>
            Go ahead anyway (main admin)
          </Button>
        </div>
      ) : (
        <p className="mt-1 text-xs">Change the PO first. Only the main admin can go ahead without changing it.</p>
      )}
    </div>
  );
}
