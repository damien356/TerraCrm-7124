/**
 * Notes 18.56: the wording of the client prep messages. Pure, so the web app
 * imports the defaults and the token list for the Settings screen.
 *
 * Every piece is editable in Settings, Client prep. Tokens in square brackets
 * are filled in when the message is made:
 *   [first name] [day, date] [arrival] [window] [furniture] [unit section]
 *   [unit line] [installer first name]
 */

export type PrepTemplates = {
  emailSubject: string;
  emailBody: string;
  /** [arrival] in the email when the day has a window. */
  emailArrivalWindow: string;
  /** [arrival] in the email when the installer and the site sort the time out. */
  emailArrivalCall: string;
  emailFurnitureYes: string;
  emailFurnitureNo: string;
  /** [unit section]: units and apartments only. */
  emailUnitSection: string;
  smsBody: string;
  smsArrivalWindow: string;
  smsArrivalCall: string;
  /** [unit line]: units and apartments only. */
  smsUnitLine: string;
  omwSms: string;
};

export const PREP_DEFAULTS: PrepTemplates = {
  emailSubject: "Getting ready for your flooring install on [day, date]",
  emailBody: [
    "Hi [first name],",
    "",
    "Your new flooring goes in on [day, date]. [arrival]",
    "",
    "Can't be home? That's fine. You can leave a key with a neighbour, in the letterbox or in a safe spot on site. Just reply with where it is (a photo helps).",
    "",
    "To help the day run smoothly, please:",
    "- [furniture]",
    "- Keep pets secured well away from the work area for the whole day.",
    "- Keep young children out of the work area. There are tools, blades and adhesives on site.",
    "- Make sure we can park close by and get in easily.",
    "[unit section]",
    "If anything changes, just reply to this email or call us on 1300 183 772.",
    "",
    "Kind regards,",
    "Team Terra",
  ].join("\n"),
  emailArrivalWindow:
    "Our installer will arrive between [window]. We can't give an exact time because things on the road and on other jobs can change, but we'll text you when we're on our way.",
  emailArrivalCall: "Our installer will call you to arrange a time. We'll text you when we're on our way.",
  emailFurnitureYes: "Pack away small items, ornaments, valuables and anything fragile. We'll move the furniture, but please clear out personal belongings first.",
  emailFurnitureNo: "Please have the rooms clear of furniture and belongings before we arrive.",
  emailUnitSection: [
    "Because you're in a unit or apartment, please arrange these with your body corporate or building manager before install day:",
    "- Fire alarm isolation: our work can create dust that may set off smoke detectors. Please ask building management to isolate the detectors in your unit for the day. Terra Flooring isn't responsible for fire brigade call-out costs if this isn't arranged.",
    "- Lift booking: please book the lift for us and arrange for it to be padded. We can't do this ourselves.",
    "- Parking and access: let us know where we can park and unload, plus any access cards or codes.",
    "- Building rules: let us know any approved work hours or flooring rules.",
    "",
    "Please reply to confirm these are arranged.",
  ].join("\n"),
  smsBody:
    "Hi [first name], Terra Flooring here. We're installing your floor tomorrow, [arrival]. We'll text when we're on our way. Not home? Leave a key somewhere safe and reply with where. Please put valuables away, and keep pets and kids clear of the work area.[unit line] 1300 183 772",
  smsArrivalWindow: "arriving between [window]",
  smsArrivalCall: "and the installer will call you to arrange a time",
  smsUnitLine: "Reminder: fire alarm isolation and a padded lift booked with your building manager.",
  omwSms: "Hi [first name], [installer first name] from Terra Flooring is on the way now.",
};

export const PREP_TEMPLATE_LABELS: Array<[keyof PrepTemplates, string, boolean]> = [
  ["emailSubject", "Install email: subject", false],
  ["emailBody", "Install email: body", true],
  ["emailArrivalWindow", "Install email: [arrival] when the day has a window", true],
  ["emailArrivalCall", "Install email: [arrival] when the installer and site sort the time", true],
  ["emailFurnitureYes", "Install email: [furniture] when we move the furniture", true],
  ["emailFurnitureNo", "Install email: [furniture] when we don't", true],
  ["emailUnitSection", "Install email: [unit section], units and apartments only", true],
  ["smsBody", "Day before text", true],
  ["smsArrivalWindow", "Day before text: [arrival] when the day has a window", false],
  ["smsArrivalCall", "Day before text: [arrival] when the installer and site sort the time", false],
  ["smsUnitLine", "Day before text: [unit line], units and apartments only", true],
  ["omwSms", "On my way text", true],
];

export function parsePrepTemplates(raw: string | null | undefined): PrepTemplates {
  let v: Record<string, unknown> = {};
  try {
    v = JSON.parse(raw || "{}") ?? {};
  } catch {
    v = {};
  }
  const out = { ...PREP_DEFAULTS };
  for (const k of Object.keys(PREP_DEFAULTS) as Array<keyof PrepTemplates>) {
    const x = v[k];
    if (typeof x === "string" && x.trim()) out[k] = x;
  }
  return out;
}

/** "07:00" to "7am", "07:30" to "7:30am". */
export function hm(hhmm: string | null | undefined): string | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m[2] === "00" ? "" : `:${m[2]}`}${h >= 12 ? "pm" : "am"}`;
}

/** "7am and 11am", or "7 and 11am" short for a text. Never one exact time. */
export function windowText(start: string, end: string, short = false): string {
  const a = hm(start) ?? start;
  const b = hm(end) ?? end;
  if (short && a.slice(-2) === b.slice(-2)) return `${a.slice(0, -2)} and ${b}`;
  return `${a} and ${b}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday 19/11/2026". Dates read DD/MM/YYYY (notes 18.52). */
export function dayDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay()]!;
  return `${wd} ${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

export type PrepFacts = {
  firstName: string;
  /** YYYY-MM-DD */
  date: string;
  /** Null when the installer and the site sort the time out. */
  window: { start: string; end: string } | null;
  furnitureMoving: boolean;
  unit: boolean;
  installerFirstName?: string;
};

const fill = (s: string, tokens: Record<string, string>) => s.replace(/\[([a-z ,]+)\]/gi, (all, k: string) => (k.toLowerCase() in tokens ? tokens[k.toLowerCase()]! : all));

/** The install email, 3 days before the first day. */
export function renderInstallEmail(t: PrepTemplates, f: PrepFacts) {
  const base = { "first name": f.firstName || "there", "day, date": dayDate(f.date) };
  const arrival = f.window ? fill(t.emailArrivalWindow, { window: windowText(f.window.start, f.window.end) }) : t.emailArrivalCall;
  const unit = f.unit ? `\n${t.emailUnitSection.trim()}\n` : "";
  const body = fill(t.emailBody, {
    ...base,
    arrival,
    furniture: f.furnitureMoving ? t.emailFurnitureYes : t.emailFurnitureNo,
    "unit section": unit,
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { subject: fill(t.emailSubject, base).trim(), body };
}

/** The day before text, one for every booked day. */
export function renderDaySms(t: PrepTemplates, f: PrepFacts) {
  const arrival = f.window ? fill(t.smsArrivalWindow, { window: windowText(f.window.start, f.window.end, true) }) : t.smsArrivalCall;
  return fill(t.smsBody, {
    "first name": f.firstName || "there",
    "day, date": dayDate(f.date),
    arrival,
    "unit line": f.unit ? ` ${t.smsUnitLine.trim()}` : "",
  })
    .replace(/ {2,}/g, " ")
    .trim();
}

/** On my way. No time, ever. */
export function renderOmwSms(t: PrepTemplates, f: { firstName: string; installerFirstName: string }) {
  return fill(t.omwSms, { "first name": f.firstName || "there", "installer first name": f.installerFirstName || "Your installer" }).trim();
}
