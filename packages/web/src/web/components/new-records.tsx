import * as React from "react";
import { Building2, MapPin } from "lucide-react";
import { Button } from "./ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "./ui/field";
import { Spinner } from "./ui/card";
import { ContactMatches, type ContactMatch } from "./contact-matches";
import { useCompanyMatches } from "../queries/people";
import { usePlaceDetails, usePlaceSuggestions, usePlacesEnabled } from "../queries/places";
import { useSites } from "../queries/companies";
import { COMPANY_TYPES, COMPANY_TYPE_LABELS } from "../../api/lib/person-tags";

/**
 * NEW RECORDS, TYPED IN PLACE.
 *
 * The forms for a new contact, company and site that sit inside another
 * screen (New job, Add person) instead of sending the office off to another
 * page. Each one is the same full record the Clients, Companies and Sites
 * pages make. They only hold what was typed: the caller decides when it is
 * saved.
 *
 * Every one checks for an existing record while it is typed and offers that
 * first, so a person or company exists once.
 */

/* ------------------------------------------------------------- contacts */

export interface NewContactDraft {
  key: string;
  firstName: string;
  lastName: string;
  mobile: string;
  /** Office or landline. */
  phone: string;
  email: string;
  address: string;
  suburb: string;
  postcode: string;
  notes: string;
  source: string;
  marketingOptIn: boolean;
  /** Filed under the job's company at `companyRole`. */
  atCompany: boolean;
  companyRole: string;
  jobTitle: string;
}

let seq = 0;
/** A handle for a person who has no id yet. Unique within the page. */
export const newKey = () => `n${Date.now().toString(36)}${(seq++).toString(36)}`;

export const blankContact = (over: Partial<NewContactDraft> = {}): NewContactDraft => ({
  key: newKey(),
  firstName: "",
  lastName: "",
  mobile: "",
  phone: "",
  email: "",
  address: "",
  suburb: "",
  postcode: "",
  notes: "",
  source: "other",
  marketingOptIn: false,
  atCompany: false,
  companyRole: "other",
  jobTitle: "",
  ...over,
});

export const contactName = (c: Pick<NewContactDraft, "firstName" | "lastName">) => `${c.firstName} ${c.lastName}`.trim();

/** What the server's newContactInput takes. Blank text goes as null. */
export function contactPayload(c: NewContactDraft) {
  const n = (s: string) => (s.trim() ? s.trim() : null);
  return {
    key: c.key,
    firstName: c.firstName.trim(),
    lastName: c.lastName.trim(),
    mobile: n(c.mobile),
    phone: n(c.phone),
    email: n(c.email),
    address: n(c.address),
    suburb: n(c.suburb),
    postcode: n(c.postcode),
    notes: n(c.notes),
    source: c.source || "other",
    marketingOptIn: c.marketingOptIn,
    atCompany: c.atCompany,
    companyRole: c.companyRole || "other",
    jobTitle: n(c.jobTitle),
  };
}

/** Plain-English problem with a new person, or null when they can be saved. */
export function contactProblem(c: NewContactDraft, opts: { mobileRequired?: boolean; who?: string } = {}) {
  const who = opts.who ?? "the new person";
  if (!c.firstName.trim()) return `Type a first name for ${who}.`;
  if (opts.mobileRequired && c.mobile.replace(/\D/g, "").length < 8) return `Type a mobile for ${who}.`;
  return null;
}

const COMPANY_ROLES = ["owner", "manager", "supervisor", "accounts", "property_manager", "purchasing", "other"];
const roleLabel = (r: string) => {
  const s = r.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * A new person's card. `variant="supervisor"` asks for what Damien wants on a
 * supervisor (name and mobile required; email, office phone, job title and
 * notes optional) and is always filed under the company. Otherwise the full
 * Clients card, with an optional "works at the company" tick.
 */
export function NewContactFields({
  value,
  onChange,
  onUseExisting,
  variant = "person",
  companyName,
  useLabel = "Use that card",
  busyId,
}: {
  value: NewContactDraft;
  onChange: (next: NewContactDraft) => void;
  /** An existing card was picked from the "Already in Ops" box. */
  onUseExisting: (m: ContactMatch) => void;
  variant?: "person" | "supervisor";
  /** The job's company, picked or new. Offers "works there" on a person. */
  companyName?: string | null;
  useLabel?: string;
  busyId?: number | null;
}) {
  const set = <K extends keyof NewContactDraft>(k: K, v: NewContactDraft[K]) => onChange({ ...value, [k]: v });
  const [more, setMore] = React.useState(false);
  const sup = variant === "supervisor";
  const id = value.key;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="First name (required)">
        <Input id={`${id}_first`} value={value.firstName} onChange={(e) => set("firstName", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Last name">
        <Input id={`${id}_last`} value={value.lastName} onChange={(e) => set("lastName", e.target.value)} autoComplete="off" />
      </Field>
      <Field label={sup ? "Mobile (required)" : "Mobile"}>
        <Input
          id={`${id}_mobile`}
          value={value.mobile}
          inputMode="tel"
          onChange={(e) => set("mobile", e.target.value)}
          placeholder="0412 345 678"
          autoComplete="off"
        />
      </Field>
      <Field label="Email">
        <Input id={`${id}_email`} value={value.email} inputMode="email" onChange={(e) => set("email", e.target.value)} autoComplete="off" />
      </Field>
      <Field label={sup ? "Office phone" : "Other phone"}>
        <Input id={`${id}_phone`} value={value.phone} inputMode="tel" onChange={(e) => set("phone", e.target.value)} autoComplete="off" />
      </Field>
      {sup ? (
        <Field label="Job title at the builder">
          <Input
            id={`${id}_title`}
            value={value.jobTitle}
            onChange={(e) => set("jobTitle", e.target.value)}
            placeholder="Site supervisor"
            autoComplete="off"
          />
        </Field>
      ) : companyName ? (
        <div className="flex flex-col justify-end gap-1.5 pb-1">
          <label htmlFor={`${id}_atco`} className="flex items-center gap-2 text-sm">
            <Checkbox id={`${id}_atco`} checked={value.atCompany} onChange={(e) => set("atCompany", e.target.checked)} />
            Works at {companyName}
          </label>
          {value.atCompany ? (
            <Select aria-label="Their role there" value={value.companyRole} onChange={(e) => set("companyRole", e.target.value)}>
              {COMPANY_ROLES.filter((r) => r !== "supervisor").map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      ) : (
        <div className="hidden sm:block" />
      )}

      <div className="empty:hidden sm:col-span-2">
        <ContactMatches
          input={{ firstName: value.firstName, lastName: value.lastName, mobile: value.mobile, phone: value.phone, email: value.email }}
          onUse={onUseExisting}
          busyId={busyId}
          useLabel={useLabel}
        />
      </div>

      {sup ? (
        <Field label="Notes" className="sm:col-span-2">
          <Textarea id={`${id}_notes`} rows={2} value={value.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
      ) : more ? (
        <>
          <Field label="Home address" className="sm:col-span-2">
            <Input id={`${id}_addr`} value={value.address} onChange={(e) => set("address", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Suburb">
            <Input id={`${id}_suburb`} value={value.suburb} onChange={(e) => set("suburb", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Postcode">
            <Input id={`${id}_pc`} value={value.postcode} onChange={(e) => set("postcode", e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea id={`${id}_notes`} rows={2} value={value.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <label htmlFor={`${id}_mkt`} className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox id={`${id}_mkt`} checked={value.marketingOptIn} onChange={(e) => set("marketingOptIn", e.target.checked)} />
            Happy to get marketing
          </label>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setMore(true)}
          className="justify-self-start text-[13px] font-medium text-primary hover:underline sm:col-span-2"
        >
          More details (home address, notes, marketing)
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ companies */

export interface NewCompanyDraft {
  name: string;
  type: string;
  abn: string;
  phone: string;
  email: string;
  website: string;
  billingAddress: string;
  paymentTerms: string;
  notes: string;
}

export const blankCompany = (): NewCompanyDraft => ({
  name: "",
  type: "builder",
  abn: "",
  phone: "",
  email: "",
  website: "",
  billingAddress: "",
  paymentTerms: "14",
  notes: "",
});

export function companyPayload(c: NewCompanyDraft) {
  const n = (s: string) => (s.trim() ? s.trim() : null);
  return {
    name: c.name.trim(),
    type: c.type as (typeof COMPANY_TYPES)[number],
    abn: n(c.abn),
    phone: n(c.phone),
    email: n(c.email),
    website: n(c.website),
    billingAddress: n(c.billingAddress),
    paymentTerms: Math.max(0, Math.round(Number(c.paymentTerms) || 0)),
    notes: n(c.notes),
  };
}

export interface CompanyMatch {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  type: string;
  reasons: string[];
}

const CO_REASON: Record<string, string> = { phone: "same phone", email: "same email", name: "same or similar name" };

/** "Already in Ops" for companies. */
export function CompanyMatches({ input, onUse }: { input: { name: string; phone: string; email: string }; onUse: (m: CompanyMatch) => void }) {
  const q = useCompanyMatches(input);
  const rows = (q.data ?? []) as CompanyMatch[];
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-[var(--gold)]/60 bg-[var(--gold)]/10 p-3" aria-live="polite">
      <p className="flex items-center gap-1.5 text-[13px] font-semibold">
        <Building2 className="size-4" /> Already in Ops
      </p>
      <ul className="mt-2 space-y-2">
        {rows.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="min-w-0">
              <span className="font-medium">{m.name}</span>
              <span className="text-muted-foreground">
                {[COMPANY_TYPE_LABELS[m.type] ?? m.type, m.phone, m.email].filter(Boolean).length
                  ? ` · ${[COMPANY_TYPE_LABELS[m.type] ?? m.type, m.phone, m.email].filter(Boolean).join(" · ")}`
                  : ""}
              </span>
              <span className="block text-xs text-muted-foreground">{m.reasons.map((r) => CO_REASON[r] ?? r).join(", ")}</span>
            </span>
            <Button size="sm" variant="outline" onClick={() => onUse(m)}>
              Use this company
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NewCompanyFields({
  value,
  onChange,
  onUseExisting,
}: {
  value: NewCompanyDraft;
  onChange: (next: NewCompanyDraft) => void;
  onUseExisting: (m: CompanyMatch) => void;
}) {
  const set = <K extends keyof NewCompanyDraft>(k: K, v: NewCompanyDraft[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <Field label="Company name (required)" className="sm:col-span-2">
        <Input id="newco_name" value={value.name} onChange={(e) => set("name", e.target.value)} placeholder="ABC Builders Pty Ltd" autoComplete="off" />
      </Field>
      <Field label="Type">
        <Select id="newco_type" value={value.type} onChange={(e) => set("type", e.target.value)}>
          {COMPANY_TYPES.map((t) => (
            <option key={t} value={t}>
              {COMPANY_TYPE_LABELS[t] ?? t}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="ABN">
        <Input id="newco_abn" value={value.abn} onChange={(e) => set("abn", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Phone">
        <Input id="newco_phone" value={value.phone} inputMode="tel" onChange={(e) => set("phone", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Accounts email">
        <Input id="newco_email" value={value.email} inputMode="email" onChange={(e) => set("email", e.target.value)} autoComplete="off" />
      </Field>
      <div className="empty:hidden sm:col-span-2">
        <CompanyMatches input={{ name: value.name, phone: value.phone, email: value.email }} onUse={onUseExisting} />
      </div>
      <Field label="Website">
        <Input id="newco_web" value={value.website} onChange={(e) => set("website", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Payment terms (days)">
        <Input id="newco_terms" type="number" min={0} value={value.paymentTerms} onChange={(e) => set("paymentTerms", e.target.value)} />
      </Field>
      <Field label="Billing address" className="sm:col-span-2">
        <Input id="newco_bill" value={value.billingAddress} onChange={(e) => set("billingAddress", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Notes" className="sm:col-span-2">
        <Textarea id="newco_notes" rows={2} value={value.notes} onChange={(e) => set("notes", e.target.value)} />
      </Field>
    </div>
  );
}

/* ---------------------------------------------------------------- sites */

export interface NewSiteDraft {
  address: string;
  suburb: string;
  state: string;
  postcode: string;
  propertyType: string;
}

export const blankSite = (): NewSiteDraft => ({ address: "", suburb: "", state: "QLD", postcode: "", propertyType: "residential" });

export function sitePayload(s: NewSiteDraft) {
  return {
    address: s.address.trim(),
    suburb: s.suburb.trim(),
    state: s.state.trim() || "QLD",
    postcode: s.postcode.trim() || null,
    propertyType: s.propertyType || "residential",
  };
}

const PROPERTY_TYPES = [
  ["residential", "House or unit"],
  ["new_build", "New build"],
  ["commercial", "Commercial"],
  ["strata", "Strata / body corporate"],
  ["other", "Other"],
] as const;

const token = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Waits for a pause in typing. */
function useDebounced<T>(value: T, ms = 250) {
  const [out, setOut] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

/**
 * A new site address. With the Google key set, typing the street offers
 * addresses and a pick fills street, suburb, state and postcode. Without it,
 * the four boxes are typed by hand. Either way an existing site at that
 * address is offered first.
 */
export function NewSiteFields({
  value,
  onChange,
  onUseExisting,
}: {
  value: NewSiteDraft;
  onChange: (next: NewSiteDraft) => void;
  onUseExisting: (site: { id: number; label: string }) => void;
}) {
  const set = <K extends keyof NewSiteDraft>(k: K, v: NewSiteDraft[K]) => onChange({ ...value, [k]: v });
  const enabled = usePlacesEnabled();
  const on = !!enabled.data?.enabled;
  const [session, setSession] = React.useState(token);
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState(false);
  const typed = useDebounced(value.address);
  const suggestions = usePlaceSuggestions(typed, session, on && open && !picked);
  const details = usePlaceDetails();
  const [lookupError, setLookupError] = React.useState<string | null>(null);

  // An existing site at this street address is offered before a second one is made.
  const street = useDebounced(value.address.trim().toLowerCase(), 300);
  const existing = useSites({ search: street }, street.length >= 6);
  const sameSites = street.length >= 6 ? (existing.data ?? []).slice(0, 4) : [];

  async function pick(placeId: string) {
    setLookupError(null);
    setOpen(false);
    try {
      const a = await details.mutateAsync({ placeId, sessionToken: session });
      onChange({ ...value, address: a.address, suburb: a.suburb, state: a.state || "QLD", postcode: a.postcode });
      setPicked(true);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : String(e));
    } finally {
      // A pick ends Google's billing session. The next search starts a new one.
      setSession(token());
    }
  }

  const list = on && open && !picked ? (suggestions.data ?? []) : [];

  return (
    <div className="grid gap-2.5 sm:grid-cols-4">
      <Field
        label="Street address (required)"
        className="relative sm:col-span-4"
        hint={on ? "Start typing and pick the address. Suburb and postcode fill in." : "Type the street, then the suburb and postcode."}
      >
        <div className="relative">
          <MapPin className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="newsite_address"
            className="pl-8"
            value={value.address}
            onChange={(e) => {
              setPicked(false);
              setOpen(true);
              set("address", e.target.value);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="14 Smith Street"
            autoComplete="off"
            aria-describedby={list.length ? "newsite_suggestions" : undefined}
          />
          {details.isPending ? <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2" /> : null}
        </div>
        {list.length ? (
          <ul
            id="newsite_suggestions"
            aria-label="Address suggestions"
            className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-card shadow-lg"
          >
            {list.map((s) => (
              <li key={s.placeId}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(s.placeId)}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-secondary"
                >
                  <span className="font-medium">{s.main}</span>
                  {s.secondary ? <span className="text-muted-foreground"> {s.secondary}</span> : null}
                </button>
              </li>
            ))}
            <li className="px-3 py-1 text-right text-[10px] text-muted-foreground">Powered by Google</li>
          </ul>
        ) : null}
      </Field>
      <Field label="Suburb" className="sm:col-span-2">
        <Input id="newsite_suburb" value={value.suburb} onChange={(e) => set("suburb", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="State">
        <Input id="newsite_state" value={value.state} onChange={(e) => set("state", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Postcode">
        <Input id="newsite_pc" value={value.postcode} inputMode="numeric" onChange={(e) => set("postcode", e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Property type" className="sm:col-span-2">
        <Select id="newsite_type" value={value.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
          {PROPERTY_TYPES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      {lookupError ? <p className="text-xs text-destructive sm:col-span-4">{lookupError}</p> : null}
      {sameSites.length ? (
        <div className="rounded-lg border border-[var(--gold)]/60 bg-[var(--gold)]/10 p-3 sm:col-span-4" aria-live="polite">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <MapPin className="size-4" /> Already in Ops
          </p>
          <ul className="mt-2 space-y-2">
            {sameSites.map((s) => {
              const label = [s.site.address, s.site.suburb].filter(Boolean).join(", ");
              const owner = s.company?.name ?? ([s.contact?.firstName, s.contact?.lastName].filter(Boolean).join(" ") || null);
              return (
                <li key={s.site.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{label}</span>
                    {owner ? <span className="text-muted-foreground"> · {owner}</span> : null}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => onUseExisting({ id: s.site.id, label })}>
                    Use this site
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
