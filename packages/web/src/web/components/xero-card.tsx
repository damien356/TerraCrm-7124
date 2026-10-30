import * as React from "react";
import { Link } from "wouter";
import { CheckCircle2, Copy, Link2Off, LogIn, RefreshCw, Send, TriangleAlert } from "lucide-react";
import { Card, CardHeader, Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select } from "./ui/field";
import { moneyExact } from "../lib/money";
import { emailState, paymentState } from "../lib/invoice-status";
import {
  useCheckXeroNow,
  useChooseXeroTenant,
  useConnectXero,
  useDisconnectXero,
  usePushToXero,
  useSaveXeroSettings,
  useXeroStatus,
} from "../queries/xero";

/**
 * XERO (Settings).
 *
 * Connect the Terra Ops Xero app to the Terra Flooring organisation. Ops
 * pushes client invoices across, numbered as Ops numbers them, and reads
 * back what Xero says. Nothing else is written to Xero. Supplier bills keep
 * going in through Hubdoc.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));
const when = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;

/** The ?xero=connected|choose|error&reason= Xero sends Damien back with. Read once, then cleared. */
function useReturnNotice() {
  const [notice] = React.useState(() => {
    const p = new URLSearchParams(window.location.search);
    const x = p.get("xero");
    if (!x) return null;
    if (x === "connected") return { ok: true, text: `Connected to ${p.get("org") || "Xero"}.` };
    if (x === "choose") return { ok: true, text: "Connected. Pick which organisation invoices go to." };
    return { ok: false, text: p.get("reason") || "Xero sign-in didn't finish." };
  });
  React.useEffect(() => {
    if (!notice) return;
    const p = new URLSearchParams(window.location.search);
    for (const k of ["xero", "reason", "org"]) p.delete(k);
    const qs = p.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
  }, [notice]);
  return notice;
}

export function XeroCard() {
  const q = useXeroStatus();
  const connect = useConnectXero();
  const choose = useChooseXeroTenant();
  const disconnect = useDisconnectXero();
  const save = useSaveXeroSettings();
  const push = usePushToXero();
  const checkNow = useCheckXeroNow();
  const notice = useReturnNotice();
  const [error, setError] = React.useState("");
  const [msg, setMsg] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  const [form, setForm] = React.useState<{ accountCode: string; materialsAccount: string; pushStatus: "DRAFT" | "AUTHORISED"; autoPush: boolean; contraAccount: string } | null>(
    null,
  );
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (window.location.hash === "#xero") ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const s = q.data;
  React.useEffect(() => {
    // Task H: until the accounts are checked in Xero the form starts on 200, 204 and 810 (Damien, 29 Oct).
    if (s && !form)
      setForm({
        accountCode: s.settings.accountCode,
        materialsAccount: s.settings.materialsAccount,
        pushStatus: s.settings.pushStatus,
        autoPush: s.settings.autoPush,
        contraAccount: s.settings.contraAccount || (s.settings.checked ? "" : "810"),
      });
  }, [s, form]);

  async function go() {
    setError("");
    try {
      const { url } = await connect.mutateAsync({});
      window.location.href = url;
    } catch (e) {
      setError(errText(e));
    }
  }

  const dirty =
    !!s &&
    !!form &&
    (!s.settings.checked ||
      form.accountCode !== s.settings.accountCode ||
      form.materialsAccount !== s.settings.materialsAccount ||
      form.pushStatus !== s.settings.pushStatus ||
      form.autoPush !== s.settings.autoPush ||
      form.contraAccount.trim() !== s.settings.contraAccount);

  return (
    <div id="xero" ref={ref} className="scroll-mt-4">
      <Card>
        <CardHeader
          title="Xero"
          subtitle="Client invoices go across to Xero with Terra's IQ numbers, every line and the job details. Paid in Xero comes back to Ops."
          action={
            s?.tenant ? (
              <Button
                size="sm"
                variant="outline"
                disabled={checkNow.isPending}
                onClick={async () => {
                  setError("");
                  setMsg("");
                  try {
                    const r = await checkNow.mutateAsync({});
                    if (r.busy) return setMsg("Already reading Xero. Give it a minute.");
                    setMsg(
                      `${r.checked} ${r.checked === 1 ? "invoice" : "invoices"} read` +
                        (r.recorded ? `, ${r.recorded} paid in Xero now recorded in Ops` : "") +
                        (r.flagged ? `, ${r.flagged} to look at` : "") +
                        ".",
                    );
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                {checkNow.isPending ? <Spinner /> : <RefreshCw />}
                Check Xero now
              </Button>
            ) : null
          }
        />
        {q.isLoading ? (
          <Loading />
        ) : !s ? (
          <p className="px-4 py-4 text-sm text-destructive">{errText(q.error) || "Couldn't load Xero."}</p>
        ) : (
          <div className="space-y-4 px-4 py-4">
            {notice ? (
              <p
                className={
                  notice.ok
                    ? "flex items-start gap-2 rounded-md bg-[var(--success)]/10 px-3 py-2 text-sm text-[var(--success)]"
                    : "flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                }
              >
                {notice.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                {notice.text}
              </p>
            ) : null}

            {!s.configured ? (
              <div className="rounded-md border border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-3 py-3 text-[13px] text-muted-foreground">
                {s.demoOnly ? (
                  <>
                    <p className="font-semibold text-foreground">Test copy. The Terra Ops Test Xero app isn't added yet.</p>
                    <p className="mt-1">
                      At developer.xero.com, make a separate Web app called Terra Ops Test with this redirect URI. Don't use the live Terra OPS app
                      or any old app. Its Client ID and secret are added through the secure form, never in chat.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-foreground">The Terra Ops Xero app isn't added yet.</p>
                    <p className="mt-1">
                      At developer.xero.com, make a Web app called Terra Ops, on the free Starter plan, with this redirect URI. Then its Client ID and
                      secret are added to Ops through the secure form, never in chat.
                    </p>
                  </>
                )}
                <RedirectUri uri={s.redirectUri} copied={copied} onCopy={() => setCopied(true)} />
              </div>
            ) : null}

            <div className="flex flex-wrap items-start gap-3 rounded-md border border-border px-3 py-3">
              <div className="min-w-[220px] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{s.tenant ? s.tenant.name : s.connected ? "No organisation picked" : "Not connected"}</span>
                  {s.tenant ? <Badge colour="#3F7D3A">Connected</Badge> : <Badge>Not connected</Badge>}
                  {s.tenant?.demo ? <Badge colour="#D08A1E">Demo Company, for testing</Badge> : null}
                </div>
                {s.connected ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.lastSyncAt ? `Last read ${when(s.lastSyncAt)}` : "Not read yet"}
                    {s.connectedAt ? ` · connected ${when(s.connectedAt)}` : ""}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.demoOnly
                      ? "Test copy: on Xero's screen, tick only Demo Company (AU). Any other organisation is refused."
                      : "On Xero's screen, tick Terra Flooring, not the Demo Company."}
                  </p>
                )}
                {s.lastError ? (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {s.lastError}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-1.5">
                {s.connected ? (
                  <>
                    <Button size="sm" variant="ghost" disabled={!s.configured || connect.isPending} onClick={go}>
                      Reconnect
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disconnect.isPending}
                      onClick={async () => {
                        if (!window.confirm("Disconnect Xero? Invoices already in Xero stay there.")) return;
                        setError("");
                        try {
                          await disconnect.mutateAsync({});
                        } catch (e) {
                          setError(errText(e));
                        }
                      }}
                    >
                      <Link2Off /> Disconnect
                    </Button>
                  </>
                ) : (
                  <Button size="sm" disabled={!s.configured || connect.isPending} onClick={go}>
                    <LogIn /> Connect to Xero
                  </Button>
                )}
              </div>
            </div>

            {s.connected && s.tenants.length > 1 ? (
              <Field label="Invoices go to" hint={s.demoOnly ? "Test copy: pick Demo Company (AU). Any other organisation is refused." : "Xero lets this sign-in reach more than one organisation. Pick Terra Flooring."}>
                <Select
                  value={s.tenant?.id ?? ""}
                  disabled={choose.isPending}
                  onChange={async (e) => {
                    setError("");
                    try {
                      await choose.mutateAsync({ tenantId: e.target.value });
                    } catch (err) {
                      setError(errText(err));
                    }
                  }}
                >
                  {!s.tenant ? <option value="">Pick one</option> : null}
                  {s.tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.demo ? " (demo)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            {form ? (
              <div className="space-y-3 border-t border-border pt-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Customer sales account"
                    hint={s.settings.accountName ? `In Xero: ${s.settings.accountName}. Every invoice unless it is marked Installer materials.` : "Checked against Xero when you save."}
                  >
                    <Input
                      value={form.accountCode}
                      onChange={(e) => setForm({ ...form, accountCode: e.target.value })}
                      maxLength={10}
                      data-testid="xero-sales-account"
                    />
                  </Field>
                  <Field
                    label="Installer materials account"
                    hint={
                      s.settings.materialsAccountName
                        ? `In Xero: ${s.settings.materialsAccountName}. New materials invoice, or an invoice marked Installer materials.`
                        : "Products and materials sold to installers. Checked against Xero when you save."
                    }
                  >
                    <Input
                      value={form.materialsAccount}
                      onChange={(e) => setForm({ ...form, materialsAccount: e.target.value })}
                      maxLength={10}
                      data-testid="xero-materials-account"
                    />
                  </Field>
                  <Field label="New invoices go into Xero as" hint="GST on Income, amounts include GST.">
                    <Select value={form.pushStatus} onChange={(e) => setForm({ ...form, pushStatus: e.target.value as "DRAFT" | "AUTHORISED" })}>
                      <option value="AUTHORISED">Awaiting payment, approved as it goes</option>
                      <option value="DRAFT">Draft, you approve it in Xero</option>
                    </Select>
                  </Field>
                </div>
                <Field
                  label="Contra clearing account"
                  hint={`${s.settings.contraAccountName ? `In Xero: ${s.settings.contraAccountName}. ` : ""}A payment Xero puts through this account is read as a contra against a bill, never as money received. The sale keeps its own sales account and GST. Payments to other non-bank accounts are flagged, not recorded.`}
                >
                  <Input
                    data-testid="xero-contra-account"
                    value={form.contraAccount}
                    onChange={(e) => setForm({ ...form, contraAccount: e.target.value })}
                    maxLength={10}
                    placeholder="None set"
                  />
                </Field>
                <label htmlFor="xero_auto" className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox id="xero_auto" className="mt-0.5" checked={form.autoPush} onChange={(e) => setForm({ ...form, autoPush: e.target.checked })} />
                  <span>
                    <span className="block text-sm font-medium">Send to Xero when the invoice is first emailed</span>
                    <span className="block text-xs text-muted-foreground">Off: press Send to Xero on the job's invoice. Xero never emails the client.</span>
                  </span>
                </label>
                {!s.settings.checked && s.connected ? (
                  <p className="text-xs text-muted-foreground">Not checked in Xero yet. Press Save to check these accounts in the connected organisation. Nothing is created or changed in Xero.</p>
                ) : null}
                {dirty ? (
                  <Button
                    size="sm"
                    disabled={save.isPending}
                    onClick={async () => {
                      setError("");
                      setMsg("");
                      try {
                        const r = await save.mutateAsync({
                          ...form,
                          accountCode: form.accountCode.trim(),
                          materialsAccount: form.materialsAccount.trim(),
                          contraAccount: form.contraAccount.trim(),
                        });
                        setMsg(
                          r.accountName
                            ? `Saved and checked in Xero. Customer sales ${r.accountName}. Installer materials ${r.materialsAccountName}.${r.contraAccountName ? ` Contra ${r.contraAccountName}.` : ""}`
                            : "Saved. Not checked yet, Xero is not connected.",
                        );
                        setForm(null);
                      } catch (e) {
                        setError(errText(e));
                      }
                    }}
                  >
                    {save.isPending ? <Spinner /> : null}
                    Save
                  </Button>
                ) : null}
              </div>
            ) : null}

            {msg ? <p className="text-sm">{msg}</p> : null}
            {error ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                {error}
              </p>
            ) : null}

            {s.issues.length ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <p className="text-sm font-medium">Ops and Xero disagree</p>
                <ul className="space-y-1">
                  {s.issues.map((i) => (
                    <li key={i.id} className="text-xs">
                      {i.jobId ? (
                        <Link to={`/jobs/${i.jobId}`} className="font-medium text-primary hover:underline">
                          {i.number}
                        </Link>
                      ) : (
                        <span className="font-medium">{i.number}</span>
                      )}{" "}
                      <span className="text-muted-foreground">{i.issue}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {s.tenant && s.notYet.length ? (
              <div className="space-y-1.5 border-t border-border pt-4">
                <p className="text-sm font-medium">Not in Xero yet ({s.counts.notYet})</p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {s.notYet.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                      <span>
                        {i.jobId ? (
                          <Link to={`/jobs/${i.jobId}`} className="font-medium text-primary hover:underline">
                            {i.number}
                          </Link>
                        ) : (
                          <span className="font-medium">{i.number}</span>
                        )}{" "}
                        <span className="text-muted-foreground">
                          {moneyExact(i.total)}, {paymentState(i).label}, {emailState(i).label}. {i.categoryLabel}, account {i.salesAccount}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={push.isPending}
                        onClick={async () => {
                          setError("");
                          setMsg("");
                          if (
                            !window.confirm(
                              `Send ${i.number} to ${s.tenant?.name} as ${s.settings.pushStatus === "DRAFT" ? "a draft" : "awaiting payment"}?\n\nSales category: ${i.categoryLabel}, account ${i.salesAccount}.\nTo change it, press Cancel and use Change on the job's invoice.`,
                            )
                          )
                            return;
                          try {
                            const r = await push.mutateAsync({ invoiceId: i.id });
                            setMsg(r.how === "linked" ? `${i.number} was already in Xero. Linked to it.` : `${i.number} is in Xero.`);
                          } catch (e) {
                            setError(errText(e));
                          }
                        }}
                      >
                        <Send className="size-3.5" /> Send to Xero
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {s.log.length ? (
              <details className="border-t border-border pt-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground">What has gone to and from Xero</summary>
                <ul className="mt-2 space-y-1">
                  {s.log.map((l) => (
                    <li key={l.id} className={l.ok ? "text-muted-foreground" : "text-destructive"}>
                      {when(l.at)} · {l.detail}
                      {l.byName && l.byName !== "System" ? ` (${l.byName})` : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <p className="border-t border-border pt-3 text-xs text-muted-foreground">
              Ops only creates client invoices in Xero, and the customer contact one needs. It never enters supplier bills (Hubdoc does), records
              payments, or voids anything in Xero.
            </p>
            {s.configured ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Redirect URI and access asked for</summary>
                <RedirectUri uri={s.redirectUri} copied={copied} onCopy={() => setCopied(true)} />
                <p className="mt-1.5 break-words">{s.scopes.join(" ")}</p>
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
      <code className="min-w-0 max-w-full break-all rounded bg-secondary px-2 py-1 text-xs text-foreground">{uri}</code>
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
