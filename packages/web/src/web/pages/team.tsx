import * as React from "react";
import { HardHat, KeyRound, ShieldCheck } from "lucide-react";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Select } from "../components/ui/field";
import { useLinkLogin, useLogins, useSetLoginActive, useSetLoginRole } from "../queries/team";
import { useInstallers } from "../queries/installers";

function when(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

export default function TeamPage() {
  const logins = useLogins();
  const installers = useInstallers();
  const link = useLinkLogin();
  const setRole = useSetLoginRole();
  const setActive = useSetLoginActive();
  const [error, setError] = React.useState<string | null>(null);

  const busy = link.isPending || setRole.isPending || setActive.isPending;

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Page
      title="Logins"
      subtitle="Every account that has signed in. A login on its own gives someone nothing — you decide here whether it's an office login or which installer card it belongs to."
    >
      <Card className="mb-4 p-4 text-sm leading-relaxed text-muted-foreground">
        <p className="mb-2 flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="size-4 text-primary" />
          How access works
        </p>
        <ul className="list-inside list-disc space-y-1">
          <li>
            <strong className="text-foreground">Office</strong> — full access: pricing, quotes, invoices, every job and
            every installer.
          </li>
          <li>
            <strong className="text-foreground">Field crew</strong> — the installer app only, and only the tasks you
            dispatch to them. Never a price, a quote or another installer's work.
          </li>
          <li>
            A field crew login sees <em>nothing at all</em> until you link it to an installer card below. That's the
            &ldquo;Field crew account&rdquo; screen they get in the office app.
          </li>
          <li>The first account to ever sign in was made office automatically. Everyone after that starts as field crew.</li>
        </ul>
      </Card>

      {error ? (
        <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {logins.isPending ? (
        <Loading label="Loading logins…" />
      ) : !logins.data || logins.data.length === 0 ? (
        <Empty>No logins yet. The first person to create an account becomes the office admin.</Empty>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="th px-4">Person</th>
                <th className="th px-4">Access</th>
                <th className="th px-4">Installer card</th>
                <th className="th px-4">Signed up</th>
                <th className="th px-4">Last signed in</th>
                <th className="th px-4" aria-label="Row actions" />
              </tr>
            </thead>
            <tbody>
              {logins.data.map((row) => (
                <tr key={row.id} className="border-b border-border/40 last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{row.name || row.email}</div>
                    <div className="text-xs text-muted-foreground">{row.email}</div>
                    {!row.active ? (
                      <Badge className="mt-1 bg-destructive/10 text-destructive">Switched off</Badge>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Select
                      value={row.role}
                      disabled={busy}
                      onChange={(e) =>
                        run(() =>
                          setRole.mutateAsync({
                            profileId: row.id,
                            role: e.target.value as "admin" | "installer",
                          }),
                        )
                      }
                      className="w-[150px]"
                    >
                      <option value="admin">Office</option>
                      <option value="installer">Field crew</option>
                    </Select>
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      {row.role === "admin" ? (
                        <>
                          <ShieldCheck className="size-3" /> Sees everything
                        </>
                      ) : (
                        <>
                          <HardHat className="size-3" /> Own tasks only
                        </>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.role === "admin" && row.installerId === null ? (
                      <span className="text-xs text-muted-foreground">Not needed for office logins</span>
                    ) : null}
                    <Select
                      value={row.installerId === null ? "" : String(row.installerId)}
                      disabled={busy}
                      onChange={(e) =>
                        run(() =>
                          link.mutateAsync({
                            profileId: row.id,
                            installerId: e.target.value === "" ? null : Number(e.target.value),
                          }),
                        )
                      }
                      className="w-[200px]"
                    >
                      <option value="">Not linked</option>
                      {(installers.data ?? []).map((inst) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name}
                        </option>
                      ))}
                    </Select>
                    {row.role === "installer" && row.installerId === null ? (
                      <div className="mt-1 text-xs text-amber-600">Can't see any work yet</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{when(row.signedUpAt)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{when(row.lastSeenAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => run(() => setActive.mutateAsync({ profileId: row.id, active: !row.active }))}
                    >
                      {busy ? <Spinner className="border-foreground/20 border-t-foreground" /> : null}
                      {row.active ? "Switch off" : "Switch on"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </Page>
  );
}
