# Labour rates build (off Damien's spec, 27 Sep 2026)

## Design calls
- Skills stay the dispatch list (what a task can be). Rate items are the priceable
  work items under a skill. So broadloom 3.66m vs 4.0m are RATE ITEMS, not two
  skills, otherwise every installer has to be ticked twice for the same trade.
- One rate table. `installer_id null` = Terra default, a row with an installer =
  that installer's override. Nothing is ever copied, so changing Terra's default
  moves everybody who has not been overridden.
- Every rate is effective dated. A new rate closes the old one off with an
  `effective_to`, it never overwrites it. Old jobs keep the rate of the day.
- Surcharges (after hours, weekend, travel, minimum charge) are rate items too,
  with `unit = percent` or `km`, so installer overrides work on them for free.

## Phases
1. [x] Schema: labour_rate_items, labour_rates, rate_acknowledgements,
       skills.min_crew / recommended_crew / production_rate
2. [x] Seed the rate book: carpet, hybrid/laminate/LVT, timber (solid + engineered),
       full stair detail, prep, demo, surcharges
3. [x] Settings -> Labour rates tab (Terra defaults, units, effective dates)
4. [x] Installer -> Rates tab: standard / his / difference, override + history
5. [x] Skills tab: min crew, recommended crew, production rate
6. [x] Forecast on the job: revenue, materials, labour, other, GP, margin,
       and what it does if you swap installer
7. [ ] Terra Crew: My rates, own rates only, acknowledge a rate change
8. [ ] Duration estimate off production rate -> completion date (feeds cashflow later)

## Tested 27 Sep, clicked through in the browser
- Settings -> Labour rates: renders 84 items, rate entry writes, unit change writes,
  new rate item writes (group, kind, unit all honoured), history opens.
- Installer -> Rates: card loads, Terra standard vs his rate vs difference correct,
  override writes against him only, Terra's row untouched, clearing puts him back.
- Effective dating: a new rate closes the old one the day before. Clearing a rate that
  started earlier closes it off, clearing one dated today bins it. History keeps every version.
- Card as at an older date shows the rate of that day, not today's.
- All QA numbers wiped after. Rate book is 84 items, zero rates. Waiting on Damien's numbers.

## Phase 6, built and tested 27 Sep
- New table task_labour_lines. The measure sits on the dispatch, the money never does,
  because the same 80m2 costs a different amount on each installer's card.
- Job page -> "What this job makes": sale off the accepted quote, materials off its cost
  prices, labour and surcharges off the rate book, total cost, GP, margin, days of work.
- Measure up on a dispatch: pick work items, put quantities in, see the rate used and where
  it came from (his rate, Terra's, or none). A missing rate says so, it is never read as zero.
- What it costs on each installer, whole job: labour, GP and margin per man, cheapest first,
  greyed out if he is not ticked for every skill on the job.
- Labour freezes onto the dispatch the moment someone is put on it, at that day's rates.
  Proved it: raised a rate after locking, the job's GP did not move. Unlock puts it back on
  live rates. Assigning re-locks at the new man's card.
- Numbers checked by hand: 85m2 at 11.25 = 956.25 labour, 20km travel at 1.10, Saturday
  loading 15% on the labour, materials 2,920 off the quote's cost prices. All matched.
- Every QA row wiped after: no test job, no test quote, no test rates. Rate book is 84
  items, zero rates.

## Open, needs Damien
- Real rates still to enter. Every one of the 84 items reads blank. Nothing in the forecast
  means anything until they go in.
- Offer accept path locks the labour through the same code as assign, but the accept was not
  click-tested on a live offer. Worth one pass when there is a real offer to accept.
