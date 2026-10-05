/**
 * The one place a price becomes a price.
 *
 * Two jobs:
 *  1. The markup chain, applied in a fixed order (see `sellExGst`).
 *  2. Deciding WHICH cost is live today — the supplier's standard price, or a
 *     special that is inside its window. A special expires by being read, not
 *     by being cleaned up: there is no job that rewrites a product row, so an
 *     ended clearance can never keep quoting itself.
 */

/** Overhead 30% -> inefficiency 5% (FIXED, not editable) -> profit 40%. */
export const MARKUP = { overhead: 1.3, inefficiency: 1.05, profit: 1.4 } as const;

/** Terra sits in Queensland; a "date" on a supplier's list is a Brisbane date. */
const TZ = "Australia/Brisbane";

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** How a unit reads inside a sentence: "$19.00 a m²", not "a unit". */
const UNIT_LABEL: Record<string, string> = { m2: "m²", lm: "lm", each: "each", roll: "roll" };
function unitLabel(u: string | null | undefined) {
  if (!u) return "unit";
  return UNIT_LABEL[u] ?? u;
}

/** installer cost -> customer sell, ex-GST. GST is added for display only. */
export function sellExGst(costExGst: number) {
  return round2(costExGst * MARKUP.overhead * MARKUP.inefficiency * MARKUP.profit);
}

/** The standard chain as one percentage, for showing the working: 91.1%. */
export const STANDARD_MARKUP_PCT = round2(
  (MARKUP.overhead * MARKUP.inefficiency * MARKUP.profit - 1) * 100,
);

/**
 * Cost -> sell where the ITEM is allowed its own markup.
 *
 * Almost everything passes null and gets the standard chain. A rate book item
 * with `markupPercent` set overrides it, which exists for one reason: getting
 * rid of the old floor is money passed through, not work Terra profits on, so
 * a disposal and tip run goes out at cost plus 15% rather than plus 91.1%.
 *
 * Deliberately NOT a general per-product margin. Materials are still marked up
 * off the standard cost by `priceProduct`, and labour still defaults to the
 * chain. This is the exception, and it has to be set on purpose.
 */
export function sellExGstWithMarkup(costExGst: number, markupPercent: number | null | undefined) {
  if (markupPercent === null || markupPercent === undefined) return sellExGst(costExGst);
  return round2(costExGst * (1 + markupPercent / 100));
}

/** What markup a line actually carried, as a percent. For the working shown. */
export function markupPctUsed(markupPercent: number | null | undefined) {
  return markupPercent === null || markupPercent === undefined ? STANDARD_MARKUP_PCT : round2(markupPercent);
}

/** Today in Brisbane as YYYY-MM-DD, so a window that ends today is still live. */
export function todayISO(now: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative once `to` is past. */
export function daysBetween(from: string, to: string) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Inside a special's window today, and not killed early. */
export function isSpecialLive(
  s: { startsOn: string; endsOn: string; cancelledAt?: Date | null },
  today = todayISO(),
) {
  if (s.cancelledAt) return false;
  return s.startsOn <= today && today <= s.endsOn;
}

/** A special the office should be warned about before it lapses. */
export const ENDING_SOON_DAYS = 14;

export type SpecialRow = {
  id: number;
  label: string;
  kind: string;
  costPriceExGst: number;
  startsOn: string;
  endsOn: string;
  cancelledAt?: Date | null;
  /** true = the customer gets the discount. Default false: Terra keeps it. */
  passOnToCustomer?: boolean;
  source?: string;
  notes?: string;
};

export type PricedProduct = {
  /** Supplier's standard cost ex-GST per unit. Never altered by a special. */
  standardCostExGst: number | null;
  /** What Terra actually pays today: the live special, else the standard. */
  costExGst: number | null;
  /**
   * What the customer pays. Marked up off the STANDARD cost, always — a
   * supplier special is Terra's buying win, not a discount handed to the
   * customer. The sell price does not move when a clearance starts or ends.
   */
  sellExGst: number | null;
  sellIncGst: number | null;
  /**
   * Extra margin per unit a live special puts in Terra's pocket, because the
   * cost dropped and the sell price did not. Zero when nothing is running.
   */
  extraMarginPerUnit: number;
  /**
   * What the sell price WOULD be if the special were handed to the customer.
   * An option for a job worth winning on price, never the default.
   */
  sellExGstIfPassedOn: number | null;
  onSpecial: boolean;
  /** true while a live special is being given to the customer as a lower sell price. */
  passedOnToCustomer: boolean;
  /** Present only while the window contains today. */
  special: (SpecialRow & { daysLeft: number; endingSoon: boolean; savingPerUnit: number; discountPct: number }) | null;
  /** The most recent special that has already lapsed, so the price change is explainable. */
  reverted: { label: string; endsOn: string; costPriceExGst: number; daysAgo: number } | null;
  /** Future-dated, already loaded and waiting to switch itself on. */
  upcoming: { label: string; startsOn: string; endsOn: string; costPriceExGst: number; daysUntil: number } | null;
  /** Plain-English line for the quote screen. Null when there is nothing to say. */
  priceNote: string | null;
};

/**
 * Resolve the live price for one variant.
 *
 * `specials` is every special ever recorded against the product, in any order.
 * The live one wins; if more than one somehow overlaps, the CHEAPEST wins,
 * because that is the one the customer was shown.
 */
export function priceProduct(
  product: { costPrice: number | null; priceOnApplication?: boolean; unit?: string | null },
  specials: SpecialRow[] = [],
  today = todayISO(),
): PricedProduct {
  const standard = product.costPrice ?? null;
  const live = specials
    .filter((s) => isSpecialLive(s, today))
    .sort((a, b) => a.costPriceExGst - b.costPriceExGst)[0];

  const lapsed = specials
    .filter((s) => !s.cancelledAt && s.endsOn < today)
    .sort((a, b) => (a.endsOn < b.endsOn ? 1 : -1))[0];

  const next = specials
    .filter((s) => !s.cancelledAt && s.startsOn > today)
    .sort((a, b) => (a.startsOn > b.startsOn ? 1 : -1))[0];

  const cost = live ? live.costPriceExGst : standard;
  /**
   * Sell is marked up off the STANDARD cost, not off `cost`. Damien's call: a
   * clearance is a buying win, so the customer keeps paying the normal price
   * and the saving stays with Terra. It also means the quoted price does not
   * lurch up the day a special lapses.
   */
  const passedOn = Boolean(live?.passOnToCustomer);
  const sell =
    standard === null ? null : passedOn && live ? sellExGst(live.costPriceExGst) : sellExGst(standard);
  /** Nothing extra stays with Terra when the customer is given the discount. */
  const extraMargin = live && standard !== null && !passedOn ? round2(standard - live.costPriceExGst) : 0;

  const special = live
    ? {
        ...live,
        daysLeft: daysBetween(today, live.endsOn),
        endingSoon: daysBetween(today, live.endsOn) <= ENDING_SOON_DAYS,
        savingPerUnit: standard === null ? 0 : round2(standard - live.costPriceExGst),
        discountPct:
          standard === null || standard === 0
            ? 0
            : Math.round(((standard - live.costPriceExGst) / standard) * 1000) / 10,
      }
    : null;

  const reverted =
    !live && lapsed
      ? {
          label: lapsed.label,
          endsOn: lapsed.endsOn,
          costPriceExGst: lapsed.costPriceExGst,
          daysAgo: daysBetween(lapsed.endsOn, today),
        }
      : null;

  const upcoming = next
    ? {
        label: next.label,
        startsOn: next.startsOn,
        endsOn: next.endsOn,
        costPriceExGst: next.costPriceExGst,
        daysUntil: daysBetween(today, next.startsOn),
      }
    : null;

  return {
    standardCostExGst: standard,
    costExGst: cost,
    sellExGst: sell,
    sellIncGst: sell === null ? null : round2(sell * 1.1),
    extraMarginPerUnit: extraMargin,
    sellExGstIfPassedOn: live ? sellExGst(live.costPriceExGst) : null,
    passedOnToCustomer: passedOn,
    onSpecial: Boolean(live),
    special,
    reverted,
    upcoming,
    priceNote: priceNote({ product, special, reverted, upcoming, extraMargin }),
  };
}

function priceNote({
  product,
  special,
  reverted,
  upcoming,
  extraMargin,
}: {
  product: { costPrice: number | null; priceOnApplication?: boolean; unit?: string | null };
  special: PricedProduct["special"];
  reverted: PricedProduct["reverted"];
  upcoming: PricedProduct["upcoming"];
  extraMargin: number;
}): string | null {
  if (product.priceOnApplication) return "Price on application — ring the supplier before quoting this.";
  if (product.costPrice === null) return "No price recorded. Confirm with the supplier before quoting.";
  if (special && special.passOnToCustomer) {
    return `${special.label}: the saving is passed to the customer, sell ${special.discountPct}% lower until ${special.endsOn}.`;
  }
  if (special) {
    const when =
      special.daysLeft === 0
        ? "today is the last day"
        : special.daysLeft === 1
          ? "last day tomorrow"
          : `${special.daysLeft} days left`;
    const tail = special.endingSoon ? ` ENDS ${special.endsOn}, ${when}.` : ` Ends ${special.endsOn}.`;
    return `Buying it ${special.discountPct}% under standard on ${special.label}, so $${extraMargin.toFixed(2)} a ${unitLabel(product.unit)} extra margin. Sell price unchanged.${tail}`;
  }
  if (reverted && reverted.daysAgo <= 60) {
    return `${reverted.label} ended ${reverted.endsOn}, back to paying the standard cost. Sell price never moved.`;
  }
  if (upcoming && upcoming.daysUntil <= 30) {
    return `${upcoming.label} starts ${upcoming.startsOn}.`;
  }
  return null;
}

/** lm -> m2 for roll goods. A 4.0m wide broadloom at $69.96/lm is $17.49/m2. */
export function perM2FromPerLm(pricePerLm: number, widthM: number | null) {
  if (!widthM) return null;
  return round2(pricePerLm / widthM);
}

/**
 * m2 for a whole number of packs. Derived from the unit size and the integer
 * count, NEVER from a supplier's printed m2/pack, which is rounded.
 */
export function packM2(unitsPerPack: number | null, unitM2: number | null) {
  if (!unitsPerPack || !unitM2) return null;
  return Math.round(unitsPerPack * unitM2 * 10_000) / 10_000;
}

/* ---------------------------------------------------------------------------
 * Roll vs cut
 *
 * Sheet vinyl and broadloom come off a fixed-size roll. Buy the whole roll and
 * you pay the roll rate; make the supplier cut a part roll and every metre of
 * it costs more. Which rate applies is decided by the ORDER QUANTITY, so it
 * cannot be a column on the product — it is resolved here, per quote line.
 *
 * Damien's rule, in his words: "if i put in over a roll even though its over a
 * roll they treat the whole thing as a roll ... 46 lineal metres will be a roll
 * plus 6m2 but they treat it as roll price not cut price". So:
 *
 *   qty >= one full roll  ->  the WHOLE quantity bills at the roll rate,
 *                             including the bit hanging off the last roll.
 *                             Nothing is rounded up to whole rolls: the
 *                             supplier cuts 46 lm and charges 46 lm.
 *   qty <  one full roll  ->  the whole quantity bills at the cut rate.
 *
 * The second job here is the one he actually asked for: telling the office when
 * a part roll is a false economy. At Polysafe QuickLay (roll $60.05, cut $71.20,
 * 40 m2 roll) anything over 33.73 m2 is CHEAPER bought as a full roll than cut,
 * and you keep the offcut. That is `betterAsFullRoll`.
 *
 * THERE CAN BE A THIRD RATE. MJS publish a deeper rate once the ORDER passes a
 * volume, on top of the roll/cut split: Somplan 100 is $20.56 cut, $17.50 a
 * roll, $16.90 over 300 m2. That is a different question from roll-versus-cut
 * (how big is the order, not did it get cut) so it gets its own threshold, and
 * a big order can clear both at once. It also gets its own false-economy
 * warning, `betterAtVolume`: 290 m2 of Somplan 500 costs $7,685 at the roll
 * rate of $26.50 and 300 m2 costs $7,650 at $25.50, so ten more metres is
 * thirty-five dollars cheaper and the spare is free stock. Same shape of
 * answer as `betterAsFullRoll`, one threshold up.
 *
 * Suppliers with only two rates are untouched: leave `volumeCostPrice` and
 * `volumeQty` null and every field below reads exactly as it did before.
 * ------------------------------------------------------------------------- */

export type RollCutProduct = {
  /** The roll rate — the product's standard cost per `unit`. */
  costPrice: number | null;
  /** Explicit per-`unit` cut rate, where the supplier publishes one (Polyflor). */
  cutCostPrice?: number | null;
  /** Or a % uplift on the roll rate, where the supplier works that way (Armstrong). */
  cutUpliftPct?: number | null;
  /** Qty on one full roll/pack, in `unit`. Null/0 = no break, one rate only. */
  rollM2?: number | null;
  /** A deeper published rate the ORDER SIZE earns, below the roll rate (MJS). */
  volumeCostPrice?: number | null;
  /** Order size in `unit` that earns it. Both null on a two-rate supplier. */
  volumeQty?: number | null;
  widthM?: number | null;
  unit?: string | null;
  /**
   * `roll` (default) or `pack`. The maths is the same either way — this only
   * decides the words. Sheet goods break by the PACK and the short rate is
   * LOOSE, not a cut, and nothing about them converts to lineal metres.
   */
  bulkKind?: string | null;
  /**
   * What ONE unit is called in a sentence — "sheet", "length", "box". Only
   * needed for `each`-unit goods, where "$23.95 a each" is not English. Left
   * unset, m2/lm goods read off their unit as before.
   */
  itemNoun?: string | null;
};

/** The nouns a break is described in. Identical arithmetic, different trade. */
type BreakWords = { whole: string; wholePl: string; short: string; shortAdj: string };
const ROLL_WORDS: BreakWords = { whole: "roll", wholePl: "rolls", short: "cut", shortAdj: "cut" };
const PACK_WORDS: BreakWords = { whole: "pack", wholePl: "packs", short: "loose", shortAdj: "loose" };
function breakWords(bulkKind?: string | null): BreakWords {
  return bulkKind === "pack" ? PACK_WORDS : ROLL_WORDS;
}

export type RollCutQuote = {
  isRollGood: boolean;
  /** `roll` or `pack` — what the thresholds and premiums below are named after. */
  bulkKind: string;
  /** Quantity priced, in `unit`. */
  qty: number;
  unit: string;
  rollM2: number | null;
  widthM: number | null;
  /** Lineal metres the qty represents, when the width is known. */
  qtyLm: number | null;
  fullRolls: number;
  /** How much hangs off the last full roll, in `unit`. */
  remainder: number;
  /** true = billing every metre at the roll rate OR better. */
  onRollRate: boolean;
  rollRateExGst: number | null;
  /** The cut rate, however the supplier expresses it. Null = no cut premium. */
  cutRateExGst: number | null;
  /* ----------------------------- volume break -----------------------------
   * All null/false on the fifteen suppliers who publish two rates. */
  /** Order size that earns the deeper rate, in `unit`. */
  volumeQty: number | null;
  /** The deeper rate itself. */
  volumeRateExGst: number | null;
  /** true = this order is big enough to earn it. */
  onVolumeRate: boolean;
  /** What the volume rate saves against the roll rate, on this line. */
  volumeSavingTotal: number;
  /**
   * Set when ordering UP TO the volume threshold costs less than the smaller
   * quantity actually asked for. The extra metres are free stock.
   */
  betterAtVolume: {
    qty: number;
    costExGst: number;
    savingExGst: number;
    spareQty: number;
    spareLm: number | null;
  } | null;
  /** Above this quantity, pushing the order to the volume break pays. */
  volumeBreakEvenQty: number | null;
  /** The rate that actually applies to this quantity. */
  rateExGst: number | null;
  costExGst: number | null;
  sellPerUnitExGst: number | null;
  sellExGst: number | null;
  sellIncGst: number | null;
  /** Extra Terra pays per unit because this is a cut, not a roll. 0 on roll rate. */
  cutPremiumPerUnit: number;
  cutPremiumTotal: number;
  /**
   * Set when taking a FULL ROLL costs less than the cut quantity asked for.
   * Same money or less, and the offcut is free stock.
   */
  betterAsFullRoll: {
    qty: number;
    costExGst: number;
    savingExGst: number;
    spareQty: number;
    spareLm: number | null;
  } | null;
  /** Above this quantity a cut is never worth it. Null when there is no cut rate. */
  breakEvenQty: number | null;
  note: string;
};

/** lm -> m2 off a fixed-width roll. 6 lm of 2m wide vinyl is 12 m2. */
export function m2FromLm(lm: number, widthM: number | null) {
  if (!widthM) return null;
  return round2(lm * widthM);
}

/** m2 -> lm off a fixed-width roll. 12 m2 of 2m wide vinyl is 6 lm. */
export function lmFromM2(m2: number, widthM: number | null) {
  if (!widthM) return null;
  return round2(m2 / widthM);
}

/**
 * Lineal metres for a quantity expressed in the PRODUCT'S OWN unit.
 *
 * All carpet is sold by the lineal metre, so on a carpet line the quantity is
 * ALREADY lineal metres and dividing it by the roll width would be nonsense:
 * 20 lm of 3.6m Chaparral is 20 lm, not 5.56. Only an m2-priced good (vinyl,
 * Polyflor) needs the width to get back to lm. Chaparral is the first supplier
 * in the book to be both lm-priced AND width-known, which is what surfaced
 * this — every earlier lm supplier had a null width and so converted to null.
 */
export function lmForQty(qty: number, unit: string | null | undefined, widthM: number | null) {
  if (unit === "lm") return round2(qty);
  return lmFromM2(qty, widthM);
}

/** m2 for a quantity in the product's own unit. The mirror of `lmForQty`. */
export function m2ForQty(qty: number, unit: string | null | undefined, widthM: number | null) {
  if (unit === "lm") return m2FromLm(qty, widthM);
  return round2(qty);
}

/** The cut rate, from whichever of the two shapes the supplier uses. */
export function cutRateFor(product: RollCutProduct): number | null {
  const roll = product.costPrice;
  if (roll === null || roll === undefined) return null;
  if (product.cutCostPrice !== null && product.cutCostPrice !== undefined) return product.cutCostPrice;
  if (product.cutUpliftPct !== null && product.cutUpliftPct !== undefined && product.cutUpliftPct > 0) {
    return round2(roll * (1 + product.cutUpliftPct / 100));
  }
  return null;
}

/**
 * Price `qty` (in the product's own unit) of a roll good.
 *
 * Sell follows cost here, unlike a special: a cut premium is real money out of
 * Terra's pocket on THIS order, so it passes through to the customer. A special
 * is the opposite case — a buying win Terra keeps — and is handled in
 * `priceProduct`, which never lets a discount reach the sell price.
 */
export function resolveRollCut(product: RollCutProduct, qty: number): RollCutQuote {
  const unit = product.unit ?? "m2";
  const rollRate = product.costPrice ?? null;
  const rollM2 = product.rollM2 && product.rollM2 > 0 ? product.rollM2 : null;
  const widthM = product.widthM ?? null;
  const cutRate = cutRateFor(product);
  const isRollGood = Boolean(rollM2 && cutRate !== null && rollRate !== null);
  const bulkKind = product.bulkKind === "pack" ? "pack" : "roll";
  const w = breakWords(bulkKind);

  /**
   * A volume rate counts only if it is actually CHEAPER than the roll rate.
   * Three MJS accessories print the same figure in all three price columns,
   * and a rate equal to the roll rate is not a break — announcing a saving of
   * zero dollars would be worse than saying nothing.
   */
  const volumeQty = product.volumeQty && product.volumeQty > 0 ? product.volumeQty : null;
  const volumeRate = product.volumeCostPrice ?? null;
  const hasVolumeBreak = Boolean(
    volumeQty !== null && volumeRate !== null && rollRate !== null && volumeRate < rollRate,
  );

  const base = {
    isRollGood,
    bulkKind,
    qty,
    unit,
    rollM2,
    widthM,
    // Sheets and lengths do not convert to lineal metres off a roll width.
    // On an lm-priced good the qty IS lineal metres already.
    qtyLm: bulkKind === "pack" ? null : lmForQty(qty, unit, widthM),
    rollRateExGst: rollRate,
    cutRateExGst: cutRate,
    volumeQty: hasVolumeBreak ? volumeQty : null,
    volumeRateExGst: hasVolumeBreak ? volumeRate : null,
  };

  // No break of either kind: one rate, no decision to make.
  if ((!isRollGood || rollM2 === null || cutRate === null) && !hasVolumeBreak) {
    const cost = rollRate === null ? null : round2(rollRate * qty);
    const sellUnit = rollRate === null ? null : sellExGst(rollRate);
    return {
      ...base,
      fullRolls: 0,
      remainder: qty,
      onRollRate: true,
      rateExGst: rollRate,
      costExGst: cost,
      sellPerUnitExGst: sellUnit,
      sellExGst: sellUnit === null ? null : round2(sellUnit * qty),
      sellIncGst: sellUnit === null ? null : round2(sellUnit * qty * 1.1),
      cutPremiumPerUnit: 0,
      cutPremiumTotal: 0,
      betterAsFullRoll: null,
      breakEvenQty: null,
      onVolumeRate: false,
      volumeSavingTotal: 0,
      betterAtVolume: null,
      volumeBreakEvenQty: null,
      note:
        rollRate === null
          ? "No price recorded. Confirm with the supplier before quoting."
          : // Neutral on purpose: a product with NO break is neither a roll nor
            // a pack, and Mitre 10's ply and mouldings are both.
            "One rate, whatever the quantity — no quantity break on this product.",
    };
  }

  /* A roll/cut break, a volume break, or both. Everything below is written so
   * that a supplier with only one of the two still reads correctly: a volume
   * break with no cut rate (MJS carpet tile) has no cut tier to fall to, and a
   * cut break with no volume rate behaves exactly as it always has. */
  const hasCutBreak = rollM2 !== null && cutRate !== null;

  /* A base rate always exists down here. Both kinds of break need one:
   * `isRollGood` is false without it and `hasVolumeBreak` tests it directly,
   * so a null base rate has already left through the one-rate return above.
   * Stated as an invariant rather than defaulted to zero, because a silent $0
   * rate would price a job at nothing. */
  if (rollRate === null) {
    throw new Error("resolveRollCut: a quantity break was found with no base rate, which cannot happen");
  }

  const fullRolls = rollM2 === null ? 0 : Math.floor(round2(qty) / rollM2);
  const remainder = rollM2 === null ? qty : round2(qty - fullRolls * rollM2);

  // Volume first: it is the deepest rate, and an order big enough to earn it
  // is always well past a full roll, so it decides the rate on its own.
  const onVolumeRate = hasVolumeBreak && volumeQty !== null && qty >= volumeQty;
  const onRollRate = onVolumeRate || !hasCutBreak || (rollM2 !== null && qty >= rollM2);
  const rate = onVolumeRate && volumeRate !== null ? volumeRate : onRollRate ? rollRate : (cutRate as number);
  const cost = round2(rate * qty);
  const sellUnit = sellExGst(rate);
  const premiumPerUnit = onRollRate || cutRate === null ? 0 : round2(cutRate - rollRate);
  const volumeSaving = onVolumeRate && volumeRate !== null ? round2((rollRate - volumeRate) * qty) : 0;

  // A whole roll at the roll rate, versus the cut quantity actually asked for.
  const fullRollCost = rollM2 === null ? null : round2(rollRate * rollM2);
  const betterAsFullRoll =
    !onRollRate && rollM2 !== null && fullRollCost !== null && fullRollCost < cost
      ? {
          qty: rollM2,
          costExGst: fullRollCost,
          savingExGst: round2(cost - fullRollCost),
          spareQty: round2(rollM2 - qty),
          spareLm: bulkKind === "pack" ? null : lmForQty(round2(rollM2 - qty), unit, widthM),
        }
      : null;

  /* The same false-economy question one threshold up: does buying UP TO the
   * volume break cost less than the quantity actually asked for? Compared
   * against `cost`, so it works whether this order is currently on the cut
   * rate or the roll rate. */
  const volumeCost = hasVolumeBreak && volumeQty !== null && volumeRate !== null ? round2(volumeRate * volumeQty) : null;
  const betterAtVolume =
    !onVolumeRate && volumeQty !== null && volumeCost !== null && volumeCost < cost
      ? {
          qty: volumeQty,
          costExGst: volumeCost,
          savingExGst: round2(cost - volumeCost),
          spareQty: round2(volumeQty - qty),
          spareLm: bulkKind === "pack" ? null : lmForQty(round2(volumeQty - qty), unit, widthM),
        }
      : null;

  const breakEven = hasCutBreak && rollM2 !== null && cutRate !== null ? round2((rollM2 * rollRate) / cutRate) : null;
  /* Measured against the ROLL rate, because a quantity anywhere near a volume
   * threshold (MJS set theirs at 300 m2, against a 40 m2 roll) is long past
   * the roll break already. */
  const volumeBreakEven =
    hasVolumeBreak && volumeQty !== null && volumeRate !== null ? round2((volumeQty * volumeRate) / rollRate) : null;

  return {
    ...base,
    fullRolls,
    remainder,
    onRollRate,
    rateExGst: rate,
    costExGst: cost,
    sellPerUnitExGst: sellUnit,
    sellExGst: round2(sellUnit * qty),
    sellIncGst: round2(sellUnit * qty * 1.1),
    cutPremiumPerUnit: premiumPerUnit,
    cutPremiumTotal: round2(premiumPerUnit * qty),
    betterAsFullRoll,
    breakEvenQty: breakEven,
    onVolumeRate,
    volumeSavingTotal: volumeSaving,
    betterAtVolume,
    volumeBreakEvenQty: volumeBreakEven,
    note: rollCutNote({
      qty,
      unit,
      w,
      // Every pack good Terra buys `each` is a sheet (plywood). Pass `itemNoun`
      // explicitly the day a pack of something else — boxes, bundles — lands.
      itemNoun: product.itemNoun ?? (bulkKind === "pack" && unit === "each" ? "sheet" : null),
      rollM2,
      widthM: bulkKind === "pack" ? null : widthM,
      onRollRate,
      fullRolls,
      remainder,
      rollRate,
      cutRate,
      premiumTotal: round2(premiumPerUnit * qty),
      betterAsFullRoll,
      breakEven,
      volumeQty: hasVolumeBreak ? volumeQty : null,
      volumeRate: hasVolumeBreak ? volumeRate : null,
      onVolumeRate,
      volumeSaving,
      betterAtVolume,
    }),
  };
}

function rollCutNote(a: {
  qty: number;
  unit: string;
  w: BreakWords;
  itemNoun: string | null;
  rollM2: number | null;
  widthM: number | null;
  onRollRate: boolean;
  fullRolls: number;
  remainder: number;
  rollRate: number;
  cutRate: number | null;
  premiumTotal: number;
  betterAsFullRoll: RollCutQuote["betterAsFullRoll"];
  breakEven: number | null;
  volumeQty: number | null;
  volumeRate: number | null;
  onVolumeRate: boolean;
  volumeSaving: number;
  betterAtVolume: RollCutQuote["betterAtVolume"];
}) {
  const u = unitLabel(a.unit);
  const { whole, wholePl, shortAdj } = a.w;
  const money = (n: number) => `\u0024${n.toFixed(2)}`;
  // "$23.95 a sheet" / "$19.00 a m²" / "$23.95 each" — never "a each".
  const per = a.itemNoun ? `a ${a.itemNoun}` : u === "each" ? "each" : `a ${u}`;
  // "75 sheets" / "40 m²" — a count of things reads with its own noun.
  const q = (n: number) => (a.itemNoun ? `${n} ${a.itemNoun}${n === 1 ? "" : "s"}` : `${n} ${u}`);
  // The second figure the office wants is whichever one the price ISN'T in. An
  // m2-priced roll reads better with its lineal metres, and an lm-priced carpet
  // roll reads better with the area it covers: "20 lm roll (72 m²)".
  const altUnit = a.unit === "lm" ? "m²" : "lm";
  const rollAlt =
    a.rollM2 === null ? null : a.unit === "lm" ? m2FromLm(a.rollM2, a.widthM) : lmFromM2(a.rollM2, a.widthM);
  const rollSize =
    a.rollM2 === null
      ? whole
      : rollAlt
        ? `${q(a.rollM2)} ${whole} (${rollAlt} ${altUnit})`
        : whole === "pack"
          ? `${whole} of ${q(a.rollM2)}`
          : `${q(a.rollM2)} ${whole}`;
  // A roll leaves an offcut; a pack ordered past leaves a plain balance.
  const leftover = whole === "pack" ? "the balance" : "the offcut";
  /** "290 m² (145 lm) spare" — the free stock a break leaves behind. */
  const spareWords = (spareQty: number, spareLm: number | null) => {
    const alt = a.unit === "lm" ? m2FromLm(spareQty, a.widthM) : spareLm;
    return alt ? `${q(spareQty)} (${alt} ${altUnit}) spare` : `${q(spareQty)} spare`;
  };

  /* The deepest tier first. An order this size has cleared every break below
   * it, so the roll-versus-cut question is already answered and saying
   * anything about it would only bury the number that matters. */
  if (a.onVolumeRate && a.volumeQty !== null && a.volumeRate !== null) {
    return `Over the ${q(a.volumeQty)} break, so the WHOLE ${q(a.qty)} bills at the volume rate, ${money(a.volumeRate)} ${per} instead of ${money(a.rollRate)} — ${money(a.volumeSaving)} off this line.`;
  }

  /** What the order is billing at now, before any volume advice. */
  const head = (() => {
    // No cut rate published: one rate up to the volume break, nothing to choose.
    if (a.cutRate === null) {
      return `${money(a.rollRate)} ${per} — the standard rate, with no ${shortAdj} premium on this product.`;
    }
    if (a.onRollRate) {
      if (a.remainder === 0) {
        return `${a.fullRolls} full ${a.fullRolls === 1 ? whole : wholePl} — all ${money(a.rollRate)} ${per} at the ${whole} rate.`;
      }
      return `Over a full ${whole} (${a.fullRolls} × ${rollSize} plus ${q(a.remainder)}), so the WHOLE ${q(a.qty)} bills at the ${whole} rate, ${money(a.rollRate)} ${per}. No ${shortAdj} premium on ${leftover}.`;
    }
    const cut = `Under a full ${whole}, so it is ${whole === "pack" ? "loose" : "a cut"}: ${money(a.cutRate)} ${per} instead of ${money(a.rollRate)}, ${money(a.premiumTotal)} more on this line.`;
    if (a.betterAsFullRoll && a.rollM2 !== null) {
      const spare = spareWords(a.betterAsFullRoll.spareQty, a.betterAsFullRoll.spareLm);
      return `${cut} TAKE THE WHOLE ${whole.toUpperCase()}: ${q(a.rollM2)} costs ${money(a.betterAsFullRoll.costExGst)} against ${money(a.betterAsFullRoll.costExGst + a.betterAsFullRoll.savingExGst)} ${shortAdj} — ${money(a.betterAsFullRoll.savingExGst)} cheaper and ${spare}.`;
    }
    if (a.breakEven !== null) {
      return `${cut} Still cheaper than a full ${whole} — a ${whole} only pays for itself above ${q(a.breakEven)}.`;
    }
    return cut;
  })();

  // Under the volume break, so the advice is about getting to it.
  if (a.betterAtVolume && a.volumeQty !== null && a.volumeRate !== null) {
    const spare = spareWords(a.betterAtVolume.spareQty, a.betterAtVolume.spareLm);
    return `${head} PUSH IT TO ${q(a.volumeQty)}: that costs ${money(a.betterAtVolume.costExGst)} at ${money(a.volumeRate)} ${per} against ${money(a.betterAtVolume.costExGst + a.betterAtVolume.savingExGst)} for what was asked — ${money(a.betterAtVolume.savingExGst)} cheaper and ${spare}.`;
  }
  if (a.volumeQty !== null && a.volumeRate !== null) {
    return `${head} Over ${q(a.volumeQty)} the rate drops to ${money(a.volumeRate)} ${per}.`;
  }
  return head;
}

/* ---------------------------------------------------------------------------
 * Supplier charges
 *
 * What a supplier adds on top of the rate, and what it adds it PER. This
 * replaced a single fuel-surcharge percentage on the supplier row, which only
 * ever worked because Terramater happen to charge a percentage. Chaparral
 * charge fuel at $2.00 per LINEAL METRE and baling at $20.00 per ROLL, both at
 * the same time, and no single percentage can express either of them.
 *
 * Two rules the rest of the app depends on:
 *
 *  1. EVERY CHARGE STAYS ITS OWN LINE. The answer is not one total, it is
 *     base + surcharges + packing + freight, each still nameable, because
 *     Damien has to be able to see what a supplier is adding and argue with
 *     them about it. A folded-in number is an unarguable number.
 *
 *  2. A CHARGE IS COMPUTED OFF ITS OWN BASIS, NEVER OFF ANOTHER CHARGE. A
 *     percentage reads off the goods total only. Nothing compounds — suppliers
 *     do not charge fuel on baling, and doing it here would quietly overstate
 *     every job's cost.
 * ------------------------------------------------------------------------- */

export type SupplierChargeRule = {
  id: number;
  name: string;
  kind: string;
  basis: string;
  amount: number | null;
  percent: number | null;
  /** "goods" (default) or "goods_and_charges". See supplier_fee_rules.percent_base. */
  percentBase?: string | null;
  amountIncludesGst: boolean;
  isCredit: boolean;
  autoApply: boolean;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  active?: boolean;
  condition?: string;
  notes?: string;
  sortOrder?: number;
};

/**
 * The order the charges are measured against. Only the quantities that a
 * charge's basis actually reads are needed — a supplier who charges per lineal
 * metre never looks at `pallets`.
 */
export type ChargeOrder = {
  /** Goods total ex-GST, before any supplier charge. What a % reads off. */
  goodsExGst: number;
  m2?: number;
  lm?: number;
  boxes?: number;
  rolls?: number;
  items?: number;
  pallets?: number;
  shipments?: number;
  weeksStored?: number;
};

/** How many billable units of its own basis this order gives a charge. */
export function chargeUnits(basis: string, order: ChargeOrder): number {
  switch (basis) {
    case "m2":
      return order.m2 ?? 0;
    case "lm":
      return order.lm ?? 0;
    case "box":
      return order.boxes ?? 0;
    case "roll":
      return order.rolls ?? 0;
    case "each":
      return order.items ?? 0;
    case "pallet":
      return order.pallets ?? 0;
    case "shipment":
      return order.shipments ?? 1;
    // Storage is per pallet per week, so a week on its own bills nothing.
    case "week":
      return (order.weeksStored ?? 0) * Math.max(order.pallets ?? 0, 1);
    // A flat charge and a percentage both bill once for the whole order.
    case "order":
    case "percent_of_order":
      return 1;
    default:
      return 1;
  }
}

/** Inside the charge's dated window today. No end date = until further notice. */
export function isChargeLive(rule: SupplierChargeRule, today = todayISO()): boolean {
  if (rule.active === false) return false;
  if (rule.effectiveFrom && rule.effectiveFrom > today) return false;
  if (rule.effectiveUntil && rule.effectiveUntil < today) return false;
  return true;
}

export type ResolvedCharge = {
  id: number;
  name: string;
  kind: string;
  basis: string;
  /** Units of the basis this order gave it — 15 lm, 1 roll, 1 order. */
  units: number;
  /** The rate, per unit of the basis. Null for a percentage. */
  rateExGst: number | null;
  percent: number | null;
  /** Signed: negative for a credit. Ex-GST, always. */
  exGst: number;
  isCredit: boolean;
  /** Why it applied, in the words the office needs: "$2.00/lm × 15 lm". */
  note: string;
};

export type SupplierChargeQuote = {
  goodsExGst: number;
  /** Every live charge, still separate. Empty when the supplier adds nothing. */
  charges: ResolvedCharge[];
  /** Charges grouped the way a cost breakdown reads, all ex-GST. */
  surchargesExGst: number;
  packingExGst: number;
  freightExGst: number;
  otherExGst: number;
  creditsExGst: number;
  chargesExGst: number;
  /** base + surcharges + packing + freight, ex-GST. The true material cost. */
  totalExGst: number;
  /** Charges recorded against the supplier but deliberately NOT applied. */
  excluded: Array<{ id: number; name: string; reason: string }>;
  note: string;
};

const CHARGE_UNIT_LABEL: Record<string, string> = {
  m2: "m²",
  lm: "lm",
  box: "box",
  roll: "roll",
  each: "item",
  pallet: "pallet",
  shipment: "delivery",
  week: "pallet/week",
  order: "order",
};

function chargeUnitLabel(basis: string) {
  return CHARGE_UNIT_LABEL[basis] ?? basis;
}

/** Charges that are packing/handling rather than a surcharge on the goods. */
const PACKING_KINDS = new Set(["baling", "handling"]);
const FREIGHT_KINDS = new Set(["delivery"]);
// "levy" is a government or industry charge passed through on the goods, the
// Resiloop recycling levy being the one in the book. It sits with the
// surcharges because that is what it is, a charge on top of the rate. Note
// Tarkett quote theirs already inside the rate, so they carry no levy row.
const SURCHARGE_KINDS = new Set(["fuel", "premium", "cutting", "levy"]);

/**
 * Turn a supplier's charge rules into money for one order.
 *
 * `supplier.deliversDirect === false` is honoured here: a supplier who does not
 * deliver to Terra can still have their published delivery charge on file, but
 * it must never land in Terra's cost. Chaparral is the case — their stock comes
 * through Jocks Transport as on-forwarder and Terra pays that carrier directly,
 * so applying Chaparral's own delivery line would bill the same freight twice.
 * The rule is not deleted, it is returned under `excluded` with the reason.
 */
export function resolveSupplierCharges(
  supplier: { deliversDirect?: boolean | null; name?: string },
  rules: SupplierChargeRule[],
  order: ChargeOrder,
  opts: { pickedIds?: number[]; today?: string } = {},
): SupplierChargeQuote {
  const today = opts.today ?? todayISO();
  const picked = opts.pickedIds ?? [];
  const goodsExGst = round2(order.goodsExGst);

  const charges: ResolvedCharge[] = [];
  const excluded: SupplierChargeQuote["excluded"] = [];
  // A percentage Damien has approved as "on goods plus charges" waits until
  // every other charge is known. The only exception to rule 2 above, and only
  // ever set on a rule by hand, after an invoice proved the supplier works it
  // that way.
  const onCharges: SupplierChargeRule[] = [];

  for (const r of rules) {
    if (!isChargeLive(r, today)) {
      if (r.active !== false && r.autoApply) {
        const window = r.effectiveFrom && r.effectiveFrom > today ? `starts ${r.effectiveFrom}` : `ended ${r.effectiveUntil}`;
        excluded.push({ id: r.id, name: r.name, reason: `Outside its dates — ${window}.` });
      }
      continue;
    }
    // Not automatic and the office did not tick it: it is not on this order.
    if (!r.autoApply && !picked.includes(r.id)) continue;

    if (supplier.deliversDirect === false && FREIGHT_KINDS.has(r.kind)) {
      excluded.push({
        id: r.id,
        name: r.name,
        reason: "Supplier does not deliver to Terra — freight is invoiced by the carrier instead, so this is not Terra's cost.",
      });
      continue;
    }

    const units = chargeUnits(r.basis, order);
    const isPercent = r.basis === "percent_of_order";
    if (isPercent && r.percentBase === "goods_and_charges") {
      onCharges.push(r);
      continue;
    }

    // A live per-unit charge with no units to bill is NOT a $0.00 line on the
    // quote — it is a quantity the office has not entered yet. Chaparral's
    // baling is per ROLL and they publish no roll length, so the roll count is
    // always typed in by hand and is always the one that gets forgotten. Say
    // so instead of quietly totalling zero.
    if (!isPercent && units === 0) {
      excluded.push({
        id: r.id,
        name: r.name,
        reason: `Charged per ${chargeUnitLabel(r.basis)} and this order has none entered — put the ${chargeUnitLabel(r.basis)} count in or it is not being costed.`,
      });
      continue;
    }
    // A percentage reads off the GOODS only. Charges never compound.
    const gross = isPercent ? (goodsExGst * (r.percent ?? 0)) / 100 : (r.amount ?? 0) * units;
    // Everything normalises to ex-GST here; GST is added once, at the end.
    const exGst = round2(r.amountIncludesGst && !isPercent ? gross / 1.1 : gross);
    const signed = r.isCredit ? -exGst : exGst;

    charges.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      basis: r.basis,
      units: round2(units),
      rateExGst: isPercent ? null : (r.amount ?? 0),
      percent: isPercent ? (r.percent ?? 0) : null,
      exGst: signed,
      isCredit: r.isCredit,
      note: chargeNote(r, units, exGst, goodsExGst),
    });
  }

  if (onCharges.length) {
    const base = round2(goodsExGst + charges.filter((c) => !c.isCredit && !FREIGHT_KINDS.has(c.kind)).reduce((t, c) => t + c.exGst, 0));
    for (const r of onCharges) {
      const exGst = round2((base * (r.percent ?? 0)) / 100);
      const signed = r.isCredit ? -exGst : exGst;
      charges.push({
        id: r.id,
        name: r.name,
        kind: r.kind,
        basis: r.basis,
        units: 1,
        rateExGst: null,
        percent: r.percent ?? 0,
        exGst: signed,
        isCredit: r.isCredit,
        note: `${r.percent ?? 0}% of \u0024${base.toFixed(2)} goods and charges = \u0024${exGst.toFixed(2)}.`,
      });
    }
  }

  const sum = (pick: (c: ResolvedCharge) => boolean) =>
    round2(charges.filter(pick).reduce((t, c) => t + c.exGst, 0));

  const surchargesExGst = sum((c) => !c.isCredit && SURCHARGE_KINDS.has(c.kind));
  const packingExGst = sum((c) => !c.isCredit && PACKING_KINDS.has(c.kind));
  const freightExGst = sum((c) => !c.isCredit && FREIGHT_KINDS.has(c.kind));
  const creditsExGst = sum((c) => c.isCredit);
  const otherExGst = sum(
    (c) => !c.isCredit && !SURCHARGE_KINDS.has(c.kind) && !PACKING_KINDS.has(c.kind) && !FREIGHT_KINDS.has(c.kind),
  );
  const chargesExGst = round2(charges.reduce((t, c) => t + c.exGst, 0));

  return {
    goodsExGst,
    charges,
    surchargesExGst,
    packingExGst,
    freightExGst,
    otherExGst,
    creditsExGst,
    chargesExGst,
    totalExGst: round2(goodsExGst + chargesExGst),
    excluded,
    note: chargesNote(charges, excluded, goodsExGst, chargesExGst),
  };
}

function chargeNote(r: SupplierChargeRule, units: number, exGst: number, goodsExGst: number) {
  const money = (n: number) => `\u0024${n.toFixed(2)}`;
  if (r.basis === "percent_of_order") {
    return `${r.percent ?? 0}% of ${money(goodsExGst)} goods = ${money(exGst)}.`;
  }
  const u = chargeUnitLabel(r.basis);
  const rate = `${money(r.amount ?? 0)}/${u}`;
  if (r.basis === "order") return `${money(r.amount ?? 0)} flat on the order.`;
  return `${rate} × ${units} ${u}${units === 1 ? "" : "s"} = ${money(exGst)}.`;
}

function chargesNote(
  charges: ResolvedCharge[],
  excluded: SupplierChargeQuote["excluded"],
  goodsExGst: number,
  chargesExGst: number,
) {
  const money = (n: number) => `\u0024${n.toFixed(2)}`;
  if (charges.length === 0) {
    const tail = excluded.length ? ` ${excluded.length} charge${excluded.length === 1 ? "" : "s"} on file did not apply.` : "";
    return `No supplier charges on this order — ${money(goodsExGst)} ex GST is the material cost.${tail}`;
  }
  const parts = charges.map((c) => `${c.name} ${money(Math.abs(c.exGst))}${c.isCredit ? " credit" : ""}`);
  // "before transport" is only true while no freight has been billed. Armstrong
  // are the first supplier with a confirmed flat delivery on file, and on their
  // orders the freight IS in this figure, so saying otherwise reads as though
  // another carrier invoice is still to come.
  const tail = charges.some((c) => !c.isCredit && FREIGHT_KINDS.has(c.kind)) ? "ex GST delivered" : "ex GST before transport";
  return `${money(goodsExGst)} goods plus ${parts.join(", ")} = ${money(round2(goodsExGst + chargesExGst))} ${tail}.`;
}
