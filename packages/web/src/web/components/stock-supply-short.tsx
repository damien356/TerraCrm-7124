import * as React from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/field";
import { type SupplyShortRow, useApproveShort, useQuoteSupply } from "../queries/stockSupply";

/* ---------------------------------------------------------------------------
 * A2 (7D): a container or stock-only product short on a quote or a sale.
 * Shown before the quote goes out or the sale is raised. Only the main admin
 * can approve going ahead short, with a note. Nothing is ordered or refunded.
 * ------------------------------------------------------------------------- */

export function SupplyShortList({
  shorts,
  canApprove,
  entityType,
  entityKey,
  onApproved,
  afterSend,
}: {
  shorts: SupplyShortRow[];
  canApprove: boolean;
  entityType: "quote" | "sale";
  entityKey: string | null;
  onApproved?: () => void;
  /** The quote is already out: what stops now is accepting it. */
  afterSend?: boolean;
}) {
  if (!shorts.length) return null;
  const open = shorts.filter((s) => !s.approved);
  return (
    <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="supply-short">
      <p className="font-semibold">
        {open.length
          ? `${entityType === "quote" ? (afterSend ? "This quote can not be accepted" : "This quote can not be sent") : "This sale can not be raised as an invoice"} until ${open.length === 1 ? "this line is" : "these lines are"} changed or the owner approves.`
          : "Shortage approved by the owner."}
      </p>
      <div className="mt-1 grid gap-2">
        {shorts.map((s) => (
          <ShortRow key={s.productId} s={s} canApprove={canApprove} entityType={entityType} entityKey={entityKey} onApproved={onApproved} />
        ))}
      </div>
    </div>
  );
}

function ShortRow({
  s,
  canApprove,
  entityType,
  entityKey,
  onApproved,
}: {
  s: SupplyShortRow;
  canApprove: boolean;
  entityType: "quote" | "sale";
  entityKey: string | null;
  onApproved?: () => void;
}) {
  const approve = useApproveShort();
  const [note, setNote] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  return (
    <div>
      <p>{s.text}</p>
      {s.approved ? (
        <p className="text-xs">
          Approved by {s.approved.byName}: {s.approved.note}
        </p>
      ) : canApprove && entityKey && s.short != null ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <Input className="h-7 w-64 bg-white" placeholder="Why it is OK to go ahead short" value={note} onChange={(e) => setNote(e.target.value)} />
          <Button
            size="sm"
            variant="outline"
            disabled={approve.isPending || note.trim().length < 5}
            onClick={async () => {
              setMsg(null);
              try {
                await approve.mutateAsync({ entityType, entityKey, productId: s.productId, shortQty: s.short!, note });
                onApproved?.();
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Approve going ahead short
          </Button>
          {msg ? <span className="text-xs">{msg}</span> : null}
        </div>
      ) : !canApprove ? (
        <p className="text-xs">Only the owner can approve this. Ask Damien, or change the line.</p>
      ) : null}
    </div>
  );
}

/** For the Send quote screen. Reads the quote as saved. */
export function QuoteSupplyShort({ quoteId, afterSend }: { quoteId: number; afterSend?: boolean }) {
  const q = useQuoteSupply(quoteId);
  if (!q.data?.shorts.length) return null;
  return <SupplyShortList shorts={q.data.shorts} canApprove={q.data.canApprove} entityType="quote" entityKey={String(quoteId)} afterSend={afterSend} onApproved={() => q.refetch()} />;
}
