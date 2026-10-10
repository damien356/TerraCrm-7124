import * as React from "react";
import { useParams } from "wouter";
import { Check, CreditCard } from "lucide-react";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/card";
import { PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { moneyExact } from "../lib/money";
import { useConfirmCardPayment, usePublicPay, useStartCardPayment } from "../queries/publicPages";

/**
 * /pay/<token>: pay one client invoice (deposit, final, variation) by card.
 * No login. Stripe takes the card; there is no surcharge. Coming back from
 * Stripe the server asks Stripe itself whether it was paid, so this page only
 * shows the answer. Bank transfer details stay as an option.
 */

function BankBlock({ bank, reference, amount }: { bank: { name: string; bsb: string; account: string }; reference: string; amount: number }) {
  return (
    <div className="rounded-lg bg-[var(--gold-wash)] px-4 py-3 text-sm">
      <p className="mb-1 font-semibold">Or pay by bank transfer</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        <dt className="text-muted-foreground">Account name</dt>
        <dd>{bank.name}</dd>
        <dt className="text-muted-foreground">BSB</dt>
        <dd className="tabular">{bank.bsb}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="tabular">{bank.account}</dd>
        <dt className="text-muted-foreground">Reference</dt>
        <dd className="tabular font-semibold">{reference}</dd>
        <dt className="text-muted-foreground">Amount</dt>
        <dd className="tabular font-semibold">{moneyExact(amount)}</dd>
      </dl>
    </div>
  );
}

export default function PublicPayPage() {
  const { token = "" } = useParams<{ token: string }>();
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const sessionId = params.get("session");
  const cancelled = params.get("cancelled") === "1";

  const page = usePublicPay(token);
  const start = useStartCardPayment();
  const confirm = useConfirmCardPayment();
  const [error, setError] = React.useState<string | null>(null);

  // Back from Stripe: confirm once, then tidy the address bar so a refresh does not ask again.
  const asked = React.useRef(false);
  React.useEffect(() => {
    if (!sessionId || asked.current) return;
    asked.current = true;
    confirm.mutate(
      { token, sessionId },
      { onSettled: () => window.history.replaceState(null, "", window.location.pathname) },
    );
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
  const justPaid = confirm.data && (confirm.data.result === "paid" || confirm.data.result === "part_paid" || confirm.data.result === "already_counted");

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
      {justPaid && inv.owing <= 0 ? (
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
      {confirm.data?.result === "not_confirmed" ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          We could not confirm the payment yet. If your card was charged it will show here within a few minutes. Please do not pay twice.
        </div>
      ) : null}
      {cancelled && !justPaid ? (
        <div className="mb-4 rounded-lg border border-border bg-card px-4 py-2.5 text-sm text-muted-foreground">
          Payment cancelled. Nothing was charged.
        </div>
      ) : null}

      <PublicCard>
        <p className="label-xs">{inv.kindLabel} invoice</p>
        <h1 className="text-2xl font-bold tracking-[-0.015em]">{inv.ref}</h1>
        {inv.label ? <p className="mt-0.5 text-sm text-muted-foreground">{inv.label}</p> : null}
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          {inv.to ? (
            <div>
              <p className="label-xs">For</p>
              <p className="font-medium">{inv.to}</p>
            </div>
          ) : null}
          {inv.siteAddress ? (
            <div>
              <p className="label-xs">Site</p>
              <p>{inv.siteAddress}</p>
            </div>
          ) : null}
        </div>
        <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total inc GST</dt>
            <dd className="tabular">{moneyExact(inv.total)}</dd>
          </div>
          {inv.amountPaid > 0 ? (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Received</dt>
              <dd className="tabular">{moneyExact(inv.amountPaid)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between text-base font-bold">
            <dt>To pay</dt>
            <dd className="tabular">{moneyExact(inv.owing)}</dd>
          </div>
        </dl>
      </PublicCard>

      {inv.status === "void" ? (
        <PublicMessage title="This invoice has been cancelled">Nothing is owing on it. Reply to our email if you have a question.</PublicMessage>
      ) : inv.owing <= 0 && !justPaid ? (
        <PublicMessage title="This invoice is paid">Thank you. Nothing is owing on {inv.ref}.</PublicMessage>
      ) : inv.owing > 0 ? (
        <PublicCard title="Pay this invoice">
          <div className="flex flex-col gap-3">
            {inv.cardPayments ? (
              <>
                <Button size="lg" onClick={pay} disabled={start.isPending} className="w-full sm:w-auto sm:self-start">
                  {start.isPending ? <Spinner /> : <CreditCard className="size-4" />}
                  Pay {moneyExact(inv.owing)} by card
                </Button>
                <p className="text-xs text-muted-foreground">
                  Secure payment through Stripe. Visa, Mastercard, Amex, Apple Pay and Google Pay. No card surcharge.
                </p>
              </>
            ) : null}
            {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <BankBlock bank={inv.bank} reference={inv.ref} amount={inv.owing} />
          </div>
        </PublicCard>
      ) : null}
    </PublicShell>
  );
}
