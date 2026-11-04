/**
 * Warehouse stock, Step A tests. Throwaway database, nothing leaves the machine.
 * Run from packages/web:  bun test scripts/stock
 *
 * Tests run in file order and share one database. Switches go on before any
 * test job or sale is made, because an order accepted before the switch went
 * on has to be brought into the workflow by an Admin.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  accept,
  alertsFor,
  costsOf,
  depositInvoice,
  holdsOf,
  invoice,
  item,
  job,
  m,
  makePeople,
  outside,
  paymentsOf,
  pdfText,
  people,
  product,
  rk,
  sale,
  schema,
  setup,
  sql,
  stripeEvent,
  supplier,
  teardown,
} from "./harness";
import { registerA2 } from "./a2.cases";
import { registerA2b } from "./a2b.cases";
import { registerA2c } from "./a2c.cases";

beforeAll(async () => {
  await setup();
  await makePeople();
});
afterAll(() => teardown());

const no = async (p: Promise<unknown>, text: string) => {
  await expect(p).rejects.toThrow(text);
};
const eq = (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => m().drizzle.eq(...a);

async function orderOf(jobId: number) {
  return (await m().orders.orderOfJob(jobId))!;
}
async function depOf(jobId: number) {
  return m().orders.depositState(await orderOf(jobId));
}
async function holdRow(id: number) {
  return m().holds.holdById(id);
}
async function itemRow(id: number) {
  return m().items.itemById(id);
}
async function material(jobId: number, productId: number, qty: number, unit = "m2", description = "Carpet") {
  const [row] = await m().db.insert(schema.jobMaterials).values({ jobId, productId, description, qty, unit, status: "to_order" }).returning();
  return row!;
}
let poNo = 0;
async function po(jobId: number, supplierId: number, status: string, lines: { jobMaterialId?: number | null; productId: number; qty: number; unit: string; unitCost: number }[], kind = "job") {
  const total = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
  const [row] = await m()
    .db.insert(schema.purchaseOrders)
    .values({ number: `PO-T${++poNo}`, jobId, supplierId, status, kind, totalExGst: total, goodsExGst: total })
    .returning();
  const made = [];
  for (const l of lines) {
    const [ln] = await m()
      .db.insert(schema.purchaseOrderLines)
      .values({
        poId: row!.id,
        jobMaterialId: l.jobMaterialId ?? null,
        productId: l.productId,
        kind: "goods",
        description: "Goods",
        qty: l.qty,
        unit: l.unit,
        unitCostExGst: l.unitCost,
        totalExGst: l.qty * l.unitCost,
      })
      .returning();
    made.push(ln!);
  }
  return { po: row!, lines: made };
}
/** The results table in the report reads these. */
const facts: Record<string, unknown> = {};

/* ================================ switches ================================ */

describe("switches and the card check", () => {
  test("S3 refused while S1 and S2 are off", async () => {
    const { core } = m();
    await no(core.setSwitch("s3", "on", people.main), "S3 Stock-backed sales needs S1 Stock register and S2 Deposit safeguards on first.");
  });
  test("only an Admin changes switches", async () => {
    await no(m().core.setSwitch("s1", "on", people.office), "Only an Admin can change the stock switches.");
  });
  test("S1 and S2 on; S3 still refused without the live card check", async () => {
    const { core } = m();
    await core.setSwitch("s1", "on", people.main);
    await core.setSwitch("s2", "on", people.main);
    await no(core.setSwitch("s3", "on", people.main), "S3 Stock-backed sales needs the live card check (step F) recorded first.");
    expect((await core.switches()).s3.state).toBe("off");
  });
  test("S4 and S5 on. S1 cannot go off under them", async () => {
    const { core } = m();
    await core.setSwitch("s4", "on", people.main);
    await core.setSwitch("s5", "on", people.main);
    await no(core.setSwitch("s1", "off", people.main), "Turn S2 Deposit safeguards and S4 Installation jobs and S5 Returns and leftovers off first.");
    expect((await core.switches()).s4.since).toBeTruthy();
  });
  test("only the main admin records the card check", async () => {
    await no(m().core.setCardCheck(true, "test", people.admin2), "Only the main admin can record the live card check.");
    expect((await m().core.cardCheck()).done).toBe(false);
  });
});

/* =============================== permissions ============================== */

describe("11.4 access and permissions", () => {
  test("ticks: who can do what", async () => {
    const { core } = m();
    await core.setStockPermission(people.office.profileId!, { handle: true, allocate: true }, people.main);
    const p = async (k: keyof typeof people) => core.stockPerms(people[k]);
    expect(await p("main")).toMatchObject({ handle: true, allocate: true, viewCosts: true, changeCosts: true, confirm: true });
    expect(await p("admin2")).toMatchObject({ allocate: true, viewCosts: true, changeCosts: false, confirm: true });
    expect(await p("office")).toMatchObject({ handle: true, allocate: true, viewCosts: false, changeCosts: false, confirm: false });
    expect(await p("officeCosts")).toMatchObject({ allocate: false, viewCosts: true, changeCosts: false });
    expect(await p("officeNoTick")).toMatchObject({ handle: false, allocate: false, viewCosts: false });
    expect(await p("field")).toMatchObject({ handle: false, allocate: false, viewCosts: false, changeCosts: false });
  });
  test("granting rules", async () => {
    const { core } = m();
    await no(core.setStockPermission(people.field.profileId!, { allocate: true }, people.main), "Allocate and hold is for Office and Admin logins.");
    await no(core.setStockPermission(people.admin2.profileId!, { changeCosts: true }, people.admin2), "Only the main admin can grant Change stock costs.");
    await no(core.setStockPermission(people.officeCosts.profileId!, { changeCosts: true }, people.main), "Change stock costs is for Admin logins only.");
    await no(core.setStockPermission(people.office.profileId!, { handle: true }, people.office), "Only an Admin can change stock permissions.");
  });
  test("Office with View costs cannot change a cost; the main admin can", async () => {
    const p = await product({ category: "carpet" });
    const it = await item(p.id, { qty: 10 });
    await no(m().items.setItemCost(it.id, { unitCost: 12, costStatus: "final", note: "x" }, people.officeCosts), 'You need "Change stock costs (Admin, separate tick)" for this.');
    await no(m().items.setItemCost(it.id, { unitCost: 12, costStatus: "final", note: "x" }, people.admin2), 'You need "Change stock costs (Admin, separate tick)" for this.');
    const after = await m().items.setItemCost(it.id, { unitCost: 12, costStatus: "final", note: "supplier price" }, people.main);
    expect(after.unitCost).toBe(12);
    const mv = await m().items.movementsOf(it.id);
    expect(mv.some((x) => x.kind === "cost_adjust" && x.note.includes("$10.00 to $12.00"))).toBe(true);
  });
  test("Office without the tick cannot allocate; Field cannot handle", async () => {
    const p = await product({ category: "carpet" });
    const it = await item(p.id, { qty: 10 });
    const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
    await no(m().holds.allocate({ jobId: jb.id, itemId: it.id, orderedQty: 2, lineUnit: "lm", requestKey: rk() }, people.officeNoTick), 'You need "Allocate and hold" for this.');
    await no(m().holds.allocate({ jobId: jb.id, itemId: it.id, orderedQty: 2, lineUnit: "lm", requestKey: rk() }, people.field), 'You need "Allocate and hold" for this.');
    await no(m().items.openBox(it.id, 1, rk(), people.field), 'You need "Handle stock" for this.');
  });
  test("a stock cost is never $0", async () => {
    const p = await product({ category: "carpet" });
    await no(item(p.id, { qty: 5, unitCost: 0 }), "A stock cost is never $0");
    const unknown = await item(p.id, { qty: 5, unitCost: null });
    expect(unknown.costStatus).toBe("unknown");
  });
});

/* ===================== clarification 4, S4 before card check ============== */

describe("clarification 4: S4 card payment before the live card check", () => {
  test("webhook only, customer never returns: recorded, not firm, Admin confirm makes it firm", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("awaiting");
    const dep = await depositInvoice(jb.id, quote!.id, 300);
    const ev = stripeEvent(dep.id, 300);
    const res = await m().stripe.handleWebhook(ev.body, ev.header);
    expect(res.status).toBe(200);
    expect((res.body as { result?: string }).result).toBe("paid");
    // The payment stands. Stock does not treat it as confirmed yet.
    expect((await invoice(dep.id)).status).toBe("paid");
    const d = await depOf(jb.id);
    expect(d.code).toBe("awaiting_confirm");
    expect(d.label).toBe("Payment recorded — awaiting admin confirmation");
    expect(d.payments[0]!.why).toContain("live card check is not recorded yet");
    expect((await holdRow(a.hold.id)).status).toBe("awaiting");
    expect(await m().holds.availableOn(roll.id)).toBe(20);
    // The 10 minute check does not change that.
    await m().recheck.recheckAll();
    expect((await holdRow(a.hold.id)).status).toBe("awaiting");
    // Admin confirms the recorded payment. No new payment.
    const pay = (await paymentsOf(dep.id))[0]!;
    await no(m().orders.confirmForStock(pay.id, "x", people.office), "Only an Admin can confirm a payment for stock.");
    const c = await m().orders.confirmForStock(pay.id, "Stripe dashboard checked", people.main);
    expect(c.reused).toBe(false);
    expect((await m().orders.confirmForStock(pay.id, "again", people.main)).reused).toBe(true);
    await m().recheck.recheckAfterPayment(dep.id);
    const h = await holdRow(a.hold.id);
    expect(h.status).toBe("reserved");
    expect(await m().holds.availableOn(roll.id)).toBe(14);
    expect((await paymentsOf(dep.id)).length).toBe(1);
    const al = await alertsFor((await orderOf(jb.id)).id);
    expect(al.map((x) => x.key)).toContain(`reserved:${(await orderOf(jb.id)).id}`);
    expect(al.find((x) => x.kind === "stock_reserved")!.body).toContain("$300.00 confirmed for stock");
    facts.s4BeforeCardCheck = { before: d.code, after: h.status, confirmedBy: h.confirmedByName };
  });

  test("record the card check (main admin, test copy note), then S3 on", async () => {
    const { core } = m();
    await core.setCardCheck(true, "Test copy only. Fake Stripe webhook, not a live card check.", people.main);
    await core.setSwitch("s3", "on", people.main);
    expect((await core.switches()).s3.state).toBe("on");
    await no(core.setCardCheck(false, "undo", people.main), "Turn S3 off first. Stock-backed sales need the live card check.");
  });

  test("S4 after the card check: webhook only makes it firm, nothing else pressed", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 2000, percent: 20, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 8, lineUnit: "lm", requestKey: rk() }, people.office);
    const dep = await depositInvoice(jb.id, quote!.id, 400);
    const ev = stripeEvent(dep.id, 400);
    await m().stripe.handleWebhook(ev.body, ev.header);
    const h = await holdRow(a.hold.id);
    expect(h.status).toBe("reserved");
    expect(h.confirmedByName).toBe("Card deposit");
    // The same Stripe event again (Stripe retries): counted once.
    const again = await m().stripe.handleWebhook(ev.body, ev.header);
    expect((again.body as { result?: string }).result).toBe("already_counted");
    expect((await paymentsOf(dep.id)).length).toBe(1);
    const o = await orderOf(jb.id);
    expect((await alertsFor(o.id)).filter((x) => x.key === `reserved:${o.id}`).length).toBe(1);
    facts.s4AfterCardCheck = h.status;
  });
});

/* ============ clarification 3: $1,000 direct invoice, $300 bank recorded ============ */

async function saleWithStock(percent: number, orderedLm = 6) {
  const p = await product({ category: "carpet" });
  const roll = await item(p.id, { qty: 20 });
  const s = await sale({ mode: "invoice", total: 1000, percent });
  const a = await m().holds.allocate({ jobId: s.job.id, itemId: roll.id, orderedQty: orderedLm, lineUnit: "lm", requestKey: rk() }, people.office);
  return { ...s, roll, hold: a.hold, invoice: s.invoice! };
}

describe("clarification 3: direct invoice, bank payment recorded but not confirmed", () => {
  test("$700 outstanding, stock awaiting confirmation, pay page does not ask for the $300 again", async () => {
    const s = await saleWithStock(30);
    const o = await orderOf(s.job.id);
    expect(o.kind).toBe("sale_invoice");
    expect(o.status).toBe("active");
    expect(o.requiredDeposit).toBe(300);
    expect(s.hold.status).toBe("awaiting");
    const paid = await m().ci.markInvoicePaid({ id: s.invoice.id, amount: 300, method: "bank", byName: people.office.name, actorRole: "office" });
    const inv = await invoice(s.invoice.id);
    expect(inv.total - inv.amountPaid).toBe(700);
    expect(inv.status).toBe("part_paid");
    const d = await depOf(s.job.id);
    expect(d.code).toBe("awaiting_confirm");
    expect(d.label).toBe("Payment recorded — awaiting admin confirmation");
    expect(d.stillToPay).toBe(0);
    expect((await holdRow(s.hold.id)).status).toBe("awaiting");
    const info = await m().pay.stockPayInfo(inv.id, 700);
    expect(info).toEqual({ stockLabel: "Payment recorded — awaiting admin confirmation", notice: null, blocked: false, depositOption: null, depositLine: null });
    const page = await m().publicPages.payState(inv);
    expect(page.stockLabel).toBe("Payment recorded — awaiting admin confirmation");
    expect(page.depositOption).toBeNull();
    expect(page.owing).toBe(700);
    // Admin confirms the recorded payment. The stock goes firm with no new payment.
    await m().orders.confirmForStock(paid.paymentId!, "Bank statement checked", people.main);
    await m().recheck.recheckAfterPayment(inv.id);
    const h = await holdRow(s.hold.id);
    expect(h.status).toBe("reserved");
    expect(h.confirmedByName).toBe("Deposit confirmed");
    expect((await paymentsOf(inv.id)).length).toBe(1);
    expect((await invoice(inv.id)).amountPaid).toBe(300);
    expect((await m().publicPages.payState(await invoice(inv.id))).stockLabel).toBeNull();
    facts.clar3 = { owing: 700, before: d.code, after: h.status, payments: 1 };
  });

  test("S3 card deposit by webhook only (card check done): firm, nothing else pressed", async () => {
    const s = await saleWithStock(30);
    const ev = stripeEvent(s.invoice.id, 300);
    const res = await m().stripe.handleWebhook(ev.body, ev.header);
    expect((res.body as { result?: string }).result).toBe("part_paid");
    const h = await holdRow(s.hold.id);
    expect(h.status).toBe("reserved");
    expect(h.confirmedByName).toBe("Card deposit");
    expect(await m().holds.availableOn(s.roll.id)).toBe(14);
    facts.s3Card = h.status;
  });
});

/* ========================= deposit line wording (open item 5) ========================= */

describe("deposit line on the pay page, PDF and email", () => {
  // A2c approved wording, real amounts with cents.
  const LINE = "Required deposit: $300.00 (30% of the invoice total). Balance after deposit: $700.00.";
  test("before any payment: $300 (30%), balance $700, on all three", async () => {
    const s = await saleWithStock(30);
    const inv = await invoice(s.invoice.id);
    const page = await m().publicPages.payState(inv);
    expect(page.depositOption).toEqual({ amount: 300, percent: 30, balance: 700 });
    expect(page.stockLabel).toBe("Stock is held for you once the deposit is paid.");
    const line = await m().pdf.stockDepositLine(inv.id, 1000);
    expect(line).toBe(LINE);
    const { pdf } = await m().pdf.clientInvoicePdfFor(inv.id);
    const text = pdfText(pdf, "deposit-line").replace(/\s+/g, " ");
    expect(text).toContain(LINE);
    const body = m().mail.invoiceEmailBody({ first: "Pat", ref: inv.number, label: "Products supplied", owing: 1000, url: "https://pay.example.invalid/x", depositLine: line });
    expect(body).toContain(LINE);
    facts.depositLine = { page: page.depositOption, pdf: LINE, email: LINE, emailBody: body };
    // $100 confirmed: the button asks for $200, never the full $300 again.
    const paid = await m().ci.markInvoicePaid({ id: inv.id, amount: 100, method: "bank", byName: people.office.name, actorRole: "office" });
    await m().orders.confirmForStock(paid.paymentId!, "checked", people.main);
    await m().recheck.recheckAfterPayment(inv.id);
    const after = await m().publicPages.payState(await invoice(inv.id));
    expect(after.depositOption).toEqual({ amount: 200, percent: 30, balance: 700 });
    expect(await m().pdf.stockDepositLine(inv.id, 900)).toBe("Required deposit: $300.00 (30% of the invoice total). Paid so far: $100.00. Deposit still to pay: $200.00. Balance after deposit: $700.00.");
  });
  test("an invoice with no stock keeps today's pay page and email", async () => {
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const dep = await depositInvoice(jb.id, quote!.id, 300);
    const page = await m().publicPages.payState(dep);
    expect(page.stockLabel).toBeNull();
    expect(page.depositOption).toBeNull();
    expect(await m().pdf.stockDepositLine(dep.id, 300)).toBeNull();
    const body = m().mail.invoiceEmailBody({ first: "Pat", ref: dep.number, label: "Deposit", owing: 300, url: null, depositLine: null });
    expect(body).not.toContain("Required deposit");
  });
});

/* ===================== clarification 1: several holds on one roll ===================== */

describe("clarification 1: several holds on one roll", () => {
  test("25 m roll, A holds 5 m and B holds 7 m: 13 m available, never over-held", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 25 });
    const A = await job({ quoteTotal: 500, percent: 0, accepted: true });
    const B = await job({ quoteTotal: 700, percent: 0, accepted: true });
    const C = await job({ quoteTotal: 900, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: A.job.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    const b = await m().holds.allocate({ jobId: B.job.id, itemId: roll.id, orderedQty: 7, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("reserved");
    expect(b.hold.status).toBe("reserved");
    expect(await m().holds.availableOn(roll.id)).toBe(13);
    // A temporary hold blocks, so it cannot take more than is free.
    await no(m().holds.allocate({ jobId: C.job.id, itemId: roll.id, orderedQty: 14, lineUnit: "lm", temporary: true, requestKey: rk() }, people.office), `Only 13 m free on ${roll.code}.`);
    // An awaiting hold does not block: it is saved with a warning and holds nothing.
    const c = await m().holds.allocate({ jobId: C.job.id, itemId: roll.id, orderedQty: 14, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(c.hold.status).toBe("awaiting");
    expect(c.warning).toContain("Only 13 m free");
    expect(await m().holds.availableOn(roll.id)).toBe(13);
    // When C's deposit is confirmed, only what is free goes firm. The rest is short, never shown as reserved.
    const dep = await depositInvoice(C.job.id, C.quote!.id, 270);
    const ev = stripeEvent(dep.id, 270);
    await m().stripe.handleWebhook(ev.body, ev.header);
    const cHolds = (await holdsOf(C.job.id)).filter((h) => h.status !== "released" && h.status !== "cancelled");
    const firm = cHolds.filter((h) => h.status === "reserved");
    const short = cHolds.filter((h) => h.status === "short");
    expect(firm.reduce((s, h) => s + h.qty, 0)).toBe(13);
    expect(short.reduce((s, h) => s + h.qty, 0)).toBe(1);
    expect(await m().holds.availableOn(roll.id)).toBe(0);
    const blocking = (await m().holds.holdsOnItem(roll.id)).filter((h) => ["temporary", "reserved", "cut", "picked"].includes(h.status));
    expect(blocking.reduce((s, h) => s + h.qty, 0)).toBeLessThanOrEqual(25);
    expect(m().recheck.reserveStatus(cHolds)).toBe("Partially reserved: 1 m outstanding");
    facts.clar1 = { available: 13, cFirm: 13, cShort: 1 };
  });
});

/* ===================== clarification 2: recovery from facts ===================== */

describe("clarification 2: recovery from facts", () => {
  test("a payment saved with nothing else updated is found by the next check", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
    const dep = await depositInvoice(jb.id, quote!.id, 300);
    // Straight into the payments table: no hook, no recheck, as if the process stopped after the save.
    await m().db.insert(schema.invoicePayments).values({ invoiceId: dep.id, amount: 300, method: "card", source: "stripe", paidOn: new Date(), byName: "Stripe" });
    expect((await holdRow(a.hold.id)).status).toBe("awaiting");
    await m().recheck.recheckAll();
    expect((await holdRow(a.hold.id)).status).toBe("reserved");
    // Fulfilled quantity is never held again.
    await m().holds.takeOut(a.hold.id, 2, rk(), people.office);
    await m().recheck.recheckAll();
    await m().recheck.recheckAll();
    let hs = await holdsOf(jb.id);
    expect(hs.length).toBe(1);
    expect(hs[0]!.collectedQty).toBe(2);
    await m().holds.takeOut(a.hold.id, 4, rk(), people.office);
    await m().recheck.recheckAll();
    hs = await holdsOf(jb.id);
    expect(hs.length).toBe(1);
    expect(hs[0]!.status).toBe("issued");
    expect((await itemRow(roll.id)).qty).toBe(14);
    facts.clar2Payment = "found by check";
    // Cancelled with money in: review, never released, never re-held.
    const [st] = await m().db.insert(schema.jobStatuses).values({ name: "Cancelled", stage: "closed" }).returning();
    await m().db.update(schema.jobs).set({ statusId: st!.id }).where(eq(schema.jobs.id, jb.id));
    await m().recheck.recheckAll();
    const o = await orderOf(jb.id);
    expect(o.status).toBe("review");
    expect((await alertsFor(o.id)).some((x) => x.key === `review:${o.id}`)).toBe(true);
    const r = await m().recheck.recheckOrder(o.id);
    expect(r.skipped).toBe("review");
    await no(m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 1, lineUnit: "lm", requestKey: rk() }, people.office), "This order is cancelled or under review.");
    facts.cancelledStatusId = st!.id;
  });

  test("a 0% order accepted with no payment is recovered by the check", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 800, percent: 0, accepted: false });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("planned");
    // Accepted, but the stock step never ran.
    await accept(quote!.id);
    expect((await orderOf(jb.id)).status).toBe("planned");
    await m().recheck.recheckAll();
    expect((await orderOf(jb.id)).status).toBe("active");
    expect((await depOf(jb.id)).code).toBe("confirmed");
    expect((await holdRow(a.hold.id)).status).toBe("reserved");
    facts.clar2Zero = "reserved";
  });

  test("cancelled with no money: waiting holds are let go", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", temporary: true, requestKey: rk() }, people.office);
    expect(await m().holds.availableOn(roll.id)).toBe(15);
    await m().db.update(schema.jobs).set({ statusId: facts.cancelledStatusId as number }).where(eq(schema.jobs.id, jb.id));
    await m().recheck.recheckAll();
    expect((await orderOf(jb.id)).status).toBe("cancelled");
    expect((await holdRow(a.hold.id)).status).toBe("released");
    expect(await m().holds.availableOn(roll.id)).toBe(20);
  });

  test("contra and the deposit-paid tick never reserve stock", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    const dep = await depositInvoice(jb.id, quote!.id, 300);
    const paid = await m().ci.markInvoicePaid({ id: dep.id, amount: 300, method: "contra", byName: people.office.name, actorRole: "office" });
    const [j] = await m().db.select().from(schema.jobs).where(eq(schema.jobs.id, jb.id));
    expect(j!.depositPaid).toBe(true);
    await m().recheck.recheckAll();
    expect((await holdRow(a.hold.id)).status).toBe("awaiting");
    const d = await depOf(jb.id);
    expect(d.code).toBe("awaiting");
    expect(d.payments[0]!.why).toBe("Contra never counts for stock.");
    await no(m().orders.confirmForStock(paid.paymentId!, "x", people.main), "Contra never counts for stock.");
  });
});

/* ========================= A1.1 job costing from stock ========================= */

/** 100 m² quoted at $20/m² from one supplier. A 4 m wide roll at $9/m² in stock. */
async function costingJob() {
  const sup = await supplier("A11 Supplier");
  const p = await product({ supplierId: sup.id, category: "carpet" });
  const roll = await item(p.id, { qty: 30, costPer: "m2", unitCost: 9 });
  const made = await job({ quoteTotal: 5000, percent: 0, accepted: true, items: [{ productId: p.id, description: "Carpet", qty: 100, unit: "m2", unitCost: 20 }] });
  const mat = await material(made.job.id, p.id, 100);
  await m().expected.syncExpectedCosts(made.job.id, made.quote!.id);
  return { sup, p, roll, mat, ...made, qi: made.quoteItems[0]! };
}
const total = (jobId: number) => m().costs.jobMaterialTotal(jobId);
async function poFromHelper(jobId: number, unitCost: number) {
  const res = await m().poHelper.draftPosForJob({ jobId, quoteRef: "Q-test" });
  expect(res.drafted.length).toBe(1);
  const poId = res.drafted[0]!.poId;
  const lines = await m().db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  const goods = lines.filter((l) => l.kind === "goods");
  // Only the 40 m² not coming from stock is ordered.
  expect(goods.length).toBe(1);
  expect(goods[0]!.qty).toBe(40);
  // Test copy: price the draft by hand so the sums are easy to read. Charges and freight cleared.
  for (const l of lines) if (l.kind !== "goods") await m().db.delete(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, l.id));
  await m().db.update(schema.purchaseOrderLines).set({ unitCostExGst: unitCost, totalExGst: unitCost * 40 }).where(eq(schema.purchaseOrderLines.id, goods[0]!.id));
  await m().db.update(schema.purchaseOrders).set({ goodsExGst: unitCost * 40, chargesExGst: 0, freightExGst: 0, totalExGst: unitCost * 40 }).where(eq(schema.purchaseOrders.id, poId));
  const [row] = await m().db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  return { po: row!, line: goods[0]! };
}
async function supplierInvoice(poId: number, supplierId: number, exGst: number) {
  await m().db.insert(schema.supplierInvoices).values({ supplierId, invoiceNumber: `SI-${poId}-${exGst}`, dedupeKey: `${supplierId}|si${poId}${exGst}`, poId, totalExGst: exGst, gst: exGst / 10, totalIncGst: exGst * 1.1 });
  await m().match.settlePo(poId);
}

describe("A1.1 job costing: stock plus PO", () => {
  test("60 m² from stock, 40 m² on a PO: $540 + $800 = $1,340 at every step", async () => {
    const c = await costingJob();
    expect(await total(c.job.id)).toBe(2000);
    const a = await m().holds.allocate({ jobId: c.job.id, itemId: c.roll.id, orderedQty: 60, lineUnit: "m2", quoteItemId: c.qi.id, jobMaterialId: c.mat.id, requestKey: rk() }, people.office);
    expect(a.hold.qty).toBe(15);
    const rows = await costsOf(c.job.id);
    const stock = rows.find((r) => r.source === "stock")!;
    const exp = rows.find((r) => r.source !== "stock" && r.kind === "materials")!;
    expect(stock.amount).toBe(540);
    expect(stock.state).toBe("paid");
    expect(stock.stockRef).toBe(`hold:${a.hold.id}`);
    expect(exp.amount).toBe(800);
    expect(exp.notes).toContain(m().expected.EXPECTED_STOCK_NOTE);
    const steps: Record<string, number> = { allocated: await total(c.job.id) };
    expect(steps.allocated).toBe(1340);
    const { po: p0 } = await poFromHelper(c.job.id, 20);
    await m().po.commitPo(p0.id, "other", null);
    const committed = (await costsOf(c.job.id)).filter((r) => r.kind === "materials" && r.source !== "stock");
    expect(committed.length).toBe(1);
    expect(committed[0]!.state).toBe("committed");
    expect(committed[0]!.amount).toBe(800);
    steps.poSent = await total(c.job.id);
    await supplierInvoice(p0.id, c.sup.id, 800);
    steps.invoiced = await total(c.job.id);
    await m().holds.takeOut(a.hold.id, 15, rk(), people.office);
    steps.issued = await total(c.job.id);
    expect(steps).toEqual({ allocated: 1340, poSent: 1340, invoiced: 1340, issued: 1340 });
    const issued = (await costsOf(c.job.id)).find((r) => r.source === "stock")!;
    expect(issued.notes).toBe("Stock issued. Actual cost.");
    facts.a11 = steps;
    // The PO was never sent anywhere: commitPo("other") only marks it, and no email went.
    // Every captured email is an office alert. None to a customer, none to a supplier, no PO.
    expect(outside.email.filter((e) => /c\d+@example\.invalid/.test(JSON.stringify(e.to))).length).toBe(0);
    expect(outside.email.filter((e) => /purchase order|\bPO\b|supplier/i.test(String(e.subject))).length).toBe(0);
    const sentAlerts = await m().db.select().from(schema.stockAlerts);
    const reservedMails = outside.email.filter((e) => /^\[Terra Ops\] Stock (partly )?reserved$/.test(String(e.subject))).length;
    expect(reservedMails).toBe(sentAlerts.filter((a) => a.key.startsWith("reserved:")).length);
  });

  test("supplier bills $820: total $1,360 with the difference noted", async () => {
    const c = await costingJob();
    await m().holds.allocate({ jobId: c.job.id, itemId: c.roll.id, orderedQty: 60, lineUnit: "m2", quoteItemId: c.qi.id, jobMaterialId: c.mat.id, requestKey: rk() }, people.office);
    const { po: p0 } = await poFromHelper(c.job.id, 20);
    await m().po.commitPo(p0.id, "other", null);
    await supplierInvoice(p0.id, c.sup.id, 820);
    expect(await total(c.job.id)).toBe(1360);
    const [si] = await m().db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.poId, p0.id));
    expect(si!.matchNote).toContain(`$20.00 ex GST more than PO ${p0.number}.`);
    facts.a11Variant = 1360;
  });

  test("stock released before the PO: back to $2,000 expected", async () => {
    const c = await costingJob();
    const a = await m().holds.allocate({ jobId: c.job.id, itemId: c.roll.id, orderedQty: 60, lineUnit: "m2", quoteItemId: c.qi.id, jobMaterialId: c.mat.id, requestKey: rk() }, people.office);
    expect(await total(c.job.id)).toBe(1340);
    await m().holds.releaseHold(a.hold.id, "customer changed colour", people.office);
    expect(await total(c.job.id)).toBe(2000);
    expect((await costsOf(c.job.id)).filter((r) => r.source === "stock").length).toBe(0);
  });

  test("everything from stock: $0 note row, no PO drafted, nothing in the cash forecast", async () => {
    const c = await costingJob();
    await m().holds.allocate({ jobId: c.job.id, itemId: c.roll.id, orderedQty: 100, lineUnit: "m2", quoteItemId: c.qi.id, jobMaterialId: c.mat.id, requestKey: rk() }, people.office);
    const rows = await costsOf(c.job.id);
    const zero = rows.find((r) => r.notes === m().expected.CHARGES_DROPPED_NOTE)!;
    expect(zero.amount).toBe(0);
    expect(rows.find((r) => r.source === "stock")!.amount).toBe(900);
    expect(await total(c.job.id)).toBe(900);
    const res = await m().poHelper.draftPosForJob({ jobId: c.job.id, quoteRef: "Q-test" });
    expect(res.drafted.length).toBe(0);
    await m().cashflow.rebuildForecast();
    const ev = await m().db.select().from(schema.cashEvents).where(eq(schema.cashEvents.costId, zero.id));
    expect(ev.length).toBe(0);
    facts.allFromStock = { total: 900, drafted: 0, cashRows: 0 };
  });
});

/* ===================== partial reserve, then the PO goods arrive ===================== */

describe("A1.6 partial reserve, receive, now fully reserved", () => {
  test("40 m² from stock, 60 m² short; goods received: Fully reserved, alerted once", async () => {
    const sup = await supplier("Recv Supplier");
    const p = await product({ supplierId: sup.id, category: "carpet" });
    const roll = await item(p.id, { qty: 10 });
    const { job: jb } = await job({ quoteTotal: 3000, percent: 0, accepted: true });
    const mat = await material(jb.id, p.id, 100);
    await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 40, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
    const s = await m().holds.allocate({ jobId: jb.id, itemId: null, productId: p.id, orderedQty: 60, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
    expect(s.hold.status).toBe("short");
    const o = await orderOf(jb.id);
    await m().recheck.recheckOrder(o.id);
    expect(m().recheck.reserveStatus(await holdsOf(jb.id))).toBe("Partially reserved: 60 m² outstanding");
    expect((await alertsFor(o.id)).find((x) => x.key === `reserved:${o.id}`)!.kind).toBe("stock_short");
    const { po: p0, lines } = await po(jb.id, sup.id, "draft", [{ jobMaterialId: mat.id, productId: p.id, qty: 60, unit: "m2", unitCost: 20 }]);
    const key = rk("recv");
    await no(m().receiving.receiveLine({ poLineId: lines[0]!.id, pieces: [{ qty: 15, widthM: 4 }], requestKey: key }, people.office), `${p0.number} has not been sent yet.`);
    await m().db.update(schema.purchaseOrders).set({ status: "sent" }).where(eq(schema.purchaseOrders.id, p0.id));
    await no(m().receiving.receiveLine({ poLineId: lines[0]!.id, pieces: [{ qty: 15 }], requestKey: key }, people.office), "Enter the width of each roll.");
    const got = await m().receiving.receiveLine({ poLineId: lines[0]!.id, pieces: [{ qty: 15, widthM: 4, labelQty: 15.5 }], requestKey: key }, people.office);
    expect(got.items.length).toBe(1);
    expect(got.shortRolls.length).toBe(1);
    const hs = await holdsOf(jb.id);
    expect(hs.find((h) => h.id === s.hold.id)!.status).toBe("released");
    const onPo = hs.find((h) => h.costOnPo)!;
    expect(onPo.status).toBe("reserved");
    expect(onPo.orderedQty).toBe(60);
    expect(m().recheck.reserveStatus(hs)).toBe("Fully reserved");
    const al = await alertsFor(o.id);
    expect(al.filter((x) => x.key === `full:${o.id}`).length).toBe(1);
    const again = await m().receiving.receiveLine({ poLineId: lines[0]!.id, pieces: [{ qty: 15, widthM: 4 }], requestKey: key }, people.office);
    expect(again.reused).toBe(true);
    await m().recheck.recheckAll();
    expect((await alertsFor(o.id)).filter((x) => x.key === `full:${o.id}`).length).toBe(1);
    const [sr] = await m().db.select().from(schema.stockAlerts).where(eq(schema.stockAlerts.key, `short-roll:${got.items[0]!.id}`));
    expect(sr!.body).toContain("label says 15.5 m, measured 15 m (0.5 m short)");
    // Goods bought on the job's PO are not free to anyone else.
    expect(await m().holds.availableOn(got.items[0]!.id)).toBe(0);
    // Leftover PO goods to general stock, Admin approval, once.
    await no(m().costs.releaseJobPoGoods(onPo.id, "left over", people.office), 'You need "');
    const rel = await m().costs.releaseJobPoGoods(onPo.id, "job used less", people.main);
    expect(rel.cost!.amount).toBe(-1200);
    expect((await m().costs.releaseJobPoGoods(onPo.id, "again", people.main)).reused).toBe(true);
    expect(await m().holds.availableOn(got.items[0]!.id)).toBe(15);
    facts.a16 = { before: "Partially reserved: 60 m² outstanding", after: "Fully reserved", fullAlerts: 1 };
    // The roll bought on this job's own PO is not an overlap with that PO.
    expect((await m().db.select().from(schema.stockAlerts)).filter((x) => x.key.startsWith(`po-overlap:${lines[0]!.id}:`)).length).toBe(0);
  });
});

describe("stock chosen after a PO was drafted or sent", () => {
  test("the PO line is flagged once, never changed", async () => {
    const sup = await supplier("Overlap Supplier");
    const p = await product({ supplierId: sup.id, category: "carpet" });
    const roll = await item(p.id, { qty: 10 });
    const { job: jb } = await job({ quoteTotal: 3000, percent: 0, accepted: true });
    const mat = await material(jb.id, p.id, 100);
    const { po: d, lines } = await po(jb.id, sup.id, "draft", [{ jobMaterialId: mat.id, productId: p.id, qty: 100, unit: "m2", unitCost: 20 }]);
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 40, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
    const draftMsg = `Draft ${d.number} still orders 100 m² of Goods. Stock now covers 40 m², so only 60 m² is still needed. Change the draft before sending it.`;
    expect(a.warning).toContain(draftMsg);
    const key = `po-overlap:${lines[0]!.id}:40`;
    const rows = async () => (await m().db.select().from(schema.stockAlerts)).filter((x) => x.key === key);
    expect((await rows()).length).toBe(1);
    expect((await rows())[0]!.kind).toBe("stock_po_overlap");
    expect((await rows())[0]!.sentAt).not.toBeNull();
    await m().recheck.recheckAll();
    expect((await rows()).length).toBe(1);
    const [line] = await m().db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, lines[0]!.id));
    expect(line!.qty).toBe(100);
    const [still] = await m().db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, d.id));
    expect(still!.status).toBe("draft");
    // Sent: still flagged, still not changed.
    await m().db.update(schema.purchaseOrders).set({ status: "sent" }).where(eq(schema.purchaseOrders.id, d.id));
    const roll2 = await item(p.id, { qty: 5 });
    const b = await m().holds.allocate({ jobId: jb.id, itemId: roll2.id, orderedQty: 20, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
    expect(b.warning).toContain(`${d.number} was sent for 100 m² of Goods. Stock now covers 60 m², so only 40 m² is still needed. The PO was not changed.`);
    const [line2] = await m().db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.id, lines[0]!.id));
    expect(line2!.qty).toBe(100);
    // No email to the supplier: only the office alert.
    expect(outside.email.filter((e) => /purchase order|supplier/i.test(String(e.subject))).length).toBe(0);
    facts.poOverlap = { draft: draftMsg, sentAlso: true, lineQtyAfter: line2!.qty };
  });
});

/* ===================== 11.1 quantities and free remainders ===================== */

describe("11.1 quantities and free remainders", () => {
  test("the rule: carpet under 2.7 m, vinyl 2 m or less", () => {
    const r = { carpetKeepMinM: 2.7, vinylFreeMaxM: 2 };
    const f = m().remainders.freeRule;
    expect(f("carpet", 10, 8, r)).toMatchObject({ offer: true, freeQty: 2 });
    expect(f("carpet", 10, 7.31, r)).toMatchObject({ offer: true, freeQty: 2.69 });
    expect(f("carpet", 10, 7.3, r)).toMatchObject({ offer: false });
    expect(f("vinyl", 10, 8, r)).toMatchObject({ offer: true, freeQty: 2 });
    expect(f("vinyl", 10, 7.99, r)).toMatchObject({ offer: false });
    expect(f("other", 10, 9, r)).toMatchObject({ offer: false });
    expect(f("carpet", 10, 10, r)).toMatchObject({ offer: false, why: "Nothing left on the roll." });
  });
  test("sale: 32 m² ordered off a 10 m roll, 4 m wide. Proposed, approved, five quantities", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 10 });
    const s = await sale({ mode: "invoice", total: 1000, percent: 0 });
    const a = await m().holds.allocate({ jobId: s.job.id, itemId: roll.id, orderedQty: 32, lineUnit: "m2", requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("reserved");
    expect(a.hold.qty).toBe(8);
    expect(a.hold.freeState).toBe("proposed");
    expect(a.hold.freeQty).toBe(2);
    expect(await m().holds.availableOn(roll.id)).toBe(2);
    await no(m().remainders.approveFree(a.hold.id, people.officeNoTick), 'You need "Allocate and hold" for this.');
    const ok = await m().remainders.approveFree(a.hold.id, people.office);
    expect(ok.qty).toBe(10);
    expect(ok.billedQty).toBe(32);
    const q = await m().remainders.quantitiesOf(a.hold.id);
    expect(q).toMatchObject({ ordered: 32, billed: 32, lineUnit: "m2", supplied: 10, free: 2, freeArea: 8 });
    expect(q.note).toBe("Additional 2 m (8 m²) supplied at no charge.");
    expect(await m().holds.availableOn(roll.id)).toBe(0);
    facts.free = q;
  });
  test("installation jobs never get the free-remainder offer", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 10 });
    const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 8, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(a.hold.freeState).toBe("none");
  });
  test("m² line on a roll with no width is refused", async () => {
    const p = await product({ category: "carpet" });
    // A new roll cannot be saved without a width. An older row with none (e.g. a bad import) is refused at allocation.
    await no(item(p.id, { qty: 10, widthM: null }), "Enter the roll width.");
    const made = await item(p.id, { qty: 10 });
    await sql("update stock_items set width_m = null where id = ?", [made.id]);
    const roll = await itemRow(made.id);
    const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
    expect(roll.widthM).toBeNull();
    await no(m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 8, lineUnit: "m2", requestKey: rk() }, people.office), `${roll.code} has no width.`);
    facts.noWidthRoll = roll.widthM;
  });
});

/* ============================== temporary holds ============================== */

describe("temporary holds: warning, extend, expiry", () => {
  test("warned once to the person who applied it and Damien; extended; then expires back to waiting", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", temporary: true, requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("temporary");
    expect(a.hold.expiresAt).toBeTruthy();
    expect(await m().holds.availableOn(roll.id)).toBe(15);
    const ends = a.hold.expiresAt!;
    const soon = new Date(ends.getTime() - 3600_000);
    await m().holds.warnHolds(soon);
    await m().holds.warnHolds(soon);
    const key = `hold-warn:${a.hold.id}:${ends.getTime()}`;
    const warns = await m().db.select().from(schema.stockAlerts).where(eq(schema.stockAlerts.key, key));
    expect(warns.length).toBe(1);
    expect(warns[0]!.body).toContain(`held by ${people.office.name}`);
    expect(warns[0]!.body).toContain("and Damien");
    await no(m().holds.extendHold(a.hold.id, "x", people.office), "Say why the hold is being extended.");
    const ext = await m().holds.extendHold(a.hold.id, "customer away until Friday", people.office);
    expect(ext.warnedAt).toBeNull();
    expect(ext.extendReason).toContain("customer away until Friday");
    expect(ext.expiresAt!.getTime()).toBeGreaterThanOrEqual(ends.getTime());
    const n = await m().holds.expireHolds(new Date(Date.now() + 49 * 3600_000));
    expect(n).toBeGreaterThanOrEqual(1);
    const h = await holdRow(a.hold.id);
    expect(h.status).toBe("awaiting");
    expect(h.releaseReason).toBe("Temporary hold expired. Stock released, quote and invoice unchanged.");
    expect(await m().holds.availableOn(roll.id)).toBe(20);
    const [q] = await m().db.select().from(schema.quotes).where(eq(schema.quotes.id, quote!.id));
    expect(q!.status).toBe("accepted");
    await no(m().holds.extendHold(a.hold.id, "too late", people.office), "Only a temporary hold can be extended.");
    facts.tempHold = { warned: 1, after: h.status };
  });
});

/* ============================ cut, take out, replace ============================ */

describe("holds: cut, take out, replace, release", () => {
  test("cutting the whole roll keeps the roll; cutting part makes a piece and shrinks the roll", async () => {
    const p = await product({ category: "carpet" });
    const whole = await item(p.id, { qty: 6 });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 900, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: whole.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
    const c1 = await m().holds.cutHold(a.hold.id, rk("cut"), people.office);
    expect(c1.hold.status).toBe("cut");
    expect(c1.hold.stockItemId).toBe(whole.id);
    const b = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    await no(m().holds.cutHold(b.hold.id, rk("cut"), people.field), 'You need "Handle stock" for this.');
    const key = rk("cut");
    const c2 = await m().holds.cutHold(b.hold.id, key, people.office);
    expect(c2.hold.status).toBe("cut");
    const piece = await itemRow(c2.hold.stockItemId!);
    expect(piece.type).toBe("cut_piece");
    expect(piece.qty).toBe(5);
    expect(piece.parentItemId).toBe(roll.id);
    expect((await itemRow(roll.id)).qty).toBe(15);
    expect((await m().holds.cutHold(b.hold.id, key, people.office)).reused).toBe(true);
    expect((await itemRow(roll.id)).qty).toBe(15);
  });
  test("awaiting stock is not cut", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    await no(m().holds.cutHold(a.hold.id, rk("cut"), people.office), "Only firm stock is cut. Wait for the deposit to be confirmed.");
  });
  test("part taken out, the same press again does nothing, the rest cannot be released", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 900, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
    const key = rk("out");
    await m().holds.takeOut(a.hold.id, 2, key, people.office);
    const again = await m().holds.takeOut(a.hold.id, 2, key, people.office);
    expect(again.reused).toBe(true);
    const h = await holdRow(a.hold.id);
    expect(h.collectedQty).toBe(2);
    expect((await itemRow(roll.id)).qty).toBe(18);
    await no(m().holds.takeOut(a.hold.id, 5, rk("out"), people.office), "Up to 4 can go out on this hold.");
    await no(m().holds.releaseHold(a.hold.id, "changed mind", people.office), "Part of it has gone out. Hand over or return the rest instead.");
  });
  test("damaged roll swapped: the new hold is firm, the old one points at it", async () => {
    const p = await product({ category: "carpet" });
    const r1 = await item(p.id, { qty: 20 });
    const r2 = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 900, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: r1.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
    const key = rk("swap");
    const s = await m().holds.replaceItem(a.hold.id, r2.id, key, people.office);
    expect(s.hold.status).toBe("reserved");
    expect(s.hold.stockItemId).toBe(r2.id);
    const old = await holdRow(a.hold.id);
    expect(old.status).toBe("released");
    expect(old.replacedById).toBe(s.hold.id);
    expect((await m().holds.replaceItem(a.hold.id, r2.id, key, people.office)).reused).toBe(true);
    expect(await m().holds.availableOn(r1.id)).toBe(20);
    expect(await m().holds.availableOn(r2.id)).toBe(14);
    const live = (await holdsOf(jb.id)).filter((h) => h.status !== "released");
    expect(live.length).toBe(1);
  });
});

/* ===================== S5 returns and leftovers from jobs ===================== */

describe("11.3 returns and leftovers", () => {
  test("unopened: back at the original cost after Admin approval, credited once", async () => {
    const p = await product({ category: "accessories", unit: "each" });
    const lot = await item(p.id, { qty: 10, unit: "each", type: "unit_lot", unitCost: 12, costPer: "unit" });
    const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: lot.id, orderedQty: 10, lineUnit: "each", requestKey: rk() }, people.office);
    await m().holds.takeOut(a.hold.id, 10, rk("out"), people.office);
    expect(await total(jb.id)).toBe(120);
    await no(m().returns.returnFromJob({ holdId: a.hold.id, kind: "unopened", qty: 11, requestKey: rk("ret") }, people.office), "Only 10 each went out on this hold.");
    const r = await m().returns.returnFromJob({ holdId: a.hold.id, kind: "unopened", qty: 4, requestKey: rk("ret") }, people.office);
    expect(r.item!.status).toBe("to_check");
    expect(await total(jb.id)).toBe(120);
    await no(m().returns.approveReturn(r.item!.id, people.office), 'You need "');
    const ok = await m().returns.approveReturn(r.item!.id, people.main);
    expect(ok.credit.credited).toBe(true);
    expect(await total(jb.id)).toBe(72);
    expect((await m().returns.creditReturn(r.item!.id)).note).toBe("Already credited.");
    const rows = (await costsOf(jb.id)).filter((x) => x.stockRef === `return:${r.item!.id}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.amount).toBe(-48);
    facts.unopened = { out: 120, credit: -48, carries: 72 };
  });
  test("opened: internal use only, no credit; $120 pail with $40 moved to the next job", async () => {
    const p = await product({ category: "accessories", unit: "each", name: "Adhesive pail" });
    const pail = await item(p.id, { qty: 1, unit: "each", type: "unit_lot", unitCost: 120, costPer: "unit" });
    const J1 = await job({ quoteTotal: 500, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: J1.job.id, itemId: pail.id, orderedQty: 1, lineUnit: "each", requestKey: rk() }, people.office);
    await m().holds.takeOut(a.hold.id, 1, rk("out"), people.office);
    const r = await m().returns.returnFromJob({ holdId: a.hold.id, kind: "opened", qty: 1, requestKey: rk("ret") }, people.office);
    expect(r.note).toBe("Opened — internal use only. No credit: the first job keeps the full cost.");
    expect(r.item!.condition).toBe("opened");
    expect(r.item!.note).toContain("Opened — internal use only. Cost already allocated to Job");
    const ok = await m().returns.approveReturn(r.item!.id, people.main);
    expect(ok.credit.credited).toBe(false);
    expect(await total(J1.job.id)).toBe(120);
    // A customer sale never gets an opened container.
    const s = await sale({ mode: "invoice", total: 300, percent: 0 });
    await no(m().holds.allocate({ jobId: s.job.id, itemId: r.item!.id, orderedQty: 1, lineUnit: "each", requestKey: rk() }, people.office), "Opened — internal use only. It can only go to our own jobs.");
    await no(m().returns.moveOpenedCost(r.item!.id, 40, "half left", people.admin2), 'You need "Change stock costs (Admin, separate tick)" for this.');
    expect((await m().returns.moveOpenedCost(r.item!.id, 40, "about a third left", people.main)).moved).toBe(true);
    expect((await m().returns.moveOpenedCost(r.item!.id, 40, "again", people.main)).moved).toBe(false);
    expect(await total(J1.job.id)).toBe(80);
    const J2 = await job({ quoteTotal: 500, percent: 0, accepted: true });
    const b = await m().holds.allocate({ jobId: J2.job.id, itemId: r.item!.id, orderedQty: 1, lineUnit: "each", requestKey: rk() }, people.office);
    expect(await total(J2.job.id)).toBe(0);
    await m().holds.takeOut(b.hold.id, 1, rk("out"), people.office);
    expect(await total(J2.job.id)).toBe(40);
    expect((await total(J1.job.id)) + (await total(J2.job.id))).toBe(120);
    facts.opened = { first: 80, next: 40, sum: 120 };
  });
  test("leftovers: too small or not Terra-owned are not stock; 3 m x 4 m comes back at its own rate", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb } = await job({ quoteTotal: 900, percent: 0, accepted: true });
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 10, lineUnit: "lm", requestKey: rk() }, people.office);
    await m().holds.takeOut(a.hold.id, 10, rk("out"), people.office);
    const small = await m().returns.returnFromJob({ holdId: a.hold.id, kind: "leftover", qty: 2, terraOwned: true, requestKey: rk("ret") }, people.office);
    expect(small.stock).toBe(false);
    expect(small.note).toBe("Not stock: under 2.7 m. Recorded on the job.");
    const notOurs = await m().returns.returnFromJob({ holdId: a.hold.id, kind: "leftover", qty: 3, terraOwned: false, requestKey: rk("ret") }, people.office);
    expect(notOurs.note).toBe("Not stock: not ticked as Terra-owned. Recorded on the job.");
    const logged = await m().db.select().from(schema.activityLog).where(eq(schema.activityLog.action, "stock_leftover_not_stock"));
    expect(logged.filter((l) => l.jobId === jb.id).length).toBe(2);
    const kept = await m().returns.returnFromJob({ holdId: a.hold.id, kind: "leftover", qty: 3, widthM: 4, terraOwned: true, requestKey: rk("ret") }, people.office);
    expect(kept.item!.type).toBe("remnant");
    const ok = await m().returns.approveReturn(kept.item!.id, people.main);
    expect(ok.credit.credited).toBe(true);
    expect(await total(jb.id)).toBe(70);
    facts.leftover = { out: 100, credit: -30, carries: 70 };
  });
});

/* ================================ item edits ================================ */

describe("items: boxes, loose returns, corrections", () => {
  test("opening boxes keeps quantity and cost; a repeat press does nothing", async () => {
    const p = await product({ category: "timber", unit: "box" });
    const box = await item(p.id, { qty: 5, unit: "box", type: "box_lot", packSize: 10, unitCost: 80, costPer: "unit" });
    const key = rk("open");
    const o = await m().items.openBox(box.id, 2, key, people.office);
    expect(o.box.qty).toBe(3);
    expect(o.loose.qty).toBe(20);
    expect(o.loose.unitCost).toBe(8);
    const again = await m().items.openBox(box.id, 2, key, people.office);
    expect(again.box.qty).toBe(3);
    expect(again.loose.qty).toBe(20);
    await no(m().items.openBox(box.id, 1.5, rk("open"), people.office), "Open whole boxes only.");
    expect(await m().items.countLooseReturn(5, 2)).toEqual({ counted: 5, notCounted: 2, note: "2 short board(s) not counted as stock." });
  });
  test("a movement is reversed once; a held quantity cannot be written off", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 10 });
    const mv = await m().items.writeOff(roll.id, 1, "water damage", people.main);
    expect((await itemRow(roll.id)).qty).toBe(9);
    await no(m().items.reverseMovement(mv.id, "wrong roll", people.office), 'You need "');
    await m().items.reverseMovement(mv.id, "wrong roll", people.main);
    expect((await itemRow(roll.id)).qty).toBe(10);
    await no(m().items.reverseMovement(mv.id, "wrong roll", people.main), "That movement has already been reversed.");
    const { job: jb } = await job({ quoteTotal: 900, percent: 0, accepted: true });
    await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 8, lineUnit: "lm", requestKey: rk() }, people.office);
    await no(m().items.writeOff(roll.id, 5, "damaged", people.main), "Part of that is held for an order. Release the hold first.");
  });
});

/* ============================== pause and bring in ============================== */

describe("switches paused, and orders from before the switch", () => {
  test("S4 paused: holds stay, nothing new, PO helper still leaves out stock", async () => {
    const c = await costingJob();
    const a = await m().holds.allocate({ jobId: c.job.id, itemId: c.roll.id, orderedQty: 100, lineUnit: "m2", quoteItemId: c.qi.id, jobMaterialId: c.mat.id, requestKey: rk() }, people.office);
    await m().core.setSwitch("s4", "paused", people.main);
    const since = (await m().core.switches()).s4.since;
    await m().recheck.recheckAll();
    expect((await holdRow(a.hold.id)).status).toBe("reserved");
    const other = await item(c.p.id, { qty: 10 });
    await no(m().holds.allocate({ jobId: c.job.id, itemId: other.id, orderedQty: 1, lineUnit: "lm", requestKey: rk() }, people.office), "S4 Installation jobs is paused. Existing holds stay, but nothing new can be done.");
    expect((await m().poHelper.draftPosForJob({ jobId: c.job.id, quoteRef: "Q-test" })).drafted.length).toBe(0);
    expect(await total(c.job.id)).toBe(900);
    await m().core.setSwitch("s4", "on", people.main);
    expect((await m().core.switches()).s4.since).toBe(since);
    facts.paused = "holds kept, allocate refused, PO helper unchanged";
  });
  test("accepted before S4 went on: refused until an Admin brings it in, once", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const since = new Date((await m().core.switches()).s4.since!);
    await m().db.update(schema.quotes).set({ acceptedAt: new Date(since.getTime() - 86400_000) }).where(eq(schema.quotes.id, quote!.id));
    await no(m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office), 'This order was accepted before the stock workflow was on. An Admin uses "Bring into stock workflow" first.');
    await no(m().orders.bringIntoWorkflow(jb.id, people.office), "Only an Admin can bring an order into the stock workflow.");
    const b = await m().orders.bringIntoWorkflow(jb.id, people.main);
    expect(b.order.joinedVia).toBe("brought_in");
    expect(b.order.broughtInByName).toBe(people.main.name);
    expect(b.order.requiredDeposit).toBe(300);
    await no(m().orders.bringIntoWorkflow(jb.id, people.main), "This order is already in the stock workflow.");
    const a = await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    expect(a.hold.status).toBe("awaiting");
    facts.broughtIn = b.startPosition;
  });
});

/* ================================ check failures ================================ */

describe("the 10 minute check failing", () => {
  test("three failures in a row alert once; the next good check clears it", async () => {
    const p = await product({ category: "carpet" });
    const roll = await item(p.id, { qty: 20 });
    // A 0% order is confirmed, so the check reads its holds (an order still waiting for a deposit stops before that).
    const { job: jb } = await job({ quoteTotal: 1000, percent: 0, accepted: true });
    await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 5, lineUnit: "lm", requestKey: rk() }, people.office);
    const o = await orderOf(jb.id);
    await sql("alter table stock_reservations rename to sr_tmp");
    try {
      for (let i = 0; i < 3; i++) expect((await m().recheck.recheckOrder(o.id)).state).toBe("error");
    } finally {
      await sql("alter table sr_tmp rename to stock_reservations");
    }
    const al = (await alertsFor(o.id)).filter((x) => x.key === `check-failed:${o.id}`);
    expect(al.length).toBe(1);
    expect(al[0]!.body).toContain("failed 3 times running");
    const ok = await m().recheck.recheckOrder(o.id);
    expect(ok.error ?? null).toBeNull();
    expect((await orderOf(jb.id)).failCount).toBe(0);
  });
});

/* ========================= lines, crew view, isolation ========================= */

describe("lines stock is chosen for, and the Crew view", () => {
  test("a quote line is tied to its job material; other materials stand alone", async () => {
    const c = await costingJob();
    const p2 = await product({ category: "accessories", unit: "each" });
    const m2 = await material(c.job.id, p2.id, 3, "each", "Trims");
    const lines = await m().orders.stockLinesOf(c.job.id);
    expect(lines.map((l) => l.key).sort()).toEqual([`m:${m2.id}`, `q:${c.qi.id}`].sort());
    const q = lines.find((l) => l.key === `q:${c.qi.id}`)!;
    expect(q.jobMaterialId).toBe(c.mat.id);
    expect(q.quoteItemId).toBe(c.qi.id);
  });
  test("Crew sees 'warehouse' only once stock is firm (reserved, cut or picked)", async () => {
    const p = await product({ category: "carpet" });
    const r1 = await item(p.id, { qty: 20 });
    const r2 = await item(p.id, { qty: 20 });
    const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
    const m1 = await material(jb.id, p.id, 5, "lm", "Carpet A");
    const m2 = await material(jb.id, p.id, 4, "lm", "Carpet B");
    const a = await m().holds.allocate({ jobId: jb.id, itemId: r1.id, orderedQty: 5, lineUnit: "lm", jobMaterialId: m1.id, requestKey: rk() }, people.office);
    await m().holds.allocate({ jobId: jb.id, itemId: r2.id, orderedQty: 4, lineUnit: "lm", jobMaterialId: m2.id, temporary: true, requestKey: rk() }, people.office);
    const where = async () => Object.fromEntries((await m().crew.crewMaterials(jb.id, null)).map((x) => [x.id, x.where]));
    expect(await where()).toEqual({ [m1.id]: "to_order", [m2.id]: "to_order" });
    const dep = await depositInvoice(jb.id, quote!.id, 300);
    const ev = stripeEvent(dep.id, 300);
    await m().stripe.handleWebhook(ev.body, ev.header);
    expect(await where()).toEqual({ [m1.id]: "warehouse", [m2.id]: "warehouse" });
    await m().holds.cutHold(a.hold.id, rk("cut"), people.office);
    expect((await where())[m1.id]).toBe("warehouse");
    facts.crew = "to_order until firm, then warehouse";
  });
});

describe("stock status wording", () => {
  test("nothing firm yet, part short: says it waits, and how much is still to come in", () => {
    const rs = m().recheck.reserveStatus;
    const h = (status: string, orderedQty: number) => ({ status, qty: orderedQty, orderedQty, lineUnit: "lm" }) as any;
    expect(rs([h("awaiting", 12), h("short", 8)])).toBe("Not reserved yet. 8 m still to come in");
    expect(rs([h("short", 8)])).toBe("Not reserved: 8 m outstanding");
    expect(rs([h("reserved", 12), h("short", 8)])).toBe("Partially reserved: 8 m outstanding");
    expect(rs([h("awaiting", 12)])).toBe("Not reserved yet");
    expect(rs([h("reserved", 12), h("released", 8)])).toBe("Fully reserved");
  });
});

registerA2({ no, eq, facts, material });
registerA2b({ no, eq, facts, material });
registerA2c({ no, eq, facts, material });

describe("isolation: nothing left the machine", () => {
  test("no network, no SMS, no job email, no customer or supplier email", async () => {
    expect(outside.fetch).toEqual([]);
    expect(outside.sms).toEqual([]);
    expect(outside.jobMail).toEqual([]);
    const all = JSON.stringify(outside.email.map((e) => e.to));
    expect(/c\d+@example\.invalid|pat@example\.invalid/.test(all)).toBe(false);
    expect(outside.email.every((e) => String(e.subject).startsWith("[Terra Ops] "))).toBe(true);
    // A2 follow-up: purchase orders to suppliers only ever to .invalid test addresses, captured.
    expect(outside.supplierMail.every((e) => /\.invalid$/.test(e.to))).toBe(true);
    facts.outside = { fetch: outside.fetch.length, sms: outside.sms.length, jobMail: outside.jobMail.length, officeEmails: outside.email.length, push: outside.push.length };
    await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/stock-facts.tmp.json`, JSON.stringify(facts, null, 2));
  });
});
