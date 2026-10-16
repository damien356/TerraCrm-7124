import * as React from "react";
import { authClient } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
import { Spinner } from "../components/ui/card";

export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState<"none" | "email">("none");
  const [error, setError] = React.useState<string | null>(null);

  const session = authClient.useSession();
  React.useEffect(() => {
    if (session.data) window.location.href = "/";
  }, [session.data]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy("email");
    try {
      // Sign in only. Logins are made by an Admin in Admin, People.
      const res = await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy("none");
    }
  }

  return (
    <div className="flex min-h-screen">
      <div className="hidden flex-1 flex-col justify-between bg-[var(--sidebar)] px-10 py-12 lg:flex">
        <div>
          <img src="/images/terra-logo-reverse.png" alt="Terra Flooring" className="h-24 w-auto" />
          <p className="mt-4 text-lg font-semibold text-white">Terra Ops</p>
          <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-white/40">Terra Flooring</p>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight text-white">
            Quotes, jobs and the crew. <span className="text-primary">One board.</span>
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-white/55">
            Every job broken into the dispatches it actually is: tile removal, prep, lay, skirting, silicone. Each
            one goes to an installer who's ticked for that skill, at their rate, with their pay shown up front.
          </p>
        </div>
        <p className="text-xs text-white/30">Gold Coast · Established flooring trade since 2008</p>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">Sign in</h2>
          <p className="mt-1 text-sm text-muted-foreground">Office access to Terra Ops.</p>

          <form onSubmit={submit} className="mt-6 space-y-3">
            <Field label="Email">
              <Input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@terraflooring.com.au"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                required
                minLength={8}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
              />
            </Field>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button
              type="submit"
              className="w-full bg-[#BC9558] text-[#1C1B1A] hover:bg-[#C4A56B] focus-visible:ring-[#BC9558]"
              disabled={busy !== "none"}
            >
              {busy === "email" ? <Spinner className="border-[#1C1B1A]/30 border-t-[#1C1B1A]" /> : null}
              Sign in
            </Button>
          </form>

          <p className="mt-4 text-sm text-muted-foreground">No login yet? Ask the office to add you.</p>
        </div>
      </div>
    </div>
  );
}
