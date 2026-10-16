import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { BillToPicker, CardDepositPrompt } from "./bill-to";
import { useBillToOptions } from "../queries/billTo";
import { useUpdateJob } from "../queries/jobs";

/**
 * Who pays this job (notes 18.54). One company or one person, never empty.
 * A card with no deposit % yet is asked once here and the % saves on it.
 */
export function JobBillTo({ jobId, disabled }: { jobId: number; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const opts = useBillToOptions({ jobId });
  const update = useUpdateJob();
  const [error, setError] = React.useState<string | null>(null);
  const current = opts.data?.current ?? null;

  return (
    <div className="flex flex-col gap-1.5">
      <BillToPicker
        jobId={jobId}
        value={current ? { type: current.type, id: current.id } : null}
        disabled={disabled || update.isPending}
        onChange={(next) => {
          if (!next) return setError("Every job needs a Bill to. Pick a company or a person.");
          setError(null);
          update.mutate(
            next.type === "company"
              ? { id: jobId, billToType: "company", billToCompanyId: next.id }
              : { id: jobId, billToType: "contact", billToContactId: next.id },
            {
              onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.billTo.key() }),
              onError: (e) => setError(e.message),
            },
          );
        }}
      />
      {current && current.percent == null ? <CardDepositPrompt card={current} /> : null}
      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
