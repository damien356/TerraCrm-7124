import * as React from "react";
import { Link } from "wouter";
import { Plus, Search, Sofa } from "lucide-react";
import { Page } from "../components/layout";
import { MemoButton } from "../components/voice-memo";
import { Card, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { Combobox } from "../components/ui/combobox";
import { SupervisorPicker } from "../components/supervisor-picker";
import { useCreateJob, useJobs } from "../queries/jobs";
import { useBootstrap } from "../queries/settings";
import { ContactPicker } from "../components/contact-picker";
import { useCompanies, useSites } from "../queries/companies";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

export function NewJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bootstrap = useBootstrap();
  const companies = useCompanies();
  const sites = useSites();
  const create = useCreateJob();

  const [form, setForm] = React.useState({
    title: "",
    contactId: "",
    companyId: "",
    supervisorContactId: "",
    siteId: "",
    statusId: "",
    billToType: "contact" as "contact" | "company",
    furnitureOnSite: false,
    value: "",
    description: "",
    accessNotes: "",
    source: "phone",
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    if (form.companyId && !form.supervisorContactId) {
      setError("Pick the supervisor who sent this job, or add them, before saving.");
      return;
    }
    try {
      await create.mutateAsync({
        title: form.title,
        contactId: form.contactId ? Number(form.contactId) : null,
        companyId: form.companyId ? Number(form.companyId) : null,
        siteId: form.siteId ? Number(form.siteId) : null,
        statusId: form.statusId ? Number(form.statusId) : null,
        billToType: form.companyId ? form.billToType : "contact",
        billToContactId: form.contactId ? Number(form.contactId) : null,
        billToCompanyId: form.companyId ? Number(form.companyId) : null,
        furnitureOnSite: form.furnitureOnSite,
        value: form.value ? Number(form.value) : 0,
        description: form.description || null,
        accessNotes: form.accessNotes || null,
        source: form.source,
        supervisorContactId:
          form.companyId && form.supervisorContactId ? Number(form.supervisorContactId) : null,
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
      title="New job"
      subtitle="Billing is decided here, per job — not on the person."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Create job
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Job title" className="sm:col-span-2">
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Carpet through 3 bed + hall"
          />
        </Field>
        <Field label="Contact (the person)">
          <ContactPicker value={form.contactId} onChange={(v) => set("contactId", v)} emptyLabel="None" />
        </Field>
        <Field label="Company (optional)">
          <Combobox
            value={form.companyId}
            onChange={(v) => {
              // A different builder means a different set of supervisors.
              setForm((f) => ({ ...f, companyId: v, supervisorContactId: "" }));
            }}
            placeholder="Search companies…"
            emptyLabel="None, private customer"
            options={(companies.data ?? []).map((c) => ({
              value: String(c.id),
              label: c.name,
            }))}
          />
        </Field>
        <SupervisorPicker
          companyId={form.companyId ? Number(form.companyId) : null}
          value={form.supervisorContactId}
          onChange={(v) => set("supervisorContactId", v)}
          required
        />
        <Field label="Site">
          <Select value={form.siteId} onChange={(e) => set("siteId", e.target.value)}>
            <option value="">None</option>
            {(sites.data ?? []).map((s) => (
              <option key={s.site.id} value={s.site.id}>
                {s.site.address}, {s.site.suburb}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status">
          <Select value={form.statusId} onChange={(e) => set("statusId", e.target.value)}>
            <option value="">First status</option>
            {(bootstrap.data?.statuses ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who gets the invoice" hint="Carol's own house bills Carol. Her builder job bills the company.">
          <Select
            value={form.billToType}
            onChange={(e) => set("billToType", e.target.value as "contact" | "company")}
            disabled={!form.companyId}
          >
            <option value="contact">The contact</option>
            <option value="company">The company</option>
          </Select>
        </Field>
        <Field label="Job value (ex GST)">
          <Input
            type="number"
            inputMode="decimal"
            value={form.value}
            onChange={(e) => set("value", e.target.value)}
            placeholder="0"
          />
        </Field>
        <Field label="Where it came from">
          <Select value={form.source} onChange={(e) => set("source", e.target.value)}>
            <option value="phone">Phone</option>
            <option value="website">Website</option>
            <option value="repeat">Repeat customer</option>
            <option value="referral">Referral</option>
            <option value="builder">Builder</option>
            <option value="walk_in">Walk in</option>
            <option value="other">Other</option>
          </Select>
        </Field>
        <label htmlFor={`jobs_cb1`} className="flex items-center gap-2 self-end pb-2 text-sm">
          <Checkbox id={`jobs_cb1`} checked={form.furnitureOnSite} onChange={(e) => set("furnitureOnSite", e.target.checked)} />
          Furniture on site (forces a 2-man crew)
        </label>
        <Field label="Job notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="What's happening on this job"
          />
        </Field>
        <Field label="Access notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.accessNotes}
            onChange={(e) => set("accessNotes", e.target.value)}
            placeholder="Gate code, parking, dog on site, lift booking…"
          />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

export default function JobsPage() {
  const [search, setSearch] = React.useState("");
  const [statusId, setStatusId] = React.useState("");
  const [modal, setModal] = React.useState(false);
  const bootstrap = useBootstrap();
  const jobs = useJobs({
    search: search || undefined,
    statusId: statusId ? Number(statusId) : undefined,
  });

  return (
    <Page
      title="Jobs"
      subtitle="Every job is a set of dispatches — tile removal, prep, lay, skirting, silicone."
      actions={
        <Button onClick={() => setModal(true)}>
          <Plus className="size-4" />
          New job
        </Button>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Job number, address, customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select className="w-auto min-w-[160px]" value={statusId} onChange={(e) => setStatusId(e.target.value)}>
          <option value="">All statuses</option>
          {(bootstrap.data?.statuses ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>

      <Card>
        {jobs.isLoading ? (
          <Loading />
        ) : (jobs.data ?? []).length === 0 ? (
          <Empty>No jobs match that.</Empty>
        ) : (
          <div className="board-scroll overflow-x-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Job</th>
                  <th className="th px-4">Customer</th>
                  <th className="th px-4">Site</th>
                  <th className="th px-4">Status</th>
                  <th className="th px-4 text-right">Dispatches</th>
                  <th className="th px-4 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {(jobs.data ?? []).map((j) => (
                  <tr key={j.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1">
                        <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                          #{j.number}
                        </Link>
                        <MemoButton jobId={j.id} compact />
                      </span>
                      <p className="max-w-[240px] truncate text-xs text-muted-foreground">{j.title || "Untitled"}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="truncate">
                        {j.company?.name ??
                          [j.contact?.firstName, j.contact?.lastName].filter(Boolean).join(" ") ??
                          "—"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        bills {j.billToType === "company" ? "the company" : "the contact"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="max-w-[220px] truncate">{j.site?.address ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{j.site?.suburb ?? ""}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge colour={j.status?.colour}>{j.status?.name ?? "No status"}</Badge>
                        {j.furnitureOnSite ? (
                          <Badge colour="#C0603F">
                            <Sofa className="size-3" />
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="tabular px-4 py-2.5 text-right">
                      {j.doneCount}/{j.taskCount}
                      {j.unassignedCount > 0 ? (
                        <span className="ml-1 text-xs text-[var(--warning)]">{j.unassignedCount} open</span>
                      ) : null}
                    </td>
                    <td className="tabular px-4 py-2.5 text-right font-medium">{money(j.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <NewJobModal open={modal} onClose={() => setModal(false)} />
    </Page>
  );
}
