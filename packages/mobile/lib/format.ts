/** Small display helpers shared across the field screens. */

export function fmtTime(t?: string | null) {
  if (!t) return "Any time";
  const [rawH, rawM] = t.split(":");
  const h = Number(rawH);
  const m = Number(rawM ?? 0);
  if (!Number.isFinite(h)) return t;
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, "0")}${suffix}`;
}

export function fmtHours(h?: number | null) {
  if (h == null) return "";
  return h === 1 ? "1 hr" : `${Number.isInteger(h) ? h : h.toFixed(1)} hrs`;
}

export function fmtMoney(n?: number | null) {
  if (n == null) return "—";
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/** Same as fmtMoney but keeps the cents, for line item pay breakdowns. */
export function fmtMoney2(n?: number | null) {
  if (n == null) return "—";
  return `${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Short label for a rate book unit, as used on an installer's pay breakdown. */
export function unitLabel(unit?: string | null) {
  switch (unit) {
    case "m2":
      return "m²";
    case "lm":
      return "lin";
    case "each":
      return "each";
    case "step":
      return "step";
    case "hour":
      return "hr";
    case "day":
      return "day";
    case "job":
      return "job";
    case "percent":
      return "%";
    case "km":
      return "km";
    default:
      return unit ?? "";
  }
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseISODate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function toISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** iso plus n days, n can be negative. */
export function addDaysISO(iso: string, n: number) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

/** Monday of the week that iso falls in. */
export function startOfWeekISO(iso: string) {
  const d = parseISODate(iso);
  const dow = d.getDay(); // 0 = Sunday
  const back = dow === 0 ? 6 : dow - 1;
  d.setDate(d.getDate() - back);
  return toISO(d);
}

/** The 1st of iso's month. */
export function startOfMonthISO(iso: string) {
  const d = parseISODate(iso);
  return toISO(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** "September 2026" for a month grid header. */
export function monthLabel(iso: string) {
  const d = parseISODate(iso);
  return `${["January","February","March","April","May","June","July","August","September","October","November","December"][d.getMonth()]} ${d.getFullYear()}`;
}

/** "Mon 29" for a week strip day. */
export function dayOfMonth(iso: string) {
  return parseISODate(iso).getDate();
}

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Full calendar grid for the month iso falls in, in whole weeks, Monday first.
 * Each cell knows whether it belongs to iso's own month, for dimming the
 * leading/trailing days that spill from the months either side.
 */
export function monthGrid(iso: string): { date: string; inMonth: boolean }[] {
  const monthStart = startOfMonthISO(iso);
  const month = parseISODate(iso).getMonth();
  const gridStart = startOfWeekISO(monthStart);
  const cells: { date: string; inMonth: boolean }[] = [];
  let cursor = gridStart;
  for (let i = 0; i < 42; i++) {
    cells.push({ date: cursor, inMonth: parseISODate(cursor).getMonth() === month });
    cursor = addDaysISO(cursor, 1);
  }
  return cells;
}

/** "Today", "Tomorrow", else "Wednesday 2 Sep". */
export function fmtDayLabel(iso?: string | null) {
  if (!iso) return "Not booked in yet";
  const d = parseISODate(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtLongDate(iso?: string | null) {
  if (!iso) return "";
  const d = parseISODate(iso);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtDateTime(value?: Date | string | null) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "1h 42m left" / "Expired" — for offer countdowns. */
export function fmtCountdown(expiresAt?: Date | string | null, nowMs = Date.now()) {
  if (!expiresAt) return "No cut-off";
  const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const ms = end.getTime() - nowMs;
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return "Expired";
  const mins = Math.floor(ms / 60_000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m left`;
  return `${mins}m left`;
}

export function daysUntil(value?: Date | string | null) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400_000);
}

export function crewLabel(capacity?: string | null) {
  switch (capacity) {
    case "solo":
      return "Works solo";
    case "own_offsider":
      return "Brings own offsider";
    case "needs_partner":
      return "Needs a partner";
    default:
      return capacity ?? "";
  }
}

export function statusLabel(status?: string | null) {
  switch (status) {
    case "assigned":
      return "Booked in";
    case "in_progress":
      return "On the job";
    case "complete":
      return "Finished";
    case "offered":
      return "Offered";
    case "unassigned":
      return "Unassigned";
    case "cancelled":
      return "Cancelled";
    default:
      return status ?? "";
  }
}
