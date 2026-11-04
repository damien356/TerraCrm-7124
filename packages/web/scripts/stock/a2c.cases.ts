/**
 * Warehouse stock, A2c readiness checks (Damien, 4 Nov 2026). Registered from
 * stock.test.ts after the A2 follow-up tests, on the same throwaway database.
 *
 *  - The deposit line with real amounts, after a part payment, and after a
 *    payment recorded but not confirmed (never asked for twice).
 *  - A known shortage before payment: the approved wording. A reorder
 *    product is told but not blocked. A container product is blocked on the
 *    pay page, PDF and email until the main admin records what the customer
 *    agreed to. The internal approval note alone never unblocks it.
 *  - Paid, then short: the approved wording, payments unchanged, no PO,
 *    never "Fully reserved".
 *  - One product in bags, bought by the pallet: the same unit word and the
 *    conversion everywhere.
 *  - The setup gate before stock goes in. A job-only product is unchanged.
 *  - S6 off and paused: Send and Mark sent both refused.
 *
 * Nothing leaves the machine. Run from packages/web:  bun test scripts/stock
 */
import { describe, expect, test } from "bun:test";
import { call } from "@orpc/server";
import { holdsOf, item, job, m, outside, paymentsOf, pdfText, people, product, rk, sale, schema, supplier } from "./harness";

type Helpers = {
  no: (p: Promise<unknown>, text: string) => Promise<void>;
  eq: (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => ReturnType<ReturnType<typeof m>["drizzle"]["eq"]>;
  facts: Record<string, unknown>;
  material: (jobId: number, productId: number, qty: number, unit?: string, description?: string) => Promise<typeof schema.jobMaterials.$inferSelect>;
};
type Prod = typeof schema.products.$inferSelect;

export function registerA2c(h: Helpers) {
  const { no, eq, facts, material } = h;
  const db = () => m().db;
  const prod = async (id: number) => (await db().select().from(schema.products).where(eq(schema.products.id, id)))[0]!;
  const setSupply = async (id: number, s: Partial<Prod>) => {
    await db()
      .update(schema.products)
      .set({ stockTracked: true, supplySetAt: new Date(), supplySetBy: "Test", ...s })
      .where(eq(schema.products.id, id));
    return prod(id);
  };
  const inv = async (id: number) => (await db().select().from(schema.invoices).where(eq(schema.invoices.id, id)))[0]!;
  const owing = (i: typeof schema.invoices.$inferSelect) => Math.round((i.total - i.amountPaid) * 100) / 100;
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const checkout = (token: string, choice?: "deposit" | "full") => call(m().publicPages.publicPages.pay.checkout, { token, choice }, { context: { headers: new Headers() } } as never);
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected it to be refused");
  };
  /** The PDF and email a customer would get for this invoice now. */
  const paperwork = async (invoiceId: number, tag: string) => {
    const i = await inv(invoiceId);
    const note = await m().pdf.stockPayNote(i.id, owing(i));
    const url = m().stripe.payUrl(i.id);
    const body = m().mail.invoiceEmailBody({ first: "Pat", ref: i.number, label: i.label, owing: owing(i), url, depositLine: note.text, payBlocked: note.blocked });
    const { pdf } = await m().pdf.clientInvoicePdfFor(i.id);
    const pdfTxt = flat(pdfText(pdf, `a2c-${tag}`));
    return { note, body, pdfTxt, url, token: m().stripe.payToken(i.id), pdf };
  };

  const SHORT = () => m().pay.SHORT_BEFORE_PAY;
  const PAID = () => m().pay.PAID_SHORT;

  /* ============================ the deposit line ============================ */

  describe("A2c: the deposit line, real amounts, never asked for twice", () => {
    test("$1,000 direct invoice, 30%: the line on the pay page, PDF and email; no shortage notice", async () => {
      const p = await product({ category: "carpet" });
      const roll = await item(p.id, { qty: 20 });
      const s = await sale({ mode: "invoice", total: 1000, percent: 30 });
      await m().holds.allocate({ jobId: s.job.id, itemId: roll.id, orderedQty: 6, lineUnit: "lm", requestKey: rk() }, people.office);
      const LINE = "Required deposit: $300.00 (30% of the invoice total). Balance after deposit: $700.00.";
      const page = await m().publicPages.payState(await inv(s.invoice!.id));
      expect(page.depositLine).toBe(LINE);
      expect(page.depositOption).toEqual({ amount: 300, percent: 30, balance: 700 });
      // A deposit less than the total is not a shortage.
      expect(page.stockNotice).toBeNull();
      expect(page.payBlocked).toBe(false);
      const pw = await paperwork(s.invoice!.id, "dep-before");
      expect(pw.pdfTxt).toContain(LINE);
      expect(pw.body).toContain(LINE);
      expect(pw.body).toContain(pw.url);
      expect(pw.pdfTxt).not.toContain(SHORT().slice(0, 40));

      // $100 bank payment, confirmed: the line says what is left of the deposit.
      const p1 = await m().ci.markInvoicePaid({ id: s.invoice!.id, amount: 100, method: "bank", byName: people.office.name, actorRole: "office" });
      await m().orders.confirmForStock(p1.paymentId!, "Bank statement checked", people.main);
      await m().recheck.recheckAfterPayment(s.invoice!.id);
      const PART = "Required deposit: $300.00 (30% of the invoice total). Paid so far: $100.00. Deposit still to pay: $200.00. Balance after deposit: $700.00.";
      const page2 = await m().publicPages.payState(await inv(s.invoice!.id));
      expect(page2.depositLine).toBe(PART);
      expect(page2.depositOption).toEqual({ amount: 200, percent: 30, balance: 700 });
      const pw2 = await paperwork(s.invoice!.id, "dep-part");
      expect(pw2.pdfTxt).toContain(PART);
      expect(pw2.body).toContain(PART);

      // $200 recorded by hand but not confirmed: nothing more is asked for as a deposit.
      await m().ci.markInvoicePaid({ id: s.invoice!.id, amount: 200, method: "bank", byName: people.office.name, actorRole: "office" });
      const page3 = await m().publicPages.payState(await inv(s.invoice!.id));
      expect(page3.depositOption).toBeNull();
      expect(page3.depositLine).toBeNull();
      expect(page3.stockLabel).toBe("Payment recorded — awaiting admin confirmation");
      expect(page3.owing).toBe(700);
      const pw3 = await paperwork(s.invoice!.id, "dep-recorded");
      expect(pw3.body).not.toContain("Required deposit");
      expect(pw3.pdfTxt).not.toContain("Required deposit");
      // The deposit button is refused at checkout too: the amount is worked out on the server.
      const e = await errOf(checkout(pw3.token, "deposit"));
      expect(e.message).toBe("The deposit has already been paid or recorded. Please pay the balance shown.");
      expect((await paymentsOf(s.invoice!.id)).length).toBe(2);
      facts.a2cDeposit = { before: LINE, afterPart: PART, afterRecorded: { depositOption: null, depositLine: null, label: page3.stockLabel }, notice: null };
    });
  });

  /* ================== reorder product short: told, not blocked; then paid ================== */

  describe("A2c: a reorder product short before payment, then paid while short", () => {
    let s: Awaited<ReturnType<typeof sale>>;
    let sup: Awaited<ReturnType<typeof supplier>>;
    test("before payment: the approved notice, payment still allowed", async () => {
      sup = await supplier("TEST ONLY Tub Supplier");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Tile Grout 5 kg" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 0, reorderQty: 0, stockUnitLabel: "tubs", costPrice: 12, leadTimeDays: 2 });
      s = await sale({ mode: "invoice", total: 1000, percent: 30 });
      const a = await m().holds.allocate({ jobId: s.job.id, itemId: null, productId: p.id, orderedQty: 8, lineUnit: "each", requestKey: rk() }, people.office);
      expect(a.hold.status).toBe("short");
      const info = (await m().pay.stockPayInfo(s.invoice!.id, 1000))!;
      expect(info.notice).toBe(SHORT());
      expect(info.notice).toBe(
        "Some material for your order is currently unavailable. Please contact Terra Flooring before paying so we can confirm the available quantities and agree how to proceed.",
      );
      expect(info.blocked).toBe(false);
      expect(info.stockLabel).toBeNull();
      const pw = await paperwork(s.invoice!.id, "reorder-short");
      expect(pw.note.blocked).toBe(false);
      expect(pw.pdfTxt).toContain(SHORT());
      expect(pw.pdfTxt).toContain("PAYMENT BY BANK TRANSFER");
      expect(pw.body).toContain(SHORT());
      expect(pw.body).toContain(pw.url);
      expect(pw.body).toContain("BSB:");
      facts.a2cReorderShort = { notice: info.notice, blocked: info.blocked, payLink: true };
    });

    test("paid while short: the paid wording, one payment, no refund, no PO, never Fully reserved", async () => {
      const paid = await m().ci.markInvoicePaid({ id: s.invoice!.id, amount: 300, method: "bank", byName: people.office.name, actorRole: "office" });
      await m().orders.confirmForStock(paid.paymentId!, "Bank statement checked", people.main);
      await m().recheck.recheckAfterPayment(s.invoice!.id);
      const info = (await m().pay.stockPayInfo(s.invoice!.id, 700))!;
      expect(info.notice).toBe(PAID());
      expect(info.notice).toBe("Your payment has been received, but we have not yet been able to reserve all the material for your order. Our office will contact you to discuss the next steps.");
      expect(info.stockLabel).toBeNull();
      const pays = await paymentsOf(s.invoice!.id);
      expect(pays.length).toBe(1);
      expect(pays.every((x) => x.amount > 0)).toBe(true);
      expect((await inv(s.invoice!.id)).amountPaid).toBe(300);
      expect((await db().select().from(schema.purchaseOrders)).filter((x) => x.supplierId === sup.id).length).toBe(0);
      const hs = await holdsOf(s.job.id);
      expect(m().recheck.reserveStatus(hs)).not.toBe("Fully reserved");
      const pw = await paperwork(s.invoice!.id, "paid-short");
      expect(pw.pdfTxt).toContain(PAID());
      expect(pw.body).toContain(PAID());
      expect(pw.body).not.toContain("Fully reserved");
      facts.a2cPaidShort = { notice: info.notice, payments: pays.length, refunds: 0, pos: 0, status: m().recheck.reserveStatus(hs) };
    });
  });

  /* ============ container short on a direct invoice: blocked until the customer agrees ============ */

  describe("A2c: a container shortage blocks payment until the customer's arrangement is recorded", () => {
    let invoiceId = 0;
    let productId = 0;
    let jobId = 0;
    test("internal approval raises the invoice, but the pay page, checkout, PDF and email stay blocked", async () => {
      const sup = await supplier("TEST ONLY Container Three");
      const p = await product({ supplierId: sup.id, category: "carpet", unit: "lm", widthM: 4, name: "TEST Imported Velvet" });
      await setSupply(p.id, { supplyMode: "container" });
      await item(p.id, { qty: 20 });
      productId = p.id;
      const [ct] = await db().insert(schema.contacts).values({ firstName: "Robin", lastName: "Direct", email: "c770002@example.invalid" }).returning();
      const key = rk("sale-a2c");
      const input = {
        buyer: { kind: "contact" as const, contactId: ct!.id },
        mode: "invoice" as const,
        lines: [{ productId: p.id, description: "Imported velvet carpet", qty: 30, unit: "lm", unitPrice: 100, fromStock: 20 }],
        orderNeeded: true,
        depositPercent: 30,
      };
      const pv = await m().productSale.previewSale({ ...input, requestKey: key });
      const total = (pv as unknown as { total: number }).total;
      await m().supplyCheck.approveSupplyShort({ entityType: "sale", entityKey: key, productId: p.id, shortQty: 10, note: "Owner OK to raise the invoice" }, people.main);
      const out = await m().productSale.raiseSale({ ...input, requestKey: key, expectedTotal: total }, people.office as never);
      invoiceId = out.invoice!.id;
      const i = await inv(invoiceId);
      jobId = i.jobId!;
      const page = await m().publicPages.payState(i);
      expect(page.stockNotice).toBe(SHORT());
      expect(page.payBlocked).toBe(true);
      expect(page.depositOption).toBeNull();
      const pw = await paperwork(invoiceId, "container-blocked");
      // Checkout refuses both choices before anything goes to Stripe.
      const fetches = outside.fetch.length;
      expect((await errOf(checkout(pw.token, "full"))).message).toBe(SHORT());
      expect((await errOf(checkout(pw.token, "deposit"))).message).toBe(SHORT());
      expect(outside.fetch.length).toBe(fetches);
      expect(pw.note.blocked).toBe(true);
      expect(pw.pdfTxt).toContain(SHORT());
      expect(pw.pdfTxt).not.toContain(pw.token);
      expect(pw.pdfTxt).not.toContain("PAYMENT BY BANK TRANSFER");
      expect(pw.pdfTxt).not.toContain("BSB");
      expect(pw.pdfTxt).not.toContain("PAY BY CARD");
      expect(pw.body).toContain(SHORT());
      expect(pw.body).not.toContain(pw.url);
      expect(pw.body).not.toContain("BSB:");
      expect(pw.body).not.toContain("Pay by card");
      // The internal note is on the sale. It is not the customer's agreement.
      const appr = (await db().select().from(schema.stockSupplyApprovals)).filter((a) => a.entityKey === key);
      expect(appr.map((a) => [a.note, a.customerAgreed])).toEqual([["Owner OK to raise the invoice", ""]]);
      const panel = await m().shortage.jobShortages(jobId, null);
      expect(panel.map((x) => [x.productId, x.blocksPayment, x.arrangement, x.target])).toEqual([[productId, true, null, { invoiceId }]]);
      facts.a2cContainer = { notice: page.stockNotice, blocked: true, checkout: "refused", pdfPayLink: false, pdfBank: false, emailPayLink: false, emailBank: false, internalNote: appr[0]!.note };
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2c-blocked-invoice.tmp.pdf`, pw.pdf);
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2c-blocked-email.tmp.txt`, pw.body);
    });

    test("office refused; main admin must tick and write it; then payment opens and the arrangement shows", async () => {
      const arr = "Customer takes 20 m now and the last 10 m from the December container.";
      await no(m().shortage.recordCustomerArrangement({ invoiceId, productId, arrangement: arr, customerAgreed: true }, people.office), "Only the main admin can record an arrangement agreed with the customer.");
      await no(m().shortage.recordCustomerArrangement({ invoiceId, productId, arrangement: arr, customerAgreed: false }, people.main), "Tick that the customer has agreed to this arrangement.");
      await no(m().shortage.recordCustomerArrangement({ invoiceId, productId, arrangement: "ok", customerAgreed: true }, people.main), "Write down what the customer agreed to.");
      expect((await m().pay.stockPayInfo(invoiceId, owing(await inv(invoiceId))))?.blocked).toBe(true);
      await m().shortage.recordCustomerArrangement({ invoiceId, productId, arrangement: arr, customerAgreed: true }, people.main);
      const page = await m().publicPages.payState(await inv(invoiceId));
      expect(page.payBlocked).toBe(false);
      expect(page.stockNotice).toBeNull();
      const pw = await paperwork(invoiceId, "container-agreed");
      expect(pw.note.blocked).toBe(false);
      expect(pw.pdfTxt).toContain("PAYMENT BY BANK TRANSFER");
      expect(pw.body).toContain(pw.url);
      const panel = await m().shortage.jobShortages(jobId, null);
      expect(panel[0]!.arrangement?.text).toBe(arr);
      expect(panel[0]!.arrangement?.byName).toBe(people.main.name);
      const log = (await db().select().from(schema.activityLog)).filter((a) => a.action === "stock_customer_arrangement" && a.entityId === jobId);
      expect(log.length).toBe(1);
      // Kept apart from the internal approval note.
      const rows = (await db().select().from(schema.stockSupplyApprovals)).filter((a) => a.productId === productId);
      expect(rows.map((r) => [r.entityType, r.note, r.customerAgreed]).sort()).toEqual([
        ["invoice", "", arr],
        ["sale", "Owner OK to raise the invoice", ""],
      ]);
      // Nothing was ordered or paid by this.
      expect((await paymentsOf(invoiceId)).length).toBe(0);
      facts.a2cArrangement = { officeRefused: true, untickedRefused: true, recordedBy: people.main.name, text: arr, blockedAfter: false };
    });
  });

  /* ============================ units, one product ============================ */

  describe("A2c: one product in bags, bought by the pallet, the same everywhere", () => {
    test("stock, job panel, receiving, PO line and PDF, and Crew all say bags; the conversion shows", async () => {
      await m().core.setSwitch("s6", "on", people.main);
      const sup = await supplier("TEST ONLY Bag Supplier");
      await db().update(schema.suppliers).set({ email: "orders@bag-supplier-test.invalid" }).where(eq(schema.suppliers.id, sup.id));
      const p0 = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Rapid Set 20 kg" });
      const p = await setSupply(p0.id, { supplyMode: "reorder", reorderLevel: 10, reorderQty: 100, stockUnitLabel: "bags", purchaseUnit: "pallet", stockPerPurchase: 50, costPrice: 20, leadTimeDays: 3 });
      const R = m().replenish;
      expect(R.conversionText(p)).toBe("1 pallet = 50 bags");
      expect(R.setupProblems(p)).toEqual([]);
      const d = await m().warehousePo.draftSuggestions(sup.id, [p.id], people.main);
      const po = d.po!;
      const [line] = (await db().select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id))).filter((l) => l.kind === "goods");
      expect(line!.qty).toBe(100);
      expect(line!.description).toBe("TEST Rapid Set 20 kg Grey (100 bags = 2 pallets. 1 pallet = 50 bags)");
      // Receiving and the PO screens read the line through the same word.
      expect(R.unitWord(p, line!.unit)).toBe("bags");
      const r = await m().purchasing.sendPoNow({ id: po.id, saveEmail: false }, people.main as never);
      expect(r.ok).toBe(true);
      const mail = outside.supplierMail.at(-1)!;
      const pdf = Buffer.from(mail.attachments[0]!.content, "base64");
      const txt = flat(pdfText(pdf, `a2c-${po.number}`));
      // The description wraps in its column: "(100 bags = 2 pallets. 1" then "pallet = 50 bags)", with Qty and Unit beside it.
      expect(txt).toMatch(/TEST Rapid Set 20 kg Grey \(100 bags = 2 pallets\. 1 100 bags \$20\.00 \$2000\.00 pallet = 50 bags\)/);
      expect(txt).not.toMatch(/\s100 unit\s/);
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2c-${po.number}.tmp.pdf`, pdf);
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2c-po-email.tmp.json`, JSON.stringify({ ...mail, attachments: mail.attachments.map((a) => ({ filename: a.filename, bytes: Buffer.from(a.content, "base64").length })) }, null, 2));
      // Received: the stock item counts bags.
      const got = await m().receiving.receiveLine({ poLineId: line!.id, pieces: [{ qty: 100 }], requestKey: rk("recv-bags") }, people.office);
      const it = got.items[0]!;
      expect(R.unitWord(p, it.unit)).toBe("bags");
      // A job takes 12: the job panel line and Crew both say bags.
      const { job: jb } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
      const mat = await material(jb.id, p.id, 12, "each", "Rapid set");
      const a = await m().holds.allocate({ jobId: jb.id, itemId: it.id, orderedQty: 12, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      expect(R.unitWord(p, a.hold.lineUnit)).toBe("bags");
      const crew = (await m().crew.crewMaterials(jb.id, null)).find((x) => x.id === mat.id)!;
      expect(crew.count).toBe("12 bags");
      expect(m().crew.crewQty(1, "each", p).count).toBe("1 bag");
      expect(JSON.stringify(crew)).not.toMatch(/\$|unitCost|price/i);
      facts.a2cUnits = {
        conversion: R.conversionText(p),
        poLine: line!.description,
        pdfLine: "100 bags $20.00 $2000.00",
        stockItem: `${it.qty} ${R.unitWord(p, it.unit)}`,
        jobLine: `12 ${R.unitWord(p, a.hold.lineUnit)}`,
        crew: crew.count,
        po: po.number,
      };
    });
  });

  /* ============================ the setup gate ============================ */

  describe("A2c: a product is confirmed before it goes into stock; job-only products unchanged", () => {
    test("unconfirmed: opening stock and receiving refused with what is missing", async () => {
      const sup = await supplier("TEST ONLY Gate Supplier");
      const p0 = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Unconfirmed Primer" });
      // Flagged for the warehouse in the catalogue, but nobody has confirmed its supply rule or units.
      await db().update(schema.products).set({ stockTracked: true, supplyMode: "reorder", purchaseUnit: "carton", stockPerPurchase: null }).where(eq(schema.products.id, p0.id));
      const p = await prod(p0.id);
      expect(m().replenish.setupProblems(p)).toEqual([
        "Its supply rule has not been confirmed.",
        "The stock unit word is missing (for example bags or pails).",
        'Purchase unit "carton" has no conversion to the stock unit.',
      ]);
      const want = "Confirm TEST Unconfirmed Primer Grey before it goes into stock. Its supply rule has not been confirmed. The stock unit word is missing (for example bags or pails). Purchase unit \"carton\" has no conversion to the stock unit. Set it on Reorder, product supply settings.";
      await no(m().replenish.assertSetUp(p.id), want);
      // Receiving on a sent job PO is refused the same way, and nothing is created.
      const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
      const mat = await material(jb.id, p.id, 4, "each", "Primer");
      const [po] = await db().insert(schema.purchaseOrders).values({ number: `PO-G${jb.id}`, jobId: jb.id, supplierId: sup.id, status: "sent", kind: "job", totalExGst: 40, goodsExGst: 40 }).returning();
      const [ln] = await db()
        .insert(schema.purchaseOrderLines)
        .values({ poId: po!.id, jobMaterialId: mat.id, productId: p.id, kind: "goods", description: "Primer", qty: 4, unit: "each", unitCostExGst: 10, totalExGst: 40 })
        .returning();
      await no(m().receiving.receiveLine({ poLineId: ln!.id, pieces: [{ qty: 4 }], requestKey: rk("recv-gate") }, people.office), want);
      expect((await db().select().from(schema.stockItems)).filter((i) => i.productId === p.id).length).toBe(0);
      // Confirmed: it goes in.
      await setSupply(p.id, { stockUnitLabel: "tins", stockPerPurchase: 6 });
      const got = await m().receiving.receiveLine({ poLineId: ln!.id, pieces: [{ qty: 4 }], requestKey: rk("recv-gate") }, people.office);
      expect(got.items.length).toBeGreaterThan(0);
      facts.a2cGate = { refused: want, afterConfirm: "received" };
    });

    test("a job-only product, never set up for stock, receives on a job PO as before", async () => {
      const sup = await supplier("TEST ONLY Job Supplier");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Job Only Nosing" });
      expect(p.stockTracked).toBe(false);
      expect(m().replenish.modeOf(p)).toBe("job");
      const { job: jb } = await job({ quoteTotal: 500, percent: 0, accepted: true });
      const mat = await material(jb.id, p.id, 3, "each", "Nosing");
      const [po] = await db().insert(schema.purchaseOrders).values({ number: `PO-J${jb.id}`, jobId: jb.id, supplierId: sup.id, status: "sent", kind: "job", totalExGst: 30, goodsExGst: 30 }).returning();
      const [ln] = await db()
        .insert(schema.purchaseOrderLines)
        .values({ poId: po!.id, jobMaterialId: mat.id, productId: p.id, kind: "goods", description: "Nosing", qty: 3, unit: "each", unitCostExGst: 10, totalExGst: 30 })
        .returning();
      const got = await m().receiving.receiveLine({ poLineId: ln!.id, pieces: [{ qty: 3 }], requestKey: rk("recv-job") }, people.office);
      expect(got.items.length).toBeGreaterThan(0);
      const after = await prod(p.id);
      expect([after.stockTracked, after.supplyMode, after.supplySetAt]).toEqual([p.stockTracked, p.supplyMode, p.supplySetAt]);
      facts.a2cJobOnly = "received, product unchanged";
    });
  });

  /* ============================ S6 off and paused ============================ */

  describe("A2c: S6 off and S6 paused, Send and Mark sent both refused", () => {
    test("a warehouse draft cannot go while S6 is paused or off", async () => {
      await m().core.setSwitch("s6", "on", people.main);
      const sup = await supplier("TEST ONLY S6 Supplier");
      await db().update(schema.suppliers).set({ email: "orders@s6-supplier-test.invalid" }).where(eq(schema.suppliers.id, sup.id));
      const p0 = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST S6 Adhesive" });
      await setSupply(p0.id, { supplyMode: "reorder", reorderLevel: 5, reorderQty: 10, stockUnitLabel: "pails", costPrice: 30, leadTimeDays: 5 });
      const d = (await m().warehousePo.draftSuggestions(sup.id, [p0.id], people.main)).po!;
      const MSG = "Warehouse orders are paused (S6 is off). Turn S6 back on to send this draft.";
      const mails = outside.supplierMail.length;
      const seen: Record<string, string[]> = {};
      for (const state of ["paused", "off"] as const) {
        await m().core.setSwitch("s6", state, people.main);
        const a = await errOf(m().purchasing.sendPoNow({ id: d.id, saveEmail: false }, people.main as never));
        const b = await errOf(m().purchasing.markPoSentNow({ id: d.id, how: "phoned" }, people.main as never));
        expect([a.message, b.message]).toEqual([MSG, MSG]);
        const [row] = await db().select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, d.id));
        expect(row!.status).toBe("draft");
        seen[state] = [a.message, b.message];
      }
      expect(outside.supplierMail.length).toBe(mails);
      await m().core.setSwitch("s6", "on", people.main);
      facts.a2cS6 = { ...seen, emails: 0, status: "draft" };
    });
  });
}
