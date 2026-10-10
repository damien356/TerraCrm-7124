import * as React from "react";
import { UserPlus } from "lucide-react";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Combobox } from "./ui/combobox";
import { Spinner } from "./ui/card";
import { useCompanyPeople } from "../queries/companies";
import { useCreateContact } from "../queries/contacts";
import { useMutation } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { type ContactMatch } from "./contact-matches";
import { NewContactFields, blankContact, contactName, contactPayload, contactProblem, type NewContactDraft } from "./new-records";

/**
 * SUPERVISOR PICKER.
 *
 * The one place the supervisor on a job gets chosen. The list is the people
 * already filed under that company at a role that could have sent the work,
 * so it never offers someone from a different builder.
 *
 * A supervisor is not a column on the job. It is a normal `job_contacts` row
 * at role 'supervisor', so whoever is picked here reads back through the same
 * link every other person on a job uses. This component only reports the
 * contact id, the caller decides when to write it.
 *
 * New names get added right here rather than sending someone off to the
 * contacts page and losing the job they were filling in. The person is created
 * once and filed under the company as a supervisor in the same step.
 */

/** Roles at a company that plausibly sent the work. */
const SENDER_ROLES = ["supervisor", "manager", "owner", "purchasing"];

export function SupervisorPicker({
  companyId,
  value,
  onChange,
  disabledReason,
  required = false,
}: {
  companyId: number | null;
  /** Contact id as a string, or "" for nobody. */
  value: string;
  onChange: (contactId: string) => void;
  disabledReason?: string;
  /** True when the work cannot be saved without a supervisor. */
  required?: boolean;
}) {
  const people = useCompanyPeople(companyId, SENDER_ROLES);
  const createContact = useCreateContact();
  const link = useMutation(orpc.contacts.linkCompany.mutationOptions());

  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState<NewContactDraft>(() => blankContact({ source: "builder" }));
  const [error, setError] = React.useState<string | null>(null);

  // Picking a different company invalidates whoever was chosen.
  React.useEffect(() => {
    setAdding(false);
    setError(null);
  }, [companyId]);

  const options = (people.data ?? []).map((p) => ({
    value: String(p.contactId),
    label: p.name,
    sublabel: p.jobTitle ?? p.role.replace(/_/g, " "),
  }));

  const reset = () => {
    setDraft(blankContact({ source: "builder" }));
    setAdding(false);
  };

  async function saveNew() {
    setError(null);
    if (!companyId) return;
    const problem = contactProblem(draft, { mobileRequired: true, who: "the supervisor" });
    if (problem) return setError(problem);
    const p = contactPayload(draft);
    try {
      const created = await createContact.mutateAsync({
        firstName: p.firstName,
        lastName: p.lastName,
        mobile: p.mobile,
        phone: p.phone,
        email: p.email,
        notes: p.notes,
        source: "builder",
        companyId,
        companyRole: "supervisor",
        companyJobTitle: p.jobTitle,
      });
      await people.refetch();
      if (created && "id" in created) onChange(String(created.id));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** The person is already in Ops: file them under this company as a supervisor and pick them. */
  async function pickExisting(m: ContactMatch) {
    setError(null);
    if (!companyId) return;
    try {
      await link.mutateAsync({ contactId: m.id, companyId, role: "supervisor" });
      await people.refetch();
      onChange(String(m.id));
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!companyId) {
    return (
      <Field label="Supervisor" hint={disabledReason ?? "Pick a company first, then their supervisor."}>
        <Combobox value="" onChange={() => {}} options={[]} disabled emptyLabel="No company on this job" />
      </Field>
    );
  }

  return (
    <Field
      label={required ? "Supervisor (required)" : "Supervisor (optional)"}
      hint="The person at the company who sent this work. Not in the list? Add them below."
    >
      <div className="space-y-2">
        <Combobox
          value={value}
          onChange={onChange}
          options={options}
          placeholder={people.isLoading ? "Loading…" : "Search their people…"}
          emptyLabel="Nobody recorded"
        />

        {adding ? (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
            <p className="text-[13px] font-semibold">Add a new supervisor</p>
            <NewContactFields
              variant="supervisor"
              value={draft}
              onChange={setDraft}
              onUseExisting={pickExisting}
              busyId={link.isPending ? (link.variables?.contactId ?? null) : null}
            />
            <p className="text-xs text-muted-foreground">
              They get saved as a supervisor at this company, so they are there next time too.
            </p>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            <div className="flex gap-2">
              <Button size="sm" onClick={saveNew} disabled={createContact.isPending}>
                {createContact.isPending ? <Spinner className="border-white/40 border-t-white" /> : null}
                Save and use
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
          >
            <UserPlus className="size-3.5" /> Add a new supervisor
          </button>
        )}
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------- New job */

/** Who the New job screen has as supervisor. Nothing is saved until Create job. */
export type SupervisorChoice =
  | { kind: "none" }
  /** An existing card. `fileUnder`: not yet filed under the company, file them there with the job. */
  | { kind: "pick"; contactId: number; name: string; fileUnder: boolean }
  | { kind: "new"; draft: NewContactDraft };

export const supervisorChoiceName = (c: SupervisorChoice) =>
  c.kind === "pick" ? c.name : c.kind === "new" ? contactName(c.draft) : "";

/**
 * The supervisor box on New job. Same choices as the job page, but a new
 * supervisor is only held in the form and made with the job, and it works
 * while the company itself is still new (nobody is filed under it yet).
 */
export function SupervisorDraftPicker({
  companyId,
  companyIsNew,
  value,
  onChange,
}: {
  /** The picked company, or null when there is none or it is new. */
  companyId: number | null;
  companyIsNew: boolean;
  value: SupervisorChoice;
  onChange: (next: SupervisorChoice) => void;
}) {
  const people = useCompanyPeople(companyId, SENDER_ROLES);
  const hasCompany = !!companyId || companyIsNew;

  if (!hasCompany) {
    return (
      <Field label="Supervisor" hint="Pick or add a company first, then their supervisor.">
        <Combobox value="" onChange={() => {}} options={[]} disabled emptyLabel="No company on this job" />
      </Field>
    );
  }

  const options = companyIsNew
    ? []
    : (people.data ?? []).map((p) => ({
        value: String(p.contactId),
        label: p.name,
        sublabel: p.jobTitle ?? p.role.replace(/_/g, " "),
      }));

  return (
    <Field
      label="Supervisor (optional)"
      hint="The person at the company who sent this work. Skip it and the job shows Supervisor missing until it is filled in."
    >
      <div className="space-y-2">
        {value.kind === "new" ? (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">New supervisor</p>
              <button type="button" onClick={() => onChange({ kind: "none" })} className="text-[13px] font-medium text-primary hover:underline">
                {companyIsNew ? "Skip for now" : "Pick from the list instead"}
              </button>
            </div>
            <NewContactFields
              variant="supervisor"
              value={value.draft}
              onChange={(draft) => onChange({ kind: "new", draft })}
              onUseExisting={(m) => {
                const filed = !companyIsNew && (people.data ?? []).some((p) => p.contactId === m.id && p.role === "supervisor");
                onChange({ kind: "pick", contactId: m.id, name: m.name || "Supervisor", fileUnder: !filed });
              }}
            />
            <p className="text-xs text-muted-foreground">Saved as a supervisor at this company when the job is made.</p>
          </div>
        ) : companyIsNew ? (
          value.kind === "pick" ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <span className="font-medium">{value.name}</span>
              <button type="button" onClick={() => onChange({ kind: "none" })} className="text-[13px] text-primary hover:underline">
                Change
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nobody is filed under a new company yet.</p>
          )
        ) : (
          <Combobox
            value={value.kind === "pick" ? String(value.contactId) : ""}
            onChange={(v) => {
              if (!v) return onChange({ kind: "none" });
              const p = (people.data ?? []).find((x) => String(x.contactId) === v);
              onChange({ kind: "pick", contactId: Number(v), name: p?.name ?? "Supervisor", fileUnder: false });
            }}
            options={options}
            placeholder={people.isLoading ? "Loading…" : "Search their people…"}
            emptyLabel="Nobody recorded"
          />
        )}
        {value.kind !== "new" ? (
          <button
            type="button"
            onClick={() => onChange({ kind: "new", draft: blankContact({ source: "builder", atCompany: true, companyRole: "supervisor" }) })}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
          >
            <UserPlus className="size-3.5" /> Add a new supervisor
          </button>
        ) : null}
      </div>
    </Field>
  );
}
