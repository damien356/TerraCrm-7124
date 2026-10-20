import * as React from "react";
import { useParams } from "wouter";
import { Check, CreditCard } from "lucide-react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/card";
import { BankDetails, PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { longDate, moneyExact } from "../lib/money";
import { useTradeCheckout, useTradeConfirm, useTradePayState } from "../queries/trade";

/**
 * /tp/<token>: pay one trade materials invoice by card (notes 18.65). No login.
 * Totals only: no lines, no costs, no offsets, no agreements. Coming back from
 * Stripe the server asks Stripe whether it was paid, once, and the webhook
 * records it too; the unique Stripe id means it is only ever counted once.
 */
export default function PublicTradePayPage() {
  const { token = "" } = useParams<{ token: string }>();
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session");
  const cancelled = params.get("cancelled") === "1";

  const page = useTradePayState(token);
  const start = useTradeCheckout();
  const confirm = useTradeConfirm();
  const [error, setError] = React.useState<string | null>(null);

  const asked = React.useRef(false);
  React.useEffect(() => {
    if (!sessionId || asked.current) return;
    asked.current = true;
    confirm.mutate({ token, sessionId }, { onSettled: () => window.history.replaceState(null, "", window.location.pathname) });
  }, [sessionId, token, confirm]);

  if (page.isLoading || (sessionId && confirm.isPending)) {
    return (
      <PublicShell>
        <div className="flex flex-col items-center gap-3 py-20 text-sm text-muted-foreground">
          <Spinner />
          {sessionId ? "Checking your payment with the bank..." : null}
        </div>
      </PublicShell>
    );
  }
  if (page.error || !page.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open this invoice">{errorText(page.error ?? "This link is not valid.")}</PublicMessage>
      </PublicShell>
    );
  }

  const inv = confirm.data ?? page.data;
  const result = confirm.data?.result;
  const justPaid = result === "paid" || result === "part_paid" || result === "already_counted" || result === "over_paid";

  async function pay() {
    setError(null);
    try {
      const out = await start.mutateAsync({ token });
      window.location.href = out.url;
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <PublicShell>
      {justPaid && inv.owing <= 0.005 ? (
        <PublicCard>
          <div className="flex flex-col items-center py-4 text-center">
            <span className="mb-3 grid size-12 place-items-center rounded-full bg-[#3F7D3A]/12 text-[#3F7D3A]">
              <Check className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-[-0.015em]">Thank you, {inv.ref} is paid</h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">Your card payment went through. Stripe will email your receipt.</p>
          </div>
        </PublicCard>
      ) : null}
      {result === "not_confirmed" ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          We could not confirm the payment yet. If your card was charged it will show here within a few minutes. Please do not pay twice.
        </div>
      ) : null}
      {cancelled && !justPaid ? (
        <div className="mb-4 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground">Payment cancelled. Nothing was charged.</div>
      ) : null}

      <PublicCard>
        <p className="label-xs">Materials tax invoice</p>
        <h1 className="text-2xl font-bold tracking-[-0.015em]">{inv.ref}</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">For {inv.billName}</p>
        {inv.dueDate ? <p className="mt-0.5 text-sm text-muted-foreground">Due {longDate(inv.dueDate)}</p> : null}
        <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total inc GST</dt>
            <dd className="tabular">{moneyExact(inv.total)}</dd>
          </div>
          {inv.credited > 0.005 ? (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Credited</dt>
              <dd className="tabular">{moneyExact(-inv.credited)}</dd>
            </div>
          ) : null}
          {inv.paid > 0.005 ? (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Received</dt>
              <dd className="tabular">{moneyExact(-inv.paid)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between text-base font-bold">
            <dt>To pay</dt>
            <dd className="tabular">{moneyExact(inv.owing)}</dd>
          </div>
        </dl>
      </PublicCard>

      {inv.cancelled ? (
        <PublicMessage title="This invoice was cancelled">Nothing is owing on it. Call 1300 183 772 with any questions.</PublicMessage>
      ) : inv.owing > 0.005 ? (
        <PublicCard>
          {inv.canPay ? (
            <div className="mb-3 flex flex-col items-center gap-1">
              <Button size="lg" onClick={pay} disabled={start.isPending}>
                {start.isPending ? <Spinner className="border-white/30 border-t-white" /> : <CreditCard className="size-4" />}
                Pay {moneyExact(inv.owing)} by card
              </Button>
              <p className="text-xs text-muted-foreground">Secure payment through Stripe. No card surcharge.</p>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
            </div>
          ) : null}
          <BankDetails bank={inv.bank} reference={inv.ref} amount={inv.owing} />
        </PublicCard>
      ) : !justPaid ? (
        <PublicMessage title="Nothing to pay">This invoice is fully paid. Thank you.</PublicMessage>
      ) : null}
    </PublicShell>
  );
}
