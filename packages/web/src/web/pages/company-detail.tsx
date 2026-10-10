import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Pencil } from "lucide-react";
import { Page } from "../components/layout";
import { SwmsToggle } from "../components/swms";
import { DepositDefault } from "../components/deposit-default";
import { Card, CardHeader, Empty, Loading, Spinner, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { PaymentTermsCard } from "../components/payment-terms";
import { useCompany, useUpdateCompany } from "../queries/companies";
import { useCompanyIntelDetail } from "../queries/intel";
import { histDate, money, pct } from "../lib/money";
import { typeLabel } from "./companies";
import { COMPANY_TYPES } from "../../api/lib/person-tags";

const roleLabel = (r: string) => r.replace(/_/g, " ");

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="label-xs">{label}</p>
      <p className="mt-0.5 text-sm">{children}</p>
    </div>
  );
}

export default function CompanyDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const company = useCompany(Number.isFinite(id) ? id : null);
  const intel = useCompanyIntelDetail(Number.isFinite(id) ? id : null);
  const update = useUpdateCompany();
  const [editing, setEditing] = React.useState(false);

  if (company.isLoading) return <Loading label="Opening company…" />;
  if (!company.data) {
    return (
      <Page title="Company not found">
        <Card>
          <Empty>
            That company isn't there.{" "}
            <Link to="/companies" className="text-primary hover:underline">
              Back to companies
            </Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const { company: c, people, sites } = company.data;
  const lt = intel.data?.lifetime;

  return (
    <Page
      title={c.name}
      subtitle={
        <span className="flex items-center gap-2">
          <Link to="/companies" className="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowLeft className="size-3.5" />
            Companies
          </Link>
          <span className="text-muted-foreground">·</span>
          <Badge>{typeLabel(c.type)}</Badge>
          {!c.active ? <Badge colour="#7A736D">Inactive</Badge> : null}
        </span>
      }
      actions={
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Pencil className="size-4" />
          Edit details
        </Button>
      }
    >
      {/* ----------------------- what they are worth ----------------------- */}
      {lt ? (
        <div className="mb-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Lifetime revenue"
              value={money(lt.revenue)}
              hint={`${lt.deliveredJobs} ${lt.deliveredJobs === 1 ? "job" : "jobs"} delivered`}
            />
            <Stat
              label="Lifetime gross profit"
              value={lt.grossProfit === null ? "No cost data" : money(lt.grossProfit)}
              hint={
                lt.grossProfit === null
                  ? "No costs recorded against their jobs"
                  : `${pct(lt.marginPercent)} on ${money(lt.costedRevenue)} costed`
              }
            />
            <Stat label="Average job" value={money(lt.avgJobValue)} hint="Across delivered jobs" />
            <Stat
              label="Owing now"
              value={intel.data!.outstanding > 0 ? money(intel.data!.outstanding) : "Nothing"}
              tone={intel.data!.outstanding > 0 ? "warning" : "default"}
              hint={
                intel.data!.avgDaysToPay === null
                  ? "No paid invoices to average yet"
                  : `Pays in ${intel.data!.avgDaysToPay} days on average`
              }
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="px-4 py-3">
              <p className="label-xs">Live work</p>
              <p className="tabular mt-1 text-sm font-medium">
                {lt.liveJobs === 0
                  ? "Nothing open"
                  : `${money(lt.pipelineValue)} across ${lt.liveJobs} ${lt.liveJobs === 1 ? "job" : "jobs"}`}
              </p>
            </Card>
            <Card className="px-4 py-3">
              <p className="label-xs">First job</p>
              <p className="tabular mt-1 text-sm font-medium">{histDate(lt.firstJob)}</p>
            </Card>
            <Card className="px-4 py-3">
              <p className="label-xs">Last job</p>
              <p className="tabular mt-1 text-sm font-medium">{histDate(lt.lastJob)}</p>
            </Card>
            <Card className="px-4 py-3">
              <p className="label-xs">Cancelled</p>
              <p className="tabular mt-1 text-sm font-medium">
                {lt.cancelledJobs === 0
                  ? "None"
                  : `${lt.cancelledJobs} ${lt.cancelledJobs === 1 ? "job" : "jobs"}`}
              </p>
            </Card>
          </div>

          <PaymentTermsCard companyId={c.id} companyName={c.name} />

          {/* ---------------------- who sends the work ---------------------- */}
          <Card>
            <CardHeader
              title="Who sends the work"
              subtitle="The people inside this company, ranked by what they personally put through."
            />
            {intel.data!.supervisors.length === 0 ? (
              <Empty>
                No job here has a person attached to it, so there is nothing to rank. Set the supervisor on a
                job and this fills in.
              </Empty>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="th px-4">Person</th>
                    <th className="th px-3 text-right">Revenue</th>
                    <th className="th px-3 text-right">Gross profit</th>
                    <th className="th px-3 text-right">Jobs</th>
                    <th className="th px-3 text-right">Avg job</th>
                    <th className="th px-3 text-right">Last job</th>
                  </tr>
                </thead>
                <tbody>
                  {intel.data!.supervisors.map((s) => (
                    <tr key={s.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/supervisors/${s.id}`} className="font-medium text-primary hover:underline">
                          {s.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {s.role ? roleLabel(s.role) : (s.mobile ?? s.email ?? "no contact details")}
                        </p>
                      </td>
                      <td className="tabular px-3 py-2.5 text-right font-medium">{money(s.revenue)}</td>
                      <td className="tabular px-3 py-2.5 text-right">
                        {s.grossProfit === null ? (
                          <span className="text-xs text-muted-foreground">no cost data</span>
                        ) : (
                          money(s.grossProfit)
                        )}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right">{s.deliveredJobs}</td>
                      <td className="tabular px-3 py-2.5 text-right">{money(s.avgJobValue)}</td>
                      <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                        {histDate(s.lastJob)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {intel.data!.attribution.unattributedJobs > 0 ? (
              <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                {intel.data!.attribution.unattributedJobs}{" "}
                {intel.data!.attribution.unattributedJobs === 1 ? "job" : "jobs"} here, worth{" "}
                {money(intel.data!.attribution.unattributedValue)} delivered, came across with the company on
                them and nobody's name. Those are not counted against anyone above.
              </p>
            ) : null}
          </Card>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Account" />
            <div className="grid gap-3 px-4 py-3">
              <Fact label="Phone">{c.phone ?? "-"}</Fact>
              <Fact label="Accounts email">{c.email ?? "-"}</Fact>
              <Fact label="Website">
                {c.website ? (
                  <a href={c.website} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {c.website}
                  </a>
                ) : (
                  "-"
                )}
              </Fact>
              <Fact label="ABN">{c.abn ?? "-"}</Fact>
              <Fact label="Billing address">{c.billingAddress ?? "-"}</Fact>
              <Fact label="Credit limit">{c.creditLimit ? money(c.creditLimit) : "None set"}</Fact>
              {c.notes ? <Fact label="Notes">{c.notes}</Fact> : null}
            </div>
            <div className="border-t border-border px-4 py-3">
              <SwmsToggle kind="company" id={c.id} value={Boolean(c.requiresSwms)} />
              <div className="mt-3 border-t border-border pt-3">
                <DepositDefault kind="company" id={c.id} value={c.depositPercent ?? null} companyType={c.type} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="People here" subtitle="Each person is their own record, linked with a role." />
            {people.length === 0 ? (
              <Empty>Nobody linked yet. Link people from their contact card.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {people.map(({ link, contact }) => (
                  <li key={link.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <Link
                        to={`/clients/${contact.id}`}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {contact.firstName} {contact.lastName}
                      </Link>
                      <p className="tabular text-xs text-muted-foreground">
                        {contact.mobile ?? contact.email ?? "No number on file"}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1">
                      {link.isPrimary ? <Badge colour="#C05A2B">Primary</Badge> : null}
                      <Badge>{roleLabel(link.role)}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Sites" subtitle={`${sites.length} address${sites.length === 1 ? "" : "es"}`} />
            {sites.length === 0 ? (
              <Empty>No sites recorded against this company.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {sites.map((s) => (
                  <li key={s.id} className="px-4 py-2.5">
                    <p className="text-sm">{s.address}</p>
                    <p className="text-xs text-muted-foreground">
                      {[s.suburb, s.state, s.postcode].filter(Boolean).join(" ")}
                      {s.label ? ` · ${s.label}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Jobs"
            subtitle="Everything billed to or booked through this company, newest first."
            action={intel.data ? <Badge>{intel.data.jobs.length}</Badge> : null}
          />
          {!intel.data ? (
            <div className="px-4 py-6">
              <Spinner />
            </div>
          ) : intel.data.jobs.length === 0 ? (
            <Empty>No jobs yet.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="th px-4">Job</th>
                  <th className="th px-2">Sent by</th>
                  <th className="th px-2">Status</th>
                  <th className="th px-2 text-right">Value</th>
                  <th className="th px-2 text-right">Gross profit</th>
                  <th className="th px-2 text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {intel.data.jobs.map((j) => (
                  <tr key={j.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                    <td className="px-4 py-2.5">
                      <Link to={`/jobs/${j.id}`} className="font-medium text-primary hover:underline">
                        #{j.displayNumber ?? j.number}
                      </Link>
                      <p className="max-w-[260px] truncate text-xs text-muted-foreground">{j.title}</p>
                    </td>
                    <td className="px-2 py-2.5 text-xs text-muted-foreground">{j.senderName ?? "-"}</td>
                    <td className="px-2 py-2.5">
                      <Badge>{j.status ?? "-"}</Badge>
                    </td>
                    <td className="tabular px-2 py-2.5 text-right font-medium">{money(j.value)}</td>
                    <td className="tabular px-2 py-2.5 text-right">
                      {j.grossProfit === null ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        money(j.grossProfit)
                      )}
                    </td>
                    <td className="tabular px-2 py-2.5 text-right text-muted-foreground">{histDate(j.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <EditCompanyModal
        key={c.id}
        open={editing}
        onClose={() => setEditing(false)}
        company={c}
        pending={update.isPending}
        onSave={async (input) => {
          await update.mutateAsync({ id: c.id, ...input });
          setEditing(false);
        }}
      />
    </Page>
  );
}

type CompanyRow = { name: string; abn: string | null; type: string; phone: string | null; email: string | null; website: string | null; billingAddress: string | null; paymentTerms: number; creditLimit: number | null; notes: string | null; active: boolean };

function EditCompanyModal({
  open,
  onClose,
  company,
  pending,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  company: CompanyRow;
  pending: boolean;
  onSave: (input: {
    name: string;
    abn: string | null;
    type: string;
    phone: string | null;
    email: string | null;
    website: string | null;
    billingAddress: string | null;
    paymentTerms: number;
    creditLimit: number | null;
    notes: string | null;
    active: boolean;
  }) => Promise<void>;
}) {
  const [form, setForm] = React.useState({
    name: company.name,
    abn: company.abn ?? "",
    type: company.type,
    phone: company.phone ?? "",
    email: company.email ?? "",
    website: company.website ?? "",
    billingAddress: company.billingAddress ?? "",
    paymentTerms: String(company.paymentTerms),
    creditLimit: company.creditLimit == null ? "" : String(company.creditLimit),
    notes: company.notes ?? "",
    active: company.active,
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setError(null);
    try {
      await onSave({
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
        active: form.active,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit company"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.name || pending}>
            {pending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Type">
          <Select value={form.type} onChange={(e) => set("type", e.target.value)}>
            {COMPANY_TYPES.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="ABN">
          <Input value={form.abn} onChange={(e) => set("abn", e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Accounts email">
          <Input value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Website">
          <Input value={form.website} onChange={(e) => set("website", e.target.value)} />
        </Field>
        <Field label="Payment terms (days)">
          <Input type="number" value={form.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} />
        </Field>
        <Field label="Billing address" className="sm:col-span-2">
          <Input value={form.billingAddress} onChange={(e) => set("billingAddress", e.target.value)} />
        </Field>
        <Field label="Credit limit">
          <Input type="number" value={form.creditLimit} onChange={(e) => set("creditLimit", e.target.value)} />
        </Field>
        <Field label="Status">
          <Select
            value={form.active ? "active" : "inactive"}
            onChange={(e) => set("active", e.target.value === "active")}
          >
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}
