/**
 * Bundle names and categories. No server imports here, so the web app can use
 * the same labels as the API and the PDF.
 */

export const FLOOR_CATEGORIES = [
  "carpet",
  "carpet_tile",
  "vinyl",
  "sheet_goods",
  "hybrid",
  "laminate",
  "timber",
  "turf",
] as const;
export type FloorCategory = (typeof FLOOR_CATEGORIES)[number];

export const ALL = "all";
export const EXTRAS = "extras";
export const BUNDLE_MODES = ["combined", "split"] as const;
export type BundleMode = (typeof BUNDLE_MODES)[number];

/** What a line can be put in by hand. */
export const LINE_CATEGORIES = [...FLOOR_CATEGORIES, EXTRAS] as const;

export const BUNDLE_TITLES: Record<string, string> = {
  [ALL]: "Flooring supply and installation",
  carpet: "Carpet supply and installation",
  carpet_tile: "Carpet tile supply and installation",
  vinyl: "Vinyl plank supply and installation",
  sheet_goods: "Sheet vinyl supply and installation",
  hybrid: "Hybrid flooring supply and installation",
  laminate: "Laminate flooring supply and installation",
  timber: "Timber flooring supply and installation",
  turf: "Artificial turf supply and installation",
  [EXTRAS]: "Preparation, removal and disposal",
};

/** Short names for the line category picker. */
export const CATEGORY_LABELS: Record<string, string> = {
  carpet: "Carpet",
  carpet_tile: "Carpet tiles",
  vinyl: "Vinyl plank",
  sheet_goods: "Sheet vinyl",
  hybrid: "Hybrid",
  laminate: "Laminate",
  timber: "Timber",
  turf: "Turf",
  [EXTRAS]: "Prep, removal and other",
};
