import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { billToOfLink, buyerLinkOf, invoicesForLink, openInstallerBills } from "./installer-buyer";
import { localDate } from "./local-date";
import { XeroError, logXero, xeroApi, xeroReady } from "./xero";
import { syncFromXero, xeroSettings } from "./xero-invoices";

/* ---------------------------------------------------------------------------
 * Task H (Damien, 29 Oct): contras between an installer's materials invoice
 * (he owes Terra) and his contractor bill (Terra owes him).
 *
 * Example: bill $1,500, invoice $1,000. Both stay in Xero in full with their
 * own tax. Ops posts two payments to the contra clearing account: $1,000 on
 * the invoice and $1,000 on the bill. The clearing account nets to nil. The
 * bill shows $500 left, paid by bank as normal. Never shown as a bank payment.
 *
 * Steps: pick an invoice and a bill, refresh both from Xero, preview, record
 * how he agreed, then the owner approves with an explicit confirmation. Ops
 * posts each side once (Idempotency-Key plus a Reference check), reads both
 * back, and only then shows it settled. One side posted and the other not
 * shows as incomplete; retry posts only the missing side.
 *
 * Switched off unless CONTRA_WORKFLOW=on. Posting also needs
 * XERO_CONTRA_POSTING=on and the accounting.payments scope, which Ops does
 * not ask Xero for today. Neither is set on the live server.
 * ------------------------------------------------------------------------- */

export const contraFlags = () => ({
  workflow: process.env.CONTRA_WORKFLOW === "on",
  posting: process.env.CONTRA_WORKFLOW === "on" && process.env.XERO_CONTRA_POSTING === "on",
});

const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const OPEN = ["draft", "approved", "posting", "incomplete", "posted"] as const;
const inFlight = new Set<number>();

export function assertWorkflow() {
  if (!contraFlags().workflow) throw new ORPCError("FORBIDDEN", { message: "Contras are switched off on this server." });
}

/** The confirmation the owner types to approve. */
export const approvalPhrase = (amount: number) => `CONTRA ${r2(amount).toFixed(2)}`;

/* ------------------------------ Xero reads -------------------------------- */

/**
 * Why this code can not be the contra clearing account in the connected
 * organisation, or null when it can. Xero's own system accounts (Historical
 * Adjustment, Rounding, GST and so on) and bank accounts are refused, and the
 * account must take payments.
 */
export async function contraAccountProblem(code: string): Promise<string | null> {
  const r = await xeroApi<{ Accounts?: Array<{ Code?: string; Name?: string; Type?: string; Status?: string; EnablePaymentsToAccount?: boolean; SystemAccount?: string | null }> }>("Accounts", {
    query: { where: `Code=="${code.replace(/[^A-Za-z0-9.-]/g, "")}"` },
  });
  const a = (r.Accounts ?? []).find((x) => x.Code === code && x.Status !== "ARCHIVED");
  if (!a) return `Xero has no active account ${code} for contras. Check the code in Xero's chart of accounts.`;
  if (a.Type === "BANK") return `Account ${code} (${a.Name}) is a bank account. A contra goes through a clearing account, not a bank account.`;
  if (a.SystemAccount) return `Account ${code} (${a.Name}) is one of Xero's own system accounts. Use a clearing account your bookkeeper sets up.`;
  if (!a.EnablePaymentsToAccount) return `Account ${code} (${a.Name}) does not take payments. Tick "Enable payments to this account" on it in Xero first.`;
  return null;
}

type XContact = { ContactID: string; Name: string; EmailAddress?: string; TaxNumber?: string; ContactStatus?: string; IsSupplier?: boolean; IsCustomer?: boolean };
export type XDoc = {
  InvoiceID: string;
  InvoiceNumber?: string;
  Reference?: string;
  Type?: string;
  Status?: string;
  Contact?: { ContactID?: string; Name?: string };
  Date?: string;
  DateString?: string;
  DueDate?: string;
  DueDateString?: string;
  Total?: number;
  TotalTax?: number;
  AmountDue?: number;
  AmountPaid?: number;
  AmountCredited?: number;
  UpdatedDateUTC?: string;
  Payments?: Array<{ PaymentID?: string; Amount?: number; Date?: string }>;
};

async function tenant() {
  const conn = await xeroReady();
  if (!conn?.tenantId) throw bad("Xero is not connected, or no organisation is picked.");
  return conn.tenantId;
}

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
/** Xero ids are GUIDs. Loose on purpose: letters, digits and dashes only, so nothing odd reaches a Xero URL or filter. */
const isGuid = (v: string) => /^[\w-]{8,64}$/.test(v);

/** Xero contacts that may be him: same ABN in the tax number, or his names. Read only. */
export async function xeroContactCandidates(installerId: number) {
  assertWorkflow();
  await tenant();
  const link = await buyerLinkOf(installerId);
  if (!link) throw bad("Link him to the record he is billed as first.");
  const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, installerId));
  const abn = digits(i?.abn);
  const found = new Map<string, XContact & { reasons: string[] }>();
  const add = (list: XContact[], why: string) => {
    for (const c of list) {
      const e = found.get(c.ContactID) ?? { ...c, reasons: [] };
      if (!e.reasons.includes(why)) e.reasons.push(why);
      found.set(c.ContactID, e);
    }
  };
  if (abn.length === 11) {
    const spaced = `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`;
    for (const v of [abn, spaced]) {
      const r = await xeroApi<{ Contacts?: XContact[] }>("Contacts", { query: { where: `TaxNumber=="${q(v)}"`, includeArchived: "true" } });
      add(r.Contacts ?? [], "Same ABN");
    }
  }
  const names = new Set([link.buyerName, i?.tradingName, i?.abnLegalName, i?.fullName, i?.name].map((n) => (n ?? "").trim()).filter((n) => n.length > 1));
  for (const n of names) {
    const r = await xeroApi<{ Contacts?: XContact[] }>("Contacts", { query: { searchTerm: n, includeArchived: "true" } });
    add(r.Contacts ?? [], `Name like "${n}"`);
  }
  const key = `${link.billToType}:${link.billToType === "company" ? link.companyId : link.contactId}`;
  const [inv] = await db.select().from(schema.xeroContactLinks).where(and(eq(schema.xeroContactLinks.tenantId, await tenant()), eq(schema.xeroContactLinks.billToKey, key)));
  return {
    pinned: link.xeroContactId ? { id: link.xeroContactId, name: link.xeroContactName } : null,
    invoicesGoTo: inv ? { id: inv.xeroContactId, name: inv.xeroName } : null,
    candidates: [...found.values()].map((c) => ({
      id: c.ContactID,
      name: c.Name,
      email: c.EmailAddress ?? null,
      taxNumber: c.TaxNumber ?? null,
      abnMatch: abn.length === 11 && digits(c.TaxNumber) === abn,
      archived: c.ContactStatus === "ARCHIVED",
      supplier: !!c.IsSupplier,
      customer: !!c.IsCustomer,
      reasons: c.reasons,
    })),
  };
}

/**
 * Pin the one Xero contact his bills and invoices are on. If Ops already sends
 * his invoices to a different Xero contact it refuses, unless the owner asks
 * to send future invoices to this one too. Nothing in Xero changes.
 */
export async function pinXeroContact(input: { installerId: number; xeroContactId: string; repointInvoices: boolean }, actor: Pick<Actor, "name" | "role">) {
  assertWorkflow();
  const tenantId = await tenant();
  const link = await buyerLinkOf(input.installerId);
  if (!link) throw bad("Link him to the record he is billed as first.");
  if (!isGuid(input.xeroContactId)) throw bad("That is not a Xero contact.");
  const r = await xeroApi<{ Contacts?: XContact[] }>(`Contacts/${encodeURIComponent(input.xeroContactId)}`);
  const c = r.Contacts?.[0];
  if (!c) throw bad("Xero did not return that contact.");
  if (c.ContactStatus === "ARCHIVED") throw bad(`${c.Name} is archived in Xero.`);
  const ref = billToOfLink(link);
  const key = `${ref.type}:${ref.id}`;
  const [inv] = await db.select().from(schema.xeroContactLinks).where(and(eq(schema.xeroContactLinks.tenantId, tenantId), eq(schema.xeroContactLinks.billToKey, key)));
  if (inv && inv.xeroContactId !== c.ContactID) {
    if (!input.repointInvoices)
      throw bad(`His invoices already go to Xero contact ${inv.xeroName}. Pick that one, or tick to send his future invoices to ${c.Name}. Invoices already in Xero stay where they are.`);
    await db.update(schema.xeroContactLinks).set({ xeroContactId: c.ContactID, xeroName: c.Name, how: "matched", updatedAt: new Date() }).where(eq(schema.xeroContactLinks.id, inv.id));
  } else if (!inv) {
    await db
      .insert(schema.xeroContactLinks)
      .values({ tenantId, billToKey: key, contactId: ref.type === "contact" ? ref.id : null, companyId: ref.type === "company" ? ref.id : null, xeroContactId: c.ContactID, xeroName: c.Name, how: "matched" })
      .onConflictDoNothing();
  }
  await db
    .update(schema.installerBuyerLinks)
    .set({ xeroTenantId: tenantId, xeroContactId: c.ContactID, xeroContactName: c.Name, xeroPinnedByName: actor.name, xeroPinnedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.installerBuyerLinks.id, link.id));
  await db.insert(schema.activityLog).values({
    entityType: "installer",
    entityId: input.installerId,
    action: "xero_contact_pinned",
    detail: `Xero contact for his bills and invoices: ${c.Name}${inv && inv.xeroContactId !== c.ContactID ? ` (future invoices moved from ${inv.xeroName})` : ""}.`,
    actorName: actor.name,
    actorRole: actor.role,
  });
  return { ok: true, name: c.Name };
}

async function pinned(installerId: number) {
  const link = await buyerLinkOf(installerId);
  if (!link) throw bad("Link him to the record he is billed as first.");
  const tenantId = await tenant();
  if (!link.xeroContactId || link.xeroTenantId !== tenantId) throw bad("Pick his Xero contact first.");
  return { link, tenantId, contactId: link.xeroContactId };
}

/** A Xero date as YYYY-MM-DD. Xero sends "2026-10-20T00:00:00" or "/Date(1792454400000+0000)/". */
function xeroDay(v: string | null | undefined) {
  if (!v) return null;
  const ms = /\/Date\((-?\d+)/.exec(v);
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** His bills in Xero (ACCPAY) with what is left on each. Read only. */
export async function readBills(installerId: number) {
  assertWorkflow();
  const { contactId } = await pinned(installerId);
  const r = await xeroApi<{ Invoices?: XDoc[] }>("Invoices", {
    query: { where: `Type=="ACCPAY" AND Contact.ContactID==guid("${contactId}")`, order: "Date DESC", page: "1" },
  });
  const ops = await db.select().from(schema.installerInvoices).where(eq(schema.installerInvoices.installerId, installerId));
  return (r.Invoices ?? [])
    .filter((b) => b.Type === "ACCPAY" && b.Status !== "DELETED" && b.Status !== "VOIDED")
    .map((b) => {
      const n = Number(digits(b.InvoiceNumber));
      const match = ops.find((o) => o.invoiceNumber === n && Math.abs(o.total - (b.Total ?? 0)) < 0.01) ?? null;
      return {
        xeroId: b.InvoiceID,
        number: b.InvoiceNumber ?? "",
        reference: b.Reference ?? "",
        status: b.Status ?? "",
        date: xeroDay(b.DateString ?? b.Date),
        dueDate: xeroDay(b.DueDateString ?? b.DueDate),
        total: r2(b.Total ?? 0),
        tax: r2(b.TotalTax ?? 0),
        paid: r2(b.AmountPaid ?? 0),
        credited: r2(b.AmountCredited ?? 0),
        due: r2(b.AmountDue ?? 0),
        opsBill: match ? { id: match.id, number: match.invoiceNumber, status: match.status, total: match.total } : null,
      };
    });
}

async function readDoc(id: string) {
  const r = await xeroApi<{ Invoices?: XDoc[] }>(`Invoices/${encodeURIComponent(id)}`);
  const d = r.Invoices?.[0];
  if (!d) throw new XeroError("Xero did not return that document.");
  return d;
}

const fingerprint = (a: XDoc, b: XDoc) =>
  createHash("sha256")
    .update(JSON.stringify([a.InvoiceID, a.AmountDue, a.Status, a.UpdatedDateUTC ?? "", b.InvoiceID, b.AmountDue, b.Status, b.UpdatedDateUTC ?? ""]))
    .digest("hex")
    .slice(0, 24);

/**
 * Refresh both from Xero and say what a contra would leave. Read only.
 * Refused unless both are open, on his pinned Xero contact, and Ops has the
 * invoice billed to his linked record.
 */
export async function previewContra(input: { installerId: number; invoiceId: number; billXeroId: string; amount?: number | null }) {
  assertWorkflow();
  const { link, contactId } = await pinned(input.installerId);
  const { contraAccount } = await xeroSettings();
  if (!contraAccount) throw bad("Set the contra clearing account in Settings, Xero first. Your bookkeeper confirms the code.");
  const accountProblem = await contraAccountProblem(contraAccount);
  if (accountProblem) throw bad(accountProblem);
  const mine = await invoicesForLink(link);
  const inv = mine.find((r) => r.id === input.invoiceId);
  if (!inv) throw bad("That invoice is not billed to him.");
  if (!inv.xeroInvoiceId) throw bad(`${inv.number} is not in Xero yet. Send it to Xero first.`);
  if (!isGuid(input.billXeroId)) throw bad("Pick one of his bills.");
  const [xi, xb] = await Promise.all([readDoc(inv.xeroInvoiceId), readDoc(input.billXeroId)]);
  const problems: string[] = [];
  if (xi.Type !== "ACCREC") problems.push(`${inv.number} is not a sales invoice in Xero.`);
  if (xb.Type !== "ACCPAY") problems.push("That bill is not a bill in Xero.");
  if (xi.Status !== "AUTHORISED") problems.push(`${inv.number} is ${xi.Status?.toLowerCase()} in Xero, not awaiting payment.`);
  if (xb.Status !== "AUTHORISED") problems.push(`Bill ${xb.InvoiceNumber ?? ""} is ${xb.Status?.toLowerCase()} in Xero, not awaiting payment.`);
  if (xi.Contact?.ContactID !== contactId) problems.push(`${inv.number} is on Xero contact ${xi.Contact?.Name ?? "?"}, not his pinned contact ${link.xeroContactName}.`);
  if (xb.Contact?.ContactID !== contactId) problems.push(`The bill is on Xero contact ${xb.Contact?.Name ?? "?"}, not his pinned contact ${link.xeroContactName}.`);
  const invDue = r2(xi.AmountDue ?? 0);
  const billDue = r2(xb.AmountDue ?? 0);
  if (!(invDue > 0)) problems.push(`${inv.number} has nothing left to pay in Xero.`);
  if (!(billDue > 0)) problems.push("The bill has nothing left to pay in Xero.");
  const max = r2(Math.min(invDue, billDue));
  const amount = r2(input.amount ?? max);
  if (!(amount > 0)) problems.push("The contra must be over $0.");
  if (amount > max + 0.001) problems.push(`The most that can be offset is ${money(max)}.`);
  const open = await db
    .select({ id: schema.xeroContras.id })
    .from(schema.xeroContras)
    .where(and(inArray(schema.xeroContras.status, [...OPEN]), eq(schema.xeroContras.invoiceId, inv.id)));
  if (open.length) problems.push(`Contra C${open[0]!.id} on ${inv.number} is still open.`);
  const openBill = await db
    .select({ id: schema.xeroContras.id })
    .from(schema.xeroContras)
    .where(and(inArray(schema.xeroContras.status, [...OPEN]), eq(schema.xeroContras.billXeroId, xb.InvoiceID)));
  if (openBill.length) problems.push(`Contra C${openBill[0]!.id} on that bill is still open.`);
  return {
    ok: problems.length === 0,
    problems,
    contraAccount,
    invoice: { id: inv.id, number: inv.number, xeroId: xi.InvoiceID, total: r2(xi.Total ?? 0), tax: r2(xi.TotalTax ?? 0), paid: r2(xi.AmountPaid ?? 0), due: invDue, after: r2(invDue - amount) },
    bill: { xeroId: xb.InvoiceID, number: xb.InvoiceNumber ?? "", total: r2(xb.Total ?? 0), tax: r2(xb.TotalTax ?? 0), paid: r2(xb.AmountPaid ?? 0), due: billDue, after: r2(billDue - amount) },
    amount,
    max,
    sameEntityBasis: `${link.basis === "abn_match" ? "Same ABN" : link.basis === "created" ? "Made from his card" : `Confirmed: ${link.reason ?? ""}`}; Xero contact ${link.xeroContactName}`,
    fingerprint: fingerprint(xi, xb),
  };
}

/** Save a contra to approve. A second click with the same request key returns the same one. */
export async function prepareContra(
  input: {
    requestKey: string;
    installerId: number;
    invoiceId: number;
    billXeroId: string;
    amount: number;
    fingerprint: string;
    agreement: { how: "email" | "sms" | "signed" | "in_person" | "phone"; note: string; on: string };
    sameEntity: true;
  },
  actor: Pick<Actor, "name" | "role">,
) {
  assertWorkflow();
  const [again] = await db.select().from(schema.xeroContras).where(eq(schema.xeroContras.requestKey, input.requestKey));
  if (again) return again;
  if (!input.sameEntity) throw bad("Confirm the invoice and the bill are the same legal person or business.");
  if (input.agreement.note.trim().length < 8) throw bad("Say how he agreed, for example the email or text he sent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.agreement.on)) throw bad("Give the date he agreed.");
  const p = await previewContra(input);
  if (!p.ok) {
    // A second click that lands after the first one saved sees its own contra as "still open". Hand that one back.
    const [first] = await db.select().from(schema.xeroContras).where(eq(schema.xeroContras.requestKey, input.requestKey));
    if (first) return first;
    throw bad(p.problems.join(" "));
  }
  if (p.fingerprint !== input.fingerprint) throw bad("Something changed in Xero since the preview. Check the preview again.");
  if (Math.abs(p.amount - r2(input.amount)) > 0.001) throw bad("The amount changed. Check the preview again.");
  const tenantId = await tenant();
  const bills = await openInstallerBills(input.installerId);
  const n = Number(digits(p.bill.number));
  const opsBill = bills.find((b) => b.invoiceNumber === n && Math.abs(b.total - p.bill.total) < 0.01);
  try {
    const [row] = await db
      .insert(schema.xeroContras)
      .values({
        requestKey: input.requestKey,
        tenantId,
        installerId: input.installerId,
        invoiceId: p.invoice.id,
        invoiceNumber: p.invoice.number,
        xeroInvoiceId: p.invoice.xeroId,
        billXeroId: p.bill.xeroId,
        billNumber: p.bill.number,
        installerInvoiceId: opsBill?.id ?? null,
        amount: p.amount,
        contraAccount: p.contraAccount,
        paidOn: localDate(),
        status: "draft",
        invoiceDueBefore: p.invoice.due,
        billDueBefore: p.bill.due,
        invoiceTotal: p.invoice.total,
        billTotal: p.bill.total,
        agreementHow: input.agreement.how,
        agreementNote: input.agreement.note.trim(),
        agreementOn: input.agreement.on,
        sameEntityBasis: p.sameEntityBasis,
        preparedByName: actor.name,
        preparedAt: new Date(),
      })
      .returning();
    await audit(row!, "contra_prepared", `Contra C${row!.id} prepared: ${money(p.amount)} of ${p.invoice.number} against bill ${p.bill.number}. Leaves ${money(p.invoice.after)} on the invoice and ${money(p.bill.after)} on the bill. He agreed by ${input.agreement.how} on ${input.agreement.on}.`, actor);
    return row!;
  } catch (e) {
    const [raced] = await db.select().from(schema.xeroContras).where(eq(schema.xeroContras.requestKey, input.requestKey));
    if (raced) return raced;
    throw e;
  }
}

async function audit(c: typeof schema.xeroContras.$inferSelect, action: string, detail: string, actor: Pick<Actor, "name" | "role">) {
  const [inv] = await db.select({ jobId: schema.invoices.jobId }).from(schema.invoices).where(eq(schema.invoices.id, c.invoiceId));
  await db.insert(schema.activityLog).values({ jobId: inv?.jobId ?? null, entityType: "contra", entityId: c.id, action, detail, actorName: actor.name, actorRole: actor.role });
  await db.insert(schema.activityLog).values({ entityType: "installer", entityId: c.installerId, action, detail, actorName: actor.name, actorRole: actor.role });
}

async function contraOr404(id: number) {
  const [c] = await db.select().from(schema.xeroContras).where(eq(schema.xeroContras.id, id));
  if (!c) throw new ORPCError("NOT_FOUND", { message: "Contra not found" });
  return c;
}

/**
 * The owner approves with the typed phrase, then Ops posts. One person may
 * prepare and approve (Damien, 29 Oct). Approval is recorded once.
 */
export async function approveContra(input: { id: number; confirm: string }, actor: Pick<Actor, "name" | "role">) {
  assertWorkflow();
  if (actor.role !== "admin") throw new ORPCError("FORBIDDEN", { message: "Only the owner can approve a contra." });
  const c = await contraOr404(input.id);
  if (c.status !== "draft") return { contra: c, posted: false, message: c.status === "cancelled" ? "This contra was cancelled." : "Already approved." };
  if (input.confirm.trim().toUpperCase() !== approvalPhrase(c.amount)) throw bad(`Type ${approvalPhrase(c.amount)} to approve.`);
  const done = await db
    .update(schema.xeroContras)
    .set({ status: "approved", approvedByName: actor.name, approvedAt: new Date(), approvalText: input.confirm.trim(), updatedAt: new Date() })
    .where(and(eq(schema.xeroContras.id, c.id), eq(schema.xeroContras.status, "draft")))
    .returning();
  if (!done.length) return { contra: await contraOr404(c.id), posted: false, message: "Already approved." };
  await audit(done[0]!, "contra_approved", `Contra C${c.id} approved by ${actor.name} (typed "${input.confirm.trim()}").`, actor);
  return { contra: done[0]!, posted: false, message: "Approved." };
}

const reference = (id: number) => `Terra Ops contra C${id}`;

/** A payment Xero already has for this contra on this document, from an earlier try whose reply was lost. */
async function alreadyPosted(c: typeof schema.xeroContras.$inferSelect, docId: string) {
  const r = await xeroApi<{ Payments?: Array<{ PaymentID?: string; Status?: string; Amount?: number; Invoice?: { InvoiceID?: string }; Account?: { Code?: string } }> }>("Payments", {
    query: { where: `Reference=="${reference(c.id)}"` },
  });
  return (r.Payments ?? []).find((p) => p.Status !== "DELETED" && p.Invoice?.InvoiceID === docId && Math.abs((p.Amount ?? 0) - c.amount) < 0.001 && p.Account?.Code === c.contraAccount) ?? null;
}

async function postSide(c: typeof schema.xeroContras.$inferSelect, side: "inv" | "bill") {
  const docId = side === "inv" ? c.xeroInvoiceId : c.billXeroId;
  const have = await alreadyPosted(c, docId);
  if (have?.PaymentID) return { id: have.PaymentID, how: "found" as const };
  const d = await readDoc(docId);
  if (d.Status !== "AUTHORISED" || r2(d.AmountDue ?? 0) + 0.001 < c.amount)
    throw new XeroError(`${side === "inv" ? c.invoiceNumber : `Bill ${c.billNumber}`} now has ${money(d.AmountDue ?? 0)} left (${d.Status}) in Xero, less than the contra. Nothing was posted on it.`);
  const r = await xeroApi<{ Payments?: Array<{ PaymentID?: string }> }>("Payments", {
    method: "PUT",
    contraAccount: c.contraAccount,
    idempotencyKey: `terra-ops-contra-${c.tenantId.slice(0, 8)}-${c.id}-${side}`,
    body: { Payments: [{ Invoice: { InvoiceID: docId }, Account: { Code: c.contraAccount }, Date: c.paidOn, Amount: c.amount, Reference: reference(c.id) }] },
  });
  const id = r.Payments?.[0]?.PaymentID;
  if (!id) throw new XeroError("Xero did not return the payment.");
  return { id, how: "posted" as const };
}

/**
 * Post what is not posted yet: the invoice side, then the bill side. Each is
 * saved the moment Xero answers, so a retry never posts it again. Stops with
 * the contra incomplete when a side fails. Then reads both back.
 */
export async function postContra(id: number, actor: Pick<Actor, "name" | "role">) {
  assertWorkflow();
  if (!contraFlags().posting) throw new ORPCError("FORBIDDEN", { message: "Posting contras to Xero is switched off on this server. Nothing was sent." });
  if (actor.role !== "admin") throw new ORPCError("FORBIDDEN", { message: "Only the owner can post a contra." });
  if (inFlight.has(id)) return { contra: await contraOr404(id), message: "Already posting." };
  inFlight.add(id);
  try {
    const claimed = await db
      .update(schema.xeroContras)
      .set({ status: "posting", updatedAt: new Date() })
      .where(and(eq(schema.xeroContras.id, id), inArray(schema.xeroContras.status, ["approved", "incomplete", "posting"])))
      .returning();
    // "posting" is claimable too: only if the server stopped mid post (inFlight is clear). Each side checks Xero by Reference first.
    if (!claimed.length) {
      const c = await contraOr404(id);
      if (c.status === "posted" || c.status === "confirmed") return { contra: c, message: "Already posted." };
      throw bad(c.status === "draft" ? "Approve it first." : `This contra is ${c.status}.`);
    }
    let c = claimed[0]!;
    if ((await tenant()) !== c.tenantId) {
      await db.update(schema.xeroContras).set({ status: "incomplete", lastError: "Xero is connected to a different organisation now.", updatedAt: new Date() }).where(eq(schema.xeroContras.id, id));
      throw bad("Xero is connected to a different organisation from the one this contra was prepared in.");
    }
    for (const side of ["inv", "bill"] as const) {
      if (side === "inv" ? c.invPaymentId : c.billPaymentId) continue;
      try {
        const got = await postSide(c, side);
        const set = side === "inv" ? { invPaymentId: got.id, invPostedAt: new Date() } : { billPaymentId: got.id, billPostedAt: new Date() };
        [c] = await db.update(schema.xeroContras).set({ ...set, lastError: null, updatedAt: new Date() }).where(eq(schema.xeroContras.id, id)).returning();
        await audit(c!, side === "inv" ? "contra_invoice_posted" : "contra_bill_posted", `Contra C${id}: ${money(c!.amount)} to ${c!.contraAccount} on ${side === "inv" ? c!.invoiceNumber : `bill ${c!.billNumber}`} ${got.how === "found" ? "was already in Xero (earlier try), now recorded" : "posted in Xero"}. Xero payment ${got.id}.`, actor);
        await logXero("push", true, `Contra C${id} ${side === "inv" ? c!.invoiceNumber : `bill ${c!.billNumber}`} payment ${got.id} (${got.how}).`, { invoiceId: side === "inv" ? c!.invoiceId : null, xeroId: got.id, byName: actor.name });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const which = side === "inv" ? c.invoiceNumber : `bill ${c.billNumber}`;
        [c] = await db.update(schema.xeroContras).set({ status: "incomplete", lastError: `${which}: ${msg}`, updatedAt: new Date() }).where(eq(schema.xeroContras.id, id)).returning();
        await audit(c!, "contra_incomplete", `Contra C${id} is incomplete. ${which} was not posted: ${msg}. ${c!.invPaymentId ? `${c!.invoiceNumber} side is in Xero.` : ""} ${c!.billPaymentId ? "Bill side is in Xero." : ""}`.trim(), actor);
        await logXero("error", false, `Contra C${id} ${which}: ${msg}`, { invoiceId: c!.invoiceId, byName: actor.name });
        return { contra: c!, message: `Incomplete. ${which} was not posted: ${msg}` };
      }
    }
    [c] = await db.update(schema.xeroContras).set({ status: "posted", updatedAt: new Date() }).where(eq(schema.xeroContras.id, id)).returning();
    const after = await confirmContra(id, actor);
    return { contra: after.contra, message: after.message };
  } finally {
    inFlight.delete(id);
  }
}

/**
 * Read both back. Settled only when Xero shows both payments and Ops has the
 * invoice side recorded as a contra by the normal read back.
 */
export async function confirmContra(id: number, actor: Pick<Actor, "name" | "role">) {
  assertWorkflow();
  let c = await contraOr404(id);
  if (c.status === "confirmed") return { contra: c, message: "Settled." };
  if (c.status !== "posted") return { contra: c, message: `This contra is ${c.status}.` };
  const [xi, xb] = await Promise.all([readDoc(c.xeroInvoiceId), readDoc(c.billXeroId)]);
  const onInv = (xi.Payments ?? []).some((p) => p.PaymentID === c.invPaymentId);
  const onBill = (xb.Payments ?? []).some((p) => p.PaymentID === c.billPaymentId);
  if (!onInv || !onBill) return { contra: c, message: `Xero does not show ${!onInv ? "the invoice payment" : "the bill payment"} yet. Check again shortly.` };
  await syncFromXero(actor.name).catch(() => null);
  const [read] = await db
    .select()
    .from(schema.xeroPaymentReads)
    .where(and(eq(schema.xeroPaymentReads.tenantId, c.tenantId), eq(schema.xeroPaymentReads.xeroPaymentId, c.invPaymentId!)));
  if (!read || read.kind !== "contra") {
    return { contra: c, message: read ? `Ops read the invoice payment as ${read.kind}, not contra. Check the clearing account setting.` : "Both payments are in Xero. Ops has not recorded the invoice side yet. Check again shortly." };
  }
  [c] = await db.update(schema.xeroContras).set({ status: "confirmed", confirmedAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(schema.xeroContras.id, id)).returning();
  await audit(c!, "contra_confirmed", `Contra C${id} settled. Xero shows ${money(c!.amount)} on ${c!.invoiceNumber} (${money(xi.AmountDue ?? 0)} left) and on bill ${c!.billNumber} (${(xb.AmountDue ?? 0) > 0.004 ? `${money(xb.AmountDue ?? 0)} left, to pay by bank` : "nothing left"}). Not a bank payment.`, actor);
  return { contra: c!, message: "Settled." };
}

/** Only before anything is in Xero. */
export async function cancelContra(input: { id: number; reason: string }, actor: Pick<Actor, "name" | "role">) {
  assertWorkflow();
  const c = await contraOr404(input.id);
  if (c.invPaymentId || c.billPaymentId) throw bad("Part of this contra is already in Xero. Retry the missing side, or ask your bookkeeper to remove the Xero payment, then tell Ops.");
  if (!["draft", "approved", "incomplete"].includes(c.status)) throw bad(`This contra is ${c.status}.`);
  if (input.reason.trim().length < 4) throw bad("Say why it is cancelled.");
  const [row] = await db
    .update(schema.xeroContras)
    .set({ status: "cancelled", cancelledByName: actor.name, lastError: input.reason.trim(), updatedAt: new Date() })
    .where(and(eq(schema.xeroContras.id, c.id), inArray(schema.xeroContras.status, ["draft", "approved", "incomplete"])))
    .returning();
  if (row) await audit(row, "contra_cancelled", `Contra C${c.id} cancelled: ${input.reason.trim()}`, actor);
  return row ?? c;
}

export async function contrasFor(installerId: number) {
  return db.select().from(schema.xeroContras).where(eq(schema.xeroContras.installerId, installerId)).orderBy(desc(schema.xeroContras.id));
}
