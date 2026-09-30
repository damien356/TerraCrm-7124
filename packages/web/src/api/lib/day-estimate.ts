/**
 * How long work takes on site, from output rates rather than from dollars.
 *
 * This is deliberately separate from the labour rate book. The rate book
 * answers "what do we pay for this", in dollars per m2 or per lineal metre.
 * This answers "how many days will it sit there", in metres per day. The two
 * numbers move independently: a price rise does not make anyone lay faster.
 *
 * Every number here is a recommendation. The office can type a day count over
 * the top of it and that is what gets booked, because furniture, prep, stairs,
 * parking and a hundred other things the database has never heard of all move
 * the real answer around.
 */

/**
 * What a crew of `crew` gets through in a day.
 *
 * A second body does NOT double the output, even though the arithmetic looks
 * like it should. Two people on vinyl plank run about 30 to 40 per cent faster
 * than one, not 100 per cent, because they share the same cut station, the
 * same room and the same doorway. Carpet scales better than resilient: one
 * layer does 25 lineal metres of broadloom a day, two do 45, so the second
 * body is worth about 80 per cent there.
 *
 * That per-skill difference is what `extraCrewUpliftPct` carries, and every
 * extra body after the first is worth the same uplift again.
 */
export function crewOutputPerDay(rate: number, crew: number, extraCrewUpliftPct: number) {
  const bodies = Math.max(1, Math.round(crew));
  const uplift = Math.max(0, extraCrewUpliftPct) / 100;
  return rate * (1 + uplift * (bodies - 1));
}

/**
 * Turn a quantity into days on site.
 *
 * Two parts, added together, because they behave completely differently:
 *
 *   working days = quantity ÷ what the crew gets through in a day
 *   fixed days   = the waiting the job does regardless of its size
 *
 * Sanding is why the second part exists. Coats have to dry, and drying does
 * not care whether the floor is 50m2 or 120m2, so that time is flat. It also
 * means a second body cannot shorten it: paint dries at its own pace. Hence
 * the uplift is applied to the working part only and never to the fixed part.
 *
 * The 0.15 shaved off before rounding up is there so a job that lands a
 * whisker over a clean day does not book an extra one. 41m2 of hybrid at
 * 40m2 a day is a big day, not two days. 52m2 is two.
 */
export function daysFromQty(args: {
  qty: number;
  rate: number;
  crew: number;
  extraCrewUpliftPct: number;
  /** Drying, curing, waiting. Not shortened by extra bodies. */
  fixedDays?: number;
}) {
  const perDay = crewOutputPerDay(args.rate, args.crew, args.extraCrewUpliftPct);
  if (perDay <= 0 || args.qty <= 0) return null;
  const working = args.qty / perDay;
  const fixed = Math.max(0, args.fixedDays ?? 0);
  const exact = working + fixed;
  return {
    days: Math.max(1, Math.ceil(exact - 0.15)),
    exact: Math.round(exact * 10) / 10,
    perDay: Math.round(perDay * 10) / 10,
    workingDays: Math.round(working * 10) / 10,
    fixedDays: fixed,
  };
}
