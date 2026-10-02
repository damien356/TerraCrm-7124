import * as React from "react";
import { Link } from "wouter";
import { CheckCircle2, Copy, Inbox, Link2Off, LogIn, RefreshCw, TriangleAlert } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/field";
import { useCheckMailNow, useConnectMailbox, useDisconnectMailbox, useMailStatus } from "../queries/mail";
import { useSetAutoSend } from "../queries/payables";

/**
 * EMAIL AGENT (Settings).
 *
 * Connect billing@, damien@ and team@ so the agent can read supplier invoices
 * and statements. Read only on all three. team@ also gets send, because POs
 * and missing-invoice requests go from there. Each mailbox is signed into as
 * itself, not as Damien.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;

/** The ?mail=connected|error&reason= Google sends Damien back with. Read once, then cleared from the address bar. */
function useReturnNotice() {
  const [notice] = React.useState(() => {
    const p = new URLSearchParams(window.location.search);
    const mail = p.get("mail");
    if (!mail) return null;
    return mail === "connected"
      ? { ok: true, text: `${p.get("address") ?? "Mailbox"} is connected. The agent reads it every 15 minutes.` }
      : { ok: false, text: p.get("reason") || "Google sign-in didn't finish." };
  });
  React.useEffect(() => {
    if (!notice) return;
    const p = new URLSearchParams(window.location.search);
    for (const k of ["mail", "reason", "address"]) p.delete(k);
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, [notice]);
  return notice;
}

export function EmailAgentCard() {
  const q = useMailStatus();
  const connect = useConnectMailbox();
  const disconnect = useDisconnectMailbox();
  const checkNow = useCheckMailNow();
  const setAuto = useSetAutoSend();
  const notice = useReturnNotice();
  const [error, setError] = React.useState("");
  const [checkMsg, setCheckMsg] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (window.location.hash === "#email-agent") ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const s = q.data;
  const anyConnected = s?.mailboxes.some((m) => m.connected) ?? false;

  async function go(address: string) {
    setError("");
    try {
      const { url } = await connect.mutateAsync({ address });
      window.location.href = url;
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div id="email-agent" ref={ref} className="scroll-mt-4">
      <Card>
        <CardHeader
          title="Email agent"
          subtitle="Reads supplier invoices and statements from three mailboxes and matches them to the POs raised on jobs."
          action={
            anyConnected ? (
              <Button
                size="sm"
                variant="outline"
                disabled={checkNow.isPending}
                onClick={async () => {
                  setError("");
                  setCheckMsg("");
                  try {
                    const r = await checkNow.mutateAsync({});
                    if (r.busy) return setCheckMsg("Already checking. Give it a minute.");
                    const inv = r.runs.reduce((a, x) => a + x.invoices, 0);
                    const st = r.runs.reduce((a, x) => a + x.statements, 0);
                    const errs = r.runs.reduce((a, x) => a + x.errors, 0);
                    setCheckMsg(
                      `${inv} new ${inv === 1 ? "invoice" : "invoices"}, ${st} ${st === 1 ? "statement" : "statements"}` +
                        (r.sent ? `, ${r.sent} ${r.sent === 1 ? "request" : "requests"} sent` : "") +
                        (errs ? `. ${errs} couldn't be read, see below.` : "."),
                    );
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                {checkNow.isPending ? <Spinner /> : <RefreshCw />}
                Check now
              </Button>
            ) : null
          }
        />
        {q.isLoading ? (
          <Loading />
        ) : !s ? (
          <p className="px-4 py-4 text-sm text-destructive">{errText(q.error) || "Couldn't load the email agent."}</p>
        ) : (
          <div className="space-y-4 px-4 py-4">
            {notice ? (
              <p className={notice.ok ? "flex items-start gap-2 rounded-md bg-[var(--success)]/10 px-3 py-2 text-sm text-[var(--success)]" : "flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"}>
                {notice.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                {notice.text}
              </p>
            ) : null}

            {!s.configured ? (
              <div className="rounded-md border border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-3 py-3 text-[13px] text-muted-foreground">
                <p className="font-semibold text-foreground">Google sign-in isn't set up yet.</p>
                <p className="mt-1">
                  It needs a Google Cloud project in the Terra Workspace, set to Internal, with a Client ID and Client Secret. Add this as the redirect URI:
                </p>
                <RedirectUri uri={s.redirectUri} copied={copied} onCopy={() => setCopied(true)} />
                <p className="mt-1">Once the Client ID and secret are added to Ops, the Connect buttons below switch on.</p>
              </div>
            ) : null}

            <ul className="divide-y divide-border rounded-md border border-border">
              {s.mailboxes.map((m) => (
                <li key={m.address} className="flex flex-wrap items-start gap-3 px-3 py-3">
                  <Inbox className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-[220px] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{m.address}</span>
                      {m.connected ? <Badge colour="#3F7D3A">Connected</Badge> : <Badge>Not connected</Badge>}
                      <Badge>{m.wantsSend ? "Read and send" : "Read only"}</Badge>
                      {m.connected && m.wantsSend && !m.canSend ? <Badge colour="#D08A1E">Send not allowed</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{m.purpose}</p>
                    {m.connected ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.lastCheckedAt ? `Last checked ${when(m.lastCheckedAt)}` : "Not checked yet"}
                        {m.connectedAt ? ` · connected ${when(m.connectedAt)}` : ""}
                      </p>
                    ) : null}
                    {m.lastError ? (
                      <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                        {m.lastError}
                      </p>
                    ) : null}
                    {m.connected && m.wantsSend && !m.canSend ? (
                      <p className="mt-1 text-xs text-[var(--warning)]">Reconnect and allow sending, or POs and requests can't go from {m.address}.</p>
                    ) : null}
                  </div>
                  <div className="flex gap-1.5">
                    {m.connected ? (
                      <>
                        <Button size="sm" variant="ghost" disabled={!s.configured || connect.isPending} onClick={() => go(m.address)}>
                          Reconnect
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disconnect.isPending}
                          onClick={async () => {
                            if (!window.confirm(`Stop reading ${m.address}? Invoices already read stay in Ops.`)) return;
                            setError("");
                            try {
                              await disconnect.mutateAsync({ address: m.address });
                            } catch (e) {
                              setError(errText(e));
                            }
                          }}
                        >
                          <Link2Off /> Disconnect
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" disabled={!s.configured || connect.isPending} onClick={() => go(m.address)}>
                        <LogIn /> Connect
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {s.configured ? (
              <p className="text-xs text-muted-foreground">
                Google asks you to sign in. Sign in as that mailbox, not as yourself. Ops checks it's the right account and refuses anything
                more than read (and send for team@).
              </p>
            ) : null}
            {checkMsg ? <p className="text-sm">{checkMsg}</p> : null}
            {error ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </p>
            ) : null}

            <div className="border-t border-border pt-4">
              <label htmlFor="mail_auto_send" className="flex cursor-pointer items-start gap-2.5">
                <Checkbox
                  id="mail_auto_send"
                  className="mt-0.5"
                  checked={s.autoSend}
                  disabled={setAuto.isPending}
                  onChange={async (e) => {
                    setError("");
                    try {
                      await setAuto.mutateAsync({ on: e.target.checked });
                    } catch (err) {
                      setError(errText(err));
                    }
                  }}
                />
                <span>
                  <span className="block text-sm font-medium">Send missing-invoice requests by themselves</span>
                  <span className="block text-xs text-muted-foreground">
                    Off: each request waits on Suppliers owed for your okay. On: they go from team@ as soon as a statement shows an invoice
                    Terra never got. Leave it off for the first couple of weeks.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
              <span>{s.messagesRead} emails looked at so far.</span>
              <Link to="/finance/suppliers-owed" className="font-medium text-primary hover:underline">
                Open Suppliers owed
              </Link>
            </div>
            {s.configured ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Redirect URI</summary>
                <RedirectUri uri={s.redirectUri} copied={copied} onCopy={() => setCopied(true)} />
              </details>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function RedirectUri({ uri, copied, onCopy }: { uri: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2">
      <code className="rounded bg-secondary px-2 py-1 text-xs text-foreground">{uri}</code>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(uri).then(onCopy, () => undefined);
        }}
      >
        <Copy className="size-3" /> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
