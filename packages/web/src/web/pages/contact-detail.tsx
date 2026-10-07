import * as React from "react";
import { Link, useParams } from "wouter";
import { ArrowLeft, Building2, Mail, MapPin, Phone, Trash2 } from "lucide-react";
import { Page } from "../components/layout";
import { SwmsToggle } from "../components/swms";
import { DepositDefault } from "../components/deposit-default";
import { MemoButton } from "../components/voice-memo";
import { Card, CardHeader, Empty, Loading, Stat } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { Combobox } from "../components/ui/combobox";
import { useContact, useLinkCompany, useUnlinkCompany, useUpdateContact } from "../queries/contacts";
import { useCompanies } from "../queries/companies";
import { useClient } from "../queries/intel";
import { histDate, money, pct } from "../lib/money";

const COMPANY_ROLES = ["owner", "manager", "supervisor", "accounts", "property_manager", "purchasing", "other"];
const roleLabel = (r: string | null) => (r ?? "").replace(/_/g, " ");

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const contact = useContact(Number.isFinite(id) ? id : null);
  const intel = useClient(Number.isFinite(id) ? id : null);
  const companies = useCompanies();
  const update = useUpdateContact();
  const link = useLinkCompany();
  const unlink = useUnlinkCompany();

  const [edit, setEdit] = React.useState(false);
  const [linkModal, setLinkModal] = React.useState(false);
  const [linkForm, setLinkForm] = React.useState({ companyId: "", role: "other", jobTitle: "" });

  if (contact.isLoading) return <Loading label="Loading contact…" />;
  if (contact.error || !contact.data) {
    return (
      <Page title="Contact not found">
        <Card>
          <Empty>
            <Link to="/clients" className="text-primary hover:underline">
              Back to clients
            </Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const c = contact.data.contact;
  const lt = intel.data?.lifetime;
  const quotes = intel.data?.quotes;

  return (
    <Page
      title={`${c.firstName} ${c.lastName}`.trim()}
      subtitle={
        <Link to="/clients" className="inline-flex items-center gap-1 text-primary hover:underline">
          <ArrowLeft className="size-3.5" /> All clients
        </Link>
      }
      actions={
        <>
          <MemoButton contactId={c.id} />
          <Button variant="secondary" onClick={() => setLinkModal(true)}>
            <Building2 className="size-4" />
            Link a company
          </Button>
          <Button onClick={() => setEdit(true)}>Edit details</Button>
        </>
      }
    >
      {/* --------------------- what this client is worth -------------------- */}
      {lt && intel.data ? (
        <div className="mb-4 space-y-3">
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
              value={intel.data.outstanding > 0 ? money(intel.data.outstanding) : "Nothing"}
              tone={intel.data.outstanding > 0 ? "warning" : "default"}
              hint={
                intel.data.avgDaysToPay === null
                  ? "No paid invoices to average yet"
                  : `Pays in ${intel.data.avgDaysToPay} days on average`
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
              <p className="label-xs">Quotes won and lost</p>
              <p className="tabular mt-1 text-sm font-medium">
                {quotes && quotes.won + quotes.lost + quotes.open > 0
                  ? `${quotes.won} won, ${quotes.lost} lost`
                  : "None quoted"}
              </p>
              {quotes && quotes.won > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {money(quotes.wonValue)} accepted
                  {quotes.open > 0 ? `, ${quotes.open} still out` : ""}
                </p>
              ) : quotes && quotes.open > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{quotes.open} still out</p>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="grid gap-4">
          <Card className="px-4 py-4">
            <div className="grid gap-2 text-sm">
              {c.mobile ? (
                <p className="flex items-center gap-2">
                  <Phone className="size-3.5 text-muted-foreground" />
                  <a href={`tel:${c.mobile}`} className="tabular hover:underline">
                    {c.mobile}
                  </a>
                </p>
              ) : null}
              {c.phone ? (
                <p className="flex items-center gap-2">
                  <Phone className="size-3.5 text-muted-foreground" />
                  <span className="tabular">{c.phone}</span>
                </p>
              ) : null}
              {c.email ? (
                <p className="flex items-center gap-2">
                  <Mail className="size-3.5 text-muted-foreground" />
                  <a href={`mailto:${c.email}`} className="truncate hover:underline">
                    {c.email}
                  </a>
                </p>
              ) : null}
              {c.address || c.suburb ? (
                <p className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    {c.address}
                    {c.suburb ? `, ${c.suburb}` : ""} {c.postcode ?? ""}
                  </span>
                </p>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-1 border-t border-border pt-3">
              <Badge>{roleLabel(c.source) || "other"}</Badge>
              {c.marketingOptIn ? <Badge colour="#3F7D3A">Marketing OK</Badge> : <Badge>No marketing</Badge>}
              {!c.active ? <Badge colour="#C0603F">Archived</Badge> : null}
            </div>
            {c.notes ? <p className="mt-3 text-xs text-muted-foreground">{c.notes}</p> : null}
            <div className="mt-3 border-t border-border pt-3">
              <SwmsToggle kind="contact" id={c.id} value={Boolean(c.requiresSwms)} />
              <div className="mt-3 border-t border-border pt-3">
                <DepositDefault kind="contact" id={c.id} value={c.depositPercent ?? null} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Companies" subtitle="Optional wrapper — the person stays one record." />
            {contact.data.companies.length === 0 ? (
              <Empty>Private customer.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {contact.data.companies.map(({ link: l, company }) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 px-4 py-2.5">
                    <div className="min-w-0">
                      <Link to={`/companies/${company.id}`} className="text-sm font-medium text-primary hover:underline">
                        {company.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {roleLabel(l.role)}
                        {l.jobTitle ? ` · ${l.jobTitle}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => unlink.mutate({ linkId: l.id })}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="Sites" />
            {contact.data.sites.length === 0 ? (
              <Empty>No addresses on file.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {contact.data.sites.map((s) => (
                  <li key={s.id} className="px-4 py-2.5">
                    <p className="text-sm">{s.address}</p>
                    <p className="text-xs text-muted-foreground">
                      {s.suburb} {s.postcode ?? ""} · {roleLabel(s.propertyType)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="grid gap-4">
          <Card>
            <CardHeader title="Jobs" subtitle="Everything this person has ever been part of." />
            {contact.data.jobs.length === 0 ? (
              <Empty>No jobs yet.</Empty>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {contact.data.jobs.map(({ job, status, site, role }) => (
                    <tr key={job.id} className="border-b border-border last:border-0 hover:bg-secondary/50">
                      <td className="px-4 py-2.5">
                        <Link to={`/jobs/${job.id}`} className="font-medium text-primary hover:underline">
                          #{job.number}
                        </Link>
                        <p className="text-xs text-muted-foreground">{job.title || "Untitled"}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <p className="max-w-[200px] truncate">{site?.address ?? "—"}</p>
                        <p className="text-xs text-muted-foreground">{roleLabel(role) || "job contact"}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge colour={status?.colour}>{status?.name ?? "No status"}</Badge>
                      </td>
                      <td className="tabular px-4 py-2.5 text-right">{money(job.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card>
            <CardHeader title="Quotes" />
            {contact.data.quotes.length === 0 ? (
              <Empty>No quotes yet.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {contact.data.quotes.map((q) => (
                  <li key={q.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <Link to={`/quotes/${q.id}`} className="font-medium text-primary hover:underline">
                      #{q.number}
                      {q.version > 1 ? `v${q.version}` : ""}
                    </Link>
                    <span className="flex items-center gap-2">
                      <Badge>{q.status}</Badge>
                      <span className="tabular">{money(q.total)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="History" />
            {contact.data.activity.length === 0 ? (
              <Empty>Nothing logged.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {contact.data.activity.map((a) => (
                  <li key={a.id} className="px-4 py-2.5">
                    <p className="text-sm">{a.detail}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {a.actorName || "System"} ·{" "}
                      {new Date(a.createdAt).toLocaleString("en-AU", {
                        day: "numeric",
                        month: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <EditContactModal open={edit} onClose={() => setEdit(false)} contact={c} onSave={(input) => update.mutateAsync(input as Parameters<typeof update.mutateAsync>[0])} />

      <Modal
        open={linkModal}
        onClose={() => setLinkModal(false)}
        title="Link to a company"
        subtitle="Same person, extra hat. Billing is still decided per job."
        footer={
          <>
            <Button variant="ghost" onClick={() => setLinkModal(false)}>
              Cancel
            </Button>
            <Button
              disabled={!linkForm.companyId || link.isPending}
              onClick={async () => {
                await link.mutateAsync({
                  contactId: c.id,
                  companyId: Number(linkForm.companyId),
                  role: linkForm.role,
                  jobTitle: linkForm.jobTitle || null,
                });
                setLinkModal(false);
              }}
            >
              Link
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <Field label="Company">
            <Combobox
              value={linkForm.companyId}
              onChange={(v) => setLinkForm((f) => ({ ...f, companyId: v }))}
              placeholder="Search companies…"
              emptyLabel="Pick a company"
              options={(companies.data ?? []).map((co) => ({
                value: String(co.id),
                label: co.name,
              }))}
            />
          </Field>
          <Field label="Role there">
            <Select value={linkForm.role} onChange={(e) => setLinkForm((f) => ({ ...f, role: e.target.value }))}>
              {COMPANY_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Job title (optional)">
            <Input
              value={linkForm.jobTitle}
              onChange={(e) => setLinkForm((f) => ({ ...f, jobTitle: e.target.value }))}
              placeholder="Site manager"
            />
          </Field>
        </div>
      </Modal>
    </Page>
  );
}

function EditContactModal({
  open,
  onClose,
  contact,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  contact: {
    id: number;
    firstName: string;
    lastName: string;
    mobile: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    suburb: string | null;
    postcode: string | null;
    notes: string | null;
    marketingOptIn: boolean;
    active: boolean;
  };
  onSave: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  const [form, setForm] = React.useState({
    firstName: contact.firstName,
    lastName: contact.lastName,
    mobile: contact.mobile ?? "",
    phone: contact.phone ?? "",
    email: contact.email ?? "",
    address: contact.address ?? "",
    suburb: contact.suburb ?? "",
    postcode: contact.postcode ?? "",
    notes: contact.notes ?? "",
    marketingOptIn: contact.marketingOptIn,
    active: contact.active,
  });
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setForm({
        firstName: contact.firstName,
        lastName: contact.lastName,
        mobile: contact.mobile ?? "",
        phone: contact.phone ?? "",
        email: contact.email ?? "",
        address: contact.address ?? "",
        suburb: contact.suburb ?? "",
        postcode: contact.postcode ?? "",
        notes: contact.notes ?? "",
        marketingOptIn: contact.marketingOptIn,
        active: contact.active,
      });
    }
  }, [open, contact]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit contact"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              setError(null);
              try {
                await onSave({
                  id: contact.id,
                  firstName: form.firstName,
                  lastName: form.lastName,
                  mobile: form.mobile || null,
                  phone: form.phone || null,
                  email: form.email || null,
                  address: form.address || null,
                  suburb: form.suburb || null,
                  postcode: form.postcode || null,
                  notes: form.notes || null,
                  marketingOptIn: form.marketingOptIn,
                  active: form.active,
                });
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name">
          <Input value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
        </Field>
        <Field label="Last name">
          <Input value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
        </Field>
        <Field label="Mobile">
          <Input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} />
        </Field>
        <Field label="Other phone">
          <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Email" className="sm:col-span-2">
          <Input value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={form.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <Field label="Suburb">
          <Input value={form.suburb} onChange={(e) => set("suburb", e.target.value)} />
        </Field>
        <Field label="Postcode">
          <Input value={form.postcode} onChange={(e) => set("postcode", e.target.value)} />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={3} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <label htmlFor={`contact_detail_cb1`} className="flex items-center gap-2 text-sm">
          <Checkbox id={`contact_detail_cb1`} checked={form.marketingOptIn} onChange={(e) => set("marketingOptIn", e.target.checked)} />
          Happy to get marketing
        </label>
        <label htmlFor={`contact_detail_cb2`} className="flex items-center gap-2 text-sm">
          <Checkbox id={`contact_detail_cb2`} checked={form.active} onChange={(e) => set("active", e.target.checked)} />
          Active
        </label>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}
