import { ORPCError } from "@orpc/server";
import { eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "../database";
import * as schema from "../database/schema";
import type { Actor } from "../middleware/auth";
import { round2 } from "./pricing";

/* ---------------------------------------------------------------------------
 * Trade sales core (notes 18.65): settings, the audit trail, balances and the
 * write guard. Every money figure is worked from the rows, never stored as a
 * running total, so nothing can drift.
 *
 *  SALE BALANCE  = invoice total
 *                  - credit notes
 *                  - cash in (payments less reversed payments)
 *                  + cash out (refunds less reversed refunds)
 *                  - confirmed offsets (offset rows less offset reversals)
 *  BILL REMAINING = bill total - confirmed offsets - cash paid (each net of reversals)
 *
 * Below zero on a sale is a credit balance: Terra owes the buyer.
 * ------------------------------------------------------------------------- */

export type Who = { name: string; role: string };
export const whoOf = (a: Actor): Who => ({ name: a.name || a.email || "Admin", role: a.role });

export const money = (n: number) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const nowSec = () => Math.floor(Date.now() / 1000);
export const ymd = (d = new Date()) => {
  const z = new Date(d.toLocaleString("en-US", { timeZone: "Australia/Brisbane" }));
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, "0")}-${String(z.getDate()).padStart(2, "0")}`;
};
export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const bad = (message: string) => new ORPCError("BAD_REQUEST", { message });
export const conflict = (message: string) => new ORPCError("CONFLICT", { message });
export const notFound = (message = "Not found") => new ORPCError("NOT_FOUND", { message });

/* ------------------------------- settings -------------------------------- */

export type TradeSettingsView = {
  enabled: boolean;
  markupPct: number;
  nextNumber: number;
  categories: string[];
  supplierIds: number[];
  updatedByName: string;
  updatedAt: Date;
};

const parseArr = <T>(s: string | null | undefined): T[] => {
  try {
    const v = JSON.parse(s || "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};
export const parseCategories = (s: string | null | undefined) => parseArr<string>(s).filter((x) => typeof x === "string");

export async function tradeSettings(): Promise<TradeSettingsView> {
  const [row] = await db.select().from(schema.tradeSettings).where(eq(schema.tradeSettings.id, 1));
  if (!row) throw new ORPCError("PRECONDITION_FAILED", { message: "Trade sales is not set up on this database." });
  return {
    enabled: row.enabled,
    markupPct: row.markupPct,
    nextNumber: row.nextNumber,
    categories: parseCategories(row.categories),
    supplierIds: parseArr<number>(row.supplierIds).filter((x) => Number.isInteger(x)),
    updatedByName: row.updatedByName,
    updatedAt: row.updatedAt,
  };
}

/** The kill switch. Off stops new sales, finalising, new offsets and offset confirms. */
export async function requireTradeOn() {
  const s = await tradeSettings();
  if (!s.enabled) throw new ORPCError("PRECONDITION_FAILED", { message: "Trade sales is switched off in Settings." });
  return s;
}

/* -------------------------------- audit ---------------------------------- */

export type AuditInput = {
  entityType: string;
  entityId?: number | null;
  saleId?: number | null;
  billId?: number | null;
  action: string;
  detail: string;
  who: Who;
};

export const auditRow = (a: AuditInput) =>
  db.insert(schema.tradeAudit).values({
    entityType: a.entityType,
    entityId: a.entityId ?? null,
    saleId: a.saleId ?? null,
    billId: a.billId ?? null,
    action: a.action,
    detail: a.detail.slice(0, 1000),
    actorName: a.who.name,
    actorRole: a.who.role,
  });

export async function audit(a: AuditInput) {
  await auditRow(a);
}

/* ------------------------------- balances -------------------------------- */

/** SQL for a sale's balance, usable inside a guarded batch. */
export const saleBalanceSql = (saleId: number | SQL) => sql`(
  coalesce((select total from trade_sales where id = ${saleId} and status = 'finalised'), 0)
  - coalesce((select sum(total) from trade_credit_notes where sale_id = ${saleId}), 0)
  - coalesce((select sum(case kind when 'payment' then amount when 'payment_reversal' then -amount
                                   when 'refund' then -amount when 'refund_reversal' then amount else 0 end)
              from trade_payments where sale_id = ${saleId}), 0)
  - coalesce((select sum(case kind when 'offset' then amount when 'offset_reversal' then -amount else 0 end)
              from installer_bill_settlements where sale_id = ${saleId}), 0)
)`;

/** SQL for what is still to pay on an installer bill. */
export const billRemainingSql = (billId: number | SQL) => sql`(
  coalesce((select total from installer_invoices where id = ${billId}), 0)
  - coalesce((select sum(case kind when 'offset' then amount when 'cash' then amount
                                   when 'offset_reversal' then -amount when 'cash_reversal' then -amount else 0 end)
              from installer_bill_settlements where bill_id = ${billId}), 0)
)`;

export type SaleMoney = {
  total: number;
  credited: number;
  cashIn: number;
  refunded: number;
  offsetConfirmed: number;
  offsetPending: number;
  balance: number;
  /** outstanding · part_paid · paid · credit_balance · draft · cancelled */
  state: string;
};

export async function saleMoney(saleIds: number[]): Promise<Map<number, SaleMoney>> {
  const out = new Map<number, SaleMoney>();
  if (!saleIds.length) return out;
  const ids = sql.join(
    saleIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.all<{
    id: number;
    status: string;
    total: number;
    credited: number;
    cash_in: number;
    refunded: number;
    off_conf: number;
    off_pend: number;
  }>(sql`
    select s.id, s.status, s.total,
      coalesce((select sum(total) from trade_credit_notes c where c.sale_id = s.id), 0) as credited,
      coalesce((select sum(case kind when 'payment' then amount when 'payment_reversal' then -amount else 0 end) from trade_payments p where p.sale_id = s.id), 0) as cash_in,
      coalesce((select sum(case kind when 'refund' then amount when 'refund_reversal' then -amount else 0 end) from trade_payments p where p.sale_id = s.id), 0) as refunded,
      coalesce((select sum(case kind when 'offset' then amount when 'offset_reversal' then -amount else 0 end) from installer_bill_settlements b where b.sale_id = s.id), 0) as off_conf,
      coalesce((select sum(amount) from trade_offsets o where o.sale_id = s.id and o.status in ('proposed', 'approved')), 0) as off_pend
    from trade_sales s where s.id in (${ids})`);
  for (const r of rows) {
    const total = r.status === "finalised" ? Number(r.total) : 0;
    const credited = round2(Number(r.credited));
    const cashIn = round2(Number(r.cash_in));
    const refunded = round2(Number(r.refunded));
    const offsetConfirmed = round2(Number(r.off_conf));
    const balance = round2(total - credited - cashIn + refunded - offsetConfirmed);
    const settled = round2(cashIn + offsetConfirmed);
    const state =
      r.status === "draft"
        ? "draft"
        : r.status === "cancelled"
          ? "cancelled"
          : balance < -0.005
            ? "credit_balance"
            : balance <= 0.005
              ? "paid"
              : settled > 0.005 || credited > 0.005
                ? "part_paid"
                : "outstanding";
    out.set(r.id, { total, credited, cashIn, refunded, offsetConfirmed, offsetPending: round2(Number(r.off_pend)), balance, state });
  }
  return out;
}

export async function oneSaleMoney(saleId: number) {
  const m = (await saleMoney([saleId])).get(saleId);
  if (!m) throw notFound("Sale not found");
  return m;
}

export type BillMoney = {
  billId: number;
  total: number;
  status: string;
  offsets: number;
  cash: number;
  remaining: number;
  /** Marked paid before settlement rows existed. Nothing is invented for it. */
  legacyPaid: boolean;
};

export async function billMoney(billIds: number[]): Promise<Map<number, BillMoney>> {
  const out = new Map<number, BillMoney>();
  if (!billIds.length) return out;
  const ids = sql.join(
    billIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.all<{ id: number; total: number; status: string; offsets: number; cash: number; n_cash: number }>(sql`
    select i.id, i.total, i.status,
      coalesce((select sum(case kind when 'offset' then amount when 'offset_reversal' then -amount else 0 end) from installer_bill_settlements b where b.bill_id = i.id), 0) as offsets,
      coalesce((select sum(case kind when 'cash' then amount when 'cash_reversal' then -amount else 0 end) from installer_bill_settlements b where b.bill_id = i.id), 0) as cash,
      (select count(*) from installer_bill_settlements b where b.bill_id = i.id and b.kind = 'cash') as n_cash
    from installer_invoices i where i.id in (${ids})`);
  for (const r of rows) {
    const total = round2(Number(r.total));
    const offsets = round2(Number(r.offsets));
    const cash = round2(Number(r.cash));
    out.set(r.id, {
      billId: r.id,
      total,
      status: r.status,
      offsets,
      cash,
      remaining: round2(total - offsets - cash),
      legacyPaid: r.status === "paid" && Number(r.n_cash) === 0,
    });
  }
  return out;
}

/* ------------------------------ write guard ------------------------------ */

/**
 * A statement that fails the whole batch when `cond` is false. trade_guard has
 * CHECK (ok = 1) and is always empty, so a passing guard inserts nothing.
 */
export const guard = (cond: SQL) => db.run(sql`insert into trade_guard (ok) select 0 where not (${cond})`);

export const GUARD_MSG = "The figures changed while this was saving, so nothing was saved. Reload and try again.";

export async function runGuarded(stmts: BatchItem<"sqlite">[]) {
  try {
    await db.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e) + String((e as { cause?: Error })?.cause?.message ?? "");
    if (/CHECK constraint failed/i.test(msg) && /ok/.test(msg)) throw conflict(GUARD_MSG);
    if (/UNIQUE constraint failed/i.test(msg)) throw new ORPCError("CONFLICT", { message: "Already done. Nothing was saved twice." });
    throw e;
  }
}

export const isUniqueConflict = (e: unknown) => e instanceof ORPCError && e.code === "CONFLICT" && /Already done/.test(e.message);

/* -------------------------------- buyers --------------------------------- */

export type BuyerKind = "installer" | "contact" | "company";

export type BuyerView = {
  id: number;
  kind: BuyerKind;
  refId: number;
  name: string;
  email: string | null;
  abn: string | null;
  address: string | null;
  active: boolean;
  categories: string[];
  creditApproved: boolean;
  creditApprovedByName: string | null;
  creditApprovedAt: Date | null;
  termsDays: number;
  feePresentation: string;
  entityAbn: string | null;
  entityVerifiedAt: Date | null;
  entityVerifiedByName: string | null;
  /** Installer only: verified, the ABN still matches the card, and it is not blank. */
  entityOk: boolean;
  notes: string;
};

const fullName = (c: { firstName?: string | null; lastName?: string | null }) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
export const normAbn = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

export async function buyerViews(rows: Array<typeof schema.tradeBuyers.$inferSelect>): Promise<BuyerView[]> {
  const out: BuyerView[] = [];
  for (const b of rows) {
    let kind: BuyerKind;
    let refId: number;
    let name = "";
    let email: string | null = null;
    let abn: string | null = null;
    let address: string | null = null;
    if (b.installerId) {
      kind = "installer";
      refId = b.installerId;
      const [i] = await db.select().from(schema.installers).where(eq(schema.installers.id, b.installerId));
      name = i?.tradingName?.trim() || i?.name || "Installer";
      email = i?.invoiceEmail?.trim() || i?.email?.trim() || null;
      abn = i?.abn?.trim() || null;
      address = i?.businessAddress?.trim() || null;
    } else if (b.companyId) {
      kind = "company";
      refId = b.companyId;
      const [c] = await db.select().from(schema.companies).where(eq(schema.companies.id, b.companyId));
      name = c?.name || "Company";
      email = c?.email?.trim() || null;
      abn = c?.abn?.trim() || null;
      address = c?.billingAddress?.trim() || null;
    } else {
      kind = "contact";
      refId = b.contactId!;
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, b.contactId!));
      name = (c && fullName(c)) || "Contact";
      email = c?.email?.trim() || null;
      address = c?.address?.trim() || null;
    }
    const entityOk = kind === "installer" && !!b.entityVerifiedAt && !!normAbn(b.entityAbn) && normAbn(b.entityAbn) === normAbn(abn);
    out.push({
      id: b.id,
      kind,
      refId,
      name,
      email,
      abn,
      address,
      active: b.active,
      categories: parseCategories(b.categories),
      creditApproved: b.creditApproved,
      creditApprovedByName: b.creditApprovedByName,
      creditApprovedAt: b.creditApprovedAt,
      termsDays: b.termsDays,
      feePresentation: b.feePresentation,
      entityAbn: b.entityAbn,
      entityVerifiedAt: b.entityVerifiedAt,
      entityVerifiedByName: b.entityVerifiedByName,
      entityOk,
      notes: b.notes,
    });
  }
  return out;
}

export async function buyerView(buyerId: number) {
  const [b] = await db.select().from(schema.tradeBuyers).where(eq(schema.tradeBuyers.id, buyerId));
  if (!b) throw notFound("Trade buyer not found");
  return (await buyerViews([b]))[0]!;
}
