/* ---------------------------------------------------------------------------
 * What a quote is for, worked out from its own lines (Damien, 17 Nov 2026).
 *
 * Pure: facts in, wording out. No database, so the Send screen, Settings and
 * the tests all read the same thing. Every customer message about a quote
 * (the email, the text, the follow-ups, the signed copy and the accept page)
 * takes its wording from here, so a repair quote never talks about colours
 * and a supply only quote never talks about an install date.
 *
 * Rules:
 *   - Repairs: arranging the repairs. No colour or flooring talk.
 *   - Sanding and coating: a finish is only mentioned when it is still to be
 *     confirmed on the quote.
 *   - Supply and install: colour is only asked about when it is not settled.
 *   - Install only: never says we will order the flooring.
 *   - Supply only: pickup or delivery. No install, no dates.
 *   - Mixed: a short combination. New timber with sanding reads as one job:
 *     "the supply, installation, sanding and coating of your new timber
 *     flooring".
 *   - Decks (Damien, 17 Nov 2026): oiling never says sanding, a deck build
 *     says decking, deck repairs say deck. Floors and a deck on one quote
 *     name both.
 *   - Removal, prep or other trades only: says what it is, "the removal of
 *     your existing timber flooring".
 *   - Can not tell: plain wording and a note for the office to check.
 *   - Photos are only mentioned when the client sent some, a visit only when
 *     one happened. Never "reviewed".
 * ------------------------------------------------------------------------- */

import { andList, FLOOR_CATEGORIES } from "./quote-followup-wording";

export type MessageLine = {
  kind: string;
  description: string;
  /** The product's category, when the line has a product. */
  category?: string | null;
  /** The product's colour, when the line has a product. */
  colour?: string | null;
  hasProduct?: boolean;
  /** The labour rate's group (carpet, resilient, timber, prep, trades...). */
  rateGroup?: string | null;
};

export type MessageFacts = {
  lines: MessageLine[];
  /** The client sent photos or video in (the repair form, the enquiry form). */
  photosReceived: boolean;
  /** Someone from Terra has been out to the site. */
  siteVisitDone: boolean;
  suburb: string | null;
  /** The timber repair request on the job, when there is one. */
  repair: { type: string; floorType: string } | null;
  depositAmount: number;
  depositPaid: boolean;
  /** Picked on the selection form, so colour is not asked about again. */
  coloursChosen: string[];
  /** A builder, property manager or other company. */
  trade: boolean;
};

export type WorkType = "repairs" | "sand_coat" | "supply_install" | "install_only" | "supply_only" | "mixed" | "prep" | "unclear";
export type DepositState = "required" | "none" | "paid";
export type Arrangement = "delivery" | "pickup" | "unknown";

export const WORK_LABEL: Record<WorkType, string> = {
  repairs: "Repairs",
  sand_coat: "Sanding and coating",
  supply_install: "Supply and install",
  install_only: "Install only",
  supply_only: "Supply only",
  mixed: "Mixed work",
  prep: "Removal, prep or trades",
  unclear: "Not clear from the lines",
};

export type MessageContext = {
  work: WorkType;
  workLabel: string;
  /** "the timber floor repairs". Reads after "your quote for". */
  scope: string;
  /** For the text: "the timber floor repairs at Highgate Hill". */
  smsScope: string;
  /** For the subject: "timber floor repair", as in "Your timber floor repair quote". */
  title: string;
  /** "Highgate Hill", or "" when there is no suburb. */
  suburb: string;
  /** The first lines of the email. */
  opening: string;
  /** "You can review the repair work included and accept your quote using the link below:" */
  reviewLine: string;
  /** What happens after they accept, with the deposit. */
  nextSteps: string;
  depositState: DepositState;
  colourOutstanding: boolean;
  finishOutstanding: boolean;
  /** Supply and install: we order the flooring once accepted. */
  ordersFlooring: boolean;
  arrangement: Arrangement;
  /** On the signed copy and the accept page, after they have accepted. */
  afterAccept: (depositDue: boolean) => string;
  /** Under the bank details: "We order your flooring once the deposit lands." or "". */
  depositNote: string;
  /** For the office to check before it goes. Never blocks sending. */
  review: string[];
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** "highgate hill" and "HIGHGATE HILL" become "Highgate Hill". "McDowall" is left alone. */
export function suburbName(raw: string | null | undefined) {
  const s = clean(raw);
  if (!s || (s !== s.toLowerCase() && s !== s.toUpperCase())) return s;
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ------------------------------ the lines -------------------------------- */

const SKIP_KINDS = new Set(["supplier_charge", "internal_charge"]);
const WORK_KINDS = new Set(["labour", "other", "prep", "removal"]);
const DELIVERY_WORDS = /deliver|courier|freight|cartage|transport|unload|pick ?up|collect|crane|crain|jocks|hand unload/i;
const PICKUP_WORDS = /(customer|client|owner)\b.{0,12}(pick|collect)|click (and|&) collect|(pick ?up|collect(ed|ion)?) by (the )?(customer|client|owner)|customer to collect/i;
const PREP_RE = /level|grind|moisture|\bskim|smoothing|screed|\bprime|uplift|remov|dispos|dump|skip bin|hardboard|demoli/i;
const REPAIR_RE = /\brepair|\bpatch|scratch|gouge|water damage|replace.*board|board.*replace|pot plant|\bdent/i;
const SAND_RE = /\bsand(s|ing|ed)?\b|\bcoat(s|ing)?\b|refinish|polish|\bstain|varnish|\boil(ed|ing|s)?\b/i;
const INSTALL_RE = /install|\blay(ing)?\b|\bfit(ting|ted)?\b|broadloom|glue ?down|floating|\bstairs?\b|\bdeck\w*\b.{0,30}\b(build|construct)|\b(build|construct)\w*\b.{0,30}\bdeck|\bjoists?\b|\bbearers?\b|sub ?fram/i;
/** Other trades: not flooring work. */
const TRADE_RE = /skirting|bedding|waterproof|architrave|painting|plaster|tiling/i;
const FLOOR_GROUPS = new Set(["carpet", "resilient", "timber"]);
const FLOOR_WORDS = /carpet|hybrid|laminate|vinyl|timber|\boak\b|plank|\blvt\b|flooring|engineered|parquet|cork|\bdeck/i;
const NOT_FLOOR = /underlay|trim|scotia|nosing|adhesive|glue|skirting|sealant|primer|compound|threshold|reducer|edge|screw|\boil\b|\bstain|cleaner|joist|bearer/i;
const DECK_RE = /\bdeck/i;
const REMOVAL_RE = /uplift|remov|dispos|dump|strip|take up|pull up|demoli/i;
const UNSETTLED = /\b(tbc|tba|to be (confirmed|chosen|selected|advised)|choose|select(ed)? (by|later)|colour to)\b/i;
const FINISH_TBC = /(finish|sheen|stain|colour)[^.]{0,30}\b(tbc|tba|to be confirmed)\b|\b(tbc|tba|to be confirmed)\b[^.]{0,30}(finish|sheen|stain)/i;

type Role = "skip" | "delivery" | "pickup" | "prep" | "repair" | "sand" | "install" | "trade" | "floor" | "supply" | "neutral";

/** What one line is. */
export function lineRole(l: MessageLine): Role {
  const kind = clean(l.kind).toLowerCase();
  const text = clean(l.description);
  const group = clean(l.rateGroup).toLowerCase();
  if (SKIP_KINDS.has(kind)) return "skip";
  if (PICKUP_WORDS.test(text)) return "pickup";
  /* "Hardboard removal and sand floor" was saved as a delivery line. Only real delivery words count as delivery. */
  const asKind = kind === "delivery" ? (DELIVERY_WORDS.test(text) ? "delivery" : "other") : kind;
  if (asKind === "delivery") return "delivery";
  if (asKind === "supply" || asKind === "accessory") {
    const cat = clean(l.category).toLowerCase();
    if (cat && FLOOR_CATEGORIES.includes(cat)) return "floor";
    if (!cat && FLOOR_WORDS.test(text) && !NOT_FLOOR.test(text)) return "floor";
    return "supply";
  }
  if (group === "trades" || TRADE_RE.test(text)) return "trade";
  if (asKind === "prep" || asKind === "removal" || group === "prep" || group === "demolition" || PREP_RE.test(text)) return "prep";
  if (!WORK_KINDS.has(asKind)) return "neutral";
  if (REPAIR_RE.test(text)) return "repair";
  if (SAND_RE.test(text)) return "sand";
  if (FLOOR_GROUPS.has(group) || INSTALL_RE.test(text)) return "install";
  return "neutral";
}

const CATEGORY_WORDS: Record<string, string> = {
  carpet: "carpet",
  carpet_tile: "carpet tiles",
  laminate: "laminate flooring",
  engineered_timber: "engineered timber flooring",
  solid_timber: "timber flooring",
  timber: "timber flooring",
  hybrid: "hybrid flooring",
  vinyl: "vinyl flooring",
  lvt: "vinyl plank flooring",
  sheet_vinyl: "sheet vinyl",
};

/** "hybrid flooring" from a line with no category, by its words. */
function wordsFromText(text: string) {
  const t = text.toLowerCase();
  if (/\bdeck/.test(t)) return "decking";
  if (/carpet tile/.test(t)) return "carpet tiles";
  if (/carpet|broadloom/.test(t)) return "carpet";
  if (/hybrid/.test(t)) return "hybrid flooring";
  if (/laminate/.test(t)) return "laminate flooring";
  if (/sheet vinyl/.test(t)) return "sheet vinyl";
  if (/vinyl|\blvt\b/.test(t)) return "vinyl flooring";
  if (/\bcork\b/.test(t)) return "cork flooring";
  if (/engineered/.test(t)) return "engineered timber flooring";
  if (/timber|\boak\b|parquet/.test(t)) return "timber flooring";
  return "";
}

/** "carpet and hybrid flooring". Falls back to "flooring". */
function floorWordsOf(floor: MessageLine[], install: MessageLine[]) {
  const words: string[] = [];
  const add = (w: string) => {
    if (w && !words.includes(w)) words.push(w);
  };
  for (const l of floor) add(DECK_RE.test(clean(l.description)) ? "decking" : (CATEGORY_WORDS[clean(l.category).toLowerCase()] ?? wordsFromText(clean(l.description))));
  if (!words.length) {
    for (const l of install) {
      const g = clean(l.rateGroup).toLowerCase();
      add(wordsFromText(clean(l.description)) || (g === "carpet" ? "carpet" : g === "timber" ? "timber flooring" : ""));
    }
  }
  if (!words.length) return "flooring";
  /* "engineered timber flooring" already says timber. */
  const specific = words.filter((w) => !(w === "timber flooring" && words.some((o) => o !== w && o.endsWith("timber flooring"))));
  /* "carpet, engineered timber and hybrid flooring" reads better than "flooring" three times. */
  const shown = specific.slice(0, 3);
  const flooring = shown.filter((w) => w.endsWith(" flooring"));
  if (flooring.length > 1) {
    const rest = shown.filter((w) => !w.endsWith(" flooring"));
    return `${andList([...rest, ...flooring.map((w) => w.replace(/ flooring$/, ""))])} flooring`;
  }
  return andList(shown);
}

/* ------------------------- sanding, decks, prep -------------------------- */

/** Floors: "sanding and coating", or "sanding, staining and coating". As before. */
function floorTreatment(text: string) {
  return /\bstain/i.test(text) ? "sanding, staining and coating" : "sanding and coating";
}

/**
 * Decks (Damien, 17 Nov 2026): only what the lines say. "Deck clean and oil"
 * is "cleaning and oiling", never sanding.
 */
function deckTreatment(text: string) {
  const t = text.toLowerCase();
  const sanded = /\bsand(s|ing|ed)?\b/.test(t);
  const stain = /\bstain/.test(t);
  const oil = /\boil(ed|ing|s)?\b/.test(t) && !/poly|varnish|2 ?pac/.test(t);
  const finish = oil ? "oiling" : sanded || /\bcoat|poly|varnish|2 ?pac|seal/.test(t) || !stain ? "coating" : "";
  const words = sanded ? ["sanding", stain ? "staining" : "", finish] : [/clean|wash/.test(t) ? "cleaning" : "", stain ? "staining" : "", finish];
  return { words: andList(words.filter(Boolean)), sanded };
}

/** "timber flooring" from "Bonded timber removal on acoustic rubber". */
function removedWhat(text: string) {
  const t = text.toLowerCase();
  if (/carpet tile/.test(t)) return "carpet tiles";
  if (/carpet/.test(t)) return "carpet";
  if (/vinyl|\blino/.test(t)) return "vinyl";
  if (/\btiles?\b/.test(t)) return "tiles";
  if (/hardboard/.test(t)) return "hardboard";
  if (/\bcork\b/.test(t)) return "cork flooring";
  if (/hybrid/.test(t)) return "hybrid flooring";
  if (/laminate/.test(t)) return "laminate flooring";
  if (/floating/.test(t)) return "floating floor";
  if (/\bdeck/.test(t)) return "decking";
  if (/timber|parquet|engineered|\bboards?\b/.test(t)) return "timber flooring";
  return "flooring";
}

/** What other prep is: "floor levelling", "floor grinding", or "floor preparation". */
function prepWhat(text: string) {
  const t = text.toLowerCase();
  if (/level|screed|smoothing|\bskim|patch/.test(t)) return "floor levelling";
  if (/grind/.test(t)) return "floor grinding";
  if (/moisture/.test(t)) return "moisture treatment";
  return "floor preparation";
}

/** Other trades: "skirting work", "painting". */
function tradeWhat(text: string) {
  const t = text.toLowerCase();
  if (/skirting/.test(t)) return "skirting work";
  if (/architrave/.test(t)) return "architrave work";
  if (/painting/.test(t)) return "painting";
  if (/plaster/.test(t)) return "plastering";
  if (/tiling/.test(t)) return "tiling";
  if (/waterproof/.test(t)) return "waterproofing";
  return "trade work";
}

/* ------------------------------ the wording ------------------------------ */

type Part = "repair" | "sand" | "flooring";

/** Everything the messages say about this quote. */
export function quoteMessageContext(f: MessageFacts): MessageContext {
  const review: string[] = [];
  const by: Record<Role, MessageLine[]> = { skip: [], delivery: [], pickup: [], prep: [], repair: [], sand: [], install: [], trade: [], floor: [], supply: [], neutral: [] };
  for (const l of f.lines) by[lineRole(l)].push(l);

  const suburb = suburbName(f.suburb);
  const allText = f.lines.map((l) => clean(l.description)).join(" ");
  const hasRepair = by.repair.length > 0;
  const hasSand = by.sand.length > 0;
  const hasInstall = by.install.length > 0;
  const hasFloor = by.floor.length > 0;
  const anySupply = hasFloor || by.supply.length > 0;

  /* Which kinds of work are on the quote. */
  const parts: Part[] = [];
  if (hasRepair) parts.push("repair");
  if (hasSand) parts.push("sand");
  /* "Labor Pedro", "Day rate, leading hand": labour, but not saying what for. */
  const plainLabour = by.neutral.some((l) => clean(l.kind).toLowerCase() === "labour");
  let flooring: "supply_install" | "install_only" | "supply_only" | null = null;
  if (hasInstall) flooring = hasFloor ? "supply_install" : "install_only";
  else if (hasFloor && hasRepair) {
    /* Boards for the repair: materials for that work, nothing to word separately. */
  } else if (hasFloor && hasSand) {
    review.push("Flooring is on the quote with the sanding work, but there is no install line. Check the wording fits.");
  } else if (hasFloor && (by.prep.length || plainLabour)) {
    flooring = "supply_install";
    review.push(`Flooring and ${by.prep.length ? "floor prep" : "labour"} are quoted but no install line, so it is worded as supply and install. Check that is right.`);
  } else if (anySupply && !hasRepair && !hasSand && !by.prep.length && !by.trade.length && !plainLabour) flooring = "supply_only";
  if (flooring) parts.push("flooring");

  let work: WorkType;
  if (parts.length > 1) work = "mixed";
  else if (parts[0] === "repair") work = "repairs";
  else if (parts[0] === "sand") work = "sand_coat";
  else if (flooring) work = flooring;
  /* Damien, 17 Nov 2026: removal, levelling or skirting with nothing else says what it is. */
  else if (!hasFloor && (by.prep.length || by.trade.length)) work = "prep";
  else work = "unclear";
  if (work === "unclear") review.push("Could not tell from the quote lines what the work is, so the email uses general wording. Check it before sending.");

  /* The repair words: timber from the repair form or the lines. */
  const repairText = by.repair.map((l) => `${clean(l.description)} ${clean(l.rateGroup)}`).join(" ").toLowerCase();
  const floorType = clean(f.repair?.floorType).toLowerCase();
  /* Damien, 17 Nov 2026: a deck or cork repair says so. */
  const repairWhat = (() => {
    if (DECK_RE.test(repairText)) return "deck";
    if (/\bcork\b/.test(repairText) || /\bcork\b/.test(floorType)) return "cork floor";
    if (f.repair && (!floorType || /engineer|solid|timber|hardwood|parquet/.test(floorType))) return "timber floor";
    if (/carpet/.test(repairText) || /carpet/.test(floorType)) return "carpet";
    if (/timber|hardwood|parquet|engineer/.test(repairText) || /engineer|solid|timber/.test(floorType)) return "timber floor";
    return "floor";
  })();
  /* Floors and a deck: each named for what is done to it (Damien, 17 Nov 2026). */
  const deckSand = by.sand.filter((l) => DECK_RE.test(clean(l.description)));
  const floorSand = by.sand.filter((l) => !DECK_RE.test(clean(l.description)));
  const floorT = floorTreatment(floorSand.map((l) => clean(l.description)).join(" "));
  const deck = deckTreatment(deckSand.map((l) => clean(l.description)).join(" "));
  /* sandScope reads after "the". sandTitle is the short one for the subject. */
  let sandScope: string;
  let sandTitle: string;
  if (!deckSand.length) sandScope = sandTitle = `floor ${floorT}`;
  else if (!floorSand.length) sandScope = sandTitle = `deck ${deck.words}`;
  else if (deck.words === floorT || (deck.sanded && !deck.words.includes("oiling"))) {
    sandScope = `floor and deck ${/\bstain/i.test(by.sand.map((l) => clean(l.description)).join(" ")) ? "sanding, staining and coating" : "sanding and coating"}`;
    sandTitle = "floor and deck sanding";
  } else {
    sandScope = `floor ${floorT} and the deck ${deck.words}`;
    sandTitle = deck.sanded ? "floor and deck sanding" : `floor sanding and deck ${deck.words.split(" ").pop()}`;
  }
  /* Floors only keep "the sanding and coating", as before. */
  const sandTime = !deckSand.length ? "the sanding and coating" : `the ${sandScope}`;
  const words = floorWordsOf(by.floor, by.install);
  const decking = words === "decking";
  /* New timber that is sanded once it is down: one job, in the order it is done. */
  const timberSand =
    flooring === "supply_install" && hasSand && !hasRepair && !deckSand.length && /(timber|cork|parquet) flooring$/.test(words) && !/carpet|hybrid|laminate|vinyl|tiles|decking/.test(words);
  const orderWhat = decking ? "your decking" : "your flooring";

  const partScope: Record<Part, string> = {
    repair: `the ${repairWhat} repairs`,
    sand: `the ${sandScope}`,
    flooring:
      flooring === "supply_install"
        ? `the supply and installation of your new ${words}`
        : flooring === "install_only"
          ? `the installation of your ${words}`
          : hasFloor
            ? `the supply of your ${words}`
            : "the supply of your flooring materials",
  };
  const partTitle: Record<Part, string> = {
    repair: `${repairWhat} repair`,
    sand: sandTitle,
    flooring: flooring === "supply_install" ? words : flooring === "install_only" ? `${words} installation` : hasFloor ? `${words} supply` : "flooring materials",
  };
  const partShort: Record<Part, string> = {
    repair: `the ${repairWhat} repairs`,
    sand: `the ${sandScope}`,
    flooring: flooring === "supply_only" ? `the supply of your ${hasFloor ? words : "flooring materials"}` : flooring === "install_only" ? `installing your ${words}` : `your new ${words}`,
  };

  /* Flooring first, the order the work is done in. */
  const ordered = (["flooring", "repair", "sand"] as Part[]).filter((p) => parts.includes(p));
  /* Removal, prep or trades only: "the removal of your existing carpet and the floor levelling". */
  const removed = [...new Set(by.prep.filter((l) => REMOVAL_RE.test(clean(l.description))).map((l) => removedWhat(clean(l.description))))];
  const removedList = removed.length > 1 ? removed.filter((w) => w !== "flooring") : removed;
  const otherJobs = [
    ...new Set([
      ...by.prep.filter((l) => !REMOVAL_RE.test(clean(l.description))).map((l) => prepWhat(clean(l.description))),
      ...by.trade.map((l) => tradeWhat(clean(l.description))),
    ]),
  ];
  const prepScope = andList([removedList.length ? `the removal of your existing ${andList(removedList)}` : "", otherJobs.length ? `the ${andList(otherJobs)}` : ""]);
  const prepTitle = andList([removedList.length ? `${andList(removedList)} removal` : "", ...otherJobs]);
  const scope =
    work === "unclear"
      ? "the quoted work"
      : work === "prep"
        ? prepScope
        : timberSand
          ? `the supply, installation, ${floorT} of your new ${words}`
          : ordered.map((p) => partScope[p]).join(" plus ");
  /* Mixed keeps the subject short: "timber flooring and floor sanding", flooring first. */
  const mixedTitle: Record<Part, string> = {
    repair: `${repairWhat} repair`,
    sand: !deckSand.length ? (hasRepair ? "sanding" : "floor sanding") : !floorSand.length ? (deck.sanded ? "deck sanding" : `deck ${deck.words}`) : sandTitle,
    flooring: flooring === "supply_only" ? `${hasFloor ? words : "flooring materials"} supply` : flooring === "install_only" ? `${words} installation` : words,
  };
  const mixedOrder: Part[] = ["flooring", "repair", "sand"];
  const title =
    work === "unclear"
      ? "Terra Flooring"
      : work === "prep"
        ? prepTitle
        : timberSand
          ? `${words} and sanding`
          : work === "mixed"
            ? andList(mixedOrder.filter((p) => parts.includes(p)).map((p) => mixedTitle[p]))
            : partTitle[parts[0]];
  const at = suburb ? ` at ${suburb}` : "";
  let smsScope = work === "unclear" ? `the quoted work${at}` : `${parts.length > 1 && !timberSand ? andList(ordered.map((p) => partShort[p])) : scope}${at}`;
  if (smsScope.length > 150) smsScope = `the quoted work${at}`;

  /* How it gets to them. */
  const arrangement: Arrangement = by.pickup.length ? "pickup" : by.delivery.length ? "delivery" : "unknown";
  const supplyOnly = work === "supply_only";
  if (supplyOnly && arrangement === "unknown") review.push("Supply only, with no delivery or pickup line, so it says pickup or delivery. Change it if you know which.");

  /* Colour and finish: only when the quote leaves them open. */
  const floorPart = flooring === "supply_install" || flooring === "supply_only";
  const colourOutstanding =
    floorPart &&
    hasFloor &&
    !decking &&
    !f.coloursChosen.length &&
    by.floor.some((l) => !l.hasProduct || !clean(l.colour) || UNSETTLED.test(clean(l.description)) || UNSETTLED.test(clean(l.colour)));
  const finishOutstanding = hasSand && FINISH_TBC.test(allText);
  const ordersFlooring = flooring === "supply_install";

  const depositState: DepositState = f.depositPaid ? "paid" : f.depositAmount > 0 ? "required" : "none";

  /* What we do once they accept. */
  const confirms = [colourOutstanding ? "confirm your colour choice" : "", finishOutstanding ? "confirm the finish with you" : ""].filter(Boolean);
  const times: string[] = [];
  if (timberSand) times.push(`the installation, ${floorT}`);
  else {
    if (parts.includes("repair")) times.push("the repairs");
    if (flooring === "supply_install" || flooring === "install_only") times.push("the installation");
    if (parts.includes("sand")) times.push(sandTime);
  }
  if (work === "prep") {
    if (removedList.length) times.push("the removal");
    for (const j of otherJobs) times.push(`the ${j}`);
  }
  let arrange: string;
  if (work === "unclear") arrange = "contact you about the next steps";
  else if (supplyOnly) arrange = arrangement === "pickup" ? "let you know when it's ready to collect" : arrangement === "delivery" ? "contact you to arrange delivery" : "contact you to arrange pickup or delivery";
  else if (times.length === 1 && times[0] === "the installation") arrange = "contact you to arrange a suitable installation time";
  else arrange = `contact you to arrange a suitable time for ${andList(times)}`;
  const order = ordersFlooring ? [`order ${orderWhat}`] : supplyOnly ? ["place your order"] : [];
  const actions = [...confirms, ...order, arrange];
  const prefix =
    depositState === "required"
      ? "Once you have accepted the quote and paid the deposit, we'll "
      : depositState === "none"
        ? "No deposit is required. Once you have accepted the quote, we'll "
        : "Once you have accepted the quote, we'll ";
  const nextSteps = `${prefix}${andList(actions)}.`;

  /* After the accept: the deposit note covers the order, so this is the rest. */
  const afterAccept = (depositDue: boolean) => {
    if (supplyOnly && arrangement === "pickup") return depositDue ? "We'll let you know when your order is ready to collect." : "We'll place your order and let you know when it's ready to collect.";
    if (work === "unclear") return "We'll be in touch about the next steps.";
    const rest = arrange.replace(/^contact you to /, "");
    const what = andList([...confirms, rest]);
    if (!depositDue && (ordersFlooring || supplyOnly)) return `We'll ${ordersFlooring ? `order ${orderWhat}` : "place your order"} and be in touch to ${what}.`;
    return `We'll be in touch to ${what}.`;
  };
  const depositNote = ordersFlooring ? `We order ${orderWhat} once the deposit lands.` : supplyOnly ? "We place your order once the deposit lands." : "";

  /* The opening: only what actually happened. */
  const thanks = f.siteVisitDone
    ? "Thank you for having us out."
    : f.photosReceived
      ? "Thank you for sending through the photos."
      : f.trade
        ? "Thank you for the opportunity to quote."
        : "Thank you for your enquiry.";
  const where = suburb ? (f.trade ? ` at ${suburb}` : ` at your ${suburb} property`) : "";
  const opening = `${thanks} Please find your quote for ${scope}${where}.`;

  const reviewWhat: Record<WorkType, string> = {
    repairs: "the repair work included",
    sand_coat:
      floorSand.length && deckSand.length
        ? "the floor and deck work included"
        : deckSand.length && (!deck.sanded || deck.words.includes("oiling"))
          ? "the deck work included"
          : "the sanding and coating work included",
    supply_install: decking ? "the decking and installation included" : "the flooring and installation included",
    install_only: "the installation work included",
    supply_only: "the products included",
    mixed: timberSand ? "the flooring, installation and sanding included" : "the work included",
    prep: "the work included",
    unclear: "everything included",
  };
  /* For the Send screen: a little more than the type, "Deck oiling", "Deck build". */
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const workLabel =
    work === "sand_coat" && deckSand.length
      ? cap(sandTitle)
      : (work === "supply_install" || work === "install_only") && decking
        ? "Deck build"
        : work === "repairs" && repairWhat === "deck"
          ? "Deck repairs"
          : timberSand
            ? "Supply, install and sanding"
            : work === "prep"
              ? cap(andList([removedList.length ? "removal" : "", by.prep.some((l) => !REMOVAL_RE.test(clean(l.description))) ? "floor prep" : "", by.trade.length ? "trades" : ""]))
              : WORK_LABEL[work];
  const reviewLine = `You can review ${reviewWhat[work]} and accept your quote using the link below:`;

  return {
    work,
    workLabel,
    scope,
    smsScope,
    title,
    suburb,
    opening,
    reviewLine,
    nextSteps,
    depositState,
    colourOutstanding,
    finishOutstanding,
    ordersFlooring,
    arrangement,
    afterAccept,
    depositNote,
    review,
  };
}

/** The deposit figure for the email: "$1,458.60", "$1,458.60 received, thank you", or "" for none. */
export function depositValue(state: DepositState, amount: number) {
  if (state === "none" || amount <= 0) return "";
  return state === "paid" ? `${money(amount)} received, thank you` : money(amount);
}
