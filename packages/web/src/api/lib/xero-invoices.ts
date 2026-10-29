import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { snapshotFor, type IssuedSnapshot } from "./clientInvoicePdf";
import { markInvoicePaid } from "./client-invoices";
import { rebuildForecast } from "./cashflow";
import { localDate } from "./local-date";
import { isLiveServer } from "./runtime";
import { logXero, XeroError, XeroNotConnected, xeroApi, xeroDate, xeroReady, xeroRow } from "./xero";

/* ---------------------------------------------------------------------------
 * Client invoices into Xero, and what Xero says back (Damien, 28 Oct).
 *
 * Push: one Xero sales invoice (ACCREC) per IQ invoice, numbered as Ops
 * numbers it (IQ188032-1), never Xero's own. It carries everything the PDF
 * says: the job and site, every section or itemised row of the quote with its
 * wording, the quote totals and the billing summary, as wording lines with no
 * amount. Then one line for this invoice's amount, GST inclusive, on the sales
 * account. So the Xero total is always the Ops total.
 *
 * Before anything is created Ops looks for that number in Xero. If it is
 * there, Ops links to it rather than make a second one. Writes also carry an
 * Idempotency-Key.
 *
 * Read back: Xero's status, paid and due. When Xero has more paid than Ops,
 * each new Xero payment is read for the account it went to (Task G): a bank
 * account is recorded as received by bank, the contra clearing account as a
 * contra (never as money in), and any other account is flagged, not
 * recorded. Each Xero payment is recorded once. Ops is never lowered from
 * Xero and nothing is added twice: a card payment Ops already has simply
 * shows in Xero once the bookkeeper reconciles it. Voids, credits and totals
 * that disagree are flagged on the invoice, never changed by themselves.
 * ------------------------------------------------------------------------- */

export const XERO_ACCOUNT_KEY = "xero_sales_account";
export const XERO_TAX_KEY = "xero_tax_type";
export const XERO_STATUS_KEY = "xero_push_status";
export const XERO_AUTO_KEY = "xero_auto_push";
/** Task G: the clearing account a contra is paid through in Xero. Empty: no account is read as a contra. */
export const XERO_CONTRA_KEY = "xero_contra_account";

export type XeroSettings = { accountCode: string; taxType: string; pushStatus: "DRAFT" | "AUTHORISED"; autoPush: boolean; contraAccount: string };

export async function xeroSettings(): Promise<XeroSettings> {
  const rows = await db
    .select()
    .from(schema.settings)
    .where(inArray(schema.settings.key, [XERO_ACCOUNT_KEY, XERO_TAX_KEY, XERO_STATUS_KEY, XERO_AUTO_KEY, XERO_CONTRA_KEY]));
  const v = new Map(rows.map((r) => [r.key, r.value]));
  return {
    // 6 Oct notes: sales go to 204 with GST, the same as Terra Stock.
    accountCode: (v.get(XERO_ACCOUNT_KEY) ?? "").trim() || "204",
    taxType: (v.get(XERO_TAX_KEY) ?? "").trim() || "OUTPUT",
    // Damien, 29 Oct: invoices go in approved (awaiting payment). Draft only if the setting says so.
    pushStatus: v.get(XERO_STATUS_KEY) === "DRAFT" ? "DRAFT" : "AUTHORISED",
    autoPush: v.get(XERO_AUTO_KEY) === "1",
    contraAccount: (v.get(XERO_CONTRA_KEY) ?? "").trim(),
  };
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyOut = (n: number) => String(r2(n));
const unitOut = (u: string) => (u === "m2" ? "m²" : u);
/** Xero allows 4000 characters a line. Kept under, split on blank lines then lines. */
const LINE_MAX = 3900;

function chunks(text: string): string[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t.length <= LINE_MAX) return t ? [t] : [];
  const out: string[] = [];
  let cur = "";
  for (const part of t.split(/\n/)) {
    const piece = part.length > LINE_MAX ? part.match(new RegExp(`.{1,${LINE_MAX}}`, "g")) ?? [] : [part];
    for (const p of piece) {
      if (cur && cur.length + 1 + p.length > LINE_MAX) {
        out.push(cur);
        cur = p;
      } else cur = cur ? `${cur}\n${p}` : p;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export type XeroLine = { Description: string; Quantity?: number; UnitAmount?: number; AccountCode?: string; TaxType?: string };

export type XeroInvoiceInput = {
  inv: Pick<typeof schema.invoices.$inferSelect, "number" | "total" | "createdAt" | "dueDate">;
  snap: IssuedSnapshot;
  contactId: string;
  settings: Pick<XeroSettings, "accountCode" | "taxType" | "pushStatus">;
};

/** The lines, in the order the PDF reads. Pure, so it can be checked without Xero. */
export function xeroLines(snap: IssuedSnapshot, total: number, s: Pick<XeroSettings, "accountCode" | "taxType">): XeroLine[] {
  const lines: XeroLine[] = [];
  const words = (t: string) => chunks(t).forEach((Description) => lines.push({ Description }));
  const w = snap.works;
  if (w) {
    words(`Quote ${w.quoteRef}`);
    if (w.items?.length) {
      for (const i of w.items) words(`${i.description}\n${qtyOut(i.qty)} ${unitOut(i.unit)} at ${money(i.rate)} = ${money(i.total)} ex GST`);
    } else {
      const bundlesEx = Math.abs(w.bundles.reduce((a, b) => a + b.total, 0) - w.subtotal) < 0.05;
      for (const b of w.bundles) {
        // The wording often opens with the title again. Said once is enough.
        const body = (b.wording ?? "").replace(/\r\n/g, "\n").trim();
        const first = body.split("\n")[0]?.trim() ?? "";
        const wording = b.title && first.toLowerCase() === b.title.trim().toLowerCase() ? body.split("\n").slice(1).join("\n").trim() : body;
        words([b.title, wording, `${money(b.total)}${bundlesEx ? " ex GST" : ""}`].filter((x) => x && x.trim()).join("\n"));
      }
    }
    words(`Quote ${w.quoteRef}: sub total ${money(w.subtotal)} ex GST, GST ${money(w.gst)}, total ${money(w.total)} inc GST`);
  }
  if (snap.summary.state === "shown" && snap.summary.lines.length) {
    words(["Billing summary, inc GST", ...snap.summary.lines.map((l) => `${l.label}: ${money(l.amount)}`)].join("\n"));
  }
  lines.push({
    Description: chunks(snap.description || "Flooring")[0] ?? "Flooring",
    Quantity: 1,
    UnitAmount: r2(total),
    AccountCode: s.accountCode,
    TaxType: s.taxType,
  });
  return lines;
}

export function buildXeroInvoice({ inv, snap, contactId, settings }: XeroInvoiceInput) {
  const date = localDate(inv.createdAt);
  const site = snap.siteAddress ? `, ${snap.siteAddress}` : "";
  return {
    Type: "ACCREC" as const,
    Contact: { ContactID: contactId },
    InvoiceNumber: inv.number,
    Reference: `Job ${snap.jobRef}${site}`.slice(0, 255),
    Date: date,
    DueDate: inv.dueDate ? localDate(inv.dueDate) : date,
    LineAmountTypes: "Inclusive" as const,
    Status: settings.pushStatus,
    CurrencyCode: "AUD",
    SentToContact: false,
    LineItems: xeroLines(snap, inv.total, settings),
  };
}

/* -------------------------------- contacts -------------------------------- */

type XContact = { ContactID: string; Name: string; EmailAddress?: string; ContactStatus?: string };

const whereEq = (field: string, v: string) => `${field}=="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const same = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

async function findContacts(where: string) {
  const r = await xeroApi<{ Contacts?: XContact[] }>("Contacts", { query: { where, includeArchived: "true", summaryOnly: "true" } });
  return r.Contacts ?? [];
}

/**
 * The Xero contact this invoice bills to. A link saved earlier, else the one
 * Xero contact with the same name, else the one with the same email, else a
 * new contact with the name, email and address the invoice shows. An
 * existing Xero contact is never changed.
 */
export async function xeroContactFor(inv: typeof schema.invoices.$inferSelect, snap: IssuedSnapshot, tenantId: string, byName: string) {
  const key = inv.billToType === "company" && inv.billToCompanyId ? `company:${inv.billToCompanyId}` : inv.billToContactId ? `contact:${inv.billToContactId}` : null;
  if (key) {
    const [link] = await db
      .select()
      .from(schema.xeroContactLinks)
      .where(and(eq(schema.xeroContactLinks.tenantId, tenantId), eq(schema.xeroContactLinks.billToKey, key)));
    if (link) return { id: link.xeroContactId, name: link.xeroName, how: "linked" as const };
  }
  const name = (snap.to.company || snap.to.name || "").replace(/\s+/g, " ").trim();
  if (!name || name === "Client") throw new Error(`${inv.number} has no client name to bill in Xero. Set who it bills to first.`);
  const email = (snap.to.email ?? "").trim();

  let found: XContact | null = null;
  let how: "matched" | "created" = "matched";
  const byNameHits = (await findContacts(whereEq("Name", name))).filter((c) => same(c.Name, name));
  const activeNamed = byNameHits.filter((c) => c.ContactStatus !== "ARCHIVED");
  if (activeNamed.length === 1) found = activeNamed[0];
  else if (activeNamed.length > 1) throw new Error(`Xero has ${activeNamed.length} contacts called ${name}. Merge them in Xero, then try again.`);
  else if (byNameHits.length) throw new Error(`${name} is archived in Xero. Restore the contact in Xero, then try again.`);

  if (!found && email) {
    const byEmail = (await findContacts(whereEq("EmailAddress", email))).filter((c) => same(c.EmailAddress, email) && c.ContactStatus !== "ARCHIVED");
    if (byEmail.length === 1) found = byEmail[0];
  }

  if (!found) {
    const person = !snap.to.company ? name.split(" ") : [];
    const body = {
      Contacts: [
        {
          Name: name,
          ...(email ? { EmailAddress: email } : {}),
          ...(person.length > 1 ? { FirstName: person[0], LastName: person.slice(1).join(" ") } : {}),
          ...(snap.to.address ? { Addresses: [{ AddressType: "POBOX", AddressLine1: snap.to.address.slice(0, 500) }] } : {}),
          IsCustomer: true,
        },
      ],
    };
    const r = await xeroApi<{ Contacts?: XContact[] }>("Contacts", {
      method: "PUT",
      body,
      idempotencyKey: `terra-ops-contact-${tenantId.slice(0, 8)}-${key ?? inv.number}`,
    });
    found = r.Contacts?.[0] ?? null;
    if (!found?.ContactID) throw new XeroError("Xero did not create the contact.");
    how = "created";
    await logXero("push", true, `Contact ${found.Name} created in Xero for ${inv.number}.`, { invoiceId: inv.id, xeroId: found.ContactID, byName });
  }
  if (key) {
    await db
      .insert(schema.xeroContactLinks)
      .values({
        tenantId,
        billToKey: key,
        contactId: key.startsWith("contact:") ? inv.billToContactId : null,
        companyId: key.startsWith("company:") ? inv.billToCompanyId : null,
        xeroContactId: found.ContactID,
        xeroName: found.Name ?? name,
        how,
      })
      .onConflictDoNothing();
  }
  return { id: found.ContactID, name: found.Name ?? name, how };
}

/* ---------------------------------- push ---------------------------------- */

type XInvoice = {
  InvoiceID: string;
  InvoiceNumber?: string;
  Type?: string;
  Status?: string;
  Total?: number;
  AmountDue?: number;
  AmountPaid?: number;
  AmountCredited?: number;
  FullyPaidOnDate?: string;
  Payments?: Array<{ PaymentID?: string; Date?: string; Amount?: number }>;
  HasErrors?: boolean;
  ValidationErrors?: Array<{ Message?: string }>;
};

const OPEN = new Set(["DRAFT", "SUBMITTED", "AUTHORISED", "PAID"]);
export const PUSHABLE_STATUSES = ["sent", "part_paid", "paid", "overdue"] as const;
const PUSHABLE = new Set<string>(PUSHABLE_STATUSES);
const inFlight = new Set<number>();

/** Why this invoice can not go to Xero yet, or null. */
export function pushBlocker(inv: typeof schema.invoices.$inferSelect) {
  if (inv.xeroInvoiceId) return "Already in Xero.";
  if (inv.status === "void") return "Void invoices are not sent to Xero.";
  if (!PUSHABLE.has(inv.status)) return "Issue the invoice first. Drafts are not sent to Xero.";
  return null;
}

async function saveXeroState(invId: number, tenantId: string, x: XInvoice, extra: Partial<typeof schema.invoices.$inferInsert> = {}) {
  await db
    .update(schema.invoices)
    .set({
      xeroInvoiceId: x.InvoiceID,
      xeroTenantId: tenantId,
      xeroStatus: x.Status ?? null,
      xeroAmountPaid: typeof x.AmountPaid === "number" ? x.AmountPaid : null,
      xeroAmountDue: typeof x.AmountDue === "number" ? x.AmountDue : null,
      xeroSyncedAt: new Date(),
      updatedAt: new Date(),
      ...extra,
    })
    .where(eq(schema.invoices.id, invId));
}

export type PushResult =
  | { ok: true; how: "created" | "linked" | "already"; xeroInvoiceId: string; status: string | null; contact?: string; issue?: string | null }
  | { ok: false; reason: string };

/**
 * Send one IQ invoice to Xero. Looks for its number in Xero first and links
 * to it if found. What the invoice says is fixed at this point if it was not
 * already, so a later email shows the same as Xero.
 */
export async function pushInvoiceToXero(invoiceId: number, byName: string, actorRole = "system"): Promise<PushResult> {
  if (inFlight.has(invoiceId)) return { ok: false, reason: "Already sending this one to Xero." };
  inFlight.add(invoiceId);
  try {
    const conn = await xeroReady();
    if (!conn?.tenantId) return { ok: false, reason: "Xero is not connected, or no organisation is picked. See Settings, Xero." };
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return { ok: false, reason: "Invoice not found." };
    if (inv.xeroInvoiceId) return { ok: true, how: "already", xeroInvoiceId: inv.xeroInvoiceId, status: inv.xeroStatus };
    const blocked = pushBlocker(inv);
    if (blocked) return { ok: false, reason: blocked };

    // 1. Is that number already in Xero? Then link, never a second invoice.
    const existing = await xeroApi<{ Invoices?: XInvoice[] }>("Invoices", { query: { InvoiceNumbers: inv.number } });
    const hit = (existing.Invoices ?? []).find((x) => x.Type === "ACCREC" && x.InvoiceNumber === inv.number && OPEN.has(x.Status ?? ""));
    if (hit) {
      const issue = typeof hit.Total === "number" && Math.abs(hit.Total - inv.total) > 0.005 ? `Xero has ${inv.number} at ${money(hit.Total)}, Ops at ${money(inv.total)}.` : null;
      await saveXeroState(inv.id, conn.tenantId, hit, { xeroPushedAt: new Date(), xeroPushedByName: byName, xeroIssue: issue });
      await logXero("link", true, `${inv.number} was already in Xero (${hit.Status}). Linked to it, nothing new created.${issue ? ` ${issue}` : ""}`, { invoiceId: inv.id, xeroId: hit.InvoiceID, byName });
      await activity(inv, "invoice_xero_linked", `${inv.number} linked to the invoice already in Xero (${statusWords(hit.Status)})`, byName, actorRole);
      return { ok: true, how: "linked", xeroInvoiceId: hit.InvoiceID, status: hit.Status ?? null, issue };
    }

    // 2. What it says: the saved snapshot, or fixed now.
    const { snapshot, fresh } = await snapshotFor(inv);
    const settings = await xeroSettings();
    const contact = await xeroContactFor(inv, snapshot, conn.tenantId, byName);
    const body = buildXeroInvoice({ inv, snap: snapshot, contactId: contact.id, settings });
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
    const r = await xeroApi<{ Invoices?: XInvoice[] }>("Invoices", {
      method: "PUT",
      body: { Invoices: [body] },
      idempotencyKey: `terra-ops-inv-${inv.id}-${digest}`,
    });
    const made = r.Invoices?.[0];
    if (!made?.InvoiceID || made.HasErrors) {
      throw new XeroError(made?.ValidationErrors?.[0]?.Message ?? "Xero did not create the invoice.");
    }
    if (fresh) {
      await db
        .update(schema.invoices)
        .set({ issuedSnapshot: JSON.stringify(snapshot), updatedAt: new Date() })
        .where(and(eq(schema.invoices.id, inv.id), isNull(schema.invoices.issuedSnapshot)));
    }
    const issue = typeof made.Total === "number" && Math.abs(made.Total - inv.total) > 0.005 ? `Xero worked it out at ${money(made.Total)}, Ops has ${money(inv.total)}.` : null;
    await saveXeroState(inv.id, conn.tenantId, made, { xeroPushedAt: new Date(), xeroPushedByName: byName, xeroIssue: issue });
    await logXero(
      "push",
      true,
      `${inv.number} created in Xero as ${statusWords(made.Status)}, ${money(made.Total ?? inv.total)}, billed to ${contact.name} (${contact.how}), ${body.LineItems.length} lines.${issue ? ` ${issue}` : ""}`,
      { invoiceId: inv.id, xeroId: made.InvoiceID, byName },
    );
    await activity(inv, "invoice_xero_pushed", `${inv.number} sent to Xero as ${statusWords(made.Status)}, billed to ${contact.name}`, byName, actorRole);
    return { ok: true, how: "created", xeroInvoiceId: made.InvoiceID, status: made.Status ?? null, contact: contact.name, issue };
  } catch (e) {
    const reason = errorWords(e);
    await logXero("error", false, `Invoice ${invoiceId} not sent to Xero: ${reason}`, { invoiceId, byName });
    return { ok: false, reason };
  } finally {
    inFlight.delete(invoiceId);
  }
}

/** After the first email, when Settings says so. Never holds up or fails the email. */
export async function autoPushAfterEmail(invoiceId: number, byName: string) {
  try {
    const s = await xeroSettings();
    if (!s.autoPush || !(await xeroReady())) return;
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv || inv.xeroInvoiceId || pushBlocker(inv)) return;
    await pushInvoiceToXero(invoiceId, byName);
  } catch (e) {
    console.error("[xero] auto push failed", e);
  }
}

/* -------------------------------- read back ------------------------------- */

export function statusWords(s: string | null | undefined) {
  switch (s) {
    case "DRAFT":
      return "a draft";
    case "SUBMITTED":
      return "awaiting approval";
    case "AUTHORISED":
      return "awaiting payment";
    case "PAID":
      return "paid";
    case "VOIDED":
      return "voided";
    case "DELETED":
      return "deleted";
    default:
      return s ? s.toLowerCase() : "unknown";
  }
}

function errorWords(e: unknown) {
  if (e instanceof XeroNotConnected) return "Xero is not connected. See Settings, Xero.";
  if (e instanceof XeroError) return e.detail.length > 1 ? e.detail.join(" ") : e.message;
  return String((e as Error)?.message ?? e).slice(0, 400);
}

async function activity(inv: typeof schema.invoices.$inferSelect, action: string, detail: string, byName: string, actorRole: string) {
  await db.insert(schema.activityLog).values({ jobId: inv.jobId, entityType: "invoice", entityId: inv.id, action, detail, actorName: byName, actorRole });
}

export type Reconcile = {
  /** Received in Xero beyond what Ops has. Recorded in Ops. */
  record: number;
  issues: string[];
};

/** What to do with what Xero says. Pure, so every case can be checked without Xero. */
export function reconcile(
  ops: { number: string; status: string; total: number; amountPaid: number },
  x: { Status?: string; Total?: number; AmountPaid?: number; AmountCredited?: number },
): Reconcile {
  const issues: string[] = [];
  const xs = x.Status ?? "";
  const xPaid = r2(x.AmountPaid ?? 0);
  const credited = r2(x.AmountCredited ?? 0);
  const opsVoid = ops.status === "void";
  const xGone = xs === "VOIDED" || xs === "DELETED";
  if (typeof x.Total === "number" && Math.abs(x.Total - ops.total) > 0.005 && !xGone)
    issues.push(`Xero has ${money(x.Total)}, Ops has ${money(ops.total)}. Fix one so they agree.`);
  if (xGone && !opsVoid) issues.push(`${statusWords(xs).replace(/^./, (c) => c.toUpperCase())} in Xero but not in Ops. Void it in Ops if it should be.`);
  if (opsVoid && !xGone) issues.push("Void in Ops but still open in Xero. Void it in Xero by hand.");
  if (credited > 0) issues.push(`${money(credited)} credited in Xero. Ops does not take credits off, so check what is owing.`);
  let record = 0;
  if (!opsVoid && !xGone) {
    if (xPaid > ops.amountPaid + 0.005) {
      const owing = r2(ops.total - ops.amountPaid);
      record = r2(Math.min(xPaid - ops.amountPaid, owing));
      if (xPaid > ops.total + 0.005) issues.push(`Xero shows ${money(xPaid)} paid, more than the ${money(ops.total)} invoice.`);
    } else if (ops.amountPaid > xPaid + 0.005 && xs !== "DRAFT") {
      issues.push(`Ops has ${money(ops.amountPaid)} received, Xero has ${money(xPaid)}. Reconcile the payment in Xero.`);
    }
  }
  return { record: record > 0.005 ? record : 0, issues };
}

/* ------------------------- how each payment was made ---------------------- */

/** One Xero payment as Ops reads it, with the account it went to. */
export type ReadPayment = {
  paymentId: string;
  amount: number;
  date: Date | null;
  status: string;
  accountCode: string | null;
  accountName: string | null;
  accountType: string | null;
};

export type PaymentKind = "bank" | "contra" | "other";
export type PaymentPlan = { paymentId: string; kind: PaymentKind; amount: number; recorded: number; read: ReadPayment };

/** What a Xero payment was, from the account it went to. */
export function paymentKind(p: Pick<ReadPayment, "accountType" | "accountCode">, contraAccount: string): PaymentKind {
  if (p.accountType === "BANK") return "bank";
  if (contraAccount && p.accountCode && p.accountCode.toLowerCase() === contraAccount.toLowerCase()) return "contra";
  return "other";
}

/**
 * Split what Ops is about to record across the Xero payments it has not read
 * yet (Task G). Pure.
 *   A payment to a BANK account is a bank payment.
 *   A payment to the contra clearing account (Settings, Xero) is an offset
 *   against a bill. It is recorded as contra, never as money received.
 *   A payment to any other account is not recorded. A person checks it.
 * Offsets go first, because a bank payment Ops does not have yet is far more
 * likely to be one the office already marked by hand. Whatever no payment
 * explains is left for a person too.
 */
export function planPayments(record: number, unseen: ReadPayment[], contraAccount: string) {
  const live = unseen.filter((p) => p.status !== "DELETED" && p.amount > 0.005);
  const kind = (p: ReadPayment) => paymentKind(p, contraAccount);
  const ordered = [...live.filter((p) => kind(p) === "contra"), ...live.filter((p) => kind(p) === "bank")];
  let left = r2(record);
  const out: PaymentPlan[] = [];
  for (const p of ordered) {
    const take = r2(Math.max(0, Math.min(p.amount, left)));
    left = r2(left - take);
    out.push({ paymentId: p.paymentId, kind: kind(p), amount: r2(p.amount), recorded: take, read: p });
  }
  const other = live.filter((p) => kind(p) === "other");
  return { lines: out, other, unexplained: left > 0.005 ? left : 0 };
}

type XAccount = { AccountID?: string; Code?: string; Name?: string; Type?: string; Status?: string; EnablePaymentsToAccount?: boolean };
type XPayment = {
  PaymentID?: string;
  Date?: string;
  Amount?: number;
  Status?: string;
  PaymentType?: string;
  Account?: { AccountID?: string; Code?: string };
  Invoice?: { InvoiceID?: string };
};

/** Xero's chart of accounts, once per read. Code and id both look up. */
async function accountsByKey() {
  const r = await xeroApi<{ Accounts?: XAccount[] }>("Accounts", { narrow403: true });
  const m = new Map<string, XAccount>();
  for (const a of r.Accounts ?? []) {
    if (a.Code) m.set(`code:${a.Code}`, a);
    if (a.AccountID) m.set(`id:${a.AccountID}`, a);
  }
  return m;
}

/** Read each new payment on one invoice: amount, date and the account it went to. Read only. */
async function readNewPayments(tenantId: string, x: XInvoice, accounts: () => Promise<Map<string, XAccount>>) {
  const ids = [...new Set((x.Payments ?? []).map((p) => p.PaymentID).filter((v): v is string => !!v))];
  if (!ids.length) return [];
  const seen = await db
    .select({ id: schema.xeroPaymentReads.xeroPaymentId })
    .from(schema.xeroPaymentReads)
    .where(and(eq(schema.xeroPaymentReads.tenantId, tenantId), inArray(schema.xeroPaymentReads.xeroPaymentId, ids)));
  const done = new Set(seen.map((s) => s.id));
  const out: ReadPayment[] = [];
  for (const id of ids) {
    if (done.has(id)) continue;
    const r = await xeroApi<{ Payments?: XPayment[] }>(`Payments/${encodeURIComponent(id)}`, { narrow403: true });
    const p = r.Payments?.[0];
    if (!p) throw new XeroError(`Xero did not return payment ${id}.`);
    const map = await accounts();
    const acct = (p.Account?.AccountID && map.get(`id:${p.Account.AccountID}`)) || (p.Account?.Code && map.get(`code:${p.Account.Code}`)) || null;
    out.push({
      paymentId: id,
      amount: r2(p.Amount ?? 0),
      date: xeroDate(p.Date),
      status: p.Status ?? "AUTHORISED",
      accountCode: acct?.Code ?? p.Account?.Code ?? null,
      accountName: acct?.Name ?? null,
      // Unknown account: treated as not a bank, so it is never shown as money in.
      accountType: acct?.Type ?? null,
    });
  }
  return out;
}

/**
 * Record what Xero has paid on one invoice, payment by payment, each once.
 * Returns what it could not explain, which is flagged and not recorded.
 */
async function recordFromXero(
  inv: typeof schema.invoices.$inferSelect,
  x: XInvoice,
  record: number,
  tenantId: string,
  accounts: () => Promise<Map<string, XAccount>>,
  contraAccount: string,
) {
  const plan = planPayments(record, await readNewPayments(tenantId, x, accounts), contraAccount);
  let recorded = 0;
  for (const l of plan.lines) {
    if (l.kind === "other") continue;
    // Claim the payment first, so two reads at once never record it twice.
    const claimed = await db
      .insert(schema.xeroPaymentReads)
      .values({
        tenantId,
        xeroPaymentId: l.paymentId,
        invoiceId: inv.id,
        xeroInvoiceId: x.InvoiceID,
        amount: l.amount,
        recorded: 0,
        accountCode: l.read.accountCode,
        accountName: l.read.accountName,
        accountType: l.read.accountType,
        kind: l.kind,
        paidOn: l.read.date,
      })
      .onConflictDoNothing()
      .returning({ id: schema.xeroPaymentReads.id });
    if (!claimed.length || l.recorded <= 0) continue;
    const acct = [l.read.accountCode, l.read.accountName].filter(Boolean).join(" ") || "an account that is not a bank account";
    try {
      await markInvoicePaid({
        id: inv.id,
        amount: l.recorded,
        method: l.kind === "contra" ? "contra" : "bank",
        paidOn: l.read.date ?? new Date(),
        byName: "Xero",
        actorRole: "system",
        how: l.kind === "contra" ? `settled by contra in Xero (${acct}), not a bank payment` : `received by bank (${acct} in Xero)`,
      });
    } catch (e) {
      // Not recorded, so let the next read try this payment again.
      await db.delete(schema.xeroPaymentReads).where(eq(schema.xeroPaymentReads.id, claimed[0]!.id));
      throw e;
    }
    await db.update(schema.xeroPaymentReads).set({ recorded: l.recorded }).where(eq(schema.xeroPaymentReads.id, claimed[0]!.id));
    recorded = r2(recorded + l.recorded);
    await logXero(
      "pull",
      true,
      `${inv.number}: ${money(l.recorded)} ${l.kind === "contra" ? `settled by contra in Xero (${acct}), recorded in Ops as contra, not as a bank payment` : "paid in Xero, now recorded in Ops"}.`,
      { invoiceId: inv.id, xeroId: x.InvoiceID, byName: "Xero" },
    );
  }
  // Paid to an account that is neither a bank nor the contra account: not recorded, never read as a bank payment.
  // Left unclaimed, so it is read again next time (and recorded as contra if that account is then set as the contra account).
  const other = plan.other.map((p) => `${money(p.amount)} to ${[p.accountCode, p.accountName].filter(Boolean).join(" ") || "an unknown account"}`);
  const otherSum = r2(plan.other.reduce((a, p) => a + p.amount, 0));
  return { recorded, other, unexplained: r2(Math.max(0, plan.unexplained - otherSum)) };
}

let syncing = false;

/** Read every invoice Ops has put in Xero, and bring paid across. */
export async function syncFromXero(byName = "Xero") {
  if (syncing) return { skipped: true as const };
  syncing = true;
  try {
    const conn = await xeroReady();
    if (!conn) return { skipped: true as const, reason: "not connected" };
    if (!conn.tenantId) return { skipped: true as const, reason: "no organisation picked" };
    const tenantId = conn.tenantId;
    const rows = await db
      .select()
      .from(schema.invoices)
      .where(and(isNotNull(schema.invoices.xeroInvoiceId), eq(schema.invoices.xeroTenantId, tenantId)));
    // Settled on both sides and agreeing: nothing more to read.
    const todo = rows.filter((r) => !(r.xeroIssue == null && ((r.status === "paid" && r.xeroStatus === "PAID") || (r.status === "void" && (r.xeroStatus === "VOIDED" || r.xeroStatus === "DELETED")))));
    let checked = 0;
    let recorded = 0;
    let accts: Promise<Map<string, XAccount>> | null = null;
    const accounts = () => (accts ??= accountsByKey());
    const { contraAccount } = await xeroSettings();
    let flagged = 0;
    const errors: string[] = [];
    for (let i = 0; i < todo.length; i += 40) {
      const batch = todo.slice(i, i + 40);
      const r = await xeroApi<{ Invoices?: XInvoice[] }>("Invoices", { query: { IDs: batch.map((b) => b.xeroInvoiceId!).join(","), page: "1" } });
      const byId = new Map((r.Invoices ?? []).map((x) => [x.InvoiceID, x]));
      for (const inv of batch) {
        const x = byId.get(inv.xeroInvoiceId!);
        if (!x) continue;
        checked++;
        const plan = reconcile(inv, x);
        if (plan.record > 0) {
          // Task G: each payment is read for the account it went to, so a contra is never shown as a bank payment.
          try {
            const got = await recordFromXero(inv, x, plan.record, tenantId, accounts, contraAccount);
            if (got.recorded > 0) recorded++;
            if (got.other.length)
              plan.issues.push(
                `Xero shows ${got.other.join(", ")}, which is not a bank account${contraAccount ? ` or the contra account ${contraAccount}` : ", and no contra account is set in Settings, Xero"}. Not recorded. Check it in Xero.`,
              );
            if (got.unexplained > 0.005)
              plan.issues.push(
                `Xero shows ${money(got.unexplained)} more paid that Ops could not match to a Xero payment (it may be a prepayment or overpayment). Not recorded. Check it in Xero.`,
              );
          } catch (e) {
            const m = errorWords(e);
            plan.issues.push(`Paid in Xero but Ops could not read how it was paid, so nothing was recorded yet: ${m}`);
            errors.push(`${inv.number}: ${m}`);
          }
        }
        const issue = plan.issues.length ? plan.issues.join(" ") : null;
        if (issue && issue !== inv.xeroIssue) {
          flagged++;
          await logXero("pull", false, `${inv.number}: ${issue}`, { invoiceId: inv.id, xeroId: x.InvoiceID, byName });
        }
        await saveXeroState(inv.id, tenantId, x, { xeroIssue: issue });
      }
    }
    await db.update(schema.xeroConnection).set({ lastSyncAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(schema.xeroConnection.id, conn.id));
    if (recorded) await rebuildForecast().catch((e) => console.error("[cashflow] rebuild after Xero read failed:", e));
    return { skipped: false as const, checked, recorded, flagged, errors };
  } catch (e) {
    const m = errorWords(e);
    const row = await xeroRow();
    // A lost sign-in already left its own, clearer reason. Keep that one.
    if (row && !(e instanceof XeroNotConnected)) await db.update(schema.xeroConnection).set({ lastError: m, updatedAt: new Date() }).where(eq(schema.xeroConnection.id, row.id));
    await logXero("error", false, `Reading Xero failed: ${m}`, { byName });
    throw e;
  } finally {
    syncing = false;
  }
}

/* ---------------------------------- timer --------------------------------- */

let booted = false;

/** Reads Xero every 30 minutes. Only on the published server, and only once connected. */
export function bootXeroSync() {
  if (booted) return;
  booted = true;
  const mode = process.env.XERO_SYNC_TIMER;
  if (mode === "off") return void console.log("[xero] timer disabled by XERO_SYNC_TIMER=off");
  if (mode !== "on" && !isLiveServer()) return void console.log("[xero] timer idle, not the published server");
  const tick = () =>
    void syncFromXero().catch((e) => {
      if (!(e instanceof XeroNotConnected)) console.error("[xero] read back failed", e);
    });
  setInterval(tick, 30 * 60_000);
  setTimeout(tick, 2 * 60_000);
}
