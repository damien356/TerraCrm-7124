import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { useParams } from "wouter";
import { Spinner } from "../components/ui/card";
import { Field, Input } from "../components/ui/field";
import { PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { useInviteCheck, useInviteSetup } from "../queries/invites";

/**
 * /setup/<token>: the one-time link in a staff invite (notes 18.55). No
 * login. The person chooses their own password here. It works once, runs
 * out after 48 hours, and a newer invite stops it working.
 */

const TITLES: Record<string, string> = {
  used: "This link has already been used",
  expired: "This link has run out",
  replaced: "There is a newer invite",
  invalid: "This link is not valid",
  off: "This login is switched off",
};

export default function PublicSetupPage() {
  const { token = "" } = useParams<{ token: string }>();
  const check = useInviteCheck(token);
  const setup = useInviteSetup();
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<{ email: string; role: string } | null>(null);

  if (done) {
    const field = done.role === "field";
    return (
      <PublicShell>
        <PublicMessage title="You're set up">
          <p>
            Your username is <strong className="text-foreground">{done.email}</strong>.
          </p>
          <p className="mt-2">
            {field
              ? "Open the Terra app and sign in with that email and the password you just chose."
              : "Sign in with that email and the password you just chose."}
          </p>
          <div className="mt-5 flex flex-col gap-2">
            {field ? (
              <a href="/app" className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--gold)] px-5 text-sm font-semibold text-white shadow-sm hover:brightness-95">
                Get the Terra app
              </a>
            ) : (
              <a href="/login" className="inline-flex h-11 items-center justify-center rounded-lg bg-[var(--gold)] px-5 text-sm font-semibold text-white shadow-sm hover:brightness-95">
                Sign in to Terra Ops
              </a>
            )}
          </div>
        </PublicMessage>
      </PublicShell>
    );
  }

  if (check.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }
  if (check.error || !check.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open this link">{errorText(check.error ?? "Call the office on 1300 183 772.")}</PublicMessage>
      </PublicShell>
    );
  }
  const c = check.data;
  if (c.state !== "ok") {
    return (
      <PublicShell>
        <PublicMessage title={TITLES[c.state] ?? TITLES.invalid!}>{c.message}</PublicMessage>
      </PublicShell>
    );
  }

  const min = c.minPassword;
  const tooShort = password.length > 0 && password.length < min;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= min && confirm === password && !setup.isPending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      const r = await setup.mutateAsync({ token, password });
      setDone({ email: r.email, role: r.role });
    } catch (err) {
      setError(errorText(err));
      check.refetch();
    }
  }

  return (
    <PublicShell>
      <PublicCard title="Set up your Terra login">
        <form onSubmit={submit} className="grid gap-4">
          <p className="text-sm">
            Hi {c.firstName}. Choose a password for your Terra login. Your username is{" "}
            <strong>{c.email}</strong>.
          </p>
          {/* Lets the phone's password manager save the pair. */}
          <input type="email" name="username" autoComplete="username" aria-label="Username" value={c.email} readOnly hidden />
          <Field label="Password" hint={`At least ${min} characters.`}>
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-11 pr-11 text-base"
                aria-label="Password"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-muted-foreground"
                aria-label={show ? "Hide password" : "Show password"}
              >
                {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
          <Field label="Type it again">
            <Input
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="h-11 text-base"
              aria-label="Type the password again"
            />
          </Field>
          {tooShort ? <p className="text-sm text-muted-foreground">Use at least {min} characters.</p> : null}
          {mismatch ? <p className="text-sm text-destructive">The two passwords are not the same.</p> : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <button
            type="submit"
            disabled={!ready}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[var(--gold)] px-5 text-sm font-semibold text-white shadow-sm hover:brightness-95 disabled:opacity-50"
          >
            {setup.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Save my password
          </button>
          <p className="text-xs text-muted-foreground">
            This link works once and runs out {new Date(c.expiresAt).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Australia/Brisbane" })}. Any questions, call the office on 1300 183 772.
          </p>
        </form>
      </PublicCard>
    </PublicShell>
  );
}
