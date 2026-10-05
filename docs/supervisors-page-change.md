# Supervisors page, fresh start

## SQL to run on the live database first

```sql
ALTER TABLE quotes ADD COLUMN supervisor_contact_id integer REFERENCES contacts(id) ON DELETE SET NULL;
```

No other schema change. The "gone quiet" months setting is a normal row in `settings`
(key `supervisor_quiet_months`, default 3 when missing), edited under Settings.

## What changed, in plain English

- Starts clean. Only jobs and quotes with a supervisor picked on purpose count. No guessing from old ServiceM8 contacts. The "Only 20 of 1,351 jobs" banner is gone.
- A supervisor is required when a job or quote is for a company. If they are not in the list, you add them on the spot and they are linked under that company.
- Quotes now carry the supervisor. It is kept when a quote is revised and passed onto the job when the quote is converted. A company quote with no supervisor (for example from a voice recording) saves as a draft but cannot be sent or turned into a job until one is picked. The quote screen shows a picker for it.
- Supervisors page: Last 12 months / This year / All time (default 12 months), Table/Chart toggle remembered per person on that device, summary strip (active supervisors, revenue, gone quiet), top 10 bar chart that follows the sort, top 5 donut, cards on phones.
- Gone quiet: shown on the Supervisors page and as a Dashboard card. The number of months is in Settings.
- Quote win rate per supervisor: quotes sent, won, win rate.
- Gross profit per job = sell price minus installer cost minus material cost (from the job's costs). If either is missing it shows "incomplete".
- A supervisor who moves company: "Moved company?" on their page. Old jobs and quotes stay under the old company. Damien is emailed (to damien@, sent from team@) when a supervisor's company or email changes.
- Detail page: line chart of jobs and quotes per month, companies history, jobs and quotes with the company each came from.
- Access: Office sees supervisors, jobs and revenue. Gross profit, win rate and the donut are stripped on the server unless Admin, or Office with cost access on.
- Fixed: revising a discounted quote now keeps the discount record, so Office cannot bypass approval by revising.
- People page: new "Installer cards without a login" section with Add installer.
- Bulk special options reworded: "Keep the extra profit" and "Pass the saving to the client".
