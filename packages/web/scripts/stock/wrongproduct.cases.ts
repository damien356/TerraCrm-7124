/**
 * Wrong product on a PO (Damien, 11 Nov 2026, job 188065). Registered from
 * stock.test.ts after the other cases, on the same throwaway database.
 *
 *  1. 188065 replayed: a sale raised with product A, the line swapped for B
 *     in the quote builder before it was sent, accepted online. The sale
 *     lines, materials and draft PO follow B, with B's supplier and boxes.
 *  2. Order pressed again and the sale opened again: nothing doubles.
 *  3. A revised quote accepted (a new version): lines follow the version
 *     accepted, matched by product, never duplicated.
 *  4. A draft already made with the wrong product (the state 188065 was
 *     in): Send and Mark sent refuse it, only the main admin can approve a
 *     substitute and only with a reason; the approval is logged and read by
 *     later checks. The wrong line is never ordered again.
 *  5. Another supplier for the same product, and a part order: allowed.
 *
 * Supplier emails go only to .invalid addresses and are captured. Nothing
 * leaves the machine. Run from packages/web: bun test scripts/stock
 */
import { describe, expect, test } from "bun:test";
import { m, outside, people, rk, schema, supplier } from "./harness";

type Helpers = {
  no: (p: Promise<unknown>, text: string) => Promise<void>;
  eq: (...a: Parameters<ReturnType<typeof m>["drizzle"]["eq"]>) => ReturnType<ReturnType<typeof m>["drizzle"]["eq"]>;
  facts: Record<string, unknown>;
};

export function registerWrongProduct(h: Helpers) {
  const { no, eq, facts } = h;
  const db = () => m().db;
  const office = { name: people.office?.name ?? "Test office", role: "office" };
  let seq = 0;

  const mkSup = async (name: string) => {
    const s = await supplier(name);
    await db().update(schema.suppliers).set({ email: `orders-wp${++seq}@example.invalid`, active: true }).where(eq(schema.suppliers.id, s.id));
    return s;
  };
  /** A boxed floor: whole boxes of `box` m2 on the PO. */
  const mkProd = async (supplierId: number, brand: string, range: string, colour: string, box: number, cost: number) => {
    const [p] = await db()
      .insert(schema.products)
      .values({
        supplierId,
        brand,
        range,
        colour,
        category: "hybrid",
        unit: "m2",
        soldAs: "box",
        unitsPerPack: 1,
        unitM2: box,
        costPrice: cost,
        sellPrice: cost * 1.3,
        variantKey: `wp-${++seq}-${range}-${colour}`,
      })
      .returning();
    return p!;
  };
  const contact = async () => {
    const [c] = await db()
      .insert(schema.contacts)
      .values({ firstName: "Dana", lastName: `Wrongprod ${++seq}`, email: `wp${seq}@example.invalid` })
      .returning();
    return c!;
  };
  /** Sell products, saved as a quote (not sent), Order ticked. */
  const saleQuote = async (productId: number, qty: number, unitPrice: number, orderNeeded = true) => {
    const c = await contact();
    const key = rk("wp-sale");
    const input = {
      buyer: { kind: "contact" as const, contactId: c.id },
      mode: "quote" as const,
      lines: [{ productId, description: "", qty, unit: "m2", unitPrice }],
      orderNeeded,
      depositPercent: 0,
    };
    const pv = (await m().productSale.previewSale({ ...input, requestKey: key })) as unknown as { total: number };
    return m().productSale.raiseSale({ ...input, requestKey: key, expectedTotal: pv.total }, people.office as never);
  };
  /** What removeItem then addItem leave behind in the quote builder: the old row gone, a new row for the new product. */
  const swap = async (quoteId: number, fromProductId: number, to: typeof schema.products.$inferSelect, qty: number, unitPrice: number) => {
    const [old] = await db().select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, quoteId));
    expect(old!.productId).toBe(fromProductId);
    await db().delete(schema.quoteItems).where(eq(schema.quoteItems.id, old!.id));
    const [row] = await db()
      .insert(schema.quoteItems)
      .values({ quoteId, productId: to.id, kind: "supply", description: `${to.brand} ${to.range} in ${to.colour}`, qty, unit: "m2", unitPrice, unitCost: to.costPrice, lineType: "material", sortOrder: 0 })
      .returning();
    const total = Math.round(qty * unitPrice * 1.1 * 100) / 100;
    await db().update(schema.quotes).set({ status: "sent", total, subtotal: Math.round(qty * unitPrice * 100) / 100 }).where(eq(schema.quotes.id, quoteId));
    return row!;
  };
  const acceptOnline = (quoteId: number) => m().quoteAccept.acceptQuote({ quoteId, actor: { name: "Dana Client", role: "customer" }, via: "online" });
  const saleOf = async (jobId: number) => (await db().select().from(schema.productSales).where(eq(schema.productSales.jobId, jobId)))[0]!;
  const linesOf = async (saleId: number) => db().select().from(schema.productSaleLines).where(eq(schema.productSaleLines.saleId, saleId));
  const matsOf = async (jobId: number) => db().select().from(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId));
  const posOf = async (jobId: number) => db().select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.jobId, jobId));
  const poLines = async (poId: number) => db().select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, poId));
  const acts = async (jobId: number, action: string) => (await db().select().from(schema.activityLog).where(eq(schema.activityLog.jobId, jobId))).filter((a) => a.action === action);
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as Error & { data?: { poSubstitute?: string[] } };
    }
    throw new Error("expected it to be refused");
  };
  /** A draft job PO, as the helper or a person would have left it. */
  let poN = 0;
  const draftPo = async (jobId: number, supplierId: number, lines: { jobMaterialId: number | null; productId: number; qty: number; unitCost: number; description: string }[]) => {
    const total = Math.round(lines.reduce((s, l) => s + l.qty * l.unitCost, 0) * 100) / 100;
    const [row] = await db()
      .insert(schema.purchaseOrders)
      .values({ number: `PO-WP${++poN}`, jobId, supplierId, status: "draft", kind: "job", totalExGst: total, goodsExGst: total, deliverTo: "warehouse", deliveryAddress: "2/22 Lawrence Dr, Nerang QLD 4211" })
      .returning();
    for (const l of lines)
      await db()
        .insert(schema.purchaseOrderLines)
        .values({ poId: row!.id, jobMaterialId: l.jobMaterialId, productId: l.productId, kind: "goods", description: l.description, qty: l.qty, unit: "m2", unitCostExGst: l.unitCost, totalExGst: Math.round(l.qty * l.unitCost * 100) / 100 });
    return row!;
  };

  // Like 188065: A is Terramater-like, B is NFD-like, from different suppliers, different box sizes.
  let supA: Awaited<ReturnType<typeof mkSup>>;
  let supB: Awaited<ReturnType<typeof mkSup>>;
  let supC: Awaited<ReturnType<typeof mkSup>>;
  let A: typeof schema.products.$inferSelect;
  let B: typeof schema.products.$inferSelect;
  let B2: typeof schema.products.$inferSelect;
  let first: Awaited<ReturnType<typeof saleQuote>>;
  let bItemId = 0;

  describe("Wrong product PO (188065): the product changed in the quote builder before acceptance", () => {
    test("sale raised with A, swapped for B before sending, accepted online: lines, material and draft PO are B", async () => {
      supA = await mkSup("TEST ONLY Arlo Floors");
      supB = await mkSup("TEST ONLY Eternity Floors");
      supC = await mkSup("TEST ONLY Eternity Second Source");
      A = await mkProd(supA.id, "WPTEST Arlo", "WildOak Arlo", "Nordic White", 2.2, 50);
      B = await mkProd(supB.id, "WPTEST Eternity", "Eternity", "Celtic Snow 801", 1.8, 52.9);
      B2 = await mkProd(supC.id, "WPTEST Eternity", "Eternity", "Celtic Snow 801", 1.8, 51.5);

      first = await saleQuote(A.id, 161.7, 62.9);
      expect(first.mode).toBe("quote");
      const before = await linesOf(first.saleId);
      expect(before.map((l) => l.productId)).toEqual([A.id]);
      const item = await swap(first.quoteId, A.id, B, 160.2, 63.3);
      bItemId = item.id;
      // The bug: before the fix this line stayed A, with no quote line, and A was ordered.
      const out = await acceptOnline(first.quoteId);
      expect(out.quote.status).toBe("accepted");

      const lines = await linesOf(first.saleId);
      expect(lines.map((l) => [l.productId, l.quoteItemId, l.qty, l.unitPrice])).toEqual([[B.id, item.id, 160.2, 63.3]]);
      const mats = await matsOf(first.jobId);
      expect(mats.map((x) => [x.productId, x.qty, x.status, x.saleLineId])).toEqual([[B.id, 160.2, "to_order", lines[0]!.id]]);
      const pos = await posOf(first.jobId);
      expect(pos.map((p) => [p.supplierId, p.status])).toEqual([[supB.id, "draft"]]);
      const pl = await poLines(pos[0]!.id);
      const goods = pl.filter((l) => l.kind === "goods");
      expect(goods.map((l) => l.productId)).toEqual([B.id]);
      // B's own boxes: 160.2 m2 in 1.8 m2 boxes is 89 boxes = 160.2 m2, at B's cost.
      expect(goods[0]!.qty).toBeCloseTo(160.2, 2);
      expect(goods[0]!.unitCostExGst).toBeCloseTo(52.9, 2);
      expect(pl.some((l) => l.productId === A.id)).toBe(false);
      expect((await db().select().from(schema.purchaseOrders)).some((p) => p.supplierId === supA.id)).toBe(false);
      expect(await m().poIdentity.poIdentityIssues(pos[0]!.id)).toEqual([]);
      const synced = await acts(first.jobId, "sale_lines_synced");
      expect(synced.length).toBe(1);
      expect(synced[0]!.detail).toContain("Added WPTEST Eternity Eternity in Celtic Snow 801, 160.2 m²");
      expect(synced[0]!.detail).toContain("no longer on the quote");
      facts.wp1 = { lines: lines.length, line: [B.id, item.id], materials: mats.length, po: { supplier: supB.name, goods: goods.map((g) => [g.description, g.qty, g.unit, g.unitCostExGst]) }, log: synced[0]!.detail };
    });

    test("Order pressed again and the sale opened again: no second line, material or PO, no second log", async () => {
      const mats = (await matsOf(first.jobId)).length;
      const pos = (await posOf(first.jobId)).length;
      const logs = (await acts(first.jobId, "sale_lines_synced")).length;
      for (let i = 0; i < 3; i++) {
        const again = await m().productSale.setStockAndOrder({ jobId: first.jobId, fromStock: [], actor: people.office as never });
        expect(again.added).toEqual([]);
        expect(again.drafted).toEqual([]);
        expect(await m().productSale.syncSaleLines(first.saleId, first.quoteId, office)).toEqual({ changed: [], removed: [], kept: [] });
      }
      expect((await linesOf(first.saleId)).length).toBe(1);
      expect((await matsOf(first.jobId)).length).toBe(mats);
      expect((await posOf(first.jobId)).length).toBe(pos);
      expect((await acts(first.jobId, "sale_lines_synced")).length).toBe(logs);
      facts.wp2 = { repeats: 3, lines: 1, materials: mats, pos };
    });

    test("another supplier for the same product, and a part order: no mismatch, sent without an approval", async () => {
      const mat = (await matsOf(first.jobId))[0]!;
      const alt = await draftPo(first.jobId, supC.id, [{ jobMaterialId: mat.id, productId: B2.id, qty: 50.4, unitCost: 51.5, description: "WPTEST Eternity Celtic Snow 801" }]);
      expect(await m().poIdentity.poIdentityIssues(alt.id)).toEqual([]);
      const ok = await m().purchasing.markPoSentNow({ id: alt.id, how: "phoned" }, people.office as never);
      expect(ok.ok).toBe(true);
      expect((await acts(first.jobId, "product_substitute_approved")).length).toBe(0);
      // The helper's own draft is the rest, also a part of the quote. Still fine.
      const helperPo = (await posOf(first.jobId)).find((p) => p.supplierId === supB.id)!;
      expect(await m().poIdentity.poIdentityIssues(helperPo.id)).toEqual([]);
      facts.wp5 = { altSupplier: "allowed", partOrder: "allowed" };
    });
  });

  describe("Wrong product PO (188065): a revised quote accepted", () => {
    test("v2 with a new qty and v2's own line ids: one line per product, re-linked, not duplicated", async () => {
      const s = await saleQuote(B.id, 40, 63.3, false);
      const { reviseQuoteRecord } = await import("../../src/api/routes/quotes");
      const [v1] = await db().select().from(schema.quotes).where(eq(schema.quotes.id, s.quoteId));
      const v2 = await reviseQuoteRecord(v1!, people.office as never);
      const v2Id = (v2 as { id: number }).id;
      const [it] = await db().select().from(schema.quoteItems).where(eq(schema.quoteItems.quoteId, v2Id));
      expect(it!.productId).toBe(B.id);
      await db().update(schema.quoteItems).set({ qty: 45 }).where(eq(schema.quoteItems.id, it!.id));
      await db().update(schema.quotes).set({ status: "sent" }).where(eq(schema.quotes.id, v2Id));
      await acceptOnline(v2Id);
      const lines = await linesOf(s.saleId);
      expect(lines.map((l) => [l.productId, l.quoteItemId, l.qty])).toEqual([[B.id, it!.id, 45]]);
      expect((await saleOf(s.jobId)).quoteId).toBe(v2Id);
      // Not ticked to order: nothing on Materials to order, no PO.
      expect((await matsOf(s.jobId)).length).toBe(0);
      expect((await posOf(s.jobId)).length).toBe(0);
      facts.wp3a = { line: [B.id, it!.id, 45] };
    });

    test("v2 swaps A for B: the version accepted is what is ordered", async () => {
      const s = await saleQuote(A.id, 30, 62.9, true);
      const { reviseQuoteRecord } = await import("../../src/api/routes/quotes");
      const [v1] = await db().select().from(schema.quotes).where(eq(schema.quotes.id, s.quoteId));
      const v2Id = ((await reviseQuoteRecord(v1!, people.office as never)) as { id: number }).id;
      await swap(v2Id, A.id, B, 30.6, 63.3);
      await acceptOnline(v2Id);
      const [v1after] = await db().select().from(schema.quotes).where(eq(schema.quotes.id, s.quoteId));
      expect(v1after!.status).toBe("expired");
      expect((await linesOf(s.saleId)).map((l) => l.productId)).toEqual([B.id]);
      expect((await matsOf(s.jobId)).map((x) => [x.productId, x.qty])).toEqual([[B.id, 30.6]]);
      const pos = await posOf(s.jobId);
      expect(pos.map((p) => p.supplierId)).toEqual([supB.id]);
      expect((await poLines(pos[0]!.id)).filter((l) => l.kind === "goods").map((l) => l.productId)).toEqual([B.id]);
      facts.wp3b = { ordered: "B", supplier: supB.name };
    });
  });

  describe("Wrong product PO (188065): a draft already made with the wrong product", () => {
    let jobId = 0;
    let saleId = 0;
    let quoteId = 0;
    let wrongPo = 0;
    let wrongMat = 0;

    test("the stale state: line still A with no quote line, A on Materials to order and on a draft PO", async () => {
      const s = await saleQuote(A.id, 161.7, 62.9, false);
      jobId = s.jobId;
      saleId = s.saleId;
      quoteId = s.quoteId;
      await swap(quoteId, A.id, B, 160.2, 63.3);
      // Accepted before the fix: the quote is accepted and the sale line was never touched.
      await db().update(schema.quotes).set({ status: "accepted", acceptedAt: new Date() }).where(eq(schema.quotes.id, quoteId));
      const [line] = await linesOf(saleId);
      await db().update(schema.productSaleLines).set({ quoteItemId: null }).where(eq(schema.productSaleLines.id, line!.id));
      const [mat] = await db()
        .insert(schema.jobMaterials)
        .values({ jobId, productId: A.id, description: line!.description, qty: 161.7, unit: "m2", status: "to_order", saleLineId: line!.id })
        .returning();
      wrongMat = mat!.id;
      wrongPo = (await draftPo(jobId, supA.id, [{ jobMaterialId: mat!.id, productId: A.id, qty: 162.8, unitCost: 50, description: line!.description }])).id;
      const found = await m().poIdentity.poIdentityIssues(wrongPo);
      expect(found.length).toBe(1);
      expect(found[0]!.text).toBe(
        "WPTEST Arlo WildOak Arlo in Nordic White is not on the accepted quote or an approved change. The client agreed to WPTEST Eternity Eternity in Celtic Snow 801.",
      );
      facts.wp4warning = found[0]!.text;
    });

    test("Send and Mark sent refuse it; nothing is emailed or marked", async () => {
      const mails = outside.supplierMail.length;
      const e = await errOf(m().purchasing.sendPoNow({ id: wrongPo, saveEmail: false }, people.main as never));
      expect(e.message).toStartWith("Product mismatch. WPTEST Arlo WildOak Arlo in Nordic White is not on the accepted quote");
      expect(e.data?.poSubstitute?.length).toBe(1);
      await no(m().purchasing.markPoSentNow({ id: wrongPo, how: "phoned" }, people.main as never), "Product mismatch.");
      await no(m().purchasing.markPoSentNow({ id: wrongPo, how: "phoned" }, people.office as never), "Product mismatch.");
      await no(
        m().purchasing.markPoSentNow({ id: wrongPo, how: "phoned", substituteOverride: { reason: "Client asked for it" } }, people.admin2 as never),
        "Only the main admin can approve a substitute product.",
      );
      await no(m().purchasing.markPoSentNow({ id: wrongPo, how: "phoned", substituteOverride: { reason: "ok" } }, people.main as never), "Say why this substitute is OK before it is marked sent.");
      const [po] = await db().select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, wrongPo));
      expect(po!.status).toBe("draft");
      expect(po!.sentAt).toBeNull();
      expect(outside.supplierMail.length).toBe(mails);
      expect((await acts(jobId, "product_substitute_approved")).length).toBe(0);
      facts.wp4refused = { send: e.message, office: "refused", otherAdmin: "Only the main admin can approve a substitute product.", noReason: "Say why this substitute is OK before it is marked sent." };
    });

    test("opening the sale fixes the lines; the A line on a live draft is kept, never reordered, and B is ordered", async () => {
      const r = await m().productSale.syncSaleLines(saleId, quoteId, office);
      expect(r.kept.length).toBe(1);
      expect(r.kept[0]).toContain("is no longer on the quote but is already on PO-WP");
      const lines = await linesOf(saleId);
      expect(lines.map((l) => l.productId).sort()).toEqual([A.id, B.id].sort());
      // Opening it again says nothing new.
      const logs = (await acts(jobId, "sale_lines_synced")).length;
      await m().productSale.syncSaleLines(saleId, quoteId, office);
      expect((await acts(jobId, "sale_lines_synced")).length).toBe(logs);
      await db().update(schema.quotes).set({ status: "accepted" }).where(eq(schema.quotes.id, quoteId));
      const o = await m().productSale.setStockAndOrder({ jobId, fromStock: [], actor: people.office as never });
      expect(o.added.length).toBe(1);
      const mats = await matsOf(jobId);
      expect(mats.filter((x) => x.productId === A.id).map((x) => x.id)).toEqual([wrongMat]);
      expect(mats.filter((x) => x.productId === B.id).length).toBe(1);
      const pos = await posOf(jobId);
      expect(pos.filter((p) => p.supplierId === supA.id).length).toBe(1);
      expect(pos.filter((p) => p.supplierId === supB.id).length).toBe(1);
    });

    test("the helper never drafts a wrong product: left off and put on the tray once", async () => {
      const [stray] = await db().insert(schema.jobMaterials).values({ jobId, productId: A.id, description: "Arlo extra", qty: 10, unit: "m2", status: "to_order" }).returning();
      const r1 = await m().poHelper.draftPosForJob({ jobId, quoteRef: "Q-test" });
      const r2 = await m().poHelper.draftPosForJob({ jobId, quoteRef: "Q-test" });
      expect(r1.drafted.length + r2.drafted.length).toBe(0);
      const tray = (await db().select().from(schema.aiActions).where(eq(schema.aiActions.jobId, jobId))).filter((a) => a.kind === "po_skipped");
      expect(tray.length).toBe(1);
      expect(tray[0]!.title).toStartWith("Product mismatch, no PO drafted");
      await db().delete(schema.jobMaterials).where(eq(schema.jobMaterials.id, stray!.id));
      facts.wp4tray = tray[0]!.title;
    });

    test("main admin approves the substitute with a reason: sent, logged with who and why, and later checks read it", async () => {
      const mails = outside.supplierMail.length;
      const ok = await m().purchasing.sendPoNow({ id: wrongPo, saveEmail: false, substituteOverride: { reason: "Client asked by phone for the Arlo after all" } }, people.main as never);
      expect(ok.ok).toBe(true);
      expect(outside.supplierMail.length).toBe(mails + 1);
      expect(outside.supplierMail.at(-1)!.to).toMatch(/\.invalid$/);
      const logged = await acts(jobId, "product_substitute_approved");
      expect(logged.length).toBe(1);
      expect(logged[0]!.actorName).toBe(people.main.name);
      expect(logged[0]!.detail).toContain("Reason: Client asked by phone for the Arlo after all");
      expect(logged[0]!.detail).toContain(`[substitute:${A.id}]`);
      // A later PO with the same substitute is not stopped again.
      const later = await draftPo(jobId, supA.id, [{ jobMaterialId: null, productId: A.id, qty: 4.4, unitCost: 50, description: "Arlo top up" }]);
      expect(await m().poIdentity.poIdentityIssues(later.id)).toEqual([]);
      facts.wp4approved = { by: logged[0]!.actorName, detail: logged[0]!.detail };
    });

    test("a draft removed before it is sent: the A line and its material go, B stays", async () => {
      const s = await saleQuote(A.id, 20, 62.9, false);
      await swap(s.quoteId, A.id, B, 19.8, 63.3);
      await db().update(schema.quotes).set({ status: "accepted", acceptedAt: new Date() }).where(eq(schema.quotes.id, s.quoteId));
      const [line] = await linesOf(s.saleId);
      await db().update(schema.productSaleLines).set({ quoteItemId: null }).where(eq(schema.productSaleLines.id, line!.id));
      const [mat] = await db().insert(schema.jobMaterials).values({ jobId: s.jobId, productId: A.id, description: line!.description, qty: 20, unit: "m2", status: "to_order", saleLineId: line!.id }).returning();
      const d = await draftPo(s.jobId, supA.id, [{ jobMaterialId: mat!.id, productId: A.id, qty: 20, unitCost: 50, description: line!.description }]);
      // As Remove draft leaves it: cancelled, never sent.
      await db().update(schema.purchaseOrders).set({ status: "cancelled", notes: "Draft removed, never sent." }).where(eq(schema.purchaseOrders.id, d.id));
      expect(await m().poIdentity.poIdentityIssues(d.id)).toEqual([]);
      const r = await m().productSale.syncSaleLines(s.saleId, s.quoteId, office);
      expect(r.removed.length).toBe(1);
      expect(r.kept).toEqual([]);
      expect((await linesOf(s.saleId)).map((l) => l.productId)).toEqual([B.id]);
      expect((await matsOf(s.jobId)).length).toBe(0);
      // The cancelled draft stays as history with its own lines.
      expect((await poLines(d.id)).map((l) => l.productId)).toEqual([A.id]);
      facts.wp4removed = r.removed[0];
    });
  });
}
