# Marketing module, build plan

Terra Ops. A new "Marketing" section in the sidebar that sends homeowner follow-up
email and SMS on autopilot, plus a team@ inbox so replies come back into the app.

Everything below is decided, not open. Read it, tell me what you want changed, and
I build it in the order listed.

---

## 1. The rules we agreed

1. **Homeowners only for anything automatic.** A journey can never enrol a contact
   that sits under a company. Builders are fenced off in the code, not just by
   convention, so a homeowner-worded email cannot reach a builder by accident.
2. **Builders can still be emailed, by hand.** You can build a builder list and fire
   a one-off blast you write yourself. No automation touches that list.
3. **Consent is required.** A contact only receives marketing if `marketingOptIn` is
   true and they have not unsubscribed. That field already exists on the contacts
   table, unused, waiting for this.
4. **team@terraflooring.com.au sends the marketing.** damien@ keeps sending quotes
   exactly as it does now. Nothing in this build touches quote sending.
5. **Replies land in Terra Ops, team@ only.** A Marketing inbox shows them threaded
   against the contact. damien@ replies stay in your normal mail, untouched.
6. **Nothing sends until you press the switch.** Every journey starts as a draft. A
   draft enrols nobody and sends nothing.

## 2. What you sign up for

| Service | What for | Cost | What I need from you |
| --- | --- | --- | --- |
| Resend | Email sending and reply capture | Free to 3,000/month, then about $20/month for 50,000 | An account, then paste terraflooring.com.au in as a domain. It hands you 3 DNS records. Give me the API key. |
| ClickSend | SMS | No monthly fee, roughly 7 to 8c a message | An account and the API key. Sender shows as TERRA, no phone number needed. |

The DNS records are the important part. They are what tells Gmail and Outlook that
Resend is allowed to send as terraflooring.com.au. Without them everything lands in
spam. I will give you the exact three records to paste at your domain host and check
them for you once they are in.

Both keys go into `.env` on the server. They never reach the browser.

## 3. Database, 8 new tables

Built the same way as the forms engine, which is the closest thing already in the app:
a template, its steps, and a record of every run.

**journeys**
name, description, trigger type, trigger delay in days, audience (locked to
homeowner), status (draft, active, paused), created and updated.

**journeySteps**
journeyId, sortOrder, kind, and a JSON config blob per kind. The seven kinds:
`email`, `sms`, `wait`, `branch`, `notify`, `move_journey`, `set_tag`. A branch step
carries the condition and the ids of the yes path and the no path, which is how the
canvas gets its two arms.

**journeyEnrolments**
journeyId, contactId, status (active, finished, exited, failed), current step,
the timestamp the next step is due, why it exited. One row per person per run
through a journey. This table is the engine's whole memory.

**emailTemplates**
name, subject, body, whether the footer is attached, active flag. Editable by you in
the app. Merge fields like `{{first_name}}`, `{{suburb}}`, `{{product}}` get filled
at send time.

**segments**
name, audience (homeowner or builder), a JSON rule set, and a flag for whether
journeys are allowed to use it. Builder segments always have that flag off, enforced
server side.

**sends**
Every individual email and SMS that went out: contactId, journeyId, stepId, channel,
subject, body as sent, provider message id, status, timestamps. This is the audit
trail. If a homeowner rings up asking what you sent them, it is in here.

**emailEvents**
sendId, type (delivered, opened, clicked, bounced, complained, replied), the link
that was clicked, when. Fed by Resend webhooks.

**unsubscribes**
email or mobile, when, from which journey, and the token behind the unsubscribe link.
Checked before every single send, no exceptions.

Messages replies thread onto the existing `messages` table so a contact's history
stays in one place rather than splitting in two.

## 4. The engine

One scheduled worker, runs every 5 minutes.

1. Find enrolments whose next step is due.
2. Check consent and unsubscribe. Fail either and the enrolment exits, logged.
3. Run the step. Email and SMS go out through the provider. A wait sets the next due
   time. A branch reads the condition and picks an arm. Notify creates an office
   task. Move journey exits this one and enrols them in another. Set tag writes to
   the contact.
4. Write the send row, advance the enrolment, or finish it.

Triggers are checked by the same worker: quote sent with no reply after X days, quote
accepted, job completed, measure appointment booked, no work in 12 months, install
anniversary. Each one looks at your existing jobs and quotes data, so nothing needs
entering twice.

Safety rails built in from the start: one enrolment per contact per journey at a
time, a cap of one marketing email per contact per 24 hours across all journeys,
nothing sends between 8pm and 8am, no SMS on Sundays.

## 5. Pages

**Marketing** in the sidebar, sitting under Price book, with five tabs.

**Journeys.** The list, then the builder. The builder is a canvas: steps as cards down
the page, a branch splitting into a yes arm and a no arm, drag to reorder, click a
card to edit it in a side panel. Draft and active toggle at the top, and a live count
of who is currently in it.

**Templates.** Write and edit the emails. Merge fields down the side, a preview pane,
and a test send to yourself.

**Contacts and segments.** Build a list from rules. Shows the matching count as you
change a rule, so you know what you are aiming at before you fire. Builder lists are
visibly marked "one-off sends only".

**Inbox.** team@ replies, newest first, threaded to the contact and their jobs.
Reply from inside the app and it goes back out from team@.

**Reports.** Per journey and per blast: sent, delivered, opened, clicked, replied,
unsubscribed, bounced. Plus a plain list of who is in each journey right now.

## 6. Email look

Mostly text, which is what gets delivered and what gets replies. Terra logo at the
top, normal readable paragraphs, a plain text link rather than a big button. Footer
carries Terra Flooring, the address, your phone, and the unsubscribe line. Legally you
need that unsubscribe link on marketing mail in Australia, and it also keeps you off
spam lists.

## 7. Order of build

| Step | What lands | Why first |
| --- | --- | --- |
| 1 | Schema, the 8 tables | Everything sits on it |
| 2 | Resend wired, domain verified, a test send to you | No point building on sending that does not work |
| 3 | Templates page | You can write your emails while the rest is built |
| 4 | Segments page with live counts | You can see your own homeowner list for the first time |
| 5 | Journey builder, drafts only, nothing sends | You design the follow-ups and check them |
| 6 | The engine, one journey switched live | Prove it on the smallest one, review requests after a job |
| 7 | Unsubscribe, consent, opens and clicks | Make it safe and measurable |
| 8 | team@ inbox | Replies stop going missing |
| 9 | ClickSend and the SMS step | Cheapest to bolt on last |
| 10 | Reports, and the one-off builder blast | The last two nice-to-haves |

## 8. Two things I want your call on before step 1

1. **The first journey.** I suggest review requests, 3 days after a job is marked
   complete. Low risk, every send goes to someone happy with finished floors, and it
   earns you Google reviews. Agree, or start somewhere else?
2. **Quote follow-up timing.** Quote sent and no reply after how many days? I would
   go 3 days for the first nudge, 10 for the second, then stop. Your call, you know
   how long people take to decide.
