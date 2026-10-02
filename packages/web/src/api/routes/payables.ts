import { z } from "zod";
import { and, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly } from "../middleware/auth";
import { addDays, settleDate, SUPPLIER_TERMS, today } from "../lib/cashflow";
import { dedupeKey, invoiceExGst, markPaid, placeInvoice, round2, safeJson, squash } from "../lib/invoice-match";
import { AUTO_SEND_KEY, ingestPdf, sendInvoiceRequest } from "../lib/mail-agent";
import { gmailLink } from "../lib/gmail";
import { signGet } from "../lib/s3";

/**
 * SUPPLIERS OWED. What Terra owes each supplier, built from the invoices the
 * email agent read and the POs raised in Ops.
 *
 * Amounts owed are inc GST, because that is what leaves the bank. PO
 * comparisons are ex GST, because that is how a PO is written.
 */

type Inv = typeof schema.supplierInvoices.$inferSelect;

const signed = (i: Pick<Inv, "docType" | "totalIncGst">) => (i.docType === "credit" ? -1 : 1) * i.totalIncGst;
const dueOf = (i: Pick<Inv, "dueDate" | "invoiceDate">) =>
  i.dueDate ?? (i.invoiceDate ? settleDate(i.invoiceDate, SUPPLIER_TERMS.days, SUPPLIER_TERMS.eom) : null);
const groupKey = (supplierId: number | null, raw: string) => (supplierId ? `s:${supplierId}` : `n:${squash(raw)}`);

/** How an invoice and its PO sit together, in the words on the screen. */
function pairState(inv: Pick<Inv, "poId" | "matchStatus" | "checkedAt">) {
  if (!inv.poId) return "no_po" as const;
  if (inv.matchStatus === "matched") return "matched" as const;
  if (inv.matchStatus === "different") return inv.checkedAt ? ("checked" as const) : ("different" as const);
  return "no_po" as const;
}

async function autoSendOn() {
  const [s] = await db.select().from(schema.settings).where(eq(schema.settings.key, AUTO_SEND_KEY));
  return s?.value === "on";
}

/** A supplier email added after a request was drafted: the request can now go. */
async function refreshRequestEmails() {
  const stuck = await db
    .select({ id: schema.invoiceRequests.id, email: schema.suppliers.email })
    .from(schema.invoiceRequests)
    .innerJoin(schema.suppliers, eq(schema.suppliers.id, schema.invoiceRequests.supplierId))
    .where(eq(schema.invoiceRequests.status, "no_email"));
  for (const s of stuck) {
    if (!s.email) continue;
    await db.update(schema.invoiceRequests).set({ toAddress: s.email, status: "waiting_ok", updatedAt: new Date() }).where(eq(schema.invoiceRequests.id, s.id));
  }
}

export const payables = {
  /** One row per supplier, plus everything that needs a person. */
  owed: adminOnly.handler(async () => {
    await refreshRequestEmails();
    const now = today();
    const soon = addDays(now, 14);
    const suppliers = await db.select({ id: schema.suppliers.id, name: schema.suppliers.name, email: schema.suppliers.email }).from(schema.suppliers);
    const supName = new Map(suppliers.map((s) => [s.id, s.name]));

    const unpaid = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.payState, "unpaid"));
    const openPos = await db
      .select({
        id: schema.purchaseOrders.id,
        number: schema.purchaseOrders.number,
        supplierId: schema.purchaseOrders.supplierId,
        totalExGst: schema.purchaseOrders.totalExGst,
        sentAt: schema.purchaseOrders.sentAt,
        jobId: schema.purchaseOrders.jobId,
        jobNumber: schema.jobs.number,
      })
      .from(schema.purchaseOrders)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
      .where(eq(schema.purchaseOrders.status, "sent"));

    type Row = {
      key: string;
      supplierId: number | null;
      name: string;
      owedIncGst: number;
      overdueIncGst: number;
      dueSoonIncGst: number;
      nextDue: string | null;
      invoices: number;
      awaitingInvoice: number;
      awaitingExGst: number;
      needsYou: number;
      hasEmail: boolean;
    };
    const rows = new Map<string, Row>();
    const row = (supplierId: number | null, raw: string) => {
      const key = groupKey(supplierId, raw);
      let r = rows.get(key);
      if (!r) {
        r = {
          key,
          supplierId,
          name: (supplierId && supName.get(supplierId)) || raw || "Unknown supplier",
          owedIncGst: 0,
          overdueIncGst: 0,
          dueSoonIncGst: 0,
          nextDue: null,
          invoices: 0,
          awaitingInvoice: 0,
          awaitingExGst: 0,
          needsYou: 0,
          hasEmail: Boolean(supplierId && suppliers.find((s) => s.id === supplierId)?.email),
        };
        rows.set(key, r);
      }
      return r;
    };

    for (const i of unpaid) {
      const r = row(i.supplierId, i.supplierNameRaw);
      const amt = signed(i);
      const due = dueOf(i);
      r.owedIncGst += amt;
      r.invoices++;
      if (due && due < now) r.overdueIncGst += amt;
      else if (due && due <= soon) r.dueSoonIncGst += amt;
      if (due && due >= now && (!r.nextDue || due < r.nextDue)) r.nextDue = due;
      if (!i.supplierId || (pairState(i) === "no_po" && !i.checkedAt) || pairState(i) === "different") r.needsYou++;
    }
    // Open price checks count as something to look at on that supplier's row.
    const flags = await db.select({ supplierId: schema.priceFlags.supplierId }).from(schema.priceFlags).where(eq(schema.priceFlags.status, "open"));
    for (const f of flags) if (f.supplierId && rows.has(groupKey(f.supplierId, ""))) rows.get(groupKey(f.supplierId, ""))!.needsYou++;
    for (const p of openPos) {
      const r = row(p.supplierId, "");
      r.awaitingInvoice++;
      r.awaitingExGst += p.totalExGst;
    }

    /* -------------------------------- needs you -------------------------------- */
    const needsYou: Array<{
      kind: "no_po" | "different" | "unknown_supplier" | "request" | "late_invoice" | "mailbox";
      id: number;
      title: string;
      detail: string;
      supplierKey: string | null;
      amount: number | null;
      date: string | null;
    }> = [];
    for (const i of unpaid) {
      const st = pairState(i);
      const who = (i.supplierId && supName.get(i.supplierId)) || i.supplierNameRaw;
      if (!i.supplierId) {
        needsYou.push({ kind: "unknown_supplier", id: i.id, title: `${i.docType === "credit" ? "Credit" : "Invoice"} ${i.invoiceNumber} from ${who}`, detail: "Not a supplier in Ops. Pick which supplier this is.", supplierKey: groupKey(null, i.supplierNameRaw), amount: signed(i), date: i.invoiceDate });
      } else if (st === "no_po" && !i.checkedAt) {
        needsYou.push({ kind: "no_po", id: i.id, title: `${who} invoice ${i.invoiceNumber}`, detail: i.matchNote || "No PO found.", supplierKey: groupKey(i.supplierId, ""), amount: signed(i), date: i.invoiceDate });
      } else if (st === "different") {
        const diff = i.diffExGst ?? 0;
        needsYou.push({
          kind: "different",
          id: i.id,
          title: `${who} invoice ${i.invoiceNumber}, $${Math.abs(diff).toFixed(2)} ${diff > 0 ? "over" : "under"} the PO`,
          detail: i.matchNote.split(" | ").slice(1).join(" ") || i.matchNote,
          supplierKey: groupKey(i.supplierId, ""),
          amount: signed(i),
          date: i.invoiceDate,
        });
      }
    }
    const requests = await db
      .select()
      .from(schema.invoiceRequests)
      .where(inArray(schema.invoiceRequests.status, ["waiting_ok", "no_email"]))
      .orderBy(desc(schema.invoiceRequests.createdAt));
    for (const q of requests) {
      needsYou.push({
        kind: "request",
        id: q.id,
        title: `Missing invoice ${q.invoiceNumber} from ${q.supplierNameRaw}`,
        detail: q.status === "no_email" ? "On their statement but never received. No email on file for them yet." : `On their statement but never received. Request ready to send to ${q.toAddress}.`,
        supplierKey: groupKey(q.supplierId, q.supplierNameRaw),
        amount: q.amountIncGst,
        date: q.invoiceDate,
      });
    }
    const lateCut = Date.now() - 35 * 86_400_000;
    for (const p of openPos) {
      if (!p.sentAt || p.sentAt.getTime() > lateCut) continue;
      const days = Math.floor((Date.now() - p.sentAt.getTime()) / 86_400_000);
      needsYou.push({ kind: "late_invoice", id: p.id, title: `PO ${p.number} has no invoice yet`, detail: `Sent ${days} days ago to ${supName.get(p.supplierId) ?? "the supplier"}. Check it was delivered and billed.`, supplierKey: groupKey(p.supplierId, ""), amount: null, date: null });
    }
    const mailboxes = await db
      .select({ id: schema.mailAccounts.id, address: schema.mailAccounts.address, lastError: schema.mailAccounts.lastError, connected: schema.mailAccounts.refreshTokenSealed })
      .from(schema.mailAccounts);
    for (const m of mailboxes) {
      if (m.connected && m.lastError) needsYou.push({ kind: "mailbox", id: m.id, title: `Can't read ${m.address}`, detail: m.lastError, supplierKey: null, amount: null, date: null });
    }

    const list = [...rows.values()]
      .map((r) => ({ ...r, owedIncGst: round2(r.owedIncGst), overdueIncGst: round2(r.overdueIncGst), dueSoonIncGst: round2(r.dueSoonIncGst), awaitingExGst: round2(r.awaitingExGst) }))
      .sort((a, b) => b.overdueIncGst - a.overdueIncGst || b.owedIncGst - a.owedIncGst || a.name.localeCompare(b.name));
    return {
      today: now,
      totals: {
        owedIncGst: round2(list.reduce((a, r) => a + r.owedIncGst, 0)),
        overdueIncGst: round2(list.reduce((a, r) => a + r.overdueIncGst, 0)),
        dueSoonIncGst: round2(list.reduce((a, r) => a + r.dueSoonIncGst, 0)),
        awaitingExGst: round2(list.reduce((a, r) => a + r.awaitingExGst, 0)),
      },
      suppliers: list,
      needsYou,
      priceChecksOpen: flags.length,
      mailboxesConnected: mailboxes.filter((m) => m.connected).length,
      autoSend: await autoSendOn(),
    };
  }),

  /** One supplier: its POs next to their invoices, and invoices with no PO. */
  supplier: adminOnly.input(z.object({ key: z.string() })).handler(async ({ input }) => {
    const sid = input.key.startsWith("s:") ? Number(input.key.slice(2)) : null;
    const rawKey = input.key.startsWith("n:") ? input.key.slice(2) : null;
    if (!sid && !rawKey) throw new ORPCError("BAD_REQUEST", { message: "Bad supplier key" });
    const since = new Date(Date.now() - 365 * 86_400_000);
    const sinceIso = addDays(today(), -120);

    const [sup] = sid ? await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, sid)) : [];
    let invoices = sid
      ? await db
          .select()
          .from(schema.supplierInvoices)
          .where(and(eq(schema.supplierInvoices.supplierId, sid), or(eq(schema.supplierInvoices.payState, "unpaid"), gte(schema.supplierInvoices.invoiceDate, sinceIso), isNull(schema.supplierInvoices.invoiceDate))))
          .orderBy(desc(schema.supplierInvoices.invoiceDate))
      : await db.select().from(schema.supplierInvoices).where(isNull(schema.supplierInvoices.supplierId));
    if (rawKey) invoices = invoices.filter((i) => squash(i.supplierNameRaw) === rawKey);

    const pos = sid
      ? await db
          .select({ po: schema.purchaseOrders, jobNumber: schema.jobs.number, jobTitle: schema.jobs.title })
          .from(schema.purchaseOrders)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
          .where(and(eq(schema.purchaseOrders.supplierId, sid), inArray(schema.purchaseOrders.status, ["sent", "invoiced"]), gte(schema.purchaseOrders.createdAt, since)))
          .orderBy(desc(schema.purchaseOrders.createdAt))
      : [];
    // An invoice linked to an older PO still shows its PO.
    const missingPoIds = [...new Set(invoices.map((i) => i.poId).filter((x): x is number => !!x && !pos.some((p) => p.po.id === x)))];
    if (missingPoIds.length) {
      pos.push(
        ...(await db
          .select({ po: schema.purchaseOrders, jobNumber: schema.jobs.number, jobTitle: schema.jobs.title })
          .from(schema.purchaseOrders)
          .innerJoin(schema.jobs, eq(schema.jobs.id, schema.purchaseOrders.jobId))
          .where(inArray(schema.purchaseOrders.id, missingPoIds))),
      );
    }

    const now = today();
    const invOut = (i: Inv) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      docType: i.docType,
      invoiceDate: i.invoiceDate,
      dueDate: dueOf(i),
      dueDatePrinted: Boolean(i.dueDate),
      overdue: i.payState === "unpaid" && (dueOf(i) ?? "9999") < now,
      totalIncGst: signed(i),
      totalExGst: invoiceExGst(i),
      freightExGst: i.freightExGst,
      poRefRaw: i.poRefRaw,
      matchStatus: i.matchStatus,
      pair: pairState(i),
      matchNote: i.matchNote,
      diffExGst: i.diffExGst,
      payState: i.payState,
      paidNote: i.paidNote,
      checkedBy: i.checkedBy,
      hasPdf: Boolean(i.pdfKey),
    });

    const pairs = pos
      .map((p) => {
        const its = invoices.filter((i) => i.poId === p.po.id);
        const billed = round2(its.reduce((a, i) => a + (i.docType === "credit" ? -1 : 1) * invoiceExGst(i), 0));
        return {
          po: {
            id: p.po.id,
            number: p.po.number,
            jobId: p.po.jobId,
            jobNumber: p.jobNumber,
            jobTitle: p.jobTitle,
            totalExGst: p.po.totalExGst,
            freightExGst: p.po.freightExGst,
            sentAt: p.po.sentAt,
            status: p.po.status,
          },
          state: !its.length ? ("no_invoice" as const) : its.some((i) => pairState(i) === "different") ? ("different" as const) : its.every((i) => pairState(i) === "matched") ? ("matched" as const) : ("checked" as const),
          billedExGst: billed,
          invoices: its.map(invOut),
        };
      })
      .sort((a, b) => (b.po.sentAt?.getTime() ?? 0) - (a.po.sentAt?.getTime() ?? 0));

    const statements = sid
      ? await db.select().from(schema.supplierStatements).where(eq(schema.supplierStatements.supplierId, sid)).orderBy(desc(schema.supplierStatements.statementDate)).limit(3)
      : [];
    const requests = sid ? await db.select().from(schema.invoiceRequests).where(eq(schema.invoiceRequests.supplierId, sid)).orderBy(desc(schema.invoiceRequests.createdAt)).limit(30) : [];

    return {
      key: input.key,
      supplier: sup ? { id: sup.id, name: sup.name, email: sup.email, accountNumber: sup.accountNumber } : null,
      name: sup?.name ?? invoices[0]?.supplierNameRaw ?? "Unknown supplier",
      pairs,
      noPo: invoices.filter((i) => !i.poId).map(invOut),
      statements: statements.map((s) => ({ id: s.id, statementDate: s.statementDate, balanceIncGst: s.balanceIncGst, overdueIncGst: s.overdueIncGst, lines: safeJson<unknown[]>(s.lines, []).length })),
      requests: requests.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate, amountIncGst: r.amountIncGst, status: r.status, toAddress: r.toAddress, sentAt: r.sentAt, error: r.error })),
    };
  }),

  /** Everything on one invoice, for the side panel. */
  invoice: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [i] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, input.id));
    if (!i) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    const [po] = i.poId ? await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, i.poId)) : [];
    const poLines = po ? await db.select().from(schema.purchaseOrderLines).where(eq(schema.purchaseOrderLines.poId, po.id)) : [];
    let link: string | null = null;
    if (i.mailMessageId) {
      const [m] = await db
        .select({ gmailId: schema.mailMessages.gmailId, address: schema.mailAccounts.address })
        .from(schema.mailMessages)
        .innerJoin(schema.mailAccounts, eq(schema.mailAccounts.id, schema.mailMessages.accountId))
        .where(eq(schema.mailMessages.id, i.mailMessageId));
      if (m) link = gmailLink(m.address, m.gmailId);
    }
    return {
      ...i,
      lines: safeJson<Array<{ description: string; qty: number | null; unit: string | null; unitPriceExGst: number | null; totalExGst: number | null }>>(i.lines, []),
      exGst: invoiceExGst(i),
      due: dueOf(i),
      pair: pairState(i),
      po: po ? { id: po.id, number: po.number, totalExGst: po.totalExGst, goodsExGst: po.goodsExGst, freightExGst: po.freightExGst, chargesExGst: po.chargesExGst, lines: poLines } : null,
      pdfUrl: i.pdfKey ? await signGet(i.pdfKey).catch(() => null) : null,
      gmailLink: link,
    };
  }),

  /** Tie an invoice to a PO by hand, or untie it (poId null). */
  match: adminOnly.input(z.object({ invoiceId: z.number(), poId: z.number().nullable() })).handler(async ({ input }) => {
    if (input.poId) {
      const [[inv], [po]] = await Promise.all([
        db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, input.invoiceId)),
        db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, input.poId)),
      ]);
      if (!inv || !po) throw new ORPCError("NOT_FOUND", { message: "Not found" });
      if (inv.supplierId && inv.supplierId !== po.supplierId) throw new ORPCError("BAD_REQUEST", { message: `PO ${po.number} is to a different supplier.` });
      if (po.status === "cancelled" || po.status === "draft") throw new ORPCError("BAD_REQUEST", { message: `PO ${po.number} was never sent.` });
    }
    await placeInvoice(input.invoiceId, input.poId);
    return { ok: true };
  }),

  /** Run the automatic matching again, after a PO was raised late. */
  rematch: adminOnly.input(z.object({ invoiceId: z.number() })).handler(async ({ input }) => {
    await placeInvoice(input.invoiceId);
    return { ok: true };
  }),

  /** Say which supplier an unknown name is. Ops remembers it for next time. */
  setSupplier: adminOnly.input(z.object({ invoiceId: z.number(), supplierId: z.number() })).handler(async ({ input }) => {
    const [inv] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, input.invoiceId));
    if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    const key = dedupeKey(input.supplierId, inv.supplierNameRaw, inv.invoiceNumber);
    const [dupe] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(and(eq(schema.supplierInvoices.dedupeKey, key), ne(schema.supplierInvoices.id, inv.id)));
    if (dupe) throw new ORPCError("CONFLICT", { message: "That supplier already has this invoice number in Ops. This one is a copy." });
    await db.update(schema.supplierInvoices).set({ supplierId: input.supplierId, dedupeKey: key, updatedAt: new Date() }).where(eq(schema.supplierInvoices.id, inv.id));
    // Any other invoice under the same printed name goes the same way.
    const others = await db
      .select({ id: schema.supplierInvoices.id, invoiceNumber: schema.supplierInvoices.invoiceNumber })
      .from(schema.supplierInvoices)
      .where(and(isNull(schema.supplierInvoices.supplierId), eq(schema.supplierInvoices.supplierNameRaw, inv.supplierNameRaw)));
    for (const o of others) {
      const k = dedupeKey(input.supplierId, inv.supplierNameRaw, o.invoiceNumber);
      const [d] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.dedupeKey, k));
      if (d) continue;
      await db.update(schema.supplierInvoices).set({ supplierId: input.supplierId, dedupeKey: k, updatedAt: new Date() }).where(eq(schema.supplierInvoices.id, o.id));
      await placeInvoice(o.id);
    }
    await placeInvoice(inv.id);
    return { ok: true };
  }),

  markPaid: adminOnly.input(z.object({ invoiceId: z.number(), paid: z.boolean().default(true), note: z.string().max(300).default("") })).handler(async ({ input, context }) => {
    await markPaid(input.invoiceId, input.note || `Marked paid by ${context.actor.name}.`, input.paid);
    return { ok: true };
  }),

  /** A person has looked at a price difference and is happy with it. */
  markChecked: adminOnly.input(z.object({ invoiceId: z.number(), checked: z.boolean().default(true) })).handler(async ({ input, context }) => {
    await db
      .update(schema.supplierInvoices)
      .set({ checkedAt: input.checked ? new Date() : null, checkedBy: input.checked ? context.actor.name : null, updatedAt: new Date() })
      .where(eq(schema.supplierInvoices.id, input.invoiceId));
    return { ok: true };
  }),

  /* ------------------------------ invoice requests ----------------------------- */

  request: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    const [r] = await db.select().from(schema.invoiceRequests).where(eq(schema.invoiceRequests.id, input.id));
    if (!r) throw new ORPCError("NOT_FOUND", { message: "Request not found" });
    return r;
  }),

  /** Change who it goes to or the wording before it is sent. */
  requestEdit: adminOnly
    .input(z.object({ id: z.number(), toAddress: z.string().max(200).optional(), body: z.string().max(4000).optional(), saveEmail: z.boolean().default(false) }))
    .handler(async ({ input }) => {
      const [r] = await db.select().from(schema.invoiceRequests).where(eq(schema.invoiceRequests.id, input.id));
      if (!r) throw new ORPCError("NOT_FOUND", { message: "Request not found" });
      if (r.status === "sent" || r.status === "received") throw new ORPCError("BAD_REQUEST", { message: "Already sent." });
      const to = input.toAddress?.trim();
      if (to !== undefined && to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ORPCError("BAD_REQUEST", { message: `"${to}" is not an email address.` });
      const set: Partial<typeof schema.invoiceRequests.$inferInsert> = { updatedAt: new Date() };
      if (to !== undefined) {
        set.toAddress = to || null;
        set.status = to ? "waiting_ok" : "no_email";
      }
      if (input.body !== undefined) set.body = input.body;
      await db.update(schema.invoiceRequests).set(set).where(eq(schema.invoiceRequests.id, r.id));
      if (input.saveEmail && to && r.supplierId) await db.update(schema.suppliers).set({ email: to, updatedAt: new Date() }).where(eq(schema.suppliers.id, r.supplierId));
      return { ok: true };
    }),

  /** Damien okays it: it goes now, from team@. */
  requestSend: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    try {
      const r = await sendInvoiceRequest(input.id);
      return { ok: true, status: r.status };
    } catch (e) {
      throw new ORPCError("BAD_REQUEST", { message: (e as Error).message });
    }
  }),

  requestCancel: adminOnly.input(z.object({ id: z.number() })).handler(async ({ input }) => {
    await db
      .update(schema.invoiceRequests)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(schema.invoiceRequests.id, input.id), inArray(schema.invoiceRequests.status, ["waiting_ok", "no_email"])));
    return { ok: true };
  }),

  /** Off by default. On = missing-invoice requests go without waiting for an okay. */
  setAutoSend: adminOnly.input(z.object({ on: z.boolean() })).handler(async ({ input }) => {
    const value = input.on ? "on" : "off";
    await db
      .insert(schema.settings)
      .values({ key: AUTO_SEND_KEY, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
    return { on: input.on };
  }),

  /** Drop in a supplier PDF by hand. Read and matched exactly like one from email. */
  uploadPdf: adminOnly
    .input(z.object({ filename: z.string().min(1).max(200), base64: z.string().min(10).max(28_000_000) }))
    .handler(async ({ input, context }) => {
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new ORPCError("BAD_REQUEST", { message: "That file is not a PDF." });
      try {
        const r = await ingestPdf(bytes, { filename: input.filename, from: `uploaded by ${context.actor.name}`, subject: "", mailMessageId: null });
        return r;
      } catch (e) {
        throw new ORPCError("BAD_GATEWAY", { message: `Could not read it: ${(e as Error).message}` });
      }
    }),
};
