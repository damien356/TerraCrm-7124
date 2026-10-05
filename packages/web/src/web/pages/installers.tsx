import * as React from "react";
import { Check, Star, Trash2 } from "lucide-react";
import { CardHeader, Loading, Spinner } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/field";
import { Modal } from "../components/ui/modal";
import { InstallerRatesTab } from "../components/labour";
import {
  useCreateInstaller,
  useInstaller,
  useSetInstallerSkill,
  useUpdateInstaller,
  uploadInstallerLogo,
} from "../queries/installers";
import { useBootstrap } from "../queries/settings";
import {
  useAddUnavailabilityFromText,
  useRemoveUnavailability,
  useUnavailability,
} from "../queries/availability";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });

function dateInput(value: Date | string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/* ---------------------------- new installer ---------------------------- */

export function NewInstallerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateInstaller();
  const [form, setForm] = React.useState({
    name: "",
    mobile: "",
    email: "",
    crewCapacity: "solo" as "solo" | "own_offsider" | "needs_partner",
    serviceArea: "",
    abn: "",
    colour: "#4A7FA5",
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
        mobile: form.mobile || null,
        email: form.email || null,
        crewCapacity: form.crewCapacity,
        serviceArea: form.serviceArea || null,
        abn: form.abn || null,
        colour: form.colour,
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
      title="New installer"
      subtitle="Add the man first, then tick the skills he's allowed to be dispatched for."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!form.name || create.isPending}>
            {create.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add installer
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="Mobile">
          <Input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} placeholder="0412 345 678" />
        </Field>
        <Field label="Email" hint="Used for their app invite later">
          <Input value={form.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Crew capacity" hint="Decides who can take a 2-man task alone">
          <Select
            value={form.crewCapacity}
            onChange={(e) => set("crewCapacity", e.target.value as typeof form.crewCapacity)}
          >
            <option value="solo">Works solo</option>
            <option value="own_offsider">Brings his own offsider</option>
            <option value="needs_partner">Needs a partner</option>
          </Select>
        </Field>
        <Field label="Service area">
          <Input
            value={form.serviceArea}
            onChange={(e) => set("serviceArea", e.target.value)}
            placeholder="Gold Coast, Tweed"
          />
        </Field>
        <Field label="ABN">
          <Input value={form.abn} onChange={(e) => set("abn", e.target.value)} />
        </Field>
        <Field label="Board colour">
          <input
            type="color"
                aria-label="Colour"
            value={form.colour}
            onChange={(e) => set("colour", e.target.value)}
            className="h-9 w-full cursor-pointer rounded-md border border-border bg-card px-1"
          />
        </Field>
        <Field label="Notes" className="sm:col-span-2">
          <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ------------------------- skills + card editor ------------------------- */

function SkillRow({
  installerId,
  skill,
  link,
}: {
  installerId: number;
  skill: { id: number; name: string; groupName: string; defaultCrewSize: number };
  link?: { rateType: string; rate: number | null; canLead: boolean };
}) {
  const setSkill = useSetInstallerSkill();
  const enabled = !!link;

  function save(patch: { enabled?: boolean; rateType?: string; rate?: number | null; canLead?: boolean }) {
    setSkill.mutate({
      installerId,
      skillId: skill.id,
      enabled: patch.enabled ?? enabled,
      rateType: (patch.rateType ?? link?.rateType ?? "per_m2") as "per_m2" | "hourly" | "per_job" | "day_rate",
      rate: patch.rate !== undefined ? patch.rate : (link?.rate ?? null),
      canLead: patch.canLead ?? link?.canLead ?? true,
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 last:border-0">
      <label htmlFor={`installers_cb1`} className="flex min-w-[190px] flex-1 items-center gap-2 text-sm">
        <Checkbox id={`installers_cb1`} checked={enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        <span className={enabled ? "font-medium" : "text-muted-foreground"}>{skill.name}</span>
        {skill.defaultCrewSize > 1 ? <Badge>2 man</Badge> : null}
      </label>

      {/* Pay used to be typed here, one rate per skill. It now lives on the
          Rates tab: per work item, effective dated, and it keeps its history. */}
      <label htmlFor={`installers_cb2`} className="flex w-[92px] items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox id={`installers_cb2`}
          checked={link?.canLead ?? false}
          disabled={!enabled}
          onChange={(e) => save({ canLead: e.target.checked })}
        />
        Can lead
      </label>
    </div>
  );
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function prettyRange(from: string | null, to: string | null) {
  if (!from) return "";
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  return from === to ? fmt(from) : `${fmt(from)} → ${fmt(to ?? from)}`;
}

/**
 * Blackout dates. He types it how he'd say it and we parse it into real blocked
 * dates. The booking check is server-side, not a warning on the screen.
 */
function BlackoutCard({ installerId }: { installerId: number }) {
  const rows = useUnavailability(installerId);
  const addFromText = useAddUnavailabilityFromText();
  const remove = useRemoveUnavailability();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    if (text.trim().length < 2) return;
    setError(null);
    try {
      await addFromText.mutateAsync({ installerId, text });
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="rounded-lg border border-border">
      <CardHeader
        title="Days he can't work"
        subtitle="Type it how you'd say it. He won't be offered or booked on these days."
      />
      <div className="flex flex-col gap-2 px-4 pb-3">
        <div className="flex gap-2">
          <Input
            value={text}
            placeholder="off Dec 1-17, Japan trip"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <Button variant="secondary" onClick={submit} disabled={addFromText.isPending}>
            {addFromText.isPending ? <Spinner /> : null}
            Block it
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Works with "never works weekends", "no Mondays", "away 24 Dec - 5 Jan", "off 3/12".
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      {rows.isLoading ? (
        <Loading />
      ) : (rows.data ?? []).length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing blocked, available any working day.</p>
      ) : (
        <ul className="border-t border-border">
          {(rows.data ?? []).map((r) => {
            const days = (() => {
              try {
                const parsed: unknown = JSON.parse(r.weekdayMask);
                return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : [];
              } catch {
                return [];
              }
            })();
            return (
              <li key={r.id} className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
                <div className="flex-1">
                  <p className="text-sm font-medium">
                    {r.kind === "recurring"
                      ? `Never works ${days.map((d) => WEEKDAY_SHORT[d]).join(", ")}`
                      : prettyRange(r.fromDate, r.toDate)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {r.reason || "No reason given"}
                    {r.rawText ? ` · you typed: "${r.rawText}"` : ""}
                  </p>
                </div>
                <Badge colour={r.kind === "recurring" ? "#7A736D" : "#C0603F"}>
                  {r.kind === "recurring" ? "Standing rule" : "Blocked"}
                </Badge>
                <button
                  type="button"
                  aria-label="Remove"
                  onClick={() => remove.mutate({ id: r.id })}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The contractor's own invoicing profile. Whatever is typed here is what gets
 * printed on the invoice he raises from Terra Crew, in his business name and
 * billed to Arclan Pty Ltd t/a Terra Flooring.
 *
 * Two things here gate him entirely. He cannot raise an invoice until the
 * office has given him a starting invoice number, because the numbering is his
 * sequence not Terra's, and he cannot raise one without bank details because
 * accounts would have nowhere to pay it. The readiness strip below says so
 * plainly rather than letting him find out on the job.
 */
function InstallerInvoicingTab({ id }: { id: number }) {
  const detail = useInstaller(id);
  const update = useUpdateInstaller();
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [form, setForm] = React.useState<{
    tradingName: string;
    gstRegistered: boolean;
    abn: string;
    businessAddress: string;
    invoiceEmail: string;
    bankAccountName: string;
    bankBsb: string;
    bankAccountNumber: string;
    nextInvoiceNumber: string;
    logoUrl: string | null;
  } | null>(null);

  const installer = detail.data?.installer;
  const invoicing = detail.data?.invoicing;

  React.useEffect(() => {
    if (!installer) return;
    setForm({
      tradingName: installer.tradingName ?? "",
      gstRegistered: installer.gstRegistered,
      abn: installer.abn ?? "",
      businessAddress: installer.businessAddress ?? "",
      invoiceEmail: installer.invoiceEmail ?? installer.email ?? "",
      bankAccountName: installer.bankAccountName ?? "",
      bankBsb: installer.bankBsb ?? "",
      bankAccountNumber: installer.bankAccountNumber ?? "",
      nextInvoiceNumber: installer.nextInvoiceNumber == null ? "" : String(installer.nextInvoiceNumber),
      logoUrl: installer.logoUrl ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per installer
  }, [installer?.id]);

  function set<K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) {
    setSaved(false);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const key = await uploadInstallerLogo(file, id);
      set("logoUrl", key);
      await update.mutateAsync({ id, logoUrl: key });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!form) return;
    setError(null);
    const numbered = form.nextInvoiceNumber.trim();
    if (numbered && !/^\d+$/.test(numbered)) {
      setError("The starting invoice number has to be a whole number.");
      return;
    }
    try {
      await update.mutateAsync({
        id,
        tradingName: form.tradingName.trim() || null,
        gstRegistered: form.gstRegistered,
        abn: form.abn.trim() || null,
        businessAddress: form.businessAddress.trim() || null,
        invoiceEmail: form.invoiceEmail.trim() || null,
        bankAccountName: form.bankAccountName.trim() || null,
        bankBsb: form.bankBsb.trim() || null,
        bankAccountNumber: form.bankAccountNumber.trim() || null,
        // Once he has raised one, the number is locked and we never send it.
        ...(invoicing && invoicing.raised > 0 ? {} : { nextInvoiceNumber: numbered ? Number(numbered) : null }),
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (detail.isLoading || !form || !invoicing) return <Loading />;

  const locked = invoicing.raised > 0;
  const blockers: string[] = [];
  if (installer?.nextInvoiceNumber == null) blockers.push("no starting invoice number");
  if (form.gstRegistered && !form.abn.trim()) blockers.push("GST registered with no ABN");
  if (!form.bankAccountName.trim() || !form.bankBsb.trim() || !form.bankAccountNumber.trim())
    blockers.push("bank details incomplete");

  return (
    <div className="flex flex-col gap-4">
      <div
        className={
          blockers.length
            ? "rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            : "rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        }
      >
        {blockers.length ? (
          <>
            <span className="font-medium">He can't raise an invoice yet.</span> Outstanding: {blockers.join(", ")}.
          </>
        ) : (
          <>
            <Check className="mr-1 inline size-4" />
            Set up. He can invoice a completed job from his phone.
          </>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Trading / business name" hint="Printed at the top of his invoice. Falls back to his own name.">
          <Input
            value={form.tradingName}
            placeholder={installer?.name ?? ""}
            onChange={(e) => set("tradingName", e.target.value)}
          />
        </Field>
        <Field label="ABN">
          <Input value={form.abn} onChange={(e) => set("abn", e.target.value)} />
        </Field>
        <Field label="Business / home address" className="sm:col-span-2">
          <Textarea rows={2} value={form.businessAddress} onChange={(e) => set("businessAddress", e.target.value)} />
        </Field>
        <Field label="Invoice email" hint="His copy of every submitted invoice lands here.">
          <Input value={form.invoiceEmail} onChange={(e) => set("invoiceEmail", e.target.value)} />
        </Field>
        <Field label="GST" hint="GST is only ever added if he's registered for it.">
          <label htmlFor="installer-gst-registered" className="flex h-9 items-center gap-2 text-sm">
            <Checkbox
              id="installer-gst-registered"
              checked={form.gstRegistered}
              onChange={(e) => set("gstRegistered", e.target.checked)}
            />
            Registered for GST
          </label>
        </Field>
      </div>

      <div className="rounded-lg border border-border p-3">
        <p className="label-xs mb-2">Bank details</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Account name" className="sm:col-span-3">
            <Input value={form.bankAccountName} onChange={(e) => set("bankAccountName", e.target.value)} />
          </Field>
          <Field label="BSB">
            <Input value={form.bankBsb} placeholder="000-000" onChange={(e) => set("bankBsb", e.target.value)} />
          </Field>
          <Field label="Account number" className="sm:col-span-2">
            <Input value={form.bankAccountNumber} onChange={(e) => set("bankAccountNumber", e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Starting invoice number"
          hint={
            locked
              ? `Locked. He's raised ${invoicing.raised}, last one was #${invoicing.lastNumber}. Next will be #${installer?.nextInvoiceNumber}.`
              : "His sequence, not Terra's. Set it to whatever his next invoice number is, then it locks."
          }
        >
          <Input
            inputMode="numeric"
            disabled={locked}
            value={form.nextInvoiceNumber}
            placeholder="e.g. 1042"
            onChange={(e) => set("nextInvoiceNumber", e.target.value)}
          />
        </Field>
        <Field label="Business logo" hint="Optional. Sits on his invoice instead of the Terra mark.">
          <div className="flex items-center gap-3">
            {invoicing.logoViewUrl ? (
              <img
                src={invoicing.logoViewUrl}
                alt="Logo"
                className="h-9 w-16 rounded border border-border bg-card object-contain"
              />
            ) : null}
            <label className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-sm hover:bg-secondary">
              {uploading ? "Uploading..." : invoicing.logoViewUrl ? "Replace" : "Upload"}
              <input
                type="file"
                accept="image/*"
                aria-label="Upload invoice logo"
                className="hidden"
                disabled={uploading}
                onChange={(e) => pickLogo(e.target.files?.[0])}
              />
            </label>
          </div>
        </Field>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
          Save invoicing
        </Button>
        {saved && !update.isPending ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
      </div>
    </div>
  );
}

export function InstallerPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const [panel, setPanel] = React.useState<"card" | "rates" | "invoicing">("card");
  const detail = useInstaller(id);
  const bootstrap = useBootstrap();
  const update = useUpdateInstaller();
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<{
    name: string;
    mobile: string;
    email: string;
    crewCapacity: "solo" | "own_offsider" | "needs_partner";
    serviceArea: string;
    abn: string;
    colour: string;
    insuranceExpiry: string;
    licenceExpiry: string;
    unavailableDays: number[];
    starRating: number;
    creditLimit: string;
    notes: string;
    active: boolean;
  } | null>(null);

  const installer = detail.data?.installer;

  React.useEffect(() => {
    if (!installer) return;
    setForm({
      name: installer.name,
      mobile: installer.mobile ?? "",
      email: installer.email ?? "",
      crewCapacity: installer.crewCapacity as "solo" | "own_offsider" | "needs_partner",
      serviceArea: installer.serviceArea ?? "",
      abn: installer.abn ?? "",
      colour: installer.colour,
      insuranceExpiry: dateInput(installer.insuranceExpiry),
      licenceExpiry: dateInput(installer.licenceExpiry),
      unavailableDays: installer.unavailableDays,
      starRating: installer.starRating,
      creditLimit: String(installer.creditLimit ?? 0),
      notes: installer.notes ?? "",
      active: installer.active,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate the form only when a different installer is opened
  }, [installer?.id]);

  function set<K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function save() {
    if (!form) return;
    setError(null);
    try {
      await update.mutateAsync({
        id,
        name: form.name,
        mobile: form.mobile || null,
        email: form.email || null,
        crewCapacity: form.crewCapacity,
        serviceArea: form.serviceArea || null,
        abn: form.abn || null,
        colour: form.colour,
        insuranceExpiry: form.insuranceExpiry ? new Date(`${form.insuranceExpiry}T00:00:00`) : null,
        licenceExpiry: form.licenceExpiry ? new Date(`${form.licenceExpiry}T00:00:00`) : null,
        unavailableDays: form.unavailableDays,
        starRating: form.starRating,
        creditLimit: Number(form.creditLimit) || 0,
        notes: form.notes || null,
        active: form.active,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const skills = bootstrap.data?.allSkills ?? [];
  const linkBySkill = new Map((detail.data?.skills ?? []).map((s) => [s.skillId, s]));
  const groups = Array.from(new Set(skills.map((s) => s.groupName)));

  return (
    <Modal
      open
      onClose={onClose}
      title={installer?.name ?? "Installer"}
      subtitle="Skills, rates and availability. He can only ever be offered a task he's ticked for."
      width={panel === "rates" ? "max-w-5xl" : "max-w-3xl"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {panel === "card" ? (
            <Button onClick={save} disabled={!form || update.isPending}>
              {update.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save card
            </Button>
          ) : null}
        </>
      }
    >
      {/* Two views on the one man: his details, and what Terra pays him. */}
      <div className="mb-4 flex gap-1 rounded-lg border border-border bg-background p-1">
        {([
          { id: "card", label: "His card" },
          { id: "rates", label: "Rates" },
          { id: "invoicing", label: "Invoicing" },
        ] as const).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setPanel(t.id)}
            className={
              panel === t.id
                ? "rounded-md bg-[var(--sidebar)] px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {panel === "rates" ? <InstallerRatesTab installerId={id} /> : null}
      {panel === "invoicing" ? <InstallerInvoicingTab id={id} /> : null}

      {panel === "card" && (detail.isLoading || !form) ? <Loading /> : null}
      {panel === "card" && !(detail.isLoading || !form) ? (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Mobile">
              <Input value={form.mobile} onChange={(e) => set("mobile", e.target.value)} />
            </Field>
            <Field label="Email">
              <Input value={form.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Crew capacity">
              <Select
                value={form.crewCapacity}
                onChange={(e) => set("crewCapacity", e.target.value as typeof form.crewCapacity)}
              >
                <option value="solo">Works solo</option>
                <option value="own_offsider">Brings his own offsider</option>
                <option value="needs_partner">Needs a partner</option>
              </Select>
            </Field>
            <Field label="Service area">
              <Input value={form.serviceArea} onChange={(e) => set("serviceArea", e.target.value)} />
            </Field>
            <Field label="ABN">
              <Input value={form.abn} onChange={(e) => set("abn", e.target.value)} />
            </Field>
            <Field label="Insurance expiry">
              <Input
                type="date"
                value={form.insuranceExpiry}
                onChange={(e) => set("insuranceExpiry", e.target.value)}
              />
            </Field>
            <Field label="Licence expiry">
              <Input type="date" value={form.licenceExpiry} onChange={(e) => set("licenceExpiry", e.target.value)} />
            </Field>
            <Field label="Board colour">
              <input
                type="color"
                aria-label="Colour"
                value={form.colour}
                onChange={(e) => set("colour", e.target.value)}
                className="h-9 w-full cursor-pointer rounded-md border border-border bg-card px-1"
              />
            </Field>
            <Field label="On the tools?">
              <Select
                value={form.active ? "active" : "inactive"}
                onChange={(e) => set("active", e.target.value === "active")}
              >
                <option value="active">Active</option>
                <option value="inactive">Not working for us</option>
              </Select>
            </Field>
            <Field label="Star rating" hint="5 and 4 star can take a job on the spot. 3 and under sits on hold for 2 hours first.">
              <div className="flex items-center gap-1 pt-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`${n} star`}
                    onClick={() => set("starRating", n)}
                    className="p-0.5 text-lg leading-none"
                  >
                    <Star
                      className={
                        n <= form.starRating
                          ? "h-5 w-5 fill-warning text-warning"
                          : "h-5 w-5 text-muted-foreground/40"
                      }
                    />
                  </button>
                ))}
                <span className="ml-2 text-xs text-muted-foreground">{form.starRating} of 5</span>
              </div>
            </Field>
            <Field label="Materials credit limit" hint="Dollar ceiling on account. Blocked once he hits it. 0 = no account.">
              <Input
                type="number"
                min="0"
                step="50"
                value={form.creditLimit}
                onChange={(e) => set("creditLimit", e.target.value)}
              />
            </Field>
            <Field label="Days he doesn't work" className="sm:col-span-2">
              <div className="flex flex-wrap gap-1.5 pt-1">
                {DAYS.map((d, i) => {
                  const off = form.unavailableDays.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() =>
                        set(
                          "unavailableDays",
                          off ? form.unavailableDays.filter((n) => n !== i) : [...form.unavailableDays, i],
                        )
                      }
                      className={
                        off
                          ? "rounded-md bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive"
                          : "rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary"
                      }
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Notes" className="sm:col-span-2">
              <Textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </div>

          <div className="rounded-lg border border-border">
            <CardHeader
              title="Skills he's ticked for"
              subtitle="What he can be sent to. Saves as you tick. His pay is on the Rates tab."
            />
            {groups.map((group) => (
              <div key={group}>
                <p className="label-xs bg-secondary/60 px-4 py-1.5">{group.replace(/_/g, " ")}</p>
                {skills
                  .filter((s) => s.groupName === group)
                  .map((s) => (
                    <SkillRow key={s.id} installerId={id} skill={s} link={linkBySkill.get(s.id)} />
                  ))}
              </div>
            ))}
          </div>

          <BlackoutCard installerId={id} />

          {detail.data ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="card-surface px-3 py-2">
                <p className="label-xs">Tasks done</p>
                <p className="tabular mt-0.5 text-lg font-semibold">{detail.data.stats.completed}</p>
              </div>
              <div className="card-surface px-3 py-2">
                <p className="label-xs">Tasks all up</p>
                <p className="tabular mt-0.5 text-lg font-semibold">{detail.data.stats.total}</p>
              </div>
              <div className="card-surface px-3 py-2">
                <p className="label-xs">Pay booked</p>
                <p className="tabular mt-0.5 text-lg font-semibold">{money(detail.data.stats.payTotal)}</p>
              </div>
            </div>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------- page -------------------------------- */
