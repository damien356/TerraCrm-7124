/**
 * AI phone agent (Retell) tests 1 to 8 from the brief. Test 9 is a real call
 * and needs the Retell key, so it is not here.
 *
 * Run from packages/web: bun test scripts/phone
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { call, configure, m, MIN, outside, schema, seed, setup, sql, teardown, type Seed } from "./harness";

let s: Seed;

beforeAll(async () => {
  await setup();
  s = await seed();
  await configure(s);
});
afterAll(() => {
  expect(outside.fetch).toEqual([]);
  expect(outside.sms).toEqual([]);
  teardown();
});

const run = (name: string, c: ReturnType<typeof call>, args: Record<string, unknown> = {}, now = new Date()) => m().fns.runTool(name, { call: c, args }, now);
const callRow = async (c: { call_id: string }) => (await sql("select * from phone_calls where retell_call_id = ?", [c.call_id]))[0];
const fuOf = async (id: number) => (await m().followups.followupById(id))!;

/** A day at least two days out that the measurers work (a weekday), YYYY-MM-DD. */
function workday(offset = 3) {
  const { addLocalDays, todayLocal } = m().localDate;
  let d = addLocalDays(todayLocal(), offset);
  for (;;) {
    const wd = new Date(`${d}T12:00:00+10:00`).getUTCDay();
    if (wd !== 0 && wd !== 6) return d;
    d = addLocalDays(d, 1);
  }
}

/** A call from Alice's number with Alice verified on it. */
async function aliceCall() {
  const c = call("+61411111111");
  const v = await run("verify_caller", c, { last_name: "Anders", first_name: "Alice", street_address: "12 Smith St" });
  expect(v.ok).toBe(true);
  return c;
}

/* ------------------------------------------------------------------------ */

describe("signature", () => {
  test("only a fresh, correctly signed body is accepted", () => {
    const { signBody, checkSignature } = m().signature;
    const key = "retell_test_key_not_real";
    const body = JSON.stringify({ event: "call_started", call: { call_id: "x" } });
    const now = Date.now();
    const header = signBody(body, key, now);
    expect(checkSignature(body, header, now, key)).toEqual({ ok: true });
    expect(checkSignature(body.replace("x", "y"), header, now, key).ok).toBe(false);
    expect(checkSignature(body, signBody(body, "another key", now), now, key).ok).toBe(false);
    expect(checkSignature(body, signBody(body, key, now - 6 * MIN), now, key)).toEqual({ ok: false, reason: "signature too old" });
    expect(checkSignature(body, "", now, key).ok).toBe(false);
    expect(checkSignature(body, header, now, "").ok).toBe(false);
  });
});

describe("1. who is calling", () => {
  test("caller ID alone unlocks nothing", async () => {
    const c = call("+61411111111");
    const id = await run("identify_caller", c);
    expect(id.data).toMatchObject({ number_known: true, shared_number: true, number_withheld: false });
    expect(JSON.stringify(id)).not.toContain("Alice");
    const sum = await run("get_job_summary", c);
    expect(sum).toMatchObject({ ok: false, status: "refused", data: { needs: "verify_caller" } });
    const note = await run("add_call_note", c, { note: "Please call after 3" });
    expect(note.status).toBe("refused");
  });

  test("an outbound call (Terra's number ringing out) treats the number rung as the caller's", async () => {
    const c = call("+61756905370", { direction: "outbound", to_number: "+61411111111" });
    const id = await run("identify_caller", c);
    expect(id.data).toMatchObject({ number_known: true, shared_number: true, number_withheld: false });
    const row = await callRow(c);
    expect(row.direction).toBe("outbound");
    expect(row.from_number).toBe("+61411111111");
    expect(row.to_number).toBe("+61756905370");
    expect(row.withheld).toBe(0);
  });

  test("customer A: caller ID + surname + street verifies, and their one job is picked", async () => {
    const c = call("+61411111111");
    const v = await run("verify_caller", c, { last_name: "Anders", first_name: "Alice", street_address: "12 Smith St" });
    expect(v.ok).toBe(true);
    expect(v.data!.jobs).toHaveLength(1);
    const row = await callRow(c);
    expect(row.verified_contact_id).toBe(s.alice.id);
    expect(row.verify_method).toBe("caller ID + surname + site address");
    expect(row.job_id).toBe(s.jobA.id);
    // Andy shares the number and the surname but not the street.
    const sum = await run("get_job_summary", c);
    expect(sum.ok).toBe(true);
    expect(sum.data!.job_ref).toBe("4101");
  });

  test("a shared number with only the surname is not enough", async () => {
    const c = call("+61411111111");
    const v = await run("verify_caller", c, { last_name: "Anders" });
    expect(v.ok).toBe(false);
    expect((await callRow(c)).verified_contact_id).toBeNull();
  });

  test("withheld number needs two details, and three misses locks it", async () => {
    const c = call(null);
    expect((await run("verify_caller", c, { last_name: "Brown", street_address: "5 Ocean Pde" })).ok).toBe(false);
    expect((await run("verify_caller", c, { last_name: "Brown", street_address: "9 Wrong St" })).ok).toBe(false);
    expect((await run("verify_caller", c, { last_name: "Brown", email: "nope@example.invalid" })).ok).toBe(false);
    const locked = await run("verify_caller", c, { last_name: "Brown", street_address: "5 Ocean Pde", email: "bob@example.invalid" });
    expect(locked.data).toMatchObject({ locked: true });

    const c2 = call(null);
    const ok = await run("verify_caller", c2, { last_name: "Brown", street_address: "5 Ocean Pde", email: "bob@example.invalid" });
    expect(ok.ok).toBe(true);
    expect((await callRow(c2)).verify_method).toBe("surname + email on file + site address");
  });

  test("customer B has two jobs: the agent must ask which, and can't open anyone else's", async () => {
    const c = call("+61422222222");
    const v = await run("verify_caller", c, { last_name: "Brown", street_address: "5 Ocean Parade" });
    expect(v.ok).toBe(true);
    expect(v.data!.jobs).toHaveLength(2);
    expect((await callRow(c)).job_id).toBeNull();
    const ask = await run("get_job_summary", c);
    expect(ask).toMatchObject({ status: "refused", data: { needs: "job_ref" } });
    const b2 = await run("get_job_summary", c, { job_ref: "4103" });
    expect(b2.ok).toBe(true);
    expect(b2.data!.where).toContain("88 Hill Road");
    const other = await run("get_job_summary", c, { job_ref: "4101" });
    expect(other.status).toBe("refused");
    expect(JSON.stringify(other)).not.toContain("Smith");
  });

  test("the summary carries no costs, margins or crew pay", async () => {
    const { db } = m();
    const [q] = await db
      .insert(schema.quotes)
      .values({ number: 4102, version: 1, jobId: s.jobB1.id, contactId: s.bob.id, status: "sent", subtotal: 1000, gst: 100, total: 1100, validUntil: new Date(Date.now() + 20 * 86_400_000) })
      .returning();
    await db.insert(schema.quoteItems).values({ quoteId: q!.id, description: "Hybrid", qty: 10, unit: "m2", unitPrice: 100, unitCost: 37.77, markupPercent: 61.3, kind: "supply", lineType: "material", sortOrder: 0 });
    await db.insert(schema.jobCosts).values({ jobId: s.jobB1.id, description: "Crew pay", amount: 444.44 } as never);
    const c = call("+61422222222");
    await run("verify_caller", c, { last_name: "Brown", street_address: "5 Ocean Parade" });
    const sum = await run("get_job_summary", c, { job_ref: "4102" });
    expect(sum.ok).toBe(true);
    const text = JSON.stringify(sum);
    expect(text).toContain("$1,100.00");
    for (const bad of ["37.77", "61.3", "444.44", "cost", "margin", "markup", "pay"]) expect(text.toLowerCase()).not.toContain(bad);
  });
});

describe("2. new enquiry", () => {
  test("the same request twice makes one job, sourced AI phone call", async () => {
    const c = call("+61433333333");
    const args = { first_name: "Cara", last_name: "Clark", what_they_need: "Carpet for two bedrooms", suburb: "Varsity Lakes", street_address: "3 Lake Drive" };
    const one = await run("create_enquiry", c, args);
    expect(one.ok).toBe(true);
    const two = await run("create_enquiry", c, args);
    expect(two.ok).toBe(true);
    const jobs = await sql("select j.id, j.source, j.lead_flags, s.name as status from jobs j left join job_statuses s on s.id = j.status_id where j.title like 'Phone enquiry%'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe("AI phone call");
    expect(jobs[0].status).toBe("Lead");
    expect(JSON.parse(jobs[0].lead_flags)).toContain("Address not checked with Google");
    const cards = await sql("select * from contacts where last_name = 'Clark'");
    expect(cards).toHaveLength(1);
    expect(cards[0].mobile).toContain("433");
    const row = await callRow(c);
    expect(row.new_enquiry).toBe(1);
    expect(row.job_id).toBe(jobs[0].id);
    // Exactly one claim was made for it.
    expect(await sql("select * from phone_call_actions where call_id = ? and name = 'create_enquiry'", [row.id])).toHaveLength(1);
  });

  test("Retell retrying the same request returns the first answer", async () => {
    const c = call("+61433333334");
    const args = { first_name: "Dee", last_name: "Dunn", what_they_need: "Vinyl in the kitchen" };
    const a = await m().calls.upsertCall(c);
    const first = await run("create_enquiry", c, args);
    // A second call on the same row bypassing the "already saved" shortcut: runAction itself must dedupe.
    await m().calls.patchCall(a.id, { newEnquiry: false, jobId: null });
    const again = await run("create_enquiry", c, args);
    expect(again).toMatchObject({ repeat: true, ok: true });
    expect((again.data as { job_ref: string }).job_ref).toBe((first.data as { job_ref: string }).job_ref);
    expect(await sql("select * from contacts where last_name = 'Dunn'")).toHaveLength(1);
  });

  test("the same person calling again within 14 days adds a note, not a second job", async () => {
    const before = await sql("select count(*) as n from jobs");
    const c = call("+61433333333");
    const r = await run("create_enquiry", c, { first_name: "Cara", last_name: "Clark", what_they_need: "Also the hallway" });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ duplicate_of_existing: true });
    expect(r.say).not.toContain("Carpet");
    expect((await sql("select count(*) as n from jobs"))[0].n).toBe(before[0].n);
    const notes = await sql("select * from activity_log where action = 'phone_note' and detail like '%hallway%'");
    expect(notes).toHaveLength(1);
  });

  test("a different surname on the same number is a new person, flagged as a possible duplicate", async () => {
    const c = call("+61433333333");
    const r = await run("create_enquiry", c, { first_name: "Eve", last_name: "Evans", what_they_need: "Timber floor quote" });
    expect(r.ok).toBe(true);
    const [j] = await sql("select * from jobs where id = ?", [(await callRow(c)).job_id]);
    expect(j.lead_flags).toContain("Possible duplicate of card");
  });
});

describe("3. notes and access details", () => {
  test("a call note lands on the right job's history", async () => {
    const c = await aliceCall();
    const r = await run("add_call_note", c, { note: "Dog in the yard, use the side gate" });
    expect(r.ok).toBe(true);
    const rows = await sql("select * from activity_log where action = 'phone_note' and detail like '%side gate%'");
    expect(rows).toHaveLength(1);
    expect(rows[0].job_id).toBe(s.jobA.id);
    expect(rows[0].actor_name).toBe("AI phone agent");
  });

  test("access notes are only saved after the read-back", async () => {
    const c = await aliceCall();
    const no = await run("update_job_details", c, { field: "access_notes", new_value: "Key under the mat" });
    expect(no).toMatchObject({ status: "refused", data: { needs: "read_back_confirmed" } });
    expect((await sql("select access_notes from jobs where id = ?", [s.jobA.id]))[0].access_notes).toBeNull();
    const yes = await run("update_job_details", c, { field: "access_notes", new_value: "Key under the mat", read_back_confirmed: true });
    expect(yes.ok).toBe(true);
    expect((await sql("select access_notes from jobs where id = ?", [s.jobA.id]))[0].access_notes).toContain("Key under the mat");
    expect(await sql("select * from activity_log where action = 'access_notes_updated' and job_id = ?", [s.jobA.id])).toHaveLength(1);
  });

  test("other fields are never changed by the agent: they go to a person", async () => {
    const c = await aliceCall();
    const r = await run("update_job_details", c, { field: "site_address", new_value: "14 Smith Street" });
    expect(r.ok).toBe(true);
    expect(r.needsPerson).toBeTruthy();
    expect((await sql("select address from sites where id = ?", [s.sA.id]))[0].address).toBe("12 Smith Street, Robina");
  });
});

describe("4. measure and site visits", () => {
  test("offers only free times, books one, and won't book a taken or privately busy time", async () => {
    const day = workday(4);
    const c = await aliceCall();
    const avail = await run("check_availability", c, { from_date: day });
    expect(avail.ok).toBe(true);
    const slots = (avail.data as { slots: { slot: string; say: string }[] }).slots;
    expect(slots.length).toBeGreaterThan(0);
    const first = slots[0]!.slot;
    expect(first).toBe(`${day}|08:00|${s.measurer.id}`);

    const booked = await run("book_visit", c, { slot: first });
    expect(booked.ok).toBe(true);
    const tasks = await sql("select * from job_tasks where job_id = ? and skill_id = ?", [s.jobA.id, s.skill.id]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].assigned_installer_id).toBe(s.measurer.id);
    const days = await sql("select * from task_days where task_id = ?", [tasks[0].id]);
    expect(days.map((d: any) => [d.date, d.arrival_start])).toEqual([[day, "08:00"]]);

    // Cal's private calendar is busy 08:00 to 09:00 that day.
    outside.busy.set(s.link.id, [{ startAt: Date.parse(`${day}T08:00:00+10:00`), endAt: Date.parse(`${day}T09:00:00+10:00`) }]);
    const b = call("+61422222222");
    await run("verify_caller", b, { last_name: "Brown", street_address: "5 Ocean Parade" });
    const again = await run("check_availability", b, { from_date: day });
    const offered = (again.data as { slots: { slot: string }[] }).slots.map((x) => x.slot);
    expect(offered).not.toContain(`${day}|08:00|${s.measurer.id}`);
    expect(offered).not.toContain(`${day}|08:00|${s.measurer2.id}`);
    expect(offered[0]).toBe(`${day}|10:00|${s.measurer.id}`);
    expect(outside.freeBusy.length).toBeGreaterThan(0);
    // Nothing about why: no private detail reaches the agent.
    expect(JSON.stringify(again).toLowerCase()).not.toMatch(/personal|busy|calendar|google/);

    // Asking for the taken slot or the privately busy one anyway.
    const taken = await run("book_visit", b, { slot: first, job_ref: "4102" });
    expect(taken).toMatchObject({ ok: false, data: { slot_gone: true } });
    const busy = await run("book_visit", b, { slot: `${day}|08:00|${s.measurer2.id}`, job_ref: "4102" });
    expect(busy).toMatchObject({ ok: false, data: { slot_gone: true } });
    expect(await sql("select * from job_tasks where job_id = ? and status != 'cancelled'", [s.jobB1.id])).toHaveLength(0);

    // A second visit on a job that already has one goes to a person.
    const dup = await run("book_visit", c, { slot: `${day}|13:00|${s.measurer.id}` });
    expect(dup.ok).toBe(false);
    expect(dup.needsPerson).toContain("already on the job");
    outside.busy.clear();
  });

  test("a calendar that can't be read counts as busy", async () => {
    const { db, drizzle, visits, config } = m();
    const day = workday(5);
    const cfg = await config.loadPhoneConfig();
    expect(await visits.slotFree(cfg, s.measurer2.id, day, "13:00")).toBe(true);
    await db.update(schema.calendarLinks).set({ refreshTokenSealed: null, lastError: "Google sign-in expired" }).where(drizzle.eq(schema.calendarLinks.id, s.link.id));
    expect(await visits.slotFree(cfg, s.measurer2.id, day, "13:00")).toBe(false);
    await db.update(schema.calendarLinks).set({ refreshTokenSealed: "sealed-test-not-real", lastError: null }).where(drizzle.eq(schema.calendarLinks.id, s.link.id));
  });
});

describe("5. quote resend", () => {
  test("resends the one current quote to the address it went to, like pressing Send", async () => {
    const { db } = m();
    const [q] = await db
      .insert(schema.quotes)
      .values({
        number: 4101,
        version: 1,
        jobId: s.jobA.id,
        contactId: s.alice.id,
        status: "sent",
        subtotal: 2000,
        gst: 200,
        total: 2200,
        depositPercent: 30,
        depositSource: "quote",
        billToType: "contact",
        billToContactId: s.alice.id,
        validUntil: new Date(Date.now() + 25 * 86_400_000),
      })
      .returning();
    await db.insert(schema.quoteSends).values({
      quoteId: q!.id,
      sendKey: "office-press-1",
      quoteTotal: 2200,
      kind: "first",
      byName: "Test damien",
      emailTo: "alice@example.invalid",
      emailStatus: "sent",
      emailAt: new Date(),
      emailJson: JSON.stringify({ to: "alice@example.invalid", subject: "Your Terra Flooring quote", body: "Hi Alice, here is your quote." }),
    });
    const before = outside.jobMail.length;
    const c = await aliceCall();
    const r = await run("resend_quote", c);
    expect(r.ok).toBe(true);
    expect(r.say).toContain("email address we have on file");
    expect(outside.jobMail.length).toBe(before + 1);
    expect(outside.jobMail.at(-1)).toMatchObject({ to: "alice@example.invalid", jobId: s.jobA.id });
    const sends = await sql("select * from quote_sends where quote_id = ? order by id", [q!.id]);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toMatchObject({ kind: "first", email_status: "sent", email_to: "alice@example.invalid", by_name: "AI phone agent" });

    // Asked again on the same call: not sent twice.
    const twice = await run("resend_quote", c);
    expect(twice).toMatchObject({ repeat: true });
    expect(outside.jobMail.length).toBe(before + 1);
  });

  test("more than one current quote goes to the office instead", async () => {
    const { db } = m();
    await db.insert(schema.quotes).values({ number: 4102, version: 2, jobId: s.jobB1.id, contactId: s.bob.id, status: "sent", subtotal: 900, gst: 90, total: 990, validUntil: new Date(Date.now() + 20 * 86_400_000) });
    const before = outside.jobMail.length;
    const c = call("+61422222222");
    await run("verify_caller", c, { last_name: "Brown", street_address: "5 Ocean Parade" });
    const r = await run("resend_quote", c, { job_ref: "4102" });
    expect(r.ok).toBe(true);
    expect(r.needsPerson).toBe("Caller asked for their quote again");
    expect(outside.jobMail.length).toBe(before);
    const [fu] = await sql("select * from phone_followups where call_id = ? and title = 'Caller asked for their quote again'", [(await callRow(c)).id]);
    expect(fu.detail).toContain("more than one current quote");
  });
});

describe("6. routing", () => {
  test("an existing-job callback goes to office staff, not the admin", async () => {
    const c = await aliceCall();
    const r = await run("request_callback", c, { reason: "Wants to talk about the colour" });
    expect(r.ok).toBe(true);
    const [fu] = await sql("select * from phone_followups where call_id = ?", [(await callRow(c)).id]);
    expect([s.sam.id, s.kim.id]).toContain(fu.owner_profile_id);
    expect(fu.owner_profile_id).not.toBe(s.damien.id);
    expect(fu.status).toBe("assigned");
    expect(fu.routed_via).toBe("the Office team");
  });

  test("the job's manager gets it first when set", async () => {
    const { db, routing, config } = m();
    await db.insert(schema.jobManagers).values({ jobId: s.jobA.id, profileId: s.lou.id });
    const route = await routing.resolveRoute(await config.loadPhoneConfig(), "existing_job", { jobId: s.jobA.id });
    expect(route).toMatchObject({ ownerProfileId: s.lou.id, via: "job manager" });
  });

  test("a new enquiry goes to sales", async () => {
    const { routing, config } = m();
    const route = await routing.resolveRoute(await config.loadPhoneConfig(), "enquiry");
    expect(route.ownerProfileId).toBe(s.sam.id);
  });

  test("the owner hears about it, and a person with no phone falls back to the queue", async () => {
    const { followups, config } = m();
    const cfg = await config.loadPhoneConfig();
    // Accounts goes to Lou, who has no phone signed in.
    const { row } = await followups.createFollowup(cfg, { dedupeKey: "test:accounts:1", callType: "accounts", title: "Invoice question", detail: "Asked about the invoice" });
    expect(row.ownerProfileId).toBe(s.lou.id);
    const sent = await sql("select * from phone_notifications where followup_id = ? order by id", [row.id]);
    expect(sent.find((n: any) => n.channel === "in_app")).toMatchObject({ status: "sent" });
    expect(sent.find((n: any) => n.channel === "push" && n.profile_id === s.lou.id)).toMatchObject({ status: "no_device" });
    // The office queue's people get it instead (Sam has a phone).
    expect(sent.find((n: any) => n.reason === "fallback" && n.profile_id === s.sam.id)).toMatchObject({ status: "sent" });
  });

  test("email not connected is recorded, not hidden", async () => {
    const { followups, config } = m();
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      const { row } = await followups.createFollowup(await config.loadPhoneConfig(), { dedupeKey: "test:urgent:1", callType: "urgent", title: "Water on the floor", detail: "Urgent" });
      expect(row.ownerProfileId).toBe(s.damien.id);
      const sent = await sql("select * from phone_notifications where followup_id = ? and channel = 'email'", [row.id]);
      expect(sent[0]).toMatchObject({ status: "not_connected" });
    } finally {
      process.env.RESEND_API_KEY = key;
    }
  });
});

describe("7. ownership, cover, fallbacks, escalation", () => {
  test("reassigning keeps the deadline, writes an audit line and tells the new owner", async () => {
    const { followups, config } = m();
    const cfg = await config.loadPhoneConfig();
    const { row } = await followups.createFollowup(cfg, { dedupeKey: "test:reassign", callType: "booking", title: "Move the install", detail: "Wants a later date" });
    expect(row.ownerProfileId).toBe(s.kim.id);
    const moved = await followups.assignFollowup(cfg, row.id, s.sam.id, { name: "Test damien", role: "admin", profileId: s.damien.id }, "Kim is flat out");
    expect(moved.ownerProfileId).toBe(s.sam.id);
    expect(moved.dueAt!.getTime()).toBe(row.dueAt!.getTime());
    const audit = await sql("select * from activity_log where entity_type = 'phone_followup' and entity_id = ? and action = 'followup_reassigned'", [row.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].detail).toBe("Test kim → Test sam. Kim is flat out");
    expect(audit[0].actor_name).toBe("Test damien");
    const told = await sql("select * from phone_notifications where followup_id = ? and profile_id = ? and reason = 'new_owner' and channel = 'push'", [row.id, s.sam.id]);
    expect(told[0]).toMatchObject({ status: "sent" });
    // Claim, start, resolve, reopen.
    const claimed = await followups.claimFollowup(cfg, row.id, { name: "Test kim", role: "office", profileId: s.kim.id });
    expect(claimed).toMatchObject({ ownerProfileId: s.kim.id, status: "in_progress" });
    await expect(followups.resolveFollowup(row.id, { name: "Test kim", role: "office", profileId: s.kim.id }, "ok")).rejects.toThrow();
    const done = await followups.resolveFollowup(row.id, { name: "Test kim", role: "office", profileId: s.kim.id }, "Rang her, moved to Friday");
    expect(done.status).toBe("resolved");
    const back = await followups.reopenFollowup(row.id, { name: "Test damien", role: "admin", profileId: s.damien.id }, "She rang again");
    expect(back).toMatchObject({ status: "assigned", ownerProfileId: s.kim.id });
    expect(back.dueAt!.getTime()).toBe(row.dueAt!.getTime());
    // Nobody switched off or outside the office can be given it.
    await expect(followups.assignFollowup(cfg, row.id, s.off.id, { name: "Test damien", role: "admin", profileId: s.damien.id })).rejects.toThrow();
    await expect(followups.assignFollowup(cfg, row.id, s.field.id, { name: "Test damien", role: "admin", profileId: s.damien.id })).rejects.toThrow();
  });

  test("leave cover sends new work to the cover and moves open work, deadlines kept", async () => {
    const { db, followups, routing, config, webhook, localDate } = m();
    const cfg = await config.loadPhoneConfig();
    const { row } = await followups.createFollowup(cfg, { dedupeKey: "test:leave:open", callType: "booking", title: "Install time", detail: "x" });
    expect(row.ownerProfileId).toBe(s.kim.id);
    const today = localDate.todayLocal();
    await db.insert(schema.staffCover).values({ profileId: s.kim.id, coverProfileId: s.lou.id, kind: "leave", fromDate: today, toDate: localDate.addLocalDays(today, 5), reason: "Holiday" });
    const route = await routing.resolveRoute(cfg, "booking");
    expect(route.ownerProfileId).toBe(s.lou.id);
    expect(route.steps.join(" ")).toContain("is on leave");
    const out = await webhook.sweepOnce(new Date());
    expect(out.coverMoved).toBeGreaterThanOrEqual(1);
    const after = await fuOf(row.id);
    expect(after.ownerProfileId).toBe(s.lou.id);
    expect(after.dueAt!.getTime()).toBe(row.dueAt!.getTime());
    await db.update(schema.staffCover).set({ cancelledAt: new Date() });
  });

  test("a switched-off owner falls to the backup, then the duty person, then the queue", async () => {
    const { routing, config } = m();
    const base = await config.loadPhoneConfig();
    const cfg = config.phoneConfigSchema.parse({ ...base, rules: { ...base.rules, complaint: { dest: { kind: "profile", profileId: s.off.id }, backupProfileId: s.kim.id } } });
    expect(await routing.resolveRoute(cfg, "complaint")).toMatchObject({ ownerProfileId: s.kim.id, via: "backup" });
    const noBackup = config.phoneConfigSchema.parse({ ...cfg, rules: { ...cfg.rules, complaint: { dest: { kind: "profile", profileId: s.off.id }, backupProfileId: s.gone.id } } });
    const r2 = await routing.resolveRoute(noBackup, "complaint");
    expect(r2).toMatchObject({ ownerProfileId: s.duty.id, via: "duty person" });
    expect(r2.steps.join(" ")).toContain("is switched off");
    expect(r2.steps.join(" ")).toContain("is archived");
    const nobody = config.phoneConfigSchema.parse({ ...noBackup, dutyProfileId: s.off.id });
    const r3 = await routing.resolveRoute(nobody, "complaint");
    expect(r3).toMatchObject({ ownerProfileId: null, via: "queue", queueKey: "office" });
  });

  test("deadlines count office hours only, unless it's urgent", async () => {
    const { config } = m();
    const base = await config.loadPhoneConfig();
    const cfg = config.phoneConfigSchema.parse({ ...base, officeHours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" } });
    const at = (s: string) => new Date(s).getTime();
    // Friday 4pm plus 2 office hours: 1 hour Friday, 1 hour Monday.
    expect(config.deadlineFrom(cfg, 120, new Date("2026-11-06T16:00:00+10:00")).getTime()).toBe(at("2026-11-09T09:00:00+10:00"));
    // Saturday night: the clock starts Monday 8am.
    expect(config.deadlineFrom(cfg, 60, new Date("2026-11-07T21:00:00+10:00")).getTime()).toBe(at("2026-11-09T09:00:00+10:00"));
    // Urgent: real minutes, day or night.
    expect(config.deadlineFrom(cfg, 30, new Date("2026-11-07T21:00:00+10:00"), true).getTime()).toBe(at("2026-11-07T21:30:00+10:00"));
  });

  test("past its deadline it escalates once, and unowned work gets an owner", async () => {
    const { followups, config, webhook } = m();
    const base = await config.loadPhoneConfig();
    try {
    // Accounts with nobody in the team and no duty person: it waits unowned.
    await config.savePhoneConfig(config.phoneConfigSchema.parse({ ...base, dutyProfileId: null, teams: base.teams.map((t) => (t.key === "accounts" ? { ...t, memberIds: [] } : t)) }));
    // Whole seconds: the database stores times to the second.
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    const cfgNow = await config.loadPhoneConfig();
    const { row } = await followups.createFollowup(cfgNow, { dedupeKey: "test:overdue", callType: "accounts", title: "Refund question", detail: "x", now: t0 });
    expect(row).toMatchObject({ ownerProfileId: null, status: "new" });
    const due = row.dueAt!.getTime();
    // 8 office hours. The test office is shut 23:59 to midnight, so it can be a minute longer.
    expect(due).toBe(config.deadlineFrom(cfgNow, 480, t0).getTime());
    expect(due - t0.getTime()).toBeGreaterThanOrEqual(480 * MIN);
    expect(due - t0.getTime()).toBeLessThanOrEqual(481 * MIN);

    // The sweep looks at everything open, so check this follow-up rather than the totals.
    await webhook.sweepOnce(new Date(due - 10 * MIN));
    expect(await fuOf(row.id)).toMatchObject({ escalationLevel: 0, ownerProfileId: null });
    expect((await fuOf(row.id)).remindedAt).not.toBeNull();

    const late = await webhook.sweepOnce(new Date(due + MIN));
    expect(late.escalated).toBeGreaterThanOrEqual(1);
    const after = await fuOf(row.id);
    expect(after).toMatchObject({ escalationLevel: 1, ownerProfileId: s.damien.id, routedVia: "escalation", status: "assigned" });
    expect(await sql("select * from activity_log where entity_id = ? and action = 'followup_escalated'", [row.id])).toHaveLength(1);
    expect(await sql("select * from phone_notifications where followup_id = ? and reason = 'escalation' and channel = 'email'", [row.id])).toHaveLength(1);
    // Never twice.
    await webhook.sweepOnce(new Date(due + 5 * MIN));
    expect((await fuOf(row.id)).escalationLevel).toBe(1);
    expect(await sql("select * from activity_log where entity_id = ? and action = 'followup_escalated'", [row.id])).toHaveLength(1);
    } finally {
      await config.savePhoneConfig(base);
    }
  });
});

describe("8. repeats, failures and dropped calls", () => {
  test("a failed write is recorded, a person is told at once, and the caller isn't told it's done", async () => {
    outside.failCreateJob = 1;
    const c = call("+61444444444");
    const r = await run("create_enquiry", c, { first_name: "Fay", last_name: "Fox", what_they_need: "Tiles" });
    expect(r).toMatchObject({ ok: false, status: "failed" });
    expect(r.say).toContain("couldn't save that");
    const row = await callRow(c);
    const [act] = await sql("select * from phone_call_actions where call_id = ?", [row.id]);
    expect(act.status).toBe("failed");
    expect(act.error).toContain("database refused");
    const fus = await sql("select * from phone_followups where call_id = ?", [row.id]);
    expect(fus).toHaveLength(1);
    expect(fus[0]).toMatchObject({ call_type: "failure", priority: "high", owner_profile_id: s.duty.id });
    expect(await sql("select * from contacts where last_name = 'Fox'")).toHaveLength(0);
  });

  test("the line drops mid-write: the action is uncertain and the call still gets an outcome and an owner", async () => {
    const { db, webhook, calls } = m();
    const c = call("+61455555555");
    await webhook.handleRetellEvent({ event: "call_started", call: c });
    const row = await calls.upsertCall(c);
    // A write was claimed and the process never finished it.
    const k = calls.idemKeyFor(c.call_id, "add_call_note", {});
    await db.insert(schema.phoneCallActions).values({ callId: row.id, name: "add_call_note", idemKey: k, args: "{}", status: "running" });
    // Asked again while still running: the agent is not told it's done, and the write doesn't run twice.
    let ranAgain = false;
    const still = await calls.runAction(row, "add_call_note", {}, async () => {
      ranAgain = true;
      return { ok: true, status: "done", say: "" };
    });
    expect(still).toMatchObject({ ok: false, status: "uncertain", repeat: true });
    expect(ranAgain).toBe(false);

    const ended = Date.now();
    await webhook.handleRetellEvent({ event: "call_ended", call: { ...c, end_timestamp: ended, duration_ms: 45_000, disconnection_reason: "user_hangup" } });
    const acts = await sql("select * from phone_call_actions where call_id = ? and idem_key = ?", [row.id, k]);
    expect(acts).toHaveLength(1);
    expect(acts[0].status).toBe("uncertain");
    // No analysis comes. Ten minutes later the sweep closes it out anyway.
    const out = await webhook.sweepOnce(new Date(ended + 11 * MIN));
    expect(out.finalised).toBe(1);
    const fin = await callRow(c);
    expect(fin.status).toBe("finalised");
    expect(fin.analysis_state).toBe("missing");
    expect(fin.needs_person).toContain("add call note not confirmed");
    const fus = await sql("select * from phone_followups where call_id = ? and status != 'resolved'", [row.id]);
    // One piece of work for the call: check the note with the caller. No second "ring back".
    expect(fus).toHaveLength(1);
    expect(fus[0].title).toBe("AI call action not confirmed: add call note");
    expect(fus[0].owner_profile_id).not.toBeNull();
    // Finalising again does nothing.
    expect((await webhook.finaliseCall(row.id)).finalised).toBe(false);
  });

  test("a write left running is marked uncertain by the sweep with a failure follow-up", async () => {
    const { db, webhook, calls } = m();
    const c = call("+61466666666");
    const row = await calls.upsertCall(c);
    const old = Math.floor(Date.now() / 1000) - 5 * 60;
    await db.insert(schema.phoneCallActions).values({ callId: row.id, name: "book_visit", idemKey: `${c.call_id}:book_visit:y`, args: "{}", status: "running", createdAt: new Date(old * 1000) });
    const out = await webhook.sweepOnce(new Date());
    expect(out.uncertain).toBeGreaterThanOrEqual(1);
    const fus = await sql("select * from phone_followups where dedupe_key = ?", [`call:${row.id}:failure:book_visit`]);
    expect(fus).toHaveLength(1);
    expect(fus[0].title).toBe("AI call action not confirmed: book visit");
  });

  test("the analysis arriving after a hang-up gives one outcome, and retried webhooks change nothing", async () => {
    const { webhook } = m();
    const c = await aliceCall();
    await run("add_call_note", c, { note: "Prefers mornings" });
    const ended = { ...c, end_timestamp: Date.now(), duration_ms: 60_000 };
    await webhook.handleRetellEvent({ event: "call_ended", call: ended });
    await webhook.handleRetellEvent({ event: "call_ended", call: ended });
    const analyzed = { ...ended, call_analysis: { call_summary: "Alice added a note.", custom_analysis_data: {} } };
    await webhook.handleRetellEvent({ event: "call_analyzed", call: analyzed });
    await webhook.handleRetellEvent({ event: "call_analyzed", call: analyzed });
    const row = await callRow(c);
    expect(row.status).toBe("finalised");
    expect(row.outcome).toContain("Note added to the job");
    expect(row.needs_person).toBe("");
    expect(await sql("select * from phone_followups where call_id = ?", [row.id])).toHaveLength(0);
    const outcome = await sql("select * from phone_notifications where call_id = ? and reason = 'outcome' and channel = 'in_app'", [row.id]);
    expect(outcome).toHaveLength(1);
  });

  test("a transfer nobody answered becomes a call back", async () => {
    const { webhook } = m();
    const c = call("+61477777777");
    await webhook.handleRetellEvent({ event: "transfer_failed", call: c });
    await webhook.handleRetellEvent({ event: "transfer_failed", call: c });
    const row = await callRow(c);
    expect(await sql("select * from phone_followups where call_id = ? and title = 'Transfer not answered: call back'", [row.id])).toHaveLength(1);
  });

  test("switched off, or an action off: refused with a hand-over line, nothing written", async () => {
    const { config } = m();
    const base = await config.loadPhoneConfig();
    await config.savePhoneConfig(config.phoneConfigSchema.parse({ ...base, actions: { ...base.actions, enquiry: false } }));
    const c = call("+61488888888");
    const r = await run("create_enquiry", c, { first_name: "Gus", last_name: "Gray", what_they_need: "Carpet" });
    expect(r).toMatchObject({ status: "refused", data: { action_off: "enquiry", use: "request_callback" } });
    await config.savePhoneConfig(config.phoneConfigSchema.parse({ ...base, enabled: false }));
    const r2 = await run("add_call_note", c, { note: "x y z" });
    expect(r2).toMatchObject({ status: "refused", data: { switched_off: true } });
    await config.savePhoneConfig(base);
    expect(await sql("select * from contacts where last_name = 'Gray'")).toHaveLength(0);
  });
});

describe("the real endpoints Retell calls", () => {
  const key = "retell_test_key_not_real";
  const post = async (path: string, body: unknown, header?: string) => {
    const { default: app } = await import("../../src/api/index");
    const raw = JSON.stringify(body);
    const res = await app.request(path, { method: "POST", body: raw, headers: { "content-type": "application/json", ...(header === undefined ? {} : { "x-retell-signature": header }) } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const signed = (body: unknown) => m().signature.signBody(JSON.stringify(body), key);

  test("a tool call: unsigned or forged is refused, signed is answered", async () => {
    const c = call("+61411111111");
    const body = { name: "identify_caller", call: c, args: {} };
    expect((await post("/api/retell/fn/identify_caller", body)).status).toBe(401);
    expect((await post("/api/retell/fn/identify_caller", body, m().signature.signBody(JSON.stringify(body), "wrong key"))).status).toBe(401);
    expect((await post("/api/retell/fn/add_call_note", body, signed(body))).status).toBe(400);
    const ok = await post("/api/retell/fn/identify_caller", body, signed(body));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, data: { number_known: true } });
    expect(JSON.stringify(ok.body)).not.toContain("Alice");
  });

  test("the call webhook: signed events are stored, other agents are ignored, no key means 503", async () => {
    const c = call("+61499999999");
    const ev = { event: "call_started", call: c };
    expect((await post("/api/webhooks/retell", ev)).status).toBe(401);
    const ok = await post("/api/webhooks/retell", ev, signed(ev));
    expect(ok).toMatchObject({ status: 200, body: { ok: true, handled: true } });
    expect(await callRow(c)).toBeTruthy();

    process.env.RETELL_AGENT_ID = "agent_the_real_one";
    try {
      const other = { event: "call_started", call: call("+61488888888") };
      expect((await post("/api/webhooks/retell", other, signed(other))).body).toMatchObject({ ok: true, ignored: "other agent" });
      expect(await callRow(other.call)).toBeUndefined();
      const fn = { call: call("+61488888888"), args: {} };
      expect((await post("/api/retell/fn/identify_caller", fn, signed(fn))).status).toBe(403);
    } finally {
      delete process.env.RETELL_AGENT_ID;
    }

    const saved = process.env.RETELL_API_KEY;
    delete process.env.RETELL_API_KEY;
    try {
      expect((await post("/api/webhooks/retell", ev, signed(ev))).status).toBe(503);
      expect((await post("/api/retell/fn/identify_caller", { call: c }, signed({ call: c }))).status).toBe(503);
    } finally {
      process.env.RETELL_API_KEY = saved;
    }
  });
});
