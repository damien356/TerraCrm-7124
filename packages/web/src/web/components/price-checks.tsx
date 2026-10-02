import * as React from "react";
import { Check, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { moneyExact, shortDate } from "../lib/money";
import { useApproveFlag, useIgnoreFlag, useInvoicePriceChecks, useRecheckInvoice, usePriceChecks } from "../queries/price-checks";

/**
 * PRICE CHECKS ON SUPPLIER INVOICES.
 *
 * A rate on an invoice that differs from the Ops price list or the supplier's
 * charges. Approve update changes that one rate and logs which invoice it came
 * off. Ignore leaves the price list alone. Nothing changes by itself.
 */

export type PriceFlag = NonNullable<ReturnType<typeof usePriceChecks>["data"]>["open"][number];

const KIND: Record<string, { label: string; colour: string }> = {
  product_cost: { label: "Price list", colour: "#D08A1E" },
  special_missed: { label: "Special missed", colour: "#C0603F" },
  invoice_special: { label: "Special price", colour: "#3F7D3A" },
  product_other: { label: "Price", colour: "#D08A1E" },
  fee_amount: { label: "Charge", colour: "#D08A1E" },
  fee_percent: { label: "Surcharge %", colour: "#D08A1E" },
  fee_basis: { label: "Surcharge", colour: "#D08A1E" },
  freight: { label: "Freight", colour: "#C0603F" },
  new_charge: { label: "New charge", colour: "#C0603F" },
  missing_charge: { label: "No surcharge", colour: "#4A7FA5" },
};
export const flagKind = (k: string) => KIND[k] ?? { label: "Price", colour: "#D08A1E" };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

/** "$1.76 more on this invoice" or "$140.00 less". */
function Impact({ n }: { n: number }) {
  if (Math.abs(n) < 0.005) return null;
  return (
    <span className={n > 0 ? "tabular text-sm font-semibold text-[var(--warning)]" : "tabular text-sm font-semibold text-[var(--success)]"}>
      {n > 0 ? "+" : "-"}
      {moneyExact(Math.abs(n))}
    </span>
  );
}

/** One price check, with its two buttons while it is open. */
export function PriceFlagRow({ f, showWhere = true, onInvoice }: { f: PriceFlag; showWhere?: boolean; onInvoice?: (id: number) => void }) {
  const approve = useApproveFlag();
  const ignore = useIgnoreFlag();
  const [error, setError] = React.useState("");
  const busy = approve.isPending || ignore.isPending;
  const meta = flagKind(f.kind);

  async function run(p: Promise<unknown>) {
    setError("");
    try {
      await p;
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge colour={meta.colour}>{meta.label}</Badge>
            {showWhere ? (
              onInvoice ? (
                <button type="button" onClick={() => onInvoice(f.invoiceId)} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                  {f.supplierName} · invoice {f.invoiceNumber}
                  {f.invoiceDate ? ` · ${shortDate(f.invoiceDate)}` : ""}
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  {f.supplierName} · invoice {f.invoiceNumber}
                </span>
              )
            ) : null}
            {f.status === "approved" ? <Badge colour="#3F7D3A">Updated</Badge> : f.status === "ignored" ? <Badge colour="#A9A29B">Ignored</Badge> : null}
          </div>
          <p className="mt-1 text-sm font-medium">{f.title}</p>
          <p className="text-xs text-muted-foreground">{f.status === "open" ? f.detail : f.outcome}</p>
        </div>
        <Impact n={f.impactExGst} />
      </div>
      {f.status === "open" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy || !f.canApprove}
            title={f.canApprove ? "Change this one rate in Ops" : "Nothing in the price list to change. Sort it with the supplier, then Ignore."}
            onClick={() => run(approve.mutateAsync({ id: f.id }))}
          >
            <Check /> Approve update
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(ignore.mutateAsync({ id: f.id }))}>
            <X /> Ignore
          </Button>
          {busy ? <Spinner /> : null}
          {!f.canApprove ? <span className="text-[11px] text-muted-foreground">Nothing to change in Ops.</span> : null}
        </div>
      ) : null}
      {error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The price checks on one invoice, for the invoice panel. */
export function InvoicePriceChecks({ invoiceId }: { invoiceId: number }) {
  const q = useInvoicePriceChecks(invoiceId);
  const recheck = useRecheckInvoice();
  const flags = q.data ?? [];
  const open = flags.filter((f) => f.status === "open").length;

  return (
    <div className="rounded-md border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <p className="flex-1 text-xs font-semibold">
          Prices against the Ops price list
          {open ? <span className="ml-1.5 font-normal text-[var(--warning)]">{open} to look at</span> : null}
        </p>
        <Button size="sm" variant="ghost" disabled={recheck.isPending} onClick={() => recheck.mutate({ invoiceId })}>
          {recheck.isPending ? <Spinner /> : <RotateCcw />} Check again
        </Button>
      </div>
      {q.isLoading ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">Checking…</p>
      ) : flags.length === 0 ? (
        <p className="px-3 py-2.5 text-xs text-muted-foreground">Every rate on this invoice matches Ops, or is out by $10 or less.</p>
      ) : (
        <ul className="divide-y divide-border">
          {flags.map((f) => (
            <li key={f.id}>
              <PriceFlagRow f={f} showWhere={false} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
