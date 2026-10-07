/**
 * Tags a person can hold on a job or quote. Roles belong to the job, not the
 * person: the same card can be Owner on one job and Property manager on the next,
 * and hold several tags on one job.
 *
 * Pure constants and helpers with no server imports, so the web app imports
 * this file directly.
 */

export const PERSON_TAGS = [
  "owner",
  "tenant",
  "supervisor",
  "property_manager",
  "builder_contact",
  "accounts",
  "other",
] as const;

export type PersonTag = (typeof PERSON_TAGS)[number];

export const PERSON_TAG_LABELS: Record<PersonTag, string> = {
  owner: "Owner",
  tenant: "Tenant",
  supervisor: "Supervisor",
  property_manager: "Property manager / Real estate agent",
  builder_contact: "Builder contact",
  accounts: "Accounts",
  other: "Other",
};

/** Short labels for chips on narrow screens. */
export const PERSON_TAG_SHORT: Record<PersonTag, string> = {
  owner: "Owner",
  tenant: "Tenant",
  supervisor: "Supervisor",
  property_manager: "Property manager",
  builder_contact: "Builder contact",
  accounts: "Accounts",
  other: "Other",
};

/** Only these tags earn referral credit. */
export const REFERRAL_TAGS: readonly PersonTag[] = ["supervisor", "property_manager"];

/** The old one-role-per-row names, mapped onto tags. */
export function legacyRoleToTag(role: string | null | undefined, companyJob: boolean): PersonTag {
  switch (role) {
    case "job_contact":
      return companyJob ? "other" : "owner";
    case "property_manager":
    case "tenant":
    case "supervisor":
    case "owner":
    case "accounts":
    case "builder_contact":
    case "other":
      return role;
    default:
      return "other";
  }
}

const TAG_SET = new Set<string>(PERSON_TAGS);

/** Reads the stored JSON list. Unknown values are dropped, order follows PERSON_TAGS. */
export function parseTags(raw: unknown): PersonTag[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  if (!Array.isArray(list)) return [];
  const have = new Set(list.filter((t): t is string => typeof t === "string" && TAG_SET.has(t)));
  return PERSON_TAGS.filter((t) => have.has(t));
}

/** Clean, ordered, de-duplicated JSON for storage. */
export function tagsJson(tags: readonly string[]): string {
  return JSON.stringify(parseTags(tags as string[]));
}

export function tagLabel(tag: string): string {
  return (PERSON_TAG_LABELS as Record<string, string>)[tag] ?? tag;
}

/** Company types. Insurer and Real estate agency join the old list. */
export const COMPANY_TYPES = [
  "builder",
  "real_estate",
  "property_manager",
  "insurer",
  "commercial",
  "government",
  "retail",
  "other",
] as const;

export const COMPANY_TYPE_LABELS: Record<string, string> = {
  builder: "Builder",
  real_estate: "Real estate agency",
  property_manager: "Property manager",
  insurer: "Insurer",
  commercial: "Commercial",
  government: "Government",
  retail: "Retail",
  other: "Other",
};
