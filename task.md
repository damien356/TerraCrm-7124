# Marketing build, engine first

Decided 29 Sep 2026. Damien's call: engine first, canvas builder later.

## Order

- [x] 1. Templates. DONE. Route, page, editor with live preview rendered by
      the same code that sends. Verified in a real browser: page renders, zero
      console errors, preview iframe shows real merged HTML. Review request
      template saved (id 1). Test-send button built but not fired yet.
- [ ] 2. Segments. Matcher lib DONE (`api/lib/segments.ts`): every segment
      reports two counts, matching and reachable, plus a blocked breakdown.
      Never collapsed into one number. Product matching is keyword families,
      not exact category, because ten years of ServiceM8 free text spells
      carpet six ways. All 7 sample rule sets under 300ms against prod.
      `reachableIds` cross-checked against `checkConsent` on 60 real
      contacts, 0 mismatches. STILL TO DO: oRPC route, page, rule editor.
  - [x] 2a. Homeowner vs trade, fixed. The old test (contact's own jobs
        carry a company_id) classified 2 of 1653 contacts as trade, because
        1351 jobs carry a company_id with contact_id NULL. It was letting
        builders into the homeowner pool: a rebuild contractor with 24 jobs,
        two real-estate agents, a shopfitter, a painter, a body corporate
        manager, all sitting in "homeowner, reachable". New `api/lib/trade.ts`
        scores four signals: business email domain (freemail list), 4+
        completed jobs, jobs against a company, company_contacts row. New
        column `contacts.audience_kind` (homeowner|trade|unknown) so a human
        decision always beats the heuristic, and unknown-but-looks-like-trade
        is held back rather than mailed. Now: homeowner 1125 matching / 170
        reachable, trade 411 / 85. Review queue 85 contacts, 6 spot-checked
        by hand, all correct. NOTE: live DB column added with
        `drizzle-kit push`, no migration file, schema.ts is the only record.
- [x] 3. Engine. DONE. Ticks every 5 min from `__server.ts` only, never from
      Vite dev, so the sandbox can never send to a real customer. Kill switch
      `MARKETING_ENGINE=off`. Verified with a real tick against prod: 378ms,
      zero sends, because no journey exists yet.
- [ ] 4. Review request journey, live. 3 days after job complete.
- [ ] 5. Quote follow-up journey, draft only. 3 days then 10 then stop.
- [ ] 6. Unsubscribe, opens, clicks.
- [ ] 7. Reports.
- [ ] 8. team@ inbox.

Canvas journey builder is deferred on purpose. Not needed to send.

## Data facts that drive this, verified 29 Sep 2026

- Job completions are live: 15 to 25 a month, latest 25 Sep, history to 2016.
- 13 jobs completed in last 30 days with emailable marketable homeowner.
- quotes 0 rows. Quote follow-up cannot fire yet. Built as draft only.
- 4219 of 4223 jobs are ServiceM8 imports. Only 4 native.
- Consent pool: 262 contacts marketing_basis completed_job, 3 express opt-in,
  1 do_not_market. Spam Act existing-customer basis is the one that matters.
- contacts has no company_id. 1351 jobs carry a company_id with contact_id
  NULL, so "does this contact's own job name a company" is not a trade test.
  company_contacts has 5 rows total, so that join cannot carry it either.
  Homeowner vs trade is now `contacts.audience_kind` plus the heuristic in
  `api/lib/trade.ts`. 85 contacts sit in "unknown, looks like trade, held
  back" awaiting human review.
- 1537 contacts have an email.

## Rails, non negotiable, from marketing-plan.md

- One enrolment per contact per journey at a time.
- Max one marketing email per contact per 24h across all journeys.
- Nothing sends 8pm to 8am.
- No SMS on Sundays.
- Unsubscribe and do_not_market checked before every send, no exceptions.
- Builder audiences can never be used by a journey. Enforced server side.
- Every journey starts as draft. A draft enrols nobody.

## Freeze protocol

Commit and push after every step. Update this file and STATE.md in the same
commit. A freeze then costs one step, never the work behind it.

## Open, does not block until step 5

Does Damien want to raise quotes in Terra Ops instead of ServiceM8? If no, the
quote follow-up journey stays a draft forever and we need a different second
journey.
