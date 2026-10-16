/**
 * Notes 18.56: property type, kept on the site (it belongs to the address) and
 * shown on the job. Pure constants, so the web app imports this file directly.
 *
 * Older values (residential, rental, new_build) are not answers: they read as
 * "not answered" and go red, because the old default was a guess.
 */
export const PROPERTY_TYPES = [
  ["house", "House"],
  ["townhouse", "Townhouse/duplex"],
  ["unit_low", "Unit, low-rise (walk-up, 1 to 3 storeys)"],
  ["apartment_high", "Apartment, high-rise (lift building)"],
  ["commercial", "Commercial"],
] as const;

export type PropertyType = (typeof PROPERTY_TYPES)[number][0];

const LABELS = new Map<string, string>(PROPERTY_TYPES.map(([v, l]) => [v, l]));

/** Short words for chips and lists. */
const SHORT: Record<string, string> = {
  house: "House",
  townhouse: "Townhouse/duplex",
  unit_low: "Unit, low-rise",
  apartment_high: "Apartment, high-rise",
  commercial: "Commercial",
};

export const propertyTypeAnswered = (v: string | null | undefined): v is PropertyType => !!v && LABELS.has(v);

export const propertyTypeLabel = (v: string | null | undefined) => (propertyTypeAnswered(v) ? LABELS.get(v)! : "Not answered");

export const propertyTypeShort = (v: string | null | undefined) => (propertyTypeAnswered(v) ? SHORT[v]! : "Not answered");

/** Unit or apartment: the body corporate section and the apartment checklist apply. */
export const isUnitType = (v: string | null | undefined) => v === "unit_low" || v === "apartment_high";

/** Measures are not installs: they never need the answers and never get prep messages. */
export const isMeasureSkill = (name: string | null | undefined) => /measure/i.test(name ?? "");

export const APT_CHECKS = [
  ["fire", "Fire alarm isolated"],
  ["lift", "Lift booked and padded"],
  ["parking", "Parking/access sorted"],
] as const;

export type AptCheckKey = (typeof APT_CHECKS)[number][0];
export type AptChecks = Partial<Record<AptCheckKey, { at: string; by: string }>>;

export function parseAptChecks(raw: string | null | undefined): AptChecks {
  try {
    const v = JSON.parse(raw || "{}");
    const out: AptChecks = {};
    for (const [k] of APT_CHECKS) {
      const x = v?.[k];
      if (x && typeof x.at === "string") out[k] = { at: x.at, by: String(x.by ?? "") };
    }
    return out;
  } catch {
    return {};
  }
}
