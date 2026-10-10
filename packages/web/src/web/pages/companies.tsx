import * as React from "react";
import { Link } from "wouter";
import { Plus, Search } from "lucide-react";
import { Page } from "../components/layout";
import { Card, Empty, Loading, Spinner } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { useCreateCompany } from "../queries/companies";
import { useCompanyIntel, type ListSort } from "../queries/intel";
import { histDate, money, pct } from "../lib/money";
import { COMPANY_TYPES, COMPANY_TYPE_LABELS } from "../../api/lib/person-tags";

export const typeLabel = (t: string) => COMPANY_TYPE_LABELS[t] ?? t.replace(/_/g, " ");

export function NewCompanyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateCompany();
  const [form, setForm] = React.useState({
    name: "",
    abn: "",
    type: "builder",
    phone: "",
    email: "",
    website: "",
    billingAddress: "",
    paymentTerms: "14",
    creditLimit: "",
    notes: "",
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        name: form.name,
        abn: form.abn || null,
        type: form.type,
        phone: form.phone || null,
        email: form.email || null,
        website: form.website || null,
        billingAddress: form.billingAddress || null,
        paymentTerms: Number(form.paymentTerms) || 0,
        creditLimit: form.creditLimit ? Number(form.creditLimit) : null,
        notes: form.notes || null,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New company"
      subtitle="A company is a billing wrapper around people. The people stay their own records."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.name || create.isPending}>
            {create.isPending ? (
              <Spinner className="border-white/40 border-t-white" />
            ) : null}
            Save company
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name" className="sm:col-span-2">
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="ABC Builders Pty Ltd"
          />
        </Field>
        <Field label="Type">
          <Select
            value={form.type}
            onChange={(e) => set("type", e.target.value)}
          >
            {COMPANY_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ABN">
          <Input
            value={form.abn}
            onChange={(e) => set("abn", e.target.value)}
          />
        </Field>
        <Field label="Phone">
          <Input
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
          />
        </Field>
        <Field label="Accounts email">
          <Input
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>
        <Field label="Website">
          <Input
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
          />
        </Field>
        <Field label="Payment terms (days)">
          <Input
            type="number"
            value={form.paymentTerms}
            onChange={(e) => set("paymentTerms", e.target.value)}
          />
        </Field>
        <Field label="Billing address" className="sm:col-span-2">
          <Input
            value={form.billingAddress}
            onChange={(e) => set("billingAddress", e.target.value)}
          />
        </Field>
        <Field label="Credit limit" hint="Leave blank for none">
          <Input
            type="number"
            value={form.creditLimit}
            onChange={(e) => set("creditLimit", e.target.value)}
          />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/**
 * COMPANIES.
 *
 * Builders and commercial accounts, ranked by what they are worth. Lifetime
 * revenue and lifetime gross profit both show, since a builder can be the
 * biggest name on the list and still be the worst payer, which is what the
 * owing and days-to-pay columns are for.
 */

const SORTS: { key: CompanySort; label: string }[] = [
  { key: "revenue", label: "Lifetime revenue" },
  { key: "gp", label: "Gross profit" },
  { key: "outstanding", label: "Owing" },
  { key: "jobs", label: "Jobs" },
  { key: "recent", label: "Most recent" },
  { key: "name", label: "Name" },
];

type CompanySort = ListSort | "outstanding";

export default function CompaniesPage() {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<CompanySort>("revenue");
  const [modal, setModal] = React.useState(false);
  const q = useCompanyIntel({ search: search || undefined, sort, limit: 300 });
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;

  return (
    <Page
      title="Companies"
      subtitle="Builders, agencies and commercial accounts, ranked by what they have put through Terra."
      actions={
        <>
          <Link to="/companies/types" className="text-[13px] font-medium text-primary hover:underline">
            Check company types
          </Link>
          <Button onClick={() => setModal(true)}>
            <Plus className="size-4" />
            New company
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Company name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              className={
                sort === s.key
                  ? "rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground"
                  : "rounded-md border border-border px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        {q.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty>
            No companies yet. Add one when a builder or agency starts sending
            you work.
          </Empty>
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-3">Company</th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Lifetime revenue
                  </th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Gross profit
                  </th>
                  <th className="th whitespace-nowrap px-3 text-right">Jobs</th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Avg job
                  </th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Owing
                  </th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Pays in
                  </th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Last job
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border last:border-0 hover:bg-secondary/50"
                  >
                    <td className="px-3 py-2.5">
                      <Link
                        to={`/companies/${c.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {typeLabel(c.type)}
                        {c.contactCount > 0
                          ? ` · ${c.contactCount} ${c.contactCount === 1 ? "person" : "people"}`
                          : ""}
                      </p>
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right font-semibold">
                      {c.revenue > 0 ? money(c.revenue) : "-"}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {c.grossProfit === null ? (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          no cost data
                        </span>
                      ) : (
                        <>
                          {money(c.grossProfit)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            {pct(c.marginPercent)}
                          </span>
                        </>
                      )}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {c.deliveredJobs}
                      {c.liveJobs > 0 ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          +{c.liveJobs} live
                        </span>
                      ) : null}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {c.avgJobValue > 0 ? money(c.avgJobValue) : "-"}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {c.outstanding > 0 ? (
                        <span className="font-medium text-[#C05A2B]">
                          {money(c.outstanding)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right text-muted-foreground">
                      {c.avgDaysToPay === null
                        ? `${c.termsDays}d terms`
                        : `${c.avgDaysToPay}d actual`}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right text-muted-foreground">
                      {histDate(c.lastJob)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > 0 ? (
          <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
            Showing {rows.length} of {total} companies
            {search ? " that match" : ", ranked by the sort above"}. Pays in
            shows what they actually average once invoices are paid, and their
            agreed terms until then.
          </p>
        ) : null}
      </Card>

      <NewCompanyModal open={modal} onClose={() => setModal(false)} />
    </Page>
  );
}
