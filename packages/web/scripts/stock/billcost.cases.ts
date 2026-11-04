/**
 * Warehouse stock: remnant and stock cost when the supplier bill is not the
 * PO amount (v3 section 13 item 4, A1 amendment). Registered from
 * stock.test.ts on the same throwaway database.
 *
 *  - Stock keeps the PO line rate. Freight is not included. The figure is
 *    never changed by a bill.
 *  - Bill differs: the received roll and its remnant are "provisional" and
 *    marked "Cost provisional, bill differs from PO".
 *  - Bill agrees (or is corrected to agree): final, mark removed.
 *  - The job credit for a remnant is at the PO rate, once.
 *  - An Admin who sets the cost by hand clears the mark, and a later bill
 *    check leaves that item alone.
 *
 * Nothing leaves the machine. Run from packages/web:  bun test scripts/stock
 */
import { describe, expect, test } from "bun:test";
import { costsOf, job, m, people, product, rk, schema, supplier } from "./harness";

type Helpers = {
  eq: (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => ReturnType<ReturnType<typeof m>["drizzle"]["eq"]>;
  facts: Record<string, unknown>;
  material: (jobId: number, productId: number, qty: number, unit?: string, description?: string) => Promise<typeof schema.jobMaterials.$inferSelect>;
  po: (jobId: number, supplierId: number, status: string, lines: { jobMaterialId?: number | null; productId: number; qty: number; unit: string; unitCost: number }[], kind?: string) => Promise<{ po: typeof schema.purchaseOrders.$inferSelect; lines: (typeof schema.purchaseOrderLines.$inferSelect)[] }>;
};

export function registerBillCost(h: Helpers) {
  const { eq, facts, material, po } = h;
  const db = () => m().db;
  const FLAG = "Cost provisional, bill differs from PO";
  const row = async (id: number) => (await db().select().from(schema.stockItems).where(eq(schema.stockItems.id, id)))[0]!;
  let n = 0;
  const bill = async (poId: number, supplierId: number, exGst: number, docType: "invoice" | "credit" = "invoice") => {
    const tag = `BC-${poId}-${++n}`;
    await db()
      .insert(schema.supplierInvoices)
      .values({ supplierId, invoiceNumber: tag, dedupeKey: `${supplierId}|${tag}`, poId, docType, totalExGst: exGst, gst: exGst / 10, totalIncGst: exGst * 1.1 });
    await m().match.settlePo(poId);
  };
  const reviews = async (itemId: number) => (await db().select().from(schema.stockMovements).where(eq(schema.stockMovements.stockItemId, itemId))).filter((x) => x.kind === "cost_review");

  /** 60 m² carpet at $20 on a sent job PO, received as one 15 m x 4 m roll. */
  const received = async (label: string) => {
    const sup = await supplier(`Bill ${label}`);
    const p = await product({ supplierId: sup.id, category: "carpet" });
    const { job: jb } = await job({ quoteTotal: 3000, percent: 0, accepted: true });
    const mat = await material(jb.id, p.id, 60);
    const made = await po(jb.id, sup.id, "sent", [{ jobMaterialId: mat.id, productId: p.id, qty: 60, unit: "m2", unitCost: 20 }]);
    return { sup, p, jb, ...made };
  };
  const receive = async (lineId: number) => (await m().receiving.receiveLine({ poLineId: lineId, pieces: [{ qty: 15, widthM: 4 }], requestKey: rk("bc-recv") }, people.office)).items[0]!;

  describe("stock cost when the bill differs from the PO", () => {
    test("bill $1,250 on a $1,200 PO: roll and remnant provisional at the PO rate, marked; credit once at the PO rate", async () => {
      const c = await received("differs");
      const roll = await receive(c.lines[0]!.id);
      expect(roll.costStatus).toBe("provisional");
      expect(roll.unitCost).toBe(20);
      expect(roll.purchaseCostNote).toBe("");
      await bill(c.po.id, c.sup.id, 1250);
      const [si] = await db().select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.poId, c.po.id));
      expect(si!.matchStatus).toBe("different");
      const r1 = await row(roll.id);
      expect(r1.costStatus).toBe("provisional");
      expect(r1.purchaseCostNote).toContain(FLAG);
      expect(r1.unitCost).toBe(20);
      expect((await reviews(roll.id)).map((x) => x.note)).toEqual([`${FLAG}. Kept at the PO rate, $20.00 per m2, freight not included. For review.`]);
      // The same check again changes nothing and adds no second note.
      await m().match.settlePo(c.po.id);
      expect((await reviews(roll.id)).length).toBe(1);

      // The job uses it and 3 m x 4 m comes back as a Terra-owned remnant.
      const [hold] = (await db().select().from(schema.stockReservations).where(eq(schema.stockReservations.jobId, c.jb.id))).filter((x) => x.stockItemId === roll.id);
      await m().holds.takeOut(hold!.id, 15, rk("bc-out"), people.office);
      const back = await m().returns.returnFromJob({ holdId: hold!.id, kind: "leftover", qty: 3, widthM: 4, terraOwned: true, requestKey: rk("bc-ret") }, people.office);
      const rem = back.item!;
      expect(rem.type).toBe("remnant");
      expect(rem.parentItemId).toBe(roll.id);
      expect(rem.costStatus).toBe("provisional");
      expect(rem.purchaseCostNote).toContain(FLAG);
      expect(rem.unitCost).toBe(20);
      const ok = await m().returns.approveReturn(rem.id, people.main);
      expect(ok.credit.credited).toBe(true);
      expect((await m().returns.creditReturn(rem.id)).note).toBe("Already credited.");
      const credits = (await costsOf(c.jb.id)).filter((x) => x.stockRef === `return:${rem.id}`);
      expect(credits.length).toBe(1);
      // 3 m x 4 m = 12 m² at the PO rate of $20. Not at the bill, and no freight.
      expect(credits[0]!.amount).toBe(-240);
      facts.billDiffers = { roll: r1.costStatus, rollNote: FLAG, remnant: rem.costStatus, unitCost: 20, credit: -240, credits: credits.length };

      // The supplier credits $50, so the bills now agree: both final, mark gone, rate the same, credit unchanged.
      await bill(c.po.id, c.sup.id, 50, "credit");
      const [r2, rm2] = [await row(roll.id), await row(rem.id)];
      expect([r2.costStatus, rm2.costStatus]).toEqual(["final", "final"]);
      expect(r2.purchaseCostNote).not.toContain(FLAG);
      expect(rm2.purchaseCostNote).not.toContain(FLAG);
      expect([r2.unitCost, rm2.unitCost]).toEqual([20, 20]);
      expect((await reviews(rem.id)).at(-1)!.note).toBe("Bill agrees with the PO. Cost final at the PO rate, $20.00 per m2.");
      expect((await costsOf(c.jb.id)).filter((x) => x.stockRef === `return:${rem.id}`).map((x) => x.amount)).toEqual([-240]);
      facts.billCorrected = { roll: r2.costStatus, remnant: rm2.costStatus };
    });

    test("bill agrees: final, no mark", async () => {
      const c = await received("agrees");
      const roll = await receive(c.lines[0]!.id);
      await bill(c.po.id, c.sup.id, 1200);
      const r = await row(roll.id);
      expect(r.costStatus).toBe("final");
      expect(r.purchaseCostNote).not.toContain(FLAG);
      expect(r.unitCost).toBe(20);
    });

    test("bill in before the goods: received straight in as provisional and marked, or final if it agrees", async () => {
      const a = await received("first-differs");
      await bill(a.po.id, a.sup.id, 1290);
      const ra = await receive(a.lines[0]!.id);
      expect(ra.costStatus).toBe("provisional");
      expect(ra.purchaseCostNote).toContain(FLAG);
      expect(ra.unitCost).toBe(20);
      const b = await received("first-agrees");
      await bill(b.po.id, b.sup.id, 1200);
      const rb = await receive(b.lines[0]!.id);
      expect(rb.costStatus).toBe("final");
      expect(rb.purchaseCostNote).toBe("");
    });

    test("Admin sets the cost by hand: mark off, and a later bill check leaves it alone", async () => {
      const c = await received("by-hand");
      const roll = await receive(c.lines[0]!.id);
      await bill(c.po.id, c.sup.id, 1250);
      expect((await row(roll.id)).purchaseCostNote).toContain(FLAG);
      await m().items.setItemCost(roll.id, { unitCost: 20.83, costStatus: "final", note: "Checked the bill, price went up" }, people.main);
      const r = await row(roll.id);
      expect(r.costStatus).toBe("final");
      expect(r.unitCost).toBe(20.83);
      expect(r.purchaseCostNote).not.toContain(FLAG);
      await m().match.settlePo(c.po.id);
      const again = await row(roll.id);
      expect([again.costStatus, again.unitCost, again.purchaseCostNote.includes(FLAG)]).toEqual(["final", 20.83, false]);
    });
  });
}
