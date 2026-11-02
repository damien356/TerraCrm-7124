import * as React from "react";
import { UserCheck } from "lucide-react";
import { Card, CardHeader, Empty, Loading, Spinner } from "./ui/card";
import { Select } from "./ui/field";
import { useUpdateInstaller, useWorkerReview } from "../queries/installers";

/**
 * People page, Admin only (Damien, 2 Nov). Current cards with no worker type
 * yet. Nothing is set from the ABN: each person is picked by hand here or on
 * their profile. The login level, booking and skills don't change.
 */
export function WorkerTypeReview({ onOpen }: { onOpen: (installerId: number) => void }) {
  const q = useWorkerReview();
  const update = useUpdateInstaller();
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function pick(id: number, workerType: "employee" | "subcontractor") {
    setError(null);
    setBusy(id);
    try {
      await update.mutateAsync({ id, workerType });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const d = q.data;
  return (
    <Card className="mt-4" data-testid="worker-type-review">
      <CardHeader
        title="Worker type to review"
        subtitle={
          d
            ? `${d.unclassified.length} not set yet. ${d.employees} employee${d.employees === 1 ? "" : "s"}, ${d.subcontractors} subcontractor${d.subcontractors === 1 ? "" : "s"}. Employees need no ABN or contractor invoicing.`
            : "Current people with no worker type yet."
        }
        action={<UserCheck className="size-4 text-muted-foreground" />}
      />
      {q.isPending ? (
        <Loading label="Loading worker types" />
      ) : q.isError ? (
        <Empty>Couldn't load worker types. {q.error.message}</Empty>
      ) : !d || d.unclassified.length === 0 ? (
        <Empty>Everyone current has a worker type.</Empty>
      ) : (
        <div className="divide-y divide-border" aria-label="Worker type review list">
          {d.unclassified.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <button type="button" className="min-w-40 text-left font-medium text-primary hover:underline" onClick={() => onOpen(r.id)}>
                {r.name}
              </button>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {r.login}
                {r.fullName ? `. Full name ${r.fullName}` : ""}
                {r.hasAbn ? ". ABN on file" : ". No ABN on file"}
              </span>
              <div className="flex items-center gap-2">
                {busy === r.id ? <Spinner /> : null}
                <Select
                  aria-label={`Worker type for ${r.name}`}
                  value=""
                  disabled={busy !== null}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "employee" || v === "subcontractor") void pick(r.id, v);
                  }}
                >
                  <option value="">Pick one</option>
                  <option value="employee">Employee</option>
                  <option value="subcontractor">Subcontractor (ABN)</option>
                </Select>
              </div>
            </div>
          ))}
        </div>
      )}
      {error ? <p className="px-4 pb-3 text-sm text-destructive">{error}</p> : null}
    </Card>
  );
}
