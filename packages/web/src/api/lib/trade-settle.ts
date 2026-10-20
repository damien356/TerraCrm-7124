import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../database";
import * as schema from "../database/schema";
import { round2 } from "./pricing";
import { putObject, signGet } from "./s3";
import {
  auditRow,
  bad,
  billMoney,
  billRemainingSql,
  buyerView,
  guard,
  money,
  normAbn,
  notFound,
  oneSaleMoney,
  requireTradeOn,
  runGuarded,
  saleBalanceSql,
  ymd,
  type Who,
} from "./trade-core";
import { invoiceRef } from "./trade-pricing";

/* ---------------------------------------------------------------------------
 * Materials offsets against an installer's bill, and the bill's own money
 * rows (notes 18.65, answers B and C).
 *
 *   proposed  ->  approved  ->  confirmed  (->  reversed, only while unpaid)
 *        \-----------\----> cancelled
 *
 * An offset needs: an installer buyer whose card ABN Admin verified as the
 * same entity, the sale and the bill on that same ABN, and a signed file
 * (uploaded on the offset, or an in-date standing agreement on the card).
 * Confirm re-reads both balances inside the write and takes at most the
 * smaller one. While an offset is proposed or approved, that bill cannot be
 * scheduled or marked paid. The bill's total never changes: settlement rows
 * carry the offsets and the cash, and the remaining is worked from them.
 *
 * Office sees the ref, the amount and the net on the bill, nothing else, and
 * cannot approve or change an offset.
 * ------------------------------------------------------------------------- */

const OPEN = ["proposed", "approved"] as const;
const MAX_FILE = 8 * 1024 * 1024;

async function offsetRow(id: number) {
  const [o] = await db.select().from(schema.tradeOffsets).where(eq(schema.tradeOffsets.id, id));
  if (!o) throw notFound("Offset not found");
  return o;
}

async function saleRow(id: number) {
  const [s] = await db.select().from(schema.tradeSales).where(eq(schema.tradeSales.id, id));
  if (!s) throw notFound("Sale not found");
  return s;
}

async function billRow(id: number) {
  const [b] = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.id, id));
  if (!b) throw notFound("Bill not found");
  return b;
}

const billLabel = (b: { invoiceNumber: number | string; jobNumber: number | string | null }) => `bill #${b.invoiceNumber}${b.jobNumber ? ` (job ${b.jobNumber})` : ""}`;

const fileOk = (f: { filename: string; base64: string; mime: string }) => {
  const buf = Buffer.from(f.base64, "base64");
  if (!buf.length) throw bad("The file is empty.");
  if (buf.length > MAX_FILE) throw bad("The file is over 8 MB.");
  if (!/^(application\/pdf|image\/(png|jpeg|heic|webp))$/.test(f.mime)) throw bad("Upload a PDF or a photo.");
  return buf;
};

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "agreement.pdf";

/* ------------------------------- agreements ------------------------------- */

export async function listAgreements(installerId: number) {
  const rows = await db
    .select()
    .from(schema.installerAgreements)
    .where(eq(schema.installerAgreements.installerId, installerId))
    .orderBy(desc(schema.installerAgreements.id));
  const today = ymd();
  return rows.map((a) => ({ ...a, inDate: agreementInDate(a, today) }));
}

const agreementInDate = (a: { archivedAt: Date | null; signedDate: string; validUntil: string | null }, today: string) =>
  !a.archivedAt && a.signedDate <= today && (!a.validUntil || a.validUntil >= today);

export async function addAgreement(
  input: { installerId: number; title: string; signedDate: string; validUntil: string | null; note: string; file: { filename: string; base64: string; mime: string } },
  who: Who,
) {
  const [i] = await db.select({ id: schema.installers.id }).from(schema.installers).where(eq(schema.installers.id, input.installerId));
  if (!i) throw notFound("Installer not found");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.signedDate)) throw bad("Pick the date it was signed.");
  if (input.validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil)) throw bad("Pick a valid until date, or leave it blank.");
  if (input.validUntil && input.validUntil < input.signedDate) throw bad("Valid until is before the signed date.");
  const buf = fileOk(input.file);
  const name = safeName(input.file.filename);
  const key = `trade/agreements/${input.installerId}/${Date.now()}-${name}`;
  await putObject(key, buf, input.file.mime, name);
  await runGuarded([
    db.insert(schema.installerAgreements).values({
      installerId: input.installerId,
      kind: "standing_offset",
      title: input.title.trim().slice(0, 200) || "Standing offset agreement",
      fileKey: key,
      filename: name,
      signedDate: input.signedDate,
      validUntil: input.validUntil || null,
      note: input.note.trim().slice(0, 1000),
      byName: who.name,
    }),
    auditRow({ entityType: "agreement", entityId: input.installerId, action: "agreement_added", detail: `Standing offset agreement ${name}, signed ${input.signedDate}${input.validUntil ? `, valid until ${input.validUntil}` : ""}.`, who }),
  ]);
}

export async function archiveAgreement(id: number, who: Who) {
  const [a] = await db.select().from(schema.installerAgreements).where(eq(schema.installerAgreements.id, id));
  if (!a) throw notFound("Agreement not found");
  if (a.archivedAt) return;
  await runGuarded([
    db.update(schema.installerAgreements).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(schema.installerAgreements.id, id)),
    auditRow({ entityType: "agreement", entityId: a.installerId, action: "agreement_archived", detail: `Agreement ${a.filename} archived. The file is kept.`, who }),
  ]);
}

export async function agreementUrl(id: number) {
  const [a] = await db.select().from(schema.installerAgreements).where(eq(schema.installerAgreements.id, id));
  if (!a) throw notFound("Agreement not found");
  return { url: await signGet(a.fileKey) };
}

export async function offsetFileUrl(offsetId: number) {
  const o = await offsetRow(offsetId);
  const key = o.agreementFileKey ?? (o.agreementId ? (await db.select().from(schema.installerAgreements).where(eq(schema.installerAgreements.id, o.agreementId)))[0]?.fileKey : null);
  if (!key) throw notFound("No file on this offset");
  return { url: await signGet(key) };
}

/* --------------------------------- offsets -------------------------------- */

/** Bills an offset can sit against: this installer's, not paid, not on a payment run. */
export async function billsForOffset(saleId: number) {
  const s = await saleRow(saleId);
  const buyer = await buyerView(s.buyerId);
  if (buyer.kind !== "installer") return [];
  const bills = await db
    .select()
    .from(schema.installerInvoices)
    .where(and(eq(schema.installerInvoices.installerId, buyer.refId), inArray(schema.installerInvoices.status, ["submitted", "approved"])))
    .orderBy(desc(schema.installerInvoices.id));
  const m = await billMoney(bills.map((b) => b.id));
  return bills.map((b) => ({
    id: b.id,
    invoiceNumber: b.invoiceNumber,
    jobNumber: b.jobNumber,
    status: b.status,
    total: b.total,
    remaining: m.get(b.id)?.remaining ?? b.total,
    abn: b.abn,
    abnMatches: !!normAbn(b.abn) && normAbn(b.abn) === normAbn(buyer.entityAbn),
  }));
}

export async function proposeOffset(input: { saleId: number; billId: number; amount: number }, who: Who) {
  await requireTradeOn();
  const s = await saleRow(input.saleId);
  if (s.status !== "finalised") throw bad("Finalise the sale first.");
  const buyer = await buyerView(s.buyerId);
  if (buyer.kind !== "installer") throw bad("Offsets are for subcontractor installers only. External buyers pay.");
  const b = await billRow(input.billId);
  if (b.installerId !== buyer.refId) throw bad("That bill is from a different installer.");
  if (b.status !== "submitted" && b.status !== "approved") throw bad("That bill is already on a payment run or paid. Pick an open bill.");
  const amount = round2(input.amount);
  if (!(amount > 0)) throw bad("Enter the amount to take off the bill.");
  const sm = await oneSaleMoney(s.id);
  const bm = (await billMoney([b.id])).get(b.id)!;
  if (amount > sm.balance + 0.005) throw bad(`Only ${money(Math.max(0, sm.balance))} is owing on ${invoiceRef(s.number)}.`);
  if (amount > bm.remaining + 0.005) throw bad(`Only ${money(Math.max(0, bm.remaining))} is left to pay on ${billLabel(b)}.`);
  await runGuarded([
    db.insert(schema.tradeOffsets).values({ saleId: s.id, installerId: buyer.refId, billId: b.id, status: "proposed", amount, proposedByName: who.name }),
    auditRow({ entityType: "offset", saleId: s.id, billId: b.id, action: "offset_proposed", detail: `Proposed: take ${money(amount)} for ${invoiceRef(s.number)} off ${billLabel(b)}. That bill cannot be paid until this is confirmed or cancelled.`, who }),
  ]).catch((e) => {
    if (/Already done/.test(String(e?.message))) throw bad("This sale already has an offset waiting. Confirm or cancel it first.");
    throw e;
  });
}

export async function approveOffset(
  input: { offsetId: number; agreementRef: string; agreementId?: number | null; file?: { filename: string; base64: string; mime: string } | null },
  who: Who,
) {
  await requireTradeOn();
  const o = await offsetRow(input.offsetId);
  if (o.status !== "proposed") throw bad(`This offset is ${o.status}.`);
  if (o.conflict) throw bad(`Flagged: ${o.conflict}`);
  const s = await saleRow(o.saleId);
  const buyer = await buyerView(s.buyerId);
  if (!buyer.entityOk) throw bad("Verify same entity on the installer's trade tab first. It clears whenever the ABN changes.");
  const b = await billRow(o.billId!);
  if (normAbn(s.billAbn) !== normAbn(buyer.entityAbn)) throw bad(`The sale was billed to ABN ${s.billAbn || "blank"}, not the verified ${buyer.entityAbn}. No offset.`);
  if (normAbn(b.abn) !== normAbn(buyer.entityAbn)) throw bad(`${billLabel(b)} is on ABN ${b.abn || "blank"}, not the verified ${buyer.entityAbn}. No offset.`);
  if (!input.agreementRef.trim()) throw bad("Add the agreement reference.");
  let fileKey: string | null = null;
  let filename: string | null = null;
  let agreementId: number | null = null;
  if (input.file) {
    const buf = fileOk(input.file);
    filename = safeName(input.file.filename);
    fileKey = `trade/offsets/${o.id}/${Date.now()}-${filename}`;
    await putObject(fileKey, buf, input.file.mime, filename);
  } else if (input.agreementId) {
    const [a] = await db.select().from(schema.installerAgreements).where(eq(schema.installerAgreements.id, input.agreementId));
    if (!a || a.installerId !== o.installerId) throw bad("That agreement is not on this installer's card.");
    if (!agreementInDate(a, ymd())) throw bad("That agreement is archived or out of date. Upload a signed file instead.");
    agreementId = a.id;
  } else {
    throw bad("Upload the signed agreement, or pick an in-date standing agreement from the installer card.");
  }
  await runGuarded([
    guard(sql`(select status from trade_offsets where id = ${o.id}) = 'proposed' and (select conflict from trade_offsets where id = ${o.id}) is null`),
    db
      .update(schema.tradeOffsets)
      .set({
        status: "approved",
        agreementRef: input.agreementRef.trim().slice(0, 200),
        agreementId,
        agreementFileKey: fileKey,
        agreementFilename: filename,
        approvedByName: who.name,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.tradeOffsets.id, o.id)),
    auditRow({
      entityType: "offset",
      entityId: o.id,
      saleId: o.saleId,
      billId: o.billId,
      action: "offset_approved",
      detail: `Approved ${money(o.amount)} off ${billLabel(b)}. Agreement ${input.agreementRef.trim()}, ${filename ? `file ${filename}` : `standing agreement #${agreementId}`}. Same entity ABN ${buyer.entityAbn}.`,
      who,
    }),
  ]);
}

/**
 * Confirm: the deduction is now real. Takes at most what is still owing on
 * the sale and still to pay on the bill, both re-read inside the write.
 */
export async function confirmOffset(input: { offsetId: number; xeroRef: string; amount?: number | null }, who: Who) {
  await requireTradeOn();
  const o = await offsetRow(input.offsetId);
  if (o.status === "confirmed") return { already: true };
  if (o.status !== "approved") throw bad(o.status === "proposed" ? "Approve it first." : `This offset is ${o.status}.`);
  if (o.conflict) throw bad(`Flagged: ${o.conflict}`);
  if (!input.xeroRef.trim()) throw bad("Add the Xero reference for the deduction.");
  const s = await saleRow(o.saleId);
  const b = await billRow(o.billId!);
  if (b.status === "paid" || b.status === "scheduled_for_payment") throw bad(`${billLabel(b)} is already ${b.status === "paid" ? "paid" : "on a payment run"}.`);
  const sm = await oneSaleMoney(s.id);
  const bm = (await billMoney([b.id])).get(b.id)!;
  const cap = round2(Math.min(sm.balance, bm.remaining));
  const amount = round2(input.amount ?? o.amount);
  if (!(amount > 0)) throw bad("Enter the amount.");
  if (amount > o.amount + 0.005) throw bad(`The approved amount is ${money(o.amount)}. Cancel and propose again for more.`);
  if (amount > cap + 0.005) throw bad(`At most ${money(Math.max(0, cap))} can be offset now (owing on the sale ${money(sm.balance)}, left on the bill ${money(bm.remaining)}).`);
  const today = ymd();
  try {
    await runGuarded([
      guard(sql`(select status from trade_offsets where id = ${o.id}) = 'approved' and (select conflict from trade_offsets where id = ${o.id}) is null
        and (select status from installer_invoices where id = ${b.id}) in ('submitted', 'approved')
        and ${saleBalanceSql(s.id)} >= ${amount} - 0.005 and ${billRemainingSql(b.id)} >= ${amount} - 0.005`),
      db.insert(schema.installerBillSettlements).values({
        billId: b.id,
        kind: "offset",
        amount,
        offsetId: o.id,
        saleId: s.id,
        paidDate: today,
        reference: `${invoiceRef(s.number)} Xero ${input.xeroRef.trim()}`.slice(0, 200),
        idemKey: `offset:${o.id}`,
        byName: who.name,
      }),
      db
        .update(schema.tradeOffsets)
        .set({ status: "confirmed", confirmedAmount: amount, xeroRef: input.xeroRef.trim().slice(0, 100), confirmedByName: who.name, confirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.tradeOffsets.id, o.id)),
      auditRow({
        entityType: "offset",
        entityId: o.id,
        saleId: s.id,
        billId: b.id,
        action: "offset_confirmed",
        detail: `Confirmed: ${money(amount)} for ${invoiceRef(s.number)} taken off ${billLabel(b)}. Non cash. Xero ${input.xeroRef.trim()}.`,
        who,
      }),
    ]);
  } catch (e) {
    const again = await offsetRow(o.id);
    if (again.status === "confirmed") return { already: true };
    throw e;
  }
  return { already: false };
}

export async function cancelOffset(input: { offsetId: number; reason: string }, who: Who) {
  const o = await offsetRow(input.offsetId);
  if (o.status === "cancelled") return;
  if (!(OPEN as readonly string[]).includes(o.status)) throw bad("A confirmed offset is undone with a reversal, not a cancel.");
  if (!input.reason.trim()) throw bad("Say why.");
  await runGuarded([
    guard(sql`(select status from trade_offsets where id = ${o.id}) in ('proposed', 'approved')`),
    db
      .update(schema.tradeOffsets)
      .set({ status: "cancelled", cancelledByName: who.name, cancelledAt: new Date(), cancelReason: input.reason.trim().slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.tradeOffsets.id, o.id)),
    auditRow({ entityType: "offset", entityId: o.id, saleId: o.saleId, billId: o.billId, action: "offset_cancelled", detail: `Offset ${money(o.amount)} cancelled. ${input.reason.trim()}. The bill can be paid again.`, who }),
  ]);
}

/**
 * Undo all or part of a confirmed offset, only while the bill is unpaid. The
 * money goes back on the sale and back on the bill. Once per offset.
 */
export async function reverseOffset(input: { offsetId: number; amount: number; reason: string }, who: Who) {
  const o = await offsetRow(input.offsetId);
  if (o.status !== "confirmed") throw bad("Only a confirmed offset can be reversed.");
  if (!input.reason.trim()) throw bad("Say why.");
  const [row] = await db
    .select()
    .from(schema.installerBillSettlements)
    .where(and(eq(schema.installerBillSettlements.offsetId, o.id), eq(schema.installerBillSettlements.kind, "offset")));
  if (!row) throw notFound("Offset settlement not found");
  const b = await billRow(row.billId);
  if (b.status === "paid" || b.status === "scheduled_for_payment") throw bad(`${billLabel(b)} is ${b.status === "paid" ? "paid" : "on a payment run"}, so the offset stays. Settle the difference with a refund or a credit.`);
  const amount = round2(input.amount);
  if (!(amount > 0) || amount > row.amount + 0.005) throw bad(`Reverse between $0.01 and ${money(row.amount)}.`);
  const full = Math.abs(amount - row.amount) < 0.005;
  const s = await saleRow(o.saleId);
  await runGuarded([
    guard(sql`(select status from installer_invoices where id = ${b.id}) in ('submitted', 'approved')`),
    db.insert(schema.installerBillSettlements).values({
      billId: b.id,
      kind: "offset_reversal",
      amount,
      offsetId: o.id,
      saleId: o.saleId,
      paidDate: ymd(),
      reference: `Reverses ${invoiceRef(s.number)} offset`,
      reversesId: row.id,
      reason: input.reason.trim().slice(0, 500),
      idemKey: `offset-rev:${row.id}`,
      byName: who.name,
    }),
    ...(full ? [db.update(schema.tradeOffsets).set({ status: "reversed", updatedAt: new Date() }).where(eq(schema.tradeOffsets.id, o.id))] : []),
    auditRow({
      entityType: "offset",
      entityId: o.id,
      saleId: o.saleId,
      billId: b.id,
      action: "offset_reversed",
      detail: `${full ? "Reversed" : "Part reversed"} ${money(amount)} of the ${money(row.amount)} offset for ${invoiceRef(s.number)} on ${billLabel(b)}. ${input.reason.trim()}`,
      who,
    }),
  ]).catch((e) => {
    if (/Already done/.test(String(e?.message))) throw bad("This offset has already been reversed once.");
    throw e;
  });
}

/* --------------------------- bill status and cash -------------------------- */

/** Why a bill cannot move to scheduled or paid now, or null. */
export async function billPaymentBlock(billId: number) {
  const open = await db
    .select({ id: schema.tradeOffsets.id, saleId: schema.tradeOffsets.saleId, amount: schema.tradeOffsets.amount, status: schema.tradeOffsets.status })
    .from(schema.tradeOffsets)
    .where(and(eq(schema.tradeOffsets.billId, billId), inArray(schema.tradeOffsets.status, [...OPEN])));
  if (!open.length) return null;
  const sales = await db.select({ id: schema.tradeSales.id, number: schema.tradeSales.number }).from(schema.tradeSales).where(inArray(schema.tradeSales.id, open.map((o) => o.saleId)));
  const ref = (id: number) => invoiceRef(sales.find((x) => x.id === id)?.number ?? 0);
  return `On hold: a materials offset (${open.map((o) => `${ref(o.saleId)} ${money(o.amount)}`).join(", ")}) is waiting for Admin. This bill cannot be scheduled or paid until it is confirmed or cancelled.`;
}

/**
 * The writes that go with moving a bill's status. Mark paid records one cash
 * row for what is left to pay (zero when offsets covered it all). Moving a
 * paid bill back reverses its last cash row. Same batch as the status change,
 * guarded on the old status, so a double click records once.
 */
export async function billStatusStmts(billId: number, to: string, who: Who): Promise<{ stmts: BatchItem<"sqlite">[]; noop: boolean }> {
  const b = await billRow(billId);
  const from = b.status;
  if (from === to) return { stmts: [], noop: true };
  if (to === "paid" || to === "scheduled_for_payment") {
    const block = await billPaymentBlock(billId);
    if (block) throw bad(block);
  }
  const stmts: BatchItem<"sqlite">[] = [
    guard(sql`(select status from installer_invoices where id = ${billId}) = ${from}`),
    guard(sql`(select count(*) from trade_offsets where bill_id = ${billId} and status in ('proposed', 'approved')) = 0 or ${to} not in ('paid', 'scheduled_for_payment')`),
  ];
  const [{ revs }] = (await db.all<{ revs: number }>(sql`select count(*) as revs from installer_bill_settlements where bill_id = ${billId} and kind = 'cash_reversal'`)) as [{ revs: number }];
  if (to === "paid") {
    const m = (await billMoney([billId])).get(billId)!;
    const amount = round2(Math.max(0, m.remaining));
    stmts.push(
      db.run(sql`insert into installer_bill_settlements (bill_id, kind, amount, paid_date, reference, idem_key, by_name, created_at, updated_at)
        values (${billId}, 'cash', max(0, round(${billRemainingSql(billId)}, 2)), ${ymd()}, ${`Marked paid by ${who.name}`}, ${`bill:${billId}:paid:${Number(revs)}`}, ${who.name}, unixepoch(), unixepoch())`),
      auditRow({ entityType: "bill", entityId: billId, billId, action: "bill_paid", detail: `Bill #${b.invoiceNumber} marked paid: cash ${money(amount)}${m.offsets ? ` after ${money(m.offsets)} materials offset` : ""} on ${ymd()}.`, who }),
    );
  } else if (from === "paid") {
    const [last] = await db
      .select()
      .from(schema.installerBillSettlements)
      .where(
        and(
          eq(schema.installerBillSettlements.billId, billId),
          eq(schema.installerBillSettlements.kind, "cash"),
          sql`not exists (select 1 from installer_bill_settlements r where r.reverses_id = ${schema.installerBillSettlements.id})`,
        ),
      )
      .orderBy(desc(schema.installerBillSettlements.id))
      .limit(1);
    if (last) {
      stmts.push(
        db.insert(schema.installerBillSettlements).values({
          billId,
          kind: "cash_reversal",
          amount: last.amount,
          paidDate: ymd(),
          reference: `Reverses cash #${last.id}`,
          reversesId: last.id,
          reason: `Status moved from paid to ${to}`,
          idemKey: `bill:${billId}:unpaid:${last.id}`,
          byName: who.name,
        }),
      );
    }
    stmts.push(
      auditRow({
        entityType: "bill",
        entityId: billId,
        billId,
        action: "bill_unpaid",
        detail: last ? `Bill #${b.invoiceNumber} moved from paid to ${to}. Cash ${money(last.amount)} reversed.` : `Bill #${b.invoiceNumber} moved from paid to ${to}. It was paid before settlement records, so there is no cash row to reverse.`,
        who,
      }),
    );
  }
  return { stmts, noop: false };
}

/** What Office sees on each bill: materials refs and amounts, and the net. Nothing else. */
export async function officeBillLines(billIds: number[]) {
  const out = new Map<number, { offsets: Array<{ ref: string; amount: number; pending: boolean }>; net: number; netToPay: number; legacyPaid: boolean; onHold: boolean; cashPaid: number }>();
  if (!billIds.length) return out;
  const m = await billMoney(billIds);
  const offs = await db
    .select({ billId: schema.tradeOffsets.billId, status: schema.tradeOffsets.status, amount: schema.tradeOffsets.amount, confirmedAmount: schema.tradeOffsets.confirmedAmount, number: schema.tradeSales.number, id: schema.tradeOffsets.id })
    .from(schema.tradeOffsets)
    .innerJoin(schema.tradeSales, eq(schema.tradeSales.id, schema.tradeOffsets.saleId))
    .where(and(inArray(schema.tradeOffsets.billId, billIds), inArray(schema.tradeOffsets.status, ["proposed", "approved", "confirmed"])));
  const revs = offs.length
    ? await db
        .select({ offsetId: schema.installerBillSettlements.offsetId, amount: schema.installerBillSettlements.amount })
        .from(schema.installerBillSettlements)
        .where(and(inArray(schema.installerBillSettlements.offsetId, offs.map((o) => o.id)), eq(schema.installerBillSettlements.kind, "offset_reversal")))
    : [];
  for (const id of billIds) {
    const bm = m.get(id);
    if (!bm) continue;
    const mine = offs.filter((o) => o.billId === id);
    out.set(id, {
      offsets: mine.map((o) => ({
        ref: invoiceRef(o.number),
        amount: round2(o.status === "confirmed" ? (o.confirmedAmount ?? o.amount) - revs.filter((r) => r.offsetId === o.id).reduce((t, r) => t + r.amount, 0) : o.amount),
        pending: o.status !== "confirmed",
      })),
      net: round2(bm.total - bm.offsets),
      netToPay: bm.legacyPaid || bm.status === "paid" ? 0 : round2(Math.max(0, bm.remaining)),
      legacyPaid: bm.legacyPaid,
      onHold: mine.some((o) => o.status !== "confirmed"),
      cashPaid: bm.cash,
    });
  }
  return out;
}

/* ------------------------------- remittance ------------------------------- */

/** The remittance advice for a bill: original, materials offsets, cash and the net. */
export async function remittanceData(billId: number) {
  const b = await billRow(billId);
  const bm = (await billMoney([billId])).get(billId)!;
  const rows = await db.select().from(schema.installerBillSettlements).where(eq(schema.installerBillSettlements.billId, billId)).orderBy(schema.installerBillSettlements.id);
  const saleIds = [...new Set(rows.map((r) => r.saleId).filter((x): x is number => x != null))];
  const sales = saleIds.length ? await db.select({ id: schema.tradeSales.id, number: schema.tradeSales.number }).from(schema.tradeSales).where(inArray(schema.tradeSales.id, saleIds)) : [];
  const numOf = new Map(sales.map((s) => [s.id, s.number]));
  const reversed = new Map<number, number>();
  for (const r of rows) if (r.reversesId) reversed.set(r.reversesId, (reversed.get(r.reversesId) ?? 0) + r.amount);
  const offsets = rows
    .filter((r) => r.kind === "offset")
    .map((r) => ({ ref: invoiceRef(numOf.get(r.saleId!) ?? 0), date: r.paidDate, amount: round2(r.amount - (reversed.get(r.id) ?? 0)) }))
    .filter((r) => r.amount > 0.005);
  const cash = rows
    .filter((r) => r.kind === "cash")
    .map((r) => ({ date: r.paidDate, reference: r.reference, amount: round2(r.amount - (reversed.get(r.id) ?? 0)) }))
    .filter((r) => r.amount > 0.005 || r.amount === 0);
  const [inst] = await db.select().from(schema.installers).where(eq(schema.installers.id, b.installerId));
  return {
    billId: b.id,
    invoiceNumber: b.invoiceNumber,
    jobNumber: b.jobNumber,
    status: b.status,
    payee: b.tradingName || b.installerName,
    abn: b.abn,
    email: inst?.invoiceEmail?.trim() || inst?.email?.trim() || null,
    original: bm.total,
    offsets,
    offsetTotal: bm.offsets,
    cash,
    cashTotal: bm.cash,
    net: round2(bm.total - bm.offsets),
    remaining: bm.remaining,
    legacyPaid: bm.legacyPaid,
  };
}

/** Admin's bill view: every settlement row with the offset it came from. */
export async function billSettlementView(billId: number) {
  const b = await billRow(billId);
  const bm = (await billMoney([billId])).get(billId)!;
  const rows = await db.select().from(schema.installerBillSettlements).where(eq(schema.installerBillSettlements.billId, billId)).orderBy(schema.installerBillSettlements.id);
  const offsets = await db.select().from(schema.tradeOffsets).where(eq(schema.tradeOffsets.billId, billId)).orderBy(schema.tradeOffsets.id);
  const block = await billPaymentBlock(billId);
  return { bill: { id: b.id, invoiceNumber: b.invoiceNumber, jobNumber: b.jobNumber, status: b.status, total: b.total, payee: b.tradingName || b.installerName }, money: bm, rows, offsets, block };
}

/** Offsets waiting on Admin, for the trade home screen. */
export async function openOffsets() {
  const rows = await db
    .select({ o: schema.tradeOffsets, number: schema.tradeSales.number, billName: schema.tradeSales.billName })
    .from(schema.tradeOffsets)
    .innerJoin(schema.tradeSales, eq(schema.tradeSales.id, schema.tradeOffsets.saleId))
    .where(inArray(schema.tradeOffsets.status, [...OPEN]))
    .orderBy(desc(schema.tradeOffsets.id));
  return rows.map((r) => ({ ...r.o, ref: invoiceRef(r.number), buyerName: r.billName }));
}

