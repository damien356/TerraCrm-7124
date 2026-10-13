/* ---------------------------------------------------------------------------
 * Lead sources, landing pages and timber repairs: the shared names.
 * Spec 14 Oct, PROJECT_NOTES section 18.38.
 *
 * No imports on purpose: the Settings page, the New job screen and the
 * report read this file too, and web code must never pull in a server module.
 * ------------------------------------------------------------------------- */

/** The name every imported job gets until something better is known. */
export const UNKNOWN_SOURCE = "Unknown (before tracking)";

/**
 * Jobs made before the list moved into Settings carry a short key. The New
 * job screen, quotes and voice memos still send these, so they are read
 * through this map everywhere a source is shown or counted.
 */
export const LEGACY_SOURCE_NAMES: Record<string, string> = {
  phone: "Phone",
  website: "Website",
  repeat: "Repeat client",
  referral: "Referral",
  builder: "Builder",
  walk_in: "Walk-in showroom",
  other: "Other",
  unknown: UNKNOWN_SOURCE,
  callback: "Callback",
};

/** What a job's source reads as, old keys included. */
export function sourceName(raw: string | null | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return UNKNOWN_SOURCE;
  return LEGACY_SOURCE_NAMES[v] ?? v;
}

/** Test jobs left in the import. Never counted in the leads report. */
export const REPORT_EXCLUDED_JOB_NUMBERS = [4384, 4385, 4388, 4389];

export const CLIENT_TYPES = [
  ["healthcare", "Healthcare"],
  ["commercial", "Commercial"],
  ["homeowner", "Homeowner"],
  ["builder", "Builder"],
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number][0];
export const clientTypeLabel = (v: string) => CLIENT_TYPES.find(([k]) => k === v)?.[1] ?? v;

/** The tag a timber repair page puts on its jobs. */
export const TIMBER_TAG = "Timber repair";
export const TIMBER_SKILL = "Timber repair";

export const REPAIR_TYPES = [
  ["scratches", "Scratches"],
  ["water_damage", "Water damage"],
  ["pot_plant", "Pot plant damage and dents"],
] as const;
export type RepairType = (typeof REPAIR_TYPES)[number][0];
export const repairTypeLabel = (v: string) => REPAIR_TYPES.find(([k]) => k === v)?.[1] ?? v;

/** Read the repair type off whatever the page sent. */
export function repairTypeOf(raw: string | null | undefined): RepairType | "" {
  const v = String(raw ?? "").toLowerCase();
  if (!v.trim()) return "";
  if (/water/.test(v)) return "water_damage";
  if (/pot|plant|dent/.test(v)) return "pot_plant";
  if (/scratch/.test(v)) return "scratches";
  return "";
}

export const FLOOR_TYPES = [
  ["solid", "Solid timber"],
  ["engineered", "Engineered"],
  ["laminate", "Laminate"],
  ["not_sure", "Not sure"],
] as const;
export const floorTypeLabel = (v: string) => FLOOR_TYPES.find(([k]) => k === v)?.[1] ?? v;

export function floorTypeOf(raw: string | null | undefined): string {
  const v = String(raw ?? "").toLowerCase();
  if (!v.trim()) return "";
  if (/engineer|floating/.test(v)) return "engineered";
  if (/laminate/.test(v)) return "laminate";
  if (/solid|hardwood|timber|wood/.test(v)) return "solid";
  return "not_sure";
}

/** The wording every timber repair quote carries, whatever the template. */
export const PHOTO_PRICE_SENTENCE =
  "This price is based on your photos. We'll confirm it when we see the floor. If it's different, we'll tell you before starting any work.";

/** Settings keys. Each one holds markup or cost, so non-admins never see them (SENSITIVE_SETTING). */
export const TIMBER_MARKUP_KEY = "timber_repair_markup";
export const TIMBER_MIN_KEY = "timber_repair_min_charge_cost";
export const TIMBER_AUTOSEND_KEY = "timber_repair_autosend_under_cost";
/** Hours before an unanswered price text pushes the office. */
export const TIMBER_NUDGE_HOURS = 2;
/** Days the no-login photo link works for. */
export const TIMBER_LINK_DAYS = 14;
export const TIMBER_TEMPLATE_KEY = (t: string) => `timber_repair_template_${t}`;
export const LEAD_AUTOREPLY_KEY = "lead_client_autoreply_on";
export const TIMBER_MARKUP_DEFAULT = 1.9;

const cents = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** What a quote shows for one line at this ex GST price: the same sums as routes/quotes.ts recalc. */
export const quoteTotalFor = (unitEx: number, gstRate = 0.1) => cents(unitEx + cents(unitEx * gstRate));

/**
 * The ex GST line price that makes the quote total exactly this many dollars,
 * or null when no price in cents does (about 1 in 11 dollar amounts, because
 * GST is rounded to the cent separately).
 */
export function exPriceFor(totalIncl: number, gstRate = 0.1): number | null {
  const base = cents(totalIncl / (1 + gstRate));
  for (const d of [0, -0.01, 0.01, -0.02, 0.02]) {
    const ex = cents(base + d);
    if (Math.abs(quoteTotalFor(ex, gstRate) - totalIncl) < 0.001) return ex;
  }
  return null;
}

/**
 * Client price from Marc's price: markup, then GST, to the nearest dollar,
 * never under the minimum. When the quote cannot carry that exact dollar
 * figure, it goes up a dollar (at most 3) so the client never sees cents.
 */
export function timberClientPrice(marcPrice: number, markup: number, minCharge: number, gstRate = 0.1) {
  const ex = Math.max(marcPrice * markup, minCharge || 0);
  let total = Math.round(ex * (1 + gstRate));
  for (let i = 0; i < 4 && exPriceFor(total, gstRate) == null; i++) total += 1;
  return { total, unitEx: exPriceFor(total, gstRate) ?? cents(total / (1 + gstRate)) };
}

/** The starting wording per repair type. Damien edits it in Settings, Leads. */
export const TIMBER_TEMPLATE_DEFAULTS: Record<RepairType, string> = {
  scratches: [
    "Scratch repair to the timber floor shown in your photos.",
    "Included: cleaning the area, filling and blending the scratches to match the floor colour, and a matching top coat over the repaired area.",
    "Not included: full floor sanding, recoating the whole room, moving furniture, or damage not shown in the photos.",
    "Time: usually half a day on site.",
  ].join("\n"),
  water_damage: [
    "Water damage repair to the timber floor shown in your photos.",
    "Included: lifting and replacing the damaged boards with the closest match we can source, sanding and coating the repaired area to blend in.",
    "Not included: finding or fixing the water leak, subfloor or joist repairs, moisture testing reports, or matching boards that are no longer made.",
    "Time: usually 1 to 2 days on site, plus drying time for the coating.",
  ].join("\n"),
  pot_plant: [
    "Pot plant damage and dent repair to the timber floor shown in your photos.",
    "Included: drawing out or filling the dents and marks, treating water rings, and a matching top coat over the repaired area.",
    "Not included: full floor sanding, replacing boards that are split or rotten, or damage not shown in the photos.",
    "Time: usually half a day on site.",
  ].join("\n"),
};

/** What Marc's reply is, read with rules. "350", "$350", "350 ex", "350 half a day", "SEE". */
export type MarcReply = { kind: "price"; price: number; note: string } | { kind: "see" } | { kind: "other" };

export function readMarcReply(body: string): MarcReply {
  const t = String(body ?? "").trim();
  if (/^see\b[.!]*$/i.test(t) || /^see\b/i.test(t)) return { kind: "see" };
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*(.*)$/s.exec(t);
  if (!m) return { kind: "other" };
  const price = Number(`${m[1]!.replace(/,/g, "")}${m[2] ? `.${m[2]}` : ""}`);
  if (!Number.isFinite(price) || price <= 0 || price > 100000) return { kind: "other" };
  let note = (m[3] ?? "").trim();
  // "350 ex", "350 ex GST", "350 + GST" are just the price.
  note = note.replace(/^(\+\s*gst|ex\.?(\s*gst)?|excl?\.?(\s*gst)?|plus\s*gst)\b[.,]?\s*/i, "").trim();
  note = note.replace(/^[-,.:;]+\s*/, "").trim();
  return { kind: "price", price, note };
}
