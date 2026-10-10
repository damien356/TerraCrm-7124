import * as React from "react";
import { useParams } from "wouter";
import { Check, CreditCard, Download, FileText } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input } from "../components/ui/field";
import { Spinner } from "../components/ui/card";
import { SignaturePad, type SignatureValue } from "../components/signature-pad";
import { PublicCard, PublicMessage, PublicShell, errorText } from "../components/public-shell";
import { moneyExact } from "../lib/money";
import { useAcceptQuoteOnline, usePublicQuote, usePublicQuotePdf } from "../queries/publicPages";

/**
 * /q/<token>: the client reads the quote, the Supply Terms, signs and
 * accepts. No login. Bundles and totals only, the same as the PDF.
 * The deposit can be paid by card (Stripe, through /pay/<token>, no
 * surcharge) or by bank transfer. Position / Company is only asked for when
 * the quote is billed to a company.
 */

type Bank = { name: string; bsb: string; account: string };

function BankDetails({ bank, reference, amount }: { bank: Bank; reference: string; amount?: number }) {
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

function PayByCard({ url, amount }: { url: string; amount: number }) {
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

function downloadBase64(filename: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function PublicQuotePage() {
  const { token = "" } = useParams<{ token: string }>();
  const quote = usePublicQuote(token);
  const pdf = usePublicQuotePdf();
  const accept = useAcceptQuoteOnline();

  const [agreed, setAgreed] = React.useState(false);
  const [name, setName] = React.useState("");
  const [position, setPosition] = React.useState("");
  const [email, setEmail] = React.useState<string | null>(null);
  const [signature, setSignature] = React.useState<SignatureValue | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // A "tick the box" or "sign here" message goes once they fix it.
  React.useEffect(() => setError(null), [agreed, name, signature]);
  const [showTerms, setShowTerms] = React.useState(false);

  if (quote.isLoading) {
    return (
      <PublicShell>
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </PublicShell>
    );
  }
  if (quote.error || !quote.data) {
    return (
      <PublicShell>
        <PublicMessage title="We could not open this quote">{errorText(quote.error ?? "This link is not valid.")}</PublicMessage>
      </PublicShell>
    );
  }

  const q = quote.data;
  if (q.state === "not_ready" && !q.preview) {
    return (
      <PublicShell>
        <PublicMessage title="This quote is not ready yet">We are still finishing it. You will get an email from us as soon as it is.</PublicMessage>
      </PublicShell>
    );
  }
  if (!("bundles" in q)) return null;

  const done = accept.data;
  const canSign = q.state === "open" && !done;

  async function onAccept() {
    setError(null);
    if (!agreed) return setError("Tick the box to say you have read and agree to the terms.");
    if (name.trim().length < 2) return setError("Type your full name.");
    if (!signature) return setError("Sign in the box before accepting.");
    try {
      await accept.mutateAsync({
        token,
        name: name.trim(),
        position: q.billedToCompany ? position.trim() : "",
        email: (email ?? q.to?.email ?? "").trim() || null,
        agreed: true,
        signature,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <PublicShell>
      {q.preview ? (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          Office preview. This quote has not been sent yet, so the client cannot open this link.
        </div>
      ) : null}
      {q.views != null && !q.preview ? (
        <div className="mb-4 rounded-lg border border-border bg-card px-4 py-2.5 text-xs text-muted-foreground">
          You are signed in to Terra Ops, so this visit is not counted. The client has opened it {q.views} {q.views === 1 ? "time" : "times"}.
        </div>
      ) : null}

      {done ? (
        <PublicCard>
          <div className="flex flex-col items-center py-4 text-center">
            <span className="mb-3 grid size-12 place-items-center rounded-full bg-[#3F7D3A]/12 text-[#3F7D3A]">
              <Check className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-[-0.015em]">Thank you, quote {done.ref} is accepted</h1>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {done.emailedTo ? `Your signed copy is on its way to ${done.emailedTo}.` : "You can download your signed copy below."} We will be in
              touch to book your job in.
            </p>
          </div>
          {done.deposit ? (
            <div className="mx-auto max-w-md">
              <p className="mb-2 text-center text-sm">
                Your deposit invoice is <span className="font-semibold">{done.deposit.ref}</span> for{" "}
                <span className="font-semibold">{moneyExact(done.deposit.total)}</span>. We order your flooring once it lands.
              </p>
              {done.deposit.payUrl ? <PayByCard url={done.deposit.payUrl} amount={done.deposit.total} /> : null}
              <BankDetails bank={done.bank} reference={done.deposit.ref} amount={done.deposit.total} />
            </div>
          ) : null}
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              disabled={pdf.isPending}
              onClick={async () => {
                const out = await pdf.mutateAsync({ token });
                downloadBase64(out.filename, out.base64);
              }}
            >
              <Download className="size-4" />
              Download signed copy
            </Button>
          </div>
        </PublicCard>
      ) : null}

      {!done && q.state === "accepted" ? (
        <PublicCard>
          <div className="text-center">
            <h1 className="text-lg font-bold">Quote {q.ref} is accepted</h1>
            {q.signature ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Signed by {q.signature.name} on {new Date(q.signature.signedAt).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}.
              </p>
            ) : null}
          </div>
          {q.depositInvoice && !q.depositInvoice.paid ? (
            <div className="mx-auto mt-3 max-w-md">
              <p className="mb-2 text-center text-sm">
                Deposit {q.depositInvoice.ref}: {moneyExact(q.depositInvoice.owing)} still to pay.
              </p>
              {q.depositInvoice.payUrl ? <PayByCard url={q.depositInvoice.payUrl} amount={q.depositInvoice.owing} /> : null}
              <BankDetails bank={q.bank} reference={q.depositInvoice.ref} amount={q.depositInvoice.owing} />
            </div>
          ) : q.depositInvoice?.paid ? (
            <p className="mt-2 text-center text-sm text-[#3F7D3A]">Deposit {q.depositInvoice.ref} received. Thank you.</p>
          ) : null}
        </PublicCard>
      ) : null}
      {q.state === "replaced" ? (
        <PublicMessage title="This version has been replaced">
          We have sent you a newer version of this quote.
          {q.newerUrl ? (
            <>
              {" "}
              <a href={q.newerUrl} className="font-medium text-[#906F3C] underline">
                Open the latest version
              </a>
              .
            </>
          ) : (
            " Open the newest email from us."
          )}
        </PublicMessage>
      ) : null}
      {q.state === "declined" ? (
        <PublicMessage title="This quote was declined">If you have changed your mind, reply to our email and we will send you a fresh one.</PublicMessage>
      ) : null}
      {q.state === "past_valid" ? (
        <PublicMessage title="This quote has passed its valid until date">
          Prices may have moved since {q.validUntil}. Reply to our email and we will update it for you.
        </PublicMessage>
      ) : null}

      <PublicCard>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-xs">Quotation</p>
            <h1 className="text-2xl font-bold tracking-[-0.015em]">{q.ref}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {q.date}
              {q.validUntil ? ` · valid until ${q.validUntil}` : ""}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={pdf.isPending}
            onClick={async () => {
              try {
                const out = await pdf.mutateAsync({ token });
                downloadBase64(out.filename, out.base64);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            {pdf.isPending ? <Spinner /> : <FileText className="size-4" />}
            PDF
          </Button>
        </div>
        <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="label-xs">Prepared for</p>
            <p className="font-medium">{q.to.name || q.to.company || "Client"}</p>
            {q.to.company && q.to.name ? <p className="text-muted-foreground">{q.to.company}</p> : null}
          </div>
          {q.to.siteAddress ? (
            <div>
              <p className="label-xs">Site</p>
              <p>{q.to.siteAddress}</p>
            </div>
          ) : null}
        </div>
      </PublicCard>

      <PublicCard title="What is included">
        <div className="divide-y divide-border">
          {q.bundles.map((b) => (
            <div key={b.key} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="font-semibold">{b.title}</h3>
                <span className="tabular shrink-0 text-sm text-muted-foreground">{moneyExact(b.total)} ex GST</span>
              </div>
              {b.wording ? <p className="mt-1 whitespace-pre-line text-sm leading-relaxed">{b.wording}</p> : null}
            </div>
          ))}
        </div>
        <dl className="mt-4 ml-auto flex max-w-xs flex-col gap-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular">{moneyExact(q.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">GST</dt>
            <dd className="tabular">{moneyExact(q.gst)}</dd>
          </div>
          <div className="flex justify-between text-base font-bold">
            <dt>Total inc GST</dt>
            <dd className="tabular">{moneyExact(q.total)}</dd>
          </div>
          {q.depositPercent > 0 ? (
            <>
              <div className="mt-1 flex justify-between">
                <dt className="text-muted-foreground">{q.depositPercent}% deposit on acceptance</dt>
                <dd className="tabular">{moneyExact(q.deposit)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Balance</dt>
                <dd className="tabular">{moneyExact(q.balance)}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </PublicCard>

      <PublicCard title={q.terms.title}>
        <p className="text-sm text-muted-foreground">
          Please read these before you accept. Accepting the quote means you agree to them.
        </p>
        <button type="button" className="mt-2 text-sm font-medium text-[#906F3C] hover:underline" onClick={() => setShowTerms((v) => !v)}>
          {showTerms ? "Hide the terms" : "Read the terms"}
        </button>
        {showTerms ? (
          <div className="mt-3 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-secondary/30 px-4 py-3 text-[13px] leading-relaxed">
            {q.terms.items.map((t, i) =>
              t.t === "h" ? (
                <h4 key={i} className="mt-3 mb-1 font-semibold first:mt-0">
                  {t.x}
                </h4>
              ) : t.t === "i" ? (
                <p key={i} className="mb-1 pl-4">
                  • {t.x}
                </p>
              ) : (
                <p key={i} className="mb-1.5">
                  {t.x}
                </p>
              ),
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">Version {q.terms.version}</p>
          </div>
        ) : null}
      </PublicCard>

      {canSign ? (
        <PublicCard title="Accept this quote">
          <div className="flex flex-col gap-3">
            <div className={`grid gap-3 ${q.billedToCompany ? "sm:grid-cols-2" : ""}`}>
              <Field label="Your full name">
                <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" disabled={q.preview} />
              </Field>
              {q.billedToCompany ? (
                <Field label="Position / Company">
                  <Input value={position} onChange={(e) => setPosition(e.target.value)} autoComplete="organization" disabled={q.preview} />
                </Field>
              ) : null}
            </div>
            <Field label="Email for your signed copy">
              <Input
                type="email"
                value={email ?? q.to.email ?? ""}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={q.preview}
              />
            </Field>
            <div>
              <p className="label-xs mb-1">Signature</p>
              <SignaturePad onChange={setSignature} disabled={q.preview} />
            </div>
            <label className="flex items-start gap-2.5 text-sm">
              <Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={q.preview} className="mt-0.5" />
              <span>
                I have read and agree to the {q.terms.title}, and I accept quote {q.ref} for {moneyExact(q.total)} including GST.
                {q.depositPercent > 0 ? ` I understand a ${q.depositPercent}% deposit of ${moneyExact(q.deposit)} is due now.` : ""}
              </span>
            </label>
            {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <Button size="lg" onClick={onAccept} disabled={accept.isPending || q.preview} className="w-full sm:w-auto sm:self-end">
              {accept.isPending ? <Spinner /> : <Check className="size-4" />}
              Accept quote
            </Button>
            {q.depositPercent > 0 ? (
              <p className="text-xs text-muted-foreground">
                After you accept you can pay the deposit {q.cardPayments ? "by card or by bank transfer" : "by bank transfer"}.
              </p>
            ) : null}
          </div>
        </PublicCard>
      ) : null}
      {!canSign && error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    </PublicShell>
  );
}
