import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../database";
import * as schema from "../database/schema";
import { adminOnly, staffOnly } from "../middleware/auth";
import {
  chooseTenant,
  isDemoCompany,
  logXero,
  tenantsOf,
  XERO_SCOPES,
  xeroApi,
  xeroConfigured,
  xeroConnectUrl,
  xeroDisconnect,
  xeroReady,
  xeroRedirectUri,
  xeroRow,
} from "../lib/xero";
import {
  PUSHABLE_STATUSES,
  pushBlocker,
  pushInvoiceToXero,
  syncFromXero,
  XERO_ACCOUNT_KEY,
  XERO_AUTO_KEY,
  XERO_STATUS_KEY,
  xeroSettings,
} from "../lib/xero-invoices";

/**
 * Settings, Xero. Connect the Terra Ops Xero app, pick the organisation, and
 * choose how invoices go across. No route ever returns a token.
 */

const ACCOUNT_NAME_KEY = "xero_sales_account_name";

async function putSetting(key: string, value: string) {
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

async function profileId(userId: string) {
  const [p] = await db.select({ id: schema.profiles.id }).from(schema.profiles).where(eq(schema.profiles.userId, userId));
  return p?.id ?? null;
}

const fail = (e: unknown) => new ORPCError("BAD_REQUEST", { message: String((e as Error)?.message ?? e).slice(0, 400) });

export const xero = {
  status: adminOnly.handler(async () => {
    const row = await xeroRow();
    const s = await xeroSettings();
    const [acct] = await db.select().from(schema.settings).where(eq(schema.settings.key, ACCOUNT_NAME_KEY));
    const connected = Boolean(row?.refreshTokenSealed);
    const invs = await db
      .select({
        id: schema.invoices.id,
        number: schema.invoices.number,
        status: schema.invoices.status,
        total: schema.invoices.total,
        jobId: schema.invoices.jobId,
        xeroInvoiceId: schema.invoices.xeroInvoiceId,
        xeroIssue: schema.invoices.xeroIssue,
      })
      .from(schema.invoices);
    const pushable = new Set<string>(PUSHABLE_STATUSES);
    const notYet = invs.filter((i) => !i.xeroInvoiceId && pushable.has(i.status));
    const log = await db.select().from(schema.xeroSyncLog).orderBy(desc(schema.xeroSyncLog.id)).limit(20);
    return {
      configured: xeroConfigured(),
      redirectUri: xeroRedirectUri(),
      scopes: [...XERO_SCOPES],
      connected,
      tenant: connected && row?.tenantId ? { id: row.tenantId, name: row.tenantName, demo: isDemoCompany(row.tenantName) } : null,
      tenants: connected ? tenantsOf(row).map((t) => ({ id: t.tenantId, name: t.tenantName, demo: isDemoCompany(t.tenantName) })) : [],
      connectedAt: connected ? (row?.connectedAt ?? null) : null,
      lastSyncAt: row?.lastSyncAt ?? null,
      // Kept after Xero drops the sign-in, so Settings can say why.
      lastError: row?.lastError ?? null,
      settings: { ...s, accountName: acct?.value ?? null },
      counts: {
        inXero: invs.filter((i) => i.xeroInvoiceId).length,
        notYet: notYet.length,
        issues: invs.filter((i) => i.xeroIssue).length,
      },
      notYet: notYet.slice(0, 50).map((i) => ({ id: i.id, number: i.number, status: i.status, total: i.total, jobId: i.jobId })),
      issues: invs.filter((i) => i.xeroIssue).map((i) => ({ id: i.id, number: i.number, jobId: i.jobId, issue: i.xeroIssue })),
      log: log.map((l) => ({ id: l.id, kind: l.kind, ok: l.ok, detail: l.detail, byName: l.byName, invoiceId: l.invoiceId, at: l.createdAt })),
    };
  }),

  /** The Xero sign-in link. Pick Terra Flooring on Xero's screen, not the Demo Company. */
  connect: adminOnly.handler(async ({ context }) => {
    if (!xeroConfigured()) throw new ORPCError("PRECONDITION_FAILED", { message: "Xero isn't set up yet. The Client ID and secret need adding first." });
    return { url: xeroConnectUrl(await profileId(context.actor.userId)) };
  }),

  chooseTenant: adminOnly.input(z.object({ tenantId: z.string().min(1) })).handler(async ({ input, context }) => {
    try {
      const t = await chooseTenant(input.tenantId, context.actor.name || "Admin");
      return { ok: true, name: t.tenantName };
    } catch (e) {
      throw fail(e);
    }
  }),

  disconnect: adminOnly.handler(async ({ context }) => {
    await xeroDisconnect(context.actor.name || "Admin");
    return { ok: true };
  }),

  /** Sales account, Draft or Awaiting payment, and whether the first email sends it to Xero. */
  saveSettings: adminOnly
    .input(
      z.object({
        accountCode: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9.-]+$/, "Account codes are letters and numbers only."),
        pushStatus: z.enum(["DRAFT", "AUTHORISED"]),
        autoPush: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      const before = await xeroSettings();
      let accountName: string | null = null;
      // Check the account is a real one in the organisation, when there is one to ask.
      if (await xeroReady()) {
        try {
          const r = await xeroApi<{ Accounts?: Array<{ Code?: string; Name?: string; Type?: string; Status?: string }> }>("Accounts", {
            query: { where: `Code=="${input.accountCode}"` },
          });
          const a = (r.Accounts ?? []).find((x) => x.Code === input.accountCode && x.Status !== "ARCHIVED");
          if (!a) throw new Error(`Xero has no active account ${input.accountCode}. Check the code in Xero's chart of accounts.`);
          if (!["REVENUE", "SALES", "OTHERINCOME"].includes(a.Type ?? "")) throw new Error(`Account ${input.accountCode} (${a.Name}) is not an income account in Xero.`);
          accountName = `${a.Code} ${a.Name}`;
        } catch (e) {
          throw fail(e);
        }
      }
      await putSetting(XERO_ACCOUNT_KEY, input.accountCode);
      await putSetting(XERO_STATUS_KEY, input.pushStatus);
      await putSetting(XERO_AUTO_KEY, input.autoPush ? "1" : "0");
      if (accountName) await putSetting(ACCOUNT_NAME_KEY, accountName);
      else if (before.accountCode !== input.accountCode) await db.delete(schema.settings).where(eq(schema.settings.key, ACCOUNT_NAME_KEY));
      await logXero(
        "settings",
        true,
        `Sales account ${input.accountCode}, new invoices go in as ${input.pushStatus === "DRAFT" ? "drafts" : "awaiting payment"}, ${input.autoPush ? "sent to Xero at the first email" : "sent to Xero by hand"}.`,
        { byName: context.actor.name || "Admin" },
      );
      return { ok: true, accountName };
    }),

  /** Send one invoice to Xero now. Admin or Office. */
  push: staffOnly.input(z.object({ invoiceId: z.number().int() })).handler(async ({ input, context }) => {
    const r = await pushInvoiceToXero(input.invoiceId, context.actor.name || "Office", context.actor.role);
    if (!r.ok) throw new ORPCError("BAD_REQUEST", { message: r.reason });
    return r;
  }),

  /** Can this invoice go to Xero, and if not, why. For the button on the job page. */
  canPush: staffOnly.input(z.object({ invoiceId: z.number().int() })).handler(async ({ input }) => {
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, input.invoiceId));
    if (!inv) throw new ORPCError("NOT_FOUND", { message: "Invoice not found" });
    const ready = Boolean(await xeroReady());
    return { ready, blocker: ready ? pushBlocker(inv) : "Xero is not connected." };
  }),

  /** Read Xero now instead of waiting for the 30 minute round. */
  checkNow: adminOnly.handler(async ({ context }) => {
    try {
      const r = await syncFromXero(context.actor.name || "Admin");
      if (r.skipped) return { busy: true, checked: 0, recorded: 0, flagged: 0, errors: [] as string[] };
      return { busy: false, checked: r.checked, recorded: r.recorded, flagged: r.flagged, errors: r.errors };
    } catch (e) {
      throw fail(e);
    }
  }),

  /** Is Xero ready for the job page buttons. Any staff member can ask. */
  ready: staffOnly.handler(async () => {
    const row = await xeroReady();
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.invoices)
      .where(and(isNull(schema.invoices.xeroInvoiceId), inArray(schema.invoices.status, [...PUSHABLE_STATUSES])));
    return { ready: Boolean(row), tenantName: row?.tenantName ?? null, demo: isDemoCompany(row?.tenantName), notInXero: n };
  }),
};
