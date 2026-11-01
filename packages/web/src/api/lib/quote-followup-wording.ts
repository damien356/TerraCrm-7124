/* ---------------------------------------------------------------------------
 * Quote follow-up wording (28 Oct). Pure: facts in, email out. No database.
 *
 * Damien's rules:
 *   - Warm Australian English, 60 to 120 words in the body, one main question.
 *   - Only what is on the quote: the product, range and colour, the rooms,
 *     the prep that was actually quoted. Never a benefit, a discount, a date,
 *     availability or prep that is not there.
 *   - A provisional allowance is called one, word for word as the quote has it.
 *   - Builders and other companies get wording about their project and their
 *     approval process. No colour questions for them.
 *   - Nothing already answered is asked again (a colour already picked on the
 *     selection form, a start date already on the job).
 *   - Missing data: simpler wording, and the draft is flagged for a person to
 *     read before it goes when the gap matters.
 *   - Every email carries the quote link, a reply address that is read (team@,
 *     filed onto the job by the reply pass), the staff member's signature,
 *     who Terra Flooring is, and a working unsubscribe.
 * ------------------------------------------------------------------------- */

/** The number on every follow-up (Damien, 28 Oct: the digits, not "1300 1 TERRA"). */
export const FOLLOWUP_PHONE = "1300 183 772";
export const FOLLOWUP_STEPS = [3, 7, 14, 25] as const;
/** Insurance builders (Damien, 31 Oct): days 3, 10 and 21, then stop. No sales chasing. */
export const INSURANCE_STEPS = [3, 10, 21] as const;
export const ALL_STEPS = [3, 7, 10, 14, 21, 25] as const;
export type FollowupStep = (typeof ALL_STEPS)[number];
export type FollowupAudience = "homeowner" | "trade" | "insurance";
/** Who the trade wording is written for. Property managers, real estate and commercial follow the builder steps with their own words. */
export type TradeRole = "builder" | "property_manager" | "real_estate" | "commercial";
export const stepsFor = (audience: FollowupAudience): readonly FollowupStep[] => (audience === "insurance" ? INSURANCE_STEPS : FOLLOWUP_STEPS);
export const lastStepFor = (audience: FollowupAudience): FollowupStep => (audience === "insurance" ? 21 : 25);
export const STEP_PURPOSE: Partial<Record<FollowupStep, string>> = {
  3: "Product and colour",
  7: "Prep and removal quoted",
  14: "Timing and help to decide",
  25: "Still considering, or pause? Last one",
};
export const TRADE_STEP_PURPOSE: Partial<Record<FollowupStep, string>> = {
  3: "Reached the right person for approval?",
  7: "Scope check against the plans",
  14: "Program and start date",
  25: "Still going ahead? Last one",
};
export const INSURANCE_STEP_PURPOSE: Partial<Record<FollowupStep, string>> = {
  3: "Received? Anything needed for approval",
  10: "Anything outstanding for the insurer?",
  21: "Approval status. Last one",
};
export function purposeFor(audience: FollowupAudience, step: number) {
  const m = audience === "insurance" ? INSURANCE_STEP_PURPOSE : audience === "trade" ? TRADE_STEP_PURPOSE : STEP_PURPOSE;
  return m[step as FollowupStep] ?? `Day ${step}`;
}

export const WORDS_MIN = 60;
export const WORDS_MAX = 120;

export type FloorFact = { brand: string; range: string; colour: string; category: string };
export type PrepFact = { description: string; provisional: boolean };

export type FollowupFacts = {
  audience: FollowupAudience;
  /** Trade wording for a builder, a property manager, real estate or a commercial client. */
  tradeRole?: TradeRole;
  /** Insurance: the site address, with the builder ref or work order number after it when set. */
  jobPlace?: string | null;
  firstName: string | null;
  companyName: string | null;
  /** "188034" or "188034-3", as the client sees it. */
  quoteRef: string;
  /** "27 October". */
  sentOn: string;
  link: string | null;
  suburb: string | null;
  floors: FloorFact[];
  rooms: string[];
  /** Labour lines for prep and removal. */
  prepLines: PrepFact[];
  /** Prep products on the quote with no prep labour line (levelling compound, primer). */
  prepProductsOnly: boolean;
  /** Picked on the selection form, so not asked again. */
  coloursChosen: string[];
  /** "26 November": the valid-until date on the quote, when there is one. */
  validUntil: string | null;
  /** A start date already on the job. Timing is not asked again. */
  startDate: string | null;
  signature: { name: string; phone: string; email: string };
  unsubscribeUrl: string | null;
  /** Who it is addressed to. Only shown in the footer when people are copied in. */
  toEmail?: string | null;
  /** People copied in, each with their own unsubscribe link. One link per person, so nobody can unsubscribe someone else. */
  ccUnsubscribe?: Array<{ email: string; url: string }>;
};

export type RenderedFollowup = {
  subject: string;
  /** What the customer reads, signature and footer included. */
  text: string;
  /** The body alone, for the word count. */
  body: string;
  words: number;
  /** Why a person must read it before it goes. Empty = fine to go. */
  review: string[];
  /** Plain notes on choices made (simpler wording used, and why). */
  notes: string[];
  /** Set when this step does not apply at all. */
  skip: string | null;
};

const CATEGORY_WORD: Record<string, string> = {
  carpet: "carpet",
  carpet_tile: "carpet tiles",
  laminate: "laminate",
  engineered_timber: "engineered timber",
  solid_timber: "timber",
  timber: "timber",
  hybrid: "hybrid",
  vinyl: "vinyl",
  lvt: "vinyl plank",
  sheet_vinyl: "sheet vinyl",
};
export const FLOOR_CATEGORIES = Object.keys(CATEGORY_WORD);

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export const countWords = (s: string) => s.replace(/https?:\/\/\S+/g, "link").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;

/** "a, b and c". */
export function andList(items: string[]) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "Belgotex Key West in Casa Marina". Brand and range only when the colour is blank. */
export function floorName(f: FloorFact) {
  const name = clean(`${f.brand} ${f.range}`);
  const colour = clean(f.colour);
  return colour && colour.toLowerCase() !== clean(f.range).toLowerCase() ? `${name} in ${colour}` : name;
}

export const categoryWord = (c: string) => CATEGORY_WORD[c] ?? "flooring";

/** "the carpet and hybrid". */
function floorWords(floors: FloorFact[]) {
  const words = [...new Set(floors.map((f) => categoryWord(f.category)))];
  return words.length ? `the ${andList(words)}` : "your new flooring";
}

function roomsPhrase(f: FollowupFacts) {
  if (f.rooms.length && f.rooms.length <= 4) return ` for the ${andList(f.rooms.map((r) => r.toLowerCase()))}`;
  if (f.rooms.length > 4) return " for the rooms we measured";
  return "";
}

function signatureBlock(f: FollowupFacts) {
  const lines = [f.signature.name, "Terra Flooring", f.signature.phone, f.signature.email].filter(Boolean);
  return lines.join("\n");
}

function footerBlock(f: FollowupFacts) {
  const role = f.tradeRole ?? "builder";
  const why =
    f.audience === "insurance"
      ? "You're getting this because you asked Terra Flooring to quote on this job."
      : f.audience === "trade"
        ? role === "property_manager" || role === "real_estate"
          ? "You're getting this because you asked Terra Flooring to quote on this property."
          : role === "commercial"
            ? "You're getting this because you asked Terra Flooring to quote on this job."
            : "You're getting this because you asked Terra Flooring to quote on this project."
        : "You're getting this because you asked Terra Flooring for a quote.";
  const lines = ["--", `Terra Flooring  ·  ${FOLLOWUP_PHONE}  ·  team@terraflooring.com.au  ·  terraflooring.com.au`, why];
  if (f.unsubscribeUrl && f.ccUnsubscribe?.length) {
    lines.push("Don't want these follow-ups? Each person can unsubscribe with their own link:");
    lines.push(`${f.toEmail ?? "To"}: ${f.unsubscribeUrl}`);
    for (const c of f.ccUnsubscribe) lines.push(`${c.email}: ${c.url}`);
  } else if (f.unsubscribeUrl) lines.push(`Don't want these follow-ups? Unsubscribe: ${f.unsubscribeUrl}`);
  return lines.join("\n");
}

function prepSentence(lines: PrepFact[], productsOnly: boolean) {
  if (!lines.length && productsOnly) return "It includes the floor preparation materials listed on the quote.";
  const names = lines.map((l) => l.description.replace(/\.$/, ""));
  const lower = names.map((n, i) => (i === 0 ? n.charAt(0).toLowerCase() + n.slice(1) : n.toLowerCase()));
  return `It includes ${andList(lower)}.`;
}

const REMOVAL = /uplift|remov|dispos|dump|strip|take up|pull up/i;
/** Name only what is on the quote: "prep", "removal", or "prep or removal". */
function prepTopic(lines: PrepFact[], productsOnly: boolean) {
  const removal = lines.some((l) => REMOVAL.test(l.description));
  const prep = productsOnly || lines.some((l) => !REMOVAL.test(l.description));
  return removal && prep ? "prep or removal" : removal ? "removal" : "prep";
}

function provisionalSentence(lines: PrepFact[]) {
  const prov = lines.filter((l) => l.provisional);
  if (!prov.length) return "";
  const names = prov.map((l) => `"${l.description.replace(/\.$/, "")}"`);
  return ` ${andList(names)} ${prov.length === 1 ? "is" : "are"} listed as ${prov.length === 1 ? "a provisional allowance" : "provisional allowances"}, so ${prov.length === 1 ? "that figure" : "those figures"} can change.`;
}

/**
 * Insurance builder follow-ups (Damien, 31 Oct), word for word. Short on
 * purpose, so the 60 to 120 word check does not apply. Still carries the quote
 * link and the unsubscribe footer.
 */
function renderInsurance(step: FollowupStep, f: FollowupFacts): RenderedFollowup {
  const review: string[] = [];
  const notes: string[] = [];
  const name = f.firstName ?? "there";
  if (!f.firstName) review.push("Insurance quote with no named person. Check who it should go to.");
  if (!f.link) review.push("No quote link yet. It is made when the email goes, so check the preview again.");
  if (!f.unsubscribeUrl) review.push("No unsubscribe link: the person it goes to is not a contact card. Pick a contact first.");
  const place = clean(f.jobPlace) || null;
  if (!place) review.push("No site address and no builder ref on the job. Add one so they know which job it is.");
  const at = place ? ` for ${place}` : "";
  const q = `quote ${f.quoteRef}`;
  let subject = "";
  let line = "";
  if (step === 3) {
    subject = `Quote ${f.quoteRef}${at}`;
    line = `Hi ${name}, just checking you received our ${q}${at}, sent on ${f.sentOn}. Please let us know if you need any scope clarification or further information to progress approval.`;
  } else if (step === 10) {
    subject = `Quote ${f.quoteRef}: anything outstanding?`;
    line = `Hi ${name}, following up on our ${q}${at}. Is there anything outstanding from us that you or the insurer need, such as photos, measurements or a breakdown of the scope? Happy to send it through.`;
  } else if (step === 21) {
    subject = `Quote ${f.quoteRef}: approval status`;
    line = `Hi ${name}, a last check on our ${q}${at}. Could you let us know where approval is up to? If it's still with the insurer, no problem. We'll leave it with you, and we're here if anything changes on the scope.`;
  } else {
    return { subject: "", text: "", body: "", words: 0, review: [], notes, skip: `Insurance jobs only get days 3, 10 and 21.` };
  }
  const linkLine = f.link ? `The quote is here if you need it:\n${f.link}` : `The quote is in our email from ${f.sentOn}.`;
  const who = clean(f.signature.name).split(" ")[0] || "Damien";
  const signOff = `Thanks, ${who}, Terra Flooring, ${FOLLOWUP_PHONE}`;
  const bodyText = [line, linkLine].join("\n\n");
  const text = `${bodyText}\n\n${signOff}\n\n${footerBlock(f)}`;
  return { subject, text, body: bodyText, words: countWords(bodyText), review, notes, skip: null };
}

const TRADE_WORDS: Record<TradeRole, { approval: string; ask3: string; scope: string; program: [string, string]; moved: string; last: string; ahead: string }> = {
  builder: {
    approval: "I know quotes often need to go through a few hands before they're signed off, so I wanted to check it's landed with the right person.",
    ask3: "Is there anything else you need from us to get it through your approval process?",
    scope: "It's worth checking against your plans and schedule of finishes now, so the quote you approve matches the job on site.",
    program: ["Knowing where the flooring sits in your program helps us plan our crews around it once it's approved.", "Do you have a rough start date for the flooring stage yet?"],
    moved: "If anything has moved on the program, or the quote needs updating to suit, I can turn that around for you.",
    last: "If it's still with the client or waiting on other trades, that's fine.",
    ahead: "Is the project still going ahead with us, or should I pause follow-ups for now?",
  },
  property_manager: {
    approval: "I know quotes often need the owner's OK before they can be approved, so I wanted to check it's landed with the right person.",
    ask3: "Is there anything else you or the owner need from us to approve it?",
    scope: "It's worth checking against what the owner has asked for now, so the quote you approve matches the work at the property.",
    program: ["Knowing when the property is available, and whether anyone needs notice, helps us plan our crews once it's approved.", "Do you have a rough timeframe for the work yet?"],
    moved: "If anything has changed with access or the owner's plans, or the quote needs updating to suit, I can turn that around for you.",
    last: "If it's still with the owner, that's fine.",
    ahead: "Is the work still going ahead with us, or should I pause follow-ups for now?",
  },
  real_estate: {
    approval: "I know quotes often need the owner's OK before they can be approved, so I wanted to check it's landed with the right person.",
    ask3: "Is there anything else you or the owner need from us to approve it?",
    scope: "It's worth checking against what the owner has asked for now, so the quote you approve matches the work at the property.",
    program: ["Knowing when the property is available, and whether anyone needs notice, helps us plan our crews once it's approved.", "Do you have a rough timeframe for the work yet?"],
    moved: "If anything has changed with access or the owner's plans, or the quote needs updating to suit, I can turn that around for you.",
    last: "If it's still with the owner, that's fine.",
    ahead: "Is the work still going ahead with us, or should I pause follow-ups for now?",
  },
  commercial: {
    approval: "I know quotes often go through a few people before they're approved, so I wanted to check it's landed with the right person.",
    ask3: "Is there anything else you need from us to get it through your approval process?",
    scope: "It's worth checking against your scope or specification now, so the quote you approve matches the work on site.",
    program: ["Knowing when the site is available helps us plan our crews around it once it's approved.", "Do you have a rough timeframe for the work yet?"],
    moved: "If anything has moved on your timing, or the quote needs updating to suit, I can turn that around for you.",
    last: "If it's still going through approvals, that's fine.",
    ahead: "Is the work still going ahead with us, or should I pause follow-ups for now?",
  },
};

/** The email for one step. */
export function renderFollowup(step: FollowupStep, f: FollowupFacts, weeksSinceSent = 4): RenderedFollowup {
  if (f.audience === "insurance") return renderInsurance(step, f);
  if (step === 10 || step === 21) return { subject: "", text: "", body: "", words: 0, review: [], notes: [], skip: "Days 10 and 21 are for insurance jobs only." };
  const review: string[] = [];
  const notes: string[] = [];
  const hi = f.firstName ? `Hi ${f.firstName},` : "Hi there,";
  if (!f.firstName) notes.push("No first name on the contact, so it opens with Hi there.");
  if (!f.link) review.push("No quote link yet. It is made when the email goes, so check the preview again.");
  if (!f.unsubscribeUrl) review.push("No unsubscribe link: the person it goes to is not a contact card. Pick a contact first.");
  const linkLine = f.link ? `Your quote is here if you'd like another look:\n${f.link}` : `Your quote is in my email from ${f.sentOn}.`;
  const ref = `quote ${f.quoteRef}`;
  const trade = f.audience === "trade";
  const where = f.suburb ? ` at ${f.suburb}` : "";
  const hasPrep = f.prepLines.length > 0 || f.prepProductsOnly;
  let subject = "";
  let paras: string[] = [];
  let skip: string | null = null;

  if (!trade) {
    const floors = f.floors.slice(0, 3);
    if (step === 3) {
      if (!floors.length) {
        notes.push("No flooring product on the quote, so it asks a general question instead of about colour.");
        subject = `Your Terra Flooring quote ${f.quoteRef}`;
        paras = [
          `Just checking that ${ref}, sent on ${f.sentOn}, came through okay and made sense.`,
          "Quotes can be a lot to take in, so if any part of it isn't clear, I'm happy to explain how it's put together.",
          "Is there anything in it you'd like me to go over?",
        ];
      } else if (f.coloursChosen.length) {
        notes.push("Colours were already picked on the selection form, so it does not ask about colour again.");
        subject = `Your ${floorWords(floors).replace(/^the /, "")} quote ${f.quoteRef}`;
        paras = [
          `Thanks for sending through your choice of ${andList(f.coloursChosen)}. I've noted it against ${ref}${roomsPhrase(f)}.`,
          "Now that the colour is sorted, the rest is just making sure the quote covers everything you're after.",
          "Is there anything else about the quote you'd like me to go over before you decide?",
        ];
      } else {
        const extra = f.floors.length - floors.length;
        /* Never more than three named. The rest are counted, so nothing on the quote is left out. */
        const names = [...floors.map(floorName), ...(extra ? [extra === 1 ? "one other floor" : `${extra} other floors`] : [])];
        const colours = floors.map((x) => clean(x.colour)).filter(Boolean);
        subject = `Quote ${f.quoteRef}: your colour choice`;
        paras = [
          `Just following up on ${ref}, which I sent on ${f.sentOn}. It's for ${andList(names)}${roomsPhrase(f)}.`,
          "Colours can look quite different in your own light than on a screen or in a showroom, so it's worth taking a second look at home before you lock it in.",
          colours.length > 1
            ? `Are you still happy with ${andList(colours)}, or would you like to talk through other colours in the same ranges?`
            : colours.length
              ? `Is ${colours[0]} still the colour you're leaning towards, or would you like to talk through another colour in the same range?`
              : "Have you settled on a colour yet, or would you like to talk through the options?",
        ];
        if (!colours.length) notes.push("No colour on the product, so it asks which colour rather than naming one.");
      }
    } else if (step === 7) {
      if (!hasPrep) skip = "No prep or removal on the quote, so there is nothing to explain.";
      const topic = prepTopic(f.prepLines, f.prepProductsOnly);
      subject = `Quote ${f.quoteRef}: the ${topic === "prep or removal" ? "prep and removal" : topic} we've allowed for`;
      paras = [
        `A quick note on one part of ${ref}. ${prepSentence(f.prepLines, f.prepProductsOnly)}${provisionalSentence(f.prepLines)}`,
        `${topic === "removal" ? "Removing the old floor" : topic === "prep" ? "Prep" : "Prep and removal"} ${topic === "prep or removal" ? "are the parts" : "is the part"} of a flooring quote people most often have questions about, and it's easier to talk it through now than on the day.`,
        `Is there anything about the ${topic} you'd like me to explain?`,
      ];
    } else if (step === 14) {
      subject = `Quote ${f.quoteRef}: timing`;
      if (f.startDate) {
        notes.push("A start date is already on the job, so it does not ask about timing.");
        paras = [
          `Just touching base on ${ref} for ${floorWords(floors)}${where}.`,
          `We've got ${f.startDate} noted as the date you're working towards.`,
          "If it would help to talk anything through before you decide, I'm happy to go over the quote with you by phone or email.",
          "Is there anything still holding you back that I can help with?",
        ];
      } else {
        paras = [
          `Just touching base on ${ref} for ${floorWords(floors)}${where}.`,
          "If you're weighing it up, I'm happy to go through the quote with you by phone or email, so you can decide with all the details in front of you.",
          "Do you have a rough timeframe in mind for getting the new floors in?",
        ];
      }
    } else {
      subject = `Quote ${f.quoteRef}: still considering?`;
      paras = [
        `It's been about ${weeksSinceSent} weeks since I sent ${ref}, so this is the last time I'll follow it up.`,
        `No pressure either way. Plans change, and a flooring project is a big decision.${f.validUntil ? ` The quote is valid until ${f.validUntil}.` : ""}`,
        `Are you still considering it, or would you like me to pause things for now? A one word reply like "still keen" or "pause" is plenty.`,
      ];
    }
  } else {
    const tw = TRADE_WORDS[f.tradeRole ?? "builder"];
    const isProperty = f.tradeRole === "property_manager" || f.tradeRole === "real_estate";
    const project = isProperty
      ? `the property${where}`
      : f.tradeRole === "commercial"
        ? `the job${where}`
        : f.companyName
          ? `${f.companyName}${/s$/i.test(f.companyName) ? "'" : "'s"} project${where}`
          : `the project${where}`;
    if (step === 3) {
      subject = `Quote ${f.quoteRef}: anything needed for approval?`;
      paras = [
        `Just following up on ${ref} for ${project}, which I sent on ${f.sentOn}.`,
        tw.approval,
        tw.ask3,
      ];
    } else if (step === 7) {
      if (!hasPrep) skip = "No prep or removal on the quote, so there is no scope detail to check.";
      subject = `Quote ${f.quoteRef}: scope check`;
      paras = [
        `A quick check on the scope in ${ref}. ${prepSentence(f.prepLines, f.prepProductsOnly)}${provisionalSentence(f.prepLines)}`,
        tw.scope,
        "Does that line up with your scope, or should anything be added or taken out?",
      ];
    } else if (step === 14) {
      subject = `Quote ${f.quoteRef}: program`;
      paras = f.startDate
        ? [
            `Just touching base on ${ref} for ${project}.`,
            `We've got ${f.startDate} noted as the start you're working towards.`,
            tw.moved,
            "Is that date still holding?",
          ]
        : [
            `Just touching base on ${ref} for ${project}.`,
            ...tw.program,
          ];
      if (f.startDate) notes.push("A start date is already on the job, so it asks whether it is still holding.");
    } else {
      subject = `Quote ${f.quoteRef}: still going ahead?`;
      paras = [
        `It's been about ${weeksSinceSent} weeks since I sent ${ref} for ${project}, so this is my last follow-up on it.`,
        `${tw.last}${f.validUntil ? ` The quote is valid until ${f.validUntil}.` : ""}`,
        tw.ahead,
      ];
    }
    if (!f.firstName) review.push(`${isProperty ? "Property" : f.tradeRole === "commercial" ? "Commercial" : "Builder"} quote with no named person. Check who it should go to.`);
  }

  /* A step that does not apply has no email to show. */
  if (skip) return { subject, text: "", body: "", words: 0, review: [], notes, skip };
  const bodyText = [hi, ...paras, linkLine, "Just reply to this email if you have any questions."].join("\n\n");
  const words = countWords(bodyText);
  if (words < WORDS_MIN || words > WORDS_MAX) review.push(`${words} words. It should be ${WORDS_MIN} to ${WORDS_MAX}.`);
  const text = `${bodyText}\n\n${signatureBlock(f)}\n\n${footerBlock(f)}`;
  return { subject, text, body: bodyText, words, review, notes, skip };
}
