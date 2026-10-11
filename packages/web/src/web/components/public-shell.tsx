import * as React from "react";
import { CreditCard } from "lucide-react";
import { moneyExact } from "../lib/money";

/**
 * The frame around the no-login client pages (/q, /m and /pay). No sidebar, no
 * sign-in, nothing from the office. Charcoal bar with the logo, stone page.
 */
export function PublicShell({ children }: { children: React.ReactNode }) {
  React.useEffect(() => {
    const prev = document.title;
    document.title = "Terra Flooring";
    return () => {
      document.title = prev;
    };
  }, []);
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="page-chrome">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <img src="/images/terra-logo-reverse.png" alt="Terra Flooring" className="h-10 w-auto" />
          <a href="mailto:team@terraflooring.com.au" className="text-xs font-medium text-[var(--gold-pale)] hover:underline">
            team@terraflooring.com.au
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-5 sm:py-8">{children}</main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 text-center text-[11px] text-muted-foreground">
        Arclan Pty Ltd trading as Terra Flooring
      </footer>
    </div>
  );
}

export function PublicCard({ title, children, className = "" }: { title?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card-surface mb-4 overflow-hidden ${className}`}>
      {title ? (
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3">
          <span className="h-3 w-[3px] shrink-0 rounded-full bg-[var(--gold)]" />
          <h2 className="text-sm font-semibold tracking-[-0.01em]">{title}</h2>
        </div>
      ) : null}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function PublicMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <PublicCard>
      <div className="py-6 text-center">
        <h1 className="text-lg font-bold tracking-[-0.015em]">{title}</h1>
        {children ? <div className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{children}</div> : null}
      </div>
    </PublicCard>
  );
}

export function errorText(e: unknown) {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/* Shared by /q and /v: how to pay, and saving the PDF. */

type Bank = { name: string; bsb: string; account: string };

export function BankDetails({ bank, reference, amount }: { bank: Bank; reference: string; amount?: number }) {
  return (
    <div className="rounded-lg bg-[var(--gold-wash)] px-4 py-3 text-sm">
      <p className="mb-1 font-semibold">Pay by bank transfer</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
        <dt className="text-muted-foreground">Account name</dt>
        <dd>{bank.name}</dd>
        <dt className="text-muted-foreground">BSB</dt>
        <dd className="tabular">{bank.bsb}</dd>
        <dt className="text-muted-foreground">Account</dt>
        <dd className="tabular">{bank.account}</dd>
        <dt className="text-muted-foreground">Reference</dt>
        <dd className="tabular font-semibold">{reference}</dd>
        {amount != null ? (
          <>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular font-semibold">{moneyExact(amount)}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

export function PayByCard({ url, amount }: { url: string; amount: number }) {
  return (
    <div className="mb-3 flex flex-col items-center gap-1">
      <a
        href={url}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--gold)] px-5 text-sm font-semibold text-white shadow-sm hover:brightness-95"
      >
        <CreditCard className="size-4" />
        Pay {moneyExact(amount)} by card
      </a>
      <p className="text-xs text-muted-foreground">Secure payment through Stripe. No card surcharge.</p>
    </div>
  );
}

export function downloadBase64(filename: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
