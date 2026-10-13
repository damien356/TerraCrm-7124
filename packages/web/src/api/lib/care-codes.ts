/* ---------------------------------------------------------------------------
 * After-job care series: the fixed facts. Section 18.37.
 *
 * No imports on purpose: the Care page, the job page and the price book read
 * this file too, and web code must never pull in a server module.
 * ------------------------------------------------------------------------- */

/** Floor types a job can put down, as the care series sees them. */
export const CARE_FLOORS = [
  "carpet",
  "vinyl_plank",
  "hybrid",
  "laminate",
  "engineered_timber",
  "sanding",
  "carpet_tiles",
  "sheet_vinyl",
] as const;
export type CareFloor = (typeof CARE_FLOORS)[number];

export const CARE_FLOOR_LABELS: Record<CareFloor, string> = {
  carpet: "Carpet",
  vinyl_plank: "Vinyl plank",
  hybrid: "Hybrid",
  laminate: "Laminate",
  engineered_timber: "Engineered timber",
  sanding: "Floor sanding and coating",
  carpet_tiles: "Carpet tiles",
  sheet_vinyl: "Sheet vinyl",
};

export const isCareFloor = (v: unknown): v is CareFloor => typeof v === "string" && (CARE_FLOORS as readonly string[]).includes(v);

/** Carpet fibre. The first five are what a price list can say. */
export const FIBRES = ["wool", "wool_blend", "nylon", "polypropylene", "polyester"] as const;
/** On a job: the price list values, plus the two answers a person can give. */
export const JOB_FIBRES = [...FIBRES, "not_wool", "unknown"] as const;
export type Fibre = (typeof JOB_FIBRES)[number];

export const FIBRE_LABELS: Record<Fibre, string> = {
  wool: "Wool",
  wool_blend: "Wool blend",
  nylon: "Nylon",
  polypropylene: "Polypropylene",
  polyester: "Polyester",
  not_wool: "Not wool",
  unknown: "Unknown",
};

export const PILES = ["cut", "loop", "cut_loop"] as const;
export type Pile = (typeof PILES)[number];
export const PILE_LABELS: Record<Pile, string> = { cut: "Cut pile", loop: "Loop pile", cut_loop: "Cut and loop" };

/** Wool blend is treated the same as wool for every email. */
export const isWoolFibre = (f: string | null | undefined) => f === "wool" || f === "wool_blend";
/** Cut and loop has loops too, so it gets the loop advice. */
export const isLoopPile = (p: string | null | undefined) => p === "loop" || p === "cut_loop";

/** Fibres a person can still be asked about: nothing found yet. */
export const fibreKnown = (f: string | null | undefined) => !!f && f !== "unknown";

/* ---------------------------------------------------------------------------
 * Settings keys (settings table)
 * ------------------------------------------------------------------------- */

/** "1" sends. Anything else, nothing goes. Off until Damien switches it on. */
export const CARE_ON_KEY = "care_engine_on";
/** ms. Set the first time it is switched on. Jobs completed before it are not added. */
export const CARE_STARTED_KEY = "care_started_at";
/** JSON list of range names that are wool, for the job text and the backfill. */
export const CARE_WOOL_RANGES_KEY = "care_wool_ranges";
export const CARE_WOOL_RANGES_DEFAULT = ["Settlers Peak", "Auburn Ridge"];

/* ---------------------------------------------------------------------------
 * The Queensland holiday calendar. Everyone in the series, 7am Brisbane.
 * Refresh each year from the Queensland Government school calendar.
 * ------------------------------------------------------------------------- */

export interface CareHoliday {
  /** Brisbane date the email goes, YYYY-MM-DD. */
  date: string;
  code: string;
  label: string;
}

export const CARE_HOLIDAYS: CareHoliday[] = [
  { date: "2026-12-10", code: "H2", label: "Summer school holidays and Christmas" },
  { date: "2027-01-21", code: "H5", label: "Australia Day long weekend" },
  { date: "2027-03-23", code: "H3", label: "Easter and autumn school holidays" },
  { date: "2027-04-22", code: "H1", label: "Anzac Day long weekend" },
  { date: "2027-06-23", code: "H4", label: "Winter school holidays" },
  { date: "2027-09-15", code: "H6", label: "Spring school holidays and King's Birthday" },
  { date: "2027-12-08", code: "H2", label: "Summer school holidays and Christmas" },
];

/** Seasonal emails push any other email 2 weeks clear. Holiday emails push them 10 days clear. */
export const SEASONAL_CODES = new Set(["H1", "H2", "H3"]);
export const holidayClearDays = (code: string) => (SEASONAL_CODES.has(code) ? 14 : 10);

/** The hour (Brisbane) holiday emails go. Everything else goes from 9am. */
export const HOLIDAY_SEND_HOUR = 7;
export const SERIES_SEND_HOUR = 9;

/* ---------------------------------------------------------------------------
 * The schedules. Weeks after the job was completed.
 * ------------------------------------------------------------------------- */

export type ScheduleKey = "carpet" | "carpet_landlord" | "timber" | "sanding" | "vinyl" | "laminate" | "tiles";

export const SCHEDULE_LABELS: Record<ScheduleKey, string> = {
  carpet: "Carpet",
  carpet_landlord: "Carpet (landlord)",
  timber: "Engineered timber",
  sanding: "Floor sanding",
  vinyl: "Vinyl",
  laminate: "Laminate and hybrid",
  tiles: "Carpet tiles",
};

export interface ScheduleStep {
  code: string;
  /** Weeks after completion. Fractions are days: S1 is the day after. */
  week: number;
  /** Only for wool and wool blend carpet. */
  woolOnly?: boolean;
  /** Goes on its day even inside the 3 week gap. Only S1, which is about the first 3 weeks. */
  urgent?: boolean;
}

export const SCHEDULES: Record<ScheduleKey, ScheduleStep[]> = {
  carpet: [
    { code: "C1", week: 3 },
    { code: "A1", week: 8 },
    { code: "C2", week: 13 },
    { code: "C5", week: 18 },
    { code: "A2", week: 23 },
    { code: "A3", week: 28 },
    { code: "A4", week: 33 },
    { code: "C6", week: 38, woolOnly: true },
  ],
  /* C4 at week 3, C1 moves to 8, A1 to 13, C2 to 18. The rest move 5 weeks too. */
  carpet_landlord: [
    { code: "C4", week: 3 },
    { code: "C1", week: 8 },
    { code: "A1", week: 13 },
    { code: "C2", week: 18 },
    { code: "C5", week: 23 },
    { code: "A2", week: 28 },
    { code: "A3", week: 33 },
    { code: "A4", week: 38 },
    { code: "C6", week: 43, woolOnly: true },
  ],
  timber: [
    { code: "T1", week: 1 },
    { code: "T2", week: 5 },
    { code: "A1", week: 10 },
    { code: "T3", week: 15 },
    { code: "A3", week: 20 },
    { code: "T5", week: 26 },
    { code: "A2", week: 31 },
    { code: "A4", week: 36 },
    { code: "T7", week: 41 },
  ],
  sanding: [
    { code: "S1", week: 1 / 7, urgent: true },
    { code: "S2", week: 4 },
    { code: "A1", week: 9 },
    { code: "A2", week: 14 },
    { code: "S3", week: 20 },
  ],
  vinyl: [
    { code: "V1", week: 3 },
    { code: "A1", week: 8 },
    { code: "V2", week: 14 },
    { code: "A3", week: 19 },
    { code: "A2", week: 24 },
    { code: "A4", week: 29 },
  ],
  laminate: [
    { code: "L1", week: 3 },
    { code: "A1", week: 8 },
    { code: "L2", week: 13 },
    { code: "A3", week: 18 },
    { code: "A2", week: 23 },
    { code: "A4", week: 28 },
  ],
  tiles: [
    { code: "CT1", week: 3 },
    { code: "A1", week: 8 },
    { code: "C2", week: 13 },
    { code: "A3", week: 18 },
  ],
};

/** The 12-month email for each schedule. Exactly 12 months after completion, then every year. */
export const FIXED_CODES: Partial<Record<ScheduleKey, string>> = {
  carpet: "C3",
  carpet_landlord: "C3",
  timber: "T6",
  sanding: "S4",
};

/** Goes 5 weeks after the last email of the schedule. Once, however many floors. */
export const LAST_CODE = "A5";
export const LAST_CODE_WEEKS = 5;

export function scheduleKeyFor(floor: CareFloor, landlord: boolean): ScheduleKey {
  switch (floor) {
    case "carpet":
      return landlord ? "carpet_landlord" : "carpet";
    case "engineered_timber":
      return "timber";
    case "sanding":
      return "sanding";
    case "vinyl_plank":
    case "sheet_vinyl":
      return "vinyl";
    case "laminate":
    case "hybrid":
      return "laminate";
    case "carpet_tiles":
      return "tiles";
  }
}

/* ---------------------------------------------------------------------------
 * Year 2 onwards: the bank. One every 8 to 10 weeks after the schedule runs out.
 * ------------------------------------------------------------------------- */

export interface BankEmail {
  code: string;
  /** Schedules it suits. Empty means everyone. */
  for: ScheduleKey[];
  landlordOnly?: boolean;
  /** Months (1 to 12) it may go in. Empty means any time. */
  months?: number[];
  /** Never within 6 months of these. */
  from: string[];
}

const HARD: ScheduleKey[] = ["timber", "sanding", "laminate", "vinyl"];

export const BANK: BankEmail[] = [
  { code: "R1", for: ["carpet", "carpet_landlord"], from: ["C1", "C1-W"] },
  { code: "R2", for: ["carpet", "carpet_landlord", "tiles"], from: ["C2"] },
  { code: "R3", for: HARD, from: ["T1", "T3"] },
  { code: "R4", for: [], from: ["T1"] },
  { code: "R5", for: ["vinyl"], from: ["V1"] },
  { code: "R6", for: ["laminate"], from: ["L1"] },
  { code: "R7", for: [], months: [9], from: [] },
  { code: "R8", for: [], months: [1, 2], from: ["H5", "L2"] },
  { code: "R9", for: [], from: [] },
  { code: "R10", for: ["carpet_landlord"], landlordOnly: true, from: ["C4"] },
];

export const BANK_GAP_DAYS = { min: 56, max: 70, slow: 84 } as const;
/** A group slows to every 12 weeks above this unsubscribe rate or below this open rate. */
export const SLOW_RULES = { unsubAbove: 0.01, opensBelow: 0.3, minSends: 30 } as const;

/** Merged schedules keep this many days between any two emails. */
export const MIN_GAP_DAYS = 21;
/** Resend once when the first is not opened in this many days. */
export const RESEND_AFTER_DAYS = 7;

/**
 * Company types whose people never get care emails: they are not the person
 * living in the house. Real estate agency counts as a property manager.
 * Damien's rule, replacing the old "4 completed jobs means trade" guess.
 */
export const CARE_TRADE_COMPANY_TYPES = ["builder", "insurance_builder", "property_manager", "real_estate", "commercial"] as const;

/** One care series per person per floor type in any 12 months. A floor restarts only after this. */
export const FLOOR_RESTART_DAYS = 365;

/** Note on an email passed over because it was due before the person joined. */
export const PASSED_OVER_NOTE = "before the series started, passed over";
export const RESEND_LINE = "I could be wrong, but it doesn't look like you opened my last email, so here it is again.";

/** Kind of each code, for the report. */
export function codeKind(code: string): "series" | "fixed" | "holiday" | "bank" {
  if (/^H\d$/.test(code)) return "holiday";
  if (/^R\d+$/.test(code)) return "bank";
  if (code === "C3" || code === "T6" || code === "S4") return "fixed";
  return "series";
}
