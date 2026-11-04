/**
 * Warehouse stock, Amendment 2 tests (7G). Registered from stock.test.ts so
 * they share its throwaway database and run after the Step A and A1 tests.
 * Nothing leaves the machine: fetch is blocked, mail and pushes are captured.
 *
 * Run from packages/web:  bun test scripts/stock
 */
import { describe, expect, test } from "bun:test";
import { costsOf, depositInvoice, holdsOf, item, job, m, paymentsOf, people, product, rk, schema, supplier } from "./harness";

type Helpers = {
  no: (p: Promise<unknown>, text: string) => Promise<void>;
  eq: (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => ReturnType<ReturnType<typeof m>["drizzle"]["eq"]>;
  facts: Record<string, unknown>;
  material: (jobId: number, productId: number, qty: number, unit?: string, description?: string) => Promise<typeof schema.jobMaterials.$inferSelect>;
};

type Prod = typeof schema.products.$inferSelect;

export function registerA2(h: Helpers) {
  const { no, eq, facts, material } = h;

  const prod = async (id: number) => (await m().db.select().from(schema.products).where(eq(schema.products.id, id)))[0]!;
  const setSupply = async (id: number, s: Partial<Prod>) => {
    await m()
      .db.update(schema.products)
      .set({ stockTracked: true, supplySetAt: new Date(), supplySetBy: "Test", ...s })
      .where(eq(schema.products.id, id));
    return prod(id);
  };
  const nums = async (id: number) => (await m().replenish.productNumbers([await prod(id)])).get(id)!;
  const state = async (id: number) => m().replenish.supplyState(await prod(id), await nums(id));
  const bags = (productId: number, qty: number, unitCost = 30) => item(productId, { qty, unit: "unit", type: "unit_lot", costPer: "unit", unitCost, widthM: null, batch: null });
  const poRow = async (id: number) => (await m().db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)))[0]!;
  const linesOf = async (poId: number) => m().db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  const goodsLine = async (poId: number, productId: number) => (await linesOf(poId)).find((l) => l.kind === "goods" && l.productId === productId)!;
  const stockCost = async (jobId: number) => (await costsOf(jobId)).filter((r) => r.source === "stock").reduce((s, r) => s + r.amount, 0);
  const cash = async (poNumber: string) => {
    await m().cashflow.rebuildForecast();
    return (await m().db.select().from(schema.cashEvents)).filter((e) => e.label.includes(poNumber));
  };
  const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;

  /* =============================== S6 ================================== */

  describe("A2 S6 Low-stock alerts and warehouse orders", () => {
    test("off by default, Admin only, needs S1", async () => {
      expect((await m().core.switches()).s6.state).toBe("off");
      await no(m().core.setSwitch("s6", "on", people.office), "Only an Admin can change the stock switches.");
      await m().core.setSwitch("s6", "on", people.main);
      expect((await m().core.switches()).s6.state).toBe("on");
    });
  });

  /* ======================= 7A low now / another order ======================= */

  let lowSup: Awaited<ReturnType<typeof supplier>>;
  let leveller: Prod;
  let lowPo: typeof schema.purchaseOrders.$inferSelect;

  describe("7A low stock now, enough already ordered", () => {
    test("10 available, reorder level 20: low now and another order needed, alerted once", async () => {
      lowSup = await supplier("Leveller Supplier");
      const p = await product({ supplierId: lowSup.id, category: "accessory", unit: "each", name: "Leveller 20kg" });
      leveller = await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 20, reorderQty: 50, reorderMethod: "fixed", stockUnitLabel: "bags", lowStockAlerts: true, leadTimeDays: 5, costPrice: 30 });
      await bags(p.id, 10);
      const st = await state(p.id);
      expect(st.lowNow).toBe(true);
      expect(st.needMore).toBe(true);
      expect(st.suggestStock).toBe(50);
      expect(st.text[0]).toBe("Low stock now: 10 bags available. Another order needed: 50 bags for general warehouse stock.");
      expect((await m().replenish.checkLowAlerts([p.id])).sent).toBe(1);
      expect((await m().replenish.checkLowAlerts([p.id])).sent).toBe(0);
      expect((await state(p.id)).lowNow).toBe(true);
      const alerts = (await m().db.select().from(schema.stockAlerts)).filter((a) => a.key.startsWith(`low:${p.id}:`));
      expect(alerts.length).toBe(1);
      expect(alerts[0]!.kind).toBe("stock_low");
    });

    test("a draft is proposed, not incoming; pressing again keeps one draft", async () => {
      await no(m().warehousePo.draftSuggestions(lowSup.id, null, people.office), "Warehouse orders are Admin only.");
      const a = await m().warehousePo.draftSuggestions(lowSup.id, null, people.main);
      expect(a.po!.number).toMatch(/^PO-W\d{4}$/);
      expect(a.changed).toEqual(["Test Leveller 20kg Grey: 50 bags"]);
      const b = await m().warehousePo.draftSuggestions(lowSup.id, null, people.main);
      expect(b.po!.id).toBe(a.po!.id);
      expect(b.changed).toEqual([]);
      lowPo = a.po!;
      const n = await nums(leveller.id);
      expect([n.draftFree, n.incomingFree, n.incomingJob]).toEqual([50, 0, 0]);
      const st = await state(leveller.id);
      expect(st.needMore).toBe(false);
      expect(st.text[0]).toBe(`Low stock now: 10 bags available. 50 bags on draft ${lowPo.number} — not sent yet. No additional purchase currently suggested.`);
      const drafts = (await m().db.select().from(schema.purchaseOrders)).filter((x) => x.kind === "warehouse" && x.supplierId === lowSup.id);
      expect(drafts.length).toBe(1);
    });

    test("sent: 50 ordered — awaiting receipt, no further suggestion, no second alert", async () => {
      await m().po.commitPo(lowPo.id, "other", "phoned");
      const n = await nums(leveller.id);
      expect([n.available, n.incomingFree, n.draftFree]).toEqual([10, 50, 0]);
      const st = await state(leveller.id);
      expect(st.lowNow).toBe(true);
      expect(st.needMore).toBe(false);
      expect(st.text[0]).toBe("Low stock now: 10 bags available. 50 bags ordered — awaiting receipt. No additional purchase currently suggested.");
      const again = await m().warehousePo.draftSuggestions(lowSup.id, null, people.main);
      expect(again.po).toBeNull();
      expect(again.changed).toEqual([]);
      expect((await m().replenish.checkLowAlerts([leveller.id])).sent).toBe(0);
      facts.a2low = st.text[0];
    });
  });

  /* ============================ 7C min / multiple ============================ */

  describe("7C minimum and multiple", () => {
    test("min 5, multiple 4 gives 8; zero stays zero; pallets convert", () => {
      const r = m().replenish.roundOrder;
      expect(r(3, { reorderMinQty: 5, orderMultiple: 4, stockPerPurchase: null })).toEqual({ purchaseQty: 8, stockQty: 8 });
      expect(r(0, { reorderMinQty: 5, orderMultiple: 4, stockPerPurchase: null })).toEqual({ purchaseQty: 0, stockQty: 0 });
      expect(r(9, { reorderMinQty: 5, orderMultiple: 4, stockPerPurchase: null })).toEqual({ purchaseQty: 12, stockQty: 12 });
      expect(r(45, { reorderMinQty: null, orderMultiple: null, stockPerPurchase: 20 })).toEqual({ purchaseQty: 3, stockQty: 60 });
      facts.a2round = { "3 (min 5, x4)": 8, "0": 0, "9 (min 5, x4)": 12, "45 bags, 20 a pallet": "3 pallets = 60" };
    });

    test("on the draft: a suggestion of 3 goes on as 8, an edit to 9 becomes 12", async () => {
      const sup = await supplier("Grout Supplier");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "Grout 5kg" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 2, reorderQty: 3, reorderMinQty: 5, orderMultiple: 4, stockUnitLabel: "bags", costPrice: 12, leadTimeDays: 3 });
      const st = await state(p.id);
      expect(st.suggestStock).toBe(8);
      const d = await m().warehousePo.draftSuggestions(sup.id, null, people.main);
      expect((await goodsLine(d.po!.id, p.id)).qty).toBe(8);
      const e = await m().warehousePo.editDraftLine({ poId: d.po!.id, productId: p.id, generalQty: 9 }, people.main);
      expect(e.rounded).toBe(12);
      expect((await goodsLine(d.po!.id, p.id)).qty).toBe(12);
      expect((await poRow(d.po!.id)).totalExGst).toBe(144);
      const z = await m().warehousePo.editDraftLine({ poId: d.po!.id, productId: p.id, generalQty: 0 }, people.main);
      expect(z.line).toBeNull();
    });
  });

  /* ======================== decision 1: route A and B ======================== */

  let adh: Prod;
  let adhSup: Awaited<ReturnType<typeof supplier>>;
  let jobB: Awaited<ReturnType<typeof job>>;
  let shortB: typeof schema.stockReservations.$inferSelect;
  let wPo: typeof schema.purchaseOrders.$inferSelect;

  describe("decision 1: one shortage each way, never ordered twice", () => {
    test("route A, the job's own PO: counted once, refused on a warehouse order", async () => {
      adhSup = await supplier("Adhesive Supplier");
      const p = await product({ supplierId: adhSup.id, category: "accessory", unit: "each", name: "Adhesive 15L" });
      adh = await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 5, reorderQty: 40, stockUnitLabel: "bags", costPrice: 40, leadTimeDays: 10 });
      const a = await job({ quoteTotal: 2000, percent: 0, accepted: true });
      const mat = await material(a.job.id, p.id, 20, "each", "Adhesive");
      const s = await m().holds.allocate({ jobId: a.job.id, itemId: null, productId: p.id, orderedQty: 20, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      expect(s.hold.status).toBe("short");
      expect((await nums(p.id)).shortUncovered).toBe(20);
      await no(m().warehousePo.shortageToJobPo(s.hold.id, people.office), "Warehouse orders are Admin only.");
      const r = await m().warehousePo.shortageToJobPo(s.hold.id, people.main);
      expect(r.drafted.length).toBe(1);
      const n = await nums(p.id);
      expect([n.shortOnJobPo, n.shortUncovered, n.shortLinked]).toEqual([20, 0, 0]);
      await no(m().warehousePo.addShortageToWarehouse(s.hold.id, people.main), `Already on draft ${r.drafted[0]}`);
      // Sent: flagged for review, the supplier order is not changed.
      const [jp] = await m().db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.number, r.drafted[0]!));
      const before = await linesOf(jp!.id);
      await m().db.update(schema.purchaseOrders).set({ status: "sent", sentAt: new Date() }).where(eq(schema.purchaseOrders.id, jp!.id));
      await no(m().warehousePo.addShortageToWarehouse(s.hold.id, people.main), `Already on ${jp!.number}, which has been sent. Nothing changed.`);
      const flag = (await m().db.select().from(schema.stockAlerts)).filter((x) => x.key === `on-sent-po:${s.hold.id}:${jp!.id}`);
      expect(flag.length).toBe(1);
      expect(flag[0]!.kind).toBe("stock_on_sent_po");
      expect((await linesOf(jp!.id)).map((l) => [l.qty, l.totalExGst])).toEqual(before.map((l) => [l.qty, l.totalExGst]));
      expect((await poRow(jp!.id)).status).toBe("sent");
      // Nothing for this shortage went on a warehouse order.
      expect((await m().db.select().from(schema.stockPoLinks)).filter((k) => k.reservationId === s.hold.id).length).toBe(0);
      facts.a2routeA = { jobPo: jp!.number, flagged: 1, warehouseLinks: 0 };
    });

    test("route B, the warehouse order: kept for the job, never also on a job PO", async () => {
      jobB = await job({ quoteTotal: 2000, percent: 0, accepted: true });
      const mat = await material(jobB.job.id, adh.id, 20, "each", "Adhesive");
      const s = await m().holds.allocate({ jobId: jobB.job.id, itemId: null, productId: adh.id, orderedQty: 20, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      shortB = s.hold;
      await no(m().warehousePo.addShortageToWarehouse(s.hold.id, people.office), "Warehouse orders are Admin only.");
      const r = await m().warehousePo.addShortageToWarehouse(s.hold.id, people.main);
      expect(r.reused).toBe(false);
      expect(r.link.qty).toBe(20);
      wPo = r.po;
      expect((await goodsLine(wPo.id, adh.id)).qty).toBe(20);
      const again = await m().warehousePo.addShortageToWarehouse(s.hold.id, people.main);
      expect(again.reused).toBe(true);
      expect((await goodsLine(wPo.id, adh.id)).qty).toBe(20);
      expect((await m().db.select().from(schema.stockPoLinks)).filter((k) => k.reservationId === s.hold.id).length).toBe(1);
      // The job's own PO helper leaves it out; route A is refused while it is on the warehouse order.
      expect((await m().poHelper.draftPosForJob({ jobId: jobB.job.id, quoteRef: "Q-test" })).drafted.length).toBe(0);
      await no(m().warehousePo.shortageToJobPo(s.hold.id, people.main), "This shortage is on a warehouse order. Take it off there first.");
      const n = await nums(adh.id);
      expect([n.shortLinked, n.draftJob, n.draftFree, n.shortUncovered, n.incomingJob]).toEqual([20, 20, 0, 0, 0]);
    });

    test("general stock added beside it: 20 for the job + 40 for the warehouse, one line, one draft", async () => {
      const d = await m().warehousePo.draftSuggestions(adhSup.id, null, people.main);
      expect(d.po!.id).toBe(wPo.id);
      expect((await goodsLine(wPo.id, adh.id)).qty).toBe(60);
      expect((await m().warehousePo.draftSuggestions(adhSup.id, null, people.main)).changed).toEqual([]);
      expect((await goodsLine(wPo.id, adh.id)).qty).toBe(60);
      const view = (await m().warehousePo.warehouseOrders()).find((o) => o.id === wPo.id)!;
      expect(view.lines[0]!.split).toBe(`20 bags expected for Job ${jobB.job.number} + 40 bags for general warehouse stock`);
      expect(view.lines[0]!.generalQty).toBe(40);
      expect(view.lines[0]!.jobQty).toBe(20);
      expect((await poRow(wPo.id)).totalExGst).toBe(2400);
      expect(await stockCost(jobB.job.id)).toBe(0);
      facts.a2split = view.lines[0]!.split;
    });

    test("a shortage the job no longer needs can be withdrawn, but not while it is on a warehouse order", async () => {
      await no(m().holds.releaseHold(shortB.id, "Job changed", people.office), `This shortage is on draft ${wPo.number}`);
      const c = await job({ quoteTotal: 2000, percent: 0, accepted: true });
      const mat = await material(c.job.id, adh.id, 6, "each", "Adhesive");
      const s = await m().holds.allocate({ jobId: c.job.id, itemId: null, productId: adh.id, orderedQty: 6, lineUnit: "each", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      expect((await nums(adh.id)).shortUncovered).toBe(6);
      const r = await m().holds.releaseHold(s.hold.id, "Customer dropped the adhesive", people.office);
      expect(r.status).toBe("released");
      expect((await nums(adh.id)).shortUncovered).toBe(0);
      expect((await goodsLine(wPo.id, adh.id)).qty).toBe(60);
      facts.a2withdraw = { draftRefused: true, released: 6 };
    });
  });

  /* ======================= 7B split order, part receipts ======================= */

  describe("7B incoming: job share and general kept apart, part receipts", () => {
    test("sent: 20 incoming for the job, 40 incoming general, nothing available yet", async () => {
      await m().po.commitPo(wPo.id, "other", "phoned");
      const n = await nums(adh.id);
      expect([n.physical, n.available, n.incomingJob, n.incomingFree, n.draftJob, n.draftFree]).toEqual([0, 0, 20, 40, 0, 0]);
      expect((await state(adh.id)).needMore).toBe(false);
      // Sent warehouse POs are not changed on the Reorder list.
      await no(m().warehousePo.editDraftLine({ poId: wPo.id, productId: adh.id, generalQty: 10 }, people.main), "has gone to the supplier");
      await no(m().holds.releaseHold(shortB.id, "Job changed", people.main), `This shortage is on ${wPo.number}, which has been sent. The order is not changed from here.`);
    });

    test("12 arrive: all 12 to the job, costed once at $480; 8 still to come for it", async () => {
      const line = await goodsLine(wPo.id, adh.id);
      const key = rk("recv");
      const got = await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 12 }], requestKey: key }, people.office);
      expect(got.items.length).toBe(1);
      const [k] = await m().db.select().from(schema.stockPoLinks).where(eq(schema.stockPoLinks.reservationId, shortB.id));
      expect([k!.receivedQty, k!.status]).toEqual([12, "open"]);
      const hs = await holdsOf(jobB.job.id);
      const onItem = hs.filter((x) => x.stockItemId === got.items[0]!.id);
      expect(onItem.length).toBe(1);
      expect(onItem[0]!.qty).toBe(12);
      expect(onItem[0]!.status).toBe("reserved");
      expect(hs.find((x) => x.id === shortB.id)!.qty).toBe(8);
      const n = await nums(adh.id);
      expect([n.physical, n.committed, n.available, n.incomingJob, n.incomingFree, n.shortLinked, n.shortUncovered]).toEqual([12, 12, 0, 8, 40, 8, 0]);
      expect(await stockCost(jobB.job.id)).toBe(480);
      const again = await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 12 }], requestKey: key }, people.office);
      expect(again.reused).toBe(true);
      expect(await stockCost(jobB.job.id)).toBe(480);
      expect((await goodsLine(wPo.id, adh.id)).receivedQty).toBe(12);
    });

    test("18 more: the job's 20 are complete ($800 once), 10 general on the shelf, 30 still to come", async () => {
      const line = await goodsLine(wPo.id, adh.id);
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 18 }], requestKey: rk("recv") }, people.office);
      const [k] = await m().db.select().from(schema.stockPoLinks).where(eq(schema.stockPoLinks.reservationId, shortB.id));
      expect([k!.receivedQty, k!.status]).toEqual([20, "received"]);
      const hs = await holdsOf(jobB.job.id);
      expect(hs.find((x) => x.id === shortB.id)!.status).toBe("released");
      expect(hs.filter((x) => x.status === "reserved").reduce((s, x) => s + x.qty, 0)).toBe(20);
      const n = await nums(adh.id);
      expect([n.physical, n.committed, n.available, n.incomingJob, n.incomingFree, n.shortLinked]).toEqual([30, 20, 10, 0, 30, 0]);
      expect(await stockCost(jobB.job.id)).toBe(800);
      facts.a2receipts = { after12: { job: 12, jobStillToCome: 8, general: 40 }, after30: { job: 20, generalOnShelf: 10, generalStillToCome: 30 }, jobCost: 800, poTotal: 2400 };
    });

    test("the supplier will not send the rest: closed, it stops counting as incoming", async () => {
      const line = await goodsLine(wPo.id, adh.id);
      await no(m().warehousePo.closeLine(line.id, "out of stock", people.office), "Warehouse orders are Admin only.");
      await m().warehousePo.closeLine(line.id, "Supplier out of stock until March", people.main);
      const n = await nums(adh.id);
      expect([n.incomingFree, n.incomingJob]).toEqual([0, 0]);
      await no(m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 5 }], requestKey: rk("recv") }, people.office), "This line was closed.");
      expect(await stockCost(jobB.job.id)).toBe(800);
    });
  });

  /* ===================== decision 3: forecast, bill, payment ===================== */

  describe("decision 3: one warehouse PO through the forecast, bill and payment", () => {
    test("draft, sent with a supplier deposit, part bill, payments: never counted twice", async () => {
      const sup = await supplier("Forecast Supplier");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "Primer 10L" });
      await setSupply(p.id, { supplyMode: "reorder", reorderLevel: 1, reorderQty: 10, stockUnitLabel: "pails", costPrice: 100, leadTimeDays: 2 });
      const d = await m().warehousePo.draftSuggestions(sup.id, null, people.main);
      const po = d.po!;
      expect(po.totalExGst).toBe(1000);
      const steps: Record<string, unknown> = {};

      // Draft, no terms, no date: flagged, never dated.
      expect(await cash(po.number)).toEqual([]);
      expect((await m().warehouseCash.warehouseUndated()).find((u) => u.poId === po.id)!.why).toBe(m().warehouseCash.UNDATED_TEXT);
      // Draft with supplier terms: a planned purchase, not committed.
      await m().db.update(schema.suppliers).set({ termsDays: 30, termsEom: false }).where(eq(schema.suppliers.id, sup.id));
      let ev = await cash(po.number);
      expect(ev.map((e) => [e.confidence, e.amount])).toEqual([["pipeline", 1100]]);
      expect(ev[0]!.label.startsWith(`Planned purchase (draft) ${po.number}`)).toBe(true);
      steps.draft = { planned: 1100, committed: 0 };

      // Sent, with a supplier deposit and an expected payment date.
      await m().warehousePo.editWarehouseTerms({ poId: po.id, supplierDepositExGst: 300, supplierDepositDue: "2026-12-01", expectedPayDate: "2026-12-20" }, people.main);
      await m().po.commitPo(po.id, "other", "portal");
      ev = await cash(po.number);
      expect(ev.map((e) => [e.confidence, e.amount, e.dueDate]).sort()).toEqual([
        ["committed", 330, "2026-12-01"],
        ["committed", 770, "2026-12-20"],
      ]);
      steps.sent = { deposit: 330, balance: 770, total: sum(ev) };

      // No date and no terms: the balance is flagged, not given a made-up date.
      await m().db.update(schema.suppliers).set({ termsDays: null }).where(eq(schema.suppliers.id, sup.id));
      await m().warehousePo.editWarehouseTerms({ poId: po.id, expectedPayDate: "" }, people.main);
      ev = await cash(po.number);
      expect(ev.map((e) => e.amount)).toEqual([330]);
      expect((await m().warehouseCash.warehouseUndated()).filter((u) => u.poId === po.id).map((u) => [u.part, u.amountIncGst])).toEqual([["balance", 770]]);
      await m().warehousePo.editWarehouseTerms({ poId: po.id, expectedPayDate: "2026-12-20" }, people.main);

      // Receiving adds nothing.
      const line = await goodsLine(po.id, p.id);
      const beforeRecv = sum(await cash(po.number));
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 10 }], requestKey: rk("recv") }, people.office);
      expect(sum(await cash(po.number))).toBe(beforeRecv);
      expect(beforeRecv).toBe(1100);

      // A part bill replaces only its share.
      const bill = async (n: string, ex: number, due: string) => {
        const [row] = await m()
          .db.insert(schema.supplierInvoices)
          .values({ supplierId: sup.id, invoiceNumber: n, dedupeKey: `${sup.id}|${n}`, poId: po.id, totalExGst: ex, gst: ex / 10, totalIncGst: Math.round(ex * 110) / 100, dueDate: due })
          .returning();
        await m().match.settlePo(po.id);
        return row!;
      };
      const b1 = await bill("INV-A1", 400, "2026-12-10");
      ev = await cash(po.number);
      expect(ev.map((e) => [e.amount, e.dueDate]).sort()).toEqual([
        [440, "2026-12-10"],
        [660, "2026-12-20"],
      ]);
      expect(sum(ev)).toBe(1100);
      steps.partBill = { bill: 440, rest: 660, total: sum(ev) };

      // Paid: drops out. What is left is the rest.
      await m().match.markPaid(b1.id, "Paid in the test");
      ev = await cash(po.number);
      expect(ev.map((e) => e.amount)).toEqual([660]);
      steps.firstPaid = { left: sum(ev) };

      const b2 = await bill("INV-A2", 600, "2026-12-22");
      ev = await cash(po.number);
      expect(ev.map((e) => [e.amount, e.dueDate])).toEqual([[660, "2026-12-22"]]);
      await m().match.markPaid(b2.id, "Paid in the test");
      expect(await cash(po.number)).toEqual([]);
      steps.allPaid = { left: 0, paidInTotal: 1100 };
      // No job carries any of it.
      expect((await m().db.select().from(schema.jobCosts)).filter((c) => (c.description ?? "").includes(po.number)).length).toBe(0);
      facts.a2cash = steps;
    });
  });

  /* ======================= 7D imported carpet, stock only ======================= */

  let carpet: Prod;
  let carpetSup: Awaited<ReturnType<typeof supplier>>;

  describe("7D imported carpet (container) and stock-only products", () => {
    test("quote short: shown before sending, only the main admin can approve, with a note", async () => {
      carpetSup = await supplier("Carpet Importer");
      const p = await product({ supplierId: carpetSup.id, category: "carpet", unit: "lm", widthM: 4, name: "Baltimore Imported" });
      carpet = await setSupply(p.id, { supplyMode: "container", reorderLevel: 25 });
      await item(p.id, { qty: 12 });
      await item(p.id, { qty: 8 });
      const ent = { entityType: "quote" as const, entityKey: "a2-quote-1" };
      const lines = [{ productId: p.id, qty: 120, unit: "m2" }];
      const s = await m().supplyCheck.supplyShorts(lines, null, ent);
      expect(s.length).toBe(1);
      expect([s[0]!.need, s[0]!.available, s[0]!.short, s[0]!.label]).toEqual([30, 20, 10, "Stock shortage — owner review required"]);
      expect(s[0]!.text).toBe("Stock shortage — owner review required: Test Baltimore Imported Grey needs 30 m, 20 m available. 10 m short.");
      await no(m().supplyCheck.assertSupplyOk(lines, null, ent), "or the owner approves the shortage first.");
      await no(m().supplyCheck.approveSupplyShort({ ...ent, productId: p.id, shortQty: 10, note: "Customer will wait" }, people.office), "Only the main admin can approve a stock shortage.");
      await no(m().supplyCheck.approveSupplyShort({ ...ent, productId: p.id, shortQty: 10, note: "ok" }, people.main), "Say why it is OK to go ahead short.");
      await m().supplyCheck.approveSupplyShort({ ...ent, productId: p.id, shortQty: 10, note: "Customer agreed to wait for the next container" }, people.main);
      const ok = await m().supplyCheck.assertSupplyOk(lines, null, ent);
      expect(ok[0]!.approved!.note).toBe("Customer agreed to wait for the next container");
      // A bigger shortage than approved needs approving again.
      await no(m().supplyCheck.assertSupplyOk([{ productId: p.id, qty: 160, unit: "m2" }], null, ent), "20 m short.");
      facts.a2quoteShort = s[0]!.text;
    });

    test("never reordered, never incoming, no small job top-up PO", async () => {
      const st = await state(carpet.id);
      expect(st.lowNow).toBe(true);
      expect(st.needMore).toBe(false);
      expect(st.suggestStock).toBe(0);
      expect(st.text[0]).toBe("Low stock — owner review required for bulk/container replenishment.");
      const d = await m().warehousePo.draftSuggestions(carpetSup.id, null, people.main);
      expect([d.po, d.changed]).toEqual([null, []]);
      const jb = await job({ quoteTotal: 3000, percent: 30, accepted: true });
      const mat = await material(jb.job.id, carpet.id, 120, "m2", "Carpet");
      const s = await m().holds.allocate({ jobId: jb.job.id, itemId: null, productId: carpet.id, orderedQty: 120, lineUnit: "m2", jobMaterialId: mat.id, requestKey: rk() }, people.office);
      expect(s.hold.status).toBe("short");
      const n = await nums(carpet.id);
      expect([n.shortUncovered, n.incomingJob, n.incomingFree]).toEqual([30, 0, 0]);
      await no(m().warehousePo.addShortageToWarehouse(s.hold.id, people.main), "Container and stock-only products are not reordered here. Owner review.");
      await no(m().warehousePo.shortageToJobPo(s.hold.id, people.main), "Container and stock-only products are not ordered for one job. Owner review.");
      expect((await m().poHelper.draftPosForJob({ jobId: jb.job.id, quoteRef: "Q-test" })).drafted.length).toBe(0);
      const crew = await m().crew.crewMaterials(jb.job.id, null);
      expect(crew.find((c) => c.id === mat.id)!.whereLabel).toBe("Stock shortage — owner review required");

      // The deposit comes in before anyone sorts it out: recorded, alerted, no refund, no purchase.
      const inv = await depositInvoice(jb.job.id, jb.quote!.id, 900);
      const paid = await m().ci.markInvoicePaid({ id: inv.id, amount: 900, method: "bank", byName: people.office.name, actorRole: "office" });
      await m().orders.confirmForStock(paid.paymentId!, "Bank statement checked", people.main);
      await m().recheck.recheckAfterPayment(inv.id);
      const o = (await m().orders.orderOfJob(jb.job.id))!;
      const al = (await m().db.select().from(schema.stockAlerts)).filter((x) => x.key === `paid-short:${o.id}:${carpet.id}`);
      expect(al.length).toBe(1);
      expect(al[0]!.body).toContain("The deposit is recorded and stays as it is.");
      expect(al[0]!.body).toContain("No refund or purchase has been made.");
      expect((await paymentsOf(inv.id)).length).toBe(1);
      expect((await m().db.select().from(schema.invoices).where(eq(schema.invoices.id, inv.id)))[0]!.amountPaid).toBe(900);
      expect((await m().db.select().from(schema.purchaseOrders)).filter((x) => x.supplierId === carpetSup.id).length).toBe(0);
      await m().recheck.recheckAfterPayment(inv.id);
      expect((await m().db.select().from(schema.stockAlerts)).filter((x) => x.key === `paid-short:${o.id}:${carpet.id}`).length).toBe(1);
      facts.a2container = { shortM: 30, alerts: 1, payments: 1, refunds: 0, posDrafted: 0, crew: "Stock shortage — owner review required" };
    });

    test("stock only and reorderable wording", async () => {
      const sup = await supplier("Clearance");
      const p = await product({ supplierId: sup.id, category: "accessory", unit: "each", name: "Clearance Trim" });
      await setSupply(p.id, { supplyMode: "stock_only", stockUnitLabel: "lengths" });
      await item(p.id, { qty: 3, unit: "unit", type: "unit_lot", costPer: "unit", widthM: null, batch: null });
      const s = await m().supplyCheck.supplyShorts([{ productId: p.id, qty: 5, unit: "each" }], null, null);
      expect(s[0]!.text).toBe("Insufficient stock — no replenishment planned: Test Clearance Trim Grey needs 5 lengths, 3 lengths available. 2 lengths short.");
      // Reorderable products are never blocked here; their shortage is "Not ordered yet" until a route is chosen.
      expect(await m().supplyCheck.supplyShorts([{ productId: adh.id, qty: 500, unit: "each" }], null, null)).toEqual([]);
      expect([m().crew.shortLabel("container"), m().crew.shortLabel("stock_only"), m().crew.shortLabel("reorder")]).toEqual([
        "Stock shortage — owner review required",
        "Insufficient stock — no replenishment planned",
        "Not ordered yet",
      ]);
    });

    test("m² products counted in m²: a 4 m wide roll of vinyl is 4 m² a metre", async () => {
      const sup = await supplier("Vinyl Supplier");
      const p = await product({ supplierId: sup.id, category: "vinyl", unit: "m2", name: "Sheet Vinyl" });
      await setSupply(p.id, { supplyMode: "stock_only" });
      await item(p.id, { qty: 10, widthM: 4 });
      const n = await nums(p.id);
      expect(n.physical).toBe(40);
      const s = await m().supplyCheck.supplyShorts([{ productId: p.id, qty: 50, unit: "m2" }], null, null);
      expect([s[0]!.need, s[0]!.available, s[0]!.short]).toEqual([50, 40, 10]);
    });
  });

  /* ========================= decision 2: Admin only ========================= */

  describe("decision 2: warehouse orders are Admin only", () => {
    test("Office (even with Handle stock and View costs) cannot prepare, change, link or close", async () => {
      for (const who of [people.office, people.officeCosts, people.field]) {
        await no(m().warehousePo.draftSuggestions(lowSup.id, null, who), "Warehouse orders are Admin only.");
        await no(m().warehousePo.editDraftLine({ poId: lowPo.id, productId: leveller.id, generalQty: 1 }, who), "Warehouse orders are Admin only.");
        await no(m().warehousePo.editWarehouseTerms({ poId: lowPo.id, expectedPayDate: "2026-12-31" }, who), "Warehouse orders are Admin only.");
        await no(m().warehousePo.addShortageToWarehouse(shortB.id, who), "Warehouse orders are Admin only.");
        await no(m().warehousePo.closeLine(1, "x", who), "Warehouse orders are Admin only.");
      }
      // The A1 split stays: View costs and Change costs are separate ticks.
      const office = await m().core.stockPerms(people.office);
      const officeCosts = await m().core.stockPerms(people.officeCosts);
      expect([office.viewCosts, officeCosts.viewCosts]).toEqual([false, true]);
      expect(officeCosts.changeCosts).toBe(false);
      facts.a2perms = "Office, Office with View costs and Field refused on all five warehouse-order actions";
    });
  });

  /* ========================== 7E pause with orders ========================== */

  describe("7E S6 paused, then off, with warehouse POs present", () => {
    test("nothing new, but every warehouse PO and what is owed stays visible", async () => {
      await m().warehousePo.editWarehouseTerms({ poId: lowPo.id, expectedPayDate: "2026-12-15" }, people.main);
      const before = await cash(lowPo.number);
      expect(sum(before)).toBe(1650);
      const [bill] = await m()
        .db.insert(schema.supplierInvoices)
        .values({ supplierId: lowSup.id, invoiceNumber: "INV-L1", dedupeKey: `${lowSup.id}|INV-L1`, poId: lowPo.id, totalExGst: 1500, gst: 150, totalIncGst: 1650, dueDate: "2026-12-15" })
        .returning();
      await m().match.settlePo(lowPo.id);
      const listed = (await m().warehousePo.warehouseOrders()).map((o) => o.number);
      for (const s of ["paused", "off"] as const) {
        await m().core.setSwitch("s6", s, people.main);
        await no(m().warehousePo.draftSuggestions(adhSup.id, null, people.main), "Warehouse orders are paused or off (S6).");
        await no(m().warehousePo.addShortageToWarehouse(shortB.id, people.main), "Warehouse orders are paused or off (S6).");
        expect((await m().warehousePo.warehouseOrders()).map((o) => o.number)).toEqual(listed);
        const ev = await cash(lowPo.number);
        expect(ev.map((e) => [e.amount, e.dueDate])).toEqual([[1650, "2026-12-15"]]);
        const unpaid = (await m().db.select().from(schema.supplierInvoices)).filter((i) => i.id === bill!.id && i.payState === "unpaid");
        expect(unpaid.length).toBe(1);
        // Container products stay container: still no job top-up PO.
        expect((await prod(carpet.id)).supplyMode).toBe("container");
        // Low alerts stop; the low state stays on screen.
        expect((await state(leveller.id)).lowNow).toBe(true);
      }
      // Receiving still works on a sent warehouse PO while S6 is off.
      const line = await goodsLine(lowPo.id, leveller.id);
      await m().receiving.receiveLine({ poLineId: line.id, pieces: [{ qty: 50 }], requestKey: rk("recv") }, people.office);
      expect((await nums(leveller.id)).available).toBe(60);
      expect((await m().replenish.checkLowAlerts([leveller.id])).reset).toBe(1);
      facts.a2pause = { listed, owedVisible: 1650 };
    });
  });

  /* ===================== decisions 4 and 5: numbers, lead time ===================== */

  describe("decision 4: PO-W numbers", () => {
    test("own sequence, never reused after a cancel, unchanged by edits and receipts", async () => {
      const all = await m().warehousePo.warehouseOrders(true);
      const numbers = all.map((o) => o.number);
      expect(numbers.every((n) => /^PO-W\d{4}$/.test(n))).toBe(true);
      expect(new Set(numbers).size).toBe(numbers.length);
      // The PO that was edited, sent, billed and received still has its first number.
      expect((await poRow(lowPo.id)).number).toBe(lowPo.number);
      // Job POs keep their own numbers.
      const jobPos = (await m().db.select().from(schema.purchaseOrders)).filter((p) => p.kind !== "warehouse");
      expect(jobPos.length > 0 && jobPos.every((p) => !p.number.startsWith("PO-W"))).toBe(true);
      // Cancel the newest one: its number is not handed out again.
      const last = [...all].sort((a, b) => a.number.localeCompare(b.number)).at(-1)!;
      await m().db.update(schema.purchaseOrders).set({ status: "cancelled" }).where(eq(schema.purchaseOrders.id, last.id));
      const n = Number(last.number.slice(4));
      expect(await m().warehousePo.nextWarehouseNumber()).toBe(`PO-W${String(n + 1).padStart(4, "0")}`);
      facts.a2numbers = { numbers, afterCancel: await m().warehousePo.nextWarehouseNumber() };
    });
  });

  describe("decision 5: lead time warning", () => {
    type Short = Parameters<ReturnType<typeof m>["replenish"]["leadFlag"]>[1];
    test("business days, needed date else job start, unknown lead time, warning only", async () => {
      const r = m().replenish;
      // Business days skip the weekend: Friday 6 Nov + 1 is Monday 9 Nov.
      expect(r.addBusinessDays("2026-11-06", 1)).toBe("2026-11-09");
      expect(r.addBusinessDays("2026-11-04", 5)).toBe("2026-11-11");
      const j = await job({});
      const start = new Date("2026-11-09T14:00:00Z"); // 10 Nov, Brisbane
      await m().db.update(schema.jobs).set({ scheduledStart: start }).where(eq(schema.jobs.id, j.job.id));
      const s = { jobId: j.job.id } as Short;
      const sent = new Date("2026-11-04T00:00:00Z");
      expect(await r.leadFlag({ leadTimeDays: null }, s, sent)).toBe("Lead time unknown — confirm with supplier.");
      // No booked task: the job start is used.
      expect(await r.leadFlag({ leadTimeDays: 5 }, s, sent)).toBe(
        "Material may arrive after the required date — check with supplier (about 2026-11-11, needed 2026-11-10, job start; lead time counts Monday to Friday only; public holidays not excluded).",
      );
      // A booked task wins over the job start. 20 Nov is after 11 Nov: no warning.
      await m().db.insert(schema.jobTasks).values({ jobId: j.job.id, title: "Install", scheduledDate: "2026-11-20", status: "booked" });
      expect(await r.leadFlag({ leadTimeDays: 5 }, s, sent)).toBe(null);
      // A warning only: the job date is not moved.
      const [after] = await m().db.select().from(schema.jobs).where(eq(schema.jobs.id, j.job.id));
      expect(after!.scheduledStart?.getTime()).toBe(start.getTime());
      facts.a2lead = { fridayPlus1: "2026-11-09", wedPlus5: "2026-11-11", unknown: true, late: true, onTime: true };
    });
  });
}
