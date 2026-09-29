# Marketing build, engine first

Decided 29 Sep 2026. Damien's call: engine first, canvas builder later.

## Order

- [ ] 1. Templates. Route plus page. Merge fields, preview, test send to self.
- [ ] 2. Segments. Route plus page. Live matching count.
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
- contacts has no company_id. Homeowner vs builder is derived through jobs.
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
