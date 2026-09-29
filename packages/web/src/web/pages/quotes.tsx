import * as React from "react";
import { Link, useLocation } from "wouter";
import { Plus, Search } from "lucide-react";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { Combobox } from "../components/ui/combobox";
import { useCreateQuote, useQuoteStats, useQuotes } from "../queries/quotes";
import { useContacts } from "../queries/contacts";
import { useCompanies, useSites } from "../queries/companies";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export const QUOTE_STATUS_COLOUR: Record<string, string> = {
  draft: "#7A736D",
  sent: "#D08A1E",
  accepted: "#3F7D3A",
  declined: "#B4342A",
  expired: "#7A736D",
};

const STATUSES = ["draft", "sent", "accepted", "declined", "expired"];

function fmtDate(value: Date | string | null) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "2-digit" });
}

export function NewQuoteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [, navigate] = useLocation();
  const contacts = useContacts();
  const companies = useCompanies();
  const create = useCreateQuote();
  const [form, setForm] = React.useState({
    contactId: "",
    companyId: "",
    siteId: "",
    depositPercent: "0",
    validDays: "30",
    notes: "",
  });
  const [error, setError] = React.useState<string | null>(null);
  const sites = useSites(form.contactId ? { contactId: Number(form.contactId) } : {});

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    try {
      const quote = await create.mutateAsync({
        contactId: form.contactId ? Number(form.contactId) : null,
        companyId: form.companyId ? Number(form.companyId) : null,
        siteId: form.siteId ? Number(form.siteId) : null,
        depositPercent: Number(form.depositPercent) || 0,
        validDays: Number(form.validDays) || 30,
        notes: form.notes || null,
        items: [],
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
      subtitle="Pick who it's for, then build the lines. A company on the quote means the company gets billed."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Start quote
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Customer" className="sm:col-span-2">
          <Combobox
            value={form.contactId}
            onChange={(v) => set("contactId", v)}
            placeholder="Search people…"
            emptyLabel="Select a person…"
            options={(contacts.data ?? []).map((c) => ({
              value: String(c.id),
              label: `${c.firstName} ${c.lastName}`,
              sublabel: c.suburb ?? undefined,
            }))}
          />
        </Field>
        <Field label="Bill the company?" hint="Leave as none for a private customer">
          <Combobox
            value={form.companyId}
            onChange={(v) => set("companyId", v)}
            placeholder="Search companies…"
            emptyLabel="None — bills the person"
            options={(companies.data ?? []).map((c) => ({
              value: String(c.id),
              label: c.name,
            }))}
          />
        </Field>
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
        <Field label="Deposit %">
          <Input
            type="number"
            value={form.depositPercent}
            onChange={(e) => set("depositPercent", e.target.value)}
          />
        </Field>
        <Field label="Valid for (days)">
          <Input type="number" value={form.validDays} onChange={(e) => set("validDays", e.target.value)} />
        </Field>
        <Field label="Notes for the customer" className="sm:col-span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
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
      subtitle="Price it, send it, and when it's accepted it turns into a job with the dispatches already listed."
      actions={
        <Button onClick={() => setModal(true)}>
          <Plus className="size-4" />
          New quote
        </Button>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
        <div className="relative max-w-md flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Quote number, customer, address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select className="w-[170px]" value={status} onChange={(e) => setStatus(e.target.value)}>
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
                        #{q.number}
                      </Link>
                      {q.version > 1 ? <span className="ml-1 text-xs text-muted-foreground">v{q.version}</span> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      {q.contact ? `${q.contact.firstName} ${q.contact.lastName}` : "—"}
                      {q.company ? <p className="text-xs text-muted-foreground">{q.company.name}</p> : null}
                    </td>
                    <td className="px-4 py-2.5">{q.site?.address ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <Badge colour={QUOTE_STATUS_COLOUR[q.status]}>{q.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {q.job ? (
                        <Link to={`/jobs/${q.job.id}`} className="text-primary hover:underline">
                          #{q.job.number}
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
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
