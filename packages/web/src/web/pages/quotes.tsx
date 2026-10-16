import * as React from "react";
import { SupervisorPicker } from "../components/supervisor-picker";
import { Link, useLocation } from "wouter";
import { Copy, Plus, Search } from "lucide-react";
import { QuoteCopyModal } from "../components/quote-copy";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { Combobox } from "../components/ui/combobox";
import { QuotePeopleDraft, draftsToInput, type PersonDraft } from "../components/job-people";
import { LeadSourceSelect } from "../components/lead-source-select";
import { BillToField, readyBillTo, type BillToCard } from "../components/bill-to";
import { useSetCardDeposit } from "../queries/billTo";
import { useCreateQuote, useQuoteStats, useQuotes } from "../queries/quotes";
import { ContactPicker } from "../components/contact-picker";
import { useCompanies, useSites } from "../queries/companies";
import { PhoneCardList } from "../components/phone-card-list";
import { isPhoneApp } from "../lib/phone-app";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export const QUOTE_STATUS_COLOUR: Record<string, string> = {
  draft: "#7A736D",
  needs_review: "#D08A1E",
  sent: "#D08A1E",
  accepted: "#3F7D3A",
  declined: "#B4342A",
  expired: "#7A736D",
  replaced: "#5B6E7A",
  cancelled: "#8A4B3C",
};

const STATUSES = ["draft", "needs_review", "sent", "accepted", "declined", "expired", "replaced", "cancelled"];

function fmtDate(value: Date | string | null) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });
}

export function NewQuoteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const companies = useCompanies();
  const create = useCreateQuote();
  const [form, setForm] = React.useState({
    contactId: "",
    companyId: "",
    supervisorContactId: "",
    siteId: "",
    /** Asked only when the Bill to's card has no % yet. Saved on the card. */
    billToPercent: "",
    validDays: "30",
    notes: "",
    /** Where the job came from. Required, same as New job. */
    source: "",
  });
  const [people, setPeople] = React.useState<PersonDraft[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [copying, setCopying] = React.useState(false);
  const sites = useSites(form.contactId ? { contactId: Number(form.contactId) } : {});
  // Who pays (notes 18.54). Nothing is picked for the office.
  const [billTo, setBillTo] = React.useState<BillToCard | null>(null);
  const setCard = useSetCardDeposit();
  const known = [
    ...(form.contactId ? [{ type: "contact" as const, id: Number(form.contactId), role: "Customer" }] : []),
    ...(form.companyId ? [{ type: "company" as const, id: Number(form.companyId), role: "Company" }] : []),
  ];

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    if (!form.source) {
      setError('Pick where the job came from. "Other" is fine.');
      return;
    }
    const ready = readyBillTo(billTo, form.billToPercent, "quote");
    if ("error" in ready || !billTo) {
      setError("error" in ready ? ready.error : "Pick who pays this quote (Bill to).");
      return;
    }
    try {
      if (ready.save != null) await setCard.mutateAsync({ billTo: { type: billTo.type, id: billTo.id }, percent: ready.save });
      const quote = await create.mutateAsync({
        contactId: form.contactId ? Number(form.contactId) : null,
        companyId: form.companyId ? Number(form.companyId) : null,
        supervisorContactId: form.companyId && form.supervisorContactId ? Number(form.supervisorContactId) : null,
        siteId: form.siteId ? Number(form.siteId) : null,
        // The deposit % comes off the Bill to's card.
        billTo: { type: billTo.type, id: billTo.id },
        validDays: Number(form.validDays) || 30,
        notes: form.notes || null,
        // Beyond the customer and supervisor. Merged onto one row per person on the job.
        people: draftsToInput(people),
        items: [],
        // The job is made now, at Lead, with the same number and one list of people.
        makeJob: true,
        source: form.source,
      });
      onClose();
      if (quote?.id) navigate(`/quotes/${quote.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New quote"
      subtitle="Pick who it's for, then build the lines. This also makes the job at Lead, with the same number. Bill to says who pays."
      width="max-w-xl"
      footer={
        <>
          <Button variant="outline" className="mr-auto" onClick={() => setCopying(true)}>
            <Copy className="size-4" />
            Copy from previous job
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || setCard.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Start quote
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" className="sm:col-span-2">
          <ContactPicker
            value={form.contactId}
            onChange={(v) => setForm((f) => ({ ...f, contactId: v, siteId: "" }))}
          />
        </Field>
        <Field label="Bill the company?" hint="Leave as none for a private customer">
          <Combobox
            value={form.companyId}
            onChange={(v) => setForm((f) => ({ ...f, companyId: v, supervisorContactId: "" }))}
            placeholder="Search companies…"
            emptyLabel="None, bills the person"
            options={(companies.data ?? []).map((c) => ({
              value: String(c.id),
              label: c.name,
            }))}
          />
        </Field>
        {form.companyId ? (
          <div className="sm:col-span-2">
            <SupervisorPicker
              companyId={Number(form.companyId)}
              value={form.supervisorContactId}
              onChange={(v) => set("supervisorContactId", v)}
            />
          </div>
        ) : null}
        <Field label="Site">
          <Select value={form.siteId} onChange={(e) => set("siteId", e.target.value)}>
            <option value="">No site yet</option>
            {(sites.data ?? []).map((row) => (
              <option key={row.site.id} value={row.site.id}>
                {row.site.address}
                {row.site.suburb ? `, ${row.site.suburb}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bill to (required)" hint="Who pays. The deposit % comes off their card." className="sm:col-span-2">
          <BillToField
            id="newquote_billto"
            value={billTo}
            onChange={setBillTo}
            percent={form.billToPercent}
            onPercent={(v) => set("billToPercent", v)}
            known={known}
          />
        </Field>
        <Field label="Valid for (days)">
          <Input type="number" value={form.validDays} onChange={(e) => set("validDays", e.target.value)} />
        </Field>
        <Field label="Where it came from (required)">
          <LeadSourceSelect id="newquote_source" value={form.source} onChange={(v) => set("source", v)} invalid={!form.source && !!error} />
        </Field>
        <Field label="Notes for the customer" className="sm:col-span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <QuotePeopleDraft
            value={people}
            onChange={setPeople}
            hint="Owner, tenant, agent, accounts. They go on the job's list of people, which the quote uses too."
          />
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      <QuoteCopyModal
        open={copying}
        onClose={() => setCopying(false)}
        contactId={form.contactId ? Number(form.contactId) : null}
        companyId={form.companyId ? Number(form.companyId) : null}
      />
    </Modal>
  );
}

export default function QuotesPage() {
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("");
  const [modal, setModal] = React.useState(false);
  const quotes = useQuotes({ search: search || undefined, status: status || undefined });
  const stats = useQuoteStats();
  const rows = quotes.data ?? [];

  return (
    <Page
      title="Quotes"
      subtitle="Price it and send it. Every quote sits on a job, and when it's accepted the dispatches and materials are listed on that job."
      actions={
        <Button onClick={() => setModal(true)}>
          <Plus className="size-4" />
          New quote
        </Button>
      }
    >
      <div className={isPhoneApp ? "mb-4 grid grid-cols-2 gap-3" : "mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"}>
        <Stat label="Out with customers" value={money(stats.data?.outstandingValue ?? 0)} tone="warning" hint={`${stats.data?.sentCount ?? 0} sent, waiting`} />
        <Stat label="Accepted value" value={money(stats.data?.acceptedValue ?? 0)} tone="success" />
        <Stat label="Still drafts" value={stats.data?.draftCount ?? 0} hint="Not sent to anyone yet" />
        <Stat
          label="Declined"
          value={stats.data?.byStatus?.declined?.count ?? 0}
          tone="danger"
          hint="Reasons are on each quote"
        />
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <div className={isPhoneApp ? "relative w-full" : "relative max-w-md flex-1"}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Quote number, customer, address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select className={isPhoneApp ? "w-full" : "w-[170px]"} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {quotes.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>No quotes match that.</Empty>
        ) : isPhoneApp ? (
          <PhoneCardList
            items={rows.map((q) => ({
              key: q.id,
              href: `/quotes/${q.id}`,
              title: q.job ? `${q.ref} · job #${q.job.number}` : q.ref,
              badges: <Badge colour={QUOTE_STATUS_COLOUR[q.status]}>{q.status}</Badge>,
              line1: q.contact
                ? `${q.contact.firstName} ${q.contact.lastName}${q.company ? `, ${q.company.name}` : ""}`
                : (q.company?.name ?? "No customer"),
              line2: q.site?.address ?? "No site",
              meta: (
                <span className="tabular">
                  {money(q.total)} · valid to {fmtDate(q.validUntil)}
                </span>
              ),
            }))}
          />
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Quote</th>
                  <th className="th px-4">Customer</th>
                  <th className="th px-4">Site</th>
                  <th className="th px-4">Status</th>
                  <th className="th px-4">Job</th>
                  <th className="th px-4 text-right">Lines</th>
                  <th className="th px-4 text-right">Valid to</th>
                  <th className="th px-4 text-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <Link to={`/quotes/${q.id}`} className="font-medium text-primary hover:underline">
                        {q.ref}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      {q.contact ? `${q.contact.firstName} ${q.contact.lastName}` : "-"}
                      {q.company ? <p className="text-xs text-muted-foreground">{q.company.name}</p> : null}
                    </td>
                    <td className="px-4 py-2.5">{q.site?.address ?? "-"}</td>
                    <td className="px-4 py-2.5">
                      <Badge colour={QUOTE_STATUS_COLOUR[q.status]}>{q.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {q.job ? (
                        <Link to={`/jobs/${q.job.id}`} className="text-primary hover:underline">
                          #{q.job.number}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">{q.itemCount}</td>
                    <td className="tabular px-4 py-2.5 text-right text-muted-foreground">{fmtDate(q.validUntil)}</td>
                    <td className="tabular px-4 py-2.5 text-right font-medium">{money(q.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewQuoteModal open={modal} onClose={() => setModal(false)} />
    </Page>
  );
}
