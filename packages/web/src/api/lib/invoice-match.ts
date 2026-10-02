import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { SupplierDoc } from "../agent/supplier-docs";
import { SUPPLIER_TERMS, settleDate } from "./cashflow";
import { INVOICES_TO } from "./gmail";
import { checkInvoicePrices } from "./price-check";

/* ---------------------------------------------------------------------------
 * Matching supplier paperwork to POs.
 *
 *   invoice   -> which supplier, which PO, does the money agree
 *   statement -> which invoices are still owing, which ones never arrived
 *
 * Never guesses. Anything it cannot tie with confidence goes to "Needs you"
 * with the reason in plain words.
 * ------------------------------------------------------------------------- */

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const squash = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const NAME_NOISE = new Set([
  "pty", "ltd", "limited", "the", "australia", "aust", "au", "co", "company", "group", "trust", "trading", "as",
  "flooring", "floorcoverings", "floor", "floors", "carpets", "carpet", "and", "qld", "nsw", "wholesale",
]);
const PUBLIC_MAIL = /@(gmail|outlook|hotmail|yahoo|bigpond|icloud|live)\./i;

/**
 * The words that identify a supplier. Possessives and plurals fold together,
 * because the invoice says "Hurford Wholesale" while Ops says "Hurford's".
 */
function nameWords(s: string) {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Tolerance on a PO comparison: a dollar, or 0.2% on a big order. */
export const tolerance = (total: number) => Math.max(1, Math.abs(total) * 0.002);

export function dedupeKey(supplierId: number | null, supplierName: string, number: string) {
  return `${supplierId ?? `n:${squash(supplierName)}`}|${squash(number)}`;
}

/** "4113-A", "4113 A", "PO 4113A", "4113/a" all read as 4113-A. */
export function poRefsIn(...texts: Array<string | null | undefined>) {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/(?<![\d])(\d{3,6})\s*[-/ ]?\s*([A-Za-z])(?![A-Za-z])/g)) out.add(`${m[1]}-${m[2]!.toUpperCase()}`);
  }
  return [...out];
}

/**
 * PO numbers inside product lines. Only the exact form 4113-A counts here,
 * because "240 X 15" on a Hurford's line is a board size, not PO 240-X.
 */
export function strictPoRefsIn(...texts: Array<string | null | undefined>) {
  const out = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(/(?<![\dA-Za-z])(\d{3,6})-([A-Za-z])(?![A-Za-z\d])/g)) out.add(`${m[1]}-${m[2]!.toUpperCase()}`);
  return [...out];
}

/** Bare job numbers, used only when no PO number is printed. */
function jobNumbersIn(...texts: Array<string | null | undefined>) {
  const out = new Set<number>();
  for (const t of texts) for (const m of (t ?? "").matchAll(/(?<![\d.$])(\d{4,5})(?![\d.])/g)) out.add(Number(m[1]));
  return [...out];
}

const TERRA_OWN = /terra\s*flooring|arclan(\s*pty)?(\s*ltd)?|(2\s*\/\s*)?22\s*lawrence\s*dr(ive)?/gi;
const OWN_KEY = /terraflooring|arclan|lawrencedr/;

/* -------------------------------- supplier -------------------------------- */

export async function findSupplier(name: string | null, fromAddress: string) {
  const raw = squash(name);
  if (raw) {
    // Learned: someone already told Ops who this printed name is.
    const [inv] = await db
      .select({ id: schema.supplierInvoices.supplierId, n: schema.supplierInvoices.supplierNameRaw })
      .from(schema.supplierInvoices)
      .where(and(isNotNull(schema.supplierInvoices.supplierId), eq(schema.supplierInvoices.supplierNameRaw, name!)))
      .limit(1);
    if (inv?.id) return inv.id;
  }
  const all = await db
    .select({ id: schema.suppliers.id, name: schema.suppliers.name, email: schema.suppliers.email })
    .from(schema.suppliers);
  const words = new Set(nameWords(name ?? ""));
  const scored = all
    .map((s) => {
      const sw = nameWords(s.name);
      if (!sw.length) return { s, hit: squash(s.name) === raw };
      return { s, hit: sw.every((w) => words.has(w)) || (raw.length > 3 && raw.includes(squash(sw.join("")))) };
    })
    .filter((x) => x.hit);
  if (scored.length === 1) return scored[0]!.s.id;
  // Same domain as the supplier email on file, unless it is a public mailbox.
  const dom = fromAddress.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
  if (dom && !PUBLIC_MAIL.test(fromAddress)) {
    const byDomain = all.filter((s) => s.email && s.email.toLowerCase().endsWith(`@${dom}`));
    if (byDomain.length === 1) return byDomain[0]!.id;
  }
  if (scored.length > 1) {
    // Several suppliers share the words. Take the one whose whole name matches longest.
    const best = scored.sort((a, b) => squash(b.s.name).length - squash(a.s.name).length)[0]!;
    if (raw.includes(squash(best.s.name).slice(0, 6))) return best.s.id;
  }
  return null;
}

export const isTerraOwn = (name: string | null) => /terra\s*flooring|arclan/i.test(name ?? "");

/* ---------------------------------- POs ----------------------------------- */

type InvoiceRow = typeof schema.supplierInvoices.$inferSelect;

export const invoiceExGst = (i: Pick<InvoiceRow, "totalExGst" | "totalIncGst" | "gst">) =>
  round2(i.totalExGst ?? (i.gst !== null ? i.totalIncGst - i.gst : i.totalIncGst / 1.1));

/** Work out which PO an invoice belongs to. Writes poId, jobId and a note. */
export async function linkInvoice(inv: InvoiceRow): Promise<{ poId: number | null; note: string }> {
  const lines = safeJson<Array<{ description?: string }>>(inv.lines, []);
  const printed = poRefsIn(inv.poRefRaw);
  const refs = [...new Set([...printed, ...strictPoRefsIn(...lines.map((l) => l.description))])];
  if (refs.length) {
    const pos = await db.select().from(schema.purchaseOrders).where(inArray(schema.purchaseOrders.number, refs));
    if (pos.length === 1) {
      const po = pos[0]!;
      if (inv.supplierId && po.supplierId !== inv.supplierId) {
        const [sup] = await db.select({ name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.id, po.supplierId));
        return { poId: null, note: `PO ${po.number} is for ${sup?.name ?? "another supplier"}, but this invoice is from ${inv.supplierNameRaw}.` };
      }
      return { poId: po.id, note: `PO ${po.number} printed on the invoice.` };
    }
    if (pos.length > 1) return { poId: null, note: `More than one PO printed (${refs.join(", ")}). Pick the right one.` };
    // A number in the order field that Ops never raised is worth a look. One
    // only found inside a product line is probably a code, so keep looking.
    if (printed.length) return { poId: null, note: `PO ${refs.join(", ")} printed, but Ops has no PO with that number.` };
  }
  if (!inv.supplierId) return { poId: null, note: `No PO number, and "${inv.supplierNameRaw}" is not a supplier in Ops yet.` };

  const open = await db
    .select()
    .from(schema.purchaseOrders)
    .where(and(eq(schema.purchaseOrders.supplierId, inv.supplierId), inArray(schema.purchaseOrders.status, ["sent", "invoiced"])));

  // A bare job number with exactly one PO to this supplier on that job.
  const jobNos = jobNumbersIn(inv.poRefRaw, inv.otherRefs);
  if (jobNos.length && open.length) {
    const jobs = await db.select({ id: schema.jobs.id, number: schema.jobs.number }).from(schema.jobs).where(inArray(schema.jobs.number, jobNos));
    const jobIds = new Set(jobs.map((j) => j.id));
    const onJob = open.filter((p) => jobIds.has(p.jobId));
    if (onJob.length === 1) return { poId: onJob[0]!.id, note: `No PO number, matched on job ${jobs.find((j) => j.id === onJob[0]!.jobId)?.number}.` };
  }

  // Customer name or site address printed on it, with exactly one open PO to this supplier on that job.
  // Terra's own name and warehouse are on every "deliver to", so they never point at a job.
  const refs2 = squash(`${inv.otherRefs ?? ""} ${inv.poRefRaw ?? ""}`.replace(TERRA_OWN, " "));
  if (refs2.length >= 4 && open.length) {
    const who = await db
      .select({ jobId: schema.jobs.id, number: schema.jobs.number, last: schema.contacts.lastName, company: schema.companies.name, address: schema.sites.address })
      .from(schema.jobs)
      .leftJoin(schema.contacts, eq(schema.contacts.id, schema.jobs.contactId))
      .leftJoin(schema.companies, eq(schema.companies.id, schema.jobs.companyId))
      .leftJoin(schema.sites, eq(schema.sites.id, schema.jobs.siteId))
      .where(inArray(schema.jobs.id, [...new Set(open.map((p) => p.jobId))]));
    const hits = who.filter((j) => {
      const keys = [j.last, j.company, (j.address ?? "").replace(/^\s*(unit\s*)?\d+[a-z]?\s*[/,]?\s*\d*\s*/i, "")]
        .map(squash)
        .filter((k) => k.length >= 5 && !OWN_KEY.test(k));
      return keys.some((k) => refs2.includes(k));
    });
    const onJob = open.filter((p) => hits.some((h) => h.jobId === p.jobId));
    if (onJob.length === 1) {
      const j = hits.find((h) => h.jobId === onJob[0]!.jobId)!;
      return { poId: onJob[0]!.id, note: `No PO number. Matched on the customer or address for job ${j.number}, check it.` };
    }
  }

  // Last resort: one open PO to this supplier for the same money, not yet invoiced.
  const ex = invoiceExGst(inv);
  const sameMoney = open.filter((p) => p.status === "sent" && Math.abs(p.totalExGst - ex) <= tolerance(p.totalExGst));
  if (sameMoney.length === 1) return { poId: sameMoney[0]!.id, note: `No PO number printed. Matched on supplier and amount to ${sameMoney[0]!.number}, check it.` };
  if (sameMoney.length > 1) return { poId: null, note: `No PO number, and ${sameMoney.length} open POs to this supplier are the same amount.` };
  return { poId: null, note: "No PO number printed and nothing open to this supplier for that amount." };
}

/**
 * Recompare every invoice on a PO against it, and move the PO and its
 * forecast line along. Several invoices on one PO is normal (part deliveries).
 */
export async function settlePo(poId: number) {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
  if (!po) return;
  const invs = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.poId, poId));
  const billed = round2(invs.reduce((a, i) => a + (i.docType === "credit" ? -1 : 1) * invoiceExGst(i), 0));
  const diff = round2(billed - po.totalExGst);
  const tol = tolerance(po.totalExGst);
  const agrees = Math.abs(diff) <= tol;
  const under = !agrees && diff < 0;
  const status = !invs.length ? null : agrees ? "matched" : "different";

  const freightBilled = invs.reduce((a, i) => a + (i.docType === "credit" ? 0 : (i.freightExGst ?? 0)), 0);
  const notes: string[] = [];
  if (status === "matched") notes.push(`Agrees with PO ${po.number}.`);
  if (status === "different" && !under) notes.push(`$${diff.toFixed(2)} ex GST more than PO ${po.number}.`);
  if (status === "different" && under) notes.push(`$${Math.abs(diff).toFixed(2)} ex GST less than PO ${po.number}. A part delivery, or a better price.`);
  if (freightBilled - po.freightExGst > 0.5) notes.push(`Freight $${round2(freightBilled - po.freightExGst).toFixed(2)} charged that is not on the PO.`);

  for (const i of invs) {
    await db
      .update(schema.supplierInvoices)
      .set({ matchStatus: status ?? "needs_you", diffExGst: diff, jobId: po.jobId, matchNote: [i.matchNote.split(" | ")[0], ...notes].filter(Boolean).join(" | "), updatedAt: new Date() })
      .where(eq(schema.supplierInvoices.id, i.id));
  }

  await db
    .update(schema.purchaseOrders)
    .set({ status: invs.length ? "invoiced" : po.status === "invoiced" ? "sent" : po.status, updatedAt: new Date() })
    .where(eq(schema.purchaseOrders.id, poId));

  if (po.jobCostId) {
    const [line] = await db.select({ dueDateLocked: schema.jobCosts.dueDateLocked }).from(schema.jobCosts).where(eq(schema.jobCosts.id, po.jobCostId));
    const allPaid = invs.length > 0 && invs.every((i) => i.payState === "paid");
    const due = invs
      .map((i) => i.dueDate ?? (i.invoiceDate ? settleDate(i.invoiceDate, SUPPLIER_TERMS.days, SUPPLIER_TERMS.eom) : null))
      .filter(Boolean)
      .sort()[0];
    await db
      .update(schema.jobCosts)
      .set({
        state: !invs.length ? "committed" : allPaid && !under ? "paid" : "invoiced",
        amount: invs.length && !under ? billed : po.totalExGst,
        invoiceRef: invs.map((i) => i.invoiceNumber).join(", ") || null,
        // A date a person typed stays put. Everything else follows the invoices.
        ...(due && !line?.dueDateLocked ? { dueDate: due } : {}),
        paidAt: allPaid && !under ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobCosts.id, po.jobCostId));
  }
}

/* ------------------------------ recording docs ---------------------------- */

export type DocMeta = { fromAddress: string; mailMessageId: number | null; pdfKey: string | null; pdfName: string | null };

/** Store one invoice or credit. Returns null when it was already in Ops. */
export async function recordInvoice(doc: SupplierDoc, meta: DocMeta) {
  if (!doc.invoiceNumber || doc.totalIncGst === null) return { skipped: "no invoice number or total" as const };
  const supplierName = doc.supplierName?.trim() || "Unknown supplier";
  const supplierId = await findSupplier(supplierName, meta.fromAddress);
  const key = dedupeKey(supplierId, supplierName, doc.invoiceNumber);
  const [dupe] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.dedupeKey, key));
  if (dupe) return { duplicate: dupe.id };

  const [inv] = await db
    .insert(schema.supplierInvoices)
    .values({
      supplierId,
      supplierNameRaw: supplierName,
      invoiceNumber: doc.invoiceNumber.trim(),
      dedupeKey: key,
      docType: doc.docType === "credit" ? "credit" : "invoice",
      poRefRaw: doc.poReference,
      invoiceDate: doc.invoiceDate,
      dueDate: doc.dueDate,
      goodsExGst: doc.goodsExGst,
      freightExGst: doc.freightExGst,
      totalExGst: doc.totalExGst,
      gst: doc.gst,
      totalIncGst: Math.abs(doc.totalIncGst),
      lines: JSON.stringify(doc.lines),
      otherRefs: doc.otherReferences,
      pdfKey: meta.pdfKey,
      pdfName: meta.pdfName,
      mailMessageId: meta.mailMessageId,
    })
    .returning();
  await placeInvoice(inv!.id);

  // A request for this invoice is now answered.
  await db
    .update(schema.invoiceRequests)
    .set({ status: "received", updatedAt: new Date() })
    .where(and(eq(schema.invoiceRequests.dedupeKey, key), ne(schema.invoiceRequests.status, "received")));
  return { id: inv!.id };
}

/** (Re)link an invoice to its PO and recompare. Safe to call again after a manual fix. */
export async function placeInvoice(invoiceId: number, forcePoId?: number | null) {
  const [inv] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.id, invoiceId));
  if (!inv) return;
  const before = inv.poId;
  let poId: number | null;
  let note: string;
  if (forcePoId !== undefined) {
    poId = forcePoId;
    const [po] = forcePoId ? await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, forcePoId)) : [];
    note = po ? `Matched to ${po.number} by hand.` : "Unlinked by hand.";
  } else {
    ({ poId, note } = await linkInvoice(inv));
  }
  // The PO number settles who the supplier is when the printed name did not.
  let supplierId = inv.supplierId;
  let dedupe = inv.dedupeKey;
  if (poId && !supplierId) {
    const [po] = await db.select({ supplierId: schema.purchaseOrders.supplierId }).from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, poId));
    if (po) {
      supplierId = po.supplierId;
      const key = dedupeKey(supplierId, inv.supplierNameRaw, inv.invoiceNumber);
      const [clash] = await db.select({ id: schema.supplierInvoices.id }).from(schema.supplierInvoices).where(eq(schema.supplierInvoices.dedupeKey, key));
      if (!clash) dedupe = key;
    }
  }
  await db
    .update(schema.supplierInvoices)
    .set({
      poId,
      supplierId,
      dedupeKey: dedupe,
      matchNote: note,
      matchStatus: poId ? inv.matchStatus : "needs_you",
      diffExGst: poId ? inv.diffExGst : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.supplierInvoices.id, invoiceId));
  if (poId) await settlePo(poId);
  if (before && before !== poId) await settlePo(before);
  // Every rate on it against the price list. Flags only, never a price change.
  await checkInvoicePrices(invoiceId);
}

/* -------------------------------- statements ------------------------------ */

export function requestText(supplierName: string, inv: { invoiceNumber: string; invoiceDate: string | null; amountIncGst: number | null }, statementDate: string | null) {
  const when = inv.invoiceDate ? ` dated ${auDate(inv.invoiceDate)}` : "";
  const amt = inv.amountIncGst !== null ? ` for $${inv.amountIncGst.toFixed(2)}` : "";
  const on = statementDate ? `Your statement of ${auDate(statementDate)}` : "Your latest statement";
  return {
    subject: `Missing invoice ${inv.invoiceNumber}, Terra Flooring`,
    body: [
      `Hi ${supplierName} accounts,`,
      "",
      `${on} lists invoice ${inv.invoiceNumber}${when}${amt}, but we don't have a copy of it.`,
      "",
      `Could you please send it to ${INVOICES_TO}. That address goes straight to our accounts.`,
      "",
      "Thanks,",
      "Terra Flooring",
      "1300 183 772",
    ].join("\n"),
  };
}

export const auDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};

/**
 * Store a statement, then use it two ways: invoices it lists that Ops never
 * received get a request drafted, and unpaid invoices dated before it that it
 * no longer lists are taken as paid.
 */
export async function recordStatement(doc: SupplierDoc, meta: DocMeta) {
  const supplierName = doc.supplierName?.trim() || "Unknown supplier";
  const supplierId = await findSupplier(supplierName, meta.fromAddress);
  const [st] = await db
    .insert(schema.supplierStatements)
    .values({
      supplierId,
      supplierNameRaw: supplierName,
      statementDate: doc.statementDate,
      balanceIncGst: doc.statementBalanceIncGst,
      overdueIncGst: doc.statementOverdueIncGst,
      lines: JSON.stringify(doc.statementLines),
      pdfKey: meta.pdfKey,
      pdfName: meta.pdfName,
      mailMessageId: meta.mailMessageId,
    })
    .returning();
  const out = await applyStatement(st!.id);
  return { id: st!.id, ...out };
}

export async function applyStatement(statementId: number) {
  const [st] = await db.select().from(schema.supplierStatements).where(eq(schema.supplierStatements.id, statementId));
  if (!st) return { requested: 0, markedPaid: 0, rowsAddUp: false };
  const lines = safeJson<Array<{ invoiceNumber: string; date: string | null; amountIncGst: number | null; outstandingIncGst: number | null; isPayment: boolean }>>(st.lines, []);
  const [sup] = st.supplierId ? await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, st.supplierId)) : [];
  const name = sup?.name ?? st.supplierNameRaw;

  let requested = 0;
  const listedKeys = new Set<string>();
  for (const l of lines) {
    if (l.isPayment || !l.invoiceNumber) continue;
    const key = dedupeKey(st.supplierId, st.supplierNameRaw, l.invoiceNumber);
    listedKeys.add(key);
    const owing = l.outstandingIncGst ?? l.amountIncGst ?? 0;
    const [have] = await db.select().from(schema.supplierInvoices).where(eq(schema.supplierInvoices.dedupeKey, key));
    if (have) {
      if (l.outstandingIncGst === 0 && have.payState !== "paid") await markPaid(have.id, `Statement of ${st.statementDate ? auDate(st.statementDate) : "?"} shows it paid.`);
      continue;
    }
    if (owing <= 0) continue; // credits and paid rows: nothing to chase
    if (!st.supplierId) continue; // can't chase a supplier Ops doesn't know
    const [already] = await db.select({ id: schema.invoiceRequests.id }).from(schema.invoiceRequests).where(eq(schema.invoiceRequests.dedupeKey, key));
    if (already) continue;
    const text = requestText(name, { invoiceNumber: l.invoiceNumber, invoiceDate: l.date, amountIncGst: l.amountIncGst }, st.statementDate);
    await db.insert(schema.invoiceRequests).values({
      supplierId: st.supplierId,
      supplierNameRaw: name,
      invoiceNumber: l.invoiceNumber,
      dedupeKey: key,
      invoiceDate: l.date,
      amountIncGst: l.amountIncGst,
      statementId: st.id,
      toAddress: sup?.email ?? null,
      subject: text.subject,
      body: text.body,
      status: sup?.email ? "waiting_ok" : "no_email",
    });
    requested++;
  }

  // Open-item statement: an unpaid invoice dated before it that is no longer listed has been paid.
  // Only trusted when the rows add up to the balance printed, so a page the reader missed
  // never turns into "paid". An invoice dated the same day may simply be too new to be on it.
  let markedPaid = 0;
  const rowsTotal = round2(lines.filter((l) => !l.isPayment).reduce((a, l) => a + (l.outstandingIncGst ?? l.amountIncGst ?? 0), 0));
  const adds = st.balanceIncGst !== null && Math.abs(rowsTotal - st.balanceIncGst) <= Math.max(1, Math.abs(st.balanceIncGst) * 0.005);
  if (st.supplierId && st.statementDate && adds && (lines.length > 0 || st.balanceIncGst === 0)) {
    const unpaid = await db
      .select()
      .from(schema.supplierInvoices)
      .where(
        and(
          eq(schema.supplierInvoices.supplierId, st.supplierId),
          eq(schema.supplierInvoices.payState, "unpaid"),
          isNotNull(schema.supplierInvoices.invoiceDate),
          lt(schema.supplierInvoices.invoiceDate, st.statementDate),
        ),
      );
    for (const i of unpaid) {
      if (listedKeys.has(i.dedupeKey)) continue;
      await markPaid(i.id, `Not on the statement of ${auDate(st.statementDate)}, so it has been paid.`);
      markedPaid++;
    }
  }
  return { requested, markedPaid, rowsAddUp: adds };
}

export async function markPaid(invoiceId: number, note: string, paid = true) {
  const [inv] = await db
    .update(schema.supplierInvoices)
    .set({ payState: paid ? "paid" : "unpaid", paidNote: paid ? note : "", paidAt: paid ? new Date() : null, updatedAt: new Date() })
    .where(eq(schema.supplierInvoices.id, invoiceId))
    .returning();
  if (inv?.poId) await settlePo(inv.poId);
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? ((JSON.parse(s) as T | null) ?? fallback) : fallback;
  } catch {
    return fallback;
  }
}
