import * as React from "react";
import { UserPlus } from "lucide-react";
import { Button } from "./ui/button";
import { Field, Input } from "./ui/field";
import { Combobox } from "./ui/combobox";
import { Spinner } from "./ui/card";
import { useCompanyPeople } from "../queries/companies";
import { useCreateContact } from "../queries/contacts";
import { useMutation } from "@tanstack/react-query";
import { orpc } from "../lib/api";
import { ContactMatches, type ContactMatch } from "./contact-matches";

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
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [mobile, setMobile] = React.useState("");
  const [email, setEmail] = React.useState("");
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

  async function saveNew() {
    setError(null);
    if (!companyId) return;
    if (!firstName.trim()) {
      setError("A first name is needed.");
      return;
    }
    try {
      const created = await createContact.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        mobile: mobile.trim() || null,
        email: email.trim() || null,
        source: "builder",
        companyId,
        companyRole: "supervisor",
      });
      await people.refetch();
      if (created && "id" in created) onChange(String(created.id));
      setFirstName("");
      setLastName("");
      setMobile("");
      setEmail("");
      setAdding(false);
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
      setFirstName("");
      setLastName("");
      setMobile("");
      setEmail("");
      setAdding(false);
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
            <div className="grid gap-2 sm:grid-cols-2">
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" />
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" />
              <Input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Mobile" />
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
            </div>
            <ContactMatches
              input={{ firstName, lastName, mobile, email }}
              onUse={pickExisting}
              busyId={link.isPending ? (link.variables?.contactId ?? null) : null}
              useLabel="Use that card"
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
