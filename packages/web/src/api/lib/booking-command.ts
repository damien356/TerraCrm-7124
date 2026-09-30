/**
 * The typed booking line: "Pedro 4446 thu 3 days 7-11".
 *
 * The office says a booking out loud faster than they can click it, so the
 * board takes it as one line of text. This file only reads the line apart. It
 * never books anything: the parse comes back as a preview the office confirms,
 * and the confirm goes through the same `book` write as the panel.
 *
 * Deliberately forgiving. Word order barely matters, the day count and the
 * window are optional, and anything it can't place is reported rather than
 * guessed at.
 */

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** Words that carry no meaning of their own, so they never look like a name. */
const NOISE = new Set([
  "a",
  "all",
  "an",
  "am",
  "and",
  "arrive",
  "arriving",
  "asap",
  "at",
  "book",
  "booked",
  "booking",
  "crew",
  "day",
  "days",
  "for",
  "from",
  "he",
  "hell",
  "him",
  "his",
  "in",
  "install",
  "installer",
  "job",
  "lay",
  "next",
  "on",
  "onto",
  "please",
  "pls",
  "pm",
  "put",
  "send",
  "site",
  "start",
  "starting",
  "the",
  "them",
  "they",
  "theyll",
  "this",
  "to",
  "until",
  "week",
  "with",
]);

function iso(d: Date) {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * A bare hour the way the office means it: 7 is 7am, 1 is 1pm. Nobody books a
 * 1am start, so the afternoon reading is the right one for the small numbers.
 */
function hour24(h: number, suffix: "am" | "pm" | null) {
  if (suffix === "am") return h === 12 ? 0 : h;
  if (suffix === "pm") return h === 12 ? 12 : h + 12;
  if (h >= 7 && h <= 11) return h;
  if (h === 12) return 12;
  if (h >= 1 && h <= 6) return h + 12;
  return h;
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

export type ParsedCommand = {
  /** Words left over once the numbers and dates are taken out, for name matching. */
  nameWords: string[];
  jobNumber: string | null;
  taskId: number | null;
  startDate: string | null;
  /** True when the line named a day rather than the parser falling back. */
  dateGiven: boolean;
  days: number | null;
  arrivalStart: string | null;
  arrivalEnd: string | null;
  /** Following days left for the installer and the site to sort out. */
  coordinateAfterFirst: boolean;
  unread: string[];
};

/**
 * Read a booking line apart. `today` is passed in so the same line parses the
 * same way in a test as it does on a Tuesday afternoon in the office.
 */
export function parseBookingLine(text: string, today: Date): ParsedCommand {
  const out: ParsedCommand = {
    nameWords: [],
    jobNumber: null,
    taskId: null,
    startDate: null,
    dateGiven: false,
    days: null,
    arrivalStart: null,
    arrivalEnd: null,
    coordinateAfterFirst: false,
    unread: [],
  };

  const raw = text.trim().toLowerCase();
  if (!raw) return out;

  // "they'll ring the site" instead of a window.
  const coordinate = /\b(ring|rings|rings the site|coordinate|tbc|tba)\b/.test(raw);
  out.coordinateAfterFirst = coordinate;

  const tokens = raw.split(/[\s,]+/).filter(Boolean);
  let nextIsWeek = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const bare = token.replace(/^[#@]/, "");

    // Arrival window: 7-11, 7am-11am, 7:30-11, 07:00-11:00.
    const window = bare.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?-(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (window) {
      const endSuffix = (window[6] as "am" | "pm" | undefined) ?? null;
      // "7-11am" means both ends are am, which is how it gets said.
      const startSuffix = (window[3] as "am" | "pm" | undefined) ?? endSuffix;
      out.arrivalStart = hhmm(hour24(Number(window[1]), startSuffix), Number(window[2] ?? 0));
      out.arrivalEnd = hhmm(hour24(Number(window[4]), endSuffix), Number(window[5] ?? 0));
      continue;
    }

    // The spoken form: "7 to 11", "7 till 11", "8 through 12". Three tokens
    // rather than one, because that is how it gets dictated down the phone.
    const bareHour = bare.match(/^(\d{1,2})(?::(\d{2}))?$/);
    const joiner = tokens[i + 1];
    const after = tokens[i + 2]?.replace(/^[#@]/, "");
    const afterHour = after?.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
    if (
      bareHour &&
      Number(bareHour[1]) <= 12 &&
      joiner &&
      /^(to|till|til|until|thru|through|-)$/.test(joiner) &&
      afterHour &&
      Number(afterHour[1]) <= 12 &&
      out.arrivalStart == null
    ) {
      const endSuffix = (afterHour[3] as "am" | "pm" | undefined) ?? null;
      out.arrivalStart = hhmm(hour24(Number(bareHour[1]), endSuffix), Number(bareHour[2] ?? 0));
      out.arrivalEnd = hhmm(hour24(Number(afterHour[1]), endSuffix), Number(afterHour[2] ?? 0));
      i += 2;
      continue;
    }

    // A single time: the start, no end. "pedro 4446 thu 7am".
    const single = bare.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
    if (single) {
      out.arrivalStart = hhmm(hour24(Number(single[1]), single[3] as "am" | "pm"), Number(single[2] ?? 0));
      continue;
    }

    // An explicit date: 5/10, 5/10/26, 2026-10-05.
    const isoDate = bare.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoDate) {
      out.startDate = bare;
      out.dateGiven = true;
      continue;
    }
    const slash = bare.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (slash) {
      const day = Number(slash[1]);
      const month = Number(slash[2]);
      const yearPart = slash[3] ? Number(slash[3]) : null;
      const year = yearPart == null ? today.getFullYear() : yearPart < 100 ? 2000 + yearPart : yearPart;
      const d = new Date(year, month - 1, day);
      // A day already gone this year means next year, the way a diary works.
      if (yearPart == null && d < today) d.setFullYear(year + 1);
      out.startDate = iso(d);
      out.dateGiven = true;
      continue;
    }

    // "3 days", "3d", "x3".
    const dayCount = bare.match(/^x?(\d{1,2})(?:d|days?)?$/);
    if (dayCount && (/(?:d|days?)$/.test(bare) || bare.startsWith("x") || tokens[i + 1]?.startsWith("day"))) {
      out.days = Number(dayCount[1]);
      continue;
    }

    // A job number, or a task by its own id. The first one wins: a second
    // stray number later in the line is far more likely to be a mangled time
    // than a second job, so it is reported rather than quietly taking over.
    if (/^\d{2,}$/.test(bare)) {
      if (token.startsWith("@")) out.taskId = Number(bare);
      else if (out.jobNumber == null) out.jobNumber = bare;
      else out.unread.push(token);
      continue;
    }

    if (bare === "today" || bare === "tday") {
      out.startDate = iso(today);
      out.dateGiven = true;
      continue;
    }
    if (bare === "tomorrow" || bare === "tmr" || bare === "tom") {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      out.startDate = iso(d);
      out.dateGiven = true;
      continue;
    }
    if (bare === "next") {
      nextIsWeek = true;
      continue;
    }

    const weekday = WEEKDAYS[bare];
    if (weekday != null) {
      const d = new Date(today);
      // The named day coming up. Today counts, because "thu" said on a Thursday
      // morning means this morning.
      const ahead = (weekday - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + ahead + (nextIsWeek || tokens[i + 1] === "week" ? 7 : 0));
      out.startDate = iso(d);
      out.dateGiven = true;
      nextIsWeek = false;
      continue;
    }

    if (NOISE.has(bare) || /^(ring|rings|coordinate|tbc|tba)$/.test(bare)) continue;
    if (/^[a-z'-]{2,}$/.test(bare)) out.nameWords.push(bare);
    else out.unread.push(token);
  }

  return out;
}

/**
 * Pick the installer the line meant. Matches a first name, a surname, or the
 * start of either, so "ped", "pedro" and "silva" all land on Pedro Silva.
 * Returns nothing at all when two people answer to it, rather than guessing.
 */
export function matchInstaller<T extends { id: number; name: string }>(
  words: string[],
  installers: T[],
): { installer: T | null; ambiguous: T[] } {
  if (words.length === 0) return { installer: null, ambiguous: [] };

  const scored = installers
    .map((inst) => {
      const parts = inst.name.toLowerCase().split(/\s+/);
      let score = 0;
      for (const word of words) {
        if (parts.includes(word)) score += 3;
        else if (parts.some((p) => p.startsWith(word) && word.length >= 3)) score += 2;
        else if (inst.name.toLowerCase().includes(word) && word.length >= 4) score += 1;
      }
      return { inst, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { installer: null, ambiguous: [] };
  const top = scored[0]!;
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) return { installer: null, ambiguous: tied.map((s) => s.inst) };
  return { installer: top.inst, ambiguous: [] };
}
