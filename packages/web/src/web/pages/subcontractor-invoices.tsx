import * as React from "react";
import { Link } from "wouter";
import { Check, Download, Info, X } from "lucide-react";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select } from "../components/ui/field";
import { moneyExact } from "../lib/money";
import { useInstallers } from "../queries/installers";
import { useBootstrap } from "../queries/settings";
import {
  type InvoiceStatus,
  useDecideVariation,
  useInvoicePdfUrl,
  useSetInvoiceStatus,
  useSubcontractorInvoices,
  useVariationRequests,
} from "../queries/installerInvoices";
import { useInvoiceBalances, useInvoiceEntries, useRecordPayment, useXeroPaymentCheck } from "../queries/hourlyInvoices";

type Balance = NonNullable<ReturnType<typeof useInvoiceBalances>["data"]>[number];
type XeroRow = NonNullable<ReturnType<typeof useXeroPaymentCheck>["data"]>["rows"][number];

const STATE_COLOUR: Record<string, string> = { awaiting_payment: "#C0603F", part_paid: "#D08A1E", paid: "#3F7D3A" };

function sayYmd(ymd: string | null | undefined) {
  if (!ymd) return "";
  return new Date(`${ymd}T12:00:00+10:00`).toLocaleDateString("en-AU", { timeZone: "Australia/Brisbane", day: "numeric", month: "short", year: "numeric" });
}

function todayBrisbane() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * SUBCONTRACTOR INVOICES.
 *
 * The other direction to the Finance invoices screen. These are invoices the
 * installers raise against Terra for their own pay, generated in Terra Crew
 * off the rates already agreed on the job. Nothing on this page can change an
 * amount. The office approves the invoice, schedules it, marks it paid, and
 * the installer watches that status move in the app.
 *
 * The one place an amount is decided is the variation queue at the top. An
 * installer who reckons something extra is owed asks here, and only once it is
 * approved can it appear on an invoice.
 */

const STATUS_FLOW: { key: InvoiceStatus; label: string; colour: string }[] = [
  { key: "submitted", label: "Submitted", colour: "#4A7FA5" },
  { key: "approved", label: "Approved", colour: "#D08A1E" },
  { key: "scheduled_for_payment", label: "Scheduled for payment", colour: "#C0603F" },
  { key: "paid", label: "Paid", colour: "#3F7D3A" },
];

const STATUS_LABEL = Object.fromEntries(STATUS_FLOW.map((s) => [s.key, s.label]));
const STATUS_COLOUR = Object.fromEntries(STATUS_FLOW.map((s) => [s.key, s.colour]));

/** What the office can move this invoice to next, in order. */
const NEXT_STATUS: Record<InvoiceStatus, InvoiceStatus | null> = {
  submitted: "approved",
  approved: "scheduled_for_payment",
  scheduled_for_payment: "paid",
  paid: null,
};

function stamp(value: Date | string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });
}

type LineItem = { description: string; unit?: string; qty?: number; rate?: number; total: number };

function parseLines(json: string): LineItem[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as LineItem[]) : [];
  } catch {
    return [];
  }
}

/* --------------------------- variation queue --------------------------- */

function VariationQueue({ installerName }: { installerName: (id: number) => string }) {
  const q = useVariationRequests("pending");
  const decide = useDecideVariation();
  const bootstrap = useBootstrap();
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [amounts, setAmounts] = React.useState<Record<number, string>>({});

  const rows = q.data ?? [];
  if (q.isLoading || rows.length === 0) return null;

  const decidedByName = bootstrap.data?.actor.name || "Office";

  async function run(id: number, approve: boolean, original: number) {
    setBusy(id);
    setError(null);
    try {
      const typed = Number(amounts[id]);
      await decide.mutateAsync({
        id,
        approve,
        decidedByName,
        // Approving at a different figure than asked is normal. Blank keeps theirs.
        amount: approve && Number.isFinite(typed) && typed > 0 && typed !== original ? typed : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Extras waiting on you"
        subtitle="An installer has asked to be paid for something outside the agreed job. It cannot reach an invoice until you approve it here."
        action={<Badge colour="#C0603F">{rows.length}</Badge>}
      />
      {error ? <p className="px-4 pt-3 text-[13px] text-destructive">{error}</p> : null}
      <div className="divide-y divide-border">
        {rows.map((r) => (
          <div key={r.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{installerName(r.installerId)}</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{r.description}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Task #{r.taskId}, asked {stamp(r.requestedAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-32">
                <Input
                  type="number"
                  step="0.01"
                  placeholder={r.amount.toFixed(2)}
                  value={amounts[r.id] ?? ""}
                  onChange={(e) => setAmounts((a) => ({ ...a, [r.id]: e.target.value }))}
                />
              </div>
              <Button variant="ghost" onClick={() => run(r.id, false, r.amount)} disabled={busy === r.id}>
                <X className="size-4" />
                Reject
              </Button>
              <Button onClick={() => run(r.id, true, r.amount)} disabled={busy === r.id}>
                {busy === r.id ? <Spinner className="border-white/40 border-t-white" /> : <Check className="size-4" />}
                Approve
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
        Leave the box empty to approve the amount asked for. Type a figure to approve a different one.
      </p>
    </Card>
  );
}

/* ------------------------------ one invoice ------------------------------ */

function InvoiceRow({
  row,
  installerName,
  bal,
  canSeeCosts,
  xero,
}: {
  row: NonNullable<ReturnType<typeof useSubcontractorInvoices>["data"]>[number];
  installerName: (id: number) => string;
  bal: Balance | null;
  canSeeCosts: boolean;
  xero: XeroRow | null;
}) {
  const byDates = bal?.kind === "period";
  const setStatus = useSetInvoiceStatus();
  const pdf = useInvoicePdfUrl();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const lines = React.useMemo(() => parseLines(row.lineItems), [row.lineItems]);
  const next = NEXT_STATUS[row.status as InvoiceStatus];

  async function advance() {
    if (!next) return;
    setError(null);
    try {
      await setStatus.mutateAsync({ invoiceId: row.id, status: next });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function download() {
    setError(null);
    try {
      const res = await pdf.mutateAsync({ invoiceId: row.id });
      window.open(res.url, "_blank", "noopener");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <>
      <tr className="border-b border-border hover:bg-secondary/50">
        <td className="px-4 py-2.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-left font-medium"
            aria-expanded={open}
          >
            #{row.invoiceNumber}
          </button>
          <p className="text-xs text-muted-foreground">
            {/* Notes 18.64: legal name t/a business name. Bills from before have no legal name. */}
            {row.legalName ? (row.tradingName ? `${row.legalName} t/a ${row.tradingName}` : row.legalName) : row.tradingName || row.installerName}
          </p>
        </td>
        <td className="px-4 py-2.5 text-[13px]">{installerName(row.installerId)}</td>
        <td className="px-4 py-2.5 text-xs text-muted-foreground">
          {byDates ? (
            <>
              <p className="font-medium text-foreground">Hourly, by dates</p>
              <p className="truncate">
                {bal!.periodFrom === bal!.periodTo ? sayYmd(bal!.periodFrom) : `${sayYmd(bal!.periodFrom)} to ${sayYmd(bal!.periodTo)}`}
              </p>
            </>
          ) : (
            <>
              <Link to={`/jobs/${row.jobId}`} className="text-primary hover:underline">
                #{row.jobNumber}
              </Link>
              <p className="truncate">{row.taskTitle}</p>
            </>
          )}
        </td>
        <td className="tabular px-4 py-2.5 text-[13px]">{stamp(row.submittedAt)}</td>
        <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{moneyExact(row.subtotal)}</td>
        <td className="tabular px-4 py-2.5 text-right text-muted-foreground">
          {row.gstRegistered ? moneyExact(row.gstAmount) : "No GST"}
        </td>
        <td className="tabular px-4 py-2.5 text-right font-semibold">{moneyExact(row.total)}</td>
        <td className="px-4 py-2.5">
          <Badge colour={STATUS_COLOUR[row.status]}>{STATUS_LABEL[row.status] ?? row.status}</Badge>
          {bal && bal.state !== "awaiting_payment" && row.status !== "paid" ? (
            <p className="mt-1">
              <Badge colour={STATE_COLOUR[bal.state]}>{bal.label}</Badge>
            </p>
          ) : null}
          {bal && bal.state === "part_paid" ? <p className="tabular mt-0.5 text-xs text-muted-foreground">{moneyExact(bal.balance)} left</p> : null}
          {bal?.dueDate && bal.state !== "paid" ? <p className="mt-0.5 text-xs text-muted-foreground">Due {sayYmd(bal.dueDate)}</p> : null}
          {xero?.looksPaid ? (
            <p className="mt-1">
              <Badge colour="#3F7D3A">Looks paid in Xero</Badge>
            </p>
          ) : xero?.match === "check" ? (
            <p className="mt-1">
              <Badge colour="#D08A1E">Check in Xero</Badge>
            </p>
          ) : null}
        </td>
        <td className="px-4 py-2.5">
          <div className="flex items-center justify-end gap-1.5">
            <Button variant="ghost" onClick={download} disabled={pdf.isPending || !row.pdfKey}>
              <Download className="size-4" />
              PDF
            </Button>
            {next ? (
              <Button onClick={advance} disabled={setStatus.isPending}>
                {setStatus.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
                {next === "approved" ? "Approve" : next === "scheduled_for_payment" ? "Schedule" : "Mark paid"}
              </Button>
            ) : null}
          </div>
          {error ? <p className="mt-1 text-right text-xs text-destructive">{error}</p> : null}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border bg-secondary/30">
          <td colSpan={9} className="px-4 py-3" aria-label={`Invoice ${row.invoiceNumber} detail`}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="label-xs">What they billed</p>
                <table className="mt-1.5 w-full text-[13px]">
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        <td className="py-1 pr-3">{l.description}</td>
                        <td className="tabular py-1 pr-3 text-muted-foreground">
                          {l.qty != null && l.rate != null
                            ? `${l.qty} ${l.unit ?? ""} at ${moneyExact(l.rate)}`
                            : ""}
                        </td>
                        <td className="tabular py-1 text-right">{moneyExact(l.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[13px]">
                {bal ? <PaymentsBlock row={row} bal={bal} canSeeCosts={canSeeCosts} xero={xero} /> : null}
                <p className="label-xs">Their business details, as invoiced</p>
                <dl className="mt-1.5 space-y-1">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">ABN</dt>
                    <dd>{row.abn || "not on file"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">GST</dt>
                    <dd>{row.gstRegistered ? "GST registered" : "Not GST registered"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Address</dt>
                    <dd className="text-right">{row.businessAddress || "not on file"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Pay to</dt>
                    <dd className="text-right">
                      {row.bankAccountName || "not on file"}
                      {row.bankBsb ? `, BSB ${row.bankBsb}` : ""}
                      {row.bankAccountNumber ? `, acct ${row.bankAccountNumber}` : ""}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Site</dt>
                    <dd className="text-right">{row.siteAddress || "not recorded"}</dd>
                  </div>
                </dl>
              </div>
            </div>
            {byDates ? <LinkedEntries invoiceId={row.id} /> : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ------------------- money paid, and the time it bills ------------------- */

/**
 * Damien, 13 Nov 2026: what has been paid, what is left, and recording a
 * payment as Xero shows it. If "Check Xero for payments" was pressed, what
 * the matching Xero bill shows sits here too, with a button that fills the
 * form in. Nothing is recorded until Record payment is pressed, and nothing
 * is ever written to Xero.
 */
function PaymentsBlock({ row, bal, canSeeCosts, xero }: { row: { id: number; total: number }; bal: Balance; canSeeCosts: boolean; xero: XeroRow | null }) {
  const record = useRecordPayment();
  const [amount, setAmount] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(todayBrisbane());
  const [note, setNote] = React.useState("");
  return (
    <div className="mb-4">
      <p className="label-xs">Payment</p>
      {xero && xero.match !== "none" ? (
        <div className="mt-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs">
          <p className="font-medium">
            {xero.looksPaid ? "Looks paid in Xero" : xero.match === "matched" ? "Found in Xero" : "Check in Xero"}
          </p>
          <p className="text-muted-foreground">{xero.why}</p>
          {xero.bill ? (
            <p className="tabular mt-0.5 text-muted-foreground">
              Bill {xero.bill.number || "with no number"}, {xero.bill.contact || "no contact"}, {xero.bill.status.toLowerCase()}. Total{" "}
              {moneyExact(xero.bill.total)}, paid {moneyExact(xero.bill.paid)}, due {moneyExact(xero.bill.due)}
              {xero.bill.paidOn ? `, last paid ${sayYmd(xero.bill.paidOn)}` : ""}.
            </p>
          ) : null}
          {canSeeCosts && xero.looksPaid && xero.toRecord > 0 ? (
            <Button
              variant="ghost"
              className="mt-1"
              onClick={() => {
                setAmount(xero.toRecord.toFixed(2));
                if (xero.bill?.paidOn && xero.bill.paidOn <= todayBrisbane()) setPaidOn(xero.bill.paidOn);
                setNote(`Xero bill ${xero.bill?.number ?? ""}`.trim());
              }}
            >
              Fill in {moneyExact(xero.toRecord)} from Xero
            </Button>
          ) : null}
        </div>
      ) : null}
      <dl className="mt-1.5 space-y-1">
        {bal.kind === "period" ? (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Terms</dt>
            <dd>
              {bal.termsDays != null ? `${bal.termsDays} days` : "not set"}
              {bal.dueDate ? `, due ${sayYmd(bal.dueDate)}` : ""}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Paid so far</dt>
          <dd className="tabular">{moneyExact(bal.paid)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Left to pay</dt>
          <dd className="tabular font-semibold">{moneyExact(bal.balance)}</dd>
        </div>
        {bal.payments.map((p) => (
          <div key={p.id} className="flex justify-between gap-4 text-xs text-muted-foreground">
            <dt>
              {sayYmd(p.paidOn)}
              {p.by ? `, recorded by ${p.by}` : ""}
              {p.note ? `: ${p.note}` : ""}
            </dt>
            <dd className="tabular">{moneyExact(p.amount)}</dd>
          </div>
        ))}
      </dl>
      {canSeeCosts && bal.balance > 0 ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Amount paid" className="w-[120px]">
            <Input type="number" step="0.01" min="0" placeholder={bal.balance.toFixed(2)} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Paid on" className="w-[150px]">
            <Input type="date" value={paidOn} max={todayBrisbane()} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
          <Field label="Note (optional)" className="min-w-[140px] flex-1">
            <Input value={note} maxLength={300} placeholder="Xero payment ref" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button
            disabled={record.isPending || !(Number(amount || bal.balance) > 0) || !paidOn}
            onClick={() =>
              record.mutate(
                { invoiceId: row.id, amount: Number(amount || bal.balance), paidOn, note: note.trim() || null },
                { onSuccess: () => { setAmount(""); setNote(""); } },
              )
            }
          >
            Record payment
          </Button>
          {record.error ? <p className="w-full text-xs text-destructive">{record.error.message}</p> : null}
          <p className="w-full text-xs text-muted-foreground">Leave the amount empty to record the full {moneyExact(bal.balance)} left. Enter what Xero shows as paid.</p>
        </div>
      ) : null}
    </div>
  );
}

function LinkedEntries({ invoiceId }: { invoiceId: number }) {
  const q = useInvoiceEntries(invoiceId);
  const rows = q.data ?? [];
  if (q.isLoading) return <p className="mt-3 text-xs text-muted-foreground">Loading the time entries…</p>;
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <p className="label-xs">Time entries on this invoice ({rows.length})</p>
      <table className="mt-1.5 w-full text-[13px]">
        <tbody>
          {rows.map((e) => (
            <tr key={e.sessionId} className="border-b border-border/60 last:border-0">
              <td className="tabular py-1 pr-3">{sayYmd(e.workDate)}</td>
              <td className="py-1 pr-3">
                <Link to={`/jobs/${e.jobId}`} className="text-primary hover:underline">
                  Job {e.jobId}
                </Link>
              </td>
              <td className="tabular py-1 pr-3 text-muted-foreground">
                {Math.floor(e.minutes / 60)}h{e.minutes % 60 ? ` ${e.minutes % 60}m` : ""}
              </td>
              <td className="tabular py-1 text-right">{e.amount == null ? "" : moneyExact(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------- page -------------------------------- */

export default function SubcontractorInvoicesPage() {
  const [status, setStatus] = React.useState<InvoiceStatus | "all">("submitted");
  const [installerId, setInstallerId] = React.useState<number | "all">("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const [search, setSearch] = React.useState("");

  const installers = useInstallers(true);
  const q = useSubcontractorInvoices({
    status: status === "all" ? undefined : status,
    installerId: installerId === "all" ? undefined : installerId,
    from: from || undefined,
    to: to || undefined,
  });
  /*
   * The four figures up top are a picture of the whole pipeline, so they are
   * read off their own query that follows the installer and date filters but
   * never the status one. Summing the table instead would zero three of them
   * the moment the office narrowed to a single status.
   */
  const pipeline = useSubcontractorInvoices({
    installerId: installerId === "all" ? undefined : installerId,
    from: from || undefined,
    to: to || undefined,
  });

  const bootstrap = useBootstrap();
  const canSeeCosts = Boolean(bootstrap.data?.actor.canSeeCosts);
  const ids = React.useMemo(() => (q.data ?? []).map((r) => r.id), [q.data]);
  const balances = useInvoiceBalances(ids);
  const xeroCheck = useXeroPaymentCheck();
  const xeroOf = React.useMemo(() => {
    const m = new Map((xeroCheck.data?.rows ?? []).map((r) => [r.invoiceId, r]));
    return (id: number) => m.get(id) ?? null;
  }, [xeroCheck.data]);
  const unpaidIds = React.useMemo(() => (balances.data ?? []).filter((b) => b.balance > 0).map((b) => b.invoiceId), [balances.data]);
  const balOf = React.useMemo(() => {
    const m = new Map((balances.data ?? []).map((b) => [b.invoiceId, b]));
    return (id: number) => m.get(id) ?? null;
  }, [balances.data]);

  const nameById = React.useMemo(() => {
    const m = new Map((installers.data ?? []).map((i) => [i.id, i.name]));
    return (id: number) => m.get(id) ?? `Installer ${id}`;
  }, [installers.data]);

  const rows = React.useMemo(() => {
    const all = q.data ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return all;
    return all.filter((r) =>
      [String(r.jobNumber), String(r.invoiceNumber), r.tradingName, r.installerName, r.taskTitle, r.siteAddress]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)),
    );
  }, [q.data, search]);

  const totals = React.useMemo(() => {
    const sum = (s: InvoiceStatus) =>
      (pipeline.data ?? []).filter((r) => r.status === s).reduce((n, r) => n + r.total, 0);
    return {
      submitted: sum("submitted"),
      approved: sum("approved"),
      scheduled: sum("scheduled_for_payment"),
      paid: sum("paid"),
    };
  }, [pipeline.data]);

  return (
    <Page
      title="Subcontractor invoices"
      subtitle="Invoices the installers raise against Terra for their own pay, generated in Terra Crew from the rates already agreed on the job."
    >
      <div className="space-y-4">
        <VariationQueue installerName={nameById} />

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Waiting on approval" value={moneyExact(totals.submitted)} hint="Submitted, not yet checked" />
          <Stat label="Approved" value={moneyExact(totals.approved)} hint="Checked, not yet scheduled" />
          <Stat label="Scheduled to pay" value={moneyExact(totals.scheduled)} hint="In the next pay run" />
          <Stat label="Paid" value={moneyExact(totals.paid)} hint="Settled with the installer" />
        </div>

        <Card className="px-4 py-3.5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | "all")}>
                <option value="all">Every status</option>
                {STATUS_FLOW.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Installer">
              <Select
                value={String(installerId)}
                onChange={(e) => setInstallerId(e.target.value === "all" ? "all" : Number(e.target.value))}
              >
                <option value="all">Everyone</option>
                {(installers.data ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Submitted from">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Submitted to">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Field label="Job or invoice number">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="4446" />
            </Field>
          </div>
        </Card>

        {q.isLoading ? (
          <Loading label="Loading subcontractor invoices…" />
        ) : (
          <Card>
            <CardHeader
              title={status === "all" ? "All invoices" : (STATUS_LABEL[status] ?? "Invoices")}
              subtitle="Click an invoice number to see the lines and the business details it was issued with."
              action={
                <div className="flex items-center gap-2">
                  {canSeeCosts ? (
                    <Button
                      variant="ghost"
                      disabled={xeroCheck.isPending || unpaidIds.length === 0}
                      onClick={() => xeroCheck.mutate({ invoiceIds: unpaidIds })}
                      title="Reads Xero bills only. Nothing is recorded or changed."
                    >
                      {xeroCheck.isPending ? <Spinner /> : null}
                      Check Xero for payments
                    </Button>
                  ) : null}
                  <Badge>{rows.length}</Badge>
                </div>
              }
            />
            {xeroCheck.data || xeroCheck.error ? (
              <p className={`border-b border-border px-4 py-2 text-xs ${xeroCheck.error ? "text-destructive" : "text-muted-foreground"}`}>
                {xeroCheck.error ? xeroCheck.error.message : xeroCheck.data!.message}
                {xeroCheck.data?.rows.some((r) => r.looksPaid || r.match === "check") ? " Open an invoice to see the Xero bill." : ""}
              </p>
            ) : null}
            {rows.length === 0 ? (
              <Empty>
                No invoices match that. An invoice appears here the moment an installer presses submit in Terra
                Crew on a task marked complete.
              </Empty>
            ) : (
              <div className="board-scroll overflow-x-auto">
                <table className="w-full min-w-[1100px] text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="th px-4">Invoice</th>
                      <th className="th px-4">Installer</th>
                      <th className="th px-4">Job</th>
                      <th className="th px-4">Submitted</th>
                      <th className="th px-4 text-right">Subtotal</th>
                      <th className="th px-4 text-right">GST</th>
                      <th className="th px-4 text-right">Total</th>
                      <th className="th px-4">Status</th>
                      <th className="th px-4 text-right">Do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <InvoiceRow key={r.id} row={r} installerName={nameById} bal={balOf(r.id)} canSeeCosts={canSeeCosts} xero={xeroOf(r.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        <Card className="flex items-start gap-3 px-4 py-3.5">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            These invoices are issued by the installer to Arclan Pty Ltd t/a Terra Flooring, in the installer's own
            business name and their own invoice numbering. Terra only supplies the software that fills the document
            in from the approved job. An installer cannot submit one until the office has set their starting invoice
            number and their bank details on the Invoicing tab of their installer card.
          </p>
        </Card>
      </div>
    </Page>
  );
}
