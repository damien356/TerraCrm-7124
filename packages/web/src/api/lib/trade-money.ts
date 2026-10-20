import { and, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../database";
import * as schema from "../database/schema";
import { round2 } from "./pricing";
import {
  auditRow,
  bad,
  conflict,
  guard,
  money,
  notFound,
  oneSaleMoney,
  runGuarded,
  saleBalanceSql,
  ymd,
  type Who,
} from "./trade-core";
import { invoiceRef } from "./trade-pricing";
import { lastMovementIdSql, movementStmt, onHandFor } from "./trade-stock";

/* ---------------------------------------------------------------------------
 * Trade sales after finalise (notes 18.65): payments, refunds, reversals,
 * credit notes, collection or dispatch, returns, arrangements and cancel.
 *
 * Nothing here ever changes a finalised sale's lines or totals, and nothing
 * is ever deleted. A mistake is a reversal row. Credit (money), refund (money
 * back) and a physical return (goods back on the shelf) are three separate
 * actions, so one can happen without the others.
 *
 * Every write is one guarded batch: balances are re-read inside the write, so
 * two people at once cannot take the same money twice, and each action has a
 * unique key, so a double click saves once.
 * ------------------------------------------------------------------------- */

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const q3 = (n: number) => Math.round(n * 1000) / 1000;

async function saleRow(saleId: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, saleId));
  if (!s) throw notFound("Sale not found");
  return s;
}

async function finalisedSale(saleId: number) {
  const s = await saleRow(saleId);
  if (s.status === "draft") throw bad("Finalise the sale first.");
  if (s.status === "cancelled") throw bad("This sale was cancelled.");
  return s;
}

const cleanKey = (k: string) => {
  const v = (k ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw bad("Missing action key. Reload the page and try again.");
  return v;
};

/** Open offsets bigger than what will be left owing are flagged, so they cannot take the same money twice. */
async function flagOffsetStmts(saleId: number, after: number, why: string, ref: string) {
  const open = await db
    .select()
    .from(schema.tradeOffsets)
    .where(and(eq(schema.tradeOffsets.saleId, saleId), inArray(schema.tradeOffsets.status, ["proposed", "approved"])));
  const clash = open.filter((o) => o.amount > Math.max(0, after) + 0.005);
  const out: BatchItem<"sqlite">[] = [];
  for (const o of clash) {
    out.push(
      db
        .update(schema.tradeOffsets)
        .set({ conflict: `${why} Only ${money(Math.max(0, after))} is now owing on ${ref}. Change or cancel this offset.`, updatedAt: new Date() })
        .where(eq(schema.tradeOffsets.id, o.id)),
      auditRow({
        entityType: "offset",
        entityId: o.id,
        saleId,
        billId: o.billId,
        action: "offset_conflict",
        detail: `Offset ${money(o.amount)} flagged. ${why} Nothing deducted.`,
        who: { name: "System", role: "system" },
      }),
    );
  }
  return out;
}

/* -------------------------------- payments -------------------------------- */

export async function recordPayment(
  input: { saleId: number; method: "bank" | "cash" | "other"; amount: number; paidDate: string; reference: string; key: string },
  who: Who,
) {
  const s = await finalisedSale(input.saleId);
  const key = cleanKey(input.key);
  const amount = round2(input.amount);
  if (!(amount > 0)) throw bad("Enter the amount received.");
  if (!ISO.test(input.paidDate)) throw bad("Pick the date it was received.");
  if (!input.reference.trim()) throw bad("Add the bank or receipt reference.");
  const m = await oneSaleMoney(s.id);
  if (amount > m.balance + 0.005) throw bad(`Only ${money(Math.max(0, m.balance))} is owing. Record at most that.`);
  const ref = invoiceRef(s.number);
  const flags = await flagOffsetStmts(s.id, round2(m.balance - amount), `${money(amount)} was received by ${input.method} on ${input.paidDate}.`, ref);
  await runGuarded([
    guard(sql`${saleBalanceSql(s.id)} >= ${amount} - 0.005`),
    db.insert(schema.tradePayments).values({
      saleId: s.id,
      kind: "payment",
      method: input.method,
      amount,
      paidDate: input.paidDate,
      reference: input.reference.trim().slice(0, 200),
      idemKey: `pay:${key}`,
      byName: who.name,
    }),
    auditRow({ entityType: "payment", saleId: s.id, action: "payment", detail: `${ref}: ${money(amount)} received by ${input.method} on ${input.paidDate}, ref ${input.reference.trim()}.`, who }),
    ...flags,
  ]);
}

/** Money back to the buyer. At most the credit balance. Records it, never sends it. */
export async function recordRefund(
  input: { saleId: number; method: "bank" | "card" | "cash" | "other"; amount: number; paidDate: string; reference: string; key: string },
  who: Who,
) {
  const s = await finalisedSale(input.saleId);
  const key = cleanKey(input.key);
  const amount = round2(input.amount);
  if (!(amount > 0)) throw bad("Enter the amount refunded.");
  if (!ISO.test(input.paidDate)) throw bad("Pick the date it was refunded.");
  if (!input.reference.trim()) throw bad("Add the refund reference.");
  const m = await oneSaleMoney(s.id);
  const credit = round2(-m.balance);
  if (amount > credit + 0.005) throw bad(credit > 0 ? `The credit balance is ${money(credit)}. Refund at most that.` : "There is no credit balance to refund.");
  await runGuarded([
    guard(sql`-${saleBalanceSql(s.id)} >= ${amount} - 0.005`),
    db.insert(schema.tradePayments).values({
      saleId: s.id,
      kind: "refund",
      method: input.method,
      amount,
      paidDate: input.paidDate,
      reference: input.reference.trim().slice(0, 200),
      idemKey: `refund:${key}`,
      byName: who.name,
    }),
    auditRow({ entityType: "payment", saleId: s.id, action: "refund", detail: `${invoiceRef(s.number)}: refunded ${money(amount)} by ${input.method} on ${input.paidDate}, ref ${input.reference.trim()}.`, who }),
  ]);
}

/** Leave a credit balance on the sale for later. A note only, no money moves. */
export async function keepAsCredit(saleId: number, note: string, who: Who) {
  const s = await finalisedSale(saleId);
  const m = await oneSaleMoney(saleId);
  if (!(m.balance < -0.005)) throw bad("There is no credit balance on this sale.");
  await auditRow({ entityType: "payment", saleId, action: "kept_as_credit", detail: `${invoiceRef(s.number)}: ${money(-m.balance)} kept as credit for ${s.billName}. ${note.trim()}`.trim(), who });
}

/** Use a credit balance on one sale to pay another of the same buyer. Two linked rows, no cash. */
export async function applyCredit(input: { fromSaleId: number; toSaleId: number; amount: number; key: string }, who: Who) {
  const from = await finalisedSale(input.fromSaleId);
  const to = await finalisedSale(input.toSaleId);
  const key = cleanKey(input.key);
  if (from.id === to.id) throw bad("Pick a different sale.");
  if (from.buyerId !== to.buyerId) throw bad("Credit can only go to a sale for the same buyer.");
  const amount = round2(input.amount);
  if (!(amount > 0)) throw bad("Enter the amount to apply.");
  const [mf, mt] = [await oneSaleMoney(from.id), await oneSaleMoney(to.id)];
  if (amount > -mf.balance + 0.005) throw bad(`The credit balance on ${invoiceRef(from.number)} is ${money(Math.max(0, -mf.balance))}.`);
  if (amount > mt.balance + 0.005) throw bad(`Only ${money(Math.max(0, mt.balance))} is owing on ${invoiceRef(to.number)}.`);
  const today = ymd();
  const flags = await flagOffsetStmts(to.id, round2(mt.balance - amount), `${money(amount)} credit from ${invoiceRef(from.number)} was applied.`, invoiceRef(to.number));
  await runGuarded([
    guard(sql`-${saleBalanceSql(from.id)} >= ${amount} - 0.005 and ${saleBalanceSql(to.id)} >= ${amount} - 0.005`),
    db.insert(schema.tradePayments).values({
      saleId: from.id,
      kind: "refund",
      method: "credit",
      amount,
      paidDate: today,
      reference: `Credit applied to ${invoiceRef(to.number)}`,
      idemKey: `credit-out:${key}`,
      byName: who.name,
    }),
    db.insert(schema.tradePayments).values({
      saleId: to.id,
      kind: "payment",
      method: "credit",
      amount,
      paidDate: today,
      reference: `Credit from ${invoiceRef(from.number)}`,
      idemKey: `credit-in:${key}`,
      byName: who.name,
    }),
    auditRow({ entityType: "payment", saleId: from.id, action: "credit_applied", detail: `${money(amount)} credit moved to ${invoiceRef(to.number)}.`, who }),
    auditRow({ entityType: "payment", saleId: to.id, action: "credit_applied", detail: `${money(amount)} paid from the credit on ${invoiceRef(from.number)}.`, who }),
    ...flags,
  ]);
}

/** Undo a payment or refund typed in by mistake. The row stays; a reversal row cancels it. Once only. */
export async function reversePayment(input: { paymentId: number; reason: string }, who: Who) {
  const [p] = await db.select().from(schema.tradePayments).where(eq(schema.tradePayments.id, input.paymentId));
  if (!p) throw notFound("Payment not found");
  if (p.kind !== "payment" && p.kind !== "refund") throw bad("A reversal cannot itself be reversed. Record a new payment instead.");
  if (p.method === "credit") throw bad("A credit transfer is undone by applying the credit back.");
  if (!input.reason.trim()) throw bad("Say why it is being reversed.");
  const s = await saleRow(p.saleId);
  const kind = p.kind === "payment" ? "payment_reversal" : "refund_reversal";
  await runGuarded([
    db.insert(schema.tradePayments).values({
      saleId: p.saleId,
      kind,
      method: p.method,
      amount: p.amount,
      paidDate: ymd(),
      reference: `Reverses #${p.id}: ${input.reason.trim()}`.slice(0, 200),
      reversesId: p.id,
      idemKey: `rev:${p.id}`,
      byName: who.name,
    }),
    auditRow({
      entityType: "payment",
      entityId: p.id,
      saleId: p.saleId,
      action: kind,
      detail: `${invoiceRef(s.number)}: ${p.kind} of ${money(p.amount)} (${p.method}, ${p.reference}) reversed. ${input.reason.trim()}`,
      who,
    }),
  ]);
}

/* ------------------------------- credit notes ------------------------------ */

export type CreditLineInput = { saleLineId: number; qty: number };

/**
 * A credit note: S188000-2, S188000-3 and so on, linked to the original,
 * which never changes. Each line is capped at what is left to credit on it.
 * GST is worked per line. A credit after a confirmed offset leaves a credit
 * balance for Admin to refund, keep, or reverse part of the offset.
 */
export async function createCredit(input: { saleId: number; reason: string; lines: CreditLineInput[]; key: string }, who: Who) {
  const s = await finalisedSale(input.saleId);
  const key = cleanKey(input.key);
  if (!input.reason.trim()) throw bad("Say why the credit is given.");
  const wanted = input.lines.filter((l) => l.qty > 0);
  if (!wanted.length) throw bad("Pick at least one line to credit.");
  const lines = await db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, s.id));
  const done = await db
    .select({ saleLineId: schema.tradeCreditLines.saleLineId, qty: sql<number>`sum(${schema.tradeCreditLines.qty})`, ex: sql<number>`sum(${schema.tradeCreditLines.lineExGst})`, gst: sql<number>`sum(${schema.tradeCreditLines.gstAmount})` })
    .from(schema.tradeCreditLines)
    .innerJoin(schema.tradeCreditNotes, eq(schema.tradeCreditNotes.id, schema.tradeCreditLines.creditId))
    .where(eq(schema.tradeCreditNotes.saleId, s.id))
    .groupBy(schema.tradeCreditLines.saleLineId);
  const doneOf = new Map(done.map((d) => [d.saleLineId, { qty: Number(d.qty), ex: Number(d.ex), gst: Number(d.gst) }]));
  const rows: Array<{ saleLineId: number; qty: number; ex: number; gst: number }> = [];
  for (const w of wanted) {
    const l = lines.find((x) => x.id === w.saleLineId);
    if (!l) throw notFound("Line not found on this sale");
    const prev = doneOf.get(l.id) ?? { qty: 0, ex: 0, gst: 0 };
    const left = q3(l.qty - prev.qty);
    const qty = q3(w.qty);
    if (qty > left + 0.0005) throw bad(`${l.description}: only ${left} ${l.unitLabel || l.sellUnit} left to credit.`);
    const full = Math.abs(qty - left) < 0.0005;
    // The last credit on a line takes exactly what is left, so cents never drift.
    const ex = full ? round2(l.lineExGst - prev.ex) : round2((l.lineExGst * qty) / l.qty);
    const gst = full ? round2(l.gstAmount - prev.gst) : round2((ex * l.gstRate) / 100);
    if (ex < 0 || gst < 0) throw bad(`${l.description}: nothing left to credit.`);
    rows.push({ saleLineId: l.id, qty, ex, gst });
  }
  const subtotal = round2(rows.reduce((t, r) => t + r.ex, 0));
  const gst = round2(rows.reduce((t, r) => t + r.gst, 0));
  const total = round2(subtotal + gst);
  if (!(total > 0)) throw bad("Nothing to credit.");
  const idem = `credit:${key}`;
  const m = await oneSaleMoney(s.id);
  const ref = invoiceRef(s.number);
  const flags = await flagOffsetStmts(s.id, round2(m.balance - total), `A credit note for ${money(total)} was raised.`, ref);
  const creditId = sql`(select id from trade_credit_notes where idem_key = ${idem})`;
  await runGuarded([
    db.run(sql`insert into trade_credit_notes (sale_id, seq, reason, subtotal, gst, total, idem_key, created_by_name, created_at, updated_at)
      select ${s.id}, coalesce(max(seq), 1) + 1, ${input.reason.trim().slice(0, 500)}, ${subtotal}, ${gst}, ${total}, ${idem}, ${who.name}, unixepoch(), unixepoch()
      from trade_credit_notes where sale_id = ${s.id}`),
    ...rows.map((r) =>
      db.run(sql`insert into trade_credit_lines (credit_id, sale_line_id, qty, line_ex_gst, gst_amount, line_inc_gst, created_at, updated_at)
        values (${creditId}, ${r.saleLineId}, ${r.qty}, ${r.ex}, ${r.gst}, ${round2(r.ex + r.gst)}, unixepoch(), unixepoch())`),
    ),
    // Re-checked inside the write: no line credited past its qty, money or GST.
    ...rows.map((r) =>
      guard(sql`(select coalesce(sum(qty), 0) from trade_credit_lines where sale_line_id = ${r.saleLineId}) <= (select qty from trade_sale_lines where id = ${r.saleLineId}) + 0.0005
        and (select coalesce(sum(line_ex_gst), 0) from trade_credit_lines where sale_line_id = ${r.saleLineId}) <= (select line_ex_gst from trade_sale_lines where id = ${r.saleLineId}) + 0.005`),
    ),
    db.run(sql`insert into trade_audit (entity_type, entity_id, sale_id, action, detail, actor_name, actor_role, created_at)
      select 'credit', id, ${s.id}, 'credit_note', 'CREDIT NOTE S' || ${s.number} || '-' || seq || ' for $' || printf('%.2f', total) || ' against ' || ${ref} || '. ' || reason, ${who.name}, ${who.role}, unixepoch()
      from trade_credit_notes where idem_key = ${idem}`),
    ...flags,
  ]);
  const [c] = await db.select().from(schema.tradeCreditNotes).where(eq(schema.tradeCreditNotes.idemKey, idem));
  return { creditId: c!.id, seq: c!.seq, total };
}

/* ------------------------- collection and dispatch ------------------------ */

/**
 * Goods leave the warehouse, once per sale. Takes stock out per line in the
 * product's own unit. Pay before collection is enforced unless the sale is
 * settled or Admin recorded an arrangement. Going below zero needs a reason
 * from Admin and the product is then flagged until a count fixes it.
 */
export async function fulfil(input: { saleId: number; method: "collected" | "dispatched"; overrideReason?: string | null }, who: Who) {
  const s = await finalisedSale(input.saleId);
  const [already] = await db.select().from(schema.tradeFulfilments).where(eq(schema.tradeFulfilments.saleId, s.id));
  if (already) return { already: true };
  const m = await oneSaleMoney(s.id);
  if (s.payBeforeCollection && m.balance > 0.005 && !s.arrangementNote) {
    throw bad(`${money(m.balance)} is still owing and this buyer pays before collection. Take payment, or record an arrangement first.`);
  }
  const lines = (await db.select().from(schema.tradeSaleLines).where(eq(schema.tradeSaleLines.saleId, s.id))).filter((l) => l.kind === "product" && l.productId);
  const credited = await db
    .select({ saleLineId: schema.tradeCreditLines.saleLineId, qty: sql<number>`sum(${schema.tradeCreditLines.qty})` })
    .from(schema.tradeCreditLines)
    .innerJoin(schema.tradeCreditNotes, eq(schema.tradeCreditNotes.id, schema.tradeCreditLines.creditId))
    .where(eq(schema.tradeCreditNotes.saleId, s.id))
    .groupBy(schema.tradeCreditLines.saleLineId);
  const credOf = new Map(credited.map((c) => [c.saleLineId, Number(c.qty)]));
  const outs = lines
    .map((l) => ({ l, sellQty: q3(l.qty - (credOf.get(l.id) ?? 0)), stockQty: q3((l.qty - (credOf.get(l.id) ?? 0)) * (l.stockPerSellUnit ?? 1)) }))
    .filter((o) => o.stockQty > 0);
  const need = new Map<number, number>();
  for (const o of outs) need.set(o.l.productId!, q3((need.get(o.l.productId!) ?? 0) + o.stockQty));
  const onHand = await onHandFor([...need.keys()]);
  const short = [...need.entries()].filter(([pid, q]) => (onHand.get(pid) ?? 0) - q < -0.0005);
  const reason = (input.overrideReason ?? "").trim();
  if (short.length && !reason) {
    const names = short.map(([pid, q]) => {
      const l = outs.find((o) => o.l.productId === pid)!.l;
      return `${l.description} ${l.detail} needs ${q} ${l.stockUnit ?? ""}, ${onHand.get(pid) ?? 0} on hand`.replace(/\s+/g, " ").trim();
    });
    throw bad(`Not enough stock: ${names.join("; ")}. Admin can override with a reason, and the product is flagged negative until a count fixes it.`);
  }
  const fid = sql`(select id from trade_fulfilments where sale_id = ${s.id})`;
  const stmts: BatchItem<"sqlite">[] = [
    db.insert(schema.tradeFulfilments).values({ saleId: s.id, method: input.method, stockOverrideReason: short.length ? reason.slice(0, 500) : null, byName: who.name }),
  ];
  for (const o of outs) {
    stmts.push(
      movementStmt({
        productId: o.l.productId!,
        kind: "trade_out",
        qty: -o.stockQty,
        note: `${invoiceRef(s.number)} ${input.method} by ${s.billName}`,
        who,
      }),
      db.run(sql`insert into trade_stock_links (movement_id, sale_id, sale_line_id, fulfilment_id, created_at)
        values (${lastMovementIdSql(o.l.productId!)}, ${s.id}, ${o.l.id}, ${fid}, unixepoch())`),
    );
  }
  if (!short.length) {
    // Re-checked inside the write: someone else may have taken the same stock a moment ago.
    for (const pid of need.keys()) stmts.push(guard(sql`coalesce((select sum(qty) from stock_movements where product_id = ${pid}), 0) >= -0.0005`));
  }
  stmts.push(
    auditRow({
      entityType: "fulfilment",
      saleId: s.id,
      action: input.method,
      detail: `${invoiceRef(s.number)} ${input.method}. ${outs.map((o) => `${o.l.description} ${o.sellQty} ${o.l.unitLabel || o.l.sellUnit}`).join(", ") || "No stock lines"}.${short.length ? ` Stock override: ${reason}` : ""}${s.payBeforeCollection && m.balance > 0.005 ? ` Collected on arrangement: ${s.arrangementNote}` : ""}`,
      who,
    }),
  );
  try {
    await runGuarded(stmts);
  } catch (e) {
    const [again] = await db.select().from(schema.tradeFulfilments).where(eq(schema.tradeFulfilments.saleId, s.id));
    if (again) return { already: true };
    if (e instanceof Error && /figures changed/.test(e.message)) throw conflict("Stock changed while saving. Nothing was taken out. Reload and try again.");
    throw e;
  }
  return { already: false };
}

/** Collected or dispatched is a label. Switching it moves no stock. */
export async function setFulfilmentMethod(saleId: number, method: "collected" | "dispatched", who: Who) {
  const [f] = await db.select().from(schema.tradeFulfilments).where(eq(schema.tradeFulfilments.saleId, saleId));
  if (!f) throw bad("Nothing has been collected or dispatched yet.");
  if (f.method === method) return;
  const s = await saleRow(saleId);
  await runGuarded([
    db.update(schema.tradeFulfilments).set({ method, updatedAt: new Date() }).where(eq(schema.tradeFulfilments.id, f.id)),
    auditRow({ entityType: "fulfilment", entityId: f.id, saleId, action: "fulfilment_label", detail: `${invoiceRef(s.number)}: ${f.method} changed to ${method}. Label only, no stock moved.`, who }),
  ]);
}

/** Goods back on the shelf, fit to sell. Capped at what went out less what already came back. No money moves. */
export async function recordReturn(input: { saleId: number; saleLineId: number; qty: number; reason: string; key: string }, who: Who) {
  const s = await finalisedSale(input.saleId);
  const key = cleanKey(input.key);
  if (!input.reason.trim()) throw bad("Say why it came back.");
  const [l] = await db.select().from(schema.tradeSaleLines).where(and(eq(schema.tradeSaleLines.id, input.saleLineId), eq(schema.tradeSaleLines.saleId, s.id)));
  if (!l || l.kind !== "product" || !l.productId) throw notFound("Product line not found on this sale");
  const per = l.stockPerSellUnit ?? 1;
  const [{ out }] = (await db.all<{ out: number }>(sql`select coalesce(-sum(m.qty), 0) as out from trade_stock_links k join stock_movements m on m.id = k.movement_id where k.sale_line_id = ${l.id} and k.fulfilment_id is not null`)) as [{ out: number }];
  const [{ back }] = (await db.all<{ back: number }>(sql`select coalesce(sum(qty), 0) as back from trade_returns where sale_line_id = ${l.id}`)) as [{ back: number }];
  const collected = q3(Number(out) / per);
  const left = q3(collected - Number(back));
  const qty = q3(input.qty);
  if (!(qty > 0)) throw bad("Enter the quantity returned.");
  if (collected <= 0) throw bad("Nothing on this line has gone out yet.");
  if (qty > left + 0.0005) throw bad(`Only ${left} ${l.unitLabel || l.sellUnit} can still come back on this line.`);
  const idem = `return:${key}`;
  const rid = sql`(select id from trade_returns where idem_key = ${idem})`;
  await runGuarded([
    db.insert(schema.tradeReturns).values({ saleId: s.id, saleLineId: l.id, qty, reason: input.reason.trim().slice(0, 500), idemKey: idem, byName: who.name }),
    guard(sql`(select coalesce(sum(qty), 0) from trade_returns where sale_line_id = ${l.id}) <= ${collected} + 0.0005`),
    movementStmt({ productId: l.productId, kind: "trade_return", qty: q3(qty * per), note: `${invoiceRef(s.number)} return: ${input.reason.trim()}`, who }),
    db.run(sql`insert into trade_stock_links (movement_id, sale_id, sale_line_id, return_id, created_at) values (${lastMovementIdSql(l.productId)}, ${s.id}, ${l.id}, ${rid}, unixepoch())`),
    auditRow({ entityType: "return", saleId: s.id, action: "return", detail: `${invoiceRef(s.number)}: ${qty} ${l.unitLabel || l.sellUnit} of ${l.description} back on the shelf. ${input.reason.trim()}. No credit given by this.`, who }),
  ]);
}

/* ------------------------- arrangement and cancel ------------------------- */

/** Admin agrees a buyer who pays before collection may take the goods first. */
export async function setArrangement(saleId: number, note: string, who: Who) {
  const s = await finalisedSale(saleId);
  if (!note.trim()) throw bad("Write down what was agreed.");
  await runGuarded([
    db
      .update(schema.tradeSales)
      .set({ arrangementNote: note.trim().slice(0, 500), arrangementByName: who.name, arrangementAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.tradeSales.id, s.id)),
    auditRow({ entityType: "sale", entityId: s.id, saleId: s.id, action: "arrangement", detail: `${invoiceRef(s.number)}: arrangement recorded. ${note.trim()}`, who }),
  ]);
}

/** Cancel a draft, or a finalised sale nothing has happened to. The record and its number stay. */
export async function cancelSale(saleId: number, reason: string, who: Who) {
  const s = await saleRow(saleId);
  if (s.status === "cancelled") return;
  if (!reason.trim()) throw bad("Say why it is cancelled.");
  if (s.status === "finalised") {
    const [f] = await db.select({ id: schema.tradeFulfilments.id }).from(schema.tradeFulfilments).where(eq(schema.tradeFulfilments.saleId, s.id));
    if (f) throw bad("Goods have gone out on this sale. Use a credit note and a return instead.");
    const [p] = await db.select({ id: schema.tradePayments.id }).from(schema.tradePayments).where(eq(schema.tradePayments.saleId, s.id)).limit(1);
    const [c] = await db.select({ id: schema.tradeCreditNotes.id }).from(schema.tradeCreditNotes).where(eq(schema.tradeCreditNotes.saleId, s.id)).limit(1);
    const [o] = await db
      .select({ id: schema.tradeOffsets.id })
      .from(schema.tradeOffsets)
      .where(and(eq(schema.tradeOffsets.saleId, s.id), inArray(schema.tradeOffsets.status, ["proposed", "approved", "confirmed", "reversed"])))
      .limit(1);
    if (p || c || o) throw bad("Money or an offset has been recorded on this sale. Use a credit note instead.");
  }
  await runGuarded([
    guard(sql`(select count(*) from trade_fulfilments where sale_id = ${s.id}) = 0 and (select count(*) from trade_payments where sale_id = ${s.id}) = 0
      and (select count(*) from installer_bill_settlements where sale_id = ${s.id}) = 0`),
    db
      .update(schema.tradeSales)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledByName: who.name, cancelReason: reason.trim().slice(0, 500), rev: sql`rev + 1`, updatedAt: new Date() })
      .where(eq(schema.tradeSales.id, s.id)),
    auditRow({ entityType: "sale", entityId: s.id, saleId: s.id, action: "cancelled", detail: `${s.number > 0 ? invoiceRef(s.number) : `Draft ${s.id}`} cancelled. ${reason.trim()}`, who }),
  ]);
}
