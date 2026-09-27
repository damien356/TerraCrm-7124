/**
 * Turns the way Damien talks into blocked dates.
 *
 *   "cant work dec 1-17 japan trip"  → range 2026-12-01 → 2026-12-17, "Japan trip"
 *   "never works weekends"           → recurring [0,6]
 *   "off 2/12 to 5/12 wedding"       → range 2026-12-02 → 2026-12-05, "wedding"
 *   "away 24 dec - 5 jan"            → range 2026-12-24 → 2027-01-05 (rolls the year)
 *
 * Anything it can't read comes back empty so the caller can tell him instead of
 * silently saving nothing.
 */

export interface ParsedUnavailability {
  kind: "range" | "recurring";
  fromDate?: string;
  toDate?: string;
  weekdays?: number[];
  reason: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sundays: 0, sun: 0,
  monday: 1, mondays: 1, mon: 1,
  tuesday: 2, tuesdays: 2, tue: 2, tues: 2,
  wednesday: 3, wednesdays: 3, wed: 3,
  thursday: 4, thursdays: 4, thu: 4, thurs: 4,
  friday: 5, fridays: 5, fri: 5,
  saturday: 6, saturdays: 6, sat: 6,
};

const NOISE = new Set([
  "cant", "can't", "cannot", "not", "no", "never", "works", "work", "working", "available",
  "unavailable", "off", "away", "out", "on", "leave", "holidays", "holiday", "annual", "book",
  "booked", "dont", "don't", "doesnt", "doesn't", "is", "he", "she", "till", "until", "to",
  "from", "the", "and", "of", "for", "at", "in", "any", "days", "day", "week", "weeks", "gone",
]);

const pad = (n: number) => String(n).padStart(2, "0");

function iso(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Pick the year that makes the date land in the next 12 months. */
function yearFor(month: number, day: number, today: Date) {
  const y = today.getFullYear();
  const candidate = new Date(y, month - 1, day);
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  cutoff.setDate(cutoff.getDate() - 14);
  return candidate < cutoff ? y + 1 : y;
}

interface DatePart {
  month?: number;
  day: number;
  year?: number;
}

/** "dec 1", "1 dec", "1/12", "01/12/2026", or a bare "17" (month borrowed later). */
function readDate(token: string): DatePart | null {
  const t = token.trim().toLowerCase().replace(/(st|nd|rd|th)$/, "");
  if (!t) return null;

  const slash = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/.exec(t);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year: number | undefined;
    if (slash[3]) year = slash[3].length === 2 ? 2000 + Number(slash[3]) : Number(slash[3]);
    return { day, month, year };
  }

  const words = t.split(/\s+/).filter(Boolean);
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  for (const w of words) {
    const cleaned = w.replace(/[^a-z0-9]/g, "").replace(/(st|nd|rd|th)$/, "");
    if (!cleaned) continue;
    if (MONTHS[cleaned] !== undefined) month = MONTHS[cleaned];
    else if (/^\d{4}$/.test(cleaned)) year = Number(cleaned);
    else if (/^\d{1,2}$/.test(cleaned)) day ??= Number(cleaned);
  }
  if (day === undefined || day < 1 || day > 31) return null;
  return { day, month, year };
}

function reasonFrom(text: string) {
  const words = text
    .toLowerCase()
    .replace(/[0-9]/g, " ")
    .split(/[^a-z']+/)
    .filter((w) => w.length > 1 && !NOISE.has(w) && MONTHS[w] === undefined && WEEKDAYS[w] === undefined);
  if (words.length === 0) return "";
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function parseUnavailability(raw: string, today = new Date()): ParsedUnavailability[] {
  const text = raw.toLowerCase().trim();
  if (!text) return [];
  const reason = reasonFrom(raw);
  const out: ParsedUnavailability[] = [];

  // Standing rules first — "never works weekends", "no saturdays".
  const weekdays = new Set<number>();
  if (/weekend/.test(text)) {
    weekdays.add(0);
    weekdays.add(6);
  }
  for (const [word, n] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) weekdays.add(n);
  }
  const looksRecurring = /\bnever\b|\bevery\b|\bweekend|\bno \w+days?\b|\bnot? .*(days)\b/.test(text);
  const hasDigits = /\d/.test(text);
  if (weekdays.size > 0 && (looksRecurring || !hasDigits)) {
    out.push({ kind: "recurring", weekdays: [...weekdays].sort(), reason });
    if (!hasDigits) return out;
  }

  // Ranges — "dec 1-17", "2/12 to 5/12", "24 dec - 5 jan".
  const rangeRe =
    /([a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?)\s*(?:-|–|—|to|till|until|thru|through)\s*([a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th)?)/g;

  let matched = false;
  for (const m of text.matchAll(rangeRe)) {
    const a = readDate(m[1]!);
    const b = readDate(m[2]!);
    if (!a || !b) continue;
    // A month named once covers both ends: "dec 1-17".
    const monthHint = a.month ?? b.month;
    if (monthHint === undefined) continue;
    const aMonth = a.month ?? monthHint;
    let bMonth = b.month ?? monthHint;
    if (bMonth < aMonth && b.month === undefined) bMonth = aMonth;

    const aYear = a.year ?? yearFor(aMonth, a.day, today);
    // "24 dec - 5 jan" rolls into next year.
    const bYear = b.year ?? (bMonth < aMonth ? aYear + 1 : aYear);
    const from = iso(aYear, aMonth, a.day);
    const to = iso(bYear, bMonth, b.day);
    if (to < from) continue;
    out.push({ kind: "range", fromDate: from, toDate: to, reason });
    matched = true;
  }
  if (matched) return out;

  // Single day — "off dec 3", "away 3/12".
  const singleRe =
    /([a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?)/;
  const single = singleRe.exec(text);
  if (single) {
    const d = readDate(single[1]!);
    if (d?.month !== undefined) {
      const year = d.year ?? yearFor(d.month, d.day, today);
      const day = iso(year, d.month, d.day);
      out.push({ kind: "range", fromDate: day, toDate: day, reason });
    }
  }
  return out;
}
