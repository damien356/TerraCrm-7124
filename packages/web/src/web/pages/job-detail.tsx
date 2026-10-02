import * as React from "react";
import { Link, useParams, useSearch } from "wouter";
import { ArrowLeft, MessagesSquare, Plus, Sofa, Trash2, Users } from "lucide-react";
import { Page } from "../components/layout";
import { MemoButton } from "../components/voice-memo";
import { JobFile } from "../components/job-file";
import { JobVisits } from "../components/crew-updates";
import { JobForecastCard, MeasureUpModal } from "../components/costing";
import { JobCashCard } from "../components/job-cash";
import { PurchaseOrdersCard } from "../components/purchase-orders";
import { PaymentTermsCard } from "../components/payment-terms";
import { JobConversation } from "../components/conversation";
import { BookInstallerPanel } from "../components/book-installer";
import { Card, CardHeader, Empty, Loading, Spinner } from "../components/ui/card";
import { Badge, TASK_STATUS_COLOUR, TASK_STATUS_LABEL, tintFor } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import {
  useAddJobContact,
  useAddJobNote,
  useAddMaterial,
  useJob,
  useRemoveJobContact,
  useRemoveMaterial,
  useSetJobSupervisor,
  useUpdateJob,
  useUpdateJobContact,
  useUpdateMaterial,
} from "../queries/jobs";
import { SupervisorPicker } from "../components/supervisor-picker";
import { useCreateTask, useRemoveTask } from "../queries/tasks";
import { useBootstrap } from "../queries/settings";
import { useContacts } from "../queries/contacts";

const money = (n: number) =>
  n.toLocaleString("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 });

const JOB_CONTACT_ROLES = [
  "job_contact",
  "property_manager",
  "tenant",
  "accounts",
  "supervisor",
  "owner",
  "referrer",
  "other",
];

const roleLabel = (r: string) => r.replace(/_/g, " ");

const MATERIAL_STATUS = ["to_order", "ordered", "on_site", "installed"];

function fmtDate(value: string | null) {
  if (!value) return "Unscheduled";
  const d = new Date(`${value}T00:00:00`);
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

/* ------------------------------- add a task ------------------------------ */

function NewTaskModal({ jobId, open, onClose, furniture }: { jobId: number; open: boolean; onClose: () => void; furniture: boolean }) {
  const bootstrap = useBootstrap();
  const create = useCreateTask();
  const [form, setForm] = React.useState({
    title: "",
    skillId: "",
    areaM2: "",
    durationHours: "4",
    crewSize: furniture ? "2" : "1",
    payType: "per_job" as "per_m2" | "hourly" | "per_job" | "day_rate",
    payAmount: "",
    scheduledDate: "",
    description: "",
  });
  const [error, setError] = React.useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const skill = (bootstrap.data?.skills ?? []).find((s) => String(s.id) === form.skillId);

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        jobId,
        title: form.title || skill?.name || "Task",
        skillId: form.skillId ? Number(form.skillId) : null,
        areaM2: form.areaM2 ? Number(form.areaM2) : null,
        durationHours: Number(form.durationHours || 4),
        crewSize: furniture ? 2 : Number(form.crewSize),
        payType: form.payType,
        payAmount: form.payAmount ? Number(form.payAmount) : null,
        scheduledDate: form.scheduledDate || null,
        description: form.description || null,
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
      title="Add a dispatch"
      subtitle="Each piece of work on the job is its own dispatch — own skill, own crew, own pay."
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add dispatch
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Skill">
          <Select
            value={form.skillId}
            onChange={(e) => {
              const id = e.target.value;
              const s = (bootstrap.data?.skills ?? []).find((x) => String(x.id) === id);
              setForm((f) => ({
                ...f,
                skillId: id,
                title: f.title || s?.name || "",
                crewSize: furniture ? "2" : String(s?.defaultCrewSize ?? 1),
              }));
            }}
          >
            <option value="">Pick a skill</option>
            {(bootstrap.data?.skills ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What it's called on the board">
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Lift tiles — kitchen" />
        </Field>
        <Field label="Area (m²)">
          <Input type="number" inputMode="decimal" value={form.areaM2} onChange={(e) => set("areaM2", e.target.value)} />
        </Field>
        <Field label="Hours on site">
          <Input
            type="number"
            inputMode="decimal"
            value={form.durationHours}
            onChange={(e) => set("durationHours", e.target.value)}
          />
        </Field>
        <Field
          label="Crew size"
          hint={furniture ? "Locked at 2 — furniture on site." : "2 means either a lead with his own offsider, or two bookings."}
        >
          <Select value={form.crewSize} onChange={(e) => set("crewSize", e.target.value)} disabled={furniture}>
            <option value="1">1 man</option>
            <option value="2">2 men</option>
          </Select>
        </Field>
        <Field label="Date (optional)">
          <Input type="date" value={form.scheduledDate} onChange={(e) => set("scheduledDate", e.target.value)} />
        </Field>
        <Field label="Installer pay basis">
          <Select value={form.payType} onChange={(e) => set("payType", e.target.value as typeof form.payType)}>
            <option value="per_job">Fixed for the task</option>
            <option value="per_m2">Per m²</option>
            <option value="hourly">Hourly</option>
            <option value="day_rate">Day rate</option>
          </Select>
        </Field>
        <Field label="Pay amount" hint="Leave blank to use the installer's own rate.">
          <Input
            type="number"
            inputMode="decimal"
            value={form.payAmount}
            onChange={(e) => set("payAmount", e.target.value)}
          />
        </Field>
        <Field label="Notes for the installer" className="sm:col-span-2">
          <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ------------------------------ job contacts ----------------------------- */

function AddContactModal({ jobId, open, onClose }: { jobId: number; open: boolean; onClose: () => void }) {
  const contacts = useContacts();
  const add = useAddJobContact();
  const [contactId, setContactId] = React.useState("");
  const [role, setRole] = React.useState("job_contact");
  const [flags, setFlags] = React.useState({
    receivesSms: false,
    receivesEmail: false,
    canApproveQuote: false,
    onSiteContact: false,
  });
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await add.mutateAsync({ jobId, contactId: Number(contactId), role, isPrimary: false, ...flags });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add someone to this job"
      subtitle="Property manager, tenant, accounts, supervisor — each with their own comms."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!contactId || add.isPending}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Person">
          <Select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Pick a contact</option>
            {(contacts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName} {c.companyNames ? `— ${c.companyNames}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Role on this job">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            {JOB_CONTACT_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["receivesSms", "Gets the SMS updates"],
              ["receivesEmail", "Gets the emails"],
              ["canApproveQuote", "Can approve the quote"],
              ["onSiteContact", "On-site contact"],
            ] as const
          ).map(([key, label]) => (
            <label htmlFor={`job_detail_cb1`} key={key} className="flex items-center gap-2 text-sm">
              <Checkbox id={`job_detail_cb1`}
                checked={flags[key]}
                onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* -------------------------------- the page ------------------------------- */

/**
 * The supervisor who sent the job. Reads and writes the same `job_contacts`
 * link as everyone else on the job, at role 'supervisor', so it also shows up
 * in the people list below with its comms flags.
 */
function SupervisorCard({
  jobId,
  companyId,
  current,
}: {
  jobId: number;
  companyId: number | null;
  current: { contactId: number; name: string } | null;
}) {
  const setSupervisor = useSetJobSupervisor();
  const currentId = current?.contactId ?? null;
  const [editing, setEditing] = React.useState(false);
  const [picked, setPicked] = React.useState(currentId ? String(currentId) : "");

  // Keep the picker in step when the job reloads with a different supervisor.
  React.useEffect(() => {
    setPicked(currentId ? String(currentId) : "");
  }, [currentId]);

  async function save(contactId: number | null) {
    await setSupervisor.mutateAsync({ jobId, contactId });
    setEditing(false);
  }

  return (
    <Card>
      <CardHeader
        title="Supervisor"
        subtitle="Who sent this work. Drives the supervisor numbers on Profitability."
        action={
          companyId && !editing ? (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {current ? "Change" : "Add"}
            </Button>
          ) : null
        }
      />
      <div className="px-4 py-3.5">
        {editing ? (
          <div className="space-y-3">
            <SupervisorPicker
              companyId={companyId}
              value={picked}
              onChange={(v) => setPicked(v)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() => save(picked ? Number(picked) : null)}
                disabled={setSupervisor.isPending}
              >
                {setSupervisor.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {current ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => save(null)}
                  disabled={setSupervisor.isPending}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        ) : current ? (
          <Link to={`/supervisors/${current.contactId}`} className="text-sm font-medium text-primary hover:underline">
            {current.name}
          </Link>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            {companyId
              ? "Nobody recorded yet. This job will not show up under any supervisor until one is added."
              : "Private customer, so there is no builder supervisor to record."}
          </p>
        )}
      </div>
    </Card>
  );
}

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const job = useJob(Number.isFinite(id) ? id : null);
  const bootstrap = useBootstrap();
  const updateJob = useUpdateJob();
  const updateContact = useUpdateJobContact();
  const removeContact = useRemoveJobContact();
  const addMaterial = useAddMaterial();
  const updateMaterial = useUpdateMaterial();
  const removeMaterial = useRemoveMaterial();
  const addNote = useAddJobNote();
  const removeTask = useRemoveTask();

  // The inbox deep-links straight at the thread: /jobs/12?tab=conversation.
  const searchString = useSearch();
  const wantsThread = new URLSearchParams(searchString).get("tab") === "conversation";
  const [tab, setTab] = React.useState<"job" | "conversation">(wantsThread ? "conversation" : "job");
  const [taskModal, setTaskModal] = React.useState(false);
  const [contactModal, setContactModal] = React.useState(false);
  const [measuring, setMeasuring] = React.useState<{ id: number; title: string } | null>(null);
  const [booking, setBooking] = React.useState<number | null>(null);
  const [note, setNote] = React.useState("");
  const [material, setMaterial] = React.useState({ description: "", qty: "", unit: "m2" });

  if (job.isLoading) return <Loading label="Loading job…" />;
  if (job.error || !job.data) {
    return (
      <Page title="Job not found">
        <Card>
          <Empty>
            That job isn't there.{" "}
            <Link to="/jobs" className="text-primary hover:underline">
              Back to jobs
            </Link>
          </Empty>
        </Card>
      </Page>
    );
  }

  const j = job.data;
  const customer = j.company?.name ?? [j.contact?.firstName, j.contact?.lastName].filter(Boolean).join(" ") ?? "—";

  return (
    <Page
      title={`Job #${j.number}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Link to="/jobs" className="inline-flex items-center gap-1 text-primary hover:underline">
            <ArrowLeft className="size-3.5" /> All jobs
          </Link>
          <span className="text-muted-foreground">·</span>
          {j.title || "Untitled"}
        </span>
      }
      actions={
        <>
          <Select
            className="w-auto min-w-[150px]"
            value={j.statusId ? String(j.statusId) : ""}
            onChange={(e) => updateJob.mutate({ id: j.id, statusId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No status</option>
            {(bootstrap.data?.statuses ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <MemoButton jobId={j.id} />
          <Button onClick={() => setTaskModal(true)}>
            <Plus className="size-4" />
            Add dispatch
          </Button>
        </>
      }
    >
      {/* Two ways to read a job: the work, and the talking. */}
      <div className="mb-4 flex gap-1.5">
        <Button size="sm" variant={tab === "job" ? "default" : "outline"} onClick={() => setTab("job")}>
          The job
        </Button>
        <Button
          size="sm"
          variant={tab === "conversation" ? "default" : "outline"}
          onClick={() => setTab("conversation")}
        >
          <MessagesSquare className="size-3.5" />
          Conversation
        </Button>
      </div>

      {tab === "conversation" ? <JobConversation jobId={j.id} /> : null}

      <div className={tab === "job" ? "grid gap-4 lg:grid-cols-[1fr_340px]" : "hidden"}>
        <div className="grid gap-4">
          {/* header facts */}
          <Card className="px-4 py-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <p className="label-xs">Customer</p>
                <p className="mt-0.5 text-sm font-medium">{customer}</p>
                <p className="text-xs text-muted-foreground">
                  bills {j.billToType === "company" ? "the company" : "the contact"}
                </p>
              </div>
              <div>
                <p className="label-xs">Site</p>
                <p className="mt-0.5 text-sm">{j.site?.address ?? "—"}</p>
                <p className="text-xs text-muted-foreground">{j.site?.suburb ?? ""}</p>
              </div>
              <div>
                <p className="label-xs">Value ex GST</p>
                <p className="tabular mt-0.5 text-sm font-medium">{money(j.value)}</p>
              </div>
              <div>
                <p className="label-xs">Furniture on site</p>
                <label htmlFor={`job_detail_cb2`} className="mt-1 flex items-center gap-2 text-sm">
                  <Checkbox id={`job_detail_cb2`}
                    checked={j.furnitureOnSite}
                    onChange={(e) => updateJob.mutate({ id: j.id, furnitureOnSite: e.target.checked })}
                  />
                  {j.furnitureOnSite ? "Yes — 2-man crews" : "No"}
                </label>
              </div>
            </div>
            {j.accessNotes ? (
              <p className="mt-3 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Access:</span> {j.accessNotes}
              </p>
            ) : null}
          </Card>

          {/* what the job makes */}
          <JobForecastCard jobId={j.id} />

          {/* what it costs Terra to carry, and when the money moves */}
          <JobCashCard jobId={j.id} />

          {/* when the customer's money actually lands */}
          <PaymentTermsCard jobId={j.id} companyName={j.company?.name ?? null} />

          {/* dispatches */}
          <Card>
            <CardHeader
              title="Dispatches"
              subtitle="Tasks are what gets assigned — not the job."
              action={
                <span className="text-xs text-muted-foreground">
                  {j.tasks.filter((t) => t.status === "complete").length}/{j.tasks.length} done
                </span>
              }
            />
            {j.tasks.length === 0 ? (
              <Empty>No dispatches yet. Add the first one — tile removal, prep, lay, skirting…</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {j.tasks.map((t) => {
                  const tint = tintFor(t.skill?.groupName);
                  return (
                    <li key={t.id} className="flex items-start gap-3 px-4 py-3">
                      <span className="mt-1 h-8 w-1 rounded-full" style={{ backgroundColor: tint.edge }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{t.title}</p>
                          <Badge colour={TASK_STATUS_COLOUR[t.status]}>{TASK_STATUS_LABEL[t.status] ?? t.status}</Badge>
                          {t.crewSize > 1 ? (
                            <Badge>
                              <Users className="size-3" /> 2
                            </Badge>
                          ) : null}
                          {t.pendingOffers > 0 ? <Badge colour="#D08A1E">{t.pendingOffers} offered</Badge> : null}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t.skill?.name ?? "No skill"} · {fmtDate(t.scheduledDate)} · {t.durationHours}h
                          {t.areaM2 ? ` · ${t.areaM2}m²` : ""} ·{" "}
                          {t.installer ? `on ${t.installer.name}` : "nobody on it"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setMeasuring({ id: t.id, title: t.title })}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          Measure up
                        </button>
                        <button
                          type="button"
                          onClick={() => setBooking(t.id)}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          Book
                        </button>
                        <button
                          type="button"
                          onClick={() => removeTask.mutate({ id: t.id })}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                          title="Delete dispatch"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* who sent the work */}
          <SupervisorCard
            jobId={j.id}
            companyId={j.companyId ?? null}
            current={(() => {
              const row = j.contacts.find((p) => p.link.role === "supervisor");
              return row
                ? {
                    contactId: row.contact.id,
                    name: `${row.contact.firstName} ${row.contact.lastName}`.trim(),
                  }
                : null;
            })()}
          />

          {/* people on the job */}
          <Card>
            <CardHeader
              title="People on this job"
              subtitle="Each one has their own comms flags."
              action={
                <Button variant="secondary" onClick={() => setContactModal(true)}>
                  <Plus className="size-3.5" />
                  Add
                </Button>
              }
            />
            {j.contacts.length === 0 ? (
              <Empty>Nobody linked yet.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {j.contacts.map(({ link, contact }) => (
                  <li key={link.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <Link to={`/clients/${contact.id}`} className="text-sm font-medium text-primary hover:underline">
                          {contact.firstName} {contact.lastName}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {roleLabel(link.role)}
                          {contact.mobile ? ` · ${contact.mobile}` : ""}
                          {link.isPrimary ? " · primary" : ""}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeContact.mutate({ id: link.id })}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {(
                        [
                          ["receivesSms", "SMS"],
                          ["receivesEmail", "Email"],
                          ["canApproveQuote", "Can approve quotes"],
                          ["onSiteContact", "On site"],
                        ] as const
                      ).map(([key, label]) => (
                        <label htmlFor={`job_detail_cb3`} key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox id={`job_detail_cb3`}
                            checked={Boolean(link[key])}
                            onChange={(e) => updateContact.mutate({ id: link.id, [key]: e.target.checked })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* materials */}
          <Card>
            <CardHeader title="Materials" subtitle="What has to be on site before anyone turns up." />
            {j.materials.length > 0 ? (
              <ul className="divide-y divide-border">
                {j.materials.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{m.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {m.qty} {m.unit}
                      </p>
                    </div>
                    <Select
                      className="w-auto"
                      value={m.status}
                      onChange={(e) => updateMaterial.mutate({ id: m.id, status: e.target.value })}
                    >
                      {MATERIAL_STATUS.map((s) => (
                        <option key={s} value={s}>
                          {roleLabel(s)}
                        </option>
                      ))}
                    </Select>
                    <button
                      type="button"
                      onClick={() => removeMaterial.mutate({ id: m.id })}
                      className="text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3">
              <Field label="Material" className="min-w-[200px] flex-1">
                <Input
                  value={material.description}
                  onChange={(e) => setMaterial((m) => ({ ...m, description: e.target.value }))}
                  placeholder="Belgotex Tuscany — Nomad, 4m broadloom"
                />
              </Field>
              <Field label="Qty" className="w-20">
                <Input
                  type="number"
                  inputMode="decimal"
                  value={material.qty}
                  onChange={(e) => setMaterial((m) => ({ ...m, qty: e.target.value }))}
                />
              </Field>
              <Field label="Unit" className="w-24">
                <Select value={material.unit} onChange={(e) => setMaterial((m) => ({ ...m, unit: e.target.value }))}>
                  <option value="m2">m²</option>
                  <option value="lm">lm</option>
                  <option value="each">each</option>
                  <option value="roll">roll</option>
                </Select>
              </Field>
              <Button
                variant="secondary"
                disabled={!material.description || addMaterial.isPending}
                onClick={async () => {
                  await addMaterial.mutateAsync({
                    jobId: j.id,
                    description: material.description,
                    qty: material.qty ? Number(material.qty) : 0,
                    unit: material.unit,
                  });
                  setMaterial({ description: "", qty: "", unit: "m2" });
                }}
              >
                Add
              </Button>
            </div>
          </Card>

          {/* ordering the materials, and the supplier invoices that come back */}
          <PurchaseOrdersCard jobId={j.id} />
        </div>

        {/* right rail */}
        <div className="grid gap-4">
          <Card>
            <CardHeader title="Quotes" />
            {j.quotes.length === 0 ? (
              <Empty>No quote on this job.</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {j.quotes.map((q) => (
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

          <JobVisits jobId={j.id} />

          <Card>
            <CardHeader title="History" subtitle="Everything that's happened on this job." />
            <div className="border-b border-border px-4 py-3">
              <Textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add a note…"
              />
              <Button
                className="mt-2 w-full"
                variant="secondary"
                disabled={!note.trim() || addNote.isPending}
                onClick={async () => {
                  await addNote.mutateAsync({ jobId: j.id, body: note.trim() });
                  setNote("");
                }}
              >
                Save note
              </Button>
            </div>
            {j.activity.length === 0 ? (
              <Empty>Nothing logged yet.</Empty>
            ) : (
              <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
                {j.activity.map((a) => (
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

          <JobFile jobId={j.id} />
        </div>
      </div>

      {j.furnitureOnSite ? (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Sofa className="size-3.5 text-[var(--primary)]" />
          Furniture is on site, so every open dispatch on this job is locked to a 2-man crew.
        </p>
      ) : null}

      <NewTaskModal jobId={j.id} open={taskModal} onClose={() => setTaskModal(false)} furniture={j.furnitureOnSite} />
      <AddContactModal jobId={j.id} open={contactModal} onClose={() => setContactModal(false)} />
      <MeasureUpModal
        taskId={measuring?.id ?? null}
        title={measuring?.title ?? ""}
        open={measuring != null}
        onClose={() => setMeasuring(null)}
      />

      {booking != null ? (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            aria-label="Close booking"
            className="flex-1 bg-black/30"
            onClick={() => setBooking(null)}
          />
          <BookInstallerPanel
            taskId={booking}
            onClose={() => setBooking(null)}
            onBooked={() => void job.refetch()}
          />
        </div>
      ) : null}
    </Page>
  );
}
