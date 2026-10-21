import * as React from "react";
import { Link, useLocation, useSearch } from "wouter";
import { ArrowLeft, ChevronRight, FileText, Inbox, Mail, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Page } from "../components/layout";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { money, moneyExact, shortDate } from "../lib/money";
import { orpc } from "../lib/api";
import { PAIR_META } from "../components/purchase-orders";
import { InvoicePanel, RequestModal, UploadPdfButton, errText, requestStatus } from "../components/supplier-invoice";
import { PriceFlagRow } from "../components/price-checks";
import { useLabelledInvoices, useOwed, useSupplierOwed, useUnlabelInvoice } from "../queries/payables";
import { usePriceChecks } from "../queries/price-checks";
import { EmailInput } from "../components/email-input";

/**
 * SUPPLIERS OWED.
 *
 * What Terra owes each supplier, from the invoices the email agent read out
 * of billing@, damien@ and team@, matched to the POs raised on jobs in Ops.
 * Owed amounts are inc GST, because that is what leaves the bank. PO
 * comparisons are ex GST, because that is how a PO is written.
 */

type Owed = NonNullable<ReturnType<typeof useOwed>["data"]>;
type NeedsItem = Owed["needsYou"][number];
type Detail = NonNullable<ReturnType<typeof useSupplierOwed>["data"]>;
type InvRow = Detail["noPo"][number];

const NEEDS_LABEL: Record<NeedsItem["kind"], { label: string; colour: string }> = {
  no_po: { label: "No PO", colour: "#C0603F" },
  different: { label: "Price different", colour: "#D08A1E" },
  unknown_supplier: { label: "Who is this?", colour: "#C0603F" },
  request: { label: "Missing invoice", colour: "#4A7FA5" },
  late_invoice: { label: "No invoice yet", colour: "#7A736D" },
  mailbox: { label: "Mailbox", colour: "#C0603F" },
};

/**
 * Every figure here is Terra's own record: invoices read from email, less the
 * ones marked paid by a statement or by hand. Xero is not connected, so
 * payments and credits entered only in Xero are not in it (21 Oct). Wording
 * waiting on Damien's pick.
 */
const NOT_CHECKED = "Not checked against Xero yet. Recorded payments and credits may be missing.";

const dayOf = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "");

/** Saves a supplier's email. Written out here so its input stays typed. */
function useSaveSupplierEmail() {
  const queryClient = useQueryClient();
  return useMutation(
    orpc.suppliers.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.suppliers.key() });
        queryClient.invalidateQueries({ queryKey: orpc.payables.key() });
        queryClient.invalidateQueries({ queryKey: orpc.purchasing.key() });
      },
    }),
  );
}

export default function SuppliersOwedPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const key = new URLSearchParams(search).get("s");
  const [invoiceId, setInvoiceId] = React.useState<number | null>(null);
  const [requestId, setRequestId] = React.useState<number | null>(null);

  const openSupplier = (k: string | null) => navigate(k ? `/finance/suppliers-owed?s=${encodeURIComponent(k)}` : "/finance/suppliers-owed");

  return (
    <Page
      title="Suppliers owed"
      subtitle="What Terra owes each supplier, from their invoices matched to the POs raised on jobs."
      actions={<UploadPdfButton />}
    >
      {key ? (
        <SupplierDetail k={key} onBack={() => openSupplier(null)} onInvoice={setInvoiceId} onRequest={setRequestId} />
      ) : (
        <Overview onSupplier={openSupplier} onInvoice={setInvoiceId} onRequest={setRequestId} />
      )}
      {invoiceId != null ? <InvoicePanel id={invoiceId} onClose={() => setInvoiceId(null)} /> : null}
      {requestId != null ? <RequestModal id={requestId} onClose={() => setRequestId(null)} /> : null}
    </Page>
  );
}

/* ================================ overview ================================ */

function Overview({
  onSupplier,
  onInvoice,
  onRequest,
}: {
  onSupplier: (k: string) => void;
  onInvoice: (id: number) => void;
  onRequest: (id: number) => void;
}) {
  const q = useOwed();
  const checks = usePriceChecks();
  if (q.isLoading) return <Loading label="Working out what's owed…" />;
  const d = q.data;
  const flags = checks.data?.open ?? [];
  const needsCount = d ? d.needsYou.length + flags.length : 0;
  if (!d) return <Empty>{errText(q.error) || "Couldn't load Suppliers owed."}</Empty>;

  const open = (n: NeedsItem) => {
    if (n.kind === "request") onRequest(n.id);
    else if (n.kind === "late_invoice") {
      if (n.supplierKey) onSupplier(n.supplierKey);
    } else if (n.kind !== "mailbox") onInvoice(n.id);
  };
  const noEmail = d.suppliers.filter((s) => s.supplierId && !s.hasEmail && (s.awaitingInvoice > 0 || s.invoices > 0));

  return (
    <div className="space-y-4">
      {d.mailboxesConnected === 0 ? (
        <Card className="border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-4 py-3.5">
          <div className="flex flex-wrap items-start gap-3">
            <Inbox className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
            <p className="flex-1 text-[13px] text-muted-foreground">
              <span className="font-semibold text-foreground">The email agent isn't reading any mailbox yet.</span> Connect billing@, damien@ and team@ in
              Settings and invoices land here by themselves. Until then, upload a supplier PDF with the button above.
            </p>
            <Button size="sm" variant="outline" asChild>
              <Link to="/settings#email-agent">
                <SettingsIcon /> Email agent
              </Link>
            </Button>
          </div>
        </Card>
      ) : null}

      <Card className="border-[var(--warning)]/45 bg-[var(--warning)]/[0.08] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <p className="text-[13px]">
            <span className="font-semibold">Balance not verified.</span> {NOT_CHECKED} Owed, overdue, due soon and every supplier row below are from Terra's
            own records only: invoices read from email, less those marked paid on a statement or by hand.
          </p>
        </div>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Owed" value={money(d.totals.owedIncGst)} hint="Unpaid invoices, inc GST. Not checked against Xero." />
        <Stat label="Overdue" value={money(d.totals.overdueIncGst)} tone={d.totals.overdueIncGst > 0 ? "danger" : "default"} hint="Past the due date. Not checked against Xero." />
        <Stat label="Due in 14 days" value={money(d.totals.dueSoonIncGst)} tone={d.totals.dueSoonIncGst > 0 ? "warning" : "default"} hint="Not overdue yet. Not checked against Xero." />
        <Stat label="Ordered, not billed" value={money(d.totals.awaitingExGst)} hint="Sent POs with no invoice, ex GST" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader title="By supplier" subtitle="Most overdue first. Tap a supplier to see each PO next to its invoice. Owed and overdue are not checked against Xero yet." action={<Badge>{d.suppliers.length}</Badge>} />
          {d.suppliers.length === 0 ? (
            <Empty>Nothing owed and no POs waiting on an invoice.</Empty>
          ) : (
            <div className="board-scroll overflow-x-auto">
              <table className="w-full min-w-[600px] text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Supplier</th>
                    <th className="th px-4 text-right">Owed</th>
                    <th className="th px-4 text-right">Overdue</th>
                    <th className="th px-4">Next due</th>
                    <th className="th px-4">Waiting on invoice</th>
                    <th className="th px-4">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.suppliers.map((s) => (
                    <tr key={s.key} className="cursor-pointer border-b border-border last:border-0 hover:bg-secondary/50" onClick={() => onSupplier(s.key)}>
                      <td className="px-4 py-2.5">
                        <span className="font-medium">{s.name}</span>
                        <div className="mt-0.5 flex flex-wrap gap-1.5">
                          {!s.supplierId ? <Badge colour="#C0603F">Not in Ops</Badge> : null}
                          {s.needsYou ? <Badge colour="#D08A1E">{s.needsYou} to check</Badge> : null}
                          {s.supplierId && !s.hasEmail ? <Badge>No email</Badge> : null}
                        </div>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right font-semibold">{s.invoices ? money(s.owedIncGst) : "-"}</td>
                      <td className={s.overdueIncGst > 0 ? "tabular px-4 py-2.5 text-right font-semibold text-destructive" : "tabular px-4 py-2.5 text-right text-muted-foreground"}>
                        {s.overdueIncGst ? money(s.overdueIncGst) : "-"}
                      </td>
                      <td className="tabular px-4 py-2.5">{s.nextDue ? shortDate(s.nextDue) : "-"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {s.awaitingInvoice ? `${s.awaitingInvoice} ${s.awaitingInvoice === 1 ? "PO" : "POs"} · ${money(s.awaitingExGst)} ex` : "-"}
                      </td>
                      <td className="px-2 py-2.5 text-muted-foreground">
                        <ChevronRight className="size-4" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Needs you" subtitle="Everything the agent couldn't settle by itself." action={<Badge colour={needsCount ? "#D08A1E" : undefined}>{needsCount}</Badge>} />
            {flags.length ? (
              <div className="border-b border-border">
                <p className="label-xs bg-secondary/40 px-4 py-1.5">
                  Prices to check · {flags.length} · nothing changes until you approve
                </p>
                <ul className="divide-y divide-border">
                  {flags.map((f) => (
                    <li key={`flag-${f.id}`}>
                      <PriceFlagRow f={f} onInvoice={onInvoice} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {d.needsYou.length === 0 ? (
              flags.length ? null : <Empty>All clear. Every invoice matches its PO and the price list.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {d.needsYou.map((n) => {
                  const meta = NEEDS_LABEL[n.kind];
                  const inner = (
                    <>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge colour={meta.colour}>{meta.label}</Badge>
                            {n.date ? <span className="text-[11px] text-muted-foreground">{shortDate(n.date)}</span> : null}
                          </div>
                          <p className="mt-1 text-sm font-medium">{n.title}</p>
                          <p className="text-xs text-muted-foreground">{n.detail}</p>
                        </div>
                        {n.amount != null ? <span className="tabular text-sm font-semibold">{moneyExact(n.amount)}</span> : null}
                      </div>
                    </>
                  );
                  return (
                    <li key={`${n.kind}-${n.id}`}>
                      {n.kind === "mailbox" ? (
                        <Link to="/settings#email-agent" className="block px-4 py-3 hover:bg-secondary/50">
                          {inner}
                        </Link>
                      ) : (
                        <button type="button" onClick={() => open(n)} className="block w-full px-4 py-3 text-left hover:bg-secondary/50">
                          {inner}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {noEmail.length ? (
            <Card className="px-4 py-3.5">
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
                <div className="text-[13px] text-muted-foreground">
                  <p>
                    <span className="font-semibold text-foreground">
                      {noEmail.length} {noEmail.length === 1 ? "supplier has" : "suppliers have"} no email on file.
                    </span>{" "}
                    POs and missing-invoice requests can't go to them until one is added.
                  </p>
                  <p className="mt-1">
                    {noEmail.map((s, i) => (
                      <React.Fragment key={s.key}>
                        {i ? ", " : ""}
                        <button type="button" className="font-medium text-primary hover:underline" onClick={() => onSupplier(s.key)}>
                          {s.name}
                        </button>
                      </React.Fragment>
                    ))}
                  </p>
                </div>
              </div>
            </Card>
          ) : null}

          <LabelledCard unpaid={d.labelledUnpaid} onInvoice={onInvoice} />

          <AutoSendNote on={d.autoSend} />
        </div>
      </div>
    </div>
  );
}

/**
 * Invoices labelled No PO needed or Before POs. The label only takes the
 * missing PO warning off Needs you. They still count in every total, and
 * price checks on them stay open. Search, see who labelled each one and why,
 * and take a label off (21 Oct).
 */
function LabelledCard({ unpaid, onInvoice }: { unpaid: number; onInvoice: (id: number) => void }) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [source, setSource] = React.useState<"all" | "supplier" | "date" | "review">("all");
  const q = useLabelledInvoices(search.trim(), source, open);
  const unlabel = useUnlabelInvoice();
  return (
    <Card>
      <CardHeader
        title="Labelled, no PO"
        subtitle="Off Needs you for the missing PO only. Still owed, still price checked."
        action={
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : `Show${unpaid ? ` · ${unpaid} unpaid` : ""}`}
          </Button>
        }
      />
      {open ? (
        <div className="space-y-2 px-4 pb-3">
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Supplier, invoice no or reason"
              aria-label="Search labelled invoices"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-sm"
            />
            <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Where the label came from" className="h-8 rounded-md border border-border bg-background px-2 text-sm">
              <option value="all">All</option>
              <option value="review">Backlog review</option>
              <option value="supplier">Supplier tick</option>
              <option value="date">Dated before POs</option>
            </select>
          </div>
          {q.isLoading ? (
            <Loading />
          ) : !q.data?.items.length ? (
            <Empty>No labelled invoices{search ? " match" : ""}.</Empty>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                {q.data.total} labelled{q.data.total > q.data.items.length ? `, first ${q.data.items.length} shown` : ""}
              </p>
              <ul className="max-h-[420px] divide-y divide-border overflow-y-auto rounded-md border border-border">
                {q.data.items.map((r) => (
                  <li key={r.id} className="px-3 py-2 text-sm">
                    <div className="flex items-start gap-2">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onInvoice(r.id)}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge colour="#7A736D">{r.labelWords}</Badge>
                          <span className="text-[11px] text-muted-foreground">{r.sourceWords}</span>
                          {r.payState === "paid" ? <Badge colour="#4A7FA5">Paid</Badge> : null}
                        </div>
                        <p className="mt-0.5 font-medium">
                          {r.supplier} · {r.invoiceNumber}
                          {r.date ? <span className="text-xs font-normal text-muted-foreground"> · {shortDate(r.date)}</span> : null}
                        </p>
                        {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                        {r.labelledBy ? (
                          <p className="text-[11px] text-muted-foreground">
                            By {r.labelledBy}
                            {r.labelledAt ? `, ${dayOf(r.labelledAt)}` : ""}
                          </p>
                        ) : null}
                      </button>
                      <div className="flex flex-col items-end gap-1">
                        <span className="tabular text-sm font-semibold">{moneyExact(r.amount)}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={unlabel.isPending}
                          onClick={() => {
                            if (window.confirm(`Take the label off ${r.supplier} invoice ${r.invoiceNumber}? It goes back on Needs you as missing a PO. Nothing else changes.`))
                              unlabel.mutate({ invoiceId: r.id });
                          }}
                        >
                          Take off
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function AutoSendNote({ on }: { on: boolean }) {
  return (
    <p className="px-1 text-xs text-muted-foreground">
      {on
        ? "Missing-invoice requests send by themselves from team@. "
        : "Missing-invoice requests wait for your okay before they go from team@. "}
      <Link to="/settings#email-agent" className="font-medium text-primary hover:underline">
        Change in Settings
      </Link>
    </p>
  );
}

/* ================================= detail ================================= */

function SupplierDetail({
  k,
  onBack,
  onInvoice,
  onRequest,
}: {
  k: string;
  onBack: () => void;
  onInvoice: (id: number) => void;
  onRequest: (id: number) => void;
}) {
  const q = useSupplierOwed(k);
  const d = q.data;
  const checks = usePriceChecks();
  const flags = (checks.data?.open ?? []).filter((f) => d?.supplier && f.supplierId === d.supplier.id);

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> All suppliers
      </button>
      {q.isLoading ? (
        <Loading />
      ) : !d ? (
        <Empty>{errText(q.error) || "Couldn't load this supplier."}</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{d.name}</h2>
              <p className="text-xs text-muted-foreground">
                {d.supplier ? (
                  <>
                    {d.supplier.accountNumber ? `Account ${d.supplier.accountNumber} · ` : ""}
                    {d.supplier.email ?? "No email on file"} ·{" "}
                    <Link to={`/suppliers?id=${d.supplier.id}`} className="font-medium text-primary hover:underline">
                      Supplier settings
                    </Link>
                  </>
                ) : (
                  "Not a supplier in Ops yet. Open an invoice to say which supplier this is."
                )}
              </p>
            </div>
          </div>

          <p className="text-xs text-[var(--warning)]">{NOT_CHECKED}</p>

          {d.supplier && !d.supplier.email ? <AddEmail supplierId={d.supplier.id} name={d.supplier.name} /> : null}

          {flags.length ? (
            <Card>
              <CardHeader
                title="Prices to check"
                subtitle={`Rates on ${d.name} invoices that differ from Ops. Nothing changes until you approve.`}
                action={<Badge colour="#D08A1E">{flags.length}</Badge>}
              />
              <ul className="divide-y divide-border">
                {flags.map((f) => (
                  <li key={f.id}>
                    <PriceFlagRow f={f} onInvoice={onInvoice} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {d.supplier ? (
            <Card>
              <CardHeader title="POs and their invoices" subtitle="Sent POs from the last year, newest first. PO amounts are ex GST." action={<Badge>{d.pairs.length}</Badge>} />
              {d.pairs.length === 0 ? (
                <Empty>No POs sent to {d.name} yet. Raise one from a job's Purchase orders card.</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {d.pairs.map((p) => {
                    const meta = PAIR_META[p.state] ?? PAIR_META.no_invoice!;
                    return (
                      <li key={p.po.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="tabular text-sm font-semibold">{p.po.number}</span>
                            <Badge colour={meta.colour}>{meta.label}</Badge>
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            <Link to={`/jobs/${p.po.jobId}`} className="text-primary hover:underline">
                              #{p.po.jobNumber}
                            </Link>{" "}
                            {p.po.jobTitle}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {moneyExact(p.po.totalExGst)} ex{p.po.sentAt ? ` · sent ${dayOf(p.po.sentAt)}` : ""}
                          </p>
                        </div>
                        <div>
                          {p.invoices.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No invoice yet.</p>
                          ) : (
                            <div className="space-y-1.5">
                              {p.invoices.map((i) => (
                                <InvoiceLine key={i.id} i={i} onOpen={() => onInvoice(i.id)} />
                              ))}
                              {p.invoices.length > 1 ? (
                                <p className="text-right text-[11px] text-muted-foreground">Billed {moneyExact(p.billedExGst)} ex across {p.invoices.length}</p>
                              ) : null}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Invoices with no PO" subtitle="Tie each to a PO, or okay it if there was never going to be one." action={<Badge colour={d.noPo.length ? "#C0603F" : undefined}>{d.noPo.length}</Badge>} />
            {d.noPo.length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              <div className="space-y-1.5 px-4 py-3">
                {d.noPo.map((i) => (
                  <InvoiceLine key={i.id} i={i} onOpen={() => onInvoice(i.id)} />
                ))}
              </div>
            )}
          </Card>

          {d.requests.length || d.statements.length ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader title="Missing-invoice requests" subtitle="On their statement, never received. Sent from team@, asking for the invoice at billing@." />
                {d.requests.length === 0 ? (
                  <Empty>None.</Empty>
                ) : (
                  <ul className="divide-y divide-border">
                    {d.requests.map((r) => {
                      const st = requestStatus(r.status);
                      return (
                        <li key={r.id}>
                          <button type="button" onClick={() => onRequest(r.id)} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-secondary/50">
                            <span className="flex-1">
                              Invoice {r.invoiceNumber}
                              <span className="text-xs text-muted-foreground">{r.invoiceDate ? ` · ${shortDate(r.invoiceDate)}` : ""}</span>
                              {r.error ? <span className="block text-xs text-destructive">{r.error}</span> : null}
                            </span>
                            {r.amountIncGst != null ? <span className="tabular text-xs">{moneyExact(r.amountIncGst)}</span> : null}
                            <Badge colour={st.colour}>{st.label}</Badge>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Recent statements" />
                {d.statements.length === 0 ? (
                  <Empty>No statements read yet.</Empty>
                ) : (
                  <ul className="divide-y divide-border">
                    {d.statements.map((s) => (
                      <li key={s.id} className="flex items-center gap-2 px-4 py-2.5 text-sm">
                        <FileText className="size-4 text-muted-foreground" />
                        <span className="flex-1">
                          {s.statementDate ? shortDate(s.statementDate) : "Undated"}
                          <span className="text-xs text-muted-foreground"> · {s.lines} lines</span>
                        </span>
                        <span className="tabular text-xs">
                          {s.balanceIncGst != null ? `${moneyExact(s.balanceIncGst)} balance` : ""}
                          {s.overdueIncGst ? <span className="text-destructive"> · {moneyExact(s.overdueIncGst)} overdue</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function InvoiceLine({ i, onOpen }: { i: InvRow; onOpen: () => void }) {
  const meta = PAIR_META[i.pair] ?? PAIR_META.no_po!;
  return (
    <button type="button" onClick={onOpen} className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-secondary/50">
      <span className="min-w-0 flex-1">
        <span className="font-medium">
          {i.docType === "credit" ? "Credit" : "Invoice"} {i.invoiceNumber}
        </span>
        <span className="text-xs text-muted-foreground">
          {i.invoiceDate ? ` · ${shortDate(i.invoiceDate)}` : ""}
          {i.poRefRaw ? ` · ref "${i.poRefRaw}"` : ""}
        </span>
        {i.pair === "different" && i.diffExGst != null ? (
          <span className="block text-xs text-[var(--warning)]">
            {moneyExact(Math.abs(i.diffExGst))} {i.diffExGst > 0 ? "over" : "under"} the PO
          </span>
        ) : null}
      </span>
      <Badge colour={meta.colour}>{meta.label}</Badge>
      {i.payState === "paid" ? (
        <Badge colour="#3F7D3A">Paid</Badge>
      ) : (
        <span className={i.overdue ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
          {i.dueDate ? `${i.overdue ? "overdue " : "due "}${shortDate(i.dueDate)}` : "no due date"}
        </span>
      )}
      <span className="tabular w-24 text-right font-semibold">{moneyExact(i.totalIncGst)}</span>
    </button>
  );
}

function AddEmail({ supplierId, name }: { supplierId: number; name: string }) {
  const save = useSaveSupplierEmail();
  const [email, setEmail] = React.useState("");
  const [error, setError] = React.useState("");
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <Card className="border-[var(--warning)]/35 bg-[var(--warning)]/[0.06] px-4 py-3.5">
      <div className="flex flex-wrap items-start gap-3">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="min-w-[240px] flex-1 space-y-2">
          <p className="text-[13px] text-muted-foreground">
            <span className="font-semibold text-foreground">No email on file for {name}.</span> POs and missing-invoice requests need one.
          </p>
          <div className="flex flex-wrap gap-2">
            <EmailInput wrapperClassName="w-full max-w-xs" value={email} onValueChange={setEmail} placeholder="orders@supplier.com.au" />
            <Button
              size="sm"
              disabled={!ok || save.isPending}
              onClick={async () => {
                setError("");
                try {
                  await save.mutateAsync({ id: supplierId, email: email.trim() });
                } catch (e) {
                  setError(errText(e));
                }
              }}
            >
              {save.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save email
            </Button>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </Card>
  );
}
