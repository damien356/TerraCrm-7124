import * as React from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { Page } from "../components/layout";
import { MemoButton } from "../components/voice-memo";
import { Card, Empty, Loading, Spinner } from "../components/ui/card";
import { Button } from "../components/ui/button";
import {
  Checkbox,
  Field,
  Input,
  Select,
  Textarea,
} from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { Combobox } from "../components/ui/combobox";
import { useCreateContact } from "../queries/contacts";
import { ContactMatches, type ContactMatch } from "../components/contact-matches";
import { orpc } from "../lib/api";
import { useCompanies } from "../queries/companies";
import { useClientIntel, type ListSort } from "../queries/intel";
import { histDate, money, pct } from "../lib/money";

const COMPANY_ROLES = [
  "owner",
  "manager",
  "supervisor",
  "accounts",
  "property_manager",
  "purchasing",
  "other",
];
const roleLabel = (r: string) => r.replace(/_/g, " ");

export function NewContactModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const companies = useCompanies();
  const create = useCreateContact();
  const [form, setForm] = React.useState({
    firstName: "",
    lastName: "",
    mobile: "",
    email: "",
    address: "",
    suburb: "",
    postcode: "",
    source: "phone",
    companyId: "",
    companyRole: "other",
    marketingOptIn: false,
    notes: "",
  });
  const [error, setError] = React.useState<string | null>(null);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const link = useMutation(orpc.contacts.linkCompany.mutationOptions());

  /** Use the card that is already there, filed under the company if one was picked. */
  async function pickExisting(m: ContactMatch) {
    setError(null);
    try {
      if (form.companyId) {
        await link.mutateAsync({ contactId: m.id, companyId: Number(form.companyId), role: form.companyRole });
        qc.invalidateQueries({ queryKey: orpc.contacts.key() });
        qc.invalidateQueries({ queryKey: orpc.companies.key() });
      }
      onClose();
      navigate(`/clients/${m.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        firstName: form.firstName,
        lastName: form.lastName,
        mobile: form.mobile || null,
        email: form.email || null,
        address: form.address || null,
        suburb: form.suburb || null,
        postcode: form.postcode || null,
        source: form.source,
        notes: form.notes || null,
        marketingOptIn: form.marketingOptIn,
        companyId: form.companyId ? Number(form.companyId) : null,
        companyRole: form.companyRole,
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
      title="New contact"
      subtitle="A person exists once, forever. Whether a job bills them or their company is decided on the job."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!form.firstName || create.isPending}
          >
            {create.isPending ? (
              <Spinner className="border-white/40 border-t-white" />
            ) : null}
            Save contact
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input
            value={form.firstName}
            onChange={(e) => set("firstName", e.target.value)}
          />
        </Field>
        <Field label="Last name">
          <Input
            value={form.lastName}
            onChange={(e) => set("lastName", e.target.value)}
          />
        </Field>
        <Field label="Mobile">
          <Input
            value={form.mobile}
            onChange={(e) => set("mobile", e.target.value)}
            placeholder="0412 345 678"
          />
        </Field>
        <Field label="Email">
          <Input
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>
        <div className="sm:col-span-2 empty:hidden">
          <ContactMatches
            input={{ firstName: form.firstName, lastName: form.lastName, mobile: form.mobile, email: form.email }}
            onUse={pickExisting}
            busyId={link.isPending ? (link.variables?.contactId ?? null) : null}
            useLabel={form.companyId ? "Use that card, file under company" : "Open that card"}
          />
        </div>
        <Field label="Address" className="sm:col-span-2">
          <Input
            value={form.address}
            onChange={(e) => set("address", e.target.value)}
          />
        </Field>
        <Field label="Suburb">
          <Input
            value={form.suburb}
            onChange={(e) => set("suburb", e.target.value)}
          />
        </Field>
        <Field label="Postcode">
          <Input
            value={form.postcode}
            onChange={(e) => set("postcode", e.target.value)}
          />
        </Field>
        <Field label="Company (optional)">
          <Combobox
            value={form.companyId}
            onChange={(v) => set("companyId", v)}
            placeholder="Search companies…"
            emptyLabel="None — private customer"
            options={(companies.data ?? []).map((c) => ({
              value: String(c.id),
              label: c.name,
            }))}
          />
        </Field>
        <Field label="Their role there">
          <Select
            value={form.companyRole}
            onChange={(e) => set("companyRole", e.target.value)}
            disabled={!form.companyId}
          >
            {COMPANY_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Where they came from">
          <Select
            value={form.source}
            onChange={(e) => set("source", e.target.value)}
          >
            <option value="phone">Phone</option>
            <option value="website">Website</option>
            <option value="referral">Referral</option>
            <option value="repeat">Repeat customer</option>
            <option value="walk_in">Walk in</option>
            <option value="builder">Builder</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <label
          htmlFor={`clients_cb1`}
          className="flex items-center gap-2 self-end pb-2 text-sm"
        >
          <Checkbox
            id={`clients_cb1`}
            checked={form.marketingOptIn}
            onChange={(e) => set("marketingOptIn", e.target.checked)}
          />
          Happy to get marketing
        </label>
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
 * CLIENTS.
 *
 * Individual customers, ranked by what they are actually worth to Terra, not
 * alphabetically. Revenue and gross profit sit side by side because revenue on
 * its own hides a job that was busy and unprofitable. There is deliberately no
 * single client score: the numbers are all here, the judgement stays Damien's.
 */

const SORTS: { key: ListSort; label: string }[] = [
  { key: "revenue", label: "Lifetime revenue" },
  { key: "gp", label: "Gross profit" },
  { key: "jobs", label: "Jobs" },
  { key: "recent", label: "Most recent" },
  { key: "name", label: "Name" },
];

export default function ClientsPage() {
  const [search, setSearch] = React.useState("");
  const [sort, setSort] = React.useState<ListSort>("revenue");
  const [modal, setModal] = React.useState(false);
  const q = useClientIntel({ search: search || undefined, sort, limit: 200 });
  const rows = q.data?.rows ?? [];
  const total = q.data?.total ?? 0;

  return (
    <Page
      title="Clients"
      subtitle="People, not accounts. One record each, for life, with what they have put through Terra."
      actions={
        <Button onClick={() => setModal(true)}>
          <Plus className="size-4" />
          New contact
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Name, mobile, email, suburb…"
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
          <Empty>No contacts match that.</Empty>
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-3">Name</th>
                  <th className="th whitespace-nowrap px-3 text-right">
                    Lifetime revenue
                  </th>
                  <th className="th px-3 text-right">Gross profit</th>
                  <th className="th px-3 text-right">Jobs</th>
                  <th className="th px-3 text-right">Avg job</th>
                  <th className="th px-3 text-right">Owing</th>
                  <th className="th px-3 text-right">Last job</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-border last:border-0 hover:bg-secondary/50"
                  >
                    <td className="px-3 py-2.5">
                      <span className="flex items-center gap-1">
                        <Link
                          to={`/clients/${c.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {c.name}
                        </Link>
                        <MemoButton contactId={c.id} compact />
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {c.mobile ?? c.email ?? "No contact details"}
                        {c.suburb ? ` · ${c.suburb}` : ""}
                      </p>
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right font-semibold">
                      {c.revenue > 0 ? money(c.revenue) : "—"}
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
                      {c.avgJobValue > 0 ? money(c.avgJobValue) : "—"}
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">
                      {c.outstanding > 0 ? (
                        <span className="font-medium text-[#C05A2B]">
                          {money(c.outstanding)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
            Showing {rows.length} of {total} {total === 1 ? "person" : "people"}
            {search ? " that match" : ", ranked by the sort above"}. Search to
            reach anyone not listed.
          </p>
        ) : null}
      </Card>

      <NewContactModal open={modal} onClose={() => setModal(false)} />
    </Page>
  );
}
