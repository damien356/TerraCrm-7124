import * as React from "react";
import { Building2, MapPin, UserPlus } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Modal } from "./ui/modal";
import { Combobox } from "./ui/combobox";
import { Spinner } from "./ui/card";
import { ContactPicker } from "./contact-picker";
import { SupervisorDraftPicker, supervisorChoiceName, type SupervisorChoice } from "./supervisor-picker";
import { QuotePeopleDraft, draftId, jobDraftsToInput, type PersonDraft } from "./job-people";
import {
  NewCompanyFields,
  NewContactFields,
  NewSiteFields,
  blankCompany,
  blankContact,
  blankSite,
  companyPayload,
  contactName,
  contactPayload,
  contactProblem,
  sitePayload,
  type NewCompanyDraft,
  type NewContactDraft,
  type NewSiteDraft,
} from "./new-records";
import { useCreateJob } from "../queries/jobs";
import { useBootstrap } from "../queries/settings";
import { useCompanies, useSites } from "../queries/companies";
import type { PersonTag } from "../../api/lib/person-tags";

/**
 * NEW JOB.
 *
 * Everything a new job needs can be picked from Ops or typed in right here:
 * the contact, the company, its supervisor, the site and anyone else on the
 * job. New records are only held in the form. "Create job" sends them with
 * the job and the server makes them all first (lib/job-new-records.ts), so
 * Cancel leaves nothing behind.
 *
 * Built so the New enquiry screen (spec section 3: contact, new address with
 * autocomplete, required lead source, duplicate check, Book measure) can
 * reuse the same pieces.
 */

/** Where the job came from. Required, nothing picked to start with. */
export const LEAD_SOURCES = [
  ["phone", "Phone"],
  ["website", "Website"],
  ["repeat", "Repeat customer"],
  ["referral", "Referral"],
  ["builder", "Builder"],
  ["walk_in", "Walk in"],
  ["other", "Other"],
  ["unknown", "Unknown"],
] as const;

type ContactChoice = { mode: "pick"; id: string; name: string } | { mode: "new"; draft: NewContactDraft };
type CompanyChoice = { mode: "pick"; id: string; name: string } | { mode: "new"; draft: NewCompanyDraft };
type SiteChoice = { mode: "pick"; id: string; label: string } | { mode: "new"; draft: NewSiteDraft };

/** Who gets the invoice: "main" (the job contact), "company", "sup", or a person's draftId. */
type BillTo = string;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

function useDebounced<T>(value: T, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/** Existing sites: the contact's own first, or a search over every site. */
function SitePicker({
  value,
  label,
  contactId,
  onChange,
}: {
  value: string;
  label: string;
  contactId: number | null;
  onChange: (id: string, label: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const q = useDebounced(query.trim());
  const searched = useSites({ search: q }, q.length >= 2);
  const theirs = useSites({ contactId: contactId ?? 0 }, !!contactId);
  const rows = q.length >= 2 ? (searched.data ?? []) : (theirs.data ?? []);
  const options = rows.slice(0, 30).map((s) => {
    const owner = s.company?.name ?? ([s.contact?.firstName, s.contact?.lastName].filter(Boolean).join(" ") || undefined);
    return { value: String(s.site.id), label: [s.site.address, s.site.suburb].filter(Boolean).join(", "), sublabel: owner };
  });
  return (
    <Combobox
      value={value}
      onChange={(v) => onChange(v, options.find((o) => o.value === v)?.label ?? "")}
      options={options}
      onQueryChange={setQuery}
      selectedLabel={label}
      loading={searched.isFetching || query.trim() !== q}
      idleHint={contactId ? "Their sites show here. Or type a street to search." : "Type a street or suburb"}
      placeholder="Search sites…"
      emptyLabel="None yet"
    />
  );
}

export function NewJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bootstrap = useBootstrap();
  const companies = useCompanies();
  const create = useCreateJob();

  const [form, setForm] = React.useState({
    title: "",
    statusId: "",
    furnitureOnSite: false,
    value: "",
    description: "",
    accessNotes: "",
    source: "",
  });
  const [contact, setContact] = React.useState<ContactChoice>({ mode: "pick", id: "", name: "" });
  const [company, setCompany] = React.useState<CompanyChoice>({ mode: "pick", id: "", name: "" });
  const [supervisor, setSupervisor] = React.useState<SupervisorChoice>({ kind: "none" });
  const [site, setSite] = React.useState<SiteChoice>({ mode: "pick", id: "", label: "" });
  const [people, setPeople] = React.useState<PersonDraft[]>([]);
  const [billTo, setBillTo] = React.useState<BillTo>("main");
  const [addBillTo, setAddBillTo] = React.useState<PersonTag[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // A fresh form every time it opens.
  React.useEffect(() => {
    if (!open) return;
    setForm({ title: "", statusId: "", furnitureOnSite: false, value: "", description: "", accessNotes: "", source: "" });
    setContact({ mode: "pick", id: "", name: "" });
    setCompany({ mode: "pick", id: "", name: "" });
    setSupervisor({ kind: "none" });
    setSite({ mode: "pick", id: "", label: "" });
    setPeople([]);
    setBillTo("main");
    setAddBillTo(null);
    setError(null);
  }, [open]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const companyIsNew = company.mode === "new";
  const pickedCompanyId = company.mode === "pick" && company.id ? Number(company.id) : null;
  const hasCompany = companyIsNew || !!pickedCompanyId;
  const companyName = company.mode === "new" ? company.draft.name.trim() || "the new company" : company.name || null;
  const hasContact = contact.mode === "new" || !!contact.id;
  const contactLabel = contact.mode === "new" ? contactName(contact.draft) || "the new contact" : contact.name || "the contact";

  /** A different company means a different set of supervisors. */
  function changeCompany(next: CompanyChoice) {
    setCompany(next);
    setSupervisor({ kind: "none" });
    if (billTo === "company" || billTo === "sup") setBillTo("main");
  }

  const billOptions: Array<[BillTo, string]> = [
    ...(hasContact ? ([["main", `${contactLabel} (the contact)`]] as Array<[BillTo, string]>) : []),
    ...(hasCompany ? ([["company", `${companyName} (the company)`]] as Array<[BillTo, string]>) : []),
    ...(supervisor.kind !== "none" ? ([["sup", `${supervisorChoiceName(supervisor) || "The supervisor"} (supervisor)`]] as Array<[BillTo, string]>) : []),
    ...people.map((p) => [draftId(p), p.name] as [BillTo, string]),
  ];
  // Whoever was billed was taken off the form: fall back to the first one left.
  const billValue = billOptions.some(([v]) => v === billTo) ? billTo : (billOptions[0]?.[0] ?? "");

  /** Plain-English reason the job cannot be made yet, or null. */
  function problem(): string | null {
    if (!hasContact && !hasCompany) return "Pick or add who the job is for: a contact, a company, or both.";
    if (contact.mode === "new") {
      const p = contactProblem(contact.draft, { who: "the new contact" });
      if (p) return p;
    }
    if (company.mode === "new" && !company.draft.name.trim()) return "Type a name for the new company.";
    if (supervisor.kind === "new") {
      const p = contactProblem(supervisor.draft, { mobileRequired: true, who: "the new supervisor" });
      if (p) return p;
    }
    if (site.mode === "new" && !site.draft.address.trim()) return "Type the street address for the new site, or pick an existing site.";
    if (!form.source) return "Pick where the job came from. Unknown is fine.";
    return null;
  }

  async function submit() {
    setError(null);
    const p = problem();
    if (p) return setError(p);

    const newContacts: ReturnType<typeof contactPayload>[] = [];
    // A new contact came in the same way the job did.
    if (contact.mode === "new") {
      newContacts.push({ ...contactPayload(contact.draft), source: form.source, atCompany: hasCompany && contact.draft.atCompany });
    }
    if (supervisor.kind === "new") newContacts.push({ ...contactPayload(supervisor.draft), atCompany: true, companyRole: "supervisor" });
    for (const person of people) {
      if (person.newContact) newContacts.push({ ...contactPayload(person.newContact), atCompany: hasCompany && person.newContact.atCompany });
    }

    // Who gets the invoice, as an id or a new person's key.
    let billToContactId: number | null = null;
    let billToContactKey: string | null = null;
    if (billValue === "main") {
      if (contact.mode === "new") billToContactKey = contact.draft.key;
      else if (contact.id) billToContactId = Number(contact.id);
    } else if (billValue === "sup") {
      if (supervisor.kind === "new") billToContactKey = supervisor.draft.key;
      else if (supervisor.kind === "pick") billToContactId = supervisor.contactId;
    } else if (billValue !== "company") {
      const person = people.find((x) => draftId(x) === billValue);
      if (person?.contactKey) billToContactKey = person.contactKey;
      else if (person) billToContactId = person.contactId;
    }

    try {
      await create.mutateAsync({
        title: form.title,
        statusId: form.statusId ? Number(form.statusId) : null,
        contactId: contact.mode === "pick" && contact.id ? Number(contact.id) : null,
        contactKey: contact.mode === "new" ? contact.draft.key : null,
        companyId: pickedCompanyId,
        newCompany: company.mode === "new" ? companyPayload(company.draft) : null,
        siteId: site.mode === "pick" && site.id ? Number(site.id) : null,
        newSite: site.mode === "new" ? sitePayload(site.draft) : null,
        supervisorContactId: supervisor.kind === "pick" ? supervisor.contactId : null,
        supervisorKey: supervisor.kind === "new" ? supervisor.draft.key : null,
        fileSupervisor: supervisor.kind === "pick" && supervisor.fileUnder,
        billToType: billValue === "company" ? "company" : "contact",
        billToContactId,
        billToContactKey,
        billToCompanyId: billValue === "company" ? pickedCompanyId : null,
        newContacts,
        people: jobDraftsToInput(people),
        furnitureOnSite: form.furnitureOnSite,
        value: form.value ? Number(form.value) : 0,
        description: form.description || null,
        accessNotes: form.accessNotes || null,
        source: form.source,
      });
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }

  const linkBtn = "inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline";
  const panel = "space-y-2 rounded-lg border border-border bg-secondary/40 p-3";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New job"
      subtitle="Pick people and places from Ops, or type new ones in. Nothing is saved until Create job."
      width="max-w-2xl"
      footer={
        <>
          {error ? (
            <p role="alert" className="mr-auto self-center text-sm text-destructive">
              {error}
            </p>
          ) : null}
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
          <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Carpet through 3 bed + hall" />
        </Field>

        {/* ---- contact ---- */}
        <div className="sm:col-span-2">
          {contact.mode === "pick" ? (
            <Field label="Contact (the person)">
              <div className="space-y-1.5">
                <ContactPicker
                  value={contact.id}
                  selectedLabel={contact.name}
                  onChange={(v) => setContact((c) => ({ mode: "pick", id: v, name: c.mode === "pick" && v ? c.name : "" }))}
                  onPicked={(name) => setContact((c) => (c.mode === "pick" ? { ...c, name } : c))}
                  emptyLabel="None"
                />
                <button type="button" className={linkBtn} onClick={() => setContact({ mode: "new", draft: blankContact() })}>
                  <UserPlus className="size-3.5" /> New contact
                </button>
              </div>
            </Field>
          ) : (
            <div className={panel}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold">New contact</p>
                <button type="button" className="text-[13px] font-medium text-primary hover:underline" onClick={() => setContact({ mode: "pick", id: "", name: "" })}>
                  Pick from Ops instead
                </button>
              </div>
              <NewContactFields
                value={contact.draft}
                onChange={(draft) => setContact({ mode: "new", draft })}
                companyName={hasCompany ? companyName : null}
                onUseExisting={(m) => setContact({ mode: "pick", id: String(m.id), name: m.name || "Contact" })}
              />
            </div>
          )}
        </div>

        {/* ---- company ---- */}
        <div className="sm:col-span-2">
          {company.mode === "pick" ? (
            <Field label="Company (optional)">
              <div className="space-y-1.5">
                <Combobox
                  value={company.id}
                  onChange={(v) => changeCompany({ mode: "pick", id: v, name: (companies.data ?? []).find((c) => String(c.id) === v)?.name ?? "" })}
                  placeholder="Search companies…"
                  emptyLabel="None, private customer"
                  options={(companies.data ?? []).map((c) => ({ value: String(c.id), label: c.name }))}
                />
                <button type="button" className={linkBtn} onClick={() => changeCompany({ mode: "new", draft: blankCompany() })}>
                  <Building2 className="size-3.5" /> New company
                </button>
              </div>
            </Field>
          ) : (
            <div className={panel}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold">New company</p>
                <button
                  type="button"
                  className="text-[13px] font-medium text-primary hover:underline"
                  onClick={() => changeCompany({ mode: "pick", id: "", name: "" })}
                >
                  Pick from Ops instead
                </button>
              </div>
              <NewCompanyFields
                value={company.draft}
                onChange={(draft) => setCompany({ mode: "new", draft })}
                onUseExisting={(m) => changeCompany({ mode: "pick", id: String(m.id), name: m.name })}
              />
            </div>
          )}
        </div>

        {/* ---- supervisor ---- */}
        <div className="sm:col-span-2">
          <SupervisorDraftPicker companyId={pickedCompanyId} companyIsNew={companyIsNew} value={supervisor} onChange={setSupervisor} />
        </div>

        {/* ---- site ---- */}
        <div className="sm:col-span-2">
          {site.mode === "pick" ? (
            <Field label="Site">
              <div className="space-y-1.5">
                <SitePicker
                  value={site.id}
                  label={site.label}
                  contactId={contact.mode === "pick" && contact.id ? Number(contact.id) : null}
                  onChange={(id, label) => setSite({ mode: "pick", id, label })}
                />
                <button type="button" className={linkBtn} onClick={() => setSite({ mode: "new", draft: blankSite() })}>
                  <MapPin className="size-3.5" /> New address
                </button>
              </div>
            </Field>
          ) : (
            <div className={panel}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-semibold">New site</p>
                <button
                  type="button"
                  className="text-[13px] font-medium text-primary hover:underline"
                  onClick={() => setSite({ mode: "pick", id: "", label: "" })}
                >
                  Pick from Ops instead
                </button>
              </div>
              <NewSiteFields
                value={site.draft}
                onChange={(draft) => setSite({ mode: "new", draft })}
                onUseExisting={(s) => setSite({ mode: "pick", id: String(s.id), label: s.label })}
              />
            </div>
          )}
        </div>

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
        <Field label="Where it came from (required)">
          <Select id="newjob_source" value={form.source} onChange={(e) => set("source", e.target.value)} aria-invalid={!form.source && !!error}>
            <option value="" disabled>
              Pick one…
            </option>
            {LEAD_SOURCES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who gets the invoice" hint="Carol's own house bills Carol. Her builder job bills the company.">
          <Select
            id="newjob_billto"
            value={billValue}
            onChange={(e) => {
              if (e.target.value === "__new") setAddBillTo(["accounts"]);
              else setBillTo(e.target.value);
            }}
          >
            {billOptions.length ? null : <option value="">Pick a contact or company first</option>}
            {billOptions.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            <option value="__new">Someone else (add them)…</option>
          </Select>
        </Field>
        <Field label="Job value (ex GST)">
          <Input type="number" inputMode="decimal" value={form.value} onChange={(e) => set("value", e.target.value)} placeholder="0" />
        </Field>
        <label htmlFor="jobs_cb1" className="flex items-center gap-2 pb-2 text-sm sm:col-span-2">
          <Checkbox id="jobs_cb1" checked={form.furnitureOnSite} onChange={(e) => set("furnitureOnSite", e.target.checked)} />
          Furniture on site (forces a 2-man crew)
        </label>
        <Field label="Job notes" className="sm:col-span-2">
          <Textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="What's happening on this job" />
        </Field>
        <Field label="Access notes" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={form.accessNotes}
            onChange={(e) => set("accessNotes", e.target.value)}
            placeholder="Gate code, parking, dog on site, lift booking…"
          />
        </Field>
        <div className="sm:col-span-2">
          <QuotePeopleDraft
            value={people}
            onChange={setPeople}
            deferNew
            company={hasCompany ? { id: pickedCompanyId, name: companyName ?? "" } : null}
            addTags={addBillTo}
            onAddClosed={(added) => {
              if (addBillTo && added) setBillTo(draftId(added));
              setAddBillTo(null);
            }}
            hint="Owner, tenant, agent, accounts. Tick Site access for anyone the crew should see."
          />
        </div>
      </div>
    </Modal>
  );
}
