import * as React from "react";
import { Link } from "wouter";
import { Check } from "lucide-react";
import { Loading, Spinner } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { dayOf } from "@/lib/utils";
import {
  useContraApprove,
  useContraCancel,
  useContraConfirm,
  useContraHistory,
  useContraPost,
  useContraPrepare,
  useContraPreview,
  useCreateBuyer,
  useInstallerAccount,
  useLinkBuyer,
  usePinXero,
  useUnlinkBuyer,
  useXeroBills,
  useXeroContactsForInstaller,
} from "../queries/installerAccount";
import { SalesList, SellProductsButton } from "./sell-products";

/* ---------------------------------------------------------------------------
 * Installer Account tab (Task H, Damien 29 Oct).
 *
 * The installer who also buys materials from Terra. Office and Admin only.
 * His own field login never sees this tab and the link gives it nothing.
 *
 * 1. Billed as: the one contact or company he is billed as. Ops suggests
 *    records, the office ticks that it is the same legal person or business.
 * 2. Sell products to him: the Sell products form, on its own supply only job.
 * 3. He owes us, we owe him.
 * 4. Contras (Admin, and only when the server switches them on).
 * ------------------------------------------------------------------------- */

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
/** YYYY-MM-DD or a date, as 29 Oct 2026. */
const day = (v: string | Date | null | undefined) => {
  const d = dayOf(v ?? null);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const newKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.random().toString(36).slice(2)}`;

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Note({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: React.ReactNode }) {
  const cls = {
    ok: "border-emerald-300 bg-emerald-50 text-emerald-900",
    warn: "border-amber-300 bg-amber-50 text-amber-900",
    bad: "border-red-300 bg-red-50 text-red-900",
    info: "border-border bg-secondary/50 text-foreground",
  }[tone];
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}

const BASIS: Record<string, string> = { abn_match: "Same ABN, confirmed", confirmed: "Confirmed same person or business", created: "Made from his card" };

export function InstallerAccountTab({ id }: { id: number }) {
  const q = useInstallerAccount(id);
  if (q.isLoading) return <Loading />;
  if (q.error) return <Note tone="bad">{errText(q.error)}</Note>;
  const d = q.data!;
  return (
    <div className="flex flex-col gap-4" data-testid="installer-account">
      <p className="text-xs text-muted-foreground">
        Office and Admin only. {d.installer.name}'s own login does not see this and gets nothing new from it.
      </p>
      <BilledAs installerId={id} data={d} />
      <Materials installerId={id} data={d} />
      <Balances data={d} />
      {d.flags.workflow ? <Contras installerId={id} data={d} /> : null}
    </div>
  );
}

type Overview = NonNullable<ReturnType<typeof useInstallerAccount>["data"]>;

/* ------------------------------ billed as ------------------------------ */

function BilledAs({ installerId, data }: { installerId: number; data: Overview }) {
  const link = useLinkBuyer();
  const create = useCreateBuyer();
  const unlink = useUnlinkBuyer();
  const [pick, setPick] = React.useState<string>("");
  const [same, setSame] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [makeOpen, setMakeOpen] = React.useState(false);
  const [makeAs, setMakeAs] = React.useState<"company" | "contact">("company");
  const [makeName, setMakeName] = React.useState("");
  const [noneOfThese, setNoneOfThese] = React.useState(false);
  const [unlinkOpen, setUnlinkOpen] = React.useState(false);
  const [unlinkReason, setUnlinkReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const i = data.installer;

  if (data.link) {
    const l = data.link;
    return (
      <Section title="Billed as" hint="Materials invoices for him go to this record. It is the same legal person or business as his installer card.">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2" data-testid="billed-as">
            <span className="font-medium">{l.name}</span>
            <Badge>{l.billTo.type === "company" ? "Company" : "Contact"}</Badge>
            {l.abn ? <span className="text-sm text-muted-foreground">ABN {l.abn}</span> : null}
            <Badge colour="#059669">
              <Check className="size-3" />
              {BASIS[l.basis] ?? l.basis}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {l.reason ? `Reason: ${l.reason}. ` : ""}Confirmed by {l.confirmedByName} on {day(l.confirmedAt)}.
            {l.xeroContactName ? ` Xero contact: ${l.xeroContactName}.` : ""}
          </p>
          {unlinkOpen ? (
            <div className="flex flex-col gap-2">
              <Field label="Why unlink?">
                <Input value={unlinkReason} onChange={(e) => setUnlinkReason(e.target.value)} placeholder="For example: wrong record picked" />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={unlink.isPending}
                  onClick={async () => {
                    setError(null);
                    try {
                      await unlink.mutateAsync({ installerId, reason: unlinkReason });
                      setUnlinkOpen(false);
                      setUnlinkReason("");
                    } catch (e) {
                      setError(errText(e));
                    }
                  }}
                >
                  Unlink
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setUnlinkOpen(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button variant="outline" size="sm" onClick={() => setUnlinkOpen(true)}>
                Unlink
              </Button>
            </div>
          )}
          {error ? <Note tone="bad">{error}</Note> : null}
        </div>
      </Section>
    );
  }

  const cands = data.candidates;
  const chosen = cands.find((c) => `${c.type}:${c.id}` === pick) ?? null;
  const needReason = !!chosen && !chosen.abnMatch;
  const free = cands.filter((c) => !c.linkedTo);
  const abnHit = free.find((c) => c.abnMatch);

  async function doLink() {
    if (!chosen) return;
    setError(null);
    try {
      await link.mutateAsync({ installerId, buyer: { type: chosen.type, id: chosen.id }, sameEntity: true, reason: needReason ? reason : null });
      setPick("");
      setSame(false);
      setReason("");
    } catch (e) {
      setError(errText(e));
    }
  }

  async function doCreate() {
    setError(null);
    try {
      await create.mutateAsync({ installerId, as: makeAs, name: makeName, noneOfThese });
      setMakeOpen(false);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <Section
      title="Billed as"
      hint={`Not set. To bill ${i.name} for materials, pick the existing contact or company that is him. Ops does not make a second record when one exists.`}
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted-foreground">
          His card: {i.legalName ?? i.name}
          {i.tradingName ? ` t/a ${i.tradingName}` : ""}
          {i.abn ? `, ABN ${i.abn}` : ", no ABN"}
          {i.email ? `, ${i.email}` : ""}.
        </p>
        {cands.length ? (
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Records that may be him">
            {cands.map((c) => {
              const key = `${c.type}:${c.id}`;
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${pick === key ? "border-[var(--primary)] bg-secondary/40" : "border-border"} ${c.linkedTo ? "cursor-not-allowed opacity-60" : ""}`}
                >
                  <input
                    type="radio"
                    name="buyer"
                    className="mt-1"
                    disabled={!!c.linkedTo}
                    checked={pick === key}
                    onChange={() => {
                      setPick(key);
                      setSame(false);
                      setError(null);
                    }}
                  />
                  <span className="flex flex-col">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.name}</span>
                      <Badge>{c.type === "company" ? "Company" : "Contact"}</Badge>
                      {c.abnMatch ? <Badge colour="#059669">Same ABN</Badge> : null}
                      {c.abn && !c.abnMatch ? <Badge colour="#b45309">ABN {c.abn}</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {c.reasons.join(", ")}
                      {c.email ? `. ${c.email}` : ""}
                      {c.linkedTo ? `. Already linked to ${c.linkedTo.name}.` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <Note tone="info">Ops found no contact or company with his ABN, name, email or mobile.</Note>
        )}

        {chosen ? (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={same} onChange={(e) => setSame(e.target.checked)} aria-label="Same legal person or business" className="mt-0.5" />
              <span>
                <span className="font-medium">{chosen.name}</span> is the same legal person or business as installer <span className="font-medium">{i.legalName ?? i.name}</span>
                {i.abn ? ` (ABN ${i.abn})` : ""}.
              </span>
            </label>
            {needReason ? (
              <Field label="How do you know?" hint="The ABNs do not match on file, so say how you know. At least a few words.">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: he confirmed by text on 29 Oct, sole trader" />
              </Field>
            ) : null}
            <div>
              <Button size="sm" disabled={!same || (needReason && reason.trim().length < 8) || link.isPending} onClick={doLink}>
                {link.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
                Link
              </Button>
            </div>
          </div>
        ) : null}

        {!abnHit ? (
          makeOpen ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
                <Field label="Make a">
                  <Select value={makeAs} onChange={(e) => setMakeAs(e.target.value as "company" | "contact")}>
                    <option value="company">Company</option>
                    <option value="contact">Contact (sole trader)</option>
                  </Select>
                </Field>
                <Field label="Bill to name" hint="Uses his ABN, invoice email, mobile and address from his card.">
                  <Input value={makeName} onChange={(e) => setMakeName(e.target.value)} />
                </Field>
              </div>
              {free.length ? (
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={noneOfThese} onChange={(e) => setNoneOfThese(e.target.checked)} aria-label="None of these is him" />
                  None of the records above is him.
                </label>
              ) : null}
              <div className="flex gap-2">
                <Button size="sm" disabled={create.isPending || makeName.trim().length < 2 || (free.length > 0 && !noneOfThese)} onClick={doCreate}>
                  Make and link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMakeOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMakeName(i.legalName ?? i.tradingName ?? i.name);
                  setMakeOpen(true);
                }}
              >
                None of these. Make one from his card
              </Button>
            </div>
          )
        ) : null}
        {error ? <Note tone="bad">{error}</Note> : null}
      </div>
    </Section>
  );
}

/* ---------------------------- materials ------------------------------ */

/**
 * Sell products (Damien, 30 Oct). The one form for products sold to him,
 * quote or straight invoice. Installer materials (204). No contra, no crew
 * tasks, no Crew login, nothing taken off his pay.
 */
function Materials({ installerId, data }: { installerId: number; data: Overview }) {
  return (
    <Section
      title="Sell products to him"
      hint="Products and materials he buys from Terra. Save a quote or raise the invoice straight away, on its own supply only job. No crew or install messages, and nothing comes off his pay."
    >
      <div className="flex flex-col gap-3" data-testid="materials">
        <div>
          <SellProductsButton
            buyer={{ kind: "installer", installerId }}
            buyerName={data.installer.name}
            disabled={!data.link}
            size="default"
            note={
              data.link
                ? `Billed to ${data.link.name}. Sales category Installer materials (${data.salesAccounts.installer_materials.name}). Work on his own home is a normal job, billed as Customer sales.`
                : undefined
            }
          />
          {!data.link ? <p className="mt-1 text-xs text-muted-foreground">Set Billed as first.</p> : null}
        </div>
        <div className="rounded-md border border-border">
          <SalesList where={{ installerId }} />
        </div>
        {data.materialsQuotes.length ? (
          <div className="text-sm">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Older materials quotes still open</p>
            <ul className="flex flex-col gap-1">
              {data.materialsQuotes.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <Link href={`/quotes/${m.id}`} className="text-[var(--primary)] hover:underline">
                    {m.ref}
                  </Link>
                  <Badge>{m.status}</Badge>
                  <span className="text-muted-foreground">{money(m.total)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* ----------------------------- balances ------------------------------ */

function Balances({ data }: { data: Overview }) {
  const owes = data.owesUs.filter((r) => r.due > 0.004);
  const owesTotal = owes.reduce((s, r) => s + r.due, 0);
  const oweTotal = data.weOweHim.reduce((s, b) => s + b.total, 0);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Section title={`He owes us ${money(owesTotal)}`} hint={data.link ? `Invoices to ${data.link.name}, not draft or void.` : "Link Billed as to see his invoices."}>
        {data.owesUs.length ? (
          <table className="w-full text-sm" data-testid="owes-us">
            <tbody>
              {data.owesUs.map((r) => (
                <tr key={r.id} className="border-t border-border first:border-0">
                  <td className="py-1">
                    <Link href={`/jobs/${r.jobId}`} className="text-[var(--primary)] hover:underline">
                      {r.number}
                    </Link>
                  </td>
                  <td className="py-1 text-muted-foreground">
                    {r.status.replace(/_/g, " ")}
                    <span className="block text-xs">{r.salesCategory === "installer_materials" ? "Installer materials" : "Customer sales"}</span>
                  </td>
                  <td className="py-1 text-right">{money(r.due)} due</td>
                  <td className="py-1 text-right text-xs text-muted-foreground">of {money(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing.</p>
        )}
      </Section>
      <Section title={`We owe him ${money(oweTotal)}`} hint="His contractor bills in Ops that are not paid yet.">
        {data.weOweHim.length ? (
          <table className="w-full text-sm">
            <tbody>
              {data.weOweHim.map((b) => (
                <tr key={b.id} className="border-t border-border first:border-0">
                  <td className="py-1">Bill {b.number}</td>
                  <td className="py-1 text-muted-foreground">{b.status.replace(/_/g, " ")}</td>
                  <td className="py-1 text-right">{money(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing.</p>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------ contras ------------------------------ */

type Contra = Overview["contras"][number];

const STATUS: Record<string, { label: string; colour: string }> = {
  draft: { label: "Waiting for approval", colour: "#b45309" },
  approved: { label: "Approved, not posted", colour: "#2563eb" },
  posting: { label: "Posting", colour: "#2563eb" },
  incomplete: { label: "Incomplete", colour: "#dc2626" },
  posted: { label: "Posted, checking Xero", colour: "#7c3aed" },
  confirmed: { label: "Settled", colour: "#059669" },
  cancelled: { label: "Cancelled", colour: "#6b7280" },
};

function Contras({ installerId, data }: { installerId: number; data: Overview }) {
  const pinned = !!data.link?.xeroPinned;
  return (
    <Section
      title="Contras (owner only)"
      hint="Offset what he owes on one invoice against what Terra owes him on one Xero bill. Two Xero payments to the clearing account, same date, same amount."
    >
      <div className="flex flex-col gap-3">
        <Note tone={data.flags.posting ? "warn" : "info"}>
          {data.flags.posting
            ? "Posting is switched on for this server. Approving and posting sends two payments to Xero."
            : "Posting to Xero is switched off on this server. You can preview and prepare. Nothing is sent to Xero."}
        </Note>
        {data.contraAccount ? (
          <p className="text-xs text-muted-foreground" data-testid="contra-account">
            Clearing account: <span className="font-medium text-foreground">{data.contraAccount}</span>. Set in Settings, Xero. Your bookkeeper confirms the code.
          </p>
        ) : (
          <Note tone="warn">No contra clearing account is set. Ask your bookkeeper for the code, then set it in Settings, Xero.</Note>
        )}
        {!data.link ? <p className="text-sm text-muted-foreground">Set Billed as first.</p> : <XeroContact installerId={installerId} data={data} />}
        {pinned ? <NewContra installerId={installerId} data={data} /> : null}
        {data.contras.length ? (
          <div className="flex flex-col gap-2">
            {data.contras.map((c) => (
              <ContraRow key={c.id} c={c} posting={data.flags.posting} />
            ))}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function XeroContact({ installerId, data }: { installerId: number; data: Overview }) {
  const [look, setLook] = React.useState(false);
  const found = useXeroContactsForInstaller(installerId, look);
  const pin = usePinXero();
  const [error, setError] = React.useState<string | null>(null);
  if (data.link?.xeroPinned)
    return (
      <p className="text-sm">
        Xero contact: <span className="font-medium">{data.link.xeroContactName}</span>
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Pick the one Xero contact his invoices and bills are both on.</p>
      {!look ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => setLook(true)}>
            Find his Xero contact
          </Button>
        </div>
      ) : found.isLoading ? (
        <Loading label="Reading Xero…" />
      ) : found.error ? (
        <Note tone="bad">{errText(found.error)}</Note>
      ) : (
        <div className="flex flex-col gap-1.5">
          {found.data?.invoicesGoTo ? (
            <p className="text-xs text-muted-foreground">Ops sends his invoices to Xero contact {found.data.invoicesGoTo.name}.</p>
          ) : null}
          {(found.data?.candidates ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <span className="font-medium">{c.name}</span>
              {c.abnMatch ? <Badge colour="#059669">Same ABN</Badge> : null}
              {c.supplier ? <Badge>Supplier</Badge> : null}
              {c.customer ? <Badge>Customer</Badge> : null}
              {c.archived ? <Badge colour="#6b7280">Archived</Badge> : null}
              <span className="text-xs text-muted-foreground">{c.reasons.join(", ")}</span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                disabled={pin.isPending}
                onClick={async () => {
                  setError(null);
                  try {
                    await pin.mutateAsync({ installerId, xeroContactId: c.id, repointInvoices: false });
                  } catch (e) {
                    setError(errText(e));
                  }
                }}
              >
                Use this one
              </Button>
            </div>
          ))}
          {!(found.data?.candidates ?? []).length ? <p className="text-sm text-muted-foreground">Xero has no contact like him.</p> : null}
        </div>
      )}
      {error ? <Note tone="bad">{error}</Note> : null}
    </div>
  );
}

function NewContra({ installerId, data }: { installerId: number; data: Overview }) {
  const [show, setShow] = React.useState(false);
  const bills = useXeroBills(installerId, show);
  const preview = useContraPreview();
  const prepare = useContraPrepare();
  const [invoiceId, setInvoiceId] = React.useState<number | null>(null);
  const [billId, setBillId] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [how, setHow] = React.useState<"email" | "sms" | "signed" | "in_person" | "phone">("email");
  const [note, setNote] = React.useState("");
  const [on, setOn] = React.useState(dayOf(new Date()));
  const [same, setSame] = React.useState(false);
  const [key, setKey] = React.useState(newKey);
  const [error, setError] = React.useState<string | null>(null);

  const invoices = data.owesUs.filter((r) => r.inXero && r.due > 0.004);
  const openBills = (bills.data ?? []).filter((b) => b.due > 0.004);
  const p = preview.data;

  function changed() {
    preview.reset();
    setSame(false);
    setError(null);
  }

  async function doPreview() {
    if (invoiceId == null || !billId) return;
    setError(null);
    try {
      await preview.mutateAsync({ installerId, invoiceId, billXeroId: billId, amount: amount.trim() ? Number(amount) : null });
    } catch (e) {
      setError(errText(e));
    }
  }

  async function doPrepare() {
    if (!p || invoiceId == null) return;
    setError(null);
    try {
      await prepare.mutateAsync({
        requestKey: key,
        installerId,
        invoiceId,
        billXeroId: billId,
        amount: p.amount,
        fingerprint: p.fingerprint,
        agreement: { how, note, on },
        sameEntity: true,
      });
      setKey(newKey());
      preview.reset();
      setShow(false);
      setInvoiceId(null);
      setBillId("");
      setAmount("");
      setNote("");
      setSame(false);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3">
      {!show ? (
        <div>
          <Button variant="outline" size="sm" onClick={() => setShow(true)}>
            Read his Xero bills
          </Button>
        </div>
      ) : bills.isLoading ? (
        <Loading label="Reading his bills from Xero…" />
      ) : bills.error ? (
        <Note tone="bad">{errText(bills.error)}</Note>
      ) : (
        <>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">His bills in Xero (read only)</p>
              <Button variant="ghost" size="sm" onClick={() => bills.refetch()}>
                Read again
              </Button>
            </div>
            <table className="w-full text-sm" data-testid="xero-bills">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1">Bill</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Due</th>
                </tr>
              </thead>
              <tbody>
                {(bills.data ?? []).map((b) => (
                  <tr key={b.xeroId} className="border-t border-border">
                    <td className="py-1">
                      {b.number || b.reference || "No number"}
                      {b.opsBill ? <span className="ml-1 text-xs text-muted-foreground">(Ops bill {b.opsBill.number})</span> : null}
                    </td>
                    <td>{day(b.date)}</td>
                    <td>{b.status.toLowerCase()}</td>
                    <td className="text-right">{money(b.total)}</td>
                    <td className="text-right">{money(b.paid + b.credited)}</td>
                    <td className="text-right font-medium">{money(b.due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="His invoice">
              <Select
                aria-label="His invoice"
                value={invoiceId ?? ""}
                onChange={(e) => {
                  setInvoiceId(e.target.value ? Number(e.target.value) : null);
                  changed();
                }}
              >
                <option value="">Pick one</option>
                {invoices.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.number}, {money(r.due)} due
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Against his bill">
              <Select
                aria-label="Against his bill"
                value={billId}
                onChange={(e) => {
                  setBillId(e.target.value);
                  changed();
                }}
              >
                <option value="">Pick one</option>
                {openBills.map((b) => (
                  <option key={b.xeroId} value={b.xeroId}>
                    {b.number || b.reference}, {money(b.due)} due
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount" hint="Empty takes the most it can.">
              <Input
                aria-label="Contra amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  changed();
                }}
              />
            </Field>
          </div>
          {!invoices.length ? <p className="text-xs text-muted-foreground">None of his invoices is in Xero with money owing.</p> : null}
          <div>
            <Button size="sm" variant="outline" disabled={invoiceId == null || !billId || preview.isPending} onClick={doPreview}>
              {preview.isPending ? <Spinner /> : null}
              Preview from Xero
            </Button>
          </div>

          {p ? (
            <div className="flex flex-col gap-2" data-testid="contra-preview">
              {p.ok ? (
                <Note tone="info">
                  Contra <span className="font-medium">{money(p.amount)}</span> on clearing account {p.contraAccount}.<br />
                  {p.invoice.number}: {money(p.invoice.due)} due now, {money(p.invoice.after)} after.
                  <br />
                  Bill {p.bill.number}: {money(p.bill.due)} due now, {money(p.bill.after)} after.
                  <br />
                  <span className="text-xs text-muted-foreground">{p.sameEntityBasis}</span>
                </Note>
              ) : (
                <Note tone="bad">
                  {p.problems.map((x) => (
                    <div key={x}>{x}</div>
                  ))}
                </Note>
              )}
              {p.ok ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-[10rem_10rem_1fr]">
                    <Field label="He agreed by">
                      <Select value={how} onChange={(e) => setHow(e.target.value as typeof how)}>
                        <option value="email">Email</option>
                        <option value="sms">Text</option>
                        <option value="signed">Signed</option>
                        <option value="in_person">In person</option>
                        <option value="phone">Phone</option>
                      </Select>
                    </Field>
                    <Field label="On">
                      <Input type="date" value={on} onChange={(e) => setOn(e.target.value)} />
                    </Field>
                    <Field label="What he agreed to">
                      <Textarea aria-label="Agreement note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: his email of 28 Oct, take the $1,000 for the hybrid off bill 1501" />
                    </Field>
                  </div>
                  <label className="flex items-start gap-2 text-sm">
                    <Checkbox checked={same} onChange={(e) => setSame(e.target.checked)} aria-label="Same entity on both" className="mt-0.5" />
                    The invoice and the bill are the same legal person or business.
                  </label>
                  <div>
                    <Button size="sm" disabled={!same || note.trim().length < 8 || prepare.isPending} onClick={doPrepare}>
                      Prepare contra
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      {error ? <Note tone="bad">{error}</Note> : null}
    </div>
  );
}

function ContraRow({ c, posting }: { c: Contra; posting: boolean }) {
  const approve = useContraApprove();
  const post = useContraPost();
  const confirm = useContraConfirm();
  const cancel = useContraCancel();
  const [typed, setTyped] = React.useState("");
  const [msg, setMsg] = React.useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [showLog, setShowLog] = React.useState(false);
  const log = useContraHistory(c.id, showLog);
  const st = STATUS[c.status] ?? { label: c.status, colour: "#6b7280" };
  const canCancel = ["draft", "approved", "incomplete"].includes(c.status) && !c.invPaymentId && !c.billPaymentId;
  const busy = approve.isPending || post.isPending || confirm.isPending || cancel.isPending;

  async function run(fn: () => Promise<{ message?: string } | unknown>) {
    setMsg(null);
    try {
      const r = (await fn()) as { message?: string } | undefined;
      if (r && typeof r === "object" && "message" in r && r.message) setMsg({ tone: /incomplete|not|does not/i.test(r.message) ? "bad" : "ok", text: r.message });
    } catch (e) {
      setMsg({ tone: "bad", text: errText(e) });
    }
  }

  return (
    <div className="rounded-md border border-border p-3 text-sm" data-testid={`contra-${c.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">C{c.id}</span>
        <Badge colour={st.colour}>{st.label}</Badge>
        <span>
          {money(c.amount)}: {c.invoiceNumber} against bill {c.billNumber}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Before: invoice {money(c.invoiceDueBefore)} due, bill {money(c.billDueBefore)} due. Account {c.contraAccount}, dated {day(c.paidOn)}.
        <br />
        He agreed by {c.agreementHow.replace("_", " ")} on {day(c.agreementOn)}: {c.agreementNote}
        <br />
        Prepared by {c.preparedByName}
        {c.approvedByName ? `. Approved by ${c.approvedByName} (typed "${c.approvalText}")` : ""}.
        {c.invPaymentId ? " Invoice side in Xero." : ""}
        {c.billPaymentId ? " Bill side in Xero." : ""}
        {c.cancelledByName ? ` Cancelled by ${c.cancelledByName}: ${c.lastError}` : ""}
      </p>
      {c.lastError && c.status === "incomplete" ? <Note tone="bad">{c.lastError}</Note> : null}

      {c.status === "draft" ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label={`To approve, type ${c.phrase}`} hint="You may prepare and approve it yourself. This is your sign off and is recorded.">
            <Input aria-label="Approval phrase" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={c.phrase} />
          </Field>
          <Button size="sm" disabled={busy || !typed.trim()} onClick={() => run(() => approve.mutateAsync({ id: c.id, confirm: typed }))}>
            Approve
          </Button>
        </div>
      ) : null}

      {["approved", "posting", "incomplete"].includes(c.status) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {posting ? (
            <Button size="sm" disabled={busy} onClick={() => run(() => post.mutateAsync({ id: c.id }))}>
              {post.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              {c.status === "approved" ? "Post to Xero" : "Retry the missing side"}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">Posting is switched off on this server. Nothing was sent.</span>
          )}
        </div>
      ) : null}

      {c.status === "posted" ? (
        <div className="mt-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => confirm.mutateAsync({ id: c.id }))}>
            Check Xero
          </Button>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-2">
        {canCancel && !cancelOpen ? (
          <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
            Cancel contra
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide trail" : "Audit trail"}
        </Button>
      </div>
      {cancelOpen ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Why cancel?">
            <Input aria-label="Cancel reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await cancel.mutateAsync({ id: c.id, reason });
                setCancelOpen(false);
                return { message: "Cancelled. Nothing was sent to Xero." };
              })
            }
          >
            Cancel it
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCancelOpen(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
      {showLog ? (
        <ul className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-xs" data-testid={`contra-trail-${c.id}`}>
          {(log.data ?? []).map((a) => (
            <li key={a.id}>
              <span className="text-muted-foreground">{a.createdAt ? new Date(a.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Brisbane" }) : ""}</span>{" "}
              <span className="font-medium">{a.actorName}</span>: {a.detail}
            </li>
          ))}
        </ul>
      ) : null}
      {msg ? (
        <div className="mt-2">
          <Note tone={msg.tone}>{msg.text}</Note>
        </div>
      ) : null}
    </div>
  );
}
