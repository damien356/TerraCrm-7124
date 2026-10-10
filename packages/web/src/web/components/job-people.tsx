import * as React from "react";
import { Link } from "wouter";
import { AlertTriangle, Check, PencilLine, Plus, Trash2, UserPlus, X } from "lucide-react";
import { Card, CardHeader, Empty, Spinner } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Field, Input } from "./ui/field";
import { Modal } from "./ui/modal";
import { ContactPicker } from "./contact-picker";
import { NewContactFields, blankContact, contactName, contactPayload, contactProblem, type NewContactDraft } from "./new-records";
import { useCreateContact } from "../queries/contacts";
import { PERSON_TAGS, PERSON_TAG_SHORT, type PersonTag } from "../../api/lib/person-tags";
import {
  useJobPersonAdd,
  useJobPersonRemove,
  useJobPersonUpdate,
  useQuotePeople,
  useQuotePersonAdd,
  useQuotePersonRemove,
  useQuotePersonUpdate,
} from "../queries/people";

/**
 * PEOPLE ON A JOB OR QUOTE.
 *
 * One card per person; the tags, the ticks (Show to Crew, Decision-maker,
 * Site access) and the note belong to this job. Crew only ever sees people
 * ticked Show to Crew. Supervisor is picked in its own box (one per job, from the billed
 * company), so here it shows as a fixed chip and is never toggled.
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

/** Tags anyone can toggle here. Supervisor has its own box. */
const PICKABLE: PersonTag[] = PERSON_TAGS.filter((t) => t !== "supervisor");

export interface PersonDraft {
  /** 0 for a new person who is only saved with the job (see `newContact`). */
  contactId: number;
  /** A new person's handle until they have an id. Set with `newContact`. */
  contactKey?: string;
  /** A person typed in on the New job screen, saved when the job is made. */
  newContact?: NewContactDraft;
  name: string;
  tags: PersonTag[];
  canApproveQuote: boolean;
  onSiteContact: boolean;
  receivesSms: boolean;
  receivesEmail: boolean;
  showToCrew: boolean;
  whenToContact: string;
}

const blankDraft = (): Omit<PersonDraft, "contactId" | "name"> => ({
  tags: [],
  canApproveQuote: false,
  onSiteContact: false,
  receivesSms: false,
  receivesEmail: false,
  showToCrew: false,
  whenToContact: "",
});

export function TagChips({
  value,
  onChange,
  fixed = [],
  disabled,
}: {
  value: PersonTag[];
  onChange: (next: PersonTag[]) => void;
  /** Shown as held but not toggleable (Supervisor). */
  fixed?: PersonTag[];
  disabled?: boolean;
}) {
  const toggle = (t: PersonTag) =>
    onChange(value.includes(t) ? value.filter((x) => x !== t) : PERSON_TAGS.filter((x) => x === t || value.includes(x)));
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Tags on this job</legend>
      {fixed.map((t) => (
        <span
          key={t}
          title="Change the supervisor in the Supervisor box"
          className="inline-flex items-center gap-1 rounded-full bg-[var(--sidebar)] px-2.5 py-1 text-xs font-semibold text-white"
        >
          {PERSON_TAG_SHORT[t]}
        </span>
      ))}
      {PICKABLE.map((t) => {
        const on = value.includes(t);
        return (
          <button
            key={t}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(t)}
            className={
              on
                ? "inline-flex items-center gap-1 rounded-full border border-[var(--gold)] bg-[var(--gold)] px-2.5 py-1 text-xs font-semibold text-[var(--sidebar)]"
                : "inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
            }
          >
            {on ? <Check className="size-3" /> : null}
            {PERSON_TAG_SHORT[t]}
          </button>
        );
      })}
    </fieldset>
  );
}

const TICKS = [
  ["showToCrew", "Show to Crew", "Crew sees this person's name, number, tags and note on this job"],
  ["canApproveQuote", "Decision-maker", "Approves colour, product and sign-off"],
  ["onSiteContact", "Site access", "Crew rings this person to get in. Also ticks Show to Crew"],
] as const;
const COMMS = [
  ["receivesSms", "SMS updates"],
  ["receivesEmail", "Emails"],
] as const;

type Flags = Pick<PersonDraft, "canApproveQuote" | "onSiteContact" | "receivesSms" | "receivesEmail" | "showToCrew">;

/** The ticks as one line of text, for locked rows and draft lists. */
const flagText = (f: Pick<Flags, "showToCrew" | "canApproveQuote" | "onSiteContact">) =>
  [f.showToCrew ? "Shown to Crew" : null, f.canApproveQuote ? "Decision-maker" : null, f.onSiteContact ? "Site access" : null].filter(Boolean);

function FlagBoxes({ value, onChange: emit, idPrefix, compact }: { value: Flags; onChange: (patch: Partial<Flags>) => void; idPrefix: string; compact?: boolean }) {
  // Site access means crew rings them, so it brings Show to Crew with it.
  const onChange = (k: keyof Flags, v: boolean) =>
    emit(k === "onSiteContact" && v && !value.showToCrew ? { onSiteContact: true, showToCrew: true } : { [k]: v });
  return (
    <div className={compact ? "flex flex-wrap gap-x-4 gap-y-1.5" : "grid gap-2 sm:grid-cols-2"}>
      {TICKS.map(([key, label, hint]) => (
        <label key={key} htmlFor={`${idPrefix}_${key}`} className="flex items-start gap-2 text-sm" title={hint}>
          <Checkbox id={`${idPrefix}_${key}`} className="mt-0.5" checked={value[key]} onChange={(e) => onChange(key, e.target.checked)} />
          <span>
            <span className="font-medium">{label}</span>
            {compact ? null : <span className="block text-xs text-muted-foreground">{hint}</span>}
          </span>
        </label>
      ))}
      {COMMS.map(([key, label]) => (
        <label key={key} htmlFor={`${idPrefix}_${key}`} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox id={`${idPrefix}_${key}`} checked={value[key]} onChange={(e) => onChange(key, e.target.checked)} />
          {label}
        </label>
      ))}
    </div>
  );
}

/**
 * Pick a person, or type a new one, plus their tags, ticks and note, in one
 * step. Used by the job page, the quote builder, New quote and New job.
 *
 * A new person is a normal full Clients card. With `deferNew` (New job) the
 * card is only held in the form and saved with the job, so Cancel leaves
 * nothing behind. Otherwise it is saved when Add is pressed.
 */
export function AddPersonModal({
  open,
  onClose,
  onAdd,
  title = "Add job contact",
  pending,
  deferNew = false,
  company = null,
  initialTags = [],
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (draft: PersonDraft) => Promise<void> | void;
  title?: string;
  pending?: boolean;
  deferNew?: boolean;
  /** The job's company. A new person can be filed there. `id` is null while the company is new too. */
  company?: { id: number | null; name: string } | null;
  /** Tags already ticked when it opens, e.g. Accounts for "who gets the invoice". */
  initialTags?: PersonTag[];
}) {
  const createContact = useCreateContact();
  const [mode, setMode] = React.useState<"pick" | "new">("pick");
  const [contactId, setContactId] = React.useState("");
  const [name, setName] = React.useState("");
  const [person, setPerson] = React.useState<NewContactDraft>(() => blankContact());
  const [draft, setDraft] = React.useState(blankDraft);
  const [error, setError] = React.useState<string | null>(null);
  const tagKey = initialTags.join(",");

  React.useEffect(() => {
    if (open) {
      setMode("pick");
      setContactId("");
      setName("");
      setPerson(blankContact());
      setDraft({ ...blankDraft(), tags: tagKey ? (tagKey.split(",") as PersonTag[]) : [] });
      setError(null);
    }
  }, [open, tagKey]);

  async function submit() {
    setError(null);
    if (mode === "pick" && !contactId) return setError("Pick the person, or press New person to type them in.");
    if (mode === "new") {
      const problem = contactProblem(person);
      if (problem) return setError(problem);
    }
    if (draft.tags.length === 0) return setError("Pick at least one tag, so we know who they are on this job.");
    const base = { ...draft, whenToContact: draft.whenToContact.trim() };
    try {
      if (mode === "pick") {
        await onAdd({ ...base, contactId: Number(contactId), name: name || "Contact" });
      } else if (deferNew) {
        await onAdd({ ...base, contactId: 0, contactKey: person.key, newContact: person, name: contactName(person) });
      } else {
        const p = contactPayload(person);
        const atCo = !!(person.atCompany && company?.id);
        const created = await createContact.mutateAsync({
          firstName: p.firstName,
          lastName: p.lastName,
          mobile: p.mobile,
          phone: p.phone,
          email: p.email,
          address: p.address,
          suburb: p.suburb,
          postcode: p.postcode,
          notes: p.notes,
          source: p.source,
          marketingOptIn: p.marketingOptIn,
          companyId: atCo ? company!.id : null,
          companyRole: atCo ? p.companyRole : "other",
        });
        if (!created) throw new Error("The new person could not be saved. Try again.");
        // From here a retry re-uses this card instead of making a second one.
        setMode("pick");
        setContactId(String(created.id));
        setName(contactName(person));
        await onAdd({ ...base, contactId: created.id, name: contactName(person) });
      }
      onClose();
    } catch (e) {
      setError(errText(e));
    }
  }

  const busy = pending || createContact.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle="Tags are for this job only. The same person can be Owner here and Property manager on the next job."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Spinner className="border-white/40 border-t-white" /> : null}
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {mode === "pick" ? (
          <Field label="Person">
            <div className="space-y-1.5">
              <ContactPicker value={contactId} onChange={setContactId} onPicked={setName} selectedLabel={name} emptyLabel="Pick a contact" />
              <button
                type="button"
                onClick={() => {
                  setMode("new");
                  setError(null);
                }}
                className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
              >
                <UserPlus className="size-3.5" /> Not in Ops yet? New person
              </button>
            </div>
          </Field>
        ) : (
          <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] font-semibold">New person</p>
              <button type="button" onClick={() => setMode("pick")} className="text-[13px] font-medium text-primary hover:underline">
                Pick from Ops instead
              </button>
            </div>
            <NewContactFields
              value={person}
              onChange={setPerson}
              companyName={company?.name ?? null}
              onUseExisting={(m) => {
                setMode("pick");
                setContactId(String(m.id));
                setName(m.name || "Contact");
              }}
            />
            <p className="text-xs text-muted-foreground">
              {deferNew ? "Saved as a normal client card when the job is made." : "Saved as a normal client card when you press Add."}
            </p>
          </div>
        )}
        <Field label="Who are they on this job?">
          <TagChips
            value={draft.tags}
            // Tagging a tenant ticks Show to Crew: they are usually who lets crew in. Untick to hide them.
            onChange={(tags) =>
              setDraft((d) => ({ ...d, tags, showToCrew: d.showToCrew || (tags.includes("tenant") && !d.tags.includes("tenant")) }))
            }
          />
        </Field>
        <FlagBoxes value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} idPrefix="add_person" />
        <Field label="When to contact" hint="Crew sees this under the name when Show to Crew is ticked. For example: after 3pm, text first.">
          <Input value={draft.whenToContact} maxLength={200} onChange={(e) => setDraft((d) => ({ ...d, whenToContact: e.target.value }))} />
        </Field>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ rows */

interface Row {
  id: number;
  contactId: number;
  name: string;
  mobile: string | null;
  tags: PersonTag[];
  flags: Flags;
  whenToContact: string | null;
  actedForCompanyName: string | null;
  isPrimary?: boolean;
}

function PersonRow({
  row,
  onSave,
  onRemove,
  canRemove,
  locked,
}: {
  row: Row;
  onSave: (patch: Partial<Flags> & { tags?: PersonTag[]; whenToContact?: string | null }) => Promise<unknown>;
  onRemove: () => void;
  canRemove: boolean;
  locked?: boolean;
}) {
  const fixed = row.tags.filter((t) => t === "supervisor");
  const own = row.tags.filter((t) => t !== "supervisor");
  const [editing, setEditing] = React.useState(false);
  const [tags, setTags] = React.useState(own);
  const [note, setNote] = React.useState(row.whenToContact ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!editing) {
      setTags(row.tags.filter((t) => t !== "supervisor"));
      setNote(row.whenToContact ?? "");
    }
  }, [row.tags, row.whenToContact, editing]);

  async function save() {
    setError(null);
    const all = [...fixed, ...tags];
    if (all.length === 0) return setError("Keep at least one tag, or remove them from the job.");
    setBusy(true);
    try {
      await onSave({ tags: all, whenToContact: note.trim() || null });
      setEditing(false);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function flag(patch: Partial<Flags>) {
    setError(null);
    try {
      await onSave(patch);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/clients/${row.contactId}`} className="text-sm font-medium text-primary hover:underline">
            {row.name}
          </Link>
          <p className="text-xs text-muted-foreground">
            {[row.mobile, row.actedForCompanyName ? `for ${row.actedForCompanyName}` : null].filter(Boolean).join(" · ") || "No mobile on the card"}
          </p>
        </div>
        {locked ? null : (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              aria-label={editing ? "Stop editing" : "Edit tags and note"}
              onClick={() => setEditing((e) => !e)}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {editing ? <X className="size-3.5" /> : <PencilLine className="size-3.5" />}
            </button>
            {canRemove ? (
              <button type="button" aria-label="Remove from this job" onClick={onRemove} className="text-muted-foreground transition-colors hover:text-destructive">
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-2.5 space-y-2.5">
          <TagChips value={tags} onChange={(next) => setTags(next.filter((t) => t !== "supervisor"))} fixed={fixed} />
          <Input value={note} maxLength={200} placeholder="When to contact, e.g. after 3pm" onChange={(e) => setNote(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? <Spinner className="border-white/40 border-t-white" /> : null}
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {row.tags.length ? (
              row.tags.map((t) => (
                <span
                  key={t}
                  className={
                    t === "supervisor"
                      ? "rounded-full bg-[var(--sidebar)] px-2 py-0.5 text-[11px] font-semibold text-white"
                      : "rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium"
                  }
                >
                  {PERSON_TAG_SHORT[t]}
                </span>
              ))
            ) : (
              <span className="rounded-full border border-[var(--warning)]/50 bg-[var(--warning)]/10 px-2 py-0.5 text-[11px] font-medium">Not tagged</span>
            )}
          </div>
          {row.whenToContact ? <p className="mt-1.5 text-xs">{row.whenToContact}</p> : null}
        </>
      )}

      <div className="mt-2">
        {locked ? (
          <p className="text-xs text-muted-foreground">
            {flagText(row.flags).join(" · ")}
          </p>
        ) : (
          <FlagBoxes value={row.flags} onChange={flag} idPrefix={`p${row.id}`} compact />
        )}
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

/* ------------------------------------------------------------- job card */

export interface JobPersonLink {
  id: number;
  contactId: number;
  tags: PersonTag[];
  isPrimary: boolean;
  onSiteContact: boolean;
  canApproveQuote: boolean;
  receivesSms: boolean;
  receivesEmail: boolean;
  showToCrew: boolean;
  whenToContact: string | null;
}

export function JobPeopleCard({
  jobId,
  people,
  needsPeopleTagged,
  canRemove,
  company = null,
  subtitle = "Tags, ticks and the note are for this job only.",
}: {
  jobId: number;
  subtitle?: string;
  /** The job's company. A new person typed in can be filed there. */
  company?: { id: number; name: string } | null;
  people: Array<{ link: JobPersonLink; contact: { id: number; firstName: string; lastName: string; mobile: string | null }; actedForCompanyName: string | null }>;
  needsPeopleTagged: boolean;
  canRemove: boolean;
}) {
  const add = useJobPersonAdd();
  const update = useJobPersonUpdate();
  const remove = useJobPersonRemove();
  const [open, setOpen] = React.useState(false);
  const noCrewContact = people.length > 0 && !people.some((p) => p.link.showToCrew);

  const rows: Row[] = people.map(({ link, contact, actedForCompanyName }) => ({
    id: link.id,
    contactId: contact.id,
    name: `${contact.firstName} ${contact.lastName}`.trim(),
    mobile: contact.mobile,
    tags: link.tags,
    flags: { canApproveQuote: link.canApproveQuote, onSiteContact: link.onSiteContact, receivesSms: link.receivesSms, receivesEmail: link.receivesEmail, showToCrew: link.showToCrew },
    whenToContact: link.whenToContact,
    actedForCompanyName,
    isPrimary: link.isPrimary,
  }));

  return (
    <Card>
      <CardHeader
        title="People on this job"
        subtitle={subtitle}
        action={
          <Button variant="secondary" onClick={() => setOpen(true)}>
            <Plus className="size-3.5" />
            Add
          </Button>
        }
      />
      {needsPeopleTagged ? (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Nobody is tagged on this job yet.</p>
            <p className="text-xs text-muted-foreground">Add the owner, tenant or agent and tick Show to Crew, so Crew knows who to ring.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={() => setOpen(true)}>
              <UserPlus className="size-3.5" />
              Tag people
            </Button>
          </div>
        </div>
      ) : noCrewContact ? (
        <p className="mx-4 mt-3 rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          Crew sees nobody on this job. Tick Show to Crew on whoever they should ring.
        </p>
      ) : null}
      {rows.length === 0 ? (
        needsPeopleTagged ? <div className="h-3" /> : <Empty>Nobody linked yet.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <PersonRow
              key={r.id}
              row={r}
              canRemove={canRemove && !r.tags.includes("supervisor")}
              onSave={(patch) => update.mutateAsync({ id: r.id, ...patch })}
              onRemove={() => remove.mutate({ id: r.id })}
            />
          ))}
        </ul>
      )}
      <AddPersonModal
        open={open}
        onClose={() => setOpen(false)}
        pending={add.isPending}
        company={company}
        onAdd={async (d) => {
          await add.mutateAsync({
            jobId,
            contactId: d.contactId,
            tags: d.tags,
            canApproveQuote: d.canApproveQuote,
            onSiteContact: d.onSiteContact,
            receivesSms: d.receivesSms,
            receivesEmail: d.receivesEmail,
            showToCrew: d.showToCrew,
            whenToContact: d.whenToContact || null,
          });
        }}
      />
    </Card>
  );
}

/* ------------------------------------------------------------ quote side */

/** New quote screen: people held in the form until the quote is saved. */
export function QuotePeopleDraft({
  value,
  onChange,
  hint = "Owner, tenant, agent, accounts. They move onto the job when it is accepted.",
  deferNew = false,
  company = null,
  addTags,
  onAddClosed,
}: {
  value: PersonDraft[];
  onChange: (next: PersonDraft[]) => void;
  hint?: string;
  /** New people stay in the form and are saved with it (New job). */
  deferNew?: boolean;
  company?: { id: number | null; name: string } | null;
  /** Opens the Add popup from outside with these tags ticked (Who gets the invoice). */
  addTags?: PersonTag[] | null;
  onAddClosed?: (added: PersonDraft | null) => void;
}) {
  const [ownOpen, setOpen] = React.useState(false);
  const open = ownOpen || !!addTags;
  const added = React.useRef<PersonDraft | null>(null);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div>
          <p className="text-sm font-medium">Job contacts</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <Plus className="size-3.5" />
          Add job contact
        </Button>
      </div>
      {value.length ? (
        <ul className="divide-y divide-border border-t border-border">
          {value.map((p) => (
            <li key={draftId(p)} className="flex items-start justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium">
                  {p.name}
                  {p.newContact ? <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold">New</span> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    p.tags.map((t) => PERSON_TAG_SHORT[t]).join(", "),
                    ...flagText(p),
                    p.whenToContact || null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                aria-label={`Take ${p.name} off`}
                onClick={() => onChange(value.filter((x) => draftId(x) !== draftId(p)))}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <AddPersonModal
        open={open}
        deferNew={deferNew}
        company={company}
        initialTags={addTags ?? []}
        onClose={() => {
          setOpen(false);
          onAddClosed?.(added.current);
          added.current = null;
        }}
        onAdd={(d) => {
          added.current = d;
          const others = value.filter((x) => draftId(x) !== draftId(d));
          const had = value.find((x) => draftId(x) === draftId(d));
          const merged = had
            ? {
                ...d,
                tags: PERSON_TAGS.filter((t) => had.tags.includes(t) || d.tags.includes(t)),
                canApproveQuote: had.canApproveQuote || d.canApproveQuote,
                onSiteContact: had.onSiteContact || d.onSiteContact,
                receivesSms: had.receivesSms || d.receivesSms,
                receivesEmail: had.receivesEmail || d.receivesEmail,
                showToCrew: had.showToCrew || d.showToCrew,
                whenToContact: d.whenToContact || had.whenToContact,
              }
            : d;
          onChange([...others, merged]);
        }}
      />
    </div>
  );
}

/** Quote builder: people saved on the quote. Locked once the quote is accepted. */
export function QuotePeopleCard({ quoteId, locked }: { quoteId: number; locked: boolean }) {
  const list = useQuotePeople(quoteId);
  const add = useQuotePersonAdd();
  const update = useQuotePersonUpdate();
  const remove = useQuotePersonRemove();
  const [open, setOpen] = React.useState(false);
  const rows: Row[] = (list.data ?? []).map((p) => ({
    id: p.id,
    contactId: p.contactId,
    name: `${p.contact.firstName} ${p.contact.lastName}`.trim(),
    mobile: p.contact.mobile,
    tags: p.tags,
    flags: { canApproveQuote: p.canApproveQuote, onSiteContact: p.onSiteContact, receivesSms: p.receivesSms, receivesEmail: p.receivesEmail, showToCrew: p.showToCrew },
    whenToContact: p.whenToContact,
    actedForCompanyName: p.actedForCompanyName,
  }));
  return (
    <Card>
      <CardHeader
        title="Job contacts"
        subtitle={locked ? "Carried onto the job." : "Beyond the customer and supervisor. They move onto the job when it is accepted."}
        action={
          locked ? null : (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" />
              Add
            </Button>
          )
        }
      />
      {list.isLoading ? (
        <div className="flex justify-center py-4">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">Nobody else yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => (
            <PersonRow
              key={r.id}
              row={r}
              locked={locked}
              canRemove
              onSave={(patch) => update.mutateAsync({ id: r.id, ...patch })}
              onRemove={() => remove.mutate({ id: r.id })}
            />
          ))}
        </ul>
      )}
      <AddPersonModal
        open={open}
        onClose={() => setOpen(false)}
        pending={add.isPending}
        onAdd={async (d) => {
          await add.mutateAsync({
            quoteId,
            contactId: d.contactId,
            tags: d.tags,
            canApproveQuote: d.canApproveQuote,
            onSiteContact: d.onSiteContact,
            receivesSms: d.receivesSms,
            receivesEmail: d.receivesEmail,
            showToCrew: d.showToCrew,
            whenToContact: d.whenToContact || null,
          });
        }}
      />
    </Card>
  );
}

/** One draft row: a new person by key, else the card id. */
export const draftId = (p: Pick<PersonDraft, "contactId" | "contactKey">) => (p.contactKey ? `k:${p.contactKey}` : `c:${p.contactId}`);

/** New job: existing cards go by id, new people by key (their card travels in newContacts). */
export const jobDraftsToInput = (list: PersonDraft[]) =>
  list.map((p) => ({
    ...(p.contactKey ? { contactKey: p.contactKey } : { contactId: p.contactId }),
    tags: p.tags,
    canApproveQuote: p.canApproveQuote,
    onSiteContact: p.onSiteContact,
    receivesSms: p.receivesSms,
    receivesEmail: p.receivesEmail,
    showToCrew: p.showToCrew,
    whenToContact: p.whenToContact || null,
  }));

/** Draft list to the API shape (New quote). */
export const draftsToInput = (list: PersonDraft[]) =>
  list.map((p) => ({
    contactId: p.contactId,
    tags: p.tags,
    canApproveQuote: p.canApproveQuote,
    onSiteContact: p.onSiteContact,
    receivesSms: p.receivesSms,
    receivesEmail: p.receivesEmail,
    showToCrew: p.showToCrew,
    whenToContact: p.whenToContact || null,
  }));
