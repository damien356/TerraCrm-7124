import * as React from "react";
import { useParams } from "wouter";
import { Check, Download, FileText, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Textarea } from "../components/ui/field";
import { Spinner } from "../components/ui/card";
import { SignaturePad, type SignatureValue } from "../components/signature-pad";
import { BankDetails, PayByCard, PublicCard, PublicMessage, PublicShell, downloadBase64, errorText } from "../components/public-shell";
import { moneyExact } from "../lib/money";
import { useAcceptVariationOnline, useDeclineVariationOnline, usePublicVariation, usePublicVariationPdf } from "../queries/publicPages";

/**
 * /v/<token>: the client reads a variation, signs and accepts it, or
 * declines it (item 12). No login. What the work is, the qty and the
 * totals. Never a unit price. A variation billed on its own invoice can be
 * paid by card once accepted.
 */

const UNIT: Record<string, string> = { m2: "m²", lm: "lm", each: "each", hour: "hr", day: "day", job: "job", step: "step" };
const unitOf = (u: string) => UNIT[u] ?? u;
const qtyOf = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
const longDay = (d: Date | string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

export default function PublicVariationPage() {
  const { token = "" } = useParams<{ token: string }>();
  const page = usePublicVariation(token);
  const pdf = usePublicVariationPdf();
  const accept = useAcceptVariationOnline();
  const decline = useDeclineVariationOnline();

  const [agreed, setAgreed] = React.useState(false);
  const [name, setName] = React.useState("");
  const [position, setPosition] = React.useState("");
  const [email, setEmail] = React.useState<string | null>(null);
  const [signature, setSignature] = React.useState<SignatureValue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");
  React.useEffect(() => setError(null), [agreed, name, signature]);

  if (page.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }
  if (page.error || !page.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open this variation">{errorText(page.error ?? "This link is not valid.")}</PublicMessage>
      </PublicShell>
    );
  }
  const v = page.data;
  if (!v.full) {
    return (
      <PublicShell>
        {v.state === "being_updated" ? (
          <PublicMessage title="We are updating this variation">We are making a change to it. You will get the new one from us shortly.</PublicMessage>
        ) : (
          <PublicMessage title="This variation is not ready yet">We are still finishing it. You will hear from us as soon as it is.</PublicMessage>
        )}
      </PublicShell>
    );
  }

  const toEmail = v.to.email ?? "";
  const done = accept.data;
  const declined = decline.data || v.state === "declined";
  const canSign = v.state === "open" && !done && !decline.data;

  async function savePdf() {
    try {
      const out = await pdf.mutateAsync({ token });
      downloadBase64(out.filename, out.base64);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function onAccept() {
    setError(null);
    if (name.trim().length < 2) return setError("Type your full name.");
    if (!signature) return setError("Sign in the box before accepting.");
    if (!agreed) return setError("Tick the box to accept the variation.");
    try {
      await accept.mutateAsync({
        token,
        name: name.trim(),
        position: v.billedToCompany ? position.trim() : "",
        email: (email ?? toEmail).trim() || null,
        agreed: true,
        signature,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function onDecline() {
    setError(null);
    if (name.trim().length < 2) return setError("Type your name so we know who declined it.");
    try {
      await decline.mutateAsync({ token, name: name.trim(), reason: reason.trim() || undefined });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const owing = v.invoice && !v.invoice.paid && v.invoice.owing > 0 ? v.invoice : null;

  return (
    <PublicShell>
      {v.preview ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          Office preview. This variation has not been sent, so the client cannot open this link.
        </div>
      ) : null}
      {v.views != null && !v.preview ? (
        <div className="mb-4 rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
          You are signed in to Terra Ops, so this visit is not counted. The client has opened it {v.views} {v.views === 1 ? "time" : "times"}.
        </div>
      ) : null}

      {done ? (
        <PublicCard>
          <div className="flex flex-col items-center py-4 text-center">
            <span className="mb-3 grid size-12 place-items-center rounded-full bg-[#3F7D3A]/12 text-[#3F7D3A]">
              <Check className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-[-0.015em]">Thank you, variation {done.ref} is accepted</h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {done.emailedTo ? `Your signed copy is on its way to ${done.emailedTo}.` : "You can download your signed copy below."} {done.billNote}
            </p>
          </div>
          {done.invoice ? (
            <div className="mx-auto max-w-md">
              <p className="mb-2 text-center text-sm">
                Your invoice is <span className="font-semibold">{done.invoice.ref}</span> for{" "}
                <span className="font-semibold">{moneyExact(done.invoice.total)}</span>.
              </p>
              {done.invoice.payUrl ? <PayByCard url={done.invoice.payUrl} amount={done.invoice.total} /> : null}
              <BankDetails bank={done.bank} reference={done.invoice.ref} amount={done.invoice.total} />
            </div>
          ) : null}
          <div className="mt-4 flex justify-center">
            <Button variant="outline" disabled={pdf.isPending} onClick={savePdf}>
              <Download className="size-4" />
              Download signed copy
            </Button>
          </div>
        </PublicCard>
      ) : null}

      {!done && v.state === "accepted" ? (
        <PublicCard>
          <div className="text-center">
            <h1 className="text-lg font-bold">Variation {v.ref} is accepted</h1>
            {v.signature ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Signed by {v.signature.name} on {longDay(v.signature.signedAt)}.
              </p>
            ) : null}
            <p className="mt-1 text-sm text-muted-foreground">{v.billNote}</p>
          </div>
          {owing ? (
            <div className="mx-auto mt-3 max-w-md">
              <p className="mb-2 text-center text-sm">
                Invoice {owing.ref}: {moneyExact(owing.owing)} still to pay.
              </p>
              {owing.payUrl ? <PayByCard url={owing.payUrl} amount={owing.owing} /> : null}
              <BankDetails bank={v.bank} reference={owing.ref} amount={owing.owing} />
            </div>
          ) : v.invoice?.paid ? (
            <p className="mt-2 text-center text-sm text-[#3F7D3A]">Invoice {v.invoice.ref} paid. Thank you.</p>
          ) : null}
        </PublicCard>
      ) : null}

      {declined ? (
        <PublicMessage title="This variation was declined">
          {decline.data ? "Thanks for letting us know. We will be in touch." : "If you have changed your mind, reply to our message and we will send it again."}
        </PublicMessage>
      ) : null}

      <PublicCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-xs">Variation</p>
            <h1 className="text-2xl font-bold tracking-[-0.015em]">{v.ref}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {v.date} · job {v.jobRef}
              {v.quoteRef ? ` · to quote ${v.quoteRef}` : ""}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={pdf.isPending} onClick={savePdf}>
            {pdf.isPending ? <Spinner /> : <FileText className="size-4" />}
            PDF
          </Button>
        </div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="label-xs">Prepared for</p>
            <p className="font-medium">{v.to.name || v.to.company || "Client"}</p>
            {v.to.company && v.to.name ? <p className="text-muted-foreground">{v.to.company}</p> : null}
          </div>
          {v.to.siteAddress ? (
            <div>
              <p className="label-xs">Site</p>
              <p>{v.to.siteAddress}</p>
            </div>
          ) : null}
        </div>
      </PublicCard>

      {v.reason || v.photos.length ? (
        <PublicCard title="Why this variation">
          {v.reason ? <p className="whitespace-pre-line text-sm leading-relaxed">{v.reason}</p> : null}
          {v.photos.length ? (
            <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${v.reason ? "mt-3" : ""}`}>
              {v.photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border bg-secondary/40">
                  {p.kind === "video" ? (
                    <video src={p.url} className="aspect-[4/3] w-full object-cover" muted playsInline controls aria-label={p.caption ?? "Video"} />
                  ) : (
                    <img src={p.url} alt={p.caption ?? "Photo"} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                  )}
                  {p.caption ? <p className="px-2 py-1 text-xs text-muted-foreground">{p.caption}</p> : null}
                </a>
              ))}
            </div>
          ) : null}
        </PublicCard>
      ) : null}

      <PublicCard title="The work">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Description</th>
              <th className="pb-2 text-right font-medium">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {v.lines.map((l, i) => (
              <tr key={i}>
                <td className="py-2 pr-3">{l.description}</td>
                <td className="tabular py-2 text-right whitespace-nowrap">
                  {qtyOf(l.qty)} {unitOf(l.unit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular">{moneyExact(v.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">GST</dt>
            <dd className="tabular">{moneyExact(v.gst)}</dd>
          </div>
          <div className="flex justify-between text-base font-bold">
            <dt>Total inc GST</dt>
            <dd className="tabular">{moneyExact(v.total)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-right text-xs text-muted-foreground">{v.billNote}</p>
      </PublicCard>

      {canSign ? (
        <PublicCard title="Accept this variation">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{v.acceptText}</p>
            <div className={`grid gap-3 ${v.billedToCompany ? "sm:grid-cols-2" : ""}`}>
              <Field label="Your full name">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={v.preview} />
              </Field>
              {v.billedToCompany ? (
                <Field label="Position / Company">
                  <Input value={position} onChange={(e) => setPosition(e.target.value)} autoComplete="organization" disabled={v.preview} />
                </Field>
              ) : null}
            </div>
            <Field label="Email for your signed copy">
              <Input type="email" value={email ?? v.to.email ?? ""} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={v.preview} />
            </Field>
            <div>
              <p className="label-xs mb-1">Signature</p>
              <SignaturePad onChange={setSignature} disabled={v.preview} />
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={v.preview} className="mt-0.5" />
              <span>
                I accept variation {v.ref} for {moneyExact(v.total)} including GST, added to job {v.jobRef}.
              </span>
            </label>
            {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="ghost" onClick={() => setDeclining((d) => !d)} disabled={v.preview}>
                <X className="size-4" />
                Decline
              </Button>
              <Button size="lg" onClick={onAccept} disabled={accept.isPending || v.preview}>
                {accept.isPending ? <Spinner /> : <Check className="size-4" />}
                Accept variation
              </Button>
            </div>
            {declining ? (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-3">
                <Field label="Why not? (optional)">
                  <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button variant="outline" className="self-end" onClick={onDecline} disabled={decline.isPending}>
                  {decline.isPending ? <Spinner /> : null}
                  Decline variation {v.ref}
                </Button>
              </div>
            ) : null}
            {v.cardPayments ? <p className="text-xs text-muted-foreground">After you accept you can pay its invoice by card or by bank transfer.</p> : null}
          </div>
        </PublicCard>
      ) : null}
      {!canSign && error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </PublicShell>
  );
}
