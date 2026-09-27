import * as React from "react";
import { authClient } from "../lib/auth";
import { Button } from "../components/ui/button";
import { Field, Input } from "../components/ui/field";
import { Spinner } from "../components/ui/card";

export default function LoginPage() {
  const [mode, setMode] = React.useState<"signin" | "signup">("signin");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState<"none" | "email" | "google">("none");
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
      const res =
        mode === "signin"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name || email.split("@")[0]! });
      if (res.error) throw new Error(res.error.message ?? "Sign in failed");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy("none");
    }
  }

  async function google() {
    setError(null);
    setBusy("google");
    try {
      await authClient.managedAuth.signIn({ provider: "google" });
      window.location.href = "/";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Closing the Google popup isn't a failure worth shouting about.
      if (!message.includes("POPUP_CLOSED")) setError(message);
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
          <h2 className="text-xl font-semibold">{mode === "signin" ? "Sign in" : "Create your account"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin" ? "Office access to Terra Ops." : "The first account created becomes the admin."}
          </p>

          <Button
            type="button"
            variant="outline"
            className="mt-6 w-full"
            disabled={busy !== "none"}
            onClick={google}
          >
            {busy === "google" ? <Spinner /> : null}
            Continue with Google
          </Button>

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={submit} className="space-y-3">
            {mode === "signup" ? (
              <Field label="Your name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Damien Lacey" />
              </Field>
            ) : null}
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
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </Field>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <Button
              type="submit"
              className="w-full bg-[#BC9558] text-[#1C1B1A] hover:bg-[#C4A56B] focus-visible:ring-[#BC9558]"
              disabled={busy !== "none"}
            >
              {busy === "email" ? <Spinner className="border-[#1C1B1A]/30 border-t-[#1C1B1A]" /> : null}
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          <button
            type="button"
            className="mt-4 text-sm text-muted-foreground transition-colors hover:text-primary"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
            }}
          >
            {mode === "signin" ? "No account yet? Create one" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
