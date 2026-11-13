import { inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { addLocalDays, localDate, todayLocal } from "./local-date";
import { round2 } from "./hourly-calc";
import { balanceOf, paymentsFor } from "./hourly-invoice";
import { XeroError, xeroApi, xeroReady } from "./xero";

/*
 * XERO PAYMENT CHECK FOR CONTRACTOR INVOICES (Damien, 13 Nov 2026).
 *
 * The office still records payments by hand. This only reads Xero bills
 * (ACCPAY) and flags contractor invoices that look paid there, so nobody has
 * to look each one up. It never writes to Xero and never records a payment:
 * the office presses Record payment themselves.
 *
 * A bill is a match when the total is the same to the cent AND the invoice
 * number is the same AND the Xero contact name looks like the contractor.
 * Same total with only one of those two is "check it": shown, but never called
 * paid. One Xero bill is only ever matched to one invoice.
 */

type XBill = {
  InvoiceID: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  Date?: string;
  DateString?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  FullyPaidOnDate?: string;
  Payments?: Array<{ Date?: string; Amount?: number }>;
};

export type XeroCheckDeps = {
  ready: () => Promise<unknown>;
  api: <T>(path: string, init: { query: Record<string, string>; narrow403?: boolean }) => Promise<T>;
};

const live: XeroCheckDeps = { ready: xeroReady, api: (p, i) => xeroApi(p, i) };

const PAGES = 5;
const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").replace(/^0+/, "");
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** A Xero date as YYYY-MM-DD. Xero sends "2026-10-20T00:00:00" or "/Date(1792454400000+0000)/". */
export function xeroDay(v: string | null | undefined) {
  if (!v) return null;
  const ms = /\/Date\((-?\d+)/.exec(v);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** Does this Xero contact name look like him? Whole business name, or first and last name both in it. */
export function nameLooksLike(contact: string | null | undefined, names: Array<string | null | undefined>) {
  const c = norm(contact);
  if (!c) return false;
  for (const raw of names) {
    const n = norm(raw);
    if (n.length < 3) continue;
    if (c === n || c.includes(n) || (c.length >= 5 && n.includes(c))) return true;
    const words = n.split(" ").filter((w) => w.length >= 2);
    if (words.length >= 2 && c.includes(words[0]!) && c.includes(words[words.length - 1]!)) return true;
  }
  return false;
}

export type XeroCheckRow = {
  invoiceId: number;
  match: "matched" | "check" | "none";
  why: string;
  bill: { number: string; contact: string; status: string; total: number; paid: number; due: number; paidOn: string | null } | null;
  opsPaid: number;
  /** Xero shows more paid than the office has recorded. Only ever true on a full match. */
  looksPaid: boolean;
  /** What Xero shows paid beyond what is recorded, capped at what is left. */
  toRecord: number;
};

export async function xeroPaymentCheck(invoiceIds: number[], deps: XeroCheckDeps = live, today: string = todayLocal()) {
  const ids = [...new Set(invoiceIds)];
  if (!ids.length) return { connected: true, checked: 0, billsRead: 0, rows: [] as XeroCheckRow[], message: "Nothing to check." };
  if (!(await deps.ready())) return { connected: false, checked: 0, billsRead: 0, rows: [] as XeroCheckRow[], message: "Xero is not connected, so nothing was checked." };

  const invs = await db.select().from(schema.installerInvoices).where(inArray(schema.installerInvoices.id, ids));
  const pays = await paymentsFor(invs.map((i) => i.id));
  const open = invs
    .map((i) => ({ inv: i, bal: balanceOf(i, pays.get(i.id) ?? []) }))
    .filter((x) => x.bal.balance > 0);
  if (!open.length) return { connected: true, checked: 0, billsRead: 0, rows: [] as XeroCheckRow[], message: "Every one of these is already paid in Ops." };

  const people = await db
    .select()
    .from(schema.installers)
    .where(inArray(schema.installers.id, [...new Set(open.map((x) => x.inv.installerId))]));
  const namesOf = new Map(people.map((p) => [p.id, [p.name, p.tradingName, p.fullName, p.abnLegalName]]));

  // Bills dated from two weeks before the oldest open invoice. Newest first, up to 500.
  const oldest = open.map((x) => (x.inv.submittedAt ? localDate(x.inv.submittedAt) : today)).sort()[0]!;
  const since = addLocalDays(oldest, -14);
  const [y, m, d] = since.split("-").map(Number);
  const bills: XBill[] = [];
  try {
    for (let page = 1; page <= PAGES; page++) {
      const r = await deps.api<{ Invoices?: XBill[] }>("Invoices", {
        query: { where: `Type=="ACCPAY" AND Date>=DateTime(${y},${m},${d})`, order: "Date DESC", page: String(page) },
        narrow403: true,
      });
      const got = r.Invoices ?? [];
      bills.push(...got);
      if (got.length < 100) break;
    }
  } catch (e) {
    const msg = e instanceof XeroError || e instanceof Error ? e.message : String(e);
    return { connected: true, checked: 0, billsRead: 0, rows: [] as XeroCheckRow[], message: `Xero could not be read: ${msg}` };
  }
  const usable = bills.filter((b) => b.Type === "ACCPAY" && b.Status !== "DELETED" && b.Status !== "VOIDED");

  const used = new Set<string>();
  const rows: XeroCheckRow[] = [];
  // Strong matches first across every invoice, so a "check it" never takes a bill a full match needs.
  const scored = open.map(({ inv, bal }) => {
    const names = [...(namesOf.get(inv.installerId) ?? []), inv.tradingName, inv.legalName, inv.installerName];
    const cands = usable
      .filter((b) => Math.abs(round2(b.Total ?? 0) - round2(inv.total)) < 0.005)
      .map((b) => {
        const num = digits(b.InvoiceNumber) === String(inv.invoiceNumber) || digits(b.Reference) === String(inv.invoiceNumber);
        const name = nameLooksLike(b.Contact?.Name, names);
        return { b, num, name, score: (num ? 2 : 0) + (name ? 1 : 0) };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
    return { inv, bal, cands };
  });
  const pick = new Map<number, (typeof scored)[number]["cands"][number] | null>();
  for (const want of [3, 2, 1]) {
    for (const s of scored) {
      if (pick.has(s.inv.id)) continue;
      const top = s.cands.filter((c) => c.score === want && !used.has(c.b.InvoiceID));
      if (!top.length) continue;
      // Two bills fit just as well: say so rather than guess.
      if (top.length > 1) { pick.set(s.inv.id, null); continue; }
      used.add(top[0]!.b.InvoiceID);
      pick.set(s.inv.id, top[0]!);
    }
  }

  for (const s of scored) {
    const c = pick.get(s.inv.id);
    const opsPaid = s.bal.paid;
    if (c === undefined) {
      rows.push({ invoiceId: s.inv.id, match: "none", why: "No Xero bill with this total, number or name.", bill: null, opsPaid, looksPaid: false, toRecord: 0 });
      continue;
    }
    if (c === null) {
      rows.push({ invoiceId: s.inv.id, match: "check", why: "More than one Xero bill fits. Check in Xero which one it is.", bill: null, opsPaid, looksPaid: false, toRecord: 0 });
      continue;
    }
    const b = c.b;
    const paid = round2(b.AmountPaid ?? 0);
    const lastPay = (b.Payments ?? []).map((p) => xeroDay(p.Date)).filter(Boolean).sort().pop() ?? null;
    const full = c.num && c.name;
    const extra = round2(Math.min(s.bal.balance, paid - opsPaid));
    rows.push({
      invoiceId: s.inv.id,
      match: full ? "matched" : "check",
      why: full
        ? "Same total, invoice number and contractor."
        : c.num
          ? "Same total and invoice number, but the Xero contact name is different. Check it is him."
          : "Same total and contractor, but a different invoice number in Xero. Check it is this invoice.",
      bill: {
        number: b.InvoiceNumber ?? "",
        contact: b.Contact?.Name ?? "",
        status: b.Status ?? "",
        total: round2(b.Total ?? 0),
        paid,
        due: round2(b.AmountDue ?? 0),
        paidOn: xeroDay(b.FullyPaidOnDate) ?? lastPay,
      },
      opsPaid,
      looksPaid: !!full && extra > 0.004,
      toRecord: full && extra > 0.004 ? extra : 0,
    });
  }

  const flagged = rows.filter((r) => r.looksPaid).length;
  return {
    connected: true,
    checked: rows.length,
    billsRead: usable.length,
    rows,
    message: flagged
      ? `${flagged} of ${rows.length} look paid in Xero. Nothing was recorded. Check each one and press Record payment.`
      : `Checked ${rows.length} against ${usable.length} Xero bills. None look paid beyond what is recorded.`,
  };
}
