/**
 * The billing summary on a client invoice (Damien, 26 Oct): one calculation
 * from the accepted quote, approved variations and issued invoices, withheld
 * when the figures disagree, saved at the first email so a re-send never
 * pulls revised scope or figures, and the PDF's amount due held to the pay
 * page's.
 *
 * Runs on its own throwaway database file built from schema.ts. No email
 * leaves: the mail sender is replaced. Run: bun test scripts/invoice-summary.test.ts
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import * as schema from "../src/api/database/schema";

const dir = mkdtempSync(join(tmpdir(), "inv-summary-"));
const file = join(dir, "test.db");
process.env.DATABASE_URL = `file:${file}`;
delete process.env.DATABASE_AUTH_TOKEN;
// Nothing is sent and nobody signs in; these modules only need a value to load.
process.env.RESEND_API_KEY ??= "re_test_not_used";
process.env.APPLICATION_ID ??= "test";
process.env.VITE_RUNABLE_AUTH_ISSUER ??= "https://auth.example.invalid";

type Mods = {
  db: typeof import("../src/api/database").db;
  ci: typeof import("../src/api/lib/client-invoices");
  fi: typeof import("../src/api/lib/final-invoice");
  sum: typeof import("../src/api/lib/invoice-summary");
  pdf: typeof import("../src/api/lib/clientInvoicePdf");
  mail: typeof import("../src/api/lib/invoice-email");
  va: typeof import("../src/api/lib/variation-accept");
  pay: typeof import("../src/api/routes/publicPages");
};
let m: Mods;
let client: Client;
/** Every email the fake sender was handed. */
const outbox: { to: string; files: { filename: string; content: Buffer }[] }[] = [];
const actor = { name: "Test Office", role: "office" };

beforeAll(async () => {
  client = createClient({ url: `file:${file}` });
  const ddl = await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema as any));
  for (const s of ddl) await client.execute(s);
  const realMail = await import("../src/api/lib/job-mail");
  mock.module("../src/api/lib/job-mail", () => ({
    ...realMail,
    pickedFiles: async () => [],
    sendJobEmail: async (a: { to: string; files: { filename: string; content: Buffer }[] }) => {
      outbox.push({ to: a.to, files: a.files });
      return { via: "test", message: { id: outbox.length }, linked: [] };
    },
  }));
  m = {
    db: (await import("../src/api/database")).db,
    ci: await import("../src/api/lib/client-invoices"),
    fi: await import("../src/api/lib/final-invoice"),
    sum: await import("../src/api/lib/invoice-summary"),
    pdf: await import("../src/api/lib/clientInvoicePdf"),
    mail: await import("../src/api/lib/invoice-email"),
    va: await import("../src/api/lib/variation-accept"),
    pay: await import("../src/api/routes/publicPages"),
  };
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

const q = async (sql: string, args: (string | number | null)[] = []) => (await client.execute({ sql, args })).rows as any[];

let nextJob = 990100;
/** A job with an accepted quote of `total` inc GST, one section of wording, and its value set the way quote-accept.ts sets it. */
async function jobWithQuote(total: number, wording = "Supply and install hybrid plank to the living room.") {
  const number = nextJob++;
  const { db } = m;
  const [contact] = await db.insert(schema.contacts).values({ firstName: "Test", lastName: `Client ${number}`, email: `c${number}@example.invalid` }).returning();
  const [site] = await db.insert(schema.sites).values({ address: "1 Test St", suburb: "Nerang", state: "QLD", postcode: "4211" }).returning();
  const [job] = await db.insert(schema.jobs).values({ number, siteId: site!.id, contactId: contact!.id, billToType: "contact", value: total }).returning();
  const subtotal = Math.round((total / 1.1) * 100) / 100;
  const [quote] = await db
    .insert(schema.quotes)
    .values({ number, version: 1, jobId: job!.id, contactId: contact!.id, status: "accepted", layout: "sections", subtotal, gst: Math.round((total - subtotal) * 100) / 100, total })
    .returning();
  await db.insert(schema.quoteItems).values({ quoteId: quote!.id, kind: "supply", description: "Hybrid plank", qty: 1, unitPrice: subtotal, total: subtotal });
  const { bundlesFor, saveBundle } = await import("../src/api/routes/quoteBundles");
  const { bundles } = await bundlesFor(quote!);
  for (const b of bundles) await saveBundle(quote!.id, b.key, { title: "Flooring supply", wording });
  return { job: job!, quote: quote!, contact: contact! };
}

const invoiceRow = async (id: number) => (await q("select * from invoices where id = ?", [id]))[0];
const fullInvoice = async (id: number) => {
  const { eq } = await import("drizzle-orm");
  const [row] = await m.db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
  return row!;
};

/** The PDF's text, pages joined, read back with pdftotext. */
function textOf(pdf: Buffer, name: string) {
  const f = join(dir, `${name}.pdf`);
  writeFileSync(f, pdf);
  const p = Bun.spawnSync(["pdftotext", "-layout", f, "-"]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
}
const amountDueIn = (t: string) => {
  const hit = t.match(/Amount due on this invoice\s+\$([\d,]+\.\d\d)/);
  if (!hit) throw new Error("no Amount due on this invoice in the PDF");
  return Number(hit[1]!.replace(/,/g, ""));
};

/** Draw the invoice's PDF as an email would, and check its amount due against the pay page. */
async function pdfAgreesWithPayPage(id: number, name: string) {
  const { pdf } = await m.pdf.clientInvoicePdfFor(id);
  const text = textOf(pdf, name);
  const pay = await m.pay.payState(await fullInvoice(id));
  expect(amountDueIn(text)).toBe(pay.owing);
  // Never a job balance or a job payment figure on the invoice.
  expect(text).not.toContain("Paid on this job");
  expect(text).not.toMatch(/outstanding/i);
  expect(text).not.toContain("Job balance");
  return { text, owing: pay.owing };
}

async function variation(jobId: number, seq: number, total: number, description: string) {
  const subtotal = Math.round((total / 1.1) * 100) / 100;
  const [v] = await m.db
    .insert(schema.variations)
    .values({ jobId, ref: `V-${jobId}-0${seq}`, seq, description, status: "sent", subtotal, gst: Math.round((total - subtotal) * 100) / 100, total, amount: total })
    .returning();
  return v!;
}

describe("billing summary", () => {
  test("deposit: quote, this invoice and what remains. Amount due matches the pay page", async () => {
    const { job, quote } = await jobWithQuote(4048.28);
    const dep = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 50% on quote", total: 2024.14, createdByName: "t", actorRole: "system" });
    const s = await m.sum.billingSummaryFor(dep);
    expect(s.state).toBe("shown");
    if (s.state !== "shown") return;
    expect(s.lines.map((l) => l.kind)).toEqual(["quote", "this", "remaining"]);
    expect(s.remaining).toBe(2024.14);
    const { text, owing } = await pdfAgreesWithPayPage(dep.id, "deposit");
    expect(owing).toBe(2024.14);
    expect(text).toContain("BILLING SUMMARY FOR THIS JOB");
    expect(text).toContain("Remaining to invoice after this invoice");
    expect(text).not.toContain("Previously invoiced");
  });

  test("part payment: the summary is unchanged, the PDF and pay page both drop the amount due", async () => {
    const { job, quote } = await jobWithQuote(3000);
    const dep = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 50% on quote", total: 1500, createdByName: "t", actorRole: "system" });
    const before = await m.sum.billingSummaryFor(dep);
    await m.ci.markInvoicePaid({ id: dep.id, amount: 400, method: "bank", byName: "t", actorRole: "office" });
    const after = await m.sum.billingSummaryFor(await fullInvoice(dep.id));
    expect(after).toEqual(before);
    const { text, owing } = await pdfAgreesWithPayPage(dep.id, "part-paid");
    expect(owing).toBe(1100);
    expect(text).toContain("Paid on this invoice");
    expect(text).toContain("$400.00");
  });

  test("progress, approved variation, voided invoice and final: one calculation, and it matches the job page", async () => {
    const { job, quote } = await jobWithQuote(10000);
    const dep = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 30% on quote", total: 3000, createdByName: "t", actorRole: "system" });
    await m.ci.markInvoicePaid({ id: dep.id, amount: 1000, method: "bank", byName: "t", actorRole: "office" });

    const prog = await m.fi.raiseJobInvoice({ jobId: job.id, kind: "stage", amount: 2000, actor });
    let s = await m.sum.billingSummaryFor(prog);
    expect(s.state).toBe("shown");
    if (s.state !== "shown") return;
    // The deposit is listed at what was invoiced, $3,000, not the $1,000 paid on it.
    expect(s.lines.filter((l) => l.kind === "previous").map((l) => l.amount)).toEqual([3000]);
    expect(s.remaining).toBe(5000);
    expect(s.remaining).toBe((await m.fi.billingOnJob(job.id)).toBill);
    const progPdf = await pdfAgreesWithPayPage(prog.id, "progress");
    expect(progPdf.text).toContain("Previously invoiced");
    expect(progPdf.text).toContain("invoices issued, not payments received");

    // A variation accepted the real way adds to the job value.
    const v = await variation(job.id, 1, 1430, "Extra stair nosing on landing");
    await m.va.acceptVariation({ id: v.id, actor, via: "staff" });

    // A progress invoice raised in error and voided drops out.
    const wrong = await m.fi.raiseJobInvoice({ jobId: job.id, kind: "stage", amount: 100, actor });
    await m.ci.voidInvoice({ id: wrong.id, reason: "raised in error", byName: "t", actorRole: "admin" });
    // A declined variation never counts.
    const no = await variation(job.id, 2, 999, "Declined extra");
    await m.va.rejectVariation({ id: no.id, actor, via: "staff" });
    // Nor does one still waiting on the client.
    await variation(job.id, 3, 555, "Pending extra");

    const fin = await m.fi.raiseJobInvoice({ jobId: job.id, kind: "final", actor });
    expect(fin.total).toBe(6430);
    s = await m.sum.billingSummaryFor(fin);
    expect(s.state).toBe("shown");
    if (s.state !== "shown") return;
    expect(s.contract).toBe(11430);
    expect(s.previous).toBe(5000);
    expect(s.remaining).toBe(0);
    expect(s.lines.some((l) => l.label.includes(wrong.number))).toBe(false);
    expect(s.lines.some((l) => l.label.includes("Declined extra"))).toBe(false);
    expect(s.lines.some((l) => l.label.includes("Pending extra"))).toBe(false);
    expect(s.remaining).toBe((await m.fi.billingOnJob(job.id)).toBill);
    const finPdf = await pdfAgreesWithPayPage(fin.id, "final");
    expect(finPdf.text).toContain("Approved variation");
    expect(finPdf.text).toContain("Quote and approved variations");
    expect(finPdf.owing).toBe(6430);
  });

  test("a variation put in without accepting it (the $1,430 on the test job) is caught, not printed", async () => {
    const { job, quote } = await jobWithQuote(28955.15);
    const dep = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 50% on quote", total: 14477.58, createdByName: "t", actorRole: "system" });
    // What the scratch data did: approved rows written straight in, job value never moved.
    await q("insert into variations (job_id, ref, seq, description, status, subtotal, gst, total, amount, approved_at, created_at, updated_at) values (?, 'V-x-01', 1, 'a', 'approved', 500, 50, 550, 550, 0, 0, 0)", [job.id]);
    await q("insert into variations (job_id, ref, seq, description, status, subtotal, gst, total, amount, approved_at, created_at, updated_at) values (?, 'V-x-02', 2, 'b', 'approved', 800, 80, 880, 880, 0, 0, 0)", [job.id]);
    const s = await m.sum.billingSummaryFor(dep);
    expect(s.state).toBe("withheld");
    if (s.state === "withheld") {
      expect(s.reason).toContain("$28,955.15");
      expect(s.reason).toContain("$30,385.15");
    }
  });

  test("a credit, an overbilled job and an earlier quote version are withheld. A draft does not count", async () => {
    const a = await jobWithQuote(2000);
    const inv = await m.ci.raiseInvoice({ jobId: a.job.id, quoteId: a.quote.id, kind: "deposit", label: "Deposit", total: 1000, createdByName: "t", actorRole: "system" });
    await q("insert into invoices (number, job_number, seq, job_id, quote_id, kind, label, status, subtotal, gst, total, created_at, updated_at) values ('IQ-draft', ?, 9, ?, ?, 'stage', 'Draft', 'draft', 9090.91, 909.09, 10000, 0, 0)", [a.job.number, a.job.id, a.quote.id]);
    expect((await m.sum.billingSummaryFor(inv)).state).toBe("shown");
    await q("insert into invoices (number, job_number, seq, job_id, quote_id, kind, label, status, subtotal, gst, total, created_at, updated_at) values ('IQ-credit', ?, 8, ?, ?, 'other', 'Credit', 'sent', -90.91, -9.09, -100, 0, 0)", [a.job.number, a.job.id, a.quote.id]);
    const credit = await m.sum.billingSummaryFor(inv);
    expect(credit.state).toBe("withheld");
    if (credit.state === "withheld") expect(credit.reason).toContain("credit");

    const b = await jobWithQuote(2000);
    const b1 = await m.ci.raiseInvoice({ jobId: b.job.id, quoteId: b.quote.id, kind: "deposit", label: "Deposit", total: 1500, createdByName: "t", actorRole: "system" });
    const b2 = await m.ci.raiseInvoice({ jobId: b.job.id, quoteId: b.quote.id, kind: "final", label: "Final", total: 1500, createdByName: "t", actorRole: "system" });
    const over = await m.sum.billingSummaryFor(b2);
    expect(over.state).toBe("withheld");
    if (over.state === "withheld") expect(over.reason).toContain("$1,000.00 more than");
    expect((await m.sum.billingSummaryFor(b1)).state).toBe("withheld");

    const c = await jobWithQuote(2000);
    const c1 = await m.ci.raiseInvoice({ jobId: c.job.id, quoteId: c.quote.id, kind: "deposit", label: "Deposit", total: 1000, createdByName: "t", actorRole: "system" });
    await q("update quotes set status = 'replaced' where id = ?", [c.quote.id]);
    await q("insert into quotes (number, version, job_id, status, subtotal, gst, total, created_at, updated_at) values (?, 2, ?, 'accepted', 1818.18, 181.82, 2000, 0, 0)", [c.job.number, c.job.id]);
    const old = await m.sum.billingSummaryFor(c1);
    expect(old.state).toBe("withheld");
  });

  test("one invoice for the whole quote: no summary, the quote total says it", async () => {
    const { job, quote } = await jobWithQuote(5000);
    const inv = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "final", label: "Final", total: 5000, createdByName: "t", actorRole: "system" });
    expect((await m.sum.billingSummaryFor(inv)).state).toBe("hidden");
    const { text } = await pdfAgreesWithPayPage(inv.id, "single");
    expect(text).not.toContain("BILLING SUMMARY");
    expect(text).toContain("WORKS AS QUOTED");
  });
});

describe("sending", () => {
  test("a withheld summary: the invoice still goes, without it, and the office gets one task", async () => {
    const { job, quote } = await jobWithQuote(2000);
    const inv = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit", total: 1000, createdByName: "t", actorRole: "system" });
    await q("update jobs set value = 2500 where id = ?", [job.id]);
    const out = await m.mail.sendInvoiceEmail({ invoiceId: inv.id, byName: "t", actorRole: "office" });
    expect(out.summaryWithheld).toContain("$2,500.00");
    const text = textOf(outbox[outbox.length - 1]!.files[0]!.content, "withheld");
    expect(text).not.toContain("BILLING SUMMARY");
    expect(amountDueIn(text)).toBe(1000);
    const tasks = await q("select title, detail from office_tasks where job_id = ?", [job.id]);
    expect(tasks.length).toBe(1);
    expect(tasks[0].title).toBe(`Check the billing on ${inv.number}`);
    const logs = await q("select action from activity_log where entity_type = 'invoice' and entity_id = ? and action = 'invoice_summary_withheld'", [inv.id]);
    expect(logs.length).toBe(1);
    // Sending again does not make a second task.
    await m.mail.sendInvoiceEmail({ invoiceId: inv.id, byName: "t", actorRole: "office" });
    expect((await q("select id from office_tasks where job_id = ?", [job.id])).length).toBe(1);
  });

  test("a re-send is the invoice as first issued, with only its own payments moved", async () => {
    const { job, quote } = await jobWithQuote(6000, "Original wording for the living room.");
    const dep = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 50% on quote", total: 3000, createdByName: "t", actorRole: "system" });
    await m.mail.sendInvoiceEmail({ invoiceId: dep.id, byName: "t", actorRole: "office" });
    const first = textOf(outbox[outbox.length - 1]!.files[0]!.content, "first");
    expect((await invoiceRow(dep.id)).issued_snapshot).toBeTruthy();
    expect(first).toContain("Original wording for the living room.");

    // Afterwards: the accepted quote's wording is revised, a variation is approved, a part payment comes in.
    await q("update quote_bundles set wording = 'Revised wording after the invoice went.' where quote_id = ?", [quote.id]);
    const v = await variation(job.id, 1, 1100, "Extra after issue");
    await m.va.acceptVariation({ id: v.id, actor, via: "staff" });
    await m.ci.markInvoicePaid({ id: dep.id, amount: 1000, method: "bank", byName: "t", actorRole: "office" });
    // Drawn fresh today, the invoice would now carry the revised wording and the new variation.
    const { bundlesFor } = await import("../src/api/routes/quoteBundles");
    expect((await bundlesFor(quote)).bundles.map((b) => b.wording)).toEqual(["Revised wording after the invoice went."]);
    const today = await m.sum.billingSummaryFor(await fullInvoice(dep.id));
    expect(today.state === "shown" && today.lines.some((l) => l.label.includes("Extra after issue"))).toBe(true);

    const out = await m.mail.sendInvoiceEmail({ invoiceId: dep.id, byName: "t", actorRole: "office" });
    const again = textOf(outbox[outbox.length - 1]!.files[0]!.content, "again");
    expect(again).toContain("Original wording for the living room.");
    expect(again).not.toContain("Revised wording");
    expect(again).not.toContain("Extra after issue");
    expect(again).toContain("Paid on this invoice");
    expect(amountDueIn(again)).toBe(2000);
    expect(amountDueIn(again)).toBe((await m.pay.payState(await fullInvoice(dep.id))).owing);
    expect(out.summaryWithheld).toBeNull();
    const log = await q("select detail from activity_log where entity_id = ? and action = 'invoice_emailed' order by id", [dep.id]);
    expect(log.length).toBe(2);
    expect(log[1].detail).toContain("as first issued on");
  });

  test("an invoice emailed before saved copies existed re-sends as it first went: one line, no works, no summary", async () => {
    const { job, quote } = await jobWithQuote(4000);
    const inv = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit 50% on quote", total: 2000, createdByName: "t", actorRole: "system" });
    // Emailed by the build before this one, which kept no copy. The job value is also off, so a fresh draw would be withheld.
    await q("insert into activity_log (job_id, entity_type, entity_id, action, detail, actor_name, actor_role, created_at) values (?, 'invoice', ?, 'invoice_emailed', 'old send', 't', 'office', 1790000000)", [job.id, inv.id]);
    await q("update jobs set value = 4500 where id = ?", [job.id]);
    const out = await m.mail.sendInvoiceEmail({ invoiceId: inv.id, byName: "t", actorRole: "office" });
    const text = textOf(outbox[outbox.length - 1]!.files[0]!.content, "legacy");
    expect(text).not.toContain("WORKS AS QUOTED");
    expect(text).not.toContain("BILLING SUMMARY");
    expect(text).toContain("Deposit 50% on quote");
    expect(amountDueIn(text)).toBe(2000);
    expect(out.summaryWithheld).toBeNull();
    expect((await q("select id from office_tasks where job_id = ?", [job.id])).length).toBe(0);
    const snap = JSON.parse((await invoiceRow(inv.id)).issued_snapshot);
    expect(snap.legacy).toBe(true);
    expect(snap.issuedAt.slice(0, 10)).toBe("2026-09-21");
    const log = await q("select detail from activity_log where entity_id = ? and action = 'invoice_emailed' order by id", [inv.id]);
    expect(log[1].detail).toContain("as first issued on 2026-09-21");
  });

  test("a saved copy that will not read stops the re-send rather than redraw from today", async () => {
    const { job, quote } = await jobWithQuote(1000);
    const inv = await m.ci.raiseInvoice({ jobId: job.id, quoteId: quote.id, kind: "deposit", label: "Deposit", total: 500, createdByName: "t", actorRole: "system" });
    await q("update invoices set issued_snapshot = '{broken' where id = ?", [inv.id]);
    const sent = outbox.length;
    await expect(m.mail.sendInvoiceEmail({ invoiceId: inv.id, byName: "t", actorRole: "office" })).rejects.toThrow("cannot be read");
    expect(outbox.length).toBe(sent);
  });
});
