import * as React from "react";

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
