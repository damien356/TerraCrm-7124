/**
 * Warehouse stock, A2 follow-up checks (Damien, 4 Nov 2026). Registered from
 * stock.test.ts after the A2 tests, on the same throwaway database.
 *
 *  - Send on a PO-W: the real Send path, the email captured (test-only
 *    .invalid address), the PDF read back.
 *  - Send failure and retry: not sent, nothing ordered, one email on retry.
 *  - The overlap check on Send and Mark sent, job PO and warehouse PO, with
 *    the main admin's override written to the activity log.
 *  - Container shortage on Raise invoice now, and a quote whose stock went
 *    to another order before the customer accepted, then paid.
 *  - One cost example at one rate.
 *
 * Nothing leaves the machine. Run from packages/web:  bun test scripts/stock
 */
import { describe, expect, test } from "bun:test";
import { costsOf, depositInvoice, holdsOf, item, job, m, outside, paymentsOf, pdfText, people, product, rk, schema, stripeEvent, supplier } from "./harness";

type Helpers = {
  no: (p: Promise<unknown>, text: string) => Promise<void>;
  eq: (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => ReturnType<ReturnType<typeof m>["drizzle"]["eq"]>;
  facts: Record<string, unknown>;
  material: (jobId: number, productId: number, qty: number, unit?: string, description?: string) => Promise<typeof schema.jobMaterials.$inferSelect>;
};
type Prod = typeof schema.products.$inferSelect;

export function registerA2b(h: Helpers) {
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
  const poRow = async (id: number) => (await db().select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)))[0]!;
  const linesOf = async (poId: number) => db().select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  /** Forecast rows plus "no date yet" rows for one warehouse PO (a supplier with no terms lands in the second). */
  const owed = async (poId: number, number: string) => {
    const w = await m().warehouseCash.warehouseCash();
    const rows = [...w.events.filter((e) => e.label.includes(number)).map((e) => Math.abs(e.amount)), ...w.undated.filter((u) => u.poId === poId).map((u) => u.amountIncGst)];
    return { rows: rows.length, total: Math.round(rows.reduce((a, b) => a + b, 0) * 100) / 100 };
  };
  const overrides = async (poId: number) =>
    (await db().select().from(schema.activityLog)).filter((a) => a.action === "po_overlap_override" && a.entityType === "purchase_order" && a.entityId === poId);
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as Error & { data?: { poOverlap?: string[] } };
    }
    throw new Error("expected it to be refused");
  };
  const jobPo = async (jobId: number, supplierId: number, lines: { jobMaterialId: number; productId: number; qty: number; unit: string; unitCost: number }[]) => {
    const total = lines.reduce((s, l) => s + l.qty * l.unitCost, 0);
    const [row] = await db()
      .insert(schema.purchaseOrders)
      .values({ number: `PO-F${jobId}-${lines.length}-${Math.round(total)}`, jobId, supplierId, status: "draft", kind: "job", totalExGst: total, goodsExGst: total })
      .returning();
    for (const l of lines)
      await db()
        .insert(schema.purchaseOrderLines)
        .values({ poId: row!.id, jobMaterialId: l.jobMaterialId, productId: l.productId, kind: "goods", description: "Goods", qty: l.qty, unit: l.unit, unitCostExGst: l.unitCost, totalExGst: l.qty * l.unitCost });
    return row!;
  };

  /* ===================== one rate for every money check ===================== */
  // $40 ex GST a pail. 60 pails = $2,400. The job's 20 = $800. General 40 = $1,600.
  const RATE = 40;
  let pailSup: Awaited<ReturnType<typeof supplier>>;
  let pail: Prod;
  let pailJob: Awaited<ReturnType<typeof job>>;
  let pw: typeof schema.purchaseOrders.$inferSelect;

  describe("A2 follow-up: Send on a warehouse PO (captured email, PDF)", () => {
    test("S6 on, a test-only supplier address, 20 for the job + 40 general at one rate", async () => {
      await m().core.setSwitch("s6", "on", people.main);
      pailSup = await supplier("TEST ONLY Pail Supplier");
      await db().update(schema.suppliers).set({ email: "orders@pail-supplier-test.invalid" }).where(eq(schema.suppliers.id, pailSup.id));
      const p = await product({ supplierId: pailSup.id, category: "accessory", unit: "each", name: "TEST Adhesive 15 L" });
      pail = await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 5, reorderQty: 40, stockUnitLabel: "pails", costPrice: RATE, leadTimeDays: 5 });
      pailJob = await job({ quoteTotal: 2000, percent: 0, accepted: true });
      const mat = await material(pailJob.job.id, p.id, 20, "each", "Adhesive");
      const s = await m().holds.allocate({ jobId: pailJob.job.id, itemId: null, productId: p.id, orderedQty: 20, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      expect(s.hold.status).toBe("short");
      pw = (await m().warehousePo.addShortageToWarehouse(s.hold.id, people.main)).po;
      await m().warehousePo.draftSuggestions(pailSup.id, null, people.main);
      const ls = (await linesOf(pw.id)).filter((l) => l.kind === "goods");
      expect(ls.map((l) => [l.qty, l.unitCostExGst, l.totalExGst])).toEqual([[60, 40, 2400]]);
      expect((await poRow(pw.id)).totalExGst).toBe(2400);
      expect(pw.number).toMatch(/^PO-W\d{4}$/);
    });

    test("the real Send: one email to the test address, PDF attached and correct, then sent and counted once", async () => {
      const before = outside.supplierMail.length;
      const r = await m().purchasing.sendPoNow({ id: pw.id, saveEmail: false }, people.main as never);
      expect([r.ok, r.to, r.overridden]).toEqual([true, "orders@pail-supplier-test.invalid", []]);
      expect(outside.supplierMail.length).toBe(before + 1);
      const mail = outside.supplierMail.at(-1)!;
      expect(mail.subject).toBe(`Purchase order ${pw.number}, Terra Flooring`);
      expect(mail.text).toContain(`Please find attached purchase order ${pw.number} for warehouse stock.`);
      expect(mail.text).toContain("Deliver to: our warehouse,");
      expect(mail.text).toContain(`Please quote ${pw.number} on your invoice`);
      expect(mail.attachments.length).toBe(1);
      expect(mail.attachments[0]!.filename).toContain(pw.number);
      const pdf = Buffer.from(mail.attachments[0]!.content, "base64");
      expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
      const txt = pdfText(pdf, `a2b-${pw.number}`);
      expect(txt).toContain(pw.number);
      // The line: 60 pails at $40.00 = $2400.00 (the PO PDF prints money without a thousands comma, as it always has).
      expect(txt).toMatch(/TEST Adhesive 15 L Grey \(60 pails\)\s+60\s+pails\s+\$40\.00\s+\$2400\.00/);
      expect(txt).not.toMatch(/\s60\s+unit\s/);
      expect(txt).toMatch(/Total ex GST\s+\$2400\.00/);
      expect(txt).toMatch(/GST\s+\$240\.00/);
      expect(txt).toMatch(/Total inc GST\s+\$2640\.00/);
      expect(txt).toContain("Warehouse stock");
      expect(txt.toLowerCase()).toContain("warehouse");
      const sent = await poRow(pw.id);
      expect([sent.status, sent.sentVia, sent.sentTo]).toEqual(["sent", "email", "orders@pail-supplier-test.invalid"]);
      // In the forecast once, for the whole order.
      expect(await owed(pw.id, pw.number)).toEqual({ rows: 1, total: 2640 });
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2b-email.tmp.json`, JSON.stringify({ ...mail, attachments: mail.attachments.map((a) => ({ filename: a.filename, bytes: Buffer.from(a.content, "base64").length })) }, null, 2));
      await Bun.write(`${import.meta.dir}/../../../../../scratch-tmpdb/a2b-${pw.number}.tmp.pdf`, pdf);
      facts.a2bEmail = { to: mail.to, subject: mail.subject, attachment: mail.attachments[0]!.filename, pdfHas: [pw.number, "60 pails", "$40.00", "$2400.00 ex", "$240.00 GST", "$2640.00 inc", "Warehouse stock"], status: sent.status, cashIncGst: -2640 };
    });

    test("the cost example, one rate: 12 then 8 to the job ($800 once), the rest general", async () => {
      const line = (await linesOf(pw.id)).find((l) => l.kind === "goods")!;
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 12 }], requestKey: rk("recv") }, people.office);
      const stockCost = async () => (await costsOf(pailJob.job.id)).filter((c) => c.source === "stock").reduce((s, c) => s + c.amount, 0);
      expect(await stockCost()).toBe(480);
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 18 }], requestKey: rk("recv") }, people.office);
      expect(await stockCost()).toBe(800);
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 30 }], requestKey: rk("recv") }, people.office);
      expect(await stockCost()).toBe(800);
      expect((await costsOf(pailJob.job.id)).filter((c) => c.source === "po").length).toBe(0);
      facts.a2bCost = { rate: RATE, order: 2400, jobShare: 800, general: 1600, receipts: [12, 18, 30], jobCostAfter: [480, 800, 800] };
    });
  });

  describe("A2 follow-up: Send fails, then a retry", () => {
    let po2: typeof schema.purchaseOrders.$inferSelect;
    test("email fails: still a draft, nothing ordered, nothing in the forecast", async () => {
      const sup = await supplier("TEST ONLY Retry Supplier");
      await db().update(schema.suppliers).set({ email: "orders@retry-supplier-test.invalid" }).where(eq(schema.suppliers.id, sup.id));
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Primer 4 L" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 10, reorderQty: 24, stockUnitLabel: "tins", costPrice: 25, leadTimeDays: 3 });
      po2 = (await m().warehousePo.draftSuggestions(sup.id, null, people.main)).po!;
      expect(po2.status).toBe("draft");
      const before = outside.supplierMail.length;
      outside.failNext = 1;
      const e = await errOf(m().purchasing.sendPoNow({ id: po2.id, saveEmail: false }, people.main as never));
      expect(e.message).toBe(`Email did not go: Test relay is down (500). ${po2.number} is still a draft, not sent, and nothing was ordered. Press Send again once it is fixed.`);
      expect((await poRow(po2.id)).status).toBe("draft");
      expect((await poRow(po2.id)).sentAt).toBeNull();
      expect(outside.supplierMail.length).toBe(before);
      const draftOwed = await owed(po2.id, po2.number);
      expect((await poRow(po2.id)).status).toBe("draft");
      facts.a2bFailDraftOwed = draftOwed;
      facts.a2bFail = e.message;
    });

    test("retry: one sent PO, one email; a double press is refused while the first is going", async () => {
      const before = outside.supplierMail.length;
      const [a, b] = await Promise.allSettled([
        m().purchasing.sendPoNow({ id: po2.id, saveEmail: false }, people.main as never),
        m().purchasing.sendPoNow({ id: po2.id, saveEmail: false }, people.main as never),
      ]);
      expect(a.status).toBe("fulfilled");
      expect(b.status).toBe("rejected");
      expect(((b as PromiseRejectedResult).reason as Error).message).toBe("This PO is already being sent. Wait a moment, then refresh.");
      expect(outside.supplierMail.length).toBe(before + 1);
      expect((await poRow(po2.id)).status).toBe("sent");
      const all = (await db().select().from(schema.purchaseOrders)).filter((x) => x.supplierId === po2.supplierId);
      expect(all.length).toBe(1);
      expect(await owed(po2.id, po2.number)).toEqual({ rows: 1, total: Math.round(po2.totalExGst * 110) / 100 });
      facts.a2bRetry = { posForSupplier: all.length, emails: 1, doublePress: "This PO is already being sent. Wait a moment, then refresh." };
    });
  });

  describe("A2 follow-up: the overlap check on Send and Mark sent", () => {
    test("job PO, Mark sent: refused, wrong person and short reason refused, main admin override logged", async () => {
      const sup = await supplier("TEST ONLY Overlap Gate");
      const p = await product({ supplierId: sup.id, category: "carpet" });
      const roll = await item(p.id, { qty: 10 });
      const { job: jb } = await job({ quoteTotal: 3000, percent: 0, accepted: true });
      const mat = await material(jb.id, p.id, 100);
      const d = await jobPo(jb.id, sup.id, [{ jobMaterialId: mat.id, productId: p.id, qty: 100, unit: "m2", unitCost: 20 }]);
      await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 40, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const msg = `Draft ${d.number} still orders 100 m² of Goods. Stock now covers 40 m², so only 60 m² is still needed. Change the draft before sending it.`;
      const e = await errOf(m().purchasing.markPoSentNow({ id: d.id, how: "phoned" }, people.main as never));
      expect(e.data?.poOverlap).toEqual([msg]);
      expect(e.message).toContain("Change the PO first, or the main admin marks it anyway with a reason.");
      expect((await poRow(d.id)).status).toBe("draft");
      await no(m().purchasing.markPoSentNow({ id: d.id, how: "phoned", overlapOverride: { reason: "Supplier has cut it already" } }, people.admin2 as never), "Only the main admin can send a PO past a stock overlap.");
      await no(m().purchasing.markPoSentNow({ id: d.id, how: "phoned", overlapOverride: { reason: "ok" } }, people.main as never), "Say why it is OK to send it as it is.");
      expect((await poRow(d.id)).status).toBe("draft");
      expect((await overrides(d.id)).length).toBe(0);
      const ok = await m().purchasing.markPoSentNow({ id: d.id, how: "phoned", overlapOverride: { reason: "Supplier has already cut the 100 m², keep it" } }, people.main as never);
      expect(ok.overridden).toEqual([msg]);
      expect((await poRow(d.id)).status).toBe("sent");
      const log = await overrides(d.id);
      expect(log.length).toBe(1);
      expect(log[0]!.actorName).toBe(people.main.name);
      expect(log[0]!.detail).toContain("marked sent past a stock overlap. Reason: Supplier has already cut the 100 m², keep it.");
      expect((await linesOf(d.id))[0]!.qty).toBe(100);
      facts.a2bOverlapMark = { refused: msg, override: log[0]!.detail };
    });

    test("job PO, Send: refused before any email; corrected draft then goes without an override", async () => {
      const sup = await supplier("TEST ONLY Overlap Send");
      await db().update(schema.suppliers).set({ email: "orders@overlap-send-test.invalid" }).where(eq(schema.suppliers.id, sup.id));
      const p = await product({ supplierId: sup.id, category: "carpet" });
      const roll = await item(p.id, { qty: 10 });
      const { job: jb } = await job({ quoteTotal: 3000, percent: 0, accepted: true });
      const mat = await material(jb.id, p.id, 100);
      const d = await jobPo(jb.id, sup.id, [{ jobMaterialId: mat.id, productId: p.id, qty: 100, unit: "m2", unitCost: 20 }]);
      await m().holds.allocate({ jobId: jb.id, itemId: roll.id, orderedQty: 40, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const before = outside.supplierMail.length;
      const e = await errOf(m().purchasing.sendPoNow({ id: d.id, saveEmail: false }, people.main as never));
      expect(e.data?.poOverlap?.length).toBe(1);
      expect(e.message).toContain("Change the PO first, or the main admin sends it anyway with a reason.");
      expect(outside.supplierMail.length).toBe(before);
      expect((await poRow(d.id)).status).toBe("draft");
      // The office takes the 40 m² off (60 left), then Send works with no override.
      const [l] = await linesOf(d.id);
      await db().update(schema.purchaseOrderLines).set({ qty: 60, totalExGst: 1200 }).where(eq(schema.purchaseOrderLines.id, l!.id));
      await db().update(schema.purchaseOrders).set({ totalExGst: 1200, goodsExGst: 1200 }).where(eq(schema.purchaseOrders.id, d.id));
      const r = await m().purchasing.sendPoNow({ id: d.id, saveEmail: false }, people.main as never);
      expect(r.overridden).toEqual([]);
      expect(outside.supplierMail.length).toBe(before + 1);
      expect((await poRow(d.id)).status).toBe("sent");
      expect((await overrides(d.id)).length).toBe(0);
    });

    test("warehouse PO: a job share whose shortage is no longer open stops Send and Mark sent", async () => {
      const sup = await supplier("TEST ONLY Warehouse Overlap");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "TEST Grout 5 kg" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 0, reorderQty: 0, stockUnitLabel: "tubs", costPrice: 12, leadTimeDays: 2 });
      const a = await job({ quoteTotal: 900, percent: 0, accepted: true });
      const mat = await material(a.job.id, p.id, 8, "each", "Grout");
      const s = await m().holds.allocate({ jobId: a.job.id, itemId: null, productId: p.id, orderedQty: 8, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const { po, link } = await m().warehousePo.addShortageToWarehouse(s.hold.id, people.main);
      // Stock turned up for the job another way (set directly here: the hold is no longer short).
      await db().update(schema.stockReservations).set({ status: "reserved" }).where(eq(schema.stockReservations.id, s.hold.id));
      const want = `${po.number} still orders 8 tubs for job ${a.job.number}, but the job now has it from stock. Take the job share off the draft before sending it.`;
      expect(await m().poGate.poSendOverlaps(po.id)).toEqual([want]);
      const e = await errOf(m().purchasing.markPoSentNow({ id: po.id, how: "phoned" }, people.main as never));
      expect(e.data?.poOverlap).toEqual([want]);
      const e2 = await errOf(m().purchasing.sendPoNow({ id: po.id, to: "orders@warehouse-overlap-test.invalid", saveEmail: true }, people.main as never));
      expect(e2.data?.poOverlap).toEqual([want]);
      expect((await poRow(po.id)).status).toBe("draft");
      // A refused send changes nothing: the typed email is not saved on the supplier.
      const [supAfter] = await db().select().from(schema.suppliers).where(eq(schema.suppliers.id, sup.id));
      expect(supAfter!.email ?? null).not.toBe("orders@warehouse-overlap-test.invalid");
      await m().warehousePo.removeShortageLink(link.id, people.main);
      expect(await m().poGate.poSendOverlaps(po.id)).toEqual([]);
      facts.a2bOverlapWarehouse = want;
    });
  });

  /* ======================= container-only shortage ======================= */

  describe("A2 follow-up: container shortage on Raise invoice now", () => {
    test("refused until the main admin approves; then one invoice, no PO, never Fully reserved", async () => {
      const sup = await supplier("TEST ONLY Container Importer");
      const p = await product({ supplierId: sup.id, category: "carpet", unit: "lm", widthM: 4, name: "TEST Imported Loop" });
      await setSupply(p.id, { supplyMode: "container" });
      await item(p.id, { qty: 20 });
      const [ct] = await db().insert(schema.contacts).values({ firstName: "Sam", lastName: "Direct", email: "c770001@example.invalid" }).returning();
      const key = rk("sale-direct");
      const input = {
        buyer: { kind: "contact" as const, contactId: ct!.id },
        mode: "invoice" as const,
        lines: [{ productId: p.id, description: "Imported loop carpet", qty: 30, unit: "lm", unitPrice: 100, fromStock: 20 }],
        orderNeeded: true,
        depositPercent: 30,
      };
      const pv = await m().productSale.previewSale({ ...input, requestKey: key });
      expect(pv.supplyShort.length).toBe(1);
      expect(pv.supplyShort[0]!.text).toBe("Stock shortage — owner review required: TEST Imported Loop Grey needs 30 m, 20 m available. 10 m short.");
      const total = (pv as unknown as { total: number }).total;
      await no(m().productSale.raiseSale({ ...input, requestKey: key, expectedTotal: total }, people.office as never), "or the owner approves the shortage first.");
      expect((await db().select().from(schema.productSales)).filter((x) => x.requestKey === key).length).toBe(0);
      await no(m().supplyCheck.approveSupplyShort({ entityType: "sale", entityKey: key, productId: p.id, shortQty: 10, note: "Customer takes 20 now" }, people.office), "Only the main admin can approve a stock shortage.");
      await m().supplyCheck.approveSupplyShort({ entityType: "sale", entityKey: key, productId: p.id, shortQty: 10, note: "Customer agreed to wait for the next container" }, people.main);
      const out = await m().productSale.raiseSale({ ...input, requestKey: key, expectedTotal: total }, people.office as never);
      expect(out.invoice).not.toBeNull();
      expect(out.poDrafts).toEqual([]);
      expect((await db().select().from(schema.purchaseOrders)).filter((x) => x.supplierId === sup.id).length).toBe(0);
      const appr = (await db().select().from(schema.stockSupplyApprovals)).filter((a) => a.entityKey === key);
      expect(appr.map((a) => [a.byName, a.note, a.shortQty])).toEqual([[people.main.name, "Customer agreed to wait for the next container", 10]]);
      const [sale] = await db().select().from(schema.productSales).where(eq(schema.productSales.requestKey, key));
      const hs = await holdsOf(sale!.jobId!);
      expect(m().recheck.reserveStatus(hs)).not.toBe("Fully reserved");
      const pay = await m().pay.stockPayInfo(out.invoice!.id, out.invoice!.total);
      facts.a2bDirect = {
        preview: pv.supplyShort[0]!.text,
        refused: true,
        approvedBy: people.main.name,
        invoice: out.invoice!.number,
        poDrafts: out.poDrafts,
        holds: hs.map((x) => [x.status, x.qty]),
        status: m().recheck.reserveStatus(hs),
        payLabel: pay?.stockLabel ?? null,
      };
      if (hs.some((x) => x.status === "short") && pay) expect(pay.stockLabel).toBe(m().pay.PART_SHORT_LABEL);
    });
  });

  describe("A2 follow-up: quote sent with stock, stock taken, then the customer accepts and pays", () => {
    let carpet: Prod;
    let qj: Awaited<ReturnType<typeof job>>;
    let sup: Awaited<ReturnType<typeof supplier>>;
    test("at send: enough stock, nothing to approve", async () => {
      sup = await supplier("TEST ONLY Container Two");
      const p = await product({ supplierId: sup.id, category: "carpet", unit: "lm", widthM: 4, name: "TEST Imported Twist" });
      carpet = await setSupply(p.id, { supplyMode: "container" });
      await item(p.id, { qty: 30 });
      qj = await job({ quoteTotal: 4400, percent: 30, items: [{ productId: p.id, description: "Imported twist carpet", qty: 120, unit: "m2" }] });
      expect(qj.quote!.status).toBe("sent");
      const at = await m().supplyCheck.supplyShorts(await m().supplyCheck.quoteSupplyLines(qj.quote!.id), qj.job.id, { entityType: "quote", entityKey: String(qj.quote!.id) });
      expect(at).toEqual([]);
    });

    test("another order takes 20 m: online accept refused with a plain message, office told once, quote unchanged", async () => {
      const other = await job({ quoteTotal: 2000, percent: 0, accepted: true });
      const mat = await material(other.job.id, carpet.id, 80, "m2", "Carpet");
      const roll = (await db().select().from(schema.stockItems).where(eq(schema.stockItems.productId, carpet.id)))[0]!;
      await m().holds.allocate({ jobId: other.job.id, itemId: roll.id, orderedQty: 80, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const pushes = outside.push.length;
      const e = await errOf(m().quoteAccept.acceptQuote({ quoteId: qj.quote!.id, actor: { name: "Pat Tester", role: "customer" }, via: "online" }));
      expect(e.message).toBe(m().quoteAccept.ACCEPT_SHORT_CUSTOMER);
      expect(e.message).not.toMatch(/\d+ m\b|stock|container/i);
      const [q] = await db().select().from(schema.quotes).where(eq(schema.quotes.id, qj.quote!.id));
      expect(q!.status).toBe("sent");
      expect((await db().select().from(schema.invoices)).filter((i) => i.jobId === qj.job.id).length).toBe(0);
      const al = (await db().select().from(schema.stockAlerts)).filter((a) => a.key === `accept-short:${qj.quote!.id}:${carpet.id}`);
      expect(al.length).toBe(1);
      expect(al[0]!.kind).toBe("stock_accept_short");
      expect(al[0]!.body).toContain("needs 30 m, 10 m available. 20 m short.");
      expect(al[0]!.body).toContain("The customer was told the office will contact them.");
      expect(outside.push.length).toBe(pushes + 1);
      // A second try does not alert again.
      await errOf(m().quoteAccept.acceptQuote({ quoteId: qj.quote!.id, actor: { name: "Pat Tester", role: "customer" }, via: "online" }));
      expect((await db().select().from(schema.stockAlerts)).filter((a) => a.key === `accept-short:${qj.quote!.id}:${carpet.id}`).length).toBe(1);
      facts.a2bAccept = { customer: e.message, officeTitle: al[0]!.title, officeBody: al[0]!.body };
    });

    test("staff accept refused too; after the main admin approves, it accepts, with no PO", async () => {
      await no(m().quoteAccept.acceptQuote({ quoteId: qj.quote!.id, actor: { name: people.office.name, role: "office" }, via: "staff" }), "or the owner approves the shortage first.");
      await m().supplyCheck.approveSupplyShort({ entityType: "quote", entityKey: String(qj.quote!.id), productId: carpet.id, shortQty: 20, note: "Customer agreed to wait for the next container" }, people.main);
      const out = await m().quoteAccept.acceptQuote({ quoteId: qj.quote!.id, actor: { name: people.office.name, role: "office" }, via: "staff" });
      expect(out.quote.status).toBe("accepted");
      expect((await db().select().from(schema.purchaseOrders)).filter((x) => x.supplierId === sup.id).length).toBe(0);
      facts.a2bAcceptApproved = { invoice: out.invoice?.number ?? null };
    });

    test("deposit paid while short: recorded, office told, no refund, no purchase, never Fully reserved", async () => {
      const mat = await material(qj.job.id, carpet.id, 120, "m2", "Carpet");
      await m().holds.allocate({ jobId: qj.job.id, itemId: null, productId: carpet.id, orderedQty: 120, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const inv = (await db().select().from(schema.invoices)).find((i) => i.jobId === qj.job.id && i.kind === "deposit")!;
      expect(inv).toBeTruthy();
      const paid = await m().ci.markInvoicePaid({ id: inv.id, amount: inv.total, method: "bank", byName: people.office.name, actorRole: "office" });
      await m().orders.confirmForStock(paid.paymentId!, "Bank statement checked", people.main);
      const emailsBefore = outside.email.length;
      await m().recheck.recheckAfterPayment(inv.id);
      const o = (await m().orders.orderOfJob(qj.job.id))!;
      const al = (await db().select().from(schema.stockAlerts)).filter((x) => x.key === `paid-short:${o.id}:${carpet.id}`);
      expect(al.length).toBe(1);
      expect(al[0]!.body).toContain("No refund or purchase has been made.");
      const pays = await paymentsOf(inv.id);
      expect(pays.length).toBe(1);
      expect(pays.every((x) => x.amount > 0)).toBe(true);
      expect((await db().select().from(schema.purchaseOrders)).filter((x) => x.supplierId === sup.id).length).toBe(0);
      const hs = await holdsOf(qj.job.id);
      expect(hs.some((x) => x.status === "short")).toBe(true);
      expect(m().recheck.reserveStatus(hs)).not.toBe("Fully reserved");
      // Nothing to the customer about it.
      expect(outside.email.slice(emailsBefore).filter((x) => /example\.invalid/.test(JSON.stringify(x.to)) && !/^\[Terra Ops\]/.test(String(x.subject))).length).toBe(0);
      facts.a2bPaid = { officeTitle: al[0]!.title, officeBody: al[0]!.body, payments: pays.length, refunds: 0, pos: 0, status: m().recheck.reserveStatus(hs) };
    });
  });
  describe("A2 follow-up: Crew app, part of a line in the warehouse", () => {
    test("only the part firmly held says In the warehouse; the rest says where it is; no money", async () => {
      const sup = await supplier("TEST ONLY Leveller Supplier");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "Leveller 20kg bag" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 2, reorderQty: 10, leadTimeDays: 3, stockUnitLabel: "bags" });
      const it = await item(p.id, { qty: 18, unit: "unit", type: "unit_lot", widthM: null, costPer: "unit", unitCost: 40 });
      const { job: jb, quote } = await job({ quoteTotal: 1000, percent: 30, accepted: true });
      const mat = await material(jb.id, p.id, 26, "each", "Leveller");
      await m().holds.allocate({ jobId: jb.id, itemId: it.id, orderedQty: 18, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      await m().holds.allocate({ jobId: jb.id, itemId: null, productId: p.id, orderedQty: 8, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      const line = async () => (await m().crew.crewMaterials(jb.id, null)).find((x) => x.id === mat.id)!;
      const before = await line();
      const dep = await depositInvoice(jb.id, quote!.id, 300);
      const ev = stripeEvent(dep.id, 300);
      await m().stripe.handleWebhook(ev.body, ev.header);
      const after = await line();
      expect(before.whereLabel).toBe("Not ordered yet");
      expect(after.where).toBe("to_order");
      expect(after.whereLabel).toBe("In the warehouse: 18 bags\nNot ordered yet: 8 bags");
      expect(after.count).toBe("26 bags");
      expect(JSON.stringify(after)).not.toMatch(/\$|cost|price|paid|deposit|invoice/i);
      facts.a2bCrew = { before: before.whereLabel, after: after.whereLabel, count: after.count };
    });
  });
}
